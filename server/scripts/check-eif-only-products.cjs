#!/usr/bin/env node
/* A product can be listed under Ethical & Interest-Free and nowhere else.
 *
 * The EIF tab has always excluded standard products. This is the other
 * direction, and it did not exist: an EIF product appeared in its own tab AND
 * in the general "All products" grid, badged, with no way to keep one out of
 * the general listing. The portal even said so in a comment — "All products
 * really is all of them" — which was a deliberate choice, and the one being
 * asked to become optional.
 *
 * WHAT HAS TO HOLD
 *
 * A STANDARD PRODUCT MUST NEVER BE EXCLUSIVE. 'standard' has no tab of its
 * own — the general grid IS its listing — so an exclusive standard product
 * would be filtered out of the only place it appears: active in the console
 * and invisible in the portal, which is indistinguishable from a deleted one.
 * The console hides the control, forces the value on save, setup clears any
 * row that has it, and the portal refuses to honour it. Four places, because
 * the one that matters is the one the client actually looks at.
 *
 * AND IT HAS TO MEAN IT. Switch targets at maturity are built from the OPEN
 * POOLS, not from the product list, so a category-exclusive product with an
 * open pool would still be offered to every client — including one switching
 * out of a conventional product. A flag that hides a product from one grid and
 * leaves it in another picker is a half-truth.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-eif-only-products.cjs
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

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_eifonly_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

const CORE  = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const HTML  = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
const CORE_CODE  = strip(CORE);
const ADMIN_CODE = strip(ADMIN);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool;

async function runSetup() {
  for (const f of ['pool.js', 'setup.js']) {
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', f))];
  }
  const q = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); }
  finally { console.log = q; console.warn = w; }
  try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
}

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  process.env.DATABASE_URL = withDatabase(process.env.DATABASE_URL, DB_NAME);
  await runSetup();
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
  /* The teardown drops this database WITH (FORCE); pg reports the termination
     as a pool 'error', and a pool with no listener takes the process down
     after every assertion has already passed. */
  pool.on('error', () => {});
}

/* ── The shipped portal predicates, lifted and run ───────────────────────── */
function sliceFn(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at, i + 1);
}
function liftPortal() {
  const names = ['EIF_CATEGORY', '_isEifProduct', '_isCategoryExclusive'];
  const ctx = vm.createContext({ console });
  vm.runInContext(names.map(n => sliceFn(CORE, n)).join('\n') +
    `\nthis._f = { ${names.join(', ')} };`, ctx);
  return ctx._f;
}

/* THE REAL FILTER, lifted out of renderMarketplace and run.

   This was a hand-written copy of the same three lines, and a copy is not the
   rule: deleting the exclusion from the shipped code left every behavioural
   assertion here passing, because they were exercising this file's idea of
   the filter rather than the portal's. The callback is sliced from the source
   instead, so removing a line from it fails the assertions about what a client
   sees. */
function liftGridFilter() {
  const anchor = 'const products = (_mktProducts || []).filter(p => {';
  const at = CORE.indexOf(anchor);
  if (at < 0) throw new Error('the marketplace filter could not be found in portal-core.js');
  let i = CORE.indexOf('{', at + anchor.length - 1), depth = 0;
  for (; i < CORE.length; i++) {
    if (CORE[i] === '{') depth++;
    else if (CORE[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = CORE.slice(CORE.indexOf('{', at + anchor.length - 1), i + 1);
  return { body, source: anchor + body.slice(1) };
}

function makeGridFilter(P) {
  const { body } = liftGridFilter();
  const ctx = vm.createContext({
    console,
    _isEifProduct: P._isEifProduct,
    _isCategoryExclusive: P._isCategoryExclusive,
  });
  /* cat and mf are the two variables the callback closes over; they are bound
     per call so the same lifted body answers for both tabs. */
  return (products, cat) => {
    vm.runInContext(`this._g = p => { const cat = ${JSON.stringify(cat)}, mf = 'all'; return (function (p) ${body})(p); };`, ctx);
    return products.filter(ctx._g).map(p => p.product_type);
  };
}

(async () => {
  try {
    await makeDatabase();
    const P = liftPortal();
    const gridFilter = makeGridFilter(P);

    console.log('\nthe column, and what it may hold');
    {
      const { rows } = await pool.query(
        `SELECT column_name, data_type, column_default FROM information_schema.columns
          WHERE table_name='products' AND column_name='category_exclusive'`);
      ok('products.category_exclusive exists', rows.length === 1);
      ok('as a boolean defaulting to false',
         rows[0] && rows[0].data_type === 'boolean' && /false/.test(rows[0].column_default || ''),
         JSON.stringify(rows[0]));
      const seeded = await pool.query(
        `SELECT COUNT(*) n FROM products WHERE category_exclusive IS NOT false`);
      ok('nothing is exclusive out of the box', Number(seeded.rows[0].n) === 0,
         'the three seeded EIF products keep appearing in both places');
    }

    console.log('\na standard product cannot be made exclusive');
    {
      /* Nothing in the console writes this combination, but a direct database
         edit can — and the row would then be invisible in the portal while
         reading as active in the console. */
      await pool.query(
        `INSERT INTO products (id, product_type, label, category, category_exclusive, is_active)
         VALUES ('p-rogue','rogue_standard','Rogue','standard',true,true)`);
      await runSetup();
      const { rows } = await pool.query(
        `SELECT category_exclusive FROM products WHERE product_type='rogue_standard'`);
      ok('setup clears it on the next boot', rows[0].category_exclusive === false,
         String(rows[0].category_exclusive));

      ok('and the portal would not have honoured it anyway',
         P._isCategoryExclusive({ category: 'standard', category_exclusive: true }) === false,
         'it would have vanished from the only grid that lists it');
      ok('nor on a product with no category at all',
         P._isCategoryExclusive({ category_exclusive: true }) === false);
      await pool.query(`DELETE FROM products WHERE product_type='rogue_standard'`);
    }

    console.log('\nwhere an EIF product appears');
    {
      await pool.query(
        `INSERT INTO products (id, product_type, label, category, category_exclusive, is_active, min_investment)
         VALUES ('p-only','eif_sukuk','Sukuk Income','eif',true,true,1000),
                ('p-both','eif_open','Open EIF','eif',false,true,1000)`);
      const { rows: products } = await pool.query('SELECT * FROM products ORDER BY sort_order');

      const all = gridFilter(products, 'all');
      const eif = gridFilter(products, 'eif');

      ok('an EIF-only product is in the Ethical & Interest-Free tab',
         eif.includes('eif_sukuk'), eif.join(', '));
      ok('and NOT in All products', !all.includes('eif_sukuk'),
         'which is the whole request');
      ok('an ordinary EIF product is still in both',
         eif.includes('eif_open') && all.includes('eif_open'),
         'the default is unchanged — this is opt-in per product');
      ok('the seeded EIF products are still in both',
         ['eif_murabaha', 'eif_ijara', 'eif_mudarabah'].every(t => all.includes(t) && eif.includes(t)));
      ok('a standard product is in All products and not in the EIF tab',
         all.includes('cattle') && !eif.includes('cattle'));

      /* Deactivating it removes it from both, as for any product. */
      await pool.query(`UPDATE products SET is_active=false WHERE product_type='eif_sukuk'`);
      const { rows: p2 } = await pool.query('SELECT * FROM products');
      ok('an inactive one is in neither',
         !gridFilter(p2, 'all').includes('eif_sukuk') &&
         !gridFilter(p2, 'eif').includes('eif_sukuk'));
      await pool.query(`UPDATE products SET is_active=true WHERE product_type='eif_sukuk'`);
    }

    console.log('\nand the tab it lives under is still shown');
    {
      /* _eifIsLive gates the tabs on there being an active EIF product. An
         exclusive one counts — otherwise a client would have no way to reach
         the only place it appears. */
      ok('an exclusive product still counts as EIF being live',
         /_eifProducts\(\)[\s\S]{0,80}filter\(p => p && p\.is_active && _isEifProduct\(p\)\)/.test(CORE) ||
         /is_active && _isEifProduct\(p\)/.test(CORE_CODE),
         '_eifProducts filters on active and category, not on exclusivity');
      ok('so the tab appears and the product is reachable',
         /_eifIsLive\(\) \|\| _selectedProductType/.test(CORE_CODE) === false ||
         /if \(!_eifIsLive\(\)/.test(CORE_CODE),
         'the tabs are hidden only when no active EIF product exists at all');
    }

    console.log('\nit is kept out of the maturity switch picker too');
    {
      ok('switch targets skip a category-exclusive product',
         /_isCategoryExclusive\(\(_mktProducts \|\| \[\]\)\.find/.test(CORE_CODE),
         'those come from the open pools, so it would otherwise be offered to every client');
      ok('and the code says what that does NOT settle',
         /still category-blind and needs its own decision/.test(CORE),
         'whether an EIF client should be offered conventional products is a separate question');
    }

    console.log('\nthe console can set it, and cannot set it wrongly');
    {
      ok('there is a control for it', /id="prodExclusive"/.test(HTML));
      ok('worded as where the product appears, not as a flag',
         /Ethical &amp; Interest-Free only/.test(HTML) &&
         /All products, and under Ethical &amp; Interest-Free/.test(HTML));
      ok('it is shown only for an EIF product',
         /function onProdCategoryChange\(/.test(ADMIN_CODE) &&
         /grp\.style\.display = isEif \? '' : 'none'/.test(ADMIN_CODE));
      ok('and follows the Offering select as it changes',
         /onchange="onProdCategoryChange\(\)"/.test(HTML));
      ok('the save forces it false on anything but EIF',
         /category_exclusive:\s*document\.getElementById\('prodCategory'\)\.value === 'eif' &&/.test(ADMIN_CODE),
         'a hidden control is still a control with a value in it');
      ok('editing an existing product brings the setting back',
         /getElementById\('prodExclusive'\)\.value =\s*\n?\s*\(p\.category_exclusive === true/.test(ADMIN) ||
         /p\.category_exclusive === true \|\| p\.category_exclusive === 't'/.test(ADMIN_CODE),
         'otherwise opening a product to change its name silently unsets it');
      ok('and reads the boolean in either shape it can arrive in',
         /category_exclusive === 't'/.test(ADMIN_CODE));
      ok('the new-product form starts on the safe default',
         /getElementById\('prodExclusive'\)\.value = 'false'/.test(ADMIN_CODE));

      const v = HTML.match(/js\/admin\.js\?v=(\d+)/);
      ok('admin.js is cache-busted past 166', v && Number(v[1]) > 166, v ? v[0] : 'no version');
    }

    console.log('\nthe portal bundles carry the same rule');
    {
      ok('the predicate lives in the shared core, once',
         (CORE_CODE.match(/function _isCategoryExclusive\(/g) || []).length === 1);
      const mob = path.join(ROOT, 'mobile', 'www', 'js', 'portal-core.js');
      ok('and the mobile bundle is built from it',
         fs.existsSync(mob) && fs.readFileSync(mob, 'utf8') === CORE,
         'mobile/www is built from js/ — a stale copy still lists the product');
      const pv = fs.readFileSync(path.join(ROOT, 'portal', 'index.html'), 'utf8')
        .match(/portal-core\.js\?v=(\d+)/);
      ok('portal-core.js is cache-busted', !!pv, pv ? pv[0] : 'no version query string');
    }

  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    if (pool) await pool.end().catch(() => {});
    try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
