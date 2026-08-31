#!/usr/bin/env node
/* Every column a console writes must exist.
 *
 * This is the third time the same defect has been found by hand, and the second
 * time it had silently disabled a whole feature:
 *
 *   cattle_animals had no exit_mass, so every Add/Edit Animal save 500'd.
 *   cattle_costs had none of the seven columns the Cycle Costs tab wrote, so no
 *     cost entry had ever been recorded.
 *   fund_runs has none of the fifteen the Fund Ops console writes, so no fund
 *     run had ever been created and every seeded run rendered as zeros.
 *
 * The shape is always the same and it is invisible to review: the client and
 * the schema were written at different times by different hands, the generic
 * table API builds its INSERT straight from the request body, and Postgres only
 * complains at runtime — to a catch block that shows a generic toast. Nothing
 * fails at build, nothing fails at load, and the feature is simply inert.
 *
 * So: read the REAL columns out of a database built by this repo's own setup,
 * read the keys every client actually writes, and compare. Reading the schema
 * from information_schema rather than from setup.js matters — setup.js is not
 * the only thing that shapes the database, and a check that compares source to
 * source cannot see a migration that never ran.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-schema-contract.cjs
 *      …--list   print every write site and its keys, for auditing
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const pool = require(path.join(__dirname, '..', 'db', 'pool'));

const ROOT = path.join(__dirname, '..', '..');
const LIST = process.argv.includes('--list');

/* The client files that write through the generic table API. dist/ is a stale
   tracked copy that nothing serves, and node_modules is not ours. */
const SOURCES = [
  'fund/js/fund.js',
  'fund/js/cattle.js',
  'fund/js/solar.js',
  'admin/js/admin.js',
  'team/js/employee.js',
];

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ── Finding the writes ────────────────────────────────────────────────────
   Three call shapes are in use across the consoles:

     apiPost('table', {…})            apiPatch('table', id, {…})
     apiPost('tables/table', {…})     apiPatch(`tables/table/${id}`, {…})
     apiFetch('tables/table', { method:'POST', body: JSON.stringify({…}) })

   The payload is often a variable rather than a literal, so an identifier is
   resolved one level by looking back for its `const <name> = {` in the same
   file. One level is enough for every site here and stops well short of
   evaluating the file, which is the thing this must not do. */

function matchBrace(src, from, open = '{', close = '}') {
  let i = src.indexOf(open, from);
  if (i < 0) return null;
  let depth = 0, inStr = null;
  for (; i < src.length; i++) {
    const c = src[i], prev = src[i - 1];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return { start: src.indexOf(open, from), end: i }; }
  }
  return null;
}

/* Top-level keys of an object literal. Nested objects and arrays are skipped —
   only the outer keys become columns. */
function objectKeys(body) {
  const keys = [];
  let depth = 0, inStr = null, atKey = true, token = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i], prev = body[i - 1];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; else token += c; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '`') { inStr = c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; continue; }
    if (depth > 0) continue;
    if (c === ',') { atKey = true; token = ''; continue; }
    if (c === ':' && atKey) {
      const k = token.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) keys.push(k);
      atKey = false; token = '';
      continue;
    }
    if (atKey) token += c;
  }
  return keys;
}

/* `at` is the offset of the call site. An identifier is resolved to the NEAREST
   PRECEDING declaration, not the first one in the file — several of these
   consoles name every payload `data` or `payload`, and taking the first match
   attributed the cycle form's fields to the animal table and reported eleven
   columns missing from cattle_animals that the animal form never writes. A
   wrong finding costs more than a missing one: it sends someone to fix code
   that is correct. */
function resolveArg(src, arg, at) {
  const trimmed = arg.trim();
  if (trimmed.startsWith('{')) {
    const b = matchBrace(trimmed, 0);
    return b ? objectKeys(trimmed.slice(b.start + 1, b.end)) : [];
  }
  if (trimmed.startsWith('JSON.stringify(')) return resolveArg(src, trimmed.slice(15, -1), at);
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const re = new RegExp(`(?:const|let|var)\\s+${trimmed}\\s*=\\s*\\{`, 'g');
    let best = null, m;
    while ((m = re.exec(src)) && m.index < at) best = m.index;
    if (best === null) return null;
    /* And it must be in the same function: a declaration before the call but
       inside a different function body is not this payload either. */
    const fnStart = Math.max(
      src.lastIndexOf('\nfunction ', at), src.lastIndexOf('\nasync function ', at));
    if (fnStart > best) return null;
    const b = matchBrace(src, best);
    return b ? objectKeys(src.slice(b.start + 1, b.end)) : null;
  }
  return null;                                    // unresolvable — reported, not guessed
}

/* Split a call's arguments at top level. */
function splitArgs(text) {
  const args = [];
  let depth = 0, inStr = null, cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], prev = text[i - 1];
    if (inStr) { cur += c; if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; continue; }
    if ('{[('.includes(c)) depth++;
    if ('}])'.includes(c)) depth--;
    if (c === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) args.push(cur);
  return args;
}

const TABLE_RE = /(?:apiPost|apiPatch|apiPut|apiFetch)\s*\(\s*[`'"](?:tables\/)?([a-z_]+)(?:\/\$\{[^}]*\}|\/[^`'"]*)?[`'"]/g;

function writesIn(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    /* Comments explain these very defects by naming the old columns; scanning
       them would report the fix's own description as a defect. */
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

  const out = [];
  let m;
  TABLE_RE.lastIndex = 0;
  while ((m = TABLE_RE.exec(src))) {
    const table = m[1];
    const callStart = src.lastIndexOf('(', m.index + m[0].length - 1);
    const paren = matchBrace(src, m.index + m[0].indexOf('('), '(', ')');
    if (!paren) continue;
    const args = splitArgs(src.slice(paren.start + 1, paren.end));
    if (args.length < 2) continue;                 // a GET or a DELETE

    /* apiFetch's second argument is an options object carrying method + body. */
    const second = args[1].trim();
    let payloadArg = null, method = 'POST';
    if (/method\s*:/.test(second)) {
      const mm = /method\s*:\s*['"`](\w+)['"`]/.exec(second);
      method = mm ? mm[1].toUpperCase() : 'POST';
      if (method === 'DELETE' || method === 'GET') continue;
      const bodyIdx = second.indexOf('body');
      if (bodyIdx < 0) continue;
      payloadArg = second.slice(second.indexOf(':', bodyIdx) + 1).replace(/,?\s*\}$/, '');
    } else {
      payloadArg = args.length >= 3 ? args[2] : args[1];
      method = args.length >= 3 ? 'PATCH' : 'POST';
    }

    const keys = resolveArg(src, payloadArg, m.index);
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ table, method, keys, line, raw: payloadArg.trim().slice(0, 60) });
  }
  return out;
}

/* ── The real columns ──────────────────────────────────────────────────── */
(async () => {
  try {
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'`);
    const columns = {};
    for (const r of rows) (columns[r.table_name] ||= new Set()).add(r.column_name);

    ok('the database has a schema to check against', Object.keys(columns).length > 10,
       `${Object.keys(columns).length} tables — autoSetup may not have run`);

    /* Not a column, but accepted: the table API strips these itself before
       building its statement. */
    const IGNORED = new Set(['id']);

    const problems = [];
    const unresolved = [];

    console.log('\nevery column the consoles write exists');
    for (const rel of SOURCES) {
      if (!fs.existsSync(path.join(ROOT, rel))) continue;
      for (const w of writesIn(rel)) {
        if (!columns[w.table]) continue;           // not a real table — covered below
        if (w.keys === null) { unresolved.push(`${rel}:${w.line} ${w.method} ${w.table} ← ${w.raw}`); continue; }
        if (LIST) console.log(`    ${rel}:${w.line} ${w.method} ${w.table} { ${w.keys.join(', ')} }`);
        const missing = w.keys.filter(k => !IGNORED.has(k) && !columns[w.table].has(k));
        if (missing.length) problems.push({ rel, ...w, missing });
      }
    }

    /* Grouped by table: fifteen missing columns on one table is one defect, not
       fifteen, and a per-key list buries which feature is dead. */
    const byTable = {};
    for (const p of problems) (byTable[p.table] ||= []).push(p);

    for (const [table, ps] of Object.entries(byTable)) {
      const all = [...new Set(ps.flatMap(p => p.missing))];
      ok(`${table} — every written column exists`, false,
         `${all.length} missing: ${all.join(', ')}\n      ` +
         ps.map(p => `${p.rel}:${p.line} ${p.method}`).join('\n      ') +
         `\n      Every write here fails with "column ... does not exist"; the console shows a generic error.`);
    }
    if (!Object.keys(byTable).length)
      ok('no console writes a column its table does not have', true);

    /* A write to a table that does not exist at all. */
    console.log('\nevery table the consoles read and write exists');
    const unknown = new Set();
    for (const rel of SOURCES) {
      if (!fs.existsSync(path.join(ROOT, rel))) continue;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
      for (const mm of src.matchAll(/(?:apiGet|apiPost|apiPatch|apiDelete|intFetchAll|fetchAll|safeGet)\s*\(\s*[`'"](?:tables\/)?([a-z_]{4,})[`'"\/?]/g)) {
        const t = mm[1];
        if (!columns[t] && !/^(admin|cattle|api|opsconsole|reconcile|tables)$/.test(t)) unknown.add(`${rel}: ${t}`);
      }
    }
    ok('no console fetches a table that does not exist', unknown.size === 0,
       [...unknown].join('\n      ') +
       '\n      intFetchAll swallows the error and returns [], so the panel renders empty rather than broken.');

    if (unresolved.length && LIST) {
      console.log('\n  payloads this check could not resolve (reported, not assumed safe):');
      unresolved.forEach(u => console.log('    ' + u));
    }
    ok('every write payload could be resolved to a set of keys',
       unresolved.length === 0,
       `${unresolved.length} unresolved — run with --list to see them. An unresolved payload is ` +
       'unchecked, which is how this class of defect survives.');

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
