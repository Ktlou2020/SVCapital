'use strict';
/* ═══════════════════════════════════════════════════════════
   Changing the mandate, without a staff member typing it in.

   Until now a group that elected a new treasurer, wanted three signatures
   instead of two, or wanted its money locked until December had to send a
   constitution to SV Capital and wait for somebody in the console to tick
   is_signatory. Safe, and a queue: at a few hundred groups it is a job, at
   twenty thousand it is a department.

   Now the group asks for the change itself, as a request of kind 'mandate',
   and THE SIGNATORIES APPROVE IT LIKE MONEY. It rides the same table, the
   same votes, the same evaluate() and the same "one rejection ends it" rule
   as a withdrawal, because a change to who may approve withdrawals is as
   serious as a withdrawal.

   WHY THIS DOES NOT WEAKEN THE MANDATE. Anything a mandate change makes
   possible, the signatories who approve it could already do: a quorum that
   can approve a change could equally approve taking every rand out. So
   letting that same quorum change who signs grants nobody a power they did
   not hold. What it must never do is let FEWER people than the quorum
   change it, and every rule below is a way of making sure of that:

   · THE QUORUM APPROVES IT, counted by mandate.evaluate exactly as for money
     — current signatories only, one vote each, any rejection kills it, and
     the bar is the higher of the quorum it was raised under and today's.
   · NOBODY VOTES ON THEIR OWN REMOVAL. A signatory being removed could
     otherwise keep their seat by rejecting. Their vote is refused, so the
     others must carry it without them.
   · THE RESULT MUST BE A MANDATE. A quorum below two, or more signatures
     required than there are signatories, is refused when the change is
     raised AND re-checked when it is applied, because the roster can move
     in between.
   · ONLY AN ACTIVE MEMBER CAN BE MADE A SIGNATORY. An invitation still never
     produces one (stokvelInvites); a person has to have joined first.
   · A LOCK DATE CAN BE SET, MOVED OR CLEARED, but only this way. Bringing it
     forward releases money earlier than the group agreed, which is exactly
     the kind of thing one person must not do alone.

   It is APPLIED IN THE TRANSACTION OF THE VOTE THAT CARRIES IT and the
   request is marked used, so an approved change cannot sit waiting for
   somebody to press a second button, and cannot be applied twice.
   ═══════════════════════════════════════════════════════════ */

const mandate = require('./stokvelMandate');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* Today in South Africa, as YYYY-MM-DD. A lock date is a calendar date the
   group reads off a calendar, so "the future" is judged in SAST. */
function todaySast() {
  return new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

async function _name(client, investorId) {
  const { rows } = await client.query(
    `SELECT first_name, last_name FROM investors WHERE id = $1`, [investorId]);
  return rows[0] ? [rows[0].first_name, rows[0].last_name].filter(Boolean).join(' ') : investorId;
}

/**
 * Read the change a caller asked for out of a request body. Pure shape
 * checking; validate() decides whether it is allowed.
 * Returns { change } or { error }.
 */
function parse(body) {
  const b = body || {};
  const str = v => (v === undefined || v === null) ? '' : String(v).trim();
  const change = {
    add_signatory:    str(b.add_signatory) || null,
    remove_signatory: str(b.remove_signatory) || null,
    quorum:           (b.quorum === undefined || b.quorum === null || b.quorum === '')
                        ? null : Number(b.quorum),
    lock_date:        str(b.lock_date) || null,
    clear_lock:       b.clear_lock === true || b.clear_lock === 'true',
  };
  if (change.quorum !== null && !Number.isInteger(change.quorum)) {
    return { error: 'The number of approvals must be a whole number.' };
  }
  if (change.lock_date && !ISO_DATE.test(change.lock_date)) {
    return { error: 'A lock date must be a date (YYYY-MM-DD).' };
  }
  if (change.lock_date && change.clear_lock) {
    return { error: 'Set a lock date or clear it, not both.' };
  }
  if (change.add_signatory && change.add_signatory === change.remove_signatory) {
    return { error: 'The same person cannot be added and removed in one change.' };
  }
  if (!change.add_signatory && !change.remove_signatory && change.quorum === null
      && !change.lock_date && !change.clear_lock) {
    return { error: 'Say what should change: a signatory, the number of approvals, or the lock date.' };
  }
  return { change };
}

/**
 * Is this change allowed against the group as it stands right now?
 * Returns { ok: true, result, summary } or { error }.
 * `result` is the mandate the group would have afterwards.
 */
async function validate(client, group, change) {
  const sigs = await mandate.currentSignatories(client, group.id);
  const after = new Set(sigs);

  if (change.add_signatory) {
    const { rows } = await client.query(
      `SELECT 1 FROM stokvel_members
        WHERE sub_account_id = $1 AND investor_id = $2 AND status = 'active'`,
      [group.id, change.add_signatory]);
    if (!rows.length) return { error: 'Only an active member of the group can be made a signatory.' };
    if (sigs.has(change.add_signatory)) return { error: 'That member is already a signatory.' };
    after.add(change.add_signatory);
  }
  if (change.remove_signatory) {
    if (!sigs.has(change.remove_signatory)) return { error: 'That person is not a signatory.' };
    after.delete(change.remove_signatory);
  }

  const quorumNow = Number(group.stokvel_quorum) || 0;
  const quorumAfter = change.quorum !== null ? change.quorum : quorumNow;
  if (quorumAfter < mandate.MIN_QUORUM) {
    return { error: `At least ${mandate.MIN_QUORUM} signatories must approve before money moves. A mandate of one is not a mandate.` };
  }
  if (quorumAfter > after.size) {
    return { error: `That would need ${quorumAfter} approvals from ${after.size} signator${after.size === 1 ? 'y' : 'ies'}, so nothing could ever be approved.` };
  }

  if (change.lock_date && change.lock_date <= todaySast()) {
    return { error: 'A lock date must be in the future.' };
  }

  const parts = [];
  if (change.add_signatory)    parts.push(`make ${await _name(client, change.add_signatory)} a signatory`);
  if (change.remove_signatory) parts.push(`remove ${await _name(client, change.remove_signatory)} as a signatory`);
  if (change.quorum !== null && change.quorum !== quorumNow) {
    parts.push(`require ${change.quorum} approvals instead of ${quorumNow || 'none'}`);
  }
  if (change.lock_date) parts.push(`lock the group’s money until ${change.lock_date}`);
  if (change.clear_lock) parts.push('remove the lock date');
  if (!parts.length) return { error: 'That is the mandate the group already has.' };

  return {
    ok: true,
    result: { signatories: after.size, quorum: quorumAfter },
    summary: parts.join(', '),
  };
}

/* The change a stored request carries, whether node-postgres handed it back
   parsed or as text. */
function changeOf(request) {
  const c = request && request.mandate_change;
  if (!c) return null;
  if (typeof c === 'string') { try { return JSON.parse(c); } catch (_) { return null; } }
  return c;
}

/* May this person vote on this request? Only refuses the one case the
   general mandate does not cover: a signatory voting on their own removal. */
function voteRefusal(request, voterId) {
  if (String(request.kind) !== 'mandate') return null;
  const c = changeOf(request);
  if (c && c.remove_signatory && c.remove_signatory === voterId) {
    return 'You cannot vote on your own removal as a signatory. The other signatories decide it.';
  }
  return null;
}

/**
 * Put an approved change into force. Call inside the transaction of the vote
 * that carried it, with the request row locked. Re-validates first, because
 * the roster can have moved since the change was raised.
 * Returns { applied: true, summary } or { error }.
 */
async function apply(client, group, request) {
  const change = changeOf(request);
  if (!change) return { error: 'That request carries no change to the mandate.' };
  const v = await validate(client, group, change);
  if (v.error) return { error: 'The change can no longer be made: ' + v.error };

  if (change.add_signatory) {
    await client.query(
      `UPDATE stokvel_members SET is_signatory = true, updated_at = NOW()
        WHERE sub_account_id = $1 AND investor_id = $2 AND status = 'active'`,
      [group.id, change.add_signatory]);
  }
  if (change.remove_signatory) {
    await client.query(
      `UPDATE stokvel_members SET is_signatory = false, updated_at = NOW()
        WHERE sub_account_id = $1 AND investor_id = $2`,
      [group.id, change.remove_signatory]);
  }
  if (change.quorum !== null) {
    await client.query(
      `UPDATE sub_accounts SET stokvel_quorum = $2, updated_at = NOW() WHERE id = $1`,
      [group.id, change.quorum]);
  }
  if (change.lock_date || change.clear_lock) {
    await client.query(
      `UPDATE sub_accounts SET withdrawal_date = $2, updated_at = NOW() WHERE id = $1`,
      [group.id, change.clear_lock ? null : change.lock_date]);
  }
  await client.query(
    `UPDATE stokvel_withdrawal_requests
        SET status = 'used', used_at = NOW(), used_by_reference = 'MANDATE-CHANGE', updated_at = NOW()
      WHERE id = $1`, [request.id]);
  return { applied: true, summary: v.summary };
}

module.exports = { parse, validate, apply, voteRefusal, changeOf, todaySast };
