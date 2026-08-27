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

    console.log('\nit names the destination per maturing pool, not just per product');
    {
      const p = r.pools.find(x => x.poolId === 'PF-POSTED');
      ok('the maturing pool says what it rolls into',
         p && p.rollsInto && p.rollsInto.length === 1 && p.rollsInto[0].poolId === 'PF-TARGET',
         JSON.stringify(p && p.rollsInto));
    }

    console.log('\na similarly named successor does NOT receive a rollover');
    {
      /* The trap this exists to catch. "Cattle Investment - August 2026" looks
         like the obvious successor to "Cattle Investment - August 2025", but
         the engine matches product_type and never reads the name. A migrated
         pool carrying product_type 'other' finds nothing, however the open
         pool is titled. */
      await pool.query(`
        INSERT INTO investment_pools (id,name,product_type,status,annual_rate,term_months,
            start_date,end_date,min_investment)
        VALUES ('PF-LOOKALIKE','Migrated Product - September 2026','pf_real','open',0.12,6,
                CURRENT_DATE, CURRENT_DATE+30, 1000)`);
      await pool.query(`
        INSERT INTO investment_pools (id,name,product_type,status,annual_rate,actual_rate,term_months,
            start_date,end_date,maturity_date,min_investment)
        VALUES ('PF-MIGRATED','Migrated Product - August 2026','other','active',0.12,0.05,6,
                CURRENT_DATE-190, CURRENT_DATE-1, CURRENT_DATE, 1000)`);
      await pool.query(`
        INSERT INTO investments (id,investor_id,pool_id,pool_name,amount,status,start_date,end_date,
            annual_rate,term_months,expected_return,actual_return,product_type,maturity_instruction)
        VALUES ('PF-3','PF-A','PF-MIGRATED','Migrated Product - August 2026',200000,'active',
                CURRENT_DATE-190, CURRENT_DATE-1, 0.12, 6, 0, 0, 'other', 'reinvest')`);

      const r2 = await runMaturityPreflight(pool, { horizonDays: 14 });
      const mig = r2.pools.find(x => x.poolId === 'PF-MIGRATED');
      ok('the lookalike pool is not offered as the destination',
         mig && mig.rollsInto[0] && mig.rollsInto[0].poolId !== 'PF-LOOKALIKE',
         `offered ${mig && mig.rollsInto[0] && mig.rollsInto[0].poolId}`);
      ok('it says the money goes to wallets instead',
         mig && mig.rollsInto[0] && mig.rollsInto[0].toWallet === true,
         JSON.stringify(mig && mig.rollsInto));
      ok('and the finding names the pool and the reason',
         r2.findings.some(f => /PF-MIGRATED/.test(f.message) && /product_type only/.test(f.message)),
         JSON.stringify(r2.findings.filter(f => /PF-MIGRATED/.test(f.message))));

      /* And once the product types agree, it lands where you would expect. */
      await pool.query(`UPDATE investment_pools SET product_type='other' WHERE id='PF-LOOKALIKE'`);
      const r3 = await runMaturityPreflight(pool, { horizonDays: 14 });
      const mig3 = r3.pools.find(x => x.poolId === 'PF-MIGRATED');
      ok('matching product_type is what makes the succession work',
         mig3 && mig3.rollsInto[0] && mig3.rollsInto[0].poolId === 'PF-LOOKALIKE',
         `got ${mig3 && mig3.rollsInto[0] && mig3.rollsInto[0].poolId}`);
    }

    console.log('\na pool awaiting a cycle no longer diverts the rollover target');
    {
      /* cycleExpiredPools runs first inside the same job. It used to deploy
         every other open pool of the product type, current ones included,
         which moved the rollover target before any money left. Fixed at
         source; this holds the line from the reporting side. */
      /* Isolate: any OTHER cattle/short_term pool still awaiting a cycle would
         also sweep, and then this measures the wrong cause. Sibling checks in
         the suite leave exactly such pools behind, so stamp them first —
         PF-SWEEPER must be the only pending cycle. */
      await pool.query(
        `UPDATE investment_pools SET cycled_at = NOW()
          WHERE product_type IN ('cattle','short_term') AND cycled_at IS NULL`);
      await pool.query(`
        INSERT INTO investment_pools (id,name,product_type,status,annual_rate,term_months,
            start_date,end_date,maturity_date,min_investment,cycled_at)
        VALUES ('PF-SWEEPER','Cattle - July 2026','cattle','active',0.16,12,
                CURRENT_DATE-90, CURRENT_DATE-10, CURRENT_DATE+270, 500, NULL)`);
      await pool.query(`
        INSERT INTO investment_pools (id,name,product_type,status,annual_rate,term_months,
            start_date,end_date,maturity_date,min_investment,cycled_at)
        VALUES ('PF-CT-TARGET','Cattle - August 2026','cattle','open',0.16,12,
                CURRENT_DATE-30, CURRENT_DATE+20, CURRENT_DATE+380, 500, NOW())`);
      await pool.query(`
        INSERT INTO investment_pools (id,name,product_type,status,annual_rate,actual_rate,term_months,
            start_date,end_date,maturity_date,min_investment,cycled_at)
        VALUES ('PF-CT-MAT','Cattle - August 2025','cattle','active',0.16,0.1223,12,
                CURRENT_DATE-360, CURRENT_DATE-1, CURRENT_DATE, 500, NOW())`);
      await pool.query(`
        INSERT INTO investments (id,investor_id,pool_id,pool_name,amount,status,start_date,end_date,
            annual_rate,term_months,expected_return,actual_return,product_type,maturity_instruction)
        VALUES ('PF-CT-1','PF-A','PF-CT-MAT','Cattle - August 2025',3970430.15,'active',
                CURRENT_DATE-360, CURRENT_DATE-1, 0.16, 12, 0, 0, 'cattle', 'reinvest')`);

      const rs = await runMaturityPreflight(pool, { horizonDays: 14 });
      const ct = rs.pools.find(x => x.poolId === 'PF-CT-MAT');
      ok('the pool due to be cycled is still reported',
         (rs.pendingCycle || []).some(p => p.poolId === 'PF-SWEEPER'),
         JSON.stringify(rs.pendingCycle));
      ok('but the destination stands — the sweep no longer takes it',
         ct && ct.rollsInto[0] && ct.rollsInto[0].poolId === 'PF-CT-TARGET',
         JSON.stringify(ct && ct.rollsInto));
      ok('and no STOP is raised about it',
         !rs.findings.some(f => f.level === 'STOP' && /will NOT reach/.test(f.message)),
         JSON.stringify(rs.findings.filter(f => f.level === 'STOP').map(f => f.message)));
      ok('nobody is listed as having their target swept',
         !(rs.affected || []).some(a => a.issue === 'rollover_target_swept'),
         'that class cannot occur now that the sweep only deploys closed pools');
    }

    console.log('\nit names the clients behind each finding, not just a count');
    {
      /* A count tells you how much is wrong; it does not tell you who to
         phone. Every finding that resolves to specific people has to name
         them, with enough to act on. */
      const rp = await runMaturityPreflight(pool, { horizonDays: 14 });
      const byIssue = i => (rp.affected || []).filter(a => a.issue === i);

      const custom = byIssue('custom_payout_no_amount');
      ok('the custom-payout client is named', custom.length === 1, JSON.stringify(custom));
      if (custom[0]) {
        /* PF-2 is the payout_custom fixture: Ben, on the pool whose rate has
           not been posted. */
        ok('with the details needed to contact them',
           custom[0].name === 'Ben Unposted' && custom[0].email === 'ben@example.test' &&
           custom[0].investorId === 'PF-B' && custom[0].investmentId === 'PF-2',
           JSON.stringify(custom[0]));
        ok('and the capital at stake',
           custom[0].amount === 50000, `amount=${custom[0].amount}`);
        ok('with no return figure invented for an unposted pool',
           custom[0].postedReturn === 0,
           `postedReturn=${custom[0].postedReturn} — the pool has no actual_rate`);
        ok('marked STOP, because it silently changes what they receive',
           custom[0].severity === 'STOP', custom[0].severity);
      }

      ok('a rollover with nowhere to go names its investor',
         byIssue('rollover_to_wallet').every(a => a.name && a.investorId && a.targetProductType),
         JSON.stringify(byIssue('rollover_to_wallet')));

      ok('nobody without an issue appears in the list',
         !(rp.affected || []).some(a => a.investmentId === 'PF-1'),
         'PF-1 has a posted rate, a valid instruction and a target — it is not an issue');

      ok('the auto-reinvested are listed separately, not mixed in',
         Array.isArray(rp.noInstruction) &&
         !(rp.affected || []).some(a => a.issue === 'no_instruction'),
         'choosing nothing is a default, not a fault — but it is still worth seeing by name');

      ok('one client with two distinct problems gets two rows, not one',
         (() => {
           const byInvestor = {};
           for (const a of rp.affected || []) (byInvestor[a.investorId] ||= []).push(a.issue);
           return Object.values(byInvestor).every(issues => new Set(issues).size === issues.length);
         })(),
         'the same issue must not be listed twice for one person, but different issues must be');

      ok('the worst appears first',
         (rp.affected || []).length < 2 ||
         (rp.affected[0].severity === 'STOP' || !rp.affected.some(a => a.severity === 'STOP')),
         JSON.stringify((rp.affected || []).map(a => a.severity)));
    }

    console.log('\nit notices the things that need a person');
    /* Asserted on the section and the issue key, not the sentence. The prose
       has to change as instructions are added — switch_amount made "custom
       payout" the wrong blanket term for a message now covering three — and a
       check that fails on rewording says nothing about whether the STOP fired. */
    ok('an instruction with no amount is a STOP',
       r.findings.some(f => f.level === 'STOP' && f.section === 'instructions' && /amount/.test(f.message)),
       JSON.stringify(r.findings.filter(f => f.section === 'instructions')));
    ok('and the client is named with the issue',
       (r.affected || []).some(a => a.issue === 'custom_payout_no_amount' && a.severity === 'STOP'),
       JSON.stringify((r.affected || []).map(a => a.issue)));
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
