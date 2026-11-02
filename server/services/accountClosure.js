'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   What has to be settled before an account can be closed.

   POPIA gives a person the right to have their data erased, and this
   platform honours it by anonymising rather than deleting — the transaction
   history stays, because an FSP is required to keep it, and the name on it
   does not.

   What the endpoint did NOT do was look at whether the person still had
   anything here. It checked a confirmation string and anonymised, and then
   told them "active investments will continue until maturity" — which is
   true and is the problem. Those investments mature into a wallet belonging
   to "Deleted User", on an email address at deleted.invalid, behind a users
   row set inactive. The maturity alert bounces. Nobody can sign in. The
   money is still theirs and they can no longer reach it.

   A STOKVEL MAKES IT WORSE, in two ways neither of which the old code knew
   existed. A member who closes their account keeps their share of the
   group's pot — the per-member ledger still owes it to a person with no
   name. And a CHAIRPERSON is the investor in sub_accounts.parent_investor_id:
   close their account and the stokvel itself is owned by an anonymised
   record, with the succession flow never run because nobody exited.

   So: erasure is a right, and it is not a way to abandon money. This lists
   what is in the way, in the person's own words, with the thing that clears
   each one. Every blocker here is something they can resolve themselves,
   which is what keeps "we refuse" from meaning "we refuse, work it out".
   ───────────────────────────────────────────────────────────────────────── */

const pool = require('../db/pool');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function rand(n) { return 'R' + round2(n).toLocaleString('en-ZA', { minimumFractionDigits: 2 }); }

/* Everything standing between this person and a closed account.

   Returns a list rather than a yes/no, because "you cannot close this" with
   no reason is the kind of answer that generates a support ticket, and all
   of these have an action the person can take today. */
async function blockersFor(db, investorId) {
  const q = (db || pool);
  const blockers = [];

  const { rows: [inv] } = await q.query(
    'SELECT wallet_balance FROM investors WHERE id = $1', [investorId]);
  if (!inv) return [{ code: 'no_such_investor', title: 'No such account.', action: null }];

  const wallet = round2(inv.wallet_balance);
  if (wallet > 0) {
    blockers.push({
      code: 'wallet_balance', amount: wallet,
      title: `${rand(wallet)} is still in your wallet.`,
      detail: 'Withdraw it before closing the account — once the account is closed '
            + 'there is no way to sign in and move it.',
      action: 'Withdraw your balance',
    });
  }

  const { rows: [investments] } = await q.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS total
       FROM investments WHERE investor_id = $1 AND status = 'active'`, [investorId]);
  if (investments.n > 0) {
    blockers.push({
      code: 'active_investments', count: investments.n, amount: round2(investments.total),
      title: `${investments.n} investment${investments.n === 1 ? '' : 's'} `
           + `of ${rand(investments.total)} ${investments.n === 1 ? 'is' : 'are'} still running.`,
      detail: 'They would mature into a wallet you can no longer sign in to. Wait for '
            + 'them to mature and withdraw, or talk to us about ending them early.',
      action: 'Wait for maturity, or contact us',
    });
  }

  const { rows: [pending] } = await q.query(
    `SELECT COUNT(*)::int AS n FROM transactions
      WHERE investor_id = $1 AND type = 'withdrawal' AND status = 'pending'`, [investorId]);
  if (pending.n > 0) {
    blockers.push({
      code: 'pending_withdrawals', count: pending.n,
      title: `${pending.n} withdrawal${pending.n === 1 ? '' : 's'} `
           + `${pending.n === 1 ? 'is' : 'are'} still being paid out.`,
      detail: 'Closing the account now would leave it with nowhere to confirm to.',
      action: 'Wait for it to clear',
    });
  }

  /* MEMBERSHIP. Their share of the pot is owed to them, and the share
     ledger has no way to express "owed to nobody". */
  const { rows: groups } = await q.query(
    `SELECT a.id, a.name
       FROM stokvel_members m
       JOIN sub_accounts a ON a.id = m.sub_account_id
      WHERE m.investor_id = $1 AND m.status = 'active' AND a.status = 'active'`,
    [investorId]);
  for (const g of groups) {
    blockers.push({
      code: 'stokvel_member', sub_account_id: g.id,
      title: `You are still a member of ${g.name}.`,
      detail: 'Your share of the pot is owed to you, and the group cannot pay it to a '
            + 'closed account. Ask to leave — the signatories approve it and you are '
            + 'paid out — and then close this account.',
      action: `Leave ${g.name}`,
    });
  }

  /* OWNERSHIP, which is not the same thing and is worse. The chairperson is
     the investor the stokvel ACCOUNT belongs to; anonymise them and the
     group's money is held under a record with nobody behind it. */
  const { rows: owned } = await q.query(
    `SELECT id, name FROM sub_accounts
      WHERE parent_investor_id = $1 AND account_type = 'stokvel' AND status = 'active'`,
    [investorId]);
  for (const g of owned) {
    if (groups.some(x => x.id === g.id)) {
      /* Already listed as a membership, but the ownership is the harder
         half and the instruction is different, so it is said separately. */
    }
    blockers.push({
      code: 'stokvel_owner', sub_account_id: g.id,
      title: `${g.name} is held in your name.`,
      detail: 'The account itself belongs to you, so closing yours would leave the '
            + 'group’s money under a record with nobody behind it. Hand the '
            + 'chairperson’s role to another member first.',
      action: `Hand over ${g.name}`,
    });
  }

  /* An open dispute means money may still be taken back from this person. */
  const { rows: [disputes] } = await q.query(
    `SELECT COUNT(*)::int AS n FROM payment_reversals
      WHERE investor_id = $1 AND status = 'open'`, [investorId]);
  if (disputes.n > 0) {
    blockers.push({
      code: 'open_dispute', count: disputes.n,
      title: 'There is an unresolved dispute on a payment to this account.',
      detail: 'We cannot close the account while a card payment is still being '
            + 'decided. It will not take long.',
      action: 'Wait for it to be resolved',
    });
  }

  return blockers;
}

/* Everything that must be switched off at the moment of closing, beyond the
   anonymising the route already did. Small, and it exists because a card
   charged on behalf of a closed account is the one mistake that would be
   indefensible. */
async function standDown(db, investorId) {
  const q = (db || pool);
  await q.query(
    `UPDATE stokvel_members SET autopay_enabled = false, autopay_enabled_at = NULL,
            updated_at = NOW()
      WHERE investor_id = $1`, [investorId]);
  await q.query(
    `UPDATE investors SET auto_topup_enabled = false, recurring_enabled = false,
            updated_at = NOW()
      WHERE id = $1`, [investorId]);
  /* The stored card goes with the account. Keeping an authorisation that can
     be charged, against a person who has asked to be forgotten, is the
     opposite of what they asked for. */
  await q.query('DELETE FROM paystack_authorizations WHERE investor_id = $1', [investorId]);
}

module.exports = { blockersFor, standDown };
