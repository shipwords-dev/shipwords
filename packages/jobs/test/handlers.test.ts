import { env } from 'cloudflare:test';
import { getBalance, grantCredits } from '@shipwords/core/credits/ledger';
import { createDb } from '@shipwords/core/db/client';
import type { Core } from '@shipwords/core/server';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createJobs } from '../src/handlers';
import { loadJob, markFailed, markSucceeded } from '../src/lifecycle';
import type { ModelDefinition } from '../src/models';
import { jobs } from '../src/schema';

// Money paths of the plain (non-idempotent) create, cancel and stale healing. Idempotent create: idempotent-create.test.ts.

const db = createDb(env.DB);
const model: ModelDefinition = {
  id: 'paid',
  name: 'Paid',
  kind: 'image',
  upstream: 'yir',
  upstreamModel: 'test/image',
  credits: 4,
  guest: false,
  allowedParameters: [],
  maxReferences: 0,
  timeoutMinutes: 10,
};

async function setup(balance = 10) {
  const userId = crypto.randomUUID();
  await grantCredits(db, { userId, amount: balance, idemKey: userId, source: 'test' });
  const dispatched: string[] = [];
  let dispatchFails = false;
  const api = createJobs(
    {
      db,
      site: { id: 'test', url: 'https://test.example' },
      getUser: async () => ({ id: userId }),
      log: () => {},
      env: {
        GUEST_COOKIE_SECRET: 'test-secret',
        OUTPUTS: env.OUTPUTS,
        GENERATION_WORKFLOW: {
          create: async ({ id }: { id: string }) => {
            if (dispatchFails) throw new Error('dispatch error');
            dispatched.push(id);
          },
        },
      },
    } as unknown as Core,
    [model],
  );
  const request = (path: string, body?: unknown) =>
    new Request(`https://test.example${path}`, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    userId,
    dispatched,
    failDispatch: () => {
      dispatchFails = true;
    },
    balance: async () => (await getBalance(db, userId)).available,
    create: () => api.create(request('/api/jobs', { modelId: 'paid', prompt: 'a cat' })),
    get: (jobId: string) => api.get(new Request(`https://test.example/api/jobs/${jobId}`), jobId),
    cancel: (jobId: string) => api.cancel(request(`/api/jobs/${jobId}/cancel`), jobId),
    file: (key: string) => api.file(new Request(`https://test.example/files/${key}`), key),
  };
}

describe('GET /files', () => {
  it('serves an output replaced by hand under its new key, once the job succeeded', async () => {
    const ctx = await setup();
    const jobId = await createdId(await ctx.create());
    const replaced = `jobs/${jobId}/0-r1794301409744.mp4`;
    await env.OUTPUTS.put(replaced, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'video/mp4' },
    });
    expect((await ctx.file(replaced)).status).toBe(404);
    await markSucceeded(db, jobId, [{ key: replaced, mediaType: 'video/mp4' }]);
    expect((await ctx.file(replaced)).status).toBe(200);
    expect((await ctx.file(`jobs/${jobId}/0-rx.mp4`)).status).toBe(404);
  });
});

async function createdId(response: Response) {
  return ((await response.json()) as { job: { id: string } }).job.id;
}

describe('job handlers: money paths', () => {
  it('not enough credits: 402, no job row, nothing dispatched', async () => {
    const ctx = await setup(3);
    const response = await ctx.create();
    expect(response.status).toBe(402);
    expect(await db.select().from(jobs).where(eq(jobs.userId, ctx.userId))).toHaveLength(0);
    expect(ctx.dispatched).toHaveLength(0);
    expect(await ctx.balance()).toBe(3);
  });

  it('dispatch failure fails the job and refunds once, however often it is read', async () => {
    const ctx = await setup();
    ctx.failDispatch();
    expect((await ctx.create()).status).toBe(503);
    const [row] = await db.select().from(jobs).where(eq(jobs.userId, ctx.userId));
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('dispatch_failed');
    await ctx.get(row!.id);
    await ctx.get(row!.id);
    expect(await ctx.balance()).toBe(10);
  });

  it('a user cancel racing a runner failure refunds exactly once', async () => {
    const ctx = await setup();
    const jobId = await createdId(await ctx.create());
    expect(await ctx.balance()).toBe(6);
    await Promise.all([
      ctx.cancel(jobId),
      markFailed(db, jobId, 'failed', 'upstream_failed', 'x'),
      ctx.cancel(jobId),
    ]);
    expect(['canceled', 'failed']).toContain((await loadJob(db, jobId))?.status);
    expect(await ctx.balance()).toBe(10);
  });

  it('a stale job failed on read stays failed: a late runner success writes nothing', async () => {
    const ctx = await setup();
    const jobId = await createdId(await ctx.create());
    await db
      .update(jobs)
      .set({ createdAt: Date.now() - (model.timeoutMinutes + 16) * 60_000 })
      .where(eq(jobs.id, jobId));
    const read = (await (await ctx.get(jobId)).json()) as {
      job: { status: string; error: { code: string } };
    };
    expect(read.job).toMatchObject({ status: 'failed', error: { code: 'stale' } });
    expect(await ctx.balance()).toBe(10);
    expect(await markSucceeded(db, jobId, [{ key: `jobs/${jobId}/0.png`, mediaType: 'image/png' }])).toBe(
      false,
    );
    expect((await loadJob(db, jobId))?.status).toBe('failed');
    expect(await ctx.balance()).toBe(10);
  });
});
