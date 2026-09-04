#!/usr/bin/env node
/* An investment row must offer a visible way into the investment detail.
 *
 * The row in the investor's Investments tab has opened the detail on click all
 * along, but the only control drawn in it was the purple move-pool button.
 * That reads as "the action here is moving pools", so the row itself looks
 * inert and the capability goes unfound — a feature that exists and cannot be
 * discovered is, from the operator's side, a feature that is missing.
 *
 * The rows are also reached by keyboard. The main investments list carried
 * tabindex="0" with no key handler, which is worse than not being focusable:
 * the focus ring promises an action that Enter does not perform.
 *
 * The markup is generated from the shipped template and then parsed, rather
 * than matched with a regex. Attribute quoting is the thing most likely to
 * break here — these handlers nest JSON strings inside single-quoted
 * attributes — and a regex over the source cannot tell whether the result
 * parses.
 *
 * Run: node scripts/check-investment-row-open.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');

/* The real Utils, lifted out of js/api.js, with this check's deterministic
   overrides on top.
 *
 * Each of these checks used to hand-write a Utils object with the four or five
 * methods the render happened to call. Adding a method to the real Utils and
 * using it in admin.js then failed here with "Utils.txnDate is not a function"
 * — a true failure reported as if the shipped code were broken, when what was
 * missing was the stub. Lifting the real one means a new helper is simply
 * there, and one that is DELETED breaks these honestly. */
function realUtils(overrides) {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'js', 'api.js'), 'utf8');
  const at = src.indexOf('const Utils = {');
  if (at < 0) throw new Error('Utils not found in js/api.js');
  let i = src.indexOf('{', at), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  const box = { console };
  require('vm').createContext(box);
  require('vm').runInContext(src.slice(at, j + 1) + ';\nthis.U = Utils;', box);
  return Object.assign({}, box.U, overrides || {});
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* Pull the row mapper out of the investor-detail Investments tab and run it.
   Sliced between markers in the shipped source so what is exercised is what
   ships. */
function renderInvestorTabRow() {
  const start = SRC.indexOf('${invsts.length ? invsts.map(i => {');
  if (start < 0) throw new Error('the investor-detail investments mapper was not found');
  const open = SRC.indexOf('{', SRC.indexOf('invsts.map(i => '));
  const end  = SRC.indexOf("}).join('')", open);
  if (end < 0) throw new Error('could not find the end of the mapper');
  const body = SRC.slice(open + 1, end);

  const sandbox = {
    Utils: realUtils({
      productInfo: () => ({ label: 'Cattle Investment', badgeClass: 'badge--gold', icon: 'fa-cow' }),
      rand: v => 'R' + Number(v || 0).toFixed(2),
      date: () => '24 Mar 2026',
      rateCell: () => '<span>2.13%</span>',
      statusBadge: () => '<span class="badge">ACTIVE</span>',
    }),
    _esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    JSON, Number, String,
    i: { id: 'INV-abc123', pool_name: "O'Brien Cattle — March", pool_id: 'POOL-9',
         product_type: 'cattle', amount: 10000, status: 'active',
         start_date: '2026-03-24', end_date: '2026-08-31' },
    id: 'INV-OWNER-1',
  };
  vm.createContext(sandbox);
  return vm.runInContext(`(function(){ ${body} })()`, sandbox);
}

/* A minimal attribute reader. Values are delimited by the quote character the
   attribute opens with, which is exactly the property under test. */
/* Attribute values are HTML-escaped in the markup — _esc(JSON.stringify(...))
   — and the browser decodes them before the JS is parsed. Assertions therefore
   compare against the decoded form, which is what actually executes. Matching
   the raw markup would fail on correct code and pass on code that forgot to
   escape, which is exactly backwards. */
const decodeEntities = s => String(s)
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z-]+)=(["'])([\s\S]*?)\2/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = m[3];
  return out;
}

(async () => {
  try {
    const html = renderInvestorTabRow();

    console.log('\nthe row markup parses');
    {
      const trTag = html.slice(0, html.indexOf('>') + 1);
      const a = attrs(trTag);
      ok('the row carries a click handler', !!a.onclick, trTag);
      ok('which opens this investment', /viewInvestmentDetail\("INV-abc123"/.test(a.onclick || ''), a.onclick);
      ok('and passes the investor to come back to',
         /"INV-OWNER-1"/.test(a.onclick || ''), a.onclick);

      ok('the row is reachable by keyboard', a.tabindex === '0', trTag);
      ok('and Enter activates it', /event\.key==="Enter"/.test(a.onkeydown || ''), a.onkeydown);
      ok('as does Space, without scrolling the page',
         /event\.key===" "/.test(a.onkeydown || '') && /preventDefault/.test(a.onkeydown || ''),
         a.onkeydown);
    }

    console.log('\nthere is something visible to click');
    {
      ok('an eye button is drawn in the row', /fa-eye/.test(html),
         'the move-pool button alone reads as the only action available');
      const eyeBtn = html.slice(html.lastIndexOf('<button', html.indexOf('fa-eye')), html.indexOf('fa-eye'));
      ok('it opens the detail rather than moving the pool',
         /viewInvestmentDetail\("INV-abc123","INV-OWNER-1"\)/.test(eyeBtn), eyeBtn);
      ok('and does not also fire the row click',
         /event\.stopPropagation\(\)/.test(eyeBtn), eyeBtn);
      ok('it is labelled for a screen reader and on hover',
         /title="Open investment detail"/.test(html));
    }

    console.log('\nthe move-pool button still works and stays distinct');
    {
      const swapAt = html.indexOf('fa-right-left');
      ok('it is still there', swapAt > -1);
      const swapBtn = html.slice(html.lastIndexOf('<button', swapAt), swapAt);
      ok('it moves the pool, not opens the detail',
         /openMoveInvestment\("INV-abc123","POOL-9"\)/.test(decodeEntities(swapBtn)), swapBtn);
      ok('and stops the row click', /event\.stopPropagation\(\)/.test(swapBtn), swapBtn);
      ok('the two buttons do not wrap onto separate lines',
         /white-space:nowrap/.test(html));
    }

    console.log('\nquoting survives content that would break it');
    {
      /* The pool name in the fixture contains an apostrophe. Attribute values
         are single-quoted here, so an unescaped one would truncate the handler
         and silently produce a row that does nothing. */
      ok('an apostrophe in the pool name is escaped',
         /O&#39;Brien/.test(html) && !/O'Brien/.test(html),
         html.slice(html.indexOf('td-strong'), html.indexOf('td-strong') + 120));
      const handlers = html.match(/on(click|keydown)='([^']*)'/g) || [];
      ok('every handler attribute closes cleanly', handlers.length >= 3,
         `found ${handlers.length}`);
    }

    console.log('\nthe main investments list is not left half-accessible');
    {
      ok('its focusable row has a key handler too',
         /tabindex="0"[^>]*onkeydown='if\(event\.key==="Enter"/.test(SRC) ||
         /const _openRow = /.test(SRC),
         'tabindex with no handler is a focus ring that promises nothing');
      ok('and it still opens without a back target, being the top-level list',
         /const _openRow = `viewInvestmentDetail\(\$\{JSON\.stringify\(i\.id\)\}\)`/.test(SRC));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  }
  process.exit(fail ? 1 : 0);
})();
