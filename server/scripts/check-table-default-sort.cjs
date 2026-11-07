#!/usr/bin/env node
/* Every table the console can list sorts on a column it actually has.
 *
 * The generic reader orders an unsorted list by created_at unless the table
 * names its own column. platform_settings and quest_completions have no
 * created_at, so every unsorted read of them failed with a 500 — the
 * console's Platform Settings panel showed "Loading..." and nothing else,
 * on production, for months. This builds the real schema and, for every
 * table in ALLOWED_TABLES, checks that the column its default ORDER BY
 * names exists. A new table added without one fails here, not in front of
 * the person trying to change a setting.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-table-default-sort.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const SRC = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'tables.js'), 'utf8');

const allowedBlock = SRC.match(/const ALLOWED_TABLES = \{([\s\S]*?)\n\};/);
const sortBlock = SRC.match(/const defaultSort = \{([\s\S]*?)\n\s*\};/);
ok('the table list and the sort map can both be read', !!allowedBlock && !!sortBlock);
const tables = [...(allowedBlock ? allowedBlock[1] : '').matchAll(/^\s*([a-z_]+):/gm)].map(m => m[1]);
const sorts = Object.fromEntries([...(sortBlock ? sortBlock[1] : '').matchAll(/^\s*([a-z_]+):\s*'([^']+)'/gm)]
  .map(m => [m[1], m[2]]));
ok(`${tables.length} tables are listed`, tables.length > 30);
ok('settings sort by key, A to Z',
   sorts.platform_settings === 'key' && /ASC_BY_DEFAULT = \[[^\]]*'platform_settings'/.test(SRC));

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

(async () => {
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  try {
    const broken = [];
    for (const t of tables) {
      const { rows: [exists] } = await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, ['public.' + t]);
      if (!exists.ok) continue;            // a table this schema does not build is not listed
      /* The columns the default ORDER BY expression names (COALESCE(a, b)
         names two). */
      const expr = sorts[t] || 'created_at';
      const cols = expr.replace(/COALESCE|\(|\)/g, ' ').split(/[\s,]+/).filter(Boolean);
      for (const c of cols) {
        const { rows } = await db.query(
          `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [t, c]);
        if (!rows.length) broken.push(`${t}.${c}`);
      }
    }
    ok('every listed table sorts on a column it has', !broken.length,
       `missing: ${broken.join(', ')} — add the table to defaultSort in server/routes/tables.js`);
    const { rows } = await db.query(`SELECT key FROM platform_settings ORDER BY key ASC NULLS LAST LIMIT 100 OFFSET 0`);
    ok('and the settings read the console makes returns the settings', rows.length > 0, String(rows.length));
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
