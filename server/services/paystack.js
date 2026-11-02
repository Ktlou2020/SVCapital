'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   Paystack — charging a card the client has already authorised.

   The platform has had this since auto top-up: when a client pays by card,
   Paystack hands back an AUTHORIZATION CODE, and that code can be charged
   again without the client being present. It is stored in
   paystack_authorizations against the investor, and it is the member's own
   card on their own main account — the one they already use to top the
   wallet up.

   Everything that charges it needs the same two things, so they live here
   rather than being written out a second time by whoever needs them next.

   THE FEE IS GROSSED UP, NOT ABSORBED. Paystack South Africa takes 1.5%
   plus R2, capped at R800. A client who asks for R500 to reach their wallet
   must have R500 reach their wallet, so the card is charged what it takes to
   net that. Charging R500 and crediting R490,50 is the kind of arithmetic
   that ends up in a complaint, and rightly.

   Note this is the GATEWAY's fee and has nothing to do with SV Capital's 1%
   platform fee, which is charged on investments and is a separate figure on
   a separate line. Two percentages on one screen is confusing enough without
   the code conflating them.
   ───────────────────────────────────────────────────────────────────────── */

const pool = require('../db/pool');

const CHARGE_URL = 'https://api.paystack.co/transaction/charge_authorization';

/* Paystack SA, at the time of writing. Kept together and named, so the day
   the rate changes there is one place to change it. */
const FEE_RATE = 0.015;
const FEE_FLAT = 2;
const FEE_CAP  = 800;

function secretKey() {
  return (process.env.PAYSTACK_SECRET_KEY || '').trim();
}

/* What the card must be charged for `net` to arrive.

   Solving net = gross - (gross * rate + flat) gives
   gross = (net + flat) / (1 - rate), which is where the /0.985 comes from. */
function grossUp(net) {
  const amount = Number(net) || 0;
  if (amount <= 0) return { net: 0, fee: 0, gross: 0 };
  const rawFee = (amount + FEE_FLAT) / (1 - FEE_RATE) - amount;
  const fee    = Math.min(rawFee, FEE_CAP);
  const gross  = Math.round((amount + fee) * 100) / 100;
  return { net: amount, fee: Math.round(fee * 100) / 100, gross };
}

/* The investor's stored card, or null. One row per investor today; newest
   first regardless, so the shape of that never has to be assumed here. */
async function authorizationFor(db, investorId) {
  const { rows } = await (db || pool).query(
    `SELECT authorization_code, email, last4, card_type, bank, exp_month, exp_year
       FROM paystack_authorizations
      WHERE investor_id = $1
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 1`, [investorId]);
  return rows[0] || null;
}

/* Charge it.

   `reference` must be DETERMINISTIC for whatever this is collecting — the
   same obligation on the same day must produce the same reference, because
   Paystack refuses a duplicate and that refusal is what stops a cron that
   fires twice from charging somebody twice. Idempotency here is the
   gateway's job and it is better at it than we are.

   Returns a plain result rather than throwing, because every caller is a
   loop over people and one declined card must not end the run. */
async function charge({ authorizationCode, email, net, reference, metadata = {} }) {
  const key = secretKey();
  if (!key) return { ok: false, reason: 'PAYSTACK_SECRET_KEY is not set', declined: false };

  const { fee, gross } = grossUp(net);
  if (!(gross > 0)) return { ok: false, reason: 'nothing to charge', declined: false };

  let res, data;
  try {
    res = await fetch(CHARGE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authorization_code: authorizationCode,
        email,
        amount: Math.round(gross * 100),   // kobo/cents
        reference,
        metadata: { ...metadata, wallet_credit: net, gateway_fee: fee, gross_charge: gross },
      }),
    });
    data = await res.json();
  } catch (err) {
    /* The network, not the card. Worth telling apart: a card that was
       declined should not be retried tomorrow as though it might work,
       and a connection that dropped should. */
    return { ok: false, reason: `could not reach Paystack: ${err.message}`,
             declined: false, net, fee, gross };
  }

  const ok = !!(data && data.status && data.data && data.data.status === 'success');
  return {
    ok,
    net, fee, gross, reference,
    /* Paystack answered and said no. The distinction from a network failure
       is what lets a caller stop trying a card that will keep saying no. */
    declined: !ok && !!(data && data.status !== undefined),
    reason: ok ? null : ((data && (data.data?.gateway_response || data.message)) || 'declined'),
    raw: data,
  };
}

/* What the GATEWAY thinks happened, for a day.

   Nothing on this platform ever compared Paystack's record against ours.
   Two different silences follow from that, and both cost money: a charge
   Paystack took that we never credited — the client is out of pocket and
   waiting — and a credit we made that Paystack later reversed, which leaves
   every balance overstated by that amount with nothing saying so.

   Paged, because a busy day is more than fifty rows and a comparison that
   reads only the first page reports every row beyond it as missing. */
async function listTransactions({ from, to, status = 'success', perPage = 100, maxPages = 20 } = {}) {
  const key = secretKey();
  if (!key) return { ok: false, reason: 'PAYSTACK_SECRET_KEY is not set', data: [] };

  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.paystack.co/transaction?perPage=${perPage}&page=${page}`
      + `&status=${encodeURIComponent(status)}`
      + (from ? `&from=${encodeURIComponent(from)}` : '')
      + (to ? `&to=${encodeURIComponent(to)}` : '');
    let body;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      body = await res.json();
    } catch (err) {
      /* Partial, and SAID to be partial. A reconciliation that reports what
         it managed to fetch as though it were the whole day would invent
         discrepancies for every row it never saw. */
      return { ok: false, reason: `could not reach Paystack: ${err.message}`, data: out, partial: true };
    }
    if (!body || body.status !== true) {
      return { ok: false, reason: (body && body.message) || 'Paystack refused the request',
               data: out, partial: out.length > 0 };
    }
    const rows = body.data || [];
    out.push(...rows);
    if (rows.length < perPage) return { ok: true, data: out, pages: page };
  }
  /* Ran out of pages before running out of data. */
  return { ok: false, reason: `more than ${maxPages} pages of transactions`, data: out, partial: true };
}

module.exports = { grossUp, charge, authorizationFor, secretKey, listTransactions,
                   FEE_RATE, FEE_FLAT, FEE_CAP, CHARGE_URL };
