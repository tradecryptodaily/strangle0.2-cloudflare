// GET /api/candles?symbol=BTCUSD&days=35 — Cloudflare Pages Function.
// Daily candles (public, unsigned). Used for: 30-day realized vol + IV
// history backfill (MARK:<option symbol>).
// NOTE: Delta India's BTC perpetual is "BTCUSD" (no T) — "BTCUSDT" is not a
// valid product on this endpoint and returns an empty result with HTTP 200
// (no error), so a caller relying on the default would silently get no data.
import { deltaGet } from "./_delta.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const symbol = String(url.searchParams.get("symbol") || "BTCUSD").slice(0, 60);
    const days = Math.min(60, Math.max(5, +(url.searchParams.get("days") || 35)));
    const end = Math.floor(Date.now() / 1000);
    const start = end - days * 86400;
    const data = await deltaGet("/v2/history/candles", {
      symbol, resolution: "1d", start: String(start), end: String(end),
    }, false, env);
    return new Response(JSON.stringify({ result: data.result || [] }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "s-maxage=1800, stale-while-revalidate=3600",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
