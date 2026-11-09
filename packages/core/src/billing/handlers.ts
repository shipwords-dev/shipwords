import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { type Db, isConstraintError, newId } from '../db/client';
import { billingCustomers, orders, payments, subscriptions, webhookEvents } from '../db/schema';
import { errorResponse, json, readJson, safeRelativePath } from '../http';
import { findProduct, type SiteConfig } from '../site';
import { type PaymentProvider, WebhookSignatureError } from './provider';
import { applyCheckout, type ReconcileContext, reconcileTarget } from './reconcile';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface BillingDeps {
  db: Db;
  site: SiteConfig;
  provider: PaymentProvider;
  baseURL: string;
  getUser: (request: Request) => Promise<SessionUser | null>;
  log: (message: string, details: Record<string, unknown>) => void;
}

const reconcileCtx = (deps: BillingDeps): ReconcileContext => ({
  db: deps.db,
  site: deps.site,
  provider: deps.provider,
  log: deps.log,
});

const safeReturnPath = safeRelativePath;

async function ensureCustomer(deps: BillingDeps, user: SessionUser): Promise<string> {
  const where = and(eq(billingCustomers.userId, user.id), eq(billingCustomers.provider, deps.provider.name));
  const existing = await deps.db.query.billingCustomers.findFirst({ where });
  if (existing) return existing.customerRef;
  const customerRef = await deps.provider.createCustomer({ ...user, siteId: deps.site.id });
  try {
    await deps.db
      .insert(billingCustomers)
      .values({ userId: user.id, provider: deps.provider.name, customerRef });
  } catch (error) {
    if (!isConstraintError(error, 'UNIQUE')) throw error;
  }
  const row = await deps.db.query.billingCustomers.findFirst({ where });
  return row?.customerRef ?? customerRef;
}

/** POST { productId, returnPath? } → { url }: creates an order and redirects to the provider's checkout. */
export async function handleCheckout(deps: BillingDeps, request: Request): Promise<Response> {
  const user = await deps.getUser(request);
  if (!user) return errorResponse(401, 'unauthorized');
  const body = await readJson<{ productId?: string; returnPath?: string }>(request);
  // Price and credits come only from the server-side catalog; never trust any amount in the request.
  const product = body?.productId ? findProduct(deps.site, body.productId) : undefined;
  if (!product) return errorResponse(400, 'unknown_product');

  const customerRef = await ensureCustomer(deps, user);
  const orderId = newId('ord');
  await deps.db.insert(orders).values({
    id: orderId,
    userId: user.id,
    productId: product.id,
    provider: deps.provider.name,
    amount: product.price.amount,
    currency: product.price.currency,
  });
  const returnPath = safeReturnPath(body?.returnPath, '/account');
  const successUrl = `${deps.baseURL}/billing/return?order=${orderId}&next=${encodeURIComponent(returnPath)}`;
  const cancelUrl = `${deps.baseURL}${returnPath === '/account' ? '/pricing' : returnPath}`;
  const checkout = await deps.provider.createCheckout({
    orderId,
    siteId: deps.site.id,
    product,
    userId: user.id,
    customerRef,
    successUrl,
    cancelUrl,
  });
  await deps.db.update(orders).set({ checkoutRef: checkout.checkoutRef }).where(eq(orders.id, orderId));
  return json({ url: checkout.url, orderId });
}

/** POST { orderId } → { status }: the return page pulls provider state once instead of waiting for the webhook. */
export async function handleSyncOrder(deps: BillingDeps, request: Request): Promise<Response> {
  const user = await deps.getUser(request);
  if (!user) return errorResponse(401, 'unauthorized');
  const body = await readJson<{ orderId?: string }>(request);
  const order = body?.orderId
    ? await deps.db.query.orders.findFirst({
        where: and(eq(orders.id, body.orderId), eq(orders.userId, user.id)),
      })
    : undefined;
  if (!order) return errorResponse(404, 'order_not_found');
  if (order.status === 'pending' && order.checkoutRef) {
    await applyCheckout(reconcileCtx(deps), await deps.provider.fetchCheckout(order.checkoutRef));
  }
  const fresh = await deps.db.query.orders.findFirst({ where: eq(orders.id, order.id) });
  return json({ orderId: order.id, status: fresh?.status ?? order.status, productId: order.productId });
}

/** POST /api/webhooks/<provider>: verify → dedupe → fetch latest state and store → 200. Returns 500 on failure so the provider retries. */
export async function handleWebhook(deps: BillingDeps, request: Request): Promise<Response> {
  let trigger: Awaited<ReturnType<PaymentProvider['parseWebhook']>>;
  try {
    trigger = await deps.provider.parseWebhook(request);
  } catch (error) {
    if (error instanceof WebhookSignatureError) return errorResponse(400, 'invalid_signature');
    throw error;
  }
  if (!trigger.target) return json({ received: true, ignored: true });

  const done = await deps.db.query.webhookEvents.findFirst({
    where: and(eq(webhookEvents.provider, deps.provider.name), eq(webhookEvents.eventId, trigger.eventId)),
  });
  if (done) return json({ received: true, duplicate: true });

  try {
    const outcome = await reconcileTarget(reconcileCtx(deps), trigger.target);
    await deps.db
      .insert(webhookEvents)
      .values({
        provider: deps.provider.name,
        eventId: trigger.eventId,
        type: trigger.type,
        processedAt: Date.now(),
      })
      .onConflictDoNothing();
    return json({ received: true, outcome });
  } catch (error) {
    deps.log('webhook processing failed', {
      eventId: trigger.eventId,
      type: trigger.type,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(500, 'webhook_failed');
  }
}

/** POST { returnPath? } → { url }: redirects to the provider's billing management page (cancel subscription, update card, invoices). */
export async function handlePortal(deps: BillingDeps, request: Request): Promise<Response> {
  const user = await deps.getUser(request);
  if (!user) return errorResponse(401, 'unauthorized');
  const customer = await deps.db.query.billingCustomers.findFirst({
    where: and(eq(billingCustomers.userId, user.id), eq(billingCustomers.provider, deps.provider.name)),
  });
  if (!customer) return errorResponse(404, 'no_billing_account');
  const body = await readJson<{ returnPath?: string }>(request);
  const url = await deps.provider.portalUrl(
    customer.customerRef,
    `${deps.baseURL}${safeReturnPath(body?.returnPath, '/account')}`,
  );
  return json({ url });
}

/** GET ?order=<order ID> → 302 to this payment's receipt page at the provider. Only for the user's own paid orders. */
export async function handleReceipt(deps: BillingDeps, request: Request): Promise<Response> {
  const user = await deps.getUser(request);
  if (!user) return errorResponse(401, 'unauthorized');
  const orderId = new URL(request.url).searchParams.get('order');
  const receiptUrl = deps.provider.receiptUrl?.bind(deps.provider);
  // Subscription orders have multiple payments; the receipt is for the first period.
  const payment =
    orderId && receiptUrl
      ? await deps.db.query.payments.findFirst({
          where: and(
            eq(payments.orderId, orderId),
            eq(payments.userId, user.id),
            eq(payments.provider, deps.provider.name),
          ),
          orderBy: asc(payments.createdAt),
        })
      : undefined;
  const url = payment && receiptUrl ? await receiptUrl(payment.paymentRef) : null;
  if (!url?.startsWith('https://')) return errorResponse(404, 'receipt_not_found');
  return Response.redirect(url, 302);
}

const LIVE_STATUSES = ['active', 'trialing', 'past_due'];

/** The currently active subscription, or null. During past_due the provider is still retrying the charge, so it counts as active. */
export async function activeSubscription(db: Db, userId: string, now = Date.now()) {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, LIVE_STATUSES)))
    .orderBy(desc(subscriptions.currentPeriodEnd));
  return rows.find((row) => (row.currentPeriodEnd ?? 0) > now) ?? null;
}

/**
 * Recent paid orders with the first period's paid amount, refunded amount and dispute status (matching the receipt; subscriptions use the first period only).
 * Abandoned checkouts stay pending and are neither listed nor counted.
 */
export async function recentOrders(db: Db, userId: string, limit = 20) {
  const rows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.userId, userId), eq(orders.status, 'paid')))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
  const ids = rows.map((row) => row.id);
  const paid = ids.length
    ? await db
        .select({
          orderId: payments.orderId,
          amount: payments.amount,
          amountRefunded: payments.amountRefunded,
          disputeStatus: payments.disputeStatus,
        })
        .from(payments)
        .where(and(eq(payments.userId, userId), inArray(payments.orderId, ids)))
        .orderBy(desc(payments.createdAt))
    : [];
  // Written in descending creation order, so the last one kept per order is the first period.
  const first = new Map(paid.map((p) => [p.orderId, p]));
  return rows.map((row) => ({
    ...row,
    // With a promo code, the paid amount is below list price; use the paid amount to decide full refunds.
    amountPaid: first.get(row.id)?.amount ?? row.amount,
    amountRefunded: first.get(row.id)?.amountRefunded ?? 0,
    dispute: first.get(row.id)?.disputeStatus ?? null,
  }));
}
