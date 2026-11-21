#!/usr/bin/env node
/* A statement for an account that is not a person — and a personal one that
 * is only the person's.
 *
 * No sub-account had a statement at all — not a stokvel, a trust, a business
 * or a child's account — because every query in services/accountStatement.js
 * was scoped by investor_id. A stokvel's AGM had nothing to table.
 *
 * AND THE ROWS WENT THE OTHER WAY TOO. A sub-account's transactions carry the
 * holder's investor_id as well as the account's, so a personal statement
 * listed the group's deposits, contributions, payouts and holdings beside its
 * owner's own money. While a sub-account had no statement of its own that was
 * the right call: better on the wrong page than on none. It has one now, and
 * the decision taken on 21 November 2026 was to narrow the personal one.
 *
 * THAT IS ALSO WHY A CLIENT WITH A GROUP COULD NOT BE HANDED A STATEMENT THAT
 * TIED. Every balance on one is anchored to the holder's own wallet, and the
 * ledger beneath it listed money that never passed through that wallet — so
 * the two could not agree, and the footer said so, in as many words, on every
 * statement issued to a client with a sub-account. `reconciles` is the
 * service's own answer to whether they agree, and it is asserted here.
 *
 * The same split is asserted on the client: the wallet's activity list and
 * the income chart are the same question asked on a screen instead of a page.
 *
 * Then the other half: a stokvel statement carries the money view every
 * account gets, plus the three things an AGM actually asks — who contributed
 * what, what each member's share is, and WHICH signatories approved the money
 * that moved.
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-stokvel-statement.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ── The same decision, on the screens ────────────────────────────────
   A comment that explains the fix quotes the thing it warns about, so the
   source is read with comments stripped. */
/* A comment that explains a fix quotes the thing it warns about, so every
   source read here strips them first. */
const strip = src => String(src).replace(/\/\*[\s\S]*?\*\//g, ' ')
                                .replace(/^\s*\/\/.*$/gm, ' ');
const CORE = strip(fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8'));

/* ── Which way the money went, and whose row it is ───────────────────
   REPORTED FROM THE LIVE PORTAL: a member's own transactions showed the
   group's contributions as theirs, and the R60 000 they had paid INTO the
   group as +R 60 000,00 in green.

   Two faults, one shape. The scope one is the same decision as the
   statement above, applied to a list that was missed. The sign one is that
   four separate screens each carried their own
   `!['withdrawal','fee','investment','reinvestment','gift_sent']` — a list
   of what goes OUT written as a list of exceptions, so every type added
   since was money arriving by default.

   These are RUN, not read: the answer for a given type is the thing that
   was wrong. */
console.log('\nand which way the money went is one answer, not four');
{
  const vm = require('vm');
  const ctx = { window: {}, document: { getElementById: () => null },
                location: { search: '' },
                localStorage: { getItem: () => null, setItem() {} },
                sessionStorage: { getItem: () => null, setItem() {} },
                Utils: { rand: n => 'R ' + Number(n).toFixed(2) }, encodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(
    path.join(ROOT, 'js', 'portal-core.js'), 'utf8'), ctx);

  const dir = type => ctx._stmtDirection({ type, amount: 100 });
  ok('MONEY PAID INTO A GROUP IS MONEY LEAVING',
     dir('stokvel_contribution') === 'debit',
     `${dir('stokvel_contribution')} — a client saw the R60 000 they paid into `
     + 'their stokvel as +R 60 000,00 in green on their own transactions');
  ok('and the group receiving it is money arriving, on the group’s side',
     dir('stokvel_contribution_received') === 'credit', dir('stokvel_contribution_received'));
  ok('AND THE SIGN IS DRAWN FROM THAT, not from a list of exceptions',
     ctx._txnIsCredit({ type: 'stokvel_contribution' }) === false
     && ctx._txnIsCredit({ type: 'deposit' }) === true,
     'the four lists each named five or six outgoing types and treated '
     + 'everything else as arriving');

  /* CLAUDE.md: a fee displays as negative in all transaction lists and
     statements. Both spellings, because both are written. */
  ok('a fee is still negative, both ways it is spelled',
     dir('fee') === 'debit' && dir('platform_fee') === 'debit');
  ok('and so is every other way money leaves',
     ['withdrawal', 'investment', 'reinvestment', 'gift_sent', 'transfer_out', 'reversal']
       .every(t => dir(t) === 'debit'),
     JSON.stringify(['withdrawal', 'investment', 'reinvestment', 'gift_sent',
                     'transfer_out', 'reversal'].map(t => [t, dir(t)])));
  ok('and money arriving is not drawn as leaving',
     ['deposit', 'return', 'payout', 'referral_bonus', 'gift_received', 'matured_funds',
      'transfer_in', 'fee_reversal'].every(t => dir(t) === 'credit'),
     JSON.stringify(['deposit', 'return', 'payout', 'referral_bonus', 'gift_received',
                     'matured_funds', 'transfer_in', 'fee_reversal'].map(t => [t, dir(t)])));

  /* THE LIST MUST MATCH THE SERVER'S. Two definitions of what moves cash
     is how a screen and a statement come to disagree about a balance. */
  const LED = strip(fs.readFileSync(
    path.join(ROOT, 'server', 'services', 'ledger.js'), 'utf8'));
  const listOf = name => {
    const m = LED.match(new RegExp(name + '\\s*=\\s*\\[([\\s\\S]*?)\\]'));
    return m ? m[1].match(/'[a-z_]+'/g).map(x => x.slice(1, -1)) : [];
  };
  const missingCredit = listOf('CASH_CREDIT_TYPES').filter(t => dir(t) !== 'credit');
  const missingDebit  = listOf('CASH_DEBIT_TYPES').filter(t => dir(t) !== 'debit');
  ok('EVERY TYPE THE SERVER CALLS A CREDIT IS ONE HERE TOO',
     missingCredit.length === 0, JSON.stringify(missingCredit));
  ok('and every type it calls a debit', missingDebit.length === 0, JSON.stringify(missingDebit));

  ok('and whose row it is has one answer as well',
     ctx._isOwnTxn({ id: 'a' }) === true && ctx._isOwnTxn({ sub_account_id: 'SA-1' }) === false);
}

console.log('\nand every personal list on the screens uses both');
{
  const files = { 'portal/js/portal.js': null, 'mobile/src/js/portal.js': null };
  for (const f of Object.keys(files)) {
    files[f] = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  }
  /* PER FUNCTION, NOT PER FILE. The first version of this searched the
     whole file for PORTAL.transactions.filter(_isOwnTxn) — and both
     renderers live in it, so unscoping one of them left the other to
     satisfy the assertion. A pattern that matches the file is not a
     pattern that checks the function. */
  const fnIn = (src, name) => {
    const from = src.indexOf(`function ${name}(`);
    if (from < 0) return '';
    const next = src.indexOf('\nfunction ', from + 1);
    return src.slice(from, next < 0 ? src.length : next);
  };

  for (const [f, src] of Object.entries(files)) {
    for (const fn of ['renderMyTxnTable', 'renderOverviewTxns']) {
      const body = fnIn(src, fn);
      ok(`${f} ${fn}: it exists to be checked`, !!body,
         'renamed or moved — this assertion is about a function that is gone');
      ok(`${f} ${fn}: SCOPED TO THE HOLDER`,
         /PORTAL\.transactions\s*\n?\s*\.filter\(_isOwnTxn\)|PORTAL\.transactions\.filter\(_isOwnTxn\)/.test(body),
         'this is the list the client was looking at when they reported it: '
         + body.slice(0, 240));
      /* The app draws a card and passes the builder by reference —
         map(_txnCardHTML) — so a pattern requiring a call misses it. */
      ok(`${f} ${fn}: and signs rows from the shared definition`,
         /_txnIsCredit\(/.test(body) || /_txnCardHTML\b/.test(body),
         body.slice(0, 240));
    }
    ok(`${f}: AND CARRIES NO LIST OF ITS OWN`,
       !/\['withdrawal',\s*'fee'/.test(src),
       'four screens each had one, and every type added since any of them '
       + 'was written was money arriving by default');
  }
  /* The app draws a card rather than a row, so its sign comes through
     _txnCardHTML — which must itself use the shared answer. */
  ok('the app’s transaction card signs from the shared definition too',
     /_txnIsCredit\(t\)/.test(fnIn(files['mobile/src/js/portal.js'], '_txnCardHTML'))
     || /_txnIsPositive\(t\)/.test(fnIn(files['mobile/src/js/portal.js'], '_txnCardHTML')),
     fnIn(files['mobile/src/js/portal.js'], '_txnCardHTML').slice(0, 200));
}

console.log('\nand the wallet screen answers the same question');
{
  const list = CORE.slice(CORE.indexOf('const walletTxns'),
                          CORE.indexOf('if (!walletTxns.length)'));
  /* The spelling moved from an inline `!t.sub_account_id` to the named
     _isOwnTxn once four more lists needed the same question answered.
     Asserting the NAME is the stronger claim: it ties this screen to the
     one definition rather than to a predicate that happens to match. */
  ok('THE WALLET LISTS ITS OWN ROWS',
     /\.filter\(_isOwnTxn\)/.test(list),
     'a sub-account\u2019s rows carry the holder\u2019s investor_id, so the eight '
     + 'most recent movements on a client\u2019s wallet were often the group\u2019s: '
     + list.slice(0, 200));
  ok('AND THE TRANSFER THAT FUNDED THE GROUP IS ONE OF THEM',
     /'transfer_out'/.test(list) && /'transfer_in'/.test(list),
     'the one row about the group that IS this wallet\u2019s business was the one '
     + 'row missing \u2014 transfer_out was in no list of visible types, so money '
     + 'left and the wallet said nothing');
  ok('and the eight are still the most recent eight',
     /\.slice\(0, 8\)/.test(list), list.slice(-200));

  const chart = CORE.slice(CORE.indexOf('const txns = PORTAL.transactions.filter'),
                           CORE.indexOf('const monthly = {};'));
  ok('AND THE INCOME CHART CHARTS THEIR OWN INCOME',
     /_isOwnTxn\(t\)/.test(chart),
     'interest earned by a group, which is divided among its members by share, '
     + 'was charted as the chairperson\u2019s own earnings: ' + chart.slice(0, 200));
  ok('and still only what counts as income',
     /_isIncomeTxn\(t\)/.test(chart) && /_stmtCounts\(t\)/.test(chart), chart.slice(0, 200));
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

(async () => {
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.stokvel_allocations') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no stokvel tables here'); return; }

    const { buildAccountStatement } =
      require(path.join(ROOT, 'server', 'services', 'accountStatement.js'));

    const clean = async () => {
      await db.query(`DELETE FROM stokvel_allocations WHERE sub_account_id LIKE 'SA-ST-%'`);
      await db.query(`DELETE FROM stokvel_request_approvals WHERE request_id IN
                        (SELECT id FROM stokvel_withdrawal_requests WHERE sub_account_id LIKE 'SA-ST-%')`);
      await db.query(`DELETE FROM stokvel_withdrawal_requests WHERE sub_account_id LIKE 'SA-ST-%'`);
      await db.query(`DELETE FROM stokvel_contributions WHERE sub_account_id LIKE 'SA-ST-%'`);
      await db.query(`DELETE FROM stokvel_members WHERE sub_account_id LIKE 'SA-ST-%'`);
      await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-ST-%' OR sub_account_id LIKE 'SA-ST-%'`);
      await db.query(`DELETE FROM investments  WHERE investor_id LIKE 'INV-ST-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-ST-%'`);
      await db.query(`DELETE FROM investors    WHERE id LIKE 'INV-ST-%'`);
    };
    await clean();

    /* EVERY BALANCE ON A STATEMENT IS ANCHORED TO THE WALLET, and the
       opening is that wallet unwound by the period's movements. So a
       fixture wallet that does not equal its own ledger makes the
       statement report a gap it is right to report, and `reconciles`
       would then be testing the fixture rather than the code. Ayanda's
       wallet is her own rows: 1000 in, 200 out. */
    for (const [id, fn, wallet] of [['INV-ST-A', 'Ayanda', 800], ['INV-ST-B', 'Bongi', 0]])
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
         VALUES ($1,$2,'Member',$3,'active',$4)`,
        [id, fn, id.toLowerCase() + '@example.test', wallet]);

    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, kyc_status, status, stokvel_quorum,
                                 stokvel_reg_number, sa_reference)
       VALUES ('SA-ST-1','INV-ST-A','stokvel','Siyakhula Stokvel',
               1000,'approved','active',2,'NAS-4242','SA-ST4242')`);
    for (const [id, role] of [['INV-ST-A', 'chairperson'], ['INV-ST-B', 'member']])
      await db.query(
        `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status)
         VALUES ($1,'SA-ST-1',$2,$3,true,'active')`, ['SM-ST-' + id.slice(-1), id, role]);

    /* Transactions on BOTH the investor and the sub-account, which is the
       case that makes the no-change assertion meaningful: the investor's
       statement has always included the sub-account's rows. */
    await db.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, transaction_date, created_at, updated_at)
       VALUES (gen_random_uuid(),'INV-ST-A','deposit',1000,'completed','ST-PERS-1','Personal deposit','2026-06-10','2026-06-10',NOW())`);
    await db.query(
      `INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference, description, transaction_date, created_at, updated_at)
       VALUES (gen_random_uuid(),'INV-ST-A','SA-ST-1','stokvel_contribution_received',500,'completed','ST-GRP-1','Contribution received','2026-06-12','2026-06-12',NOW())`);
    /* A member funding the group: two rows, one movement. The OUT leaves
       the personal wallet and belongs on the personal statement; the IN
       lands in the group and belongs on the group's. */
    await db.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, transaction_date, created_at, updated_at)
       VALUES (gen_random_uuid(),'INV-ST-A','transfer_out',200,'completed','ST-OUT-1','Wallet transfer to the group','2026-06-14','2026-06-14',NOW())`);
    await db.query(
      `INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference, description, transaction_date, created_at, updated_at)
       VALUES (gen_random_uuid(),'INV-ST-A','SA-ST-1','transfer_in',200,'completed','ST-OUT-1-IN','Wallet transfer from a member','2026-06-14','2026-06-14',NOW())`);

    /* A GROUP ROW BEFORE THE WINDOW. The opening balance is the sum of the
       cash effect of everything prior, and that query is scoped by the same
       clause as the list. With only in-period rows in the fixture, dropping
       the clause from it summed nothing either way and the omission was
       invisible — a client with a group older than the statement is the
       ordinary case, not an edge one. The group's wallet is its own rows:
       300 before the window and 700 inside it. */
    await db.query(
      `INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference, description, transaction_date, created_at, updated_at)
       VALUES (gen_random_uuid(),'INV-ST-A','SA-ST-1','stokvel_contribution_received',300,'completed','ST-GRP-PRE','Contribution received','2026-05-10','2026-05-10',NOW())`);

    /* AND THE GROUP'S HOLDING. The investments on a statement are scoped by
       the same rule as the rows, and a group's investment is placed FROM the
       group's wallet by whichever member carried the mandate out — so the
       row carries that member's investor_id as well as the sub-account's,
       and listed the group's holding on their personal statement beside
       their own. */
    await db.query(
      `INSERT INTO investments (id, investor_id, sub_account_id, amount, status, product_type,
                                start_date, end_date, created_at)
       VALUES ('INVST-ST-GRP','INV-ST-A','SA-ST-1',5000,'active','fixed_term',
               '2026-06-05','2027-06-05','2026-06-05')`);
    await db.query(
      `INSERT INTO investments (id, investor_id, amount, status, product_type,
                                start_date, end_date, created_at)
       VALUES ('INVST-ST-OWN','INV-ST-A',1200,'active','fixed_term',
               '2026-06-06','2027-06-06','2026-06-06')`);

    const WIN = { from: '2026-06-01', to: '2026-06-30' };

    /* ── The regression that matters ───────────────────────────────── */
    console.log('\nan investor statement is exactly what it was');
    const asInvestor = await buildAccountStatement(db, { investorId: 'INV-ST-A', ...WIN });
    ok('it still builds', !!asInvestor && !!asInvestor.investor,
       JSON.stringify(Object.keys(asInvestor || {})));
    /* THIS ASSERTED THE OPPOSITE, and said why: an investor statement had
       always carried their sub-accounts' rows, and narrowing it would
       change documents clients already hold. That was the right call while
       a sub-account had no statement of its own. It has one now, and the
       decision was taken on 21 November 2026 to narrow it: a group's
       contributions, investments and payouts belong on the group's
       statement, not beside the chairperson's own money.

       It also makes the personal statement RECONCILE. Every balance in it
       is anchored to the holder's own wallet, and it was listing money
       that never passed through that wallet — so the ledger and the anchor
       could not agree, and the footer said so on every statement a client
       with a sub-account was issued. */
    ok('A PERSONAL STATEMENT IS PERSONAL',
       !(asInvestor.transactions || []).some(t => t.reference === 'ST-GRP-1'),
       'the group’s rows carry the holder’s investor_id too, and used to come '
       + 'along — so "what did I do with my money" was answered by a page that '
       + 'also listed what four other people did with theirs');
    ok('and it carries their own', (asInvestor.transactions || []).some(t => t.reference === 'ST-PERS-1'));

    /* THE SYMPTOM A CLIENT ACTUALLY SAW. Every balance on a statement is
       anchored to the holder's own wallet. While the rows included a
       sub-account's — money that never passed through that wallet — the
       ledger and the anchor could not agree, and the footer said so in as
       many words on every statement issued to a client with a group.
       `reconciles` is the service's own answer to whether they agree. */
    ok('AND IT RECONCILES TO THE WALLET IT IS ANCHORED TO',
       asInvestor.reconciles === true,
       `derived ${asInvestor.derived_opening_balance} vs opening `
       + `${asInvestor.opening_balance} — `
       + 'a statement that cannot tie to its own anchor tells the client so '
       + 'in a red box at the bottom');

    /* The transfer that funds a group is the holder's own money leaving, so
       it stays — it is the one row about the group that belongs here. */
    ok('THE GROUP\u2019S HOLDING IS NOT LISTED AS THEIRS',
       !(asInvestor.investments || []).some(i => i.id === 'INVST-ST-GRP'),
       'the member who placed it is on the row, which is how R5 000 of the '
       + 'group\u2019s money appeared under one person\u2019s own holdings');
    ok('and their own still is',
       (asInvestor.investments || []).some(i => i.id === 'INVST-ST-OWN'),
       JSON.stringify((asInvestor.investments || []).map(i => i.id)));

    ok('the money LEAVING for the group is still on it',
       (asInvestor.transactions || []).some(t => t.reference === 'ST-OUT-1'),
       'what left this wallet is this wallet\u2019s business; what the group '
       + 'then did with it is the group\u2019s');
    ok('and the group\u2019s side of the same transfer is not',
       !(asInvestor.transactions || []).some(t => t.reference === 'ST-OUT-1-IN'),
       'both halves on one page net to zero against an anchor that moved by '
       + 'the full amount, which is exactly how it stopped reconciling');
    ok('the person is named as a person',
       asInvestor.investor.first_name === 'Ayanda' && asInvestor.investor.last_name === 'Member',
       JSON.stringify(asInvestor.investor).slice(0, 160));
    ok('and no stokvel section is attached to it',
       !('stokvel' in asInvestor),
       'an individual’s statement must not grow a section because the code can now build one');

    /* The same call made the way the two live callers make it — positionally
       identical to before the parameter existed. */
    const asBefore = await buildAccountStatement(db, { investorId: 'INV-ST-A', from: WIN.from, to: WIN.to });
    ok('two identical calls produce identical documents',
       JSON.stringify(asBefore) === JSON.stringify(asInvestor),
       'the computation has to be a function of its inputs');

    /* ── The new half ──────────────────────────────────────────────── */
    console.log('\nand a sub-account has one at all now');
    const grp = await buildAccountStatement(db, { subAccountId: 'SA-ST-1', ...WIN });
    ok('it builds for a sub-account', !!grp && !!grp.investor);
    ok('the ACCOUNT is named, not the person who opened it',
       grp.investor.account_name === 'Siyakhula Stokvel'
       && grp.investor.first_name === 'Siyakhula Stokvel',
       JSON.stringify(grp.investor).slice(0, 200));
    ok('with its type and reference', grp.investor.account_type === 'stokvel'
       && grp.investor.sa_reference === 'SA-ST4242');
    ok('the group’s statement carries the group’s holding',
       (grp.investments || []).some(i => i.id === 'INVST-ST-GRP')
       && !(grp.investments || []).some(i => i.id === 'INVST-ST-OWN'),
       JSON.stringify((grp.investments || []).map(i => i.id)));
    ok('it carries the group’s transactions',
       (grp.transactions || []).some(t => t.reference === 'ST-GRP-1'));
    ok('and NOT the personal ones',
       !(grp.transactions || []).some(t => t.reference === 'ST-PERS-1'),
       'the group’s statement is the group’s money');
    ok('the balances anchor to the group wallet',
       Math.abs(Number(grp.closing_balance) - 1000) < 0.02,
       `closing ${grp.closing_balance}, wallet is 1000`);
    ok('and it opens where the group\u2019s earlier rows left it',
       Math.abs(Number(grp.opening_balance) - 300) < 0.02,
       `opening ${grp.opening_balance} \u2014 the 300 contributed in May`);
    ok('and the group\u2019s reconciles too', grp.reconciles === true,
       `derived ${grp.derived_opening_balance} vs opening ${grp.opening_balance} \u2014 `
       + 'the group\u2019s rows are the group\u2019s wallet, which is the other half '
       + 'of the same decision');

    console.log('\nand a stokvel’s carries what an AGM asks for');
    await db.query(
      `INSERT INTO stokvel_contributions
         (id, sub_account_id, investor_id, period_label, amount_due, amount_paid, due_date, status)
       VALUES ('SC-ST-1','SA-ST-1','INV-ST-A','2026-06',500,500,'2026-06-25','paid'),
              ('SC-ST-2','SA-ST-1','INV-ST-B','2026-06',500,0,'2026-06-25','due')`);
    await db.query(
      `INSERT INTO stokvel_withdrawal_requests
         (id, sub_account_id, requested_by, amount, kind, bank_name, bank_account_number,
          reason, quorum_required, status, expires_at, created_at)
       VALUES ('SWR-ST-1','SA-ST-1','INV-ST-A',300,'withdrawal','FNB','123','Funeral',2,
               'approved', NOW() + INTERVAL '7 days', '2026-06-15')`);
    await db.query(
      `INSERT INTO stokvel_request_approvals (id, request_id, investor_id, decision, decided_at)
       VALUES ('SRA-ST-1','SWR-ST-1','INV-ST-A','approve','2026-06-15'),
              ('SRA-ST-2','SWR-ST-1','INV-ST-B','approve','2026-06-16')`);

    const full = await buildAccountStatement(db, { subAccountId: 'SA-ST-1', ...WIN });
    ok('there is a stokvel section', !!full.stokvel, JSON.stringify(Object.keys(full)));
    ok('the group is named with its registration',
       full.stokvel.name === 'Siyakhula Stokvel' && full.stokvel.registration === 'NAS-4242');
    ok('every member is listed with their role',
       (full.stokvel.members || []).length === 2
       && full.stokvel.members.some(m => m.role === 'chairperson'));
    ok('who contributed what, and who did not',
       (full.stokvel.contributions || []).length === 2
       && full.stokvel.contributions.some(c => Number(c.paid) === 500)
       && full.stokvel.contributions.some(c => c.status === 'due'),
       JSON.stringify(full.stokvel.contributions));
    ok('each member’s share, with the pot broken down',
       !!full.stokvel.shares && full.stokvel.shares.net_assets > 0
       && (full.stokvel.shares.members || []).length === 2,
       JSON.stringify(full.stokvel.shares && full.stokvel.shares.net_assets));
    ok('THE APPROVALS REGISTER, naming who agreed',
       (full.stokvel.approvals || []).length === 1
       && full.stokvel.approvals[0].votes.length === 2
       && full.stokvel.approvals[0].votes.every(v => v.name && v.decision),
       JSON.stringify(full.stokvel.approvals));
    ok('and it says which two, not that two agreed',
       full.stokvel.approvals[0].votes.some(v => /Ayanda/.test(v.name))
       && full.stokvel.approvals[0].votes.some(v => /Bongi/.test(v.name)),
       'a stokvel answering to its own members needs the names');

    console.log('\nand a statement is not handed to the wrong person');
    {
      const SRC = require('fs').readFileSync(
        path.join(ROOT, 'server', 'routes', 'statements.js'), 'utf8');
      ok('the route checks the caller may read that account',
         /parent_investor_id = \$2/.test(SRC) && /stokvel_members/.test(SRC),
         'an id in a query string is not an entitlement');
      ok('and answers 404 rather than describing it',
         /No such account\./.test(SRC),
         'a caller who is not on the account learns nothing, not even that it is real');
    }

    await clean();
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
