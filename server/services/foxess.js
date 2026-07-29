/* ═══════════════════════════════════════════════════════════
   FoxESS / FoxCloud OpenAPI client — Solar telematics
   Docs: https://www.foxesscloud.com  (OpenAPI /op/v0/*)
   Auth: signature = md5(`${path}\r\n${token}\r\n${timestamp}`)
   sent in the token/timestamp/signature headers.

   The API key is read from the FOXESS_API_KEY environment variable
   (set it in your deployment — do not commit it). All three solar
   products (5/6/7-year) are the SAME physical installation — just
   different investment terms — so a single aggregate powers all.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');

const BASE    = (process.env.FOXESS_API_BASE || 'https://www.foxesscloud.com').replace(/\/$/, '');
const API_KEY = (process.env.FOXESS_API_KEY || '').trim();

function _headers(path) {
  const timestamp = Date.now().toString();
  // FoxESS signs with the LITERAL 4-char separator \r\n (backslash-r-backslash-n),
  // NOT an actual CRLF — hence the double backslashes below.
  const signature = crypto.createHash('md5')
    .update(`${path}\\r\\n${API_KEY}\\r\\n${timestamp}`)
    .digest('hex');
  return {
    'token':        API_KEY,
    'timestamp':    timestamp,
    'signature':    signature,
    'lang':         'en',
    'User-Agent':   'SVCapital/1.0',
    'Content-Type': 'application/json',
  };
}

const FETCH_TIMEOUT_MS = 12000; // 12 s — abort if FoxESS doesn't respond

function _fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function _post(path, body) {
  const r = await _fetchWithTimeout(BASE + path, { method: 'POST', headers: _headers(path), body: JSON.stringify(body || {}) });
  const d = await r.json();
  if (d && d.errno && d.errno !== 0) throw new Error(`FoxESS ${path} errno ${d.errno}: ${d.msg || ''}`);
  return d ? d.result : null;
}

async function _get(path, query) {
  const url = BASE + path + (query ? '?' + query : '');
  const r = await _fetchWithTimeout(url, { method: 'GET', headers: _headers(path) });
  const d = await r.json();
  if (d && d.errno && d.errno !== 0) throw new Error(`FoxESS ${path} errno ${d.errno}: ${d.msg || ''}`);
  return d ? d.result : null;
}

/* ─── Aggregated solar telematics (cached) ─── */
let _cache = { at: 0, data: null };
const CACHE_MS = 10 * 60 * 1000; // 10 minutes — well within FoxESS rate limits

async function getSolarStats() {
  if (!API_KEY) throw new Error('FOXESS_API_KEY not configured');
  if (_cache.data && (Date.now() - _cache.at) < CACHE_MS) return _cache.data;

  // 1) Devices on the account
  const listRes = await _post('/op/v0/device/list', { currentPage: 1, pageSize: 100 });
  const devices = (listRes && (listRes.data || listRes.devices)) || [];

  let today = 0, month = 0, cumulative = 0, power = 0, n = 0, stationName = null;

  for (const dev of devices) {
    const sn = dev.deviceSN || dev.sn;
    if (!sn) continue;
    n++;
    if (!stationName && (dev.stationName || dev.plantName)) stationName = dev.stationName || dev.plantName;

    // Energy generated (today / month / cumulative kWh)
    try {
      const gen = await _get('/op/v0/device/generation', `sn=${encodeURIComponent(sn)}`);
      if (gen) {
        today      += parseFloat(gen.today)      || 0;
        month      += parseFloat(gen.month)      || 0;
        cumulative += parseFloat(gen.cumulative) || 0;
      }
    } catch (_) { /* per-device failure is non-fatal */ }

    // Real-time generation power (kW)
    try {
      const real = await _post('/op/v0/device/real/query', { sn, variables: ['generationPower'] });
      const datas = (Array.isArray(real) ? (real[0] && real[0].datas) : (real && real.datas)) || [];
      const gp = datas.find(d => d.variable === 'generationPower');
      if (gp) power += parseFloat(gp.value) || 0;
    } catch (_) { /* non-fatal */ }
  }

  const data = {
    device_count:     n,
    station_name:     stationName,
    current_power_kw: Math.round(power * 100) / 100,
    today_kwh:        Math.round(today * 10) / 10,
    month_kwh:        Math.round(month * 10) / 10,
    total_kwh:        Math.round(cumulative * 10) / 10,
    co2_avoided_kg:   Math.round(cumulative * 0.9), // ≈0.9 kg CO₂ / kWh (SA grid)
    updated_at:       new Date().toISOString(),
  };
  _cache = { at: Date.now(), data };
  return data;
}

/* ─── Daily generation for the current month (cached) ─── */
let _histCache = { at: 0, data: null };
const HIST_CACHE_MS = 30 * 60 * 1000; // 30 minutes

async function getSolarHistory() {
  if (!API_KEY) throw new Error('FOXESS_API_KEY not configured');
  if (_histCache.data && (Date.now() - _histCache.at) < HIST_CACHE_MS) return _histCache.data;

  const listRes = await _post('/op/v0/device/list', { currentPage: 1, pageSize: 100 });
  const devices = (listRes && (listRes.data || listRes.devices)) || [];

  const now   = new Date();
  const year  = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const byDay = {};

  for (const dev of devices) {
    const sn = dev.deviceSN || dev.sn;
    if (!sn) continue;
    try {
      // Daily generation report for the month
      const rep = await _post('/op/v0/device/report', { sn, year, month, dimension: 'day', variables: ['generation'] });
      const arr = Array.isArray(rep) ? rep : (rep && rep.datas) || [];
      const gen = arr.find(x => x.variable === 'generation') || arr[0];
      const values = (gen && (gen.values || gen.data)) || [];
      values.forEach((v, i) => {
        const day = i + 1;
        const val = typeof v === 'object' ? (parseFloat(v.value) || 0) : (parseFloat(v) || 0);
        byDay[day] = (byDay[day] || 0) + val;
      });
    } catch (_) { /* non-fatal per device */ }
  }

  const series = Object.keys(byDay).map(Number).sort((a, b) => a - b)
    .map(d => ({ day: d, kwh: Math.round(byDay[d] * 10) / 10 }));

  const data = { year, month, series, updated_at: new Date().toISOString() };
  _histCache = { at: Date.now(), data };
  return data;
}

/* ─── Per-device stats (for individual project dashboards) ─── */
async function getSolarStatsBySN(sn) {
  if (!API_KEY) throw new Error('FOXESS_API_KEY not configured');
  if (!sn) throw new Error('Device SN required');

  let today = 0, month = 0, cumulative = 0, power = 0;

  const gen = await _get('/op/v0/device/generation', `sn=${encodeURIComponent(sn)}`);
  if (gen) {
    today      = parseFloat(gen.today)      || 0;
    month      = parseFloat(gen.month)      || 0;
    cumulative = parseFloat(gen.cumulative) || 0;
  }

  try {
    const real = await _post('/op/v0/device/real/query', { sn, variables: ['generationPower', 'gridConsumptionPower', 'pvPower', 'SoC'] });
    const datas = (Array.isArray(real) ? (real[0] && real[0].datas) : (real && real.datas)) || [];
    const gp = datas.find(d => d.variable === 'generationPower');
    if (gp) power = parseFloat(gp.value) || 0;
  } catch (_) { /* non-fatal */ }

  const now = new Date();
  const year  = now.getUTCFullYear();
  const monthNum = now.getUTCMonth() + 1;
  let series = [];
  try {
    const rep = await _post('/op/v0/device/report', { sn, year, month: monthNum, dimension: 'day', variables: ['generation'] });
    const arr = Array.isArray(rep) ? rep : (rep && rep.datas) || [];
    const genVar = arr.find(x => x.variable === 'generation') || arr[0];
    const values = (genVar && (genVar.values || genVar.data)) || [];
    series = values.map((v, i) => ({ day: i + 1, kwh: Math.round((typeof v === 'object' ? parseFloat(v.value) : parseFloat(v)) * 10) / 10 || 0 })).filter(x => x.kwh > 0);
  } catch (_) { /* non-fatal */ }

  return {
    device_sn:        sn,
    current_power_kw: Math.round(power * 100) / 100,
    today_kwh:        Math.round(today * 10) / 10,
    month_kwh:        Math.round(month * 10) / 10,
    total_kwh:        Math.round(cumulative * 10) / 10,
    co2_avoided_kg:   Math.round(cumulative * 0.9),
    month_series:     series,
    updated_at:       new Date().toISOString(),
  };
}

module.exports = { getSolarStats, getSolarHistory, getSolarStatsBySN };
