import { getBalance, grantCredits } from '@shipwords/core/credits/ledger';
import type { Core } from '@shipwords/core/server';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createJobs } from '../src/handlers';
import { loadJob, markFailed, markSucceeded } from '../src/lifecycle';
import type { ModelDefinition } from '../src/models';
import { jobRuns, jobs } from '../src/schema';
import { bucket } from './bucket';
import { db } from './db';

// Money paths of the plain (non-idempotent) create, cancel and stale healing. Idempotent create: idempotent-create.test.ts.

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
  const api = createJobs(
    {
      db,
      site: { id: 'test', url: 'https://test.example' },
      getUser: async () => ({ id: userId }),
      log: () => {},
      env: {
        GUEST_COOKIE_SECRET: 'test-secret',
      },
    } as unknown as Core,
    [model],
    { store: bucket },
  );
  const request = (path: string, body?: unknown) =>
    new Request(`https://test.example${path}`, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    userId,
    /** Runs queued for this user's jobs. */
    runs: () =>
      db
        .select({ id: jobRuns.id })
        .from(jobRuns)
        .innerJoin(jobs, eq(jobs.id, jobRuns.id))
        .where(eq(jobs.userId, userId)),
    balance: async () => (await getBalance(db, userId)).available,
    create: (prompt = 'a cat') => api.create(request('/api/jobs', { modelId: 'paid', prompt })),
    get: (jobId: string) => api.get(new Request(`https://test.example/api/jobs/${jobId}`), jobId),
    cancel: (jobId: string) => api.cancel(request(`/api/jobs/${jobId}/cancel`), jobId),
    file: (key: string) => api.file(new Request(`https://test.example/files/${key}`), key),
  };
}

describe('GET /files', () => {
  it('serves prep crops only while submitted, without caching temporary access', async () => {
    const ctx = await setup();
    const jobId = await createdId(await ctx.create());
    const key = `jobs/${jobId}/prep-backLeft-3.png`;
    await bucket.put(key, new Uint8Array([1]), { contentType: 'image/png' });
    expect((await ctx.file(key)).status).toBe(404);
    await db.update(jobs).set({ status: 'submitted' }).where(eq(jobs.id, jobId));
    const response = await ctx.file(key);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await response.arrayBuffer();
    await markFailed(db, jobId, 'failed', 'test', 'failed');
    expect((await ctx.file(key)).status).toBe(404);
  });
  it('never serves kept prep or upload copies, whatever the job state', async () => {
    const ctx = await setup();
    const jobId = await createdId(await ctx.create());
    const keys = [`jobs/${jobId}/kept/prep-left-0.png`, `jobs/${jobId}/kept/uploads/up_a.png`];
    for (const key of keys) await bucket.put(key, new Uint8Array([1]), { contentType: 'image/png' });
    for (const status of ['queued', 'submitted', 'succeeded'] as const) {
      await db.update(jobs).set({ status }).where(eq(jobs.id, jobId));
      for (const key of keys) expect((await ctx.file(key)).status).toBe(404);
    }
  });
  it('serves uploads uncached, so no copy outlives the lifecycle deletion; outputs stay cacheable', async () => {
    const ctx = await setup();
    await bucket.put('uploads/up_cachetest.png', new Uint8Array([1]), { contentType: 'image/png' });
    const upload = await ctx.file('uploads/up_cachetest.png');
    expect(upload.status).toBe(200);
    expect(upload.headers.get('cache-control')).toBe('no-store');
    await upload.arrayBuffer();
    const jobId = await createdId(await ctx.create());
    const output = `jobs/${jobId}/0.mp4`;
    await bucket.put(output, new Uint8Array([1]), { contentType: 'video/mp4' });
    await markSucceeded(db, jobId, [{ key: output, mediaType: 'video/mp4' }]);
    const served = await ctx.file(output);
    expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    await served.arrayBuffer();
  });
  it('serves an output replaced by hand under its new key, once the job succeeded', async () => {
    const ctx = await setup();
    const jobId = await createdId(await ctx.create());
    const replaced = `jobs/${jobId}/0-r1794301409744.mp4`;
    await bucket.put(replaced, new Uint8Array([1, 2, 3]), {
      contentType: 'video/mp4',
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
  it('rejects a prompt with a NUL character before charging', async () => {
    const ctx = await setup();
    const response = await ctx.create('a\u0000cat');
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_prompt');
    expect(await ctx.balance()).toBe(10);
  });

  it('not enough credits: 402, no job row, no run', async () => {
    const ctx = await setup(3);
    const response = await ctx.create();
    expect(response.status).toBe(402);
    expect(await db.select().from(jobs).where(eq(jobs.userId, ctx.userId))).toHaveLength(0);
    expect(await ctx.runs()).toHaveLength(0);
    expect(await ctx.balance()).toBe(3);
  });

  it('queues the run in the charge transaction', async () => {
    const ctx = await setup();
    const jobId = await createdId(await ctx.create());
    expect(await ctx.runs()).toEqual([{ id: jobId }]);
    expect(await ctx.balance()).toBe(6);
  });

  it('a run insert that fails rolls back the charge and the job', async () => {
    const ctx = await setup();
    // A run row already holding the next job ID can't exist; simulate a failing run insert with a CHECK on this test database.
    await db.execute(sql`alter table job_runs add constraint test_no_runs check (false) not valid`);
    try {
      await expect(ctx.create()).rejects.toThrow();
    } finally {
      await db.execute(sql`alter table job_runs drop constraint test_no_runs`);
    }
    expect(await db.select().from(jobs).where(eq(jobs.userId, ctx.userId))).toHaveLength(0);
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
