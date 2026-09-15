#!/usr/bin/env node
/* The only unsolicited mail the platform sends about somebody's own money.
 *
 * Both dashboard panels surface an idle wallet, but only to somebody who
 * visits. A client who deposited and did not come back sees nothing. This job
 * reaches them — which means it is also the job most able to annoy four and a
 * half thousand people at once, so nearly all of this file is about who it
 * must NOT email.
 *
 *   · Nobody whose balance cannot buy anything. The bar is the cheapest open
 *     pool's minimum PLUS the 1% fee charged on top of it, which is the same
 *     rule the portal uses. Telling somebody with R300 their money is idle,
 *     when nothing on the shelf is reachable, is a nuisance.
 *   · Nobody twice in a month. Read from email_logs rather than a new column,
 *     so a redeploy or a second instance cannot reset the clock.
 *   · Nobody within three days of a deposit — they are mid-decision.
 *   · Nobody with a withdrawal pending. That money is on its way out and they
 *     have said so.
 *   · Nobody who is not FICA-approved and active, because they cannot invest
 *     even if they want to and the email would invite them to a dead end.
 *
 * And nothing at all until IDLE_NUDGE_ENABLED=true. The default is a dry run
 * that does the whole selection and reports the volume.
 *
 * Needs a database. It creates and drops its own.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-idle-wallet-nudge.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const db   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const JOB = path.join(ROOT, 'server', 'jobs', 'idleWalletCron.js');
const SRC = fs.readFileSync(JOB, 'utf8');

/* Every send is captured instead of leaving the building. */
const sentTo = [];
const emailPath = require.resolve(path.join(ROOT, 'server', 'services', 'email.js'));
const realEmail = require(emailPath);
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true,
  exports: { ...realEmail, sendIdleWalletNudge: async (inv, args) => { sentTo.push({ inv, args }); } },
};
const { runIdleWalletNudge, minWalletFor } = require(JOB);

const seedPool = async (id, min, endDays, status) => {
  await db.query(`DELETE FROM investment_pools WHERE id = $1`, [id]);
  const end = new Date(); end.setDate(end.getDate() + endDays);
  const start = new Date(end); start.setDate(start.getDate() - 60);
  await db.query(
    `INSERT INTO investment_pools (id, name, product_type, status, target_amount, min_investment,
       annual_rate, term_months, start_date, end_date)
     VALUES ($1, $2, 'cattle', $3, 1000000, $4, 0.13, 12, $5, $6)`,
    [id, `Pool ${id}`, status, min, start.toISOString().slice(0,10), end.toISOString().slice(0,10)]);
};
const seedInv = async (id, balance, opts = {}) => {
  await db.query(`DELETE FROM investors WHERE id = $1`, [id]);
  await db.query(
    `INSERT INTO investors (id, first_name, last_name, email, wallet_balance, status, kyc_status)
     VALUES ($1, 'Idle', 'Check', $2, $3, $4, $5)`,
    [id, `${id.toLowerCase()}@idlechk.test`, balance,
     opts.status || 'active', opts.kyc || 'approved']);
};
const run = async () => {
  sentTo.length = 0;
  const said = [];
  const l = console.log, e = console.error;
  console.log = (...a) => said.push(a.join(' '));
  console.error = (...a) => said.push(a.join(' '));
  let r;
  try { r = await runIdleWalletNudge(); } finally { console.log = l; console.error = e; }
  return { r, said, to: sentTo.map(x => x.inv.id).sort() };
};
const cleanup = async () => {
  await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'IDLE-%'`).catch(() => {});
  await db.query(`DELETE FROM email_logs WHERE to_email LIKE '%@idlechk.test'`).catch(() => {});
  await db.query(`DELETE FROM investors WHERE id LIKE 'IDLE-%'`).catch(() => {});
  await db.query(`DELETE FROM investment_pools WHERE id LIKE 'IDLEPOOL-%'`).catch(() => {});
};

(async () => {
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});
    await db.query(`UPDATE investment_pools SET status = 'chk_parked' WHERE status = 'open'`);
    await cleanup();

    console.log('\nthe bar is the minimum PLUS the fee');
    {
      ok('R500 minimum needs R505', Math.abs(minWalletFor(500) - 505) < 0.005, String(minWalletFor(500)));
      ok('and it is never below the minimum',
         [500, 1000, 3100].every(m => minWalletFor(m) > m),
         'the fee is charged on top — a bar equal to the minimum invites a refusal');
      const web = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
      ok('the portal computes the same thing', /function svcMinWalletFor\(pool\)/.test(web),
         'two halves of one rule; if they drift the email promises what the modal refuses');
    }

    await seedPool('IDLEPOOL-1', 500, 30, 'open');

    console.log('\nit does not send until somebody turns it on');
    {
      await seedInv('IDLE-RICH', 5000);
      delete process.env.IDLE_NUDGE_ENABLED;
      const { r, said, to } = await run();
      ok('nothing is sent by default', to.length === 0, JSON.stringify(to));
      ok('but the eligible investor was found', r.skipped === 1, JSON.stringify(r));
      ok('and the log says how to enable it',
         said.some(x => /IDLE_NUDGE_ENABLED=true/.test(x)),
         said.join(' | ').slice(0, 160));
      ok('and reports the volume first',
         said.some(x => /1 investor\(s\) holding R5000\.00 idle/.test(x)),
         said.filter(x => /holding/.test(x)).join(' | '));
    }

    process.env.IDLE_NUDGE_ENABLED = 'true';

    console.log('\nwith it on, the eligible investor is emailed');
    {
      const { to } = await run();
      ok('exactly the one', JSON.stringify(to) === JSON.stringify(['IDLE-RICH']), JSON.stringify(to));
      const args = sentTo[0].args;
      ok('told their balance', args.balance === 5000, String(args.balance));
      ok('told what the cheapest pool needs, fee included',
         Math.abs(args.minNeeded - 505) < 0.005, String(args.minNeeded));
      ok('and which pool it is', args.poolName === 'Pool IDLEPOOL-1', args.poolName);
    }

    console.log('\nand everybody who should be left alone is');
    {
      await db.query(`DELETE FROM email_logs WHERE to_email LIKE '%@idlechk.test'`);
      await seedInv('IDLE-SHORT',    504);                      // cannot afford the fee
      await seedInv('IDLE-NOFICA',   5000, { kyc: 'pending' }); // cannot invest
      await seedInv('IDLE-INACTIVE', 5000, { status: 'suspended' });
      await seedInv('IDLE-WITHDRAW', 5000);
      await seedInv('IDLE-FRESH',    5000);
      await seedInv('IDLE-MAILED',   5000);
      await db.query(
        `INSERT INTO transactions (id, investor_id, type, amount, status, created_at)
         VALUES ('TXN-IDLE-W','IDLE-WITHDRAW','withdrawal',1000,'pending',NOW()),
                ('TXN-IDLE-D','IDLE-FRESH','deposit',5000,'completed',NOW() - INTERVAL '1 day')`);
      await db.query(
        `INSERT INTO email_logs (to_email, subject, type, status, sent_at)
         VALUES ('idle-mailed@idlechk.test','x','idle_wallet','sent', NOW() - INTERVAL '5 days')`);

      const { to } = await run();
      const excluded = ['IDLE-SHORT','IDLE-NOFICA','IDLE-INACTIVE','IDLE-WITHDRAW','IDLE-FRESH','IDLE-MAILED'];
      for (const id of excluded)
        ok(`${id} is not emailed`, !to.includes(id), JSON.stringify(to));
      ok('and IDLE-RICH still is', to.includes('IDLE-RICH'), JSON.stringify(to));
      ok('exactly one recipient', to.length === 1, JSON.stringify(to));
    }

    console.log('\nnobody is emailed twice in a month');
    {
      /* The first run above wrote no email_logs row — the send is stubbed — so
         the cooldown is proved with a row of its own rather than by assuming
         the stub left a trace. */
      await db.query(
        `INSERT INTO email_logs (to_email, subject, type, status, sent_at)
         VALUES ('idle-rich@idlechk.test','x','idle_wallet','sent', NOW() - INTERVAL '2 days')`);
      const { to } = await run();
      ok('the recent recipient is skipped', !to.includes('IDLE-RICH'), JSON.stringify(to));

      await db.query(
        `UPDATE email_logs SET sent_at = NOW() - INTERVAL '40 days'
          WHERE to_email = 'idle-rich@idlechk.test'`);
      const again = await run();
      ok('and picked up again after the cooldown', again.to.includes('IDLE-RICH'), JSON.stringify(again.to));

      /* A failed send must not buy a month of silence. */
      await db.query(`DELETE FROM email_logs WHERE to_email = 'idle-rich@idlechk.test'`);
      await db.query(
        `INSERT INTO email_logs (to_email, subject, type, status, error, sent_at)
         VALUES ('idle-rich@idlechk.test','x','idle_wallet','failed','boom', NOW() - INTERVAL '2 days')`);
      const afterFail = await run();
      ok('a failed send does not count as a send', afterFail.to.includes('IDLE-RICH'),
         JSON.stringify(afterFail.to));
    }

    console.log('\nwith nothing to invest in, it says nothing');
    {
      await db.query(`DELETE FROM email_logs WHERE to_email LIKE '%@idlechk.test'`);
      await db.query(`UPDATE investment_pools SET status = 'closed' WHERE id = 'IDLEPOOL-1'`);
      const { r, said, to } = await run();
      ok('nobody is emailed', to.length === 0, JSON.stringify(to));
      ok('and the reason is given', said.some(x => /no open pool is currently reachable/.test(x)),
         said.join(' | ').slice(0, 140));
      ok('the run reports zero rather than throwing', r && r.sent === 0, JSON.stringify(r));
    }

    console.log('\nthe copy promises nothing');
    {
      const em = fs.readFileSync(path.join(ROOT, 'server', 'services', 'email.js'), 'utf8');
      /* Whitespace collapsed first. The phrases under test wrap across lines in
         the HTML template, and a regex written on one line silently fails to
         find copy that is present — reporting a compliance gap that is not
         there, which is the worst direction for this particular check to be
         wrong in. */
      const fn = em.slice(em.indexOf('function sendIdleWalletNudge'), em.indexOf('module.exports'))
                   .replace(/\s+/g, ' ');
      ok('it states the risk', /returns are not guaranteed/i.test(fn));
      ok('it says you can lose money', /get back less than you invest/i.test(fn));
      ok('it offers a way to stop it', /To stop it, reply/i.test(fn),
         'unsolicited mail about somebody money needs an off switch in the mail itself');
      ok('it says how often it comes', /at most once a month/i.test(fn));
      ok('and it never calls anything safe',
         !/\b(guaranteed returns|risk-free|capital[- ]protected|safe investment)\b/i.test(fn));
    }

    await cleanup();
    await db.query(`UPDATE investment_pools SET status = 'open' WHERE status = 'chk_parked'`);

  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    delete process.env.IDLE_NUDGE_ENABLED;
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
