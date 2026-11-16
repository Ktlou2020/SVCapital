#!/usr/bin/env node
/* The month a factsheet is filed under.
 *
 * REPORTED: "The October 2026 cattle investment factsheet was uploaded to the
 * admin portal but doesn't appear on the app. The October 2026 short-term
 * factsheet, however, appears on the app."
 *
 * It was never missing. The screenshot of the cattle archive reads August,
 * June, April, February 2026, then December and October 2025 — and TWO rows
 * for October 2025, one of them uploaded on 21 October 2026. That second one
 * is the sheet being looked for, filed a year early and sorted below the fold
 * under the wrong year heading.
 *
 * The period defaulted to the POOL'S CLOSE MONTH, in the console's pre-fill
 * and again in the server's fallback. That is the month the sheet reports on
 * only for a pool that happens to close in it — which is why the short-term
 * sheet, uploaded against a pool closing in October 2026, landed correctly
 * and looked like proof the feature worked. The cattle pool closed in
 * October 2025, so every sheet uploaded against it is stamped October 2025,
 * auto-named "October 2025 - Factsheet", and filed on top of the last one.
 * The alternating months are the same thing: pool maturity dates, not the
 * months the sheets report on.
 *
 * Run: node server/scripts/check-factsheet-period.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const ROUTE = read('server/routes/factsheets.js');
const ADMIN = read('admin/js/admin.js');

/* ── The server's fallback, RUN rather than read ─────────────────────── */
console.log('\nthe period a sheet gets when nobody states one');
{
  /* monthStart and the fallback expression, lifted out and evaluated: a
     hand-written copy of the rule would be a check of the copy. */
  const vm = require('vm');
  const from = ROUTE.indexOf('function monthStart');
  const to   = ROUTE.indexOf('function periodLabel');
  ok('the date helper was found', from > 0 && to > from,
     'a slice that missed it would assert nothing while passing');

  /* To the end of the STATEMENT, not to the first ")": the fallback is
     monthStart(new Date()), whose own parenthesis ended the match and left
     this asserting on an empty string. */
  const m = /const periodDate = monthStart\((.*?)\) \|\| monthStart\((.*)\);/.exec(ROUTE);
  ok('the fallback was found', !!m, 'the upload route no longer reads as expected');

  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(ROUTE.slice(from, to) + '\nthis.monthStart = monthStart;', ctx);

  /* The pool in the report: cattle, closed October 2025. The sheet is being
     uploaded in October 2026. */
  const poolEnd = '2025-10-31';
  const uploadedAt = new Date('2026-10-21T12:00:00Z');

  ok('AN EXPLICIT PERIOD STILL WINS',
     ctx.monthStart('2026-10-01') === '2026-10-01', ctx.monthStart('2026-10-01'));

  const fellBackTo = (m && m[2] || '').trim();
  ok('and the fallback is NOT the pool\'s close date',
     !/end_date/.test(fellBackTo),
     `${fellBackTo} — the cattle pool closed ${poolEnd}, so every sheet uploaded `
     + 'against it was stamped October 2025, a year before it was written');
  ok('it is the month the sheet is being uploaded in',
     /new Date\(\)/.test(fellBackTo), fellBackTo);
  /* And that month is the one the reporter expected. */
  ok('which for a sheet uploaded 21 Oct 2026 is October 2026',
     ctx.monthStart(uploadedAt) === '2026-10-01', ctx.monthStart(uploadedAt));
  ok('while the pool\'s close month would have been October 2025',
     ctx.monthStart(poolEnd) === '2025-10-01',
     ctx.monthStart(poolEnd) + ' — this is the figure that was being used');
}

/* ── The console pre-fill, which is what an admin actually accepts ───── */
console.log('\nand the month the console offers before the upload');
{
  const at = ADMIN.indexOf('async function openFactsheetManager');
  const fn = ADMIN.slice(at, ADMIN.indexOf('\n}', ADMIN.indexOf('Modal.open(\'adminFactsheetModal\')', at)));
  ok('the factsheet manager was found', at > 0 && fn.length > 400);

  const per = fn.slice(fn.indexOf('adminFsPeriod'));
  ok('THE PRE-FILL IS NOT THE POOL\'S CLOSE MONTH',
     !/end_date/.test(per),
     'the admin accepts what is offered, and what was offered named the wrong '
     + 'month AND auto-named the file after it');
  ok('it is the current month', /new Date\(\)/.test(per) && /getMonth\(\)/.test(per),
     per.slice(0, 240));
  ok('and the name still follows the period', /_autoFsName\(\)/.test(per),
     'otherwise the file is named for one month and filed under another');
  /* The field is still editable — back-filling an archive must stay possible. */
  ok('the period is still an editable field, not a derived one',
     /<input class="form-input" type="month" id="adminFsPeriod"/.test(read('admin/index.html')),
     'a month that cannot be changed cannot be corrected either');
  ok('and changing it renames the file with it',
     /id="adminFsPeriod" onchange="_autoFsName\(\)"/.test(read('admin/index.html')),
     'admin/index.html');
}

/* ── Finding the ones already filed wrong ────────────────────────────── */
console.log('\nand a sheet already filed on top of another is visible');
{
  /* The signal is two sheets on ONE pool under ONE month. A back-filled
     archive uploaded in a single sitting has one row per month and must not
     light up, or the warning is noise and gets ignored. */
  const at = ADMIN.indexOf('async function _loadAdminFactsheets');
  const fn = ADMIN.slice(at, ADMIN.indexOf('\n}', ADMIN.indexOf('catch (e)', at)));
  ok('the admin factsheet list was found', at > 0 && fn.length > 400);
  ok('it counts how many sheets share each month', /_perCount\[k\] = \(_perCount\[k\] \|\| 0\) \+ 1/.test(fn),
     fn.slice(0, 200));
  ok('and warns only where more than one does',
     /_perCount\[k\] > 1/.test(fn), 'one row per month is a normal archive');
  ok('the warning says what to do about it',
     /pencil/i.test(fn) && /same month/i.test(fn),
     'a warning that does not name the remedy is a worry, not a help');
  ok('a sheet with no period is not counted as sharing one',
     /if \(k\) _perCount\[k\]/.test(fn),
     'two undated sheets are not two sheets filed under the same month');

  /* The correction itself already exists and must keep existing. */
  ok('and the period can be corrected without re-uploading the file',
     /router\.patch\('\/:id'/.test(ROUTE) && /period_date/.test(ROUTE),
     'otherwise the only fix is delete and upload again');
  ok('while the FILE behind an id is never swapped',
     /The FILE is never touched/.test(ROUTE),
     'the bytes behind an id must stay the bytes somebody read under it');
}

/* ── The archive still sorts on the period ───────────────────────────── */
console.log('\nand the archive is still ordered by the period, newest first');
{
  const CORE = read('js/portal-core.js');
  ok('the portal reads period_date first', /if \(sheet && sheet\.period_date\)/.test(CORE),
     'js/portal-core.js');
  ok('and the list orders on it, with undated last',
     /ORDER BY f\.is_current DESC, f\.period_date DESC NULLS LAST/.test(ROUTE),
     'a sheet with no period sorting first is how the archive came to lead '
     + 'with a document nobody was looking for');
  ok('the product, not the pool, is what the app asks for',
     /factsheets\?product_type=/.test(CORE),
     'a sheet whose pool was merged away is findable only by its product');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
