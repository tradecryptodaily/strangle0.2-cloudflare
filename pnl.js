// ── P&L statement — computed entirely client-side from positions.js ──────────
// No API calls: closed-trade P&L only needs entry/exit prices already stored
// on each position record, and "premium collected" only needs entry prices +
// lots. Updates automatically whenever positions.js changes (close a trade,
// add a new one, club two legs) — nothing here needs to be touched by hand.

const fmt = (n, d = 0) => n == null ? "—" : (+n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const money = (n, d = 2) => (n < 0 ? "-" : "") + "$" + fmt(Math.abs(n), d);

function legLots(p, side) {
  // Per-leg lot override for a "clubbed" position (call/put built up to
  // different sizes over time) — same fallback rule as live_monitor.py and
  // app.js's pollPositions(): call_lots/put_lots override `lots` if present.
  if (side === "call") return p.call_lots ?? p.lots ?? 0;
  return p.put_lots ?? p.lots ?? 0;
}

function computePnL() {
  const positions = typeof MY_POSITIONS !== "undefined" ? MY_POSITIONS : [];

  // ── Closed trades: only ones with an exit price on at least one leg ──────
  const closed = positions.filter(
    (p) => !p.active && (p.exit_call_price != null || p.exit_put_price != null)
  );

  const trades = closed.map((p) => {
    const legs = [];
    let pnl = 0;
    if (p.call_strike && p.exit_call_price != null) {
      const lots = legLots(p, "call");
      const legPnl = (p.entry_call_price - p.exit_call_price) * lots * 0.001;
      pnl += legPnl;
      legs.push({ label: `C-${fmt(p.call_strike)}`, entry: p.entry_call_price, exit: p.exit_call_price, pnl: legPnl });
    }
    if (p.put_strike && p.exit_put_price != null) {
      const lots = legLots(p, "put");
      const legPnl = (p.entry_put_price - p.exit_put_price) * lots * 0.001;
      pnl += legPnl;
      legs.push({ label: `P-${fmt(p.put_strike)}`, entry: p.entry_put_price, exit: p.exit_put_price, pnl: legPnl });
    }
    return { id: p.id, pnl, legs };
  });

  const totalRealized = trades.reduce((a, t) => a + t.pnl, 0);
  const winCount = trades.filter((t) => t.pnl > 0).length;
  const winRate = trades.length ? (winCount / trades.length) * 100 : null;

  // ── Open positions: credit collected, not yet realized ────────────────────
  const open = positions.filter((p) => p.active);
  const openRows = open.map((p) => {
    const callLots = legLots(p, "call");
    const putLots = legLots(p, "put");
    const credit =
      (p.call_strike ? p.entry_call_price * callLots * 0.001 : 0) +
      (p.put_strike ? p.entry_put_price * putLots * 0.001 : 0);
    const legDesc = [
      p.call_strike ? `C-${fmt(p.call_strike)}` : null,
      p.put_strike ? `P-${fmt(p.put_strike)}` : null,
    ].filter(Boolean).join(" + ");
    const lotsTxt =
      p.call_strike && p.put_strike && callLots !== putLots
        ? `${fmt(callLots)}C / ${fmt(putLots)}P lots`
        : `${fmt(callLots || putLots)} lots`;
    return { id: p.id, legDesc, lotsTxt, credit };
  });
  const totalOpenCredit = openRows.reduce((a, r) => a + r.credit, 0);

  // ── Premium collected over time: every position (closed + open), running
  // cumulative total keyed on entry_date, sorted chronologically ───────────
  const byDate = positions
    .filter((p) => p.entry_date)
    .map((p) => {
      const callLots = legLots(p, "call");
      const putLots = legLots(p, "put");
      const credit =
        (p.call_strike ? p.entry_call_price * callLots * 0.001 : 0) +
        (p.put_strike ? p.entry_put_price * putLots * 0.001 : 0);
      return { date: p.entry_date, credit };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const curveMap = new Map();
  let running = 0;
  for (const t of byDate) {
    running += t.credit;
    curveMap.set(t.date, running); // later same-day entries just overwrite with the fuller running total
  }

  return {
    trades, totalRealized, winRate,
    openRows, totalOpenCredit,
    curveLabels: [...curveMap.keys()],
    curveData: [...curveMap.values()],
  };
}

function render() {
  const r = computePnL();

  document.getElementById("subtitle").textContent =
    `${r.trades.length} closed trade${r.trades.length === 1 ? "" : "s"} · ${r.openRows.length} open position${r.openRows.length === 1 ? "" : "s"}`;

  document.getElementById("kpiRealized").textContent = money(r.totalRealized);
  document.getElementById("kpiRealized").className = "val " + (r.totalRealized >= 0 ? "pos" : "r");
  document.getElementById("kpiClosed").textContent = fmt(r.trades.length);
  document.getElementById("kpiWinRate").textContent = r.winRate == null ? "—" : fmt(r.winRate) + "%";
  document.getElementById("kpiOpenCredit").textContent = money(r.totalOpenCredit, 0);

  // Leg detail table
  const tbody = document.querySelector("#legTable tbody");
  tbody.innerHTML = "";
  for (const t of r.trades) {
    for (const leg of t.legs) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${t.id}</td><td>${leg.label}</td><td>${fmt(leg.entry, 1)}</td><td>${fmt(leg.exit, 1)}</td>
        <td class="${leg.pnl >= 0 ? "g" : "r"}">${leg.pnl >= 0 ? "+" : ""}${money(leg.pnl)}</td>`;
      tbody.appendChild(tr);
    }
  }
  document.getElementById("emptyTrades").style.display = r.trades.length ? "none" : "block";

  // Open positions list
  const openList = document.getElementById("openList");
  openList.innerHTML = "";
  for (const o of r.openRows) {
    const row = document.createElement("div");
    row.className = "openrow";
    row.innerHTML = `<span>${o.id} · ${o.legDesc} · ${o.lotsTxt}</span><span class="y">${money(o.credit, 0)} credit</span>`;
    openList.appendChild(row);
  }
  document.getElementById("emptyOpen").style.display = r.openRows.length ? "none" : "block";

  // ── Charts ────────────────────────────────────────────────────────────────
  const grid = "rgba(255,255,255,0.06)";
  const tick = "#6a6a6a";

  if (r.trades.length) {
    new Chart(document.getElementById("pnlChart"), {
      type: "bar",
      data: {
        labels: r.trades.map((t) => t.id),
        datasets: [{ data: r.trades.map((t) => t.pnl), backgroundColor: "#4ec9b0", borderRadius: 4, maxBarThickness: 60 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => money(c.parsed.y) } } },
        scales: {
          y: { beginAtZero: true, grid: { color: grid }, ticks: { color: tick, callback: (v) => "$" + v } },
          x: { grid: { display: false }, ticks: { color: tick } },
        },
      },
    });
  } else {
    document.getElementById("pnlChart").closest(".chartwrap").style.display = "none";
  }

  new Chart(document.getElementById("curveChart"), {
    type: "line",
    data: {
      labels: r.curveLabels,
      datasets: [{
        data: r.curveData, borderColor: "#4ec9b0", backgroundColor: "rgba(78,201,176,0.12)",
        fill: true, tension: 0.35, borderWidth: 2, pointRadius: 4,
        pointBackgroundColor: "#4ec9b0", pointBorderColor: "#000", pointBorderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => "$" + c.parsed.y.toLocaleString() } } },
      scales: {
        y: { beginAtZero: true, grid: { color: grid }, ticks: { color: tick, callback: (v) => "$" + v.toLocaleString() } },
        x: { grid: { display: false }, ticks: { color: tick } },
      },
    },
  });
}

render();
