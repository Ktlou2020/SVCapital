#!/usr/bin/env node
/* Where a product is listed.
 *
 * ASKED FOR: "Give me an option to select for a product to appear under both
 * standard and EIF."
 *
 * The platform already did this — it is what an Ethical & Interest-Free
 * product does by default — but the only control that said so was a second
 * select, hidden until you had already switched Offering to EIF. So the
 * answer to "can it appear in both?" was invisible until after you had
 * changed the thing you were asking about, and it read as a missing feature.
 *
 * Offering is now one select with the three states the two columns can
 * legitimately hold:
 *
 *   standard   category 'standard', not exclusive  → the general grid only
 *   both       category 'eif',      not exclusive  → the general grid AND the tab
 *   eif_only   category 'eif',      exclusive      → the tab only
 *
 * The fourth combination — standard AND exclusive — would filter a product
 * out of the only grid that lists it, leaving it active in the console and
 * invisible in the portal. It is refused in three places and this asserts
 * the form is the first of them.
 *
 * There is deliberately no option for the reverse of "both": a standard,
 * interest-bearing product listed under Ethical & Interest-Free. That tab's
 * whole claim is how the return is earned, and an interest-bearing product
 * sitting in it would make the claim false. Asserted, because it is the one
 * mistake this screen could make that nobody would see in testing.
 *
 * Run: node server/scripts/check-product-offering.cjs
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

const ADMIN_JS   = read('admin/js/admin.js');
const ADMIN_HTML = read('admin/index.html');
const CORE       = read('js/portal-core.js');

/* ── The control the request was about ───────────────────────────────── */
console.log('\nthe Offering select offers all three, without having to change it first');
{
  const at = ADMIN_HTML.indexOf('<select class="form-select" id="prodCategory"');
  const sel = ADMIN_HTML.slice(at, ADMIN_HTML.indexOf('</select>', at));
  ok('the select was found', at > 0 && sel.length > 60);

  const values = [...sel.matchAll(/value="([^"]+)"/g)].map(m => m[1]);
  ok('it carries exactly the three offerings',
     values.length === 3 && values.join(',') === 'standard,both,eif_only',
     JSON.stringify(values));
  ok('AND "BOTH" IS ONE OF THEM, visible without changing anything',
     /value="both"/.test(sel) && /Standard and Ethical/.test(sel),
     sel.replace(/\s+/g, ' ').slice(0, 220));

  /* The hidden second control is gone rather than left to disagree. */
  ok('the separate hidden control is gone',
     !/id="prodExclusive"/.test(ADMIN_HTML) && !/prodExclusive/.test(ADMIN_JS),
     'two controls for one question is how the answer came to be invisible');
  ok('and nothing is display:none on this row any more',
     !/prodExclusiveGroup/.test(ADMIN_HTML + ADMIN_JS));
}

/* ── The mapping, RUN rather than read ───────────────────────────────── */
console.log('\nand each choice writes the pair of columns it stands for');
{
  const from = ADMIN_JS.indexOf('const PROD_OFFERINGS = {');
  const to   = ADMIN_JS.indexOf('function onProdCategoryChange');
  ok('the mapping was found', from > 0 && to > from,
     'a slice that missed it would assert nothing while passing');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(ADMIN_JS.slice(from, to)
    + '\nthis.M = PROD_OFFERINGS; this.of = _prodOfferingOf;', ctx);
  const M = ctx.M;

  ok('standard  → standard, listed everywhere it belongs',
     M.standard.category === 'standard' && M.standard.exclusive === false,
     JSON.stringify(M.standard));
  ok('BOTH      → the EIF offering, NOT kept out of the general grid',
     M.both.category === 'eif' && M.both.exclusive === false,
     JSON.stringify(M.both));
  ok('eif_only  → the EIF offering, kept out of the general grid',
     M.eif_only.category === 'eif' && M.eif_only.exclusive === true,
     JSON.stringify(M.eif_only));

  /* The combination that would make a product invisible. */
  ok('NO CHOICE PRODUCES standard + exclusive',
     !Object.values(M).some(o => o.category === 'standard' && o.exclusive === true),
     JSON.stringify(M) + ' — that pair filters a product out of the only grid '
     + 'that lists it: active here, gone from the portal');
  /* And the reverse of "both", which would be the compliance mistake. */
  ok('and none lists an interest-bearing product under Ethical & Interest-Free',
     !Object.values(M).some(o => o.category === 'standard' && o.exclusive === false
                                  && o !== M.standard),
     'the tab says how the return is earned; a standard product in it makes that false');

  /* THE TABLE HAS TO BE WHAT SAVES. Everything above runs PROD_OFFERINGS,
     which proves the table is right and nothing about whether the form uses
     it — the save could still carry its own copy of the rule and drift from
     the one being tested here. Both columns are read back from the lookup. */
  const save = ADMIN_JS.slice(ADMIN_JS.indexOf('async function saveProduct'),
                              ADMIN_JS.indexOf('risk_profile:', ADMIN_JS.indexOf('async function saveProduct')));
  ok('the saved category comes from the table',
     /category:\s*\(PROD_OFFERINGS\[/.test(save), save.slice(-320));
  ok('and so does category_exclusive',
     /category_exclusive:\s*\(PROD_OFFERINGS\[/.test(save), save.slice(-320));
  ok('with a fallback that cannot invent a fourth combination',
     (save.match(/\|\| PROD_OFFERINGS\.standard\)/g) || []).length === 2,
     'an unknown select value must land on a real pair, not undefined');

  /* Opening a stored row lands on the choice that row actually is. */
  const cases = [
    [{ category: 'standard', category_exclusive: false }, 'standard'],
    [{ category: 'standard' },                            'standard'],
    [{},                                                  'standard'],
    [{ category: 'eif', category_exclusive: false },      'both'],
    [{ category: 'eif' },                                 'both'],
    [{ category: 'eif', category_exclusive: true },       'eif_only'],
    /* A direct database edit stores the Postgres text form. */
    [{ category: 'eif', category_exclusive: 't' },        'eif_only'],
    [{ category: 'eif', category_exclusive: 'true' },     'eif_only'],
    /* The illegal pair, should it already exist in a row. */
    [{ category: 'standard', category_exclusive: true },  'standard'],
  ];
  for (const [row, want] of cases) {
    ok(`a stored ${JSON.stringify(row)} opens on "${want}"`,
       ctx.of(row) === want, ctx.of(row));
  }
  /* Round trip: what it opens on must save back as what it was. */
  ok('and every choice round-trips unchanged',
     Object.keys(M).every(k => ctx.of({ category: M[k].category,
                                        category_exclusive: M[k].exclusive }) === k),
     'opening a product and saving it must not move it to another tab');
}

/* ── What a client actually sees ─────────────────────────────────────── */
console.log('\nand the portal lists it where the choice says');
{
  /* The real predicates, lifted out and run. */
  const from = CORE.indexOf('function _isEifProduct');
  const to   = CORE.indexOf('/* ── How each structure actually earns');
  ok('the portal predicates were found', from > 0 && to > from);
  const ctx = { EIF_CATEGORY: () => 'eif' };
  vm.createContext(ctx);
  vm.runInContext(CORE.slice(from, to)
    + '\nthis.isEif = _isEifProduct; this.isEx = _isCategoryExclusive;', ctx);

  /* The grid composes those two the same way; asserted verbatim so this
     cannot pass while the filter has been rewritten around them. */
  ok('the general grid drops a category-exclusive product',
     /if \(cat === 'all' && _isCategoryExclusive\(p\)\) return false;/.test(CORE), 'js/portal-core.js');
  ok('and the EIF tab drops a standard one',
     /if \(cat === 'eif' && !_isEifProduct\(p\)\) return false;/.test(CORE), 'js/portal-core.js');

  const shows = (p, tab) => {
    if (tab === 'eif' && !ctx.isEif(p)) return false;
    if (tab === 'all' && ctx.isEx(p)) return false;
    return true;
  };
  const row = k => ({ standard: { category: 'standard', category_exclusive: false },
                      both:     { category: 'eif',      category_exclusive: false },
                      eif_only: { category: 'eif',      category_exclusive: true } }[k]);

  ok('standard: in the general grid', shows(row('standard'), 'all'));
  ok('standard: NOT under Ethical & Interest-Free', !shows(row('standard'), 'eif'),
     'the tab is a claim about how the return is earned');

  ok('BOTH: IN THE GENERAL GRID', shows(row('both'), 'all'),
     'this is the half that was asked for and already worked');
  ok('BOTH: AND UNDER ETHICAL & INTEREST-FREE', shows(row('both'), 'eif'));

  ok('eif_only: under Ethical & Interest-Free', shows(row('eif_only'), 'eif'));
  ok('eif_only: and NOT in the general grid', !shows(row('eif_only'), 'all'));
}

/* ── The hint under the select ───────────────────────────────────────── */
console.log('\nand the screen says what each choice does to the wording of the return');
{
  const from = ADMIN_JS.indexOf('const PROD_OFFERINGS = {');
  const to   = ADMIN_JS.indexOf('function onProdCategoryChange');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(ADMIN_JS.slice(from, to) + '\nthis.M = PROD_OFFERINGS;', ctx);
  ok('every choice carries a hint', Object.values(ctx.M).every(o => o.hint && o.hint.length > 40),
     JSON.stringify(Object.keys(ctx.M)));
  /* The consequence somebody choosing "both" would not otherwise expect. */
  ok('and "both" warns that the return is relabelled a profit share',
     /profit share/i.test(ctx.M.both.hint),
     ctx.M.both.hint + ' — it is an EIF product listed in two places, not a '
     + 'standard one with an extra tab, and that changes the wording a client reads');
  ok('the hint is rendered into the page', /id="prodCategoryHint"/.test(ADMIN_HTML)
     && /hint\.innerHTML = o\.hint/.test(ADMIN_JS));
  ok('and it is written on open and on change',
     (ADMIN_JS.match(/onProdCategoryChange\(\);/g) || []).length >= 2,
     'a hint that only appears after you touch the select is the bug again');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
