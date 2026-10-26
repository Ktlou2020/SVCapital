'use strict';
/* Enquiries from the institutional and private-client page.
 *
 * This is the only PUBLIC write on the platform that is not a signup, so it
 * is built as one: nothing it accepts reaches a wallet, a product or an
 * investor record. It writes a support ticket and sends an email, and that
 * is the whole of its authority.
 *
 * The three things a public write has to answer:
 *
 *   · WHO FLOODS IT. Its own rate limiter, far tighter than the platform's —
 *     a person enquiring does so once, not fifty times an hour — plus a
 *     honeypot field the page hides and a human never fills in. A honeypot
 *     hit is accepted and dropped rather than refused, because an error tells
 *     a script what to change.
 *   · WHAT IT STORES. Length caps on every field, and the text is stored as
 *     text. The console renders ticket bodies, so anything accepted here is
 *     read by staff later — see check-admin-xss, which is why none of this is
 *     interpolated as markup anywhere.
 *   · WHAT IT PROMISES. The ticket is written first and the email is
 *     best-effort after it. An enquiry that is recorded but not emailed is
 *     recoverable from the console; one that is emailed and not recorded is
 *     a person waiting on an answer nobody can see.
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');
const pool      = require('../db/pool');
const emailService = require('../services/email');

const router = express.Router();

/* Where an enquiry is sent. The address already published on the site. */
const ENQUIRY_INBOX = process.env.ENQUIRY_INBOX || 'enquiry@svcapital.co.za';

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many enquiries from this address — please email ' + ENQUIRY_INBOX + '.' },
});

const CAPS = { name: 120, organisation: 160, email: 160, phone: 40, role: 120, message: 4000 };
const clean = (v, cap) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, cap);
/* Deliberately loose. A regex that tries to be clever about addresses turns
   away real ones; this only rejects what cannot be delivered to at all. */
const looksLikeEmail = e => /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(e);

const CAPACITIES = new Set(['individual', 'institution', 'adviser', 'family_office', 'other']);
const CAPACITY_LABEL = {
  individual:    'Private individual',
  institution:   'Institution',
  adviser:       'Adviser or intermediary',
  family_office: 'Family office',
  other:         'Other',
};

router.post('/institutional', limiter, async (req, res) => {
  const b = req.body || {};

  /* The honeypot. Hidden on the page and labelled for autofill to ignore;
     only a script fills it. Answered exactly as a real submission is. */
  if (clean(b.company_website, 200)) {
    return res.json({ ok: true, reference: 'ENQ-' + Date.now().toString(36).toUpperCase() });
  }

  const name         = clean(b.name, CAPS.name);
  const organisation = clean(b.organisation, CAPS.organisation);
  const email        = clean(b.email, CAPS.email).toLowerCase();
  const phone        = clean(b.phone, CAPS.phone);
  const role         = clean(b.role, CAPS.role);
  const message      = clean(b.message, CAPS.message);
  const capacity     = CAPACITIES.has(String(b.capacity)) ? String(b.capacity) : 'other';

  if (!name)    return res.status(400).json({ error: 'A name is required.' });
  if (!email || !looksLikeEmail(email)) {
    return res.status(400).json({ error: 'An email address we can reply to is required.' });
  }
  if (!message) return res.status(400).json({ error: 'Please tell us what you would like to discuss.' });

  const reference = 'ENQ-' + Date.now().toString(36).toUpperCase();
  const subject = `Institutional enquiry — ${CAPACITY_LABEL[capacity]}` +
                  (organisation ? ` — ${organisation}` : '') + ` — ${name}`;
  const body =
    `${CAPACITY_LABEL[capacity]} enquiry from the institutional page.\n\n` +
    `Name: ${name}\n` +
    (organisation ? `Organisation: ${organisation}\n` : '') +
    (role ? `Role: ${role}\n` : '') +
    `Email: ${email}\n` +
    (phone ? `Phone: ${phone}\n` : '') +
    `Reference: ${reference}\n\n` +
    `${message}`;

  try {
    /* investor_id stays NULL: this person is not an investor, and the column
       is a foreign key — inventing an id would fail, and borrowing one would
       put a stranger's enquiry on somebody's record. */
    await pool.query(
      `INSERT INTO support_tickets
         (id, investor_id, subject, message, category, priority, status, created_at, updated_at)
       VALUES ($1, NULL, $2, $3, 'institutional_enquiry', 'high', 'open', NOW(), NOW())`,
      [reference, subject, body]);
  } catch (err) {
    console.error('[enquiries/institutional] could not record:', err.message);
    return res.status(500).json({
      error: `We could not record that. Please email ${ENQUIRY_INBOX} and we will pick it up.`,
    });
  }

  /* After the write, and never fatal: the enquiry is already safe. */
  emailService.sendAlert(
    { email: ENQUIRY_INBOX, first_name: 'SV Capital' },
    { subject, message: body }
  ).catch(err => console.error('[enquiries/institutional] email failed:', err.message));

  res.json({ ok: true, reference });
});

module.exports = router;
