import { env } from 'cloudflare:test';
import { getBalance, grantCredits } from '@shipwords/core/credits/ledger';
import { createDb } from '@shipwords/core/db/client';
import type { Core } from '@shipwords/core/server';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createJobs } from '../src/handlers';
import { loadJob, markFailed } from '../src/lifecycle';
import type { ModelDefinition } from '../src/models';
import { jobs } from '../src/schema';

const db = createDb(env.DB);
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
  const running = new Set<string>();
  let unavailable = false;
  let throwAfterAccept = false;
  let statusUnavailable = false;
  const api = createJobs(
    {
      db,
      site: { id: 'test', url: 'https://test.example' },
      getUser: async () => ({ id: userId }),
      log: () => {},
      env: {
        GENERATION_WORKFLOW: {
          create: async ({ id }: { id: string }) => {
            if (unavailable || running.has(id)) throw new Error('dispatch error');
            running.add(id);
            if (throwAfterAccept) throw new Error('response lost');
          },
          get: async (id: string) => ({
            status: async () => {
              if (statusUnavailable || !running.has(id)) throw new Error('not found');
              return { status: 'running' };
            },
          }),
        },
      },
    } as unknown as Core,
    [{ ...model, credits }],
  );
  const create = (prompt = 'hello') =>
    api.create(
      new Request('https://test.example/api/jobs', {
        method: 'POST',
        body: JSON.stringify({ modelId: 'preview', prompt }),
      }),
      { idempotencyKey: 'one-step' },
    );
  return {
    create,
    userId,
    running,
    acceptedError: (statusFails: boolean) => {
      throwAfterAccept = true;
      statusUnavailable = statusFails;
    },
    unavailable: (value: boolean) => {
      unavailable = value;
    },
  };
}

describe('idempotent server job creation', () => {
  it('recovers acceptance followed by a lost response, retaining the debit even when status is unavailable', async () => {
    const ctx = await setup();
    ctx.acceptedError(true);
    expect((await ctx.create()).status).toBe(503);
    expect(ctx.running.size).toBe(1);
    expect((await getBalance(db, ctx.userId)).available).toBe(9);
    ctx.acceptedError(false);
    expect((await ctx.create()).ok).toBe(true);
    expect(ctx.running.size).toBe(1);
    expect((await getBalance(db, ctx.userId)).available).toBe(9);
  });
  it('deduplicates free jobs and rejects concurrent conflicting input', async () => {
    const ctx = await setup(0);
    const responses = await Promise.all([ctx.create('one'), ctx.create('two')]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(ctx.running.size).toBe(1);
    expect((await getBalance(db, ctx.userId)).available).toBe(10);
  });
  it('rejects concurrent conflicting paid input without a second charge', async () => {
    const ctx = await setup();
    const responses = await Promise.all([ctx.create('one'), ctx.create('two')]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(ctx.running.size).toBe(1);
    expect((await getBalance(db, ctx.userId)).available).toBe(9);
  });
  it('concurrent duplicate requests debit once and dispatch one workflow', async () => {
    const ctx = await setup();
    const results = await Promise.all(Array.from({ length: 4 }, () => ctx.create()));
    expect(results.every((r) => r.ok)).toBe(true);
    const bodies = await Promise.all(results.map((r) => r.json() as Promise<{ job: { id: string } }>));
    expect(new Set(bodies.map((b) => b.job.id)).size).toBe(1);
    expect(ctx.running.size).toBe(1);
    expect((await getBalance(db, ctx.userId)).available).toBe(9);
  });
  it('rejects a different input for the same key without another debit', async () => {
    const ctx = await setup();
    await ctx.create();
    expect((await ctx.create('different')).status).toBe(409);
    expect((await getBalance(db, ctx.userId)).available).toBe(9);
  });
  it('resumes a saved debit after an unavailable dispatcher, without refunding an uncertain submit', async () => {
    const ctx = await setup();
    ctx.unavailable(true);
    expect((await ctx.create()).status).toBe(503);
    expect((await getBalance(db, ctx.userId)).available).toBe(9);
    ctx.unavailable(false);
    expect((await ctx.create()).ok).toBe(true);
    expect((await getBalance(db, ctx.userId)).available).toBe(9);
    expect(ctx.running.size).toBe(1);
  });
  it('never restarts or recharges a failed and refunded job', async () => {
    const ctx = await setup();
    const { job } = (await (await ctx.create()).json()) as { job: { id: string } };
    await markFailed(db, job.id, 'failed', 'test', 'test');
    const response = await ctx.create();
    expect(response.ok).toBe(true);
    expect((await loadJob(db, job.id))!.status).toBe('failed');
    expect((await getBalance(db, ctx.userId)).available).toBe(10);
    expect(ctx.running.size).toBe(1);
  });
  it('does not dispatch expired queued work and heals it after the settlement grace period', async () => {
    const ctx = await setup();
    ctx.unavailable(true);
    await ctx.create();
    const row = await db.select().from(jobs).where(eq(jobs.userId, ctx.userId)).get();
    await db
      .update(jobs)
      .set({ createdAt: Date.now() - 11 * 60_000 })
      .where(eq(jobs.id, row!.id));
    ctx.unavailable(false);
    expect((await ctx.create()).ok).toBe(true);
    expect(ctx.running.size).toBe(0);
    expect((await getBalance(db, ctx.userId)).available).toBe(9);
    await db
      .update(jobs)
      .set({ createdAt: Date.now() - 26 * 60_000 })
      .where(eq(jobs.id, row!.id));
    expect((await ctx.create()).ok).toBe(true);
    expect(ctx.running.size).toBe(0);
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
