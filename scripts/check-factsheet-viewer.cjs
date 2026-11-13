#!/usr/bin/env node
/* A factsheet must actually appear when a client taps it.
 *
 * Reported from the Android app: "I couldn't open any of the factsheets
 * under any of the investment products." The overlay opened — Back button,
 * the document's name along the top — and the body below it was blank.
 *
 * ANDROID'S WEBVIEW HAS NO PDF RENDERER. Not a CSP problem and not a blob
 * problem: an <iframe> pointing at a PDF paints nothing, and
 * product_factsheets.mime_type defaults to 'application/pdf', so every
 * factsheet hit it. Chrome on Android does the same — it downloads a PDF
 * rather than displaying one — so there was never a build of this that
 * worked on a phone.
 *
 * The overlay now picks its element by what the document IS: an <img> for
 * an image, pdf.js onto canvases for a PDF, the old iframe for anything
 * else. pdf.js is VENDORED (mobile/src/vendor/pdfjs, from npm) rather than
 * pulled off a CDN: a factsheet is the document a client is asked to invest
 * on, and making it unreadable whenever a CDN is slow or blocked is a worse
 * trade than 1.4 MB in the bundle.
 *
 * WHAT THIS ASSERTS, AND WHY IT IS NOT A STUB. The REAL pdf.js renders a
 * REAL PDF here, and what is measured is the pixels it put on the canvas —
 * not that a canvas exists, which an empty one would also satisfy. A
 * hand-written stand-in for pdf.js would have matched whatever calls the
 * code makes, which is the one thing worth checking.
 *
 * Run: node scripts/check-factsheet-viewer.cjs
 */
'use strict';

const fs   = require('fs');
const http = require('http');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const CHROME = require('./lib/chromium.cjs').findChromium();

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ── The vendored viewer ─────────────────────────────────────────────── */
console.log('\nthe viewer ships with the app');
{
  const dir = path.join(ROOT, 'mobile', 'src', 'vendor', 'pdfjs');
  for (const f of ['pdf.min.js', 'pdf.worker.min.js']) {
    const p = path.join(dir, f);
    ok(`mobile/src/vendor/pdfjs/${f} is vendored`,
       fs.existsSync(p) && fs.statSync(p).size > 100000,
       fs.existsSync(p) ? `${fs.statSync(p).size} bytes` : 'missing');
  }
  /* mobile/www is a BUILD OUTPUT. A viewer that exists only in src is a
     viewer the app does not have. */
  for (const f of ['pdf.min.js', 'pdf.worker.min.js']) {
    ok(`and the build carries ${f} into www`,
       fs.existsSync(path.join(ROOT, 'mobile', 'www', 'vendor', 'pdfjs', f)),
       'run node mobile/scripts/build.js');
  }
  const src = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'js', 'portal.js'), 'utf8');
  ok('and it is loaded from the app, not from a CDN',
     /_PDFJS_BASE\s*=\s*'vendor\/pdfjs'/.test(src)
     && !/pdfjs-dist@[\d.]+/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
     'a factsheet must not depend on a CDN being reachable');
}

if (!CHROME) {
  console.log('\n  SKIP  no headless Chromium — nothing was rendered');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* A real, minimal PDF. Built here rather than committed so the check carries
   no binary, and it is a genuine PDF — pdf.js parses it or the check fails. */
const PDF_BYTES = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 160]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 58>>stream
BT /F1 14 Tf 20 80 Td (OCTOBER 2026 FACTSHEET) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>`, 'latin1');
const PDF = 'data:application/pdf;base64,' + PDF_BYTES.toString('base64');
/* A 1×1 PNG. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
const HARNESS = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>window.__SVC_NATIVE__ = true;<\/script>
<script src="/js/api.js"><\/script>
<script src="/js/portal-core.js"><\/script>
<script src="/mobile/src/js/portal.js"><\/script>
</body></html>`;

(async () => {
  let browser, server;
  try {
    server = http.createServer((q, s) => {
      const u = decodeURIComponent(q.url.split('?')[0]);
      if (u === '/__harness.html') { s.writeHead(200, { 'Content-Type': 'text/html' }); return s.end(HARNESS); }
      /* The app asks for vendor/pdfjs relative to itself; serve it from src. */
      const rel = u.startsWith('/vendor/') ? path.join('mobile', 'src', u) : u;
      const f = path.join(ROOT, rel);
      if (!f.startsWith(ROOT)) { s.writeHead(403); return s.end('no'); }
      fs.readFile(f, (e, d) => {
        if (e) { s.writeHead(404); s.end('nf'); }
        else { s.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'text/plain' }); s.end(d); }
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const BASE = `http://127.0.0.1:${server.address().port}`;

    const { chromium } = require('playwright');
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message)));
    /* js/portal.js sends a browser with no token to the login page before it
       defines anything, so nothing would be global to call. */
    await page.addInitScript(() => {
      try {
        const b64 = o => btoa(JSON.stringify(o))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        localStorage.setItem('svc_token',
          b64({ alg: 'HS256', typ: 'JWT' }) + '.' +
          b64({ id: 'I1', email: 'e@x.t', role: 'investor',
                exp: Math.floor(Date.now() / 1000) + 86400 }) + '.sig');
        localStorage.setItem('svc_user', JSON.stringify({ id: 'I1', email: 'e@x.t', role: 'investor' }));
      } catch (_) {}
    });
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.includes('/api/')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' });
      }
      if (url.startsWith(BASE)) return route.continue();
      /* Nothing off this machine: if the viewer ever goes back to a CDN,
         this check must fail rather than quietly succeed over the network. */
      return route.abort();
    });
    await page.goto(`${BASE}/__harness.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window._openFsDoc === 'function'
      || typeof _openFsDoc === 'function', { timeout: 15000 }).catch(() => {});

    const show = async doc => page.evaluate(async d => {
      document.getElementById('_fsNativeOverlay')?.remove();
      /* The LEXICAL binding: _fsDocCache is a top-level `let`, so
         window._fsDocCache would be a different variable entirely. */
      _fsDocCache = [d];
      _openFsDoc(0);
      for (let i = 0; i < 75; i++) {
        const b = document.getElementById('_fsBody');
        if (b && (b.querySelector('canvas') || b.querySelector('img')
                  || /Could not/.test(b.textContent))) break;
        await new Promise(r => setTimeout(r, 200));
      }
      const b = document.getElementById('_fsBody');
      const canvas = b && b.querySelector('canvas');
      return {
        overlay: !!document.getElementById('_fsNativeOverlay'),
        canvases: b ? b.querySelectorAll('canvas').length : 0,
        imgs: b ? b.querySelectorAll('img').length : 0,
        iframes: b ? b.querySelectorAll('iframe').length : 0,
        text: b ? b.innerText.slice(0, 160) : '',
        /* A canvas can exist and be blank. This is the difference between
           "pdf.js was called" and "the document is on the screen". */
        inked: canvas ? (() => {
          const g = canvas.getContext('2d');
          const px = g.getImageData(0, 0, canvas.width, canvas.height).data;
          /* ALPHA, not colour. A canvas that was never rendered is
             transparent black — every pixel reads r=0, so a "darker than
             white" test called a blank canvas fully inked and passed while
             the render was deleted. Anything actually painted has alpha. */
          let drawn = 0, dark = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i + 3] > 0) {
              drawn++;
              if (px[i] < 128 && px[i + 1] < 128 && px[i + 2] < 128) dark++;
            }
          }
          return { w: canvas.width, h: canvas.height, drawn, dark };
        })() : null,
      };
    }, doc);

    console.log('\nand a PDF factsheet is drawn, not left blank');
    const pdf = await show({ file_url: PDF, file_name: 'October 2026 – Factsheet',
                             mime_type: 'application/pdf' });
    ok('the overlay opens', pdf.overlay === true, JSON.stringify(pdf).slice(0, 200));
    ok('IT IS NOT AN IFRAME, which is what rendered blank on Android',
       pdf.iframes === 0, JSON.stringify(pdf).slice(0, 200));
    ok('a page is rendered to a canvas', pdf.canvases === 1, String(pdf.canvases));
    ok('AND THE CANVAS HAS THE DOCUMENT ON IT',
       !!pdf.inked && pdf.inked.drawn > 1000,
       JSON.stringify(pdf.inked) + ' — a blank canvas would satisfy the count above');
    ok('with dark pixels where the text is',
       !!pdf.inked && pdf.inked.dark > 200,
       JSON.stringify(pdf.inked) + ' — a page painted white and nothing else is not the document');
    ok('at the page\'s own shape', !!pdf.inked
       && Math.abs((pdf.inked.w / pdf.inked.h) - (300 / 160)) < 0.02,
       JSON.stringify(pdf.inked) + ' — the test page is 300×160');
    /* Scale, not just shape. The page is 300pt wide; rendered at scale 1 it
       would be 300 device pixels on a 412px screen at dpr 2 — a blurry
       half-size image that still has the right aspect ratio, which is why
       shape alone did not catch dropping the scale. */
    ok('and rendered for the screen rather than at its own point size',
       !!pdf.inked && pdf.inked.w > 600,
       JSON.stringify(pdf.inked) + ' — 300pt wide at dpr 2 on a 412px screen '
       + 'should be ~824 device pixels, not 300');
    ok('and no error is shown', !/Could not/.test(pdf.text), pdf.text);

    console.log('\nand an image factsheet is drawn as an image');
    const png = await show({ file_url: PNG, file_name: 'An image factsheet',
                             mime_type: 'image/png' });
    ok('it uses an <img>', png.imgs === 1 && png.canvases === 0, JSON.stringify(png).slice(0, 160));
    ok('and not an iframe', png.iframes === 0, JSON.stringify(png));

    console.log('\nand a document with no stated type is treated as a PDF');
    {
      /* mime_type has a default, but a row written before that default, or
         through a path that did not set it, arrives with nothing. Guessing
         "iframe" there is guessing the blank screen. */
      /* A data: URL states its own type in its header, so omitting
         mime_type alone does NOT exercise this — the sniff finds it anyway,
         and the first version of this test passed with the fallback
         inverted. The type has to be absent from BOTH. */
      const bare = await show({ file_url: PDF.replace('data:application/pdf;', 'data:;'),
                                file_name: 'No mime recorded' });
      ok('it still renders', bare.canvases === 1 && !!bare.inked && bare.inked.drawn > 1000,
         JSON.stringify(bare).slice(0, 200));
    }

    console.log('\nand nothing reached for the network');
    ok('no script was fetched off this machine',
       !errors.some(e => /ERR_FAILED|net::/.test(e)),
       JSON.stringify(errors).slice(0, 300)
       + ' — every outside request is aborted in this check, so a viewer '
       + 'loaded from a CDN would fail here');
    ok('and nothing threw', !errors.some(e => /is not defined|is not a function/.test(e)),
       JSON.stringify(errors).slice(0, 300));
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server)  server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
