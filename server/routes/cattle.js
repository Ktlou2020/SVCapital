'use strict';
/* ═══════════════════════════════════════════════════════════
   Cattle batch import endpoints
   POST /api/cattle/import/cycles  — bulk upsert cattle_cycles
   POST /api/cattle/import/animals — bulk insert cattle_animals (skip duplicates)
   ═══════════════════════════════════════════════════════════ */
const express     = require('express');
const router      = express.Router();
const pool        = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

/* Helper: generate a short prefixed ID */
const genId = prefix => `${prefix}-${uuidv4().replace(/-/g,'').slice(0,12).toUpperCase()}`;

/* Helper: insert a batch of rows into a table inside a single transaction.
   rows: array of { colName: value } objects.
   Returns count inserted. */
async function bulkInsert(client, table, rows) {
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  let inserted = 0;
  for (const row of rows) {
    const vals = cols.map(c => row[c]);
    const ph   = cols.map((_, i) => `$${i + 1}`).join(', ');
    try {
      await client.query(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph}) ON CONFLICT DO NOTHING`,
        vals
      );
      inserted++;
    } catch (_) { /* skip individual row errors */ }
  }
  return inserted;
}

/* ── GET /api/cattle/animals/stats ──────────────────────────
   Returns aggregate stats + distinct batches/breeds for the
   animals filter bar. Accepts the same filter params as the
   table API: search, status, batch_no, breed.             */
router.get('/animals/stats', requireAuth, async (req, res) => {
  try {
    const { search, status, batch_no, breed } = req.query;
    const conds = [], params = [];

    if (search) {
      params.push(`%${search}%`);
      conds.push(`(tag_number ILIKE $${params.length} OR batch_name ILIKE $${params.length} OR batch_no::text ILIKE $${params.length} OR breed ILIKE $${params.length})`);
    }
    if (status)   { params.push(status);   conds.push(`status = $${params.length}`); }
    if (batch_no) { params.push(batch_no); conds.push(`batch_no = $${params.length}`); }
    if (breed)    { params.push(breed);    conds.push(`breed = $${params.length}`); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const [agg, batches, breeds] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int                                                             AS total,
           COUNT(*) FILTER (WHERE status='sold'      OR sold=true)::int             AS sold,
           COUNT(*) FILTER (WHERE status='mortality' OR mortality=true)::int        AS mortalities,
           ROUND(AVG(entry_mass)::numeric, 1)                                       AS avg_mass
         FROM cattle_animals ${where}`,
        params
      ),
      pool.query(`SELECT DISTINCT batch_no FROM cattle_animals WHERE batch_no IS NOT NULL ORDER BY batch_no`),
      pool.query(`SELECT DISTINCT breed    FROM cattle_animals WHERE breed    IS NOT NULL ORDER BY breed`),
    ]);

    res.json({
      ...agg.rows[0],
      batches: batches.rows.map(r => r.batch_no),
      breeds:  breeds.rows.map(r => r.breed),
    });
  } catch (err) {
    console.error('[cattle/animals/stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/cattle/import/cycles ─────────────────────────
   Body: { records: [...] }
   Skips rows whose batch_name already exists.             */
router.post('/import/cycles', requireAuth, async (req, res) => {
  try {
    const records = req.body?.records;
    if (!Array.isArray(records) || !records.length)
      return res.json({ inserted: 0, skipped: 0 });

    /* Fetch existing batch names for dedup */
    const { rows: existing } = await pool.query('SELECT batch_name FROM cattle_cycles');
    const existingNames = new Set(existing.map(r => (r.batch_name || '').toLowerCase()));

    const toInsert = records.filter(r => r.batch_name && !existingNames.has(r.batch_name.toLowerCase()));
    const skipped  = records.length - toInsert.length;

    if (!toInsert.length) return res.json({ inserted: 0, skipped });

    const client = await pool.connect();
    let inserted = 0;
    try {
      await client.query('BEGIN');
      const rows = toInsert.map(r => ({
        id:                   genId('CC'),
        batch_name:           r.batch_name           || null,
        inv_no:               r.inv_no               || null,
        invoice_date:         r.invoice_date         || null,
        cycle_start_date:     r.cycle_start_date     || null,
        end_date:             r.end_date             || null,
        sale_date:            r.sale_date            || null,
        cycle_no:             r.cycle_no             || null,
        days_in_cycle:        r.days_in_cycle != null ? parseInt(r.days_in_cycle) || null : null,
        company:              r.company              || null,
        no_purchased:         parseInt(r.no_purchased)        || 0,
        mortalities:          parseInt(r.mortalities)         || 0,
        no_live:              parseInt(r.no_live)             || 0,
        no_sold:              parseInt(r.no_sold)             || 0,
        unsold_cattle:        parseInt(r.unsold_cattle)       || 0,
        avg_cattle_cost:      r.avg_cattle_cost      != null ? parseFloat(r.avg_cattle_cost)      || null : null,
        purchase_value:       r.purchase_value       != null ? parseFloat(r.purchase_value)       || null : null,
        expected_sale_value:  r.expected_sale_value  != null ? parseFloat(r.expected_sale_value)  || null : null,
        total_selling_price:  r.total_selling_price  != null ? parseFloat(r.total_selling_price)  || null : null,
        selling_price_per_head: r.selling_price_per_head != null ? parseFloat(r.selling_price_per_head) || null : null,
        svc_standing_fee:     r.svc_standing_fee     != null ? parseFloat(r.svc_standing_fee)     || null : null,
        net_return_pct:       r.net_return_pct       != null ? parseFloat(r.net_return_pct)       || null : null,
        outstanding_invoice:  r.outstanding_invoice  != null ? parseFloat(r.outstanding_invoice)  || null : null,
        invoice_paid:         r.invoice_paid         || 'Pending',
        status:               r.status               || 'active',
        notes:                (r.notes || '').substring(0, 500),
      }));
      inserted = await bulkInsert(client, 'cattle_cycles', rows);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[cattle/import/cycles]', err.message);
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }

    res.json({ inserted, skipped: records.length - inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/cattle/import/animals ────────────────────────
   Body: { records: [...] }
   Skips rows whose tag_number already exists.
   Auto-links to cattle_cycles via batch_name.             */
router.post('/import/animals', requireAuth, async (req, res) => {
  try {
    const records = req.body?.records;
    if (!Array.isArray(records) || !records.length)
      return res.json({ inserted: 0, skipped: 0 });

    /* Existing tag numbers for dedup */
    const { rows: existingTags } = await pool.query('SELECT tag_number FROM cattle_animals');
    const existingSet = new Set(existingTags.map(r => String(r.tag_number)));

    /* Cycle lookup: batch_name → id */
    const { rows: cycles } = await pool.query('SELECT id, batch_name FROM cattle_cycles');
    const cycleByName = {};
    cycles.forEach(c => { if (c.batch_name) cycleByName[c.batch_name.toLowerCase()] = c.id; });

    const toInsert = records.filter(r => r.tag_number && !existingSet.has(String(r.tag_number)));
    const skipped  = records.length - toInsert.length;

    if (!toInsert.length) return res.json({ inserted: 0, skipped });

    const client = await pool.connect();
    let inserted = 0;
    try {
      await client.query('BEGIN');
      const rows = toInsert.map(r => {
        const batchName = r.batch_name || '';
        const cycleId   = r.cycle_id || (batchName ? cycleByName[batchName.toLowerCase()] : null) || null;
        const isMort    = r.mortality === true || r.mortality === 'true';
        const isSold    = r.sold === true || r.sold === 'true';
        return {
          id:               genId('CA'),
          tag_number:       String(r.tag_number),
          batch_no:         r.batch_no         || null,
          batch_name:       batchName          || null,
          cycle_id:         cycleId,
          entry_mass:       r.entry_mass != null ? parseFloat(r.entry_mass) || null : null,
          gender:           r.gender            || null,
          breed:            r.breed             || null,
          dim_tag:          r.dim_tag           || null,
          extra_colour_tag: r.extra_colour_tag  || null,
          status:           isMort ? 'mortality' : isSold ? 'sold' : 'active',
          mortality:        isMort,
          mortality_date:   r.mortality_date    || null,
          mortality_report: r.mortality_report  || null,
          sold:             isSold,
          sale_batch:       r.sale_batch        || null,
          sale_date:        r.sale_date         || null,
          notes:            (r.notes || '').substring(0, 500),
        };
      });
      inserted = await bulkInsert(client, 'cattle_animals', rows);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[cattle/import/animals]', err.message);
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }

    res.json({ inserted, skipped: records.length - inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── DELETE /api/cattle/purge ───────────────────────────────
   Truncates cattle_animals and cattle_cycles.
   Requires authenticated director session.               */
router.delete('/purge', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount: animals } = await client.query('DELETE FROM cattle_animals');
    const { rowCount: cycles  } = await client.query('DELETE FROM cattle_cycles');
    await client.query('COMMIT');
    console.log(`[cattle/purge] Deleted ${animals} animal(s) and ${cycles} cycle(s)`);
    res.json({ deleted: { animals, cycles } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[cattle/purge]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
