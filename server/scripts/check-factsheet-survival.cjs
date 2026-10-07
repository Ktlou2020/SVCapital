#!/usr/bin/env node
/* A factsheet is a published document and must outlive the pool it came in on.
 *
 * product_factsheets.pool_id was declared ON DELETE CASCADE, and a factsheet is
 * attached to a POOL rather than to a product. A new pool is created every
 * month, so one product's archive is scattered across dozens of pool rows —
 * and deleting ANY of them destroyed that month's document, permanently and
 * without a word.
 *
 * The pool merge made it worse. It moved the investments to the target pool and
 * then deleted the source, so tidying up a duplicate pool took the source's
 * factsheets with it. The investments were carefully carried across; the
 * documents were not, and nothing was audited, so there was nothing to work
 * back from.
 *
 * Four separate ways a sheet could vanish, all closed here:
 *   · the pool is deleted            → SET NULL, not CASCADE
 *   · the pool is merged away        → the merge carries the sheets
 *   · the pool is not loaded by the portal → the archive is fetched by PRODUCT
 *   · two months share a file + name → the de-dup key includes the period
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-factsheet-survival.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const FS     = read('server/routes/factsheets.js');
const FSC    = strip(FS);
const TABLES = strip(read('server/routes/tables.js'));
const SETUP  = read('server/db/setup.js');
const CORE   = read('js/portal-core.js');
const ADMIN  = read('admin/js/admin.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

console.log('\na document does not die with a pool row');
{
  ok('a fresh database declares the key SET NULL',
     /pool_id     TEXT REFERENCES investment_pools\(id\) ON DELETE SET NULL/.test(SETUP),
     'CASCADE means deleting a pool destroys the documents investors were shown');
  ok('and nothing still declares it CASCADE',
     !/REFERENCES investment_pools\(id\) ON DELETE CASCADE/.test(SETUP));
  ok('an existing database is migrated off CASCADE',
     /fk\.confdeltype === 'c'/.test(SETUP) && /ADD CONSTRAINT product_factsheets_pool_id_fkey/.test(SETUP),
     'the table already exists everywhere, so CREATE TABLE alone changes nothing');
  ok('the sheet carries its own product, so it is findable without the pool',
     /ADD COLUMN IF NOT EXISTS product_type TEXT/.test(SETUP)
     && /product_type TEXT,/.test(SETUP));
  ok('and the product is backfilled while the link still exists',
     /UPDATE product_factsheets f SET product_type = ip\.product_type/.test(SETUP));
}

console.log('\na merge carries the documents, like it carries the money');
{
  const merge = TABLES.slice(TABLES.indexOf("router.post('/investment_pools/:id/merge'"),
                             TABLES.indexOf("router.post('/investment_pools/:id/merge'") + 2600);
  ok('the factsheets move to the target before the source is deleted',
     /UPDATE product_factsheets[\s\S]{0,200}SET pool_id = \$1/.test(merge)
     && merge.indexOf('UPDATE product_factsheets') < merge.indexOf('DELETE FROM investment_pools'),
     'deleting first takes them with it, whatever the key says');
  ok('and the product is kept on them',
     /product_type = COALESCE\(product_type, \$3\)/.test(merge));
  ok('a target that does not exist is refused',
     /That target pool does not exist/.test(merge),
     'the investments move onto nothing and the source is deleted a line later');
  ok('and the merge is audited',
     /action:\s*'pool\.merge'/.test(merge),
     'a pool vanishing left nothing to work back from');
  ok('the audit says how many of each moved',
     /factsheet\(s\) moved, source pool deleted/.test(merge));
  ok('and the caller is told too', /factsheets_moved: sheets/.test(merge));
}

console.log('\nthe archive belongs to the product');
{
  ok('the list can be asked by product',
     /const \{ pool_id, product_type \} = req\.query/.test(FSC)
     && /COALESCE\(f\.product_type, ip\.product_type\) = \$1/.test(FSC),
     'a sheet whose pool was deleted has only its product left to find it by');
  ok('the upload records the product',
     /\(id,pool_id,product_type,pool_name/.test(FSC));
  ok('and every row comes back carrying one',
     /product_type: r\.product_type \|\| r\.pool_product_type \|\| null/.test(FSC));

  ok('the portal asks by product, not by the pools it happens to hold',
     /factsheets\?product_type=\$\{encodeURIComponent\(type\)\}/.test(CORE),
     'filtering on PORTAL.pools drops a sheet whose pool was merged or not loaded');
  ok('and no longer filters the result against its own pool list',
     !/sheets = \(res\.data \|\| \[\]\)\.filter\(s => poolIds\.has\(s\.pool_id\)\)/.test(CORE));
}

console.log('\ntwo months are two sheets');
{
  ok('the de-duplication key includes the period',
     /const when = s\.period_date \|\| s\.period_label \|\| `#\$\{s\.id\}`/.test(CORE)
     && /const key = `\$\{when\}\|\$\{s\.file_url/.test(CORE),
     'file+name alone collapses two different months that share a document');
  ok('and a sheet with no period keeps its own identity',
     /`#\$\{s\.id\}`/.test(CORE),
     'otherwise one undated sheet swallows every other undated one');
}

console.log('\nwhat was already lost is at least nameable');
{
  ok('there is a coverage report',
     /router\.get\('\/coverage', requireAuth, requireRole\('admin', 'director'\)/.test(FSC));
  ok('it names the months, not just a count',
     /missing, missingCount: missing\.length/.test(FSC));
  ok('a month that has not happened is not "missing"',
     /m <= now/.test(FSC));
  ok('a product with gaps AND sheets sorts above one that never had any',
     /const aLost = a\.total > 0 && a\.missingCount > 0/.test(FSC),
     'a backlog is not a loss, and the report is for finding losses');
  ok('orphans are counted and named',
     /COUNT\(\*\) FILTER \(WHERE f\.pool_id IS NULL\)::int AS orphaned/.test(FSC));
  ok('and the console can open it',
     /function openFactsheetCoverage\(\)/.test(ADMIN) && /openFactsheetCoverage\(\)"/.test(ADMIN));
}

/* ── Against a database ────────────────────────────────────────────── */
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\n  (skipping the database half — DATABASE_URL not set)');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  const { Pool } = require('pg');
  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

    console.log('\nand it survives, against a real database');
    const { rows: [fk] } = await db.query(
      `SELECT confdeltype FROM pg_constraint
        WHERE conrelid = 'product_factsheets'::regclass AND contype = 'f' LIMIT 1`);
    ok('the live key is SET NULL, not CASCADE', fk && fk.confdeltype === 'n',
       `confdeltype is ${fk ? fk.confdeltype : 'missing'}`);

    await db.query(`DELETE FROM product_factsheets WHERE id LIKE 'CHKFS-%'`);
    await db.query(`DELETE FROM investment_pools  WHERE id LIKE 'CHKP-%'`);
    await db.query(`INSERT INTO investment_pools (id,name,product_type,status,term_months,start_date,end_date)
                    VALUES ('CHKP-A','Check Pool A','short_term','closed',5,'2026-01-01','2026-01-31'),
                           ('CHKP-B','Check Pool B','short_term','open',5,'2026-02-01','2026-02-28')`);
    await db.query(`INSERT INTO product_factsheets (id,pool_id,product_type,file_name,file_url,period_date)
                    VALUES ('CHKFS-1','CHKP-A','short_term','Jan - Factsheet','data:application/pdf;base64,JVBERi0=','2026-01-01')`);

    await db.query(`DELETE FROM investment_pools WHERE id = 'CHKP-A'`);
    const { rows: [after] } = await db.query(
      `SELECT pool_id, product_type FROM product_factsheets WHERE id = 'CHKFS-1'`);
    ok('deleting the pool does NOT delete the factsheet', !!after,
       'this is the bug: the document went with the pool row');
    ok('it is orphaned rather than destroyed', after && after.pool_id === null);
    ok('and it still knows its product, so it still appears',
       after && after.product_type === 'short_term');

    const { rows: byProduct } = await db.query(
      `SELECT f.id FROM product_factsheets f
        LEFT JOIN investment_pools ip ON ip.id = f.pool_id
       WHERE COALESCE(f.product_type, ip.product_type) = 'short_term' AND f.id = 'CHKFS-1'`);
    ok('the product query finds it with no pool at all', byProduct.length === 1);

    await db.query(`DELETE FROM product_factsheets WHERE id LIKE 'CHKFS-%'`);
    await db.query(`DELETE FROM investment_pools  WHERE id LIKE 'CHKP-%'`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
