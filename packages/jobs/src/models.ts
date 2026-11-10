// Each site declares its models in two files. site.models.ts (definePublicModels) holds what pages show: ID, name, credit price,
// guest eligibility, inputs; pages import it, so it ships to the browser. src/models.server.ts (serverModels) adds the upstream model,
// cost cap, timeout and effect presets by ID. Prices are defined only in site.models.ts; display and charging read the same source.

export interface ModelDefinition {
  /** The site's model ID, used in URLs and requests. */
  id: string;
  name: string;
  /** music: style prompt plus optional lyrics in, songs out; no references and no effect. */
  kind: 'image' | 'video' | 'music';
  upstream: 'yir';
  upstreamModel: string;
  /** Credits charged per job; pass a function for parameter-based pricing. */
  credits: number | ((parameters: Record<string, unknown>) => number);
  /** Whether guests can try this model for free (usually only the cheapest one). */
  guest: boolean;
  /** Parameter names users may pass; all others are dropped. */
  allowedParameters: readonly string[];
  defaults?: Readonly<Record<string, unknown>>;
  /** Max reference images; 0 means text-to-image only. */
  maxReferences: number;
  /** Upstream cost cap per job (USD string), so the upstream can't route to an expensive channel. For effects it caps the whole job; the sum of segment maxCost must not exceed it. */
  maxCost?: string;
  /** How long to poll before timing out and refunding. */
  timeoutMinutes: number;
  /** Role of the user's reference image for the upstream; defaults to reference_image for image models, first_frame for video models. */
  referenceRole?: 'reference_image' | 'first_frame';
  /** Effects: prompts and reference videos are preset server-side; users only upload photos per slot. */
  effect?: EffectSpec;
}

export interface EffectSlot {
  id: string;
  label: string;
  /** Must be uploaded; if none are required, at least one must be uploaded (otherwise there's nothing to render). */
  required: boolean;
  /**
   * Prep prompt (applies when effect.prep exists): first edits the user's photo into a consistent half-body outfit shot; video segments use the edited image.
   * An array of 1–4 prompts makes one image per prompt (views of the same person, e.g. face, front, three-quarter, profile); the first is
   * the main view. Segments with subjects send every view as that person's photos; elsewhere only the main view is used.
   */
  prep?: string | readonly string[];
}

/** What a slot's photo shows, as the user marked it; unmarked slots are people. */
export type SlotKind = 'person' | 'pet';

/** What a segment prompt knows besides the image names. */
export interface PromptContext {
  /** Filled slot → what its photo shows ('person' when the user didn't say). */
  kinds: Readonly<Record<string, SlotKind>>;
  /**
   * A placeholder for the slot's appearance, filled in at submit from its prep image (effect.describe): ", a man with short dark hair in a red
   * T-shirt…" or an empty string when describing is off or fails. Write it right after the image name: `with @Lead${describe('lead')}.`
   */
  describe: (slot: string) => string;
}

/** Describe each filled slot's prep image with a vision model before the video segments are submitted (RunnerDeps.describe). */
export interface EffectDescribe {
  /** What to say about the person; the answer goes into the prompt after the image name. */
  instruction: string;
  /** Which prep view to describe (index into the slot's prep prompts, or its last view when it has fewer); defaults to 0. */
  view?: number;
}

/** Prep sub-task: one per slot with prep, using the user's photo as reference. */
export interface EffectPrep {
  upstreamModel: string;
  parameters: Readonly<Record<string, unknown>>;
  /** Cost cap per prep run (USD string). */
  maxCost: string;
}

export interface EffectSegment {
  id: string;
  /**
   * Reference video: an R2 key (assets/...) or a full https URL. Pass a function to pick a variant by the filled slots
   * (in this segment's slot order), e.g. a clip with those people's eyes masked so the model can't keep the original faces.
   */
  referenceVideo: string | ((filled: readonly string[]) => string);
  /** Reference audio (assets/*.mp3 or https), retimed like the reference video; passed to the upstream as reference_audio. */
  referenceAudio?: string;
  /** Swappable slots in this shot; filled slots map to @image1, @image2… in this order. */
  slots: readonly string[];
  /**
   * Slot → subject name for upstreams that take several photos per person (Kling subjects): every prep view of the slot is sent as that
   * subject's photo and the prompt refers to it as @Name instead of @imageN. Names are letters, digits and _ (1–32, starting with a letter).
   */
  subjects?: Readonly<Record<string, string>>;
  /** images only contains filled slots; values are how the prompt refers to them (e.g. @image1, or @Lead for a subject). */
  prompt: (images: Readonly<Record<string, string>>, context: PromptContext) => string;
  parameters: Readonly<Record<string, unknown>>;
  /** Upstream cost cap for this segment (USD string), passed to the upstream as max_cost. */
  maxCost: string;
  /** For compose (required when effect.compose exists): seconds this segment occupies in the output. */
  target?: number;
  /** For compose: base clip (R2 key) used when nobody in this segment is swapped, retimed to target. */
  base?: string;
  /**
   * For compose: how the model output goes into the final video. 'stretch' (default) retimes the whole segment to target;
   * 'trim' takes the first target seconds at real speed (for reference videos cut longer than the shot without retiming; better lip sync).
   */
  fit?: 'stretch' | 'trim';
  /**
   * For compose: shot cut times of this segment in the final cut (seconds, increasing, inside (0, target)). Overrides fit:
   * compose finds the scene cuts in the model output, matches each to the nearest one within 0.5 s and retimes every shot to its exact length,
   * for edit models that keep the shots but not the exact timing. A missing cut fails the job with a refund.
   */
  cuts?: readonly number[];
  /**
   * Output check (needs effect.compose): for each filled slot listed in faces, look for the original person's face in the output.
   * If any of them is still there (face similarity ≥ maxSimilarity) the swap didn't take: the whole job fails with a refund, no rerun.
   */
  check?: EffectCheck;
  /**
   * Repair (needs check and cuts, and compose with this as the only segment): when the check still finds original people, re-render the shots
   * they appear in with a video replace model instead of refunding, then check again; after `rounds` passes the job fails with a refund,
   * or delivers the best version when `onMiss` is 'deliver'.
   */
  repair?: EffectRepair;
}

/** A box as fractions of the frame: [x, y, width, height]. */
export type CropBox = readonly [number, number, number, number];

export interface EffectRepair {
  /** Video replace model: gets the shots to repair as reference_video and the photos of the slots in that pass as reference_image (1–3). */
  upstreamModel: string;
  /** Instruction for one pass; slots are the people being replaced, in reference image order; kinds as in PromptContext. */
  prompt: (slots: readonly string[], kinds: Readonly<Record<string, SlotKind>>) => string;
  parameters: Readonly<Record<string, unknown>>;
  /** Cost cap per pass (USD string). */
  maxCost: string;
  /** Most passes per job (1–5); every pass counts toward the model's maxCost. */
  rounds: number;
  /**
   * When the passes can't replace everyone (they run out, the model rejects or fails one, or no pass covers a missed slot):
   * 'refund' (default) fails the job swap_not_applied with a refund; 'deliver' delivers the version with the fewest missed people
   * and keeps the credits, for sites that stop refunding once the paid render has been charged. Under 'deliver' a check error on the render
   * or a miss that can't be repaired at all also delivers the render instead of refunding.
   */
  onMiss?: 'refund' | 'deliver';
  /**
   * Slots visible in each shot, one entry per shot (cuts split the segment into cuts.length + 1 shots), at most 3 per shot. Shots with the
   * same slots form a group that one pass re-renders together, with the photos of everyone in it; a slot in several groups (a person who
   * also shows in another shot's corner) gets a pass per group, in order.
   */
  shots: readonly (readonly string[])[];
  /**
   * Slot → box around that person in the first group of shots they are in, for people at the frame edge the model passes over when the
   * whole frame is repaired: after a whole-frame pass on that group has missed them, the next pass repairs that box alone and blends it back.
   */
  crops?: Readonly<Record<string, CropBox>>;
  /**
   * Width / height the replace model renders at (e.g. 7 / 9). Crop boxes are widened or heightened to it around their center before they
   * are cut out, so the model doesn't crop them again and the repaired box lines up when it is blended back.
   */
  aspect?: number;
  /**
   * Slot → lowest likeness (cosine, 0–1) between the person's photo and their face in the shots they are in, checked on the composed
   * video. A filled slot below it is repaired like a missed swap and counts as missed when picking the best version. Needs onMiss
   * 'deliver': a person who doesn't look enough like their photo is never a reason to refund. For close-ups only: small or profile
   * faces score low even when right.
   */
  likeness?: Readonly<Record<string, number>>;
}

export interface EffectCheck {
  /** Unmasked original clip of this shot (assets/*.mp4); the original faces are read from its first frame, or from the frame at a point's t. */
  original: string;
  /**
   * Slot → face center as fractions of width and height, in the original's first frame ([x, y]) or at t seconds ([x, y, t]),
   * for clips where people appear in different shots. A list checks several appearances of the same person (a face in the corner of
   * another shot); the slot scores its highest.
   */
  faces: Readonly<Record<string, FacePoint | readonly FacePoint[]>>;
  /** Face similarity (cosine, 0–1) at or above which a slot still shows the original person. */
  maxSimilarity: number;
}

export type FacePoint = readonly [number, number] | readonly [number, number, number];

/** A check.faces entry as a list of points. */
export function pointsOf(entry: FacePoint | readonly FacePoint[]): readonly FacePoint[] {
  return typeof entry[0] === 'number' ? [entry as FacePoint] : (entry as readonly FacePoint[]);
}

/** A slot's prep prompts, main view first. */
export function prepViews(slot: EffectSlot): readonly string[] {
  return slot.prep === undefined ? [] : typeof slot.prep === 'string' ? [slot.prep] : slot.prep;
}

/** Part ID of a slot's prep view: the main view keeps the single-view ID prep-<slot>. */
export function prepPartId(slot: string, view: number): string {
  return view === 0 ? `prep-${slot}` : `prep-${slot}-v${view}`;
}

const DESCRIBE_TOKEN = /\{\{describe:([A-Za-z0-9_-]+)\}\}/g;

/** Fill describe placeholders: ", <text>" for a described slot, nothing otherwise. */
export function fillDescriptions(prompt: string, descriptions: Readonly<Record<string, string>>): string {
  return prompt.replace(DESCRIBE_TOKEN, (_, slot: string) =>
    descriptions[slot] ? `, ${descriptions[slot]}` : '',
  );
}

/** Slots whose appearance a prompt asks for. */
export function describedSlots(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(DESCRIBE_TOKEN)].map((match) => match[1]!))];
}

/** Every non-empty subset of a segment's slots, in slot order. */
function slotCombinations(slots: readonly string[]): string[][] {
  const result: string[][] = [];
  for (let mask = 1; mask < 1 << slots.length; mask++) {
    result.push(slots.filter((_, i) => mask & (1 << i)));
  }
  return result;
}

/** The reference video for the filled slots of a segment. */
export function referenceVideoOf(segment: EffectSegment, filled: readonly string[]): string {
  return typeof segment.referenceVideo === 'function'
    ? segment.referenceVideo(filled)
    : segment.referenceVideo;
}

/** Compose config: segments are stitched in order into one video, mixed with the original track, plus a silent version. */
export interface EffectCompose {
  /** Original track (R2 key), cut audioDuration seconds starting at audioStart. */
  audio: string;
  audioStart: number;
  audioDuration: number;
  width: number;
  height: number;
  fps: number;
}

export interface EffectSpec {
  slots: readonly EffectSlot[];
  segments: readonly EffectSegment[];
  compose?: EffectCompose;
  prep?: EffectPrep;
  describe?: EffectDescribe;
}

/** Role of the user's reference image. */
export function referenceRoleOf(model: ModelDefinition): string {
  return model.referenceRole ?? (model.kind === 'video' ? 'first_frame' : 'reference_image');
}

export function defineModels<const T extends readonly ModelDefinition[]>(models: T): T {
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) throw new Error(`duplicate model id: ${model.id}`);
    ids.add(model.id);
    if (model.kind === 'music' && (model.effect || model.maxReferences !== 0))
      throw new Error(`model ${model.id}: music models take no references and no effect`);
    if (model.effect) validateEffect(model, model.effect);
  }
  return models;
}

/** An effect slot as the browser sees it: no prep prompt. */
export type PublicSlot = Omit<EffectSlot, 'prep'>;

const PUBLIC_KEYS = [
  'id',
  'name',
  'kind',
  'credits',
  'guest',
  'allowedParameters',
  'defaults',
  'maxReferences',
  'effect',
] as const;
const PUBLIC_SLOT_KEYS: readonly string[] = ['id', 'label', 'required'];

/** What the browser may know about a model: name, price and inputs. site.models.ts holds only this, since pages import it. */
export type PublicModel = Pick<ModelDefinition, Exclude<(typeof PUBLIC_KEYS)[number], 'effect'>> & {
  effect?: { slots: readonly PublicSlot[] };
};

/** Effect presets for src/models.server.ts. slots may be repeated (same ids, same order) to add prep prompts. */
export type ServerEffect = Omit<EffectSpec, 'slots'> & { slots?: readonly EffectSlot[] };

/** The server-only fields of a model: upstream, cost cap, timeout and effect presets. */
export type ServerModel = Omit<ModelDefinition, keyof PublicModel> & { effect?: ServerEffect };

/** Top-level fields beyond PublicModel become never, so typecheck flags them before the runtime check does. */
type OnlyPublic<T> = { [K in keyof T]: T[K] & Record<Exclude<keyof T[K], keyof PublicModel>, never> };

/**
 * For site.models.ts. Pages import that file, so it ships to the browser: any other field (upstream model, cost cap, prompts)
 * fails typecheck, throws here, and belongs in src/models.server.ts.
 */
export function definePublicModels<const T extends readonly PublicModel[]>(models: T & OnlyPublic<T>): T {
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) throw new Error(`duplicate model id: ${model.id}`);
    ids.add(model.id);
    const leaked = [
      ...Object.keys(model).filter((key) => !(PUBLIC_KEYS as readonly string[]).includes(key)),
      ...Object.keys(model.effect ?? {})
        .filter((key) => key !== 'slots')
        .map((key) => `effect.${key}`),
      ...(model.effect?.slots ?? []).flatMap((slot) =>
        Object.keys(slot)
          .filter((key) => !PUBLIC_SLOT_KEYS.includes(key))
          .map((key) => `slot ${key}`),
      ),
    ];
    if (leaked.length)
      throw new Error(
        `model ${model.id}: ${leaked.join(', ')} would ship to the browser; move it to src/models.server.ts`,
      );
  }
  return models;
}

/** For src/models.server.ts: joins each public model with its server fields by id, then validates the result like defineModels. */
export function serverModels<const T extends readonly PublicModel[]>(
  catalog: T,
  server: { readonly [K in T[number]['id']]: ServerModel },
): ModelDefinition[] {
  const byId: Readonly<Record<string, ServerModel>> = server;
  const extra = Object.keys(byId).filter((id) => !catalog.some((model) => model.id === id));
  if (extra.length) throw new Error(`server models without a public entry: ${extra.join(', ')}`);
  return defineModels(
    catalog.map((model): ModelDefinition => {
      const fields = byId[model.id];
      if (!fields) throw new Error(`model ${model.id}: missing from src/models.server.ts`);
      // A server object passed through a variable escapes the excess-property check, so a repeated price would otherwise win.
      const repeated = Object.keys(fields).filter(
        (key) => key !== 'effect' && (PUBLIC_KEYS as readonly string[]).includes(key),
      );
      if (repeated.length)
        throw new Error(`model ${model.id}: ${repeated.join(', ')} belongs in site.models.ts only`);
      if (Boolean(model.effect) !== Boolean(fields.effect))
        throw new Error(`model ${model.id}: effect must be in both site.models.ts and src/models.server.ts`);
      if (!model.effect || !fields.effect) return { ...fields, ...model, effect: undefined };
      // Server slots may only add prep prompts; everything the page shows must match site.models.ts.
      const publicSlots = model.effect.slots;
      const serverSlots = fields.effect.slots;
      if (
        serverSlots &&
        (serverSlots.length !== publicSlots.length ||
          serverSlots.some(
            (slot, i) =>
              slot.id !== publicSlots[i]?.id ||
              slot.label !== publicSlots[i]?.label ||
              slot.required !== publicSlots[i]?.required,
          ))
      )
        throw new Error(`model ${model.id}: server effect slots must match site.models.ts apart from prep`);
      const slots = serverSlots
        ? publicSlots.map((slot, i) => ({ ...slot, prep: serverSlots[i]?.prep }))
        : publicSlots;
      return { ...fields, ...model, effect: { ...fields.effect, slots } };
    }),
  );
}

function validateEffect(model: ModelDefinition, effect: EffectSpec) {
  const modelId = model.id;
  const slotIds = new Set(effect.slots.map((slot) => slot.id));
  if (slotIds.size !== effect.slots.length) throw new Error(`model ${modelId}: duplicate effect slot`);
  const segmentIds = new Set<string>();
  for (const segment of effect.segments) {
    // prep and prep-<slot> are taken by prep parts and their step names; a segment with one of those IDs would be mixed up with a prep.
    if (segmentIds.has(segment.id) || !/^[a-z0-9_-]+$/.test(segment.id) || /^prep($|-)/.test(segment.id))
      throw new Error(`model ${modelId}: bad segment id ${segment.id}`);
    segmentIds.add(segment.id);
    // A function is called for every slot combination here, so a bad key fails at startup, not on a paid job.
    for (const filled of slotCombinations(segment.slots)) {
      const video = referenceVideoOf(segment, filled);
      if (
        typeof video !== 'string' ||
        !/^(https:\/\/|assets\/[a-z0-9][a-z0-9/_-]*\.mp4$)/.test(video) ||
        video.includes('..')
      )
        throw new Error(
          `model ${modelId}: segment ${segment.id} referenceVideo must be https or assets/*.mp4`,
        );
    }
    if (
      segment.referenceAudio !== undefined &&
      (!/^(https:\/\/|assets\/[a-z0-9][a-z0-9/_-]*\.mp3$)/.test(segment.referenceAudio) ||
        segment.referenceAudio.includes('..'))
    )
      throw new Error(`model ${modelId}: segment ${segment.id} referenceAudio must be https or assets/*.mp3`);
    for (const slot of segment.slots) {
      if (!slotIds.has(slot))
        throw new Error(`model ${modelId}: segment ${segment.id} uses unknown slot ${slot}`);
    }
    if (segment.subjects) {
      const names = Object.values(segment.subjects);
      if (
        Object.keys(segment.subjects).some(
          (slot) => !segment.subjects![slot] || !segment.slots.includes(slot),
        ) ||
        names.some((name) => !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name)) ||
        new Set(names).size !== names.length
      )
        throw new Error(
          `model ${modelId}: segment ${segment.id} subjects must map its slots to distinct names (letters, digits, _)`,
        );
    }
  }
  for (const slot of effect.slots) {
    const views = prepViews(slot);
    if (
      slot.prep !== undefined &&
      (views.length < 1 || views.length > 4 || views.some((view) => !view.trim()))
    )
      throw new Error(`model ${modelId}: slot ${slot.id} prep needs 1–4 prompts`);
  }
  if (effect.describe) {
    const view = effect.describe.view ?? 0;
    if (
      !effect.prep ||
      !effect.describe.instruction.trim() ||
      !Number.isInteger(view) ||
      view < 0 ||
      !effect.slots.some((slot) => view < prepViews(slot).length)
    )
      throw new Error(`model ${modelId}: describe needs prep, an instruction and a view some slot has`);
  }
  // Whole-job cap: even with every segment rendered it must not exceed the model's maxCost. Compared in 1/10000 USD to avoid float error
  // without rounding sub-cent caps (a 0.015 image cap counted as 0.02 would add a cent per image).
  const cents = (value: string) => Math.round(Number(value) * 10000);
  if (effect.prep && !(cents(effect.prep.maxCost) > 0))
    throw new Error(`model ${modelId}: prep needs a positive maxCost`);
  const prepCount = effect.prep ? effect.slots.reduce((sum, slot) => sum + prepViews(slot).length, 0) : 0;
  // A slow prep may run twice (runner PREP_HEDGE_MS).
  const total =
    effect.segments.reduce(
      (sum, segment) =>
        sum +
        cents(segment.maxCost) +
        (segment.repair ? segment.repair.rounds * cents(segment.repair.maxCost) : 0),
      0,
    ) +
    prepCount * 2 * (effect.prep ? cents(effect.prep.maxCost) : 0);
  if (effect.segments.some((segment) => !(cents(segment.maxCost) > 0)))
    throw new Error(`model ${modelId}: every segment needs a positive maxCost`);
  if (model.maxCost === undefined || total > cents(model.maxCost))
    throw new Error(
      `model ${modelId}: segment maxCost sum ${total / 10000} exceeds model maxCost ${model.maxCost}`,
    );
  if (effect.compose) {
    const asset = /^assets\/[a-z0-9][a-z0-9/_.-]*$/;
    if (!asset.test(effect.compose.audio) || effect.compose.audio.includes('..'))
      throw new Error(`model ${modelId}: compose.audio must be an assets/ key`);
    for (const segment of effect.segments) {
      if (!(segment.target! > 0) || !segment.base || !asset.test(segment.base) || segment.base.includes('..'))
        throw new Error(
          `model ${modelId}: segment ${segment.id} needs target and an assets/ base for compose`,
        );
      const cuts = segment.cuts;
      if (
        cuts !== undefined &&
        (cuts.length === 0 ||
          !cuts.every(
            (cut, i) => Number.isFinite(cut) && cut > (i === 0 ? 0 : cuts[i - 1]!) && cut < segment.target!,
          ))
      )
        throw new Error(`model ${modelId}: segment ${segment.id} cuts must increase inside (0, target)`);
    }
  } else if (effect.segments.some((segment) => segment.cuts))
    throw new Error(`model ${modelId}: segment cuts need compose`);
  for (const segment of effect.segments) {
    const check = segment.check;
    if (!check) continue;
    if (!effect.compose) throw new Error(`model ${modelId}: segment ${segment.id} check needs compose`);
    if (!/^assets\/[a-z0-9][a-z0-9/_-]*\.mp4$/.test(check.original) || check.original.includes('..'))
      throw new Error(`model ${modelId}: segment ${segment.id} check.original must be assets/*.mp4`);
    const faces = Object.entries(check.faces);
    const badPoint = (point: FacePoint) =>
      (point.length !== 2 && point.length !== 3) ||
      !point.slice(0, 2).every((value) => value >= 0 && value <= 1) ||
      (point.length === 3 && !(point[2]! >= 0 && point[2]! <= 60));
    if (
      faces.length === 0 ||
      faces.some(([slot, entry]) => {
        const points = Array.isArray(entry) && entry.length > 0 ? pointsOf(entry) : [];
        return (
          !segment.slots.includes(slot) ||
          points.length === 0 ||
          points.length > 4 ||
          points.some((point) => !Array.isArray(point) || badPoint(point))
        );
      })
    )
      throw new Error(
        `model ${modelId}: segment ${segment.id} check.faces must map this segment's slots to 0–1 points (and 0–60 s)`,
      );
    if (!(check.maxSimilarity > 0 && check.maxSimilarity < 1))
      throw new Error(`model ${modelId}: segment ${segment.id} check.maxSimilarity must be between 0 and 1`);
  }
  for (const segment of effect.segments) {
    if (segment.repair) validateRepair(modelId, effect, segment, segment.repair);
  }
  for (const slot of effect.slots) {
    if (!effect.segments.some((segment) => segment.slots.includes(slot.id)))
      throw new Error(`model ${modelId}: slot ${slot.id} is in no segment`);
  }
}

function validateRepair(modelId: string, effect: EffectSpec, segment: EffectSegment, repair: EffectRepair) {
  const where = `model ${modelId}: segment ${segment.id} repair`;
  // The repaired frames are cut from the composed video by the final-cut shot times, and checked against the original over the same timeline.
  if (!segment.check || !segment.cuts || !effect.compose || effect.segments.length !== 1)
    throw new Error(`${where} needs check, cuts and compose with a single segment`);
  if (!Number.isInteger(repair.rounds) || repair.rounds < 1 || repair.rounds > 5)
    throw new Error(`${where}.rounds must be 1–5`);
  if (!(Math.round(Number(repair.maxCost) * 100) > 0)) throw new Error(`${where} needs a positive maxCost`);
  const shots = repair.shots;
  if (
    shots.length !== segment.cuts.length + 1 ||
    shots.some((slots) => slots.some((slot) => !segment.slots.includes(slot)))
  )
    throw new Error(
      `${where}.shots must list this segment's slots for each of its ${segment.cuts.length + 1} shots`,
    );
  // One pass sends the photos of everyone in the group of shots it covers; the replace model takes at most 3.
  if (shots.some((slots) => slots.length > 3 || new Set(slots).size !== slots.length))
    throw new Error(`${where}.shots: at most 3 different people per shot`);
  for (const slot of Object.keys(segment.check.faces)) {
    if (!shots.some((slots) => slots.includes(slot)))
      throw new Error(`${where}: checked slot ${slot} must be in some shot`);
  }
  if (repair.aspect !== undefined && !(repair.aspect > 0.2 && repair.aspect < 5))
    throw new Error(`${where}.aspect must be a width / height ratio`);
  for (const [slot, box] of Object.entries(repair.crops ?? {})) {
    const [x, y, width, height] = box;
    if (
      !segment.slots.includes(slot) ||
      box.length !== 4 ||
      !(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1 && y + height <= 1)
    )
      throw new Error(`${where}.crops must map this segment's slots to boxes inside the frame`);
  }
  for (const [slot, min] of Object.entries(repair.likeness ?? {})) {
    if (repair.onMiss !== 'deliver') throw new Error(`${where}.likeness needs onMiss 'deliver'`);
    if (!shots.some((slots) => slots.includes(slot)) || !(min > 0 && min < 1))
      throw new Error(`${where}.likeness must map slots in some shot to a similarity between 0 and 1`);
  }
}

export function sanitizeParameters(model: PublicModel, input: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = { ...model.defaults };
  if (input && typeof input === 'object') {
    for (const key of model.allowedParameters) {
      const value = (input as Record<string, unknown>)[key];
      if (
        value !== undefined &&
        (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      ) {
        result[key] = value;
      }
    }
  }
  return result;
}

/** Longest lyrics a music job accepts; each model's own limit is checked by the upstream. */
export const MAX_LYRICS = 3000;

/**
 * Music needs exactly one lyrics source: the user's lyrics, an instrumental, or lyrics the model writes from the prompt.
 * Settled once at job creation so the stored input is always a valid request.
 */
export function musicParameters(
  parameters: Record<string, unknown>,
  lyrics: string | undefined,
): Record<string, unknown> {
  const { instrumental, lyrics_optimizer: _, ...rest } = parameters;
  if (lyrics) return rest;
  if (instrumental === true) return { ...rest, instrumental: true };
  return { ...rest, lyrics_optimizer: true };
}

export function creditsFor(model: PublicModel, parameters: Record<string, unknown>): number {
  const value = typeof model.credits === 'function' ? model.credits(parameters) : model.credits;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`model ${model.id}: invalid credit price ${value}`);
  return value;
}

/** One upstream sub-task. Effect jobs resolve their segments at creation; regular model jobs have a single part. */
export interface JobPart {
  id: string;
  /** image for prep segments; defaults to the model's kind. Prep segments come before video segments and finish first. */
  kind?: 'image' | 'video';
  upstreamModel: string;
  prompt: string;
  /** Music only: the user's lyrics. */
  lyrics?: string;
  /**
   * slot: effect video segments name the slot each photo belongs to (missing on parts stored by older versions, where photos follow
   * slots in order); subject: the upstream subject the photo belongs to (segment.subjects).
   */
  references: { url: string; role: string; slot?: string; subject?: string }[];
  parameters: Record<string, unknown>;
  maxCost?: string;
  /** Effect video segments: the filled slots this part swaps, in segment slot order (the output check only looks at these). */
  slots?: string[];
  /** Effect video segments: what each filled slot's photo shows. */
  kinds?: Record<string, SlotKind>;
  /** Effect video segments whose prompt asks for descriptions: the instruction and the image of each slot to describe (prep placeholders). */
  describe?: { instruction: string; images: Record<string, string> };
}

/** A slot's value in a create request: an upload path, or { photo, kind } to say what it shows. Null if malformed. */
function slotInput(value: unknown): { ref: unknown; kind?: SlotKind } | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const { photo, kind } = value as { photo?: unknown; kind?: unknown };
    if (kind !== undefined && kind !== 'person' && kind !== 'pet') return null;
    return { ref: photo, ...(kind ? { kind } : {}) };
  }
  return { ref: value };
}

/**
 * Effects: resolve the segments to render from the slots the user filled. Prompts and reference videos come from site presets, never user input.
 * uploadUrl validates and converts user upload paths (null if invalid); assetUrl turns an R2 key into a public URL.
 * Returns null for invalid slots (missing required, unknown slot, invalid file) or when no segment needs rendering.
 */
export function effectParts(
  model: ModelDefinition,
  slots: unknown,
  uploadUrl: (ref: unknown) => string | null,
  assetUrl: (key: string) => string,
): JobPart[] | null {
  const effect = model.effect;
  if (!effect || !slots || typeof slots !== 'object' || Array.isArray(slots)) return null;
  const filled = new Map<string, string>();
  const kinds: Record<string, SlotKind> = {};
  for (const [slotId, value] of Object.entries(slots)) {
    if (!effect.slots.some((slot) => slot.id === slotId)) return null;
    const input = slotInput(value);
    if (!input) return null;
    const url = uploadUrl(input.ref);
    if (!url) return null;
    filled.set(slotId, url);
    kinds[slotId] = input.kind ?? 'person';
  }
  if (effect.slots.some((slot) => slot.required && !filled.has(slot.id))) return null;
  const parts: JobPart[] = [];
  // Prep segments: one per view of each filled slot with prep; in video segments that slot's reference images are placeholders, replaced
  // with the prep results at submit.
  const views = new Map<string, number>();
  const prep = effect.prep;
  if (prep) {
    for (const slot of effect.slots) {
      if (!filled.has(slot.id)) continue;
      const prompts = prepViews(slot);
      if (prompts.length === 0) continue;
      views.set(slot.id, prompts.length);
      for (const [view, prompt] of prompts.entries())
        parts.push({
          id: prepPartId(slot.id, view),
          kind: 'image',
          upstreamModel: prep.upstreamModel,
          prompt,
          references: [{ url: filled.get(slot.id)!, role: 'reference_image' }],
          parameters: { ...prep.parameters },
          maxCost: prep.maxCost,
        });
    }
  }
  /** The image of a slot's view: a prep placeholder (prep:<slot> for the main view, prep:<slot>-vN after it) or the upload itself. */
  const imageUrl = (slotId: string, view = 0) =>
    views.has(slotId) ? `${PREP_REF}${prepPartId(slotId, view).slice('prep-'.length)}` : filled.get(slotId)!;
  const mediaUrl = (ref: string) => (/^https:\/\//.test(ref) ? ref : assetUrl(ref));
  const describe = effect.describe;
  let rendered = 0;
  for (const segment of effect.segments) {
    const used = segment.slots.filter((slotId) => filled.has(slotId));
    if (used.length === 0) continue;
    rendered++;
    const subject = (slotId: string) => segment.subjects?.[slotId];
    const names = Object.fromEntries(
      used.map((slotId, i) => [slotId, subject(slotId) ? `@${subject(slotId)}` : `@image${i + 1}`]),
    );
    const prompt = segment.prompt(names, {
      kinds: Object.fromEntries(used.map((slotId) => [slotId, kinds[slotId]!])),
      describe: (slotId) => (describe && used.includes(slotId) ? `{{describe:${slotId}}}` : ''),
    });
    const photos = used.flatMap((slotId) => {
      const name = subject(slotId);
      // A subject gets every view of the slot; a plain reference only the main view.
      const count = name ? (views.get(slotId) ?? 1) : 1;
      return Array.from({ length: count }, (_, view) => ({
        url: imageUrl(slotId, view),
        role: 'reference_image',
        slot: slotId,
        ...(name ? { subject: name } : {}),
      }));
    });
    const asked = describedSlots(prompt).filter((slotId) => views.has(slotId));
    parts.push({
      id: segment.id,
      upstreamModel: model.upstreamModel,
      prompt,
      references: [
        { url: mediaUrl(referenceVideoOf(segment, used)), role: 'reference_video' },
        ...photos,
        ...(segment.referenceAudio
          ? [{ url: mediaUrl(segment.referenceAudio), role: 'reference_audio' }]
          : []),
      ],
      parameters: { ...segment.parameters },
      maxCost: segment.maxCost,
      slots: used,
      kinds: Object.fromEntries(used.map((slotId) => [slotId, kinds[slotId]!])),
      ...(describe && asked.length > 0
        ? {
            describe: {
              instruction: describe.instruction,
              images: Object.fromEntries(
                asked.map((slotId) => [
                  slotId,
                  imageUrl(slotId, Math.min(describe.view ?? 0, views.get(slotId)! - 1)),
                ]),
              ),
            },
          }
        : {}),
    });
  }
  return rendered > 0 ? parts : null;
}

/** Placeholder prefix for video segment reference images: `prep:<slot>` is replaced with that slot's prep result URL at submit. */
export const PREP_REF = 'prep:';

/** A job's stored input_json. */
interface JobInput {
  references?: { url: string; role: string }[];
  parameters?: Record<string, unknown>;
  /** Music jobs: the user's lyrics. */
  lyrics?: string;
  parts?: JobPart[];
}

export function partsOf(job: { prompt: string; inputJson: string }, model: ModelDefinition): JobPart[] {
  const input = JSON.parse(job.inputJson) as JobInput;
  if (input.parts?.length) return input.parts;
  return [
    {
      id: 'main',
      upstreamModel: model.upstreamModel,
      prompt: job.prompt,
      ...(input.lyrics ? { lyrics: input.lyrics } : {}),
      references: input.references ?? [],
      parameters: input.parameters ?? {},
      ...(model.maxCost ? { maxCost: model.maxCost } : {}),
    },
  ];
}
