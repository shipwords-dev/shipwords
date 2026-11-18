import { MockAdapter, mockMode } from './mock';
import type { UpstreamAdapter } from './upstream';
import { YirAdapter } from './yir';

// Bindings and secrets the generation runtime reads, and the upstream adapters built from them.

export interface JobsEnv {
  DATABASE_URL: string;
  OUTPUTS: R2Bucket;
  GENERATION_WORKFLOW: Workflow<{ jobId: string }>;
  YIR_API_KEY: string;
  YIR_BASE_URL?: string;
  /** Yir referral code included for people deploying this starter; optional for your own sites. */
  YIR_REFERRAL_CODE?: string;
  /** Effect compose container (Durable Object binding of the Container class); sites without effect compose don't need it. */
  COMPOSE?: DurableObjectNamespace;
  /** For job-finished emails; shares the send_email binding and sender address with sign-in codes. */
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  /** Where to send notes about delivered jobs that need a human look (people the repair passes couldn't swap); unset sends none. */
  REVIEW_EMAIL?: string;
  /** Workers AI, for describing the people in effect prep images (effect.describe); without it descriptions are left out. */
  AI?: Ai;
  APP_URL?: string;
  /** For testing flows locally or on a test-mode demo, see mock.ts. */
  UPSTREAM_MOCK?: string;
  /** Optional with UPSTREAM_MOCK: R2 keys of a fixed composed result (with track, silent) returned for every effect job. */
  UPSTREAM_MOCK_RESULT?: string;
  UPSTREAM_MOCK_RESULT_SILENT?: string;
}

export function createAdapters(env: JobsEnv): Record<string, UpstreamAdapter> {
  const mock = mockMode(env);
  // Fail closed: a site that asked for the mock must never fall through to the paid upstream (e.g. after a live key was set).
  if (!mock && env.UPSTREAM_MOCK)
    throw new Error(
      'UPSTREAM_MOCK is set but the mock is inactive (live payment key or non-local APP_URL); refusing to call the upstream',
    );
  if (mock) return { yir: new MockAdapter(mock, undefined, env.APP_URL!.replace(/\/$/, '')) };
  return {
    yir: new YirAdapter({
      apiKey: env.YIR_API_KEY,
      ...(env.YIR_BASE_URL ? { baseURL: env.YIR_BASE_URL } : {}),
      ...(env.YIR_REFERRAL_CODE ? { referralCode: env.YIR_REFERRAL_CODE } : {}),
    }),
  };
}

export function fixedMockResult(env: JobsEnv) {
  if (!env.UPSTREAM_MOCK_RESULT) return undefined;
  return {
    song: env.UPSTREAM_MOCK_RESULT,
    silent: env.UPSTREAM_MOCK_RESULT_SILENT ?? env.UPSTREAM_MOCK_RESULT,
  };
}
