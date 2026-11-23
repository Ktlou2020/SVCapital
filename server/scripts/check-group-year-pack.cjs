#!/usr/bin/env node
/* The document a treasurer stands up with.
 *
 * A stokvel has an AGM and somebody has to account for the year. The
 * platform held every number that meeting needs — what each member paid,
 * what the group spent, what each share came to, which two signatories
 * approved each movement — and the screen printed four summary lines and
 * the sentence "Contributions, shares and the approvals register are
 * included in the document itself" about a document that did not exist.
 * The numbers were built on the server and thrown away on the client.
 *
 * WHAT MAKES THIS PACK WORTH HANDING OUT, and what is checked below:
 *
 *   IT IS PER MEMBER, NOT PER PERIOD. At an AGM the question is "what did
 *   Nomsa pay this year", never "what did period 2026-07 collect".
 *
 *   IT TIES, AND SAYS SO. The members' shares add up to what the group
 *   holds, in two lines next to each other, because a member doing that
 *   arithmetic in the room is the point of handing it out.
 *
 *   AND IT SAYS SO WHEN IT DOES NOT. A pack whose own figures disagree is
 *   worse than no pack, because somebody will check it. It tells the
 *   treasurer not to table it rather than letting them find out standing up.
 *
 *   THE REGISTER NAMES PEOPLE. Not that two signatories agreed — which two.
 *
 * Run: node server/scripts/check-group-year-pack.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function portal() {
  const ctx = { window: {}, document: { getElementById: () => null },
                location: { search: '' },
                localStorage: { getItem: () => null, setItem() {} },
                sessionStorage: { getItem: () => null, setItem() {} },
                Utils: { rand: n => 'R ' + Number(n || 0).toFixed(2) },
                encodeURIComponent, console };
  vm.createContext(ctx);
  vm.runInContext(read('js/portal-core.js'), ctx);
  /* The bundle's own escaper, as the workspace gets it. */
  ctx._esc = v => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return ctx;
}
/* What a person in the room reads, with the markup taken away. */
const words = html => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const PACK = () => ({
  opening_balance: 1000, closing_balance: 9000,
  transactions: [{}, {}, {}],
  stokvel: {
    name: 'Masibambane', registration: 'NAS-9001',
    contributions: [
      { investor_id: 'A', name: 'Zanele', period: '2026-01', due: 500, paid: 500 },
      { investor_id: 'A', name: 'Zanele', period: '2026-02', due: 500, paid: 500 },
      { investor_id: 'B', name: 'Kabelo', period: '2026-01', due: 500, paid: 450 },
    ],
    shares: { basis: 'contribution', net_assets: 9000, wallet: 9000, invested: 0,
              owed_to_former_members: 0,
              members: [{ investor_id: 'A', name: 'Zanele', share: 4500, arrears: 0 },
                        { investor_id: 'B', name: 'Kabelo', share: 4500, arrears: 50 }] },
    approvals: [{ kind: 'withdrawal', amount: 2000, at: '2026-11-23',
                  votes: [{ name: 'Zanele', decision: 'approve' },
                          { name: 'Tumi',   decision: 'approve' }] }],
  },
});

const P = portal();
const build = d => P._svYearPack(d, '2026-01-01', '2026-12-31');

/* ══ 1. It is a document, not a summary ════════════════════════════ */
console.log('\nthe pack carries what the meeting has to be told');
{
  const w = words(build(PACK()));
  for (const [what, probe] of [
    ['the group and its registration', /Masibambane/],
    ['the period it covers',           /2026-01-01 to 2026-12-31/],
    ['what each member paid',          /What each member paid/],
    ['each share at the closing date', /share at the closing date/],
    ['and who approved what moved',    /Who approved the money that moved/],
  ]) ok(`it names ${what}`, probe.test(w), w.slice(0, 220));

  ok('AND IT CAN BE PRINTED, because the meeting is on paper',
     /_svPrintPack\(\)/.test(build(PACK())),
     'a document that only exists on a phone is not tabled at an AGM');
}

/* ══ 2. Per member, not per period ═════════════════════════════════ */
console.log('\nand it answers the question an AGM actually asks');
{
  const w = words(build(PACK()));
  /* SCOPED TO THE SECTION. Counting "Zanele" across the whole pack counts
     her share row and her signature on the register too — a document-wide
     count cannot tell "gathered per member" from "printed three times". */
  const contribSection = w.slice(w.indexOf('What each member paid'),
                                 w.indexOf('share at the closing date'));
  ok('A MEMBER WHO PAID TWICE IS ONE ROW, NOT TWO',
     (contribSection.match(/Zanele/g) || []).length === 1,
     'per period is the server\'s shape; per member is the meeting\'s: '
     + contribSection);
  ok('and it says how many periods that was',
     /Zanele 2 periods/.test(w), w.slice(0, 400));
  ok('and a member who paid once says one period, not 1 periods',
     /Kabelo 1 period /.test(w), w.slice(0, 400));
  ok('THE TOTALS ARE THE SUM OF THE ROWS',
     /Due in the period R 1500\.00/.test(w) && /Paid in the period R 1450\.00/.test(w),
     'R500 + R500 + R500 due, R500 + R500 + R450 paid: ' + w.slice(0, 500));
  ok('and a member who is short is shown as short, by how much',
     /R 50\.00 owing/.test(w), w.slice(0, 500));
  ok('and one who is not is shown as paid up',
     /paid up/.test(w), w.slice(0, 500));
}

/* ══ 3. It ties, and says so ═══════════════════════════════════════ */
console.log('\nand it proves itself in front of the people reading it');
{
  const w = words(build(PACK()));
  ok('the members’ shares are added up',
     /shares add up to R 9000\.00/.test(w), w.slice(0, 700));
  ok('beside what the group holds',
     /the group holds R 9000\.00/.test(w), w.slice(0, 700));
  ok('AND IT SAYS WHAT THAT MEANS',
     /every rand the group holds belongs to somebody in this list/.test(w),
     'the arithmetic is the argument this product exists to end');

  /* The one that matters. */
  const broken = PACK();
  broken.stokvel.shares.net_assets = 9500;
  const b = words(build(broken));
  ok('AND WHEN THEY DO NOT AGREE IT SAYS DO NOT TABLE THIS',
     /Do not table this pack/.test(b) && !/every rand the group holds belongs/.test(b),
     'a treasurer finding out standing up is the worst version of this: ' + b.slice(0, 700));

  /* Cents from splitting a pot three ways are not a discrepancy. */
  const rounded = PACK();
  rounded.stokvel.shares.members = [
    { investor_id: 'A', name: 'A', share: 3000.01, arrears: 0 },
    { investor_id: 'B', name: 'B', share: 3000, arrears: 0 },
    { investor_id: 'C', name: 'C', share: 3000, arrears: 0 }];
  rounded.stokvel.shares.net_assets = 9000;
  ok('but a cent of rounding is not a disagreement',
     !/Do not table this pack/.test(words(build(rounded))),
     'R10 between three members loses a cent, every month, for ever — '
     + 'calling that a break would cry wolf on every pack ever printed');
}

/* ══ 4. The register names people ══════════════════════════════════ */
console.log('\nand the register says which signatories, not how many');
{
  const w = words(build(PACK()));
  ok('IT NAMES THEM', /Zanele, Tumi/.test(w),
     'two people agreed is not a register: ' + w.slice(-500));
  ok('and says what they approved and when',
     /withdrawal R 2000\.00/.test(w) && /2026-11-23/.test(w), w.slice(-500));

  const rejected = PACK();
  rejected.stokvel.approvals[0].votes = [
    { name: 'Zanele', decision: 'approve' },
    { name: 'Tumi',   decision: 'reject'  }];
  const r = words(build(rejected));
  ok('AND SOMEBODY WHO SAID NO IS NOT LISTED AS HAVING APPROVED IT',
     /Zanele/.test(r) && !/Zanele, Tumi/.test(r),
     'a register that reads a refusal as an approval is worse than none: ' + r.slice(-400));

  const unsigned = PACK();
  unsigned.stokvel.approvals[0].votes = [];
  ok('and a movement with no votes on record says so rather than blank',
     /no signatories recorded/.test(words(build(unsigned))),
     'an empty cell reads as a formatting bug; this reads as a finding');
}

/* ══ 5. The empty cases, which a new group hits first ══════════════ */
console.log('\nand a group with nothing yet gets a pack that says nothing yet');
{
  const bare = { opening_balance: 0, closing_balance: 0, transactions: [],
                 stokvel: { name: 'New Group', contributions: [], shares: null, approvals: [] } };
  const w = words(build(bare));
  ok('no contributions says so in words',
     /No contributions fell due in this period/.test(w), w);
  ok('nothing approved says so in words',
     /Nothing needed the signatories in this period/.test(w), w);
  ok('AND IT DOES NOT FALL OVER WITHOUT A SHARE SPLIT',
     w.length > 50 && /New Group/.test(w),
     'a group made this week has no shares block at all');
  ok('and a payload with nothing in it at all still renders',
     words(build({})).length > 0 && words(build(null)).length > 0,
     'the screen must not go blank on an unexpected answer');
}

/* ══ 6. A member’s own name is not markup ══════════════════════════ */
console.log('\nand nothing a member typed becomes part of the document');
{
  const nasty = PACK();
  nasty.stokvel.name = '<img src=x onerror=alert(1)>';
  nasty.stokvel.contributions[0].name = '<script>alert(2)</script>';
  nasty.stokvel.shares.members[0].name = '"><b>b</b>';
  nasty.stokvel.approvals[0].votes[0].name = '<i>i</i>';
  const html = build(nasty);
  /* A TAG, not a word. "&lt;img src=x onerror=alert(1)&gt;" still contains
     the letters onerror= and is meant to — it is text. What must not exist
     is an element the browser will run or style. */
  ok('A NAME IS DRAWN AS A NAME',
     !/<script/i.test(html) && !/<img/i.test(html)
     && !/<b>b<\/b>/.test(html) && !/<i>i<\/i>/.test(html),
     'this document is handed to everybody in the group: ' + html.slice(0, 400));
  ok('and the escaped text is still there to read',
     /&lt;script&gt;/.test(html), 'escaping must not delete the name');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
