import { createDb } from '@shipwords/core/db/client';
import { createCore } from '@shipwords/core/server';
import type { JobsEnv } from '@shipwords/jobs/adapters';
import { type ReplaceOutputInput, replaceJobOutput } from '@shipwords/jobs/admin';
import { createJobs } from '@shipwords/jobs/handlers';
import { startSiteJobWorker } from '@shipwords/jobs/runtime';
import { storeFromEnv } from '@shipwords/jobs/store';
import type { JobWorker } from '@shipwords/jobs/worker';
import site from '../site.config';
import models from './models.server';

// Server singleton: route files only delegate; business logic lives in packages.
export const core = createCore(site);

// The process's job worker lives on globalThis: a dev-server reload re-runs this module, and must not leave two workers running.
const holder = globalThis as { shipwordsWorker?: { worker: JobWorker; models: unknown } };

/**
 * Starts this process's job worker; called once by the server entry (src/server.ts), never by importing this module, so a test or a
 * build that imports a route doesn't start claiming and running jobs. JOB_WORKER=0 runs a process that only serves pages and API.
 * After a dev reload with changed models, the old worker is stopped and a new one runs the current models.
 */
export function startJobWorker(): void {
  if (process.env.JOB_WORKER === '0') return;
  const current = holder.shipwordsWorker;
  if (current?.models === models) return;
  if (current) void current.worker.stop();
  holder.shipwordsWorker = {
    models,
    worker: startSiteJobWorker(process.env as unknown as JobsEnv, models, site, { db: core.db }),
  };
}

export const jobsApi = createJobs(core, models, { wake: () => holder.shipwordsWorker?.worker.wake() });

/**
 * Owner operations run by hand from the site's scripts (replace-output.mjs), with this site's database and bucket. They open their
 * own connection: core.db would build the whole core (auth, payments) and need every secret just to update one row.
 */
export const admin = {
  replaceOutput: (input: ReplaceOutputInput) => {
    const env = process.env as unknown as JobsEnv;
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    return replaceJobOutput({ db: createDb(env.DATABASE_URL), store: storeFromEnv(env) }, input);
  },
};

/** Lets steps in flight finish and hands the worker's runs back; call before the process exits. */
export async function shutdown(): Promise<void> {
  await holder.shipwordsWorker?.worker.stop();
}
