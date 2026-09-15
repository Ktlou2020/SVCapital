#!/usr/bin/env node
/* The two moments where a client is trying to put more money in.
 *
 * ── A wallet that is short ──────────────────────────────────────────────
 * Both shortfall prompts in the invest modal ended in the same line:
 *
 *     Modal.close('investModal'); navigate('wallet', …)
 *
 * which drops the pool they had chosen and the amount they had typed, and
 * leaves them on the wallet page to work out the difference, top up, find the
 * marketplace again, find the pool again, and start over. Every one of those
 * steps is somewhere to give up — and the funnel records the giving up as
 * `insufficient_funds` with no idea how much of it we caused.
 *
 * It now opens the top-up modal with the shortfall already filled in, and on a
 * successful payment reopens the invest modal for the same pool with the same
 * amount.
 *
 * ── The moment after an investment ──────────────────────────────────────
 * Recurring contribution is the whole machinery for investing more over time:
 * recurring_enabled / _amount / _day / _product_type, a nightly cron, a portal
 * tab. Production reports "0 investor(s) scheduled for today" because it lives
 * two levels down as a sub-tab inside the wallet. It is now offered once, by
 * toast, at the only moment a client has just proved they want the product.
 *
 * Reads the shipped files and RUNS the pieces that can be run. No database.
 *
 * Run: node server/scripts/check-invest-more-paths.cjs
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
const decomment = s => s.replace(/(^|[\s;{(=])\/\*[\s\S]*?\*\//g, '$1 ').replace(/^\s*\/\/.*$/gm, ' ');

const CORE    = read(path.join('js', 'portal-core.js'));
const PORTALS = [path.join('portal', 'js', 'portal.js'),
                 path.join('mobile', 'src', 'js', 'portal.js'),
                 path.join('mobile', 'www', 'js', 'portal.js')];

console.log('\nthe shortfall keeps hold of what the client had chosen');
for (const rel of PORTALS) {
  const src = decomment(read(rel));
  /* Both prompts — the one shown when the modal opens under the minimum, and
     the one shown when they type more than they hold. */
  const calls = (src.match(/topUpForShortfall\(/g) || []).length;
  ok(`${rel} — both prompts route through it`, calls === 2, `${calls} call(s)`);
  ok(`${rel} — neither dumps them on the wallet page`,
     !/onclick="Modal\.close\('investModal'\);navigate\('wallet'/.test(src),
     'that line is what loses the pool and the amount');
  ok(`${rel} — the button says what it will do`,
     /Top up \$\{Utils\.rand\([^)]*\)\} and come back/.test(src),
     '"Top Up Wallet" does not tell them they get to keep their place');
}

console.log('\nthe top-up opens with the difference already in it');
{
  const c = decomment(CORE);
  ok('openTopUpModal takes a prefill', /function openTopUpModal\(gateway, saId, prefillAmount\)/.test(c));
  ok('rounded up to a round number', /Math\.ceil\(\(Number\(prefillAmount\) \|\| 0\) \/ 100\) \* 100/.test(c));
  ok('and never below the R100 minimum', /Math\.max\(100,/.test(c));
  ok('the hint explains where the figure came from', /you are short, rounded up/.test(c));

  /* Run it: the arithmetic is the part a client sees. */
  const ctx = { Math, Number };
  vm.createContext(ctx);
  const pre = vm.runInContext(
    '(function (prefillAmount) { return Math.max(100, Math.ceil((Number(prefillAmount) || 0) / 100) * 100); })', ctx);
  ok('  R1 short → R100',      pre(1) === 100, String(pre(1)));
  ok('  R340 short → R400',    pre(340) === 400, String(pre(340)));
  ok('  R2 000 short → R2 000', pre(2000) === 2000, String(pre(2000)));
  ok('  never rounds DOWN below the shortfall',
     [1, 99, 101, 349, 1999, 12345].every(v => pre(v) >= v),
     'a top-up that leaves them still short sends them round the loop again');
}

console.log('\nand a successful payment puts them back where they were');
{
  const c = decomment(CORE);
  ok('the pool and amount are remembered', /function _resumeBag\(\)/.test(c) &&
     /bag\.poolId = poolId \|\| null;/.test(c));
  ok('held off the top level, as this file requires',
     /window\.__svcInvestResume/.test(c) && !/^let __svcInvestResume/m.test(c),
     'check-portal-split forbids load-time state in the shared core');
  ok('the invest modal reopens on the same pool',
     /const pool = \(PORTAL\.pools \|\| \[\]\)\.find\(p => p\.id === resumePool\);/.test(c));
  ok('with the amount restored', /el\.value = resumeAmt;/.test(c));
  ok('and the calculator recomputed from it',
     /el\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/.test(c),
     'setting .value alone leaves the fee breakdown showing the old figure');
  ok('only after a payment that actually succeeded',
     /if \(!succeeded\) return;/.test(c));
  ok('and the memory is cleared either way',
     /bag\.poolId = null; bag\.amount = 0;/.test(c),
     'an abandoned top-up must not reopen an invest modal the next time somebody tops up');
}

console.log('\nrecurring is offered once, at the moment it makes sense');
{
  const c = decomment(CORE);
  ok('the offer exists', /function offerRecurringAfterInvest\(pool, poolAmount\)/.test(c));
  ok('it is a toast, not another modal', /Toast\.action\(/.test(c),
     'interrupting a completed task with a form is how a prompt becomes a nuisance');
  ok('never shown to somebody who already has a schedule',
     /if \(PORTAL\.investor\?\.recurring_enabled\) return;/.test(c));
  ok('and at most once a fortnight',
     /14 \* 24 \* 60 \* 60 \* 1000/.test(c));
  ok('storage failure cannot break it',
     /try \{ last = parseInt\(localStorage\.getItem\(KEY\)/.test(c),
     'localStorage throws in a private window and returns nothing after a clear');
  ok('nor can anything else in it',
     /catch \(e\) \{[\s\S]{0,200}console\.warn\('\[recurring offer\]'/.test(c),
     'an offer is not worth breaking a completed investment over');

  for (const rel of PORTALS) {
    const src = decomment(read(rel));
    ok(`${rel} — asked after the investment completes`,
       /offerRecurringAfterInvest\(pool, poolAmount\);/.test(src));
    ok(`${rel} — and after the reload, so the suppression is accurate`,
       /await loadPortalData\(\);[\s\S]{0,120}offerRecurringAfterInvest/.test(src),
       'recurring_enabled comes off the record loadPortalData refreshes');
  }
}

console.log('\nthe prefilled form does not lose the product');
{
  const c = decomment(CORE);
  ok('openRecurringModal accepts a prefill', /function openRecurringModal\(prefill\)/.test(c));
  ok('the product is matched canonically', /svcCanonProductType\(o\.value\)/.test(c),
     'a delivery_bikes pool has to select the delivery_bike option or the answer silently vanishes');
  ok('their own saved settings still win',
     /inv\?\.recurring_amount \|\| \(prefill && prefill\.amount\)/.test(c));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
