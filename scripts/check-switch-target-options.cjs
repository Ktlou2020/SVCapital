#!/usr/bin/env node
/* A switch target may only be a product the engine can actually route into.
 *
 * The list was read from STATE.products, which only the Products tab fills, so
 * an investment opened from the investor detail showed "No products available"
 * on a platform with plenty of them — the screen in the bug report.
 *
 * The deeper problem is what the list MEANT. A product whose pools are all
 * closed is not a switch target: reinvestAmount finds nothing, falls back to
 * the wallet, and the client is paid out cash they did not ask for. Offering it
 * is offering a wallet payout under another name — and it is exactly the
 * "switch with no target" the maturity pre-flight reports.
 *
 * So the options now come from open pools, using reinvestAmount's own
 * predicate. This asserts that predicate really is the same one, by running
 * the shipped function over pools that fail it in each individual way.
 *
 * Run: node scripts/check-switch-target-options.cjs
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

const day = off => {
  const d = new Date(); d.setDate(d.getDate() + off);
  return d.toISOString().slice(0, 10);
};

function ctx(pools) {
  const sandbox = {
    STATE: { pools },
    Utils: realUtils({ productInfo: pt => ({ label: { cattle: 'Cattle Investment', short_term: 'Short Term Investment', solar: 'Solar' }[pt] || pt }) }),
    _esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    Date, String, Number, Map, Array, Object, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(slice('_switchableProducts'), sandbox);
  vm.runInContext(slice('_switchProductOptions'), sandbox);
  return sandbox;
}

const OPEN_CATTLE = { id: 'P1', name: 'Cattle Investment - August 2026', product_type: 'cattle',
                      status: 'open', end_date: day(30), current_invested: 0, max_investment: null };

(async () => {
  try {
    console.log('\nonly products with a pool the engine would find');
    {
      const s = ctx([
        OPEN_CATTLE,
        { id: 'P2', name: 'Solar - closed',   product_type: 'solar',      status: 'closed', end_date: day(30) },
        { id: 'P3', name: 'Short Term - past', product_type: 'short_term', status: 'open',   end_date: day(-1) },
        { id: 'P4', name: 'Bikes - full',      product_type: 'bikes',      status: 'open',   end_date: day(30),
          current_invested: 500000, max_investment: 500000 },
        { id: 'P5', name: 'Nameless type',     product_type: '',           status: 'open',   end_date: day(30) },
      ]);
      const got = vm.runInContext('_switchableProducts().map(o => o.productType)', s);
      ok('an open pool inside its window qualifies', got.includes('cattle'), JSON.stringify(got));
      ok('a closed pool does not', !got.includes('solar'), JSON.stringify(got));
      ok('nor one past its close date', !got.includes('short_term'),
         'reinvestAmount floors on end_date >= CURRENT_DATE — a stale pool is not a target');
      ok('nor one already at capacity', !got.includes('bikes'), JSON.stringify(got));
      ok('and a pool with no product type is skipped', !got.includes(''), JSON.stringify(got));
      ok('exactly one product qualifies here', got.length === 1, JSON.stringify(got));
    }

    console.log('\nthe pool named is the one the rollover would pick');
    {
      const s = ctx([
        { id: 'A', name: 'Cattle - December 2026', product_type: 'cattle', status: 'open', end_date: day(120) },
        { id: 'B', name: 'Cattle - August 2026',   product_type: 'cattle', status: 'open', end_date: day(4) },
        { id: 'C', name: 'Cattle - October 2026',  product_type: 'cattle', status: 'open', end_date: day(60) },
      ]);
      const got = vm.runInContext('_switchableProducts()', s);
      ok('one entry per product, not one per pool', got.length === 1, JSON.stringify(got.map(g => g.poolName)));
      ok('and it is the earliest closing, as the engine orders them',
         got[0].poolName === 'Cattle - August 2026', got[0].poolName);
      /* end_date NULL sorts last in the engine (NULLS LAST); it must not win here. */
      const s2 = ctx([{ id: 'N', name: 'Cattle - open ended', product_type: 'cattle', status: 'open', end_date: null },
                      { id: 'B', name: 'Cattle - August 2026', product_type: 'cattle', status: 'open', end_date: day(4) }]);
      ok('an open-ended pool does not outrank a dated one',
         vm.runInContext('_switchableProducts()[0].poolName', s2) === 'Cattle - August 2026');
    }

    console.log('\nthe options say where the money lands');
    {
      const s = ctx([OPEN_CATTLE]);
      const o = vm.runInContext('_switchProductOptions("")', s);
      ok('the product is named', /Cattle Investment/.test(o.html), o.html);
      ok('and the pool alongside it', /Cattle Investment - August 2026/.test(o.html), o.html);
      ok('nothing is preselected when no target is set yet', !/selected/.test(o.html), o.html);
    }

    console.log('\nan existing choice is never silently dropped');
    {
      const s = ctx([OPEN_CATTLE]);
      const o = vm.runInContext('_switchProductOptions("solar")', s);
      ok('a target with no open pool is still listed', /value="solar"/.test(o.html), o.html);
      ok('and stays selected, so Set Instruction does not rewrite it',
         /value="solar" selected/.test(o.html), o.html);
      ok('marked as what it would actually do',
         /no open pool \(would pay to wallet\)/.test(o.html), o.html);
      ok('and reported as unbacked so the form can warn', o.chosenHasPool === false);

      const good = vm.runInContext('_switchProductOptions("cattle")', s);
      ok('a target that does have a pool is reported as backed', good.chosenHasPool === true);
      ok('and is preselected', /value="cattle" selected/.test(good.html), good.html);
    }

    console.log('\nno open pools anywhere is stated as such');
    {
      const s = ctx([{ id: 'X', name: 'All closed', product_type: 'cattle', status: 'closed', end_date: day(30) }]);
      const o = vm.runInContext('_switchProductOptions("")', s);
      ok('the list is empty', o.count === 0 && o.html === '', JSON.stringify(o));
      /* Matched against the markup, not the whole file — the old wording still
         appears in a comment explaining what it used to say, and a check that
         cannot tell a comment from an <option> would fail on its own history. */
      ok('the form says no OPEN POOL, not no products',
         /No product currently has an open pool/.test(SRC) &&
         !/<option[^>]*>\s*No products available\s*<\/option>/.test(SRC),
         '"no products" sends someone to the product catalogue; the pools are what is missing');
      ok('and the select is disabled rather than silently empty',
         /<select id="admMatProduct" class="form-select" disabled>/.test(SRC));
      ok('with the consequence spelled out',
         /pay out to the wallet instead/.test(SRC));
    }

    console.log('\nthe pools are loaded before the form is built');
    {
      ok('the detail fetches pools when the cache is cold',
         /if \(!STATE\.pools \|\| !STATE\.pools\.length\) \{[\s\S]{0,200}?API\.pools\.list/.test(SRC),
         'this modal is reachable without ever opening the Pools tab');
      ok('and the old products-table source is gone',
         !/\$\{\(STATE\.products \|\| \[\]\)\.map\(pr => \{/.test(SRC),
         'STATE.products is only filled by the Products tab');
      ok('a pool load failure is reported, not swallowed',
         /\[investment detail\] pools failed to load/.test(SRC));
    }

    console.log('\nit matches the engine, not a paraphrase of it');
    {
      const engine = fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'maturityCron.js'), 'utf8');
      const q = engine.slice(engine.indexOf('SELECT * FROM investment_pools'), engine.indexOf('LIMIT 1', engine.indexOf('SELECT * FROM investment_pools')));
      ok('the engine still filters on open', /status = 'open'/.test(q));
      ok('still floors on end_date', /end_date IS NULL OR end_date >= CURRENT_DATE/.test(q));
      ok('still excludes full pools', /max_investment IS NULL OR COALESCE\(current_invested,0\) < max_investment/.test(q));
      ok('and still orders by end_date ascending',
         /ORDER BY end_date ASC NULLS LAST/.test(q),
         'if this changes, _switchableProducts has to change with it');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  }
  process.exit(fail ? 1 : 0);
})();
