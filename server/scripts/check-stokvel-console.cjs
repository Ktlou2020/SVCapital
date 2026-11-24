#!/usr/bin/env node
/* The console's view of a group, as the person answering the phone meets it.
 *
 * THE WHOLE SCREEN WAS 404. openStokvelAdmin reads eight stokvel tables
 * through the generic table API, and not one of them was in
 * ALLOWED_TABLES — so staff clicked Open on a group and got "Could not
 * load: Unknown table: stokvel_members", and had done since the screen
 * shipped. The tables WERE listed in ADMIN_ONLY_TABLES, "requires admin to
 * READ", which is a guard on a door that did not exist.
 *
 * THEY ARE READ-ONLY, AND THAT IS NOT TIMIDITY. tables.js argues at length
 * that the mandate must not be reachable through the generic writer — "who
 * may SIGN was never reachable here" — and that argument is right. Listing
 * them for reading and refusing every write keeps it: a roster, a quorum, a
 * vote and an allocation are changed by the services that hold the
 * signatories' approval, or not at all. The console's two member writers
 * went with the controls that called them; neither had ever worked.
 *
 * AND THE SCREEN NAMED NOBODY. Every row was an investor id — the roster,
 * the shares, the exit debt, the attribute dropdown. Somebody rings and
 * says "this is Precious Nkuna" and the person answering has four
 * identifiers. The arrears were a total: "R 850,00 · 2 obligations", which
 * answers how much and never why.
 *
 * Run: DATABASE_URL=… node server/scripts/check-stokvel-console.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const vm   = require('vm');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = src => String(src).replace(/\/\*[\s\S]*?\*\//g, ' ')
                                .replace(/^\s*\/\/.*$/gm, ' ');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

/* The eight reads openStokvelAdmin makes, in its own order. */
const SCREEN_READS = [
  'stokvel_members', 'stokvel_contribution_schedules', 'stokvel_withdrawal_requests',
  'stokvel_contributions', 'stokvel_invites', 'stokvel_allocations',
  'stokvel_exit_debts', 'stokvel_payouts',
];

const words = h => String(h).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/* THE CONSOLE, RUN RATHER THAN READ.
 *
 * The first version of the arrears assertion matched the source for "Who
 * owes it", and a mutation that wrapped the whole breakdown in `${false ?
 * …}` passed it — the strings are still in the file, inside a branch that
 * can never render. A screen is only proved by the HTML it produces.
 *
 * STATE is declared with `let`, so it lives in the context's lexical scope
 * and never appears on the global object; it is reached by running code
 * inside the context rather than by assignment from out here. Utils has to
 * exist BEFORE admin.js runs, or `Utils.rand` resolves to nothing.
 */
function consoleVm() {
  const ctx = {
    document: { getElementById: () => null, querySelector: () => null,
                querySelectorAll: () => [], addEventListener() {} },
    location: { search: '', pathname: '/admin/', href: '' },
    navigator: { userAgent: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    Utils: { rand: n => 'R ' + Number(n || 0).toFixed(2) },
    setTimeout, clearTimeout, setInterval, clearInterval, console,
    encodeURIComponent, decodeURIComponent, URLSearchParams,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('admin/js/admin.js'), ctx);
  ctx.__names = new Map([
    ['INV-A', { first_name: 'Precious', last_name: 'Nkuna' }],
    ['INV-B', { first_name: 'Sipho',    last_name: 'Dlamini' }],
  ]);
  ctx.activity = open => {
    ctx.__open = open;
    return vm.runInContext(
      'STATE.stokvelOpen = __open; STATE.stokvelNames = __names;'
      + ' _stokvelAdminActivity({})', ctx);
  };
  ctx.nameOf = id => {
    ctx.__id = id;
    return vm.runInContext(
      'STATE.stokvelNames = __names; _stokvelMemberName(__id)', ctx);
  };
  return ctx;
}

(async () => {
  let srv;
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.stokvel_members') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no stokvel tables here'); return; }

    const clean = async () => {
      for (const t of ['stokvel_members', 'stokvel_allocations', 'stokvel_exit_debts',
                       'stokvel_contributions'])
        await db.query(`DELETE FROM ${t} WHERE sub_account_id LIKE 'SA-CN-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-CN-%'`);
      await db.query(`DELETE FROM investors    WHERE id LIKE 'INV-CN-%'`);
    };
    await clean();
    await db.query(
      `INSERT INTO investors (id, first_name, last_name, email, phone, status, wallet_balance)
       VALUES ('INV-CN-A','Precious','Nkuna','precious.cn@example.test','0760000001','active',0)`);
    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, wallet_balance,
                                 kyc_status, status, stokvel_quorum, share_basis)
       VALUES ('SA-CN-1','INV-CN-A','stokvel','Console Club',1000,'approved','active',2,'contribution')`);
    await db.query(
      `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
       VALUES ('SM-CN-1','SA-CN-1','INV-CN-A','chairperson',true,'active',NOW())`);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/tables', require(path.join(ROOT, 'server', 'routes', 'tables.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const tok = (role, extra) => jwt.sign(Object.assign(
      { id: 'u-' + role, role, email: role + '@svcapital.test' }, extra || {}),
      process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = (method, p, token, body) => new Promise(res => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign({ Authorization: `Bearer ${token}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s = ''; x.on('data', c => s += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s || '{}') })); });
      if (payload) r.write(payload);
      r.end();
    });

    /* ══ 1. The screen's own reads ═════════════════════════════════ */
    console.log('\nthe eight reads the console makes all answer');
    for (const t of SCREEN_READS) {
      const r = await call('GET', `/api/tables/${t}?sub_account_id=SA-CN-1&limit=10`, tok('admin'));
      ok(`${t} is readable by staff`, r.status === 200,
         'the whole group screen is these eight reads, and every one of them '
         + 'answered "Unknown table": ' + JSON.stringify(r.body).slice(0, 140));
    }

    /* ══ 1b. Every one of them, sorted by something it has ═════════ */
    console.log('\nand every table listed answers an unsorted read');
    {
      /* A table joins the allowlist and the reader sorts it by created_at
         unless defaultSort names a column. stokvel_request_approvals has
         decided_at and no created_at, so listing it without that entry
         turned every read of it into a 500 — which is how the console's
         Platform Settings panel sat on "Loading..." for months. The eight
         reads above are the screen's; this is the whole set, because the
         next person to read one of them should not find out this way. */
      for (const t of ['stokvel_members', 'stokvel_withdrawal_requests',
                       'stokvel_request_approvals', 'stokvel_invites',
                       'stokvel_allocations', 'stokvel_exit_debts',
                       'stokvel_payouts', 'stokvel_payout_lines',
                       'stokvel_contributions', 'stokvel_contribution_schedules',
                       'stokvel_cash_receipts']) {
        const r = await call('GET', `/api/tables/${t}?limit=5`, tok('admin'));
        ok(`${t} sorts on a column it has`, r.status === 200,
           'an unsorted read falls back to created_at, and a table without '
           + 'one answers 500: ' + JSON.stringify(r.body).slice(0, 120));
      }
    }

    /* ══ 2. And only by staff ══════════════════════════════════════ */
    console.log('\nand only by staff');
    {
      const inv = await call('GET', '/api/tables/stokvel_members?limit=10',
                             tok('investor', { investorId: 'INV-CN-A' }));
      ok('AN INVESTOR CANNOT READ EVERY GROUP’S ROSTER',
         inv.status === 403 || inv.status === 401,
         'unlisted, this reader would hand every signed-in investor the '
         + 'membership of every stokvel on the platform: ' + JSON.stringify(inv.body));
      const alloc = await call('GET', '/api/tables/stokvel_allocations?limit=10',
                               tok('investor', { investorId: 'INV-CN-A' }));
      ok('nor every group’s internal split',
         alloc.status === 403 || alloc.status === 401, JSON.stringify(alloc.body));
    }

    /* ══ 3. And nobody writes to them here ═════════════════════════ */
    console.log('\nand nobody changes a group’s mandate from a table editor');
    {
      const patch = await call('PATCH', '/api/tables/stokvel_members/SM-CN-1',
                               tok('admin'), { is_signatory: false });
      ok('STAFF CANNOT FLIP A SIGNATORY',
         patch.status === 403,
         'who signs for a group’s money is the mandate, changed by the '
         + 'group to its quorum — opening these tables for reading must '
         + 'not open them for writing: ' + JSON.stringify(patch.body));
      ok('and is told so, rather than having the field dropped',
         /cannot be changed here/.test(patch.body.error || ''),
         'a column quietly dropped returns 200 and tells staff their change '
         + 'was saved: ' + JSON.stringify(patch.body));
      const { rows: [m] } = await db.query(
        `SELECT is_signatory FROM stokvel_members WHERE id = 'SM-CN-1'`);
      ok('AND NOTHING MOVED', m.is_signatory === true, String(m.is_signatory));

      const post = await call('POST', '/api/tables/stokvel_members', tok('admin'),
        { sub_account_id: 'SA-CN-1', investor_id: 'INV-CN-A', role: 'member', status: 'active' });
      ok('and cannot add a member either', post.status === 403, JSON.stringify(post.body));
      const del = await call('DELETE', '/api/tables/stokvel_members/SM-CN-1', tok('admin'));
      ok('and cannot remove one', del.status === 403, JSON.stringify(del.body));

      for (const t of ['stokvel_withdrawal_requests', 'stokvel_request_approvals',
                       'stokvel_allocations', 'stokvel_contributions', 'stokvel_payouts']) {
        const w = await call('PATCH', `/api/tables/${t}/anything`, tok('director'), { amount: 1 });
        ok(`nor write to ${t}`, w.status === 403,
           'a vote, an allocation and an obligation are ledger entries: '
           + JSON.stringify(w.body).slice(0, 100));
      }
    }

    /* ══ 4. Tables that are meant to be writable still are ══════════ */
    console.log('\nand the rest of the console is untouched');
    {
      const w = await call('PATCH', '/api/tables/sub_accounts/SA-CN-1', tok('admin'),
                           { name: 'Console Club Renamed' });
      ok('STAFF CAN STILL EDIT WHAT THEY COULD BEFORE',
         w.status === 200 || w.status === 204,
         'the read-only rule must apply to the group’s own tables and '
         + 'nothing else: ' + JSON.stringify(w.body).slice(0, 140));
      await db.query(`UPDATE sub_accounts SET name = 'Console Club' WHERE id = 'SA-CN-1'`);
    }

    /* ══ 5. The screen names people ════════════════════════════════ */
    console.log('\nand the screen names people rather than identifiers');
    {
      const A = strip(read('admin/js/admin.js'));
      ok('there is one helper for a member’s name',
         /function _stokvelMemberName\(id\)/.test(A));
      ok('and openStokvelAdmin fetches the ones it does not have',
         /STATE\.stokvelNames = known/.test(A) && /tables\/investors/.test(A),
         'the console only has the investors its Clients screen loaded');
      ok('THE ROSTER USES IT',
         /_stokvelMemberName\(m\.investor_id\)/.test(A), 'admin/js/admin.js');
      ok('and so do the shares, the exit debts and the attribute list',
         /const name = id => _stokvelMemberName\(id\)/.test(A),
         'one helper, or one of them drifts back to an id');

      ok('AND THE ROSTER OFFERS NO CONTROL THE SERVER REFUSES',
         !/updateStokvelMember\(/.test(A) && !/addStokvelMember\(/.test(A),
         'a dropdown that 403s is the same defect as a button that cannot '
         + 'render');
    }


    /* ══ 6. Driven, not grepped ════════════════════════════════════ */
    console.log('\nand the screen, run rather than read, names them');
    {
      const C = consoleVm();
      const DUE = over => Object.assign(
        { investor_id: 'INV-A', status: 'due', amount_due: '500',
          amount_paid: '0', period_label: '2026-03', due_date: '2026-03-01' },
        over || {});

      ok('THE NAME HELPER RESOLVES AN INVESTOR',
         C.nameOf('INV-A') === 'Precious Nkuna',
         'stokvel_members carries no name columns, so the old helper looked '
         + 'for m.first_name, found nothing and printed the id: '
         + JSON.stringify(C.nameOf('INV-A')));
      ok('and an id it cannot resolve still shows the id',
         C.nameOf('INV-ZZZ') === 'INV-ZZZ',
         'a blank where a name belongs is worse than the identifier: '
         + JSON.stringify(C.nameOf('INV-ZZZ')));

      const w = words(C.activity({ requests: [], members: [], contributions: [
        DUE(),
        /* PART PAID, so the column must be the shortfall and not the
           obligation: R400 raised, R50 handed over, R350 owing. */
        DUE({ investor_id: 'INV-B', amount_due: '400', amount_paid: '50',
              kind: 'fine', period_label: 'FINE-77', note: 'late again',
              due_date: '2026-03-05' }),
        DUE({ status: 'paid', amount_paid: '500', period_label: '2026-02' }),
      ] }));
      ok('AND THE ARREARS SAY WHO OWES WHAT', /Who owes it/.test(w),
         'a total answers "how much", which is never the question on the '
         + 'phone: ' + w.slice(0, 220));
      ok('naming each of them',
         /Precious Nkuna/.test(w) && /Sipho Dlamini/.test(w), w.slice(0, 300));
      ok('with what each one owes, not just the total',
         /R 500\.00/.test(w) && /R 350\.00/.test(w) && /R 850\.00/.test(w),
         w.slice(0, 300));
      ok('and the one already paid is not in the list',
         !/2026-02/.test(w), w.slice(0, 300));
      ok('A FINE READS AS A FINE, not as a period label',
         /Fine \u2014 late again/.test(w) && !/FINE-77/.test(w),
         'FINE-<id> is an identifier; the portal learned that the hard '
         + 'way: ' + w.slice(0, 300));

      const none = words(C.activity({ requests: [], members: [],
        contributions: [DUE({ status: 'paid', amount_paid: '500' })] }));
      ok('and with nothing owing there is no breakdown at all',
         !/Who owes it/.test(none) && /Outstanding contributions/.test(none),
         'an empty table under a heading reads as a loading failure: '
         + none.slice(0, 200));

      const nasty = C.activity({ requests: [], members: [], contributions: [
        DUE({ kind: 'fine', note: '<img src=x onerror=alert(1)>' })] });
      ok('AND A NOTE SOMEBODY TYPED IS DRAWN AS TEXT',
         !/<img/i.test(nasty) && /&lt;img/.test(nasty),
         'the treasurer types this note: ' + nasty.slice(0, 300));
    }

    await clean();
  } catch (err) {
    fail += 1;
    console.log('  ✗ the check itself fell over\n      ' + (err && err.stack || err));
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
