#!/usr/bin/env node
/* The switch that hides the investment-agreement flow.
 *
 * It reached production before it was meant to: clients opening an investment
 * were asked to read and sign a contract for a step they had been completing
 * without one. Hiding it had to be possible in a minute, in one environment,
 * without unpicking the feature from the branch it is still being built on.
 *
 * The dangerous state is not "on" or "off" — it is half of each. The portal
 * asks the server to draw an agreement; the wallet transaction refuses an
 * investment that has none. Switch off the first and leave the second, and
 * every investment a client makes fails with 412 and an error about a
 * document they were never shown. So what is asserted here is mostly that
 * the two cannot part company: one function, read by both, at the point of
 * use.
 *
 * Run: node server/scripts/check-agreement-switch.cjs
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
const read  = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const AG     = require(path.join(ROOT, 'server', 'services', 'agreements.js'));
const ROUTE  = read('server/routes/agreements.js');
const TABLES = read('server/routes/tables.js');
const CORE   = read('js/portal-core.js');

console.log('\noff unless somebody turned it on');
{
  /* The shipped function, run — not a copy of its rule. */
  ok('nothing set means off',            AG.agreementsEnabled({}) === false);
  ok('empty means off',                  AG.agreementsEnabled({ INVESTMENT_AGREEMENTS_ENABLED: '' }) === false);
  ok('"false" means off',                AG.agreementsEnabled({ INVESTMENT_AGREEMENTS_ENABLED: 'false' }) === false);
  /* The value that most often gets typed when somebody means yes, and the one
     that would silently switch a legal document on in production. */
  ok('"1" is not on either',             AG.agreementsEnabled({ INVESTMENT_AGREEMENTS_ENABLED: '1' }) === false,
     'a truthy-looking value must not be enough to put a contract in front of a client');
  ok('"yes" is not on either',           AG.agreementsEnabled({ INVESTMENT_AGREEMENTS_ENABLED: 'yes' }) === false);
  ok('only "true" is on',                AG.agreementsEnabled({ INVESTMENT_AGREEMENTS_ENABLED: 'true' }) === true);
  ok('and case does not matter',         AG.agreementsEnabled({ INVESTMENT_AGREEMENTS_ENABLED: 'TRUE' }) === true);

  /* Captured at require() time it could not be changed without a rebuild, and
     a check could not set it and watch the shipped code react. */
  const fn = (read('server/services/agreements.js')
    .match(/function agreementsEnabled\([\s\S]*?\n\}/) || [''])[0];
  ok('it reads the environment when asked, not when loaded',
     /const e = env \|\| process\.env;/.test(fn), fn);
}

console.log('\nboth halves read the same switch');
{
  ok('the endpoint the portal draws from asks it',
     /if \(!AG\.agreementsEnabled\(\)\) return res\.json\(\{ required: false \}\);/.test(strip(ROUTE)),
     'the modal would still be put in front of clients');
  ok('and it answers before doing anything else',
     strip(ROUTE).indexOf('agreementsEnabled()') <
     strip(ROUTE).indexOf('const investorId = investorOf(req);'),
     'an agreement row would be written for a feature that is switched off');

  /* Sliced rather than matched: two blocks in tables.js open with these exact
     words, so a regex anchored on the opening line answers about whichever
     comes first in the file — which is the closed-pool guard, not this. */
  const MARK = "if (req.user.role === 'investor' && !isReinvestment";
  const src  = strip(TABLES);
  const branches = [];
  for (let i = src.indexOf(MARK); i !== -1; i = src.indexOf(MARK, i + 1)) {
    branches.push(src.slice(i, i + 1100));
  }
  ok('there are two investor branches to tell apart', branches.length === 2, String(branches.length));

  const agreementGate = branches.find(b => /investment_agreements/.test(b));
  const closedPool    = branches.find(b => /past_close/.test(b));
  ok('the gate on the money asks it too',
     !!agreementGate && /agreementsEnabled\(\)/.test(agreementGate.slice(0, 200)),
     agreementGate && agreementGate.slice(0, 200));

  /* Two blocks in tables.js open with the same words — the closed-pool guard
     and the agreement gate — and a search-and-replace that took both switched
     off the guard that stops an investor buying into a round that has shut.
     The suite caught it; this is so the next one is caught here.

     Only the block that claims an agreement may be switchable. */
  /* Two blocks in tables.js open with the same words — the closed-pool guard
     and the agreement gate — and a search-and-replace that took both switched
     off the guard that stops an investor buying into a round that has shut.
     The suite caught it; this is so the next one is caught here. */
  ok('and it is the only branch behind the switch',
     branches.filter(b => /agreementsEnabled\(\)/.test(b.slice(0, 200))).length === 1,
     'more than the agreement gate is being switched off');
  ok('the closed-pool guard is not',
     !!closedPool && !/agreementsEnabled\(\)/.test(closedPool.slice(0, 200)),
     'switching agreements off would let an investor buy into a round that has shut');

  /* The failure that costs real money. Whichever way round it happens, a
     client with no way to sign meets a gate that demands a signature. */
  ok('neither half can be switched without the other',
     /agreementsEnabled/.test(ROUTE) && /agreementsEnabled/.test(TABLES) &&
     !/INVESTMENT_AGREEMENTS_ENABLED/.test(strip(ROUTE)) &&
     !/INVESTMENT_AGREEMENTS_ENABLED/.test(strip(TABLES)),
     'reading the variable directly is how the two drift apart');
}

console.log('\nswitched off, an investment simply proceeds');
{
  const sign = (CORE.match(/async function signAgreementFor\([\s\S]*?\n\}\n/) || [''])[0];
  ok('the portal takes required:false as "carry on"',
     /if \(drawn && drawn\.required === false\) return true;/.test(sign),
     'it would open an empty modal nobody can complete');
  ok('and it decides that before drawing anything',
     sign.indexOf('drawn.required === false') < sign.indexOf('_agrEnsureModal()'), sign);
  ok('a genuine failure is still a failure',
     /Could not prepare your agreement[\s\S]{0,60}return false;/.test(sign),
     'an outage would read as "no signature needed" and let the money move');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
