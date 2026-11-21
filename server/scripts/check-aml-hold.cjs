#!/usr/bin/env node
/* A flagged deposit is HELD, not credited and reported afterwards.
 *
 * WHAT WAS WRONG. aml.checkDeposit was called fire-and-forget from
 * payments.js and its result thrown away:
 *
 *     const result = await creditWallet(...);
 *     aml.checkDeposit(pool, investorId, creditAmount, reference).catch(...)
 *
 * So the rules fired, a high-priority ticket was raised — and the money was
 * already in the wallet and spendable. A client could deposit R2m, invest
 * it and withdraw the proceeds before anybody opened the ticket. An alert
 * that arrives after the money has moved is a record of a decision nobody
 * got to make, and for an FSP that is the wrong way round.
 *
 * WHAT IS CHECKED HERE, by running it rather than reading it:
 *   · the rules still fire at the thresholds they always did
 *   · A FLAGGED DEPOSIT MOVES NO WALLET, and the row says pending_aml
 *   · an unflagged one is credited exactly as before — the ordinary case,
 *     which is the one a control like this most often breaks
 *   · releasing credits it once, to the account it was paid into, and a
 *     second release is refused rather than paying twice
 *   · rejecting credits nothing
 *   · the 24h rule no longer counts the deposit being assessed twice
 *     against itself, which flagged two R40 000 deposits for crossing
 *     R100 000 when the real total was R80 000
 *   · a staff EFT credit is assessed at all, which it never was
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-aml-hold.cjs
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
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const INV = 'INV-AML-1';
const SA  = 'SA-AML-1';

(async () => {
  let srv;
  try {
    const { rows: [r] } = await db.query(
      `SELECT to_regclass('public.support_tickets') IS NOT NULL AS ready`);
    if (!r.ready) { console.log('\n  SKIP  no support_tickets table here'); return; }

    const aml = require(path.join(ROOT, 'server', 'services', 'aml.js'));

    const clean = async () => {
      await db.query(`DELETE FROM support_tickets WHERE investor_id LIKE 'INV-AML-%'`);
      await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-AML-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-AML-%'`);
      await db.query(`DELETE FROM investors WHERE id LIKE 'INV-AML-%'`);
    };
    await clean();
    await db.query(
      `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance, kyc_status)
       VALUES ($1,'Amina','Test','aml-1@example.test','active',0,'approved')`, [INV]);
    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, wallet_balance,
                                 kyc_status, status)
       VALUES ($1,$2,'minor','Child Account',0,'approved','active')`, [SA, INV]);

    const walletOf = async () => Number((await db.query(
      `SELECT wallet_balance::float w FROM investors WHERE id = $1`, [INV])).rows[0].w);
    const saWalletOf = async () => Number((await db.query(
      `SELECT wallet_balance::float w FROM sub_accounts WHERE id = $1`, [SA])).rows[0].w);
    const txnOf = async ref => (await db.query(
      `SELECT * FROM transactions WHERE reference = $1`, [ref])).rows[0];
    const ticketsOf = async () => (await db.query(
      `SELECT * FROM support_tickets WHERE investor_id = $1 ORDER BY created_at`, [INV])).rows;

    /* ── The rules themselves ───────────────────────────────────────── */
    console.log('\nthe rules fire where they always did');
    {
      const big = await aml.assess(db, { investorId: INV, amount: 50000 });
      ok('a single deposit at R50 000 is flagged', big.flagged === true, JSON.stringify(big));
      ok('and one a cent under is not',
         !(await aml.assess(db, { investorId: INV, amount: 49999.99 })).flagged);
      ok('the reason says which rule', /Large single deposit/.test(big.reason || ''), big.reason);
      ok('ASSESSING WRITES NOTHING', (await ticketsOf()).length === 0,
         'the decision and the ticket were one function, which is why the '
         + 'decision could only be made after the money had moved');
    }

    /* ── The double count, which was a real false positive ──────────── */
    console.log('\nand the deposit being assessed is not counted twice against itself');
    {
      await db.query(
        `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, created_at, updated_at)
         VALUES (gen_random_uuid(),$1,'deposit',40000,'completed','AML-PRE-1','Earlier today',NOW(),NOW())`, [INV]);
      const second = await aml.assess(db, { investorId: INV, amount: 40000 });
      ok('TWO R40 000 DEPOSITS IN A DAY ARE R80 000, NOT R120 000',
         second.flagged === false && second.total24h === 80000,
         JSON.stringify(second) + ' — the old caller ran after the row was '
         + 'written, so the sum already held it and then added the amount again');
      /* Called after the row exists, naming it, the answer is the same. */
      await db.query(
        `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, created_at, updated_at)
         VALUES (gen_random_uuid(),$1,'deposit',40000,'completed','AML-PRE-2','Just written',NOW(),NOW())`, [INV]);
      const after = await aml.assess(db, { investorId: INV, amount: 40000, excludeReference: 'AML-PRE-2' });
      ok('and excluding it by reference gives the same answer either way',
         after.flagged === false && after.total24h === 80000, JSON.stringify(after));
      const third = await aml.assess(db, { investorId: INV, amount: 30000 });
      ok('but R80 000 already in and R30 000 more does cross R100 000',
         third.flagged === true && /24h/.test(third.reason || ''), JSON.stringify(third));
      await db.query(`DELETE FROM transactions WHERE reference LIKE 'AML-PRE-%'`);
    }

    /* ── The credit path, for real, through the route ────────────────── */
    const express = require('express');
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_check';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));

    /* Paystack is the one thing not driven for real: the verify route calls
       its API. Everything downstream of the verification — the assessment,
       the hold, the wallet, the ticket, the release — is the real code. */
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('api.paystack.co')) {
        const ref = decodeURIComponent(u.split('/verify/')[1] || '');
        return { ok: true, json: async () => ({
          status: true,
          data: { status: 'success', amount: (AMOUNTS[ref] || 0) * 100, reference: ref,
                  metadata: { wallet_credit: AMOUNTS[ref], sub_account_id: SUBS[ref] || null } },
        }) };
      }
      return realFetch ? realFetch(url, opts) : { ok: false, json: async () => ({}) };
    };
    const AMOUNTS = {};
    const SUBS = {};

    const app = express();
    app.use(express.json());
    app.use('/api/payments', require(path.join(ROOT, 'server', 'routes', 'payments.js')));
    app.use('/api/admin/aml', require(path.join(ROOT, 'server', 'routes', 'aml.js')));
    srv = await new Promise(res => { const x = app.listen(0, () => res(x)); });

    const call = (method, p, token, body) => new Promise(res => {
      const http = require('http');
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const q = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign({ Authorization: `Bearer ${token}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s = ''; x.on('data', c => s += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s || '{}') })); });
      if (payload) q.write(payload);
      q.end();
    });
    const asClient = jwt.sign({ id: 'u-aml', role: 'investor', investorId: INV }, process.env.JWT_SECRET);
    const asStaff  = jwt.sign({ id: 'u-staff', role: 'admin', email: 'staff@example.test' }, process.env.JWT_SECRET);
    const deposit = (ref, amount, subAccountId) => {
      AMOUNTS[ref] = amount;
      if (subAccountId) SUBS[ref] = subAccountId;
      return call('POST', '/api/payments/paystack/verify', asClient,
                  { reference: ref, subAccountId: subAccountId || null });
    };

    console.log('\nan ordinary deposit is credited exactly as before');
    {
      const res = await deposit('AML-OK-1', 1000);
      ok('it succeeds', res.status === 200, JSON.stringify(res.body));
      ok('THE WALLET HAS THE MONEY', await walletOf() === 1000, String(await walletOf()));
      const t = await txnOf('AML-OK-1');
      ok('and the deposit is completed', t && t.status === 'completed', t && t.status);
      ok('and nothing was flagged', (await ticketsOf()).length === 0);
      ok('and the response does not claim a hold', res.body.held !== true, JSON.stringify(res.body));
    }

    console.log('\nand a flagged one is held');
    {
      const before = await walletOf();
      const res = await deposit('AML-BIG-1', 75000);
      ok('the payment is accepted, not refused', res.status === 200, JSON.stringify(res.body));
      ok('THE WALLET DID NOT MOVE', await walletOf() === before,
         `${before} → ${await walletOf()} — this is the bug: the money used to `
         + 'be credited and spendable while the ticket waited to be read');
      ok('and the response says it is held, with the reason',
         res.body.held === true && /Large single deposit/.test(res.body.reason || ''),
         JSON.stringify(res.body));
      const t = await txnOf('AML-BIG-1');
      ok('the deposit is recorded, so the client can see it arrived',
         !!t, 'a payment that appears nowhere is worse than one that is delayed');
      ok('AND IT CARRIES pending_aml', t && t.status === aml.HELD_STATUS, t && t.status);
      ok('and the reason is on the row', /Large single deposit/.test((t && t.notes) || ''), t && t.notes);
      ok('and it does not describe itself as credited',
         !/credited to/.test((t && t.description) || ''), t && t.description);

      const tickets = await ticketsOf();
      ok('a ticket is raised', tickets.length === 1, JSON.stringify(tickets.map(x => x.subject)));
      ok('it is high priority and open',
         tickets[0] && tickets[0].priority === 'high' && tickets[0].status === 'open');
      ok('AND IT SAYS THE FUNDS ARE HELD, and where to act',
         /FUNDS ARE HELD/.test(tickets[0].message) && /Funds held for AML review/.test(tickets[0].message),
         tickets[0].message);
    }

    console.log('\nand the webhook cannot credit the held one behind our back');
    {
      /* Both doors use one reference and the unique index. The row already
         exists as pending_aml, so a second attempt writes nothing — which
         is also what stops a release being undone by a late webhook. */
      const before = await walletOf();
      await deposit('AML-BIG-1', 75000);
      ok('a repeat of the same reference moves no money',
         await walletOf() === before, String(await walletOf()));
      ok('and the row is still held, not completed',
         (await txnOf('AML-BIG-1')).status === aml.HELD_STATUS);
      ok('and no second ticket is raised', (await ticketsOf()).length === 1);
    }

    console.log('\nreleasing it credits it once');
    {
      const before = await walletOf();
      const res = await call('POST', '/api/admin/aml/held/AML-BIG-1/release', asStaff);
      ok('staff can release it', res.status === 200, JSON.stringify(res.body));
      ok('THE MONEY IS IN THE WALLET NOW', await walletOf() === before + 75000,
         `${before} → ${await walletOf()}`);
      const t = await txnOf('AML-BIG-1');
      ok('and the row is completed', t.status === 'completed', t.status);
      ok('and says it was released after review', /released after AML review/.test(t.description || ''), t.description);
      ok('and who released it is on the row', /released by staff@example.test/.test(t.notes || ''), t.notes);
      ok('the ticket is closed by the same action',
         (await ticketsOf())[0].status === 'resolved',
         'the queue and the tickets must not disagree about what is outstanding');

      /* Two people reading the same queue and both pressing Release is the
         ordinary case, not the unlikely one. */
      const again = await call('POST', '/api/admin/aml/held/AML-BIG-1/release', asStaff);
      ok('A SECOND RELEASE IS REFUSED, not paid twice', again.status === 409,
         `${again.status} ${JSON.stringify(again.body)}`);
      ok('and the wallet is unchanged by it', await walletOf() === before + 75000,
         String(await walletOf()));
    }

    console.log('\nand a held deposit paid into a sub-account goes there');
    {
      const res = await deposit('AML-SA-1', 60000, SA);
      ok('it is held', res.body.held === true, JSON.stringify(res.body));
      ok('and the sub-account did not move either', await saWalletOf() === 0, String(await saWalletOf()));
      const own = await walletOf();
      const rel = await call('POST', '/api/admin/aml/held/AML-SA-1/release', asStaff);
      ok('releasing credits the SUB-ACCOUNT it was paid into',
         rel.status === 200 && await saWalletOf() === 60000, String(await saWalletOf()));
      ok('AND NOT THE PARENT’S OWN WALLET', await walletOf() === own,
         `${own} → ${await walletOf()} — release has to route the money the same `
         + 'way the deposit would have');
    }

    console.log('\nand rejecting it credits nothing');
    {
      const res = await deposit('AML-REJ-1', 80000);
      ok('it is held', res.body.held === true, JSON.stringify(res.body));
      const before = await walletOf();

      const noReason = await call('POST', '/api/admin/aml/held/AML-REJ-1/reject', asStaff, {});
      ok('a rejection with no reason is refused', noReason.status === 400, JSON.stringify(noReason.body));

      const rej = await call('POST', '/api/admin/aml/held/AML-REJ-1/reject', asStaff,
                             { reason: 'Source of funds not established' });
      ok('with one it is rejected', rej.status === 200, JSON.stringify(rej.body));
      ok('THE WALLET IS UNTOUCHED', await walletOf() === before, String(await walletOf()));
      const t = await txnOf('AML-REJ-1');
      ok('and the row says rejected', t.status === 'rejected', t.status);
      ok('and the reason is on it', /Source of funds not established/.test(t.notes || ''), t.notes);
      const tk = (await ticketsOf()).find(x => /AML-REJ-1/.test(x.message));
      ok('and the ticket stays OPEN, because the refund still has to be done',
         tk && tk.status === 'open', tk && tk.status);
      ok('and says in as many words that it was not done',
         /refund through the gateway is a/.test(tk.message) && /has NOT been done/.test(tk.message),
         tk.message);
      ok('releasing a rejected one is refused',
         (await call('POST', '/api/admin/aml/held/AML-REJ-1/release', asStaff)).status === 409);
    }

    console.log('\nand the queue is what the console reads');
    {
      await deposit('AML-Q-1', 55000);
      const q = await call('GET', '/api/admin/aml/held', asStaff);
      const refs = (q.body.data || []).map(x => x.reference);
      ok('a held deposit is in it', refs.includes('AML-Q-1'), JSON.stringify(refs));
      ok('a released one is not', !refs.includes('AML-BIG-1'), JSON.stringify(refs));
      ok('a rejected one is not', !refs.includes('AML-REJ-1'), JSON.stringify(refs));
      ok('and it carries who paid it and why it is held',
         (q.body.data || []).some(x => x.reference === 'AML-Q-1'
           && x.first_name === 'Amina' && /Large single deposit/.test(x.notes || '')),
         JSON.stringify(q.body.data));
      ok('A CLIENT CANNOT SEE THE QUEUE',
         (await call('GET', '/api/admin/aml/held', asClient)).status === 403);
      ok('and cannot release their own held deposit',
         (await call('POST', '/api/admin/aml/held/AML-Q-1/release', asClient)).status === 403,
         'this is the one button a client would most like to press');
    }

    /* ── The paths that are NOT held, and why ───────────────────────── */
    console.log('\nand a staff EFT credit is assessed, but not held');
    {
      const MC = strip(fs.readFileSync(path.join(ROOT, 'server', 'routes', 'manualCredit.js'), 'utf8'));
      ok('IT IS ASSESSED AT ALL NOW',
         /aml\.checkDeposit\(pool, investorId, numAmount, reference\)/.test(MC),
         'the rules were wired into the card path only, and the largest '
         + 'deposits on this platform arrive by EFT and are credited here');
      ok('and awaited, not fire-and-forget',
         /await aml\.checkDeposit/.test(MC),
         'a ticket that fails to be written is worth knowing about');
      ok('and the credit still happens — a human has already verified it',
         !/HELD_STATUS/.test(MC) && /wallet_balance = wallet_balance \+ \$1/.test(MC),
         'holding a staff credit would mean the same person releasing it a '
         + 'moment later, which is a control in name only');
      ok('and whoever pressed the button is told a review was raised',
         /aml_flagged/.test(MC), MC.slice(-400));
    }

    console.log('\nand the old fire-and-forget call is gone from the card path');
    {
      const P = strip(fs.readFileSync(path.join(ROOT, 'server', 'routes', 'payments.js'), 'utf8'));
      ok('THE ASSESSMENT IS INSIDE THE TRANSACTION, before the credit',
         P.indexOf('aml.assess(client,') > -1
         && P.indexOf('aml.assess(client,') < P.indexOf('wallet_balance = wallet_balance + $1'),
         'decided against the same locked row the money moves from');
      ok('and there is no discarded checkDeposit left in it',
         !/aml\.checkDeposit\([^)]*\)\.catch/.test(P),
         'that call is how the ticket came to be raised after the money moved');
      ok('and a held deposit is not emailed a confirmation',
         P.indexOf('sendDepositUnderReview') < P.indexOf('sendDepositConfirmed'),
         '"your deposit has been credited" about money that is not in the wallet');
    }

    await clean();
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
