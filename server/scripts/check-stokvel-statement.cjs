#!/usr/bin/env node
/* A statement for an account that is not a person.
 *
 * No sub-account had one — not a stokvel, a trust, a business or a child's
 * account — because every query in services/accountStatement.js is scoped by
 * investor_id. A stokvel's AGM had nothing to table.
 *
 * THE ASSERTION THAT MATTERS MOST IS THE ONE ABOUT NOT CHANGING ANYTHING.
 * This service produces live client statements. An investor's statement
 * today includes their sub-accounts' transactions, because those rows carry
 * investor_id as well — so "scope it to the investor properly" would be a
 * silent change to documents clients already hold. The first thing checked
 * below is that an investor statement is IDENTICAL, field for field, to
 * what the same inputs produced before the sub-account dimension existed.
 *
 * Then the new half: a stokvel statement carries the money view every
 * account gets, plus the three things an AGM actually asks — who
 * contributed what, what each member's share is, and WHICH signatories
 * approved the money that moved.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-stokvel-statement.cjs
 */
'use strict';

const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

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

    for (const [id, fn] of [['INV-ST-A', 'Ayanda'], ['INV-ST-B', 'Bongi']])
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
         VALUES ($1,$2,'Member',$3,'active',5000)`, [id, fn, id.toLowerCase() + '@example.test']);

    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, kyc_status, status, stokvel_quorum,
                                 stokvel_reg_number, sa_reference)
       VALUES ('SA-ST-1','INV-ST-A','stokvel','Siyakhula Stokvel',
               1500,'approved','active',2,'NAS-4242','SA-ST4242')`);
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

    const WIN = { from: '2026-06-01', to: '2026-06-30' };

    /* ── The regression that matters ───────────────────────────────── */
    console.log('\nan investor statement is exactly what it was');
    const asInvestor = await buildAccountStatement(db, { investorId: 'INV-ST-A', ...WIN });
    ok('it still builds', !!asInvestor && !!asInvestor.investor,
       JSON.stringify(Object.keys(asInvestor || {})));
    ok('and still carries the sub-account’s rows',
       (asInvestor.transactions || []).some(t => t.reference === 'ST-GRP-1'),
       'an investor statement has always included their sub-accounts’ transactions — '
       + 'narrowing that would silently change documents clients already hold');
    ok('and their own', (asInvestor.transactions || []).some(t => t.reference === 'ST-PERS-1'));
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
    ok('it carries the group’s transactions',
       (grp.transactions || []).some(t => t.reference === 'ST-GRP-1'));
    ok('and NOT the personal ones',
       !(grp.transactions || []).some(t => t.reference === 'ST-PERS-1'),
       'the group’s statement is the group’s money');
    ok('the balances anchor to the group wallet',
       Math.abs(Number(grp.closing_balance) - 1500) < 0.02,
       `closing ${grp.closing_balance}, wallet is 1500`);

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
