import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { emailOTP, oneTap } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { grantCredits } from '../credits/ledger';
import type { Db } from '../db/client';
import * as schema from '../db/schema';
import { emailCopy } from '../email/copy';
import type { Mailer } from '../email/mailer';
import type { CoreEnv } from '../env';
import { clientIp, ipBucket } from '../http';
import { consumeQuota, dayWindow, type QuotaRule, releaseQuota } from '../quota/counters';
import type { SiteConfig } from '../site';
import { isDisposableEmail } from './disposable';
import { admitCodeDelivery, admitSignInCode, countCodeRequest, unusableAddress } from './sign-in-codes';

const DAY = 86_400_000;
export const ATTRIBUTION_COOKIE = 'sh_attr';

export interface AuthDeps {
  db: Db;
  env: CoreEnv;
  /** Sends sign-in codes. */
  mailer: Mailer;
  site: SiteConfig;
  baseURL: string;
  log: (message: string, details: Record<string, unknown>) => void;
}

function readAttribution(headers: Headers | undefined) {
  const cookie = headers?.get('cookie') ?? '';
  const raw = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ATTRIBUTION_COOKIE}=`));
  if (!raw) return null;
  try {
    const value = JSON.parse(decodeURIComponent(raw.slice(ATTRIBUTION_COOKIE.length + 1)));
    const pick = (key: string) =>
      typeof value?.[key] === 'string' ? String(value[key]).slice(0, 200) : null;
    return {
      utmSource: pick('utm_source'),
      utmMedium: pick('utm_medium'),
      utmCampaign: pick('utm_campaign'),
      referrer: pick('referrer'),
      landingPath: pick('landing_path'),
    };
  } catch {
    return null;
  }
}

/** Sign-up bonus: verified emails only, once per user, capped per IP and site-wide per day. */
export async function grantSignupBonus(
  deps: Pick<AuthDeps, 'db' | 'site' | 'log'>,
  userId: string,
  headers: Headers | undefined,
) {
  const { bonusCredits, bonusExpiresDays, bonusPerIpDaily, bonusSiteDaily } = deps.site.signup;
  if (bonusCredits <= 0) return;
  const idemKey = `signup:${userId}`;
  const already = await deps.db.query.creditLedger.findFirst({
    where: eq(schema.creditLedger.idemKey, idemKey),
  });
  if (already) return;
  const ip = headers ? clientIp(headers) : null;
  const window = dayWindow();
  // The per-IP cap stops casual repeats; the site-wide cap bounds the cost of farming with fresh emails and rotating IPs.
  const rules: QuotaRule[] = [
    ...(ip ? [{ key: `signup-bonus:ip:${ipBucket(ip)}`, window, limit: bonusPerIpDaily }] : []),
    { key: 'signup-bonus:site', window, limit: bonusSiteDaily },
  ];
  if (!(await consumeQuota(deps.db, rules))) {
    deps.log('signup bonus skipped: daily limit', { userId });
    return;
  }
  const result = await grantCredits(deps.db, {
    userId,
    amount: bonusCredits,
    idemKey,
    source: 'signup',
    expiresAt: bonusExpiresDays == null ? null : Date.now() + bonusExpiresDays * DAY,
  });
  // A concurrent hook for the same user got there first; give back the slots this attempt counted.
  if (!result.applied) await releaseQuota(deps.db, rules);
}

// Without a secret Better Auth silently falls back to a public default (it only refuses when NODE_ENV=production, which dev servers and tests
// don't set), and anyone could then sign session tokens. 32 characters rules out the .env.example placeholder too.
function authSecret(env: CoreEnv): string {
  const secret = env.BETTER_AUTH_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error(
      'BETTER_AUTH_SECRET must be set to at least 32 random characters (e.g. openssl rand -base64 32)',
    );
  }
  return secret;
}

// The one route a visitor asks for a code through; the hook in createAuth applies the sign-in code limits to it.
const SEND_CODE_PATH = '/email-otp/send-verification-otp';

export function createAuth(deps: AuthDeps) {
  const { db, env, site } = deps;
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
      : {};
  // The sign-in code limits protect the sending domain; a mailer that only logs (local development) sends nothing to protect.
  const guarded = !deps.mailer.local;

  return betterAuth({
    appName: site.name,
    baseURL: deps.baseURL,
    secret: authSecret(env),
    // Email change links are signed with the secret and sign the user in; we only use email OTP and Google, so the route stays off.
    // So do the email OTP plugin's password reset routes: no account has a password, and each of them mails codes to accounts and
    // tells an account's address from any other.
    disabledPaths: [
      '/verify-email',
      '/email-otp/request-password-reset',
      '/forget-password/email-otp',
      '/email-otp/reset-password',
    ],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        rateLimit: schema.rateLimit,
      },
    }),
    socialProviders: google,
    account: {
      // Only auto-link Google accounts (Google returns verified emails), so nobody can take over someone else's account with an unverified email.
      accountLinking: { enabled: true, trustedProviders: ['google'] },
    },
    rateLimit: { enabled: true, storage: 'database' },
    advanced: {
      // Keeps cookies separate when several sites run locally at once.
      cookiePrefix: site.id,
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        // Every path that mails a code ends here. Better Auth runs it in the background and answers 200 whatever happens, so a
        // refusal here can only mean not sending. A request for a sign-in code was already checked and counted by the hook below
        // and only the site-wide limit is left; a code on any other path (email change, a server-side call) gets every check.
        async sendVerificationOTP({ email, otp }, ctx) {
          if (guarded) {
            const headers = ctx?.request?.headers ?? ctx?.headers;
            const refused =
              ctx?.path === SEND_CODE_PATH
                ? await admitCodeDelivery(db, email)
                : await admitSignInCode(db, { email, ip: headers ? clientIp(headers) : null });
            if (refused) {
              deps.log('sign-in code not sent', { reason: refused });
              return;
            }
          }
          await deps.mailer.send({
            to: email,
            from: { email: env.EMAIL_FROM, name: site.name },
            ...emailCopy(site.defaultLocale).signInCode({ siteName: site.name, otp }),
          });
        },
      }),
      ...(google.google ? [oneTap()] : []),
    ],
    hooks: {
      // The sign-in code limits a visitor can be told about (auth/sign-in-codes.ts), applied before Better Auth creates a code.
      // Nothing here depends on whether the address has an account, so neither the status nor the message says so.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SEND_CODE_PATH) return;
        const body = ctx.body as { email?: unknown; type?: unknown } | undefined;
        // Sign-in is the only kind of code a site uses. The others would be mailed to accounts only, which tells them apart.
        if (body?.type !== 'sign-in') throw new APIError('BAD_REQUEST', { message: 'Invalid OTP type' });
        // Not a request Better Auth will accept; it answers that itself.
        if (!guarded || typeof body.email !== 'string') return;
        const unusable = unusableAddress(body.email);
        if (unusable === 'disposable')
          throw new APIError('BAD_REQUEST', { message: 'Please use a permanent email address.' });
        if (unusable)
          throw new APIError('BAD_REQUEST', { message: 'Enter an email address you can receive mail at.' });
        const headers = ctx.request?.headers ?? ctx.headers;
        const over = await countCodeRequest(db, {
          email: body.email,
          ip: headers ? clientIp(headers) : null,
        });
        if (over) {
          throw new APIError('TOO_MANY_REQUESTS', {
            message: `Too many sign-in codes requested. Try again later${google.google ? ' or continue with Google' : ''}.`,
          });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          async before(user) {
            if (isDisposableEmail(user.email)) {
              throw new APIError('BAD_REQUEST', { message: 'Please use a permanent email address.' });
            }
          },
          async after(user, context) {
            const headers = context?.request?.headers ?? context?.headers;
            const attribution = readAttribution(headers);
            const ip = headers ? clientIp(headers) : null;
            await db
              .insert(schema.userAttribution)
              .values({ userId: user.id, ...attribution, signupIp: ip })
              .onConflictDoNothing();
            if (user.emailVerified) await grantSignupBonus(deps, user.id, headers);
          },
        },
        update: {
          async after(user, context) {
            if (!user.emailVerified) return;
            await grantSignupBonus(deps, user.id, context?.request?.headers ?? context?.headers);
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
