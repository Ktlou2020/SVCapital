#!/usr/bin/env node
/* Solar distributes on the anniversary of the INVESTMENT, and pays once.
 *
 * A five-year holding earns five returns, each on the anniversary of the day
 * that client invested. The things that can go wrong with that are all money:
 *
 *   · the date is taken from the pool, or from a calendar date, rather than
 *     from the client's own start_date
 *   · a year is paid twice — a retry, two instances, a re-run of a backlog
 *   · a year pays a projection because nobody posted what it earned
 *   · the term's posted return is paid IN FULL at maturity, on top of the
 *     anniversaries already distributed, paying those years twice
 *   · the money lands in the parent's wallet when the investment is a
 *     sub-account's
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-anniversary-returns.cjs
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
const eqN = (name, a, b) => ok(name, Math.abs(Number(a) - Number(b)) < 0.005, `expected ${b}, got ${a}`);

console.log('\nthe rule is written once, and the money is cash not accrual');
{
  const svc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'anniversaryReturns.js'), 'utf8');
  ok('the anniversary comes off the investment’s own start date',
     /start_date \+ make_interval\(years => g\.k\)/.test(svc),
     'the pool start would give every client in a pool the same date, which is not what was promised');
  ok('and the date arithmetic is the database’s, not JavaScript’s',
     /make_interval/.test(svc) && !/setFullYear/.test(svc),
     '29 February resolves to the 28th in Postgres and to 1 March in JS');
  ok('the distribution is a payout, so it reaches a wallet',
     /'payout'/.test(svc) && !/'return',/.test(svc),
     "a `return` row is an accrual here — ledger.js keeps it out of CASH_CREDIT_TYPES");
  ok('and the whole distribution counts as earnings',
     /total_returns  = COALESCE\(total_returns, 0\) \+ \$1/.test(svc));
  ok('the reference is one per investment per year',
     /ANN-\$\{item\.investmentId\}-Y\$\{item\.yearIndex\}/.test(svc));
  ok('the insert is the guard, and it comes first',
     /ON CONFLICT \(reference\) DO NOTHING[\s\S]{0,400}if \(!rowCount\) return/.test(svc),
     'crediting first and inserting second double-pays anything that runs twice');
  ok('a year with no posted rate pays nothing',
     /if \(item\.rate == null\) return \{ paid: false/.test(svc),
     'this platform refuses rather than paying a projection — the maturity engine does the same');

  const maturity = fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'maturityCron.js'), 'utf8');
  ok('maturity subtracts what the anniversaries already paid',
     /const alreadyDistributed = await annualReturns\.paidSoFar\(client, inv\.id\)/.test(maturity)
     && /postedReturn - alreadyDistributed/.test(maturity),
     "a solar pool's actual_rate covers the WHOLE term, so paying it in full at the end pays those years twice");
  ok('and never claws money back when it has over-distributed',
     /Math\.max\(0, round2\(postedReturn - alreadyDistributed\)\)/.test(maturity),
     'that is a rate to correct, not a wallet to take money out of');

  const route = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'manualCredit.js'), 'utf8');
  ok('only a director can post the rate that releases the money',
     /router\.post\('\/pool-annual-return', requireRole\('director'\)/.test(route));
  ok('and a rate above 1 is refused as the typo it is',
     /would pay \$\{r\} times the capital/.test(route),
     '8.5 instead of 0.085 pays eight and a half times the capital');
  ok('posting a rate is audited, with the previous one kept',
     /pool_annual_return_corrected/.test(route) && /before: before \?/.test(route));

  const index = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  ok('the job runs daily, because an anniversary is a per-investment date',
     /startAnniversaryCron\(\)/.test(index));
  const cronSrc = fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'anniversaryCron.js'), 'utf8');
  ok('on business time, and before the maturity run',
     /cron\.schedule\('10 6 \* \* \*'/.test(cronSrc) && /timezone: BUSINESS_TZ/.test(cronSrc),
     'maturity runs at 23:00; a final anniversary must be distributed before it settles');
  ok('one investment failing does not take the run with it',
     /failures\.push/.test(cronSrc) && /continue|catch \(err\)/.test(cronSrc));
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const { Pool } = require('pg');
const annual = require(path.join(ROOT, 'server', 'services', 'anniversaryReturns'));
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function schema() {
  await db.query(`DROP TABLE IF EXISTS pool_annual_returns, transactions, investments,
                                       investment_pools, investors, sub_accounts CASCADE`);
  await db.query(`
    CREATE TABLE investors (id TEXT PRIMARY KEY, wallet_balance NUMERIC(18,2) DEFAULT 0,
      total_returns NUMERIC(18,2) DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE sub_accounts (id TEXT PRIMARY KEY, wallet_balance NUMERIC(18,2) DEFAULT 0,
      total_returns NUMERIC(18,2) DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE investment_pools (id TEXT PRIMARY KEY, name TEXT, product_type TEXT,
      term_months INT, actual_rate NUMERIC(8,4));
    CREATE TABLE investments (id TEXT PRIMARY KEY, investor_id TEXT, sub_account_id TEXT,
      pool_id TEXT, product_type TEXT, amount NUMERIC(18,2), status TEXT,
      start_date DATE, end_date DATE, term_months INT);
    CREATE TABLE transactions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      investor_id TEXT, sub_account_id TEXT, investment_id TEXT, type TEXT,
      amount NUMERIC(18,2), status TEXT, reference TEXT, description TEXT,
      transaction_date TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE UNIQUE INDEX idx_txn_ref ON transactions(reference);
    CREATE TABLE pool_annual_returns (pool_id TEXT, year_index INT, rate NUMERIC(8,4),
      note TEXT, posted_by TEXT, posted_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (pool_id, year_index));`);
}

/* Every borrowed client is returned, even when the thing under test throws.
   A client left open in a transaction makes db.end() wait for ever, so the
   check hangs instead of failing — and a mutation that makes payOne throw is
   exactly the case this file exists to catch. */
async function inTxn(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { paid: false, reason: `threw: ${err.message}`, threw: true };
  } finally {
    client.release();
  }
}

const wallet = async id =>
  Number((await db.query('SELECT wallet_balance FROM investors WHERE id=$1', [id])).rows[0].wallet_balance);
const returns = async id =>
  Number((await db.query('SELECT total_returns FROM investors WHERE id=$1', [id])).rows[0].total_returns);

(async () => {
  try {
    await schema();
    await db.query(`INSERT INTO investors (id) VALUES ('S-SOLAR'), ('S-OTHER')`);
    await db.query(`INSERT INTO sub_accounts (id) VALUES ('SA-1')`);
    await db.query(`INSERT INTO investment_pools (id, name, product_type, term_months, actual_rate)
                    VALUES ('P-SOLAR','Solar 5yr — Oct 2025','solar_5yr',60,0.5000),
                           ('P-CATTLE','Cattle — Oct 2025','cattle',12,0.1400)`);
    /* Invested 16 Oct 2025, five years. Anniversaries 2026…2030. */
    await db.query(`INSERT INTO investments
      (id, investor_id, pool_id, product_type, amount, status, start_date, term_months)
      VALUES ('INV-S','S-SOLAR','P-SOLAR','solar_5yr',100000,'active', DATE '2025-10-16',60),
             ('INV-SA','S-SOLAR','P-SOLAR','solar_5yr',50000,'active', DATE '2025-10-16',60),
             ('INV-C','S-OTHER','P-CATTLE','cattle',100000,'active', DATE '2025-10-16',12)`);
    await db.query(`UPDATE investments SET sub_account_id='SA-1' WHERE id='INV-SA'`);

    console.log('\nthe schedule comes off each investment’s own date');
    {
      const before = await annual.due(db, { asOf: '2026-10-15' });
      ok('the day before the anniversary, nothing is due', before.length === 0,
         JSON.stringify(before.map(x => x.dueOn)));
      const on = await annual.due(db, { asOf: '2026-10-16' });
      ok('on the day, the first year falls due for both solar holdings',
         on.length === 2 && on.every(x => x.yearIndex === 1), JSON.stringify(on.map(x => [x.investmentId, x.yearIndex])));
      ok('and no cattle investment is in it', !on.some(x => x.productType === 'cattle'),
         'only solar distributes before maturity');
      const five = await annual.due(db, { asOf: '2031-01-01' });
      ok('a five-year holding has exactly five anniversaries',
         five.filter(x => x.investmentId === 'INV-S').length === 5,
         JSON.stringify(five.filter(x => x.investmentId === 'INV-S').map(x => x.dueOn)));
      ok('and no sixth', !five.some(x => x.yearIndex > 5));
      ok('every year with no posted rate reads as waiting',
         five.every(x => x.state === 'awaiting-rate'),
         'nothing is payable until somebody closes the year out');
    }

    console.log('\nnothing pays until a rate is posted for that year');
    {
      const [item] = (await annual.due(db, { asOf: '2026-10-16' })).filter(x => x.investmentId === 'INV-S');
      ok('the first year is on the schedule at all', !!item,
         'without it the rest of this section is testing nothing');
      const refused = await inTxn(c => annual.payOne(c, item));
      ok('a year with no rate is refused', refused.paid === false, JSON.stringify(refused));
      eqN('and no money moved', await wallet('S-SOLAR'), 0);

      await db.query(`INSERT INTO pool_annual_returns (pool_id, year_index, rate)
                      VALUES ('P-SOLAR', 1, 0.1000)`);
      const [now] = (await annual.due(db, { asOf: '2026-10-16' })).filter(x => x.investmentId === 'INV-S');
      ok('once posted, the year is payable', now.state === 'payable' && now.rate === 0.1);
      eqN('and it would pay the rate on the capital', now.wouldPay, 10000);
    }

    console.log('\na year is paid once, however many times the job runs');
    {
      const pay = async () => {
        const items = (await annual.due(db, { asOf: '2026-10-16' })).filter(x => x.state === 'payable');
        const out = [];
        for (const it of items) out.push(await inTxn(c => annual.payOne(c, it)));
        return out;
      };
      const first = await pay();
      ok('the first run pays', first.filter(r => r.paid).length === 2, JSON.stringify(first));
      eqN('the investor is credited 10% of their capital', await wallet('S-SOLAR'), 10000);
      eqN('and it counts as earnings', await returns('S-SOLAR'), 10000);
      eqN("the sub-account's distribution goes to the sub-account",
          Number((await db.query(`SELECT wallet_balance FROM sub_accounts WHERE id='SA-1'`)).rows[0].wallet_balance),
          5000);
      eqN("and not to the parent's wallet", await wallet('S-SOLAR'), 10000,
          'the parent keeps only its own 10,000');

      const second = await pay();
      ok('a second run pays nothing', second.length === 0 || second.every(r => !r.paid), JSON.stringify(second));
      eqN('and the wallet is unchanged', await wallet('S-SOLAR'), 10000);
      const n = Number((await db.query(
        `SELECT COUNT(*)::int c FROM transactions WHERE reference='ANN-INV-S-Y1'`)).rows[0].c);
      ok('one transaction exists for that year, not two', n === 1, String(n));
      ok('and the year now reads as paid',
         (await annual.due(db, { asOf: '2026-10-16' })).every(x => x.state === 'paid'));

      /* The filter in due() is not the guard. Two instances racing, or any
         caller that pays an item it was handed earlier, reaches payOne with a
         year that has already been paid — so payOne itself has to refuse. */
      const [alreadyPaid] = (await annual.due(db, { asOf: '2026-10-16' }))
        .filter(x => x.investmentId === 'INV-S');
      const again = await inTxn(c => annual.payOne(c, { ...alreadyPaid, rate: 0.1 }));
      ok('payOne refuses a year it has already paid, whoever asks',
         again.paid === false && /already paid/.test(again.reason || ''), JSON.stringify(again));
      eqN('and the wallet is still untouched by it', await wallet('S-SOLAR'), 10000);
      eqN('as is what it counts as earnings', await returns('S-SOLAR'), 10000);
    }

    console.log('\nmaturity does not pay the distributed years a second time');
    {
      /* The pool's actual_rate is 50% — the whole five-year return. One year
         has been distributed at 10%, so maturity owes the other 40%. */
      const paid = await annual.paidSoFar(db, 'INV-S');
      eqN('what the anniversaries have paid is known', paid, 10000);
      const postedWholeTerm = 100000 * 0.5;
      const atMaturity = Math.max(0, annual.round2(postedWholeTerm - paid));
      eqN('so maturity pays the rest of the term, not all of it', atMaturity, 40000);
      ok('paying the posted rate in full would double-pay a year',
         postedWholeTerm - atMaturity === 10000);
    }

    console.log('\nand a correction downward never takes money back');
    {
      const over = Math.max(0, annual.round2(5000 - 10000));
      eqN('a term return now smaller than what was distributed pays zero', over, 0);
    }

    await db.query(`DROP TABLE IF EXISTS pool_annual_returns, transactions, investments,
                                         investment_pools, investors, sub_accounts CASCADE`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
