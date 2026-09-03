#!/usr/bin/env node
/* A payout is not income.
 *
 * maturityCron's creditWallet writes ONE transaction when a holding matures,
 * and its amount is the client's CAPITAL COMING BACK plus the return on it.
 * Only the return portion is booked to total_returns. So anything that sums
 * `payout` and calls the result "returns" reports a client's own money back to
 * them as earnings — and it is invisible on tidy data, because it only bites
 * in a period where something actually matured.
 *
 * This was found and fixed FIVE separate times before anyone went looking:
 *
 *   the admin income certificate            a tax document
 *   the investor income certificate         a tax document
 *   the statement's Portfolio Snapshot      "Returns in Period"
 *   the director report email               "Returns Distributed This Month"
 *   analytics                               "Returns Paid" and "Returns YTD"
 *
 * Two of those are tax documents and one goes to the board monthly. The
 * pattern is that `payout` looks like income to anyone reading transaction
 * types without knowing what creditWallet writes.
 *
 * So this is a sweep, not a spot check. It fails on any NEW site that sums
 * payout into something named like income, and it names the known cash
 * figures — the ones where the number is right and the label says "paid out"
 * rather than "returns" — so the difference stays deliberate.
 *
 * Income is `return` and `interest`, from server/services/ledger.js.
 *
 * Run: node scripts/check-payout-not-income.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

console.log('\nthere is one definition of income');
{
  const ledger = read('server/services/ledger.js');
  ok('services/ledger names it',
     /INCOME_TYPES = \['return', 'interest'\]/.test(strip(ledger)),
     'every server sum should reach for incomeTypesSQL() rather than listing types again');
  ok('and payout is not in it',
     !/INCOME_TYPES = \[[^\]]*payout/.test(strip(ledger)));

  const core = read('js/portal-core.js');
  ok('the client has the same definition, in one place',
     /function _isIncomeTxn\(t\) \{[\s\S]{0,160}\['return', 'interest'\]/.test(core),
     'three client sites listed the types inline; a fourth would have been a fourth answer');
}

/* Files that compute money figures. Excludes the checks themselves — they say
   "payout" constantly, describing the bug. */
const SOURCES = [
  'server/jobs/directorReportCron.js',
  'server/routes/analytics-extra.js',
  'server/routes/tables.js',
  'server/services/accountStatement.js',
  'server/services/incomeReference.js',
  'server/routes/statements.js',
  'js/portal-core.js',
  'js/sv-intelligence.js',
  'js/investor-documents.js',
  'portal/js/portal.js',
  'mobile/src/js/portal.js',
  'admin/js/admin.js',
];

/* Where summing a payout is CORRECT, and why. A payout is a cash credit: it
   moves money into the wallet, it belongs in a balance, and it belongs in a
   figure honestly labelled as cash paid out. Named individually so that a new
   one has to be added deliberately rather than slipping in. */
const ALLOWED = [
  // [file, a fragment that identifies the line, why]
  ['server/services/ledger.js',        'CASH_CREDIT_TYPES', 'a payout really is a cash credit'],
  ['server/services/accountStatement.js', "sumTypes('payout', 'interest')",
                                       'the statement\'s cash section, labelled "Paid out to you"'],
  ['server/routes/tables.js',          '_moneyTypes',       'wallet crediting, not reporting'],
  ['server/routes/tables.js',          "u.type === 'payout'", 'wallet crediting, not reporting'],
  ['js/portal-core.js',                'const CREDIT =',    'credit/debit direction'],
  ['js/portal-core.js',                "['deposit', 'return', 'payout', 'referral_bonus']",
                                       'credit/debit direction'],
  ['js/sv-intelligence.js',            'const totalReturns', 'cash; the tile reads "Paid to Investors"'],
  ['js/sv-intelligence.js',            'const totalPaid',    'cash; the tile reads "Paid to Investors to Date"'],
  ['js/sv-intelligence.js',            'const retTxns',      'cash; the row reads "Returns & Payouts"'],
  ['admin/js/admin.js',                'const payouts',      'the flow chart series is labelled "Payouts"'],
  ['admin/js/admin.js',                'received ${Utils.rand', 'the activity feed says "received", and names the type'],
  ['portal/js/portal.js',              '_isCreditTx',       'credit/debit direction'],
  ['mobile/src/js/portal.js',          '_isCreditTx',       'credit/debit direction'],
];

/* A line that combines `payout` with `return` AND reads like income.
 *
 * Deliberately narrow. The first version matched any line mentioning payout
 * beside the word "return", which caught a type-ALIAS map
 * (payout: ['payout','payout_all','maturity_payout','capital_return',…]) and
 * the maturity INSTRUCTION names (payout_all, payout_return, …). Neither sums
 * anything; both mention both words. A detector that cries wolf on those gets
 * its allow-list padded until it catches nothing. */
const COMBINES = /\['return',\s*'payout'\]|\['payout',\s*'return'\]|IN \('return','payout'\)|t\.type === 'return' \|\| t\.type === 'payout'|'payout',\s*'interest'/;
const LOOKS_LIKE_INCOME = /returns?\b|income|earn/i;

console.log('\nno new site sums a payout into something called a return');
{
  const offenders = [];
  for (const rel of SOURCES) {
    /* Comments are blanked rather than deleted, so a reported line number is
       the line in the actual file. Stripping them outright shifted every
       number after the first comment and sent the reader to the wrong place. */
    const raw = read(rel).split('\n');
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
      .replace(/^\s*\/\/.*$/gm, m => m.replace(/[^\n]/g, ' '))
      .split('\n');
    src.forEach((ln, i) => {
      if (!COMBINES.test(ln) || !LOOKS_LIKE_INCOME.test(ln)) return;
      /* A site may declare itself, in place, with
             /* payout-is-cash: why * /
         on its own line or the one above. A marker beside the code beats a
         central list that drifts away from what it is describing — and it
         forces whoever writes the line to say why it is not income. */
      const marked = /payout-is-cash:/.test(raw[i] || '') ||
                     /payout-is-cash:/.test(raw[i - 1] || '');
      const allowed = marked || ALLOWED.some(([f, frag]) => f === rel && ln.includes(frag));
      if (!allowed) offenders.push(`${rel}:${i + 1}  ${raw[i].trim().slice(0, 110)}`);
    });
  }
  ok('every payout sum is either income-free or a named cash figure',
     offenders.length === 0,
     offenders.join('\n      ') +
     '\n      — if the figure really is cash, label it "paid out" rather than ' +
     '"returns" and mark the line /* payout-is-cash: why */');
}

console.log('\nthe five sites that were wrong are still right');
{
  const dir = strip(read('server/jobs/directorReportCron.js'));
  ok('the director report sums income, not payouts',
     /incomeTypesSQL\(\)/.test(dir) && !/IN \('return','payout'\)/.test(dir),
     '"Returns Distributed This Month" goes to the board');
  ok('and windows it on the date the money moved',
     /COALESCE\(transaction_date, created_at\) >= \$1/.test(dir),
     'created_at puts a back-dated transaction in the wrong month');

  const an = strip(read('server/routes/analytics-extra.js'));
  ok('analytics "Returns Paid" and "Returns YTD" sum income',
     (an.match(/incomeTypesSQL\(\)/g) || []).length >= 2 &&
     !/IN \('return','payout'\)/.test(an));

  const core = strip(read('js/portal-core.js'));
  ok('the monthly returns chart plots income',
     /_isIncomeTxn\(t\) && _stmtCounts\(t\)/.test(core),
     'a maturity month spiked by the size of the holding');
  ok('and the statement figures count income',
     /returns:\s*_stmtRound\(\(byType\.return \|\| 0\) \+ \(byType\.interest \|\| 0\)\)/.test(core));

  for (const rel of ['portal/js/portal.js', 'mobile/src/js/portal.js']) {
    ok(`${rel} sums income for its returns figure`,
       /_isIncomeTxn\(t\) && t\.status !== 'cancelled'/.test(strip(read(rel))));
  }

  const docs = read('js/investor-documents.js');
  ok('the statement calls the cash row "Paid out to you"',
     /Paid out to you/.test(docs) && !/Returns paid to you/.test(docs),
     'the figure is cash and correct; calling it a return told a client their ' +
     'own capital was money they had earned');
  ok('and says what is in it',
     /maturity payouts \(capital \+ return\) and interest/.test(docs));
}

console.log('\nand the things a payout legitimately is');
{
  const ledger = strip(read('server/services/ledger.js'));
  ok('a payout still credits the wallet', /CASH_CREDIT_TYPES[^\]]*payout/.test(ledger),
     'it moves real money — removing it would break every balance');
  const tables = strip(read('server/routes/tables.js'));
  ok('and total_returns is still only moved by `return`',
     /u\.type === 'return'\)\s*\{[\s\S]{0,200}total_returns/.test(tables),
     'the stored field is the one figure that was always right');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
