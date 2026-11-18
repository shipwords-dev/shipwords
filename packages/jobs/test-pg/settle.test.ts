import { getBalance, grantCredits, spendCredits } from '@shipwords/core/credits/ledger';
import type { Db } from '@shipwords/core/db/client';
import { quotaCounters } from '@shipwords/core/db/schema';
import { consumeQuota } from '@shipwords/core/quota/counters';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadJob, markFailed, spendKey } from '../src/lifecycle';
import { jobs } from '../src/schema';
import { adminUrl, freshDatabase } from './pg';

// Settlement raced against itself on separate connections: the refund and the guest quota return happen once.

const N = 30;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  if (!adminUrl) return;
  ({ db, close } = await freshDatabase());
});
afterAll(async () => close?.());

const base = { modelId: 'm', kind: 'image' as const, prompt: 'p', inputJson: '{}', upstream: 'yir' };

describe.skipIf(!adminUrl)('job settlement under real concurrency', () => {
  it('failing a paid job from many places refunds once', async () => {
    const userId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    await grantCredits(db, { userId, amount: 10, idemKey: `g:${userId}`, source: 'test' });
    await spendCredits(db, { userId, amount: 4, idemKey: spendKey(jobId) }, (tx) =>
      tx.insert(jobs).values({ id: jobId, userId, costCredits: 4, ...base }),
    );
    await Promise.all(Array.from({ length: N }, () => markFailed(db, jobId, 'failed', 'x', 'boom')));
    expect((await getBalance(db, userId)).available).toBe(10);
    expect((await loadJob(db, jobId))?.status).toBe('failed');
  });

  it('failing a guest job from many places returns its quota once', async () => {
    const window = 'w';
    const rules = [{ key: `guest:${crypto.randomUUID()}`, window, limit: 10 }];
    for (let i = 0; i < 3; i++) expect(await consumeQuota(db, rules)).toBe(true);
    const jobId = crypto.randomUUID();
    await db.insert(jobs).values({ id: jobId, guestId: 'g', quotaJson: JSON.stringify(rules), ...base });
    await Promise.all(Array.from({ length: N }, () => markFailed(db, jobId, 'failed', 'x', 'boom')));
    const [counter] = await db
      .select()
      .from(quotaCounters)
      .where(and(eq(quotaCounters.key, rules[0]!.key), eq(quotaCounters.window, window)));
    expect(counter!.count).toBe(2);
    expect((await loadJob(db, jobId))?.quotaReleased).toBe(true);
  });
});
