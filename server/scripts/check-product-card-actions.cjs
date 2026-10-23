#!/usr/bin/env node
/* A card's buttons stay inside the card.
 *
 * The actions row was `grid-template-columns: 1fr 1fr`, and a 1fr track will
 * not shrink below its content. The buttons are white-space: nowrap, so the
 * row kept its full 328px however narrow the card got, and the card's
 * overflow: hidden cut the second button off at the edge.
 *
 * The media query that stacked them under 768px asked the wrong question. The
 * products grid puts three cards in a row on a desktop, so a card is at its
 * NARROWEST while the viewport is at its widest: measured in Chromium, the
 * card gave the buttons 302px at a 1280px viewport, 243px at 1024px and 308px
 * at 820px — clipped by 25px, 84px and 19px, and not clipped at all on a
 * phone, which is where anyone would have looked.
 *
 * So this measures rather than asserts a string. A rule about overflow cannot
 * be checked by grepping for the rule: what matters is where the button ends
 * up, and only a layout engine knows that. The static half is kept as the
 * cheap first word, and the measured half is skipped — loudly — when there is
 * no browser to measure with.
 *
 * Run: node server/scripts/check-product-card-actions.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

console.log('\nthe row stacks on the space it has, not on the viewport');
{
  const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
  const i = css.indexOf('.product-card__actions {');
  const rule = i === -1 ? '' : css.slice(i, css.indexOf('}', i));
  ok('the actions row exists', !!rule);
  ok('it is not two fixed tracks',
     !/grid-template-columns:\s*1fr 1fr/.test(rule),
     'a 1fr track cannot shrink below a nowrap button, so the row overflows the card');
  ok('it takes a second column only when one fits',
     /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(\d+px,\s*1fr\)\)/.test(rule), rule.trim());
  ok('and a button may wrap rather than leave the card',
     /\.product-card__actions \.btn \{[^}]*white-space:\s*normal/.test(css),
     'the last resort when a label is longer than the threshold allows for');
}

/* ── Measured ───────────────────────────────────────────────────── */
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT   = 9444;
const WIDTHS = [1600, 1440, 1280, 1150, 1024, 960, 900, 860, 820, 768, 600, 414, 390, 360];

if (!fs.existsSync(CHROME)) {
  console.log(`\n  SKIP  no browser at ${CHROME} — the measured half did not run`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const get = p => new Promise((res, rej) =>
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let s = ''; r.on('data', c => s += c); r.on('end', () => res(JSON.parse(s)));
  }).on('error', rej));

(async () => {
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
    '--no-sandbox', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  const stop = () => { try { proc.kill(); } catch (_) {} };
  try {
    let tabs;
    for (let i = 0; i < 25 && !tabs; i++) {
      await new Promise(r => setTimeout(r, 400));
      try { tabs = await get('/json/list'); } catch (_) {}
    }
    if (!tabs) { ok('the browser started', false, 'devtools never answered'); stop(); return; }

    const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const pending = new Map();
    ws.onmessage = ev => { const d = JSON.parse(ev.data);
      if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params) => new Promise(r => {
      const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: 'file://' + path.join(ROOT, 'index.html') });
    await new Promise(r => setTimeout(r, 2500));

    const worst = [];
    for (const w of WIDTHS) {
      await send('Emulation.setDeviceMetricsOverride',
        { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 768 });
      await new Promise(r => setTimeout(r, 300));
      const ev = await send('Runtime.evaluate', { returnByValue: true, expression: `
        (() => {
          /* The EIF section is display:none until the API says the offering is
             live, and there is no API behind file://. */
          const sec = document.getElementById('eif');
          if (sec) sec.style.display = '';
          let worst = null;
          for (const card of document.querySelectorAll('.product-card[data-product]')) {
            card.classList.remove('product-card--hp-hidden');
            card.style.visibility = ''; card.style.display = '';
            const acts = card.querySelector('.product-card__actions');
            if (!acts) continue;
            const cs = getComputedStyle(card);
            const inner = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
            if (inner <= 0) continue;
            const right = card.getBoundingClientRect().right - parseFloat(cs.paddingRight);
            const clipped = Math.max(0, ...[...acts.querySelectorAll('.btn')]
              .map(b => b.getBoundingClientRect().right - right));
            const row = { key: card.dataset.product, inner: Math.round(inner),
                          clipped: Math.round(clipped) };
            if (!worst || row.clipped > worst.clipped) worst = row;
          }
          return worst;
        })()` });
      const r = ev && ev.result && ev.result.result && ev.result.result.value;
      if (!r) { worst.push({ w, err: true }); continue; }
      worst.push({ w, ...r });
    }
    ws.close(); stop();

    const measured = worst.filter(x => !x.err);
    ok(`every card was measurable at all ${WIDTHS.length} widths`,
       measured.length === WIDTHS.length, `${measured.length} of ${WIDTHS.length}`);
    const bad = measured.filter(x => x.clipped > 0);
    ok('no card clips its buttons at any width',
       bad.length === 0,
       bad.map(b => `${b.w}px: ${b.key} clipped by ${b.clipped}px (card had ${b.inner}px)`).join('\n      '));
    const narrowest = measured.reduce((m, x) => (x.inner < m.inner ? x : m), measured[0]);
    ok(`and the narrowest card measured still fits (${narrowest.inner}px at ${narrowest.w}px)`,
       narrowest.clipped === 0);
  } catch (err) {
    ok('the measured half ran', false, err.message);
    stop();
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
