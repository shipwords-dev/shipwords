import { describe, expect, it } from 'vitest';
import { defineModels } from '../src/models';
import { runnerDeps } from '../src/runtime';
import { memoryStore } from '../src/store';
import { db } from './db';

const models = defineModels([
  {
    id: 'fast',
    name: 'Fast',
    kind: 'image',
    upstream: 'yir',
    upstreamModel: 'vendor/fast',
    credits: 1,
    guest: false,
    allowedParameters: [],
    maxReferences: 0,
    timeoutMinutes: 10,
  },
]);
const site = { id: 's', name: 'Site', url: 'https://site.example', defaultLocale: 'en' } as never;
const base = {
  DATABASE_URL: 'x',
  YIR_API_KEY: 'k',
  EMAIL_FROM: 'noreply@site.example',
  REVIEW_EMAIL: 'me@site.example',
};

describe('runner dependencies from the environment', () => {
  it('skips job emails when mail cannot be sent, instead of retrying a certain failure on every job', () => {
    const deps = runnerDeps(base, db, models, site, { store: memoryStore() });
    expect(deps.notify).toBeUndefined();
    expect(deps.review).toBeUndefined();
    expect(deps.failures).toBeUndefined();
  });

  it('wires job emails, review notes and image descriptions once Cloudflare credentials are set', () => {
    const deps = runnerDeps(
      {
        ...base,
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
        COMPOSE_URL: 'http://compose:8080',
      },
      db,
      models,
      site,
      { store: memoryStore() },
    );
    expect(deps.notify).toBeTypeOf('function');
    expect(deps.review).toBeTypeOf('function');
    expect(deps.failures).toBeTypeOf('function');
    expect(deps.describe).toBeTypeOf('function');
    expect(deps.composer).toBeDefined();
  });
});
