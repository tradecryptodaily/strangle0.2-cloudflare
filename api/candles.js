// GET /api/candles?symbol=BTCUSD&days=35 — daily candles (public, unsigned).
// Used for: 30-day realized vol + IV-history backfill (MARK:<option symbol>).
// NOTE: Delta India's BTC perpetual is "BTCUSD" (no T) — "BTCUSDT" is not a
// valid product on this endpoint and returns an empty result with HTTP 200
// (no error), so a caller relying on the default would silently get no data.
const { deltaGet } = require("./_delta");

module.exports = async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "BTCUSD").slice(0, 60);
    const days = Math.min(60, Math.max(5, +(req.query.days || 35)));
    const end = Math.floor(Date.now() / 1000);
    const start = end - days * 86400;
    const data = await deltaGet("/v2/history/candles", {
      symbol, resolution: "1d", start: String(start), end: String(end),
    });
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    res.status(200).json({ result: data.result || [] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
