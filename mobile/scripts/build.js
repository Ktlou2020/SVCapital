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

// Clean www
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

// Layer 3: Mobile-specific overrides from mobile/src/
// These files win over the portal/ and root js/css/ layers.
// native.js is always present; css/ and js/ subdirs are optional overrides.
const nativeSrc = path.join(SRC_DIR, 'native.js');
fs.mkdirSync(path.join(WWW, 'js'), { recursive: true });
fs.copyFileSync(nativeSrc, path.join(WWW, 'js', 'native.js'));
console.log('[build] Copied native.js');

for (const subdir of ['css', 'js']) {
  const srcSubdir = path.join(SRC_DIR, subdir);
  if (fs.existsSync(srcSubdir)) {
    copyDir(srcSubdir, path.join(WWW, subdir));
    console.log(`[build] Applied mobile/src/${subdir}/ overrides`);
  }
}

// Layer 4: Patch HTML files — inject native config, mobile-app.css link,
// and the loading cover element that hides initial skeleton content.
const LOADING_COVER = `
<!-- Native-app loading cover: masks skeleton content while portal data loads.
     Removed by portal.js after loadPortalData() resolves (including retries). -->
<div id="_nativeCover" style="display:none;position:fixed;inset:0;z-index:99998;background:#ffffff;flex-direction:column;align-items:center;justify-content:center;gap:16px">
  <img src="../assets/logo.png" alt="SV Capital" width="80" height="80" style="border-radius:18px;box-shadow:0 4px 24px rgba(0,0,0,0.12)">
  <p id="_nativeCoverText" style="color:#9ca3af;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;font-weight:500">Loading your portfolio…</p>
</div>
<script>(function(){
  if(!window.__SVC_NATIVE__)return;
  var c=document.getElementById('_nativeCover');
  if(!c)return;
  c.style.display='flex';
  try{
    if(localStorage.getItem('svc_dark_mode')==='dark'){
      c.style.background='#0d1117';
      var t=document.getElementById('_nativeCoverText');
      if(t)t.style.color='#6b7280';
    }
  }catch(_){}
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
    s.textContent='@keyframes viewFadeIn{from{opacity:1;transform:none}to{opacity:1;transform:none}}@-webkit-keyframes viewFadeIn{from{opacity:1;transform:none}to{opacity:1;transform:none}}.view{animation:none!important;-webkit-animation:none!important;opacity:1!important;transform:none!important}.view.active{animation:none!important;-webkit-animation:none!important;opacity:1!important;transform:none!important}';
    document.head.appendChild(s);
  })();
  </script>`;

const htmlFilesToPatch = ['index.html', 'login.html', 'signup.html', 'reset-password.html'];
for (const htmlFile of htmlFilesToPatch) {
  const htmlPath = path.join(WWW, htmlFile);
  if (!fs.existsSync(htmlPath)) continue;
  let html = fs.readFileSync(htmlPath, 'utf8');

  if (!html.includes('__SVC_NATIVE__')) {
    html = html.replace('</head>', nativeHeadScript + '\n</head>');
    console.log(`[build] Injected native config into ${htmlFile}`);
  }

  // Inject loading cover into index.html (portal main page only)
  if (htmlFile === 'index.html' && !html.includes('_nativeCover')) {
    html = html.replace('<body>', '<body>' + LOADING_COVER);
    console.log('[build] Injected loading cover into index.html');
  }

  fs.writeFileSync(htmlPath, html, 'utf8');
}

// Create www/portal/ so the server's post-login redirect to /portal/ resolves correctly.
const portalRedirectDir = path.join(WWW, 'portal');
fs.mkdirSync(portalRedirectDir, { recursive: true });
fs.writeFileSync(path.join(portalRedirectDir, 'index.html'),
`<!DOCTYPE html><html><head>
  <script>
    window.__SVC_NATIVE__ = true;
    window.__SVC_API_BASE__ = '${API_BASE}';
  </script>
  <script>window.location.replace('/');</script>
</head></html>`);
console.log('[build] Created www/portal/ redirect');

console.log('[build] www/ built successfully from portal/');
