#!/usr/bin/env node
/* Where a maturing pool's money goes, per instruction and per destination.
 *
 * The report is read BEFORE the money moves, and it is the basis on which
 * someone decides to let it move. So the only property worth guarding hard is
 * that it agrees with maturityCron: every instruction is exercised here, and
 * the split each one produces is asserted against the switch statement in the
 * engine rather than against what the report happens to compute.
 *
 * The interesting cases are the ones a GROUP BY cannot answer:
 *   · a blank instruction, which is not missing but defaulted, and must carry
 *     the auto-reinvest tag
 *   · switch_amount, the only instruction with TWO destinations
 *   · a switch whose product type has no open pool, where "switched" is a lie
 *     and the money is really cash
 *   · a delivery-bike holding left on reinvest, which the engine pays OUT
 *   · an investment with no posted return, which the engine does not process
 *     at all and which must therefore not appear in any total
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-pool-maturity-report.cjs
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
const DB_NAME = 'chk_matrep_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = '/' + name;
  return u.toString();
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

/* The maturing pool: R100 000 of capital at a posted 5%, so every return is a
   round number and every split can be checked by hand.

   MR-DEST-ST and MR-DEST-CT are the open pools the rollovers land in.
   'gridfarmer' deliberately has NO open pool — a switch into it is cash. */
async function seed() {
  await pool.query(`DELETE FROM investments      WHERE id LIKE 'MR-%'`);
  await pool.query(`DELETE FROM sub_accounts     WHERE id LIKE 'MR-%'`);
  await pool.query(`DELETE FROM investors        WHERE id LIKE 'MR-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'MR-%'`);
  /* The seeded demo pools sit open years past their close date and would win
     the rollover target query ahead of the fixtures. */
  await pool.query(`UPDATE investment_pools SET status='active' WHERE id NOT LIKE 'MR-%'`);

  await pool.query(`
    INSERT INTO investment_pools (id,name,product_type,status,annual_rate,actual_rate,term_months,
        start_date,end_date,maturity_date,min_investment)
    VALUES
      ('MR-POOL','Short Term Investment - March 2025','short_term','active',0.16,0.05,12,
       CURRENT_DATE-365, CURRENT_DATE-30, CURRENT_DATE, 500),
      ('MR-DEST-ST','Short Term Investment - October 2026','short_term','open',0.16,0,12,
       CURRENT_DATE-5, CURRENT_DATE+25, CURRENT_DATE+390, 500),
      ('MR-DEST-CT','Cattle Investment - November 2026','cattle','open',0.16,0,12,
       CURRENT_DATE-5, CURRENT_DATE+55, CURRENT_DATE+420, 500)`);

  await pool.query(`
    INSERT INTO investors (id,first_name,last_name,email,status,wallet_balance)
    VALUES ('MR-I1','Ann','Blank','ann@example.test','active',0),
           ('MR-I2','Ben','Payout','ben@example.test','active',0),
           ('MR-I3','Cara','Switcher','cara@example.test','active',0),
           ('MR-I4','Dan','Split','dan@example.test','active',0),
           ('MR-I5','Eve','Nowhere','eve@example.test','active',0),
           ('MR-I6','Fay','Bike','fay@example.test','active',0),
           ('MR-I7','Gus','Unposted','gus@example.test','active',0)`);
  await pool.query(`
    INSERT INTO sub_accounts (id,parent_investor_id,name,account_type,wallet_balance)
    VALUES ('MR-SA','MR-I1','Ann Junior','minor',0)`);

  /* id, investor, sub, amount, instruction, custom, switch_type, product_type */
  const INV = [
    ['MR-A', 'MR-I1', null,    100000, null,             0,     null,         'short_term'],   // blank
    ['MR-B', 'MR-I2', null,    100000, 'payout_all',     0,     null,         'short_term'],
    ['MR-C', 'MR-I2', null,    100000, 'payout_return',  0,     null,         'short_term'],
    ['MR-D', 'MR-I3', null,    100000, 'payout_custom',  30000, null,         'short_term'],
    ['MR-E', 'MR-I3', null,    100000, 'switch_product', 0,     'cattle',     'short_term'],
    ['MR-F', 'MR-I4', null,    100000, 'custom_switch',  25000, 'cattle',     'short_term'],
    ['MR-G', 'MR-I4', null,    100000, 'switch_amount',  40000, 'cattle',     'short_term'],
    ['MR-H', 'MR-I5', null,    100000, 'switch_product', 0,     'gridfarmer', 'short_term'],
    ['MR-I', 'MR-I6', null,    100000, 'reinvest',       0,     null,         'delivery_bike'],
    ['MR-J', 'MR-I1', 'MR-SA', 100000, 'reinvest',       0,     null,         'short_term'],
  ];
  for (const [id, investor, sub, amount, instr, custom, sw, ptype] of INV) {
    await pool.query(
      `INSERT INTO investments (id,investor_id,sub_account_id,pool_id,pool_name,amount,status,
          start_date,end_date,annual_rate,term_months,expected_return,actual_return,
          product_type,maturity_instruction,custom_payout_amount,switch_product_type)
       VALUES ($1,$2,$3,'MR-POOL','Short Term Investment - March 2025',$4,'active',
               CURRENT_DATE-365, CURRENT_DATE, 0.16, 12, 9999, 0, $5, $6, $7, $8)`,
      [id, investor, sub, amount, ptype, instr, custom, sw]);
  }

  /* An investment in a pool with no posted rate — the engine holds it back.
     Its own pool, so MR-POOL's rate cannot rescue it. */
  await pool.query(`
    INSERT INTO investment_pools (id,name,product_type,status,annual_rate,actual_rate,term_months,
        start_date,end_date,maturity_date,min_investment)
    VALUES ('MR-POOL-NORATE','Short Term Investment - unposted','short_term','active',0.16,0,12,
            CURRENT_DATE-365, CURRENT_DATE-30, CURRENT_DATE, 500)`);
  await pool.query(`
    INSERT INTO investments (id,investor_id,pool_id,pool_name,amount,status,
        start_date,end_date,annual_rate,term_months,expected_return,actual_return,
        product_type,maturity_instruction)
    VALUES ('MR-K','MR-I7','MR-POOL-NORATE','Short Term Investment - unposted',50000,'active',
            CURRENT_DATE-365, CURRENT_DATE, 0.16, 12, 7777, 0, 'short_term', 'payout_all')`);
}

function serve() {
  const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
  const authPath = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, children: [], paths: [],
    exports: {
      requireAuth: (req, _res, next) => { req.user = { id: 'MR-ADM', email: 'a@example.test', role: 'admin' }; next(); },
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

    const { status, body: d } = await get(port, '/api/admin/pool-maturity-report?pool_id=MR-POOL');

    console.log('\nthe report answers');
    ok('a 200', status === 200, `status ${status}: ${JSON.stringify(d).slice(0, 200)}`);
    ok('and names the pool it is about', d.pool && d.pool.id === 'MR-POOL');
    if (status !== 200) throw new Error('cannot continue without a report');

    const byId = Object.fromEntries((d.rows || []).map(r => [r.investmentId, r]));
    const grp  = Object.fromEntries((d.byInstruction || []).map(g => [g.instruction, g]));

    /* R100 000 at 5% posted on the pool = R5 000 return, R105 000 maturing. */
    console.log('\nthe return is the pool\'s posted rate, applied to capital');
    ok('R100 000 at 5% matures at R105 000',
       byId['MR-B'] && near(byId['MR-B'].gross, 105000) && near(byId['MR-B'].actualReturn, 5000),
       JSON.stringify(byId['MR-B'] && { g: byId['MR-B'].gross, r: byId['MR-B'].actualReturn }));

    console.log('\na blank instruction is auto-reinvest, not a gap');
    ok('it is tagged auto_reinvest', byId['MR-A'] && byId['MR-A'].instruction === 'auto_reinvest',
       byId['MR-A'] && byId['MR-A'].instruction);
    ok('and labelled so a reader knows it was defaulted, not chosen',
       byId['MR-A'] && /no instruction given/i.test(byId['MR-A'].instructionLabel),
       byId['MR-A'] && byId['MR-A'].instructionLabel);
    ok('its money is reinvested in full, as the engine does',
       byId['MR-A'] && near(byId['MR-A'].reinvested, 105000) && near(byId['MR-A'].toWallet, 0));
    ok('it is grouped apart from an explicit reinvest',
       !!grp.auto_reinvest && !!grp.reinvest && grp.auto_reinvest.count === 1,
       JSON.stringify(Object.keys(grp)));

    console.log('\nevery instruction splits the way maturityCron splits it');
    ok('payout_all: all to the wallet',
       near(byId['MR-B'].toWallet, 105000) && near(byId['MR-B'].reinvested, 0));
    ok('payout_return: the return out, the capital reinvested',
       near(byId['MR-C'].toWallet, 5000) && near(byId['MR-C'].reinvested, 100000));
    ok('payout_custom: the named amount out, the rest reinvested',
       near(byId['MR-D'].toWallet, 30000) && near(byId['MR-D'].reinvested, 75000));
    ok('custom_switch: the named amount out, the rest switched',
       near(byId['MR-F'].toWallet, 25000) && near(byId['MR-F'].reinvested, 80000));
    ok('switch_product: nothing out, everything switched',
       near(byId['MR-E'].toWallet, 0) && near(byId['MR-E'].reinvested, 105000));
    ok('switch_amount: nothing out — the named amount goes to a PRODUCT',
       near(byId['MR-G'].toWallet, 0) && near(byId['MR-G'].reinvested, 105000),
       'this is the instruction that exists to avoid the 1% fee on the balance');

    console.log('\nswitches name the pool the money lands in');
    ok('a switch to cattle names the open cattle pool',
       byId['MR-E'].legs.length === 1 &&
       byId['MR-E'].legs[0].destinationPoolId === 'MR-DEST-CT' &&
       byId['MR-E'].legs[0].isSwitch === true,
       JSON.stringify(byId['MR-E'].legs));
    ok('and a reinvest names the open pool of its own product',
       byId['MR-A'].legs[0].destinationPoolId === 'MR-DEST-ST' &&
       byId['MR-A'].legs[0].isSwitch === false,
       JSON.stringify(byId['MR-A'].legs));
    ok('the destination carries its closing date, so a reader can check it',
       !!byId['MR-E'].legs[0].destinationEndDate);

    console.log('\nswitch_amount has TWO destinations, and both are shown');
    {
      const legs = byId['MR-G'].legs;
      ok('two legs, not one', legs.length === 2, JSON.stringify(legs));
      const sw  = legs.find(l => l.isSwitch);
      const own = legs.find(l => !l.isSwitch);
      ok('R40 000 switches into the cattle pool',
         sw && near(sw.amount, 40000) && sw.destinationPoolId === 'MR-DEST-CT',
         JSON.stringify(sw));
      ok('and the R65 000 balance stays in short_term',
         own && near(own.amount, 65000) && own.destinationPoolId === 'MR-DEST-ST',
         JSON.stringify(own));
    }

    console.log('\na switch with nowhere to go is cash, and says so');
    {
      const leg = byId['MR-H'].legs[0];
      ok('the leg is flagged as falling back to the wallet',
         leg && leg.fallsBackToWallet === true && leg.destinationPoolId === null,
         JSON.stringify(leg));
      /* Where the money goes is the question this report answers, and it can
         only have one answer. Counting the fallback as reinvested in the
         totals while flagging it as cash in the destination cell made the
         summary cards and the table's TOTAL row disagree by R105 000 on the
         same page. */
      ok('it counts as money reaching the wallet, not a pool',
         near(byId['MR-H'].toWallet, 105000) && near(byId['MR-H'].reinvested, 0),
         `toWallet ${byId['MR-H'].toWallet}, reinvested ${byId['MR-H'].reinvested}`);
      ok('and the instruction it was given is still reported separately',
         near(byId['MR-H'].instructedToWallet, 0) && near(byId['MR-H'].fallbackToWallet, 105000),
         'the client asked for a switch; the report must show both the ask and the outcome');
    }

    console.log('\nthe engine\'s delivery-bike override is reflected');
    ok('a delivery-bike holding left on reinvest is paid OUT',
       near(byId['MR-I'].toWallet, 105000) && near(byId['MR-I'].reinvested, 0),
       'reporting the tag alone would put this money in the reinvest column');
    ok('and the row says it will not execute as tagged',
       byId['MR-I'].effectiveInstruction === 'payout_all',
       String(byId['MR-I'].effectiveInstruction));

    console.log('\na sub-account holding is named as its own holder');
    ok('the sub-account name is shown, not the parent\'s',
       byId['MR-J'] && byId['MR-J'].holderName === 'Ann Junior' && byId['MR-J'].isSubAccount === true,
       JSON.stringify(byId['MR-J'] && { n: byId['MR-J'].holderName, s: byId['MR-J'].isSubAccount }));

    console.log('\nthe destination summary answers "what is each pool about to receive"');
    {
      const dest = Object.fromEntries((d.destinations || []).map(x => [x.poolId || 'wallet', x]));
      ok('the cattle pool is listed with what switches into it',
         dest['MR-DEST-CT'] && near(dest['MR-DEST-CT'].switchedIn, 105000 + 80000 + 40000),
         JSON.stringify(dest['MR-DEST-CT']));
      ok('the short_term pool separates switched-in money from ordinary reinvestment',
         dest['MR-DEST-ST'] && near(dest['MR-DEST-ST'].switchedIn, 0) &&
         dest['MR-DEST-ST'].amount > 0,
         JSON.stringify(dest['MR-DEST-ST']));
      ok('and the wallet fallback is a destination in its own right',
         (d.destinations || []).some(x => x.fallsBackToWallet === true),
         JSON.stringify((d.destinations || []).map(x => x.poolId)));
    }

    console.log('\nthe totals reconcile');
    {
      const t = d.totals;
      ok('capital plus return equals the maturing total',
         near(t.principal + t.actualReturn, t.gross),
         `${t.principal} + ${t.actualReturn} vs ${t.gross}`);
      ok('wallet plus reinvested equals the maturing total',
         near(t.toWallet + t.reinvested, t.gross),
         `${t.toWallet} + ${t.reinvested} vs ${t.gross} — every rand must be allocated somewhere`);
      ok('the by-instruction groups sum to the same total',
         near(d.byInstruction.reduce((s, g) => s + g.gross, 0), t.gross));
      ok('and the group columns sum to the same wallet and reinvested figures',
         near(d.byInstruction.reduce((s, g) => s + g.toWallet, 0), t.toWallet) &&
         near(d.byInstruction.reduce((s, g) => s + g.reinvested, 0), t.reinvested),
         'the summary cards and the table TOTAL are the same numbers or the page contradicts itself');
      ok('the destinations sum to the maturing total once the wallet is added back',
         near(d.destinations.reduce((s, x) => s + x.amount, 0) + t.instructedToWallet, t.gross));
      ok('and the fallback is counted as cash exactly once',
         near(t.instructedToWallet + t.fallbackToWallet, t.toWallet),
         `${t.instructedToWallet} + ${t.fallbackToWallet} vs ${t.toWallet}`);
      ok('ten investments, seven holders', t.investments === 10 && t.investors === 7,
         `${t.investments} / ${t.investors}`);
    }

    console.log('\nan investment with no posted return is held back, not totalled');
    {
      const r2 = await get(port, '/api/admin/pool-maturity-report?pool_id=MR-POOL-NORATE');
      ok('it appears in heldBack', (r2.body.heldBack || []).some(h => h.investmentId === 'MR-K'),
         JSON.stringify(r2.body.heldBack));
      ok('and in no allocation total', near(r2.body.totals.gross, 0),
         `gross ${r2.body.totals.gross} — the engine skips these and retries the next night`);
      ok('its capital is reported so it is not invisible',
         near(r2.body.heldBackPrincipal, 50000), String(r2.body.heldBackPrincipal));
      ok('and the pool is flagged as having no posted rate',
         r2.body.pool.ratePosted === false);
    }

    console.log('\nand it refuses what it cannot answer');
    const missing = await get(port, '/api/admin/pool-maturity-report?pool_id=MR-NOPE');
    ok('an unknown pool is a 404', missing.status === 404, `status ${missing.status}`);
    const noId = await get(port, '/api/admin/pool-maturity-report');
    ok('a missing pool_id is a 400', noId.status === 400, `status ${noId.status}`);

    console.log('\nthe allocation is the engine\'s, not a second copy of it');
    {
      const cron = fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'maturityCron.js'), 'utf8');
      const svc  = fs.readFileSync(path.join(ROOT, 'server', 'services', 'maturityInstructionReport.js'), 'utf8');
      const cases = ['payout_all', 'payout_return', 'payout_custom', 'custom_switch',
                     'switch_amount', 'switch_product', 'reinvest'];
      const missingCase = cases.filter(c => !new RegExp(`case '${c}'`).test(svc));
      ok('every instruction the engine handles is handled here',
         missingCase.length === 0,
         `absent from the report: ${missingCase.join(', ')} — an unhandled case falls to reinvest silently`);
      const cronOnly = cases.filter(c => !new RegExp(`case '${c}'`).test(cron));
      ok('and the list is taken from the engine, which still has them all',
         cronOnly.length === 0, cronOnly.join(', '));
      ok('the report imports the posted-return rule rather than restating it',
         /require\('\.\/maturityPreflight'\)/.test(svc) && /postedReturn\(/.test(svc));
      ok('and resolves destinations with the engine\'s own target query',
         /resolveRolloverTarget/.test(svc),
         'a second definition of "which pool does this land in" is a second thing to drift');
    }

    /* ── The PDF generator, executed ──────────────────────────────────
       Source assertions prove the function exists. They do not prove it runs:
       a typo, a bad property access, or a spread of an array into a
       three-argument call all pass a regex and throw at the click. jsPDF comes
       from a CDN this container cannot reach, so it is stubbed faithfully
       enough to record what the generator asks of it — which is what exercises
       the body. */
    console.log('\nthe PDF generator, run against the real report');
    {
      const vm = require('vm');
      const admin = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      const at = admin.indexOf('function _buildPoolMaturityPDF(');
      let k = admin.indexOf('{', admin.indexOf(')', at)), depth = 0, end = k;
      for (; k < admin.length; k++) {
        if (admin[k] === '{') depth++;
        else if (admin[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
      }
      const fnSrc = admin.slice(at, end + 1);

      const calls = { tables: [], text: [], saved: null, toasts: [] };
      let finalY = 100;
      const docStub = {
        internal: { pageSize: { getWidth: () => 842, getHeight: () => 595 }, getNumberOfPages: () => 2 },
        setFillColor(){}, rect(){}, setTextColor(){}, setFont(){}, setFontSize(){}, setPage(){},
        text(t){ calls.text.push(String(t)); },
        autoTable(o){ calls.tables.push(o); finalY += 120; this.lastAutoTable = { finalY }; },
        lastAutoTable: { finalY: 100 },
        save(name){ calls.saved = name; },
      };
      const ctx = {
        console, Date, Math, String, Number, JSON, parseFloat, RegExp,
        _POOL_MATURITY_REPORT: d,
        Toast: { error: m => calls.toasts.push('error:' + m), success: m => calls.toasts.push('ok:' + m) },
        window: { jspdf: { jsPDF: function () { return docStub; } } },
      };
      vm.createContext(ctx);
      let threw = null;
      try {
        vm.runInContext(`${fnSrc}\nthis.__run = () => _buildPoolMaturityPDF(_POOL_MATURITY_REPORT);`, ctx);
        calls.returned = ctx.__run();
      } catch (e) { threw = e.message; }

      ok('it runs without throwing', threw === null, String(threw));
      ok('and returns a document for the caller to embed or save',
         calls.returned === docStub, 'null means the libraries are missing, which is a different outcome');
      ok('with a table for each section',
         calls.tables.length === 3,
         `${calls.tables.length} tables — instructions, destinations, by client`);

      const cells = calls.tables.flatMap(t => t.body.flat()).map(String);
      ok('no cell renders as undefined', !cells.some(c => /undefined/.test(c)),
         JSON.stringify(cells.filter(c => /undefined/.test(c)).slice(0, 3)));
      ok('and none as NaN', !cells.some(c => /NaN/.test(c)),
         JSON.stringify(cells.filter(c => /NaN/.test(c)).slice(0, 3)));

      /* Guarded: when the generator throws part-way there is no first table,
         and reading .body off it aborted the whole check — so a real failure
         reported as a crash instead of as the four assertions it broke. */
      const instr = calls.tables[0] || { body: [] };
      const lastRow = instr.body[instr.body.length - 1] || [];
      ok('the instruction table ends with a TOTAL row',
         lastRow[0] === 'TOTAL', JSON.stringify(instr.body.slice(-1)));
      ok('the auto-reinvest tag reaches the PDF',
         cells.some(c => /no instruction given/i.test(c)));
      ok('so does a named switch destination',
         cells.some(c => /Cattle Investment - November 2026/.test(c) && /switched/.test(c)),
         'the destination is the point of the report');
      ok('and the wallet fallback is spelled out rather than shown as a pool',
         cells.some(c => /no open gridfarmer pool/i.test(c)));
      ok('the header states the three headline figures',
         calls.text.some(t => /Maturing R/.test(t) && /Paid to wallets R/.test(t) && /Reinvested R/.test(t)),
         JSON.stringify(calls.text.slice(0, 6)));
      ok('every page carries the footer',
         calls.text.filter(t => /www\.svcapital\.co\.za/.test(t)).length === 2,
         'two pages in the stub, so two footers');
      ok('and it reports nothing — the caller decides what to do with it',
         calls.toasts.length === 0, JSON.stringify(calls.toasts));
    }

    console.log('\nthe console can draw and export it');
    {
      const admin = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      ok('the pool card offers the report', /openPoolMaturityReport\(/.test(admin));
      ok('the document shares the statement letterhead',
         /Maturity Instructions<\/div>/.test(admin) &&
         /sv-capital-logo-horizontal-white-text\.png/.test(admin) &&
         /border-top:5px solid #eda5ff/.test(admin));
      ok('and there is a CSV download', /function downloadPoolMaturityCSV/.test(admin));
      ok('the CSV writes one line per destination',
         /const legs = r\.legs\.length \? r\.legs : \[null\];/.test(admin),
         'flattening switch_amount to one line hides one of its two destinations');
      ok('and a PDF download that produces a file, not a print dialog',
         /function downloadPoolMaturityPDF/.test(admin) && /doc\.save\(/.test(admin),
         'this report is filed and forwarded, not just read on screen');
      /* The report window is a document.write into about:blank, and what a
         download needs there is specific. Driving the real popup over CDP
         showed: a data: anchor in that window downloads, a blob: anchor in it
         does NOT, and the first version's cross-window callback left every
         failure reporting through Toast in the console behind the report — so
         a broken button and a working one looked identical.

         Hence: both files embedded as data: URLs on real anchors. No opener,
         no blob, one gesture in the window the person is looking at. */
      ok('the download controls are anchors carrying the file, not callbacks',
         /<a class="btn-csv" href="\$\{csvHref\}" download=/.test(admin) &&
         /<a class="btn-pdf" href="\$\{pdfHref\}" download=/.test(admin),
         'a cross-window call depends on window.opener surviving; an anchor does not');
      ok('and nothing calls back into the opener any more',
         !/_back\('download/.test(admin) && !/window\.opener\.downloadPoolMaturity/.test(admin));
      ok('the CSV is a data: URL, which is what downloads from that window',
         /'data:text\/csv;charset=utf-8;base64,' \+ b64\(/.test(admin),
         'a blob: URL in a document.write popup silently fails to download');
      ok('and the PDF is embedded the same way, not saved from the console',
         /pdfDoc\.output\('datauristring'\)/.test(admin));
      ok('a PDF that cannot be built shows a note instead of a dead button',
         /PDF unavailable &mdash; use Print/.test(admin),
         'jsPDF and autoTable come from a CDN and either can fail to load');
      ok('and the builder returns null rather than toasting into the wrong window',
         /function _buildPoolMaturityPDF\(d\) \{[\s\S]{0,400}return null;/.test(admin));
      ok('and the console loads both libraries',
         /jspdf\.umd\.min\.js/.test(fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8')) &&
         /jspdf\.plugin\.autotable/.test(fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8')));
    }

  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    if (srv) srv.close();
    if (pool) await pool.end().catch(() => {});
    /* The route module under test resolves db/pool at require time and opens
       its OWN pool against this database. Leaving it open makes the DROP below
       fail with "is being accessed by other users", which the .catch() then
       swallows — so the scratch database survives the run and check-run-checks
       reports it. Closing it here is what actually lets the drop succeed. */
    try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
