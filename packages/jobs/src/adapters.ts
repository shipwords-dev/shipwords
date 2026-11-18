import type { MailerEnv } from '@shipwords/core/email/mailer';
import { MockAdapter, mockMode } from './mock';
import type { StoreEnv } from './store';
import type { UpstreamAdapter } from './upstream';
import { YirAdapter } from './yir';

// Settings and secrets the generation runtime reads, and the upstream adapters built from them.

export interface JobsEnv extends StoreEnv, MailerEnv {
  DATABASE_URL: string;
  YIR_API_KEY: string;
  YIR_BASE_URL?: string;
  /** Yir referral code included for people deploying this starter; optional for your own sites. */
  YIR_REFERRAL_CODE?: string;
  /** The compose service (packages/jobs/compose), e.g. http://compose:8080; sites without effect compose don't need it. */
  COMPOSE_URL?: string;
  /** Sender of job emails, the same address as sign-in codes. Sending uses CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. */
  EMAIL_FROM?: string;
  /** Where to send notes about delivered jobs that need a human look (people the repair passes couldn't swap); unset sends none. */
  REVIEW_EMAIL?: string;
  /** Describing the people in effect prep images (effect.describe) uses Workers AI with the same Cloudflare credentials; without them descriptions are left out. */
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
