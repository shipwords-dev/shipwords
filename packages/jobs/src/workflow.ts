import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { createDb } from '@shipwords/core/db/client';
import type { SiteConfig } from '@shipwords/core/site';
import { containerComposer } from './compose';
import { markFailed } from './lifecycle';
import { MockAdapter, mockComposer, mockMode } from './mock';
import type { ModelDefinition } from './models';
import { emailOnFinish } from './notify';
import { runGeneration } from './runner';
import type { UpstreamAdapter } from './upstream';
import { YirAdapter } from './yir';

export interface JobsEnv {
  DB: D1Database;
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

function fixedMockResult(env: JobsEnv) {
  if (!env.UPSTREAM_MOCK_RESULT) return undefined;
  return {
    song: env.UPSTREAM_MOCK_RESULT,
    silent: env.UPSTREAM_MOCK_RESULT_SILENT ?? env.UPSTREAM_MOCK_RESULT,
  };
}

const STEP_RETRIES = { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' } } as const;

/**
 * Sites export it from the Worker entry: export const GenerationWorkflow = defineGenerationWorkflow(models, site);
 * When site is passed and EMAIL is bound, signed-in users get an email when a job succeeds or fails;
 * a site whose jobs are only stages of a larger result passes `{ emails: false }` to keep those mails out.
 * workflows[].class_name in wrangler.jsonc must use the same name.
 */
export function defineGenerationWorkflow(
  models: readonly ModelDefinition[],
  site?: SiteConfig,
  options: { emails?: boolean } = {},
) {
  return class GenerationWorkflow extends WorkflowEntrypoint<JobsEnv, { jobId: string }> {
    override async run(event: Readonly<WorkflowEvent<{ jobId: string }>>, step: WorkflowStep) {
      const env = this.env;
      const db = createDb(env.DB);
      const baseURL = (env.APP_URL ?? site?.url)?.replace(/\/$/, '');
      try {
        await runGeneration(
          {
            db,
            bucket: env.OUTPUTS,
            models,
            adapters: createAdapters(env),
            ...(mockMode(env)
              ? { composer: mockComposer(env.OUTPUTS, fixedMockResult(env)) }
              : env.COMPOSE
                ? { composer: containerComposer(env.COMPOSE, env.OUTPUTS) }
                : {}),
            // Served by the site's /files route (handlers.ts file), the same origin the upload URLs use.
            ...(baseURL ? { fileUrl: (key: string) => `${baseURL}/files/${key}` } : {}),
            ...(site && options.emails !== false && env.EMAIL && env.EMAIL_FROM
              ? {
                  notify: emailOnFinish({
                    db,
                    email: env.EMAIL,
                    from: env.EMAIL_FROM,
                    site,
                    baseURL: (env.APP_URL ?? site.url).replace(/\/$/, ''),
                  }),
                }
              : {}),
            log: console.log,
          },
          event.payload.jobId,
          {
            do: (name, fn) => step.do(name, STEP_RETRIES, fn as () => Promise<never>),
            sleep: (name, ms) => step.sleep(name, ms),
          },
        );
      } catch (error) {
        // runGeneration has its own fallback; this catches errors outside steps (e.g. failing to construct the adapter).
        await step.do('abort:outer', async () => {
          await markFailed(db, event.payload.jobId, 'failed', 'internal_error', String(error));
          return true;
        });
      }
    }
  };
}
