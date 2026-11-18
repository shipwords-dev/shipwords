import { defineConfig } from 'drizzle-kit';

// Only for jobs' own tests: core and jobs tables are generated together into test/migrations.
export default defineConfig({
  dialect: 'postgresql',
  schema: ['../core/src/db/schema.ts', './src/schema.ts'],
  out: './test/migrations',
  migrations: { prefix: 'timestamp' },
});
