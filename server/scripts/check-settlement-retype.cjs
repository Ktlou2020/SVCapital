#!/usr/bin/env node
/* Correcting an income-typed maturity settlement, without moving money nobody
 * decided to move.
 *
 * services/incomeReference.js keeps such a row out of the income total and
 * names it, so the DOCUMENT is honest. fix-income-typed-settlements.cjs is the
 * other half — making the LEDGER right so the row stops needing explaining.
 *
 * The reason it is a script with flags rather than a migration is cashMovement,
 * whose lists are not symmetrical:
 *
 *     interest → a cash CREDIT        payout → a cash CREDIT
 *     return   → NO cash effect at all
 *
 * So `interest` → `payout` moves nothing, and `return` → `payout` moves the
 * investor's derived balance by the amount. On an account already disputing an
 * opening balance, that is a decision, not a side effect.
 *
 * What this holds:
 *
 *   previews        nothing is written without --apply
 *   sorts           cash-neutral and balance-shifting rows are told apart, and
 *                   the shifting ones need a flag of their own
 *   refuses         a settlement whose money is already credited elsewhere is
 *                   never written, under any flags — retyping it would count
 *                   the same money twice
 *   leaves alone    genuine income, and a settlement of an investment whose
 *                   return has not been posted
 *   closes the loop the corrected row drops out of the income reference
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-settlement-retype.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_retype_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
const SCRIPT  = path.join(ROOT, 'server', 'scripts', 'fix-income-typed-settlements.cjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

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

const typeOf = async id => (await pool.query(
  'SELECT type, investment_id, pool_id, notes FROM transactions WHERE id = $1', [id])).rows[0];

/* Four investors, one situation each.

   RT-A  the client's own case: a `return` row of capital + return. Shifts.
   RT-B  the same settlement typed `interest`. Cash-neutral.
   RT-C  a settlement whose money a `payout` row ALREADY credits. Must skip.
   RT-D  genuine interest, a fraction of the capital. Must be left alone.
   RT-E  an investment whose return is NOT posted, and an income row equal to
         its capital. Reading the unposted return as zero would make capital
         alone look like a settlement and would retype real income.
   RT-F  an income row NEAR the settlement amount but not equal to it. Only an
         exact match may be retyped; a loose tolerance retypes income. */
async function seed() {
  await pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status) VALUES
      ('RT-A','Bongani','Sibanda','a@example.test','active'),
      ('RT-B','Thandi','Nkosi','b@example.test','active'),
      ('RT-C','Sipho','Dlamini','c@example.test','active'),
      ('RT-D','Lerato','Mokoena','d@example.test','active'),
      ('RT-E','Naledi','Khumalo','e@example.test','active'),
      ('RT-F','Kagiso','Molefe','f@example.test','active')`);
  await pool.query(`
    INSERT INTO investment_pools (id, name, product_type, status, annual_rate, actual_rate, term_months, end_date)
    VALUES ('RTP','Cattle Investment-April 2024','cattle','matured',0.13,0.13,12,'2025-04-29')`);
  /* R600 capital, R78 posted — the client's figures. */
  const inv = (id, who) => pool.query(`
    INSERT INTO investments (id, investor_id, pool_id, pool_name, amount, status,
        start_date, end_date, annual_rate, term_months, expected_return, actual_return, product_type)
    VALUES ($1,$2,'RTP','Cattle Investment-April 2024', 600,'matured',
            '2024-05-03','2025-04-29', 0.13, 12, 78, 78, 'cattle')`, [id, who]);
  await inv('RT-IA', 'RT-A'); await inv('RT-IB', 'RT-B');
  await inv('RT-IC', 'RT-C'); await inv('RT-ID', 'RT-D'); await inv('RT-IF', 'RT-F');

  /* A pool that has NOT been closed out: no achieved rate, and the
     investment carries no posted return either. There is no figure to
     compare, so nothing of this investor's may be retyped. */
  await pool.query(`
    INSERT INTO investment_pools (id, name, product_type, status, annual_rate, term_months, end_date)
    VALUES ('RTP-OPEN','Cattle Investment-May 2024','cattle','matured',0.13,12,'2025-05-29')`);
  await pool.query(`
    INSERT INTO investments (id, investor_id, pool_id, pool_name, amount, status,
        start_date, end_date, annual_rate, term_months, expected_return, actual_return, product_type)
    VALUES ('RT-IE','RT-E','RTP-OPEN','Cattle Investment-May 2024', 600,'matured',
            '2024-06-03','2025-05-29', 0.13, 12, 78, 0, 'cattle')`);

  await pool.query(`
    INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, transaction_date)
    VALUES
      ('RT-T-A','RT-A','return',   678,'completed','MAT-RT-IA','PAYOUT','2025-04-30'),
      ('RT-T-B','RT-B','interest', 678,'completed','MAT-RT-IB','PAYOUT','2025-04-30'),
      ('RT-T-C','RT-C','return',   678,'completed','MAT-RT-IC','PAYOUT','2025-04-30'),
      ('RT-T-C2','RT-C','payout',  678,'completed','MAT-RT-IC-2','Maturity payout','2025-04-30'),
      ('RT-T-D','RT-D','interest',  78,'completed','INT-RT-ID','Interest credited','2025-09-30'),
      ('RT-T-E','RT-E','interest', 600,'completed','INT-RT-IE','Interest credited','2025-05-30'),
      ('RT-T-F','RT-F','interest', 700,'completed','INT-RT-IF','Interest credited','2025-04-30')`);
}

(async () => {
  try {
    await makeDatabase();
    await seed();

    console.log('\nit previews, and writes nothing');
    {
      const out = run();
      ok('the preview names the client’s own row',
         /RT-T-A/.test(out) && /return → payout/.test(out), out.slice(0, 400));
      ok('and says plainly that nothing was written',
         /nothing will be written/i.test(out), out.slice(0, 300));
      const a = await typeOf('RT-T-A');
      ok('the row is untouched', a.type === 'return', JSON.stringify(a));
    }

    console.log('\nand it tells a cash-neutral correction from one that moves a balance');
    {
      const out = run();
      ok('the interest row is listed as cash-neutral',
         /CASH-NEUTRAL[\s\S]*RT-T-B/.test(out), out.slice(0, 1200));
      ok('the return row is listed as balance-shifting',
         /BALANCE-SHIFTING[\s\S]*RT-T-A/.test(out), out.slice(0, 2000));
      ok('and the balance change is stated per investor',
         /RT-A\s+\+R\s?678,00/.test(out.replace(/ /g, ' ')), out.slice(-900));
    }

    console.log('\nand it refuses the one whose money is already credited');
    {
      const out = run();
      ok('RT-C is skipped, not written',
         /SKIPPED[\s\S]*RT-T-C\b/.test(out), out.slice(0, 2500));
      ok('and the row that already credits it is named',
         /RT-T-C2/.test(out), 'an operator cannot judge it without seeing the clash');
    }

    console.log('\n--apply writes the cash-neutral one and holds the rest back');
    {
      const out = run('--apply');
      ok('it reports one row corrected', /1 row\(s\) corrected/.test(out), out.slice(-500));
      ok('the interest settlement is now a payout',
         (await typeOf('RT-T-B')).type === 'payout');
      ok('the balance-shifting one is NOT touched without its flag',
         (await typeOf('RT-T-A')).type === 'return',
         'moving a client’s balance must be a decision, not a side effect');
      ok('and the already-credited one is NOT touched',
         (await typeOf('RT-T-C')).type === 'return');
      ok('genuine interest is left exactly as it was',
         (await typeOf('RT-T-D')).type === 'interest');
      /* The two that separate a careful rule from a careless one. Both are
         R600-ish income rows sitting at a maturity; retyping either would
         take real earnings out of a client's income and understate what
         they must declare. */
      ok('income against an investment with NO posted return is left alone',
         (await typeOf('RT-T-E')).type === 'interest',
         'with no figure posted there is nothing to compare, and treating the ' +
         'return as zero makes the capital alone look like a settlement');
      ok('and an amount NEAR the settlement but not equal to it is left alone',
         (await typeOf('RT-T-F')).type === 'interest',
         'R700 is not R678 — only an exact match is a settlement');

      const b = await typeOf('RT-T-B');
      ok('the corrected row now names its investment and pool',
         b.investment_id === 'RT-IB' && b.pool_id === 'RTP', JSON.stringify(b));
      ok('and carries a note saying what was changed and why',
         /Type corrected interest → payout/.test(b.notes || '')
         && /not investment income/.test(b.notes || ''),
         JSON.stringify(b.notes));
    }

    console.log('\nand it is idempotent — a second run finds nothing left to do');
    {
      const out = run('--apply');
      ok('nothing further is written', /Nothing to write|0 row\(s\) corrected/.test(out),
         out.slice(-400));
      ok('the corrected row stays corrected', (await typeOf('RT-T-B')).type === 'payout');
    }

    console.log('\nthe balance-shifting one needs its own flag, and then goes through');
    {
      const out = run('--apply', '--allow-balance-shift');
      ok('it is applied now', /1 row\(s\) corrected/.test(out), out.slice(-400));
      ok('the client’s row is a payout', (await typeOf('RT-T-A')).type === 'payout');
      ok('and the already-credited one is STILL refused',
         (await typeOf('RT-T-C')).type === 'return',
         'no flag may let the same money be counted twice');
    }

    console.log('\nand --investor confines it to one account');
    {
      await pool.query(`UPDATE transactions SET type = 'interest' WHERE id = 'RT-T-B'`);
      await pool.query(`UPDATE transactions SET type = 'interest' WHERE id = 'RT-T-A'`);
      const out = run('--investor=RT-A', '--apply');
      ok('only the named investor is written', /1 row\(s\) corrected/.test(out), out.slice(-400));
      ok('their row is corrected', (await typeOf('RT-T-A')).type === 'payout');
      ok('and the other account is untouched', (await typeOf('RT-T-B')).type === 'interest',
         'a scoped run must not reach past the account it names');
    }

    console.log('\nand once corrected, the income reference stops counting it');
    {
      await pool.query(`UPDATE transactions SET type = 'interest' WHERE id = 'RT-T-B'`);
      delete require.cache[require.resolve(path.join(ROOT, 'server', 'services', 'incomeReference.js'))];
      const IR = require(path.join(ROOT, 'server', 'services', 'incomeReference.js'));

      const before = await IR.buildIncomeReference(pool, { investorId: 'RT-B', year: 2026 });
      ok('before: the guard catches it and keeps it out of the total',
         before.settlements.length === 1 && Math.abs(before.totalReturns) < 0.005,
         JSON.stringify({ t: before.totalReturns, s: before.settlements.length }));

      run('--investor=RT-B', '--apply');
      const after = await IR.buildIncomeReference(pool, { investorId: 'RT-B', year: 2026 });
      ok('after: there is nothing left for the guard to catch',
         after.settlements.length === 0 && Math.abs(after.totalReturns) < 0.005,
         'the document no longer has to explain the row — ' + JSON.stringify(after.settlements));
      ok('and the realised return is untouched at R78',
         Math.abs(after.maturedReturns - 78) < 0.005, String(after.maturedReturns));
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
