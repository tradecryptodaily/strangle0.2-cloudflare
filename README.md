# ⚡ BTC Strangle Monitor — Cloudflare Pages

Same dashboard as `strangle-web` (the Vercel version) — identical frontend,
identical analytics (IV Rank, Expected Move, skew, term structure, IV/RV,
max pain, gamma/vega triggers, live WebSocket spot price) — ported to run
on **Cloudflare Pages** instead of Vercel. The two folders are independent;
you can run either or both.

## Why this needed a separate `api/` rewrite

Vercel's serverless functions use Node.js conventions: files under `/api`,
handlers shaped `(req, res) => {...}`, secrets from `process.env`. Cloudflare
Pages Functions run on Workers (V8 isolates, not Node.js): files live under
`/functions`, handlers are `onRequestGet(context)` returning a standard
`Response`, and secrets come from `context.env`. This folder's `functions/api/*.js`
files are that port — same logic, Cloudflare's shape. HMAC request-signing
uses the Web Crypto API (`crypto.subtle`) instead of Node's `crypto` module,
so **no compatibility flags or extra config are needed** — it runs as-is.

The frontend (`index.html`, `app.js`, `positions.js`) is an exact,
byte-identical copy of the Vercel version — static files behave the same
everywhere.

## Deploy (5 minutes, no environment variables needed)

1. **Push this folder to GitHub** (can be its own repo, or a folder inside
   a larger one — Cloudflare lets you set a root directory either way):
   ```bash
   cd cloudflare-web
   git init && git add -A && git commit -m "strangle monitor — cloudflare"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. **Cloudflare dashboard** → Workers & Pages → Create application → **Pages**
   → Connect to Git → select the repo.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `/`
   - If this folder lives inside a bigger repo (not its own repo root), set
     **Root directory** to `cloudflare-web` in the project's build settings.
4. **Deploy.** No environment variables are required — every API call here
   hits Delta's public, unsigned endpoints (same as the Vercel version).
5. Open the assigned `*.pages.dev` URL. The header BTC price streams live
   via a direct browser WebSocket to Delta (bypasses these functions
   entirely for that one number); everything else polls through
   `/api/chain` and `/api/candles` on this Cloudflare deployment.

## Updating your trades

Same workflow as the Vercel version: edit `positions.js`, then
```bash
git add positions.js && git commit -m "update positions" && git push
```
Cloudflare Pages redeploys automatically on push, same as Vercel.

## Notes

- `functions/api/_delta.js` is prefixed with an underscore on purpose —
  Cloudflare Pages excludes underscore-prefixed files from routing, so it's
  treated as a shared helper module (imported by the other function files)
  rather than an endpoint of its own.
- `functions/api/positions.js` is a deprecated stub (matches the Vercel
  version) — kept only so an old client gets a clear error instead of a 404.
- Your strikes/sizes are embedded in `positions.js` and served to whoever
  has the URL — keep the repo private if that matters to you.
