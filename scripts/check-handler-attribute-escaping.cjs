#!/usr/bin/env node
/* An apostrophe in a name must not kill the buttons in that row.
 *
 * The console builds inline handlers as
 *
 *     onclick='depositToInvestor(${JSON.stringify(inv.id)}, ${JSON.stringify(name)}, …)'
 *
 * JSON.stringify escapes for JavaScript, not for an HTML attribute, and it
 * does not touch apostrophes. The attribute is single-quoted, so a name like
 * S'busiso ends it early: the browser parses onclick as
 * `depositToInvestor("S-11470", "S` and the handler never runs.
 *
 * The stored-markup audit found three such investors in production —
 * S'busiso, Ma'roof and a trust called MEN'S FORUM(CMF) — for whom Add Funds,
 * Reset 2FA, Invest on Behalf, Recalculate Wallet and Override Wallet Balance
 * were all silently dead. Money-adjacent admin functions, broken for named
 * clients, with nothing on screen to say so.
 *
 * Asserted in a real browser, because this is precisely a case where reading
 * the template tells you nothing: the markup looks correct, and only the HTML
 * parser reveals that the attribute ended three characters in.
 *
 * Run: node scripts/check-handler-attribute-escaping.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ── Structural: nothing is left unwrapped ─────────────────────────── */
console.log('\nevery inline handler escapes what it interpolates');
{
  const lines = SRC.split('\n');
  const unwrapped = [];
  lines.forEach((ln, i) => {
    if (!/on(click|keydown|change|input)='/.test(ln)) return;
    for (const m of ln.matchAll(/\$\{JSON\.stringify\(/g)) unwrapped.push(i + 1);
  });
  ok('no ${JSON.stringify(…)} sits raw inside a single-quoted handler',
     unwrapped.length === 0,
     `still raw on line(s): ${unwrapped.slice(0, 8).join(', ')}`);

  const wrapped = (SRC.match(/\$\{_esc\(JSON\.stringify\(/g) || []).length;
  ok('and the escaped form is used throughout', wrapped >= 80, `found ${wrapped}`);
}

if (!CHROME) {
  console.log('\n  SKIP  no headless Chromium — the browser half was not exercised');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* ── Behavioural: render the shipped pattern and click it ──────────── */
const NAMES = [
  { label: 'an apostrophe, as in S\'busiso',        value: "S'busiso Dlamini" },
  { label: 'a double quote',                        value: 'Ma"roof Test' },
  { label: 'a trust name with both, MEN\'S "F"',    value: 'MEN\'S "FORUM"(CMF)' },
  { label: 'markup, which must arrive inert',       value: '<img src=x onerror="window.pwned=1">' },
  { label: 'an ordinary name',                      value: 'Thandi Mokoena' },
];

const escSrc = (SRC.match(/^const _esc = .*$/m) || [])[0];
ok('the shipped _esc was found', !!escSrc);

/* The real button, lifted out of admin.js.

   An earlier version of this check built the markup itself, from the pattern
   the fix uses. That tested the pattern, not the file: against the unfixed
   admin.js the structural assertions failed while every browser assertion
   still passed, which is precisely the shape of a check that cannot see the
   bug it exists for. Extracting the shipped template means the negative
   control fails here too. */
function shippedButton() {
  const at = SRC.indexOf("onclick='depositToInvestor(");
  if (at < 0) return null;
  const start = SRC.lastIndexOf('<button', at);
  const end   = SRC.indexOf('</button>', at);
  if (start < 0 || end < 0) return null;
  return SRC.slice(start, end + '</button>'.length);
}
const BUTTON = shippedButton();
ok('the Add Funds button template was found', !!BUTTON, String(BUTTON).slice(0, 120));

/* Rendered here, in Node, using the shipped template and the shipped _esc —
   then the finished HTML is handed to the browser. Building the template
   literal inside the page string is what broke first: its backticks closed the
   outer literal. Rendering in Node also means the browser only ever sees the
   markup the console would actually emit. */
const _escFn = new Function('return ' + escSrc.replace(/^const _esc = /, ''))();
const RENDERED = NAMES.map(n => {
  const inv = { id: 'S-11470', first_name: n.value, last_name: '', wallet_balance: 0 };
  try {
    return new Function('inv', '_esc', 'return `' + (BUTTON || '') + '`;')(inv, _escFn);
  } catch (err) {
    return `<!-- template failed: ${String(err.message).replace(/-->/g, '')} -->`;
  }
});
ok('the template rendered for every name', RENDERED.every(h => /<button/.test(h)),
   RENDERED.find(h => !/<button/.test(h)));

const page = `<!doctype html><meta charset="utf-8"><body>
<div id="out"></div><div id="host"></div>
<script>
${escSrc}
window.pwned = 0;
window.results = [];
function depositToInvestor(id, name, bal) { window.results.push({ ok: true, id: id, name: name }); }
/* The template's own name expression is first_name + " " + last_name, so the
   value that arrives has a trailing space when last_name is empty. */
const RENDERED = ${JSON.stringify(RENDERED)};
RENDERED.forEach(function (html) {
  document.getElementById('host').innerHTML = html;
  const btn = document.getElementById('host').querySelector('button');
  const before = window.results.length;
  try { btn.click(); } catch (e) { window.results.push({ ok: false, error: e.message }); }
  if (!btn) { window.results.push({ ok: false, error: 'no button rendered' }); return; }
  if (window.results.length === before) window.results.push({ ok: false, error: 'handler did not fire' });
});
document.getElementById('out').textContent = JSON.stringify({ results: window.results, pwned: window.pwned });
</script></body>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attresc-'));
const file = path.join(tmp, 'page.html');
fs.writeFileSync(file, page);

let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=4000', '--dump-dom', 'file://' + file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
} catch (err) {
  dom = (err.stdout || '').toString();
}
const m = dom.match(/id="out">([^<]*)</);
let parsed = null;
try { parsed = JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')); }
catch (_) { /* reported below */ }

console.log('\nthe handler fires, whatever the name contains');
ok('the page reported results', !!parsed, (m ? m[1] : dom).slice(0, 200));

if (parsed) {
  NAMES.forEach((n, i) => {
    const r = parsed.results[i];
    ok(`${n.label} — the button still works`, r && r.ok === true,
       JSON.stringify(r));
    if (r && r.ok) {
      ok(`  …and the name arrives intact`, String(r.name).trim() === n.value,
         `expected ${JSON.stringify(n.value)}, got ${JSON.stringify(r.name)}`);
    }
  });

  /* The markup case is the one that must not merely "work". */
  ok('markup passed through a handler does not execute', parsed.pwned === 0,
     'an onerror inside the interpolated value ran');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
