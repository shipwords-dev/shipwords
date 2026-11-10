import { describe, expect, it } from 'vitest';
import { definePublicModels, type EffectSlot, serverModels } from '../src/models';

const catalog = definePublicModels([
  {
    id: 'image',
    name: 'Image',
    kind: 'image',
    credits: 5,
    guest: true,
    allowedParameters: [],
    maxReferences: 2,
  },
  {
    id: 'effect',
    name: 'Effect',
    kind: 'video',
    credits: 10,
    guest: false,
    allowedParameters: [],
    maxReferences: 0,
    effect: { slots: [{ id: 'a', label: 'A', required: true }] },
  },
]);

const segment = {
  id: 'full',
  referenceVideo: 'assets/demo/full.mp4',
  slots: ['a'],
  prompt: (images: Readonly<Record<string, string>>) => `Swap in ${images.a}`,
  parameters: {},
  maxCost: '1.00',
};

const server = {
  image: { upstream: 'yir', upstreamModel: 'vendor/image', maxCost: '0.20', timeoutMinutes: 5 },
  effect: {
    upstream: 'yir',
    upstreamModel: 'vendor/video',
    maxCost: '1.00',
    timeoutMinutes: 20,
    effect: { segments: [segment] },
  },
} as const;

describe('public and server model files', () => {
  it('joins each public model with its server fields', () => {
    const [image, effect] = serverModels(catalog, server);
    expect(image).toMatchObject({ id: 'image', credits: 5, upstreamModel: 'vendor/image' });
    expect(image?.effect).toBeUndefined();
    expect(effect?.effect?.slots).toEqual([{ id: 'a', label: 'A', required: true }]);
    expect(
      effect?.effect?.segments[0]?.prompt({ a: '@image1' }, { kinds: { a: 'person' }, describe: () => '' }),
    ).toBe('Swap in @image1');
  });

  it('rejects server fields in site.models.ts', () => {
    const leak = (model: object) => () => definePublicModels([{ ...catalog[0], ...model }]);
    expect(leak({ upstreamModel: 'vendor/image' })).toThrow(/upstreamModel would ship to the browser/);
    expect(leak({ effect: { slots: [], segments: [segment] } })).toThrow(/effect.segments/);
    expect(leak({ effect: { slots: [{ id: 'a', label: 'A', required: true, prep: 'secret' }] } })).toThrow(
      /slot prep/,
    );
  });

  it('requires both files to list the same models, effects and slots', () => {
    const join = (fields: object) => () => serverModels(catalog, fields as typeof server);
    expect(join({ image: server.image })).toThrow(/effect: missing/);
    expect(join({ ...server, extra: server.image })).toThrow(/without a public entry: extra/);
    expect(join({ ...server, image: { ...server.image, effect: { segments: [segment] } } })).toThrow(
      /effect must be in both/,
    );
    expect(
      join({
        ...server,
        effect: {
          ...server.effect,
          effect: { segments: [segment], slots: [{ id: 'b', label: 'B', required: true }] },
        },
      }),
    ).toThrow(/slots must match/);
  });

  it('never lets server fields change what the page shows', () => {
    // Through a variable, so no excess-property check: the repeated price must still be rejected.
    const priced = { ...server.image, credits: 99 };
    expect(() => serverModels(catalog, { ...server, image: priced })).toThrow(
      /credits belongs in site.models.ts only/,
    );
    const withSlots = (slots: EffectSlot[]) => ({
      ...server,
      effect: { ...server.effect, effect: { segments: [segment], slots } },
    });
    expect(() => serverModels(catalog, withSlots([{ id: 'a', label: 'A', required: false }]))).toThrow(
      /apart from prep/,
    );
    const [, effect] = serverModels(
      catalog,
      withSlots([{ id: 'a', label: 'A', required: true, prep: 'Half-body photo' }]),
    );
    expect(effect?.effect?.slots).toEqual([{ id: 'a', label: 'A', required: true, prep: 'Half-body photo' }]);
  });

  it('still validates presets like defineModels', () => {
    const cheap = { ...server, effect: { ...server.effect, maxCost: '0.50' } };
    expect(() => serverModels(catalog, cheap)).toThrow(/exceeds model maxCost/);
  });
});
