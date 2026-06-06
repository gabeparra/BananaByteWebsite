# BANANAbyte — bananabyte.io

Marketing + portfolio site for **BANANAbyte**, a solo web design & development studio in Orlando, FL.

> Brand rule: the wordmark is **BANANA**byte — `BANANA` in caps, `byte` lowercase.

## Stack

- **Astro 5** (`output: 'static'`) — bundles to `dist/`. The live pages are hand-written, self-contained HTML/CSS/JS in `public/` (no Tailwind, no components); Astro just emits the static output.
- **Cloudflare Worker** (`bananabytewebsite`) serves the static assets **and** a small `/api/*` Worker. This is a Worker deployment, **not** Cloudflare Pages.
- Fonts load per-page via Google Fonts; the brand uses **Archivo Black** + **JetBrains Mono**.

## Project layout

- `public/index.html` — homepage
- `public/work/` — public portfolio page (`/work/`) + preview thumbnails
- `public/concepts/` — internal **noindex** gallery: design concepts, the audience-gate prototype (`mode-switch/`), and 10 client mockups (`mock-*`)
- `worker/index.js` — the `/api/*` Worker:
  - `/api/contact` — Turnstile-gated → Resend email + Telegram notify
  - `/api/event` + `/api/stats` — first-party KV analytics (token-gated dashboard)
- `wrangler.toml` — Worker config: `[assets]` (serves `dist/`, `run_worker_first=["/api/*"]`), `[vars]`, rate-limit + KV bindings
- `public/robots.txt`, `public/sitemap.xml`, `public/_headers`*

\* `_headers` is kept for reference / Pages-portability but is **not honored on Worker-served sites**. Security headers + image caching are applied via a Cloudflare **response Transform Rule** instead.

## Develop

```sh
npm install
npm run dev        # http://localhost:4321
```

## Build & deploy

```sh
npm run build      # -> dist/
CLOUDFLARE_API_TOKEN=<scoped-token> npx wrangler@4 deploy
```

This deploys the Worker plus the `dist/` static assets to the `bananabytewebsite` Worker. (The Cloudflare Git-build auto-deploy is misconfigured; deploy manually with the command above.)

## Email & contact form

- The contact form POSTs to `/api/contact`, which verifies **Cloudflare Turnstile**, then sends a notification via **Resend** (to the business inbox + a personal Gmail) and pings **Telegram**. Succeeds if either notify channel does.
- **Receiving:** `contact@bananabyte.io` is a **Google Workspace** mailbox (MX → `smtp.google.com`; SPF/DKIM via Cloudflare DNS). DMARC is `p=quarantine`.
- Resend sends from the `send.bananabyte.io` subdomain — a separate lane from the Workspace inbox, so the two don't conflict.

## Secrets (set on the Worker, never committed)

`RESEND_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TURNSTILE_SECRET`, `STATS_TOKEN` — set via `wrangler secret put <NAME>`.

## Brand palette

| Token | Hex |
|---|---|
| Near-black base | `#0A0A0A` |
| Banana yellow (primary) | `#F5C800` |
| Bright yellow | `#FFD42E` |
| Deep gold (hover/shadow) | `#E0B11E` |
| Bone / ink text | `#ECECEE` |
