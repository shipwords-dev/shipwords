import type { Db } from '@shipwords/core/db/client';
import { and, desc, eq, lt, not, or } from 'drizzle-orm';
import { type JobRow, jobs } from './schema';

/**
 * A signed-in user whose jobs fail this many times with no success in between is worth a human look: a user who keeps retrying a
 * broken model wants the result badly, and nothing else tells us (on 2026-11-13 one paying user failed 15 jobs in a row unnoticed).
 */
export const FAILURE_STREAK = 3;

/**
 * The streak's failed jobs so far, newest first, when the job just ended is exactly the FAILURE_STREAK-th to fail since the user's
 * latest success before it; otherwise null. Ordered by when jobs ended (finishedAt, then id), so the jobs before it never change
 * once it has ended: each streak alerts once, whenever the check runs and in whatever order jobs were created or end, and later
 * failures stay quiet until a success starts a new count. Canceled jobs (the user's own doing) and jobs still running are not in it.
 * finishedAt comes from the Worker clock, so only two jobs of one user ending in the same few milliseconds on different isolates,
 * committed out of clock order, can make one streak alert twice or not at all.
 */
export async function failureStreak(db: Db, job: JobRow): Promise<JobRow[] | null> {
  if (job.status !== 'failed' || !job.userId || job.finishedAt == null) return null;
  const { userId, finishedAt, id } = job;
  /** Rows that ended before (at, key) in end order: finishedAt, then id for jobs that ended in the same millisecond. */
  const endedBefore = (at: number, key: string) =>
    or(lt(jobs.finishedAt, at), and(eq(jobs.finishedAt, at), lt(jobs.id, key)))!;
  const [success] = await db
    .select({ finishedAt: jobs.finishedAt, id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.userId, userId), eq(jobs.status, 'succeeded'), endedBefore(finishedAt, id)))
    .orderBy(desc(jobs.finishedAt), desc(jobs.id))
    .limit(1);
  const streak = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, userId),
        eq(jobs.status, 'failed'),
        // After the latest success, up to and including this job.
        success?.finishedAt != null ? not(endedBefore(success.finishedAt, success.id)) : undefined,
        or(endedBefore(finishedAt, id), eq(jobs.id, id)),
      ),
    )
    .orderBy(desc(jobs.finishedAt), desc(jobs.id))
    .limit(FAILURE_STREAK + 1);
  return streak.length === FAILURE_STREAK && streak[0]!.id === id ? streak : null;
}
