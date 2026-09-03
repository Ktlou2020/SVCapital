#!/usr/bin/env node
/* Where a pool's money came from, and what the raise cost.
 *
 * Money reaches a pool three ways and they are not interchangeable: new money
 * carries the 1% platform fee and grew the book, while reinvested and switched
 * money is fee-free and merely moved. A report that adds them into one figure
 * answers no question anyone has.
 *
 * The hard part is the source pool. investments carries no source column —
 * reinvestAmount writes the new holding with the DESTINATION pool and nothing
 * else. The provenance lives in the reinvestment transaction's reference,
 * 'REINV-' + the source investment id, with '-S'/'-R' on the two legs of a
 * switch_amount. This exercises that recovery against rows written the way
 * maturityCron writes them, including the leg suffixes and a rollover with no
 * transaction at all.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-pool-raise-report.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
/* A name no other process can pick.
 *
 * A check failed intermittently with FATAL 57P01, "terminating connection due
 * to administrator command" — which in this suite only comes from
 * DROP DATABASE ... WITH (FORCE), confirmed by the forced checkpoint the
 * server logs immediately after it. Something dropped a database out from
 * under a running check.
 *
 * process.pid alone is not unique enough to rule that out: one suite run
 * spawns two hundred short-lived processes and a container recycles pids, so
 * two checks can pick the same database name minutes apart. The random suffix
 * costs nothing and removes the only way two processes can name the same
 * database. */
const DB_NAME = 'chk_raise_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

function withDatabase(url, name) {
  const u = new URL(url); u.pathname = '/' + name; return u.toString();
}

/* max: 2 — these checks are single-threaded and never need more; the pg
   default is 10 per pool and this file opens two.

   This was originally introduced as a fix for an intermittent failure, on the
   theory that idle connections were exhausting max_connections. That theory
   was WRONG: the server log carries not one "sorry, too many clients already"
   in the whole session. The real error was FATAL 57P01, a forced DROP
   DATABASE terminating a live connection. The cap is kept because it is
   correct on its own terms, not because it fixed anything. */
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool;

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  const url = withDatabase(process.env.DATABASE_URL, DB_NAME);
  process.env.DATABASE_URL = url;
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  pool = new Pool({ connectionString: url, ssl: SSL, max: 2 });
}

/* RR-POOL is the pool that has just closed: short_term, 2% management fee.
   Money arrives from three places and one of them cannot be traced. */
async function seed() {
  await pool.query(`DELETE FROM transactions    WHERE id LIKE 'RR-%' OR reference LIKE 'RR-%'`);
  await pool.query(`DELETE FROM investments     WHERE id LIKE 'RR-%'`);
  await pool.query(`DELETE FROM sub_accounts    WHERE id LIKE 'RR-%'`);
  await pool.query(`DELETE FROM investors       WHERE id LIKE 'RR-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'RR-%'`);

  await pool.query(`
    INSERT INTO investment_pools (id,name,product_type,status,annual_rate,actual_rate,term_months,
        start_date,end_date,maturity_date,min_investment,management_fee_pct)
    VALUES
      ('RR-POOL','Short Term Investment - September 2026','short_term','active',0.13,0,12,
       CURRENT_DATE-60, CURRENT_DATE-1, CURRENT_DATE+364, 500, 0.02),
      ('RR-SRC-ST','Short Term Investment - August 2025','short_term','matured',0.13,0.05,12,
       CURRENT_DATE-420, CURRENT_DATE-60, CURRENT_DATE-60, 500, 0.02),
      ('RR-SRC-CT','Cattle Investment - August 2025','cattle','matured',0.16,0.06,12,
       CURRENT_DATE-420, CURRENT_DATE-60, CURRENT_DATE-60, 500, 0.02)`);

  await pool.query(`
    INSERT INTO investors (id,first_name,last_name,email,status,wallet_balance)
    VALUES ('RR-I1','Ana','Newmoney','ana@example.test','active',0),
           ('RR-I2','Bo','Newmoney','bo@example.test','active',0),
           ('RR-I3','Cyn','Rollover','cyn@example.test','active',0),
           ('RR-I4','Dee','Switcher','dee@example.test','active',0),
           ('RR-I5','Eli','Legacy','eli@example.test','active',0)`);
  await pool.query(`
    INSERT INTO sub_accounts (id,parent_investor_id,name,account_type,wallet_balance)
    VALUES ('RR-SA','RR-I1','Ana Junior','minor',0)`);

  /* The source holdings the rollovers came out of. */
  await pool.query(`
    INSERT INTO investments (id,investor_id,pool_id,pool_name,amount,status,start_date,end_date,
        annual_rate,term_months,expected_return,actual_return,product_type,maturity_instruction)
    VALUES
      ('RR-SRC-A','RR-I3','RR-SRC-ST','Short Term Investment - August 2025',200000,'matured',
       CURRENT_DATE-420, CURRENT_DATE-60, 0.13,12,0,0,'short_term','reinvest'),
      ('RR-SRC-B','RR-I4','RR-SRC-CT','Cattle Investment - August 2025',300000,'matured',
       CURRENT_DATE-420, CURRENT_DATE-60, 0.16,12,0,0,'cattle','switch_amount')`);

  /* What landed in RR-POOL.
     id, investor, sub, amount, is_reinvestment */
  const INV = [
    ['RR-N1', 'RR-I1', null,    100000, false],
    ['RR-N2', 'RR-I2', null,     50000, false],
    ['RR-N3', 'RR-I1', 'RR-SA',  25000, false],
    ['RR-R1', 'RR-I3', null,    210000, true],   // rolled from the short_term pool
    ['RR-S1', 'RR-I4', null,    120000, true],   // switched leg out of cattle
    ['RR-S2', 'RR-I4', null,    198000, true],   // the balance leg, also from cattle
    ['RR-U1', 'RR-I5', null,     40000, true],   // reinvested, no transaction to trace
  ];
  for (const [id, investor, sub, amount, reinv] of INV) {
    await pool.query(
      `INSERT INTO investments (id,investor_id,sub_account_id,pool_id,pool_name,amount,status,
          start_date,end_date,annual_rate,term_months,expected_return,actual_return,
          product_type,maturity_instruction,is_reinvestment,created_at)
       VALUES ($1,$2,$3,'RR-POOL','Short Term Investment - September 2026',$4,'active',
               CURRENT_DATE-30, CURRENT_DATE+334, 0.13, 12, 0, 0, 'short_term','reinvest',$5,NOW())`,
      [id, investor, sub, amount, reinv]);
  }

  /* Platform fee transactions, as tables.js writes them: FEE-<investment id>,
     on new money only. RR-N3's is deliberately missing — a fee that was never
     recorded is exactly what "fees paid" must not invent. */
  for (const [id, investor, sub, fee] of [
    ['RR-N1', 'RR-I1', null,   1000],
    ['RR-N2', 'RR-I2', null,    500],
  ]) {
    await pool.query(
      `INSERT INTO transactions (id,investor_id,sub_account_id,type,amount,status,reference,
          description,transaction_date,created_at,updated_at)
       VALUES ($1,$2,$3,'fee',$4,'completed',$1,'1% platform fee on investment',NOW(),NOW(),NOW())`,
      [`FEE-${id}`, investor, sub, fee]);
  }

  /* The rollover transactions, written the way reinvestAmount writes them:
     reference 'REINV-' + SOURCE investment id, with the leg suffix on a
     switch_amount, investment_id pointing at the NEW holding, pool_id at the
     destination. RR-U1 gets none. */
  const REINV = [
    ['REINV-RR-SRC-A',    'RR-R1', 'RR-I3', 210000],
    ['REINV-RR-SRC-B-S',  'RR-S1', 'RR-I4', 120000],
    ['REINV-RR-SRC-B-R',  'RR-S2', 'RR-I4', 198000],
  ];
  for (const [ref, newInv, investor, amount] of REINV) {
    await pool.query(
      `INSERT INTO transactions (id,investor_id,type,amount,status,reference,description,
          investment_id,pool_id,transaction_date,created_at,updated_at)
       VALUES (gen_random_uuid(),$1,'reinvestment',$2,'completed',$3,'Maturity rollover',
               $4,'RR-POOL',NOW(),NOW(),NOW())`,
      [investor, amount, ref, newInv]);
  }

  /* A cancelled holding: not money the pool raised, and must be excluded. */
  await pool.query(`
    INSERT INTO investments (id,investor_id,pool_id,pool_name,amount,status,start_date,end_date,
        annual_rate,term_months,expected_return,actual_return,product_type,maturity_instruction,is_reinvestment)
    VALUES ('RR-X1','RR-I2','RR-POOL','Short Term Investment - September 2026',999999,'cancelled',
            CURRENT_DATE-30, CURRENT_DATE+334, 0.13,12,0,0,'short_term','reinvest',false)`);
}

function serve() {
  const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
  const authPath = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, children: [], paths: [],
    exports: {
      requireAuth: (req, _res, next) => { req.user = { id: 'RR-ADM', email: 'a@example.test', role: 'admin' }; next(); },
      requireRole: () => (_req, _res, next) => next(),
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', require(path.join(ROOT, 'server', 'routes', 'manualCredit')));
  return new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

const get = (port, url) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: url }, res => {
    let b = ''; res.on('data', d => (b += d));
    res.on('end', () => {
      let body; try { body = JSON.parse(b); } catch (_) { body = { _raw: b.slice(0, 300) }; }
      resolve({ status: res.statusCode, body });
    });
  }).on('error', reject);
});

(async () => {
  let srv;
  try {
    await makeDatabase();
    await seed();
    srv = await serve();
    const port = srv.address().port;

    const { status, body: d } = await get(port, '/api/admin/pool-raise-report?pool_id=RR-POOL');
    console.log('\nthe report answers');
    ok('a 200', status === 200, `status ${status}: ${JSON.stringify(d).slice(0, 200)}`);
    if (status !== 200) throw new Error('cannot continue');
    ok('and names the pool', d.pool && d.pool.id === 'RR-POOL');

    const byId = Object.fromEntries((d.rows || []).map(r => [r.investmentId, r]));
    const t = d.totals;

    console.log('\nthe three ways money arrives are told apart');
    /* 100 000 + 50 000 + 25 000 new; 210 000 rolled from short_term;
       120 000 + 198 000 switched out of cattle; 40 000 untraceable. */
    ok('new money is the wallet-funded investments',
       near(t.newMoney, 175000) && t.newMoneyCount === 3, `${t.newMoney} / ${t.newMoneyCount}`);
    ok('reinvested is a rollover from the SAME product',
       near(t.reinvested, 210000) && t.reinvestedCount === 1, `${t.reinvested} / ${t.reinvestedCount}`);
    ok('switched in is a rollover from a DIFFERENT product',
       near(t.switchedIn, 318000) && t.switchedInCount === 2, `${t.switchedIn} / ${t.switchedInCount}`);
    ok('and the three plus the untraceable make the total raised',
       near(t.newMoney + t.reinvested + t.switchedIn + t.sourceUnknown, t.raised),
       `${t.newMoney} + ${t.reinvested} + ${t.switchedIn} + ${t.sourceUnknown} vs ${t.raised}`);
    ok('the total raised is R743 000', near(t.raised, 743000), String(t.raised));

    console.log('\nthe source pool is recovered from the rollover reference');
    /* investments has no source column. The reference is 'REINV-' + the source
       investment id, and that id is what makes the source pool knowable. */
    ok('a plain rollover names the pool it left',
       byId['RR-R1'] && byId['RR-R1'].sourcePoolId === 'RR-SRC-ST' &&
       byId['RR-R1'].kind === 'reinvest',
       JSON.stringify(byId['RR-R1'] && { p: byId['RR-R1'].sourcePoolId, k: byId['RR-R1'].kind }));
    ok('a switch names its source pool and is marked a switch',
       byId['RR-S1'] && byId['RR-S1'].sourcePoolId === 'RR-SRC-CT' && byId['RR-S1'].kind === 'switch',
       JSON.stringify(byId['RR-S1'] && { p: byId['RR-S1'].sourcePoolId, k: byId['RR-S1'].kind }));
    ok('and BOTH legs of a switch_amount are traced, not just the first',
       byId['RR-S2'] && byId['RR-S2'].sourcePoolId === 'RR-SRC-CT',
       'the -S and -R suffixes have to be stripped or the second leg loses its source');

    console.log('\nmoney with no provenance is reported, not dropped');
    ok('an untraceable rollover is its own category',
       byId['RR-U1'] && byId['RR-U1'].kind === 'unknown' && near(t.sourceUnknown, 40000),
       JSON.stringify(byId['RR-U1'] && byId['RR-U1'].kind));
    ok('and it is still inside the total raised',
       near(t.raised, 743000),
       'excluding it would understate the raise; hiding it would misstate the composition');

    console.log('\nby source pool, which is the actionable form');
    {
      const src = Object.fromEntries((d.sources || []).map(x => [x.poolId || 'unknown', x]));
      ok('the cattle pool is named with what left it',
         src['RR-SRC-CT'] && near(src['RR-SRC-CT'].amount, 318000) && src['RR-SRC-CT'].isSwitch === true,
         JSON.stringify(src['RR-SRC-CT']));
      ok('the short_term pool is separate and not marked a switch',
         src['RR-SRC-ST'] && near(src['RR-SRC-ST'].amount, 210000) && src['RR-SRC-ST'].isSwitch === false,
         JSON.stringify(src['RR-SRC-ST']));
      ok('a source pool counts its investors, not just its investments',
         src['RR-SRC-CT'] && src['RR-SRC-CT'].count === 2 && src['RR-SRC-CT'].investors === 1,
         'two legs from one person is one investor');
    }

    console.log('\nfees');
    ok('platform fees paid are the transactions that exist',
       near(t.platformFeesPaid, 1500), `${t.platformFeesPaid} — R1 000 + R500 recorded`);
    ok('the expected fee is reported alongside, not instead',
       near(t.platformFeesExpected, 1750), `${t.platformFeesExpected} — 1% of R175 000 of new money`);
    ok('and the shortfall is named',
       near(t.platformFeeShortfall, 250) && d.missingFeeRows.length === 1 &&
       d.missingFeeRows[0].investmentId === 'RR-N3',
       JSON.stringify(d.missingFeeRows));
    ok('a rollover carries no platform fee',
       byId['RR-R1'].platformFeeExpected === 0 && byId['RR-S1'].platformFeeExpected === 0,
       'reinvested money never passed through a wallet; charging it is what switch_amount avoids');
    ok('the upfront fee is the pool\'s management fee on everything raised',
       near(t.upfrontFees, 743000 * 0.02), `${t.upfrontFees} — 2% of R743 000`);
    ok('and the net is the raise less the upfront fee',
       near(t.netRaised, 743000 - (743000 * 0.02)), String(t.netRaised));

    console.log('\ncounts');
    ok('investors counts a holder once', t.investors === 6,
       `${t.investors} — Ana, Ana Junior, Bo, Cyn, Dee, Eli; Dee has two legs`);
    ok('and a sub-account counts as its own holder',
       (d.rows || []).some(r => r.isSubAccount === true),
       'the money is the sub-account\'s, not the parent\'s');
    ok('investments counts the holdings', t.investments === 7, String(t.investments));
    ok('a cancelled holding is in neither', !byId['RR-X1'],
       'R999 999 cancelled is not money the pool raised');

    console.log('\nand it refuses what it cannot answer');
    ok('an unknown pool is a 404',
       (await get(port, '/api/admin/pool-raise-report?pool_id=RR-NOPE')).status === 404);
    ok('a missing pool_id is a 400',
       (await get(port, '/api/admin/pool-raise-report')).status === 400);

    console.log('\nthe fee rule is shared, not restated');
    {
      const tables = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'tables.js'), 'utf8');
      const svc    = fs.readFileSync(path.join(ROOT, 'server', 'services', 'poolRaiseReport.js'), 'utf8');
      ok('the pool investor list takes it from services/poolFees',
         /require\('\.\.\/services\/poolFees'\)/.test(tables) && /feesFor\(/.test(tables));
      ok('so does the raise report',
         /require\('\.\/poolFees'\)/.test(svc) && /feesFor\(/.test(svc));
      ok('and neither recomputes the 1% itself',
         !/PLATFORM_FEE_PCT = 0\.01/.test(tables),
         'two copies of fee arithmetic disagree in front of the same admin');
    }

    console.log('\nthe console offers each report only where it is truthful');
    {
      const admin = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      ok('the maturity report is offered only on a matured pool',
         /p\.status === 'matured'[\s\S]{0,200}openPoolMaturityReport/.test(admin),
         'on an open pool it reports an allocation nobody has been asked for');
      ok('and the raise report only once the pool has stopped raising',
         /!\['open', 'waitlist', 'filling'\]\.includes\(p\.status\)[\s\S]{0,200}openPoolRaiseReport/.test(admin),
         'the raise is complete when the cycler moves the pool to active');
      ok('the raise report embeds its downloads like the maturity one',
         /<a class="btn-csv" href="\$\{csvHref\}"[\s\S]{0,600}Raise Report/.test(admin) ||
         (/_poolRaiseCSVText\(d\)/.test(admin) && /_buildPoolRaisePDF\(d\)/.test(admin) &&
          /doc\.output\('datauristring'\)/.test(admin)));
      ok('and it shares the statement letterhead',
         /Pool Raise Report<\/div>/.test(admin) && /border-top:5px solid #eda5ff/.test(admin));
    }

  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    if (srv) srv.close();
    if (pool) await pool.end().catch(() => {});
    try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
