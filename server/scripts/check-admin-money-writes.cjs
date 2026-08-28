#!/usr/bin/env node
/* The admin console must not move money itself.
 *
 * Every balance change on this platform is applied by the server, inside the
 * same database transaction as the row that justifies it. The console's job is
 * to write that row and read the balance back.
 *
 * Four places in admin.js did it themselves anyway: they wrote the row, then
 * PATCHed investors.wallet_balance to a figure computed from the console's own
 * in-memory copy of the investor. Probed against the real route, that produced:
 *
 *   approve deposit      a R300 SUB-ACCOUNT deposit credited the sub-account
 *                        (server, correct) AND the parent investor (console) —
 *                        R300 created out of nothing
 *   approve withdrawal   the wallet is debited when the REQUEST is created, so
 *                        deducting again on approval charged the investor twice.
 *                        R1,000 out of a R5,000 wallet left R3,000, and the
 *                        Math.max(0, …) clamp meant a wallet too small to absorb
 *                        the second debit just read zero
 *   record transaction   landed on the right figure, but the write was absolute:
 *                        a R9,000 deposit arriving while the modal was open was
 *                        overwritten
 *   manual adjustment    same absolute write; the server did not handle
 *                        `adjustment` at all, so the console was the only thing
 *                        moving the wallet
 *
 * Both halves are checked. The behavioural half runs the real routes and counts
 * the money. The structural half asserts the console does not write the balance,
 * because a server that is correct on its own still ends up wrong the moment
 * someone re-adds the client-side write — which is how all four got there.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-admin-money-writes.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs      = require('fs');
const path    = require('path');
const express = require('express');
const http    = require('http');
const pool    = require(path.join(__dirname, '..', 'db', 'pool'));

const ROOT  = path.join(__dirname, '..', '..');
const ADMIN_SRC = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const ADMIN = { role: 'admin', id: 'u-admin', email: 'admin@example.test', firstName: 'A', lastName: 'D' };
const authMod = require.resolve(path.join(__dirname, '..', 'middleware', 'auth'));
require.cache[authMod] = { id: authMod, filename: authMod, loaded: true, exports: {
  requireAuth: (req, _r, next) => { req.user = ADMIN; next(); },
  requireRole: () => (_q, _r, next) => next(),
} };
const app = express();
app.use(express.json());
app.use('/api/tables', require(path.join(__dirname, '..', 'routes', 'tables')));

let server;
const call = (method, p, body) => new Promise(res => {
  const d = body ? JSON.stringify(body) : null;
  const r = http.request({ port: server.address().port, path: p, method,
    headers: d ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } : {} }, x => {
    let s = ''; x.on('data', c => s += c);
    x.on('end', () => { let j = {}; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); });
  });
  r.on('error', e => res({ status: 0, body: { error: e.message } }));
  r.end(d);
});

const q = (s, p) => pool.query(s, p);
const balances = async () => {
  const i = (await q(`SELECT wallet_balance FROM investors WHERE id='CHK-MW-INV'`)).rows[0];
  const s = (await q(`SELECT wallet_balance FROM sub_accounts WHERE id='CHK-MW-SA'`)).rows[0];
  return { investor: i ? Number(i.wallet_balance) : null, sub: s ? Number(s.wallet_balance) : null };
};

async function seed(startInvestor, startSub) {
  await q(`DELETE FROM transactions  WHERE id LIKE 'CHK-MW-%'`);
  await q(`DELETE FROM fica_checks   WHERE investor_id = 'CHK-MW-INV'`).catch(() => {});
  await q(`DELETE FROM sub_accounts  WHERE id LIKE 'CHK-MW-%'`);
  await q(`DELETE FROM investors     WHERE id LIKE 'CHK-MW-%'`);
  await q(`INSERT INTO investors (id, first_name, last_name, email, wallet_balance)
           VALUES ('CHK-MW-INV','Money','Probe','chk-mw@example.test',$1)`, [startInvestor]);
  await q(`INSERT INTO sub_accounts (id, parent_investor_id, name, account_type, wallet_balance, status)
           VALUES ('CHK-MW-SA','CHK-MW-INV','Child','child',$1,'active')`, [startSub]);
}

(async () => {
  try {
    server = await new Promise(r => { const s = app.listen(0, () => r(s)); });

    console.log('\napproving a deposit credits exactly one wallet');
    {
      await seed(1000, 500);
      await q(`INSERT INTO transactions (id, investor_id, type, amount, status, reference)
               VALUES ('CHK-MW-T1','CHK-MW-INV','deposit',200,'pending','CHK-MW-R1')`);
      await call('PATCH', '/api/tables/transactions/CHK-MW-T1', { status: 'completed' });
      const b = await balances();
      ok('an investor deposit credits the investor', b.investor === 1200, JSON.stringify(b));
      ok('and leaves the sub-account alone', b.sub === 500, JSON.stringify(b));
    }
    {
      await seed(1000, 500);
      await q(`INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference)
               VALUES ('CHK-MW-T2','CHK-MW-INV','CHK-MW-SA','deposit',300,'pending','CHK-MW-R2')`);
      await call('PATCH', '/api/tables/transactions/CHK-MW-T2', { status: 'completed' });
      const b = await balances();
      ok('a SUB-ACCOUNT deposit credits the sub-account', b.sub === 800, JSON.stringify(b));
      ok('and NOT the parent investor', b.investor === 1000,
         `parent went to ${b.investor} — crediting both creates money out of nothing`);
      ok('so the total moved is the deposit, once',
         (b.investor + b.sub) - 1500 === 300, `moved ${(b.investor + b.sub) - 1500} for a R300 deposit`);
    }

    console.log('\napproving a withdrawal does not debit twice');
    {
      await seed(5000, 0);
      /* withdrawals.js debits the wallet when the request is created — which is
         why tables.js refunds it on rejection. */
      await q(`UPDATE investors SET wallet_balance = wallet_balance - 1000 WHERE id='CHK-MW-INV'`);
      await q(`INSERT INTO transactions (id, investor_id, type, amount, status, reference)
               VALUES ('CHK-MW-W1','CHK-MW-INV','withdrawal',1000,'pending','CHK-MW-RW1')`);
      const atRequest = (await balances()).investor;
      await call('PATCH', '/api/tables/transactions/CHK-MW-W1', { status: 'completed' });
      const after = (await balances()).investor;
      ok('the debit happened at request time', atRequest === 4000, String(atRequest));
      ok('and approval does not debit again', after === 4000,
         `${atRequest} → ${after}: the investor was charged R${atRequest - after} extra`);
    }
    {
      /* The refund on rejection is the proof that the debit is at request time.
         If that ever moves, this check should fail rather than the money. */
      await seed(5000, 0);
      await q(`UPDATE investors SET wallet_balance = wallet_balance - 1000 WHERE id='CHK-MW-INV'`);
      await q(`INSERT INTO transactions (id, investor_id, type, amount, status, reference)
               VALUES ('CHK-MW-W2','CHK-MW-INV','withdrawal',1000,'pending','CHK-MW-RW2')`);
      await call('PATCH', '/api/tables/transactions/CHK-MW-W2', { status: 'rejected' });
      ok('rejecting one refunds it', (await balances()).investor === 5000,
         'the refund is what tells you the debit already happened');
    }

    console.log('\nrecording a completed transaction moves the money once');
    {
      await seed(1000, 0);
      const r = await call('POST', '/api/tables/transactions', {
        id: 'CHK-MW-N1', investor_id: 'CHK-MW-INV', type: 'deposit', amount: 250,
        status: 'completed', reference: 'CHK-MW-RN1', description: 'check',
      });
      ok('the insert succeeds', r.status === 201, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      ok('and credits once', (await balances()).investor === 1250, JSON.stringify(await balances()));
    }

    console.log('\na manual adjustment is applied by the server, relatively');
    {
      await seed(1000, 0);
      await call('POST', '/api/tables/transactions', {
        id: 'CHK-MW-A1', investor_id: 'CHK-MW-INV', type: 'adjustment', amount: 300,
        status: 'completed', reference: 'CHK-MW-RA1', description: 'credit adj',
      });
      ok('a credit adjustment raises the wallet', (await balances()).investor === 1300,
         'the console used to be the only thing moving this, with an absolute write');
    }
    {
      await seed(1000, 0);
      await call('POST', '/api/tables/transactions', {
        id: 'CHK-MW-A2', investor_id: 'CHK-MW-INV', type: 'adjustment', amount: -400,
        status: 'completed', reference: 'CHK-MW-RA2', description: 'debit adj',
      });
      ok('a debit adjustment lowers it', (await balances()).investor === 600, JSON.stringify(await balances()));
    }
    {
      /* Deliberately allowed: the console asks the admin to confirm a negative
         balance before sending. Clamping at zero here would silently discard
         part of a correction, which is the failure mode GREATEST(0, …) caused
         elsewhere in this same file. */
      await seed(100, 0);
      await call('POST', '/api/tables/transactions', {
        id: 'CHK-MW-A3', investor_id: 'CHK-MW-INV', type: 'adjustment', amount: -250,
        status: 'completed', reference: 'CHK-MW-RA3', description: 'overdraw adj',
      });
      ok('an adjustment may take the wallet negative, unclamped',
         (await balances()).investor === -150,
         'the console confirms this explicitly; clamping would hide the rest of the correction');
    }
    {
      await seed(1000, 0);
      const r = await call('POST', '/api/tables/transactions', {
        id: 'CHK-MW-A4', investor_id: 'NO-SUCH-INVESTOR', type: 'adjustment', amount: 100,
        status: 'completed', reference: 'CHK-MW-RA4', description: 'orphan',
      });
      const { rows } = await q(`SELECT 1 FROM transactions WHERE id='CHK-MW-A4'`);
      ok('a money row naming no investor is refused, not committed',
         r.status >= 400 && rows.length === 0,
         `HTTP ${r.status}, row ${rows.length ? 'was written' : 'not written'}`);
    }

    console.log('\nRecord Transaction saves the types it offers');
    {
      /* The console negated investment, reinvestment and withdrawal amounts, and
         the server rejected every negative on create — so three of the seven
         types in the Record Transaction dropdown had never once saved. The admin
         got "Failed to record transaction" with no reason given. */
      await seed(50000, 0);
      for (const type of ['deposit', 'investment', 'reinvestment', 'withdrawal', 'return', 'fee', 'referral_bonus']) {
        const r = await call('POST', '/api/tables/transactions', {
          id: `CHK-MW-TY-${type}`, investor_id: 'CHK-MW-INV', type, amount: 100,
          status: 'pending', reference: `CHK-MW-TY-${type}`, description: 'type check',
        });
        ok(`${type} records`, r.status === 201,
           `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      }
      ok('the console sends a magnitude, not a negated amount',
         /amount:\s+Math\.abs\(amount\),/.test(ADMIN_SRC) &&
         !/-Math\.abs\(amount\)\s*:\s*Math\.abs\(amount\)/.test(ADMIN_SRC),
         'the type carries the direction; a negative withdrawal would debit again on refund');
    }

    console.log('\na negative amount is allowed only where it means something');
    {
      await seed(1000, 0);
      const adj = await call('POST', '/api/tables/transactions', {
        id: 'CHK-MW-NEG1', investor_id: 'CHK-MW-INV', type: 'adjustment', amount: -50,
        status: 'pending', reference: 'CHK-MW-NEG1', description: 'signed',
      });
      ok('an adjustment may be negative — it is the one signed type', adj.status === 201,
         `HTTP ${adj.status} ${JSON.stringify(adj.body).slice(0, 160)}`);

      const wd = await call('POST', '/api/tables/transactions', {
        id: 'CHK-MW-NEG2', investor_id: 'CHK-MW-INV', type: 'withdrawal', amount: -50,
        status: 'pending', reference: 'CHK-MW-NEG2', description: 'signed',
      });
      ok('a negative withdrawal is still refused', wd.status === 400,
         `HTTP ${wd.status} — the refund adds amount back, so a negative one debits twice`);
      ok('and the refusal says why', /type carries the direction/.test(JSON.stringify(wd.body)),
         JSON.stringify(wd.body));
    }

    console.log('\nan absolute wallet write from stale state cannot survive');
    {
      /* The shape of the old bug, independent of any one call site: read a
         balance, let something else change it, write back read+delta. */
      await seed(1000, 0);
      const readAt = (await balances()).investor;
      await q(`UPDATE investors SET wallet_balance = wallet_balance + 9000 WHERE id='CHK-MW-INV'`);
      await call('POST', '/api/tables/transactions', {
        id: 'CHK-MW-S1', investor_id: 'CHK-MW-INV', type: 'deposit', amount: 250,
        status: 'completed', reference: 'CHK-MW-RS1', description: 'stale',
      });
      const after = (await balances()).investor;
      ok('a concurrent credit survives the write',
         after === 10250,
         `expected 10250, got ${after} — R${10250 - after} destroyed. read-at was ${readAt}`);
    }

    /* ── Structural: the console must not write the balance ─────────────── */
    console.log('\nthe console does not write wallet_balance through the table API');
    {
      const lines = ADMIN_SRC.split('\n');
      const offenders = [];
      lines.forEach((ln, i) => {
        if (!/wallet_balance\s*:/.test(ln)) return;
        if (/wallet_balance:\s*0\s*,/.test(ln)) return;              // new-investor defaults
        offenders.push(`${i + 1}: ${ln.trim().slice(0, 110)}`);
      });
      ok('no generic PATCH sets a wallet balance', offenders.length === 0,
         offenders.join('\n      '));

      const patchesInvestorWallet = /tables\/investors\/\$\{[^}]+\}`?\s*,\s*\{\s*wallet_balance/.test(ADMIN_SRC) ||
                                    /API\.investors\.update\([^)]*\{\s*wallet_balance/.test(ADMIN_SRC);
      ok('and no helper does it indirectly', !patchesInvestorWallet,
         'API.investors.update({wallet_balance}) is the exact call that caused all four');

      ok('the deliberate override still goes through its own endpoint',
         /admin\/override-wallet/.test(ADMIN_SRC),
         'an audited, confirmed absolute set is legitimate — a silent one is not');
    }

    console.log('\nthe reason is written down where the next person will look');
    {
      const named = [
        ['approve deposit',     /changeTxnStatus/],
        ['approve withdrawal',  /approveWithdrawal|Withdrawal approved/],
        ['record transaction',  /saveNewTxn|Transaction recorded/],
        ['manual adjustment',   /Adjustment applied/],
      ];
      for (const [label, re] of named) ok(`${label} still exists to be checked`, re.test(ADMIN_SRC));
      ok('each explains why it does not credit',
         (ADMIN_SRC.match(/server credits it|server applies the adjustment|debited when the withdrawal REQUEST|credits the wallet inside the insert/g) || []).length >= 4,
         'four identical mistakes in one file means the reason has to be written at each one');
    }

    await q(`DELETE FROM transactions WHERE id LIKE 'CHK-MW-%'`).catch(() => {});
    await q(`DELETE FROM fica_checks  WHERE investor_id = 'CHK-MW-INV'`).catch(() => {});
    await q(`DELETE FROM sub_accounts WHERE id LIKE 'CHK-MW-%'`).catch(() => {});
    await q(`DELETE FROM investors    WHERE id LIKE 'CHK-MW-%'`).catch(() => {});

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    try { server && server.close(); } catch (_) { /* already down */ }
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
