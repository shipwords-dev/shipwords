import { describe, expect, it } from 'vitest';
import {
  addInterval,
  encodeCustomId,
  mapDispute,
  PayPalProvider,
  type PayPalSubscription,
  paymentFactFromCapture,
  paymentFactFromTransaction,
  readCustomId,
  subscriptionFact,
  subscriptionProduct,
  toMinor,
  webhookTarget,
} from '../src/billing/paypal';
import { WebhookSignatureError } from '../src/billing/provider';
import { defineSite, type Product, type SubscriptionProduct } from '../src/site';

const customId = encodeCustomId({ userId: 'u1', productId: 'pack_100', orderId: 'ord_1' });

const products: Product[] = [
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
    creditsPerPeriod: 500,
    refs: { paypal: 'P-PLAN' },
  },
];
const proMonth = products[1] as SubscriptionProduct;

describe('PayPal field mapping', () => {
  it('converts amounts to the smallest unit by currency decimals, without floating point', () => {
    expect(toMinor({ currency_code: 'USD', value: '19.99' })).toBe(1999);
    expect(toMinor({ currency_code: 'USD', value: '0.1' })).toBe(10);
    expect(toMinor({ currency_code: 'USD', value: '5' })).toBe(500);
    expect(toMinor({ currency_code: 'JPY', value: '1200' })).toBe(1200);
  });

  it('custom_id round-trips; bad data reads as empty', () => {
    expect(readCustomId(customId)).toEqual({ userId: 'u1', productId: 'pack_100', orderId: 'ord_1' });
    expect(readCustomId('not json')).toEqual({ userId: null, productId: null, orderId: null });
    expect(() => encodeCustomId({ userId: 'x'.repeat(120), productId: 'p', orderId: 'o' })).toThrow();
  });

  it('capture refund amount sums completed refunds under the same order', () => {
    const capture = {
      id: 'CAP1',
      status: 'PARTIALLY_REFUNDED',
      amount: { currency_code: 'USD', value: '10.00' },
      custom_id: customId,
      create_time: '2026-10-01T00:00:00Z',
    };
    const up = [{ rel: 'up', href: 'https://api-m.paypal.com/v2/payments/captures/CAP1' }];
    const fact = paymentFactFromCapture(
      capture,
      [
        { id: 'R1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '3.00' }, links: up },
        { id: 'R2', status: 'PENDING', amount: { currency_code: 'USD', value: '5.00' }, links: up },
      ],
      [],
    );
    expect(fact).toMatchObject({
      paymentRef: 'CAP1',
      chargeRef: 'CAP1',
      paid: true,
      amount: 1000,
      currency: 'usd',
      amountRefunded: 300,
      userId: 'u1',
      productId: 'pack_100',
      orderId: 'ord_1',
      paidAt: Date.parse('2026-10-01T00:00:00Z'),
    });
  });

  it('fully refunded status counts as full even without refund details', () => {
    const fact = paymentFactFromCapture(
      { id: 'CAP2', status: 'REFUNDED', amount: { currency_code: 'USD', value: '10.00' } },
      [],
      [],
    );
    expect(fact.amountRefunded).toBe(1000);
  });

  it('a PENDING capture is not paid', () => {
    const fact = paymentFactFromCapture(
      { id: 'CAP3', status: 'PENDING', amount: { currency_code: 'USD', value: '10.00' } },
      [],
      [],
    );
    expect(fact.paid).toBe(false);
  });

  it('disputes: open while unresolved, outcome once resolved, latest one wins', () => {
    expect(mapDispute([])).toBeNull();
    expect(mapDispute([{ dispute_id: 'D1', status: 'UNDER_REVIEW' }])).toBe('open');
    const resolved = (code: string) => [
      { dispute_id: 'D1', status: 'RESOLVED', dispute_outcome: { outcome_code: code } },
    ];
    expect(mapDispute(resolved('RESOLVED_SELLER_FAVOUR'))).toBe('won');
    expect(mapDispute(resolved('CANCELED_BY_BUYER'))).toBe('won');
    expect(mapDispute(resolved('RESOLVED_WITH_PAYOUT'))).toBe('won');
    expect(mapDispute(resolved('RESOLVED_BUYER_FAVOUR'))).toBe('lost');
    expect(mapDispute(resolved('ACCEPTED'))).toBe('lost');
    expect(mapDispute(resolved('NONE'))).toBe('lost');
    expect(
      mapDispute([
        { dispute_id: 'old', status: 'RESOLVED', create_time: '2026-01-01T00:00:00Z' },
        { dispute_id: 'new', status: 'OPEN', create_time: '2026-02-01T00:00:00Z' },
      ]),
    ).toBe('open');
  });

  it('subscription charges: paymentRef includes the subscription ID, period follows the billing interval, partial refunds count as full', () => {
    const subscription: PayPalSubscription = {
      id: 'I-SUB',
      status: 'ACTIVE',
      custom_id: encodeCustomId({ userId: 'u1', productId: 'pro_month', orderId: 'ord_2' }),
    };
    const transaction = {
      id: 'TX1',
      status: 'PARTIALLY_REFUNDED',
      time: '2026-01-31T00:00:00Z',
      amount_with_breakdown: { gross_amount: { currency_code: 'USD', value: '20.00' } },
    };
    const fact = paymentFactFromTransaction(subscription, transaction, [], proMonth, false);
    expect(fact).toMatchObject({
      paymentRef: 'I-SUB:TX1',
      chargeRef: 'TX1',
      paid: true,
      amount: 2000,
      amountRefunded: 2000,
      subscriptionRef: 'I-SUB',
      productId: 'pro_month',
      periodStart: Date.parse('2026-01-31T00:00:00Z'),
      periodEnd: Date.parse('2026-02-28T00:00:00Z'),
    });
  });

  it('adding a period at month end uses the last day of the month', () => {
    const at = (iso: string) => Date.parse(iso);
    expect(addInterval(at('2026-01-31T05:00:00Z'), 'month')).toBe(at('2026-02-28T05:00:00Z'));
    expect(addInterval(at('2028-01-31T00:00:00Z'), 'month')).toBe(at('2028-02-29T00:00:00Z'));
    expect(addInterval(at('2026-12-15T00:00:00Z'), 'month')).toBe(at('2027-01-15T00:00:00Z'));
    expect(addInterval(at('2028-02-29T00:00:00Z'), 'year')).toBe(at('2029-02-28T00:00:00Z'));
  });

  it('when the latest charge succeeds on retry, the service period ends at the next billing time', () => {
    const subscription: PayPalSubscription = {
      id: 'I-SUB',
      status: 'ACTIVE',
      billing_info: { next_billing_time: '2026-03-01T00:00:00Z' },
    };
    const transaction = {
      id: 'TX2',
      status: 'COMPLETED',
      time: '2026-02-05T00:00:00Z',
      amount_with_breakdown: { gross_amount: { currency_code: 'USD', value: '20.00' } },
    };
    expect(paymentFactFromTransaction(subscription, transaction, [], proMonth, true).periodEnd).toBe(
      Date.parse('2026-03-01T00:00:00Z'),
    );
    expect(paymentFactFromTransaction(subscription, transaction, [], proMonth, false).periodEnd).toBe(
      Date.parse('2026-03-05T00:00:00Z'),
    );
  });

  it('after cancellation, the paid period stays valid', () => {
    const now = Date.parse('2026-03-10T00:00:00Z');
    const base: PayPalSubscription = {
      id: 'I-SUB',
      status: 'CANCELLED',
      custom_id: encodeCustomId({ userId: 'u1', productId: 'pro_month', orderId: 'ord_2' }),
      billing_info: { last_payment: { time: '2026-03-01T00:00:00Z' } },
    };
    expect(subscriptionFact(base, proMonth, now)).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: Date.parse('2026-04-01T00:00:00Z'),
    });
    expect(subscriptionFact(base, proMonth, Date.parse('2026-05-01T00:00:00Z')).status).toBe('canceled');
    expect(
      subscriptionFact(
        {
          ...base,
          status: 'ACTIVE',
          billing_info: { ...base.billing_info, next_billing_time: '2026-04-01T10:00:00Z' },
        },
        proMonth,
        now,
      ),
    ).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: Date.parse('2026-04-01T10:00:00Z'),
    });
    expect(subscriptionFact({ ...base, status: 'SUSPENDED' }, proMonth, now).status).toBe('paused');
    expect(subscriptionFact({ ...base, status: 'APPROVAL_PENDING' }, proMonth, now).status).toBe(
      'incomplete',
    );
  });

  it('a subscription maps to the product of its plan_id, never the productId in custom_id', () => {
    const yearly: SubscriptionProduct = {
      ...proMonth,
      id: 'pro_year',
      interval: 'year',
      price: { amount: 20000, currency: 'usd' },
      refs: { paypal: 'P-YEAR' },
    };
    const catalog = [...products, yearly];
    // Monthly plan paid, custom_id forged to name the yearly product.
    const forged: PayPalSubscription = {
      id: 'I-SUB',
      status: 'CANCELLED',
      plan_id: 'P-PLAN',
      custom_id: encodeCustomId({ userId: 'u1', productId: 'pro_year', orderId: 'ord_2' }),
      billing_info: { last_payment: { time: '2026-03-01T00:00:00Z' } },
    };
    expect(subscriptionProduct(forged, catalog)?.id).toBe('pro_month');
    expect(
      subscriptionFact(forged, subscriptionProduct(forged, catalog), Date.parse('2026-03-10T00:00:00Z')),
    ).toMatchObject({
      productId: 'pro_month',
      currentPeriodEnd: Date.parse('2026-04-01T00:00:00Z'),
    });
    // A plan no product points to, or no plan at all: unmapped.
    expect(subscriptionProduct({ plan_id: 'P-OTHER' }, catalog)).toBeNull();
    expect(subscriptionProduct({}, catalog)).toBeNull();
    const unknown = subscriptionFact(
      { ...forged, plan_id: 'P-OTHER' },
      null,
      Date.parse('2026-03-10T00:00:00Z'),
    );
    expect(unknown).toMatchObject({ productId: null, status: 'canceled' });
  });

  it('maps webhook events to the object to fetch', () => {
    const ev = (event_type: string, resource: Record<string, unknown>) =>
      webhookTarget({ id: 'WH-1', event_type, resource });
    expect(ev('CHECKOUT.ORDER.APPROVED', { id: 'ORD1' })).toEqual({ kind: 'checkout', ref: 'ORD1' });
    expect(ev('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP1' })).toEqual({ kind: 'payment', ref: 'CAP1' });
    expect(
      ev('PAYMENT.CAPTURE.REFUNDED', {
        id: 'R1',
        links: [{ rel: 'up', href: 'https://api-m.paypal.com/v2/payments/captures/CAP1' }],
      }),
    ).toEqual({ kind: 'charge', ref: 'CAP1' });
    expect(ev('PAYMENT.SALE.COMPLETED', { id: 'TX1', billing_agreement_id: 'I-SUB' })).toEqual({
      kind: 'checkout',
      ref: 'I-SUB:TX1',
    });
    expect(ev('PAYMENT.SALE.COMPLETED', { id: 'TX1' })).toBeNull();
    expect(ev('PAYMENT.SALE.REFUNDED', { id: 'R2', sale_id: 'TX1' })).toEqual({ kind: 'charge', ref: 'TX1' });
    expect(
      ev('CUSTOMER.DISPUTE.CREATED', { disputed_transactions: [{ seller_transaction_id: 'CAP1' }] }),
    ).toEqual({ kind: 'charge', ref: 'CAP1' });
    expect(ev('BILLING.SUBSCRIPTION.CANCELLED', { id: 'I-SUB' })).toEqual({
      kind: 'subscription',
      ref: 'I-SUB',
    });
    expect(ev('BILLING.PLAN.CREATED', { id: 'P-1' })).toBeNull();
  });

  it('PayPal sites must configure a Plan ID for subscription products', () => {
    const base = {
      id: 't',
      name: 'T',
      url: 'https://t.example',
      locales: ['en'],
      defaultLocale: 'en',
      signup: { bonusCredits: 0, bonusExpiresDays: null, bonusPerIpDaily: 1, bonusSiteDaily: 100 },
      guest: { dailyPerDevice: 1, dailyPerIp: 1, dailySiteBudget: 1, minRecaptchaScore: 0.5 },
      billing: { provider: 'paypal' as const },
    };
    expect(() => defineSite({ ...base, products })).not.toThrow();
    const { refs: _refs, ...withoutPlan } = products[1] as Product & { refs?: unknown };
    expect(() => defineSite({ ...base, products: [withoutPlan as Product] })).toThrow(/refs.paypal/);
  });
});

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakePayPal(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    calls.push(call);
    const path = new URL(url).pathname;
    if (path === '/v1/oauth2/token') {
      return Response.json({ access_token: 'tok', expires_in: 3600 });
    }
    const handler = routes[`${call.method} ${path}`];
    if (!handler) return Response.json({ name: 'RESOURCE_NOT_FOUND' }, { status: 404 });
    const result = handler(call);
    return Response.json(result.body, { status: result.status ?? 200 });
  }) as typeof fetch;
  const provider = new PayPalProvider(
    { clientId: 'id', clientSecret: 'secret', webhookId: 'WH-ID', sandbox: true, products },
    fetcher,
  );
  return { provider, calls };
}

const capture = {
  id: 'CAP1',
  status: 'COMPLETED',
  amount: { currency_code: 'USD', value: '10.00' },
  custom_id: customId,
  invoice_id: 'ord_1',
  create_time: '2026-10-01T00:00:00Z',
  supplementary_data: { related_ids: { order_id: 'ORD1' } },
};
const completedOrder = {
  id: 'ORD1',
  status: 'COMPLETED',
  purchase_units: [{ invoice_id: 'ord_1', custom_id: customId, payments: { captures: [capture] } }],
};

describe('PayPalProvider', () => {
  it('billing portal: automatic payments page with subscription products, activity page with only one-time products', async () => {
    const options = { clientId: 'id', clientSecret: 'secret', webhookId: 'WH-ID', sandbox: true };
    expect(await new PayPalProvider({ ...options, products }).portalUrl()).toBe(
      'https://www.sandbox.paypal.com/myaccount/autopay/',
    );
    const packs = products.filter((p) => p.kind !== 'subscription');
    expect(await new PayPalProvider({ ...options, products: packs }).portalUrl()).toBe(
      'https://www.sandbox.paypal.com/myaccount/activities/',
    );
    expect(await new PayPalProvider({ ...options, sandbox: false, products: packs }).portalUrl()).toBe(
      'https://www.paypal.com/myaccount/activities/',
    );
  });

  it('credit pack checkout: amount from catalog, invoice_id is our order ID, with an idempotency key', async () => {
    const { provider, calls } = fakePayPal({
      'POST /v2/checkout/orders': () => ({
        body: { id: 'ORD1', links: [{ rel: 'payer-action', href: 'https://paypal.test/approve' }] },
      }),
    });
    const result = await provider.createCheckout({
      orderId: 'ord_1',
      siteId: 't',
      product: products[0] as Product,
      userId: 'u1',
      customerRef: 'u1',
      successUrl: 'https://t.example/billing/return?order=ord_1',
      cancelUrl: 'https://t.example/pricing',
    });
    expect(result).toEqual({ url: 'https://paypal.test/approve', checkoutRef: 'ORD1' });
    const create = calls.find((c) => c.url.endsWith('/v2/checkout/orders'));
    expect(create?.url.startsWith('https://api-m.sandbox.paypal.com')).toBe(true);
    expect(create?.headers['paypal-request-id']).toBe('checkout:ord_1');
    const unit = JSON.parse(create?.body ?? '{}').purchase_units[0];
    expect(unit).toMatchObject({
      invoice_id: 'ord_1',
      custom_id: customId,
      amount: { currency_code: 'USD', value: '10.00' },
    });
  });

  it('subscription checkout uses the Plan from refs.paypal', async () => {
    const { provider, calls } = fakePayPal({
      'POST /v1/billing/subscriptions': () => ({
        body: { id: 'I-SUB', links: [{ rel: 'approve', href: 'https://paypal.test/sub' }] },
      }),
    });
    const result = await provider.createCheckout({
      orderId: 'ord_2',
      siteId: 't',
      product: products[1] as Product,
      userId: 'u1',
      customerRef: 'u1',
      successUrl: 'https://t.example/ok',
      cancelUrl: 'https://t.example/pricing',
    });
    expect(result.checkoutRef).toBe('I-SUB');
    expect(JSON.parse(calls.at(-1)?.body ?? '{}').plan_id).toBe('P-PLAN');
  });

  it('approved order on return: captures then returns the payment, capture uses a fixed idempotency key', async () => {
    let captured = false;
    const { provider, calls } = fakePayPal({
      'GET /v2/checkout/orders/ORD1': () => ({
        body: captured
          ? completedOrder
          : { id: 'ORD1', status: 'APPROVED', purchase_units: [{ invoice_id: 'ord_1' }] },
      }),
      'POST /v2/checkout/orders/ORD1/capture': () => {
        captured = true;
        return { status: 201, body: completedOrder };
      },
      'GET /v2/payments/captures/CAP1': () => ({ body: capture }),
      'GET /v1/customer/disputes': () => ({ body: { items: [] } }),
    });
    const fact = await provider.fetchCheckout('ORD1');
    expect(fact.orderId).toBe('ord_1');
    expect(fact.payment).toMatchObject({ paymentRef: 'CAP1', paid: true, amount: 1000, userId: 'u1' });
    const capturing = calls.find((c) => c.url.endsWith('/capture'));
    expect(capturing?.headers['paypal-request-id']).toBe('capture:ORD1');
    expect(calls.some((c) => c.url.includes('disputed_transaction_id=CAP1'))).toBe(true);
  });

  it('re-reads the order when a concurrent request already captured it', async () => {
    const { provider } = fakePayPal({
      'GET /v2/checkout/orders/ORD1': (() => {
        let n = 0;
        return () => ({ body: n++ === 0 ? { id: 'ORD1', status: 'APPROVED' } : completedOrder });
      })(),
      'POST /v2/checkout/orders/ORD1/capture': () => ({
        status: 422,
        body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] },
      }),
      'GET /v2/payments/captures/CAP1': () => ({ body: capture }),
      'GET /v1/customer/disputes': () => ({ body: { items: [] } }),
    });
    const fact = await provider.fetchCheckout('ORD1');
    expect(fact.payment?.paymentRef).toBe('CAP1');
  });

  it('a declined charge does not throw and the order stays unpaid', async () => {
    const { provider } = fakePayPal({
      'GET /v2/checkout/orders/ORD1': () => ({ body: { id: 'ORD1', status: 'APPROVED' } }),
      'POST /v2/checkout/orders/ORD1/capture': () => ({
        status: 422,
        body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] },
      }),
    });
    const fact = await provider.fetchCheckout('ORD1');
    expect(fact.payment).toBeNull();
  });

  it('refunded capture sums refunds from the order and fetches details for resolved disputes', async () => {
    const { provider } = fakePayPal({
      'GET /v2/payments/captures/CAP1': () => ({ body: { ...capture, status: 'PARTIALLY_REFUNDED' } }),
      'GET /v2/checkout/orders/ORD1': () => ({
        body: {
          ...completedOrder,
          purchase_units: [
            {
              payments: {
                captures: [capture],
                refunds: [{ id: 'R1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '4.00' } }],
              },
            },
          ],
        },
      }),
      'GET /v1/customer/disputes': () => ({ body: { items: [{ dispute_id: 'D1', status: 'RESOLVED' }] } }),
      'GET /v1/customer/disputes/D1': () => ({
        body: {
          dispute_id: 'D1',
          status: 'RESOLVED',
          dispute_outcome: { outcome_code: 'RESOLVED_SELLER_FAVOUR' },
        },
      }),
    });
    const fact = await provider.fetchPayment('CAP1');
    expect(fact).toMatchObject({ amountRefunded: 400, dispute: 'won' });
  });

  it('finds a subscription charge by transaction ID in the subscription transaction list', async () => {
    const { provider } = fakePayPal({
      'GET /v1/billing/subscriptions/I-SUB': () => ({
        body: {
          id: 'I-SUB',
          status: 'ACTIVE',
          create_time: '2026-10-01T00:00:00Z',
          plan_id: 'P-PLAN',
          custom_id: encodeCustomId({ userId: 'u1', productId: 'pro_month', orderId: 'ord_2' }),
        },
      }),
      'GET /v1/billing/subscriptions/I-SUB/transactions': () => ({
        body: {
          transactions: [
            {
              id: 'TX1',
              status: 'COMPLETED',
              time: '2026-10-01T00:01:00Z',
              amount_with_breakdown: { gross_amount: { currency_code: 'USD', value: '20.00' } },
            },
          ],
        },
      }),
      'GET /v1/customer/disputes': () => ({ body: {} }),
    });
    expect(await provider.fetchPayment('I-SUB:TX1')).toMatchObject({
      paid: true,
      amount: 2000,
      productId: 'pro_month',
      orderId: 'ord_2',
    });
    expect(await provider.fetchPayment('I-SUB:TX9')).toBeNull();
    // Renewal webhook arrives before the transaction list: throw so PayPal retries; must not be treated as "no payment".
    await expect(provider.fetchCheckout('I-SUB:TX9')).rejects.toThrow(/not listed yet/);
    expect((await provider.fetchCheckout('I-SUB')).payment?.paymentRef).toBe('I-SUB:TX1');
    // Renewal webhook: payment and subscription are returned together, and paymentRef matches the return path.
    const renewal = await provider.fetchCheckout('I-SUB:TX1');
    expect(renewal.subscription).toMatchObject({ subscriptionRef: 'I-SUB', status: 'active' });
    expect(renewal.payment?.paymentRef).toBe('I-SUB:TX1');
  });

  it('returns null when no capture is found by transaction ID', async () => {
    const { provider } = fakePayPal({});
    expect(await provider.fetchPaymentByCharge('TX-UNKNOWN')).toBeNull();
  });

  describe('webhook signature verification', () => {
    const body =
      '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP1","amount":1.10}}';
    const headers = {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.paypal.com/cert.pem',
      'paypal-transmission-id': 'T1',
      'paypal-transmission-sig': 'SIG',
      'paypal-transmission-time': '2026-10-27T00:00:00Z',
    };

    it('forwards the raw event body to PayPal for verification and returns the trigger on success', async () => {
      const { provider, calls } = fakePayPal({
        'POST /v1/notifications/verify-webhook-signature': () => ({
          body: { verification_status: 'SUCCESS' },
        }),
      });
      const trigger = await provider.parseWebhook(
        new Request('https://t.example', { method: 'POST', headers, body }),
      );
      expect(trigger).toEqual({
        eventId: 'WH-1',
        type: 'PAYMENT.CAPTURE.COMPLETED',
        target: { kind: 'payment', ref: 'CAP1' },
      });
      const sent = calls.find((c) => c.url.endsWith('/verify-webhook-signature'))?.body ?? '';
      expect(sent.endsWith(`"webhook_event":${body}}`)).toBe(true);
      expect(JSON.parse(sent)).toMatchObject({
        webhook_id: 'WH-ID',
        transmission_sig: 'SIG',
        auth_algo: 'SHA256withRSA',
      });
    });

    it('throws WebhookSignatureError on failed verification or missing signature headers', async () => {
      const { provider } = fakePayPal({
        'POST /v1/notifications/verify-webhook-signature': () => ({
          body: { verification_status: 'FAILURE' },
        }),
      });
      await expect(
        provider.parseWebhook(new Request('https://t.example', { method: 'POST', headers, body })),
      ).rejects.toBeInstanceOf(WebhookSignatureError);
      await expect(
        provider.parseWebhook(new Request('https://t.example', { method: 'POST', body })),
      ).rejects.toBeInstanceOf(WebhookSignatureError);
    });
  });
});
