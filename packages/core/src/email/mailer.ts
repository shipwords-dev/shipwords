import type { EmailMessage } from './copy';

// Sending email: sign-in codes, job results, owner alerts. The default sends through the Cloudflare Email Service REST API, which
// keeps a site's verified sending domain; local development logs messages instead. Another provider is one more Mailer.

export interface MailAddress {
  email: string;
  name?: string;
}

export interface Mail extends EmailMessage {
  to: string;
  from: MailAddress;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export interface CloudflareMailerConfig {
  accountId: string;
  /** An API token with Email Sending permission. */
  apiToken: string;
}

/** Cloudflare Email Service, POST /accounts/{id}/email/sending/send. Throws when the service doesn't accept the message. */
export function cloudflareMailer(config: CloudflareMailerConfig, fetcher: typeof fetch = fetch): Mailer {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/email/sending/send`;
  return {
    async send(mail) {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          to: mail.to,
          // The REST API names the address field "address" (the Workers binding used "email").
          from: { address: mail.from.email, ...(mail.from.name ? { name: mail.from.name } : {}) },
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        success?: boolean;
        errors?: { code: number; message: string }[];
        result?: { permanent_bounces?: string[]; suppressed_recipients?: string[] };
      } | null;
      if (!response.ok || body?.success !== true) {
        const errors = body?.errors?.map((error) => `${error.code} ${error.message}`).join('; ');
        throw new Error(`email send failed: ${response.status}${errors ? ` ${errors}` : ''}`);
      }
      // Accepted but known undeliverable: a sign-in code that will never arrive is a failure the caller should report.
      const lost = [...(body.result?.permanent_bounces ?? []), ...(body.result?.suppressed_recipients ?? [])];
      if (lost.some((address) => address.toLowerCase() === mail.to.toLowerCase()))
        throw new Error(`email to ${mail.to} bounced or is suppressed`);
    },
  };
}

/** Local development: write each message to the log (sign-in codes included) instead of sending it. */
export function logMailer(log: (message: string, details: Record<string, unknown>) => void): Mailer {
  return {
    async send(mail) {
      log('email (not sent)', { to: mail.to, from: mail.from.email, subject: mail.subject, text: mail.text });
    },
  };
}

export interface MailerEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Needs Email Sending permission (and Workers AI, if the site describes images). */
  CLOUDFLARE_API_TOKEN?: string;
  /** "1" in local development only: write emails (sign-in codes included) to the log instead of sending them. Ignored in production. */
  MAIL_LOG?: string;
}

function logsMail(env: MailerEnv): boolean {
  return env.MAIL_LOG === '1' && process.env.NODE_ENV !== 'production';
}

/** True when mail can actually go out (or is deliberately logged in development). */
export function canSendMail(env: MailerEnv): boolean {
  return Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) || logsMail(env);
}

/**
 * The mailer a site's environment configures. Logging instead of sending needs MAIL_LOG=1 outside production: a misconfigured
 * deployment must never write sign-in codes to its log. Without credentials, sending throws, so a missing setting shows at once.
 */
export function mailerFromEnv(
  env: MailerEnv,
  log: (message: string, details: Record<string, unknown>) => void = (message, details) =>
    console.log(JSON.stringify({ level: 'info', message, ...details })),
): Mailer {
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)
    return cloudflareMailer({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN });
  if (logsMail(env)) return logMailer(log);
  return {
    async send() {
      throw new Error('no mailer configured: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    },
  };
}
