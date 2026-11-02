'use strict';
/* The job that notices the other jobs have stopped.
 *
 * An error that is reported is the easy half. A cron that silently stops
 * being scheduled — a container that restarted badly, a require that failed
 * at boot, a timezone that moved it off the end of the day — produces no
 * exception, no log line and no incident. Just maturities that are never
 * paid, and a client who finds out before we do.
 *
 * Every job writes a heartbeat either side of each run (see jobs/_watched)
 * with how long it may reasonably go quiet. This reads those rows hourly and
 * raises an incident for anything overdue. The incident folds like any
 * other, so a job that stays down sends one alert and then at most one an
 * hour, with the occurrence count saying how long it has been down.
 *
 * It does not watch itself: a sweep that has stopped cannot notice that it
 * has stopped, and pretending otherwise would be the most misleading green
 * light on the platform. What catches THIS is the absence of its own
 * heartbeat row, which the admin panel shows.
 */

const cron      = require('./_watched');
const incidents = require('../services/incidents');

async function runHeartbeatSweep() {
  const late = await incidents.sweepOverdueJobs();
  if (late.length) {
    console.warn(`[heartbeat] ${late.length} job(s) overdue: `
      + late.map(j => `${j.job} (${Math.round(j.quiet_minutes)}m)`).join(', '));
  }
  return late;
}

function startHeartbeatCron() {
  /* watch: false — see above. It still writes its own heartbeat through
     jobFinished so the panel can show when it last ran. */
  cron.schedule('40 * * * *', async () => {
    const startedAt = new Date();
    try {
      await runHeartbeatSweep();
      await incidents.jobFinished('heartbeatCron', { startedAt, maxSilenceMinutes: 180 });
    } catch (err) {
      await incidents.jobFinished('heartbeatCron', { startedAt, error: err.message });
      await incidents.report(err, { source: 'job:heartbeatCron', severity: 'critical' });
    }
  }, { watch: false, timezone: 'UTC' });
  console.log('⏰ Heartbeat sweep scheduled: hourly at :40 UTC');
}

module.exports = { startHeartbeatCron, runHeartbeatSweep };
