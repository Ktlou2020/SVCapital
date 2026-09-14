#!/usr/bin/env node
/* A Delivery Bikes pool appears under the Delivery Bikes product.
 *
 * The marketplace is product-first: it lists products from the products table
 * and then filters pools with `p.product_type !== type`. Those two sides
 * disagree about how this product is spelled.
 *
 *     products (server/db/setup.js) .................. delivery_bike
 *     pools from Firebase (migrate-from-firebase.js) . delivery_bikes
 *
 * The POOL-MIGR-* rows in production came through that migrator. A plural pool
 * can never equal a singular product, so the product card shows "0 pools" and
 * the detail page behind it is empty — a dead end one click into the
 * marketplace, for the product whose funnel we were asking about.
 *
 * Both spellings already sat side by side in two KNOWN lists in js/api.js and
 * in an exclusion at the mobile-activity roll-up, which is what working around
 * this looks like when it is done one site at a time.
 *
 * Normalised at the point of comparison. Nothing re-labels a pool: the stored
 * values are untouched and history keeps whatever it was written with, which is
 * why this is a matching fix and not a migration.
 *
 * The filters are LIFTED from the shipped files and run against fixture pools,
 * rather than read for their shape — the bug was an operator comparing two
 * strings, and only running it proves which strings now match.
 *
 * Run: node server/scripts/check-product-type-alias.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── The shipped normaliser, lifted ─────────────────────────────────────── */
const core = read(path.join('js', 'portal-core.js'));
const canonSrc = (core.match(/function svcCanonProductType\(t\) \{[\s\S]*?\n\}/) || [])[0];
ok('svcCanonProductType is in the shared core', !!canonSrc,
   'both portals call it, so it has to live where both of them load');

const sandbox = { Date, String, Object };
vm.createContext(sandbox);
if (canonSrc) vm.runInContext(canonSrc, sandbox);
/* Identity when the helper is absent, so the rest of the file still RUNS and
   reports which comparisons broke. Without this the check threw on
   `canon is not a function` the moment the helper was removed — a crash names
   one problem and hides the six behind it, and the whole point is to show that
   a plural pool stops reaching the singular product. */
const canon = sandbox.svcCanonProductType || (t => String(t == null ? '' : t));

console.log('\nthe two spellings resolve to one');
{
  ok('delivery_bikes becomes delivery_bike', canon('delivery_bikes') === 'delivery_bike');
  ok('delivery_bike is left alone',          canon('delivery_bike')  === 'delivery_bike');
  ok('case does not matter',                 canon('Delivery_Bikes') === 'delivery_bike');
  ok('surrounding space does not matter',    canon('  delivery_bikes ') === 'delivery_bike');
  /* An alias map that swallowed everything would pass the four above. */
  ok('every other product is untouched',
     ['cattle', 'solar', 'solar_7yr', 'short_term', 'cattle_12j', 'ilobola', 'gridfarmer']
       .every(t => canon(t) === t),
     'this is an alias for one known split, not a general rewriter');
  ok('null and undefined do not throw', canon(null) === '' && canon(undefined) === '');
}

/* ── The shipped filters, lifted and run ────────────────────────────────── */
for (const rel of [path.join('portal', 'js', 'portal.js'),
                   path.join('mobile', 'src', 'js', 'portal.js'),
                   path.join('mobile', 'www', 'js', 'portal.js')]) {
  const src = read(rel);
  const fnSrc = (src.match(/function _openPoolsForProduct\(type\) \{[\s\S]*?\n\}/) || [])[0];

  console.log(`\n${rel} — a plural pool reaches the singular product`);
  ok('the filter is still findable', !!fnSrc,
     'if this fails the check proves nothing about the real marketplace');
  if (!fnSrc) continue;

  const future = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
  const past   = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const pools = [
    { id: 'P-PLURAL',   product_type: 'delivery_bikes', status: 'open',   end_date: future },
    { id: 'P-SINGULAR', product_type: 'delivery_bike',  status: 'open',   end_date: future },
    { id: 'P-CLOSED',   product_type: 'delivery_bikes', status: 'open',   end_date: past   },
    { id: 'P-MATURED',  product_type: 'delivery_bikes', status: 'matured',end_date: future },
    { id: 'P-CATTLE',   product_type: 'cattle',         status: 'open',   end_date: future },
  ];

  const ctx = {
    PORTAL: { pools },
    svcCanonProductType: canon,
    _poolPastClose: p => { const t = Date.parse(p.end_date); return !isNaN(t) && Date.now() > t; },
    Date, String, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc, ctx);
  const got = ctx._openPoolsForProduct('delivery_bike').map(p => p.id);

  ok('the delivery_bikes pool is offered', got.includes('P-PLURAL'),
     `got ${JSON.stringify(got)} — this is the pool the migrator created`);
  ok('so is the delivery_bike one',        got.includes('P-SINGULAR'), JSON.stringify(got));
  ok('a pool past its close date is not', !got.includes('P-CLOSED'), JSON.stringify(got));
  ok('nor a matured one',                 !got.includes('P-MATURED'), JSON.stringify(got));
  ok('and cattle stays out of it',        !got.includes('P-CATTLE'),
     'the alias must not merge products that are genuinely different');

  /* Asking by the plural must give the same answer as asking by the singular —
     the product page is reachable by either. */
  const byPlural = ctx._openPoolsForProduct('delivery_bikes').map(p => p.id).sort();
  ok('asking either way gives the same pools',
     JSON.stringify(byPlural) === JSON.stringify(got.slice().sort()),
     `${JSON.stringify(byPlural)} vs ${JSON.stringify(got)}`);
}

console.log('\nthe product card counts the pools it will then show');
{
  const src = read(path.join('js', 'portal-core.js'));
  ok('the count is keyed canonically', /openCounts\[k\] = \(openCounts\[k\] \|\| 0\) \+ 1/.test(src));
  ok('and read back canonically', /const open = openCounts\[_canonType\] \|\| 0;/.test(src),
     'a card saying "0 pools" over a page that lists two is the same bug wearing a hat');
}

console.log('\nthe label and icon resolve for both spellings');
{
  const api = read(path.join('js', 'api.js'));
  ok('productInfo canonicalises before the lookup',
     /const _t = \(typeof svcCanonProductType === 'function'\) \? svcCanonProductType\(type\) : type;/.test(api));
  ok('and the map is read with it', /const base = map\[_t\]/.test(api),
     'delivery_bikes has no map entry — it fell through to Other, grey, labelled with its own raw type');
  ok('the product cache is read with it too', /this\._productCache\[_t\] \|\| this\._productCache\[type\]/.test(api));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
