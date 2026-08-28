#!/usr/bin/env node
/* Find text already in the database that the admin console would render as markup.
 *
 * The write paths are now closed: identity columns are blocked for non-admin
 * roles and their other free text is stripped. Neither of those reaches rows
 * that are ALREADY stored — written before the fix, or brought in by the
 * Firebase migration, which passed through no sanitiser at all.
 *
 * So this asks the only question the fix cannot answer: is there anything in
 * there now. It reports two kinds of finding, because they are not equally
 * serious:
 *
 *   EXECUTABLE   a tag or an event handler — <img onerror=…>, <script>,
 *                javascript: — which is the thing that would actually run in
 *                an admin session.
 *
 *   BREAKING     a bare quote or angle bracket in a field the console
 *                interpolates into an HTML attribute. Not script execution,
 *                but it truncates the attribute, so buttons in that row stop
 *                working — and an apostrophe in a surname is common enough
 *                that this is probably already happening to real people.
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

const WANT_CSV = process.argv.includes('--csv');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  statement_timeout: 60000,
});

const H = s => console.log(`\n${s}\n${'─'.repeat(s.length)}`);

/* Where investor-controlled text lands, and which columns the admin console
   interpolates. Kept explicit rather than scanning every text column: a
   false positive on a field nobody renders is noise that hides the real ones. */
const TARGETS = [
  { table: 'investors',       id: 'id', cols: ['first_name', 'last_name', 'email', 'address', 'street_address', 'suburb', 'occupation', 'notes'] },
  { table: 'sub_accounts',    id: 'id', cols: ['name'] },
  { table: 'support_tickets', id: 'id', cols: ['subject', 'message'] },
  { table: 'transactions',    id: 'id', cols: ['description', 'reference'] },
  { table: 'investment_pools',id: 'id', cols: ['name', 'description'] },
];

/* A tag, or an inline handler, or a javascript: url. Deliberately narrower
   than "contains < or >": a description reading "R < 100" is not a finding,
   and reporting it alongside a real one is how a real one gets skimmed past. */
const EXECUTABLE = `(
     %s ~* '<[a-z][^>]*>'
  OR %s ~* 'on[a-z]+\\s*='
  OR %s ~* 'javascript:'
)`;
/* Quotes and stray brackets — attribute-breaking rather than executing. */
const BREAKING = `(%s ~ '[<>"'']')`;

async function hasTable(t) {
  const { rows } = await pool.query(`SELECT to_regclass('public.' || $1) IS NOT NULL AS ok`, [t]);
  return rows[0].ok;
}
async function hasColumn(t, c) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int n FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`, [t, c]);
  return rows[0].n > 0;
}

(async () => {
  const executable = [], breaking = [];
  try {
    for (const t of TARGETS) {
      if (!await hasTable(t.table)) continue;
      for (const col of t.cols) {
        if (!await hasColumn(t.table, col)) continue;

        const ex = EXECUTABLE.replace(/%s/g, col);
        const { rows: hits } = await pool.query(
          `SELECT ${t.id} AS row_id, ${col} AS value FROM ${t.table}
            WHERE ${col} IS NOT NULL AND ${ex} LIMIT 200`);
        for (const h of hits) executable.push({ table: t.table, col, id: h.row_id, value: h.value });

        const br = BREAKING.replace(/%s/g, col);
        const { rows: soft } = await pool.query(
          `SELECT ${t.id} AS row_id, ${col} AS value FROM ${t.table}
            WHERE ${col} IS NOT NULL AND ${br} AND NOT ${ex} LIMIT 200`);
        for (const s of soft) breaking.push({ table: t.table, col, id: s.row_id, value: s.value });
      }
    }

    H('Stored text the admin console would render as markup');
    console.log(`\nEXECUTABLE  ${executable.length}   tags, event handlers or javascript: urls`);
    console.log(`BREAKING    ${breaking.length}   quotes or brackets that truncate an HTML attribute`);

    if (executable.length) {
      H('EXECUTABLE — treat as an incident');
      console.log('  These would run in whatever session renders them. The admin console can');
      console.log('  reach manual credit, bulk KYC approval and the pool remap.\n');
      for (const r of executable) {
        console.log(`  ${r.table}.${r.col}  row ${r.id}`);
        console.log(`     ${String(r.value).slice(0, 160)}`);
      }
      console.log('\n  Clear these before anyone opens the screens that show them.');
    }

    if (breaking.length) {
      H('BREAKING — buttons in these rows may already be dead');
      console.log('  A quote ends the attribute early. Nothing executes, but the controls in');
      console.log('  that row stop working — and an apostrophe in a surname is ordinary, so');
      console.log('  some of these are probably real people rather than anything malicious.\n');
      const shown = breaking.slice(0, 25);
      for (const r of shown) {
        console.log(`  ${r.table}.${r.col}  row ${r.id}   ${String(r.value).slice(0, 80)}`);
      }
      if (breaking.length > shown.length) {
        console.log(`  …and ${breaking.length - shown.length} more`);
      }
    }

    if (WANT_CSV && (executable.length || breaking.length)) {
      const out = path.join(process.cwd(), 'stored-markup-audit.csv');
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = ['severity,table,column,row_id,value'];
      for (const r of executable) lines.push(['EXECUTABLE', r.table, r.col, r.id, r.value].map(esc).join(','));
      for (const r of breaking)   lines.push(['BREAKING',   r.table, r.col, r.id, r.value].map(esc).join(','));
      fs.writeFileSync(out, lines.join('\n'));
      console.log(`\n  wrote ${out} (${lines.length - 1} rows)`);
    }

    H('Summary');
    if (!executable.length && !breaking.length) {
      console.log('  Nothing found. No stored text in the audited columns contains markup,');
      console.log('  an event handler, or a character that would break out of an attribute.');
    } else if (!executable.length) {
      console.log(`  Nothing executable. ${breaking.length} row(s) carry a quote or bracket that`);
      console.log('  breaks an attribute — a display and usability problem, not a security one.');
    } else {
      console.log(`  ${executable.length} row(s) contain something that would execute. Deal with those first.`);
    }
    console.log('\n  This audits what is STORED. The write paths are closed separately —');
    console.log('  identity columns are blocked for non-admin roles and their other free text');
    console.log('  is stripped — so nothing new should appear here.');
    console.log('  Nothing was changed by running this.\n');
  } catch (err) {
    console.error('\naudit failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
