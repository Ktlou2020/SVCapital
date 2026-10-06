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
    const { pool_id } = req.query;
    const q = pool_id
      ? `SELECT * FROM product_factsheets WHERE pool_id=$1
          ORDER BY is_current DESC, period_date DESC NULLS LAST, created_at DESC`
      : `SELECT * FROM product_factsheets
          ORDER BY pool_id, is_current DESC, period_date DESC NULLS LAST, created_at DESC`;
    const { rows } = await pool.query(q, pool_id ? [pool_id] : []);
    res.json({ data: rows.map(r => ({ ...r, period_label: periodLabel(r.period_date) })) });
  } catch (err) {
    console.error('[factsheets] list failed:', err.message);
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
         (id,pool_id,pool_name,file_name,file_url,file_size,mime_type,version,period_date,uploaded_by,is_current,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,NOW()) RETURNING *`,
      [id, pool_id, pool_name || pr[0].name || null, file_name, file_url,
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
