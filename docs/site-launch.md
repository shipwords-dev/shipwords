# Site launch handbook

From keyword to a live, paid site. Steps marked **(confirm)** create resources, cost money or affect production; an AI agent must get explicit confirmation before running them.

A site runs as a Docker container on a machine you control, with a Postgres database and an S3-compatible bucket (Cloudflare R2). Cloudflare sits in front as DNS, CDN and WAF and sends the site's email.

## 1. Domain (confirm)

1. Buy the domain on Cloudflare Registrar (or add an existing domain to Cloudflare and switch its nameservers).
2. Pick a support address such as `support@<domain>`. Every site needs a contact email and a DMCA page.

## 2. Create the site

1. `pnpm new-site <dir> --domain <domain>` copies `templates/ai-site` into `sites/<dir>`, names its image and compose project, and sets the site URL and email domains.
2. Fill in `sites/<dir>/README.md`: target keyword and intent, competitors, and what makes this site different. If there is no difference yet, do not launch.
3. Test the upstream before setting prices: run a few real generations through [Yir](https://yir.ai/?utm_source=shipwords&utm_medium=docs), record cost, latency and quality, and set each model's `maxCost` with headroom.
4. Write `DESIGN.md`, then restyle `src/site/styles.css` and the pages to match. Rewrite the home page copy, titles and FAQ for the target keyword.
5. Choose models: names and prices in `site.models.ts`, upstream models and cost caps in `src/models.server.ts`; set products, signup bonus and guest quota in `site.config.ts`.
6. Replace the `TODO` placeholders in the policy texts under `messages/legal/`. `check-site` fails until they are gone.

## 3. Machine and database (confirm)

- A Linux machine with Docker and Docker Compose, and a checkout of the repo on `main`. Images are built on it from the workspace root (`sites/<dir>/compose.yaml` does this).
- The site's `compose.yaml` runs the site, its own Postgres 17 and the compose service. Several sites on one machine share one Postgres and one compose service instead: give each site a database and a role of its own,

  ```sql
  create role <dir> login password '<password>';
  create database <dir> owner <dir>;
  ```

  set `SITE_DATABASE_URL` (and `SITE_COMPOSE_URL`) in the site's `.env`, and leave the `db` and `compose` services out of its `compose.yaml`. Give each site its own host port in `ports`.
- The compose service is only needed by effect sites that stitch video. It listens on the internal Docker network only.

## 4. Cloudflare (confirm)

- **DNS and CDN:** point the domain at the machine with a proxied record, so all traffic passes through Cloudflare. A reverse proxy on the machine forwards the domain to the site's port (`127.0.0.1:3000` in the template).
- **Origin accepts Cloudflare only.** Guest quotas and visitor IPs trust the `cf-connecting-ip` header, which anyone can send to an open origin. Firewall the proxy's public ports to [Cloudflare's IP ranges](https://www.cloudflare.com/ips/), or have the proxy drop that header on requests from anywhere else.
- **Bucket:** create an R2 bucket (for example `<dir>-outputs`) and an R2 API token with object read and write on it. Its S3 credentials go into `S3_ENDPOINT` (`https://<account id>.r2.cloudflarestorage.com`), `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.
- Add an R2 lifecycle rule on `uploads/` (for example, delete after 2 days) that matches the retention promised in your privacy policy.
- **Email:** enable Email Sending for the domain and add the DNS records it asks for. Create an API token with Email Sending permission (and Workers AI, if the site describes images with `effect.describe`); it goes into `CLOUDFLARE_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID`. Set `EMAIL_FROM` to an address on the domain.
- Support inbox: enable Email Routing, forward `support@<domain>` to your inbox (verify the destination), and drop catch-all mail. Use this address on the policy pages and in the footer.

## 5. Settings and secrets (confirm)

On the machine, create `sites/<dir>/.env` from `.env.example`, readable only by you. It is never committed and never part of the image (`.dockerignore` excludes it); the container reads it at start.

- `APP_URL=https://<domain>`. Remove `UPSTREAM_MOCK` (with live payment keys the job worker refuses to start while it is set) and `MAIL_LOG`, and drop `STORAGE_DIR` once `S3_*` is set.
- `POSTGRES_PASSWORD` for the site's own Postgres, or `SITE_DATABASE_URL` for a shared one.
- `BETTER_AUTH_SECRET`, `GUEST_COOKIE_SECRET`: 32 random bytes each, different for every site.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: a Google Cloud OAuth client. Redirect URI `https://<domain>/api/auth/callback/google`; add the domain as an authorized JavaScript origin (One Tap needs it). Also register `http://localhost:<dev port>` for local testing. A consent screen with only basic scopes and no logo can be published without verification.
- `RECAPTCHA_SITE_KEY` / `RECAPTCHA_PROJECT_ID` / `RECAPTCHA_API_KEY`: a score-based Google Cloud reCAPTCHA key restricted to the domain; restrict the API key to the reCAPTCHA Enterprise API.
- `YIR_API_KEY`: from [yir.ai](https://yir.ai/?utm_source=shipwords&utm_medium=docs). One key per site makes per-site cost easy to see.
- `REVIEW_EMAIL` (optional): where review notes and failure-streak alerts go.

## 6. Payments (confirm)

Each site picks one provider in `site.config.ts` under `billing.provider`: `stripe` or `paypal`. Configure only that provider's secrets. Use a separate payment account per site where possible.

### Stripe

- Create a webhook endpoint at `https://<domain>/api/webhooks/stripe`. For credit packs only, listen to:
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `charge.refunded`, `charge.refund.updated`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`.
  With subscription products, also add `invoice.paid`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
- With subscriptions, enable the Customer Portal (cancel subscription, update payment method, view invoices). For packs only, the account page links each order to its provider receipt (`/api/billing/receipt`).
- For automatic tax, enable Stripe Tax and set `billing.automaticTax: true` in `site.config.ts`.
- Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `.env`.

### PayPal

- Set `billing: { provider: 'paypal' }` in `site.config.ts`.
- On developer.paypal.com, create a REST app (one Live, one Sandbox) with Subscriptions and Disputes enabled. Without Disputes access, payment reconciliation fails.
- Subscription products need a Product and Plan created first (price and interval matching `site.config.ts`); put the Plan ID into the product's `refs: { paypal: 'P-...' }`. To change a price, create a new Plan and swap the ID. Credit packs need nothing pre-created.
- Create a webhook at `https://<domain>/api/webhooks/paypal` with these events:
  `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`,
  `PAYMENT.SALE.COMPLETED`, `PAYMENT.SALE.REFUNDED`, `PAYMENT.SALE.REVERSED`,
  `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`, `CUSTOMER.DISPUTE.RESOLVED`,
  `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.UPDATED`, `BILLING.SUBSCRIPTION.RE-ACTIVATED`,
  `BILLING.SUBSCRIPTION.SUSPENDED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.EXPIRED`.
- Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_WEBHOOK_ID` (the ID on the webhook detail page) in `.env`. Set `PAYPAL_ENV=sandbox` only for local and sandbox testing; leave it unset in production.
- PayPal has no merchant billing portal; "Manage subscription" sends buyers to the automatic payments page in their PayPal account.

## 7. Pre-launch checks

- `pnpm --filter "./sites/<dir>" check` passes (build, required routes, no template placeholders, no cross-site imports). The image build runs the same launch checks.
- Locally in Stripe test mode (or PayPal sandbox), walk the whole flow: sign in, buy the cheapest pack, generate, receive the output, full and partial refunds claw back credits, a dispute claws back and a won dispute restores.
- Run the production image locally with `docker compose up --build` (see [local development](local-development.md)) and run the main flow once on it.
- Privacy, terms, refunds and DMCA pages exist and the footer shows the contact email. Review the refund terms yourself.
- `robots.txt`, `sitemap.xml` and `llms.txt` load; the home page title, description and canonical are correct.
- Icons: besides `favicon.svg`, add `favicon.ico` (16/32) and a 180x180 `apple-touch-icon.png`, declared in the head of `__root.tsx`. With only an SVG, link previews and many crawlers show a generic globe.
- Have someone (or a second AI reviewer) review the money paths of a site's first launch end to end.

## 8. Deploy (confirm)

On the machine, in the repo checkout on `main`:

```bash
git pull
cd sites/<dir>
docker compose build
docker compose run --rm site node migrate.mjs   # applies pending migrations; also needed on first launch
docker compose up -d
```

- Deploy only from main. Migrations are their own step: the server never migrates on start. They run while the old version still serves, so keep them compatible with it.
- On `docker compose up -d` the old container gets SIGTERM: it stops taking requests, lets job steps in flight finish (up to 60 s) and hands its runs back, and the new container picks them up. Keep `stop_grace_period` (90 s in the template) above that.
- The image's health check calls `/healthz`, which answers without touching the database; `docker compose ps` shows it.
- Afterwards, read `docker compose logs -f site` and the provider's webhook delivery log, and confirm the first real order granted its credits.

## 9. Search and analytics

- Run `node tools/check-crawl.mjs https://<domain> "a product fact visible in the page body"` from the engine root after deployment. From a parent repository use its `vendor/shipwords/tools/check-crawl.mjs` path. The read-only smoke check requests home, robots and sitemap with four UAs, checks HTTP status, canonical, indexing directives, SSR text and JSON-LD video dates, and exits nonzero on failures. It does not execute JavaScript. Supply stable product phrases to detect an empty client-only shell. Test fixtures run with `pnpm test:tools`.
- Review the printed robots groups manually (including crawler-specific groups); the smoke check is not a robots policy evaluator or a full XML validator. Check every sitemap URL separately. Inspect HTTPS/www redirects, public DNS via DoH when local DNS is proxied, and repeat from independent networks. A UA string does not impersonate a verified crawler's IP or prove global reachability.
- In GSC, inspect the home URL: record indexed status, last crawl, crawl success, declared and Google-selected canonical, then run a live test. Inspect Bing separately: its index can lag Google. Record the actual reporting dates and distinguish property-level impressions from page totals. Search-result absence alone does not prove exclusion.
- If a fetch fails, inspect Cloudflare AI Crawl Control, WAF, challenge settings, cache rules and failed request paths before changing anything. Errors on scanner paths are not evidence that public pages fail. Do not disable protections to compensate for an unexplained tool error.
- Keep `llms.txt` consistent with the public product, but do not treat it as an indexing or ranking requirement. Google [does not use llms.txt for Search visibility or ranking](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide). Fix concrete markup warnings using recorded publication dates, not invented timestamps, reviews or ratings.

- **Google Search Console:** add the domain property (DNS verification through Cloudflare is quickest) and submit `https://<domain>/sitemap.xml`.
- **Bing Webmaster Tools:** import from GSC or add the site, and submit the same sitemap.
- **IndexNow:** generate a key, put `<key>.txt` containing the key into `public/`, deploy, then submit new URLs to `https://api.indexnow.org/indexnow`. Bing and other IndexNow engines pick them up quickly.
- **GA4:** create a property and web stream, then set `analytics.ga4` in `site.config.ts`.
- **Rybbit:** create a site, set `analytics.rybbit.siteId` in `site.config.ts`, and set `RYBBIT_UPSTREAM` in `.env` to your Rybbit API URL. Tracking goes through the site's own `/stats/` path. Enable `firstPartyProxy` for the site in Rybbit; otherwise every visit looks like it comes from the site's server, many visits are dropped as bots and countries are wrong.
- **Clarity (optional):** set `analytics.clarity`.
- Wire funnel events before launch, for example: upload, click generate, sign in, purchase, credits granted, output delivered, download.

## Tips

- Keep the user on the page: pricing and account as dialogs, Google One Tap for sign-in, and uploads kept in `sessionStorage` so they survive the checkout round trip.
- For pages likely to be cited by AI search, answer one sub-question per page (how-to, pricing, free options, templates), ideally with measured data. Launch with the home page plus a few such pages; add long-tail pages once Search Console shows the queries.
- When generation takes minutes, tell users they can close the page and will get an email, show "in progress" or "ready" on return visits, and keep history in the account page.
