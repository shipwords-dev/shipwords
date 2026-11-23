import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import { type Db, schema } from '../src/db/client';

// Lock behavior needs a real server: PGlite has one connection, so its transactions queue instead of contending.
// TEST_DATABASE_URL points at a server where this role may create databases (locally: the shared Postgres, see docs/local-development.md;
// in CI: a service container). Each file gets its own database, dropped afterwards.

export const adminUrl = process.env.TEST_DATABASE_URL;

export async function freshDatabase(): Promise<{ db: Db; close: () => Promise<void> }> {
  if (!adminUrl) throw new Error('TEST_DATABASE_URL is not set');
  const name = `sw_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  // Small pools and one file at a time (vitest.pg.config.ts): a shared server has room for only so many connections.
  const pool = new Pool({ connectionString: url.toString(), max: 12, connectionTimeoutMillis: 10_000 });
  const db = drizzle({ client: pool, schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../test/migrations', import.meta.url)) });
  return {
    db: db as unknown as Db,
    async close() {
      // pool.end() only starts closing its connections. Dropping the database "with (force)" while one is still open makes the
      // server send that client FATAL 57P01, which surfaces as an unhandled error and fails the run (it did, every time, in CI).
      // So wait until the server has no session on it left, and keep force only for one that never goes away.
      await pool.end();
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      const until = Date.now() + 5_000;
      for (;;) {
        const { rows } = await cleanup.query(
          'select count(*)::int as n from pg_stat_activity where datname = $1',
          [name],
        );
        if (rows[0].n === 0 || Date.now() > until) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await cleanup.query(`drop database if exists ${name} with (force)`);
      await cleanup.end();
    },
  };
}
