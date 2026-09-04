#!/usr/bin/env node
/* Opening an investment detail must actually render it.
 *
 * This exists because a shipped bug got past two checks that both looked like
 * they covered it. check-row-click asserts which handler a click fires, with
 * viewInvestmentDetail stubbed out. check-investment-row-open asserts the row
 * markup is correct. Neither ever ran the render — so _backControl referencing
 * _investorName, a const belonging to a different function, threw
 * ReferenceError on every call, innerHTML was never assigned, and clicking a
 * row in the investor's Investments tab did nothing at all.
 *
 * Only that one path was affected, which is what made it survive: the All
 * Investments list passes no backTo and returns early, and the pool list takes
 * the backKind === 'pool' branch. The broken branch was the one in between.
 *
 * So this renders the detail for real, on every entry path, and fails on any
 * exception. Assertions about wording come second; the first question is
 * whether it renders at all.
 *
 * Run: node scripts/check-investment-detail-renders.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');

/* The real Utils, lifted out of js/api.js, with this check's deterministic
   overrides on top.
 *
 * Each of these checks used to hand-write a Utils object with the four or five
 * methods the render happened to call. Adding a method to the real Utils and
 * using it in admin.js then failed here with "Utils.txnDate is not a function"
 * — a true failure reported as if the shipped code were broken, when what was
 * missing was the stub. Lifting the real one means a new helper is simply
 * there, and one that is DELETED breaks these honestly. */
function realUtils(overrides) {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'js', 'api.js'), 'utf8');
  const at = src.indexOf('const Utils = {');
  if (at < 0) throw new Error('Utils not found in js/api.js');
  let i = src.indexOf('{', at), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  const box = { console };
  require('vm').createContext(box);
  require('vm').runInContext(src.slice(at, j + 1) + ';\nthis.U = Utils;', box);
  return Object.assign({}, box.U, overrides || {});
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function slice(name) {
  let at = SRC.indexOf(`async function ${name}(`);
  if (at < 0) at = SRC.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} not found in admin/js/admin.js`);
  const end = SRC.indexOf('\n}\n', at);
  if (end < 0) throw new Error(`could not find the end of ${name}`);
  return SRC.slice(at, end + 3);
}

const INVESTOR = { id: 'S-1', first_name: 'Anita', last_name: 'Redeker', email: 'anita@example.test' };
const POOL_OPEN = { id: 'P1', name: 'Cattle Investment - August 2026', product_type: 'cattle',
                    status: 'open', end_date: '2099-09-30', current_invested: 0, max_investment: null };
const SOURCE_POOL = { id: 'P0', name: 'Short Term Investment - March 2026', product_type: 'short_term',
                      status: 'active', end_date: '2026-08-31' };

/* Every global the render legitimately reaches for. Stubbed rather than
   omitted: a missing stub is this check's own bug and would masquerade as the
   defect it is looking for. */
function env() {
  const els = {};
  const mk = id => (els[id] = { id, textContent: '', innerHTML: '', style: {}, value: '', disabled: false });
  ['invDetailTitle', 'invDetailBody', 'admMatInstruction', 'admMatProduct',
   'admMatAmountLabel', 'admMatAmountHint'].forEach(mk);

  const sandbox = {
    document: { getElementById: id => els[id] || null, querySelector: () => null },
    STATE: { investors: [INVESTOR], pools: [POOL_OPEN, SOURCE_POOL], products: [], investments: [] },
    Utils: realUtils({
      productInfo: pt => ({ label: { cattle: 'Cattle Investment', short_term: 'Short Term Investment' }[pt] || pt || '—',
                            badgeClass: 'badge--gold', icon: 'fa-bolt' }),
      rand: v => 'R' + Number(v || 0).toFixed(2),
      pct:  v => (Number(v) * 100).toFixed(2) + '%',
      date: () => '24 Mar 2026',
      statusBadge: () => '<span class="badge">ACTIVE</span>',
      effectiveRate: () => 0.0213,
      rateCell: () => '<span>2.13%</span>',
      /* A posted rate is a period return, so no "p.a." — the render reads this
         for the Return Rate row. */
      rateLabel: () => '2.13% for the period',
      rateSuffix: () => '',
      maturityPlan: (inv, lbl) => ({ label: 'Switch product',
        detail: `Switched into another product — ${lbl || 'none chosen yet'}`,
        payout: null, remainder: 10213 }),
    }),
    _esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    Modal: { open() {}, close() {} },
    Toast: { success() {}, error() {}, info() {} },
    API: { _fetch: async () => ({ data: [] }), pools: { list: async () => ({ data: [] }) } },
    _getAdminName: () => 'Admin',
    ADM_NEEDS_AMOUNT: ['payout_custom', 'custom_switch', 'switch_amount'],
    ADM_NEEDS_PRODUCT: ['switch_product', 'custom_switch', 'switch_amount'],
    ADM_AMOUNT_SWITCHES: ['switch_amount'],
    JSON, Number, String, Math, Date, Map, Array, Object, parseFloat, console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ['_switchableProducts', '_switchProductOptions', '_backControl', '_renderInvestmentDetail']) {
    vm.runInContext(slice(f), sandbox);
  }
  return { sandbox, els };
}

const INV = {
  id: 'INV-1', investor_id: 'S-1', investor_name: 'Anita Redeker',
  pool_name: 'Short Term Investment - March 2026', pool_id: 'P0',
  product_type: 'short_term', amount: 10000, status: 'active',
  start_date: '2026-03-24', end_date: '2026-08-31',
  annual_rate: 0, pool_actual_rate: 0.0213,
  maturity_instruction: 'switch_product', switch_product_type: null,
  custom_payout_amount: null, expected_return: null,
};

/* Returns { html, error } — never throws, so a failure is reported as a
   failure rather than taking the whole run down. */
function render(backTo, backKind, invOverrides) {
  const { sandbox, els } = env();
  sandbox.__inv = { ...INV, ...(invOverrides || {}) };
  sandbox.__backTo = backTo;
  sandbox.__backKind = backKind;
  try {
    vm.runInContext('_renderInvestmentDetail(__inv, __backTo, __backKind)', sandbox);
    return { html: els.invDetailBody.innerHTML, title: els.invDetailTitle.textContent, error: null };
  } catch (err) {
    return { html: '', title: '', error: `${err.constructor.name}: ${err.message}` };
  }
}

(async () => {
  try {
    console.log('\nit renders from every entry path');
    {
      const fromList = render(undefined, undefined);
      ok('from the All Investments list, with no way back',
         !fromList.error && fromList.html.length > 500, fromList.error || `${fromList.html.length} chars`);

      const fromInvestor = render('S-1', undefined);
      ok('from the investor\'s Investments tab',
         !fromInvestor.error && fromInvestor.html.length > 500,
         fromInvestor.error || `${fromInvestor.html.length} chars`);

      const fromPool = render('P0', 'pool');
      ok('from the pool investors list',
         !fromPool.error && fromPool.html.length > 500, fromPool.error || `${fromPool.html.length} chars`);

      ok('and the title names the pool',
         fromInvestor.title === 'Investment — Short Term Investment - March 2026', fromInvestor.title);
    }

    console.log('\nthe way back matches where it was opened from');
    {
      const fromList     = render(undefined, undefined);
      const fromInvestor = render('S-1', undefined);
      const fromPool     = render('P0', 'pool');

      ok('no back control when there is nowhere to go back to',
         !/fa-arrow-left/.test(fromList.html));
      ok('back to the investor, by name rather than id',
         /Back to Anita Redeker/.test(fromInvestor.html),
         (fromInvestor.html.match(/Back to [^<]*/) || ['(none)'])[0]);
      ok('and it reopens the investor',
         /viewInvestor\('S-1'\)/.test(fromInvestor.html));
      ok('back to the pool, by name',
         /Back to Short Term Investment - March 2026/.test(fromPool.html),
         (fromPool.html.match(/Back to [^<]*/) || ['(none)'])[0]);
      ok('and it closes the detail behind it',
         /Modal\.close\('investorDetailModal'\);viewPoolInvestors\('P0'\)/.test(fromPool.html));
    }

    console.log('\nan unknown investor degrades rather than breaking');
    {
      const orphan = render('S-NOT-LOADED', undefined);
      ok('it still renders', !orphan.error && orphan.html.length > 500, orphan.error);
      ok('falling back to the id rather than an empty label',
         /Back to S-NOT-LOADED/.test(orphan.html),
         (orphan.html.match(/Back to [^<]*/) || ['(none)'])[0]);
    }

    console.log('\nthe switch target list is present and populated');
    {
      const r = render('S-1', undefined);
      ok('the product select is rendered', /id="admMatProduct"/.test(r.html));
      ok('offering the product whose pool is open',
         /Cattle Investment — Cattle Investment - August 2026/.test(r.html),
         (r.html.match(/<option[^>]*>[^<]*<\/option>/g) || ['(none)']).join(' | '));
      ok('and not the source product, whose pool is not open',
         !/>Short Term Investment — /.test(r.html));
    }

    console.log('\nevery maturity instruction renders');
    {
      for (const instruction of ['reinvest', 'payout_all', 'payout_return', 'payout_custom',
                                 'switch_product', 'custom_switch', 'switch_amount']) {
        const r = render('S-1', undefined, { maturity_instruction: instruction, custom_payout_amount: 2500,
                                             switch_product_type: 'cattle' });
        ok(`${instruction} renders without throwing`, !r.error && r.html.length > 500, r.error);
      }
    }

    console.log('\nthe scope bug itself cannot come back');
    {
      /* Comments stripped first: the fix carries a comment naming the identifier
         it used to read, and a check that cannot tell a comment from code would
         fail on the explanation of its own bug. */
      const back = slice('_backControl')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ');
      ok('_backControl reads no identifier it does not own',
         !/_investorName/.test(back),
         '_investorName is a const inside _renderInvestmentDetail — a top-level function cannot see it');
      ok('it resolves the name from state it is given',
         /STATE\.investors \|\| \[\]\)\.find\(i => i\.id === backTo\)/.test(back), back.slice(0, 200));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  }
  process.exit(fail ? 1 : 0);
})();
