#!/usr/bin/env node
/* The maturity pre-flight must be admin-only, read-only, and honest.
 *
 * It reports what the maturity engine will do to real money on its next run,
 * so three things matter:
 *
 *   1. Only admin and director can see it. It names investors' capital.
 *   2. It changes nothing. A pre-flight that mutates is not a pre-flight.
 *   3. Its numbers match what the engine will actually do — which is why the
 *      checks live in services/maturityPreflight.js and are shared with the
 *      CLI rather than written twice.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-maturity-preflight.cjs
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
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const eqN = (name, a, b, detail) =>
  ok(name, Math.abs(Number(a) - Number(b)) < 0.005, detail || `expected ${b}, got ${a}`);

function isScratchDatabase(url) {
  const name = (String(url).split('?')[0].split('/').pop() || '').toLowerCase();
  return /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(name) || /^svctest/.test(name);
}

async function ensureSchema() {
  const needed = ['investors', 'investments', 'investment_pools', 'transactions'];
  const { rows } = await pool.query(
    `SELECT bool_and(to_regclass('public.' || t) IS NOT NULL) AS ready
       FROM unnest($1::text[]) AS t`, [needed]);
  if (rows[0].ready) return true;
  if (!isScratchDatabase(process.env.DATABASE_URL) && process.env.CHECK_ALLOW_RESET !== '1') {
    console.log('  SKIP  incomplete schema and this is not a scratch database.');
    return false;
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const quiet = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); }
  finally { console.log = quiet; }
  return true;
}

async function seed() {
  /* The seeded demo pools include several left 'open' long past their close
     date. Leave them: the report should notice them. */
  await pool.query(`DELETE FROM investments WHERE id LIKE 'PF-%'`);
  await pool.query(`DELETE FROM investors   WHERE id LIKE 'PF-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'PF-%'`);

  await pool.query(`
    INSERT INTO investment_pools (id,name,product_type,status,annual_rate,actual_rate,term_months,
        start_date,end_date,maturity_date,min_investment,current_invested,raised_amount)
    VALUES
     ('PF-POSTED','Posted Pool','pf_type','active',0.12,0.07,6,
      CURRENT_DATE-190,CURRENT_DATE-1,CURRENT_DATE,1000,100000,100000),
     ('PF-UNPOSTED','Unposted Pool','pf_type','active',0.12,0,6,
      CURRENT_DATE-190,CURRENT_DATE-1,CURRENT_DATE,1000,50000,50000),
     ('PF-TARGET','Open Target','pf_type','open',0.12,0,6,
      CURRENT_DATE,CURRENT_DATE+30,CURRENT_DATE+210,1000,0,0)`);

  await pool.query(`
    INSERT INTO investors (id,first_name,last_name,email,phone,status,wallet_balance)
    VALUES ('PF-A','Ann','Posted','ann@example.test','0800000001','active',0),
           ('PF-B','Ben','Unposted','ben@example.test',NULL,'active',0)`);

  await pool.query(`
    INSERT INTO investments (id,investor_id,pool_id,pool_name,amount,status,start_date,end_date,
        annual_rate,term_months,expected_return,actual_return,product_type,maturity_instruction,
        custom_payout_amount)
    VALUES
     ('PF-1','PF-A','PF-POSTED','Posted Pool',100000,'active',CURRENT_DATE-190,CURRENT_DATE-1,
      0.12,6,6000,0,'pf_type','reinvest',NULL),
     ('PF-2','PF-B','PF-UNPOSTED','Unposted Pool',50000,'active',CURRENT_DATE-190,CURRENT_DATE-1,
      0.12,6,3000,0,'pf_type','payout_custom',NULL)`);
}

const snapshot = async () => (await pool.query(`
  SELECT (SELECT COALESCE(sum(wallet_balance),0) FROM investors)              AS wallets,
         (SELECT count(*) FROM investments)                                    AS investments,
         (SELECT count(*) FROM transactions)                                   AS transactions,
         (SELECT COALESCE(sum(amount),0) FROM investments)                     AS invested,
         (SELECT count(*) FROM investments WHERE maturity_processed_at IS NOT NULL) AS processed
`)).rows[0];

(async () => {
  try {
    if (!await ensureSchema()) { await pool.end(); process.exit(0); }
    await seed();

    const { runMaturityPreflight } = require(path.join(ROOT, 'server', 'services', 'maturityPreflight.js'));

    console.log('\nit changes nothing');
    const before = await snapshot();
    const r = await runMaturityPreflight(pool, { horizonDays: 14 });
    const after = await snapshot();
    ok('wallets, investments and transactions are untouched',
       JSON.stringify(before) === JSON.stringify(after),
       `before ${JSON.stringify(before)}\n      after  ${JSON.stringify(after)}`);
    {
      const src = fs.readFileSync(path.join(ROOT, 'server', 'services', 'maturityPreflight.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      const writes = src.match(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b\s/gi) || [];
      ok('the service issues no writes', writes.length === 0, `found: ${writes.join(', ')}`);
    }

    console.log('\nit reports the posted return, not the projection');
    const posted = r.pools.find(p => p.poolId === 'PF-POSTED');
    ok('the posted pool is reported', !!posted);
    if (posted) {
      eqN('7% of R100 000 for the period', posted.postedTotal, 7000);
      eqN('the projection is shown alongside it', posted.projected, 6000);
      eqN('and the difference is spelled out', posted.difference, 1000);
      ok('with no floating-point tail',
         String(posted.postedTotal) === '7000' && String(posted.difference) === '1000',
         `postedTotal=${posted.postedTotal} difference=${posted.difference}`);
    }

    console.log('\nan unposted rate is called a STOP, because nothing will be paid');
    const unposted = r.pools.find(p => p.poolId === 'PF-UNPOSTED');
    ok('it is flagged as not posted', unposted && unposted.ratePosted === false);
    ok('no return figure is invented for it', unposted && unposted.postedTotal === null);
    ok('and it is a STOP naming the held-back capital',
       r.findings.some(f => f.level === 'STOP' && /PF-UNPOSTED/.test(f.message) && /HELD BACK/.test(f.message)),
       JSON.stringify(r.findings.filter(f => f.level === 'STOP'), null, 1));

    console.log('\nit uses the same target query as the engine');
    {
      const t = r.reinvestTargets.find(x => x.productType === 'pf_type');
      ok('the open, current pool is named', t && t.poolId === 'PF-TARGET', `got ${t && t.poolId}`);
    }

    console.log('\nit notices the things that need a person');
    ok('a custom payout with no amount is a STOP',
       r.findings.some(f => f.level === 'STOP' && /custom-payout/.test(f.message)));
    ok('stale open pools are reported',
       r.stalePools.length > 0 && r.findings.some(f => /past their close date/.test(f.message)));
    ok('the verdict is blocked while a STOP stands', r.summary.verdict === 'blocked', r.summary.verdict);

    console.log('\nthe horizon is bounded');
    const wide = await runMaturityPreflight(pool, { horizonDays: 9999 });
    ok('an absurd horizon is clamped', wide.horizonDays === 365, String(wide.horizonDays));
    const bad = await runMaturityPreflight(pool, { horizonDays: 'nonsense' });
    ok('a non-numeric horizon falls back to the default', bad.horizonDays === 14, String(bad.horizonDays));

    console.log('\nthe endpoint is admin-only and read-only');
    {
      const route = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'manualCredit.js'), 'utf8');
      ok('it is mounted on the admin router',
         /router\.get\('\/maturity-preflight'/.test(route));
      ok('which is guarded for admin and director',
         /router\.use\(requireAuth, requireRole\('admin', 'director'\)\)/.test(route),
         'the router-level guard is what makes every route here admin-only');
      const handler = route.slice(route.indexOf("router.get('/maturity-preflight'"));
      const body = handler.slice(0, handler.indexOf('\n});'));
      ok('the handler is a GET that only reads',
         !/\b(INSERT|UPDATE|DELETE)\b/i.test(body) && !/audit\.log/.test(body),
         'nothing happened, so there is nothing to audit');
    }

    console.log('\none implementation, two front ends');
    {
      const cli = fs.readFileSync(path.join(ROOT, 'server', 'scripts', 'preflight-maturity.cjs'), 'utf8');
      ok('the CLI renders the shared service rather than its own queries',
         /require\('\.\.\/services\/maturityPreflight'\)/.test(cli) &&
         !/FROM investments/i.test(cli),
         'a second copy of these queries would drift from the engine');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    await pool.query(`DELETE FROM investments WHERE id LIKE 'PF-%'`).catch(() => {});
    await pool.query(`DELETE FROM investors   WHERE id LIKE 'PF-%'`).catch(() => {});
    await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'PF-%'`).catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
