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
            AND COALESCE(ip2.actual_rate, 0) > 0)         AS matured_pool_count
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

module.exports = router;
