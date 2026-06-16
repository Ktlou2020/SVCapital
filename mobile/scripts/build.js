#!/usr/bin/env node
/**
 * Build script: copies the portal web app into mobile/www/
 * and injects the native API base URL + Capacitor bridge config.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '../..');
const PORTAL    = path.join(ROOT, 'portal');
const JS_DIR    = path.join(ROOT, 'js');
const CSS_DIR   = path.join(ROOT, 'css');
const ASSETS    = path.join(ROOT, 'assets');
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

// Copy portal files to www root
copyDir(PORTAL, WWW);

// Copy shared js/ and css/ and assets/ into www
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

// Copy native bridge script
const nativeSrc = path.join(__dirname, '../src/native.js');
fs.mkdirSync(path.join(WWW, 'js'), { recursive: true });
fs.copyFileSync(nativeSrc, path.join(WWW, 'js', 'native.js'));
console.log('[build] Copied native.js');

// Patch all HTML files: inject native config + bridge script before </head>
const nativeConfigScript = `
  <!-- ── Capacitor native config injected by build.js ── -->
  <script>
    window.__SVC_NATIVE__ = true;
    window.__SVC_API_BASE__ = '${API_BASE}';
  </script>
  <script src="/js/native.js"></script>`;

const htmlFilesToPatch = ['index.html', 'login.html', 'signup.html', 'reset-password.html'];
for (const htmlFile of htmlFilesToPatch) {
  const htmlPath = path.join(WWW, htmlFile);
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    if (!html.includes('__SVC_NATIVE__')) {
      html = html.replace('</head>', nativeConfigScript + '\n</head>');
      fs.writeFileSync(htmlPath, html, 'utf8');
      console.log(`[build] Injected native config into ${htmlFile}`);
    }
  }
}

console.log('[build] www/ built successfully from portal/');
