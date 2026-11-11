import { describe, expect, it } from 'vitest';
import { DESCRIBE_MODEL, workersAiDescribe } from '../src/describe';
import {
  defineModels,
  type EffectRepair,
  effectParts,
  fillDescriptions,
  type ModelDefinition,
  pointsOf,
} from '../src/models';
import { emailReview } from '../src/notify';
import {
  checkPoints,
  checkWindows,
  fitAspect,
  judgeCheck,
  missedAfterLikeness,
  nextRepairPass,
  photoOf,
  shotAt,
  shotGroups,
} from '../src/repair';
import { cleanDescription, subjectPhotos } from '../src/runner';

// Person swaps: several prep views per person sent as upstream subjects, person/pet slots, descriptions in the prompt, and repair planning.

const upload = (ref: unknown) =>
  typeof ref === 'string' && ref.startsWith('/files/uploads/') ? `https://site${ref}` : null;
const asset = (key: string) => `https://site/files/${key}`;

const swapModel: ModelDefinition = {
  id: 'swap',
  name: 'Swap',
  kind: 'video',
  upstream: 'yir',
  upstreamModel: 'vendor/edit',
  credits: 10,
  guest: false,
  allowedParameters: [],
  maxReferences: 0,
  maxCost: '4.00',
  timeoutMinutes: 30,
  effect: {
    slots: [
      { id: 'lead', label: 'Lead', required: false, prep: ['face', 'front', 'side'] },
      { id: 'keys', label: 'Keys', required: false, prep: 'strip' },
      { id: 'sax', label: 'Sax', required: false },
    ],
    prep: { upstreamModel: 'vendor/image', parameters: {}, maxCost: '0.02' },
    describe: { instruction: 'say what they look like', view: 1 },
    segments: [
      {
        id: 'full',
        referenceVideo: 'assets/demo/full.mp4',
        slots: ['lead', 'keys', 'sax'],
        subjects: { lead: 'Lead' },
        prompt: (images, { kinds, describe }) =>
          Object.entries(images)
            .map(([slot, name]) => `${slot}=${name}${describe(slot)}(${kinds[slot]})`)
            .join(' '),
        parameters: { duration: 18 },
        maxCost: '3.40',
      },
    ],
  },
};

describe('person swap parts', () => {
  it('one prep part per view, subjects get every view, plain slots the main one, kinds and descriptions recorded', () => {
    const parts = effectParts(
      swapModel,
      {
        lead: '/files/uploads/up_l.png',
        keys: { photo: '/files/uploads/up_k.png', kind: 'pet' },
        sax: { photo: '/files/uploads/up_s.png' },
      },
      upload,
      asset,
    )!;
    expect(parts.map((part) => part.id)).toEqual([
      'prep-lead',
      'prep-lead-v1',
      'prep-lead-v2',
      'prep-keys',
      'full',
    ]);
    expect(parts.slice(0, 4).map((part) => [part.prompt, part.references[0]!.url])).toEqual([
      ['face', 'https://site/files/uploads/up_l.png'],
      ['front', 'https://site/files/uploads/up_l.png'],
      ['side', 'https://site/files/uploads/up_l.png'],
      ['strip', 'https://site/files/uploads/up_k.png'],
    ]);
    const full = parts[4]!;
    expect(full.prompt).toBe(
      'lead=@Lead{{describe:lead}}(person) keys=@image2{{describe:keys}}(pet) sax=@image3(person)',
    );
    expect(full.references).toEqual([
      { url: 'https://site/files/assets/demo/full.mp4', role: 'reference_video' },
      { url: 'prep:lead', role: 'reference_image', slot: 'lead', subject: 'Lead' },
      { url: 'prep:lead-v1', role: 'reference_image', slot: 'lead', subject: 'Lead' },
      { url: 'prep:lead-v2', role: 'reference_image', slot: 'lead', subject: 'Lead' },
      { url: 'prep:keys', role: 'reference_image', slot: 'keys' },
      { url: 'https://site/files/uploads/up_s.png', role: 'reference_image', slot: 'sax' },
    ]);
    expect(full.kinds).toEqual({ lead: 'person', keys: 'pet', sax: 'person' });
    // The described view is the front (view 1); keys has one view, so its only one. sax has no prep image: no placeholder.
    expect(full.describe).toEqual({
      instruction: 'say what they look like',
      images: { lead: 'prep:lead-v1', keys: 'prep:keys' },
    });
  });

  it('rejects a kind other than person or pet', () => {
    expect(
      effectParts(swapModel, { lead: { photo: '/files/uploads/up_l.png', kind: 'robot' } }, upload, asset),
    ).toBeNull();
    expect(
      effectParts(swapModel, { lead: { photo: 'https://evil.example/x.png' } }, upload, asset),
    ).toBeNull();
  });

  it('without describe the placeholder is empty and nothing is recorded', () => {
    const plain = { ...swapModel, effect: { ...swapModel.effect!, describe: undefined } };
    const full = effectParts(plain, { lead: '/files/uploads/up_l.png' }, upload, asset)!.at(-1)!;
    expect(full.prompt).toBe('lead=@Lead(person)');
    expect(full.describe).toBeUndefined();
  });

  it('fills descriptions after the name and drops the ones it has none for', () => {
    const prompt = 'with @Lead{{describe:lead}}. with @Keys{{describe:keys}}.';
    expect(fillDescriptions(prompt, { lead: 'a man in a red shirt' })).toBe(
      'with @Lead, a man in a red shirt. with @Keys.',
    );
  });

  it('cleans a vision answer into a prompt phrase', () => {
    expect(cleanDescription('  The person is a man, 40s,\n short dark hair, red "N" shirt. ')).toBe(
      'a man, 40s, short dark hair, red N shirt',
    );
    expect(cleanDescription('@Lead {{describe:x}} ok')).toBe('Lead describe:x ok');
    expect(cleanDescription('x'.repeat(300))).toHaveLength(200);
  });

  it('validates subjects, prep views, describe and multi-point checks', () => {
    const segment = swapModel.effect!.segments[0]!;
    const withEffect = (effect: object) => () =>
      defineModels([{ ...swapModel, effect: { ...swapModel.effect!, ...effect } }]);
    expect(withEffect({})).not.toThrow();
    expect(withEffect({ segments: [{ ...segment, subjects: { lead: 'Lead', keys: 'Lead' } }] })).toThrow(
      /subjects/,
    );
    expect(withEffect({ segments: [{ ...segment, subjects: { lead: '1st' } }] })).toThrow(/subjects/);
    expect(withEffect({ segments: [{ ...segment, subjects: { nobody: 'Nobody' } }] })).toThrow(/subjects/);
    // A subject takes 2–4 photos: a slot with one prep view can't be one; a slot without prep can (its upload is padded).
    expect(withEffect({ segments: [{ ...segment, subjects: { lead: 'Lead', keys: 'Keys' } }] })).toThrow(
      /keys needs 2–4 prep views/,
    );
    expect(withEffect({ segments: [{ ...segment, subjects: { lead: 'Lead', sax: 'Sax' } }] })).not.toThrow();
    // Generated prep IDs must not collide: lead's second view is prep-lead-v1, so a slot called lead-v1 with prep can't exist.
    expect(
      withEffect({
        slots: [...swapModel.effect!.slots, { id: 'lead-v1', label: 'X', required: false, prep: 'x' }],
        segments: [{ ...segment, slots: [...segment.slots, 'lead-v1'] }],
      }),
    ).toThrow(/prep part IDs collide/);
    const lead = swapModel.effect!.slots[0]!;
    expect(
      withEffect({
        slots: [{ ...lead, prep: ['a', 'b', 'c', 'd', 'e'] }, ...swapModel.effect!.slots.slice(1)],
      }),
    ).toThrow(/1–4 prompts/);
    expect(withEffect({ describe: { instruction: 'x', view: 3 } })).toThrow(/describe/);
    expect(withEffect({ prep: undefined })).toThrow(/describe needs prep/);
    // Four prep images at 0.02, each possibly hedged: 0.16 + 3.40 fits 4.00; a fifth image per slot would not be allowed anyway.
    expect(() => defineModels([{ ...swapModel, maxCost: '3.55' }])).toThrow(/exceeds/);
  });
});

describe('check points', () => {
  const faces = {
    keys: [
      [0.4, 0.5, 0],
      [0.87, 0.82, 12.5],
    ] as const,
    lead: [0.8, 0.3, 5.4] as const,
  };

  it('flattens points per slot and reads one entry as a list', () => {
    expect(pointsOf([0.1, 0.2])).toEqual([[0.1, 0.2]]);
    expect(checkPoints(faces, ['lead', 'keys'])).toEqual({
      points: [
        [0.8, 0.3, 5.4],
        [0.4, 0.5, 0],
        [0.87, 0.82, 12.5],
      ],
      owners: ['lead', 'keys', 'keys'],
    });
  });

  it('a slot misses when any of its points does, and where says in which shots', () => {
    // Cuts at 5.333, 11.625, 15: the corner point at 12.5 s is in shot 2.
    const judged = judgeCheck(faces, ['lead', 'keys'], [0.2, 0.3, 0.7], 0.45, [5.333, 11.625, 15]);
    expect(judged).toEqual({ missed: ['keys'], where: { keys: [2] } });
    expect(shotAt([5.333, 11.625, 15], 0)).toBe(0);
    expect(shotAt([5.333, 11.625, 15], 16)).toBe(3);
  });

  it('each point looks at the shots of its group, trimmed at inner cuts; points no shot covers look everywhere', () => {
    const shots = [['keys', 'left'], ['lead'], ['sax', 'keys'], ['left', 'keys']];
    const { points, owners } = checkPoints(faces, ['lead', 'keys']);
    expect(checkWindows(points, owners, shots, [5.333, 11.625, 15], 18)).toEqual([
      [[5.633, 11.325]],
      [
        [0, 5.033],
        [15.3, 18],
      ],
      [[11.925, 14.7]],
    ]);
    // A shot shorter than 4 × margin is trimmed by a quarter of its length, so its window stays valid.
    expect(checkWindows([[0.5, 0.5, 1.2]], ['lead'], [['keys'], ['lead'], ['sax']], [1, 1.5], 3)).toEqual([
      [[1.125, 1.375]],
    ]);
    // lead's point at 5.4 s is in shot 1, which has lead; a slot not in the point's shot gets the whole output.
    expect(checkWindows([[0.5, 0.5, 0]], ['lead'], shots, [5.333, 11.625, 15], 18)).toEqual([[[0, 18]]]);
  });

  it('finds a slot photo by name, or by position in parts from older versions', () => {
    const named = [
      { url: 'v', role: 'reference_video' },
      { url: 'l1', role: 'reference_image', slot: 'lead' },
      { url: 'l2', role: 'reference_image', slot: 'lead' },
      { url: 'k1', role: 'reference_image', slot: 'keys' },
    ];
    expect(photoOf(named, ['lead', 'keys'], 'keys')).toBe('k1');
    expect(photoOf(named, ['lead', 'keys'], 'lead')).toBe('l1');
    const old = [
      { url: 'v', role: 'reference_video' },
      { url: 'a', role: 'reference_image' },
      { url: 'b', role: 'reference_image' },
    ];
    expect(photoOf(old, ['lead', 'keys'], 'keys')).toBe('b');
  });
});

describe('repair planning by shot groups', () => {
  const repair: EffectRepair = {
    upstreamModel: 'vendor/replace',
    prompt: () => 'replace',
    parameters: {},
    maxCost: '0.40',
    rounds: 5,
    // band shots 0 and 3 have the same three people; the sax close-up (2) also shows keys in its corner.
    shots: [['keys', 'left', 'right'], ['lead'], ['sax', 'keys'], ['right', 'left', 'keys']],
    crops: { left: [0, 0, 0.44, 0.39] },
  };
  const filled = ['lead', 'sax', 'keys', 'left', 'right'];

  it('groups shots with the same people, whatever their order', () => {
    expect(shotGroups(repair.shots)).toEqual([
      { shots: [0, 3], slots: ['keys', 'left', 'right'] },
      { shots: [1], slots: ['lead'] },
      { shots: [2], slots: ['sax', 'keys'] },
    ]);
  });

  it('starts with the group where the check saw the original, then the slot’s other groups, then takes turns', () => {
    const first = nextRepairPass(repair, filled, ['keys'], [], { keys: [2] })!;
    expect(first).toEqual({ slots: ['sax', 'keys'], shots: [2] });
    const second = nextRepairPass(repair, filled, ['keys'], [first], { keys: [2] })!;
    // Every flagged group had its pass; the slot's other group is next.
    expect(second).toEqual({ slots: ['keys', 'left', 'right'], shots: [0, 3] });
    const third = nextRepairPass(repair, filled, ['keys'], [first, second], { keys: [2] })!;
    expect(third).toEqual({ slots: ['sax', 'keys'], shots: [2] });
    // Without a place (a likeness miss), the slot's groups in order.
    expect(nextRepairPass(repair, filled, ['keys'], [])).toEqual({
      slots: ['keys', 'left', 'right'],
      shots: [0, 3],
    });
  });

  it('a crop pass on the first group once it had a whole-frame pass', () => {
    const whole = nextRepairPass(repair, filled, ['left'], [])!;
    expect(whole).toEqual({ slots: ['keys', 'left', 'right'], shots: [0, 3] });
    expect(nextRepairPass(repair, filled, ['left'], [whole])).toEqual({
      slots: ['left'],
      shots: [0, 3],
      crop: [0, 0, 0.44, 0.39],
    });
  });

  it('fits a crop box to the model aspect around its center, inside the frame', () => {
    // 360×496 px at the top right of a 720×1280 frame, widened to 7:9 (386×496), pushed back inside the right edge.
    const [x, y, w, h] = fitAspect([0.5, 0, 0.5, 0.3875], 7 / 9, 720, 1280);
    expect(w * 720).toBeCloseTo(385.78, 1);
    expect(h * 1280).toBeCloseTo(496, 5);
    expect(x + w).toBeCloseTo(1, 10);
    expect(y).toBe(0);
    // A tall box gets wider; a box too wide for the frame shrinks to fit.
    const tall = fitAspect([0.4, 0.4, 0.1, 0.1], 1, 1000, 1000);
    expect(tall.map((v) => Number(v.toFixed(6)))).toEqual([0.4, 0.4, 0.1, 0.1]);
    const wide = fitAspect([0, 0, 1, 0.1], 0.5, 100, 100);
    expect(wide[2] * 100).toBeCloseTo(50, 5);
    expect(wide[3] * 100).toBeCloseTo(100, 5);
  });
});

describe('describe and review helpers', () => {
  it('sends the image as a data URL with the instruction and returns the answer', async () => {
    const calls: unknown[] = [];
    const ai = {
      run: async (model: string, input: unknown) => {
        calls.push([model, input]);
        return { response: 'a man in a red shirt' };
      },
    } as unknown as Ai;
    const fetcher = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png' },
      })) as unknown as typeof fetch;
    const describe = workersAiDescribe(ai, { fetcher });
    expect(await describe('https://up/front.png', 'who is this')).toBe('a man in a red shirt');
    expect(calls).toEqual([
      [
        DESCRIBE_MODEL,
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'who is this' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
              ],
            },
          ],
          max_tokens: 80,
        },
      ],
    ]);
    const broken = workersAiDescribe(ai, {
      fetcher: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    });
    await expect(broken('https://up/x.png', 'x')).rejects.toThrow(/404/);
  });

  it('emails the owner which job needs a look, why and where the result is', async () => {
    const sent: { to: string; subject: string; text: string; html: string }[] = [];
    const email = { send: async (message: never) => void sent.push(message) } as unknown as SendEmail;
    const review = emailReview({
      email,
      from: 'noreply@site.example',
      to: 'owner@site.example',
      site: { name: 'Site' },
      baseURL: 'https://site.example',
    });
    await review(
      {
        id: 'job_1',
        modelId: 'swap',
        userId: 'u_1',
        outputsJson: JSON.stringify([{ key: 'jobs/job_1/1.mp4', mediaType: 'video/mp4' }]),
      } as never,
      ['band: delivered with keys not swapped <x>'],
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'owner@site.example', subject: '[Site] job_1 needs review' });
    expect(sent[0]!.text).toContain('- band: delivered with keys not swapped <x>');
    expect(sent[0]!.text).toContain('Result: https://site.example/files/jobs/job_1/1.mp4');
    expect(sent[0]!.html).toContain('&lt;x&gt;');
  });
});

describe('subject photos and the likeness rule', () => {
  it('sends a subject’s photos once each and pads a lone site upload with a second URL', () => {
    const refs = [
      { url: 'https://cdn/a.png', role: 'reference_image', subject: 'Lead' },
      { url: 'https://site/files/uploads/up_l.png', role: 'reference_image', subject: 'Lead' },
      { url: 'https://site/files/uploads/up_l.png', role: 'reference_image', subject: 'Lead' },
      { url: 'https://site/files/uploads/up_k.png', role: 'reference_image', subject: 'Keys' },
      { url: 'https://site/files/uploads/up_k.png', role: 'reference_image', subject: 'Keys' },
      { url: 'https://cdn/s.png', role: 'reference_image', subject: 'Sax' },
      { url: 'https://site/files/uploads/up_x.png', role: 'reference_image' },
    ];
    expect(subjectPhotos(refs, 'https://site/files/').map((ref) => [ref.url, ref.subject])).toEqual([
      ['https://cdn/a.png', 'Lead'],
      ['https://site/files/uploads/up_l.png', 'Lead'],
      ['https://site/files/uploads/up_k.png', 'Keys'],
      ['https://site/files/uploads/up_k.png?view=2', 'Keys'],
      // A lone upstream URL is left as is (validation keeps it from happening); plain references are untouched.
      ['https://cdn/s.png', 'Sax'],
      ['https://site/files/uploads/up_x.png', undefined],
    ]);
  });

  it('drops a face-check miss that clearly looks like the photo, keeps likeness misses', () => {
    expect(
      missedAfterLikeness(['lead', 'sax', 'keys'], ['lead', 'keys'], { missed: ['sax'], passed: ['lead'] }),
    ).toEqual(['sax', 'keys']);
  });
});
