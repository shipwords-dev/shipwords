import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Epoch milliseconds, the unit every business timestamp uses. clock_timestamp so rows written in one transaction still differ. */
export const nowMs = sql`((extract(epoch from clock_timestamp()) * 1000)::bigint)`;
/** Epoch milliseconds as a JS number (fits until year 275760). */
const ms = (name: string) => bigint(name, { mode: 'number' });
const createdAt = () => ms('created_at').notNull().default(nowMs);
const updatedAt = () => ms('updated_at').notNull().default(nowMs);
/** Better Auth reads and writes Date objects. */
const authTime = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ---- Better Auth core tables (field names follow Better Auth conventions, columns are snake_case) ----

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: authTime('created_at').notNull().defaultNow(),
  updatedAt: authTime('updated_at').notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: authTime('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: authTime('created_at').notNull().defaultNow(),
    updatedAt: authTime('updated_at').notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

export const account = pgTable(
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
    accessTokenExpiresAt: authTime('access_token_expires_at'),
    refreshTokenExpiresAt: authTime('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: authTime('created_at').notNull().defaultNow(),
    updatedAt: authTime('updated_at').notNull().defaultNow(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: authTime('expires_at').notNull(),
    createdAt: authTime('created_at').notNull().defaultNow(),
    updatedAt: authTime('updated_at').notNull().defaultNow(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

/** Sign-up attribution: first landing page and UTM, written once at sign-up. */
export const userAttribution = pgTable('user_attribution', {
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
// Balance = sum of remaining over unexpired lots - debt. Every operation is one transaction that first locks the user's
// credit_accounts row (see credits/ledger.ts), so one user's ledger writes run one at a time; CHECK constraints (never negative) are the backstop.

export const creditAccounts = pgTable(
  'credit_accounts',
  {
    userId: text('user_id').primaryKey(),
    /** Amount a refund or chargeback clawback couldn't take from lots; later grants repay this first. */
    debt: integer('debt').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [check('credit_accounts_debt_nonneg', sql`${t.debt} >= 0`)],
);

export const creditLots = pgTable(
  'credit_lots',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    source: text('source').notNull(),
    sourceRef: text('source_ref'),
    amount: integer('amount').notNull(),
    remaining: integer('remaining').notNull(),
    /** Millisecond timestamp; null means never expires. Expiry is checked on read, no cron job. */
    expiresAt: ms('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('credit_lots_user_idx').on(t.userId, t.expiresAt),
    check('credit_lots_amount_pos', sql`${t.amount} > 0`),
    check('credit_lots_remaining_range', sql`${t.remaining} >= 0 and ${t.remaining} <= ${t.amount}`),
  ],
);

export const creditLedger = pgTable(
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
export const creditAllocations = pgTable(
  'credit_allocations',
  {
    ledgerId: text('ledger_id').notNull(),
    lotId: text('lot_id').notNull(),
    amount: integer('amount').notNull(),
  },
  (t) => [primaryKey({ columns: [t.ledgerId, t.lotId] })],
);

// ---- Billing ----

export const billingCustomers = pgTable(
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
export const orders = pgTable(
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
    paidAt: ms('paid_at'),
  },
  (t) => [index('orders_user_idx').on(t.userId, t.createdAt)],
);

/** One row per payment received: a one-time payment, or one subscription period. */
export const payments = pgTable(
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
    periodStart: ms('period_start'),
    periodEnd: ms('period_end'),
    /** When the provider state was fetched; only newer snapshots are accepted. */
    fetchedAt: ms('fetched_at').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payments_ref_uq').on(t.provider, t.paymentRef),
    index('payments_charge_idx').on(t.provider, t.chargeRef),
    index('payments_user_idx').on(t.userId),
  ],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    subscriptionRef: text('subscription_ref').notNull(),
    userId: text('user_id').notNull(),
    productId: text('product_id').notNull(),
    status: text('status').notNull(),
    currentPeriodStart: ms('current_period_start'),
    currentPeriodEnd: ms('current_period_end'),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    /** When the provider state was fetched; only newer snapshots are accepted, so concurrent webhooks can't overwrite new state with old. */
    fetchedAt: ms('fetched_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('subscriptions_ref_uq').on(t.provider, t.subscriptionRef),
    index('subscriptions_user_idx').on(t.userId),
  ],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    processedAt: ms('processed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.eventId] })],
);

// ---- Quota counters ----

export const quotaCounters = pgTable(
  'quota_counters',
  {
    key: text('key').notNull(),
    window: text('window').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.window] })],
);

/** Better Auth rate-limit counters. Workers are stateless and in-memory limits don't work, so they live in the database. */
export const rateLimit = pgTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: ms('last_request').notNull(),
});
