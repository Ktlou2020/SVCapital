#!/usr/bin/env node
/* The maturities CSV: short instructions, no named-amount column, and a
 * summary that adds up to the detail above it.
 *
 * The report on screen and the PDF keep the full sentences — "Pay out a set
 * amount, switch the rest" tells a client what happens to their money. A
 * spreadsheet column is not read as a sentence: it is sorted, filtered and
 * pivoted, and a phrase with a comma in it does all three badly. So the CSV
 * has its own labels, and this file is what keeps the two from drifting.
 *
 * The summary is counted per INVESTMENT while the detail writes one line per
 * DESTINATION, so an instruction with two legs appears twice above and once
 * below. Getting that wrong doubles a custom switch and its capital, which is
 * the failure worth guarding.
 *
 * Run: node server/scripts/check-maturity-csv.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const ADMIN  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const REPORT = require(path.join(ROOT, 'server', 'services', 'maturityInstructionReport.js'));

/* The shipped builders, lifted and run. Retyping them here would prove only
   that this file agrees with itself. */
function lift() {
  const names = ['MATURITY_CSV_LABELS', '_matCsvLabel',
                 '_poolMaturitySummaryRows', '_poolMaturityCSVRows'];
  let src = '';
  for (const n of names) {
    const re = n === 'MATURITY_CSV_LABELS'
      ? /const MATURITY_CSV_LABELS = \{[\s\S]*?\n\};/
      : (n === '_matCsvLabel'
        ? /const _matCsvLabel = [\s\S]*?;\n/
        : new RegExp(`function ${n}\\(d\\) \\{[\\s\\S]*?\\n\\}`, 'm'));
    const m = ADMIN.match(re);
    if (!m) throw new Error(`could not lift ${n} from admin/js/admin.js`);
    src += m[0] + '\n';
  }
  const ctx = { Math, Number, String, Object, Map, console };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.api = { ' + names.join(', ') + ' };', ctx);
  return ctx.api;
}
const A = lift();

/* A report shaped like the real one, with the two-legged instruction present
   because that is the case the counting has to survive. */
const D = {
  rows: [
    { investmentId: 'I1', instruction: 'reinvest',       instructionLabel: 'Reinvest',
      principal: 1000, actualReturn: 100, gross: 1100, toWallet: 0,
      legs: [{ amount: 1100, isSwitch: false, destinationPoolName: 'P2' }] },
    { investmentId: 'I2', instruction: 'payout_all',     instructionLabel: 'Pay out in full',
      principal: 2000, actualReturn: 200, gross: 2200, toWallet: 2200, legs: [] },
    { investmentId: 'I3', instruction: 'switch_amount',  instructionLabel: 'Switch a set amount, reinvest the rest',
      principal: 3000, actualReturn: 300, gross: 3300, toWallet: 0,
      legs: [{ amount: 1000, isSwitch: true, destinationPoolName: 'S1' },
             { amount: 2300, isSwitch: false, destinationPoolName: 'P2' }] },
    { investmentId: 'I4', instruction: 'auto_reinvest',  instructionLabel: 'Auto-reinvest (no instruction given)',
      principal: 500, actualReturn: 50, gross: 550, toWallet: 0,
      legs: [{ amount: 550, isSwitch: false, destinationPoolName: 'P2' }] },
    { investmentId: 'I5', instruction: 'custom_switch',  instructionLabel: 'Pay out a set amount, switch the rest',
      principal: 4000, actualReturn: 400, gross: 4400, toWallet: 1000,
      legs: [{ amount: 3400, isSwitch: true, destinationPoolName: 'S1' }] },
  ],
  heldBack: [
    { investmentId: 'H1', instruction: 'reinvest', instructionLabel: 'Reinvest', principal: 750 },
  ],
};

console.log('\nevery instruction has a short label');
{
  const tags = Object.keys(REPORT.INSTRUCTION_LABELS);
  for (const t of tags) {
    ok(`${t} has one`, !!A.MATURITY_CSV_LABELS[t], 'the CSV would fall back to the long sentence');
  }
  ok('no label is longer than two words',
     Object.values(A.MATURITY_CSV_LABELS).every(v => v.split(/\s+/).length <= 2),
     JSON.stringify(Object.values(A.MATURITY_CSV_LABELS).filter(v => v.split(/\s+/).length > 2)));
  ok('and none carries a comma, which sorts and pivots badly',
     Object.values(A.MATURITY_CSV_LABELS).every(v => !v.includes(',')));
  ok('the report keeps its full sentences for the screen and the PDF',
     Object.values(REPORT.INSTRUCTION_LABELS).some(v => v.includes(',')),
     'the long labels were changed too — this was meant to be CSV only');
  ok('an unknown tag falls back rather than going blank',
     A._matCsvLabel({ instruction: 'something_new', instructionLabel: 'Something new' }) === 'Something new');
}

console.log('\nthe named-amount column is gone');
{
  const header = A._poolMaturityCSVRows(D)[0];
  ok('it is not in the header', !header.includes('Named amount'), JSON.stringify(header));
  ok('and the header is one column shorter than it was', header.length === 15,
     `${header.length} columns`);
  ok('every detail row matches the header width',
     A._poolMaturityCSVRows(D).slice(1, 1 + 7).every(r => r.length === header.length),
     'a ragged row shifts every value after it into the wrong column');
}

console.log('\nthe summary adds up to the detail');
{
  const rows = A._poolMaturityCSVRows(D);
  const head = rows.findIndex(r => r[0] === 'Instruction' && r[1] === 'Investments');
  ok('there is a summary table', head > 0, JSON.stringify(rows.slice(-6)));
  const body = rows.slice(head + 1);
  const total = body.find(r => r[0] === 'Total');
  ok('with a total row', !!total, JSON.stringify(body));

  /* Five investments, not seven rows: I3 has two legs and I5 one, and the
     detail writes a line per leg. */
  ok('it counts investments, not lines', total && total[1] === 5,
     `counted ${total && total[1]} — the detail has 7 lines for 5 investments`);
  ok('capital totals the investments once each', total && total[2] === 10500,
     `got ${total && total[2]}, expected 10500`);
  ok('return likewise', total && total[3] === 1050, `got ${total && total[3]}`);
  ok('and gross is capital plus return', total && total[4] === 11550,
     `got ${total && total[4]}`);

  const lineFor = name => body.find(r => r[0] === name);
  ok('the two-legged instruction is counted once',
     lineFor('Custom reinvest') && lineFor('Custom reinvest')[1] === 1,
     JSON.stringify(lineFor('Custom reinvest')));
  ok('and carries its capital once', lineFor('Custom reinvest')[2] === 3000,
     JSON.stringify(lineFor('Custom reinvest')));
  ok('each instruction appears on its own line',
     ['Reinvest', 'Payout all', 'Custom reinvest', 'Auto-reinvest', 'Custom switch']
       .every(n => !!lineFor(n)),
     JSON.stringify(body.map(r => r[0])));
  ok('an instruction nobody chose is left out rather than shown as zero',
     !lineFor('Payout return'), 'empty rows pad a summary nobody asked for');

  /* Held back has no posted return, so it is not part of tonight's
     allocation and must not sit inside the instruction totals. */
  const held = body.find(r => String(r[0]).startsWith('Held back'));
  ok('held-back investments are reported separately', !!held, JSON.stringify(body));
  ok('with their own capital', held && held[2] === 750, JSON.stringify(held));
  ok('and are not counted in the total', total[2] === 10500,
     'the held-back 750 leaked into the allocation total');
}

console.log('\nthe summary is separated from the detail');
{
  const rows = A._poolMaturityCSVRows(D);
  const head = rows.findIndex(r => r[0] === 'Instruction' && r[1] === 'Investments');
  ok('a blank line comes before the summary title',
     rows[head - 2].length === 0, JSON.stringify(rows[head - 2]));
  ok('and it is titled', /^Summary/.test(String(rows[head - 1][0])), JSON.stringify(rows[head - 1]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
