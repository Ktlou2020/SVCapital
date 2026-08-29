#!/usr/bin/env node
/* Text a client typed must not reach innerHTML unescaped.
 *
 * The inline handlers were swept first, because an apostrophe in a surname
 * genuinely broke them — S'busiso, Ma'roof and MEN'S FORUM(CMF) had five
 * money-adjacent buttons silently dead. That sweep left the rest of the console:
 * roughly a hundred interpolations of the same fields into markup that is not a
 * handler attribute.
 *
 * Most were harmless in practice and none was known to be exploited: the write
 * paths are closed (non-privileged writes are stripped at the server, email and
 * id_number refused) and the stored-markup audit reports what is actually
 * sitting in the database. But "closed today" and "safe" are different claims,
 * and neither survives a migration, an import, or a column that was not on the
 * strip list. The escaping is the part that holds regardless.
 *
 * WHAT COUNTS AS A FINDING
 *
 * A `${…}` inside a template literal that contains real markup, whose expression
 * still names a field a person can type after every `_esc(…)` call and string
 * literal is removed from it. That last step matters: `${_esc(a)} ${b}` must
 * report b and not be excused by a, and `${x ? 'yes' : 'no'}` on a tainted x is
 * not a finding because neither branch carries the value.
 *
 * Sort comparators, search haystacks, CSV rows and toast strings are not markup
 * and are not scanned — three separate local helpers in this file are called
 * `esc` and escape for CSV, which is why the check looks for `_esc` specifically.
 *
 * Run: node scripts/check-markup-interpolation.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'admin', 'js', 'admin.js');
const SRC  = fs.readFileSync(FILE, 'utf8');

/* Fields a client, a sub-account holder or a ticket author can type. The
   denormalised copies are included deliberately: investor_name is written onto
   transactions, investments and maturity rows, and is the same text. */
const TAINTED = /\b(first_name|last_name|investor_name|full_name|nickname|email|phone|id_number|address|city|province|bank_name|account_holder|description|notes?|message|subject|body|reason|comment|reference|pool_name|title|file\.name|\bname\b)\b/;

/* Helpers that produce their own safe output: numbers, dates, fixed badge
   markup. Escaping their result would show entities to the operator. */
const SAFE_CALL = /^(Utils\.(rand|pct|date|dateTime|num|money|statusBadge|productInfo|initials|poolFillPct|effectiveRate)|Number|parseFloat|parseInt|encodeURIComponent|String\(.*\)\.length)\s*\(/;

/* Template literals, with nesting tracked so an inner literal inside ${…} is
   collected in its own right rather than swallowed by the outer one. */
function templateLiterals(src) {
  const out = [], stack = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      if (stack.length && stack[stack.length - 1].type === 'tpl') out.push({ start: stack.pop().start, end: i });
      else stack.push({ type: 'tpl', start: i });
      continue;
    }
    if (c === '$' && src[i + 1] === '{' && stack.length && stack[stack.length - 1].type === 'tpl') {
      stack.push({ type: 'sub' }); i++; continue;
    }
    if (c === '}' && stack.length && stack[stack.length - 1].type === 'sub') { stack.pop(); continue; }
  }
  return out;
}

/* Remove every _esc(…) call, balanced, along with its argument. What is left is
   the part of the expression that reaches the page raw. */
function stripEscaped(expr) {
  let s = expr, guard = 0;
  while (guard++ < 40) {
    const at = s.search(/(^|[^A-Za-z0-9_$])_esc\s*\(/);
    if (at < 0) break;
    const open = s.indexOf('(', at);
    let i = open, depth = 0;
    for (; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { depth--; if (depth === 0) break; }
    }
    if (i >= s.length) break;
    s = s.slice(0, at === 0 ? 0 : at + 1) + ' SAFE ' + s.slice(i + 1);
  }
  return s;
}

const stripStrings = s => s.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

/* A ternary may TEST a tainted value and print only constants —
   `${(inv.province||'') === p ? 'selected' : ''}` decides an attribute, it does
   not carry the province into the page. Reporting those would push someone to
   "fix" them by wrapping a literal in _esc, which is noise that makes the real
   findings harder to see. Only the branches are examined; the condition is not
   printed. Split at the top level so a nested ternary inside a branch still
   gets looked at. */
function ternaryBranches(expr) {
  let depth = 0, q = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '?' && depth === 0 && expr[i + 1] !== '.' && expr[i + 1] !== '?') { q = i; break; }
  }
  if (q < 0) return null;
  depth = 0;
  for (let i = q + 1; i < expr.length; i++) {
    const c = expr[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '?' && depth === 0) return null;      // nested ternary, treat whole thing as printed
    else if (c === ':' && depth === 0) return [expr.slice(q + 1, i), expr.slice(i + 1)];
  }
  return null;
}

/* What actually reaches the page: a ternary contributes only its branches. */
function printedPart(expr) {
  const t = ternaryBranches(expr);
  return t ? t.map(printedPart).join(' ') : expr;
}

/* The top-level `${…}` spans of one literal, found by walking rather than by
   regex, so nesting is respected: braces, nested literals and quoted strings
   all keep their own depth. */
function substitutions(lit) {
  const out = [];
  let i = lit.start + 1;
  while (i < lit.end) {
    const c = SRC[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '$' && SRC[i + 1] === '{') {
      const start = i;
      let depth = 0; i += 1;
      for (; i < lit.end; i++) {
        const d = SRC[i];
        if (d === '\\') { i++; continue; }
        if (d === "'" || d === '"') {                     // skip a quoted string whole
          const q = d; i++;
          while (i < lit.end && SRC[i] !== q) { if (SRC[i] === '\\') i++; i++; }
          continue;
        }
        if (d === '`') {                                  // skip a nested literal whole
          let td = 0; i++;
          while (i < lit.end) {
            if (SRC[i] === '\\') { i += 2; continue; }
            if (SRC[i] === '$' && SRC[i + 1] === '{') { td++; i += 2; continue; }
            if (SRC[i] === '}' && td > 0) { td--; i++; continue; }
            if (SRC[i] === '`' && td === 0) break;
            i++;
          }
          continue;
        }
        if (d === '{') depth++;
        else if (d === '}') { depth--; if (depth === 0) { out.push({ start, end: i + 1 }); break; } }
      }
      i++;
      continue;
    }
    i++;
  }
  return out;
}

function findings() {
  const lits = templateLiterals(SRC).filter(l =>
    /<[a-zA-Z][a-zA-Z0-9-]*[\s>/]/.test(SRC.slice(l.start, l.end)));

  const lineStarts = [];
  { let n = 0; for (const ln of SRC.split('\n')) { lineStarts.push(n); n += ln.length + 1; } }
  const lineOf = off => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStarts[m] <= off) lo = m; else hi = m - 1; } return lo + 1; };

  const seen = new Set(), out = [];
  for (const l of lits) {
    for (const sub of substitutions(l)) {
      const expr = SRC.slice(sub.start + 2, sub.end - 1).trim();
      /* A substitution holding its own template literal is a block of code —
         a .map() body, a helper call — not a value being printed. Its markup
         is a literal in its own right and is scanned as one. Matching `${…}`
         with a regex over the outer literal's raw text did not know that: it
         reached inside those blocks and reported ordinary statements, and the
         fixer then wrapped a variable's CONSTRUCTION in _esc while the sink
         escaped it again. */
      if (!expr || expr.includes('`')) continue;
      if (SAFE_CALL.test(expr)) continue;
      const bare = stripStrings(stripEscaped(printedPart(expr)));
      if (!TAINTED.test(bare)) continue;
      /* Deduped on the OFFSET, not on line+expression. Nested literals mean
         the same physical `${…}` is reached several times and must collapse to
         one finding — but two distinct occurrences of the same expression on
         one line are two findings. Keying on line+expr conflated those: it
         dropped the second, --fix left it behind, and the sweep needed a
         second pass to converge. */
      const start = sub.start;
      const line = lineOf(start);
      if (seen.has(start)) continue;
      seen.add(start);
      out.push({ line, start, end: sub.end, raw: expr,
                 expr: expr.replace(/\s+/g, ' ').slice(0, 120) });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

const found = findings();

/* --fix wraps each finding in _esc at the point of interpolation, using the
   SAME detection as the report. A separate fixer would drift from the check
   that guards it, and the two disagreeing about what counts is exactly how a
   sweep like this leaves a residue behind.

   Escaping happens at the sink rather than where the value is built: a variable
   escaped at construction is "already HTML" and quietly wrong the next time it
   is used for a title attribute, a CSV cell or a comparison. */
if (process.argv.includes('--fix')) {
  const edits = findings().sort((a, b) => b.start - a.start);   // back to front, so offsets hold
  let out = SRC;
  for (const f of edits) out = out.slice(0, f.start) + '${_esc(' + f.raw.trim() + ')}' + out.slice(f.end);
  fs.writeFileSync(FILE, out);
  console.log(`wrapped ${edits.length} interpolation(s) in _esc`);
  process.exit(0);
}

if (process.argv.includes('--list')) {
  console.log(`${found.length} unescaped tainted interpolation(s) in markup\n`);
  for (const f of found) console.log(`  admin/js/admin.js:${f.line}  ${f.expr}`);
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

console.log('\nno client-typed text reaches innerHTML unescaped');
ok('the console is clean', found.length === 0,
   found.length
     ? found.slice(0, 25).map(f => `admin/js/admin.js:${f.line}  ${f.expr}`).join('\n      ') +
       (found.length > 25 ? `\n      …and ${found.length - 25} more (run with --list)` : '')
     : '');

/* The detector has to be able to see a defect, or a clean run means nothing.
   Both directions are exercised on synthetic input rather than trusted. */
console.log('\nthe detector itself works');
{
  const probe = (expr, hasMarkup = true) => {
    const body = hasMarkup ? '`<div>${' + expr + '}</div>`' : '`${' + expr + '}`';
    const saveSrc = body;
    const lits = templateLiterals(saveSrc).filter(l =>
      /<[a-zA-Z][a-zA-Z0-9-]*[\s>/]/.test(saveSrc.slice(l.start, l.end)));
    if (!lits.length) return false;
    const inner = saveSrc.slice(lits[0].start, lits[0].end);
    const m = [...inner.matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)][0];
    if (!m) return false;
    const e = m[1].trim();
    if (SAFE_CALL.test(e)) return false;
    return TAINTED.test(stripStrings(stripEscaped(printedPart(e))));
  };

  ok('a raw name is caught',                probe('inv.first_name'));
  ok('an escaped one is not',              !probe('_esc(inv.first_name)'));
  ok('escaped beside raw still reports',    probe('_esc(a.first_name) + b.last_name'),
     'one escaped value must not excuse an unescaped one next to it');
  ok('a nested _esc is unwrapped correctly',!probe('_esc(x.email || fallbackFn(y))'));
  ok('a constant ternary on a tainted test is not a finding',
     !probe("(inv.province || '') === p ? 'selected' : ''"),
     'the value is tested, not printed');
  ok('but printing either branch is',       probe("x ? inv.email : ''"));
  ok('a number helper is not a finding',   !probe('Utils.rand(t.amount)'));
  ok('and text outside markup is ignored', !probe('inv.first_name', false),
     'CSV rows, sort keys and search haystacks are not sinks');
}

console.log('\nnothing is escaped twice');
{
  /* The failure mode of a sweep like this is not a missed site, it is a value
     escaped at construction AND again at the sink, which shows the operator
     &amp;#39; where a client typed an apostrophe. Asserted by round-tripping a
     name through the shipped _esc in a browser: escaped once, the rendered
     text must equal the input exactly. */
  const doubled = [...SRC.matchAll(/_esc\([^)]*_esc\(/g)].length;
  ok('no expression escapes inside another', doubled === 0, `${doubled} nested _esc calls`);

  const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                  '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));
  const escSrc = (SRC.match(/^const _esc = .*$/m) || [])[0];
  ok('the shipped _esc was found', !!escSrc);

  if (!CHROME) {
    console.log('  SKIP  no headless Chromium — the round trip was not rendered');
  } else {
    const os = require('os');
    const { execFileSync } = require('child_process');
    const NAME = `Mokoena & Sons <img src=x onerror="window.pwned=1"> O'Brien`;
    const page = `<!doctype html><meta charset="utf-8"><body><div id="h"></div><div id="a"></div><div id="out"></div><script>
${escSrc}
window.pwned = 0;
var v = ${JSON.stringify(NAME)};
document.getElementById('h').innerHTML = '<td><div class="td-strong clip">' + _esc(v) + '</div></td>';
document.getElementById('a').innerHTML = '<li data-name="' + _esc(v) + '"><span>' + _esc(v) + '</span></li>';
document.getElementById('out').textContent = JSON.stringify({
  pwned: window.pwned,
  imgs: document.querySelectorAll('#h img,#a img').length,
  roundTrip: document.getElementById('h').textContent === v,
  attr: document.querySelector('#a li').getAttribute('data-name') === v,
});
<\/script></body>`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escrt-'));
    const file = path.join(dir, 'p.html');
    fs.writeFileSync(file, page);
    let dom = '';
    try {
      dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox',
        '--virtual-time-budget=4000', '--dump-dom', 'file://' + file],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
    } catch (err) { dom = (err.stdout || '').toString(); }
    const mm = dom.match(/id="out">([^<]*)</);
    let r = null;
    try { r = JSON.parse((mm ? mm[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')); }
    catch (_) { /* reported below */ }
    ok('the page reported', !!r, (mm ? mm[1] : dom).slice(0, 200));
    if (r) {
      ok('the name renders as typed, escaped exactly once', r.roundTrip === true,
         'a second escape would show &amp;#39; where the client typed an apostrophe');
      ok('and survives an attribute unchanged', r.attr === true);
      ok('markup in a name does not execute', r.pwned === 0);
      ok('and creates no element', r.imgs === 0, `${r.imgs} <img>`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
