#!/usr/bin/env node
/* Which pool an investment is in must show, and a dialog must say what it
 * will do.
 *
 * Reported: "the pool is not showing for this investment" — a row with a
 * product, an amount and a maturity, and a bare dash under Pool.
 *
 * investments carries BOTH pool_id, the real link, and pool_name, a
 * denormalised copy the schema calls legacy. Either can be null and they can
 * disagree. The server already handles that — all-investments matches
 * `i.pool_id = $1 OR (i.pool_name = ip.name AND i.pool_id IS NULL)`. The
 * client read pool_name ALONE, so an investment properly linked by pool_id
 * with no name copied onto it rendered as a dash, which reads as a broken
 * screen rather than as a fact.
 *
 * Two more on the same screen, found while fixing it:
 *
 *   the cancel-and-refund dialog interpolated inv.pool_name, so it read
 *   "cancel the investment of R717,12 in undefined" — on the one screen
 *   where somebody confirms something irreversible
 *
 *   every Confirm.ask caller that passed `confirmClass` was passing an
 *   option Confirm.ask does not accept. It takes `danger`. Three
 *   destructive confirmations were therefore showing a primary button
 *   instead of a red one, silently, and nothing could have told them
 *
 * admin/js/admin.js and js/api.js are loaded WHOLE, over HTTP, the way the
 * browser loads them.
 *
 * Run: node scripts/check-pool-label.cjs
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

/* ── The half that needs no browser ──────────────────────────────────── */
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SRC = strip(ADMIN);

console.log('\nevery Confirm.ask option is one Confirm.ask reads');
{
  /* The signature, read from the object itself rather than typed out here,
     so adding an option to Confirm cannot make this check wrong. */
  const sig = SRC.match(/ask\(title,\s*\{([^}]*)\}\s*=\s*\{\}\s*\)/);
  ok('the signature was found', !!sig, 'a changed signature should fail loudly, not silently pass');
  const accepted = new Set((sig ? sig[1] : '')
    .split(',').map(s => s.trim().split('=')[0].trim()).filter(Boolean));
  ok('and it lists the options it takes', accepted.size >= 3,
     [...accepted].join(', '));

  /* Every key passed to a Confirm.ask call.

     Found by balancing braces from the call's options object, not by a
     lazy regex to the next "})". The lazy version swallowed whole unrelated
     object literals further down the file and reported fifty keys that no
     Confirm.ask has ever been passed — an assertion failing for a reason
     that has nothing to do with what it is about is as useless as one that
     cannot fail. */
  const passed = new Set();
  for (const m of SRC.matchAll(/Confirm\.ask\(/g)) {
    /* Step to the options object: past the title argument, to its comma. */
    let i = m.index + m[0].length, depth = 0;
    for (; i < SRC.length; i++) {
      const c = SRC[i];
      if ('([{`'.includes(c)) depth++;
      else if (')]}`'.includes(c)) { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) { i++; break; }
    }
    while (i < SRC.length && /\s/.test(SRC[i])) i++;
    if (SRC[i] !== '{') continue;
    /* Balance to the matching close, and read only the keys at depth 1. */
    let d = 0, end = i;
    for (; end < SRC.length; end++) {
      if (SRC[end] === '{') d++;
      else if (SRC[end] === '}') { d--; if (!d) break; }
    }
    const obj = SRC.slice(i + 1, end);
    /* A backtick both opens and closes, so it cannot be counted like a
       bracket — the first version did, never came back to depth 0, and read
       prose inside a template literal as option names. Strings and template
       literals are skipped outright instead. */
    let dd = 0, quote = null;
    for (let j = 0; j < obj.length; j++) {
      const c = obj[j];
      if (quote) {
        if (c === '\\') { j++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '`' || c === '"' || c === "'") { quote = c; continue; }
      if ('({['.includes(c)) { dd++; continue; }
      if (')}]'.includes(c)) { dd--; continue; }
      if (dd !== 0) continue;
      const k = /^([A-Za-z_$][\w$]*)\s*:/.exec(obj.slice(j));
      if (k && (j === 0 || /[\s,]/.test(obj[j - 1]))) { passed.add(k[1]); j += k[0].length - 1; }
    }
  }
  ok('and callers pass some', passed.size > 0, [...passed].join(', '));
  const unknown = [...passed].filter(k => !accepted.has(k));
  ok('NO CALLER PASSES AN OPTION THAT IS IGNORED',
     unknown.length === 0,
     `${unknown.join(', ')} — confirmClass was passed on four calls and read by `
     + 'none of them, so three destructive dialogs showed a primary button');
  /* The specific one, named, so it cannot drift back. */
  ok('confirmClass in particular is gone', !/confirmClass/.test(SRC),
     'Confirm.ask takes `danger`');
  ok('and the destructive dialogs now say so',
     (SRC.match(/danger: true/g) || []).length >= 15,
     String((SRC.match(/danger: true/g) || []).length));
}

console.log('\nand every screen that shows a pool goes through the helper');
{
  /* Testing _poolLabel in isolation proves the helper. It does NOT prove the
     table uses it, and the table is what was reported — a mutation putting
     `${_esc(i.pool_name)||'—'}` back in the cell passed every other
     assertion in this file. */
     /* Scoped to INVESTMENT rows — i and inv. maturity_instructions also
        carries a pool_name, and deliberately reads it alone: that table has
        no pool_id column at all, so there is nothing to fall through to and
        the copied name is the only answer it has. (It does carry an
        investment_id, so it could resolve through the investment; that is a
        different change from the one reported and is not made here.) */
  const bare = [];
  for (const m of SRC.matchAll(/\$\{_esc\((i|inv)\.pool_name[^}]*\}/g)) {
    bare.push(SRC.slice(Math.max(0, m.index - 60), m.index + m[0].length).replace(/\s+/g, ' '));
  }
  ok('NO INVESTMENT SCREEN READS pool_name ON ITS OWN',
     bare.length === 0,
     bare.join('\n      ') + ' — on an investment, pool_name is a denormalised '
     + 'copy that can be null while pool_id is set; that is the reported bug');

  /* And the investments table in particular, by name. */
  const at = SRC.indexOf('<th style="min-width:160px">Pool</th>');
  ok('the investments table was found', at > 0,
     'a slice that missed it would assert nothing while passing');
  const table = SRC.slice(at, at + 2000);
  ok('its Pool cell goes through the helper',
     /_poolCell\(i\)/.test(table), table.slice(0, 400));
}

console.log('\nand the cancel dialog names the pool, as markup not as text');
{
  const at = SRC.indexOf('async function cancelInvestment(');
  const body = SRC.slice(at, at + 1200);
  ok('the dialog was found', at > 0);
  ok('it resolves the pool rather than reading the copied name',
     /_poolCell\(inv\)/.test(body) && !/_esc\(inv\.pool_name\)/.test(body),
     body.slice(0, 300));
  /* Confirm.ask puts `body` in as textContent, so HTML passed there is shown
     literally. This was the only caller in the file doing it. */
  ok('and passes its markup as bodyHtml, which is the field that renders it',
     /bodyHtml:/.test(body) && !/\n\s*body: `This will cancel/.test(body),
     body.slice(0, 300));
  ok('no Confirm.ask in the file passes markup to the text field',
     !/body: `[^`]*<(strong|em|br|span|div)\b/.test(SRC),
     'body is textContent — tags passed there are shown to the operator verbatim');
}

if (!CHROME) {
  console.log('\n  SKIP  no headless Chromium — the rendered half did not run');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* ── The rendered half ───────────────────────────────────────────────── */
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/admin.css">
</head><body>
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
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message)));
    await page.addInitScript(() => {
      try {
        const b64 = o => btoa(JSON.stringify(o))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        localStorage.setItem('svc_token',
          b64({ alg: 'HS256', typ: 'JWT' }) + '.' +
          b64({ id: 'u', email: 'e@x.t', role: 'admin',
                exp: Math.floor(Date.now() / 1000) + 86400 }) + '.sig');
      } catch (_) {}
    });
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.includes('/api/')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' });
      }
      if (url.startsWith(BASE)) return route.continue();
      return route.fulfill({ status: 200,
        contentType: /\.js(\?|$)/.test(url) ? 'application/javascript' : 'text/css', body: '' });
    });
    await page.goto(`${BASE}/__harness.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window._poolLabel === 'function',
      { timeout: 15000 }).catch(() => {});

    const r = await page.evaluate(() => {
      const out = { fn: typeof _poolLabel === 'function', cellFn: typeof _poolCell === 'function' };
      if (!out.fn) return out;
      window.STATE = window.STATE || {};
      STATE.pools = [{ id: 'P-1', name: 'Cattle Investment April 2026', status: 'open' }];
      /* THE REPORTED ROW: linked by pool_id, with no name copied onto it. */
      out.byId      = _poolLabel({ pool_id: 'P-1' });
      out.byIdCell  = _poolCell({ pool_id: 'P-1' });
      /* The copied name still wins when it is there — it is what the row was
         filed under, and the pool may since have been renamed. */
      out.byName    = _poolLabel({ pool_name: 'As Filed', pool_id: 'P-1' });
      /* A pool_id pointing at a pool this screen has not loaded: the id is
         still more use than a dash. */
      out.unknownId = _poolLabel({ pool_id: 'P-GONE' });
      /* Genuinely in no pool. */
      out.none      = _poolLabel({});
      out.noneCell  = _poolCell({});
      out.blankName = _poolLabel({ pool_name: '   ', pool_id: 'P-1' });
      /* Client data reaches this cell. */
      out.xssCell   = _poolCell({ pool_name: '<img src=x onerror="window.__x=1">Pool' });
      document.body.innerHTML = out.xssCell;
      out.xssFired  = !!window.__x;
      out.imgs      = document.querySelectorAll('img').length;
      return out;
    });

    console.log('\nand the pool shows however the investment is linked to it');
    ok('the helper is there', r.fn && r.cellFn, JSON.stringify(r).slice(0, 200));
    ok('THE REPORTED ROW RESOLVES: linked by id, no name copied on it',
       r.byId === 'Cattle Investment April 2026',
       `${r.byId} — this is the row that showed a bare dash`);
    ok('and the cell draws the name, not a dash',
       /Cattle Investment April 2026/.test(r.byIdCell || '') && !/—/.test(r.byIdCell || ''),
       r.byIdCell);
    ok('a copied name still wins, since it is what the row was filed under',
       r.byName === 'As Filed', String(r.byName));
    ok('a blank copied name falls through to the real one',
       r.blankName === 'Cattle Investment April 2026', String(r.blankName));
    ok('an id this screen cannot resolve still shows the id',
       r.unknownId === 'P-GONE',
       `${r.unknownId} — an id is more use than a dash when chasing it down`);

    console.log('\nand an investment in no pool says so, rather than showing a dash');
    ok('the label is null, which is the only honest answer', r.none === null, String(r.none));
    ok('and the cell says "Not in a pool"',
       /Not in a pool/.test(r.noneCell || ''), r.noneCell);
    ok('rather than a dash, which reads as a broken screen',
       !/^—$|>—</.test(r.noneCell || ''), r.noneCell);

    console.log('\nand a pool name is never markup');
    ok('a name carrying a tag does not execute',
       r.xssFired !== true && r.imgs === 0, JSON.stringify({ x: r.xssFired, i: r.imgs }));
    ok('and nothing threw loading the file whole',
       !errors.some(e => /is not defined|is not a function/.test(e)),
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
