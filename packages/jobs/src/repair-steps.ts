import {
  activeJob,
  appendUpstreamJob,
  cancelAll,
  loadJob,
  type StoredOutput,
  upstreamIds,
} from './lifecycle';
import { type FacePoint, partsOf, type SlotKind } from './models';
import {
  checkPoints,
  checkWindows,
  fitAspect,
  judgeCheck,
  missedAfterLikeness,
  nextRepairPass,
  photoOf,
  type RepairPass,
  shotFrames,
} from './repair';
import type { RunnerDeps, StepRunner } from './runner';
import type { JobRow } from './schema';
import type { PollResult, SubmitInput, UpstreamAdapter } from './upstream';
import { UpstreamError } from './upstream';

// Repair passes after compose (segment.repair) and the likeness check that can ask for them. Run inside one job's runner:
// RepairContext carries what they share with it. Step names are Workflow cache keys and must not change.

export interface SegmentCheck {
  maxSimilarity: number;
  /** Missing on checks cached by older versions (per-second SSIM): those jobs are delivered unchecked. */
  original?: string;
  faces?: Readonly<Record<string, FacePoint | readonly FacePoint[]>>;
  seconds: number;
  /** The segment has repair passes; missing on loads cached by older versions, whose missed swaps are refunded as before. */
  repair?: boolean;
  /**
   * The segment has a likeness check (repair.likeness); missing on loads cached by older versions. A job already in its repair passes
   * when likeness shipped must not start checking it on replay: a new miss would change which pass its cached steps belong to.
   */
  likeness?: boolean;
}

/** What repair passes share with the job's runner. */
export interface RepairContext {
  deps: RunnerDeps;
  jobId: string;
  step: StepRunner;
  adapter: UpstreamAdapter;
  /** The model ID from the cached load; the repair config is read from the current config. */
  modelId: string;
  checks: Record<string, SegmentCheck> | undefined;
  /** Segments in the job: repair tasks are recorded in upstream_job_id after them. */
  partCount: number;
  deadline: number;
  fail: (code: string, message: string) => Promise<unknown>;
  timeOut: () => Promise<unknown>;
  submitInput: (job: JobRow, index: number) => SubmitInput;
  pollUntilDone: (
    upstreamJobId: string,
    label: string | null,
  ) => Promise<Exclude<PollResult, { state: 'running' }> | { state: 'stopped' } | { state: 'timeout' }>;
  /** Mark the job for a human look after it is delivered (people still missed or on the wrong face). */
  review: (reason: string) => void;
}

/** A likeness check: slots that don't look like their photo (or look more like someone else's), and slots that clearly do. */
interface Likeness {
  missed: string[];
  passed: string[];
  /** Slots whose face looks more like another filled slot's photo than their own: the model put the wrong person there. */
  swapped: string[];
}

const NO_LIKENESS: Likeness = { missed: [], passed: [], swapped: [] };

/**
 * Filled slots of a composed video that don't look enough like their photos (repair.likeness), each scored over the shots it is in,
 * and against every other filled slot's photo over the same shots: a face closer to someone else's photo than to its own is a swap.
 * Soft by design: a check error or a photo with no face counts as no miss, so this only ever adds repair passes, never fails or refunds.
 */
async function unlike(
  ctx: RepairContext,
  stepName: string,
  partId: string,
  index: number,
  key: string,
): Promise<Likeness> {
  const { deps, jobId, step } = ctx;
  const effect = deps.models.find((m) => m.id === ctx.modelId)?.effect;
  const segment = effect?.segments.find((candidate) => candidate.id === partId);
  const repair = segment?.repair;
  const fps = effect?.compose?.fps;
  if (
    !ctx.checks?.[partId]?.likeness ||
    !repair?.likeness ||
    repair.onMiss !== 'deliver' ||
    !segment?.cuts ||
    !fps ||
    !deps.composer
  )
    return NO_LIKENESS;
  const { likeness, shots } = repair;
  const { cuts, target } = segment;
  const result = await step
    .do(stepName, async (): Promise<Likeness> => {
      const row = await activeJob(deps.db, jobId);
      if (!row) return NO_LIKENESS;
      const model = deps.models.find((m) => m.id === row.modelId)!;
      const filled = partsOf(row, model)[index]!.slots ?? [];
      const references = ctx.submitInput(row, index).references;
      const slots = filled.filter((slot) => likeness[slot] !== undefined);
      if (slots.length === 0) return NO_LIKENESS;
      // Site uploads (the photo itself when prep fell back to it) are read from the bucket, not over HTTP from the site.
      const files = deps.fileUrl?.('') ?? null;
      const photo = (slot: string) => {
        const url = photoOf(references, filled, slot)!;
        return files && url.startsWith(files) ? { key: url.slice(files.length) } : { url };
      };
      // Per likeness slot: its own photo first, then each other filled slot's photo, all over the likeness slot's shots.
      const people = slots.flatMap((slot) => {
        const ofSlot = shots.flatMap((inShot, i) => (inShot.includes(slot) ? [i] : []));
        const ranges = shotFrames(cuts, target!, fps, ofSlot).map(
          ([start, end]) => [start / fps, end / fps] as [number, number],
        );
        return [slot, ...filled.filter((other) => other !== slot)].map((who) => ({
          photo: photo(who),
          ranges,
        }));
      });
      const scores = await deps.composer!.likeness({ jobId, key, people });
      deps.log?.('likeness checked', { jobId, part: partId, key, slots, scores });
      const verdict: Likeness = { missed: [], passed: [], swapped: [] };
      let at = 0;
      for (const slot of slots) {
        const own = scores[at];
        const others = scores
          .slice(at + 1, at + filled.length)
          .filter((score): score is number => score != null);
        at += filled.length;
        if (own == null) continue;
        if (others.some((score) => score > own)) verdict.swapped.push(slot);
        if (own < likeness[slot]! || verdict.swapped.includes(slot)) verdict.missed.push(slot);
        else verdict.passed.push(slot);
      }
      return verdict;
    })
    .catch((error: unknown) => {
      deps.log?.('likeness check errored', { jobId, part: partId, key, error: String(error) });
      return NO_LIKENESS;
    });
  // Steps cached by versions before the swap check returned the missed slots alone.
  return Array.isArray(result) ? { missed: result as string[], passed: [], swapped: [] } : result;
}

/**
 * Repair passes after compose for a segment whose check found original people, or whose people don't look enough like their photos
 * (segment.repair, the only segment, so the composed video shares the original clip's timeline). Each pass cuts the shots of one missed slot out of the composed video, has the replace model
 * re-render them with the photos, puts them back and checks every filled slot again; nextRepairPass picks whole frame or one person's box.
 * The upstream tasks are recorded after the segments, so cancel, abort and cost cover them. When the passes run out, the model rejects
 * or fails a pass, or nothing is left that a pass can cover, the job fails swap_not_applied with a refund; under repair.onMiss
 * 'deliver' it delivers the best checked version instead, and so on a timeout or a check error during the passes.
 * Returns the delivered outputs (the compose keys, overwritten), or null if the job has ended.
 */
export async function repairOutputs(
  ctx: RepairContext,
  partId: string,
  index: number,
  check: SegmentCheck,
  initial: string[],
  composed: StoredOutput[],
  initialWhere: Readonly<Record<string, readonly number[]>> = {},
): Promise<StoredOutput[] | null> {
  const { deps, jobId, step, adapter, deadline, fail, timeOut, pollUntilDone } = ctx;
  let missed = initial;
  let where: Readonly<Record<string, readonly number[]>> = initialWhere;
  const notApplied = (why: string) => () =>
    fail(
      'swap_not_applied',
      `${partId} still shows an original face after repair (${why}): ${missed.join(', ')}`.slice(0, 500),
    );
  // Read from the current config: the repair functions can't be cached in a step. A config that dropped repair refunds as before.
  const effect = deps.models.find((m) => m.id === ctx.modelId)?.effect;
  const segment = effect?.segments.find((candidate) => candidate.id === partId);
  const repair = segment?.repair;
  const compose = effect?.compose;
  if (!segment?.cuts || !repair || !compose || !check.original || !check.faces) {
    // Nothing missed the swap: deliver as composed, a likeness miss alone is never refunded.
    if (initial.length === 0) return composed;
    await notApplied('repair is no longer configured')();
    return null;
  }
  const { width, height, fps } = compose;
  const { cuts } = segment;
  const work = (name: string) => `jobs/${jobId}/repair-${partId}-${name}.mp4`;
  const passes: RepairPass[] = [];
  let current = composed[0]!.key;
  let silent = composed[1]!.key;
  const first = await unlike(ctx, `likeness:${partId}`, partId, index, current);
  missed = missedAfterLikeness(
    [...initial, ...first.missed.filter((slot) => !initial.includes(slot))],
    initial,
    first,
  );
  if (first.swapped.length > 0)
    deps.log?.('faces swapped between slots', { jobId, part: partId, slots: first.swapped });
  if (missed.length === 0) return composed;
  /** Copy a version over the compose keys (the delivered outputs). */
  const deliver = (stepName: string, song: string, quiet: string) =>
    step.do(stepName, async () => {
      for (const [output, source] of [
        [composed[0]!, song],
        [composed[1]!, quiet],
      ] as const) {
        if (source === output.key) continue;
        const object = await deps.bucket.get(source);
        if (!object) throw new Error(`repair output missing: ${source}`);
        await deps.bucket.put(output.key, await object.arrayBuffer(), {
          httpMetadata: { contentType: 'video/mp4' },
        });
      }
      return true;
    });
  // The checked version with the fewest missed people so far; a tie keeps the earlier one.
  let best = { song: current, silent, missed, swapped: first.swapped };
  /**
   * The passes can't finish the swap. By default the job fails (`failure`, with a refund); under onMiss 'deliver' the paid render
   * has been charged, so the best checked version is delivered and the credits are kept.
   */
  const giveUp = async (why: string, failure: () => Promise<unknown>): Promise<StoredOutput[] | null> => {
    if (repair.onMiss !== 'deliver') {
      await failure();
      return null;
    }
    deps.log?.('repair gave up, delivering the best version', {
      jobId,
      part: partId,
      why,
      missed: best.missed.length,
    });
    ctx.review(
      `${partId}: delivered with ${best.missed.join(', ') || 'nobody'} not swapped or not like their photo` +
        (best.swapped.length ? ` (${best.swapped.join(', ')} on another person's face)` : '') +
        ` after ${why}`,
    );
    // A pass can still be running upstream (the deadline passed while polling it): cancel it as a failure would, so it stops billing.
    await step.do(`repair:${partId}:cancel-passes`, async () => {
      const row = await loadJob(deps.db, jobId);
      if (row) await cancelAll(adapter, upstreamIds(row));
      return true;
    });
    return (await deliver(`repair:${partId}:deliver-best`, best.song, best.silent)) ? composed : null;
  };
  const runPasses = async (): Promise<StoredOutput[] | null> => {
    for (let round = 0; round < repair.rounds; round++) {
      const label = `repair:${partId}:${round}`;
      const job = await step.do(`${label}:plan`, async () => {
        const row = await activeJob(deps.db, jobId);
        if (!row) return null;
        const model = deps.models.find((m) => m.id === row.modelId)!;
        const part = partsOf(row, model)[index]!;
        const references = ctx.submitInput(row, index).references;
        const slots = part.slots ?? [];
        return {
          slots,
          photos: slots.map((slot) => photoOf(references, slots, slot)!),
          kinds: part.kinds ?? {},
        };
      });
      if (!job) return null;
      const pass = nextRepairPass(repair, job.slots, missed, passes, where);
      if (!pass) return giveUp('no pass covers them', notApplied('no pass covers them'));
      passes.push(pass);
      const ranges = shotFrames(cuts, segment.target!, fps, pass.shots);
      const cut = {
        jobId,
        key: current,
        ranges,
        // The box is cut at the replace model's aspect so it renders all of it and lines up when blended back.
        ...(pass.crop
          ? { crop: repair.aspect ? fitAspect(pass.crop, repair.aspect, width, height) : pass.crop }
          : {}),
        width,
        height,
        fps,
      };
      const clip = await step.do(`${label}:extract`, async () => {
        const bytes = await deps.composer!.extract(cut);
        await deps.bucket.put(work(String(round)), bytes, { httpMetadata: { contentType: 'video/mp4' } });
        return work(String(round));
      });
      const position = ctx.partCount + round;
      const submitted = await step.do(`${label}:submit`, async () => {
        const row = await activeJob(deps.db, jobId);
        if (!row) return { done: true as const };
        const existing = upstreamIds(row)[position];
        if (existing) return { upstreamJobId: existing };
        if (Date.now() > deadline) return { timeout: true as const };
        const input: SubmitInput = {
          upstreamModel: repair.upstreamModel,
          kind: 'video',
          // Plans cached by versions before slot kinds have none: everyone is a person, as before.
          prompt: repair.prompt(pass.slots, (job as { kinds?: Record<string, SlotKind> }).kinds ?? {}),
          references: [
            { url: deps.fileUrl!(clip), role: 'reference_video' },
            ...pass.slots.map((slot) => ({
              url: job.photos[job.slots.indexOf(slot)]!,
              role: 'reference_image',
            })),
          ],
          // A new seed each pass: the same frames with the same seed may come back the same.
          parameters: { ...repair.parameters, seed: round + 1 },
          maxCost: repair.maxCost,
        };
        try {
          const { upstreamJobId } = await adapter.submit(input, `${jobId}:${partId}:repair:${round}`);
          if (!(await appendUpstreamJob(deps.db, jobId, position, upstreamJobId))) {
            await adapter.cancel(upstreamJobId).catch(() => undefined);
            return { done: true as const };
          }
          return { upstreamJobId };
        } catch (error) {
          if (error instanceof UpstreamError && !error.retryable) return { rejected: error.code };
          throw error;
        }
      });
      if ('done' in submitted) return null;
      if ('timeout' in submitted) return giveUp('timed out', timeOut);
      if ('rejected' in submitted) {
        const why = `pass ${round} rejected: ${submitted.rejected}`;
        return giveUp(why, notApplied(why));
      }
      const result = await pollUntilDone(submitted.upstreamJobId, label);
      if (result.state === 'stopped') return null;
      if (result.state === 'timeout') return giveUp('timed out', timeOut);
      if (result.state === 'failed' || !result.files[0]) {
        const why = `pass ${round} failed: ${result.state === 'failed' ? result.code : 'no output'}`;
        return giveUp(why, notApplied(why));
      }
      const file = result.files[0];
      const patchKey = await step.do(`${label}:store`, async () => {
        const response = await (deps.fetcher ?? fetch)(file.url);
        if (!response.ok || !response.body)
          throw new Error(`download repair ${round} failed: ${response.status}`);
        await deps.bucket.put(work(`${round}-out`), response.body, {
          httpMetadata: { contentType: 'video/mp4' },
        });
        return work(`${round}-out`);
      });
      const patched = await step.do(`${label}:patch`, async () => {
        const { song, silent: quiet } = await deps.composer!.patch({
          ...cut,
          name: `${jobId}-repair-${partId}-${round}`,
          patchKey,
        });
        const meta = { httpMetadata: { contentType: 'video/mp4' } };
        await deps.bucket.put(work(`${round}-song`), song, meta);
        await deps.bucket.put(work(`${round}-silent`), quiet, meta);
        return { song: work(`${round}-song`), silent: work(`${round}-silent`) };
      });
      current = patched.song;
      silent = patched.silent;
      const slots = job.slots.filter((slot) => check.faces![slot]);
      const { points, owners } = checkPoints(check.faces!, slots);
      const scores = await step
        .do(`${label}:check`, () =>
          deps.composer!.faces({
            jobId,
            key: current,
            originalKey: check.original!,
            points,
            seconds: segment.target!,
            windows: checkWindows(points, owners, repair.shots, cuts, segment.target!),
          }),
        )
        .catch((error: unknown) => ({ errored: String(error) }));
      // An unchecked video may have lost people the last check passed, so it is never delivered; best is the last checked version.
      if ('errored' in scores)
        return giveUp(`pass ${round} could not be checked`, () =>
          fail(
            'check_failed',
            `${partId} repair ${round} could not be checked: ${scores.errored}`.slice(0, 500),
          ),
        );
      deps.log?.('repair pass checked', { jobId, part: partId, round, pass, scores });
      const unlikeNow = await unlike(ctx, `${label}:likeness`, partId, index, current);
      const judged = judgeCheck(check.faces!, slots, scores, check.maxSimilarity, cuts);
      where = judged.where;
      missed = missedAfterLikeness(job.slots, judged.missed, unlikeNow);
      if (missed.length < best.missed.length)
        best = { song: current, silent, missed, swapped: unlikeNow.swapped };
      if (missed.length > 0) continue;
      return (await deliver(`${label}:deliver`, current, silent)) ? composed : null;
    }
    return giveUp(`${repair.rounds} passes`, notApplied(`${repair.rounds} passes`));
  };
  try {
    return await runPasses();
  } catch (error) {
    // A pass step that throws after its Workflow retries (status reads, the download, the container's extract or patch) fails the
    // job with a refund through the fallback; under onMiss 'deliver' the paid render is delivered instead, as on any other miss.
    if (repair.onMiss !== 'deliver') throw error;
    return giveUp(`a pass errored: ${String(error)}`.slice(0, 300), () => Promise.reject(error));
  }
}
