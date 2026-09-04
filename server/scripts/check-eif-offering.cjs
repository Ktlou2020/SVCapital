#!/usr/bin/env node
/* The Ethical and Interest-Free offering.
 *
 * EIF products are ordinary rows in `products` carrying category = 'eif'. They
 * are pooled, filled, invested in and matured by the machinery every other
 * product uses — that is the design, and it is what keeps this an offering
 * rather than a second platform. What is specific to it is presentation,
 * vocabulary, and one piece of behaviour that is not cosmetic at all.
 *
 * THE ONE THAT MATTERS. The platform imports interest from 3PIM each period
 * and credits it to investor wallets and sub-accounts. An EIF client's money
 * sits in that same wallet. Without the election, the platform selling the
 * alternative to riba would be paying riba into the account of the client who
 * came for it — as a line on a statement they never asked for. So:
 *
 *   · the preview marks a declining client's row `interest_free` and leaves
 *     the amount out of the total;
 *   · the apply RE-READS the election from the database at the moment money
 *     moves, because `items` is a payload the browser sends back and a
 *     preview taken an hour ago cannot be trusted to still be true.
 *
 * The rest is language. A Murabaha's return is a share of a trading profit; a
 * screen that calls it a "target return p.a." has the number right and the
 * word wrong, and the word is the reason the client is on that screen. So the
 * labels are asserted too.
 *
 * And the claim. The platform holds no Sharia certificate. The copy says
 * review is under way and claims nothing further, in the banner and in the
 * FAQ row, and this check fails if either starts claiming otherwise — that is
 * the kind of sentence that gets added in a hurry by someone who assumes it
 * must be true by now.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-eif-offering.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
/* Comments blanked, not removed: a negative assertion that matches the
   explanation of its own fix is the mistake this repo has made before. */
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const CORE   = read('js/portal-core.js');
const SETUP  = read('server/db/setup.js');
const INT    = read('server/routes/interest.js');
const PRODR  = read('server/routes/products.js');
const CSS    = read('portal/css/portal-premium.css');
const ADMINJ = read('admin/js/admin.js');
const ADMINH = read('admin/index.html');

console.log('\nthe offering is a category, not a second platform');
{
  ok('products carries a category, defaulting to standard',
     /ALTER TABLE products ADD COLUMN category TEXT DEFAULT 'standard'/.test(SETUP) &&
     /category\s+TEXT DEFAULT 'standard'/.test(SETUP),
     'both the CREATE TABLE and the migration — one without the other leaves ' +
     'either a new database or every existing one without the column');

  ok('the three structures are seeded',
     ['eif_murabaha', 'eif_ijara', 'eif_mudarabah'].every(t => SETUP.includes(t)));

  /* seedProducts() returns the moment `products` has any row, so a product
     added to DEFAULT_PRODUCTS alone reaches a fresh database and no existing
     one. Step 12 was the same mistake in a different table. */
  ok('and installed by a setup step, not only by the seed',
     /await step\("13\. Install the Ethical and Interest-Free offering"/.test(SETUP) &&
     /for \(const p of EIF_PRODUCTS\)[\s\S]{0,600}ON CONFLICT \(product_type\) DO NOTHING/.test(SETUP),
     'seedProducts skips a table that already has rows — a seed-only addition ' +
     'would never reach production');

  /* strip() first. Without it this matched the step's own comment — which
     says "ON CONFLICT (product_type) DO NOTHING" while explaining why — and
     passed cheerfully against a step whose SQL had been changed to DO UPDATE.
     A check that reads the explanation of a fix instead of the fix is worth
     less than no check, because it is trusted. */
  const step13 = strip((SETUP.match(/await step\("13\.[\s\S]*?\n    \}\);/) || [''])[0]);
  ok('the install is idempotent and does not overwrite an edited product',
     step13.length > 500 &&
     /ON CONFLICT \(product_type\) DO NOTHING/.test(step13) &&
     !/ON CONFLICT \(product_type\) DO UPDATE/.test(step13),
     'DO UPDATE here would undo every change an admin had made, on every reboot');

  ok('nothing is left with a NULL category',
     /UPDATE products SET category = 'standard' WHERE category IS NULL/.test(SETUP),
     'a NULL category shows in neither grid, which on the portal looks exactly ' +
     'like a deleted product');
}

console.log('\nthe portal presents it, and hides it when it is switched off');
{
  ok('the section exists only while an active EIF product does',
     /function _eifIsLive\(\)\s*\{\s*return _eifProducts\(\)\.length > 0/.test(CORE) &&
     /function _eifProducts\(\)[\s\S]{0,200}p\.is_active && _isEifProduct\(p\)/.test(CORE),
     'is_active is the on/off switch — there is no second flag, so this is what ' +
     'takes the offering off the portal');

  ok('the tabs are not drawn when it is not live',
     /if \(!_eifIsLive\(\) \|\| _selectedProductType\) \{ host\.innerHTML = ''; host\.style\.display = 'none'; return; \}/.test(CORE));

  ok('both shells carry the tab host',
     read('portal/index.html').includes('id="mktCategoryTabs"') &&
     read('mobile/src/index.html').includes('id="mktCategoryTabs"'),
     'the app and the web portal share portal-core, so a host missing from ' +
     'either one silently drops the section on that surface');

  ok('the EIF tab excludes, and All products includes',
     /if \(cat === 'eif' && !_isEifProduct\(p\)\) return false;/.test(CORE) &&
     !/cat === 'all' && _isEifProduct/.test(CORE),
     'an EIF product is a product — a client browsing everything should see it, badged');

  ok('changing category closes an open product detail',
     /function filterMarketCategory[\s\S]{0,400}_selectedProductType = null;/.test(CORE),
     'otherwise a conventional product stays open inside the EIF section');

  ok('the marketplace title works on both shells',
     /section-banner__title'\)\s*\n?\s*\|\|\s*document\.querySelector\('#view-marketplace \.mkt-hero__title'\)/.test(CORE),
     'the app titles this view with .mkt-hero__title and the web with ' +
     '.section-banner__title — reading only one leaves the other stuck on ' +
     '"Investment Products" inside the EIF section');
}

console.log('\nand it says profit share, not interest');
{
  ok('EIF products get their own rate label',
     /if \(_isEifProduct\(p\)\)[\s\S]{0,600}TARGET PROFIT SHARE P\.A\./.test(CORE));

  /* An early draft appended the term to the EIF label as short_term does,
     which read "TARGET PROFIT SHARE (36 MO)" beside 12.5% on a three-year
     lease — saying the lease pays 12.5% over its life rather than annually.
     The suffix belongs to short_term, whose stored rate really is a period
     rate. */
  ok('and no period suffix, because those rates are annual',
     !/TARGET PROFIT SHARE \$\{|TARGET PROFIT SHARE \(\$\{|PROFIT SHARE ACHIEVED \$\{/.test(strip(CORE)),
     'a (36 MO) suffix on an annual rate understates a three-year lease by two thirds');

  ok('the past-performance tile follows',
     /Avg profit share p\.a\.' : 'Avg return p\.a\./.test(CORE));

  ok('the word interest appears in the section only where it is the subject',
     !/TARGET RETURN[\s\S]{0,80}_isEifProduct/.test(CORE));
}

console.log('\nthe interest election is real, and is checked where the money moves');
{
  ok('investors carry the election',
     /ALTER TABLE investors ADD COLUMN interest_free_election BOOLEAN DEFAULT false/.test(SETUP));

  ok('a client can read and set their own, and only their own',
     /router\.get\('\/eif\/election', requireAuth/.test(PRODR) &&
     /router\.put\('\/eif\/election', requireAuth/.test(PRODR) &&
     !/\/eif\/election\/:/.test(PRODR),
     'an id in the path would let one client set another\'s');

  ok('and it reads the investorId claim, not investor_id',
     /req\.user\.investorId \|\| req\.user\.investor_id/.test(PRODR),
     'signToken writes investorId; reading investor_id alone finds nothing and ' +
     'falls through to the users-table uuid, which matches no investor row');

  ok('the preview carries the election on both wallet shapes',
     /COALESCE\(p\.interest_free_election, false\) AS interest_free_election/.test(INT) &&
     /COALESCE\(interest_free_election, false\) AS interest_free_election/.test(INT),
     'a sub-account holds the same client\'s money — crediting it would defeat ' +
     'the choice exactly as crediting the main wallet would');

  ok('a declining client reads as declined, not as zero',
     /if \(declinedInterest\) \{[\s\S]{0,400}status: 'interest_free'/.test(INT),
     'the amount is real and is being withheld on instruction — a different ' +
     'fact from there being nothing to pay');

  ok('and the withheld amount is reported rather than disappearing',
     /declined,\s*\n\s*declined_total:/.test(INT) &&
     /summary\.declined/.test(ADMINJ),
     'money not paid on instruction must be visible to whoever runs the ' +
     'distribution');

  /* The heart of it. `items` is whatever the browser posts back, from a
     preview that may be hours old. */
  ok('the apply re-reads the election from the database',
     /SELECT id FROM investors\s*\n?\s*WHERE id = ANY\(\$1::text\[\]\) AND COALESCE\(interest_free_election, false\) = true/.test(INT),
     'trusting the posted rows would credit a client who opted out after the ' +
     'preview was taken');

  ok('and filters the credit list with it',
     /const toCredit = posted\.filter\(i => !declinedSet\.has\(i\.investor_id\)\)/.test(INT));

  ok('the client-facing toggle exists',
     /function toggleEifElection/.test(CORE) && /class="eif-switch/.test(CORE));

  ok('a failed read shows as unknown rather than as off',
     /PORTAL\.eifElection = null;/.test(CORE) &&
     /eif-election__err/.test(CORE),
     'a toggle drawn "off" because the request failed tells the client they ' +
     'are receiving interest when nobody knows whether they are');
}

console.log('\nthe FAQs are rows, and the claim is the one we can make');
{
  ok('there is a product_faqs table',
     /CREATE TABLE IF NOT EXISTS product_faqs/.test(SETUP));
  ok('it is readable without a login and editable in the console',
     /router\.get\('\/faqs'/.test(PRODR) &&
     /product_faqs:\s*'id'/.test(read('server/routes/tables.js')) &&
     /'products', 'product_faqs'/.test(read('server/routes/tables.js')),
     'the answers describe how a structure avoids riba — whoever is ' +
     'accountable for that wording has to be able to fix it without a deploy');
  ok('and only active rows are served',
     /WHERE is_active = true/.test(PRODR));

  const seeded = (SETUP.match(/const EIF_FAQS = \[[\s\S]*?\n\];/) || [''])[0];
  ok('the seeded set covers what a client asks first',
     /interest-free/i.test(seeded) && /certified/i.test(seeded) &&
     /excluded/i.test(seeded) && /platform fee/i.test(seeded) &&
     /loss/i.test(seeded));

  /* No certificate exists. Both places that talk about governance say so. */
  const banner = (CORE.match(/function _eifBannerHtml\(\)[\s\S]*?\n\}/) || [''])[0];
  ok('the banner claims no certificate',
     /Sharia advisory review is under way/.test(banner) &&
     /do not yet hold a Sharia certificate/i.test(banner) &&
     !/Sharia[- ]certified|Sharia compliant|fully compliant/i.test(banner),
     'the platform does not hold one');
  ok('and neither does the FAQ',
     /Not yet, and we will not say otherwise/.test(seeded) &&
     !/is Sharia certified\.|fully Sharia compliant/i.test(seeded));
}

console.log('\nthe look and feel stays inside the CI');
{
  ok('the accent is the CI lime',
     /function EIF_ACCENT\(\)\s*\{ return '#65ed00'; \}/.test(CORE),
     'the CI palette is fixed — a new hue for a new section is how a brand ' +
     'stops being one');

  const palette = read('js/api.js');
  ok('and that colour really is in the CI palette',
     /ciProductPalette:[^\]]*#65ed00/.test(palette));

  /* One canonical purple, and no second brand colour smuggled in beside it. */
  const eifCss = (CSS.match(/Ethical and Interest-Free \(EIF\)[\s\S]*$/) || [''])[0];
  const hexes = [...new Set((strip(eifCss).match(/#[0-9a-fA-F]{6}/g) || []).map(h => h.toLowerCase()))];
  const allowed = ['#65ed00', '#0d1a00', '#1a1a1a'];
  ok('the EIF stylesheet introduces no colour of its own',
     hexes.every(h => allowed.includes(h)),
     `found ${hexes.filter(h => !allowed.includes(h)).join(', ')} — everything ` +
     `else must come through a CI variable`);

  ok('the section is styled once, where both surfaces read it',
     /\.eif-banner\b/.test(CSS) && /\.mkt-cat-tab\b/.test(CSS) &&
     !fs.existsSync(path.join(ROOT, 'mobile/src/css/portal-premium.css')),
     'the app loads portal/css/portal-premium.css directly since the CSS fork ' +
     'was removed — a second copy here is how that fork started');

  /* One mark, defined once. It is drawn in three places — the category tab,
     the section banner, and the badge an EIF product carries out in the
     all-products grid — and the three disagreeing is how a section stops
     looking like one thing. */
  ok('the mark is defined in one place',
     /function EIF_ICON\(\)\s*\{ return 'fa-[\w-]+'; \}/.test(CORE));
  {
    const eifMarkup = [
      (CORE.match(/function renderMarketCategoryTabs\(\)[\s\S]*?\n\}/) || [''])[0],
      (CORE.match(/function _eifBannerHtml\(\)[\s\S]*?\n\}/) || [''])[0],
      (CORE.match(/class="eif-tag"[^`]*/) || [''])[0],
    ].join('\n');
    ok('and every place that draws it reads that one function',
       (eifMarkup.match(/fa-solid \$\{EIF_ICON\(\)\}/g) || []).length === 3 &&
       !/fa-solid fa-(mosque|leaf)/.test(eifMarkup),
       'a hard-coded icon in one of the three drifts the moment the other two change');
  }
}

console.log('\nthe homepage carries it, on the same switches');
{
  const HOME  = read('index.html');
  const MAIN  = read('js/main.js');
  const HOMECSS = read('css/home-ci.css');

  ok('there is a section, and it starts hidden',
     /<section class="eif-section" id="eif" style="display:none">/.test(HOME),
     'shown by main.js once the products are known — a section that paints ' +
     'before the fetch flashes an offering that may be switched off');

  ok('and so does its nav link',
     /id="navEifLink" style="display:none"/.test(HOME));

  ok('the cards are keyed by product_type',
     ['eif_murabaha', 'eif_ijara', 'eif_mudarabah']
       .every(t => HOME.includes(`data-product="${t}"`)),
     'data-product is what _applyLiveProductAverages resolves against, so ' +
     'these get the achieved average, the admin colour and the admin copy ' +
     'without any homepage code specific to them');

  ok('and they are in homeMap, so that machinery reaches them',
     /eif_murabaha:\s*\{ types: \['eif_murabaha'\],\s*primary: 'eif_murabaha' \}/.test(MAIN) &&
     /eif_mudarabah:\s*\{ types: \['eif_mudarabah'\]/.test(MAIN));

  ok('the section follows its cards',
     /const eifVisible = EIF_TYPES\.some\(resolveVisible\)/.test(MAIN) &&
     /eifSection\.style\.display = eifVisible \? '' : 'none'/.test(MAIN) &&
     /eifNav\.style\.display = eifVisible \? '' : 'none'/.test(MAIN),
     'hiding the cards but leaving the section is a header, four principles ' +
     'and a governance note about an offering that is not there');

  /* The risk pills belong to #products. Unscoped, choosing "Low" emptied a
     section they have nothing to do with. */
  ok('the risk filter is scoped to the products section',
     /querySelectorAll\('#products \.products-grid \.product-card'\)/.test(MAIN),
     'the EIF cards sit in their own .products-grid');

  ok('the FAQs are fetched, not a second copy in the markup',
     /fetch\('\/api\/products\/faqs\?category=eif'\)/.test(MAIN) &&
     !/What makes these investments interest-free/.test(HOME),
     'a static copy is a second thing to correct when the Sharia review ' +
     'concludes, and the one nobody remembers');

  ok('the homepage makes the same claim as the portal',
     /Sharia advisory review is under way/.test(HOME) &&
     /do not yet hold a Sharia certificate/i.test(HOME) &&
     !/Sharia[- ]certified\b|fully Sharia compliant/i.test(HOME));

  /* _applyLiveProductAverages paints each card's stat value and icon with the
     product's colour, inline. #65ed00 on a white card is about 1.7:1 — the
     headline figure would be the least legible thing on the card. */
  ok('the accent never becomes body text on the light homepage',
     /\.product-card--eif \.stat__value--gold \{ color: var\(--eif-ink\) !important; \}/.test(HOMECSS) &&
     /--eif-ink:\s*#2f6b00/.test(HOMECSS),
     'only !important beats the inline style the live sync writes');

  const eifCss = (HOMECSS.match(/ETHICAL AND INTEREST-FREE \(EIF\)[\s\S]*$/) || [''])[0];
  const hexes = [...new Set((strip(eifCss).match(/#[0-9a-fA-F]{6}/g) || []).map(h => h.toLowerCase()))];
  const allowed = ['#65ed00', '#2f6b00', '#fbfef8', '#ffffff', '#f0f2f5', '#fff'];
  ok('and the homepage block introduces no colour of its own either',
     hexes.every(h => allowed.includes(h)),
     `found ${hexes.filter(h => !allowed.includes(h)).join(', ')}`);
}

console.log('\nand the console can create them like any other product');
{
  ok('the product form has an offering field',
     /id="prodCategory"/.test(ADMINH) &&
     /<option value="eif">/.test(ADMINH));
  ok('it is populated when editing',
     /getElementById\('prodCategory'\)\.value\s*=\s*p\.category \|\| 'standard'/.test(ADMINJ));
  ok('it is saved',
     /category:\s*document\.getElementById\('prodCategory'\)\.value \|\| 'standard'/.test(ADMINJ));
  ok('and a new product defaults to standard rather than to blank',
     /getElementById\('prodCategory'\)\.value = 'standard';/.test(ADMINJ),
     'the New Product handler blanks every field — left blank, the product ' +
     'would appear in neither grid');
}

/* ── Against a real database ──────────────────────────────────────────────
   Everything above reads source. This runs the setup and looks at the rows,
   because "the step exists" and "the step works" are different claims. */
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\n  (skipping the database half — DATABASE_URL not set)');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  const { Pool } = require('pg');
  const SSL = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
  pool.on('error', () => {});

  try {
    console.log('\nand the rows are actually there');
    const { rows: prods } = await pool.query(
      `SELECT product_type, category, is_active, min_investment, term_months, benchmark_rate
         FROM products WHERE category = 'eif' ORDER BY sort_order`);
    ok('the three structures are installed', prods.length === 3,
       `found ${prods.length}: ${prods.map(p => p.product_type).join(', ')}`);
    ok('and are active, so the section is visible',
       prods.every(p => p.is_active));
    ok('each has a minimum and a term a pool can be built from',
       prods.every(p => Number(p.min_investment) > 0 && Number(p.term_months) > 0),
       JSON.stringify(prods));
    ok('and a target to show',
       prods.every(p => Number(p.benchmark_rate) > 0));

    const { rows: faqs } = await pool.query(
      `SELECT question FROM product_faqs WHERE category = 'eif' AND is_active = true`);
    ok('the FAQs are installed', faqs.length >= 8, `found ${faqs.length}`);

    /* The install must survive a re-run: a container reboots and autoSetup
       runs again on every one. */
    const before = await pool.query(`SELECT count(*)::int AS n FROM products`);
    await pool.query(`UPDATE products SET label = 'EDITED BY ADMIN' WHERE product_type = 'eif_ijara'`);
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
    const qLog = console.log, qErr = console.error;
    console.log = () => {}; console.error = () => {};
    let rerun;
    try { rerun = await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); }
    finally { console.log = qLog; console.error = qErr; }

    /* The re-run has to have actually run. A step that throws is recorded and
       swallowed, and the two assertions below would then pass because nothing
       happened — which is the opposite of what they claim to be testing. */
    const step13Failed = ((rerun && rerun.failures) || [])
      .find(f => /Ethical and Interest-Free/i.test(f.name || ''));
    ok('the re-run reached the EIF step', !step13Failed,
       step13Failed ? step13Failed.message : '');

    const after = await pool.query(`SELECT count(*)::int AS n FROM products`);
    const { rows: edited } = await pool.query(
      `SELECT label FROM products WHERE product_type = 'eif_ijara'`);
    ok('re-running setup adds nothing twice', before.rows[0].n === after.rows[0].n,
       `${before.rows[0].n} → ${after.rows[0].n}`);
    ok('and does not undo an edit made in the console',
       edited[0] && edited[0].label === 'EDITED BY ADMIN',
       'DO NOTHING, not DO UPDATE — otherwise every reboot reverts the catalogue');

    /* And the election actually withholds. */
    await pool.query(`DELETE FROM investors WHERE id IN ('EIF-YES','EIF-NO')`);
    await pool.query(
      `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance, interest_free_election)
       VALUES ('EIF-YES','Declines','Interest','eifyes@x.test','active', 1000, true),
              ('EIF-NO','Takes','Interest','eifno@x.test','active', 1000, false)`);
    const { rows: elect } = await pool.query(
      `SELECT id FROM investors
        WHERE id = ANY($1::text[]) AND COALESCE(interest_free_election, false) = true`,
      [['EIF-YES', 'EIF-NO']]);
    ok('the apply-time query finds exactly the client who declined',
       elect.length === 1 && elect[0].id === 'EIF-YES',
       JSON.stringify(elect));
    await pool.query(`DELETE FROM investors WHERE id IN ('EIF-YES','EIF-NO')`);
  } catch (err) {
    fail++;
    console.log(`  ✗ threw: ${err.message}`);
  } finally {
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
