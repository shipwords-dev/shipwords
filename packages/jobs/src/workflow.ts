import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { createDb } from '@shipwords/core/db/client';
import type { SiteConfig } from '@shipwords/core/site';
import { createAdapters, fixedMockResult, type JobsEnv } from './adapters';

export { createAdapters, type JobsEnv };

import { containerComposer } from './compose';
import { workersAiDescribe } from './describe';
import { markFailed } from './lifecycle';
import { mockComposer, mockMode } from './mock';
import type { ModelDefinition } from './models';
import { emailFailures, emailOnFinish, emailReview } from './notify';
import { runGeneration } from './runner';

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
      const db = createDb(env.DATABASE_URL);
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
                    baseURL: baseURL!,
                  }),
                }
              : {}),
            ...(env.AI ? { describe: workersAiDescribe(env.AI) } : {}),
            ...(site && env.EMAIL && env.EMAIL_FROM && env.REVIEW_EMAIL
              ? {
                  review: emailReview({
                    email: env.EMAIL,
                    from: env.EMAIL_FROM,
                    to: env.REVIEW_EMAIL,
                    site,
                    baseURL: baseURL!,
                  }),
                  failures: emailFailures({
                    email: env.EMAIL,
                    from: env.EMAIL_FROM,
                    to: env.REVIEW_EMAIL,
                    site,
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
          // Its own code: the runner never ran, so no failure-streak check ran for it (failures.ts UNCHECKED_FAILURES).
          await markFailed(db, event.payload.jobId, 'failed', 'workflow_failed', String(error));
          return true;
        });
      }
    }
  };
}
