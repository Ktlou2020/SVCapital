#!/usr/bin/env node
/* The Ledger Gap panel must actually draw, with the figures on it.
 *
 * check-ledger-gap-explained proves the arithmetic and the route. This proves
 * the screen built from it, which is a separate failure: a figure computed
 * correctly and then interpolated under the wrong name renders an empty cell
 * with no error anywhere.
 *
 * ── WHY THE WHOLE FILE IS LOADED ───────────────────────────────────────
 *
 * The fund console shipped with 24 references to `fmt` where the file defines
 * `stlfmt`. Every endpoint returned 200 and the screen hung, because the check
 * guarding it had lifted the renderer into a context with `fmt` STUBBED IN —
 * so the one thing that was broken was the one thing the harness supplied.
 *
 * So admin/js/admin.js and js/api.js are loaded WHOLE, over HTTP, the way the
 * browser loads them, and the panel's markup is lifted verbatim out of
 * admin/index.html. Nothing the renderer reaches for is provided by this file.
 * What is stubbed is the network and the clock, never the code under test.
 *
 * The console's own index.html cannot be used directly: js/api.js sends a
 * browser with no token to /login.html before the shell mounts. A token of the
 * right shape is planted so api.js loads as itself.
 *
 * Run: node scripts/check-ledger-gap-screen.cjs
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

if (!CHROME) {
  console.log('  SKIP  no headless Chromium — the panel was not rendered');
  process.exit(0);
}

/* The panel's markup out of the shipped file. If the markers move this throws,
   rather than quietly rendering an empty page and passing nothing. */
const INDEX = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
const FROM  = INDEX.indexOf('<!-- Ledger gap explained -->');
const TO    = INDEX.indexOf('<!-- Withdrawal double-debit reconciliation -->');
if (FROM < 0 || TO <= FROM) {
  console.log('  ✗ the Ledger Gap panel could not be found in admin/index.html');
  process.exit(1);
}
const PANEL = INDEX.slice(FROM, TO);

/* The shape the route returns for an account whose rollovers lost their
   matured-funds credits — the reported shape, with one reinvestment the
   repair cannot pair and one accrual that must not be counted. */
const PAYLOAD = {
  scope: 'S-112415', threshold: 100, found: true, scanned: 3,
  accounts: [{
    id: 'S-112415', name: 'Puno Stokvel Association', email: 'p@x.test',
    wallet: 2000, derived: 1300, gap: 700, direction: 'ledger-under-accounts',
    causes: {
      unpairedReinvestments: { count: 2, total: 700,
        rows: [{ id: 'T1', reference: 'REINV-INV-A', amount: 400, at: '2025-06-10' },
               { id: 'T2', reference: 'REINV-INV-C', amount: 300, at: '2025-09-10' }],
        remedy: 'POST /api/admin/backfill-matured-funds — {"dry_run":true} first' },
      unpairableReinvestments: { count: 1, total: 120,
        rows: [{ id: 'T3', reference: null, amount: 120, at: '2025-04-01' }],
        remedy: 'By hand' },
      noCashEffect: { total: 50, byType: [{ type: 'return', n: 1, total: 50 }], counted: false },
    },
    accountedFor: 700, unexplained: 0,
    recent: [
      { id: 'R1', type: 'deposit', amount: 2000, reference: 'DEP-1', at: '2025-03-10', cash: 2000 },
      { id: 'R2', type: 'return',  amount: 50,   reference: 'RET-1', at: '2025-08-10', cash: 0 },
    ],
  }],
};

/* A client name carrying markup. Everything on this panel is client data, and
   a panel that renders a name as HTML is the vulnerability it reports on. */
const XSS = JSON.parse(JSON.stringify(PAYLOAD));
XSS.accounts[0].name = '<img src=x onerror="window.__XSS=1">Mandla';
XSS.accounts[0].causes.unpairedReinvestments.rows[0].reference = '<b>REINV-BOLD</b>';

const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/admin.css">
<link rel="stylesheet" href="/css/admin-premium.css">
<link rel="stylesheet" href="/css/admin-v2.css">
</head><body>
<div class="view active" id="view-opsconsole" style="padding:24px;max-width:1100px">
${PANEL}
</div>
<script>window.StaffAuth={guard:()=>true,injectWidget(){},logout(){},setSession(){},clearSession(){}};<\/script>
<script src="/js/api.js"><\/script>
<script src="/admin/js/admin.js"><\/script>
</body></html>`;

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

(async () => {
  let browser, server;
  try {
    server = http.createServer((q, s) => {
      const u = decodeURIComponent(q.url.split('?')[0]);
      if (u === '/__harness.html') {
        s.writeHead(200, { 'Content-Type': 'text/html' });
        return s.end(HARNESS);
      }
      const f = path.join(ROOT, u);
      /* Nothing outside the repo is served, harness aside. */
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

    /* One page load per payload, so a leftover DOM cannot carry an assertion. */
    async function render(payload) {
      const page = await browser.newPage({ viewport: { width: 1180, height: 1100 } });
      const errors = [];
      page.on('pageerror', e => errors.push(String(e.message)));
      await page.addInitScript(() => {
        try {
          /* Auth.getToken decodes the JWT and treats an unparseable or expired
             one as absent, so the token needs the right SHAPE and a future exp.
             It is never sent anywhere — every API call is intercepted below. */
          const b64 = o => btoa(JSON.stringify(o))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          localStorage.setItem('svc_token',
            b64({ alg: 'HS256', typ: 'JWT' }) + '.' +
            b64({ id: 'u-lg', email: 'lg@chk.test', role: 'admin',
                  exp: Math.floor(Date.now() / 1000) + 86400 }) + '.sig');
          localStorage.setItem('svc_user', JSON.stringify(
            { id: 'u-lg', email: 'lg@chk.test', role: 'admin', first_name: 'Check' }));
        } catch (_) {}
      });
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (url.includes('/api/admin/ledger-gap')) {
          return route.fulfill({ status: 200, contentType: 'application/json',
                                 body: JSON.stringify(payload) });
        }
        if (url.includes('/api/')) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' });
        }
        if (url.startsWith(BASE)) return route.continue();
        /* Fonts and the icon CDN: the panel's legibility must not depend on
           the network, and neither must this check. */
        return route.fulfill({ status: 200,
          contentType: /\.js(\?|$)/.test(url) || url.includes('gtag')
            ? 'application/javascript' : 'text/css', body: '' });
      });
      await page.goto(`${BASE}/__harness.html`, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.runLedgerGap === 'function',
        { timeout: 15000 }).catch(() => {});
      const out = await page.evaluate(async () => {
        const res = { fn: typeof runLedgerGap === 'function',
                      csvFn: typeof exportLedgerGapCSV === 'function',
                      panel: !!document.getElementById('lgResult') };
        if (!res.fn || !res.panel) return res;
        document.getElementById('lgInvestor').value = 'S-112415';
        const btn = document.querySelector('button[onclick="runLedgerGap(this)"]');
        res.btn = !!btn;
        try { await runLedgerGap(btn); res.ran = true; } catch (e) { res.threw = e.message; }
        const el = document.getElementById('lgResult');
        res.html = el.innerHTML;
        res.text = (el.innerText || '').replace(/\s+/g, ' ');
        res.exportShown = document.getElementById('lgExportBtn').style.display !== 'none';
        res.xssFired = !!window.__XSS;
        res.imgs = el.querySelectorAll('img').length;
        res.bolds = el.querySelectorAll('b').length;
        /* Text the same colour as whatever is actually painted behind it —
           the fault that shipped a panel nobody could read. Walked up to the
           nearest painted ancestor rather than read off the source. */
        const painted = n => {
          for (let e = n; e && e !== document.documentElement; e = e.parentElement) {
            const bg = getComputedStyle(e).backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        res.invisible = [];
        el.querySelectorAll('*').forEach(n => {
          if (![...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim())) return;
          const cs = getComputedStyle(n);
          if (cs.color === painted(n)) res.invisible.push(n.innerText.slice(0, 40));
        });
        return res;
      });
      out.errors = errors;
      await page.close();
      return out;
    }

    console.log('\nthe panel draws, from the real admin.js');
    const r = await render(PAYLOAD);
    ok('the markup and both functions are there',
       r.panel && r.fn && r.csvFn && r.btn, JSON.stringify(r).slice(0, 300));
    ok('it runs without throwing', r.ran === true, r.threw || JSON.stringify(r.errors).slice(0, 300));
    /* The whole file is loaded, so a reference to a helper that does not exist
       surfaces here instead of on a fund manager's screen. */
    ok('and nothing in the file references a helper that is not there',
       !r.errors.some(e => /is not defined|is not a function/.test(e)),
       JSON.stringify(r.errors).slice(0, 400));

    console.log('\nand the figures are on it');
    const has = s => r.text.includes(s);
    ok('the client is named', has('Puno Stokvel Association') && has('S-112415'), r.text.slice(0, 200));
    ok('the wallet, the ledger and the gap are all three shown',
       /R.?2.?000,00/.test(r.text) && /R.?1.?300,00/.test(r.text) && /\+R.?700,00/.test(r.text),
       r.text.slice(0, 300));
    ok('the direction is spelled out, not left as a sign',
       /under-accounts/.test(r.text), r.text.slice(0, 300));
    /* The sentence that stops somebody paying the client twice. */
    ok('and it says not to credit the wallet again',
       /do not credit the wallet again/i.test(r.text),
       'this panel exists to prevent exactly that');
    ok('the unpaired reinvestments are listed by reference',
       has('REINV-INV-A') && has('REINV-INV-C'), r.text.slice(0, 600));
    ok('the remedy is named', /Backfill Matured Funds/.test(r.text));
    ok('the accrual is shown but marked not counted',
       /no cash effect/i.test(r.text) && /Not counted/i.test(r.text), r.text);
    ok('accounted-for and unexplained are shown apart',
       /R.?700,00 accounted for/.test(r.text) && /R.?0,00 unexplained/.test(r.text),
       'adding them would overstate what is explained');
    ok('the export becomes available once there is something to export',
       r.exportShown === true);
    ok('and nothing rendered as undefined or NaN',
       !/undefined|NaN/.test(r.text), r.text.slice(0, 400));

    console.log('\nand every colour it uses is one the console defines');
    {
      const used = [...new Set((r.html.match(/var\(--([a-z-]+)\)/g) || [])
        .map(s => s.slice(6, -1)))];
      const css = ['admin.css', 'admin-premium.css', 'admin-v2.css']
        .map(f => { try { return fs.readFileSync(path.join(ROOT, 'css', f), 'utf8'); }
                    catch (_) { return ''; } }).join('\n');
      const undef = used.filter(v => !new RegExp('--' + v + '\\s*:').test(css));
      /* --bg-secondary is used 38 times elsewhere in this console and defined
         nowhere, so those backgrounds render transparent. This panel must not
         add a 39th. */
      ok('no undefined custom property is referenced', undef.length === 0,
         `undefined: ${undef.join(', ')} — used: ${used.join(', ')}`);
      ok('and it does reference some, so this is not passing on an empty set',
         used.length >= 2, used.join(', '));
    }

    console.log('\nand no text is the same colour as what is behind it');
    ok('every line is legible against its own background',
       r.invisible.length === 0, JSON.stringify(r.invisible.slice(0, 5)));

    /* The two empty answers, which must not read alike. A mistyped account
       number is the ordinary way to reach the first, and a screen that
       answers it with a green tick is how a typo becomes a sign-off on an
       account nobody looked at. */
    console.log('\nand an empty answer says WHICH kind of empty it is');
    {
      const missing = await render({ scope: 'S-000000', threshold: 100, found: false, accounts: [] });
      ok('an unknown account is drawn as not found', missing.ran === true
         && /No account with id/i.test(missing.text), missing.text || missing.threw);
      ok('and is not drawn as balancing',
         !/ties/i.test(missing.text) && !/circle-check/.test(missing.html || ''),
         missing.text);
      ok('and says plainly that nothing was checked',
         /not the same as the account balancing/i.test(missing.text), missing.text);
      ok('the export stays hidden, since there is nothing to export',
         missing.exportShown === false, String(missing.exportShown));

      const ties = await render({ scope: 'S-112415', threshold: 100, found: true,
                                  scanned: 412, accounts: [] });
      ok('an account that really ties is drawn as tying', ties.ran === true
         && /ties/i.test(ties.text), ties.text || ties.threw);
      ok('and the two empty answers do not read the same',
         ties.text !== missing.text && !/No account with id/i.test(ties.text),
         `${missing.text}\n      vs\n      ${ties.text}`);
    }

    console.log('\nand a client\'s own text is never markup');
    {
      const x = await render(XSS);
      ok('the panel still draws', x.ran === true, x.threw || '');
      ok('a name carrying a tag does not execute',
         x.xssFired !== true && x.imgs === 0,
         'every value on this panel is client data and goes through _esc');
      ok('and a reference carrying a tag is shown, not applied',
         x.bolds === 0 && /<b>REINV-BOLD<\/b>/.test(x.text || ''),
         (x.text || '').slice(0, 300));
    }
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
