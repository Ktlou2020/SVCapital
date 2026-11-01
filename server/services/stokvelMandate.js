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

module.exports = { MIN_QUORUM, currentSignatories, evaluate };
