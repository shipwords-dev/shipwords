import { env as workerEnv } from 'cloudflare:workers';
import { createAuth } from './auth/server';
import {
  activeSubscription,
  type BillingDeps,
  handleCheckout,
  handlePortal,
  handleReceipt,
  handleSyncOrder,
  handleWebhook,
  recentOrders,
  type SessionUser,
} from './billing/handlers';
import { PayPalProvider } from './billing/paypal';
import type { PaymentProvider } from './billing/provider';
import { StripeProvider } from './billing/stripe';
import { getBalance } from './credits/ledger';
import { createDb, type Db } from './db/client';
import type { CoreEnv } from './env';
import { errorResponse, json } from './http';
import { authorizeGuest } from './quota/guest';
import type { SiteConfig } from './site';

// Server entry for a site: call createCore(site) once in src/core.server.ts,
// and keep route files as thin forwarders, e.g. POST: ({ request }) => core.billing.checkout(request).

export type Logger = (message: string, details: Record<string, unknown>) => void;

const defaultLog: Logger = (message, details) =>
  console.log(JSON.stringify({ level: 'info', message, ...details }));

function required(env: CoreEnv, name: keyof CoreEnv): string {
  const value = env[name];
  if (typeof value !== 'string' || !value) throw new Error(`missing env ${name}`);
  return value;
}

function createProvider(site: SiteConfig, env: CoreEnv): PaymentProvider {
  if (site.billing.provider === 'paypal') {
    return new PayPalProvider({
      clientId: required(env, 'PAYPAL_CLIENT_ID'),
      clientSecret: required(env, 'PAYPAL_CLIENT_SECRET'),
      // The webhook ID only exists once the webhook is created, so it's checked only when verifying signatures; a missing one doesn't block sign-in or checkout.
      webhookId: env.PAYPAL_WEBHOOK_ID ?? '',
      sandbox: env.PAYPAL_ENV === 'sandbox',
      products: site.products,
    });
  }
  return new StripeProvider({
    secretKey: required(env, 'STRIPE_SECRET_KEY'),
    webhookSecret: required(env, 'STRIPE_WEBHOOK_SECRET'),
    automaticTax: site.billing.automaticTax,
  });
}

export function createCore(site: SiteConfig, options: { log?: Logger } = {}) {
  const log = options.log ?? defaultLog;
  // env doesn't change within an isolate, so dependent objects are created lazily once and reused.
  let cached: {
    env: CoreEnv;
    db: Db;
    baseURL: string;
    auth: ReturnType<typeof createAuth>;
    billing: BillingDeps;
  } | null = null;

  function context() {
    if (cached) return cached;
    const env = workerEnv as unknown as CoreEnv;
    const db = createDb(required(env, 'DATABASE_URL'));
    const baseURL = (env.APP_URL ?? site.url).replace(/\/$/, '');
    const auth = createAuth({ db, env, site, baseURL, log });
    const getUser = async (request: Request): Promise<SessionUser | null> => {
      const session = await auth.api.getSession({ headers: request.headers });
      return session ? { id: session.user.id, email: session.user.email, name: session.user.name } : null;
    };
    const provider = createProvider(site, env);
    cached = { env, db, baseURL, auth, billing: { db, site, provider, baseURL, getUser, log } };
    return cached;
  }

  return {
    site,
    log,
    get env() {
      return context().env;
    },
    get db() {
      return context().db;
    },
    get auth() {
      return context().auth;
    },
    getUser: (request: Request) => context().billing.getUser(request),

    /** /api/auth/* is handled by Better Auth. */
    handleAuth: (request: Request) => context().auth.handler(request),

    billing: {
      checkout: (request: Request) => handleCheckout(context().billing, request),
      sync: (request: Request) => handleSyncOrder(context().billing, request),
      portal: (request: Request) => handlePortal(context().billing, request),
      receipt: (request: Request) => handleReceipt(context().billing, request),
      webhook: (request: Request) => handleWebhook(context().billing, request),
      /** GET: current user's balance, subscription and recent orders. */
      async me(request: Request) {
        const { db, billing } = context();
        const user = await billing.getUser(request);
        if (!user) return errorResponse(401, 'unauthorized');
        const [balance, subscription, orders] = await Promise.all([
          getBalance(db, user.id),
          activeSubscription(db, user.id),
          recentOrders(db, user.id),
        ]);
        return json({ user, balance, subscription, orders });
      },
    },

    guest: {
      /** Call before a guest's free generation; on success one unit is already consumed, so call releaseQuota if submission fails later. */
      authorize(request: Request, recaptchaToken: string | null | undefined, action: string) {
        const { db, env } = context();
        return authorizeGuest({
          db,
          request,
          siteId: site.id,
          quota: site.guest,
          recaptcha: {
            siteKey: env.RECAPTCHA_SITE_KEY,
            projectId: env.RECAPTCHA_PROJECT_ID,
            apiKey: env.RECAPTCHA_API_KEY,
          },
          recaptchaToken,
          action,
          cookieSecret: env.GUEST_COOKIE_SECRET,
        });
      },
    },
  };
}

export type Core = ReturnType<typeof createCore>;
