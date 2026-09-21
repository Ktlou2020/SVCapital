#!/usr/bin/env node
/* An Ethical & Interest-Free investment is settled in cash at maturity, and
 * that is the only thing it can do.
 *
 * Each EIF pool is a discrete contract — a murabaha sale, an ijara lease, a
 * mudarabah venture — concluded when the underlying transaction concludes.
 * There is nothing to roll into. "Reinvest" on one of these would enter the
 * client into a NEW contract they never agreed to, which is precisely what
 * somebody who will not take riba came here to avoid. The portal offered it
 * anyway, and defaulted to it: an EIF holding left alone rolled over.
 *
 * Four places have to agree, or the rule is decorative:
 *
 *   the form      offers nothing else and preselects payout
 *   the route     refuses anything else, for staff as well as clients
 *   the engine    pays out whatever the column says
 *   the preview   predicts what the engine will do, not what the column says
 *
 * The client mirror (Utils.isPayoutOnlyProduct) and the server rule
 * (maturityPolicy.isPayoutOnlyProduct) are asserted to agree product by
 * product. A form that offers an option the server refuses is a dead end a
 * client cannot get out of; a form that hides one the server allows quietly
 * removes a choice they are entitled to.
 *
 * Run: node scripts/check-eif-payout-only.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── The two implementations, side by side ─────────────────────────────── */

const policy = require(path.join(ROOT, 'server', 'services', 'maturityPolicy.js'));

const sandbox = {
  window: {}, document: { addEventListener() {}, getElementById: () => null },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  console, fetch: () => Promise.reject(new Error('no network')),
  setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  navigator: { userAgent: 'node' }, location: { href: '', origin: '' },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('js/api.js'), sandbox, { filename: 'js/api.js' });
const Utils = vm.runInContext('typeof Utils !== "undefined" ? Utils : null', sandbox);
if (!Utils || typeof Utils.isPayoutOnlyProduct !== 'function') {
  console.error('Utils.isPayoutOnlyProduct is missing from js/api.js');
  process.exit(1);
}

/* Every product type the platform has ever shipped, plus the shapes that
   nearly match. `eif_sukuk` is not seeded today and that is the point: a
   fourth EIF structure must inherit the rule rather than default to
   reinvest, because the default is the failure that costs a client their
   compliance. */
const CASES = [
  ['eif_murabaha',   true],
  ['eif_ijara',      true],
  ['eif_mudarabah',  true],
  ['eif_sukuk',      true],   // does not exist yet — must still be covered
  ['EIF_MURABAHA',   true],   // case is not a promise anyone made
  ['eif',            true],
  ['cattle',         false],
  ['cattle_12j',     false],
  ['solar',          false],
  ['solar_5yr',      false],
  ['short_term',     false],
  ['smme',           false],
  ['delivery_bike',  false],
  ['delivery_bikes', false],
  ['ilobola',        false],
  ['gridfarmer',     false],
  ['eifx',           false],  // prefix without the separator is a DIFFERENT product
  ['notaneif_thing', false],
  ['',               false],
  [null,             false],
  [undefined,        false],
];

console.log('\nwhich products settle in cash');
for (const [pt, expected] of CASES) {
  ok(`${JSON.stringify(pt)} → ${expected ? 'payout only' : 'free to roll'}`,
     policy.isPayoutOnlyProduct(pt) === expected,
     `server said ${policy.isPayoutOnlyProduct(pt)}`);
}

console.log('\nand the portal agrees with the server, product by product');
for (const [pt] of CASES) {
  ok(`${JSON.stringify(pt)} reads the same on both sides`,
     Utils.isPayoutOnlyProduct(pt) === policy.isPayoutOnlyProduct(pt),
     `portal ${Utils.isPayoutOnlyProduct(pt)} vs server ${policy.isPayoutOnlyProduct(pt)}`);
}

/* ── What the engine will actually do ──────────────────────────────────── */

console.log('\nthe engine pays an EIF holding out, whatever its column says');
for (const stored of ['reinvest', 'payout_return', 'payout_custom', 'switch_product',
                      'custom_switch', 'switch_amount', 'pending', '', null]) {
  ok(`stored ${JSON.stringify(stored)} → payout_all`,
     policy.effectiveInstruction(stored, 'eif_ijara') === 'payout_all',
     policy.effectiveInstruction(stored, 'eif_ijara'));
}

console.log('\nwithout disturbing what every other product does');
ok('cattle on reinvest still reinvests',
   policy.effectiveInstruction('reinvest', 'cattle') === 'reinvest');
ok('cattle with nothing set still reinvests (the platform default)',
   policy.effectiveInstruction(null, 'cattle') === 'reinvest');
ok('cattle on payout_return is left alone',
   policy.effectiveInstruction('payout_return', 'cattle') === 'payout_return');
ok('cattle on switch_amount is left alone',
   policy.effectiveInstruction('switch_amount', 'cattle') === 'switch_amount');
ok('a delivery bike on reinvest still pays out (unchanged behaviour)',
   policy.effectiveInstruction('reinvest', 'delivery_bikes') === 'payout_all');
ok('a delivery bike with nothing set still pays out',
   policy.effectiveInstruction(null, 'delivery_bike') === 'payout_all');
ok('but a delivery bike may still switch',
   policy.effectiveInstruction('switch_product', 'delivery_bike') === 'switch_product');
ok('and an EIF holding may not',
   policy.effectiveInstruction('switch_product', 'eif_murabaha') === 'payout_all');

console.log('\nthe route refuses what the form does not offer');
ok('reinvest on EIF is refused', !!policy.instructionRefusal('reinvest', 'eif_murabaha'));
ok('switch_product on EIF is refused', !!policy.instructionRefusal('switch_product', 'eif_ijara'));
ok('payout_return on EIF is refused', !!policy.instructionRefusal('payout_return', 'eif_mudarabah'));
ok('payout_all on EIF is allowed', policy.instructionRefusal('payout_all', 'eif_murabaha') === null);
ok('reinvest on cattle is allowed', policy.instructionRefusal('reinvest', 'cattle') === null);
ok('the refusal says why, not just no',
   /contract/i.test(policy.instructionRefusal('reinvest', 'eif_ijara') || ''),
   policy.instructionRefusal('reinvest', 'eif_ijara'));

/* ── The form ──────────────────────────────────────────────────────────── */

console.log('\nthe maturity form offers one instruction on an EIF holding');
{
  const core = read('js/portal-core.js');
  const box = Object.create(null);
  const s = {
    window: {}, console, Date, String, Number, Math, JSON, Object, Array, Map, Set,
    RegExp, parseFloat, parseInt, isNaN, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, location: { href: '', origin: 'http://x' },
    fetch: () => Promise.reject(new Error('no network')),
    document: {
      addEventListener() {}, removeEventListener() {},
      body: { style: {}, classList: { add() {}, remove() {} } },
      activeElement: null,
      querySelector: () => null, querySelectorAll: () => [],
      getElementById: id => (box[id] = box[id] || {
        innerHTML: '', style: {}, value: '', textContent: '', dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {},
        setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
        querySelector: () => null, querySelectorAll: () => [],
        appendChild() {}, insertAdjacentHTML() {}, focus() {}, closest: () => null,
      }),
    },
    Modal: { open() {}, close() {} },
    Toast: { success() {}, error() {} },
    API: { _fetch: () => Promise.resolve({}) },
    SVC: { track() {} },
    _withBtn: (b, f) => f && f(),
  };
  s.window = s; s.globalThis = s; s.self = s;
  vm.createContext(s);
  vm.runInContext(read('js/api.js'), s, { filename: 'js/api.js' });
  /* portal-core declares no top-level state by design (check-portal-split
     enforces it) — PORTAL lives in portal.js. Stand it up here so the shared
     functions have the object they read from. */
  vm.runInContext(
    'var PORTAL = { investments: [], pools: [], transactions: [] };' +
    'var _mktProducts = [];' +
    /* Taken verbatim from portal/js/portal.js:56 rather than approximated —
       an escaper that differs from the shipped one would hide a real
       escaping bug in the markup this check reads. */
    "var _esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')" +
    ".replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');", s);
  vm.runInContext(core, s, { filename: 'js/portal-core.js' });

  /* Only the instruction dropdown. The switch-target select below it also
     holds <option> elements, and counting those as instructions would report
     a form with two choices as having four. */
  const instructionOptions = html => {
    const at = html.indexOf('id="matInstructionType"');
    if (at < 0) return null;
    const end = html.indexOf('</select>', at);
    return [...html.slice(at, end).matchAll(/<option value="([a-z_]+)"/g)].map(m => m[1]);
  };

  const render = async (productType, stored) => {
    box.maturityModalBody = { innerHTML: '', style: {} };
    const inv = {
      id: 'INV-1', pool_id: 'POOL-1', pool_name: 'Murabaha Trade Finance — Q4',
      investor_id: 'INV-A', amount: 50000, status: 'active',
      product_type: productType, maturity_instruction: stored,
      maturity_date: '2026-12-31', end_date: '2026-12-31',
    };
    vm.runInContext('PORTAL.investments = ' + JSON.stringify([inv]) +
                    '; PORTAL.pools = ' + JSON.stringify([
                      { id: 'POOL-2', product_type: 'cattle', status: 'open' },
                      { id: 'POOL-3', product_type: 'solar', status: 'open' },
                    ]) + ';', s);
    await s.openMaturityModal('INV-1');
    return box.maturityModalBody.innerHTML;
  };

  const run = async () => {
    const eif = await render('eif_murabaha', 'reinvest');
    const values = instructionOptions(eif);
    ok('exactly one instruction is offered',
       !!values && values.length === 1 && values[0] === 'payout_all', JSON.stringify(values));
    ok('and no switch-target picker is rendered at all',
       !/matSwitchProductType/.test(eif));
    ok('and it is preselected even though the column says reinvest',
       /value="payout_all"[^>]*selected/.test(eif));
    ok('the select is disabled, so nothing else can be submitted',
       /id="matInstructionType"\s+disabled/.test(eif));
    ok('the form says WHY, rather than leaving a dead control unexplained',
       /concluded at the end of the term/.test(eif), eif.slice(0, 400));
    ok('it names the client’s own contract where we know it',
       /Your Murabaha contract/.test(eif));
    /* The copy legitimately says "nothing to roll over", so this asserts the
       absence of a PROMISE rather than of the word: no reinvest option, no
       reinvest panel, and no sentence saying the money will be rolled. */
    ok('nothing offers or promises a rollover',
       !/value="reinvest"/.test(eif) &&
       !/id="reinvestGroup"/.test(eif) &&
       !/rolled into/i.test(eif) &&
       !/automatically reinvested/i.test(eif),
       (eif.match(/.{0,80}(value="reinvest"|reinvestGroup|rolled into|automatically reinvested).{0,80}/i) || [''])[0]);

    const bike = await render('delivery_bike', null);
    const bikeValues = instructionOptions(bike);
    ok('a delivery bike is untouched — payout and switch, as before',
       JSON.stringify(bikeValues) === JSON.stringify(['payout_all', 'switch_product']),
       JSON.stringify(bikeValues));

    const cattle = await render('cattle', null);
    const cattleValues = instructionOptions(cattle);
    ok('and a conventional product still offers the whole list',
       cattleValues.length === 6 && cattleValues.includes('reinvest'),
       JSON.stringify(cattleValues));
    ok('the EIF form is genuinely shorter than the conventional one',
       values.length < cattleValues.length);
  };
  /* No top-level `return` — Node tolerates one in CommonJS, the parser
     check-js-parses uses does not, and a check that fails another check is
     not a check. */
  run().then(afterRender, e => { fail++; console.log('  ✗ the form rendered at all\n      ' + (e && e.stack) || e); afterRender(); });
}

function afterRender() {
/* ── The panel staff read ──────────────────────────────────────────────── */

console.log('\nthe console reports what will happen, not what the column says');
{
  const eifPlan = Utils.maturityPlan(
    { amount: 100000, product_type: 'eif_murabaha', maturity_instruction: 'reinvest',
      actual_return_amount: 0, annual_rate: 0.14, term_months: 12 }, null);
  ok('an EIF holding carrying reinvest is reported as a payout',
     eifPlan.label === 'Pay out all', eifPlan.label);
  ok('and the detail line does not say rolled', !/rolled/i.test(eifPlan.detail), eifPlan.detail);

  const cattlePlan = Utils.maturityPlan(
    { amount: 100000, product_type: 'cattle', maturity_instruction: 'reinvest',
      annual_rate: 0.14, term_months: 12 }, null);
  ok('a cattle holding carrying reinvest still reports a rollover',
     cattlePlan.label === 'Reinvest', cattlePlan.label);
}

/* ── The four places, in the shipped source ────────────────────────────── */

console.log('\nevery place that decides money imports the one rule');
{
  const cron = read('server/jobs/maturityCron.js');
  ok('the maturity engine imports effectiveInstruction',
     /require\('\.\.\/services\/maturityPolicy'\)/.test(cron));
  ok('and uses it to pick the branch it executes',
     /const instruction\s*=\s*effectiveInstruction\(/.test(cron));
  ok('it no longer restates the delivery-bike rule of its own',
     !/includes\('delivery_bike'\)/.test(cron),
     'a second copy of the rule is a second thing to forget');

  const pre = read('server/services/maturityPreflight.js');
  ok('the pre-flight predicts by the same rule',
     /effectiveInstruction\(m\.maturity_instruction, m\.product_type\)/.test(pre));
  ok('it no longer guesses from the raw column',
     !/\(m\.maturity_instruction \|\| 'reinvest'\) !== 'payout_all'/.test(pre));
  ok('and it stops chasing an instruction a payout-only product cannot give',
     /!isPayoutOnlyProduct\(m\.product_type\)/.test(pre));

  const rep = read('server/services/maturityInstructionReport.js');
  ok('the instruction report uses it too',
     /effectiveInstruction\(raw, i\.product_type\)/.test(rep));

  const routes = read('server/routes/investments.js');
  const refusals = (routes.match(/instructionRefusal\(/g) || []).length;
  ok('both instruction routes call instructionRefusal', refusals >= 2, `found ${refusals}`);
  const singleAt = routes.indexOf("router.post('/:id/instruction'");
  const poolAt   = routes.indexOf("router.post('/pool/:poolId/instruction'");
  const single   = routes.slice(singleAt, poolAt);
  const poolR    = routes.slice(poolAt);
  ok('the single-investment route refuses BEFORE it writes',
     single.indexOf('instructionRefusal(') < single.indexOf('SET maturity_instruction'),
     'a refusal after the UPDATE has already changed the money');
  ok('the pool route refuses BEFORE it writes',
     poolR.indexOf('instructionRefusal(') < poolR.indexOf('SET maturity_instruction'));

  /* Calling it is not acting on it. Each route must branch on the value it
     just computed and answer 400 — a guard rewritten to `if (false)` leaves
     the call in place and every assertion above still passing. */
  for (const [label, body, name] of [['single-investment', single, 'refusal'],
                                     ['pool', poolR, 'poolRefusal']]) {
    const at = body.indexOf(`const ${name} =`);
    const after = at < 0 ? '' : body.slice(at, at + 420);
    ok(`the ${label} route branches on what instructionRefusal returned`,
       new RegExp(`if \\(${name}\\)`).test(after),
       after.slice(0, 200));
    ok(`and answers 400 with the ${name === 'refusal' ? 'message' : 'same message'}`,
       /res\.status\(400\)[\s\S]{0,120}INSTRUCTION_NOT_AVAILABLE/.test(after),
       after.slice(0, 300));
    ok(`and rolls the transaction back first`,
       /ROLLBACK[\s\S]{0,120}res\.status\(400\)/.test(after),
       after.slice(0, 300));
  }
  ok('the refusal is not skipped for staff',
     !/isStaff[^\n]*instructionRefusal/.test(routes),
     'acting on a client’s behalf must not create a rollover the product cannot carry');
}

console.log('\nthe console’s own form is restricted too');
{
  const adm = read('admin/js/admin.js');
  ok('admin asks Utils whether the product is payout-only',
     /_admPayoutOnly\s*=\s*Utils\.isPayoutOnlyProduct\(inv\.product_type\)/.test(adm));
  ok('and the select collapses to one option on those',
     /\$\{_admPayoutOnly \? `\s*\n\s*<option value="payout_all" selected>/.test(adm));
  ok('the select is disabled so nothing else can be sent',
     /id="admMatInstruction"[^\n]*\$\{_admPayoutOnly \? ' disabled' : ''\}/.test(adm));
}

console.log('\nthe portal stops asking for a decision that does not exist');
{
  const core = read('js/portal-core.js');
  ok('a matured EIF holding raises no "awaiting instruction" notice',
     /if \(Utils\.isPayoutOnlyProduct\(i\.product_type\)\) return false;/.test(core));
  ok('the My Investments card states the outcome instead of warning',
     /Paid out in full/.test(core));
  /* Counted, not merely found. The Maturity screen draws two cards — active
     and matured — from separate blocks, and an assertion satisfied by either
     one lets the other go back to "Awaiting instruction". */
  const decided = (core.match(/payoutOnly \? 'Paid out in full at maturity'/g) || []).length;
  ok('both maturity cards, active and matured, report it as decided',
     decided === 2, `found ${decided}`);
  const settled = (core.match(/payoutOnly\s*=\s*Utils\.isPayoutOnlyProduct/g) || []).length;
  ok('and each asks the shared rule rather than testing the product itself',
     settled >= 2, `found ${settled}`);
  ok('the individual-instruction rows say paid out, not "Not set"',
     /payoutOnly \? 'Paid out' :/.test(core));
}

console.log('\nexisting rows are brought into line with the behaviour');
{
  const setup = read('server/db/setup.js');
  ok('setup settles EIF investments on payout_all',
     /maturity_instruction = 'payout_all'/.test(setup) &&
     /product_type ~\* '\^eif\(_\|\$\)'/.test(setup));
  ok('narrowly — a re-run changes nothing',
     /COALESCE\(maturity_instruction, ''\) <> 'payout_all'/.test(setup));
  ok('and it clears the companion fields a switch left behind',
     /switch_product_type\s*=\s*NULL/.test(setup));
  ok('staff are told, with where to find it',
     /ANN-2026-EIF-PAYOUT-ONLY/.test(setup));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}
