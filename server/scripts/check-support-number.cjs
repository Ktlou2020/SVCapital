#!/usr/bin/env node
/* The support WhatsApp number, in every place it is written down.
 *
 * It is written down five times — the landing page footer, the floating
 * button on the landing page, two places in the app shell, and the portal's
 * support panel — and nothing tied them together. Changing the number meant
 * finding all five; missing one sends a client to a number nobody answers,
 * and the page that still has it is the one nobody looks at.
 *
 * So: one number, and every link uses it.
 *
 * To change it, edit NUMBER here and run:
 *   node server/scripts/check-support-number.cjs --update
 * which rewrites every link in the repository and rebuilds the app shell.
 *
 * Run: node server/scripts/check-support-number.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

/* International format, digits only — what api.whatsapp.com expects. South
   African mobile: 27 followed by nine digits, the leading 0 dropped.
   27 79 111 5476 is 079 111 5476. */
const NUMBER = '27791115476';

const ROOT   = path.join(__dirname, '..', '..');
const UPDATE = process.argv.includes('--update');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* dist/ is a stale export nothing serves; node_modules is not ours. */
const SKIP = /(^|\/)(node_modules|dist|\.git|android|ios)(\/|$)/;

function pages(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT, abs);
    if (SKIP.test(rel)) continue;
    if (entry.isDirectory()) pages(abs, out);
    else if (/\.(html|js)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const LINK = /(?:api\.whatsapp\.com\/send\?phone=|wa\.me\/)(\d+)/g;

const found = [];
for (const rel of pages(ROOT)) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const m of text.matchAll(LINK)) found.push({ rel, digits: m[1] });
}

if (UPDATE) {
  const wrong = [...new Set(found.filter(f => f.digits !== NUMBER).map(f => f.rel))];
  for (const rel of wrong) {
    const p = path.join(ROOT, rel);
    const before = fs.readFileSync(p, 'utf8');
    fs.writeFileSync(p, before.replace(LINK, (whole, d) => whole.replace(d, NUMBER)));
    console.log(`  updated ${rel}`);
  }
  if (!wrong.length) console.log('  every link already uses ' + NUMBER);
  console.log('\nRun `node mobile/scripts/build.js` and bump mobile/src/sw.js if the app shell changed.');
  process.exit(0);
}

console.log('\nthere is one support number, and every link uses it');
{
  ok('the links exist at all', found.length > 0,
     'nothing matched — the markup changed shape and this check now proves nothing');
  /* Named so a failure says which pages disagree, not just that they do. */
  const wrong = found.filter(f => f.digits !== NUMBER);
  ok(`all ${found.length} WhatsApp links use ${NUMBER}`, wrong.length === 0,
     wrong.map(w => `${w.rel} → ${w.digits}`).join('\n      '));

  /* The app shell is built from mobile/src; a number changed in one and not
     rebuilt into the other ships the old one to every phone. */
  const src = found.filter(f => f.rel.startsWith('mobile/src/'));
  const www = found.filter(f => f.rel.startsWith('mobile/www/'));
  ok('and the built app shell matches its source',
     src.length === www.length && src.every((s, i) => s.digits === www[i].digits),
     `src ${JSON.stringify(src.map(s => s.digits))} vs www ${JSON.stringify(www.map(w => w.digits))}`);
}

console.log('\nand it is a number WhatsApp can dial');
{
  ok('digits only, no + and no spaces', /^\d+$/.test(NUMBER), NUMBER);
  ok('South African country code', NUMBER.startsWith('27'), NUMBER);
  ok('and eleven digits in all', NUMBER.length === 11, `${NUMBER.length} digits`);
  ok('with no leading zero after the country code', NUMBER[2] !== '0',
     'api.whatsapp.com reads 2707… as a different number and reaches nobody');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
