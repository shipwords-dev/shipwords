import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { grantSignupBonus } from '../src/auth/server';
import { getBalance } from '../src/credits/ledger';
import { quotaCounters } from '../src/db/schema';
import { defineSite } from '../src/site';
import { db } from './db';

let seq = 0;
const uid = () => `u_${++seq}_${crypto.randomUUID().slice(0, 8)}`;
// Each test runs on its own UTC day, so the shared daily counters start at zero.
let day = 0;

function deps(signup: { bonusPerIpDaily: number; bonusSiteDaily: number }) {
  const site = defineSite({
    id: 'test',
    name: 'Test',
    url: 'https://test.example',
    locales: ['en'],
    defaultLocale: 'en',
    products: [],
    signup: { bonusCredits: 2, bonusExpiresDays: 30, ...signup },
    guest: { dailyPerDevice: 1, dailyPerIp: 3, dailySiteBudget: 100, minRecaptchaScore: 0.5 },
    billing: { provider: 'stripe', automaticTax: false },
  });
  return { db, site, log: () => {} };
}

const from = (ip: string) => new Headers({ 'cf-connecting-ip': ip });

async function count(key: string) {
  const window = new Date().toISOString().slice(0, 10);
  const row = await db.query.quotaCounters.findFirst({
    where: and(eq(quotaCounters.key, key), eq(quotaCounters.window, window)),
  });
  return row?.count ?? 0;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2030, 0, 1 + ++day, 12));
});
afterEach(() => vi.useRealTimers());

describe('sign-up bonus', () => {
  it('grants once per user even when the hook fires again', async () => {
    const d = deps({ bonusPerIpDaily: 3, bonusSiteDaily: 10 });
    const userId = uid();
    await grantSignupBonus(d, userId, from('203.0.113.1'));
    await grantSignupBonus(d, userId, from('203.0.113.1'));
    expect((await getBalance(db, userId)).available).toBe(2);
    expect(await count('signup-bonus:site')).toBe(1);
  });

  it('stops at the per-IP daily limit', async () => {
    const d = deps({ bonusPerIpDaily: 1, bonusSiteDaily: 10 });
    const [a, b] = [uid(), uid()];
    await grantSignupBonus(d, a, from('203.0.113.2'));
    await grantSignupBonus(d, b, from('203.0.113.2'));
    expect((await getBalance(db, a)).available).toBe(2);
    expect((await getBalance(db, b)).available).toBe(0);
  });

  it('stops at the site-wide daily limit across different IPs, without using up the IP slot', async () => {
    const d = deps({ bonusPerIpDaily: 3, bonusSiteDaily: 2 });
    const users = [uid(), uid(), uid()];
    await grantSignupBonus(d, users[0]!, from('198.51.100.1'));
    await grantSignupBonus(d, users[1]!, from('198.51.100.2'));
    await grantSignupBonus(d, users[2]!, from('198.51.100.3'));
    const balances = await Promise.all(users.map(async (id) => (await getBalance(db, id)).available));
    expect(balances).toEqual([2, 2, 0]);
    expect(await count('signup-bonus:site')).toBe(2);
    // The rejected attempt rolled back its IP count.
    expect(await count('signup-bonus:ip:198.51.100.3')).toBe(0);
  });

  it('applies the site-wide limit when the request has no client IP', async () => {
    const d = deps({ bonusPerIpDaily: 3, bonusSiteDaily: 1 });
    const [a, b] = [uid(), uid()];
    await grantSignupBonus(d, a, undefined);
    await grantSignupBonus(d, b, undefined);
    expect((await getBalance(db, a)).available).toBe(2);
    expect((await getBalance(db, b)).available).toBe(0);
  });

  it('concurrent hooks for one user grant once and count one slot', async () => {
    const d = deps({ bonusPerIpDaily: 3, bonusSiteDaily: 10 });
    const userId = uid();
    await Promise.all([
      grantSignupBonus(d, userId, from('203.0.113.9')),
      grantSignupBonus(d, userId, from('203.0.113.9')),
      grantSignupBonus(d, userId, from('203.0.113.9')),
    ]);
    expect((await getBalance(db, userId)).available).toBe(2);
    expect(await count('signup-bonus:site')).toBe(1);
    expect(await count('signup-bonus:ip:203.0.113.9')).toBe(1);
  });

  it('never grants more than the site limit under concurrent sign-ups', async () => {
    const d = deps({ bonusPerIpDaily: 100, bonusSiteDaily: 3 });
    const users = Array.from({ length: 8 }, uid);
    await Promise.all(users.map((id, i) => grantSignupBonus(d, id, from(`192.0.2.${i + 1}`))));
    const granted = (await Promise.all(users.map(async (id) => (await getBalance(db, id)).available))).filter(
      (n) => n > 0,
    );
    expect(granted).toHaveLength(3);
    expect(await count('signup-bonus:site')).toBe(3);
  });
});
