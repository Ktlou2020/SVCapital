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
 * Body: { siteCode, countryCode, currencyCode, amount,
 *         transactionRef, bankRef, cancelUrl, errorUrl, successUrl, isTest }
 * Returns: { hash }
 *
 * Ozow HashCheck = lowercase(SHA512(
 *   SiteCode + CountryCode + CurrencyCode + Amount +
 *   TransactionReference + BankReference +
 *   CancelUrl + ErrorUrl + SuccessUrl + IsTest +
 *   PrivateKey
 * ))
 */
router.post('/ozow-hash', requireAuth, (req, res) => {
  const privateKey = process.env.OZOW_PRIVATE_KEY;
  if (!privateKey) {
    return res.status(503).json({ error: 'Ozow private key not configured on server.' });
  }

  const {
    siteCode, countryCode, currencyCode, amount,
    transactionRef, bankRef, cancelUrl, errorUrl, successUrl, isTest,
  } = req.body;

  if (!siteCode || !amount || !transactionRef || !successUrl) {
    return res.status(400).json({ error: 'Missing required Ozow hash fields.' });
  }

  const payload = [
    siteCode,
    countryCode || 'ZA',
    currencyCode || 'ZAR',
    amount,
    transactionRef,
    bankRef || '',
    cancelUrl || '',
    errorUrl || '',
    successUrl,
    String(isTest),
    privateKey,
  ].join('');

  const hash = crypto.createHash('sha512').update(payload).digest('hex').toLowerCase();
  return res.json({ hash });
});

module.exports = router;
