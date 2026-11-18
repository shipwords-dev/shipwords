#!/usr/bin/env node
// Usage: run node ../../tools/stripe-listen.mjs in a site directory
// Starts stripe listen with the test key from .env and forwards webhooks to the site's dev server (APP_URL).
// The signing secret (whsec) can change, so the current one is written back to .env first; the dev server reloads.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setVar } from './lib.mjs';

/** Parses .env; the last occurrence of a variable wins. */
export function parseVars(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (match) vars[match[1]] = match[2].trim();
  }
  return vars;
}

/** Builds stripe listen args. Only test keys are accepted, so live events never get forwarded locally. */
export function listenArgs(vars) {
  const key = vars.STRIPE_SECRET_KEY ?? '';
  if (!/^(sk|rk)_test_\w{20,}$/.test(key)) throw new Error('.env has no usable Stripe test key (sk_test_)');
  if (!vars.APP_URL) throw new Error('.env has no APP_URL');
  const target = `${vars.APP_URL.replace(/\/$/, '')}/api/webhooks/stripe`;
  return ['listen', '--api-key', key, '--forward-to', target];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const text = fs.readFileSync('.env', 'utf8');
    const vars = parseVars(text);
    const args = listenArgs(vars);
    const secret = execFileSync('stripe', [...args.slice(0, 3), '--print-secret'], {
      encoding: 'utf8',
    }).trim();
    if (!secret.startsWith('whsec_')) throw new Error('stripe listen returned no signing secret');
    if (vars.STRIPE_WEBHOOK_SECRET !== secret) {
      fs.writeFileSync('.env', setVar(text, 'STRIPE_WEBHOOK_SECRET', secret));
      console.log('[stripe-listen] signing secret changed, written to .env');
    }
    console.log(`[stripe-listen] forwarding to ${args.at(-1)}`);
    const child = spawn('stripe', args, { stdio: 'inherit' });
    child.on('error', () => {
      console.error('[stripe-listen] stripe command not found; install the Stripe CLI first');
      process.exit(1);
    });
    child.on('exit', (code) => process.exit(code ?? 0));
  } catch (error) {
    console.error(`[stripe-listen] ${error.message}`);
    process.exit(1);
  }
}
