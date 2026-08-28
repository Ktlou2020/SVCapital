#!/usr/bin/env node
/* A capped tab must say so, and one failing query must not blank the rest.
 *
 * Investors, Investments, Transactions and Maturity each loaded with a bare
 * Promise.all and no idea how much of the table they had. Two faults:
 *
 *   · Promise.all rejects as a whole, so one failing query blanked the tab even
 *     when the others had returned. The catch showed a toast and left the
 *     previous render on screen — stale figures with nothing saying they were
 *     stale.
 *   · Every one reads a capped page and sums its tiles in the browser. The API
 *     has returned the true row count all along and nothing looked. There is no
 *     symptom to notice: a total that stops growing looks like a total.
 *
 * The banners are asserted by RUNNING the shipped loaders against a stubbed API
 * in a browser, not by reading the source. A guard that is present but never
 * reached is the thing being fixed here, and only executing it tells them apart.
 *
 * Maturity is checked hardest. There, truncation removes ROWS rather than
 * skewing a tile — the list is partly derived from investments, so a capped
 * investments read drops people out of "no instruction set", which is the list
 * an operator works before a maturity run.
 *
 * Run: node scripts/check-tab-load-guards.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const TABS = ['investors', 'investments', 'transactions', 'maturity'];

console.log('\nevery tab has somewhere to put the warning');
for (const t of TABS) {
  ok(`${t} has a truncation banner`, new RegExp(`id="${t}-truncation"`).test(HTML));
  ok(`  and a load-error banner`,    new RegExp(`id="${t}-load-errors"`).test(HTML));
}

console.log('\nnone of them loads with a bare Promise.all any more');
{
  for (const fn of ['loadInvestors', 'loadInvestments', 'loadTransactions', 'loadMaturity']) {
    const at = SRC.indexOf(`async function ${fn}(`);
    const body = SRC.slice(at, SRC.indexOf('\n}\n', at));
    ok(`${fn} goes through _loadSources`, /_loadSources\(/.test(body), body.slice(0, 300));
    ok(`  and reports what failed`, /_renderLoadErrors\(/.test(body));
    ok(`  and what was truncated`, /_renderTruncationBanner\(/.test(body));
    ok(`  with no bare Promise.all left`, !/await Promise\.all\(/.test(body), body.slice(0, 400));
  }
  ok('_loadSources uses allSettled', /Promise\.allSettled\(sources\.map/.test(SRC));
  ok('a failed source is emptied rather than left stale',
     /values\[s\.key\] = \[\];/.test(SRC),
     'the old catch left the previous render on screen with nothing saying it was stale');
}

console.log('\nthe maturity warning says rows are missing, not just totals');
{
  const at = SRC.indexOf('async function loadMaturity(');
  const body = SRC.slice(at, SRC.indexOf('\n}\n', at));
  ok('it says rows are missing from the list',
     /Rows are missing from this list, not just from a total/.test(body), body.slice(0, 200));
  ok('it names the "no instruction set" list specifically',
     /no instruction set/.test(body),
     'that is the list someone works before a run');
  ok('and it says the engine itself is unaffected',
     /engine reads the database directly and is not affected/.test(body),
     'otherwise this reads as "the payout run is broken", which it is not');
}

if (!CHROME) {
  console.log('\n  SKIP  no headless Chromium — the loaders were not run');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* ── Run the shipped loaders against a stubbed API ─────────────────────── */
function slice(name) {
  const isFn = SRC.includes(`function ${name}(`) || SRC.includes(`async function ${name}(`);
  const at = SRC.indexOf(SRC.includes(`async function ${name}(`) ? `async function ${name}(`
            : isFn ? `function ${name}(` : `const ${name} =`);
  if (at < 0) throw new Error(`${name} not found`);
  let i = SRC.indexOf('{', at), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  return SRC.slice(at, i + 1) + (isFn ? '' : ';');
}

let engine = '';
try {
  engine = ['_esc', '_loadSources', '_renderLoadErrors', '_renderTruncationBanner'].map(slice).join('\n');
} catch (err) {
  ok('the guard helpers could be extracted', false, err.message);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

const page = `<!doctype html><meta charset="utf-8"><body>
<div id="t-truncation" style="display:none"></div>
<div id="t-load-errors" style="display:none"></div>
<div id="out"></div>
<script>
${engine}

const out = {};
const src = (key, label, data, total) => ({ key, label, load: () => Promise.resolve({ data, total }) });
const boom = (key, label, msg) => ({ key, label, load: () => Promise.reject(new Error(msg)) });
const rows = n => Array.from({ length: n }, (_, i) => ({ id: i }));

(async () => {
  /* 1. Truncated: 5000 read of 12345. */
  let r = await _loadSources([src('transactions', 'Transactions', rows(5000), 12345)]);
  out.shownWhenShort = _renderTruncationBanner('t-truncation', r.counts, 'tail text here');
  out.shortHtml = document.getElementById('t-truncation').textContent.replace(/\\s+/g, ' ').trim();

  /* 2. Complete: 40 of 40. The banner must stay hidden — a guard that cries
        wolf on every load is a guard everyone learns to ignore. */
  r = await _loadSources([src('investors', 'Investors', rows(40), 40)]);
  out.shownWhenComplete = _renderTruncationBanner('t-truncation', r.counts, 'x');
  out.hiddenAfterComplete = document.getElementById('t-truncation').style.display === 'none';

  /* 3. total absent — the cached-resolve path. Unknown is not a shortfall. */
  r = await _loadSources([src('investors', 'Investors', rows(40), undefined)]);
  out.shownWhenUnknown = _renderTruncationBanner('t-truncation', r.counts, 'x');

  /* 4. One source fails, the others still land. */
  r = await _loadSources([
    src('a', 'Transactions', rows(3), 3),
    boom('b', 'Investors', 'HTTP 500'),
    src('c', 'Sub-accounts', rows(2), 2),
  ]);
  out.survivors = r.values.a.length + r.values.c.length;
  out.failedEmpty = Array.isArray(r.values.b) && r.values.b.length === 0;
  out.failedLabels = r.failed.map(f => f.label).join(',');
  out.errShown = _renderLoadErrors('t-load-errors', r.failed, 'loadInvestors()');
  out.errHtml = document.getElementById('t-load-errors').textContent.replace(/\\s+/g, ' ').trim();
  out.countsExcludeFailed = r.counts.length === 2;

  /* 5. A hostile source label must not become markup. */
  r = await _loadSources([boom('x', '<img src=x onerror="window.pwned=1">Investors', 'nope')]);
  window.pwned = 0;
  _renderLoadErrors('t-load-errors', r.failed, 'loadInvestors()');
  out.pwned = window.pwned;
  out.imgs = document.getElementById('t-load-errors').querySelectorAll('img').length;

  document.getElementById('out').textContent = JSON.stringify(out);
})();
</script></body>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabguard-'));
const file = path.join(tmp, 'p.html');
fs.writeFileSync(file, page);
let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=5000', '--dump-dom', 'file://' + file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
} catch (err) { dom = (err.stdout || '').toString(); }
const m = dom.match(/id="out">([^<]*)</);
let r = null;
try { r = JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')); }
catch (_) { /* reported below */ }

console.log('\nthe guards, executed');
ok('the page reported', !!r, (m ? m[1] : dom).slice(0, 250));

if (r) {
  ok('a short read raises the banner', r.shownWhenShort === true);
  ok('it names both figures', /5,000 of 12,345/.test(r.shortHtml), r.shortHtml.slice(0, 180));
  ok('and how many rows are excluded', /7,345 excluded/.test(r.shortHtml), r.shortHtml.slice(0, 220));
  ok('it says not to report the numbers', /do not report them/i.test(r.shortHtml), r.shortHtml.slice(0, 120));

  ok('a complete read raises nothing', r.shownWhenComplete === false,
     'a guard that fires on every load is one everyone learns to ignore');
  ok('and the banner is hidden again', r.hiddenAfterComplete === true,
     'left visible, a stale warning outlives the problem it described');
  ok('an unknown total is not treated as a shortfall', r.shownWhenUnknown === false,
     'Number(undefined) is NaN, which must read as "unknown", not "zero rows"');

  ok('one failing source does not blank the others', r.survivors === 5,
     `got ${r.survivors} of 5 rows from the two that succeeded`);
  ok('the failed one is emptied, not left undefined', r.failedEmpty === true);
  ok('it is named', r.failedLabels === 'Investors', r.failedLabels);
  ok('the error banner appears', r.errShown === true);
  ok('and says zero means missing, not zero',
     /showing zero because the data is missing/.test(r.errHtml), r.errHtml.slice(0, 200));
  ok('with the reason', /HTTP 500/.test(r.errHtml), r.errHtml.slice(0, 220));
  ok('a failed source contributes no row count', r.countsExcludeFailed === true,
     'counting a failed source as "0 of N" would report a truncation that did not happen');

  ok('a hostile source label does not execute', r.pwned === 0);
  ok('and creates no element', r.imgs === 0, `${r.imgs} <img>`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
