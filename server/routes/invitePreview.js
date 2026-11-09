'use strict';
/* ═══════════════════════════════════════════════════════════
   GET /api/invite-preview/:id — what an invitation link shows, before sign-up.

   WHY A LINK AT ALL, after the invitation was deliberately sent without one.
   The reasoning then was right: "a link is a capability — forwarded once it
   shows a stranger the group's money". And most people invited to a group
   have no account, so the message told them to sign up and hope they used
   the same email address or number, then look for it on a screen they had
   never seen. The largest drop in the whole flow was there.

   So the link carries the invitation's id — and is NOT a capability:

     · IT SHOWS ONLY WHAT THE MESSAGE ALREADY SAID: the group's name, the
       first name of whoever sent it, and the signing rules. Never a balance,
       a roster, a member count or anybody's contact details. The address it
       was sent to appears masked (t*****@gmail.com, *** *** 9415), so the
       person signing up can tell which one to use.
     · IT GRANTS NOTHING. Accepting still happens signed in, and still checks
       that the signed-in person IS the email address or cell number the
       invitation was addressed to (stokvelInvites.addressedTo). A forwarded
       link lets a stranger read the group's name; it does not let them join.
     · ONLY A LIVE INVITATION ANSWERS. Accepted, declined, revoked or expired
       all read as one "not available", so the endpoint cannot be used to
       learn what became of somebody's invitation.
     · IT IS RATE-LIMITED (server/index.js), and the id is 56 random bits.
   ═══════════════════════════════════════════════════════════ */

const router = require('express').Router();
const pool   = require('../db/pool');
const { maskContact } = require('../services/stokvelInvites');
const fm     = require('../services/stokvelFoundingMandate');

const ID = /^SVI-[0-9A-F]{14}$/;
const GONE = { error: 'This invitation is no longer available. It may have expired or been withdrawn — ask whoever invited you to send another.' };

router.get('/:id', async (req, res) => {
  const id = String(req.params.id || '').toUpperCase();
  if (!ID.test(id)) return res.status(404).json(GONE);
  try {
    const { rows: [v] } = await pool.query(
      `SELECT v.email, v.cell, v.as_signatory, v.expires_at, v.matched_investor_id,
              a.name AS group_name, a.stokvel_quorum, a.share_basis, a.withdrawal_date,
              i.first_name AS invited_by_first_name
         FROM stokvel_invites v
         JOIN sub_accounts a ON a.id = v.sub_account_id
         LEFT JOIN investors i ON i.id = v.invited_by
        WHERE v.id = $1 AND v.status = 'pending' AND v.expires_at > NOW()`, [id]);
    if (!v) return res.status(404).json(GONE);
    res.set('Cache-Control', 'no-store');
    return res.json({ data: {
      group_name: v.group_name,
      invited_by: v.invited_by_first_name || 'A member',
      rules: fm.disclosureLine(fm.disclosure(v), !!v.as_signatory),
      as_signatory: !!v.as_signatory,
      email_hint: v.email ? maskContact({ email: v.email }) : null,
      cell_hint:  v.cell  ? maskContact({ cell: v.cell })   : null,
      expires_at: v.expires_at,
    } });
  } catch (err) {
    console.error('[invite-preview] failed:', err.message);
    return res.status(500).json({ error: 'Could not look up that invitation.' });
  }
});

module.exports = router;
