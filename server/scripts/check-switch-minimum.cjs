#!/usr/bin/env node
/* A maturity cannot be switched into a product that will not take the amount.
 *
 * The destination list in the maturity form was every product that had a pool
 * ROW. Two things followed, and a client met neither of them until the money
 * had already moved:
 *
 *   · A product whose last pool CLOSED months ago was offered as somewhere to
 *     put money — while the option's own note claimed nothing else was open.
 *
 *   · A pool's MINIMUM was never consulted. A client with R2 000 maturing was
 *     shown a product that will not take less than R10 000. They chose it, the
 *     instruction saved without complaint, and at maturity the engine put the
 *     money wherever it could — not where they had asked.
 *
 * A minimum belongs to the POOL, which CLAUDE.md is explicit about and which
 * matters here because a product's own min_investment and its pools' drift
 * apart. So a product's minimum is its CHEAPEST OPEN POOL: the cheapest thing
 * that can be bought today.
 *
 * What this holds:
 *
 *   the form      lists only destinations the amount can actually reach, and
 *                 says what the next one up costs rather than leaving a short
 *                 list looking like a fault
 *   the amount    is what goes INTO the new product, never the gross payout —
 *                 the whole payout on switch_product, the remainder on
 *                 custom_switch, and the NAMED amount on switch_amount
 *   the pool form is cleared by the SMALLEST holding, because one instruction
 *                 is applied to each investment separately and so is the cash
 *   the route     refuses what the form would not have offered, for clients;
 *                 staff keep the override, like the 17:00 cutoff
 *
 * NOT asserted, because it is not built: the engine still does not consult
 * the minimum when it places the money. reinvestAmount takes the first open
 * pool by end_date and writes the investment whatever the amount, so an
 * instruction valid when saved can still land below a minimum. That is a
 * change to what happens to a client's money at maturity and wants its own
 * decision; server/services/switchMinimum.js says so at the top.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-switch-minimum.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const http = require('http');
const vm   = require('vm');
const { Pool } = require('pg');
const { nbsp } = require('../../scripts/lib/rendered.cjs');

const ROOT = path.join(__dirname, '..', '..');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* Every amount here is formatted with toLocaleString('en-ZA'), whose group
   separator is a NON-BREAKING space. Normalise once at the boundary so the
   patterns below can be written with ordinary spaces — scripts/lib/rendered.cjs
   explains the generation of assertions that were written against a comma. */
const N = v => nbsp(v == null ? '' : v);

const sm = require(path.join(ROOT, 'server', 'services', 'switchMinimum.js'));

function isScratchDatabase(url) {
  const n = (String(url).split('?')[0].split('/').pop() || '').toLowerCase();
  return /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(n) || /^svctest/.test(n);
}
async function ensureSchema() {
  const { rows } = await db.query(
    `SELECT bool_and(to_regclass('public.' || t) IS NOT NULL) AS ready FROM unnest($1::text[]) AS t`,
    [['investors', 'investments', 'investment_pools']]);
  if (rows[0].ready) return true;
  if (!isScratchDatabase(process.env.DATABASE_URL) && process.env.CHECK_ALLOW_RESET !== '1') {
    console.log('  SKIP  incomplete schema and this is not a scratch database.');
    return false;
  }
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  return true;
}

/* ═══════════════════════════════════════════════════════════════════
   1. Which leg the minimum is tested against

   The three switching instructions send three different amounts into the new
   product, and reading any of them as "the payout" tests the wrong figure
   against the threshold. switch_amount is the one that inverts: the named
   amount is what SWITCHES and the balance stays where it is, so subtracting
   it — as custom_switch does — would gate the switch on the leg that is not
   switching.
   ═══════════════════════════════════════════════════════════════════ */
function pureFunctionAssertions() {
  console.log('\nthe minimum is tested against what actually goes into the product');

  // R10,000 capital with R1,500 declared = R11,500 to work with.
  const inv = { amount: 10000, actual_return: 1500 };

  ok('switch_product sends the whole payout',
     sm.amountSwitched(inv, 'switch_product', null) === 11500,
     String(sm.amountSwitched(inv, 'switch_product', null)));
  ok('custom_switch sends what is left after the client’s cash',
     sm.amountSwitched(inv, 'custom_switch', 9000) === 2500,
     String(sm.amountSwitched(inv, 'custom_switch', 9000)));
  ok('switch_amount sends the NAMED amount, not the remainder',
     sm.amountSwitched(inv, 'switch_amount', 2000) === 2000,
     'subtracting it would gate the switch on the leg that is reinvested, ' +
     'not the one being switched — got ' + sm.amountSwitched(inv, 'switch_amount', 2000));
  ok('a cash figure larger than the investment cannot make the remainder negative',
     sm.amountSwitched(inv, 'custom_switch', 99999) === 0,
     String(sm.amountSwitched(inv, 'custom_switch', 99999)));

  console.log('\nand the value is what has been declared, never a benchmark');
  ok('a declared return counts', sm.investmentValue(inv) === 11500);
  ok('an expected return does not',
     sm.investmentValue({ amount: 10000, expected_return: 4000 }) === 10000,
     'the portal caps the cash payout with the declared figure; a filter using ' +
     'a more generous one offers a destination the cap will not fund');
  ok('nothing posted yet is the capital alone',
     sm.investmentValue({ amount: 10000, actual_return: 0 }) === 10000);

  /* The third source, and the one a narrower reading misses. The portal's
     Utils.postedReturn falls back to the rate posted on the POOL when the
     investment row has no amount on it yet, so a server rule that did not
     would refuse a destination the form had just offered. */
  ok('a rate posted on the pool counts, as it does in the portal',
     sm.investmentValue({ amount: 10000, actual_return: 0 }, 0.10) === 11000,
     String(sm.investmentValue({ amount: 10000, actual_return: 0 }, 0.10)));
  ok('and a rate on the row itself wins over one passed in',
     sm.investmentValue({ amount: 10000, actual_return: 0, pool_actual_rate: 0.2 }, 0.10) === 12000,
     String(sm.investmentValue({ amount: 10000, actual_return: 0, pool_actual_rate: 0.2 }, 0.10)));
  ok('a declared amount still beats any rate',
     sm.investmentValue({ amount: 10000, actual_return: 1500, pool_actual_rate: 0.9 }, 0.9) === 11500);
}

/* ═══════════════════════════════════════════════════════════════════
   2. The rule against real pools
   ═══════════════════════════════════════════════════════════════════ */
const wipe = async () => {
  await db.query(`DELETE FROM investments      WHERE investor_id LIKE 'SM-%'`);
  await db.query(`DELETE FROM investment_pools WHERE id LIKE 'SMP-%'`);
  await db.query(`DELETE FROM investors        WHERE id LIKE 'SM-%'`);
};

/* One client holding a maturing cattle investment, and three destinations:
   solar is cheap, wind is dear, and wood has nothing a client can buy. */
async function seed() {
  await wipe();
  await db.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
    VALUES ('SM-A','Lerato','Mokoena','lerato@example.test','active', 0)`);

  await db.query(`
    INSERT INTO investment_pools (id, name, product_type, status, end_date, annual_rate, term_months, min_investment)
    VALUES
      ('SMP-SOL-A','Solar — cheap seat','solar','open',  CURRENT_DATE + 30, 0.12, 6,  1000),
      ('SMP-SOL-B','Solar — dearer seat','solar','open', CURRENT_DATE + 60, 0.13, 12, 7500),
      ('SMP-WIND', 'Wind','wind','open',                 CURRENT_DATE + 30, 0.14, 12, 50000),
      ('SMP-BIO',  'Biogas','biogas','open',             CURRENT_DATE + 30, 0.11, 6,  10000),
      ('SMP-WOOD-OLD','Wood — closed last month','wood','open', CURRENT_DATE - 20, 0.11, 6, 500)`);

  // The maturing pool, with its rate posted so the value is known.
  await db.query(`
    INSERT INTO investment_pools (id, name, product_type, status, end_date, annual_rate, actual_rate, term_months)
    VALUES ('SMP-OLD','Cattle 2025','cattle','active', CURRENT_DATE + 10, 0.16, 0.10, 12)`);
  await db.query(`
    INSERT INTO investments (id, investor_id, pool_id, pool_name, amount, status, start_date, end_date,
        annual_rate, term_months, expected_return, actual_return, product_type)
    VALUES
      ('SM-BIG','SM-A','SMP-OLD','Cattle 2025', 10000,'active', CURRENT_DATE - 360, CURRENT_DATE + 10,
       0.16, 12, 1600, 1000, 'cattle'),
      ('SM-SMALL','SM-A','SMP-OLD','Cattle 2025', 1200,'active', CURRENT_DATE - 360, CURRENT_DATE + 10,
       0.16, 12, 192, 120, 'cattle')`);
}

async function ruleAssertions() {
  console.log('\na product’s minimum is its cheapest OPEN pool');
  ok('the cheaper of two open pools wins',
     await sm.cheapestOpenMinimum(db, 'solar') === 1000,
     'got ' + await sm.cheapestOpenMinimum(db, 'solar'));
  ok('a product with nothing open has no minimum, it has no seat',
     await sm.cheapestOpenMinimum(db, 'wood') === null,
     'a pool past its close date is not somewhere money can go — got ' +
     await sm.cheapestOpenMinimum(db, 'wood'));
  ok('and a product that never had a pool is the same answer',
     await sm.cheapestOpenMinimum(db, 'nothing_here') === null);

  console.log('\nand a full pool is not a seat either');
  await db.query(`UPDATE investment_pools SET max_investment = 1000000, current_invested = 1000000 WHERE id = 'SMP-SOL-A'`);
  ok('the cheap seat drops out once it is full, leaving the dearer one',
     await sm.cheapestOpenMinimum(db, 'solar') === 7500,
     'got ' + await sm.cheapestOpenMinimum(db, 'solar'));
  await db.query(`UPDATE investment_pools SET max_investment = NULL, current_invested = 0 WHERE id = 'SMP-SOL-A'`);

  console.log('\nso the refusal follows the amount, not the client’s total holding');
  const big   = { amount: 10000, actual_return: 1000 };   // R11,000
  const small = { amount: 1200,  actual_return: 120  };   // R1,320

  ok('R11,000 may switch into solar', !await sm.switchRefusal(db, big, 'switch_product', 'solar', null));
  const windRefusal = N(await sm.switchRefusal(db, big, 'switch_product', 'wind', null));
  ok('R11,000 may NOT switch into wind',
     /will not take less than R50 000,00/.test(windRefusal), JSON.stringify(windRefusal));
  ok('the refusal names both figures, so the client is not left guessing',
     /R11 000,00/.test(windRefusal), JSON.stringify(windRefusal));
  ok('R1,320 may still switch into solar’s cheap seat',
     !await sm.switchRefusal(db, small, 'switch_product', 'solar', null));
  ok('a product with nothing open is refused with a different reason',
     /no open pool/.test(await sm.switchRefusal(db, big, 'switch_product', 'wood', null) || ''),
     JSON.stringify(await sm.switchRefusal(db, big, 'switch_product', 'wood', null)));

  console.log('\nthe cash the client takes is what shrinks the remainder');
  ok('R11,000 less R10,500 cash cannot reach solar’s R1,000',
     /R500,00 would be switched/.test(N(await sm.switchRefusal(db, big, 'custom_switch', 'solar', 10500)))
     && /will not take less than R1 000,00/.test(N(await sm.switchRefusal(db, big, 'custom_switch', 'solar', 10500))),
     JSON.stringify(N(await sm.switchRefusal(db, big, 'custom_switch', 'solar', 10500))));
  ok('but R11,000 less R500 cash still can',
     !await sm.switchRefusal(db, big, 'custom_switch', 'solar', 500));
  /* The cent of tolerance, tested on the artefact it exists for rather than
     on a round number that would pass without it.

     R8 333,33 at a posted 20% is 9999.996 in binary floating point. The
     client is shown R10 000,00 and the pool's minimum IS R10 000, so
     refusing them would be refusing a minimum they visibly meet. */
  ok('a minimum met to the cent is allowed, not lost to a floating-point artefact',
     !await sm.switchRefusal(db, { amount: 8333.33, actual_return: 0, pool_actual_rate: 0.20 },
                             'switch_product', 'biogas', null),
     'value computes to ' + sm.investmentValue({ amount: 8333.33, actual_return: 0, pool_actual_rate: 0.20 }) +
     ' against a R10 000 minimum');
  ok('and a cent genuinely short is still refused',
     /will not take less than R10 000,00/.test(
       N(await sm.switchRefusal(db, { amount: 9998, actual_return: 0 }, 'switch_product', 'biogas', null))),
     'the tolerance is a rounding allowance, not a discount');

  console.log('\nand a pool of investments is cleared by the SMALLEST of them');
  const set = [big, small];
  ok('both together are allowed while the R1 000 seat is open',
     !await sm.switchRefusalForSet(db, set, 'switch_product', 'solar', null));
  await db.query(`UPDATE investment_pools SET end_date = CURRENT_DATE - 1 WHERE id = 'SMP-SOL-A'`);
  {
    const refusal = N(await sm.switchRefusalForSet(db, set, 'switch_product', 'solar', null));
    ok('with only the R7,500 seat open, R12,320 between them does not buy a seat for the R1,320 one',
       /R1 320,00/.test(refusal || '') && /R7 500,00/.test(refusal || ''),
       JSON.stringify(refusal));
    ok('and the error says the amount applies to each investment separately',
       /each investment separately/.test(refusal || ''),
       'that per-investment behaviour is why the number looked reasonable');
    ok('the big one on its own is still allowed',
       !await sm.switchRefusalForSet(db, [big], 'switch_product', 'solar', null));
  }
  await db.query(`UPDATE investment_pools SET end_date = CURRENT_DATE + 30 WHERE id = 'SMP-SOL-A'`);

  console.log('\nand an instruction that moves no money into a product is not this rule’s business');
  ok('payout_all is never refused here', !await sm.switchRefusal(db, small, 'payout_all', 'wind', null));
  ok('reinvest is never refused here',   !await sm.switchRefusal(db, small, 'reinvest',   'wind', null));
}

/* ═══════════════════════════════════════════════════════════════════
   3. The route, over HTTP

   The service holds the rule; this is about who it binds. A client is
   refused. Staff acting on a client's behalf are not — they may know what
   the threshold does not, which is the division the 17:00 cutoff already
   makes and the opposite of the payout-only refusal, which binds everyone
   because it is about what a contract can carry.
   ═══════════════════════════════════════════════════════════════════ */
async function routeAssertions() {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
  const jwt     = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
  const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
  const app = express();
  app.use(express.json());
  app.use('/api/investments', require(path.join(ROOT, 'server', 'routes', 'investments.js')));
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });

  const tok = (role, investorId) => jwt.sign({ id: 'u-1', role, investorId, email: 'x@example.test' },
                                             process.env.JWT_SECRET, { expiresIn: '1h' });
  const call = (p, token, body) => new Promise(res => {
    const payload = Buffer.from(JSON.stringify(body));
    const r = http.request({ port: srv.address().port, path: p, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
                 'Content-Length': payload.length } },
      x => { let s = ''; x.on('data', c => s += c);
             x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s || '{}') })); });
    r.write(payload); r.end();
  });

  const stored = async id => (await db.query(
    `SELECT maturity_instruction, switch_product_type FROM investments WHERE id = $1`, [id])).rows[0];

  try {
    console.log('\nthe route refuses what the form would not have offered');
    const client = tok('investor', 'SM-A');
    {
      const r = await call('/api/investments/SM-BIG/instruction', client,
        { instruction: 'switch_product', switch_product_type: 'wind' });
      ok('a client is refused a product below whose minimum they fall',
         r.status === 400 && r.body.code === 'SWITCH_BELOW_MINIMUM',
         JSON.stringify(r));
      const row = await stored('SM-BIG');
      ok('and nothing was written',
         !row.maturity_instruction && !row.switch_product_type, JSON.stringify(row));
    }
    {
      const r = await call('/api/investments/SM-BIG/instruction', client,
        { instruction: 'switch_product', switch_product_type: 'solar' });
      ok('the same client may switch into a product they can afford', r.status === 200, JSON.stringify(r));
      const row = await stored('SM-BIG');
      ok('and that one IS written', row.switch_product_type === 'solar', JSON.stringify(row));
    }
    {
      const r = await call('/api/investments/SM-BIG/instruction', client,
        { instruction: 'switch_product', switch_product_type: 'wood' });
      ok('a product with no open pool is refused too',
         r.status === 400 && /no open pool/.test(r.body.error || ''), JSON.stringify(r));
    }

    console.log('\nbut staff keep the override, as they do for the cutoff');
    {
      const r = await call('/api/investments/SM-BIG/instruction', tok('admin', null),
        { instruction: 'switch_product', switch_product_type: 'wind' });
      ok('staff may set a switch the client could not', r.status === 200, JSON.stringify(r));
      const row = await stored('SM-BIG');
      ok('and it is stored as given', row.switch_product_type === 'wind', JSON.stringify(row));
    }

    console.log('\nand a pool-wide instruction is held to the smallest investment in it');
    await db.query(`UPDATE investment_pools SET end_date = CURRENT_DATE - 1 WHERE id = 'SMP-SOL-A'`);
    await db.query(`UPDATE investments SET maturity_instruction = NULL, switch_product_type = NULL WHERE investor_id = 'SM-A'`);
    {
      const r = await call('/api/investments/pool/SMP-OLD/instruction', tok('investor', 'SM-A'),
        { instruction: 'switch_product', switch_product_type: 'solar' });
      ok('refused, because one of the two cannot meet it',
         r.status === 400 && r.body.code === 'SWITCH_BELOW_MINIMUM', JSON.stringify(r));
      const rows = await db.query(
        `SELECT count(*) FILTER (WHERE maturity_instruction IS NOT NULL) AS set_count
           FROM investments WHERE investor_id = 'SM-A'`);
      ok('and NEITHER was written — all or nothing, as the route promises',
         Number(rows.rows[0].set_count) === 0, JSON.stringify(rows.rows[0]));
    }
    await db.query(`UPDATE investment_pools SET end_date = CURRENT_DATE + 30 WHERE id = 'SMP-SOL-A'`);
    {
      const r = await call('/api/investments/pool/SMP-OLD/instruction', tok('investor', 'SM-A'),
        { instruction: 'switch_product', switch_product_type: 'solar' });
      ok('with the cheap seat back, both are set at once',
         r.status === 200 && r.body.updated === 2, JSON.stringify(r));
    }
  } finally {
    srv.close();
  }
}

/* ═══════════════════════════════════════════════════════════════════
   4. What the client actually sees

   The real openMaturityModal, run against a stub DOM, because the
   requirement is about what renders — not about a function that could be
   called to produce it.
   ═══════════════════════════════════════════════════════════════════ */
function formAssertions() {
  const box = {};
  const sent = { calls: [], toast: null };
  /* One element shape, handed out by both getElementById and createElement.
     addEventListener keeps the handler so a check can fire it the way the
     browser would. */
  const mkEl = () => ({
    innerHTML: '', style: {}, value: '', textContent: '', dataset: {}, className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(ev, fn) { (this._on = this._on || {})[ev] = fn; },
    removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
    appendChild() {}, removeChild() {}, remove() {}, append() {}, prepend() {},
    insertAdjacentHTML() {}, insertBefore() {}, replaceChildren() {},
    focus() {}, closest: () => null, scrollIntoView() {}, firstChild: null,
  });
  const s = {
    console, JSON, Math, Date, Number, String, Object, Array, Boolean, Set, Map, Error,
    RegExp, parseFloat, parseInt, isNaN, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, location: { href: '', origin: 'http://x' },
    fetch: () => Promise.reject(new Error('no network')),
    document: {
      addEventListener() {}, removeEventListener() {},
      body: { style: {}, classList: { add() {}, remove() {} }, appendChild() {}, removeChild() {} },
      activeElement: null,
      querySelector: () => null, querySelectorAll: () => [],
      /* submitMaturityInstruction runs to completion on the happy path, and
         js/api.js's real Toast — a lexical const this check cannot replace —
         builds itself a container out of createElement. So the element this
         returns has to be as complete as the ones getElementById hands back,
         or the guard is exercised only as far as the first toast. */
      createElement: () => mkEl(),
      getElementById: id => (box[id] = box[id] || mkEl()),
    },
    Modal: { open() {}, close() {} },
    Toast: { success() {}, error(m) { sent.toast = m; } },
    API: { _fetch: (m, p, b) => { sent.calls.push([m, p, b]); return Promise.resolve({}); } },
    SVC: { track() {} },
    _withBtn: (b, f) => f && f(),
  };
  s.window = s; s.globalThis = s; s.self = s;
  vm.createContext(s);
  vm.runInContext(read('js/api.js'), s, { filename: 'js/api.js' });
  vm.runInContext(
    'var PORTAL = { investments: [], pools: [], transactions: [] };' +
    'var _mktProducts = [];' +
    "var _esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')" +
    ".replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');", s);
  vm.runInContext(read('js/portal-core.js'), s, { filename: 'js/portal-core.js' });
  vm.runInContext('function loadPortalData(){return Promise.resolve();}' +
                  'function loadMaturity(){}', s);
  /* js/api.js declares API, Toast and Modal as lexical `const`s, so the
     sandbox properties set above are SHADOWED once it loads — an API stub
     that is never consulted makes "the request was not made" pass whether
     the guard fired or not. Reach the real objects inside the context and
     replace the three methods this check cares about. */
  s.__sent = sent;
  vm.runInContext(
    'API._fetch = (m, p, b) => { __sent.calls.push([m, p, b]); return Promise.resolve({}); };' +
    'Toast.error = m => { __sent.toast = String(m); };' +
    'Toast.success = () => {};' +
    'Modal.open = () => {}; Modal.close = () => {};', s);

  /* Only the destination select. The instruction dropdown above it also holds
     <option> elements, and counting those as products would report a list of
     one product as a list of six. */
  const destinations = html => {
    const at = html.indexOf('id="matSwitchProductType"');
    if (at < 0) return null;
    const end = html.indexOf('</select>', at);
    return [...html.slice(at, end).matchAll(/<option value="([a-z_]*)"/g)].map(m => m[1]).filter(Boolean);
  };

  /* Cheap solar at R1,000, dear wind at R50,000, and a wood pool that closed
     last month. Mirrors the database fixture above on purpose: the form and
     the route must agree about what is on offer. */
  const POOLS = [
    { id: 'P-SOL', product_type: 'solar', status: 'open',     min_investment: 1000,  end_date: '2099-01-01' },
    { id: 'P-WND', product_type: 'wind',  status: 'open',     min_investment: 50000, end_date: '2099-01-01' },
    { id: 'P-WUD', product_type: 'wood',  status: 'open',     min_investment: 500,   end_date: '2020-01-01' },
    { id: 'P-WLT', product_type: 'hydro', status: 'waitlist', min_investment: 100,   end_date: '2099-01-01' },
    { id: 'P-CAT', product_type: 'cattle', status: 'open',    min_investment: 100,   end_date: '2099-01-01' },
  ];

  const render = async (amount, declared) => {
    box.maturityModalBody = { innerHTML: '', style: {} };
    const inv = {
      id: 'INV-1', pool_id: 'P-OLD', pool_name: 'Cattle 2025', investor_id: 'SM-A',
      amount, actual_return_amount: declared, status: 'active', product_type: 'cattle',
      maturity_instruction: '', maturity_date: '2099-12-31', end_date: '2099-12-31',
    };
    vm.runInContext('PORTAL.investments = ' + JSON.stringify([inv]) +
                    '; PORTAL.pools = ' + JSON.stringify(POOLS) + ';', s);
    await s.openMaturityModal('INV-1');
    return N(box.maturityModalBody.innerHTML);
  };

  return (async () => {
    console.log('\nthe client is offered only what their payout can buy');
    {
      const html = await render(10000, 1000);                // R11,000
      const d = destinations(html);
      ok('solar, at R1 000, is offered', (d || []).includes('solar'), JSON.stringify(d));
      ok('wind, at R50 000, is NOT offered', !(d || []).includes('wind'), JSON.stringify(d));
      ok('and the form says why the list is short, naming the next one up',
         /next starts at <strong>R 50 000,00/.test(html),
         'a select silently holding one of three products reads as a fault');
      ok('the minimum is printed beside each destination',
         /solar"[^>]*>[^<]*from R 1 000,00/.test(html), html.slice(html.indexOf('matSwitchProductType'), html.indexOf('matSwitchProductType') + 400));
    }
    {
      const d = destinations(await render(500, 0));           // R500, below everything
      ok('a payout below every minimum offers nothing at all',
         !(d || []).length, JSON.stringify(d));
    }
    {
      const html = await render(500, 0);
      ok('and the switch instruction itself is closed off rather than left as a dead end',
         /value="switch_product"[^>]*disabled/.test(html));
      ok('with the reason named in the option, not left to be guessed',
         /is below every other product’s minimum/.test(html),
         html.slice(html.indexOf('switch_product'), html.indexOf('switch_product') + 260));
      ok('and the panel states the smallest minimum open today',
         /smallest is <strong>R 1 000,00/.test(html));
    }

    console.log('\nand never something it could not place the money in');
    {
      const d = destinations(await render(10000, 1000));
      ok('a pool past its close date is not a destination', !(d || []).includes('wood'),
         'the engine will not place into it, so offering it is a promise we cannot keep');
      ok('a waitlist pool is not a destination either', !(d || []).includes('hydro'),
         JSON.stringify(d));
      ok('and the product the client already holds is not offered back to them',
         !(d || []).includes('cattle'), JSON.stringify(d));
    }

    /* ── And it follows the cash as the client types it ────────────────
       On Custom Switch the destination is bought with what is LEFT, so a
       list drawn once from the full payout keeps offering products the
       remainder can no longer reach. The handler the modal binds is called
       here the way the browser would call it. */
    console.log('\nand the list follows the cash the client takes, as they type it');
    {
      await render(10000, 1000);                            // R11,000 payout
      /* Through getElementById, not box directly: the stub creates an element
         the first time it is asked for, and the select is part of the body
         STRING until the repaint reaches for it. */
      const el    = id => s.document.getElementById(id);
      const cash  = el('matCustomAmount');
      const sel   = el('matSwitchProductType');
      const note  = el('matSwitchMinNote');
      ok('the modal binds a handler to the cash field at all',
         !!(cash && cash._on && cash._on.input),
         'without it the destinations never change once drawn');

      box.matInstructionType.value = 'custom_switch';
      cash.value = '10600';                                 // leaves R400
      cash._on.input();
      ok('taking R10 600 of R11 000 drops solar, which needs R1 000',
         !/value="solar"/.test(N(sel.innerHTML)), JSON.stringify(N(sel.innerHTML)));
      ok('and the panel says what the R400 remainder cannot reach',
         /smallest is <strong>R 1 000,00/.test(N(note.innerHTML)),
         JSON.stringify(N(note.innerHTML)));

      cash.value = '500';                                   // leaves R10,500
      cash._on.input();
      ok('taking only R500 brings solar back',
         /value="solar"/.test(N(sel.innerHTML)), JSON.stringify(N(sel.innerHTML)));
      ok('and wind, at R50 000, is still out of reach',
         !/value="wind"/.test(N(sel.innerHTML)), JSON.stringify(N(sel.innerHTML)));
    }

    /* ── And the submit refuses what a stale list still holds ──────────
       The list is filtered, so reaching submit with an unreachable product
       means the amount moved after it was drawn — a page left open while a
       return was revised, or a select the client never re-read. The guard is
       driven here with the select forced to a product the payout cannot buy,
       and the assertion is that NOTHING was sent. */
    console.log('\nand submitting a product the amount cannot buy sends nothing');
    {
      const html = await render(10000, 1000);               // R11,000
      void html;
      sent.calls.length = 0; sent.toast = null;
      const sel = s.document.getElementById('matSwitchProductType');
      /* _matSelectedProduct reads the selected OPTION, so the stub needs one. */
      sel.options = [{ value: 'wind', disabled: false }];
      sel.selectedIndex = 0;
      s.document.getElementById('matInstructionType').value = 'switch_product';

      await s.submitMaturityInstruction({ id: 'INV-1', amount: 10000, actual_return: 1000,
                                          product_type: 'cattle' });
      ok('the request is never made', sent.calls.length === 0, JSON.stringify(sent.calls));
      /* Utils.rand puts a space after the R; the server's own formatter does
         not. Both appear in this check, which is why each pattern is written
         against the formatter that produced the string. */
      ok('and the client is told both figures',
         /R 11 000,00/.test(N(sent.toast || '')) && /R 50 000,00/.test(N(sent.toast || '')),
         JSON.stringify(N(sent.toast)));

      /* The other half of the guard: a product that is not a candidate at all,
         because every pool it had has closed. A page left open across a pool
         cycle is exactly how this arrives. */
      sel.options = [{ value: 'wood', disabled: false }];
      sent.calls.length = 0; sent.toast = null;
      await s.submitMaturityInstruction({ id: 'INV-1', amount: 10000, actual_return: 1000,
                                          product_type: 'cattle' });
      ok('a product whose pools have all closed sends nothing either',
         sent.calls.length === 0, JSON.stringify(sent.calls));
      ok('and says so, rather than failing silently',
         /no longer has an open pool/.test(N(sent.toast || '')), JSON.stringify(N(sent.toast)));

      sel.options = [{ value: 'solar', disabled: false }];
      sent.calls.length = 0; sent.toast = null;
      await s.submitMaturityInstruction({ id: 'INV-1', amount: 10000, actual_return: 1000,
                                          product_type: 'cattle' });
      ok('a product the amount CAN buy is sent through',
         sent.calls.length === 1 && sent.calls[0][2].switch_product_type === 'solar',
         JSON.stringify(sent.calls));
    }

    console.log('\nthe pool-wide form is held to the smallest holding in it');
    {
      box.maturityModalBody = { innerHTML: '', style: {} };
      const mk = (id, amount) => ({
        id, pool_id: 'P-OLD', pool_name: 'Cattle 2025', investor_id: 'SM-A',
        amount, actual_return_amount: 0, status: 'active', product_type: 'cattle',
        maturity_instruction: '', maturity_date: '2099-12-31', end_date: '2099-12-31',
      });
      vm.runInContext('PORTAL.investments = ' + JSON.stringify([mk('I-BIG', 60000), mk('I-SMALL', 800)]) +
                      '; PORTAL.pools = ' + JSON.stringify(POOLS) + ';', s);
      await s.openPoolMaturityModal('P-OLD');
      const html = N(box.maturityModalBody.innerHTML);
      const d = destinations(html);
      ok('R60 800 between them does not offer solar, because R800 of it cannot reach R1 000',
         !(d || []).includes('solar'), JSON.stringify(d));
      /* Matched inside the destination panel's own note, not anywhere in the
         modal: the standing banner above already carries the phrase
         "per-investment instructions", so a loose test passes with the label
         deleted. */
      const noteAt = html.indexOf('id="matSwitchMinNote"');
      const note   = noteAt < 0 ? '' : html.slice(noteAt, html.indexOf('</div>', noteAt));
      ok('and the panel says the figure is per investment',
         /per investment/.test(note), JSON.stringify(note.slice(0, 300)));

      /* And its submit guard, which is the per-investment one applied to the
         smallest holding. Driven through the real function, not assumed to
         behave like its sibling. */
      const sel2 = s.document.getElementById('matSwitchProductType');
      sel2.options = [{ value: 'solar', disabled: false }];
      sel2.selectedIndex = 0;
      s.document.getElementById('matInstructionType').value = 'switch_product';
      sent.calls.length = 0; sent.toast = null;
      await s.submitPoolMaturityInstruction('P-OLD');
      ok('submitting it sends nothing, because the R800 holding cannot reach R1 000',
         sent.calls.length === 0, JSON.stringify(sent.calls));
      ok('and the message points at setting that one on its own',
         /Individual instructions/.test(N(sent.toast || '')), JSON.stringify(N(sent.toast)));
    }
  })();
}

(async () => {
  try {
    if (!await ensureSchema()) { await db.end(); process.exit(0); }
    pureFunctionAssertions();
    await seed();
    await ruleAssertions();
    await routeAssertions();
    await formAssertions();
    await wipe();
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
