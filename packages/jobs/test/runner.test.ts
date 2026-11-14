import { env } from 'cloudflare:test';
import { getBalance, grantCredits, spendCredits } from '@shipwords/core/credits/ledger';
import { createDb } from '@shipwords/core/db/client';
import { user } from '@shipwords/core/db/schema';
import { consumeQuota } from '@shipwords/core/quota/counters';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sumUsd } from '../src/cost';
import { FAILURE_STREAK, failureStreak } from '../src/failures';
import { cancelQueued, loadJob, markFailed, markSubmitted, markSucceeded, spendKey } from '../src/lifecycle';
import { defineModels } from '../src/models';
import { emailFailures, emailOnFinish } from '../src/notify';
import { runGeneration, type StepRunner } from '../src/runner';
import { jobs } from '../src/schema';
import {
  type PollResult,
  type SubmitInput,
  type UpstreamAdapter,
  type UpstreamCost,
  UpstreamError,
} from '../src/upstream';
import { buildYirRequest, YirAdapter } from '../src/yir';

const db = createDb(env.DB);

const models = defineModels([
  {
    id: 'fast',
    name: 'Fast',
    kind: 'image',
    upstream: 'yir',
    upstreamModel: 'vendor/fast',
    credits: 10,
    guest: true,
    allowedParameters: ['aspect_ratio'],
    maxReferences: 1,
    timeoutMinutes: 10,
  },
]);

class FakeAdapter implements UpstreamAdapter {
  readonly name = 'yir';
  submits: { input: SubmitInput; key: string }[] = [];
  polls: PollResult[] = [];
  cancelled: string[] = [];
  submitError: Error | null = null;
  /** Runs after the upstream accepted the task, before the runner records it (to land a cancel in between). */
  onSubmit: (() => Promise<void>) | null = null;
  async submit(input: SubmitInput, key: string) {
    if (this.submitError) throw this.submitError;
    this.submits.push({ input, key });
    await this.onSubmit?.();
    return { upstreamJobId: `up_${key}` };
  }
  async poll() {
    return this.polls.shift() ?? { state: 'running' as const };
  }
  async cancel(id: string) {
    this.cancelled.push(id);
  }
}

/** StepRunner that runs directly and records step names for assertions. */
function immediateSteps(names: string[] = []): StepRunner {
  return {
    async do(name, fn) {
      names.push(name);
      return fn();
    },
    async sleep(name) {
      names.push(name);
    },
  };
}

const outputFetcher: typeof fetch = async () =>
  new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });

async function paidJob(cost = 10, overrides: Partial<typeof jobs.$inferInsert> = {}) {
  const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
  const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
  await grantCredits(db, { userId, amount: 50, idemKey: `g:${userId}`, source: 'test' });
  await spendCredits(db, { userId, amount: cost, idemKey: spendKey(jobId) }, [
    db.insert(jobs).values({
      id: jobId,
      userId,
      modelId: 'fast',
      kind: 'image',
      prompt: 'a cat',
      inputJson: JSON.stringify({ references: [], parameters: { aspect_ratio: '1:1' } }),
      costCredits: cost,
      upstream: 'yir',
      ...overrides,
    }),
  ]);
  return { userId, jobId };
}

const deps = (adapter: FakeAdapter) => ({
  db,
  bucket: env.OUTPUTS,
  models,
  adapters: { yir: adapter },
  fetcher: outputFetcher,
});

describe('generation jobs', () => {
  it('success: submits with jobId as idempotency key, stores results in R2, no refund', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new FakeAdapter();
    adapter.polls = [
      { state: 'running' },
      { state: 'succeeded', files: [{ url: 'https://up/x.png', mediaType: 'image/png' }] },
    ];
    await runGeneration(deps(adapter), jobId, immediateSteps());
    expect(adapter.submits[0]).toMatchObject({
      key: jobId,
      input: { upstreamModel: 'vendor/fast', parameters: { aspect_ratio: '1:1' } },
    });
    const job = await loadJob(db, jobId);
    expect(job?.status).toBe('succeeded');
    const [output] = JSON.parse(job!.outputsJson!);
    expect(output).toEqual({ key: `jobs/${jobId}/0.png`, mediaType: 'image/png' });
    expect(await env.OUTPUTS.get(output.key)).not.toBeNull();
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('emails signed-in users a direct result link on success; not for guest jobs', async () => {
    const { userId, jobId } = await paidJob();
    await db.insert(user).values({ id: userId, name: 'U', email: `${userId}@example.com` });
    const sent: { to: string; subject: string; text: string }[] = [];
    const email = {
      send: async (message: { to: string; subject: string; text: string }) => {
        sent.push(message);
        return { messageId: 'm1' };
      },
    } as unknown as SendEmail;
    const notify = emailOnFinish({
      db,
      email,
      from: 'noreply@example.com',
      site: { name: 'Demo', defaultLocale: 'en' },
      baseURL: 'https://demo.test',
    });
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'succeeded', files: [{ url: 'https://up/x.png', mediaType: 'image/png' }] }];
    await runGeneration({ ...deps(adapter), notify }, jobId, immediateSteps());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: `${userId}@example.com`, subject: 'Your Demo image is ready' });
    expect(sent[0]!.text).toContain(`https://demo.test/files/jobs/${jobId}/0.png`);

    await notify({ ...(await loadJob(db, jobId))!, userId: null });
    expect(sent).toHaveLength(1);
  });

  it('notification failure does not affect the job; canceled jobs are not notified', async () => {
    const { jobId } = await paidJob();
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'succeeded', files: [{ url: 'https://up/x.png', mediaType: 'image/png' }] }];
    const steps: string[] = [];
    await runGeneration(
      {
        ...deps(adapter),
        notify: async () => {
          throw new Error('smtp down');
        },
      },
      jobId,
      immediateSteps(steps),
    );
    expect(steps).toContain('notify');
    expect(steps).not.toContain('abort');
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');

    const canceled = await paidJob();
    await markFailed(db, canceled.jobId, 'canceled', 'canceled', 'by user');
    let calls = 0;
    await runGeneration(
      {
        ...deps(new FakeAdapter()),
        notify: async () => {
          calls++;
        },
      },
      canceled.jobId,
      immediateSteps(),
    );
    expect(calls).toBe(0);
  });

  it('failed jobs email the user after the refund settled, saying nothing was charged', async () => {
    const { userId, jobId } = await paidJob();
    await db.insert(user).values({ id: userId, name: 'U', email: `${userId}@example.com` });
    const sent: { to: string; subject: string; text: string }[] = [];
    let balanceAtSend = -1;
    const email = {
      send: async (message: { to: string; subject: string; text: string }) => {
        balanceAtSend = (await getBalance(db, userId)).available;
        sent.push(message);
        return { messageId: 'm1' };
      },
    } as unknown as SendEmail;
    const notify = emailOnFinish({
      db,
      email,
      from: 'noreply@example.com',
      site: { name: 'Demo', defaultLocale: 'en' },
      baseURL: 'https://demo.test',
    });
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'failed', code: 'YIR_EXECUTION_FAILED', message: 'provider down' }];
    const steps: string[] = [];
    await runGeneration({ ...deps(adapter), notify }, jobId, immediateSteps(steps));
    expect(steps.slice(-3)).toEqual(['settle', 'notify', 'cost:0']);
    expect(balanceAtSend).toBe(50);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: `${userId}@example.com`,
      subject: "Your Demo image couldn't be made",
    });
    expect(sent[0]!.text).toContain('the 10 credits for it are back in your account');
    expect(sent[0]!.text).toContain('https://demo.test/');
  });

  it('upstream fails: marked failed and refunded, repeated settlement refunds once', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'failed', code: 'YIR_CONTENT_REJECTED', message: 'nope' }];
    await runGeneration(deps(adapter), jobId, immediateSteps());
    await markFailed(db, jobId, 'failed', 'again', 'again');
    expect((await loadJob(db, jobId))?.errorCode).toBe('YIR_CONTENT_REJECTED');
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('submit rejected (non-retryable): fails and refunds directly, no polling', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new FakeAdapter();
    adapter.submitError = new UpstreamError('YIR_INVALID_REQUEST', 'bad', false);
    const steps: string[] = [];
    await runGeneration(deps(adapter), jobId, immediateSteps(steps));
    expect(steps.some((name) => name.startsWith('poll'))).toBe(false);
    expect((await loadJob(db, jobId))?.status).toBe('failed');
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('still failing after retries: fallback marks failed and refunds', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new FakeAdapter();
    adapter.submitError = new UpstreamError('YIR_RATE_LIMITED', 'slow down', true);
    await runGeneration(deps(adapter), jobId, immediateSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'internal_error' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('timeout: cancels the upstream task and refunds', async () => {
    const { userId, jobId } = await paidJob(10, { createdAt: Date.now() - 11 * 60_000 });
    const adapter = new FakeAdapter();
    await runGeneration(deps(adapter), jobId, immediateSteps());
    const job = await loadJob(db, jobId);
    expect(job).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect(adapter.cancelled).toEqual([`up_${jobId}`]);
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('Workflow stops polling after user cancel; succeeded jobs are never changed to failed', async () => {
    const { userId, jobId } = await paidJob();
    await markFailed(db, jobId, 'canceled', 'canceled', 'by user');
    const adapter = new FakeAdapter();
    await runGeneration(deps(adapter), jobId, immediateSteps());
    expect(adapter.submits).toHaveLength(0);
    expect((await getBalance(db, userId)).available).toBe(50);

    const second = await paidJob();
    await markSucceeded(db, second.jobId, []);
    await markFailed(db, second.jobId, 'canceled', 'canceled', 'late cancel');
    expect((await loadJob(db, second.jobId))?.status).toBe('succeeded');
    expect((await getBalance(db, second.userId)).available).toBe(40);
  });

  it('user cancel before the upstream: canceled and refunded once; the Workflow then submits nothing', async () => {
    const { userId, jobId } = await paidJob();
    expect(await cancelQueued(db, jobId)).toMatchObject({ status: 'canceled', errorCode: 'canceled' });
    expect(await cancelQueued(db, jobId)).toMatchObject({ status: 'canceled' });
    const adapter = new FakeAdapter();
    await runGeneration(deps(adapter), jobId, immediateSteps());
    expect(adapter.submits).toHaveLength(0);
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('user cancel once the upstream has the job: nothing changes, no refund, the job still delivers', async () => {
    const { userId, jobId } = await paidJob();
    await markSubmitted(db, jobId, `up_${jobId}`);
    expect(await cancelQueued(db, jobId)).toMatchObject({ status: 'submitted', errorCode: null });
    expect((await getBalance(db, userId)).available).toBe(40);
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'succeeded', files: [{ url: 'https://up/x.png', mediaType: 'image/png' }] }];
    await runGeneration(deps(adapter), jobId, immediateSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('cancel lands while the first submit is in flight: the cancel wins, the just-submitted task is canceled, refunded once', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new FakeAdapter();
    adapter.onSubmit = async () => {
      await cancelQueued(db, jobId);
    };
    await runGeneration(deps(adapter), jobId, immediateSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'canceled' });
    expect(adapter.cancelled).toEqual([`up_${jobId}`]);
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('failed guest job returns quota, only once', async () => {
    const rule = { key: `guest:device:${crypto.randomUUID()}`, window: 'w', limit: 1 };
    expect(await consumeQuota(db, [rule])).toBe(true);
    const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
    await db.insert(jobs).values({
      id: jobId,
      guestId: 'g_1',
      modelId: 'fast',
      kind: 'image',
      prompt: 'x',
      inputJson: JSON.stringify({ references: [], parameters: {} }),
      quotaJson: JSON.stringify([rule]),
      upstream: 'yir',
    });
    await markFailed(db, jobId, 'failed', 'x', 'x');
    await markFailed(db, jobId, 'failed', 'x', 'x');
    expect(await consumeQuota(db, [rule])).toBe(true);
    expect(await consumeQuota(db, [rule])).toBe(false);
  });

  it('canceled guest job keeps its quota spent, so create → cancel cannot loop past the daily limit', async () => {
    const rule = { key: `guest:device:${crypto.randomUUID()}`, window: 'w', limit: 1 };
    expect(await consumeQuota(db, [rule])).toBe(true);
    const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
    await db.insert(jobs).values({
      id: jobId,
      guestId: 'g_1',
      modelId: 'fast',
      kind: 'image',
      prompt: 'x',
      inputJson: JSON.stringify({ references: [], parameters: {} }),
      quotaJson: JSON.stringify([rule]),
      upstream: 'yir',
    });
    await markFailed(db, jobId, 'canceled', 'canceled', 'by user');
    expect(await consumeQuota(db, [rule])).toBe(false);
  });
});

describe('old Workflow replay', () => {
  it('old cached load without parts continues as single-part with unchanged step names and idempotency keys', async () => {
    const { jobId } = await paidJob();
    const job = (await loadJob(db, jobId))!;
    const cache = new Map<string, unknown>([
      ['load', { upstream: 'yir', timeoutMinutes: 10, createdAt: job.createdAt }],
    ]);
    const names: string[] = [];
    const steps: StepRunner = {
      async do(name, fn) {
        names.push(name);
        if (cache.has(name)) return cache.get(name) as never;
        const value = await fn();
        cache.set(name, value);
        return value;
      },
      async sleep(name) {
        names.push(name);
      },
    };
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'succeeded', files: [{ url: 'https://up/x.png', mediaType: 'image/png' }] }];
    await runGeneration(deps(adapter), jobId, steps);
    expect(adapter.submits.map((s) => s.key)).toEqual([jobId]);
    expect(names).toEqual(['load', 'submit', 'poll:0', 'store', 'finish', 'settle', 'cost:0']);
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
  });
});

describe('settlement catch-up', () => {
  it('job marked failed but refund not written: the final Workflow settle step completes the refund', async () => {
    const { userId, jobId } = await paidJob();
    // Simulate the intermediate state "status written as failed, then the refund write failed".
    await db.update(jobs).set({ status: 'failed', errorCode: 'x' }).where(eq(jobs.id, jobId));
    expect((await getBalance(db, userId)).available).toBe(40);
    const steps: string[] = [];
    await runGeneration(deps(new FakeAdapter()), jobId, immediateSteps(steps));
    expect(steps.slice(-2)).toEqual(['settle', 'cost:0']);
    expect((await getBalance(db, userId)).available).toBe(50);
  });
});

describe('Yir not configured', () => {
  it('missing API key fails as non-retryable with a refund, job never hangs', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new YirAdapter({ apiKey: '' });
    await runGeneration({ ...deps(new FakeAdapter()), adapters: { yir: adapter } }, jobId, immediateSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'yir_not_configured' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });
});

describe('Yir errors', () => {
  const input = { upstreamModel: 'm', kind: 'image' as const, prompt: 'p', references: [], parameters: {} };
  const rejecting = (error: unknown) => {
    let calls = 0;
    const client = {
      submitImage: async () => {
        calls++;
        throw error;
      },
    };
    return { adapter: new YirAdapter({ apiKey: 'k' }, client as never), calls: () => calls };
  };

  it('a submit error Yir already retried fails the job at once with a refund, no second submit', async () => {
    const { userId, jobId } = await paidJob();
    const { adapter, calls } = rejecting({
      status: 503,
      code: 'YIR_UPSTREAM_UNAVAILABLE',
      retryable: true,
      message: 'busy',
    });
    const steps: string[] = [];
    await runGeneration(
      { ...deps(new FakeAdapter()), adapters: { yir: adapter } },
      jobId,
      immediateSteps(steps),
    );
    expect(calls()).toBe(1);
    expect(steps).not.toContain('abort');
    expect(await loadJob(db, jobId)).toMatchObject({
      status: 'failed',
      errorCode: 'YIR_UPSTREAM_UNAVAILABLE',
    });
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('only a rate limit stays retryable; network errors are final', async () => {
    await expect(
      rejecting({ status: 429, code: 'YIR_RATE_LIMITED', message: 'slow' }).adapter.submit(input, 'k1'),
    ).rejects.toMatchObject({ code: 'YIR_RATE_LIMITED', retryable: true });
    await expect(rejecting(new TypeError('fetch failed')).adapter.submit(input, 'k2')).rejects.toMatchObject({
      code: 'yir_error',
      retryable: false,
    });
  });
});

describe('Yir request', () => {
  it('uses text input without reference images, image input with them, includes the cost cap', () => {
    const base = { upstreamModel: 'm', kind: 'image' as const, prompt: 'p', parameters: { n: 1 } };
    expect(buildYirRequest({ ...base, references: [] })).toEqual({
      model: 'm',
      parameters: { n: 1 },
      input: { type: 'text', prompt: 'p' },
    });
    expect(
      buildYirRequest({
        ...base,
        references: [{ url: 'https://x/a.png', role: 'reference_image' }],
        maxCost: '0.2',
      }),
    ).toEqual({
      model: 'm',
      parameters: { n: 1 },
      max_cost: '0.2',
      input: {
        type: 'image',
        prompt: 'p',
        references: [{ role: 'reference_image', url: 'https://x/a.png' }],
      },
    });
  });
});

/** Fake upstream that also reports charges: a queue of readings per task, the last one repeating. */
class CostingAdapter extends FakeAdapter {
  charges = new Map<string, UpstreamCost[]>();
  costError: Error | null = null;
  /** Reads that succeed before costError starts applying. */
  readsBeforeError = 0;
  async cost(id: string) {
    if (this.costError && this.readsBeforeError-- <= 0) throw this.costError;
    const queue = this.charges.get(id) ?? [];
    return (queue.length > 1 ? queue.shift() : queue[0]) ?? { usd: '0', settled: true };
  }
}

describe('upstream cost', () => {
  const done = { state: 'succeeded' as const, files: [{ url: 'https://up/x.png', mediaType: 'image/png' }] };

  it('records the settled charge after the job ends, after notify', async () => {
    const { jobId } = await paidJob();
    const adapter = new CostingAdapter();
    adapter.polls = [done];
    adapter.charges.set(`up_${jobId}`, [{ usd: '3.06', settled: true }]);
    const steps: string[] = [];
    await runGeneration({ ...deps(adapter), notify: async () => {} }, jobId, immediateSteps(steps));
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded', upstreamCostUsd: '3.06' });
    expect(steps.slice(-3)).toEqual(['settle', 'notify', 'cost:0']);
  });

  it('waits while billing is pending, then records the settled amount', async () => {
    const { jobId } = await paidJob();
    const adapter = new CostingAdapter();
    adapter.polls = [done];
    adapter.charges.set(`up_${jobId}`, [
      { usd: '0', settled: false },
      { usd: '3.06', settled: true },
    ]);
    const steps: string[] = [];
    await runGeneration(deps(adapter), jobId, immediateSteps(steps));
    expect((await loadJob(db, jobId))?.upstreamCostUsd).toBe('3.06');
    expect(steps.slice(-3)).toEqual(['cost:0', 'cost-wait:0', 'cost:1']);
  });

  it('still pending after the last read: keeps the latest amount and logs it', async () => {
    const { jobId } = await paidJob();
    const adapter = new CostingAdapter();
    adapter.polls = [done];
    adapter.charges.set(`up_${jobId}`, [{ usd: '1.5', settled: false }]);
    const logs: string[] = [];
    const steps: string[] = [];
    await runGeneration(
      { ...deps(adapter), log: (message: string) => logs.push(message) },
      jobId,
      immediateSteps(steps),
    );
    expect((await loadJob(db, jobId))?.upstreamCostUsd).toBe('1.5');
    expect(steps.filter((name) => name.startsWith('cost:'))).toEqual([
      'cost:0',
      'cost:1',
      'cost:2',
      'cost:3',
    ]);
    expect(steps).not.toContain('cost-wait:3');
    expect(logs).toContain('upstream cost not settled');
  });

  it('a read that fails after a pending one keeps the amount already seen', async () => {
    const { jobId } = await paidJob();
    const adapter = new CostingAdapter();
    adapter.polls = [done];
    adapter.charges.set(`up_${jobId}`, [{ usd: '3.06', settled: false }]);
    adapter.costError = new Error('down');
    adapter.readsBeforeError = 1;
    const logs: string[] = [];
    await runGeneration(
      { ...deps(adapter), log: (message: string) => logs.push(message) },
      jobId,
      immediateSteps(),
    );
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded', upstreamCostUsd: '3.06' });
    expect(logs).toContain('cost record failed');
  });

  it('failed jobs are charged too: the cost is recorded alongside the refund', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new CostingAdapter();
    adapter.polls = [{ state: 'failed', code: 'bad', message: 'no' }];
    adapter.charges.set(`up_${jobId}`, [{ usd: '0.4', settled: true }]);
    await runGeneration(deps(adapter), jobId, immediateSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', upstreamCostUsd: '0.4' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('sums every upstream task and skips rejected-prep placeholders', async () => {
    const { jobId } = await paidJob(10, { status: 'failed', upstreamJobId: 'up_a,skipped:prep-x,up_b' });
    const adapter = new CostingAdapter();
    adapter.charges.set('up_a', [{ usd: '0.0085', settled: true }]);
    adapter.charges.set('up_b', [{ usd: '3.06', settled: true }]);
    await runGeneration(deps(adapter), jobId, immediateSteps());
    expect((await loadJob(db, jobId))?.upstreamCostUsd).toBe('3.0685');
  });

  it('a failing cost read never changes the job; adapters without cost leave it null', async () => {
    const { jobId } = await paidJob();
    const adapter = new CostingAdapter();
    adapter.polls = [done];
    adapter.costError = new Error('down');
    const logs: string[] = [];
    await runGeneration(
      { ...deps(adapter), log: (message: string) => logs.push(message) },
      jobId,
      immediateSteps(),
    );
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded', upstreamCostUsd: null });
    expect(logs).toContain('cost record failed');

    const plain = await paidJob();
    const fake = new FakeAdapter();
    fake.polls = [done];
    await runGeneration(deps(fake), plain.jobId, immediateSteps());
    expect(await loadJob(db, plain.jobId)).toMatchObject({ status: 'succeeded', upstreamCostUsd: null });
  });

  it('sumUsd adds in micro-dollars without float drift', () => {
    expect(sumUsd(['0.1', '0.2'])).toBe('0.3');
    expect(sumUsd(['3.06', '0.0085'])).toBe('3.0685');
    expect(sumUsd(['10', '0'])).toBe('10');
    expect(sumUsd([])).toBe('0');
    expect(() => sumUsd(['x'])).toThrow();
  });

  it('Yir: reads total_charged_by_yir; only an explicit settled status is final', async () => {
    const reply = (billing: unknown) =>
      new YirAdapter({ apiKey: 'k' }, { getJob: async () => ({ billing }) } as never).cost('j');
    expect(await reply({ total_charged_by_yir: '3.06', status: 'settled' })).toEqual({
      usd: '3.06',
      settled: true,
    });
    expect(await reply({ total_charged_by_yir: '0' })).toEqual({ usd: '0', settled: false });
    expect(await reply({ total_charged_by_yir: '2', status: 'refunding' })).toEqual({
      usd: '2',
      settled: false,
    });
    expect(await reply({ total_charged_by_yir: '1', status: 'pending' })).toEqual({
      usd: '1',
      settled: false,
    });
    expect(await reply(undefined)).toEqual({ usd: '0', settled: false });
  });
});

describe('failure streak alerts', () => {
  /** A job of the given user, inserted directly; terminal ones have ended at `endedAt`, running ones haven't. */
  async function jobOf(
    userId: string | null,
    status: (typeof jobs.$inferInsert)['status'],
    endedAt: number,
    {
      createdAt = endedAt - 100,
      errorCode = status === 'failed' ? 'reference_subject_invalid' : null,
      id = `job_${crypto.randomUUID().replaceAll('-', '')}`,
      ended = true,
    } = {},
  ) {
    const running = status === 'queued' || status === 'submitted';
    await db.insert(jobs).values({
      id,
      userId,
      guestId: userId ? null : 'g_1',
      modelId: 'fast',
      kind: 'image',
      prompt: 'a cat',
      inputJson: '{"references":[],"parameters":{}}',
      upstream: 'yir',
      status,
      errorCode,
      createdAt,
      finishedAt: running || !ended ? null : endedAt,
    });
    return (await loadJob(db, id))!;
  }
  const someone = () => `u_${crypto.randomUUID().slice(0, 10)}`;
  const alerting = async (rows: Awaited<ReturnType<typeof jobOf>>[]) => {
    const hits: string[] = [];
    for (const row of rows) if (await failureStreak(db, row)) hits.push(row.id);
    return hits;
  };

  it('alerts once, on the third job to fail in a row; later failures stay quiet', async () => {
    const userId = someone();
    const first = await jobOf(userId, 'failed', 1_000);
    expect(await failureStreak(db, first)).toBeNull();
    const second = await jobOf(userId, 'failed', 2_000);
    expect(await failureStreak(db, second)).toBeNull();
    const third = await jobOf(userId, 'failed', 3_000);
    expect((await failureStreak(db, third))?.map((job) => job.id)).toEqual([third.id, second.id, first.id]);
    expect(await failureStreak(db, await jobOf(userId, 'failed', 4_000))).toBeNull();
    expect(FAILURE_STREAK).toBe(3);
  });

  it('jobs created in one order and ending in the reverse order alert exactly once', async () => {
    const userId = someone();
    // A..F created in order, ending F first and A last (the review's counterexample: it used to alert 4 times out of 6).
    const rows = [];
    for (let i = 0; i < 6; i++)
      rows.push(await jobOf(userId, 'failed', 10_000 - i * 1_000, { createdAt: 1_000 + i }));
    const hits = await alerting(rows.toReversed());
    expect(hits).toEqual([rows[3]!.id]);
  });

  it('checks that run late, after more jobs have ended, still alert exactly once', async () => {
    const userId = someone();
    // All four ended before any of them was checked (slow or retried notify steps), checked newest first.
    const rows = [];
    for (const at of [1_000, 2_000, 3_000, 4_000]) rows.push(await jobOf(userId, 'failed', at));
    expect(await alerting(rows.toReversed())).toEqual([rows[2]!.id]);
  });

  it('a success starts a new count; failures that ended before it keep their own streak', async () => {
    const userId = someone();
    await jobOf(userId, 'failed', 1_000);
    await jobOf(userId, 'failed', 2_000);
    await jobOf(userId, 'succeeded', 4_000);
    // Ended third in a row before the success, checked only after it: still that streak's alert.
    const beforeSuccess = await jobOf(userId, 'failed', 3_000);
    expect(await failureStreak(db, beforeSuccess)).toHaveLength(3);
    await jobOf(userId, 'failed', 5_000);
    const again = await jobOf(userId, 'failed', 6_000);
    expect(await failureStreak(db, again)).toBeNull();
    const third = await jobOf(userId, 'failed', 7_000);
    expect(await failureStreak(db, third)).toHaveLength(3);
  });

  it('a success and a failure ending in the same millisecond are ordered by id, like the failures', async () => {
    const userId = someone();
    const tag = crypto.randomUUID().slice(0, 8);
    // The review's case: success a and failure b both at 1000, a first by id; b, c, d are three failures after it.
    await jobOf(userId, 'succeeded', 1_000, { id: `job_${tag}_a` });
    const b = await jobOf(userId, 'failed', 1_000, { id: `job_${tag}_b` });
    const c = await jobOf(userId, 'failed', 2_000);
    const d = await jobOf(userId, 'failed', 3_000);
    expect(await alerting([b, c, d])).toEqual([d.id]);
    expect((await failureStreak(db, d))?.map((job) => job.id)).toEqual([d.id, c.id, b.id]);
    // A failure at 1000 whose id sorts before the success ended before it: an older streak.
    const other = someone();
    await jobOf(other, 'failed', 500);
    await jobOf(other, 'failed', 600);
    const early = await jobOf(other, 'failed', 1_000, { id: `job_${tag}_0` });
    await jobOf(other, 'succeeded', 1_000, { id: `job_${tag}_1` });
    expect(await failureStreak(db, early)).toHaveLength(3);
  });

  it('failed rows without an end time (written before finishedAt existed) are not counted', async () => {
    const userId = someone();
    await jobOf(userId, 'failed', 1_000, { ended: false });
    await jobOf(userId, 'failed', 2_000);
    const second = await jobOf(userId, 'failed', 3_000);
    expect(await failureStreak(db, second)).toBeNull();
    expect(await failureStreak(db, await jobOf(userId, 'failed', 1_500, { ended: false }))).toBeNull();
  });

  it('canceled and still running jobs are not in the streak; a running one that fails later counts when it ends', async () => {
    const userId = someone();
    await jobOf(userId, 'failed', 1_000);
    await jobOf(userId, 'canceled', 2_000);
    const running = await jobOf(userId, 'submitted', 3_000, { createdAt: 500 });
    await jobOf(userId, 'failed', 4_000);
    const third = await jobOf(userId, 'failed', 5_000);
    expect(await failureStreak(db, third)).toHaveLength(3);
    // The running one (created first) fails now: the fourth to end, no second alert.
    await markFailed(db, running.id, 'failed', 'YIR_EXECUTION_FAILED', 'down');
    expect(await failureStreak(db, (await loadJob(db, running.id))!)).toBeNull();
  });

  it('never for guests, other users or jobs that did not fail', async () => {
    const userId = someone();
    await jobOf(userId, 'failed', 1_000);
    await jobOf(someone(), 'failed', 2_000);
    await jobOf(userId, 'failed', 3_000);
    expect(await failureStreak(db, await jobOf(userId, 'succeeded', 4_000))).toBeNull();
    for (const at of [1_000, 2_000]) await jobOf(null, 'failed', at);
    expect(await failureStreak(db, await jobOf(null, 'failed', 3_000))).toBeNull();
  });

  it('the runner alerts after settle; an alert error leaves the failed, refunded job as it is', async () => {
    const { userId, jobId } = await paidJob();
    await jobOf(userId, 'failed', 1_000);
    await jobOf(userId, 'failed', 2_000);
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'failed', code: 'YIR_EXECUTION_FAILED', message: 'provider down' }];
    const steps: string[] = [];
    const alerts: string[][] = [];
    await runGeneration(
      {
        ...deps(adapter),
        failures: async (failed) => {
          alerts.push(failed.map((job) => job.id));
          throw new Error('smtp down');
        },
      },
      jobId,
      immediateSteps(steps),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]![0]).toBe(jobId);
    expect(steps.slice(-3)).toEqual(['settle', 'failures', 'cost:0']);
    expect(steps).not.toContain('abort');
    expect((await loadJob(db, jobId))?.status).toBe('failed');
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('the alert email names the user and every failed job', async () => {
    const userId = someone();
    const failed = [
      await jobOf(userId, 'failed', Date.UTC(2026, 10, 13, 15, 14)),
      await jobOf(userId, 'failed', Date.UTC(2026, 10, 13, 15, 9), { errorCode: 'YIR_EXECUTION_FAILED' }),
    ];
    const sent: { to: string; subject: string; text: string }[] = [];
    const email = {
      send: async (message: { to: string; subject: string; text: string }) => {
        sent.push(message);
        return { messageId: 'm1' };
      },
    } as unknown as SendEmail;
    await emailFailures({
      email,
      from: 'noreply@example.com',
      to: 'owner@example.com',
      site: { name: 'Demo' },
    })(failed);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'owner@example.com',
      subject: `[Demo] 2 failed jobs in a row for user ${userId}`,
    });
    expect(sent[0]!.text).toContain(
      `- ${failed[0]!.id} (fast) ended 2026-11-13T15:14:00.000Z: reference_subject_invalid`,
    );
    expect(sent[0]!.text).toContain('YIR_EXECUTION_FAILED');
  });
});
