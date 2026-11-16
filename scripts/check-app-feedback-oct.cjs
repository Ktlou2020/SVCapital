#!/usr/bin/env node
/* Four things from the October app feedback, each with its own reason.
 *
 * TWO "PRINT / SAVE PDF" BUTTONS. The statement preview bar carries one and
 * the document mounted inside it carries its own. _overlay already hid the
 * document's copy — its comment says why: in the packaged app it is the DEAD
 * one, because it calls window.print(), which iOS's WKWebView does not have
 * and Android's WebView ignores. The inline preview never hid it, which is
 * the only reason two were on screen. The one in the bar goes through the
 * share sheet, so that is the one that stays — the request was to drop the
 * one beside Refresh, and dropping that one would have left only the button
 * that does nothing on a phone.
 *
 * A CALCULATOR THAT TOOK ANY RATE. A client could type a rate SV Capital has
 * never offered and the calculator would show the return on it; a screenshot
 * of that is indistinguishable from a quote. The rate is read-only now and
 * comes from the chosen pool, and there is no "custom rate" option to pick.
 *
 * "AVG RETURN P.A." THAT WAS NOT PER ANNUM. The product grid read
 * avg_actual_rate — the return achieved over each pool's OWN period — under a
 * label saying P.A. for every product but short_term. On solar_7yr that
 * presented seven years' return as one year's. The products route has
 * carried the annualised average all along, with a comment saying it exists
 * for this tile and nothing read it yet.
 *
 * A QUEST THAT LOOKED LOCKED. "Refer Your First Friend" showed a PADLOCK
 * beside the word "Available" — a contradiction — and offered no way to go
 * and do it, so the only route was finding Refer & Earn in the side menu.
 *
 * Run: node scripts/check-app-feedback-oct.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const CORE = strip(read('js/portal-core.js'));
const DOCS = strip(read('js/investor-documents.js'));

console.log('\nonly one Print / Save PDF button is on screen at a time');
{
  /* Both mounts must hide the document's own button; neither may be the
     one that is kept, because it is the dead one in the app. */
  const mount = DOCS.slice(DOCS.indexOf('function _mountScaled'),
                           DOCS.indexOf('function _present'));
  ok('the inline preview was found', mount.length > 200);
  ok('IT HIDES THE DOCUMENT\'S OWN PRINT BUTTON',
     /button\[onclick\*="print"\]/.test(mount) && /display = 'none'/.test(mount),
     'two were on screen because only the overlay hid it');
  const overlay = DOCS.slice(DOCS.indexOf('function _overlay'),
                             DOCS.indexOf('function _isNativeApp'));
  ok('and so does the full-screen overlay, as it already did',
     /button\[onclick\*="print"\]/.test(overlay), overlay.slice(0, 200));
  /* The surviving button must be the share-sheet one, not window.print(). */
  const portal = strip(read('mobile/src/js/portal.js'));
  /* To the function's own closing brace, not a fixed number of characters:
     the first version cut at 400 and stopped one line short of the call it
     was looking for, failing on code that was correct. */
  const pAt = portal.indexOf('function printStatement');
  const fn = portal.slice(pAt, portal.indexOf('\n}', pAt) + 2);
  ok('the button that stays opens the document, not window.print()',
     /SVCDocs\.openAccountStatement/.test(fn) && !/window\.print\(\)/.test(fn),
     fn.slice(0, 200) + ' — window.print() is the one that does nothing on a phone');
}

console.log('\nand the calculator cannot be given a rate nobody offered');
{
  for (const f of ['mobile/src/index.html', 'portal/index.html']) {
    const html = strip(read(f));
    const at = html.indexOf('id="calcRate"');
    ok(`${f.split('/')[0]}: the rate field was found`, at > 0);
    const field = html.slice(html.lastIndexOf('<input', at), html.indexOf('>', at) + 1);
    ok(`${f.split('/')[0]}: THE RATE IS READ-ONLY`,
       /\breadonly\b/.test(field), field.slice(0, 200));
    ok(`${f.split('/')[0]}: and typing in it no longer recalculates`,
       !/oninput="updateCalc\(\)"/.test(field), field.slice(0, 200));
    /* The element carried id="calcRate" twice; the second was ignored. */
    ok(`${f.split('/')[0]}: and carries its id once`,
       (field.match(/id="calcRate"/g) || []).length === 1, field.slice(0, 200));
    ok(`${f.split('/')[0]}: no "custom rate" is offered`,
       !/Custom rate/.test(html), 'a custom rate is a quote nobody authorised');
  }
  ok('the picker is built without a custom option',
     !/Custom rate/.test(CORE) && /Choose a pool/.test(CORE), 'js/portal-core.js');
  ok('and the calculator opens on a real pool',
     /sel\.selectedIndex = 1;[\s\S]{0,40}calcLoadPool\(\)/.test(CORE),
     'otherwise it opens on a default rate with no pool behind it');
}

console.log('\nand an average labelled p.a. is per annum');
{
  ok('the product grid reads the ANNUALISED average',
     /p\.avg_annual_rate > 0 \? parseFloat\(p\.avg_annual_rate\)/.test(CORE),
     'avg_actual_rate is the return over each pool\'s own period');
  ok('and the label no longer says "(N MO)" for an average',
     /if \(isAvg\) return 'AVG RETURN P\.A\.';/.test(CORE)
     && !/AVG RETURN \(\$\{termMonths\} MO\)/.test(CORE),
     'the figure is annualised now, so a period label would be the lie reversed');
  /* The target is a different figure and keeps its period form. */
  ok('while a TARGET on a short-term pool keeps its period label',
     /TARGET RETURN \(\$\{termMonths\} MO\)/.test(CORE),
     'a short_term pool\'s stored target really is a period rate');
  /* The server side this depends on. */
  const PROD = read('server/routes/products.js');
  ok('the annualised average is what the server computes',
     /ip\.actual_rate \* 12\.0 \/ ip\.term_months[\s\S]{0,400}AS avg_annual_rate/.test(PROD),
     'the grid would be reading a field that does not exist');
  ok('and the track record annualises on the same basis',
     /const annualActual = term > 0 \? actual \* 12 \/ term : actual;/.test(PROD),
     'Browse Pools and the product grid must not disagree');
}

console.log('\nand a quest you can act on says how');
{
  ok('there is no padlock beside the word Available',
     !/fa-lock-open"><\/i> Available/.test(CORE),
     'a lock icon labelled "Available" is a contradiction, and it read as locked');
  ok('a quest with somewhere to go offers the way there',
     /_questRoutes\(\)\[quest\.id\]/.test(CORE), 'js/portal-core.js');
  ok('and Refer Your First Friend goes to Refer & Earn',
     /first_referral:\s*go\('referral'\)/.test(CORE),
     'it was only reachable from the side menu');
  ok('with a label that says what it does',
     /first_referral:\s*'Invite'/.test(CORE), CORE.slice(0, 0));
  ok('and a quest with nowhere to go says so plainly',
     /Not yet<\/div>/.test(CORE),
     'reaching R100,000 invested is not a button');
  /* The route must point at a view that exists. */
  const html = read('mobile/src/index.html');
  for (const v of ['referral', 'marketplace', 'wallet']) {
    ok(`the ${v} view exists to route to`,
       new RegExp(`data-view="${v}"`).test(html), v);
  }
}

console.log('\nand the Murabaha minimum a new environment seeds is R1m');
{
  const SETUP = read('server/db/setup.js');
  const at = SETUP.indexOf("product_type: 'eif_murabaha'");
  ok('the Murabaha seed was found', at > 0);
  const block = SETUP.slice(at, at + 2000);
  const m = /min_investment:\s*(\d+)/.exec(block);
  ok('and its minimum is R1 000 000', m && Number(m[1]) === 1000000,
     m ? `R${Number(m[1]).toLocaleString('en-ZA')}` : 'no min_investment found');
  /* Worth saying in the check, because it is why this was wrong for so long
     and why fixing it changes nothing on a running environment. */
  ok('the seed is still ON CONFLICT DO NOTHING, so it never rewrites a live product',
     /ON CONFLICT \(product_type\) DO NOTHING/.test(SETUP),
     'if this ever became an upsert, every console edit would be reverted on deploy');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
