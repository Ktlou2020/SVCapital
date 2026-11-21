#!/usr/bin/env node
/* Winding a group up, and who may carry its decisions out.
 *
 * TWO GAPS FOUND IN A LAUNCH REVIEW.
 *
 * NOTHING ENDED A GROUP. Members could leave one at a time and the pot
 * could be paid out, but a stokvel that had finished its life stayed open
 * for ever — collecting nothing, owed to nobody, and removable only by
 * asking us. The sub-account close built for minors deliberately refuses a
 * stokvel, and rightly: a group's money is not the chairperson's to sweep.
 * So closing a group needed its own path, through the signatories.
 *
 * AND ONLY THE CHAIRPERSON COULD CARRY OUT A GROUP INVESTMENT. The
 * ownership predicate was parent_investor_id, which for a stokvel is the
 * chairperson — so signatories could approve an investment and nobody but
 * that one person could place it. A group whose chairperson was away held
 * an approved authority it could not use, which is the opposite of what a
 * mandate is for.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-stokvel-dissolve.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

console.log('\nclosing a group is a decision the signatories take');
{
  const MAN = strip(read('server/services/stokvelMandate.js'));
  ok('dissolve is an authority kind', /dissolve/.test(MAN), 'server/services/stokvelMandate.js');
  ok('AND IT CANNOT BE DONE WITHOUT ONE',
     /want\.kind === 'dissolve'[\s\S]{0,260}?needs an approved authority/.test(MAN),
     'this is the decision a chairperson acting alone must least be able to take');
  ok('an authority for something else does not release it',
     /dissolve: 'closing the group'/.test(MAN),
     'a payout authority must not close the group');
  ok('and it carries no amount, like a mandate change',
     /want\.kind !== 'dissolve' &&/.test(MAN),
     'a group is not closed FOR a sum');

  const SETUP = read('server/db/setup.js');
  ok('the database allows the kind',
     /kind IN \('withdrawal','investment','exit','payout','mandate',\s*'notice_deposit','dissolve'\)/.test(SETUP),
     'server/db/setup.js');
  ok('and allows it to have no amount',
     /amount > 0 OR kind IN \('mandate','dissolve'\)/.test(SETUP), 'server/db/setup.js');
  /* A constraint that already exists under the same name keeps its OLD
     definition, so guarding the ADD with duplicate_object would leave the
     new kind rejected by a rule nobody can see. */
  ok('and both constraints are replaced, not re-added behind a guard',
     /DROP CONSTRAINT IF EXISTS swr_kind_chk;\s*ALTER TABLE stokvel_withdrawal_requests ADD CONSTRAINT swr_kind_chk/.test(SETUP),
     'server/db/setup.js');
}

console.log('\nand a member may carry out what the signatories approved');
{
  const T = strip(read('server/routes/tables.js'));
  ok('an active member of the stokvel may place it',
     /account_type = 'stokvel'[\s\S]{0,240}?stokvel_members[\s\S]{0,320}?status = 'active'/.test(T),
     'it was parent_investor_id alone, which for a stokvel is the chairperson');
  ok('AND THE OWNER PREDICATE STILL HOLDS FOR EVERY OTHER KIND',
     /s\.parent_investor_id = \$2/.test(T),
     'a minor, a trust and a business are owned by one person and that must '
     + 'not have been loosened with them');
  ok('and the mandate still pins what is placed',
     /kind: 'investment', amount: poolAmount, poolId: body\.pool_id/.test(T),
     'the carrier chooses nothing — widening who may carry out is only safe '
     + 'because WHAT is carried out is fixed by the authority');
}

console.log('\nand the portal can ask for it and carry it out');
{
  const CORE = strip(read('js/portal-core.js'));
  ok('there is a way to ask', /function raiseStokvelDissolve/.test(CORE), 'js/portal-core.js');
  ok('and it is offered to the committee only',
     /c\.canPropose && g\.stokvel_quorum \? `<button[\s\S]{0,180}?raiseStokvelDissolve/.test(CORE),
     'asking grants nothing, but it should not be something any member can '
     + 'put in front of the whole group on a whim');
  ok('an approved one offers the close',
     /function _svDissolveReady/.test(CORE) && /dissolveStokvel\(/.test(CORE), 'js/portal-core.js');
  ok('AND IT IS NOT OFFERED WHILE THERE IS MONEY LEFT',
     /left > 0 \? '' : `<button/.test(CORE),
     'the button is hidden rather than shown and refused, because the right '
     + 'next step is a payout and the panel says so');
  ok('and it says to pay the members out first',
     /splits it by each member/.test(CORE), 'js/portal-core.js');
  ok('and it does not re-render a workspace that is no longer theirs',
     /loadStokvels === 'function'/.test(CORE),
     'their membership ended with the group');
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});
const mandate = require(path.join(ROOT, 'server', 'services', 'stokvelMandate.js'));

(async () => {
  try {
    const { rows: [r] } = await db.query(
      `SELECT to_regclass('public.stokvel_withdrawal_requests') IS NOT NULL AS ready`);
    if (!r.ready) { console.log('\n  SKIP  no stokvel tables in this database'); return; }

    const clean = async () => {
      await db.query(`DELETE FROM stokvel_withdrawal_requests WHERE sub_account_id LIKE 'SA-DS-%'`);
      await db.query(`DELETE FROM stokvel_members WHERE sub_account_id LIKE 'SA-DS-%'`);
      await db.query(`DELETE FROM investments WHERE sub_account_id LIKE 'SA-DS-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-DS-%'`);
      await db.query(`DELETE FROM investors WHERE id LIKE 'INV-DS-%'`);
    };
    await clean();

    for (const n of ['A', 'B']) {
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
         VALUES ($1, $2, 'Member', $3, 'active', 0)`,
        [`INV-DS-${n}`, n, `ds-${n.toLowerCase()}@example.test`]);
    }
    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, wallet_balance,
                                 kyc_status, status, stokvel_quorum)
       VALUES ('SA-DS-1','INV-DS-A','stokvel','Dissolve Test',0,'approved','active',2)`);
    for (const n of ['A', 'B']) {
      await db.query(
        `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status)
         VALUES ($1,'SA-DS-1',$2,$3,true,'active')`,
        [`SM-DS-${n}`, `INV-DS-${n}`, n === 'A' ? 'chairperson' : 'member']);
    }

    const raise = async (kind, extra = {}) => {
      const id = `SWR-DS-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      await db.query(
        `INSERT INTO stokvel_withdrawal_requests
           (id, sub_account_id, requested_by, amount, kind, quorum_required, status, expires_at)
         VALUES ($1,'SA-DS-1','INV-DS-A',$2,$3,2,$4, NOW() + INTERVAL '7 days')`,
        [id, extra.amount || 0, kind, extra.status || 'approved']);
      return id;
    };

    console.log('\nthe database really accepts a dissolve with no amount');
    {
      let threw = null;
      let id = null;
      try { id = await raise('dissolve'); } catch (e) { threw = e.message; }
      ok('a dissolve request can be stored', !threw && !!id,
         threw + ' — the amount and kind constraints both had to be replaced');
    }

    console.log('\nand the authority is the only way to close a group');
    {
      const none = await mandate.authorityFor(db, { id: 'SA-DS-1', stokvel_quorum: 2 },
                                              null, { kind: 'dissolve' });
      ok('WITHOUT ONE IT IS REFUSED', !!none.error, JSON.stringify(none));
      ok('and says to ask the signatories',
         /signatories/.test(none.error || ''), none.error);

      /* An authority approved for something else must not close the group. */
      const payout = await raise('payout', { amount: 500 });
      const wrong = await mandate.authorityFor(db, { id: 'SA-DS-1', stokvel_quorum: 2 },
                                               payout, { kind: 'dissolve' });
      ok('A PAYOUT AUTHORITY DOES NOT CLOSE THE GROUP', !!wrong.error, JSON.stringify(wrong));
      ok('and names what it was actually for',
         /approved for a payout/.test(wrong.error || ''), wrong.error);
    }

    console.log('\nand a dissolve authority is accepted on its own terms');
    {
      const id = await raise('dissolve');
      /* evaluate() needs the votes; approve it the way the vote route does. */
      await db.query(
        `INSERT INTO stokvel_request_approvals (id, request_id, investor_id, decision)
         VALUES ($1,$2,'INV-DS-A','approve'), ($3,$2,'INV-DS-B','approve')`,
        [`SRA-DS-1-${id}`, id, `SRA-DS-2-${id}`]);
      const got = await mandate.authorityFor(db, { id: 'SA-DS-1', stokvel_quorum: 2 },
                                             id, { kind: 'dissolve' });
      ok('IT IS RELEASED WITH NO AMOUNT TO MATCH', !got.error && !!got.authority,
         JSON.stringify(got.error || 'ok')
         + ' — a group is not closed FOR a sum, so nothing is matched against one');
    }

    await clean();
  } finally {
    await db.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
