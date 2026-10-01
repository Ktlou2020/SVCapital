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
const FIXSVC = read('server/services/walletFallbackReinvest.js');
const FIXCLI = read('server/scripts/reinvest-wallet-fallbacks.cjs');

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
  /* The panel now carries a button that moves money, so a bare "read-only"
     badge on it would be a lie. It has to say which half is which. */
  const head = HTML.slice(HTML.indexOf('Matured Into Wallets'), HTML.indexOf('Matured Into Wallets') + 400);
  ok('the panel says the report is read-only and the correction is not',
     /The report is read-only — the correction below is not/.test(head), head.slice(0, 160));
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
  ok('it decides the product on maturity_instruction', /maturity_instruction/.test(code));
  ok('and never on payout_option',
     !/payout_option/.test(code),
     'that column DEFAULTs to reinvest and would report every row as one');
  ok('a blank instruction counts as a reinvest',
     /SAME_PRODUCT = new Set\(\[[^\]]*''/.test(code),
     'a blank instruction already defaults to reinvest in the engine');
  /* The fallback amount is only ever the portion the engine tried to
     reinvest — the cash part was paid out first — and for these two it
     routes to inv.product_type, the same product. */
  ok('payout_return and payout_custom count as the same product',
     /SAME_PRODUCT = new Set\(\[[\s\S]{0,120}'payout_return', 'payout_custom'/.test(code),
     'their fallback amount IS the portion that was meant to be reinvested');
  ok('and a switch does not, because it names a different one',
     !/'switch_product'/.test(code.slice(code.indexOf('SAME_PRODUCT'), code.indexOf('SAME_PRODUCT') + 220)));
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
  ok('and names the ones that asked for a different product',
     /switch into a different product/.test(ADMIN));
  ok('the console JS was re-stamped',
     (() => {
       const m = HTML.match(/js\/admin\.js\?v=(\d+)/);
       return !!m && Number(m[1]) >= 186;
     })(), 'a stamped asset is cached for a year');
}

console.log('\nand the button that moves money is built like one');
{
  const code = strip(FIXSVC);
  const route = strip(ROUTE);

  ok('plan and apply are separate endpoints',
     /router\.post\('\/maturity-wallet-fallbacks\/plan'/.test(route)
     && /router\.post\('\/maturity-wallet-fallbacks\/apply'/.test(route));
  ok('and the plan writes nothing',
     !/\b(INSERT|UPDATE|DELETE)\b/.test((FIXSVC.match(/async function planReinvest[\s\S]*?\n\}/) || [''])[0]));

  /* A page that could post its own list of investments and amounts would be
     telling the server which money to take. */
  ok('apply re-derives the plan instead of trusting the request',
     /const plan = await planReinvest\(pool, opts\);/.test(route)
     && !/req\.body\.(chosen|items|investments|amount)/.test(route));
  ok('and the confirmation names the count and the target',
     /const want = `REINVEST \$\{plan\.count\} INTO \$\{plan\.target\.id\}`/.test(route),
     'a mis-click cannot produce it, and neither can a stale tab');
  /* The COMPARISON, not the message. An `if (false)` keeps the message and
     drops the guard, which is exactly the mutation that survived the first
     time this was written. */
  ok('a mismatch refuses',
     /if \(String\(req\.body\.confirm \|\| ''\)\.trim\(\) !== want\)/.test(route)
     && /Confirmation does not match/.test(route),
     'asserting the message alone passes on a guard that never runs');
  /* Scoped to THIS handler: manualCredit.js has several audit.log calls, and
     indexOf would otherwise find one belonging to another endpoint. */
  const applyFn = route.slice(route.indexOf("router.post('/maturity-wallet-fallbacks/apply'"));
  ok('and who did it is recorded afterwards',
     /action: 'maturity_wallet_fallback_reinvested'/.test(applyFn)
     && applyFn.indexOf('await audit.log') > applyFn.indexOf('await applyReinvest'),
     'an audit row records what happened and must not be able to undo it');

  ok('each investor is written in their own transaction',
     /for \(const c of plan\.chosen\)[\s\S]{0,200}pool\.connect\(\)[\s\S]{0,120}BEGIN/.test(code),
     'one failure must not take the other 56 down');
  ok('the balance is re-read under a lock before the debit',
     /FROM sub_accounts WHERE id=\$1 FOR UPDATE/.test(code)
     && /FROM investors {4}WHERE id=\$1 FOR UPDATE/.test(code),
     'the plan is a snapshot; a client who spends in between must be caught');
  ok('and a wallet is never driven negative',
     /Number\(bal\.b\) \+ 0\.005 < c\.amount/.test(code));
  ok('the target pool is locked and its capacity re-checked',
     /FROM investment_pools WHERE id=\$1 FOR UPDATE/.test(code)
     && /max_investment \+ /.test(code.replace(/\s+/g, ' ')) === false
     && /current_invested \|\| 0\) \+ c\.amount > Number\(lock\.max_investment\)/.test(code));
  ok('it is idempotent on a UNIQUE reference',
     /'REINV-FIX-' \+ c\.investment_id/.test(code)
     && /REINV-FIX-/.test(strip(SVC)),
     'the audit drops a corrected row, and the reference index refuses a second');
  /* No fee: the wallet is debited by exactly the amount that reaches the
     pool. The 1% is charged on a client's own investment, not on a
     correction of ours — and the engine's own rollover is fee-free too. */
  ok('no platform fee is charged anywhere in this path',
     !/platform_fee|fee_cents|svcPlatformFee|PLATFORM_FEE|\* 0\.01/.test(code));
  ok('and the wallet is debited by the same figure that reaches the pool',
     /wallet_balance = wallet_balance - \$1[\s\S]{0,120}\[c\.amount,/.test(code)
     && /current_invested,0\) \+ \$1[\s\S]{0,200}\[c\.amount, plan\.target\.id\]/.test(code),
     'one amount, used for both sides — there is nowhere for a fee to appear');

  /* It has to read as a reinvestment, not as a fresh investment the client
     chose to make. _stmtDirection puts both in DEBIT, so the running balance
     is unaffected; _stmtLabel is what differs. */
  ok('the statement row is typed reinvestment',
     /VALUES \(gen_random_uuid\(\),\$1,\$2,'reinvestment'/.test(code),
     "_stmtLabel renders 'investment' as Investment and 'reinvestment' as Reinvestment");
  ok('and the investment record carries is_reinvestment',
     /is_reinvestment[\s\S]{0,260}true/.test(code));
  ok('reinvestment is still a debit on the statement, so the balance agrees',
     /DEBIT {2}= \[[^\]]*'reinvestment'/.test(read('js/portal-core.js')),
     'if it ever moves to CREDIT, this debit would stop being reflected');

  ok('the CLI and the button share this one module',
     /walletFallbackReinvest/.test(strip(FIXCLI)) && /walletFallbackReinvest/.test(route),
     'two copies would move the same money on different rules');

  ok('a selection naming an investment that is not there refuses',
     /has no wallet-fallback credit in/.test(code),
     'a typo would otherwise correct nobody and report success');
  ok('a target that has stopped raising is named',
     /stopped raising on/.test(FIXSVC));
  ok('and that warning does not fire once the pool has deployed',
     /const closedToNew = target\.status === 'open'/.test(code),
     'it would otherwise claim the status is still open when it is not');
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
    ok('three go back into the same product (one of them blank)', s.sameProduct === 3, String(s.sameProduct));
    ok('the switch is kept apart, because it names a different product',
       s.otherProduct === 1 && Math.abs(s.otherProductTotal - 9000) < 0.01,
       JSON.stringify([s.otherProduct, s.otherProductTotal]));
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
