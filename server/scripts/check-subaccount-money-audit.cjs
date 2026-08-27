#!/usr/bin/env node
/* The sub-account money audit must find each defect's signature, and must not
 * invent findings from healthy rows.
 *
 * The second half is the part worth testing. An audit pointed at production
 * that reports money astray when none is will send someone chasing refunds
 * that should not happen; one that stays quiet when money really is missing is
 * worse. Both directions are exercised here.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-subaccount-money-audit.cjs
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

const ROOT = path.join(__dirname, '..', '..');
const AUDIT = path.join(__dirname, 'audit-subaccount-money.cjs');
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
    [['investors', 'sub_accounts', 'transactions', 'investments']]);
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
  await pool.query(`DELETE FROM transactions WHERE investor_id LIKE 'AU-%'`);
  await pool.query(`DELETE FROM investments  WHERE investor_id LIKE 'AU-%'`);
  await pool.query(`DELETE FROM sub_accounts WHERE id LIKE 'AUSUB-%'`);
  await pool.query(`DELETE FROM investors    WHERE id LIKE 'AU-%'`);
};

async function baseline() {
  await wipe();
  await pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status)
    VALUES ('AU-A','Anna','Payer','anna@example.test','active'),
           ('AU-B','Ben','Other','ben@example.test','active')`);
  await pool.query(`
    INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, wallet_balance, status)
    VALUES ('AUSUB-A','AU-A','trust','Anna Trust', 0, 'active'),
           ('AUSUB-B','AU-B','trust','Ben Trust',  0, 'active')`);
  /* Healthy rows the audit must stay silent about: a normal wallet deposit, a
     correctly-routed sub-account deposit, and a pending one. */
  await pool.query(`
    INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference, created_at)
    VALUES ('AU-T-OK1','AU-A',NULL,     'deposit', 500,'completed','AUOK1', NOW()),
           ('AU-T-OK2','AU-A','AUSUB-A','deposit', 750,'completed','AUOK2', NOW()),
           ('AU-T-PEND','AU-A','AUSUB-A','deposit',900,'pending',  'AUPEND',NOW())`);
}

const run = () => execFileSync('node', [AUDIT], { env: { ...process.env }, encoding: 'utf8' });

(async () => {
  try {
    if (!await ensureSchema()) { await pool.end(); process.exit(0); }

    console.log('\nhealthy data produces no findings');
    await baseline();
    {
      const out = run();
      ok('nothing is reported', /Nothing found/.test(out), out.slice(-500));
      ok('and the counts are zero',
         /A  deposits credited nowhere\s+0/.test(out) &&
         /B  deposits credited to the wrong owner\s+0/.test(out) &&
         /C  maturity paid to the parent\s+0/.test(out), out.slice(0, 500));
    }

    console.log('\nA — a deposit naming a sub-account that no longer exists');
    await baseline();
    await pool.query(`
      INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference, created_at)
      VALUES ('AU-T-GHOST','AU-A','AUSUB-GONE','deposit', 1000,'completed','AUGHOST', NOW())`);
    {
      const out = run();
      ok('it is found', /A  deposits credited nowhere\s+1/.test(out), out.slice(0, 400));
      ok('with the amount and the payer named',
         /R1,000\.00/.test(out) && /Anna Payer/.test(out) && /AUGHOST/.test(out));
      ok('and says the investor is short',
         /investor is short by the full amount/.test(out));
    }

    console.log('\nB — a deposit credited to another investor\'s sub-account');
    await baseline();
    await pool.query(`
      INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference, created_at)
      VALUES ('AU-T-WRONG','AU-A','AUSUB-B','deposit', 250,'completed','AUWRONG', NOW())`);
    {
      const out = run();
      ok('it is found', /B  deposits credited to the wrong owner\s+1/.test(out), out.slice(0, 400));
      ok('naming who paid and who received',
         /paid by Anna Payer/.test(out) && /belongs to Ben Other/.test(out), out.slice(-900));
    }

    console.log('\nC — maturity that paid the parent instead of the sub-account');
    await baseline();
    await pool.query(`
      INSERT INTO investments (id, investor_id, sub_account_id, pool_id, pool_name, amount, status,
          start_date, end_date, annual_rate, term_months, expected_return, actual_return, product_type,
          maturity_processed_at)
      VALUES ('AU-IV','AU-A','AUSUB-A',NULL,'Cattle Aug', 5000,'matured',
              CURRENT_DATE-360, CURRENT_DATE-1, 0.16, 12, 0, 0, 'cattle', NOW())`);
    await pool.query(`
      INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference,
          investment_id, created_at)
      VALUES ('AU-T-MAT','AU-A',NULL,'payout', 5500,'completed','MAT-AU-IV','AU-IV', NOW())`);
    {
      const out = run();
      ok('it is found', /C  maturity paid to the parent\s+1/.test(out), out.slice(0, 400));
      ok('and is described as misattribution, not loss',
         /stayed within the same investor, so none is missing/.test(out));
      ok('naming the sub-account it should have reached',
         /Anna Trust|AUSUB-A/.test(out), out.slice(-800));
    }

    console.log('\na correctly-routed maturity is not flagged');
    await baseline();
    await pool.query(`
      INSERT INTO investments (id, investor_id, sub_account_id, pool_id, pool_name, amount, status,
          start_date, end_date, annual_rate, term_months, expected_return, actual_return, product_type,
          maturity_processed_at)
      VALUES ('AU-IV2','AU-A','AUSUB-A',NULL,'Cattle Aug', 5000,'matured',
              CURRENT_DATE-360, CURRENT_DATE-1, 0.16, 12, 0, 0, 'cattle', NOW())`);
    await pool.query(`
      INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference,
          investment_id, created_at)
      VALUES ('AU-T-MAT2','AU-A','AUSUB-A','payout', 5500,'completed','MAT-AU-IV2','AU-IV2', NOW())`);
    {
      const out = run();
      ok('a payout carrying its sub-account is left alone',
         /C  maturity paid to the parent\s+0/.test(out), out.slice(0, 400));
    }

    console.log('\nthe three are reported apart, because they are not the same problem');
    await baseline();
    await pool.query(`
      INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference, created_at)
      VALUES ('AU-T-G2','AU-A','AUSUB-GONE','deposit', 100,'completed','AUG2', NOW()),
             ('AU-T-W2','AU-A','AUSUB-B',   'deposit',  50,'completed','AUW2', NOW())`);
    {
      const out = run();
      ok('money astray and misattribution are totalled separately',
         /is not where the payer put it \(A and B\)/.test(out) &&
         /right investor but the wrong account \(C\)/.test(out), out.slice(-700));
      ok('and A and B are summed together as the real shortfall',
         /R150\.00 is not where the payer put it/.test(out), out.slice(-700));
    }

    console.log('\nit is safe to point at production');
    {
      const src = fs.readFileSync(AUDIT, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      const writes = src.match(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b\s/gi) || [];
      ok('the audit issues no writes', writes.length === 0, `found: ${writes.join(', ')}`);
      ok('and bounds its statements with a timeout', /statement_timeout/.test(src));
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
