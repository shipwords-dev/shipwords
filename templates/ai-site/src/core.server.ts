import { createCore } from '@shipwords/core/server';
import type { JobsEnv } from '@shipwords/jobs/adapters';
import { createJobs } from '@shipwords/jobs/handlers';
import { startSiteJobWorker } from '@shipwords/jobs/runtime';
import type { JobWorker } from '@shipwords/jobs/worker';
import site from '../site.config';
import models from './models.server';

// Server singleton: route files only delegate; business logic lives in packages.
export const core = createCore(site);

// One job worker per process, started with the server. JOB_WORKER=0 runs a process that only serves pages and API.
// Kept on globalThis so a dev-server reload doesn't start a second one.
const holder = globalThis as { shipwordsWorker?: JobWorker };
function jobWorker(): JobWorker | null {
  if (process.env.JOB_WORKER === '0') return null;
  holder.shipwordsWorker ??= startSiteJobWorker(process.env as unknown as JobsEnv, models, site, {
    db: core.db,
  });
  return holder.shipwordsWorker;
}
const worker = jobWorker();

export const jobsApi = createJobs(core, models, { wake: () => worker?.wake() });

/** Lets steps in flight finish and hands the worker's runs back; call before the process exits. */
export async function shutdown(): Promise<void> {
  await worker?.stop();
}
