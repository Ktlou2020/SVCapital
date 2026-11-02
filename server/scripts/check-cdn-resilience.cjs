#!/usr/bin/env node
/* A library that fails to load must not take the page with it.
 *
 * The portal loads five scripts from a CDN — Chart.js, FontAwesome, QRCode,
 * jsPDF and its autotable plugin — and twenty-four of the twenty-six
 * `new Chart(` call sites assumed the first of them had arrived. Run with
 * the CDN unreachable, which is a normal morning on a South African mobile
 * connection, this is what the console said:
 *
 *   loadPortalData error (attempt 1): ReferenceError: Chart is not defined
 *       at renderPortfolioTrendChart
 *
 * The throw was inside loadPortalData, so it aborted THE ENTIRE DASHBOARD —
 * balances, investments, activity — retried, failed again, and showed the
 * client "Server is waking up, this can take up to 30 seconds". The server
 * was up the whole time. A decorative chart library took the portfolio down
 * and then blamed the backend.
 *
 * Run: node server/scripts/check-cdn-resilience.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SURFACES = ['js/portal-core.js', 'admin/js/admin.js', 'portal/js/portal.js'];

console.log('every chart goes through the one guarded entry point');
{
  const direct = [];
  for (const rel of SURFACES) {
    read(rel).split('\n').forEach((l, i) => {
      if (/new Chart\(/.test(l)) direct.push(`${rel}:${i + 1}`);
    });
  }
  ok('nothing constructs a Chart directly any more',
     direct.length === 0,
     direct.join('\n      ') + '\n      use Utils.chart(canvas, config) — '
     + 'twenty-four of twenty-six sites assumed the CDN had answered');

  let routed = 0;
  for (const rel of SURFACES) routed += (read(rel).match(/Utils\.chart\(/g) || []).length;
  ok('and the charts are still there', routed >= 20, `${routed} routed through Utils.chart`);

  const api = read('js/api.js');
  ok('the entry point checks the library arrived',
     /typeof Chart === 'undefined'/.test(api));
  ok('and catches a render that throws for any other reason',
     /try \{[\s\S]{0,120}new Chart\(el, config\)[\s\S]{0,200}catch/.test(api),
     'a bad dataset must not be fatal either');
  ok('a missing chart leaves a line, not a blank rectangle',
     /_chartUnavailable/.test(api) && /could not load/.test(api),
     'the allocation panel rendered as an empty white box');
}

console.log('\nand the page never asserts a cause it cannot know');
{
  const p = read('portal/js/portal.js');
  ok('a slow load no longer blames the server',
     !/Server is waking up/.test(p.replace(/\/\*[\s\S]*?\*\//g, '')),
     'it is a five-second timer, not a diagnosis — the commonest slow load '
     + 'is a phone on a weak signal, and the day a CDN failure made a chart '
     + 'throw the server was up and answering');
}

console.log('\nand the browser agrees, with the CDN taken away');
{
  const { findChromium } = require(path.join(ROOT, 'scripts', 'lib', 'chromium.cjs'));
  const CHROME = findChromium();
  if (!CHROME) {
    fail++;
    console.log('  ✗ the measured half needs a browser');
  } else {
    runMeasured(CHROME);
  }
}

function runMeasured(CHROME) {
  const { execFileSync } = require('child_process');
  const api  = read('js/api.js');
  const core = read('js/portal-core.js');

  /* Utils, loaded exactly as a browser would load it, with Chart ABSENT —
     which is the state the CDN failure produces. */
  const page = `<!DOCTYPE html><html><body>
    <div id="holder"><canvas id="c1"></canvas></div>
    <div id="probe"></div>
    <script>
    window.__err = null;
    try {
      ${api.slice(api.indexOf('const Utils = {'), api.indexOf('\n};', api.indexOf('const Utils = {')) + 3)}
      window.Utils = Utils;
    } catch (e) { window.__err = 'utils: ' + e.message; }
    const out = { err: window.__err };
    try {
      out.returned = Utils.chart('c1', { type: 'line', data: {} });
      out.threw = false;
    } catch (e) { out.threw = true; out.message = e.message; }
    out.canvasHidden = document.getElementById('c1').style.display === 'none';
    const note = document.querySelector('.chart-unavailable');
    out.noteText = note ? note.textContent : null;
    out.noteRole = note ? note.getAttribute('role') : null;
    /* Called twice, as a re-render would. */
    try { Utils.chart('c1', { type: 'line', data: {} }); } catch (e) { out.secondThrew = true; }
    out.notes = document.querySelectorAll('.chart-unavailable').length;
    document.getElementById('probe').textContent = JSON.stringify(out);
    </script></body></html>`;

  const tmp = path.join(require('os').tmpdir(), `svc-cdn-${process.pid}.html`);
  fs.writeFileSync(tmp, page);
  let dom = '';
  try {
    dom = execFileSync(CHROME, ['--headless', '--no-sandbox', '--disable-gpu',
      '--virtual-time-budget=3000', '--dump-dom', 'file://' + tmp],
      { encoding: 'utf8', timeout: 45000 });
  } catch (e) { dom = (e.stdout || '').toString(); }
  fs.unlinkSync(tmp);

  const { readProbe } = require(path.join(ROOT, 'scripts', 'lib', 'rendered.cjs'));
  const m = dom.match(/id="probe">([\s\S]*?)<\/div>/);
  const r = readProbe(m ? m[1] : '');

  ok('the page reported', !!r, (m ? m[1] : dom).slice(0, 300));
  if (!r) return;
  ok('nothing threw when Chart was absent', r.threw === false,
     r.message + ' — this is the throw that aborted the whole dashboard');
  ok('and the call answered with nothing rather than a half-chart',
     r.returned === null, JSON.stringify(r.returned));
  ok('the empty canvas is taken out of the layout', r.canvasHidden === true);
  ok('and a line is put in its place', /could not load/.test(r.noteText || ''),
     JSON.stringify(r.noteText));
  ok('which a screen reader is told about',
     r.noteRole === 'status', String(r.noteRole));
  ok('and re-rendering does not stack a second one',
     r.notes === 1, `${r.notes} notes after two calls`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
