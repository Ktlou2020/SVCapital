#!/usr/bin/env node
/* Approving an EFT deposit credits the amount that actually arrived, once,
 * and leaves a record of who decided it.
 *
 * A client paid R505 and typed R500 into the portal. The console asked
 * "Credit R500 to their wallet?" and offered yes or no — so R500 was credited
 * and the R5 went nowhere.
 *
 * The figure was worse than fragile. It came from a regex over the ticket
 * SUBJECT, a display string:
 *
 *     R1 485.15  ->  1485     15c lost
 *     R505,50    ->  50550    R505,50 credited as R50 550
 *
 * South African formatting uses the comma as the decimal separator and the
 * regex stripped it. A name containing " R " broke the parse entirely.
 *
 * Needs a database:
 *   DATABASE_URL=postgres://… DATABASE_SSL=false node server/scripts/check-eft-approve.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see server/scripts/check-eft-approve.cjs header');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const eqN = (name, a, b) => ok(name, Math.abs(Number(a) - Number(b)) < 0.005, `expected ${b}, got ${a}`);

const ROOT = path.join(__dirname, '..', '..');

/* The subject regex the console used, so its failures are recorded rather
   than asserted from memory. */
function oldParse(subject) {
  const m = String(subject || '').match(/R([\d\s,]+)/);
  const raw = m ? m[1].replace(/[\s,]/g, '') : null;
  return raw ? parseFloat(raw) : null;
}

async function schema() {
  await pool.query('DROP TABLE IF EXISTS transactions, support_tickets, investors, sub_accounts CASCADE');
  await pool.query(`
    CREATE TABLE investors (
      id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT,
      wallet_balance NUMERIC(18,2) DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE sub_accounts (id TEXT PRIMARY KEY, wallet_balance NUMERIC(18,2) DEFAULT 0);
    CREATE TABLE support_tickets (
      id TEXT PRIMARY KEY, investor_id TEXT, sub_account_id TEXT, category TEXT,
      subject TEXT, status TEXT, admin_response TEXT,
      responded_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), investor_id TEXT, sub_account_id TEXT,
      type TEXT, amount NUMERIC(18,2), status TEXT, reference TEXT, description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, event_type TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
      user_id UUID, user_email TEXT, actor_role TEXT, description TEXT,
      ip_address TEXT, metadata JSONB, platform TEXT, created_at TIMESTAMPTZ DEFAULT NOW());`);
}

async function seed({ ticketId, ref, declared, status = 'pending', subAccount = null }) {
  await pool.query(`INSERT INTO investors (id, first_name, last_name, wallet_balance)
                    VALUES ('S-EFT','Georgina','Read',0) ON CONFLICT (id) DO UPDATE SET wallet_balance = 0`);
  await pool.query(`DELETE FROM transactions; DELETE FROM support_tickets;`);
  await pool.query(
    `INSERT INTO support_tickets (id, investor_id, category, subject, status)
     VALUES ($1,'S-EFT','payment_proof',$2,'open')`,
    [ticketId, `EFT Proof of Payment — Georgina Read — R${declared} — ${ref}`]);
  if (subAccount) {
    await pool.query(`INSERT INTO sub_accounts (id, wallet_balance) VALUES ($1, 0)
                      ON CONFLICT (id) DO UPDATE SET wallet_balance = 0`, [subAccount]);
  }
  await pool.query(
    `INSERT INTO transactions (investor_id, sub_account_id, type, amount, status, reference)
     VALUES ('S-EFT',$3,'deposit',$1,$4,$2)`, [declared, ref, subAccount, status]);
}

const subWallet = async id =>
  Number((await pool.query(`SELECT wallet_balance FROM sub_accounts WHERE id=$1`, [id])).rows[0].wallet_balance);
const ticketStatus = async id =>
  (await pool.query(`SELECT status FROM support_tickets WHERE id=$1`, [id])).rows[0].status;

const wallet = async () =>
  Number((await pool.query(`SELECT wallet_balance FROM investors WHERE id='S-EFT'`)).rows[0].wallet_balance);

(async () => {
  try {
    await schema();

    /* ── The parse that caused it ───────────────────────────────────── */
    console.log('\nthe subject regex, for the record');
    eqN('R1 485.15 was read as 1485 — 15c lost', oldParse('X — R1 485.15 — EFT-1'), 1485);
    eqN('R505,50 was read as 50550 — a hundredfold over-credit', oldParse('X — R505,50 — EFT-2'), 50550);
    ok('a name containing " R " broke it entirely', oldParse('Read R Smith — R750 — EFT-3') === null,
       `got ${oldParse('Read R Smith — R750 — EFT-3')}`);

    const admin = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
    ok('the console no longer parses the amount out of the subject',
       !/Parse amount from subject/.test(admin) && !/match\(\/R\(\[\\d\\s,\]\+\)\//.test(admin),
       'the regex is still there');
    ok('it reads the declared amount from the pending deposit instead',
       /const p = \(res\?\.data \?\? \[\]\)\.find\(t => t\.reference === ref && t\.type === 'deposit'\)/.test(admin));

    /* ── Approving as declared ──────────────────────────────────────── */
    console.log('\napproving the amount as submitted');
    const route = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'manualCredit.js'), 'utf8');
    ok('there is one endpoint that does the whole approval',
       /router\.post\('\/eft-approve'/.test(route));
    ok('it runs in a transaction', /BEGIN[\s\S]{0,4000}eft-approve|\/eft-approve[\s\S]{0,2000}BEGIN/.test(route));
    ok('and guards against a second credit',
       /WHERE id = \$3 AND COALESCE\(status, ''\) <> 'completed'/.test(route),
       'a retry or double-click would credit twice');
    ok('the guard is NULL-safe',
       !/WHERE id = \$3 AND status <> 'completed'/.test(route),
       "`status <> 'completed'` is NULL for a NULL status, so the credit was skipped in silence");
    ok('and an approval that credits nothing refuses instead of resolving the ticket',
       /code: 'ALREADY_COMPLETED'/.test(route) && /Already completed — approving moves no money/.test(route),
       'it used to resolve the ticket and tell the investor the money was in their wallet');

    /* The route itself, over a socket. This used to be a second copy of the
       endpoint's SQL, written out statement by statement — which passes
       happily while the real route changes underneath it, and did: the copy
       still credited where the route now refuses. Auth is stubbed because the
       login is not what is under test. */
    const express = require('express');
    const http    = require('http');
    /* The router applies requireAuth + requireRole to everything it mounts, so
       the stub goes in before it is required. The login is not under test; the
       money is. */
    const ACTOR = { id: null, email: 'ops@check-eft.test', role: 'admin' };
    const authMod = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
    require.cache[authMod] = { id: authMod, filename: authMod, loaded: true, exports: {
      requireAuth: (req, _r, next) => { req.user = ACTOR; next(); },
      requireRole: (...roles) => (req, res, next) =>
        roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden.' }),
    } };
    const app = express();
    app.use(express.json());
    app.use('/api/admin', require(path.join(ROOT, 'server', 'routes', 'manualCredit')));
    const srv = await new Promise(r => { const x = app.listen(0, () => r(x)); });

    const post = (path_, body) => new Promise(resolve => {
      const payload = Buffer.from(JSON.stringify(body));
      const req = http.request({ port: srv.address().port, path: path_, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } }, res => {
        let out = ''; res.on('data', c => out += c);
        res.on('end', () => { let j = {}; try { j = JSON.parse(out); } catch (_) {} resolve({ status: res.statusCode, ...j }); });
      });
      req.on('error', e => resolve({ status: 0, error: e.message }));
      req.end(payload);
    });

    const approve = async ({ ticketId, approvedAmt, reason }) => {
      const r = await post('/api/admin/eft-approve',
        { ticket_id: ticketId, amount: approvedAmt, reason: reason || null });
      return { ...r, refused: r.code === 'REASON_REQUIRED' };
    };

    await seed({ ticketId: 'TK-A', ref: 'EFT-A', declared: 500 });
    const a = await approve({ ticketId: 'TK-A', approvedAmt: 500 });
    eqN('the wallet is credited the declared amount', await wallet(), 500);
    ok('and it is not flagged as a correction', a.adjusted === false);

    console.log('\na second click credits nothing — and now says so');
    const again = await approve({ ticketId: 'TK-A', approvedAmt: 500 });
    ok('the repeat is refused rather than reported as a success',
       again.status === 409 && again.code === 'ALREADY_COMPLETED', JSON.stringify(again));
    eqN('the wallet is unchanged', await wallet(), 500);
    ok('and the refusal names the repair', /Manual Credit/.test(again.error || ''), again.error);

    /* ── The case that started this ─────────────────────────────────── */
    console.log('\nthe client paid R505 and typed R500');
    await seed({ ticketId: 'TK-B', ref: 'EFT-B', declared: 500 });

    const refused = await approve({ ticketId: 'TK-B', approvedAmt: 505 });
    ok('a correction without a reason is refused', refused.refused === true, JSON.stringify(refused));
    eqN('and nothing is credited', await wallet(), 0);
    ok('the ticket is left open for someone to finish',
       (await pool.query(`SELECT status FROM support_tickets WHERE id='TK-B'`)).rows[0].status === 'open');

    const fixed = await approve({ ticketId: 'TK-B', approvedAmt: 505,
                                  reason: 'proof of payment shows R505,00' });
    eqN('with a reason, the real amount is credited', await wallet(), 505);
    ok('and it is recorded as a correction', fixed.adjusted === true);

    ok('the endpoint requires a reason to change the figure',
       /REASON_REQUIRED/.test(route) && /A reason is required to change it/.test(route));
    ok('and writes an audit event naming both amounts',
       /eft_deposit_approved_amount_corrected/.test(route) &&
       /declared_amount: declared/.test(route) && /approved_amount: approved/.test(route));
    ok('the audit row is written after the commit, so a logging failure cannot undo a credit',
       /COMMIT'\);[\s\S]{0,600}audit\.log\(/.test(route));

    /* ── The incident: approved, recorded, never credited ───────────── */
    console.log('\na deposit that is already completed cannot be approved into a wallet');
    {
      /* The state a real one was found in: the deposit row reads completed,
         the ticket is open, and no money ever moved. Whatever completed the
         row — a direct edit, an import, the old three-call console flow — the
         approval that follows finds nothing to update and so credits nothing.
         It used to resolve the ticket anyway and tell the investor the money
         was in their wallet. */
      await seed({ ticketId: 'TK-D', ref: 'EFT-D', declared: 1400, status: 'completed' });
      const r = await approve({ ticketId: 'TK-D', approvedAmt: 1400 });
      ok('the approval refuses', r.status === 409 && r.code === 'ALREADY_COMPLETED', JSON.stringify(r));
      eqN('no money is moved', await wallet(), 0);
      ok('the ticket is left open rather than resolved',
         await ticketStatus('TK-D') === 'open',
         'resolving it tells the investor about money that is not there');
      const told = (await pool.query(`SELECT admin_response FROM support_tickets WHERE id='TK-D'`)).rows[0];
      ok('and the investor is told nothing', !told.admin_response);
      const claims = (await pool.query(
        `SELECT COUNT(*)::int n FROM audit_events WHERE entity_id='TK-D'`)).rows[0].n;
      ok('nothing is written to the audit trail either', claims === 0,
         'an audit row for an approval that moved no money is a false record');
    }

    console.log('\na deposit with no status at all is credited, not skipped');
    {
      /* `status <> 'completed'` is NULL — not true — for a NULL status, so the
         UPDATE matched nothing and the credit was skipped in silence. The same
         outcome as above, by a different route, and the harder one to see. */
      await seed({ ticketId: 'TK-E', ref: 'EFT-E', declared: 750, status: null });
      const r = await approve({ ticketId: 'TK-E', approvedAmt: 750 });
      ok('the approval goes through', r.status === 200 && r.credited === true, JSON.stringify(r));
      eqN('and the wallet has the money', await wallet(), 750);
      ok('the ticket is resolved', await ticketStatus('TK-E') === 'resolved');
    }

    console.log('\na sub-account deposit credits the sub-account, not the parent');
    {
      await seed({ ticketId: 'TK-F', ref: 'EFT-F', declared: 300, subAccount: 'SA-EFT-1' });
      const r = await approve({ ticketId: 'TK-F', approvedAmt: 300 });
      ok('the approval goes through', r.status === 200 && r.credited === true, JSON.stringify(r));
      eqN('the sub-account is credited', await subWallet('SA-EFT-1'), 300);
      eqN("and the parent's wallet is untouched", await wallet(), 0,
          'this looks like a missing credit on the parent and is not one');
    }

    /* ── Cents survive ──────────────────────────────────────────────── */
    console.log('\ncents survive the round trip');
    await seed({ ticketId: 'TK-C', ref: 'EFT-C', declared: 1485.15 });
    await approve({ ticketId: 'TK-C', approvedAmt: 1485.15 });
    // seed() resets the wallet, so this is the only credit against it.
    eqN('R1 485,15 is credited exactly', await wallet(), 1485.15);
    const row = (await pool.query(`SELECT amount FROM transactions WHERE reference='EFT-C'`)).rows[0];
    eqN('and stored exactly', row.amount, 1485.15);

    /* ── The dialog ─────────────────────────────────────────────────── */
    console.log('\nthe console asks before crediting');
    ok('there is a confirm step, not a yes/no', /function _eftConfirmAmount\(/.test(admin));
    ok('the amount is editable', /id="eftAmt"[^>]*type="number"/.test(admin));
    ok('a change demands a reason before it will submit',
       /it goes on the audit trail/.test(admin));
    ok('and the approval goes through the single endpoint',
       /API\._fetch\('POST', 'admin\/eft-approve'/.test(admin));

    /* ── The audit row must survive an actor it cannot link ─────────── */
    console.log('\nthe audit row survives an actor that is not a users UUID');
    {
      await pool.query(`DROP TABLE IF EXISTS audit_events`);
      await pool.query(`CREATE TABLE audit_events (
        id TEXT PRIMARY KEY, event_type TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
        user_id UUID, user_email TEXT, actor_role TEXT, description TEXT,
        ip_address TEXT, metadata JSONB, platform TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);

      delete require.cache[require.resolve(path.join(ROOT, 'server', 'services', 'audit'))];
      delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool'))];
      const audit = require(path.join(ROOT, 'server', 'services', 'audit'));

      // 'E1-EMPLOYEE' is not a UUID. Staff authenticated by empId look like
      // this, and the whole row used to be dropped on the failed cast.
      await audit.log({
        actorId: 'E1-EMPLOYEE', actorEmail: 'ops@svcapital.co.za', actorRole: 'admin',
        action: 'eft_deposit_approved_amount_corrected',
        entityType: 'support_ticket', entityId: 'TK-B',
        description: 'EFT approved at R505.00 — corrected from R500.00.',
        before: { declared_amount: 500 }, after: { approved_amount: 505, reason: 'proof shows R505,00' },
      });

      const rows = (await pool.query(`SELECT * FROM audit_events`)).rows;
      ok('the event is recorded even though the actor cannot be linked', rows.length === 1,
         `${rows.length} row(s) — a non-UUID actor used to lose the event entirely`);
      if (rows[0]) {
        ok('the link is dropped, not the row', rows[0].user_id === null);
        ok('who did it is still known',
           rows[0].user_email === 'ops@svcapital.co.za' && rows[0].actor_role === 'admin');
        ok('and the unlinkable id is kept verbatim',
           rows[0].metadata && rows[0].metadata.actor_ref === 'E1-EMPLOYEE',
           JSON.stringify(rows[0].metadata));
        ok('both amounts and the reason are on the row',
           String(rows[0].metadata.before.declared_amount) === '500' &&
           String(rows[0].metadata.after.approved_amount) === '505' &&
           /R505,00/.test(rows[0].metadata.after.reason), JSON.stringify(rows[0].metadata));
      }

      const src = fs.readFileSync(path.join(ROOT, 'server', 'services', 'audit.js'), 'utf8');
      ok('the service retries without the link before giving up',
         /recorded "\$\{action\}" without an actor link/.test(src));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await pool.query('DROP TABLE IF EXISTS transactions, support_tickets, investors, sub_accounts CASCADE').catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
