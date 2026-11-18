import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  getBalance,
  grantCredits,
  InsufficientCreditsError,
  refundSpend,
  revokeCredits,
  spendCredits,
} from '../src/credits/ledger';
import { creditLots } from '../src/db/schema';
import { db } from './db';

let seq = 0;
const uid = () => `u_${++seq}_${crypto.randomUUID().slice(0, 8)}`;
const DAY = 86_400_000;

describe('credit ledger', () => {
  it('grants are idempotent: one key grants once', async () => {
    const userId = uid();
    const first = await grantCredits(db, { userId, amount: 100, idemKey: `g:${userId}`, source: 'test' });
    const second = await grantCredits(db, { userId, amount: 100, idemKey: `g:${userId}`, source: 'test' });
    expect(first.applied).toBe(true);
    expect(second).toEqual({ applied: false, ledgerId: first.ledgerId });
    expect((await getBalance(db, userId)).available).toBe(100);
  });

  it('charges earliest-expiring lots first and never-expiring lots last', async () => {
    const userId = uid();
    await grantCredits(db, {
      userId,
      amount: 50,
      idemKey: `p:${userId}`,
      source: 'pack',
      sourceRef: 'forever',
    });
    await grantCredits(db, {
      userId,
      amount: 30,
      idemKey: `s:${userId}`,
      source: 'sub',
      sourceRef: 'soon',
      expiresAt: Date.now() + DAY,
    });
    await spendCredits(db, { userId, amount: 40, idemKey: `x:${userId}` });
    const lots = await db.select().from(creditLots).where(eq(creditLots.userId, userId));
    expect(lots.find((lot) => lot.sourceRef === 'soon')?.remaining).toBe(0);
    expect(lots.find((lot) => lot.sourceRef === 'forever')?.remaining).toBe(40);
  });

  it('expired lots do not count toward balance and are not charged', async () => {
    const userId = uid();
    await grantCredits(db, {
      userId,
      amount: 20,
      idemKey: `e:${userId}`,
      source: 'sub',
      expiresAt: Date.now() - 1,
    });
    expect((await getBalance(db, userId)).available).toBe(0);
    await expect(spendCredits(db, { userId, amount: 1, idemKey: `x:${userId}` })).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
  });

  it('writes nothing on insufficient balance; duplicate charge requests do not report insufficient balance', async () => {
    const userId = uid();
    await grantCredits(db, { userId, amount: 10, idemKey: `g:${userId}`, source: 'test' });
    await expect(spendCredits(db, { userId, amount: 11, idemKey: `big:${userId}` })).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
    const spent = await spendCredits(db, { userId, amount: 10, idemKey: `job:${userId}` });
    const again = await spendCredits(db, { userId, amount: 10, idemKey: `job:${userId}` });
    expect(spent.applied).toBe(true);
    expect(again).toEqual({ applied: false, ledgerId: spent.ledgerId });
    expect((await getBalance(db, userId)).available).toBe(0);
  });

  it('concurrent charges never go negative', async () => {
    const userId = uid();
    await grantCredits(db, { userId, amount: 30, idemKey: `g:${userId}`, source: 'test' });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        spendCredits(db, { userId, amount: 10, idemKey: `c:${userId}:${i}` }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(3);
    expect(failed.every((r) => r.status === 'rejected' && r.reason instanceof InsufficientCreditsError)).toBe(
      true,
    );
    expect((await getBalance(db, userId)).available).toBe(0);
  });

  it('refunding a charge returns credits to the original lots, only once', async () => {
    const userId = uid();
    await grantCredits(db, { userId, amount: 25, idemKey: `g:${userId}`, source: 'test' });
    await spendCredits(db, { userId, amount: 20, idemKey: `job:${userId}` });
    const refund = await refundSpend(db, { spendIdemKey: `job:${userId}`, idemKey: `refund:${userId}` });
    const again = await refundSpend(db, { spendIdemKey: `job:${userId}`, idemKey: `refund:${userId}` });
    expect(refund.applied).toBe(true);
    expect(again.applied).toBe(false);
    expect((await getBalance(db, userId)).available).toBe(25);
    expect((await refundSpend(db, { spendIdemKey: 'missing', idemKey: 'r:missing' })).applied).toBe(false);
  });

  it('a clawback shortfall becomes debt, and later grants repay debt first', async () => {
    const userId = uid();
    await grantCredits(db, {
      userId,
      amount: 100,
      idemKey: `pay1:${userId}`,
      source: 'pack',
      sourceRef: 'pay1',
    });
    await spendCredits(db, { userId, amount: 80, idemKey: `job:${userId}` });
    await revokeCredits(db, { userId, amount: 100, idemKey: `rv:${userId}`, preferSourceRef: 'pay1' });
    expect(await getBalance(db, userId)).toMatchObject({ available: -80, debt: 80 });
    await expect(spendCredits(db, { userId, amount: 1, idemKey: `job2:${userId}` })).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
    await grantCredits(db, { userId, amount: 50, idemKey: `pay2:${userId}`, source: 'pack' });
    expect(await getBalance(db, userId)).toMatchObject({ available: -30, debt: 30 });
    await grantCredits(db, { userId, amount: 50, idemKey: `pay3:${userId}`, source: 'pack' });
    expect(await getBalance(db, userId)).toMatchObject({ available: 20, debt: 0 });
  });

  it('refunding a charge with debt repays debt first instead of giving new credits the old lots expiry', async () => {
    const userId = uid();
    await grantCredits(db, {
      userId,
      amount: 100,
      idemKey: `pack:${userId}`,
      source: 'pack',
      sourceRef: 'pack',
    });
    await spendCredits(db, { userId, amount: 100, idemKey: `job:${userId}` });
    await revokeCredits(db, { userId, amount: 100, idemKey: `rv:${userId}`, preferSourceRef: 'pack' });
    expect(await getBalance(db, userId)).toMatchObject({ available: -100, debt: 100 });
    await refundSpend(db, { spendIdemKey: `job:${userId}`, idemKey: `refund:${userId}` });
    expect(await getBalance(db, userId)).toMatchObject({ available: 0, debt: 0 });
    const periodEnd = Date.now() + DAY;
    await grantCredits(db, {
      userId,
      amount: 600,
      idemKey: `sub:${userId}`,
      source: 'sub',
      expiresAt: periodEnd,
    });
    expect((await getBalance(db, userId)).available).toBe(600);
    expect((await getBalance(db, userId, periodEnd + 1)).available).toBe(0);
  });

  it('concurrent refund and clawback also never leave "lot credits + equal debt"', async () => {
    for (let round = 0; round < 5; round++) {
      const userId = uid();
      await grantCredits(db, {
        userId,
        amount: 100,
        idemKey: `pack:${userId}`,
        source: 'pack',
        sourceRef: 'pack',
      });
      await spendCredits(db, { userId, amount: 100, idemKey: `job:${userId}` });
      await Promise.all([
        refundSpend(db, { spendIdemKey: `job:${userId}`, idemKey: `refund:${userId}` }),
        revokeCredits(db, { userId, amount: 100, idemKey: `rv:${userId}`, preferSourceRef: 'pack' }),
      ]);
      const balance = await getBalance(db, userId);
      expect(balance.available).toBe(0);
      expect(balance.debt).toBe(0);
    }
  });

  it('concurrent grants never repay debt below zero', async () => {
    const userId = uid();
    await grantCredits(db, { userId, amount: 10, idemKey: `g:${userId}`, source: 'test' });
    await revokeCredits(db, { userId, amount: 40, idemKey: `rv:${userId}` });
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        grantCredits(db, { userId, amount: 20, idemKey: `p:${userId}:${i}`, source: 'pack' }),
      ),
    );
    expect(await getBalance(db, userId)).toMatchObject({ available: 50, debt: 0 });
  });

  it('balance shows the nearest expiring lot', async () => {
    const userId = uid();
    const soon = Date.now() + DAY;
    await grantCredits(db, { userId, amount: 5, idemKey: `a:${userId}`, source: 'sub', expiresAt: soon });
    await grantCredits(db, {
      userId,
      amount: 7,
      idemKey: `b:${userId}`,
      source: 'sub',
      expiresAt: soon + DAY,
    });
    expect((await getBalance(db, userId)).nextExpiry).toEqual({ at: soon, amount: 5 });
  });
});
