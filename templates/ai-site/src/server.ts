import { proxyRybbit } from '@shipwords/core/analytics';
import handler from '@tanstack/react-start/server-entry';
import { paraglideMiddleware } from '~/paraglide/server.js';
// Imported here, not only from routes, so the job worker starts when the server does rather than on the first request.
import { shutdown } from './core.server';

// Server entry: pages and API go to TanStack Start. start.mjs serves it with srvx and calls shutdown() on SIGTERM.
export { shutdown };

export default {
  async fetch(request: Request): Promise<Response> {
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
