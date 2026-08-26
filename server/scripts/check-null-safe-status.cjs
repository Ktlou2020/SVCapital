#!/usr/bin/env node
/* A status filter must not silently drop rows whose status is NULL.
 *
 * Columns added by `ALTER TABLE … ADD COLUMN status TEXT DEFAULT 'x'` only get
 * that default on NEW rows. Every row that existed before the migration holds
 * NULL — and `NULL <> 'archived'` is NULL, which is not true, so the row is
 * excluded from a filter meant to include it.
 *
 * It bit three different ways in this codebase:
 *
 *   · Investors with a NULL status received no broadcast and no automated FICA
 *     check. Nothing errored; they simply were not in the result.
 *   · Two repair endpoints — backfill/fica-from-kyc and restore/investor-statuses
 *     — skipped precisely the rows they exist to repair, because NULL is the
 *     commonest way for a status to be out of step. Staff ran them, saw a low
 *     count, and concluded there was nothing to fix.
 *   · Pool investor and investment counts under-reported, and an analytics
 *     dashboard showed active + dormant not adding up to total.
 *
 * Equality is fine: `status = 'active'` is false for NULL, which is correct.
 * Only negation needs COALESCE.
 *
 * Run: node server/scripts/check-null-safe-status.cjs
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

/* Status-like values. Deliberately not every string literal — comparing a
   free-text column is not the same risk, and a check that cries wolf gets
   turned off. */
const STATUS_VALUES = [
  'archived', 'suspended', 'active', 'approved', 'cancelled', 'completed',
  'rejected', 'pending', 'matured', 'paid_out', 'resolved', 'closed',
];

const NEGATED = new RegExp(`(!=|<>)\\s*'(${STATUS_VALUES.join('|')})'`);

/* Deliberate exceptions, each with the reason it is safe. */
const ALLOWED = [
  {
    file: 'server/routes/manualCredit.js',
    match: /WHERE id = \$3 AND status <> 'completed'/,
    why: 'guards a double credit — a NULL status there would mean a broken row, and skipping it is correct',
  },
  {
    file: 'server/routes/tables.js',
    match: /WHERE \$\{key\} = \$\$\{values\.length\} AND status <> 'completed'/,
    why: 'same double-credit guard on the generic transactions PATCH',
  },
];

function scan(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  /* Block-comment state has to be tracked across lines. A prose line inside a
     /* … *\/ block that happens to quote `NULL <> 'approved'` — which the
     comments explaining this very trap do — starts with neither // nor *, so
     a per-line test flags the explanation as the offence. */
  let inBlock = false;
  fs.readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
    const wasInBlock = inBlock;
    const opens = line.lastIndexOf('/*');
    const closes = line.lastIndexOf('*/');
    if (!inBlock && opens !== -1 && closes < opens) inBlock = true;
    else if (inBlock && closes !== -1 && closes > opens) inBlock = false;
    if (wasInBlock || inBlock) return;                   // inside a block comment
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;         // line comment
    if (!NEGATED.test(line)) return;
    if (line.includes('COALESCE')) return;               // guarded
    if (ALLOWED.some(a => a.file === rel && a.match.test(line))) return;
    out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 96)}`);
  });
  return out;
}

function walk(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter(f => f.endsWith('.js'))
    .map(f => path.join(dir, f));
}

const files = [...walk('server/routes'), ...walk('server/jobs'), ...walk('server/services')];

console.log(`\nnegated status comparisons must tolerate NULL  (${files.length} files)`);
const offenders = files.flatMap(scan);
ok('no unguarded negated status comparison', offenders.length === 0,
   offenders.join('\n      ') + '\n      Use COALESCE(col, \'\') <> \'value\'.');

/* The specific places it was doing damage, so a revert is caught by name
   rather than only by the general rule. */
console.log('\nthe sites it was excluding people from');
const cases = [
  ['broadcasts reach investors with no status',
   'server/routes/broadcast.js', /COALESCE\((i\.)?status, ''\) <> 'archived'/, 4],
  ['the FICA sweep does not skip them',
   'server/routes/fica.js', /COALESCE\((i\.)?status, ''\) <> 'suspended'/, 2],
  ['nor does the FICA cron',
   'server/jobs/ficaCron.js', /COALESCE\((i\.)?status, ''\) <> 'suspended'/, 2],
  ['the FICA backfill repairs the rows it exists for',
   'server/routes/manualCredit.js', /COALESCE\(fica_status, ''\) <> 'approved'/, 1],
  ['so does the status restore',
   'server/routes/manualCredit.js', /COALESCE\(i\.kyc_status, ''\) <> 'approved'/, 2],
  ['pool counts include investments with no status',
   'server/routes/tables.js', /COUNT\(CASE WHEN COALESCE\(status, ''\) <> 'cancelled'/, 2],
  ['active + dormant adds up to total',
   'server/routes/analytics-extra.js', /COUNT\(\*\) FILTER \(WHERE COALESCE\(status, ''\) <> 'active'\)/, 1],
];
for (const [label, rel, re, min] of cases) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const n = (src.match(new RegExp(re.source, 'g')) || []).length;
  ok(`${label} (${n}/${min})`, n >= min, `${rel}: found ${n}, expected at least ${min}`);
}

console.log('\nequality is left alone — it is already correct for NULL');
{
  const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'broadcast.js'), 'utf8');
  ok('no COALESCE was added around an equality test',
     !/COALESCE\([a-z_.]+, ''\) = '/.test(src),
     'status = \'active\' is false for NULL, which is what is wanted');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
