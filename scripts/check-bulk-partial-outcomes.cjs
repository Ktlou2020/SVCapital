#!/usr/bin/env node
/* A bulk action almost never fails as a unit, and must not report as if it did.
 *
 * Several ran Promise.all, or a bare loop with no per-item catch. Both collapse
 * a partial result into a total one. The concrete failure: seventeen investors
 * approved and three refused was reported as "Bulk FICA approval failed", and
 * because the local update sat AFTER the throw, the table went on showing all
 * twenty as pending while the server had approved seventeen. On KYC and FICA
 * that is a regulated decision the console disagrees with.
 *
 * The runner is exercised for real — a worker that fails on chosen items, with
 * the outcomes checked — rather than grepped for. A grep cannot tell whether
 * the successes were kept.
 *
 * No database, no browser.
 *
 * Run: node scripts/check-bulk-partial-outcomes.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function slice(name) {
  /* Take the `async` with it. Slicing from `function` alone yields a
     non-async body whose awaits are a syntax error, which surfaces as a
     confusing throw rather than as the missing keyword it is. */
  let at = SRC.indexOf(`async function ${name}(`);
  if (at < 0) at = SRC.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} not found in admin/js/admin.js`);
  const end = SRC.indexOf('\n}\n', at);
  if (end < 0) throw new Error(`could not find the end of ${name}`);
  return SRC.slice(at, end + 3);
}

/* The shipped runner and reporter, with Toast captured so the wording can be
   asserted on rather than assumed. */
function harness() {
  const toasts = [], errs = [];
  const sandbox = {
    Toast: { success: m => toasts.push(['success', m]), error: m => toasts.push(['error', m]), info: () => {} },
    STATE: { investors: [], kyc: [], investments: [] },
    console: { error: (...a) => errs.push(a.join(' ')), log() {}, warn() {} },
    Promise, String, Number, Array, Object, JSON, Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(slice('_bulkRun'), sandbox);
  vm.runInContext(slice('_bulkReport'), sandbox);
  return { sandbox, toasts, errs };
}

const run = (sandbox, code) => vm.runInContext(`(async () => { ${code} })()`, sandbox);

(async () => {
  try {
    console.log('\nthe runner keeps successes and failures apart');
    {
      const { sandbox } = harness();
      const res = await run(sandbox, `
        return await _bulkRun(['a','b','c','d'], async id => {
          if (id === 'b' || id === 'd') throw new Error('server said no: ' + id);
        }, { label: id => 'Investor ' + id });`);
      ok('every item is attempted, not abandoned at the first failure',
         res.succeeded.length + res.failed.length === 4,
         JSON.stringify(res));
      ok('the ones that worked are kept',
         res.succeeded.join(',') === 'a,c', JSON.stringify(res.succeeded));
      ok('the ones that did not are named',
         res.failed.map(f => f.item).join(',') === 'b,d', JSON.stringify(res.failed.map(f => f.item)));
      ok('with a human label, not an id',
         res.failed[0].label === 'Investor b', res.failed[0].label);
      ok('and the reason', /server said no/.test(res.failed[0].message), res.failed[0].message);
    }

    console.log('\na failure part-way through does not stop the rest');
    {
      const { sandbox } = harness();
      const res = await run(sandbox, `
        globalThis.attempted = [];
        return await _bulkRun([1,2,3,4,5], async n => {
          attempted.push(n);
          if (n === 2) throw new Error('boom');
        }, { sequential: true });`);
      const attempted = vm.runInContext('attempted', sandbox);
      ok('items after the failure still run', attempted.join(',') === '1,2,3,4,5',
         `attempted ${attempted.join(',')} — this is the KYC loop that stopped at the first throw`);
      ok('and four of five succeed', res.succeeded.length === 4);
    }

    /* The old shape, run side by side. A negative control against the previous
       admin.js only throws on the missing function, which proves the helper is
       new rather than that what it replaced was wrong. This demonstrates the
       defect directly and keeps the reason in the file. */
    console.log('\nthe shape this replaced loses the successes');
    {
      const failing = async id => { if (id === 'b') throw new Error('no'); };

      let lost = null;
      try { await Promise.all(['a', 'b', 'c'].map(failing)); }
      catch (err) { lost = err.message; }
      ok('Promise.all reports only the first failure', lost === 'no');
      ok('and surfaces nothing about a and c, which succeeded', lost === 'no',
         'the caller cannot tell two of three landed — so it either updates all or none');

      const attempted = [];
      let stopped = null;
      try { for (const id of ['a', 'b', 'c']) { attempted.push(id); await failing(id); } }
      catch (err) { stopped = err.message; }
      ok('a bare loop abandons everything after the failure',
         attempted.join(',') === 'a,b' && stopped === 'no',
         `attempted ${attempted.join(',')} — c was never tried`);

      const { sandbox } = harness();
      const res = await run(sandbox, `
        return await _bulkRun(['a','b','c'], async id => { if (id === 'b') throw new Error('no'); });`);
      ok('the runner reports all three outcomes instead',
         res.succeeded.join(',') === 'a,c' && res.failed.length === 1,
         JSON.stringify(res));
    }

    console.log('\nthe report says what actually happened');
    {
      const { sandbox, toasts, errs } = harness();
      await run(sandbox, `_bulkReport('investor', 'FICA approved', { succeeded: [1,2,3], failed: [] });`);
      ok('a clean run reports success', toasts[0][0] === 'success' && /3 investors FICA approved/.test(toasts[0][1]),
         JSON.stringify(toasts[0]));

      await run(sandbox, `_bulkReport('investor', 'FICA approved', {
        succeeded: [1,2,3],
        failed: [{item:4,label:'Thandi Mokoena',message:'x'},{item:5,label:'Sipho Dlamini',message:'y'}] });`);
      const t = toasts[1];
      ok('a partial run is an error, not a success', t[0] === 'error', JSON.stringify(t));
      ok('and gives both counts', /3 FICA approved/.test(t[1]) && /2 failed/.test(t[1]), t[1]);
      ok('naming who failed, so it can be acted on',
         /Thandi Mokoena/.test(t[1]) && /Sipho Dlamini/.test(t[1]), t[1]);
      ok('the reasons go to the console', errs.some(e => /Thandi Mokoena: x/.test(e)), JSON.stringify(errs));

      await run(sandbox, `_bulkReport('document', 'approved', {
        succeeded: [], failed: [1,2,3,4,5].map(n => ({item:n,label:'P'+n,message:'e'})) });`);
      ok('a long failure list is truncated, not dumped',
         /and 2 more/.test(toasts[2][1]), toasts[2][1]);
    }

    console.log('\nsingular and plural read correctly');
    {
      const { sandbox, toasts } = harness();
      await run(sandbox, `_bulkReport('investor', 'archived', { succeeded: [1], failed: [] });`);
      ok('one item is not "1 investors"', /1 investor archived/.test(toasts[0][1]), toasts[0][1]);
    }

    console.log('\nthe shipped call sites use it');
    {
      const sites = [
        ['bulkArchiveInvestors', /_bulkRun\(ids, id => API\.investors\.update\(id, \{ status: 'archived' \}\)/],
        ['bulkApproveFica',      /_bulkRun\(ids, id => API\.investors\.update\(id, \{ fica_status: 'approved'/],
        ['bulkTriggerPayout',    /_bulkRun\(checked,\s*\n\s*id => API\.investments\.update/],
        ['bulkApproveKyc',       /const res = await _bulkRun\(ids, async id => \{\s*\n\s*await API\.kyc\.update\(id, \{ status: 'approved'/],
        ['_executeBulkKycReject',/_bulkRun\(ids, async id => \{\s*\n\s*await API\.kyc\.update\(id, \{ status: 'rejected'/],
        ['the withdrawals bulk', /_bulkRun\(ids, id => API\._fetch\('PATCH', `tables\/transactions/],
      ];
      for (const [name, re] of sites) ok(`${name} runs through the shared runner`, re.test(SRC));

      ok('no bulk action still uses Promise.all over a selection',
         !/Promise\.all\(ids\.map/.test(SRC) && !/Promise\.all\(snapshot\.map/.test(SRC),
         'Promise.all rejects on the first failure and loses every other outcome');
      ok('no KYC loop runs without a per-item catch',
         !/for \(let i = 0; i < ids\.length; i\+\+\) \{\s*\n\s*await API\.kyc\.update/.test(SRC),
         'approve and reject both had this shape — one throw abandoned the rest of the batch');
      ok('a failed notification does not fail the rejection it belongs to',
         /send-investor-email[\s\S]{0,400}?\}\)\.catch\(\(\) => \{\}\)/.test(SRC),
         'an email that does not send is not a reason to report the KYC decision as failed');
    }

    console.log('\nlocal state follows what the server accepted');
    {
      ok('FICA marks only the succeeded investors approved',
         /res\.succeeded\.forEach\(id => \{\s*\n\s*const inv = STATE\.investors\.find/.test(SRC),
         'updating all of them after a partial run is what made the table disagree with the server');
      ok('failures stay selected for a retry',
         (SRC.match(/failed\.forEach\(f => (selectedInvestors|_kycSelected)\.add\(f\.item\)\)/g) || []).length >= 2);
      ok('undo restores only what was actually archived',
         /snapshot\.filter\(s => archived\.succeeded\.includes\(s\.id\)\)/.test(SRC),
         'restoring a row that never moved reports success for doing nothing');
      ok('and undo is not offered when nothing was archived',
         /if \(archived\.succeeded\.length\) Toast\.action/.test(SRC));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  }
  process.exit(fail ? 1 : 0);
})();
