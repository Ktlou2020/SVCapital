'use strict';
/* Solar distributions, paid on each investment's own anniversary.
 *
 * Daily, because an anniversary is a per-investment date and every day is
 * somebody's. 06:10 SAST, before the business day and well clear of the 23:00
 * maturity run, so a holding whose final anniversary and maturity fall on the
 * same date has its distribution paid first and maturity then settles the
 * capital and whatever is left of the term's posted return.
 *
 * The timezone is named: a cron left on UTC fires at a different local hour
 * for half the year and reads as a different day either side of midnight,
 * which for a job keyed on dates would move an anniversary.
 *
 * A year whose rate has not been posted pays nothing and is counted as
 * waiting. That is the designed outcome, not a failure — see the service.
 */

const cron = require('node-cron');
const pool = require('../db/pool');
const audit = require('../services/audit');
const annual = require('../services/anniversaryReturns');

const BUSINESS_TZ = 'Africa/Johannesburg';

async function runAnniversaryReturns({ asOf = new Date() } = {}) {
  const items = await annual.due(pool, { asOf });
  const payable = items.filter(x => x.state === 'payable');
  const waiting = items.filter(x => x.state === 'awaiting-rate');

  let paid = 0, total = 0;
  const failures = [];
  for (const item of payable) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await annual.payOne(client, item);
      await client.query('COMMIT');
      if (res.paid) { paid++; total = annual.round2(total + res.amount); }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      /* One investment's failure must not take the rest of the run with it —
         the next one is a different client's money. */
      failures.push({ investment: item.investmentId, year: item.yearIndex, error: err.message });
      console.error(`[anniversary] ${item.investmentId} Y${item.yearIndex}:`, err.message);
    } finally {
      client.release();
    }
  }

  if (paid || failures.length) {
    await audit.log({
      actorEmail: 'cron', actorRole: 'system',
      action: 'anniversary_returns_distributed',
      entityType: 'product', entityId: 'solar',
      description: `${paid} anniversary distribution(s) paid, R${total.toFixed(2)} in all. ` +
        `${waiting.length} year(s) waiting on a posted rate. ${failures.length} failed.`,
      after: { paid, total, waiting: waiting.length, failures },
    }).catch(() => {});
  }

  console.log(`[anniversary] ${paid} paid (R${total.toFixed(2)}) · ` +
              `${waiting.length} waiting on a rate · ${failures.length} failed`);
  return { paid, total, waiting: waiting.length, failures, items };
}

function startAnniversaryCron() {
  cron.schedule('10 6 * * *', () => {
    runAnniversaryReturns().catch(err =>
      console.error('[anniversary] run failed:', err.message));
  }, { timezone: BUSINESS_TZ });
  console.log('⏰ Anniversary return distribution scheduled (06:10 SAST, daily)');
}

module.exports = { startAnniversaryCron, runAnniversaryReturns };
