/* Strangle Monitor Web — all analytics ported from live_monitor.py v0.2 */
"use strict";

// ── Config (mirrors the terminal TRIGGERS) ───────────────────────────────────
const TRIGGERS = {
  delta_breach: 0.30,
  be_proximity_pct: 8.0,
  loss_x_credit: 1.5,
  stop_x_credit: 2.0,
  iv_spike_pct: 15.0,
  profit_target_pct: 50.0,
  gamma_breach: 0.00005,
  oi_wall_drop_pct: 20.0,
  oi_wall_min_peak: 100.0,
  max_pain_be_prox_pct: 3.0,
};
const EM_FACTOR = 0.85;
const IVR_HIGH = 70, IVR_LOW = 50;
const SKEW_THRESHOLD = 5.0, SKEW_SHIFT = 0.05;
const TS_FLAT_PTS = 2.0;
const IVRV_LOW = 1.0, IVRV_HIGH = 1.2;
const CHAIN_POLL_MS = 15000, POS_POLL_MS = 30000, VOL_POLL_MS = 3600000;

// ── Black-Scholes + IV solver (ported) ───────────────────────────────────────
function ncdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function erf(x) { // Abramowitz-Stegun 7.1.26
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429;
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return s * y;
}
function bsPrice(S, K, T, v, type) {
  if (v <= 0 || T <= 0) return 0;
  const d1 = (Math.log(S / K) + 0.5 * v * v * T) / (v * Math.sqrt(T));
  const d2 = d1 - v * Math.sqrt(T);
  return type === "call" ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1);
}
function ivFromMark(S, K, T, price, type) {
  if (S <= 0 || K <= 0 || T <= 0 || price <= 0) return 0;
  let lo = 0.01, hi = 5.0;
  let flo = bsPrice(S, K, T, lo, type) - price, fhi = bsPrice(S, K, T, hi, type) - price;
  if (flo * fhi > 0) return 0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2, fm = bsPrice(S, K, T, mid, type) - price;
    if (Math.abs(fm) < 0.01 || hi - lo < 1e-4) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

// ── Analytics (ported 1:1) ───────────────────────────────────────────────────
function findTarget(opts, target) {
  let bk = null, bd = null;
  for (const [k, d] of Object.entries(opts)) {
    if (!d.delta) continue;
    if (bk === null || Math.abs(Math.abs(d.delta) - target) < Math.abs(Math.abs(bd.delta) - target)) {
      bk = +k; bd = d;
    }
  }
  return [bk, bd];
}
function atmIV(exp, chain, S, dte) {
  let ivs = [];
  for (const side of ["calls", "puts"]) {
    let best = null;
    for (const [k, d] of Object.entries(chain[side] || {})) {
      const dl = Math.abs(d.delta || 0);
      if (d.iv > 0 && dl > 0 && (best === null || Math.abs(dl - 0.5) < best[0]))
        best = [Math.abs(dl - 0.5), d.iv];
    }
    if (best) ivs.push(best[1]);
  }
  if (ivs.length) return ivs.reduce((a, b) => a + b) / ivs.length;
  if (S <= 0) return 0;
  const T = Math.max(1, dte) / 365;
  for (const [side, typ] of [["calls", "call"], ["puts", "put"]]) {
    const withMarks = Object.entries(chain[side] || {}).filter(([, d]) => d.mark > 0);
    if (!withMarks.length) continue;
    const [k, d] = withMarks.reduce((a, b) => Math.abs(+a[0] - S) < Math.abs(+b[0] - S) ? a : b);
    const iv = ivFromMark(S, +k, T, d.mark, typ);
    if (iv > 0) ivs.push(iv);
  }
  return ivs.length ? ivs.reduce((a, b) => a + b) / ivs.length : 0;
}
function targetDeltaForIVR(ivr) {
  if (ivr == null) return [0.20, "20Δ (default — building IV history)"];
  if (ivr > IVR_HIGH) return [0.15, "15Δ (IVR>70: rich vol → wider strikes)"];
  if (ivr < IVR_LOW) return [0.25, "25Δ (IVR<50: cheap vol → tighter strikes)"];
  return [0.20, "20Δ (IVR 50–70: default)"];
}
function skewAdjusted(skewPct, base) {
  if (skewPct > SKEW_THRESHOLD) return [base + SKEW_SHIFT, base - SKEW_SHIFT, "put skew rich"];
  if (skewPct < -SKEW_THRESHOLD) return [base - SKEW_SHIFT, base + SKEW_SHIFT, "call skew rich"];
  return null;
}
function expectedMove(chain, S) {
  if (S <= 0) return [null, null];
  const common = Object.keys(chain.calls || {}).filter(
    (k) => chain.puts?.[k] && chain.calls[k].mark > 0 && chain.puts[k].mark > 0);
  if (!common.length) return [null, null];
  const atmK = common.reduce((a, b) => Math.abs(+a - S) < Math.abs(+b - S) ? a : b);
  return [(chain.calls[atmK].mark + chain.puts[atmK].mark) * EM_FACTOR, +atmK];
}
function emSafe(beDn, beUp, S, em) {
  const dnOk = beDn == null || beDn <= S - em;
  const upOk = beUp == null || beUp >= S + em;
  return dnOk && upOk;
}
function maxPain(chain) {
  const calls = {}, puts = {};
  for (const [k, d] of Object.entries(chain.calls || {})) calls[k] = d.oi || 0;
  for (const [k, d] of Object.entries(chain.puts || {})) puts[k] = d.oi || 0;
  const strikes = [...new Set([...Object.keys(calls), ...Object.keys(puts)])].map(Number);
  const tot = Object.values(calls).concat(Object.values(puts)).reduce((a, b) => a + b, 0);
  if (!strikes.length || tot <= 0) return null;
  let bk = null, bp = null;
  for (const K of strikes) {
    let pain = 0;
    for (const [k, oi] of Object.entries(calls)) pain += oi * Math.max(0, K - +k);
    for (const [k, oi] of Object.entries(puts)) pain += oi * Math.max(0, +k - K);
    if (bp === null || pain < bp) { bk = K; bp = pain; }
  }
  return bk;
}
function ivrvStatus(r) {
  if (r < IVRV_LOW) return ["THIN — not compensated: consider closing/hedging", "red"];
  if (r <= IVRV_HIGH) return ["FAIR — acceptable, not generous", "yellow"];
  return ["RICH — good time to sell premium", "green"];
}

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  chain: null, spot: 0, legs: [], rv30: 0,
  ivHist: {},           // {exp: [{ts, iv}]}  built from candles hourly
  alerts: {},           // {key: {title, msg, sev, ts}}
  fired: new Set(),     // notification de-dupe (re-arms on clear)
  token: localStorage.getItem("dash_token") || "",
  spotWs: 0, spotWsTs: 0,   // live tick from the direct browser WebSocket
  chainFails: 0, lastChainOk: 0,   // transient-error tracking for the status banner
  reference: null, tradeTargets: [],   // nearest-monthly reference expiry vs. actual 45/80 DTE targets
  recentAlerts: JSON.parse(localStorage.getItem("recent_alerts") || "[]"),   // persists past the condition clearing
};
const WS_SPOT_MAX_AGE_MS = 8000;   // treat the WS price as "live" for this long since last tick
const oiPeaks = JSON.parse(localStorage.getItem("oi_peaks") || "{}");
const ivBase = JSON.parse(localStorage.getItem("iv_baseline") || "{}");

// ── Alert engine ─────────────────────────────────────────────────────────────
// state.alerts tracks only what's CURRENTLY breaching (cleared the instant a
// condition resolves — matches live_monitor.py's active_alerts). That's
// correct for "what needs attention right now", but it means anything that
// fired and cleared between two page views vanishes without a trace. The
// terminal doesn't have that problem — it appends every fire to
// alert_history.json permanently. recentAlerts mirrors that here: a
// capped, localStorage-backed log written once per firing episode (not
// every poll while it's active), so a transient alert stays visible even
// after it clears or the page reloads.
const RECENT_ALERTS_MAX = 30;
function logRecentAlert(entry) {
  state.recentAlerts.unshift(entry);
  if (state.recentAlerts.length > RECENT_ALERTS_MAX) state.recentAlerts.length = RECENT_ALERTS_MAX;
  localStorage.setItem("recent_alerts", JSON.stringify(state.recentAlerts));
}
function fire(key, title, msg, sev) {
  state.alerts[key] = { title, msg, sev, ts: new Date().toLocaleTimeString() };
  if (!state.fired.has(key)) {
    state.fired.add(key);
    logRecentAlert({ key, title, msg, sev, ts: Date.now() });
    if ("Notification" in window && Notification.permission === "granted")
      new Notification(title, { body: msg });
  }
}
function clearAlert(key) { delete state.alerts[key]; state.fired.delete(key); }

function effectiveSpot() {
  // Prefer the live WebSocket tick (millisecond-fresh) over the 15s-polled
  // server snapshot, as long as it hasn't gone stale (socket dropped etc).
  if (state.spotWs > 0 && Date.now() - state.spotWsTs < WS_SPOT_MAX_AGE_MS) return state.spotWs;
  if (state.spot > 0) return state.spot;
  if (!state.chain) return 0;
  // Put-call parity at the ATM strike: C − P ≈ S − K → S ≈ K + C − P.
  // Smooth, dollar-accurate — unlike snapping to the nearest strike.
  for (const e of Object.keys(state.chain)) {
    const ch = state.chain[e];
    const common = Object.keys(ch.calls || {}).filter(
      (k) => ch.puts?.[k] && ch.calls[k].mark > 0 && ch.puts[k].mark > 0);
    if (!common.length) continue;
    const atmK = common.reduce((a, b) =>
      Math.abs(ch.calls[a].mark - ch.puts[a].mark) <
      Math.abs(ch.calls[b].mark - ch.puts[b].mark) ? a : b);
    const s = +atmK + ch.calls[atmK].mark - ch.puts[atmK].mark;
    if (s > 10000) return s;
  }
  // Last resort: strike whose call delta ≈ 0.5
  for (const e of Object.keys(state.chain)) {
    const atm = Object.entries(state.chain[e].calls || {})
      .filter(([, d]) => d.delta >= 0.45 && d.delta <= 0.60);
    if (atm.length) return +atm.reduce((a, b) =>
      Math.abs(a[1].delta - 0.5) < Math.abs(b[1].delta - 0.5) ? a : b)[0];
  }
  return 0;
}

function ivRank(exp, cur) {
  const hist = (state.ivHist[exp] || []).filter((s) => s.iv > 0);
  const samples = cur > 0 ? [...hist, { ts: Date.now() / 1000, iv: cur }] : hist;
  if (samples.length < 8) return [null, null, null];
  const span = (Math.max(...samples.map((s) => s.ts)) - Math.min(...samples.map((s) => s.ts))) / 86400;
  if (span < 3) return [null, null, null];
  const ivs = samples.map((s) => s.iv);
  const lo = Math.min(...ivs), hi = Math.max(...ivs);
  if (hi - lo < 1e-6) return [null, lo, hi];
  return [Math.max(0, Math.min(100, ((cur - lo) / (hi - lo)) * 100)), lo, hi];
}

// ── Position grouping + triggers ─────────────────────────────────────────────
function positionGroups() {
  const byId = {};
  for (const l of state.legs.filter((l) => l.size < 0)) {  // short legs only
    (byId[l.posid || l.expiry] ||= []).push(l);
  }
  return byId;
}

function checkPositionTriggers(pid, exp, legs, S, meta) {
  const ch = state.chain?.[exp] || { calls: {}, puts: {} };
  const call = legs.find((l) => l.side === "call");
  const put = legs.find((l) => l.side === "put");
  const cd = call ? ch.calls[call.strike] || {} : {};
  const pd = put ? ch.puts[put.strike] || {} : {};
  const cMark = cd.mark ?? call?.mark_price ?? 0;
  const pMark = pd.mark ?? put?.mark_price ?? 0;
  const entry = (call?.entry_price || 0) + (put?.entry_price || 0);
  if (entry <= 0) return null;
  const cur = (call ? cMark : 0) + (put ? pMark : 0);
  const pnlPct = ((entry - cur) / entry) * 100;
  const lossX = cur / entry;
  const beUp = call ? call.strike + entry : null;
  const beDn = put ? put.strike - entry : null;
  const pctUp = beUp ? ((beUp - S) / S) * 100 : null;
  const pctDn = beDn ? ((S - beDn) / S) * 100 : null;
  const pfx = `${pid}`;

  if (pnlPct >= TRIGGERS.profit_target_pct)
    fire(`${pfx}:profit`, "✅ 50% Profit Target", `${meta}: +${pnlPct.toFixed(0)}% of credit — close the trade`, "green");
  else clearAlert(`${pfx}:profit`);

  if (lossX >= TRIGGERS.stop_x_credit)
    fire(`${pfx}:stop`, "🛑 HARD STOP", `${meta}: loss ${lossX.toFixed(1)}x credit — EXIT NOW`, "red");
  else {
    clearAlert(`${pfx}:stop`);
    if (lossX >= TRIGGERS.loss_x_credit)
      fire(`${pfx}:loss`, "⚠️ 1.5x Loss Warning", `${meta}: loss ${lossX.toFixed(1)}x credit — prepare to adjust`, "yellow");
    else clearAlert(`${pfx}:loss`);
  }

  for (const [leg, d, name] of [[call, cd, "call"], [put, pd, "put"]]) {
    if (!leg) continue;
    const key = `${pfx}:${name}`;
    const delta = Math.abs(d.delta || 0);
    if (delta >= TRIGGERS.delta_breach)
      fire(`${key}:delta`, `📈 ${name} delta ${delta.toFixed(2)}`, `${leg.symbol}: roll trigger hit (≥0.30)`, "red");
    else clearAlert(`${key}:delta`);
    if ((d.gamma || 0) >= TRIGGERS.gamma_breach)
      fire(`${key}:gamma`, `⚡ ${name} gamma alert`, `${leg.symbol}: Γ=${(d.gamma).toFixed(6)} — roll earlier than delta trigger`, "yellow");
    else clearAlert(`${key}:gamma`);
    // vega shock vs first-seen IV baseline (localStorage)
    if (d.iv > 0) {
      if (!ivBase[leg.symbol]) { ivBase[leg.symbol] = d.iv; localStorage.setItem("iv_baseline", JSON.stringify(ivBase)); }
      const spike = (d.iv / ivBase[leg.symbol] - 1) * 100;
      if (spike >= TRIGGERS.iv_spike_pct)
        fire(`${key}:vega`, `🌊 ${name} IV spike +${spike.toFixed(0)}%`, `${leg.symbol}: roll further OTM or hedge vega`, "yellow");
      else clearAlert(`${key}:vega`);
    }
    // OI wall crumbling (session peaks in localStorage, min-peak filter)
    const oi = d.oi || 0;
    if (oi > 0) {
      const pk = `${leg.symbol}`;
      if (!oiPeaks[pk] || oi > oiPeaks[pk]) { oiPeaks[pk] = oi; localStorage.setItem("oi_peaks", JSON.stringify(oiPeaks)); }
      if (oiPeaks[pk] >= TRIGGERS.oi_wall_min_peak) {
        const drop = ((oiPeaks[pk] - oi) / oiPeaks[pk]) * 100;
        if (drop >= TRIGGERS.oi_wall_drop_pct)
          fire(`${key}:oi`, `🧱 OI wall crumbling`, `${leg.symbol}: OI −${drop.toFixed(0)}% from peak — strike vulnerable`, "yellow");
        else clearAlert(`${key}:oi`);
      }
    }
  }

  if (pctUp != null && pctUp <= TRIGGERS.be_proximity_pct)
    fire(`${pfx}:beup`, "⚠️ Near call breakeven", `${meta}: ${pctUp.toFixed(1)}% to upper BE $${fmt(beUp)}`, "yellow");
  else clearAlert(`${pfx}:beup`);
  if (pctDn != null && pctDn <= TRIGGERS.be_proximity_pct)
    fire(`${pfx}:bedn`, "⚠️ Near put breakeven", `${meta}: ${pctDn.toFixed(1)}% to lower BE $${fmt(beDn)}`, "yellow");
  else clearAlert(`${pfx}:bedn`);

  const mp = maxPain(ch);
  if (mp && S > 0) {
    const prox = TRIGGERS.max_pain_be_prox_pct / 100;
    const nearUp = beUp != null && mp >= beUp * (1 - prox);
    const nearDn = beDn != null && mp <= beDn * (1 + prox);
    if (nearUp || nearDn)
      fire(`${pfx}:mp`, "🧲 Max pain near breakeven", `${meta}: max pain $${fmt(mp)} near BE — pinning risk, consider widening`, "yellow");
    else clearAlert(`${pfx}:mp`);
  }

  const upnl = legs.reduce((a, l) => a + (l.upnl || 0), 0);
  return { call, put, cd, pd, cMark, pMark, entry, cur, pnlPct, lossX, beUp, beDn, pctUp, pctDn, upnl, mp };
}

// ── Fetch loops ──────────────────────────────────────────────────────────────
async function j(url) { const r = await fetch(url); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status); return r.json(); }

function positionExpiries() {
  const src = typeof MY_POSITIONS !== "undefined" ? MY_POSITIONS : [];
  return [...new Set(src.filter((p) => p.active).map((p) => p.expiry))];
}

async function pollChain() {
  try {
    const extra = positionExpiries().join(",");
    const d = await j("/api/chain" + (extra ? `?expiries=${encodeURIComponent(extra)}` : ""));
    state.chain = d.chain; state.spot = d.spot; state.expiries = d.expiries; state.meta = d.meta;
    state.reference = d.reference || null; state.tradeTargets = d.trade_targets || [];
    state.chainFails = 0; state.lastChainOk = Date.now();
    document.getElementById("status").textContent = "LIVE";
    document.getElementById("status").className = "ok";
    render();
  } catch (e) {
    state.chainFails++;
    // A single failed poll doesn't mean the feed is down — Delta's edge
    // rate-limiting is intermittent (some requests through Cloudflare 403,
    // others don't) and _delta.js already retries 3x per call. Only surface
    // this as an error once it's failed several polls in a row; otherwise
    // keep showing the last good data as LIVE (it's at most ~15-30s stale).
    if (state.chainFails >= 3) {
      const ageS = state.lastChainOk ? Math.round((Date.now() - state.lastChainOk) / 1000) : null;
      document.getElementById("status").textContent =
        "ERR: " + e.message + (ageS ? ` (stale ${ageS}s)` : "");
      document.getElementById("status").className = "bad";
    }
  }
}
function pollPositions() {
  // Positions come from positions.js (repo config) — priced from the public
  // option chain. No Delta API key needed anywhere.
  const src = typeof MY_POSITIONS !== "undefined" ? MY_POSITIONS : [];
  const legs = [];
  for (const p of src) {
    if (!p.active) continue;
    const feePerLeg = (p.entry_spot || 0) * p.lots * 0.001 * 0.0005; // Delta: 0.05% notional
    for (const [side, strike, entry] of [
      ["call", p.call_strike, p.entry_call_price],
      ["put", p.put_strike, p.entry_put_price],
    ]) {
      if (!strike) continue;
      const d = (side === "call"
        ? state.chain?.[p.expiry]?.calls
        : state.chain?.[p.expiry]?.puts)?.[strike] || {};
      const mark = d.mark || 0;
      legs.push({
        symbol: `${side === "call" ? "C" : "P"}-BTC-${strike}-${p.expiry}`,
        side, strike, expiry: p.expiry, posid: p.id, entry_date: p.entry_date,
        size: -p.lots, entry_price: entry, mark_price: mark,
        upnl: mark > 0 ? (entry - mark) * p.lots * 0.001 - feePerLeg : 0,
      });
    }
  }
  state.legs = legs;
  document.getElementById("posmsg").textContent =
    legs.length ? "" : "— no active positions in positions.js";
  render();
}
async function pollVol() {
  // 30d RV from BTC daily closes
  try {
    const d = await j("/api/candles?symbol=BTCUSDT&days=35");
    const closes = (d.result || []).sort((a, b) => a.time - b.time).map((c) => +c.close).filter((x) => x > 0).slice(-31);
    if (closes.length >= 15) {
      const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
      const m = rets.reduce((a, b) => a + b, 0) / rets.length;
      const va = rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1);
      state.rv30 = Math.sqrt(va) * Math.sqrt(365);
    }
    // IV history per expiry: back-solve daily ATM IVs from option mark candles
    const S = effectiveSpot();
    if (state.chain && S > 0) {
      const btcByDay = {};
      for (const c of d.result || []) btcByDay[c.time - (c.time % 86400)] = +c.close;
      for (const exp of Object.keys(state.chain)) {
        const calls = state.chain[exp].calls || {};
        const ks = Object.keys(calls).filter((k) => calls[k].mark > 0);
        if (!ks.length) continue;
        const atmK = +ks.reduce((a, b) => Math.abs(+a - S) < Math.abs(+b - S) ? a : b);
        const expDate = Date.UTC(2000 + +exp.slice(4, 6), +exp.slice(2, 4) - 1, +exp.slice(0, 2)) / 1000;
        try {
          const oc = await j(`/api/candles?symbol=${encodeURIComponent("MARK:C-BTC-" + atmK + "-" + exp)}&days=35`);
          const hist = [];
          for (const c of oc.result || []) {
            const day = c.time - (c.time % 86400);
            const Sd = btcByDay[day];
            const dte = (expDate - day) / 86400;
            if (!Sd || dte <= 0) continue;
            const iv = ivFromMark(Sd, atmK, dte / 365, +c.close, "call");
            if (iv > 0) hist.push({ ts: day, iv });
          }
          if (hist.length) state.ivHist[exp] = hist;
        } catch (_) {}
      }
    }
  } catch (_) {}
  render();
}

// ── Live BTC spot — direct browser WebSocket to Binance (millisecond ticks) ──
// Bypasses the 15s /api/chain poll entirely for the header price AND for
// every downstream calculation (breakevens, max pain, P&L, delta/gamma
// triggers all read this via effectiveSpot()). Binance's BTCUSDT feed is
// the deepest, fastest BTC book on the internet — ticks arrive far faster
// than Delta's own socket. Trade-off, explicitly chosen: Delta India's
// options settle against Delta's own index, which can drift a few dollars
// from Binance spot during fast moves — this feed is the fastest available,
// not necessarily the exact settlement price. If Binance goes stale/down,
// effectiveSpot() falls back to the server-polled Delta chain price, so
// analytics never depend on Binance alone.
// The full render() is driven by requestAnimationFrame + a dirty flag (see
// renderLoop below) instead of a fixed interval, so a full recompute of
// P&L/alerts/tables fires within ~1 frame of a tick rather than waiting on
// a timer — the header number itself still updates via a direct, cheap
// textContent write on every single tick, independent of that loop.
const WS_URL = "wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/btcusdt@bookTicker";
let spotSocket = null, wsBackoffMs = 1000, wsReconnectTimer = null;
let renderDirty = false, lastTickSpot = 0;

function flashSpot(up) {
  const el = document.getElementById("spot");
  if (!el) return;
  el.classList.remove("tick-up", "tick-down");
  void el.offsetWidth;   // restart the CSS animation even if the same class is reapplied
  el.classList.add(up ? "tick-up" : "tick-down");
}
function setSpotSrc(text, cls) {
  const el = document.getElementById("spotsrc");
  if (el) { el.textContent = text; el.className = cls; }
}
function connectSpotWS() {
  try {
    spotSocket = new WebSocket(WS_URL);
  } catch (_) {
    scheduleReconnect();
    return;
  }
  spotSocket.onopen = () => { wsBackoffMs = 1000; };   // combined stream, no subscribe message needed
  spotSocket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    const stream = msg.stream || "", d = msg.data || {};
    let price = 0;
    if (stream.endsWith("@aggTrade")) price = +(d.p || 0);          // last trade price
    else if (stream.endsWith("@bookTicker")) price = (+(d.b || 0) + +(d.a || 0)) / 2 || 0; // bid/ask mid
    else return;
    if (price <= 10000) return;   // sanity check, same guard as the terminal script
    state.spotWs = price;
    state.spotWsTs = Date.now();
    // Update the number immediately — don't wait for the throttled render.
    const el = document.getElementById("spot");
    if (el) {
      el.textContent = "$" + fmt(price, 2);
      if (lastTickSpot) flashSpot(price >= lastTickSpot);
      lastTickSpot = price;
    }
    setSpotSrc("⚡ live (Binance)", "g");
    renderDirty = true;   // let the rAF loop recompute P&L/alerts/tables
  };
  spotSocket.onclose = () => { setSpotSrc("reconnecting…", "y"); scheduleReconnect(); };
  spotSocket.onerror = () => { try { spotSocket.close(); } catch (_) {} };
}
function scheduleReconnect() {
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(connectSpotWS, wsBackoffMs);
  wsBackoffMs = Math.min(20000, wsBackoffMs * 1.6);   // capped exponential backoff
}

// ── Render ───────────────────────────────────────────────────────────────────
const fmt = (n, d = 0) => n == null ? "—" : (+n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const compact = (n) => n == null ? "—" : Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const gaugeColor = (frac) => frac >= 0.9 ? "var(--r)" : frac >= 0.6 ? "var(--y)" : "var(--g)";

function oiWalls(ch) {
  // Biggest OI strike per side, excluding penny options (mark < $5)
  const top = (side) => {
    const real = Object.entries(ch[side] || {}).filter(([, d]) => d.mark >= 5 && d.oi > 0);
    return real.length ? real.reduce((a, b) => (a[1].oi > b[1].oi ? a : b)) : null;
  };
  const c = top("calls"), p = top("puts");
  return { c, p, mx: Math.max(c ? c[1].oi : 0, p ? p[1].oi : 0, 1) };
}
function myStrikes(exp) {
  const c = new Set(), p = new Set();
  for (const q of (typeof MY_POSITIONS !== "undefined" ? MY_POSITIONS : [])) {
    if (!q.active || q.expiry !== exp) continue;
    if (q.call_strike) c.add(+q.call_strike);
    if (q.put_strike) p.add(+q.put_strike);
  }
  return { c, p };
}
function barRow(label, frac, color, val, extra = "") {
  return `<div class="brow"><span class="lab">${label}</span>
    <div class="bar"><i style="width:${Math.max(2, Math.min(100, frac * 100)).toFixed(0)}%;background:${color}"></i></div>
    <span class="val">${val}</span>${extra}</div>`;
}
function legBox(leg, d) {
  const iv = d.iv > 0 ? (d.iv * 100).toFixed(1) + "%" : "N/A";
  const mark = d.mark ?? leg.mark_price;
  return `<div class="legbox">
    <div class="sect" style="margin:0 0 2px">SHORT ${leg.side.toUpperCase()}</div>
    <div class="strike">${leg.side === "call" ? "C" : "P"}-${fmt(leg.strike)}</div>
    <div class="kv"><span>Entry</span><span>$${fmt(leg.entry_price, 1)}</span></div>
    <div class="kv"><span>Mark</span><span>$${fmt(mark, 1)}</span></div>
    <div class="kv"><span>IV</span><span>${iv}</span></div>
    <div class="kv"><span>Δ / θ</span><span>${(d.delta ?? 0).toFixed(3)} / ${(d.theta ?? 0).toFixed(1)}</span></div>
    <div class="kv"><span>Γ / ν</span><span>${(d.gamma ?? 0).toFixed(6)} / $${fmt(d.vega ?? 0, 1)}</span></div>
    <div class="legpnl ${leg.upnl >= 0 ? "g" : "r"}">${leg.upnl >= 0 ? "+" : ""}$${fmt(leg.upnl, 2)}</div>
  </div>`;
}

function render() {
  if (!state.chain) return;
  const S = effectiveSpot();
  document.getElementById("spot").textContent = S > 0 ? "$" + fmt(S, 2) : "—";
  const wsFresh = state.spotWs > 0 && Date.now() - state.spotWsTs < WS_SPOT_MAX_AGE_MS;
  if (wsFresh) setSpotSrc("⚡ live", "g");
  else if (state.spot > 0) setSpotSrc("server", "dim");
  else setSpotSrc("chain-derived", "dim");
  document.getElementById("clock").textContent = new Date().toLocaleTimeString();

  // Expiry cards
  let html = "";
  const tsIVs = [];
  for (const exp of state.expiries || []) {
    const ch = state.chain[exp]; const meta = state.meta[exp];
    const dte = meta.dte;
    const isRef = exp === state.reference;
    const [ck, cdd] = findTarget(ch.calls, 0.20);
    const [pk, pdd] = findTarget(ch.puts, 0.20);
    const aiv = atmIV(exp, ch, S, dte);
    if (aiv > 0) tsIVs.push([exp, aiv, meta, isRef]);
    if (!cdd || !pdd || !(cdd.mark > 0) || !(pdd.mark > 0)) {
      html += card(meta, dte, `<div class="dim">Waiting for data…</div>`, isRef); continue;
    }
    const T = Math.max(1, dte) / 365;
    const cIV = (cdd.iv > 0 ? cdd.iv : ivFromMark(S, ck, T, cdd.mark, "call")) * 100;
    const pIV = (pdd.iv > 0 ? pdd.iv : ivFromMark(S, pk, T, pdd.mark, "put")) * 100;
    const credit = cdd.mark + pdd.mark, beUp = ck + credit, beDn = pk - credit;
    const skew = pIV - cIV;
    const [em, emK] = expectedMove(ch, S);
    const [ivr] = ivRank(exp, aiv);
    const [recD, recLbl] = targetDeltaForIVR(ivr);
    const mp = maxPain(ch);
    let body = `
      <table><tr><th>Strike</th><th>Δ</th><th>IV%</th><th>Mark</th><th>Bid</th><th>Ask</th><th>Theta</th></tr>
      <tr><td>C-${fmt(ck)} 20Δ</td><td class="y">${Math.abs(cdd.delta).toFixed(3)}</td><td>${cIV.toFixed(1)}%</td><td>$${fmt(cdd.mark, 1)}</td><td>${fmt(cdd.bid, 1)}</td><td>${fmt(cdd.ask, 1)}</td><td>${cdd.theta?.toFixed(1) ?? "—"}</td></tr>
      <tr><td>P-${fmt(pk)} 20Δ</td><td class="y">${Math.abs(pdd.delta).toFixed(3)}</td><td>${pIV.toFixed(1)}%</td><td>$${fmt(pdd.mark, 1)}</td><td>${fmt(pdd.bid, 1)}</td><td>${fmt(pdd.ask, 1)}</td><td>${pdd.theta?.toFixed(1) ?? "—"}</td></tr></table>
      <div class="line"><b>→ Strangle C-${fmt(ck)} + P-${fmt(pk)}</b></div>
      <div class="line">Credit: <span class="y">$${fmt(credit)}/BTC</span> │ BE: <span class="r">$${fmt(beDn)}</span> – <span class="r">$${fmt(beUp)}</span> │ ${skew >= 0 ? "+" : ""}${skew.toFixed(1)}% put skew</div>`;
    if (em) {
      const safe = emSafe(beDn, beUp, S, em);
      body += `<div class="line">Expected Move (1σ): <span class="c">± $${fmt(em)}</span> → $${fmt(S - em)} – $${fmt(S + em)} <span class="dim">(ATM ${fmt(emK)} × ${EM_FACTOR})</span></div>
      <div class="line">Breakevens vs EM: ${safe ? `<span class="g">✓ SAFE (outside EM)</span>` : `<span class="r">⚠ INSIDE EM — low probability</span>`}</div>`;
    }
    body += `<div class="line">IV Rank: ${ivr == null ? `<span class="dim">collecting… (ATM IV ${(aiv * 100).toFixed(1)}%)</span>` : `<b class="${recD !== 0.2 ? "m" : "c"}">${ivr.toFixed(0)}%</b>`} → target <b>${recLbl}</b></div>`;
    if (state.rv30 > 0 && aiv > 0) {
      const ratio = aiv / state.rv30; const [lbl, col] = ivrvStatus(ratio);
      body += `<div class="line">IV/RV: <b class="${col === "green" ? "g" : col === "yellow" ? "y" : "r"}">${ratio.toFixed(2)} ●</b> (ATM IV ${(aiv * 100).toFixed(1)}% / RV30 ${(state.rv30 * 100).toFixed(1)}%) → <span class="${col === "green" ? "g" : col === "yellow" ? "y" : "r"}">${lbl}</span></div>`;
    }
    if (ivr != null && recD !== 0.20) {
      const [rk, rd] = findTarget(ch.calls, recD), [qk, qd] = findTarget(ch.puts, recD);
      if (rd?.mark > 0 && qd?.mark > 0) {
        const rc = rd.mark + qd.mark;
        body += `<div class="line m">★ RECOMMENDED ${Math.round(recD * 100)}Δ: C-${fmt(rk)} + P-${fmt(qk)} │ credit $${fmt(rc)}/BTC │ BE $${fmt(qk - rc)}–$${fmt(rk + rc)}</div>`;
      }
    }
    const sk = skewAdjusted(skew, recD);
    if (sk) {
      const [scD, spD, why] = sk;
      const [sck, scd] = findTarget(ch.calls, scD), [spk, spd] = findTarget(ch.puts, spD);
      if (scd?.mark > 0 && spd?.mark > 0) {
        const sc = scd.mark + spd.mark;
        body += `<div class="line b">◆ SKEW ADJ (${skew >= 0 ? "+" : ""}${skew.toFixed(1)}% ${why}): Try C-${Math.round(scD * 100)}Δ + P-${Math.round(spD * 100)}Δ → C-${fmt(sck)} + P-${fmt(spk)} │ credit $${fmt(sc)}/BTC</div>`;
      }
    }
    if (mp) body += `<div class="line">Max Pain: <span class="c">$${fmt(mp)}</span> (${(((mp - S) / S) * 100).toFixed(1)}% vs spot)</div>`;
    // ── OI Walls for this expiry ─────────────────────────────────────────
    const w = oiWalls(ch);
    if (w.c || w.p) {
      const mine = myStrikes(exp);
      body += `<div class="sect">OI Walls</div>`;
      if (w.c) body += barRow(`Call wall C-${fmt(+w.c[0])}`, w.c[1].oi / w.mx, "var(--r)",
        compact(w.c[1].oi), mine.c.has(+w.c[0]) ? ` <span class="c">← your short</span>` : "");
      if (w.p) body += barRow(`Put wall P-${fmt(+w.p[0])}`, w.p[1].oi / w.mx, "var(--g)",
        compact(w.p[1].oi), mine.p.has(+w.p[0]) ? ` <span class="c">← your short</span>` : "");
    }
    html += card(meta, dte, body, isRef);
  }
  document.getElementById("expiries").innerHTML = html;

  // Term structure — "ivs" (tsIVs) includes every displayed expiry, incl. the
  // reference month, but the shape/recommendation is deliberately computed
  // from your two actual trade-target expiries only, so a reference-month
  // reading never skews which of YOUR expiries the tool prefers.
  let tsHtml = "";
  const tradeIVs = tsIVs.filter(([, , , isRef]) => !isRef);
  if (tradeIVs.length >= 2) {
    const spread = (tradeIVs[1][1] - tradeIVs[0][1]) * 100;
    const shape = spread <= -TS_FLAT_PTS ? "BACKWARDATION" : spread >= TS_FLAT_PTS ? "CONTANGO" : "FLAT";
    const cls = shape === "BACKWARDATION" ? "g" : shape === "CONTANGO" ? "y" : "";
    const rec = shape === "BACKWARDATION"
      ? `Prefer ${tradeIVs[0][2].label} — front IV richer: faster theta, better roll yield`
      : shape === "CONTANGO"
        ? `⚠ Vol event priced into ${tradeIVs[1][2].label} — avoid it or sell a WIDER strangle there; ${tradeIVs[0][2].label} is cleaner`
        : "Flat term structure — default ~45DTE expiry is fine";
    tsHtml = `<b>VOL TERM STRUCTURE</b>&nbsp; ${tsIVs.map(([e, iv, m, isRef]) =>
        `<span class="${isRef ? "dim" : "c"}">${m.label} (${m.dte}DTE)${isRef ? " ref" : ""}</span> ${(iv * 100).toFixed(1)}%`).join(" &nbsp; ")}
      <div class="line">Slope: <span class="${cls}">${spread >= 0 ? "+" : ""}${spread.toFixed(1)} vol pts (${shape})</span> → <span class="${cls}">${rec}</span></div>`;
  }
  document.getElementById("term").innerHTML = tsHtml;

  // Positions
  const groups = positionGroups();
  let ph = "";
  for (const [pid, legs] of Object.entries(groups)) {
    const exp = legs[0].expiry;
    const meta = state.meta?.[exp] || { label: exp, dte: "?" };
    const info = checkPositionTriggers(pid, exp, legs, S, `${pid} ${meta.label}`);
    if (!info) continue;
    const isStrangle = !!(info.call && info.put);
    const [badgeTxt, badgeCls] = isStrangle ? ["Short Strangle", "strangle"]
      : info.put ? ["Naked Put", "naked"] : ["Naked Call", "naked"];
    const lots = Math.abs(legs[0].size);
    const held = legs[0].entry_date
      ? ` · ${Math.max(0, Math.round((Date.now() - new Date(legs[0].entry_date)) / 86400000))}d held` : "";
    const legDesc = legs.map((l) => (l.side === "call" ? "C-" : "P-") + fmt(l.strike)).join(" + ");

    // Leg boxes
    const boxes = legs.map((l) => legBox(l,
      (l.side === "call" ? state.chain?.[exp]?.calls : state.chain?.[exp]?.puts)?.[l.strike] || {})).join("");

    // Breakeven proximity bars (distance scaled to 25%)
    let beHtml = "";
    if (info.beUp != null) beHtml += barRow(`↑ Upper $${fmt(info.beUp)}`,
      Math.min(1, info.pctUp / 25), info.pctUp <= 8 ? "var(--r)" : "var(--g)", `${info.pctUp.toFixed(1)}%`);
    if (info.beDn != null) beHtml += barRow(`↓ Lower $${fmt(info.beDn)}`,
      Math.min(1, info.pctDn / 25), info.pctDn <= 8 ? "var(--r)" : "var(--g)", `${info.pctDn.toFixed(1)}%`);

    // Risk gauges: delta roll (vs 0.30) and stop-loss (vs 2.0x)
    let gHtml = "";
    if (info.call) {
      const f = Math.abs(info.cd.delta ?? 0) / TRIGGERS.delta_breach;
      gHtml += barRow("Call Δ roll", f, gaugeColor(f), `${Math.abs(info.cd.delta ?? 0).toFixed(3)} / 0.30`);
    }
    if (info.put) {
      const f = Math.abs(info.pd.delta ?? 0) / TRIGGERS.delta_breach;
      gHtml += barRow("Put Δ roll", f, gaugeColor(f), `${Math.abs(info.pd.delta ?? 0).toFixed(3)} / 0.30`);
    }
    const sf = info.lossX / TRIGGERS.stop_x_credit;
    gHtml += barRow("Stop-loss", Math.max(0, sf), gaugeColor(sf), `${info.lossX.toFixed(2)}× / 2.0×`);

    const [dotCol, statusTxt] =
      info.pnlPct >= 50 ? ["var(--g)", "50% PROFIT TARGET HIT — close the trade"] :
      info.lossX >= 2 ? ["var(--r)", `HARD STOP — CLOSE NOW (${info.lossX.toFixed(1)}×)`] :
      info.lossX >= 1.5 ? ["var(--r)", `WARNING — loss ${info.lossX.toFixed(1)}× credit`] :
      (info.pctUp != null && info.pctUp <= 8) || (info.pctDn != null && info.pctDn <= 8)
        ? ["var(--y)", "Approaching breakeven — monitor closely"]
        : ["var(--g)", "Position healthy — BTC inside profit zone"];

    ph += `<div class="card">
      <div class="pos-head"><span class="pos-id">${pid}</span>
        <span class="badge ${badgeCls}">${badgeTxt}</span>
        <span class="pill">${meta.dte} DTE</span></div>
      <div class="pos-sub">${legDesc} · ${fmt(lots)} lots${held}</div>
      <div class="sect" style="margin-top:6px">Unrealized P&amp;L</div>
      <div class="pnl-row">
        <div class="pnl-hero ${info.upnl >= 0 ? "g" : "r"}">${info.upnl >= 0 ? "+" : ""}$${fmt(info.upnl, 2)}</div>
        <div class="pnl-side">
          <div class="big ${info.pnlPct >= 0 ? "g" : "r"}">${info.pnlPct >= 0 ? "+" : ""}${info.pnlPct.toFixed(1)}% collected</div>
          <div class="dim">Entry $${fmt(info.entry)} · Current $${fmt(info.cur)}/BTC</div>
        </div>
      </div>
      <div class="legs">${boxes}</div>
      ${beHtml ? `<div class="sect">Breakeven Proximity</div>${beHtml}` : ""}
      <div class="sect">Risk Gauges</div>${gHtml}
      <div class="statusline"><span class="dot" style="background:${dotCol}"></span>
        <span style="color:${dotCol}">${statusTxt}</span>
        ${info.mp ? `<span class="dim" style="margin-left:auto">Max pain $${fmt(info.mp)}</span>` : ""}</div>
    </div>`;
  }
  document.getElementById("positions").innerHTML =
    ph || `<div class="dim">No active positions — edit positions.js in the repo to add trades.</div>`;

  // Alerts
  const al = Object.values(state.alerts);
  document.getElementById("alerts").innerHTML = al.length
    ? al.map((a) => `<div class="alert ${a.sev}"><b>[${a.ts}] ${a.title}</b><div class="dim">${a.msg}</div></div>`).join("")
    : `<div class="g">✓ All clear — no active alerts</div>`;

  // Recent alerts — persists past the condition clearing (see logRecentAlert)
  const recentEl = document.getElementById("recentAlerts");
  if (recentEl) {
    recentEl.innerHTML = state.recentAlerts.length
      ? state.recentAlerts.slice(0, 10).map((a) => {
          const when = new Date(a.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
          const stillActive = !!state.alerts[a.key];
          return `<div class="alert ${a.sev}" style="opacity:${stillActive ? 1 : .6}">
            <b>[${when}] ${a.title}</b>${stillActive ? ` <span class="y" style="font-size:10px">● still active</span>` : ""}
            <div class="dim">${a.msg}</div></div>`;
        }).join("")
      : `<div class="dim">No alerts fired yet this session.</div>`;
  }
}

function card(meta, dte, body, isRef = false) {
  const badge = isRef ? ` <span class="badge ref">reference</span>` : "";
  return `<div class="card"><div class="cardhead">${meta.label} (${dte}DTE)${badge}</div>${body}</div>`;
}

// ── Init ─────────────────────────────────────────────────────────────────────
if ("Notification" in window && Notification.permission === "default")
  document.getElementById("notifbtn").onclick = () => Notification.requestPermission();
else document.getElementById("notifbtn").style.display = "none";

pollChain(); pollPositions(); setTimeout(pollVol, 2500);
setInterval(pollChain, CHAIN_POLL_MS);
setInterval(pollPositions, POS_POLL_MS);
setInterval(pollVol, VOL_POLL_MS);

connectSpotWS();
// Recompute loop: the spot number itself updates every tick (above, direct
// textContent write), but the full P&L/alerts/tables render is pinned to
// requestAnimationFrame instead of a fixed timer — it only does work when
// renderDirty is set, so idle frames cost one boolean check, and a dirty
// frame repaints within ~16ms of the tick instead of waiting up to 400ms.
function renderLoop() {
  if (renderDirty) { renderDirty = false; render(); }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);
