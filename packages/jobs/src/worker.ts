import type { Db } from '@shipwords/core/db/client';
import { and, eq, inArray, lt, ne, notInArray, sql } from 'drizzle-orm';
import { cancelAll, loadJob, markFailed, upstreamIds } from './lifecycle';
import { type RunnerDeps, runGeneration, type StepRunner } from './runner';
import { jobRuns, jobSteps, TERMINAL } from './schema';

// Durable execution of runGeneration on Postgres, in place of Cloudflare Workflows.
//
// - A job's run row is inserted with the job (handlers.ts). Each process runs a loop that claims pending runs with
//   SELECT … FOR UPDATE SKIP LOCKED and holds each one by a lease it keeps extending. Every claim writes its own token into
//   locked_by, so saves, heartbeats and releases match one claim, never an older one of the same process.
// - step.do(name, fn) returns a finished step's saved result without running fn, so a replay skips the work already done;
//   otherwise it runs fn with a time limit, retrying with exponential backoff (the attempt count survives a replay), and saves
//   the result. Steps are at least once: a crash after fn but before the save runs fn again, as on Workflows, and the runner's
//   steps are written for that.
// - Before fn starts the worker confirms in the database that it still holds the lease, and it saves the result only under the
//   lease. Once the lease is lost, or the process is stopping, every later step throws RunLost without running. That includes the
//   runner's own abort and settle steps, so a worker that lost a run can't fail and refund a job another worker is finishing.
// - The worker's own database trouble (reading or saving a step) never reaches the runner as a step failure, which would fail
//   and refund a paid job: the worker stops the run instead, and it is replayed once the lease expires.
// - A run marked done always has a finished job. A run whose job is still in progress when runGeneration returns is left to be
//   replayed; a run claimed too often without finishing is poison: its upstream tasks are canceled and the job is failed
//   ('stale') and refunded without running it again.

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
  /** A step running longer counts as a failed attempt. Runner steps take seconds to a minute or two. */
  stepTimeoutMs?: number;
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
  stepTimeoutMs: 10 * 60_000,
  keepStepsMs: 30 * 24 * 3_600_000,
} as const;

const CLEANUP_EVERY_MS = 3_600_000;
/** A step doesn't start this close to the lease's end: the heartbeat should have extended it long before. */
const LEASE_MARGIN_MS = 5_000;
/** The worker's own reads and writes are retried this often before it gives the run up for a later replay. */
const ENGINE_ATTEMPTS = 3;

/** Thrown by a step once this worker may no longer run the job: it lost the lease, the process is stopping, or its own bookkeeping failed. */
export class RunLost extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId} is no longer held by this worker`);
    this.name = 'RunLost';
  }
}

/** Step results are saved as JSON; a fresh run returns the same round-tripped value a replay would. */
function encode(value: unknown): { v?: unknown } {
  return JSON.parse(JSON.stringify({ v: value })) as { v?: unknown };
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

class StepTimeout extends Error {
  constructor(name: string, ms: number) {
    super(`step ${name} took longer than ${ms} ms`);
    this.name = 'StepTimeout';
  }
}

/** Resolves or rejects with fn, or rejects with StepTimeout after ms. fn keeps running in the background; steps are at least once. */
function withTimeout<T>(name: string, ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(name, ms)), ms);
  });
  return Promise.race([fn(), limit]).finally(() => clearTimeout(timer));
}

export interface Lease {
  runId: string;
  /** This claim's locked_by value. */
  token: string;
  /** Aborted when the lease is lost or the worker stops; pending waits end at once, and no step runs after. */
  abort: AbortController;
  /** locked_until as last written by this worker. */
  until: number;
}

export interface JobWorker {
  readonly id: string;
  /** Look for pending runs now, e.g. right after a job is created in this process. */
  wake(): void;
  /** Stop claiming; let steps in flight finish, then release the leases so another process picks the runs up at once. */
  stop(): Promise<void>;
  /** Runs held right now (for tests and health checks). */
  readonly active: number;
}

interface StepOptions {
  retries: number;
  retryDelayMs: number;
  stepTimeoutMs: number;
  now: () => number;
}

/** Steps of one run, bound to one claim's lease on it. */
export function leasedSteps(db: Db, lease: Lease, options: StepOptions): StepRunner {
  const { runId, token } = lease;
  /** From here on every step of this run throws, including the runner's abort and settle steps. */
  const lost = () => {
    const error = new RunLost(runId);
    if (!lease.abort.signal.aborted) lease.abort.abort(error);
    return error;
  };

  /** The worker's own database work. A failure that persists stops the run (replayed later); it never becomes a step failure. */
  async function engine<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (error) {
        if (error instanceof RunLost) throw error;
        if (attempt >= ENGINE_ATTEMPTS) throw lost();
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
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

  async function stepRow(name: string) {
    const [row] = await db
      .select()
      .from(jobSteps)
      .where(and(eq(jobSteps.runId, runId), eq(jobSteps.name, name)));
    return row ?? null;
  }

  /** Confirms, locally and in the database, that a step may start now. */
  async function check() {
    if (lease.abort.signal.aborted || options.now() > lease.until - LEASE_MARGIN_MS) throw lost();
    const [row] = await engine(() =>
      db
        .select({ id: jobRuns.id })
        .from(jobRuns)
        .where(heldWhere(options.now() + LEASE_MARGIN_MS)),
    );
    if (!row) throw lost();
  }

  /** Saves a step outcome only while this claim still holds the lease; otherwise throws RunLost. */
  async function save(
    name: string,
    fields: { result?: { v?: unknown }; attempts: number; error: string | null; done: boolean },
  ) {
    await engine(() =>
      db.transaction(async (tx) => {
        const [held] = await tx
          .select({ id: jobRuns.id })
          .from(jobRuns)
          .where(heldWhere(options.now()))
          .for('update');
        if (!held) throw lost();
        const values = {
          result: fields.result ?? null,
          attempts: fields.attempts,
          error: fields.error,
          doneAt: fields.done ? options.now() : null,
        };
        await tx
          .insert(jobSteps)
          .values({ runId, name, ...values })
          .onConflictDoUpdate({ target: [jobSteps.runId, jobSteps.name], set: values });
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
    async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const row = await engine(() => stepRow(name));
      if (row?.doneAt != null) return (row.result as { v?: unknown } | null)?.v as T;
      // Attempts made before a crash or a handover count: a replay doesn't get a fresh set of retries.
      const done = row?.attempts ?? 0;
      if (done > options.retries) throw new Error(row?.error ?? `step ${name} failed`);
      if (done > 0) await backoff(done);
      for (let attempt = done + 1; ; attempt++) {
        await check();
        let value: T;
        try {
          value = await withTimeout(name, options.stepTimeoutMs, fn);
        } catch (error) {
          if (error instanceof RunLost) throw error;
          const message = error instanceof Error ? error.message : String(error);
          await save(name, { attempts: attempt, error: message.slice(0, 2_000), done: false });
          if (attempt > options.retries) throw error;
          await backoff(attempt);
          continue;
        }
        const result = encode(value);
        await save(name, { result, attempts: attempt, error: null, done: true });
        return result.v as T;
      }
    },

    async sleep(name: string, ms: number): Promise<void> {
      const row = await engine(() => stepRow(name));
      if (row?.doneAt != null) return;
      await check();
      try {
        await abortableDelay(ms, lease.abort.signal);
      } catch {
        throw lost();
      }
      await save(name, { attempts: 1, error: null, done: true });
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
  const keepStepsMs = options.keepStepsMs ?? DEFAULTS.keepStepsMs;
  const now = options.now ?? Date.now;
  const log = options.log ?? deps.log ?? (() => {});
  const stepOptions: StepOptions = {
    retries: options.retries ?? DEFAULTS.retries,
    retryDelayMs: options.retryDelayMs ?? DEFAULTS.retryDelayMs,
    stepTimeoutMs: options.stepTimeoutMs ?? DEFAULTS.stepTimeoutMs,
    now,
  };
  // A heartbeat must land well before a step would refuse to start for a lease about to end.
  if (leaseMs - LEASE_MARGIN_MS < 2 * heartbeatMs)
    throw new Error(
      `leaseMs (${leaseMs}) must be at least ${LEASE_MARGIN_MS} ms plus two heartbeats (${heartbeatMs} ms)`,
    );

  const held = new Map<string, Lease>();
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
  async function finish(lease: Lease, status: 'done' | 'dead') {
    await db
      .update(jobRuns)
      .set({ status, lockedBy: null, lockedUntil: null, finishedAt: now() })
      .where(
        and(eq(jobRuns.id, lease.runId), eq(jobRuns.lockedBy, lease.token), eq(jobRuns.status, 'pending')),
      );
  }

  /** Gives a run back so another worker can claim it at once (shutdown); the claim isn't counted against the poison limit. */
  async function release(runId: string, token: string) {
    await db
      .update(jobRuns)
      .set({ lockedBy: null, lockedUntil: null, pickups: sql`greatest(${jobRuns.pickups} - 1, 0)` })
      .where(and(eq(jobRuns.id, runId), eq(jobRuns.lockedBy, token), eq(jobRuns.status, 'pending')));
  }

  /** Poison: cancel what the job still has running upstream (it would keep billing), then fail and refund it. */
  async function bury(lease: Lease) {
    const job = await loadJob(db, lease.runId);
    if (job && !TERMINAL.includes(job.status)) {
      const adapter = deps.adapters[job.upstream];
      if (adapter) await cancelAll(adapter, upstreamIds(job));
    }
    // A job that already ended keeps its state; settlement is idempotent and completes in case the last run died before settle.
    if (job) await markFailed(db, lease.runId, 'failed', 'stale', 'the job kept stopping before it finished');
    await finish(lease, 'dead');
  }

  async function execute(run: { id: string; pickups: number; until: number; token: string }) {
    const lease: Lease = { runId: run.id, token: run.token, abort: new AbortController(), until: run.until };
    held.set(run.id, lease);
    try {
      if (run.pickups > maxPickups) {
        log('job run is poison', { jobId: run.id, pickups: run.pickups });
        await bury(lease);
        return;
      }
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
      if (lease.abort.signal.aborted) throw new RunLost(run.id);
      const job = await loadJob(db, run.id);
      if (job && !TERMINAL.includes(job.status)) {
        // Shouldn't happen: leave the lease to expire so the run is replayed; pickups bound how often.
        log('job run ended with the job unfinished', { jobId: run.id, status: job.status });
        return;
      }
      await finish(lease, 'done');
    } catch (error) {
      if (error instanceof RunLost) {
        if (stopping) await release(run.id, run.token).catch(() => {});
        log('job run left to be replayed', { jobId: run.id });
        return;
      }
      // The lease expires and the run is replayed; pickups bound how often.
      log('job run crashed', { jobId: run.id, error: String(error) });
    } finally {
      held.delete(run.id);
    }
  }

  async function heartbeat() {
    if (held.size === 0) return;
    const leases = [...held.values()];
    const t = now();
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
      else lease.abort.abort(new RunLost(lease.runId));
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

  function schedule(delay: number) {
    if (stopping) return;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(tick, delay);
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
      for (const lease of held.values()) lease.abort.abort(new RunLost(lease.runId));
      await polling;
      for (const lease of held.values()) lease.abort.abort(new RunLost(lease.runId));
      await Promise.allSettled([...running]);
      clearInterval(beat);
    },
  };
}
