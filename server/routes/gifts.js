'use strict';

const router  = require('express').Router();
const pool    = require('../db/pool');
const crypto  = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');
const email   = require('../services/email');
const { recordTransaction, actorFromRequest } = require('../services/ledger');

const MIN_GIFT = 50;

/* ── POST /api/gifts/send ───────────────────────────────────────────────────
   Checks sender wallet balance, then atomically deducts and creates the gift
   inside a single DB transaction so money can never be lost mid-flight.
─────────────────────────────────────────────────────────────────────────── */
router.post('/send', requireAuth, async (req, res) => {
  const { recipientEmail, recipientName, amount, message } = req.body;
  const senderId = req.user?.investorId || req.user?.id;

  if (!recipientEmail || !amount) {
    return res.status(400).json({ error: 'recipientEmail and amount are required' });
  }
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt < MIN_GIFT) {
    return res.status(400).json({ error: `Minimum gift amount is R${MIN_GIFT}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock sender row for the duration of the transaction (prevents double-spend)
    const { rows: [sender] } = await client.query(
      'SELECT first_name, last_name, wallet_balance, email FROM investors WHERE id = $1 FOR UPDATE',
      [senderId]
    );
    if (!sender) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sender account not found' });
    }
    if (sender.email?.toLowerCase() === recipientEmail.toLowerCase()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You cannot send a gift to yourself' });
    }

    const walletBalance = parseFloat(sender.wallet_balance) || 0;
    if (walletBalance < amt) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Insufficient wallet balance. You have R${walletBalance.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} available.`,
      });
    }

    // Deduct from sender wallet — the WHERE clause is a final safety net against
    // concurrent requests that both passed the balance check above
    const { rowCount } = await client.query(
      'UPDATE investors SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2 AND wallet_balance >= $1',
      [amt, senderId]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient wallet balance' });
    }

    const { rows: [recipient] } = await client.query(
      'SELECT id, first_name, last_name, email FROM investors WHERE LOWER(email) = LOWER($1)',
      [recipientEmail]
    );

    const claimToken = crypto.randomBytes(28).toString('hex');
    const giftId     = `GIFT-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const senderName = `${sender.first_name} ${sender.last_name}`.trim();
    const recipientDisplayName = recipientName?.trim()
      || (recipient ? `${recipient.first_name} ${recipient.last_name}`.trim() : null)
      || recipientEmail.split('@')[0];

    // Record sender transaction
    await recordTransaction(client, {
      id: `TXN-${giftId}-S`, investorId: senderId, type: 'gift_sent', amount: -amt,
      description: `Gift sent to ${recipientDisplayName}`,
    }, actorFromRequest(req));

    const isExisting = !!recipient;
    const giftStatus = isExisting ? 'claimed' : 'pending';

    // Create gift record
    await client.query(
      `INSERT INTO gifts (id, sender_id, recipient_id, recipient_email, recipient_name,
         amount, message, status, claim_token, claimed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        giftId, senderId, recipient?.id ?? null, recipientEmail, recipientDisplayName,
        amt, message?.trim() || null, giftStatus, claimToken,
        isExisting ? new Date().toISOString() : null,
      ]
    );

    if (isExisting) {
      // Instantly credit recipient wallet
      await client.query(
        'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
        [amt, recipient.id]
      );
      /* The SENDER is the actor on both legs: the recipient did nothing.
         Attributing the credit to the person who received it would make a
         gift look like a self-credit. */
      await recordTransaction(client, {
        id: `TXN-${giftId}-R`, investorId: recipient.id, type: 'gift_received',
        amount: amt, description: `Investment gift from ${senderName}`,
      }, actorFromRequest(req));
    }

    await client.query('COMMIT');

    // Fire-and-forget emails after the transaction is committed
    if (isExisting) {
      email.sendGiftReceived(recipientEmail, {
        senderName, amount: amt, message: message?.trim() || null,
        recipientName: `${recipient.first_name} ${recipient.last_name}`.trim(),
        investorId: recipient.id,
      }).catch(() => {});
    } else {
      const BASE = process.env.BASE_URL || 'https://platform.svcapital.co.za';
      email.sendGiftInvite(recipientEmail, {
        senderName, amount: amt, message: message?.trim() || null,
        recipientName: recipientDisplayName,
        signupUrl: `${BASE}/signup.html?gift=${claimToken}`,
      }).catch(() => {});
    }

    res.json({ success: true, giftId, recipientExists: isExisting });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[gifts/send]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

/* ── GET /api/gifts/admin ───────────────────────────────────────
   Every gift, for the console's Gifts section.

   Staff could only meet a gift as two unconnected rows in the Transaction
   Ledger — a gift_sent against one client and, if it was ever claimed, a
   gift_received against another — with nothing joining them and nothing at
   all for the ones in between.

   NO claim_token, deliberately. It is the bearer credential that claims the
   money, and a list endpoint is the wrong place for one; nothing the console
   shows needs it. recipient_email IS here: for a recipient who has no
   account yet it is the only thing identifying them.

   LAPSED IS DERIVED HERE, NOT STORED. A gift to somebody without an account
   debits the sender's wallet immediately and then waits on a claim. Nothing
   sweeps expires_at: the claim route refuses a gift past it, but the row
   goes on saying 'pending' for ever. A console reading status alone would
   therefore report money as "waiting to be claimed" that can never be
   claimed — the sender's money, already gone from their wallet, recoverable
   only if they happen to cancel the gift in the portal. The flag is computed
   in SQL so the database's clock decides it, not the reader's browser.

   The totals are their own aggregate over the whole table rather than a sum
   of the rows returned. A stat card that sums a capped page reports a figure
   that quietly shrinks as the table outgrows the cap.
─────────────────────────────────────────────────────────────────────── */
/* The two states written once, the way ledger.js writes cashMovementSQL: `p`
   prefixes the columns for the query that aliases the table, so the row flag
   and the stat card beside it cannot come to disagree about what lapsed
   means. */
const LAPSED_SQL   = (p = '') => `${p}status = 'pending' AND ${p}expires_at IS NOT NULL AND ${p}expires_at < NOW()`;
const AWAITING_SQL = (p = '') => `${p}status = 'pending' AND (${p}expires_at IS NULL OR ${p}expires_at >= NOW())`;

router.get('/admin', requireAuth, requireRole('admin', 'director', 'staff'), async (req, res) => {
  const asked = parseInt(req.query.limit, 10);
  const limit = Math.min(Math.max(Number.isFinite(asked) ? asked : 500, 1), 2000);
  try {
    const [list, totals] = await Promise.all([
      pool.query(
        `SELECT g.id, g.amount, g.status, g.message,
                g.sender_id, g.recipient_id, g.recipient_email, g.recipient_name,
                g.sent_at, g.claimed_at, g.expires_at, g.created_at,
                s.first_name AS sender_first, s.last_name AS sender_last,
                s.email      AS sender_email,
                r.first_name AS recipient_first, r.last_name AS recipient_last,
                (${LAPSED_SQL('g.')}) AS lapsed
           FROM gifts g
           LEFT JOIN investors s ON s.id = g.sender_id
           LEFT JOIN investors r ON r.id = g.recipient_id
          ORDER BY COALESCE(g.sent_at, g.created_at) DESC
          LIMIT $1`, [limit]),
      pool.query(
        `SELECT COUNT(*)::int AS gifts,
                COALESCE(SUM(amount), 0) AS total,
                COUNT(*) FILTER (WHERE status = 'claimed')::int AS claimed,
                COALESCE(SUM(amount) FILTER (WHERE status = 'claimed'), 0) AS claimed_amount,
                COUNT(*) FILTER (WHERE ${AWAITING_SQL()})::int AS awaiting,
                COALESCE(SUM(amount) FILTER (WHERE ${AWAITING_SQL()}), 0) AS awaiting_amount,
                COUNT(*) FILTER (WHERE ${LAPSED_SQL()})::int AS lapsed,
                COALESCE(SUM(amount) FILTER (WHERE ${LAPSED_SQL()}), 0) AS lapsed_amount,
                COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                /* Imported Firebase history. Counted apart from lapsed on
                   purpose: that import writes no transaction and moves no
                   wallet, so those gifts are not money anybody here is
                   holding. See _giftState in admin.js. */
                COUNT(*) FILTER (WHERE status = 'expired')::int AS expired
           FROM gifts`),
    ]);
    res.json({
      data: list.rows, totals: totals.rows[0],
      limit, truncated: list.rows.length >= limit,
    });
  } catch (err) {
    console.error('[gifts/admin]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ── GET /api/gifts/my ──── sent gifts ──────────────────────────────────── */
router.get('/my', requireAuth, async (req, res) => {
  const senderId = req.user?.investorId || req.user?.id;
  try {
    const { rows } = await pool.query(
      `SELECT g.*, i.first_name AS r_first, i.last_name AS r_last
       FROM gifts g LEFT JOIN investors i ON g.recipient_id = i.id
       WHERE g.sender_id = $1 ORDER BY g.created_at DESC LIMIT 200`,
      [senderId]
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ── GET /api/gifts/received ── received gifts ──────────────────────────── */
router.get('/received', requireAuth, async (req, res) => {
  const investorId = req.user?.investorId || req.user?.id;
  try {
    const { rows } = await pool.query(
      `SELECT g.*, i.first_name AS s_first, i.last_name AS s_last
       FROM gifts g LEFT JOIN investors i ON g.sender_id = i.id
       WHERE g.recipient_id = $1 ORDER BY g.created_at DESC LIMIT 200`,
      [investorId]
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ── POST /api/gifts/claim/:token ── new-user gift claim ─────────────────── */
router.post('/claim/:token', requireAuth, async (req, res) => {
  const claimantId = req.user?.investorId || req.user?.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [gift] } = await client.query(
      'SELECT * FROM gifts WHERE claim_token = $1 FOR UPDATE',
      [req.params.token]
    );
    if (!gift) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Gift not found' }); }
    if (gift.status !== 'pending') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Gift already claimed or cancelled' }); }
    if (gift.expires_at && new Date(gift.expires_at) < new Date()) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Gift has expired' }); }

    const { rows: [claimant] } = await client.query(
      'SELECT email, first_name, last_name FROM investors WHERE id = $1',
      [claimantId]
    );
    if (!claimant) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Investor not found' }); }
    if (claimant.email.toLowerCase() !== gift.recipient_email.toLowerCase()) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This gift was sent to a different email address' });
    }

    await client.query(
      'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
      [gift.amount, claimantId]
    );
    await client.query(
      `UPDATE gifts SET status = 'claimed', claimed_at = NOW(), recipient_id = $1 WHERE id = $2`,
      [claimantId, gift.id]
    );

    const { rows: [sender] } = await client.query(
      'SELECT first_name, last_name FROM investors WHERE id = $1', [gift.sender_id]
    );
    const senderName = sender ? `${sender.first_name} ${sender.last_name}`.trim() : 'Someone';

    await recordTransaction(client, {
      id: `TXN-CLAIM-${gift.id}`, investorId: claimantId, type: 'gift_received',
      amount: gift.amount, description: `Investment gift from ${senderName}`,
    }, actorFromRequest(req));

    await client.query('COMMIT');
    res.json({ success: true, amount: gift.amount, senderName });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[gifts/claim]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

/* ── DELETE /api/gifts/:id ── cancel pending gift & refund ─────────────── */
router.delete('/:id', requireAuth, async (req, res) => {
  const senderId = req.user?.investorId || req.user?.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [gift] } = await client.query(
      'SELECT * FROM gifts WHERE id = $1 AND sender_id = $2 FOR UPDATE',
      [req.params.id, senderId]
    );
    if (!gift) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Gift not found' }); }
    if (gift.status !== 'pending') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Only pending gifts can be cancelled' }); }

    await client.query(`UPDATE gifts SET status = 'cancelled' WHERE id = $1`, [gift.id]);
    await client.query(
      'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
      [gift.amount, senderId]
    );
    await recordTransaction(client, {
      investorId: gift.sender_id, type: 'gift_cancelled', amount: gift.amount,
      reference: 'GIFT-CANCEL-' + gift.id, description: 'Gift cancellation refund',
    }, actorFromRequest(req));

    await client.query('COMMIT');
    res.json({ success: true, refunded: gift.amount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

/* ── GET /api/gifts/check-recipient ── look up email ─────────────────────── */
router.get('/check-recipient', requireAuth, async (req, res) => {
  const { email: recipientEmail } = req.query;
  if (!recipientEmail) return res.status(400).json({ error: 'email required' });
  try {
    const { rows: [investor] } = await pool.query(
      'SELECT id FROM investors WHERE LOWER(email) = LOWER($1)',
      [recipientEmail]
    );
    return res.json({ exists: !!investor });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
