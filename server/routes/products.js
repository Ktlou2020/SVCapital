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
        /* As posted: the average return achieved over each pool's own period.
           DELIBERATELY UNCHANGED. The portal's product grid shows this under a
           "(N MO)" label for short_term — correctly, as a period figure — and
           short_term has matured pools, so annualising this field would have
           put 5.11% under a label reading "(5 MO)" on a live screen. The name
           has an established meaning here; the new basis gets a new name. */
        (SELECT ROUND(AVG(ip.actual_rate)::numeric, 4)
           FROM investment_pools ip
          WHERE ip.product_type = p.product_type
            AND ip.status IN ('matured','paid_out')
            AND COALESCE(ip.actual_rate, 0) > 0)          AS avg_actual_rate,

        /* Annualised, simply — × 12 / term_months. Additive: nothing reads it
           yet. It exists so the grid's "AVG RETURN P.A." tile has a figure that
           is actually per annum to move to, rather than continuing to label a
           period return that way. On a 12-month pool the two coincide, which is
           why cattle has always looked right; on solar_7yr the period figure is
           seven years' return presented as one year's. A pool with no term is
           left as posted rather than guessed at. */
        (SELECT ROUND(AVG(
                  CASE WHEN COALESCE(ip.term_months, 0) > 0
                       THEN ip.actual_rate * 12.0 / ip.term_months
                       ELSE ip.actual_rate END)::numeric, 4)
           FROM investment_pools ip
          WHERE ip.product_type = p.product_type
            AND ip.status IN ('matured','paid_out')
            AND COALESCE(ip.actual_rate, 0) > 0)          AS avg_annual_rate,
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

/* GET /api/products/faqs — PUBLIC. The questions shown under an offering.
 *
 * Rows, not markup, because the EIF answers describe how a structure avoids
 * riba and whoever is accountable for that wording has to be able to correct
 * it without a deploy. ?category= narrows to one offering; the default returns
 * everything active so a caller can group them itself. */
router.get('/faqs', async (req, res) => {
  try {
    const category = (req.query.category || '').trim();
    const params = [];
    let where = 'WHERE is_active = true';
    if (category) { params.push(category); where += ` AND category = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT id, category, product_type, question, answer, sort_order
         FROM product_faqs ${where}
        ORDER BY sort_order, question`, params);
    res.set('Cache-Control', 'no-store');
    res.json({ data: rows });
  } catch (err) {
    console.error('[products/faqs] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ── The interest-free election ───────────────────────────────────────────
 *
 * The platform imports interest from 3PIM each period and credits it to
 * investor wallets and sub-accounts. A client who came here for the Ethical
 * and Interest-Free offering keeps their money in that same wallet, so
 * without this they would be paid riba by the platform that sold them the
 * alternative to it — quietly, as a line on a statement they did not ask for.
 *
 * This is the client's own choice, recorded on their record. The interest run
 * reads it in two places: the preview marks the row `interest_free` and leaves
 * it out of the total, and the apply re-reads it at the moment of payment so a
 * stale preview cannot credit someone who has since opted out.
 *
 * It is not implied by holding an EIF product, and it is not set for them.
 * Some clients hold both kinds and want the interest; that is theirs to say.
 */
const { requireAuth } = require('../middleware/auth');

/* The token claim is `investorId`. Reading `investor_id` here finds nothing
   and falls through to the users-table uuid, which matches no investor row —
   the election would appear to save and then not be there. */
const callerInvestorId = req => (req.user && (req.user.investorId || req.user.investor_id)) || null;

router.get('/eif/election', requireAuth, async (req, res) => {
  try {
    const id = callerInvestorId(req);
    if (!id) return res.json({ interest_free_election: false });
    const { rows } = await pool.query(
      'SELECT COALESCE(interest_free_election, false) AS elected FROM investors WHERE id = $1', [id]);
    res.set('Cache-Control', 'no-store');
    res.json({ interest_free_election: !!(rows[0] && rows[0].elected) });
  } catch (err) {
    console.error('[products/eif-election] read error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.put('/eif/election', requireAuth, async (req, res) => {
  try {
    const id = callerInvestorId(req);
    if (!id) return res.status(403).json({ error: 'Forbidden.' });
    /* Only ever the caller's own row. There is no id in the path for a reason:
       one client must not be able to set another's election. */
    const elected = req.body && req.body.interest_free_election === true;
    const { rowCount } = await pool.query(
      `UPDATE investors SET interest_free_election = $1, updated_at = NOW() WHERE id = $2`,
      [elected, id]);
    if (!rowCount) return res.status(404).json({ error: 'Investor not found.' });
    res.json({ success: true, interest_free_election: elected });
  } catch (err) {
    console.error('[products/eif-election] write error:', err.message);
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

      /* actual_rate is the return achieved FOR THE POOL'S PERIOD, for every
         product — not per annum and not prorated over term_months. This treated
         short_term as the only period-based product and everything else as per
         annum, which is the convention the rest of the platform moved off.

         The money figure is not a matter of convention at all. The maturity
         engine pays `amount * actual_rate` with no proration, for every product
         (see postedReturnFor in maturityCron). So paid-back has to be
         invested * (1 + actual) or it is not reporting what was paid. The old
         expression multiplied the return by term/12 — one for a 12-month cattle
         pool, so cattle was unaffected and the error stayed invisible, but
         SEVEN for solar_7yr. A published rand figure was overstating what
         investors received by a factor of the term in years. */
      const paidBack = invested * (1 + actual);

      /* Annualised for display, because the tile that shows this says "p.a."
         and because an average across a five-month pool and a seven-year one
         is meaningless otherwise. Simple, not compounded — the same 12/term
         the file already applied to short_term, now applied consistently
         rather than to one product. The period figure is carried alongside so
         nothing downstream has to reverse it. */
      const annualActual = term > 0 ? actual * 12 / term : actual;

      byType[t].pools.push({
        name: p.name, ended: p.end_date,
        actual_rate: annualActual,      // annualised, matching the p.a. label
        period_rate: actual,            // as posted on the pool, unmodified
        term_months: term,
        benchmark_rate: benchmark,
      });
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
    /* Stated, not implied. This endpoint is public and its figures are
       published as achieved performance, so what the rate means travels with
       it rather than being inferred by each caller. */
    res.json({
      data,
      rate_basis: 'annualised_simple',
      note: 'actual_rate on a pool is the return achieved for that pool\'s period. ' +
            'avg_actual_rate and pools[].actual_rate are annualised simply (× 12 / term_months); ' +
            'pools[].period_rate is the figure as posted. total_paid_back is capital × (1 + period rate), ' +
            'which is what the maturity engine pays.',
    });
  } catch (err) {
    console.error('[track-record] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
