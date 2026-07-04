'use strict';

const router  = require('express').Router();
const pool    = require('../db/pool');
const crypto  = require('crypto');
const { requireAuth } = require('../middleware/auth');
const email   = require('../services/email');

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
    await client.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, description, transaction_date, created_at)
       VALUES ($1,$2,'gift_sent',$3,'completed',$4,NOW(),NOW())`,
      [`TXN-${giftId}-S`, senderId, -amt, `Gift sent to ${recipientDisplayName}`]
    );

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
      await client.query(
        `INSERT INTO transactions (id, investor_id, type, amount, status, description, transaction_date, created_at)
         VALUES ($1,$2,'gift_received',$3,'completed',$4,NOW(),NOW())`,
        [`TXN-${giftId}-R`, recipient.id, amt, `Investment gift from ${senderName}`]
      );
    }

    await client.query('COMMIT');

    // Fire-and-forget emails after the transaction is committed
    if (isExisting) {
      email.sendGiftReceived(recipientEmail, {
        senderName, amount: amt, message: message?.trim() || null,
        recipientName: `${recipient.first_name} ${recipient.last_name}`.trim(),
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
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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

    await client.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, description, transaction_date, created_at)
       VALUES ($1,$2,'gift_received',$3,'completed',$4,NOW(),NOW())`,
      [`TXN-CLAIM-${gift.id}`, claimantId, gift.amount, `Investment gift from ${senderName}`]
    );

    await client.query('COMMIT');
    res.json({ success: true, amount: gift.amount, senderName });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[gifts/claim]', err.message);
    res.status(500).json({ error: err.message });
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
    await client.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'gift_cancelled', $2, 'completed', $3, 'Gift cancellation refund', NOW(), NOW())`,
      [senderId, gift.amount, 'GIFT-CANCEL-' + gift.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, refunded: gift.amount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
