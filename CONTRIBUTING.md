# Contributing

Thanks for helping. Keep changes small and focused.

- **One topic per PR.** Do not mix refactors, dependency upgrades and features.
- **Run the scoped checks** for what you touched (see [AGENTS.md](AGENTS.md#4-verification)):

  ```bash
  pnpm --filter @shipwords/core check
  pnpm --filter @shipwords/jobs check
  pnpm check:template
  pnpm test:tools && pnpm lint
  ```

- **Money paths need tests.** Changes to credits, billing, auth, quota or the job lifecycle must add tests for races, duplicate and out-of-order webhooks, and partial failures. Money writes use idempotency keys and a single Postgres transaction.
- **Sites must not import each other.** Shared code goes into `packages/`; packages never contain site names, pages or styles.
- Generate migrations with `pnpm db:generate`; do not commit generated files or hand-edit `pnpm-lock.yaml`.
- Never commit secrets. Local secrets live in `~/.config/shipwords/` (see [docs/local-development.md](docs/local-development.md)).

Security issues: see [SECURITY.md](SECURITY.md).
