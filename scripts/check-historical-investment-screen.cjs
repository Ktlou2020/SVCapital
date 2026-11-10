#!/usr/bin/env node
/* The Record a Past Investment panel must say what it is about to do.
 *
 * check-historical-investment proves the service: no wallet moves, the
 * settled stamp keeps both nightly jobs off a holding that already paid out.
 * This proves the SCREEN, which is a separate thing, because the preview IS
 * the safety argument. A panel that writes money onto the books by hand and
 * does not show the operator whether the holding counts as settled, or what
 * the optional ledger debit would do, has removed the safeguards and put
 * nothing in their place.
 *
 * As with check-ledger-gap-screen, admin/js/admin.js and js/api.js are loaded
 * WHOLE over HTTP and the markup is lifted verbatim out of admin/index.html.
 * Nothing the renderer reaches for is supplied here — that is how 24 bad
 * `fmt` references once shipped behind a harness that stubbed `fmt` in.
 *
 * Run: node scripts/check-historical-investment-screen.cjs
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

const INDEX = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
const FROM  = INDEX.indexOf('<!-- Record a historical investment -->');
const TO    = INDEX.indexOf('<!-- Ledger gap explained -->');
if (FROM < 0 || TO <= FROM) {
  console.log('  ✗ the Record a Past Investment panel could not be found in admin/index.html');
  process.exit(1);
}
const PANEL = INDEX.slice(FROM, TO);

/* What the route returns for a holding whose maturity has already passed —
   the case the stamp exists for, and the one the operator must be shown. */
const SETTLED = {
  applied: false,
  pool: { id: 'P-ST', name: 'Short Term Investment', productType: 'short_term',
          status: 'matured', annualRate: 0.08, termMonths: 5, maturityDate: '2026-03-01' },
  today: '2026-11-10', ledger: false,
  plan: [{
    where: 'row 1', investorId: 'S-112415', name: 'Puno Stokvel Association',
    subAccountId: null, subAccountName: null, amount: 50000,
    startDate: '2025-10-01', endDate: '2026-03-01', termMonths: 5, annualRate: 0.08,
    productType: 'short_term', expectedReturn: 1666.67, actualReturn: 0,
    status: 'matured', maturityProcessedAt: '2026-03-01', settled: true,
    ledgerRow: false, notes: null, alreadyRecorded: null,
  }],
  refusals: [],
  totals: { records: 1, willWrite: 1, alreadyRecorded: 0, refused: 0,
            amount: 50000, settled: 1, active: 0 },
  willNot: ['debit any wallet', 'charge a platform fee', 'email anybody',
            'require a signed agreement'],
};

const RUNNING = JSON.parse(JSON.stringify(SETTLED));
RUNNING.plan[0].settled = false;
RUNNING.plan[0].status = 'active';
RUNNING.plan[0].maturityProcessedAt = null;
RUNNING.plan[0].endDate = '2027-03-01';
RUNNING.totals.settled = 0; RUNNING.totals.active = 1;

const WITH_LEDGER = JSON.parse(JSON.stringify(SETTLED));
WITH_LEDGER.ledger = true;
WITH_LEDGER.plan[0].ledgerRow = true;

const REFUSED = JSON.parse(JSON.stringify(SETTLED));
REFUSED.plan = [];
REFUSED.refusals = [{ where: 'row 1', investorId: 'S-112415',
  reason: 'The start date 2027-01-01 is in the future — this records what already happened.' }];
REFUSED.totals = { records: 0, willWrite: 0, alreadyRecorded: 0, refused: 1,
                   amount: 0, settled: 0, active: 0 };

const DUPE = JSON.parse(JSON.stringify(SETTLED));
DUPE.plan[0].alreadyRecorded = 'HINV-S-112415-20251001-5000000';
DUPE.totals = { records: 1, willWrite: 0, alreadyRecorded: 1, refused: 0,
                amount: 0, settled: 0, active: 0 };

/* A client name carrying markup — every value on this panel is client data. */
const XSS = JSON.parse(JSON.stringify(SETTLED));
XSS.plan[0].name = '<img src=x onerror="window.__XSS=1">Mandla';

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
      if (u === '/__harness.html') { s.writeHead(200, { 'Content-Type': 'text/html' }); return s.end(HARNESS); }
      const f = path.join(ROOT, u);
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

    async function render(payload) {
      const page = await browser.newPage({ viewport: { width: 1180, height: 1200 } });
      const errors = [];
      const posted = [];
      page.on('pageerror', e => errors.push(String(e.message)));
      await page.addInitScript(() => {
        try {
          const b64 = o => btoa(JSON.stringify(o))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          localStorage.setItem('svc_token',
            b64({ alg: 'HS256', typ: 'JWT' }) + '.' +
            b64({ id: 'u-hi', email: 'hi@chk.test', role: 'admin',
                  exp: Math.floor(Date.now() / 1000) + 86400 }) + '.sig');
          localStorage.setItem('svc_user', JSON.stringify(
            { id: 'u-hi', email: 'hi@chk.test', role: 'admin', first_name: 'Check' }));
        } catch (_) {}
      });
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (url.includes('/api/admin/historical-investments')) {
          posted.push(JSON.parse(route.request().postData() || '{}'));
          return route.fulfill({ status: 200, contentType: 'application/json',
                                 body: JSON.stringify(payload) });
        }
        if (url.includes('/api/')) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' });
        }
        if (url.startsWith(BASE)) return route.continue();
        return route.fulfill({ status: 200,
          contentType: /\.js(\?|$)/.test(url) || url.includes('gtag')
            ? 'application/javascript' : 'text/css', body: '' });
      });
      await page.goto(`${BASE}/__harness.html`, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.previewHistoricalInvestment === 'function',
        { timeout: 15000 }).catch(() => {});
      const out = await page.evaluate(async () => {
        const res = {
          fn: typeof previewHistoricalInvestment === 'function',
          applyFn: typeof applyHistoricalInvestment === 'function',
          fill: typeof _hiFillPickers === 'function',
          panel: !!document.getElementById('hiResult'),
          fields: ['hiPool', 'hiInvestor', 'hiSub', 'hiAmount', 'hiStart', 'hiTerm',
                   'hiEnd', 'hiActual', 'hiLedger', 'hiApplyBtn']
            .every(id => !!document.getElementById(id)),
        };
        if (!res.fn || !res.panel) return res;
        /* The pickers come from STATE, so give it something to fill from. */
        window.STATE = window.STATE || {};
        STATE.pools = [{ id: 'P-ST', name: 'Short Term Investment', status: 'matured' }];
        STATE.investors = [{ id: 'S-112415', first_name: 'Puno', last_name: 'Stokvel' }];
        STATE.subAccounts = [
          { id: 'SA-1', parent_investor_id: 'S-112415', name: 'Burial Society' },
          { id: 'SA-9', parent_investor_id: 'SOMEONE-ELSE', name: 'Not Theirs' },
        ];
        _hiFillPickers();
        res.poolOpts = [...document.getElementById('hiPool').options].map(o => o.value);
        document.getElementById('hiInvestor').value = 'S-112415';
        _hiLoadSubAccounts();
        res.subOpts = [...document.getElementById('hiSub').options].map(o => o.value);

        document.getElementById('hiAmount').value = '50000';
        document.getElementById('hiStart').value = '2025-10-01';
        const btn = document.querySelector('button[onclick="previewHistoricalInvestment(this)"]');
        res.btn = !!btn;
        try { await previewHistoricalInvestment(btn); res.ran = true; }
        catch (e) { res.threw = e.message; }
        const el = document.getElementById('hiResult');
        res.html = el.innerHTML;
        res.text = (el.innerText || '').replace(/\s+/g, ' ');
        res.applyShown = document.getElementById('hiApplyBtn').style.display !== 'none';
        res.xssFired = !!window.__XSS;
        res.imgs = el.querySelectorAll('img').length;
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
          if (getComputedStyle(n).color === painted(n)) res.invisible.push(n.innerText.slice(0, 40));
        });
        return res;
      });
      out.errors = errors;
      out.posted = posted;
      await page.close();
      return out;
    }

    console.log('\nthe panel draws, from the real admin.js');
    const r = await render(SETTLED);
    ok('the markup, the fields and both functions are there',
       r.panel && r.fn && r.applyFn && r.fill && r.fields && r.btn,
       JSON.stringify(r).slice(0, 300));
    ok('it runs without throwing', r.ran === true, r.threw || JSON.stringify(r.errors).slice(0, 300));
    ok('and nothing in the file references a helper that is not there',
       !r.errors.some(e => /is not defined|is not a function/.test(e)),
       JSON.stringify(r.errors).slice(0, 400));

    console.log('\nand it offers only the client\'s OWN sub-accounts');
    ok('the chosen client\'s group is offered',
       (r.subOpts || []).includes('SA-1'), JSON.stringify(r.subOpts));
    ok('and somebody else\'s is not',
       !(r.subOpts || []).includes('SA-9'),
       'recording a group\'s holding against the wrong parent puts its money on a person\'s statement');

    console.log('\nand it previews before it writes');
    ok('the preview posted without apply',
       r.posted.length === 1 && !r.posted[0].apply,
       JSON.stringify(r.posted));
    ok('and sent the amount and date that were typed',
       r.posted[0].records[0].amount === 50000
       && r.posted[0].records[0].startDate === '2025-10-01',
       JSON.stringify(r.posted[0].records[0]));
    ok('Record it appears only once there is something to write', r.applyShown === true);

    console.log('\nand it shows the thing that stops a second payout');
    ok('a settled holding is named as settled', /Recorded as settled/i.test(r.text), r.text.slice(0, 400));
    ok('and says the nightly jobs will not touch it',
       /will not touch it/i.test(r.text), r.text.slice(0, 600));
    /* The sentence that explains WHY, which is the part an operator needs to
       trust the tool rather than just obey it. */
    ok('and says what would happen without it',
       /pay this holding a second time/i.test(r.text), r.text);
    ok('the figures are on it',
       /R.?50.?000,00/.test(r.text) && r.text.includes('2025-10-01') && r.text.includes('2026-03-01'),
       r.text.slice(0, 400));
    ok('and what it will not do is spelled out',
       /debit any wallet/.test(r.text) && /charge a platform fee/.test(r.text)
       && /email anybody/.test(r.text), r.text.slice(-400));
    ok('the return actually paid is called zero, and said to be unknown',
       /zero/i.test(r.text) && /inventing it/i.test(r.text), r.text);
    ok('and nothing rendered as undefined or NaN', !/undefined|NaN/.test(r.text),
       r.text.slice(0, 400));

    console.log('\nand a holding still running is drawn differently');
    {
      const x = await render(RUNNING);
      ok('it is named as running', /Recorded as running/i.test(x.text), x.text.slice(0, 400));
      ok('and NOT as settled', !/Recorded as settled/i.test(x.text), x.text.slice(0, 400));
      ok('and it does not claim the jobs will leave it alone',
         !/will not touch it/i.test(x.text),
         'that promise is only true of a holding carrying the settled stamp');
    }

    console.log('\nand the optional ledger debit is stated either way');
    {
      ok('unticked, it says no row will be written',
         /No ledger row will be written/i.test(r.text), r.text);
      const x = await render(WITH_LEDGER);
      ok('ticked, it says the debit will be written and dated to the start',
         /investment debit/i.test(x.text) && /2025-10-01/.test(x.text), x.text);
      ok('and still promises no wallet balance changes',
         /No wallet balance changes/i.test(x.text), x.text);
    }

    console.log('\nand the two ways there is nothing to do do not read alike');
    {
      const ref = await render(REFUSED);
      ok('a refusal is shown with its reason',
         /Cannot be recorded/i.test(ref.text) && /in the future/i.test(ref.text), ref.text);
      ok('and Record it stays hidden', ref.applyShown === false, String(ref.applyShown));
      const dup = await render(DUPE);
      ok('an already-recorded holding says so', /Already recorded/i.test(dup.text), dup.text);
      ok('and also hides Record it, so it cannot be written twice',
         dup.applyShown === false, String(dup.applyShown));
      ok('and the two read differently',
         ref.text !== dup.text && !/Cannot be recorded/i.test(dup.text),
         `${ref.text}\n      vs\n      ${dup.text}`);
    }

    console.log('\nand every colour it uses is one the console defines');
    {
      const used = [...new Set((r.html.match(/var\(--([a-z-]+)\)/g) || []).map(s => s.slice(6, -1)))];
      const css = ['admin.css', 'admin-premium.css', 'admin-v2.css']
        .map(f => { try { return fs.readFileSync(path.join(ROOT, 'css', f), 'utf8'); }
                    catch (_) { return ''; } }).join('\n');
      const undef = used.filter(v => !new RegExp('--' + v + '\\s*:').test(css));
      ok('no undefined custom property is referenced', undef.length === 0,
         `undefined: ${undef.join(', ')} — used: ${used.join(', ')}`);
      ok('and it does reference some, so this is not passing on an empty set',
         used.length >= 2, used.join(', '));
    }

    console.log('\nand no text is the same colour as what is behind it');
    ok('every line is legible against its own background',
       r.invisible.length === 0, JSON.stringify(r.invisible.slice(0, 5)));

    console.log('\nand a client\'s own text is never markup');
    {
      const x = await render(XSS);
      ok('the panel still draws', x.ran === true, x.threw || '');
      ok('a name carrying a tag does not execute',
         x.xssFired !== true && x.imgs === 0,
         'every value on this panel is client data and goes through _esc');
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
