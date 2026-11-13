import { env } from 'cloudflare:test';
import { getBalance, grantCredits, spendCredits } from '@shipwords/core/credits/ledger';
import { createDb } from '@shipwords/core/db/client';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type {
  ComposeInput,
  Composer,
  ExtractInput,
  FacesInput,
  LikenessInput,
  PatchInput,
} from '../src/compose';
import { appendUpstreamJob, loadJob, markFailed, spendKey } from '../src/lifecycle';
import { defineModels, type EffectSegment, effectParts, type ModelDefinition } from '../src/models';
import { PREP_HEDGE_MS, runGeneration, type StepRunner } from '../src/runner';
import { jobs } from '../src/schema';
import { type PollResult, type SubmitInput, type UpstreamAdapter, UpstreamError } from '../src/upstream';
import { buildYirRequest, YirAdapter } from '../src/yir';

const db = createDb(env.DB);

const effectModel: ModelDefinition = {
  id: 'demo',
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
      { id: 'left', label: 'Left', required: true },
      { id: 'right', label: 'Right', required: false },
    ],
    segments: [
      {
        id: 'left',
        referenceVideo: 'assets/demo/left.mp4',
        slots: ['left'],
        prompt: (images) => `swap in ${images.left}`,
        parameters: { duration: 6 },
        maxCost: '0.30',
      },
      {
        id: 'right',
        referenceVideo: 'https://cdn.example/right.mp4',
        slots: ['right'],
        prompt: (images) => `right ${images.right}`,
        parameters: { duration: 4 },
        maxCost: '0.20',
      },
      {
        id: 'group',
        referenceVideo: 'assets/demo/group.mp4',
        slots: ['left', 'right'],
        prompt: (images) => `group ${images.left} ${images.right ?? '-'}`,
        parameters: { duration: 5 },
        maxCost: '0.30',
      },
    ],
  },
};
const models = defineModels([effectModel]);

const upload = (ref: unknown) =>
  typeof ref === 'string' && ref.startsWith('/files/uploads/') ? `https://site${ref}` : null;
const asset = (key: string) => `https://site/files/${key}`;

describe('effect slot resolution', () => {
  it('renders only segments with filled slots, numbers prompt images by in-segment order, reference video uses reference_video', () => {
    const parts = effectParts(effectModel, { left: '/files/uploads/up_a.png' }, upload, asset)!;
    expect(parts.map((p) => p.id)).toEqual(['left', 'group']);
    expect(parts[0]).toEqual({
      id: 'left',
      upstreamModel: 'vendor/edit',
      prompt: 'swap in @image1',
      references: [
        { url: 'https://site/files/assets/demo/left.mp4', role: 'reference_video' },
        { url: 'https://site/files/uploads/up_a.png', role: 'reference_image', slot: 'left' },
      ],
      parameters: { duration: 6 },
      maxCost: '0.30',
      slots: ['left'],
      kinds: { left: 'person' },
    });
    expect(parts[1]!.prompt).toBe('group @image1 -');
    expect(parts[1]!.slots).toEqual(['left']);

    const both = effectParts(
      effectModel,
      { right: '/files/uploads/up_b.png', left: '/files/uploads/up_a.png' },
      upload,
      asset,
    )!;
    expect(both.map((p) => p.id)).toEqual(['left', 'right', 'group']);
    expect(both[1]!.references[0]!.url).toBe('https://cdn.example/right.mp4');
    // In-segment order comes from the preset, not the order the user sent.
    expect(both[2]!.prompt).toBe('group @image1 @image2');
    expect(both[2]!.references.slice(1).map((r) => r.url)).toEqual([
      'https://site/files/uploads/up_a.png',
      'https://site/files/uploads/up_b.png',
    ]);
  });

  it('with all slots optional any combination works: renders segments containing uploaded slots, rejects when none uploaded', () => {
    const open: ModelDefinition = {
      ...effectModel,
      effect: {
        ...effectModel.effect!,
        slots: effectModel.effect!.slots.map((slot) => ({ ...slot, required: false })),
      },
    };
    expect(defineModels([open])).toHaveLength(1);
    const ids = (slots: Record<string, string>) => effectParts(open, slots, upload, asset)?.map((p) => p.id);
    // Swap a slot that appears in a single segment only.
    expect(ids({ right: '/files/uploads/up_b.png' })).toEqual(['right', 'group']);
    // Cross-segment slot: left appears in both left and group.
    expect(ids({ left: '/files/uploads/up_a.png' })).toEqual(['left', 'group']);
    // Swap all.
    expect(ids({ left: '/files/uploads/up_a.png', right: '/files/uploads/up_b.png' })).toEqual([
      'left',
      'right',
      'group',
    ]);
    expect(effectParts(open, {}, upload, asset)).toBeNull();
  });

  it('rejects missing required, unknown slots, external links and non-objects', () => {
    expect(effectParts(effectModel, { right: '/files/uploads/up_b.png' }, upload, asset)).toBeNull();
    expect(
      effectParts(
        effectModel,
        { left: '/files/uploads/up_a.png', extra: '/files/uploads/up_c.png' },
        upload,
        asset,
      ),
    ).toBeNull();
    expect(effectParts(effectModel, { left: 'https://evil/x.png' }, upload, asset)).toBeNull();
    expect(effectParts(effectModel, ['/files/uploads/up_a.png'], upload, asset)).toBeNull();
    expect(effectParts(effectModel, undefined, upload, asset)).toBeNull();
    expect(
      effectParts({ ...effectModel, effect: undefined }, { left: '/files/uploads/up_a.png' }, upload, asset),
    ).toBeNull();
  });

  it('preset config errors are reported at defineModels time', () => {
    const bad = (effect: ModelDefinition['effect']) => () => defineModels([{ ...effectModel, effect }]);
    const slots = effectModel.effect!.slots;
    const segment = effectModel.effect!.segments[0]!;
    expect(bad({ slots, segments: [{ ...segment, slots: ['extra'] }] })).toThrow(/unknown slot/);
    expect(bad({ slots, segments: [segment] })).toThrow(/slot right is in no segment/);
    for (const id of ['prep', 'prep-left'])
      expect(bad({ slots: [slots[0]!], segments: [{ ...segment, id }] })).toThrow(/bad segment id/);
    expect(bad({ slots: [slots[0]!], segments: [{ ...segment, referenceVideo: 'http://x/a.mp4' }] })).toThrow(
      /referenceVideo/,
    );
    // Whole-job cap: reject when the sum of segment caps (0.30 + 0.20 + 0.30 = 0.80) exceeds the model cap.
    expect(() => defineModels([{ ...effectModel, maxCost: '0.79' }])).toThrow(/exceeds model maxCost/);
    expect(() => defineModels([{ ...effectModel, maxCost: undefined }])).toThrow(/exceeds model maxCost/);
    expect(bad({ slots: [slots[0]!], segments: [{ ...segment, maxCost: '0' }] })).toThrow(/positive maxCost/);
    expect(
      bad({ slots: [slots[0]!], segments: [{ ...segment, referenceVideo: 'assets/../x.mp4' }] }),
    ).toThrow(/referenceVideo/);
  });

  it('reference video picked by the filled slots: every combination is validated up front, parts use the variant for what was filled', () => {
    const group = effectModel.effect!.segments[2]!;
    const masked = (filled: readonly string[]) => `assets/demo/group-${filled.join('-')}.mp4`;
    const variant: ModelDefinition = {
      ...effectModel,
      effect: {
        ...effectModel.effect!,
        segments: effectModel.effect!.segments.map((s) =>
          s.id === 'group' ? { ...group, referenceVideo: masked } : s,
        ),
      },
    };
    expect(defineModels([variant])).toHaveLength(1);
    const video = (slots: Record<string, string>) =>
      effectParts(variant, slots, upload, asset)!.find((p) => p.id === 'group')!.references[0]!.url;
    expect(video({ left: '/files/uploads/up_a.png' })).toBe('https://site/files/assets/demo/group-left.mp4');
    expect(video({ right: '/files/uploads/up_b.png', left: '/files/uploads/up_a.png' })).toBe(
      'https://site/files/assets/demo/group-left-right.mp4',
    );
    // A combination that maps to a bad key (here only right alone) fails at startup, not on a paid job.
    const broken = (filled: readonly string[]) =>
      filled.join() === 'right' ? 'assets/../x.mp4' : masked(filled);
    expect(() =>
      defineModels([
        {
          ...variant,
          effect: {
            ...variant.effect!,
            segments: variant.effect!.segments.map((s) =>
              s.id === 'group' ? { ...s, referenceVideo: broken } : s,
            ),
          },
        },
      ]),
    ).toThrow(/referenceVideo/);
  });
});

describe('Yir request input mode', () => {
  const base = { upstreamModel: 'm', prompt: 'p', parameters: {} };
  it('video with reference video or image uses reference, first frame only uses image, image tasks stay image', () => {
    const reference = buildYirRequest({
      ...base,
      kind: 'video',
      references: [
        { url: 'https://x/v.mp4', role: 'reference_video' },
        { url: 'https://x/a.png', role: 'reference_image' },
      ],
    });
    expect(reference.input.type).toBe('reference');
    const firstFrame = buildYirRequest({
      ...base,
      kind: 'video',
      references: [{ url: 'https://x/a.png', role: 'first_frame' }],
    });
    expect(firstFrame.input.type).toBe('image');
    const image = buildYirRequest({
      ...base,
      kind: 'image',
      references: [{ url: 'https://x/a.png', role: 'reference_image' }],
    });
    expect(image.input.type).toBe('image');
  });
});

class FakeAdapter implements UpstreamAdapter {
  readonly name = 'yir';
  submits: { input: SubmitInput; key: string }[] = [];
  polls = new Map<string, PollResult[]>();
  cancelled: string[] = [];
  /** Errors injected by submit order. */
  submitErrors: (Error | null)[] = [];
  onSubmit: ((key: string) => Promise<void>) | null = null;
  async submit(input: SubmitInput, key: string) {
    const error = this.submitErrors.shift();
    if (error) throw error;
    this.submits.push({ input, key });
    await this.onSubmit?.(key);
    return { upstreamJobId: `up_${key}` };
  }
  async poll(id: string) {
    return this.polls.get(id)?.shift() ?? { state: 'running' as const };
  }
  async cancel(id: string) {
    this.cancelled.push(id);
  }
}

/** Simulated Workflow: successful step results are cached and not re-run on replay. */
function durableSteps(cache = new Map<string, unknown>(), names: string[] = []): StepRunner {
  return {
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
}

const outputFetcher: typeof fetch = async () =>
  new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } });

async function effectJob(slots: Record<string, string>, overrides: Partial<typeof jobs.$inferInsert> = {}) {
  const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
  const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
  const parts = effectParts(effectModel, slots, upload, asset)!;
  await grantCredits(db, { userId, amount: 50, idemKey: `g:${userId}`, source: 'test' });
  await spendCredits(db, { userId, amount: 10, idemKey: spendKey(jobId) }, [
    db.insert(jobs).values({
      id: jobId,
      userId,
      modelId: 'demo',
      kind: 'video',
      prompt: '',
      inputJson: JSON.stringify({ parts }),
      costCredits: 10,
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
const succeeded = (name: string): PollResult => ({
  state: 'succeeded',
  files: [{ url: `https://up/${name}.mp4`, mediaType: 'video/mp4' }],
});

describe('multi-part effect jobs', () => {
  it('success: each segment submits with jobId:segment ID, outputs numbered by segment, charged once', async () => {
    const { userId, jobId } = await effectJob({
      left: '/files/uploads/up_a.png',
      right: '/files/uploads/up_b.png',
    });
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${jobId}:left`, [{ state: 'running' }, succeeded('left')]);
    adapter.polls.set(`up_${jobId}:right`, [succeeded('right')]);
    adapter.polls.set(`up_${jobId}:group`, [succeeded('group')]);
    const names: string[] = [];
    await runGeneration(deps(adapter), jobId, durableSteps(new Map(), names));
    // Step names are Workflow cache keys (here and below): renaming one replays in-flight jobs wrong.
    expect(names).toMatchSnapshot();

    expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:left`, `${jobId}:right`, `${jobId}:group`]);
    expect(adapter.submits[0]!.input).toMatchObject({
      kind: 'video',
      prompt: 'swap in @image1',
      maxCost: '0.30',
    });
    expect(adapter.submits[1]!.input.maxCost).toBe('0.20');
    const job = await loadJob(db, jobId);
    expect(job?.status).toBe('succeeded');
    expect(job?.upstreamJobId).toBe(`up_${jobId}:left,up_${jobId}:right,up_${jobId}:group`);
    expect(JSON.parse(job!.outputsJson!).map((o: { key: string }) => o.key)).toEqual([
      `jobs/${jobId}/0.mp4`,
      `jobs/${jobId}/1.mp4`,
      `jobs/${jobId}/2.mp4`,
    ]);
    expect(adapter.cancelled).toEqual([]);
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('one segment fails: whole job fails, full refund, submitted segments canceled', async () => {
    const { userId, jobId } = await effectJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${jobId}:left`, [succeeded('left')]);
    adapter.polls.set(`up_${jobId}:group`, [
      { state: 'failed', code: 'YIR_CONTENT_REJECTED', message: 'no' },
    ]);
    await runGeneration(deps(adapter), jobId, durableSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'YIR_CONTENT_REJECTED' });
    expect(adapter.cancelled.sort()).toEqual([`up_${jobId}:group`, `up_${jobId}:left`]);
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('second segment submit rejected (non-retryable): cancels first segment and refunds', async () => {
    const { userId, jobId } = await effectJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.submitErrors = [null, new UpstreamError('YIR_INPUT_REJECTED', 'bad video', false)];
    const names: string[] = [];
    await runGeneration(deps(adapter), jobId, durableSteps(new Map(), names));
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'YIR_INPUT_REJECTED' });
    expect(adapter.cancelled).toEqual([`up_${jobId}:left`]);
    expect(names.some((n) => n.startsWith('poll'))).toBe(false);
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('second segment submit exhausts retries: fallback failure cancels the submitted first segment, refunds once', async () => {
    const { userId, jobId } = await effectJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.submitErrors = [null, new UpstreamError('YIR_TEMPORARILY_UNAVAILABLE', 'busy', true)];
    const names: string[] = [];
    await runGeneration(deps(adapter), jobId, durableSteps(new Map(), names));
    expect(names).toContain('abort');
    expect(adapter.cancelled).toEqual([`up_${jobId}:left`]);
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'internal_error' });
    await markFailed(db, jobId, 'failed', 'again', 'again');
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('replay after interruption: recorded segments are not resubmitted, continues with the next', async () => {
    const { jobId } = await effectJob({ left: '/files/uploads/up_a.png' });
    // The previous run was interrupted after submitting the first segment (Workflow step cache lost, but the DB recorded segment one).
    await appendUpstreamJob(db, jobId, 0, `up_${jobId}:left`);
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${jobId}:left`, [succeeded('left')]);
    adapter.polls.set(`up_${jobId}:group`, [succeeded('group')]);
    await runGeneration(deps(adapter), jobId, durableSteps());
    expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:group`]);
    expect(await loadJob(db, jobId)).toMatchObject({
      status: 'succeeded',
      upstreamJobId: `up_${jobId}:left,up_${jobId}:group`,
    });
  });

  it('user cancels during submit: the just-submitted segment is canceled, polling stops, refunded', async () => {
    const { userId, jobId } = await effectJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.onSubmit = async (key) => {
      if (key.endsWith(':group')) await markFailed(db, jobId, 'canceled', 'canceled', 'by user');
    };
    const names: string[] = [];
    await runGeneration(deps(adapter), jobId, durableSteps(new Map(), names));
    expect(adapter.cancelled).toContain(`up_${jobId}:group`);
    expect(names.some((n) => n.startsWith('poll'))).toBe(false);
    expect((await loadJob(db, jobId))?.status).toBe('canceled');
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('timeout: past the deadline later segments are not submitted, submitted ones are canceled and refunded', async () => {
    const { userId, jobId } = await effectJob(
      { left: '/files/uploads/up_a.png' },
      { createdAt: Date.now() - 21 * 60_000 },
    );
    const adapter = new FakeAdapter();
    await runGeneration(deps(adapter), jobId, durableSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:left`]);
    expect(adapter.cancelled).toEqual([`up_${jobId}:left`]);
    expect((await getBalance(db, userId)).available).toBe(50);
  });
});

describe('appendUpstreamJob', () => {
  it('appends in order, repeated calls are idempotent, rejects misordered or ended jobs', async () => {
    const { jobId } = await effectJob({ left: '/files/uploads/up_a.png' });
    expect(await appendUpstreamJob(db, jobId, 1, 'b')).toBe(false);
    expect(await appendUpstreamJob(db, jobId, 0, 'a')).toBe(true);
    expect(await appendUpstreamJob(db, jobId, 0, 'a')).toBe(true);
    expect(await appendUpstreamJob(db, jobId, 0, 'x')).toBe(false);
    expect(await appendUpstreamJob(db, jobId, 2, 'c')).toBe(false);
    expect(await appendUpstreamJob(db, jobId, 1, 'b')).toBe(true);
    expect(await appendUpstreamJob(db, jobId, 1, 'b')).toBe(true);
    expect((await loadJob(db, jobId))?.upstreamJobId).toBe('a,b');
    await markFailed(db, jobId, 'canceled', 'canceled', 'by user');
    expect(await appendUpstreamJob(db, jobId, 2, 'c')).toBe(false);
  });
});

describe('effect compose', () => {
  const composeModel: ModelDefinition = {
    ...effectModel,
    id: 'demo-compose',
    effect: {
      ...effectModel.effect!,
      segments: effectModel.effect!.segments.map((segment, i) => ({
        ...segment,
        target: [5.333, 3.375, 2.688][i]!,
        base: `assets/demo/base-${segment.id}.mp4`,
        ...(segment.id === 'left' ? { fit: 'trim' as const } : {}),
      })),
      compose: {
        audio: 'assets/demo/song.m4a',
        audioStart: 1.375,
        audioDuration: 11.396,
        width: 720,
        height: 1280,
        fps: 24,
      },
    },
  };
  const composeModels = defineModels([composeModel]);

  class FakeComposer implements Composer {
    calls: ComposeInput[] = [];
    error: Error | null = null;
    checks: FacesInput[] = [];
    /** Per-slot similarity returned by each check in turn; returns "swapped" once exhausted. */
    scores: number[][] = [];
    checkError: Error | null = null;
    async compose(input: ComposeInput) {
      this.calls.push(input);
      if (this.error) throw this.error;
      return { song: new Uint8Array([1]).buffer, silent: new Uint8Array([2]).buffer };
    }
    async faces(input: FacesInput) {
      this.checks.push(input);
      if (this.checkError) throw this.checkError;
      return this.scores.shift() ?? input.points.map(() => 0.3);
    }
    likenessChecks: LikenessInput[] = [];
    /** Per-person likeness returned by each likeness check in turn; returns "looks like them" once exhausted. */
    likenessScores: (number | null)[][] = [];
    likenessError: Error | null = null;
    async likeness(input: LikenessInput) {
      this.likenessChecks.push(input);
      if (this.likenessError) throw this.likenessError;
      return this.likenessScores.shift() ?? input.people.map(() => 0.9);
    }
    extracts: ExtractInput[] = [];
    patches: PatchInput[] = [];
    async extract(input: ExtractInput) {
      this.extracts.push(input);
      return new Uint8Array([7]).buffer;
    }
    /** The repaired song of pass n is the single byte 10 + n, its silent copy 20 + n. */
    async patch(input: PatchInput) {
      this.patches.push(input);
      const n = this.patches.length - 1;
      return { song: new Uint8Array([10 + n]).buffer, silent: new Uint8Array([20 + n]).buffer };
    }
  }

  async function composeJob(slots: Record<string, string>) {
    const job = await effectJob(slots);
    await db.update(jobs).set({ modelId: 'demo-compose' }).where(eq(jobs.id, job.jobId));
    return job;
  }

  function adapterFor(jobId: string) {
    const adapter = new FakeAdapter();
    for (const part of ['left', 'right', 'group'])
      adapter.polls.set(`up_${jobId}:${part}`, [succeeded(part)]);
    return adapter;
  }

  it('rendered segments use model outputs, unrendered ones use base clips, output keeps only with-track and silent versions', async () => {
    const { userId, jobId } = await composeJob({ left: '/files/uploads/up_a.png' });
    const composer = new FakeComposer();
    await runGeneration(
      { ...deps(adapterFor(jobId)), models: composeModels, composer },
      jobId,
      durableSteps(),
    );
    expect(composer.calls).toHaveLength(1);
    expect(composer.calls[0]).toMatchObject({
      jobId,
      segments: [
        { key: `jobs/${jobId}/0.mp4`, target: 5.333, fit: 'trim' },
        { key: 'assets/demo/base-right.mp4', target: 3.375, fit: 'stretch' },
        { key: `jobs/${jobId}/1.mp4`, target: 2.688, fit: 'stretch' },
      ],
      audio: { key: 'assets/demo/song.m4a', start: 1.375, duration: 11.396 },
    });
    const job = await loadJob(db, jobId);
    expect(job?.status).toBe('succeeded');
    expect(JSON.parse(job!.outputsJson!)).toEqual([
      { key: `jobs/${jobId}/2.mp4`, mediaType: 'video/mp4' },
      { key: `jobs/${jobId}/3.mp4`, mediaType: 'video/mp4' },
    ]);
    expect(new Uint8Array(await (await env.OUTPUTS.get(`jobs/${jobId}/3.mp4`))!.arrayBuffer())).toEqual(
      new Uint8Array([2]),
    );
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('compose fails (retries exhausted): whole job fails, full refund, refunded once', async () => {
    const { userId, jobId } = await composeJob({ left: '/files/uploads/up_a.png' });
    const composer = new FakeComposer();
    composer.error = new Error('ffmpeg exploded');
    await runGeneration(
      { ...deps(adapterFor(jobId)), models: composeModels, composer },
      jobId,
      durableSteps(),
    );
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'internal_error' });
    await markFailed(db, jobId, 'failed', 'again', 'again');
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('site has no compose container bound: fails with refund, never delivers a partial result', async () => {
    const { userId, jobId } = await composeJob({ left: '/files/uploads/up_a.png' });
    await runGeneration({ ...deps(adapterFor(jobId)), models: composeModels }, jobId, durableSteps());
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('replay after interruption before compose: segments not resubmitted, compose writes the same keys', async () => {
    const { jobId } = await composeJob({ left: '/files/uploads/up_a.png' });
    const adapter = adapterFor(jobId);
    const cache = new Map<string, unknown>();
    const composer = new FakeComposer();
    composer.error = new Error('container cold');
    // First run: compose throws. Simulate a Workflow retry: keep cached successful steps, drop the fallback's steps, run again.
    const crashing: StepRunner = {
      async do(name, fn) {
        if (name === 'abort' || name === 'settle') throw new Error('stop here');
        if (cache.has(name)) return cache.get(name) as never;
        const value = await fn();
        cache.set(name, value);
        return value;
      },
      async sleep() {},
    };
    await expect(
      runGeneration({ ...deps(adapter), models: composeModels, composer }, jobId, crashing),
    ).rejects.toThrow();
    composer.error = null;
    await runGeneration({ ...deps(adapter), models: composeModels, composer }, jobId, durableSteps(cache));
    expect(adapter.submits).toHaveLength(2);
    expect(composer.calls).toHaveLength(2);
    expect(JSON.parse((await loadJob(db, jobId))!.outputsJson!).map((o: { key: string }) => o.key)).toEqual([
      `jobs/${jobId}/2.mp4`,
      `jobs/${jobId}/3.mp4`,
    ]);
  });

  it('job created under an older config whose segments are gone (shots merged into one): fails and refunds, never composes base clips', async () => {
    const { userId, jobId } = await composeJob({
      left: '/files/uploads/up_a.png',
      right: '/files/uploads/up_b.png',
    });
    const effect = composeModel.effect!;
    const merged = defineModels([
      {
        ...composeModel,
        effect: {
          ...effect,
          segments: [{ ...effect.segments[0]!, id: 'full', slots: effect.slots.map((slot) => slot.id) }],
        },
      },
    ]);
    const adapter = adapterFor(jobId);
    const composer = new FakeComposer();
    await runGeneration({ ...deps(adapter), models: merged, composer }, jobId, durableSteps());
    expect(composer.calls).toHaveLength(0);
    expect((await loadJob(db, jobId))?.status).toBe('failed');
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('incomplete compose config errors at defineModels time', () => {
    const segments = composeModel.effect!.segments;
    expect(() =>
      defineModels([
        {
          ...composeModel,
          effect: {
            ...composeModel.effect!,
            segments: [{ ...segments[0]!, base: undefined }, ...segments.slice(1)],
          },
        },
      ]),
    ).toThrow(/needs target/);
    expect(() =>
      defineModels([
        {
          ...composeModel,
          effect: {
            ...composeModel.effect!,
            compose: { ...composeModel.effect!.compose!, audio: 'https://x/a.m4a' },
          },
        },
      ]),
    ).toThrow(/compose.audio/);
  });

  describe('output check', () => {
    const leftCheck = {
      original: 'assets/demo/base-left.mp4',
      faces: { left: [0.5, 0.4] as const },
      maxSimilarity: 0.6,
    };
    const groupCheck = {
      original: 'assets/demo/base-group.mp4',
      faces: { left: [0.3, 0.5] as const, right: [0.7, 0.5] as const },
      maxSimilarity: 0.6,
    };
    const checkModel: ModelDefinition = {
      ...composeModel,
      id: 'demo-check',
      effect: {
        ...composeModel.effect!,
        segments: composeModel.effect!.segments.map((segment) =>
          segment.id === 'left'
            ? { ...segment, check: leftCheck }
            : segment.id === 'group'
              ? { ...segment, check: groupCheck }
              : segment,
        ),
      },
    };
    const checkModels = defineModels([checkModel]);
    const checkDeps = (adapter: FakeAdapter, composer: FakeComposer) => ({
      ...deps(adapter),
      models: checkModels,
      composer,
    });

    async function checkJob() {
      const job = await effectJob({ left: '/files/uploads/up_a.png' });
      await db.update(jobs).set({ modelId: 'demo-check' }).where(eq(jobs.id, job.jobId));
      return job;
    }

    it('swapped: checks each segment once, only the filled slots, trim over the raw target, stretch over the model duration', async () => {
      const { userId, jobId } = await checkJob();
      const adapter = adapterFor(jobId);
      const composer = new FakeComposer();
      composer.scores = [[0.32]];
      const names: string[] = [];
      await runGeneration(checkDeps(adapter, composer), jobId, durableSteps(new Map(), names));
      expect(names).toMatchSnapshot();
      expect(composer.checks).toEqual([
        {
          jobId,
          key: `jobs/${jobId}/0.mp4`,
          originalKey: 'assets/demo/base-left.mp4',
          points: [[0.5, 0.4]],
          seconds: 5.333,
        },
        // right is not filled, so only the left person in the group shot is checked.
        {
          jobId,
          key: `jobs/${jobId}/1.mp4`,
          originalKey: 'assets/demo/base-group.mp4',
          points: [[0.3, 0.5]],
          seconds: 5,
        },
      ]);
      expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:left`, `${jobId}:group`]);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
      expect((await getBalance(db, userId)).available).toBe(40);
    });

    it('not swapped: no rerun, whole job fails swap_not_applied, cancels running segments, no compose, refunds once', async () => {
      const { userId, jobId } = await checkJob();
      const adapter = adapterFor(jobId);
      adapter.polls.set(`up_${jobId}:group`, []);
      const composer = new FakeComposer();
      composer.scores = [[0.86, 0.81]];
      await runGeneration(checkDeps(adapter, composer), jobId, durableSteps());
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'swap_not_applied' });
      expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:left`, `${jobId}:group`]);
      expect(adapter.cancelled).toEqual(expect.arrayContaining([`up_${jobId}:group`]));
      expect(composer.calls).toHaveLength(0);
      expect((await getBalance(db, userId)).available).toBe(50);
      await markFailed(db, jobId, 'failed', 'again', 'again');
      expect((await getBalance(db, userId)).available).toBe(50);
    });

    it('check result cached before an interruption is reused on replay, not checked again', async () => {
      const { jobId } = await checkJob();
      const adapter = adapterFor(jobId);
      const composer = new FakeComposer();
      composer.scores = [[0.3], [0.2]];
      const cache = new Map<string, unknown>();
      const crashing: StepRunner = {
        async do(name, fn) {
          if (name.startsWith('poll:group') || name === 'abort' || name === 'settle')
            throw new Error('stop here');
          if (cache.has(name)) return cache.get(name) as never;
          const value = await fn();
          cache.set(name, value);
          return value;
        },
        async sleep() {},
      };
      await expect(runGeneration(checkDeps(adapter, composer), jobId, crashing)).rejects.toThrow();
      await runGeneration(checkDeps(adapter, composer), jobId, durableSteps(cache));
      // left was checked before the interruption; on replay only group is checked.
      expect(composer.checks.map((c) => c.key)).toEqual([`jobs/${jobId}/0.mp4`, `jobs/${jobId}/1.mp4`]);
      expect(adapter.submits).toHaveLength(2);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
    });

    it('check errors: whole job fails check_failed, no rerun, no compose, running segments canceled, refunded once', async () => {
      const { userId, jobId } = await checkJob();
      const adapter = adapterFor(jobId);
      const composer = new FakeComposer();
      composer.checkError = new Error('container cold');
      const log = vi.fn();
      await runGeneration({ ...checkDeps(adapter, composer), log }, jobId, durableSteps());
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'check_failed' });
      expect(adapter.submits).toHaveLength(2);
      expect(composer.calls).toHaveLength(0);
      expect(adapter.cancelled).toEqual(expect.arrayContaining([`up_${jobId}:group`]));
      expect(log).toHaveBeenCalledWith('swap check errored', expect.anything());
      expect((await getBalance(db, userId)).available).toBe(50);
      await markFailed(db, jobId, 'failed', 'again', 'again');
      expect((await getBalance(db, userId)).available).toBe(50);
    });

    it('points with a time read the original at that time; segment cuts go to compose with the rendered output only', async () => {
      const timed: ModelDefinition = {
        ...checkModel,
        id: 'demo-timed',
        effect: {
          ...checkModel.effect!,
          segments: checkModel.effect!.segments.map((segment) =>
            segment.id === 'left'
              ? {
                  ...segment,
                  cuts: [1.5, 3],
                  check: { ...leftCheck, faces: { left: [0.5, 0.4, 2.5] as const } },
                }
              : segment.id === 'right'
                ? { ...segment, cuts: [1] }
                : segment,
          ),
        },
      };
      const { jobId } = await checkJob();
      await db.update(jobs).set({ modelId: 'demo-timed' }).where(eq(jobs.id, jobId));
      const composer = new FakeComposer();
      await runGeneration(
        { ...checkDeps(adapterFor(jobId), composer), models: defineModels([timed]) },
        jobId,
        durableSteps(),
      );
      expect(composer.checks[0]!.points).toEqual([[0.5, 0.4, 2.5]]);
      expect(composer.calls[0]!.segments).toEqual([
        { key: `jobs/${jobId}/0.mp4`, target: 5.333, fit: 'trim', cuts: [1.5, 3] },
        // right was not filled: its base clip already has the original timing, so no cuts.
        { key: 'assets/demo/base-right.mp4', target: 3.375, fit: 'stretch' },
        { key: `jobs/${jobId}/1.mp4`, target: 2.688, fit: 'stretch' },
      ]);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
    });

    it('bad cuts and timed points are rejected at defineModels time', () => {
      const withLeft = (patch: Partial<EffectSegment>) => ({
        ...checkModel,
        effect: {
          ...checkModel.effect!,
          segments: checkModel.effect!.segments.map((segment) =>
            segment.id === 'left' ? { ...segment, ...patch } : segment,
          ),
        },
      });
      for (const cuts of [[], [2, 1], [0], [5.333], [1, Number.NaN]])
        expect(() => defineModels([withLeft({ cuts })])).toThrow(/cuts must increase/);
      expect(() =>
        defineModels([withLeft({ check: { ...leftCheck, faces: { left: [0.5, 0.4, 61] as const } } })]),
      ).toThrow(/check.faces/);
      expect(() =>
        defineModels([
          {
            ...checkModel,
            effect: {
              ...checkModel.effect!,
              compose: undefined,
              segments: checkModel.effect!.segments.map((segment) => ({
                ...segment,
                check: undefined,
                cuts: [1],
              })),
            },
          },
        ]),
      ).toThrow(/cuts need compose/);
    });

    it('jobs stored before parts recorded their slots: nothing is checked, delivered as is', async () => {
      const { jobId } = await checkJob();
      const job = await loadJob(db, jobId);
      const input = JSON.parse(job!.inputJson) as { parts: { slots?: string[] }[] };
      for (const part of input.parts) delete part.slots;
      await db
        .update(jobs)
        .set({ inputJson: JSON.stringify(input) })
        .where(eq(jobs.id, jobId));
      const adapter = adapterFor(jobId);
      const composer = new FakeComposer();
      await runGeneration(checkDeps(adapter, composer), jobId, durableSteps());
      expect(composer.checks).toHaveLength(0);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
    });

    it('in-flight jobs whose cached load has the old similarity check: delivered without checking', async () => {
      const { jobId } = await checkJob();
      const adapter = adapterFor(jobId);
      const composer = new FakeComposer();
      const steps = durableSteps();
      const replaying: StepRunner = {
        async do(name, fn) {
          const value = await steps.do(name, fn);
          if (name !== 'load' || !value || typeof value !== 'object' || !('checks' in value)) return value;
          // What an older version cached: SSIM settings, no original or faces.
          return {
            ...value,
            checks: {
              left: { maxSimilarity: 0.75, retries: 1, referenceKey: 'assets/demo/left.mp4', seconds: 5.333 },
            },
          } as never;
        },
        sleep: (name, ms) => steps.sleep(name, ms),
      };
      await runGeneration(checkDeps(adapter, composer), jobId, replaying);
      expect(composer.checks).toHaveLength(0);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
    });

    it("config validation: assets/ original, faces mapping this segment's slots to 0–1 points, bounded threshold, segments within the job cap", () => {
      const withCheck =
        (check: Record<string, unknown>, extra: object = {}) =>
        () =>
          defineModels([
            {
              ...checkModel,
              ...extra,
              effect: {
                ...checkModel.effect!,
                segments: checkModel.effect!.segments.map((s) =>
                  s.id === 'left' ? { ...s, check: { ...leftCheck, ...check } as never } : s,
                ),
              },
            },
          ]);
      expect(withCheck({})).not.toThrow();
      expect(withCheck({ maxSimilarity: 1.2 })).toThrow(/maxSimilarity/);
      expect(withCheck({}, { maxCost: '0.79' })).toThrow(/exceeds/);
      expect(withCheck({ original: 'https://cdn.example/left.mp4' })).toThrow(/check.original/);
      expect(withCheck({ original: 'assets/../secret.mp4' })).toThrow(/check.original/);
      expect(withCheck({ faces: {} })).toThrow(/check.faces/);
      expect(withCheck({ faces: { right: [0.5, 0.5] } })).toThrow(/check.faces/);
      expect(withCheck({ faces: { left: [0.5, 1.5] } })).toThrow(/check.faces/);
      expect(() =>
        defineModels([
          {
            ...effectModel,
            maxCost: '1.10',
            effect: {
              ...effectModel.effect!,
              segments: effectModel.effect!.segments.map((s) =>
                s.id === 'left' ? { ...s, check: leftCheck } : s,
              ),
            },
          },
        ]),
      ).toThrow(/needs compose/);
    });
  });

  describe('repair passes', () => {
    // One segment, three shots: front and edge in the wide shots 0 and 2, solo alone in shot 1; edge sits in the top-left box.
    const repair = {
      upstreamModel: 'vendor/replace',
      prompt: (slots: readonly string[]) => `replace ${slots.join(' ')}`,
      parameters: { resolution: '720p' },
      maxCost: '0.10',
      rounds: 3,
      shots: [['front', 'edge'], ['solo'], ['front', 'edge']],
      crops: { edge: [0, 0, 0.4, 0.4] as const },
    };
    const band: EffectSegment = {
      id: 'band',
      referenceVideo: 'assets/demo/band.mp4',
      slots: ['front', 'edge', 'solo'],
      prompt: () => 'edit',
      parameters: { duration: 6 },
      maxCost: '0.50',
      target: 6,
      cuts: [2, 4],
      base: 'assets/demo/band.mp4',
      check: {
        original: 'assets/demo/band.mp4',
        faces: { front: [0.5, 0.5], edge: [0.1, 0.1], solo: [0.5, 0.4, 3] },
        maxSimilarity: 0.45,
      },
      repair,
    };
    const repairModel: ModelDefinition = {
      ...composeModel,
      id: 'demo-repair',
      maxCost: '0.80',
      effect: {
        slots: [
          { id: 'front', label: 'Front', required: false },
          { id: 'edge', label: 'Edge', required: false },
          { id: 'solo', label: 'Solo', required: false },
        ],
        segments: [band],
        compose: composeModel.effect!.compose,
      },
    };
    const repairModels = defineModels([repairModel]);
    const slotPhotos = {
      front: '/files/uploads/up_f.png',
      edge: '/files/uploads/up_e.png',
      solo: '/files/uploads/up_s.png',
    };
    const fileUrl = (key: string) => `https://site/files/${key}`;

    async function repairJob() {
      const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
      const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
      const parts = effectParts(repairModel, slotPhotos, upload, asset)!;
      await grantCredits(db, { userId, amount: 50, idemKey: `g:${userId}`, source: 'test' });
      await spendCredits(db, { userId, amount: 10, idemKey: spendKey(jobId) }, [
        db.insert(jobs).values({
          id: jobId,
          userId,
          modelId: 'demo-repair',
          kind: 'video',
          prompt: '',
          inputJson: JSON.stringify({ parts }),
          costCredits: 10,
          upstream: 'yir',
        }),
      ]);
      const adapter = new FakeAdapter();
      adapter.polls.set(`up_${jobId}`, [succeeded('band')]);
      for (const round of [0, 1, 2])
        adapter.polls.set(`up_${jobId}:band:repair:${round}`, [succeeded(`repair-${round}`)]);
      return { userId, jobId, adapter };
    }
    const repairDeps = (adapter: FakeAdapter, composer: FakeComposer) => ({
      ...deps(adapter),
      models: repairModels,
      composer,
      fileUrl,
    });
    const bytesOf = async (key: string) => new Uint8Array(await (await env.OUTPUTS.get(key))!.arrayBuffer());

    it('a missed edge person: whole wide shots with everyone in them first, then their box alone, then delivered', async () => {
      const { userId, jobId, adapter } = await repairJob();
      const composer = new FakeComposer();
      // Scores per check in slot order front, edge, solo: the render misses edge, the whole-frame pass still misses edge, the box pass gets it.
      composer.scores = [
        [0.3, 0.8, 0.2],
        [0.3, 0.7, 0.2],
        [0.3, 0.2, 0.2],
      ];
      const names: string[] = [];
      await runGeneration(repairDeps(adapter, composer), jobId, durableSteps(new Map(), names));
      expect(names).toMatchSnapshot();

      expect(composer.calls).toHaveLength(1);
      expect(composer.extracts).toEqual([
        {
          jobId,
          key: `jobs/${jobId}/1.mp4`,
          ranges: [
            [0, 48],
            [96, 144],
          ],
          width: 720,
          height: 1280,
          fps: 24,
        },
        {
          jobId,
          key: `jobs/${jobId}/repair-band-0-song.mp4`,
          ranges: [
            [0, 48],
            [96, 144],
          ],
          crop: [0, 0, 0.4, 0.4],
          width: 720,
          height: 1280,
          fps: 24,
        },
      ]);
      const repairs = adapter.submits.slice(1);
      expect(repairs.map((s) => s.key)).toEqual([`${jobId}:band:repair:0`, `${jobId}:band:repair:1`]);
      expect(repairs[0]!.input).toEqual({
        upstreamModel: 'vendor/replace',
        kind: 'video',
        prompt: 'replace front edge',
        references: [
          { url: `https://site/files/jobs/${jobId}/repair-band-0.mp4`, role: 'reference_video' },
          { url: 'https://site/files/uploads/up_f.png', role: 'reference_image' },
          { url: 'https://site/files/uploads/up_e.png', role: 'reference_image' },
        ],
        parameters: { resolution: '720p', seed: 1 },
        maxCost: '0.10',
      });
      expect(repairs[1]!.input).toMatchObject({
        prompt: 'replace edge',
        references: [
          { url: `https://site/files/jobs/${jobId}/repair-band-1.mp4`, role: 'reference_video' },
          { url: 'https://site/files/uploads/up_e.png', role: 'reference_image' },
        ],
        parameters: { resolution: '720p', seed: 2 },
      });
      expect(composer.patches.map((p) => [p.key, p.patchKey, p.name])).toEqual([
        [`jobs/${jobId}/1.mp4`, `jobs/${jobId}/repair-band-0-out.mp4`, `${jobId}-repair-band-0`],
        [
          `jobs/${jobId}/repair-band-0-song.mp4`,
          `jobs/${jobId}/repair-band-1-out.mp4`,
          `${jobId}-repair-band-1`,
        ],
      ]);
      // Repaired videos are checked on the composed timeline, every filled slot again.
      expect(composer.checks.slice(1)).toEqual([
        {
          jobId,
          key: `jobs/${jobId}/repair-band-0-song.mp4`,
          originalKey: 'assets/demo/band.mp4',
          points: [
            [0.5, 0.5],
            [0.1, 0.1],
            [0.5, 0.4, 3],
          ],
          seconds: 6,
          // Each point looks at the shots of its group only: front and edge at the wide shots 0 and 2, solo at shot 1.
          windows: [
            [
              [0, 1.7],
              [4.3, 6],
            ],
            [
              [0, 1.7],
              [4.3, 6],
            ],
            [[2.3, 3.7]],
          ],
        },
        expect.objectContaining({ key: `jobs/${jobId}/repair-band-1-song.mp4` }),
      ]);
      const job = await loadJob(db, jobId);
      expect(job).toMatchObject({
        status: 'succeeded',
        upstreamJobId: `up_${jobId},up_${jobId}:band:repair:0,up_${jobId}:band:repair:1`,
      });
      expect(JSON.parse(job!.outputsJson!)).toEqual([
        { key: `jobs/${jobId}/1.mp4`, mediaType: 'video/mp4' },
        { key: `jobs/${jobId}/2.mp4`, mediaType: 'video/mp4' },
      ]);
      expect(await bytesOf(`jobs/${jobId}/1.mp4`)).toEqual(new Uint8Array([11]));
      expect(await bytesOf(`jobs/${jobId}/2.mp4`)).toEqual(new Uint8Array([21]));
      expect((await getBalance(db, userId)).available).toBe(40);
    });

    it('a missed close-up person: only their shot, only their photo; the first pass fixing it delivers', async () => {
      const { jobId, adapter } = await repairJob();
      const composer = new FakeComposer();
      composer.scores = [
        [0.3, 0.2, 0.9],
        [0.3, 0.2, 0.1],
      ];
      await runGeneration(repairDeps(adapter, composer), jobId, durableSteps());
      expect(composer.extracts.map((e) => [e.ranges, e.crop])).toEqual([[[[48, 96]], undefined]]);
      expect(adapter.submits[1]!.input.references.map((r) => r.url)).toEqual([
        `https://site/files/jobs/${jobId}/repair-band-0.mp4`,
        'https://site/files/uploads/up_s.png',
      ]);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
      expect(await bytesOf(`jobs/${jobId}/1.mp4`)).toEqual(new Uint8Array([10]));
    });

    it('passes run out: swap_not_applied, every pass recorded for cost and cancel, refunded once', async () => {
      const { userId, jobId, adapter } = await repairJob();
      const composer = new FakeComposer();
      composer.scores = [0, 1, 2, 3].map(() => [0.3, 0.8, 0.2]);
      await runGeneration(repairDeps(adapter, composer), jobId, durableSteps());
      expect(adapter.submits).toHaveLength(4);
      // After the whole-frame pass, later passes keep to the box, each with a new seed.
      expect(composer.extracts.map((e) => e.crop)).toEqual([undefined, [0, 0, 0.4, 0.4], [0, 0, 0.4, 0.4]]);
      expect(adapter.submits.slice(1).map((s) => s.input.parameters.seed)).toEqual([1, 2, 3]);
      const job = await loadJob(db, jobId);
      expect(job).toMatchObject({ status: 'failed', errorCode: 'swap_not_applied' });
      expect(job!.upstreamJobId!.split(',')).toHaveLength(4);
      expect((await getBalance(db, userId)).available).toBe(50);
      await markFailed(db, jobId, 'failed', 'again', 'again');
      expect((await getBalance(db, userId)).available).toBe(50);
    });

    it('a repair pass fails or is rejected upstream: no more passes, swap_not_applied, refunded', async () => {
      for (const setup of [
        (adapter: FakeAdapter, jobId: string) =>
          adapter.polls.set(`up_${jobId}:band:repair:0`, [{ state: 'failed', code: 'nsfw', message: 'no' }]),
        (adapter: FakeAdapter) => {
          adapter.submitErrors = [null, new UpstreamError('content_rejected', 'no', false)];
        },
      ]) {
        const { userId, jobId, adapter } = await repairJob();
        setup(adapter, jobId);
        const composer = new FakeComposer();
        composer.scores = [[0.3, 0.8, 0.2]];
        await runGeneration(repairDeps(adapter, composer), jobId, durableSteps());
        expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'swap_not_applied' });
        expect(composer.patches).toHaveLength(0);
        expect((await getBalance(db, userId)).available).toBe(50);
      }
    });

    it('the check of a repaired video errors: check_failed, the original render is never delivered, refunded', async () => {
      const { userId, jobId, adapter } = await repairJob();
      const composer = new FakeComposer();
      composer.scores = [[0.3, 0.8, 0.2]];
      const faces = composer.faces.bind(composer);
      composer.faces = async (input) => {
        if (input.key.includes('repair')) throw new Error('container cold');
        return faces(input);
      };
      await runGeneration(repairDeps(adapter, composer), jobId, durableSteps());
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'check_failed' });
      expect(adapter.submits).toHaveLength(2);
      expect((await getBalance(db, userId)).available).toBe(50);
    });

    it('without a public file URL a missed swap is refunded as before, with no repair', async () => {
      const { userId, jobId, adapter } = await repairJob();
      const composer = new FakeComposer();
      composer.scores = [[0.3, 0.8, 0.2]];
      const { fileUrl: _, ...noUrl } = repairDeps(adapter, composer);
      await runGeneration(noUrl, jobId, durableSteps());
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'swap_not_applied' });
      expect(adapter.submits).toHaveLength(1);
      expect(composer.calls).toHaveLength(0);
      expect((await getBalance(db, userId)).available).toBe(50);
    });

    it('replay after an interruption mid-pass: the pass is not submitted twice, the job finishes', async () => {
      const { jobId, adapter } = await repairJob();
      const composer = new FakeComposer();
      composer.scores = [
        [0.3, 0.8, 0.2],
        [0.3, 0.1, 0.2],
      ];
      const cache = new Map<string, unknown>();
      const crashing: StepRunner = {
        async do(name, fn) {
          if (name === 'repair:band:0:patch' || name === 'abort' || name === 'settle')
            throw new Error('stop here');
          if (cache.has(name)) return cache.get(name) as never;
          const value = await fn();
          cache.set(name, value);
          return value;
        },
        async sleep() {},
      };
      await expect(runGeneration(repairDeps(adapter, composer), jobId, crashing)).rejects.toThrow();
      await runGeneration(repairDeps(adapter, composer), jobId, durableSteps(cache));
      expect(adapter.submits.map((s) => s.key)).toEqual([jobId, `${jobId}:band:repair:0`]);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
    });

    it('user cancels while a pass renders: polling stops, no further passes, refunded once', async () => {
      const { userId, jobId, adapter } = await repairJob();
      adapter.polls.set(`up_${jobId}:band:repair:0`, []);
      adapter.onSubmit = async (key) => {
        if (key.endsWith(':repair:0')) await markFailed(db, jobId, 'canceled', 'canceled', 'by user');
      };
      const composer = new FakeComposer();
      composer.scores = [[0.3, 0.8, 0.2]];
      await runGeneration(repairDeps(adapter, composer), jobId, durableSteps());
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'canceled' });
      // Submitted after the cancel landed: the pass is canceled right away instead of recorded.
      expect(adapter.cancelled).toContain(`up_${jobId}:band:repair:0`);
      expect(adapter.submits).toHaveLength(2);
      expect((await getBalance(db, userId)).available).toBe(50);
    });

    it('with prep: passes send the prepped photos, not the uploads', async () => {
      const prepRepairModel: ModelDefinition = {
        ...repairModel,
        maxCost: '0.86',
        effect: {
          ...repairModel.effect!,
          slots: repairModel.effect!.slots.map((slot) => ({ ...slot, prep: `clean ${slot.id}` })),
          prep: { upstreamModel: 'vendor/image', parameters: {}, maxCost: '0.01' },
        },
      };
      const models = defineModels([prepRepairModel]);
      const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
      const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
      const parts = effectParts(models[0]!, slotPhotos, upload, asset)!;
      expect(parts.map((p) => p.id)).toEqual(['prep-front', 'prep-edge', 'prep-solo', 'band']);
      await grantCredits(db, { userId, amount: 50, idemKey: `g:${userId}`, source: 'test' });
      await spendCredits(db, { userId, amount: 10, idemKey: spendKey(jobId) }, [
        db.insert(jobs).values({
          id: jobId,
          userId,
          modelId: 'demo-repair',
          kind: 'video',
          prompt: '',
          inputJson: JSON.stringify({ parts }),
          costCredits: 10,
          upstream: 'yir',
        }),
      ]);
      const adapter = new FakeAdapter();
      for (const slot of ['front', 'edge', 'solo'])
        adapter.polls.set(`up_${jobId}:prep-${slot}`, [
          { state: 'succeeded', files: [{ url: `https://up/${slot}-prep.png`, mediaType: 'image/png' }] },
        ]);
      adapter.polls.set(`up_${jobId}:band`, [succeeded('band')]);
      adapter.polls.set(`up_${jobId}:band:repair:0`, [succeeded('repair-0')]);
      const composer = new FakeComposer();
      composer.scores = [
        [0.3, 0.8, 0.2],
        [0.3, 0.2, 0.2],
      ];
      await runGeneration({ ...repairDeps(adapter, composer), models }, jobId, durableSteps());
      const pass = adapter.submits.find((s) => s.key === `${jobId}:band:repair:0`)!;
      expect(pass.input.references.slice(1).map((r) => r.url)).toEqual([
        'https://up/front-prep.png',
        'https://up/edge-prep.png',
      ]);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
      expect((await getBalance(db, userId)).available).toBe(40);
    });

    describe("onMiss 'deliver': the paid render was charged, so a miss delivers instead of refunding", () => {
      const deliverModels = defineModels([
        {
          ...repairModel,
          effect: {
            ...repairModel.effect!,
            segments: [{ ...band, repair: { ...repair, onMiss: 'deliver' } }],
          },
        },
      ]);
      const deliverDeps = (adapter: FakeAdapter, composer: FakeComposer) => ({
        ...repairDeps(adapter, composer),
        models: deliverModels,
      });

      it('passes run out: the checked version with the fewest missed people is delivered, credits kept, every pass recorded', async () => {
        const { userId, jobId, adapter } = await repairJob();
        const composer = new FakeComposer();
        // The render misses edge and solo; pass 0 fixes solo; passes 1 and 2 each lose someone again.
        composer.scores = [
          [0.3, 0.8, 0.9],
          [0.3, 0.8, 0.2],
          [0.9, 0.8, 0.2],
          [0.3, 0.8, 0.9],
        ];
        await runGeneration(deliverDeps(adapter, composer), jobId, durableSteps());
        expect(adapter.submits).toHaveLength(4);
        const job = await loadJob(db, jobId);
        expect(job).toMatchObject({ status: 'succeeded', errorCode: null });
        expect(job!.upstreamJobId!.split(',')).toHaveLength(4);
        expect(await bytesOf(`jobs/${jobId}/1.mp4`)).toEqual(new Uint8Array([10]));
        expect(await bytesOf(`jobs/${jobId}/2.mp4`)).toEqual(new Uint8Array([20]));
        expect((await getBalance(db, userId)).available).toBe(40);
        // Settlement runs again on a replay or a late failure write: a succeeded job never refunds.
        await markFailed(db, jobId, 'failed', 'late', 'late');
        expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
        expect((await getBalance(db, userId)).available).toBe(40);
      });

      it('delivered with people still missed: the job is marked for review and someone is told, the user sees a plain success', async () => {
        const { jobId, adapter } = await repairJob();
        const composer = new FakeComposer();
        composer.scores = [0, 1, 2, 3].map(() => [0.3, 0.8, 0.2]);
        const reviewed: [string, readonly string[]][] = [];
        await runGeneration(
          {
            ...deliverDeps(adapter, composer),
            review: async (job, reasons) => void reviewed.push([job.id, reasons]),
          },
          jobId,
          durableSteps(),
        );
        const job = await loadJob(db, jobId);
        expect(job).toMatchObject({ status: 'succeeded', errorCode: null });
        expect(job!.errorMessage).toMatch(/^needs review: band: delivered with edge not swapped/);
        expect(reviewed).toEqual([[jobId, [expect.stringMatching(/^band: delivered with edge/)]]]);
      });

      it('a fully swapped job is not marked for review', async () => {
        const { jobId, adapter } = await repairJob();
        const composer = new FakeComposer();
        const reviewed: string[] = [];
        await runGeneration(
          { ...deliverDeps(adapter, composer), review: async (job) => void reviewed.push(job.id) },
          jobId,
          durableSteps(),
        );
        expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded', errorMessage: null });
        expect(reviewed).toEqual([]);
      });

      it('a person also seen in another shot: the pass re-renders the shot group where the check saw them', async () => {
        // front also shows in solo's shot (shot 1), checked at 3 s; the render still has front there.
        const cornerModels = defineModels([
          {
            ...repairModel,
            effect: {
              ...repairModel.effect!,
              segments: [
                {
                  ...band,
                  check: {
                    ...band.check!,
                    faces: {
                      ...band.check!.faces,
                      front: [
                        [0.5, 0.5],
                        [0.9, 0.9, 3],
                      ],
                    },
                  },
                  repair: {
                    ...repair,
                    onMiss: 'deliver',
                    shots: [
                      ['front', 'edge'],
                      ['solo', 'front'],
                      ['front', 'edge'],
                    ],
                  },
                },
              ],
            },
          },
        ]);
        const { jobId, adapter } = await repairJob();
        const composer = new FakeComposer();
        // Points in order: front (two), edge, solo.
        composer.scores = [[0.2, 0.8, 0.2, 0.2]];
        await runGeneration(
          { ...repairDeps(adapter, composer), models: cornerModels },
          jobId,
          durableSteps(),
        );
        expect(composer.checks[0]!.points).toEqual([
          [0.5, 0.5],
          [0.9, 0.9, 3],
          [0.1, 0.1],
          [0.5, 0.4, 3],
        ]);
        // The render is checked on its own timeline (6 s requested): front's second point only looks at shot 1, so it flags shot 1 alone.
        expect(composer.checks[0]!.windows).toEqual([
          [
            [0, 1.7],
            [4.3, 6],
          ],
          [[2.3, 3.7]],
          [
            [0, 1.7],
            [4.3, 6],
          ],
          [[2.3, 3.7]],
        ]);
        expect(composer.extracts.map((e) => e.ranges)).toEqual([[[48, 96]]]);
        expect(adapter.submits[1]!.input.prompt).toBe('replace front solo');
        expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
      });

      it('a pass is rejected, fails upstream or times out before any pass lands: the render itself is delivered, credits kept', async () => {
        for (const setup of [
          (adapter: FakeAdapter, _: string, __: FakeComposer) => {
            adapter.submitErrors = [null, new UpstreamError('content_rejected', 'no', false)];
          },
          (adapter: FakeAdapter, jobId: string, _: FakeComposer) =>
            adapter.polls.set(`up_${jobId}:band:repair:0`, [
              { state: 'failed', code: 'nsfw', message: 'no' },
            ]),
          // The deadline passes while the render is composed, so the first pass is never submitted.
          (_: FakeAdapter, __: string, composer: FakeComposer) => {
            const compose = composer.compose.bind(composer);
            composer.compose = async (input) => {
              const late = Date.now() + 2 * 60 * 60_000;
              vi.spyOn(Date, 'now').mockReturnValue(late);
              return compose(input);
            };
          },
        ]) {
          const { userId, jobId, adapter } = await repairJob();
          const composer = new FakeComposer();
          setup(adapter, jobId, composer);
          composer.scores = [[0.3, 0.8, 0.2]];
          await runGeneration(deliverDeps(adapter, composer), jobId, durableSteps());
          vi.restoreAllMocks();
          expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
          expect(composer.patches).toHaveLength(0);
          expect(await bytesOf(`jobs/${jobId}/1.mp4`)).toEqual(new Uint8Array([1]));
          expect(await bytesOf(`jobs/${jobId}/2.mp4`)).toEqual(new Uint8Array([2]));
          expect((await getBalance(db, userId)).available).toBe(40);
        }
      });

      it('the deadline passes while a pass renders: the pass is canceled upstream, the render is delivered, credits kept', async () => {
        const { userId, jobId, adapter } = await repairJob();
        adapter.polls.set(`up_${jobId}:band:repair:0`, []);
        adapter.onSubmit = async (key) => {
          if (key.endsWith(':repair:0')) vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60_000);
        };
        const composer = new FakeComposer();
        composer.scores = [[0.3, 0.8, 0.2]];
        await runGeneration(deliverDeps(adapter, composer), jobId, durableSteps());
        vi.restoreAllMocks();
        expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
        expect(adapter.cancelled).toContain(`up_${jobId}:band:repair:0`);
        expect(await bytesOf(`jobs/${jobId}/1.mp4`)).toEqual(new Uint8Array([1]));
        expect((await getBalance(db, userId)).available).toBe(40);
      });

      it('a pass step keeps throwing (the container patch): the best checked version is delivered; without onMiss it still refunds', async () => {
        for (const [models, delivered] of [
          [deliverModels, true],
          [repairModels, false],
        ] as const) {
          const { userId, jobId, adapter } = await repairJob();
          const composer = new FakeComposer();
          // The render misses edge and solo; pass 0 fixes solo; pass 1's patch keeps failing.
          composer.scores = [
            [0.3, 0.8, 0.9],
            [0.3, 0.8, 0.2],
          ];
          const patch = composer.patch.bind(composer);
          composer.patch = async (input) => {
            if (input.name.endsWith('-1')) throw new Error('container down');
            return patch(input);
          };
          await runGeneration({ ...repairDeps(adapter, composer), models }, jobId, durableSteps());
          if (delivered) {
            expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
            expect(await bytesOf(`jobs/${jobId}/1.mp4`)).toEqual(new Uint8Array([10]));
            expect(await bytesOf(`jobs/${jobId}/2.mp4`)).toEqual(new Uint8Array([20]));
            expect((await getBalance(db, userId)).available).toBe(40);
          } else {
            expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'internal_error' });
            expect((await getBalance(db, userId)).available).toBe(50);
          }
        }
      });

      it('the check of a repaired video errors: the last checked version is delivered, never the unchecked one', async () => {
        const { userId, jobId, adapter } = await repairJob();
        const composer = new FakeComposer();
        composer.scores = [
          [0.3, 0.8, 0.9],
          [0.3, 0.8, 0.2],
        ];
        const faces = composer.faces.bind(composer);
        composer.faces = async (input) => {
          if (input.key.includes('repair-band-1')) throw new Error('container cold');
          return faces(input);
        };
        await runGeneration(deliverDeps(adapter, composer), jobId, durableSteps());
        expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
        expect(adapter.submits).toHaveLength(3);
        expect(await bytesOf(`jobs/${jobId}/1.mp4`)).toEqual(new Uint8Array([10]));
        expect((await getBalance(db, userId)).available).toBe(40);
      });

      it('the check of the render itself errors: the charged render is delivered unchecked, credits kept, no pass', async () => {
        const { userId, jobId, adapter } = await repairJob();
        const composer = new FakeComposer();
        composer.checkError = new Error('container cold');
        await runGeneration(deliverDeps(adapter, composer), jobId, durableSteps());
        expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded', errorCode: null });
        expect(composer.calls).toHaveLength(1);
        expect(adapter.submits).toHaveLength(1);
        expect(await bytesOf(`jobs/${jobId}/1.mp4`)).toEqual(new Uint8Array([1]));
        expect((await getBalance(db, userId)).available).toBe(40);
      });

      it('a miss that cannot be repaired (no public file URL): the charged render is delivered as is, credits kept', async () => {
        const { userId, jobId, adapter } = await repairJob();
        const composer = new FakeComposer();
        composer.scores = [[0.3, 0.8, 0.2]];
        const { fileUrl: _, ...noUrl } = deliverDeps(adapter, composer);
        await runGeneration(noUrl, jobId, durableSteps());
        expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded', errorCode: null });
        expect(adapter.submits).toHaveLength(1);
        expect((await getBalance(db, userId)).available).toBe(40);
      });

      it('replay after an interruption while delivering: no pass runs twice, the job finishes once', async () => {
        const { userId, jobId, adapter } = await repairJob();
        const composer = new FakeComposer();
        composer.scores = [0, 1, 2, 3].map(() => [0.3, 0.8, 0.2]);
        const cache = new Map<string, unknown>();
        const crashing: StepRunner = {
          async do(name, fn) {
            if (name === 'repair:band:deliver-best' || name === 'abort' || name === 'settle')
              throw new Error('stop here');
            if (cache.has(name)) return cache.get(name) as never;
            const value = await fn();
            cache.set(name, value);
            return value;
          },
          async sleep() {},
        };
        await expect(runGeneration(deliverDeps(adapter, composer), jobId, crashing)).rejects.toThrow();
        await runGeneration(deliverDeps(adapter, composer), jobId, durableSteps(cache));
        expect(adapter.submits).toHaveLength(4);
        expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
        expect((await getBalance(db, userId)).available).toBe(40);
      });

      describe('likeness: a swapped person who does not look like their photo is repaired, never refunded', () => {
        const likenessModels = defineModels([
          {
            ...repairModel,
            effect: {
              ...repairModel.effect!,
              segments: [{ ...band, repair: { ...repair, onMiss: 'deliver', likeness: { solo: 0.5 } } }],
            },
          },
        ]);
        const likenessDeps = (adapter: FakeAdapter, composer: FakeComposer) => ({
          ...repairDeps(adapter, composer),
          models: likenessModels,
        });

        it('the check matched the original but the face clearly looks like the photo (a profile): no pass, delivered as composed', async () => {
          const { jobId, adapter } = await repairJob();
          const composer = new FakeComposer();
          composer.scores = [[0.3, 0.2, 0.6]];
          composer.likenessScores = [[0.7, 0.1, 0.1]];
          await runGeneration(likenessDeps(adapter, composer), jobId, durableSteps());
          expect(adapter.submits).toHaveLength(1);
          expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded', errorMessage: null });
        });

        it('the face looks like it should but more like another filled slot: a swap, repaired', async () => {
          const { jobId, adapter } = await repairJob();
          const composer = new FakeComposer();
          // solo looks enough like its photo (0.6), but more like front's (0.7).
          composer.likenessScores = [[0.6, 0.7, 0.1]];
          await runGeneration(likenessDeps(adapter, composer), jobId, durableSteps());
          expect(adapter.submits).toHaveLength(2);
          expect(adapter.submits[1]!.input.prompt).toBe('replace solo');
          expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
        });

        it('the close-up is unlike its photo: one pass on its shot with its photo, delivered once it looks like them', async () => {
          const { userId, jobId, adapter } = await repairJob();
          const composer = new FakeComposer();
          composer.likenessScores = [[0.4], [0.7]];
          await runGeneration(likenessDeps(adapter, composer), jobId, durableSteps());
          // Scored on the composed video over solo's shot, the photo read from the bucket rather than over HTTP; then the other filled
          // slots' photos over the same shot, so a face on the wrong person shows up.
          expect(composer.likenessChecks).toEqual([
            {
              jobId,
              key: `jobs/${jobId}/1.mp4`,
              people: [
                { photo: { key: 'uploads/up_s.png' }, ranges: [[2, 4]] },
                { photo: { key: 'uploads/up_f.png' }, ranges: [[2, 4]] },
                { photo: { key: 'uploads/up_e.png' }, ranges: [[2, 4]] },
              ],
            },
            expect.objectContaining({ key: `jobs/${jobId}/repair-band-0-song.mp4` }),
          ]);
          expect(adapter.submits).toHaveLength(2);
          expect(adapter.submits[1]!.input).toMatchObject({
            prompt: 'replace solo',
            references: [
              { url: `https://site/files/jobs/${jobId}/repair-band-0.mp4`, role: 'reference_video' },
              { url: 'https://site/files/uploads/up_s.png', role: 'reference_image' },
            ],
          });
          expect(composer.extracts.map((e) => e.ranges)).toEqual([[[48, 96]]]);
          expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
          expect(await bytesOf(`jobs/${jobId}/1.mp4`)).toEqual(new Uint8Array([10]));
          expect((await getBalance(db, userId)).available).toBe(40);
        });

        it('still unlike after every pass: the render is delivered as composed, credits kept, never refunded', async () => {
          const { userId, jobId, adapter } = await repairJob();
          const composer = new FakeComposer();
          composer.likenessScores = [0, 1, 2, 3].map(() => [0.4]);
          await runGeneration(likenessDeps(adapter, composer), jobId, durableSteps());
          expect(adapter.submits).toHaveLength(4);
          expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded', errorCode: null });
          // No pass did better than the render (a tie keeps the earlier version), so the composed video stays.
          expect(await bytesOf(`jobs/${jobId}/1.mp4`)).toEqual(new Uint8Array([1]));
          expect((await getBalance(db, userId)).available).toBe(40);
        });

        it('a pass that fixes the face but brings an original back: the version with fewer misses wins', async () => {
          const { jobId, adapter } = await repairJob();
          const composer = new FakeComposer();
          // Render: everyone swapped, solo unlike. Pass 0: solo fixed but edge back. Passes 1–2: edge fixed, solo unlike again.
          composer.scores = [
            [0.3, 0.2, 0.2],
            [0.3, 0.8, 0.2],
            [0.3, 0.2, 0.2],
            [0.3, 0.2, 0.2],
          ];
          composer.likenessScores = [[0.4], [0.7], [0.4], [0.4]];
          await runGeneration(likenessDeps(adapter, composer), jobId, durableSteps());
          expect(adapter.submits).toHaveLength(4);
          // Pass 0 went after solo; pass 1, with edge missed again, after edge first.
          expect(adapter.submits[1]!.input.prompt).toBe('replace solo');
          expect(adapter.submits[2]!.input.prompt).toBe('replace front edge');
          expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
          expect(await bytesOf(`jobs/${jobId}/1.mp4`)).toEqual(new Uint8Array([1]));
        });

        it('the likeness check errors or finds no face in the photo: delivered as composed, no pass', async () => {
          for (const setup of [
            (composer: FakeComposer) => {
              composer.likenessError = new Error('container down');
            },
            (composer: FakeComposer) => {
              composer.likenessScores = [[null]];
            },
          ]) {
            const { userId, jobId, adapter } = await repairJob();
            const composer = new FakeComposer();
            setup(composer);
            const log = vi.fn();
            await runGeneration({ ...likenessDeps(adapter, composer), log }, jobId, durableSteps());
            expect(adapter.submits).toHaveLength(1);
            expect(composer.likenessChecks).toHaveLength(1);
            expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
            expect(await bytesOf(`jobs/${jobId}/1.mp4`)).toEqual(new Uint8Array([1]));
            expect((await getBalance(db, userId)).available).toBe(40);
          }
        });

        it('solo left as the original: not scored, no pass', async () => {
          const { jobId } = await repairJob();
          // Keep front and edge filled, leave solo unfilled.
          const parts = effectParts(
            repairModel,
            { front: slotPhotos.front, edge: slotPhotos.edge },
            upload,
            asset,
          )!;
          await db
            .update(jobs)
            .set({ inputJson: JSON.stringify({ parts }) })
            .where(eq(jobs.id, jobId));
          const adapter = new FakeAdapter();
          adapter.polls.set(`up_${jobId}`, [succeeded('band')]);
          const composer = new FakeComposer();
          composer.likenessScores = [[0.1]];
          await runGeneration(likenessDeps(adapter, composer), jobId, durableSteps());
          expect(composer.likenessChecks).toHaveLength(0);
          expect(adapter.submits).toHaveLength(1);
          expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
        });

        it('a job whose cached load predates likeness never checks it on replay, so its cached passes keep their plan', async () => {
          const { jobId, adapter } = await repairJob();
          const composer = new FakeComposer();
          composer.likenessScores = [[0.1]];
          const inner = durableSteps();
          // The load step as an older version cached it: the checks carry no likeness flag.
          const older: StepRunner = {
            async do(name, fn) {
              if (name !== 'load') return inner.do(name, fn);
              const setup = (await fn()) as { checks: Record<string, { likeness?: boolean }> };
              for (const check of Object.values(setup.checks)) delete check.likeness;
              return setup as never;
            },
            sleep: inner.sleep,
          };
          await runGeneration(likenessDeps(adapter, composer), jobId, older);
          expect(composer.likenessChecks).toHaveLength(0);
          expect(adapter.submits).toHaveLength(1);
          expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
        });

        it('sites without likeness: a fully swapped render runs no likeness check', async () => {
          const { jobId, adapter } = await repairJob();
          const composer = new FakeComposer();
          await runGeneration(deliverDeps(adapter, composer), jobId, durableSteps());
          expect(composer.likenessChecks).toHaveLength(0);
          expect(adapter.submits).toHaveLength(1);
          expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
        });
      });

      it('a cancel during the passes still refunds: delivery only replaces the miss refund', async () => {
        const { userId, jobId, adapter } = await repairJob();
        adapter.polls.set(`up_${jobId}:band:repair:0`, []);
        adapter.onSubmit = async (key) => {
          if (key.endsWith(':repair:0')) await markFailed(db, jobId, 'canceled', 'canceled', 'by user');
        };
        const composer = new FakeComposer();
        composer.scores = [[0.3, 0.8, 0.2]];
        await runGeneration(deliverDeps(adapter, composer), jobId, durableSteps());
        expect(await loadJob(db, jobId)).toMatchObject({ status: 'canceled' });
        expect((await getBalance(db, userId)).available).toBe(50);
      });
    });

    it('config validation: needs check, cuts and a single composed segment; shots per cut; at most 3 people per pass; boxes inside the frame; passes count toward the cap', () => {
      const withRepair =
        (patch: Partial<EffectSegment>, extra: Partial<ModelDefinition> = {}) =>
        () =>
          defineModels([
            {
              ...repairModel,
              ...extra,
              effect: { ...repairModel.effect!, segments: [{ ...band, ...patch }] },
            },
          ]);
      expect(withRepair({})).not.toThrow();
      expect(withRepair({}, { maxCost: '0.79' })).toThrow(/exceeds/);
      expect(withRepair({ check: undefined })).toThrow(/needs check/);
      expect(() =>
        defineModels([
          {
            ...repairModel,
            maxCost: '2.00',
            effect: { ...repairModel.effect!, segments: [band, { ...band, id: 'two', repair: undefined }] },
          },
        ]),
      ).toThrow(/single segment/);
      expect(withRepair({ repair: { ...repair, rounds: 0 } })).toThrow(/rounds/);
      expect(withRepair({ repair: { ...repair, shots: [['front']] } })).toThrow(/shots/);
      expect(withRepair({ repair: { ...repair, shots: [['front', 'edge'], ['solo'], ['nobody']] } })).toThrow(
        /shots/,
      );
      expect(
        withRepair({ repair: { ...repair, shots: [['front', 'edge'], ['front', 'solo'], []] } }),
      ).not.toThrow();
      const withExtra = (shots: string[][]) => () =>
        defineModels([
          {
            ...repairModel,
            effect: {
              ...repairModel.effect!,
              slots: [...repairModel.effect!.slots, { id: 'extra', label: 'Extra', required: false }],
              segments: [{ ...band, slots: [...band.slots, 'extra'], repair: { ...repair, shots } }],
            },
          },
        ]);
      // The limit is per shot: a pass re-renders one group of shots with the same people, so front may be in two groups of 3 and 2.
      expect(withExtra([['front', 'edge', 'solo'], ['front', 'extra'], []])).not.toThrow();
      expect(withExtra([['front', 'edge', 'solo', 'extra'], ['front'], []])).toThrow(/at most 3/);
      // The container takes at most 10 points or people per call: likeness slots × segment slots, and all check points, are capped.
      const withExtraRepair = (extra: object, faces?: object) => () =>
        defineModels([
          {
            ...repairModel,
            effect: {
              ...repairModel.effect!,
              slots: [...repairModel.effect!.slots, { id: 'extra', label: 'Extra', required: false }],
              segments: [
                {
                  ...band,
                  slots: [...band.slots, 'extra'],
                  ...(faces ? { check: { ...band.check!, faces: faces as never } } : {}),
                  repair: {
                    ...repair,
                    onMiss: 'deliver' as const,
                    shots: [['front', 'edge', 'solo'], ['extra'], []],
                    ...extra,
                  },
                },
              ],
            },
          },
        ]);
      expect(withExtraRepair({ likeness: { front: 0.5, edge: 0.5 } })).not.toThrow();
      expect(withExtraRepair({ likeness: { front: 0.5, edge: 0.5, solo: 0.5 } })).toThrow(/at most 10/);
      const four = [
        [0.1, 0.1],
        [0.2, 0.2],
        [0.3, 0.3],
        [0.4, 0.4],
      ];
      expect(withExtraRepair({}, { front: four, edge: four, solo: four })).toThrow(/more than 10 points/);
      expect(withRepair({ repair: { ...repair, aspect: 0 } })).toThrow(/aspect/);
      expect(withRepair({ repair: { ...repair, shots: [['front'], ['solo'], ['front']] } })).toThrow(
        /edge must be in some shot/,
      );
      expect(withRepair({ repair: { ...repair, crops: { edge: [0.8, 0, 0.4, 0.4] } } })).toThrow(/crops/);
      const deliver = { ...repair, onMiss: 'deliver' as const };
      expect(withRepair({ repair: { ...deliver, likeness: { solo: 0.5 } } })).not.toThrow();
      expect(withRepair({ repair: { ...repair, likeness: { solo: 0.5 } } })).toThrow(/onMiss 'deliver'/);
      expect(withRepair({ repair: { ...deliver, likeness: { solo: 1.2 } } })).toThrow(/likeness/);
      expect(withRepair({ repair: { ...deliver, likeness: { nobody: 0.5 } } })).toThrow(/likeness/);
    });
  });
});

describe('prep and reference audio', () => {
  const prepModel: ModelDefinition = {
    ...effectModel,
    id: 'demo-prep',
    maxCost: '0.88',
    effect: {
      slots: [
        { id: 'left', label: 'Left', required: true, prep: 'left outfit' },
        { id: 'right', label: 'Right', required: false },
      ],
      segments: effectModel.effect!.segments.map((segment) =>
        segment.id === 'group' ? { ...segment, referenceAudio: 'assets/demo/group.mp3' } : segment,
      ),
      prep: { upstreamModel: 'vendor/image', parameters: { resolution: '1K' }, maxCost: '0.04' },
    },
  };
  const prepModels = defineModels([prepModel]);
  const prepDeps = (adapter: FakeAdapter) => ({ ...deps(adapter), models: prepModels });
  const image = (url: string): PollResult => ({
    state: 'succeeded',
    files: [{ url, mediaType: 'image/png' }],
  });

  async function prepJob(slots: Record<string, string>) {
    const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
    const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
    const parts = effectParts(prepModel, slots, upload, asset)!;
    await grantCredits(db, { userId, amount: 50, idemKey: `g:${userId}`, source: 'test' });
    await spendCredits(db, { userId, amount: 10, idemKey: spendKey(jobId) }, [
      db.insert(jobs).values({
        id: jobId,
        userId,
        modelId: 'demo-prep',
        kind: 'video',
        prompt: '',
        inputJson: JSON.stringify({ parts }),
        costCredits: 10,
        upstream: 'yir',
      }),
    ]);
    return { userId, jobId };
  }

  it('resolution: prep segments first, video segments reference prep results via placeholders, slots without prep keep the original, reference audio after reference images', () => {
    const parts = effectParts(
      prepModel,
      { left: '/files/uploads/up_a.png', right: '/files/uploads/up_b.png' },
      upload,
      asset,
    )!;
    expect(parts.map((p) => p.id)).toEqual(['prep-left', 'left', 'right', 'group']);
    expect(parts[0]).toEqual({
      id: 'prep-left',
      kind: 'image',
      upstreamModel: 'vendor/image',
      prompt: 'left outfit',
      references: [{ url: 'https://site/files/uploads/up_a.png', role: 'reference_image' }],
      parameters: { resolution: '1K' },
      maxCost: '0.04',
    });
    expect(parts[3]!.references).toEqual([
      { url: 'https://site/files/assets/demo/group.mp4', role: 'reference_video' },
      { url: 'prep:left', role: 'reference_image', slot: 'left' },
      { url: 'https://site/files/uploads/up_b.png', role: 'reference_image', slot: 'right' },
      { url: 'https://site/files/assets/demo/group.mp3', role: 'reference_audio' },
    ]);
    // Only a slot without prep is filled: no prep segment.
    const optional: ModelDefinition = {
      ...prepModel,
      effect: {
        ...prepModel.effect!,
        slots: prepModel.effect!.slots.map((slot) => ({ ...slot, required: false })),
      },
    };
    expect(
      effectParts(optional, { right: '/files/uploads/up_b.png' }, upload, asset)!.map((p) => p.id),
    ).toEqual(['right', 'group']);
  });

  it('config validation: prep cost counts twice toward the job cap (hedge copy), reference audio only accepts assets/*.mp3 or https', () => {
    expect(() => defineModels([{ ...prepModel, maxCost: '0.87' }])).toThrow(/exceeds model maxCost/);
    expect(() =>
      defineModels([
        {
          ...prepModel,
          effect: {
            ...prepModel.effect!,
            segments: prepModel.effect!.segments.map((segment) => ({
              ...segment,
              referenceAudio: 'assets/demo/a.m4a',
            })),
          },
        },
      ]),
    ).toThrow(/referenceAudio/);
  });

  it('execution: video segments submit after prep finishes, placeholders replaced with prep results, prep images not stored, output numbered from 0', async () => {
    const { userId, jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${jobId}:prep-left`, [{ state: 'running' }, image('https://up/left-prep.png')]);
    adapter.polls.set(`up_${jobId}:left`, [succeeded('left')]);
    adapter.polls.set(`up_${jobId}:group`, [succeeded('group')]);
    let videoSubmittedEarly = false;
    adapter.onSubmit = async (key) => {
      if (!key.endsWith('prep-left') && (adapter.polls.get(`up_${jobId}:prep-left`)?.length ?? 0) > 0)
        videoSubmittedEarly = true;
    };
    const names: string[] = [];
    await runGeneration(prepDeps(adapter), jobId, durableSteps(new Map(), names));
    expect(names).toMatchSnapshot();

    expect(videoSubmittedEarly).toBe(false);
    expect(adapter.submits.map((s) => s.key)).toEqual([
      `${jobId}:prep-left`,
      `${jobId}:left`,
      `${jobId}:group`,
    ]);
    expect(adapter.submits[0]!.input).toMatchObject({
      kind: 'image',
      upstreamModel: 'vendor/image',
      maxCost: '0.04',
    });
    expect(adapter.submits[1]!.input.kind).toBe('video');
    expect(adapter.submits[1]!.input.references[1]).toEqual({
      url: 'https://up/left-prep.png',
      role: 'reference_image',
      slot: 'left',
    });
    const job = await loadJob(db, jobId);
    expect(job).toMatchObject({
      status: 'succeeded',
      upstreamJobId: `up_${jobId}:prep-left,up_${jobId}:left,up_${jobId}:group`,
    });
    expect(JSON.parse(job!.outputsJson!).map((o: { key: string }) => o.key)).toEqual([
      `jobs/${jobId}/0.mp4`,
      `jobs/${jobId}/1.mp4`,
    ]);
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  describe('subjects and descriptions', () => {
    // left is a subject with three prep views; right a plain reference without prep. The prompt asks for left's description (view 1).
    const subjectModel: ModelDefinition = {
      ...prepModel,
      id: 'demo-subjects',
      maxCost: '1.00',
      effect: {
        slots: [
          { id: 'left', label: 'Left', required: true, prep: ['face', 'front', 'side'] },
          { id: 'right', label: 'Right', required: false },
        ],
        prep: prepModel.effect!.prep,
        describe: { instruction: 'describe them', view: 1 },
        segments: [
          {
            id: 'group',
            referenceVideo: 'assets/demo/group.mp4',
            slots: ['left', 'right'],
            subjects: { left: 'Left' },
            prompt: (images, { describe }) =>
              `group ${images.left}${describe('left')} ${images.right ?? '-'}`,
            parameters: { duration: 5 },
            maxCost: '0.40',
          },
        ],
      },
    };
    const subjectModels = defineModels([subjectModel]);

    async function subjectJob() {
      const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
      const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
      const parts = effectParts(
        subjectModel,
        { left: '/files/uploads/up_a.png', right: '/files/uploads/up_b.png' },
        upload,
        asset,
      )!;
      await grantCredits(db, { userId, amount: 50, idemKey: `g:${userId}`, source: 'test' });
      await spendCredits(db, { userId, amount: 10, idemKey: spendKey(jobId) }, [
        db.insert(jobs).values({
          id: jobId,
          userId,
          modelId: 'demo-subjects',
          kind: 'video',
          prompt: '',
          inputJson: JSON.stringify({ parts }),
          costCredits: 10,
          upstream: 'yir',
        }),
      ]);
      const adapter = new FakeAdapter();
      adapter.polls.set(`up_${jobId}:group`, [succeeded('group')]);
      return { userId, jobId, adapter };
    }

    it('each view goes to the subject, a failed view falls back to the photo, the description lands after the name', async () => {
      const { jobId, adapter } = await subjectJob();
      adapter.polls.set(`up_${jobId}:prep-left`, [image('https://up/face.png')]);
      adapter.polls.set(`up_${jobId}:prep-left-v1`, [{ state: 'failed', code: 'x', message: 'no' }]);
      adapter.polls.set(`up_${jobId}:prep-left-v2`, [image('https://up/side.png')]);
      const asked: [string, string][] = [];
      const names: string[] = [];
      await runGeneration(
        {
          ...deps(adapter),
          models: subjectModels,
          fileUrl: (key: string) => `https://site/files/${key}`,
          describe: async (url: string, instruction: string) => {
            asked.push([url, instruction]);
            return 'The person is a woman in a red "N" shirt.';
          },
        },
        jobId,
        durableSteps(new Map(), names),
      );
      expect(names).toContain('describe:group');
      // The front view fell back to the photo, so that is what was described.
      expect(asked).toEqual([['https://site/files/uploads/up_a.png', 'describe them']]);
      const video = adapter.submits.find((submit) => submit.key === `${jobId}:group`)!.input;
      expect(video.prompt).toBe('group @Left, a woman in a red N shirt @image2');
      expect(video.references.map((ref) => [ref.url, ref.subject])).toEqual([
        ['https://site/files/assets/demo/group.mp4', undefined],
        ['https://up/face.png', 'Left'],
        ['https://site/files/uploads/up_a.png', 'Left'],
        ['https://up/side.png', 'Left'],
        ['https://site/files/uploads/up_b.png', undefined],
      ]);
      expect(buildYirRequest(video).input).toMatchObject({
        references: expect.arrayContaining([
          { role: 'reference_image', url: 'https://up/face.png', subject: 'Left' },
        ]),
      });
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
    });

    it('every view fell back to the photo: sent once plus a second URL; a failed description is left out, the job goes on', async () => {
      const { jobId, adapter } = await subjectJob();
      for (const id of ['prep-left', 'prep-left-v1', 'prep-left-v2'])
        adapter.polls.set(`up_${jobId}:${id}`, [{ state: 'failed', code: 'x', message: 'no' }]);
      await runGeneration(
        {
          ...deps(adapter),
          models: subjectModels,
          fileUrl: (key: string) => `https://site/files/${key}`,
          describe: async () => {
            throw new Error('model down');
          },
        },
        jobId,
        durableSteps(),
      );
      const video = adapter.submits.find((submit) => submit.key === `${jobId}:group`)!.input;
      expect(video.prompt).toBe('group @Left @image2');
      expect(video.references.filter((ref) => ref.subject === 'Left').map((ref) => ref.url)).toEqual([
        'https://site/files/uploads/up_a.png',
        'https://site/files/uploads/up_a.png?view=2',
      ]);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'succeeded' });
    });
  });

  const finishVideo = (adapter: FakeAdapter, jobId: string) => {
    adapter.polls.set(`up_${jobId}:left`, [succeeded('left')]);
    adapter.polls.set(`up_${jobId}:group`, [succeeded('group')]);
  };

  it('prep fails (e.g. celebrity photo rejected): falls back to the original photo, no refund', async () => {
    const { userId, jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${jobId}:prep-left`, [
      { state: 'failed', code: 'YIR_CONTENT_REJECTED', message: 'no' },
    ]);
    finishVideo(adapter, jobId);
    await runGeneration(prepDeps(adapter), jobId, durableSteps());
    expect(adapter.submits.map((s) => s.key)).toEqual([
      `${jobId}:prep-left`,
      `${jobId}:left`,
      `${jobId}:group`,
    ]);
    expect(adapter.submits[1]!.input.references[1]!.url).toBe('https://site/files/uploads/up_a.png');
    expect(adapter.cancelled).toEqual([]);
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
    expect((await getBalance(db, userId)).available).toBe(40);
  });

  it('prep succeeds but returns no image: also falls back to the original photo', async () => {
    const { jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${jobId}:prep-left`, [{ state: 'succeeded', files: [] }]);
    finishVideo(adapter, jobId);
    await runGeneration(prepDeps(adapter), jobId, durableSteps());
    expect(adapter.submits[1]!.input.references[1]!.url).toBe('https://site/files/uploads/up_a.png');
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
  });

  it('prep submit rejected outright (non-retryable): records a placeholder, never polls or cancels it, video segment uses the original photo', async () => {
    const { jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.submitErrors = [new UpstreamError('YIR_INPUT_REJECTED', 'public figure', false)];
    finishVideo(adapter, jobId);
    const names: string[] = [];
    await runGeneration(prepDeps(adapter), jobId, durableSteps(new Map(), names));
    expect(names.some((n) => n.startsWith('poll:prep-left'))).toBe(false);
    expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:left`, `${jobId}:group`]);
    expect(adapter.submits[0]!.input.references[1]!.url).toBe('https://site/files/uploads/up_a.png');
    expect(await loadJob(db, jobId)).toMatchObject({
      status: 'succeeded',
      upstreamJobId: `skipped:prep-left,up_${jobId}:left,up_${jobId}:group`,
    });
  });

  it('video segment fails after prep rejection: whole job refunded, placeholder skipped on cancel', async () => {
    const { userId, jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.submitErrors = [new UpstreamError('YIR_INPUT_REJECTED', 'public figure', false)];
    adapter.polls.set(`up_${jobId}:left`, [{ state: 'failed', code: 'YIR_CONTENT_REJECTED', message: 'no' }]);
    await runGeneration(prepDeps(adapter), jobId, durableSteps());
    expect(adapter.cancelled.sort()).toEqual([`up_${jobId}:group`, `up_${jobId}:left`]);
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'YIR_CONTENT_REJECTED' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('prep finishes after the deadline: video segments not submitted, prep segment canceled and refunded', async () => {
    const { userId, jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    // The clock passes 21 minutes when the prep poll returns, simulating prep using up the time limit.
    adapter.polls.set(`up_${jobId}:prep-left`, [image('https://up/left-prep.png')]);
    const poll = adapter.poll.bind(adapter);
    const start = Date.now();
    adapter.poll = async (id: string) => {
      const result = await poll(id);
      vi.spyOn(Date, 'now').mockReturnValue(start + 21 * 60_000);
      return result;
    };
    try {
      await runGeneration(prepDeps(adapter), jobId, durableSteps());
    } finally {
      vi.restoreAllMocks();
    }
    expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:prep-left`]);
    expect(adapter.cancelled).toEqual([`up_${jobId}:prep-left`]);
    expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect((await getBalance(db, userId)).available).toBe(50);
  });

  it('replay after interruption during video submit: prep not resubmitted, placeholders still use cached prep results', async () => {
    const { jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${jobId}:prep-left`, [image('https://up/left-prep.png')]);
    adapter.polls.set(`up_${jobId}:left`, [succeeded('left')]);
    adapter.polls.set(`up_${jobId}:group`, [succeeded('group')]);
    adapter.submitErrors = [null, null, new Error('worker evicted')];
    const cache = new Map<string, unknown>();
    // First run: throws on submitting video segment 2, and the fallback step is also interrupted (simulating Worker eviction), so the job stays in progress.
    const crashing = durableSteps(cache);
    await expect(
      runGeneration(prepDeps(adapter), jobId, {
        ...crashing,
        async do(name, fn) {
          if (name === 'abort') throw new Error('interrupted');
          return crashing.do(name, fn);
        },
      }),
    ).rejects.toThrow(/interrupted/);
    // Second run: replay from cache.
    await runGeneration(prepDeps(adapter), jobId, durableSteps(cache));
    expect(adapter.submits.map((s) => s.key)).toEqual([
      `${jobId}:prep-left`,
      `${jobId}:left`,
      `${jobId}:group`,
    ]);
    expect(adapter.submits[2]!.input.references[1]!.url).toBe('https://up/left-prep.png');
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
  });
  describe('slow prep hedge', () => {
    const hedgeId = (jobId: string) => `up_${jobId}:prep-left:hedge`;
    /** Clock past PREP_HEDGE_MS after job creation from the first prep poll on. */
    const lateClock = (adapter: FakeAdapter) => {
      const poll = adapter.poll.bind(adapter);
      const start = Date.now();
      adapter.poll = async (id: string) => {
        vi.spyOn(Date, 'now').mockReturnValue(start + PREP_HEDGE_MS + 1_000);
        return poll(id);
      };
    };

    it('prep still running past the hedge time: submits one copy, the first to finish is used, the other is canceled, the copy is not recorded', async () => {
      const { userId, jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
      const adapter = new FakeAdapter();
      adapter.polls.set(`up_${jobId}:prep-left`, [{ state: 'running' }, { state: 'running' }]);
      adapter.polls.set(hedgeId(jobId), [image('https://up/left-hedge.png')]);
      finishVideo(adapter, jobId);
      lateClock(adapter);
      try {
        const names: string[] = [];
        await runGeneration(prepDeps(adapter), jobId, durableSteps(new Map(), names));
        expect(names).toMatchSnapshot();
      } finally {
        vi.restoreAllMocks();
      }
      expect(adapter.submits.map((s) => s.key)).toEqual([
        `${jobId}:prep-left`,
        `${jobId}:prep-left:hedge`,
        `${jobId}:left`,
        `${jobId}:group`,
      ]);
      expect(adapter.submits[1]!.input).toEqual(adapter.submits[0]!.input);
      expect(adapter.submits[2]!.input.references[1]!.url).toBe('https://up/left-hedge.png');
      expect(adapter.cancelled).toEqual([`up_${jobId}:prep-left`]);
      expect(await loadJob(db, jobId)).toMatchObject({
        status: 'succeeded',
        upstreamJobId: `up_${jobId}:prep-left,up_${jobId}:left,up_${jobId}:group`,
      });
      expect((await getBalance(db, userId)).available).toBe(40);
    });

    it('original finishes first after hedging: original used, copy canceled; original failing waits for the copy', async () => {
      const first = await prepJob({ left: '/files/uploads/up_a.png' });
      const adapter = new FakeAdapter();
      adapter.polls.set(`up_${first.jobId}:prep-left`, [
        { state: 'running' },
        image('https://up/left-prep.png'),
      ]);
      finishVideo(adapter, first.jobId);
      lateClock(adapter);
      try {
        await runGeneration(prepDeps(adapter), first.jobId, durableSteps());
      } finally {
        vi.restoreAllMocks();
      }
      expect(adapter.submits[2]!.input.references[1]!.url).toBe('https://up/left-prep.png');
      expect(adapter.cancelled).toEqual([hedgeId(first.jobId)]);

      const second = await prepJob({ left: '/files/uploads/up_a.png' });
      const other = new FakeAdapter();
      const stuck: PollResult = { state: 'failed', code: 'YIR_EXECUTION_FAILED', message: 'stuck' };
      other.polls.set(`up_${second.jobId}:prep-left`, [{ state: 'running' }, stuck, stuck]);
      other.polls.set(hedgeId(second.jobId), [{ state: 'running' }, image('https://up/left-hedge.png')]);
      finishVideo(other, second.jobId);
      lateClock(other);
      try {
        await runGeneration(prepDeps(other), second.jobId, durableSteps());
      } finally {
        vi.restoreAllMocks();
      }
      expect(other.submits[2]!.input.references[1]!.url).toBe('https://up/left-hedge.png');
      expect((await loadJob(db, second.jobId))?.status).toBe('succeeded');
    });

    it('both copies fail: falls back to the original photo; copy submit failing keeps waiting on the original', async () => {
      const first = await prepJob({ left: '/files/uploads/up_a.png' });
      const adapter = new FakeAdapter();
      const failed: PollResult = { state: 'failed', code: 'YIR_EXECUTION_FAILED', message: 'no' };
      adapter.polls.set(`up_${first.jobId}:prep-left`, [{ state: 'running' }, failed]);
      adapter.polls.set(hedgeId(first.jobId), [failed]);
      finishVideo(adapter, first.jobId);
      lateClock(adapter);
      try {
        await runGeneration(prepDeps(adapter), first.jobId, durableSteps());
      } finally {
        vi.restoreAllMocks();
      }
      expect(adapter.submits[2]!.input.references[1]!.url).toBe('https://site/files/uploads/up_a.png');
      expect((await loadJob(db, first.jobId))?.status).toBe('succeeded');

      const second = await prepJob({ left: '/files/uploads/up_a.png' });
      const other = new FakeAdapter();
      other.submitErrors = [null, new UpstreamError('YIR_RATE_LIMITED', 'busy', false)];
      other.polls.set(`up_${second.jobId}:prep-left`, [
        { state: 'running' },
        { state: 'running' },
        image('https://up/left-prep.png'),
      ]);
      finishVideo(other, second.jobId);
      lateClock(other);
      const names: string[] = [];
      try {
        await runGeneration(prepDeps(other), second.jobId, durableSteps(new Map(), names));
      } finally {
        vi.restoreAllMocks();
      }
      expect(names.filter((n) => n === 'hedge:prep-left')).toHaveLength(1);
      expect(other.submits.map((s) => s.key)).toEqual([
        `${second.jobId}:prep-left`,
        `${second.jobId}:left`,
        `${second.jobId}:group`,
      ]);
      expect(other.submits[1]!.input.references[1]!.url).toBe('https://up/left-prep.png');
      expect((await loadJob(db, second.jobId))?.status).toBe('succeeded');
    });

    it('user cancels after the copy is placed: the next poll cancels the unrecorded copy and stops, refunded', async () => {
      const { userId, jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
      const adapter = new FakeAdapter();
      adapter.polls.set(`up_${jobId}:prep-left`, [{ state: 'running' }]);
      adapter.onSubmit = async (key) => {
        if (key.endsWith(':hedge')) await markFailed(db, jobId, 'canceled', 'canceled', 'by user');
      };
      lateClock(adapter);
      try {
        await runGeneration(prepDeps(adapter), jobId, durableSteps());
      } finally {
        vi.restoreAllMocks();
      }
      expect(adapter.cancelled).toContain(hedgeId(jobId));
      expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:prep-left`, `${jobId}:prep-left:hedge`]);
      expect((await loadJob(db, jobId))?.status).toBe('canceled');
      expect((await getBalance(db, userId)).available).toBe(50);
    });

    it('timeout after the copy is placed: both copies canceled, refunded', async () => {
      const { userId, jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
      const adapter = new FakeAdapter();
      adapter.polls.set(`up_${jobId}:prep-left`, [{ state: 'running' }]);
      const start = Date.now();
      adapter.onSubmit = async (key) => {
        if (key.endsWith(':hedge')) vi.spyOn(Date, 'now').mockReturnValue(start + 21 * 60_000);
      };
      lateClock(adapter);
      try {
        await runGeneration(prepDeps(adapter), jobId, durableSteps());
      } finally {
        vi.restoreAllMocks();
      }
      expect(adapter.cancelled.sort()).toEqual([`up_${jobId}:prep-left`, hedgeId(jobId)].sort());
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
      expect((await getBalance(db, userId)).available).toBe(50);
    });

    it('replay: cached prep polls are reused and never hedge, even with a late clock', async () => {
      const { jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
      const adapter = new FakeAdapter();
      finishVideo(adapter, jobId);
      await appendUpstreamJob(db, jobId, 0, `up_${jobId}:prep-left`);
      const cache = new Map<string, unknown>([
        ['submit:prep-left', { upstreamJobId: `up_${jobId}:prep-left` }],
        ['poll:prep:0', { state: 'polled', results: { 'prep-left': { state: 'running' } }, hedge: [] }],
        [
          'poll:prep:1',
          { state: 'polled', results: { 'prep-left': image('https://up/left-prep.png') }, hedge: [] },
        ],
      ]);
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + PREP_HEDGE_MS + 1_000);
      try {
        await runGeneration(prepDeps(adapter), jobId, durableSteps(cache));
      } finally {
        vi.restoreAllMocks();
      }
      expect(adapter.submits.map((s) => s.key)).toEqual([`${jobId}:left`, `${jobId}:group`]);
      expect(adapter.submits[0]!.input.references[1]!.url).toBe('https://up/left-prep.png');
    });

    it('replay resuming a cached hedge decision past the deadline: no copy submitted, times out and refunds', async () => {
      const { userId, jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
      const adapter = new FakeAdapter();
      await appendUpstreamJob(db, jobId, 0, `up_${jobId}:prep-left`);
      const cache = new Map<string, unknown>([
        ['submit:prep-left', { upstreamJobId: `up_${jobId}:prep-left` }],
        [
          'poll:prep:0',
          { state: 'polled', results: { 'prep-left': { state: 'running' } }, hedge: ['prep-left'] },
        ],
      ]);
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 21 * 60_000);
      try {
        await runGeneration(prepDeps(adapter), jobId, durableSteps(cache));
      } finally {
        vi.restoreAllMocks();
      }
      expect(adapter.submits).toEqual([]);
      expect(await loadJob(db, jobId)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
      expect((await getBalance(db, userId)).available).toBe(50);
    });

    it('a query error on one copy does not override the other copy succeeding', async () => {
      const { jobId } = await prepJob({ left: '/files/uploads/up_a.png' });
      const adapter = new FakeAdapter();
      adapter.polls.set(`up_${jobId}:prep-left`, [{ state: 'running' }]);
      adapter.polls.set(hedgeId(jobId), [image('https://up/left-hedge.png')]);
      finishVideo(adapter, jobId);
      lateClock(adapter);
      const poll = adapter.poll;
      adapter.poll = async (id: string) => {
        if (id === `up_${jobId}:prep-left` && adapter.submits.length > 1) throw new Error('status 502');
        return poll(id);
      };
      try {
        await runGeneration(prepDeps(adapter), jobId, durableSteps());
      } finally {
        vi.restoreAllMocks();
      }
      expect(adapter.submits[2]!.input.references[1]!.url).toBe('https://up/left-hedge.png');
      expect((await loadJob(db, jobId))?.status).toBe('succeeded');
    });

    it('several slow preps: each gets its copy in the same round, not after the previous prep finishes', async () => {
      const both: ModelDefinition = {
        ...prepModel,
        id: 'demo-prep-both',
        maxCost: '0.96',
        effect: {
          ...prepModel.effect!,
          slots: prepModel.effect!.slots.map((slot) => ({ ...slot, prep: `${slot.id} outfit` })),
        },
      };
      const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
      const jobId = `job_${crypto.randomUUID().replaceAll('-', '')}`;
      const parts = effectParts(
        both,
        { left: '/files/uploads/up_a.png', right: '/files/uploads/up_b.png' },
        upload,
        asset,
      )!;
      await grantCredits(db, { userId, amount: 50, idemKey: `g:${userId}`, source: 'test' });
      await spendCredits(db, { userId, amount: 10, idemKey: spendKey(jobId) }, [
        db.insert(jobs).values({
          id: jobId,
          userId,
          modelId: both.id,
          kind: 'video',
          prompt: '',
          inputJson: JSON.stringify({ parts }),
          costCredits: 10,
          upstream: 'yir',
        }),
      ]);
      const adapter = new FakeAdapter();
      adapter.polls.set(`up_${jobId}:prep-left`, [{ state: 'running' }, { state: 'running' }]);
      adapter.polls.set(`up_${jobId}:prep-right`, [{ state: 'running' }, { state: 'running' }]);
      adapter.polls.set(`up_${jobId}:prep-left:hedge`, [image('https://up/left-hedge.png')]);
      adapter.polls.set(`up_${jobId}:prep-right:hedge`, [image('https://up/right-hedge.png')]);
      for (const id of ['left', 'right', 'group']) adapter.polls.set(`up_${jobId}:${id}`, [succeeded(id)]);
      lateClock(adapter);
      try {
        await runGeneration({ ...deps(adapter), models: defineModels([both]) }, jobId, durableSteps());
      } finally {
        vi.restoreAllMocks();
      }
      expect(adapter.submits.map((s) => s.key)).toEqual([
        `${jobId}:prep-left`,
        `${jobId}:prep-right`,
        `${jobId}:prep-left:hedge`,
        `${jobId}:prep-right:hedge`,
        `${jobId}:left`,
        `${jobId}:right`,
        `${jobId}:group`,
      ]);
      expect(adapter.submits[6]!.input.references.slice(1, 3).map((r) => r.url)).toEqual([
        'https://up/left-hedge.png',
        'https://up/right-hedge.png',
      ]);
      expect((await loadJob(db, jobId))?.status).toBe('succeeded');
    });
  });
});

describe('four-view sheets', () => {
  const model: ModelDefinition = {
    ...effectModel,
    maxCost: '0.84',
    effect: {
      ...effectModel.effect!,
      slots: [{ id: 'left', label: 'Left', required: true, prepSheet: 'four equal panels' }],
      prep: { upstreamModel: 'vendor/image', parameters: {}, maxCost: '0.04' },
      segments: [{ ...effectModel.effect!.segments[0]!, subjects: { left: 'Lead' } }],
    },
  };
  const sheetModels = defineModels([model]);
  const splitSheet = () =>
    vi.fn(async () => Array.from({ length: 4 }, (_, n) => new Uint8Array([n + 1]).buffer));
  async function setup() {
    const parts = effectParts(model, { left: '/files/uploads/up_a.png' }, upload, asset)!;
    const job = await effectJob(
      { left: '/files/uploads/up_a.png' },
      { inputJson: JSON.stringify({ parts }) },
    );
    const adapter = new FakeAdapter();
    adapter.polls.set(`up_${job.jobId}:prep-left`, [succeeded('sheet')]);
    adapter.polls.set(`up_${job.jobId}:left`, [succeeded('video')]);
    const split = splitSheet();
    const runDeps = {
      ...deps(adapter),
      models: sheetModels,
      fileUrl: asset,
      composer: { splitSheet: split } as unknown as Composer,
    };
    return { ...job, adapter, split, runDeps, parts };
  }
  it('one image task yields four distinct subject photos and retains credits once on replay', async () => {
    const { jobId, userId, adapter, split, runDeps, parts } = await setup();
    expect(parts.map((part) => part.id)).toEqual(['prep-left', 'left']);
    const cache = new Map<string, unknown>();
    adapter.submitErrors = [null, new Error('evicted')];
    const steps = durableSteps(cache);
    await expect(
      runGeneration(runDeps, jobId, {
        ...steps,
        async do(name, fn) {
          if (name === 'abort') throw new Error('interrupted');
          return steps.do(name, fn);
        },
      }),
    ).rejects.toThrow('interrupted');
    await runGeneration(runDeps, jobId, durableSteps(cache));
    await runGeneration(runDeps, jobId, durableSteps(cache));
    expect(split).toHaveBeenCalledTimes(1);
    expect(adapter.submits).toHaveLength(2);
    const photos = adapter.submits[1]!.input.references.slice(1);
    expect(photos).toHaveLength(4);
    expect(new Set(photos.map((photo) => photo.url)).size).toBe(4);
    expect(photos.every((photo) => photo.subject === 'Lead')).toBe(true);
    expect((await getBalance(db, userId)).available).toBe(40);
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
  });
  it('slow sheets never submit speculative copies', async () => {
    const { jobId, adapter, runDeps } = await setup();
    adapter.polls.set(`up_${jobId}:prep-left`, [{ state: 'running' }, succeeded('sheet')]);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + PREP_HEDGE_MS + 1000);
    try {
      await runGeneration(runDeps, jobId, durableSteps());
      expect(adapter.submits.map((item) => item.key)).toEqual([`${jobId}:prep-left`, `${jobId}:left`]);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('retries a partial crop write without submitting another image task', async () => {
    const { jobId, adapter, split, runDeps } = await setup();
    let interrupted = false;
    const bucket = new Proxy(env.OUTPUTS, {
      get(target, key) {
        if (key === 'put')
          return async (...args: Parameters<R2Bucket['put']>) => {
            if (args[0].endsWith('prep-left-1.png') && !interrupted) {
              interrupted = true;
              throw new Error('write interrupted');
            }
            return target.put(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const steps = durableSteps();
    await runGeneration({ ...runDeps, bucket }, jobId, {
      ...steps,
      async do(name, fn) {
        if (name.startsWith('split:'))
          return steps.do(name, async () => {
            try {
              return await fn();
            } catch {
              return fn();
            }
          });
        return steps.do(name, fn);
      },
    });
    expect(interrupted).toBe(true);
    expect(split).toHaveBeenCalledTimes(2);
    expect(adapter.submits).toHaveLength(2);
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
    for (let view = 0; view < 4; view++) {
      const object = await env.OUTPUTS.get(`jobs/${jobId}/prep-left-${view}.png`);
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(new Uint8Array([view + 1]));
    }
  });
  it('failed sheet falls back to original photos without splitting', async () => {
    const { jobId, adapter, runDeps, split } = await setup();
    adapter.polls.set(`up_${jobId}:prep-left`, [{ state: 'failed', code: 'rejected', message: 'rejected' }]);
    await runGeneration(runDeps, jobId, durableSteps());
    expect(split).not.toHaveBeenCalled();
    expect(adapter.submits[1]!.input.references.slice(1)).toHaveLength(2);
    expect((await loadJob(db, jobId))?.status).toBe('succeeded');
  });
  it('real SDK validation rejects invalid video before any prep charge, refunds only once', async () => {
    const { jobId, userId, adapter, runDeps, parts } = await setup();
    parts[1]!.references[1]!.subject = 'bad name!';
    await db
      .update(jobs)
      .set({ inputJson: JSON.stringify({ parts }) })
      .where(eq(jobs.id, jobId));
    const validator = new YirAdapter({ apiKey: 'unused' });
    Object.assign(adapter, { validate: validator.validate.bind(validator) });
    await runGeneration(runDeps, jobId, durableSteps());
    await runGeneration(runDeps, jobId, durableSteps());
    expect(adapter.submits).toHaveLength(0);
    expect((await loadJob(db, jobId))?.status).toBe('failed');
    expect((await getBalance(db, userId)).available).toBe(50);
  });
  it('split failure prevents video spending and refunds once', async () => {
    const { jobId, userId, adapter, runDeps, split } = await setup();
    split.mockRejectedValue(new Error('bad image'));
    await runGeneration(runDeps, jobId, durableSteps());
    await runGeneration(runDeps, jobId, durableSteps());
    expect(adapter.submits).toHaveLength(1);
    expect((await getBalance(db, userId)).available).toBe(50);
  });
});
