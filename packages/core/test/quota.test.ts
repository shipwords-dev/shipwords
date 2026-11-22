import { describe, expect, it } from 'vitest';
import { isDisposableEmail } from '../src/auth/disposable';
import { ipBucket, safeRelativePath } from '../src/http';
import { consumeQuota, releaseQuota } from '../src/quota/counters';
import { authorizeGuest, readGuestId } from '../src/quota/guest';
import { verifyRecaptcha } from '../src/quota/recaptcha';
import { db } from './db';

const recaptcha = { siteKey: 'site', projectId: 'proj', apiKey: 'key' };
const quota = { dailyPerDevice: 2, dailyPerIp: 3, dailySiteBudget: 100, minRecaptchaScore: 0.5 };

function assessment(score: number, action = 'generate', valid = true): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ tokenProperties: { valid, action }, riskAnalysis: { score } }), {
      status: 200,
    });
}

describe('quota counters', () => {
  it('rejects at the limit and rolls back counts added in the same request', async () => {
    const key = crypto.randomUUID();
    const a = { key: `a:${key}`, window: 'w', limit: 5 };
    const b = { key: `b:${key}`, window: 'w', limit: 1 };
    expect(await consumeQuota(db, [a, b])).toBe(true);
    expect(await consumeQuota(db, [a, b])).toBe(false);
    // The second a was rolled back, so a can still be used 4 more times.
    for (let i = 0; i < 4; i++) expect(await consumeQuota(db, [a])).toBe(true);
    expect(await consumeQuota(db, [a])).toBe(false);
    await releaseQuota(db, [a]);
    expect(await consumeQuota(db, [a])).toBe(true);
  });

  it('never exceeds the limit under concurrency', async () => {
    const rule = { key: `c:${crypto.randomUUID()}`, window: 'w', limit: 3 };
    const results = await Promise.all(Array.from({ length: 8 }, () => consumeQuota(db, [rule])));
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it('rolls back earlier counts when a later write throws', async () => {
    const a = { key: `t:${crypto.randomUUID()}`, window: 'w', limit: 1 };
    // A null key violates NOT NULL, so the second write throws after the first one counted.
    const broken = { key: null as unknown as string, window: 'w', limit: 1 };
    await expect(consumeQuota(db, [a, broken])).rejects.toThrow();
    // a was rolled back, so its only slot is still free.
    expect(await consumeQuota(db, [a])).toBe(true);
  });

  it('rejects immediately when the limit is 0', async () => {
    expect(await consumeQuota(db, [{ key: 'zero', window: 'w', limit: 0 }])).toBe(false);
  });
});

describe('reCAPTCHA', () => {
  it('score, action and token validity must all pass', async () => {
    expect(await verifyRecaptcha(recaptcha, 't', 'generate', 0.5, assessment(0.9))).toEqual({
      ok: true,
      score: 0.9,
    });
    expect(await verifyRecaptcha(recaptcha, 't', 'generate', 0.5, assessment(0.1))).toMatchObject({
      reason: 'low_score',
    });
    expect(await verifyRecaptcha(recaptcha, 't', 'generate', 0.5, assessment(0.9, 'login'))).toMatchObject({
      reason: 'action_mismatch',
    });
    expect(
      await verifyRecaptcha(recaptcha, 't', 'generate', 0.5, assessment(0.9, 'generate', false)),
    ).toMatchObject({
      reason: 'invalid_token',
    });
    expect(await verifyRecaptcha(recaptcha, null, 'generate', 0.5, assessment(0.9))).toMatchObject({
      reason: 'missing_token',
    });
    const down: typeof fetch = async () => new Response('', { status: 503 });
    expect(await verifyRecaptcha(recaptcha, 't', 'generate', 0.5, down)).toMatchObject({
      reason: 'unavailable',
    });
  });
});

describe('guest trial', () => {
  const request = (cookie?: string, ip = '203.0.113.7') =>
    new Request('https://test.example/api/jobs', {
      headers: { 'cf-connecting-ip': ip, ...(cookie ? { cookie } : {}) },
    });
  const base = {
    db,
    siteId: 'gt',
    quota,
    recaptcha,
    action: 'generate',
    cookieSecret: 'secret',
    recaptchaToken: 't',
  };

  it('first visit gets a signed cookie; the same device is rejected after the daily limit', async () => {
    const first = await authorizeGuest({ ...base, request: request(), fetcher: assessment(0.9) });
    expect(first.ok).toBe(true);
    const cookie = first.setCookie!.split(';')[0]!;
    const guestId = await readGuestId(request(cookie).headers, 'gt', 'secret');
    expect(first.ok && first.guestId).toBe(guestId);

    const second = await authorizeGuest({ ...base, request: request(cookie), fetcher: assessment(0.9) });
    const third = await authorizeGuest({ ...base, request: request(cookie), fetcher: assessment(0.9) });
    expect(second.ok).toBe(true);
    expect(third).toMatchObject({ ok: false, reason: 'quota' });
  });

  it('a forged cookie is treated as a new device and IP counting still applies', async () => {
    const ip = '198.51.100.9';
    const forged = 'gt_gid=g_fake.signature';
    expect(await readGuestId(request(forged).headers, 'gt', 'secret')).toBeNull();
    const results = [];
    for (let i = 0; i < 4; i++)
      results.push(await authorizeGuest({ ...base, request: request(forged, ip), fetcher: assessment(0.9) }));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
  });

  it('low scores are rejected without consuming quota', async () => {
    const decision = await authorizeGuest({
      ...base,
      request: request(undefined, '192.0.2.1'),
      fetcher: assessment(0.1),
    });
    expect(decision).toMatchObject({ ok: false, reason: 'recaptcha' });
  });
});

describe('utilities', () => {
  it('groups IPv6 by /64 and compressed forms land in the same bucket', () => {
    expect(ipBucket('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('2001::1:2:3:4:5')).toBe('2001:0:0:1::/64');
    expect(ipBucket('2001:0:0:1::1')).toBe('2001:0:0:1::/64');
    expect(ipBucket('2001:DB8:0001:0002::9')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
  });

  it('site-relative path check blocks open redirects', () => {
    expect(safeRelativePath('/account?x=1', '/')).toBe('/account?x=1');
    const bad = ['//evil.example', '/\\evil.example/x', '/\\/evil', 'https://evil.example', '/a\nb', 42];
    for (const value of bad) {
      expect(safeRelativePath(value, '/')).toBe('/');
    }
  });

  it('disposable emails include subdomains', () => {
    expect(isDisposableEmail('a@mailinator.com')).toBe(true);
    expect(isDisposableEmail('a@x.mailinator.com')).toBe(true);
    expect(isDisposableEmail('a@gmail.com')).toBe(false);
  });
});
