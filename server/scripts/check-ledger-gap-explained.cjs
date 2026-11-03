#!/usr/bin/env node
/* Explaining the gap a statement reports, instead of only measuring it.
 *
 * A client asked: "There's a R33 237,71 opening balance discrepancy flagged on
 * the statement. Can you please explain or correct this?" Nobody could — the
 * statement states the size and not the cause.
 *
 * What this holds:
 *
 *   the number    explain-ledger-gap's gap is accountStatement's ledger_gap,
 *                 asserted against the real service rather than re-derived —
 *                 a diagnostic that explains a different number than the
 *                 document is worse than none
 *   period-free   the same gap comes back whatever dates the statement covers,
 *                 because the period cancels out of the algebra
 *   attribution   a reinvestment with no matured_funds credit is counted
 *                 exactly, and the figure quoted is what the existing repair
 *                 would actually write
 *   restraint     a `return` accrual is REPORTED, never counted — calling one
 *                 cash would invent money; and whatever is left is called
 *                 UNEXPLAINED rather than folded into a cause
 *   read-only     it writes nothing
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-ledger-gap-explained.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');
const { nbsp } = require('../../scripts/lib/rendered.cjs');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_gap_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
const SCRIPT  = path.join(ROOT, 'server', 'scripts', 'explain-ledger-gap.cjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
/* The server's formatter is 'R' + toLocaleString — no space after the R,
   unlike the portal's Utils.rand which writes "R 700,00". Both appear in
   this repo's output, so each pattern below is written against the one that
   produced the string. nbsp() only normalises the group separator. */
const N = v => nbsp(v == null ? '' : v);

function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool, dbUrl;

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  dbUrl = withDatabase(process.env.DATABASE_URL, DB_NAME);
  process.env.DATABASE_URL = dbUrl;
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  pool = new Pool({ connectionString: dbUrl, ssl: SSL, max: 2 });
  pool.on('error', () => {});
}

const run = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], {
  encoding: 'utf8',
  env: Object.assign({}, process.env, { DATABASE_URL: dbUrl, DATABASE_SSL: 'false' }),
});

/* An account built so the arithmetic is known in advance.
 *
 *   deposit            +2 000   counted
 *   reinvestment A       −700   counted, and its MATF credit is MISSING
 *   reinvestment B       −300   counted, and its MATF credit EXISTS (+300)
 *   return                 50   carries no cash effect
 *
 *   ledger  = 2000 − 700 − 300 + 300 = 1300
 *   wallet  = 2000                       (what the account really holds)
 *   gap     = 700, which is exactly reinvestment A
 *
 * GAP-B ties exactly, and is here so "every account ties" can be distinguished
 * from "this tool finds nothing". */
async function seed() {
  await pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance) VALUES
      ('GAP-A','Bongani','Sibanda','a@example.test','active', 2000),
      ('GAP-B','Thandi','Nkosi','b@example.test','active', 500)`);
  await pool.query(`
    INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, transaction_date)
    VALUES
      ('G-DEP', 'GAP-A','deposit',      2000,'completed','DEP-1','Deposit','2025-03-10'),
      ('G-RI-A','GAP-A','reinvestment',  700,'completed','REINV-INV-A','Reinvested','2025-06-10'),
      ('G-RI-B','GAP-A','reinvestment',  300,'completed','REINV-INV-B','Reinvested','2025-07-10'),
      ('G-MF-B','GAP-A','matured_funds', 300,'completed','MATF-INV-B','Matured Funds','2025-07-10'),
      ('G-RET', 'GAP-A','return',         50,'completed','RET-1','Return accrued','2025-08-10'),
      ('G-DEP-B','GAP-B','deposit',      500,'completed','DEP-B','Deposit','2025-03-10')`);
}

(async () => {
  try {
    await makeDatabase();
    await seed();

    /* ── The number is the document's number ───────────────────────── */
    console.log('\nthe gap it explains is the one the statement reports');
    {
      const { buildAccountStatement } = require(path.join(ROOT, 'server', 'services', 'accountStatement.js'));
      const stmt = await buildAccountStatement(pool, {
        investorId: 'GAP-A', from: '2025-01-01', to: '2025-12-31' });
      ok('the statement does not reconcile', stmt.reconciles === false,
         JSON.stringify({ r: stmt.reconciles, gap: stmt.ledger_gap }));
      ok('and reports a gap of R700', Math.abs(stmt.ledger_gap - 700) < 0.005,
         String(stmt.ledger_gap));

      const out = N(run('--investor=GAP-A'));
      ok('the tool reports the same R700',
         /GAP \+?R700,00/.test(out), out.slice(0, 700));
      ok('and shows the wallet and the ledger it came from',
         /wallet R2 000,00/.test(out) && /ledger R1 300,00/.test(out), out.slice(0, 700));
      ok('and says which way round it is',
         /ledger UNDER-accounts/.test(out), out.slice(0, 800));

      /* The algebra says the period cancels. If it did not, a diagnostic run
         on one date range would contradict a statement run on another. */
      const narrow = await buildAccountStatement(pool, {
        investorId: 'GAP-A', from: '2025-07-01', to: '2025-07-31' });
      ok('the statement’s gap is the same over a different period',
         Math.abs(narrow.ledger_gap - stmt.ledger_gap) < 0.005,
         `${narrow.ledger_gap} vs ${stmt.ledger_gap} — the period must cancel`);
    }

    /* ── Attribution ───────────────────────────────────────────────── */
    console.log('\nand it names the cause rather than restating the size');
    {
      const out = N(run('--investor=GAP-A'));
      ok('the unpaired reinvestment is identified',
         /REINVESTMENTS WITH NO MATURED-FUNDS CREDIT — 1, R700,00/.test(out), out);
      ok('by its own reference, so it can be looked up',
         /REINV-INV-A/.test(out));
      ok('and the PAIRED one is not blamed',
         !/REINV-INV-B/.test(out),
         'it has its matured_funds credit and is not part of the gap');
      ok('the existing repair is named',
         /backfill-matured-funds/.test(out), 'a cause with no remedy is half an answer');
      ok('with what it would close',
         /would close R700,00 of the gap/.test(out), out.slice(-900));
      ok('and the remainder is nothing',
         /UNEXPLAINED: nothing/.test(out), out.slice(-600));
    }

    console.log('\nand it reports an accrual without counting it');
    {
      const out = N(run('--investor=GAP-A'));
      ok('the return row is reported', /ROWS CARRYING NO CASH EFFECT/.test(out) && /return/.test(out),
         out);
      ok('with its amount', /R50,00/.test(out));
      ok('but it is NOT added to what is accounted for',
         /ACCOUNTED FOR: R700,00/.test(out),
         'an accrual counted as cash invents money — the R50 must not be in the R700');
      ok('and the tool says so in as many words',
         /NOT automatically part of the gap/.test(out));
    }

    /* ── Restraint where it cannot know ────────────────────────────── */
    console.log('\nand what it cannot explain, it calls unexplained');
    {
      /* The wallet moves with no row written — the third cause, which no
         ledger can name. */
      await pool.query(`UPDATE investors SET wallet_balance = 2500 WHERE id = 'GAP-A'`);
      const out = N(run('--investor=GAP-A'));
      ok('the gap grows to R1 200', /GAP \+?R1 200,00/.test(out), out.slice(0, 700));
      ok('still only R700 is accounted for', /ACCOUNTED FOR: R700,00/.test(out), out.slice(-800));
      ok('and R500 is named as unexplained', /UNEXPLAINED: R500,00/.test(out), out.slice(-800));
      ok('with the one cause it cannot see from the ledger spelled out',
         /wallet that moved with\s*\n?\s*no row written/.test(out), out.slice(-600));
      await pool.query(`UPDATE investors SET wallet_balance = 2000 WHERE id = 'GAP-A'`);
    }

    console.log('\nand an account that ties is left out of the report');
    {
      const out = N(run());
      ok('the broken account is listed', /GAP-A/.test(out));
      ok('and the sound one is not', !/GAP-B/.test(out),
         'a reconciliation report listing accounts that reconcile is noise');
      const only = N(run('--investor=GAP-B'));
      ok('asking about it directly says it ties',
         /Every account ties/.test(only), only);
    }

    console.log('\nand it never writes');
    {
      const before = (await pool.query(
        `SELECT count(*) AS n, COALESCE(SUM(amount),0) AS total FROM transactions`)).rows[0];
      run(); run('--investor=GAP-A');
      const after = (await pool.query(
        `SELECT count(*) AS n, COALESCE(SUM(amount),0) AS total FROM transactions`)).rows[0];
      ok('the ledger is byte-for-byte unchanged',
         before.n === after.n && String(before.total) === String(after.total),
         JSON.stringify({ before, after }));
      ok('and the source contains no write at all',
         !/\b(INSERT|UPDATE|DELETE)\b/i.test(
           require('fs').readFileSync(SCRIPT, 'utf8')
             .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
         'a diagnostic that can write is not a diagnostic');
    }
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (pool) await pool.end().catch(() => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
