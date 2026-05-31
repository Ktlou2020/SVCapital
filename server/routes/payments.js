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
  // .trim() guards against accidental trailing newlines/spaces when copy-pasting into Railway env vars
  const siteCode   = (process.env.OZOW_SITE_CODE   || '').trim();
  const privateKey = (process.env.OZOW_PRIVATE_KEY || '').trim();

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

  // Ozow HashCheck spec (per official PHP SDK):
  //   lowercase(SHA512(
  //     lowercase(siteCode) + lowercase(countryCode) + lowercase(currencyCode) +
  //     lowercase(amount) + lowercase(transactionRef) + lowercase(bankRef) +
  //     lowercase(cancelUrl) + lowercase(errorUrl) + lowercase(successUrl) +
  //     lowercase(isTest) + privateKey   ← private key appended as-is, NOT lowercased
  //   ))
  const lc = v => String(v).toLowerCase();
  const payload =
    lc(siteCode) + lc(countryCode) + lc(currencyCode) +
    lc(amount) + lc(transactionRef) + lc(bankRef) +
    lc(cancelUrl) + lc(errorUrl) + lc(successUrl) +
    lc(String(isTest)) + privateKey;  // privateKey used verbatim

  const hash = crypto.createHash('sha512').update(payload).digest('hex').toLowerCase();

  // Debug — visible in Railway logs to diagnose mismatches (private key not logged)
  console.log('[Ozow] hash inputs:', {
    siteCode,
    countryCode,
    currencyCode,
    amount,
    transactionRef,
    bankRef,
    cancelUrl,
    errorUrl,
    successUrl,
    isTest: String(isTest),
    privateKeyLen: privateKey.length,
    hash,
  });

  return res.json({ hash, siteCode });
});

module.exports = router;
