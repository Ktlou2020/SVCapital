'use strict';

const router      = require('express').Router();
const pool        = require('../db/pool');
const emailService = require('../services/email');
const { requireAuth, requireRole } = require('../middleware/auth');
const { actorFromRequest } = require('../services/ledger');
const audit = require('../services/audit');

/* ──────────────────────────────────────────────────────────
   POST /api/waitlist/international
   No auth required — captures international prospect details
   before the platform is available in their country.
────────────────────────────────────────────────────────── */
router.post('/international', async (req, res) => {
  const stripHtml = s => String(s || '').replace(/<[^>]*>/g, '').trim().slice(0, 200);
  const safeName    = stripHtml(req.body.full_name);
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
    emailService.sendInternationalWaitlistConfirmation({
      full_name: safeName,
      email: req.body.email.trim().toLowerCase(),
      country: safeCountry,
    }).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error('[waitlist] error:', err.message);
    res.status(500).json({ error: 'Could not save your details. Please try again.' });
  }
});

/* ──────────────────────────────────────────────────────────
   POST /api/waitlist/international/announce
   Requires role: admin | director

   The message this list was collected for: registration is open where you
   are. Nothing else reaches these people — they have no account, so the
   broadcast tool, which segments INVESTORS, cannot see them.

   NOBODY IS TOLD TWICE. notified_at is stamped as each one goes, so a
   second press reaches only whoever has been added since, and a press that
   dies half way through does not re-send to the first half. `resend: true`
   is there for a genuine retry and says so in the audit line.

   It is deliberately not a free-text composer. This is one announcement
   with one meaning, and a box to type into is how a list collected for a
   single purpose becomes a mailing list.
────────────────────────────────────────────────────────── */
router.post('/international/announce',
  requireAuth, requireRole('admin', 'director'), async (req, res) => {
  const resend  = !!(req.body && req.body.resend);
  const country = String((req.body && req.body.country) || '').trim();

  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, country FROM international_waitlist
        WHERE ($1::text = '' OR country = $1)
          ${resend ? '' : 'AND notified_at IS NULL'}
        ORDER BY created_at ASC`, [country]);

    if (!rows.length) {
      return res.json({ sent: 0, failed: 0, total: 0,
        message: resend ? 'Nobody matches that filter.'
                        : 'Everybody on the list has already been told.' });
    }

    let sent = 0, failed = 0;
    for (const r of rows) {
      try {
        await emailService.sendInternationalSignupOpen(r);
        await pool.query(
          'UPDATE international_waitlist SET notified_at = NOW() WHERE id = $1', [r.id]);
        sent++;
      } catch (err) {
        failed++;
        console.error('[waitlist announce] failed for one recipient:', err.message);
      }
    }

    const actor = actorFromRequest(req, 'staff');
    await audit.log({
      actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
      action: 'waitlist.international_announced', entityType: 'international_waitlist',
      entityId: country || 'all',
      description: `Told ${sent} international prospect(s) that registration is open`
                 + (country ? ` (${country})` : '') + (failed ? `; ${failed} failed` : '')
                 + (resend ? ' — RESEND, including people already told' : ''),
      ip: actor.ip,
    }).catch(() => {});

    res.json({ sent, failed, total: rows.length });
  } catch (err) {
    console.error('[waitlist announce]', err.message);
    res.status(500).json({ error: 'Could not send the announcement.' });
  }
});

module.exports = router;
