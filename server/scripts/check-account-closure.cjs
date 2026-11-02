#!/usr/bin/env node
/* Closing an account you still have money in.
 *
 * DELETE /api/privacy/account checked a confirmation string and anonymised.
 * It looked at nothing else, and then told the person "active investments
 * will continue until maturity" — which is true and is exactly the problem.
 * They mature into a wallet belonging to "Deleted User", on an address at
 * deleted.invalid, behind a users row set inactive. The maturity email
 * bounces. Nobody can sign in. The money is still theirs and they can no
 * longer reach it.
 *
 * A STOKVEL makes it worse in two ways the old code had no idea existed. A
 * member keeps their share of the group's pot, and the share ledger has no
 * way to express "owed to nobody". And a CHAIRPERSON is the investor in
 * sub_accounts.parent_investor_id — close their account and the group's
 * money is held under a record with nobody behind it, with the succession
 * flow never run because nobody ever exited.
 *
 * Erasure is a right under POPIA. It is not a way to abandon money.
 *
 * Run: DATABASE_URL=… node server/scripts/check-account-closure.cjs
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
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

console.log('the route asks before it erases');
{
  const r = read('server/routes/privacy.js');
  const del = r.slice(r.indexOf("router.delete('/account'"));
  /* Both positions required to be FOUND. With indexOf alone a missing call
     returns -1, which is less than everything, so the assertion passed
     precisely when the call had been deleted. */
  const asked = del.indexOf('closure.blockersFor');
  const wrote = del.indexOf('UPDATE investors');
  ok('and before anything is anonymised',
     asked > -1 && wrote > -1 && asked < wrote,
     `blockersFor at ${asked}, the first write at ${wrote} — anonymising and `
     + 'then refusing leaves the account half closed');
  ok('and the same list can be asked for first',
     /router\.get\('\/account\/closure'/.test(r),
     'accepting a typed confirmation and then rejecting it is a bad way to '
     + 'tell somebody they have money left');
  ok('closing also stands everything down',
     /closure\.standDown\(/.test(del),
     'a card charged on behalf of a closed account is the one mistake here '
     + 'that would be indefensible');
  /* The RESPONSE, not the file: the comment above the handler quotes the
     old wording as the thing it replaced, and a whole-file search finds
     that instead. The same trap caught an assertion two commits ago. */
  const reply = del.slice(del.indexOf('res.json({'), del.indexOf('res.json({') + 420);
  ok('and no longer promises investments will quietly mature',
     !/will continue until maturity/.test(reply),
     'into a wallet nobody can sign in to: ' + reply.slice(0, 200));
  ok('it says plainly what is kept and why',
     /required to\s*'?\s*\+?\s*'?\s*keep it/.test(reply) || /required to keep it/.test(reply.replace(/'\s*\+\s*'/g, '')),
     reply.slice(0, 260));
}

console.log('\nand the portal asks the right thing of the right route');
{
  const core = read('js/portal-core.js');
  const fn = core.slice(core.indexOf('async function confirmAccountDeletion'),
                        core.indexOf('async function confirmAccountDeletion') + 1400);
  ok('it uses DELETE, which is the method the route answers to',
     /_fetch\('DELETE', 'privacy\/account'/.test(fn),
     'it POSTed to a DELETE-only route, so it 404\u2019d every single time');
  ok('and a failure is shown, not turned into a support ticket',
     !/tickets\.create/.test(fn),
     'the old catch swallowed the 404, filed a ticket and said "account '
     + 'deletion request submitted" \u2014 so somebody believed they had been '
     + 'erased when they had not, which under POPIA is worse than failing');
  ok('what is in the way is shown before the confirmation is typed',
     /privacy\/account\/closure/.test(core),
     'asking somebody to type a phrase and then refusing is a bad way to '
     + 'tell them they still have money here');

  for (const page of ['portal/index.html', 'mobile/src/index.html']) {
    const html = read(page);
    ok(`${page} no longer claims investments are cancelled`,
       !/cancel all active investments/.test(html),
       'closing an account does not cancel an investment, and telling a '
       + 'client it does is telling them something false about their money');
    ok(`${page} no longer claims the data is permanently deleted`,
       !/permanently delete your personal data/.test(html),
       'the transaction history is KEPT, because an FSP is required to keep '
       + 'it \u2014 it is the name on it that goes');
    ok(`${page} has somewhere to put the blockers`,
       /id="deleteAccountBlockers"/.test(html));
  }
}

(async () => {
  if (!process.env.DATABASE_URL) {
    fail++;
    console.log('\n  ✗ the blocker half needs a database');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  const pool    = require(path.join(ROOT, 'server', 'db', 'pool.js'));
  const closure = require(path.join(ROOT, 'server', 'services', 'accountClosure.js'));

  const ME = 'INV-CL';
  async function fixture({ wallet = 0 } = {}) {
    await pool.query(`DELETE FROM stokvel_members WHERE investor_id IN ($1,'INV-CL2')`, [ME]);
    await pool.query(`DELETE FROM paystack_authorizations WHERE investor_id = $1`, [ME]);
    await pool.query(`DELETE FROM payment_reversals WHERE investor_id = $1`, [ME]);
    await pool.query(`DELETE FROM transactions WHERE investor_id = $1`, [ME]);
    await pool.query(`DELETE FROM investments WHERE investor_id = $1`, [ME]);
    await pool.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-CL%'`);
    await pool.query(`DELETE FROM investors WHERE id IN ($1,'INV-CL2')`, [ME]);
    await pool.query(
      `INSERT INTO investors (id, first_name, last_name, email, wallet_balance, status)
       VALUES ($1,'Thandi','M','cl@example.test',$2,'active'),
              ('INV-CL2','Other','P','cl2@example.test',0,'active')`, [ME, wallet]);
  }
  const codes = async () => (await closure.blockersFor(pool, ME)).map(b => b.code);

  try {
    /* THE ROUTE ITSELF, not its source.

       Two assertions here used to read the file and check that
       blockersFor was called — which stayed true with the result thrown
       away and with the refusal removed entirely. What matters is whether
       an account with money in it survives a DELETE, so the handler is
       pulled off the router and driven. */
    const router = require(path.join(ROOT, 'server', 'routes', 'privacy.js'));
    const layer = router.stack.find(l => l.route && l.route.path === '/account'
                                      && l.route.methods.delete);
    const handler = layer && layer.route.stack[layer.route.stack.length - 1].handle;

    async function callDelete() {
      const out = { status: 200, body: null };
      const res = {
        status(c) { out.status = c; return res; },
        json(b) { out.body = b; return res; },
      };
      await handler({ user: { investorId: ME, email: 'cl@example.test' },
                      body: { confirm: 'DELETE MY ACCOUNT' }, ip: '1.1.1.1' }, res);
      return out;
    }

    console.log('\nthe route refuses an account with money in it');
    await fixture({ wallet: 900 });
    ok('the handler is reachable', typeof handler === 'function');
    let r1 = await callDelete();
    ok('it refuses', r1.status === 409, `${r1.status} ${JSON.stringify(r1.body)}`);
    ok('and says what is in the way rather than just no',
       !!(r1.body && r1.body.blockers && r1.body.blockers.length),
       JSON.stringify(r1.body) + ' — "you cannot close this" with no reason '
       + 'is a support ticket');
    ok('and the account is NOT half closed',
       (await pool.query(`SELECT first_name FROM investors WHERE id=$1`, [ME]))
         .rows[0].first_name === 'Thandi',
       'anonymising and then refusing is the worst of both');

    console.log('\nand closes a clean one');
    await fixture();
    let r2 = await callDelete();
    ok('it goes through', r2.status === 200 && r2.body && r2.body.success === true,
       `${r2.status} ${JSON.stringify(r2.body)}`);
    ok('and the name really is gone',
       (await pool.query(`SELECT first_name FROM investors WHERE id=$1`, [ME]))
         .rows[0].first_name === 'Deleted');

    console.log('\nand a clean account closes');
    await fixture();
    ok('nothing is in the way', (await codes()).length === 0, JSON.stringify(await codes()));

    console.log('\nand money left behind is in the way');
    await fixture({ wallet: 1250.5 });
    let b = await closure.blockersFor(pool, ME);
    ok('a wallet with money in it stops the closure',
       b.some(x => x.code === 'wallet_balance'), JSON.stringify(await codes()));
    ok('and it says how much, in the person’s own words',
       /R1 ?250,50|R1,250\.50|R1 250,50/.test(b.find(x => x.code === 'wallet_balance').title),
       b.find(x => x.code === 'wallet_balance').title);
    ok('with something they can actually do',
       !!b.find(x => x.code === 'wallet_balance').action);

    console.log('\nand so is an investment still running');
    await fixture();
    await pool.query(
      `INSERT INTO investments (id, investor_id, amount, status, product_type)
       VALUES ('INVST-CL',$1, 5000, 'active', 'cattle')`, [ME]);
    ok('an active investment stops it',
       (await codes()).includes('active_investments'), JSON.stringify(await codes()));
    await pool.query(`UPDATE investments SET status='matured' WHERE id='INVST-CL'`);
    ok('but a matured one does not', !(await codes()).includes('active_investments'));

    console.log('\nand a withdrawal still being paid out');
    await fixture();
    await pool.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, reference,
                                 actor_kind, actor_role)
       VALUES ('TX-CL','${ME}','withdrawal',100,'pending','W-CL','client','investor')`);
    ok('a pending withdrawal stops it',
       (await codes()).includes('pending_withdrawals'), JSON.stringify(await codes()));

    console.log('\nand a stokvel that still owes them their share');
    await fixture();
    await pool.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, name, account_type, status, wallet_balance)
       VALUES ('SA-CL1','INV-CL2','Ubuntu Club','stokvel','active',5000)`);
    await pool.query(
      `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, status)
       VALUES ('SM-CL','SA-CL1',$1,'member','active')`, [ME]);
    let bm = (await closure.blockersFor(pool, ME)).find(x => x.code === 'stokvel_member');
    ok('being a member stops it', !!bm, JSON.stringify(await codes()));
    ok('and the group is named so they know which one',
       /Ubuntu Club/.test(bm.title), bm.title);
    ok('and they are told to leave it properly, not just abandon it',
       /signatories approve|paid out/.test(bm.detail), bm.detail);

    await pool.query(`UPDATE stokvel_members SET status='exited' WHERE id='SM-CL'`);
    ok('a member who has already left is not blocked',
       !(await codes()).includes('stokvel_member'));

    console.log('\nand a stokvel held in their own name');
    await fixture();
    await pool.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, name, account_type, status, wallet_balance)
       VALUES ('SA-CL2',$1,'Masibambane','stokvel','active',9000)`, [ME]);
    let bo = (await closure.blockersFor(pool, ME)).find(x => x.code === 'stokvel_owner');
    ok('being the chairperson stops it', !!bo, JSON.stringify(await codes()));
    ok('and it says the group would be left under nobody',
       /nobody behind it/.test(bo.detail), bo.detail);
    ok('and tells them to hand it over first',
       /chairperson/.test(bo.detail) && /Masibambane/.test(bo.action), JSON.stringify(bo));

    console.log('\nand a dispute still being decided');
    await fixture();
    await pool.query(
      `INSERT INTO payment_reversals (id, gateway_id, kind, reference, investor_id, amount, status)
       VALUES ('PR-CL','GW-CL','dispute','R-CL',$1, 500, 'open')`, [ME]);
    ok('an open dispute stops it',
       (await codes()).includes('open_dispute'), JSON.stringify(await codes()));
    await pool.query(`UPDATE payment_reversals SET status='recovered' WHERE id='PR-CL'`);
    ok('a resolved one does not', !(await codes()).includes('open_dispute'));

    console.log('\nand closing stands everything down');
    await fixture();
    await pool.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, name, account_type, status, wallet_balance)
       VALUES ('SA-CL3','INV-CL2','Ubuntu Club','stokvel','active',0)`);
    await pool.query(
      `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, status, autopay_enabled)
       VALUES ('SM-CL3','SA-CL3',$1,'member','active',true)`, [ME]);
    await pool.query(
      `INSERT INTO paystack_authorizations (investor_id, authorization_code, email)
       VALUES ($1,'AUTH_cl','cl@example.test')`, [ME]);
    await pool.query(`UPDATE investors SET auto_topup_enabled = true WHERE id = $1`, [ME]);

    await closure.standDown(pool, ME);
    ok('the stored card is gone',
       (await pool.query(`SELECT 1 FROM paystack_authorizations WHERE investor_id=$1`, [ME])).rowCount === 0,
       'keeping a chargeable authorisation against somebody who asked to be '
       + 'forgotten is the opposite of what they asked for');
    ok('stokvel autopay is off',
       (await pool.query(`SELECT autopay_enabled FROM stokvel_members WHERE id='SM-CL3'`))
         .rows[0].autopay_enabled === false);
    ok('and so is auto top-up',
       (await pool.query(`SELECT auto_topup_enabled FROM investors WHERE id=$1`, [ME]))
         .rows[0].auto_topup_enabled === false);
  } catch (e) {
    fail++;
    console.log(`  ✗ the blocker half threw\n      ${e.stack || e.message}`);
  } finally {
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
