'use strict';
const router       = require('express').Router();
const pool         = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const requireAdmin = requireRole('admin', 'director');
const bcrypt       = require('bcryptjs');
const crypto       = require('crypto');
const jwt          = require('jsonwebtoken');
const emailService = require('../services/email');
const JWT_SECRET   = process.env.JWT_SECRET || 'dev-secret';
const BASE_URL     = process.env.BASE_URL || 'https://platform.svcapital.co.za';

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
    res.status(500).json({ error: 'Internal server error.' });
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
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* POST /api/email-logs/:id/retry — resend a single failed email */
router.post('/:id/retry', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT id, to_email, subject, type, status FROM email_logs WHERE id = $1',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Log entry not found.' });
    const log = rows[0];
    const email = log.to_email.toLowerCase().trim();

    await _retryEmail(log.type, email);
    res.json({ ok: true, message: 'Email resent successfully.' });
  } catch (err) {
    console.error(`[email-logs] retry ${id} failed:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to resend.' });
  }
});

/* POST /api/email-logs/retry-failed — bulk resend all failed emails of retryable types */
router.post('/retry-failed', requireAuth, requireAdmin, async (req, res) => {
  const { type } = req.body;
  const RETRYABLE = ['account_setup', 'password_reset'];
  const typeFilter = type && RETRYABLE.includes(type) ? type : null;

  try {
    const params = typeFilter ? [typeFilter] : [RETRYABLE[0], RETRYABLE[1]];
    const typeClause = typeFilter
      ? `AND type = $1`
      : `AND type IN ($1, $2)`;
    const { rows: failed } = await pool.query(
      `SELECT id, to_email, type FROM email_logs
       WHERE status = 'failed' ${typeClause}
       ORDER BY sent_at DESC LIMIT 500`,
      params
    );

    let sent = 0, skipped = 0, errors = 0;
    for (const log of failed) {
      try {
        await _retryEmail(log.type, log.to_email.toLowerCase().trim());
        sent++;
      } catch (_) {
        errors++;
      }
    }
    res.json({ ok: true, processed: failed.length, sent, skipped, errors });
  } catch (err) {
    console.error('[email-logs] retry-failed error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ── shared retry logic ───────────────────────────────────────────────────── */
async function _retryEmail(type, email) {
  switch (type) {
    case 'account_setup': {
      const { rows: invRows } = await pool.query(
        `SELECT id, first_name, last_name FROM investors WHERE LOWER(email) = $1`,
        [email]
      );
      if (!invRows[0]) throw new Error(`No investor found for ${email}`);
      const inv = invRows[0];
      const tempHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      const { rows: [user] } = await pool.query(`
        INSERT INTO users (email, password_hash, role, first_name, last_name, investor_id)
        VALUES ($1, $2, 'investor', $3, $4, $5)
        ON CONFLICT (email) DO UPDATE
          SET investor_id = COALESCE(users.investor_id, EXCLUDED.investor_id)
        RETURNING id, first_name
      `, [email, tempHash, inv.first_name || '', inv.last_name || '', inv.id]);
      const jti = crypto.randomBytes(16).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const token = jwt.sign({ sub: user.id, purpose: 'password_reset', jti }, JWT_SECRET, { expiresIn: '7d' });
      await pool.query('DELETE FROM password_reset_tokens WHERE user_id=$1 AND used=false', [user.id]);
      await pool.query('INSERT INTO password_reset_tokens (jti, user_id, expires_at) VALUES ($1,$2,$3)', [jti, user.id, expiresAt]);
      const setupLink = `${BASE_URL}/reset-password.html?token=${token}`;
      await emailService.sendAccountSetup(email, inv.first_name || email, setupLink);
      break;
    }
    case 'password_reset': {
      const { rows: userRows } = await pool.query(
        'SELECT id, first_name FROM users WHERE LOWER(email) = $1',
        [email]
      );
      if (!userRows[0]) throw new Error(`No user account found for ${email}`);
      const user = userRows[0];
      const jti = crypto.randomBytes(16).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const token = jwt.sign({ sub: user.id, purpose: 'password_reset', jti }, JWT_SECRET, { expiresIn: '30m' });
      await pool.query('DELETE FROM password_reset_tokens WHERE user_id=$1 AND used=false', [user.id]);
      await pool.query('INSERT INTO password_reset_tokens (jti, user_id, expires_at) VALUES ($1,$2,$3)', [jti, user.id, expiresAt]);
      const resetLink = `${BASE_URL}/reset-password.html?token=${token}`;
      await emailService.sendPasswordReset(email, user.first_name || '', resetLink);
      break;
    }
    default:
      throw new Error(`Retry not supported for type "${type}".`);
  }
}

module.exports = router;
