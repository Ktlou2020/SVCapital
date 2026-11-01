#!/usr/bin/env node
/* What is my share — and what happens when I leave.
 *
 * A stokvel member could not find out what their share of the pot was, and a
 * member set to 'exited' was simply stopped from seeing the group while their
 * money stayed pooled. The second half of that was a live bug, not a missing
 * feature: nothing calculated what they were owed and nothing paid it.
 *
 * EVERYTHING HERE IS ONE ASSERTION, MADE REPEATEDLY:
 *
 *     Σ active members' shares
 *       = wallet + investments at cost − unpaid exit debts
 *
 * It is checked after every kind of money movement a stokvel can make,
 * because a split pot is only worth having if it cannot drift from the money
 * it is splitting. The ways it would drift are each their own test:
 *
 *  · ROUNDING. R10 between three members is R3.33 three times and a lost
 *    cent. Over a year of monthly interest a stokvel's books wander away
 *    from its wallet by amounts nobody can account for, which is the
 *    argument this feature exists to end.
 *  · INVESTING. Money moving from the wallet into a pool must not change
 *    anybody's share — it is the same money in a different place — while the
 *    1% fee on top is a real cost and must.
 *  · AN EXIT THAT OUTRUNS THE CASH. The pot may be R20 000 in an
 *    eighteen-month cattle pool and R600 in the wallet. The leaver takes the
 *    R600 and is owed the rest, which is senior to current members' income
 *    and earns nothing itself.
 *  · ARREARS. What a leaver owed stays in the pot for the members who chased
 *    it, and is not paid out to them on the way through the door.
 *  · THE MANDATE. An exit is group money leaving. No one person ends a
 *    membership and draws the share.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-stokvel-shares.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

console.log('\nthe per-member money is not readable by everybody');
{
  const TB = codeOnly(read('server/routes/tables.js'));
  const i = TB.indexOf('ADMIN_ONLY_TABLES');
  const list = TB.slice(i, i + 1800);
  ok('stokvel_allocations is admin-only', /'stokvel_allocations'/.test(list),
     'unlisted, the generic reader hands every signed-in investor every stokvel’s internal split');
  ok('and so is stokvel_exit_debts', /'stokvel_exit_debts'/.test(list));
}

/* The split, before any database is involved. Pure arithmetic, so the
   failure is unambiguous when it is the arithmetic that is wrong. */
console.log('\nsplitting an amount never loses or invents a cent');
{
  const shares = require(path.join(ROOT, 'server', 'services', 'stokvelShares.js'));
  const sum = m => [...m.values()].reduce((a, b) => a + b, 0);
  const w3 = new Map([['a', 100], ['b', 100], ['c', 100]]);
  ok('R10 three ways sums to R10', sum(shares.splitPro(10, w3)) === 1000,
     String(sum(shares.splitPro(10, w3))));
  ok('one cent two ways sums to one cent',
     sum(shares.splitPro(0.01, new Map([['a', 333.33], ['b', 666.67]]))) === 1,
     'the part that rounds to nothing still has to go somewhere');
  ok('a cost splits as exactly as a credit',
     sum(shares.splitPro(-5.55, w3)) === -555, String(sum(shares.splitPro(-5.55, w3))));
  ok('and the remainder goes to the largest holder',
     shares.splitPro(10, new Map([['a', 1], ['b', 1000]])).get('b') > 900,
     'dropping it is how the books drift; scattering it is how a split stops being reproducible');
  ok('a credit into a group where nobody holds anything is shared equally',
     sum(shares.splitPro(90, new Map([['a', 0], ['b', 0], ['c', 0]]))) === 9000,
     'pro-rata on nothing has no answer, and dropping it leaves a gap reconcile '
     + 'would try to allocate for ever');
  ok('awkward thirds still sum',
     sum(shares.splitPro(1000.03, w3)) === 100003, String(sum(shares.splitPro(1000.03, w3))));
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

const sent = { email: [], push: [], sms: [] };
function stub(record) {
  return new Proxy({}, { get(_t, k) {
    if (typeof k !== 'string' || k === 'then' || k === 'inspect') return undefined;
    return (...args) => { record.push({ fn: k, args }); return Promise.resolve({ ok: true }); };
  } });
}
for (const [f, r] of [['email.js', sent.email], ['pushService.js', sent.push], ['sms.js', sent.sms]]) {
  const p = path.join(ROOT, 'server', 'services', f);
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: stub(r) };
}

(async () => {
  let srv;
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.stokvel_allocations') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no share tables here'); return; }

    const shares = require(path.join(ROOT, 'server', 'services', 'stokvelShares.js'));

    const clean = async () => {
      await db.query(`DELETE FROM stokvel_allocations WHERE sub_account_id LIKE 'SA-SH-%'`);
      await db.query(`DELETE FROM stokvel_exit_debts  WHERE sub_account_id LIKE 'SA-SH-%'`);
      await db.query(`DELETE FROM stokvel_request_approvals WHERE request_id IN
                        (SELECT id FROM stokvel_withdrawal_requests WHERE sub_account_id LIKE 'SA-SH-%')`);
      await db.query(`DELETE FROM stokvel_withdrawal_requests WHERE sub_account_id LIKE 'SA-SH-%'`);
      await db.query(`DELETE FROM stokvel_contributions WHERE sub_account_id LIKE 'SA-SH-%'`);
      await db.query(`DELETE FROM stokvel_members WHERE sub_account_id LIKE 'SA-SH-%'`);
      await db.query(`DELETE FROM investments  WHERE sub_account_id LIKE 'SA-SH-%'`);
      await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-SH-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-SH-%'`);
      await db.query(`DELETE FROM investors    WHERE id LIKE 'INV-SH-%'`);
      await db.query(`DELETE FROM investment_pools WHERE id LIKE 'POOL-SH-%'`);
    };
    await clean();

    const MEMBERS = ['INV-SH-A', 'INV-SH-B', 'INV-SH-C'];
    for (const id of MEMBERS)
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, phone, status, wallet_balance)
         VALUES ($1,$2,'Member',$3,$4,'active',10000)`,
        [id, id.slice(-1), `${id.toLowerCase()}@example.test`, '072000000' + id.slice(-1)]);

    /* Quorum 2 of 3 so an exit needs more than the leaver's own say-so. */
    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, kyc_status, status, stokvel_quorum, share_basis)
       VALUES ('SA-SH-1','INV-SH-A','stokvel','Masiphumelele Stokvel',
               0,'approved','active',2,'contribution')`);
    for (const [i, id] of MEMBERS.entries())
      await db.query(
        `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status)
         VALUES ($1,'SA-SH-1',$2,$3,true,'active')`,
        ['SM-SH-' + id.slice(-1), id, i === 0 ? 'chairperson' : 'member']);

    await db.query(
      `INSERT INTO investment_pools (id, name, product_type, status, annual_rate,
                                     term_months, min_investment, max_capacity, current_invested)
       VALUES ('POOL-SH-1','Cattle March','cattle','open',0.14,18,100,10000000,0)`);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
    app.use('/api/tables',   require(path.join(ROOT, 'server', 'routes', 'tables.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });

    const tok = id => jwt.sign({ id: 'u-' + id, role: 'investor', investorId: id },
                               process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = (method, p, token, body) => new Promise(res => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign({ Authorization: `Bearer ${token}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s = ''; x.on('data', c => s += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s || '{}') })); });
      if (payload) r.write(payload);
      r.end();
    });

    /* THE assertion. Called after every movement below. */
    const invariant = async (where, group = 'SA-SH-1') => {
      const a = await shares.audit(db, group);
      ok(`the books balance ${where}`, Math.abs(a.difference) < 0.005,
         `assets ${a.assets} vs shares ${a.shares}, out by ${a.difference} `
         + `(wallet ${a.parts.wallet}, invested ${a.parts.invested}, owed ${a.parts.owed})`);
      return a;
    };
    const shareOf = async id => {
      const r = await call('GET', '/api/stokvels/SA-SH-1/shares', tok(id));
      return r.body.data;
    };

    /* ── Contributions ─────────────────────────────────────────────── */
    console.log('\na contribution becomes that member’s share, and nobody else’s');
    const contribute = async (id, amount, period) => {
      await db.query(
        `INSERT INTO stokvel_contributions
           (id, sub_account_id, investor_id, period_label, amount_due, amount_paid, due_date, status)
         VALUES ($1,'SA-SH-1',$2,$3,$4,0,CURRENT_DATE,'due')
         ON CONFLICT (sub_account_id, investor_id, period_label) DO NOTHING`,
        [`SC-SH-${id.slice(-1)}-${period}`, id, period, amount]);
      const { rows: [c] } = await db.query(
        `SELECT id FROM stokvel_contributions
          WHERE sub_account_id='SA-SH-1' AND investor_id=$1 AND period_label=$2`, [id, period]);
      return call('POST', `/api/stokvels/SA-SH-1/contributions/${c.id}/pay`, tok(id), {});
    };
    await contribute('INV-SH-A', 1000, '2026-01');
    await contribute('INV-SH-B', 1000, '2026-01');
    await contribute('INV-SH-C', 500,  '2026-01');

    const s1 = await shareOf('INV-SH-A');
    ok('each member’s share is what they put in',
       s1.shares.find(x => x.investor_id === 'INV-SH-A').share === 1000 &&
       s1.shares.find(x => x.investor_id === 'INV-SH-C').share === 500,
       JSON.stringify(s1.shares.map(x => [x.investor_id, x.share])));
    ok('and the group’s net assets are the sum of them', s1.net_assets === 2500,
       String(s1.net_assets));
    await invariant('after three contributions');

    /* ── Income ────────────────────────────────────────────────────── */
    console.log('\ninterest on the group wallet reaches the members in proportion');
    /* Credited straight to the wallet, exactly as the 3PIM interest import
       does — the point is that NOTHING hooked this and it is still shared. */
    await db.query(
      `UPDATE sub_accounts SET wallet_balance = wallet_balance + 250 WHERE id = 'SA-SH-1'`);
    const s2 = await shareOf('INV-SH-A');
    const a2 = s2.shares.find(x => x.investor_id === 'INV-SH-A').share;
    const c2 = s2.shares.find(x => x.investor_id === 'INV-SH-C').share;
    ok('a credit nothing hooked is still shared out', a2 > 1000 && c2 > 500,
       JSON.stringify(s2.shares.map(x => [x.investor_id, x.share])));
    ok('in proportion to what each holds', Math.abs(a2 - 1100) < 0.02 && Math.abs(c2 - 550) < 0.02,
       `A ${a2} (expected 1100), C ${c2} (expected 550)`);
    await invariant('after interest');

    /* ── Investing ─────────────────────────────────────────────────── */
    console.log('\ninvesting the pot moves nobody’s share, but its fee does');
    const before = await shareOf('INV-SH-A');
    const raise = async body => (await call('POST', '/api/stokvels/SA-SH-1/withdrawal-requests',
                                            tok('INV-SH-A'), body)).body.data;
    const vote = (rid, who) => call('POST',
      `/api/stokvels/SA-SH-1/withdrawal-requests/${rid}/vote`, tok(who), { decision: 'approve' });
    const auth = await raise({ amount: 2000, kind: 'investment', pool_id: 'POOL-SH-1' });
    await vote(auth.id, 'INV-SH-A'); await vote(auth.id, 'INV-SH-B');
    const invested = await call('POST', '/api/tables/investments', tok('INV-SH-A'), {
      id: 'INVST-SH-1', investor_id: 'INV-SH-A', sub_account_id: 'SA-SH-1',
      pool_id: 'POOL-SH-1', pool_name: 'Cattle March', amount: 2000,
      annual_rate: 0.14, term_months: 18, status: 'active',
      start_date: '2026-03-01', end_date: '2027-09-01', authority_id: auth.id,
    });
    ok('the approved investment goes through', invested.status < 300,
       `${invested.status} ${JSON.stringify(invested.body).slice(0, 200)}`);
    const after = await shareOf('INV-SH-A');
    ok('net assets drop by the fee only, not by the investment',
       Math.abs((before.net_assets - after.net_assets) - 20) < 0.02,
       `${before.net_assets} → ${after.net_assets} (the 1% on R2 000 is R20)`);
    ok('and the money is counted where it now sits', after.invested === 2000,
       `invested ${after.invested}, wallet ${after.wallet}`);
    await invariant('after investing and its fee');
    /* The reconcile inside the investment's own transaction is not what makes
       the fee reach the members — the read-time and daily reconciles would
       catch it anyway. What it provides is a LEGIBLE reason: a member reading
       their own ledger sees "Platform fee on an investment" rather than
       "Shared out on read", and a share ledger nobody can interpret settles
       no arguments. */
    const feeRow = (await db.query(
      `SELECT reason, kind FROM stokvel_allocations
        WHERE sub_account_id = 'SA-SH-1' AND kind = 'cost'
        ORDER BY created_at DESC LIMIT 1`)).rows[0];
    ok('and the cost says in the ledger what it was for',
       feeRow && /fee/i.test(feeRow.reason || ''), JSON.stringify(feeRow));

    /* ── Equal basis ───────────────────────────────────────────────── */
    console.log('\nand a group whose constitution says equal gets equal');
    await db.query(`UPDATE sub_accounts SET share_basis = 'equal' WHERE id = 'SA-SH-1'`);
    const eq = await shareOf('INV-SH-A');
    const vals = eq.shares.map(x => x.share);
    ok('the pot divides by head regardless of who put in what',
       Math.max(...vals) - Math.min(...vals) < 0.02, JSON.stringify(vals));
    ok('and it still sums to the pot',
       Math.abs(vals.reduce((a, b) => a + b, 0) - eq.net_assets) < 0.02,
       `${vals.reduce((a, b) => a + b, 0)} vs ${eq.net_assets}`);
    await db.query(`UPDATE sub_accounts SET share_basis = 'contribution' WHERE id = 'SA-SH-1'`);

    /* ── Arrears come off the share, not out of the pot ────────────── */
    console.log('\nan exit needs the signatories, and arrears stay behind');
    await db.query(
      `INSERT INTO stokvel_contributions
         (id, sub_account_id, investor_id, period_label, amount_due, amount_paid, due_date, status)
       VALUES ('SC-SH-C-ARR','SA-SH-1','INV-SH-C','2026-02',500,0,CURRENT_DATE,'due')`);

    const noAuth = await call('POST', '/api/stokvels/SA-SH-1/exits', tok('INV-SH-C'), {});
    ok('nobody settles their own exit without an authority', noAuth.status === 403,
       `${noAuth.status} ${JSON.stringify(noAuth.body)}`);

    const exitAuth = await raise({ amount: 600, kind: 'exit', exit_investor_id: 'INV-SH-C' });
    ok('an exit can be raised against the mandate', !!(exitAuth && exitAuth.id),
       JSON.stringify(exitAuth));
    const onlyOne = await call('POST', '/api/stokvels/SA-SH-1/exits', tok('INV-SH-C'),
                               { authority_id: exitAuth.id });
    ok('and one approval does not release it', onlyOne.status === 403,
       `${onlyOne.status} ${JSON.stringify(onlyOne.body)}`);

    await vote(exitAuth.id, 'INV-SH-A'); await vote(exitAuth.id, 'INV-SH-B');

    const cShareBefore = (await shareOf('INV-SH-C')).shares
      .find(x => x.investor_id === 'INV-SH-C');
    const walletBefore = Number((await db.query(
      'SELECT wallet_balance FROM investors WHERE id = $1', ['INV-SH-C'])).rows[0].wallet_balance);

    const settled = await call('POST', '/api/stokvels/SA-SH-1/exits', tok('INV-SH-C'),
                               { authority_id: exitAuth.id });
    ok('an approved exit settles', settled.status === 200,
       `${settled.status} ${JSON.stringify(settled.body)}`);
    const out = settled.body.data || {};
    ok('the arrears come off what is paid',
       Math.abs(Number(out.arrears) - 500) < 0.02, JSON.stringify(out));
    ok('and stay in the pot for the members who chased them',
       Math.abs(Number(out.net) - (cShareBefore.gross - 500)) < 0.02,
       `net ${out.net}, gross ${cShareBefore.gross}`);
    const walletAfter = Number((await db.query(
      'SELECT wallet_balance FROM investors WHERE id = $1', ['INV-SH-C'])).rows[0].wallet_balance);
    ok('what was paid reached their own wallet',
       Math.abs((walletAfter - walletBefore) - Number(out.paid)) < 0.02,
       `wallet moved ${walletAfter - walletBefore}, settlement says ${out.paid}`);
    ok('their obligations are closed rather than left due against a non-member',
       (await db.query(`SELECT COUNT(*)::int AS n FROM stokvel_contributions
                         WHERE sub_account_id='SA-SH-1' AND investor_id='INV-SH-C' AND status='due'`))
         .rows[0].n === 0);
    ok('and they are off the roster',
       (await db.query(`SELECT status, is_signatory FROM stokvel_members
                         WHERE sub_account_id='SA-SH-1' AND investor_id='INV-SH-C'`))
         .rows[0].status === 'exited');
    ok('the same authority cannot settle a second exit',
       (await call('POST', '/api/stokvels/SA-SH-1/exits', tok('INV-SH-C'),
                   { authority_id: exitAuth.id })).status >= 400);
    await invariant('after an exit');

    /* ── An exit that outruns the cash ─────────────────────────────── */
    console.log('\nand an exit the cash cannot cover pays what is there and owes the rest');
    const cash = Number((await db.query(
      `SELECT wallet_balance FROM sub_accounts WHERE id='SA-SH-1'`)).rows[0].wallet_balance);
    const bShare = (await shareOf('INV-SH-B')).shares.find(x => x.investor_id === 'INV-SH-B').share;
    ok('the set-up is the real case: their share exceeds the wallet', bShare > cash,
       `share ${bShare}, wallet ${cash} — the rest is in the cattle pool`);

    const bAuth = await raise({ amount: bShare, kind: 'exit', exit_investor_id: 'INV-SH-B' });
    await vote(bAuth.id, 'INV-SH-A'); await vote(bAuth.id, 'INV-SH-B');
    const bOut = (await call('POST', '/api/stokvels/SA-SH-1/exits', tok('INV-SH-B'),
                             { authority_id: bAuth.id })).body.data || {};
    ok('they are paid what the wallet held', Math.abs(Number(bOut.paid) - cash) < 0.02,
       `paid ${bOut.paid}, wallet was ${cash}`);
    ok('and the remainder is recorded as owed to them',
       Math.abs(Number(bOut.queued) - (Number(bOut.net) - cash)) < 0.02, JSON.stringify(bOut));
    ok('they leave at once rather than waiting on the cattle pool',
       (await db.query(`SELECT status FROM stokvel_members
                         WHERE sub_account_id='SA-SH-1' AND investor_id='INV-SH-B'`))
         .rows[0].status === 'exited');
    const debtRow = (await db.query(
      `SELECT amount_owed, amount_paid, status FROM stokvel_exit_debts
        WHERE sub_account_id='SA-SH-1' AND investor_id='INV-SH-B'`)).rows[0];
    ok('the debt is on the group’s books', debtRow && debtRow.status === 'owing',
       JSON.stringify(debtRow));
    await invariant('after a part-settled exit');

    /* The remaining member must not be shown money that is already promised. */
    const afterDebt = await shareOf('INV-SH-A');
    ok('what is owed to a former member is not in the remaining members’ shares',
       Math.abs(afterDebt.net_assets -
         (afterDebt.wallet + afterDebt.invested - afterDebt.owed_to_former_members)) < 0.02,
       JSON.stringify(afterDebt));
    ok('and the group can see it', afterDebt.owed_to_former_members > 0,
       String(afterDebt.owed_to_former_members));

    /* ── The debt is senior, and earns nothing ─────────────────────── */
    console.log('\ncash that arrives pays the former member before it pays anybody’s share');
    const owedBefore = Number(debtRow.amount_owed) - Number(debtRow.amount_paid);
    const groupWalletBefore = Number((await db.query(
      `SELECT wallet_balance FROM sub_accounts WHERE id='SA-SH-1'`)).rows[0].wallet_balance);
    const bWalletBefore = Number((await db.query(
      'SELECT wallet_balance FROM investors WHERE id = $1', ['INV-SH-B'])).rows[0].wallet_balance);
    const netBefore = (await shareOf('INV-SH-A')).net_assets;

    /* Half of what is owed arrives — maturity, interest, it does not matter
       which, and nothing hooks either of them. */
    const arriving = Math.round((owedBefore / 2) * 100) / 100;
    await db.query(
      `UPDATE sub_accounts SET wallet_balance = wallet_balance + $1 WHERE id = 'SA-SH-1'`, [arriving]);
    const afterCash = await shareOf('INV-SH-A');
    const debtNow = (await db.query(
      `SELECT amount_owed, amount_paid, status FROM stokvel_exit_debts
        WHERE sub_account_id='SA-SH-1' AND investor_id='INV-SH-B'`)).rows[0];
    const bWalletAfter = Number((await db.query(
      'SELECT wallet_balance FROM investors WHERE id = $1', ['INV-SH-B'])).rows[0].wallet_balance);
    const groupWalletAfter = Number((await db.query(
      `SELECT wallet_balance FROM sub_accounts WHERE id='SA-SH-1'`)).rows[0].wallet_balance);

    /* SENIORITY IS ABOUT CASH, not about value. The first draft of this
       asserted that the remaining member's share must not move, which is
       wrong and took a while to see: the money arriving is EARNINGS, and
       earnings do belong to the members who are still there. Paying the debt
       takes cash out and takes the same amount of liability off, so net
       assets are unchanged by the payment itself and up by exactly what was
       earned. What seniority means is that the cash reaches the former
       member rather than sitting in the group's wallet until somebody
       decides. */
    ok('the cash reached the former member', Math.abs((bWalletAfter - bWalletBefore) - arriving) < 0.02,
       `their wallet moved ${bWalletAfter - bWalletBefore}, ${arriving} arrived`);
    ok('rather than sitting in the group wallet',
       Math.abs(groupWalletAfter - groupWalletBefore) < 0.02,
       `group wallet ${groupWalletBefore} \u2192 ${groupWalletAfter}`);
    ok('and it came off what is owed', Number(debtNow.amount_paid) > 0, JSON.stringify(debtNow));
    ok('the group is better off by what it earned, not by what it repaid',
       Math.abs((afterCash.net_assets - netBefore) - arriving) < 0.02,
       `net assets ${netBefore} \u2192 ${afterCash.net_assets}, earned ${arriving} \u2014 `
       + 'repaying a debt moves cash and liability together and changes nothing');
    ok('the former member\u2019s debt did not grow while it waited',
       Math.abs(Number(debtNow.amount_owed) - Number(debtRow.amount_owed)) < 0.005,
       'their share was crystallised the day they left; the growth since is not theirs');
    await invariant('after paying down an exit debt');

    /* ── Who may see it ───────────────────────────────────────────── */
    console.log('\nand the split is the group’s business, not the platform’s');
    await db.query(
      `INSERT INTO investors (id, first_name, email, phone, status, wallet_balance)
       VALUES ('INV-SH-OUT','Out','out@example.test','0729998888','active',0)`);
    ok('somebody outside the stokvel cannot read the shares',
       (await call('GET', '/api/stokvels/SA-SH-1/shares', tok('INV-SH-OUT'))).status === 404);
    const everyone = await shareOf('INV-SH-A');
    ok('every member sees every member’s share',
       everyone.shares.length >= 1 && everyone.shares.every(x => 'share' in x),
       'a share only its owner can see is a treasurer’s spreadsheet with extra steps');
    ok('and is told which of them is theirs',
       everyone.shares.some(x => x.is_me) && everyone.my_share === everyone.shares.find(x => x.is_me).share,
       JSON.stringify({ my_share: everyone.my_share }));
    await db.query(`DELETE FROM investors WHERE id = 'INV-SH-OUT'`);

    console.log('\nand the member who left was told what they were paid and what is owed');
    ok('the settlement message carries both figures',
       sent.email.concat(sent.push).some(c => {
         const t = JSON.stringify(c.args);
         return /exit/i.test(t) && /owed|follow|mature/i.test(t);
       }),
       'a message reporting only the cash paid reads as the whole settlement');

    /* ── The person who opened it, leaving ─────────────────────────
       sub_accounts.parent_investor_id grants access on its own. A
       chairperson who exits and keeps it is paid out AND still sees the
       wallet, the roster and every member's share, and can still invite
       people \u2014 for a product whose whole claim is "no one member", the
       worst possible person to leave holding the door. The exit feature
       created that path, so the exit has to close it. */
    console.log('\nand the member who opened it hands it on when they go');
    {
      const owner = async () => (await db.query(
        `SELECT parent_investor_id FROM sub_accounts WHERE id='SA-SH-1'`)).rows[0].parent_investor_id;
      ok('A opened this stokvel', (await owner()) === 'INV-SH-A');

      /* C and B have already left above, so bring a successor in. */
      await db.query(
        `INSERT INTO investors (id, first_name, email, phone, status, wallet_balance)
         VALUES ('INV-SH-D','Dineo','d@example.test','0729990003','active',0)
         ON CONFLICT (id) DO NOTHING`);
      await db.query(
        `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status)
         VALUES ('SM-SH-D','SA-SH-1','INV-SH-D','member',true,'active')
         ON CONFLICT (sub_account_id, investor_id) DO UPDATE SET status='active', is_signatory=true`);

      const aAuth = await raise({ amount: 1, kind: 'exit', exit_investor_id: 'INV-SH-A' });
      await vote(aAuth.id, 'INV-SH-A'); await vote(aAuth.id, 'INV-SH-D');
      const gone = await call('POST', '/api/stokvels/SA-SH-1/exits', tok('INV-SH-A'),
                              { authority_id: aAuth.id });
      ok('the chairperson can leave', gone.status === 200, JSON.stringify(gone.body).slice(0, 200));
      ok('AND THE ACCOUNT IS HANDED TO SOMEBODY STILL IN THE GROUP',
         (await owner()) === 'INV-SH-D', `owner is now ${await owner()}`);
      ok('who becomes the chairperson',
         (await db.query(`SELECT role FROM stokvel_members
                           WHERE sub_account_id='SA-SH-1' AND investor_id='INV-SH-D'`))
           .rows[0].role === 'chairperson');
      ok('and the one who left can no longer see the stokvel at all',
         !((await call('GET', '/api/stokvels', tok('INV-SH-A'))).body.data || [])
            .some(x => x.id === 'SA-SH-1'),
         'they were paid out \u2014 the group\u2019s money is no longer their business');
      ok('nor open it directly',
         (await call('GET', '/api/stokvels/SA-SH-1', tok('INV-SH-A'))).status === 404);
      ok('nor read the shares',
         (await call('GET', '/api/stokvels/SA-SH-1/shares', tok('INV-SH-A'))).status === 404);
      ok('nor invite anybody into it',
         (await call('POST', '/api/stokvels/SA-SH-1/invites', tok('INV-SH-A'),
                     { name: 'Friend', email: 'friend@example.test' })).status === 404,
         'mayInvite reads the same ownership column the guard does');
      await invariant('after the chairperson left');

      /* THE LAST MEMBER OUT cannot take the account with them.
         Exercised against the service rather than the route, because the
         route cannot reach it: the mandate needs two approvals and only
         counts CURRENT signatories, so a sole remaining member is refused
         by the quorum long before the owner rule is consulted. The guard is
         still worth having \u2014 settleExit is a service, and the next caller
         of it may not come through that route. */
      const soleOut = await (async () => {
        const c = await db.connect();
        try {
          await c.query('BEGIN');
          const r = await shares.settleExit(c, {
            subAccountId: 'SA-SH-1', investorId: 'INV-SH-D', authorityId: null });
          await c.query('ROLLBACK');
          return r;
        } finally { c.release(); }
      })();
      ok('the last member cannot leave the account with no owner',
         !!(soleOut && soleOut.error), JSON.stringify(soleOut).slice(0, 200));
      ok('and is told to close the stokvel instead',
         /closed with us/i.test((soleOut && soleOut.error) || ''),
         JSON.stringify(soleOut));
      ok('the account still has its owner', (await owner()) === 'INV-SH-D');
      await db.query(`DELETE FROM investors WHERE id='INV-SH-D'`).catch(() => {});
    }

    await clean();
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
