// Repair planning for effect segments whose output check found original people (segment.repair): which shots and slots the next pass covers.
// Pure functions; the runner executes the passes and the compose container cuts and blends the frames.

import {
  type CropBox,
  type EffectRepair,
  type EffectSegment,
  type FacePoint,
  likenessRule,
  pointsOf,
  type SlotKind,
  shotAt,
  shotSpots,
} from './models';
import type { SubmitInput } from './upstream';

export { shotAt };

/** The check points of the given slots, flattened in slot order, and whose each one is. */
export function checkPoints(
  faces: Readonly<Record<string, FacePoint | readonly FacePoint[]>>,
  slots: readonly string[],
): { points: FacePoint[]; owners: string[] } {
  const points: FacePoint[] = [];
  const owners: string[] = [];
  for (const slot of slots) {
    for (const point of faces[slot] ? pointsOf(faces[slot]) : []) {
      points.push(point);
      owners.push(slot);
    }
  }
  return { points, owners };
}

/**
 * Read a swap check: slots with any point at or above maxSimilarity still show the original. where: for each of those slots, the shots
 * (by the points' times on the segment timeline) where the original was seen. Scores are per point, as checkPoints listed them.
 */
export function judgeCheck(
  faces: Readonly<Record<string, FacePoint | readonly FacePoint[]>>,
  slots: readonly string[],
  scores: readonly number[],
  maxSimilarity: number,
  cuts: readonly number[] = [],
): { missed: string[]; where: Record<string, number[]> } {
  const { points, owners } = checkPoints(faces, slots);
  const where: Record<string, number[]> = {};
  points.forEach((point, i) => {
    if (!((scores[i] ?? 0) >= maxSimilarity)) return;
    const shot = shotAt(cuts, point[2] ?? 0);
    const owner = owners[i]!;
    const seen = where[owner] ?? [];
    if (!seen.includes(shot)) where[owner] = [...seen, shot];
  });
  return { missed: slots.filter((slot) => where[slot]), where };
}

/**
 * Slots still missed after both checks: a face the swap check matched to the original but that clearly looks like the user's photo is a
 * false alarm (a profile shot keeps the original's outline), as long as the likeness check scored every shot the original was seen in
 * (where; scored: slot → its likeness shots, all of them when absent); a face the likeness check missed (unlike its photo, or closer to
 * another filled slot's photo) is missed however it scored. In `slots` order.
 */
export function missedAfterLikeness(
  slots: readonly string[],
  faceMissed: readonly string[],
  likeness: { missed: readonly string[]; passed: readonly string[] },
  where: Readonly<Record<string, readonly number[]>> = {},
  scored: Readonly<Record<string, readonly number[]>> = {},
): string[] {
  // A pass on the wide shots says nothing about an original left in another shot's corner.
  const cleared = (slot: string) =>
    likeness.passed.includes(slot) &&
    (!scored[slot] || (where[slot] ?? []).every((shot) => scored[slot]!.includes(shot)));
  return slots.filter(
    (slot) => (faceMissed.includes(slot) && !cleared(slot)) || likeness.missed.includes(slot),
  );
}

/** Slot → the shots its repair.likeness threshold is scored in. */
export function likenessShots(repair: EffectRepair): Record<string, number[]> {
  return Object.fromEntries(
    Object.keys(repair.likeness ?? {}).map((slot) => [slot, likenessRule(repair, slot)!.shots]),
  );
}

/** The photo the check and repair use for a slot: its first image (the main prep view), by slot name, or by position in older parts. */
export function photoOf(
  references: readonly { url: string; role: string; slot?: string }[],
  slots: readonly string[],
  slot: string,
): string | undefined {
  const images = references.filter((ref) => ref.role === 'reference_image');
  if (images.some((ref) => ref.slot)) return images.find((ref) => ref.slot === slot)?.url;
  return images[slots.indexOf(slot)]?.url;
}

export interface RepairPass {
  /** Slots replaced in this pass, in reference image order. */
  slots: string[];
  /** Shot indices this pass re-renders. */
  shots: number[];
  /** Set when the pass repairs one person's box instead of the whole frame. */
  crop?: CropBox;
}

/**
 * The upstream request of one repair pass: the cut-out shots (with their soundtrack) as reference_video and the photo of each slot the
 * pass replaces as reference_image, in the pass's slot order. A new seed each pass: the same frames with the same seed may come back the same.
 */
export function repairInput(
  repair: EffectRepair,
  pass: RepairPass,
  kinds: Readonly<Record<string, SlotKind>>,
  clipUrl: string,
  photos: readonly string[],
  round: number,
): SubmitInput {
  return {
    upstreamModel: repair.upstreamModel,
    kind: 'video',
    prompt: repair.prompt(pass.slots, kinds, pass.shots),
    references: [
      { url: clipUrl, role: 'reference_video' },
      ...photos.map((url) => ({ url, role: 'reference_image' })),
    ],
    parameters: { ...repair.parameters, seed: round + 1 },
    maxCost: repair.maxCost,
  };
}

/** Shots with the same people, in order of first appearance: one pass re-renders a group with the photos of everyone in it. */
export function shotGroups(shots: readonly (readonly string[])[]): { shots: number[]; slots: string[] }[] {
  const groups: { key: string; shots: number[]; slots: string[] }[] = [];
  shots.forEach((slots, i) => {
    const key = [...slots].sort().join();
    const group = groups.find((candidate) => candidate.key === key);
    if (group) group.shots.push(i);
    else groups.push({ key, shots: [i], slots: [...slots] });
  });
  return groups.map(({ shots: indices, slots }) => ({ shots: indices, slots }));
}

/**
 * The next pass for the still-failing slot that has had the fewest passes (the first in `failing` order on a tie), or null when no
 * failing slot can be repaired: with one person per pass, a person who keeps failing must not use up the rounds of another.
 * A pass re-renders one group of shots (shotGroups) and replaces that one slot, with its photo alone: the replace model redraws whole
 * people, and given several photos at once it rewrote mouths and gestures of everyone in the frame. Shots of a group share their
 * framing, so a person gets one face and one set of accessories across them. Groups where the check saw the original
 * (where: slot → shot indices) come first, then the slot's other groups it has not had a pass on. After that, when the slot has a crop
 * box and its first group has had a whole-frame pass for it, the pass repairs that box alone; otherwise the slot's groups take turns
 * again (with a new seed). focus (slot → shot indices) limits a slot to the groups with those shots.
 */
export function nextRepairPass(
  repair: EffectRepair,
  filled: readonly string[],
  failing: readonly string[],
  done: readonly RepairPass[],
  where: Readonly<Record<string, readonly number[]>> = {},
  focus: Readonly<Record<string, readonly number[]>> = {},
): RepairPass | null {
  // Unfilled slots keep the original person on purpose and are never repaired.
  const candidates = failing.filter(
    (candidate) => filled.includes(candidate) && repair.shots.some((slots) => slots.includes(candidate)),
  );
  const tries = (candidate: string) => done.filter((pass) => pass.slots.includes(candidate)).length;
  const slot = candidates.reduce<string | undefined>(
    (best, candidate) => (best === undefined || tries(candidate) < tries(best) ? candidate : best),
    undefined,
  );
  if (!slot) return null;
  const all = shotGroups(repair.shots).filter((group) => group.slots.includes(slot));
  // A slot missed for its likeness is repaired only where that was scored (plus where the original was seen): a pass elsewhere can't
  // change its score.
  const aimed = focus[slot]
    ? all.filter((group) => group.shots.some((shot) => focus[slot]!.includes(shot)))
    : all;
  const groups = aimed.length > 0 ? aimed : all;
  const same = (pass: RepairPass, group: { shots: number[] }) => pass.shots.join() === group.shots.join();
  const mine = done.filter((pass) => pass.slots.includes(slot));
  const covered = (group: { shots: number[] }) => mine.some((pass) => !pass.crop && same(pass, group));
  const seen = where[slot] ?? [];
  const flagged = groups.filter((group) => group.shots.some((shot) => seen.includes(shot)));
  const whole = (group: { shots: number[] }): RepairPass => ({ slots: [slot], shots: group.shots });
  const fresh = [...flagged, ...groups].find((group) => !covered(group));
  if (fresh) return whole(fresh);
  // The crop box belongs to the slot's first group of all; a focus that leaves that group out never uses it.
  const crop = groups.includes(all[0]!) ? repair.crops?.[slot] : undefined;
  const first = groups[0]!;
  if (crop && (flagged.length === 0 || flagged.includes(first)))
    return { slots: [slot], shots: first.shots, crop };
  const turn = flagged.length > 0 ? flagged : groups;
  const before = mine.filter((pass) => turn.some((group) => same(pass, group))).length;
  return whole(turn[before % turn.length]!);
}

/**
 * A crop box widened or heightened around its center to width / height = aspect (in pixels of a width×height frame), shifted back inside
 * the frame and shrunk to fit it if needed, so a replace model that renders at that aspect has nothing to crop away.
 */
export function fitAspect(box: CropBox, aspect: number, width: number, height: number): CropBox {
  let w = box[2] * width;
  let h = box[3] * height;
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  if (w > width) {
    w = width;
    h = w / aspect;
  }
  if (h > height) {
    h = height;
    w = h * aspect;
  }
  const cx = (box[0] + box[2] / 2) * width;
  const cy = (box[1] + box[3] / 2) * height;
  const x = Math.min(Math.max(cx - w / 2, 0), width - w);
  const y = Math.min(Math.max(cy - h / 2, 0), height - h);
  return [x / width, y / height, w / width, h / height];
}

/**
 * Where each check point looks on the output: the shots of its group (shotGroups of the repair shots containing the point's shot), each
 * trimmed by `margin` seconds (at most a quarter of the shot) at inner cuts so a cut that came out a few frames late doesn't mix in the next shot. Points the repair shots
 * don't cover (or a slot not in the point's shot) look everywhere: [[0, end]].
 */
export function checkWindows(
  points: readonly FacePoint[],
  owners: readonly string[],
  shots: readonly (readonly string[])[],
  cuts: readonly number[],
  end: number,
  margin = 0.3,
): [number, number][][] {
  const bounds = [0, ...cuts, end];
  const groups = shotGroups(shots);
  return points.map((point, i) => {
    const shot = shotAt(cuts, point[2] ?? 0);
    const group = groups.find((candidate) => candidate.shots.includes(shot));
    if (!group || !group.slots.includes(owners[i]!)) return [[0, end]];
    return group.shots.map((index): [number, number] => {
      const trim = Math.min(margin, (bounds[index + 1]! - bounds[index]!) / 4);
      return [
        index === 0 ? 0 : bounds[index]! + trim,
        index === cuts.length ? end : bounds[index + 1]! - trim,
      ];
    });
  });
}

/**
 * Frame ranges [start, end) of the given shots in the final cut, adjacent shots merged.
 * Shot i runs from cut i - 1 (0 for the first) to cut i (target for the last). Compose rounds each shot's length to frames on its own
 * (splitAtCuts, buildFfmpegArgs), so the bounds add those up rather than rounding each cut time.
 */
export function shotFrames(
  cuts: readonly number[],
  target: number,
  fps: number,
  shots: readonly number[],
): [number, number][] {
  const times = [0, ...cuts, target];
  const bounds = [0];
  for (let i = 1; i < times.length; i++)
    bounds.push(bounds[i - 1]! + Math.round((times[i]! - times[i - 1]!) * fps));
  const ranges: [number, number][] = [];
  for (const shot of [...shots].sort((a, b) => a - b)) {
    const start = bounds[shot]!;
    const end = bounds[shot + 1]!;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === start) last[1] = end;
    else ranges.push([start, end]);
  }
  return ranges;
}

/**
 * How much more another person's photo must match a slot's face than the slot's own photo before the slot counts as swapped: two
 * customers can look alike. Stored tiny-desk renders: a wrong person beat their own photo by 0.3–0.56, a look-alike at a small
 * back-row face by 0.41, right people by under 0.15.
 */
export const SWAP_MARGIN = 0.2;

/** One likeness slot to score: its threshold, the people whose photos are scored on its face (itself first), and where to look. */
export interface LikenessAsk {
  slot: string;
  min: number;
  /** The slot, then every other filled person (pets left out): one score each, in this order. */
  photos: string[];
  /** Seconds [start, end), one per likeness shot. */
  ranges: [number, number][];
  /** Per range, the spots of that shot as [x, y], the slot's own first; absent when a shot has no point for the slot. */
  spots?: [number, number][][];
}

/**
 * The likeness check of a composed video (repair.likeness): for each filled person with a threshold, the shots it is scored in (one
 * range each, so each carries its own shot's spots) and the photos scored on that face. Pets are skipped: SFace is a human face model
 * and animals of a kind match each other.
 */
export function likenessAsks(
  segment: Pick<EffectSegment, 'cuts' | 'target' | 'check'> & { repair: EffectRepair },
  fps: number,
  filled: readonly string[],
  kinds: Readonly<Record<string, SlotKind>>,
): LikenessAsk[] {
  const { repair, cuts, target, check } = segment;
  const people = filled.filter((slot) => kinds[slot] !== 'pet');
  return people.flatMap((slot) => {
    const rule = likenessRule(repair, slot);
    if (!rule || !cuts || target === undefined || !check) return [];
    const ranges: [number, number][] = [];
    const spots: [number, number][][] = [];
    for (const shot of rule.shots) {
      const [start, end] = shotFrames(cuts, target, fps, [shot])[0]!;
      const here = shotSpots(check.faces, repair.shots, cuts, shot);
      ranges.push([start / fps, end / fps]);
      spots.push(
        [slot, ...repair.shots[shot]!.filter((other) => other !== slot)].flatMap((who) =>
          here[who] ? [here[who]] : [],
        ),
      );
    }
    // Validated configs have every spot; a range without the slot's own would score someone else, so then score the best face instead.
    const spotted = rule.shots.every((shot) => shotSpots(check.faces, repair.shots, cuts, shot)[slot]);
    return [
      {
        slot,
        min: rule.min,
        photos: [slot, ...people.filter((other) => other !== slot)],
        ranges,
        ...(spotted ? { spots } : {}),
      },
    ];
  });
}

/**
 * Read likeness scores (one per photo of each ask, in order): a slot whose own score is under its threshold, or whose face another
 * person's photo matches by more than SWAP_MARGIN better, is missed; a slot with no score (no face in the photo or in its spot) is neither.
 */
export function judgeLikeness(
  asks: readonly LikenessAsk[],
  scores: readonly (number | null)[],
): { missed: string[]; passed: string[]; swapped: string[] } {
  const verdict = { missed: [] as string[], passed: [] as string[], swapped: [] as string[] };
  let at = 0;
  for (const { slot, min, photos } of asks) {
    const own = scores[at];
    const others = scores.slice(at + 1, at + photos.length).filter((score): score is number => score != null);
    at += photos.length;
    if (own == null) continue;
    // In thousandths: scores come rounded to 3 places, and 0.47 + 0.2 is 0.6699999999999999 in floating point.
    if (others.some((score) => Math.round((score - own) * 1000) > Math.round(SWAP_MARGIN * 1000)))
      verdict.swapped.push(slot);
    if (own < min || verdict.swapped.includes(slot)) verdict.missed.push(slot);
    else verdict.passed.push(slot);
  }
  return verdict;
}
