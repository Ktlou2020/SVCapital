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

const CONSUMERS = [
  'portal/js/portal.js',
  'admin/js/admin.js',
  'mobile/www/js/portal.js',
  'js/main.js',
  'js/staff-auth.js',
  'js/sv-intelligence.js',
];

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
  const lines = fs.readFileSync(file, 'utf8').split('\n');

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

      problems.push({ rel, line: i + 1, name, src: line.trim().slice(0, 110) });
    }
  });
}

console.log(`  resolved ${checked} Utils.* references across ${CONSUMERS.length} files against js/api.js`);
console.log(`  Utils exposes ${known.size} members\n`);

if (!problems.length) {
  console.log('  PASS  every unguarded Utils call resolves');
  process.exit(0);
}

for (const p of problems) {
  console.log(`  FAIL  ${p.rel}:${p.line}  Utils.${p.name} is not defined`);
  console.log(`          ${p.src}`);
}
console.log(`\n  ${problems.length} unresolved call(s) — each throws when that screen renders`);
process.exit(1);
