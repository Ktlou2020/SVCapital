#!/usr/bin/env node
/* The pending-deposit queue must be findable, and workable in bulk.
 *
 * Transactions was the only queue in the console with neither a status filter
 * nor a bulk action. KYC, withdrawals, investors and maturity all had both. So
 * the one queue that is money coming in was worked by paging through the entire
 * ledger looking for the word "pending", then approving one row at a time —
 * while the dashboard sat there counting it.
 *
 * The command palette had a matching gap: its placeholder has always read
 * "Search views, investors, actions…" and it only ever searched a hard-coded
 * list of views. Looking a client up is the most common thing anyone does here.
 *
 * Two things are asserted in a real browser rather than by reading the source:
 * that a select-all covers the whole FILTER rather than the visible page, and
 * that an investor name carrying markup reaches the palette inert. The second
 * is new exposure — the palette's labels were a fixed list until now, so raw
 * interpolation was safe there; it no longer is.
 *
 * Run: node scripts/check-admin-queue-tools.cjs
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

console.log('\nthe pending queue can be found');
{
  ok('the ledger has a status filter', /id="txnStatusFilter"/.test(HTML),
     'without it the queue could only be found by eye, page by page');
  for (const s of ['pending', 'processing', 'completed', 'failed'])
    ok(`  it offers ${s}`, new RegExp(`<option value="${s}"`).test(HTML));
  ok('the filter is wired to the table',
     /const status = document\.getElementById\('txnStatusFilter'\)/.test(SRC) &&
     /status\.addEventListener\('change', filter\)/.test(SRC));
  ok('a row with no status counts as pending',
     /\(t\.status \|\| 'pending'\) === st/.test(SRC),
     'NULL reads as pending everywhere else, so the visible queue must match the counted one');
  ok('the dashboard tile opens the filtered queue, not the raw ledger',
     /function openPendingDeposits\(\)/.test(SRC) && /go: 'openPendingDeposits\(\)'/.test(SRC),
     'counting work and then landing on every transaction ever made is not opening the queue');
}

console.log('\nand worked in bulk, like every other queue');
{
  ok('there is a bulk bar', /id="txnBulkBar"/.test(HTML));
  ok('a select-all in the header', /id="txnSelectAll"/.test(HTML));
  ok('and an approve action', /bulkApproveDeposits\(this\)/.test(HTML));
  ok('only a pending deposit is selectable',
     /const _isApprovableTxn = t => t && t\.type === 'deposit' && t\.status === 'pending'/.test(SRC),
     'the checkbox means "approve", and nothing else here can be approved');
  ok('the bar shows the total about to be credited',
     /to be credited/.test(SRC),
     'the figure hitting client wallets is the difference between a bulk action and a bulk accident');
  ok('it confirms before crediting anything',
     /await Confirm\.ask\(`Approve \$\{picked\.length\}/.test(SRC));
  ok('approvals run sequentially',
     /_bulkRun\(picked,[\s\S]{0,220}?sequential: true/.test(SRC),
     'several deposits for one investor in parallel is the shape that makes concurrent balance writes interesting');
  ok('partial failure is reported per investor',
     /_bulkReport\('deposit', 'approved', result\)/.test(SRC) &&
     /label: t => _investorLabel\(t\.investor_id\)/.test(SRC));
  ok('it approves by writing the row, not the wallet',
     /API\.transactions\.update\(t\.id, \{ status: 'completed' \}\)/.test(SRC),
     'the server credits inside the same transaction — see check-admin-money-writes');
  ok('filtering a row away deselects it',
     /if \(!visible\.has\(id\)\) selectedTxns\.delete\(id\)/.test(SRC),
     'a hidden row still ticked is a row approved without being seen');
}

console.log('\nthe palette searches what it says it searches');
{
  ok('the placeholder still promises investors',
     /placeholder="Search views, investors, actions/.test(HTML));
  ok('and investors are actually searched',
     /STATE\.investors \|\| \[\]\)\.filter/.test(SRC),
     'it only ever filtered a hard-coded list of views');
  for (const [what, re] of [
    ['name',      /_q\(`\$\{i\.first_name\} \$\{i\.last_name\}`\)\.includes\(query\)/],
    ['email',     /_q\(i\.email\)\.includes\(query\)/],
    ['ID number', /_q\(i\.id_number\)\.includes\(query\)/],
    ['phone',     /_q\(i\.phone\)\.replace/],
  ]) ok(`  by ${what}`, re.test(SRC));
  ok('views and actions still rank above people',
     /const filtered = \[\.\.\.matches, \.\.\.people\]/.test(SRC),
     'typing "kyc" means the view, not four clients with kyc in an email address');
  ok('selecting one opens that investor',
     /viewInvestor\(i\.id\)/.test(SRC), 'otherwise you search twice for the same person');
  ok('a single character does not scan every investor',
     /query\.length >= 2 \?/.test(SRC));
}

if (!CHROME) {
  console.log('\n  SKIP  no headless Chromium — the browser half was not exercised');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* ── Browser: select-all scope, and the palette's new escaping ────────── */
const escSrc = (SRC.match(/^const _esc = .*$/m) || [])[0];
ok('the shipped _esc was found', !!escSrc);

/* The palette's render, lifted out of admin.js rather than rebuilt here — a
   rebuilt copy would keep passing after someone drops the escaping. */
function paletteTemplate() {
  const at = SRC.indexOf('el.innerHTML = filtered.map((c,i) =>');
  if (at < 0) return null;
  const start = SRC.indexOf('`', at);
  const end   = SRC.indexOf('</div>`', start);
  return end < 0 ? null : SRC.slice(start + 1, end + '</div>'.length);
}
const TPL = paletteTemplate();
ok('the palette row template was found', !!TPL, String(TPL).slice(0, 140));

const NASTY = '<img src=x onerror="window.pwned=1">Mokoena';

/* Rendered here, in Node, with the shipped template and the shipped _esc, then
   the finished HTML is handed to the browser.

   Embedding the template literal in the page string is what broke first: it
   contains nested literals for the optional sub-line and badges, and escaping
   its backticks to survive the outer literal turned those nested ones into
   plain characters, so the whole expression stopped parsing. Same trap as
   check-handler-attribute-escaping, same answer. */
const _escFn = new Function('return ' + escSrc.replace(/^const _esc = /, ''))();
let RENDERED = '';
try {
  RENDERED = new Function('c', 'i', '_esc', 'return `' + (TPL || '') + '`;')(
    { label: NASTY, sub: 'x@y.test · S-1', icon: 'fa-user' }, 0, _escFn);
} catch (err) {
  RENDERED = `<!-- template failed: ${String(err.message).replace(/-->/g, '')} -->`;
}
ok('the palette row rendered', /<div class="adm-cmd-item"/.test(RENDERED), RENDERED.slice(0, 200));

const page = `<!doctype html><meta charset="utf-8"><body>
<div id="host"></div><div id="out"></div>
<script>
window.pwned = 0;
function adminCmdHover(){} function adminCmdSelect(){}
document.getElementById('host').innerHTML = ${JSON.stringify(RENDERED)};

/* Select-all must cover the whole filter, not the page on screen. Modelled on
   the shipped helpers: 60 matching rows, a 25-row page. */
var filteredTxns = [];
for (var n = 0; n < 60; n++) filteredTxns.push({ id: 't'+n, type: 'deposit', status: 'pending' });
var selectedTxns = new Set();
${(SRC.match(/const _isApprovableTxn = [^\n]*\n/) || [''])[0]}
${(SRC.match(/function toggleAllTxns\(on\)[\s\S]*?\n\}\n/) || [''])[0].replace('renderTxnTable();', '')}
toggleAllTxns(true);

document.getElementById('out').textContent = JSON.stringify({
  pwned: window.pwned,
  text: document.getElementById('host').textContent.trim().slice(0, 60),
  imgs: document.getElementById('host').querySelectorAll('img').length,
  selected: selectedTxns.size,
});
</script></body>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'queuetools-'));
const file = path.join(tmp, 'page.html');
fs.writeFileSync(file, page);

let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=4000', '--dump-dom', 'file://' + file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
} catch (err) { dom = (err.stdout || '').toString(); }

const m = dom.match(/id="out">([^<]*)</);
let parsed = null;
try {
  parsed = JSON.parse((m ? m[1] : '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
} catch (_) { /* reported below */ }

console.log('\nin a real browser');
ok('the page reported results', !!parsed, (m ? m[1] : dom).slice(0, 220));
if (parsed) {
  ok('an investor name carrying markup does not execute', parsed.pwned === 0,
     'the palette renders names now — it was a fixed list before');
  ok('and no element is created from it', parsed.imgs === 0, `${parsed.imgs} <img> rendered`);
  ok('the name is still shown as text', /Mokoena/.test(parsed.text), parsed.text);
  ok('select-all covers the whole filter, not the visible page',
     parsed.selected === 60,
     `selected ${parsed.selected} of 60 — a select-all that quietly means "these 25" half-works the queue`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
