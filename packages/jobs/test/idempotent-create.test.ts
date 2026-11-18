import { getBalance, grantCredits } from '@shipwords/core/credits/ledger';
import type { Core } from '@shipwords/core/server';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createJobs } from '../src/handlers';
import { loadJob, markFailed } from '../src/lifecycle';
import type { ModelDefinition } from '../src/models';
import { jobRuns, jobs } from '../src/schema';
import { db } from './db';

const model: ModelDefinition = {
  id: 'preview',
  name: 'Preview',
  kind: 'image',
  upstream: 'yir',
  upstreamModel: 'test/image',
  credits: 1,
  guest: false,
  allowedParameters: [],
  maxReferences: 0,
  timeoutMinutes: 10,
};
async function setup(credits = 1) {
  const userId = crypto.randomUUID();
  await grantCredits(db, { userId, amount: 10, idemKey: userId, source: 'test' });
  let wakes = 0;
  const api = createJobs(
    {
      db,
      site: { id: 'test', url: 'https://test.example' },
      getUser: async () => ({ id: userId }),
      log: () => {},
      env: {},
    } as unknown as Core,
    [{ ...model, credits }],
    { wake: () => wakes++ },
  );
  const create = (prompt = 'hello') =>
    api.create(
      new Request('https://test.example/api/jobs', {
        method: 'POST',
        body: JSON.stringify({ modelId: 'preview', prompt }),
      }),
      { idempotencyKey: 'one-step' },
    );
  /** Runs queued for this user's jobs. */
  const runs = async () =>
    db
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .innerJoin(jobs, eq(jobs.id, jobRuns.id))
      .where(eq(jobs.userId, userId));
  return { create, userId, runs, wakes: () => wakes };
}

describe('idempotent server job creation', () => {
  it('queues exactly one run with the charge, however often the request is repeated', async () => {
    const ctx = await setup();
    for (let i = 0; i < 3; i++) expect((await ctx.create()).ok).toBe(true);
    expect(await ctx.runs()).toHaveLength(1);
    expect(ctx.wakes()).toBe(3);
    expect((await getBalance(db, ctx.userId)).available).toBe(9);
  });
  it('deduplicates free jobs and rejects concurrent conflicting input', async () => {
    const ctx = await setup(0);
    const responses = await Promise.all([ctx.create('one'), ctx.create('two')]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await ctx.runs()).toHaveLength(1);
    expect((await getBalance(db, ctx.userId)).available).toBe(10);
  });
  it('rejects concurrent conflicting paid input without a second charge', async () => {
    const ctx = await setup();
    const responses = await Promise.all([ctx.create('one'), ctx.create('two')]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await ctx.runs()).toHaveLength(1);
    expect((await getBalance(db, ctx.userId)).available).toBe(9);
  });
  it('concurrent duplicate requests debit once and queue one run', async () => {
    const ctx = await setup();
    const results = await Promise.all(Array.from({ length: 4 }, () => ctx.create()));
    expect(results.every((r) => r.ok)).toBe(true);
    const bodies = await Promise.all(results.map((r) => r.json() as Promise<{ job: { id: string } }>));
    expect(new Set(bodies.map((b) => b.job.id)).size).toBe(1);
    expect(await ctx.runs()).toHaveLength(1);
    expect((await getBalance(db, ctx.userId)).available).toBe(9);
  });
  it('rejects a different input for the same key without another debit', async () => {
    const ctx = await setup();
    await ctx.create();
    expect((await ctx.create('different')).status).toBe(409);
    expect((await getBalance(db, ctx.userId)).available).toBe(9);
  });
  it('never restarts or recharges a failed and refunded job', async () => {
    const ctx = await setup();
    const { job } = (await (await ctx.create()).json()) as { job: { id: string } };
    await markFailed(db, job.id, 'failed', 'test', 'test');
    const response = await ctx.create();
    expect(response.ok).toBe(true);
    expect((await loadJob(db, job.id))!.status).toBe('failed');
    expect((await getBalance(db, ctx.userId)).available).toBe(10);
    expect(await ctx.runs()).toHaveLength(1);
  });
  it('heals queued work nobody ran after the settlement grace period', async () => {
    const ctx = await setup();
    await ctx.create();
    const row = await db
      .select()
      .from(jobs)
      .where(eq(jobs.userId, ctx.userId))
      .then((rows) => rows[0]);
    await db
      .update(jobs)
      .set({ createdAt: Date.now() - 11 * 60_000 })
      .where(eq(jobs.id, row!.id));
    expect((await ctx.create()).ok).toBe(true);
    expect((await getBalance(db, ctx.userId)).available).toBe(9);
    await db
      .update(jobs)
      .set({ createdAt: Date.now() - 26 * 60_000 })
      .where(eq(jobs.id, row!.id));
    expect((await ctx.create()).ok).toBe(true);
    expect((await loadJob(db, row!.id))!.status).toBe('failed');
    expect((await getBalance(db, ctx.userId)).available).toBe(10);
  });
  it('repairs a terminal state whose refund did not finish', async () => {
    const ctx = await setup();
    const { job } = (await (await ctx.create()).json()) as { job: { id: string } };
    await db.update(jobs).set({ status: 'failed' }).where(eq(jobs.id, job.id));
    expect((await getBalance(db, ctx.userId)).available).toBe(9);
    await ctx.create();
    await ctx.create();
    expect((await getBalance(db, ctx.userId)).available).toBe(10);
  });
});
