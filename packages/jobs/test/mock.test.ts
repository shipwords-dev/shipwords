import { getBalance, grantCredits, spendCredits } from '@shipwords/core/credits/ledger';
import { describe, expect, it } from 'vitest';
import { createAdapters, type JobsEnv } from '../src/adapters';
import { loadJob, spendKey } from '../src/lifecycle';
import { MockAdapter, mockComposer, mockMode } from '../src/mock';
import { defineModels, effectParts, type ModelDefinition } from '../src/models';
import { runGeneration, type StepRunner } from '../src/runner';
import { jobs } from '../src/schema';
import { bucket } from './bucket';
import { db } from './db';

const model: ModelDefinition = {
  id: 'mock-demo',
  name: 'Demo',
  kind: 'video',
  upstream: 'yir',
  upstreamModel: 'vendor/edit',
  credits: 10,
  guest: false,
  allowedParameters: [],
  maxReferences: 0,
  maxCost: '0.80',
  timeoutMinutes: 20,
  effect: {
    slots: [
      { id: 'left', label: 'Left', required: false, prep: 'wearing a cap' },
      { id: 'right', label: 'Right', required: false, prep: 'holding a prop' },
    ],
    prep: { upstreamModel: 'vendor/image', parameters: {}, maxCost: '0.02' },
    segments: [
      {
        id: 'left',
        referenceVideo: 'assets/demo/left.mp4',
        slots: ['left'],
        prompt: (images) => `swap in ${images.left}`,
        parameters: { duration: 6 },
        maxCost: '0.30',
        target: 6,
        base: 'assets/demo/base-left.mp4',
      },
      {
        id: 'right',
        referenceVideo: 'assets/demo/right.mp4',
        slots: ['right'],
        prompt: (images) => `right ${images.right}`,
        parameters: { duration: 4 },
        maxCost: '0.20',
        target: 4,
        base: 'assets/demo/base-right.mp4',
      },
    ],
    compose: {
      audio: 'assets/demo/song.m4a',
      audioStart: 0,
      audioDuration: 10,
      width: 720,
      height: 1280,
      fps: 24,
    },
  },
};
const models = defineModels([model]);

const steps: StepRunner = {
  do: (_name, fn) => fn() as never,
  async sleep() {},
};

/** Records which URLs the runner fetched when storing, returning different bytes per URL. */
function recordingFetcher(fetched: string[]): typeof fetch {
  return async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    return new Response(new TextEncoder().encode(url), { headers: { 'content-type': 'video/mp4' } });
  };
}

async function mockJob(slots: Record<string, string>) {
  const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
  const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
  const parts = effectParts(
    model,
    slots,
    (ref) =>
      typeof ref === 'string' && ref.startsWith('/files/uploads/') ? `http://localhost:5464${ref}` : null,
    (key) => `http://localhost:5464/files/${key}`,
  )!;
  await grantCredits(db, { userId, amount: 50, idemKey: `g:${userId}`, source: 'test' });
  await spendCredits(db, { userId, amount: 10, idemKey: spendKey(jobId) }, (tx) =>
    tx.insert(jobs).values({
      id: jobId,
      userId,
      modelId: 'mock-demo',
      kind: 'video',
      prompt: '',
      inputJson: JSON.stringify({ parts }),
      costCredits: 10,
      upstream: 'yir',
    }),
  );
  return { userId, jobId };
}

describe('mock switch', () => {
  it('without payment credentials only active on localhost, fail mode detected separately', () => {
    expect(mockMode({ UPSTREAM_MOCK: '1', APP_URL: 'http://localhost:5464' })).toBe('succeed');
    expect(mockMode({ UPSTREAM_MOCK: '1', APP_URL: 'http://127.0.0.1:5464/' })).toBe('succeed');
    expect(mockMode({ UPSTREAM_MOCK: '1', APP_URL: 'http://site.localhost' })).toBe('succeed');
    expect(mockMode({ UPSTREAM_MOCK: 'fail', APP_URL: 'http://localhost:5464' })).toBe('fail');
    expect(mockMode({ UPSTREAM_MOCK: '1', APP_URL: 'https://example.com' })).toBeNull();
    expect(mockMode({ UPSTREAM_MOCK: '1', APP_URL: 'https://localhost.evil.com' })).toBeNull();
    expect(mockMode({ UPSTREAM_MOCK: '1' })).toBeNull();
    expect(mockMode({ UPSTREAM_MOCK: '', APP_URL: 'http://localhost:5464' })).toBeNull();
  });

  it('is enabled on a public host only when every payment credential is in test mode', () => {
    const demo = { UPSTREAM_MOCK: '1', APP_URL: 'https://demo.example.com' };
    expect(mockMode({ ...demo, STRIPE_SECRET_KEY: 'sk_test_x' })).toBe('succeed');
    expect(mockMode({ ...demo, STRIPE_SECRET_KEY: 'rk_test_x' })).toBe('succeed');
    expect(mockMode({ ...demo, PAYPAL_CLIENT_ID: 'id', PAYPAL_ENV: 'sandbox' })).toBe('succeed');
    expect(mockMode({ ...demo, STRIPE_SECRET_KEY: 'sk_live_x' })).toBeNull();
    expect(mockMode({ ...demo, STRIPE_SECRET_KEY: 'rk_live_x' })).toBeNull();
    expect(mockMode({ ...demo, PAYPAL_CLIENT_ID: 'id', PAYPAL_ENV: 'live' })).toBeNull();
    expect(mockMode({ ...demo, PAYPAL_CLIENT_ID: 'id' })).toBeNull();
    // A leftover test key does not unlock mock while the other provider is live.
    expect(
      mockMode({ ...demo, STRIPE_SECRET_KEY: 'sk_test_x', PAYPAL_CLIENT_ID: 'id', PAYPAL_ENV: 'live' }),
    ).toBeNull();
    expect(
      mockMode({ ...demo, PAYPAL_CLIENT_ID: 'id', PAYPAL_ENV: 'sandbox', STRIPE_SECRET_KEY: 'sk_live_x' }),
    ).toBeNull();
    // No payment credentials at all: stay off.
    expect(mockMode(demo)).toBeNull();
  });

  it('refuses the real upstream when UPSTREAM_MOCK is set but inactive', () => {
    const base = { YIR_API_KEY: 'yir_x', UPSTREAM_MOCK: '1', APP_URL: 'https://demo.example.com' } as JobsEnv;
    expect(() => createAdapters({ ...base, STRIPE_SECRET_KEY: 'sk_live_x' } as JobsEnv)).toThrow(/refusing/);
    expect(createAdapters({ ...base, STRIPE_SECRET_KEY: 'sk_test_x' } as JobsEnv).yir).toBeInstanceOf(
      MockAdapter,
    );
    expect(createAdapters({ ...base, UPSTREAM_MOCK: '' }).yir).not.toBeInstanceOf(MockAdapter);
  });
});

describe('fake upstream', () => {
  it('in progress until due; then video returns the reference video, image returns the first reference image', async () => {
    const adapter = new MockAdapter('succeed', { image: 0, video: 60_000 });
    const video = await adapter.submit({
      upstreamModel: 'm',
      kind: 'video',
      prompt: '',
      references: [
        { url: 'http://localhost/files/assets/a.mp4', role: 'reference_video' },
        { url: 'http://localhost/files/uploads/b.jpg', role: 'reference_image' },
      ],
      parameters: {},
    });
    expect(await adapter.poll(video.upstreamJobId)).toEqual({ state: 'running' });
    const image = await adapter.submit({
      upstreamModel: 'm',
      kind: 'image',
      prompt: '',
      references: [{ url: 'http://localhost/files/uploads/b.jpg', role: 'reference_image' }],
      parameters: {},
    });
    expect(await adapter.poll(image.upstreamJobId)).toEqual({
      state: 'succeeded',
      files: [{ url: 'http://localhost/files/uploads/b.jpg', mediaType: 'image/jpeg' }],
    });
  });

  it('text-only image task returns the fallback image', async () => {
    const adapter = new MockAdapter('succeed', { image: 0, video: 0 }, 'http://localhost');
    const job = await adapter.submit({
      upstreamModel: 'm',
      kind: 'image',
      prompt: 'a cat',
      references: [],
      parameters: {},
    });
    expect(await adapter.poll(job.upstreamJobId)).toEqual({
      state: 'succeeded',
      files: [{ url: 'http://localhost/mock-output.png', mediaType: 'image/png' }],
    });
  });
});

describe('mock runs a full effect job', () => {
  it('success: prep returns the original photo, video segment returns its reference video, compose uses the first rendered segment, charged once', async () => {
    const { userId, jobId } = await mockJob({ right: '/files/uploads/up_a.png' });
    const fetched: string[] = [];
    const adapter = new MockAdapter('succeed', { image: 0, video: 0 });
    await runGeneration(
      {
        db,
        bucket: bucket,
        models,
        adapters: { yir: adapter },
        composer: mockComposer(bucket),
        fetcher: recordingFetcher(fetched),
      },
      jobId,
      steps,
    );
    const job = await loadJob(db, jobId);
    expect(job?.status).toBe('succeeded');
    // The prep result (the original photo, in mock) is copied to R2 first; then only the right segment renders, so its reference video is
    // what gets stored; the earlier left segment uses its base clip, skips the upstream, and isn't used for the output.
    expect(fetched).toEqual([
      'http://localhost:5464/files/uploads/up_a.png',
      'http://localhost:5464/files/assets/demo/right.mp4',
    ]);
    const outputs = JSON.parse(job!.outputsJson!) as { key: string }[];
    expect(outputs).toHaveLength(2);
    const song = await bucket.get(outputs[0]!.key);
    expect(await song!.text()).toBe('http://localhost:5464/files/assets/demo/right.mp4');
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('fixed result: every job returns the same finished video and never echoes inputs', async () => {
    await bucket.put('assets/demo/result.mp4', 'fixed-song');
    await bucket.put('assets/demo/result-silent.mp4', 'fixed-silent');
    const { jobId } = await mockJob({ right: '/files/uploads/up_a.png' });
    await runGeneration(
      {
        db,
        bucket: bucket,
        models,
        adapters: { yir: new MockAdapter('succeed', { image: 0, video: 0 }) },
        composer: mockComposer(bucket, {
          song: 'assets/demo/result.mp4',
          silent: 'assets/demo/result-silent.mp4',
        }),
        fetcher: recordingFetcher([]),
      },
      jobId,
      steps,
    );
    const job = await loadJob(db, jobId);
    expect(job?.status).toBe('succeeded');
    const [song, silent] = JSON.parse(job!.outputsJson!) as { key: string }[];
    expect(await (await bucket.get(song!.key))!.text()).toBe('fixed-song');
    expect(await (await bucket.get(silent!.key))!.text()).toBe('fixed-silent');
  });

  it('fail mode: whole job fails with a full refund', async () => {
    const { userId, jobId } = await mockJob({
      left: '/files/uploads/up_a.png',
      right: '/files/uploads/up_b.png',
    });
    await runGeneration(
      {
        db,
        bucket: bucket,
        models,
        adapters: { yir: new MockAdapter('fail', { image: 0, video: 0 }) },
        composer: mockComposer(bucket),
        fetcher: recordingFetcher([]),
      },
      jobId,
      steps,
    );
    expect((await loadJob(db, jobId))?.status).toBe('failed');
    expect((await getBalance(db, userId)).available).toBe(50);
  });
});
