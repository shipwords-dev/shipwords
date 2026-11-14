# Architecture

shipwords is a monorepo for running one AI tool site per keyword. All sites share `packages/`; each site is deployed, configured and paid out on its own.

## 1. Goals

- **One keyword, one site.** Each site is a small, focused tool. Watch it after launch and keep investing in the ones that work.
- **Payments on day one.** New sites can get traffic from AI search quickly, so every site launches with login, credits and subscriptions already working.
- **Isolated payouts.** Each site has its own payment account, so a problem with one site does not spill over into the others.
- **Cloudflare only.** Workers, D1, R2, Workflows (and optionally Containers). One Worker per site.
- **Fully custom front ends.** Pages, components and styles belong to the site. Unique content is the main defense against looking like a template.
- **AI-friendly.** Configuration lives in code, every money path has tests, and checks run fast.

## 2. Stack

| Concern          | Choice                                                               | Notes                                                                                                        |
| ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Framework        | TanStack Start + React 19 + `@cloudflare/vite-plugin`                | One Worker per site                                                                                          |
| UI               | Tailwind v4                                                          | Components live in each site; packages ship headless hooks only                                              |
| Database         | D1 + Drizzle                                                         | D1 only; migrations use timestamp prefixes                                                                   |
| Auth             | Better Auth: Google OAuth, One Tap, email one-time codes             | No passwords                                                                                                 |
| Email            | Cloudflare Email Service (Worker binding)                            | No extra secret needed. Copy is built in for en/ja/ko (`core/src/email/copy.ts`), picked by `defaultLocale`  |
| Bot defense      | reCAPTCHA v3 (score-based)                                           | Called only on guest generation and sign-up; low scores must sign in. Script loads on first tool interaction |
| Rate limits      | Guest daily quota and site budget in D1 with conditional writes      | KV is eventually consistent and not suitable for exact counters                                              |
| Device identity  | IP (IPv6 grouped by /64) plus a signed device cookie                 |                                                                                                              |
| Disposable email | Built-in blocklist                                                   | Sign-up bonus requires a verified, non-disposable email                                                      |
| Payments         | Stripe (default) or PayPal, behind one provider interface            | See section 5                                                                                                |
| Job runtime      | Cloudflare Workflows                                                 | See section 6                                                                                                |
| Storage          | R2 binding                                                           | Outputs served through the site                                                                              |
| i18n             | Paraglide                                                            | Production builds ship English only                                                                          |
| Analytics        | GA4, Rybbit (proxied through the site's `/stats/`), Clarity optional | Configured in `site.config.ts`                                                                               |
| Errors           | Workers Logs                                                         |                                                                                                              |
| Tests            | Vitest + `@cloudflare/vitest-plugin`                                 | Money tests run against a real D1 runtime in memory                                                          |
| Tooling          | pnpm workspace, Biome, strict TypeScript                             | Biome handles both lint and format                                                                           |

## 3. Repository layout

```
shipwords/
  AGENTS.md  CLAUDE.md  README.md
  package.json  pnpm-workspace.yaml  biome.json  tsconfig.base.json  .nvmrc
  docs/                 confirmed design and handbooks; docs/live/ for unfinished work

  packages/
    core/               db, auth, billing, credits, quota and bot defense, SEO, analytics, headless hooks
    jobs/               async job runtime (Workflows), upstream adapters, R2 storage, compose container

  templates/ai-site/    AI site template; pnpm new-site copies it; must pass check on its own
  sites/<site>/         one complete TanStack Start app per keyword
    README.md           site profile: target keyword and intent, competitors, launch date, payment account, status
    DESIGN.md           this site's visual direction
    site.config.ts      brand, locales, products, quota, billing provider, analytics IDs
    site.models.ts      models as pages see them: name, credit cost, guest eligibility, inputs (ships to the browser)
    src/models.server.ts  the server side of each model: upstream model, cost cap, timeout, effect presets
    src/  messages/  migrations/  public/  wrangler.jsonc  package.json

  apps/<sidecar>/       optional standalone Workers that belong to no single site
  tools/                repo scripts with tests: new-site, check-site, list-sites, setup-worktree, dev-port, stripe-listen
```

Why this split: the parts every site shares (auth, billing, credits, quota, bot defense, SEO) are the bulk of the code and carry the most risk, so they exist exactly once. What differs between sites is the product surface, which the site owns completely.

## 4. Rules

1. **Runtime isolation.** Each site has its own Worker, D1, R2 bucket, secrets and payment account.
2. **Sites never import each other** (enforced by Biome and `check-site`). Reuse means moving code into a package or copying it.
3. **Packages contain no pages and no styles.**
4. **Packages contain no site logic.** Sites pass their differences in through `site.config.ts`, `site.models.ts` and registration functions.
5. **Verification scope.** Changing a package means checking every site that depends on it; money tests live in the packages. Changing one site means checking that site.
6. **Deploys.** Ship a package change to one site first, watch it, then deploy the other live sites. Inactive sites can keep running their old build.
7. **Retiring a site.** Delete its directory and take down its Worker, D1, bucket and payment account.
8. **Migrations.** Package tables and site tables are generated into each site's `migrations/` with `pnpm db:generate` (timestamp prefix) and applied to that site's own D1.
9. **Secrets** live only in Wrangler secrets (and `.dev.vars` locally, kept outside the repo). The database holds runtime state, not configuration.
10. **Browser boundary.** Every module a page imports, directly or not, ships to the browser. Server-only code and data (prompts, upstream models, cost caps, reference clips, internal rules) live in `*.server.ts` files, which TanStack Start refuses to bundle for the client. Secrets are read only from the Worker `env` at runtime; code that touches `cloudflare:workers` fails a client build. Config the browser needs goes through an allowlisting server function, never by returning `env`. `check-site` scans the browser bundle for strings from `*.server.ts` files and for `.dev.vars` values, and `deploy` / `deploy:preview` run it after the build, so a leaking build never ships. Job APIs return failure codes only; the stored error message (exceptions, upstream replies, check scores) stays in the database and logs.

## 5. Billing

### 5.1 Principles

- **Atomicity.** Every multi-row money write goes into one D1 batch with guarded conditional updates. Every ledger entry has a unique idempotency key.
- **Webhooks are signals.** A webhook is verified, deduplicated by provider event ID, and then the current state is fetched from the provider API. Local state is updated from that state, never from the event body, so missed and out-of-order events are harmless.
- **Settlement in one batch.** Marking an order paid and granting its credits happen in the same batch.
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
- **Webhook flow:** verify, insert into `webhook_events` to deduplicate, `fetchState`, update state and grant or revoke credits in one D1 batch, return 200.
- **Credit grants** use `pay:<paymentId>` as the idempotency key. Subscriptions grant once per paid period; subscription credits expire at period end, pack credits expire after `expiresDays` (or never).
- **Stripe:** Checkout in `payment` or `subscription` mode; customer portal for cancel, card update and invoices. Stripe is not a merchant of record; enable Stripe Tax (`billing.automaticTax`) or handle sales tax yourself.
- **PayPal:** packs use Orders v2 and are captured by us (on return and on `CHECKOUT.ORDER.APPROVED`, with a fixed `PayPal-Request-Id`); subscriptions use Subscriptions v1 with a pre-created Plan in `refs.paypal`.
- **Front end:** `usePricing()` reads the catalog and `useCheckout(productId)` starts a checkout. A site enables one provider at a time through `billing.provider`.

## 6. Generation jobs

- **Adapter interface:** `submit` / `poll` / `cancel`, plus an optional `cost`. Adapters never touch the database or credits. Submitting twice with the same idempotency key must return the same upstream job. Yir is the default upstream ([yir.ai](https://yir.ai/?utm_source=shipwords&utm_medium=docs)); add another upstream by implementing the same interface.
- **Model registry:** each site declares its models in two files. `site.models.ts` (`definePublicModels`) holds what pages show: name, credit cost, guest eligibility, allowed parameters, reference limit and effect slots; any other field throws. `src/models.server.ts` (`serverModels`) adds, by ID, the upstream model, per-job upstream cost cap (`maxCost`), timeout and effect presets; both files must list the same models. `core.server.ts` and `server.ts` import the server file; pages import only `site.models.ts`.
- **Charging:** credits are debited with the job ID as the idempotency key, after a balance check, before submitting upstream. The job ID is also the upstream idempotency key.
- **Server-side create retries:** `createJobs().create(request, { idempotencyKey })` supports signed-in staged tools. The user and server-supplied key determine the job ID; reuse must match the normalized model, prompt and input. The atomic job/debit batch deduplicates concurrent calls. Reuse heals stale jobs and unfinished terminal refunds, never resets terminal jobs, and only dispatches queued work before its original execution deadline. Ambiguous dispatch retains the debit through the stale-job grace period, allowing a retry to recover without starting or refunding a second render. Sites own confirmation gates and separately priced stages; the option is not read from the public request body.
- **One-way states:** conditional updates prevent a failed or cancelled job from becoming succeeded. Failed and cancelled jobs are refunded from their final state.
- **Refunds and upstream charges:** refund credits only when the customer got nothing _and_ nothing will be billed for them; never on a path the customer can repeat after the upstream has charged. Credits are a loop: a refund lets the same customer submit again, and each submit is a new paid render. A video site found this the hard way when one customer resubmitted a failing order nine times, each time paying the $3 render upstream. The engine applies it on every path:
  - **User cancel** only works while the job is `queued` (`cancelQueued`): once an upstream task runs it bills whether or not it is cancelled, so the cancel API answers 409 `job_started` and the job keeps going and delivers. The first submit and the cancel race through conditional updates, and when the cancel wins the runner cancels the task it just submitted.
  - **Missed swaps** of an effect render are repaired, and with `repair.onMiss: 'deliver'` the best checked version is delivered instead of refunded (§6.1).
  - **Upstream failures and refusals** refund, since the upstream normally bills nothing for them. A model that bills a refused or failed task would reopen the loop; watch `jobs.upstream_cost_usd` on failed jobs to catch it.
  - **System faults** (a compose or check container error, the job timeout) refund: the customer got nothing and can't trigger them on purpose.
  - Keep the per-job `maxCost` below the cheapest pack's net price per job, so even a job that uses every repair pass doesn't lose money. Say all of this on the site's refund page, including that results caused by the customer's own photo or prompt aren't broken results.
- **No retries on upstream failure:** Yir already retries the task across providers and the SDK retries transient HTTP errors, so a failed upstream job or a rejected submit fails the job at once with a refund. Only a 429 rate limit on submit, or a failed status read, gets Workflow step retries.
- **Finish email:** with `EMAIL` bound, signed-in users get an email when a job succeeds (result link) or fails (not charged, credits back). It is sent after the refund settles; cancelled and guest jobs get none. Like sign-in codes, it is written in the site's `defaultLocale` (English when that language has no built-in copy).
- **Upstream cost:** after a job ends (succeeded or failed), the Workflow reads `cost` for every upstream job and stores the sum in `jobs.upstream_cost_usd`. Billing can settle after the result lands, so it re-reads up to 4 times, 30 s apart, writing each complete read; only an explicit `settled` status ends the wait. Best-effort: a read failure is only logged and keeps the last amount written. Not counted: prep hedge copies, and a task the runner cancels right after a user cancel won the race against its submit (never recorded).
- **Cancel** (before submit only, see above) leaves the Workflow running: it may be inside the first submit, and only the runner learns the upstream ID it must cancel. It stops at its next step.
- **Observability:** per-stage timestamps and error classification; side effects run in `waitUntil`.
- **Resumable UI:** in-flight jobs resume after a page refresh.
- **Mock upstream:** with `UPSTREAM_MOCK` set, outputs are replaced with reference assets (text-only image jobs get the site's `public/mock-output.png`) so the whole flow (upload, charge, poll, store, deliver, refund) runs without a key or cost. It only activates when `APP_URL` is a local host or every payment credential is in test mode (the public demo), so a site that can take real money never serves fake outputs. If `UPSTREAM_MOCK` is set but the mock is inactive, `createAdapters` throws rather than fall through to the paid upstream. A public demo can also set `UPSTREAM_MOCK_RESULT` (and `_SILENT`) to R2 keys so every effect job returns the same finished video.
- **Compose container (optional):** an ffmpeg service on Cloudflare Containers (`packages/jobs/compose/`) that stitches segments and mixes audio for video sites.

### 6.1 Effects: server-side presets with several segments

An effect is a model entry with an `effect` field: the user only uploads photos, and the server swaps them into fixed reference clips. `createJobs` and `defineGenerationWorkflow` keep their signatures.

- **Server-only presets:** slots (ID, label, required) are public; segments, prompts, reference clips, checks, repair and compose live in `src/models.server.ts`. A slot's `prep` prompt is server-only too: repeat the slots there (same IDs, same order) with `prep` added.

- **Input roles:** `ModelDefinition.referenceRole` (`reference_image` or `first_frame`) says how uploads reach the upstream. Default: `reference_image` for image models, `first_frame` for video models. A video job with any `reference_*` input is sent in Yir's `reference` mode, otherwise in `image` mode.
- **Slots and segments:** `effect.slots` lists the faces a user can fill (`required` or not); `effect.segments` lists the shots, each with a reference video (R2 key under `assets/` or an https URL), the slots it swaps (in `@image1`, `@image2`… order), a prompt builder and parameters. A segment renders only when at least one of its slots is filled; empty segments fall back to the base footage.
- **Request:** `POST /api/jobs { modelId, slots: { <slotId>: '/files/uploads/…' } }`. Effects ignore `prompt`, `references` and `parameters`. A missing required slot, an unknown slot, a file not uploaded to this site, or no renderable segment returns 400.
- **Price and cost cap:** one `credits` charge per job, regardless of how many slots or segments. Every segment declares its own `maxCost` (sent upstream as max_cost); `defineModels` rejects segments whose sum exceeds the model's `maxCost`.
- **Server only:** prompts and reference videos are stored in `input_json` (`prompt` is an empty string) and never leave through `publicJob`. `/files/assets/…` serves reference assets read-only and unlistable.
- **Several upstream jobs per job:** segments are resolved into `input_json.parts` at creation. `upstream_job_id` holds the upstream IDs in segment order, comma-separated, so there is no extra column or migration; jobs without `parts` run as one segment.
  - The first submit moves `queued → submitted` (`markSubmitted`); later ones use `appendUpstreamJob`, a conditional update that requires the job to be in flight and the list to hold exactly the earlier parts. Replays skip parts that already have an ID; if the job has ended meanwhile (for example cancelled), the new upstream job is cancelled at once.
  - Idempotency keys: `jobId` for a single part, `jobId:partId` for several.
  - Parts are polled in turn (they run in parallel upstream); the timeout still counts from job creation.
  - Any failed part fails the whole job, cancels the others and refunds in full; the abort path cancels submitted parts too. Cancelling a job cancels every upstream ID.
  - On success each output is stored as `jobs/<jobId>/<n>.<ext>` and the job is marked succeeded once. The state machine, refunds and guest quota writes are unchanged.
- **Compose (`effect.compose`):** after all parts are stored, a `compose` step sends the parts, base footage and soundtrack to the container (instance keyed by job ID) with a cut list: per segment its `target` seconds in the final cut, its `base` fallback, and `fit` (`stretch` retimes the whole segment, `trim` keeps the original speed and cuts the first `target` seconds). The container re-encodes to one size and frame rate, concatenates and mixes the soundtrack; the job then lists only `final.mp4` and `final-silent.mp4`.
  - **Shot cuts (`segment.cuts`):** edit models that take a whole multi-shot clip (Kling 4.0 `Edit @video_1`) keep the shots but not the exact timing (a 17.69 s input requested as 18 s came back 18.04 s, each cut 1–3 frames late). A segment can list its cut times in the final cut; the container finds the scene cuts in the output (ffmpeg scene score > 0.3), matches each expected cut to the nearest one within 0.5 s, and retimes every shot to its exact length, the last shot by the drift of the last cut. A missing cut means the output lost the reference's shot structure: compose fails and the job is refunded.
  - **Output check (`segment.check`):** before compose, the container looks for each filled slot's original person in the output (YuNet + SFace, 2 frames per second, at least 16). Face points are `[x, y]` in the original's first frame or `[x, y, t]` at t seconds, for whole clips where people appear in different shots. Similarity at or above `maxSimilarity` fails the job with a refund (`swap_not_applied`); there is no rerun, since a video render costs dollars. An error in the check itself also fails and refunds (`check_failed`): an unchecked video may be the original clip. The step is retryable and idempotent per job; when retries run out, or the site has no container binding, the job fails and is refunded in full rather than delivering a partial result.
  - **Repair (`segment.repair`):** a missed swap can be repaired instead of refunded, for a single composed segment with `check` and `cuts`. After compose, each pass cuts the shots of the first missed slot out of the composed video (`repair.shots` lists who is in each shot), serves them at a `jobs/<id>/repair-*.mp4` URL that `/files` only answers while the job runs, and has a video replace model (Pruna `p-video-replace` through Yir) re-render them from the photos; the container retimes the result to those frames and puts it back, and every filled slot is checked again. The first pass on a set of shots repairs the whole frame with everyone in them (the model replaces the most prominent people first and would otherwise put one person's face on another); once that has run, a slot with a `crops` box at the frame edge gets its box repaired alone and blended back with feathered edges. Each pass gets a new seed, its own `maxCost`, and is recorded after the segments in `upstream_job_id`, so cancel, abort and cost cover it; `rounds` passes count toward the model's `maxCost`. When the passes run out, or the model rejects or fails one, the job fails `swap_not_applied` with a refund. A site that stops refunding once the paid render has been charged sets `onMiss: 'deliver'`: the same cases (and a timeout, a check error or a pass step that keeps throwing during the passes, a check error on the render itself, or a miss on a site that can't run passes) deliver the checked version with the fewest missed people and keep the credits; the customer can still ask for a refund of a broken result by email. Raise `rounds` with it, since each extra pass is cheap next to the render already paid for. Measured: two missed jobs repaired with one whole-frame and one box pass each, about $0.25 a pass against $3.06 for a new render. **Likeness (`repair.likeness`, needs `onMiss: 'deliver'`):** a swap can take and still not look like the customer, which the original-face check can't see (a paid order complained “you can't recognize anyone”: the close-up lead scored 0.44 against their photo). For the slots listed, the container scores the composed video against each slot's photo (the prep result, else the upload) over the shots it is in: per sampled frame the best SFace match, then the median. A filled slot below its threshold joins the missed slots and is repaired the same way, and counts as missed when picking the best version; a check error or a photo with no face (an animal) counts as no miss, so likeness only ever adds passes, never fails or refunds. Set it for close-ups only: profile and small wide-shot faces score 0.33–0.5 even when right.
- **People swaps: several photos per person, person or pet, descriptions, review.** Lessons from two complaints on one order (jersey numbers and logos gone, a face on the wrong person, fur on a person's hands, an original performer left in the corner of another shot):
  - **Prep views and subjects:** a slot's `prep` may be 1–4 prompts, one image each (`prep-<slot>`, `prep-<slot>-v1`…); the first is the main view. A segment with `subjects: { <slot>: 'Name' }` sends every view of that slot as one upstream subject (Yir `reference_image` with `subject`; Kling takes 2–4 photos per subject) and the prompt names it `@Name`. Views whose prep fails fall back to the upload; a subject's identical URLs are sent once, and a subject left with a single site photo gets it again under `?view=2`.
  - **Person or pet:** a request slot may be `{ photo, kind: 'pet' }`. Prompt builders get `kinds` (and repair prompts too), so only pets are told to grow fur and paws.
  - **Prep sheets:** `slot.prepSheet` replaces `prep` with one borderless 2x2 sheet prompt. The persisted image part carries `prepSheet: true`; four row-major crops are stored at deterministic `jobs/<id>/prep-<slot>-<view>.png` keys by a replayable container split step. These URLs are served without caching only while the job is submitted. Sheets never hedge; the cost cap counts one image per slot. A failed image falls back to the original upload for all views; split errors retry the step without generating another image. Existing stored per-view plans retain their original behavior. Before any paid preparation, an adapter's optional local `validate` hook checks every planned request using HTTPS stand-ins for future prep images. The Yir adapter uses the installed SDK validator.
  - **Descriptions (`effect.describe`):** before a segment is submitted, a `describe:<segment>` step has `RunnerDeps.describe` (Workers AI vision, `env.AI`) describe the chosen prep view of each slot whose prompt asks for it (`describe(slot)` placeholder). Best effort: a failure leaves the description out.
  - **Checks:** `check.faces` may list several points per slot (a person also seen in another shot); the slot scores its worst point, and the shots of the points that matched the original decide where repair starts. Likeness also scores each likeness slot against every other filled slot's photo: a face closer to someone else's photo is a swap and is repaired. A residual-face miss is dropped when the likeness check clearly passes (a profile shot keeps the original's outline).
  - **Repair by shot group:** shots with the same people form a group; a pass re-renders one group with the photos of everyone in it (at most 3 per shot). Groups where the original was seen go first, then the slot's other groups, then crop passes, then turns. `repair.aspect` (Pruna renders 7:9) widens crop boxes to the model's aspect before they are cut, and the container puts repaired frames back lined up on the background (`align.py`: ORB features, RANSAC similarity per frame, temporal median, feathered blend; the old stretch is the fallback). Stretching alone left the shelves visibly offset at the box edge.
  - **Review:** when repair gives up and delivers under `onMiss: 'deliver'`, the job is marked `needs review: …` in `error_message` (`error_code` stays empty, so the page shows a plain success) and `RunnerDeps.review` emails `REVIEW_EMAIL`. Never a refund or a status change.
  - **Failure streaks:** when a signed-in user's jobs fail `FAILURE_STREAK` (3) times with no success in between, `RunnerDeps.failures` emails `REVIEW_EMAIL`, listing the streak's failed jobs and their error codes (`failures.ts`, step `failures` after `notify`). The streak is ordered by when jobs ended, so the third job to fail alerts exactly once, however late its check runs and in whatever order the jobs were created; later failures stay quiet until a success ends the streak. Canceled and running jobs are not in it. `finishedAt` comes from the Worker clock: only two jobs of one user ending within milliseconds on different isolates can make a streak alert twice or not at all. Only failures that end in the runner are covered: `dispatch_failed`, stale recovery in the handlers and the Workflow's outer catch mark jobs failed without it. On 2026-11-13 a paying user retried a broken model 15 times before anyone noticed.
  - **Redo by hand:** `tools/replace-output.mjs` uploads a new file under a new key and points `outputs_json` at it; outputs are served immutable for a year, so overwriting the old key would leave viewers on the old video.
- **Site side:** export a `ComposeContainer` class and add `containers`, a `COMPOSE` Durable Object binding and its `migrations` to `wrangler.jsonc` (see the example site). Measured cost: about 33 s of a half vCPU for an 18 s 720p cut, roughly $0.0007 per job at list price.
- **Stopping: the container exits on its own.** A running instance bills its full memory whether it works or not, and `sleepAfter` in `@cloudflare/containers` 0.3.7 is not a stop guarantee: on expiry it only sends SIGTERM, then renews and sends it again every period, never SIGKILL; an unread response body keeps its in-flight count up ([#242](https://github.com/cloudflare/containers/issues/242)); re-creating an evicted Durable Object resets the timer ([#264](https://github.com/cloudflare/containers/issues/264)). Node as PID 1 without a SIGTERM handler ignored that signal, and 21 instances idled for about 984 instance-hours (about $74) before anyone noticed. So `server.mjs` exits after 60 s with no request in flight (calls within a step come seconds apart; upstream waits between repair passes take 75 s or more) and 10 minutes after start regardless; a request cut off by the cap fails its step, which retries on a fresh instance. Deploying a new image does not replace instances already running: after changing the image, destroy the old ones. To check, query `containersUsageAdaptiveGroups` per instance and minute in the GraphQL Analytics API: billing should stop within a minute or two of the last call.

## 7. Guests and abuse

- Guest quota is enforced by D1 counters per IP and per device cookie, plus a daily budget per site. reCAPTCHA v3 scores raise the bar.
- A captcha only raises the cost of abuse; solving services are cheap. The real backstop is the quota and the daily site budget.
- Failed guest jobs return their quota; cancelled ones don't, since the upstream may already have charged for them.
- Guest results are attached to the new account after sign-in.
- The sign-up bonus requires a verified email and blocks disposable domains, with a per-IP daily limit (`signup.bonusPerIpDaily`) and a site-wide daily limit (`signup.bonusSiteDaily`). The site-wide limit caps the daily cost of farming bonuses with fresh emails and rotating IPs; past it, sign-up still works but grants nothing that day.

## 8. Testing

- **Money unit tests:** race replays, including concurrent debits, duplicate webhooks, out-of-order events and refunds that fail midway.
- **Site checks:** one command per site runs typecheck, build and launch checks (required routes, policy pages without placeholders, no cross-site imports).

## 9. Parallel development with worktrees

Goal: several AI sessions work in separate worktrees at once, a new worktree is runnable in minutes, merges rarely conflict, and local checks never interfere with each other.

**New worktrees work out of the box**

- `pnpm install` uses the global content-addressed store with hard links. Keep the store on the same disk as the repo, or hard links degrade into copies.
- Secrets stay outside the repo in `~/.config/shipwords/<site>.dev.vars` (override with `SHIPWORDS_SECRETS`). `pnpm setup:worktree` copies them in.
- Local D1, R2 and Workflows state lives in each worktree's own `.wrangler/state`.
- Dev ports are derived from the site name in the main checkout (same port on every machine) and from the full path in a worktree, so worktrees never fight over a port.

**Fewer merge conflicts**

- Generated files (`routeTree.gen.ts`, Paraglide output, `worker-configuration.d.ts`) are git-ignored and regenerated by dev, build and check.
- No central files everyone edits: no barrel `export *` files, messages split by block, `docs/live/` one topic per file, the site list generated from code.
- Timestamp-prefixed migrations never collide.
- Lockfile conflicts are resolved by rebasing and rerunning `pnpm install`. Dependency upgrades are their own change.

**Splitting work**

- Sites in parallel: one worktree per site.
- Packages in series: one session at a time changes `packages/*` and checks every dependent site; others rebase after it lands.
- Public interface changes (payment adapter, job runtime) start with a short note in `docs/live/`.

**Preview and deploy**

- Preview with `wrangler versions upload` from any worktree; it does not take production traffic.
- Production deploys run only from main, one site at a time.

## 10. Left open on purpose

These directions are kept possible without code written for them today:

| Direction                                         | What keeps it open                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| More payment providers                            | Provider interface and provider-neutral product catalog                       |
| Synchronous conversion tools                      | Execution lives in its own package; a sync-call package can sit beside `jobs` |
| Many more sites                                   | Independent deploys; selective builds and batch deploys can be added          |
| A site outgrowing the repo                        | A site depends only on packages and can be moved out with them                |
| Admin back office, agent API, cron reconciliation | All money state is in D1 tables; reconcile helpers are idempotent             |

## 11. Known limitations

**Not yet verified**

- Stripe subscription renewals (packs, refunds and disputes are tested in test mode). Test renewals with `stripe listen` and a test card before launching a subscription site.
- PayPal disputes and the second automatic renewal never fired in the sandbox; check the first real renewal after launch.
- reCAPTCHA scoring is only tested against fake assessment responses; configure a real key before launch.

**Accepted trade-offs**

- Refund amounts and dispute states merge monotonically (refunds only grow; disputes go none → open → won or lost). If a Stripe refund fails and `amount_refunded` shrinks, credits are not restored; re-grant them by hand.
- The credit ledger uses a per-user version lock, so one user's ledger writes are serialized; heavy concurrent debits for the same user retry (up to 8 times) without affecting correctness.
- PayPal subscription payments do not expose partial refund amounts, so a partial refund claws back the whole period's credits; refund subscriptions in full only.
- Cancelling a PayPal subscription takes effect immediately, but the paid period stays active (last payment time plus one interval).
- Engine emails use the site's `defaultLocale`, not the visitor's locale, so a multi-locale site sends one language. Better Auth's own error messages stay English; sites translate what they show.
- Concurrency tests run on workerd's in-memory D1 with `Promise.all`; they approximate interleavings rather than step through them.

**Not built**

- One site using Stripe and PayPal at the same time; each site picks one provider.
- Timeout fallback runs when a user views the job; a stuck job nobody looks at is not refunded until then. Add a cron sweep if needed.
- Admin back office, agent API, cross-site stats.
