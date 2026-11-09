import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type BillingDeps,
  handleCheckout,
  handleReceipt,
  handleSyncOrder,
  handleWebhook,
  recentOrders,
} from '../src/billing/handlers';
import type {
  CheckoutFact,
  CheckoutRequest,
  PaymentFact,
  PaymentProvider,
  SubscriptionFact,
  WebhookTrigger,
} from '../src/billing/provider';
import { WebhookSignatureError } from '../src/billing/provider';
import { applyPayment, applySubscription, targetRevoked } from '../src/billing/reconcile';
import { mapDispute } from '../src/billing/stripe';
import { getBalance, spendCredits } from '../src/credits/ledger';
import { createDb } from '../src/db/client';
import { orders, payments, subscriptions } from '../src/db/schema';
import { defineSite } from '../src/site';

const db = createDb(env.DB);
const DAY = 86_400_000;

const site = defineSite({
  id: 'test',
  name: 'Test',
  url: 'https://test.example',
  locales: ['en'],
  defaultLocale: 'en',
  products: [
    {
      id: 'pack_100',
      kind: 'credits',
      name: '100 credits',
      price: { amount: 1000, currency: 'usd' },
      credits: 100,
      expiresDays: null,
    },
    {
      id: 'pro_month',
      kind: 'subscription',
      name: 'Pro',
      price: { amount: 2000, currency: 'usd' },
      interval: 'month',
      creditsPerPeriod: 300,
    },
  ],
  signup: { bonusCredits: 0, bonusExpiresDays: null, bonusPerIpDaily: 3, bonusSiteDaily: 100 },
  guest: { dailyPerDevice: 1, dailyPerIp: 3, dailySiteBudget: 100, minRecaptchaScore: 0.5 },
  billing: { provider: 'stripe', automaticTax: false },
});

/** In-memory fake provider: tests mutate payments / subscriptions directly, then send the matching webhook. */
class FakeProvider implements PaymentProvider {
  readonly name = 'fake';
  payments = new Map<string, PaymentFact>();
  subscriptions = new Map<string, SubscriptionFact>();
  checkouts = new Map<string, CheckoutFact>();
  created: CheckoutRequest[] = [];
  failNextFetch = false;

  async createCustomer(user: { id: string }) {
    return `cus_${user.id}`;
  }
  async createCheckout(request: CheckoutRequest) {
    this.created.push(request);
    return { url: `https://pay.example/${request.orderId}`, checkoutRef: `cs_${request.orderId}` };
  }
  async parseWebhook(request: Request): Promise<WebhookTrigger> {
    if (request.headers.get('x-sig') !== 'ok') throw new WebhookSignatureError();
    return (await request.json()) as WebhookTrigger;
  }
  async fetchCheckout(ref: string) {
    return this.checkouts.get(ref) ?? { orderId: null, payment: null, subscription: null };
  }
  async fetchPayment(ref: string) {
    if (this.failNextFetch) {
      this.failNextFetch = false;
      throw new Error('provider down');
    }
    return this.payments.get(ref) ?? null;
  }
  async fetchPaymentByCharge(ref: string) {
    return [...this.payments.values()].find((p) => p.chargeRef === ref) ?? null;
  }
  async fetchSubscription(ref: string) {
    return this.subscriptions.get(ref) ?? null;
  }
  async portalUrl() {
    return 'https://pay.example/portal';
  }
  async receiptUrl(ref: string) {
    return this.payments.has(ref) ? `https://pay.example/receipts/${ref}` : null;
  }
}

let provider: FakeProvider;
let currentUser: { id: string; email: string; name: string } | null;
let deps: BillingDeps;
const logs: string[] = [];

beforeEach(() => {
  provider = new FakeProvider();
  currentUser = null;
  deps = {
    db,
    site,
    provider,
    baseURL: 'https://test.example',
    getUser: async () => currentUser,
    log: (message) => logs.push(message),
  };
});

const ctx = () => ({ db, site, provider, log: deps.log });
const uid = () => `u_${crypto.randomUUID().slice(0, 12)}`;
let clock = Date.now();

function packPayment(userId: string, ref: string, overrides: Partial<PaymentFact> = {}): PaymentFact {
  return {
    provider: 'fake',
    paymentRef: ref,
    chargeRef: `ch_${ref}`,
    paid: true,
    amount: 1000,
    currency: 'usd',
    amountRefunded: 0,
    dispute: null,
    metadataTrusted: true,
    userId,
    productId: 'pack_100',
    orderId: null,
    subscriptionRef: null,
    periodStart: null,
    periodEnd: null,
    paidAt: Date.now(),
    fetchedAt: ++clock,
    ...overrides,
  };
}

function webhook(trigger: WebhookTrigger, sig = 'ok') {
  return new Request('https://test.example/api/webhooks/fake', {
    method: 'POST',
    headers: { 'x-sig': sig },
    body: JSON.stringify(trigger),
  });
}

describe('refund clawback ratio', () => {
  it('rounds down proportionally; chargebacks are full', () => {
    const fact = packPayment('u', 'p', { amountRefunded: 333 });
    expect(targetRevoked(fact, 100)).toBe(33);
    expect(targetRevoked({ ...fact, amountRefunded: 5000 }, 100)).toBe(100);
    expect(targetRevoked({ ...fact, dispute: 'open' }, 100)).toBe(100);
    expect(targetRevoked({ ...fact, dispute: 'won', amountRefunded: 0 }, 100)).toBe(0);
  });
});

describe('storing payments', () => {
  it('credit packs grant once; duplicate events or different events for the same payment never over-grant', async () => {
    const userId = uid();
    provider.payments.set('pi_1', packPayment(userId, 'pi_1'));
    const first = await handleWebhook(
      deps,
      webhook({ eventId: 'evt_1', type: 't', target: { kind: 'payment', ref: 'pi_1' } }),
    );
    await handleWebhook(
      deps,
      webhook({ eventId: 'evt_1', type: 't', target: { kind: 'payment', ref: 'pi_1' } }),
    );
    await handleWebhook(
      deps,
      webhook({ eventId: 'evt_2', type: 't', target: { kind: 'charge', ref: 'ch_pi_1' } }),
    );
    expect(first.status).toBe(200);
    expect((await getBalance(db, userId)).available).toBe(100);
  });

  it('partial refund claws back proportionally, then a full refund claws back the rest; reprocessing changes nothing', async () => {
    const userId = uid();
    await applyPayment(ctx(), packPayment(userId, 'pi_r'));
    await applyPayment(ctx(), packPayment(userId, 'pi_r', { amountRefunded: 500 }));
    expect((await getBalance(db, userId)).available).toBe(50);
    await applyPayment(ctx(), packPayment(userId, 'pi_r', { amountRefunded: 1000 }));
    await applyPayment(ctx(), packPayment(userId, 'pi_r', { amountRefunded: 1000 }));
    expect((await getBalance(db, userId)).available).toBe(0);
    const row = await db.query.payments.findFirst({ where: eq(payments.paymentRef, 'pi_r') });
    expect(row).toMatchObject({ creditsGranted: 100, creditsRevoked: 100, amountRefunded: 1000 });
  });

  it('a refund after the user spent all credits records the difference as debt', async () => {
    const userId = uid();
    await applyPayment(ctx(), packPayment(userId, 'pi_d'));
    await spendCredits(db, { userId, amount: 90, idemKey: `job:${userId}` });
    await applyPayment(ctx(), packPayment(userId, 'pi_d', { amountRefunded: 1000 }));
    expect(await getBalance(db, userId)).toMatchObject({ available: -90, debt: 90 });
  });

  it('a chargeback claws back in full, then returns credits on a win', async () => {
    const userId = uid();
    await applyPayment(ctx(), packPayment(userId, 'pi_x'));
    await applyPayment(ctx(), packPayment(userId, 'pi_x', { dispute: 'open' }));
    expect((await getBalance(db, userId)).available).toBe(0);
    await applyPayment(ctx(), packPayment(userId, 'pi_x', { dispute: 'won' }));
    await applyPayment(ctx(), packPayment(userId, 'pi_x', { dispute: 'won' }));
    expect((await getBalance(db, userId)).available).toBe(100);
  });

  it('replies 200 and logs without granting when our metadata is missing or the product does not exist', async () => {
    const userId = uid();
    provider.payments.set('pi_m', packPayment(userId, 'pi_m', { productId: 'gone' }));
    const response = await handleWebhook(
      deps,
      webhook({ eventId: 'evt_m', type: 't', target: { kind: 'payment', ref: 'pi_m' } }),
    );
    expect(await response.json()).toMatchObject({ outcome: 'unmapped' });
    expect((await getBalance(db, userId)).available).toBe(0);
  });

  it('untrusted metadata (PayPal custom_id) grants only when the payment covers the list price in the list currency', async () => {
    const userId = uid();
    const untrusted = { metadataTrusted: false };
    expect(await applyPayment(ctx(), packPayment(userId, 'pp_low', { ...untrusted, amount: 1 }))).toBe(
      'unmapped',
    );
    expect(await applyPayment(ctx(), packPayment(userId, 'pp_eur', { ...untrusted, currency: 'eur' }))).toBe(
      'unmapped',
    );
    expect(
      await applyPayment(
        ctx(),
        packPayment(userId, 'pp_sub', {
          ...untrusted,
          productId: 'pro_month',
          amount: 1000,
          subscriptionRef: 'I-1',
        }),
      ),
    ).toBe('unmapped');
    expect((await getBalance(db, userId)).available).toBe(0);
    expect(await applyPayment(ctx(), packPayment(userId, 'pp_ok', untrusted))).toBe('applied');
    expect((await getBalance(db, userId)).available).toBe(100);
  });

  it('trusted metadata (Stripe) still grants a discounted payment from a promotion code', async () => {
    const userId = uid();
    expect(await applyPayment(ctx(), packPayment(userId, 'pi_promo', { amount: 500 }))).toBe('applied');
    expect((await getBalance(db, userId)).available).toBe(100);
  });

  it('unpaid states are not stored', async () => {
    const userId = uid();
    expect(await applyPayment(ctx(), packPayment(userId, 'pi_u', { paid: false }))).toBe('ignored');
    expect(await db.query.payments.findFirst({ where: eq(payments.paymentRef, 'pi_u') })).toBeUndefined();
  });

  it("a payment marks its order paid only when the order is the same user's and product's", async () => {
    const [owner, other] = [uid(), uid()];
    const orderId = `ord_${crypto.randomUUID().slice(0, 12)}`;
    await db.insert(orders).values({
      id: orderId,
      userId: owner,
      productId: 'pack_100',
      provider: 'fake',
      amount: 1000,
      currency: 'usd',
    });
    const status = async () => (await db.query.orders.findFirst({ where: eq(orders.id, orderId) }))?.status;
    // Untrusted metadata naming someone else's order: the payer still gets credits, the order stays pending.
    await applyPayment(ctx(), packPayment(other, 'pp_steal', { metadataTrusted: false, orderId }));
    expect((await getBalance(db, other)).available).toBe(100);
    expect(await status()).toBe('pending');
    await applyPayment(
      ctx(),
      packPayment(owner, 'pp_own', { orderId, productId: 'pro_month', amount: 2000 }),
    );
    expect(await status()).toBe('pending');
    await applyPayment(ctx(), packPayment(owner, 'pp_paid', { orderId }));
    expect(await status()).toBe('paid');
  });
});

describe('regressions found in review', () => {
  it('a late stale snapshot does not re-grant clawed-back credits, even with a later fetch time', async () => {
    const userId = uid();
    await applyPayment(ctx(), packPayment(userId, 'pi_old'));
    await applyPayment(ctx(), packPayment(userId, 'pi_old', { amountRefunded: 1000, fetchedAt: 200 }));
    expect((await getBalance(db, userId)).available).toBe(0);
    // The request sent first but returned last carries old data with a larger timestamp.
    await applyPayment(
      ctx(),
      packPayment(userId, 'pi_old', { amountRefunded: 0, fetchedAt: Date.now() * 2 }),
    );
    expect((await getBalance(db, userId)).available).toBe(0);
    await applyPayment(ctx(), packPayment(userId, 'pi_old', { dispute: 'open' }));
    await applyPayment(ctx(), packPayment(userId, 'pi_old', { dispute: null }));
    const row = await db.query.payments.findFirst({ where: eq(payments.paymentRef, 'pi_old') });
    expect(row).toMatchObject({ amountRefunded: 1000, disputeStatus: 'open', creditsRevoked: 100 });
  });

  it('concurrent adjustments have converged to the latest state by the time each returns', async () => {
    const userId = uid();
    await applyPayment(ctx(), packPayment(userId, 'pi_c'));
    await applyPayment(ctx(), packPayment(userId, 'pi_c', { dispute: 'open' }));
    await Promise.all([
      applyPayment(ctx(), packPayment(userId, 'pi_c', { dispute: 'won' })),
      applyPayment(ctx(), packPayment(userId, 'pi_c', { dispute: 'won', amountRefunded: 1000 })),
      applyPayment(ctx(), packPayment(userId, 'pi_c', { amountRefunded: 500 })),
    ]);
    const row = await db.query.payments.findFirst({ where: eq(payments.paymentRef, 'pi_c') });
    expect(row).toMatchObject({ disputeStatus: 'won', amountRefunded: 1000, creditsRevoked: 100 });
    expect((await getBalance(db, userId)).available).toBe(0);
  });

  it('Stripe closed early warning returns credits clawed back for it (mapping + merge + adjustment end to end)', async () => {
    const userId = uid();
    const d = (status: string, created: number) => ({ status, created }) as Stripe.Dispute;
    await applyPayment(ctx(), packPayment(userId, 'pi_warn'));
    await applyPayment(
      ctx(),
      packPayment(userId, 'pi_warn', { dispute: mapDispute([d('warning_needs_response', 1)]) }),
    );
    expect((await getBalance(db, userId)).available).toBe(0);
    await applyPayment(
      ctx(),
      packPayment(userId, 'pi_warn', { dispute: mapDispute([d('warning_closed', 2)]) }),
    );
    expect((await getBalance(db, userId)).available).toBe(100);
  });

  it('refunds on past payments still claw back credits after the product is removed', async () => {
    const userId = uid();
    await applyPayment(ctx(), packPayment(userId, 'pi_gone'));
    const withoutProduct = { ...site, products: site.products.filter((p) => p.id !== 'pack_100') };
    await applyPayment(
      { db, site: withoutProduct, provider, log: deps.log },
      packPayment(userId, 'pi_gone', { amountRefunded: 1000 }),
    );
    expect((await getBalance(db, userId)).available).toBe(0);
  });

  it('a stored payment whose fact no longer maps to a product (PayPal plan replaced) still converges refunds and disputes', async () => {
    const userId = uid();
    const renewal = { productId: 'pro_month', amount: 2000, subscriptionRef: 'I-OLD' };
    await applyPayment(ctx(), packPayment(userId, 'I-OLD:TX1', renewal));
    expect((await getBalance(db, userId)).available).toBe(300);
    const unmapped = { ...renewal, productId: null };
    expect(
      await applyPayment(ctx(), packPayment(userId, 'I-OLD:TX1', { ...unmapped, dispute: 'open' })),
    ).toBe('applied');
    expect((await getBalance(db, userId)).available).toBe(0);
    await applyPayment(ctx(), packPayment(userId, 'I-OLD:TX1', { ...unmapped, dispute: 'won' }));
    expect((await getBalance(db, userId)).available).toBe(300);
    // A new payment on that plan is still not granted.
    expect(await applyPayment(ctx(), packPayment(userId, 'I-OLD:TX2', unmapped))).toBe('unmapped');
  });

  it('credits returned on a won chargeback keep the original lot expiry', async () => {
    const userId = uid();
    const start = Date.now();
    const invoice = (overrides: Partial<PaymentFact>) =>
      packPayment(userId, 'in_d', {
        productId: 'pro_month',
        amount: 2000,
        periodStart: start,
        periodEnd: start + 30 * DAY,
        ...overrides,
      });
    await applyPayment(ctx(), invoice({}));
    await applyPayment(ctx(), invoice({ dispute: 'open' }));
    await applyPayment(ctx(), invoice({ dispute: 'won' }));
    const balance = await getBalance(db, userId);
    expect(balance.available).toBe(300);
    expect((await getBalance(db, userId, start + 31 * DAY)).available).toBe(0);
  });
});

describe('webhook', () => {
  it('replies 400 on an invalid signature', async () => {
    const response = await handleWebhook(deps, webhook({ eventId: 'e', type: 't', target: null }, 'bad'));
    expect(response.status).toBe(400);
  });

  it('replies 500 on failure, is not marked processed, and grants on retry', async () => {
    const userId = uid();
    provider.payments.set('pi_f', packPayment(userId, 'pi_f'));
    provider.failNextFetch = true;
    const trigger: WebhookTrigger = { eventId: 'evt_f', type: 't', target: { kind: 'payment', ref: 'pi_f' } };
    expect((await handleWebhook(deps, webhook(trigger))).status).toBe(500);
    expect((await handleWebhook(deps, webhook(trigger))).status).toBe(200);
    expect((await getBalance(db, userId)).available).toBe(100);
  });
});

describe('subscriptions', () => {
  it('grants once per paid period, expiring at period end', async () => {
    const userId = uid();
    const start = Date.now() - 1000;
    const invoice = (ref: string, from: number): PaymentFact =>
      packPayment(userId, ref, {
        productId: 'pro_month',
        amount: 2000,
        subscriptionRef: 'sub_1',
        periodStart: from,
        periodEnd: from + 30 * DAY,
      });
    await applyPayment(ctx(), invoice('in_1', start));
    await applyPayment(ctx(), invoice('in_1', start));
    const balance = await getBalance(db, userId);
    expect(balance.available).toBe(300);
    expect(balance.nextExpiry?.at).toBe(start + 30 * DAY);
    await applyPayment(ctx(), invoice('in_2', start + 30 * DAY));
    expect((await getBalance(db, userId)).available).toBe(600);
    expect((await getBalance(db, userId, start + 31 * DAY)).available).toBe(300);
  });

  it('a stale snapshot does not overwrite a newer one', async () => {
    const userId = uid();
    const fact = (status: string, fetchedAt: number): SubscriptionFact => ({
      provider: 'fake',
      subscriptionRef: 'sub_o',
      userId,
      productId: 'pro_month',
      status,
      currentPeriodStart: 1,
      currentPeriodEnd: Date.now() + DAY,
      cancelAtPeriodEnd: false,
      fetchedAt,
    });
    await applySubscription(ctx(), fact('active', 100));
    await applySubscription(ctx(), fact('canceled', 300));
    await applySubscription(ctx(), fact('active', 200));
    const row = await db.query.subscriptions.findFirst({ where: eq(subscriptions.subscriptionRef, 'sub_o') });
    expect(row?.status).toBe('canceled');
  });
});

describe('checkout', () => {
  it('401 when signed out, 400 for unknown products', async () => {
    const request = () =>
      new Request('https://test.example/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ productId: 'pack_100' }),
      });
    expect((await handleCheckout(deps, request())).status).toBe(401);
    currentUser = { id: uid(), email: 'a@example.com', name: 'A' };
    const unknown = new Request('https://test.example/api/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ productId: 'nope' }),
    });
    expect((await handleCheckout(deps, unknown)).status).toBe(400);
  });

  it('price comes only from the catalog; return path must be site-relative; order is paid after return sync', async () => {
    currentUser = { id: uid(), email: 'b@example.com', name: 'B' };
    const response = await handleCheckout(
      deps,
      new Request('https://test.example/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ productId: 'pack_100', amount: 1, returnPath: '//evil.example' }),
      }),
    );
    const { orderId } = (await response.json()) as { orderId: string };
    const created = provider.created[0]!;
    expect(created.product.price.amount).toBe(1000);
    expect(created.successUrl.startsWith('https://test.example/billing/return?order=')).toBe(true);
    expect(created.successUrl).toContain(encodeURIComponent('/account'));

    provider.checkouts.set(`cs_${orderId}`, {
      orderId,
      subscription: null,
      payment: packPayment(currentUser.id, `pi_${orderId}`, { orderId }),
    });
    const sync = await handleSyncOrder(
      deps,
      new Request('https://test.example/api/billing/sync', {
        method: 'POST',
        body: JSON.stringify({ orderId }),
      }),
    );
    expect(await sync.json()).toMatchObject({ status: 'paid' });
    expect((await db.query.orders.findFirst({ where: eq(orders.id, orderId) }))?.paidAt).toBeTypeOf('number');
    expect((await getBalance(db, currentUser.id)).available).toBe(100);
  });

  it('other users orders are not found', async () => {
    currentUser = { id: uid(), email: 'c@example.com', name: 'C' };
    const response = await handleCheckout(
      deps,
      new Request('https://test.example/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ productId: 'pack_100' }),
      }),
    );
    const { orderId } = (await response.json()) as { orderId: string };
    currentUser = { id: uid(), email: 'd@example.com', name: 'D' };
    const sync = await handleSyncOrder(
      deps,
      new Request('https://test.example/api/billing/sync', {
        method: 'POST',
        body: JSON.stringify({ orderId }),
      }),
    );
    expect(sync.status).toBe(404);
  });

  it('receipt redirects only to the provider receipt for your own paid orders; unpaid, other users, or unsupported providers get 404', async () => {
    const owner = { id: uid(), email: 'e@example.com', name: 'E' };
    currentUser = owner;
    const response = await handleCheckout(
      deps,
      new Request('https://test.example/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ productId: 'pack_100' }),
      }),
    );
    const { orderId } = (await response.json()) as { orderId: string };
    const receipt = () =>
      handleReceipt(deps, new Request(`https://test.example/api/billing/receipt?order=${orderId}`));

    expect((await receipt()).status).toBe(404);

    const payment = packPayment(owner.id, `pi_${orderId}`, { orderId });
    provider.payments.set(payment.paymentRef, payment);
    await applyPayment(ctx(), payment);
    const ok = await receipt();
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe(`https://pay.example/receipts/pi_${orderId}`);

    currentUser = { id: uid(), email: 'f@example.com', name: 'F' };
    expect((await receipt()).status).toBe(404);
    currentUser = null;
    expect((await receipt()).status).toBe(401);

    currentUser = owner;
    deps = { ...deps, provider: Object.assign(new FakeProvider(), { receiptUrl: undefined }) };
    expect((await receipt()).status).toBe(404);
  });

  it('order list shows only paid orders with paid and refunded amounts and dispute status; abandoned checkouts never push paid orders out', async () => {
    const user = { id: uid(), email: 'g@example.com', name: 'G' };
    currentUser = user;
    const order = async () => {
      const response = await handleCheckout(
        deps,
        new Request('https://test.example/api/billing/checkout', {
          method: 'POST',
          body: JSON.stringify({ productId: 'pack_100' }),
        }),
      );
      return ((await response.json()) as { orderId: string }).orderId;
    };
    const refunded = await order();
    const disputed = await order();
    const discounted = await order();
    await applyPayment(ctx(), packPayment(user.id, `pi_${refunded}`, { orderId: refunded }));
    await applyPayment(
      ctx(),
      packPayment(user.id, `pi_${refunded}`, { orderId: refunded, amountRefunded: 400 }),
    );
    await applyPayment(ctx(), packPayment(user.id, `pi_${disputed}`, { orderId: disputed, dispute: 'open' }));
    // Promo code: list price 1000, paid 800.
    await applyPayment(ctx(), packPayment(user.id, `pi_${discounted}`, { orderId: discounted, amount: 800 }));
    for (let i = 0; i < 25; i++) await order();

    const list = await recentOrders(db, user.id);
    expect(list.every((row) => row.status === 'paid')).toBe(true);
    const rows = new Map(list.map((row) => [row.id, row]));
    expect(rows.size).toBe(3);
    expect(rows.get(refunded)).toMatchObject({ amountPaid: 1000, amountRefunded: 400, dispute: null });
    expect(rows.get(disputed)).toMatchObject({ amountRefunded: 0, dispute: 'open' });
    expect(rows.get(discounted)).toMatchObject({ amount: 1000, amountPaid: 800 });
  });
});
