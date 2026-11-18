import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { type Db, isConstraintError, isRetryableTransactionError, newId, type Tx } from '../db/client';
import { creditAccounts, creditAllocations, creditLedger, creditLots } from '../db/schema';

// The only write entry points for the credit ledger. Rules:
// - One idempotency key per operation; if the key exists, treat it as done and return applied=false;
// - Every write of an operation, including the caller's `extra` writes, runs in one transaction;
// - The transaction first locks the user's credit_accounts row (SELECT … FOR UPDATE), so one user's ledger operations run one at a time
//   and each reads lots and debt after the previous one committed. The idempotency check runs under the same lock.
//   CHECK constraints (remaining and debt non-negative) and the unique idempotency key are the backstop.

/** Deadlocks and serialization failures roll the whole transaction back; it is safe to run again. */
const MAX_ATTEMPTS = 3;

export class InsufficientCreditsError extends Error {
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super(`insufficient credits: required ${required}, available ${available}`);
    this.name = 'InsufficientCreditsError';
  }
}

export interface LedgerResult {
  /** false means the idempotency key already existed and nothing was written. */
  applied: boolean;
  ledgerId: string | null;
}

/** Writes that must commit together with a ledger operation (e.g. the job row a charge pays for). Runs last, in the same transaction. */
export type ExtraWrites = (tx: Tx) => Promise<unknown>;

interface ActiveLot {
  id: string;
  remaining: number;
  sourceRef: string | null;
}

/** Credit columns are Postgres integer (32-bit). */
export const MAX_CREDITS = 2_147_483_647;

function assertPositiveInt(amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_CREDITS)
    throw new Error(`credit amount must be a positive integer up to ${MAX_CREDITS}: ${amount}`);
}

function activeLotsWhere(userId: string, now: number) {
  return and(
    eq(creditLots.userId, userId),
    gt(creditLots.remaining, 0),
    or(isNull(creditLots.expiresAt), gt(creditLots.expiresAt, now)),
  );
}

async function activeLots(tx: Tx, userId: string, now: number): Promise<ActiveLot[]> {
  return (
    tx
      .select({ id: creditLots.id, remaining: creditLots.remaining, sourceRef: creditLots.sourceRef })
      .from(creditLots)
      .where(activeLotsWhere(userId, now))
      // Earliest expiry first, never-expiring last.
      .orderBy(asc(creditLots.expiresAt), asc(creditLots.createdAt))
  );
}

async function findLedger(db: Db | Tx, idemKey: string) {
  const [row] = await db.select().from(creditLedger).where(eq(creditLedger.idemKey, idemKey)).limit(1);
  return row ?? null;
}

/** Creates the user's account if missing and locks it until the transaction ends; returns the current debt. */
async function lockAccount(tx: Tx, userId: string): Promise<number> {
  await tx.insert(creditAccounts).values({ userId }).onConflictDoNothing();
  const [row] = await tx
    .select({ debt: creditAccounts.debt })
    .from(creditAccounts)
    .where(eq(creditAccounts.userId, userId))
    .for('update');
  return row!.debt;
}

async function changeDebt(tx: Tx, userId: string, debtChange: number) {
  await tx
    .update(creditAccounts)
    .set({ debt: sql`${creditAccounts.debt} + ${debtChange}`, updatedAt: Date.now() })
    .where(eq(creditAccounts.userId, userId));
}

/** Takes up to amount from lots in order and returns how much each lot gives; returns what's available if short. */
function allocate(lots: ActiveLot[], amount: number): { lotId: string; amount: number }[] {
  const plan: { lotId: string; amount: number }[] = [];
  let left = amount;
  for (const lot of lots) {
    if (left === 0) break;
    const take = Math.min(lot.remaining, left);
    plan.push({ lotId: lot.id, amount: take });
    left -= take;
  }
  return plan;
}

/**
 * Runs one ledger operation for userId: lock the account, return applied=false if idemKey is already used, else `write` (which returns
 * the new ledger ID) and then `extra`, all in one transaction. A unique violation on the idempotency key (the same key used for
 * another user, or a race the lock can't see) also means already applied.
 */
async function runIdempotent(
  db: Db,
  userId: string,
  idemKey: string,
  write: (tx: Tx, debt: number) => Promise<string>,
  extra?: ExtraWrites,
): Promise<LedgerResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const debt = await lockAccount(tx, userId);
        const existing = await findLedger(tx, idemKey);
        if (existing) return { applied: false, ledgerId: existing.id };
        const ledgerId = await write(tx, debt);
        if (extra) await extra(tx);
        return { applied: true, ledgerId };
      });
    } catch (error) {
      if (isConstraintError(error, 'UNIQUE', 'credit_ledger_idem_uq')) {
        const existing = await findLedger(db, idemKey);
        return { applied: false, ledgerId: existing?.id ?? null };
      }
      if (isRetryableTransactionError(error) && attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * attempt));
        continue;
      }
      throw error;
    }
  }
}

export interface GrantInput {
  userId: string;
  amount: number;
  idemKey: string;
  source: string;
  sourceRef?: string | null;
  /** Millisecond timestamp; null or omitted means never expires. */
  expiresAt?: number | null;
  ref?: string | null;
}

/** Grants credits. If the user has debt, it's repaid first and only the rest becomes available. */
export async function grantCredits(db: Db, input: GrantInput, extra?: ExtraWrites): Promise<LedgerResult> {
  assertPositiveInt(input.amount);
  return runIdempotent(
    db,
    input.userId,
    input.idemKey,
    async (tx, debt) => {
      const debtPay = Math.min(debt, input.amount);
      const ledgerId = newId('cl');
      await tx.insert(creditLedger).values({
        id: ledgerId,
        userId: input.userId,
        kind: 'grant',
        delta: input.amount,
        debtDelta: -debtPay,
        idemKey: input.idemKey,
        ref: input.ref ?? input.sourceRef ?? null,
      });
      await tx.insert(creditLots).values({
        id: newId('lot'),
        userId: input.userId,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        amount: input.amount,
        remaining: input.amount - debtPay,
        expiresAt: input.expiresAt ?? null,
      });
      await changeDebt(tx, input.userId, -debtPay);
      return ledgerId;
    },
    extra,
  );
}

export interface SpendInput {
  userId: string;
  amount: number;
  idemKey: string;
  ref?: string | null;
}

/**
 * Charges credits, earliest-expiring lots first. Throws InsufficientCreditsError on low balance and writes nothing.
 * A repeated key returns applied=false without checking the balance, so a retry never reports insufficient credits.
 */
export async function spendCredits(db: Db, input: SpendInput, extra?: ExtraWrites): Promise<LedgerResult> {
  assertPositiveInt(input.amount);
  return runIdempotent(
    db,
    input.userId,
    input.idemKey,
    async (tx, debt) => {
      const lots = await activeLots(tx, input.userId, Date.now());
      const total = lots.reduce((sum, lot) => sum + lot.remaining, 0);
      if (total - debt < input.amount)
        throw new InsufficientCreditsError(input.amount, Math.max(0, total - debt));
      const ledgerId = newId('cl');
      await tx.insert(creditLedger).values({
        id: ledgerId,
        userId: input.userId,
        kind: 'spend',
        delta: -input.amount,
        idemKey: input.idemKey,
        ref: input.ref ?? null,
      });
      for (const part of allocate(lots, input.amount)) {
        await tx
          .update(creditLots)
          .set({ remaining: sql`${creditLots.remaining} - ${part.amount}` })
          .where(eq(creditLots.id, part.lotId));
        await tx.insert(creditAllocations).values({ ledgerId, lotId: part.lotId, amount: part.amount });
      }
      return ledgerId;
    },
    extra,
  );
}

export interface RefundSpendInput {
  /** Idempotency key of the original charge. */
  spendIdemKey: string;
  idemKey: string;
  ref?: string | null;
}

/**
 * Refunds a charge (e.g. a failed task) back to the original lots. Returns applied=false if the charge doesn't exist.
 * If the user has debt, the refunded credits repay it first and only the remainder goes back to lots;
 * otherwise we'd leave "credits in lots + equal debt", and later grants would repay the debt, effectively giving new credits the old lots' expiry.
 */
export async function refundSpend(
  db: Db,
  input: RefundSpendInput,
  extra?: ExtraWrites,
): Promise<LedgerResult> {
  const spend = await findLedger(db, input.spendIdemKey);
  if (spend?.kind !== 'spend') return { applied: false, ledgerId: null };
  const parts = await db.select().from(creditAllocations).where(eq(creditAllocations.ledgerId, spend.id));
  return runIdempotent(
    db,
    spend.userId,
    input.idemKey,
    async (tx, debt) => {
      const debtPay = Math.min(debt, -spend.delta);
      const ledgerId = newId('cl');
      await tx.insert(creditLedger).values({
        id: ledgerId,
        userId: spend.userId,
        kind: 'refund',
        delta: -spend.delta,
        debtDelta: -debtPay,
        idemKey: input.idemKey,
        ref: input.ref ?? spend.ref,
      });
      await changeDebt(tx, spend.userId, -debtPay);
      let toDebt = debtPay;
      for (const part of parts) {
        const kept = Math.min(toDebt, part.amount);
        toDebt -= kept;
        if (part.amount - kept === 0) continue;
        await tx
          .update(creditLots)
          .set({ remaining: sql`${creditLots.remaining} + ${part.amount - kept}` })
          .where(eq(creditLots.id, part.lotId));
      }
      return ledgerId;
    },
    extra,
  );
}

export interface RevokeInput {
  userId: string;
  amount: number;
  idemKey: string;
  /** Claw back from lots of this source first (usually the lots granted by this payment). */
  preferSourceRef?: string | null;
  ref?: string | null;
}

/** Claws back credits (refunds, chargebacks). Whatever the lots can't cover becomes debt, so balance can go negative. */
export async function revokeCredits(db: Db, input: RevokeInput, extra?: ExtraWrites): Promise<LedgerResult> {
  assertPositiveInt(input.amount);
  return runIdempotent(
    db,
    input.userId,
    input.idemKey,
    async (tx) => {
      const lots = await activeLots(tx, input.userId, Date.now());
      const preferred = input.preferSourceRef
        ? lots.filter((lot) => lot.sourceRef === input.preferSourceRef)
        : [];
      const ordered = [...preferred, ...lots.filter((lot) => !preferred.includes(lot))];
      const plan = allocate(ordered, input.amount);
      const taken = plan.reduce((sum, part) => sum + part.amount, 0);
      const debtAdd = input.amount - taken;
      const ledgerId = newId('cl');
      await tx.insert(creditLedger).values({
        id: ledgerId,
        userId: input.userId,
        kind: 'revoke',
        delta: -input.amount,
        debtDelta: debtAdd,
        idemKey: input.idemKey,
        ref: input.ref ?? null,
      });
      await changeDebt(tx, input.userId, debtAdd);
      for (const part of plan) {
        await tx
          .update(creditLots)
          .set({ remaining: sql`${creditLots.remaining} - ${part.amount}` })
          .where(eq(creditLots.id, part.lotId));
        await tx.insert(creditAllocations).values({ ledgerId, lotId: part.lotId, amount: part.amount });
      }
      return ledgerId;
    },
    extra,
  );
}

export interface Balance {
  /** Available balance; may be negative (debt). */
  available: number;
  debt: number;
  /** Nearest expiry time and amount, for hints like "X credits expire on <date>". */
  nextExpiry: { at: number; amount: number } | null;
}

export async function getBalance(db: Db, userId: string, now = Date.now()): Promise<Balance> {
  const [lots, [account]] = await Promise.all([
    db
      .select({ remaining: creditLots.remaining, expiresAt: creditLots.expiresAt })
      .from(creditLots)
      .where(activeLotsWhere(userId, now)),
    db.select({ debt: creditAccounts.debt }).from(creditAccounts).where(eq(creditAccounts.userId, userId)),
  ]);
  const debt = account?.debt ?? 0;
  const total = lots.reduce((sum, lot) => sum + lot.remaining, 0);
  let nextExpiry: Balance['nextExpiry'] = null;
  for (const lot of lots) {
    if (lot.expiresAt == null) continue;
    if (!nextExpiry || lot.expiresAt < nextExpiry.at)
      nextExpiry = { at: lot.expiresAt, amount: lot.remaining };
    else if (lot.expiresAt === nextExpiry.at) nextExpiry.amount += lot.remaining;
  }
  return { available: total - debt, debt, nextExpiry };
}
