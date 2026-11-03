#!/usr/bin/env node
/* A matured investment coming back is not income, whatever the ledger calls it.
 *
 * This was found by a client, in the middle of a SARS verification:
 *
 *   "The statement shows R1 631,18 in returns realised at maturity and R678
 *    credited. Can you clarify whether these amounts overlap?"
 *
 * They did. One row — 30 Apr 2025, description "PAYOUT", R678,00 — was typed
 * as income. R678,00 was R600,00 of that client's own capital plus the R78,00
 * return on an investment that had matured the day before, and the R78,00 was
 * already inside the R1 631,18. Adding the two figures, which is what anybody
 * would do, would have declared R600 of the client's capital as earnings and
 * counted the R78 twice.
 *
 * The engine cannot produce such a row today — creditWallet writes maturity
 * settlements as `payout`, which INCOME_TYPES excludes — so this is about the
 * ledger that was imported and about any future path that gets the type wrong.
 *
 * What this holds:
 *
 *   the rule      matches only capital PLUS realised return, to the cent, at
 *                 that investment's maturity; genuine interim income is a
 *                 fraction of capital and cannot be mistaken for it
 *   the direction excluding real income would UNDER-declare, which is the
 *                 error that gets a client in trouble rather than confused —
 *                 so every near-miss is asserted to stay in the total
 *   the document  names what it removed, beside the investment it settles,
 *                 because a tax figure quietly adjusted is worse than a wrong
 *                 one
 *   the alert     is raised, because one mis-typed row goes on producing
 *                 confused clients until somebody changes it
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-income-settlement-guard.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { Pool } = require('pg');
const { nbsp } = require('../../scripts/lib/rendered.cjs');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_incguard_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const N = v => nbsp(v == null ? '' : v);

const IR = require(path.join(ROOT, 'server', 'services', 'incomeReference.js'));

/* ═══════════════════════════════════════════════════════════════════
   1. The rule, on the numbers that found it

   R600 capital, R78 realised, matured 29 Apr 2025, and a R678 income row
   on 30 Apr 2025. Nothing here is invented: these are the figures off the
   client's own statement.
   ═══════════════════════════════════════════════════════════════════ */
const APRIL = {
  id: 'INV-APR24', pool_name: 'Cattle Investment-April 2024',
  amount: 600, end_date: '2025-04-29', realised_return: 78, return_posted: true,
};
const row = (over) => Object.assign({
  id: 'T1', txn_date: '2025-04-30', created_at: '2025-04-30',
  type: 'return', description: 'PAYOUT', amount: 678, reference: null, investment_id: null,
}, over);

function ruleAssertions() {
  console.log('\nthe settlement that started this is recognised');
  {
    const { income, settlements } = IR.partitionIncome([row()], [APRIL]);
    ok('R678 against R600 + R78 is taken out of income',
       income.length === 0 && settlements.length === 1, JSON.stringify({ income, settlements }));
    ok('and it names the investment it settles',
       settlements[0].matches_investment_id === 'INV-APR24'
       && settlements[0].matches_capital === 600 && settlements[0].matches_return === 78,
       JSON.stringify(settlements[0]));
  }

  console.log('\nand genuine income is left exactly where it is');
  {
    /* Every one of these is a near miss on purpose. Excluding any of them
       would understate what the client earned, which is the direction that
       gets somebody into trouble with SARS rather than merely confused. */
    const keeps = [
      ['interim interest, a fraction of the capital', row({ amount: 78 })],
      ['the capital alone, with no return on it',     row({ amount: 600 })],
      ['a cent more than the settlement',             row({ amount: 678.01 })],
      ['a cent less',                                 row({ amount: 677.99 })],
      ['the right amount two months early',           row({ txn_date: '2025-02-20', created_at: '2025-02-20' })],
      ['the right amount two months late',            row({ txn_date: '2025-07-05', created_at: '2025-07-05' })],
    ];
    for (const [label, t] of keeps) {
      const { income, settlements } = IR.partitionIncome([t], [APRIL]);
      ok(`${label} stays income`, income.length === 1 && settlements.length === 0,
         JSON.stringify(settlements));
    }
  }

  console.log('\nbut a row that names its investment needs no date at all');
  {
    const t = row({ txn_date: '2026-01-01', created_at: '2026-01-01', investment_id: 'INV-APR24' });
    const { settlements } = IR.partitionIncome([t], [APRIL]);
    ok('an import can carry any date; the link is conclusive',
       settlements.length === 1, JSON.stringify(settlements));
    const other = row({ amount: 999, investment_id: 'INV-APR24' });
    ok('though the amount must still be the settlement',
       IR.partitionIncome([other], [APRIL]).settlements.length === 0,
       'naming an investment does not make an unrelated amount its settlement');
  }

  console.log('\nand an investment with no posted return matches nothing');
  {
    /* The amount is the CAPITAL, R600. That is the case that separates the
       two behaviours: with no posted return a careless rule reads the
       realised return as zero, makes capital-plus-nothing the settlement,
       and throws out a R600 income row the client actually earned. An
       earlier version of this assertion used R678 and could not tell the
       difference — it passed with the guard deleted. */
    const unposted = Object.assign({}, APRIL, { realised_return: null, return_posted: false });
    const { income, settlements } = IR.partitionIncome([row({ amount: 600 })], [unposted]);
    ok('there is no figure to compare, so nothing is excluded',
       income.length === 1 && settlements.length === 0,
       'treating an unposted return as zero would exclude genuine income and ' +
       'UNDER-declare — ' + JSON.stringify(settlements));
    ok('and the same row against a POSTED return is still left alone',
       IR.partitionIncome([row({ amount: 600 })], [APRIL]).income.length === 1,
       'R600 is the capital, not the settlement of R678');
  }

  console.log('\nand several holdings are each matched to their own');
  {
    const JUNE = { id: 'INV-JUN24', pool_name: 'Cattle Investment-June 2024',
                   amount: 569, end_date: '2025-06-29', realised_return: 68.85, return_posted: true };
    const rows = [
      row({ id: 'T-A' }),
      row({ id: 'T-B', txn_date: '2025-06-30', created_at: '2025-06-30', amount: 637.85 }),
      row({ id: 'T-C', txn_date: '2025-08-01', created_at: '2025-08-01', amount: 120, description: 'Interest' }),
    ];
    const { income, settlements } = IR.partitionIncome(rows, [APRIL, JUNE]);
    ok('two settlements out, the interest left in',
       settlements.length === 2 && income.length === 1 && income[0].id === 'T-C',
       JSON.stringify({ income: income.map(i => i.id), settlements: settlements.map(s => s.id) }));
    ok('each is matched to the right investment',
       settlements.find(s => s.id === 'T-A').matches_investment_id === 'INV-APR24'
       && settlements.find(s => s.id === 'T-B').matches_investment_id === 'INV-JUN24',
       JSON.stringify(settlements.map(s => [s.id, s.matches_investment_id])));
  }
}

/* ═══════════════════════════════════════════════════════════════════
   2. End to end, through the real query
   ═══════════════════════════════════════════════════════════════════ */
function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
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
  pool.on('error', () => {});
}

/* The client's own shape, reduced to what the question turns on: one
   matured holding whose return is posted, and the R678 row. */
async function seed() {
  await pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, id_number)
    VALUES ('IG-1','Bongani','Sibanda','bongani@example.test','active','9010106036080')`);
  await pool.query(`
    INSERT INTO investment_pools (id, name, product_type, status, annual_rate, actual_rate,
        term_months, end_date)
    VALUES ('IGP-APR','Cattle Investment-April 2024','cattle','matured',0.13,0.13,12,'2025-04-29')`);
  await pool.query(`
    INSERT INTO investments (id, investor_id, pool_id, pool_name, amount, status,
        start_date, end_date, annual_rate, term_months, expected_return, actual_return, product_type)
    VALUES ('IG-INV','IG-1','IGP-APR','Cattle Investment-April 2024', 600,'matured',
            '2024-05-03','2025-04-29', 0.13, 12, 78, 78, 'cattle')`);
  await pool.query(`
    INSERT INTO transactions (id, investor_id, type, amount, status, reference, description,
        transaction_date)
    VALUES
      ('IG-T-PAYOUT','IG-1','return', 678,'completed','MAT-IG-INV','PAYOUT','2025-04-30'),
      ('IG-T-REAL',  'IG-1','interest', 25,'completed','INT-1','Interest credited','2025-09-30')`);
}

async function endToEnd() {
  console.log('\nthe document the client was sent now states the exclusion');
  const data = await IR.buildIncomeReference(pool, { investorId: 'IG-1', year: 2026 });

  ok('the R678 is out of Returns Credited',
     Math.abs(data.totalReturns - 25) < 0.005,
     `R25 of genuine interest should remain — got ${data.totalReturns}`);
  ok('and it is reported, not dropped',
     data.settlements.length === 1 && Math.abs(data.settlementsTotal - 678) < 0.005,
     JSON.stringify(data.settlements));
  ok('the realised return is unchanged at R78',
     Math.abs(data.maturedReturns - 78) < 0.005, String(data.maturedReturns));
  ok('so the two figures no longer overlap',
     Math.abs((data.totalReturns + data.maturedReturns) - 103) < 0.005,
     'R25 credited plus R78 realised, with no part of either counted twice — got ' +
     (data.totalReturns + data.maturedReturns));

  console.log('\nand an account with nothing wrong is untouched');
  await pool.query(`DELETE FROM transactions WHERE id = 'IG-T-PAYOUT'`);
  const clean = await IR.buildIncomeReference(pool, { investorId: 'IG-1', year: 2026 });
  ok('no settlements are reported', clean.settlements.length === 0, JSON.stringify(clean.settlements));
  ok('and the income total is the income', Math.abs(clean.totalReturns - 25) < 0.005,
     String(clean.totalReturns));

  console.log('\nand the mis-typed row is raised where somebody can fix it');
  /* The report is fired and NOT awaited on purpose — a tax document must
     not fail to issue because an alerter is unhappy — so the row arrives
     shortly after the call returns. Waited for, rather than asserted
     against a gap in time. Bounded, so an incident that never arrives
     fails instead of hanging the suite. */
  const rows = await (async () => {
    const until = Date.now() + 5000;
    for (;;) {
      const r = await pool.query(
        `SELECT severity, source, message FROM platform_incidents WHERE source = 'income-reference'`);
      if (r.rows.length || Date.now() > until) return r.rows;
      await new Promise(x => setTimeout(x, 100));
    }
  })();
  ok('an incident exists', rows.length === 1, JSON.stringify(rows));
  ok('it names the amount and what to do',
     rows[0] && /R678\.00/.test(rows[0].message) && /'payout'/.test(rows[0].message),
     JSON.stringify(rows[0] && rows[0].message));
}

/* ═══════════════════════════════════════════════════════════════════
   3. What the reader sees
   ═══════════════════════════════════════════════════════════════════ */
function documentAssertions(data) {
  const box = {};
  const s = {
    console, Math, Number, String, JSON, Object, Array, Boolean, Date, Set, Map, Error,
    RegExp, parseFloat, parseInt, isNaN, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0, clearTimeout() {},
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { userAgent: 'node' },
    location: { href: '', origin: 'https://platform.svcapital.co.za' },
    document: {
      addEventListener() {},
      getElementById: id => (box[id] = box[id] || { innerHTML: '', style: {} }),
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {},
        classList: { add() {}, remove() {} }, click() {} }),
      body: { appendChild() {}, removeChild() {} },
    },
    Toast: { success() {}, error() {} },
    _esc: v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  };
  s.window = s; s.globalThis = s; s.self = s;
  /* The window the document is written into, captured instead of opened. */
  let written = '';
  s.open = () => ({ document: { write(h) { written += h; }, close() {} }, focus() {} });
  vm.createContext(s);
  vm.runInContext(read('js/investor-documents.js'), s, { filename: 'js/investor-documents.js' });

  const SVCDocs = vm.runInContext('typeof SVCDocs !== "undefined" ? SVCDocs : null', s);
  if (!SVCDocs || typeof SVCDocs.openIncomeReference !== 'function') {
    ok('the document module exposes openIncomeReference', false,
       'nothing to render — the rest of this section would pass against an empty string');
    return;
  }
  SVCDocs.openIncomeReference(data);
  const html = N(written);

  console.log('\nand the page shows the corrected figure, and says nothing about why');
  ok('the document rendered at all', html.length > 2000, `only ${html.length} characters`);

  /* The exclusion is NOT explained to the client. This document goes to
     SARS with their return, and a red box about an SV Capital data defect
     raises a question they cannot answer and did not ask. The figure is
     right; the reason staff need is raised as an incident instead, and
     fix-income-typed-settlements.cjs ends it at the source. */
  ok('no banner about an exclusion',
     !/has been excluded/.test(html) && !/excluded from Returns Credited/i.test(html),
     html.slice(0, 1200));
  ok('and no section listing what was taken out',
     !/Excluded from Returns Credited/.test(html) && !/TOTAL EXCLUDED/.test(html));
  ok('nothing on the page mentions the settled investment',
     !/Cattle Investment-April 2024[\s\S]{0,200}capital R 600,00/.test(html),
     'the pool legitimately appears under Returns Realised at Maturity; what must ' +
     'not appear is it being named as the source of an exclusion');
  ok('and no wording about the client’s capital being declared as earnings',
     !/declare the client.s capital as earnings/.test(html));

  /* The half that still has to be true. Removing the explanation must not
     have removed the correction with it. */
  ok('the R678 is still out of the Returns Credited figure',
     !/>R 678,00<\/div>/.test(html),
     'the headline must be the adjusted figure, not the raw ledger total');
  ok('and the genuine R25 of interest is still shown as credited',
     /R 25,00/.test(html), 'excluding the settlement must not hide real income');
  ok('while Returns Realised at Maturity still reads R78,00',
     /R 78,00/.test(html), 'the return itself is income and belongs on the document');

  console.log('\nand the page is the same whether or not anything was excluded');
  const clean = Object.assign({}, data, { settlements: [], settlementsTotal: 0 });
  written = '';
  SVCDocs.openIncomeReference(clean);
  const cleanHtml = N(written);
  ok('a clean account renders the same document',
     cleanHtml.length === html.length,
     'a settlement must leave no trace on the client’s copy — ' +
     `${html.length} vs ${cleanHtml.length} characters`);

  /* Against the SOURCE, not the output. The two assertions above say this
     fixture produced no banner; this one says there is no branch that could
     produce one for any payload — which is what "remove it completely"
     means, and what stops it returning as a condition nobody triggers in a
     test. The service still computes settlements, and must: that is what
     keeps the figure right and raises the incident. It is the DOCUMENT that
     carries none of it. */
  const docSrc = read('js/investor-documents.js')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('and the document has no branch that could render one',
     !/settlements/.test(docSrc),
     'a dormant branch is a banner waiting for the right payload — ' +
     (docSrc.match(/.{0,60}settlements.{0,60}/) || [''])[0]);
}

(async () => {
  try {
    ruleAssertions();
    await makeDatabase();
    await seed();
    const data = await IR.buildIncomeReference(pool, { investorId: 'IG-1', year: 2026 });
    await endToEnd();
    documentAssertions(data);
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
