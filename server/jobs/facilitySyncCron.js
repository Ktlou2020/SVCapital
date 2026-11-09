'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   Keeping the facility report from being stale by default.

   The figures come from a spreadsheet the operator maintains, and the first
   version of this only moved when somebody pressed Re-read in the console.
   That is the wrong default: a report nobody has refreshed is not neutral,
   it is wrong, and it is wrong in the direction of looking finished. Loads
   are added to that sheet every few days.

   So it is re-read on a schedule. What that is allowed to do is deliberately
   narrow — the sync service refuses anything but a published
   docs.google.com URL, never deletes a load that has left the sheet, and
   touches no wallet, schedule, NAV or payout. It restates a report.

   THE PREVIEW STAYS for the console, which is a different question: a person
   about to change what the fund reports wants to see what would change. The
   schedule has nobody to show it to, so it applies, and the audit row it
   writes names what moved. A run that changed nothing writes none, so the
   runs that did change a figure are the ones in the log.

   Through _watched rather than node-cron, so a schedule that silently stops
   being scheduled raises an incident instead of producing nothing. That is
   the failure that matters here: a stale report looks exactly like a correct
   one.
   ───────────────────────────────────────────────────────────────────────── */

const cron = require('./_watched');
const pool = require('../db/pool');
const sync = require('../services/facilitySync');

const BUSINESS_TZ = 'Africa/Johannesburg';

async function runFacilitySync() {
  const { rows } = await pool.query(
    `SELECT * FROM stl_facilities WHERE status = 'active' AND loads_url IS NOT NULL`);
  if (!rows.length) return { facilities: 0 };
  let changed = 0, failed = 0;
  for (const f of rows) {
    try {
      const out = await sync.sync(pool, f, { apply: true, actor: { email: 'schedule', role: 'system' } });
      const c = out.counts || {};
      const moved = (c.added || 0) + (c.newly_settled || 0) + (c.changed || 0);
      if (moved) changed++;
      console.log(`[facilitySync] ${f.name}: ${c.added || 0} new, ${c.newly_settled || 0} newly settled, `
        + `${c.changed || 0} changed, ${(out.warnings || []).length} warning(s)`);
    } catch (err) {
      /* One facility's sheet being unpublished or slow must not stop the
         others being read. The throw is logged and counted; _watched raises
         the incident if the whole run dies. */
      failed++;
      console.error(`[facilitySync] ${f.name} failed: ${err.message}`);
    }
  }
  return { facilities: rows.length, changed, failed };
}

function startFacilitySyncCron() {
  /* Every six hours, at :17. Six hours because loads appear in that sheet
     every few days and a report hours old is fine, where one days old is
     not; :17 rather than :00 because everything else on this server runs on
     the hour and a read of somebody else's service does not need to join the
     queue. Pinned to the business day, like every other schedule here. */
  cron.schedule('17 */6 * * *', async () => {
    try { await runFacilitySync(); }
    catch (err) { console.error('[facilitySync] cron error:', err.message); }
  }, { timezone: BUSINESS_TZ });
  console.log('⏰ Facility sync scheduled: every 6 hours at :17 SAST — re-read trading facility sheets');
}

module.exports = { startFacilitySyncCron, runFacilitySync };
