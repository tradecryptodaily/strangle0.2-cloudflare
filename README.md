# ⚡ BTC Strangle Monitor — Web

Web version of `live_monitor.py` v0.2. Same analytics: IV Rank strike selection, Expected Move, skew-adjusted strangles, gamma/vega triggers, OI walls + max pain, vol term structure, IV/RV ratio, live positions with P&L, and browser alert notifications.

## Architecture — no API keys required

- `index.html` + `app.js` — the dashboard (all analytics run in your browser)
- `positions.js` — **your positions, as a config file** (like positions.json in the terminal). Legs are priced live from the public option chain — no Delta account access needed.
- `api/chain.js` — option chain + spot proxy (public Delta data, unsigned)
- `api/candles.js` — daily candles for realized vol + IV history

## Deploy (5 minutes)

1. **Create a GitHub repo** (private recommended) and push this folder:
   ```bash
   cd strangle-web
   git init && git add -A && git commit -m "strangle monitor web"
   git remote add origin https://github.com/<you>/strangle-monitor.git
   git push -u origin main
   ```
2. **Import to Vercel**: vercel.com → Add New → Project → import the repo. Framework preset: **Other**. No build command, no environment variables.
3. **Deploy.** Open the URL, click 🔔 to enable browser alerts.

## Updating your trades

Edit `positions.js` (open/close/adjust, set `active: false` when closed), then:
```bash
git add positions.js && git commit -m "update positions" && git push
```
Vercel redeploys automatically in ~30 seconds.

## Security notes

- Your strikes/sizes are embedded in the page — keep the repo private and don't share the URL if you care about that. No API keys or account access are exposed anywhere.
- The chain/candles endpoints expose only public market data.

## Notes / limits vs the terminal version

- IV Rank history is rebuilt hourly from daily candles (no persistent server storage on Vercel) — same approximation as the terminal's backfill.
- OI-wall session peaks and vega baselines persist in your browser (localStorage).
- Alerts fire while the page is open (browser notifications). For 24/7 alerting, keep the terminal monitor running too — they coexist fine.
- Vercel functions run in Mumbai (`bom1`) for lowest latency to Delta India.
