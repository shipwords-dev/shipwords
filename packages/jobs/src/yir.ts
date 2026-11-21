import { createNodeYirClient, DEFAULT_USER_AGENT, YirSubmissionUncertainError } from '@yir-ai/sdk/server';
import type {
  StandardImageGenerationRequest,
  StandardMusicGenerationRequest,
  StandardVideoGenerationRequest,
} from '@yir-ai/sdk/shared';
import { validateGeneration } from '@yir-ai/sdk/shared';
import {
  type PollResult,
  type SubmitInput,
  type UpstreamAdapter,
  type UpstreamCost,
  UpstreamError,
} from './upstream';

type YirClient = ReturnType<typeof createNodeYirClient>;

/**
 * Names shipwords ahead of the SDK. Yir keeps the first User-Agent product per job,
 * so it can tell sites built on this starter from other SDK callers.
 */
export const YIR_USER_AGENT = `shipwords ${DEFAULT_USER_AGENT}`;

/**
 * The SDK already retries network errors and 502/503/504 on submits and status reads, and Yir retries the task across providers,
 * so an error that reaches us is final: retrying the step would only keep the user waiting. Two exceptions stay retryable:
 * a rate limit (429), and a submit whose outcome the SDK could not learn (`YirSubmissionUncertainError`: the request was sent,
 * then the network or the Gateway failed). A Job may exist and be charged, so failing and refunding would be wrong; the step is
 * retried with the same idempotency key, which returns that Job if it was created.
 */
function toUpstreamError(error: unknown): UpstreamError {
  if (error instanceof YirSubmissionUncertainError) {
    const cause = error.cause as { message?: string } | undefined;
    return new UpstreamError('submission_outcome_uncertain', cause?.message ?? error.message, true);
  }
  const e = error as { code?: string; message?: string; status?: number };
  return new UpstreamError(e?.code ?? 'yir_error', e?.message ?? String(error), e?.status === 429);
}

type YirRequest =
  | StandardImageGenerationRequest
  | StandardVideoGenerationRequest
  | StandardMusicGenerationRequest;

export function buildYirRequest(input: SubmitInput): YirRequest {
  const references = input.references.map((ref) => ({
    role: ref.role,
    url: ref.url,
    ...(ref.subject ? { subject: ref.subject } : {}),
  }));
  const base = {
    model: input.upstreamModel,
    parameters: input.parameters,
    ...(input.maxCost ? { max_cost: input.maxCost } : {}),
  };
  // Music takes text only: a style prompt plus the lyrics, when the user wrote them.
  if (input.kind === 'music') {
    if (references.length) throw new UpstreamError('invalid_input', 'music jobs take no references', false);
    return {
      ...base,
      input: { type: 'text', prompt: input.prompt, ...(input.lyrics ? { lyrics: input.lyrics } : {}) },
    };
  }
  if (references.length === 0) return { ...base, input: { type: 'text', prompt: input.prompt } };
  // Video image mode only accepts first/last frames; reference images and videos need reference mode.
  const type =
    input.kind === 'video' && references.some((ref) => ref.role.startsWith('reference_'))
      ? 'reference'
      : 'image';
  return {
    ...base,
    input: { type, prompt: input.prompt, references },
  } as StandardImageGenerationRequest | StandardVideoGenerationRequest;
}

export class YirAdapter implements UpstreamAdapter {
  readonly name = 'yir';
  private instance: YirClient | null;

  constructor(
    private readonly options: { apiKey: string; baseURL?: string; referralCode?: string; demo?: boolean },
    client?: YirClient,
  ) {
    this.instance = client ?? null;
  }

  /** Created lazily: a missing API key raises a non-retryable error inside a step, so the job fails and is refunded instead of hanging. */
  private get client(): YirClient {
    if (this.instance) return this.instance;
    if (!this.options.apiKey) throw new UpstreamError('yir_not_configured', 'YIR_API_KEY is not set', false);
    this.instance = createNodeYirClient({
      apiKey: this.options.apiKey,
      userAgent: YIR_USER_AGENT,
      ...(this.options.baseURL ? { baseURL: this.options.baseURL } : {}),
      ...(this.options.referralCode ? { referralCode: this.options.referralCode } : {}),
      // Explicit, so only the site's own env decides (an unrelated YIR_DEMO in the process environment doesn't).
      demo: this.options.demo === true,
    });
    return this.instance;
  }

  async submit(input: SubmitInput, idempotencyKey: string) {
    const request = buildYirRequest(input);
    try {
      const job =
        input.kind === 'music'
          ? await this.client.submitMusic(request as StandardMusicGenerationRequest, idempotencyKey)
          : input.kind === 'video'
            ? await this.client.submitVideo(request as StandardVideoGenerationRequest, idempotencyKey)
            : await this.client.submitImage(request as StandardImageGenerationRequest, idempotencyKey);
      return { upstreamJobId: job.id };
    } catch (error) {
      throw error instanceof UpstreamError ? error : toUpstreamError(error);
    }
  }

  validate(input: SubmitInput): void {
    try {
      validateGeneration(
        input.kind === 'video'
          ? 'generate_video'
          : input.kind === 'music'
            ? 'generate_music'
            : 'generate_image',
        buildYirRequest(input),
      );
    } catch (error) {
      throw toUpstreamError(error);
    }
  }

  async poll(upstreamJobId: string, waitSeconds: number): Promise<PollResult> {
    let status: Awaited<ReturnType<YirClient['getJobStatus']>>;
    try {
      status = await this.client.getJobStatus(upstreamJobId, { waitSeconds });
    } catch (error) {
      throw error instanceof UpstreamError ? error : toUpstreamError(error);
    }
    if (status.status === 'failed' || status.status === 'cancelled') {
      return {
        state: 'failed',
        code:
          status.error?.code ?? (status.status === 'cancelled' ? 'upstream_cancelled' : 'upstream_failed'),
        message: status.error?.message ?? status.status,
      };
    }
    if (status.status !== 'succeeded') return { state: 'running' };
    const job = await this.client.getJob(upstreamJobId);
    if (job.result?.availability !== 'available') {
      return { state: 'failed', code: 'result_expired', message: 'upstream result is no longer available' };
    }
    return {
      state: 'succeeded',
      files: job.result.files.map((file) => ({ url: file.url, mediaType: file.media_type })),
    };
  }

  /** Billing can still be pending after the result lands. Only an explicit `settled` counts as final: Yir says absent or unknown status is unconfirmed. */
  async cost(upstreamJobId: string): Promise<UpstreamCost> {
    let job: Awaited<ReturnType<YirClient['getJob']>>;
    try {
      job = await this.client.getJob(upstreamJobId);
    } catch (error) {
      throw error instanceof UpstreamError ? error : toUpstreamError(error);
    }
    if (!job.billing) return { usd: '0', settled: false };
    return { usd: job.billing.total_charged_by_yir, settled: job.billing.status === 'settled' };
  }

  async cancel(upstreamJobId: string) {
    try {
      await this.client.cancelJob(upstreamJobId);
    } catch (error) {
      // A finished task can't be canceled; not treated as an error. Since SDK 0.14 cancelJob resolves with a finished Job instead of
      // the 409; the code check stays for older Gateways. An unfinished demo Job can't be canceled either (demo mode, testing only):
      // it ends by itself, and the local job is already terminal.
      const upstream = toUpstreamError(error);
      if (upstream.code !== 'YIR_JOB_NOT_CANCELLABLE' && upstream.message !== 'demo_cancel_unsupported')
        throw upstream;
    }
  }
}
