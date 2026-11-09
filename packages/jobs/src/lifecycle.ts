import { refundSpend } from '@shipwords/core/credits/ledger';
import type { BatchItem, Db } from '@shipwords/core/db/client';
import { quotaCounters } from '@shipwords/core/db/schema';
import type { QuotaRule } from '@shipwords/core/quota/counters';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type JobRow, jobs, TERMINAL } from './schema';
import type { UpstreamAdapter } from './upstream';

// Every write to job state goes through here. Each state change is a conditional UPDATE;
// refunds and quota returns after failure or cancel settle on the final state, so they can be repeated and survive partial failure.

const ACTIVE: JobRow['status'][] = ['queued', 'submitted'];

export const spendKey = (jobId: string) => `job:${jobId}`;

export async function loadJob(db: Db, jobId: string): Promise<JobRow | null> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return row ?? null;
}

/** The job while it is still in progress; null once it has ended or is gone. */
export async function activeJob(db: Db, jobId: string): Promise<JobRow | null> {
  const job = await loadJob(db, jobId);
  return job && !TERMINAL.includes(job.status) ? job : null;
}

export async function markSubmitted(db: Db, jobId: string, upstreamJobId: string): Promise<boolean> {
  const result = await db
    .update(jobs)
    .set({ status: 'submitted', upstreamJobId, submittedAt: Date.now() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued')))
    .run();
  return result.meta.changes > 0;
}

/** upstream_job_id stores upstream task IDs comma-separated in segment order; a single-part job has one ID. */
/** Placeholder ID recorded in a segment slot when the upstream rejects a prep submit: no upstream task, never polled or canceled. */
export const SKIPPED_UPSTREAM = 'skipped:';

export function upstreamIds(job: Pick<JobRow, 'upstreamJobId'>): string[] {
  return job.upstreamJobId ? job.upstreamJobId.split(',') : [];
}

/**
 * Record the upstream task ID for segment `index` (0-based). Segment 0 also advances the job to submitted;
 * later segments are appended only while the job is in progress and exactly the first `index` segments are recorded, so replays never duplicate or misalign.
 * Returns false if the job has ended (or was advanced elsewhere); the caller should cancel the upstream task it just submitted.
 */
export async function appendUpstreamJob(
  db: Db,
  jobId: string,
  index: number,
  upstreamJobId: string,
): Promise<boolean> {
  if (index === 0 && (await markSubmitted(db, jobId, upstreamJobId))) return true;
  const job = await loadJob(db, jobId);
  if (index === 0) return job?.status === 'submitted' && upstreamIds(job)[0] === upstreamJobId;
  if (job?.status !== 'submitted') return false;
  const ids = upstreamIds(job);
  if (ids[index] === upstreamJobId) return true;
  if (ids.length !== index) return false;
  const result = await db
    .update(jobs)
    .set({ upstreamJobId: [...ids, upstreamJobId].join(',') })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'submitted'), eq(jobs.upstreamJobId, job.upstreamJobId!)))
    .run();
  return result.meta.changes > 0;
}

export interface StoredOutput {
  key: string;
  mediaType: string;
}

export async function markSucceeded(db: Db, jobId: string, outputs: StoredOutput[]): Promise<boolean> {
  const result = await db
    .update(jobs)
    .set({ status: 'succeeded', outputsJson: JSON.stringify(outputs), finishedAt: Date.now() })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ACTIVE)))
    .run();
  return result.meta.changes > 0;
}

/** Record the upstream charge of an ended job; only bookkeeping, it never touches state or credits, so a re-read simply overwrites it. */
export async function recordUpstreamCost(db: Db, jobId: string, usd: string): Promise<void> {
  await db.update(jobs).set({ upstreamCostUsd: usd }).where(eq(jobs.id, jobId)).run();
}

/** Move an in-progress job to failed or canceled, then settle the refund. If the job already ended the state isn't changed, but settlement still runs. */
export async function markFailed(
  db: Db,
  jobId: string,
  status: 'failed' | 'canceled',
  code: string,
  message: string,
): Promise<JobRow | null> {
  await db
    .update(jobs)
    .set({ status, errorCode: code, errorMessage: message.slice(0, 500), finishedAt: Date.now() })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ACTIVE)));
  const job = await loadJob(db, jobId);
  if (job) await settleFailure(db, job);
  return job;
}

/**
 * User cancel: only while nothing has been submitted upstream, then settle the refund. A running upstream task bills whether or not
 * it is canceled, so refunding then would let a user loop submit → cancel for free renders; such a job keeps going and delivers.
 * The first submit moves the job out of queued with a conditional update too (markSubmitted), so exactly one of the two wins;
 * when the cancel wins, the runner cancels the task it just submitted. Returns the job as it is now.
 */
export async function cancelQueued(db: Db, jobId: string): Promise<JobRow | null> {
  await db
    .update(jobs)
    .set({
      status: 'canceled',
      errorCode: 'canceled',
      errorMessage: 'canceled by user',
      finishedAt: Date.now(),
    })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued')));
  const job = await loadJob(db, jobId);
  if (job) await settleFailure(db, job);
  return job;
}

/**
 * Failed and canceled jobs: refund credits (idempotent). Failed guest jobs also return their quota (once); canceled ones don't, because the
 * upstream may already have charged us (a cancel just before the result lands), and returning it would let one guest loop create → cancel forever.
 * Succeeded jobs do nothing.
 */
export async function settleFailure(db: Db, job: JobRow): Promise<void> {
  if (job.status !== 'failed' && job.status !== 'canceled') return;
  if (job.costCredits > 0 && job.userId) {
    await refundSpend(db, {
      spendIdemKey: spendKey(job.id),
      idemKey: `refund:${spendKey(job.id)}`,
      ref: job.id,
    });
  }
  if (job.status === 'failed' && job.quotaJson && !job.quotaReleased) {
    // The quota decrements and the "returned" flag share one batch: each decrement is conditioned on the flag not being set,
    // so repeated calls return once, and a partial failure can't leave "flag set, count not returned".
    const notReleased = sql`exists (select 1 from ${jobs} where ${jobs.id} = ${job.id} and ${jobs.quotaReleased} = 0)`;
    const rules = JSON.parse(job.quotaJson) as QuotaRule[];
    const decrements = rules.map((rule) =>
      db
        .update(quotaCounters)
        .set({ count: sql`max(${quotaCounters.count} - 1, 0)` })
        .where(and(eq(quotaCounters.key, rule.key), eq(quotaCounters.window, rule.window), notReleased)),
    );
    // The flag must come last: the decrements above are conditioned on it not being set.
    const markReleased = db.update(jobs).set({ quotaReleased: true }).where(eq(jobs.id, job.id));
    const items: BatchItem[] = [...decrements, markReleased];
    await db.batch(items as [BatchItem, ...BatchItem[]]);
  }
}

/** After a guest signs in, move this device's guest jobs to the new account. */
export async function claimGuestJobs(db: Db, guestId: string, userId: string): Promise<void> {
  await db
    .update(jobs)
    .set({ userId })
    .where(and(eq(jobs.guestId, guestId), isNull(jobs.userId)))
    .run();
}

/** Best-effort cancel of upstream tasks (prep placeholders skipped): a task left running keeps billing. */
export async function cancelAll(adapter: UpstreamAdapter, ids: readonly string[]) {
  await Promise.all(
    ids
      .filter((id) => !id.startsWith(SKIPPED_UPSTREAM))
      .map((id) => adapter.cancel(id).catch(() => undefined)),
  );
}
