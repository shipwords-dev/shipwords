import { getBalance, grantCredits, spendCredits } from '@shipwords/core/credits/ledger';
import type { Db } from '@shipwords/core/db/client';
import type { Core } from '@shipwords/core/server';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createJobs } from '../src/handlers';
import { appendUpstreamJob, enqueueRun, loadJob, markSubmitted, spendKey } from '../src/lifecycle';
import { defineModels } from '../src/models';
import type { RunnerDeps } from '../src/runner';
import { jobRuns, jobSteps, jobs } from '../src/schema';
import type { PollResult, SubmitInput, UpstreamAdapter } from '../src/upstream';
import { type JobWorker, type Lease, leasedSteps, RunLost, startJobWorker } from '../src/worker';
import { bucket } from './bucket';
import { db } from './db';

// The Postgres replacement for Workflows: saved steps, retries, leases, replay after a crash, poison runs and shutdown,
// plus a regression test for each finding of the 2026-11-18 review of the first version.

const models = defineModels([
  {
    id: 'fast',
    name: 'Fast',
    kind: 'image',
    upstream: 'yir',
    upstreamModel: 'vendor/fast',
    credits: 10,
    guest: false,
    allowedParameters: [],
    maxReferences: 0,
    timeoutMinutes: 10,
  },
]);

class FakeAdapter implements UpstreamAdapter {
  readonly name = 'yir';
  submits: { input: SubmitInput; key: string }[] = [];
  cancelled: string[] = [];
  async submit(input: SubmitInput, key: string) {
    this.submits.push({ input, key });
    return { upstreamJobId: `up_${key}` };
  }
  async poll(): Promise<PollResult> {
    return { state: 'succeeded', files: [{ url: 'https://up/x.png', mediaType: 'image/png' }] };
  }
  async cancel(id: string) {
    this.cancelled.push(id);
  }
}

/** A gate that can hold a call open, to stop a worker in the middle of a step. */
function gated<T>(result: () => T) {
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  let calls = 0;
  return {
    async call(): Promise<T> {
      calls++;
      if (gate) await gate;
      return result();
    },
    calls: () => calls,
    hold() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open();
    },
  };
}

const imageResponse = () =>
  new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });

async function paidJob(cost = 10, createdAt?: number) {
  const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
  const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
  await grantCredits(db, { userId, amount: 50, idemKey: `g:${userId}`, source: 'test' });
  await spendCredits(db, { userId, amount: cost, idemKey: spendKey(jobId) }, async (tx) => {
    await tx.insert(jobs).values({
      id: jobId,
      userId,
      modelId: 'fast',
      kind: 'image',
      prompt: 'a cat',
      inputJson: JSON.stringify({ references: [], parameters: {} }),
      costCredits: cost,
      upstream: 'yir',
      ...(createdAt ? { createdAt } : {}),
    });
    await enqueueRun(tx, jobId);
  });
  return { userId, jobId };
}

const runOf = async (jobId: string) => (await db.select().from(jobRuns).where(eq(jobRuns.id, jobId)))[0]!;
const stepOf = async (jobId: string, name: string) =>
  (await db.select().from(jobSteps).where(eq(jobSteps.runId, jobId))).find((step) => step.name === name);

async function until(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const workers: JobWorker[] = [];
function worker(deps: RunnerDeps, options: Parameters<typeof startJobWorker>[1] = {}) {
  const started = startJobWorker(deps, {
    pollMs: 10,
    heartbeatMs: 50,
    leaseMs: 10_000,
    retryDelayMs: 1,
    ...options,
  });
  workers.push(started);
  return started;
}
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
});

const stepOptions = { retries: 2, retryDelayMs: 1, stepTimeoutMs: 60_000, now: Date.now };

/** A run row held by one claim (`token`), and steps bound to that lease. */
async function heldRun(token: string, options: Partial<typeof stepOptions> = {}, database: Db = db) {
  const runId = `run_${crypto.randomUUID().slice(0, 8)}`;
  const until = Date.now() + 60_000;
  await db.insert(jobRuns).values({ id: runId, lockedBy: token, lockedUntil: until, pickups: 1 });
  const lease: Lease = { runId, token, abort: new AbortController(), until };
  return { runId, lease, steps: leasedSteps(database, lease, { ...stepOptions, ...options }) };
}

function takeOver(runId: string, token: string) {
  return db.update(jobRuns).set({ lockedBy: token }).where(eq(jobRuns.id, runId));
}

describe('steps', () => {
  it('a replay returns saved results without running them again, whichever step the crash came after', async () => {
    for (let crashAfter = 0; crashAfter <= 3; crashAfter++) {
      const { runId, steps } = await heldRun('w1:1');
      const ran: Record<string, number> = {};
      const job = async (s: typeof steps, crashAt: number | null) => {
        const values: unknown[] = [];
        for (const [i, name] of ['a', 'b', 'c'].entries()) {
          if (i === crashAt) throw new Error('process died');
          values.push(
            await s.do(name, async () => {
              ran[name] = (ran[name] ?? 0) + 1;
              return name === 'b' ? undefined : { name, at: i };
            }),
          );
        }
        return values;
      };
      // The first claim gets through crashAfter steps, then its process dies (3: it finished, the run is replayed anyway).
      await job(steps, crashAfter === 3 ? null : crashAfter).catch(() => {});
      await takeOver(runId, 'w2:1');
      const lease: Lease = { runId, token: 'w2:1', abort: new AbortController(), until: Date.now() + 60_000 };
      expect(await job(leasedSteps(db, lease, stepOptions), null)).toEqual([
        { name: 'a', at: 0 },
        undefined,
        { name: 'c', at: 2 },
      ]);
      expect(ran).toEqual({ a: 1, b: 1, c: 1 });
    }
  });

  it('retries a throwing step with backoff and saves the attempts; gives up after the retry limit', async () => {
    const { runId, steps } = await heldRun('w1:1');
    let calls = 0;
    expect(
      await steps.do('flaky', async () => {
        calls++;
        if (calls < 3) throw new Error(`try ${calls}`);
        return 'ok';
      }),
    ).toBe('ok');
    expect(await stepOf(runId, 'flaky')).toMatchObject({ attempts: 3, error: null, result: { v: 'ok' } });
    await expect(
      steps.do('broken', async () => {
        throw new Error('always');
      }),
    ).rejects.toThrow('always');
    expect(await stepOf(runId, 'broken')).toMatchObject({ attempts: 3, error: 'always', doneAt: null });
  });

  it('a replay keeps counting attempts: retries are not reset by a crash or a handover', async () => {
    const { runId, steps } = await heldRun('w1:1');
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error('still broken');
    };
    await expect(steps.do('broken', failing)).rejects.toThrow('still broken');
    expect(calls).toBe(3);
    await takeOver(runId, 'w2:1');
    const lease: Lease = { runId, token: 'w2:1', abort: new AbortController(), until: Date.now() + 60_000 };
    await expect(leasedSteps(db, lease, stepOptions).do('broken', failing)).rejects.toThrow('still broken');
    expect(calls).toBe(3);
  });

  it('a step that never returns counts as a failed attempt', async () => {
    const { runId, steps } = await heldRun('w1:1', { retries: 1, stepTimeoutMs: 20 });
    await expect(steps.do('hang', () => new Promise(() => {}))).rejects.toThrow(/longer than 20 ms/);
    expect(await stepOf(runId, 'hang')).toMatchObject({ attempts: 2, doneAt: null });
  });

  it('a claim that lost its lease saves nothing, and no later step of the run starts', async () => {
    const { runId, steps } = await heldRun('w1:1');
    await takeOver(runId, 'w2:1');
    let ran = 0;
    await expect(steps.do('first', async () => ++ran)).rejects.toBeInstanceOf(RunLost);
    expect(await stepOf(runId, 'first')).toBeUndefined();
    // The runner's abort and settle steps come next: they must not run.
    await expect(steps.do('abort', async () => ++ran)).rejects.toBeInstanceOf(RunLost);
    await expect(steps.sleep('pause', 1)).rejects.toBeInstanceOf(RunLost);
    expect(ran).toBe(0);
  });

  it('an older claim of the same process is refused once the run was claimed again', async () => {
    const { runId, steps } = await heldRun('w1:1');
    await takeOver(runId, 'w1:2');
    await expect(steps.do('x', async () => 1)).rejects.toBeInstanceOf(RunLost);
  });

  it('no step starts when the lease is about to run out', async () => {
    const { lease, steps } = await heldRun('w1:1');
    lease.until = Date.now() + 1_000;
    let ran = false;
    await expect(
      steps.do('late', async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(RunLost);
    expect(ran).toBe(false);
  });

  it('an expired lease is refused when saving, even before the heartbeat notices', async () => {
    const { runId, steps } = await heldRun('w1:1');
    await expect(
      steps.do('x', async () => {
        await db
          .update(jobRuns)
          .set({ lockedUntil: Date.now() - 1 })
          .where(eq(jobRuns.id, runId));
        return 1;
      }),
    ).rejects.toBeInstanceOf(RunLost);
    expect(await stepOf(runId, 'x')).toBeUndefined();
  });

  it("the worker's own database failure stops the run instead of failing the step", async () => {
    let failSaves = true;
    const flaky = new Proxy(db, {
      get(target, key) {
        if (key === 'transaction' && failSaves)
          return async () => {
            throw new Error('connection reset');
          };
        return Reflect.get(target, key);
      },
    });
    const { steps } = await heldRun('w1:1', {}, flaky);
    let ran = 0;
    await expect(steps.do('submit', async () => ++ran)).rejects.toBeInstanceOf(RunLost);
    // The runner's abort step must not run after that.
    failSaves = false;
    await expect(steps.do('abort', async () => ++ran)).rejects.toBeInstanceOf(RunLost);
    expect(ran).toBe(1);
  });
});

describe('upstream IDs recorded twice', () => {
  it('the same segment submit replayed elsewhere is recorded once and reported as recorded to both', async () => {
    const { jobId } = await paidJob();
    await markSubmitted(db, jobId, 'up_0');
    const results = await Promise.all([
      appendUpstreamJob(db, jobId, 1, 'up_1'),
      appendUpstreamJob(db, jobId, 1, 'up_1'),
    ]);
    expect(results).toEqual([true, true]);
    expect((await loadJob(db, jobId))?.upstreamJobId).toBe('up_0,up_1');
  });
});

describe('job worker', () => {
  it('runs a queued job to the end once; a repeated enqueue adds no second run', async () => {
    const { userId, jobId } = await paidJob();
    await enqueueRun(db, jobId);
    const adapter = new FakeAdapter();
    worker({ db, bucket, models, adapters: { yir: adapter }, fetcher: async () => imageResponse() });
    await until(async () => (await runOf(jobId)).status === 'done');
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
    expect(adapter.submits).toHaveLength(1);
    expect((await runOf(jobId)).pickups).toBe(1);
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('after a worker dies mid-step, another replays the run without submitting it again', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new FakeAdapter();
    const download = gated(imageResponse);
    download.hold();
    const deps = { db, bucket, models, adapters: { yir: adapter }, fetcher: () => download.call() };
    const first = worker(deps, { id: 'first' });
    await until(async () => download.calls() > 0);
    // The first process "dies": its lease is taken away and it stops heartbeating (it is still blocked on the download).
    await db
      .update(jobRuns)
      .set({ lockedBy: 'gone', lockedUntil: Date.now() - 1 })
      .where(eq(jobRuns.id, jobId));
    download.release();
    worker(deps, { id: 'second' });
    await until(async () => (await runOf(jobId)).status === 'done');
    expect(adapter.submits).toHaveLength(1);
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
    expect((await getBalance(db, userId)).available).toBe(40);
    expect(first.active).toBe(0);
  });

  it('never claims a run it is still executing, even after its lease ran out', async () => {
    const { jobId } = await paidJob();
    const download = gated(imageResponse);
    download.hold();
    // No heartbeat during the test, so only the claim exclusion keeps the run from being claimed twice.
    const w = worker(
      { db, bucket, models, adapters: { yir: new FakeAdapter() }, fetcher: () => download.call() },
      { heartbeatMs: 60_000, leaseMs: 200_000 },
    );
    await until(async () => download.calls() > 0);
    await db
      .update(jobRuns)
      .set({ lockedUntil: Date.now() - 1 })
      .where(eq(jobRuns.id, jobId));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(download.calls()).toBe(1);
    expect((await runOf(jobId)).pickups).toBe(1);
    expect(w.active).toBe(1);
    download.release();
  });

  it('a run that starts past the job deadline fails it with a refund before submitting', async () => {
    const { userId, jobId } = await paidJob(10, Date.now() - 11 * 60_000);
    const adapter = new FakeAdapter();
    worker({ db, bucket, models, adapters: { yir: adapter } });
    await until(async () => (await runOf(jobId)).status === 'done');
    expect(adapter.submits).toHaveLength(0);
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('fails and refunds a run claimed too often, canceling what it still has upstream', async () => {
    const { userId, jobId } = await paidJob();
    await markSubmitted(db, jobId, 'up_live');
    await db.update(jobRuns).set({ pickups: 2 }).where(eq(jobRuns.id, jobId));
    const adapter = new FakeAdapter();
    worker({ db, bucket, models, adapters: { yir: adapter } }, { maxPickups: 2 });
    await until(async () => (await runOf(jobId)).status === 'dead');
    expect(adapter.submits).toHaveLength(0);
    expect(adapter.cancelled).toEqual(['up_live']);
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'stale' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('on shutdown, finishes the step in flight, starts no other and gives the run back uncounted', async () => {
    const { jobId } = await paidJob();
    const adapter = new FakeAdapter();
    const download = gated(imageResponse);
    download.hold();
    const deps = { db, bucket, models, adapters: { yir: adapter }, fetcher: () => download.call() };
    const first = worker(deps, { id: 'first' });
    await until(async () => download.calls() > 0);
    const stopped = first.stop();
    download.release();
    await stopped;
    expect(await runOf(jobId)).toMatchObject({ status: 'pending', lockedBy: null, pickups: 0 });
    expect((await loadJob(db, jobId))?.status).toBe('submitted');
    worker(deps, { id: 'second' });
    await until(async () => (await runOf(jobId)).status === 'done');
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
    expect(adapter.submits).toHaveLength(1);
  });

  it('a shutdown during a best-effort step leaves the run to be replayed, so the step still happens', async () => {
    const { jobId } = await paidJob();
    const notify = gated(() => undefined);
    notify.hold();
    const deps = {
      db,
      bucket,
      models,
      adapters: { yir: new FakeAdapter() },
      fetcher: async () => imageResponse(),
      notify: () => notify.call(),
    };
    const first = worker(deps, { id: 'first', retries: 0 });
    await until(async () => notify.calls() > 0);
    // stop() aborts the lease while notify is in flight; once it returns, nothing marks the run done.
    const stopped = first.stop();
    notify.release();
    await stopped;
    expect((await runOf(jobId)).status).toBe('pending');
    worker(deps, { id: 'second' });
    await until(async () => (await runOf(jobId)).status === 'done');
    expect(await stepOf(jobId, 'notify')).toMatchObject({ doneAt: expect.any(Number) });
  });

  it('refuses lease settings that would let a lease run out between heartbeats', () => {
    expect(() =>
      startJobWorker({ db, bucket, models, adapters: {} }, { leaseMs: 4_000, heartbeatMs: 1_000 }),
    ).toThrow(/leaseMs/);
  });
});

describe('creating jobs', () => {
  function api(userId: string, wake?: () => void) {
    return createJobs(
      {
        db,
        site: { id: 'test', url: 'https://test.example' },
        getUser: async () => ({ id: userId }),
        log: () => {},
        env: {},
      } as unknown as Core,
      models,
      wake ? { wake } : {},
    );
  }
  const post = () =>
    new Request('https://test.example/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ modelId: 'fast', prompt: 'a cat' }),
    });

  it('a throwing wake() does not turn a created job into an error', async () => {
    const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
    await grantCredits(db, { userId, amount: 50, idemKey: `g:${userId}`, source: 'test' });
    const response = await api(userId, () => {
      throw new Error('worker gone');
    }).create(post());
    expect(response.status).toBe(201);
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('a queued job without a run (created before job_runs) gets one when its creation is retried', async () => {
    const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
    await grantCredits(db, { userId, amount: 50, idemKey: `g:${userId}`, source: 'test' });
    const jobsApi = api(userId);
    const create = () => jobsApi.create(post(), { idempotencyKey: 'legacy' });
    const { job } = (await (await create()).json()) as { job: { id: string } };
    await db.delete(jobRuns).where(eq(jobRuns.id, job.id));
    expect((await create()).ok).toBe(true);
    expect((await runOf(job.id)).status).toBe('pending');
    expect((await getBalance(db, userId)).available).toBe(40);
  });
});
