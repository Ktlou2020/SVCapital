#!/usr/bin/env node
/* Find text already in the database that the admin console would render as markup.
 *
 * The write paths are closed: non-privileged writes have their text stripped,
 * and email and id_number are refused outright. Neither of those reaches rows
 * that are ALREADY stored — written before that fix, or brought in by the
 * Firebase migration, which passed through no sanitiser at all.
 *
 * The detection lives in server/services/storedMarkupAudit.js, shared with the
 * admin endpoint (GET /api/admin/stored-markup-audit). This file only renders
 * it. Two copies of a security check drift, and then they disagree about
 * whether anything is wrong.
 *
 * Two severities, because they are not the same thing:
 *
 *   EXECUTABLE   a tag, an event handler or a javascript: url — the thing that
 *                would actually run, in a session that can reach manual credit,
 *                bulk KYC approval and the pool remap.
 *
 *   BREAKING     a bare quote or bracket in a field the console interpolates
 *                into an HTML attribute. Nothing executes, but it truncates the
 *                attribute, so the controls in that row stop working — and an
 *                apostrophe in a surname is common enough that this is probably
 *                already happening to real people.
 *
 * READ-ONLY. Every statement is a SELECT.
 *
 * Run:
 *   DATABASE_URL="<production url>" node server/scripts/audit-stored-markup.cjs
 *   …add --csv to write stored-markup-audit.csv alongside the report.
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See the header of this file.');
  process.exit(2);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { runStoredMarkupAudit } = require(path.join(__dirname, '..', 'services', 'storedMarkupAudit'));

const WANT_CSV = process.argv.includes('--csv');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  statement_timeout: 60000,
});

const H = s => console.log(`\n${s}\n${'─'.repeat(s.length)}`);

(async () => {
  try {
    const r = await runStoredMarkupAudit(pool);

    H('Stored text the admin console would render as markup');
    console.log(`\nEXECUTABLE  ${r.totals.executable}   tags, event handlers or javascript: urls`);
    console.log(`BREAKING    ${r.totals.breaking}   quotes or brackets that truncate an HTML attribute`);
    console.log(`\n  scanned ${r.scanned.length} column(s)${r.skipped.length ? `, skipped ${r.skipped.length} not present` : ''}`);

    if (r.executable.length) {
      H('EXECUTABLE — treat as an incident');
      console.log('  These would run in whatever session renders them. The admin console can');
      console.log('  reach manual credit, bulk KYC approval and the pool remap.\n');
      for (const x of r.executable) {
        console.log(`  ${x.table}.${x.column}  row ${x.rowId}`);
        console.log(`     ${String(x.value).slice(0, 160)}`);
      }
      console.log('\n  Clear these before anyone opens the screens that show them.');
    }

    if (r.breaking.length) {
      H('BREAKING — buttons in these rows may already be dead');
      console.log('  A quote ends the attribute early. Nothing executes, but the controls in');
      console.log('  that row stop working — and an apostrophe in a surname is ordinary, so');
      console.log('  some of these are real people rather than anything malicious.\n');
      const shown = r.breaking.slice(0, 25);
      for (const x of shown) {
        console.log(`  ${x.table}.${x.column}  row ${x.rowId}   ${String(x.value).slice(0, 80)}`);
      }
      if (r.breaking.length > shown.length) {
        console.log(`  …and ${r.breaking.length - shown.length} more`);
      }
    }

    if (WANT_CSV && (r.executable.length || r.breaking.length)) {
      const out = path.join(process.cwd(), 'stored-markup-audit.csv');
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = ['severity,table,column,row_id,value'];
      for (const x of r.executable) lines.push(['EXECUTABLE', x.table, x.column, x.rowId, x.value].map(esc).join(','));
      for (const x of r.breaking)   lines.push(['BREAKING',   x.table, x.column, x.rowId, x.value].map(esc).join(','));
      fs.writeFileSync(out, lines.join('\n'));
      console.log(`\n  wrote ${out} (${lines.length - 1} rows)`);
    }

    H('Summary');
    if (r.verdict === 'clean') {
      console.log('  Nothing found. No stored text in the audited columns contains markup,');
      console.log('  an event handler, or a character that would break out of an attribute.');
    } else if (r.verdict === 'attribute-breaking-only') {
      console.log(`  Nothing executable. ${r.totals.breaking} row(s) carry a quote or bracket that`);
      console.log('  breaks an attribute — a display and usability problem, not a security one.');
    } else {
      console.log(`  ${r.totals.executable} row(s) contain something that would execute. Deal with those first.`);
    }
    console.log('\n  This audits what is STORED. The write paths are closed separately, so');
    console.log('  nothing new should appear here. Nothing was changed by running this.\n');
  } catch (err) {
    console.error('\naudit failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
