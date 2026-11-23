#!/usr/bin/env node
/* A stokvel arrives with its members already written down.
 *
 * It has existed for nine years. The roster is in a WhatsApp group, or a
 * book, or the treasurer's notes. Inviting them one at a time — a name, an
 * email and a cell number, twenty times — is the difference between "we did
 * it at the meeting" and "we will do it sometime", and sometime does not
 * come. The committee is only ever all in one room for an hour.
 *
 * TWO HALVES, both held here:
 *
 *   THE PARSER, which has to be forgiving about shape and strict about
 *   substance. Nobody exports a tidy CSV from a WhatsApp group: the paste
 *   has commas or tabs or pipes, the fields come in any order, and some
 *   lines have an email, some a cell, some both. What it must never do is
 *   quietly drop a line — a committee that pastes twenty and sends
 *   seventeen has no way of knowing which three are missing.
 *
 *   THE ROUTE, where each row is its own transaction. One duplicate in a
 *   pasted list must not roll back the nineteen that were fine, or the
 *   committee pastes the lot again and the server refuses all twenty.
 *
 * Run: DATABASE_URL=… node server/scripts/check-group-roster.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const vm   = require('vm');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function portal() {
  const ctx = { window: {}, document: { getElementById: () => null },
                location: { search: '' },
                localStorage: { getItem: () => null, setItem() {} },
                sessionStorage: { getItem: () => null, setItem() {} },
                Utils: { rand: n => 'R ' + Number(n || 0).toFixed(2) },
                encodeURIComponent, console };
  vm.createContext(ctx);
  vm.runInContext(read('js/portal-core.js'), ctx);
  ctx._esc = v => String(v == null ? '' : v);
  return ctx;
}

/* ══ 1. The parser, driven ═════════════════════════════════════════ */
console.log('\na pasted roster is read the way a pasted roster actually looks');
{
  const P = portal();
  const parse = t => P._svParseRoster(t);

  const basic = parse('Bongani Zulu, bongani@example.co.za, 082 999 0002');
  ok('a name, an email and a cell on one line',
     basic.length === 1 && basic[0].name === 'Bongani Zulu'
     && basic[0].email === 'bongani@example.co.za'
     && basic[0].cell === '082 999 0002' && !basic[0].problem,
     JSON.stringify(basic));

  ok('AND THE ORDER DOES NOT MATTER',
     (() => { const r = parse('082 999 0002; bongani@example.co.za; Bongani Zulu')[0];
              return r.name === 'Bongani Zulu' && r.email === 'bongani@example.co.za'
                     && r.cell === '082 999 0002'; })(),
     'the email is whichever piece has an @ in it and the cell is whichever '
     + 'is a run of digits — not column one, two and three');

  for (const [sep, label] of [[',', 'commas'], ['\t', 'tabs'], [';', 'semicolons'], ['|', 'pipes']]) {
    const r = parse(['Nomsa Dlamini', 'nomsa@example.co.za', '0834441234'].join(sep))[0];
    ok(`${label} separate`, r && r.name === 'Nomsa Dlamini' && !r.problem, JSON.stringify(r));
  }

  ok('a cell on its own is enough',
     (() => { const r = parse('Nomsa Dlamini, 083 444 1234')[0];
              return r.cell === '083 444 1234' && !r.email && !r.problem; })(),
     'half a stokvel has no email address, and an invitation can reach a cell');
  ok('and an email on its own is enough',
     (() => { const r = parse('Thabo Mokoena, thabo@example.co.za')[0];
              return r.email === 'thabo@example.co.za' && !r.cell && !r.problem; })());

  ok('BLANK LINES ARE NOT PEOPLE',
     parse('A, a@b.co\n\n\nB, b@b.co').length === 2,
     'a pasted list is full of them');
  ok('and the line number is the line in the paste, not the row in the table',
     parse('A, a@b.co\n\n\nB, b@b.co')[1].line === 4,
     'a committee fixing line 4 has to find line 4');

  /* What must be refused, each for its own reason. */
  ok('A LINE WITH NO WAY TO REACH ANYBODY IS A PROBLEM, NOT A PERSON',
     /No email address or cell number/.test(parse('Just A Name')[0].problem),
     'there is nowhere to send the invitation');
  ok('a line with no name is a problem',
     /No name/.test(parse('thabo@example.co.za')[0].problem),
     'the group would see an invitation to nobody');
  ok('and an address that is not one is a problem',
     /does not look right/.test(parse('Bad, not@an, 0821112222')[0].problem),
     JSON.stringify(parse('Bad, not@an, 0821112222')[0]));

  ok('THE SAME PERSON TWICE IS A SLIP, AND IS SAID SO BEFORE IT IS SENT',
     /on the list twice/.test(parse('A, a@b.co\nA again, a@b.co')[1].problem),
     'the server would refuse it anyway; saying so first is the difference '
     + 'between a tidy list and twenty rows of red');
  ok('and a duplicate is caught on the cell as well as the email',
     /on the list twice/.test(parse('Nomsa, 083 444 1234\nNomsa D, nomsa@b.co, 0834441234')[1].problem),
     'a roster kept in two places arrives with the same person in two shapes');
  ok('AND +27 IS THE SAME NUMBER AS 0',
     /on the list twice/.test(parse('Zodwa, +27 82 111 2222\nZodwa again, 0821112222')[1].problem),
     'one of them is how it is saved on a phone and the other is how it is typed');
  ok('but two different people are two different people',
     !parse('A, a@b.co, 0821112222\nB, b@b.co, 0831112222')[1].problem);

  ok('nothing at all parses to nobody',
     parse('').length === 0 && parse(null).length === 0 && parse(undefined).length === 0,
     'the form must not offer to send an empty list');
}

/* ══ 2. The route, against a real database ═════════════════════════ */
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});
const sent = [];
function stub() {
  return new Proxy({}, { get(_t, k) {
    if (typeof k !== 'string' || k === 'then' || k === 'inspect') return undefined;
    return (...a) => { sent.push({ fn: k, args: a }); return Promise.resolve({ ok: true }); };
  } });
}
for (const f of ['email.js', 'pushService.js', 'sms.js', 'stokvelNotify.js']) {
  const p = path.join(ROOT, 'server', 'services', f);
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: stub() };
}

(async () => {
  let srv;
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.stokvel_invites') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no stokvel tables here'); return; }

    const clean = async () => {
      await db.query(`DELETE FROM stokvel_invites  WHERE sub_account_id LIKE 'SA-RO-%'`);
      await db.query(`DELETE FROM stokvel_members  WHERE sub_account_id LIKE 'SA-RO-%'`);
      await db.query(`DELETE FROM sub_accounts     WHERE id LIKE 'SA-RO-%'`);
      await db.query(`DELETE FROM investors        WHERE id LIKE 'INV-RO-%'`);
    };
    await clean();

    await db.query(
      `INSERT INTO investors (id, first_name, last_name, email, phone, status, wallet_balance)
       VALUES ('INV-RO-CHAIR','Lindiwe','Nkosi','lindiwe.ro@example.test','0829990501','active',0),
              ('INV-RO-MEM','Plain','Member','plain.ro@example.test','0829990502','active',0)`);
    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, kyc_status, status, stokvel_quorum, share_basis)
       VALUES ('SA-RO-1','INV-RO-CHAIR','stokvel','Ikhaya',0,'approved','active',2,'contribution')`);
    await db.query(
      `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
       VALUES ('SM-RO-1','SA-RO-1','INV-RO-CHAIR','chairperson',true,'active',NOW()),
              ('SM-RO-2','SA-RO-1','INV-RO-MEM','member',false,'active',NOW())`);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });

    const tok = id => jwt.sign({ id: 'u-' + id, role: 'investor', investorId: id },
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
    const bulk = (who, people) =>
      call('POST', '/api/stokvels/SA-RO-1/invites/bulk', tok(who), { people });

    console.log('\nand a whole roster goes in one go');
    {
      const r = await bulk('INV-RO-CHAIR', [
        { name: 'Bongani Zulu',  email: 'bongani.ro@example.test', cell: '0829990601' },
        { name: 'Nomsa Dlamini', email: '',                        cell: '0829990602' },
        { name: 'Thabo Mokoena', email: 'thabo.ro@example.test',   cell: '' },
      ]);
      ok('three invitations are sent', r.status === 201 && r.body.data.sent.length === 3,
         JSON.stringify(r.body));
      ok('and none is skipped', r.body.data.skipped.length === 0, JSON.stringify(r.body.data.skipped));
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM stokvel_invites WHERE sub_account_id = 'SA-RO-1'`);
      ok('AND THEY ARE REALLY THERE', rows[0].n === 3, String(rows[0].n));
      ok('and every one of them was told about', sent.filter(s => s.fn === 'invited').length === 3,
         'an invitation nobody hears about is a row in a table: '
         + JSON.stringify(sent.map(s => s.fn)));
      ok('and the contact comes back masked',
         r.body.data.sent.every(s => s.contact && !/bongani\.ro@example\.test/.test(JSON.stringify(s.contact))),
         'the roster being shared is not a reason to publish an address: '
         + JSON.stringify(r.body.data.sent));
    }

    console.log('\nand one bad row does not take the good ones with it');
    {
      sent.length = 0;
      const r = await bulk('INV-RO-CHAIR', [
        { name: 'Bongani Zulu', email: 'bongani.ro@example.test', cell: '0829990601' },
        { name: 'Sipho Ndlovu', email: 'sipho.ro@example.test',   cell: '0829990603' },
        { name: 'Nobody',       email: '',                        cell: '' },
      ]);
      ok('THE GOOD ONE IS STILL SENT',
         r.body.data.sent.length === 1 && r.body.data.sent[0].invitee_name === 'Sipho Ndlovu',
         'each row is its own transaction, or a committee pastes twenty and '
         + 'gets nothing: ' + JSON.stringify(r.body.data));
      ok('and the two that could not be are named with a reason',
         r.body.data.skipped.length === 2
         && r.body.data.skipped.every(s => typeof s.reason === 'string' && s.reason),
         JSON.stringify(r.body.data.skipped));
      ok('AND EACH ONE SAYS WHICH LINE IT WAS',
         r.body.data.skipped.map(s => s.at).join(',') === '0,2',
         'a committee fixing a list has to know which rows to fix: '
         + JSON.stringify(r.body.data.skipped));
      ok('and only the one that was sent was notified',
         sent.filter(s => s.fn === 'invited').length === 1,
         JSON.stringify(sent.map(s => s.fn)));
    }

    console.log('\nand it is the committee’s to do');
    {
      const r = await bulk('INV-RO-MEM', [{ name: 'X', email: 'x.ro@example.test', cell: '' }]);
      ok('A PLAIN MEMBER CANNOT INVITE THE WHOLE ROSTER',
         r.status === 403,
         'the single-invite route is the committee’s; a bulk door that was '
         + 'not would be the way round it: ' + JSON.stringify(r.body));
      const outsider = await call('POST', '/api/stokvels/SA-RO-1/invites/bulk',
        jwt.sign({ id: 'u-x', role: 'investor', investorId: 'INV-RO-NOBODY' },
                 process.env.JWT_SECRET, { expiresIn: '1h' }),
        { people: [{ name: 'X', email: 'y.ro@example.test' }] });
      ok('and somebody outside the group cannot see it at all',
         outsider.status === 404, JSON.stringify(outsider.body));
    }

    console.log('\nand a mistaken paste cannot send a thousand');
    {
      const many = Array.from({ length: 51 }, (_, i) =>
        ({ name: 'P' + i, email: `p${i}.ro@example.test`, cell: '' }));
      const r = await bulk('INV-RO-CHAIR', many);
      ok('FIFTY AT A TIME IS THE MOST', r.status === 400 && /Fifty/.test(r.body.error || ''),
         JSON.stringify(r.body));
      const empty = await bulk('INV-RO-CHAIR', []);
      ok('and an empty list is refused', empty.status === 400, JSON.stringify(empty.body));
    }

    console.log('\nand nobody is made a signatory twenty at a time');
    {
      await db.query(`DELETE FROM stokvel_invites WHERE sub_account_id = 'SA-RO-1'`);
      await bulk('INV-RO-CHAIR', [
        { name: 'Zodwa Khumalo', email: 'zodwa.ro@example.test', cell: '', as_signatory: true },
      ]);
      const { rows } = await db.query(
        `SELECT as_signatory FROM stokvel_invites WHERE sub_account_id = 'SA-RO-1'`);
      ok('A BULK ROW CANNOT NOMINATE A SIGNATORY',
         rows.length === 1 && rows[0].as_signatory === false,
         'one at a time it is a deliberate act with the founding state '
         + 'checked in front of the person doing it; twenty at a time it is '
         + 'a checkbox nobody read: ' + JSON.stringify(rows));
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
