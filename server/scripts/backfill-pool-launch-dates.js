'use strict';
/**
 * Backfill investment_pools.start_date from launchDate in investmentPools.json.
 *
 * Run:  DATABASE_URL=<url> node server/scripts/backfill-pool-launch-dates.js
 *
 * The script also updates end_date (closingDate) and maturity_date where they
 * are NULL or mismatched.  It only touches pools whose id starts with "POOL-MIGR-".
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs   = require('fs');
const path = require('path');
const pool = require('../db/pool');

const DATA_DIR    = path.join(__dirname, '../../migration-data');
const POOLS_FILE  = path.join(DATA_DIR, 'investmentPools.json');

async function backfill() {
  if (!fs.existsSync(POOLS_FILE)) {
    console.error(`❌  File not found: ${POOLS_FILE}`);
    process.exit(1);
  }

  const pools = JSON.parse(fs.readFileSync(POOLS_FILE, 'utf8'));
  console.log(`📂  Loaded ${pools.length} pools from JSON\n`);

  let updated = 0, skipped = 0, errors = 0;

  for (const p of pools) {
    if (!p._id || !p.launchDate) { skipped++; continue; }

    const id           = `POOL-MIGR-${p._id}`;
    const launchDate   = new Date(p.launchDate);
    const closingDate  = p.closingDate  ? new Date(p.closingDate)  : null;
    const maturityDate = p.maturityDate ? new Date(p.maturityDate) : null;

    let termMonths = null;
    if (p.launchDate && p.maturityDate) {
      const diff = new Date(p.maturityDate) - launchDate;
      termMonths = Math.round(diff / (1000 * 60 * 60 * 24 * 30));
    }

    try {
      const { rowCount } = await pool.query(`
        UPDATE investment_pools
        SET    start_date    = $1,
               end_date      = COALESCE($2, end_date),
               maturity_date = COALESCE($3, maturity_date),
               term_months   = COALESCE($4, term_months),
               updated_at    = NOW()
        WHERE  id = $5
      `, [launchDate, closingDate, maturityDate, termMonths, id]);

      if (rowCount > 0) {
        console.log(`  ✓ ${id}  launch=${p.launchDate}`);
        updated++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`  ✗ ${id}: ${err.message}`);
      errors++;
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log(`Updated: ${updated}  Skipped: ${skipped}  Errors: ${errors}`);
  await pool.end();
}

backfill().catch(err => { console.error(err); process.exit(1); });
