#!/usr/bin/env node
/* The pool edit form must not invent a product type.
 *
 * product_type is the only thing the maturity engine matches a rollover on.
 * maturityCron passes inv.product_type into a query whose sole predicate is
 * `product_type = $1`; it never reads the pool name. So "Cattle Investment -
 * August 2026" does not succeed "Cattle Investment - August 2025" unless their
 * product_type values agree.
 *
 * The edit form loaded that field as:
 *
 *     editPoolType.value = pool.product_type || 'cattle'
 *
 * A migrated pool with an empty product_type therefore displayed "Cattle
 * Investment" — the first option, not the stored value. And because the save
 * writes back whatever the field shows, opening the modal on such a pool and
 * pressing Save silently retyped it as cattle. On a short-term pool that is
 * simply the wrong product, applied without anyone choosing it.
 *
 * Verified in Chromium: assigning a select an unlisted value leaves
 * selectedIndex at -1 and the field blank, while a falsy value fell through
 * the `||` to the default. Both now render honestly.
 *
 * Run: node scripts/check-pool-product-type.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const admin = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const html  = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
const cron  = fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'maturityCron.js'), 'utf8');

console.log('\nthe form shows what is stored, not a default');
ok('an empty product type no longer falls through to cattle',
   !/editPoolType'\)\.value\s*=\s*pool\.product_type \|\| 'cattle'/.test(admin) &&
   !/getElementById\('editPoolType'\)\.value\s*=\s*pool\.product_type \|\| '[a-z]/.test(admin),
   "`pool.product_type || 'cattle'` displays cattle for a pool that has no product type");
ok('it loads the stored value verbatim, empty included',
   /getElementById\('editPoolType'\)\.value\s*=\s*pool\.product_type \|\| ''/.test(admin));
ok('an unset pool gets a "not set" option so the field can say so',
   /not set[\s\S]{0,40}<\/option>|<option value="">— not set —<\/option>/.test(admin));
ok('a value the dropdown does not list is added rather than dropped',
   /!Array\.from\(editTypeSel\.options\)\.some\(o => o\.value === pool\.product_type\)/.test(admin) &&
   /\(unmapped\)/.test(admin),
   'without this an unlisted value renders blank and saves as empty');
ok('the injected option is escaped',
   /<option value="\$\{_esc\(pool\.product_type\)\}">/.test(admin),
   'product_type is data; it belongs escaped like any other');

console.log('\nsaving does not quietly change it');
ok('saving with no product type asks first',
   /Save without a product type\?/.test(admin));
ok('and the warning says why it matters',
   /matches rollovers on product type alone/.test(admin),
   'the consequence — rollovers going to wallets — is the reason to care');

console.log('\nthe dropdown still offers the real products');
for (const v of ['cattle', 'short_term']) {
  ok(`"${v}" is selectable`, new RegExp(`<option value="${v}">`).test(html));
}

console.log('\nand the engine really does match on product_type alone');
ok('the target query keys on product_type',
   /WHERE status = 'open'[\s\S]{0,120}AND product_type = \$1/.test(cron));
ok('the rollover passes the INVESTMENT\'s product type, not the pool\'s',
   /reinvestAmount\(client, inv, gross, inv\.product_type, poolName\)/.test(cron),
   'this is why fixing the pool alone does not reroute anything');
ok('nothing in the target query looks at the pool name',
   !/WHERE status = 'open'[\s\S]{0,200}\bname\b\s*(=|ILIKE|LIKE)/.test(cron));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
