#!/usr/bin/env node
/* Digital Asset Links: letting the app own its own links.
 *
 * Android decides whether this app may open a host's links — and whether a
 * saved password may be shared between the website and the app — by fetching
 * https://<host>/.well-known/assetlinks.json. Until today that file did not
 * exist anywhere, while the manifest had carried `autoVerify="true"` for
 * svcapital.co.za since the app shipped. So verification had been failing
 * from the start, silently: a tapped link opened the browser, and nothing
 * anywhere said why.
 *
 * THE FAILURE MODE IS ALWAYS SILENCE. There is no error surface. A wrong
 * fingerprint, a missing host, a redirect, an HTML 404 page served with a
 * 200 — each one simply means the link opens the browser, and the only way
 * to find out is to notice that it did.
 *
 * Three things have to agree, which is why they are checked together:
 *   · the FILE — valid JSON, the right package, a SHA-256 fingerprint
 *   · the MANIFEST — every host whose links the app claims
 *   · the PUBLISHING — the Pages build copies it, the server serves it
 *
 * Run: node scripts/check-assetlinks.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const has  = rel => fs.existsSync(path.join(ROOT, rel));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const FILE = '.well-known/assetlinks.json';

/* ── The file ────────────────────────────────────────────────────────── */
console.log('\nthe asset links file says what Android needs it to say');
let doc = null;
{
  ok('IT EXISTS AT ALL', has(FILE),
     'the manifest has claimed svcapital.co.za with autoVerify since the app '
     + 'shipped, and without this file that claim has always failed');
  if (has(FILE)) {
    let parsed = null, err = null;
    try { parsed = JSON.parse(read(FILE)); } catch (e) { err = e.message; }
    ok('and it is valid JSON', parsed !== null, err);
    doc = parsed;
  }
}

if (doc) {
  ok('it is a list of statements', Array.isArray(doc) && doc.length > 0, JSON.stringify(doc).slice(0, 120));

  const st = doc[0] || {};
  const target = st.target || {};
  ok('the namespace is android_app', target.namespace === 'android_app', String(target.namespace));

  /* The package decides which app the statement is about. strings.xml is the
     source android-config applies, so they must agree — a statement for a
     package we do not ship verifies nothing. */
  const strings = read('mobile/android-config/app/src/main/res/values/strings.xml');
  const want = (strings.match(/<string name="package_name">([^<]+)</) || [])[1];
  ok('the check found the package it should expect', !!want, 'strings.xml');
  ok('AND THE STATEMENT NAMES THAT PACKAGE',
     target.package_name === want,
     `${target.package_name} vs ${want} — a statement about another package is `
     + 'ignored, and the links keep opening the browser');

  const fps = target.sha256_cert_fingerprints;
  ok('it carries a fingerprint list', Array.isArray(fps) && fps.length > 0, JSON.stringify(fps));
  for (const fp of (fps || [])) {
    const bytes = String(fp).split(':');
    /* THE MISTAKE THIS CATCHES: pasting the upload key's SHA-1, which is the
       fingerprint written down in the release notes and is 20 bytes. The
       field is sha256 and Android compares it byte for byte. */
    ok(`the fingerprint is a SHA-256, not a SHA-1 (${bytes.length} bytes)`,
       bytes.length === 32,
       'a SHA-1 is 20 bytes; mobile/RELEASE-5.3.md quotes the upload key SHA-1 '
       + 'right next to this, and it is not what goes here');
    ok('and every byte is uppercase hex',
       bytes.every(b => /^[0-9A-F]{2}$/.test(b)), String(fp));
  }

  const rel = st.relation || [];
  ok('IT DELEGATES LINK HANDLING',
     rel.includes('delegate_permission/common.handle_all_urls'),
     'without this the app cannot open the host\'s links at all');
  ok('and credential sharing, which is what the Play Console toggle asked for',
     rel.includes('delegate_permission/common.get_login_creds'),
     'this is what lets a password saved on the website autofill in the app');
}

/* ── The manifest ────────────────────────────────────────────────────── */
console.log('\nand the manifest claims both the apex and the www host');
let hosts = [];
{
  const mf = read('mobile/android-config/app/src/main/AndroidManifest.xml');
  /* Comments stripped: the comment above this filter explains that both hosts
     are needed and therefore contains both host names, so an assertion
     reading the raw file passes on the explanation of what was deleted. */
  const code = mf.replace(/<!--[\s\S]*?-->/g, ' ');

  const at = code.indexOf('android:scheme="https"');
  const from = code.lastIndexOf('<intent-filter', at);
  const filter = at < 0 ? '' : code.slice(from, code.indexOf('</intent-filter>', at));
  ok('the https app-link filter was found', at > 0 && filter.length > 60,
     'a slice that missed it would assert nothing while passing');
  ok('and the slice is code, not its comment',
     !/Android verifies each host separately/.test(filter), filter.slice(0, 120));

  hosts = [...filter.matchAll(/android:host="([^"]+)"/g)].map(m => m[1]);
  ok('it still claims the apex', hosts.includes('svcapital.co.za'), hosts.join(', '));
  ok('AND THE WWW HOST, WHICH IS A SEPARATE SITE TO ANDROID',
     hosts.includes('www.svcapital.co.za'),
     'a filter naming only the apex leaves every www link opening the browser, '
     + 'however correct the file published at www is');
  ok('and verification is still asked for',
     /autoVerify="true"/.test(filter), filter.slice(0, 160));

  /* The marketing filter must stay unrestricted. Android combines every host
     with every path INSIDE one filter, so a pathPrefix added here would
     quietly narrow the apex and www to that prefix too. */
  ok('and the marketing filter is not narrowed by a path',
     !/pathPrefix/.test(filter),
     'a pathPrefix in this filter applies to the apex and www as well, and '
     + 'every link outside it goes back to opening the browser');

  /* ── The platform host, where the app's own links live ────────────── */
  const pAt = code.indexOf('android:host="platform.svcapital.co.za"');
  const pFrom = code.lastIndexOf('<intent-filter', pAt);
  const pFilter = pAt < 0 ? '' : code.slice(pFrom, code.indexOf('</intent-filter>', pAt));
  ok('THE PLATFORM HOST IS CLAIMED TOO',
     pAt > 0,
     'the invitation email and SMS, notification links and /get-app are all '
     + 'on platform.svcapital.co.za — unclaimed, an invited member tapping '
     + 'their invitation lands in a browser');
  ok('in a filter of its own, not merged into the marketing one',
     pFrom !== from,
     'one filter crosses every host with every path, so merging them would '
     + 'restrict the apex and www to the client prefixes');
  ok('and it asks for verification', /autoVerify="true"/.test(pFilter), pFilter.slice(0, 120));

  const prefixes = [...pFilter.matchAll(/android:pathPrefix="([^"]+)"/g)].map(m => m[1]);
  ok('IT IS RESTRICTED TO PATHS, not the whole host',
     prefixes.length > 0,
     'an unrestricted claim pulls the staff admin console into the app');
  for (const want of ['/portal', '/get-app', '/signup', '/reset-password'])
    ok(`a client is sent to ${want}, so it opens in the app`,
       prefixes.includes(want), prefixes.join(', '));
  /* The point of restricting it at all. */
  for (const staff of ['/admin', '/team'])
    ok(`AND ${staff} IS LEFT TO THE BROWSER`,
       !prefixes.some(p => p === staff || staff.startsWith(p)),
       `${prefixes.join(', ')} — a prefix matching ${staff} pulls staff tools `
       + 'into the app, which is not what the app is for');
}

/* ── The publishing ──────────────────────────────────────────────────── */
console.log('\nand every host it claims is one the file is actually published to');
{
  /* The marketing hosts are served by the Cloudflare Pages build, which does
     `rm -rf dist` and then copies an explicit list — so a file not named in
     that list is simply absent from the published site. */
  const pkg = JSON.parse(read('package.json'));
  const build = pkg.scripts['pages:build'] || '';
  ok('THE PAGES BUILD COPIES IT',
     /\bcp -r [^&]*\.well-known\b/.test(build),
     'the build removes dist and copies a named list; a file left off that '
     + 'list is published nowhere and nothing fails');
  ok('and the built output really carries it',
     has('dist/' + FILE), 'dist/' + FILE);
  if (has('dist/' + FILE))
    ok('byte for byte the same file', read('dist/' + FILE) === read(FILE), 'dist copy differs');

  /* And the Railway host, which is where every link the app itself writes
     lives — invitations, notifications, /get-app. */
  const srv = read('server/index.js').replace(/\/\*[\s\S]*?\*\//g, ' ');
  ok('the server serves it too',
     /app\.get\('\/\.well-known\/assetlinks\.json'/.test(srv),
     'express.static refuses dotfiles by default, so this needs its own route');
  ok('as application/json',
     /assetlinks\.json'[\s\S]{0,400}?'Content-Type': 'application\/json'/.test(srv),
     'Android wants JSON; an HTML error page served with a 200 fails silently');

  /* Order matters: the .html redirect middleware and the SPA fallback would
     both happily answer this path with a page. */
  const route = srv.indexOf("app.get('/.well-known/assetlinks.json'");
  const spa   = srv.indexOf('express.static(STATIC_DIR');
  ok('AND BEFORE THE STATIC HANDLER AND THE SPA FALLBACK',
     route > 0 && spa > route,
     `route at ${route}, static at ${spa} — answered later, the request would `
     + 'get index.html with a 200, which reads as a valid response and is not');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
