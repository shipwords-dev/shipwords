import type { Db } from '@shipwords/core/db/client';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueRun } from '../src/lifecycle';
import { defineModels } from '../src/models';
import { jobRuns, jobSteps, jobs } from '../src/schema';
import { startJobWorker } from '../src/worker';
import { adminUrl, freshDatabase } from './pg';

// SKIP LOCKED claims on separate connections: two workers polling the same queue never run one run twice.

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  if (!adminUrl) return;
  ({ db, close } = await freshDatabase());
});
afterAll(async () => close?.());

const models = defineModels([
  {
    id: 'fast',
    name: 'Fast',
    kind: 'image',
    upstream: 'yir',
    upstreamModel: 'vendor/fast',
    credits: 0,
    guest: false,
    allowedParameters: [],
    maxReferences: 0,
    timeoutMinutes: 10,
  },
]);

describe.skipIf(!adminUrl)('job workers on one queue', () => {
  it('two workers share 60 runs and each run is claimed and run exactly once', async () => {
    const ids = Array.from({ length: 60 }, () => `job_${crypto.randomUUID().replaceAll('-', '')}`);
    // Jobs that already ended: the runner loads them, finds nothing to do and settles, so each run is a handful of steps.
    for (const id of ids)
      await db.transaction(async (tx) => {
        await tx.insert(jobs).values({
          id,
          userId: 'u',
          modelId: 'fast',
          kind: 'image',
          prompt: 'p',
          inputJson: '{}',
          upstream: 'yir',
          status: 'canceled',
          finishedAt: Date.now(),
        });
        await enqueueRun(tx, id);
      });
    const deps = { db, bucket: {} as R2Bucket, models, adapters: {} };
    const logs: string[] = [];
    const log = (message: string, details: Record<string, unknown>) =>
      logs.push(`${message} ${JSON.stringify(details)}`);
    const options = { pollMs: 5, heartbeatMs: 50, slots: 8, retryRunAfterMs: 100, log };
    const a = startJobWorker(deps, { ...options, id: 'a' });
    const b = startJobWorker(deps, { ...options, id: 'b' });
    const end = Date.now() + 20_000;
    for (;;) {
      const runs = await db.select().from(jobRuns).where(inArray(jobRuns.id, ids));
      if (runs.every((run) => run.status === 'done')) break;
      if (Date.now() > end) {
        const left = runs
          .filter((run) => run.status !== 'done')
          .map((run) => `${run.id} ${run.status} ${run.pickups}`);
        throw new Error(
          [`runs did not finish: ${left.join('; ')}`, ...logs.slice(-20)].join(String.fromCharCode(10)),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await Promise.all([a.stop(), b.stop()]);
    const runs = await db.select().from(jobRuns).where(inArray(jobRuns.id, ids));
    // A run handed back after a transient database error is claimed again; nothing else may claim a run twice.
    const reclaimed = runs.filter((run) => run.pickups !== 1).map((run) => run.id);
    const handedBack = logs.filter((line) => line.includes('"reason":"engine"'));
    expect(reclaimed.length).toBeLessThanOrEqual(handedBack.length);
    const loads = await db.select().from(jobSteps).where(eq(jobSteps.name, 'load'));
    expect(loads.filter((step) => ids.includes(step.runId)).every((step) => step.attempts === 1)).toBe(true);
  });
});
