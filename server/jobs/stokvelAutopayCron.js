'use strict';
/* Taking the contribution, so nobody has to remember to.
 *
 * Runs daily, after the period-opening job has had a chance to create the
 * month's obligations — a collection that ran first would find nothing on
 * the 1st and leave everybody a day late.
 *
 * Every outcome here is a money outcome, so none of them is silent: a
 * collection tells the member what was taken and from where, a declined card
 * tells them before the treasurer has to, and a charge that succeeded at the
 * gateway without crediting the wallet raises a critical incident, because
 * that is the one state where a member is out of pocket with nothing to show
 * for it.
 */

const cron      = require('./_watched');
const pool      = require('../db/pool');
const autopay   = require('../services/stokvelAutopay');
const incidents = require('../services/incidents');

async function runStokvelAutopay(asOf = new Date()) {
  const due = await autopay.collectable(pool, asOf);
  console.log(`[stokvelAutopay] ${due.length} contribution(s) to collect`);

  let collected = 0, declined = 0, part = 0, failed = 0, cents = 0;

  for (const item of due) {
    try {
      const out = await autopay.collectOne(item, { asOf });
      if (out.declined) declined++;
      if (out.paid > 0) {
        collected++;
        cents += Math.round(out.paid * 100);
        if (out.part) part++;
      }
      await _tell(item, out);
    } catch (err) {
      failed++;
      /* One member's failure must not end the run for the rest. */
      console.error(`[stokvelAutopay] ${item.investor_id} / ${item.id} failed:`, err.message);
      await incidents.report(err, {
        source: 'job:stokvelAutopayCron',
        /* Charged and not credited is the one that wakes somebody up. */
        severity: err.chargedButNotCredited ? 'critical' : 'error',
        details: { contribution: item.id, investor: item.investor_id,
                   stokvel: item.sub_account_id, reference: err.reference || null },
      });
    }
  }

  console.log(`[stokvelAutopay] collected ${collected} (R${(cents / 100).toFixed(2)}), `
    + `${part} part, ${declined} declined, ${failed} failed`);
  return { collected, declined, part, failed, amount: cents / 100 };
}

/* Telling the member. A card charged without a word is how a platform gets
   reported to a bank as an unrecognised debit. */
async function _tell(item, out) {
  const email = require('../services/email');
  const push  = require('../services/pushService');
  try {
    if (out.paid > 0) {
      const how = out.charged
        ? `R${out.charged.toLocaleString('en-ZA')} was charged to your card ending ${item.last4 || '••••'}`
        : 'it came from your wallet, so your card was not charged';
      const subject = `${item.stokvel_name} — R${out.paid.toLocaleString('en-ZA')} contributed`;
      const body = `Your ${item.period_label} contribution to ${item.stokvel_name} has been paid`
        + `${out.part ? ' in part' : ''}. ${how}.`
        + (out.part ? ` R${Number(out.outstanding).toLocaleString('en-ZA')} is still outstanding.` : '');
      await email.sendAlert({ id: item.investor_id, email: item.email,
                              first_name: item.first_name }, { subject, message: body });
    } else if (out.declined) {
      const left = autopay.MAX_ATTEMPTS - (out.attempts || 0);
      await email.sendAlert({ id: item.investor_id, email: item.email,
                              first_name: item.first_name }, {
        subject: `${item.stokvel_name} — your card was declined`,
        message: `We could not collect your ${item.period_label} contribution to `
          + `${item.stokvel_name}. ${out.reason || 'Your card was declined.'}\n\n`
          + (left > 0
              ? `We will try again tomorrow. You can also pay it from the app at any time.`
              : `We will not try again — please pay it from the app, or update your card.`),
      });
      await push.sendPushToInvestor(item.investor_id, {
        title: `${item.stokvel_name}: card declined`,
        body: `Your ${item.period_label} contribution could not be collected.`,
        url: '/portal/#stokvel',
      }).catch(() => {});
    }
  } catch (err) {
    /* Not telling somebody is bad; failing the collection because we could
       not tell them would be worse. The money moved either way. */
    console.error('[stokvelAutopay] could not notify:', err.message);
  }
}

function startStokvelAutopayCron() {
  /* 02:30 UTC — after openPeriods at 00:20, so the month's obligations
     exist by the time this looks for them. */
  cron.schedule('30 2 * * *', () => runStokvelAutopay(), { timezone: 'UTC' });
  console.log('⏰ Stokvel autopay scheduled: daily at 02:30 UTC');
}

module.exports = { startStokvelAutopayCron, runStokvelAutopay };
