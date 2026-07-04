'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');

/* ──────────────────────────────────────────────────────────
   POST /api/waitlist/international
   No auth required — captures international prospect details
   before the platform is available in their country.
────────────────────────────────────────────────────────── */
router.post('/international', async (req, res) => {
  const stripHtml = s => String(s || '').replace(/<[^>]*>/g, '').trim().slice(0, 200);
  const safeName = stripHtml(req.body.full_name);
  const safeCountry = stripHtml(req.body.country);

  if (!safeName)
    return res.status(400).json({ error: 'Full name is required.' });
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!req.body.email || !emailRegex.test(req.body.email) || req.body.email.length > 254) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (!safeCountry)
    return res.status(400).json({ error: 'Country of residence is required.' });

  try {
    await pool.query(
      `INSERT INTO international_waitlist (full_name, email, country)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name, country = EXCLUDED.country`,
      [safeName, req.body.email.trim().toLowerCase(), safeCountry]
    );
    console.log('[waitlist]', JSON.stringify({ email: req.body.email, country: req.body.country }));
    res.json({ success: true });
  } catch (err) {
    console.error('[waitlist] error:', err.message);
    res.status(500).json({ error: 'Could not save your details. Please try again.' });
  }
});

module.exports = router;
