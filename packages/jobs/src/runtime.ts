import { createDb, type Db } from '@shipwords/core/db/client';
import type { SiteConfig } from '@shipwords/core/site';
import { createAdapters, fixedMockResult, type JobsEnv } from './adapters';
import { containerComposer } from './compose';
import { workersAiDescribe } from './describe';
import { mockComposer, mockMode } from './mock';
import type { ModelDefinition } from './models';
import { emailFailures, emailOnFinish, emailReview } from './notify';
import type { RunnerDeps } from './runner';
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
  options: SiteRunnerOptions = {},
): RunnerDeps {
  const baseURL = (env.APP_URL ?? site?.url)?.replace(/\/$/, '');
  return {
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
      ? { notify: emailOnFinish({ db, email: env.EMAIL, from: env.EMAIL_FROM, site, baseURL: baseURL! }) }
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
          failures: emailFailures({ email: env.EMAIL, from: env.EMAIL_FROM, to: env.REVIEW_EMAIL, site }),
        }
      : {}),
    log: (message, details) => console.log(JSON.stringify({ level: 'info', message, ...details })),
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
  options: SiteRunnerOptions & { db?: Db; worker?: WorkerOptions } = {},
): JobWorker {
  const db = options.db ?? createDb(env.DATABASE_URL);
  return startJobWorker(runnerDeps(env, db, models, site, options), options.worker);
}
