import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { type Db, schema } from '../src/db/client';

// One in-memory Postgres per test file (vitest isolates modules per file), with this package's migrations applied.
// Tests use fresh IDs, so they share it within a file.
const pglite = drizzle({ client: new PGlite(), schema });
await migrate(pglite, { migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)) });

export const db = pglite as unknown as Db;
