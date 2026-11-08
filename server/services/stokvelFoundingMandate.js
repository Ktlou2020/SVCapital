'use strict';
/* ═══════════════════════════════════════════════════════════
   The FIRST mandate — the one no signatory can approve, because there are
   none yet.

   stokvelMandateChange handles every mandate after the first, and justifies
   itself like this: "anything a mandate change makes possible, the
   signatories who approve it could already do... letting that same quorum
   change who signs grants nobody a power they did not hold."

   THAT ARGUMENT COLLAPSES FOR THE FOUNDING MANDATE. A new group has no
   signatories, so no existing quorum bounds the change. Until now the answer
   was that staff typed it into the console against the group's constitution —
   safe, and a queue, and the thing that stopped a committee running its own
   group.

   SO THE CHECK IS NOT A VOTE. IT IS CONSENT AT THE POINT OF JOINING.
   Nobody's money is in a group until they accept an invitation, and an
   invitation now carries the mandate in full: how many signatories must
   approve before money moves, how the pot divides, any date the money is
   locked until, and whether THIS person is being asked to be a signatory.
   The founder sets the rules; everybody else agrees to them by joining a
   group whose rules they were shown. That is how a stokvel adopts a
   constitution at its first meeting, and it is the only authority available
   before there is a quorum.

   ── WHAT AN INVITATION STILL DOES NOT DO ──────────────────────────────

   CONFER SIGNATORY STATUS. Terms 26.3: "An invitation does not confer
   signatory status or any office." So an invitation carries a NOMINATION,
   which is disclosure, and the nominee becomes a signatory only by their own
   act afterwards — confirming an appointment they can read before accepting.
   Nothing somebody else does makes a person a signatory.

   ── THE FOUNDING WINDOW CLOSES, AND NEVER REOPENS ─────────────────────

   A nomination confers on confirmation only while the group has never had a
   full mandate. The moment confirmed signatories reach the quorum,
   mandate_adopted_at is stamped and the window shuts for good.

   It is a STAMP rather than a count for one reason: a count would reopen.
   If "founding" meant "fewer signatories than the quorum", then a group that
   lost a signatory to an exit would be back in its founding window, and the
   chairperson could nominate a replacement who confirms themselves in —
   appointing a signatory without the vote, which is the whole thing this
   exists to prevent. After adoption, signatories change by vote only.
   ═══════════════════════════════════════════════════════════ */

const mandate = require('./stokvelMandate');

const SHARE_BASES = ['contribution', 'equal'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COMMITTEE = ['chairperson', 'secretary', 'treasurer'];

/* A lock date is a calendar date the group reads off a calendar, so "the
   future" is judged on the South African business day — the same clock the
   schedules are pinned to. */
function todaySast() {
  return new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

/* Where a group stands: whether it has agreed a mandate, whether the founding
   window is still open, and how many confirmations it is still waiting for.
   One function, so a screen and a guard cannot disagree about it. */
async function state(db, group) {
  const { rows: [c] } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE is_signatory AND status = 'active')::int AS signatories,
            COUNT(*) FILTER (WHERE status = 'active')::int                  AS members,
            COUNT(*) FILTER (WHERE status = 'active'
                               AND NOT is_signatory
                               AND signatory_nominated_at IS NOT NULL)::int  AS awaiting
       FROM stokvel_members WHERE sub_account_id = $1`, [group.id]);
  const quorum = Number(group.stokvel_quorum) || null;
  const adopted = !!group.mandate_adopted_at;
  return {
    has_mandate:   quorum !== null,
    adopted,
    /* Open until the mandate has ever been complete. See the header. */
    founding:      quorum !== null && !adopted,
    needs_mandate: quorum === null,
    quorum,
    signatories:   c.signatories,
    members:       c.members,
    awaiting_confirmation: c.awaiting,
    short_by: quorum === null ? null : Math.max(0, quorum - c.signatories),
  };
}

/* ── Setting it, once ────────────────────────────────────────────────
   The numbers only: how many must approve, how the pot divides, and any date
   the money is locked until. WHO signs is not set here, because nobody can
   be made a signatory by somebody else — see the header. */
async function setFounding(client, group, callerId, body) {
  const st = await state(client, group);
  if (!st.needs_mandate) {
    return { status: 409, error: 'This group already has a mandate. Changing it is a '
           + 'mandate change the signatories vote on, in the Approvals section.' };
  }

  /* The committee, as everywhere else: whoever opened the account, or a
     member holding an office. Not every member — the mandate is the rule
     book, and "any member may write it" is not a door a savings club wants
     open before anybody has joined. */
  const mine = group.my_role || (group.i_opened_it ? 'chairperson' : null);
  if (!group.i_opened_it && !COMMITTEE.includes(mine)) {
    return { status: 403, error: 'The chairperson, secretary or treasurer sets the group’s '
           + 'first mandate.' };
  }

  const quorum = parseInt(body && body.quorum, 10);
  if (!Number.isFinite(quorum)) {
    return { status: 400, error: 'How many signatories must approve before money leaves?' };
  }
  if (quorum < mandate.MIN_QUORUM) {
    return { status: 400, error: `At least ${mandate.MIN_QUORUM} signatories must approve `
           + 'before money moves. A mandate of one is not a mandate.' };
  }
  /* An upper bound as well as a lower one. A quorum of nine in a group that
     will never have nine signatories is a group that can never move its own
     money, and it would discover that only when it tried. */
  if (quorum > 20) {
    return { status: 400, error: 'That is more approvals than a group of this size can give. '
           + 'Twenty is the most.' };
  }

  const basis = String((body && body.share_basis) || 'contribution').trim().toLowerCase();
  if (!SHARE_BASES.includes(basis)) {
    return { status: 400, error: 'How the pot divides must be by contribution or equally.' };
  }

  let lock = (body && body.lock_date) ? String(body.lock_date).trim() : null;
  if (lock && !ISO_DATE.test(lock)) {
    return { status: 400, error: 'A lock date must be written as YYYY-MM-DD.' };
  }
  if (lock && lock <= todaySast()) {
    return { status: 400, error: 'A lock date has to be in the future.' };
  }

  await client.query(
    `UPDATE sub_accounts
        SET stokvel_quorum = $2, share_basis = $3, withdrawal_date = $4, updated_at = NOW()
      WHERE id = $1`, [group.id, quorum, basis, lock]);

  /* Whoever set it is a member already (the chairperson row is written when
     the group is created), so they can be nominated as a signatory without
     anybody else's say — a nomination is not an appointment, and they still
     have to confirm it like everybody else. */
  if (body && body.nominate_me) {
    await client.query(
      `UPDATE stokvel_members
          SET signatory_nominated_at = COALESCE(signatory_nominated_at, NOW()),
              updated_at = NOW()
        WHERE sub_account_id = $1 AND investor_id = $2 AND status = 'active'`,
      [group.id, callerId]);
  }

  return { ok: true, mandate: { quorum, share_basis: basis, lock_date: lock } };
}

/* ── Confirming an appointment, which only the nominee can do ────────── */
async function confirmSignatory(client, group, investorId) {
  const st = await state(client, group);
  if (st.needs_mandate) {
    return { status: 409, error: 'This group has not agreed a mandate yet.' };
  }
  if (!st.founding) {
    return { status: 409, error: 'This group’s mandate is in force. Adding a signatory is '
           + 'now a mandate change the signatories vote on, in the Approvals section.' };
  }

  const { rows: [me] } = await client.query(
    `SELECT is_signatory, signatory_nominated_at, status
       FROM stokvel_members
      WHERE sub_account_id = $1 AND investor_id = $2 FOR UPDATE`, [group.id, investorId]);
  if (!me || me.status !== 'active') {
    return { status: 403, error: 'Only an active member of this group can do that.' };
  }
  if (me.is_signatory) return { status: 409, error: 'You are already a signatory of this group.' };
  if (!me.signatory_nominated_at) {
    return { status: 403, error: 'You have not been asked to be a signatory of this group.' };
  }

  await client.query(
    `UPDATE stokvel_members SET is_signatory = true, updated_at = NOW()
      WHERE sub_account_id = $1 AND investor_id = $2`, [group.id, investorId]);

  /* Re-counted after the write, inside the same transaction, because two
     nominees confirming at the same moment must not both read "one short"
     and leave the window open on a mandate that is already complete. */
  const after = await state(client, group);
  let adopted = false;
  if (after.signatories >= after.quorum) {
    await client.query(
      `UPDATE sub_accounts SET mandate_adopted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND mandate_adopted_at IS NULL`, [group.id]);
    adopted = true;
  }
  return { ok: true, adopted, signatories: after.signatories, quorum: after.quorum };
}

/* What an invitation has to say, so somebody can read the rules before they
   agree to them. Returned to the accept screen and put into the message. */
function disclosure(group) {
  const quorum = Number(group.stokvel_quorum) || null;
  return {
    quorum,
    share_basis: group.share_basis || 'contribution',
    lock_date: group.withdrawal_date
      ? new Date(group.withdrawal_date).toISOString().slice(0, 10) : null,
  };
}

/* One sentence a person can read in an SMS. Deliberately not a summary of
   the account — the one thing somebody joining has to know is how many
   people it takes to move the money they are about to put in. */
function disclosureLine(d, asSignatory) {
  if (!d.quorum) return 'This group has not agreed its signing rules yet.';
  const bits = [`${d.quorum} signatories must approve before any money leaves`];
  bits.push(d.share_basis === 'equal' ? 'the pot divides equally'
                                      : 'the pot divides by what each member has paid in');
  if (d.lock_date) bits.push(`the money is locked until ${d.lock_date}`);
  let s = bits.join('; ') + '.';
  if (asSignatory) s += ' You are being asked to be one of the signatories.';
  return s;
}

module.exports = { state, setFounding, confirmSignatory, disclosure, disclosureLine,
                   SHARE_BASES, COMMITTEE };
