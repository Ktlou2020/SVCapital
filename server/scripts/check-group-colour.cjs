#!/usr/bin/env node
/* The group screens' palette, and the two ways it comes undone.
 *
 * These screens were accented in the platform purple, #eda5ff, at
 * thirty-five sites. A review of the staging stokvel pages asked for green
 * and amber instead: a group's banner should read as its own thing, what
 * is approved should read as settled, and what is waiting on somebody
 * should read as waiting.
 *
 * THAT IS A DELIBERATE EXCEPTION to the brand rule, which says #eda5ff is
 * the single canonical purple platform-wide. It still is, and the personal
 * portal still uses it — the group screens are carved out, and CLAUDE.md
 * records the carve-out so nobody reads the divergence as a mistake. This
 * check is the other half of that record.
 *
 * ── THE TWO WAYS IT COMES UNDONE ─────────────────────────────────────
 *
 * 1. Purple comes back. One copied line from a personal-portal screen and
 *    a group page has a lilac border again. So: no purple at all inside
 *    the group functions.
 *
 * 2. The colours scatter. The purple was written out thirty-five times,
 *    which is exactly why it could not be changed without reading all
 *    thirty-five. Replacing it with four more literals written out
 *    thirty-five times would leave the next change just as expensive. So:
 *    the group functions name the constants and do not write the group
 *    palette's hex values by hand.
 *
 * AND THE PERSONAL PORTAL IS LEFT ALONE. A check that simply banned
 * #eda5ff from the file would delete the brand from seventeen screens
 * nobody reviewed. The ban is scoped to the group functions by name.
 *
 * Run: node server/scripts/check-group-colour.cjs
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

const CORE = read('js/portal-core.js');

/* The group's own screens, by the function that draws each one. Named
   rather than guessed from a line range: the file is 17 000 lines and a
   range goes stale the first time anything is inserted above it. */
const GROUP_FNS = [
  '_svBadge', '_svContributions', '_svFoundingPanel', '_svHeader',
  '_svHeaderFigures', '_svInviteCard', '_svMembers', '_svNoticeFund',
  '_svOverview', '_svPayouts', '_svRenderInviteBanner', '_svSignatoryNote',
  '_svWithdrawals', '_svWsTabs', 'renderGroupsView', 'renderStokvelSwitcher',
];

/* Every line of the file, tagged with the function it is inside. */
function linesByFunction() {
  const out = [];
  let fn = '(top level)';
  CORE.split('\n').forEach((l, i) => {
    const m = l.match(/^(?:async )?function ([A-Za-z0-9_$]+)/);
    if (m) fn = m[1];
    out.push({ n: i + 1, fn, text: l });
  });
  return out;
}
const LINES = linesByFunction();
const groupLines = LINES.filter(l => GROUP_FNS.includes(l.fn));

const PURPLE = /eda5ff|237,\s*165,\s*255|2d1d6e/i;

/* ══ 1. The group screens carry no purple ══════════════════════════ */
console.log('\nthe group screens carry no purple');
{
  ok('EVERY GROUP FUNCTION IS STILL IN THIS FILE',
     GROUP_FNS.every(f => LINES.some(l => l.fn === f)),
     'a function renamed out from under this list would empty the check '
     + 'and pass: ' + GROUP_FNS.filter(f => !LINES.some(l => l.fn === f)).join(', '));
  ok('and there are lines inside them to check',
     groupLines.length > 200, String(groupLines.length));

  const offenders = groupLines.filter(l => PURPLE.test(l.text));
  ok('NO PURPLE IN ANY OF THEM', offenders.length === 0,
     offenders.map(o => `${o.fn}:${o.n}`).join(', '));
}

/* ══ 2. And the palette is named, not retyped ══════════════════════ */
console.log('\nand the palette is named rather than written out');
{
  const PALETTE = { SV_GREEN: '#078e07', SV_GOLD: '#ff9b0c',
                    SV_INK: '#303030', SV_GREY: '#656565' };
  /* AS FUNCTIONS, AND NOT AS CONSTS. portal-core.js is loaded in the
     same scope as portal.js in both shells, so a top-level `const` here
     collides with one of the same name there — and a redeclaration is a
     SyntaxError, which does not break one card, it stops the whole
     portal parsing. check-portal-split enforces that for the file; this
     asserts the palette specifically, because it is the thing most
     likely to be written as a const by somebody adding a sixth colour.
     EIF_CATEGORY() and EIF_ICON() are the same shape. */
  for (const [name, hex] of Object.entries(PALETTE)) {
    ok(`${name} is defined once, as ${hex}`,
       new RegExp(`function ${name}\\(\\)\\s*\\{\\s*return '${hex}';`).test(CORE),
       'the single definition is what makes the next change one line');
    ok(`  and as a function, not a top-level const`,
       !new RegExp(`(?:const|let|var)\\s+${name}\\s*=`).test(CORE),
       'a top-level const in the shared core is a redeclaration waiting '
       + 'to happen, and it takes the whole portal down rather than one '
       + 'screen');
  }
  ok('and so is the wash behind a highlighted box',
     /function SV_WASH\(\)\s*\{\s*return 'rgba\(0,0,0,0\.035\)';/.test(CORE)
     && !/(?:const|let|var)\s+SV_WASH\s*=/.test(CORE));

  /* THE SECOND FAILURE MODE. Four literals retyped thirty-five times is
     the same problem the purple had, in a different colour. */
  const literal = /#078e07|#ff9b0c|#656565|#303030/i;
  const retyped = groupLines.filter(l => literal.test(l.text)
    && !/const SV_(GREEN|GOLD|INK|GREY)/.test(l.text));
  ok('NO GROUP FUNCTION WRITES A PALETTE HEX BY HAND',
     retyped.length === 0,
     'use the constant — the purple was changeable only after reading '
     + 'thirty-five sites, and this is how that happens again: '
     + retyped.map(o => `${o.fn}:${o.n}`).join(', '));
}

/* ══ 3. The personal portal keeps the brand ════════════════════════ */
console.log('\nand the rest of the portal keeps the brand purple');
{
  const elsewhere = LINES.filter(l => !GROUP_FNS.includes(l.fn) && /eda5ff/i.test(l.text));
  /* A FLOOR NEAR THE REAL NUMBER, not a token one. There are ~26 uses
     outside the group screens; a floor of 10 would have let sixteen of
     them disappear unnoticed, which is most of the brand.

     It is deliberately a floor and not an exact count: this check is
     about the GROUP palette, and pinning every purple in a 17 000-line
     file would fail here for unrelated work on screens it says nothing
     about. What it catches is the wholesale case — somebody reading
     "no purple" and applying it to the file rather than to these
     sixteen functions. */
  ok('PURPLE IS STILL THERE OUTSIDE THE GROUP SCREENS',
     elsewhere.length >= 20,
     'a ban applied to the whole file would strip the brand from screens '
     + 'nobody reviewed — only ' + elsewhere.length + ' uses left');
  ok('and it is still the one canonical purple',
     !/#(?:a|b|c|d|e|f)[0-9a-f]{2}(?:7|8|9|a|b)[0-9a-f]ff\b/i.test(
       CORE.replace(/eda5ff/gi, '')),
     'CLAUDE.md permits exactly one purple value platform-wide');
}

/* ══ 4. What each colour is for, on the real markup ════════════════ */
console.log('\nand each colour is used for what it means');
{
  /* Rendered, not grepped: the constants could be defined correctly and
     then used in the wrong places. */
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    document: { getElementById: () => null, querySelector: () => null,
                querySelectorAll: () => [], addEventListener() {},
                createElement: () => ({ style: {} }),
                body: { appendChild() {} }, head: { appendChild() {} } },
    location: { search: '', pathname: '/portal/', origin: 'https://x', href: '' },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    navigator: { userAgent: '' }, fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    encodeURIComponent, addEventListener() {},
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('js/api.js'), ctx);
  vm.runInContext(read('js/portal-core.js'), ctx);
  ctx._esc = v => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* The field names the card actually reads — stokvel_name, not name;
     active_members, not members; and mandate_line, without which the
     rules box does not render at all and the assertion below would be
     testing markup the fixture never produced. */
  /* A NAMED FAILURE, NOT A STACK TRACE. Turn the palette back into a
     const and SV_GREEN() stops being callable, so this section threw and
     took the whole run with it — including the twelve assertions above,
     whose results are the useful part. The throw is caught and reported
     as what it is. */
  ctx.__inv = { id: 'INV-1', stokvel_name: 'Club 2', active_members: 2,
                invited_by_name: 'Staging', as_signatory: false,
                mandate_line: '2 signatories must approve before any money leaves; '
                            + 'the pot divides by what each member has paid in.' };
  let card = '', threw = null;
  try { card = vm.runInContext('_svInviteCard(__inv)', ctx); }
  catch (e) { threw = e.message; }

  ok('THE INVITATION CARD IS DRAWN AT ALL', threw === null,
     'the group screens do not render: ' + threw);
  ok('and it carries no purple',
     card.length > 200 && !PURPLE.test(card), card.slice(0, 200));
  ok("and its header is the group's green",
     /background:#078e07/.test(card),
     'the group banner is the one place the green is the subject rather '
     + 'than a signal: ' + card.slice(0, 240));
  ok('and the card itself is bordered neutrally',
     /border:1px solid var\(--border\)/.test(card),
     'a green box round everything makes the green that means something '
     + 'worthless');
  ok("AND THE GROUP'S RULES ARE MARKED IN GREEN, NOT BOXED IN IT",
     /border-left:3px solid #078e07/.test(card) && !/border:2px solid #078e07/.test(card),
     card.slice(0, 300));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
