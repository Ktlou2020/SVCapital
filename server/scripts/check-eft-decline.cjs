#!/usr/bin/env node
/* Declining an EFT proof must close the deposit, not just the ticket.
 *
 * The portal pre-creates a PENDING deposit row when an investor submits proof
 * of payment. The console's decline updated the TICKET and nothing else, so
 * that row stayed 'pending' forever: the client was told their proof had been
 * rejected and then went on seeing the deposit as Pending in their
 * transactions, indistinguishable from one still being checked. Nothing in the
 * client's view ever said the money was not coming.
 *
 * Approval was rewritten into a single server call for exactly this reason —
 * a ticket update plus a transaction PATCH from the browser could half-apply.
 * Decline now goes the same way, so both writes commit together or neither
 * does.
 *
 * The cases that matter beyond the happy path are the ones where declining
 * must NOT rewrite history: a deposit already approved and credited, and a
 * second decline of the same ticket.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-eft-decline.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const express = require('express');
const pool    = require(path.join(__dirname, '..', 'db', 'pool'));

const ROOT  = path.join(__dirname, '..', '..');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const USER = { role: 'admin', id: 'u-dec', email: 'admin@chk-dec.test', firstName: 'A', lastName: 'D' };
const authMod = require.resolve(path.join(__dirname, '..', 'middleware', 'auth'));
require.cache[authMod] = { id: authMod, filename: authMod, loaded: true, exports: {
  requireAuth: (req, _r, next) => { req.user = USER; next(); },
  requireRole: () => (_q, _r, next) => next(),
} };
const app = express();
app.use(express.json());
app.use('/api/admin', require(path.join(__dirname, '..', 'routes', 'manualCredit')));

let server;
const post = (p, body) => new Promise(res => {
  const d = JSON.stringify(body);
  const r = http.request({ port: server.address().port, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, x => {
    let s = ''; x.on('data', c => s += c);
    x.on('end', () => { let j = {}; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); });
  });
  r.on('error', e => res({ status: 0, body: { error: e.message } }));
  r.end(d);
});

const q = (s, p) => pool.query(s, p);
const REF = 'EFT-CHKDEC1';

async function cleanup() {
  await q(`DELETE FROM support_tickets WHERE id LIKE 'CHK-DEC-%'`).catch(() => {});
  await q(`DELETE FROM transactions    WHERE id LIKE 'CHK-DEC-%'`).catch(() => {});
  await q(`DELETE FROM investors       WHERE id LIKE 'CHK-DEC-%'`).catch(() => {});
}

/* An investor who submitted proof: a payment_proof ticket and the pending
   deposit the portal creates alongside it. */
async function seed({ depositStatus = 'pending', withDeposit = true } = {}) {
  await cleanup();
  await q(`INSERT INTO investors (id, first_name, last_name, email, wallet_balance)
           VALUES ('CHK-DEC-INV','Decline','Probe','dec@chk.test', 1000)`);
  await q(`INSERT INTO support_tickets (id, investor_id, category, subject, message, status)
           VALUES ('CHK-DEC-T1','CHK-DEC-INV','payment_proof',$1,'proof attached','open')`,
          [`EFT proof of payment ${REF}`]);
  if (withDeposit) {
    await q(`INSERT INTO transactions (id, investor_id, type, amount, status, reference, description)
             VALUES ('CHK-DEC-TX1','CHK-DEC-INV','deposit', 2500, $1, $2, 'Awaiting proof review')`,
            [depositStatus, REF]);
  }
}

const deposit = async () => (await q(`SELECT * FROM transactions WHERE id='CHK-DEC-TX1'`)).rows[0];
const ticket  = async () => (await q(`SELECT * FROM support_tickets WHERE id='CHK-DEC-T1'`)).rows[0];
const wallet  = async () => Number((await q(`SELECT wallet_balance FROM investors WHERE id='CHK-DEC-INV'`)).rows[0].wallet_balance);

(async () => {
  try {
    server = await new Promise(r => { const s = app.listen(0, () => r(s)); });

    console.log('\ndeclining closes the deposit as well as the ticket');
    {
      await seed();
      const before = await wallet();
      const r = await post('/api/admin/eft-decline',
        { ticket_id: 'CHK-DEC-T1', response: 'Proof was unreadable.' });

      ok('the call succeeds', r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      ok('and reports that it closed the deposit', r.body.closed === true, JSON.stringify(r.body));

      const d = await deposit();
      ok('the deposit no longer reads pending', d.status !== 'pending', d.status);
      ok('it reads rejected', d.status === 'rejected',
         `${d.status} — "failed" would tell the client their payment broke, which it did not`);
      ok('and says why, without losing what was there', /declined by admin/i.test(d.description) &&
         /Awaiting proof review/.test(d.description), d.description);
      ok('the reviewer\'s words are carried into it', /unreadable/i.test(d.description), d.description);

      const t = await ticket();
      ok('the ticket is resolved', t.status === 'resolved', t.status);
      ok('with the response the reviewer typed', /unreadable/i.test(t.admin_response), t.admin_response);

      ok('no money moved', await wallet() === before, `${before} → ${await wallet()}`);
    }

    console.log('\nit will not rewrite a deposit that was already approved');
    {
      /* The dangerous case. Declining the ticket after the money is credited
         must not flip a completed deposit to rejected and leave the wallet
         holding funds the ledger says were refused. */
      await seed({ depositStatus: 'completed' });
      const r = await post('/api/admin/eft-decline', { ticket_id: 'CHK-DEC-T1' });
      ok('the call still succeeds', r.status === 200, `HTTP ${r.status}`);
      ok('it says the deposit was already completed', r.body.alreadyCompleted === true, JSON.stringify(r.body));
      ok('and did not close anything', r.body.closed === false, JSON.stringify(r.body));
      const d = await deposit();
      ok('the completed deposit is untouched', d.status === 'completed', d.status);
      ok('but the ticket is still resolved', (await ticket()).status === 'resolved');
    }

    console.log('\na second decline changes nothing');
    {
      await seed();
      await post('/api/admin/eft-decline', { ticket_id: 'CHK-DEC-T1' });
      const first = await deposit();
      const r = await post('/api/admin/eft-decline', { ticket_id: 'CHK-DEC-T1' });
      const second = await deposit();
      ok('it succeeds again', r.status === 200, `HTTP ${r.status}`);
      ok('and the deposit is not annotated twice',
         second.description === first.description, `\n      ${first.description}\n      ${second.description}`);
      ok('still rejected', second.status === 'rejected', second.status);
    }

    console.log('\nthe edges are handled rather than crashed on');
    {
      await seed({ withDeposit: false });
      const r = await post('/api/admin/eft-decline', { ticket_id: 'CHK-DEC-T1' });
      ok('a ticket with no deposit row still resolves', r.status === 200 && r.body.closed === false,
         JSON.stringify(r.body));
      ok('and the ticket is closed', (await ticket()).status === 'resolved');

      const missing = await post('/api/admin/eft-decline', { ticket_id: 'NO-SUCH-TICKET' });
      ok('an unknown ticket is a 404', missing.status === 404, `HTTP ${missing.status}`);

      const noId = await post('/api/admin/eft-decline', {});
      ok('a missing ticket_id is refused', noId.status === 400, `HTTP ${noId.status}`);

      await q(`UPDATE support_tickets SET category='general' WHERE id='CHK-DEC-T1'`);
      const wrongKind = await post('/api/admin/eft-decline', { ticket_id: 'CHK-DEC-T1' });
      ok('a ticket that is not a payment proof is refused', wrongKind.status === 400,
         `HTTP ${wrongKind.status} — this route may only close EFT deposits`);
    }

    console.log('\nthe console goes through the endpoint');
    {
      const at = ADMIN.indexOf("if (!approve) {");
      const body = ADMIN.slice(at, at + 2600);
      ok('decline calls the server route', /admin\/eft-decline/.test(body), body.slice(0, 200));
      ok('and no longer only updates the ticket',
         !/await API\.tickets\.update\(id, \{\s*status: 'resolved',\s*admin_response/.test(body),
         'that left the deposit pending forever');
      ok('the ledger is reloaded when it is on screen',
         /if \(STATE\.transactions\.length\) await loadTransactions\(\);/.test(body));
      ok('an already-credited deposit is reported as a warning, not a success',
         /Toast\.warning\('Ticket declined — but this deposit was already approved/.test(body),
         'the reviewer has to know the money is still out');
      ok('the toast type is chosen by function, not by argument',
         !/Toast\.(success|error)\([^)]*,\s*'(warning|success|error|info)'/.test(ADMIN),
         "Toast.success's second argument is a duration; a type name there coerces to 0 and the toast vanishes");
    }

    console.log('\nthe backfill closes the stranded rows, and only the safe ones');
    {
      /* Every ticket declined before the fix left its deposit pending. The
         backfill must close those — and must NOT touch a deposit whose ticket
         says it was APPROVED, because that is an approval that did not finish
         and the money may genuinely have arrived. */
      const { execFileSync } = require('child_process');
      const SCRIPT = path.join(__dirname, 'close-declined-eft-deposits.cjs');
      const run = args => {
        try {
          return execFileSync('node', [SCRIPT, ...args],
            { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
        } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
      };

      await cleanup();
      await q(`INSERT INTO investors (id, first_name, last_name, email)
               VALUES ('CHK-DEC-INV','Decline','Probe','dec@chk.test')`);
      const mk = async (n, resp, ref) => {
        await q(`INSERT INTO support_tickets (id, investor_id, category, subject, message, status, admin_response, responded_at)
                 VALUES ($1,'CHK-DEC-INV','payment_proof',$2,'proof','resolved',$3, NOW())`,
                [`CHK-DEC-T${n}`, `EFT proof of payment ${ref}`, resp]);
        await q(`INSERT INTO transactions (id, investor_id, type, amount, status, reference)
                 VALUES ($1,'CHK-DEC-INV','deposit', 100, 'pending', $2)`, [`CHK-DEC-TX${n}`, ref]);
      };
      await mk(11, 'Your EFT proof of payment was declined. Please resubmit.', 'EFT-CHKD11');
      await mk(12, 'Your EFT deposit of R100.00 has been approved and credited to your wallet.', 'EFT-CHKD12');
      await mk(13, null, 'EFT-CHKD13');

      const report = run([]);
      ok('the report finds all three', /DECLINED: 1/.test(report) && /APPROVED: 1/.test(report) && /UNCLEAR: 1/.test(report),
         report.slice(0, 700));
      ok('and writes nothing without --apply',
         (await q(`SELECT COUNT(*)::int n FROM transactions WHERE id LIKE 'CHK-DEC-TX1%' AND status='pending'`)).rows[0].n === 3,
         'the report must not change anything');
      ok('it says an approval that did not finish is never written',
         /NEVER written/.test(report), report.slice(-900));

      const applied = run(['--apply']);
      ok('--apply closes one deposit', /Applied\. 1 deposit/.test(applied), applied.slice(-400));
      const st = async n => (await q(`SELECT status FROM transactions WHERE id=$1`, [`CHK-DEC-TX${n}`])).rows[0].status;
      ok('the declined one is now rejected', await st(11) === 'rejected', await st(11));
      ok('the APPROVED one is left pending', await st(12) === 'pending',
         `${await st(12)} — the client may have paid; rejecting it would be the opposite of the truth`);
      ok('the UNCLEAR one is left pending', await st(13) === 'pending', await st(13));
      ok('and a second run finds nothing left to do',
         /DECLINED: 0/.test(run([])) , run([]).slice(0, 400));
    }

    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
    await cleanup().catch(() => {});
  } finally {
    try { server && server.close(); } catch (_) { /* already down */ }
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
