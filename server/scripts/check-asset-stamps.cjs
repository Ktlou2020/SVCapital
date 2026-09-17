#!/usr/bin/env node
/* A version-stamped asset that changed without its number changing.
 *
 * server/index.js serves anything whose URL carries a ?v= with
 * Cache-Control: immutable, max-age=31536000 — a year. That is sound only
 * while the number moves every time the file does, which CLAUDE.md requires
 * and nothing enforced.
 *
 * css/home-ci.css sat at ?v=3 through three separate changes to it. The
 * Products submenu was added, its breakpoint corrected, and then rewritten as
 * a disclosure — and a browser that had loaded the landing page before any of
 * that was pinned to the original file until 2027. The bug report was "the
 * heading is still not fixed", which it was, three times.
 *
 * A stale stamp does not look like a bug in the diff. It looks like nothing:
 * the change is right there in the file, the check suite passes, the deploy
 * succeeds, and the only symptom is a returning visitor seeing last month's
 * page. So the stamp is recorded here against the hash of what it stood for,
 * and moving one without the other fails.
 *
 * When this fails, the fix is almost always to bump the number in the HTML
 * that points at the file — not to update this manifest by hand. The manifest
 * is refreshed with:
 *
 *   node server/scripts/check-asset-stamps.cjs --update
 *
 * which is correct only when the stamps already moved.
 *
 * Run: node server/scripts/check-asset-stamps.cjs
 */
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT     = path.join(__dirname, '..', '..');
const MANIFEST = path.join(__dirname, 'asset-stamps.json');
const UPDATE   = process.argv.includes('--update');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* Build outputs follow their sources; a stamp there is copied, not authored.
   node_modules and dist are not ours to stamp at all.

   mobile/ is left out for a different reason: its pages are a Capacitor
   bundle served with mobile/www as the root, so /css/portal.css and
   ../js/api.js there resolve inside the bundle and not where they sit in this
   repository — resolving them from here reports links that work as broken.
   Its cache is the service worker's svc-portal-vN, which CLAUDE.md already
   requires to be bumped and check-mobile-build-reproducible already holds. */
const SKIP_DIR = /(^|\/)(node_modules|dist|\.git|android|ios|mobile)(\/|$)/;

function htmlFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT, abs);
    if (SKIP_DIR.test(rel)) continue;
    if (entry.isDirectory()) htmlFiles(abs, out);
    else if (entry.name.endsWith('.html')) out.push(rel);
  }
  return out;
}

/* Every ?v= reference, resolved to the file it actually points at. A
   reference that resolves to nothing is not a stamping problem — it is a
   broken link, and it is reported as one. */
function references() {
  const found = new Map();   // "path?v=N" -> Set of pages referencing it
  const broken = [];
  for (const page of htmlFiles(ROOT)) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const m of html.matchAll(/(?:href|src)="([^"?]+\.(?:css|js))\?v=(\d+)"/g)) {
      const [, href, v] = m;
      const target = href.startsWith('/')
        ? path.join(ROOT, href.slice(1))
        : path.resolve(path.dirname(path.join(ROOT, page)), href);
      const rel = path.relative(ROOT, target);
      if (SKIP_DIR.test(rel)) continue;
      if (!fs.existsSync(target)) { broken.push(`${page} → ${href}?v=${v}`); continue; }
      const key = `${rel.split(path.sep).join('/')}?v=${v}`;
      if (!found.has(key)) found.set(key, new Set());
      found.get(key).add(page);
    }
  }
  return { found, broken };
}

const sha = p => crypto.createHash('sha256')
  .update(fs.readFileSync(p).toString('utf8').replace(/\r\n/g, '\n'))
  .digest('hex').slice(0, 16);

const { found, broken } = references();

if (UPDATE) {
  const next = {};
  for (const key of [...found.keys()].sort()) next[key] = sha(path.join(ROOT, key.split('?')[0]));
  fs.writeFileSync(MANIFEST, JSON.stringify(next, null, 2) + '\n');
  console.log(`recorded ${Object.keys(next).length} stamped assets in ${path.relative(ROOT, MANIFEST)}`);
  process.exit(0);
}

const recorded = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};

console.log('\nevery ?v= points at a file that exists');
ok('no reference dangles', broken.length === 0, broken.join('\n      '));

console.log('\nand nothing changed behind a stamp that stayed put');
{
  const stale = [];
  for (const [key, pages] of found) {
    const want = recorded[key];
    if (!want) continue;                 // new stamp — nothing to contradict
    const got = sha(path.join(ROOT, key.split('?')[0]));
    if (got !== want) stale.push(`${key} changed but the number did not — bump it in ${[...pages].join(', ')}`);
  }
  ok('no stamped asset changed without its number changing', stale.length === 0,
     stale.join('\n      ') + (stale.length
       ? '\n      (a browser that loaded the old one is pinned to it for a year)' : ''));
}

console.log('\nthe manifest is a record of what shipped, not a wish');
{
  const missing = [...found.keys()].filter(k => !(k in recorded));
  ok('every stamped asset is recorded', missing.length === 0,
     `not in the manifest — run with --update once the stamps are right:\n      ${missing.join('\n      ')}`);
  const gone = Object.keys(recorded).filter(k => !found.has(k));
  ok('and nothing recorded has been left behind', gone.length === 0,
     `no page references these any more:\n      ${gone.join('\n      ')}`);
}

/* The thing that makes a stale stamp expensive rather than merely untidy. */
console.log('\nbecause a stamped URL really is cached for a year');
{
  const server = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  ok('server/index.js still serves ?v= as immutable',
     /IMMUTABLE_MAX_AGE = 31536000/.test(server) && /immutable/.test(server),
     'if this stops being true the manifest is no longer worth keeping');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
