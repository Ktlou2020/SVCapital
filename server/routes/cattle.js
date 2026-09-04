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
               COUNT(*) FILTER (WHERE exit_mass  > 0)::int              AS exit_count,
               /* What the animals in this batch have actually fetched, where
                  they were sold one at a time with a price recorded. It is what
                  the bulk mark-sold dialog offers as the batch's sale value —
                  a figure taken from the sales rather than typed over them. */
               COALESCE(SUM(sale_value), 0)::float8                     AS sale_sum,
               COUNT(*) FILTER (WHERE sale_value IS NOT NULL)::int      AS sale_count
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

      /* The cycles these animals landed in now hold more head than their
         header says. Recomputed here, or the batch reads "0 purchased" beside
         129 animals — which is what several batches on this book already look
         like, and why nothing valued them.

         no_purchased is raised to the animals on file rather than overwritten:
         it is the fund's own figure from the invoice, and an import that only
         carries part of a batch must not shrink it. live/dead/sold are derived
         and are simply recomputed. Open cycles only — a sold or discontinued
         batch is a closed record. */
      const touched = [...new Set(rows.map(r => r.cycle_id).filter(Boolean))];
      if (touched.length) {
        await client.query(`
          UPDATE cattle_cycles c
             SET no_purchased = GREATEST(COALESCE(c.no_purchased, 0), s.total),
                 no_live      = s.live,
                 mortalities  = s.dead,
                 no_sold      = s.sold,
                 updated_at   = NOW()
            FROM (SELECT cycle_id,
                         COUNT(*)::int                                                  AS total,
                         COUNT(*) FILTER (WHERE COALESCE(sold,false) = false
                                            AND COALESCE(mortality,false) = false)::int AS live,
                         COUNT(*) FILTER (WHERE COALESCE(mortality,false))::int         AS dead,
                         COUNT(*) FILTER (WHERE COALESCE(sold,false))::int              AS sold
                    FROM cattle_animals
                   WHERE cycle_id = ANY($1::text[])
                   GROUP BY cycle_id) s
           WHERE c.id = s.cycle_id
             AND c.status NOT IN ('sold','discontinued')`, [touched]);
      }
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

/* ── GET /api/cattle/cycles/:id/animals ─────────────────────
   The animals in one batch, for the cycle detail panel. READ ONLY.

   Scoped to the cycle and paged. The detail panel used to read whatever was in
   S.animals — the animals TABLE's current page, 75 rows of whatever filter was
   last applied — so it listed animals from other batches, or none, and valued
   the cycle off them. */
router.get('/cycles/:id/animals', requireFund, async (req, res) => {
  try {
    const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit) || 200));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT id, tag_number, breed, gender, entry_mass, exit_mass,
                status, sold, mortality, mortality_date, sale_date, sale_batch, sale_value
           FROM cattle_animals
          WHERE cycle_id = $1
          ORDER BY tag_number NULLS LAST, id
          LIMIT $2 OFFSET $3`, [req.params.id, limit, offset]),
      pool.query('SELECT COUNT(*)::int AS n FROM cattle_animals WHERE cycle_id = $1', [req.params.id]),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ data: rows.rows, total: count.rows[0].n, limit, offset });
  } catch (err) {
    console.error('[cattle/cycle-animals]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ── PATCH /api/cattle/animals/:id ──────────────────────────
   Mark one animal sold, deceased, or back to active.

   `sold` and `mortality` are separate booleans as well as a `status` string,
   and they have disagreed: an animal could carry sold = true and
   status = 'mortality' at once, and which one the console believed depended on
   which screen was reading it. Every write here sets all three together, so
   they cannot drift.

   A sale value belongs to a sold animal. Marking one deceased clears it —
   money it did not fetch has no business staying on the record, and it would
   otherwise be summed into the cycle's sale total. */
router.patch('/animals/:id', requireFund, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!['sold', 'mortality', 'active'].includes(status))
      return res.status(400).json({ error: "status must be 'sold', 'mortality' or 'active'." });

    let sale = null;
    if (status === 'sold' && req.body.sale_value !== undefined && req.body.sale_value !== null && req.body.sale_value !== '') {
      sale = Number(req.body.sale_value);
      if (!isFinite(sale) || sale < 0) return res.status(400).json({ error: 'sale_value must be a positive number.' });
    }

    /* An exit mass, when one is supplied, is what the animal actually weighed —
       and cycleNAV prefers it over the growth model for the whole cycle. */
    let exitMass = null;
    if (req.body.exit_mass !== undefined && req.body.exit_mass !== null && req.body.exit_mass !== '') {
      exitMass = Number(req.body.exit_mass);
      if (!isFinite(exitMass) || exitMass <= 0) return res.status(400).json({ error: 'exit_mass must be a positive number.' });
    }

    /* Built as (fragment, params) together rather than as a template with a
       conditional tail. The first version counted $-placeholders by hand and
       got them out of step the moment exit_mass was optional — which is the
       kind of bug that writes a date into a numeric column. */
    const sets = [];
    const params = [id];
    const P = v => { params.push(v); return `$${params.length}`; };

    if (status === 'sold') {
      sets.push(`status = 'sold'`, `sold = true`, `mortality = false`, `mortality_date = NULL`);
      sets.push(`sale_date = COALESCE(${P(req.body.date || null)}::date, CURRENT_DATE)`);
      sets.push(`sale_value = ${P(sale)}`);
      sets.push(`sale_batch = COALESCE(sale_batch, 'MANUAL')`);
    } else if (status === 'mortality') {
      sets.push(`status = 'mortality'`, `sold = false`, `mortality = true`);
      sets.push(`mortality_date = COALESCE(${P(req.body.date || null)}::date, CURRENT_DATE)`);
      sets.push(`sale_date = NULL`, `sale_value = NULL`, `sale_batch = NULL`);
    } else {
      sets.push(`status = 'active'`, `sold = false`, `mortality = false`);
      sets.push(`sale_date = NULL`, `mortality_date = NULL`, `sale_value = NULL`, `sale_batch = NULL`);
    }
    if (exitMass !== null) sets.push(`exit_mass = ${P(exitMass)}`);
    sets.push('updated_at = NOW()');

    const { rows: [row] } = await pool.query(
      `UPDATE cattle_animals SET ${sets.join(', ')}
        WHERE id = $1
       RETURNING id, cycle_id, tag_number, status, sold, mortality, sale_date,
                 mortality_date, sale_value, exit_mass`,
      params
    );
    if (!row) return res.status(404).json({ error: 'Animal not found.' });

    /* The cycle's headline counts are derived from its animals, so they are
       recomputed here rather than left for someone to notice. Only for a cycle
       still open: a sold or discontinued cycle is a closed record and must not
       start moving because one animal was corrected. */
    let cycle = null;
    if (row.cycle_id) {
      const { rows: [c] } = await pool.query(
        `UPDATE cattle_cycles c
            SET no_live     = s.live,
                mortalities = s.dead,
                no_sold     = s.sold,
                updated_at  = NOW()
           FROM (SELECT
                   COUNT(*) FILTER (WHERE COALESCE(sold,false) = false
                                      AND COALESCE(mortality,false) = false)::int AS live,
                   COUNT(*) FILTER (WHERE COALESCE(mortality,false) = true)::int  AS dead,
                   COUNT(*) FILTER (WHERE COALESCE(sold,false) = true)::int       AS sold
                   FROM cattle_animals WHERE cycle_id = $1) s
          WHERE c.id = $1 AND c.status NOT IN ('sold','discontinued')
        RETURNING c.id, c.no_live, c.mortalities, c.no_sold`, [row.cycle_id]);
      cycle = c || null;
    }

    res.json({ success: true, animal: row, cycle });
  } catch (err) {
    console.error('[cattle/animals PATCH]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/cattle/cycles/bulk-status ────────────────────
   Mark many cycles sold, discontinue them, or reopen a discontinued one.

   SOLD carries a sale value per cycle, and the route will not accept the
   action without one. A sold cycle shows total_selling_price as its realised
   value and (sale − purchase) ÷ purchase as its realised return, so a cycle
   marked sold at nothing books its entire purchase value as a loss — on a book
   of 138 cycles and R110m that is a nine-figure hole in the fund's reported
   return, produced by two clicks and no typing. The figure is required here
   rather than defaulted so that cannot happen quietly.

   DISCONTINUED takes no value. It freezes a cycle where it stands and marks
   its animals sold, for batches that will never be closed out properly — the
   stale imports sitting at a thousand-plus days in cycle, still accruing
   1.2kg a day of modelled weight gain against nothing. It leaves the book
   entirely: cycleNAV is not asked for a valuation, and portfolioNAV counts it
   in neither the active herd nor realised returns. It keeps its recorded
   numbers for the record and contributes nothing.

   REOPEN undoes a discontinue. The animals it flagged carry sale_batch
   'DISC-<cycle id>', so reopening releases exactly those and leaves an animal
   that was genuinely sold — by an import, or by a real sale — flagged. Without
   that tag, reopening would resurrect every sold animal in the batch.

   One transaction: a bulk action that half-applied would leave cycles and
   animals disagreeing about what was sold, and nothing on the screen would
   say which half landed. */
router.post('/cycles/bulk-status', requireFund, async (req, res) => {
  const { action } = req.body || {};
  const cycles = Array.isArray(req.body && req.body.cycles) ? req.body.cycles : [];

  if (!['sold', 'discontinued', 'reopen'].includes(action))
    return res.status(400).json({ error: "action must be 'sold', 'discontinued' or 'reopen'." });
  if (!cycles.length) return res.status(400).json({ error: 'No cycles selected.' });
  if (cycles.length > 500) return res.status(400).json({ error: 'Too many cycles in one request (max 500).' });

  const ids = cycles.map(c => (c && typeof c === 'object' ? c.id : c)).filter(Boolean);
  if (ids.length !== cycles.length) return res.status(400).json({ error: 'Every entry needs an id.' });

  /* Validated before the transaction opens, so a missing figure is a 400 that
     changed nothing rather than a rollback. */
  const saleById = {};
  if (action === 'sold') {
    const missing = [];
    for (const c of cycles) {
      const v = Number(c.total_selling_price);
      if (!isFinite(v) || v < 0) { missing.push(c.id); continue; }
      saleById[c.id] = v;
    }
    if (missing.length)
      return res.status(400).json({
        error: 'sale_value_required',
        cycles: missing,
        message: `${missing.length} selected cycle${missing.length === 1 ? '' : 's'} ha${missing.length === 1 ? 's' : 've'} no sale value. A cycle marked sold at nothing reports its whole purchase value as a realised loss.`,
      });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: found } = await client.query(
      'SELECT * FROM cattle_cycles WHERE id = ANY($1::text[]) FOR UPDATE', [ids]);
    const byId = {};
    for (const r of found) byId[r.id] = r;
    const notFound = ids.filter(i => !byId[i]);
    if (notFound.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Some cycles no longer exist.', cycles: notFound });
    }

    let cyclesChanged = 0, animalsChanged = 0;
    const skipped = [];

    for (const id of ids) {
      const cycle = byId[id];

      if (action === 'reopen') {
        if (cycle.status !== 'discontinued') { skipped.push({ id, why: 'not discontinued' }); continue; }
        const { rowCount: a } = await client.query(
          `UPDATE cattle_animals
              SET sold = false, status = 'active', sale_date = NULL, sale_batch = NULL, updated_at = NOW()
            WHERE cycle_id = $1 AND sale_batch = $2`, [id, `DISC-${id}`]);
        const { rowCount: c } = await client.query(
          `UPDATE cattle_cycles SET status = 'active', updated_at = NOW() WHERE id = $1`, [id]);
        cyclesChanged += c; animalsChanged += a;
        continue;
      }

      if (action === 'discontinued') {
        if (cycle.status === 'discontinued') { skipped.push({ id, why: 'already discontinued' }); continue; }
        /* Only animals still live. One already flagged sold keeps whatever
           sale_batch it had, so a later reopen does not claim it. */
        const { rowCount: a } = await client.query(
          `UPDATE cattle_animals
              SET sold = true, status = 'sold', sale_date = NOW(), sale_batch = $2, updated_at = NOW()
            WHERE cycle_id = $1
              AND COALESCE(sold, false) = false
              AND COALESCE(status, 'active') <> 'mortality'
              AND COALESCE(mortality, false) = false`, [id, `DISC-${id}`]);
        /* The cycle's own figures are left exactly as they are — that is what
           freezing means. Only the status moves. */
        const { rowCount: c } = await client.query(
          `UPDATE cattle_cycles SET status = 'discontinued', updated_at = NOW() WHERE id = $1`, [id]);
        cyclesChanged += c; animalsChanged += a;
        continue;
      }

      /* sold */
      if (cycle.status === 'sold') { skipped.push({ id, why: 'already sold' }); continue; }
      const sale     = saleById[id];
      const purchase = parseFloat(cycle.purchase_value) || 0;
      /* Gross of the standing fee, and the console says so beside the field as
         it is typed. net_return_pct is otherwise an imported column the fund
         supplies; this route only ever writes it for a sale it is recording. */
      const netPct = purchase > 0 ? ((sale - purchase) / purchase) * 100 : null;
      const live   = parseInt(cycle.no_live) || 0;

      const { rowCount: a } = await client.query(
        `UPDATE cattle_animals
            SET sold = true, status = 'sold', sale_date = NOW(), sale_batch = $2, updated_at = NOW()
          WHERE cycle_id = $1
            AND COALESCE(sold, false) = false
            AND COALESCE(status, 'active') <> 'mortality'
            AND COALESCE(mortality, false) = false`, [id, `SOLD-${id}`]);
      const { rowCount: c } = await client.query(
        `UPDATE cattle_cycles
            SET status = 'sold',
                total_selling_price = $2,
                net_return_pct = $3,
                sale_date = COALESCE(sale_date, NOW()),
                no_sold = COALESCE(NULLIF(no_sold, 0), $4),
                no_live = 0,
                updated_at = NOW()
          WHERE id = $1`, [id, sale, netPct, live]);
      cyclesChanged += c; animalsChanged += a;
    }

    await client.query('COMMIT');
    res.json({ success: true, action, cyclesChanged, animalsChanged, skipped });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[cattle/bulk-status]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
