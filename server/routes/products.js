/* ═══════════════════════════════════════════════════════════
   Products — public read with auto-computed average return.
   The average return for each product is the average ACHIEVED rate
   (actual_rate) across all of that product's pools that have matured
   or been paid out. CRUD is handled via the generic /api/tables API
   (admin-only writes).
   ═══════════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');
const foxess = require('../services/foxess');

/* GET /api/products — PUBLIC. Active products with avg achieved return. */
router.get('/', async (req, res) => {
  try {
    const includeInactive = req.query.all === '1';
    const { rows } = await pool.query(`
      SELECT p.*,
        (SELECT ROUND(AVG(ip.actual_rate)::numeric, 4)
           FROM investment_pools ip
          WHERE ip.product_type = p.product_type
            AND ip.status IN ('matured','paid_out')
            AND COALESCE(ip.actual_rate, 0) > 0)          AS avg_actual_rate,
        (SELECT COUNT(*)
           FROM investment_pools ip2
          WHERE ip2.product_type = p.product_type
            AND ip2.status IN ('matured','paid_out')
            AND COALESCE(ip2.actual_rate, 0) > 0)         AS matured_pool_count,
        (SELECT MIN(ip3.end_date)
           FROM investment_pools ip3
          WHERE ip3.product_type = p.product_type
            AND ip3.status IN ('open','filling','active')
            AND ip3.end_date >= CURRENT_DATE)             AS next_closing_date,
        (SELECT COUNT(*)
           FROM investment_pools ip4
          WHERE ip4.product_type = p.product_type
            AND ip4.status IN ('open','filling','active')) AS open_pool_count
      FROM products p
      ${includeInactive ? '' : 'WHERE p.is_active = true'}
      ORDER BY p.sort_order, p.label
    `);
    res.set('Cache-Control', 'no-store');
    res.json({ data: rows });
  } catch (err) {
    console.error('[products] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* GET /api/products/cattle-stats — PUBLIC. Aggregated, non-sensitive herd
   stats (no individual animal data) for the Cattle Investment product:
   number purchased to date, gender & breed breakdown, and average weight. */
router.get('/cattle-stats', async (req, res) => {
  try {
    // Daily weight-gain assumption + target sale weight power the weight journey.
    const { rows: setRows } = await pool.query(
      `SELECT setting_key, setting_value FROM cattle_nav_settings
       WHERE setting_key IN ('avg_daily_weight_gain_kg','target_sale_weight_kg')`
    );
    const settings = Object.fromEntries(setRows.map(r => [r.setting_key, r.setting_value]));
    const dailyGain    = parseFloat(settings.avg_daily_weight_gain_kg) || 1.2;
    const targetWeight = parseFloat(settings.target_sale_weight_kg) || 475;

    // Herd counts come primarily from the CYCLES the fund manager captures
    // (no_purchased / no_live / no_sold / mortalities). Individual animal rows
    // are optional and only power the gender/breed/weight breakdowns.
    const { rows: cyc } = await pool.query(`
      SELECT
        COALESCE(SUM(no_purchased), 0) AS purchased,
        COALESCE(SUM(no_live),      0) AS live,
        COALESCE(SUM(no_sold),      0) AS sold,
        COALESCE(SUM(mortalities),  0) AS mortalities
      FROM cattle_cycles
      WHERE COALESCE(status,'active') <> 'cancelled'
    `);

    const { rows: ani } = await pool.query(`
      SELECT
        COUNT(*)                                                               AS animal_count,
        COUNT(*) FILTER (WHERE COALESCE(status,'active') NOT IN ('sold','mortality')
                           AND NOT COALESCE(sold,false) AND NOT COALESCE(mortality,false)) AS animal_live,
        COUNT(*) FILTER (WHERE COALESCE(sold,false) OR status = 'sold')        AS animal_sold,
        COUNT(*) FILTER (WHERE COALESCE(mortality,false) OR status = 'mortality') AS animal_mortality,
        ROUND(AVG(entry_mass)::numeric, 1)                                     AS avg_entry_weight
      FROM cattle_animals
    `);

    const { rows: byGender } = await pool.query(`
      SELECT COALESCE(NULLIF(TRIM(gender),''), 'Unspecified') AS label, COUNT(*) AS count
      FROM cattle_animals GROUP BY 1 ORDER BY count DESC
    `);
    const { rows: byBreed } = await pool.query(`
      SELECT COALESCE(NULLIF(TRIM(breed),''), 'Unspecified') AS label, COUNT(*) AS count
      FROM cattle_animals GROUP BY 1 ORDER BY count DESC
    `);

    // Estimated current average weight for live animals = entry + gain × days in cycle
    const { rows: curRows } = await pool.query(`
      SELECT ROUND(AVG(a.entry_mass + ($1::numeric) * GREATEST(0, (CURRENT_DATE - c.cycle_start_date::date)))::numeric, 1) AS avg_current_weight
      FROM cattle_animals a
      LEFT JOIN cattle_cycles c ON c.id = a.cycle_id
      WHERE COALESCE(a.status,'active') NOT IN ('sold','mortality')
        AND NOT COALESCE(a.sold,false) AND NOT COALESCE(a.mortality,false)
        AND a.entry_mass IS NOT NULL
    `, [dailyGain]);

    const c = cyc[0] || {}, a = ani[0] || {};
    // Prefer cycle-level counts; fall back to animal counts when no cycles exist
    const cyclePurchased = parseInt(c.purchased) || 0;
    const total_purchased = cyclePurchased > 0 ? cyclePurchased : (parseInt(a.animal_count) || 0);
    const live_count      = cyclePurchased > 0 ? (parseInt(c.live) || 0) : (parseInt(a.animal_live) || 0);
    const sold_count      = cyclePurchased > 0 ? (parseInt(c.sold) || 0) : (parseInt(a.animal_sold) || 0);
    const mortality_count = cyclePurchased > 0 ? (parseInt(c.mortalities) || 0) : (parseInt(a.animal_mortality) || 0);

    res.json({
      total_purchased,
      live_count,
      sold_count,
      mortality_count,
      avg_entry_weight:   a.avg_entry_weight != null ? parseFloat(a.avg_entry_weight) : null,
      avg_current_weight: curRows[0]?.avg_current_weight != null ? parseFloat(curRows[0].avg_current_weight) : null,
      target_weight:      targetWeight,
      by_gender: byGender.map(r => ({ label: r.label, count: parseInt(r.count) })),
      by_breed:  byBreed.map(r => ({ label: r.label, count: parseInt(r.count) })),
    });
  } catch (err) {
    console.error('[cattle-stats] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* GET /api/products/solar-stats — PUBLIC. Live solar telematics aggregated
   from the FoxESS/FoxCloud installation (all solar terms share one site).
   Returns { unavailable: true } gracefully if the feed can't be reached so
   the UI simply hides the panel. */
router.get('/solar-stats', async (req, res) => {
  try {
    const data = await foxess.getSolarStats();
    res.json(data);
  } catch (err) {
    console.error('[solar-stats] error:', err.message);
    res.json({ unavailable: true });
  }
});

/* GET /api/products/solar-device — ADMIN. Live stats for a single FoxESS
   device identified by ?sn=<deviceSN>. Used by per-project dashboards. */
router.get('/solar-device', async (req, res) => {
  const { sn } = req.query;
  if (!sn) return res.status(400).json({ error: 'sn query param required' });
  try {
    const data = await foxess.getSolarStatsBySN(sn);
    res.set('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    console.error('[solar-device] error:', err.message);
    res.json({ unavailable: true, error: err.message });
  }
});

/* GET /api/products/foxess-ping — Diagnostic. Tests FoxESS connectivity and
   returns the raw device list so admin can verify the API key and SN. */
router.get('/foxess-ping', async (req, res) => {
  const crypto = require('crypto');
  const BASE    = (process.env.FOXESS_API_BASE || 'https://www.foxesscloud.com').replace(/\/$/, '');
  const API_KEY = (process.env.FOXESS_API_KEY || '').trim();
  if (!API_KEY) return res.json({ ok: false, error: 'FOXESS_API_KEY environment variable is not set on this server.' });

  const path = '/op/v0/device/list';
  const timestamp = Date.now().toString();
  const signature = crypto.createHash('md5')
    .update(`${path}\\r\\n${API_KEY}\\r\\n${timestamp}`)
    .digest('hex');
  const headers = { token: API_KEY, timestamp, signature, lang: 'en', 'Content-Type': 'application/json', 'User-Agent': 'SVCapital/1.0' };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify({ currentPage: 1, pageSize: 10 }), signal: ctrl.signal }).finally(() => clearTimeout(timer));
    const d = await r.json();
    const devices = (d.result && (d.result.data || d.result.devices)) || [];
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: d.errno === 0 || !d.errno,
      errno: d.errno,
      msg: d.msg,
      device_count: devices.length,
      devices: devices.map(dev => ({ sn: dev.deviceSN || dev.sn, name: dev.stationName || dev.plantName || dev.deviceType, status: dev.online ?? dev.status })),
      key_prefix: API_KEY.slice(0, 4) + '…',
    });
  } catch (err) {
    res.json({ ok: false, error: err.name === 'AbortError' ? 'FoxESS API timed out (12s). Check network connectivity from the server.' : err.message });
  }
});

/* GET /api/products/solar-history — PUBLIC. Daily solar generation for the
   current month (last ~30 days) for the 30-day chart. */
router.get('/solar-history', async (req, res) => {
  try {
    const data = await foxess.getSolarHistory();
    res.json(data);
  } catch (err) {
    console.error('[solar-history] error:', err.message);
    res.json({ unavailable: true });
  }
});

/* GET /api/products/track-record — PUBLIC. Per-product matured-pool performance
   (actual return vs benchmark, count, total paid back) — the verifiable track
   record. Pool-level only; no investor data. */
router.get('/track-record', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ip.id, ip.name, ip.product_type, ip.end_date, ip.term_months,
             COALESCE(ip.actual_rate, 0)  AS actual_rate,
             COALESCE(ip.annual_rate, 0)  AS annual_rate,
             COALESCE(SUM(i.amount), ip.raised_amount, 0) AS invested_amount
      FROM investment_pools ip
      LEFT JOIN investments i ON i.pool_id = ip.id
        AND (i.is_reinvestment IS NULL OR i.is_reinvestment = false)
      WHERE ip.status IN ('matured','paid_out') AND COALESCE(ip.actual_rate, 0) > 0
      GROUP BY ip.id
      ORDER BY ip.end_date ASC
    `);

    const byType = {};
    for (const p of rows) {
      const t = p.product_type;
      if (!byType[t]) byType[t] = { pools: [], total_paid_back: 0, sum_actual: 0, sum_benchmark: 0, n_with_rate: 0 };
      const actual    = parseFloat(p.actual_rate) || 0;
      const benchmark = parseFloat(p.annual_rate) || 0;
      const invested  = parseFloat(p.invested_amount) || 0;
      const term      = parseInt(p.term_months) || 12;
      const isShortTerm = t === 'short_term';
      // Short-term: actual_rate is total period return, not p.a. → annualise for display
      const annualActual = isShortTerm && term > 0 ? actual * 12 / term : actual;
      // Paid back: principal + returns (short_term uses period rate directly; others use annual rate × months)
      const paidBack = isShortTerm ? invested * (1 + actual) : invested * (1 + actual * (term / 12));
      byType[t].pools.push({ name: p.name, ended: p.end_date, actual_rate: annualActual, benchmark_rate: benchmark });
      byType[t].total_paid_back += paidBack;
      byType[t].sum_actual      += annualActual;
      byType[t].sum_benchmark   += benchmark;
    }

    const data = {};
    for (const [t, v] of Object.entries(byType)) {
      const n = v.pools.length;
      data[t] = {
        matured_count:      n,
        avg_actual_rate:    n ? v.sum_actual / n : 0,
        avg_benchmark_rate: n ? v.sum_benchmark / n : 0,
        total_paid_back:    Math.round(v.total_paid_back),
        pools:              v.pools,
      };
    }
    res.json({ data });
  } catch (err) {
    console.error('[track-record] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
