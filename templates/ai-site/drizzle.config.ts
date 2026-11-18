import { defineConfig } from 'drizzle-kit';

// db:migrate needs DATABASE_URL: from the environment, or from .env in local development.
try {
  process.loadEnvFile();
} catch {}

// Migrations are generated from the packages schema plus this site's schema, with timestamp prefixes so parallel work never collides.
// When a packages table changes, run pnpm db:generate once in each site.
export default defineConfig({
  dialect: 'postgresql',
  schema: [
    '../../packages/core/src/db/schema.ts',
    '../../packages/jobs/src/schema.ts',
    './src/site/schema.ts',
  ],
  out: './migrations',
  // pnpm db:migrate applies them to DATABASE_URL.
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  migrations: { prefix: 'timestamp' },
});
