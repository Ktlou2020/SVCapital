'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   When a card payment is taken back.

   The webhook handled charge.success and returned on everything else:

     if (event !== 'charge.success') return;

   So a dispute, a refund or a reversal was dropped on the floor. Paystack
   takes the money back from SV Capital either way, and the client's wallet
   went on showing the credit as though nothing had happened. Every balance
   on the platform was overstated by exactly the amount somebody had taken
   back, and nothing anywhere said so.

   Automatic collection made this likely rather than rare. A card charged
   once, by a client who pressed the button, seldom gets disputed. A card
   charged every month without the client present is the exact pattern that
   produces "I do not recognise this debit".

   WHAT CAN BE TAKEN BACK IS NOT WHAT WAS TAKEN. The money may be sitting in
   the wallet, or it may have been invested, or — the hard one — paid into a
   stokvel, where it has already moved into the group's pot and been shared
   across every member's ledger. So this does three things and refuses to
   guess at a fourth:

     it records the reversal, always, whether or not anything was recovered;

     it debits the wallet for as much as the wallet can cover, because that
     part is unambiguous and leaving it is simply wrong;

     and it raises an incident for the rest, naming where the money went.

   IT NEVER CLAWS BACK FROM A STOKVEL. Taking R500 out of a group's pot
   because one member's card was disputed takes it from fourteen other people
   who did nothing. That is a conversation with a committee, not a database
   write, and a platform that does it automatically will do it wrongly at
   least once. The incident names the group and the amount and stops there.
   ───────────────────────────────────────────────────────────────────────── */

const pool      = require('../db/pool');
const incidents = require('./incidents');
const { recordTransaction, systemActor } = require('./ledger');

const ACTOR = () => systemActor('paystack:reversal');

/* The events that mean money is going the other way. Paystack sends several
   about the same dispute; all of them land here and the gateway_id folds
   them onto one row. */
const REVERSING_EVENTS = {
  'charge.dispute.create':  'dispute',
  'charge.dispute.remind':  'dispute',
  'charge.dispute.resolve': 'dispute',
  'refund.processed':       'refund',
  'refund.pending':         'refund',
  'refund.failed':          'refund',
  'charge.reversed':        'reversal',
};

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/* Where the money went after it was credited.

   Deliberately coarse. The point is not a forensic trace — it is telling a
   human the one thing that changes what they do next: is this still in the
   wallet, or is it inside a stokvel where other people's shares are now
   involved. */
async function _whereItWent(db, { investorId, reference }) {
  /* A contribution collected automatically carries the obligation's own
     reference, so the top-up that funded it is findable from either end. */
  const { rows } = await db.query(
    `SELECT t.type, t.sub_account_id, a.name AS stokvel_name
       FROM transactions t
       LEFT JOIN sub_accounts a ON a.id = t.sub_account_id
      WHERE t.investor_id = $1
        AND t.created_at >= (SELECT created_at FROM transactions
                              WHERE reference = $2 LIMIT 1)
        AND t.type IN ('stokvel_contribution', 'investment', 'withdrawal')
      ORDER BY t.created_at
      LIMIT 1`, [investorId, reference]);
  const row = rows[0];
  if (!row) return { spent_on: null, sub_account_id: null, stokvel_name: null };
  return {
    spent_on: row.type,
    sub_account_id: row.sub_account_id || null,
    stokvel_name: row.stokvel_name || null,
  };
}

/* Record one, and take back what can honestly be taken back. */
async function record({ event, data }) {
  const kind = REVERSING_EVENTS[event];
  if (!kind) return null;

  /* Paystack nests the charge differently per event; all three shapes are
     tried rather than assumed, because guessing wrong here means a reversal
     silently attached to no transaction at all. */
  const reference = data?.transaction?.reference || data?.reference
                 || data?.transaction_reference || null;
  const gatewayId = String(data?.id || data?.dispute?.id || reference || '');
  const amount    = round2(
    (data?.amount ?? data?.transaction?.amount ?? 0) / 100 || data?.refunded_amount / 100 || 0);
  const gatewayStatus = data?.status || data?.dispute?.status || null;

  if (!reference) {
    await incidents.report(
      new Error(`a ${kind} arrived from Paystack with no reference on it`),
      { source: 'paystack:webhook', severity: 'critical', details: { event, data } });
    return null;
  }

  /* The original. Without it there is nothing to reverse and nobody to
     reverse it from — which is itself worth waking somebody for, because it
     means Paystack has a charge we never recorded. */
  const { rows: [original] } = await pool.query(
    `SELECT id, investor_id, amount, type, reversed_at
       FROM transactions WHERE reference = $1 LIMIT 1`, [reference]);

  if (!original) {
    await incidents.report(
      new Error(`Paystack sent a ${kind} for ${reference}, which is not a payment we recorded`),
      { source: 'paystack:webhook', severity: 'critical',
        details: { event, reference, amount } });
    return null;
  }

  const investorId = original.investor_id;
  const toReverse  = amount > 0 ? amount : round2(original.amount);
  const where      = await _whereItWent(pool, { investorId, reference });

  /* Upsert first, so the record exists even if the clawing-back below
     fails. A dispute we know about and could not act on is worth far more
     than no record at all. */
  const { rows: [row] } = await pool.query(
    `INSERT INTO payment_reversals
       (id, gateway_id, kind, reference, investor_id, amount, spent_on,
        sub_account_id, gateway_status, raw)
     VALUES (gen_random_uuid()::text, $1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (gateway_id) DO UPDATE SET
       gateway_status = EXCLUDED.gateway_status,
       raw            = EXCLUDED.raw
     RETURNING *`,
    [gatewayId, kind, reference, investorId, toReverse, where.spent_on,
     where.sub_account_id, gatewayStatus, JSON.stringify(data || null)]);

  /* A DISPUTE HAS TO BE ANSWERED. Paystack gives a merchant a window to
     submit evidence, and a dispute nobody answers is lost by default —
     which costs the full amount whether or not anything could be clawed
     back from the wallet. So every new dispute is surfaced, including the
     ones where recovery went perfectly: the money is only safe once
     somebody has replied to Paystack with the proof.

     Folded by fingerprint like any incident, so the reminders Paystack
     sends about the same dispute do not become a stream of alerts. */
  if (kind === 'dispute' && event === 'charge.dispute.create') {
    const dueAt = data?.due_at || data?.dispute?.due_at || null;
    await incidents.report(
      new Error(`a R${toReverse.toFixed(2)} card payment is being disputed`
        + `${dueAt ? ` — Paystack wants our evidence by ${dueAt}` : ''}`
        + '. A dispute nobody answers is lost by default.'),
      { source: 'paystack:dispute', severity: 'warning',
        details: { reference, investor: investorId, amount: toReverse,
                   dueAt, gatewayId } });
  }

  /* A dispute Paystack has resolved IN OUR FAVOUR takes nothing back. */
  if (event === 'charge.dispute.resolve'
      && String(gatewayStatus || '').toLowerCase().includes('merchant')) {
    await pool.query(
      `UPDATE payment_reversals SET status = 'reversed_back', resolved_at = NOW(),
              note = 'Paystack resolved this in our favour; nothing was taken back'
        WHERE id = $1`, [row.id]);
    return { ...row, status: 'reversed_back', recovered: 0 };
  }

  /* Already acted on. A reminder about the same dispute must not debit the
     wallet a second time. */
  if (original.reversed_at) {
    return { ...row, alreadyReversed: true };
  }

  return _clawBack(row, { original, toReverse, where });
}

async function _clawBack(row, { original, toReverse, where }) {
  const investorId = original.investor_id;

  const client = await pool.connect();
  let recovered = 0, shortfall = toReverse;
  try {
    await client.query('BEGIN');

    /* Locked, so a withdrawal landing at the same moment cannot spend the
       balance between reading it and debiting it. */
    const { rows: [inv] } = await client.query(
      'SELECT wallet_balance FROM investors WHERE id = $1 FOR UPDATE', [investorId]);
    const wallet = round2(inv ? inv.wallet_balance : 0);

    /* As much as the wallet honestly covers, and no more. A wallet driven
       negative is a number no screen on this platform knows how to explain,
       and the shortfall is a debt to be collected, not an overdraft to be
       invented. */
    recovered = round2(Math.max(0, Math.min(wallet, toReverse)));
    shortfall = round2(toReverse - recovered);

    if (recovered > 0) {
      /* THE LEDGER ROW IS THE GATE. Paystack sends several events about one
         dispute, and the reference is derived from the original charge, so
         a second attempt hits ON CONFLICT and writes nothing. The wallet
         debit is made to depend on that: written unconditionally it would
         run again on every reminder, taking the money twice from anybody
         who had topped up in between. The early return above catches the
         ordinary case; this catches it when that check is wrong. */
      const written = await recordTransaction(client, {
        investorId, type: 'reversal', amount: -recovered,
        reference: `REV-${original.id}`,
        description: `Card payment taken back — ${row.kind} on ${row.reference}`,
      }, ACTOR(), { onConflict: 'reference' });

      if (written) {
        await client.query(
          'UPDATE investors SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
          [recovered, investorId]);
      } else {
        recovered = 0;
        shortfall = toReverse;
      }
    }

    await client.query(
      `UPDATE transactions SET reversed_at = NOW(), reversed_reference = $2, updated_at = NOW()
        WHERE id = $1`, [original.id, row.reference]);

    /* $3 is cast explicitly: used once as a numeric column value and once
       inside a CASE against 0, Postgres cannot deduce one type for it and
       refuses the whole statement with "inconsistent types deduced for
       parameter $3" — which rolled back every claw-back before it ever
       debited anything. */
    await client.query(
      `UPDATE payment_reversals
          SET recovered = $2::numeric, shortfall = $3::numeric,
              status = CASE WHEN $3::numeric = 0 THEN 'recovered' ELSE 'open' END
        WHERE id = $1`, [row.id, recovered, shortfall]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await incidents.report(err, {
      source: 'paystack:reversal', severity: 'critical',
      details: { reference: row.reference, investor: investorId, amount: toReverse } });
    return { ...row, failed: err.message };
  } finally {
    client.release();
  }

  /* What a human has to deal with. Raised AFTER the commit, so an incident
     never describes a state the database rolled back. */
  if (shortfall > 0) {
    const intoStokvel = where.spent_on === 'stokvel_contribution';
    await incidents.report(
      new Error(
        `R${shortfall.toFixed(2)} of a ${row.kind} on ${row.reference} could not be taken back: `
        + (intoStokvel
            ? `it had already been paid into ${where.stokvel_name || where.sub_account_id} `
              + `and shared across its members`
            : where.spent_on
              ? `it had already gone into a ${where.spent_on}`
              : `the wallet did not hold it`)),
      { source: 'paystack:reversal',
        severity: 'critical',
        details: { reference: row.reference, investor: investorId,
                   amount: toReverse, recovered, shortfall,
                   spentOn: where.spent_on, stokvel: where.sub_account_id } });
  }

  return { ...row, recovered, shortfall,
           status: shortfall > 0 ? 'open' : 'recovered' };
}

module.exports = { record, REVERSING_EVENTS, _whereItWent };
