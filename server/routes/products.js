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
    res.json({ data: rows });
  } catch (err) {
    console.error('[products] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* GET /api/products/cattle-stats — PUBLIC. Aggregated, non-sensitive herd
   stats (no individual animal data) for the Cattle Investment product:
   number purchased to date, gender & breed breakdown, and average weight. */
router.get('/cattle-stats', async (req, res) => {
  try {
    // Daily weight-gain assumption powers the current-weight estimate.
    const { rows: setRows } = await pool.query(
      `SELECT setting_value FROM cattle_nav_settings WHERE setting_key = 'avg_daily_weight_gain_kg' LIMIT 1`
    );
    const dailyGain = parseFloat(setRows[0]?.setting_value) || 1.2;

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
      SELECT ROUND(AVG(a.entry_mass + $1 * GREATEST(0, (CURRENT_DATE - c.cycle_start_date::date)))::numeric, 1) AS avg_current_weight
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
      by_gender: byGender.map(r => ({ label: r.label, count: parseInt(r.count) })),
      by_breed:  byBreed.map(r => ({ label: r.label, count: parseInt(r.count) })),
    });
  } catch (err) {
    console.error('[cattle-stats] error:', err.message);
    res.status(500).json({ error: err.message });
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

module.exports = router;
