// Repair planning for effect segments whose output check found original people (segment.repair): which shots and slots the next pass covers.
// Pure functions; the runner executes the passes and the compose container cuts and blends the frames.

import { type CropBox, type EffectRepair, type FacePoint, pointsOf } from './models';

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
 * The next pass for the first still-failing slot, or null when no failing slot can be repaired.
 * A pass re-renders one group of shots (shotGroups) with the photos of every filled slot in it; the model replaces the most prominent
 * people first, and handing it everyone keeps it from putting one person's face on another. Groups where the check saw the original
 * (where: slot → shot indices) come first, then the slot's other groups not yet re-rendered. After that, when the slot has a crop box and
 * its first group has had a whole-frame pass, the pass repairs that box alone; otherwise the slot's groups take turns again (with a new seed).
 */
export function nextRepairPass(
  repair: EffectRepair,
  filled: readonly string[],
  failing: readonly string[],
  done: readonly RepairPass[],
  where: Readonly<Record<string, readonly number[]>> = {},
): RepairPass | null {
  const slot = failing.find((candidate) => repair.shots.some((slots) => slots.includes(candidate)));
  if (!slot) return null;
  const groups = shotGroups(repair.shots).filter((group) => group.slots.includes(slot));
  const same = (pass: RepairPass, group: { shots: number[] }) => pass.shots.join() === group.shots.join();
  const covered = (group: { shots: number[] }) => done.some((pass) => !pass.crop && same(pass, group));
  const seen = where[slot] ?? [];
  const flagged = groups.filter((group) => group.shots.some((shot) => seen.includes(shot)));
  const whole = (group: { shots: number[]; slots: string[] }): RepairPass => ({
    slots: filled.filter((candidate) => group.slots.includes(candidate)),
    shots: group.shots,
  });
  const fresh = [...flagged, ...groups].find((group) => !covered(group));
  if (fresh) return whole(fresh);
  const crop = repair.crops?.[slot];
  const first = groups[0]!;
  if (crop && (flagged.length === 0 || flagged.includes(first)))
    return { slots: [slot], shots: first.shots, crop };
  const turn = flagged.length > 0 ? flagged : groups;
  const before = done.filter((pass) => turn.some((group) => same(pass, group))).length;
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
 * trimmed by `margin` seconds at inner cuts so a cut that came out a few frames late doesn't mix in the next shot. Points the repair shots
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
    return group.shots.map((index): [number, number] => [
      index === 0 ? 0 : bounds[index]! + margin,
      index === cuts.length ? end : bounds[index + 1]! - margin,
    ]);
  });
}

/** Shot index of a time (seconds) on the segment's timeline, given its cuts. */
export function shotAt(cuts: readonly number[], seconds: number): number {
  const index = cuts.findIndex((cut) => seconds < cut);
  return index === -1 ? cuts.length : index;
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
