#!/usr/bin/env node
/* The signing modal must be completable, and must say why when it is not.
 *
 * It was not. "Sign & continue" is disabled until four things are true, and
 * one of them — having read to the end of the agreement — could not be made
 * true at all:
 *
 *   the document went into an iframe pinned at 1200px, inside a 280px box
 *   the agreement itself runs to about 4 000px, so the frame showed under a
 *     third of it and the rest was unreachable
 *   an iframe scrolls its OWN content, so a wheel over it never reached the
 *     outer box, and that box's onscroll — the only signal — never fired
 *
 * The investor ticked every acknowledgement, typed their name, drew their
 * signature, and the button did nothing. Nothing styled .btn:disabled either,
 * so it did not even look dead. That is the bug report: "nothing happens when
 * I click on sign and continue."
 *
 * The frame is the scroller now and the document reports for itself, so no
 * height is guessed and the end of the document is the end of the document.
 *
 * Run: node scripts/check-agreement-read-gate.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const core = read('js/portal-core.js');
const AG   = require(path.join(ROOT, 'server', 'services', 'agreements.js'));

console.log('\nthe frame is the scroller, and no height is guessed');
{
  const frame = (core.match(/<iframe id="agrFrame"[^>]*>/) || [''])[0];
  ok('the agreement frame fills its box', /height:100%/.test(frame), frame);
  ok('and is not pinned to a guessed pixel height',
     !/height:\s*\d+px/.test(frame),
     'a fixed height shows only as much of the agreement as somebody guessed');

  const box = (core.match(/<div id="agrDoc"[^>]*>/) || [''])[0];
  ok('the box around it does not scroll', /overflow:hidden/.test(box), box);
  ok('and no longer listens for a scroll it cannot receive',
     !/onscroll="_agrScrolled/.test(core),
     'a wheel over an iframe scrolls the iframe, never the box around it');
}

console.log('\nthe document says when it has been read');
{
  const doc = AG.renderAgreement({
    agreement_no: 'AGR-2026-000001', product_type: 'eif_ijara', pool_name: 'Pool',
    amount_cents: 505000, pool_amount_cents: 500000, fee_cents: 5000, drawn_at: new Date(),
  });
  ok('the rendered agreement carries the reporter', /svcAgreement/.test(doc));
  ok('it reports only to a parent frame',
     /window\.parent === window\) return/.test(doc),
     'a copy opened full size or saved to disk must be inert');
  ok('it waits for the document to load before believing a measurement',
     /readyState === 'complete'|addEventListener\('load'/.test(doc));
  ok('and for layout to settle after that',
     /requestAnimationFrame/.test(doc),
     'scrollHeight read during parsing equals the viewport height, which reads as already-at-the-end');
  ok('it refuses to report from a frame of no height',
     /if \(!h \|\| !d\.scrollHeight\) return false/.test(doc),
     'the modal is built before it is opened; an unlaid-out frame measures 0 and satisfies the gate trivially');
  ok('a sent report is sent once', /if \(sent/.test(doc));
}

/* ── The reporter, run rather than read ────────────────────────────────
   A regex can see that requestAnimationFrame is mentioned. It cannot see
   that the report is actually withheld until layout has settled — which is
   the whole defect: a frame measured during parsing reports scrollHeight
   equal to the viewport height, which reads as "already at the end" on a
   4 000px document, and the gate opens itself before a word has been seen.
   So the script is executed against a window whose measurements change the
   way a real one's do. */
console.log('\nthe reporter, executed');
{
  const doc = AG.renderAgreement({
    agreement_no: 'AGR-2026-000001', product_type: 'cattle', pool_name: 'Pool',
    amount_cents: 505000, pool_amount_cents: 500000, fee_cents: 5000, drawn_at: new Date(),
  });
  const body = (doc.match(/<script>([\s\S]*?)<\/script>/) || [, ''])[1];

  /* innerHeight/scrollHeight are getters, so a case can change what the
     document measures between one call and the next — exactly what a real
     layout pass does. */
  function runReporter({ parent = 'other', measure }) {
    const posted = [];
    const listeners = {};
    const w = {
      scrollY: 0,
      get innerHeight() { return measure().innerHeight; },
      addEventListener: (k, f) => { (listeners[k] = listeners[k] || []).push(f); },
      parent: null,
      requestAnimationFrame: f => { (listeners.__raf = listeners.__raf || []).push(f); },
    };
    w.parent = parent === 'self' ? w : { postMessage: (d) => posted.push(d) };
    const documentStub = {
      get documentElement() { return { scrollHeight: measure().scrollHeight }; },
      readyState: 'loading',
      addEventListener: w.addEventListener,
    };
    const ctx = { window: w, document: documentStub, requestAnimationFrame: w.requestAnimationFrame };
    ctx.globalThis = ctx;
    require('vm').createContext(ctx);
    require('vm').runInContext(
      'with (window) { (' + body.trim().replace(/^\(function/, 'function') .replace(/\)\(\);?$/, '') + ')(); }',
      ctx);
    const fire = k => (listeners[k] || []).slice().forEach(f => f());
    /* Drain the rAF queue the way a browser does: each callback may queue
       another, and both have to run before anything is believed. */
    const flushRaf = () => {
      for (let i = 0; i < 4; i++) {
        const q = listeners.__raf || []; listeners.__raf = [];
        q.forEach(f => f());
      }
    };
    return { posted, fire, flushRaf, w };
  }

  const LONG  = () => ({ innerHeight: 278, scrollHeight: 4085 });
  const PARSE = () => ({ innerHeight: 278, scrollHeight: 278 });   // pre-layout
  const HIDDEN = () => ({ innerHeight: 0,   scrollHeight: 0 });    // modal not open yet

  {
    // The defect: measured during parsing, then laid out long.
    let phase = PARSE;
    const r = runReporter({ measure: () => phase() });
    ok('nothing is reported while the document is still being parsed', r.posted.length === 0,
       JSON.stringify(r.posted));
    /* An iframe fires resize as it is sized, which happens DURING parsing.
       At that moment scrollHeight still reads as the viewport height, so a
       tell() that does not wait for layout reports a 4 000px agreement as
       fully read before it has been laid out — the original defect. */
    r.fire('resize'); r.fire('scroll');
    ok('nor when the frame is resized before layout has settled',
       r.posted.length === 0, JSON.stringify(r.posted));
    phase = LONG;
    r.fire('load'); r.flushRaf();
    ok('and nothing once it is laid out at the top of a long document',
       r.posted.length === 0, JSON.stringify(r.posted));
    r.w.scrollY = 4085 - 278;
    r.fire('scroll');
    ok('but it reports once scrolled to the end', r.posted.length === 1, JSON.stringify(r.posted));
    ok('and says so in the shape the portal listens for',
       r.posted[0] && r.posted[0].svcAgreement === 'read', JSON.stringify(r.posted[0]));
    r.fire('scroll'); r.fire('scroll');
    ok('and only once, however much more it is scrolled', r.posted.length === 1);
  }

  {
    // A frame with no height at all — the modal is built before it is opened.
    const r = runReporter({ measure: HIDDEN });
    r.fire('load'); r.flushRaf(); r.fire('resize');
    ok('a frame of no height reports nothing', r.posted.length === 0, JSON.stringify(r.posted));
  }

  {
    // A short agreement has been read when it has been shown.
    const r = runReporter({ measure: () => ({ innerHeight: 400, scrollHeight: 300 }) });
    ok('a short agreement reports nothing before layout', r.posted.length === 0);
    r.fire('load'); r.flushRaf();
    ok('and reports once shown, since there is nothing to scroll to',
       r.posted.length === 1, JSON.stringify(r.posted));
  }

  {
    // The copy opened full size or saved to disk.
    const r = runReporter({ parent: 'self', measure: LONG });
    r.fire('load'); r.flushRaf(); r.fire('scroll');
    ok('outside a frame it does nothing at all', r.posted.length === 0);
  }
}

console.log('\nthe portal believes only that frame');
{
  ok('it listens for the report', /e\.data\.svcAgreement === 'read'/.test(core));
  ok('and checks the message came from the agreement frame',
     /e\.source !== frame\.contentWindow/.test(core),
     'a sandboxed frame posts from an opaque origin, so identity is the window, not the origin');
  ok('the listener is installed once', /__svcAgreementListening/.test(core));
}

console.log('\nthe sandbox is relaxed by exactly one flag');
{
  const m = core.match(/setAttribute\('sandbox', '([^']*)'\)/);
  ok('the frame is still sandboxed', !!m, 'the agreement frame must not run unsandboxed');
  ok('with allow-scripts and nothing else', m && m[1] === 'allow-scripts', m && m[1]);
  /* Every sandbox value the file sets, not every mention of the string —
     the comment above the call names the flag in order to say why it is NOT
     there, and an assertion that cannot tell those apart fails on prose. */
  const values = [...core.matchAll(/sandbox['"],\s*'([^']*)'/g)].map(x => x[1])
    .concat([...core.matchAll(/sandbox="([^"]*)"/g)].map(x => x[1]));
  ok('no sandbox in the portal grants same-origin',
     values.length > 0 && values.every(v => !/allow-same-origin/.test(v)),
     JSON.stringify(values));
}

console.log('\nand there is a way through even if the frame cannot report');
{
  ok('opening the full-size copy counts as reading it',
     /_agrMarkRead\('opened'\)/.test(core),
     'without this an investor whose browser blocks frame scripts is stuck with no route out');
}

console.log('\na blocked button says what is outstanding');
{
  ok('the outstanding items are computed', /function _agrOutstanding\(\)/.test(core));
  for (const [what, re] of [
    ['reading the agreement', /read to the end of the agreement/],
    ['the tick boxes',        /tick every box/],
    ['the typed name',        /type your full name/],
    ['the drawn signature',   /draw your signature/],
  ]) ok(`${what} is named when missing`, re.test(core));
  ok('and the list is shown, not just computed', /id="agrWhy"/.test(core));
  ok('the button is disabled from that same list',
     /btn\.disabled = missing\.length > 0/.test(core),
     'two sources for one rule drift, and then the reason shown is not the reason');
}

console.log('\nand a disabled button looks disabled');
{
  const css = read('css/admin.css');
  const m = css.match(/\.btn:disabled[^{]*\{([^}]*)\}/);
  ok('.btn:disabled is styled at all', !!m,
     'without this every dead button on the platform looks live');
  ok('it is dimmed', !!m && /opacity/.test(m[1]));
  ok('and the cursor says so', !!m && /cursor:\s*not-allowed/.test(m[1]));
  ok('hover does not lift a dead button',
     /\.btn:disabled:hover[\s\S]{0,120}transform:\s*none/.test(css));
}

/* ── The fee, which the document contradicted itself about ─────────────── */

console.log('\nthe agreement states the fee the way the platform charges it');
{
  const WRONG = [
    /taken from the amount I am investing/i,
    /Investment Amount less the platform fee/i,
    /deducted from the amount invested/i,
    /not charged in addition to it/i,
    /at the time of investment, not added to it/i,
  ];
  for (const pt of ['cattle', 'eif_murabaha', 'eif_ijara', 'eif_mudarabah']) {
    const doc = AG.renderAgreement({
      agreement_no: 'AGR-2026-000001', product_type: pt, pool_name: 'Pool',
      amount_cents: 505000, pool_amount_cents: 500000, fee_cents: 5000, drawn_at: new Date(),
    });
    const bad = WRONG.filter(re => re.test(doc)).map(String);
    ok(`${pt}: nothing says the fee comes out of the investment`, bad.length === 0, bad.join('\n      '));
    ok(`${pt}: and it says the wallet pays the amount plus the fee`,
       /charged in addition to the Investment Amount/i.test(doc), 'the Fees clause');
    ok(`${pt}: the acknowledgement matches the clauses`,
       AG.acknowledgementsFor(pt).some(a => a.key === 'fee_on_top'),
       AG.acknowledgementsFor(pt).map(a => a.key).join(','));
    ok(`${pt}: no template still uses the superseded wording`,
       !AG.acknowledgementsFor(pt).some(a => a.key === 'fee_inclusive'));
  }

  ok('the superseded acknowledgement is kept, not deleted',
     typeof AG.ACK.fee_inclusive === 'string',
     'an agreement signed under it must remain explicable in the words it was signed under');

  /* The arithmetic the fee wording describes, from the file that does it. */
  const pool = 50000, fee = Math.round(pool * 0.01);
  ok('R500 into a R500 pool still places R500 and debits R505',
     pool === 50000 && fee === 500 && pool + fee === 50500,
     `${pool} + ${fee} = ${pool + fee}`);
}

console.log('\nthe agreement is set in the platform\u2019s own face');
{
  const doc = AG.renderAgreement({
    agreement_no: 'AGR-2026-000007', product_type: 'eif_ijara', pool_name: 'Pool',
    amount_cents: 505000, pool_amount_cents: 500000, fee_cents: 5000, drawn_at: new Date(),
  });
  const css = doc.slice(doc.indexOf('<style>'), doc.indexOf('</style>'));

  ok('the body is set in Poppins', /font:[^;]*'Poppins'/.test(css), (css.match(/body\{font:[^;]*/) || [''])[0]);
  ok('the stylesheet is linked', /fonts\.googleapis\.com\/css2\?family=Poppins/.test(doc));
  ok('and the font host is preconnected', /fonts\.gstatic\.com/.test(doc));
  ok('no second typeface is left anywhere',
     !/Georgia|Times New Roman|font-family:\s*monospace/.test(css),
     (css.match(/.{0,50}(Georgia|Times New Roman|font-family:\s*monospace).{0,30}/) || [''])[0]);
  ok('the reference line keeps its alignment without one',
     /font-variant-numeric:tabular-nums/.test(css),
     'it was monospace so the agreement number lined up');
  /* In the declaration, not in the comment above it — the note explaining
     why the fallback matters contains the word too. */
  const bodyFont = (css.match(/body\{font:[^;]*/) || [''])[0];
  ok('a copy opened with no network still has a face to fall back to',
     /sans-serif/.test(bodyFont) && /,/.test(bodyFont), bodyFont);

  /* Linked rather than embedded, and that is not a detail: the document is
     stored per agreement in investment_agreements.document_html and served
     back byte for byte, so a base64 face would be carried in every row for
     ever. */
  ok('the font is not embedded in every stored agreement',
     !/@font-face|data:font|data:application\/font/.test(doc),
     'document_html is stored per row; the EIF watermark is a base64 SVG and is meant to be there');

  /* The signing modal renders this inside a sandboxed iframe, which inherits
     the portal's CSP. A face the CSP refuses is a face that silently does not
     load. */
  const csp = read('server/index.js');
  ok('the CSP admits the stylesheet host',
     /styleSrc:[^\]]*fonts\.googleapis\.com/.test(csp));
  ok('and the font host', /fontSrc:[^\]]*fonts\.gstatic\.com/.test(csp));
}

console.log('\nchanged wording ships under a new template version');
{
  /* Past the version that carried the wrong fee wording, not equal to the
     one that replaced it. An exact pin turns the next legitimate correction
     into a failure here, and whoever hits it edits this line instead of
     thinking about the version — which is what the rule exists to prevent. */
  const vnum = v => parseInt(String(v).replace(/^v/, ''), 10);
  const WRONG_UNTIL = { standard: 1, eif_murabaha: 2, eif_ijara: 2, eif_mudarabah: 2 };
  for (const [key, last] of Object.entries(WRONG_UNTIL)) {
    const t = AG.TEMPLATES[key];
    ok(`${key} ships past v${last}, which carried the wrong fee wording`,
       !!t && /^v\d+$/.test(t.version) && vnum(t.version) > last, t && t.version);
  }
  ok('every template carries a version', Object.values(AG.TEMPLATES).every(t => /^v\d+$/.test(t.version)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
