/* ═══════════════════════════════════════════════════════
   POPIA Privacy Endpoints
   GET    /api/privacy/export   — export all investor data
   DELETE /api/privacy/account  — anonymise account (RTBF)
   ═══════════════════════════════════════════════════════ */
'use strict';

const router       = require('express').Router();
const pool         = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const audit        = require('../services/audit');
const closure = require('../services/accountClosure');

/* ─── GET /api/privacy/export ─── */
router.get('/export', requireAuth, async (req, res) => {
  try {
    const investorId = req.user.investorId || req.user.investor_id;
    if (!investorId) {
      return res.status(403).json({ error: 'This endpoint is only available to investor accounts.' });
    }

    // Fetch investor row
    const { rows: [investor] } = await pool.query(
      `SELECT id, first_name, last_name, email, phone, province, occupation,
              risk_profile, kyc_status, status, wallet_balance, total_invested,
              total_returns, referral_code, date_joined, created_at, updated_at
       FROM investors WHERE id = $1`,
      [investorId]
    );
    if (!investor) return res.status(404).json({ error: 'Investor record not found.' });

    // Fetch investments
    const { rows: investments } = await pool.query(
      `SELECT id, pool_id, pool_name, amount, status, start_date, end_date,
              annual_rate, expected_return, actual_return, term_months,
              payout_option, created_at
       FROM investments WHERE investor_id = $1 ORDER BY created_at DESC`,
      [investorId]
    );

    // Fetch transactions
    const { rows: transactions } = await pool.query(
      `SELECT id, type, amount, status, reference, description, created_at
       FROM transactions WHERE investor_id = $1 ORDER BY created_at DESC`,
      [investorId]
    );

    // Fetch KYC documents (omit any binary file_data columns)
    const { rows: kyc_documents } = await pool.query(
      `SELECT id, doc_type, status, file_url, file_name, notes,
              reviewed_at, submitted_at, created_at
       FROM kyc_documents WHERE investor_id = $1 ORDER BY created_at DESC`,
      [investorId]
    );

    // Fetch support tickets
    const { rows: support_tickets } = await pool.query(
      `SELECT id, subject, message, category, priority, status,
              response, responded_at, created_at
       FROM support_tickets WHERE investor_id = $1 ORDER BY created_at DESC`,
      [investorId]
    );

    // Fetch investor notes
    const { rows: investor_notes } = await pool.query(
      `SELECT id, admin_email, note, created_at
       FROM investor_notes WHERE investor_id = $1 ORDER BY created_at DESC`,
      [investorId]
    ).catch(() => ({ rows: [] }));

    res.json({
      exportedAt: new Date().toISOString(),
      investor,
      investments,
      transactions,
      kyc_documents,
      support_tickets,
      investor_notes,
    });

  } catch (err) {
    console.error('/privacy/export error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── GET /api/privacy/account/closure ───────────────────────────────
   What is standing in the way, BEFORE they try.

   The same list the DELETE refuses with, offered up front so the screen can
   say "here is what to settle first" instead of accepting a typed
   confirmation and then rejecting it.
   ──────────────────────────────────────────────────────────────────── */
router.get('/account/closure', requireAuth, async (req, res) => {
  try {
    const investorId = req.user.investorId || req.user.investor_id;
    if (!investorId) {
      return res.status(403).json({ error: 'This endpoint is only available to investor accounts.' });
    }
    const blockers = await closure.blockersFor(pool, investorId);
    res.json({ data: { can_close: blockers.length === 0, blockers } });
  } catch (err) {
    console.error('/privacy/account/closure error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── DELETE /api/privacy/account ─── */
router.delete('/account', requireAuth, async (req, res) => {
  try {
    const { confirm } = req.body;
    if (confirm !== 'DELETE MY ACCOUNT') {
      return res.status(400).json({
        error: 'Confirmation string mismatch. Send { confirm: "DELETE MY ACCOUNT" } to proceed.',
      });
    }

    const investorId = req.user.investorId || req.user.investor_id;
    if (!investorId) {
      return res.status(403).json({ error: 'This endpoint is only available to investor accounts.' });
    }

    /* WHAT IS STILL HERE.

       This used to check the confirmation string and anonymise, then say
       "active investments will continue until maturity" — true, and the
       problem: they mature into a wallet belonging to Deleted User, on an
       address at deleted.invalid, behind an inactive login. The money is
       still theirs and they can no longer reach it.

       Erasure is a right. It is not a way to abandon money, and it is not a
       way out of a stokvel that still owes you your share. */
    const blockers = await closure.blockersFor(pool, investorId);
    if (blockers.length) {
      return res.status(409).json({
        error: 'There are a few things to settle before this account can be closed.',
        blockers,
      });
    }

    // Verify investor exists
    const { rows: [investor] } = await pool.query(
      'SELECT id FROM investors WHERE id = $1', [investorId]
    );
    if (!investor) return res.status(404).json({ error: 'Investor record not found.' });

    // Anonymise PII — do NOT delete investment or transaction records (regulatory requirement)
    await pool.query(
      `UPDATE investors
         SET email       = $1,
             first_name  = 'Deleted',
             last_name   = 'User',
             phone       = NULL,
             id_number   = NULL,
             address     = NULL,
             updated_at  = NOW()
       WHERE id = $2`,
      [`deleted-${investorId}@deleted.invalid`, investorId]
    );

    // Delete KYC documents for this investor
    await pool.query('DELETE FROM kyc_documents WHERE investor_id = $1', [investorId]);

    // Anonymise linked users row if present
    await pool.query(
      `UPDATE users
         SET email        = $1,
             first_name   = 'Deleted',
             last_name    = 'User',
             is_active    = false,
             updated_at   = NOW()
       WHERE investor_id = $2`,
      [`deleted-${investorId}@deleted.invalid`, investorId]
    ).catch(() => {}); // best-effort

    /* Nothing may still charge this card or act on their behalf. A payment
       taken against somebody who has asked to be forgotten is the one
       mistake here that would be indefensible. */
    await closure.standDown(pool, investorId);

    // Record audit event
    setImmediate(() => audit.log({
      actorId:     investorId,
      actorEmail:  req.user.email,
      action:      'account_deletion_request',
      entityType:  'investors',
      entityId:    investorId,
      description: `POPIA account anonymisation requested by investor ${investorId}`,
      ip:          req.ip,
      metadata:    { actor_role: 'investor' },
    }).catch(err => console.error('[audit] account_deletion_request failed:', err.message)));

    res.json({
      success: true,
      message: 'Account closed and your personal details removed. Your transaction '
             + 'history is kept without your name on it, because we are required to '
             + 'keep it.',
    });

  } catch (err) {
    console.error('/privacy/account DELETE error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
