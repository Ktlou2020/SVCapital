#!/usr/bin/env node
/* Four things reported from the phone app.
 *
 * A LABEL CUT IN HALF. "Confirm that I will be a signato" and "Change the
 * mandate or lock d". .btn carries white-space:nowrap, which is right for
 * "Save" and wrong for a sentence on a 390px screen: the button grew wider
 * than its container and the container clipped it mid-word.
 *
 * A CALCULATOR WITH ITS OWN RATE AND TERM. The rate was a read-only box and
 * the term a select of 6/12/18/24/36, and calcLoadPool snapped the pool's
 * REAL term to the closest of those — a five-month pool calculated over six,
 * a seven-year solar pool over three. Two figures that looked like the
 * pool's and were not. Both now come from the chosen pool and are shown
 * rather than entered.
 *
 * A SAVE THAT DID NOTHING ON ANDROID. _handleSavePdf tested window.Capacitor
 * while the whole app tests __SVC_NATIVE__, and fell through to
 * window.print() — which does nothing in a WebView. Two names for one
 * question, and the guard answered the wrong one.
 *
 * AND REFER & EARN BELOW POLICIES. It sat outside the collapsible group, so
 * it rendered after everything in it.
 *
 * Run: node server/scripts/check-app-feedback-nov.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const CORE   = read('js/portal-core.js');
const APPJS  = read('mobile/src/js/portal.js');
const PAGES  = { app: 'mobile/www/index.html', web: 'portal/index.html' };

/* ── 2. The calculator ───────────────────────────────────────────────── */
console.log('\nthe calculator has no rate or term of its own');
{
  for (const [which, file] of Object.entries(PAGES)) {
    const html = read(file);
    ok(`${which}: the rate INPUT is gone`, !/id="calcRate"/.test(html),
       'a rate a client can type is a rate they can screenshot');
    ok(`${which}: the term SELECT is gone`, !/id="calcTerm"/.test(html),
       'its options were a fixed 6/12/18/24/36 and the pool was snapped to '
       + 'the nearest one');
    ok(`${which}: and both are shown instead`,
       /id="calcRateShown"/.test(html) && /id="calcTermShown"/.test(html), file);
    ok(`${which}: with a line saying where they come from`,
       /come from the pool you chose/.test(html), file);
  }

  /* The rule, run. */
  const vm = require('vm');
  /* The slice moved: portal-core may not declare top-level state, so the
     two `let`s this used to anchor on became a function. */
  const from = CORE.indexOf('function _calcPoolTerms');
  const to   = CORE.indexOf('function calcGoInvest');
  ok('the calculator code was found', from > 0 && to > from,
     'a slice that missed it would assert nothing while passing');

  const els = {};
  const ctx = {
    _calcPoolId: null,
    Utils: { rand: n => 'R' + Number(n).toFixed(2) },
    document: {
      getElementById: id => (els[id] = els[id] || { value: '', textContent: '', innerHTML: '', style: {} }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(CORE.slice(from, to)
    + '\nthis.load = calcLoadPool; this.calc = updateCalc;'
    + '\nthis.terms = _calcPoolTerms;', ctx);

  /* A five-month pool at 12% — the one in the screenshot, whose term the
     old select rounded up to six. */
  els.calcPoolSelect = { selectedIndex: 0, options: [{ value: 'POOL-1', dataset: { rate: '0.12', term: '5' } }] };
  ctx.load();
  ok('A FIVE-MONTH POOL IS FIVE MONTHS, not the nearest option',
     ctx.terms().term === 5, String(ctx.terms().term));
  ok('and its rate is the pool\'s', ctx.terms().rate === 0.12, String(ctx.terms().rate));
  ok('the term is shown in words', els.calcTermShown.textContent === '5 months',
     els.calcTermShown.textContent);
  ok('and the rate with its unit', /12\.00% p\.a\./.test(els.calcRateShown.textContent),
     els.calcRateShown.textContent);

  /* And the maths uses them. */
  els.calcAmount = { value: '50000' };
  ctx.calc();
  /* 50 000 at 12% for 5 months = 2 500. Over six it would be 3 000 — the
     figure the old rounding produced. */
  ok('AND THE RETURN IS CALCULATED OVER FIVE MONTHS',
     els.calcReturn.textContent === 'R2500.00',
     els.calcReturn.textContent + ' — over six months it would read R3000.00, '
     + 'which is what the snapped term produced');
  ok('a singular month is not "1 months"',
     (() => { els.calcPoolSelect.options[0].dataset.term = '1'; ctx.load();
              return els.calcTermShown.textContent === '1 month'; })(),
     els.calcTermShown.textContent);
}

/* ── 1. The clipped labels ───────────────────────────────────────────── */
console.log('\nand a button label that does not fit wraps instead of being cut');
{
  const CSS = read('css/admin.css');
  ok('.btn still does not wrap on a wide screen',
     /\.btn \{[^}]*white-space: nowrap/.test(CSS),
     'a toolbar on a desktop console should stay on one line');
  const at = CSS.indexOf('@media (max-width: 560px)');
  const rule = at < 0 ? '' : CSS.slice(at, CSS.indexOf('}\n}', at));
  ok('but it does at phone widths', /\.btn\s*\{[\s\S]*white-space: normal/.test(rule),
     'the label was clipped mid-word: "Confirm that I will be a signato"');
  ok('and cannot grow past its container', /max-width: 100%/.test(rule), rule.slice(0, 200));
}

/* ── 3. Saving the statement ─────────────────────────────────────────── */
console.log('\nand saving the statement asks the same question the app asks');
{
  const at = APPJS.indexOf('async function _handleSavePdf');
  /* COMMENTS STRIPPED. The comment above the guard explains the bug and
     therefore contains the very identifier being looked for, so swapping
     the code back to window.Capacitor alone left this passing on the
     explanation of what the code no longer did. Third time this session. */
  const fn = APPJS.slice(at, APPJS.indexOf('\n}', APPJS.indexOf('catch', at)))
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  ok('the save was found', at > 0 && fn.length > 400);
  ok('and the slice is code, not its comment',
     !/Two names for one question/.test(fn), fn.slice(0, 160));
  ok('IT TESTS __SVC_NATIVE__, the one the rest of the app sets',
     /__SVC_NATIVE__/.test(fn),
     'it tested window.Capacitor alone, and when that was not there it fell '
     + 'through to window.print(), which does nothing in a WebView');
  ok('and window.print is only for a real browser',
     /if \(!native\) \{\s*\n\s*window\.print\(\);/.test(fn), fn.slice(0, 300));
  ok('the PDF goes through the one deliverer',
     /svcDeliverFile\(/.test(fn),
     'it carried its own copy of the share rule — the copy every other '
     + 'document lacked');
  ok('and it no longer keeps its own download fallback',
     !/a\.click\(\)/.test(fn), fn.slice(-300));
}

/* ── 4. The menu ─────────────────────────────────────────────────────── */
console.log('\nand Refer & Earn sits above Platform Policies');
{
  for (const [which, file] of Object.entries(PAGES)) {
    const html = read(file);
    const refer = html.indexOf('data-view="referral"');
    const pol   = html.indexOf('data-view="policies"');
    ok(`${which}: both are in the menu`, refer > 0 && pol > 0, `${refer} / ${pol}`);
    ok(`${which}: REFER & EARN COMES FIRST`, refer < pol,
       `referral at ${refer}, policies at ${pol}`);
    /* It used to sit outside the collapsible group, which is why it rendered
       after everything inside it. */
    const between = html.slice(refer, pol);
    ok(`${which}: and they are in the same group`,
       !/<\/div>/.test(between),
       'a </div> between them means the referral is outside the group again '
       + 'and will render after it');
    ok(`${which}: the "not yet live" comment is gone`,
       !/Referral nav hidden/.test(html), file);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
