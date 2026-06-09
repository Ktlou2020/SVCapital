'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');

/* ──────────────────────────────────────────────────────────
   POST /api/waitlist/international
   No auth required — captures international prospect details
   before the platform is available in their country.
────────────────────────────────────────────────────────── */
router.post('/international', async (req, res) => {
  const { full_name, email, country } = req.body;

  if (!full_name || !full_name.trim())
    return res.status(400).json({ error: 'Full name is required.' });
  if (!email || !email.includes('@'))
    return res.status(400).json({ error: 'A valid email address is required.' });
  if (!country || !country.trim())
    return res.status(400).json({ error: 'Country of residence is required.' });

  try {
    await pool.query(
      `INSERT INTO international_waitlist (full_name, email, country)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name, country = EXCLUDED.country`,
      [full_name.trim(), email.trim().toLowerCase(), country.trim()]
    );
    console.log(`[waitlist] ${email} (${country}) added to international waitlist`);
    res.json({ success: true });
  } catch (err) {
    console.error('[waitlist] error:', err.message);
    res.status(500).json({ error: 'Could not save your details. Please try again.' });
  }
});

module.exports = router;
