#!/usr/bin/env node
/* One list of next steps, not three.
 *
 * The overview carried two checklists. "Getting Started" listed Identity
 * Verification / Add Bank Account / Add Funds / Make First Investment, and
 * the Action Centre listed the same four in different words plus the risk
 * profile — then repeated its own first outstanding item underneath itself as
 * a "Recommended next step" with its own button. A client was asked to add
 * funds three times on one screen.
 *
 * Worse, the two disagreed. Getting Started tested fica_status === 'approved'
 * exactly; the Action Centre normalises what the verification provider
 * actually sends, so a client recorded as "Approved" was complete in one
 * panel and outstanding in the other.
 *
 * And the wallet step measured the balance RIGHT NOW, so a client who funded
 * their wallet and invested all of it went back to incomplete — permanently.
 * That is the reported screenshot: two live investments, R0 in the wallet, and
 * a checklist stuck at 4/5 asking for the one thing already done.
 *
 * The shipped renderer is lifted and RUN against each of those states, because
 * what matters is what a client is shown, not which words are in the file.
 *
 * Run: node server/scripts/check-action-centre.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const CORE = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

function slice(name) {
  let at = CORE.indexOf(`async function ${name}(`);
  if (at < 0) at = CORE.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} not found in js/portal-core.js`);
  const end = CORE.indexOf('\n}\n', at);
  if (end < 0) throw new Error(`could not find the end of ${name}`);
  return CORE.slice(at, end + 3);
}

/* Run the shipped renderer against a given client and read back what a person
   would actually see. */
function render({ investor, investments = [], transactions = [] }) {
  const els = {};
  const mk = id => (els[id] = { id, style: { display: '' }, innerHTML: '', textContent: '',
    insertAdjacentElement() {}, parentNode: {} });
  mk('taskCompletionPanel'); mk('taskCompletionBody'); mk('taskCompletionMeta'); mk('welcomeBanner');

  const sandbox = {
    PORTAL: { investor, investments, transactions },
    document: {
      getElementById: id => els[id] || null,
      createElement: () => ({ id: '', style: { cssText: '' }, innerHTML: '' }),
    },
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    slice('_normFicaStatus') + '\n' +
    slice('_isInvestorFicaApproved') + '\n' +
    /* The panel already exists in this fixture, so the creator returns it. */
    'function _ensureTaskCompletionPanel() { return document.getElementById("taskCompletionPanel"); }\n' +
    slice('renderTaskCompletionPanel'), sandbox);
  sandbox.renderTaskCompletionPanel();

  const html = els.taskCompletionBody.innerHTML;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&middot;|&mdash;/g, '-').replace(/\s+/g, ' ');
  return { hidden: els.taskCompletionPanel.style.display === 'none',
           meta: els.taskCompletionMeta.textContent, html, text };
}

const BASE = {
  id: 'I1', fica_status: 'approved', kyc_status: 'approved',
  bank_account_number: '123', bank_account_status: 'approved',
  risk_profile: 'moderate', wallet_balance: '0.00',
};

console.log('\nthe step that could never be completed');
{
  /* The reported client: verified, banked, risk profile done, two live
     investments, and an empty wallet because it all went into them. */
  const invested = render({ investor: BASE, investments: [{ id: 'X' }, { id: 'Y' }] });
  ok('a client who invested their wallet is not still asked to fund it',
     invested.meta === '5/5 complete', invested.meta);
  /* Read off a client who still has something outstanding, because a panel
     with nothing left to do hides without drawing a body — so there would be
     no rows to inspect in the case above. */
  const investedNoRisk = render({ investor: { ...BASE, risk_profile: null },
                                  investments: [{ id: 'X' }] });
  ok('and the wallet row reads as done while the panel is still up',
     /Add funds to your wallet.{0,40}Completed/.test(investedNoRisk.text),
     investedNoRisk.text.slice(0, 260));
  ok('with the outstanding one marked instead',
     /Confirm your risk profile.{0,40}Next up/.test(investedNoRisk.text),
     investedNoRisk.text.slice(0, 260));
  ok('and the panel takes itself off the screen', invested.hidden === true,
     'a finished checklist is clutter on every visit afterwards');

  /* A deposit that has been spent counts too — the money did arrive. */
  const deposited = render({ investor: BASE,
    transactions: [{ type: 'deposit', status: 'completed', amount: 500 }] });
  ok('a past deposit counts even when the balance is back to zero',
     /Add funds to your wallet.{0,40}Completed/.test(deposited.text));
  ok('but a rejected one does not',
     !/Add funds to your wallet.{0,40}Completed/.test(
       render({ investor: BASE, transactions: [{ type: 'deposit', status: 'rejected' }] }).text),
     'money that never arrived is not money that arrived');

  /* And somebody who genuinely has not funded still gets asked. */
  const fresh = render({ investor: BASE });
  ok('a client who has never funded is still asked', fresh.meta === '3/5 complete', fresh.meta);
  ok('and the panel is shown to them', fresh.hidden === false);
}

console.log('\nan action is listed once');
{
  const fresh = render({ investor: BASE });
  const addFunds = (fresh.text.match(/Add funds/gi) || []).length;
  ok('"Add funds" appears once in the panel', addFunds === 1, `${addFunds} times: ${fresh.text}`);
  /* The panel used to end by repeating its own first outstanding item. */
  ok('and the panel no longer repeats its next step underneath itself',
     !/Recommended next step/i.test(fresh.text), fresh.text.slice(0, 200));
  ok('it marks the next one instead', /Next up/i.test(fresh.text));
  ok('exactly one task is marked next',
     (fresh.html.match(/ac-task--next/g) || []).length === 1);
  ok('and it is the first outstanding one, not a completed one',
     /Add funds to your wallet.{0,60}Next up/.test(fresh.text), fresh.text.slice(0, 260));
}

console.log('\nthere is only one checklist left');
{
  for (const shell of ['portal/index.html', 'mobile/src/index.html']) {
    const html = read(shell);
    ok(`${shell} has no Getting Started panel`,
       !/id="onboardingWizard"/.test(html) && !/>Getting Started</.test(html),
       'two checklists of the same steps, in different words');
    ok(`${shell} still has somewhere to put the Action Centre`,
       /id="welcomeBanner"/.test(html), 'the panel anchors to it');
  }
  ok('and nothing calls the removed renderer',
     !/renderOnboardingWizard\(\)/.test(CORE + read('portal/js/portal.js') + read('mobile/src/js/portal.js')),
     'a call to a function that no longer exists stops the whole overview render');
  ok('nor its dismiss button',
     !/dismissOnboarding/.test(read('portal/index.html') + read('mobile/src/index.html')));

  /* The two panels used different FICA rules, so they could disagree about
     the same client. Only the normalising one is left. */
  const r = render({ investor: { ...BASE, fica_status: 'Approved', kyc_status: 'Approved' } });
  ok('a provider’s capitalised "Approved" counts as verified',
     /Complete identity verification.{0,40}Completed/.test(r.text),
     'the removed panel compared it exactly and called this client unverified');
}

console.log('\nand the client is told it moved');
{
  const setup = read('server/db/setup.js');
  ok('the change is announced to staff', /ANN-2026-ACTION-CENTRE/.test(setup),
     'CLAUDE.md: a change to where something is needs a notice');
  ok('and the notice says where to find it',
     /ANN-2026-ACTION-CENTRE[\s\S]{0,1600}?where: '[^']{20,}'/.test(setup),
     'the field that turns a notice into something somebody can act on');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
