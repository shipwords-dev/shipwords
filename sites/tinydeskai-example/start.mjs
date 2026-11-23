// Production server: the built app (dist/server/server.js) and its static files (dist/client), served by srvx.
// On SIGTERM (docker stop) it stops taking requests and, at the same time, stops the job worker (steps in flight finish, runs are
// handed back), then exits. srvx's own shutdown handling is off: it would exit before the worker is done.
import { fileURLToPath } from 'node:url';
import { serve } from 'srvx';
import { staticMiddleware } from 'srvx/static';
import app, { shutdown } from './dist/server/server.js';

/** Open requests (a long download, say) get this long to finish before their connections are cut. */
const HTTP_DRAIN_MS = Number(process.env.HTTP_DRAIN_MS) || 20_000;

const server = serve({
  fetch: app.fetch,
  middleware: [staticMiddleware({ dir: fileURLToPath(new URL('./dist/client', import.meta.url)) })],
  port: Number(process.env.PORT) || 3000,
  // A container listens on every interface (the proxy in front reaches it); a local run (pnpm start, pnpm preview) stays on loopback.
  hostname: process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
  gracefulShutdown: false,
});
await server.ready();
console.log(JSON.stringify({ level: 'info', message: 'listening', url: server.url }));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ level: 'info', message: 'shutting down', signal }));
    try {
      await Promise.all([
        // The worker stops claiming at once and finishes its steps in flight, whatever the HTTP side is doing.
        shutdown(),
        Promise.race([server.close(), delay(HTTP_DRAIN_MS).then(() => server.close(true))]),
      ]);
    } finally {
      process.exit(0);
    }
  });
}
