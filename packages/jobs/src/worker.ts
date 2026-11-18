import type { Db } from '@shipwords/core/db/client';
import { and, eq, inArray, isNotNull, like, lt, ne, notInArray, sql } from 'drizzle-orm';
import { cancelAll, loadJob, markFailed, upstreamIds } from './lifecycle';
import { type RunnerDeps, runGeneration, type StepRunner } from './runner';
import { jobRuns, jobSteps, TERMINAL } from './schema';

// Durable execution of runGeneration on Postgres, in place of Cloudflare Workflows.
//
// - A job's run row is inserted with the job (handlers.ts). Each process runs a loop that claims pending runs with
//   SELECT … FOR UPDATE SKIP LOCKED and holds each one by a lease it keeps extending. Every claim writes its own token into
//   locked_by, so step writes, heartbeats and releases match one claim, never an older one of the same process.
// - step.do(name, fn) returns a finished step's saved result without running fn, so a replay skips the work already done.
//   Otherwise, under the lease, it records that an attempt is starting, runs fn and saves the result, retrying failures with
//   exponential backoff. The attempt count includes attempts whose process died, survives replays, and is passed to fn, so a step
//   can tell a first attempt (nothing done yet) from one whose earlier effects are unknown. Steps are at least once.
// - A step is never run twice at the same time: there is no per-step timeout to retry around a slow call (a Node call can't be
//   stopped, and the old one would keep writing). A run stuck past its job's deadline plus a grace period is buried instead:
//   its upstream tasks are canceled and the job is failed ('stale') and refunded. Jobs only move forward, so whatever the stuck
//   call writes later can't undo that.
// - Once the lease is lost or the process is stopping, every later step throws RunLost without running, including the runner's
//   own abort and settle steps, so a worker that lost a run can't fail and refund a job another worker is finishing.
// - The worker's own database trouble never reaches the runner as a step failure (which would fail and refund a paid job): the
//   run is handed back for a later replay, and such hand-backs don't count toward the poison limit.
// - A run marked done always has a finished job. A run whose job is still in progress when runGeneration returns is left to be
//   replayed; a run claimed too often without finishing is poison and is buried.

export interface WorkerOptions {
  /** Identifies this process in locked_by; defaults to a random ID. */
  id?: string;
  /** Runs held at once. Jobs mostly wait on the upstream, so this can be well above the CPU count. */
  slots?: number;
  /** How often the loop looks for pending runs when nothing woke it. */
  pollMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  /** A run claimed more often than this is poison. */
  maxPickups?: number;
  /** Retries of a throwing step after the first attempt, and the delay before the first retry (doubling each time). */
  retries?: number;
  retryDelayMs?: number;
  /** A run still going this long after its job's deadline is buried (the same grace the job handlers use for stale jobs). */
  stuckGraceMs?: number;
  /** How long stop() waits for steps in flight before returning anyway (their leases then expire). */
  stopGraceMs?: number;
  /** A run handed back after the worker's own database trouble is retried after this delay. */
  retryRunAfterMs?: number;
  /** Step rows of runs that ended this long ago are deleted. */
  keepStepsMs?: number;
  log?: (message: string, details: Record<string, unknown>) => void;
  /** For tests; defaults to Date.now. */
  now?: () => number;
}

const DEFAULTS = {
  slots: 20,
  pollMs: 1_000,
  leaseMs: 60_000,
  heartbeatMs: 20_000,
  maxPickups: 10,
  retries: 5,
  retryDelayMs: 10_000,
  stuckGraceMs: 15 * 60_000,
  stopGraceMs: 60_000,
  retryRunAfterMs: 30_000,
  keepStepsMs: 30 * 24 * 3_600_000,
} as const;

const CLEANUP_EVERY_MS = 3_600_000;
/** A step doesn't start this close to the lease's end: the heartbeat should have extended it long before. */
const LEASE_MARGIN_MS = 5_000;
/** The worker's own reads and writes are retried this often before it hands the run back. */
const ENGINE_ATTEMPTS = 3;
/** Canceling upstream tasks of a buried run waits at most this long; the refund doesn't wait on a hung upstream. */
const CANCEL_LIMIT_MS = 30_000;

/** Why a step refused to run. */
export type LostReason = 'lost' | 'stopping' | 'engine' | 'stuck';

/** Thrown by a step once this worker may no longer run the job. */
export class RunLost extends Error {
  constructor(
    readonly runId: string,
    readonly reason: LostReason = 'lost',
  ) {
    super(`run ${runId} is no longer run by this worker (${reason})`);
    this.name = 'RunLost';
  }
}

/** Step results are saved as JSON; a fresh run returns the same round-tripped value a replay would. */
function encode(value: unknown): { v?: unknown } {
  return JSON.parse(JSON.stringify({ v: value })) as { v?: unknown };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolves with the promise, or with undefined after ms, so a hung call can't hold up what follows it. */
function within<T>(ms: number, promise: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export interface Lease {
  runId: string;
  /** This claim's locked_by value. */
  token: string;
  /** Aborted (with a RunLost) when the run may no longer continue here; pending waits end at once, and no step runs after. */
  abort: AbortController;
  /** locked_until as last written by this worker. */
  until: number;
}

export interface JobWorker {
  readonly id: string;
  /** Look for pending runs now, e.g. right after a job is created in this process. */
  wake(): void;
  /** Stop claiming; let steps in flight finish (up to stopGraceMs), then release the leases so another process picks the runs up. */
  stop(): Promise<void>;
  /** Runs held right now (for tests and health checks). */
  readonly active: number;
}

interface StepOptions {
  retries: number;
  retryDelayMs: number;
  now: () => number;
}

function abortLease(lease: Lease, reason: LostReason): RunLost {
  if (lease.abort.signal.aborted) return lease.abort.signal.reason as RunLost;
  const error = new RunLost(lease.runId, reason);
  lease.abort.abort(error);
  return error;
}

/** Steps of one run, bound to one claim's lease on it. */
export function leasedSteps(db: Db, lease: Lease, options: StepOptions): StepRunner {
  const { runId, token } = lease;
  const lost = (reason: LostReason = 'lost') => abortLease(lease, reason);

  /** The worker's own database work. A failure that persists hands the run back; it never becomes a step failure. */
  async function engine<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (error) {
        if (error instanceof RunLost) throw error;
        if (attempt >= ENGINE_ATTEMPTS) throw lost('engine');
        await delay(200 * attempt);
      }
    }
  }

  const heldWhere = (atLeast: number) =>
    and(
      eq(jobRuns.id, runId),
      eq(jobRuns.status, 'pending'),
      eq(jobRuns.lockedBy, token),
      sql`${jobRuns.lockedUntil} > ${atLeast}`,
    );

  function assertRunning() {
    if (lease.abort.signal.aborted) throw lease.abort.signal.reason as RunLost;
    if (options.now() > lease.until - LEASE_MARGIN_MS) throw lost();
  }

  async function stepRow(name: string) {
    const [row] = await db
      .select()
      .from(jobSteps)
      .where(and(eq(jobSteps.runId, runId), eq(jobSteps.name, name)));
    return row ?? null;
  }

  /** Under the lease, records that `attempt` is starting. */
  async function begin(name: string, attempt: number) {
    assertRunning();
    await engine(() =>
      db.transaction(async (tx) => {
        const [held] = await tx
          .select({ id: jobRuns.id })
          .from(jobRuns)
          .where(heldWhere(options.now() + LEASE_MARGIN_MS))
          .for('update');
        if (!held) throw lost();
        // Aborted while waiting for the lock: roll back, so an attempt that never ran isn't counted.
        if (lease.abort.signal.aborted) throw lease.abort.signal.reason as RunLost;
        await tx
          .insert(jobSteps)
          .values({ runId, name, attempts: attempt })
          .onConflictDoUpdate({ target: [jobSteps.runId, jobSteps.name], set: { attempts: attempt } });
      }),
    );
    // stop() or the heartbeat may have aborted the lease while the query was in flight.
    assertRunning();
  }

  /** Saves a step's outcome only while this claim still holds the lease; otherwise throws RunLost. */
  async function settle(name: string, fields: { result?: { v?: unknown }; error?: string; done: boolean }) {
    await engine(() =>
      db.transaction(async (tx) => {
        const [held] = await tx
          .select({ id: jobRuns.id })
          .from(jobRuns)
          .where(heldWhere(options.now()))
          .for('update');
        if (!held) throw lost();
        await tx
          .update(jobSteps)
          .set({
            result: fields.result ?? null,
            error: fields.error ?? null,
            doneAt: fields.done ? options.now() : null,
          })
          .where(and(eq(jobSteps.runId, runId), eq(jobSteps.name, name)));
      }),
    );
  }

  async function backoff(attempt: number) {
    try {
      await abortableDelay(options.retryDelayMs * 2 ** (attempt - 1), lease.abort.signal);
    } catch {
      throw lost();
    }
  }

  return {
    async do<T>(name: string, fn: (info?: { attempt: number }) => Promise<T>): Promise<T> {
      assertRunning();
      const row = await engine(() => stepRow(name));
      if (row?.doneAt != null) return (row.result as { v?: unknown } | null)?.v as T;
      // Attempts started before (including ones whose process died) count: a replay doesn't get a fresh set of retries.
      const started = row?.attempts ?? 0;
      if (started > options.retries)
        throw new Error(row?.error ?? `step ${name} did not finish in ${started} attempts`);
      if (started > 0 && row?.error) await backoff(started);
      for (let attempt = started + 1; ; attempt++) {
        await begin(name, attempt);
        let value: T;
        try {
          value = await fn({ attempt });
        } catch (error) {
          if (error instanceof RunLost) throw error;
          const message = error instanceof Error ? error.message : String(error);
          await settle(name, { error: message.slice(0, 2_000), done: false });
          if (attempt > options.retries) throw error;
          await backoff(attempt);
          continue;
        }
        const result = encode(value);
        await settle(name, { result, done: true });
        return result.v as T;
      }
    },

    async sleep(name: string, ms: number): Promise<void> {
      assertRunning();
      const row = await engine(() => stepRow(name));
      if (row?.doneAt != null) return;
      await begin(name, (row?.attempts ?? 0) + 1);
      try {
        await abortableDelay(ms, lease.abort.signal);
      } catch {
        throw lost();
      }
      await settle(name, { done: true });
    },
  };
}

/**
 * Starts the loop in this process. `deps` are the runner's dependencies (database, bucket, adapters, composer, mails…);
 * the worker uses deps.db for its own tables too.
 */
export function startJobWorker(deps: RunnerDeps, options: WorkerOptions = {}): JobWorker {
  const db = deps.db;
  const id = options.id ?? `w_${crypto.randomUUID().slice(0, 8)}`;
  const slots = options.slots ?? DEFAULTS.slots;
  const pollMs = options.pollMs ?? DEFAULTS.pollMs;
  const leaseMs = options.leaseMs ?? DEFAULTS.leaseMs;
  const heartbeatMs = options.heartbeatMs ?? DEFAULTS.heartbeatMs;
  const maxPickups = options.maxPickups ?? DEFAULTS.maxPickups;
  const stuckGraceMs = options.stuckGraceMs ?? DEFAULTS.stuckGraceMs;
  const stopGraceMs = options.stopGraceMs ?? DEFAULTS.stopGraceMs;
  const retryRunAfterMs = options.retryRunAfterMs ?? DEFAULTS.retryRunAfterMs;
  const keepStepsMs = options.keepStepsMs ?? DEFAULTS.keepStepsMs;
  const now = options.now ?? Date.now;
  const log = options.log ?? deps.log ?? (() => {});
  const stepOptions: StepOptions = {
    retries: options.retries ?? DEFAULTS.retries,
    retryDelayMs: options.retryDelayMs ?? DEFAULTS.retryDelayMs,
    now,
  };
  // A heartbeat must land well before a step would refuse to start for a lease about to end.
  if (leaseMs - LEASE_MARGIN_MS < 2 * heartbeatMs)
    throw new Error(
      `leaseMs (${leaseMs}) must be at least ${LEASE_MARGIN_MS} ms plus two heartbeats (${heartbeatMs} ms)`,
    );

  interface Held {
    lease: Lease;
    /** When the run counts as stuck: its job's deadline plus the grace. */
    stuckAt: number;
  }
  const held = new Map<string, Held>();
  const running = new Set<Promise<void>>();
  let stopping = false;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let polling: Promise<void> | null = null;
  let lastCleanup = 0;

  async function claim(
    limit: number,
  ): Promise<{ id: string; pickups: number; until: number; token: string }[]> {
    const t = now();
    const claimable = and(
      eq(jobRuns.status, 'pending'),
      sql`${jobRuns.runAfter} <= ${t}`,
      sql`(${jobRuns.lockedUntil} is null or ${jobRuns.lockedUntil} < ${t})`,
      // A run this process still executes is never claimed again here, even if its lease ran out meanwhile.
      ...(held.size > 0 ? [notInArray(jobRuns.id, [...held.keys()])] : []),
    );
    // SKIP LOCKED leaves rows another worker is claiming right now to that worker. The conditions are repeated on the UPDATE,
    // which Postgres re-checks on the latest row version after waiting for a lock, so a run is never claimed twice.
    const pending = db
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .where(claimable)
      .orderBy(jobRuns.createdAt)
      .limit(limit)
      .for('update', { skipLocked: true });
    const prefix = `${id}:${t}:`;
    return db
      .update(jobRuns)
      .set({
        lockedBy: sql`${prefix} || ${jobRuns.id}`,
        lockedUntil: t + leaseMs,
        pickups: sql`${jobRuns.pickups} + 1`,
      })
      .where(and(inArray(jobRuns.id, pending), claimable))
      .returning({
        id: jobRuns.id,
        pickups: jobRuns.pickups,
        until: sql<number>`${jobRuns.lockedUntil}`.mapWith(Number),
        token: sql<string>`${jobRuns.lockedBy}`,
      });
  }

  /** Ends a run this claim holds; a no-op if the lease moved on. */
  async function end(lease: Lease, status: 'done' | 'dead') {
    await db
      .update(jobRuns)
      .set({ status, lockedBy: null, lockedUntil: null, finishedAt: now() })
      .where(
        and(eq(jobRuns.id, lease.runId), eq(jobRuns.lockedBy, lease.token), eq(jobRuns.status, 'pending')),
      );
  }

  /**
   * Gives a run back without counting the claim against the poison limit: on shutdown (claimable at once) or after the worker's own
   * database trouble (claimable after retryRunAfterMs).
   */
  async function release(runId: string, token: string, after = 0) {
    await db
      .update(jobRuns)
      .set({
        lockedBy: null,
        lockedUntil: null,
        pickups: sql`greatest(${jobRuns.pickups} - 1, 0)`,
        runAfter: now() + after,
      })
      .where(and(eq(jobRuns.id, runId), eq(jobRuns.lockedBy, token), eq(jobRuns.status, 'pending')));
  }

  /** Upstream task IDs a run placed: those recorded on the job, plus prep hedge copies, which only live in step results. */
  async function upstreamTasks(runId: string, recorded: readonly string[]): Promise<string[]> {
    const hedges = await db
      .select({ result: jobSteps.result })
      .from(jobSteps)
      .where(and(eq(jobSteps.runId, runId), like(jobSteps.name, 'hedge:%'), isNotNull(jobSteps.doneAt)));
    const copies = hedges.flatMap((row) => {
      const value = (row.result as { v?: unknown } | null)?.v;
      return typeof value === 'string' ? [value] : [];
    });
    return [...recorded, ...copies];
  }

  /** Poison or stuck: cancel what the job still has running upstream (it would keep billing), then fail and refund it. */
  async function bury(lease: Lease, why: string) {
    const job = await loadJob(db, lease.runId);
    if (job && !TERMINAL.includes(job.status)) {
      const adapter = deps.adapters[job.upstream];
      if (adapter)
        await within(CANCEL_LIMIT_MS, cancelAll(adapter, await upstreamTasks(lease.runId, upstreamIds(job))));
    }
    // A job that already ended keeps its state; settlement is idempotent and completes in case the last run died before settle.
    if (job) await markFailed(db, lease.runId, 'failed', 'stale', why);
    await end(lease, 'dead');
  }

  async function stuckAt(runId: string): Promise<number> {
    const job = await loadJob(db, runId);
    const model = job && deps.models.find((m) => m.id === job.modelId);
    if (!job || !model) return Number.POSITIVE_INFINITY;
    return job.createdAt + model.timeoutMinutes * 60_000 + stuckGraceMs;
  }

  async function execute(run: { id: string; pickups: number; until: number; token: string }) {
    const lease: Lease = { runId: run.id, token: run.token, abort: new AbortController(), until: run.until };
    const entry: Held = { lease, stuckAt: Number.POSITIVE_INFINITY };
    held.set(run.id, entry);
    try {
      if (run.pickups > maxPickups) {
        log('job run is poison', { jobId: run.id, pickups: run.pickups });
        await bury(lease, 'the job kept stopping before it finished');
        return;
      }
      entry.stuckAt = await stuckAt(run.id);
      const steps = leasedSteps(db, lease, stepOptions);
      try {
        await runGeneration(deps, run.id, steps);
      } catch (error) {
        if (error instanceof RunLost) throw error;
        // runGeneration has its own fallback; this catches what escapes it.
        await steps.do('abort:outer', async () => {
          await markFailed(db, run.id, 'failed', 'workflow_failed', String(error));
          return true;
        });
      }
      // runGeneration swallows errors of best-effort steps (notify, cost): a run stopped in one of them is not finished.
      if (lease.abort.signal.aborted) throw lease.abort.signal.reason;
      const job = await loadJob(db, run.id);
      if (job && !TERMINAL.includes(job.status)) {
        // Shouldn't happen: leave the lease to expire so the run is replayed; pickups bound how often.
        log('job run ended with the job unfinished', { jobId: run.id, status: job.status });
        return;
      }
      await end(lease, 'done');
    } catch (error) {
      if (error instanceof RunLost) {
        if (error.reason === 'stopping') await release(run.id, run.token).catch(() => {});
        if (error.reason === 'engine') await release(run.id, run.token, retryRunAfterMs).catch(() => {});
        log('job run left to be replayed', { jobId: run.id, reason: error.reason });
        return;
      }
      // The lease expires and the run is replayed; pickups bound how often.
      log('job run crashed', { jobId: run.id, error: String(error) });
    } finally {
      if (held.get(run.id) === entry) held.delete(run.id);
    }
  }

  async function heartbeat() {
    if (held.size === 0) return;
    const t = now();
    // Runs stuck past their job's deadline are buried, and their slot is freed even though the stuck call never returns.
    for (const [runId, entry] of held) {
      if (t < entry.stuckAt || entry.lease.abort.signal.aborted) continue;
      abortLease(entry.lease, 'stuck');
      held.delete(runId);
      log('job run stuck past its deadline', { jobId: runId });
      void bury(entry.lease, 'the job got stuck').catch((error: unknown) =>
        log('burying a stuck run failed', { jobId: runId, error: String(error) }),
      );
    }
    const leases = [...held.values()].map((entry) => entry.lease);
    if (leases.length === 0) return;
    const kept = await db
      .update(jobRuns)
      .set({ lockedUntil: t + leaseMs })
      .where(
        and(
          inArray(
            jobRuns.id,
            leases.map((lease) => lease.runId),
          ),
          inArray(
            jobRuns.lockedBy,
            leases.map((lease) => lease.token),
          ),
          eq(jobRuns.status, 'pending'),
        ),
      )
      .returning({ id: jobRuns.id });
    const keptIds = new Set(kept.map((row) => row.id));
    for (const lease of leases) {
      if (keptIds.has(lease.runId)) lease.until = t + leaseMs;
      else abortLease(lease, 'lost');
    }
  }

  async function cleanup() {
    const before = now() - keepStepsMs;
    const ended = db
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .where(and(ne(jobRuns.status, 'pending'), lt(jobRuns.finishedAt, before)));
    await db.delete(jobSteps).where(inArray(jobSteps.runId, ended));
    await db.delete(jobRuns).where(and(ne(jobRuns.status, 'pending'), lt(jobRuns.finishedAt, before)));
  }

  async function poll() {
    if (stopping) return;
    const free = slots - held.size;
    if (free > 0) {
      for (const run of await claim(free)) {
        // stop() began while claiming: hand the run straight back.
        if (stopping) {
          await release(run.id, run.token).catch(() => {});
          continue;
        }
        const task = execute(run);
        running.add(task);
        void task.finally(() => running.delete(task));
      }
    }
    if (!stopping && now() - lastCleanup > CLEANUP_EVERY_MS) {
      lastCleanup = now();
      await cleanup().catch((error: unknown) => log('job step cleanup failed', { error: String(error) }));
    }
  }

  function schedule(ms: number) {
    if (stopping) return;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(tick, ms);
  }

  function tick() {
    wakeTimer = null;
    if (polling) return;
    polling = poll()
      .catch((error: unknown) => log('job worker poll failed', { error: String(error) }))
      .finally(() => {
        polling = null;
        schedule(pollMs);
      });
  }

  const beat = setInterval(() => {
    void heartbeat().catch((error: unknown) => log('job worker heartbeat failed', { error: String(error) }));
  }, heartbeatMs);
  schedule(0);

  return {
    id,
    get active() {
      return held.size;
    },
    wake() {
      schedule(0);
    },
    async stop() {
      stopping = true;
      if (wakeTimer) clearTimeout(wakeTimer);
      for (const entry of held.values()) abortLease(entry.lease, 'stopping');
      await polling;
      for (const entry of held.values()) abortLease(entry.lease, 'stopping');
      // A step that never returns would hold this forever; its lease simply expires and another process replays the run.
      await within(stopGraceMs, Promise.allSettled([...running]));
      clearInterval(beat);
    },
  };
}
