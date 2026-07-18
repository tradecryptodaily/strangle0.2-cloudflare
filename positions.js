// ── YOUR POSITIONS ───────────────────────────────────────────────────────────
// This mirrors positions.json from the terminal monitor.
// When you open / close / adjust a trade: edit this file, then
//   git add positions.js && git commit -m "update positions" && git push
// Vercel redeploys automatically (~30s) and the site shows the new trades.
// Set active: false when a position is closed. call_strike/put_strike: null = no leg.
const MY_POSITIONS = [
  {
    id: "AUG28_001",
    active: true,
    expiry: "280826",            // DDMMYY
    call_strike: 70000,
    put_strike: 52000,
    entry_call_price: 910.0,     // $/BTC received per leg
    entry_put_price: 1400.0,
    lots: 500,                   // contracts (0.001 BTC each)
    entry_spot: 64032,           // BTC price at entry (used for fee calc)
    entry_date: "2026-07-07",
  },
  {
    id: "AUG28_002",
    active: true,
    expiry: "280826",
    call_strike: null,           // naked put
    put_strike: 58000,
    entry_call_price: 0,
    entry_put_price: 1160.0,
    lots: 500,
    entry_spot: 64032,
    entry_date: "2026-07-07",
  },
  {
    id: "SEP25_001",
    active: true,
    expiry: "250926",
    call_strike: 75000,
    put_strike: 55000,
    entry_call_price: 1070.0,
    entry_put_price: 1592.0,
    lots: 2000,
    entry_spot: 62447,
    entry_date: "2026-07-07",
  },
];
