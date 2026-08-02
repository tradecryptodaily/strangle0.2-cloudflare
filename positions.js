// ── YOUR POSITIONS ───────────────────────────────────────────────────────────
// This mirrors positions.json from the terminal monitor.
// When you open / close / adjust a trade: edit this file, then
//   git add positions.js && git commit -m "update positions" && git push
// Vercel redeploys automatically (~30s) and the site shows the new trades.
// Set active: false when a position is closed. call_strike/put_strike: null = no leg.
const MY_POSITIONS = [
  {
    id: "AUG28_001",
    active: false,               // CLOSED Aug 1, 2026 — bought back both legs
    expiry: "280826",            // DDMMYY
    call_strike: 70000,
    put_strike: 52000,
    entry_call_price: 910.0,     // $/BTC received per leg
    entry_put_price: 1400.0,
    lots: 500,                   // contracts (0.001 BTC each)
    entry_spot: 64032,           // BTC price at entry (used for fee calc)
    entry_date: "2026-07-07",
    exit_call_price: 254.0,
    exit_put_price: 188.0,
    exit_date: "2026-08-01",
  },
  {
    id: "AUG28_002",
    active: false,               // CLOSED Aug 1, 2026 — bought back
    expiry: "280826",
    call_strike: null,           // naked put
    put_strike: 58000,
    entry_call_price: 0,
    entry_put_price: 1160.0,
    lots: 500,
    entry_spot: 64032,
    entry_date: "2026-07-11",    // corrected from fill history (was mis-recorded as 07-07)
    exit_put_price: 727.0,
    exit_date: "2026-08-01",
  },
  {
    id: "AUG28_003",
    active: false,               // CLOSED Aug 1, 2026 — bought back
    expiry: "280826",
    call_strike: 74000,          // naked call
    put_strike: null,
    entry_call_price: 600.0,
    entry_put_price: 0,
    lots: 500,
    entry_spot: 65000,           // estimate — correct if you have the exact fill spot
    entry_date: "2026-07-21",
    exit_call_price: 67.2,
    exit_date: "2026-08-01",
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
  {
    id: "SEP25_002",
    active: true,
    expiry: "250926",
    call_strike: 70000,          // naked call — extra leg added Aug 1 alongside SEP25_001
    put_strike: null,
    entry_call_price: 910.0,
    entry_put_price: 0,
    lots: 2000,
    entry_spot: 63494,           // estimate — correct if you have the exact fill spot
    entry_date: "2026-08-01",
  },
  {
    // Clubbed Oct 30 strangle — was two separate naked legs (OCT30_001 put +
    // OCT30_002 call), merged into one position per request. Lots are
    // asymmetric (1200 calls vs 1000 puts) — call_lots/put_lots carry the
    // true per-leg size; `lots` is a legacy fallback only.
    id: "OCT30_001",
    active: true,
    expiry: "301026",
    call_strike: 73000,
    put_strike: 54000,
    entry_call_price: 1300.0,
    entry_put_price: 1450.0,
    lots: 1000,
    call_lots: 1200,              // opened Aug 2, originally 700, +500 more added later, same price
    put_lots: 1000,               // opened Aug 1, originally 500, +500 more added later, same price
    entry_spot: 63300,           // estimate — correct if you have the exact fill spot
    entry_date: "2026-08-01",
  },
];
