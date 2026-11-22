import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { user } from '../db/schema';
import { ipBucket } from '../http';
import { consumeQuota, dayWindow, hourWindow, pruneQuota, type QuotaRule } from '../quota/counters';
import { isDisposableEmail } from './disposable';

// Who may be sent a sign-in code. Anyone can ask for a code to any address, so without limits a script can flood one mailbox or send
// hundreds of codes to addresses that bounce, and the mail provider then throttles or suspends the sending domain: sign-in codes and
// job emails stop for every user. Better Auth's own rate limit counts per IP and path, which rotating IPs walk around.
//
// Two kinds of limit, kept apart on purpose:
// - Per mailbox and per IP, counted for every request before Better Auth looks at it, whether or not the address has an account. The
//   visitor is told (429), and since nothing was created yet, a code already in their inbox keeps working. Counting every request the
//   same way is what keeps the answer from revealing which addresses have accounts.
// - Site-wide, for codes to addresses without an account, checked when the code is about to be mailed. Past it the request has
//   already been answered like any other and the code is simply not sent.

export const SIGN_IN_CODE_LIMITS = {
  /** Requests for one mailbox per hour: room for a few resends, never a flood into someone's inbox. */
  perAddressHourly: 5,
  /** Requests from one IP (a /64 for IPv6) per UTC day, whatever the addresses. */
  perIpDaily: 30,
  /**
   * Codes per hour and per UTC day, site-wide, to addresses that have no account yet. This is what bounds the bounces a script with
   * fresh addresses and rotating IPs can cause. Addresses with an account don't count, so customers can always sign in.
   */
  newAddressesHourly: 20,
  newAddressesDaily: 60,
};

const KEY_PREFIX = 'sign-in-code:';
const DAY = 86_400_000;

// RFC 2606 and RFC 6761 names that never receive mail, plus .local (mDNS).
const RESERVED_TLDS = new Set(['example', 'invalid', 'local', 'localhost', 'test']);
const RESERVED_DOMAINS = new Set(['example.com', 'example.net', 'example.org']);
// RFC 5321: a path is at most 256 octets with its angle brackets.
const MAX_ADDRESS_LENGTH = 254;

/**
 * Why an address can't be sent a code, or null when it can: too long to be one, a reserved name that never receives mail, or a
 * disposable mailbox. Safe on unvalidated input: the length is checked before anything walks the domain.
 */
export function unusableAddress(email: string): 'invalid' | 'reserved' | 'disposable' | null {
  if (email.length > MAX_ADDRESS_LENGTH) return 'invalid';
  const host = email.trim().toLowerCase().split('@')[1] ?? '';
  const labels = host.split('.');
  // A single label (user@localhost) is not a public mail domain either.
  if (labels.length < 2 || RESERVED_TLDS.has(labels.at(-1)!)) return 'reserved';
  if (RESERVED_DOMAINS.has(labels.slice(-2).join('.'))) return 'reserved';
  return isDisposableEmail(email) ? 'disposable' : null;
}

// Providers that document which spellings reach one mailbox: the domains that are the same account, and the characters of the
// local part they ignore. Other domains keep their punctuation: dropping it everywhere would merge different people's mailboxes.
const SAME_MAILBOX: Record<string, { domain: string; ignored: RegExp }> = {
  'gmail.com': { domain: 'gmail.com', ignored: /\./g },
  'googlemail.com': { domain: 'gmail.com', ignored: /\./g },
  'proton.me': { domain: 'proton.me', ignored: /[._-]/g },
  'protonmail.com': { domain: 'proton.me', ignored: /[._-]/g },
  'protonmail.ch': { domain: 'proton.me', ignored: /[._-]/g },
  'pm.me': { domain: 'proton.me', ignored: /[._-]/g },
};

/**
 * One key per mailbox, so the per-address limit can't be dodged with spellings that land in the same inbox: case, a +tag, and what
 * Gmail and Proton ignore. A +tag is dropped for every domain: the few mail systems where it names a separate mailbox then share a
 * limit, which costs far less than letting one inbox be flooded through tags. Hashed, so the counters table holds no addresses.
 */
export async function mailboxKey(email: string): Promise<string> {
  const [local = '', host = ''] = email.trim().toLowerCase().split('@');
  const untagged = local.split('+')[0] ?? '';
  const same = SAME_MAILBOX[host];
  const mailbox = same ? `${untagged.replace(same.ignored, '')}@${same.domain}` : `${untagged}@${host}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(mailbox));
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export interface CodeRequest {
  email: string;
  ip: string | null;
}

/** The IP's rule first: a request refused for its IP then never touches (or creates) the mailbox's counter. */
async function requestRules(request: CodeRequest, now: number): Promise<QuotaRule[]> {
  return [
    ...(request.ip
      ? [
          {
            key: `${KEY_PREFIX}ip:${ipBucket(request.ip)}`,
            window: dayWindow(now),
            limit: SIGN_IN_CODE_LIMITS.perIpDaily,
          },
        ]
      : []),
    {
      key: `${KEY_PREFIX}to:${await mailboxKey(request.email)}`,
      window: hourWindow(now),
      limit: SIGN_IN_CODE_LIMITS.perAddressHourly,
    },
  ];
}

// Counters from before yesterday are dropped once an hour (per process), so a flood of requests doesn't leave rows behind for good.
let prunedHour = '';
async function pruneOld(db: Db, now: number): Promise<void> {
  const hour = hourWindow(now);
  if (hour === prunedHour) return;
  prunedHour = hour;
  await pruneQuota(db, KEY_PREFIX, dayWindow(now - DAY));
}

/**
 * Counts one request for a code against the IP and the mailbox: 'request-limit' when either is used up. Call it for every request,
 * before anything depends on whether the address has an account.
 */
export async function countCodeRequest(
  db: Db,
  request: CodeRequest,
  now = Date.now(),
): Promise<'request-limit' | null> {
  await pruneOld(db, now);
  return (await consumeQuota(db, await requestRules(request, now))) ? null : 'request-limit';
}

/** Whether an address belongs to an account. Better Auth stores and looks up emails lowercased. */
async function hasAccount(db: Db, email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email.toLowerCase()))
    .limit(1);
  return Boolean(row);
}

/**
 * Whether a code about to be mailed fits the site-wide limits: 'site-limit' when the address has no account and they are used up.
 * Counts one code to a new address.
 */
export async function admitCodeDelivery(
  db: Db,
  email: string,
  now = Date.now(),
): Promise<'site-limit' | null> {
  if (await hasAccount(db, email)) return null;
  const admitted = await consumeQuota(db, [
    { key: `${KEY_PREFIX}new:hour`, window: hourWindow(now), limit: SIGN_IN_CODE_LIMITS.newAddressesHourly },
    { key: `${KEY_PREFIX}new:day`, window: dayWindow(now), limit: SIGN_IN_CODE_LIMITS.newAddressesDaily },
  ]);
  return admitted ? null : 'site-limit';
}

export type SignInCodeRefusal = 'invalid' | 'reserved' | 'disposable' | 'request-limit' | 'site-limit';

/**
 * Every check at once, for a code about to be mailed on a path the request hook doesn't cover (see createAuth): nothing can be said
 * to the visitor there, so a refused code is simply not sent.
 */
export async function admitSignInCode(
  db: Db,
  request: CodeRequest,
  now = Date.now(),
): Promise<SignInCodeRefusal | null> {
  return (
    unusableAddress(request.email) ??
    (await countCodeRequest(db, request, now)) ??
    (await admitCodeDelivery(db, request.email, now))
  );
}
