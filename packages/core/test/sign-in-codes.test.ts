import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../src/auth/server';
import { admitSignInCode, mailboxKey, SIGN_IN_CODE_LIMITS, unusableAddress } from '../src/auth/sign-in-codes';
import { quotaCounters, user, verification } from '../src/db/schema';
import { logMailer, type Mailer } from '../src/email/mailer';
import type { CoreEnv } from '../src/env';
import { defineSite } from '../src/site';
import { db } from './db';

const site = defineSite({
  id: 'test',
  name: 'Test',
  url: 'https://test.example',
  locales: ['en'],
  defaultLocale: 'en',
  products: [],
  signup: { bonusCredits: 0, bonusExpiresDays: null, bonusPerIpDaily: 3, bonusSiteDaily: 100 },
  guest: { dailyPerDevice: 1, dailyPerIp: 3, dailySiteBudget: 100, minRecaptchaScore: 0.5 },
  billing: { provider: 'stripe', automaticTax: false },
});
const env = { BETTER_AUTH_SECRET: 'x'.repeat(32), EMAIL_FROM: 'noreply@test.example' } as unknown as CoreEnv;

// What the mailer stub was asked to deliver, and what the auth log recorded.
let sent: { to: string; code: string }[] = [];
let logged: Record<string, unknown>[] = [];
const sentTo = (email: string) => sent.filter((mail) => mail.to === email);

function authWith(mailer: Mailer) {
  return createAuth({
    db,
    env,
    site,
    baseURL: 'https://test.example',
    log: (_message, details) => logged.push(details),
    mailer,
  });
}
const auth = authWith({
  async send(mail) {
    sent.push({ to: mail.to, code: mail.text.match(/\b\d{6}\b/)?.[0] ?? '' });
  },
});

// Better Auth's own limit is 3 requests a minute per IP and path; a fresh IP per request keeps it out of the way, as rotating IPs do.
let ipSeq = 0;
const freshIp = () => `198.51.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
let seq = 0;
const address = (name = 'someone') => `${name}-${++seq}@inbox.fixture`;

const SEND = '/email-otp/send-verification-otp';

async function post(path: string, body: unknown, ip: string | null = freshIp(), handler = auth.handler) {
  const response = await handler(
    new Request(`https://test.example/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://test.example',
        ...(ip ? { 'cf-connecting-ip': ip } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
  const json = (await response.json().catch(() => null)) as { message?: string; success?: boolean } | null;
  return { status: response.status, message: json?.message, success: json?.success };
}

/** Asks for a sign-in code, as the sign-in form does. */
const ask = (email: string, ip: string | null = freshIp(), handler = auth.handler) =>
  post(SEND, { email, type: 'sign-in' }, ip, handler);

async function customer(email: string) {
  await db.insert(user).values({ id: crypto.randomUUID(), name: 'Customer', email, emailVerified: true });
  return email;
}

async function counter(key: string, window: string) {
  const [row] = await db
    .select({ count: quotaCounters.count })
    .from(quotaCounters)
    .where(and(eq(quotaCounters.key, key), eq(quotaCounters.window, window)));
  return row?.count ?? null;
}

// Each test gets its own UTC day (and so its own hour), so the shared counters start at zero.
let day = 0;
let clock = 0;
function advance(ms: number) {
  clock += ms;
  vi.setSystemTime(clock);
}
const hourNow = () => new Date(clock).toISOString().slice(0, 13);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = Date.UTC(2031, 0, 1 + ++day, 12);
  vi.setSystemTime(clock);
  sent = [];
  logged = [];
});
afterEach(() => vi.useRealTimers());

const HOUR = 3_600_000;
// Better Auth's own limit counts 3 a minute per IP from the last request; requests from one IP are kept further apart than that.
const MINUTE = 61_000;
const { perAddressHourly, perIpDaily, newAddressesHourly, newAddressesDaily } = SIGN_IN_CODE_LIMITS;

describe('addresses that never receive mail', () => {
  it('recognizes reserved names and disposable mailboxes, and nothing else', () => {
    for (const email of [
      'burst-1@example.com',
      'a@EXAMPLE.org',
      'a@mail.example.net',
      'a@anything.test',
      'a@site.invalid',
      'a@box.example',
      'a@printer.local',
      'a@localhost',
      'no-at-sign',
    ]) {
      expect(unusableAddress(email), email).toBe('reserved');
    }
    expect(unusableAddress('a@mailinator.com')).toBe('disposable');
    for (const email of ['a@gmail.com', 'a@examplecompany.com', 'a@test.io', 'a@my-example.com']) {
      expect(unusableAddress(email), email).toBeNull();
    }
  });

  it('are refused with a message, and nothing is sent or counted', async () => {
    const reserved = await ask('probe@example.com');
    expect(reserved.status).toBe(400);
    expect(reserved.message).toMatch(/receive mail/);
    const disposable = await ask('probe@mailinator.com');
    expect(disposable.status).toBe(400);
    expect(disposable.message).toMatch(/permanent email/);
    // An account on a reserved name (a seeded test user, say) gets no code either.
    const seeded = await customer(`seeded-${++seq}@example.com`);
    expect((await ask(seeded)).status).toBe(400);
    expect(sent).toEqual([]);
    expect(await counter(`sign-in-code:to:${await mailboxKey(seeded)}`, hourNow())).toBeNull();
  });

  it('include anything too long to be an address, refused before its domain is looked at', async () => {
    const long = `a@${'b.'.repeat(20_000)}fixture`;
    expect(unusableAddress(long)).toBe('invalid');
    const started = performance.now();
    expect((await ask(long)).status).toBe(400);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(sent).toEqual([]);
  });
});

describe('codes a site does not use', () => {
  it('cannot be asked for: only sign-in codes are mailed', async () => {
    const email = await customer(address('customer'));
    for (const type of ['forget-password', 'email-verification', 'change-email', undefined]) {
      const result = await post(SEND, { email, type });
      expect(result.status, String(type)).toBe(400);
    }
    expect(sent).toEqual([]);
    // The same with a mailer that only logs: the route behaves alike in development.
    const local = authWith(logMailer(() => {}));
    expect((await post(SEND, { email, type: 'forget-password' }, freshIp(), local.handler)).status).toBe(400);
  });

  it('have no password reset routes', async () => {
    const email = await customer(address('customer'));
    for (const [path, body] of [
      ['/email-otp/request-password-reset', { email }],
      ['/forget-password/email-otp', { email }],
      ['/email-otp/reset-password', { email, otp: '123456', password: 'correct horse battery' }],
    ] as const) {
      expect((await post(path, body)).status, path).toBe(404);
    }
    expect(sent).toEqual([]);
  });
});

describe('one mailbox', () => {
  it('maps the spellings of one inbox to one key', async () => {
    const key = await mailboxKey('jane.doe.fixture@gmail.com');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    for (const same of [
      'Jane.Doe.Fixture@Gmail.com',
      'janedoefixture@gmail.com',
      'jane.doe.fixture+news@gmail.com',
      'j.a.n.e.doefixture+1@googlemail.com',
    ]) {
      expect(await mailboxKey(same), same).toBe(key);
    }
    const proton = await mailboxKey('janedoefixture@proton.me');
    for (const same of ['jane.doe_fixture@proton.me', 'Jane-Doe.Fixture+x@proton.me']) {
      expect(await mailboxKey(same), same).toBe(proton);
    }
    // Proton's domains are one account.
    for (const same of [
      'jane-doe.fixture@pm.me',
      'janedoefixture@protonmail.com',
      'janedoe_fixture@protonmail.ch',
    ]) {
      expect(await mailboxKey(same), same).toBe(proton);
    }
    // Other domains keep their punctuation (different people); a +tag is dropped everywhere.
    expect(await mailboxKey('jane.doe@inbox.fixture')).not.toBe(await mailboxKey('janedoe@inbox.fixture'));
    expect(await mailboxKey('jane_doe@gmail.com')).not.toBe(await mailboxKey('janedoe@gmail.com'));
    expect(await mailboxKey('jane+a@inbox.fixture')).toBe(await mailboxKey('jane@inbox.fixture'));
  });

  it('gets a few codes an hour whatever the IP or spelling, then the visitor is told', async () => {
    const tag = ++seq;
    const spellings = (i: number) =>
      [`flood${tag}@gmail.com`, `fl.ood${tag}@gmail.com`, `flood${tag}+${i}@gmail.com`][i % 3]!;
    for (let i = 0; i < perAddressHourly; i++) {
      expect((await ask(spellings(i))).status, `send ${i + 1}`).toBe(200);
    }
    expect(sent).toHaveLength(perAddressHourly);
    // Each request counted once: the hook counts, sending doesn't count again.
    expect(await counter(`sign-in-code:to:${await mailboxKey(spellings(0))}`, hourNow())).toBe(
      perAddressHourly,
    );

    const refused = await ask(spellings(1));
    expect(refused.status).toBe(429);
    expect(refused.message).toMatch(/Too many sign-in codes/);
    expect(sent).toHaveLength(perAddressHourly);

    advance(HOUR);
    expect((await ask(spellings(0))).status).toBe(200);
    expect(sent).toHaveLength(perAddressHourly + 1);
  });

  it('never gets more than the limit from concurrent requests, and every refusal is told', async () => {
    const email = address('race');
    const results = await Promise.all(Array.from({ length: 12 }, () => ask(email)));
    expect(results.filter((result) => result.status === 200)).toHaveLength(perAddressHourly);
    expect(results.filter((result) => result.status === 429)).toHaveLength(12 - perAddressHourly);
    expect(sentTo(email)).toHaveLength(perAddressHourly);
  });

  it('keeps the code already sent working when a further request is refused', async () => {
    const email = address('resend');
    for (let i = 0; i < perAddressHourly; i++) {
      // The clock is frozen in these tests; Better Auth picks the newest code by creation time, so give each its own.
      advance(1000);
      await ask(email);
    }
    const latest = sentTo(email).at(-1)!.code;
    expect(latest).toMatch(/^\d{6}$/);
    // Refused before Better Auth creates a new code, so the last one mailed is still the valid one.
    const codes = () =>
      db
        .select()
        .from(verification)
        .where(eq(verification.identifier, `sign-in-otp-${email}`));
    const before = await codes();
    expect(before.length).toBeGreaterThan(0);
    advance(1000);
    expect((await ask(email)).status).toBe(429);
    expect(await codes()).toEqual(before);
    expect((await post('/sign-in/email-otp', { email, otp: latest })).status).toBe(200);
  });
});

describe('whether an address has an account', () => {
  // The same requests for an address with an account and one without: the answers must not differ, only the mail does.
  const repeated = async (email: string) => {
    const statuses: number[] = [];
    for (let i = 0; i < perAddressHourly + 2; i++) {
      advance(1000);
      statuses.push((await ask(email)).status);
    }
    return statuses;
  };
  const limited = [...Array(perAddressHourly).fill(200), 429, 429];
  const exhaustSiteLimit = async () => {
    for (let i = 0; i < newAddressesHourly; i++) await ask(address('filler'));
  };

  it('does not show in the answers to repeated requests', async () => {
    const known = await customer(address('known'));
    const unknown = address('unknown');
    expect(await repeated(known)).toEqual(limited);
    expect(await repeated(unknown)).toEqual(limited);
    expect(sentTo(known)).toHaveLength(perAddressHourly);
    expect(sentTo(unknown)).toHaveLength(perAddressHourly);
  });

  it('does not show once the site-wide limit is used up: not in the answers, not in what checking a code says', async () => {
    await exhaustSiteLimit();
    const known = await customer(address('known'));
    const unknown = address('unknown');
    expect(await repeated(known)).toEqual(limited);
    expect(await repeated(unknown)).toEqual(limited);
    expect(sentTo(known)).toHaveLength(perAddressHourly);
    expect(sentTo(unknown)).toHaveLength(0);

    // A code exists for both, mailed or not, so guessing at it is answered alike (wrong code, then too many attempts).
    const guesses = async (email: string, path: string, body: Record<string, unknown>) => {
      const mailed = sentTo(email).at(-1)?.code;
      const otp = mailed === '000000' ? '111111' : '000000';
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await post(path, { email, otp, ...body })).status);
      return statuses;
    };
    const check = ['/email-otp/check-verification-otp', { type: 'sign-in' }] as const;
    expect(await guesses(unknown, ...check)).toEqual(await guesses(known, ...check));
  });
});

describe('one IP', () => {
  it('can ask for a bounded number of codes a day, across addresses', async () => {
    // Customers, so the site-wide limit for new addresses stays out of this test.
    const ip = '203.0.113.77';
    for (let i = 0; i < perIpDaily; i++) {
      advance(MINUTE);
      expect((await ask(await customer(address('office')), ip)).status, `send ${i + 1}`).toBe(200);
    }
    advance(MINUTE);
    const blocked = await customer(address('office'));
    const refused = await ask(blocked, ip);
    expect(refused.status).toBe(429);
    expect(refused.message).toMatch(/Too many sign-in codes/);
    expect(sent).toHaveLength(perIpDaily);
    // The refused request never touched the counter of the mailbox it asked for: no row is left behind.
    expect(await counter(`sign-in-code:to:${await mailboxKey(blocked)}`, hourNow())).toBeNull();
    // Another IP is unaffected.
    expect((await ask(blocked)).status).toBe(200);
  });

  it('shares a limit across an IPv6 /64', async () => {
    for (let i = 0; i < perIpDaily; i++) {
      advance(MINUTE);
      await ask(await customer(address('v6')), `2001:db8:1:2::${(i + 1).toString(16)}`);
    }
    expect(sent).toHaveLength(perIpDaily);
    advance(MINUTE);
    const refused = await ask(await customer(address('v6')), '2001:db8:1:2:ffff::1');
    expect(refused.status).toBe(429);
    expect(refused.message).toMatch(/Too many sign-in codes/);
    advance(MINUTE);
    expect((await ask(await customer(address('v6')), '2001:db8:1:3::1')).status).toBe(200);
  });
});

describe('addresses without an account, site-wide', () => {
  it('stop being mailed at the hourly limit while customers still get their codes', async () => {
    for (let i = 0; i < newAddressesHourly; i++) {
      expect((await ask(address('new'))).status).toBe(200);
    }
    expect(sent).toHaveLength(newAddressesHourly);

    // Over the limit: answered like any other request, and no mail goes out.
    const dropped = address('new');
    expect(await ask(dropped)).toMatchObject({ status: 200, success: true });
    expect(sentTo(dropped)).toHaveLength(0);
    expect(logged.at(-1)).toEqual({ reason: 'site-limit' });

    const known = await customer(address('customer'));
    expect(await ask(known)).toMatchObject({ status: 200, success: true });
    expect(sentTo(known)).toHaveLength(1);

    advance(HOUR);
    expect((await ask(dropped)).status).toBe(200);
    expect(sentTo(dropped)).toHaveLength(1);
  });

  it('stop at the daily limit even when spread over hours', async () => {
    const hours = Math.ceil(newAddressesDaily / newAddressesHourly);
    // Start at midnight so every hour used here is in the same UTC day.
    advance(-12 * HOUR);
    for (let hour = 0; hour < hours; hour++) {
      for (let i = 0; i < newAddressesHourly; i++) await ask(address('spread'));
      advance(HOUR);
    }
    expect(sent).toHaveLength(newAddressesDaily);
    await ask(address('spread'));
    expect(sent).toHaveLength(newAddressesDaily);
    advance(24 * HOUR);
    await ask(address('next-day'));
    expect(sent).toHaveLength(newAddressesDaily + 1);
  });

  it('never exceed the hourly limit under concurrent requests from different IPs', async () => {
    const results = await Promise.all(
      Array.from({ length: newAddressesHourly + 15 }, () => ask(address('burst'))),
    );
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(sent).toHaveLength(newAddressesHourly);
  });

  it('apply when the request carries no client IP', async () => {
    for (let i = 0; i < newAddressesHourly + 2; i++) {
      // Better Auth counts requests without an IP together; keep them more than a minute apart.
      advance(MINUTE);
      await ask(address('no-ip'), null);
    }
    expect(sent).toHaveLength(newAddressesHourly);
  });
});

describe('a send that fails', () => {
  it('keeps its count, so retrying a bouncing address is still bounded', async () => {
    const failing = authWith({
      async send(mail) {
        sent.push({ to: mail.to, code: '' });
        throw new Error(`email to ${mail.to} bounced or is suppressed`);
      },
    });
    const email = address('bounces');
    for (let i = 0; i < perAddressHourly; i++) {
      expect((await ask(email, freshIp(), failing.handler)).status).toBe(200);
    }
    expect((await ask(email, freshIp(), failing.handler)).status).toBe(429);
    expect(sentTo(email)).toHaveLength(perAddressHourly);
  });
});

describe('a mailer that only logs (local development)', () => {
  it('is not limited and accepts placeholder addresses', async () => {
    const local = authWith(logMailer((_message, details) => sent.push({ to: String(details.to), code: '' })));
    for (let i = 0; i < perAddressHourly + 2; i++) {
      expect((await ask('dev@example.com', freshIp(), local.handler)).status).toBe(200);
    }
    expect(sentTo('dev@example.com')).toHaveLength(perAddressHourly + 2);
  });
});

describe('a code mailed outside the request routes (email change, a server-side call)', () => {
  it('goes through every check at the point of sending', async () => {
    const now = () => clock;
    expect(await admitSignInCode(db, { email: `${'a'.repeat(300)}@inbox.fixture`, ip: null }, now())).toBe(
      'invalid',
    );
    expect(await admitSignInCode(db, { email: 'a@example.com', ip: null }, now())).toBe('reserved');
    expect(await admitSignInCode(db, { email: 'a@mailinator.com', ip: null }, now())).toBe('disposable');

    const email = address('change');
    for (let i = 0; i < perAddressHourly; i++) {
      expect(await admitSignInCode(db, { email, ip: '203.0.113.5' }, now())).toBeNull();
    }
    expect(await admitSignInCode(db, { email, ip: '203.0.113.6' }, now())).toBe('request-limit');

    for (let i = perAddressHourly; i < newAddressesHourly; i++) {
      expect(await admitSignInCode(db, { email: address('change'), ip: null }, now())).toBeNull();
    }
    expect(await admitSignInCode(db, { email: address('change'), ip: null }, now())).toBe('site-limit');
    expect(
      await admitSignInCode(db, { email: await customer(address('known')), ip: null }, now()),
    ).toBeNull();
  });
});

describe('counters', () => {
  it('from before yesterday are dropped as requests come in, and only this feature’s', async () => {
    const dayOf = (offset: number) => new Date(clock + offset * 24 * HOUR).toISOString().slice(0, 10);
    const tag = crypto.randomUUID();
    const rows = [
      { key: `sign-in-code:to:${tag}`, window: `${dayOf(-3)}T09`, count: 4 },
      { key: `sign-in-code:ip:${tag}`, window: dayOf(-2), count: 9 },
      { key: `sign-in-code:ip:${tag}`, window: dayOf(-1), count: 9 },
      { key: `upload:ip:${tag}`, window: dayOf(-3), count: 2 },
    ];
    await db.insert(quotaCounters).values(rows);
    await ask(address('prune'));
    const left = await Promise.all(rows.map((row) => counter(row.key, row.window)));
    // Gone: the two older than yesterday. Kept: yesterday's, and another feature's counter of any age.
    expect(left).toEqual([null, null, 9, 2]);
  });
});
