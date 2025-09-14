**iPhone 17 Taiwan Pickup (Cloudflare Worker)**

- Scrapes iPhone 17 part numbers from Apple Taiwan’s buy page.
- Queries Apple’s fulfillment API for in‑store pickup quotes across Taiwan.
- Renders a Tailwind (mobile‑first) UI and exposes a JSON API.

**Local Dev**

- Prereq: Node 18+.
- Install wrangler: `npm i` (uses devDependency).
- Run dev server: `npx wrangler dev` (or `npm run dev`).
- Open: http://127.0.0.1:8787/

**Deploy**

- Deploy to Cloudflare: `npx wrangler deploy`.

**Endpoints**

- `/` — Tailwind UI.
- `/api/availability` — JSON payload with models, stores, and pickup quotes.
  - Returns from Cloudflare KV immediately (`source: "kv"`).
  - Query `?force=1` to refresh now and update KV (`source: "fresh"`).

**Config**

Edit `wrangler.toml` if needed:

- `LOCATION_SEEDS`: Comma-separated seeds like `Taiwan,Taipei,Kaohsiung`.
- `APPLE_BASE`: Base URL (defaults to `https://www.apple.com`).
- `REGION_PATH`: Region prefix (defaults to `/tw`).
- `FAMILIES`: Comma‑separated buy-page slugs to scrape (default `iphone-17,iphone-17-pro`).

**KV Caching + Cron**

- A KV namespace `AVAIL_KV` is bound in `wrangler.toml`.
- The Worker stores the latest payload at key `availability.latest`.
- Cron schedule `*/5 * * * *` refreshes KV every 5 minutes.
- First call when KV is empty returns `{ source: "warmup" }` and refreshes in the background.

**Notes**

- The worker uses `<script id="metrics">` on Apple’s buy page to discover iPhone 17 part numbers, then calls `/tw/shop/fulfillment-messages` with those parts.
- The UI shows Apple’s pickup quotes (e.g., 今天/明天/日期) for each model per store. Availability text is taken directly from Apple’s API.
