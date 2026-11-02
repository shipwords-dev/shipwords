import { InsufficientCreditsError, spendCredits } from '@shipwords/core/credits/ledger';
import { newId } from '@shipwords/core/db/client';
import { clientIp, errorResponse, ipBucket, json, readJson } from '@shipwords/core/http';
import { consumeQuota, dayWindow, releaseQuota } from '@shipwords/core/quota/counters';
import { ensureGuestId, readGuestId } from '@shipwords/core/quota/guest';
import type { Core } from '@shipwords/core/server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { imageSize } from './image-size';
import {
  cancelQueued,
  claimGuestJobs,
  loadJob,
  markFailed,
  SKIPPED_UPSTREAM,
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
import { type JobRow, jobs } from './schema';
import { createAdapters, type JobsEnv } from './workflow';

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

export function createJobs(core: Core, models: readonly ModelDefinition[]) {
  const env = () => core.env as unknown as JobsEnv & { GUEST_COOKIE_SECRET: string; APP_URL?: string };
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
   * Fallback: if the Workflow exits unexpectedly the job stays in progress. Jobs still unfinished after the model timeout plus 15 minutes
   * are marked failed and refunded when the user views them, so no cron is needed.
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

  async function dispatch(job: JobRow): Promise<Response | null> {
    try {
      await env().GENERATION_WORKFLOW.create({ id: job.id, params: { jobId: job.id } });
      return null;
    } catch (error) {
      core.log('workflow dispatch failed', { jobId: job.id, error: String(error) });
      await markFailed(core.db, job.id, 'failed', 'dispatch_failed', 'could not start the job');
      return errorResponse(503, 'dispatch_failed', 'Could not start the job, please try again.');
    }
  }

  return {
    models,

    /** POST /api/jobs */
    async create(request: Request, options?: { idempotencyKey: string }): Promise<Response> {
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
        if (!prompt || prompt.length > MAX_PROMPT) return errorResponse(400, 'invalid_prompt');
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
      if (options && (!user || !/^[a-zA-Z0-9:_-]{1,200}$/.test(options.idempotencyKey)))
        return errorResponse(400, 'invalid_idempotency_key');
      const jobId = options
        ? `job_${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([user!.id, options.idempotencyKey])))), (b) => b.toString(16).padStart(2, '0')).join('')}`
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
        // The runner's deadline is anchored to creation, not dispatch. Never start expired work.
        // Keep ambiguous submissions through the existing grace period before stale healing refunds them.
        if (job.status === 'queued' && Date.now() < job.createdAt + model!.timeoutMinutes * 60_000) {
          try {
            await env().GENERATION_WORKFLOW.create({ id: job.id, params: { jobId: job.id } });
          } catch {
            try {
              // create can time out after accepting the task, or race another retry of this request.
              await (await env().GENERATION_WORKFLOW.get(job.id)).status();
            } catch {
              // Keep the debit and queued row: retry the same key, or let stale-job healing settle it.
              return errorResponse(503, 'dispatch_pending');
            }
          }
        }
        return json({ job: publicJob((await loadJob(core.db, job.id))!, baseURL()) }, { status: 200 });
      }
      if (options) {
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
          // Charge and job creation share one batch: either both happen or neither does.
          if (cost > 0) {
            await spendCredits(
              core.db,
              { userId: user.id, amount: cost, idemKey: spendKey(jobId), ref: jobId },
              [core.db.insert(jobs).values(row)],
            );
          } else {
            if (options) await core.db.insert(jobs).values(row).onConflictDoNothing();
            else await core.db.insert(jobs).values(row);
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
        if (options) return resume(job);
        return (await dispatch(job)) ?? json({ job: publicJob(job, baseURL()) }, { status: 201 });
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
        .insert(jobs)
        .values({
          id: jobId,
          guestId: decision.guestId,
          modelId: model.id,
          kind: model.kind,
          prompt,
          inputJson,
          costCredits: 0,
          quotaJson: JSON.stringify(decision.rules),
          upstream: model.upstream,
        })
        .catch(async (error) => {
          // Quota was taken but the job wasn't created: give it back, or repeated failures would drain the daily guest budget.
          await releaseQuota(core.db, decision.rules);
          throw error;
        });
      const job = (await loadJob(core.db, jobId))!;
      const failed = await dispatch(job);
      return withCookie(
        failed ?? json({ job: publicJob(job, baseURL()) }, { status: 201 }),
        decision.setCookie,
      );
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
      const updated = await cancelQueued(core.db, jobId);
      if (updated?.status === 'submitted') return errorResponse(409, 'job_started');
      if (updated?.status === 'canceled') {
        // The Workflow is not terminated: it may be inside the first submit, the upstream already holding the task. Left running, it sees
        // the job canceled, cancels the task it just submitted and stops; a Workflow that hasn't started yet stops at its first step.
        // createAdapters throws when the mock is misconfigured; nothing real was submitted then, so there is nothing to cancel.
        const adapter = (() => {
          try {
            return createAdapters(env())[job.upstream];
          } catch {
            return undefined;
          }
        })();
        // The job read before canceling may not list every segment yet; use the record after canceling so a just-submitted segment isn't missed.
        const ids = upstreamIds(updated).filter((id) => !id.startsWith(SKIPPED_UPSTREAM));
        if (adapter) await Promise.all(ids.map((id) => adapter.cancel(id).catch(() => undefined)));
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
      await env().OUTPUTS.put(key, bytes, { httpMetadata: { contentType: type } });
      return withCookie(
        json({ path: `/files/${key}`, url: `${baseURL()}/files/${key}` }, { status: 201 }),
        guest?.setCookie ?? null,
      );
    },

    /** GET /files/<key>: read outputs and uploads from R2. Keys contain a random ID and can't be enumerated. */
    async file(_request: Request, key: string): Promise<Response> {
      // assets/ holds site-provided assets (effect reference videos etc.); file names are chosen by the site, read-only.
      if (
        !/^(jobs\/job_[a-z0-9]+\/(\d+\.[a-z0-9]+|repair-[a-z0-9_-]+-\d+\.mp4)|uploads\/up_[a-z0-9]+\.(png|jpg|webp)|assets\/[a-z0-9][a-z0-9/_-]*\.(mp4|mp3|png|jpg|webp))$/.test(
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
      if (jobId && status !== (key.includes('/repair-') ? 'submitted' : 'succeeded'))
        return errorResponse(404, 'not_found');
      const object = await env().OUTPUTS.get(key);
      if (!object) return errorResponse(404, 'not_found');
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('cache-control', 'public, max-age=31536000, immutable');
      return new Response(object.body, { headers });
    },
  };
}

export type Jobs = ReturnType<typeof createJobs>;
