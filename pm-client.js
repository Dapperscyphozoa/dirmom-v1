/**
 * pm-client.js — JavaScript client for portfolio-manager service.
 *
 * Mirrors the Python pm_client API:
 *   getEquity()                            → number | null
 *   getRegime(coin)                        → object | null
 *   getSizeFraction(engine?)               → number 0..1, fail-closed 0
 *   checkPretrade({coin, side, notional, slDistancePct, isLive, engine}) → object
 *
 * All calls are fail-closed: if PM is unreachable, sizing returns 0 and the
 * gate denies. Engines never trade when PM is down.
 *
 * Required env:
 *   PM_URL              base URL (default https://portfolio-manager-7df2.onrender.com)
 *   ENGINE_NAME         must match a key in PM's STRATEGY_REGISTRY
 *   PM_CHECK_ENABLED    "1" to actually call /check (else default-allow)
 *   PM_AUTH_TOKEN       optional shared secret
 *   PM_TIMEOUT_SEC      default 5
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const PM_URL = (process.env.PM_URL || 'https://portfolio-manager-7df2.onrender.com').replace(/\/$/, '');
const ENGINE_NAME = process.env.ENGINE_NAME || '';
const PM_CHECK_ENABLED = process.env.PM_CHECK_ENABLED === '1';
const PM_AUTH_TOKEN = (process.env.PM_AUTH_TOKEN || '').trim();
const PM_TIMEOUT_SEC = parseInt(process.env.PM_TIMEOUT_SEC || '5', 10);
const SIZE_CACHE_TTL_SEC = parseInt(process.env.PM_SIZE_CACHE_TTL || '60', 10);

const _sizeCache = new Map();  // engine -> {value, expiry}

function _request(method, path, body) {
  return new Promise((resolve) => {
    const u = new URL(PM_URL + path);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json' };
    if (PM_AUTH_TOKEN) headers['X-PM-Auth'] = PM_AUTH_TOKEN;
    let payload;
    if (body !== undefined && body !== null) {
      payload = Buffer.from(JSON.stringify(body));
      headers['Content-Length'] = payload.length;
    }
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method, headers, timeout: PM_TIMEOUT_SEC * 1000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try {
          if (res.statusCode === 429) {
            const j = buf ? JSON.parse(buf) : {};
            return resolve({ _rate_limited: true, ...j });
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return resolve(buf ? JSON.parse(buf) : {});
          }
          return resolve({ _http_error: res.statusCode, _body: buf });
        } catch (e) {
          return resolve({ _parse_error: e.message, _body: buf });
        }
      });
    });
    req.on('error', (e) => resolve({ _unreachable: true, _error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ _unreachable: true, _error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function getEquity() {
  const r = await _request('GET', '/equity');
  if (!r || r._unreachable || r._http_error) return null;
  const av = r.account_value;
  return av != null ? Number(av) : null;
}

async function getRegime(coin) {
  const r = await _request('GET', `/regime/${coin}`);
  if (!r || r._unreachable || r._http_error) return null;
  return r;
}

async function getSizeFraction(engine = ENGINE_NAME) {
  const now = Date.now() / 1000;
  const cached = _sizeCache.get(engine);
  if (cached && cached.expiry > now) return cached.value;
  
  const r = await _request('GET', `/size/${engine}`);
  if (!r || r._unreachable) return 0.0;            // fail-closed
  if (r._http_error === 404) return 0.0;
  if (r.halted) return 0.0;
  const sf = Number(r.size_fraction || 0);
  _sizeCache.set(engine, { value: sf, expiry: now + SIZE_CACHE_TTL_SEC });
  return sf;
}

async function checkPretrade({ coin, side, notional, slDistancePct, isLive = true, engine = ENGINE_NAME }) {
  if (!PM_CHECK_ENABLED) {
    return { allow: true, reason: 'pm_check_disabled', engine, coin };
  }
  if (!engine) return { allow: false, reason: 'ENGINE_NAME_unset' };
  if (!notional || notional <= 0) return { allow: false, reason: 'notional_must_be_positive' };
  
  const body = { engine, coin, side, notional: Number(notional), is_live: !!isLive };
  if (slDistancePct != null) body.sl_distance_pct = slDistancePct;
  
  const r = await _request('POST', '/check', body);
  if (!r) return { allow: false, reason: 'pm_unreachable' };
  if (r._unreachable) return { allow: false, reason: 'pm_unreachable', error: r._error };
  if (r._rate_limited) return { allow: false, reason: 'rate_limited', retry_after_seconds: r.retry_after_seconds };
  if (r._http_error) return { allow: false, reason: `pm_error_${r._http_error}`, body: r._body };
  return r;
}

async function isPmLive() {
  const r = await _request('GET', '/health');
  return !!(r && r.status === 'ok');
}

async function registerCloid(cloid, coin, engine = ENGINE_NAME) {
  if (!engine) return { ok: false, reason: 'ENGINE_NAME_unset' };
  if (!cloid) return { ok: false, reason: 'cloid_empty' };
  const body = { cloid: String(cloid), engine: String(engine) };
  if (coin) body.coin = String(coin);
  const r = await _request('POST', '/register_cloid', body);
  if (!r) return { ok: false, reason: 'pm_unreachable' };
  if (r._unreachable) return { ok: false, reason: 'pm_unreachable', error: r._error };
  if (r._http_error) return { ok: false, reason: `pm_error_${r._http_error}` };
  return r;
}

module.exports = {
  getEquity, getRegime, getSizeFraction, checkPretrade, isPmLive, registerCloid,
  ENGINE_NAME, PM_URL, PM_CHECK_ENABLED,
};
