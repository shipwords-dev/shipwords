import type { Product, SubscriptionProduct } from '../site';
import type {
  CheckoutFact,
  CheckoutRequest,
  PaymentFact,
  PaymentProvider,
  SubscriptionFact,
  WebhookTarget,
  WebhookTrigger,
} from './provider';
import { WebhookSignatureError } from './provider';

// PayPal adapter (REST API; paypal.cn merchant accounts also use api-m.paypal.com). Conventions:
// - Credit packs use Orders v2: we capture after buyer approval; both the return page and the CHECKOUT.ORDER.APPROVED webhook trigger capture,
//   and capture sends a fixed PayPal-Request-Id so repeated calls charge only once;
// - Subscriptions use Subscriptions v1 with pre-created Plans; the Plan ID lives in the product's refs.paypal;
// - Our userId, productId and orderId go into custom_id (max 127 chars), and orderId also goes into invoice_id,
//   since PayPal rejects a second payment with the same invoice_id. custom_id is untrusted (anyone with the client ID can create a
//   subscription carrying any custom_id), so a subscription's product comes from its plan_id;
// - For one-time payments both paymentRef and chargeRef are the capture ID; for each subscription period paymentRef is `<subscription ID>:<transaction ID>`,
//   and chargeRef is the transaction ID (what dispute and refund events reference).

export interface PayPalOptions {
  clientId: string;
  clientSecret: string;
  webhookId: string;
  sandbox: boolean;
  products: readonly Product[];
}

const PROVIDER = 'paypal';

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly issue: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'PayPalApiError';
  }
}

interface Money {
  currency_code: string;
  value: string;
}

export interface PayPalCapture {
  id: string;
  status: string;
  amount: Money;
  custom_id?: string;
  invoice_id?: string;
  create_time?: string;
  supplementary_data?: { related_ids?: { order_id?: string } };
}

export interface PayPalRefund {
  id: string;
  status: string;
  amount?: Money;
  links?: { href: string; rel: string }[];
}

export interface PayPalOrder {
  id: string;
  status: string;
  purchase_units?: {
    custom_id?: string;
    invoice_id?: string;
    payments?: { captures?: PayPalCapture[]; refunds?: PayPalRefund[] };
  }[];
  links?: { href: string; rel: string }[];
}

export interface PayPalSubscription {
  id: string;
  status: string;
  custom_id?: string;
  plan_id?: string;
  create_time?: string;
  billing_info?: { next_billing_time?: string; last_payment?: { time?: string } };
  links?: { href: string; rel: string }[];
}

export interface PayPalTransaction {
  id: string;
  status: string;
  time?: string;
  amount_with_breakdown?: { gross_amount?: Money };
}

export interface PayPalDispute {
  dispute_id: string;
  status: string;
  create_time?: string;
  dispute_outcome?: { outcome_code?: string };
}

interface OurMetadata {
  userId: string | null;
  productId: string | null;
  orderId: string | null;
}

export function encodeCustomId(meta: { userId: string; productId: string; orderId: string }): string {
  const value = JSON.stringify({ u: meta.userId, p: meta.productId, o: meta.orderId });
  if (value.length > 127) throw new Error(`paypal custom_id too long: ${value.length}`);
  return value;
}

export function readCustomId(customId: string | null | undefined): OurMetadata {
  try {
    const parsed = customId ? (JSON.parse(customId) as { u?: unknown; p?: unknown; o?: unknown }) : null;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return { userId: str(parsed?.u), productId: str(parsed?.p), orderId: str(parsed?.o) };
  } catch {
    return { userId: null, productId: null, orderId: null };
  }
}

const ZERO_DECIMAL = new Set(['HUF', 'JPY', 'TWD']);

/** "12.34" → 1234; converts to the smallest unit using the currency's decimals, without floating point. */
export function toMinor(money: Money | undefined): number {
  if (!money) return 0;
  const digits = ZERO_DECIMAL.has(money.currency_code.toUpperCase()) ? 0 : 2;
  const [whole = '0', frac = ''] = money.value.split('.');
  return Number(whole) * 10 ** digits + Number(`${frac}00`.slice(0, digits) || '0');
}

export function fromMinor(amount: number, currency: string): Money {
  const code = currency.toUpperCase();
  const value = ZERO_DECIMAL.has(code) ? String(amount) : (amount / 100).toFixed(2);
  return { currency_code: code, value };
}

const time = (value: string | null | undefined) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
};

/** Adds one billing period; if the target month lacks that day, uses the month's last day (Jan 31 → Feb 28/29) instead of overflowing. */
export function addInterval(start: number, interval: 'month' | 'year'): number {
  const date = new Date(start);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  if (interval === 'year') date.setUTCFullYear(date.getUTCFullYear() + 1);
  else date.setUTCMonth(date.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

export function mapDispute(disputes: PayPalDispute[]): PaymentFact['dispute'] {
  const latest = [...disputes].sort((a, b) => (time(b.create_time) ?? 0) - (time(a.create_time) ?? 0))[0];
  if (!latest) return null;
  if (latest.status !== 'RESOLVED') return 'open';
  switch (latest.dispute_outcome?.outcome_code) {
    // Buyer withdrew, claim denied, or PayPal paid the buyer out of its own pocket: the money stays with us.
    case 'RESOLVED_SELLER_FAVOUR':
    case 'CANCELED_BY_BUYER':
    case 'DENIED':
    case 'RESOLVED_WITH_PAYOUT':
      return 'won';
    // RESOLVED_BUYER_FAVOUR, ACCEPTED (we agreed to refund), and unknown outcomes are all treated as lost with a full clawback.
    default:
      return 'lost';
  }
}

const REFUNDED = new Set(['REFUNDED', 'PARTIALLY_REFUNDED']);

/** One-time payment: the capture plus completed refunds and disputes under the same order. */
export function paymentFactFromCapture(
  capture: PayPalCapture,
  refunds: PayPalRefund[],
  disputes: PayPalDispute[],
): PaymentFact {
  const amount = toMinor(capture.amount);
  // Our orders have a single capture; refunds with a rel=up link are still filtered by capture.
  let amountRefunded = refunds
    .filter((refund) => refund.status === 'COMPLETED')
    .filter((refund) => (captureIdOfRefund(refund) ?? capture.id) === capture.id)
    .reduce((sum, refund) => sum + toMinor(refund.amount), 0);
  // If the status says fully refunded but no refund details add up, trust the status.
  if (capture.status === 'REFUNDED') amountRefunded = Math.max(amountRefunded, amount);
  return {
    provider: PROVIDER,
    paymentRef: capture.id,
    chargeRef: capture.id,
    paid: capture.status === 'COMPLETED' || REFUNDED.has(capture.status),
    amount,
    currency: capture.amount.currency_code.toLowerCase(),
    amountRefunded,
    dispute: mapDispute(disputes),
    metadataTrusted: false,
    ...readCustomId(capture.custom_id),
    subscriptionRef: null,
    periodStart: null,
    periodEnd: null,
    paidAt: time(capture.create_time),
    fetchedAt: Date.now(),
  };
}

/**
 * The product a subscription bills for, read from its plan_id: custom_id is set by the buyer's browser, so its productId could
 * name a pricier or longer product. A plan no product points to (e.g. replaced in config) maps to null and the payment goes unmapped.
 */
export function subscriptionProduct(
  subscription: Pick<PayPalSubscription, 'plan_id'>,
  products: readonly Product[],
): SubscriptionProduct | null {
  if (!subscription.plan_id) return null;
  const product = products.find((p) => p.kind === 'subscription' && p.refs?.paypal === subscription.plan_id);
  return product?.kind === 'subscription' ? product : null;
}

/**
 * One subscription period: an entry in the subscription's transaction list. PayPal doesn't expose partial refund amounts, so partial refunds are clawed back in full.
 * Service period: from the latest charge to the subscription's next billing time (when a retry succeeds, payment time is later than the period start, so payment time + one period is wrong);
 * older charges have no matching next billing time, so it's estimated as payment time + one period.
 */
export function paymentFactFromTransaction(
  subscription: PayPalSubscription,
  transaction: PayPalTransaction,
  disputes: PayPalDispute[],
  product: SubscriptionProduct | null,
  latest: boolean,
): PaymentFact {
  const amount = toMinor(transaction.amount_with_breakdown?.gross_amount);
  const paidAt = time(transaction.time);
  const nextBilling = latest ? time(subscription.billing_info?.next_billing_time) : null;
  const periodEnd =
    nextBilling != null && paidAt != null && nextBilling > paidAt
      ? nextBilling
      : paidAt != null && product
        ? addInterval(paidAt, product.interval)
        : null;
  return {
    provider: PROVIDER,
    paymentRef: `${subscription.id}:${transaction.id}`,
    chargeRef: transaction.id,
    paid: transaction.status === 'COMPLETED' || REFUNDED.has(transaction.status),
    amount,
    currency: (transaction.amount_with_breakdown?.gross_amount?.currency_code ?? '').toLowerCase(),
    amountRefunded: REFUNDED.has(transaction.status) ? amount : 0,
    dispute: mapDispute(disputes),
    metadataTrusted: false,
    ...readCustomId(subscription.custom_id),
    productId: product?.id ?? null,
    subscriptionRef: subscription.id,
    periodStart: paidAt,
    periodEnd,
    paidAt,
    fetchedAt: Date.now(),
  };
}

export function subscriptionFact(
  subscription: PayPalSubscription,
  product: SubscriptionProduct | null,
  fetchedAt: number,
): SubscriptionFact {
  const lastPaid = time(subscription.billing_info?.last_payment?.time);
  const paidUntil = lastPaid != null && product ? addInterval(lastPaid, product.interval) : null;
  let status: string;
  let periodEnd = time(subscription.billing_info?.next_billing_time) ?? paidUntil;
  let cancelAtPeriodEnd = false;
  switch (subscription.status) {
    case 'ACTIVE':
      status = 'active';
      break;
    case 'SUSPENDED':
      status = 'paused';
      break;
    case 'CANCELLED':
    case 'EXPIRED':
      // PayPal cancels immediately, with no cancel-at-period-end; the paid period stays valid and activeSubscription stops returning it once it ends.
      periodEnd = paidUntil;
      status = paidUntil != null && paidUntil > fetchedAt ? 'active' : 'canceled';
      cancelAtPeriodEnd = status === 'active';
      break;
    default:
      status = 'incomplete';
  }
  return {
    provider: PROVIDER,
    subscriptionRef: subscription.id,
    ...readCustomId(subscription.custom_id),
    productId: product?.id ?? null,
    status,
    currentPeriodStart: lastPaid,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd,
    fetchedAt,
  };
}

function captureIdOfRefund(refund: PayPalRefund): string | null {
  const up = refund.links?.find((link) => link.rel === 'up')?.href;
  const match = up?.match(/\/captures\/([^/?]+)/);
  return match?.[1] ?? null;
}

interface PayPalEvent {
  id: string;
  event_type: string;
  resource?: Record<string, unknown>;
}

export function webhookTarget(event: PayPalEvent): WebhookTarget | null {
  const resource = event.resource ?? {};
  const id = typeof resource.id === 'string' ? resource.id : null;
  switch (event.event_type) {
    case 'CHECKOUT.ORDER.APPROVED':
    case 'CHECKOUT.ORDER.COMPLETED':
      return id ? { kind: 'checkout', ref: id } : null;
    case 'PAYMENT.CAPTURE.COMPLETED':
    case 'PAYMENT.CAPTURE.DENIED':
      return id ? { kind: 'payment', ref: id } : null;
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED': {
      // resource is the refund; find the original capture via its rel=up link.
      const capture = captureIdOfRefund(resource as unknown as PayPalRefund) ?? id;
      return capture ? { kind: 'charge', ref: capture } : null;
    }
    case 'PAYMENT.SALE.COMPLETED': {
      // Handle as checkout: on renewal PayPal doesn't guarantee a separate subscription update event, so payment and subscription period are stored together.
      const subscription = resource.billing_agreement_id;
      return id && typeof subscription === 'string'
        ? { kind: 'checkout', ref: `${subscription}:${id}` }
        : null;
    }
    case 'PAYMENT.SALE.REFUNDED':
    case 'PAYMENT.SALE.REVERSED': {
      const sale = typeof resource.sale_id === 'string' ? resource.sale_id : id;
      return sale ? { kind: 'charge', ref: sale } : null;
    }
    case 'CUSTOMER.DISPUTE.CREATED':
    case 'CUSTOMER.DISPUTE.UPDATED':
    case 'CUSTOMER.DISPUTE.RESOLVED': {
      const transactions = resource.disputed_transactions as { seller_transaction_id?: string }[] | undefined;
      const ref = transactions?.find((t) => t.seller_transaction_id)?.seller_transaction_id;
      return ref ? { kind: 'charge', ref } : null;
    }
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.UPDATED':
    case 'BILLING.SUBSCRIPTION.RE-ACTIVATED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED':
    case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
      return id ? { kind: 'subscription', ref: id } : null;
    default:
      return null;
  }
}

const SIGNATURE_HEADERS = {
  auth_algo: 'paypal-auth-algo',
  cert_url: 'paypal-cert-url',
  transmission_id: 'paypal-transmission-id',
  transmission_sig: 'paypal-transmission-sig',
  transmission_time: 'paypal-transmission-time',
} as const;

export class PayPalProvider implements PaymentProvider {
  readonly name = PROVIDER;
  private readonly base: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly options: PayPalOptions,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.base = options.sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  }

  /** PayPal has no customer object, so billing ownership uses our userId directly. */
  async createCustomer(user: { id: string }): Promise<string> {
    return user.id;
  }

  async createCheckout(request: CheckoutRequest): Promise<{ url: string; checkoutRef: string }> {
    const { product } = request;
    const customId = encodeCustomId({
      userId: request.userId,
      productId: product.id,
      orderId: request.orderId,
    });
    if (product.kind === 'subscription') {
      const planId = product.refs?.paypal;
      if (!planId) throw new Error(`product ${product.id} has no refs.paypal plan id`);
      const subscription = await this.call<PayPalSubscription>('POST', '/v1/billing/subscriptions', {
        body: {
          plan_id: planId,
          custom_id: customId,
          application_context: {
            shipping_preference: 'NO_SHIPPING',
            user_action: 'SUBSCRIBE_NOW',
            return_url: request.successUrl,
            cancel_url: request.cancelUrl,
          },
        },
        requestId: `checkout:${request.orderId}`,
      });
      return { url: linkOf(subscription.links, 'approve'), checkoutRef: subscription.id };
    }
    const order = await this.call<PayPalOrder>('POST', '/v2/checkout/orders', {
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: customId,
            invoice_id: request.orderId,
            description: product.name.slice(0, 127),
            amount: fromMinor(product.price.amount, product.price.currency),
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW',
              return_url: request.successUrl,
              cancel_url: request.cancelUrl,
            },
          },
        },
      },
      requestId: `checkout:${request.orderId}`,
    });
    return { url: linkOf(order.links, 'payer-action'), checkoutRef: order.id };
  }

  async parseWebhook(request: Request): Promise<WebhookTrigger> {
    if (!this.options.webhookId) throw new Error('missing env PAYPAL_WEBHOOK_ID');
    const body = await request.text();
    const headers: Record<string, string> = {};
    for (const [field, header] of Object.entries(SIGNATURE_HEADERS)) {
      const value = request.headers.get(header);
      if (!value) throw new WebhookSignatureError(`missing ${header} header`);
      headers[field] = value;
    }
    let event: PayPalEvent;
    try {
      event = JSON.parse(body) as PayPalEvent;
    } catch {
      throw new WebhookSignatureError('webhook body is not json');
    }
    // Splice the raw event body in as-is: parsing and reserializing can change key order or number formatting and break PayPal's verification.
    const payload = `{${Object.entries({ ...headers, webhook_id: this.options.webhookId })
      .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
      .join(',')},"webhook_event":${body}}`;
    const result = await this.call<{ verification_status?: string }>(
      'POST',
      '/v1/notifications/verify-webhook-signature',
      { rawBody: payload },
    );
    if (result.verification_status !== 'SUCCESS') throw new WebhookSignatureError();
    return { eventId: event.id, type: event.event_type, target: webhookTarget(event) };
  }

  /** checkoutRef is an order ID, a subscription ID (return sync, takes the first charge), or `<subscription ID>:<transaction ID>` (renewal webhook). */
  async fetchCheckout(checkoutRef: string): Promise<CheckoutFact> {
    if (checkoutRef.startsWith('I-')) {
      const [subscriptionRef = '', transactionId] = checkoutRef.split(':');
      const subscription = await this.getSubscription(subscriptionRef);
      const transactions = await this.transactions(subscription);
      const target = transactionId
        ? transactions.find((t) => t.id === transactionId)
        : transactions.find((t) => t.status === 'COMPLETED');
      // Observed in sandbox: PAYMENT.SALE.COMPLETED arrives before the subscription transaction list has it. If not found, throw so the webhook returns 500 and PayPal retries;
      // otherwise the event is marked processed and the renewal credits are never granted.
      if (transactionId && !target) {
        throw new Error(`paypal subscription transaction not listed yet: ${checkoutRef}`);
      }
      const payment = target ? await this.transactionFact(subscription, target, transactions) : null;
      return {
        orderId: readCustomId(subscription.custom_id).orderId,
        subscription: subscriptionFact(subscription, this.productOf(subscription), Date.now()),
        payment,
      };
    }
    let order = await this.call<PayPalOrder>('GET', `/v2/checkout/orders/${checkoutRef}`);
    if (order.status === 'APPROVED') order = await this.capture(order);
    const unit = order.purchase_units?.[0];
    const orderId = unit?.invoice_id ?? readCustomId(unit?.custom_id).orderId;
    const capture = unit?.payments?.captures?.[0];
    const payment = capture ? await this.fetchPayment(capture.id) : null;
    return { orderId, subscription: null, payment };
  }

  async fetchPayment(paymentRef: string): Promise<PaymentFact | null> {
    const split = paymentRef.indexOf(':');
    if (split > 0) {
      const subscription = await this.getSubscription(paymentRef.slice(0, split));
      const transactionId = paymentRef.slice(split + 1);
      const transactions = await this.transactions(subscription);
      const transaction = transactions.find((t) => t.id === transactionId);
      return transaction ? this.transactionFact(subscription, transaction, transactions) : null;
    }
    const capture = await this.call<PayPalCapture>('GET', `/v2/payments/captures/${paymentRef}`);
    const orderRef = capture.supplementary_data?.related_ids?.order_id;
    const [refunds, disputes] = await Promise.all([
      REFUNDED.has(capture.status) && orderRef ? this.orderRefunds(orderRef) : [],
      this.disputes(capture.id),
    ]);
    return paymentFactFromCapture(capture, refunds, disputes);
  }

  /** Dispute and refund events carry only the transaction ID. Subscription charges recorded chargeRef on first insert, so only one-time payments need handling here. */
  async fetchPaymentByCharge(chargeRef: string): Promise<PaymentFact | null> {
    try {
      return await this.fetchPayment(chargeRef);
    } catch (error) {
      if (error instanceof PayPalApiError && error.status === 404) return null;
      throw error;
    }
  }

  async fetchSubscription(subscriptionRef: string): Promise<SubscriptionFact | null> {
    const subscription = await this.getSubscription(subscriptionRef);
    return subscriptionFact(subscription, this.productOf(subscription), Date.now());
  }

  /**
   * PayPal has no merchant billing portal. With subscription products, go to the automatic payments page (where buyers cancel);
   * with only one-time products, go to the activity page, since automatic payments lists only subscriptions.
   */
  async portalUrl(): Promise<string> {
    const page = this.options.products.some((p) => p.kind === 'subscription') ? 'autopay' : 'activities';
    return `https://www.${this.options.sandbox ? 'sandbox.' : ''}paypal.com/myaccount/${page}/`;
  }

  private async capture(order: PayPalOrder): Promise<PayPalOrder> {
    try {
      return await this.call<PayPalOrder>('POST', `/v2/checkout/orders/${order.id}/capture`, {
        body: {},
        requestId: `capture:${order.id}`,
      });
    } catch (error) {
      if (!(error instanceof PayPalApiError) || error.status !== 422) throw error;
      // Already captured by a concurrent request: re-read. Other cases such as a declined charge: the order stays unpaid and the buyer can retry.
      if (error.issue === 'ORDER_ALREADY_CAPTURED') {
        return this.call<PayPalOrder>('GET', `/v2/checkout/orders/${order.id}`);
      }
      return order;
    }
  }

  private async orderRefunds(orderRef: string): Promise<PayPalRefund[]> {
    const order = await this.call<PayPalOrder>('GET', `/v2/checkout/orders/${orderRef}`);
    return (order.purchase_units ?? []).flatMap((unit) => unit.payments?.refunds ?? []);
  }

  private async disputes(transactionId: string): Promise<PayPalDispute[]> {
    const list = await this.call<{ items?: PayPalDispute[] }>(
      'GET',
      `/v1/customer/disputes?disputed_transaction_id=${encodeURIComponent(transactionId)}`,
    );
    const items = list.items ?? [];
    // The list doesn't always include the outcome, so fetch details for resolved disputes.
    return Promise.all(
      items.map((item) =>
        item.status === 'RESOLVED' && !item.dispute_outcome
          ? this.call<PayPalDispute>('GET', `/v1/customer/disputes/${item.dispute_id}`)
          : item,
      ),
    );
  }

  private getSubscription(id: string) {
    return this.call<PayPalSubscription>('GET', `/v1/billing/subscriptions/${id}`);
  }

  private async transactions(subscription: PayPalSubscription): Promise<PayPalTransaction[]> {
    const start = new Date((time(subscription.create_time) ?? Date.now()) - 86_400_000).toISOString();
    const end = new Date(Date.now() + 86_400_000).toISOString();
    const list = await this.call<{ transactions?: PayPalTransaction[] }>(
      'GET',
      `/v1/billing/subscriptions/${subscription.id}/transactions?start_time=${start}&end_time=${end}`,
    );
    return list.transactions ?? [];
  }

  private async transactionFact(
    subscription: PayPalSubscription,
    transaction: PayPalTransaction,
    transactions: PayPalTransaction[],
  ) {
    const paidAt = time(transaction.time) ?? 0;
    const charged = (t: PayPalTransaction) => t.status !== 'DECLINED' && t.status !== 'FAILED';
    const latest = !transactions.some(
      (t) => t.id !== transaction.id && charged(t) && (time(t.time) ?? 0) > paidAt,
    );
    return paymentFactFromTransaction(
      subscription,
      transaction,
      await this.disputes(transaction.id),
      this.productOf(subscription),
      latest,
    );
  }

  private productOf(subscription: PayPalSubscription): SubscriptionProduct | null {
    return subscriptionProduct(subscription, this.options.products);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const response = await this.fetcher(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${this.options.clientId}:${this.options.clientSecret}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!response.ok) throw new PayPalApiError(response.status, null, 'paypal oauth failed');
    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; rawBody?: string; requestId?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.accessToken()}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    };
    if (options.requestId) headers['paypal-request-id'] = options.requestId;
    const response = await this.fetcher(`${this.base}${path}`, {
      method,
      headers,
      body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
    const text = await response.text();
    if (!response.ok) {
      let issue: string | null = null;
      try {
        const data = JSON.parse(text) as { name?: string; details?: { issue?: string }[] };
        issue = data.details?.[0]?.issue ?? data.name ?? null;
      } catch {}
      throw new PayPalApiError(response.status, issue, `paypal ${method} ${path} failed: ${response.status}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

function linkOf(links: { href: string; rel: string }[] | undefined, rel: string): string {
  const href = links?.find((link) => link.rel === rel)?.href;
  if (!href) throw new Error(`paypal response has no ${rel} link`);
  return href;
}
