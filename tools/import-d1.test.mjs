// Tests for import-d1. The source is the template's D1 schema at v0.2.0 (fixtures/d1-v0.2.0-schema.sql); the target is the
// template's Postgres migrations, in an in-memory PGlite (database "postgres"). PGlite comes from packages/core, so these tests
// need pnpm install (CI has it); the rest of test:tools does not.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertDumpOutsideRepo,
  backToSource,
  importDump,
  privateAssetsDockerIgnored,
  readDump,
  sourceComparable,
  toTarget,
} from './import-d1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'packages', 'core', 'package.json'));
const { PGlite } = await import(pathToFileURL(require.resolve('@electric-sql/pglite')).href);

const schema = fs.readFileSync(path.join(here, 'fixtures', 'd1-v0.2.0-schema.sql'), 'utf8');
const migrations = path.join(here, '..', 'templates', 'ai-site', 'migrations');
const live = { apply: true, database: 'postgres' };

/** The template's tables; extra SQL adds a site's own tables, new on Postgres. */
async function target(extra = '') {
  const db = new PGlite();
  for (const file of fs
    .readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await db.exec(
      fs.readFileSync(path.join(migrations, file), 'utf8').replaceAll('--> statement-breakpoint', ''),
    );
  if (extra) await db.exec(extra);
  return db;
}
const count = async (db, name) => (await db.query(`select count(*)::int as n from "${name}"`)).rows[0].n;

const T = 1_795_000_000_123;
// Children before parents, as wrangler d1 export writes them (tables in name order).
const rows = `
INSERT INTO "session" VALUES('s1',${T + 86400000},'tok1',${T},${T},'203.0.113.9','UA','u1');
INSERT INTO "account" ("id","account_id","provider_id","user_id","created_at","updated_at") VALUES('a1','u1','credential','u1',${T},${T});
INSERT INTO "credit_accounts" ("user_id","debt","version","updated_at") VALUES('u1',0,7,${T});
INSERT INTO "credit_lots" VALUES('lot1','u1','purchase','ord1',30,20,NULL,${T});
INSERT INTO "credit_ledger" ("id","user_id","kind","delta","debt_delta","idem_key","created_at") VALUES('l1','u1','purchase',30,0,'buy:ord1',${T});
INSERT INTO "credit_ledger" ("id","user_id","kind","delta","debt_delta","idem_key","created_at") VALUES('l2','u1','charge',-10,0,'job:job_a',${T + 5});
INSERT INTO "jobs" ("id","user_id","model_id","kind","prompt","input_json","cost_credits","quota_released","status","upstream","outputs_json","created_at","finished_at")
  VALUES('job_a','u1','model-a','video','','{"parts":[]}',4,0,'succeeded','yir','[{"key":"jobs/job_a/0.mp4","mediaType":"video/mp4"}]',${T},${T + 60000});
INSERT INTO "user" VALUES('u1','Ann','ann@example.test',1,NULL,${T},${T + 1});
INSERT INTO "user" VALUES('u2','','bo@example.test',0,'https://img.example/b.png',${T + 2},${T + 3});
`;

test('import-d1: moves every row, converts types by the target column, and reads each row back', async () => {
  const db = await target();
  const report = await importDump(db, readDump(schema + rows), live);
  assert.equal(report.applied, true);
  assert.equal(report.identity.database, 'postgres');
  assert.ok(report.notes.some((n) => n.includes('credit_accounts.version')));
  assert.ok(report.notes.some((n) => n.includes('job_runs')));
  const byName = Object.fromEntries(report.tables.map((t) => [t.name, t.rows]));
  assert.equal(byName.user, 2);
  assert.equal(byName.jobs, 1);
  // Parents first: user before session and account.
  const order = report.tables.map((t) => t.name);
  assert.ok(order.indexOf('user') < order.indexOf('session'));
  assert.ok(order.indexOf('user') < order.indexOf('account'));

  const user = (await db.query(`select * from "user" where id = 'u1'`)).rows[0];
  assert.equal(user.email_verified, true);
  assert.equal(new Date(user.created_at).getTime(), T);
  assert.equal(
    (await db.query(`select email_verified from "user" where id = 'u2'`)).rows[0].email_verified,
    false,
  );
  const session = (await db.query(`select expires_at from session where id = 's1'`)).rows[0];
  assert.equal(new Date(session.expires_at).getTime(), T + 86400000);
  const job = (await db.query(`select quota_released, created_at from jobs where id = 'job_a'`)).rows[0];
  assert.equal(job.quota_released, false);
  assert.equal(Number(job.created_at), T);
  const lots = (await db.query(`select sum(remaining)::int as left from credit_lots where user_id = 'u1'`))
    .rows[0];
  assert.equal(lots.left, 20);
  const ledger = (await db.query(`select sum(delta)::int as net from credit_ledger where user_id = 'u1'`))
    .rows[0];
  assert.equal(ledger.net, 20);
});

test('import-d1: a rehearsal writes nothing', async () => {
  const db = await target();
  const report = await importDump(db, readDump(schema + rows));
  assert.equal(report.applied, false);
  assert.equal(await count(db, 'user'), 0);
  assert.equal(await count(db, 'credit_lots'), 0);
});

test('import-d1: writes only to the database named, and only into a database with every table empty', async () => {
  const db = await target();
  await assert.rejects(
    importDump(db, readDump(schema + rows), { ...live, database: 'site_dev' }),
    /not the target/,
  );
  await assert.rejects(
    importDump(db, readDump(schema + rows), { ...live, database: undefined }),
    /not the target/,
  );
  // A table the export doesn't have (a rehearsal's leftover job run) must be empty too.
  await db.query(`insert into job_runs (id) values ('run_old')`);
  await assert.rejects(importDump(db, readDump(schema + rows), live), /job_runs is not empty/);
  await db.query('delete from job_runs');
  await importDump(db, readDump(schema + rows), live);
  await assert.rejects(importDump(db, readDump(schema + rows), live), /is not empty/);
});

test('import-d1: refuses an incomplete or empty export instead of reporting success', async () => {
  const db = await target();
  // No credit_lots: balances would be gone after the cutover.
  const withoutLots = schema
    .replace(/CREATE TABLE `credit_lots` \([\s\S]*?\n\);/, '')
    .replace(/^.*ON `credit_lots`.*$/gm, '');
  assert.ok(!withoutLots.includes('CREATE TABLE `credit_lots`'));
  await assert.rejects(
    importDump(db, readDump(withoutLots + rows.replace(/^INSERT INTO "credit_lots".*$/m, '')), live),
    /target table credit_lots is not in the source/,
  );
  await assert.rejects(importDump(db, readDump(''), live), /target table user is not in the source/);
  // A column missing from the export would take the target default (debt 0): refused.
  const noDebt = readDump(schema + rows);
  noDebt.credit_accounts.columns = noDebt.credit_accounts.columns.filter((c) => c !== 'debt');
  await assert.rejects(
    importDump(db, noDebt, live),
    /target column credit_accounts\.debt is not in the source/,
  );
  assert.equal(await count(db, 'user'), 0);
});

test("import-d1: a site's own tables new on Postgres must be listed with --new-tables", async () => {
  const db = await target('create table site_extras (id text primary key)');
  await assert.rejects(
    importDump(db, readDump(schema + rows), live),
    /target table site_extras is not in the source/,
  );
  const report = await importDump(db, readDump(schema + rows), { ...live, newTables: ['site_extras'] });
  assert.ok(report.notes.some((n) => n.includes('site_extras')));
  await assert.rejects(
    importDump(await target(), readDump(schema + rows), { ...live, newTables: ['jobs'] }),
    /--new-tables lists jobs/,
  );
});

test('import-d1: refuses source tables and columns with nowhere to go, writing nothing', async () => {
  const db = await target();
  await assert.rejects(
    importDump(db, readDump(`${schema}\nCREATE TABLE extra (id text);${rows}`), live),
    /source table extra/,
  );
  await assert.rejects(
    importDump(db, readDump(`${schema}\nALTER TABLE jobs ADD legacy text;${rows}`), live),
    /jobs\.legacy/,
  );
  assert.equal(await count(db, 'user'), 0);
});

test('import-d1: refuses values it would have to guess, and rolls the whole import back', async () => {
  const db = await target();
  // Seconds instead of milliseconds in a timestamptz column, after rows of other tables were already inserted.
  const bad = `${rows}\nINSERT INTO "verification" VALUES('v1','x','y',1795000000,${T},${T});`;
  await assert.rejects(importDump(db, readDump(schema + bad), live), /verification\.expires_at/);
  assert.equal(await count(db, 'user'), 0);
  assert.throws(() => toTarget('user', 'email_verified', 'boolean', 2n), /0 or 1/);
  assert.throws(() => toTarget('t', 'c', 'jsonb', '{nope'), /JSON/);
  assert.throws(() => toTarget('jobs', 'id', 'text', 5n), /not text/);
  assert.throws(() => toTarget('t', 'c', 'uuid', 'x'), /unknown target type/);
  assert.throws(() => toTarget('t', 'c', 'integer', 2_147_483_648n), /integer/);
  assert.equal(toTarget('t', 'c', 'integer', -2_147_483_648n), -2_147_483_648);
});

test('import-d1: integers beyond 2^53 come through the real dump path exactly', async () => {
  const db = await target();
  const big = `${rows}\nUPDATE jobs SET created_at = 9007199254740993 WHERE id = 'job_a';`;
  await importDump(db, readDump(schema + big), live);
  const { rows: back } = await db.query(`select created_at::text as t from jobs where id = 'job_a'`);
  assert.equal(back[0].t, '9007199254740993');
  // 2^53 and 2^53 + 1 must not compare equal.
  assert.notEqual(backToSource('bigint', '9007199254740992'), sourceComparable('bigint', 9007199254740993n));
});

test('import-d1: JSON compares by content, not key order, and decoded string scalars are not parsed again', () => {
  assert.equal(
    sourceComparable('jsonb', '{"b":1,"a":[2,{"d":3,"c":4}]}'),
    backToSource('jsonb', { a: [2, { c: 4, d: 3 }], b: 1 }),
  );
  assert.equal(sourceComparable('jsonb', '"plain text"'), backToSource('jsonb', 'plain text'));
  assert.notEqual(sourceComparable('jsonb', '{"a":1}'), backToSource('jsonb', { a: 2 }));
});

test('import-d1: an export inside a repository is refused, except under private-assets/', () => {
  const repo = path.resolve('/repo');
  assert.throws(
    () => assertDumpOutsideRepo(path.join(repo, 'sites', 'x', 'dump.sql'), repo),
    /private-assets/,
  );
  assert.throws(() => assertDumpOutsideRepo(path.join(repo, 'dump.sql'), repo), /private-assets/);
  assertDumpOutsideRepo(path.join(repo, 'private-assets', 'x', 'dump.sql'), repo, () => true);
  // private-assets/ that a build would still send to Docker is no exception.
  assert.throws(
    () => assertDumpOutsideRepo(path.join(repo, 'private-assets', 'x', 'dump.sql'), repo, () => false),
    /dockerignore/,
  );
  assertDumpOutsideRepo(path.resolve('/elsewhere/dump.sql'), repo);
  // A directory whose name starts with ".." is still inside.
  assert.throws(() => assertDumpOutsideRepo(path.join(repo, '..notes', 'dump.sql'), repo), /private-assets/);
  // Run from a worktree or a submodule: the other checkout is a build context too.
  const other = path.resolve('/repo-worktree');
  assert.throws(
    () => assertDumpOutsideRepo(path.join(repo, 'sites', 'x', 'dump.sql'), [other, repo]),
    /private-assets/,
  );
  assertDumpOutsideRepo(path.join(repo, 'private-assets', 'x', 'dump.sql'), [other, repo], () => true);
});

test('import-d1: private-assets/ counts as ignored only when .dockerignore lists it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-d1-ignore-'));
  try {
    assert.equal(privateAssetsDockerIgnored(dir), false);
    fs.writeFileSync(path.join(dir, '.dockerignore'), '**/.env\nprivate-assets-old\n');
    assert.equal(privateAssetsDockerIgnored(dir), false);
    for (const line of [
      'private-assets',
      'private-assets/',
      '/private-assets',
      '**/private-assets',
      '  private-assets/**  ',
    ]) {
      // Written on Windows, too.
      fs.writeFileSync(path.join(dir, '.dockerignore'), `.git\r\n${line}\r\n`);
      assert.equal(privateAssetsDockerIgnored(dir), true, line);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('import-d1: a schema-only export (--no-data) is refused, not verified 0 against 0', async () => {
  const db = await target();
  await assert.rejects(importDump(db, readDump(schema), live), /no rows at all/);
});

test('import-d1: refuses an integer a float column would round', () => {
  assert.throws(() => toTarget('t', 'c', 'double precision', 9007199254740993n), /too large/);
  assert.equal(toTarget('t', 'c', 'double precision', 9007199254740992n), 9007199254740992);
  assert.throws(() => toTarget('t', 'c', 'real', 16777217n), /too large/);
});
