'use strict';
/* ═══════════════════════════════════════════════════════════════════
   js/app-banner.js — self-contained, loadable from any page.

   It carries its own styles and starts itself, because the pages that most
   need it load almost nothing else: login.html and signup.html are where a
   client on a phone without a session actually lands, and neither loads
   portal-core or the portal stylesheet. Living inside portal-core, this
   prompted only people who had already signed in.
   ═══════════════════════════════════════════════════════════════════ */

/* Injected once, so the banner looks the same on the landing page, the
   sign-in page and the portal without any of them having to ship its CSS. */
function _svcAppBannerStyles() {
  if (document.getElementById('svcAppBannerCss')) return;
  const st = document.createElement('style');
  st.id = 'svcAppBannerCss';
  st.textContent = `
    .svc-app-banner{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;
      display:flex;align-items:center;gap:12px;
      padding:12px 14px calc(12px + env(safe-area-inset-bottom,0px));
      background:#fff;color:#1a1a1a;border-top:1px solid rgba(0,0,0,.10);
      box-shadow:0 -6px 24px rgba(0,0,0,.10);
      font-family:inherit;animation:svcAppBannerIn .28s ease-out}
    @keyframes svcAppBannerIn{from{transform:translateY(100%)}to{transform:translateY(0)}}
    @media (prefers-reduced-motion:reduce){.svc-app-banner{animation:none}}
    .svc-app-banner__icon{border-radius:10px;flex-shrink:0}
    .svc-app-banner__text{display:flex;flex-direction:column;min-width:0;flex:1}
    .svc-app-banner__text strong{font-size:.86rem;font-weight:700}
    .svc-app-banner__text span{font-size:.74rem;color:#6b7280;line-height:1.35;
      overflow:hidden;text-overflow:ellipsis;display:-webkit-box;
      -webkit-line-clamp:2;-webkit-box-orient:vertical}
    .svc-app-banner__cta{flex-shrink:0;border:0;cursor:pointer;background:#eda5ff;
      color:#1a1a1a;font-size:.8rem;font-weight:700;padding:9px 16px;border-radius:20px}
    .svc-app-banner__cta:hover{filter:brightness(.95)}
    .svc-app-banner__x{flex-shrink:0;border:0;background:none;cursor:pointer;
      color:#9ca3af;font-size:1.1rem;line-height:1;padding:6px 4px}
    .svc-app-banner__x:hover{color:#4b5563}
    body.dark-mode .svc-app-banner{background:#161b22;color:#e5e7eb;
      border-top-color:rgba(255,255,255,.12)}
    body.dark-mode .svc-app-banner__text span{color:#9aa4b2}`;
  document.head.appendChild(st);
}

/* ═══════════════════════════════════════════════════════════════════
   "Get the app" on a mobile browser

   A client reading the portal on their phone is told the app exists, once,
   with a link to the right store for their device.

   What was here before did nothing at all. Both shells listened for
   beforeinstallprompt and, eight seconds later, looked for elements called
   pwaInstallBanner and iosPwaBanner. Neither element exists in any HTML file
   in this repository, so the lookup returned null and nothing was ever shown.
   It could not have worked in any case: Chrome fires beforeinstallprompt only
   for a page that links a web app manifest, and the portal links none. That
   code also prompted for the PROGRESSIVE WEB APP, which is a different thing
   from the app on the store.

   Two mechanisms, chosen by what the device does best:

     iOS Safari  — Apple's own Smart App Banner, from a meta tag in the page
                   head. It is the affordance iOS users recognise, and it is
                   the only one that can tell whether the app is already
                   installed: it says OPEN rather than VIEW. Nothing in
                   JavaScript can determine that, so this beats anything we
                   could draw. The banner below stands down for it.

     everywhere   — the banner below: Android of any browser, and iOS in
     else on a     Chrome/Firefox/Edge where Apple's banner does not appear.
     phone

   Never in the native app itself, and never once the page is running from a
   home-screen icon — telling somebody to install what they are already using
   is the fastest way to have the banner dismissed for good.
   ═══════════════════════════════════════════════════════════════════ */

function svcAppStore() {
  return {
    /* Numeric App Store id, not a slug: apps.apple.com resolves the name
       itself and the id is the part that cannot go stale. */
    ios:     'https://apps.apple.com/za/app/id6670504520',
    android: 'https://play.google.com/store/apps/details?id=co.za.svcapital.app',
    iosAppId: '6670504520',
  };
}

/* 'ios' | 'android' | null. iPadOS 13 and later report themselves as
   Macintosh, so a Mac that reports touch points is an iPad. */
function svcMobileOS(ua, nav) {
  const agent = String(ua || (typeof navigator !== 'undefined' ? navigator.userAgent : ''));
  const n = nav || (typeof navigator !== 'undefined' ? navigator : {});
  if (/Android/i.test(agent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(agent)) return 'ios';
  if (/Macintosh/.test(agent) && Number(n.maxTouchPoints) > 1) return 'ios';
  return null;
}

/* Apple draws its own banner here, so ours would be the second one on the
   same screen. Chrome, Firefox and Edge on iOS all carry "Safari" in the
   user agent and are told apart by their own tokens. */
function svcIsIOSSafari(ua) {
  const agent = String(ua || (typeof navigator !== 'undefined' ? navigator.userAgent : ''));
  if (svcMobileOS(agent) !== 'ios') return false;
  if (/CriOS|FxiOS|EdgiOS|OPiOS|Chrome/i.test(agent)) return false;
  return /Safari/i.test(agent);
}

/* ═══════════════════════════════════════════════════════════════════
   When it comes back

   The rule is the client's: the banner appears every time they log in, and
   keeps appearing until they have the app. That rules out the thing this
   code used to do — dismissing wrote a timestamp thirty days ahead into
   localStorage, and tapping through to the store wrote one a hundred and
   twenty days ahead, so a single tap on the wrong day bought four months of
   silence whether or not anything was installed.

   Two questions replace the one snooze, because they are different questions:

     have they got it?   Answered by the server, not by this browser. A web
                         session looks identical whether or not the app is on
                         the same phone; the only evidence is an ios/android
                         push token, which nothing but the app can write.
                         That answer is a real stop: they downloaded it.

     have they waved it  Answered here, and only for a WHILE. "Not now" holds
     away just now?      long enough to finish what they came to do, and then
                         the banner comes back.

   That second answer used to last the whole login: one tap on the x and the
   banner was gone until the tab was closed or they signed in again. The rule
   is that it keeps asking until they have the app, so a dismissal that lasts
   a whole session is a dismissal that defeats the rule on the one device the
   client actually reads the portal on. It is a snooze now — long enough not
   to nag somebody mid-task, short enough that the next thing they do brings
   it back.

   The snooze is still keyed on the login it was made under and still lives in
   sessionStorage, so a new sign-in or a closed tab starts clean. Signed out,
   the key is the string 'anon', which is what keeps login.html quiet while
   they are getting through it.
   ═══════════════════════════════════════════════════════════════════ */

/* Long enough to finish paying something; short enough that it is a snooze
   rather than a silence. */
function svcAppSnoozeMs() {
  return 15 * 60 * 1000;
}

/* Functions, not top-level consts: this file is loaded beside two shells and
   declares no load-time state of its own. */
function svcAppDismissKey()   { return 'svc_app_banner_dismissed_for'; }
function svcAppInstalledKey() { return 'svc_app_installed'; }
function svcAppLegacySnoozeKey() { return 'svc_app_banner_snoozed_until'; }

/* Whoever is signed in, as far as this browser is concerned. Both stores are
   read because "remember me" decides which one login.html wrote to. */
function svcAppBannerToken() {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem('svc_token')) ||
           (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('svc_token')) || '';
  } catch (_) { return ''; }
}

/* A tail of the JWT, which changes at every login — not the email, which does
   not, and not the whole token, which has no business being copied around. */
function svcLoginFingerprint(token) {
  const t = token !== undefined && token !== null ? token : svcAppBannerToken();
  return t ? 'in:' + String(t).slice(-16) : 'anon';
}

/* Stored as "<login fingerprint>|<expiry in ms>". The fingerprint is still
   part of it so a different login never inherits somebody else's snooze, and
   a value written by the older build — a bare fingerprint, no expiry — reads
   as expired, which brings the banner back rather than silencing it for the
   session on the day this ships. */
function svcAppBannerDismissed(fingerprint, now) {
  try {
    const raw = sessionStorage.getItem(svcAppDismissKey());
    if (!raw) return false;
    const at = raw.lastIndexOf('|');
    if (at === -1) return false;                       // old format: treat as over
    const who = raw.slice(0, at);
    const until = Number(raw.slice(at + 1));
    if (who !== (fingerprint || svcLoginFingerprint())) return false;
    if (!isFinite(until)) return false;
    return (now !== undefined ? now : Date.now()) < until;
  } catch (_) { return false; }
}

/* How long is left on the snooze, so the page can bring the banner back
   without waiting for a reload. Zero when nothing is snoozed. */
function svcAppSnoozeRemaining(fingerprint, now) {
  try {
    const raw = sessionStorage.getItem(svcAppDismissKey());
    if (!raw) return 0;
    const at = raw.lastIndexOf('|');
    if (at === -1) return 0;
    if (raw.slice(0, at) !== (fingerprint || svcLoginFingerprint())) return 0;
    const until = Number(raw.slice(at + 1));
    if (!isFinite(until)) return 0;
    return Math.max(0, until - (now !== undefined ? now : Date.now()));
  } catch (_) { return 0; }
}

function svcSnoozeAppBanner(fingerprint, now, ms) {
  const until = (now !== undefined ? now : Date.now()) + (ms !== undefined ? ms : svcAppSnoozeMs());
  try { sessionStorage.setItem(svcAppDismissKey(), (fingerprint || svcLoginFingerprint()) + '|' + until); }
  catch (_) { /* private window — it simply comes back on the next page */ }
  return until;
}

/* Kept under the old name because other files call it. */
function svcDismissForThisLogin(fingerprint) { return svcSnoozeAppBanner(fingerprint); }

/* Somebody carrying the old long snooze would otherwise stay silenced for up
   to four months after this shipped, which is the bug rather than the fix. */
function svcForgetLegacyAppSnooze() {
  try { localStorage.removeItem(svcAppLegacySnoozeKey()); } catch (_) {}
}

/* The server's answer, cached for this session only. One request per login
   rather than one per page, and an uninstall is noticed at the next session
   instead of never — a permanent flag in localStorage could never be undone. */
function svcAppInstalledCached() {
  try { return sessionStorage.getItem(svcAppInstalledKey()); } catch (_) { return null; }
}

function svcRememberAppInstalled(hasApp) {
  try { sessionStorage.setItem(svcAppInstalledKey(), hasApp ? '1' : '0'); } catch (_) {}
}

/* Forget a "no" so the server is asked again. Used when they have just gone
   to the store, where the answer is about to change. */
function svcForgetAppInstalledCache() {
  try { sessionStorage.removeItem(svcAppInstalledKey()); } catch (_) {}
}

/* Resolves false for every uncertainty — signed out, offline, endpoint down,
   malformed answer. Not knowing is never a reason to withhold the banner;
   only the server saying yes is. */
async function svcHasMobileApp(fetchImpl) {
  const cached = svcAppInstalledCached();
  if (cached === '1') return true;
  if (cached === '0') return false;

  const token = svcAppBannerToken();
  if (!token) return false;              // signed out: nothing to ask about yet

  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return false;
  try {
    const r = await f('/api/push/has-mobile-app', {
      headers: { Authorization: 'Bearer ' + token },
      credentials: 'same-origin',
    });
    if (!r || !r.ok) return false;
    const j = await r.json();
    const has = !!(j && j.hasApp === true);
    svcRememberAppInstalled(has);
    return has;
  } catch (_) { return false; }
}

/* Every reason not to draw it that can be decided without asking the server,
   in one place so the check can drive it. */
function svcShouldOfferApp(env) {
  const e = env || {};
  const ua        = e.ua        !== undefined ? e.ua        : (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const isNative  = e.isNative  !== undefined ? e.isNative  : (typeof window !== 'undefined' && !!window.__SVC_NATIVE__);
  const standalone= e.standalone!== undefined ? e.standalone: _svcIsStandalone();
  const dismissed = e.dismissed !== undefined ? e.dismissed : svcAppBannerDismissed();

  if (isNative)   return false;   // already in the app
  if (standalone) return false;   // already installed to the home screen
  if (dismissed)  return false;   // snoozed; it comes back
  const os = svcMobileOS(ua, e.nav);
  if (!os)        return false;   // desktop: the store link is on the site
  /* iOS Safari used to be left to Apple's Smart App Banner, which the meta tag
     in the page head still asks for. Apple's is prettier and it is free — but
     it CANNOT be made to persist: once the client taps its x, Safari remembers
     that for the site and there is no way to ask again. On the one device
     where most clients read the portal, that made "keep asking until they have
     the app" impossible. So ours is drawn here too. Apple's may appear at the
     top of the first page they open; ours sits at the bottom and is the one
     that comes back. */
  return true;
}

function _svcIsStandalone() {
  try {
    if (typeof navigator !== 'undefined' && navigator.standalone === true) return true;
    return typeof window !== 'undefined' && !!window.matchMedia &&
           window.matchMedia('(display-mode: standalone)').matches;
  } catch (_) { return false; }
}

function svcDismissAppBanner() {
  svcSnoozeAppBanner();
  const el = document.getElementById('svcAppBanner');
  if (el) el.remove();
  /* It comes back without needing a reload. The portal is one long page: a
     client who taps x at nine in the morning and keeps the tab open all day
     would otherwise never be asked again, which is the whole thing this is
     supposed to prevent. */
  svcScheduleAppBannerReturn();
}

/* Re-offer when the snooze runs out, while they are still on the page. */
function svcScheduleAppBannerReturn() {
  if (typeof setTimeout !== 'function') return;
  const left = svcAppSnoozeRemaining();
  if (left <= 0) return;
  clearTimeout(svcScheduleAppBannerReturn._t);
  svcScheduleAppBannerReturn._t = setTimeout(() => svcInitAppBanner(0), left + 250);
}

function svcOpenAppStore() {
  const os = svcMobileOS();
  /* A snooze, not a stop. Whether they installed it is not this browser's
     guess to make — the server is asked, and if they did, that answer stops
     the banner for good. If they did not, they are asked again, which is the
     point.

     The cached answer is cleared on the way out: it was written when they did
     NOT have the app, and they are on their way to the store to change that.
     Leaving the stale '0' in place would have the banner nagging somebody who
     installed it ten minutes ago. */
  svcForgetAppInstalledCache();
  svcSnoozeAppBanner();
  const url = os === 'ios' ? svcAppStore().ios : svcAppStore().android;
  window.open(url, '_blank', 'noopener');
  const el = document.getElementById('svcAppBanner');
  if (el) el.remove();
}

/* Drawn after a delay so it does not land on top of a page still loading,
   and so somebody who opened the portal to do one quick thing can finish it.
   The server is asked only once the delay is over and the cheap guards have
   all passed, so a desktop browser and the app itself never make the call. */
function svcInitAppBanner(delayMs) {
  if (typeof document === 'undefined') return;
  svcForgetLegacyAppSnooze();
  if (!svcShouldOfferApp()) return;
  setTimeout(() => {
    if (!svcShouldOfferApp()) return;          // re-checked: they may have dismissed
    if (document.getElementById('svcAppBanner')) return;
    Promise.resolve(svcHasMobileApp()).then(hasApp => {
      if (hasApp) return;                      // they downloaded it — the one real stop
      if (!svcShouldOfferApp()) return;        // re-checked again: the await took time
      if (document.getElementById('svcAppBanner')) return;
      _svcDrawAppBanner();
    });
  }, typeof delayMs === 'number' ? delayMs : 6000);
}

function _svcDrawAppBanner() {
  const os = svcMobileOS();
  const store = os === 'ios' ? 'the App Store' : 'Google Play';
  _svcAppBannerStyles();
  const el = document.createElement('div');
  el.id = 'svcAppBanner';
  el.className = 'svc-app-banner';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Get the SV Capital app');
  el.innerHTML = `
    <img class="svc-app-banner__icon" src="/assets/logo-192.png" alt="" width="44" height="44">
    <div class="svc-app-banner__text">
      <strong>SV Capital app</strong>
      <span>Faster sign-in, and alerts when a pool opens or matures.</span>
    </div>
    <button type="button" class="svc-app-banner__cta" onclick="svcOpenAppStore()">Get it</button>
    <button type="button" class="svc-app-banner__x" aria-label="Not now" onclick="svcDismissAppBanner()">
      <i class="fa-solid fa-xmark" aria-hidden="true"></i>
    </button>`;
  el.title = `Open ${store}`;
  document.body.appendChild(el);
}

/* Starts itself. Every page that loads this script gets the banner, and the
   guards inside svcShouldOfferApp decide whether it is drawn. */
(function _svcAppBannerBoot() {
  if (typeof document === 'undefined') return;
  const go = () => svcInitAppBanner();
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(go, 0);
  } else {
    window.addEventListener('DOMContentLoaded', go);
  }
})();
