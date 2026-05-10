/**
 * DIRECTIONAL MOMENTUM V1 — server
 * Slow-MOM trend-gated strategy on SOL/LINK/ETH (validated Sharpe 3.22)
 *
 * Modes:
 *   PAPER_TRADING=true  → no live orders, all trades logged & PnL tracked virtually
 *   PAPER_TRADING=false → live HL execution (requires HL_PRIVATE_KEY/HL_ADDRESS)
 *
 * Endpoints:
 *   GET /health         — server status
 *   GET /state          — current positions, regime, equity
 *   GET /trades         — closed trades log
 *   GET /signals        — last signal computation per asset
 *   POST /tick          — manual tick (for testing)
 *   GET /               — dashboard
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { handleTick, getState, getSignals, getTrades,
        refreshUniverse, getAssets, getUniverseRefreshTs,
        USE_FULL_UNIVERSE, UNIVERSE_REFRESH_MS, blacklist,
        INTERVAL_SECONDS } = require('./engine');

const PORT = process.env.PORT || 3000;
const PAPER = process.env.PAPER_TRADING !== 'false';  // default paper
const PAPER_EQUITY = parseFloat(process.env.PAPER_EQUITY || '100000');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`); next(); });

app.get('/health', (_req, res) => {
  const s = getState();
  res.json({
    status: 'ok',
    version: 'dirmom-v1',
    mode: PAPER ? 'PAPER' : 'LIVE',
    equity: s.equity,
    regime: s.regime,
    open_positions: Object.values(s.positions).filter(p => p.pos !== 0).length,
    total_trades: getTrades().length,
    uptime_s: Math.round(process.uptime()),
    last_tick_ts: s.lastTickTs,
  });
});

app.get('/state', (_req, res) => {
  const s = getState();
  const assets = getAssets();
  const bl = blacklist.getStateSnapshot();
  res.json({
    ...s,
    universe: {
      use_full_universe: USE_FULL_UNIVERSE,
      size: Object.keys(assets).length,
      coins: Object.keys(assets).sort(),
      last_refresh_ts: getUniverseRefreshTs(),
    },
    blacklist: bl,
  });
});

app.get('/universe', (_req, res) => {
  const assets = getAssets();
  res.json({
    use_full_universe: USE_FULL_UNIVERSE,
    size: Object.keys(assets).length,
    coins: Object.keys(assets).sort(),
    blacklisted: blacklist.getBlacklisted(),
    consec_losses: blacklist.getConsecLosses(),
    last_refresh_ts: getUniverseRefreshTs(),
  });
});

app.get('/blacklist', (_req, res) => res.json(blacklist.getStateSnapshot()));

app.post('/blacklist/reset', express.json(), (req, res) => {
  const coin = req.body && req.body.coin;
  if (coin) { blacklist.resetCoin(coin); res.json({ reset: coin }); }
  else { blacklist.resetAll(); res.json({ reset: 'all' }); }
});
app.get('/signals', (_req, res) => res.json(getSignals()));
app.get('/trades', (_req, res) => res.json(getTrades()));

app.post('/tick', async (_req, res) => {
  try {
    const result = await handleTick({ paper: PAPER, equity: PAPER_EQUITY });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (_req, res) => {
  const s = getState();
  const trades = getTrades();
  const sigs = getSignals();
  const wins = trades.filter(t => t.realizedPct > 0).length;
  const wr = trades.length ? (wins / trades.length * 100).toFixed(1) : '–';
  const totalPnl = trades.reduce((a, t) => a + t.realizedPct, 0).toFixed(2);
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<title>DIRECTIONAL MOMENTUM V1</title>
<meta http-equiv="refresh" content="30">
<style>
  body { font-family: 'SF Mono', Monaco, monospace; background:#0a0a0a; color:#0f0; padding:20px; }
  h1 { color:#0ff; border-bottom:1px solid #0f0; padding-bottom:10px; }
  .panel { background:#111; border:1px solid #0f0; padding:15px; margin:15px 0; }
  .label { color:#888; font-size:11px; text-transform:uppercase; }
  .val { color:#0ff; font-size:18px; }
  table { width:100%; border-collapse:collapse; }
  th { color:#888; text-align:left; font-weight:normal; padding:6px; border-bottom:1px solid #444; }
  td { padding:6px; border-bottom:1px solid #222; }
  .pos1 { color:#0f0; } .posn1 { color:#f33; } .pos0 { color:#888; }
  .badge { display:inline-block; padding:3px 8px; background:#0ff; color:#000; font-size:11px; }
  .live { background:#f33; color:#fff; }
</style></head><body>
<h1>DIRECTIONAL MOMENTUM V1 <span class="badge ${PAPER ? '' : 'live'}">${PAPER ? 'PAPER' : 'LIVE'}</span></h1>
<div class="panel">
  <span class="label">REGIME</span> <span class="val">${s.regime || '—'}</span> &nbsp;|&nbsp;
  <span class="label">EQUITY</span> <span class="val">$${(s.equity || PAPER_EQUITY).toFixed(2)}</span> &nbsp;|&nbsp;
  <span class="label">TRADES</span> <span class="val">${trades.length}</span> &nbsp;|&nbsp;
  <span class="label">WR</span> <span class="val">${wr}%</span> &nbsp;|&nbsp;
  <span class="label">CUM P&L</span> <span class="val">${totalPnl}%</span>
</div>
<div class="panel">
  <h3 style="color:#0ff;margin-top:0">POSITIONS</h3>
  <table>
    <tr><th>Asset</th><th>Pos</th><th>Entry</th><th>Stop</th><th>Last Price</th><th>Open P&L %</th><th>Action</th><th>Reason</th></tr>
    ${Object.entries(s.positions || {}).map(([a, p]) => {
      const sig = sigs[a] || {};
      const cls = p.pos === 1 ? 'pos1' : p.pos === -1 ? 'posn1' : 'pos0';
      const dir = p.pos === 1 ? 'LONG' : p.pos === -1 ? 'SHORT' : '—';
      return `<tr>
        <td><b>${a}</b></td>
        <td class="${cls}">${dir}</td>
        <td>${p.entryPx ? p.entryPx.toFixed(4) : '—'}</td>
        <td>${p.stop ? p.stop.toFixed(4) : '—'}</td>
        <td>${sig.price ? sig.price.toFixed(4) : '—'}</td>
        <td class="${p.openPnl > 0 ? 'pos1' : p.openPnl < 0 ? 'posn1' : ''}">${p.openPnl ? (p.openPnl*100).toFixed(2) : '0.00'}</td>
        <td>${sig.action || '—'}</td>
        <td>${sig.reason || '—'}</td>
      </tr>`;
    }).join('')}
  </table>
</div>
<div class="panel">
  <h3 style="color:#0ff;margin-top:0">RECENT TRADES (last 20)</h3>
  <table>
    <tr><th>Closed</th><th>Asset</th><th>Side</th><th>Entry</th><th>Exit</th><th>P&L %</th><th>Reason</th></tr>
    ${trades.slice(-20).reverse().map(t => `<tr>
      <td>${t.closedTs}</td>
      <td>${t.asset}</td>
      <td class="${t.side === 'LONG' ? 'pos1' : 'posn1'}">${t.side}</td>
      <td>${t.entryPx?.toFixed(4)}</td>
      <td>${t.exitPx?.toFixed(4)}</td>
      <td class="${t.realizedPct > 0 ? 'pos1' : 'posn1'}">${t.realizedPct.toFixed(2)}</td>
      <td>${t.reason}</td>
    </tr>`).join('') || '<tr><td colspan=7 style="color:#666">no trades yet</td></tr>'}
  </table>
</div>
<div class="panel">
  <h3 style="color:#0ff;margin-top:0">CONFIG</h3>
  <pre style="color:#0f0;margin:0">${JSON.stringify({ size: Object.keys(getAssets()).length, sample: Object.keys(getAssets()).slice(0, 20), blacklisted: blacklist.getBlacklisted() }, null, 2)}</pre>
</div>
<p style="color:#444;font-size:11px;margin-top:30px">last tick: ${s.lastTickTs || 'never'} · poll: every ${INTERVAL_SECONDS}s · auto-refresh: 30s</p>
</body></html>`);
});

// Background tick loop
async function tickLoop() {
  try {
    console.log(`[loop] tick start (mode=${PAPER ? 'PAPER' : 'LIVE'})`);
    const r = await handleTick({ paper: PAPER, equity: PAPER_EQUITY });
    if (r.events.length) console.log('[loop] events:', JSON.stringify(r.events));
  } catch (e) {
    console.error('[loop err]', e.message);
  }
}

app.listen(PORT, async () => {
  console.log(`DIRECTIONAL MOMENTUM V1 listening on :${PORT} (mode=${PAPER ? 'PAPER' : 'LIVE'}, paper_equity=$${PAPER_EQUITY})`);
  console.log(`  use_full_universe=${USE_FULL_UNIVERSE} blacklist_threshold=${blacklist.THRESHOLD}`);
  // Populate ASSETS from HL meta (or fall back to curated trio) before first tick
  const n = await refreshUniverse();
  console.log(`  active universe: ${n} assets`);
  tickLoop();
  setInterval(tickLoop, INTERVAL_SECONDS * 1000);
  setInterval(refreshUniverse, UNIVERSE_REFRESH_MS);
});
