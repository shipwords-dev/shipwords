import { proxyRybbit } from '@shipwords/core/analytics';
import { publicRequest } from '@shipwords/core/http';
import handler from '@tanstack/react-start/server-entry';
import { paraglideMiddleware } from '~/paraglide/server.js';
import { admin, shutdown, startJobWorker } from './core.server';

// Server entry: pages and API go to TanStack Start. start.mjs serves it with srvx and calls shutdown() on SIGTERM; owner scripts
// (such as the template's replace-output.mjs) use admin. Static files, including the /media samples with Range support (iPhone Safari
// needs it to play them), are served by srvx in start.mjs. Compose, the face check and repairs run in the machine's compose service
// (COMPOSE_URL); there is no per-job compose container any more.
export { admin, shutdown };

// The job worker starts with the server, not on the first request, and only here: importing core.server elsewhere starts nothing.
startJobWorker();

export default {
  async fetch(incoming: Request): Promise<Response> {
    // Behind the proxy the server sees http://; give the site's own host its public https origin (APP_URL) before anything reads request.url.
    const request = publicRequest(incoming, process.env.APP_URL);
    // Liveness for the container: answers without touching the database. Cloudflare handles http→https and www→apex.
    if (new URL(request.url).pathname === '/healthz') return new Response('ok');
    // Rybbit analytics goes through this site's /stats/ and is proxied upstream here.
    const stats = await proxyRybbit(request, process.env.RYBBIT_UPSTREAM);
    if (stats) return stats;
    // Only local dev picks the locale from a cookie (Chinese review); production is English only, so requests go straight to TanStack Start.
    return import.meta.env.DEV
      ? paraglideMiddleware(request, () => handler.fetch(request))
      : handler.fetch(request);
  },
};
