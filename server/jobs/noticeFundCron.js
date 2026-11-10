'use strict';
/* Pay the 30-day notice fund's withdrawals each morning.
 *
 * A withdrawal is paid once its notice has run, at the unit price on that
 * day, which the month's declared rate fixes. This is what pays it. A month
 * with no rate yet leaves it waiting; declaring the rate pays it at once.
 */
const cron = require('./_watched');
const pool = require('../db/pool');
const noticeFund = require('../services/noticeFund');

async function settleAll() {
  const { rows: funds } = await pool.query(
    `SELECT DISTINCT fund_id FROM notice_fund_orders WHERE status = 'pending'`);
  const totals = { redemptions: 0, waiting: 0 };
  for (const f of funds) {
    try {
      const r = await noticeFund.settle(pool, f.fund_id);
      totals.redemptions += r.redemptions; totals.waiting += r.waiting;
    } catch (err) {
      console.error(`[noticeFund] settling ${f.fund_id} failed:`, err.message);
    }
  }
  if (totals.redemptions || totals.waiting) {
    console.log(`[noticeFund] paid ${totals.redemptions} withdrawal(s); ${totals.waiting} waiting for a month's rate`);
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
