#!/usr/bin/env node
/* The service worker's cache version, against what it precaches.
 *
 * CLAUDE.md: "Bump mobile/src/sw.js CACHE version (svc-portal-vN) with every
 * JS/CSS change to mobile, then rebuild." The consequence of forgetting is
 * spelled out there too — the installed app goes on serving the stale cache
 * the bump exists to clear.
 *
 * THIS IS NOT HYPOTHETICAL. css/admin.css is in the precache list. It was
 * changed in "Insights articles can be formatted" and the CACHE version was
 * last bumped in the commit BEFORE it, so the app would have kept serving
 * the previous copy. Nothing noticed: check-mobile-build-reproducible
 * catches a file edited in www/ instead of src/, which is a different
 * mistake, and the asset-stamp manifest covers `?v=` URLs, which the
 * precache list does not use.
 *
 * So the precached set gets the same treatment the stamped assets already
 * have: a manifest of what each CACHE version shipped. Change a precached
 * file without moving the version and the hash no longer matches what is
 * recorded, and this fails naming the file.
 *
 *   node server/scripts/check-sw-cache-version.cjs --update   (after bumping)
 *
 * The manifest holds ONE entry — the current version and the hash of
 * everything it precaches. A history of old versions would be a record of
 * caches nobody can reach any more.
 *
 * Run: node server/scripts/check-sw-cache-version.cjs
 */
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT     = path.join(__dirname, '..', '..');
const SW       = path.join(ROOT, 'mobile', 'src', 'sw.js');
const MANIFEST = path.join(__dirname, 'sw-precache-stamp.json');
const UPDATE   = process.argv.includes('--update');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const src = fs.readFileSync(SW, 'utf8');

/* The version and the list, read out of the real file. */
const version = (src.match(/svc-portal-v(\d+)/) || [])[1];
const listRaw = (src.match(/const PRECACHE = \[([\s\S]*?)\];/) || [])[1] || '';
const entries = [...listRaw.matchAll(/'([^']+)'/g)].map(m => m[1]);

/* A precache path is relative to mobile/src/, which is where sw.js lives in
   the source tree; './' is that folder and '../' is the repo root. './' on
   its own is the app shell, which is index.html. */
function resolveEntry(e) {
  const rel = e === './' ? './index.html' : e;
  return path.join(ROOT, 'mobile', 'src', rel);
}

/* The one file the app is served from that the list does NOT name: sw.js
   itself is fetched by the browser, not precached, so it is excluded. */
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);

console.log('\nthe service worker precaches a readable list');
{
  ok('the CACHE version was found', !!version, src.slice(0, 120));
  ok('and the precache list was found', entries.length > 3, JSON.stringify(entries));
}

/* Every path has to exist, or the install step silently caches less than it
   says. addAll rejects as a whole and sw.js swallows it with .catch(() => {}),
   so a typo here is invisible at runtime. */
console.log('\nand every path in it is a file that exists');
const resolved = [];
for (const e of entries) {
  /* mobile/src is an overlay: a path it does not hold is served from the
     shared layer the build copies in. Both roots are tried, which is what
     the build itself does. */
  const candidates = [resolveEntry(e), path.join(ROOT, (e === './' ? './index.html' : e).replace(/^\.\.\//, '').replace(/^\.\//, 'portal/'))];
  const found = candidates.find(c => fs.existsSync(c));
  ok(`${e} resolves`, !!found,
     'addAll rejects as a whole and sw.js swallows the error, so a path that '
     + 'does not exist means NOTHING is precached and nobody is told');
  if (found) resolved.push([e, found]);
}

/* The stamp. */
const current = {};
for (const [e, file] of resolved) current[e] = sha(file);
const stamp = { version, files: current };

if (UPDATE) {
  fs.writeFileSync(MANIFEST, JSON.stringify(stamp, null, 2) + '\n');
  console.log(`\nrecorded svc-portal-v${version} with ${resolved.length} precached file(s) in ${path.relative(ROOT, MANIFEST)}`);
  process.exit(0);
}

console.log('\nand nothing it precaches changed without the version changing');
{
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (_) {}
  ok('the manifest exists', !!prev,
     'run with --update once the version is right');

  if (prev) {
    if (prev.version !== version) {
      /* A bump is the whole point — a new version may ship anything. */
      ok(`the version moved (v${prev.version} → v${version}), so the contents may differ`,
         true);
      ok('and the manifest is being kept up to date',
         false,
         `svc-portal-v${version} is not recorded — run with --update, which is `
         + 'the step that makes this check mean something next time');
    } else {
      const changed = Object.keys(current).filter(k => prev.files[k] !== current[k]);
      const added   = Object.keys(current).filter(k => !(k in prev.files));
      const removed = Object.keys(prev.files).filter(k => !(k in current));
      ok('NO PRECACHED FILE CHANGED UNDER THE SAME CACHE VERSION',
         changed.length === 0,
         changed.join(', ') + ` — bump svc-portal-v${version} in mobile/src/sw.js, `
         + 'rebuild, and run this with --update. Without the bump an installed '
         + 'app keeps serving the old copy.');
      ok('nothing was added to the list without a bump', added.length === 0, added.join(', '));
      ok('and nothing was dropped from it without one', removed.length === 0, removed.join(', '));
    }
  }
}

/* And the build output has to carry the same version, or the bump is in a
   file nobody ships. */
console.log('\nand the built bundle carries the same version');
{
  const built = path.join(ROOT, 'mobile', 'www', 'sw.js');
  ok('www/sw.js exists', fs.existsSync(built), 'run node mobile/scripts/build.js');
  if (fs.existsSync(built)) {
    const builtVer = (fs.readFileSync(built, 'utf8').match(/svc-portal-v(\d+)/) || [])[1];
    ok(`www carries v${version} too`, builtVer === version,
       `src says v${version}, www says v${builtVer} — the bump was made and not built, `
       + 'so the shipped bundle still has the old one');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
