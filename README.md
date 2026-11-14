# PearlRate

> Break-even rental & mining profitability for NVIDIA GPUs. Tune PRL price and network difficulty — every figure recomputes live.

A single-file static dashboard for estimating **Pearl (PRL, Proof-of-Useful-Work by Pearl Research Labs)** mining economics on NVIDIA GPUs. Tune the PRL price and network-difficulty multiplier and every figure recomputes live.

> ⚠️ This tracks **Pearl Research Labs (PRL)** — the GPU-mined Layer-1 — **not** the Solana "Perle (PRL)" annotation-platform token. Same ticker, different project.

## What it shows

For RTX 5090 / 4090 / 5080 / 3090 / 3090 Ti:

- **Yield/day (PRL)** — benchmark yield ÷ difficulty multiplier (price-independent)
- **Gross/day** and **Gross/h** — yield × PRL price
- **Break-even rent/h** — the max hourly rental a miner can pay and still profit (your pricing ceiling as a host)
- **Self-mine net/day** — running your own card: gross minus pool fee, minus electricity
- **Fleet totals** — enter quantities per card to size your whole fleet
- **Summary strip** — the headline numbers at the top: self-mine net/day (≈ per month), break-even rent/h, gross/day and the break-even PRL price, for your fleet (or one RTX 5090 until you set a Qty)
- **Live market badge** — PRL price, 24h change and sparkline, refreshed every minute while the tab is open
- **Price history chart** — hover/tap/arrow-key tooltip, high/low markers, and break-even lines showing the PRL price at which each card in your fleet stops covering its electricity
- **Analysis** (your fleet, or any single card):
  - *Profitability map* — net $/day across PRL price × difficulty, with the break-even line, safety margins ("PRL can fall 66% before a loss") and click-to-try scenarios
  - *Payback & ROI* — enter what the hardware cost, assume a monthly difficulty growth and price trend, and get the payback date plus a cumulative-profit chart with a ±3 pp band
  - *GPU efficiency* — yield vs power bubble chart with equal-efficiency lines, the break-even line at your electricity price, and a PRL/kWh ranking

Price and difficulty follow the live values until you move their slider (manual mode); **↺ Live** switches back. Yields are editable inline (click a yield cell) so you can drop in your own benchmarks.

## Data baseline

Yields from public hashrate.no benchmarks, scaled to the current network difficulty (18,098,085 · 17 Jun 2026) which is the ×1.00 point. Defaults: difficulty ×1.00, electricity $0.10/kWh, pool fee 4%; PRL price is fetched live. The RTX 4090 row is an estimate (no verified PRL benchmark yet) and is flagged `est`.

## Deploy

Pure static — no build step.

### 1. Push to GitHub
```bash
cd PearlRate
git init
git add .
git commit -m "PearlRate: PRL mining rental calculator"
git branch -M main
git remote add origin git@github.com:Waldemarch/PearlRate.git
git push -u origin main
```
Create the empty `PearlRate` repo on GitHub first (no README/.gitignore) so the first push has no conflict.

### 2. Publish on Cloudflare Pages
Dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick `Waldemarch/PearlRate`, then set:

| Setting | Value |
|---|---|
| Framework preset | **None** |
| Build command | *(leave empty)* |
| Build output directory | `/` (repo root) |
| Production branch | `master` |

**Save and Deploy.** You get `https://pearlrate.pages.dev`; add a custom domain (e.g. `pearlrate.dcnb.eu`) under **Custom domains**. Every push to `master` redeploys automatically; other branches get preview deploys.

> Nothing else is required — it's static, exactly like a `Skipping build step` deploy. The `_headers` file is read natively by Cloudflare Pages (security headers + always-fresh HTML).

**Alternative — CLI (Wrangler):**
```bash
npm i -g wrangler
wrangler pages deploy . --project-name=pearlrate
```

## Tests

Every pull request and every push to `master` runs `.github/workflows/e2e.yml`:

- **Playwright e2e** (`tests/e2e/`) — loads the real `index.html` from a tiny static server, with `/api/*` mocked deterministically and the clock fixed (so "3 min ago" is exact). It covers live/manual mode, the table and fleet totals, the summary strip, charts and tooltips, the Analysis section, theme, persistence, the failure / loading / stale states, the phone layout (390 px, no sideways scroll, 40 px tap targets) and a WCAG AA contrast audit in both themes. On failure the HTML report (with traces) is uploaded as a build artifact.

Run it locally (Node 22):

```bash
cd tests/e2e
npm ci
npx playwright install chromium        # once; downloads the pinned browser
npx playwright test                    # or: npm test
npx playwright show-report             # after a failure
```

Already have a Chromium/Chrome binary? Skip the download and point the suite at it:

```bash
PW_CHROMIUM_PATH=/path/to/chrome npx playwright test
```

The test tooling lives in its own `tests/e2e/package.json` on purpose: there is **no `package.json` at the repo root**, so Cloudflare Pages (build output = repo root, no build command) never installs dependencies or ships `node_modules`.

## Files
- `index.html` — the entire app (HTML + CSS + JS, no dependencies except Google Fonts)
- `_headers` — Cloudflare Pages security + cache headers
- `functions/api/` — Pages Functions (live price, difficulty, history); see [AUTOMATION.md](AUTOMATION.md)
- `worker/` — the scheduled Cloudflare Worker that keeps the live data fresh
- `tests/e2e/` — Playwright suite (own `package.json`; not part of the site build)
- `.github/workflows/` — CI: tests on every PR, Worker deploy on `master`
- `.gitignore`

## License
MIT — do whatever you like.
