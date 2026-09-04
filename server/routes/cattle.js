'use strict';
/* ═══════════════════════════════════════════════════════════
   Cattle batch import endpoints
   POST /api/cattle/import/cycles  — bulk upsert cattle_cycles
   POST /api/cattle/import/animals — bulk insert cattle_animals (skip duplicates)
   ═══════════════════════════════════════════════════════════ */
const express     = require('express');
const router      = express.Router();
const pool        = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { reconcileCattle, relinkOrphanAnimals } = require('../services/cattleReconciliation');

/* Everything under /api/cattle is fund books.
 *
 * These endpoints exist to bypass the generic table API's ADMIN_WRITE_TABLES
 * gate so the fund console can write cycles without going through the admin
 * console — but bypassing the gate is not the same as removing it, and that is
 * what had happened. Every route below carried `requireAuth` alone, and
 * requireAuth accepts ANY valid token, including an investor's. That made
 * DELETE /api/cattle/purge — which empties cattle_cycles and cattle_animals —
 * reachable by every logged-in client on the platform.
 *
 * The role list is the same one the generic API applies to these tables, so the
 * two routes to the same rows now agree on who may write them. */
const FUND_ROLES = ['admin', 'director', 'fund_manager'];
const requireFund = [requireAuth, requireRole(...FUND_ROLES)];

/* Helper: generate a short prefixed ID */
const genId = prefix => `${prefix}-${uuidv4().replace(/-/g,'').slice(0,12).toUpperCase()}`;

/* Helper: insert a batch of rows into a table inside a single transaction.
   rows: array of { colName: value } objects.

   Returns { inserted, failures } where `inserted` counts rows that ACTUALLY
   landed. This used to increment a counter once per attempt and swallow every
   per-row error, so the import reported "200 saved" whether 200 rows landed,
   or none did. A row rejected by the database — a malformed date, a value too
   long for its column — vanished silently and the operator was told it had been
   imported. The count now comes from rowCount, which ON CONFLICT DO NOTHING
   reports as 0 for a duplicate, and the errors are returned rather than
   discarded so the console can name the rows that did not make it. */
async function bulkInsert(client, table, rows, labelOf) {
  if (!rows.length) return { inserted: 0, failures: [] };
  const cols = Object.keys(rows[0]);
  const ph   = cols.map((_, i) => `$${i + 1}`).join(', ');
  let inserted = 0;
  const failures = [];
  for (const row of rows) {
    const vals = cols.map(c => row[c]);
    try {
      /* A failed INSERT aborts the surrounding transaction in Postgres, so each
         row gets a SAVEPOINT: one bad row can be rolled back and skipped
         without taking the other 199 in the chunk down with it. Without this
         the first bad row would poison every subsequent statement with
         "current transaction is aborted". */
      await client.query('SAVEPOINT row_sp');
      const { rowCount } = await client.query(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph}) ON CONFLICT DO NOTHING`,
        vals
      );
      await client.query('RELEASE SAVEPOINT row_sp');
      inserted += rowCount;
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT row_sp');
      if (failures.length < 25) failures.push({ row: labelOf ? labelOf(row) : null, error: err.message });
    }
  }
  return { inserted, failures };
}

/* ── GET /api/cattle/herd-summary ───────────────────────────
   Everything the NAV dashboard needs to know about the herd, as aggregates.
   READ ONLY.

   The console used to build these figures in the browser, from the herd. It
   walked cattle_animals through the generic table API a hundred rows at a
   time, sequentially, and then reduced twenty thousand rows to about fifty
   numbers. Measured against a 20 000-head herd on localhost: 210 requests,
   8.7 MB and 4.8 seconds, of which 4.6 was the animals. On a real connection
   the two hundred sequential round trips cost far more than the transfer —
   that is the wait the operator was sitting through, and it grows with every
   animal ever imported because the walk is of the whole table, not of the
   part being valued.

   Not one of those figures needs a row. cycleNAV averages entry_mass and
   exit_mass per cycle and counts how many animals each average rests on; the
   dashboard wants a breed histogram and three totals. All of it is GROUP BY.

   The Animals VIEW is untouched and still pages — it lists individual animals,
   which is the one screen that genuinely needs them, and it already had its
   own server-side stats. */
router.get('/herd-summary', requireFund, async (req, res) => {
  try {
    const [byCycle, totals, breeds] = await Promise.all([
      /* The four numbers cycleNAV reduces the herd to. Sums and counts rather
         than averages so the client can hold the same arithmetic it always
         had — and `*_count` is what tells the dashboard whether a valuation
         rests on real weigh-in slips or on the settings default. */
      pool.query(`
        SELECT cycle_id,
               COUNT(*)::int                                            AS animals,
               COALESCE(SUM(entry_mass) FILTER (WHERE entry_mass > 0), 0)::float8 AS entry_sum,
               COUNT(*) FILTER (WHERE entry_mass > 0)::int              AS entry_count,
               COALESCE(SUM(exit_mass)  FILTER (WHERE exit_mass  > 0), 0)::float8 AS exit_sum,
               COUNT(*) FILTER (WHERE exit_mass  > 0)::int              AS exit_count
          FROM cattle_animals
         WHERE cycle_id IS NOT NULL
         GROUP BY cycle_id`),
      pool.query(`
        SELECT COUNT(*)::int                                                     AS total,
               COUNT(*) FILTER (WHERE status = 'sold'      OR sold = true)::int  AS sold,
               COUNT(*) FILTER (WHERE status = 'mortality' OR mortality = true)::int AS mortalities
          FROM cattle_animals`),
      /* Active only, and only the breeds the dashboard can draw. The chart
         takes the first six; ordering by count here means those six are the
         six largest rather than whichever six sorted first. */
      pool.query(`
        SELECT COALESCE(NULLIF(breed, ''), 'Unknown') AS breed, COUNT(*)::int AS count
          FROM cattle_animals
         WHERE status = 'active'
            OR (COALESCE(sold, false) = false AND COALESCE(mortality, false) = false)
         GROUP BY 1
         ORDER BY count DESC, breed`),
    ]);

    /* Keyed by cycle_id so the client looks a cycle up rather than filtering
       the whole herd once per cycle — that filter was O(cycles × animals) and
       ran again on every re-render. */
    const cycles = {};
    for (const r of byCycle.rows) cycles[r.cycle_id] = r;

    res.set('Cache-Control', 'no-store');
    res.json({ cycles, totals: totals.rows[0], breeds: breeds.rows });
  } catch (err) {
    console.error('[cattle/herd-summary]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ── GET /api/cattle/animals/stats ──────────────────────────
   Returns aggregate stats + distinct batches/breeds for the
   animals filter bar. Accepts the same filter params as the
   table API: search, status, batch_no, breed.             */
router.get('/animals/stats', requireFund, async (req, res) => {
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
        /* Average gain is computed only over animals that have BOTH masses, not
           over the whole herd: averaging entry across everyone and exit across
           the few that have been weighed out would subtract two different
           populations and produce a gain figure belonging to neither. weighed
           says how much of the herd the number actually speaks for. */
        `SELECT
           COUNT(*)::int                                                             AS total,
           COUNT(*) FILTER (WHERE status='sold'      OR sold=true)::int             AS sold,
           COUNT(*) FILTER (WHERE status='mortality' OR mortality=true)::int        AS mortalities,
           ROUND(AVG(entry_mass)::numeric, 1)                                       AS avg_mass,
           ROUND(AVG(exit_mass)  FILTER (WHERE exit_mass IS NOT NULL)::numeric, 1)  AS avg_exit_mass,
           ROUND(AVG(exit_mass - entry_mass)
                 FILTER (WHERE exit_mass IS NOT NULL AND entry_mass IS NOT NULL)::numeric, 1) AS avg_gain,
           COUNT(*) FILTER (WHERE exit_mass IS NOT NULL AND entry_mass IS NOT NULL)::int      AS weighed
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
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ── GET /api/cattle/reconcile ──────────────────────────────
   Cycle headers vs the animals actually on file. READ ONLY. */
router.get('/reconcile', requireFund, async (req, res) => {
  try {
    res.json(await reconcileCattle(pool));
  } catch (err) {
    console.error('[cattle/reconcile]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ── POST /api/cattle/reconcile/relink ──────────────────────
   Restores cycle_id on orphans whose batch name matches exactly one cycle.
   The only write the reconciliation offers, and it moves no numbers — it
   reattaches a record to the batch it already names. */
router.post('/reconcile/relink', requireFund, async (req, res) => {
  try {
    const result = await relinkOrphanAnimals(pool);
    res.json({ ...result, report: await reconcileCattle(pool) });
  } catch (err) {
    console.error('[cattle/reconcile/relink]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ── POST /api/cattle/import/cycles ─────────────────────────
   Body: { records: [...] }
   Skips rows whose batch_name already exists.             */
router.post('/import/cycles', requireFund, async (req, res) => {
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
    let inserted = 0, failures = [];
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
      ({ inserted, failures } = await bulkInsert(client, 'cattle_cycles', rows, r => r.batch_name));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[cattle/import/cycles]', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    } finally {
      client.release();
    }

    /* skipped is a duplicate that was recognised before the insert; failed is a
       row the database refused. Reporting them separately matters: the first is
       expected on a re-import, the second is data that needs fixing. */
    res.json({ inserted, skipped, failed: failures.length, failures });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ── POST /api/cattle/import/animals ────────────────────────
   Body: { records: [...] }
   Skips rows whose tag_number already exists.
   Auto-links to cattle_cycles via batch_name.             */
router.post('/import/animals', requireFund, async (req, res) => {
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
    let inserted = 0, failures = [];
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
          exit_mass:        r.exit_mass  != null ? parseFloat(r.exit_mass)  || null : null,
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
      ({ inserted, failures } = await bulkInsert(client, 'cattle_animals', rows, r => r.tag_number));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[cattle/import/animals]', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    } finally {
      client.release();
    }

    res.json({ inserted, skipped, failed: failures.length, failures });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ── POST /api/cattle/cycles — create a single cycle ────────
   Bypasses ADMIN_WRITE_TABLES so fund portal users can create cycles. */
router.post('/cycles', requireFund, async (req, res) => {
  try {
    const {
      batch_name, company, inv_no, cycle_no, status,
      no_purchased, mortalities, no_live, no_sold,
      purchase_value, total_selling_price, net_return_pct,
      cycle_start_date, sale_date, notes
    } = req.body;

    const id = genId('CC');
    const { rows: [row] } = await pool.query(
      `INSERT INTO cattle_cycles
         (id, batch_name, company, inv_no, cycle_no, status,
          no_purchased, mortalities, no_live, no_sold,
          purchase_value, total_selling_price, net_return_pct,
          cycle_start_date, sale_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [id, batch_name, company, inv_no, cycle_no, status || 'active',
       no_purchased || 0, mortalities || 0, no_live || 0, no_sold || 0,
       purchase_value || 0, total_selling_price || 0, net_return_pct || 0,
       cycle_start_date || null, sale_date || null, notes || null]
    );
    res.json(row);
  } catch (err) {
    console.error('[cattle/cycles POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── PATCH /api/cattle/cycles/:id — update a single cycle ───
   Bypasses ADMIN_WRITE_TABLES so fund portal users can update cycles. */
router.patch('/cycles/:id', requireFund, async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = [
      'batch_name','company','inv_no','cycle_no','status',
      'no_purchased','mortalities','no_live','no_sold',
      'purchase_value','total_selling_price','net_return_pct',
      'cycle_start_date','sale_date','notes'
    ];
    const fields = Object.keys(req.body).filter(k => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: 'No valid fields to update.' });

    const sets   = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = fields.map(f => req.body[f]);
    values.push(id);

    const { rows: [row] } = await pool.query(
      `UPDATE cattle_cycles SET ${sets} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!row) return res.status(404).json({ error: 'Cycle not found.' });
    res.json(row);
  } catch (err) {
    console.error('[cattle/cycles PATCH]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── DELETE /api/cattle/cycles/:id — delete a single cycle ──
   Bypasses ADMIN_WRITE_TABLES so fund portal users can delete cycles. */
router.delete('/cycles/:id', requireFund, async (req, res) => {
  try {
    /* cattle_animals.cycle_id is ON DELETE SET NULL, so deleting a cycle does
       not delete its animals — it quietly unlinks them. The records survive
       with no batch, which is unrecoverable without the original CSV, and the
       operator saw nothing but "Cycle deleted". The count is returned so the
       console can say what is about to be cut loose, and `orphan=1` is the
       caller confirming it read that. */
    const { rows: [{ n }] } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM cattle_animals WHERE cycle_id = $1', [req.params.id]);

    if (n > 0 && req.query.orphan !== '1')
      return res.status(409).json({
        error: 'linked_animals',
        linkedAnimals: n,
        message: `${n} animal record${n === 1 ? '' : 's'} are linked to this cycle. Deleting it unlinks them permanently — they are not deleted, but they lose their batch.`,
      });

    const { rowCount } = await pool.query('DELETE FROM cattle_cycles WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Cycle not found.' });
    res.json({ deleted: true, orphanedAnimals: n });
  } catch (err) {
    console.error('[cattle/cycles DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── DELETE /api/cattle/purge ───────────────────────────────
   Empties cattle_animals and cattle_cycles.

   The comment here used to say "requires authenticated director session" and
   the code said requireAuth — which is any token at all, an investor's
   included. It is now what it always claimed to be, and narrower than the rest
   of this file: admin or director only, never fund_manager.

   It also needs the exact phrase in the body. The console asked "Type OK to
   confirm" over a browser confirm() that has no field to type into, so the
   whole ceremony was one stray Enter key away from emptying the fund's cattle
   books. Nothing about this operation is recoverable from inside the app. */
const PURGE_PHRASE = 'DELETE ALL CATTLE DATA';

router.delete('/purge', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  if (req.body?.confirm !== PURGE_PHRASE)
    return res.status(400).json({
      error: 'confirmation_required',
      message: `Send { "confirm": "${PURGE_PHRASE}" } to proceed.`,
    });

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
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

module.exports = router;
