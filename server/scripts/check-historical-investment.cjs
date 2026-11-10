#!/usr/bin/env node
/* Recording an investment that already happened must not make it happen again.
 *
 * The real investment route protects a client whose money is about to move:
 * it demands a signed agreement, checks the wallet, debits it, charges the 1%
 * fee, overwrites the maturity with the pool's, and emails the client. Every
 * one of those is wrong when staff are recording history, so this service does
 * none of them — and that is exactly why it needs holding down. A tool that
 * writes money onto the books by hand with the safeguards removed is only safe
 * if what replaced them is asserted.
 *
 * THE ONE THAT WOULD HAVE COST MONEY. A backdated holding whose maturity has
 * passed is, to the nightly engine, indistinguishable from one that matured
 * last night:
 *
 *   maturityCron  WHERE status = 'active' AND end_date <= NOW()
 *   payoutCron    WHERE status = 'matured' AND maturity_instruction IN (…)
 *                   AND maturity_processed_at IS NULL
 *
 * So a holding settled in March, recorded today, would be settled AGAIN
 * tonight. The service writes 'matured' WITH maturity_processed_at set, which
 * is what takes it out of both. Writing 'matured' alone is NOT enough —
 * payoutCron keys on the stamp.
 *
 * This check therefore RUNS BOTH JOBS against a row the service wrote and
 * asserts neither moved a cent. A grep for the column name would pass against
 * a service that wrote the stamp into the wrong row, or wrote it as NULL, or
 * wrote the status and not the stamp. Running them cannot.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-historical-investment.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_hinv_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool, dbUrl, hist;

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  dbUrl = withDatabase(process.env.DATABASE_URL, DB_NAME);
  process.env.DATABASE_URL = dbUrl;
  for (const m of ['server/db/pool.js', 'server/db/setup.js']) {
    delete require.cache[require.resolve(path.join(ROOT, m))];
  }
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  pool = new Pool({ connectionString: dbUrl, ssl: SSL, max: 4 });
  pool.on('error', () => {});
  hist = require(path.join(ROOT, 'server', 'services', 'historicalInvestment.js'));
}

const iso = d => d.toISOString().slice(0, 10);
const daysAgo = n => iso(new Date(Date.now() - n * 86400000));
const daysAhead = n => iso(new Date(Date.now() + n * 86400000));

/* A pool whose own maturity has passed, and a client holding money in their
   wallet. The wallet figure is the one that must not move. */
async function seed() {
  await pool.query(`
    INSERT INTO investment_pools (id, name, product_type, status, annual_rate,
                                  term_months, start_date, end_date, maturity_date,
                                  raised_amount, current_invested)
    VALUES ('P-HIST','Short Term Investment','short_term','matured',0.0800,5,
            $1::date, $2::date, $3::date, 0, 0)`,
    [daysAgo(400), daysAgo(395), daysAgo(245)]);
  await pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
    VALUES ('H-1','Thabo','Molefe','h1@x.test','active', 1234.56),
           ('H-2','Nomsa','Dube','h2@x.test','active', 0)`);
  await pool.query(`
    INSERT INTO sub_accounts (id, parent_investor_id, name, account_type, wallet_balance)
    VALUES ('SA-H1','H-1','Burial Society','group', 0),
           ('SA-H2','H-2','Other Group','group', 0)`);
}

const ACTOR = { id: null, email: 'chk@x.test', role: 'admin' };

(async () => {
  try {
    await makeDatabase();
    await seed();

    /* ── The preview ────────────────────────────────────────────────── */
    console.log('\nthe preview says what it would do, and writes nothing');
    {
      const before = (await pool.query(`SELECT count(*)::int AS n FROM investments`)).rows[0].n;
      const s = await hist.survey(pool, {
        poolId: 'P-HIST',
        records: [{ investorId: 'H-1', amount: 50000, startDate: daysAgo(395) }],
      });
      const after = (await pool.query(`SELECT count(*)::int AS n FROM investments`)).rows[0].n;
      ok('nothing was written by the preview', before === after, `${before} → ${after}`);
      ok('it plans the one record', s.totals.willWrite === 1, JSON.stringify(s.totals));
      ok('the maturity is derived from the pool term', s.plan[0].endDate === hist._addMonths(daysAgo(395), 5),
         s.plan[0].endDate);
      ok('and because that maturity has passed it is marked settled',
         s.plan[0].settled === true && s.plan[0].status === 'matured',
         JSON.stringify({ s: s.plan[0].status, settled: s.plan[0].settled }));
      ok('with the stamp that keeps the payout job off it',
         s.plan[0].maturityProcessedAt === s.plan[0].endDate,
         String(s.plan[0].maturityProcessedAt));
      /* The sentence somebody needs who is about to press Apply. */
      ok('and it states plainly what it will not do',
         s.willNot.join('|').includes('debit any wallet')
         && s.willNot.join('|').includes('charge a platform fee')
         && s.willNot.join('|').includes('email anybody'),
         JSON.stringify(s.willNot));
      ok('the contracted return is computed, not invented',
         Math.abs(s.plan[0].expectedReturn - 50000 * 0.08 * (5 / 12)) < 0.01,
         String(s.plan[0].expectedReturn));
      ok('and actual_return is left at zero, because nothing here knows it',
         s.plan[0].actualReturn === 0, String(s.plan[0].actualReturn));
    }

    /* ── What it refuses ────────────────────────────────────────────── */
    console.log('\nand it refuses what it cannot honestly record');
    {
      const s = await hist.survey(pool, {
        poolId: 'P-HIST',
        records: [
          { investorId: 'H-1', amount: 1000, startDate: daysAhead(5) },
          { investorId: 'NOBODY', amount: 1000, startDate: daysAgo(10) },
          { investorId: 'H-1', amount: 0, startDate: daysAgo(10) },
          { investorId: 'H-1', amount: 1000, startDate: 'not-a-date' },
          /* A sub-account belonging to somebody else. Recording a group's
             holding against the wrong parent is how a stokvel's money ends up
             reported as a person's. */
          { investorId: 'H-1', amount: 1000, startDate: daysAgo(10), subAccountId: 'SA-H2' },
          { investorId: 'H-1', amount: 1000, startDate: daysAgo(10), endDate: daysAgo(20) },
        ],
      });
      ok('all six are refused and none planned',
         s.refusals.length === 6 && s.totals.willWrite === 0,
         JSON.stringify(s.refusals));
      const why = s.refusals.map(r => r.reason).join(' | ');
      ok('a future start date is refused as a typo', /in the future/.test(why), why);
      ok('an unknown account is refused', /No client/.test(why), why);
      ok('a zero amount is refused', /more than zero/.test(why), why);
      ok('a maturity before the start is refused', /before the start date/.test(why), why);
      ok("and another client's sub-account is refused",
         /does not belong to that client/.test(why), why);
    }

    /* ── The write ──────────────────────────────────────────────────── */
    console.log('\nand what it writes is the holding, and only the holding');
    let invId;
    {
      const walletBefore = (await pool.query(
        `SELECT wallet_balance FROM investors WHERE id = 'H-1'`)).rows[0].wallet_balance;
      const s = await hist.survey(pool, {
        poolId: 'P-HIST',
        records: [{ investorId: 'H-1', amount: 50000, startDate: daysAgo(395) }],
      });
      const out = await hist.execute(pool, { survey: s, actor: ACTOR });
      ok('one investment is written', out.written === 1, JSON.stringify(out));
      invId = out.investments[0].id;

      const { rows: [row] } = await pool.query(`SELECT * FROM investments WHERE id = $1`, [invId]);
      ok('it is in the pool that was chosen', row.pool_id === 'P-HIST', row.pool_id);
      ok('for the amount and the date given',
         Number(row.amount) === 50000 && row.start_date.toISOString().slice(0, 10) === daysAgo(395),
         JSON.stringify({ a: row.amount, d: row.start_date }));
      ok('its status is matured', row.status === 'matured', row.status);
      ok('and maturity_processed_at is set to the maturity it actually had',
         row.maturity_processed_at
         && row.maturity_processed_at.toISOString().slice(0, 10) === hist._addMonths(daysAgo(395), 5),
         String(row.maturity_processed_at));
      /* created_at is the start date, not now: several reports group by
         COALESCE(start_date, created_at), and a row stamped today would file a
         holding from last year under this month's new business. */
      ok('created_at is the start date, not today',
         row.created_at.toISOString().slice(0, 10) === daysAgo(395),
         String(row.created_at));

      const walletAfter = (await pool.query(
        `SELECT wallet_balance FROM investors WHERE id = 'H-1'`)).rows[0].wallet_balance;
      ok('THE WALLET WAS NOT TOUCHED',
         String(walletBefore) === String(walletAfter),
         `${walletBefore} → ${walletAfter} — the money left months ago; taking it again is the whole risk`);

      const { rows: fees } = await pool.query(
        `SELECT * FROM transactions WHERE investor_id = 'H-1' AND type IN ('fee','platform_fee')`);
      ok('and no platform fee was charged', fees.length === 0, JSON.stringify(fees));

      const { rows: txns } = await pool.query(
        `SELECT * FROM transactions WHERE investor_id = 'H-1'`);
      ok('and no ledger row at all, because none was asked for',
         txns.length === 0, JSON.stringify(txns));

      const { rows: [p] } = await pool.query(
        `SELECT raised_amount, current_invested, investor_count FROM investment_pools WHERE id = 'P-HIST'`);
      ok('the pool\'s own counters include it, because the holding was real',
         Number(p.raised_amount) === 50000 && Number(p.current_invested) === 50000
         && p.investor_count === 1, JSON.stringify(p));

      const { rows: [a] } = await pool.query(
        `SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1`, [invId]);
      ok('and a staff member adding money by hand is on the audit log',
         a.n === 1, JSON.stringify(a));
    }

    /* ── THE ONE THAT WOULD HAVE PAID TWICE ─────────────────────────── */
    console.log('\nand the nightly engine leaves it alone — both halves of it');
    {
      /* The instruction that makes payoutCron want it. Without this the job
         would skip the row for a reason that has nothing to do with the stamp,
         and this check would pass while testing nothing. */
      await pool.query(
        `UPDATE investments SET maturity_instruction = 'payout_all' WHERE id = $1`, [invId]);

      const snap = async () => (await pool.query(`
        SELECT (SELECT wallet_balance FROM investors WHERE id = 'H-1') AS wallet,
               (SELECT count(*)::int FROM transactions) AS txns,
               (SELECT count(*)::int FROM investments)  AS invs,
               (SELECT status FROM investments WHERE id = $1) AS status`, [invId])).rows[0];

      const before = await snap();
      ok('the row is exactly what the payout job hunts for, bar the stamp',
         before.status === 'matured',
         'if it were not, the next two assertions would prove nothing');

      const { runMaturityProcessing } = require(path.join(ROOT, 'server', 'jobs', 'maturityCron.js'));
      const { runPayoutProcessing }   = require(path.join(ROOT, 'server', 'jobs', 'payoutCron.js'));
      const quiet = console.log; console.log = () => {};
      try { await runMaturityProcessing(); await runPayoutProcessing(); }
      finally { console.log = quiet; }

      const after = await snap();
      ok('maturityCron and payoutCron both ran',
         true, 'the assertions below are about what they did, not whether they ran');
      ok('THE WALLET WAS NOT CREDITED A SECOND TIME',
         String(before.wallet) === String(after.wallet),
         `${before.wallet} → ${after.wallet} — this holding was settled months ago`);
      ok('no payout transaction was written',
         before.txns === after.txns, `${before.txns} → ${after.txns}`);
      ok('and it was not rolled over into a new investment',
         before.invs === after.invs, `${before.invs} → ${after.invs}`);

      /* And the stamp is why. Clear it and the same job pays — so the
         assertions above are about the stamp and not about some other
         accident of the fixture. */
      await pool.query(
        `UPDATE investments SET maturity_processed_at = NULL WHERE id = $1`, [invId]);
      const quiet2 = console.log; console.log = () => {};
      try { await runPayoutProcessing(); } finally { console.log = quiet2; }
      const paid = await snap();
      ok('and with the stamp removed the very same job DOES pay it',
         String(paid.wallet) !== String(after.wallet),
         `${after.wallet} → ${paid.wallet} — if this did not change, the check above `
         + 'was passing for the wrong reason');
    }

    /* ── Idempotence ────────────────────────────────────────────────── */
    console.log('\nand pressing Apply twice records it once');
    {
      const s = await hist.survey(pool, {
        poolId: 'P-HIST',
        records: [{ investorId: 'H-1', amount: 50000, startDate: daysAgo(395) }],
      });
      ok('the second preview sees it is already there',
         s.totals.alreadyRecorded === 1 && s.totals.willWrite === 0,
         JSON.stringify(s.totals));
      let threw = null;
      try { await hist.execute(pool, { survey: s, actor: ACTOR }); }
      catch (e) { threw = e.message; }
      ok('and applying it refuses rather than duplicating',
         /nothing left to record/i.test(threw || ''), String(threw));
    }

    /* ── A holding still running ────────────────────────────────────── */
    console.log('\nand one that has not matured yet is left running');
    {
      const s = await hist.survey(pool, {
        poolId: 'P-HIST',
        records: [{ investorId: 'H-2', amount: 10000, startDate: daysAgo(30), termMonths: 12 }],
      });
      ok('it is planned as active', s.plan[0].status === 'active', s.plan[0].status);
      ok('and carries no stamp, so the engine will settle it when its day comes',
         s.plan[0].maturityProcessedAt === null, String(s.plan[0].maturityProcessedAt));
      await hist.execute(pool, { survey: s, actor: ACTOR });
      const { rows: [row] } = await pool.query(
        `SELECT status, maturity_processed_at, end_date FROM investments
          WHERE investor_id = 'H-2'`);
      ok('as written', row.status === 'active' && row.maturity_processed_at === null,
         JSON.stringify(row));
    }

    /* ── The optional ledger row ────────────────────────────────────── */
    console.log('\nand the matching ledger debit is written only when asked for');
    {
      const s = await hist.survey(pool, {
        poolId: 'P-HIST', ledger: true,
        records: [{ investorId: 'H-2', amount: 7500, startDate: daysAgo(100), termMonths: 12 }],
      });
      ok('the preview says the debit is part of the plan', s.plan[0].ledgerRow === true);
      const out = await hist.execute(pool, { survey: s, actor: ACTOR });
      const { rows: [t] } = await pool.query(
        `SELECT * FROM transactions WHERE investment_id = $1`, [out.investments[0].id]);
      ok('a transaction is written', !!t, 'none found');
      ok('as an investment debit, which is what makes the wallet tie to its history',
         t && t.type === 'investment' && Number(t.amount) === 7500,
         JSON.stringify(t && { type: t.type, amount: t.amount }));
      /* Dated to when the money moved, not to when it was typed — otherwise
         it lands in this month's statement instead of the one it belongs to. */
      ok('dated to the day the money moved, not today',
         t && t.transaction_date.toISOString().slice(0, 10) === daysAgo(100),
         String(t && t.transaction_date));
      ok('and tied back to the investment and the pool',
         t && t.investment_id === out.investments[0].id && t.pool_id === 'P-HIST',
         JSON.stringify(t && { i: t.investment_id, p: t.pool_id }));

      const wallet = (await pool.query(
        `SELECT wallet_balance FROM investors WHERE id = 'H-2'`)).rows[0].wallet_balance;
      ok('and even with the debit written, the wallet still did not move',
         Number(wallet) === 0, String(wallet));
    }

    /* ── The safeguards it does without ─────────────────────────────── */
    console.log('\nand it never reaches for the things the live route needs');
    {
      const src = require('fs')
        .readFileSync(path.join(ROOT, 'server', 'services', 'historicalInvestment.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      /* An email about an investment from last year is alarming, and the live
         route sends it fire-and-forget, so nothing can stop it once written. */
      ok('it does not send email', !/emailService|sendInvestment/.test(src),
         'the live route emails the client — here that notice is about history');
      ok('and it does not move a wallet balance',
         !/wallet_balance\s*=/.test(src),
         'the only safe wallet write in this service is none');
      ok('and it does not write a fee',
         !/platform_fee|'fee'/.test(src));
    }
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (pool) await pool.end().catch(() => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
