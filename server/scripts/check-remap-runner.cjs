#!/usr/bin/env node
/* The remap runner must not write unless it is told to, twice.
 *
 * It changes the column the maturity engine routes on, for every investment in
 * a pool, days before a run that moves millions. The things worth proving are
 * that the survey and the dry run write nothing, that a suggestion derived
 * from the pool NAME is never acted on by itself, and that when it does write,
 * pool and investments move together or not at all.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-remap-runner.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const ROOT   = path.join(__dirname, '..', '..');
const RUNNER = path.join(__dirname, 'remap-pool-product-type.cjs');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function isScratchDatabase(url) {
  const n = (String(url).split('?')[0].split('/').pop() || '').toLowerCase();
  return /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(n) || /^svctest/.test(n);
}
async function ensureSchema() {
  const { rows } = await pool.query(
    `SELECT bool_and(to_regclass('public.' || t) IS NOT NULL) AS ready FROM unnest($1::text[]) AS t`,
    [['investors', 'investments', 'investment_pools']]);
  if (rows[0].ready) return true;
  if (!isScratchDatabase(process.env.DATABASE_URL) && process.env.CHECK_ALLOW_RESET !== '1') {
    console.log('  SKIP  incomplete schema and this is not a scratch database.');
    return false;
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  return true;
}

const wipe = async () => {
  await pool.query(`DELETE FROM investments      WHERE investor_id LIKE 'RM-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'RMP-%'`);
  await pool.query(`DELETE FROM investors        WHERE id LIKE 'RM-%'`);
};

/* A migrated pool: named for cattle, carrying 'other', with an open cattle
   pool beside it that its rollovers cannot reach. */
async function seed() {
  await wipe();
  await pool.query(`INSERT INTO investors (id, first_name, last_name, email, status)
                    VALUES ('RM-A','Thabo','Nkosi','thabo@example.test','active')`);
  await pool.query(`
    INSERT INTO investment_pools (id, name, product_type, status, end_date, annual_rate, term_months, current_invested, max_investment)
    VALUES ('RMP-NEW','Cattle Investment - August 2026','cattle','open', CURRENT_DATE + 30, 0.16, 12, 0, NULL),
           ('RMP-OLD','Cattle Investment - August 2025','other','active', CURRENT_DATE + 3, 0.16, 12, 0, NULL)`);
  await pool.query(`
    INSERT INTO investments (id, investor_id, pool_id, pool_name, amount, status, start_date, end_date,
        annual_rate, term_months, expected_return, actual_return, product_type)
    VALUES ('RM-IV1','RM-A','RMP-OLD','Cattle Investment - August 2025', 100000,'active',
            CURRENT_DATE-360, CURRENT_DATE+3, 0.16, 12, 0, 0, 'other'),
           ('RM-IV2','RM-A','RMP-OLD','Cattle Investment - August 2025',  50000,'active',
            CURRENT_DATE-360, CURRENT_DATE+3, 0.16, 12, 0, 0, 'other')`);
}

const run = args => {
  try {
    return execFileSync('node', [RUNNER, ...args], { env: { ...process.env }, encoding: 'utf8' });
  } catch (err) { return (err.stdout || '') + (err.stderr || ''); }
};

const typesOf = async () => (await pool.query(
  `SELECT (SELECT product_type FROM investment_pools WHERE id='RMP-OLD') AS pool_type,
          (SELECT COUNT(*)::int FROM investments WHERE pool_id='RMP-OLD' AND product_type='other') AS still_other,
          (SELECT COUNT(*)::int FROM investments WHERE pool_id='RMP-OLD' AND product_type='cattle') AS now_cattle`
)).rows[0];

(async () => {
  try {
    if (!await ensureSchema()) { await pool.end(); process.exit(0); }

    console.log('\nthe survey finds stranded money and writes nothing');
    await seed();
    {
      const out = run([]);
      ok('the stranded pool is named', /RMP-OLD/.test(out), out.slice(0, 600));
      ok('with the capital at stake', /R150,000\.00/.test(out), out.slice(0, 800));
      ok('and it says the rollovers find no open pool',
         /find no open pool/i.test(out), out.slice(0, 300));

      const st = await typesOf();
      ok('nothing was written', st.pool_type === 'other' && st.still_other === 2, JSON.stringify(st));
    }

    console.log('\nthe suggestion comes from the name, and is only a suggestion');
    {
      const out = run([]);
      ok('it proposes the mapping to type back',
         /--map RMP-OLD=cattle/.test(out), out.slice(0, 900));
      ok('and says plainly that names are what the engine cannot see',
         /cannot see names/.test(out));
      const st = await typesOf();
      ok('the suggestion alone changes nothing', st.pool_type === 'other', JSON.stringify(st));
    }

    console.log('\n--map without --apply is a dry run');
    {
      const out = run(['--map', 'RMP-OLD=cattle']);
      ok('it reports what would change', /2 of 2 would change/.test(out), out.slice(0, 900));
      ok('naming the pool rollovers would reach after',
         /rollovers after.*Cattle Investment - August 2026/s.test(out), out.slice(0, 1200));
      ok('and states that nothing was written', /Nothing was written/.test(out));

      const st = await typesOf();
      ok('nothing was written', st.pool_type === 'other' && st.still_other === 2, JSON.stringify(st));
    }

    console.log('\n--apply writes the pool and its investments together');
    {
      const out = run(['--map', 'RMP-OLD=cattle', '--apply']);
      ok('it reports applying', /applied — 1 pool, 2 investment\(s\)/.test(out), out.slice(-900));

      const st = await typesOf();
      ok('the pool moved', st.pool_type === 'cattle', JSON.stringify(st));
      ok('and every investment with it', st.now_cattle === 2 && st.still_other === 0,
         'correcting the pool alone reroutes nothing — the engine reads the investment');
    }

    console.log('\nafterwards there is nothing left stranded');
    {
      const out = run([]);
      ok('the survey comes back clean', /Nothing to remap/.test(out), out.slice(0, 400));
    }

    console.log('\nit refuses what it cannot safely do');
    await seed();
    {
      const typo = run(['--map', 'RMP-OLD=catle']);
      ok('a product type no pool uses is rejected',
         /No other pool uses product_type "catle"/.test(typo), typo.slice(0, 500));
      ok('and the existing types are listed to choose from',
         /Existing types: /.test(typo), typo.slice(0, 500));
      ok('nothing was written', (await typesOf()).pool_type === 'other');

      const bad = run(['--map', 'RMP-OLD=Cattle']);
      ok('an upper-case type is rejected before it reaches the database',
         /lower-case letters/.test(bad), bad.slice(0, 300));

      const malformed = run(['--map', 'RMP-OLD=cattle,justrubbish']);
      ok('a malformed entry stops the whole run',
         /not of the form POOL_ID=product_type/.test(malformed), malformed.slice(0, 300));
      ok('rather than silently applying the valid half',
         (await typesOf()).pool_type === 'other',
         'applying a subset while the operator believes all of it ran is the worst outcome here');

      const missing = run(['--map', 'RMP-NOPE=cattle']);
      ok('an unknown pool is reported, not created', /not found/.test(missing), missing.slice(0, 300));

      const noMap = run(['--apply']);
      ok('--apply without --map refuses', /--apply needs --map/.test(noMap), noMap.slice(0, 300));
      ok('and still nothing was written', (await typesOf()).pool_type === 'other');
    }

    console.log('\nit warns when the remap would not actually fix the routing');
    await seed();
    await pool.query(`UPDATE investment_pools SET status = 'closed' WHERE id = 'RMP-NEW'`);
    {
      const out = run(['--map', 'RMP-OLD=cattle']);
      ok('it says the target has no open pool either',
         /STILL no open pool/.test(out), out.slice(0, 1200));
      ok('and flags that the remap would not fix the routing',
         /would not fix the routing/.test(out), out.slice(0, 1200));
    }

    console.log('\nthe writes are the same ones the admin endpoint makes');
    {
      const cli   = fs.readFileSync(RUNNER, 'utf8');
      const route = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'manualCredit.js'), 'utf8');
      for (const sql of [
        `UPDATE investment_pools SET product_type = $2, updated_at = NOW() WHERE id = $1`,
        `UPDATE investments SET product_type = $2, updated_at = NOW()`,
      ]) {
        ok(`both issue: ${sql.slice(0, 46)}…`, cli.includes(sql) && route.includes(sql));
      }
      ok('both resolve the rollover target from the shared service',
         /resolveRolloverTarget/.test(cli) && /resolveRolloverTarget/.test(route),
         'two definitions of "where would this go" is how they end up disagreeing');
      ok('the CLI writes the same audit action',
         /action: 'pool_product_type_remapped'/.test(cli) && /action: 'pool_product_type_remapped'/.test(route));
      ok('and bounds its statements with a timeout', /statement_timeout/.test(cli));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, err.stdout || '');
    fail++;
  } finally {
    await wipe().catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
