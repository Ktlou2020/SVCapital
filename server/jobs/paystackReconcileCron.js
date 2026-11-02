'use strict';
/* Checking the gateway's books against ours, every morning.
 *
 * The webhook was the only connection between Paystack and this ledger, and
 * a webhook is a message that can be lost — dropped during a deploy, refused
 * while the database was down, sent for an event the handler returned early
 * on. Every one of those leaves the two records disagreeing silently and for
 * ever, in one of two directions: a client charged and never credited, or a
 * credit standing against a charge the gateway no longer has.
 *
 * Yesterday, not today: a day still in progress has charges that have simply
 * not been written yet, and reporting those as missing is a false alarm
 * every single morning.
 */

const cron      = require('./_watched');
const reconcile = require('../services/paystackReconcile');

async function runPaystackReconcile(day) {
  const out = await reconcile.reconcileDay(day);
  if (!out.ok) {
    console.warn(`[paystackReconcile] ${out.day}: ${out.reason}`);
    return out;
  }
  console.log(`[paystackReconcile] ${out.day}: ${out.gatewayCount} at Paystack, `
    + `${out.ourCount} here, ${out.onlyAtGateway.length} uncredited, `
    + `${out.onlyHere.length} unmatched`);
  return out;
}

function startPaystackReconcileCron() {
  /* 05:10 UTC — after the overnight jobs have finished writing, and early
     enough that somebody reading the dashboard at the start of the day sees
     yesterday already reconciled. */
  cron.schedule('10 5 * * *', () => runPaystackReconcile(), { timezone: 'UTC' });
  console.log('⏰ Paystack reconciliation scheduled: daily at 05:10 UTC');
}

module.exports = { startPaystackReconcileCron, runPaystackReconcile };
