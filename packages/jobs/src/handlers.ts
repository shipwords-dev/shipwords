import { InsufficientCreditsError, spendCredits } from '@shipwords/core/credits/ledger';
import { newId } from '@shipwords/core/db/client';
import { clientIp, errorResponse, ipBucket, json, readJson } from '@shipwords/core/http';
import { consumeQuota, dayWindow, releaseQuota } from '@shipwords/core/quota/counters';
import { ensureGuestId, readGuestId } from '@shipwords/core/quota/guest';
import type { Core } from '@shipwords/core/server';
import { and, desc, eq, isNull, like, or } from 'drizzle-orm';
import { createAdapters, type JobsEnv } from './adapters';
import { imageSize } from './image-size';
import {
  cancelAll,
  cancelQueued,
  claimGuestJobs,
  enqueueRun,
  loadJob,
  markFailed,
  type StoredOutput,
  settleFailure,
  spendKey,
  upstreamIds,
} from './lifecycle';
import {
  creditsFor,
  effectParts,
  MAX_LYRICS,
  type ModelDefinition,
  musicParameters,
  referenceRoleOf,
  sanitizeParameters,
} from './models';
import { objectResponse } from './object-range';
import { type JobRow, jobRuns, jobSteps, jobs } from './schema';
import { type ObjectStore, storeFromEnv } from './store';

const MAX_PROMPT = 4000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const UPLOADS_PER_DAY = 40;
/** Shorter side below this and models can't pick out a face or subject; a failed face swap still costs the upstream in full. */
const MIN_UPLOAD_SIDE = 160;
const RECAPTCHA_ACTION = 'generate';

interface CreateBody {
  modelId?: string;
  prompt?: string;
  /** Reference images: site file paths (/files/uploads/...) obtained from the upload endpoint first. */
  references?: string[];
  parameters?: Record<string, unknown>;
  /** Music models: song lyrics; omit to have the model write them (or for an instrumental). */
  lyrics?: string;
  /** Effects: slot ID → site path returned by the upload endpoint. */
  slots?: Record<string, unknown>;
  recaptchaToken?: string;
}

export function publicJob(job: JobRow, baseURL: string) {
  const outputs = job.outputsJson ? (JSON.parse(job.outputsJson) as StoredOutput[]) : [];
  return {
    id: job.id,
    modelId: job.modelId,
    status: job.status,
    prompt: job.prompt,
    costCredits: job.costCredits,
    outputs: outputs.map((output) => ({
      url: `${baseURL}/files/${output.key}`,
      mediaType: output.mediaType,
    })),
    // Code only: the stored message holds internal detail (exceptions, upstream replies, check scores) and stays in the database and logs.
    error: job.errorCode ? { code: job.errorCode } : null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

function withCookie(response: Response, setCookie: string | null): Response {
  if (setCookie) response.headers.append('set-cookie', setCookie);
  return response;
}

export interface JobsOptions {
  /** Tell this process's job worker a run is waiting (worker.wake); without it the worker finds the run on its next poll. */
  wake?: () => void;
  /** Where uploads and outputs live; defaults to the store the environment configures (storeFromEnv). */
  store?: ObjectStore;
}

export function createJobs(core: Core, models: readonly ModelDefinition[], options: JobsOptions = {}) {
  /** Best effort: the job is already committed, so a throwing wake must not turn the response into an error (a retry would charge again). */
  const wake = () => {
    try {
      options.wake?.();
    } catch (error) {
      core.log('job worker wake failed', { error: String(error) });
    }
  };
  const env = () => core.env as unknown as JobsEnv & { GUEST_COOKIE_SECRET: string; APP_URL?: string };
  let configured: ObjectStore | null = options.store ?? null;
  const store = () => (configured ??= storeFromEnv(env()));
  const baseURL = () => (env().APP_URL ?? core.site.url).replace(/\/$/, '');

  /** Identity of the current request: signed-in user, or a guest with a signed cookie. Signed-in users also claim this device's guest jobs. */
  async function identity(request: Request) {
    const [user, guestId] = await Promise.all([
      core.getUser(request),
      readGuestId(request.headers, core.site.id, env().GUEST_COOKIE_SECRET),
    ]);
    if (user && guestId) await claimGuestJobs(core.db, guestId, user.id);
    return { user, guestId };
  }

  /**
   * Fallback next to the worker's poison-run check: a job still unfinished after the model timeout plus 15 minutes (no worker running,
   * say) is marked failed and refunded when the user views it.
   */
  async function healStale(job: JobRow): Promise<JobRow> {
    if (job.status === 'failed' || job.status === 'canceled') {
      // Settlement is idempotent: a refund that previously failed halfway is completed here.
      await settleFailure(core.db, job);
      return job;
    }
    if (job.status !== 'queued' && job.status !== 'submitted') return job;
    const model = models.find((m) => m.id === job.modelId);
    const limit = ((model?.timeoutMinutes ?? 30) + 15) * 60_000;
    if (Date.now() - job.createdAt < limit) return job;
    core.log('stale job failed on read', { jobId: job.id });
    return (await markFailed(core.db, job.id, 'failed', 'stale', 'the job stopped responding')) ?? job;
  }

  async function ownedJob(request: Request, jobId: string) {
    const { user, guestId } = await identity(request);
    const found = await loadJob(core.db, jobId);
    const job = found ? await healStale(found) : null;
    if (!job) return null;
    if (user && job.userId === user.id) return job;
    if (guestId && job.guestId === guestId && !job.userId) return job;
    return null;
  }

  /** Only accept files uploaded to this site, so users can't make the upstream fetch arbitrary URLs. Returns the public URL, or null if invalid. */
  function uploadUrl(ref: unknown): string | null {
    if (typeof ref !== 'string') return null;
    const prefix = `${baseURL()}/files/uploads/`;
    const path = ref.startsWith('/files/uploads/') ? `${baseURL()}${ref}` : ref;
    if (!path.startsWith(prefix) || !/^[a-z0-9_]+\.(png|jpg|webp)$/.test(path.slice(prefix.length)))
      return null;
    return path;
  }

  function resolveReferences(model: ModelDefinition, refs: unknown): string[] | null {
    if (refs === undefined) return [];
    if (!Array.isArray(refs) || refs.length > model.maxReferences) return null;
    const urls: string[] = [];
    for (const ref of refs) {
      const url = uploadUrl(ref);
      if (!url) return null;
      urls.push(url);
    }
    return urls;
  }

  return {
    models,

    /** POST /api/jobs */
    async create(request: Request, idempotent?: { idempotencyKey: string }): Promise<Response> {
      const body = await readJson<CreateBody>(request);
      const model = models.find((m) => m.id === body?.modelId);
      if (!body || !model) return errorResponse(400, 'unknown_model');
      let prompt: string;
      let parameters: Record<string, unknown>;
      let inputJson: string;
      if (model.effect) {
        // Effect prompts stay server-side: the prompt column is an empty string, so publicJob never exposes it.
        const parts = effectParts(model, body.slots, uploadUrl, (key) => `${baseURL()}/files/${key}`);
        if (!parts) return errorResponse(400, 'invalid_slots');
        prompt = '';
        parameters = {};
        inputJson = JSON.stringify({ parts });
      } else {
        prompt = (body.prompt ?? '').trim();
        // Postgres text can't store NUL; reject it here so it doesn't fail the insert after the charge.
        if (!prompt || prompt.length > MAX_PROMPT || prompt.includes('\u0000'))
          return errorResponse(400, 'invalid_prompt');
        const references = resolveReferences(model, body.references);
        if (!references) return errorResponse(400, 'invalid_references');
        parameters = sanitizeParameters(model, body.parameters);
        const role = referenceRoleOf(model);
        const input = { references: references.map((url) => ({ url, role })), parameters };
        if (model.kind === 'music') {
          if (body.lyrics !== undefined && typeof body.lyrics !== 'string')
            return errorResponse(400, 'invalid_lyrics');
          const lyrics = body.lyrics?.trim() || undefined;
          if (lyrics && lyrics.length > MAX_LYRICS) return errorResponse(400, 'invalid_lyrics');
          parameters = musicParameters(parameters, lyrics);
          inputJson = JSON.stringify({ ...input, parameters, ...(lyrics ? { lyrics } : {}) });
        } else {
          inputJson = JSON.stringify(input);
        }
      }
      const user = await core.getUser(request);
      if (idempotent && (!user || !/^[a-zA-Z0-9:_-]{1,200}$/.test(idempotent.idempotencyKey)))
        return errorResponse(400, 'invalid_idempotency_key');
      const jobId = idempotent
        ? `job_${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([user!.id, idempotent.idempotencyKey])))), (b) => b.toString(16).padStart(2, '0')).join('')}`
        : newId('job');

      // Only the server supplies this key. A lost response must not create another debit or reset a terminal job.
      async function resume(job: JobRow): Promise<Response> {
        if (
          job.userId !== user?.id ||
          job.modelId !== model!.id ||
          job.prompt !== prompt ||
          job.inputJson !== inputJson
        )
          return errorResponse(409, 'idempotency_conflict');
        job = await healStale(job);
        // The run was queued with the job; queue it again in case the job predates job_runs (a no-op otherwise), and nudge the
        // worker. A run that starts past the job's deadline fails it with a refund before submitting anything.
        if (job.status === 'queued') {
          await enqueueRun(core.db, job.id);
          wake();
        }
        return json({ job: publicJob((await loadJob(core.db, job.id))!, baseURL()) }, { status: 200 });
      }
      if (idempotent) {
        const existing = await loadJob(core.db, jobId);
        if (existing) return resume(existing);
      }

      if (user) {
        const cost = creditsFor(model, parameters);
        const row = {
          id: jobId,
          userId: user.id,
          modelId: model.id,
          kind: model.kind,
          prompt,
          inputJson,
          costCredits: cost,
          upstream: model.upstream,
        };
        try {
          // Charge, job and run share one transaction: all happen or none does, so a charged job always runs.
          if (cost > 0) {
            await spendCredits(
              core.db,
              { userId: user.id, amount: cost, idemKey: spendKey(jobId), ref: jobId },
              async (tx) => {
                await tx.insert(jobs).values(row);
                await enqueueRun(tx, jobId);
              },
            );
          } else {
            await core.db.transaction(async (tx) => {
              if (idempotent) await tx.insert(jobs).values(row).onConflictDoNothing();
              else await tx.insert(jobs).values(row);
              await enqueueRun(tx, jobId);
            });
          }
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            return errorResponse(402, 'insufficient_credits', 'Not enough credits.', {
              required: error.required,
              available: error.available,
            });
          }
          throw error;
        }
        const job = (await loadJob(core.db, jobId))!;
        if (idempotent) return resume(job);
        wake();
        return json({ job: publicJob(job, baseURL()) }, { status: 201 });
      }

      if (!model.guest) return errorResponse(401, 'login_required', 'Sign in to use this model.');
      const decision = await core.guest.authorize(request, body.recaptchaToken, RECAPTCHA_ACTION);
      if (!decision.ok) {
        return withCookie(
          errorResponse(401, 'login_required', 'Sign in to keep generating.', { reason: decision.reason }),
          decision.setCookie,
        );
      }
      await core.db
        .transaction(async (tx) => {
          await tx.insert(jobs).values({
            id: jobId,
            guestId: decision.guestId,
            modelId: model.id,
            kind: model.kind,
            prompt,
            inputJson,
            costCredits: 0,
            quotaJson: JSON.stringify(decision.rules),
            upstream: model.upstream,
          });
          await enqueueRun(tx, jobId);
        })
        .catch(async (error) => {
          // Quota was taken but the job wasn't created: give it back, or repeated failures would drain the daily guest budget.
          await releaseQuota(core.db, decision.rules);
          throw error;
        });
      const job = (await loadJob(core.db, jobId))!;
      wake();
      return withCookie(json({ job: publicJob(job, baseURL()) }, { status: 201 }), decision.setCookie);
    },

    /** GET /api/jobs/<id> */
    async get(request: Request, jobId: string): Promise<Response> {
      const job = await ownedJob(request, jobId);
      return job ? json({ job: publicJob(job, baseURL()) }) : errorResponse(404, 'job_not_found');
    },

    /** GET /api/jobs: recent jobs, to resume in-flight jobs after a refresh and show history. */
    async list(request: Request): Promise<Response> {
      const { user, guestId } = await identity(request);
      if (!user && !guestId) return json({ jobs: [] });
      const owner = user ? eq(jobs.userId, user.id) : and(eq(jobs.guestId, guestId!), isNull(jobs.userId));
      const rows = await core.db.select().from(jobs).where(owner).orderBy(desc(jobs.createdAt)).limit(30);
      const healed = await Promise.all(rows.map(healStale));
      return json({ jobs: healed.map((row) => publicJob(row, baseURL())) });
    },

    /** POST /api/jobs/<id>/cancel: only before the job reaches the upstream; after that it keeps going and delivers (409 job_started). */
    async cancel(request: Request, jobId: string): Promise<Response> {
      const job = await ownedJob(request, jobId);
      if (!job) return errorResponse(404, 'job_not_found');
      // A submit that has started may have reached the upstream even though no task ID was recorded yet (its process can die in
      // between): the job counts as started, or a refund here could leave a billed task running with nothing to cancel it. The check
      // and the cancel hold the run row, which a step also locks to start an attempt, so a submit can't begin between them.
      const outcome = await core.db.transaction(async (tx) => {
        await tx.select({ id: jobRuns.id }).from(jobRuns).where(eq(jobRuns.id, jobId)).for('update');
        const [begun] = await tx
          .select({ name: jobSteps.name })
          .from(jobSteps)
          .where(
            and(
              eq(jobSteps.runId, jobId),
              or(like(jobSteps.name, 'submit%'), like(jobSteps.name, 'hedge:%')),
            ),
          )
          .limit(1);
        if (begun) return 'started' as const;
        return cancelQueued(tx as unknown as typeof core.db, jobId);
      });
      if (outcome === 'started') return errorResponse(409, 'job_started');
      const updated = outcome;
      if (updated?.status === 'submitted') return errorResponse(409, 'job_started');
      if (updated?.status === 'canceled') {
        // The run is not stopped: it may be inside the first submit, the upstream already holding the task. Left running, it sees
        // the job canceled, cancels the task it just submitted and stops; a run that hasn't started yet stops at its first step.
        // createAdapters throws when the mock is misconfigured; nothing real was submitted then, so there is nothing to cancel.
        const adapter = (() => {
          try {
            return createAdapters(env())[job.upstream];
          } catch {
            return undefined;
          }
        })();
        // The job read before canceling may not list every segment yet; use the record after canceling so a just-submitted segment isn't missed.
        if (adapter) await cancelAll(adapter, upstreamIds(updated));
      }
      return json({ job: updated ? publicJob(updated, baseURL()) : null });
    },

    /** POST /api/uploads: upload one reference image, returns a site path. Open to users and guests, rate-limited per IP per day. */
    async upload(request: Request): Promise<Response> {
      const user = await core.getUser(request);
      const guest = user
        ? null
        : await ensureGuestId(request.headers, core.site.id, env().GUEST_COOKIE_SECRET);
      const ip = clientIp(request.headers);
      const owner = user ? `user:${user.id}` : `guest:${guest!.guestId}`;
      const allowed = await consumeQuota(core.db, [
        { key: `upload:${owner}`, window: dayWindow(), limit: UPLOADS_PER_DAY },
        ...(ip
          ? [{ key: `upload:ip:${ipBucket(ip)}`, window: dayWindow(), limit: UPLOADS_PER_DAY * 2 }]
          : []),
      ]);
      if (!allowed)
        return errorResponse(429, 'upload_limit', "You've reached today's upload limit. Try again tomorrow.");
      const type = request.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (!UPLOAD_TYPES.has(type))
        return errorResponse(415, 'unsupported_type', 'Use a JPG, PNG or WebP photo.');
      const tooLarge = () => errorResponse(413, 'too_large', 'This photo is over 10 MB. Use a smaller one.');
      const length = Number(request.headers.get('content-length') ?? '0');
      if (!length || length > MAX_UPLOAD_BYTES) return tooLarge();
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > MAX_UPLOAD_BYTES) return tooLarge();
      const size = imageSize(bytes);
      if (!size) return errorResponse(415, 'invalid_image', 'This file is not a readable image.');
      if (Math.min(size.width, size.height) < MIN_UPLOAD_SIDE) {
        return errorResponse(422, 'image_too_small', 'This photo is too small. Use a larger, clearer one.', {
          width: size.width,
          height: size.height,
          minSide: MIN_UPLOAD_SIDE,
        });
      }
      const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      const key = `uploads/${newId('up')}.${ext}`;
      await store().put(key, bytes, { contentType: type });
      return withCookie(
        json({ path: `/files/${key}`, url: `${baseURL()}/files/${key}` }, { status: 201 }),
        guest?.setCookie ?? null,
      );
    },

    /**
     * GET /files/<key>: read outputs and uploads from the object store. Keys contain a random ID and can't be enumerated. An output replaced by hand
     * after a redo (tools/replace-output.mjs) gets a new key, <n>-r<timestamp>.<ext>, since outputs are cached as immutable.
     */
    async file(request: Request, key: string): Promise<Response> {
      // assets/ holds site-provided assets (effect reference videos etc.); file names are chosen by the site, read-only.
      if (
        !/^(jobs\/job_[a-z0-9]+\/(\d+(-r\d+)?\.[a-z0-9]+|repair-[a-z0-9_-]+-\d+\.mp4|prep-[A-Za-z0-9_-]+-[0-3]\.png)|uploads\/up_[a-z0-9]+\.(png|jpg|webp)|assets\/[a-z0-9][a-z0-9/_-]*\.(mp4|mp3|png|jpg|webp))$/.test(
          key,
        ) ||
        key.includes('..')
      ) {
        return errorResponse(404, 'not_found');
      }
      // Outputs are only served after the job succeeds: if a cancel lands between "stored" and "marked succeeded", the user was refunded and must not get the result.
      // Repair inputs (the frames a repair pass hands the upstream) are only served while the job runs.
      const jobId = key.startsWith('jobs/') ? key.split('/')[1] : null;
      const status = jobId ? (await loadJob(core.db, jobId))?.status : null;
      const intermediate = key.includes('/repair-') || key.includes('/prep-');
      if (jobId && status !== (intermediate ? 'submitted' : 'succeeded'))
        return errorResponse(404, 'not_found');
      const head = await store().head(key);
      if (!head) return errorResponse(404, 'not_found');
      const headers = new Headers();
      if (head.contentType) headers.set('content-type', head.contentType);
      if (head.contentDisposition) headers.set('content-disposition', head.contentDisposition);
      // Customer uploads are deleted by a lifecycle rule after a few days; a cached copy must not outlive that, so they are never cached.
      const uncached = intermediate || key.startsWith('uploads/');
      headers.set('cache-control', uncached ? 'no-store' : 'public, max-age=31536000, immutable');
      // Byte ranges: iPhone Safari needs 206 to play stored videos.
      return (await objectResponse(store(), key, request, headers)) ?? errorResponse(404, 'not_found');
    },
  };
}

export type Jobs = ReturnType<typeof createJobs>;
