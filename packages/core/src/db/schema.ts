import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(cast(unixepoch('subsec') * 1000 as integer))`;
const createdAt = () => integer('created_at', { mode: 'number' }).notNull().default(now);
const updatedAt = () => integer('updated_at', { mode: 'number' }).notNull().default(now);

// ---- Better Auth core tables (field names follow Better Auth conventions, columns are snake_case) ----

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

/** Sign-up attribution: first landing page and UTM, written once at sign-up. */
export const userAttribution = sqliteTable('user_attribution', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  utmSource: text('utm_source'),
  utmMedium: text('utm_medium'),
  utmCampaign: text('utm_campaign'),
  referrer: text('referrer'),
  landingPath: text('landing_path'),
  signupIp: text('signup_ip'),
  createdAt: createdAt(),
});

// ---- Credit ledger ----
// Balance = sum of remaining over unexpired lots - debt. Every write happens in one D1 batch;
// concurrency is handled by a per-user version optimistic lock (see credits/ledger.ts), with CHECK constraints (never negative) as a backstop.

export const creditAccounts = sqliteTable(
  'credit_accounts',
  {
    userId: text('user_id').primaryKey(),
    /** Amount a refund or chargeback clawback couldn't take from lots; later grants repay this first. */
    debt: integer('debt').notNull().default(0),
    /** Optimistic lock version: incremented on every ledger write; if another operation slips in between read and write, the batch rolls back and retries. */
    version: integer('version').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [check('credit_accounts_debt_nonneg', sql`${t.debt} >= 0`)],
);

export const creditLots = sqliteTable(
  'credit_lots',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    source: text('source').notNull(),
    sourceRef: text('source_ref'),
    amount: integer('amount').notNull(),
    remaining: integer('remaining').notNull(),
    /** Millisecond timestamp; null means never expires. Expiry is checked on read, no cron job. */
    expiresAt: integer('expires_at', { mode: 'number' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('credit_lots_user_idx').on(t.userId, t.expiresAt),
    check('credit_lots_amount_pos', sql`${t.amount} > 0`),
    check('credit_lots_remaining_range', sql`${t.remaining} >= 0 and ${t.remaining} <= ${t.amount}`),
  ],
);

export const creditLedger = sqliteTable(
  'credit_ledger',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    kind: text('kind', { enum: ['grant', 'spend', 'refund', 'revoke'] }).notNull(),
    /** Net effect on balance: positive for grants, negative for charges and clawbacks. */
    delta: integer('delta').notNull(),
    /** Change to debt from this entry: positive when a clawback falls short, negative when a grant repays debt. */
    debtDelta: integer('debt_delta').notNull().default(0),
    idemKey: text('idem_key').notNull(),
    ref: text('ref'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('credit_ledger_idem_uq').on(t.idemKey), index('credit_ledger_user_idx').on(t.userId)],
);

/** How much each charge or clawback took from which lots, so refunded charges go back to the original lots. */
export const creditAllocations = sqliteTable(
  'credit_allocations',
  {
    ledgerId: text('ledger_id').notNull(),
    lotId: text('lot_id').notNull(),
    amount: integer('amount').notNull(),
  },
  (t) => [primaryKey({ columns: [t.ledgerId, t.lotId] })],
);

// ---- Billing ----

export const billingCustomers = sqliteTable(
  'billing_customers',
  {
    userId: text('user_id').notNull(),
    provider: text('provider').notNull(),
    customerRef: text('customer_ref').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.provider] }),
    uniqueIndex('billing_customers_ref_uq').on(t.provider, t.customerRef),
  ],
);

/** One row per checkout started. Status is only for display and reconciliation; granting credits doesn't depend on it. */
export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    productId: text('product_id').notNull(),
    provider: text('provider').notNull(),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    status: text('status', { enum: ['pending', 'paid'] })
      .notNull()
      .default('pending'),
    checkoutRef: text('checkout_ref'),
    createdAt: createdAt(),
    paidAt: integer('paid_at', { mode: 'number' }),
  },
  (t) => [index('orders_user_idx').on(t.userId, t.createdAt)],
);

/** One row per payment received: a one-time payment, or one subscription period. */
export const payments = sqliteTable(
  'payments',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    /** Provider's key for this payment: PaymentIntent for Stripe one-time payments, Invoice for subscriptions. */
    paymentRef: text('payment_ref').notNull(),
    /** Reference used by refund and chargeback events to find this payment: always the PaymentIntent for Stripe. */
    chargeRef: text('charge_ref'),
    userId: text('user_id').notNull(),
    orderId: text('order_id'),
    subscriptionRef: text('subscription_ref'),
    productId: text('product_id').notNull(),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    amountRefunded: integer('amount_refunded').notNull().default(0),
    disputeStatus: text('dispute_status', { enum: ['open', 'won', 'lost'] }),
    creditsGranted: integer('credits_granted').notNull().default(0),
    /** Credits already clawed back for refunds or chargebacks; adjustSeq increments on each adjustment and is part of the idempotency key. */
    creditsRevoked: integer('credits_revoked').notNull().default(0),
    adjustSeq: integer('adjust_seq').notNull().default(0),
    periodStart: integer('period_start', { mode: 'number' }),
    periodEnd: integer('period_end', { mode: 'number' }),
    /** When the provider state was fetched; only newer snapshots are accepted. */
    fetchedAt: integer('fetched_at', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payments_ref_uq').on(t.provider, t.paymentRef),
    index('payments_charge_idx').on(t.provider, t.chargeRef),
    index('payments_user_idx').on(t.userId),
  ],
);

export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    subscriptionRef: text('subscription_ref').notNull(),
    userId: text('user_id').notNull(),
    productId: text('product_id').notNull(),
    status: text('status').notNull(),
    currentPeriodStart: integer('current_period_start', { mode: 'number' }),
    currentPeriodEnd: integer('current_period_end', { mode: 'number' }),
    cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' }).notNull().default(false),
    /** When the provider state was fetched; only newer snapshots are accepted, so concurrent webhooks can't overwrite new state with old. */
    fetchedAt: integer('fetched_at', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('subscriptions_ref_uq').on(t.provider, t.subscriptionRef),
    index('subscriptions_user_idx').on(t.userId),
  ],
);

export const webhookEvents = sqliteTable(
  'webhook_events',
  {
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    processedAt: integer('processed_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.eventId] })],
);

// ---- Quota counters ----

export const quotaCounters = sqliteTable(
  'quota_counters',
  {
    key: text('key').notNull(),
    window: text('window').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.window] })],
);

/** Better Auth rate-limit counters. Workers are stateless and in-memory limits don't work, so they live in the database. */
export const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request', { mode: 'number' }).notNull(),
});
