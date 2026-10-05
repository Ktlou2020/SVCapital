'use strict';
/* The weekly beef price, fetched on a schedule.
 *
 * Thursday morning, SAST — the report is published during the week and this
 * gives it time to land, while still being well before a month end. The
 * timezone is named explicitly: a cron left on UTC fires at a different local
 * hour for half the year in places that shift, and reads as a different day
 * either side of midnight. Same reasoning as the pool cycler.
 *
 * A run that finds nothing is not an error and does not retry in a loop. It
 * writes down what it saw and the report shows that the price is ageing, which
 * is the signal a person can act on. */

const cron = require('node-cron');
const { runBeefPriceFetch } = require('../services/beefPriceFetch');

const BUSINESS_TZ = 'Africa/Johannesburg';

function startBeefPriceCron() {
  cron.schedule('17 7 * * 4', () => {
    runBeefPriceFetch({ triggeredBy: null })
      .catch(e => console.error('[beefPriceCron] run failed:', e.message));
  }, { timezone: BUSINESS_TZ });
  console.log('[beefPriceCron] Scheduled: Thursdays at 07:17 SAST');
}

module.exports = { startBeefPriceCron, BUSINESS_TZ };
