import { defineConfig } from 'drizzle-kit';

// Only for core's own tests: generated migrations are applied to the in-memory PGlite in tests.
// Each site generates its own migrations from the merged schema; see templates/ai-site/drizzle.config.ts.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './test/migrations',
  migrations: { prefix: 'timestamp' },
});
