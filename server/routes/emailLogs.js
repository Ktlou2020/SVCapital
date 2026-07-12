'use strict';
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const requireAdmin = requireRole('admin');

/* GET /api/email-logs — paginated list with optional filters */
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  const { type, status, search, limit = 50, offset = 0 } = req.query;
  const conditions = [];
  const params = [];

  if (type)   { params.push(type);   conditions.push(`type = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (search) { params.push(`%${search.toLowerCase()}%`); conditions.push(`lower(to_email) LIKE $${params.length}`); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(parseInt(limit) || 50, parseInt(offset) || 0);

  try {
    const { rows } = await pool.query(
      `SELECT id, to_email, subject, type, status, error, resend_id, sent_at
       FROM email_logs ${where}
       ORDER BY sent_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) FROM email_logs ${where}`,
      params.slice(0, -2)
    );
    res.json({ data: rows, total: parseInt(count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* GET /api/email-logs/stats — counts by type and status */
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: byType } = await pool.query(
      `SELECT type, COUNT(*) AS total,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
       FROM email_logs
       GROUP BY type ORDER BY total DESC`
    );
    const { rows: [totals] } = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status='sent'   THEN 1 ELSE 0 END) AS sent
       FROM email_logs`
    );
    res.json({ byType, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
