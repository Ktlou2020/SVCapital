'use strict';
/* ═══════════════════════════════════════════════════════════
   CASH, WHICH IS HOW A STOKVEL ACTUALLY COLLECTS.

   A stokvel meets and money changes hands in the room. Until now a member
   could pay only from their own SV Capital wallet, so a fifteen-year-old
   burial society could not move onto the platform without converting every
   member to a card on day one — which is never day one. Mama Dlamini put
   R500 on the table and nothing could record it: her row stayed overdue,
   the arrears list lied to the committee, the reminder chased a woman who
   had paid, and her share was understated at the payout.

   TWO STEPS, AND THE SPLIT BETWEEN THEM IS THE WHOLE DESIGN.

   RECORDING is a record, not a credit. The platform does not hold that
   R500 — it is in the treasurer's hands — and a share ledger that counted
   money SV Capital does not hold would be false in the one way this ledger
   must never be false. So recording moves nothing and allocates nothing.
   What it changes is what the member's row SAYS: "recorded, waiting for
   the deposit", with who recorded it, read by the whole group.

   SETTLING happens when the money is really here, against a NAMED deposit
   into the group's wallet, and never for more than that deposit brought
   in. It calls stokvelShares.attribute, which says whose an already-banked
   amount was without inventing any: the amount is taken back from everybody
   on the proportions it was shared out on and given to the member it
   belonged to. The sum of the shares does not move, so the invariant —
   Σ members' shares = wallet + invested − exit debts — is untouched, which
   is the only reason this is safe to do at all.

   WHY A NAMED DEPOSIT rather than "settle when the wallet looks big
   enough". A group's wallet also grows from interest, from a maturing
   investment, from a refund. Settling against whatever happens to be there
   would quietly hand one member money that belonged to all of them. Tying
   each receipt to a deposit reference makes the question "did this money
   arrive, and has it already been used" answerable, by anybody, afterwards.

   THE CONTROL IS THAT EVERYBODY SEES IT. A treasurer who can record a
   receipt can record a false one — exactly as the treasurer of any stokvel
   can write a false line in the book. What makes the book work is that the
   meeting reads it, so every receipt names who recorded it and the whole
   group can see it. Requiring the member to confirm was the obvious
   alternative and it is wrong: the member paying cash is the member
   without a smartphone, which is who this exists for.
   ═══════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const cents  = n => Math.round((Number(n) || 0) * 100);
const fmtR   = n => 'R' + round2(n).toFixed(2);
const newId  = p => p + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();

/* The types that mean money ARRIVED in the group's wallet from outside it.
   stokvel_contribution_received is deliberately absent: that is a member's
   contribution which has already been attributed to them, and settling a
   cash receipt out of it would pay the same contribution twice. */
const DEPOSIT_TYPES = ['deposit', 'transfer_in'];

/* ─── Recording one ──────────────────────────────────────────────── */
async function record(client, { subAccount, investorId, amount, receivedOn, method, note, recordedBy }) {
  const amt = round2(amount);
  if (!(amt > 0)) return { error: 'How much was handed over?' };

  const { rows: [m] } = await client.query(
    `SELECT 1 FROM stokvel_members
      WHERE sub_account_id = $1 AND investor_id = $2 AND status = 'active'`,
    [subAccount.id, investorId]);
  if (!m) return { error: 'That person is not an active member of this group.' };

  const on = String(receivedOn || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return { error: 'Give the date it was received as YYYY-MM-DD.' };
  /* A receipt dated in the future is a typo, every time. */
  if (new Date(on + 'T00:00:00Z') > new Date(Date.now() + 86400000)) {
    return { error: 'That date is in the future.' };
  }

  const how = ['cash', 'eft', 'other'].includes(String(method)) ? String(method) : 'cash';
  const id = newId('SCR');
  await client.query(
    `INSERT INTO stokvel_cash_receipts
       (id, sub_account_id, investor_id, amount, received_on, method, note, recorded_by)
     VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8)`,
    [id, subAccount.id, investorId, amt, on, how,
     String(note || '').slice(0, 200) || null, recordedBy]);
  return { receipt: { id, amount: amt, received_on: on, method: how, status: 'recorded' } };
}

/* ─── Calling one back ───────────────────────────────────────────── */
async function cancel(client, { subAccount, receiptId, by }) {
  const { rows: [r] } = await client.query(
    `SELECT * FROM stokvel_cash_receipts
      WHERE id = $1 AND sub_account_id = $2 FOR UPDATE`, [receiptId, subAccount.id]);
  if (!r) return { error: 'No such receipt.' };
  if (r.status === 'cancelled') return { cancelled: r.id };
  /* A settled receipt has moved a share. Undoing that is an attribution in
     the other direction, which is a staff decision with a record, not a
     button on a committee screen. */
  if (r.status === 'settled') {
    return { error: 'That one has already been settled against a deposit. SV Capital can reverse it.' };
  }
  await client.query(
    `UPDATE stokvel_cash_receipts
        SET status = 'cancelled', cancelled_by = $2, cancelled_at = NOW(), updated_at = NOW()
      WHERE id = $1`, [r.id, by]);
  return { cancelled: r.id };
}

/* ─── What the group has recorded ────────────────────────────────── */
async function list(client, subAccountId) {
  const { rows } = await client.query(
    `SELECT c.id, c.investor_id, c.amount, c.received_on, c.method, c.note, c.status,
            c.deposit_reference, c.settled_at, c.created_at,
            i.first_name, i.last_name,
            r.first_name AS recorded_by_name
       FROM stokvel_cash_receipts c
       JOIN investors i ON i.id = c.investor_id
       LEFT JOIN investors r ON r.id = c.recorded_by
      WHERE c.sub_account_id = $1
      ORDER BY (c.status = 'recorded') DESC, c.received_on DESC, c.created_at DESC
      LIMIT 200`, [subAccountId]);
  return rows.map(r => ({
    id: r.id, investor_id: r.investor_id,
    name: [r.first_name, r.last_name].filter(Boolean).join(' '),
    amount: r.amount, received_on: r.received_on, method: r.method, note: r.note,
    status: r.status, deposit_reference: r.deposit_reference,
    settled_at: r.settled_at, recorded_by_name: r.recorded_by_name || 'the committee',
  }));
}

/* ─── Settling them against a deposit that really arrived ────────── */
async function settle(client, { subAccount, reference, actor }) {
  const ref = String(reference || '').trim();
  if (!ref) return { error: 'Which deposit? Give the reference it arrived under.' };

  const { rows: [dep] } = await client.query(
    `SELECT reference, amount, type, created_at FROM transactions
      WHERE sub_account_id = $1 AND reference = $2 AND status = 'completed'
        AND type = ANY($3::text[])
      ORDER BY created_at DESC LIMIT 1`,
    [subAccount.id, ref, DEPOSIT_TYPES]);
  if (!dep) {
    return { error: 'No deposit with that reference has arrived in this group’s account yet.' };
  }

  /* One deposit cannot settle more than it brought in, however many times
     somebody presses the button. */
  const { rows: [used] } = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS n FROM stokvel_cash_receipts
      WHERE sub_account_id = $1 AND deposit_reference = $2 AND status = 'settled'`,
    [subAccount.id, ref]);
  let available = round2(Number(dep.amount) - Number(used.n));
  if (cents(available) <= 0) {
    return { error: `That deposit of ${fmtR(dep.amount)} has already been used up.` };
  }

  const { rows: open } = await client.query(
    `SELECT * FROM stokvel_cash_receipts
      WHERE sub_account_id = $1 AND status = 'recorded'
      ORDER BY received_on ASC, created_at ASC
      FOR UPDATE`, [subAccount.id]);
  if (!open.length) return { error: 'There is nothing recorded that is waiting to be settled.' };

  const shares = require('./stokvelShares');
  const contributions = require('./stokvelContributions');
  const settled = [];
  let short = null;

  for (const r of open) {
    const amt = round2(r.amount);
    /* WHOLE RECEIPTS ONLY. Half of Mama Dlamini's R500 settled and half
       waiting is an object nobody can explain at a meeting, and it would
       leave her row both paid and owing. What the deposit cannot cover
       waits for the next one. */
    if (cents(amt) > cents(available)) {
      short = { id: r.id, amount: amt, short: round2(amt - available) };
      break;
    }
    const out = await shares.attribute(client, {
      subAccountId: subAccount.id, investorId: r.investor_id, amount: amt,
      reason: `${r.method === 'cash' ? 'Cash' : r.method === 'eft' ? 'EFT' : 'Payment'} `
            + `received ${String(r.received_on).slice(0, 10)}`
            + (r.note ? ' — ' + String(r.note).slice(0, 80) : ''),
      actor,
    });
    if (out.error) return { error: out.error };

    await contributions.settleDue(client, subAccount.id, r.investor_id, amt);
    await client.query(
      `UPDATE stokvel_cash_receipts
          SET status = 'settled', deposit_reference = $2, settled_at = NOW(), updated_at = NOW()
        WHERE id = $1`, [r.id, ref]);
    available = round2(available - amt);
    settled.push({ id: r.id, investor_id: r.investor_id, amount: amt });
  }

  return {
    deposit: { reference: ref, amount: round2(dep.amount) },
    settled,
    total: round2(settled.reduce((n, s) => n + s.amount, 0)),
    left_over: available,
    /* Named rather than silent: a committee that settled four of five
       receipts has to know which one is still waiting and by how much. */
    not_settled: short,
  };
}

module.exports = { record, cancel, list, settle, DEPOSIT_TYPES };
