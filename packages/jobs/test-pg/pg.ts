import { fileURLToPath } from 'node:url';
import { type Db, schema } from '@shipwords/core/db/client';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';

// Lock behavior needs a real server: PGlite has one connection, so its transactions queue instead of contending.
// TEST_DATABASE_URL points at a disposable server (e.g. docker run -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55433:5432 postgres:17-alpine
// gives postgres://postgres@127.0.0.1:55433/postgres). Each file gets its own database, dropped afterwards.

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
  const pool = new Pool({ connectionString: url.toString(), max: 40 });
  const db = drizzle({ client: pool, schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../test/migrations', import.meta.url)) });
  return {
    db: db as unknown as Db,
    async close() {
      await pool.end();
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${name} with (force)`);
      await cleanup.end();
    },
  };
}
