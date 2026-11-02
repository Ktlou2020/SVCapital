'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   Comparing what Paystack says happened with what we recorded.

   Nothing on this platform ever did. The webhook was the only connection
   between the gateway and the ledger, and a webhook is a message that can be
   lost: dropped during a deploy, refused while the database was down, sent
   for an event the handler returned early on. Every one of those leaves the
   two records disagreeing silently and for ever.

   TWO DIFFERENT SILENCES, and they cost money in opposite directions.

   PAYSTACK HAS A SUCCESSFUL CHARGE WE DID NOT CREDIT. The client's card was
   debited and their wallet never moved. They are out of pocket, they are
   waiting, and the only way they find out is by noticing — which is to say,
   by complaining. This is the one that ends up with the bank.

   WE CREDITED SOMETHING PAYSTACK NO LONGER HAS. A dispute or a refund whose
   webhook never arrived. Every balance on the platform is then overstated by
   that amount, including a stokvel's pot, with nothing anywhere saying so.

   Run daily over the day before, and raised as incidents rather than logged,
   because a reconciliation nobody reads is the same as no reconciliation.
   ───────────────────────────────────────────────────────────────────────── */

const pool      = require('../db/pool');
const paystack  = require('./paystack');
const incidents = require('./incidents');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function dayBounds(day) {
  const d = new Date(day);
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
  const to   = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59));
  return { from: from.toISOString(), to: to.toISOString() };
}

/* Compare one day. Returns what it found rather than reporting it, so the
   same function serves the cron, a check, and a staff member asking about a
   particular day. */
async function compareDay(day = new Date(Date.now() - 86400000)) {
  const { from, to } = dayBounds(day);

  const gateway = await paystack.listTransactions({ from, to, status: 'success' });
  if (!gateway.ok) {
    /* Said plainly and NOT turned into a list of discrepancies. A partial
       read reports every row it never fetched as missing, which is a page of
       false alarms and the fastest way to teach somebody to ignore this. */
    return { ok: false, reason: gateway.reason, partial: !!gateway.partial,
             day: from.slice(0, 10), onlyAtGateway: [], onlyHere: [] };
  }

  const theirs = new Map();
  for (const t of gateway.data) {
    if (!t || !t.reference) continue;
    theirs.set(String(t.reference), round2((t.amount || 0) / 100));
  }

  /* Ours, for the same window. Only the rows that came from a card: an EFT
     deposit or a maturity payout has no Paystack side and would be reported
     as missing from a gateway that never saw it.

     Asked by the RECORDED gateway, not guessed from the reference prefix.
     The first version listed the prefixes it knew about, which missed
     exactly the rows this exists to find: a credit the gateway no longer
     has is the one whose reference nobody thought to add to the list. */
  const { rows: ours } = await pool.query(
    `SELECT reference, amount, investor_id, reversed_at
       FROM transactions
      WHERE created_at >= $1::timestamptz AND created_at <= $2::timestamptz
        AND status = 'completed'
        AND reference IS NOT NULL
        AND gateway = 'paystack'`,
    [from, to]);

  const mine = new Map();
  for (const r of ours) mine.set(String(r.reference), r);

  /* Charged by the gateway, never credited here. */
  const onlyAtGateway = [...theirs.entries()]
    .filter(([ref]) => !mine.has(ref))
    .map(([reference, amount]) => ({ reference, amount }));

  /* Credited here, and the gateway has no successful charge for it. A row
     already marked reversed is not a discrepancy — it is this working. */
  const onlyHere = [...mine.values()]
    .filter(r => !theirs.has(String(r.reference)) && !r.reversed_at)
    .map(r => ({ reference: r.reference, amount: round2(r.amount),
                 investor_id: r.investor_id }));

  return { ok: true, day: from.slice(0, 10),
           gatewayCount: theirs.size, ourCount: mine.size,
           onlyAtGateway, onlyHere };
}

/* The same comparison, reported. One incident per side rather than one per
   row: twenty missing credits on the day of a bad deploy is one fault, and
   twenty alerts about it is how somebody learns to mute this. */
async function reconcileDay(day) {
  const out = await compareDay(day);

  if (!out.ok) {
    await incidents.report(
      new Error(`could not reconcile ${out.day} against Paystack: ${out.reason}`),
      { source: 'paystack:reconcile', severity: 'error', details: { day: out.day } });
    return out;
  }

  if (out.onlyAtGateway.length) {
    const total = round2(out.onlyAtGateway.reduce((n, r) => n + r.amount, 0));
    await incidents.report(
      new Error(`${out.onlyAtGateway.length} charge(s) on ${out.day} totalling R${total.toFixed(2)} `
        + `were taken by Paystack and never credited here`),
      { source: 'paystack:reconcile', severity: 'critical',
        details: { day: out.day, references: out.onlyAtGateway.slice(0, 50) } });
  }

  if (out.onlyHere.length) {
    const total = round2(out.onlyHere.reduce((n, r) => n + r.amount, 0));
    await incidents.report(
      new Error(`${out.onlyHere.length} credit(s) on ${out.day} totalling R${total.toFixed(2)} `
        + `have no successful charge at Paystack`),
      { source: 'paystack:reconcile', severity: 'critical',
        details: { day: out.day, references: out.onlyHere.slice(0, 50) } });
  }

  return out;
}

module.exports = { compareDay, reconcileDay, dayBounds };
