// Production server: the built app (dist/server/server.js) and its static files (dist/client), served by srvx.
// On SIGTERM (docker stop) it stops taking requests, lets the job worker finish its steps in flight and hand its runs back, then
// exits. srvx's own shutdown handling is off: it would exit before the worker is done.
import { fileURLToPath } from 'node:url';
import { serve } from 'srvx';
import { staticMiddleware } from 'srvx/static';
import app, { shutdown } from './dist/server/server.js';

const server = serve({
  fetch: app.fetch,
  middleware: [staticMiddleware({ dir: fileURLToPath(new URL('./dist/client', import.meta.url)) })],
  port: Number(process.env.PORT) || 3000,
  hostname: process.env.HOST || '0.0.0.0',
  gracefulShutdown: false,
});
await server.ready();
console.log(JSON.stringify({ level: 'info', message: 'listening', url: server.url }));

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ level: 'info', message: 'shutting down', signal }));
    try {
      await server.close();
      await shutdown();
    } finally {
      process.exit(0);
    }
  });
}
