/* Every front-end surface calls into the shared Utils object in js/api.js, and
   nothing checks that the methods it calls exist. Two live bugs came from that
   in one day:

     mobile portal.js called Utils.ficaBadge, absent from the mobile fork of
     api.js, so the FICA/KYC panel threw instead of rendering.

     admin.js called Utils.fmtCcy, which has never existed anywhere, inside two
     .map() callbacks — so those investment lists threw and rendered nothing.

   Both are the same shape: a name that resolves to undefined, called as a
   function, usually inside a template literal where the throw takes the whole
   render with it. Neither shows up until someone opens that screen.

   This resolves every Utils.<name> reference across the surfaces against the
   real object and fails on any that do not exist. Guarded uses are allowed —
   `Utils.esc ? Utils.esc(x) : x` is a deliberate optional call. */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* ── The consumers, FOUND rather than listed ───────────────────────────
   This was a hand-written list of six files. js/portal-core.js — thirteen
   thousand lines, the shared core of the web portal and the app — was split
   out after that list was written and never added to it, so 53 unguarded
   Utils.toast calls sat in the one file the check did not open. Utils has no
   toast member and never has. Every one of them threw.

   The symptom was reported as "I click Send the invitation, it sends, and
   nothing happens": the throw landed between the toast and the re-render, so
   the request succeeded and the screen never moved.

   A list of files to check is a list that falls behind the code. This finds
   every front-end script that mentions Utils, so a file split out tomorrow is
   covered the day it appears.

   dist/ is excluded: pages:build copies these same files into it, so
   including it reports every finding twice and names a path nobody edits.
   mobile/www IS included — it is a build output too, but of a different
   source tree, and a stale copy there is its own bug. */
const SEARCH_DIRS = ['js', 'portal', 'admin', 'team', 'fund', 'ifa', 'mobile/src', 'mobile/www'];

function findConsumers() {
  const out = [];
  const walk = dir => {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(rel);
      } else if (entry.name.endsWith('.js')) {
        /* api.js defines Utils; checking it against itself proves nothing and
           its own internal references are not calls from a consumer. */
        if (rel === path.join('js', 'api.js')) continue;
        if (/Utils\./.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) out.push(rel);
      }
    }
  };
  SEARCH_DIRS.forEach(walk);
  return out.sort();
}

const CONSUMERS = findConsumers();

/* Load the real shared api.js and pull Utils out of it. */
function loadUtils() {
  const win = {
    location: { pathname: '/', href: '/' },
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  };
  win.window = win;
  win.document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, append() {}, appendChild() {} }),
    body: { appendChild() {} },
    addEventListener() {}, querySelector: () => null,
  };
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8'), ctx, { filename: 'api.js' });
  return vm.runInContext('Utils', ctx);
}

const Utils = loadUtils();
const known = new Set(Object.keys(Utils));

let checked = 0, problems = [];

for (const rel of CONSUMERS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  /* Comments are blanked before scanning, because prose about this very bug
     reads as the bug. The comment above _svToast explains that the portal
     never had a Utils.toast — and named it three times, which this reported
     as three unresolved calls.

     Blanked, not stripped: every character of a comment becomes a space and
     the newlines stay, so the line numbers in a finding still point at the
     line in the file. Only a // at the start of a line is treated as a
     comment, so an https:// inside a string is left alone. */
  const raw = fs.readFileSync(file, 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/^(\s*)\/\/.*$/gm, (m, pre) => pre + ' '.repeat(m.length - pre.length));
  const lines = code.split('\n');
  /* Reported from the original, so a finding shows the real line. */
  const rawLines = raw.split('\n');

  lines.forEach((line, i) => {
    for (const m of line.matchAll(/Utils\.([A-Za-z_$][\w$]*)/g)) {
      const name = m[1];
      checked++;
      if (known.has(name)) continue;

      // A guarded reference is intentional: the caller has already accounted
      // for the method being absent.
      const guarded =
        new RegExp(`Utils\\.${name}\\s*\\?`).test(line) ||
        new RegExp(`typeof\\s+Utils\\.${name}`).test(line) ||
        new RegExp(`Utils\\.${name}\\s*&&`).test(line) ||
        new RegExp(`Utils\\.${name}\\s*\\|\\|`).test(line);
      if (guarded) continue;

      problems.push({ rel, line: i + 1, name, src: (rawLines[i] || '').trim().slice(0, 110) });
    }
  });
}

console.log(`  resolved ${checked} Utils.* references across ${CONSUMERS.length} files against js/api.js`);
console.log(`  Utils exposes ${known.size} members\n`);

if (!problems.length) console.log('  PASS  every unguarded Utils call resolves');
for (const p of problems) {
  console.log(`  FAIL  ${p.rel}:${p.line}  Utils.${p.name} is not defined`);
  console.log(`          ${p.src}`);
}
if (problems.length) {
  console.log(`\n  ${problems.length} unresolved call(s) — each throws when that screen renders`);
}

/* The tally the runner reads. This check's unit is the reference it
   resolved, so the count IS what it looked at: if the consumer list ever
   silently empties, `checked` goes to zero and the runner refuses it rather
   than printing a tick for a check that examined nothing. */
console.log(`\n${checked} passed, ${problems.length} failed`);
process.exit(problems.length ? 1 : 0);
