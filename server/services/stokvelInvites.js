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
/* A phone number, canonically.
 *
 * THIS KEPT THE LAST NINE DIGITS AND NOTHING ELSE. That is a South African
 * heuristic: it makes 061 420 7723 and +27 61 420 7723 the same number,
 * which is right, by throwing away the country code — which is not. Nine
 * digits do not identify a person on earth, and +44 7614 207723 has the
 * same last nine as 061 420 7723.
 *
 * An invitation is found by matching the contact it was sent to against the
 * contacts on the signed-in account, so a collision is not a cosmetic
 * problem: it shows one client another client's invitation to a savings
 * group, and the Accept button beside it works. It took international
 * sign-up being open to make that reachable, which is exactly when it was
 * reported.
 *
 * The country code is kept now. South Africa's two ways of writing the same
 * number are still reconciled, explicitly, because that is a real
 * equivalence rather than a side effect of truncation.
 */
function normCell(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);              // 0027… — the long way to write +27
  if (d.length === 10 && d[0] === '0') d = '27' + d.slice(1);   // 0XX XXX XXXX, South African
  else if (d.length === 9) d = '27' + d;               // a bare SA national number
  /* A foreign number keeps its own leading zero if that is how it was
     given: 07614 207723 is a UK number, not a South African one, and
     forcing it to +27 is the same mistake in the other direction. */
  return d.length >= 10 ? d : null;
}

/* Every form of a number an invitation might be STORED under.
 *
 * Invitations written before the fix hold the nine-digit tail, and a live
 * invitation must not stop being findable because the rule improved. So a
 * South African number also matches its own legacy tail — and only a South
 * African one, which is the whole point: a foreign number contributes no
 * nine-digit key and therefore cannot collide with a legacy South African
 * row. Once setup.js has rewritten the stored rows this is belt and braces.
 */
function cellKeys(raw) {
  const c = normCell(raw);
  if (!c) return [];
  return c.startsWith('27') && c.length === 11 ? [c, c.slice(2)] : [c];
}

/* The same canonicalisation, in SQL, for the one query that has to apply it
 * to a column instead of a value.
 *
 * Exported rather than written out at the call site: the rule above and a
 * hand-copy of it in a WHERE clause is two definitions of "the same number",
 * and the copy is what was wrong — it compared RIGHT(digits, 9), so an
 * investor in another country whose number ends the same way WAS the person
 * being invited as far as that lookup was concerned.
 */
function canonicalCellSQL(col) {
  const d = `REGEXP_REPLACE(COALESCE(${col}, ''), '\\D', '', 'g')`;
  return `CASE
            WHEN LENGTH(${d}) = 10 AND LEFT(${d}, 1) = '0' THEN '27' || SUBSTRING(${d} FROM 2)
            WHEN LENGTH(${d}) = 9                          THEN '27' || ${d}
            ELSE ${d}
          END`;
}

/* A number a telephone can ring.
 *
 * Invitations are stored canonically — digits, country code, no plus — which
 * is right for comparing and wrong for dialling. This was done inline in
 * stokvelNotify and knew only the old nine-digit form, so once the stored
 * form gained its country code the SMS went to a number with no plus on it.
 */
function dialable(cell) {
  const d = String(cell || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 9) return '0' + d;          // legacy rows: a bare SA national number
  if (d[0] === '0')   return d;                // already national, foreign or otherwise
  return '+' + d;
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
/* asSignatory is a NOMINATION and confers nothing. Terms 26.3: "An
   invitation does not confer signatory status or any office." It is carried
   so the invitation can SAY who is being asked — somebody deciding whether
   to put their savings in a group is entitled to know whether they are also
   being asked to sign for it — and the nominee becomes a signatory only by
   their own later act. See services/stokvelFoundingMandate. */
async function create(client, group, invitedBy, { name, email, cell, asSignatory }) {
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
         OR ($2::text IS NOT NULL AND ${canonicalCellSQL('phone')} = $2)
      LIMIT 1`, [e, c]);
  const who = matched[0] || null;

  if (who) {
    const { rows: already } = await client.query(
      `SELECT status FROM stokvel_members WHERE sub_account_id = $1 AND investor_id = $2`,
      [group.id, who.id]);
    if (already.length && already[0].status === 'active') {
      return { status: 409, error: `${who.first_name || 'That person'} is already a member of this group.` };
    }
    if (who.id === invitedBy) {
      return { status: 400, error: 'You are already in this group.' };
    }
  }

  const { rows: [counts] } = await client.query(
    `SELECT (SELECT COUNT(*)::int FROM stokvel_members
              WHERE sub_account_id = $1 AND status = 'active') AS members,
            (SELECT COUNT(*)::int FROM stokvel_invites
              WHERE sub_account_id = $1 AND status = 'pending'
                AND expires_at > NOW()) AS pending`, [group.id]);
  if (counts.members >= MAX_MEMBERS) {
    return { status: 409, error: `This group is at the ${MAX_MEMBERS}-member limit. Talk to us if it needs to be larger.` };
  }
  if (counts.pending >= MAX_PENDING_INVITES) {
    return { status: 429, error: `There are already ${counts.pending} invitations waiting. Give those a chance to be accepted first.` };
  }

  const id = 'SVI-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
  try {
    const { rows: [invite] } = await client.query(
      `INSERT INTO stokvel_invites
         (id, sub_account_id, invited_by, invitee_name, email, cell,
          matched_investor_id, as_signatory, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() + ($9 || ' days')::interval)
       RETURNING *`,
      [id, group.id, invitedBy, (name || '').trim().slice(0, 80) || null,
       e, c, who ? who.id : null, !!asSignatory, String(EXPIRES_DAYS)]);
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
  const c = cellKeys(investor && investor.phone);
  if (!e && !c.length) return [];
  const { rows } = await client.query(
    `SELECT v.*, a.name AS stokvel_name, a.stokvel_reg_number,
            /* The mandate, so the accept screen can state the rules the
               person is agreeing to. Before this there was nothing to show
               them: they were asked to put savings into a group without
               being told how many people it takes to move the money. */
            a.stokvel_quorum, a.share_basis, a.withdrawal_date,
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
           OR (v.cell IS NOT NULL AND v.cell = ANY($2::text[])) )
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
  const keys = cellKeys(investor.phone);
  if (invite.email && e && invite.email === e) return true;
  if (invite.cell && keys.includes(invite.cell)) return true;
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
    return { status: 409, error: `This group has reached the ${MAX_MEMBERS}-member limit since you were invited.` };
  }

  /* An invitation makes a MEMBER, never a signatory, and the values are
     written here rather than read from the invitation so that there is
     nothing to tamper with. Re-inviting somebody who left updates the row
     they already have, which is what the roster's unique index wants, and
     it deliberately does NOT restore a signatory flag they used to hold.

     THE ONE THING TAKEN FROM THE INVITATION is the nomination, and a
     nomination is not an appointment: is_signatory stays false here whatever
     the invitation said. It records that this person was ASKED, which is
     what lets them confirm it themselves afterwards and what makes the
     asking disclosable. The grant is in
     services/stokvelFoundingMandate.confirmSignatory and nowhere else. */
  await client.query(
    `INSERT INTO stokvel_members
       (id, sub_account_id, investor_id, role, is_signatory, status, invited_by, invited_at,
        joined_at, signatory_nominated_at)
     VALUES ($1,$2,$3,'member',false,'active',$4,$5,NOW(),$6)
     ON CONFLICT (sub_account_id, investor_id) DO UPDATE
        SET status = 'active', role = 'member', is_signatory = false,
            joined_at = NOW(), exited_at = NULL, updated_at = NOW(),
            signatory_nominated_at = $6`,
    ['SM-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase(),
     invite.sub_account_id, investor.id, invite.invited_by, invite.created_at,
     invite.as_signatory ? new Date().toISOString() : null]);

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
  if (!rowCount) return { status: 404, error: 'No such invitation waiting on this group.' };
  return { ok: true };
}

module.exports = {
  MAX_MEMBERS, MAX_PENDING_INVITES, EXPIRES_DAYS, COMMITTEE,
  normEmail, normCell, cellKeys, canonicalCellSQL, dialable, maskContact, mayInvite,
  create, forInvestor, addressedTo, accept, decline, revoke,
};
