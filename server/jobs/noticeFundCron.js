'use strict';
/* Settle the 30-day notice fund each morning.
 *
 * Posting a price settles what it prices at once (routes/noticeFundAdmin.js).
 * This catches the rest: a withdrawal whose notice ran out overnight, when a
 * price on or after that day was posted earlier. Without it, that group's
 * money would wait for the next price to be posted.
 */
const cron = require('./_watched');
const pool = require('../db/pool');
const noticeFund = require('../services/noticeFund');

async function settleAll() {
  const { rows: funds } = await pool.query(
    `SELECT DISTINCT fund_id FROM notice_fund_orders WHERE status = 'pending'`);
  const totals = { subscriptions: 0, redemptions: 0, waiting: 0 };
  for (const f of funds) {
    try {
      const r = await noticeFund.settle(pool, f.fund_id);
      totals.subscriptions += r.subscriptions; totals.redemptions += r.redemptions; totals.waiting += r.waiting;
    } catch (err) {
      console.error(`[noticeFund] settling ${f.fund_id} failed:`, err.message);
    }
  }
  if (totals.subscriptions || totals.redemptions) {
    console.log(`[noticeFund] settled ${totals.subscriptions} in, ${totals.redemptions} out; ${totals.waiting} waiting for a price`);
  }
  return totals;
}

function startNoticeFundCron() {
  // 06:40 SAST — after the night's jobs, before anybody opens the app.
  cron.schedule('40 6 * * *', async () => {
    try { await settleAll(); }
    catch (err) { console.error('[noticeFund] cron error:', err.message); }
  }, { timezone: 'Africa/Johannesburg' });
  console.log('[noticeFund] scheduled: 06:40 settle the notice fund (SAST)');
}

module.exports = { startNoticeFundCron, settleAll };
