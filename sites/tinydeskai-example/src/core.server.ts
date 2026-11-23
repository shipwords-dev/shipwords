import { createDb } from '@shipwords/core/db/client';
import { createCore } from '@shipwords/core/server';
import type { JobsEnv } from '@shipwords/jobs/adapters';
import { type ReplaceOutputInput, replaceJobOutput } from '@shipwords/jobs/admin';
import { createJobs } from '@shipwords/jobs/handlers';
import { startSiteJobWorker } from '@shipwords/jobs/runtime';
import { type ObjectStore, storeFromEnv } from '@shipwords/jobs/store';
import type { JobWorker } from '@shipwords/jobs/worker';
import site from '../site.config';
import models from './models.server';
import { createHandoffApi } from './site/handoff.server';

// Server singleton: route files only forward; business logic lives in packages.
export const core = createCore(site);

const env = () => process.env as unknown as JobsEnv;

/** This site's file store (S3/R2 or a local directory), one instance shared by the jobs API, the job worker and the phone handoff. */
let configuredStore: ObjectStore | null = null;
export const siteStore = (): ObjectStore => (configuredStore ??= storeFromEnv(env()));

// The process's job worker lives on globalThis: a dev-server reload re-runs this module, and must not leave two workers running.
const holder = globalThis as { shipwordsWorker?: { worker: JobWorker; models: unknown } };

/**
 * Starts this process's job worker; called once by the server entry (src/server.ts), never by importing this module, so a test or a
 * build that imports a route doesn't start claiming and running jobs. JOB_WORKER=0 runs a process that only serves pages and API.
 * After a dev reload with changed models, the old worker is stopped and a new one runs the current models.
 * Signed-in users get an email when their video finishes or fails; a job still missing a swap after repairs sends a review alert to
 * REVIEW_EMAIL; person descriptions use the AI Gateway (AI_GATEWAY_API_KEY) or else Workers AI (CLOUDFLARE_*).
 */
export function startJobWorker(): void {
  if (process.env.JOB_WORKER === '0') return;
  const current = holder.shipwordsWorker;
  if (current?.models === models) return;
  if (current) void current.worker.stop();
  holder.shipwordsWorker = {
    models,
    worker: startSiteJobWorker(env(), models, site, { db: core.db, store: siteStore() }),
  };
}

export const jobsApi = createJobs(core, models, {
  store: siteStore(),
  wake: () => holder.shipwordsWorker?.worker.wake(),
});
export const handoffApi = createHandoffApi(() => core.db, siteStore);

/**
 * Owner operations run by hand (such as the template's replace-output.mjs, which swaps a delivered output after a redo), with this
 * site's database and storage. They open their own connection: core.db would build the whole core (auth, payments) and need every
 * secret just to update one row.
 */
export const admin = {
  replaceOutput: (input: ReplaceOutputInput) => {
    if (!env().DATABASE_URL) throw new Error('DATABASE_URL is not set');
    return replaceJobOutput({ db: createDb(env().DATABASE_URL), store: storeFromEnv(env()) }, input);
  },
};

/** Lets steps in flight finish and hands the worker's runs back; call before the process exits. */
export async function shutdown(): Promise<void> {
  await holder.shipwordsWorker?.worker.stop();
}
