import { and, eq, ne, type SQLWrapper, sql } from 'drizzle-orm';
import { grantCredits, revokeCredits } from '../credits/ledger';
import { type Db, newId } from '../db/client';
import { creditLots, orders, payments, subscriptions } from '../db/schema';
import { findProduct, type SiteConfig } from '../site';
import type { CheckoutFact, PaymentFact, PaymentProvider, SubscriptionFact, WebhookTarget } from './provider';

// Applies the provider's current state locally. Every function is safe to call repeatedly:
// the same state always yields the same result; when state changes (refund, chargeback, renewal), the result converges.

const DAY = 86_400_000;

export type ReconcileOutcome = 'applied' | 'ignored' | 'unmapped';

export interface ReconcileContext {
  db: Db;
  site: SiteConfig;
  provider: PaymentProvider;
  log?: (message: string, details: Record<string, unknown>) => void;
}

function creditsFor(site: SiteConfig, fact: PaymentFact) {
  const product = fact.productId ? findProduct(site, fact.productId) : undefined;
  if (!product) return null;
  // Untrusted metadata (PayPal custom_id) could be attached to any payment, so it must pay at least the list price in the list currency.
  // Trusted metadata skips this: Stripe promotion codes legitimately charge less.
  if (
    !fact.metadataTrusted &&
    (fact.currency !== product.price.currency.toLowerCase() || fact.amount < product.price.amount)
  ) {
    return null;
  }
  if (product.kind === 'credits') {
    const expiresAt =
      product.expiresDays == null ? null : (fact.paidAt ?? Date.now()) + product.expiresDays * DAY;
    return { amount: product.credits, expiresAt, source: 'pack' };
  }
  // Subscription credits expire at period end; if the period is unknown, estimate one billing period, erring on the side of giving more.
  const fallbackDays = product.interval === 'year' ? 366 : 31;
  const expiresAt = fact.periodEnd ?? (fact.paidAt ?? Date.now()) + fallbackDays * DAY;
  return { amount: product.creditsPerPeriod, expiresAt, source: 'subscription' };
}

/** Credits to claw back for this payment, based on refund ratio or dispute status. */
export function targetRevoked(
  state: Pick<PaymentFact, 'amount' | 'amountRefunded' | 'dispute'>,
  granted: number,
): number {
  if (granted <= 0) return 0;
  if (state.dispute === 'open' || state.dispute === 'lost') return granted;
  if (state.amount <= 0 || state.amountRefunded <= 0) return 0;
  const ratio = Math.min(1, state.amountRefunded / state.amount);
  return Math.min(granted, Math.floor(granted * ratio));
}

const MAX_ADJUST_ATTEMPTS = 8;

/** Dispute status order: none < open < won/lost. */
function disputeRank(column: SQLWrapper) {
  return sql`(case ${column} when 'won' then 2 when 'lost' then 2 when 'open' then 1 else 0 end)`;
}

export async function applyPayment(ctx: ReconcileContext, fact: PaymentFact): Promise<ReconcileOutcome> {
  if (!fact.paid) return 'ignored';
  const where = and(eq(payments.provider, fact.provider), eq(payments.paymentRef, fact.paymentRef));
  const known = await ctx.db.query.payments.findFirst({ where });
  // Once a product is removed (or a PayPal plan replaced, so the fact maps to no product), new payments can't be granted,
  // but already-stored payments must still be clawed back on refund or chargeback: fall back to the stored owner and product.
  const userId = fact.userId ?? known?.userId;
  const productId = fact.productId ?? known?.productId;
  if (!userId || !productId) {
    ctx.log?.('payment without our metadata', { paymentRef: fact.paymentRef });
    return 'unmapped';
  }
  const mapped = { ...fact, userId, productId };
  const credits = creditsFor(ctx.site, fact);
  if (!credits && !known) {
    ctx.log?.('payment for unknown product or below list price', {
      paymentRef: fact.paymentRef,
      productId: fact.productId,
    });
    return 'unmapped';
  }
  const paymentId = await upsertPayment(ctx.db, mapped);
  if (credits) await grantForPayment(ctx.db, mapped, paymentId, credits);
  await convergeRevoked(ctx.db, paymentId, fact.paymentRef);
  return 'applied';
}

type MappedPayment = PaymentFact & { userId: string; productId: string };

/**
 * 1. Payment record: inserted once; afterwards refund amount and dispute status merge monotonically (refunds only grow, disputes only move
 *    none → open → won or lost), so a stale snapshot from a late concurrent webhook can't roll state back. Returns the row ID.
 */
async function upsertPayment(db: Db, fact: MappedPayment): Promise<string> {
  await db
    .insert(payments)
    .values({
      id: newId('pay'),
      provider: fact.provider,
      paymentRef: fact.paymentRef,
      chargeRef: fact.chargeRef,
      userId: fact.userId,
      orderId: fact.orderId,
      subscriptionRef: fact.subscriptionRef,
      productId: fact.productId,
      amount: fact.amount,
      currency: fact.currency,
      amountRefunded: fact.amountRefunded,
      disputeStatus: fact.dispute,
      periodStart: fact.periodStart,
      periodEnd: fact.periodEnd,
      fetchedAt: fact.fetchedAt,
    })
    .onConflictDoUpdate({
      target: [payments.provider, payments.paymentRef],
      set: {
        chargeRef: sql`coalesce(excluded.charge_ref, ${payments.chargeRef})`,
        amountRefunded: sql`max(excluded.amount_refunded, ${payments.amountRefunded})`,
        disputeStatus: sql`case when ${disputeRank(sql`excluded.dispute_status`)} >= ${disputeRank(payments.disputeStatus)} then excluded.dispute_status else ${payments.disputeStatus} end`,
        fetchedAt: sql`max(excluded.fetched_at, ${payments.fetchedAt})`,
        updatedAt: Date.now(),
      },
    });
  const row = await db.query.payments.findFirst({
    columns: { id: true },
    where: and(eq(payments.provider, fact.provider), eq(payments.paymentRef, fact.paymentRef)),
  });
  if (!row) throw new Error(`payment row missing after upsert: ${fact.paymentRef}`);
  return row.id;
}

/**
 * 2. Grant: the idempotency key is tied to this payment, not order status, so retrying after a failed grant always fills it in.
 *    The order is marked paid only when it belongs to the same user and product: orderId may come from untrusted metadata (PayPal custom_id).
 */
async function grantForPayment(
  db: Db,
  fact: MappedPayment,
  paymentId: string,
  credits: NonNullable<ReturnType<typeof creditsFor>>,
) {
  const markOrderPaid = fact.orderId
    ? [
        db
          .update(orders)
          .set({ status: 'paid', paidAt: fact.paidAt ?? Date.now() })
          .where(
            and(
              eq(orders.id, fact.orderId),
              eq(orders.userId, fact.userId),
              eq(orders.productId, fact.productId),
              eq(orders.status, 'pending'),
            ),
          ),
      ]
    : [];
  await grantCredits(
    db,
    {
      userId: fact.userId,
      amount: credits.amount,
      idemKey: `pay:${fact.provider}:${fact.paymentRef}`,
      source: credits.source,
      sourceRef: paymentId,
      expiresAt: credits.expiresAt,
    },
    [
      db.update(payments).set({ creditsGranted: credits.amount }).where(eq(payments.id, paymentId)),
      ...markOrderPaid,
    ],
  );
}

/**
 * 3. Refunds, chargebacks: move clawed-back credits to the target. The target comes from the merged state in the database, not this fact;
 *    each adjustment takes a sequence number. Whether it succeeds or loses to a concurrent request, re-read and recompute until target equals clawed-back,
 *    so even if the first concurrent request to return saw an intermediate state, the later one converges the result to the latest target.
 */
async function convergeRevoked(db: Db, paymentId: string, paymentRef: string) {
  for (let attempt = 1; attempt <= MAX_ADJUST_ATTEMPTS; attempt++) {
    const current = await db.query.payments.findFirst({ where: eq(payments.id, paymentId) });
    if (!current) return;
    const target = targetRevoked(
      { amount: current.amount, amountRefunded: current.amountRefunded, dispute: current.disputeStatus },
      current.creditsGranted,
    );
    if (target === current.creditsRevoked) return;
    const nextSeq = current.adjustSeq + 1;
    const idemKey = `adj:${current.id}:${nextSeq}`;
    const bump = db
      .update(payments)
      .set({ creditsRevoked: target, adjustSeq: nextSeq, updatedAt: Date.now() })
      .where(and(eq(payments.id, current.id), eq(payments.adjustSeq, current.adjustSeq)));
    // Applied or lost to a concurrent request, loop again: the re-read at the top returns once converged.
    if (target > current.creditsRevoked) {
      await revokeCredits(
        db,
        {
          userId: current.userId,
          amount: target - current.creditsRevoked,
          idemKey,
          preferSourceRef: current.id,
          ref: current.id,
        },
        [bump],
      );
    } else {
      // Dispute won or refund reversed: return over-clawed credits, with the same expiry as the lot this payment originally granted.
      await grantCredits(
        db,
        {
          userId: current.userId,
          amount: current.creditsRevoked - target,
          idemKey,
          source: 'restore',
          sourceRef: current.id,
          expiresAt: await originalExpiry(db, current.id),
        },
        [bump],
      );
    }
  }
  throw new Error(`payment adjustment did not converge: ${paymentRef}`);
}

async function originalExpiry(db: Db, paymentId: string): Promise<number | null> {
  const [lot] = await db
    .select({ expiresAt: creditLots.expiresAt })
    .from(creditLots)
    .where(and(eq(creditLots.sourceRef, paymentId), ne(creditLots.source, 'restore')))
    .limit(1);
  return lot?.expiresAt ?? null;
}

export async function applySubscription(
  ctx: ReconcileContext,
  fact: SubscriptionFact,
): Promise<ReconcileOutcome> {
  if (!fact.userId || !fact.productId) {
    ctx.log?.('subscription without our metadata', { subscriptionRef: fact.subscriptionRef });
    return 'unmapped';
  }
  await ctx.db
    .insert(subscriptions)
    .values({
      id: newId('sub'),
      provider: fact.provider,
      subscriptionRef: fact.subscriptionRef,
      userId: fact.userId,
      productId: fact.productId,
      status: fact.status,
      currentPeriodStart: fact.currentPeriodStart,
      currentPeriodEnd: fact.currentPeriodEnd,
      cancelAtPeriodEnd: fact.cancelAtPeriodEnd,
      fetchedAt: fact.fetchedAt,
    })
    .onConflictDoUpdate({
      target: [subscriptions.provider, subscriptions.subscriptionRef],
      set: {
        status: sql`excluded.status`,
        currentPeriodStart: sql`excluded.current_period_start`,
        currentPeriodEnd: sql`excluded.current_period_end`,
        cancelAtPeriodEnd: sql`excluded.cancel_at_period_end`,
        fetchedAt: sql`excluded.fetched_at`,
      },
      setWhere: sql`excluded.fetched_at >= ${subscriptions.fetchedAt}`,
    });
  return 'applied';
}

export async function applyCheckout(ctx: ReconcileContext, fact: CheckoutFact): Promise<ReconcileOutcome> {
  let outcome: ReconcileOutcome = 'ignored';
  if (fact.subscription) outcome = await applySubscription(ctx, fact.subscription);
  if (fact.payment) outcome = await applyPayment(ctx, fact.payment);
  return outcome;
}

/** Fetches the latest state of the object a webhook points to and stores it. */
export async function reconcileTarget(
  ctx: ReconcileContext,
  target: WebhookTarget,
): Promise<ReconcileOutcome> {
  const { provider, db } = ctx;
  switch (target.kind) {
    case 'checkout':
      return applyCheckout(ctx, await provider.fetchCheckout(target.ref));
    case 'payment': {
      const fact = await provider.fetchPayment(target.ref);
      return fact ? applyPayment(ctx, fact) : 'ignored';
    }
    case 'charge': {
      const known = await db.query.payments.findFirst({
        where: and(eq(payments.provider, provider.name), eq(payments.chargeRef, target.ref)),
      });
      const fact = known
        ? await provider.fetchPayment(known.paymentRef)
        : await provider.fetchPaymentByCharge(target.ref);
      return fact ? applyPayment(ctx, fact) : 'ignored';
    }
    case 'subscription': {
      const fact = await provider.fetchSubscription(target.ref);
      return fact ? applySubscription(ctx, fact) : 'ignored';
    }
  }
}
