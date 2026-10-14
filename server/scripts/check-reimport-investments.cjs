#!/usr/bin/env node
/* Re-importing one product's investments must insert only what is absent.
 *
 * The fault being repaired is quiet: the console importer read an
 * investment's product from `inv.product?.name`, which is undefined in every
 * audit export because `product` is a path string, so every investment landed
 * as 'other'. A product page then shows nothing and the investments look lost
 * when they are merely filed wrong.
 *
 * That makes two failure modes for a re-import, and the dangerous one is the
 * second:
 *   1. the investment really is absent          → insert it
 *   2. the investment is there, labelled wrong  → an insert is a NO-OP
 * Treating (2) as (1) reports success and changes nothing, which is how you
 * come to believe a product is fixed when it is not. So they are classified
 * apart, and each has its own flag.
 *
 * Also proved here: the survey writes nothing, a pool or investor that is not
 * in the database blocks its record rather than being invented, the same
 * investment under a different id is not inserted twice, another product in
 * the same file is left alone, total_invested is not touched, and a second run
 * does nothing.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-reimport-investments.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ROOT   = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ── The half that needs no database ─────────────────────────────── */
console.log('\nboth importers resolve the product from the path, not a name that is never there');
{
  const route = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'migrate.js'), 'utf8');
  const cli   = fs.readFileSync(path.join(ROOT, 'server', 'scripts', 'migrate-from-firebase.js'), 'utf8');
  for (const [what, src] of [['the console importer', route], ['the CLI importer', cli]]) {
    ok(`${what} no longer keys product_type off inv.product?.name`,
       !/PRODUCT_TYPE_MAP\[inv\.product\?\.name\]/.test(src),
       '`product` is "investmentProducts/<id>" in every export, so that is always undefined');
    ok(`${what} resolves the product id out of the path`,
       /function resolveInvestmentProductType/.test(src)
       && /resolveInvestmentProductType\(inv\)/.test(src));
    ok(`${what} falls back to the pool path, which carries the same id`,
       /PRODUCT_ID_MAP\[productId\(inv\.pool\)\]/.test(src),
       'a record with no product field still names its product in the pool path');
  }
  ok('re-uploading the export can correct a label it got wrong',
     /product_type = CASE WHEN EXCLUDED\.product_type = 'other'/.test(route),
     'without this, a second upload skips the row it mislabelled the first time');
  ok('but an unresolved product never overwrites a real one',
     /THEN investments\.product_type/.test(route));
  const runner = fs.readFileSync(path.join(ROOT, 'server', 'scripts', 'reimport-product-investments.cjs'), 'utf8');
  ok('the runner closes the pool the audit service writes through',
     /if \(auditUsed\) await require\(path\.join\(__dirname, '\.\.', 'db', 'pool'\)\)\.end/.test(runner),
     'its idle connections hold the event loop open for 30s, so the script looks hung after it has finished');
  ok('and the fields that arrive empty without the pools file are not overwritten',
     !/pool_name=EXCLUDED\.pool_name/.test(route) && !/annual_rate=EXCLUDED\.annual_rate/.test(route),
     'an investments-only upload would blank the rate and the pool name');
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL — see the header of this file');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const { execFileSync } = require('child_process');
const { Pool } = require('pg');
const RUNNER = path.join(__dirname, 'reimport-product-investments.cjs');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

function isScratchDatabase(url) {
  const n = (String(url).split('?')[0].split('/').pop() || '').toLowerCase();
  return /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(n) || /^svctest/.test(n);
}
async function ensureSchema() {
  const { rows } = await pool.query(
    `SELECT bool_and(to_regclass('public.' || t) IS NOT NULL) AS ready FROM unnest($1::text[]) AS t`,
    [['investors', 'investments', 'investment_pools', 'audit_events']]);
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

/* The three solar product ids the exports use, and one cattle id, so the
   product filter is exercised with the real keys rather than invented ones. */
const SOLAR = 'xKQkwQMa0Hnj0dAmGsWH';
const CATTLE = 'gSjiuqRg3E8IEO2hwfmu';
const P1 = 'RIPOOL1', P2 = 'RIPOOL2', PGHOST = 'RIGHOST';
const EXPORT = path.join(os.tmpdir(), `svc-check-reimport-${process.pid}.json`);

const rec = (o) => Object.assign({
  user: 'users/whatever', status: 'ACTIVE', reinvestment: false, fee: 0,
}, o);

const RECORDS = [
  rec({ _id: 'RI-NEW1', userAccountNumber: 'RI-A', investedAmount: 10027.5,
        product: `investmentProducts/${SOLAR}`, pool: `investmentProducts/${SOLAR}/investmentPools/${P1}`,
        txRef: 'RI-A/NEW001', dateInvested: '2025-10-16T15:47:51.781Z',
        fees: { financialServicesFee: 105, managementFee: 367.5, submitedAmount: 10500 } }),
  rec({ _id: 'RI-NEW2', userAccountNumber: 'RI-B', investedAmount: 19100,
        product: `investmentProducts/${SOLAR}`, pool: `investmentProducts/${SOLAR}/investmentPools/${P2}`,
        txRef: 'RI-B/NEW002', dateInvested: '2025-10-30T18:49:25.396Z',
        maturityInstruction: { instruction: 'REINVEST', reinvestAmount: 19100 } }),
  /* already there, correctly labelled */
  rec({ _id: 'RI-EXISTS', userAccountNumber: 'RI-A', investedAmount: 5000,
        product: `investmentProducts/${SOLAR}`, pool: `investmentProducts/${SOLAR}/investmentPools/${P1}`,
        txRef: 'RI-A/EX', dateInvested: '2025-09-01T00:00:00.000Z' }),
  /* already there, labelled 'other' — the actual fault */
  rec({ _id: 'RI-MISLABEL', userAccountNumber: 'RI-A', investedAmount: 7000,
        product: `investmentProducts/${SOLAR}`, pool: `investmentProducts/${SOLAR}/investmentPools/${P1}`,
        txRef: 'RI-A/MIS', dateInvested: '2025-09-02T00:00:00.000Z' }),
  /* the same investment as a hand-entered row with a different id */
  rec({ _id: 'RI-TWIN', userAccountNumber: 'RI-B', investedAmount: 3300,
        product: `investmentProducts/${SOLAR}`, pool: `investmentProducts/${SOLAR}/investmentPools/${P1}`,
        txRef: 'RI-B/TWIN', dateInvested: '2025-09-03T00:00:00.000Z' }),
  /* blocked: the pool is not in the database */
  rec({ _id: 'RI-NOPOOL', userAccountNumber: 'RI-A', investedAmount: 1234.56,
        product: `investmentProducts/${SOLAR}`, pool: `investmentProducts/${SOLAR}/investmentPools/${PGHOST}`,
        txRef: 'RI-A/NOPOOL', dateInvested: '2025-10-01T00:00:00.000Z' }),
  /* blocked: the investor is not in the database */
  rec({ _id: 'RI-NOINV', userAccountNumber: 'RI-GHOST', investedAmount: 999,
        product: `investmentProducts/${SOLAR}`, pool: `investmentProducts/${SOLAR}/investmentPools/${P1}`,
        txRef: 'RI-GHOST/X', dateInvested: '2025-10-02T00:00:00.000Z' }),
  /* another product entirely, in the same file */
  rec({ _id: 'RI-CATTLE', userAccountNumber: 'RI-A', investedAmount: 40000,
        product: `investmentProducts/${CATTLE}`, pool: `investmentProducts/${CATTLE}/investmentPools/${P1}`,
        txRef: 'RI-A/COW', dateInvested: '2025-10-03T00:00:00.000Z' }),
];

const wipe = async () => {
  await pool.query(`DELETE FROM audit_events WHERE user_email = 'check-reimport'`);
  await pool.query(`DELETE FROM investments WHERE investor_id LIKE 'RI-%' OR id LIKE 'INV-MIGR-RI-%' OR id LIKE 'RI-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'POOL-MIGR-RI%'`);
  await pool.query(`DELETE FROM investors WHERE id LIKE 'RI-%'`);
};

async function seed() {
  await wipe();
  await pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, total_invested)
    VALUES ('RI-A','Thabo','Nkosi','ri-a@example.test','active', 22027.50),
           ('RI-B','Lerato','Dube','ri-b@example.test','active', 22400.00)`);
  await pool.query(`
    INSERT INTO investment_pools (id, name, product_type, status, actual_rate, annual_rate,
                                  term_months, maturity_date, end_date)
    VALUES ('POOL-MIGR-${P1}','Solar Investment - 7 Years - Oct 2025','solar','active',
            0.1400, 0.1400, 84, DATE '2032-10-16', DATE '2032-10-16'),
           ('POOL-MIGR-${P2}','Solar Investment - 6 Years - Oct 2025','other','active',
            0.1250, 0.1250, 72, DATE '2031-10-30', DATE '2031-10-30')`);
  await pool.query(`
    INSERT INTO investments (id, investor_id, pool_id, pool_name, amount, status, start_date,
                             end_date, annual_rate, term_months, expected_return, actual_return, product_type)
    VALUES ('INV-MIGR-RI-EXISTS','RI-A','POOL-MIGR-${P1}','Solar Investment - 7 Years - Oct 2025',
            5000,'active', DATE '2025-09-01', DATE '2032-10-16', 0.14, 84, 700, 0, 'solar'),
           ('INV-MIGR-RI-MISLABEL','RI-A','POOL-MIGR-${P1}','Solar Investment - 7 Years - Oct 2025',
            7000,'active', DATE '2025-09-02', DATE '2032-10-16', 0.14, 84, 980, 0, 'other'),
           ('RI-HAND-ENTERED','RI-B','POOL-MIGR-${P1}','Solar Investment - 7 Years - Oct 2025',
            3300,'active', DATE '2025-09-03', DATE '2032-10-16', 0.14, 84, 462, 0, 'solar')`);
  fs.writeFileSync(EXPORT, JSON.stringify(RECORDS, null, 1));
}

const run = args => {
  try {
    return execFileSync('node', [RUNNER, '--file', EXPORT, '--product', 'solar', ...args],
      { env: { ...process.env, IMPORT_ACTOR: 'check-reimport' }, encoding: 'utf8' });
  } catch (err) { return (err.stdout || '') + (err.stderr || ''); }
};
const state = async () => {
  const { rows } = await pool.query(`
    SELECT (SELECT COUNT(*)::int FROM investments WHERE investor_id LIKE 'RI-%') AS rows,
           (SELECT COUNT(*)::int FROM investments WHERE investor_id LIKE 'RI-%' AND product_type='solar') AS solar,
           (SELECT COUNT(*)::int FROM investments WHERE investor_id LIKE 'RI-%' AND product_type='other') AS other,
           (SELECT COUNT(*)::int FROM investments WHERE investor_id LIKE 'RI-%' AND product_type='cattle') AS cattle,
           (SELECT COUNT(*)::int FROM audit_events WHERE user_email='check-reimport') AS audits,
           (SELECT COALESCE(SUM(total_invested),0) FROM investors WHERE id LIKE 'RI-%') AS stored_total`);
  return rows[0];
};

(async () => {
  try {
    if (!(await ensureSchema())) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
    await seed();

    console.log('\nthe survey classifies every record and writes nothing');
    const before = await state();
    const survey = run([]);
    const after  = await state();
    ok('nothing was written', after.rows === before.rows && after.audits === 0
       && String(after.stored_total) === String(before.stored_total),
       JSON.stringify({ before, after }));
    ok('it counts the file by product before filtering', /solar/.test(survey) && /cattle/.test(survey),
       'a --product the file has nothing for is a typo worth seeing');
    ok('the two absent records are named as absent',
       /absent from the database/.test(survey) && /NEW001/.test(survey) && /NEW002/.test(survey));
    ok('the row that exists under another product is named as a relabel, not an insert',
       /to be relabelled/.test(survey) && /INV-MIGR-RI-MISLABEL currently "other"/.test(survey),
       'inserting it would be a no-op and would report success');
    ok('the record already there under a different id is skipped, not inserted',
       /already there under a different id/.test(survey),
       'same investor, pool, amount and date — inserting it again doubles a client’s holding');
    ok('a record whose pool is absent is blocked rather than guessed at',
       /its pool is not in the database/.test(survey) && /NOPOOL/.test(survey),
       'the rate, maturity and term would all be invented, and a client is shown them');
    ok('a record whose investor is absent is blocked', /its investor is not in the database/.test(survey));
    ok('the pool that is itself mislabelled is called out separately',
       new RegExp(`POOL-MIGR-${P2}`).test(survey) && /Rollovers match on product_type alone/.test(survey),
       'relabelling investments leaves the pool’s own rollovers broken');
    ok('total_invested is reconciled rather than adjusted',
       /stored    rows now   rows after/.test(survey) && /Nothing here is written/.test(survey),
       'the original migration summed the whole export, so these amounts are probably already in it');
    ok('and it says what each flag would do', /--apply/.test(survey) && /--fix-product-type/.test(survey));

    console.log('\n--apply inserts only what is absent');
    const applied = run(['--apply']);
    const s1 = await state();
    ok('exactly the two absent records were inserted', s1.rows === before.rows + 2,
       `${before.rows} → ${s1.rows}: ${applied.slice(-400)}`);
    ok('and the mislabelled row is still mislabelled', s1.other === 1,
       '--apply and --fix-product-type are separate decisions');
    ok('the other product in the same file was not imported',
       s1.cattle === 0
       && (await pool.query(`SELECT COUNT(*)::int n FROM investments WHERE id='INV-MIGR-RI-CATTLE'`)).rows[0].n === 0,
       'checking only that nothing is labelled cattle would pass if it were imported AS solar');
    ok('investors.total_invested was not touched',
       String(s1.stored_total) === String(before.stored_total),
       'the original migration already counted these — adding them again double-counts');

    const { rows: [n1] } = await pool.query(
      `SELECT * FROM investments WHERE id = 'INV-MIGR-RI-NEW1'`);
    ok('the insert carries the pool’s own name, rate, term and maturity',
       !!n1 && n1.pool_name === 'Solar Investment - 7 Years - Oct 2025'
       && Number(n1.annual_rate) === 0.14 && n1.term_months === 84
       && n1.end_date && new Date(n1.end_date).toISOString().slice(0, 10) === '2032-10-16',
       n1 ? JSON.stringify({ pool_name: n1.pool_name, rate: n1.annual_rate, term: n1.term_months, end: n1.end_date }) : 'not inserted');
    ok('it is labelled with the product that was asked for', !!n1 && n1.product_type === 'solar');
    ok('the amount is the net amount that reached the pool', !!n1 && Number(n1.amount) === 10027.50);
    ok('expected_return is computed off that amount and the pool rate',
       !!n1 && Number(n1.expected_return) === 1403.85, n1 && String(n1.expected_return));
    ok('start_date is the date of the original investment',
       !!n1 && new Date(n1.start_date).toISOString().slice(0, 10) === '2025-10-16');
    ok('the notes say where the row came from, and what the client actually paid',
       !!n1 && /RI-NEW1/.test(n1.notes) && /RI-A\/NEW001/.test(n1.notes)
       && /R10,500\.00/.test(n1.notes) && /R10,027\.50 into the pool/.test(n1.notes),
       n1 && n1.notes);
    const { rows: [n2] } = await pool.query(
      `SELECT maturity_instruction, is_reinvestment, pool_id FROM investments WHERE id = 'INV-MIGR-RI-NEW2'`);
    ok('a maturity instruction in the export is carried across, normalised',
       !!n2 && n2.maturity_instruction === 'reinvest', n2 && n2.maturity_instruction);
    ok('and it is inserted into the pool it belongs to even when that pool is mislabelled',
       !!n2 && n2.pool_id === `POOL-MIGR-${P2}`);

    console.log('\n--fix-product-type relabels what is already there');
    await run(['--fix-product-type']);
    const s2 = await state();
    ok('the mislabelled row now carries the product', s2.other === 0 && s2.solar === s2.rows,
       JSON.stringify(s2));
    ok('and the hand-entered row that was already right is untouched',
       (await pool.query(`SELECT product_type FROM investments WHERE id='RI-HAND-ENTERED'`)).rows[0].product_type === 'solar');

    console.log('\nevery write leaves a record, and a second run makes none');
    const { rows: actions } = await pool.query(
      `SELECT event_type, COUNT(*)::int n FROM audit_events
        WHERE user_email='check-reimport' GROUP BY event_type ORDER BY event_type`);
    const byAction = Object.fromEntries(actions.map(a => [a.event_type, a.n]));
    ok('each inserted investment is audited', byAction.investment_reimported === 2, JSON.stringify(byAction));
    ok('each relabelled investment is audited', byAction.investment_product_type_corrected === 1, JSON.stringify(byAction));
    ok('and the run itself is audited', byAction.product_investments_reimported === 2,
       'one per writing run — the survey writes none');

    const s3 = await state();
    const again = run(['--apply', '--fix-product-type']);
    const s4 = await state();
    ok('a second run inserts nothing and relabels nothing',
       s4.rows === s3.rows && s4.solar === s3.solar && s4.other === 0,
       JSON.stringify({ s3, s4 }));
    ok('and says so rather than reporting work it did not do',
       /0 inserted · 0 relabelled/.test(again), again.slice(-300));
    ok('no per-investment audit row is written for a run that wrote nothing',
       (await pool.query(`SELECT COUNT(*)::int n FROM audit_events
          WHERE user_email='check-reimport' AND event_type='investment_reimported'`)).rows[0].n === 2);

    console.log('\nit refuses rather than half-running');
    const noArgs = (() => { try {
      return execFileSync('node', [RUNNER], { env: { ...process.env }, encoding: 'utf8' });
    } catch (e) { return (e.stdout || '') + (e.stderr || ''); } })();
    ok('without --file and --product it does nothing and says what it needs',
       /required/.test(noArgs));
    const wrongProduct = (() => { try {
      return execFileSync('node', [RUNNER, '--file', EXPORT, '--product', 'sollar'],
        { env: { ...process.env }, encoding: 'utf8' });
    } catch (e) { return (e.stdout || '') + (e.stderr || ''); } })();
    ok('a product the file holds nothing for is reported, not treated as finished',
       /Nothing in this file maps to product_type "sollar"/.test(wrongProduct));
    ok('and the file’s real products are listed beside it', /solar/.test(wrongProduct));

    await wipe();
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    fs.existsSync(EXPORT) && fs.unlinkSync(EXPORT);
    await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
