import { defineConfig } from 'vitest/config';

// Tests run in Node; each test file gets its own in-memory Postgres (test/db.ts), so parallel worktrees don't interfere.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
