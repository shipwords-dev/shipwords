# Architecture

shipwords is a monorepo for running one AI tool site per keyword. All sites share `packages/`; each site is deployed, configured and paid out on its own.

## 1. Goals

- **One keyword, one site.** Each site is a small, focused tool. Watch it after launch and keep investing in the ones that work.
- **Payments on day one.** New sites can get traffic from AI search quickly, so every site launches with login, credits and subscriptions already working.
- **Isolated payouts.** Each site has its own payment account, so a problem with one site does not spill over into the others.
- **Plain Node and Postgres.** One Node process per site in a Docker container, a Postgres database per site, files in an S3-compatible bucket (Cloudflare R2). Cloudflare stays in front as DNS, CDN and WAF.
- **Fully custom front ends.** Pages, components and styles belong to the site. Unique content is the main defense against looking like a template.
- **AI-friendly.** Configuration lives in code, every money path has tests, and checks run fast.

## 2. Stack

| Concern          | Choice                                                                   | Notes                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework        | TanStack Start + React 19, built with Vite, served by srvx (`start.mjs`) | One Node process per site: pages, API and the job worker                                                                                                                                                    |
| UI               | Tailwind v4                                                              | Components live in each site; packages ship headless hooks only                                                                                                                                             |
| Database         | Postgres + Drizzle (`pg-core`, node-postgres)                            | One database per site; migrations use timestamp prefixes. A pool of 10 per process, with 30 s statement, 10 s lock and 60 s idle-in-transaction timeouts (`core/src/db/client.ts`)                          |
| Auth             | Better Auth: Google OAuth, One Tap, email one-time codes                 | No passwords                                                                                                                                                                                                |
| Email            | Cloudflare Email Service, REST API (`core/src/email/mailer.ts`)          | Needs `CLOUDFLARE_ACCOUNT_ID` and an API token with Email Sending. `MAIL_LOG=1` logs mail instead in local development. Copy is built in for en/ja/ko (`core/src/email/copy.ts`), picked by `defaultLocale` |
| Bot defense      | reCAPTCHA v3 (score-based)                                               | Called only on guest generation and sign-up; low scores must sign in. Script loads on first tool interaction                                                                                                |
| Rate limits      | Guest daily quota and site budget in Postgres with conditional writes    | Exact counters live in the site's own database                                                                                                                                                              |
| Device identity  | IP (`cf-connecting-ip`, IPv6 grouped by /64) plus a signed device cookie | The origin must accept traffic from Cloudflare only (see the launch handbook)                                                                                                                               |
| Disposable email | Built-in blocklist                                                       | Sign-up bonus requires a verified, non-disposable email                                                                                                                                                     |
| Payments         | Stripe (default) or PayPal, behind one provider interface                | See section 5                                                                                                                                                                                               |
| Job runtime      | `job_runs` and `job_steps` tables and a worker loop in the site process  | See section 6.1                                                                                                                                                                                             |
| Storage          | `ObjectStore` (`jobs/src/store.ts`): S3 API against an R2 bucket         | A local directory (`STORAGE_DIR`) in development, memory in tests. Outputs served through the site                                                                                                          |
| Image text       | Workers AI vision over its REST API                                      | Optional, best effort; same Cloudflare API token as email                                                                                                                                                   |
| Video compose    | ffmpeg service (`jobs/compose/`) in its own container, one per machine   | Optional; reached over HTTP at `COMPOSE_URL`. See section 6                                                                                                                                                 |
| i18n             | Paraglide                                                                | Production builds ship English only                                                                                                                                                                         |
| Analytics        | GA4, Rybbit (proxied through the site's `/stats/`), Clarity optional     | Configured in `site.config.ts`                                                                                                                                                                              |
| Errors           | JSON lines on stdout                                                     | Read with `docker compose logs`                                                                                                                                                                             |
| Deploy           | One Docker image per site, built from the workspace root                 | The site's `compose.yaml` runs the site, Postgres and the compose service                                                                                                                                   |
| Tests            | Vitest in Node, in-memory PGlite per test file                           | Lock tests (`test:pg`) run against a real Postgres. See section 8                                                                                                                                           |
| Tooling          | pnpm workspace, Biome, strict TypeScript                                 | Biome handles both lint and format                                                                                                                                                                          |

## 3. Repository layout

```
shipwords/
  AGENTS.md  CLAUDE.md  README.md
  package.json  pnpm-workspace.yaml  biome.json  tsconfig.base.json  .nvmrc
  docs/                 confirmed design and handbooks; docs/live/ for unfinished work

  packages/
    core/               db, auth, billing, credits, quota and bot defense, SEO, analytics, headless hooks
    jobs/               async job runtime (job runs on Postgres), upstream adapters, object storage, compose service

  templates/ai-site/    AI site template; pnpm new-site copies it; must pass check on its own
  sites/<site>/         one complete TanStack Start app per keyword
    README.md           site profile: target keyword and intent, competitors, launch date, payment account, status
    DESIGN.md           this site's visual direction
    site.config.ts      brand, locales, products, quota, billing provider, analytics IDs
    site.models.ts      models as pages see them: name, credit cost, guest eligibility, inputs (ships to the browser)
    src/models.server.ts  the server side of each model: upstream model, cost cap, timeout, effect presets
    src/  messages/  migrations/  public/  package.json
    start.mjs  migrate.mjs  production server (srvx) and the migration step
    Dockerfile  compose.yaml  .env.example  the image, the containers on one machine, the settings it reads

  apps/<sidecar>/       optional standalone Workers that belong to no single site
  tools/                repo scripts with tests: new-site, check-site, list-sites, setup-worktree, dev-port, stripe-listen
```

Why this split: the parts every site shares (auth, billing, credits, quota, bot defense, SEO) are the bulk of the code and carry the most risk, so they exist exactly once. What differs between sites is the product surface, which the site owns completely.

## 4. Rules

1. **Runtime isolation.** Each site has its own container, database (and database role), bucket, secrets and payment account. Sites on one machine may share the Postgres server and the compose service, nothing else.
2. **Sites never import each other** (enforced by Biome and `check-site`). Reuse means moving code into a package or copying it.
3. **Packages contain no pages and no styles.**
4. **Packages contain no site logic.** Sites pass their differences in through `site.config.ts`, `site.models.ts` and registration functions.
5. **Verification scope.** Changing a package means checking every site that depends on it; money tests live in the packages. Changing one site means checking that site.
6. **Deploys.** Ship a package change to one site first, watch it, then deploy the other live sites. Inactive sites can keep running their old build.
7. **Retiring a site.** Delete its directory and take down its container, database, bucket and payment account.
8. **Migrations.** Package tables and site tables are generated into each site's `migrations/` with `pnpm db:generate` (timestamp prefix) and applied to that site's own database by `migrate.mjs`: `pnpm db:migrate` locally, `docker compose run --rm site node migrate.mjs` on the server. The server never migrates on start, so a deploy and a schema change stay two separate acts.
9. **Secrets** live only in the site's environment: a `.env` file outside the repo (`~/.config/shipwords/<site>.env` locally, next to `compose.yaml` on the server), passed to the container at run time. `.dockerignore` keeps every `.env` file out of the image. The database holds runtime state, not configuration.
10. **Browser boundary.** Every module a page imports, directly or not, ships to the browser. Server-only code and data (prompts, upstream models, cost caps, reference clips, internal rules) live in `*.server.ts` files, which TanStack Start refuses to bundle for the client. Secrets are read only from `process.env` on the server at runtime. Config the browser needs goes through an allowlisting server function, never by returning the environment. `check-site` scans the browser bundle for strings from `*.server.ts` files and for `.env` values, and the Dockerfile runs it after the build, so a leaking build never becomes an image. Job APIs return failure codes only; the stored error message (exceptions, upstream replies, check scores) stays in the database and logs.

## 5. Billing

### 5.1 Principles

- **Atomicity.** Every multi-row money write goes into one Postgres transaction. Ledger operations first lock the user's `credit_accounts` row (`SELECT … FOR UPDATE`), so one user's ledger writes run one at a time; job state changes are guarded conditional updates. Every ledger entry has a unique idempotency key, and CHECK constraints (no negative remaining credits or debt) are the backstop.
- **Webhooks are signals.** A webhook is verified, deduplicated by provider event ID, and then the current state is fetched from the provider API. Local state is updated from that state, never from the event body, so missed and out-of-order events are harmless.
- **Settlement in one transaction.** Marking an order paid and granting its credits happen in the same transaction.
- **Renewals only move forward.** A subscription period can be claimed only if it is later than the last claimed period.
- **Refunds and disputes claw back credits** proportionally. Balances may go negative; a negative balance blocks new spending.
- **Unknown provider names return 404** on `/api/webhooks/:provider`; there is no silent fallback to a default provider.

### 5.2 Product catalog

Products are declared in `site.config.ts`, independent of the payment provider. Amounts are in the smallest currency unit:

```ts
products: [
  {
    id: 'pack_200',
    kind: 'credits',
    name: '200 credits',
    price: { amount: 499, currency: 'usd' },
    credits: 200,
    expiresDays: null,
  },
  {
    id: 'pro_month',
    kind: 'subscription',
    name: 'Pro monthly',
    price: { amount: 999, currency: 'usd' },
    interval: 'month',
    creditsPerPeriod: 600,
  },
];
```

Stripe uses inline `price_data`, so changing a price is a code change with no pre-created Price. Providers that need pre-created plans (PayPal subscriptions) take an ID in `refs`. Do not change a product `id` after launch.

### 5.3 Provider interface

Adapters translate; they never touch the database.

- `createCheckout(order)`: returns a redirect URL and session ID. Our own order number travels with the checkout (Stripe `client_reference_id` and subscription metadata, PayPal `custom_id` / `invoice_id`).
- `parseWebhook(request)`: verifies the signature and returns normalized events; unknown events return an empty list.
- `fetchState(ref)`: reads the current state of an order, subscription or invoice from the provider API.
- Refund, cancel-at-period-end and customer portal helpers, plus `capabilities` flags for provider differences.

Normalized events are a typed union, each carrying a `providerEventId`: checkout completed, payment succeeded (one-off or one subscription period), payment refunded, dispute opened/closed, subscription updated, subscription ended.

### 5.4 State machine

One state machine is shared by all providers.

- **Tables:** `orders` (one per checkout), `payments` (one per collected payment, unique by provider and invoice), `subscriptions`, `webhook_events` (unique by provider and event ID), plus the credit ledger.
- **Webhook flow:** verify, insert into `webhook_events` to deduplicate, `fetchState`, update state and grant or revoke credits in one transaction, return 200.
- **Credit grants** use `pay:<paymentId>` as the idempotency key. Subscriptions grant once per paid period; subscription credits expire at period end, pack credits expire after `expiresDays` (or never).
- **Stripe:** Checkout in `payment` or `subscription` mode; customer portal for cancel, card update and invoices. Stripe is not a merchant of record; enable Stripe Tax (`billing.automaticTax`) or handle sales tax yourself.
- **PayPal:** packs use Orders v2 and are captured by us (on return and on `CHECKOUT.ORDER.APPROVED`, with a fixed `PayPal-Request-Id`); subscriptions use Subscriptions v1 with a pre-created Plan in `refs.paypal`.
- **Front end:** `usePricing()` reads the catalog and `useCheckout(productId)` starts a checkout. A site enables one provider at a time through `billing.provider`.

## 6. Generation jobs

- **Adapter interface:** `submit` / `poll` / `cancel`, plus an optional `cost`. Adapters never touch the database or credits. Submitting twice with the same idempotency key must return the same upstream job. Yir is the default upstream ([yir.ai](https://yir.ai/?utm_source=shipwords&utm_medium=docs)); add another upstream by implementing the same interface.
- **Model registry:** each site declares its models in two files. `site.models.ts` (`definePublicModels`) holds what pages show: name, credit cost, guest eligibility, allowed parameters, reference limit and effect slots; any other field throws. `src/models.server.ts` (`serverModels`) adds, by ID, the upstream model, per-job upstream cost cap (`maxCost`), timeout and effect presets; both files must list the same models. `core.server.ts` and `server.ts` import the server file; pages import only `site.models.ts`.
- **Charging:** credits are debited with the job ID as the idempotency key, after a balance check, before submitting upstream. The debit, the job row and its run row (§6.1) commit in one transaction, so a charged job always has a run. The job ID is also the upstream idempotency key.
- **Server-side create retries:** `createJobs().create(request, { idempotencyKey })` supports signed-in staged tools. The user and server-supplied key determine the job ID; reuse must match the normalized model, prompt and input. The job/debit/run transaction deduplicates concurrent calls. Reuse heals stale jobs and unfinished terminal refunds, never resets terminal jobs, and re-queues a queued job's run (a no-op when it exists); a run that starts past the job's deadline fails it with a refund before submitting anything. Sites own confirmation gates and separately priced stages; the option is not read from the public request body.
- **One-way states:** conditional updates prevent a failed or cancelled job from becoming succeeded. Failed and cancelled jobs are refunded from their final state.
- **Refunds and upstream charges:** refund credits only when the customer got nothing _and_ nothing will be billed for them; never on a path the customer can repeat after the upstream has charged. Credits are a loop: a refund lets the same customer submit again, and each submit is a new paid render. A video site found this the hard way when one customer resubmitted a failing order nine times, each time paying the $3 render upstream. The engine applies it on every path:
  - **User cancel** only works while the job is `queued` (`cancelQueued`): once an upstream task runs it bills whether or not it is cancelled, so the cancel API answers 409 `job_started` and the job keeps going and delivers. A submit counts as started once its step has begun, even before an upstream ID is recorded: the cancel holds the job's run row, which a step also locks to start an attempt, so a submit can't begin between the check and the cancel.
  - **Missed swaps** of an effect render are repaired, and with `repair.onMiss: 'deliver'` the best checked version is delivered instead of refunded (§6.2).
  - **Upstream failures and refusals** refund, since the upstream normally bills nothing for them. A model that bills a refused or failed task would reopen the loop; watch `jobs.upstream_cost_usd` on failed jobs to catch it.
  - **System faults** (a compose or check error, the job timeout, a run buried by the worker) refund: the customer got nothing and can't trigger them on purpose.
  - Keep the per-job `maxCost` below the cheapest pack's net price per job, so even a job that uses every repair pass doesn't lose money. Say all of this on the site's refund page, including that results caused by the customer's own photo or prompt aren't broken results.
- **No retries on upstream failure:** Yir already retries the task across providers and the SDK retries transient HTTP errors, so a failed upstream job or a rejected submit fails the job at once with a refund. Only a 429 rate limit on submit, or a failed status read, gets step retries (§6.1).
- **Finish email:** with a mailer configured (`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, or `MAIL_LOG=1` in development) and `EMAIL_FROM` set, signed-in users get an email when a job succeeds (result link) or fails (not charged, credits back). It is sent after the refund settles; cancelled and guest jobs get none. Like sign-in codes, it is written in the site's `defaultLocale` (English when that language has no built-in copy).
- **Upstream cost:** after a job ends (succeeded or failed), the runner reads `cost` for every upstream job and stores the sum in `jobs.upstream_cost_usd`. Billing can settle after the result lands, so it re-reads up to 4 times, 30 s apart, writing each complete read; only an explicit `settled` status ends the wait. Best-effort: a read failure is only logged and keeps the last amount written. Not counted: prep hedge copies, and a task the runner cancels right after a user cancel won the race against its submit (never recorded).
- **Cancel** (before submit only, see above) leaves the run going: it sees the job canceled at its next step and stops, canceling anything it had just submitted.
- **Observability:** per-stage timestamps and error classification; structured JSON logs on stdout.
- **Resumable UI:** in-flight jobs resume after a page refresh.
- **Mock upstream:** with `UPSTREAM_MOCK` set, outputs are replaced with reference assets (text-only image jobs get the site's `public/mock-output.png`) so the whole flow (upload, charge, poll, store, deliver, refund) runs without a key or cost. It only activates when `APP_URL` is a local host or every payment credential is in test mode (the public demo), so a site that can take real money never serves fake outputs. If `UPSTREAM_MOCK` is set but the mock is inactive, `createAdapters` throws rather than fall through to the paid upstream. A public demo can also set `UPSTREAM_MOCK_RESULT` (and `_SILENT`) to bucket keys so every effect job returns the same finished video.
- **Compose service (optional):** an ffmpeg service (`packages/jobs/compose/`) in its own container that stitches segments and mixes audio for video sites; the site reaches it at `COMPOSE_URL` (see the end of §6.2).

### 6.1 Job runs

`runGeneration` (`runner.ts`) depends only on a `StepRunner`: `do(name, fn)` and `sleep(name, ms)`. Its steps run strictly in sequence and are written for replay: step names are fixed, the job timeout counts from creation, and upstream calls carry the job ID as idempotency key. `worker.ts` runs it durably on two Postgres tables.

- **Tables:** `job_runs` has one row per job (`pending`, `done` or `dead`, `run_after`, the lease `locked_by` / `locked_until`, `pickups`); `job_steps` has one row per step name of a run (saved result, attempts, last error). The run row is written in the same transaction as the job and its debit.
- **Worker loop:** each site process runs one, started by the site's `src/server.ts` (`JOB_WORKER=0` turns it off for a process that should only serve pages and API). It claims pending runs once a second, and at once when this process creates a job, with `SELECT … FOR UPDATE SKIP LOCKED`, up to 20 runs at a time (jobs mostly wait on the upstream). Each claim writes its own token into `locked_by` and holds a 60 s lease that a heartbeat extends every 20 s. A job created by another process is picked up on the next poll; there is no `LISTEN/NOTIFY`.
- **Steps:** a step with a saved result returns it without running `fn`, so a run picked up again replays up to where it stopped. Before each attempt the step checks the lease under a row lock and records the attempt; the attempt number is passed to `fn`, so a submit can tell a first attempt (nothing placed yet) from a later one (it submits again with the same key to recover a task the upstream may hold). A throwing step is retried 5 times, 10 s apart and doubling; only attempts that failed with an error spend that budget. `sleep` waits in process and is recorded, so a replay doesn't sleep again.
- **At least once:** a step whose `fn` finished but whose result was not saved runs again after a crash, so every step must be idempotent. Step names are replay keys and must stay stable across versions (`runner.test.ts` and `effects.test.ts` lock them).
- **Fencing:** once a lease is lost or the process is stopping, every later step throws without running, the runner's own abort and settle steps included. Job outcome writes (`markSubmitted`, `appendUpstreamJob`, `markSucceeded`, `markFailed`, `markForReview`) take the run's `Fence` (run ID and claim token) and apply only while that claim holds an unexpired lease, and the worker passes `cancel` to the upstream only while it does. A worker that lost a run therefore can't fail and refund a job another worker is finishing. Handlers write without a fence.
- **Watchdog:** there is no per-step timeout, since a Node call can't be stopped and a retry would race it. Instead the heartbeat buries a run still going 15 minutes after its job's deadline: in one transaction holding the run row it cancels the job's upstream tasks (prep hedge copies included, waiting at most 30 s), fails the job `stale` with a refund, and marks the run `dead`.
- **Poison runs:** a run claimed more than 10 times is buried the same way without running the runner. When the worker's own database reads or writes fail, it hands the run back to be tried again after 30 s, which doesn't count toward that limit and never reaches the runner as a step failure.
- **Stale jobs on read:** the handlers still fail and refund a job unfinished 15 minutes past its model timeout when a user views it, for the case where no worker runs at all.
- **Shutdown:** on SIGTERM `start.mjs` closes the HTTP server and stops the worker together. The worker stops claiming, lets steps in flight finish (up to 60 s), then releases its leases so the next process picks the runs up at once. The container's stop grace period must cover that (`stop_grace_period: 90s` in the template's `compose.yaml`). Deploys don't need zero jobs in flight.
- **Backfill and cleanup:** at start the worker queues a run for every job in progress that has none (jobs created before `job_runs` existed). Step rows of runs that ended more than 30 days ago are deleted.

### 6.2 Effects: server-side presets with several segments

An effect is a model entry with an `effect` field: the user only uploads photos, and the server swaps them into fixed reference clips. `createJobs` and the job worker keep their signatures.

- **Server-only presets:** slots (ID, label, required) are public; segments, prompts, reference clips, checks, repair and compose live in `src/models.server.ts`. A slot's `prep` prompt is server-only too: repeat the slots there (same IDs, same order) with `prep` added.

- **Input roles:** `ModelDefinition.referenceRole` (`reference_image` or `first_frame`) says how uploads reach the upstream. Default: `reference_image` for image models, `first_frame` for video models. A video job with any `reference_*` input is sent in Yir's `reference` mode, otherwise in `image` mode.
- **Slots and segments:** `effect.slots` lists the faces a user can fill (`required` or not); `effect.segments` lists the shots, each with a reference video (bucket key under `assets/` or an https URL), the slots it swaps (in `@image1`, `@image2`… order), a prompt builder and parameters. A segment renders only when at least one of its slots is filled; empty segments fall back to the base footage.
- **Request:** `POST /api/jobs { modelId, slots: { <slotId>: '/files/uploads/…' } }`. Effects ignore `prompt`, `references` and `parameters`. A missing required slot, an unknown slot, a file not uploaded to this site, or no renderable segment returns 400.
- **Price and cost cap:** one `credits` charge per job, regardless of how many slots or segments. Every segment declares its own `maxCost` (sent upstream as max_cost); `defineModels` rejects segments whose sum exceeds the model's `maxCost`.
- **Server only:** prompts and reference videos are stored in `input_json` (`prompt` is an empty string) and never leave through `publicJob`. `/files/assets/…` serves reference assets read-only and unlistable.
- **Several upstream jobs per job:** segments are resolved into `input_json.parts` at creation. `upstream_job_id` holds the upstream IDs in segment order, comma-separated, so there is no extra column or migration; jobs without `parts` run as one segment.
  - The first submit moves `queued → submitted` (`markSubmitted`); later ones use `appendUpstreamJob`, a conditional update that requires the job to be in flight and the list to hold exactly the earlier parts. Replays skip parts that already have an ID; if the job has ended meanwhile (for example cancelled), the new upstream job is cancelled at once.
  - Idempotency keys: `jobId` for a single part, `jobId:partId` for several.
  - Parts are polled in turn (they run in parallel upstream); the timeout still counts from job creation.
  - Any failed part fails the whole job, cancels the others and refunds in full; the abort path cancels submitted parts too. Cancelling a job cancels every upstream ID.
  - On success each output is stored as `jobs/<jobId>/<n>.<ext>` and the job is marked succeeded once. The state machine, refunds and guest quota writes are unchanged.
- **Compose (`effect.compose`):** after all parts are stored, a `compose` step sends the parts, base footage and soundtrack to the compose service (work directory named by job ID) with a cut list: per segment its `target` seconds in the final cut, its `base` fallback, and `fit` (`stretch` retimes the whole segment, `trim` keeps the original speed and cuts the first `target` seconds). The container re-encodes to one size and frame rate, concatenates and mixes the soundtrack; the job then lists only `final.mp4` and `final-silent.mp4`.
  - **Shot cuts (`segment.cuts`):** edit models that take a whole multi-shot clip (Kling 4.0 `Edit @video_1`) keep the shots but not the exact timing (a 17.69 s input requested as 18 s came back 18.04 s, each cut 1–3 frames late). A segment can list its cut times in the final cut; the container finds the scene cuts in the output (ffmpeg scene score > 0.3), matches each expected cut to a detected one within 0.3 s of where it should be (the best in-order assignment, so a flash near a cut can't take the next cut's match), and retimes every shot to its exact length, the last shot by the drift of the last cut. Where it should be allows one shared offset of up to 0.5 s: Kling pads the start, so all its cuts land 0.2–0.5 s late together, and a good render 0.54 s late on its last cut once failed a paid job (2026-11-18; of 63 live renders, every one has exactly three cuts, good ones sit within ±0.19 s of one offset, and the only failure is one whose later shots drifted a second apart). A missing cut means the output lost the reference's shot structure: compose fails and the job is refunded.
  - **Output check (`segment.check`):** before compose, the container looks for each filled slot's original person in the output (YuNet + SFace, 2 frames per second, at least 16). Face points are `[x, y]` in the original's first frame or `[x, y, t]` at t seconds, for whole clips where people appear in different shots. Similarity at or above `maxSimilarity` fails the job with a refund (`swap_not_applied`); there is no rerun, since a video render costs dollars. An error in the check itself also fails and refunds (`check_failed`): an unchecked video may be the original clip. The step is retryable and idempotent per job; when retries run out, or the site has no compose service (`COMPOSE_URL` unset), the job fails and is refunded in full rather than delivering a partial result.
  - **Repair (`segment.repair`):** a missed swap can be repaired instead of refunded, for a single composed segment with `check` and `cuts`. After compose, each pass cuts the shots of the first missed slot out of the composed video (`repair.shots` lists who is in each shot) with their stretch of the soundtrack, serves them at a `jobs/<id>/repair-*.mp4` URL that `/files` only answers while the job runs, and has a video replace model (Pruna `p-video-replace` through Yir) re-render them for that one slot from its photo; the container retimes the result to those frames, scales it to cover the frame and replaces them, and every filled slot is checked again. A pass replaces one person: the prompt gets the slot and the shots (`prompt(slots, kinds, shots)`), so it can name where the person is in those shots. Once a slot has had its whole-frame pass on a group, a slot with a `crops` box at the frame edge gets its box repaired alone and blended back with feathered edges. Each pass gets a new seed, its own `maxCost`, and is recorded after the segments in `upstream_job_id`, so cancel, abort and cost cover it; `rounds` passes count toward the model's `maxCost`. When the passes run out, or the model rejects or fails one, the job fails `swap_not_applied` with a refund. A site that stops refunding once the paid render has been charged sets `onMiss: 'deliver'`: the same cases (and a timeout, a check error or a pass step that keeps throwing during the passes, a check error on the render itself, or a miss on a site that can't run passes) deliver the checked version with the fewest missed people and keep the credits; the customer can still ask for a refund of a broken result by email. Raise `rounds` with it, since each extra pass is cheap next to the render already paid for. Measured: two missed jobs repaired with one whole-frame and one box pass each, about $0.25 a pass against $3.06 for a new render. How passes are cut, sent and put back was settled by a complaint (2026-11-18, below). **Likeness (`repair.likeness`, needs `onMiss: 'deliver'`):** a swap can take and still not look like the customer, which the original-face check can't see (a paid order complained “you can't recognize anyone”: the close-up lead scored 0.44 against their photo). For the slots listed, the container scores the composed video against each slot's photo (the prep result, else the upload) over the shots it is in, or only some of them (`{ min, shots }`, e.g. not another shot's corner where half the face shows): per sampled frame the SFace match of the face in the slot's spot, then the median. The spots are the `check.faces` points, each read in its own shot and reused in every shot with the same people (one camera); each face in a frame goes to the nearest spot of its shot and the slot's face is the largest one in its spot, so in a group shot another person's face never counts (a frame with nothing there is skipped). A filled slot below its threshold joins the missed slots and is repaired, on the shots it was scored in, and counts as missed when picking the best version; a check error, a photo with no face, or no face in the spot counts as no miss, so likeness only ever adds passes, never fails or refunds. Pet slots are skipped: SFace is a human face model. Profile and small faces score low even when right, so set a threshold only where stored renders show a gap between right and wrong people: TinyDeskAI replayed 24 stored renders per seat (lead close-up right 0.44–0.74, wrong at most 0.21; keyboard player in the wide shots right 0.61–0.78, wrong or unlike at most 0.29; a back-row face scored 0.15–0.53 for the same person in different jobs, and a saxophone profile overlapped wrong people) and checks only the lead (0.40) and the wide-shot keyboard player (0.35).
- **People swaps: several photos per person, person or pet, descriptions, review.** Lessons from two complaints on one order (jersey numbers and logos gone, a face on the wrong person, fur on a person's hands, an original performer left in the corner of another shot):
  - **Prep views and subjects:** a slot's `prep` may be 1–4 prompts, one image each (`prep-<slot>`, `prep-<slot>-v1`…); the first is the main view. A segment with `subjects: { <slot>: 'Name' }` sends every view of that slot as one upstream subject (Yir `reference_image` with `subject`; Kling takes 2–4 photos per subject) and the prompt names it `@Name`. Views whose prep fails fall back to the upload; a subject's identical URLs are sent once, and a subject left with a single site photo gets it again under `?view=2`.
  - **Subjects vs one image per person:** in a five-seat edit with Kling 4.0 on Yir, subjects of four views each (12–20 images) kept putting the lead, the most prominent subject, into the most prominent seat of the wide shots, and the checks didn't see it (five live jobs, 2026-11-13/15). With the same photos on the same route, one prep image per person (a two-panel image: face on the left, outfit from the neck to the waist on the right, sent whole without `subjects`) plus a prompt that gives each seat its shot, time span and spot got every seat right and a closer lead likeness. TinyDeskAI switched on 2026-11-15. Without `subjects` the engine names images `@image1…`; Kling 4.0 expects `@image_1…`, which a segment sets with `imageName` (a function from the image number to its name). A composite like that is a poor identity photo for the replace model (it may take the headless torso for a second person), so `repair.photoView` points repair passes and the likeness check at a separate plain face prep view (`prep: [pair, face]`; only the main view goes to the video model). Two prep copies of a person image could differ, so such a site can set `prep.hedge: false`: a slow prep is waited for instead of copied, and the job cap counts one run per prep. Sites check their own request path with `partInput` and `preflightUrl` from the runner, the same functions it submits and preflights with.
  - **Person or pet:** a request slot may be `{ photo, kind: 'pet' }`. Prompt builders get `kinds` (and repair prompts too), so only pets are told to grow fur and paws.
  - **Look-alikes and props in the original:** edit and swap models borrow from the original clip. When a customer shares a feature with an original performer (a white cap), the model may give that seat the original performer's face; it also leaves original props (a visor, a headset mic) on the new person, and can restyle an original face (shave the head, add a beard) instead of replacing it. Seen with Kling 4.0 edit and a dedicated object-swap model on the same lineup (2026-11-14). Prompts say outright that no replaced performer takes an original performer's face, whatever they wear, and should not lean on a feature an original performer also has to identify someone.
  - **Prep sheets:** `slot.prepSheet` replaces `prep` with one borderless 2x2 sheet prompt. The persisted image part carries `prepSheet: true`; four row-major crops are stored at deterministic `jobs/<id>/prep-<slot>-<view>.png` keys by a replayable container split step. These URLs are served without caching only while the job is submitted. Sheets never hedge; the cost cap counts one image per slot. A failed image falls back to the original upload for all views; split errors retry the step without generating another image. Existing stored per-view plans retain their original behavior. Before any paid preparation, an adapter's optional local `validate` hook checks every planned request using HTTPS stand-ins for future prep images. The Yir adapter uses the installed SDK validator.
  - **Upload copies (`model.keepUploads`, off by default):** right after `load`, before preflight and any submit, a `keep:uploads` step copies every upload of this site the job uses (`<fileUrl>uploads/up_*`, never a preset's media on another host) inside the bucket to `jobs/<id>/kept/uploads/<file>`. A lifecycle rule deletes `uploads/` after a few days, and until then `/files` serves uploads to anyone with the link (the upstream fetches them that way); `/files` never serves `kept/`, so the order keeps its originals while the public link still expires, and photos that never became an order are still deleted. `/files` serves uploads with `no-store` (outputs stay cacheable for a year), so no cached copy outlives the deletion. Without a file origin (`fileUrl`) the step logs a failure instead of silently keeping nothing. A site that turns it on keeps photos past the lifecycle and must say so in its privacy policy. The whole step is bounded by `KEEP_UPLOADS_TIMEOUT_MS` (10 s), never throws or retries, and only logs failures; loads cached before the option existed skip it.
  - **Prep copies:** every other prep image the upstream returns is copied to the bucket at `jobs/<id>/kept/<prep part ID>.<png|jpg|webp>` in one best-effort step per batch (`keep:<from>`; the images are collected from the finished polls and copied in a `finally`, so also when the batch ends early), so a reviewer can see what the video model got after the upstream URL expires. Each copy has `KEEP_TIMEOUT_MS` (20 s); the step catches every error and the call catches a step failure, so a copy never retries, holds up the video segments beyond the timeout or fails the job. The copies are not outputs, and `/files` never serves `kept/`.
  - **Descriptions (`effect.describe`):** before a segment is submitted, a `describe:<segment>` step has `RunnerDeps.describe` (Workers AI vision over its REST API, set up when `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are) describe the chosen prep view of each slot whose prompt asks for it (`describe(slot)` placeholder). Best effort: a failure leaves the description out.
  - **Checks:** `check.faces` may list several points per slot (a person also seen in another shot); the slot scores its worst point, and the shots of the points that matched the original decide where repair starts. Likeness also scores the face in each likeness slot's spot against every other filled person's photo: one that beats the slot's own by more than `SWAP_MARGIN` (0.2; two customers can look alike) is a swap and is repaired. Scored on the best face in the frame, as before 2026-11-18, a three-person wide shot found each other person's own face (44 of 62 right seats would have counted as swaps) and passed a seat taken by the wrong customer who also stood elsewhere in the frame. A residual-face miss is dropped when the likeness check clearly passes in every shot the original was seen in (a profile shot keeps the original's outline; a pass on the wide shots says nothing about another shot's corner).
  - **What the checks don't see:** likeness and its swap rule only run for slots with a threshold, so a wrong customer in a seat without one (a back-row or saxophone seat at TinyDeskAI) passes, and the original-face check only asks whether the original is still there. A second face in the lead's close-up is not counted either. A likeness score is one median over all its shots, so a group shot where the slot's spot has no face at all (the original moved next to it, say) still counts as scored and lets a pass clear that shot's original-face miss. `{ min, shots }` must take whole groups and the people in a likeness shot need points at different places, so the original-face check (which reports a group by its point's shot) and the spots line up. One customer reordered the same lineup three times over a second face in the lead's close-up while every job reported success. A per-shot check (who is in the hero shot, and how many faces) would need the container to report face counts and positions per shot; not built yet.
  - **Repair by shot group, one person per pass:** shots with the same people (and so the same framing) form a group; a pass re-renders one group for one slot, with that slot's photo alone. Groups where the original was seen go first, then the slot's other groups, then crop passes, then turns; several missed people in a group get a pass each. Joining a group's shots in one pass keeps the person's face and accessories the same across them: run apart, the last wide shot of a fixed lineup got the original performer's headset drawn back. `repair.aspect` (Pruna renders 7:9) widens crop boxes to the model's aspect before they are cut, and the container puts a repaired box back lined up on the background (`align.py`: ORB features, RANSAC similarity per frame, temporal median, feathered blend; the old stretch is the fallback). Stretching alone left the shelves visibly offset at the box edge.
  - **Why, from a complaint (2026-11-18):** the check flagged a correct render (scores just over the threshold), and a pass re-rendered three people at once from a silent clip. The replace model drives mouths from the clip's audio, so it made up lip movements and gestures (the customer: “the music doesn't match the singing”), and lining the whole frame up on the background left strips it didn't cover showing the frame before repair, a second half face at the edge. Delivering the render without repair drew the next complaint: the swapped people didn't look like the customers, which the repair had fixed. On the same shot, side by side: one person per pass, the official prompt pattern (one sentence naming the person by position, then “Keep lip sync, motion, audio, and camera from the source video.”), a chest-up front photo, the clip with its soundtrack, and the whole-frame result covering the frame looked natural (likeness to the photo 0.26 → 0.42, lip correlation 0.78 against 0.92 for the render). Pasting only the replaced face onto the render looked stitched, since the model redraws the whole person; a crop of the person added a headset that wasn't there; Seedance 2.0 Mini and Fast and MiniMax H3 on the same shot didn't make the face any closer to the photo. The scores alone ranked the face-only paste best, so compare repairs by looking at the frames.
  - **Known issue, crop repair ghosts:** the feathered blend covers the whole crop box, so a neighbour's hand that reaches into the box's feather zone (a raised arm next to a back-row singer) comes out as a half-transparent ghost: the repaired clip no longer has that hand. Measured fix, not yet in `align.py`: estimate the transform on the whole box but blend only the part around the repaired person (a 310 px wide blend inside a 386 px box removed it while all 191 frames still matched).
  - **Review:** when repair gives up and delivers under `onMiss: 'deliver'`, the job is marked `needs review: …` in `error_message` (`error_code` stays empty, so the page shows a plain success) and `RunnerDeps.review` emails `REVIEW_EMAIL`. Never a refund or a status change.
  - **Failure streaks:** when a signed-in user's jobs fail `FAILURE_STREAK` (3) times with no success in between, `RunnerDeps.failures` emails `REVIEW_EMAIL`, listing the streak's failed jobs and their error codes (`failures.ts`, step `failures` after `notify`). The streak is ordered by when jobs ended, so the third job to fail alerts exactly once, however late its check runs and in whatever order the jobs were created; later failures stay quiet until a success ends the streak. Canceled and running jobs are not in it. `finishedAt` comes from the clock of the process that ends the job: only two jobs of one user ending within milliseconds in different processes can make a streak alert twice or not at all. Failures that end outside the runner (`stale` from the handlers and from the worker's watchdog and poison handling, `workflow_failed` from the worker's catch around the runner, `dispatch_failed` on jobs from before job runs) count but run no check: when the threshold falls on them, the next failure the runner checks sends the alert, however long the run of them; a streak made only of them alerts on its first runner failure. The alert lists at most `ALERT_LIST` (20) jobs. On 2026-11-13 a paying user retried a broken model 15 times before anyone noticed.
  - **Redo by hand:** the site's `replace-output.mjs` (run inside its container; `jobs/src/admin.ts`) uploads a new file under a new key and points `outputs_json` at it; outputs are served immutable for a year, so overwriting the old key would leave viewers on the old video.
- **Site side:** set `COMPOSE_URL`; the template's `compose.yaml` builds the service from `packages/jobs/compose/` and points the site at `http://compose:8080`. Several sites on one machine share one service. Measured: about 33 s of half a vCPU for an 18 s 720p cut.
- **Compose service:** one long-running container per machine, reached over the internal Docker network only (it publishes no port). `httpComposer` reads inputs from the bucket, posts them as multipart bodies and stores the results; compose and patch leave their output in `/tmp/compose/<id>/`, and the site fetches the silent copy from there right after. Heavy requests run `MAX_JOBS` at a time (default 2); up to `MAX_WAITING` more (default 8) wait with their bodies unread, and beyond that the service answers 503 so the caller's step retries later. Work directories untouched for `KEEP_MS` (default 2 h) are removed, except ones in use. Node runs as PID 1 and handles SIGTERM, so `docker stop` doesn't wait for its timeout. `IDLE_EXIT_MS` and `MAX_LIFETIME_MS` make it exit when idle or after a set lifetime, for platforms that bill an idle instance; both are off by default. They exist because on Cloudflare Containers, where the service ran before, `sleepAfter` never guaranteed a stop and 21 idle instances billed about 984 instance-hours before anyone noticed.

## 7. Guests and abuse

- Guest quota is enforced by Postgres counters per IP and per device cookie, plus a daily budget per site. reCAPTCHA v3 scores raise the bar.
- A captcha only raises the cost of abuse; solving services are cheap. The real backstop is the quota and the daily site budget.
- Failed guest jobs return their quota; cancelled ones don't, since the upstream may already have charged for them.
- Guest results are attached to the new account after sign-in.
- The sign-up bonus requires a verified email and blocks disposable domains, with a per-IP daily limit (`signup.bonusPerIpDaily`) and a site-wide daily limit (`signup.bonusSiteDaily`). The site-wide limit caps the daily cost of farming bonuses with fresh emails and rotating IPs; past it, sign-up still works but grants nothing that day.

## 8. Testing

- **Unit tests** run in Node. Each test file gets its own in-memory PGlite with the package's migrations applied, shared by the file's tests (they use fresh IDs), and an in-memory object store. No ports and no shared database, so several worktrees can test at once.
- **Money unit tests:** race replays, including concurrent debits, duplicate webhooks, out-of-order events and refunds that fail midway.
- **Lock tests (`test:pg`):** PGlite has a single connection, so its transactions queue instead of contending. `pnpm --filter @shipwords/core --filter @shipwords/jobs test:pg` runs a second, small suite against a real Postgres at `TEST_DATABASE_URL`: concurrent spends and grants on one user, a quota counter under concurrent requests, a job failed from many places refunding once, and two workers sharing runs with each claimed and run exactly once. Each file creates its own database and drops it afterwards, so the role needs `CREATEDB`. Files run one at a time (`fileParallelism: false`) with pools of at most 12 connections, so a shared server doesn't run out. Without `TEST_DATABASE_URL` the suite is skipped; CI runs it against a Postgres 17 service container.
- **Site checks:** one command per site runs typecheck, build and launch checks (required routes, policy pages without placeholders, no cross-site imports).

## 9. Parallel development with worktrees

Goal: several AI sessions work in separate worktrees at once, a new worktree is runnable in minutes, merges rarely conflict, and local checks never interfere with each other.

**New worktrees work out of the box**

- `pnpm install` uses the global content-addressed store with hard links. Keep the store on the same disk as the repo, or hard links degrade into copies.
- Secrets stay outside the repo in `~/.config/shipwords/<site>.env` (override with `SHIPWORDS_SECRETS`). `pnpm setup:worktree` copies them into each site as `.env` and points `APP_URL` at the worktree's dev port.
- There is no local platform state to set up: a site's local database is a database on your Postgres (`DATABASE_URL`), and local files go under `STORAGE_DIR` in the site directory. Worktrees that run the same site at once should each use their own database.
- Dev ports are derived from the site name in the main checkout (same port on every machine) and from the full path in a worktree, so worktrees never fight over a port.

**Fewer merge conflicts**

- Generated files (`routeTree.gen.ts`, Paraglide output) are git-ignored and regenerated by dev, build and check.
- No central files everyone edits: no barrel `export *` files, messages split by block, `docs/live/` one topic per file, the site list generated from code.
- Timestamp-prefixed migrations never collide.
- Lockfile conflicts are resolved by rebasing and rerunning `pnpm install`. Dependency upgrades are their own change.

**Splitting work**

- Sites in parallel: one worktree per site.
- Packages in series: one session at a time changes `packages/*` and checks every dependent site; others rebase after it lands.
- Public interface changes (payment adapter, job runtime) start with a short note in `docs/live/`.

**Preview and deploy**

- Preview locally from any worktree: `pnpm preview` builds and serves the production build with `start.mjs`, and `docker compose up --build` in the site directory runs the image as production does.
- Production deploys run only from main, one site at a time: build the site's image on its machine and restart its container.

## 10. Left open on purpose

These directions are kept possible without code written for them today:

| Direction                                         | What keeps it open                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| More payment providers                            | Provider interface and provider-neutral product catalog                       |
| Synchronous conversion tools                      | Execution lives in its own package; a sync-call package can sit beside `jobs` |
| Many more sites                                   | Independent deploys; selective builds and batch deploys can be added          |
| A site outgrowing the repo                        | A site depends only on packages and can be moved out with them                |
| Admin back office, agent API, cron reconciliation | All money state is in Postgres tables; reconcile helpers are idempotent       |

## 11. Known limitations

**Not yet verified**

- Stripe subscription renewals (packs, refunds and disputes are tested in test mode). Test renewals with `stripe listen` and a test card before launching a subscription site.
- PayPal disputes and the second automatic renewal never fired in the sandbox; check the first real renewal after launch.
- reCAPTCHA scoring is only tested against fake assessment responses; configure a real key before launch.
- S3 signing against R2, the Cloudflare Email Service REST payload and the Workers AI REST call with an image have only run against fakes. Check each with real credentials before relying on it.
- On the Node runtime, a full mock-upstream order has run in containers (sign-in, charge, worker run, download, refund, a run handed over across a container restart). Stripe checkout, the compose service image and an effect job have not run on it yet.

**Accepted trade-offs**

- Refund amounts and dispute states merge monotonically (refunds only grow; disputes go none → open → won or lost). If a Stripe refund fails and `amount_refunded` shrinks, credits are not restored; re-grant them by hand.
- The credit ledger locks the user's account row, so one user's ledger writes run one at a time; a transaction that hits a deadlock or serialization failure is run again (up to 3 attempts).
- Credit amounts are Postgres `integer` columns, capped at 2,147,483,647.
- PayPal subscription payments do not expose partial refund amounts, so a partial refund claws back the whole period's credits; refund subscriptions in full only.
- Cancelling a PayPal subscription takes effect immediately, but the paid period stays active (last payment time plus one interval).
- Engine emails use the site's `defaultLocale`, not the visitor's locale, so a multi-locale site sends one language. Better Auth's own error messages stay English; sites translate what they show.
- Better Auth sends sign-in codes in the background, so a failed send is only logged while the API answers 200.
- Concurrency tests in the unit suite run on single-connection PGlite with `Promise.all`; they approximate interleavings. Lock contention is covered only by the smaller `test:pg` suite.
- A job run's lease is time-based. A worker that loses it while still alive (frozen for longer than the lease, or cut off from the database for heartbeats but not for other writes) can still finish one statement it had already started: a fenced write that began before the takeover, or an upstream call already in flight. Each window is one statement or one call, and with one worker process per site and SIGTERM then SIGKILL on deploy it needs a paused process. Closing it fully would mean holding run ownership with a Postgres session-level advisory lock instead of a time lease.

**Not built**

- One site using Stripe and PayPal at the same time; each site picks one provider.
- With no job worker running anywhere (every process started with `JOB_WORKER=0`), an unfinished job is failed and refunded only when a user views it.
- Admin back office, agent API, cross-site stats.
