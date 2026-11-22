# Node and Postgres runtime

Status: merged into `main` on 2026-11-22. Steps 2–6 (database, job runs, interfaces, template, tools/CI/docs) are done, and step 7 is done for real sites: two sites run in production on it (moved 2026-11-19 and 2026-11-22, their D1 data imported with `tools/import-d1.mjs`, R2 over S3, email and a shared compose service on the server, paid generations checked end to end). What is left is the example-site sync: `sites/tinydeskai-example` is still the Cloudflare Workers version of release `v0.2.0`. Moving a site is written up in [docs/migrating-from-workers.md](../migrating-from-workers.md); `docs/architecture.md`, `docs/local-development.md` and `docs/site-launch.md` describe the new setup. This page goes once the example site is moved.

A site becomes a Node server in a Docker container with a Postgres database. Cloudflare Workers, D1, Workflows and Containers stop being a runtime; Cloudflare stays in front as DNS, CDN and WAF, and R2 stays as object storage.

## Why

- **Money code.** D1 has no interactive transactions, only atomic batches. The credit ledger works around it with a per-user version lock and a deliberate CHECK violation to roll a batch back (`credits/ledger.ts`). Postgres transactions and row locks say the same thing directly.
- **No Durable Objects.** Anything stateful on Workers is a Durable Object: the compose container already is, and its `sleepAfter` behavior cost 984 idle instance-hours before anyone noticed (§6 of the architecture doc). A long-running process on a fixed-price machine has no such failure mode.
- **Debuggable.** The whole stack, ffmpeg included, runs locally and logs to stdout. Today containers are off in local dev and production has Workers Logs only.
- **Predictable cost.** A machine has a price cap; usage-billed products do not.

## Non-goals

- **One runtime, not two.** The Workers code paths are deleted, not kept behind an adapter. Someone who wants Workers or SQLite ports it; the seams below (step runner, object store, mailer) are what keep that port small.
- No database abstraction beyond Drizzle, no generic workflow engine, no queue service, no Temporal.

## What changes

| Concern         | Today                                         | After                                                                 |
| --------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| Server          | One Worker per site                           | One Node process per site, in a container: pages, API and job worker  |
| Database        | D1, `drizzle-orm/d1`, SQLite dialect          | Postgres, one database per site, Drizzle `pg-core`                    |
| Job runtime     | Cloudflare Workflows                          | `job_runs` and `job_steps` tables, a worker loop in the site process  |
| Compose         | Cloudflare Container per job (Durable Object) | One long-running compose service per machine, reached over HTTP       |
| Object storage  | R2 binding                                    | `ObjectStore` interface; S3 API against the same R2 bucket            |
| Email           | `send_email` binding                          | `Mailer` interface; Cloudflare Email Service REST API by default      |
| Describe        | Workers AI binding                            | Workers AI REST API behind the existing `RunnerDeps.describe`         |
| Config, secrets | `wrangler.jsonc`, `.dev.vars`, Worker `env`   | `process.env`, validated once at start; `.env` files outside the repo |
| Tests           | workerd with in-memory D1                     | Node with PGlite per test file; a small suite against a real Postgres |
| Preview, deploy | `wrangler versions upload`, `wrangler deploy` | Build an image; the owner runs it                                     |

Sites stay isolated at runtime: each has its own container, database, bucket prefix, secrets and payment account. Only the machine, the Postgres instance and the compose service are shared.

## 1. Database

- **Driver and type.** `drizzle-orm/node-postgres` in the app, `drizzle-orm/pglite` in tests (both ship in the installed drizzle-orm 0.45.4). `Db` is typed as the driver-neutral `PgDatabase`, so engine code never names a driver. `createDb` takes a connection string (`DATABASE_URL`).
- **Schema.** The two schema files (`core/src/db/schema.ts`, `jobs/src/schema.ts`) are rewritten with `pgTable`:
  - business timestamps stay epoch milliseconds, as `bigint` in number mode, so comparisons and arithmetic in the engine are untouched; the default becomes `(extract(epoch from clock_timestamp()) * 1000)::bigint`;
  - Better Auth tables use `timestamp` and `boolean`, which is what its `pg` provider expects; `drizzleAdapter` switches from `provider: 'sqlite'` to `'pg'`;
  - flags stored as 0/1 integers become `boolean`; JSON stays in `text` columns (`input_json`, `quota_json`, `outputs_json`), parsed by the engine as today.
- **Raw SQL.** Six files use `sql` fragments. Each is checked for dialect: scalar `max(x, 0)` becomes `greatest(x, 0)`, boolean comparisons with `0` become `false`.
- **Row counts.** `result.meta.changes` (D1) is used for conditional updates in `quota/counters.ts` and `jobs/lifecycle.ts`. It becomes `.returning()` plus a length check, which is the same on every driver.
- **Constraint errors.** `isConstraintError` matches D1 message text today. It will match SQLSTATE `23505` (unique) and `23514` (check) plus the constraint name.
- **Transactions.** The two `db.batch` call sites become `db.transaction`:
  - `credits/ledger.ts`: lock the user's `credit_accounts` row with `SELECT … FOR UPDATE`, read the lots, write. The version column, the retry loop and the forced CHECK violation go away. Idempotency keys (unique) and CHECK constraints stay as the backstop they are today.
  - `jobs/lifecycle.ts`: returning a failed guest job's quota and setting its `quota_released` flag commit together, as they do in the batch today. Job state changes stay single conditional updates.
- **Migrations.** Existing SQLite migrations are dropped and one baseline is generated per package and site. `pnpm db:migrate` applies them with the Drizzle migrator; a container never migrates on its own at start.

## 2. Job runs

`runner.ts` already depends only on `StepRunner` (`do(name, fn)`, `sleep(name, ms)`), its steps run strictly in sequence, and it is written for replay: step names are fixed, the job timeout counts from creation, upstream calls carry the job ID as idempotency key. None of that changes. What Workflows provided is rebuilt on two tables.

**Tables** (in `jobs/src/schema.ts`)

- `job_runs`: `id` (the job ID, primary key), `status` (`pending`, `done`, `dead`), `run_after`, `locked_by`, `locked_until`, `pickups`, `created_at`, `finished_at`.
- `job_steps`: `run_id`, `name` (primary key together), `result` (jsonb), `attempts`, `error`, `done_at`.

**Dispatch.** `handlers.ts` inserts the `job_runs` row in the same transaction as the job row and the debit (`ON CONFLICT DO NOTHING`), instead of calling `GENERATION_WORKFLOW.create` afterwards. A job can no longer be charged without a run, so the `dispatch_failed` path and the ambiguous-dispatch grace logic are removed.

**Worker loop.** Each site process claims runs once a second, and at once when a job is created in the same process:

```sql
UPDATE job_runs SET locked_by = $me, locked_until = $now + 60000, pickups = pickups + 1
WHERE id IN (
  SELECT id FROM job_runs
  WHERE status = 'pending' AND run_after <= $now AND (locked_until IS NULL OR locked_until < $now)
  ORDER BY created_at LIMIT $free FOR UPDATE SKIP LOCKED
) RETURNING id;
```

It extends `locked_until` every 20 s for the runs it holds and runs `runGeneration` for each, up to a slot limit (jobs mostly wait on the upstream, so 20 by default). `JOB_WORKER=0` turns the loop off for a process that should only serve pages.

**Step runner**

| Workflows behavior                       | Here                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A finished step returns its saved result | `do` reads `job_steps`; a row with `done_at` returns `result` without running `fn`                                                       |
| Step retries: 5, from 10 s, exponential  | On a throw, `attempts` is saved; the same process waits 10 s × 2^(n−1) and runs `fn` again; after 5 retries the error goes to the runner |
| `sleep`                                  | Awaited in process (the runner sleeps 3 s and 30 s), then recorded so a replay doesn't sleep again                                       |
| Resume after a crash                     | The lease expires, another loop claims the run and replays it; finished steps return from the table                                      |
| One instance per ID                      | The primary key, plus the lease                                                                                                          |
- **At least once.** A step whose `fn` finished but whose row was not written runs again after a crash. Workflows has the same property and the runner's steps are already idempotent.
- **Lease check.** Before running any `fn` and in the transaction that records a step, the runner confirms it still holds the lease. If it does not, `do` throws without running `fn`. This matters because `runGeneration` catches errors and runs an `abort` step: with the check, that step throws too, so a process that lost its lease can never fail and refund a job another process is finishing.
- **Shutdown.** On SIGTERM the loop stops claiming, lets steps in flight finish within the container's stop grace period, then releases its leases so the next process picks the runs up at once. Stopping uses the same throw-before-`fn` path as a lost lease. Deploys no longer need zero jobs in flight; step names must stay stable across versions, as today (`runner.test.ts` and `effects.test.ts` lock them).
- **Poison runs.** A run claimed more than 10 times is marked `dead`, and the job is failed `stale` and settled without running the runner. The read-time stale check in `handlers.ts` stays as a second backstop. This also closes a known gap: a stuck job nobody looks at is now refunded by the loop.
- **Cleanup.** Step rows of finished runs are deleted after 30 days.

As built (2026-11-18, after four review rounds) the design above changed in these ways:

- **Claim tokens.** Each claim writes its own token into `locked_by`; step writes, heartbeats and releases match that claim, and a process never claims a run it is still executing.
- **Fenced outcome writes.** `markFailed`, `markSucceeded`, `markSubmitted`/`appendUpstreamJob` and `markForReview` take an optional `Fence` (run ID + claim token) and apply only while that claim holds an unexpired lease. The worker passes each run's fence to the runner, and wraps its adapters so `cancel` reaches the upstream only while the claim is held. Handlers write without a fence.
- **Attempts.** `step.do` records each attempt under the lease before running it and passes the attempt number to the step. A submit (main, repair, hedge) past the deadline places nothing on a first attempt; on a later one it submits again with the same key to recover a task the upstream may hold, and the timeout cancels it. The retry budget is spent only by attempts that failed with an error.
- **No per-step timeout.** A slow call is never retried around (it would race its own retry). A run still going 15 minutes after its job's deadline is buried by the heartbeat: in one transaction holding the run row, upstream tasks (including hedge copies) are canceled, the job is failed `stale` and refunded, and the run ends.
- **The worker's own database errors** hand the run back after a delay without counting toward poison.
- **Cancel vs. submit.** A user cancel holds the run row (as a step does to start an attempt) and is refused once a submit has started.
- **Backfill.** At start, and on each poll until it succeeds, the worker queues a run for every job in progress that has none.

Known limit: a lease is time-based. A worker that loses it while still alive (frozen for longer than the lease, or cut off from the database for heartbeats but not for other writes) can still finish one statement it had already started: a fenced write that began before the takeover, or an upstream call already in flight. Each such window is bounded by one statement or one call, and with one worker process per site and `SIGTERM` then `SIGKILL` on deploy it needs a paused process. Closing it fully would mean holding run ownership with a Postgres session-level advisory lock instead of a time lease.

## 3. Bindings become interfaces

- **Env.** `createCore` and the worker read `process.env` once at start and fail fast on a missing value. `CoreEnv` and `JobsEnv` keep their secret names; `DB`, `OUTPUTS`, `EMAIL`, `AI`, `COMPOSE` and `GENERATION_WORKFLOW` are replaced by `DATABASE_URL`, `S3_*`, `MAIL_*`, `WORKERS_AI_*` and `COMPOSE_URL`.
- **`ObjectStore`.** The engine uses `get` (with ranges), `head` and `put` on the bucket, in 5 files. An interface with those three methods replaces `R2Bucket`. Two implementations: S3 (against R2, so existing keys, lifecycle rules and free egress stay) and a filesystem directory for local dev and tests.
- **`Mailer`.** `send({ to, from, subject, html, text })`, the shape used at the 5 `env.EMAIL.send` call sites. Default implementation: the Cloudflare Email Service REST API (`POST /accounts/{id}/email/sending/send`), which keeps a site's verified sending domain. SMTP is a few lines for anyone who prefers it.
- **Describe.** `workersAiDescribe` calls the Workers AI REST API instead of the binding; the `describe` dependency and its best-effort behavior are unchanged.
- **Client IP.** The engine reads `cf-connecting-ip` (`http.ts`, `analytics.ts`, Better Auth). Behind a reverse proxy this header is only trustworthy if the origin accepts traffic from Cloudflare alone. The launch guide must say so: firewall the origin to Cloudflare's ranges, or have the proxy drop the header from other sources. Guest quotas depend on it.

## 4. Compose service

`packages/jobs/compose/` keeps its image, endpoints and multipart interface. It changes from one instance per job to one long-running service per machine:

- idle exit and the lifetime cap become opt-in (they exist only because an idle Cloudflare container bills); the SIGTERM handler stays;
- a semaphore caps concurrent ffmpeg and face-check work;
- job directories under `/tmp/compose` are removed by age, since no instance teardown does it any more;
- it listens on the internal Docker network only.

`containerComposer(namespace, bucket)` becomes `httpComposer(baseUrl, store)`. Passing file references instead of multipart bodies is a later optimization, not part of this change.

## 5. Site app and template

- `vite.config.ts` drops `@cloudflare/vite-plugin` and adds no platform plugin. The build writes `dist/client` and `dist/server/server.js`, whose default export is the site's own `src/server.ts` handler; `srvx --prod -s ../client dist/server/server.js` serves it (srvx becomes a direct dependency). Nitro is not needed.
- `src/server.ts` keeps its fetch handler (Rybbit proxy, then TanStack Start) and also starts the worker loop; `defineGenerationWorkflow` becomes `startJobWorker(models, site)`. srvx calls `fetch(request)` without an `env`, so the handler reads config from the validated process env.
- `wrangler.jsonc`, `worker-configuration.d.ts` and `wrangler types` go. The template gains a `Dockerfile`, an example `compose.yaml` (site, Postgres, compose service) and `.env.example`.
- Scripts: `start`, `db:migrate`; `deploy` and `deploy:preview` are removed.
- Static files and sample videos are served by srvx's static handler or the reverse proxy; srvx answered a `Range` request with 206 in the spike.

## 6. Tests

- Vitest runs in Node. Each test file gets a fresh in-memory PGlite with migrations applied (`drizzle-orm/pglite/migrator`) and a temp-directory object store. No ports and no shared database, so parallel worktrees still don't interfere. Starting PGlite and migrating took about 1.2 s in the spike, so tests share one instance per file and clear tables between tests rather than start one per test.
- PGlite is a single connection: transactions queue, they do not contend. Lock behavior needs a real server, so a second suite (`pnpm test:pg`) runs against Postgres for: concurrent debits on one user, the `SKIP LOCKED` claim with two workers, lease expiry and takeover, lost-lease writes being refused. CI runs it with a Postgres service container; locally it needs Docker and is skipped without `TEST_DATABASE_URL`.
- The 12 test files that import workerd modules, and the two migration helpers, move to the new setup. Existing money tests (duplicates, out-of-order events, partial failures) are kept and must pass unchanged in meaning.
- New engine tests: replay after a crash at every step boundary of a mock job, retry backoff, shutdown mid-step, poison run, duplicate dispatch.

## 7. Tools, CI, docs

- `new-site`, `check-site` and `replace-output` read wrangler config today; they switch to `.env.example`, `compose.yaml` and the object store. `setup-worktree` copies `.env` instead of `.dev.vars`. `check-site` keeps its route, policy-page and cross-site-import checks.
- CI adds the Postgres service and `test:pg`.
- README (both languages), `apps/www`, `docs/architecture.md`, `docs/local-development.md` and `docs/site-launch.md` are rewritten for Docker and Postgres. The example site is re-synced after its source site has moved.
- An existing D1 deployment moves by exporting D1 and loading it with type conversion (epoch integers to `timestamp` for auth tables, 0/1 to `boolean`); R2 keys do not change. `tools/import-d1.mjs` does the load and checks every row; [docs/migrating-from-workers.md](../migrating-from-workers.md) is the whole procedure.

## Order of work

1. **Spikes** (below): three passed; the email send is pending.
2. **Database (done, 2026-11-18):** schema, `createDb`, ledger and lifecycle transactions, test setup on PGlite, `test:pg`. Gate: `core` and `jobs` checks green, independent review of the money paths. Credit amounts are capped at the Postgres `integer` range (2,147,483,647); the R2 binding is replaced in tests by an in-memory stand-in until step 4.
3. **Job runs (done, 2026-11-18):** tables, loop, step runner, dispatch in `handlers.ts`; described in `docs/architecture.md` §6.1. The known limit on time-based leases is under §2.
4. **Interfaces (done, 2026-11-18):** object store (`jobs/src/store.ts`: S3 via aws4fetch, local directory, memory), mailer (`core/src/email/mailer.ts`: Cloudflare Email Service REST, log-only for local sites), describe (Workers AI REST), compose over HTTP (`httpComposer`; the service caps concurrent work at MAX_JOBS, sweeps work directories after KEEP_MS, and only stops itself when IDLE_EXIT_MS / MAX_LIFETIME_MS are set). Not yet run against the real services: S3 signing against R2 (tested against a fake; no local S3 image could be pulled), the email REST payload (`from` as `{ address, name }` per the docs), and the Workers AI REST call with an `image_url` part (the body the binding accepted; the REST docs don't show image input). All three are checked at step 7 with real credentials.
5. **Template (done, 2026-11-18):** Node build, Dockerfile, `compose.yaml`; a full mock-upstream order in containers on a dev machine. As built: `start.mjs` serves the build with srvx (static files with byte ranges) and on SIGTERM stops the server, then the job worker; `core.server.ts` starts the worker with the server (`JOB_WORKER=0` turns it off); `migrate.mjs` applies migrations as its own step; settings come from `.env` (`.env.example`), loaded with `node --env-file-if-exists` locally. Verified in Docker with the mock upstream: email-code sign-in, sign-up bonus, charge, worker run, output and byte-range download, refund of a failed job, a run interrupted by a container restart handed back and finished by the new container, and a clean 1 s stop. Not covered: Stripe checkout (needs a real test key), the compose service image, an effect job. Two things learned: a production build ignores MAIL_LOG (Vite fixes NODE_ENV at build time), and Better Auth sends sign-in codes in the background, so a failed send is only logged while the API answers 200.
6. **Tools, CI, docs (done, 2026-11-18):** `new-site` writes `compose.yaml`, `Dockerfile` and `.env.example`; `check-site` reads `.env` the way Node does; `setup-worktree` and `stripe-listen` use `.env`. Replacing a delivered output moved from a wrangler-based tool into `packages/jobs/src/admin.ts`, run by the site's `replace-output.mjs` inside its container (checked against a throwaway database). CI builds the template and compose images besides the checks and `test:pg`. README (both languages), `apps/www` (pages and `llms.txt`), `AGENTS.md`, `CONTRIBUTING.md` and the three docs are rewritten. The example site stays on the `v0.2.0` Workers setup until step 7, and says so.
7. A real site moves, then the example site is re-synced. First site in production on 2026-11-19; S3 signing against R2, the email REST payload and the compose service over HTTP now run against the real services. The Workers AI describe call is not yet used by a live site. Learned on the way and written into the migration guide: behind the proxy the app must rebuild its public origin from `APP_URL`, a proxied AAAA record breaks an IPv4-only origin, Docker publishes no ports for internal-only containers, and request-path stitching shares the compose service's slots with other sites' jobs.

The generation release gate in `AGENTS.md` applies at step 7: actual site configuration through real request construction and SDK validation, and the first 5 live results looked at by a person.

## Spikes (2026-11-18)

Run in a worktree of this branch with throwaway code, not committed.

1. **Node build with the custom server entry: passed.** The template built with the Cloudflare plugin removed and `cloudflare:workers` aliased to a stub. `dist/server/server.js` exports the template's own handler (the Rybbit proxy is in it). Called from Node, `/` and `/terms` rendered 200 and `/robots.txt` served; under srvx, static files and a `Range` request (206) worked. The only failure was the handler reading `env` that srvx does not pass, covered in §5.
2. **PGlite: passed.** On a pg-core version of the Better Auth tables and `credit_accounts`, with `@electric-sql/pglite` 0.5.16 and drizzle-orm 0.45.4: drizzle-kit generated a Postgres migration and the PGlite migrator applied it; a transaction with `SELECT … FOR UPDATE` committed; a CHECK violation rolled back the whole transaction and surfaced SQLSTATE `23514`, a duplicate key `23505`; `.returning()` gave the row count of conditional updates; `greatest(x - 1, 0)` worked; bigint millisecond defaults came back as numbers. Better Auth 1.7.14 with `provider: 'pg'` ran an email OTP sign-in through `auth.handler`, returned a session with `Date` timestamps and wrote its database rate limit rows.
3. **Cloudflare Email Service REST API: not yet sent.** The endpoint exists (an unauthenticated call returns `Authentication error`). Sending needs an API token with email sending permission, which is a new credential, and the test sends a real email; both wait for the owner.
4. **Browser boundary: passed.** `check-site` (required routes, policy pages, server-only text in `dist/client`, cross-site imports) passed on the Node build output.

## Open decisions

- `node-postgres` or `postgres.js` as the app driver. Default `node-postgres`.
- Whether the loop should also listen on `LISTEN/NOTIFY` to pick up jobs created by another process. Not needed while one process per site runs both.
