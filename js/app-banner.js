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

/* A function, not a top-level const: portal-core is loaded beside two shells
   and declares no load-time state of its own. */
function svcAppSnoozeKey() { return 'svc_app_banner_snoozed_until'; }

/* Dismissal is a snooze, not a tombstone: somebody who says "not now" on a
   borrowed phone should not be silenced for ever, and somebody who taps
   through to the store almost certainly installed it and should be left
   alone for much longer. Storage can throw in a private window, so every
   read and write is guarded. */
function svcAppBannerSnoozed(now) {
  try {
    const until = parseInt(localStorage.getItem(svcAppSnoozeKey()) || '0', 10);
    return Number.isFinite(until) && until > (now || Date.now());
  } catch (_) { return false; }
}

function svcSnoozeAppBanner(days, now) {
  try {
    const until = (now || Date.now()) + (days * 24 * 60 * 60 * 1000);
    localStorage.setItem(svcAppSnoozeKey(), String(until));
  } catch (_) { /* private window — the banner simply reappears next visit */ }
}

/* Every reason not to draw it, in one place so the check can drive it. */
function svcShouldOfferApp(env) {
  const e = env || {};
  const ua        = e.ua        !== undefined ? e.ua        : (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const isNative  = e.isNative  !== undefined ? e.isNative  : (typeof window !== 'undefined' && !!window.__SVC_NATIVE__);
  const standalone= e.standalone!== undefined ? e.standalone: _svcIsStandalone();
  const snoozed   = e.snoozed   !== undefined ? e.snoozed   : svcAppBannerSnoozed();

  if (isNative)   return false;   // already in the app
  if (standalone) return false;   // already installed to the home screen
  if (snoozed)    return false;   // asked already, recently
  const os = svcMobileOS(ua, e.nav);
  if (!os)        return false;   // desktop: the store link is on the site
  if (svcIsIOSSafari(ua)) return false;  // Apple draws its own, better, banner
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
  svcSnoozeAppBanner(30);
  const el = document.getElementById('svcAppBanner');
  if (el) el.remove();
}

function svcOpenAppStore() {
  const os = svcMobileOS();
  /* Long snooze: they have gone to the store, so either they installed it —
     in which case the next visit is inside the app — or they decided not to
     and do not need asking again for a season. */
  svcSnoozeAppBanner(120);
  const url = os === 'ios' ? svcAppStore().ios : svcAppStore().android;
  window.open(url, '_blank', 'noopener');
  const el = document.getElementById('svcAppBanner');
  if (el) el.remove();
}

/* Drawn after a delay so it does not land on top of a page still loading,
   and so somebody who opened the portal to do one quick thing can finish it.
   Called by each shell on load; core declares nothing at load time itself. */
function svcInitAppBanner(delayMs) {
  if (typeof document === 'undefined') return;
  if (!svcShouldOfferApp()) return;
  setTimeout(() => {
    if (!svcShouldOfferApp()) return;          // re-checked: they may have dismissed
    if (document.getElementById('svcAppBanner')) return;
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
  }, typeof delayMs === 'number' ? delayMs : 6000);
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
