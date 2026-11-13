import type { Db } from '@shipwords/core/db/client';
import type { Composer } from './compose';
import { recordCost } from './cost';
import {
  activeJob,
  appendUpstreamJob,
  cancelAll,
  loadJob,
  markFailed,
  markForReview,
  markSucceeded,
  SKIPPED_UPSTREAM as SKIPPED,
  type StoredOutput,
  settleFailure,
  upstreamIds,
} from './lifecycle';
import { fillDescriptions, type ModelDefinition, PREP_REF, partsOf } from './models';
import { composeOutputs, storeOutputs } from './outputs';
import { checkPoints, checkWindows, judgeCheck } from './repair';
import { type RepairContext, repairOutputs, type SegmentCheck } from './repair-steps';
import type { JobRow } from './schema';
import type { PollResult, SubmitInput, UpstreamAdapter } from './upstream';
import { UpstreamError } from './upstream';

// The full execution of one generation job. The Workflow persists each step's result and resumes after interruption;
// this only depends on the StepRunner interface, so tests pass an implementation that runs directly.

export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export interface RunnerDeps {
  db: Db;
  bucket: R2Bucket;
  models: readonly ModelDefinition[];
  adapters: Record<string, UpstreamAdapter>;
  /** Effect compose (effect.compose); empty when the site binds no container, and jobs that need compose fail with a refund. */
  composer?: Composer;
  fetcher?: typeof fetch;
  /**
   * Public URL of an R2 key, served by the site's /files route. Repair passes (segment.repair) hand the upstream the frames to repair
   * through it; without it a missed swap fails with a refund.
   */
  fileUrl?: (key: string) => string;
  /** Notify the user when the job succeeds or fails (e.g. email) so they don't have to wait on the page; errors are only logged and don't affect the job. */
  notify?: (job: JobRow) => Promise<void>;
  /**
   * Describe a person in an image (effect.describe), e.g. with a vision model: a short phrase that goes into the video prompt. Errors
   * and empty answers leave the description out; without it describe placeholders are dropped.
   */
  describe?: (imageUrl: string, instruction: string) => Promise<string>;
  /**
   * Tell someone a delivered job needs a human look (people the repair passes couldn't swap, a face on the wrong person). The job is
   * delivered either way; errors are only logged.
   */
  review?: (job: JobRow, reasons: readonly string[]) => Promise<void>;
  log?: (message: string, details: Record<string, unknown>) => void;
}

const POLL_WAIT_SECONDS = 20;
const POLL_PAUSE_MS = 3_000;
/** Prep images usually finish in about 35 s; one still running past this gets a second copy, and whichever finishes first is used. */
export const PREP_HEDGE_MS = 60_000;

/**
 * Each Workflow step retries on its own; once retries are exhausted step.do throws. This fallback marks the job failed and refunds,
 * otherwise the job would stay in progress forever and the user's credits would never come back.
 */
export async function runGeneration(deps: RunnerDeps, jobId: string, step: StepRunner): Promise<void> {
  try {
    await runSteps(deps, jobId, step);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.('generation aborted', { jobId, error: message });
    await step.do('abort', async () => {
      // In a multi-part job some segments may still be running upstream: after fail + refund nobody needs them, so cancel to avoid wasted charges.
      const job = await activeJob(deps.db, jobId);
      const adapter = job ? deps.adapters[job.upstream] : undefined;
      if (job && adapter) await cancelAll(adapter, upstreamIds(job));
      await markFailed(deps.db, jobId, 'failed', 'internal_error', message);
      return true;
    });
  }
  // Always settle once at the end: if a step marked the job failed but the refund write failed, on retry that step is skipped because the job is terminal,
  // so settle here on the final state (refunds and quota returns are idempotent).
  await step.do('settle', async () => {
    const job = await loadJob(deps.db, jobId);
    if (job) await settleFailure(deps.db, job);
    return true;
  });
  const notify = deps.notify;
  if (notify) {
    // After settle, so a failure email can say the credits are back. Best-effort: if it still fails after retries, only log it.
    await step
      .do('notify', async () => {
        const job = await loadJob(deps.db, jobId);
        // Canceled jobs aren't notified: the user did it themselves.
        if (job?.status === 'succeeded' || job?.status === 'failed') await notify(job);
        return true;
      })
      .catch((error: unknown) => deps.log?.('notify failed', { jobId, error: String(error) }));
  }
  // Last, since it may wait for billing to settle. Best-effort like notify.
  await recordCost(deps, jobId, step).catch((error: unknown) =>
    deps.log?.('cost record failed', { jobId, error: String(error) }),
  );
}

/**
 * Poll copies of the same request: the first success wins and the other copies are canceled.
 * Running while any copy runs; a query error is thrown only when no copy succeeded or is still running; failed once every copy failed.
 */
async function pollCopies(
  adapter: UpstreamAdapter,
  ids: readonly string[],
  waitSeconds: number,
): Promise<PollResult> {
  type Outcome = { id: string; result: PollResult } | { id: string; error: unknown };
  const outcomes = await new Promise<Outcome[]>((resolve) => {
    const done: Outcome[] = [];
    const settle = (outcome: Outcome) => {
      done.push(outcome);
      if (('result' in outcome && outcome.result.state === 'succeeded') || done.length === ids.length)
        resolve(done);
    };
    for (const id of ids)
      adapter.poll(id, waitSeconds).then(
        (result) => settle({ id, result }),
        (error: unknown) => settle({ id, error }),
      );
  });
  const results = outcomes.flatMap((outcome) => ('result' in outcome ? [outcome] : []));
  const won = results.find(({ result }) => result.state === 'succeeded');
  if (won) {
    await cancelAll(
      adapter,
      ids.filter((id) => id !== won.id),
    );
    return won.result;
  }
  const running = results.find(({ result }) => result.state === 'running');
  if (running) return running.result;
  const errored = outcomes.find((outcome) => 'error' in outcome);
  if (errored && 'error' in errored) throw errored.error;
  return results[0]!.result;
}

async function runSteps(deps: RunnerDeps, jobId: string, step: StepRunner): Promise<void> {
  const setup = await step.do('load', async () => {
    const job = await activeJob(deps.db, jobId);
    if (!job) return null;
    const model = deps.models.find((m) => m.id === job.modelId);
    if (!model) return { missingModel: job.modelId };
    const parts = partsOf(job, model).map((part) => part.id);
    return {
      upstream: model.upstream,
      model: model.id,
      timeoutMinutes: model.timeoutMinutes,
      createdAt: job.createdAt,
      parts,
      sheets: partsOf(job, model)
        .filter((part) => part.prepSheet)
        .map((part) => part.id),
      prep: partsOf(job, model).filter((part) => part.kind === 'image' && model.kind === 'video').length,
      compose: Boolean(model.effect?.compose),
      // Video segments whose prompt waits for descriptions (effect.describe); cached loads from older versions have none.
      describe: partsOf(job, model)
        .filter((part) => part.describe)
        .map((part) => part.id),
      // Output checks: segment ID → config. Cached loads from older versions lack this, so old in-flight jobs keep running unchecked.
      checks: Object.fromEntries(
        (model.effect?.segments ?? [])
          .filter((segment) => segment.check && parts.includes(segment.id))
          .map((segment) => [
            segment.id,
            {
              maxSimilarity: segment.check!.maxSimilarity,
              original: segment.check!.original,
              faces: segment.check!.faces,
              ...(segment.repair ? { repair: true } : {}),
              ...(segment.repair?.likeness ? { likeness: true } : {}),
              // trim segments only put the first target seconds into the output, not rounded: comparing more would include the next shot that gets cut, less would miss the last frames.
              // stretch segments use the whole clip, so compare over the model duration.
              seconds:
                segment.fit === 'trim'
                  ? segment.target!
                  : Number(segment.parameters.duration) || segment.target!,
            },
          ]),
      ) as Record<string, SegmentCheck>,
    };
  });
  if (!setup) return;
  if ('missingModel' in setup) {
    await step.do('fail:model_removed', async () => {
      await markFailed(
        deps.db,
        jobId,
        'failed',
        'model_removed',
        `model ${setup.missingModel} is no longer configured`,
      );
      return true;
    });
    return;
  }
  const adapter = deps.adapters[setup.upstream];
  if (!adapter) {
    await step.do('fail:upstream_missing', async () => {
      await markFailed(deps.db, jobId, 'failed', 'upstream_missing', `no adapter for ${setup.upstream}`);
      return true;
    });
    return;
  }

  // Single-part jobs keep their original step names and idempotency keys so old in-flight jobs line up on replay; older cached loads lack parts.
  const partIds = setup.parts ?? ['main'];
  const single = partIds.length === 1;
  const name = (base: string, part: string) => (single ? base : `${base}:${part}`);
  /** End the job failed, canceling every submitted segment: the others are still running upstream and keep billing. */
  const stop = (stepName: string, code: string, message: string) =>
    step.do(stepName, async () => {
      const job = await loadJob(deps.db, jobId);
      if (job) await cancelAll(adapter, upstreamIds(job));
      await markFailed(deps.db, jobId, 'failed', code, message);
      return true;
    });
  const fail = (code: string, message: string) => stop(`fail:${code}`, code, message);

  // Timeout counts from job creation and is only checked inside a step: on Workflow replay, code outside steps runs again.
  const deadline = setup.createdAt + setup.timeoutMinutes * 60_000;
  const prepCount = setup.prep ?? 0;
  /** Prep results: prep segment ID → image URL returned by the upstream; video segments' prep:<slot> placeholders are replaced with it at submit. */
  const prepUrls = new Map<string, string>();
  const submittedIds: string[] = [];
  const outputs: StoredOutput[] = [];
  /**
   * Segments whose check found original people and that have repair passes: segment ID → [part index, missed slots, where each was seen
   * (shot indices)].
   */
  const toRepair = new Map<string, { missed: string[]; where: Record<string, number[]> }>();
  /** Descriptions of the people in each video segment (effect.describe): segment ID → slot → phrase. */
  const descriptions = new Map<string, Record<string, string>>();
  /** Why the delivered job needs a human look; written after it succeeds. */
  const reviews: string[] = [];
  /** Key of each segment's first output, looked up by segment ID when composing. */
  const partKeys = new Map<string, string>();
  const timeOut = () => stop('timeout', 'timeout', `no result after ${setup.timeoutMinutes} minutes`);

  /** A reference URL with its prep placeholder replaced by the prep result. */
  const resolve = (partId: string, url: string): string => {
    if (!url.startsWith(PREP_REF)) return url;
    const resolved = prepUrls.get(`prep-${url.slice(PREP_REF.length)}`);
    if (!resolved) throw new Error(`part ${partId} needs ${url} before it is ready`);
    return resolved;
  };
  /**
   * Upstream request for segment `index`: prep placeholders replaced with prep results, and descriptions filled in. A subject's views that
   * fell back to the same photo are sent once; a subject left with one site photo gets it again under a second URL, since subjects take
   * two photos or more.
   */
  const submitInput = (job: JobRow, index: number, preflight = false): SubmitInput => {
    const model = deps.models.find((m) => m.id === job.modelId)!;
    const part = partsOf(job, model)[index]!;
    const references = subjectPhotos(
      part.references.map((ref) => ({
        ...ref,
        url:
          preflight && ref.url.startsWith(PREP_REF)
            ? `https://preflight.invalid/${encodeURIComponent(ref.url)}.png`
            : resolve(part.id, ref.url),
      })),
      deps.fileUrl?.(''),
    );
    return {
      upstreamModel: part.upstreamModel,
      kind: part.kind ?? model.kind,
      prompt: part.describe ? fillDescriptions(part.prompt, descriptions.get(part.id) ?? {}) : part.prompt,
      ...(part.lyrics ? { lyrics: part.lyrics } : {}),
      references,
      parameters: part.parameters,
      ...(part.maxCost ? { maxCost: part.maxCost } : {}),
    };
  };
  // Run the installed adapter's local schema validator before any paid image preparation.
  const ready =
    !adapter.validate && !setup.sheets?.length
      ? true
      : await step.do('preflight', async () => {
          const job = await activeJob(deps.db, jobId);
          if (!job) return false;
          try {
            if (setup.sheets?.length && (!deps.composer?.splitSheet || !deps.fileUrl))
              throw new UpstreamError(
                'prep_sheet_not_configured',
                'sheet preparation requires a splitter and public file URLs',
                false,
              );
            for (let index = 0; index < partIds.length; index++)
              adapter.validate?.(submitInput(job, index, true));
            return true;
          } catch (error) {
            if (!(error instanceof UpstreamError) || error.retryable) throw error;
            await cancelAll(adapter, upstreamIds(job));
            await markFailed(deps.db, jobId, 'failed', error.code, error.message);
            return false;
          }
        });
  if (!ready) return;
  /** Poll until done; an empty label uses the single-part step name. */
  const pollUntilDone = async (upstreamJobId: string, label: string | null) => {
    for (let attempt = 0; ; attempt++) {
      const result: PollResult | { state: 'stopped' } | { state: 'timeout' } = await step.do(
        label === null ? `poll:${attempt}` : `poll:${label}:${attempt}`,
        async () => {
          // After a user cancel the local state is terminal; stop polling.
          const job = await activeJob(deps.db, jobId);
          if (!job) return { state: 'stopped' as const };
          if (Date.now() > deadline) return { state: 'timeout' as const };
          return adapter.poll(upstreamJobId, POLL_WAIT_SECONDS);
        },
      );
      if (result.state !== 'running') return result;
      await step.sleep(label === null ? `pause:${attempt}` : `pause:${label}:${attempt}`, POLL_PAUSE_MS);
    }
  };
  /**
   * Poll every prep segment together until each finishes. A prep still running PREP_HEDGE_MS after job creation gets one copy,
   * since one stuck image holds back every video segment; the first copy to succeed is used and the other canceled (pollCopies).
   * Copies are not recorded in upstream_job_id (video segments haven't taken their positions yet): this loop cancels them when it sees
   * the job stopped or timed out. A user cancel only works before the first submit, so it never lands while copies run.
   * Step names replaced the per-prep `poll:<prep>:<n>` of earlier versions: deploy with no effect job in flight, or a replayed job past prep re-polls its preps live.
   */
  type Finished = Exclude<PollResult, { state: 'running' }>;
  const pollPreps = async (
    pending: readonly { partId: string; index: number; upstreamJobId: string }[],
  ): Promise<
    { state: 'stopped' } | { state: 'timeout' } | { state: 'done'; results: Map<string, Finished> }
  > => {
    const results = new Map<string, Finished>();
    const copies = new Map<string, string>();
    const hedged = new Set<string>();
    for (let attempt = 0; ; attempt++) {
      const open = pending.filter((part) => !results.has(part.partId));
      const polled = await step.do(`poll:prep:${attempt}`, async () => {
        const stopped = !(await activeJob(deps.db, jobId));
        if (stopped || Date.now() > deadline) {
          await cancelAll(adapter, [...copies.values()]);
          return { state: stopped ? ('stopped' as const) : ('timeout' as const) };
        }
        const states = await Promise.all(
          open.map((part) => {
            const copy = copies.get(part.partId);
            return pollCopies(
              adapter,
              copy ? [part.upstreamJobId, copy] : [part.upstreamJobId],
              POLL_WAIT_SECONDS,
            );
          }),
        );
        const late = Date.now() - setup.createdAt > PREP_HEDGE_MS;
        return {
          state: 'polled' as const,
          results: Object.fromEntries(open.map((part, i) => [part.partId, states[i]!])),
          // Decided inside the step: replaying a cached poll must never hedge a prep that has since finished.
          hedge: open
            .filter(
              (part, i) =>
                late &&
                states[i]!.state === 'running' &&
                !hedged.has(part.partId) &&
                !setup.sheets?.includes(part.partId),
            )
            .map((part) => part.partId),
        };
      });
      if (polled.state !== 'polled') return polled;
      for (const [partId, result] of Object.entries(polled.results))
        if (result.state !== 'running') results.set(partId, result as Finished);
      for (const partId of polled.hedge) {
        hedged.add(partId);
        const part = pending.find((candidate) => candidate.partId === partId)!;
        // Best effort and no Workflow retries: if the copy can't be placed, keep waiting on the original.
        const copy = await step.do(`hedge:${partId}`, async () => {
          const job = await activeJob(deps.db, jobId);
          // A replay can resume here past the deadline: a copy then could never be used.
          if (!job || Date.now() > deadline) return null;
          try {
            const { upstreamJobId } = await adapter.submit(
              submitInput(job, part.index),
              `${jobId}:${partId}:hedge`,
            );
            return upstreamJobId;
          } catch (error) {
            deps.log?.('prep hedge failed', { jobId, part: partId, error: String(error) });
            return null;
          }
        });
        if (copy) copies.set(partId, copy);
      }
      if (results.size === pending.length) return { state: 'done' as const, results };
      if (polled.hedge.length === 0) await step.sleep(`pause:prep:${attempt}`, POLL_PAUSE_MS);
    }
  };
  /**
   * Output check: if an original person this segment should replace is still in the output (swap didn't take), fail the whole job with a refund,
   * or, for a segment with repair passes, return the slots that still show the original so they are repaired after compose.
   * No rerun of the segment itself: a video render costs dollars, a repair pass cents.
   * Only slots the user filled are checked: the others keep the original on purpose.
   * Errors in the check itself (container failure, unreadable output) fail the job with a refund: an unchecked video may be the original clip,
   * and refunding one good video costs less than charging for a broken one. Under repair.onMiss 'deliver' the render has been charged, so a
   * check error delivers it unchecked and a miss that can't be repaired delivers it as is, neither refunds. Returns false if the job has ended.
   */
  const verify = async (
    partId: string,
    index: number,
    check: SegmentCheck,
  ): Promise<boolean | { missed: string[]; where: Record<string, number[]> }> => {
    const { original, faces } = check;
    const key = partKeys.get(partId);
    if (!key) return true;
    // Step name keeps the old round suffix so in-flight jobs replay their cached check.
    const verdict:
      | { stopped: true }
      | { errored: string }
      | { scores: number[]; slots?: string[]; points?: true } = await step
      .do(`check:${partId}:0`, async () => {
        const job = await activeJob(deps.db, jobId);
        if (!job) return { stopped: true as const };
        if (!original || !faces) return { scores: [] as number[] };
        const model = deps.models.find((m) => m.id === job.modelId)!;
        // Parts stored by older versions don't record their slots: check none rather than flag slots the user left as the original.
        const slots = (partsOf(job, model)[index]!.slots ?? []).filter((slot) => faces[slot]);
        if (!deps.composer || slots.length === 0) return { scores: [] as number[] };
        const { points, owners } = checkPoints(faces, slots);
        // With repair, each point looks only at the shots of its group, so the shots it flags are where the original really is.
        const segment = model.effect?.segments.find((candidate) => candidate.id === partId);
        const windows =
          segment?.repair && segment.cuts
            ? checkWindows(points, owners, segment.repair.shots, segment.cuts, check.seconds)
            : undefined;
        const scores = await deps.composer.faces({
          jobId,
          key,
          originalKey: original,
          points,
          seconds: check.seconds,
          windows,
        });
        // points: scores are per check point (a slot can have several), not per slot as cached by older versions.
        return { scores, slots, points: true as const };
      })
      .catch((error: unknown) => {
        deps.log?.('swap check errored', { jobId, part: partId, error: String(error) });
        return { errored: String(error) };
      });
    if ('stopped' in verdict) return false;
    // Read from the current config like repairOutputs; a cached load without repair keeps refunding as before.
    const deliverOnMiss =
      check.repair &&
      deps.models.find((m) => m.id === setup.model)?.effect?.segments.find((s) => s.id === partId)?.repair
        ?.onMiss === 'deliver';
    if ('errored' in verdict) {
      if (deliverOnMiss) return true;
      await fail('check_failed', `${partId} output could not be checked: ${verdict.errored}`.slice(0, 500));
      return false;
    }
    const worst = Math.max(0, ...verdict.scores);
    if (worst < check.maxSimilarity) return true;
    deps.log?.('swap not applied', { jobId, part: partId, scores: verdict.scores });
    // Checks cached by older versions don't name their slots; repair needs compose, the container and a public URL for the frames.
    if (check.repair && verdict.slots && setup.compose && deps.composer && deps.fileUrl) {
      if (!verdict.points)
        return {
          missed: verdict.slots.filter((_, i) => verdict.scores[i]! >= check.maxSimilarity),
          where: {},
        };
      const cuts = deps.models
        .find((m) => m.id === setup.model)
        ?.effect?.segments.find((s) => s.id === partId)?.cuts;
      return judgeCheck(faces!, verdict.slots, verdict.scores, check.maxSimilarity, cuts ?? []);
    }
    if (deliverOnMiss) return true;
    await fail('swap_not_applied', `${partId} still shows an original face (similarity ${worst})`);
    return false;
  };

  // Run prep segments first, then video segments (which use the prep results). Within a phase, submit one by one so segments render upstream in parallel, then poll in turn.
  // Idempotency key is jobId for single-part, jobId:segment ID for multi-part.
  for (const [from, to] of [
    [0, prepCount],
    [prepCount, partIds.length],
  ] as const) {
    for (let index = from; index < to; index++) {
      const partId = partIds[index]!;
      if (setup.describe?.includes(partId)) {
        // Best effort: a failed description leaves it out of the prompt, it never holds up or fails the job.
        const described = await step
          .do(`describe:${partId}`, async (): Promise<Record<string, string>> => {
            const job = await activeJob(deps.db, jobId);
            const model = job && deps.models.find((m) => m.id === job.modelId);
            const ask = job && model ? partsOf(job, model)[index]!.describe : undefined;
            if (!ask || !deps.describe) return {};
            const said = await Promise.all(
              Object.entries(ask.images).map(async ([slot, image]): Promise<[string, string]> => {
                try {
                  return [
                    slot,
                    cleanDescription(await deps.describe!(resolve(partId, image), ask.instruction)),
                  ];
                } catch (error) {
                  deps.log?.('describe failed', { jobId, part: partId, slot, error: String(error) });
                  return [slot, ''];
                }
              }),
            );
            deps.log?.('described', { jobId, part: partId, said });
            return Object.fromEntries(said.filter(([, text]) => text));
          })
          .catch((error: unknown) => {
            deps.log?.('describe failed', { jobId, part: partId, error: String(error) });
            return {} as Record<string, string>;
          });
        descriptions.set(partId, described);
      }
      const submitted = await step.do(name('submit', partId), async () => {
        const job = await activeJob(deps.db, jobId);
        if (!job) return { done: true as const };
        const existing = upstreamIds(job)[index];
        if (existing) return { upstreamJobId: existing };
        // Prep may have used up the time: submitting video segments now would just waste upstream spend.
        if (index > 0 && Date.now() > deadline) return { timeout: true as const };
        try {
          const { upstreamJobId } = await adapter.submit(
            submitInput(job, index),
            single ? jobId : `${jobId}:${partId}`,
          );
          if (!(await appendUpstreamJob(deps.db, jobId, index, upstreamJobId))) {
            // The job was canceled during submit: nobody needs the task just placed, cancel it.
            await adapter.cancel(upstreamJobId).catch(() => undefined);
            return { done: true as const };
          }
          return { upstreamJobId };
        } catch (error) {
          if (error instanceof UpstreamError && !error.retryable && index < prepCount) {
            // Prep rejected (e.g. a celebrity photo): don't fail, record a placeholder and fall back to the original photo.
            deps.log?.('prep rejected, using original photo', { jobId, part: partId, code: error.code });
            const skipped = `${SKIPPED}${partId}`;
            if (!(await appendUpstreamJob(deps.db, jobId, index, skipped))) return { done: true as const };
            return { upstreamJobId: skipped };
          }
          if (error instanceof UpstreamError && !error.retryable) {
            deps.log?.('upstream rejected job', {
              jobId,
              part: partId,
              code: error.code,
              message: error.message,
            });
            await cancelAll(adapter, upstreamIds(job));
            await markFailed(deps.db, jobId, 'failed', error.code, error.message);
            return { done: true as const };
          }
          throw error;
        }
      });
      if ('done' in submitted) return;
      if ('timeout' in submitted) {
        await timeOut();
        return;
      }
      submittedIds[index] = submitted.upstreamJobId;
    }

    let prepResults = new Map<string, Finished>();
    if (from === 0 && prepCount > 0) {
      const pending = partIds
        .slice(0, prepCount)
        .map((partId, index) => ({ partId, index, upstreamJobId: submittedIds[index]! }))
        .filter((part) => !part.upstreamJobId.startsWith(SKIPPED));
      if (pending.length > 0) {
        const polled = await pollPreps(pending);
        if (polled.state === 'stopped') return;
        if (polled.state === 'timeout') {
          await timeOut();
          return;
        }
        prepResults = polled.results;
      }
    }

    for (let index = from; index < to; index++) {
      const partId = partIds[index]!;
      const upstreamJobId = submittedIds[index]!;
      /** When prep yields no image (rejected, failed, empty result), fall back to the user's original photo instead of failing the job. */
      const fallBack = async () => {
        const original = await step.do(`prep-fallback:${partId}`, async () => {
          const job = await activeJob(deps.db, jobId);
          if (!job) return null;
          const model = deps.models.find((m) => m.id === job.modelId)!;
          return partsOf(job, model)[index]!.references[0]!.url;
        });
        if (original) {
          prepUrls.set(partId, original);
          if (setup.sheets?.includes(partId))
            for (let view = 1; view < 4; view++) prepUrls.set(`${partId}-v${view}`, original);
        }
        return Boolean(original);
      };
      if (upstreamJobId.startsWith(SKIPPED)) {
        if (!(await fallBack())) return;
        continue;
      }
      const result =
        index < prepCount
          ? prepResults.get(partId)!
          : await pollUntilDone(upstreamJobId, single ? null : partId);
      if (result.state === 'stopped') return;
      if (result.state === 'failed') {
        if (index < prepCount) {
          deps.log?.('prep failed, using original photo', { jobId, part: partId, code: result.code });
          if (!(await fallBack())) return;
          continue;
        }
        await fail(result.code, result.message);
        return;
      }
      if (result.state === 'timeout') {
        await timeOut();
        return;
      }
      if (index < prepCount) {
        // Prep images are references, not deliverables; sheets are cropped and stored for the video model.
        const url = result.files[0]?.url;
        if (url && setup.sheets?.includes(partId)) {
          const urls = await step.do(`split:${partId}`, async () => {
            if (!(await activeJob(deps.db, jobId))) return null;
            const keys = Array.from({ length: 4 }, (_, view) => `jobs/${jobId}/${partId}-${view}.png`);
            // A failed write can resume with the same keys without another upstream generation.
            const existing = await Promise.all(keys.map((key) => deps.bucket.head(key)));
            if (!existing.every(Boolean)) {
              const response = await (deps.fetcher ?? fetch)(url);
              if (!response.ok) throw new Error(`download prep sheet failed: ${response.status}`);
              const images = await deps.composer!.splitSheet!({ jobId, image: await response.arrayBuffer() });
              if (images.length !== 4 || images.some((image) => !image.byteLength))
                throw new Error('sheet must produce four images');
              for (const [view, key] of keys.entries())
                await deps.bucket.put(key, images[view]!, { httpMetadata: { contentType: 'image/png' } });
            }
            return keys.map((key) => deps.fileUrl!(key));
          });
          if (!urls) return;
          for (const [view, image] of urls.entries())
            prepUrls.set(view === 0 ? partId : `${partId}-v${view}`, image);
        } else if (url) prepUrls.set(partId, url);
        else if (!(await fallBack())) return;
        continue;
      }
      const start = outputs.length;
      const stored = await step.do(name('store', partId), () =>
        storeOutputs(deps, jobId, result.files, start),
      );
      if (stored[0]) partKeys.set(partId, stored[0].key);
      outputs.push(...stored);
      const check = setup.checks?.[partId];
      if (!check) continue;
      const verdict = await verify(partId, index, check);
      if (verdict === false) return;
      if (verdict !== true) toRepair.set(partId, verdict);
    }
  }
  let finalOutputs = outputs;
  if (setup.compose) {
    // Compose failures throw: once Workflow retries run out the fallback fails the job with a full refund. Retries write the same keys, so it's idempotent.
    const composed = await step.do('compose', () => composeOutputs(deps, jobId, partKeys, outputs.length));
    if (!composed) return;
    finalOutputs = composed;
    const repairContext: RepairContext = {
      deps,
      jobId,
      step,
      adapter,
      modelId: setup.model,
      checks: setup.checks,
      partCount: partIds.length,
      deadline,
      fail,
      timeOut,
      submitInput,
      pollUntilDone,
      review: (reason) => reviews.push(reason),
    };
    for (const [index, partId] of partIds.entries()) {
      const check = setup.checks?.[partId];
      const seen = toRepair.get(partId);
      // A segment with nothing missed still goes through when it has repair passes: its likeness check may ask for some.
      if (!check || (!seen && !(check.repair && deps.composer && deps.fileUrl))) continue;
      const repaired = await repairOutputs(
        repairContext,
        partId,
        index,
        check,
        seen?.missed ?? [],
        composed,
        seen?.where,
      );
      if (!repaired) return;
    }
  }
  await step.do('finish', async () => {
    await markSucceeded(deps.db, jobId, finalOutputs);
    return true;
  });
  if (reviews.length > 0) {
    // Best effort, after delivery: the note is kept on the job (error_message, which pages never show) and sent to deps.review.
    await step
      .do('review', async () => {
        const job = await markForReview(deps.db, jobId, reviews.join('; '));
        if (job) await deps.review?.(job, reviews);
        return true;
      })
      .catch((error: unknown) => deps.log?.('review notice failed', { jobId, error: String(error) }));
  }
}

/**
 * A subject's photos as the upstream takes them (Kling: 2–4 per subject). Views that fell back to the same photo are sent once; a subject
 * left with a single photo from the site's own /files (every view fell back to the upload) gets it again under a second URL. That only
 * works because /files ignores the query string; validateEffect makes sure a subject's slot has 2 views or none, so a prep result never
 * ends up alone.
 */
export function subjectPhotos<T extends { url: string; subject?: string }>(
  references: readonly T[],
  files?: string,
): T[] {
  const kept = references.filter(
    (ref, i) =>
      !ref.subject ||
      !references.slice(0, i).some((earlier) => earlier.subject === ref.subject && earlier.url === ref.url),
  );
  for (const name of new Set(kept.flatMap((ref) => (ref.subject ? [ref.subject] : [])))) {
    const own = kept.filter((ref) => ref.subject === name);
    if (own.length !== 1 || !files || !own[0]!.url.startsWith(files)) continue;
    const only = own[0]!;
    kept.splice(kept.indexOf(only) + 1, 0, {
      ...only,
      url: `${only.url}${only.url.includes('?') ? '&' : '?'}view=2`,
    });
  }
  return kept;
}

/** A vision model's answer as a prompt phrase: one line, no markup or references, at most 200 characters, no closing period. */
export function cleanDescription(text: string): string {
  return text
    .replace(/[@{}<>`*#"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the person is|this is|a photo of)\s+/i, '')
    .slice(0, 200)
    .replace(/[.\s]+$/, '');
}
