import type { Db } from '@shipwords/core/db/client';
import { and, asc, desc, eq, lt, not, or } from 'drizzle-orm';
import { type JobRow, jobs } from './schema';

/**
 * A signed-in user whose jobs fail this many times with no success in between is worth a human look: a user who keeps retrying a
 * broken model wants the result badly, and nothing else tells us (on 2026-11-13 one paying user failed 15 jobs in a row unnoticed).
 */
export const FAILURE_STREAK = 3;

/**
 * Failures written outside the runner, so nobody checks the streak when they end: dispatch_failed (the Workflow never started) and
 * stale (its instance died). They count toward the streak but leave the alert to the next failure the runner checks.
 */
export const UNCHECKED_FAILURES: readonly string[] = ['dispatch_failed', 'stale'];

/** At most this many failures of one streak are read; a longer streak alerted long before. */
const STREAK_READ = 50;

/**
 * The streak's failed jobs up to the job just ended, newest first, when that job should send the streak's alert; otherwise null.
 * The streak is the user's failures since their latest success before it, ordered by when jobs ended (finishedAt, then id), so the
 * jobs before a job never change once it has ended. The alert goes to the FAILURE_STREAK-th failure, or, when that one and the
 * ones after it ended outside the runner (UNCHECKED_FAILURES), to the first later failure the runner checks: one alert per streak,
 * whenever the checks run and in whatever order jobs were created or end; later failures stay quiet until a success starts a new
 * count. Canceled jobs (the user's own doing) and jobs still running are not in it. Failures from the Workflow's outer catch carry
 * internal_error like the runner's own and count as checked. finishedAt comes from the Worker clock, so only two jobs of one user
 * ending in the same few milliseconds on different isolates, committed out of clock order, can make one streak alert twice or not at all.
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
    .orderBy(asc(jobs.finishedAt), asc(jobs.id))
    .limit(STREAK_READ);
  const position = streak.findIndex((row) => row.id === id);
  if (position < FAILURE_STREAK - 1) return null;
  // Every failure from the FAILURE_STREAK-th up to this one ended unchecked: nobody has alerted for this streak yet.
  const before = streak.slice(FAILURE_STREAK - 1, position);
  if (!before.every((row) => UNCHECKED_FAILURES.includes(row.errorCode ?? ''))) return null;
  return streak.slice(0, position + 1).reverse();
}
