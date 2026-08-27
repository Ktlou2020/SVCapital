#!/usr/bin/env node
/* switch_amount — switch a named amount into another product, reinvest the rest.
 *
 * The only instruction that splits a maturity across TWO products. That makes
 * it the only one that calls reinvestAmount twice inside one transaction, and
 * that is where it can go wrong quietly:
 *
 *   · transactions.reference carries a UNIQUE index and the REINV- insert has
 *     no ON CONFLICT clause. Two undifferentiated legs throw on the second,
 *     roll the whole maturity back, and leave maturity_processed_at NULL — the
 *     investment retried every night forever, its pool never marked matured.
 *     Nothing logs an error a person would see.
 *
 *   · The new investment id derives from Date.now(). Two calls in the same
 *     millisecond collide on the primary key, same outcome.
 *
 * Both are asserted against the real engine, not a transcription of it.
 *
 * Also asserted: both legs are fee-free (the reason the instruction exists —
 * paying the balance out and re-investing it would cost the client 1%), the
 * degenerate amounts do not write empty investments, and the pre-flight sizes
 * BOTH halves rather than reporting one target and staying silent on the other.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-switch-amount.cjs
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
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

function isScratchDatabase(url) {
  const n = (String(url).split('?')[0].split('/').pop() || '').toLowerCase();
  return /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(n) || /^svctest/.test(n);
}
async function ensureSchema() {
  const { rows } = await pool.query(
    `SELECT bool_and(to_regclass('public.' || t) IS NOT NULL) AS ready FROM unnest($1::text[]) AS t`,
    [['investors', 'investments', 'investment_pools', 'transactions']]);
  if (rows[0].ready) return true;
  if (!isScratchDatabase(process.env.DATABASE_URL) && process.env.CHECK_ALLOW_RESET !== '1') {
    console.log('  SKIP  incomplete schema and this is not a scratch database.');
    return false;
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  return true;
}

const wipe = async () => {
  await pool.query(`DELETE FROM transactions     WHERE investor_id LIKE 'SW-%'`);
  await pool.query(`DELETE FROM investments      WHERE investor_id LIKE 'SW-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'SWP-%'`);
  await pool.query(`DELETE FROM investors        WHERE id LIKE 'SW-%'`);
};

/* One matured cattle investment with a switch_amount instruction, plus an open
   pool for each product so both legs have somewhere to land. */
async function seed({ custom, switchTo = 'short_term', openBike = true, openCattle = true }) {
  await wipe();
  await pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
    VALUES ('SW-A','Sipho','Ndlovu','sipho@example.test','active', 0)`);

  if (openCattle) {
    await pool.query(`
      INSERT INTO investment_pools (id, name, product_type, status, end_date, annual_rate, term_months, current_invested, max_investment)
      VALUES ('SWP-CAT-NEW','Cattle Investment - August 2026','cattle','open', CURRENT_DATE + 30, 0.16, 12, 0, NULL)`);
  }
  if (openBike) {
    await pool.query(`
      INSERT INTO investment_pools (id, name, product_type, status, end_date, annual_rate, term_months, current_invested, max_investment)
      VALUES ('SWP-ST-NEW','Short Term Investment - August 2026',$1,'open', CURRENT_DATE + 30, 0.12, 6, 0, NULL)`, [switchTo]);
  }
  // The maturing pool: rate posted, so the engine pays rather than holding back.
  await pool.query(`
    INSERT INTO investment_pools (id, name, product_type, status, end_date, annual_rate, actual_rate, term_months)
    VALUES ('SWP-OLD','Cattle Investment - August 2025','cattle','active', CURRENT_DATE, 0.16, 0.10, 12)`);
  await pool.query(`
    INSERT INTO investments (id, investor_id, pool_id, pool_name, amount, status, start_date, end_date,
        annual_rate, term_months, expected_return, actual_return, product_type,
        maturity_instruction, custom_payout_amount, switch_product_type)
    VALUES ('SW-IV','SW-A','SWP-OLD','Cattle Investment - August 2025', 100000,'active',
            CURRENT_DATE - 360, CURRENT_DATE, 0.16, 12, 99999, 0, 'cattle',
            'switch_amount', $1, $2)`, [custom, switchTo]);
}

const legs = async () => (await pool.query(
  `SELECT id, pool_id, product_type, amount FROM investments
    WHERE investor_id = 'SW-A' AND is_reinvestment = true ORDER BY amount DESC`)).rows;

(async () => {
  try {
    if (!await ensureSchema()) { await pool.end(); process.exit(0); }

    /* ── The engine actually splits ───────────────────────────────── */
    console.log('\na named amount switches, the balance stays put');
    // R100,000 at a posted 10% = R110,000 gross. Switch R40,000, reinvest R70,000.
    await seed({ custom: 40000 });
    process.env.DATABASE_URL = process.env.DATABASE_URL;
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'jobs', 'maturityCron.js'))];
    const cron = require(path.join(ROOT, 'server', 'jobs', 'maturityCron.js'));
    const quiet = console.log; console.log = () => {};
    try { await cron.runMaturityProcessing(); } finally { console.log = quiet; }

    {
      const rows = await legs();
      ok('two investments are created, not one', rows.length === 2,
         JSON.stringify(rows.map(r => [r.product_type, r.amount])));
      const sw = rows.find(r => r.product_type === 'short_term');
      const re = rows.find(r => r.product_type === 'cattle');
      ok('the switched leg carries the named amount', sw && round2(sw.amount) === 40000,
         sw ? `got ${sw.amount}` : 'no short_term leg');
      ok('the balance reinvests into the original product', re && round2(re.amount) === 70000,
         re ? `got ${re.amount}` : 'no cattle leg');
      ok('the two legs land in different pools',
         sw && re && sw.pool_id === 'SWP-ST-NEW' && re.pool_id === 'SWP-CAT-NEW',
         sw && re ? `${sw.pool_id} / ${re.pool_id}` : 'legs missing');

      const { rows: [inv] } = await pool.query(
        `SELECT status, maturity_processed_at FROM investments WHERE id = 'SW-IV'`);
      ok('the maturity is marked processed — it will not run again',
         inv.status === 'matured' && inv.maturity_processed_at !== null,
         JSON.stringify(inv));
    }

    /* ── The collision that would have been silent ─────────────────── */
    console.log('\ntwo legs from one investment do not collide');
    {
      const { rows } = await pool.query(
        `SELECT reference, COUNT(*)::int n FROM transactions
          WHERE investor_id = 'SW-A' GROUP BY reference HAVING COUNT(*) > 1`);
      ok('no two transactions share a reference', rows.length === 0, JSON.stringify(rows));

      const refs = (await pool.query(
        `SELECT reference FROM transactions WHERE investor_id = 'SW-A' AND reference LIKE 'REINV-%'`)).rows;
      ok('both rollovers wrote their own REINV row', refs.length === 2,
         JSON.stringify(refs.map(r => r.reference)));

      const ids = (await legs()).map(r => r.id);
      ok('the two new investments have distinct ids', new Set(ids).size === 2, JSON.stringify(ids));
    }

    /* ── Fee-free, which is the whole point ───────────────────────── */
    console.log('\nboth legs are fee-free');
    {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(ABS(amount)),0)::float AS fees FROM transactions
          WHERE investor_id = 'SW-A' AND (type ILIKE '%fee%' OR reference ILIKE '%FEE%')`);
      ok('no platform fee is charged on either leg', Number(rows[0].fees) === 0,
         `fees totalling ${rows[0].fees} — a split must not cost what a rollover does not`);

      const { rows: [w] } = await pool.query(`SELECT wallet_balance::float w FROM investors WHERE id = 'SW-A'`);
      ok('and nothing is paid to the wallet', Number(w.w) === 0,
         `wallet moved to ${w.w} — the balance should reinvest, not pay out`);
    }

    /* ── Degenerate amounts ───────────────────────────────────────── */
    console.log('\nthe edges do not write empty investments');
    await seed({ custom: 110000 });                    // exactly the gross
    {
      const q2 = console.log; console.log = () => {};
      try { await cron.runMaturityProcessing(); } finally { console.log = q2; }
      const rows = await legs();
      ok('switching the whole amount makes one investment, not one plus a zero',
         rows.length === 1 && round2(rows[0].amount) === 110000,
         JSON.stringify(rows.map(r => [r.product_type, r.amount])));
      ok('and it is the switched product', rows[0] && rows[0].product_type === 'short_term',
         rows[0] ? rows[0].product_type : 'none');
    }

    await seed({ custom: 0.0 });                       // nothing to switch
    {
      const q3 = console.log; console.log = () => {};
      try { await cron.runMaturityProcessing(); } finally { console.log = q3; }
      const rows = await legs();
      ok('switching nothing reinvests the whole amount where it is',
         rows.length === 1 && rows[0].product_type === 'cattle' && round2(rows[0].amount) === 110000,
         JSON.stringify(rows.map(r => [r.product_type, r.amount])));
    }

    /* ── The pre-flight must see both halves ──────────────────────── */
    console.log('\nthe pre-flight reports both destinations');
    const pf = require(path.join(ROOT, 'server', 'services', 'maturityPreflight.js'));
    {
      const m = { maturity_instruction: 'switch_amount', product_type: 'cattle',
                  switch_product_type: 'short_term', custom_payout_amount: 40000 };
      const targets = pf.targetProductTypes(m);
      ok('both product types are named', targets.length === 2 &&
         targets.includes('cattle') && targets.includes('short_term'), JSON.stringify(targets));
      ok('the switch half is sized at the named amount',
         pf.legShare(m, 'short_term', 110000) === 40000, String(pf.legShare(m, 'short_term', 110000)));
      ok('the reinvest half at the balance',
         pf.legShare(m, 'cattle', 110000) === 70000, String(pf.legShare(m, 'cattle', 110000)));
      ok('and the halves sum to the gross rather than double-counting it',
         pf.legShare(m, 'short_term', 110000) + pf.legShare(m, 'cattle', 110000) === 110000);

      const same = { ...m, switch_product_type: 'cattle' };
      ok('a switch to its own product is one destination, sized once',
         pf.targetProductTypes(same).length === 1 && pf.legShare(same, 'cattle', 110000) === 110000);

      // Every other instruction keeps its single target and full size.
      const plain = { maturity_instruction: 'reinvest', product_type: 'cattle' };
      ok('other instructions are unchanged',
         pf.targetProductTypes(plain).length === 1 && pf.legShare(plain, 'cattle', 110000) === 110000);
    }

    console.log('\nthe pre-flight names a client whose half has nowhere to go');
    await seed({ custom: 40000, openCattle: false });   // switch lands; balance does not
    {
      const res = await pf.runMaturityPreflight(pool, { horizonDays: 3 });
      const mine = res.affected.filter(a => a.investorId === 'SW-A' && a.issue === 'rollover_to_wallet');
      ok('the half with no open pool is flagged', mine.length === 1, JSON.stringify(mine));
      ok('and it names which half', mine[0] && /half of a split/.test(mine[0].detail),
         mine[0] ? mine[0].detail : 'not reported');
      ok('while the half that does have a pool is not flagged',
         !mine.some(a => a.targetProductType === 'short_term'), JSON.stringify(mine.map(a => a.targetProductType)));
    }

    /* ── Validation refuses the incoherent combinations ───────────── */
    console.log('\nthe instruction is rejected without its companion fields');
    {
      const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'investments.js'), 'utf8');
      ok('switch_amount is accepted by the server', /VALID_INSTRUCTIONS[^\n]*switch_amount/.test(src));
      ok('it requires an amount', /NEEDS_AMOUNT[^\n]*switch_amount/.test(src));
      ok('it requires a target product', /NEEDS_PRODUCT[^\n]*switch_amount/.test(src));
      ok('and the error calls it a switch amount, not a payout',
         /amountNoun/.test(src) && /'switch amount'/.test(src),
         'a switch amount described as a payout invites the opposite of the intent');
    }

    console.log('\nthe form does not mislabel the amount');
    {
      const adm = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      ok('the dropdown offers it', /value="switch_amount"/.test(adm));
      ok('the amount field appears for it', /ADM_NEEDS_AMOUNT[\s\S]{0,80}switch_amount/.test(adm));
      ok('the product field too', /ADM_NEEDS_PRODUCT[\s\S]{0,80}switch_amount/.test(adm));
      ok('and the label says switch rather than pay out',
         /Amount to switch \(R\)/.test(adm));

      const portalSrc = fs.readFileSync(path.join(ROOT, 'portal', 'js', 'portal.js'), 'utf8');
      ok('the client sees a label, not the raw key',
         /switch_amount:'Switch \+ Reinvest'/.test(portalSrc) && /custom_switch:'Payout \+ Switch'/.test(portalSrc));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, err.stack);
    fail++;
  } finally {
    await wipe().catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
