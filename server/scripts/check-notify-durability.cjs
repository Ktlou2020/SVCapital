#!/usr/bin/env node
/* A notice that holds up a group's money must not be the one that vanishes.
 *
 * THE ASYMMETRY THIS CLOSES. email_queue has existed all along: three
 * attempts, backoff, a 'dead' state, drained by cron every two minutes.
 * Exactly one caller used it — the monthly statement. The group notices
 * called the email service directly and caught the failure into a console
 * line. So a statement that failed got three attempts and a row somebody
 * could find, and "your signature is needed to release R20 000" got one
 * attempt and silence. The one that matters had the weaker delivery.
 *
 * AND THE CALLER IS A FLOATING PROMISE. Routes fire n.paidOut(…).catch(…)
 * without awaiting, so whatever the fan-out has not sent when the process
 * goes is lost — and this platform redeploys several times a day. The
 * outbox row is written BEFORE the send is attempted, so the message
 * survives both a failed send and a process that dies between the two.
 *
 * NEITHER HALF MAY THROW. A notification that rejects into a floating
 * promise is the original problem with more steps.
 *
 * Run: DATABASE_URL=… node server/scripts/check-notify-durability.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

/* The email service, stubbed, so a send can be made to fail on demand. */
const sends = [];
let failNext = null;
const emailPath = path.join(ROOT, 'server', 'services', 'email.js');
require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true,
  children: [], paths: [], exports: {
    sendStokvelMandate: async (person, mail) => {
      sends.push({ to: person && person.email, subject: mail && mail.subject });
      if (failNext) { const e = failNext; failNext = null; throw new Error(e); }
      return { ok: true };
    },
  } };
/* Push, stubbed, so nothing reaches a real endpoint. */
const pushes = [];
const pushPath = path.join(ROOT, 'server', 'services', 'pushService.js');
require.cache[pushPath] = { id: pushPath, filename: pushPath, loaded: true,
  children: [], paths: [], exports: {
    sendPushToInvestor: async (id, msg) => { pushes.push({ id, title: msg && msg.title }); return { ok: true }; },
  } };

(async () => {
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.email_queue') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no email_queue here'); return; }

    const outbox = require(path.join(ROOT, 'server', 'services', 'emailQueue.js'));
    const notify = require(path.join(ROOT, 'server', 'services', 'stokvelNotify.js'));

    const clean = () => db.query(`DELETE FROM email_queue WHERE to_email LIKE '%@durability.test'`);
    const rowsFor = async to => (await db.query(
      `SELECT status, attempts, template, last_error, payload FROM email_queue
        WHERE to_email = $1 ORDER BY created_at`, [to])).rows;
    await clean();

    /* ══ 1. The happy path leaves a record that it was sent ═════════ */
    console.log('\na message that sends is still written down');
    {
      const to = 'ok@durability.test';
      const out = await outbox.enqueueAndSend(to, 'sendStokvelMandate',
        [{ email: to, first_name: 'A' }, { subject: 'Approve this' }]);
      ok('it reports that it went', out.ok === true, JSON.stringify(out));
      ok('and it really went', sends.some(s => s.to === to), JSON.stringify(sends));
      const rows = await rowsFor(to);
      ok('AND THERE IS A ROW SAYING SO',
         rows.length === 1 && rows[0].status === 'sent',
         'a send with no record cannot be audited afterwards: ' + JSON.stringify(rows));
      ok('and it is not left for the cron to send again',
         rows[0].attempts === 1, String(rows[0].attempts));
    }

    /* ══ 2. A failed send survives as work to retry ═════════════════ */
    console.log('\nand a message that fails is kept, not logged and lost');
    {
      const to = 'fails@durability.test';
      failNext = 'the mail provider said no';
      const out = await outbox.enqueueAndSend(to, 'sendStokvelMandate',
        [{ email: to, first_name: 'B' }, { subject: 'Approve this' }]);
      ok('IT DOES NOT THROW AT THE CALLER',
         out && out.ok === false,
         'a notification that rejects into a floating promise is the '
         + 'original problem with more steps');
      const rows = await rowsFor(to);
      ok('THE MESSAGE IS STILL THERE',
         rows.length === 1 && rows[0].status === 'failed',
         'this is the whole point: a request for a signature used to get '
         + 'one attempt and a console line: ' + JSON.stringify(rows));
      ok('with the reason on it',
         /mail provider said no/.test(rows[0].last_error || ''), rows[0].last_error);
      ok('and the arguments needed to send it again',
         !!(rows[0].payload && rows[0].payload.args && rows[0].payload.args.length === 2),
         JSON.stringify(rows[0].payload));
      ok('AND THE COUNT STARTS AT ONE, not again from zero',
         rows[0].attempts === 1,
         'the first attempt already happened; restarting the count would '
         + 'give it four: ' + rows[0].attempts);
    }

    /* ══ 3. And the cron carries it from there ══════════════════════ */
    console.log('\nand the cron finishes what the first attempt started');
    {
      const to = 'fails@durability.test';
      await db.query(`UPDATE email_queue SET scheduled_at = NOW() - INTERVAL '1 minute'
                       WHERE to_email = $1`, [to]);
      const before = sends.length;
      await outbox.processQueue();
      ok('IT PICKS UP WHAT THE SEND LEFT BEHIND',
         sends.length > before, 'the retry never happened: ' + (sends.length - before));
      const rows = await rowsFor(to);
      ok('and marks it sent once it goes', rows[0].status === 'sent', JSON.stringify(rows));
    }

    /* ══ 4. The cases that must not make a mess ═════════════════════ */
    console.log('\nand the awkward cases do not make a mess');
    {
      const none = await outbox.enqueueAndSend('', 'sendStokvelMandate', [{}, {}]);
      ok('no address, no row and no throw', none.ok === false && !none.queued,
         JSON.stringify(none));

      const to = 'unknown@durability.test';
      const bad = await outbox.enqueueAndSend(to, 'noSuchTemplate', [{ email: to }, {}]);
      ok('AN UNKNOWN TEMPLATE FAILS LOUDLY IN THE QUEUE, NOT AT THE CALLER',
         bad.ok === false && bad.queued === true, JSON.stringify(bad));
      const rows = await rowsFor(to);
      ok('and leaves a row somebody can find',
         rows.length === 1 && rows[0].status === 'failed'
         && /Unknown email template/.test(rows[0].last_error || ''),
         JSON.stringify(rows));
    }

    /* ══ 5. The group notices actually use it ═══════════════════════ */
    console.log('\nand a group notice goes through the outbox, not round it');
    {
      await clean();
      sends.length = 0; pushes.length = 0;

      /* A real group, so the notice has something to describe. */
      for (const t of ['stokvel_members', 'stokvel_withdrawal_requests'])
        await db.query(`DELETE FROM ${t} WHERE sub_account_id LIKE 'SA-ND-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-ND-%'`);
      await db.query(`DELETE FROM investors WHERE id LIKE 'INV-ND-%'`);
      for (const [id, nm] of [['INV-ND-A', 'Ayanda'], ['INV-ND-B', 'Bongi']])
        await db.query(
          `INSERT INTO investors (id, first_name, last_name, email, phone, status, wallet_balance)
           VALUES ($1,$2,'M',$3,'0790000000','active',0)`,
          [id, nm, id.toLowerCase() + '@durability.test']);
      await db.query(
        `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, wallet_balance,
                                   kyc_status, status, stokvel_quorum, share_basis)
         VALUES ('SA-ND-1','INV-ND-A','stokvel','Durability Club',5000,'approved','active',2,'contribution')`);
      for (const [i, id] of ['INV-ND-A', 'INV-ND-B'].entries())
        await db.query(
          `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
           VALUES ($1,'SA-ND-1',$2,$3,true,'active',NOW())`,
          ['SM-ND-' + i, id, i === 0 ? 'chairperson' : 'member']);
      await db.query(
        `INSERT INTO stokvel_withdrawal_requests
           (id, sub_account_id, requested_by, kind, amount, status, quorum_required, expires_at,
            bank_name, bank_account_number)
         VALUES ('SWR-ND-1','SA-ND-1','INV-ND-A','withdrawal',2000,'pending',2,
                 NOW() + INTERVAL '14 days','FNB','123')`);

      const out = await notify.approvalNeeded({ groupId: 'SA-ND-1', authorityId: 'SWR-ND-1', db });
      ok('the signatory is told', (out.notified || []).includes('INV-ND-B'), JSON.stringify(out));
      const rows = await rowsFor('inv-nd-b@durability.test');
      ok('AND THE EMAIL LEFT A ROW IN THE OUTBOX',
         rows.length === 1 && rows[0].template === 'sendStokvelMandate',
         'this is the change: the notice that holds up a group’s money '
         + 'now has the same delivery as a monthly statement: ' + JSON.stringify(rows));
      ok('and it was sent, not merely queued',
         rows[0].status === 'sent', JSON.stringify(rows));
      ok('and the push still went too',
         pushes.some(p => p.id === 'INV-ND-B'),
         'the two channels are not an either/or: ' + JSON.stringify(pushes));

      /* AND IT SURVIVES A SEND THAT FAILS. */
      await db.query(`DELETE FROM stokvel_request_approvals WHERE request_id = 'SWR-ND-1'`).catch(() => {});
      await clean();
      failNext = 'provider down';
      const out2 = await notify.approvalNeeded({ groupId: 'SA-ND-1', authorityId: 'SWR-ND-1', db });
      ok('A FAILED SEND DOES NOT BREAK THE NOTICE',
         (out2.notified || []).includes('INV-ND-B'),
         'the caller is a floating promise; throwing here loses the rest of '
         + 'the roster too: ' + JSON.stringify(out2));
      const kept = await rowsFor('inv-nd-b@durability.test');
      ok('AND THE MESSAGE IS STILL WAITING TO BE RETRIED',
         kept.length === 1 && kept[0].status === 'failed',
         'before this it was a console line: ' + JSON.stringify(kept));

      for (const t of ['stokvel_members', 'stokvel_withdrawal_requests'])
        await db.query(`DELETE FROM ${t} WHERE sub_account_id LIKE 'SA-ND-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-ND-%'`);
      await db.query(`DELETE FROM investors WHERE id LIKE 'INV-ND-%'`);
    }

    /* ══ 6. The roster fan-out is not one at a time ═════════════════ */
    console.log('\nand a whole roster is not told one at a time');
    {
      const SRC = read('server/services/stokvelNotify.js');
      ok('there is one helper for telling several people',
         /async function _tellAll\(people, message\)/.test(SRC));
      /* BOTH ENDS OF IT. `/const LANES = \d+/` matches 1, which is the
         serial loop this replaced — the assertion has to say more than
         one, and still bounded. */
      const lanes = Number((SRC.match(/const LANES = (\d+);/) || [])[1]);
      ok('MORE THAN ONE AT A TIME',
         lanes > 1,
         'LANES = 1 is the serial loop this exists to replace, and a digit '
         + 'is a digit: ' + lanes);
      ok('AND STILL BOUNDED',
         lanes <= 10 && /slice\(i, i \+ LANES\)/.test(SRC),
         'unbounded would open one connection per member to the mail '
         + 'provider and be rate limited into the retries this exists to '
         + 'avoid: ' + lanes);
      ok('the payout uses it', /const told = await _tellAll\(lines\.map/.test(SRC),
         'the biggest fan-out a group has');
      ok('and so does a changed contribution',
         /const told = await _tellAll\(members/.test(SRC));
    }

    await clean();
  } catch (err) {
    fail += 1;
    console.log('  ✗ the check itself fell over\n      ' + (err && err.stack || err));
  } finally {
    await db.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
