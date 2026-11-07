#!/usr/bin/env node
/* Set investor_type on the clients that came from the Firebase export.
 *
 * The export carries the answer in a field called investorType and the
 * migration never read it, so every imported client reads "Not set" in the
 * console. This fills them in.
 *
 * THE CLASSIFICATION AND THE WRITE ARE IN services/investorTypeBackfill, which
 * the console panel calls too (Settings → Data Migration → Post-Migration
 * Utilities → Investor Types from the Export). This file is the command line
 * over it: it reads the file off disk and prints. A second copy of the
 * classification here would drift from the one somebody runs in the console.
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
const { investorTypeLabel } = require('../services/investorType');
const svc = require('../services/investorTypeBackfill');

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
    let records;
    try {
      records = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
      console.error(`Could not read ${FILE}: ${e.message}`);
      process.exit(1);
    }

    let s;
    try {
      s = await svc.survey(pool, { records });
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }

    console.log(`\nInvestor types from ${FILE}`);
    console.log(APPLY
      ? `  MODE: APPLY${OVERWRITE ? ' (overwriting types already set)' : ''}`
      : '  MODE: preview only — nothing will be written. Add --apply to write.');
    console.log(`  ${s.total} record(s) in the export\n`);

    console.log(`  TO SET (${s.toSet.length}) — currently "Not set"`);
    for (const [t, n] of Object.entries(s.byType)) {
      console.log(`      ${investorTypeLabel(t).padEnd(12)} ${n}`);
    }
    for (const t of s.toSet.slice(0, 10)) {
      console.log(`        ${t.id}  ${t.name} → ${investorTypeLabel(t.type)}`);
    }
    if (s.toSet.length > 10) console.log(`        … and ${s.toSet.length - 10} more`);

    if (s.conflicts.length) {
      console.log(`\n  ALREADY SET, AND THE EXPORT DISAGREES (${s.conflicts.length})`);
      console.log('      The console is the more recent authority, so these are SKIPPED');
      console.log('      unless you pass --overwrite. Look at them before you do.');
      for (const c of s.conflicts.slice(0, 10)) {
        console.log(`        ${c.id}  ${c.name}: console says ${investorTypeLabel(c.was)}, `
                  + `export says ${investorTypeLabel(c.type)}`);
      }
      if (s.conflicts.length > 10) console.log(`        … and ${s.conflicts.length - 10} more`);
    }

    if (s.unmapped.length) {
      console.log(`\n  NOT RECOGNISED (${s.unmapped.length} value(s)) — SKIPPED, never guessed`);
      console.log('      Calling an unknown "Individual" would turn an imported trust into a');
      console.log('      natural person, and the next FICA run would verify it as one. Add');
      console.log('      these to ALIASES in server/services/investorType.js and re-run:');
      for (const u of s.unmapped) console.log(`        ${JSON.stringify(u.value)} — ${u.count} record(s)`);
      exitCode = 0;   // reporting, not failing — the operator decides
    }

    if (s.missing.length) {
      console.log(`\n  IN THE EXPORT BUT NOT IN THIS DATABASE (${s.missing.length}) — skipped`);
      console.log('      Usually a client who was never imported, or a different environment.');
    }
    if (s.noType)          console.log(`\n  ${s.noType} export record(s) carry no investorType at all — skipped.`);
    if (s.noId)            console.log(`  ${s.noId} export record(s) carry no userAccountNumber — skipped.`);
    if (s.unchanged.length) console.log(`  ${s.unchanged.length} already correct.`);

    if (!APPLY) {
      console.log(`\n  Preview only. --apply would set ${s.toSet.length}`
                + `${s.conflicts.length ? `, and ${s.conflicts.length} more with --overwrite` : ''}.\n`);
      return;
    }

    const r = await svc.execute(pool, {
      survey: s, overwrite: OVERWRITE, source: path.basename(FILE),
      actor: { id: null, email: 'cli', role: 'admin' },
    });
    if (!r.written) { console.log('\n  Nothing to write.\n'); return; }

    console.log(`\n  ✅ ${r.written} client(s) classified.`);
    for (const w of r.warnings) console.log(`  ⚠  ${w}`);
    console.log('  Clients → the Type column. Filter by "Not set" to see what is left.\n');
  } catch (err) {
    console.error('\n  Failed:', err.message);
    exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
    /* services/audit writes through db/pool, whose idle connections hold the
       event loop open long after the work is done. */
    await require('../db/pool').end().catch(() => {});
    process.exit(exitCode);
  }
})();
