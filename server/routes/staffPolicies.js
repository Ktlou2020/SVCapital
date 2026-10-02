'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Company policies. Written by the directors, read by everyone on staff.

   Two guards, deliberately different:

     READING   any authenticated person with a STAFF identity. Not a role
               check — a role check would have to list every role a new hire
               might carry and would silently exclude whoever was forgotten.
               req.user.empId is what distinguishes staff from an investor,
               and it is the same test the generic table router uses.

     WRITING   admin or director, the pairing every other authoring surface
               on this platform uses.

   The file is validated from its BYTES, never from what the uploader says it
   is, and served back from its own endpoint as real bytes rather than as a
   data: URL — Chrome has refused to navigate to one of those since 2017 and
   the platform's CSP refuses to frame one, which is exactly what made
   factsheets open blank.
   ═══════════════════════════════════════════════════════════════════ */

const router = require('express').Router();
const pool   = require('../db/pool');
const audit  = require('../services/audit');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateStoredFile, parseDataUrl } = require('../services/uploadedFile');

/* What a policy may be. A policy is something people read, so the list is
   documents and pictures of documents — never anything a browser executes. */
const ALLOWED = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 12 * 1024 * 1024;

const CATEGORIES = ['hr', 'compliance', 'finance', 'operations', 'it', 'health_safety', 'general'];

/* Everyone on staff can read. An investor's token carries no empId. */
function requireStaff(req, res, next) {
  if (!req.user || !req.user.empId) {
    return res.status(403).json({ error: 'Staff access only.' });
  }
  next();
}

const requireAuthor = [requireAuth, requireRole('admin', 'director')];

/* ─── GET /api/staff-policies ─────────────────────────────────────────
   The shelf. Metadata only: file_data is megabytes per row and nobody
   listing policies needs the bytes of all of them. */
router.get('/', requireAuth, requireStaff, async (req, res) => {
  try {
    const all = String(req.query.include_superseded || '') === 'true';
    /* acknowledged is for the person asking, not a count for everyone — the
       shelf has to be able to say "you still owe this one". */
    const { rows } = await pool.query(`
      SELECT p.id, p.title, p.category, p.summary, p.filename, p.mimetype, p.file_size,
             p.version, p.effective_date, p.supersedes_id, p.uploaded_by_name,
             p.is_active, p.requires_ack, p.created_at, p.updated_at,
             s.title AS supersedes_title,
             r.id    AS superseded_by_id, r.title AS superseded_by_title,
             a.acknowledged_at,
             (SELECT COUNT(*)::int FROM staff_policy_acks x WHERE x.policy_id = p.id) AS ack_count
        FROM staff_policies p
        LEFT JOIN staff_policies s ON s.id = p.supersedes_id
        LEFT JOIN staff_policies r ON r.supersedes_id = p.id AND r.is_active
        LEFT JOIN staff_policy_acks a ON a.policy_id = p.id AND a.employee_id = $1
       ${all ? '' : 'WHERE p.is_active'}
       ORDER BY p.category, COALESCE(p.effective_date, p.created_at::date) DESC, p.title`,
      [req.user.empId]);
    const outstanding = rows.filter(r => r.is_active && r.requires_ack && !r.acknowledged_at).length;
    return res.json({ categories: CATEGORIES, outstanding, policies: rows });
  } catch (err) {
    console.error('[staff-policies] list', err.message);
    return res.status(500).json({ error: 'Could not load the policies.' });
  }
});

/* ─── GET /api/staff-policies/:id/file ────────────────────────────────
   The document itself, as bytes. Content-Disposition inline so a PDF opens
   in the viewer rather than landing in Downloads, and the filename is
   quoted so a policy called "Leave Policy v2.pdf" survives the trip. */
router.get('/:id/file', requireAuth, requireStaff, async (req, res) => {
  try {
    const { rows: [p] } = await pool.query(
      'SELECT filename, mimetype, file_data FROM staff_policies WHERE id = $1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Policy not found.' });

    if (/^https?:\/\//i.test(p.file_data)) return res.redirect(p.file_data);

    const parsed = parseDataUrl(p.file_data);
    if (!parsed) return res.status(422).json({ error: 'That policy file is not readable.' });

    res.setHeader('Content-Type', p.mimetype || parsed.mime || 'application/octet-stream');
    res.setHeader('Content-Length', parsed.bytes.length);
    res.setHeader('Content-Disposition',
      `inline; filename="${String(p.filename || 'policy').replace(/[^\w.\- ]/g, '_')}"`);
    /* A policy changes when it is replaced, and a replacement is a new row
       with a new id, so the bytes behind one id never change. */
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.send(parsed.bytes);
  } catch (err) {
    console.error('[staff-policies] file', err.message);
    return res.status(500).json({ error: 'Could not open that policy.' });
  }
});

/* ─── POST /api/staff-policies/:id/acknowledge ────────────────────────
   "I have read this." One row per person per policy — and because a policy is
   replaced rather than edited, that is one per VERSION, which is the only
   reading of "has read the policy" worth recording.

   Idempotent: pressing it twice is pressing it once, and the FIRST time is
   the one kept. A later press must not quietly move the date somebody was
   relying on.
   ──────────────────────────────────────────────────────────────────── */
router.post('/:id/acknowledge', requireAuth, requireStaff, async (req, res) => {
  try {
    const { rows: [p] } = await pool.query(
      'SELECT id, title, is_active, requires_ack FROM staff_policies WHERE id = $1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Policy not found.' });
    if (!p.is_active) return res.status(409).json({ error: 'That policy has been withdrawn.' });
    if (!p.requires_ack) return res.status(400).json({ error: 'That policy does not need acknowledging.' });

    const name = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') || req.user?.email || null;
    const { rows: [ack] } = await pool.query(`
      INSERT INTO staff_policy_acks (policy_id, employee_id, employee_name, employee_email, ip_address)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (policy_id, employee_id) DO NOTHING
      RETURNING acknowledged_at`,
      [p.id, req.user.empId, name, req.user?.email || null, req.ip || null]);

    /* DO NOTHING returns no row when it was already there, so the existing
       date is read back rather than invented. */
    const when = ack ? ack.acknowledged_at : (await pool.query(
      'SELECT acknowledged_at FROM staff_policy_acks WHERE policy_id = $1 AND employee_id = $2',
      [p.id, req.user.empId])).rows[0]?.acknowledged_at;

    return res.json({ ok: true, policy_id: p.id, acknowledged_at: when, already: !ack });
  } catch (err) {
    console.error('[staff-policies] acknowledge', err.message);
    return res.status(500).json({ error: 'Could not record that.' });
  }
});

/* ─── GET /api/staff-policies/:id/acknowledgements ────────────────────
   Who has read it, and — the half that matters — who has not.

   The outstanding list is every ACTIVE employee without a row, computed here
   rather than left to the reader to work out from a list of names. A report
   that only says who has read it answers the easy question.
   ──────────────────────────────────────────────────────────────────── */
router.get('/:id/acknowledgements', requireAuthor, async (req, res) => {
  try {
    const { rows: [p] } = await pool.query(
      'SELECT id, title, version, requires_ack FROM staff_policies WHERE id = $1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Policy not found.' });

    const { rows: read } = await pool.query(`
      SELECT employee_id, employee_name, employee_email, acknowledged_at
        FROM staff_policy_acks WHERE policy_id = $1
       ORDER BY acknowledged_at`, [p.id]);

    const { rows: outstanding } = await pool.query(`
      SELECT e.id, e.first_name, e.last_name, e.email, e.role
        FROM employees e
       WHERE COALESCE(e.status, 'active') = 'active'
         AND NOT EXISTS (SELECT 1 FROM staff_policy_acks a
                          WHERE a.policy_id = $1 AND a.employee_id = e.id)
       ORDER BY e.first_name, e.last_name`, [p.id]);

    return res.json({
      policy: p,
      read, outstanding,
      readCount: read.length, outstandingCount: outstanding.length,
    });
  } catch (err) {
    console.error('[staff-policies] acknowledgements', err.message);
    return res.status(500).json({ error: 'Could not load that.' });
  }
});

/* ─── POST /api/staff-policies ────────────────────────────────────────
   Upload. Directors and admins only. */
router.post('/', requireAuthor, async (req, res) => {
  try {
    const { title, category, summary, filename, file_data, version, effective_date, supersedes_id } = req.body || {};
    const requiresAck = req.body.requires_ack === undefined ? true : !!req.body.requires_ack;
    if (!String(title || '').trim())     return res.status(400).json({ error: 'Give the policy a title.' });
    if (!String(filename || '').trim())  return res.status(400).json({ error: 'The file needs a name.' });

    const cat = CATEGORIES.includes(String(category || '').trim()) ? String(category).trim() : 'general';

    /* From the bytes. A file claiming to be a PDF that does not begin %PDF-
       is refused, whichever field it arrived in. */
    const check = validateStoredFile(file_data, { allow: ALLOWED, maxBytes: MAX_BYTES });
    if (!check.ok) return res.status(400).json({ error: check.error });

    if (supersedes_id) {
      const { rows: [prev] } = await pool.query('SELECT id FROM staff_policies WHERE id = $1', [supersedes_id]);
      if (!prev) return res.status(400).json({ error: 'The policy it replaces could not be found.' });
    }

    const id = 'POL-' + Date.now().toString(36).toUpperCase() + '-' +
               Math.random().toString(36).slice(2, 7).toUpperCase();
    const actorName = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') ||
                      req.user?.email || 'A director';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO staff_policies
          (id, title, category, summary, filename, mimetype, file_size, file_data,
           version, effective_date, supersedes_id, uploaded_by, uploaded_by_name, requires_ack)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, String(title).trim(), cat, String(summary || '').trim() || null,
         String(filename).trim(), check.mime || 'application/octet-stream', check.size || null,
         String(file_data), String(version || '').trim() || null,
         effective_date || null, supersedes_id || null,
         req.user?.empId || req.user?.id || null, actorName, requiresAck]);

      /* Replacing retires the old one in the same breath. Two steps would
         leave both live for however long the second took to be remembered. */
      if (supersedes_id) {
        await client.query(
          'UPDATE staff_policies SET is_active = false, updated_at = NOW() WHERE id = $1', [supersedes_id]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await audit.log({
      actorId: req.user?.id || null, actorEmail: req.user?.email || null, actorRole: req.user?.role || null,
      action: supersedes_id ? 'staff_policy_replaced' : 'staff_policy_published',
      entityType: 'staff_policy', entityId: id,
      description: `Policy "${String(title).trim()}" published to all staff` +
                   (supersedes_id ? `, replacing ${supersedes_id}` : ''),
      after: { id, category: cat, filename, size: check.size, mime: check.mime, supersedes_id: supersedes_id || null },
      ip: req.ip || null, platform: 'team',
    });

    return res.status(201).json({ ok: true, id });
  } catch (err) {
    console.error('[staff-policies] create', err.message);
    return res.status(500).json({ error: 'Could not publish that policy.' });
  }
});

/* ─── PATCH /api/staff-policies/:id ───────────────────────────────────
   Title, category, summary, version, effective date, and whether it is
   still live. The FILE is never edited — a replacement is a new row, so the
   bytes behind an id are the bytes somebody read under that id. */
router.patch('/:id', requireAuthor, async (req, res) => {
  try {
    const sets = [], vals = [];
    const put = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    if (req.body.title !== undefined) {
      if (!String(req.body.title).trim()) return res.status(400).json({ error: 'A policy needs a title.' });
      put('title', String(req.body.title).trim());
    }
    if (req.body.category !== undefined) {
      put('category', CATEGORIES.includes(String(req.body.category)) ? String(req.body.category) : 'general');
    }
    if (req.body.summary        !== undefined) put('summary', String(req.body.summary).trim() || null);
    if (req.body.version        !== undefined) put('version', String(req.body.version).trim() || null);
    if (req.body.effective_date !== undefined) put('effective_date', req.body.effective_date || null);
    if (req.body.is_active      !== undefined) put('is_active', !!req.body.is_active);
    if (req.body.requires_ack   !== undefined) put('requires_ack', !!req.body.requires_ack);
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });

    vals.push(req.params.id);
    const { rows: [row] } = await pool.query(
      `UPDATE staff_policies SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${vals.length} RETURNING id, title, is_active`, vals);
    if (!row) return res.status(404).json({ error: 'Policy not found.' });

    await audit.log({
      actorId: req.user?.id || null, actorEmail: req.user?.email || null, actorRole: req.user?.role || null,
      action: 'staff_policy_updated', entityType: 'staff_policy', entityId: row.id,
      description: `Policy "${row.title}" updated` + (row.is_active ? '' : ' and withdrawn'),
      after: req.body, ip: req.ip || null, platform: 'team',
    });
    return res.json({ ok: true, policy: row });
  } catch (err) {
    console.error('[staff-policies] update', err.message);
    return res.status(500).json({ error: 'Could not update that policy.' });
  }
});

/* ─── DELETE /api/staff-policies/:id ──────────────────────────────────
   Withdraws rather than deletes. "What did the policy say in March" is a
   question somebody eventually asks, and a deleted row cannot answer it. */
router.delete('/:id', requireAuthor, async (req, res) => {
  try {
    const { rows: [row] } = await pool.query(
      `UPDATE staff_policies SET is_active = false, updated_at = NOW()
        WHERE id = $1 RETURNING id, title`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Policy not found.' });
    await audit.log({
      actorId: req.user?.id || null, actorEmail: req.user?.email || null, actorRole: req.user?.role || null,
      action: 'staff_policy_withdrawn', entityType: 'staff_policy', entityId: row.id,
      description: `Policy "${row.title}" withdrawn from staff`,
      ip: req.ip || null, platform: 'team',
    });
    return res.json({ ok: true, withdrawn: row.id });
  } catch (err) {
    console.error('[staff-policies] withdraw', err.message);
    return res.status(500).json({ error: 'Could not withdraw that policy.' });
  }
});

module.exports = router;
