/* ═══════════════════════════════════════════════════════════
   Investment maturity instructions
   POST /api/investments/:id/instruction
     Body: { instruction }
   Clients may set their own instruction up to 17:00 SAST on the
   maturity day. Admin/director/staff may set it on behalf of a
   client at any time (bypasses the cutoff).
   ═══════════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');
const audit  = require('../services/audit');
const email  = require('../services/email');
const { requireAuth } = require('../middleware/auth');

const VALID_INSTRUCTIONS = ['payout_all', 'payout_return', 'payout_custom', 'reinvest', 'switch_product', 'custom_switch'];
const STAFF_ROLES = ['admin', 'director', 'fund_manager', 'staff'];

router.post('/:id/instruction', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { instruction } = req.body || {};

  if (!VALID_INSTRUCTIONS.includes(instruction)) {
    return res.status(400).json({ error: 'Invalid instruction.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]);
    const inv = rows[0];
    if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Investment not found.' }); }

    const isStaff = STAFF_ROLES.includes(req.user.role);

    // Clients may only manage their own investment.
    if (!isStaff) {
      if (!req.user.investorId || inv.investor_id !== req.user.investorId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Forbidden.' });
      }
      // Cutoff: 17:00 SAST on the maturity (end_date) day = 15:00 UTC that date.
      if (inv.end_date) {
        const { rows: [chk] } = await client.query(
          `SELECT (end_date::timestamp + interval '15 hours') <= NOW() AS past_cutoff
             FROM investments WHERE id = $1`,
          [id]
        );
        if (chk && chk.past_cutoff) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            error: 'Instructions close at 17:00 (SA time) on the maturity date. Please contact support.',
            code: 'INSTRUCTION_CUTOFF',
          });
        }
      }
      // Also block once the investment is no longer active.
      if (inv.status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This investment can no longer be changed.' });
      }
    }

    await client.query(
      'UPDATE investments SET maturity_instruction = $1, updated_at = NOW() WHERE id = $2',
      [instruction, id]
    );
    await client.query('COMMIT');

    audit.log({
      actorId: req.user.id || req.user.investorId, actorEmail: req.user.email, actorRole: req.user.role,
      action: 'investment.instruction_set', entityType: 'investments', entityId: id,
      description: `Maturity instruction set to '${instruction}'${isStaff ? ' by staff on behalf of investor' : ''}`,
      platform: req.headers['x-platform'] || null,
    }).catch(() => {});

    // Fire-and-forget confirmation email to the investor
    const _invId = inv.investor_id;
    const _poolName = inv.pool_name || inv.pool_id;
    const _endDate = inv.end_date;
    setImmediate(async () => {
      try {
        const { rows: [investor] } = await pool.query(
          'SELECT first_name, last_name, email FROM investors WHERE id = $1',
          [_invId]
        );
        if (investor && investor.email) {
          email.sendMaturityInstructionConfirmed(investor, {
            poolName: _poolName,
            endDate: _endDate,
            instruction,
            onBehalf: isStaff,
          }).catch(() => {});
        }
      } catch (_) {}
    });

    res.json({ success: true, instruction, onBehalf: isStaff });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[investments/instruction] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /api/investments/:id/cancel  (admin/staff only)
   Cancels an active investment and credits the full amount
   plus any platform fee back to the investor's wallet.
   ═══════════════════════════════════════════════════════════ */
router.post('/:id/cancel', requireAuth, async (req, res) => {
  if (!STAFF_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden — staff only.' });
  }

  const { id } = req.params;
  const { reason } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the investment row
    const { rows } = await client.query(
      'SELECT * FROM investments WHERE id = $1 FOR UPDATE',
      [id]
    );
    const inv = rows[0];
    if (!inv) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Investment not found.' });
    }
    if (['cancelled', 'matured', 'paid_out'].includes(inv.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Investment is already ${inv.status} and cannot be cancelled.` });
    }

    const amount = parseFloat(inv.amount) || 0;

    // Find the platform fee paid for this investment (negative amount, type='fee')
    const { rows: feeTxns } = await client.query(
      `SELECT id, amount FROM transactions
        WHERE investment_id = $1
          AND type = 'fee'
          AND status = 'completed'
        LIMIT 1`,
      [id]
    );
    const platformFee = feeTxns.length ? Math.abs(parseFloat(feeTxns[0].amount) || 0) : 0;
    const totalRefund = amount + platformFee;

    // Cancel the investment
    await client.query(
      `UPDATE investments SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // Cancel all associated transactions (investment + fee)
    await client.query(
      `UPDATE transactions SET status = 'cancelled', updated_at = NOW()
        WHERE investment_id = $1 AND status = 'completed'`,
      [id]
    );

    // Credit wallet: principal + platform fee
    await client.query(
      'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
      [totalRefund, inv.investor_id]
    );

    // Record the refund as a deposit transaction
    const refundDesc = platformFee > 0
      ? `Investment cancellation refund — ${inv.pool_name || inv.pool_id} (R${amount.toFixed(2)} principal + R${platformFee.toFixed(2)} platform fee)`
      : `Investment cancellation refund — ${inv.pool_name || inv.pool_id}`;

    await client.query(
      `INSERT INTO transactions
         (id, investor_id, type, amount, status, reference, description, investment_id, pool_id, transaction_date, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'deposit', $2, 'completed', $3, $4, $5, $6, NOW(), NOW(), NOW())`,
      [inv.investor_id, totalRefund, 'REV-' + id, refundDesc, id, inv.pool_id]
    );

    // Reduce pool totals
    if (inv.pool_id) {
      await client.query(
        `UPDATE investment_pools
            SET current_invested = GREATEST(0, COALESCE(current_invested, 0) - $1),
                raised_amount    = GREATEST(0, COALESCE(raised_amount,    0) - $1),
                updated_at       = NOW()
          WHERE id = $2`,
        [amount, inv.pool_id]
      );
    }

    await client.query('COMMIT');

    audit.log({
      actorId: req.user.id || req.user.investorId, actorEmail: req.user.email, actorRole: req.user.role,
      action: 'investment.cancelled', entityType: 'investments', entityId: id,
      description: `Investment cancelled — R${amount.toFixed(2)}${platformFee > 0 ? ` + R${platformFee.toFixed(2)} fee` : ''} refunded to wallet${reason ? ` — Reason: ${reason}` : ''}`,
      platform: req.headers['x-platform'] || null,
    }).catch(() => {});

    res.json({ success: true, refunded: totalRefund, principal: amount, platformFee });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[investments/cancel] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

module.exports = router;
