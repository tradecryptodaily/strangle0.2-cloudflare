// Shared helpers for Delta Exchange India API (server-side only)
const crypto = require("crypto");
const BASE = "https://api.india.delta.exchange";

async function deltaGet(path, params, auth = false) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const headers = {};
  if (auth) {
    // Signatures expire ~5s after signing — sign immediately before the call.
    const ts = Math.floor(Date.now() / 1000).toString();
    const msg = "GET" + ts + path + qs;
    headers["api-key"] = process.env.DELTA_API_KEY || "";
    headers["signature"] = crypto
      .createHmac("sha256", process.env.DELTA_API_SECRET || "")
      .update(msg)
      .digest("hex");
    headers["timestamp"] = ts;
  }
  const r = await fetch(BASE + path + qs, { headers });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
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
  // Enough monthly candidates to cover every target with margin.
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

// The very next monthly expiry STRICTLY AFTER today — calendar-only, no API
// dependency. Shown as a non-tradeable reference card so the term-structure
// view has a real front-of-curve point, independent of the 45/80 DTE targets.
// Uses `<=` (not `<`) so that on the expiry day itself this already rolls to
// next month, instead of handing back a 0DTE reference that sits empty once
// Delta stops serving quotes for it later that day.
function nearestMonthlyExpiry(today = new Date()) {
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  let y = today.getUTCFullYear(), m = today.getUTCMonth();
  let lf = lastFriday(y, m);
  if (lf.getTime() <= t0) {
    m += 1; if (m > 11) { m = 0; y += 1; }
    lf = lastFriday(y, m);
  }
  return ddmmyy(lf);
}
function checkToken(req, res) {
  const want = process.env.DASH_TOKEN;
  if (!want) return true; // protection disabled
  const got = (req.query && req.query.token) || "";
  if (got !== want) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

module.exports = { deltaGet, targetExpiries, expToDate, checkToken, nearestMonthlyExpiry };
