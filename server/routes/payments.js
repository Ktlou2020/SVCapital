/* ════════════════════════════════════════════════════════════
   Payment routes
   GET  /api/payments/config              — returns public Paystack key
   POST /api/payments/paystack/verify     — server-verifies a reference & credits wallet
   POST /api/payments/paystack/webhook    — Paystack server-to-server event (charge.success)
   POST /api/payments/ozow-hash           — generates Ozow SHA-512 HashCheck
   ════════════════════════════════════════════════════════════ */
'use strict';

const router       = require('express').Router();
const crypto       = require('crypto');
const pool         = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const emailService = require('../services/email');
const smsService   = require('../services/sms');
const audit        = require('../services/audit');
const aml          = require('../services/aml');

/* ──────────────────────────────────────────────────────────
   GET /api/payments/config
   Returns the Paystack public key so the frontend can be
   configured without hardcoded keys in source code.
────────────────────────────────────────────────────────── */
router.get('/config', requireAuth, (req, res) => {
  const paystackPublicKey = (process.env.PAYSTACK_PUBLIC_KEY || '').trim();
  res.json({ paystackPublicKey });
});

/* ──────────────────────────────────────────────────────────
   Shared helper — atomically credit wallet and record deposit
   Idempotent: skips silently if the reference is already processed.
────────────────────────────────────────────────────────── */
async function creditWallet(investorId, amount, reference, actorEmail = null, source = 'paystack', subAccountId = null) {
  const client = await pool.connect();
  let investor;
  try {
    await client.query('BEGIN');

    const invRes = await client.query('SELECT * FROM investors WHERE id = $1', [investorId]);
    if (!invRes.rows[0]) { await client.query('ROLLBACK'); throw new Error(`Investor ${investorId} not found`); }
    investor = invRes.rows[0];

    const sourceLabel = source === 'webhook' ? 'Paystack (confirmed)' : 'Paystack';
    const dest = subAccountId ? `sub-account` : 'wallet';
    const desc = `Top-up via ${sourceLabel} — R${Number(amount).toLocaleString('en-ZA')} credited to ${dest}`;

    // Atomic idempotency guard — ON CONFLICT DO NOTHING means rowCount = 0 if duplicate
    const { rowCount } = await client.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, sub_account_id, transaction_date, created_at)
       VALUES (gen_random_uuid(), $1, 'deposit', $2, 'completed', $3, $4, $5, NOW(), NOW())
       ON CONFLICT (reference) DO NOTHING`,
      [investorId, amount, reference, desc, subAccountId || null]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      console.log(`[payments] ${reference} already processed — skipping duplicate credit`);
      return { alreadyProcessed: true };
    }

    // Route credit: sub-account wallet takes priority when sub_account_id is present
    if (subAccountId) {
      await client.query(
        'UPDATE sub_accounts SET wallet_balance = wallet_balance + $1 WHERE id = $2',
        [parseFloat(amount), subAccountId]
      );
    } else {
      await client.query(
        'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
        [parseFloat(amount), investorId]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Email + SMS confirmation (non-blocking)
  Promise.all([
    emailService.sendDepositConfirmed(investor, amount, reference, 'Paystack').catch(e => console.error('[payments] email error:', e.message)),
    smsService.sendDepositConfirmed(investor.phone, investor.first_name, amount).catch(e => console.error('[payments] sms error:', e.message)),
  ]);

  // Audit trail
  await audit.log({
    actorEmail: actorEmail || investor.email,
    action: 'transaction.completed',
    entityType: 'transactions',
    entityId: reference,
    description: `Paystack deposit R${amount} credited to ${investorId}`,
  }).catch(() => {});

  console.log(`[payments] Credited R${amount} to ${subAccountId ? `sub-account ${subAccountId}` : `investor ${investorId}`}, ref: ${reference}`);
  return { alreadyProcessed: false, amount, investorId, subAccountId };
}

/* ──────────────────────────────────────────────────────────
   POST /api/payments/paystack/verify
   Called by the frontend after PaystackPop onSuccess fires.
   Verifies the reference with Paystack's API, then atomically
   credits the investor's wallet.
────────────────────────────────────────────────────────── */
router.post('/paystack/verify', requireAuth, async (req, res) => {
  const { reference, walletCredit, subAccountId } = req.body;
  if (!reference) return res.status(400).json({ error: 'reference is required' });

  const investorId = req.user.investorId;
  if (!investorId) return res.status(400).json({ error: 'investorId is required' });

  const secretKey = (process.env.PAYSTACK_SECRET_KEY || '').trim();

  if (!secretKey) {
    console.error('[payments] PAYSTACK_SECRET_KEY not set — rejecting payment verification request');
    return res.status(503).json({ error: 'Payment verification is unavailable. Please contact support.' });
  }

  // Verify with Paystack REST API
  try {
    const psRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } }
    );
    const psData = await psRes.json();

    if (!psData.status || psData.data?.status !== 'success') {
      const psMsg = psData.message || '';
      const hint = psMsg.toLowerCase().includes('not found')
        ? ' — likely test/live key mismatch: PAYSTACK_PUBLIC_KEY and PAYSTACK_SECRET_KEY must both be from the same environment (both test or both live)'
        : '';
      console.error('[payments] Paystack verification failed:', JSON.stringify(psData), hint);
      return res.status(400).json({
        error: 'Payment not verified by Paystack',
        details: psMsg || 'Verification returned non-success status',
      });
    }

    // Use wallet_credit from metadata (base amount, excluding gateway fee)
    // Fall back to full transaction amount if metadata missing.
    // Always credit the authenticated user — never trust investor_id from Paystack metadata.
    const creditAmount = Number(psData.data.metadata?.wallet_credit) || (psData.data.amount / 100);

    const result = await creditWallet(investorId, creditAmount, reference, req.user?.email, 'paystack', subAccountId || null);
    aml.checkDeposit(pool, investorId, creditAmount, reference).catch(e => console.error('[aml]', e.message));

    // Save reusable authorization code for future auto top-ups
    let authSaved = false;
    const auth = psData.data?.authorization;
    if (auth?.reusable && auth?.authorization_code && psData.data?.customer?.email) {
      try {
        await pool.query(
          `INSERT INTO paystack_authorizations
             (investor_id, authorization_code, email, card_type, last4, exp_month, exp_year, bank, channel, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
           ON CONFLICT (investor_id) DO UPDATE SET
             authorization_code=$2, email=$3, card_type=$4, last4=$5,
             exp_month=$6, exp_year=$7, bank=$8, channel=$9, updated_at=NOW()`,
          [investorId, auth.authorization_code, psData.data.customer.email,
           auth.card_type, auth.last4, auth.exp_month, auth.exp_year, auth.bank, auth.channel]
        );
        authSaved = true;
      } catch (e) {
        console.warn('[payments] Could not save Paystack authorization:', e.message);
      }
    }

    return res.json({ success: true, verified: true, authSaved, ...result });

  } catch (err) {
    console.error('[payments] Paystack verify error:', err.message);
    return res.status(500).json({ error: `Verification failed: ${err.message}` });
  }
});

/* ──────────────────────────────────────────────────────────
   POST /api/payments/paystack/webhook
   Paystack sends this server-to-server for every charge.success.
   This is the reliable backup path — fires even if the browser
   crashed or onSuccess didn't complete.
   No auth required (uses HMAC signature verification instead).
────────────────────────────────────────────────────────── */
router.post('/paystack/webhook', async (req, res) => {
  const secretKey = (process.env.PAYSTACK_SECRET_KEY || '').trim();
  if (!secretKey) {
    console.error('[payments] PAYSTACK_SECRET_KEY not set — rejecting webhook');
    return res.status(500).json({ error: 'Webhook verification unavailable' });
  }

  if (!req.rawBody) {
    console.error('[payments] rawBody missing — HMAC verification failed');
    return res.status(400).json({ error: 'Signature verification failed' });
  }
  // Verify HMAC-SHA512 signature using the raw body (captured in server/index.js middleware)
  const expectedSig = crypto.createHmac('sha512', secretKey).update(req.rawBody).digest('hex');
  if (expectedSig !== req.headers['x-paystack-signature']) {
    console.warn('[payments/webhook] Invalid Paystack signature — ignoring');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Acknowledge immediately — Paystack requires a 200 within 5 seconds
  res.sendStatus(200);

  const { event, data } = req.body;
  if (event !== 'charge.success') return;

  const reference    = data?.reference;
  const investorId   = data?.metadata?.investor_id;
  const creditAmt    = Number(data?.metadata?.wallet_credit) || (data?.amount / 100);
  const subAccountId = data?.metadata?.sub_account_id || null;

  if (!investorId) {
    console.warn('[payments/webhook] No investor_id in metadata, ref:', reference);
    return;
  }

  try {
    const result = await creditWallet(investorId, creditAmt, reference, null, 'webhook', subAccountId);
    if (!result.alreadyProcessed) {
      console.log(`[payments/webhook] charge.success — credited R${creditAmt} to ${investorId}`);
      aml.checkDeposit(pool, investorId, creditAmt, reference).catch(e => console.error('[aml]', e.message));
    }
  } catch (err) {
    console.error('[payments/webhook] creditWallet error:', err.message);
  }
});

/* ──────────────────────────────────────────────────────────
   POST /api/payments/ozow-hash
   Generates the server-side Ozow SHA-512 HashCheck.
   (Unchanged from previous implementation)
────────────────────────────────────────────────────────── */
router.post('/ozow-hash', requireAuth, (req, res) => {
  const siteCode   = (process.env.OZOW_SITE_CODE   || '').trim();
  const privateKey = (process.env.OZOW_PRIVATE_KEY || '').trim();
  // IsTest is server-controlled — set OZOW_IS_TEST=true in env for sandbox
  const isTestEnv  = (process.env.OZOW_IS_TEST || 'false').trim().toLowerCase() === 'true' ? 'true' : 'false';

  if (!siteCode)   return res.status(503).json({ error: 'OZOW_SITE_CODE not configured. Set it in Railway → Variables.' });
  if (!privateKey) return res.status(503).json({ error: 'OZOW_PRIVATE_KEY not configured. Set it in Railway → Variables (use the Private Key, NOT the API Key).' });

  const {
    countryCode  = 'ZA',
    currencyCode = 'ZAR',
    amount,
    transactionRef,
    bankRef    = '',
    notifyUrl  = '',
    cancelUrl  = '',
    errorUrl   = '',
    successUrl,
  } = req.body;

  if (!amount || !transactionRef || !successUrl)
    return res.status(400).json({ error: 'amount, transactionRef and successUrl are required.' });

  const lc = v => String(v).toLowerCase();
  // notifyUrl is optional but MUST be in the hash when provided (Ozow spec §3.2)
  const hashParts = [
    lc(siteCode), lc(countryCode), lc(currencyCode),
    lc(amount), lc(transactionRef), lc(bankRef),
  ];
  if (notifyUrl) hashParts.push(lc(notifyUrl));
  hashParts.push(lc(cancelUrl), lc(errorUrl), lc(successUrl), isTestEnv);
  const payload = hashParts.join('') + privateKey;

  const hash = crypto.createHash('sha512').update(payload).digest('hex').toLowerCase();

  console.log('[Ozow] hash — ref:', transactionRef, 'siteCode:', siteCode,
    'isTest:', isTestEnv, 'pkLen:', privateKey.length, 'payloadLen:', hashParts.join('').length);
  return res.json({ hash, siteCode, isTest: isTestEnv });
});

/* ──────────────────────────────────────────────────────────
   GET  /api/payments/topup-card   — return saved Paystack card
   DELETE /api/payments/topup-card — remove saved card + disable auto top-up
────────────────────────────────────────────────────────── */
router.get('/topup-card', requireAuth, async (req, res) => {
  try {
    const investorId = req.user.investorId;
    if (!investorId) return res.status(400).json({ error: 'investorId required' });
    const { rows } = await pool.query(
      `SELECT card_type, last4, exp_month, exp_year, bank, channel, created_at
       FROM paystack_authorizations WHERE investor_id = $1`,
      [investorId]
    );
    res.json({ card: rows[0] || null });
  } catch (err) {
    console.error('[payments]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.delete('/topup-card', requireAuth, async (req, res) => {
  try {
    const investorId = req.user.investorId;
    if (!investorId) return res.status(400).json({ error: 'investorId required' });
    await pool.query('DELETE FROM paystack_authorizations WHERE investor_id = $1', [investorId]);
    await pool.query(
      `UPDATE investors SET auto_topup_enabled=false, auto_topup_amount=NULL, auto_topup_day=1, updated_at=NOW()
       WHERE id=$1`,
      [investorId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[payments]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ──────────────────────────────────────────────────────────
   GET  /api/payments/auto-topup  — return current settings
   POST /api/payments/auto-topup  — save settings
────────────────────────────────────────────────────────── */
router.get('/auto-topup', requireAuth, async (req, res) => {
  try {
    const investorId = req.user.investorId;
    if (!investorId) return res.status(400).json({ error: 'investorId required' });
    const { rows } = await pool.query(
      `SELECT auto_topup_enabled, auto_topup_amount, auto_topup_day FROM investors WHERE id=$1`,
      [investorId]
    );
    res.json(rows[0] || { auto_topup_enabled: false, auto_topup_amount: null, auto_topup_day: 1 });
  } catch (err) {
    console.error('[payments]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/auto-topup', requireAuth, async (req, res) => {
  try {
    const investorId = req.user.investorId;
    if (!investorId) return res.status(400).json({ error: 'investorId required' });

    const { enabled, amount, day } = req.body;
    const amountNum = parseFloat(amount);
    const dayNum    = parseInt(day, 10);

    if (enabled) {
      if (!amountNum || amountNum < 50) return res.status(400).json({ error: 'Minimum auto top-up amount is R50' });
      if (!dayNum || dayNum < 1 || dayNum > 28) return res.status(400).json({ error: 'Day must be between 1 and 28' });

      // Require saved card to enable
      const { rows } = await pool.query(
        'SELECT id FROM paystack_authorizations WHERE investor_id=$1', [investorId]
      );
      if (!rows.length) return res.status(400).json({ error: 'No saved card found. Complete a Paystack top-up first to save your card.' });
    }

    await pool.query(
      `UPDATE investors SET
         auto_topup_enabled=$1, auto_topup_amount=$2, auto_topup_day=$3, updated_at=NOW()
       WHERE id=$4`,
      [!!enabled, enabled ? amountNum : null, enabled ? dayNum : 1, investorId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[payments]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
