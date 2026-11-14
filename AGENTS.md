# shipwords agent guide

One site per keyword: every site shares `packages/`, and each site under `sites/<site>/` deploys and takes payments on its own. Design and trade-offs: [docs/architecture.md](docs/architecture.md).

## 1. Directories and boundaries

| Directory           | What goes there                                                          | Rule                                                                                    |
| ------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `packages/core`     | Database, credit ledger, billing, auth, guest quota, SEO, headless hooks | No pages, no styles, no site-specific logic                                             |
| `packages/jobs`     | Async generation jobs (Workflows), upstream adapters (Yir, mock)         | Same as above                                                                           |
| `templates/ai-site` | AI site template, copied by `pnpm new-site`                              | The template itself must pass `pnpm check`                                              |
| `sites/<site>`      | A complete TanStack Start app                                            | Depends only on packages; **never import another site** (Biome and check-site block it) |
| `apps/<sidecar>`    | Small Workers that belong to no single site                              | Each has its own README stating its boundary                                            |
| `tools/`            | Repo scripts, Node built-in modules only                                 | Every script has tests (`pnpm test:tools`)                                              |
- Pass site differences into packages through `site.config.ts` and `site.models.ts`. Never put a site name in packages.
- Pages, components, styles and copy belong to the site. Write the site's `DESIGN.md` before changing styles; each site must look distinct from the others.
- To reuse something from another site, move it into packages or copy it into this site.
- Every site must have a DMCA page and a contact email.
- **Browser boundary:** whatever a page imports ships to the browser. Server-only code and data (prompts, upstream models, cost caps, reference clips) go in `*.server.ts`; `site.models.ts` holds only what pages show and `src/models.server.ts` the rest. Secrets come only from the Worker `env` at runtime, and config reaches the browser only through an allowlisting server function. Reviews check this too. Details: [architecture](docs/architecture.md) §4.

## 2. Money and auth: strict

When changing `packages/core/src/{credits,billing,auth,quota}` or `packages/jobs/src/{lifecycle,runner}`:

- Every money write carries an idempotency key; multiple writes go into one D1 batch. Concurrency is guarded by CHECK constraints and conditional UPDATEs.
- Webhooks are trigger signals only. Read state from the provider API; never grant credits from event contents.
- Job states only move forward. Failed and cancelled jobs settle refunds from their final state.
- Never refund credits on a path the customer can repeat after the upstream has charged (cancel after submit, a paid render that missed): a refund is a free retry. See [architecture](docs/architecture.md) §6, refunds and upstream charges.
- Add tests for races, duplicates, out-of-order events and partial failures. Get an independent review before merging.

## 3. Parallel work (worktrees)

- **Sites can be parallel**: one worktree changes one site.
- **Packages are serial**: only one session changes `packages/*` at a time; others rebase after it lands on main.
- Before changing a public interface (payment adapter, job runtime, site config types), write a short note in `docs/live/`.
- New worktree: `pnpm install && pnpm setup:worktree`. Secrets never enter the repo; see [local development](docs/local-development.md).
- Do not commit generated files (`routeTree.gen.ts`, `worker-configuration.d.ts`, `src/paraglide/`). On lockfile conflicts, rebase and rerun `pnpm install`; never hand-edit the lockfile.
- Generate migrations with `pnpm db:generate` (timestamp prefix). Never hand-number migration files.

## 4. Verification

Run only the affected scope; do not build every site locally.

```bash
pnpm --filter @shipwords/core check        # changed core: typecheck + tests
pnpm --filter @shipwords/jobs check        # changed jobs
pnpm --filter "./sites/<site>" check       # changed a site: typecheck + build + site checks
pnpm --filter "...@shipwords/core" check   # changed a core interface: core plus every dependent site
pnpm check:template                        # changed the template
pnpm test:tools && pnpm lint               # changed tools or config
pnpm check:public                          # always in CI: no private-looking values (emails, IDs, live keys) in tracked files
```

- Tests run in workerd with an in-memory D1: no ports, no shared database, safe to run in several worktrees at once.
- Pure copy or style changes need no new tests.

### Release gate for generation flow changes

Changes to generation models or SDKs, media references, subject grouping, preparation/cropping, configuration merging, orchestration or request construction must pass the checks below before release. **Mock tests, typechecking and a successful build alone are not sufficient.**

- **Exercise the actual site configuration through the full request path.** Load the site's `site.models.ts` and `src/models.server.ts`, then use the real configuration merge, job planner and adapter request builder. A handwritten equivalent fixture is not a substitute. Assert that new fields survive every layer, and check paid task counts, reference counts and roles, subject grouping, prep placeholder resolution and cost caps. Cover all enumerable seat combinations; for unbounded inputs, cover supported modes and boundaries.
- **Validate with the installed real SDK.** Use the SDK version resolved by the project's lockfile to validate final request structures, including the site's actual combinations such as reference video plus multiple subjects. Verify that required capabilities are compatible with that version; do not mock the validation layer. When SDK validation covers only common structure, also check model-contract limits and do not claim that structural validity guarantees provider acceptance.
- **Validate before spending.** Check downstream generation requests before any paid preparation. Future media may use structurally equivalent valid placeholder URLs for local validation only; submission must resolve them to real results. Fail deterministic parameter or compatibility errors early rather than spending repeatedly through retries or hedges.
- **Keep cross-layer regression coverage.** Mocks remain useful for network behavior, races, failures and recovery, but must be accompanied by a repeatable automated check from actual configuration through real request construction to real SDK validation. Configuration and compatibility fixes need regression coverage on that path, not just isolated functions.
- **Report the validation boundary.** Commit or release notes must identify the actual configuration, SDK version, scenarios and results, distinguishing static contract validation, simulated execution, real media processing and paid end-to-end tests. Static checks must not initiate paid generation by default; paid tests stay within the user's authorized budget. Do not claim end-to-end success without running it. A failed or missing required check blocks release.
- **Look at the first live results.** After a generation change reaches production, open the first 5 finished live jobs of the affected model and judge them as the customer would (for a person swap: is the chosen person in the hero shot, alone, recognizable), not by job status. The release is not done until they have been looked at; list them in the release note.

## 5. Preview and deploy

- Preview: in the site directory, `pnpm deploy:preview` (`wrangler versions upload`) returns a preview URL without touching production. Preview versions share the production D1 and R2.
- **Production deploys run only from main, one site at a time, and need explicit confirmation from the user.** For package changes, deploy one site and watch it before deploying the other live sites.
- Remote migrations (`pnpm db:migrate:remote`), creating Cloudflare resources, and configuring Stripe/PayPal or secrets all need explicit confirmation from the user.

## 6. Docs

- `docs/` holds confirmed design and handbooks. `docs/live/` holds unfinished work, one topic per file; delete or fold it into `docs/` when done.
- Each site's profile lives in `sites/<site>/README.md`. Generate the site list with `pnpm list-sites`; do not keep a separate ledger.
- No progress logs; the commit message is the record.
- `README.md` and `README.zh-CN.md` say the same thing; change both together.
