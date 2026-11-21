/* ═══════════════════════════════════════════════════════════
   Funds held for AML review — /api/admin/aml
   Requires role: admin | director

   A client deposit the AML rules flagged is recorded as pending_aml and NOT
   credited (services/aml.js, routes/payments.js). This is where a person
   looks at it and decides. Until somebody does, the money is ours and not
   theirs, which is the whole point — so this screen must be the easiest one
   to find and act on, not a report.

   RELEASING CREDITS IT, exactly as the deposit would have been credited at
   the time: the same wallet, the same sub-account routing, the same
   fallback when the sub-account no longer resolves. Rejecting credits
   nothing and says the refund is a human job, because it is — the money is
   with Paystack and taking it back is a conversation, not a column.

   BOTH ARE IDEMPOTENT AND BOTH LOCK THE ROW. Two people reading the same
   queue and both pressing Release is the ordinary case, not the unlikely
   one.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const audit  = require('../services/audit');
const aml    = require('../services/aml');
const emailService = require('../services/email');
const { actorFromRequest } = require('../services/ledger');

router.use(requireAuth, requireRole('admin', 'director'));

/* ─── What is waiting ───────────────────────────────────────────────── */
router.get('/held', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.reference, t.amount, t.notes, t.created_at, t.sub_account_id,
              t.investor_id,
              i.first_name, i.last_name, i.email, i.kyc_status,
              a.name AS sub_account_name
         FROM transactions t
         JOIN investors i ON i.id = t.investor_id
         LEFT JOIN sub_accounts a ON a.id = t.sub_account_id
        WHERE t.type = 'deposit' AND t.status = $1
        ORDER BY t.created_at ASC`,
      [aml.HELD_STATUS]);
    return res.json({ data: rows });
  } catch (err) {
    console.error('[aml] could not list held deposits:', err.message);
    return res.status(500).json({ error: 'Could not load held deposits.' });
  }
});

/* ─── Release: the money goes where the deposit said ────────────────── */
router.post('/held/:reference/release', async (req, res) => {
  const reference = String(req.params.reference || '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* The TRANSACTION row is locked, not the investor's — the status on
       this row is what makes a second release a no-op, so it is the thing
       two concurrent releases have to queue on. */
    const { rows: [txn] } = await client.query(
      `SELECT * FROM transactions WHERE reference = $1 FOR UPDATE`, [reference]);
    if (!txn) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such deposit.' }); }
    if (txn.status !== aml.HELD_STATUS) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `That deposit is not being held — it is ${txn.status}.` });
    }

    const amount = Number(txn.amount);

    /* THE SAME ROUTING THE DEPOSIT WOULD HAVE HAD. A sub-account that no
       longer resolves for this investor falls back to their own wallet
       rather than refusing: the money has been taken and a credit with
       nowhere to go is not something to discover from a support ticket
       later. routes/payments.js says the same in more words. */
    let creditedSubAccountId = null;
    if (txn.sub_account_id) {
      const { rows: [sa] } = await client.query(
        `SELECT id FROM sub_accounts
          WHERE id = $1 AND parent_investor_id = $2 AND COALESCE(status, '') <> 'closed'
          FOR UPDATE`, [txn.sub_account_id, txn.investor_id]);
      if (sa) creditedSubAccountId = sa.id;
    }

    const credit = creditedSubAccountId
      ? await client.query(
          `UPDATE sub_accounts SET wallet_balance = wallet_balance + $1, updated_at = NOW()
            WHERE id = $2`, [amount, creditedSubAccountId])
      : await client.query(
          `UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW()
            WHERE id = $2`, [amount, txn.investor_id]);

    /* rowCount, as the deposit path does: a credit that applied to nothing
       must not reach COMMIT looking like one that worked. */
    if (!credit.rowCount) {
      await client.query('ROLLBACK');
      return res.status(500).json({
        error: 'The credit applied to no wallet. Nothing was changed.' });
    }

    await client.query(
      `UPDATE transactions
          SET status = 'completed',
              description = $2,
              notes = COALESCE(notes, '') || $3,
              updated_at = NOW()
        WHERE reference = $1`,
      [reference,
       `Top-up via Paystack — R${amount.toLocaleString('en-ZA')} credited to `
       + `${creditedSubAccountId ? 'sub-account' : 'wallet'} (released after AML review)`,
       ` | released by ${req.user?.email || 'staff'} at ${new Date().toISOString()}`]);

    /* The ticket is closed by the same action, so the queue and the tickets
       cannot disagree about what is outstanding. */
    await client.query(
      `UPDATE support_tickets SET status = 'resolved', updated_at = NOW()
        WHERE category = 'aml_review' AND status = 'open' AND message LIKE $1`,
      [`%${reference}%`]);

    await client.query('COMMIT');

    await audit.log({
      actorId: actorFromRequest(req).id, actorEmail: req.user?.email,
      actorRole: req.user?.role,
      action: 'payment.aml_released',
      entityType: 'transactions', entityId: reference,
      description: `R${amount} released after AML review and credited to `
                 + `${creditedSubAccountId || txn.investor_id}.`,
    }).catch(() => {});

    const { rows: [inv] } = await pool.query(
      `SELECT email, first_name FROM investors WHERE id = $1`, [txn.investor_id]);
    if (inv) {
      emailService.sendDepositReleased(inv, amount, reference)
        .catch(e => console.error('[aml] release email error:', e.message));
    }

    return res.json({ data: { reference, amount, credited_to: creditedSubAccountId || txn.investor_id } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[aml] release failed:', err.message);
    return res.status(500).json({ error: 'Could not release the deposit.' });
  } finally {
    client.release();
  }
});

/* ─── Reject: nothing is credited, and a person handles the refund ─── */
router.post('/held/:reference/reject', async (req, res) => {
  const reference = String(req.params.reference || '');
  const reason = String((req.body && req.body.reason) || '').slice(0, 500);
  if (!reason) return res.status(400).json({ error: 'Say why it is rejected — it goes on the record.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [txn] } = await client.query(
      `SELECT * FROM transactions WHERE reference = $1 FOR UPDATE`, [reference]);
    if (!txn) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such deposit.' }); }
    if (txn.status !== aml.HELD_STATUS) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `That deposit is not being held — it is ${txn.status}.` });
    }

    /* 'rejected' is the status the portal already renders as Rejected, and
       it moves no money anywhere. The REFUND is deliberately not automated:
       the money is with the gateway, sending it back is a decision with a
       person's name on it, and a button here that implied otherwise would
       be the dangerous part of this screen. */
    await client.query(
      `UPDATE transactions
          SET status = 'rejected',
              description = $2,
              notes = COALESCE(notes, '') || $3,
              updated_at = NOW()
        WHERE reference = $1`,
      [reference,
       `Top-up via Paystack — R${Number(txn.amount).toLocaleString('en-ZA')} not credited (AML review)`,
       ` | rejected by ${req.user?.email || 'staff'} at ${new Date().toISOString()}: ${reason}`]);

    await client.query(
      `UPDATE support_tickets
          SET status = 'open', priority = 'high',
              message = message || $2, updated_at = NOW()
        WHERE category = 'aml_review' AND message LIKE $1`,
      [`%${reference}%`,
       `\n\nREJECTED by ${req.user?.email || 'staff'}: ${reason}\n`
       + 'The funds were never credited. A refund through the gateway is a '
       + 'manual step and has NOT been done by this action.']);

    await client.query('COMMIT');

    await audit.log({
      actorId: actorFromRequest(req).id, actorEmail: req.user?.email,
      actorRole: req.user?.role,
      action: 'payment.aml_rejected',
      entityType: 'transactions', entityId: reference,
      description: `R${txn.amount} from ${txn.investor_id} rejected after AML review: `
                 + `${reason}. Never credited. Refund not automated.`,
    }).catch(() => {});

    return res.json({ data: { reference, status: 'rejected' } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[aml] reject failed:', err.message);
    return res.status(500).json({ error: 'Could not reject the deposit.' });
  } finally {
    client.release();
  }
});

module.exports = router;
