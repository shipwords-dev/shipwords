import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run in Node with one in-memory PGlite per test file (test/db.ts) and this site's migrations: no ports, no shared database.
export default defineConfig({
  resolve: { alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'] },
});
