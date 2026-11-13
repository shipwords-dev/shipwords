// Local mock: no upstream calls, no compose container, only fake outputs; for testing site flows (upload, charge, polling, storage, output, refund).
// Only enabled when UPSTREAM_MOCK is set and either APP_URL points to localhost or every payment credential is in test mode
// (a public demo), so a deploy that can take real money never serves fake outputs.
// UPSTREAM_MOCK=1: everything succeeds; UPSTREAM_MOCK=fail: every segment fails (to test refunds).

import type { Composer } from './compose';
import type { PollResult, SubmitInput, UpstreamAdapter } from './upstream';

export type MockMode = 'succeed' | 'fail';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

interface MockEnv {
  UPSTREAM_MOCK?: string;
  APP_URL?: string;
  STRIPE_SECRET_KEY?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_ENV?: string;
}

export function mockMode(env: MockEnv): MockMode | null {
  if (!env.UPSTREAM_MOCK || !env.APP_URL) return null;
  let host: string;
  try {
    host = new URL(env.APP_URL).hostname;
  } catch {
    return null;
  }
  const local = LOCAL_HOSTS.includes(host) || host.endsWith('.localhost');
  if (!local && !paymentsInTestMode(env)) return null;
  return env.UPSTREAM_MOCK === 'fail' ? 'fail' : 'succeed';
}

/** At least one test-mode payment credential and no live one. */
function paymentsInTestMode(env: MockEnv): boolean {
  const stripeTest = /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? '');
  const stripeLive = !!env.STRIPE_SECRET_KEY && !stripeTest;
  const paypalTest = !!env.PAYPAL_CLIENT_ID && env.PAYPAL_ENV === 'sandbox';
  const paypalLive = !!env.PAYPAL_CLIENT_ID && env.PAYPAL_ENV !== 'sandbox';
  return !stripeLive && !paypalLive && (stripeTest || paypalTest);
}

/** The fake task's whole state is encoded in its ID: no storage needed, replays and repeated polls agree. */
interface MockJob {
  url: string;
  mediaType: string;
  readyAt: number;
}

const PREFIX = 'mock_';

/**
 * Fake upstream: image tasks return the first reference image (a prep segment gets the user's original photo), video tasks return the segment's reference video.
 * A text-only task has nothing to echo back, so it returns a file from siteUrl: public/mock-output.png for images, public/mock-output.mp3
 * for music (see createAdapters). Output only "arrives" a few seconds after submit, so the page can show the in-progress state;
 * music takes the video delay.
 */
export class MockAdapter implements UpstreamAdapter {
  readonly name = 'mock';

  constructor(
    private readonly mode: MockMode,
    private readonly delayMs = { image: 3_000, video: 10_000 },
    private readonly siteUrl = '',
  ) {}

  async submit(input: SubmitInput) {
    if (input.kind === 'music') {
      const job: MockJob = {
        url: this.siteUrl && `${this.siteUrl}/mock-output.mp3`,
        mediaType: 'audio/mpeg',
        readyAt: Date.now() + this.delayMs.video,
      };
      return { upstreamJobId: PREFIX + btoa(JSON.stringify(job)) };
    }
    const role = input.kind === 'video' ? 'reference_video' : 'reference_image';
    const fallback = this.siteUrl && `${this.siteUrl}/mock-output.png`;
    const url =
      input.references.find((ref) => ref.role === role)?.url ?? input.references[0]?.url ?? fallback;
    const job: MockJob = {
      url,
      mediaType: input.kind === 'video' ? 'video/mp4' : mediaTypeOf(url),
      readyAt: Date.now() + this.delayMs[input.kind],
    };
    return { upstreamJobId: PREFIX + btoa(JSON.stringify(job)) };
  }

  async poll(upstreamJobId: string): Promise<PollResult> {
    const job = JSON.parse(atob(upstreamJobId.slice(PREFIX.length))) as MockJob;
    if (Date.now() < job.readyAt) return { state: 'running' };
    if (this.mode === 'fail') return { state: 'failed', code: 'mock_failed', message: 'UPSTREAM_MOCK=fail' };
    if (!job.url) return { state: 'failed', code: 'mock_no_reference', message: 'no reference to echo back' };
    return { state: 'succeeded', files: [{ url: job.url, mediaType: job.mediaType }] };
  }

  async cancel() {}
}

function mediaTypeOf(url: string): string {
  const ext = url.split('?')[0]!.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

/**
 * Fake compose: no stitching, the output is just the first rendered segment (or the first base clip if none rendered); swap checks always pass.
 * With fixed (R2 keys, set by UPSTREAM_MOCK_RESULT on a public demo) every job returns the same finished video instead.
 */
export function mockComposer(bucket: R2Bucket, fixed?: { song: string; silent: string }): Composer {
  async function read(key: string) {
    const object = await bucket.get(key);
    if (!object) throw new Error(`mock result missing: ${key}`);
    return object.arrayBuffer();
  }
  return {
    async splitSheet(input) {
      return Array.from({ length: 4 }, () => input.image.slice(0));
    },
    async compose(input) {
      if (fixed) return { song: await read(fixed.song), silent: await read(fixed.silent) };
      const first = input.segments.find((segment) => segment.key.startsWith('jobs/')) ?? input.segments[0];
      const object = first ? await bucket.get(first.key) : null;
      if (!object) throw new Error(`mock compose input missing: ${first?.key}`);
      const bytes = await object.arrayBuffer();
      return { song: bytes, silent: bytes.slice(0) };
    },
    async faces(input) {
      return input.points.map(() => 0);
    },
    async likeness(input) {
      return input.people.map(() => null);
    },
    // Never reached while faces always passes; kept as plain copies so the interface is complete.
    async extract(input) {
      return read(input.key);
    },
    async patch(input) {
      const bytes = await read(input.key);
      return { song: bytes, silent: bytes.slice(0) };
    },
  };
}
