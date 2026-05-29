# PearlRate

> Break-even rental & mining profitability for NVIDIA GPUs. Tune PRL price and network difficulty — every figure recomputes live.

A single-file static dashboard for estimating **Pearl (PRL, Proof-of-Useful-Work by Pearl Research Labs)** mining economics on NVIDIA GPUs. Tune the PRL price and network-difficulty multiplier and every figure recomputes live.

> ⚠️ This tracks **Pearl Research Labs (PRL)** — the GPU-mined Layer-1 — **not** the Solana "Perle (PRL)" annotation-platform token. Same ticker, different project.

## What it shows

For RTX 5090 / 4090 / 5080 / 3090 / 3090 Ti:

- **Yield/day (PRL)** — benchmark yield ÷ difficulty multiplier (price-independent)
- **Gross/day** and **Gross/h** — yield × PRL price
- **Break-even rent/h** — the max hourly rental a miner can pay and still profit (your pricing ceiling as a host)
- **Self-mine net/day** — running your own card, electricity only
- **Fleet totals** — enter quantities per card to size your whole fleet

Yields are editable inline (double-click a yield cell) so you can drop in your own benchmarks.

## Data baseline

Yields from public hashrate.no benchmarks (26 May 2026). Defaults: PRL = $1.63, difficulty ×1.00, electricity $0.10/kWh, pool fee 4%. The RTX 4090 row is an estimate (no verified PRL benchmark yet) and is flagged `est`.

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
| Production branch | `main` |

**Save and Deploy.** You get `https://pearlrate.pages.dev`; add a custom domain (e.g. `pearlrate.chrobok.biz.pl`) under **Custom domains**. Every push to `main` redeploys automatically.

> Nothing else is required — it's static, exactly like a `Skipping build step` deploy. The `_headers` file is read natively by Cloudflare Pages (security headers + always-fresh HTML).

**Alternative — CLI (Wrangler):**
```bash
npm i -g wrangler
wrangler pages deploy . --project-name=pearlrate
```

## Files
- `index.html` — the entire app (HTML + CSS + JS, no dependencies except Google Fonts)
- `_headers` — Cloudflare Pages security + cache headers
- `.gitignore`

## License
MIT — do whatever you like.
