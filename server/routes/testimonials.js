'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const FEEDBACK_XP = 50;
const XP_LEVELS = [
  { id: 'seed', min: 0 }, { id: 'sprout', min: 100 }, { id: 'grower', min: 300 },
  { id: 'cultivator', min: 600 }, { id: 'harvester', min: 1000 },
  { id: 'pioneer', min: 1500 }, { id: 'architect', min: 2500 }, { id: 'luminary', min: 5000 },
];
const getLevelForXP = xp => [...XP_LEVELS].reverse().find(l => xp >= l.min) || XP_LEVELS[0];

/* ── helpers ──────────────────────────────────────────────── */
function toInitials(name) {
  const parts = (name || '').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] || '?').slice(0, 2).toUpperCase();
}

async function awardFeedbackXP(investorId) {
  try {
    const { rows: existing } = await pool.query(
      'SELECT id FROM quest_completions WHERE investor_id = $1 AND quest_id = $2',
      [investorId, QUEST_ID]
    );
    if (existing.length) return; // already awarded

    const { rows: [inv] } = await pool.query(
      'SELECT xp_points FROM investors WHERE id = $1', [investorId]
    );
    if (!inv) return;

    const newXP  = (parseInt(inv.xp_points) || 0) + FEEDBACK_XP;
    const newLvl = getLevelForXP(newXP);
    const cId    = `QC-FEEDBACK-${investorId}`;

    await pool.query(
      `INSERT INTO quest_completions (id, investor_id, quest_id, xp_awarded, data, completed_at)
       VALUES ($1,$2,'leave_feedback',$3,'{}',NOW()) ON CONFLICT DO NOTHING`,
      [cId, investorId, FEEDBACK_XP]
    );
    await pool.query(
      `UPDATE investors SET xp_points=$1, xp_level=$2, updated_at=NOW() WHERE id=$3`,
      [newXP, newLvl.id, investorId]
    );
  } catch (err) {
    console.error('[testimonials] XP award failed:', err.message);
  }
}

/* ── POST /api/testimonials — investor submits feedback ───── */
router.post('/', requireAuth, async (req, res) => {
  const investorId = req.user?.investorId || req.user?.id;
  const { rating, body, product_label } = req.body;

  if (!rating || !body?.trim()) {
    return res.status(400).json({ error: 'Rating and feedback text are required.' });
  }
  const ratingNum = parseInt(rating);
  if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
  }
  if (body.trim().length < 20) {
    return res.status(400).json({ error: 'Please write at least 20 characters.' });
  }

  try {
    const { rows: [inv] } = await pool.query(
      'SELECT first_name, last_name FROM investors WHERE id = $1', [investorId]
    );
    if (!inv) return res.status(404).json({ error: 'Investor not found.' });

    const fullName    = `${inv.first_name} ${inv.last_name}`.trim();
    const displayName = `${inv.first_name} ${(inv.last_name || '').charAt(0)}.`.trim();
    const initials    = toInitials(fullName);

    const { rows: [existing] } = await pool.query(
      'SELECT id FROM testimonials WHERE investor_id = $1', [investorId]
    );

    let testimonialId;
    if (existing) {
      // Update existing submission (allow editing before approval)
      await pool.query(
        `UPDATE testimonials SET rating=$1, body=$2, product_label=$3,
           status='pending', rejection_reason=NULL, updated_at=NOW()
         WHERE investor_id=$4`,
        [ratingNum, body.trim(), product_label?.trim() || null, investorId]
      );
      testimonialId = existing.id;
    } else {
      const { rows: [t] } = await pool.query(
        `INSERT INTO testimonials (investor_id, rating, body, display_name, initials, product_label)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [investorId, ratingNum, body.trim(), displayName, initials, product_label?.trim() || null]
      );
      testimonialId = t.id;
      // Award XP on first submission only
      await awardFeedbackXP(investorId);
    }

    res.json({ success: true, id: testimonialId, xpAwarded: !existing ? 50 : 0 });
  } catch (err) {
    console.error('[testimonials/post]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/testimonials/public — approved testimonials for homepage ── */
router.get('/public', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, rating, body, display_name, initials, product_label, approved_at
       FROM testimonials WHERE status = 'approved'
       ORDER BY approved_at DESC LIMIT 20`
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/testimonials/my — investor's own submission ─── */
router.get('/my', requireAuth, async (req, res) => {
  const investorId = req.user?.investorId || req.user?.id;
  try {
    const { rows: [t] } = await pool.query(
      'SELECT id, rating, body, product_label, status, rejection_reason, created_at FROM testimonials WHERE investor_id = $1',
      [investorId]
    );
    res.json({ data: t || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/testimonials — admin: all submissions ───────── */
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, i.first_name, i.last_name, i.email
       FROM testimonials t JOIN investors i ON i.id = t.investor_id
       ORDER BY t.created_at DESC`
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── PATCH /api/testimonials/:id — admin: approve or reject ─ */
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  const { status, rejection_reason } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved or rejected' });
  }
  const adminId = req.user?.id;
  try {
    const { rows: [t] } = await pool.query(
      `UPDATE testimonials
          SET status=$1, rejection_reason=$2,
              approved_by=$3, approved_at=CASE WHEN $1='approved' THEN NOW() ELSE NULL END,
              updated_at=NOW()
        WHERE id=$4 RETURNING *`,
      [status, rejection_reason?.trim() || null, adminId, req.params.id]
    );
    if (!t) return res.status(404).json({ error: 'Testimonial not found' });
    res.json({ success: true, data: t });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
