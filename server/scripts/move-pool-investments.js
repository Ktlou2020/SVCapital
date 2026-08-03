'use strict';
/* One-off migration: move specific investments from one pool to another.
   Run: node server/scripts/move-pool-investments.js
   Add --execute flag to commit changes (dry-run by default). */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const db = require('../db/pool');

const SOURCE_POOL = 'POOL-MIGR-Q95OeHEfGKj5R47oQ72S';
const TARGET_POOL = 'POOL-MIGR-eLkgGxAsZK4cP02UC3Gj-CYC-1785484654069';

// Investments to move, matched by sub_account_id + amount within source pool.
// Bonisile Makubalo appears twice intentionally (two separate investments of same amount).
const CRITERIA = [
  { sub_account_id: 'S-11258',         amount: 8020.32 },
  { sub_account_id: 'S-112620',        amount: 6279.45 },
  { sub_account_id: 'S-11926',         amount: 2000.00 },
  { sub_account_id: 'S-111580',        amount: 10000.00 },
  { sub_account_id: 'S-111175',        amount: 10000.00 }, // Bonisile Makubalo (×2)
  { sub_account_id: 'S-11510',         amount: 1500.00 },
  { sub_account_id: 'S-111887',        amount: 1000.00 },
  { sub_account_id: 'SV-SXJ1X0',       amount: 3940.00 },
  { sub_account_id: 'S-111800',        amount: 5000.00 },
  { sub_account_id: 'S-11984',         amount: 20000.00 },
  { sub_account_id: 'SV-9J3SY2',       amount: 2000.00 },
  { sub_account_id: 'SV-RVIQYX',       amount: 1000.00 },
  { sub_account_id: 'SV-MRSWXU',       amount: 1000.00 },
  { sub_account_id: 'S-11606',         amount: 1949.95 },
  { sub_account_id: 'S-11329',         amount: 2000.00 },
  { sub_account_id: 'S-11420',         amount: 4000.00 },
  { sub_account_id: 'S-111896',        amount: 1000.00 },
  { sub_account_id: 'SV-1079546805',   amount: 1000.00 },
  { sub_account_id: 'S-11496',         amount: 1000.00 },
  { sub_account_id: 'S-111581',        amount: 1000.00 },
];

async function run() {
  const execute = process.argv.includes('--execute');

  // Verify both pools exist
  const { rows: pools } = await db.query(
    `SELECT id, name, status FROM investment_pools WHERE id = ANY($1)`,
    [[SOURCE_POOL, TARGET_POOL]]
  );
  const src = pools.find(p => p.id === SOURCE_POOL);
  const tgt = pools.find(p => p.id === TARGET_POOL);
  if (!src) { console.error(`ERROR: Source pool not found: ${SOURCE_POOL}`); process.exit(1); }
  if (!tgt) { console.error(`ERROR: Target pool not found: ${TARGET_POOL}`); process.exit(1); }
  console.log(`\nSource pool : ${src.name} (${src.status})`);
  console.log(`Target pool : ${tgt.name} (${tgt.status})\n`);

  // Find matching investments
  const placeholders = CRITERIA.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}::numeric)`).join(', ');
  const values = CRITERIA.flatMap(c => [c.sub_account_id, c.amount]);

  const { rows: found } = await db.query(`
    SELECT i.id, i.sub_account_id, i.amount, i.status, i.end_date,
           inv.first_name || ' ' || inv.last_name AS investor_name
    FROM investments i
    JOIN investors inv ON inv.id = i.investor_id
    WHERE i.pool_id = $${values.length + 1}
      AND (i.sub_account_id, i.amount) IN (${placeholders})
    ORDER BY i.end_date DESC, investor_name
  `, [...values, SOURCE_POOL]);

  if (!found.length) {
    console.log('No matching investments found in source pool. Nothing to do.');
    await db.end();
    return;
  }

  console.log(`Found ${found.length} investment(s) to move:\n`);
  console.log('  Sub-account      Amount       Status     End date    Investor');
  console.log('  ─────────────────────────────────────────────────────────────────');
  found.forEach(r => {
    const amt   = `R${Number(r.amount).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`;
    const edate = r.end_date ? r.end_date.toISOString().slice(0, 10) : '—';
    console.log(`  ${r.sub_account_id.padEnd(16)} ${amt.padStart(12)}   ${(r.status || '').padEnd(10)} ${edate}   ${r.investor_name}`);
  });

  // Warn if expected count differs
  // NOTE: Bonisile Makubalo has 2 identical rows → expected count is 21, not 20
  const EXPECTED = 21;
  if (found.length !== EXPECTED) {
    console.log(`\n⚠  Expected ${EXPECTED} investments but found ${found.length}. Review before executing.`);
  }

  if (!execute) {
    console.log('\n──────────────────────────────────────────────');
    console.log('DRY RUN — no changes made.');
    console.log('Re-run with --execute to apply.\n');
    await db.end();
    return;
  }

  const ids = found.map(r => r.id);
  const { rowCount } = await db.query(
    `UPDATE investments SET pool_id = $1 WHERE id = ANY($2::text[])`,
    [TARGET_POOL, ids]
  );
  console.log(`\n✓ Moved ${rowCount} investment(s) to "${tgt.name}".`);
  await db.end();
}

run().catch(err => { console.error(err); process.exit(1); });
