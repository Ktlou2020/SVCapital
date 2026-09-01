'use strict';
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

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
    const { pool_id } = req.query;
    const q = pool_id
      ? `SELECT * FROM product_factsheets WHERE pool_id=$1
          ORDER BY is_current DESC, period_date DESC NULLS LAST, created_at DESC`
      : `SELECT * FROM product_factsheets
          ORDER BY pool_id, is_current DESC, period_date DESC NULLS LAST, created_at DESC`;
    const { rows } = await pool.query(q, pool_id ? [pool_id] : []);
    res.json({ data: rows.map(r => ({ ...r, period_label: periodLabel(r.period_date) })) });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
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
      'SELECT name, end_date FROM investment_pools WHERE id = $1', [pool_id]);
    if (!pr.length) return res.status(400).json({ error: 'Unknown pool.' });

    const periodDate = monthStart(req.body.period_date) || monthStart(pr[0].end_date);
    const file_name  = String(req.body.file_name || '').trim() || canonicalName(periodDate);
    if (!file_name) {
      return res.status(400).json({
        error: 'A factsheet name is required — this pool has no close date to derive one from.' });
    }
    // Validate by mime_type or data-URL prefix — file_name is a display label, not a filename
    const effectiveMime = mime_type || (typeof file_url === 'string' && file_url.startsWith('data:') ? file_url.split(';')[0].slice(5) : '');
    if (effectiveMime && !['application/pdf', 'application/x-pdf'].includes(effectiveMime)) {
      return res.status(400).json({ error: 'Only PDF files are allowed.' });
    }
    const id = `FS-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    // Mark all previous factsheets for this pool as not current
    await pool.query(`UPDATE product_factsheets SET is_current=false WHERE pool_id=$1`, [pool_id]);
    const { rows } = await pool.query(
      `INSERT INTO product_factsheets
         (id,pool_id,pool_name,file_name,file_url,file_size,mime_type,version,period_date,uploaded_by,is_current,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,NOW()) RETURNING *`,
      [id, pool_id, pool_name || pr[0].name || null, file_name, file_url,
       file_size || null, mime_type || 'application/pdf', version || null,
       periodDate, req.user?.email || null]
    );
    res.json({ success: true, data: { ...rows[0], period_label: periodLabel(rows[0].period_date) } });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
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
