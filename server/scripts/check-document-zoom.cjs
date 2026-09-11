#!/usr/bin/env node
/* Reading a document on a phone.
 *
 * The overlay showed the document at its own width — 1100px for the A4
 * landscape statement — inside a 390px screen, and the packaged app carries
 * user-scalable=no in its viewport so pinch does nothing. A client got the
 * top-left corner of a page and no way to pull back and see the shape of it.
 *
 * The fix is zoom the app cannot take away: the document is SCALED rather
 * than reflowed, it opens fitted to the screen, and there are buttons for
 * what pinch would have done.
 *
 * Run: node server/scripts/check-document-zoom.cjs
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
const read  = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DOCS = read('js/investor-documents.js');
const SRC  = strip(DOCS);
const MOB  = read('mobile/src/index.html');

console.log('\nthe app really does block pinch, which is why this is needed');
{
  const vp = (MOB.match(/<meta name="viewport" content="([^"]*)"/) || ['', ''])[1];
  ok('the packaged shell disables user scaling', /user-scalable=no/.test(vp), vp);
  ok('so the document cannot rely on pinch', /user-scalable=no/.test(vp));
}

console.log('\nthe reader opens fitted, not at full size');
{
  ok('a fit scale is computed from the space available',
     /const fitScale = \(\) => \{[\s\S]{0,200}avail \/ docWidth/.test(SRC));
  ok('and applied when the document loads',
     /frame\.addEventListener\('load'[\s\S]{0,300}setScale\(fitScale\(\)\)/.test(SRC),
     'it opened at 100% on a phone, showing the top-left corner');
  ok('it never scales a document UP to fill a desktop',
     /Math\.min\(1, avail \/ docWidth\)/.test(SRC),
     'a blown-up statement is worse than one at its own size');
}

console.log('\nand the client can change it');
{
  for (const id of ['svc-doc-zoom-out', 'svc-doc-zoom-in', 'svc-doc-zoom-fit']) {
    ok(`${id} is in the bar`, new RegExp(`id="${id}"`).test(SRC));
    ok(`and is wired`, new RegExp(`querySelector\\('#${id}'\\)\\.onclick`).test(SRC));
  }
  ok('the current zoom is shown as a percentage',
     /Math\.round\(scale \* 100\) \+ '%'/.test(SRC),
     '"Fit" alone does not say where you are');
  ok('zoom is bounded so a button cannot run away',
     /Math\.max\(0\.35, Math\.min\(3, v\)\)/.test(SRC));
  ok('and rotating re-fits it',
     /window\.addEventListener\('resize', onResize\)/.test(SRC),
     'the fit is derived from the width, which rotation changes');
  ok('the listener is removed when the reader closes',
     /removeEventListener\('resize', onResize\)/.test(SRC),
     'one listener per document opened, for the life of the session');
}

console.log('\nthe document is scaled, not reflowed');
{
  /* The OVERLAY's frame specifically. The inline preview sets its width the
     same way, and a looser pattern matched that one instead — so a mutation
     that squeezed the reader still passed. */
  const overlayFn = (SRC.match(/function _overlay\(html, docWidth\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok('the reader could be isolated from the preview', overlayFn.length > 200,
     'the assertions below would otherwise be about the wrong frame');
  ok('the frame keeps the document width',
     /frame\.style\.cssText = 'border:0;display:block;background:#fff;width:' \+ docWidth \+ 'px';/.test(overlayFn),
     'squeezing an A4 layout into 390px breaks its columns and its @page rules');
  ok('and a wrapper is transformed instead',
     /shell\.style\.transform = 'scale\(' \+ scale \+ '\)'/.test(SRC));
  ok('with the wrapper sized to the scaled result',
     /shell\.style\.width  = Math\.ceil\(docWidth \* scale\)/.test(SRC),
     'otherwise the scrollbars describe the unscaled document');
}

console.log('\nthe bar fits one row on a phone');
{
  ok('it does not wrap', /flex-wrap:nowrap/.test(SRC),
     'it wrapped onto two rows and ate a fifth of the screen');
  ok('the title gives way rather than the controls',
     /flex:1 1 auto;min-width:0;/.test(SRC) && /text-overflow:ellipsis/.test(SRC));
  ok('and every control keeps its size',
     (SRC.match(/flex:0 0 auto/g) || []).length >= 5,
     'a shrinking button is an unpressable one');
  ok('the icon-only buttons are still labelled for a screen reader',
     (SRC.match(/aria-label="(Zoom out|Zoom in|Fit to screen|Print or save as PDF|Close)"/g) || []).length === 5,
     'an arrow glyph alone announces nothing');
}

/* The scale arithmetic itself, run rather than read. */
console.log('\nthe arithmetic puts a real statement on a real phone');
{
  const m = SRC.match(/const fitScale = \(\) => \{[\s\S]*?\n    \};/);
  if (!m) throw new Error('could not lift fitScale');
  const body = m[0].replace('const fitScale = () =>', 'function fitScale(bodyWidth, docWidth)')
                   .replace('(body.clientWidth || docWidth)', 'bodyWidth')
                   .replace(/;$/, '');
  const ctx = { Math }; vm.createContext(ctx);
  vm.runInContext(body + '\nthis.fitScale = fitScale;', ctx);

  /* A4 landscape statement, 1100px, on a 390px phone. */
  const phone = ctx.fitScale(390, 1100);
  ok('an A4 landscape statement fits a 390px phone',
     phone < 0.4 && phone >= 0.35, String(phone));
  ok('the certificate at 860px fits too',
     ctx.fitScale(390, 860) < 0.5, String(ctx.fitScale(390, 860)));
  ok('a desktop opens the statement at its own size',
     ctx.fitScale(1400, 1100) === 1, String(ctx.fitScale(1400, 1100)));
  ok('and nothing is ever scaled below the floor',
     ctx.fitScale(120, 1100) === 0.35, String(ctx.fitScale(120, 1100)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
