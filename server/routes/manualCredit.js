/* ═══════════════════════════════════════════════════════════
   Manual Wallet Credit — /api/admin/manual-credit
   Requires role: admin | director
   ═══════════════════════════════════════════════════════════ */
'use strict';

const router  = require('express').Router();
const pool    = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const audit   = require('../services/audit');

router.use(requireAuth, requireRole('admin', 'director'));

router.post('/manual-credit', async (req, res) => {
  try {
    const { investorId, amount, notes } = req.body;
    const numAmount = parseFloat(amount);
    if (!investorId || isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'investorId and a positive amount are required.' });
    }

    const reference = 'MC-' + require('crypto').randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();

    const client = await pool.connect();
    let investor;
    try {
      await client.query('BEGIN');

      const { rows: [inv] } = await client.query(
        'SELECT id, first_name, last_name, email FROM investors WHERE id = $1 FOR UPDATE',
        [investorId]
      );
      if (!inv) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Investor not found.' });
      }
      investor = inv;

      await client.query(
        `INSERT INTO transactions
           (id, investor_id, type, amount, status, reference, description, notes, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'deposit', $2, 'completed', $3, 'Manual wallet credit', $4, NOW(), NOW())`,
        [investorId, numAmount, reference, notes || null]
      );

      await client.query(
        'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
        [numAmount, investorId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'wallet.manual_credit',
      entityType: 'investors',
      entityId:   investorId,
      description: `Manual wallet credit of R${numAmount} to investor ${investor.first_name} ${investor.last_name} (${investorId}). Ref: ${reference}. Notes: ${notes || 'none'}`,
      ip:         req.ip,
    }).catch(() => {}));

    res.json({ success: true, reference });
  } catch (err) {
    console.error('/admin/manual-credit error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/admin/reset-2fa ─── */
router.post('/reset-2fa', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const { rows } = await pool.query(
      'SELECT id, email, first_name, last_name, totp_enabled FROM users WHERE id = $1',
      [userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    const user = rows[0];

    if (!user.totp_enabled) {
      return res.status(400).json({ error: '2FA is not enabled on this account.' });
    }

    await pool.query(
      'UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = $1',
      [userId]
    );
    await pool.query(
      'DELETE FROM totp_recovery_codes WHERE user_id = $1',
      [userId]
    );

    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'user.2fa_reset',
      entityType: 'users',
      entityId:   userId,
      description: `Admin reset 2FA for user ${user.first_name} ${user.last_name} (${user.email})`,
      ip:         req.ip,
    }).catch(() => {}));

    res.json({ success: true });
  } catch (err) {
    console.error('/admin/reset-2fa error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
