#!/usr/bin/env node
/* Remapping a pool's product type must be previewable, guarded, and complete.
 *
 * product_type lives on the pool AND on every investment in it, and the
 * maturity engine reads the investments' — reinvestAmount is handed
 * inv.product_type and its target query's only predicate is
 * `product_type = $1`. Correcting the pool alone reroutes nothing. So the
 * remap has to move both, together, or it is worse than useless: it looks
 * fixed and behaves exactly as before.
 *
 * Three properties matter:
 *   1. It previews by default. dry_run must be explicitly false to write,
 *      because the apply rewrites every investment in the pool.
 *   2. A typo cannot invent a product type. Routing to a type no pool uses
 *      means "to wallets" — silently, which is the failure being fixed.
 *   3. The write is one transaction and leaves an audit row naming what the
 *      rollover target was before and after.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-remap-product-type.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

console.log('\nthe route previews by default and cannot invent a type');
{
  const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'manualCredit.js'), 'utf8');
  const i = src.indexOf("router.post('/pools/remap-product-type'");
  ok('the route exists', i > -1);
  const body = src.slice(i, src.indexOf('\n});', i));

  ok('dry run is the default — writing needs dry_run:false explicitly',
     /const dryRun = dry_run !== false;/.test(body),
     'defaulting the other way makes a mis-click rewrite every investment in the pool');
  ok('it returns before writing when previewing',
     /if \(dryRun\) return res\.json/.test(body));
  ok('the target type must already be in use by another pool',
     /No other pool uses product_type/.test(body),
     'a typo would route every rollover to a product that does not exist');
  ok('and the refusal lists what IS valid',
     /allowed: \[\.\.\.allowed\]\.sort\(\)/.test(body),
     'refusing without saying what would work just costs another round trip');
  ok('the product type is shape-checked before it reaches SQL',
     /\/\^\[a-z0-9_\]\+\$\/\.test\(target\)/.test(body));
  ok('pool and investments are written in ONE transaction',
     /BEGIN'\)[\s\S]{0,900}UPDATE investment_pools[\s\S]{0,600}UPDATE investments[\s\S]{0,400}COMMIT/.test(body),
     'a half-applied remap leaves the pool saying one thing and its investments another');
  ok('both tables are actually written',
     /UPDATE investment_pools SET product_type/.test(body) &&
     /UPDATE investments SET product_type/.test(body),
     'writing only the pool changes nothing about routing');
  ok('an audit row records the change',
     /action: 'pool_product_type_remapped'/.test(body));
  ok('and records what the rollover target was, and becomes',
     /rollover_target: plan\.rollover_before\.poolId/.test(body) &&
     /rollover_target: plan\.rollover_after\.poolId/.test(body),
     'the point of the change is where the money goes — so record that, not just a column value');
  ok('a failure rolls back and says nothing changed',
     /ROLLBACK[\s\S]{0,200}nothing was changed/.test(body));
}

console.log('\nit warns when the remap would not actually help');
{
  const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'manualCredit.js'), 'utf8');
  ok('a target type with no open pool is called out',
     /STILL become wallet payouts/.test(src),
     'remapping to a type that has no open pool changes the label and nothing else');
}

console.log('\none definition of "where would a rollover go"');
{
  const svc  = fs.readFileSync(path.join(ROOT, 'server', 'services', 'maturityPreflight.js'), 'utf8');
  const rt   = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'manualCredit.js'), 'utf8');
  const cron = fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'maturityCron.js'), 'utf8');
  ok('the resolver is exported once', /resolveRolloverTarget/.test(svc) &&
     /module\.exports = \{[\s\S]{0,200}resolveRolloverTarget/.test(svc));
  ok('and the remap route uses it rather than its own copy',
     /const \{ resolveRolloverTarget \} = require\('\.\.\/services\/maturityPreflight'\)/.test(rt) &&
     !/FROM investment_pools[\s\S]{0,200}status = 'open'[\s\S]{0,200}ORDER BY end_date ASC/.test(rt),
     'a second copy of the target query drifts from the engine');
  ok('the engine still keys on the investment product type',
     /reinvestAmount\(client, inv, gross, inv\.product_type, poolName\)/.test(cron));
}

console.log('\nthe admin control previews before it applies');
{
  const admin = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
  const html  = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
  ok('there is a preview button and an apply button',
     /remapPoolProductType\(this, true\)/.test(html) && /remapPoolProductType\(this, false\)/.test(html));
  ok('applying asks for confirmation first',
     /Apply this remap\?/.test(admin));
  ok('the confirmation says investments are rewritten too',
     /AND every investment in it/.test(admin));
  ok('the panel says the pool name is not what is matched',
     /never on the pool\s*\n?\s*name|matches rollovers on the investment's product type alone/.test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
