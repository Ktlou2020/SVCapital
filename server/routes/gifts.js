'use strict';

const router  = require('express').Router();
const pool    = require('../db/pool');
const crypto  = require('crypto');
const { requireAuth } = require('../middleware/auth');
const email   = require('../services/email');

const MIN_GIFT = 50;

/* ── POST /api/gifts/send ───────────────────────────────────────
   Deducts from sender wallet, creates gift, emails recipient.
─────────────────────────────────────────────────────────────── */
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

  try {
    const { rows: [sender] } = await pool.query(
      'SELECT first_name, last_name, wallet_balance, email FROM investors WHERE id = $1',
      [senderId]
    );
    if (!sender) return res.status(404).json({ error: 'Sender not found' });
    if (sender.email?.toLowerCase() === recipientEmail.toLowerCase()) {
      return res.status(400).json({ error: 'You cannot send a gift to yourself' });
    }
    if ((parseFloat(sender.wallet_balance) || 0) < amt) {
      return res.status(400).json({ error: 'Insufficient wallet balance to send this gift' });
    }

    const { rows: [recipient] } = await pool.query(
      'SELECT id, first_name, last_name, email FROM investors WHERE LOWER(email) = LOWER($1)',
      [recipientEmail]
    );

    const claimToken = crypto.randomBytes(28).toString('hex');
    const giftId     = `GIFT-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const senderName = `${sender.first_name} ${sender.last_name}`.trim();
    const recipientDisplayName = recipientName?.trim()
      || (recipient ? `${recipient.first_name} ${recipient.last_name}`.trim() : null)
      || recipientEmail.split('@')[0];

    // Deduct from sender wallet
    await pool.query(
      'UPDATE investors SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
      [amt, senderId]
    );

    // Record sender transaction
    const txnSentId = `TXN-${giftId}-S`;
    await pool.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, description, created_at)
       VALUES ($1,$2,'gift_sent',$3,'completed',$4,NOW())`,
      [txnSentId, senderId, -amt, `Gift sent to ${recipientDisplayName}`]
    );

    const isExisting = !!recipient;
    const giftStatus = isExisting ? 'claimed' : 'pending';

    // Create gift record
    await pool.query(
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
      await pool.query(
        'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
        [amt, recipient.id]
      );
      const txnRecvId = `TXN-${giftId}-R`;
      await pool.query(
        `INSERT INTO transactions (id, investor_id, type, amount, status, description, created_at)
         VALUES ($1,$2,'gift_received',$3,'completed',$4,NOW())`,
        [txnRecvId, recipient.id, amt, `Investment gift from ${senderName}`]
      );
      email.sendGiftReceived(recipientEmail, {
        senderName, amount: amt, message: message?.trim() || null,
        recipientName: `${recipient.first_name} ${recipient.last_name}`.trim(),
      }).catch(() => {});
    } else {
      const BASE = process.env.BASE_URL || 'https://platform.svcapital.co.za';
      const signupUrl = `${BASE}/signup.html?gift=${claimToken}`;
      email.sendGiftInvite(recipientEmail, {
        senderName, amount: amt, message: message?.trim() || null,
        recipientName: recipientDisplayName, signupUrl,
      }).catch(() => {});
    }

    res.json({ success: true, giftId, recipientExists: isExisting });
  } catch (err) {
    console.error('[gifts/send]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/gifts/my ──── sent gifts ────────────────────────── */
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

/* ── GET /api/gifts/received ── received gifts ─────────────────── */
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

/* ── POST /api/gifts/claim/:token ── new-user gift claim ────────── */
router.post('/claim/:token', requireAuth, async (req, res) => {
  const claimantId = req.user?.investorId || req.user?.id;
  try {
    const { rows: [gift] } = await pool.query(
      'SELECT * FROM gifts WHERE claim_token = $1',
      [req.params.token]
    );
    if (!gift) return res.status(404).json({ error: 'Gift not found' });
    if (gift.status !== 'pending') return res.status(400).json({ error: 'Gift already claimed' });
    if (new Date(gift.expires_at) < new Date()) return res.status(400).json({ error: 'Gift has expired' });

    const { rows: [claimant] } = await pool.query(
      'SELECT email, first_name, last_name FROM investors WHERE id = $1',
      [claimantId]
    );
    if (!claimant) return res.status(404).json({ error: 'Investor not found' });
    if (claimant.email.toLowerCase() !== gift.recipient_email.toLowerCase()) {
      return res.status(403).json({ error: 'This gift was sent to a different email address' });
    }

    await pool.query('UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2', [gift.amount, claimantId]);
    await pool.query(
      `UPDATE gifts SET status = 'claimed', claimed_at = NOW(), recipient_id = $1 WHERE id = $2`,
      [claimantId, gift.id]
    );

    const { rows: [sender] } = await pool.query('SELECT first_name, last_name FROM investors WHERE id = $1', [gift.sender_id]);
    const senderName = sender ? `${sender.first_name} ${sender.last_name}`.trim() : 'Someone';

    await pool.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, description, created_at)
       VALUES ($1,$2,'gift_received',$3,'completed',$4,NOW())`,
      [`TXN-CLAIM-${gift.id}`, claimantId, gift.amount, `Investment gift from ${senderName}`]
    );

    res.json({ success: true, amount: gift.amount, senderName });
  } catch (err) {
    console.error('[gifts/claim]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── DELETE /api/gifts/:id ── cancel pending gift ────────────── */
router.delete('/:id', requireAuth, async (req, res) => {
  const senderId = req.user?.investorId || req.user?.id;
  try {
    const { rows: [gift] } = await pool.query(
      'SELECT * FROM gifts WHERE id = $1 AND sender_id = $2',
      [req.params.id, senderId]
    );
    if (!gift) return res.status(404).json({ error: 'Gift not found' });
    if (gift.status !== 'pending') return res.status(400).json({ error: 'Only pending gifts can be cancelled' });

    await pool.query(`UPDATE gifts SET status = 'cancelled' WHERE id = $1`, [gift.id]);
    await pool.query('UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2', [gift.amount, senderId]);

    res.json({ success: true, refunded: gift.amount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/gifts/check-recipient ── look up email ─────────── */
router.get('/check-recipient', requireAuth, async (req, res) => {
  const { email: recipientEmail } = req.query;
  if (!recipientEmail) return res.status(400).json({ error: 'email required' });
  try {
    const { rows: [inv] } = await pool.query(
      'SELECT first_name, last_name FROM investors WHERE LOWER(email) = LOWER($1)',
      [recipientEmail]
    );
    res.json({ exists: !!inv, name: inv ? `${inv.first_name} ${inv.last_name}`.trim() : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
