#!/usr/bin/env node
/* What a group can put its savings into, shown the way a person is shown it.
 *
 * The personal marketplace gives a product its overview: the blurb, the
 * average achieved per annum, the minimum, the term, when the next pool
 * closes, and the factsheet. The group's Investments tab gave a line of
 * pool names with a rate beside each one — so a committee deciding where
 * the group's savings go was shown LESS than a member deciding for
 * themselves. It is more people's money, so it should be more information,
 * not less.
 *
 * ONE CARD, TWO FRONT DOORS. _svProductCard draws both. Each surface
 * supplies only the footer, because the action is the only honest
 * difference between "I will invest" and "we will ask our signatories" —
 * and two card renderers is how one of them quietly stops showing the
 * factsheet.
 *
 * Run: node server/scripts/check-group-investments.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const words = html => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function portal(over) {
  const ctx = { window: {}, document: { getElementById: () => null }, location: { search: '' },
                localStorage: { getItem: () => null, setItem() {} },
                sessionStorage: { getItem: () => null, setItem() {} },
                Utils: { rand: n => 'R ' + Number(n || 0).toFixed(2),
                         productInfo: t => ({ label: t, icon: 'fa-leaf' }),
                         productColor: () => '#2e7d32',
                         daysRemaining: () => 12 },
                encodeURIComponent, console };
  vm.createContext(ctx);
  vm.runInContext(read('js/portal-core.js'), ctx);
  ctx._esc = v => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  Object.assign(ctx, over || {});
  return ctx;
}

const POOL = over => Object.assign({
  id: 'POOL-1', product_type: 'cattle', status: 'open', name: 'Cattle Q4',
  min_investment: 5000, annual_rate: 0.13, term_months: 12, end_date: '2026-12-20',
}, over || {});
const PRODUCT = over => Object.assign({
  product_type: 'cattle', label: 'Cattle Investment', is_active: true, sort_order: 1,
  headline: 'Finance a herd, share the growth.', min_investment: 5000,
  annual_rate: 0.13, term_months: 12, benchmark_rate: 0.13, avg_annual_rate: 0.129,
  factsheet_url: 'https://example.test/cattle.pdf',
}, over || {});

const build = async (products, pools) => {
  const P = portal();
  P.PORTAL = { pools };
  P._getPortalProducts = async () => products;
  return { P, html: await P._svOpenToGroup('SA-1') };
};

(async () => {

/* ══ 1. It is the marketplace card ═════════════════════════════════ */
console.log('\na group is shown what a person is shown');
{
  const { P, html } = await build([PRODUCT()], [POOL()]);
  const w = words(html);
  for (const [what, probe] of [
    ['the product, not the pool id',    /Cattle Investment/],
    ['what it is',                      /Finance a herd/],
    ['what it has returned',            /12\.90%/],
    ['the minimum',                     /R 5000\.00/],
    ['the term',                        /12 mo/],
    ['when the next pool closes',       /closes in 12d/],
    ['AND THE FACTSHEET',               /Factsheet/],
  ]) ok(`it shows ${what}`, probe.test(w), w.slice(0, 300));

  ok('and it is literally the marketplace card',
     /market-pool-card mpc-v2/.test(html),
     'a second card renderer is how one of them quietly stops showing the '
     + 'factsheet: ' + html.slice(0, 200));

  /* THE SAME FUNCTION, proved by swapping only the footer. */
  const mine = P._svProductCard(PRODUCT(), [POOL()]);
  const theirs = P._svProductCard(PRODUCT(), [POOL()], { footer: () => '<i>group</i>' });
  const strip = h => h.replace(/<div class="mpc2-footer">[\s\S]*$/, '');
  ok('ONE CARD, AND ONLY THE ACTION DIFFERS',
     strip(mine) === strip(theirs) && strip(mine).length > 400,
     'everything above the button is identical by construction');
  ok('and the personal card keeps its own action',
     /openProductDetail\('cattle'\)/.test(mine) && /View product & pools/.test(mine),
     'the extraction must not have changed the marketplace: ' + mine.slice(-300));
}

/* ══ 2. The action is the group's, not a person's ══════════════════ */
console.log('\nbut a group asks rather than invests');
{
  const { html } = await build([PRODUCT()], [POOL()]);
  ok('THE BUTTON ASKS THE SIGNATORIES',
     /Ask the signatories/.test(words(html)) && !/View product & pools/.test(words(html)),
     'a member taps invest; a committee taps ask — and no member can '
     + 'place a group’s money alone: ' + words(html).slice(-200));
  ok('and it names a pool the group can actually be asked for',
     /raiseStokvelInvestment\('SA-1','POOL-1'\)/.test(html), html.slice(-400));
  /* THE LABELLED BUTTON, not any mention of the function. The whole card
     already carries openProductDetail as its click target, inherited from
     the marketplace — so a probe for the function name passes even with no
     button in the footer at all. What a committee needs is something that
     SAYS factsheets. */
  ok('and the factsheets are still one tap away, and say so',
     /Product &amp; factsheets/.test(html)
     && /btn--ghost[^>]*>\s*<i class="fa-solid fa-file-lines"/.test(
          html.replace(/\n\s*/g, ' ')),
     'the card inherits openProductDetail from the marketplace, so naming '
     + 'the function proves nothing: ' + html.slice(-400));
  ok('AND IT SAYS THE FEE IS ON TOP',
     /1% platform fee is charged on top/.test(words(html)),
     'a signatory who thinks R10 000 leaves the wallet when R10 100 does has '
     + 'approved the wrong number');
  ok('and that capital is at risk',
     /Capital is at risk/.test(words(html)));

  /* The cheapest pool, so the amount the form opens on is one the group can
     actually meet. */
  const two = await build([PRODUCT()],
    [POOL({ id: 'POOL-DEAR', min_investment: 50000 }), POOL({ id: 'POOL-CHEAP', min_investment: 1000 })]);
  ok('AND IT IS THE CHEAPEST OPEN POOL OF THAT PRODUCT',
     /raiseStokvelInvestment\('SA-1','POOL-CHEAP'\)/.test(two.html),
     'opening the form on a pool the group cannot afford is a dead end one '
     + 'tap in: ' + two.html.slice(-300));
}

/* ══ 2b. EVERY KIND OF PRODUCT, not just the one the fixture had ═══ */
console.log('\nand it draws an ethical & interest-free product too');
{
  /* THIS IS THE ROW THAT TOOK THE LIVE PORTAL DOWN.
   *
   * _svProductCard was lifted out of renderProductsGrid and kept a
   * reference to that function's `const cat`, which is not in scope out
   * here. Every call threw ReferenceError and the whole Invest grid came
   * back as "Could not load pools" — for every client, on production.
   *
   * THE ASSERTIONS ABOVE DROVE THIS FUNCTION AND PASSED. The reference
   * sits inside `eif && cat !== 'eif'`, so it is only reached for a
   * product that is ethical and interest-free, and every fixture here was
   * cattle. A short circuit hid an undefined variable, and only data
   * nobody had tested with would reach it. Production had that data.
   *
   * So each kind of product is drawn, and the tag is checked both ways:
   * it says "interest-free" where that is news, and not inside the
   * section where every card already is. */
  const P = portal();
  const EIF = PRODUCT({ category: 'eif', label: 'Ethical Cattle' });

  for (const [what, prod, category] of [
    ['a standard product',              PRODUCT(), 'all'],
    ['AN INTEREST-FREE PRODUCT',        EIF,       'all'],
    ['one inside the interest-free tab', EIF,      'eif'],
    ['one with no category set at all',  EIF,      undefined],
  ]) {
    let html = null, threw = null;
    try {
      P.PORTAL = { pools: [POOL()], investor: {},
                   ...(category === undefined ? {} : { marketCategory: category }) };
      html = P._svProductCard(prod, [POOL()]);
    } catch (e) { threw = e.message; }
    ok(`${what} draws without throwing`, threw === null,
       'the card renderer must not depend on a variable that belongs to '
       + 'the function it was extracted from: ' + threw);
    if (html === null) continue;
    const tagged = /eif-tag/.test(html);
    const expected = prod === EIF && category !== 'eif';
    ok(`  and the interest-free tag is ${expected ? 'shown' : 'not shown'}`,
       tagged === expected,
       'inside the interest-free section every card is interest-free, so '
       + 'the tag is noise; outside it, it is the point');
  }
}

/* ══ 3. Only what can really be asked for ══════════════════════════ */
console.log('\nand it lists only what the group could actually ask for');
{
  const none = await build([PRODUCT({ product_type: 'solar', label: 'Solar' })], [POOL()]);
  ok('A PRODUCT WITH NO OPEN POOL IS NOT OFFERED',
     !/Solar/.test(words(none.html)),
     'an overview of something they cannot buy, and the request form would '
     + 'refuse it: ' + words(none.html).slice(0, 200));

  const closed = await build([PRODUCT()], [POOL({ status: 'closed' })]);
  ok('and nor is a pool that is closed',
     /Nothing is open to new money/.test(words(closed.html)), words(closed.html));

  const inactive = await build([PRODUCT({ is_active: false })], [POOL()]);
  ok('and nor is a product that is switched off',
     /Nothing is open to new money/.test(words(inactive.html)), words(inactive.html));

  const empty = await build([], []);
  ok('with nothing at all it says so, and points at the notice account',
     /Nothing is open to new money/.test(words(empty.html))
     && /notice account/.test(words(empty.html)), words(empty.html));
}

/* ══ 4. It survives an empty products table ════════════════════════ */
console.log('\nand it does not go blank when the products table is empty');
{
  const { html } = await build([], [POOL()]);
  ok('THE POOLS THEMSELVES STAND IN',
     /cattle/i.test(words(html)) && !/Nothing is open/.test(words(html)),
     'the marketplace falls back the same way; a tab that goes blank when '
     + 'there IS something to invest in is the worse failure: '
     + words(html).slice(0, 240));

  const P = portal();
  P.PORTAL = { pools: [POOL()] };
  P._getPortalProducts = async () => { throw new Error('offline'); };
  const out = await P._svOpenToGroup('SA-1');
  ok('and a products feed that fails does not take the tab with it',
     /cattle/i.test(words(out)),
     'the group still sees what it can invest in: ' + words(out).slice(0, 200));
}

/* ══ 5. Nothing anybody typed becomes markup ═══════════════════════ */
console.log('\nand nothing in a product record becomes part of the page');
{
  const { html } = await build(
    [PRODUCT({ label: '<img src=x onerror=alert(1)>', headline: '<script>alert(2)</script>' })],
    [POOL()]);
  ok('A PRODUCT NAME IS DRAWN AS A NAME',
     !/<script/i.test(html) && !/<img/i.test(html),
     'staff type these: ' + html.slice(0, 300));
  ok('and the text is still there to read',
     /&lt;script&gt;|&lt;img/.test(html), 'escaping must not delete it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
