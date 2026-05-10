/**
 * DIRECTIONAL MOMENTUM V1 — engine
 * Core strategy logic. Pure-function signals + paper trading state machine.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const pm = require('./pm-client');
const blacklist = require('./blacklist');

const USE_FULL_UNIVERSE = process.env.USE_FULL_UNIVERSE !== '0';  // default ON
const UNIVERSE_REFRESH_MS = parseInt(process.env.UNIVERSE_REFRESH_SEC || '3600', 10) * 1000;
let _universeLastRefreshTs = 0;

// ============ ASSET CONFIG ============
// Originally tuned trio (validated 180d backtest, Sharpe 3.22) — kept as the
// reference params for the curated coins. New coins added via HL universe
// expansion get DEFAULT_PARAMS (ETH-style: fast 72, slow 432, trail 2.0).
const REFERENCE_ASSETS = {
  'SOL':  { okx: 'SOL-USDT-SWAP',  hl: 'SOL',  fast: 48, slow: 288, trailAtr: 1.5 },
  'LINK': { okx: 'LINK-USDT-SWAP', hl: 'LINK', fast: 72, slow: 432, trailAtr: 2.0 },
  'ETH':  { okx: 'ETH-USDT-SWAP',  hl: 'ETH',  fast: 72, slow: 432, trailAtr: 2.0 },
};
const DEFAULT_PARAMS = { fast: 72, slow: 432, trailAtr: 2.0 };

// ASSETS is mutable — populated on startup from HL universe (or falls back to
// REFERENCE_ASSETS if USE_FULL_UNIVERSE=0 or HL fetch fails).
let ASSETS = {};

function _hlMeta() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'meta' });
    const req = https.request({
      hostname: 'api.hyperliquid.xyz', path: '/info', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('hl meta timeout')); });
    req.write(body); req.end();
  });
}

async function refreshUniverse() {
  if (!USE_FULL_UNIVERSE) {
    // Curated mode: use the validated trio with original allocs
    ASSETS = {
      'SOL':  { ...REFERENCE_ASSETS.SOL,  alloc: 0.40 },
      'LINK': { ...REFERENCE_ASSETS.LINK, alloc: 0.35 },
      'ETH':  { ...REFERENCE_ASSETS.ETH,  alloc: 0.25 },
    };
    _universeLastRefreshTs = Date.now();
    console.log(`[universe] curated mode: ${Object.keys(ASSETS).length} assets`);
    return Object.keys(ASSETS).length;
  }
  try {
    const meta = await _hlMeta();
    if (!meta || !Array.isArray(meta.universe) || meta.universe.length === 0) {
      throw new Error('bad meta response');
    }
    const names = meta.universe.map((u) => u && u.name).filter((n) => typeof n === 'string');
    const next = {};
    const allocPer = 1.0 / names.length;
    for (const name of names) {
      const ref = REFERENCE_ASSETS[name];
      const params = ref || DEFAULT_PARAMS;
      next[name] = {
        okx: `${name}-USDT-SWAP`,
        hl: name,
        fast: params.fast,
        slow: params.slow,
        trailAtr: params.trailAtr,
        alloc: allocPer,
      };
    }
    ASSETS = next;
    _universeLastRefreshTs = Date.now();
    console.log(`[universe] refreshed: ${names.length} HL perps (alloc=${(allocPer*100).toFixed(2)}% each)`);
    return names.length;
  } catch (e) {
    console.error(`[universe] refresh failed: ${e.message}; falling back to curated trio`);
    if (Object.keys(ASSETS).length === 0) {
      ASSETS = {
        'SOL':  { ...REFERENCE_ASSETS.SOL,  alloc: 0.40 },
        'LINK': { ...REFERENCE_ASSETS.LINK, alloc: 0.35 },
        'ETH':  { ...REFERENCE_ASSETS.ETH,  alloc: 0.25 },
      };
    }
    return Object.keys(ASSETS).length;
  }
}
const ATR_N = 48;
const FEES_BPS = 4.5;
const SLIPPAGE_BPS = 2.0;
const RISK_PCT = 0.02;
const INTERVAL_SECONDS = 300;  // 5min poll

const STATE_FILE = path.join(process.env.STATE_DIR || __dirname, 'dirmom-state.json');
const TRADES_FILE = path.join(process.env.STATE_DIR || __dirname, 'dirmom-trades.json');

// ============ DATA FETCH (OKX public) ============
function okxFetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('okx timeout')); });
  });
}

async function fetchKlines(symbol, days = 30) {
  const end = Date.now();
  const start = end - days * 86400 * 1000;
  let cursor = end;
  const out = [];
  for (let calls = 0; calls < 100 && cursor > start; calls++) {
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${symbol}&bar=5m&after=${cursor}&limit=300`;
    let j;
    try { j = await okxFetch(url); }
    catch (e) { await new Promise(r => setTimeout(r, 500)); continue; }
    if (j.code !== '0' || !j.data || !j.data.length) break;
    for (const r of j.data) {
      out.push({
        ts: parseInt(r[0]),
        open: parseFloat(r[1]),
        high: parseFloat(r[2]),
        low: parseFloat(r[3]),
        close: parseFloat(r[4]),
        vol: parseFloat(r[5]),
      });
    }
    const oldest = parseInt(j.data[j.data.length - 1][0]);
    if (oldest <= start || j.data.length < 300) break;
    cursor = oldest;
    await new Promise((r) => setTimeout(r, 50));
  }
  const seen = new Set();
  return out
    .filter((b) => !seen.has(b.ts) && seen.add(b.ts))
    .sort((a, b) => a.ts - b.ts);
}

// ============ INDICATORS ============
function ema(values, span) {
  const k = 2 / (span + 1);
  const out = new Array(values.length);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function atr(bars, n = ATR_N) {
  if (bars.length === 0) return [];
  const tr = bars.map((b, i) => {
    const prev = i > 0 ? bars[i - 1].close : b.close;
    return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  });
  const out = new Array(bars.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    sum += tr[i];
    if (i >= n) sum -= tr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// ============ REGIME (proxy for HMM 3-state) ============
function regimeProxy(bars) {
  if (bars.length < 200) return 'chop';
  const recent = bars.slice(-144);
  const closes = recent.map((b) => b.close);
  const drift = (closes[closes.length - 1] - closes[0]) / closes[0];
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mu) ** 2, 0) / rets.length;
  const rv = Math.sqrt(variance);
  const driftBps = Math.abs(drift) * 10000;
  const rvBps = rv * 10000;
  if (driftBps > 200 && rvBps > 30) return 'trend';
  if (driftBps < 80 && rvBps < 25) return 'range';
  return 'chop';
}

// ============ SIGNAL LOGIC ============
function latestSignal(bars, cfg, currentPos, currentStop, regime) {
  if (bars.length < cfg.slow + ATR_N + 2) {
    return { action: 'hold', reason: 'warmup', stop: currentStop, price: bars.length ? bars[bars.length - 1].close : null };
  }
  const closes = bars.map((b) => b.close);
  const emaF = ema(closes, cfg.fast);
  const emaS = ema(closes, cfg.slow);
  const atrArr = atr(bars);
  const last = bars.length - 1;
  const px = closes[last];
  const a = atrArr[last];
  if (!isFinite(a)) return { action: 'hold', reason: 'atr_warmup', stop: currentStop, price: px };
  const trail = cfg.trailAtr * a;
  const fNow = emaF[last], sNow = emaS[last];
  const fPrev = emaF[last - 1], sPrev = emaS[last - 1];

  if (currentPos === 0) {
    if (regime !== 'trend') return { action: 'hold', reason: `regime=${regime}`, stop: null, price: px };
    if (fNow > sNow && fPrev <= sPrev) return { action: 'open_long', reason: 'cross_up+trend', stop: px - trail, price: px };
    if (fNow < sNow && fPrev >= sPrev) return { action: 'open_short', reason: 'cross_down+trend', stop: px + trail, price: px };
    return { action: 'hold', reason: 'no_cross', stop: null, price: px };
  }
  if (currentPos === 1) {
    const newStop = currentStop ? Math.max(currentStop, px - trail) : px - trail;
    if (px < newStop) return { action: 'close', reason: 'trail_stop', stop: null, price: px };
    if (fNow < sNow) return { action: 'close', reason: 'cross_against', stop: null, price: px };
    return { action: 'hold', reason: 'in_long', stop: newStop, price: px };
  }
  if (currentPos === -1) {
    const newStop = currentStop ? Math.min(currentStop, px + trail) : px + trail;
    if (px > newStop) return { action: 'close', reason: 'trail_stop', stop: null, price: px };
    if (fNow > sNow) return { action: 'close', reason: 'cross_against', stop: null, price: px };
    return { action: 'hold', reason: 'in_short', stop: newStop, price: px };
  }
  return { action: 'hold', reason: 'unknown', stop: currentStop, price: px };
}

// ============ STATE / TRADES ============
let _state = null;
let _trades = null;
let _signals = {};

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
  }
  const init = { positions: {}, equity: null, regime: null, lastTickTs: null, realizedCum: 0 };
  for (const sym of Object.keys(ASSETS)) {
    init.positions[sym] = { pos: 0, stop: null, entryPx: null, entryTs: null, openPnl: 0, size: 0 };
  }
  return init;
}
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('save state', e.message); } }

function loadTrades() {
  if (fs.existsSync(TRADES_FILE)) {
    try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch (e) {}
  }
  return [];
}
function saveTrades(t) { try { fs.writeFileSync(TRADES_FILE, JSON.stringify(t, null, 2)); } catch (e) { console.error('save trades', e.message); } }

// ============ SIZING ============
function calcSize(equity, alloc, entryPx, stopPx) {
  // Fixed-notional override (env: FIXED_NOTIONAL_USD). When > 0, returns
  // size such that size × entryPx = FIXED_NOTIONAL_USD, ignoring risk_pct,
  // alloc, and stop distance. Read on each call so Render env edits apply
  // without restart.
  const fixedNtl = parseFloat(process.env.FIXED_NOTIONAL_USD || '0');
  if (fixedNtl > 0 && entryPx > 0) {
    return fixedNtl / entryPx;
  }
  const capRisk = equity * alloc * RISK_PCT;
  const pxRisk = Math.abs(entryPx - stopPx);
  if (pxRisk <= 0 || entryPx <= 0) return 0;
  const notional = capRisk / (pxRisk / entryPx);
  return notional / entryPx;
}

// ============ MAIN TICK ============
async function handleTick({ paper = true, equity = 100000, hlClient = null } = {}) {
  if (!_state) _state = loadState();
  if (!_trades) _trades = loadTrades();
  const ts = new Date().toISOString();
  const events = [];

  // regime
  let regime = 'chop';
  try {
    const btc = await fetchKlines('BTC-USDT-SWAP', 7);
    regime = regimeProxy(btc);
  } catch (e) {
    console.error('regime fetch fail', e.message);
  }
  _state.regime = regime;

  // current equity (paper = static base + cumulative realized; live = HL fetch)
  let curEquity = equity;
  if (!paper && hlClient) {
    try {
      const acct = await hlClient.getAccountState();
      curEquity = parseFloat(acct.marginSummary.accountValue);
    } catch (e) { console.error('hl equity fetch fail', e.message); }
  } else {
    curEquity = equity * (1 + _state.realizedCum);
  }
  _state.equity = curEquity;

  // per-asset (skip blacklisted; ensure position record exists for new coins)
  const blSet = new Set(blacklist.getBlacklisted());
  for (const [sym, cfg] of Object.entries(ASSETS)) {
    if (blSet.has(sym)) continue;
    if (!_state.positions[sym]) {
      _state.positions[sym] = { pos: 0, stop: null, entryPx: null, entryTs: null, openPnl: 0, size: 0 };
    }
    let bars;
    try { bars = await fetchKlines(cfg.okx, 30); }
    catch (e) {
      // OKX won't have every HL coin (esp newer perps) — skip silently for those
      events.push({ ts, asset: sym, event: 'ERR_FETCH', msg: e.message });
      continue;
    }
    const st = _state.positions[sym];
    const sig = latestSignal(bars, cfg, st.pos, st.stop, regime);
    _signals[sym] = sig;

    if (sig.action === 'open_long' || sig.action === 'open_short') {
      const dir = sig.action === 'open_long' ? 1 : -1;
      const isLive = !paper;
      
      // Pull live size_fraction from PM (lifecycle stage). Paper engines: 1.0.
      // Fail-closed: if PM unreachable, getSizeFraction returns 0.0 → skip.
      const sizeFraction = isLive ? await pm.getSizeFraction() : 1.0;
      if (isLive && sizeFraction <= 0) {
        events.push({ ts, asset: sym, event: 'SKIP_PM_SIZE_ZERO',
                       reason: 'pm_size_fraction_zero_or_unreachable' });
        continue;
      }
      
      const baseSize = calcSize(curEquity, cfg.alloc, sig.price, sig.stop);
      const size = baseSize * sizeFraction;
      const notional = size * sig.price;
      
      if (notional < 10) {
        events.push({ ts, asset: sym, event: 'SKIP_NOTIONAL_TOO_SMALL',
                       size, notional, sizeFraction });
        continue;
      }
      
      // Pre-trade gate (fail-closed if PM unreachable when PM_CHECK_ENABLED=1)
      const slDistPct = Math.abs(sig.price - sig.stop) / sig.price;
      const pmCheck = await pm.checkPretrade({
        coin: cfg.hl, side: dir === 1 ? 'B' : 'A',
        notional, slDistancePct: slDistPct, isLive,
      });
      if (!pmCheck.allow) {
        events.push({ ts, asset: sym, event: 'DENIED_BY_PM',
                       reason: pmCheck.reason, pm_check: pmCheck });
        continue;
      }
      
      if (isLive && hlClient && hlClient.placeOrder) {
        // Generate cloid + register with PM before placing
        const cloid = `dirmom_${cfg.hl}_${ts}`;
        try { await pm.registerCloid(cloid, cfg.hl); }
        catch (e) { console.error('[dirmom] register_cloid err (non-fatal):', e.message); }
        try { await hlClient.placeOrder({ coin: cfg.hl, isBuy: dir === 1, sz: size, limit_px: sig.price, reduceOnly: false, cloid }); }
        catch (e) { events.push({ ts, asset: sym, event: 'ERR_ORDER', msg: e.message }); continue; }
      }
      st.pos = dir; st.entryPx = sig.price; st.stop = sig.stop;
      st.entryTs = ts; st.size = size; st.openPnl = 0;
      events.push({ ts, asset: sym, event: sig.action.toUpperCase(),
                     price: sig.price, stop: sig.stop, size: +size.toFixed(6),
                     reason: sig.reason, pm_size_fraction: sizeFraction,
                     pm_capital_remaining: pmCheck.capital_remaining });
    } else if (sig.action === 'close' && st.pos !== 0) {
      if (!paper && hlClient && hlClient.closePosition) {
        try { await hlClient.closePosition({ coin: cfg.hl }); }
        catch (e) { events.push({ ts, asset: sym, event: 'ERR_CLOSE', msg: e.message }); }
      }
      const grossPct = st.pos * (sig.price - st.entryPx) / st.entryPx;
      const realizedPct = grossPct - (FEES_BPS + SLIPPAGE_BPS) / 1e4;
      _state.realizedCum += realizedPct * cfg.alloc;  // weight contribution by alloc
      const trade = {
        asset: sym,
        side: st.pos === 1 ? 'LONG' : 'SHORT',
        entryTs: st.entryTs,
        closedTs: ts,
        entryPx: st.entryPx,
        exitPx: sig.price,
        size: st.size,
        realizedPct: realizedPct * 100,
        reason: sig.reason,
      };
      _trades.push(trade);
      try { blacklist.recordOutcome(sym, realizedPct * 100, sig.reason); }
      catch (e) { console.error(`[blacklist] hook failed for ${sym}: ${e.message}`); }
      events.push({ ts, asset: sym, event: 'CLOSE', price: sig.price, realizedPct: +(realizedPct*100).toFixed(3), reason: sig.reason });
      st.pos = 0; st.entryPx = null; st.stop = null; st.entryTs = null; st.openPnl = 0; st.size = 0;
    } else if (sig.action === 'hold' && st.pos !== 0) {
      st.stop = sig.stop;
      st.openPnl = st.pos * (sig.price - st.entryPx) / st.entryPx;
    }
  }

  _state.lastTickTs = ts;
  saveState(_state);
  saveTrades(_trades);
  return { ts, regime, equity: curEquity, events, paper };
}

function getState() { if (!_state) _state = loadState(); return _state; }
function getSignals() { return _signals; }
function getTrades() { if (!_trades) _trades = loadTrades(); return _trades; }

module.exports = {
  handleTick,
  getState,
  getSignals,
  getTrades,
  refreshUniverse,
  getAssets: () => ASSETS,
  getUniverseRefreshTs: () => _universeLastRefreshTs,
  ATR_N,
  INTERVAL_SECONDS,
  USE_FULL_UNIVERSE,
  UNIVERSE_REFRESH_MS,
  blacklist,
  // exports for testing
  fetchKlines,
  ema,
  atr,
  regimeProxy,
  latestSignal,
};
