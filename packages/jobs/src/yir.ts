import { createNodeYirClient } from '@yir-ai/sdk/server';
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
 * The SDK already retries network errors and 502/503/504 on submits and status reads, and Yir retries the task across providers,
 * so an error that reaches us is final: retrying in the Workflow would only keep the user waiting. A rate limit (429) is the exception.
 */
function toUpstreamError(error: unknown): UpstreamError {
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
    private readonly options: { apiKey: string; baseURL?: string; referralCode?: string },
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
      ...(this.options.baseURL ? { baseURL: this.options.baseURL } : {}),
      ...(this.options.referralCode ? { referralCode: this.options.referralCode } : {}),
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
      // A finished task can't be canceled; not treated as an error.
      const upstream = toUpstreamError(error);
      if (upstream.code !== 'YIR_JOB_NOT_CANCELLABLE') throw upstream;
    }
  }
}
