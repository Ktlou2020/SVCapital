#!/usr/bin/env node
/* Prompting a mobile browser to get the app.
 *
 * What shipped before showed nothing to anybody. Both shells listened for
 * beforeinstallprompt and then looked for elements called pwaInstallBanner
 * and iosPwaBanner; neither exists in any HTML file here, so the lookup
 * returned null every time. It could not have fired in any case — Chrome
 * needs a linked web app manifest and the portal links none — and it offered
 * the progressive web app rather than the app on the store.
 *
 * So the first thing this check asserts is the thing nobody noticed: that a
 * banner the code draws is a banner that can exist.
 *
 * Run: node server/scripts/check-app-download-prompt.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const read  = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CORE   = read('js/app-banner.js');
const WEB    = read('portal/js/portal.js');
const MOBILE = read('mobile/src/js/portal.js');
const CSS    = read('js/app-banner.js');

/* The shipped detection, lifted and run. Retyping the user-agent tests here
   would prove only that this file agrees with itself. */
function lift() {
  const names = ['svcAppStore', 'svcMobileOS', 'svcIsIOSSafari', 'svcAppSnoozeKey',
                 'svcAppBannerSnoozed', 'svcSnoozeAppBanner', 'svcShouldOfferApp',
                 '_svcIsStandalone'];
  let src = '';
  for (const n of names) {
    const m = CORE.match(new RegExp(`function ${n.replace(/[$]/g, '\\$')}\\([\\s\\S]*?\\n\\}`, 'm'));
    if (!m) throw new Error(`could not lift ${n} from js/app-banner.js`);
    src += m[0] + '\n';
  }
  /* An incomplete lift does not throw here — svcSnoozeAppBanner guards its
     storage access with try/catch, so a helper left behind reads exactly like
     a private window and the assertions quietly pass on nothing. */
  const store = {};
  const ctx = {
    Math, parseInt, Number, String, Date,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    navigator: { userAgent: '', maxTouchPoints: 0 },
    window: {},
    _store: store,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.api = { ' + names.join(', ') + ' };', ctx);
  return { api: ctx.api, ctx, store };
}

const { api: A, store } = lift();

/* Real strings from real devices, not invented ones. */
const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidFirefox:'Mozilla/5.0 (Android 13; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
  iphoneSafari:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
  ipadOS:        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macSafari:     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  windows:       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

console.log('\nit knows which device it is on');
{
  ok('Android Chrome is Android', A.svcMobileOS(UA.androidChrome) === 'android');
  ok('Android Firefox is Android', A.svcMobileOS(UA.androidFirefox) === 'android');
  ok('an iPhone is iOS', A.svcMobileOS(UA.iphoneSafari) === 'ios');
  /* iPadOS 13 and later claim to be a Mac. The touch points are the only
     thing that separates an iPad from a MacBook. */
  ok('an iPad reporting itself as a Mac is still iOS',
     A.svcMobileOS(UA.ipadOS, { maxTouchPoints: 5 }) === 'ios',
     'iPad users would be shown nothing');
  ok('and a real Mac is not', A.svcMobileOS(UA.macSafari, { maxTouchPoints: 0 }) === null);
  ok('Windows is not a phone', A.svcMobileOS(UA.windows) === null);
}

console.log('\nit stands down where Apple draws its own banner');
{
  ok('iOS Safari is left to Apple', A.svcIsIOSSafari(UA.iphoneSafari) === true);
  ok('Chrome on iOS is not Safari', A.svcIsIOSSafari(UA.iphoneChrome) === false,
     'Apple’s banner does not appear there, so ours must');
  ok('Firefox on iOS is not Safari', A.svcIsIOSSafari(UA.iphoneFirefox) === false);
  ok('Android Chrome is not iOS Safari', A.svcIsIOSSafari(UA.androidChrome) === false);
}

console.log('\nit offers the app to the people who can install it');
{
  const base = { isNative: false, standalone: false, snoozed: false };
  ok('Android Chrome is offered the app',
     A.svcShouldOfferApp({ ...base, ua: UA.androidChrome }) === true);
  ok('Chrome on iOS is offered the app',
     A.svcShouldOfferApp({ ...base, ua: UA.iphoneChrome }) === true);
  ok('iOS Safari is not, because Apple already did',
     A.svcShouldOfferApp({ ...base, ua: UA.iphoneSafari }) === false);
  ok('a desktop browser is not asked at all',
     A.svcShouldOfferApp({ ...base, ua: UA.windows }) === false);

  ok('and never inside the app itself',
     A.svcShouldOfferApp({ ...base, ua: UA.androidChrome, isNative: true }) === false,
     'telling somebody to install what they are using is how a banner gets dismissed for good');
  ok('nor once it runs from the home screen',
     A.svcShouldOfferApp({ ...base, ua: UA.androidChrome, standalone: true }) === false);
  ok('nor after they have said no',
     A.svcShouldOfferApp({ ...base, ua: UA.androidChrome, snoozed: true }) === false);
}

console.log('\n"not now" means not now, not never');
{
  const now = Date.UTC(2026, 0, 1);
  A.svcSnoozeAppBanner(30, now);
  ok('a dismissal is remembered', A.svcAppBannerSnoozed(now + 86400000) === true);
  ok('and it wears off', A.svcAppBannerSnoozed(now + 31 * 86400000) === false,
     'a tombstone silences somebody who tapped the wrong thing once');
  ok('going to the store buys a longer rest',
     (A.svcSnoozeAppBanner(120, now), A.svcAppBannerSnoozed(now + 100 * 86400000)) === true,
     'they have almost certainly installed it');
  ok('the snooze is a timestamp, not a flag',
     /^\d{10,}$/.test(String(store['svc_app_banner_snoozed_until'])),
     JSON.stringify(store));
}

console.log('\nthe banner it draws can actually exist');
{
  /* The fault in the code this replaces: it showed an element that was never
     in any HTML file. This one builds its own, so the id it creates and the
     ids it later looks for have to be the same string. */
  const core = strip(CORE);
  const initFn  = (core.match(/function svcInitAppBanner\([\s\S]*?\n\}/) || [''])[0];
  const created = (initFn.match(/el\.id = '([^']+)'/) || [])[1];
  ok('the banner is created rather than assumed to exist',
     created === 'svcAppBanner', String(created));
  const lookups = [...core.matchAll(/getElementById\('(svcAppBanner|pwaInstallBanner|iosPwaBanner)'\)/g)]
    .map(m => m[1]);
  ok('every lookup names the element it creates',
     lookups.length > 0 && lookups.every(l => l === created),
     JSON.stringify(lookups));
  ok('and the two elements nothing ever created are gone',
     !/pwaInstallBanner|iosPwaBanner/.test(core.replace(/svcAppBanner/g, '')),
     'the dead ids are still referenced somewhere');

  ok('its styles are shipped, not only its markup',
     /\.svc-app-banner\s*\{/.test(CSS) && /\.svc-app-banner__cta\s*\{/.test(CSS),
     'an unstyled fixed-position bar over the portal');
  ok('and it sits at the bottom, clear of Apple’s banner at the top',
     /\.svc-app-banner\s*\{[^}]*bottom:\s*0/.test(CSS));
  ok('with the safe area accounted for',
     /env\(safe-area-inset-bottom/.test(CSS),
     'it would sit under the iPhone home indicator');
}

console.log('\nboth shells start it, and Apple’s tag is on the pages');
{
  for (const [label, src] of [['the web portal', strip(WEB)], ['the mobile shell', strip(MOBILE)]]) {
    ok(`${label} leaves starting it to the script that owns it`,
       !/svcInitAppBanner\(\)/.test(src),
       'two callers would race to build the same banner');
    ok(`${label} no longer reaches for an element that never existed`,
       !/pwaInstallBanner|iosPwaBanner/.test(src));
  }
  for (const p of ['portal/index.html', 'index.html']) {
    const html = read(p);
    ok(`${p} carries the Smart App Banner tag`,
       /<meta name="apple-itunes-app" content="app-id=6670504520"/.test(html),
       'iOS Safari users get no prompt at all');
  }
  ok('the landing page links the App Store directly',
     /apps\.apple\.com\/za\/app\/id6670504520/.test(read('index.html')) &&
     !/list-manage\.com[^"]*"[^>]*class="app-store-btn"/.test(read('index.html')),
     'the iOS button pointed at a mailing-list redirect');
  ok('and Google Play by package id',
     /play\.google\.com\/store\/apps\/details\?id=co\.za\.svcapital\.app/.test(read('index.html')));
}

console.log('\nit reaches the pages a client actually lands on');
{
  /* The fault that made Apple's banner never appear: the tag was on the
     landing page and on the portal shell, and the portal shell sits BEHIND
     the sign-in. A client opening the portal on a phone without a session
     sees login.html, which had neither the tag nor the script, and that is
     the page they look at for longest.

     Every page here is one somebody can arrive at with no session. */
  const ENTRY = ['index.html', 'login.html', 'signup.html', 'portal/index.html'];
  for (const p of ENTRY) {
    const html = read(p);
    ok(`${p} carries Apple's Smart App Banner tag`,
       /<meta name="apple-itunes-app" content="app-id=6670504520"/.test(html),
       'iOS Safari shows nothing on this page');
    ok(`${p} loads the banner script`,
       /src="[^"]*\/?js\/app-banner\.js/.test(html),
       'Android and non-Safari iOS get nothing on this page');
  }
  ok('the banner script carries its own styles',
     /svcAppBannerCss/.test(CORE) && /\.svc-app-banner\{/.test(CORE),
     'it would render unstyled on a page that does not ship the portal CSS');
  ok('and it does not depend on the portal stylesheet any more',
     !/svc-app-banner/.test(read('portal/css/portal-premium.css')),
     'two copies of the same rules drift');
  ok('it starts itself rather than waiting to be called',
     /_svcAppBannerBoot/.test(CORE),
     'pages with no shell JavaScript would never start it');
}

console.log('\nthe store links agree with the app that is published');
{
  const s = A.svcAppStore();
  ok('the App Store id is the numeric one', s.iosAppId === '6670504520', s.iosAppId);
  ok('the iOS link carries it', /id6670504520/.test(s.ios), s.ios);
  ok('the Android link carries the package name',
     /id=co\.za\.svcapital\.app/.test(s.android), s.android);
  ok('the Play id matches the one the Android build ships under',
     (read('mobile/capacitor.config.json').match(/"appId"\s*:\s*"([^"]+)"/) || [])[1] === 'co.za.svcapital.app',
     'the banner would send people to a listing that is not this app');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
