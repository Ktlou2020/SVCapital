#!/usr/bin/env node
/* The amount on a My Investments card must stay inside its tile.
 *
 * The stats row was pinned to three equal columns. #myInvestmentsGrid lets a
 * card be as narrow as 300px, which makes each tile about 107px wide and its
 * content box about 81px. "R199,009.90" set in 12.6px Poppins 700 measures
 * 89.4px — and a rand figure offers no break opportunity anywhere inside it,
 * so it did not wrap. It ran straight out past the tile edge and was clipped:
 * the client saw "R199,009." and had to guess the rest. Measured in Chromium
 * at the real stylesheet, real font: 8.0px over at a 380px card, 21.4px over
 * at 340px, 34.7px over at 300px.
 *
 * Two things fix it, and both have to hold:
 *
 *   the layout gives the figure a track wide enough  (auto-fit, not repeat(3))
 *   and nothing can escape the tile even so           (overflow-wrap on the value)
 *
 * The second is the floor under the first. A figure in the millions still has
 * no break opportunity of its own, so without `anywhere` a wide enough tile is
 * only a wide enough tile until somebody invests more.
 *
 * Run: node scripts/check-investment-card-amounts.cjs
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

/* Every stylesheet the portal or the app shell loads. A rule in any of them
   can re-pin the grid — that is exactly what mobile-app.css did. */
const SHEETS = [
  'portal/css/portal.css',
  'portal/css/portal-premium.css',
  'css/ci-theme.css',
  'css/admin.css',
  'mobile/src/css/mobile-overrides.css',
  'mobile/src/css/mobile-app.css',
  'mobile/www/css/portal.css',
  'mobile/www/css/portal-premium.css',
  'mobile/www/css/mobile-overrides.css',
  'mobile/www/css/mobile-app.css',
];

console.log('\nno stylesheet pins the stats row to a fixed column count');
for (const rel of SHEETS) {
  if (!fs.existsSync(path.join(ROOT, rel))) { ok(`${rel} exists`, false, 'file missing'); continue; }
  const css = read(rel);
  /* Each rule whose selector mentions the stats row, body and all. */
  const bad = [];
  const re = /([^{}]*my-inv-card__stats[^{}]*)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (/grid-template-columns\s*:\s*repeat\(\s*\d+\s*,/.test(m[2]) ||
        /grid-template-columns\s*:\s*(1fr\s+){1,}1fr/.test(m[2])) {
      bad.push(m[1].trim().replace(/\s+/g, ' ') + ' { ' + m[2].trim().replace(/\s+/g, ' ') + ' }');
    }
  }
  ok(`${rel} leaves the column count to the content`, bad.length === 0, bad.join('\n      '));
}

console.log('\nthe grid fits itself to the card');
{
  const css = read('portal/css/portal.css');
  const m = css.match(/my-inv-card__stats\s*\{[^}]*grid-template-columns\s*:\s*repeat\(\s*auto-(fit|fill)\s*,\s*minmax\(\s*(\d+)px\s*,\s*1fr\s*\)\s*\)/);
  ok('portal.css uses auto-fit with a minimum track', !!m,
     'the stats row must size itself, not assume three columns');

  if (m) {
    const floor = Number(m[2]);
    const gapM  = css.match(/my-inv-card__stats\s*\{[^}]*gap\s*:\s*(\d+)px/);
    const gap   = gapM ? Number(gapM[1]) : 0;
    ok('and a gap is declared with it', !!gapM);

    /* The narrowest card the investments grid will produce, from its own
       rule: repeat(auto-fill, minmax(min(300px, 100%), 1fr)). */
    const prem = read('portal/css/portal-premium.css');
    ok('#myInvestmentsGrid still floors a card at 300px',
       /#myInvestmentsGrid\s*\{[^}]*minmax\(\s*min\(\s*300px/.test(prem),
       'if this moved, the arithmetic below is measuring the wrong card');

    const cardPad = 18;                       // .my-inv-card padding, each side
    const inner   = 300 - 2 * cardPad;
    const cols    = Math.max(1, Math.floor((inner + gap) / (floor + gap)));
    ok(`a 300px card resolves to ${cols} column(s), not 3`, cols <= 2,
       `floor ${floor}px + gap ${gap}px across ${inner}px gives ${cols}`);

    const tileInner = Math.floor((inner - gap * (cols - 1)) / cols) - 24 - 2;  // padding + border
    /* Measured in Chromium against this stylesheet and Poppins 700 at 12.6px:
       "R199,009.90" is 89.4px wide, "R1,299,009.90" is 102.9px. The first is
       the figure from the report and must fit outright. */
    ok(`and its tile holds R199,009.90 (${tileInner}px of room, 89.4px of text)`,
       tileInner >= 90, `only ${tileInner}px`);
  }
}

console.log('\nand nothing can escape a tile even so');
{
  const css = read('portal/css/portal.css');
  const val = css.match(/my-inv-card \.mic-stat__value\s*\{([^}]*)\}/);
  ok('the value rule is still there', !!val);
  if (val) {
    ok('an unbreakable figure wraps rather than overflowing',
       /overflow-wrap\s*:\s*anywhere/.test(val[1]),
       'without this a seven-figure amount overflows however wide the tile is');
    ok('and the value may shrink below its content width',
       /min-width\s*:\s*0/.test(val[1]));
  }
  const tile = css.match(/my-inv-card \.mic-stat\s*\{([^}]*)\}/);
  ok('the tile itself may shrink below its content width',
     !!tile && /min-width\s*:\s*0/.test(tile[1]),
     'a grid item defaults to min-width:auto and refuses to shrink');
}

console.log('\nthe app shell ships the same stylesheet');
{
  const a = read('portal/css/portal.css');
  const b = read('mobile/www/css/portal.css');
  const grab = css => (css.match(/my-inv-card__stats\s*\{[^}]*\}/) || [''])[0].replace(/\s+/g, ' ');
  ok('the built copy carries the same stats rule', grab(a) === grab(b),
     `portal: ${grab(a)}\n      www:    ${grab(b)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
