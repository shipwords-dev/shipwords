import { getBalance, grantCredits } from '@shipwords/core/credits/ledger';
import { user } from '@shipwords/core/db/schema';
import type { Core } from '@shipwords/core/server';
import { describe, expect, it } from 'vitest';
import { createJobs } from '../src/handlers';
import { loadJob } from '../src/lifecycle';
import { MockAdapter } from '../src/mock';
import { defineModels, MAX_LYRICS, type ModelDefinition, musicParameters } from '../src/models';
import { emailOnFinish } from '../src/notify';
import { runGeneration, type StepRunner } from '../src/runner';
import type { PollResult, SubmitInput, UpstreamAdapter } from '../src/upstream';
import { buildYirRequest, YirAdapter } from '../src/yir';
import { bucket } from './bucket';
import { db } from './db';
import { id3v2 } from './id3';

const BASE = 'https://music.test';

const song: ModelDefinition = {
  id: 'song',
  name: 'Song',
  kind: 'music',
  upstream: 'yir',
  upstreamModel: 'suno/suno-v6',
  credits: 1,
  guest: true,
  allowedParameters: ['instrumental'],
  maxReferences: 0,
  maxCost: '0.12',
  timeoutMinutes: 10,
};
const models = defineModels([song]);

class FakeAdapter implements UpstreamAdapter {
  readonly name = 'yir';
  submits: { input: SubmitInput; key: string }[] = [];
  polls: PollResult[] = [];
  async submit(input: SubmitInput, key: string) {
    this.submits.push({ input, key });
    return { upstreamJobId: `up_${key}` };
  }
  async poll() {
    return this.polls.shift() ?? { state: 'running' as const };
  }
  async cancel() {}
}

const steps: StepRunner = { do: (_name, fn) => fn(), sleep: async () => {} };
const mp3Fetcher: typeof fetch = async () =>
  new Response(new Uint8Array([0xff, 0xfb]), { headers: { 'content-type': 'audio/mpeg' } });

/** The slice of Core that createJobs touches: a signed-in user (or a guest with a granted quota) and a Workflow that only records ids. */
function fakeCore(userId: string | null) {
  const dispatched: string[] = [];
  const core = {
    db,
    site: { id: 'music', url: BASE },
    env: {
      APP_URL: BASE,
      GUEST_COOKIE_SECRET: 'secret',
      GENERATION_WORKFLOW: {
        create: async ({ id }: { id: string }) => {
          dispatched.push(id);
        },
      },
    },
    getUser: async () => (userId ? { id: userId } : null),
    guest: {
      authorize: async () => ({ ok: true, guestId: 'g_music', setCookie: null, rules: [] }),
    },
    log: () => {},
  } as unknown as Core;
  return { jobs: createJobs(core, models), dispatched };
}

async function userWith(credits: number) {
  const userId = `u_${crypto.randomUUID().slice(0, 10)}`;
  await grantCredits(db, { userId, amount: credits, idemKey: `g:${userId}`, source: 'test' });
  return userId;
}

const post = (body: unknown) =>
  new Request(`${BASE}/api/jobs`, { method: 'POST', body: JSON.stringify(body) });

async function created(response: Response) {
  const { job } = (await response.json()) as { job: { id: string } };
  return (await loadJob(db, job.id))!;
}

describe('music models', () => {
  it('take no references and no effect', () => {
    expect(() => defineModels([{ ...song, maxReferences: 1 }])).toThrow(/no references/);
    expect(() => defineModels([{ ...song, effect: { slots: [], segments: [] } }])).toThrow(/no effect/);
  });

  it('settle exactly one lyrics source', () => {
    expect(musicParameters({ instrumental: true, lyrics_optimizer: true }, '歌詞')).toEqual({});
    expect(musicParameters({ instrumental: true, lyrics_optimizer: true }, undefined)).toEqual({
      instrumental: true,
    });
    expect(musicParameters({ instrumental: false }, undefined)).toEqual({ lyrics_optimizer: true });
  });
});

describe('creating a music job', () => {
  it('stores the lyrics and the style prompt, charges once, dispatches once', async () => {
    const userId = await userWith(3);
    const { jobs, dispatched } = fakeCore(userId);
    const response = await jobs.create(
      post({
        modelId: 'song',
        prompt: 'J-POP, 明るい',
        lyrics: '  [Verse]\n夏の空  ',
        parameters: { instrumental: true },
      }),
    );
    expect(response.status).toBe(201);
    const job = await created(response);
    expect(job).toMatchObject({ kind: 'music', prompt: 'J-POP, 明るい', costCredits: 1, status: 'queued' });
    expect(JSON.parse(job.inputJson)).toEqual({ references: [], parameters: {}, lyrics: '[Verse]\n夏の空' });
    expect(dispatched).toEqual([job.id]);
    expect((await getBalance(db, userId)).available).toBe(2);
  });

  it('without lyrics asks the model to write them; an instrumental asks for none', async () => {
    const userId = await userWith(3);
    const { jobs } = fakeCore(userId);
    const written = await created(
      await jobs.create(post({ modelId: 'song', prompt: 'ballad', lyrics: '   ' })),
    );
    expect(JSON.parse(written.inputJson)).toEqual({ references: [], parameters: { lyrics_optimizer: true } });
    const instrumental = await created(
      await jobs.create(post({ modelId: 'song', prompt: 'lofi', parameters: { instrumental: true } })),
    );
    expect(JSON.parse(instrumental.inputJson)).toEqual({
      references: [],
      parameters: { instrumental: true },
    });
  });

  it('rejects bad lyrics before charging', async () => {
    const userId = await userWith(3);
    const { jobs, dispatched } = fakeCore(userId);
    for (const lyrics of ['あ'.repeat(MAX_LYRICS + 1), 42]) {
      const response = await jobs.create(post({ modelId: 'song', prompt: 'p', lyrics }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_lyrics' } });
    }
    expect(dispatched).toEqual([]);
    expect((await getBalance(db, userId)).available).toBe(3);
  });

  it('a guest job keeps the lyrics and costs no credits', async () => {
    const { jobs } = fakeCore(null);
    const job = await created(await jobs.create(post({ modelId: 'song', prompt: 'rock', lyrics: '叫べ' })));
    expect(job).toMatchObject({ guestId: 'g_music', costCredits: 0, kind: 'music' });
    expect(JSON.parse(job.inputJson).lyrics).toBe('叫べ');
  });

  it('insufficient credits: 402, no job, nothing dispatched', async () => {
    const userId = await userWith(1);
    const { jobs, dispatched } = fakeCore(userId);
    await created(await jobs.create(post({ modelId: 'song', prompt: 'a' })));
    const response = await jobs.create(post({ modelId: 'song', prompt: 'b' }));
    expect(response.status).toBe(402);
    expect(dispatched).toHaveLength(1);
    expect((await getBalance(db, userId)).available).toBe(0);
  });
});

describe('running a music job', () => {
  async function queued(lyrics?: string) {
    const userId = await userWith(3);
    const { jobs } = fakeCore(userId);
    const job = await created(await jobs.create(post({ modelId: 'song', prompt: 'city pop', lyrics })));
    return { userId, job };
  }
  const deps = (adapter: FakeAdapter) => ({
    db,
    bucket: bucket,
    models,
    adapters: { yir: adapter },
    fetcher: mp3Fetcher,
  });

  it('submits music with lyrics and the cost cap, stores both tracks as mp3, keeps the charge', async () => {
    const { userId, job } = await queued('[Chorus]\nラララ');
    const adapter = new FakeAdapter();
    const done = {
      state: 'succeeded' as const,
      files: [
        { url: 'https://up/a.mp3', mediaType: 'audio/mpeg' },
        { url: 'https://up/b.mp3', mediaType: 'audio/mpeg' },
      ],
    };
    adapter.polls = [{ state: 'running' }, done];
    await runGeneration(deps(adapter), job.id, steps);
    expect(adapter.submits).toEqual([
      {
        key: job.id,
        input: {
          upstreamModel: 'suno/suno-v6',
          kind: 'music',
          prompt: 'city pop',
          lyrics: '[Chorus]\nラララ',
          references: [],
          parameters: {},
          maxCost: '0.12',
        },
      },
    ]);
    const finished = (await loadJob(db, job.id))!;
    expect(finished.status).toBe('succeeded');
    expect(JSON.parse(finished.outputsJson!)).toEqual([
      { key: `jobs/${job.id}/0.mp3`, mediaType: 'audio/mpeg' },
      { key: `jobs/${job.id}/1.mp3`, mediaType: 'audio/mpeg' },
    ]);
    expect(await bucket.get(`jobs/${job.id}/1.mp3`)).not.toBeNull();
    expect((await getBalance(db, userId)).available).toBe(2);

    // A replayed Workflow neither resubmits nor charges again.
    adapter.polls = [done];
    await runGeneration(deps(adapter), job.id, steps);
    expect(adapter.submits).toHaveLength(1);
    expect((await getBalance(db, userId)).available).toBe(2);
  });

  it('stores songs without the provider ID3 tags', async () => {
    const { job } = await queued();
    const tagged = new Uint8Array([...id3v2('made with vendor; id=abc'), 0xff, 0xfb, 0x90, 0x64]);
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'succeeded', files: [{ url: 'https://up/a.mp3', mediaType: 'audio/mpeg' }] }];
    const fetcher: typeof fetch = async () =>
      new Response(tagged, { headers: { 'content-type': 'audio/mpeg' } });
    await runGeneration({ ...deps(adapter), fetcher }, job.id, steps);
    const stored = await bucket.get(`jobs/${job.id}/0.mp3`);
    expect([...new Uint8Array(await stored!.arrayBuffer())]).toEqual([0xff, 0xfb, 0x90, 0x64]);
  });

  it('upstream failure refunds once, even when settled again', async () => {
    const { userId, job } = await queued();
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'failed', code: 'YIR_CONTENT_REJECTED', message: 'lyrics rejected' }];
    await runGeneration(deps(adapter), job.id, steps);
    expect(adapter.submits[0]!.input).toMatchObject({ parameters: { lyrics_optimizer: true } });
    expect(adapter.submits[0]!.input.lyrics).toBeUndefined();
    await runGeneration(deps(adapter), job.id, steps);
    expect(await loadJob(db, job.id)).toMatchObject({ status: 'failed', errorCode: 'YIR_CONTENT_REJECTED' });
    expect((await getBalance(db, userId)).available).toBe(3);
  });

  it('the finish email calls it a song', async () => {
    const { userId, job } = await queued();
    await db.insert(user).values({ id: userId, name: 'U', email: `${userId}@example.com` });
    const sent: { subject: string }[] = [];
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'succeeded', files: [{ url: 'https://up/a.mp3', mediaType: 'audio/mpeg' }] }];
    const notify = emailOnFinish({
      db,
      email: {
        send: async (message: { subject: string }) => void sent.push(message),
      } as unknown as SendEmail,
      from: 'no-reply@music.test',
      site: { name: 'Music', defaultLocale: 'en' },
      baseURL: BASE,
    });
    await runGeneration({ ...deps(adapter), notify }, job.id, steps);
    expect(sent.map((message) => message.subject)).toEqual(['Your Music song is ready']);
  });

  it('a Japanese site sends the finish emails in Japanese', async () => {
    const sent: { subject: string; text: string }[] = [];
    const notify = emailOnFinish({
      db,
      email: {
        send: async (message: { subject: string; text: string }) => void sent.push(message),
      } as unknown as SendEmail,
      from: 'no-reply@music.test',
      site: { name: 'AI作曲', defaultLocale: 'ja' },
      baseURL: BASE,
    });
    const ok = await queued();
    await db.insert(user).values({ id: ok.userId, name: 'U', email: `${ok.userId}@example.com` });
    const adapter = new FakeAdapter();
    adapter.polls = [{ state: 'succeeded', files: [{ url: 'https://up/a.mp3', mediaType: 'audio/mpeg' }] }];
    await runGeneration({ ...deps(adapter), notify }, ok.job.id, steps);

    const bad = await queued();
    await db.insert(user).values({ id: bad.userId, name: 'U', email: `${bad.userId}@example.com` });
    const failing = new FakeAdapter();
    failing.polls = [{ state: 'failed', code: 'YIR_EXECUTION_FAILED', message: 'down' }];
    await runGeneration({ ...deps(failing), notify }, bad.job.id, steps);

    expect(sent.map((message) => message.subject)).toEqual([
      'AI作曲：曲ができました',
      'AI作曲：曲を作れませんでした',
    ]);
    expect(sent[0]!.text).toContain(`${BASE}/files/jobs/${ok.job.id}/0.mp3`);
    expect(sent[1]!.text).toContain(`使った${bad.job.costCredits}クレジットはアカウントに戻っています`);
  });
});

describe('Yir music requests', () => {
  const input: SubmitInput = {
    upstreamModel: 'minimax/music-2.6',
    kind: 'music',
    prompt: 'folk',
    lyrics: '[Verse]\n道',
    references: [],
    parameters: {},
    maxCost: '0.2',
  };

  it('sends text input with the lyrics, or without them when the model writes them', () => {
    expect(buildYirRequest(input)).toEqual({
      model: 'minimax/music-2.6',
      parameters: {},
      max_cost: '0.2',
      input: { type: 'text', prompt: 'folk', lyrics: '[Verse]\n道' },
    });
    const { lyrics: _, ...noLyrics } = input;
    expect(buildYirRequest({ ...noLyrics, parameters: { lyrics_optimizer: true } })).toMatchObject({
      parameters: { lyrics_optimizer: true },
      input: { type: 'text', prompt: 'folk' },
    });
    expect(() =>
      buildYirRequest({ ...input, references: [{ url: 'https://x/a.png', role: 'reference_image' }] }),
    ).toThrow(/no references/);
  });

  it('goes through submitMusic with the job id as idempotency key', async () => {
    const calls: { request: unknown; key: string }[] = [];
    const client = {
      submitMusic: async (request: unknown, key: string) => {
        calls.push({ request, key });
        return { id: 'yir_job_1' };
      },
    };
    const adapter = new YirAdapter({ apiKey: 'k' }, client as never);
    expect(await adapter.submit(input, 'job_1')).toEqual({ upstreamJobId: 'yir_job_1' });
    expect(calls).toEqual([{ request: buildYirRequest(input), key: 'job_1' }]);
  });
});

describe('mock music', () => {
  it('returns the site mock-output.mp3', async () => {
    const adapter = new MockAdapter('succeed', { image: 0, video: 0 }, 'http://localhost:3000');
    const job = await adapter.submit({
      ...{ upstreamModel: 'm', prompt: 'p', references: [], parameters: {} },
      kind: 'music',
    });
    expect(await adapter.poll(job.upstreamJobId)).toEqual({
      state: 'succeeded',
      files: [{ url: 'http://localhost:3000/mock-output.mp3', mediaType: 'audio/mpeg' }],
    });
  });
});
