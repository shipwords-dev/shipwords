import { proxyRybbit } from '@shipwords/core/analytics';
import { publicRequest } from '@shipwords/core/http';
import handler from '@tanstack/react-start/server-entry';
import { paraglideMiddleware } from '~/paraglide/server.js';
import { admin, shutdown, startJobWorker } from './core.server';

// Server entry: pages and API go to TanStack Start. start.mjs serves it with srvx and calls shutdown() on SIGTERM; the site's
// scripts (replace-output.mjs) use admin.
export { admin, shutdown };

// The job worker starts with the server, not on the first request, and only here: importing core.server elsewhere starts nothing.
startJobWorker();

export default {
  async fetch(incoming: Request): Promise<Response> {
    // Behind the proxy the server sees http://; give the site's own host its public https origin before anything reads request.url.
    const request = publicRequest(incoming, process.env.APP_URL);
    // Liveness for the container: answers without touching the database.
    if (new URL(request.url).pathname === '/healthz') return new Response('ok');
    // Rybbit analytics goes through this site's /stats/ and is proxied upstream here.
    const stats = await proxyRybbit(request, process.env.RYBBIT_UPSTREAM);
    if (stats) return stats;
    // Only local dev picks the locale from a cookie (for zh review); production is English only and passes requests straight to TanStack Start.
    return import.meta.env.DEV
      ? paraglideMiddleware(request, () => handler.fetch(request))
      : handler.fetch(request);
  },
};
