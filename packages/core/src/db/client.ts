import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

type Schema = typeof schema;

/** Any Postgres driver's database (node-postgres in the app, PGlite in tests); engine code never names a driver. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
/** A transaction handle; it accepts every query a Db does. */
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/** Opens a pool on DATABASE_URL. One per process; the pool is closed with the process. */
export function createDb(connectionString: string, config: Omit<PoolConfig, 'connectionString'> = {}): Db {
  return drizzle({ client: new Pool({ connectionString, max: 10, ...config }), schema }) as unknown as Db;
}

export { schema };

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

/** SQLSTATE codes the engine reacts to. */
const SQLSTATE = {
  UNIQUE: '23505',
  CHECK: '23514',
  /** Deadlock and serialization failures: the transaction did nothing and may be retried. */
  DEADLOCK: '40P01',
  SERIALIZATION: '40001',
} as const;

type ConstraintKind = 'UNIQUE' | 'CHECK';

interface PgErrorFields {
  code?: unknown;
  constraint?: unknown;
}

/** drizzle wraps driver errors (DrizzleQueryError); walk the cause chain to the one that carries the SQLSTATE. */
function pgError(error: unknown): PgErrorFields | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    const fields = current as PgErrorFields;
    if (typeof fields.code === 'string' && /^[0-9A-Z]{5}$/.test(fields.code)) return fields;
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}

/** True for a unique or check violation; `constraint` narrows it to one named constraint or index. */
export function isConstraintError(error: unknown, kind: ConstraintKind, constraint?: string): boolean {
  const fields = pgError(error);
  if (fields?.code !== SQLSTATE[kind]) return false;
  return !constraint || fields.constraint === constraint;
}

/** True when Postgres aborted a transaction for a deadlock or serialization failure; nothing was written. */
export function isRetryableTransactionError(error: unknown): boolean {
  const code = pgError(error)?.code;
  return code === SQLSTATE.DEADLOCK || code === SQLSTATE.SERIALIZATION;
}
