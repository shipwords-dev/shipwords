// Cross-layer regression for the release gate, starting from this site's actual configuration (site.models.ts + src/models.server.ts):
// first through the engine's real job planner (effectParts) and the runner's own request builder (partInput; prep placeholders become
// preflightUrl as in the preflight), then through the real order API (createJobs) and the real runner (runGeneration: prep, describe,
// Kling, swap check, repair, likeness, compose). Every request bound for the upstream goes to the Yir adapter's validate, the same function
// the live preflight uses (buildYirRequest plus local validation by the lockfile's @yir-ai/sdk).
// The upstream and the compose service are fakes that only record and validate: no paid generation starts. The SDK checks structure
// only, which does not guarantee the upstream accepts it; models, image counts, roles and parameters are pinned by assertions.
import { getBalance, grantCredits } from '@shipwords/core/credits/ledger';
import type { Core } from '@shipwords/core/server';
import type { Composer, LikenessInput } from '@shipwords/jobs/compose';
import { createJobs } from '@shipwords/jobs/handlers';
import { loadJob } from '@shipwords/jobs/lifecycle';
import { effectParts, PREP_REF } from '@shipwords/jobs/models';
import { judgeLikeness, likenessAsks, nextRepairPass, repairInput } from '@shipwords/jobs/repair';
import { partInput, preflightUrl, runGeneration, type StepRunner } from '@shipwords/jobs/runner';
import { memoryStore } from '@shipwords/jobs/store';
import type { PollResult, SubmitInput, UpstreamAdapter } from '@shipwords/jobs/upstream';
import { YirAdapter } from '@shipwords/jobs/yir';
import { describe, expect, it } from 'vitest';
import models, { ROLE } from '../src/models.server';
import { db } from './db';

const base = 'https://tinydeskai.example.com';
const FILES = `${base}/files/`;
const SEATS = ['lead', 'sax', 'keys', 'backLeft', 'backRight'] as const;
type Seat = (typeof SEATS)[number];
const yir = new YirAdapter({ apiKey: '' });
const model = models.find((m) => m.id === 'tiny-desk')!;
const segment = model.effect!.segments[0]!;
const repair = segment.repair!;
const cents = (usd: string | undefined) => Math.round(Number(usd ?? 0) * 100);

/** Every non-empty choice of seats, in seat order (31). */
const combos = () =>
  Array.from({ length: (1 << SEATS.length) - 1 }, (_, i) => SEATS.filter((_, s) => (i + 1) & (1 << s)));

const planned = (slots: Record<string, unknown>) =>
  effectParts(
    model,
    slots,
    (ref) => (typeof ref === 'string' ? `${FILES}${ref}` : null),
    (key) => `${FILES}${key}`,
  );
// Same as the runner's preflight: prep placeholders become stand-in URLs of the same shape, other URLs stay.
const preflight = (url: string) => (url.startsWith(PREP_REF) ? preflightUrl(url) : url);
const request = (part: Parameters<typeof partInput>[0], descriptions?: Record<string, string>) =>
  partInput(part, model, preflight, FILES, descriptions);

describe('planner and request builder (static, every seat combination)', () => {
  it('every seat combination: real planner and request builder, validated by the installed Yir SDK', () => {
    expect(model).toBeTruthy();
    let checked = 0;
    for (const chosen of combos()) {
      const label = chosen.join(',');
      const parts = planned(Object.fromEntries(chosen.map((seat) => [seat, `uploads/${seat}.jpg`])));
      expect(parts, label).toBeTruthy();
      // Two prep images per person (paid subtasks): the two-panel one for Kling, the face for repair and likeness; plus one whole-clip video task.
      const prep = parts!.filter((part) => part.kind === 'image');
      const videos = parts!.filter((part) => part.kind !== 'image');
      expect(
        prep.map((part) => part.id),
        label,
      ).toEqual(chosen.flatMap((seat) => [`prep-${seat}`, `prep-${seat}-v1`]));
      for (const part of prep) {
        expect(!part.prepSheet && part.maxCost === '0.015' && part.parameters.aspect_ratio === '3:2').toBe(
          true,
        );
        expect(part.prompt).toContain(part.id.endsWith('-v1') ? 'chest-up portrait' : '1 by 2');
        // Prep subtasks go through the same validation (so does the live preflight).
        expect(() => yir.validate(request(part)), `${label}: ${part.id}`).not.toThrow();
      }
      expect(videos, label).toHaveLength(1);
      const video = videos[0]!;
      expect(video.upstreamModel).toBe('klingai/kling-4.0');
      expect(video.maxCost).toBe('3.40');
      const input = request(video, video.describe ? {} : undefined);
      // One image per person: one reference clip, exactly one reference image (two-panel) per person, no subjects, in seat order.
      expect(
        input.references.filter((ref) => ref.role === 'reference_video'),
        label,
      ).toHaveLength(1);
      const images = input.references.filter((ref) => ref.role === 'reference_image');
      expect(images.every((ref) => !('subject' in ref) || !ref.subject)).toBe(true);
      expect(images.map((ref) => ref.url)).toEqual(chosen.map((seat) => preflightUrl(`prep:${seat}`)));
      const { prompt } = input;
      expect(prompt).not.toMatch(/[{}]|prep:|@image\d|@[A-Z]/);
      // Seats are @image_1… in order, each with its time span and position; the lead is alone in the close-up with no instrument; unfilled seats stay as in the original.
      for (const [i, seat] of chosen.entries()) expect(prompt).toContain(`${ROLE[seat]} is @image_${i + 1}.`);
      expect(prompt.includes('alone in that close-up')).toBe(chosen.includes('lead'));
      expect(prompt.includes('in the centre of both wide shots')).toBe(chosen.includes('keys'));
      expect(prompt.includes('exactly as in @video_1.')).toBe(chosen.length < SEATS.length);
      expect(prompt).toContain('No replaced performer has the face of a performer from @video_1');
      expect(prompt).toContain('do not add the lead singer or any other new person to them');
      expect(prompt.includes('camera movement') && prompt.includes('video duration')).toBe(true);
      expect(prompt, `${label}: every sentence starts with a capital`).not.toMatch(/\. [a-z]/);
      expect(() => yir.validate(input), label).not.toThrow();
      // With every description at the 200-character maximum, the prompt stays under Kling 4.0's 10,000-character limit and still validates.
      const longest = request(video, Object.fromEntries(chosen.map((seat) => [seat, 'x'.repeat(200)])));
      expect(longest.prompt.length).toBeLessThan(10000);
      expect(() => yir.validate(longest), `${label}: described`).not.toThrow();
      checked++;
    }
    expect(checked).toBe(31);
    // Repair and likeness use the second prep image (front chest-up); Kling gets only the two-panel image; a slow prep gets no hedge copy.
    expect(repair.photoView).toBe(1);
    expect(model.effect!.prep!.hedge).toBe(false);
    // The order's original photos get a private copy when the job starts (the privacy policy says so).
    expect(model.keepUploads).toBe(true);
    expect(model.effect!.slots.every((slot) => Array.isArray(slot.prep) && slot.prep.length === 2)).toBe(
      true,
    );
  });

  it('repair passes: one person per pass over their fixed shots, official prompt, validated by the installed Yir SDK', () => {
    // Which shots each person appears in is fixed: 0 wide, 1 lead close-up, 2 sax close-up, 3 wide.
    const groups: Record<Seat, number[][]> = {
      lead: [[1]],
      sax: [[2]],
      keys: [[0, 3], [2]],
      backLeft: [[0, 3]],
      backRight: [[0, 3]],
    };
    expect(repair.crops, 'no crop passes: a whole-frame result replaces the frames').toBeUndefined();
    expect(repair.rounds === 5 && repair.onMiss === 'deliver' && repair.photoView === 1).toBe(true);
    let checked = 0;
    for (const filled of combos()) {
      for (const seat of filled) {
        for (const kind of ['person', 'pet'] as const) {
          const label = `${filled.join(',')}: ${seat} (${kind})`;
          const kinds = Object.fromEntries(filled.map((s) => [s, s === seat ? kind : 'person'] as const));
          // Repair order when someone was missed (or looks unlike the photo): each group of shots they appear in, whole frames, one person and one photo per pass.
          const done: ReturnType<typeof nextRepairPass>[] = [];
          for (const shots of groups[seat]) {
            const pass = nextRepairPass(repair, filled, [seat], done as never);
            expect(pass, label).toEqual({ slots: [seat], shots });
            done.push(pass);
            const input = repairInput(
              repair,
              pass!,
              kinds,
              `${FILES}jobs/job_x/repair-full-${done.length - 1}.mp4`,
              [preflightUrl(`prep:${seat}-v1`)],
              done.length - 1,
            );
            expect(input.upstreamModel).toBe('pruna/p-video-replace');
            expect(input.maxCost).toBe('0.40');
            expect(input.references.map((ref) => ref.role)).toEqual(['reference_video', 'reference_image']);
            expect(input.prompt).toMatch(
              /^Replace the .+ with the (person|animal) from reference image 1\. Keep lip sync, motion, audio, and camera from the source video\. Do not change anyone else or the background\.$/,
            );
            expect(input.prompt).toContain(`with the ${kind === 'pet' ? 'animal' : 'person'} from`);
            // Keys shows only half a face in the sax close-up's lower right, so that pass names the corner; the wide-shot pass names the front center.
            if (seat === 'keys')
              expect(input.prompt).toContain(
                shots.includes(2)
                  ? 'partly visible in the lower right corner'
                  : 'sitting at the front center',
              );
            expect(() => yir.validate(input), label).not.toThrow();
            checked++;
          }
        }
      }
    }
    // 31 combinations × each chosen person × person or pet, with one pass per shot group for keys.
    expect(checked).toBe(2 * (80 + 16));
    // Worst case: every pass at its cap, plus Kling and prep, still within the job cap.
    expect(
      cents(segment.maxCost) +
        repair.rounds * cents(repair.maxCost) +
        10 * cents(model.effect!.prep!.maxCost),
    ).toBeLessThanOrEqual(cents(model.maxCost));
  });

  it('pets: a dog on the stage gets the animal sentence and still validates', () => {
    const slots: Record<string, unknown> = Object.fromEntries(
      SEATS.map((seat) => [seat, `uploads/${seat}.jpg`]),
    );
    slots.backLeft = { photo: 'uploads/dog.jpg', kind: 'pet' };
    const video = planned(slots)!.find((part) => part.kind !== 'image')!;
    const input = request(video, {});
    expect(input.prompt).toContain('@image_4 is an animal and becomes that animal completely');
    expect(input.prompt).toContain('@image_1, @image_2, @image_3 and @image_5 are people');
    expect(() => yir.validate(input)).not.toThrow();
  });

  it('likeness: lead and wide-shot keys, scored on the face in their spot; pets skipped; within the compose service limit', () => {
    const fps = model.effect!.compose!.fps;
    // Thresholds from replaying stored outputs on 11-18: lead 0.40; keys 0.35 in the two wide shots only, not the sax close-up's corner.
    expect(repair.likeness).toEqual({ lead: 0.4, keys: { min: 0.35, shots: [0, 3] } });
    const wide = [
      [0.395, 0.496],
      [0.073, 0.204],
      [0.859, 0.224],
    ];
    let checked = 0;
    for (const chosen of combos()) {
      for (const pet of [null, ...chosen]) {
        const label = `${chosen.join(',')}${pet ? ` (${pet} is a pet)` : ''}`;
        const slots = Object.fromEntries(
          chosen.map((seat) => [
            seat,
            seat === pet ? { photo: `uploads/${seat}.jpg`, kind: 'pet' } : `uploads/${seat}.jpg`,
          ]),
        );
        // Through the real planner: in production the engine reads slots and kinds from the job's part.
        const part = planned(slots)!.find((candidate) => candidate.kind !== 'image')!;
        const asks = likenessAsks(segment as never, fps, part.slots ?? [], part.kinds ?? {});
        const people = chosen.filter((seat) => seat !== pet);
        expect(
          asks.map(({ slot }) => slot),
          label,
        ).toEqual(['lead', 'keys'].filter((seat) => people.includes(seat as Seat)));
        for (const ask of asks) {
          expect(ask.photos).toEqual([ask.slot, ...people.filter((seat) => seat !== ask.slot)]);
          if (ask.slot === 'lead') {
            expect(ask.min).toBe(0.4);
            expect(ask.ranges).toEqual([[128 / fps, 279 / fps]]);
            expect(ask.spots).toEqual([[[0.793, 0.323]]]);
          } else {
            // One range for each wide shot, both with the three people's spots, keys first; the sax close-up (frames 279–360) does not count.
            expect(ask.min).toBe(0.35);
            expect(ask.ranges).toEqual([
              [0, 128 / fps],
              [360 / fps, 425 / fps],
            ]);
            expect(ask.spots).toEqual([wide, wide]);
          }
        }
        // The compose service takes at most 10 photos per call.
        expect(asks.reduce((sum, ask) => sum + ask.photos.length, 0)).toBeLessThanOrEqual(10);
        checked++;
      }
    }
    expect(checked).toBe(31 + 80);
    // Keys scoring 0.24 on a stored Kling output is repaired; 0.37 after repair passes; a seat counts as swapped with someone else only when another photo scores over 0.2 higher.
    const asks = likenessAsks(segment as never, fps, [...SEATS], {});
    const scores = (lead: number, keys: number) => [lead, 0.1, 0.1, 0.1, 0.1, keys, 0.1, 0.1, 0.1, 0.1];
    expect(judgeLikeness(asks, scores(0.62, 0.24)).missed).toEqual(['keys']);
    expect(judgeLikeness(asks, scores(0.44, 0.37)).missed).toEqual([]);
  });
});

// ---- The real order path: createJobs → runGeneration, with a checked fake upstream and a fake compose service ----

/** Records and validates what the runner would send; every task succeeds with one output. */
class CheckedUpstream implements UpstreamAdapter {
  readonly name = 'yir';
  readonly submits: { input: SubmitInput; key: string }[] = [];
  private kinds = new Map<string, SubmitInput['kind']>();
  validate(input: SubmitInput) {
    yir.validate(input);
  }
  async submit(input: SubmitInput, key: string) {
    yir.validate(input);
    this.submits.push({ input, key });
    const id = `up_${this.submits.length}`;
    this.kinds.set(id, input.kind);
    return { upstreamJobId: id };
  }
  async poll(id: string): Promise<PollResult> {
    const video = this.kinds.get(id) === 'video';
    return {
      state: 'succeeded',
      files: [
        {
          url: `https://cdn.example/${id}.${video ? 'mp4' : 'png'}`,
          mediaType: video ? 'video/mp4' : 'image/png',
        },
      ],
    };
  }
  async cancel() {}
}

// A 1x1 PNG, tagged after its end with the upstream task that made it.
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);
const tagged = (tag: string) => new Uint8Array([...PNG, ...new TextEncoder().encode(`#${tag}#`)]);
const fetcher = (async (url: string | URL | Request) => {
  const href = String(url instanceof Request ? url.url : url);
  const id = href
    .split('/')
    .pop()!
    .replace(/\.\w+$/, '');
  return href.endsWith('.mp4')
    ? new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
        headers: { 'content-type': 'video/mp4' },
      })
    : new Response(tagged(id), { headers: { 'content-type': 'image/png' } });
}) as typeof fetch;

const store = memoryStore();
/** Which seat a check point belongs to, from the site's own check config. */
const faces = segment.check!.faces as Record<Seat, number[] | number[][]>;
function seatOf(point: readonly number[]): Seat {
  for (const seat of SEATS) {
    const points = (Array.isArray(faces[seat]![0]) ? faces[seat] : [faces[seat]]) as number[][];
    if (points.some((p) => p[0] === point[0] && p[1] === point[1])) return seat;
  }
  throw new Error(`unknown check point ${point}`);
}

/**
 * The compose service's answers. missed: per swap check (in call order), the seats whose original face is still there; the last entry
 * repeats. likeness: the own-photo score per seat (others score 0.1).
 */
class FakeComposer implements Composer {
  checks = 0;
  readonly calls: string[] = [];
  readonly likenessInputs: LikenessInput[] = [];
  constructor(
    private readonly missed: Seat[][] = [[]],
    private readonly likeness: Partial<Record<Seat, number>> = {},
  ) {}
  async splitSheet(): Promise<ArrayBuffer[]> {
    throw new Error('no prep sheets on this site');
  }
  async compose() {
    this.calls.push('compose');
    return { song: new Uint8Array([1]).buffer, silent: new Uint8Array([2]).buffer };
  }
  async faces(input: { points: readonly (readonly number[])[] }) {
    this.calls.push('faces');
    const missed = this.missed[Math.min(this.checks++, this.missed.length - 1)]!;
    return input.points.map((point) => (missed.includes(seatOf(point)) ? 0.9 : 0.2));
  }
  async likeness(input: LikenessInput) {
    this.calls.push('likeness');
    this.likenessInputs.push(input);
    // Own photo first in each ask (likenessAsks), the others after it: a new group starts where the ranges change.
    let previous = '';
    let seat = 0;
    const order = likenessOrder(input);
    return input.people.map((person) => {
      const ranges = JSON.stringify(person.ranges);
      const own = ranges !== previous;
      previous = ranges;
      if (own) return this.likeness[order[seat++]!] ?? null;
      return 0.1;
    });
  }
  async extract() {
    this.calls.push('extract');
    return new Uint8Array([3]).buffer;
  }
  async patch() {
    this.calls.push('patch');
    return { song: new Uint8Array([4]).buffer, silent: new Uint8Array([5]).buffer };
  }
}
/** Seats of the likeness asks in call order: lead before keys, as likenessAsks lists them. */
let likenessOrder: (input: LikenessInput) => Seat[] = () => [];

const steps: StepRunner = { do: (_name, fn) => fn({ attempt: 1 }), sleep: async () => {} };

async function order(chosen: readonly Seat[], composer: FakeComposer, pet?: Seat) {
  const userId = crypto.randomUUID();
  await grantCredits(db, { userId, amount: 10, idemKey: userId, source: 'test' });
  const tag = userId.replaceAll('-', '');
  const photos = Object.fromEntries(
    chosen.map((seat) => [seat, `/files/uploads/up_${seat.toLowerCase()}${tag}.jpg`]),
  );
  for (const photo of Object.values(photos))
    await store.put(photo.slice('/files/'.length), 'jpg', { contentType: 'image/jpeg' });
  // A live site's environment: no mock, real file origin.
  const core = {
    db,
    site: { id: 'tinydeskaiex', url: base },
    env: { APP_URL: base },
    getUser: async () => ({ id: userId }),
    log: () => {},
  } as unknown as Core;
  const jobs = createJobs(core, models, { store });
  const response = await jobs.create(
    new Request(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelId: 'tiny-desk',
        slots: Object.fromEntries(
          chosen.map((seat) => [seat, seat === pet ? { photo: photos[seat], kind: 'pet' } : photos[seat]]),
        ),
      }),
    }),
  );
  expect(response.status).toBeLessThan(300);
  const { job } = (await response.json()) as { job: { id: string } };
  const upstream = new CheckedUpstream();
  const described: string[] = [];
  const asked: { instruction: string; model?: string }[] = [];
  likenessOrder = () => (['lead', 'keys'] as Seat[]).filter((seat) => chosen.includes(seat) && seat !== pet);
  await runGeneration(
    {
      db,
      bucket: store,
      models,
      adapters: { yir: upstream },
      composer,
      fetcher,
      fileUrl: (key) => `${FILES}${key}`,
      describe: async (url, instruction, model) => {
        described.push(url);
        asked.push({ instruction, model });
        return 'a person in a red jersey with the number 7';
      },
    },
    job.id,
    steps,
  );
  const row = await loadJob(db, job.id);
  return { jobId: job.id, userId, photos, upstream, described, asked, row: row! };
}

describe('generation contract: site config → real order handler and runner → Yir SDK validation', () => {
  it('every seat combination: paid tasks, the Kling request, descriptions, private upload copies and the charge', async () => {
    for (const chosen of combos()) {
      const label = chosen.join(',');
      const composer = new FakeComposer();
      const { jobId, userId, photos, upstream, described, asked, row } = await order(chosen, composer);
      expect(row.status, label).toBe('succeeded');
      expect((await getBalance(db, userId)).available, label).toBe(0);
      const sent = upstream.submits.map((s) => s.input);
      // Paid tasks: two prep images per person (pair sheet for Kling, chest-up portrait for repair and likeness), one Kling edit.
      expect(
        sent.map((s) => s.upstreamModel),
        label,
      ).toEqual([
        ...chosen.flatMap(() => ['openai/gpt-image-2.5-sunburst', 'openai/gpt-image-2.5-sunburst']),
        'klingai/kling-4.0',
      ]);
      const prep = sent.slice(0, -1);
      for (const [i, input] of prep.entries()) {
        const seat = chosen[Math.floor(i / 2)]!;
        expect(input).toMatchObject({
          kind: 'image',
          maxCost: '0.015',
          parameters: { resolution: '1K', aspect_ratio: '3:2' },
        });
        // Each prep task edits that seat's own upload, nobody else's.
        expect(
          input.references.map((r) => [r.role, r.url]),
          `${label}: prep ${i}`,
        ).toEqual([['reference_image', `${base}${photos[seat]}`]]);
        expect(input.prompt).toContain(i % 2 === 0 ? '1 by 2' : 'chest-up portrait');
      }
      const kling = sent.at(-1)!;
      expect(kling).toMatchObject({
        kind: 'video',
        maxCost: '3.40',
        parameters: { duration: 18, resolution: '720p' },
      });
      expect(kling.references.map((r) => r.role)).toEqual([
        'reference_video',
        ...chosen.map(() => 'reference_image'),
      ]);
      expect(kling.references[0]!.url).toBe(`${FILES}assets/tinydesk/full-17s.mp4`);
      // Each image is that seat's pair sheet (its first prep task: up_1, up_3, …) as the upstream returned it, in seat order.
      const images = kling.references.slice(1);
      expect(images.map((ref) => ref.url)).toEqual(
        chosen.map((_, i) => `https://cdn.example/up_${2 * i + 1}.png`),
      );
      // Descriptions come from the pair sheet (describe.view 0), one per person, and go into the prompt after each image name.
      expect(described, label).toEqual(images.map((ref) => ref.url));
      // Every description asks GPT 6.2 Sol on the AI Gateway with the constrained instruction (no invented team names).
      for (const ask of asked) {
        expect(ask.model, label).toBe('openai/gpt-6.2-sol');
        expect(ask.instruction).toContain(
          'Never add a team, school, brand or place name that is not printed in the image',
        );
      }
      expect(asked).toHaveLength(described.length);
      for (const [i, seat] of chosen.entries())
        expect(kling.prompt).toContain(
          `${ROLE[seat]} is @image_${i + 1}, a person in a red jersey with the number 7.`,
        );
      expect(kling.prompt).not.toMatch(/[{}]|prep:/);
      // Upstream idempotency keys are unique per task.
      expect(new Set(upstream.submits.map((s) => s.key)).size).toBe(upstream.submits.length);
      // Worst case of what this order may cost upstream stays under the order's cap.
      expect(sent.reduce((sum, s) => sum + cents(s.maxCost), 0)).toBeLessThanOrEqual(cents(model.maxCost));
      // keepUploads: every customer photo is kept privately with the order.
      for (const photo of Object.values(photos))
        expect(
          await store.head(`jobs/${jobId}/kept/${photo.slice('/files/'.length)}`),
          `${label}: kept`,
        ).toBeTruthy();
      // One swap check, a likeness check when the lead or keys is filled, one stitch; no repair.
      expect(
        composer.calls.filter((c) => c === 'compose'),
        label,
      ).toHaveLength(1);
      expect(composer.calls).not.toContain('patch');
    }
  });

  it('a missed lead and keys get repaired one person per pass with their chest-up portrait, and the order is delivered', async () => {
    // First check: the original lead singer and keyboard player are still there; one of them after the first pass; then nobody.
    const composer = new FakeComposer([['lead', 'keys'], ['lead', 'keys'], ['keys'], []], {
      lead: 0.6,
      keys: 0.6,
    });
    const { photos, upstream, row } = await order([...SEATS], composer);
    expect(row.status).toBe('succeeded');
    const passes = upstream.submits
      .map((s) => s.input)
      .filter((s) => s.upstreamModel === 'pruna/p-video-replace');
    expect(passes.length).toBeGreaterThanOrEqual(2);
    expect(passes.length).toBeLessThanOrEqual(repair.rounds);
    for (const pass of passes) {
      expect(pass).toMatchObject({ kind: 'video', maxCost: '0.40', parameters: { resolution: '720p' } });
      expect(pass.references.map((r) => r.role)).toEqual(['reference_video', 'reference_image']);
      expect(pass.references[0]!.url).toMatch(new RegExp(`^${FILES}jobs/job_[a-z0-9]+/`));
      // The person's chest-up portrait (their second prep task: up_2, up_4, …), never the pair sheet.
      const task = Number(/^https:\/\/cdn\.example\/up_(\d+)\.png$/.exec(pass.references[1]!.url)?.[1]);
      expect(task % 2).toBe(0);
      const seat = SEATS[task / 2 - 1]!;
      expect(pass.prompt).toMatch(
        seat === 'lead'
          ? /^Replace the lead singer with/
          : /^Replace (the keyboard player|the person partly visible)/,
      );
    }
    expect(Object.keys(photos)).toHaveLength(5);
    expect(composer.calls).toContain('extract');
    expect(composer.calls).toContain('patch');
    const sent = upstream.submits.map((s) => s.input);
    expect(sent.reduce((sum, s) => sum + cents(s.maxCost), 0)).toBeLessThanOrEqual(cents(model.maxCost));
  });

  it('worst case: nobody ever swaps in; every repair round is spent, the order is delivered and stays under the cap', async () => {
    const composer = new FakeComposer([[...SEATS]]);
    const { upstream, row } = await order([...SEATS], composer);
    // onMiss 'deliver': the customer still gets the best version (Kling was paid, so no refund); REVIEW_EMAIL gets a note.
    expect(row.status).toBe('succeeded');
    const sent = upstream.submits.map((s) => s.input);
    expect(sent.filter((s) => s.upstreamModel === 'pruna/p-video-replace')).toHaveLength(repair.rounds);
    expect(sent).toHaveLength(10 + 1 + repair.rounds);
    expect(sent.reduce((sum, s) => sum + cents(s.maxCost), 0)).toBeLessThanOrEqual(cents(model.maxCost));
  });

  it('a pet: no likeness check on the animal, the animal sentence in the prompt', async () => {
    const composer = new FakeComposer([[]], { lead: 0.6 });
    const { upstream, row } = await order(['lead', 'backLeft'], composer, 'backLeft');
    expect(row.status).toBe('succeeded');
    const kling = upstream.submits.at(-1)!.input;
    expect(kling.prompt).toContain('@image_2 is an animal and becomes that animal completely');
    expect(composer.likenessInputs.every((input) => input.people.length === 1)).toBe(true);
  });

  // The installed SDK checks the request's general structure only: an empty prompt fails. Model names, durations and image counts are
  // pinned by the tests above; whether Yir and the model accept them is the model contract, not something these tests can prove.
  it('the SDK check is real: a request it rejects fails validation before any submit', () => {
    const video = planned({ lead: 'uploads/lead.jpg' })!.find((part) => part.kind !== 'image')!;
    expect(() => yir.validate({ ...request(video, {}), prompt: '' })).toThrow(/prompt_required/);
  });
});
