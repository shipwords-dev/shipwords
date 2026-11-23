# Tiny Desk AI (example)

- **What it is**: the source of [tinydeskai.io](https://tinydeskai.io/), a live shipwords site for the "Outstanding" Tiny Desk AI trend (put anyone into the band and get a 9:16 clip). Open-sourced as a complete example: fork it and launch your own version of the keyword.
- **Not deployed from here.** tinydeskai.io is deployed from its own private config. The domain, emails and analytics IDs in this copy are placeholders, and `"example": true` in `package.json` lets `pnpm check` pass with them (see [Launch your own](#launch-your-own)).

## How it works

- **Product**: a fixed four-shot template (band, lead close-up, sax solo, band). The stage starts with five dogs; visitors tap a seat and upload a photo (at least one of their own). × on a photo puts the dog back, × on a dog keeps the original coach. Price is per video, 1 to 5 people.
- **Generation** (`site.models.ts` for the name, price and slots; `src/models.server.ts` for the rest): an effect model.
  - **Prep:** each person's photo becomes two images (GPT Image): a two-panel reference (face, and outfit from the neck down) for the video model, and a front chest-up portrait for repairs and the likeness check. A vision model writes a short description of each person for the prompt (`effect.describe`: GPT 6.2 Sol on the Vercel AI Gateway, Workers AI as the fallback).
  - **Video:** Kling 4.0 in edit mode takes the whole 17.7-second clip plus one reference image per person and replaces those people in one pass (about $3.06 at 720p). Seats still showing a dog are sent as dog photos; cleared seats keep the original coaches.
  - **Checks and repair:** the compose service (`packages/jobs/compose`, ffmpeg and face models) checks that no original face is left in a swapped seat and that the lead and the keyboard player look like their photos. A missed seat is re-rendered by Pruna `p-video-replace`, one person per pass over the shots they are in, up to 5 passes. Once Kling has charged, the job delivers the best version instead of refunding, and `REVIEW_EMAIL` gets a note.
  - **Compose:** the output is re-aligned to the original cut points and the song is mixed back in, delivering a version with the song and a silent one.
  - **Cost cap:** Kling 3.40 + repairs 5 × 0.40 + prep 0.15 stays under the job cap of $5.60, below the net price per video of the cheapest pack.
- **Tests**: `test/generation-contract.test.ts` runs the site's real configuration through the engine's planner, request builder and runner with a fake upstream and compose service, and validates every request with the installed Yir SDK, for all 31 seat combinations. No paid generation runs.
- **Pages**: tool home page, tutorial, template page, meme explainer, free page, pricing, policies; FAQ and structured data on each. Phone upload by QR code keeps its pairing codes in two site tables (`src/site/schema.ts`).
- **Flow**: sign in (Google or email code), buy credits, generate. No guest trial and no signup bonus. Order photos get a private copy (`keepUploads`), which the privacy policy states.

## Media is not in the repo

The reference clip, song and sample videos are cut from third-party footage and music, so they are not committed:

- `public/media/` (stage photos, sample clips including the dog version) is git-ignored.
- The storage objects under `assets/tinydesk/` (`full-17s.mp4`, the clip used as reference, base and check original, and `song.m4a`) are keyed in `src/models.server.ts`.

Use footage and music you have the rights to, or AI-generated base clips, and keep the DMCA page and contact email (both included).

## Run it locally

Set up as in [local development](../../docs/local-development.md), then:

1. Copy `.env.example` to `~/.config/shipwords/tinydeskai-example.env`, set `DATABASE_URL` and the two secrets, and run `pnpm setup:worktree` from the repo root, which prints the port.
2. Put your media in `public/media/` and your clips under `STORAGE_DIR` at `assets/tinydesk/<file>` (or in your bucket with `S3_*`).
3. In this directory: `pnpm db:migrate && pnpm dev`; `node ../../tools/stripe-listen.mjs` forwards Stripe test webhooks.

`UPSTREAM_MOCK=1` (the default in `.env.example`) runs the whole flow without calling the paid upstream or the compose service: outputs are the reference clips. Set `UPSTREAM_MOCK_RESULT` / `UPSTREAM_MOCK_RESULT_SILENT` to storage keys of a finished video to return that instead. Real generations need `YIR_API_KEY` and the compose service (`COMPOSE_URL`).

`pnpm check` runs the typecheck, the tests, the build and the launch checks. `docker compose up --build` runs the production image with its own Postgres and the compose service.

## Launch your own

1. Pick a domain; set `url` in `site.config.ts`, `EMAIL_FROM` in your `.env`, `SUPPORT_EMAIL` in `src/site/legal.tsx`, your analytics IDs, and the names in `compose.yaml` and `package.json`.
2. Remove `"example": true` from `package.json`: `pnpm check` then blocks until the placeholders above are replaced.
3. Create the database and bucket, upload the assets, and add a lifecycle rule deleting `uploads/` after 2 days. Settings: `YIR_API_KEY`, Stripe keys and webhook secret, `BETTER_AUTH_SECRET`, `GUEST_COOKIE_SECRET`, Google OAuth, `APP_URL`, `COMPOSE_URL`, email credentials. No `UPSTREAM_MOCK` in production.
4. Follow the [launch handbook](../../docs/site-launch.md): build the image, run `migrate.mjs`, start the containers.
