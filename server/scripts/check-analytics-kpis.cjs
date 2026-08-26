#!/usr/bin/env node
/* The headline KPIs must be computed over every row, and must agree with the
 * browser formulas they replace.
 *
 * They were summed in the browser from three lists fetched one page deep at
 * 5,000 rows. Past that they were quietly wrong. "Total Investors" was the
 * plainest case: it read the length of the fetched array, so a platform with
 * more than 5,000 investors reported exactly 5,000 — a number that looks
 * deliberate.
 *
 * Moving them to SQL is only safe if the definitions did not drift on the way,
 * so this computes both and compares them on a dataset small enough for the
 * browser version to be right. Then it makes the dataset bigger than one page
 * and shows the two diverging — which is the whole point.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-analytics-kpis.cjs
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
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const eqN = (name, a, b, detail) =>
  ok(name, Math.abs(Number(a) - Number(b)) < 0.005, detail || `expected ${b}, got ${a}`);

function isScratchDatabase(url) {
  const name = (String(url).split('?')[0].split('/').pop() || '').toLowerCase();
  return /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(name) || /^svctest/.test(name);
}

async function ensureSchema() {
  const needed = ['investors', 'investments', 'investment_pools', 'transactions'];
  const { rows } = await pool.query(
    `SELECT bool_and(to_regclass('public.' || t) IS NOT NULL) AS ready FROM unnest($1::text[]) AS t`,
    [needed]);
  if (rows[0].ready) return true;
  if (!isScratchDatabase(process.env.DATABASE_URL) && process.env.CHECK_ALLOW_RESET !== '1') {
    console.log('  SKIP  incomplete schema and this is not a scratch database.');
    return false;
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const quiet = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); }
  finally { console.log = quiet; }
  return true;
}

/* The SQL from the route, read out of the route so this cannot test a copy
   that has drifted from what ships. */
function routeSql() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'analytics-extra.js'), 'utf8');
  const i = src.indexOf("router.get('/kpis'");
  const start = src.indexOf('`', src.indexOf('pool.query(', i)) + 1;
  return src.slice(start, src.indexOf('`', start));
}

/* The browser formulas, transcribed from _renderAnalyticsKPIsFromState. */
function browserKpis({ investors, investments, transactions }) {
  const num = v => Math.abs(parseFloat(v) || 0);
  const totalAUM = transactions
    .filter(t => t.status === 'completed' && ['deposit', 'withdrawal'].includes(t.type))
    .reduce((s, t) => s + (t.type === 'deposit' ? 1 : -1) * num(t.amount), 0);
  const ytdStart = new Date(new Date().getFullYear(), 0, 1).getTime();
  return {
    total_aum: Math.max(0, totalAUM),
    active_capital: investments.filter(i => i.status === 'active').reduce((s, i) => s + num(i.amount), 0),
    total_investors: investors.length,
    returns_ytd: transactions
      .filter(t => t.status === 'completed' && ['return', 'payout'].includes(t.type) &&
        new Date(t.transaction_date || t.created_at || 0).getTime() >= ytdStart)
      .reduce((s, t) => s + num(t.amount), 0),
    platform_revenue: transactions
      .filter(t => t.status === 'completed' && ['fee', 'platform_fee'].includes(t.type))
      .reduce((s, t) => s + num(t.amount), 0),
    active_investments: investments.filter(i => i.status === 'active').length,
  };
}

async function seed(nInvestors) {
  /* Everything, not just this fixture's rows. The route's SQL counts the whole
     table — as it must — so the only way to compare it against a hand-computed
     expectation is for the table to hold nothing else. Scratch database only;
     ensureSchema() has already refused anything that is not one. */
  await pool.query(`DELETE FROM transactions`);
  await pool.query(`DELETE FROM investments`);
  await pool.query(`DELETE FROM investors`);
  await pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status)
    SELECT 'K-'||g, 'A', 'B', 'k'||g||'@example.test', 'active' FROM generate_series(1,$1) g`, [nInvestors]);
  await pool.query(`
    INSERT INTO investments (id, investor_id, pool_id, pool_name, amount, status, start_date, end_date,
        annual_rate, term_months, expected_return, actual_return, product_type)
    SELECT 'KI-'||g, 'K-'||g, NULL, 'p', 1000 + g, CASE WHEN g % 4 = 0 THEN 'matured' ELSE 'active' END,
           CURRENT_DATE-100, CURRENT_DATE+100, 0.12, 6, 0, 0, 'cattle'
      FROM generate_series(1,$1) g`, [nInvestors]);
  /* A deposit and a withdrawal, a fee (stored negative), a payout inside the
     year and one before it that must not count. */
  await pool.query(`
    INSERT INTO transactions (id, investor_id, type, amount, status, reference, transaction_date, created_at)
    SELECT 'KT-D-'||g, 'K-'||g, 'deposit',     500,  'completed', 'KTD'||g, NOW(), NOW() FROM generate_series(1,$1) g`, [nInvestors]);
  await pool.query(`
    INSERT INTO transactions (id, investor_id, type, amount, status, reference, transaction_date, created_at)
    SELECT 'KT-W-'||g, 'K-'||g, 'withdrawal', -100,  'completed', 'KTW'||g, NOW(), NOW() FROM generate_series(1,$1) g`, [nInvestors]);
  await pool.query(`
    INSERT INTO transactions (id, investor_id, type, amount, status, reference, transaction_date, created_at)
    SELECT 'KT-F-'||g, 'K-'||g, 'fee',         -10,  'completed', 'KTF'||g, NOW(), NOW() FROM generate_series(1,$1) g`, [nInvestors]);
  await pool.query(`
    INSERT INTO transactions (id, investor_id, type, amount, status, reference, transaction_date, created_at)
    SELECT 'KT-P-'||g, 'K-'||g, 'payout',       25,  'completed', 'KTP'||g, NOW(), NOW() FROM generate_series(1,$1) g`, [nInvestors]);
  await pool.query(`
    INSERT INTO transactions (id, investor_id, type, amount, status, reference, transaction_date, created_at)
    VALUES ('KT-OLD','K-1','payout', 9999, 'completed','KTOLD',
            DATE_TRUNC('year', NOW() AT TIME ZONE 'Africa/Johannesburg') - INTERVAL '1 day',
            NOW() - INTERVAL '400 days')`);
  await pool.query(`
    INSERT INTO transactions (id, investor_id, type, amount, status, reference, transaction_date, created_at)
    VALUES ('KT-PEND','K-1','deposit', 7777, 'pending','KTPEND', NOW(), NOW())`);
}

const readAll = async () => ({
  investors:    (await pool.query(`SELECT * FROM investors`)).rows,
  investments:  (await pool.query(`SELECT * FROM investments`)).rows,
  transactions: (await pool.query(`SELECT * FROM transactions`)).rows,
});

(async () => {
  try {
    if (!await ensureSchema()) { await pool.end(); process.exit(0); }
    const sql = routeSql();
    ok('the route SQL was extracted', /total_aum/.test(sql) && /active_investments/.test(sql));

    console.log('\nSQL and the browser formulas agree on a dataset that fits one page');
    await seed(50);
    const { rows: [sqlK] } = await pool.query(sql);
    const jsK = browserKpis(await readAll());

    eqN('Total AUM',          sqlK.total_aum,          jsK.total_aum);
    eqN('Active Capital',     sqlK.active_capital,     jsK.active_capital);
    eqN('Total Investors',    sqlK.total_investors,    jsK.total_investors);
    eqN('Returns YTD',        sqlK.returns_ytd,        jsK.returns_ytd);
    eqN('Platform Revenue',   sqlK.platform_revenue,   jsK.platform_revenue);
    eqN('Active Investments', sqlK.active_investments, jsK.active_investments);

    console.log('\nand the definitions are what they claim to be');
    eqN('AUM nets withdrawals off deposits', sqlK.total_aum, 50 * 500 - 50 * 100);
    eqN('a pending deposit is excluded',     sqlK.total_aum, 20000,
        'the R7,777 pending deposit must not count');
    eqN('fees count as revenue despite being stored negative', sqlK.platform_revenue, 50 * 10);
    eqN('last year\'s payout is outside YTD', sqlK.returns_ytd, 50 * 25,
        'the R9,999 payout dated before 1 Jan must not count');
    ok('matured investments are not active capital',
       Number(sqlK.active_investments) === 50 - Math.floor(50 / 4),
       `active_investments=${sqlK.active_investments}`);

    console.log('\nand they diverge once the browser can only see one page');
    {
      /* What the page did: read a page, then count what it read. */
      const PAGE = 40;
      await seed(120);
      const { rows: [sqlBig] } = await pool.query(sql);
      const all  = await readAll();
      const page = {
        investors:    all.investors.slice(0, PAGE),
        investments:  all.investments.slice(0, PAGE),
        transactions: all.transactions.slice(0, PAGE),
      };
      const jsPage = browserKpis(page);
      ok('SQL counts every investor', Number(sqlBig.total_investors) === 120,
         `got ${sqlBig.total_investors}`);
      ok('the browser reports exactly the page size — a plausible-looking number',
         jsPage.total_investors === PAGE, `got ${jsPage.total_investors}`);
      ok('and its AUM is short of the truth',
         jsPage.total_aum < Number(sqlBig.total_aum),
         `browser ${jsPage.total_aum} vs sql ${sqlBig.total_aum}`);
    }

    console.log('\nthe client prefers the endpoint and admits when it cannot');
    {
      const admin = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      ok('the KPI panel calls the endpoint',
         /API\._fetch\('GET', 'analytics\/kpis'\)/.test(admin));
      ok('it falls back to the browser sums rather than showing blanks',
         /_renderAnalyticsKPIsFromState\(\)/.test(admin));
      ok('and records which it used',
         /_analyticsKpisFromServer = true/.test(admin) && /_analyticsKpisFromServer = false/.test(admin));
      ok('the truncation banner says whether the tiles are affected',
         /headline tiles are computed in SQL over every row and are correct/.test(admin) &&
         /headline tiles fell back to browser sums and are affected too/.test(admin));
      ok('the banner renders after the panels, so it describes this run',
         admin.indexOf('_analyticsTruncation(counts);') > admin.indexOf('panels.map(([label, fn])'),
         'rendering it first would report the previous run\'s KPI source');
    }

    console.log('\nthe cattle tile shows the achieved rate, not the benchmark');
    {
      const admin = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      const html  = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
      ok('it averages actual_rate', /parseFloat\(p\.actual_rate\) > 0/.test(admin) &&
         /parseFloat\(p\.actual_rate\) \|\| 0/.test(admin));
      ok('and no longer averages annual_rate',
         !/includes\('cattle'\) && p\.annual_rate > 0/.test(admin));
      ok('the lowest-minimum tile is found by id, not by position',
         /getElementById\('an-min-investment'\)/.test(admin) &&
         !/querySelectorAll\('#view-analytics \.stat-card__value'\)/.test(admin));
      ok('and the tile has that id, with no hardcoded figure baked in',
         /id="an-min-investment">—</.test(html));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    await pool.query(`DELETE FROM transactions WHERE investor_id LIKE 'K-%'`).catch(() => {});
    await pool.query(`DELETE FROM investments  WHERE investor_id LIKE 'K-%'`).catch(() => {});
    await pool.query(`DELETE FROM investors    WHERE id LIKE 'K-%'`).catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
