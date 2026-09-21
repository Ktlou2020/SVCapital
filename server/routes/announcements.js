'use strict';
/* ═══════════════════════════════════════════════════════════════════
   "There is a new thing, and here is where it is" — /api/announcements/*

   A feature nobody is told about is a feature nobody uses. The people it
   costs most are the staff answering a client's question about a screen that
   changed under them without warning.

   Each notice carries two things, not one: what the feature is, and where to
   find it. The second is the one release notes leave out and the only one
   that turns an announcement into something somebody can act on.

   Dismissal is per person and per notice. A "seen everything up to here"
   watermark is cheaper and wrong: somebody who clears one notice has not read
   the other three, and the watermark cannot tell the difference.
   ═══════════════════════════════════════════════════════════════════ */

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const STAFF_ROLES = ['admin', 'director', 'fund_manager', 'staff'];
const requireAuthor = [requireAuth, requireRole('admin', 'director')];

/* Who is dismissing. Staff live in users and in employees and the two do not
   share an id; the address is the same on both sides, so that is the key. */
const keyOf = req => String(req.user?.email || '').trim().toLowerCase() || null;

const audienceFor = req =>
  STAFF_ROLES.includes(req.user?.role) ? 'staff' : 'clients';

const rnd = n => Math.random().toString(36).slice(2, 2 + n).toUpperCase();

/* ─── GET / — what this person has not dismissed ──────────────────── */
router.get('/', requireAuth, async (req, res) => {
  const key = keyOf(req);
  const aud = audienceFor(req);
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.title, a.body, a.where_to_find, a.area, a.audience,
              a.icon, a.published_at,
              (r.read_at IS NOT NULL) AS dismissed, r.read_at
         FROM feature_announcements a
         LEFT JOIN feature_announcement_reads r
                ON r.announcement_id = a.id AND r.user_key = $1
        WHERE a.active
          AND a.audience IN ($2, 'everyone')
          AND a.published_at <= NOW()
        ORDER BY a.published_at DESC`, [key, aud]);

    const all = rows.map(r => ({ ...r, dismissed: !!r.dismissed }));
    const unread = all.filter(r => !r.dismissed);
    /* Both, in one call: the badge needs the count and the panel needs the
       history, and two round trips for one screen is one too many. */
    res.json({ data: req.query.all ? all : unread, unread: unread.length, total: all.length });
  } catch (err) {
    console.error('[announcements] list error:', err.message);
    res.status(500).json({ error: 'Could not load announcements.' });
  }
});

/* ─── POST /:id/dismiss ───────────────────────────────────────────── */
router.post('/:id/dismiss', requireAuth, async (req, res) => {
  const key = keyOf(req);
  if (!key) return res.status(400).json({ error: 'No account on this session.' });
  try {
    /* Idempotent: a second click, a double-submit or a retry after a dropped
       response all mean the same thing, and none of them is an error. */
    const { rowCount } = await pool.query(
      `INSERT INTO feature_announcement_reads (announcement_id, user_key)
       SELECT id, $2 FROM feature_announcements WHERE id = $1
       ON CONFLICT (announcement_id, user_key) DO NOTHING`, [req.params.id, key]);
    if (!rowCount) {
      const { rows } = await pool.query(
        'SELECT 1 FROM feature_announcements WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Unknown announcement.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[announcements] dismiss error:', err.message);
    res.status(500).json({ error: 'Could not dismiss that.' });
  }
});

/* ─── POST /:id/restore — undo a dismissal ────────────────────────── */
router.post('/:id/restore', requireAuth, async (req, res) => {
  const key = keyOf(req);
  if (!key) return res.status(400).json({ error: 'No account on this session.' });
  try {
    await pool.query(
      'DELETE FROM feature_announcement_reads WHERE announcement_id = $1 AND user_key = $2',
      [req.params.id, key]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[announcements] restore error:', err.message);
    res.status(500).json({ error: 'Could not restore that.' });
  }
});

/* ─── POST / — publish one ────────────────────────────────────────── */
router.post('/', requireAuthor, async (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'title is required.' });
  if (!b.body)  return res.status(400).json({ error: 'body is required.' });
  const area     = ['admin', 'portal', 'both'].includes(b.area) ? b.area : 'admin';
  const audience = ['staff', 'clients', 'everyone'].includes(b.audience) ? b.audience : 'staff';
  try {
    const { rows: [row] } = await pool.query(
      `INSERT INTO feature_announcements
         (id, title, body, where_to_find, area, audience, icon, published_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, NOW()),$9) RETURNING *`,
      [b.id || `ANN-${rnd(10)}`, b.title, b.body, b.where_to_find || null,
       area, audience, b.icon || null, b.published_at || null, keyOf(req)]);
    res.json({ ok: true, announcement: row });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That announcement id already exists.' });
    console.error('[announcements] create error:', err.message);
    res.status(500).json({ error: 'Could not publish that.' });
  }
});

/* ─── PATCH /:id ──────────────────────────────────────────────────── */
router.patch('/:id', requireAuthor, async (req, res) => {
  const FIELDS = ['title', 'body', 'where_to_find', 'area', 'audience', 'icon', 'active', 'published_at'];
  const sets = [], vals = [];
  for (const f of FIELDS) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
      vals.push(req.body[f] === '' ? null : req.body[f]);
      sets.push(`${f} = $${vals.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
  vals.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE feature_announcements SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${vals.length} RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ error: 'Unknown announcement.' });
    res.json({ ok: true, announcement: rows[0] });
  } catch (err) {
    console.error('[announcements] patch error:', err.message);
    res.status(500).json({ error: 'Could not update that.' });
  }
});

module.exports = router;
