#!/usr/bin/env node
// Moves a site's Cloudflare D1 data into its Postgres database, once, when the site moves from Workers (v0.2.0) to Node + Postgres.
// See docs/migrating-from-workers.md.
//
//   # In the site directory: export the live D1 (read-only). The export holds sessions, users and payments: keep it outside every
//   # repository (or under a gitignored private-assets/), never in a Docker build context.
//   npx wrangler d1 export <database> --remote --output /somewhere/safe/<site>-d1.sql
//   # Rehearsal: writes everything, reads it back, rolls back, prints a report naming the target database.
//   DATABASE_URL=<the database the site really uses> node ../../tools/import-d1.mjs /somewhere/safe/<site>-d1.sql [--new-tables a,b]
//   # For real: --database must equal the database name the rehearsal printed.
//   DATABASE_URL=<same> node ../../tools/import-d1.mjs /somewhere/safe/<site>-d1.sql [--new-tables a,b] --yes --database <name>
//
// Run it from the site directory: the Postgres driver (pg) is resolved from there. The target must already have the site's tables
// (node migrate.mjs). Values are converted by the target column type: millisecond integers to timestamptz, 0/1 to boolean, text to jsonb.
// Refused rather than guessed: an unknown type or an unexpected value; a source table or column the target lacks (known dropped
// columns aside); a target table or column the source lacks (engine tables new on Postgres and the site's own new tables passed with
// --new-tables aside), so a partial, schema-only or empty export never counts as success. Every target table must be empty. All in
// one transaction, parents first; every row is read back and compared with the source before the commit.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

/** Columns the D1 schema had and Postgres no longer needs, and why. */
export const DROPPED_COLUMNS = {
  'credit_accounts.version': 'the optimistic-lock counter of the D1 ledger; Postgres uses row locks',
};

/** Tables the engine added on Postgres, with no D1 counterpart: job runs, rebuilt by the job worker for jobs in progress. */
export const ENGINE_NEW_TABLES = ['job_runs', 'job_steps'];

/** D1's own tables, not site data. */
const SOURCE_INTERNAL = /^(?:_cf_|sqlite_|d1_migrations$)/;

const MIN_MS = 1_000_000_000_000n; // 2001-09
const MAX_MS = 10_000_000_000_000n; // 2286
const INT_MIN = -2_147_483_648n;
const INT_MAX = 2_147_483_647n;
const SMALLINT_MIN = -32_768n;
const SMALLINT_MAX = 32_767n;
const INTEGER_TYPES = new Set(['smallint', 'integer', 'bigint']);

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const table = (name) => `"public".${quote(name)}`;

/** Reads a wrangler d1 export: { table: { columns, rows } }. Integers come back as BigInt, so big values are exact and never throw. */
export function readDump(sql) {
  // wrangler d1 export writes tables in name order (account before user), so children come before their parents; Postgres checks the
  // foreign keys when the rows are inserted there, in dependency order.
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  db.exec(sql);
  const tables = db
    .prepare("select name from sqlite_master where type = 'table' order by name")
    .all()
    .map((row) => row.name)
    .filter((name) => !SOURCE_INTERNAL.test(name));
  const out = {};
  for (const name of tables) {
    const columns = db
      .prepare(`pragma table_info(${quote(name)})`)
      .all()
      .map((c) => c.name);
    const select = db.prepare(`select * from ${quote(name)}`);
    select.setReadBigInts(true);
    out[name] = { columns, rows: select.all().map((row) => ({ ...row })) };
  }
  db.close();
  return out;
}

/** The target's public tables: columns with their types, and foreign-key parents. */
export async function readTarget(client) {
  const { rows: cols } = await client.query(
    `select table_name, column_name, data_type
       from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`,
  );
  const tables = {};
  for (const c of cols) {
    tables[c.table_name] ??= { columns: {}, parents: new Set() };
    tables[c.table_name].columns[c.column_name] = { type: c.data_type };
  }
  const { rows: fks } = await client.query(
    `select tc.table_name as child, ccu.table_name as parent
       from information_schema.table_constraints tc
       join information_schema.constraint_column_usage ccu
         on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`,
  );
  for (const fk of fks) if (fk.child !== fk.parent) tables[fk.child]?.parents.add(fk.parent);
  return tables;
}

/** Which database this is: printed in every report and checked against --database before a real import. */
export async function targetIdentity(client) {
  const { rows } = await client.query(
    `select current_database() as database, current_user as "user",
            coalesce(inet_server_addr()::text, 'local socket') as host, inet_server_port() as port`,
  );
  return rows[0];
}

/** Matches source to target: the tables to import (parents first) and their columns, or the problems that stop the import. */
export function plan(source, target, { newTables = [] } = {}) {
  const problems = [];
  const notes = [];
  const tables = [];
  const allowedNew = new Set([...ENGINE_NEW_TABLES, ...newTables]);
  for (const [name, { columns }] of Object.entries(source)) {
    const t = target[name];
    if (!t) {
      problems.push(`source table ${name} is not in the target`);
      continue;
    }
    const keep = [];
    for (const column of columns) {
      if (t.columns[column]) keep.push(column);
      else if (DROPPED_COLUMNS[`${name}.${column}`])
        notes.push(`dropping ${name}.${column}: ${DROPPED_COLUMNS[`${name}.${column}`]}`);
      else problems.push(`source column ${name}.${column} is not in the target`);
    }
    // A target column the source lacks would silently take its default (a missing debt column would read 0): refuse.
    for (const column of Object.keys(t.columns))
      if (!columns.includes(column)) problems.push(`target column ${name}.${column} is not in the source`);
    tables.push({ name, columns: keep });
  }
  for (const name of Object.keys(target)) {
    if (source[name]) continue;
    if (allowedNew.has(name)) notes.push(`target table ${name} is new, not in the source: left empty`);
    else
      problems.push(
        `target table ${name} is not in the source (partial export? list the site's new tables with --new-tables)`,
      );
  }
  for (const name of newTables)
    if (source[name]) problems.push(`--new-tables lists ${name}, but the source has it`);
  // Foreign-key order: parents first.
  const order = [];
  const seen = new Set();
  const visit = (name, stack = new Set()) => {
    if (seen.has(name)) return;
    if (stack.has(name)) throw new Error(`foreign-key cycle: ${[...stack, name].join(' -> ')}`);
    stack.add(name);
    for (const parent of target[name]?.parents ?? []) if (source[parent]) visit(parent, stack);
    stack.delete(name);
    seen.add(name);
    order.push(name);
  };
  for (const { name } of tables) visit(name);
  const byName = Object.fromEntries(tables.map((t) => [t.name, t]));
  return { problems, notes, tables: order.filter((name) => byName[name]).map((name) => byName[name]) };
}

function fail(tableName, column, value, why) {
  throw new Error(
    `${tableName}.${column} = ${JSON.stringify(typeof value === 'bigint' ? String(value) : value)}: ${why}`,
  );
}

const isInt = (value) => typeof value === 'bigint' || Number.isInteger(value);

/** A source (SQLite) value as written to the target column. Integers from readDump are BigInt. */
export function toTarget(tableName, column, type, value) {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'timestamp with time zone':
    case 'timestamp without time zone':
      if (!isInt(value) || BigInt(value) < MIN_MS || BigInt(value) >= MAX_MS)
        fail(tableName, column, value, 'not a millisecond timestamp');
      return new Date(Number(value));
    case 'boolean':
      if (isInt(value) && (BigInt(value) === 0n || BigInt(value) === 1n)) return BigInt(value) === 1n;
      return fail(tableName, column, value, 'not 0 or 1');
    case 'smallint':
    case 'integer': {
      const [min, max] = type === 'smallint' ? [SMALLINT_MIN, SMALLINT_MAX] : [INT_MIN, INT_MAX];
      if (!isInt(value) || BigInt(value) < min || BigInt(value) > max)
        fail(tableName, column, value, `not a ${type}`);
      return Number(value);
    }
    case 'bigint':
      if (!isInt(value)) fail(tableName, column, value, 'not an integer');
      return String(value);
    case 'double precision':
    case 'real':
    case 'numeric':
      // A float can't hold every integer: refuse one it would round (2^53 + 1 stored as 2^53 would still compare equal).
      if (typeof value === 'bigint') {
        const limit = type === 'real' ? 2n ** 24n : 2n ** 53n;
        if (value > limit || value < -limit) fail(tableName, column, value, `too large for ${type}`);
        return Number(value);
      }
      if (typeof value !== 'number' || !Number.isFinite(value))
        fail(tableName, column, value, 'not a number');
      return value;
    case 'jsonb':
    case 'json':
      if (typeof value !== 'string') fail(tableName, column, value, 'not JSON text');
      try {
        JSON.parse(value);
      } catch {
        fail(tableName, column, value, 'not valid JSON');
      }
      return value;
    case 'text':
    case 'character varying':
      if (typeof value !== 'string') fail(tableName, column, value, 'not text');
      return value;
    default:
      return fail(tableName, column, value, `unknown target type ${type}`);
  }
}

/** JSON with object keys sorted, so key order never decides equality. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** A source value in the form rows are compared in. */
export function sourceComparable(type, value) {
  if (value === null || value === undefined) return null;
  if (type === 'jsonb' || type === 'json') return canonical(JSON.parse(value));
  if (type === 'boolean') return Number(value);
  if (INTEGER_TYPES.has(type) || type.startsWith('timestamp')) return String(value);
  if (type === 'numeric' || type === 'real' || type === 'double precision') return Number(value);
  return value;
}

/** A value read back from the target, in the same form. Drivers already decode json, so it is not parsed again. */
export function backToSource(type, value) {
  if (value === null || value === undefined) return null;
  if (type === 'jsonb' || type === 'json') return canonical(value);
  if (type === 'boolean') return value === true || value === 't' ? 1 : 0;
  if (type.startsWith('timestamp'))
    return String((value instanceof Date ? value : new Date(value)).getTime());
  if (INTEGER_TYPES.has(type)) return String(value);
  if (type === 'numeric' || type === 'real' || type === 'double precision') return Number(value);
  return value;
}

const rowKey = (row) => JSON.stringify(row);

/**
 * Imports the source into the target in one transaction and checks every row. Without apply it rolls back; with apply, database must
 * equal the target's name. client only needs query(text, params) -> { rows }. Returns the target identity and per-table row counts;
 * any problem throws and rolls back.
 */
export async function importDump(
  client,
  source,
  { apply = false, database, newTables = [], batchRows = 500 } = {},
) {
  const identity = await targetIdentity(client);
  if (apply && database !== identity.database)
    throw new Error(
      `--database ${database ?? '(missing)'} is not the target database ${identity.database}; nothing written`,
    );
  const target = await readTarget(client);
  const { problems, notes, tables } = plan(source, target, { newTables });
  if (problems.length)
    throw new Error(`source and target do not match; nothing written:\n- ${problems.join('\n- ')}`);
  // A schema-only export (wrangler d1 export --no-data) has every table and column and verifies 0 against 0.
  if (Object.values(source).every((t) => t.rows.length === 0))
    throw new Error('the export has no rows at all (--no-data?); nothing written');
  const report = { identity, notes, tables: [] };
  await client.query('begin');
  try {
    // Every table of the target, the new ones too: leftovers from a rehearsal must not mix into the live site.
    for (const name of Object.keys(target)) {
      const { rows } = await client.query(`select count(*)::int as n from ${table(name)}`);
      if (rows[0].n !== 0)
        throw new Error(`target table ${name} is not empty (${rows[0].n} rows); nothing written`);
    }
    for (const { name, columns } of tables) {
      const types = columns.map((c) => target[name].columns[c].type);
      const sourceRows = source[name].rows;
      for (let start = 0; start < sourceRows.length; start += batchRows) {
        const batch = sourceRows.slice(start, start + batchRows);
        const params = [];
        const values = batch.map((row) => {
          const slots = columns.map((column, i) => {
            params.push(toTarget(name, column, types[i], row[column]));
            return `$${params.length}`;
          });
          return `(${slots.join(', ')})`;
        });
        await client.query(
          `insert into ${table(name)} (${columns.map(quote).join(', ')}) values ${values.join(', ')}`,
          params,
        );
      }
      // Read back: every row in comparable form, compared as a multiset.
      const { rows: back } = await client.query(
        `select ${columns.map(quote).join(', ')} from ${table(name)}`,
      );
      const expected = sourceRows
        .map((row) => rowKey(columns.map((c, i) => sourceComparable(types[i], row[c]))))
        .sort();
      const actual = back.map((row) => rowKey(columns.map((c, i) => backToSource(types[i], row[c])))).sort();
      if (expected.length !== actual.length || expected.some((key, i) => key !== actual[i]))
        throw new Error(
          `${name} reads back differently from the source (${expected.length} rows in, ${actual.length} back)`,
        );
      report.tables.push({ name, rows: sourceRows.length });
    }
    await client.query(apply ? 'commit' : 'rollback');
    report.applied = apply;
    return report;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

/** Refuses an export inside a repository (a private-assets/ directory aside): repository roots are Docker build contexts. */
export function assertDumpOutsideRepo(file, repoRoots) {
  const resolved = path.resolve(file);
  // By whole path segments: "..notes" is a directory inside, ".." is the parent.
  const inside = (dir) => {
    const rel = path.relative(dir, resolved);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  for (const root of [repoRoots].flat().map((r) => path.resolve(r)))
    if (inside(root) && !inside(path.join(root, 'private-assets')))
      throw new Error(
        `the export ${resolved} is inside a repository: move it outside (or under a gitignored private-assets/)`,
      );
}

/**
 * Every repository the export must stay out of: this checkout, the repository it is vendored into (submodule), the main checkout of a
 * worktree, and the repository of the current directory.
 */
export function repoRoots(toolsRepo, cwd = process.cwd()) {
  const roots = new Set([path.resolve(toolsRepo)]);
  const git = (dir, ...args) => {
    try {
      return execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  };
  for (const dir of [toolsRepo, cwd]) {
    const top = git(dir, 'rev-parse', '--show-toplevel');
    if (top) roots.add(path.resolve(top));
    const superproject = git(dir, 'rev-parse', '--show-superproject-working-tree');
    if (superproject) roots.add(path.resolve(superproject));
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    if (common && path.basename(common) === '.git') roots.add(path.resolve(path.dirname(common)));
  }
  return [...roots];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const apply = args.includes('--yes');
  const database = value('--database');
  const newTables = (value('--new-tables') ?? '').split(',').filter(Boolean);
  const file = args.find(
    (arg, i) => !arg.startsWith('--') && !['--database', '--new-tables'].includes(args[i - 1]),
  );
  if (!file || !process.env.DATABASE_URL) {
    console.error(
      'usage: DATABASE_URL=<the database the site uses> node tools/import-d1.mjs <export.sql> [--new-tables a,b] [--yes --database <name>]',
    );
    process.exit(2);
  }
  try {
    assertDumpOutsideRepo(file, repoRoots(path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  // pg from the site this runs in (sites depend on it), so the tool itself needs nothing beyond Node.
  let pg;
  try {
    pg = createRequire(path.join(process.cwd(), 'package.json'))('pg');
  } catch {
    console.error('pg not found: run this from the site directory (after pnpm install)');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const source = readDump(fs.readFileSync(file, 'utf8'));
    const report = await importDump(client, source, { apply, database, newTables });
    const { identity } = report;
    console.log(`target: ${identity.database} (user ${identity.user}, ${identity.host}:${identity.port})`);
    for (const note of report.notes) console.log(`- ${note}`);
    for (const t of report.tables) console.log(`${t.name}: ${t.rows} rows, read back identical`);
    console.log(
      apply
        ? 'written.'
        : `rehearsal: rolled back, nothing written. When the target is right, add --yes --database ${identity.database}.`,
    );
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
