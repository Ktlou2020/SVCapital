'use strict';
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateStoredFile } = require('../services/uploadedFile');
const audit  = require('../services/audit');

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

/* The month a factsheet reports on, and the name that follows from it.
 *
 * Both used to be one thing: a free-text label an admin typed. The portal then
 * read the month back out of that text to order the archive, so a sheet named
 * any other way had no place in the order, and two admins with two habits
 * produced a list that could not be sorted at all. The month is now a column,
 * taken from the pool the sheet belongs to — a sheet reports on its pool's
 * month, and the pool's dates cannot be mistyped into the wrong shape. */
function monthStart(d) {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  if (isNaN(t)) return null;
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function periodLabel(periodDate) {
  const t = periodDate ? new Date(periodDate) : null;
  if (!t || isNaN(t)) return null;
  return `${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

/* The house naming convention, in one place. Applied when an admin does not
   supply a name of their own; a deliberate name for something that is not a
   monthly sheet ("Herd health notes") is left exactly as typed. */
function canonicalName(periodDate) {
  const label = periodLabel(periodDate);
  return label ? `${label} - Factsheet` : null;
}

/* GET /api/factsheets?pool_id=X — list factsheets (current first, then history)
   Ordered by the period the sheet reports on. NULLS LAST rather than first:
   a sheet with no period is an oddity in an otherwise monthly archive, and
   sorting the oddity to the top is how the portal came to lead with a
   document nobody was looking for. */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { pool_id, product_type } = req.query;
    /* product_type is the one that answers "show me this product's archive".
       A factsheet belongs to the PRODUCT; the pool it was uploaded against is
       just where it came in, and that pool may since have been merged away or
       deleted — in which case pool_id is null and only the product can find
       it. Asking by pool alone is how a sheet became invisible. */
    let q, params;
    if (product_type) {
      q = `SELECT f.*, ip.product_type AS pool_product_type
             FROM product_factsheets f
             LEFT JOIN investment_pools ip ON ip.id = f.pool_id
            WHERE COALESCE(f.product_type, ip.product_type) = $1
            ORDER BY f.is_current DESC, f.period_date DESC NULLS LAST, f.created_at DESC`;
      params = [product_type];
    } else if (pool_id) {
      q = `SELECT * FROM product_factsheets WHERE pool_id=$1
            ORDER BY is_current DESC, period_date DESC NULLS LAST, created_at DESC`;
      params = [pool_id];
    } else {
      q = `SELECT f.*, ip.product_type AS pool_product_type
             FROM product_factsheets f
             LEFT JOIN investment_pools ip ON ip.id = f.pool_id
            ORDER BY f.pool_id, f.is_current DESC, f.period_date DESC NULLS LAST, f.created_at DESC`;
      params = [];
    }
    const { rows } = await pool.query(q, params);
    res.json({ data: rows.map(r => ({
      ...r,
      /* So a reader never has to join back to the pool to know the product. */
      product_type: r.product_type || r.pool_product_type || null,
      period_label: periodLabel(r.period_date),
    })) });
  } catch (err) {
    console.error('[factsheets] list failed:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* GET /api/factsheets/coverage — what survived, and which months are missing.
 *
 * Factsheets used to die with their pool: the key cascaded, so deleting a pool
 * — or merging one, which deletes the source — destroyed its published
 * documents without a word. That is fixed, but it cannot be undone, and the
 * gaps it left are invisible precisely because the rows are gone.
 *
 * So this reports, per product, the months a sheet exists for against the
 * months the product actually ran, and names the difference. A missing month
 * here is a month to re-upload.
 */
router.get('/coverage', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { rows: sheets } = await pool.query(`
      SELECT COALESCE(f.product_type, ip.product_type) AS product_type,
             to_char(f.period_date, 'YYYY-MM') AS month,
             COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE f.pool_id IS NULL)::int AS orphaned
        FROM product_factsheets f
        LEFT JOIN investment_pools ip ON ip.id = f.pool_id
       GROUP BY 1, 2`);

    /* The months a product ran, from its pools. A product with no pools has
       nothing to be missing. */
    const { rows: months } = await pool.query(`
      SELECT product_type, to_char(d, 'YYYY-MM') AS month
        FROM investment_pools ip,
             LATERAL generate_series(
               date_trunc('month', COALESCE(ip.start_date, ip.created_at::date)),
               date_trunc('month', COALESCE(ip.end_date, ip.start_date, ip.created_at::date)),
               INTERVAL '1 month') d
       WHERE ip.product_type IS NOT NULL
       GROUP BY 1, 2`);

    const { rows: products } = await pool.query(
      `SELECT product_type, label FROM products WHERE COALESCE(is_active, true)`);
    const labelOf = Object.fromEntries(products.map(p => [p.product_type, p.label]));

    const byProduct = {};
    const touch = pt => (byProduct[pt] = byProduct[pt] || {
      productType: pt, label: labelOf[pt] || pt,
      have: [], expected: new Set(), orphaned: 0, undated: 0, total: 0,
    });
    for (const r of months) touch(r.product_type).expected.add(r.month);
    for (const r of sheets) {
      if (!r.product_type) continue;
      const p = touch(r.product_type);
      p.total += r.n;
      p.orphaned += r.orphaned;
      if (r.month) p.have.push(r.month); else p.undated += r.n;
    }

    const out = Object.values(byProduct).map(p => {
      const have = new Set(p.have);
      /* Only months in the past are "missing" — a month that has not happened
         has no sheet to be missing. */
      const now = new Date().toISOString().slice(0, 7);
      const missing = [...p.expected].filter(m => !have.has(m) && m <= now).sort();
      return {
        productType: p.productType, label: p.label,
        total: p.total, months: [...have].sort().reverse(),
        missing, missingCount: missing.length,
        orphaned: p.orphaned, undated: p.undated,
        /* An orphan is a sheet whose pool was deleted. It still shows on the
           product, which is the point of the fix, but it is worth naming. */
      };
    }).sort((a, b) => {
      /* A product that has sheets AND gaps is where a document was lost, which
         is what this report is for. A product with no sheets at all has never
         had any — that is a backlog, not a loss, and it sorts below. */
      const aLost = a.total > 0 && a.missingCount > 0;
      const bLost = b.total > 0 && b.missingCount > 0;
      if (aLost !== bLost) return aLost ? -1 : 1;
      if (a.total !== b.total && (a.total === 0 || b.total === 0)) return b.total - a.total;
      return b.missingCount - a.missingCount || a.label.localeCompare(b.label);
    });

    return res.json({ products: out, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[factsheets] coverage', err.message);
    return res.status(500).json({ error: 'Could not build the coverage report.' });
  }
});

/* POST /api/factsheets/upload — upload/link a new factsheet for a product */
router.post('/upload', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { pool_id, pool_name, file_url, file_size, mime_type, version } = req.body;
    if (!pool_id || !file_url) {
      return res.status(400).json({ error: 'pool_id and file_url are required' });
    }

    /* Period, then name. An explicit period wins; otherwise it comes from the
       pool's close month. The name is only generated when the admin left it
       blank — which the console no longer does, because it pre-fills the same
       convention and shows it before the upload. */
    const { rows: pr } = await pool.query(
      'SELECT name, end_date, product_type FROM investment_pools WHERE id = $1', [pool_id]);
    if (!pr.length) return res.status(400).json({ error: 'Unknown pool.' });

    const periodDate = monthStart(req.body.period_date) || monthStart(pr[0].end_date);
    const file_name  = String(req.body.file_name || '').trim() || canonicalName(periodDate);
    if (!file_name) {
      return res.status(400).json({
        error: 'A factsheet name is required — this pool has no close date to derive one from.' });
    }
    /* Validated on the BYTES, not on what the caller says they are.

       This used to read `if (effectiveMime && …)`, deriving the mime from
       req.body.mime_type or from the data: prefix. Both were the caller's
       word: a body with no mime_type and a file_url that did not begin
       `data:` produced an empty string, which is falsy, so the whole check
       was skipped — and where a mime WAS present, claiming application/pdf
       beside a text/html payload passed. A stored text/html document opened
       from the portal runs its script as this platform, because a blob URL
       inherits the origin that built it. */
    const checked = validateStoredFile(file_url, {
      allow: ['application/pdf'],
      maxBytes: 2 * 1024 * 1024,      // the /api body limit is 2mb
    });
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    const id = `FS-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    // Mark all previous factsheets for this pool as not current
    await pool.query(`UPDATE product_factsheets SET is_current=false WHERE pool_id=$1`, [pool_id]);
    const { rows } = await pool.query(
      `INSERT INTO product_factsheets
         (id,pool_id,product_type,pool_name,file_name,file_url,file_size,mime_type,version,period_date,uploaded_by,is_current,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,NOW()) RETURNING *`,
      /* The product is recorded at upload, so the sheet stays findable if the
         pool is later merged away or deleted. */
      [id, pool_id, pr[0].product_type || null, pool_name || pr[0].name || null, file_name, file_url,
       /* The sniffed type, never the submitted one — the column is what a
          later reader trusts. A remote link has no bytes to sniff. */
       checked.size || file_size || null, checked.mime || 'application/pdf', version || null,
       periodDate, req.user?.email || null]
    );
    res.json({ success: true, data: { ...rows[0], period_label: periodLabel(rows[0].period_date) } });
  } catch (err) {
    /* This answered 500 and logged nothing, so an upload that failed left no
       trace to work from — the console just said "Upload failed". */
    console.error('[factsheets] upload failed:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* PATCH /api/factsheets/:id — correct the period, the name or the version.
 *
 * The period was write-once: it could only be set on upload, so a sheet filed
 * under the wrong month could not be corrected without deleting it and
 * uploading the file again. Worse, the upload form carries a period field, so
 * changing it there and pressing the button looked like an edit and was not —
 * it either did nothing or, with a file attached, made a second copy.
 *
 * The FILE is never touched. The bytes behind an id must stay the bytes
 * somebody read under that id; a replacement is a new upload, which is what
 * the upload route is for.
 */
router.patch('/:id', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { rows: [existing] } = await pool.query(
      'SELECT id, pool_id, period_date, file_name FROM product_factsheets WHERE id = $1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Factsheet not found.' });

    const sets = [], vals = [];
    const put = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    let newPeriod = existing.period_date;
    if (req.body.period_date !== undefined) {
      /* Blank clears it — a document that is not a monthly sheet has no
         period, and the list sorts those last on purpose. */
      if (req.body.period_date === null || req.body.period_date === '') {
        newPeriod = null; put('period_date', null);
      } else {
        const m = monthStart(req.body.period_date);
        if (!m) return res.status(400).json({ error: 'period_date must be a date, as YYYY-MM-DD.' });
        newPeriod = m; put('period_date', m);
      }
    }

    if (req.body.file_name !== undefined) {
      const name = String(req.body.file_name || '').trim();
      if (!name) return res.status(400).json({ error: 'Give the factsheet a name.' });
      put('file_name', name);
    } else if (req.body.period_date !== undefined) {
      /* The name was filled in from the old period. If it still carries the
         house pattern, move it with the period rather than leaving "April
         2026 - Factsheet" filed under September. A name somebody chose
         deliberately is left exactly as typed. */
      const wasCanonical = existing.file_name === canonicalName(existing.period_date);
      const next = canonicalName(newPeriod);
      if (wasCanonical && next) put('file_name', next);
    }

    if (req.body.version !== undefined) {
      put('version', String(req.body.version || '').trim() || null);
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });

    const { rows } = await pool.query(
      `UPDATE product_factsheets SET ${sets.join(', ')} WHERE id = $${vals.length + 1} RETURNING *`,
      [...vals, req.params.id]);

    audit.log({
      action:      'factsheet.update',
      actorId:     req.user.empId || req.user.id || null,
      actorEmail:  req.user.email || null,
      actorRole:   req.user.role || null,
      entityType:  'product_factsheets',
      entityId:    req.params.id,
      description: `Changed factsheet ${req.params.id}: ` + sets.join(', '),
      ip:          req.ip || null,
    }).catch(() => {});

    return res.json({ success: true, data: { ...rows[0], period_label: periodLabel(rows[0].period_date) } });
  } catch (err) {
    console.error('[factsheets] patch', err.message);
    return res.status(500).json({ error: 'Could not update that factsheet.' });
  }
});

/* DELETE /api/factsheets/:id */
router.delete('/:id', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM product_factsheets WHERE id=$1 RETURNING *`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const deleted = rows[0];
    if (deleted.is_current) {
      await pool.query(
        `UPDATE product_factsheets SET is_current=true
         WHERE id=(SELECT id FROM product_factsheets WHERE pool_id=$1 ORDER BY created_at DESC LIMIT 1)`,
        [deleted.pool_id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
