import { describe, expect, it } from 'vitest';
import { canSendMail, cloudflareMailer, mailerFromEnv } from '../src/email/mailer';

const mail = {
  to: 'user@example.com',
  from: { email: 'noreply@site.example', name: 'Site' },
  subject: 'Your code',
  text: '123456',
  html: '<p>123456</p>',
};

describe('mailer', () => {
  it('sends through the Cloudflare Email Service REST API with an address object for the sender', async () => {
    const calls: { url: string; auth: string | null; body: unknown }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        auth: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ success: true, errors: [], result: { message_id: 'm1' } });
    }) as typeof fetch;
    await cloudflareMailer({ accountId: 'acc', apiToken: 'tok' }, fetcher).send(mail);
    expect(calls).toEqual([
      {
        url: 'https://api.cloudflare.com/client/v4/accounts/acc/email/sending/send',
        auth: 'Bearer tok',
        body: {
          to: 'user@example.com',
          from: { address: 'noreply@site.example', name: 'Site' },
          subject: 'Your code',
          text: '123456',
          html: '<p>123456</p>',
        },
      },
    ]);
  });

  it('throws with the service error codes when a message is refused', async () => {
    const fetcher = (async () =>
      Response.json(
        { success: false, errors: [{ code: 10001, message: 'email.sending.error.invalid_request_schema' }] },
        { status: 400 },
      )) as unknown as typeof fetch;
    await expect(cloudflareMailer({ accountId: 'a', apiToken: 't' }, fetcher).send(mail)).rejects.toThrow(
      /400 10001 email\.sending\.error\.invalid_request_schema/,
    );
  });

  it('logs instead of sending only when MAIL_LOG=1 outside production; otherwise refuses to send', async () => {
    const logged: Record<string, unknown>[] = [];
    await mailerFromEnv({ MAIL_LOG: '1' }, (_message, details) => logged.push(details)).send(mail);
    expect(logged[0]).toMatchObject({ to: 'user@example.com', text: '123456' });
    await expect(mailerFromEnv({}).send(mail)).rejects.toThrow(/no mailer configured/);
  });

  it('never logs mail in production, even with MAIL_LOG=1', async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const logged: unknown[] = [];
      await expect(mailerFromEnv({ MAIL_LOG: '1' }, (_m, d) => logged.push(d)).send(mail)).rejects.toThrow(
        /no mailer/,
      );
      expect(logged).toEqual([]);
      expect(canSendMail({ MAIL_LOG: '1' })).toBe(false);
    } finally {
      process.env.NODE_ENV = before;
    }
  });

  it('reports a bounced or suppressed recipient as a failed send', async () => {
    const fetcher = (async () =>
      Response.json({
        success: true,
        result: {
          delivered: [],
          queued: [],
          permanent_bounces: ['USER@example.com'],
          suppressed_recipients: [],
        },
      })) as unknown as typeof fetch;
    await expect(cloudflareMailer({ accountId: 'a', apiToken: 't' }, fetcher).send(mail)).rejects.toThrow(
      /bounced/,
    );
  });
});
