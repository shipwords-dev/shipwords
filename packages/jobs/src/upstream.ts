// Upstream adapter: only submits, queries and cancels; never touches the database or credits.
// Another upstream (e.g. any async task API) just implements this interface.

export interface SubmitInput {
  upstreamModel: string;
  kind: 'image' | 'video' | 'music';
  /** For music: the style prompt. */
  prompt: string;
  /** Music only: song lyrics; absent when the model writes them or makes an instrumental. */
  lyrics?: string;
  /** Reference images: public HTTPS URLs; subject groups several photos of one person for upstreams that take them (Kling subjects). */
  references: { url: string; role: string; subject?: string }[];
  parameters: Record<string, unknown>;
  /** Cost cap per task (USD string); unlimited if unset. */
  maxCost?: string;
}

export interface OutputFile {
  url: string;
  mediaType: string;
}

export type PollResult =
  | { state: 'running' }
  | { state: 'succeeded'; files: OutputFile[] }
  | { state: 'failed'; code: string; message: string };

export interface UpstreamCost {
  /** Amount charged so far (USD string). */
  usd: string;
  /** false while the upstream may still change the amount. */
  settled: boolean;
}

export class UpstreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** false means retrying won't help (bad parameters, content rejected, etc.); fail immediately. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface UpstreamAdapter {
  readonly name: string;
  /** Local structural validation only; must not submit or charge. */
  validate?(input: SubmitInput): void;
  /** Repeated submits with the same idempotencyKey must return the same upstream task. */
  submit(input: SubmitInput, idempotencyKey: string): Promise<{ upstreamJobId: string }>;
  /** Long poll: waits up to waitSeconds, returns immediately on a state change or completion. */
  poll(upstreamJobId: string, waitSeconds: number): Promise<PollResult>;
  cancel(upstreamJobId: string): Promise<void>;
  /** What the upstream charged for this task; optional, an adapter without it leaves the job's cost unrecorded. */
  cost?(upstreamJobId: string): Promise<UpstreamCost>;
}
