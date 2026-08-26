#!/usr/bin/env node
/* One broken analytics panel must cost you one panel, and the page must not
 * lie about how old its numbers are.
 *
 * Two faults, same function.
 *
 * ISOLATION. loadAnalytics made 21 bare calls inside a single try, none of
 * them awaited. A synchronous throw in the third skipped the eighteen after
 * it; an async rejection was never caught at all. The result was a silently
 * half-drawn page — no error, just panels that quietly never appeared, which
 * is indistinguishable from "there is no data for that".
 *
 * STALENESS. The page fetched only when STATE was empty, so it loaded once per
 * session and then showed whatever was true at login for as long as the tab
 * stayed open. Worse, the "last refreshed" line used new Date() at render
 * time, so hours-old figures announced themselves as just refreshed. A stale
 * number that admits it is fine; one that claims to be current is not.
 *
 * The real functions are extracted from admin.js and driven in headless
 * Chromium — a panel that throws is made to throw, rather than assumed to.
 *
 * Run: node scripts/check-analytics-panels.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome']
  .find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const admin = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const html  = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
const body  = (() => {
  const i = admin.indexOf('async function loadAnalytics(');
  return admin.slice(i, admin.indexOf('\n}\n', i));
})();

console.log('\nthe page refetches instead of showing login-time figures forever');
ok('loadAnalytics takes a force argument', /async function loadAnalytics\(force\)/.test(admin));
ok('Refresh All actually forces a read',
   /onclick="loadAnalytics\(true\)"/.test(html),
   'without the argument the button re-renders the same cached numbers');
ok('data older than the staleness window is refetched',
   /const stale = !_analyticsFetchedAt \|\| \(Date\.now\(\) - _analyticsFetchedAt\) > ANALYTICS_STALE_MS/.test(body));
ok('the fetch time is recorded when the fetch happens',
   /_analyticsFetchedAt = Date\.now\(\);/.test(body));
ok('the age shown is the data\'s, not the render\'s',
   !/Last refreshed.*new Date\(\)\.toLocaleTimeString/.test(admin) &&
   /tsEl\.textContent = _analyticsAgeLabel\(\)/.test(admin),
   'new Date() at render time reports cached figures as freshly refreshed');

console.log('\neach panel renders on its own');
ok('panels go through the isolating wrapper',
   /panels\.map\(\(\[label, fn\]\) => _analyticsPanel\(label, fn\)\)/.test(body));
ok('and are awaited, so failures are collected rather than dropped',
   /await Promise\.all\(/.test(body));
ok('every panel is named for the failure message',
   (body.match(/\['[^']+',\s+\w/g) || []).length >= 20,
   'an unnamed panel produces an error nobody can locate');
ok('the outer catch is now only for the data read',
   /Only the data read reaches here now/.test(body));
ok('there is somewhere to report failures', /id="an-panel-errors"/.test(html));

if (!CHROME) {
  console.log('\n  SKIP  no headless Chromium — behaviour not exercised');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function grab(sig) {
  const i = admin.indexOf(sig);
  if (i < 0) return '';
  return admin.slice(i, admin.indexOf('\n}\n', i) + 3);
}
const fns = grab('async function _analyticsPanel(')
          + grab('function _analyticsPanelErrors(')
          + grab('function _analyticsAgeLabel(');
ok('the three functions were found', /_analyticsPanel/.test(fns) &&
   /_analyticsPanelErrors/.test(fns) && /_analyticsAgeLabel/.test(fns));

const page = `<!doctype html><meta charset="utf-8"><body>
<div id="an-panel-errors" style="display:none"></div>
<script>
const _esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
let _analyticsFetchedAt = 0;
${fns}
(async () => {
  var ran = [];
  var panels = [
    ['A ok',         function(){ ran.push('A'); }],
    ['B sync throw', function(){ ran.push('B'); throw new Error('boom sync'); }],
    ['C ok',         function(){ ran.push('C'); }],
    ['D async rej',  async function(){ ran.push('D'); throw new Error('boom async'); }],
    ['E ok',         async function(){ ran.push('E'); }],
  ];
  var failures = (await Promise.all(panels.map(function(p){ return _analyticsPanel(p[0], p[1]); }))).filter(Boolean);
  _analyticsPanelErrors(failures);
  var el = document.getElementById('an-panel-errors');
  var res = {
    ran: ran.join(','),
    failures: failures.map(function(f){ return f.label + '::' + f.message; }),
    shown: el.style.display !== 'none',
    text: el.textContent.replace(/\\s+/g,' ').trim(),
  };
  _analyticsPanelErrors([]);
  res.clears = el.style.display === 'none';
  _analyticsFetchedAt = 0;               res.ageNever = _analyticsAgeLabel();
  _analyticsFetchedAt = Date.now();      res.ageNow   = _analyticsAgeLabel();
  _analyticsFetchedAt = Date.now() - 45*60*1000;  res.age45 = _analyticsAgeLabel();
  _analyticsFetchedAt = Date.now() - 5*3600*1000; res.age5h = _analyticsAgeLabel();
  document.title = 'RESULTS' + JSON.stringify(res);
})();
<\/script></body>`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-panels-'));
const file = path.join(dir, 'p.html');
fs.writeFileSync(file, page);
let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=3000', '--dump-dom', 'file://' + file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) { console.log(`  ✗ chromium did not run: ${e.message}`); process.exit(1); }
const m = dom.match(/<title>RESULTS(.*?)<\/title>/s);
if (!m) { console.log('  ✗ the page did not report results'); process.exit(1); }
const decode = s => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
                     .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const r = JSON.parse(decode(m[1]));

console.log('\nand a throwing panel proves it');
ok('every panel still ran, including those after the one that threw',
   r.ran === 'A,B,C,D,E', r.ran);
ok('a synchronous throw is caught', r.failures.some(f => /^B sync throw::boom sync$/.test(f)),
   JSON.stringify(r.failures));
ok('an async rejection is caught too', r.failures.some(f => /^D async rej::boom async$/.test(f)),
   JSON.stringify(r.failures));
ok('only the broken ones are reported', r.failures.length === 2, JSON.stringify(r.failures));
ok('the failure is named and explained', /B sync throw/.test(r.text) && /boom sync/.test(r.text),
   r.text.slice(0, 140));
ok('and the rest of the page is vouched for',
   /Everything else on this page loaded normally/.test(r.text));
ok('the notice clears when nothing fails', r.clears === true);

console.log('\nthe age is stated honestly');
ok('nothing is claimed before a first read', r.ageNever === '', JSON.stringify(r.ageNever));
ok('a fresh read reads as fresh', /just now$/.test(r.ageNow), r.ageNow);
ok('45 minutes is shown as 45 minutes', /45 min ago$/.test(r.age45), r.age45);
ok('hours are shown as hours, not minutes', /5 h ago$/.test(r.age5h), r.age5h);
ok('and the clock time is given, not only the age',
   /Data as of \d{2}:\d{2}/.test(r.age45), r.age45);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
