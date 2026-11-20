# Migrating a site from Cloudflare Workers

For a site built on shipwords v0.2.0 or earlier, which runs as a Cloudflare Worker with D1, R2 bindings, a Workflow and a compose container, and is moving to the current runtime: a Docker container on your own machine with Postgres. New sites start on the new runtime and don't need this page.

Steps marked **(confirm)** touch production, create credentials or cost money; an AI agent must get explicit confirmation before running them. Read the [site launch handbook](site-launch.md) first: this page only covers what is different for a site that already has users, orders and files.

## What changes and what stays

| Part                  | Workers (v0.2.0)                     | Now                                                                    |
| --------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| Process               | Worker, `wrangler deploy`            | Docker container (`start.mjs`, srvx) behind a reverse proxy            |
| Database              | D1 (SQLite)                          | Postgres, one database and role per site                               |
| Money writes          | D1 batches + optimistic lock         | transactions + row locks; same ledger tables and idempotency keys      |
| Jobs                  | Cloudflare Workflow                  | `job_runs` / `job_steps` in the site's database, run by the job worker |
| Files                 | R2 binding                           | same R2 bucket through its S3 API (`S3_*`); keys and lifecycle stay    |
| Video stitching       | a compose container per job          | one long-running compose service per machine (`COMPOSE_URL`)           |
| Email, image describe | `send_email` and Workers AI bindings | the same Cloudflare products through their REST API (`CLOUDFLARE_*`)   |
| Config                | `wrangler.jsonc` vars + secrets      | `.env` read once at start                                              |

The site's pages, `site.config.ts`, `site.models.ts`, `src/models.server.ts`, prices, users, credits, orders and outputs carry over unchanged. Payment providers, Google sign-in and reCAPTCHA keep working with the same accounts; only the webhook endpoint's host changes, and the domain stays the same.

## 1. Credentials (confirm)

Worker secrets are write-only: you cannot read them back from Cloudflare. Collect each value from where it was created, or make a new one.

- **New, because the binding has no key:** an R2 API token with object read and write on the site's bucket only (its S3 credentials go into `S3_*`); a Cloudflare API token with Email Sending (and Workers AI if the site uses `effect.describe`); a Cloudflare origin certificate for the domain (the proxy on the machine serves it; SSL mode Full (strict)).
- **Reused:** `GOOGLE_*`, `RECAPTCHA_*`, `YIR_API_KEY`, the PayPal app. Stripe shows a secret key only once: if you don't have it, create a second restricted key with the permissions the site uses, and delete the old key after the move. The Stripe webhook signing secret can be revealed again on the endpoint page, so the same endpoint keeps working.
- **`BETTER_AUTH_SECRET` and `GUEST_COOKIE_SECRET`:** reuse them if you have them. New values sign everyone out and give every guest a fresh guest quota; nothing else is lost.

Keep the production `.env` outside every repository and back it up the way you back up other secrets.

## 2. Port the code

Compare with `templates/ai-site`, which is the reference for every file below. Work on a branch; the Worker keeps serving from main until the cutover.

1. **Build and runtime.** `package.json`: drop `wrangler`, `@cloudflare/*` and the `deploy`/`deploy:preview`/`cf-typegen` scripts; add `pg`, `srvx` and the `start`/`db:*` scripts the template has. `vite.config.ts`: remove `@cloudflare/vite-plugin`. `tsconfig.json`: drop the Workers types. Delete `wrangler.jsonc`, `worker-configuration.d.ts` and `.dev.vars*`.
2. **New files from the template:** `start.mjs`, `migrate.mjs`, `replace-output.mjs` (if the site uses it), `Dockerfile`, `compose.yaml`, `.env.example`, `drizzle.config.ts` (dialect `postgresql`). Set the image and compose project names for the site.
3. **`src/server.ts`.** Keep the site's own routes; copy the template's shape around them: wrap the incoming request with `publicRequest(request, process.env.APP_URL)` before anything reads `request.url` (behind the proxy the server sees `http://`, and same-origin checks would otherwise fail with 403), answer `/healthz` without the database, export `admin` and `shutdown`, and call `startJobWorker()` once at module load. Remove any http→https or www redirects from the app; Cloudflare does those.
4. **`src/core.server.ts`.** Build core and jobs from `process.env` the way the template does: one Postgres pool, one object store, the mailer, `startSiteJobWorker` with the site's models. `defineGenerationWorkflow` and its Workflow class go.
5. **Bindings in the site's own code:**
   - `env.OUTPUTS` (R2) → the shared `ObjectStore` (`get` with ranges, `head`, `put`). It has no `list`, no `delete` and no custom metadata: anything the site found by listing keys or stored in R2 metadata becomes a table in the site's schema (and a `--new-tables` entry when you import, see §4).
   - Serving an object with ranges → `objectResponse` from `@shipwords/jobs/object-range`.
   - `env.COMPOSE` / `containerComposer` → `httpComposer(process.env.COMPOSE_URL, store)`.
   - `env.EMAIL` → the core mailer; `env.AI` → `workersAiDescribe` with `CLOUDFLARE_*`.
   - `env.X` vars and secrets → `process.env.X`, validated where the site starts.
   - Origin checks compare against `APP_URL`, not `request.url`.
6. **Schema.** Change the site's own tables from `sqlite-core` to `pg-core` (millisecond integers that the code compares as numbers stay `bigint` with `mode: 'number'`; flags become `boolean`; JSON text can stay `text`). Delete the old D1 migrations and generate fresh ones with `pnpm db:generate`. The engine's tables come from the packages; don't copy them.
7. **Assets the site serves itself.** srvx serves `public/` with ranges. Sample files kept in a local object store need their content type: `fileStore` reads it from a `<file>.meta.json` next to each file.
8. **Tests.** Move site tests to Node: an in-memory PGlite with the site's migrations applied (see `packages/jobs/test/db.ts`) and `memoryStore()` for files. If the site changes what is sent upstream, keep a test that loads the real `site.models.ts` and `src/models.server.ts`, runs the real request construction and validates it with the installed upstream SDK.
9. **Docker build context.** A repository that vendors shipwords builds images from its own root; copy shipwords' `.dockerignore` there, or the build stops when it sees a `.env`.

Check locally: `pnpm --filter "./sites/<dir>" check`, then `docker compose up --build` and walk the whole flow once in Stripe test mode (sign in, buy, generate, receive the email, download). [Local development](local-development.md) covers the setup.

## 3. Machine (confirm)

Follow [launch handbook §3–5](site-launch.md#3-machine-and-database-confirm) for the database, role, `.env`, firewall and proxy. Things that came up in real moves:

- Several sites on one machine: one shared Postgres and one compose service on an internal Docker network, each site attached to it plus its own network for outbound calls. Docker does not publish ports of a container that is only on an internal network; if a host-side tool (backups) needs Postgres on `127.0.0.1`, attach Postgres to a second bridge with outbound NAT disabled (`com.docker.network.bridge.enable_ip_masquerade: "false"`).
- The compose service's background concurrency (`MAX_JOBS`) is shared by every site on the machine. A site that stitches inside a request (not in a job) passes `{ lane: 'interactive' }` to `httpComposer`, so it uses the interactive lane (`MAX_INTERACTIVE_JOBS`) instead of waiting behind other sites' background work. Measure the service's memory with the heaviest site's jobs running side by side: one swap check, likeness check or repair cut of a 720×1280, 18 s video takes about 0.8–0.9 GiB, so two background slots plus an interactive one need about 3 GiB.
- Proxy: allow request bodies at least as large as the site's biggest upload, and keep `proxy_read_timeout` below Cloudflare's 125 s origin read timeout but above the slowest request the site serves.
- If the proxy listens on IPv4 only, create proxied **A** records only. A proxied AAAA record makes Cloudflare try the origin over IPv6 and fail; visitors still reach the site over IPv6 through Cloudflare.
- Backups: a daily logical dump of each site database (encrypted, off the machine) and one restore drill before the cutover. Payments can be reconciled from the provider; everything else since the last dump is lost in a disaster, so pick the interval with that in mind.

Start the site container on the machine before the cutover, pointed at its empty database (`node migrate.mjs`, then `up -d`), and check it through the proxy with a hosts entry or `curl --resolve`.

## 4. Rehearse

Do the whole data move once against a scratch database before the real one:

```bash
# In the site directory. Read-only on D1. The export holds sessions, users and payments: keep it outside every repository
# (a gitignored private-assets/ is accepted) and never in a Docker build context.
npx wrangler d1 export <d1 database> --remote --output /safe/place/<site>-d1-rehearsal.sql
DATABASE_URL=<scratch database> node ../../tools/import-d1.mjs /safe/place/<site>-d1-rehearsal.sql [--new-tables a,b]
```

From a repository that vendors shipwords the tool is at `vendor/shipwords/tools/import-d1.mjs`; run it from the site directory, which provides `pg`. Without `--yes` it writes everything, reads every row back, compares it with the export and rolls back. It refuses rather than guesses:

- a source table or column the target lacks (apart from `credit_accounts.version`, the D1 lock counter);
- a target table the export lacks, apart from the engine's new `job_runs`/`job_steps` and the tables you list with `--new-tables` (the site's own tables that are new on Postgres). This is what catches a partial or schema-only export;
- a target column the export lacks, which would otherwise silently take its default;
- a value it would have to convert by guessing: a timestamp that isn't in milliseconds, a flag that isn't 0/1, invalid JSON, an integer a column can't hold;
- a target database with any rows in any table.

Data the Worker kept outside D1 (R2 listings or metadata, KV) doesn't come with the export: write a one-off script that fills the new tables from it, and run it in the rehearsal too.

## 5. Cutover (confirm)

Pick a quiet moment, and wait until no job is queued or running on the Worker (check `jobs.status` in D1). The job worker gives queued jobs without a run a fresh run, but a job that was mid-way on the Worker would start its steps again and could pay the upstream twice.

1. Final export of D1 (`wrangler d1 export … --remote`), outside every repository.
2. Import for real: run the tool without `--yes` against the site's real database, check the printed target, then again with `--yes --database <the name it printed>`.
3. Fill any tables from non-D1 data (step 4).
4. In Cloudflare: remove the Worker's custom domains (and routes) for the site, create the proxied DNS records pointing at the machine, and set SSL to Full (strict). Cloudflare switches within seconds.
5. Check: home page and a few pages through the domain, sign-in, the payment provider's webhook endpoint answers 400 to an unsigned request, `docker compose logs -f site` is clean, and D1 received no new writes after the export.
6. Make the old deploy impossible: empty the Worker's `routes`, and make main's deploy scripts fail with a message pointing at the new deploy, so nobody redeploys the Worker onto the domain by habit.
7. Run one real paid generation (the cheapest product), and check that credits, the job, the output in R2, the email and the download all work.

**Rollback** is only a DNS change while the new database has no business writes since the cutover (orders, payments, ledger entries, jobs): delete the new records and bind the domains back to the Worker. After the first write, stop writes on the new site and copy those rows back into D1 first; webhooks the new site already accepted won't be delivered again.

## 6. After the move

- Watch the first real orders and the provider's webhook log for a few days.
- After about a week without rollback **(confirm)**: delete the Worker, the D1 database and the old provider keys; keep the final D1 export with your other private backups.
- Update the site's README and runbooks: how it deploys now, where the database and backups live.
