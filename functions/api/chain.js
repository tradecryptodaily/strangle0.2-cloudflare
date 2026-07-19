// GET /api/chain — Cloudflare Pages Function (routed from this file's path:
// functions/api/chain.js → /api/chain). Full option chain + BTC spot for
// the tracked 45/80-DTE expiries. Public Delta data, called unsigned.
import { deltaGet, targetExpiries, expToDate, nearestMonthlyExpiry } from "./_delta.js";

function extract(t) {
  // IV / bid / ask tolerant to Delta schema variants (greeks.iv, mark_vol, quotes.*)
  const g = t.greeks || {};
  const q = t.quotes || {};
  let iv = +((g.iv ?? t.mark_vol ?? t.iv) || 0);
  if (iv <= 0) {
    const bi = +(q.bid_iv || 0), ai = +(q.ask_iv || 0);
    iv = bi > 0 && ai > 0 ? (bi + ai) / 2 : bi || ai;
  }
  if (iv > 3) iv /= 100;
  return {
    mark: +(t.mark_price || 0),
    bid: +((t.best_bid ?? q.best_bid) || 0),
    ask: +((t.best_ask ?? q.best_ask) || 0),
    iv,
    delta: +((g.delta ?? 0) || 0),
    gamma: +((g.gamma ?? 0) || 0),
    vega: +((g.vega ?? 0) || 0),
    theta: +((g.theta ?? 0) || 0),
    oi: +((t.oi_value ?? t.oi_contracts ?? t.oi) || 0),
  };
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    // Extra expiries the client needs beyond the 45/80-DTE targets — e.g. an
    // active position that no longer matches either target as time passes.
    const url = new URL(request.url);
    const extra = (url.searchParams.get("expiries") || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const tradeTargets = targetExpiries(undefined, extra);

    // Nearest monthly, shown as a 3rd reference-only card for full
    // term-structure context. If it already coincides with a trade target
    // (or an active position's expiry), don't duplicate the card.
    const refCandidate = nearestMonthlyExpiry();
    const reference = tradeTargets.includes(refCandidate) ? null : refCandidate;
    const expiries = reference
      ? [...tradeTargets, reference].sort((a, b) => expToDate(a) - expToDate(b))
      : tradeTargets;

    const data = await deltaGet("/v2/tickers", { contract_types: "call_options,put_options" }, false, env);
    const chain = {};
    for (const e of expiries) chain[e] = { calls: {}, puts: {} };
    let spot = 0;
    for (const t of data.result || []) {
      const sym = t.symbol || "";
      const parts = sym.split("-");
      if (parts.length === 4 && parts[1] === "BTC" && chain[parts[3]]) {
        const side = parts[0] === "C" ? "calls" : "puts";
        chain[parts[3]][side][parts[2]] = extract(t);
        // Option tickers carry the underlying spot — free, no extra request
        if (!spot) {
          const sp = +(t.spot_price || 0);
          if (sp > 10000) spot = sp;
        }
      }
    }
    // Fallback: index / perp tickers
    if (!spot) {
      for (const sym of ["BTCUSDT", ".DEXBTUSDT", ".DEBTCUSDT"]) {
        try {
          const s = await deltaGet("/v2/tickers/" + encodeURIComponent(sym), null, false, env);
          const r = s.result || {};
          const v = +(r.spot_price || r.index_price || r.mark_price || r.close || 0);
          if (v > 10000) { spot = v; break; }
        } catch (_) {}
      }
    }

    const now = Date.now();
    const meta = {};
    for (const e of expiries) {
      const d = expToDate(e);
      meta[e] = {
        label: d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
        dte: Math.max(0, Math.round((d.getTime() - now) / 86400000)),
      };
    }
    return json(
      { fetched_at: new Date().toISOString(), spot, expiries, meta, chain,
        reference, trade_targets: tradeTargets },
      200,
      { "cache-control": "s-maxage=10, stale-while-revalidate=30" }
    );
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}
