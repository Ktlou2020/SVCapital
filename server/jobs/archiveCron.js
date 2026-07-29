'use strict';

const cron = require('node-cron');
const pool = require('../db/pool');

function startArchiveCron() {
  // Daily at 02:00 SAST (00:00 UTC) — archive investors with no investments after 6 months
  cron.schedule('0 0 * * *', async () => {
    try {
      const { rowCount } = await pool.query(`
        UPDATE investors
           SET status      = 'archived',
               archived_at = NOW(),
               updated_at  = NOW()
         WHERE status = 'active'
           AND date_joined <= NOW() - INTERVAL '6 months'
           AND NOT EXISTS (
             SELECT 1 FROM investments WHERE investor_id = investors.id
           )
      `);
      if (rowCount > 0) {
        console.log(`[archiveCron] Archived ${rowCount} dormant investor(s) (no investment in 6+ months)`);
      }
    } catch (err) {
      console.error('[archiveCron] error:', err.message);
    }
  });
  console.log('[archiveCron] scheduled — daily 00:00 UTC');
}

module.exports = { startArchiveCron };
