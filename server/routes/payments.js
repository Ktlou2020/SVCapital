/* ════════════════════════════════════════════════════════════
   Payment helpers — server-side hash generation for Ozow
   POST /api/payments/ozow-hash
   ════════════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');

/**
 * POST /api/payments/ozow-hash
 * Body: { countryCode, currencyCode, amount, transactionRef,
 *         bankRef, cancelUrl, errorUrl, successUrl, isTest }
 *
 * The server reads OZOW_SITE_CODE and OZOW_PRIVATE_KEY from env vars
 * so the frontend never needs to hold sensitive credentials.
 *
 * Ozow HashCheck spec:
 *   lowercase( SHA512(
 *     siteCode + countryCode + currencyCode + amount +
 *     transactionRef + bankRef + cancelUrl + errorUrl +
 *     successUrl + isTest + privateKey
 *   ) )
 * where every value is first lowercased before concatenation.
 *
 * Returns: { hash, siteCode }  — frontend uses the returned siteCode.
 */
router.post('/ozow-hash', requireAuth, (req, res) => {
  const siteCode   = process.env.OZOW_SITE_CODE;
  const privateKey = process.env.OZOW_PRIVATE_KEY;

  if (!siteCode) {
    console.error('Ozow: OZOW_SITE_CODE env var not set');
    return res.status(503).json({ error: 'Ozow site code not configured on server. Set OZOW_SITE_CODE in Railway.' });
  }
  if (!privateKey) {
    console.error('Ozow: OZOW_PRIVATE_KEY env var not set');
    return res.status(503).json({ error: 'Ozow private key not configured on server. Set OZOW_PRIVATE_KEY in Railway.' });
  }

  const {
    countryCode  = 'ZA',
    currencyCode = 'ZAR',
    amount,
    transactionRef,
    bankRef      = '',
    cancelUrl    = '',
    errorUrl     = '',
    successUrl,
    isTest       = 'false',
  } = req.body;

  if (!amount || !transactionRef || !successUrl) {
    return res.status(400).json({ error: 'amount, transactionRef and successUrl are required.' });
  }

  // Ozow spec: lowercase all values, concatenate, SHA-512, lowercase the hex result
  const payload = [
    siteCode,
    countryCode,
    currencyCode,
    amount,
    transactionRef,
    bankRef,
    cancelUrl,
    errorUrl,
    successUrl,
    String(isTest),
    privateKey,
  ].map(v => String(v).toLowerCase()).join('');

  const hash = crypto.createHash('sha512').update(payload).digest('hex').toLowerCase();

  console.log(`Ozow hash generated for ref ${transactionRef} (site: ${siteCode})`);
  return res.json({ hash, siteCode });
});

module.exports = router;
