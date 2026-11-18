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
      } | null;
      if (!response.ok || body?.success !== true) {
        const errors = body?.errors?.map((error) => `${error.code} ${error.message}`).join('; ');
        throw new Error(`email send failed: ${response.status}${errors ? ` ${errors}` : ''}`);
      }
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
  APP_URL?: string;
}

function isLocal(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * The mailer a site's environment configures. Without Cloudflare credentials a local site logs messages; a deployed one throws, so
 * a missing setting shows at the first send instead of sign-in codes silently going nowhere.
 */
export function mailerFromEnv(
  env: MailerEnv,
  log: (message: string, details: Record<string, unknown>) => void = (message, details) =>
    console.log(JSON.stringify({ level: 'info', message, ...details })),
): Mailer {
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)
    return cloudflareMailer({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN });
  if (isLocal(env.APP_URL)) return logMailer(log);
  return {
    async send() {
      throw new Error('no mailer configured: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    },
  };
}
