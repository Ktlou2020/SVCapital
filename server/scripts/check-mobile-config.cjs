#!/usr/bin/env node
/* What the phone app actually ships.
 *
 * Three things that were wrong, and the rules that keep them from coming
 * back. All three were invisible: nothing failed, nothing logged, and the
 * app looked fine.
 *
 * ── A FORK THAT STOPPED TRACKING ───────────────────────────────────────
 *
 * mobile/src/ is an overlay: a file there SHADOWS the shared one, so a fix
 * made on the web never reaches the app. mobile/src/signup.html was forked
 * and then the shared signup gained the invitation preview and structured
 * address capture — street, suburb, postal code, address search. The app
 * kept the old city picker, and kept the COMMENT describing the address
 * search while losing the fields.
 *
 * That mattered more than it looks: invitations now push new members into
 * the app to sign up, so every invited client was giving a weaker address
 * than a web client, which is a FICA field.
 *
 * The fork is deleted rather than patched. Its only mobile-specific content
 * was the Capacitor config block — which build.js injects into every HTML
 * file it copies anyway — and one redirect that the /portal/ stub already
 * handles.
 *
 * ── A DEBUGGABLE WEBVIEW IN A RELEASE BUILD ────────────────────────────
 *
 * android.webContentsDebuggingEnabled was true. On Capacitor 6 an explicit
 * true applies to release builds, not only debug, so a shipped APK could be
 * attached to with Chrome DevTools: read the stored JWT, read anything in
 * local storage, run JS as the app. On a financial app that is a hardening
 * failure and it costs nothing to turn off.
 *
 * ── A CONFIG NAMING FILES THAT DO NOT EXIST ────────────────────────────
 *
 * LocalNotifications was configured with smallIcon "ic_stat_icon_config_sample"
 * and sound "beep.wav" — both lifted from Capacitor's own documentation
 * sample, and neither in the repo. Nothing broke only because nothing uses
 * the plugin yet. The general rule is asserted instead of the two names: an
 * asset the config points at has to be there.
 *
 * Run: node server/scripts/check-mobile-config.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const has  = rel => fs.existsSync(path.join(ROOT, rel));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const CFG = JSON.parse(read('mobile/capacitor.config.json'));

/* ── The release build ───────────────────────────────────────────────── */
console.log('\nthe app does not ship a WebView anyone can attach to');
{
  ok('WEB CONTENTS DEBUGGING IS OFF',
     CFG.android && CFG.android.webContentsDebuggingEnabled === false,
     String(CFG.android && CFG.android.webContentsDebuggingEnabled)
     + ' — on Capacitor 6 an explicit true applies to RELEASE builds too, and '
     + 'an attachable WebView hands over the stored JWT');
  /* The two that were already right, held so they stay that way. */
  ok('and mixed content is still refused',
     CFG.android.allowMixedContent === false, String(CFG.android.allowMixedContent));
  ok('and cleartext is still refused',
     CFG.server && CFG.server.cleartext === false, String(CFG.server && CFG.server.cleartext));
  ok('navigation is still limited to hosts we control',
     Array.isArray(CFG.server.allowNavigation)
     && CFG.server.allowNavigation.every(h => /svcapital\.co\.za|railway\.app|paystack\.co/.test(h)),
     JSON.stringify(CFG.server.allowNavigation));
}

/* ── Every asset the config names ────────────────────────────────────── */
console.log('\nand every file the config points at is in the repo');
{
  /* The keys whose value is a resource rather than a setting. A colour or a
     duration names nothing; these do. */
  const ASSET_KEYS = ['smallIcon', 'sound', 'icon', 'androidSplashResourceName',
                      'splashResourceName', 'iosSplashResourceName'];
  const found = [];
  const walk = (o, trail) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (ASSET_KEYS.includes(k) && typeof v === 'string') found.push({ k, v, trail: trail.concat(k).join('.') });
      else if (v && typeof v === 'object') walk(v, trail.concat(k));
    }
  };
  walk(CFG, []);

  /* Where an Android resource can legitimately live. The name is given
     without an extension, as Android resources are. */
  const resolves = v => {
    const base = v.replace(/\.[a-z0-9]+$/i, '');
    const roots = ['mobile/android-config/app/src/main/res', 'mobile/android-config/res',
                   'mobile/src/assets', 'mobile/assets', 'assets'];
    for (const r of roots) {
      const abs = path.join(ROOT, r);
      if (!fs.existsSync(abs)) continue;
      const stack = [abs];
      while (stack.length) {
        const dir = stack.pop();
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) { stack.push(path.join(dir, e.name)); continue; }
          if (e.name === v || e.name.replace(/\.[a-z0-9]+$/i, '') === base) return true;
        }
      }
    }
    return false;
  };

  ok('the scan found the keys it is meant to look at',
     found.length > 0, 'nothing to check means nothing checked');
  for (const f of found) {
    ok(`${f.trail} = "${f.v}" exists`, resolves(f.v),
       'Capacitor\'s documentation sample names ic_stat_icon_config_sample and '
       + 'beep.wav; both were copied in and neither was ever added');
  }
}

/* ── The overlay ─────────────────────────────────────────────────────── */
console.log('\nand the app\'s sign-up is the one the web has');
{
  ok('THE STALE FORK IS GONE', !has('mobile/src/signup.html'),
     'mobile/src shadows the shared file, so a fork that stops tracking means '
     + 'web fixes never reach the app and nothing says so');

  const built = 'mobile/www/signup.html';
  ok('the bundle still has a sign-up page', has(built));
  if (has(built)) {
    const html = read(built);
    /* The two things the fork had lost. */
    for (const m of ['prefillInvite', '_checkInviteContact', 'id="inviteBanner"'])
      ok(`it carries the invitation preview (${m})`, html.includes(m),
         'an invited member is sent to the app to sign up — the banner naming '
         + 'the group and the address to use is the point');
    for (const m of ['id="addressSearch"', 'id="streetAddress"', 'id="suburb"', 'id="postalCode"'])
      ok(`and the structured address (${m})`, html.includes(m),
         'a FICA field; the app was capturing a city and the web a full address');
    ok('and it is not still on the old city picker',
       !html.includes('id="sa-cities-list"'), built);

    /* Deleting the fork must not have lost what the fork was for. */
    ok('the build injects the native config into it',
       html.includes('Capacitor native config injected by build.js')
       && /__SVC_NATIVE__\s*=\s*true/.test(html),
       'this is why the fork was unnecessary — build.js adds it to every HTML '
       + 'file it copies');
    ok('and points it at production',
       /__SVC_API_BASE__ = 'https:\/\/svcapital-production/.test(html),
       (html.match(/__SVC_API_BASE__ = '[^']*'/) || [])[0]);
  }
}

/* ── The redirect the fork used to handle ────────────────────────────── */
console.log('\nand an invited member still lands on their groups');
{
  const stub = read('mobile/src/portal/index.html');
  ok('the /portal/ stub still redirects to the app shell',
     /location\.replace\(/.test(stub), stub.slice(0, 160));
  ok('AND CARRIES THE QUERY STRING ACROSS',
     /location\.search/.test(stub) && /location\.hash/.test(stub),
     'the web sign-up sends a new member to /portal/index.html?view=groups; a '
     + 'bare replace("/") dropped it and landed them on the dashboard, which is '
     + 'the one thing the invitation was trying to avoid');
  ok('and the portal reads that parameter at boot',
     /params\.get\('view'\)/.test(read('js/portal-core.js')),
     'js/portal-core.js — svcOpenDeepLink');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
