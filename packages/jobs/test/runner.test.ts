import { getBalance, grantCredits, spendCredits } from '@shipwords/core/credits/ledger';
import { user } from '@shipwords/core/db/schema';
import type { Mailer } from '@shipwords/core/email/mailer';
import { consumeQuota } from '@shipwords/core/quota/counters';
import { YirSubmissionUncertainError } from '@yir-ai/sdk/server';
import { isDemoJobID } from '@yir-ai/sdk/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { yirDemo } from '../src/adapters';
import { sumUsd } from '../src/cost';
import { ALERT_LIST, FAILURE_STREAK, failureStreak } from '../src/failures';
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
import { bucket } from './bucket';
import { db } from './db';

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
  await spendCredits(db, { userId, amount: cost, idemKey: spendKey(jobId) }, (tx) =>
    tx.insert(jobs).values({
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
  );
  return { userId, jobId };
}

const deps = (adapter: FakeAdapter) => ({
  db,
  bucket: bucket,
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
    expect(await bucket.get(output.key)).not.toBeNull();
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
    } as unknown as Mailer;
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
    } as unknown as Mailer;
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
    const { userId, jobId } = await paidJob();
    const adapter = new FakeAdapter();
    // The deadline passes while the task runs upstream (a job already past it is never submitted).
    const start = Date.now();
    adapter.onSubmit = async () => {
      vi.spyOn(Date, 'now').mockReturnValue(start + 11 * 60_000);
    };
    try {
      await runGeneration(deps(adapter), jobId, immediateSteps());
    } finally {
      vi.restoreAllMocks();
    }
    const job = await loadJob(db, jobId);
    expect(job).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect(adapter.cancelled).toEqual([`up_${jobId}`]);
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('a late rejection from one submit attempt does not fail a job another attempt already submitted', async () => {
    const { userId, jobId } = await paidJob();
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'succeeded', files: [{ url: 'https://up/x.png', mediaType: 'image/png' }] }];
    adapter.submitError = new UpstreamError('YIR_INVALID_REQUEST', 'late', false);
    const real = adapter.submit.bind(adapter);
    adapter.submit = async (input, key) => {
      // Another attempt got through and recorded its task before this one's error came back.
      await markSubmitted(db, jobId, 'up_real');
      return real(input, key);
    };
    await runGeneration(deps(adapter), jobId, immediateSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded', upstreamJobId: 'up_real' });
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('a submit whose record is refused while the slot is still empty retries instead of canceling or ending', async () => {
    const { jobId } = await paidJob();
    const adapter = new FakeAdapter();
    // The run lost the job between submit and record: the fenced write is refused and the slot stays empty.
    const deps2 = { ...deps(adapter), fence: { runId: jobId, token: 'not-the-holder' } };
    await expect(
      runGeneration(deps2, jobId, {
        do: async (name, fn) => {
          if (name === 'abort' || name === 'settle') throw new Error('stop here');
          return fn();
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow('stop here');
    expect(adapter.submits).toHaveLength(1);
    expect(adapter.cancelled).toEqual([]);
    expect((await loadJob(db, jobId))?.status).toBe('queued');
  });

  it('a submit replayed past the deadline recovers the task an earlier attempt may have placed, then cancels it', async () => {
    const { userId, jobId } = await paidJob(10, { createdAt: Date.now() - 11 * 60_000 });
    const adapter = new FakeAdapter();
    const names: string[] = [];
    const replay: StepRunner = {
      do: (name, fn) => {
        names.push(name);
        return fn({ attempt: name === 'submit' ? 2 : 1 });
      },
      sleep: async () => {},
    };
    await runGeneration(deps(adapter), jobId, replay);
    expect(adapter.submits.map((s) => s.key)).toEqual([jobId]);
    expect(adapter.cancelled).toEqual([`up_${jobId}`]);
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('a job already past its deadline is failed and refunded without being submitted', async () => {
    const { userId, jobId } = await paidJob(10, { createdAt: Date.now() - 11 * 60_000 });
    const adapter = new FakeAdapter();
    await runGeneration(deps(adapter), jobId, immediateSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect(adapter.submits).toHaveLength(0);
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

  it('only a rate limit and an uncertain submit stay retryable; other network errors are final', async () => {
    await expect(
      rejecting({ status: 429, code: 'YIR_RATE_LIMITED', message: 'slow' }).adapter.submit(input, 'k1'),
    ).rejects.toMatchObject({ code: 'YIR_RATE_LIMITED', retryable: true });
    await expect(rejecting(new TypeError('fetch failed')).adapter.submit(input, 'k2')).rejects.toMatchObject({
      code: 'yir_error',
      retryable: false,
    });
    await expect(
      rejecting(new YirSubmissionUncertainError('k3', new TypeError('socket hang up'))).adapter.submit(
        input,
        'k3',
      ),
    ).rejects.toMatchObject({
      code: 'submission_outcome_uncertain',
      message: 'socket hang up',
      retryable: true,
    });
  });

  it('an uncertain submit is retried with the same key and recovers the Job: no failure, no refund', async () => {
    const { userId, jobId } = await paidJob();
    const keys: string[] = [];
    const client = {
      submitImage: async (_request: unknown, key: string) => {
        keys.push(key);
        if (keys.length === 1) throw new YirSubmissionUncertainError(key, new TypeError('socket hang up'));
        return { id: 'yir_job_1' };
      },
      getJobStatus: async () => ({ status: 'succeeded' }),
      getJob: async () => ({
        result: { availability: 'available', files: [{ url: 'https://up/x.png', media_type: 'image/png' }] },
      }),
    };
    // Steps rethrow like the worker does and run again (the worker retries with backoff).
    const retrying: StepRunner = {
      async do(_name, fn) {
        for (let attempt = 1; ; attempt++) {
          try {
            return await fn();
          } catch (error) {
            if (attempt >= 3) throw error;
          }
        }
      },
      async sleep() {},
    };
    await runGeneration(
      { ...deps(new FakeAdapter()), adapters: { yir: new YirAdapter({ apiKey: 'k' }, client as never) } },
      jobId,
      retrying,
    );
    expect(keys).toEqual([jobId, jobId]);
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded', upstreamJobId: 'yir_job_1' });
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('cancel: a finished Job (resolved since SDK 0.14) and an unfinished demo Job are not errors', async () => {
    const cancelling = (cancelJob: () => Promise<unknown>) =>
      new YirAdapter({ apiKey: 'k' }, { cancelJob } as never).cancel('j');
    await expect(cancelling(async () => ({ id: 'j', status: 'succeeded' }))).resolves.toBeUndefined();
    await expect(
      cancelling(async () => {
        throw new Error('demo_cancel_unsupported');
      }),
    ).resolves.toBeUndefined();
    await expect(
      cancelling(async () => {
        throw { status: 404, code: 'YIR_JOB_NOT_FOUND', message: 'gone' };
      }),
    ).rejects.toMatchObject({ code: 'YIR_JOB_NOT_FOUND' });
  });
});

describe('Yir demo mode', () => {
  it('only the site env turns it on, never a stray YIR_DEMO in the process environment', () => {
    expect(yirDemo({ YIR_DEMO: '1' })).toBe(true);
    expect(yirDemo({ YIR_DEMO: ' TRUE ' })).toBe(true);
    expect(yirDemo({ YIR_DEMO: '0' })).toBe(false);
    expect(yirDemo({})).toBe(false);
  });

  it('demo submits are quoted, not submitted, and finish locally with a free DEMO result', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      paths.push(`${init?.method ?? (request instanceof Request ? request.method : 'GET')} ${url.pathname}`);
      if (url.pathname === '/v1/images/quotes') {
        const body = JSON.parse(String(init?.body));
        return Response.json({
          object: 'quote',
          model: body.model,
          operation: 'generate_image',
          input_mode: body.input.type,
          parameters: { aspect_ratio: '1:1', n: 1 },
          currency: 'USD',
          expires_at: 1900000000,
          primary: { kind: 'fixed', amount: '0.04' },
          official: { kind: 'fixed', amount: '0.08' },
          supply: { available: true, issues: [] },
        });
      }
      return Response.json({ error: { code: 'UNEXPECTED', message: url.pathname } }, { status: 500 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const adapter = new YirAdapter({ apiKey: 'k', demo: true });
      const { upstreamJobId } = await adapter.submit(
        {
          upstreamModel: 'openai/gpt-image-2',
          kind: 'image',
          prompt: 'p',
          references: [],
          parameters: { aspect_ratio: '1:1' },
        },
        'k-demo',
      );
      expect(isDemoJobID(upstreamJobId)).toBe(true);
      expect(paths).toEqual(['POST /v1/images/quotes']);
      // Answered locally, no request: still running right after submit, nothing charged (settles when it ends).
      expect(await adapter.poll(upstreamJobId, 0)).toEqual({ state: 'running' });
      expect(await adapter.cost(upstreamJobId)).toEqual({ usd: '0', settled: false });
      expect(paths).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  });
});

describe('Yir client identity', () => {
  it('sends shipwords as the first User-Agent product, ahead of the SDK', async () => {
    const seen: Headers[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(input instanceof Request ? input.headers : init?.headers));
      return Response.json({ error: { code: 'YIR_TEST', message: 'stop here' } }, { status: 400 });
    });
    try {
      const adapter = new YirAdapter({ apiKey: 'k' });
      await expect(
        adapter.submit(
          { upstreamModel: 'm', kind: 'image', prompt: 'p', references: [], parameters: {} },
          'k1',
        ),
      ).rejects.toBeInstanceOf(UpstreamError);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen[0]?.get('user-agent')).toMatch(/^shipwords @yir-ai\/sdk\/\d/);
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

  it('failures ended outside the runner pass the alert to the next failure the runner checks', async () => {
    // The third failure is dispatch_failed (no check runs for it): the fourth, checked by the runner, alerts; the fifth stays quiet.
    const userId = someone();
    await jobOf(userId, 'failed', 1_000);
    await jobOf(userId, 'failed', 2_000);
    await jobOf(userId, 'failed', 3_000, { errorCode: 'dispatch_failed' });
    const fourth = await jobOf(userId, 'failed', 4_000);
    expect(await failureStreak(db, fourth)).toHaveLength(4);
    expect(await failureStreak(db, await jobOf(userId, 'failed', 5_000))).toBeNull();
    // Two stale ones in a row at the threshold: the fifth alerts.
    const other = someone();
    await jobOf(other, 'failed', 1_000);
    await jobOf(other, 'failed', 2_000);
    await jobOf(other, 'failed', 3_000, { errorCode: 'stale' });
    await jobOf(other, 'failed', 4_000, { errorCode: 'stale' });
    expect((await failureStreak(db, await jobOf(other, 'failed', 5_000)))?.[0]?.finishedAt).toBe(5_000);
    // Once the third has alerted, unchecked failures after it don't reopen the alert.
    const third = someone();
    await jobOf(third, 'failed', 1_000);
    await jobOf(third, 'failed', 2_000);
    expect(await failureStreak(db, await jobOf(third, 'failed', 3_000))).toHaveLength(3);
    await jobOf(third, 'failed', 4_000, { errorCode: 'dispatch_failed' });
    expect(await failureStreak(db, await jobOf(third, 'failed', 5_000))).toBeNull();
  });

  it('a stale job whose Workflow resumes and runs the check never alerts itself; the next runner failure alerts once', async () => {
    const userId = someone();
    await jobOf(userId, 'failed', 1_000);
    await jobOf(userId, 'failed', 2_000);
    const stale = await jobOf(userId, 'failed', 3_000, { errorCode: 'stale' });
    expect(await failureStreak(db, stale)).toBeNull();
    expect(await failureStreak(db, await jobOf(userId, 'failed', 4_000))).toHaveLength(4);
  });

  it('the Workflow outer catch (workflow_failed) on the threshold passes the alert on too', async () => {
    const userId = someone();
    await jobOf(userId, 'failed', 1_000);
    await jobOf(userId, 'failed', 2_000);
    await jobOf(userId, 'failed', 3_000, { errorCode: 'workflow_failed' });
    expect(await failureStreak(db, await jobOf(userId, 'failed', 4_000))).toHaveLength(4);
    expect(await failureStreak(db, await jobOf(userId, 'failed', 5_000))).toBeNull();
  });

  it('however long a run of unchecked failures, the first runner failure after it alerts, listing at most ALERT_LIST jobs', async () => {
    const userId = someone();
    for (let i = 0; i < 60; i++)
      await jobOf(userId, 'failed', 1_000 + i, {
        errorCode: i < 2 ? 'YIR_EXECUTION_FAILED' : 'dispatch_failed',
      });
    const streak = await failureStreak(db, await jobOf(userId, 'failed', 5_000));
    expect(streak).toHaveLength(ALERT_LIST);
    expect(streak![0]!.finishedAt).toBe(5_000);
    expect(await failureStreak(db, await jobOf(userId, 'failed', 6_000))).toBeNull();
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
    } as unknown as Mailer;
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

  it('a full list says the streak may be longer', async () => {
    const userId = someone();
    const failed = [];
    for (let i = 0; i < ALERT_LIST; i++) failed.push(await jobOf(userId, 'failed', 10_000 - i));
    const sent: { subject: string; text: string }[] = [];
    const email = {
      send: async (message: { subject: string; text: string }) => {
        sent.push(message);
        return { messageId: 'm1' };
      },
    } as unknown as Mailer;
    await emailFailures({
      email,
      from: 'noreply@example.com',
      to: 'owner@example.com',
      site: { name: 'Demo' },
    })(failed);
    expect(sent[0]!.subject).toBe(`[Demo] ${ALERT_LIST}+ failed jobs in a row for user ${userId}`);
  });
});
