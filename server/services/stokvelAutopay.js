'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   Collecting a contribution without asking every month.

   A stokvel is a group of people paying a fixed amount on a fixed day. Until
   now every one of them had to remember to do it by hand, every month, and
   most of what the arrears screen shows is not somebody refusing to pay — it
   is friction. The chase email, the treasurer's WhatsApp, the awkward
   conversation at the next meeting: all of it downstream of a payment nobody
   got round to making.

   A member can now have it taken from the card already on their main
   account. No second card capture, no new mandate, no new vendor: it is the
   same stored Paystack authorisation that auto top-up has used for months.

   FOUR THINGS THIS DOES THAT A NAIVE VERSION WOULD NOT.

   It charges the SHORTFALL, not the contribution. The contribution has
   always been paid out of the member's wallet, and a wallet that already has
   the money needs no card at all. Charging R500 to a wallet holding R500 and
   then paying R500 out of it costs the member R9,64 in gateway fees for
   nothing.

   It pays even when the card says no. A member with R300 in the wallet and a
   declined card has still got R300 towards what they owe, and the
   contribution system has always accepted part payment. Refusing the whole
   thing because the top-up failed would leave them further behind than doing
   nothing.

   It stops after three failures. A card that keeps declining is a card that
   will keep declining, and a platform that retries it daily is a platform
   generating a failed-payment notification a day. The member is told, the
   attempts stop, and the obligation goes back to being chased the way it
   always was.

   And the reference is DETERMINISTIC. One obligation, one reference, for
   ever. Paystack refuses a duplicate, which is what makes a cron that fires
   twice harmless — the gateway is better at idempotency than we are and this
   leans on it rather than reimplementing it.
   ───────────────────────────────────────────────────────────────────────── */

const pool          = require('../db/pool');
const paystack      = require('./paystack');
const contributions = require('./stokvelContributions');
const { recordTransaction, systemActor } = require('./ledger');

/* Three. Enough for a card that was briefly over its limit, few enough that
   a dead card is not a notification a day for a month. */
const MAX_ATTEMPTS = 3;

const ACTOR = () => systemActor('stokvelAutopayCron');

/* What is collectable today.

   Due or overdue, not settled, the member still active, autopay on, a card
   stored, and not already given up on. Overdue as well as due: a member who
   turns autopay on halfway through a month should have this month collected,
   not just next month's. */
async function collectable(db, asOf = new Date()) {
  const { rows } = await (db || pool).query(
    `SELECT c.id, c.sub_account_id, c.investor_id, c.period_label, c.due_date,
            c.amount_due, c.amount_paid, c.autopay_attempts,
            (c.amount_due - c.amount_paid)       AS owed,
            a.name                                AS stokvel_name,
            i.first_name, i.email, i.wallet_balance,
            pa.authorization_code, pa.email       AS auth_email, pa.last4
       FROM stokvel_contributions c
       JOIN stokvel_members m
         ON m.sub_account_id = c.sub_account_id AND m.investor_id = c.investor_id
       JOIN sub_accounts a ON a.id = c.sub_account_id
       JOIN investors    i ON i.id = c.investor_id
       JOIN paystack_authorizations pa ON pa.investor_id = c.investor_id
      WHERE c.status = 'due'
        AND c.amount_due > c.amount_paid
        AND c.due_date <= $1::date
        AND m.status = 'active'
        AND m.autopay_enabled = true
        AND a.status = 'active'
        AND i.status = 'active'
        AND c.autopay_attempts < $2
      ORDER BY c.due_date, c.id`,
    [asOf, MAX_ATTEMPTS]);
  return rows;
}

/* One obligation, one reference, for ever. Not dated: a second attempt
   tomorrow on the same obligation is the SAME collection, and giving it a
   new reference each day would turn Paystack's duplicate refusal — the thing
   protecting the member from being charged twice — off. */
function referenceFor(item) {
  return `SAP-${String(item.id).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 28)}`;
}

/* Collect one. The caller owns the loop and the error handling around it;
   this never throws for an ordinary failure, because a declined card is an
   outcome rather than an exception. */
async function collectOne(item, { asOf = new Date() } = {}) {
  const owed   = Math.round(Number(item.owed) * 100) / 100;
  const wallet = Math.round(Number(item.wallet_balance) * 100) / 100;
  if (!(owed > 0)) return { id: item.id, skipped: 'nothing owed' };

  /* Only the part the wallet cannot cover. */
  const shortfall = Math.round(Math.max(0, owed - wallet) * 100) / 100;
  let charged = null;

  if (shortfall > 0) {
    const result = await paystack.charge({
      authorizationCode: item.authorization_code,
      email: item.auth_email,
      net: shortfall,
      reference: referenceFor(item),
      metadata: {
        source: 'stokvel_autopay',
        investor_id: item.investor_id,
        sub_account_id: item.sub_account_id,
        contribution_id: item.id,
        period: item.period_label,
      },
    });

    if (result.ok) {
      /* Credit and record in one database transaction, in that order, so a
         crash cannot leave the member charged by Paystack with no wallet
         credit to show for it. */
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await recordTransaction(client, {
          investorId: item.investor_id, type: 'deposit', amount: result.net,
          reference: result.reference,
          description: `Card top-up for ${item.stokvel_name} — ${item.period_label}`
            + ` (charged R${result.gross.toLocaleString('en-ZA')})`,
        }, ACTOR(), { onConflict: 'reference' });
        await client.query(
          'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
          [result.net, item.investor_id]);
        await client.query('COMMIT');
        charged = result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        /* Charged at the gateway and not credited here is the one state
           that must never be quiet. Raised rather than returned, so the
           caller turns it into an incident. */
        throw Object.assign(
          new Error(`charged ${item.investor_id} R${result.gross} at Paystack but could not `
            + `credit the wallet: ${err.message}`),
          { chargedButNotCredited: true, reference: result.reference });
      } finally {
        /* Released on every path. Without this the client taken for each
           SUCCESSFUL charge was never given back, so the pool drained one
           collection at a time and the whole server stopped being able to
           reach the database — found because the check hung rather than
           finished, which is the only symptom a leak like this has. */
        client.release();
      }
    } else {
      /* Recorded against the obligation, and counted. Three strikes and the
         query above stops returning it. */
      await pool.query(
        `UPDATE stokvel_contributions
            SET autopay_attempts = autopay_attempts + 1,
                autopay_attempted_at = NOW(),
                autopay_last_error = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [item.id, String(result.reason || 'declined').slice(0, 400)]);

      /* The wallet may still cover some of it. A member with R300 and a
         declined card is R300 better off than one we refused to help. */
      if (wallet <= 0) {
        return { id: item.id, paid: 0, declined: true, reason: result.reason,
                 attempts: Number(item.autopay_attempts) + 1 };
      }
    }
  }

  /* Pay what the wallet can now cover — all of it when the card worked,
     part of it when it did not. */
  const payable = Math.min(owed, charged ? owed : wallet);
  if (!(payable > 0)) {
    return { id: item.id, paid: 0, declined: !!(shortfall > 0 && !charged) };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [contribution] } = await client.query(
      'SELECT * FROM stokvel_contributions WHERE id = $1 FOR UPDATE', [item.id]);
    const { rows: [group] } = await client.query(
      'SELECT * FROM sub_accounts WHERE id = $1', [item.sub_account_id]);
    const out = await contributions.pay(client, {
      contribution, investorId: item.investor_id, subAccount: group,
      amount: payable, actor: ACTOR(),
    });
    /* The failure reason is cleared only when there was nothing wrong this
       time. Clearing it unconditionally wiped the explanation for a card
       that had just been declined — the obligation would sit there part
       paid and still owing, with nothing on it saying why, which is exactly
       what the member and the treasurer need to know. */
    const cardWasFine = shortfall === 0 || !!charged;
    await client.query(
      `UPDATE stokvel_contributions
          SET autopay_attempted_at = NOW(),
              autopay_last_error = CASE WHEN $2 THEN NULL ELSE autopay_last_error END,
              updated_at = NOW()
        WHERE id = $1`, [item.id, cardWasFine]);
    await client.query('COMMIT');
    return { id: item.id, paid: payable, charged: charged ? charged.gross : 0,
             fee: charged ? charged.fee : 0, declined: !!(shortfall > 0 && !charged),
             /* pay() reports what is LEFT, not a boolean. Nothing left is
                settled; anything left means this was a part payment and the
                obligation stays open to be chased. */
             outstanding: out ? out.outstanding : null,
             settled: !!(out && Number(out.outstanding) <= 0),
             part: payable < owed };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { collectable, collectOne, referenceFor, MAX_ATTEMPTS };
