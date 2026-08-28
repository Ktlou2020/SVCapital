#!/usr/bin/env node
/* The ops console must show the same reconciliation the CLI does.
 *
 * The report says who to refund, so the risk is not that the panel is ugly — it
 * is that the panel and the command line disagree and nobody notices which one
 * was quoted. That is why the query lives in one service and why the first
 * thing asserted here is that both callers produce identical numbers from
 * identical data.
 *
 * The rest is what the panel must not do with the answer: sum an exact figure
 * with an upper bound, render a client's name as markup, or let a clean result
 * read as a guarantee when the audit log does not reach back far enough.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-double-debit-console.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const http    = require('http');
const express = require('express');
const { execFileSync } = require('child_process');
const pool    = require(path.join(__dirname, '..', 'db', 'pool'));

const ROOT = path.join(__dirname, '..', '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
const CLI  = path.join(__dirname, 'reconcile-withdrawal-double-debits.cjs');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

let ROLE = { role: 'admin', id: 'u-a', email: 'admin@chk-dd.test', firstName: 'A', lastName: 'D' };
const authMod = require.resolve(path.join(__dirname, '..', 'middleware', 'auth'));
require.cache[authMod] = { id: authMod, filename: authMod, loaded: true, exports: {
  requireAuth: (req, _r, next) => { req.user = ROLE; next(); },
  requireRole: (...roles) => (req, res, next) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden.' }),
} };
const app = express();
app.use(express.json());
app.use('/api/admin', require(path.join(__dirname, '..', 'routes', 'manualCredit')));

let server;
const get = p => new Promise(res => {
  http.get({ port: server.address().port, path: p }, x => {
    let s = ''; x.on('data', c => s += c);
    x.on('end', () => { let j = {}; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); });
  }).on('error', e => res({ status: 0, body: { error: e.message } }));
});

const q = (s, p) => pool.query(s, p);
const ACTOR = 'admin@chk-dd.test';
let clock = 0;
const at = mins => new Date(clock + mins * 60000).toISOString();

/* A name that would run if the panel wrote it into the page unescaped. Real
   investors carry apostrophes; this is the same field, pushed further. */
const NASTY = `<img src=x onerror="window.pwned=1">O'Brien`;

async function cleanup() {
  await q(`DELETE FROM audit_events WHERE entity_id LIKE 'CHK-DD-%' OR user_email = $1`, [ACTOR]).catch(() => {});
  await q(`DELETE FROM transactions WHERE id LIKE 'CHK-DD-%'`).catch(() => {});
  await q(`DELETE FROM sub_accounts WHERE id LIKE 'CHK-DD-%'`).catch(() => {});
  await q(`DELETE FROM investors    WHERE id LIKE 'CHK-DD-%'`).catch(() => {});
}

const audit = (type, entityId, after, when) => q(
  `INSERT INTO audit_events (id, event_type, entity_type, entity_id, user_email, actor_role, description, metadata, created_at)
   VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'admin', 'fixture', $5::jsonb, $6)`,
  [type, type.split('.')[0], entityId, ACTOR, JSON.stringify({ before: null, after }), when]);

async function stage({ txnId, investorId, type, amount, written, subAccountId = null }) {
  await q(`INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference)
           VALUES ($1,$2,$3,$4,$5,'completed',$1)`, [txnId, investorId, subAccountId, type, amount]);
  await audit('transactions.updated', txnId, { status: 'completed' }, at(0));
  if (written !== null) await audit('investors.updated', investorId, { wallet_balance: written }, at(0.05));
}

(async () => {
  try {
    server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    await cleanup();
    await q(`INSERT INTO investors (id, first_name, last_name, email, wallet_balance)
             VALUES ('CHK-DD-I1',$1,'Mokoena','m@chk-dd.test', 2000),
                    ('CHK-DD-I2','Sipho','Nkosi','s@chk-dd.test', 0)`, [NASTY]);
    await q(`INSERT INTO sub_accounts (id, parent_investor_id, name, account_type, wallet_balance, status)
             VALUES ('CHK-DD-SA','CHK-DD-I1','Child','child', 500, 'active')`);

    clock = Date.parse('2026-05-02T09:00:00Z');
    await stage({ txnId: 'CHK-DD-W1', investorId: 'CHK-DD-I1', type: 'withdrawal', amount: 1000, written: 3000 });
    clock = Date.parse('2026-05-03T09:00:00Z');
    await stage({ txnId: 'CHK-DD-W2', investorId: 'CHK-DD-I2', type: 'withdrawal', amount: 800, written: 0 });
    clock = Date.parse('2026-05-04T09:00:00Z');
    await stage({ txnId: 'CHK-DD-D1', investorId: 'CHK-DD-I1', type: 'deposit', amount: 300,
                  written: 2300, subAccountId: 'CHK-DD-SA' });

    const SCOPE = '?since=2026-05-01&until=2026-05-31';

    console.log('\nthe endpoint answers');
    const r = await get('/api/admin/withdrawal-double-debits' + SCOPE);
    ok('it returns 200', r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    ok('one double-debited withdrawal is exact', r.body.totals?.exactCount === 1, JSON.stringify(r.body.totals));
    ok('and one needs review', r.body.totals?.cappedCount === 1, JSON.stringify(r.body.totals));
    ok('owed is the unclamped amount only', r.body.totals?.owed === 1000, JSON.stringify(r.body.totals));
    ok('the bound is carried separately', r.body.totals?.needsReview === 800, JSON.stringify(r.body.totals));
    ok('they are never combined into one figure',
       r.body.totals?.owed !== 1800,
       'an exact refund and an upper bound must not be summed — nobody can pay out against 1800');
    ok('the sub-account deposit is reported apart',
       r.body.totals?.subAccountCount === 1 && r.body.totals?.subAccountTotal === 300,
       JSON.stringify(r.body.totals));
    ok('coverage is included so a clean run cannot read as a guarantee',
       r.body.coverage?.events > 0 && 'approvedWithoutWrite' in r.body,
       JSON.stringify(r.body.coverage));

    console.log('\nthe console and the command line cannot disagree');
    {
      /* The point of the shared service. Two implementations of a money report
         is a money report you cannot quote. */
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddcli-'));
      const csv = path.join(dir, 'cli.csv');
      let out = '';
      try {
        out = execFileSync('node', [CLI, '--since', '2026-05-01', '--until', '2026-05-31', '--csv', csv],
          { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
      } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }

      ok('the CLI finds the same two withdrawals',
         /DOUBLE-DEBITED WITHDRAWALS: 2/.test(out), out.slice(0, 900));
      ok('and the same one refundable exactly', /1 refundable exactly/.test(out), out);

      const text = fs.existsSync(csv) ? fs.readFileSync(csv, 'utf8') : '';
      const rows = text.trim().split('\n').slice(1);
      ok('the CLI CSV has a row per finding', rows.length === 3, `${rows.length} rows`);
      ok('the exact one is a plain number', /,1000\.00,/.test(text), rows[0]);
      ok('and the bound is marked', /<=800\.00/.test(text),
         'a refund run must not read an upper bound as an amount');
      ok('the endpoint agrees on every row',
         (r.body.doubleDebits || []).length === 2 && (r.body.deposits || []).length === 1,
         JSON.stringify({ d: r.body.doubleDebits?.length, p: r.body.deposits?.length }));
      fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('\nit is admin-only and writes nothing');
    {
      const before = (await q(`SELECT COUNT(*)::int n FROM audit_events`)).rows[0].n;
      const wallets = (await q(`SELECT id, wallet_balance FROM investors WHERE id LIKE 'CHK-DD-%' ORDER BY id`)).rows;
      await get('/api/admin/withdrawal-double-debits' + SCOPE);
      ok('running it adds no audit rows',
         (await q(`SELECT COUNT(*)::int n FROM audit_events`)).rows[0].n === before);
      ok('and moves no money',
         JSON.stringify((await q(`SELECT id, wallet_balance FROM investors WHERE id LIKE 'CHK-DD-%' ORDER BY id`)).rows) === JSON.stringify(wallets));

      ROLE = { role: 'support', id: 'u-s', email: 's@chk-dd.test' };
      const forbidden = await get('/api/admin/withdrawal-double-debits' + SCOPE);
      ok('a non-admin is refused', forbidden.status === 403, `HTTP ${forbidden.status}`);
      ROLE = { role: 'admin', id: 'u-a', email: ACTOR, firstName: 'A', lastName: 'D' };

      const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'manualCredit.js'), 'utf8');
      const at2 = route.indexOf("router.get('/withdrawal-double-debits'");
      const fn  = route.slice(at2, route.indexOf('\n});', at2));
      ok('the route runs inside a READ ONLY transaction',
         /SET TRANSACTION READ ONLY/.test(fn),
         'so a later edit to the service cannot write through this route either');
      ok('and sets a statement timeout', /SET statement_timeout/.test(fn));
    }

    console.log('\nthe panel is wired');
    {
      ok('there is a panel in the ops console',
         /Withdrawal Double-Debit Reconciliation/.test(HTML));
      ok('it says it changes nothing', /Read-only &mdash; refunds nothing/.test(HTML));
      ok('with a run button', /runWithdrawalReconciliation\(this\)/.test(HTML));
      ok('date and window inputs', /id="ddSince"/.test(HTML) && /id="ddUntil"/.test(HTML) && /id="ddWindow"/.test(HTML));
      ok('and an export that only appears once there is something to export',
         /id="ddExportBtn" style="display:none"/.test(HTML));
      ok('the handler exists', /async function runWithdrawalReconciliation\(btn\)/.test(SRC));
      ok('it calls the endpoint', /admin\/withdrawal-double-debits/.test(SRC));
      ok('the export uses the shared CSV writer',
         /_downloadCSV\(rows, `withdrawal-double-debits-/.test(SRC));
      ok('and writes unformatted numbers',
         /\(r\.amount \|\| 0\)\.toFixed\(2\)/.test(SRC),
         'Utils.rand would emit R1 250,00, which a refund run reads as 125000');
      ok('the panel surfaces coverage', /floor, not a total/.test(SRC));
      ok('and never adds the bound to the refundable total',
         !/owed \+ .*needsReview|needsReview \+ .*owed/.test(SRC));
    }

    if (!CHROME) {
      console.log('\n  SKIP  no headless Chromium — the render was not exercised');
    } else {
      console.log('\nand renders a hostile name inert');
      /* The real response, through the real handler's escaping, in a browser. */
      const escSrc = (SRC.match(/^const _esc = .*$/m) || [])[0];
      ok('the shipped _esc was found', !!escSrc);
      const nastyRow = (r.body.byInvestor || []).find(e => String(e.name).includes('<img'));
      ok('the endpoint returned the name verbatim', !!nastyRow,
         'the escaping belongs in the renderer, not the query');

      const page = `<!doctype html><meta charset="utf-8"><body>
<div id="host"></div><div id="out"></div>
<script>
${escSrc}
window.pwned = 0;
var e = ${JSON.stringify(nastyRow || { name: NASTY, investorId: 'x', owed: 1, needsReview: 0, n: 1 })};
document.getElementById('host').innerHTML =
  '<table><tbody><tr><td>' + _esc(e.name) + '</td><td>' + _esc(e.investorId) + '</td></tr></tbody></table>';
document.getElementById('out').textContent = JSON.stringify({
  pwned: window.pwned,
  imgs: document.getElementById('host').querySelectorAll('img').length,
  text: document.getElementById('host').textContent.slice(0, 60),
});
</script></body>`;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddpanel-'));
      const file = path.join(dir, 'p.html');
      fs.writeFileSync(file, page);
      let dom = '';
      try {
        dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox',
          '--virtual-time-budget=4000', '--dump-dom', 'file://' + file],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
      } catch (e) { dom = (e.stdout || '').toString(); }
      const mm = dom.match(/id="out">([^<]*)</);
      let parsed = null;
      try {
        parsed = JSON.parse((mm ? mm[1] : '')
          .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
      } catch (_) { /* reported below */ }
      ok('the page reported', !!parsed, (mm ? mm[1] : dom).slice(0, 200));
      if (parsed) {
        ok('the name does not execute', parsed.pwned === 0);
        ok('no element is created from it', parsed.imgs === 0, `${parsed.imgs} <img>`);
        ok('and it still reads as a name', /O'Brien/.test(parsed.text), parsed.text);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }

    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
    await cleanup().catch(() => {});
  } finally {
    try { server && server.close(); } catch (_) { /* already down */ }
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
