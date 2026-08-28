#!/usr/bin/env node
/* A swallowed error must be a decision, and must look like one.
 *
 * admin.js carried 25 bare `catch (_) {}` blocks. Reading any one of them, you
 * could not tell whether the failure genuinely did not matter or had simply
 * never been handled — and that ambiguity is the actual defect, because it
 * makes the ones that matter invisible among the ones that do not.
 *
 * One of them dropped a KYC rejection reason: the reviewer typed the reason,
 * the save failed, the modal closed and the rejection went through without it.
 * On a rejection that note IS the reason — a compliance record — and nothing
 * on screen said it had gone.
 *
 * Another showed the statutory compliance deadlines and silently omitted every
 * item the firm had added, so the calendar looked complete while missing its
 * own entries.
 *
 * The rest were mostly the same two patterns repeated — parsing JSON out of a
 * text column, and reading browser storage that throws in privacy modes. Those
 * are genuinely fine, so they are named once as helpers rather than left as
 * twenty unexplained catches.
 *
 * Run: node scripts/check-swallowed-errors.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                            .replace(/^\s*\/\/.*$/gm, ' ');

console.log('\nevery remaining swallow is explained');
{
  /* Matched on the RAW source, not on comment-stripped source.

     Stripping blanks a comment's characters, so `catch (_) { /* why *\/ }`
     became `catch (_) {      }` and was counted as bare — the precise opposite
     of the truth, since a comment in the body is what "explained" means. A
     catch is bare only when there is genuinely nothing between its braces.

     Comments are still stripped for the SEARCH so that this file's own prose
     about `catch (_) {}` is not mistaken for code — hence matching raw lines
     but only where the stripped line still holds a catch. */
  const raw     = SRC.split('\n');
  const stripped = stripComments(SRC).split('\n');
  const BARE = /catch\s*\(\s*_\s*\)\s*\{\s*\}|catch\s*\{\s*\}/;

  const bare = [];
  raw.forEach((ln, i) => {
    if (!BARE.test(ln)) return;                       // raw: an empty body
    if (!/catch/.test(stripped[i] || '')) return;     // stripped: real code
    const window = raw.slice(Math.max(0, i - 3), i + 1).join('\n');
    if (!/\/\*|\*\/|\/\//.test(window)) bare.push(i + 1);
  });
  ok('no unexplained `catch (_) {}` remains',
     bare.length === 0,
     `unexplained on line(s): ${bare.join(', ')}`);

  const total = raw.filter((l, i) => BARE.test(l) && /catch/.test(stripped[i] || '')).length;
  ok('and there are few enough left to read', total <= 3, `${total} remain`);
}

console.log('\nthe repeated patterns are named once');
{
  const code = stripComments(SRC);
  ok('_safeParse exists for JSON held in text columns', /const _safeParse = \(raw, fallback\) =>/.test(code));
  ok('_safeStorage exists for storage that throws in privacy modes',
     /const _safeStorage = key =>/.test(code));
  ok('_staffSession exists for the session read four places shared',
     /function _staffSession\(\)/.test(code));
  ok('and the old inline session parsing is gone',
     !/JSON\.parse\(localStorage\.getItem\('staffSession'\)/.test(code) &&
     !/const s = JSON\.parse\(raw\);/.test(code),
     'four sites parsed it by hand, each with its own empty catch');
}

console.log('\nthe helpers behave');
if (!/const _safeParse = /.test(SRC) || !/function _staffSession\(/.test(SRC)) {
  /* Guarded, or the whole file dies on a throw and prints a stack trace with
     no failures — which reads like a pass to anything counting ✗ lines. The
     same crash-instead-of-report happened in check-rate-consistency today. */
  ok('the helpers exist to be exercised', false,
     'missing from admin.js — nothing below can be checked');
} else {
  const sandbox = { console, JSON, String, Object, Date, localStorage: null };
  vm.createContext(sandbox);

  /* Sliced by brace matching. Cutting at the first ';\n' truncated _safeParse
     mid-body — its own `return fallback;` ends a line — and the failure came
     back as "Unexpected end of input", which says nothing about where. */
  function sliceDecl(name) {
    const isFn = SRC.includes(`function ${name}(`);
    const at = SRC.indexOf(isFn ? `function ${name}(` : `const ${name} =`);
    if (at < 0) throw new Error(`${name} not found`);
    let i = SRC.indexOf('{', at), depth = 0;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth++;
      else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
    }
    /* Arrow consts need their trailing semicolon; a function declaration does not. */
    return SRC.slice(at, i + 1) + (isFn ? '' : ';');
  }
  /* Handed out explicitly. A top-level `const` in a vm script stays in that
     script's lexical scope and never lands on the sandbox — the same trap as
     `const Utils` in js/api.js. Function declarations do attach, but the two
     are exported the same way so the difference cannot bite later. */
  for (const name of ['_safeParse', '_safeStorage', '_staffSession']) {
    vm.runInContext(sliceDecl(name) + `\n;globalThis.${name} = ${name};`, sandbox);
  }
  const parse = sandbox._safeParse;
  ok('valid JSON parses', parse('{"a":1}', {}).a === 1);
  ok('invalid JSON falls back rather than throwing', parse('not json', { fallback: true }).fallback === true);
  ok('an object passes straight through', parse({ a: 2 }, {}).a === 2,
     'a JSONB column arrives already parsed on some drivers');
  ok('null and empty fall back', parse(null, 'x') === 'x' && parse('', 'x') === 'x');

  /* Storage that throws is the case the original catches existed for. */
  sandbox.localStorage = { getItem() { throw new Error('SecurityError'); } };
  ok('storage that throws yields null, not an exception', sandbox._safeStorage('k') === null);

  sandbox.localStorage = { getItem: () => JSON.stringify({ empId: 'E1', expiresAt: Date.now() + 60000, firstName: 'A' }) };
  ok('a live session is returned', sandbox._staffSession()?.empId === 'E1');
  sandbox.localStorage = { getItem: () => JSON.stringify({ empId: 'E1', expiresAt: Date.now() - 1 }) };
  ok('an expired one is not', sandbox._staffSession() === null);
  sandbox.localStorage = { getItem: () => 'garbage' };
  ok('and a corrupt one is treated the same as none', sandbox._staffSession() === null);
}

console.log('\nthe two that lost something now say so');
{
  const code = stripComments(SRC);

  const kycAt = code.indexOf('async function _kycReviewReject');
  const kyc = code.slice(kycAt, code.indexOf('\n}\n', kycAt));
  ok('a failed review-note save is reported',
     /review notes failed to save/.test(kyc), kyc.slice(0, 400));
  ok('and the reviewer is asked before the rejection proceeds',
     /await Confirm\.ask\('Your review notes could not be saved\.'/.test(kyc),
     'the note is the reason for the rejection — losing it silently is losing the record');
  ok('cancelling stops the rejection',
     /if \(!proceed\) return;/.test(kyc));

  ok('a compliance calendar missing its own items says so on the page',
     /This calendar is incomplete/.test(SRC),
     'showing only the statutory dates looked complete, which is the worst way to be wrong');
  ok('and the reason is escaped, since it comes from a server error',
     /_esc\(calendarLoadFailed\)/.test(code));
  ok('the flag it depends on is declared',
     /let calendarLoadFailed = null;/.test(code),
     'assigning an undeclared name would throw under strict mode');
}

console.log('\nfetches that would leave the UI blank name themselves');
{
  const code = stripComments(SRC);
  const expected = [
    ['products dropdown', /\[products\] dropdown list failed to load/],
    ['pools for averages', /\[products\] pools failed to load/],
    ['support staff list', /\[support\] staff list failed to load/],
    ['KYC document data',  /\[kyc\] document data failed to load/],
    ['SSE payloads',       /\[sse\] \w+ payload could not be handled/],
  ];
  for (const [label, re] of expected) ok(`${label} logs which fetch failed`, re.test(code));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
