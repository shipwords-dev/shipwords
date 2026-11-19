import { createDb, type Db } from '@shipwords/core/db/client';
import { canSendMail, type Mailer, mailerFromEnv } from '@shipwords/core/email/mailer';
import type { SiteConfig } from '@shipwords/core/site';
import { createAdapters, fixedMockResult, type JobsEnv } from './adapters';
import { httpComposer } from './compose';
import { workersAiDescribe } from './describe';
import { mockComposer, mockMode } from './mock';
import type { ModelDefinition } from './models';
import { emailFailures, emailOnFinish, emailReview } from './notify';
import type { RunnerDeps } from './runner';
import { type ObjectStore, storeFromEnv } from './store';
import { type JobWorker, startJobWorker, type WorkerOptions } from './worker';

export interface SiteRunnerOptions {
  /** A site whose jobs are only stages of a larger result passes false to keep per-job emails out. */
  emails?: boolean;
}

/**
 * The runner's dependencies from a site's environment. When site is passed and email is configured, signed-in users get an email
 * when a job succeeds or fails, and REVIEW_EMAIL gets review notes and failure-streak alerts.
 */
export function runnerDeps(
  env: JobsEnv,
  db: Db,
  models: readonly ModelDefinition[],
  site?: SiteConfig,
  options: SiteRunnerOptions & { store?: ObjectStore; mailer?: Mailer } = {},
): RunnerDeps {
  const appUrl = env.APP_URL ?? site?.url;
  const baseURL = appUrl?.endsWith('/') ? appUrl.slice(0, -1) : appUrl;
  const log = (message: string, details: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'info', message, ...details }));
  const store = options.store ?? storeFromEnv(env);
  const mailer = options.mailer ?? mailerFromEnv(env, log);
  // Job emails are best effort: with no way to send, skip them rather than retry a certain failure on every finished job.
  const from = options.mailer || canSendMail(env) ? env.EMAIL_FROM : undefined;
  return {
    db,
    bucket: store,
    models,
    adapters: createAdapters(env),
    ...(mockMode(env)
      ? { composer: mockComposer(store, fixedMockResult(env)) }
      : env.COMPOSE_URL
        ? { composer: httpComposer(env.COMPOSE_URL, store) }
        : {}),
    // Served by the site's /files route (handlers.ts file), the same origin the upload URLs use.
    ...(baseURL ? { fileUrl: (key: string) => `${baseURL}/files/${key}` } : {}),
    ...(site && options.emails !== false && from
      ? { notify: emailOnFinish({ db, email: mailer, from, site, baseURL: baseURL! }) }
      : {}),
    ...(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN
      ? {
          describe: workersAiDescribe({
            accountId: env.CLOUDFLARE_ACCOUNT_ID,
            apiToken: env.CLOUDFLARE_API_TOKEN,
          }),
        }
      : {}),
    ...(site && from && env.REVIEW_EMAIL
      ? {
          review: emailReview({ email: mailer, from, to: env.REVIEW_EMAIL, site, baseURL: baseURL! }),
          failures: emailFailures({ email: mailer, from, to: env.REVIEW_EMAIL, site }),
        }
      : {}),
    log,
  };
}

/**
 * Starts this process's job worker for a site. Call once at server start, pass worker.wake to createJobs, and call
 * worker.stop() on SIGTERM. Throws at once on a broken configuration (e.g. UPSTREAM_MOCK on a live site) rather than per job.
 */
export function startSiteJobWorker(
  env: JobsEnv,
  models: readonly ModelDefinition[],
  site: SiteConfig,
  options: SiteRunnerOptions & { db?: Db; store?: ObjectStore; worker?: WorkerOptions } = {},
): JobWorker {
  const db = options.db ?? createDb(env.DATABASE_URL);
  return startJobWorker(runnerDeps(env, db, models, site, options), options.worker);
}
