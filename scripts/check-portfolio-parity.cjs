#!/usr/bin/env node
/* The admin console and the client portal must show the same portfolio value.
 *
 * They disagreed. The client's hero runs Utils.portfolioValue — active capital
 * plus wallet plus POSTED returns. The admin investor overview had no such
 * figure at all, only four separate tiles, and the one labelled "Returns
 * Earned" ran Utils.totalReturns, whose own comment in js/api.js says it falls
 * back to the contracted rate and must not be used for anything labelled
 * earned. So on any investment with nothing posted, admin showed a projection
 * and the client showed zero, and nobody could reconcile the two by adding up
 * tiles.
 *
 * This asserts the two screens compute from the same helpers, and — the part
 * that matters — that those helpers give the same answer on the same data,
 * including the cases where a projection would differ from a posting.
 *
 * No database. Utils is pure.
 *
 * Run: node scripts/check-portfolio-parity.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const r2 = n => Math.round(n * 100) / 100;

/* Load the real Utils out of js/api.js rather than restating it. A check that
   carries its own copy of the formula passes while the shipped screens drift. */
function loadUtils() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');
  const sandbox = {
    window: {}, document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => Promise.reject(new Error('no network in this check')),
    console: { log() {}, warn() {}, error() {} },
    navigator: { userAgent: 'check' }, location: { origin: '', href: '', hostname: 'localhost' },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Number, String, Array, Object,
  };
  sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  /* `const Utils = {…}` at the top level of a script stays in that script's
     lexical scope — it never lands on the sandbox global — so the value has to
     be handed out explicitly. Appended rather than transcribed, so what runs
     here is the shipped object. */
  try { vm.runInContext(src + '\n;globalThis.__Utils = (typeof Utils !== "undefined") ? Utils : null;',
                        sandbox, { timeout: 10000 }); }
  catch (err) { throw new Error(`js/api.js did not evaluate: ${err.message}`); }
  const U = sandbox.__Utils || sandbox.Utils || (sandbox.window && sandbox.window.Utils);
  if (!U) throw new Error('Utils not found on the sandbox after evaluating js/api.js');
  return U;
}

(async () => {
  try {
    const Utils = loadUtils();

    console.log('\nthe helpers the two screens share');
    for (const fn of ['portfolioValue', 'earnedReturns', 'postedReturn', 'totalReturns']) {
      ok(`Utils.${fn} exists`, typeof Utils[fn] === 'function');
    }

    /* One investor, deliberately mixed: a posted active holding, an active one
       with nothing posted but a contracted rate (where projection and posting
       diverge), a matured one, and a cancelled one. */
    const wallet = 1500.25;
    const investments = [
      { id: 'A', status: 'active',    amount: 20000, pool_actual_rate: 0.079, annual_rate: 0.16 },
      { id: 'B', status: 'active',    amount: 10000, annual_rate: 0.14, expected_return: 1400 },
      { id: 'C', status: 'matured',   amount: 30000, actual_return: 2500, annual_rate: 0.12 },
      { id: 'D', status: 'cancelled', amount: 50000, annual_rate: 0.20 },
    ];

    console.log('\nboth screens compute one number from one helper');
    {
      // Portal: js/portal-core.js line ~1209. Admin: admin/js/admin.js.
      const portal = Utils.portfolioValue(investments, wallet);
      const admin  = Utils.portfolioValue(investments, wallet);
      ok('the same call gives the same answer', portal === admin);

      // 20000 active + 10000 active + wallet + posted-on-active (20000*0.079 = 1580)
      ok('and it is capital + wallet + posted returns on active holdings',
         r2(portal) === r2(30000 + wallet + 1580), `got ${portal}`);

      ok('the matured holding is not counted as capital again',
         portal < 30000 + wallet + 1580 + 30000,
         'a matured investment has already become wallet or a new holding');
      ok('and the cancelled one is excluded', r2(portal) === r2(30000 + wallet + 1580));
    }

    console.log('\nthe projection helper would have given a different answer');
    {
      const earned    = Utils.earnedReturns(investments.filter(i => i.status !== 'cancelled'));
      const projected = Utils.totalReturns(investments.filter(i => i.status !== 'cancelled'));
      ok('B has a contracted rate but nothing posted',
         Utils.postedReturn(investments[1]) == null);
      ok('so earned and projected genuinely differ here', r2(earned) !== r2(projected),
         `earned ${r2(earned)} vs projected ${r2(projected)} — if these matched, the check proves nothing`);
      ok('earned counts only what was declared', r2(earned) === r2(1580 + 2500), `got ${r2(earned)}`);
      ok('projected quietly adds the contracted rate', r2(projected) === r2(1580 + 2500 + 1400),
         `got ${r2(projected)}`);
    }

    console.log('\nthe admin overview shows the client figure');
    {
      const adm = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      ok('it calls the shared helper rather than re-adding the tiles',
         /const portfolioValue\s*=\s*Utils\.portfolioValue\(invsts,\s*inv\.wallet_balance\)/.test(adm));
      ok('under the same label the client sees', /Total Portfolio Value/.test(adm));
      ok('with the posted-return line beside it', /return posted/.test(adm) && /returnPct/.test(adm));
      ok('and no returns is stated, not shown as zero earned',
         /No returns posted yet/.test(adm));

      ok('the Returns Earned tile no longer uses the projection helper',
         !/Utils\.totalReturns\(/.test(adm),
         'Utils.totalReturns falls back to the contracted rate — see its comment in js/api.js');
      ok('it uses earnedReturns', /Utils\.earnedReturns\(earningInvs\)/.test(adm));
      ok('over non-cancelled investments, matching the client badge scope',
         /earningInvs\s*=\s*invsts\.filter\(i\s*=>\s*\(i\.status\s*\|\|\s*''\)\s*!==\s*'cancelled'\)/.test(adm));
    }

    console.log('\nthe client hero is unchanged');
    {
      const core = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
      ok('it still runs portfolioValue',
         /Utils\.portfolioValue\(PORTAL\.investments,\s*inv\.wallet_balance\)/.test(core));
      ok('and earnedReturns for the badge', /Utils\.earnedReturns\(earningInvs\)/.test(core));
    }

    console.log('\nthe edges');
    {
      ok('no investments and an empty wallet is zero, not NaN',
         Utils.portfolioValue([], 0) === 0);
      ok('a null list does not throw', Utils.portfolioValue(null, 100) === 100);
      ok('an unparseable wallet counts as nothing',
         Utils.portfolioValue([], 'not a number') === 0);
      ok('a posted rate of zero is not treated as posted',
         Utils.postedReturn({ status: 'active', amount: 1000, pool_actual_rate: 0 }) == null,
         'zero cannot currently be told apart from unposted — the column defaults to 0');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  }
  process.exit(fail ? 1 : 0);
})();
