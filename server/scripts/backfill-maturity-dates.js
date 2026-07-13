'use strict';
/* One-off backfill: set investments.end_date to investment_pools.maturity_date
   for all active investments where the pool has a canonical maturity_date.
   Run once: node server/scripts/backfill-maturity-dates.js */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const db = require('../db/pool');

async function run() {
  // Preview what will change
  const { rows: preview } = await db.query(`
    SELECT i.id, i.investor_id, i.pool_name,
           i.end_date    AS current_end_date,
           ip.maturity_date AS pool_maturity_date
    FROM investments i
    JOIN investment_pools ip ON ip.id = i.pool_id
    WHERE ip.maturity_date IS NOT NULL
      AND i.status IN ('active', 'waitlist')
      AND (i.end_date IS DISTINCT FROM ip.maturity_date)
    ORDER BY ip.maturity_date, i.pool_name
  `);

  if (!preview.length) {
    console.log('Nothing to update — all active investments already match pool maturity dates.');
    await db.end();
    return;
  }

  console.log(`\nWill update ${preview.length} investment(s):\n`);
  preview.forEach(r => {
    console.log(`  ${r.id}  ${(r.pool_name || '').padEnd(30)}  ${r.current_end_date} → ${r.pool_maturity_date}`);
  });

  // Apply the update
  const { rowCount } = await db.query(`
    UPDATE investments i
    SET end_date = ip.maturity_date
    FROM investment_pools ip
    WHERE ip.id = i.pool_id
      AND ip.maturity_date IS NOT NULL
      AND i.status IN ('active', 'waitlist')
      AND (i.end_date IS DISTINCT FROM ip.maturity_date)
  `);

  console.log(`\n✓ Updated ${rowCount} investment row(s).`);
  await db.end();
}

run().catch(err => { console.error('Backfill failed:', err.message); process.exit(1); });
