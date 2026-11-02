'use strict';
/* ═══════════════════════════════════════════════════════════
   Joining a stokvel, without a staff member typing it in.

   THE RULE THAT MATTERS MOST, and the reason this file exists rather than
   the logic living in a route:

     AN INVITATION CAN NEVER PRODUCE A SIGNATORY.

   If a chairperson could invite somebody AND name them a signatory, they
   could manufacture a quorum out of nothing — invite two friends, sign them
   up, approve their own withdrawal — and the mandate, which is the entire
   product, would be theatre. So every membership this file creates is
   is_signatory = false, with no parameter to change that. Signing power is a
   change to the mandate: it is made by staff, against a constitution, and
   the existing signatories are the ones who live with it.

   The same logic bars role: an invitation creates a 'member'. Treasurer and
   secretary are elected offices recorded against the group's constitution,
   not something conferred by whoever sent an email.

   WHO MAY INVITE. The committee — the person who opened the account, and
   members whose role is chairperson, secretary or treasurer. Not every
   member: a stokvel wallet holds everybody's savings, and "any member can
   add anyone" is not a door a savings club wants open. They cannot grant
   anything they do not have, so this is an administrative permission rather
   than a financial one.

   THE CAPS are bounds on abuse, not product rules. An invite endpoint with
   no ceiling is an email cannon with someone else's name on it.
   ═══════════════════════════════════════════════════════════ */

const crypto = require('crypto');

/* Generous enough not to be in a real stokvel's way; low enough that the
   endpoint cannot be used to send ten thousand emails. */
const MAX_MEMBERS         = 50;
const MAX_PENDING_INVITES = 25;
const EXPIRES_DAYS        = 21;

const COMMITTEE = ['chairperson', 'secretary', 'treasurer'];

/* ── Contacts, normalised ──────────────────────────────────────────
   "The same person" has to be decidable, and 072 226 9415,
   +27 72 226 9415 and 0722269415 are the same person. The last nine digits
   are what every South African format agrees on, so that is the key. An
   email is lower-cased and trimmed and nothing else — the local part is
   case-sensitive per the RFC and ignored as such by every provider anybody
   uses, and a stokvel invitation is not where to be pedantic about it. */
function normEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e) ? e : null;
}
function normCell(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/* What a member is shown of somebody else's contact details. The roster is
   public to the group on purpose — it is what settles "who was asked" — but
   that is not a reason to publish a full address to everyone. */
function maskContact({ email, cell }) {
  if (email) {
    const [user, domain] = email.split('@');
    return `${user.slice(0, 1)}${'*'.repeat(Math.max(1, user.length - 1))}@${domain}`;
  }
  if (cell) return `*** *** ${cell.slice(-4)}`;
  return '';
}

function mayInvite(group) {
  return !!(group && (group.i_opened_it || COMMITTEE.includes(String(group.my_role || ''))));
}

/* ── Raise one ─────────────────────────────────────────────────────
   Returns { invite } or { error, status }. Every refusal is a sentence the
   person who tapped invite can act on. */
async function create(client, group, invitedBy, { name, email, cell }) {
  if (!mayInvite(group)) {
    return { status: 403, error: 'Only the chairperson, secretary or treasurer can invite members.' };
  }
  const e = normEmail(email);
  const c = normCell(cell);
  if (!e && !c) {
    return { status: 400, error: 'An email address or a cell number is needed — that is how the invitation reaches them.' };
  }
  if (email && !e) return { status: 400, error: 'That does not look like an email address.' };
  if (cell && !c)  return { status: 400, error: 'That does not look like a cell number.' };

  /* Whoever is already here. Checked against the normalised contact AND
     against the resolved account, because somebody can be a member under an
     address the inviter does not know. */
  const { rows: matched } = await client.query(
    `SELECT id, first_name, email, phone FROM investors
      WHERE ($1::text IS NOT NULL AND LOWER(email) = $1)
         OR ($2::text IS NOT NULL AND RIGHT(REGEXP_REPLACE(COALESCE(phone,''), '\\D', '', 'g'), 9) = $2)
      LIMIT 1`, [e, c]);
  const who = matched[0] || null;

  if (who) {
    const { rows: already } = await client.query(
      `SELECT status FROM stokvel_members WHERE sub_account_id = $1 AND investor_id = $2`,
      [group.id, who.id]);
    if (already.length && already[0].status === 'active') {
      return { status: 409, error: `${who.first_name || 'That person'} is already a member of this stokvel.` };
    }
    if (who.id === invitedBy) {
      return { status: 400, error: 'You are already in this stokvel.' };
    }
  }

  const { rows: [counts] } = await client.query(
    `SELECT (SELECT COUNT(*)::int FROM stokvel_members
              WHERE sub_account_id = $1 AND status = 'active') AS members,
            (SELECT COUNT(*)::int FROM stokvel_invites
              WHERE sub_account_id = $1 AND status = 'pending'
                AND expires_at > NOW()) AS pending`, [group.id]);
  if (counts.members >= MAX_MEMBERS) {
    return { status: 409, error: `This stokvel is at the ${MAX_MEMBERS}-member limit. Talk to us if it needs to be larger.` };
  }
  if (counts.pending >= MAX_PENDING_INVITES) {
    return { status: 429, error: `There are already ${counts.pending} invitations waiting. Give those a chance to be accepted first.` };
  }

  const id = 'SVI-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
  try {
    const { rows: [invite] } = await client.query(
      `INSERT INTO stokvel_invites
         (id, sub_account_id, invited_by, invitee_name, email, cell,
          matched_investor_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + ($8 || ' days')::interval)
       RETURNING *`,
      [id, group.id, invitedBy, (name || '').trim().slice(0, 80) || null,
       e, c, who ? who.id : null, String(EXPIRES_DAYS)]);
    return { invite, matched: who };
  } catch (err) {
    /* The partial unique index on live invitations. Tapping invite twice is
       the ordinary cause, and the honest answer is that it is already sent. */
    if (err.code === '23505') {
      return { status: 409, error: 'That person has already been invited and has not answered yet.' };
    }
    throw err;
  }
}

/* ── Find mine ─────────────────────────────────────────────────────
   Invitations addressed to the contacts on the signed-in account. This is
   the whole discovery mechanism: there is no link to click, so being able
   to sign in as the person who holds the contact is what proves the
   invitation is theirs. */
async function forInvestor(client, investor) {
  const e = normEmail(investor && investor.email);
  const c = normCell(investor && investor.phone);
  if (!e && !c) return [];
  const { rows } = await client.query(
    `SELECT v.*, a.name AS stokvel_name, a.stokvel_reg_number,
            i.first_name AS invited_by_name,
            (SELECT COUNT(*)::int FROM stokvel_members m
              WHERE m.sub_account_id = v.sub_account_id AND m.status = 'active') AS active_members
       FROM stokvel_invites v
       JOIN sub_accounts a ON a.id = v.sub_account_id
       LEFT JOIN investors i ON i.id = v.invited_by
      WHERE v.status = 'pending'
        AND v.expires_at > NOW()
        AND ( (v.matched_investor_id IS NOT NULL AND v.matched_investor_id = $3)
           OR ($1::text IS NOT NULL AND v.email = $1)
           OR ($2::text IS NOT NULL AND v.cell  = $2) )
        /* Somebody who is already in is not shown an invitation to join. */
        AND NOT EXISTS (SELECT 1 FROM stokvel_members m
                         WHERE m.sub_account_id = v.sub_account_id
                           AND m.investor_id = $3 AND m.status = 'active')
      ORDER BY v.created_at DESC`,
    [e, c, investor.id]);
  return rows;
}

/* Does this invitation belong to this person? The contact is re-checked
   here and not taken on trust from the invite's matched_investor_id, which
   was resolved when it was sent and could since have been pointed at
   somebody else's address. */
function addressedTo(invite, investor) {
  if (!invite || !investor) return false;
  const e = normEmail(investor.email);
  const c = normCell(investor.phone);
  if (invite.email && e && invite.email === e) return true;
  if (invite.cell  && c && invite.cell  === c) return true;
  return false;
}

/* ── Accept ────────────────────────────────────────────────────────
   The only path by which a membership is created from outside the console,
   and therefore the only place the signatory rule has to hold. It holds by
   there being no parameter for it: false and 'member', written here. */
async function accept(client, invite, investor) {
  if (!addressedTo(invite, investor)) {
    return { status: 403,
      error: `This invitation was sent to ${maskContact(invite)}. Sign in with that account, or ask whoever invited you to send it to the address you use here.` };
  }
  if (invite.status !== 'pending') {
    return { status: 409, error: `That invitation has already been ${invite.status}.` };
  }
  if (new Date(invite.expires_at) <= new Date()) {
    return { status: 409, error: 'That invitation has expired. Ask whoever invited you to send another.' };
  }
  const { rows: [counts] } = await client.query(
    `SELECT COUNT(*)::int AS members FROM stokvel_members
      WHERE sub_account_id = $1 AND status = 'active'`, [invite.sub_account_id]);
  if (counts.members >= MAX_MEMBERS) {
    return { status: 409, error: `This stokvel has reached the ${MAX_MEMBERS}-member limit since you were invited.` };
  }

  /* An invitation makes a MEMBER, never a signatory, and the values are
     written here rather than read from the invitation so that there is
     nothing to tamper with. Re-inviting somebody who left updates the row
     they already have, which is what the roster's unique index wants, and
     it deliberately does NOT restore a signatory flag they used to hold. */
  await client.query(
    `INSERT INTO stokvel_members
       (id, sub_account_id, investor_id, role, is_signatory, status, invited_by, invited_at, joined_at)
     VALUES ($1,$2,$3,'member',false,'active',$4,$5,NOW())
     ON CONFLICT (sub_account_id, investor_id) DO UPDATE
        SET status = 'active', role = 'member', is_signatory = false,
            joined_at = NOW(), exited_at = NULL, updated_at = NOW()`,
    ['SM-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase(),
     invite.sub_account_id, investor.id, invite.invited_by, invite.created_at]);

  await client.query(
    `UPDATE stokvel_invites
        SET status = 'accepted', accepted_by = $2, responded_at = NOW(), updated_at = NOW()
      WHERE id = $1`, [invite.id, investor.id]);

  return { ok: true };
}

async function decline(client, invite, investor) {
  if (!addressedTo(invite, investor)) {
    return { status: 403, error: 'That invitation is not yours to answer.' };
  }
  if (invite.status !== 'pending') {
    return { status: 409, error: `That invitation has already been ${invite.status}.` };
  }
  await client.query(
    `UPDATE stokvel_invites
        SET status = 'declined', responded_at = NOW(), updated_at = NOW()
      WHERE id = $1`, [invite.id]);
  return { ok: true };
}

async function revoke(client, group, inviteId) {
  if (!mayInvite(group)) {
    return { status: 403, error: 'Only the chairperson, secretary or treasurer can withdraw an invitation.' };
  }
  const { rowCount } = await client.query(
    `UPDATE stokvel_invites
        SET status = 'revoked', responded_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND sub_account_id = $2 AND status = 'pending'`,
    [inviteId, group.id]);
  if (!rowCount) return { status: 404, error: 'No such invitation waiting on this stokvel.' };
  return { ok: true };
}

module.exports = {
  MAX_MEMBERS, MAX_PENDING_INVITES, EXPIRES_DAYS, COMMITTEE,
  normEmail, normCell, maskContact, mayInvite,
  create, forInvestor, addressedTo, accept, decline, revoke,
};
