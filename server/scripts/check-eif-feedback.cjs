#!/usr/bin/env node
/* Two things the client asked for on the Ethical & Interest-Free offering.
 *
 * THE MINIMUM. The Invest page printed products.min_investment. Nobody
 * invests in a product: they invest in a POOL, and the pool carries its own
 * minimum. The two are set in different places in the admin console and they
 * drift — the page offered a Murabaha at R500 while the only open pool would
 * not take under R1 000, and the client found out at the point of paying.
 *
 * THE COLOUR. The lime was hard to keep consistent and measures 1.5:1 on
 * white, so anything set in it had to be darkened by hand before it could be
 * read. #0096ff is the CI blue, already in the palette.
 *
 * The colour half needs a boundary as much as a value. #65ed00 is the
 * PLATFORM's lime — GridFarmer's NDVI scale, quest badges, the solar
 * products, the progress fills — and a search-and-replace across the
 * repository would have repainted all of it. Half of what is asserted below
 * is that the lime is still there where it belongs.
 *
 * Run: node server/scripts/check-eif-feedback.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const CORE = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

function lift(name) {
  const m = CORE.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`, 'm'));
  if (!m) throw new Error(`could not lift ${name}`);
  const ctx = { Math, Number, parseFloat, console };
  vm.createContext(ctx);
  vm.runInContext(m[0] + `\nthis.fn = ${name};`, ctx);
  return ctx.fn;
}
const eifCardMinimum = lift('eifCardMinimum');
const EIF_ACCENT     = lift('EIF_ACCENT');

const contrast = (a, b) => {
  const lum = hex => {
    const c = hex.replace('#', '').match(/../g).map(h => {
      const v = parseInt(h, 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

console.log('\nthe minimum is what a client can actually put in');
{
  const PRODUCT = { min_investment: 500 };
  /* The reported case, exactly. */
  ok('an open pool overrides the product figure',
     eifCardMinimum(PRODUCT, [{ min_investment: 1000 }]).amount === 1000,
     'the page offered R500 and the pool refused anything under R1 000');
  ok('and the cheapest open pool wins when there are several',
     eifCardMinimum(PRODUCT, [{ min_investment: 2500 }, { min_investment: 1000 }]).amount === 1000,
     'the cheapest open pool is the cheapest thing that can be bought today');
  ok('a pool with no minimum of its own is ignored',
     eifCardMinimum(PRODUCT, [{ min_investment: null }, { min_investment: 750 }]).amount === 750);
  ok('and so is one set to zero',
     eifCardMinimum(PRODUCT, [{ min_investment: 0 }]).amount === 500);

  /* Nothing open: there is nothing to buy, so the product's figure is all
     there is — and it is marked rather than stated as fact. */
  const none = eifCardMinimum(PRODUCT, []);
  ok('with nothing open the product figure is used', none.amount === 500);
  ok('and it is marked indicative', none.indicative === true,
     'stating it flatly is how the page came to disagree with the pool');
  ok('a real pool figure is not marked',
     eifCardMinimum(PRODUCT, [{ min_investment: 1000 }]).indicative === false);
  ok('and nothing anywhere does not throw',
     eifCardMinimum({}, []).amount === 0 && eifCardMinimum(null, null).amount === 0);
}

console.log('\nand both places that quote it agree');
{
  const card = CORE.match(/const cardMin = eifCardMinimum\(p, open\);/);
  ok('the product card asks for the pool figure', !!card);
  ok('and no longer prints the product one',
     !/mpc2-metric__val" style="font-size:1\.25rem">\$\{Utils\.rand\(p\.min_investment/.test(CORE),
     'this is the number the client saw');
  ok('the comparison table asks the same question',
     /eifCardMinimum\(p, _openPoolsForProduct\(p\.product_type\)\)/.test(CORE),
     'a table quoting a different minimum from the card above it is worse than either');
  ok('and the indicative case is explained in the footnote',
     /A minimum marked \* is the product's own figure/.test(CORE));
}

console.log('\nthe offering is the CI blue');
{
  ok('the accent is #0096ff', EIF_ACCENT() === '#0096ff', EIF_ACCENT());
  ok('which is already in the CI palette',
     /'#0096ff'/.test(read('js/api.js')) || /#0096ff/.test(read('admin/js/admin.js')),
     'a colour invented for one section is a colour that drifts');

  /* Scanned as a BLOCK, from the section's banner comment to its last rule,
     rather than line by line. A line-by-line filter only sees lines that
     mention eif — so a stray lime in a rule BODY, which is where every tint
     and border in this section lives, slips straight through. It did. */
  /* The two files spell the banner differently; each is matched as written. */
  for (const [f, from] of [['css/home-ci.css', 'ETHICAL AND INTEREST-FREE'],
                           ['portal/css/portal-premium.css', 'Ethical and Interest-Free (EIF)']]) {
    const src   = read(f);
    const start = src.indexOf(from);
    ok(`${f}: the EIF block is findable`, start > 0);
    const lastEif = src.lastIndexOf('eif');
    const end     = src.indexOf('\n}', lastEif) + 2;
    const block   = src.slice(start, end > start ? end : src.length);
    const strays  = block.match(/65ed00|101,\s*237,\s*0|2f6b00|3d8a00/g) || [];
    ok(`${f}: no lime left anywhere in the EIF block`, strays.length === 0,
       `${strays.length} left: ${[...new Set(strays)].join(', ')}`);
    /* And the block really does reach the tints, or the assertion above is
       checking an empty string. */
    ok(`${f}: the block reaches the section's tints`,
       /rgba\(0,\s*150,\s*255|color-mix\(in srgb, #0096ff/.test(block),
       'the slice missed the rules it was meant to cover');
  }

  /* Text set in the accent has to be readable; that is what the ink is for. */
  const ink = (read('css/home-ci.css').match(/--eif-ink:\s*(#[0-9a-f]{6})/i) || [])[1];
  ok('there is a darker ink for text', !!ink, String(ink));
  ok('and it passes AA on white', contrast(ink, '#ffffff') >= 4.5,
     `${ink} is ${contrast(ink, '#ffffff').toFixed(2)}:1`);
  ok('the accent itself is only ever a fill or a rule',
     contrast(EIF_ACCENT(), '#ffffff') < 4.5,
     'if it passed, the ink would be unnecessary and this check is stale');
}

console.log('\nand the platform lime is untouched');
{
  /* A search-and-replace across the repository would have repainted all of
     these. Each is somebody else's green. */
  /* Each is pinned to the LINE that owns the colour, not to the file. "The
     file still contains #65ed00 somewhere" is satisfied by any other line in
     it, and a blanket replace that repainted every solar product went
     straight past an earlier version of this. */
  for (const [f, what, pattern] of [
    ['fund/gridfarmer.html', 'the NDVI scale', /--ndvi[^;]*#65ed00|#65ed00[^;]*--ndvi/],
    ['server/routes/quests.js', 'quest badges', /color: '#65ed00'/],
    ['js/api.js', 'every solar product', /solar:\s*\{[^}]*#65ed00[^}]*\}/],
    ['js/api.js', 'the 7, 6 and 5 year solar products',
      /solar_7yr:[\s\S]{0,200}#65ed00[\s\S]{0,400}solar_5yr:[^}]*#65ed00/],
    ['js/api.js', 'GridFarmer', /gridfarmer:\s*\{[^}]*#65ed00[^}]*\}/],
    ['js/api.js', 'the CI palette itself', /ciProductPalette:[^\]]*#65ed00/],
    ['portal/css/portal-premium.css', 'the --ci-vivid-green token', /--ci-vivid-green:\s*#65ed00/],
    ['portal/css/portal-premium.css', 'the green progress fill', /progress-fill--green[^\n]*#65ed00/],
    ['mobile/src/css/mobile-app.css', 'the XP hero figure', /xp-hero__earned-val[^\n]*#65ed00/],
    ['mobile/src/css/mobile-app.css', 'the completed quest card', /quest-card--done[\s\S]{0,80}#65ed00/],
  ]) {
    ok(`${what} keeps the lime`, pattern.test(read(f)), `${f}: ${pattern}`);
  }
  ok('and GridFarmer is still the lime product it was',
     /icon: 'fa-seedling', color: '#65ed00'/.test(read('server/db/setup.js')));
}

console.log('\nthe recolour reaches databases that already exist');
{
  const setup = read('server/db/setup.js');
  const step = (setup.match(/await step\("20\. Recolour[\s\S]*?\n    \}\);/) || [''])[0];
  ok('there is a step for it', step.length > 0,
     'step 13 installs with ON CONFLICT DO NOTHING, so a new colour reaches only a new database');
  ok('it moves only the three EIF rows',
     /product_type IN \('eif_murabaha','eif_ijara','eif_mudarabah'\)/.test(step));
  ok('and only while they still carry the colour they were installed with',
     /AND color = '#65ed00'/.test(step),
     'an admin who chose their own colour would have it overwritten');
  ok('so running it twice changes nothing the second time',
     /AND color = '#65ed00'/.test(step));
  ok('the seed itself was updated too',
     (setup.match(/color: '#0096ff', badge_class: 'badge--blue'/g) || []).length === 3,
     'a fresh database would install the old colour again');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
