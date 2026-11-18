import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantCredits } from '../src/credits/ledger';
import type { Db } from '../src/db/client';
import { creditAccounts, creditLots, user } from '../src/db/schema';
import { adminUrl, freshDatabase } from './pg';

// node-postgres returns int8 as strings and timestamptz as Date; the schema must hand the engine numbers and Dates.

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  if (!adminUrl) return;
  ({ db, close } = await freshDatabase());
});
afterAll(async () => close?.());

describe.skipIf(!adminUrl)('column types through node-postgres', () => {
  it('millisecond bigint columns read back as numbers, auth times as Dates', async () => {
    const userId = crypto.randomUUID();
    const expiresAt = Date.now() + 86_400_000;
    await grantCredits(db, { userId, amount: 3, idemKey: `g:${userId}`, source: 'test', expiresAt });
    const [lot] = await db.select().from(creditLots).where(eq(creditLots.userId, userId));
    expect(lot!.expiresAt).toBe(expiresAt);
    expect(typeof lot!.createdAt).toBe('number');
    const [account] = await db.select().from(creditAccounts).where(eq(creditAccounts.userId, userId));
    expect(typeof account!.updatedAt).toBe('number');
    await db.insert(user).values({ id: userId, name: 'n', email: `${userId}@example.com` });
    const [row] = await db.select().from(user).where(eq(user.id, userId));
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.emailVerified).toBe(false);
  });
});
