#!/usr/bin/env node
/* The report that says which maturities went to a wallet, and whether the
 * money is still there.
 *
 * reinvestAmount picks the rollover target on product_type alone. An
 * investment carrying a type no pool uses matches nothing, so the money is
 * credited to the wallet under reference MAT-FALLBACK-<id> instead of being
 * reinvested. 57 maturities went that way on 30 September 2026.
 *
 * The figure that decides what can be done about it cannot be read off any
 * maturity report: whether the WALLET STILL HOLDS the money. A client who has
 * spent or withdrawn since cannot be rolled over without going negative. That
 * is what this report leads with, and what these assertions are mostly about.
 *
 * Two things it must not get wrong:
 *
 *   · investments.payout_option carries a column DEFAULT of 'reinvest', so
 *     every row has it whether or not a client chose anything. Reading it
 *     reports every maturity as a full reinvest and answers "which of these
 *     had no instruction" wrongly. Only maturity_instruction may be consulted.
 *
 *   · it is a REPORT. If it ever writes, it is not one.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-wallet-fallback-audit.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SVC   = read('server/services/walletFallbackAudit.js');
const ROUTE = read('server/routes/manualCredit.js');
const HTML  = read('admin/index.html');
const ADMIN = read('admin/js/admin.js');
const CLI   = read('server/scripts/audit-maturity-wallet-fallbacks.cjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

console.log('\nit is a report, and only a report');
{
  ok('the service writes nothing',
     !/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/.test(strip(SVC)),
     'a report that writes is not a report');
  ok('and says so where somebody would look', /READ-ONLY/.test(SVC));
  ok('the panel tells the operator the same thing',
     /Read-only &mdash; changes nothing|Read-only — changes nothing/
       .test(HTML.slice(HTML.indexOf('Matured Into Wallets'), HTML.indexOf('Matured Into Wallets') + 400)));
}

console.log('\nonly an admin can run it');
{
  ok('the endpoint exists', /router\.get\('\/maturity-wallet-fallbacks'/.test(ROUTE));
  ok('and sits behind the admin/director guard on this router',
     /router\.use\(requireAuth, requireRole\('admin', 'director'\)\)/.test(ROUTE),
     'the route carries no guard of its own, so the router-level one has to be there');
  const before = ROUTE.indexOf("router.use(requireAuth");
  const at     = ROUTE.indexOf("router.get('/maturity-wallet-fallbacks'");
  ok('and is declared after it', before > -1 && at > before, `guard at ${before}, route at ${at}`);
}

console.log('\nthe console and the command line read the same module');
{
  ok('the endpoint calls the shared service',
     /require\('\.\.\/services\/walletFallbackAudit'\)/.test(ROUTE));
  ok('and the CLI audit points at it too',
     /walletFallbackAudit/.test(CLI),
     'two copies of these queries would describe the same money differently');
}

console.log('\nthe question it answers is the right one');
{
  const code = strip(SVC);
  ok('it decides "full reinvest" on maturity_instruction', /maturity_instruction/.test(code));
  ok('and never on payout_option',
     !/payout_option/.test(code),
     'that column DEFAULTs to reinvest and would report every row as one');
  ok('a blank instruction counts as a reinvest',
     /FULL_REINVEST = new Set\(\[[^\]]*''/.test(code),
     'a blank instruction already defaults to reinvest in the engine');
  ok('it reports whether the wallet still holds the money',
     /wallet_holds_it/.test(code) && /shortfall/.test(code));
  ok('per ACCOUNT, not per credit',
     /sub_account_id \? `sa:/.test(code),
     'an investor with two credits has to cover both to be movable');
  ok('it knows what has already been corrected',
     /REINV-FIX-/.test(code),
     'the correction script writes that reference; a corrected row must not be offered again');
  ok('and derives where each type would roll into',
     /rolloverTargets/.test(code) && /status = 'open'/.test(code));
  ok('on the business day, like the cycler',
     /AT TIME ZONE 'Africa\/Johannesburg'/.test(code),
     'a pool that closed today must not be offered after the UTC date rolls');
}

console.log('\nthe panel is wired up');
{
  ok('the panel is on the page', /Matured Into Wallets/.test(HTML));
  ok('with a Run button bound to the runner', /onclick="runWalletFallbackAudit\(this\)"/.test(HTML));
  ok('and a CSV export', /_wfaExportCsv\(\)/.test(HTML) && /function _wfaExportCsv/.test(ADMIN));
  ok('the runner calls the endpoint',
     /admin\/maturity-wallet-fallbacks/.test(ADMIN));
  ok('it leads with what can actually be put back',
     /Can be put back/.test(ADMIN) && /Wallet spent/.test(ADMIN));
  ok('and names the ones that asked for something else',
     /other than a full reinvest/.test(ADMIN));
  ok('the console JS was re-stamped',
     (() => {
       const m = HTML.match(/js\/admin\.js\?v=(\d+)/);
       return !!m && Number(m[1]) >= 186;
     })(), 'a stamped asset is cached for a year');
}

/* ── Against a database ────────────────────────────────────────────── */
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\n  (skipping the database half — DATABASE_URL not set)');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  const { Pool } = require('pg');
  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  const { runWalletFallbackAudit } = require(path.join(ROOT, 'server', 'services', 'walletFallbackAudit.js'));
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});
    const wipe = async () => {
      await db.query(`DELETE FROM transactions     WHERE investor_id LIKE 'WFA-%'`);
      await db.query(`DELETE FROM investments      WHERE id LIKE 'WFA-%'`);
      await db.query(`DELETE FROM investors        WHERE id LIKE 'WFA-%'`);
      await db.query(`DELETE FROM investment_pools WHERE id LIKE 'WFA-%'`);
    };
    await wipe();
    await db.query(`
      INSERT INTO investment_pools (id,name,product_type,status,annual_rate,term_months,start_date,end_date,min_investment,target_amount,current_invested)
      VALUES ('WFA-SRC','April','other','active',0.12,5,CURRENT_DATE-150,CURRENT_DATE-1,1000,2000000,0),
             ('WFA-TGT','October','short_term','open',0.12,5,CURRENT_DATE-1,CURRENT_DATE+29,1000,5000000,0)`);
    await db.query(`
      INSERT INTO investors (id,first_name,last_name,email,wallet_balance,status) VALUES
        ('WFA-1','Has','It','1@e.com',10000,'active'),
        ('WFA-2','Spent','It','2@e.com',    5,'active'),
        ('WFA-3','Wants','Switch','3@e.com',9000,'active'),
        ('WFA-4','No','Instruction','4@e.com',4000,'active')`);
    await db.query(`
      INSERT INTO investments (id,investor_id,pool_id,pool_name,product_type,amount,status,maturity_instruction,start_date,end_date) VALUES
        ('WFA-A','WFA-1','WFA-SRC','April','other',10000,'matured','reinvest',      CURRENT_DATE-150,CURRENT_DATE-1),
        ('WFA-B','WFA-2','WFA-SRC','April','other', 8000,'matured','reinvest',      CURRENT_DATE-150,CURRENT_DATE-1),
        ('WFA-C','WFA-3','WFA-SRC','April','other', 9000,'matured','switch_product',CURRENT_DATE-150,CURRENT_DATE-1),
        ('WFA-D','WFA-4','WFA-SRC','April','other', 4000,'matured',NULL,            CURRENT_DATE-150,CURRENT_DATE-1)`);
    await db.query(`
      INSERT INTO transactions (id,investor_id,type,amount,status,reference,description,investment_id,transaction_date) VALUES
        (gen_random_uuid(),'WFA-1','payout',10000,'completed','MAT-FALLBACK-WFA-A','x','WFA-A',NOW()),
        (gen_random_uuid(),'WFA-2','payout', 8000,'completed','MAT-FALLBACK-WFA-B','x','WFA-B',NOW()),
        (gen_random_uuid(),'WFA-3','payout', 9000,'completed','MAT-FALLBACK-WFA-C','x','WFA-C',NOW()),
        (gen_random_uuid(),'WFA-4','payout', 4000,'completed','MAT-FALLBACK-WFA-D','x','WFA-D',NOW())`);

    console.log('\nand it classifies the four real shapes correctly');
    const r = await runWalletFallbackAudit(db, { poolId: 'WFA-SRC' });
    const s = r.summary;
    ok('finds all four credits', s.credits === 4 && Math.abs(s.total - 31000) < 0.01, JSON.stringify(s));
    ok('three are a full reinvest (one of them blank)', s.fullReinvest === 3, String(s.fullReinvest));
    ok('one asked for something else, and is kept apart',
       s.partial === 1 && Math.abs(s.partialTotal - 9000) < 0.01, JSON.stringify([s.partial, s.partialTotal]));
    ok('two can actually be put back', s.movable === 2 && Math.abs(s.movableTotal - 14000) < 0.01,
       JSON.stringify([s.movable, s.movableTotal]));
    ok('and the spent wallet is blocked, not quietly included',
       s.blocked === 1 && Math.abs(s.blockedTotal - 8000) < 0.01, JSON.stringify([s.blocked, s.blockedTotal]));
    ok('the blocked account is named with its shortfall',
       r.blockedAccounts.length === 1 && Math.abs(r.blockedAccounts[0].shortfall - 7995) < 0.01,
       JSON.stringify(r.blockedAccounts));
    ok('the rollover target for short_term is the open pool',
       (r.rolloverTargets.find(t => t.product_type === 'short_term') || {}).id === 'WFA-TGT');
    ok('and the product type that matched nothing is named',
       !!r.byProductType.other && r.byProductType.other.count === 4);

    /* Already-corrected rows must drop out, or the correction is offered twice. */
    await db.query(
      `INSERT INTO transactions (id,investor_id,type,amount,status,reference,description,investment_id,transaction_date)
       VALUES (gen_random_uuid(),'WFA-1','investment',10000,'completed','REINV-FIX-WFA-A','x','WFA-A',NOW())`);
    const r2 = await runWalletFallbackAudit(db, { poolId: 'WFA-SRC' });
    ok('a row already corrected is counted and then left out',
       r2.summary.alreadyCorrected === 1 && r2.summary.outstanding === 3 && r2.summary.movable === 1,
       JSON.stringify(r2.summary));

    await wipe();
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
