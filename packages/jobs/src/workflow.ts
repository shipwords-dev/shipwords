import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { createDb } from '@shipwords/core/db/client';
import type { SiteConfig } from '@shipwords/core/site';
import { createAdapters, type JobsEnv } from './adapters';
import { markFailed } from './lifecycle';
import type { ModelDefinition } from './models';
import { runGeneration } from './runner';
import { runnerDeps } from './runtime';

export { createAdapters, type JobsEnv };

// Cloudflare Workflows entry, kept only until the template moves to Node (docs/live/node-postgres-runtime.md step 5).
// Jobs are no longer dispatched to it: runs are queued in job_runs and executed by worker.ts (runtime.ts startSiteJobWorker).

const STEP_RETRIES = { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' } } as const;

/** @deprecated Use startSiteJobWorker from ./runtime. */
export function defineGenerationWorkflow(
  models: readonly ModelDefinition[],
  site?: SiteConfig,
  options: { emails?: boolean } = {},
) {
  return class GenerationWorkflow extends WorkflowEntrypoint<JobsEnv, { jobId: string }> {
    override async run(event: Readonly<WorkflowEvent<{ jobId: string }>>, step: WorkflowStep) {
      const db = createDb(this.env.DATABASE_URL);
      try {
        await runGeneration(runnerDeps(this.env, db, models, site, options), event.payload.jobId, {
          do: (name, fn) => step.do(name, STEP_RETRIES, fn as () => Promise<never>),
          sleep: (name, ms) => step.sleep(name, ms),
        });
      } catch (error) {
        await step.do('abort:outer', async () => {
          // Its own code: the runner never ran, so no failure-streak check ran for it (failures.ts UNCHECKED_FAILURES).
          await markFailed(db, event.payload.jobId, 'failed', 'workflow_failed', String(error));
          return true;
        });
      }
    }
  };
}
