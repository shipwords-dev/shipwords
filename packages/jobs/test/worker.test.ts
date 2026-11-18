import { getBalance, grantCredits, spendCredits } from '@shipwords/core/credits/ledger';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { enqueueRun, loadJob, spendKey } from '../src/lifecycle';
import { defineModels } from '../src/models';
import type { RunnerDeps } from '../src/runner';
import { jobRuns, jobSteps, jobs } from '../src/schema';
import type { PollResult, SubmitInput, UpstreamAdapter } from '../src/upstream';
import { type JobWorker, type Lease, leasedSteps, RunLost, startJobWorker } from '../src/worker';
import { bucket } from './bucket';
import { db } from './db';

// The Postgres replacement for Workflows: saved steps, retries, leases, replay after a crash, poison runs and shutdown.

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
  async submit(input: SubmitInput, key: string) {
    this.submits.push({ input, key });
    return { upstreamJobId: `up_${key}` };
  }
  async poll(): Promise<PollResult> {
    return { state: 'succeeded', files: [{ url: 'https://up/x.png', mediaType: 'image/png' }] };
  }
  async cancel() {}
}

/** A fetch for results that can be held open, to stop a worker in the middle of a step. */
function gatedFetcher() {
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    if (gate) await gate;
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  };
  return {
    fetcher,
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

async function paidJob(cost = 10) {
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
  const started = startJobWorker(deps, { pollMs: 10, heartbeatMs: 50, retryDelayMs: 1, ...options });
  workers.push(started);
  return started;
}
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
});

/** A run row held by `workerId`, and steps bound to that lease. */
async function heldRun(workerId: string, retries = 2) {
  const runId = `run_${crypto.randomUUID().slice(0, 8)}`;
  const until = Date.now() + 60_000;
  await db.insert(jobRuns).values({ id: runId, lockedBy: workerId, lockedUntil: until, pickups: 1 });
  const lease: Lease = { runId, abort: new AbortController(), until };
  return {
    runId,
    lease,
    steps: leasedSteps(db, workerId, lease, { retries, retryDelayMs: 1, now: Date.now }),
  };
}

describe('steps', () => {
  it('a replay returns saved results without running them again, whichever step the crash came after', async () => {
    for (let crashAfter = 0; crashAfter <= 3; crashAfter++) {
      const { runId, steps } = await heldRun('w1');
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
      // The first worker gets through crashAfter steps, then its process dies (3: it finished, the run is replayed anyway).
      await job(steps, crashAfter === 3 ? null : crashAfter).catch(() => {});
      // Another worker takes the run over and replays it to the end.
      await db.update(jobRuns).set({ lockedBy: 'w2' }).where(eq(jobRuns.id, runId));
      const lease: Lease = { runId, abort: new AbortController(), until: Date.now() + 60_000 };
      const replay = leasedSteps(db, 'w2', lease, { retries: 2, retryDelayMs: 1, now: Date.now });
      expect(await job(replay, null)).toEqual([{ name: 'a', at: 0 }, undefined, { name: 'c', at: 2 }]);
      expect(ran).toEqual({ a: 1, b: 1, c: 1 });
    }
  });

  it('retries a throwing step with backoff and saves the attempts; gives up after the retry limit', async () => {
    const { runId, steps } = await heldRun('w1', 2);
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

  it('a worker that lost its lease saves nothing, and no later step of the run starts', async () => {
    const { runId, steps } = await heldRun('w1');
    await db.update(jobRuns).set({ lockedBy: 'w2' }).where(eq(jobRuns.id, runId));
    let ran = 0;
    await expect(steps.do('first', async () => ++ran)).rejects.toBeInstanceOf(RunLost);
    expect(await stepOf(runId, 'first')).toBeUndefined();
    // The runner's abort and settle steps come next: they must not run.
    await expect(steps.do('abort', async () => ++ran)).rejects.toBeInstanceOf(RunLost);
    await expect(steps.sleep('pause', 1)).rejects.toBeInstanceOf(RunLost);
    expect(ran).toBe(1);
  });

  it('no step starts when the lease is about to run out', async () => {
    const { lease, steps } = await heldRun('w1');
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
    const { runId, steps } = await heldRun('w1');
    await db
      .update(jobRuns)
      .set({ lockedUntil: Date.now() - 1 })
      .where(eq(jobRuns.id, runId));
    await expect(steps.do('x', async () => 1)).rejects.toBeInstanceOf(RunLost);
  });
});

describe('job worker', () => {
  it('runs a queued job to the end once; a repeated enqueue adds no second run', async () => {
    const { userId, jobId } = await paidJob();
    await enqueueRun(db, jobId);
    const adapter = new FakeAdapter();
    const gate = gatedFetcher();
    worker({ db, bucket, models, adapters: { yir: adapter }, fetcher: gate.fetcher });
    await until(async () => (await runOf(jobId)).status === 'done');
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
    expect(adapter.submits).toHaveLength(1);
    expect((await runOf(jobId)).pickups).toBe(1);
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('after a worker dies mid-step, another replays the run without submitting it again', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new FakeAdapter();
    const gate = gatedFetcher();
    gate.hold();
    const deps = { db, bucket, models, adapters: { yir: adapter }, fetcher: gate.fetcher };
    const first = worker(deps, { id: 'first' });
    await until(async () => gate.calls() > 0);
    // The first process "dies": its lease is taken away and it stops heartbeating (it is still blocked on the download).
    await db
      .update(jobRuns)
      .set({ lockedBy: 'gone', lockedUntil: Date.now() - 1 })
      .where(eq(jobRuns.id, jobId));
    gate.release();
    worker(deps, { id: 'second' });
    await until(async () => (await runOf(jobId)).status === 'done');
    expect(adapter.submits).toHaveLength(1);
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
    expect((await getBalance(db, userId)).available).toBe(40);
    expect(first.active).toBe(0);
  });

  it('fails and refunds a run claimed too often without running it', async () => {
    const { userId, jobId } = await paidJob();
    await db.update(jobRuns).set({ pickups: 2 }).where(eq(jobRuns.id, jobId));
    const adapter = new FakeAdapter();
    worker({ db, bucket, models, adapters: { yir: adapter } }, { maxPickups: 2 });
    await until(async () => (await runOf(jobId)).status === 'dead');
    expect(adapter.submits).toHaveLength(0);
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'stale' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('on shutdown, finishes the step in flight, starts no other and gives the run back uncounted', async () => {
    const { jobId } = await paidJob();
    const adapter = new FakeAdapter();
    const gate = gatedFetcher();
    gate.hold();
    const deps = { db, bucket, models, adapters: { yir: adapter }, fetcher: gate.fetcher };
    const first = worker(deps, { id: 'first' });
    await until(async () => gate.calls() > 0);
    const stopped = first.stop();
    gate.release();
    await stopped;
    const run = await runOf(jobId);
    expect(run).toMatchObject({ status: 'pending', lockedBy: null, pickups: 0 });
    expect((await loadJob(db, jobId))?.status).toBe('submitted');
    worker(deps, { id: 'second' });
    await until(async () => (await runOf(jobId)).status === 'done');
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
    expect(adapter.submits).toHaveLength(1);
  });
});
