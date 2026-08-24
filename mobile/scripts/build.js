#!/usr/bin/env node
/**
 * Build script: copies the portal web app into mobile/www/
 * and injects the native API base URL + Capacitor bridge config.
 *
 * Layer order (later layers win):
 *   1. portal/          — web portal source (HTML, CSS, JS)
 *   2. root js/ css/    — shared JS/CSS libraries
 *   3. mobile/src/      — mobile-specific overrides (native.js, mobile-app.css, portal.js)
 *   4. Patch: inject native config script + loading cover into HTML files
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '../..');
const PORTAL    = path.join(ROOT, 'portal');
const JS_DIR    = path.join(ROOT, 'js');
const CSS_DIR   = path.join(ROOT, 'css');
const ASSETS    = path.join(ROOT, 'assets');
const SRC_DIR   = path.join(__dirname, '../src');
const WWW       = path.join(__dirname, '../www');

// Production API URL — update if your Railway domain changes
const API_BASE = process.env.SVC_API_URL || 'https://svcapital-production.up.railway.app/api/';

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}

// Default /portal/ redirect so the server's post-login redirect resolves.
// mobile/src/portal/index.html overrides this via the Layer 3 overlay.
function writePortalRedirect() {
  const dir = path.join(WWW, 'portal');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'),
`<!DOCTYPE html><html><head>
  <script>
    window.__SVC_NATIVE__ = true;
    window.__SVC_API_BASE__ = '${API_BASE}';
  </script>
  <script>window.location.replace('/');</script>
</head></html>`);
}

/* mobile/www/ is a build artifact — every file in it is reproduced from
   portal/ + root js|css|assets/ + mobile/src/. Anything the mobile app owns
   lives in mobile/src/ and wins over the shared layers, so wiping is safe.
   Edit mobile/src/, never mobile/www/. */
fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });

// Layer 1: Copy portal files to www root
copyDir(PORTAL, WWW);

// Layer 2: Copy shared js/, css/, and assets/
copyDir(JS_DIR, path.join(WWW, 'js'));
copyDir(CSS_DIR, path.join(WWW, 'css'));
if (fs.existsSync(ASSETS)) copyDir(ASSETS, path.join(WWW, 'assets'));

// Copy sw.js and manifest.json from portal root if they exist
for (const f of ['sw.js', 'manifest.json']) {
  const src = path.join(PORTAL, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(WWW, f));
}

// Copy root HTML pages the portal may redirect to
for (const f of ['login.html', 'signup.html']) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(WWW, f));
    console.log(`[build] Copied ${f}`);
  }
}

// The www/portal/ redirect is generated BEFORE the mobile/src/ overlay so that
// mobile/src/portal/index.html can override it (it resolves the API base at
// runtime against the WebView host, which this default cannot do).
writePortalRedirect();

// Layer 3: Mobile overrides — mobile/src/ mirrors the www/ layout and is copied
// wholesale over the shared layers, so anything the app owns wins. Adding a file
// here shadows its portal/ or root counterpart; no allow-list to maintain.
copyDir(SRC_DIR, WWW);
console.log(`[build] Applied mobile/src/ overrides (${countFiles(SRC_DIR)} files)`);

// Layer 4: Patch HTML files — inject native config, mobile-app.css link,
// and the loading cover element that hides initial skeleton content.
// In native mode the Capacitor SplashScreen (a true native overlay) covers the
// WebView while data loads. We must NOT show a position:fixed WebView div —
// removing such a div after load causes Android WebView GPU compositing bugs
// that leave the page content blank. The _nativeCover div stays display:none
// in native; it is only used as a web-fallback (non-native builds).
const LOADING_COVER = `
<!-- Native loading: handled by Capacitor SplashScreen (native overlay).
     _nativeCover stays hidden in native mode to avoid Android compositing bugs.
     portal.js calls window.__SVC_HIDE_COVER() after data loads, which hides
     the native splash via SplashScreen.hide(). -->
<div id="_nativeCover" style="display:none"></div>
<script>(function(){
  // Non-native web only: show a minimal loading indicator
  if(window.__SVC_NATIVE__)return;
})();</script>`;

const nativeHeadScript = `
  <!-- ── Capacitor native config injected by build.js ── -->
  <script>
    window.__SVC_NATIVE__ = true;
    window.__SVC_API_BASE__ = '${API_BASE}';
  </script>
  <script src="/js/native.js"></script>
  <link rel="stylesheet" href="/css/mobile-app.css">
  <!-- Kill viewFadeIn animation synchronously before first paint — prevents Android WebView blank screen -->
  <script>
  (function(){
    var s=document.createElement('style');
    s.textContent='@keyframes viewFadeIn{from{opacity:1;transform:none}to{opacity:1;transform:none}}@-webkit-keyframes viewFadeIn{from{opacity:1;transform:none}to{opacity:1;transform:none}}.view{animation:none!important;-webkit-animation:none!important;transform:none!important}.view.active{animation:none!important;-webkit-animation:none!important;opacity:1!important;transform:none!important}';
    document.head.appendChild(s);
  })();
  </script>`;

const htmlFilesToPatch = ['index.html', 'login.html', 'signup.html', 'reset-password.html'];
for (const htmlFile of htmlFilesToPatch) {
  const htmlPath = path.join(WWW, htmlFile);
  if (!fs.existsSync(htmlPath)) continue;
  let html = fs.readFileSync(htmlPath, 'utf8');

  // Guard: check for the unique BUILD-injected comment, not the variable name
  // (login.html references window.__SVC_NATIVE__ in its own JS, which would
  // fool the old string-match and skip injection — leaving __SVC_API_BASE__ unset)
  if (!html.includes('Capacitor native config injected by build.js')) {
    html = html.replace('</head>', nativeHeadScript + '\n</head>');
    console.log(`[build] Injected native config into ${htmlFile}`);
  }

  // Inject loading cover into index.html (portal main page only)
  if (htmlFile === 'index.html' && !html.includes('_nativeCover')) {
    html = html.replace('<body>', '<body>' + LOADING_COVER);
    console.log('[build] Injected loading cover into index.html');
  }

  // Patch tourSpotlight to start hidden so the 9999px box-shadow doesn't
  // create a full-screen dark overlay before _positionTour() runs
  if (htmlFile === 'index.html') {
    html = html.replace(
      '<div id="tourSpotlight"></div>',
      '<div id="tourSpotlight" style="display:none"></div>'
    );
    // Idempotent: if already patched, the replace is a no-op
  }

  fs.writeFileSync(htmlPath, html, 'utf8');
}

console.log('[build] www/ built successfully from portal/ + mobile/src/');
