#!/usr/bin/env node
/* Explaining the gap a statement reports, instead of only measuring it.
 *
 * A client asked: "There's a R33 237,71 opening balance discrepancy flagged on
 * the statement. Can you please explain or correct this?" Nobody could — the
 * statement states the size and not the cause.
 *
 * What this holds:
 *
 *   the number    explain-ledger-gap's gap is accountStatement's ledger_gap,
 *                 asserted against the real service rather than re-derived —
 *                 a diagnostic that explains a different number than the
 *                 document is worse than none
 *   period-free   the same gap comes back whatever dates the statement covers,
 *                 because the period cancels out of the algebra
 *   attribution   a reinvestment with no matured_funds credit is counted
 *                 exactly, and the figure quoted is what the existing repair
 *                 would actually write
 *   restraint     a `return` accrual is REPORTED, never counted — calling one
 *                 cash would invent money; and whatever is left is called
 *                 UNEXPLAINED rather than folded into a cause
 *   read-only     it writes nothing
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-ledger-gap-explained.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');
const { nbsp } = require('../../scripts/lib/rendered.cjs');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_gap_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
const SCRIPT  = path.join(ROOT, 'server', 'scripts', 'explain-ledger-gap.cjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
/* The server's formatter is 'R' + toLocaleString — no space after the R,
   unlike the portal's Utils.rand which writes "R 700,00". Both appear in
   this repo's output, so each pattern below is written against the one that
   produced the string. nbsp() only normalises the group separator. */
const N = v => nbsp(v == null ? '' : v);

function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool, dbUrl;

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  dbUrl = withDatabase(process.env.DATABASE_URL, DB_NAME);
  process.env.DATABASE_URL = dbUrl;
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  pool = new Pool({ connectionString: dbUrl, ssl: SSL, max: 2 });
  pool.on('error', () => {});
}

const run = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], {
  encoding: 'utf8',
  env: Object.assign({}, process.env, { DATABASE_URL: dbUrl, DATABASE_SSL: 'false' }),
});

/* An account built so the arithmetic is known in advance.
 *
 *   deposit            +2 000   counted
 *   reinvestment A       −700   counted, and its MATF credit is MISSING
 *   reinvestment B       −300   counted, and its MATF credit EXISTS (+300)
 *   return                 50   carries no cash effect
 *
 *   ledger  = 2000 − 700 − 300 + 300 = 1300
 *   wallet  = 2000                       (what the account really holds)
 *   gap     = 700, which is exactly reinvestment A
 *
 * GAP-B ties exactly, and is here so "every account ties" can be distinguished
 * from "this tool finds nothing". */
/* GAP-C is the other direction: the history explains MORE than the wallet
   holds (R900 of deposits against a R100 wallet). Without it, the reported
   direction could be hardcoded to the under-accounting case and every
   assertion would still pass. */
async function seed() {
  await pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance) VALUES
      ('GAP-A','Bongani','Sibanda','a@example.test','active', 2000),
      ('GAP-B','Thandi','Nkosi','b@example.test','active', 500),
      ('GAP-C','Lerato','Mahlangu','c@example.test','active', 100)`);
  await pool.query(`
    INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, transaction_date)
    VALUES
      ('G-DEP', 'GAP-A','deposit',      2000,'completed','DEP-1','Deposit','2025-03-10'),
      ('G-RI-A','GAP-A','reinvestment',  700,'completed','REINV-INV-A','Reinvested','2025-06-10'),
      ('G-RI-B','GAP-A','reinvestment',  300,'completed','REINV-INV-B','Reinvested','2025-07-10'),
      ('G-MF-B','GAP-A','matured_funds', 300,'completed','MATF-INV-B','Matured Funds','2025-07-10'),
      ('G-RET', 'GAP-A','return',         50,'completed','RET-1','Return accrued','2025-08-10'),
      ('G-DEP-B','GAP-B','deposit',      500,'completed','DEP-B','Deposit','2025-03-10'),
      ('G-DEP-C','GAP-C','deposit',      900,'completed','DEP-C','Deposit','2025-03-10')`);
}

(async () => {
  try {
    await makeDatabase();
    await seed();

    /* ── The number is the document's number ───────────────────────── */
    console.log('\nthe gap it explains is the one the statement reports');
    {
      const { buildAccountStatement } = require(path.join(ROOT, 'server', 'services', 'accountStatement.js'));
      const stmt = await buildAccountStatement(pool, {
        investorId: 'GAP-A', from: '2025-01-01', to: '2025-12-31' });
      ok('the statement does not reconcile', stmt.reconciles === false,
         JSON.stringify({ r: stmt.reconciles, gap: stmt.ledger_gap }));
      ok('and reports a gap of R700', Math.abs(stmt.ledger_gap - 700) < 0.005,
         String(stmt.ledger_gap));

      const out = N(run('--investor=GAP-A'));
      ok('the tool reports the same R700',
         /GAP \+?R700,00/.test(out), out.slice(0, 700));
      ok('and shows the wallet and the ledger it came from',
         /wallet R2 000,00/.test(out) && /ledger R1 300,00/.test(out), out.slice(0, 700));
      ok('and says which way round it is',
         /ledger UNDER-accounts/.test(out), out.slice(0, 800));

      /* The algebra says the period cancels. If it did not, a diagnostic run
         on one date range would contradict a statement run on another. */
      const narrow = await buildAccountStatement(pool, {
        investorId: 'GAP-A', from: '2025-07-01', to: '2025-07-31' });
      ok('the statement’s gap is the same over a different period',
         Math.abs(narrow.ledger_gap - stmt.ledger_gap) < 0.005,
         `${narrow.ledger_gap} vs ${stmt.ledger_gap} — the period must cancel`);
    }

    /* ── Attribution ───────────────────────────────────────────────── */
    console.log('\nand it names the cause rather than restating the size');
    {
      const out = N(run('--investor=GAP-A'));
      ok('the unpaired reinvestment is identified',
         /REINVESTMENTS WITH NO MATURED-FUNDS CREDIT — 1, R700,00/.test(out), out);
      ok('by its own reference, so it can be looked up',
         /REINV-INV-A/.test(out));
      ok('and the PAIRED one is not blamed',
         !/REINV-INV-B/.test(out),
         'it has its matured_funds credit and is not part of the gap');
      ok('the existing repair is named',
         /backfill-matured-funds/.test(out), 'a cause with no remedy is half an answer');
      ok('with what it would close',
         /would close R700,00 of the gap/.test(out), out.slice(-900));
      ok('and the remainder is nothing',
         /UNEXPLAINED: nothing/.test(out), out.slice(-600));
    }

    console.log('\nand it reports an accrual without counting it');
    {
      const out = N(run('--investor=GAP-A'));
      ok('the return row is reported', /ROWS CARRYING NO CASH EFFECT/.test(out) && /return/.test(out),
         out);
      ok('with its amount', /R50,00/.test(out));
      ok('but it is NOT added to what is accounted for',
         /ACCOUNTED FOR: R700,00/.test(out),
         'an accrual counted as cash invents money — the R50 must not be in the R700');
      ok('and the tool says so in as many words',
         /NOT automatically part of the gap/.test(out));
    }

    /* ── Restraint where it cannot know ────────────────────────────── */
    console.log('\nand what it cannot explain, it calls unexplained');
    {
      /* The wallet moves with no row written — the third cause, which no
         ledger can name. */
      await pool.query(`UPDATE investors SET wallet_balance = 2500 WHERE id = 'GAP-A'`);
      const out = N(run('--investor=GAP-A'));
      ok('the gap grows to R1 200', /GAP \+?R1 200,00/.test(out), out.slice(0, 700));
      ok('still only R700 is accounted for', /ACCOUNTED FOR: R700,00/.test(out), out.slice(-800));
      ok('and R500 is named as unexplained', /UNEXPLAINED: R500,00/.test(out), out.slice(-800));
      ok('with the one cause it cannot see from the ledger spelled out',
         /wallet that moved with\s*\n?\s*no row written/.test(out), out.slice(-600));
      await pool.query(`UPDATE investors SET wallet_balance = 2000 WHERE id = 'GAP-A'`);
    }

    console.log('\nand an account that ties is left out of the report');
    {
      const out = N(run());
      ok('the broken account is listed', /GAP-A/.test(out));
      ok('and the sound one is not', !/GAP-B/.test(out),
         'a reconciliation report listing accounts that reconcile is noise');
      const only = N(run('--investor=GAP-B'));
      ok('asking about it directly says it ties',
         /Every account ties/.test(only), only);
    }

    /* ── The same question, from the console ───────────────────────────
       The decomposition used to live only in the script, so the answer to
       "why does this client's statement not tie?" was gated on whoever held a
       production DATABASE_URL. The route exists so it is not. These run the
       REAL router — only requireAuth is stubbed, to choose a role; requireRole
       is the shipped one, so the guard below is the guard that guards. */
    console.log('\nand the console can ask the same question without a database');
    {
      const express  = require('express');
      const authMod  = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
      const realAuth = require(authMod);
      let ROLE = 'admin';
      require.cache[authMod].exports = Object.assign({}, realAuth, {
        requireAuth: (req, _r, next) => {
          req.user = { role: ROLE, id: 'u-lg', email: 'lg@chk.test' };
          next();
        },
      });
      const app = express();
      app.use(express.json());
      app.use('/api/admin', require(path.join(ROOT, 'server', 'routes', 'manualCredit')));
      const srv = app.listen(0);
      await new Promise(r => srv.on('listening', r));
      const PORT = srv.address().port;
      const get = p => new Promise(res => {
        require('http').get({ host: '127.0.0.1', port: PORT, path: p }, r => {
          let b = ''; r.on('data', c => { b += c; });
          r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: r.statusCode, body: j }); });
        }).on('error', e => res({ status: 0, body: { error: e.message } }));
      });

      try {
        const r = await get('/api/admin/ledger-gap?investor=GAP-A');
        ok('the endpoint answers', r.status === 200, JSON.stringify(r.body).slice(0, 200));
        const a = r.body && r.body.accounts && r.body.accounts[0];
        ok('it returns the one account asked about', !!a && a.id === 'GAP-A',
           JSON.stringify(r.body).slice(0, 300));
        /* The figure the screen shows must BE the script's figure, not one
           that resembles it. Two copies of this arithmetic drift, and the
           drift is what somebody quotes to a client. */
        ok('with the same R700 gap the script and the statement report',
           !!a && Math.abs(a.gap - 700) < 0.005, String(a && a.gap));
        ok('and the wallet and ledger behind it',
           !!a && Math.abs(a.wallet - 2000) < 0.005 && Math.abs(a.derived - 1300) < 0.005,
           JSON.stringify({ w: a && a.wallet, d: a && a.derived }));
        ok('the direction is stated rather than left to a sign',
           !!a && a.direction === 'ledger-under-accounts', String(a && a.direction));
        /* The opposite case, so `direction` has to be derived and cannot be a
           constant. R900 of history against a R100 wallet: the remedy here is
           the reverse of GAP-A's, and telling the two apart is the point. */
        {
          const over = await get('/api/admin/ledger-gap?investor=GAP-C');
          const c = over.body && over.body.accounts && over.body.accounts[0];
          ok('an account the history over-accounts for is named as such',
             !!c && c.direction === 'ledger-over-accounts'
             && Math.abs(c.gap + 800) < 0.005,
             JSON.stringify({ d: c && c.direction, g: c && c.gap }));
          ok('and nothing is attributed to a cause that cannot explain it',
             !!c && c.causes.unpairedReinvestments.count === 0
             && Math.abs(c.accountedFor) < 0.005
             && Math.abs(c.unexplained + 800) < 0.005,
             JSON.stringify({ acc: c && c.accountedFor, un: c && c.unexplained }));
        }
        ok('the unpaired reinvestment is attributed, with its reference',
           !!a && a.causes.unpairedReinvestments.count === 1
           && Math.abs(a.causes.unpairedReinvestments.total - 700) < 0.005
           && a.causes.unpairedReinvestments.rows[0].reference === 'REINV-INV-A',
           JSON.stringify(a && a.causes.unpairedReinvestments));
        ok('and the paired one is not blamed',
           !!a && !JSON.stringify(a.causes).includes('REINV-INV-B'),
           'it has its matured_funds credit and is not part of the gap');
        ok('the remedy travels with the cause',
           !!a && /backfill-matured-funds/.test(a.causes.unpairedReinvestments.remedy),
           'a cause with no remedy is half an answer');

        /* The restraint has to survive the trip through JSON. A field that
           says `counted: false` and a total that was nonetheless added to
           accountedFor would be worse than silence. */
        ok('the accrual is reported but marked uncounted',
           !!a && a.causes.noCashEffect.counted === false
           && Math.abs(a.causes.noCashEffect.total - 50) < 0.005,
           JSON.stringify(a && a.causes.noCashEffect));
        ok('and really is absent from what is accounted for',
           !!a && Math.abs(a.accountedFor - 700) < 0.005 && Math.abs(a.unexplained) < 0.005,
           `accountedFor ${a && a.accountedFor} — the R50 accrual must not be in it`);

        /* A single account carries context rows; a sweep must not, or the
           response is a few thousand rows nobody asked to read. */
        ok('a single account carries its recent rows as context',
           !!a && Array.isArray(a.recent) && a.recent.length > 0,
           JSON.stringify((a && a.recent || []).length));
        ok('and the cash effect of each is on the row, so "none" is visible',
           !!a && a.recent.some(x => x.type === 'return' && x.cash === 0)
           && a.recent.some(x => x.type === 'deposit' && x.cash > 0),
           JSON.stringify(a && a.recent));

        const sweep = await get('/api/admin/ledger-gap?min=100');
        ok('a sweep finds the broken account',
           sweep.status === 200 && sweep.body.accounts.some(x => x.id === 'GAP-A'));
        ok('and leaves out the one that ties',
           !sweep.body.accounts.some(x => x.id === 'GAP-B'),
           'a reconciliation report listing accounts that reconcile is noise');
        ok('and carries no context rows across every account',
           sweep.body.accounts.every(x => !x.recent || x.recent.length === 0),
           'a sweep that returns every ledger is a different endpoint');

        /* THE ONE THAT MATTERS MOST. An id that matches nobody must not read
           as a clean bill of health — that is how a typo becomes a sign-off
           on an account nobody looked at. */
        const nope = await get('/api/admin/ledger-gap?investor=NO-SUCH-ID');
        ok('an unknown account is reported as not found, not as balancing',
           nope.status === 200 && nope.body.found === false && !nope.body.accounts.length,
           JSON.stringify(nope.body));
        const ties = await get('/api/admin/ledger-gap?investor=GAP-B');
        ok('while an account that really ties is found and empty',
           ties.status === 200 && ties.body.found === true && !ties.body.accounts.length,
           JSON.stringify(ties.body));
        ok('so the two answers are distinguishable',
           nope.body.found !== ties.body.found,
           'if both said the same thing the field would be decoration');

        /* The guard is the shipped requireRole, so this is the real refusal. */
        ROLE = 'investor';
        const asClient = await get('/api/admin/ledger-gap?investor=GAP-A');
        ok('a client cannot read it', asClient.status === 403, String(asClient.status));
        ROLE = 'fund_manager';
        const asFm = await get('/api/admin/ledger-gap?investor=GAP-A');
        ok('and neither can a fund manager — it is admin/director only',
           asFm.status === 403, String(asFm.status));
        ROLE = 'director';
        const asDir = await get('/api/admin/ledger-gap?investor=GAP-A');
        ok('a director can', asDir.status === 200, String(asDir.status));
        ROLE = 'admin';

        /* READ ONLY on the transaction, so a future edit to the service
           cannot write through this route even by accident. */
        const before = (await pool.query(
          `SELECT count(*) AS n, COALESCE(SUM(amount),0) AS total FROM transactions`)).rows[0];
        await get('/api/admin/ledger-gap?investor=GAP-A');
        await get('/api/admin/ledger-gap?min=1');
        const after = (await pool.query(
          `SELECT count(*) AS n, COALESCE(SUM(amount),0) AS total FROM transactions`)).rows[0];
        ok('and the route writes nothing',
           before.n === after.n && String(before.total) === String(after.total),
           JSON.stringify({ before, after }));
        ok('because it holds the connection READ ONLY',
           /SET TRANSACTION READ ONLY/.test(
             require('fs').readFileSync(path.join(ROOT, 'server', 'routes', 'manualCredit.js'), 'utf8')
               .split("router.get('/ledger-gap'")[1].slice(0, 1200)),
           'the guard belongs on the transaction, not on the service being careful');
      } finally {
        srv.close();
        require.cache[authMod].exports = realAuth;
      }
    }

    console.log('\nand it never writes');
    {
      const before = (await pool.query(
        `SELECT count(*) AS n, COALESCE(SUM(amount),0) AS total FROM transactions`)).rows[0];
      run(); run('--investor=GAP-A');
      const after = (await pool.query(
        `SELECT count(*) AS n, COALESCE(SUM(amount),0) AS total FROM transactions`)).rows[0];
      ok('the ledger is byte-for-byte unchanged',
         before.n === after.n && String(before.total) === String(after.total),
         JSON.stringify({ before, after }));
      /* The SQL moved out of the script and into the service when the console
         needed it too, which left this assertion reading a file that no
         longer holds any SQL — passing while testing nothing. Both files are
         named, so the check cannot be satisfied by moving the query again. */
      const SERVICE = path.join(ROOT, 'server', 'services', 'ledgerGap.js');
      const naked = f => require('fs').readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const [label, file] of [['the script', SCRIPT], ['the service', SERVICE]]) {
        ok(`${label} contains no write at all`,
           !/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(naked(file)),
           'a diagnostic that can write is not a diagnostic');
      }
      /* And one definition, not two. A script that grew its own copy of the
         query would pass every assertion above and still be the thing this
         refactor existed to prevent. */
      ok('and the script owns no query of its own — it reads the service',
         !/\bSELECT\b/i.test(naked(SCRIPT))
         && /require\(['"]\.\.\/services\/ledgerGap['"]\)/.test(naked(SCRIPT)),
         'two copies of this arithmetic drift, and the drift is what gets quoted to a client');
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
