import type { Db } from '@shipwords/core/db/client';
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { markFailed } from './lifecycle';
import { type RunnerDeps, runGeneration, type StepRunner } from './runner';
import { jobRuns, jobSteps } from './schema';

// Durable execution of runGeneration on Postgres, in place of Cloudflare Workflows.
//
// - A job's run row is inserted with the job (handlers.ts). Each process runs a loop that claims pending runs with
//   SELECT … FOR UPDATE SKIP LOCKED and holds each one by a lease it keeps extending.
// - step.do(name, fn) returns a finished step's saved result without running fn, so a replay skips the work already done;
//   otherwise it runs fn, retrying with exponential backoff, and saves the result. Steps are at least once: a crash after fn
//   but before the save runs fn again, as on Workflows, and the runner's steps are written for that.
// - Before running fn, and in the transaction that saves its result, the worker checks it still holds the lease. A worker that
//   lost its lease, or is shutting down, throws RunLost from every step without running it. That includes the runner's own
//   abort step, so a worker that lost a run can never fail and refund a job another worker is finishing.
// - When a process dies its leases expire and another loop replays the runs. A run claimed too often without finishing is
//   poison: the job is failed ('stale') and refunded without running it again.

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
  keepStepsMs: 30 * 24 * 3_600_000,
} as const;

const CLEANUP_EVERY_MS = 3_600_000;

/** Thrown by a step once this worker may no longer run the job: it lost the lease, or the process is stopping. */
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

export interface Lease {
  runId: string;
  /** Aborted when the lease is lost or the worker stops; pending waits end at once, and no step runs after. */
  abort: AbortController;
  /** locked_until as last written by this worker. Past it (less a margin) another worker may claim the run, so no step starts. */
  until: number;
}

/** A step doesn't start this close to the lease's end: the heartbeat should have extended it long before. */
const LEASE_MARGIN_MS = 5_000;

export interface JobWorker {
  readonly id: string;
  /** Look for pending runs now, e.g. right after a job is created in this process. */
  wake(): void;
  /** Stop claiming; let steps in flight finish, then release the leases so another process picks the runs up at once. */
  stop(): Promise<void>;
  /** Runs held right now (for tests and health checks). */
  readonly active: number;
}

/** Steps of one run, bound to this worker's lease on it. */
export function leasedSteps(
  db: Db,
  workerId: string,
  lease: Lease,
  options: Required<Pick<WorkerOptions, 'retries' | 'retryDelayMs'>> & { now: () => number },
): StepRunner {
  const { runId } = lease;
  /** From here on every step of this run throws, including the runner's abort and settle steps. */
  const lost = () => {
    const error = new RunLost(runId);
    if (!lease.abort.signal.aborted) lease.abort.abort(error);
    return error;
  };

  async function saved(name: string): Promise<{ found: true; value: unknown } | { found: false }> {
    const [row] = await db
      .select({ result: jobSteps.result, doneAt: jobSteps.doneAt })
      .from(jobSteps)
      .where(and(eq(jobSteps.runId, runId), eq(jobSteps.name, name)));
    if (row?.doneAt == null) return { found: false };
    return { found: true, value: (row.result as { v?: unknown } | null)?.v };
  }

  /** Saves a step outcome only while this worker still holds the lease; otherwise throws RunLost. */
  async function save(
    name: string,
    fields: { result?: { v?: unknown }; attempts: number; error: string | null; done: boolean },
  ) {
    await db.transaction(async (tx) => {
      const [held] = await tx
        .select({ id: jobRuns.id })
        .from(jobRuns)
        .where(
          and(
            eq(jobRuns.id, runId),
            eq(jobRuns.status, 'pending'),
            eq(jobRuns.lockedBy, workerId),
            sql`${jobRuns.lockedUntil} > ${options.now()}`,
          ),
        )
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
    });
  }

  function check() {
    if (lease.abort.signal.aborted || options.now() > lease.until - LEASE_MARGIN_MS) throw lost();
  }

  return {
    async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const before = await saved(name);
      if (before.found) return before.value as T;
      for (let attempt = 1; ; attempt++) {
        check();
        let value: T;
        try {
          value = await fn();
        } catch (error) {
          if (error instanceof RunLost) throw error;
          const message = error instanceof Error ? error.message : String(error);
          await save(name, { attempts: attempt, error: message.slice(0, 2_000), done: false });
          if (attempt > options.retries) throw error;
          try {
            await abortableDelay(options.retryDelayMs * 2 ** (attempt - 1), lease.abort.signal);
          } catch {
            throw lost();
          }
          continue;
        }
        const result = encode(value);
        await save(name, { result, attempts: attempt, error: null, done: true });
        return result.v as T;
      }
    },

    async sleep(name: string, ms: number): Promise<void> {
      const before = await saved(name);
      if (before.found) return;
      check();
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
  const stepOptions = {
    retries: options.retries ?? DEFAULTS.retries,
    retryDelayMs: options.retryDelayMs ?? DEFAULTS.retryDelayMs,
    now,
  };

  const held = new Map<string, Lease>();
  const running = new Set<Promise<void>>();
  let stopping = false;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let polling: Promise<void> | null = null;
  let lastCleanup = 0;

  async function claim(limit: number): Promise<{ id: string; pickups: number; until: number }[]> {
    const t = now();
    const claimable = and(
      eq(jobRuns.status, 'pending'),
      sql`${jobRuns.runAfter} <= ${t}`,
      sql`(${jobRuns.lockedUntil} is null or ${jobRuns.lockedUntil} < ${t})`,
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
    return db
      .update(jobRuns)
      .set({ lockedBy: id, lockedUntil: t + leaseMs, pickups: sql`${jobRuns.pickups} + 1` })
      .where(and(inArray(jobRuns.id, pending), claimable))
      .returning({
        id: jobRuns.id,
        pickups: jobRuns.pickups,
        until: sql<number>`${jobRuns.lockedUntil}`.mapWith(Number),
      });
  }

  /** Ends a run this worker holds; a no-op if the lease moved on. */
  async function finish(runId: string, status: 'done' | 'dead') {
    await db
      .update(jobRuns)
      .set({ status, lockedBy: null, lockedUntil: null, finishedAt: now() })
      .where(and(eq(jobRuns.id, runId), eq(jobRuns.lockedBy, id), eq(jobRuns.status, 'pending')));
  }

  /** Gives a run back so another worker can claim it at once (shutdown); the claim isn't counted against the poison limit. */
  async function release(runId: string) {
    await db
      .update(jobRuns)
      .set({ lockedBy: null, lockedUntil: null, pickups: sql`greatest(${jobRuns.pickups} - 1, 0)` })
      .where(and(eq(jobRuns.id, runId), eq(jobRuns.lockedBy, id), eq(jobRuns.status, 'pending')));
  }

  async function execute(runId: string, pickups: number, until: number) {
    const lease: Lease = { runId, abort: new AbortController(), until };
    held.set(runId, lease);
    try {
      if (pickups > maxPickups) {
        log('job run is poison', { jobId: runId, pickups });
        await markFailed(db, runId, 'failed', 'stale', 'the job kept stopping before it finished');
        await finish(runId, 'dead');
        return;
      }
      const steps = leasedSteps(db, id, lease, stepOptions);
      try {
        await runGeneration(deps, runId, steps);
      } catch (error) {
        if (error instanceof RunLost) throw error;
        // runGeneration has its own fallback; this catches what escapes it (e.g. a database outage during settle).
        await steps.do('abort:outer', async () => {
          await markFailed(db, runId, 'failed', 'workflow_failed', String(error));
          return true;
        });
      }
      await finish(runId, 'done');
    } catch (error) {
      if (error instanceof RunLost) {
        if (stopping) await release(runId).catch(() => {});
        log('job run left to another worker', { jobId: runId });
        return;
      }
      // The lease expires and the run is replayed; pickups bound how often.
      log('job run crashed', { jobId: runId, error: String(error) });
    } finally {
      held.delete(runId);
    }
  }

  async function heartbeat() {
    if (held.size === 0) return;
    const ids = [...held.keys()];
    const t = now();
    const kept = await db
      .update(jobRuns)
      .set({ lockedUntil: t + leaseMs })
      .where(and(inArray(jobRuns.id, ids), eq(jobRuns.lockedBy, id), eq(jobRuns.status, 'pending')))
      .returning({ id: jobRuns.id });
    const keptIds = new Set(kept.map((row) => row.id));
    for (const runId of ids) {
      const lease = held.get(runId);
      if (!lease) continue;
      if (keptIds.has(runId)) lease.until = t + leaseMs;
      else lease.abort.abort(new RunLost(runId));
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
        const task = execute(run.id, run.pickups, run.until);
        running.add(task);
        void task.finally(() => running.delete(task));
      }
    }
    if (now() - lastCleanup > CLEANUP_EVERY_MS) {
      lastCleanup = now();
      await cleanup();
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
      await polling;
      for (const lease of held.values()) lease.abort.abort(new RunLost(lease.runId));
      await Promise.allSettled([...running]);
      clearInterval(beat);
    },
  };
}
