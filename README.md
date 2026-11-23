<div align="center">

<a href="https://shipwords.dev/"><img src="apps/www/public/img/og.jpg" alt="shipwords: One keyword. One site." width="100%"></a>

**An open-source framework for new-keyword site fleets: a new site in an afternoon, taking payments the day it launches.**

[![CI](https://github.com/shipwords-dev/shipwords/actions/workflows/ci.yml/badge.svg)](https://github.com/shipwords-dev/shipwords/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![TanStack Start](https://img.shields.io/badge/TanStack-Start-FF4154?logo=reactquery&logoColor=white)](https://tanstack.com/start)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![GitHub stars](https://img.shields.io/github/stars/shipwords-dev/shipwords?style=flat&logo=github)](https://github.com/shipwords-dev/shipwords/stargazers)

**English** · [中文](README.zh-CN.md)

</div>

shipwords is a free, MIT-licensed framework for running a fleet of new-keyword AI image and video sites on Node, Postgres and Docker, one site per keyword. What stays the same is shared: accounts, payments, credits and AI generation are written once. What changes is each site's own: pages, look and domain. Website: [shipwords.dev](https://shipwords.dev/).

> **Coming from `v0.2.0` or earlier (Cloudflare Workers)?** Since 2026-11-22 `main` runs on Node, Postgres and Docker, and the Workers runtime is gone. This is a breaking change with no in-place upgrade. `v0.2.0` stays tagged and keeps working as it is, but it gets no more fixes. A site with users moves over with the [migration guide](docs/migrating-from-workers.md), which carries over users, credits, orders and files. A site without users is quicker to recreate from the current template. Why we moved: [architecture §1](docs/architecture.md#1-goals).

## Why shipwords

**Built for a fleet of new-keyword sites.** Put up a site for every new keyword, keep improving the ones that take off, and leave the rest alone. Fix a bug in the shared core once, and every site can take the update on its next deploy. Each site deploys on its own, with its own database, storage and payment account, so launching or retiring one never touches the others.

**Proven AI, built in.** [tinydeskai.io](https://tinydeskai.io/) is built on shipwords, and its full source is in [`sites/tinydeskai-example`](sites/tinydeskai-example), ready to fork.

- **Video templates**: turn a viral clip into a template; visitors upload photos and get the same video back. That's how Tiny Desk AI works.
- **Face swap that holds up**: the whole clip in one pass. Each uploaded photo replaces a performer, face, hair and clothes, with mouths still on the beat. Missed swaps can be re-rendered shot by shot before delivery, as tinydeskai.io does.
- **The popular models, built in**: GPT Image, Nano Banana, Seedream, FLUX, Seedance, Veo, Kling, Wan and more, behind one Yir API key, paid per generation.

**Takes money out of the box.** Every site comes with:

- Google and email sign-in, account page
- Stripe and PayPal, credit packs and subscriptions, orders and refunds
- Email notifications
- Free guest tries with abuse limits (reCAPTCHA v3)
- Privacy, terms, refund and DMCA pages
- SEO, `sitemap.xml`, `robots.txt`, `llms.txt`, analytics

The money code is shared and tested: double charges, repeated or out-of-order payment events and refunds for failed jobs are all covered.

## Build a site with your coding agent

No keyword yet? [new-term-radar](https://github.com/zhuyansen/new-term-radar), a separate open-source project, catches new AI terms on X, Hugging Face, GitHub and sitemaps every day, before keyword tools list them.

Paste this into Claude Code, Codex or Cursor, with your own keyword:

```text
Read shipwords.dev/llms.txt and build a site for "<your keyword>"
```

The agent clones the repo, creates the site and runs it locally. The rules it follows are in [AGENTS.md](AGENTS.md).

## Quick start

Requirements: Node 24 (see `.nvmrc`), pnpm 10 (`corepack enable`), Postgres 17 (Docker's `postgres:17-alpine` works), and Git Bash or WSL on Windows. To go live you will also need a machine that runs Docker, a Cloudflare account (DNS, R2 storage, email) and a Stripe or PayPal account.

1. Fork or clone this repo, then install:

   ```bash
   pnpm install
   ```

2. Create your first site from the template, then install again so the new site gets its dependencies:

   ```bash
   pnpm new-site my-tool --domain my-tool.com
   pnpm install
   ```

3. Create a Postgres database for the site (for example `my_tool_dev`), then put local settings outside the repo and copy them in:

   ```bash
   mkdir -p ~/.config/shipwords
   cp sites/my-tool/.env.example ~/.config/shipwords/my-tool.env   # set DATABASE_URL and the two secrets
   pnpm setup:worktree
   ```

   Once `DATABASE_URL` is set and `BETTER_AUTH_SECRET` and `GUEST_COOKIE_SECRET` hold 32 random bytes each (`openssl rand -hex 32`; the placeholders are refused), the example file runs as-is: email sign-in works (the code is printed in the dev server's terminal), new accounts get sign-up credits, and generations use the mock upstream (`UPSTREAM_MOCK=1`), so no model key is needed. Fill in more as you need it:
   - **Real generations**: a [Yir API key](https://yir.ai/?utm_source=shipwords&utm_medium=readme), with `UPSTREAM_MOCK` turned off.
   - **Buying credits**: a Stripe test key (`sk_test_…`), then `node ../../tools/stripe-listen.mjs` in the site directory to forward webhooks.
   - **Guest free tries**: reCAPTCHA keys. Without them, visitors sign in before their first generation.
   - **Google sign-in**: a Google OAuth client with `http://localhost:<port>` as an origin. Optional; email sign-in works without it.

4. Run it:

   ```bash
   cd sites/my-tool
   pnpm db:generate && pnpm db:migrate
   pnpm dev
   ```

When you are ready to go live, follow [docs/site-launch.md](docs/site-launch.md): each site ships as a Docker image that you run on your own machine behind Cloudflare.

## What it costs

The code is free under MIT, including commercial use. What you pay for:

- Domains (Cloudflare Registrar sells them at cost).
- A machine that runs the sites in Docker; several sites can share one.
- Cloudflare usage: R2 storage and email sending.
- Stripe or PayPal fees on each order.
- Model calls on Yir, billed per request. Each job's maximum cost is set in `src/models.server.ts`.

## Repository layout

| Directory                  | What it holds                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`            | Postgres + Drizzle, credit ledger with idempotent writes, Stripe and PayPal billing (packs, subscriptions, refunds, disputes), Better Auth, guest quota + reCAPTCHA v3, SEO/GEO helpers, analytics proxy, headless React hooks                          |
| `packages/jobs`            | Generation runtime on Postgres (resumable job runs) with a one-way job state machine and automatic refunds, upstream adapter interface, Yir adapter (`@yir-ai/sdk`), mock upstream for local dev, S3/R2 object storage, optional ffmpeg compose service |
| `templates/ai-site`        | A complete, working AI image site copied by `pnpm new-site`: home, pricing, account, login, policy pages, `sitemap.xml`, `robots.txt`, `llms.txt`, plus its `Dockerfile` and `compose.yaml`                                                             |
| `sites/<site>`             | Your sites, one per keyword, each deployed on its own                                                                                                                                                                                                   |
| `sites/tinydeskai-example` | The full source of tinydeskai.io (video effect: photo slots, one-pass video edit, output check, repair passes, ffmpeg compose, content pages), with its `Dockerfile`, `compose.yaml` and a generation contract test                                     |
| `apps/<sidecar>`           | Optional small Workers that belong to no single site                                                                                                                                                                                                    |
| `tools/`                   | `new-site` scaffolder, `check-site` launch checks, `list-sites`, worktree setup, dev-port, Stripe webhook forwarding, D1 import (Node built-ins only, with tests)                                                                                       |
| `docs/`                    | Architecture, local development, launch handbook                                                                                                                                                                                                        |

Each site is a TanStack Start + React 19 app served by Node in its own Docker container, with its own Postgres database and an S3-compatible bucket (Cloudflare R2). Cloudflare stays in front as DNS and CDN.

## Common commands

```bash
pnpm new-site <dir> --domain <domain>   # scaffold sites/<dir> from the template
pnpm list-sites                         # site list generated from each site's code and README
pnpm setup:worktree                     # copy local secrets into a new worktree, fix dev ports
pnpm --filter "./sites/<site>" dev
pnpm --filter "./sites/<site>" check    # typecheck + build + launch checks
pnpm check:packages                     # core + jobs: typecheck + tests
pnpm check:template
pnpm lint && pnpm test:tools
```

## Docs

- [Architecture and design choices](docs/architecture.md)
- [Local development](docs/local-development.md)
- [Site launch handbook](docs/site-launch.md)
- [Migrating a site from Cloudflare Workers](docs/migrating-from-workers.md) (sites on `v0.2.0` or earlier)
- [Rules for AI coding agents](AGENTS.md)
- [Contributing](CONTRIBUTING.md) and [security policy](SECURITY.md)

## Community

Questions, ideas and sites you shipped go in [GitHub Discussions](https://github.com/shipwords-dev/shipwords/discussions): [Q&A](https://github.com/shipwords-dev/shipwords/discussions/categories/q-a), [Show and tell](https://github.com/shipwords-dev/shipwords/discussions/categories/show-and-tell), [Ideas](https://github.com/shipwords-dev/shipwords/discussions/categories/ideas). Bugs go in [Issues](https://github.com/shipwords-dev/shipwords/issues).

## License

[MIT](LICENSE)
