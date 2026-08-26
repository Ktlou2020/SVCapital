#!/usr/bin/env node
/* An investment must be paid for. If the wallet is short, the request fails
 * and nothing is created.
 *
 * The affordability guard — row lock, balance check, deduct under the lock —
 * ran only for `req.user.role === 'investor'`. A staff-created investment
 * skipped it and settled afterwards with:
 *
 *     wallet_balance = GREATEST(0, wallet_balance - $1)
 *
 * GREATEST clamps rather than fails. A R500 wallet funded a R10,000
 * investment: the balance went to zero, total_invested recorded the full
 * R10,000 as though it had been paid, and the R9,600 shortfall simply
 * vanished. No error, no record that anything was wrong.
 *
 * Worse, the settlement ran *after* the investment row was inserted, so
 * refusing at that point would have left an unpaid investment behind. The
 * check has to happen before the row exists, which is where the investor path
 * already did it.
 *
 * Run: node server/scripts/check-investment-affordability.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'tables.js'), 'utf8');

console.log('\nthe guard covers every role, not only investors');
ok('it is no longer gated on req.user.role === \'investor\'',
   !/if \(table === 'investments' && req\.user\.role === 'investor'\) \{/.test(src),
   'staff-created investments still bypass the affordability check');
ok('it runs for any investment POST',
   /let _investmentWalletDeducted = false;[\s\S]{0,700}if \(table === 'investments'\) \{/.test(src));

console.log('\nand it still refuses, locks, and deducts');
ok('the balance is read FOR UPDATE',
   /SELECT wallet_balance FROM investors WHERE id = \$1 FOR UPDATE/.test(src),
   'without the lock two concurrent requests both pass the check');
ok('a short balance is refused before anything is created',
   /Insufficient balance\. This investment requires/.test(src));
ok('the deduction happens while the lock is held',
   /Deduct while holding the row lock/.test(src));

console.log('\nthe clamp is gone');
{
  // Only the comment explaining it should mention GREATEST now.
  const lines = src.split('\n')
    .map((l, i) => [l, i + 1])
    .filter(([l]) => /GREATEST\(0, wallet_balance/.test(l))
    .filter(([l]) => !/^\s*(\*|\/\*|\/\/|`GREATEST)/.test(l.trim()) && !/clamps instead of/.test(l));
  ok('no wallet debit clamps at zero', lines.length === 0,
     lines.map(([l, n]) => `tables.js:${n}: ${l.trim().slice(0, 90)}`).join('\n      '));
}
ok('an unsettled investment fails loudly instead',
   /was created without a settled wallet deduction/.test(src) &&
   /Nothing was charged — please retry/.test(src),
   'the fallback should refuse, not quietly deduct what it can');

console.log('\nstaff are told whose wallet is short');
ok('the message is not "your wallet" when staff act for someone else',
   /req\.user\.role === 'investor' \? 'your wallet' : "this investor's wallet"/.test(src),
   'an admin reading "your wallet" about a client\'s balance is confusing');

console.log('\na sub-account is still owned-checked for investors only');
ok('investors may only spend from a sub-account they own',
   /parent_investor_id=\$2 FOR UPDATE/.test(src));
ok('staff are not blocked by that ownership predicate',
   /SELECT wallet_balance FROM sub_accounts WHERE id=\$1 FOR UPDATE/.test(src),
   'applying it to staff would 403 every staff POST');

/* The arithmetic the guard turns on, checked directly. */
console.log('\nthe amount required includes the 1% fee');
{
  const required = (amount, isReinvestment) => {
    const fee = isReinvestment ? 0 : Math.round(amount * 0.01 * 100) / 100;
    return amount + fee;
  };
  ok('R10 000 requires R10 100', required(10000, false) === 10100);
  ok('R400 requires R404', Math.abs(required(400, false) - 404) < 0.005);
  ok('a reinvestment carries no fee', required(10000, true) === 10000);
  ok('R500 does not cover a R10 000 investment', 500 < required(10000, false));
  ok('but does cover R400', 500 >= required(400, false));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
