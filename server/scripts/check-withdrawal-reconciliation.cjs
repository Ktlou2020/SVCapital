#!/usr/bin/env node
/* The double-debit report must find the charge, and must not invent one.
 *
 * This report is the basis for refunding clients, so both halves matter equally.
 * A miss leaves someone short. A false positive pays out against a withdrawal
 * that was handled correctly, and the deliberate wallet override — an audited,
 * confirmed admin action — looks superficially identical to the bug: an absolute
 * balance write, by an admin, on an investor. The only thing separating them is
 * the audit event type, so that separation is asserted directly.
 *
 * The fixture stages audit_events the way the console actually wrote them: a
 * transactions.updated to completed, then an investors.updated whose
 * metadata->'after' carries a wallet_balance, seconds apart, same actor.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-withdrawal-reconciliation.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const SCRIPT = path.join(__dirname, 'reconcile-withdrawal-double-debits.cjs');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function run(args) {
  try {
    return execFileSync('node', [SCRIPT, ...args],
      { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  } catch (err) { return (err.stdout || '') + (err.stderr || ''); }
}

/* The report prints money in South African format — R1 250,00, comma for the
   decimal — which is correct for the console and for this business, and is what
   the rest of the platform does. Asserting on "R1,250.00" made four of these
   checks fail against output that was right.

   So amounts are canonicalised before matching: whatever the runtime's locale
   does with separators, R1 250,00 and R1,250.00 both become R1250.00 here. The
   CSV is deliberately NOT locale-formatted — a refund run parsing "1 250,00"
   would be a disaster — and is asserted separately, raw.
   The pattern has to be exact about separators rather than "digits and
   whitespace". A loose [\d\s.,]* ran across the column gap and across newlines,
   so "<= R800,00  1" -- the amount and the count beside it -- canonised to
   R800001 and the assertion failed against a report that was correct. A
   thousands separator is ONE space or comma between groups of three; anything
   else ends the number. */
const NBSP = String.fromCharCode(160);
const canon = txt => txt.replace(
  new RegExp('R ?\\d{1,3}(?:[ ' + NBSP + ',]\\d{3})*(?:[.,]\\d{2})?', 'g'), m => {
    const s = m.replace(/^R ?/, '');
    const strip = x => x.split('').filter(ch => /\d/.test(ch)).join('');
    const dec = s.match(/^(.*)([.,])(\d{2})$/);
    return dec ? 'R' + strip(dec[1]) + '.' + dec[3] : 'R' + strip(s);
  });

const q = (s, p) => pool.query(s, p);
const ACTOR = 'admin@chk-recon.test';
let clock = Date.parse('2026-06-01T09:00:00Z');
const at = mins => new Date(clock + mins * 60000).toISOString();

async function cleanup() {
  await q(`DELETE FROM audit_events WHERE entity_id LIKE 'CHK-RC-%' OR user_email = $1`, [ACTOR]).catch(() => {});
  await q(`DELETE FROM transactions WHERE id LIKE 'CHK-RC-%'`).catch(() => {});
  await q(`DELETE FROM sub_accounts WHERE id LIKE 'CHK-RC-%'`).catch(() => {});
  await q(`DELETE FROM investors    WHERE id LIKE 'CHK-RC-%'`).catch(() => {});
}

const audit = (type, entityId, after, when, actor = ACTOR) => q(
  `INSERT INTO audit_events (id, event_type, entity_type, entity_id, user_email, actor_role, description, metadata, created_at)
   VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'admin', 'fixture', $5::jsonb, $6)`,
  [type, type.split('.')[0], entityId, actor, JSON.stringify({ before: null, after }), when]);

/* One approval, exactly as the console performed it. */
async function stageApproval({ txnId, investorId, type, amount, walletWritten, gapMins = 0.05, subAccountId = null, actor = ACTOR }) {
  await q(`INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference)
           VALUES ($1,$2,$3,$4,$5,'completed',$1)`, [txnId, investorId, subAccountId, type, amount]);
  await audit('transactions.updated', txnId, { status: 'completed' }, at(0), actor);
  if (walletWritten !== null)
    await audit('investors.updated', investorId, { wallet_balance: walletWritten }, at(gapMins), actor);
}

(async () => {
  try {
    const { rows: [t] } = await q(
      `SELECT to_regclass('audit_events') a, to_regclass('transactions') b, to_regclass('investors') c`);
    if (!t.a || !t.b || !t.c) {
      console.log('  SKIP  required tables not present'); await pool.end(); process.exit(0);
    }

    await cleanup();
    await q(`INSERT INTO investors (id, first_name, last_name, email, wallet_balance)
             VALUES ('CHK-RC-I1','Thandi','Mokoena','t@chk-recon.test', 2000),
                    ('CHK-RC-I2','Sipho','Nkosi','s@chk-recon.test', 0),
                    ('CHK-RC-I3','Clean','Case','c@chk-recon.test', 3000)`);
    await q(`INSERT INTO sub_accounts (id, parent_investor_id, name, account_type, wallet_balance, status)
             VALUES ('CHK-RC-SA','CHK-RC-I1','Child','child', 500, 'active')`);

    /* 1. The plain case: R1,000 withdrawal, wallet written above zero. */
    clock = Date.parse('2026-06-01T09:00:00Z');
    await stageApproval({ txnId: 'CHK-RC-W1', investorId: 'CHK-RC-I1', type: 'withdrawal', amount: 1000, walletWritten: 3000 });

    /* 2. A second one for the same investor — they are owed both. */
    clock = Date.parse('2026-06-02T09:00:00Z');
    await stageApproval({ txnId: 'CHK-RC-W2', investorId: 'CHK-RC-I1', type: 'withdrawal', amount: 250, walletWritten: 2750 });

    /* 3. Clamped at zero: the extra debit is AT MOST the amount. */
    clock = Date.parse('2026-06-03T09:00:00Z');
    await stageApproval({ txnId: 'CHK-RC-W3', investorId: 'CHK-RC-I2', type: 'withdrawal', amount: 800, walletWritten: 0 });

    /* 4. A correctly handled withdrawal — approved, no bare wallet write. */
    clock = Date.parse('2026-06-04T09:00:00Z');
    await stageApproval({ txnId: 'CHK-RC-W4', investorId: 'CHK-RC-I3', type: 'withdrawal', amount: 900, walletWritten: null });

    /* 5. The deliberate override. Same shape — absolute wallet write by an
          admin — but its own event type. Must never be counted. */
    clock = Date.parse('2026-06-05T09:00:00Z');
    await audit('transactions.updated', 'CHK-RC-W4', { status: 'completed' }, at(0));
    await audit('wallet.balance_override', 'CHK-RC-I3', { wallet_balance: 12345 }, at(0.05));

    /* 6. A sub-account deposit: the same bug, running the other way. */
    clock = Date.parse('2026-06-06T09:00:00Z');
    await stageApproval({ txnId: 'CHK-RC-D1', investorId: 'CHK-RC-I1', type: 'deposit', amount: 300,
                          walletWritten: 2300, subAccountId: 'CHK-RC-SA' });

    const out = run(['--since', '2026-06-01', '--until', '2026-06-30']);
    const outC = canon(out);

    console.log('\nit finds the double debits');
    ok('the report runs', /WITHDRAWAL DOUBLE-DEBIT RECONCILIATION/.test(out), out.slice(0, 300));
    ok('it says it cannot write', /READ ONLY — this transaction cannot write/.test(out));
    ok('three double-debited withdrawals', /DOUBLE-DEBITED WITHDRAWALS: 3/.test(out), out);
    ok('the investor charged twice is named', /Thandi Mokoena/.test(out), out);
    ok('their two withdrawals are summed', /R1250\.00/.test(outC),
       'R1,000 and R250 for the same person is R1,250 owed');

    console.log('\nand separates what it can settle from what it cannot');
    ok('the clamped one is not added to the refundable total',
       /≤ R800\.00/.test(outC), outC);
    ok('the refundable total is the unclamped ones only',
       /R1250\.00/.test(outC) && !/R2050\.00/.test(outC),
       '1250 + 800 = 2050 would mean the clamped one was treated as exact');
    ok('and it explains why the clamped ones need a person',
       /clamp may have absorbed/.test(out), out.slice(-1800));
    ok('it reports 2 refundable exactly', /2 refundable exactly/.test(out), out);

    console.log('\nit does not invent charges');
    ok('a correctly approved withdrawal is not flagged',
       !/Clean Case/.test(out.split('DEPOSITS WITH A BARE')[0]),
       'CHK-RC-W4 was approved with no bare wallet write');
    ok('the deliberate override is not counted',
       !/12345|12 345/.test(out),
       'wallet.balance_override is an audited, confirmed admin action — not this bug');
    ok('and the unpaired withdrawal is reported as coverage, not as a charge',
       /have no paired wallet write/.test(out), out.slice(-1200));

    console.log('\nit reports the other direction too');
    ok('the sub-account deposit is picked up',
       /DEPOSITS WITH A BARE WALLET WRITE: 1/.test(out), out);
    ok('and flagged as a sub-account', /1 on a SUB-ACCOUNT|SUB-ACCOUNT\)/.test(out), out);
    ok('with the amount credited in error', /R300\.00/.test(outC), outC);
    ok('it is kept out of the withdrawal total',
       /DOUBLE-DEBITED WITHDRAWALS: 3/.test(out),
       'a deposit is money created, not money owed — adding them would net to nonsense');

    console.log('\nit tells you how far the evidence reaches');
    ok('the audit window is printed', /audit log covers/.test(out), out.slice(0, 600));
    ok('and the pairing window', /pairing window: 30s/.test(out));
    ok('a missing audit row is called a floor, not a clean result',
       /are a floor/.test(out), out.slice(-1200));

    console.log('\nthe pairing window is honoured');
    {
      /* Ten minutes apart is not one approval. It must fall out of the pairing
         and be reported as unpaired rather than silently attributed. */
      clock = Date.parse('2026-07-01T09:00:00Z');
      await stageApproval({ txnId: 'CHK-RC-W5', investorId: 'CHK-RC-I3', type: 'withdrawal',
                            amount: 400, walletWritten: 2600, gapMins: 10 });
      const tight = run(['--since', '2026-07-01', '--until', '2026-07-31']);
      ok('a write 10 minutes later does not pair at 30s',
         /DOUBLE-DEBITED WITHDRAWALS: 0/.test(tight), tight.slice(0, 900));
      ok('and is surfaced as unpaired',
         /1 bare wallet write\(s\) had no transaction event/.test(tight), tight.slice(-1200));
      const wide = run(['--since', '2026-07-01', '--until', '2026-07-31', '--window', '900']);
      ok('raising the window pairs it', /DOUBLE-DEBITED WITHDRAWALS: 1/.test(wide), wide.slice(0, 900));
    }

    console.log('\nscoping works');
    {
      const one = run(['--since', '2026-06-01', '--until', '2026-06-30', '--investor', 'CHK-RC-I2']);
      ok('--investor narrows to that person', /DOUBLE-DEBITED WITHDRAWALS: 1/.test(one), one.slice(0, 900));
      ok('and excludes everyone else', !/Thandi Mokoena/.test(one), one);

      const none = run(['--since', '2026-01-01', '--until', '2026-01-31']);
      ok('a window with nothing in it reports none',
         /DOUBLE-DEBITED WITHDRAWALS: 0/.test(none) || /None found/.test(none), none.slice(0, 900));
    }

    console.log('\nthe CSV carries what a refund run needs');
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
      const csv = path.join(dir, 'out.csv');
      run(['--since', '2026-06-01', '--until', '2026-06-30', '--csv', csv]);
      const text = fs.existsSync(csv) ? fs.readFileSync(csv, 'utf8') : '';
      const head = text.split('\n')[0] || '';
      ok('it is written', !!text, csv);
      for (const col of ['investor_id', 'email', 'amount', 'clamped_at_zero', 'extra_debit', 'reference', 'actor'])
        ok(`  it carries ${col}`, head.includes(col), head);
      ok('the exact rows carry a plain number', /,1000\.00,/.test(text), text.split('\n').slice(0, 3).join('\n'));
      ok('and the clamped one is marked with <=', /<=800\.00/.test(text),
         'a refund run must not read an upper bound as an amount');
      fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('\nit really is read only');
    {
      const before = (await q(`SELECT COUNT(*)::int n FROM audit_events`)).rows[0].n;
      const wallets = (await q(`SELECT id, wallet_balance FROM investors WHERE id LIKE 'CHK-RC-%' ORDER BY id`)).rows;
      run(['--since', '2026-06-01', '--until', '2026-06-30']);
      const after = (await q(`SELECT COUNT(*)::int n FROM audit_events`)).rows[0].n;
      const wallets2 = (await q(`SELECT id, wallet_balance FROM investors WHERE id LIKE 'CHK-RC-%' ORDER BY id`)).rows;
      ok('it writes no audit rows of its own', before === after, `${before} → ${after}`);
      ok('and moves no money', JSON.stringify(wallets) === JSON.stringify(wallets2),
         JSON.stringify(wallets2));
      const src = fs.readFileSync(SCRIPT, 'utf8');
      ok('it opens a READ ONLY transaction', /SET TRANSACTION READ ONLY/.test(src));
      /* Comments blanked. The script's own header says "There is no --apply",
         and a raw scan reported that sentence as the thing it forbids — the same
         comment-versus-code trap as check-swallowed-errors. What matters is that
         no flag is read and no write statement exists. */
      const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      ok('there is no apply mode at all',
         !/--apply/.test(code) && !/\b(INSERT|UPDATE|DELETE)\s+(INTO\s+)?[a-z_]/i.test(code),
         'refunding is a decision, not a script');
      ok('and a statement timeout is set', /SET statement_timeout/.test(src));
    }

    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
    await cleanup().catch(() => {});
  } finally {
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
