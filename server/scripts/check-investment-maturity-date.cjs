#!/usr/bin/env node
/* An investment matures on the day its pool does.
 *
 * A pool is one contract with one end. It is closed out as a unit, its
 * achieved rate is posted on the POOL, and every rand in it earned that rate
 * over that period. So the maturity date on an investment is the pool's, not
 * a sum worked out from the day that particular investment happened to start.
 *
 * All three places that create investments worked it out the second way:
 *
 *     const end = new Date(start); end.setMonth(end.getMonth() + termMonths);
 *
 * Roll over on 1 November into a pool maturing 31 October and the new
 * investment is dated 1 November the following year — one day past the pool
 * it belongs to, on a date no close-out will ever land on. Three investments
 * in one cattle pool were carrying 01 Nov 2027, 31 Oct 2027 and 31 Oct 2027.
 *
 * It is not cosmetic. maturityCron selects work by investments.end_date, so a
 * pool closed as one unit matures in dribs across several nights, each
 * investment waiting on a nightly run its pool has already had — and the pool
 * reads matured while investments inside it are still active. That is what
 * made the October 2025 pool look as though it had not matured.
 *
 * Needs a database. The runner gives it one.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-investment-maturity-date.cjs
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
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CREATORS = {
  'server/jobs/maturityCron.js':                  'the maturity rollover',
  'server/jobs/recurringCron.js':                 'the recurring order',
  'server/services/walletFallbackReinvest.js':    'the wallet-fallback reinvestment',
};

console.log('\nthe rule is written once');
{
  const SRC = read('server/services/investmentTerm.js');
  ok('there is one definition of when an investment matures',
     /function investmentEndDate/.test(SRC));
  ok('and it prefers the pool’s own maturity date',
     /maturity_date/.test(SRC) && /if \(fromPool\) return fromPool/.test(SRC));
  ok('falling back to start plus term only when the pool has none',
     /setMonth\(d\.getMonth\(\) \+ \(Number\(termMonths\)/.test(SRC),
     'a pool with no maturity date must still produce an end date');
}

console.log('\nand every creator reads it from there');
{
  for (const [file, what] of Object.entries(CREATORS)) {
    const src = read(file);
    ok(`${what} uses it`, /investmentEndDate\(/.test(src));
    /* The old rule, which is what each of these did. Any creator still
       deriving its own end date is a creator that will drift again. */
    ok(`${what} no longer works the date out for itself`,
       !/setMonth\((?:endDate|end)\.getMonth\(\) \+/.test(src),
       'start + term is the rule this check exists to stop');
  }
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* ── Driven for real ────────────────────────────────────────────── */
const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

(async () => {
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.investments') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no investments table here'); return; }

    const clean = async () => {
      await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-MD-%'`);
      await db.query(`DELETE FROM investments  WHERE investor_id LIKE 'INV-MD-%' OR id LIKE 'INV-RI-%MD%'`);
      await db.query(`DELETE FROM investors    WHERE id LIKE 'INV-MD-%'`);
      await db.query(`DELETE FROM investment_pools WHERE id LIKE 'POOL-MD-%'`);
    };
    await clean();

    /* The pool being left: concluded yesterday, rate posted so the engine
       will actually pay rather than refuse. */
    await db.query(`
      INSERT INTO investment_pools
        (id, name, product_type, status, annual_rate, actual_rate, term_months,
         start_date, end_date, maturity_date, min_investment, current_invested, raised_amount)
      VALUES ('POOL-MD-OLD','Cattle - concluded','cattle','active',0.13,0.1317,12,
              CURRENT_DATE - 370, CURRENT_DATE - 2, CURRENT_DATE - 1, 1000, 100000, 100000)`);

    /* The pool being rolled into. Its maturity date is deliberately NOT
       today + 12 months — that gap is the whole test. */
    await db.query(`
      INSERT INTO investment_pools
        (id, name, product_type, status, annual_rate, actual_rate, term_months,
         start_date, end_date, maturity_date, min_investment, current_invested, raised_amount)
      VALUES ('POOL-MD-NEW','Cattle - open','cattle','open',0.13,0,12,
              CURRENT_DATE, CURRENT_DATE + 20, DATE '2027-10-31', 1000, 0, 0)`);

    await db.query(
      `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance, total_returns)
       VALUES ('INV-MD-ROLL','Roll','Over','inv-md-roll@example.test','active',0,0)`);
    await db.query(`
      INSERT INTO investments
        (id, investor_id, pool_id, pool_name, amount, status, start_date, end_date,
         annual_rate, term_months, expected_return, product_type,
         maturity_instruction, maturity_processed_at)
      VALUES ('INVST-INV-MD-ROLL','INV-MD-ROLL','POOL-MD-OLD','Cattle - concluded',
              100000,'active', CURRENT_DATE - 370, CURRENT_DATE - 1, 0.13, 12, 13000,
              'cattle','reinvest', NULL)`);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const { runMaturityProcessing } = require(path.join(ROOT, 'server', 'jobs', 'maturityCron.js'));
    await runMaturityProcessing();

    console.log('\na rollover lands on the pool it joins');
    const { rows } = await db.query(
      `SELECT id, pool_id, end_date::text AS end_date
         FROM investments
        WHERE investor_id = 'INV-MD-ROLL' AND is_reinvestment = true`);
    ok('the rollover was created', rows.length === 1, JSON.stringify(rows));
    const made = rows[0] || {};
    ok('into the open pool', made.pool_id === 'POOL-MD-NEW', made.pool_id);
    ok('maturing on the POOL’s date', made.end_date === '2027-10-31', made.end_date);

    /* The old rule would have produced today + 12 months. Naming it rather
       than merely asserting the right answer: if the two ever coincide, this
       check is passing by accident and should say so. */
    const wrong = new Date(); wrong.setMonth(wrong.getMonth() + 12);
    const wrongDay = wrong.toISOString().slice(0, 10);
    ok('and not on start-plus-term', made.end_date !== wrongDay,
       `start+term would have been ${wrongDay}`);
    ok('the two are actually different, so the test means something',
       wrongDay !== '2027-10-31',
       'the fixture dates have drifted together — move POOL-MD-NEW.maturity_date');

    console.log('\nand the whole pool matures on one night');
    const { rows: spread } = await db.query(
      `SELECT COUNT(DISTINCT i.end_date)::int AS days
         FROM investments i
         JOIN investment_pools p ON p.id = i.pool_id
        WHERE i.pool_id = 'POOL-MD-NEW' AND p.maturity_date IS NOT NULL`);
    ok('every investment in it shares one end date', spread[0].days <= 1,
       `${spread[0].days} different end dates in one pool`);

    await clean();
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
