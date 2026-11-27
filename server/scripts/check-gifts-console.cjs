#!/usr/bin/env node
/* The console's Gifts section, and the two things it is holding up.
 *
 * ── WHY THE SECTION EXISTS ───────────────────────────────────────────
 *
 * A gift could only be met in the Transaction Ledger, as two rows that
 * nothing joined: gift_sent against the sender and, if it was ever
 * claimed, gift_received against the recipient. The gift itself — who
 * sent it to whom, for how much, and whether it arrived — was on no
 * screen at all, and the ones in between were on no screen twice.
 *
 * ── THE STATE THE TABLE DOES NOT STORE ───────────────────────────────
 *
 * A gift to somebody with no account debits the sender's wallet at once
 * and then waits on a claim. NOTHING SWEEPS expires_at: the claim route
 * refuses a gift past it, but the row goes on saying 'pending' for ever.
 * So a console that trusted `status` would report money as "waiting to
 * be claimed" that can never be claimed — a client's money, already out
 * of their wallet, belonging to nobody. That is the state the section is
 * for, it is derived rather than stored, and it is the only thing the
 * nav badge points at.
 *
 * AND 'expired' IS NOT THAT STATE, which is the trap this check is most
 * concerned with. The gifts table does hold 'expired' rows — the
 * Firebase import writes them (import-firebase-gifts.js, EXPIRED →
 * expired). That script writes no transaction and moves no wallet: they
 * are closed history from the system before this one. Folding them in
 * with the derived flag would put a confident rand figure on screen and
 * send staff chasing money that never left an SV wallet. The two are
 * separate here, and this check holds them apart.
 *
 * ── AND THE SIGN THE LEDGER DREW ─────────────────────────────────────
 *
 * The ledger took its sign from ['investment','reinvestment',
 * 'withdrawal','fee'] — four of the nine types that are money LEAVING.
 * So gift_sent, stored with a negative amount, rendered as +R500,00 in
 * green against the client whose money had just gone; and platform_fee
 * rendered the same way, against CLAUDE.md's rule that fees always
 * display as negative. The same four names appeared twice, in the ledger
 * and in a client's drawer. There is now one list, checked against
 * CASH_DEBIT_TYPES in services/ledger.js, which is where the question is
 * answered for statements and balances.
 *
 * ── HOW THIS CHECK WORKS ─────────────────────────────────────────────
 *
 * It loads api.js and admin.js into a vm over a small fake DOM and calls
 * the real render functions on fixtures. Grepping the file for the word
 * "Lapsed" would pass against a screen that never draws it, and grepping
 * for the outflow list would pass against a list nothing reads.
 *
 * Note on reaching into the vm: admin.js declares its state with `let`
 * and `const` at top level, so none of it lands on the context object.
 * giftRows, STATE and the rest are reached through vm.runInContext.
 *
 * Run: node server/scripts/check-gifts-console.cjs
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
/* Utils.rand emits a non-breaking space, so every money assertion below
   would be comparing against a character nobody can see. */
const flat = s => String(s == null ? '' : s).replace(/ /g, ' ');

const ADMIN_JS   = read('admin/js/admin.js');
/* THE COMMENTS HAVE TO COME OFF BEFORE ANY CODE-SHAPE SCAN. The comment
   above TXN_OUTFLOW_TYPES quotes the four-name list it replaced, to say
   what went wrong — and the scan below, looking for that list, found it
   there and reported the bug as still present. A probe that its own
   explanation satisfies, or defeats, is the way these checks go wrong
   most often. Line comments are stripped only where one starts a line,
   so a `https://` inside a string survives. */
const ADMIN_CODE = ADMIN_JS
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ');
const ADMIN_HTML = read('admin/index.html');
const GIFTS_ROUTE = read('server/routes/gifts.js');

/* ═══════════════════════════════════════════════════════════════════
   The console, loaded and running
   ═══════════════════════════════════════════════════════════════════ */
function el() {
  return {
    innerHTML: '', textContent: '', value: '', title: '',
    style: {}, dataset: {}, checked: false, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, appendChild() {}, setAttribute() {},
    getAttribute: () => null, hasAttribute: () => false,
    closest: () => null, dispatchEvent() {}, focus() {}, click() {},
  };
}

function boot() {
  const els = {};
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: id => (els[id] || (els[id] = el())),
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => el(),
      body: el(), head: el(), documentElement: el(),
    },
    location: { search: '', pathname: '/admin/', origin: 'https://x', href: '', hash: '' },
    localStorage:   { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: '' },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    encodeURIComponent, decodeURIComponent,
    addEventListener() {}, removeEventListener() {},
    URL: { createObjectURL: () => 'blob:', revokeObjectURL() {} },
    Blob: function () {}, alert() {}, confirm: () => true, prompt: () => null,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    Chart: function () { this.destroy = () => {}; },
    EventSource: function () { this.close = () => {}; this.addEventListener = () => {}; },
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('js/api.js'), ctx, { filename: 'api.js' });
  vm.runInContext(ADMIN_JS, ctx, { filename: 'admin.js' });
  return { ctx, els, run: expr => vm.runInContext(expr, ctx) };
}

let CONSOLE_UP = null, BOOT_ERR = null;
try { CONSOLE_UP = boot(); } catch (e) { BOOT_ERR = e.message; }

console.log('\nthe console still loads');
ok('API.JS AND ADMIN.JS BOTH PARSE AND RUN', BOOT_ERR === null,
   'nothing below ran: ' + BOOT_ERR);
if (!CONSOLE_UP) {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}
const { run, els } = CONSOLE_UP;

/* ═══════════════════════════════════════════════════════════════════
   1. Which way the money went — one list, and it is the ledger's
   ═══════════════════════════════════════════════════════════════════ */
console.log('\nthe sign rule has one source, shared with the server');
{
  const DEBIT = require(path.join(ROOT, 'server/services/ledger.js')).CASH_DEBIT_TYPES;
  const front = run('TXN_OUTFLOW_TYPES');

  ok('the console has an outflow list at all', Array.isArray(front) && front.length > 4,
     JSON.stringify(front));

  /* NOT A SUBSET CHECK. A list missing platform_fee is a subset of the
     server's and was exactly the bug: fees drawn as green credits. */
  const missing = DEBIT.filter(t => !front.includes(t));
  const extra   = front.filter(t => !DEBIT.includes(t));
  ok('IT IS THE SAME SET AS CASH_DEBIT_TYPES IN services/ledger.js',
     missing.length === 0 && extra.length === 0,
     `missing from the console: [${missing}] · not in the server's list: [${extra}]`);

  /* The literal that was there twice. If it comes back, one screen has
     started answering this question for itself again. */
  const literal = /\['investment','reinvestment','withdrawal','fee'\]/g;
  const left = (ADMIN_CODE.match(literal) || []).length;
  ok('AND THE FOUR-NAME LITERAL IS GONE FROM BOTH SITES', left === 0,
     `${left} still there — the ledger and the client drawer each had one, `
     + 'and fixing only one leaves two screens disagreeing about a client’s money');

  /* Both call sites now read the shared list. Asserted by count because
     the second one — the Transactions panel of a client's drawer — is
     drawn inside a render too large to drive here, and a fix applied to
     the ledger alone would otherwise pass. */
  const sites = (ADMIN_CODE.match(/TXN_OUTFLOW_TYPES\.includes\(t\.type\)\?'td-red'/g) || []).length;
  ok('and both amount cells are drawn from it', sites === 2, String(sites));
}

/* ═══════════════════════════════════════════════════════════════════
   2. The ledger, rendered
   ═══════════════════════════════════════════════════════════════════ */
console.log('\nand the ledger draws a gift and a fee as money leaving');
{
  const TXNS = [
    { id: 'T1', investor_id: 'INV-1', type: 'deposit',       amount: '1000.00', status: 'completed', created_at: '2026-11-01T08:00:00Z' },
    { id: 'T2', investor_id: 'INV-1', type: 'gift_sent',     amount: '-500.00', status: 'completed', created_at: '2026-11-02T08:00:00Z' },
    { id: 'T3', investor_id: 'INV-2', type: 'gift_received', amount: '500.00',  status: 'completed', created_at: '2026-11-02T08:00:01Z' },
    { id: 'T4', investor_id: 'INV-1', type: 'gift_cancelled',amount: '250.00',  status: 'completed', created_at: '2026-11-03T08:00:00Z' },
    { id: 'T5', investor_id: 'INV-1', type: 'platform_fee',  amount: '-5.00',   status: 'completed', created_at: '2026-11-04T08:00:00Z' },
  ];
  run(`STATE.transactions = ${JSON.stringify(TXNS)}; STATE.investors = [
        { id: 'INV-1', first_name: 'Thandi', last_name: 'Mokoena' },
        { id: 'INV-2', first_name: 'Sipho',  last_name: 'Dlamini' }];`);

  let threw = null;
  try { run('applyTxnFilters({ noRemote: true })'); } catch (e) { threw = e.message; }
  ok('THE LEDGER RENDERS AT ALL', threw === null, 'applyTxnFilters threw: ' + threw);

  const html = flat(els.txnBody ? els.txnBody.innerHTML : '');
  ok('and it drew the fixture', /Thandi/.test(html) && /Sipho/.test(html), html.slice(0, 200));

  /* One row at a time, so a failure names the type. */
  const rowOf = marker => {
    const rows = html.split('<tr>').filter(r => r.includes(marker));
    return rows.length === 1 ? rows[0] : null;
  };
  const cases = [
    ['gift sent',      'gift sent',      true],
    ['gift received',  'gift received',  false],
    ['gift cancelled', 'gift cancelled', false],
    ['platform fee',   'platform fee',   true],
    ['deposit',        '>deposit<',      false],
  ];
  for (const [label, marker, out] of cases) {
    const row = rowOf(marker);
    ok(`the ${label} row is on screen once`, row !== null,
       'the badge text the row is found by has changed, and the two assertions '
       + 'below would read nothing while passing');
    if (!row) continue;
    ok(`  and it reads ${out ? 'negative, in red' : 'positive, in green'}`,
       out ? (/td-red/.test(row) && /">-R/.test(row))
           : (/td-green/.test(row) && /">\+R/.test(row)),
       row.replace(/\s+/g, ' ').slice(0, 260));
  }

  /* CLAUDE.md: fees must always display as negative in every transaction
     list and statement. The platform_fee case above is that rule; this
     names it so a failure says which rule broke. */
  const feeRow = rowOf('platform fee');
  ok('WHICH IS THE RULE THAT FEES ALWAYS DISPLAY NEGATIVE',
     !!feeRow && /td-red/.test(feeRow), 'CLAUDE.md, Platform Fee');
}

/* ═══════════════════════════════════════════════════════════════════
   3. One Type option, the whole family
   ═══════════════════════════════════════════════════════════════════ */
console.log('\nand one Type option finds every kind of gift row');
{
  /* SLICED TO THE LEDGER'S OWN SELECT. Probing the whole page for
     <option value="gift"> passed with the option deleted: there is
     another one, on an unrelated dropdown further down the file, and the
     scan found that instead. */
  const tf = ADMIN_HTML.slice(ADMIN_HTML.indexOf('id="txnTypeFilter"'));
  const typeSelect = tf.slice(0, tf.indexOf('</select>'));
  ok('the ledger’s Type filter is still findable', typeSelect.length > 100
     && /All Types/.test(typeSelect), typeSelect.slice(0, 120));
  ok('and the Gifts option is on IT',
     /<option value="gift">/.test(typeSelect),
     'the dropdown is where an operator reaches the filter; the family map '
     + 'alone is a feature with no control');

  const family = run('TXN_TYPE_FAMILIES && TXN_TYPE_FAMILIES.gift') || [];

  /* THE FAMILY IS CHECKED AGAINST WHAT THE SERVER ACTUALLY WRITES, so a
     fifth gift transaction type added to routes/gifts.js fails here
     rather than quietly dropping out of the filter. */
  const written = [...new Set(
    (GIFTS_ROUTE.match(/type:\s*'(gift[a-z_]*)'/g) || [])
      .map(m => m.replace(/.*'(gift[a-z_]*)'.*/, '$1')))];
  ok('the server writes gift transaction types this check can see',
     written.length >= 3, JSON.stringify(written));
  const uncovered = written.filter(t => !family.includes(t));
  ok('AND THE FAMILY COVERS EVERY ONE OF THEM', uncovered.length === 0,
     'not in TXN_TYPE_FAMILIES.gift: ' + JSON.stringify(uncovered));

  els.txnTypeFilter.value = 'gift';
  run('applyTxnFilters({ noRemote: true })');
  let got = run('filteredTxns.map(t => t.type).sort()');
  ok('picking Gifts shows the sent, the received and the refund',
     got.join(',') === 'gift_cancelled,gift_received,gift_sent', JSON.stringify(got));

  /* A family map that swallowed the single-type case would have broken
     every other option on the dropdown. */
  els.txnTypeFilter.value = 'deposit';
  run('applyTxnFilters({ noRemote: true })');
  got = run('filteredTxns.map(t => t.type)');
  ok('and a plain type still filters to itself', got.join(',') === 'deposit',
     JSON.stringify(got));

  els.txnTypeFilter.value = '';
  run('applyTxnFilters({ noRemote: true })');
  ok('and clearing it shows everything', run('filteredTxns.length') === 5,
     String(run('filteredTxns.length')));
}

/* ═══════════════════════════════════════════════════════════════════
   4. Lapsed, and the thing it is not
   ═══════════════════════════════════════════════════════════════════ */
console.log('\nand a lapsed gift is told apart from imported history');
{
  const st = row => run(`_giftState(${JSON.stringify(row)})`);

  ok('claimed reads as claimed',   st({ status: 'claimed' })   === 'claimed');
  ok('cancelled reads as cancelled', st({ status: 'cancelled' }) === 'cancelled');
  ok('pending inside its window is waiting',
     st({ status: 'pending', lapsed: false }) === 'awaiting');
  ok('PENDING PAST ITS EXPIRY IS LAPSED',
     st({ status: 'pending', lapsed: true }) === 'lapsed',
     'this is the whole state the section was built for');
  ok("AND AN IMPORTED 'expired' ROW IS NOT LAPSED",
     st({ status: 'expired' }) === 'expired',
     'import-firebase-gifts.js writes no transaction and moves no wallet, so '
     + 'those gifts are not money anybody here is holding — calling them '
     + 'lapsed sends staff after it with a figure attached');

  /* Both states are reachable on screen rather than only in the map. */
  const states = run('Object.keys(GIFT_STATES).sort()').join(',');
  ok('and every state has a badge and an explanation',
     states === 'awaiting,cancelled,claimed,expired,lapsed', states);
  const labels = run('Object.values(GIFT_STATES).map(r => r[1])');
  ok('whose labels do not read the same',
     new Set(labels).size === labels.length, JSON.stringify(labels));
}

/* ═══════════════════════════════════════════════════════════════════
   5. The section, rendered
   ═══════════════════════════════════════════════════════════════════ */
console.log('\nand the Gifts section draws the gifts');
{
  ok('there is a Gifts item in the sidebar',
     /data-view="gifts"/.test(ADMIN_HTML));
  ok('and a pane for it to open', /id="view-gifts"/.test(ADMIN_HTML));
  ok('and navigate() names it and loads it',
     /gifts:\s*'Gifts'/.test(ADMIN_CODE) && /gifts:\s*loadGifts/.test(ADMIN_CODE),
     'a nav button with no loader opens an empty pane that says Loading… '
     + 'for ever');
  ok('and its columns sort', /_registerSortable\('gifts'/.test(ADMIN_CODE));

  const GIFTS = [
    { id: 'GIFT-1', amount: '500.00', status: 'claimed', sender_id: 'INV-1',
      sender_first: 'Thandi', sender_last: 'Mokoena', recipient_id: 'INV-2',
      recipient_first: 'Sipho', recipient_last: 'Dlamini',
      recipient_email: 'sipho@example.com', sent_at: '2026-11-02T08:00:00Z',
      claimed_at: '2026-11-02T08:00:01Z', expires_at: '2026-12-02T08:00:00Z',
      lapsed: false, message: 'Happy birthday' },
    { id: 'GIFT-2', amount: '300.00', status: 'pending', sender_id: 'INV-1',
      sender_first: 'Thandi', sender_last: 'Mokoena', recipient_id: null,
      recipient_name: 'Naledi', recipient_email: 'naledi@example.com',
      sent_at: '2026-11-20T08:00:00Z', expires_at: '2026-12-20T08:00:00Z',
      lapsed: false, message: null },
    { id: 'GIFT-3', amount: '750.00', status: 'pending', sender_id: 'INV-3',
      sender_first: 'Lerato', sender_last: 'Khumalo', recipient_id: null,
      recipient_name: null, recipient_email: 'nobody@example.com',
      sent_at: '2026-08-01T08:00:00Z', expires_at: '2026-08-31T08:00:00Z',
      lapsed: true, message: null },
    { id: 'GIFT-4', amount: '100.00', status: 'cancelled', sender_id: 'INV-1',
      sender_first: 'Thandi', sender_last: 'Mokoena', recipient_id: null,
      recipient_email: 'gone@example.com', sent_at: '2026-09-01T08:00:00Z',
      expires_at: '2026-10-01T08:00:00Z', lapsed: false, message: null },
    { id: 'GIFT-5', amount: '900.00', status: 'expired', sender_id: 'INV-4',
      sender_first: 'Kabelo', sender_last: 'Ndlovu', recipient_id: null,
      recipient_email: 'old@example.com', sent_at: '2024-01-01T08:00:00Z',
      expires_at: '2024-02-01T08:00:00Z', lapsed: false, message: null },
  ];
  run(`giftRows = ${JSON.stringify(GIFTS)}; giftTruncated = false;`);
  let threw = null;
  try { run('applyGiftFilters()'); } catch (e) { threw = e.message; }
  ok('THE TABLE RENDERS AT ALL', threw === null, 'applyGiftFilters threw: ' + threw);

  const html = flat(els.giftBody ? els.giftBody.innerHTML : '');
  ok('and it drew five rows', (html.match(/<tr>/g) || []).length === 5,
     String((html.match(/<tr>/g) || []).length));

  ok('BOTH NAMES ARE ON THE ROW, not two investor ids',
     /Thandi Mokoena/.test(html) && /Sipho Dlamini/.test(html),
     'the ledger already showed ids; a section that does the same is the '
     + 'ledger with extra steps: ' + html.slice(0, 200));

  ok("and a recipient with no account is identified by the email the sender typed",
     /naledi@example\.com/.test(html) && /no account yet/.test(html),
     'it is the only handle anybody has on them');
  /* AND THE FALLBACK ITSELF, because the row above does not prove it:
     that fixture carries a recipient_name, and the email prints on the
     line beneath the name either way. Dropping the fallback leaves a
     nameless recipient reading as an em dash, and the assertion above
     passed straight through that. */
  ok('  including one the sender did not name',
     run("_giftTo({ recipient_email: 'nameless@example.com' })") === 'nameless@example.com',
     run("_giftTo({ recipient_email: 'nameless@example.com' })"));

  const lapsedRow = html.split('<tr>').find(r => r.includes('nobody@example.com'));
  ok('the lapsed gift is on screen', !!lapsedRow);
  ok('  marked Lapsed, in red', !!lapsedRow && /badge--red/.test(lapsedRow)
     && />Lapsed</.test(lapsedRow), (lapsedRow || '').replace(/\s+/g, ' ').slice(0, 260));
  ok('  and saying when the claim link stopped working',
     !!lapsedRow && /Expired\s/.test(lapsedRow),
     'a state with no date beside it cannot be acted on');

  const expiredRow = html.split('<tr>').find(r => r.includes('old@example.com'));
  ok('AND THE IMPORTED ROW IS NOT DRAWN AS LAPSED',
     !!expiredRow && !/badge--red/.test(expiredRow) && !/>Lapsed</.test(expiredRow),
     (expiredRow || '').replace(/\s+/g, ' ').slice(0, 260));

  /* The filter, through the same control the stat cards use. */
  run("setGiftFilter('lapsed')");
  let shown = run('giftFiltered.map(g => g.id)');
  ok('and the Lapsed filter narrows to that one gift',
     shown.join(',') === 'GIFT-3', JSON.stringify(shown));

  run("setGiftFilter('expired')");
  shown = run('giftFiltered.map(g => g.id)');
  ok('and imported history filters on its own', shown.join(',') === 'GIFT-5',
     JSON.stringify(shown));

  /* Searching by the recipient's email, which for GIFT-2 is the only
     string that identifies the recipient at all. */
  run("setGiftFilter('')");
  els.giftSearch.value = 'naledi@example.com';
  run('applyGiftFilters()');
  shown = run('giftFiltered.map(g => g.id)');
  ok("and the search reaches a recipient who has no account",
     shown.join(',') === 'GIFT-2', JSON.stringify(shown));

  els.giftSearch.value = 'nobody-at-all';
  run('applyGiftFilters()');
  ok('and a search that matches nothing says so rather than emptying the table',
     /No matching gifts/.test(flat(els.giftBody.innerHTML)),
     flat(els.giftBody.innerHTML).slice(0, 200));
  els.giftSearch.value = '';
  run('applyGiftFilters()');
}

/* ═══════════════════════════════════════════════════════════════════
   6. The figures on the cards come from the whole table
   ═══════════════════════════════════════════════════════════════════ */
console.log('\nand the figures come from the server, not from the page');
{
  /* DELIBERATELY DISAGREEING WITH giftRows. The list is capped at 2 000;
     a card that summed the rows it was handed would report a total that
     shrank as the table grew, and it would look like a figure rather
     than a bug. So the totals here are nothing like the fixture's. */
  run(`giftTotals = { gifts: 4210, total: '7777777.00',
                      claimed: 4000, claimed_amount: '7000000.00',
                      awaiting: 200, awaiting_amount: '600000.00',
                      lapsed: 10, lapsed_amount: '177777.00',
                      cancelled: 0, expired: 0 };
       _giftStats();`);

  ok('THE TOTAL IS THE SERVER’S, NOT A SUM OF THE ROWS ON SCREEN',
     /7 777 777,00/.test(flat(els['gift-total'].textContent)),
     flat(els['gift-total'].textContent));
  ok('and so is the count', String(els['gift-count'].textContent) === '4210',
     String(els['gift-count'].textContent));
  ok('the claimed card reads the claimed figure',
     /7 000 000,00/.test(flat(els['gift-claimed'].textContent)),
     flat(els['gift-claimed'].textContent));
  ok('the waiting card reads the waiting figure',
     /600 000,00/.test(flat(els['gift-awaiting'].textContent)),
     flat(els['gift-awaiting'].textContent));
  ok('and the lapsed card reads the lapsed figure',
     /177 777,00/.test(flat(els['gift-lapsed'].textContent)),
     flat(els['gift-lapsed'].textContent));

  ok('THE NAV BADGE POINTS AT THE LAPSED ONES',
     String(els.giftBadge.textContent) === '10' && els.giftBadge.style.display !== 'none',
     `${els.giftBadge.textContent} / display ${els.giftBadge.style.display}`);

  const notice = flat(els.giftLapsedNotice.innerHTML);
  ok('and the notice says what to do about them, not just how many',
     /Cancel &amp; Refund|Cancel & Refund/.test(notice) && /Send a Gift/.test(notice),
     'only the client who sent it can get the money back — DELETE '
     + '/api/gifts/:id is scoped to the sender — so a notice without that '
     + 'is a number nobody can act on: ' + notice.slice(0, 240));
  ok('  and does not claim staff can do it for them',
     !/we will refund|staff can cancel|refund (?:it|them) here/i.test(notice),
     notice.slice(0, 240));

  /* Nothing lapsed must leave the screen quiet, or the badge becomes
     furniture people stop reading. */
  run(`giftTotals = { gifts: 3, total: '900.00', claimed: 3,
                      claimed_amount: '900.00', awaiting: 0, awaiting_amount: '0',
                      lapsed: 0, lapsed_amount: '0', cancelled: 0, expired: 0 };
       _giftStats();`);
  ok('with nothing lapsed the badge and the notice are both away',
     els.giftBadge.style.display === 'none'
     && els.giftLapsedNotice.style.display === 'none'
     && flat(els.giftLapsedNotice.innerHTML) === '',
     `badge ${els.giftBadge.style.display} · notice ${els.giftLapsedNotice.style.display}`);
}

/* ═══════════════════════════════════════════════════════════════════
   7. The endpoint behind it
   ═══════════════════════════════════════════════════════════════════ */
console.log('\nand the endpoint behind it');
{
  const at = GIFTS_ROUTE.indexOf("router.get('/admin'");
  ok('GET /api/gifts/admin exists', at > 0);
  const end = GIFTS_ROUTE.indexOf("router.get('/my'", at);
  const handler = at > 0 ? GIFTS_ROUTE.slice(at, end > at ? end : at + 3000) : '';
  ok('and there is a handler there to check', handler.length > 400, String(handler.length));

  ok('IT IS STAFF ONLY', /requireAuth,\s*requireRole\(/.test(handler),
     'every other read on this router is scoped to the caller’s own gifts; '
     + 'this one returns everybody’s: ' + handler.slice(0, 160));

  /* The token claims the money. Nothing the console draws needs it, and
     a list endpoint is the wrong place to hand one out. */
  ok('AND IT DOES NOT HAND OUT claim_token', !/claim_token/.test(handler),
     'the bearer credential for the money has no business in a list the '
     + 'console reads: ' + handler.slice(0, 200));

  /* PINNED TO THE DERIVATION, NOT THE COLUMN NAME. `/AS lapsed/` was
     satisfied by `FALSE AS lapsed`, and `/LAPSED_SQL/` by the totals
     query further down, so replacing the row flag with a constant passed
     every part of this assertion while every gift read as fine. */
  ok('lapsed is decided by the database’s clock',
     /\(\$\{LAPSED_SQL\('g\.'\)\}\) AS lapsed/.test(handler)
     && /expires_at < NOW\(\)/.test(GIFTS_ROUTE),
     'computing it from a browser clock makes the figure depend on whose '
     + 'screen it is on, and hard-coding it makes every gift read as fine');

  ok('and the totals are their own aggregate over the whole table',
     /FROM gifts`\)/.test(handler) && /COUNT\(\*\)[^\n]*AS gifts/.test(handler)
     && !/FROM gifts\s+LEFT JOIN[\s\S]{0,400}COUNT\(\*\)/.test(handler),
     'a stat card summing the capped list reports a figure that shrinks as '
     + 'the table grows');

  ok('expired is counted apart from lapsed there too',
     /FILTER \(WHERE status = 'expired'\)/.test(handler)
     && /FILTER \(WHERE \$\{LAPSED_SQL\(\)\}\)/.test(handler),
     'one number covering both would put imported history into the figure '
     + 'staff act on');

  ok('and the list is capped, with the cap bounded',
     /LIMIT \$1/.test(handler) && /Math\.min\(/.test(handler),
     '?limit=10000000 is a request to read the whole table into a browser');
}

/* ═══════════════════════════════════════════════════════════════════
   8. The feature is announced
   ═══════════════════════════════════════════════════════════════════ */
console.log('\nand staff are told it exists');
{
  const SETUP = read('server/db/setup.js');
  const at = SETUP.indexOf("'admin-gifts-section-2026-11'");
  ok('there is a feature_announcements step for it', at > 0,
     'CLAUDE.md: a new admin console feature gets a row, or nobody finds it');
  const step = at > 0 ? SETUP.slice(Math.max(0, at - 700), at + 2600) : '';
  ok('inserted with ON CONFLICT DO NOTHING',
     /ON CONFLICT \(id\) DO NOTHING/.test(step),
     'a redeploy must not overwrite wording somebody has edited');
  /* where_to_find is the field CLAUDE.md calls the only one somebody can
     act on. It has to name the path, not the feature again. */
  ok('AND IT SAYS WHERE TO FIND BOTH HALVES',
     /Console\s*→\s*Gifts/.test(step) && /Console\s*→\s*Transactions/.test(step),
     'the section and the filter are in two different places: ' + step.slice(-400));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
