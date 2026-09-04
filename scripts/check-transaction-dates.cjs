#!/usr/bin/env node
/* One date for a transaction, and one for an investment.
 *
 * `created_at` is when the ROW was written. `transaction_date` is when the
 * money moved. On a ledger that has been through a batch migration they are
 * nothing alike: the import stamps every row it writes with the same
 * created_at, so a deposit made in 2023 reads as having happened on the day of
 * the migration.
 *
 * Both orderings were in use across the platform. `transaction_date ||
 * created_at` in some places and `created_at || transaction_date` in others,
 * which is not a style difference — it means one ledger row showed two
 * different dates depending on which screen you were on. The transactions CSV
 * showed a third, because it read created_at alone; so did the platform-fees
 * export and the withdrawals export, which are exports OF transactions.
 *
 * The server had already settled it, in the two queries that produce a client's
 * statement and their income certificate:
 *
 *     COALESCE(transaction_date, created_at) AS txn_date
 *
 * Utils.txnDate() is that, for the client. Utils.invDate() is the same question
 * for an investment, where start_date is the day the money went to work and
 * some imports carry investment_date instead.
 *
 * The CSV halves are separate assertions because a date on a screen and a date
 * in a spreadsheet fail differently: on screen a missing one is an em-dash a
 * person can see, and in a CSV it is a blank cell in a column someone is about
 * to reconcile a bank statement against.
 *
 * Run: node scripts/check-transaction-dates.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
/* Comments blanked, newlines kept — this file's own explanation names the
   defect, and a negative scan would find it and report the bug as present. */
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const API   = read('js/api.js');
const ADMIN = read('admin/js/admin.js');
const CORE  = read('js/portal-core.js');
const DOCS  = read('js/investor-documents.js');

console.log('\nthere is one definition of when a transaction happened');
{
  ok('Utils.txnDate prefers the movement date',
     /txnDate\(t\) \{[\s\S]{0,200}t\.txn_date \|\| t\.transaction_date \|\| t\.created_at/.test(API),
     'created_at is when the row was written; on a migrated ledger that is the ' +
     'day of the import, for every row in it');
  ok('and Utils.invDate does the same for an investment',
     /invDate\(i\) \{[\s\S]{0,200}i\.start_date \|\| i\.investment_date \|\| i\.created_at/.test(API));

  ok('it agrees with what the server already decided',
     /COALESCE\(transaction_date, created_at\) AS txn_date/.test(read('server/services/accountStatement.js')) &&
     /COALESCE\(transaction_date, created_at\) AS txn_date/.test(read('server/services/incomeReference.js')),
     'the statement and the income certificate are the two documents a client ' +
     'takes to SARS; the screens must not disagree with them');
}

console.log('\nand nothing reaches for the row-write date first');
{
  const files = ['admin/js/admin.js', 'js/portal-core.js', 'js/investor-documents.js',
                 'portal/js/portal.js', 'mobile/src/js/portal.js'];
  const offenders = [];
  for (const f of files) {
    strip(read(f)).split('\n').forEach((l, i) => {
      if (/created_at\s*\|\|\s*\w*\.?transaction_date/.test(l) ||
          /created_at\s*\|\|\s*\w*\.?start_date/.test(l)) {
        offenders.push(`${f}:${i + 1}  ${l.trim().slice(0, 100)}`);
      }
    });
  }
  ok('no site puts created_at ahead of the movement date',
     offenders.length === 0,
     offenders.join('\n      ') +
     '\n      — use Utils.txnDate() / Utils.invDate(); two orderings means one ' +
     'row with two dates depending on the screen');
}

console.log('\nevery export of a transaction carries when it happened');
{
  /* These three list transactions. All three dated them by created_at. */
  for (const [fn, label] of [
    ['exportTransactionsCSV', 'the transaction ledger'],
    ['exportPlatformFeesCSV', 'platform fees'],
    ['exportWithdrawalCSV',   'withdrawals'],
  ]) {
    const at = ADMIN.indexOf(`function ${fn}(`);
    const body = at < 0 ? '' : strip(ADMIN.slice(at, ADMIN.indexOf('\n}\n', at)));
    ok(`${label} is dated by the movement, not the row`,
       body.length > 40 && /Utils\.txnDate\(/.test(body) && !/\br\.created_at\b|\bt\.created_at\b/.test(body),
       `${fn}: ${body ? 'still reads created_at' : 'not found'}`);
  }

  const invAt = ADMIN.indexOf('function exportInvestmentsCSV(');
  const invBody = strip(ADMIN.slice(invAt, ADMIN.indexOf('\n}\n', invAt)));
  ok('the investments export falls back when start_date is missing',
     /Utils\.invDate\(i\)/.test(invBody),
     'it read start_date alone, so an investment without one exported a blank date');

  ok('and the ledger export carries the time as well as the date',
     /'Date','Time'\]/.test(strip(ADMIN)) && /Utils\.csvTime\(Utils\.txnDate\(t\)\)/.test(ADMIN),
     'a day of movements in an unordered block cannot be reconciled against a ' +
     'bank statement line by line');
}

console.log('\na date written for a spreadsheet is unambiguous');
{
  ok('there is a CSV-specific formatter',
     /csvDate\(v\) \{/.test(API) && /csvTime\(v\) \{/.test(API));
  ok('it writes ISO',
     /toLocaleDateString\('en-CA'\)/.test(API),
     '04/09/2026 is September here and April in a US locale, and Excel decides ' +
     'which without asking');
  ok('and empty rather than an em-dash when there is no date',
     /csvDate\(v\) \{\s*if \(!v\) return '';/.test(API),
     "Utils.date() draws '—' for a screen; in a CSV that is a value a filter has " +
     'to be taught to ignore');
  /* toISOString() would move a 01:30 SAST transaction to the previous day. */
  ok('formatted in the reader\'s own timezone, not UTC',
     !/csvDate\(v\)[\s\S]{0,200}toISOString/.test(API),
     'toISOString on a 01:30 SAST movement reports the day before');
}

console.log('\nthe documents a client keeps carry it too');
{
  ok('the statement ledger dates each line',
     /<td>\$\{fmtDate\(t\.txn_date \|\| t\.transaction_date \|\| t\.created_at\)\}<\/td>/.test(DOCS));
  ok('the income certificate dates each line',
     /const rowDate = t => fmtDate\(t\.txn_date \|\| t\.created_at\)/.test(DOCS));
  ok('the statement\'s investment tables are dated',
     /<th>Date<\/th><th>Pool Name<\/th>/.test(DOCS) &&
     (DOCS.match(/fmtDate\(i\.start_date \|\| i\.created_at\)/g) || []).length >= 3,
     'the two on-screen tables and the CSV the page offers');
  ok('and the statement CSV carries a date column',
     /\['Date','Pool Name','Product'/.test(DOCS));
}

console.log('\nthe admin screens show a date wherever they list either');
{
  ok('the transactions table has a Date column',
     /data-sort="_date"\s+data-sort-type="date">Date</.test(read('admin/index.html')));
  ok('the investments table has one',
     /data-sort="start_date"\s+data-sort-type="date">Date</.test(read('admin/index.html')));
  ok('the transaction rows render it from the movement date',
     /Utils\.date\(t\.transaction_date\|\|t\.created_at\)/.test(ADMIN));
  ok('and the investment detail names the date the money went to work',
     /Investment Date<\/span><span class="info-row__value td-muted">\$\{Utils\.date\(Utils\.invDate\(inv\)\)\}/.test(ADMIN),
     'it read start_date alone — an investment without one showed an em-dash ' +
     'where its date belongs');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
