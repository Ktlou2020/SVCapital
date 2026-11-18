#!/usr/bin/env node
/* Which date a pool actually needs.
 *
 * ASKED FOR: "When the target is an amount then no closing date is required,
 * the closing date is when the amount is met. The start must be optional as
 * well and will be manually added."
 *
 * A pool has one of two targets and the form asked for both regardless. It
 * hid the Target Amount on a date pool and left Close Date looking equally
 * expected either way, so an amount-goal pool — which closes when the money
 * is there, not on a date — appeared to need a date it has no use for.
 *
 *   amount goal   raises until the amount is met. No close date needed.
 *   closing date  the DATE is the target. Required, and refused without one:
 *                 a date pool with no close date has no target at all.
 *
 * WHAT THIS DOES NOT CLAIM. Nothing closes an amount-goal pool when its
 * target is reached — poolCyclerCron's sweep is `end_date IS NOT NULL`, and
 * no route caps an investment at target_amount or max_capacity. So a pool
 * left without a close date stays open past its target until somebody closes
 * it by hand. That is asserted below as the behaviour it currently is, not
 * as the behaviour anybody wants, so that the day it is implemented this
 * check fails and is updated deliberately rather than silently passing on a
 * sentence that stopped being true.
 *
 * Run: node server/scripts/check-pool-target-type.cjs
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
const CYCLER     = read('server/jobs/poolCyclerCron.js');

/* The rule, lifted out and run rather than restated. */
const ctx = {};
{
  const from = ADMIN_JS.indexOf('const POOL_TARGET_TYPES = {');
  const to   = ADMIN_JS.indexOf('function _syncPoolTargetType');
  const tail = ADMIN_JS.indexOf('async function saveNewPool');
  vm.createContext(ctx);
  vm.runInContext(ADMIN_JS.slice(from, to) + ADMIN_JS.slice(ADMIN_JS.indexOf('function _poolCloseDateError'), tail)
    + '\nthis.T = POOL_TARGET_TYPES; this.err = _poolCloseDateError;', ctx);
}

console.log('\nan amount-goal pool does not need a closing date');
{
  ok('the rule was found', !!ctx.T && !!ctx.err,
     'a slice that missed it would assert nothing while passing');
  ok('AMOUNT: a blank close date is accepted',
     ctx.err('amount', '') === null, String(ctx.err('amount', '')));
  ok('and so is one that is set, for a raise that must stop regardless',
     ctx.err('amount', '2026-12-31') === null,
     'leaving it optional is not the same as forbidding it');
  ok('the label says optional rather than looking required',
     /\(optional\)/.test(ctx.T.amount.closeLabel) && !/\*/.test(ctx.T.amount.closeLabel),
     ctx.T.amount.closeLabel);
  /* THE HINT MUST NOT PROMISE THE AUTO-CLOSE. Its first wording said the
     pool "stays open until it is full", which reads as though reaching the
     target closes it. Nothing does — see the last section. An operator who
     believed that sentence would leave the date blank and find the pool
     still taking money a month after it filled. */
  ok('and the hint says what happens if it is left blank',
     /keeps raising until you close it/i.test(ctx.T.amount.hint), ctx.T.amount.hint);
  ok('WITHOUT promising an automatic close that does not exist',
     /Nothing closes it automatically/i.test(ctx.T.amount.hint)
     && !/until it is full/i.test(ctx.T.amount.hint),
     ctx.T.amount.hint);
}

console.log('\nwhile a closing-date pool is nothing without one');
{
  ok('DATE: a blank close date is refused',
     typeof ctx.err('date', '') === 'string', String(ctx.err('date', '')));
  ok('and the message says which setting to change instead',
     /Amount goal/.test(ctx.err('date', '')), ctx.err('date', ''));
  ok('a date that is set passes', ctx.err('date', '2026-12-31') === null);
  ok('the label carries the required mark', /\*/.test(ctx.T.date.closeLabel), ctx.T.date.closeLabel);
  /* An unknown value must land somewhere real rather than throwing. */
  ok('an unrecognised target type is treated as an amount goal',
     ctx.err('nonsense', '') === null,
     'a pool saved before the types existed must not be blocked from editing');
}

console.log('\nand both forms refuse it, on the way in and on the way out');
{
  /* THE RESULT HAS TO BE ACTED ON, not merely computed. The first version
     asserted the `const` existed, so deleting the line that reads it left
     the variable in place and the assertion passing — a form that worked out
     the right answer and saved anyway. The guard is what is asserted. */
  ok('the new-pool form refuses on it',
     /const newCloseErr = _poolCloseDateError\(/.test(ADMIN_JS)
     && /if \(newCloseErr\) \{ Toast\.error\(newCloseErr\); return; \}/.test(ADMIN_JS));
  ok('and the edit form refuses on it too',
     /const editCloseErr = _poolCloseDateError\(/.test(ADMIN_JS)
     && /if \(editCloseErr\) \{ Toast\.error\(editCloseErr\); return; \}/.test(ADMIN_JS),
     'clearing the close date of an existing date pool is the one edit that '
     + 'would quietly leave it with no target');
  ok('both read the one rule rather than keeping a copy',
     (ADMIN_JS.match(/_poolCloseDateError\(/g) || []).length === 3,
     'one definition and two call sites');
  ok('the hint and label are rendered from the table',
     /lbl\.innerHTML\s*=\s*t\.closeLabel/.test(ADMIN_JS)
     && /hint\.innerHTML\s*=\s*t\.hint/.test(ADMIN_JS));
  for (const w of ['new', 'edit']) {
    ok(`the ${w} form has somewhere to put them`,
       new RegExp(`id="${w}PoolCloseLabel"`).test(ADMIN_HTML)
       && new RegExp(`id="${w}PoolTargetHint"`).test(ADMIN_HTML));
    ok(`and the ${w} form follows the select as it changes`,
       new RegExp(`onchange="_syncPoolTargetType\\('${w}'\\)"`).test(ADMIN_HTML));
  }
  ok('an existing pool opens with the hint already written',
     /_syncPoolTargetType\('edit'\);/.test(ADMIN_JS),
     'a hint that appears only after you touch the select is no hint at all');
}

console.log('\nand the investment start date is optional on both');
{
  ok('neither form calls it automatic any more',
     !/Investment Start Date <span[^>]*>\(auto\)/.test(ADMIN_HTML),
     'it is the day the money is deployed, which is decided when it happens');
  ok('both call it optional',
     (ADMIN_HTML.match(/Investment Start Date <span[^>]*>\(optional\)/g) || []).length === 2,
     'the new pool form and the edit form');
  ok('and a blank one is still saved as null rather than today',
     /investment_start_date: document\.getElementById\('newPoolInvStartDate'\)\.value \|\| null/.test(ADMIN_JS),
     'a start date invented at save time is a deployment date nobody chose');
}

console.log('\nand a pool with no close date is not treated as expired');
{
  const from = CORE.indexOf('function _poolPastClose');
  const to   = CORE.indexOf('function _getOpenMarketplacePools');
  ok('the portal predicate was found', from > 0 && to > from);
  const c2 = { _poolEndMs: v => (v ? Date.parse(v) : null), Date };
  vm.createContext(c2);
  vm.runInContext(CORE.slice(from, to) + '\nthis.past = _poolPastClose;', c2);

  ok('A POOL WITH NO CLOSE DATE IS NEVER PAST CLOSE',
     c2.past({ end_date: null }) === false && c2.past({}) === false,
     'otherwise making the date optional would hide the pool from the marketplace '
     + 'the moment it was left blank');
  ok('while one whose date has passed still is',
     c2.past({ end_date: '2020-01-01' }) === true);
  ok('and one still to come is not',
     c2.past({ end_date: '2099-01-01' }) === false);
}

/* ── The part that is NOT built, recorded as such ────────────────────── */
console.log('\nand nothing yet closes an amount pool when its target is met');
{
  /* The request said "the closing date is when the amount is met". That is
     the intent; it is not what the code does. Asserted as it stands so the
     day it changes, this fails and somebody updates it on purpose. */
  ok('the cycler only sweeps pools that HAVE a close date',
     /AND end_date IS NOT NULL/.test(CYCLER),
     'server/jobs/poolCyclerCron.js — a pool without one is never swept');
  const capped = /max_capacity/.test(read('server/routes/tables.js'))
    && /target_amount/.test(read('server/routes/investments.js'));
  ok('and no investment route caps a pool at its target', !capped,
     'if this fails, capping has been added and the note above is out of date');
  ok('so the screen says so rather than implying otherwise',
     /Nothing closes it automatically/i.test(ctx.T.amount.hint),
     'an operator leaving the date blank should be able to read what follows');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
