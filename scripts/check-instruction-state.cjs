#!/usr/bin/env node
/* A client should be able to see, from the card, whether a maturity
 * instruction has been set.
 *
 * The button said "Set Maturity Instruction" whether or not one was already
 * set, so the only way to find out was to open the modal — one investment at
 * a time.
 *
 * And the pool-level state was decided with `new Set(...).size === 1`. With
 * three investments in a pool and an instruction on one, the other two
 * contribute nothing to the set, so it still has one member and the pool reads
 * as fully set. A client would be told their instruction was in place while
 * most of the money had none.
 *
 * Run: node scripts/check-instruction-state.cjs
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

const sandbox = {
  window: {}, document: { addEventListener() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  console, fetch: () => Promise.reject(new Error('no network')),
  setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  navigator: { userAgent: 'node' }, location: { href: '', origin: '' },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8'), sandbox, { filename: 'js/api.js' });
const Utils = sandbox.Utils || vm.runInContext('typeof Utils !== "undefined" ? Utils : null', sandbox);
if (!Utils || typeof Utils.maturityInstructionState !== 'function') {
  console.error('Utils.maturityInstructionState is missing from js/api.js');
  process.exit(1);
}

const inv = i => ({ id: 'x', maturity_instruction: i });
const st  = g => Utils.maturityInstructionState(g);

console.log('\nthe state of a pool');
ok('nothing set', st([inv(null), inv(null)]).state === 'none', JSON.stringify(st([inv(null), inv(null)])));
ok('all set, same instruction', st([inv('reinvest'), inv('reinvest')]).state === 'all');
ok('two different instructions is mixed', st([inv('reinvest'), inv('payout_all')]).state === 'mixed');

// The bug: one of three set was reported as fully set.
{
  const partial = st([inv('reinvest'), inv(null), inv(null)]);
  ok('one of three set is PARTIAL, not all', partial.state === 'partial', JSON.stringify(partial));
  ok('and it says how many', partial.label === 'Reinvest — 1 of 3 set', partial.label);
  ok('setCount and total are both reported',
     partial.setCount === 1 && partial.total === 3, JSON.stringify(partial));

  // The old rule, for the record.
  const oldSaysFullySet = [...new Set([inv('reinvest'), inv(null), inv(null)]
    .map(i => i.maturity_instruction).filter(Boolean))].length === 1;
  ok('the old Set-size rule really did call that fully set', oldSaysFullySet === true);
}

console.log('\n"pending" is the column default, not a choice');
ok('pending counts as unset', st([inv('pending')]).state === 'none', JSON.stringify(st([inv('pending')])));
ok('empty string counts as unset', st([inv('')]).state === 'none');
ok('a pool of pending and a real choice is partial',
   st([inv('pending'), inv('reinvest')]).state === 'partial',
   JSON.stringify(st([inv('pending'), inv('reinvest')])));

console.log('\nedge cases do not throw');
ok('an empty group', st([]).state === 'none');
ok('a bare object rather than an array', st(inv('reinvest')).state === 'all');
ok('nulls inside the group are ignored', st([null, inv('reinvest')]).state === 'all');

console.log('\nall six instructions have words');
{
  const SERVER = ['reinvest', 'payout_all', 'payout_return', 'payout_custom', 'switch_product', 'custom_switch'];
  for (const key of SERVER) {
    const label = Utils.instructionLabel(key);
    ok(`${key} reads as "${label}"`, !!label && !label.includes('_'), JSON.stringify(label));
  }
  ok('an unknown value degrades to readable text rather than nothing',
     Utils.instructionLabel('some_new_thing') === 'some new thing');
  ok('pending has no label — it is not a choice', Utils.instructionLabel('pending') === null);
}

console.log('\nthe card shows state, and the button says what it does');
{
  const core = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
  ok('the card asks for the instruction state',
     /Utils\.maturityInstructionState\(group\)/.test(core));
  ok('the button reads "Change" once something is set',
     /Change Maturity Instruction/.test(core),
     'it said "Set" regardless, so the only way to check was to open the modal');
  ok('and still reads "Set" when nothing is',
     /'Set Maturity Instruction' : 'Change Maturity Instruction'/.test(core));

  // No copy of the old rule anywhere.
  ok('no surface still decides this with Set size',
     !/uniqueInstrs/.test(core),
     'a copy of the rule that miscounts partial coverage is still present');
  ok('the four-label map is gone',
     !/reinvest: 'Reinvest on maturity'/.test(core),
     'it covered four of the six the server accepts');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
