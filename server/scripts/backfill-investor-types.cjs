#!/usr/bin/env node
/* Set investor_type on the clients that came from the Firebase export.
 *
 * The export carries the answer in a field called investorType and the
 * migration never read it, so every imported client reads "Not set" in the
 * console. This fills them in.
 *
 * ── WHY NOT JUST RE-RUN THE MIGRATION ─────────────────────────────────
 *
 * migrate-from-firebase.js now maps investorType, so re-running it WOULD set
 * these. It would also rewrite first_name, last_name, email, phone,
 * id_number, date_of_birth, kyc_status, fica_status, status, risk_profile,
 * occupation, notes, address and province from the export — overwriting
 * anything staff have corrected in the console since the import, on every
 * client, to fill in one column. This reads the same file and writes one
 * field.
 *
 * ── WHAT IT WILL NOT DO ───────────────────────────────────────────────
 *
 * Guess. A value the mapper does not recognise is reported and skipped, never
 * defaulted to 'individual': that would turn an imported trust into a natural
 * person, and the next FICA run would verify it against Home Affairs instead
 * of its deed and trustees. The unrecognised values are listed so they can be
 * added to ALIASES in services/investorType.js and the script re-run.
 *
 * It also will not overwrite a type somebody has already set by hand, unless
 * you pass --overwrite. The console is the more recent authority.
 *
 * PREVIEWS BY DEFAULT. Nothing is written without --apply, following
 * backfill-stokvel-shares.cjs.
 *
 * Usage:
 *   DATABASE_URL=… node server/scripts/backfill-investor-types.cjs
 *   …                                                    --apply
 *   …                                                    --apply --overwrite
 *   …                                --file=/path/to/users.json
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { normaliseInvestorType, investorTypeLabel } = require('../services/investorType');

const APPLY     = process.argv.includes('--apply');
const OVERWRITE = process.argv.includes('--overwrite');
const FILE_ARG  = (process.argv.find(a => a.startsWith('--file=')) || '').split('=')[1];
const FILE = FILE_ARG || path.join(__dirname, '..', '..', 'migration-data', 'users.json');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (!fs.existsSync(FILE)) {
  console.error(`No export file at ${FILE}`);
  console.error('Copy the Firebase export\'s users.json to migration-data/, or pass --file=<path>.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

(async () => {
  let exitCode = 0;
  try {
    let users;
    try {
      users = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
      console.error(`Could not read ${FILE}: ${e.message}`);
      process.exit(1);
    }
    if (!Array.isArray(users)) {
      console.error('Expected users.json to be an array of user records.');
      process.exit(1);
    }

    console.log(`\nInvestor types from ${FILE}`);
    console.log(APPLY
      ? `  MODE: APPLY${OVERWRITE ? ' (overwriting types already set)' : ''}`
      : '  MODE: preview only — nothing will be written. Add --apply to write.');
    console.log(`  ${users.length} record(s) in the export\n`);

    /* What the export says, per account number. */
    const wanted = new Map();          // id → canonical type
    const unmapped = new Map();        // raw value → count
    let noType = 0;
    for (const u of users) {
      const id = u && u.userAccountNumber;
      if (!id) continue;
      if (!u.investorType) { noType++; continue; }
      const t = normaliseInvestorType(u.investorType);
      if (!t) {
        unmapped.set(String(u.investorType), (unmapped.get(String(u.investorType)) || 0) + 1);
        continue;
      }
      wanted.set(String(id), t);
    }

    /* What the database has. Only the ones the export actually names. */
    const ids = [...wanted.keys()];
    const { rows: current } = ids.length
      ? await pool.query(
          `SELECT id, first_name, last_name, investor_type FROM investors WHERE id = ANY($1::text[])`,
          [ids])
      : { rows: [] };
    const have = new Map(current.map(r => [r.id, r]));

    const toSet = [], conflicts = [], unchanged = [], missing = [];
    for (const [id, type] of wanted) {
      const row = have.get(id);
      if (!row) { missing.push({ id, type }); continue; }
      if (!row.investor_type) { toSet.push({ id, type, row }); continue; }
      if (row.investor_type === type) { unchanged.push(id); continue; }
      conflicts.push({ id, type, was: row.investor_type, row });
    }

    const name = r => [r.first_name, r.last_name].filter(Boolean).join(' ') || r.id;

    const counts = {};
    for (const t of toSet) counts[t.type] = (counts[t.type] || 0) + 1;
    console.log(`  TO SET (${toSet.length}) — currently "Not set"`);
    for (const [t, n] of Object.entries(counts)) console.log(`      ${investorTypeLabel(t).padEnd(12)} ${n}`);
    for (const t of toSet.slice(0, 10)) {
      console.log(`        ${t.id}  ${name(t.row)} → ${investorTypeLabel(t.type)}`);
    }
    if (toSet.length > 10) console.log(`        … and ${toSet.length - 10} more`);

    if (conflicts.length) {
      console.log(`\n  ALREADY SET, AND THE EXPORT DISAGREES (${conflicts.length})`);
      console.log('      The console is the more recent authority, so these are SKIPPED');
      console.log('      unless you pass --overwrite. Look at them before you do.');
      for (const c of conflicts.slice(0, 10)) {
        console.log(`        ${c.id}  ${name(c.row)}: console says ${investorTypeLabel(c.was)}, `
                  + `export says ${investorTypeLabel(c.type)}`);
      }
      if (conflicts.length > 10) console.log(`        … and ${conflicts.length - 10} more`);
    }

    if (unmapped.size) {
      console.log(`\n  NOT RECOGNISED (${unmapped.size} value(s)) — SKIPPED, never guessed`);
      console.log('      Calling an unknown "Individual" would turn an imported trust into a');
      console.log('      natural person, and the next FICA run would verify it as one. Add');
      console.log('      these to ALIASES in server/services/investorType.js and re-run:');
      for (const [v, n] of unmapped) console.log(`        ${JSON.stringify(v)} — ${n} record(s)`);
      exitCode = 0;   // reporting, not failing — the operator decides
    }

    if (missing.length) {
      console.log(`\n  IN THE EXPORT BUT NOT IN THIS DATABASE (${missing.length}) — skipped`);
      console.log('      Usually a client who was never imported, or a different environment.');
    }
    if (noType)          console.log(`\n  ${noType} export record(s) carry no investorType at all — skipped.`);
    if (unchanged.length) console.log(`  ${unchanged.length} already correct.`);

    const writes = OVERWRITE ? [...toSet, ...conflicts] : toSet;
    if (!APPLY) {
      console.log(`\n  Preview only. --apply would set ${toSet.length}`
                + `${conflicts.length ? `, and ${conflicts.length} more with --overwrite` : ''}.\n`);
      return;
    }
    if (!writes.length) { console.log('\n  Nothing to write.\n'); return; }

    /* One transaction: a half-applied classification across the book is
       worse than none, because the console would show a mixture nobody
       could tell apart from a partial import. */
    const client = await pool.connect();
    let written = 0;
    try {
      await client.query('BEGIN');
      for (const w of writes) {
        const { rowCount } = await client.query(
          `UPDATE investors SET investor_type = $2, updated_at = NOW() WHERE id = $1`,
          [w.id, w.type]);
        written += rowCount;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    console.log(`\n  ✅ ${written} client(s) classified.`);
    console.log('  Clients → the Type column. Filter by "Not set" to see what is left.\n');
  } catch (err) {
    console.error('\n  Failed:', err.message);
    exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
    process.exit(exitCode);
  }
})();
