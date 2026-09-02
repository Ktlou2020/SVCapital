#!/usr/bin/env node
/* Every shipped JavaScript file parses.
 *
 * This is the cheapest check in the suite and it earned its place immediately:
 * a find-and-replace that restored a commented-out line left the tail of the
 * comment behind as bare code —
 *
 *   { label: 'Account Statement', ... }, on mobile
 *
 * — and mobile/src/js/portal.js stopped parsing. The whole file. Every
 * function in the mobile app's portal bundle, gone, because a browser that
 * cannot parse a script runs none of it.
 *
 * It reached main. Eighty-eight checks passed on the way: the ones that read
 * that file read it as TEXT and matched patterns in it, which a broken file
 * satisfies perfectly well. Nothing had ever asked whether it was valid
 * JavaScript. The web portal was fine — its copy of the file is separate — and
 * the installed app carries the bundle it was built with, so no client saw it;
 * the next app build would have shipped a portal that does nothing at all.
 *
 * Parsing is not linting and this is not a style check. It answers one
 * question: would a browser load this file.
 *
 * Run: node scripts/check-js-parses.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/* Everything a browser or the server is actually served. dist/ is a stale
   committed build artifact and node_modules is not ours. */
const DIRS = [
  'js', 'admin/js', 'portal/js', 'team/js', 'fund/js', 'ifa/js',
  'mobile/src/js', 'mobile/www/js', 'mobile/scripts',
  'server', 'scripts',
];
const SKIP = /(^|\/)(node_modules|dist|\.git)(\/|$)/;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (SKIP.test(rel)) continue;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const files = [...new Set(DIRS.flatMap(d => walk(d)))].sort();

console.log(`\nparsing ${files.length} javascript files`);

const broken = [];
for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  try {
    /* Compile only — nothing is executed, so a file with side effects at load
       is as safe to check as one without.

       Classified by EXTENSION, not by content. Sniffing for a line beginning
       "import" or "export" matched a line inside a template string in
       admin.js and sent a 17,000-line classic script down the ES-module path,
       which then failed for a reason that had nothing to do with the file. */
    if (/\.mjs$/.test(rel)) {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)],
                   { stdio: ['ignore', 'ignore', 'pipe'] });
    } else {
      new vm.Script(src, { filename: rel });
    }
  } catch (err) {
    broken.push(`${rel}: ${err.message.split('\n')[0]}`);
  }
}

ok('every shipped file is valid javascript',
   broken.length === 0,
   broken.join('\n      '));

/* The two copies of the portal bundle are separate files that drift, and this
   is the one class of drift that takes the whole surface down rather than one
   feature. Named explicitly so the failure says which surface is dead. */
console.log('\nboth copies of the portal bundle');
for (const rel of ['portal/js/portal.js', 'mobile/src/js/portal.js', 'mobile/www/js/portal.js',
                   'js/portal-core.js', 'js/investor-documents.js', 'admin/js/admin.js']) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { ok(`${rel} exists`, false, 'file missing'); continue; }
  let err = null;
  try { new vm.Script(fs.readFileSync(p, 'utf8'), { filename: rel }); }
  catch (e) { err = e.message.split('\n')[0]; }
  ok(`${rel} parses`, !err, err);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
