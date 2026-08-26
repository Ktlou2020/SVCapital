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
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());`);
}

async function seed({ ticketId, ref, declared }) {
  await pool.query(`INSERT INTO investors (id, first_name, last_name, wallet_balance)
                    VALUES ('S-EFT','Georgina','Read',0) ON CONFLICT (id) DO UPDATE SET wallet_balance = 0`);
  await pool.query(`DELETE FROM transactions; DELETE FROM support_tickets;`);
  await pool.query(
    `INSERT INTO support_tickets (id, investor_id, category, subject, status)
     VALUES ($1,'S-EFT','payment_proof',$2,'open')`,
    [ticketId, `EFT Proof of Payment — Georgina Read — R${declared} — ${ref}`]);
  await pool.query(
    `INSERT INTO transactions (investor_id, type, amount, status, reference)
     VALUES ('S-EFT','deposit',$1,'pending',$2)`, [declared, ref]);
}

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
       /WHERE id = \$3 AND status <> 'completed'/.test(route),
       'a retry or double-click would credit twice');

    /* Exercise the endpoint's SQL directly — the same statements, same order. */
    async function approve({ ticketId, ref, approvedAmt, reason }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: [t] } = await client.query('SELECT * FROM support_tickets WHERE id=$1 FOR UPDATE', [ticketId]);
        const { rows: [p] } = await client.query(
          `SELECT * FROM transactions WHERE investor_id=$1 AND reference=$2 AND type='deposit'
            ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [t.investor_id, ref]);
        const declared = p ? Number(p.amount) : null;
        const adjusted = declared !== null && Math.abs(declared - approvedAmt) >= 0.005;
        if (adjusted && !String(reason || '').trim()) {
          await client.query('ROLLBACK');
          return { refused: true, declared };
        }
        const { rows: [done] } = await client.query(
          `UPDATE transactions SET status='completed', amount=$1, updated_at=NOW()
            WHERE id=$2 AND status <> 'completed' RETURNING *`, [approvedAmt, p.id]);
        if (done) {
          await client.query(
            'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at=NOW() WHERE id=$2',
            [approvedAmt, t.investor_id]);
        }
        await client.query(
          `UPDATE support_tickets SET status='resolved', responded_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [ticketId]);
        await client.query('COMMIT');
        return { credited: !!done, declared, adjusted };
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
    }

    await seed({ ticketId: 'TK-A', ref: 'EFT-A', declared: 500 });
    const a = await approve({ ticketId: 'TK-A', ref: 'EFT-A', approvedAmt: 500 });
    eqN('the wallet is credited the declared amount', await wallet(), 500);
    ok('and it is not flagged as a correction', a.adjusted === false);

    console.log('\na second click credits nothing');
    const again = await approve({ ticketId: 'TK-A', ref: 'EFT-A', approvedAmt: 500 });
    ok('the repeat is a no-op', again.credited === false);
    eqN('the wallet is unchanged', await wallet(), 500);

    /* ── The case that started this ─────────────────────────────────── */
    console.log('\nthe client paid R505 and typed R500');
    await seed({ ticketId: 'TK-B', ref: 'EFT-B', declared: 500 });

    const refused = await approve({ ticketId: 'TK-B', ref: 'EFT-B', approvedAmt: 505 });
    ok('a correction without a reason is refused', refused.refused === true, JSON.stringify(refused));
    eqN('and nothing is credited', await wallet(), 0);
    ok('the ticket is left open for someone to finish',
       (await pool.query(`SELECT status FROM support_tickets WHERE id='TK-B'`)).rows[0].status === 'open');

    const fixed = await approve({ ticketId: 'TK-B', ref: 'EFT-B', approvedAmt: 505,
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

    /* ── Cents survive ──────────────────────────────────────────────── */
    console.log('\ncents survive the round trip');
    await seed({ ticketId: 'TK-C', ref: 'EFT-C', declared: 1485.15 });
    await approve({ ticketId: 'TK-C', ref: 'EFT-C', approvedAmt: 1485.15 });
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
