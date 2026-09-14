#!/usr/bin/env node
/* Every analytics endpoint's SQL runs against the real schema.
 *
 * Three of these have shipped naming a column that does not exist, and each
 * failed the same way: silently, from the operator's side, for as long as it
 * took somebody to read a log.
 *
 *     [personas] error: column i.name does not exist
 *     [FICA Cron] Fatal sweep error: column "nationality" does not exist
 *
 * investors has first_name and last_name and never had a column called name.
 * fica_last_checked_at was never created either — the timestamp everything else
 * uses is last_auto_fica_check.
 *
 * A route that selects a column that is not there throws on its first
 * statement, so the whole endpoint returns nothing and the panel behind it
 * shows an error or an empty state. Reading the SQL cannot catch this; only
 * executing it against the schema can. So every statement in these routes is
 * LIFTED and RUN, and the columns it comes back with are compared against what
 * the handler then reads off each row.
 *
 * Needs a database. Read-only: every statement here is a SELECT and nothing is
 * written.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-analytics-queries.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const db   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const SRC = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'friction.js'), 'utf8');

/* Bounded to one handler each. An earlier version sliced to the end of the
   file and its regex ran past the handler into the next route's statements,
   reporting a syntax error in SQL that was never one statement to begin with. */
function handler(marker) {
  const start = SRC.indexOf(marker);
  if (start < 0) return null;
  const end = SRC.indexOf('router.', start + 10);
  return SRC.slice(start, end > 0 ? end : undefined);
}
/* One lifter, closing on the backtick and whatever follows it — a comma when
   the statement takes parameters, a paren when it does not. Two separate
   regexes got this wrong: the no-parameter one matched up to the first `)
   sequence, which a `, [days]) statement does not have, so it ran on into the
   NEXT statement and reported a syntax error in SQL that was never one
   statement to begin with. */
const statements = src => [...src.matchAll(/query\(`([\s\S]*?)`\s*(?:,|\))/g)].map(m => m[1]);

const ROUTES = [
  ["router.get('/personas'",                      '/api/analytics/personas'],
  ["router.get('/signup-friction/summary'",       '/api/analytics/signup-friction/summary'],
  ["router.get('/invest-funnel/summary'",         '/api/analytics/invest-funnel/summary'],
];

(async () => {
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

    for (const [marker, label] of ROUTES) {
      const src = handler(marker);
      console.log(`\n${label}`);
      ok('the handler is still findable', !!src,
         'if this fails the check proves nothing about the real endpoint');
      if (!src) continue;

      const qs = statements(src);
      ok('it has statements to run', qs.length > 0, `${qs.length} found`);

      let broken = 0;
      for (const q of qs) {
        try { await db.query(q, /\$1/.test(q) ? [30] : []); }
        catch (e) { broken++; console.log(`      ${e.message}`); }
      }
      ok(`all ${qs.length} statement(s) execute against the real schema`, broken === 0,
         `${broken} threw — the endpoint returns nothing and the panel shows an error`);
    }

    console.log('\npersonas returns the columns its handler reads');
    {
      const src = handler("router.get('/personas'");
      const [q] = statements(src);
      const cols = (await db.query(q)).fields.map(f => f.name);
      /* Straight from the row mapper below the query. */
      for (const c of ['id', 'name', 'email', 'xp_points', 'xp_level', 'date_joined', 'investor_profile'])
        ok(`  ${c}`, cols.includes(c), `got: ${cols.join(', ')}`);
    }

    console.log('\nand builds the name from the columns that exist');
    {
      const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ');
      ok('no bare i.name remains', !/\bi\.name\b/.test(code),
         'investors has first_name and last_name; there is no name column');
      ok('a missing surname does not fall through to the email address',
         /NULLIF\(BTRIM\(COALESCE\(i\.first_name, ''\) \|\| ' ' \|\| COALESCE\(i\.last_name, ''\)\), ''\)/.test(code),
         "|| with a NULL operand yields NULL, so first_name || ' ' || last_name is NULL for anyone with one name");

      const { rows } = await db.query(`
        SELECT COALESCE(
                 NULLIF(BTRIM(COALESCE(f, '') || ' ' || COALESCE(l, '')), ''),
                 e
               ) AS name
          FROM (VALUES ('Thandi','Mokoena','t@x.co'),
                       ('Thandi', NULL,     't@x.co'),
                       (NULL,     NULL,     't@x.co')) AS v(f, l, e)`);
      ok('a full name is used',        rows[0].name === 'Thandi Mokoena', rows[0].name);
      ok('a first name alone is used', rows[1].name === 'Thandi', rows[1].name);
      ok('and the email is the last resort', rows[2].name === 't@x.co', rows[2].name);
    }

  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
