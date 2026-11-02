'use strict';
/* ═══════════════════════════════════════════════════════════
   Is this request authorised?

   One definition, two callers: the approval endpoint, which needs to know
   whether a vote has just carried the request, and the withdrawal gate,
   which needs to know whether money may leave. Two copies of this would be
   two answers to the same question, and the one that disagreed would be the
   one holding the money.
   
   The rules, each of which is an attack somebody would otherwise try:
   
   · ONLY CURRENT SIGNATORIES COUNT. Not who was a signatory when they voted
     — who is one now. Otherwise the route in is: add an ally to the mandate,
     collect their approval, remove them again, withdraw. Votes are kept for
     the audit trail either way; they simply stop counting.
   · ONE VOTE EACH, enforced by a unique index rather than by counting
     carefully here.
   · ANY REJECTION KILLS IT. A mandate is not a majority — a signatory who
     says no has said no, and the request has to be raised again rather than
     out-voted.
   · THE QUORUM CAN ONLY GO UP. The request carries the quorum it was raised
     under, and the gate takes the higher of that and the stokvel's current
     one. Lowering the mandate must not release requests already in flight.
   · A MANDATE OF ONE IS NOT A MANDATE. Quorum below two is refused at the
     point a request is raised, because the whole feature is that no single
     person can do this.
   ═══════════════════════════════════════════════════════════ */

const MIN_QUORUM = 2;

/* Signatories who count right now: an active member of this stokvel whom the
   mandate names. Returns a Set of investor ids. */
async function currentSignatories(client, subAccountId) {
  const { rows } = await client.query(
    `SELECT investor_id FROM stokvel_members
      WHERE sub_account_id = $1 AND status = 'active' AND is_signatory = true`,
    [subAccountId]
  );
  return new Set(rows.map(r => r.investor_id));
}

/**
 * Where a request stands. Read-only; decides nothing and writes nothing.
 *
 * Returns { approvals, rejections, required, satisfied, reason }.
 * `satisfied` is true only when the request may release money, and `reason`
 * says why not when it is false — the string a caller can hand to a person.
 */
async function evaluate(client, request, subAccount) {
  const signatories = await currentSignatories(client, request.sub_account_id);

  const { rows: votes } = await client.query(
    `SELECT investor_id, decision FROM stokvel_request_approvals WHERE request_id = $1`,
    [request.id]
  );

  /* Votes from people who are no longer signatories are still on the record;
     they simply do not count towards anything. */
  const counted   = votes.filter(v => signatories.has(v.investor_id));
  const approvals = counted.filter(v => v.decision === 'approve').length;
  const rejections = counted.filter(v => v.decision === 'reject').length;

  /* The higher of what it was raised under and what the mandate says now. */
  const required = Math.max(
    Number(request.quorum_required) || MIN_QUORUM,
    Number(subAccount && subAccount.stokvel_quorum) || 0,
    MIN_QUORUM
  );

  let reason = null;
  if (request.status === 'used')      reason = 'That authority has already been used.';
  else if (request.status === 'rejected') reason = 'That request was rejected.';
  else if (request.status === 'expired')  reason = 'That authority has expired.';
  else if (new Date(request.expires_at) <= new Date()) reason = 'That authority has expired.';
  else if (rejections > 0)            reason = 'A signatory rejected this request.';
  else if (approvals < required)      reason = `${approvals} of ${required} signatory approvals.`;

  return { approvals, rejections, required, satisfied: reason === null, reason };
}

/**
 * The authority that releases a specific movement, or a sentence saying why
 * none does. One function for both kinds, because "is this authorised" must
 * not have two answers.
 *
 * `want` is { kind, amount, bankAccount } for a withdrawal or
 * { kind, amount, poolId } for an investment. The MATCH is the point: an
 * authority for R5 000 to one bank account must not release R5 000 to
 * another, and an authority to put R5 000 into one pool must not release it
 * into a different product. Approving a sum and letting whoever carries it
 * out choose the destination authorises nothing worth having.
 *
 * Returns { authority } or { error }. Does not consume it — the caller does
 * that inside the transaction that moves the money, so one authority cannot
 * fund two movements.
 */
async function authorityFor(client, subAccount, authorityId, want) {
  if (!authorityId) {
    if (want.kind === 'exit') {
      return { error: 'Settling a member\u2019s exit needs an approved authority. Raise the request and have the signatories approve it first.' };
    }
    if (want.kind === 'payout') {
      return { error: 'Paying the group out needs an approved authority. Plan the payout and have the signatories approve it first.' };
    }
    return { error: want.kind === 'investment'
      ? 'A stokvel investment needs an approved authority. Raise a request and have the signatories approve it first.'
      : 'A stokvel withdrawal needs an approved authority. Raise a withdrawal request and have the signatories approve it first.' };
  }
  const { rows: [authority] } = await client.query(
    `SELECT * FROM stokvel_withdrawal_requests
      WHERE id = $1 AND sub_account_id = $2 FOR UPDATE`,
    [authorityId, subAccount.id]);
  if (!authority) return { error: 'No such authority for this stokvel.' };

  /* An authority approved for one kind of movement does not release the
     other. Signatories who agreed to put money into a pool have not agreed
     to it leaving for somebody's bank account. */
  if (String(authority.kind || 'withdrawal') !== want.kind) {
    const WANTED = { investment: 'an investment', exit: 'an exit settlement',
                     payout: 'a payout to the whole group', withdrawal: 'a withdrawal' };
    return { error: `That authority was approved for a ${authority.kind || 'withdrawal'}, not ${WANTED[want.kind] || 'a withdrawal'}.` };
  }

  const state = await evaluate(client, authority, subAccount);
  if (!state.satisfied) return { error: 'That authority does not release this money: ' + state.reason };

  /* A withdrawal and an investment are approved AS A SUM, so the sum is
     matched exactly. An exit is not: "settle Nomsa's share" is inherently
     whatever her share comes to on the day, and interest arriving between
     the approval and the settlement would otherwise invalidate the authority
     and send her round the signatories again for a figure she cannot
     control. The figure on an exit request is what her share stood at when
     it was raised, shown to the signatories so they know the order of it;
     what pins an exit is WHOSE membership ends, checked below. */
  if (want.kind !== 'exit' && want.kind !== 'payout' &&
      Math.round(parseFloat(authority.amount) * 100) !== Math.round(Number(want.amount) * 100)) {
    return { error: `That authority is for R${parseFloat(authority.amount).toFixed(2)}, not R${Number(want.amount).toFixed(2)}.` };
  }

  if (want.kind === 'investment') {
    if (String(authority.pool_id || '') !== String(want.poolId || '')) {
      return { error: 'That authority was approved for a different pool.' };
    }
  } else if (want.kind === 'payout') {
    /* The signatories approve THE DISTRIBUTION, once, rather than one
       withdrawal per member. What pins it is which payout — not an amount,
       for the same reason an exit is not pinned to one: the pot on the day
       is whatever the pot is, and a figure agreed a fortnight earlier would
       send the group back round the signatories for money it has earned in
       the meantime. */
    if (String(authority.payout_id || '') !== String(want.payoutId || '')) {
      return { error: 'That authority was approved for a different payout.' };
    }
  } else if (want.kind === 'exit') {
    /* The MEMBER is the destination of an exit, in the same way a bank
       account is the destination of a withdrawal. An authority approved to
       settle one person must not settle another, or the signatories have
       authorised a sum and let the carrier choose whose membership ends. */
    if (String(authority.exit_investor_id || '') !== String(want.investorId || '')) {
      return { error: 'That authority was approved to settle a different member.' };
    }
  } else if (String(authority.bank_account_number || '').trim() !== String(want.bankAccount || '').trim()) {
    return { error: 'That authority was approved for a different bank account.' };
  }

  return { authority };
}

/* Spend it. Separate from the check so the caller does this inside the
   transaction that moves the money — an authority consumed outside it could
   be spent by a movement that then rolled back. */
async function consume(client, authority, reference) {
  await client.query(
    `UPDATE stokvel_withdrawal_requests
        SET status = 'used', used_at = NOW(), used_by_reference = $2, updated_at = NOW()
      WHERE id = $1`,
    [authority.id, reference]);
}

module.exports = { MIN_QUORUM, currentSignatories, evaluate, authorityFor, consume };
