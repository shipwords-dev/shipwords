import { describe, expect, it } from 'vitest';
import { createAuth } from '../src/auth/server';
import type { CoreEnv } from '../src/env';
import { defineSite } from '../src/site';
import { db } from './db';

const site = defineSite({
  id: 'test',
  name: 'Test',
  url: 'https://test.example',
  locales: ['en'],
  defaultLocale: 'en',
  products: [],
  signup: { bonusCredits: 0, bonusExpiresDays: null, bonusPerIpDaily: 3, bonusSiteDaily: 100 },
  guest: { dailyPerDevice: 1, dailyPerIp: 3, dailySiteBudget: 100, minRecaptchaScore: 0.5 },
  billing: { provider: 'stripe', automaticTax: false },
});

const auth = (secret: string | undefined) =>
  createAuth({
    db,
    env: { BETTER_AUTH_SECRET: secret } as unknown as CoreEnv,
    site,
    baseURL: 'https://test.example',
    log: () => {},
    mailer: { send: async () => {} },
  });

describe('auth secret', () => {
  it('refuses to start without a real secret instead of falling back to the public default', () => {
    expect(() => auth(undefined)).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => auth('')).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => auth('replace-with-32-random-bytes')).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => auth('x'.repeat(32))).not.toThrow();
  });

  it('the email change link route, which signs users in, is disabled', async () => {
    const response = await auth('x'.repeat(32)).handler(
      new Request('https://test.example/api/auth/verify-email?token=forged'),
    );
    expect(response.status).toBe(404);
  });
});
