#!/usr/bin/env node
/* The menu bar fits in the bar, or it is a drawer.
 *
 * The main site's nav is a nowrap flex row — nine links and two buttons —
 * and the drawer took over only below 768px. Nothing anywhere said what the
 * row costs, so nobody noticed when it outgrew the space: measured in
 * Chromium the row wanted 892px and had 766px at 1024, running past the
 * container's inner edge from about 1050px down. On every laptop between
 * 769px and 1050px the right-hand end of the menu — "Sign In" and "Get
 * Started", the two things the whole page is for — was clipped, with no
 * scrollbar to hint that anything was missing. It had been like that for a
 * while; adding the two audience links simply made it start 50px sooner.
 *
 * The fix was to hand the band below 1180px to the drawer, which takes any
 * number of items. But a breakpoint is a number somebody chose, and the
 * next link added to the menu invalidates it silently in exactly the same
 * way. So this does not check the number. It walks the widths, and at each
 * one asks the only question that matters: is the menu readable here —
 * either the bar fits, or the drawer has it.
 *
 * Run: node server/scripts/check-nav-fits.cjs
 */
'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('\nthe drawer exists and is not a phone-only idea');
{
  const CSS = read('css/style.css');
  const m = CSS.match(/@media \(max-width: (\d+)px\) \{\s*(?:\/\*[\s\S]*?\*\/\s*)?\.nav-overlay \{/);
  ok('the drawer rules sit in their own breakpoint', !!m, 'not found');
  ok('and it is not the phone breakpoint',
     m && Number(m[1]) > 900, m ? `${m[1]}px` : '—',
     'a bar of eleven items does not fit a laptop, never mind a tablet');
  ok('the hamburger is hidden above it',
     /\.nav-mobile-toggle \{\s*display: none/.test(CSS));
}

/* ── Measured ───────────────────────────────────────────────────── */
const CHROME = (() => {
  const base = '/opt/pw-browsers';
  const link = path.join(base, 'chromium');
  if (fs.existsSync(link)) return link;
  if (!fs.existsSync(base)) return null;
  for (const dir of fs.readdirSync(base)
        .filter(d => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
    for (const inner of ['chrome-linux64', 'chrome-linux']) {
      const bin = path.join(base, dir, inner, 'chrome');
      if (fs.existsSync(bin)) return bin;
    }
  }
  return null;
})();

if (!CHROME) {
  console.log('\n  SKIP  no chromium under /opt/pw-browsers — the measured half did not run');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
               '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon' };
const devtools = (port, p) => new Promise((res, rej) =>
  http.get({ host: '127.0.0.1', port, path: p }, r => {
    let s = ''; r.on('data', c => s += c); r.on('end', () => res(JSON.parse(s)));
  }).on('error', rej));

/* A sweep, not a shortlist. The first draft of this check listed the widths
   real laptops report — 1536, 1440, 1366, 1280, 1024 — and a deliberately
   broken breakpoint of 1100px passed it clean, because the band it left
   clipped was 1101 to 1149 and nothing on the list fell inside. A gap
   between two sampled widths is a gap a breakpoint can hide in, so this
   walks every 10px across the whole range the bar and the drawer trade in,
   and keeps the common device widths on top of that. Laying out again at a
   new width needs no reload, so the sweep is cheap. */
const WIDTHS = (() => {
  const w = new Set([1920, 1680, 1600, 1536, 1440, 1366, 1280, 1024, 912, 820, 800, 768, 744]);
  for (let x = 1500; x >= 700; x -= 10) w.add(x);
  return [...w].sort((a, b) => b - a);
})();

(async () => {
  const site = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${site.address().port}`;

  const port = 9453;
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`,
    '--no-sandbox', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  const stop = () => { try { proc.kill(); } catch (_) {} site.close(); };

  try {
    /* Thirty seconds, not ten. Four checks in this suite each start their
       own Chromium, and under that the browser has taken more than ten
       seconds to answer devtools — which failed the check with "the browser
       never answered" on a run where nothing was wrong with the page. A
       check that fails on a slow afternoon is a check people learn to
       re-run rather than read. If the process has actually died, say so:
       that is a different problem from a slow start and wants a different
       answer. */
    let tabs;
    const startedAt = Date.now();
    for (let i = 0; i < 60 && !tabs; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { tabs = await devtools(port, '/json/list'); } catch (_) {}
      if (proc.exitCode !== null) break;
    }
    if (!tabs) {
      ok('the browser started', false,
         proc.exitCode !== null
           ? `chromium exited with code ${proc.exitCode} after ${Date.now() - startedAt}ms`
           : `devtools never answered in ${Date.now() - startedAt}ms`);
      stop(); return;
    }

    const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const pending = new Map();
    ws.onmessage = ev => { const d = JSON.parse(ev.data);
      if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params) => new Promise(r => {
      const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

    await send('Page.enable');
    await send('Runtime.enable');
    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', { returnByValue: true, expression: expr });
      if (r.result && r.result.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails.exception || {}));
      }
      return r.result.result.value;
    };
    const goto = async url => {
      await send('Page.navigate', { url });
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 150));
        if (await evaluate('document.readyState') === 'complete') break;
      }
      await new Promise(r => setTimeout(r, 350));
    };

    /* The chooser puts an overlay over the page on a first visit, which is
       not what is being measured here. */
    await goto(BASE + '/index.html');
    await evaluate(`try { localStorage.setItem('svc_audience', 'retail'); } catch (_) {}`);

    /* The baseline: every item's height with room to spare. A label that
       takes a second line is taller than this, whatever the font, whatever
       the label and whatever the padding on that particular item — which is
       why the comparison is each item against ITSELF rather than against a
       line-height anybody has to keep in step. */
    await send('Emulation.setDeviceMetricsOverride',
      { width: 1800, height: 900, deviceScaleFactor: 1, mobile: false });
    await new Promise(r => setTimeout(r, 400));
    const BASELINE = await evaluate(`(() => {
      const ul = document.querySelector('.nav-links');
      return [...ul.children].map(li => Math.round(li.getBoundingClientRect().height));
    })()`);

    const MEASURE = `(() => {
      const ul = document.querySelector('.nav-links');
      const cont = document.querySelector('.nav-container');
      const tog = document.querySelector('.nav-mobile-toggle');
      const cs = getComputedStyle(ul);
      /* The drawer is the off-canvas panel: fixed, parked at right:-100%.
         When it has the band, the only thing that has to be true is that
         the hamburger that opens it is on screen. */
      if (cs.position === 'fixed') {
        return { mode: 'drawer', toggle: getComputedStyle(tog).display,
                 togW: Math.round(tog.getBoundingClientRect().width) };
      }
      const cr = cont.getBoundingClientRect();
      const inner = cr.right - parseFloat(getComputedStyle(cont).paddingRight);
      const items = [...ul.children].filter(li => getComputedStyle(li).display !== 'none');
      const right = Math.max(...items.map(li => li.getBoundingClientRect().right));
      const brand = cont.firstElementChild.getBoundingClientRect();
      const left = Math.min(...items.map(li => li.getBoundingClientRect().left));
      /* Taller than it was with room to spare means the label inside it has
         wrapped. This is the fault a row-overflow measurement cannot see:
         the items are flex children, so when the row runs short they shrink
         below their content and mangle the text instead of overflowing. The
         row stays inside its container the whole time and reads as fine. */
      const base = ${JSON.stringify(BASELINE)};
      const squashed = items.map((li, n) =>
          Math.round(li.getBoundingClientRect().height) > (base[n] || 0) + 2
            ? li.textContent.trim().replace(/\\s+/g, ' ') : null)
        .filter(Boolean);
      return { mode: 'bar', items: items.length, past: Math.round(right - inner),
               clearOfBrand: Math.round(left - brand.right),
               /* The row is right-aligned against the container, so the gap
                  at its right edge is always zero. The room the bar has
                  left is the space between the logo and the first item. */
               slack: Math.round(left - brand.right),
               squashed };
    })()`;

    console.log('\nat every width, the menu is readable');
    const clipped = [], noToggle = [], collided = [], squashedAt = [];
    let barAt = 0, drawerAt = 0, tightest = Infinity, tightestAt = 0;
    for (const w of WIDTHS) {
      await send('Emulation.setDeviceMetricsOverride',
        { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 768 });
      await new Promise(r => setTimeout(r, 90));
      const r = await evaluate(MEASURE);
      if (r.mode === 'bar') {
        barAt++;
        if (r.past > 0) clipped.push(`${w}px: ${r.past}px past the edge`);
        if (r.clearOfBrand < 0) collided.push(`${w}px: overlaps the logo by ${-r.clearOfBrand}px`);
        if (r.squashed.length) squashedAt.push(`${w}px: ${r.squashed.join(' / ')}`);
        if (r.slack < tightest) { tightest = r.slack; tightestAt = w; }  // narrowest bar wins
      } else {
        drawerAt++;
        if (r.toggle === 'none' || r.togW < 36) noToggle.push(`${w}px: ${r.toggle} / ${r.togW}px`);
      }
    }
    ok('no menu item is ever clipped at the right', clipped.length === 0, clipped.join('; '));
    ok('and no label is ever squashed onto a second line',
       squashedAt.length === 0, squashedAt.slice(0, 3).join('; '),
       'the items are flex children: short of room they shrink below their content and '
       + 'wrap the text, and the row never overflows, so overflow alone sees nothing wrong');
    ok('the bar keeps real slack where it is shown',
       tightest >= 40, `${tightest}px at ${tightestAt}px wide`,
       'a bar that only just fits is a bar that the next label breaks');
    ok('and the menu never runs back over the logo', collided.length === 0, collided.join('; '));
    ok('wherever the drawer has the band, the hamburger is on screen and tappable',
       noToggle.length === 0, noToggle.join('; '));
    ok('both layouts are actually exercised', barAt > 0 && drawerAt > 0,
       `bar at ${barAt} widths, drawer at ${drawerAt}`);

    console.log('\nand the drawer opens');
    await send('Emulation.setDeviceMetricsOverride',
      { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await goto(BASE + '/index.html');
    await evaluate(`document.querySelector('.nav-mobile-toggle').click()`);
    /* It slides in over 0.3s; measured on the same tick it is still parked
       off-screen and the assertion fails for the wrong reason. */
    await new Promise(r => setTimeout(r, 600));
    const opened = await evaluate(`(() => {
      const ul = document.querySelector('.nav-links');
      const r = ul.getBoundingClientRect();
      return { onScreen: r.right <= document.documentElement.clientWidth + 1 && r.left >= -1,
               open: ul.classList.contains('open'),
               items: [...ul.children].filter(li => li.getBoundingClientRect().width > 0).length };
    })()`);
    ok('tapping it brings the menu on screen', opened.open && opened.onScreen, JSON.stringify(opened));
    ok('with every item in it', opened.items >= 10, String(opened.items));
    ok('including the two audience pages',
       await evaluate(`!!document.querySelector('.nav-links a[href="private-clients.html"]')
                       && !!document.querySelector('.nav-links a[href="institutional.html"]')`));

    ws.close();
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    stop();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
