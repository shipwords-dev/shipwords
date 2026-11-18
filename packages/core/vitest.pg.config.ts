import { defineConfig } from 'vitest/config';

// Concurrency tests against a real Postgres (test-pg/pg.ts). Skipped without TEST_DATABASE_URL.
export default defineConfig({
  test: {
    include: ['test-pg/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One file at a time: each opens its own pool against a shared server.
    fileParallelism: false,
  },
});
