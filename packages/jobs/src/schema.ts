import { nowMs } from '@shipwords/core/db/schema';
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

const ms = (name: string) => bigint(name, { mode: 'number' });

/**
 * Generation jobs. State only moves forward: queued → submitted → succeeded | failed | canceled;
 * every state change is a conditional UPDATE, so a finished job can never be moved to another state.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    /** Signed-in users' jobs have userId; guest jobs only have guestId, and userId is filled in when claimed after sign-in. */
    userId: text('user_id'),
    guestId: text('guest_id'),
    modelId: text('model_id').notNull(),
    kind: text('kind', { enum: ['image', 'video', 'music'] }).notNull(),
    prompt: text('prompt').notNull(),
    inputJson: text('input_json').notNull(),
    costCredits: integer('cost_credits').notNull().default(0),
    /** Guest quota counting rule, used to return quota on failure. */
    quotaJson: text('quota_json'),
    quotaReleased: boolean('quota_released').notNull().default(false),
    status: text('status', { enum: ['queued', 'submitted', 'succeeded', 'failed', 'canceled'] })
      .notNull()
      .default('queued'),
    upstream: text('upstream').notNull(),
    upstreamJobId: text('upstream_job_id'),
    /** What the upstream actually charged (USD string), summed over every upstream task; null until read or when the upstream doesn't report it. */
    upstreamCostUsd: text('upstream_cost_usd'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /** R2 key and content type of the output. */
    outputsJson: text('outputs_json'),
    createdAt: ms('created_at').notNull().default(nowMs),
    submittedAt: ms('submitted_at'),
    finishedAt: ms('finished_at'),
  },
  (t) => [
    index('jobs_user_idx').on(t.userId, t.createdAt),
    index('jobs_guest_idx').on(t.guestId, t.createdAt),
  ],
);

/**
 * One run per job: the durable execution of runGeneration (worker.ts). Inserted in the same transaction as the job, so a job is never
 * charged without a run. A worker claims a pending run by taking its lease (locked_by, locked_until) and keeps extending it; when a
 * process dies the lease expires and another worker replays the run, finished steps coming back from job_steps.
 */
export const jobRuns = pgTable(
  'job_runs',
  {
    /** The job ID. */
    id: text('id').primaryKey(),
    /** pending: to run or running; done: runGeneration returned; dead: claimed too often without finishing, the job was failed. */
    status: text('status', { enum: ['pending', 'done', 'dead'] })
      .notNull()
      .default('pending'),
    /** Not claimed before this time (epoch ms). */
    runAfter: ms('run_after').notNull().default(nowMs),
    lockedBy: text('locked_by'),
    lockedUntil: ms('locked_until'),
    /** How many times a worker has claimed the run; past the limit it is treated as poison. */
    pickups: integer('pickups').notNull().default(0),
    createdAt: ms('created_at').notNull().default(nowMs),
    finishedAt: ms('finished_at'),
  },
  (t) => [index('job_runs_pending_idx').on(t.status, t.runAfter)],
);

/** Finished steps of a run, keyed by step name; a replay returns these instead of running the step again. */
export const jobSteps = pgTable(
  'job_steps',
  {
    runId: text('run_id').notNull(),
    name: text('name').notNull(),
    /** The step's return value as { v: value }, so undefined survives. Null until the step finishes. */
    result: jsonb('result'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    doneAt: ms('done_at'),
  },
  (t) => [primaryKey({ columns: [t.runId, t.name] })],
);

export type JobRow = typeof jobs.$inferSelect;
export type JobStatus = JobRow['status'];
export const TERMINAL: readonly JobStatus[] = ['succeeded', 'failed', 'canceled'];
