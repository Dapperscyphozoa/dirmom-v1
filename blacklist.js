/**
 * Coin blacklist + consecutive-loss tracker (Node.js).
 *
 * Persistent JSON-file-backed counter per coin:
 *   - increments on losing close (realizedPct <= 0)
 *   - resets to 0 on winning close
 *   - blacklisted when counter >= BLACKLIST_LOSS_THRESHOLD (default 5)
 *   - blacklist is sticky (survives restarts; manual reset only)
 *
 * Same disk layout as the Python vol-squeeze engines but JSON not SQLite,
 * since dirmom already uses JSON files for state/trades.
 */
const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.STATE_DIR || __dirname;
const BL_FILE = path.join(STATE_DIR, 'dirmom-blacklist.json');
const THRESHOLD = parseInt(process.env.BLACKLIST_LOSS_THRESHOLD || '5', 10);

let _state = null;

function _load() {
  if (_state) return _state;
  if (fs.existsSync(BL_FILE)) {
    try { _state = JSON.parse(fs.readFileSync(BL_FILE, 'utf8')); }
    catch (e) { _state = {}; }
  } else {
    _state = {};
  }
  return _state;
}

function _save() {
  try { fs.writeFileSync(BL_FILE, JSON.stringify(_state, null, 2)); }
  catch (e) { console.error('[blacklist] save failed:', e.message); }
}

function recordOutcome(coin, netPct, outcome) {
  if (!coin) return;
  const s = _load();
  if (!s[coin]) {
    s[coin] = { consec_losses: 0, blacklisted: false, blacklist_ts: null,
                 last_outcome_ts: null, last_net_pct: null };
  }
  const row = s[coin];
  const isLoss = netPct <= 0;
  if (isLoss) {
    row.consec_losses += 1;
    if (row.consec_losses >= THRESHOLD && !row.blacklisted) {
      row.blacklisted = true;
      row.blacklist_ts = Date.now();
      console.log(`[blacklist] ${coin} BLACKLISTED after ${row.consec_losses} consec losses`);
    }
  } else {
    row.consec_losses = 0;
    // sticky: blacklisted stays true
  }
  row.last_outcome_ts = Date.now();
  row.last_net_pct = netPct;
  row.last_outcome = outcome || null;
  _save();
}

function isBlacklisted(coin) {
  const s = _load();
  return Boolean(s[coin] && s[coin].blacklisted);
}

function getBlacklisted() {
  const s = _load();
  return Object.entries(s)
    .filter(([_, v]) => v.blacklisted)
    .sort((a, b) => (a[1].blacklist_ts || 0) - (b[1].blacklist_ts || 0))
    .map(([coin]) => coin);
}

function getConsecLosses() {
  const s = _load();
  const out = {};
  for (const [coin, row] of Object.entries(s)) {
    if (row.consec_losses > 0) out[coin] = row.consec_losses;
  }
  return out;
}

function getStateSnapshot() {
  const s = _load();
  const blacklisted = getBlacklisted();
  return {
    threshold: THRESHOLD,
    blacklisted,
    blacklisted_count: blacklisted.length,
    consec_losses: getConsecLosses(),
    tracked_coins: Object.keys(s).length,
  };
}

function resetCoin(coin) {
  const s = _load();
  if (s[coin]) {
    s[coin].consec_losses = 0;
    s[coin].blacklisted = false;
    s[coin].blacklist_ts = null;
    _save();
  }
}

function resetAll() {
  const s = _load();
  for (const coin of Object.keys(s)) {
    s[coin].consec_losses = 0;
    s[coin].blacklisted = false;
    s[coin].blacklist_ts = null;
  }
  _save();
}

module.exports = {
  recordOutcome,
  isBlacklisted,
  getBlacklisted,
  getConsecLosses,
  getStateSnapshot,
  resetCoin,
  resetAll,
  THRESHOLD,
};
