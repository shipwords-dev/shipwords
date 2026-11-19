# Local development

## First-time setup

1. Node 24 (see `.nvmrc`) and pnpm 10 (`corepack enable`). Keep the pnpm store on the same disk as the repo so hard links work.
2. A Postgres 17 you can reach, for example in Docker:

   ```bash
   docker run -d --name shipwords-pg -e POSTGRES_PASSWORD=<password> -p 127.0.0.1:5432:5432 postgres:17-alpine
   ```

   Each site gets a database of its own (for example `<site>_dev`) and a role that owns it.
3. `pnpm install`
4. Keep each site's settings outside the repo: copy the site's `.env.example` to `~/.config/shipwords/<site-dir>.env` (set `SHIPWORDS_SECRETS` to use another directory). Set `DATABASE_URL` to the site's database and use test keys only (`sk_test_`, PayPal sandbox, a test reCAPTCHA key).
5. `pnpm setup:worktree`: copies each file into its site as `.env` and sets `APP_URL` to this worktree's dev port.

The example file runs as it is once `DATABASE_URL` is set: sign-in codes go to the log (`MAIL_LOG=1`), files go to a local directory (`STORAGE_DIR`), and generations use the mock upstream (`UPSTREAM_MOCK=1`). A [Yir API key](https://yir.ai/?utm_source=shipwords&utm_medium=docs) (`YIR_API_KEY`) is only needed for real generations.

## Running a site

```bash
cd sites/<site>
pnpm db:generate        # after schema changes in packages or in this site
pnpm db:migrate         # apply migrations to DATABASE_URL
pnpm dev                # the site's devPort from package.json; a worktree adds 1-9
```

- `pnpm dev`, `pnpm start`, `pnpm preview` and `pnpm db:migrate` load `.env` with `node --env-file-if-exists`. The server reads its settings once at start, so restart it after editing `.env`.
- The job worker runs inside the dev server; set `JOB_WORKER=0` to run pages and API only.
- **Sign-in codes:** with `MAIL_LOG=1` and no Cloudflare credentials, every email, sign-in codes included, is written to the server log (`email (not sent)`) instead of being sent. A production build ignores `MAIL_LOG`, so a deployed site without credentials fails to send rather than logging codes. With `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` set, mail is really sent, also locally.
- **Files:** without `S3_*` settings, uploads and outputs are stored under `STORAGE_DIR` (`./.data/files` in the site directory). Sites that rely on reference assets (`assets/...`) need them at the same keys there, or `S3_*` pointed at a bucket that has them.
- **Mock upstream:** `UPSTREAM_MOCK=1` (see `packages/jobs/src/mock.ts`) makes no Yir calls and needs no compose service; outputs are replaced with reference assets (text-only image jobs get `public/mock-output.png`). Use it to test upload, charging, polling, delivery and refunds; set `UPSTREAM_MOCK=fail` to test refunds. The mock only activates when `APP_URL` is a local host or every payment credential is in test mode.
  - For real generations, remove `UPSTREAM_MOCK` and set `YIR_API_KEY`.
- **Compose service:** effect sites that stitch video need it for real generations. Run it in Docker and point the site at it:

  ```bash
  docker build -t shipwords-compose packages/jobs/compose     # from the repo root
  docker run --rm -p 127.0.0.1:8080:8080 shipwords-compose
  ```

  Then set `COMPOSE_URL=http://localhost:8080` in `.env`.
- **The whole site in containers:** `docker compose up --build` in the site directory builds the production image and runs it with its own Postgres and the compose service, as on a server. It reads the same `.env`, which then also needs `POSTGRES_PASSWORD` (or `SITE_DATABASE_URL` for a database you already run, at an address the container can reach), and `APP_URL=http://localhost:3000` while you run it this way. Apply migrations first with `docker compose run --rm site node migrate.mjs`. The image is a production build, so `MAIL_LOG` is ignored there.
- The dev server listens on `127.0.0.1` only. If a client resolves `localhost` to `::1`, call `127.0.0.1` and send `Origin: http://localhost:<port>` (Better Auth checks the origin).
- Google sign-in locally must use `localhost`, not `127.0.0.1`, and the origin and callback must be registered on your OAuth client.

## Lock and concurrency tests

Unit tests run on in-memory PGlite and need nothing. `pnpm --filter @shipwords/core --filter @shipwords/jobs test:pg` checks row locks and races against a real Postgres and is skipped unless `TEST_DATABASE_URL` is set. Point it at any Postgres 17 where the role may create databases (`CREATEDB`, no superuser needed); each test file creates its own database and drops it. Keep the URL in a file outside the repo and load it before running, e.g. `set -a; . ~/.config/shipwords/test.env; set +a`.

## Stripe webhooks locally

From the site directory:

```bash
node ../../tools/stripe-listen.mjs
```

It starts `stripe listen` with the test key from `.env`, forwards events to `<APP_URL>/api/webhooks/stripe`, and writes the current `whsec_` signing secret back into `.env`. Restart `pnpm dev` when it reports a changed secret. It refuses live keys. Requires the [Stripe CLI](https://docs.stripe.com/stripe-cli).

## PayPal sandbox

- On developer.paypal.com, switch to Sandbox and use a sandbox REST app. Put its Client ID and Secret into the site's `.env` with `PAYPAL_ENV=sandbox`.
- Under Testing Tools, Sandbox Accounts, use a personal (buyer) account to pay. The browser may autofill your real email on sandbox.paypal.com; switch to the sandbox buyer.
- Webhooks need a public URL. Use a temporary Cloudflare quick tunnel:

  ```bash
  : > /tmp/cf-empty.yml
  cloudflared tunnel --config /tmp/cf-empty.yml --protocol http2 --url http://127.0.0.1:<port>
  ```

  The empty `--config` matters if you have a named tunnel in `~/.cloudflared/config.yml`: without it, cloudflared may connect as that tunnel and send its production traffic to your dev server. If the log mentions `cred-file`, stop it.
- Allow the tunnel host in the dev server: `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.trycloudflare.com pnpm dev`.
- In the sandbox app, set the webhook URL to `<tunnel URL>/api/webhooks/paypal` with the events listed in the [launch handbook](site-launch.md), and put the webhook ID into `PAYPAL_WEBHOOK_ID`. Quick tunnel URLs change on every run, so re-register each time.

## Worktrees

- After `git worktree add`, run `pnpm install && pnpm setup:worktree` inside it.
- Tools that copy ignored files into new worktrees (for example Claude Code's `.worktreeinclude`) can bring `.env` along; still run `pnpm setup:worktree` to fix the ports.
- `setup:worktree` copies the same `DATABASE_URL` into every worktree. Two worktrees that run the same site at once should use separate databases: change `DATABASE_URL` in one worktree's `.env` and run `pnpm db:migrate` there.
