#!/usr/bin/env node
/* Every pool must be offerable as a destination, and findable.
 *
 * Reported: "I am unable to see all the pools here, also make it easier to
 * search." Both halves were real, and the first was not a display limit.
 *
 * openMoveInvestment filtered the list to pools whose status was open,
 * filling or active. A matured or closed pool could not be chosen AT ALL,
 * and nothing on the screen said why it was missing. Moving an investment is
 * almost always correcting where it always belonged, and the pool it belongs
 * in is as likely as not to have matured since — so the one move somebody
 * needed was the one the modal refused, silently.
 *
 * It also refetched the pool list only when the FILTERED list came back
 * empty, so a STATE.pools loaded elsewhere with a smaller limit capped what
 * could be chosen and looked exactly like those pools not existing.
 *
 * The answer to "a live investment should not go into a pool that has paid
 * out" is to ASK, not to make the right move impossible. So every pool is
 * offered, the ones taking new money come first, the status is on every
 * label, and the confirm step asks before moving into one of the others.
 *
 * admin/js/admin.js and js/api.js are loaded WHOLE over HTTP, as the browser
 * loads them. Nothing the modal reaches for is supplied here.
 *
 * Run: node scripts/check-move-investment-pools.cjs
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
  console.log('  SKIP  no headless Chromium — the modal was not rendered');
  process.exit(0);
}

/* The shape from the screenshot: a book with far more matured and closed
   pools than open ones, which is what an established fund looks like. */
const POOLS = [
  { id: 'P-OPEN-1',  name: 'Cattle Investment April 2026',   status: 'open',    product_type: 'cattle' },
  { id: 'P-FILL-1',  name: 'Elite Fleet Investment',          status: 'filling', product_type: 'delivery_bike' },
  { id: 'P-ACT-1',   name: 'Short Term Investment',           status: 'active',  product_type: 'short_term' },
  { id: 'P-MAT-1',   name: 'Cattle Investment April 2025',    status: 'matured', product_type: 'cattle' },
  { id: 'P-MAT-2',   name: 'Solar Investment 7 Years',        status: 'matured', product_type: 'solar' },
  { id: 'P-CLOSED-1',name: 'Delivery Bike November 2025',     status: 'closed',  product_type: 'delivery_bike' },
  { id: 'P-CURRENT', name: 'The One It Is In',                status: 'open',    product_type: 'cattle' },
];

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/admin.css">
<link rel="stylesheet" href="/css/admin-premium.css">
<link rel="stylesheet" href="/css/admin-v2.css">
</head><body>
<div class="view active" id="view-investments" style="padding:24px"></div>
<script>window.StaffAuth={guard:()=>true,injectWidget(){},logout(){},setSession(){},clearSession(){}};<\/script>
<script src="/js/api.js"><\/script>
<script src="/admin/js/admin.js"><\/script>
</body></html>`;

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
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message)));
    await page.addInitScript(() => {
      try {
        const b64 = o => btoa(JSON.stringify(o))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        localStorage.setItem('svc_token',
          b64({ alg: 'HS256', typ: 'JWT' }) + '.' +
          b64({ id: 'u-mv', email: 'mv@chk.test', role: 'admin',
                exp: Math.floor(Date.now() / 1000) + 86400 }) + '.sig');
        localStorage.setItem('svc_user', JSON.stringify(
          { id: 'u-mv', email: 'mv@chk.test', role: 'admin' }));
      } catch (_) {}
    });
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.includes('/api/')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' });
      }
      if (url.startsWith(BASE)) return route.continue();
      return route.fulfill({ status: 200,
        contentType: /\.js(\?|$)/.test(url) || url.includes('gtag')
          ? 'application/javascript' : 'text/css', body: '' });
    });
    await page.goto(`${BASE}/__harness.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.openMoveInvestment === 'function',
      { timeout: 15000 }).catch(() => {});

    const r = await page.evaluate(async (pools) => {
      const res = { fn: typeof openMoveInvestment === 'function',
                    filterFn: typeof _moveFilterPools === 'function',
                    paintFn: typeof _pickerPaint === 'function' };
      if (!res.fn) return res;
      /* API is a top-level const in js/api.js — assigning window.API makes a
         different object that admin.js never reads. Mutate the real one. */
      let askedLimit = null;
      API.pools = API.pools || {};
      API.pools.list = async opts => { askedLimit = opts && opts.limit; return { data: pools }; };
      /* STATE deliberately pre-loaded with ONLY the open pools, the way a
         smaller limit elsewhere would leave it. The modal must not take that
         as the whole book. */
      window.STATE = window.STATE || {};
      STATE.pools = pools.filter(p => p.status === 'open');

      await openMoveInvestment('INV-1', 'P-CURRENT');
      res.askedLimit = askedLimit;
      const sel = () => document.getElementById('movePoolSelect');
      const opts = () => [...sel().options].map(o => ({ v: o.value, t: o.textContent.trim() }));
      res.all = opts();
      res.count = document.getElementById('movePoolCount').textContent;
      res.hasSearch = !!document.getElementById('movePoolSearch');

      const type = v => {
        const el = document.getElementById('movePoolSearch');
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      type('solar');        res.bySolar  = opts().map(o => o.v);
      type('matured');      res.byStatus = opts().map(o => o.v);
      type('P-CLOSED-1');   res.byId     = opts().map(o => o.v);
      type('zzzz');         res.noMatch  = opts().map(o => o.v);
      res.noMatchCount = document.getElementById('movePoolCount').textContent;

      /* The rule the shared picker exists for. */
      type('');
      sel().value = 'P-MAT-2';
      type('cattle');
      res.keptValue = sel().value;
      res.keptCount = document.getElementById('movePoolCount').textContent;
      type('');
      return res;
    }, POOLS);

    console.log('\nthe modal draws, from the real admin.js');
    ok('it opens and brings the shared picker with it',
       r.fn && r.filterFn && r.paintFn, JSON.stringify(r).slice(0, 200));
    ok('and nothing in the file references a helper that is not there',
       !errors.some(e => /is not defined|is not a function/.test(e)),
       JSON.stringify(errors).slice(0, 300));

    console.log('\nand EVERY pool is offered, not just the open ones');
    const ids = (r.all || []).map(o => o.v);
    ok('the matured pools are there', ids.includes('P-MAT-1') && ids.includes('P-MAT-2'),
       JSON.stringify(ids) + ' — a correction usually points at one of these');
    ok('and the closed one', ids.includes('P-CLOSED-1'), JSON.stringify(ids));
    ok('and the open ones', ['P-OPEN-1', 'P-FILL-1', 'P-ACT-1'].every(i => ids.includes(i)),
       JSON.stringify(ids));
    ok('the pool it is already in is NOT offered', !ids.includes('P-CURRENT'),
       'moving it to where it already is does nothing');
    /* First, because that is where most moves go. */
    const firstReal = (r.all || []).filter(o => o.v)[0];
    ok('a pool that takes new money is listed first',
       firstReal && ['P-OPEN-1', 'P-FILL-1', 'P-ACT-1'].includes(firstReal.v),
       JSON.stringify(firstReal));
    /* Offered is not the same as unmarked. */
    ok('and every label says what the pool is',
       (r.all || []).filter(o => o.v).every(o => /· (open|filling|active|matured|closed)$/.test(o.t)),
       JSON.stringify((r.all || []).map(o => o.t)));

    console.log('\nand the whole book is fetched, not whatever was lying around');
    ok('it asks for the pools afresh', r.askedLimit >= 1000, String(r.askedLimit));
    /* ids carries the "— choose a pool —" placeholder, which is not a pool. */
    const realIds = ids.filter(Boolean);
    ok('so a partly-loaded STATE does not cap the list',
       realIds.length === POOLS.length - 1,
       `${realIds.length} offered from a STATE that held only `
       + `${POOLS.filter(p => p.status === 'open').length}, of ${POOLS.length - 1} movable`);

    console.log('\nand it is searchable');
    ok('there is a search box', r.hasSearch === true);
    ok('by name', JSON.stringify(r.bySolar) === JSON.stringify(['', 'P-MAT-2']),
       JSON.stringify(r.bySolar));
    ok('by status, which is how you find the matured ones',
       (r.byStatus || []).includes('P-MAT-1') && (r.byStatus || []).includes('P-MAT-2')
       && !(r.byStatus || []).includes('P-OPEN-1'), JSON.stringify(r.byStatus));
    ok('and by id', JSON.stringify(r.byId) === JSON.stringify(['', 'P-CLOSED-1']),
       JSON.stringify(r.byId));
    ok('a search matching nothing says so rather than going blank',
       JSON.stringify(r.noMatch) === JSON.stringify(['']) && /No pools match/.test(r.noMatchCount || ''),
       JSON.stringify({ o: r.noMatch, c: r.noMatchCount }));
    ok('and the count says how many of how many', /\d+ of \d+|\d+ pools/.test(r.count || ''), r.count);

    console.log('\nand a pool already chosen survives a search that excludes it');
    ok('THE CHOICE IS NOT SILENTLY LOST',
       r.keptValue === 'P-MAT-2',
       `${r.keptValue} — this modal moves an investment; filtering must never change which pool it moves to`);
    ok('and the count says it is being held there',
       /keeping the one you chose/.test(r.keptCount || ''), r.keptCount);

    /* ── Driven, not grepped ────────────────────────────────────────
       These assertions were a source scan for Confirm.ask and the early
       return. Changing the condition to `if (false)` left both strings in
       the file and the scan passed while the guard was gone — a check that
       reads the source cannot tell whether the source RUNS. So the confirm
       step is called, with a matured pool chosen and with an open one, and
       what is asserted is whether the PATCH happened. */
    const guard = await page.evaluate(async (pools) => {
      const out = { patched: [], asked: [] };
      API._fetch = async (m, p, body) => { out.patched.push({ m, p, body }); return { data: {} }; };
      Confirm.ask = async (title) => { out.asked.push(String(title)); return out._answer; };
      Toast.error = () => {}; Toast.success = () => {};
      window._currentPoolId = null; window._currentInvestorId = null;
      STATE.pools = pools;

      const pick = id => {
        const s = document.getElementById('movePoolSelect');
        s.value = id;
        if (s.value !== id) { /* not offered at all */ }
      };

      /* A matured pool, and the answer is no. */
      out._answer = false;
      pick('P-MAT-2');
      await _confirmMoveInvestment('INV-1');
      out.saidNo = { asked: out.asked.length, patched: out.patched.length };

      /* The same, and the answer is yes. */
      out.asked = []; out.patched = [];
      out._answer = true;
      pick('P-MAT-2');
      await _confirmMoveInvestment('INV-1');
      out.saidYes = { asked: out.asked.length, patched: out.patched.length,
                      to: (out.patched[0] && out.patched[0].body || {}).pool_id };

      /* An open pool must not be asked about at all. */
      out.asked = []; out.patched = [];
      out._answer = true;
      pick('P-OPEN-1');
      await _confirmMoveInvestment('INV-1');
      out.openPool = { asked: out.asked.length, patched: out.patched.length };
      return out;
    }, POOLS);

    console.log('\nand moving into a pool that has paid out is asked about, not refused');
    ok('a matured destination is asked about',
       guard.saidNo.asked === 1, JSON.stringify(guard.saidNo));
    ok('AND NOTHING MOVES IF THE ANSWER IS NO',
       guard.saidNo.patched === 0,
       JSON.stringify(guard.saidNo) + ' — the guard has to actually stop it');
    ok('but it does move if the answer is yes',
       guard.saidYes.patched === 1 && guard.saidYes.to === 'P-MAT-2',
       JSON.stringify(guard.saidYes) + ' — refusing the move outright is the bug this fixed');
    ok('and a pool still taking money is not asked about at all',
       guard.openPool.asked === 0 && guard.openPool.patched === 1,
       JSON.stringify(guard.openPool) + ' — a prompt on every move teaches people to dismiss it');

    /* The old behaviour, named so it cannot come back by accident. */
    ok('and the list itself no longer filters those pools out',
       !/const eligible = \(STATE\.pools \|\| \[\]\)\.filter/
         .test(fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8')),
       'hiding them is what made the one move somebody needed impossible');
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
