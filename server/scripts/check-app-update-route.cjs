#!/usr/bin/env node
/* How a fix actually reaches the packaged app — and what we told staff.
 *
 * A client reported Print / Save PDF dead in the app, twelve days after it
 * was fixed. The fix was correct and merged, and could not possibly have
 * reached them: capacitor.config.json carries NO server.url, so the app runs
 * assets bundled into its binary at build time, and no live-update plugin is
 * configured. A Railway deploy changes nothing on an installed app.
 *
 * The notice that announced those fixes said the opposite — "the
 * service-worker cache is bumped, so it arrives on next launch". That is
 * true of the WEB PORTAL and false of the APP, and a staff member reading it
 * would tell a client to relaunch and wait for something that is never
 * coming.
 *
 * So two things are held here:
 *
 *   · the app really is bundled, and if that ever changes — a server.url, a
 *     live-update plugin — this check is where somebody finds out, because
 *     the advice above stops being true the moment it does
 *   · no notice promises an app fix by cache bump or relaunch
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-app-update-route.cjs
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

console.log('\nthe app runs what was bundled into it, not what was deployed');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'mobile', 'capacitor.config.json'), 'utf8'));
ok('there is no server.url, so assets are bundled',
   !(cfg.server && cfg.server.url),
   `server.url = ${cfg.server && cfg.server.url} — if this is set the app loads remotely `
   + 'and a deploy DOES reach it; the guidance in the notices would need to change');
const pkgs = ['package.json', 'mobile/package.json']
  .filter(f => fs.existsSync(path.join(ROOT, f)))
  .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
ok('and no live-update plugin is installed',
   !/capacitor-updater|@capgo|code-?push|capacitor-live-update/i.test(pkgs),
   'a live-update plugin would change how a fix reaches a phone, and with it '
   + 'every answer we give a client who is still seeing a fixed bug');

console.log('\nand no notice tells staff an app fix arrives by relaunch');
const SETUP = fs.readFileSync(path.join(ROOT, 'server', 'db', 'setup.js'), 'utf8');
/* The sentence as it was published, which the correction step rewrites. */
ok('the app-document-fixes notice is corrected rather than left wrong',
   /app-document-fixes-2026-11'\s*\n?\s*AND where_to_find LIKE '%service-worker cache is bumped%'/.test(SETUP)
   || /Correct how an app fix actually reaches a phone/.test(SETUP),
   'it told staff the service-worker bump delivers it, which is true of the '
   + 'web portal and false of the packaged app');
ok('and the correction says where the fixes ARE available now',
   /THE WEB PORTAL HAS THESE NOW/.test(SETUP),
   'a client who cannot wait for a release can use the portal today');
ok('and that only a new build reaches an installed app',
   /new app build\\u2028?|new app build/.test(SETUP) && /store release/.test(SETUP));

console.log('\nand the fix it was about is really in the built app assets');
for (const f of ['mobile/src/js/portal.js', 'mobile/www/js/portal.js']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok(`${f} opens the statement through the shared document viewer`,
     /SVCDocs\.openAccountStatement\(data\)/.test(src),
     'the window.open path is what looked like a dead button in the WebView');
}
const DOCS = fs.readFileSync(path.join(ROOT, 'js', 'investor-documents.js'), 'utf8');
ok('and the viewer never asks a WebView for a window',
   /if \(!_isNativeApp\(\)\) \{[\s\S]{0,220}window\.open/.test(DOCS),
   'the Capacitor shell returns a truthy window for a view nobody sees, so a '
   + 'fallback that waits for null never fires');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
