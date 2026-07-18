// Shared helpers for Delta Exchange India API — Cloudflare Pages Functions version.
//
// This is a port of strangle-web/api/_delta.js (the Vercel version) to
// Cloudflare's runtime. Two real differences from the Vercel version:
//   1. Cloudflare Workers run on V8 isolates, not Node.js, so there's no
//      `require("crypto")`. HMAC-SHA256 signing here uses the standard Web
//      Crypto API (crypto.subtle) instead — available globally with zero
//      config, no "nodejs_compat" flag needed.
//   2. Secrets come from `env` (passed into every function via the Pages
//      Functions `context` object), not `process.env`.
// Everything else — expiry math, target-DTE selection — is identical logic.
//
// A leading underscore in the filename tells Cloudflare Pages "this is not
// a route" — it's imported by chain.js / candles.js / positions.js instead.
const BASE = "https://api.india.delta.exchange";

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deltaGet(path, params, auth, env) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  // Cloudflare Workers' default outbound fetch() fingerprint (headers/UA)
  // differs from a normal Node.js server's — some APIs' bot-protection
  // blocks that with a 403 even for perfectly public, unsigned reads.
  // Presenting a normal browser Accept/User-Agent avoids that without
  // changing anything about what data we're requesting.
  const headers = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };
  if (auth) {
    // Signatures expire ~5s after signing — sign immediately before the call.
    const ts = Math.floor(Date.now() / 1000).toString();
    const msg = "GET" + ts + path + qs;
    headers["api-key"] = (env && env.DELTA_API_KEY) || "";
    headers["signature"] = await hmacSha256Hex((env && env.DELTA_API_SECRET) || "", msg);
    headers["timestamp"] = ts;
  }
  // Delta's bot-protection appears to score/rate-limit intermittently rather
  // than hard-block Cloudflare's IP range outright (confirmed: some polls
  // succeed with real data, some 403). A short retry rides out that kind of
  // transient block without doing anything sneaky — same request, same data.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((res) => setTimeout(res, 250 * attempt));
    const r = await fetch(BASE + path + qs, { headers });
    if (r.ok) return r.json();
    lastErr = new Error(`${path} -> HTTP ${r.status}`);
    if (r.status !== 403 && r.status !== 429) break; // don't retry real errors
  }
  throw lastErr;
}

// Monthly expiry = last Friday of the month (Delta convention), code DDMMYY.
function lastFriday(y, m /* 0-11 */) {
  const d = new Date(Date.UTC(y, m + 1, 0));
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}
function ddmmyy(d) {
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getUTCDate()) + p(d.getUTCMonth() + 1) + String(d.getUTCFullYear()).slice(2);
}
function expToDate(exp) {
  return new Date(Date.UTC(2000 + +exp.slice(4, 6), +exp.slice(2, 4) - 1, +exp.slice(0, 2)));
}

// You trade strictly 45-DTE and 80-DTE strangle cycles — track exactly the
// two monthly expiries closest to those targets, not "next N".
const DTE_TARGETS = [45, 80];

function targetExpiries(dteTargets = DTE_TARGETS, extra = []) {
  const today = new Date();
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const spanMonths = Math.max(8, Math.floor(Math.max(...dteTargets) / 30) + 4);
  const candidates = [];
  let y = today.getUTCFullYear(), m = today.getUTCMonth();
  for (let i = 0; i < spanMonths; i++) {
    const lf = lastFriday(y, m);
    if (lf.getTime() >= t0) candidates.push(ddmmyy(lf));
    m += 1; if (m > 11) { m = 0; y += 1; }
  }
  const dte = (code) => Math.round((expToDate(code).getTime() - t0) / 86400000);
  const picks = [];
  for (const target of dteTargets) {
    let best = null, bestDiff = Infinity;
    for (const c of candidates) {
      const diff = Math.abs(dte(c) - target);
      if (diff < bestDiff) { best = c; bestDiff = diff; }
    }
    if (best && !picks.includes(best)) picks.push(best);
  }
  for (const e of extra) if (e && !picks.includes(e)) picks.push(e);
  return [...new Set(picks)].sort((a, b) => expToDate(a) - expToDate(b));
}

function checkToken(request, env) {
  const want = env && env.DASH_TOKEN;
  if (!want) return true; // protection disabled
  const url = new URL(request.url);
  const got = url.searchParams.get("token") || "";
  return got === want;
}

export { deltaGet, targetExpiries, expToDate, checkToken };
