'use strict';
/* ═══════════════════════════════════════════════════════════
   Proposals — the group's vote before the signatories' approval.

   The rule, decided once here:

     · Every ACTIVE member has one vote: yes, no or abstain. A member may
       change their vote while the proposal is open; the key keeps it to
       one row each.
     · It CARRIES the moment yes votes are more than half of the active
       members — nothing anybody still to vote could change that.
     · It is DEFEATED early only when it could not carry even at the close:
       when yes votes plus everybody still to vote would not beat no.
     · When it closes with neither certain, it carries if yes beats no
       among those who voted, and is defeated otherwise. Abstentions count
       as having voted and favour neither side.

   A carried proposal is a decision, not an authority. It can be turned into
   an investment request, once, and the signatories approve that to the
   quorum as they would any other.
   ═══════════════════════════════════════════════════════════ */

const VOTES = ['yes', 'no', 'abstain'];
const MIN_DAYS = 1, MAX_DAYS = 30, DEFAULT_DAYS = 7;

async function activeMembers(client, groupId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM stokvel_members
      WHERE sub_account_id = $1 AND status = 'active'`, [groupId]);
  return rows[0].n;
}

async function tally(client, proposalId, groupId) {
  /* Only votes from people who are still active members count. Somebody who
     has left the group no longer decides what it does. */
  const { rows } = await client.query(
    `SELECT v.vote, COUNT(*)::int AS n
       FROM stokvel_proposal_votes v
       JOIN stokvel_members m ON m.investor_id = v.investor_id
                             AND m.sub_account_id = $2 AND m.status = 'active'
      WHERE v.proposal_id = $1
      GROUP BY v.vote`, [proposalId, groupId]);
  const t = { yes: 0, no: 0, abstain: 0 };
  for (const r of rows) t[r.vote] = r.n;
  t.members = await activeMembers(client, groupId);
  t.voted = t.yes + t.no + t.abstain;
  t.needed = Math.floor(t.members / 2) + 1;
  return t;
}

/* What the tally makes of an open proposal: 'carried', 'defeated' or null
   while it is still undecided. */
function outcome(t, closed) {
  if (t.yes >= t.needed) return 'carried';
  if (closed) return t.yes > t.no ? 'carried' : 'defeated';
  /* Defeated early only when it could not carry even at the close: every
     member still to vote voting yes would not put yes ahead of no. */
  const outstanding = Math.max(0, t.members - t.voted);
  if (t.yes + outstanding <= t.no) return 'defeated';
  return null;
}

/* Bring an open proposal up to date and store the result if it has one.
   Returns the proposal's status after settling. */
async function settle(client, proposal) {
  if (proposal.status !== 'open') return proposal.status;
  const t = await tally(client, proposal.id, proposal.sub_account_id);
  const closed = new Date(proposal.closes_at) <= new Date();
  const result = outcome(t, closed);
  if (!result) return 'open';
  await client.query(
    `UPDATE stokvel_proposals SET status = $2, decided_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'open'`, [proposal.id, result]);
  return result;
}

function parseNew(body) {
  const b = body || {};
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) return { error: 'Say what the group is being asked to decide.' };
  const details = String(b.details || '').trim().slice(0, 1000) || null;
  const amount = (b.amount === undefined || b.amount === null || b.amount === '')
    ? null : Math.round((parseFloat(b.amount) || 0) * 100) / 100;
  if (amount !== null && !(amount > 0)) return { error: 'An amount, if given, must be more than zero.' };
  const poolId = String(b.pool_id || '').trim() || null;
  if (poolId && amount === null) return { error: 'A proposal to invest in a pool needs an amount.' };
  let days = b.closes_in_days === undefined ? DEFAULT_DAYS : parseInt(b.closes_in_days, 10);
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
    return { error: `Voting can stay open for ${MIN_DAYS} to ${MAX_DAYS} days.` };
  }
  return { proposal: { title, details, amount, pool_id: poolId, days } };
}

module.exports = { VOTES, tally, outcome, settle, parseNew, activeMembers };
