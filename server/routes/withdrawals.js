/* ═══════════════════════════════════════════════════════
   Withdrawal Approval Workflow
   POST /api/withdrawals/request           — investor
   POST /api/withdrawals/:txId/approve     — admin | director
   POST /api/withdrawals/:txId/reject      — admin | director
   ═══════════════════════════════════════════════════════ */
'use strict';

const router       = require('express').Router();
const pool         = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const emailService = require('../services/email');
const smsService   = require('../services/sms');
const audit        = require('../services/audit');

/* Lazy-load push service and SSE broadcast */
let _broadcast = null;
function getBroadcast() {
  if (!_broadcast) { try { _broadcast = require('./events').broadcast; } catch (_) {} }
  return _broadcast;
}
let _push = null;
function getPush() {
  if (!_push) { try { _push = require('../services/pushService'); } catch (_) {} }
  return _push;
}

/* ─── POST /api/withdrawals/request ─── */
router.post('/request', requireAuth, async (req, res) => {
  try {
    const investorId = req.user.investorId || req.user.investor_id;
    if (!investorId) {
      return res.status(403).json({ error: 'This endpoint is only available to investor accounts.' });
    }

    const { amount, bank_account_number, bank_name, notes, sub_account_id } = req.body;
    const numAmount = parseFloat(amount);
    if (!amount || isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number.' });
    }

    const reference = 'WD-' + require('crypto').randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();

    // ── Sub-account withdrawal ──────────────────────────────────────────────
    if (sub_account_id) {
      const client = await pool.connect();
      let investor;
      try {
        await client.query('BEGIN');

        const { rows: [saRow] } = await client.query(
          'SELECT * FROM sub_accounts WHERE id=$1 AND parent_investor_id=$2 FOR UPDATE',
          [sub_account_id, investorId]
        );
        if (!saRow) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Sub-account not found or does not belong to you.' });
        }
        if (saRow.kyc_status !== 'approved') {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Sub-account FICA/KYC verification is required before withdrawing funds.' });
        }
        if (parseFloat(saRow.wallet_balance) < numAmount) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Insufficient sub-account wallet balance. Available: R${parseFloat(saRow.wallet_balance).toFixed(2)}.` });
        }

        const description = `Sub-account withdrawal (${saRow.name})${bank_name ? ` to ${bank_name}` : ''}${bank_account_number ? ` (${bank_account_number})` : ''}`;
        await client.query(
          `INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference, description, notes, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'withdrawal', $3, 'pending', $4, $5, $6, NOW(), NOW())`,
          [investorId, sub_account_id, numAmount, reference, description, notes || null]
        );
        await client.query(
          'UPDATE sub_accounts SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
          [numAmount, sub_account_id]
        );
        await client.query('COMMIT');

        const { rows: [invRow] } = await pool.query('SELECT * FROM investors WHERE id=$1', [investorId]).catch(() => ({ rows: [] }));
        investor = invRow;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      if (investor) {
        setImmediate(() => emailService.sendWithdrawalRequested(investor, { amount: numAmount, reference })
          .catch(err => console.error('[email] sendWithdrawalRequested (SA) failed:', err.message)));
      }
      return res.json({ success: true, reference });
    }

    // ── Investor wallet withdrawal ──────────────────────────────────────────
    const description = `Withdrawal request${bank_name ? ` to ${bank_name}` : ''}${bank_account_number ? ` (${bank_account_number})` : ''}`;

    // Use a serializable transaction + FOR UPDATE to prevent double-spend race conditions
    const client = await pool.connect();
    let investor;
    try {
      await client.query('BEGIN');

      const { rows: [row] } = await client.query(
        'SELECT id, first_name, last_name, email, wallet_balance, fica_status, kyc_status, status FROM investors WHERE id = $1 FOR UPDATE',
        [investorId]
      );
      if (!row) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Investor record not found.' });
      }
      investor = row;

      const ficaOk = investor.fica_status === 'approved' || investor.kyc_status === 'verified';
      if (!ficaOk) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'FICA/KYC verification is required before withdrawing funds.' });
      }

      if (parseFloat(investor.wallet_balance) < numAmount) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Insufficient wallet balance. Available: R${parseFloat(investor.wallet_balance).toFixed(2)}.`,
        });
      }

      await client.query(
        `INSERT INTO transactions
           (id, investor_id, type, amount, status, reference, description, notes, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'withdrawal', $2, 'pending', $3, $4, $5, NOW(), NOW())`,
        [investorId, numAmount, reference, description, notes || null]
      );

      await client.query(
        'UPDATE investors SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
        [numAmount, investorId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Fire-and-forget email + SSE broadcast
    setImmediate(() => {
      emailService.sendWithdrawalRequested(investor, { amount: numAmount, reference })
        .catch(err => console.error('[email] sendWithdrawalRequested failed:', err.message));
      try {
        const bcast = getBroadcast();
        if (bcast) bcast('withdrawal_requested', {
          investor_name: `${investor.first_name || ''} ${investor.last_name || ''}`.trim(),
          amount: numAmount,
          reference,
        });
      } catch (_) {}
    });

    res.json({ success: true, reference });
  } catch (err) {
    console.error('/withdrawals/request error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/withdrawals/:txId/approve ─── */
router.post('/:txId/approve', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { txId } = req.params;

    let tx, investor;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the row and guard against concurrent approvals
      const { rows } = await client.query(
        `SELECT * FROM transactions WHERE id = $1 AND type = 'withdrawal' AND status = 'pending' FOR UPDATE`,
        [txId]
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Withdrawal not found or already processed' });
      }
      tx = rows[0];

      const { rows: [invRow] } = await client.query(
        `SELECT id, email, first_name, last_name, phone, bank_name FROM investors WHERE id = $1`,
        [tx.investor_id]
      );
      if (!invRow) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Investor record not found.' });
      }
      investor = invRow;

      // Mark as completed with status guard
      await client.query(
        `UPDATE transactions SET status = 'completed', updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
        [txId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // Fire-and-forget notifications
    setImmediate(async () => {
      try {
        await emailService.sendWithdrawalProcessed(investor, {
          amount: tx.amount, reference: tx.reference, bankName: investor.bank_name || null,
        });
      } catch (err) { console.error('[email] sendWithdrawalProcessed failed:', err.message); }
      try {
        await smsService.sendWithdrawalProcessed(investor.phone, investor.first_name, tx.amount);
      } catch (err) { console.error('[sms] sendWithdrawalProcessed failed:', err.message); }
      try {
        const ps = getPush();
        if (ps && investor.id) {
          await ps.sendPushToInvestor(investor.id, {
            title: 'Withdrawal processed',
            body:  `R${Number(tx.amount).toLocaleString('en-ZA')} has been sent to your bank account.`,
            url:   '/portal/',
            tag:   'withdrawal.approved',
          });
        }
      } catch (err) { console.error('[push] withdrawal.approved failed:', err.message); }
    });

    // Audit
    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'withdrawal.approved',
      entityType: 'transactions',
      entityId:   txId,
      description: `Withdrawal ${tx.reference} (R${tx.amount}) approved for investor ${tx.investor_id}`,
      ip:         req.ip,
    }).catch(() => {}));

    res.json({ success: true });
  } catch (err) {
    console.error('/withdrawals/:txId/approve error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/withdrawals/:txId/reject ─── */
router.post('/:txId/reject', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { txId } = req.params;
    const { reason } = req.body;

    let tx, investor;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the row and guard against concurrent rejections
      const { rows } = await client.query(
        `SELECT * FROM transactions WHERE id = $1 AND type = 'withdrawal' AND status = 'pending' FOR UPDATE`,
        [txId]
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Withdrawal not found or already processed' });
      }
      tx = rows[0];

      const { rows: [invRow] } = await client.query(
        `SELECT id, email, first_name, last_name, phone FROM investors WHERE id = $1`,
        [tx.investor_id]
      );
      if (!invRow) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Investor record not found.' });
      }
      investor = invRow;

      // Mark as rejected and store reason with status guard
      await client.query(
        `UPDATE transactions SET status = 'rejected', notes = $1, updated_at = NOW() WHERE id = $2 AND status = 'pending'`,
        [reason || null, txId]
      );

      // Refund wallet — use absolute value in case amount is stored as negative
      await client.query(
        'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
        [Math.abs(parseFloat(tx.amount)), tx.investor_id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // Fire-and-forget notifications
    setImmediate(async () => {
      try {
        await emailService.sendWithdrawalRejected(investor, {
          amount: tx.amount, reference: tx.reference, reason: reason || null,
        });
      } catch (err) { console.error('[email] sendWithdrawalRejected failed:', err.message); }
      try {
        await smsService.sendWithdrawalRejected(investor.phone, investor.first_name, tx.amount);
      } catch (err) { console.error('[sms] sendWithdrawalRejected failed:', err.message); }
      try {
        const ps = getPush();
        if (ps && investor.id) {
          await ps.sendPushToInvestor(investor.id, {
            title: 'Withdrawal request declined',
            body:  `Your withdrawal of R${Number(tx.amount).toLocaleString('en-ZA')} was declined. Funds returned to your wallet.`,
            url:   '/portal/',
            tag:   'withdrawal.rejected',
          });
        }
      } catch (err) { console.error('[push] withdrawal.rejected failed:', err.message); }
    });

    // Audit
    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'withdrawal.rejected',
      entityType: 'transactions',
      entityId:   txId,
      description: `Withdrawal ${tx.reference} (R${tx.amount}) rejected for investor ${tx.investor_id}. Reason: ${reason || 'none'}`,
      ip:         req.ip,
    }).catch(() => {}));

    res.json({ success: true });
  } catch (err) {
    console.error('/withdrawals/:txId/reject error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
