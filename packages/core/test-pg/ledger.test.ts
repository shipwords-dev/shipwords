import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getBalance,
  grantCredits,
  InsufficientCreditsError,
  refundSpend,
  revokeCredits,
  spendCredits,
} from '../src/credits/ledger';
import type { Db } from '../src/db/client';
import { creditAccounts, creditLedger, creditLots } from '../src/db/schema';
import { consumeQuota } from '../src/quota/counters';
import { adminUrl, freshDatabase } from './pg';

// Many operations for one user at once, on separate connections, so they really contend for the account row lock.

const N = 30;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  if (!adminUrl) return;
  ({ db, close } = await freshDatabase());
});
afterAll(async () => close?.());

/** Balance from the ledger alone must equal the balance from lots and debt. */
async function consistent(userId: string) {
  const [{ sum }] = (await db
    .select({ sum: sql<string>`coalesce(sum(${creditLedger.delta}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))) as [{ sum: string }];
  const balance = await getBalance(db, userId);
  expect(balance.available).toBe(Number(sum));
  const lots = await db.select().from(creditLots).where(eq(creditLots.userId, userId));
  for (const lot of lots) expect(lot.remaining).toBeGreaterThanOrEqual(0);
  return balance;
}

describe.skipIf(!adminUrl)('ledger under real concurrency', () => {
  it('concurrent spends never overdraw: exactly the affordable ones succeed', async () => {
    const userId = crypto.randomUUID();
    await grantCredits(db, { userId, amount: 10, idemKey: `g:${userId}`, source: 'test' });
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        spendCredits(db, { userId, amount: 1, idemKey: `s:${userId}:${i}` }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled' && r.value.applied);
    const short = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof InsufficientCreditsError,
    );
    expect(ok).toHaveLength(10);
    expect(short).toHaveLength(N - 10);
    expect((await consistent(userId)).available).toBe(0);
  });

  it('the same idempotency key at once applies once', async () => {
    const userId = crypto.randomUUID();
    await grantCredits(db, { userId, amount: 100, idemKey: `g:${userId}`, source: 'test' });
    const results = await Promise.all(
      Array.from({ length: N }, () => spendCredits(db, { userId, amount: 3, idemKey: `same:${userId}` })),
    );
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(new Set(results.map((r) => r.ledgerId)).size).toBe(1);
    expect((await consistent(userId)).available).toBe(97);
  });

  it('the same grant key at once, for a brand-new account, applies once', async () => {
    const userId = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        grantCredits(db, { userId, amount: 5, idemKey: `pay:${userId}`, source: 'test' }),
      ),
    );
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect((await consistent(userId)).available).toBe(5);
    expect(await db.select().from(creditAccounts).where(eq(creditAccounts.userId, userId))).toHaveLength(1);
  });

  it('a refund raced against itself applies once', async () => {
    const userId = crypto.randomUUID();
    await grantCredits(db, { userId, amount: 10, idemKey: `g:${userId}`, source: 'test' });
    await spendCredits(db, { userId, amount: 4, idemKey: `job:${userId}` });
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        refundSpend(db, { spendIdemKey: `job:${userId}`, idemKey: `refund:job:${userId}` }),
      ),
    );
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect((await consistent(userId)).available).toBe(10);
  });

  it('grants, spends and clawbacks interleaved keep ledger, lots and debt in agreement', async () => {
    const userId = crypto.randomUUID();
    await grantCredits(db, { userId, amount: 20, idemKey: `g0:${userId}`, source: 'test' });
    const ops = Array.from({ length: N }, (_, i) => {
      const key = `${i}:${userId}`;
      if (i % 3 === 0) return grantCredits(db, { userId, amount: 2, idemKey: `g:${key}`, source: 'test' });
      if (i % 3 === 1) return spendCredits(db, { userId, amount: 3, idemKey: `s:${key}` }).catch(() => null);
      return revokeCredits(db, { userId, amount: 2, idemKey: `r:${key}` });
    });
    await Promise.all(ops);
    const balance = await consistent(userId);
    const [account] = await db.select().from(creditAccounts).where(eq(creditAccounts.userId, userId));
    expect(account!.debt).toBe(balance.debt);
    expect(account!.debt).toBeGreaterThanOrEqual(0);
  });

  it('a quota counter never passes its limit under concurrent requests', async () => {
    const rule = { key: `q:${crypto.randomUUID()}`, window: 'w', limit: 5 };
    const results = await Promise.all(Array.from({ length: N }, () => consumeQuota(db, [rule])));
    expect(results.filter(Boolean)).toHaveLength(5);
  });
});
