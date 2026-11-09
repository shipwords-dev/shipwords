# Tiny Desk AI (example)

- **What it is**: the source of [tinydeskai.io](https://tinydeskai.io/), a live shipwords site for the "Outstanding" Tiny Desk AI trend (put anyone into the band and get a 9:16 clip). Open-sourced as a complete example: fork it and launch your own version of the keyword.
- **Not deployed from here.** tinydeskai.io is deployed from its own private config. Domain, resource names, IDs and the support email in this copy are placeholders.

## How it works

- **Product**: a fixed four-shot template (band, lead close-up, sax solo, band). The stage starts with five dogs; visitors tap a seat and upload a photo (at least one of their own). × on a photo puts the dog back, × on a dog keeps the original coach. Price is per video, 1 to 5 people.
- **Generation** (`site.models.ts` for the name, price and slots; `src/models.server.ts` for the rest): an effect model. Each photo is first cleaned up by GPT Image 2.5 into a single-subject, front-facing, waist-up shot (the original is used if that fails). Kling 4.0 in edit mode then takes the whole 17.7-second clip plus the photos and replaces those people in one pass (about $3.06 at 720p); seats still showing a dog are sent as dog photos, cleared seats keep the original coaches. The compose container (`packages/jobs/compose`, ffmpeg) checks each swapped seat for a leftover original face (and the lead close-up for likeness to the photo); misses are re-rendered shot by shot with Pruna p-video-replace, up to 5 rounds, and the version with the fewest misses is delivered. Once Kling has charged, a missed swap or a failed check no longer refunds the credits; they come back only when no video can be made (the render or compose fails). Compose then re-aligns the output to the original cut points and mixes the song back in, delivering a version with the song and a silent one.
- **Pages**: tool home page, tutorial, template page, meme explainer, free page, pricing, policies; FAQ and structured data on each.
- **Flow**: sign in (Google or email code), buy credits, generate. No guest trial and no signup bonus.
- **Rybbit funnel**: photo_added → generate_click → sign_in_open → sign_in → generate_started → (insufficient_credits →) pricing_open → checkout_start → payment_confirmed → generate_started → video_ready → video_download.

## Media is not in the repo

The reference clips, base clips, song and sample videos are cut from third-party footage and music, so they are not committed:

- `public/media/` (stage photos, sample clips including the dog version) is git-ignored.
- The R2 objects under `assets/tinydesk/` (`full-17s.mp4`, the clip used as reference, base and check original, and `song.m4a`) are keyed in `src/models.server.ts`.

Use footage and music you have the rights to, or AI-generated base clips, and keep the DMCA page and contact email (both included).

## Run it locally

1. `~/.config/shipwords/tinydeskai-example.dev.vars` from `.dev.vars.example` (Stripe test key, Google OAuth client with `http://localhost:<port>` as an origin), then `pnpm setup:worktree`, which prints the port.
2. Put your media in `public/media/` and your clips into local R2: `pnpm wrangler r2 object put tinydeskai-example-outputs/assets/tinydesk/<file> --local --file <file>`.
3. `pnpm db:migrate:local && pnpm dev`; `node ../../tools/stripe-listen.mjs` forwards Stripe test webhooks.

`UPSTREAM_MOCK=1` (the default in `.dev.vars.example`) runs the whole flow without calling the paid upstream: outputs are the reference clips. Set `UPSTREAM_MOCK_RESULT` / `UPSTREAM_MOCK_RESULT_SILENT` to R2 keys of a finished video to return that instead.

## Launch your own

1. Pick a domain; set `url` in `site.config.ts`, `routes` and `EMAIL_FROM` in `wrangler.jsonc`, `SUPPORT_EMAIL` in `src/site/legal.tsx`, and rename the resources.
2. `pnpm wrangler d1 create <name>`, put the id in `wrangler.jsonc`, `pnpm db:migrate:remote`; create the R2 bucket, upload the assets, add a lifecycle rule deleting `uploads/` after 2 days.
3. Secrets: `YIR_API_KEY`, Stripe keys and webhook secret, `BETTER_AUTH_SECRET`, `GUEST_COOKIE_SECRET`, Google OAuth, `APP_URL`. No `UPSTREAM_MOCK` in production.
4. Follow `docs/site-launch.md`; `pnpm check` blocks until the placeholders above are replaced. Then `pnpm run deploy`.
