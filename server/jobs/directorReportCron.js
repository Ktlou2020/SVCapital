'use strict';
const cron         = require('node-cron');
const emailService = require('../services/email');
const { staffRecipients, warnIfNotUsers } = require('../services/staffRecipients');

async function runDirectorReport() {
  console.log('[directorReportCron] Running monthly director report job…');
  try {
    /* 1. Who gets the report.
       This asked `users` for role director or admin. In this platform `users`
       holds investors; staff live in `employees` and their privilege is derived
       at login rather than stored, so the query returned nobody and the branch
       below skipped the month — quietly, at info level, every month. */
    const { to: directors, source } = await staffRecipients();
    warnIfNotUsers(source, 'directorReportCron');
    if (!directors.length) {
      console.log('[directorReportCron] No recipients resolved — skipping.');
      return;
    }

    /* 2. The figures.
       These were eight queries written here, and the dashboard added a ninth
       set. Two sets of queries is two answers to "what was AUM in September",
       and nothing keeps them in step — so both now read one service. The
       month boundaries moved with them: date_trunc ran in the database's
       timezone, which is UTC, so a transaction at 01:30 on the 1st in
       Johannesburg was filed under the previous month. */
    const report = require('../services/directorReport');
    const data   = await report.buildReport(null);
    const monthLabel = data.monthLabel;

    // 3. Build HTML email report and send to each director
    for (const director of directors) {
      await emailService.sendDirectorReport(director, {
        monthLabel,
        aum:            data.aum.closing,
        aumChangePct:   data.aum.changePct,
        newInvestors:   data.investors.joinedThisMonth,
        /* Income accrued in the month. NOT payouts: a payout is the client's
           own capital coming back plus the return on it, and summing those as
           "returns distributed" overstated it by the whole capital in any
           month with maturities. */
        returnsTotal:   data.returns.accruedThisMonth,
        depositsTotal:  data.aum.movement.newCapital,
        totalInvestors: data.investors.activeInvestors,
        reinvestedPct:  data.returns.reinvestment.reinvestedPct,
        pools: data.pools.map(p => ({
          pool_id: p.id, pool_name: p.name, product_type: p.productType,
          invested: p.aum, investors: p.investors, maturity_date: p.maturityDate,
        })),
        reportUrl: (process.env.APP_URL || 'https://platform.svcapital.co.za') + '/team/director.html#monthly-report',
      }).catch(e => console.error('[directorReportCron] email error:', e.message));
    }

    console.log(`[directorReportCron] Sent report for ${monthLabel} to ${directors.length} director(s)`);
  } catch (e) {
    console.error('[directorReportCron] Fatal error:', e.message);
  }
}

function startDirectorReportCron() {
  cron.schedule('0 7 1 * *', () => {
    // Passed bare, a rejection from this async fn is an unhandled
    // rejection, which ends the process on Node 20.
    runDirectorReport().catch(e => console.error('[directorReport] cron error:', e.message));
  }, { timezone: 'UTC' });
  console.log('[directorReportCron] Scheduled: 1st of month at 07:00 UTC (09:00 SAST)');
}

module.exports = { startDirectorReportCron, runDirectorReport };
