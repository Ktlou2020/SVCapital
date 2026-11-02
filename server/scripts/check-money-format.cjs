#!/usr/bin/env node
/* Money is written the way the people reading it write it.
 *
 * The portal formatted in en-US — R170,000.00 — while every statement, tax
 * certificate and generated document used en-ZA: R 170 000,00. The same
 * balance in two notations, depending on whether the client was looking at
 * the screen or at the PDF of the screen.
 *
 * That is not a matter of taste. IN SOUTH AFRICA THE COMMA IS THE DECIMAL
 * SEPARATOR, so "R170,000.00" is genuinely ambiguous to the person it is
 * for — read locally it says a hundred and seventy rand. On a platform
 * whose whole job is telling somebody how much money they have, that is the
 * one thing that must never be ambiguous.
 *
 * One definition, 516 call sites. This check exists so the 517th cannot
 * quietly be written in American.
 *
 * Run: node server/scripts/check-money-format.cjs
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
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* Utils is a plain object literal in js/api.js, pulled out and evaluated so
   the FORMAT is checked rather than the source that produces it. */
function loadUtils() {
  const src = read('js/api.js');
  const i = src.indexOf('const Utils = {');
  const end = src.indexOf('\n};', i);
  // eslint-disable-next-line no-eval
  const U = eval('(' + src.slice(i + 'const Utils = '.length, end + 2) + ')');
  global.Utils = U;
  return U;
}

const NBSP = String.fromCharCode(0xa0);

console.log('the one formatter writes South African rand');
{
  const U = loadUtils();
  ok('thousands are grouped with a non-breaking space',
     U.rand(170000) === `R 170${NBSP}000,00`,
     JSON.stringify(U.rand(170000)) + ' — a plain space lets a printed '
     + 'statement break an amount across two lines');
  ok('and the decimal separator is a comma',
     /,\d\d$/.test(U.rand(1234.5)), JSON.stringify(U.rand(1234.5)));
  ok('there is no dot anywhere in it',
     !U.rand(1234567.89).includes('.'),
     JSON.stringify(U.rand(1234567.89)) + ' — a dot after the thousands is '
     + 'the American reading, and locally it says one point two');
  ok('nothing is R0.00 any more, not even nothing',
     U.rand(null) === 'R 0,00' && U.rand(undefined) === 'R 0,00' && U.rand(NaN) === 'R 0,00',
     [U.rand(null), U.rand(undefined), U.rand(NaN)].join(' | '));
  ok('and the abbreviated form agrees with it',
     U.randShort(61100000) === 'R61,1M' && U.randShort(1200) === 'R1,2K',
     `${U.randShort(61100000)} | ${U.randShort(1200)} — a tile reading R61.1M `
     + 'beside R 61 100 000,00 is the same inconsistency in miniature');
}

console.log('\nand the screen agrees with the document');
{
  const U = loadUtils();
  /* The documents build their own, because they render outside the portal's
     script. What matters is that the two produce the same string. */
  const docs = read('js/investor-documents.js');
  const m = docs.match(/const fmt = n => 'R ' \+ [\s\S]{0,140}?toLocaleString\('en-ZA'[\s\S]{0,90}?\);/);
  ok('the documents still format in en-ZA', !!m, 'no en-ZA formatter found');
  if (m) {
    // eslint-disable-next-line no-eval
    const fmt = eval('(' + m[0].replace(/^const fmt = /, '').replace(/;$/, '') + ')');
    for (const v of [170000, 1704, 0.5, 61100000]) {
      ok(`${v} reads the same on both`, fmt(v) === U.rand(v),
         `document ${JSON.stringify(fmt(v))} vs screen ${JSON.stringify(U.rand(v))}`);
    }
  }
}

console.log('\nand nothing anywhere formats money in American');
{
  const dirs = ['js', 'admin/js', 'portal/js', 'team/js', 'fund/js', 'ifa/js',
                'server/services', 'server/routes', 'server/jobs'];
  const offenders = [];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter(f => f.endsWith('.js'))) {
      const rel = `${d}/${f}`;
      const src = read(rel);
      /* Scanned ACROSS LINES, not line by line. The biggest number on the
         platform — the animated hero counter — wraps its options onto the
         next line, so a per-line scan looked straight past it and reported
         the file clean while it formatted in American. */
      const re = /toLocaleString\(\s*'en-US'[\s\S]{0,160}?\)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        /* An en-US call with a RAND SIGN near it, or fraction digits in its
           options. A plain count — "1 234 rows" — is not money. */
        const around = src.slice(Math.max(0, m.index - 60), m.index + m[0].length);
        if (!/R['"\s+]|minimumFractionDigits/.test(around)) continue;
        offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  ok('no money is formatted with en-US',
     offenders.length === 0,
     offenders.join('\n      ') + '\n      use Utils.rand — one definition, '
     + 'so the 517th call site cannot be written in American');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
