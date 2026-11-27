#!/usr/bin/env node
/* The minimum a group must put into the notice fund, and changing it.
 *
 * IT WAS WRITE-ONCE, which nobody decided. The create form asks for a
 * minimum; after that the fund's only editable field was its status —
 * PATCH read `status` and ignored the rest of the body — and notice_funds
 * is not in ALLOWED_TABLES, so the generic table editor could not reach
 * it either. Changing the figure meant an UPDATE typed against production
 * by hand, on a fund whose every rate change is otherwise logged to
 * notice_fund_rate_log.
 *
 * WHAT IS DELIBERATE AND MUST STAY SO. notice_days is still not editable:
 * a group was told a notice period and it is theirs. The route refusing
 * to change it is a decision, not the same oversight, so this check holds
 * it shut.
 *
 * WHAT A CHANGE MUST NOT DO. The minimum governs money not yet in. It
 * cannot reach into what a group already holds, or a notice already
 * given, and the status must survive a minimum-only save untouched —
 * a PATCH that rebuilt the row from a partial body would quietly close
 * an open fund.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-notice-fund-minimum.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const db   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
/* The comments below quote the rule they replaced, so a scan that reads
   them finds its own explanation and reports the bug as still live. */
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const ADMIN_JS = read('admin/js/admin.js');
const ROUTE    = read('server/routes/noticeFundAdmin.js');
const SETUP    = read('server/db/setup.js');

const FUND = 'NF-MINCHK';

/* ═══════════════════════════════════════════════════════════════════
   1. The console can reach it at all
   ═══════════════════════════════════════════════════════════════════ */
console.log('\nthe minimum is a control, not a printed figure');
{
  const A = strip(ADMIN_JS);
  ok('THERE IS A BOX FOR IT ON THE FUND’S ROW',
     /id="nfMin-\$\{_esc\(f\.id\)\}"/.test(A),
     'it was printed as text beside the notice period, and the only way '
     + 'to change it was to write to the database by hand');
  ok('and a button that saves it',
     /setNoticeFundMinimum\('\$\{_esc\(f\.id\)\}'\)/.test(A));
  ok('and a handler behind the button',
     /async function setNoticeFundMinimum\(id\)/.test(A));
  ok('which PATCHes the fund',
     /API\._fetch\('PATCH', 'admin\/notice-funds\/' \+ id, \{ min_deposit: min \}\)/.test(A));

  /* A FIGURE A GROUP IS HELD TO, and R15 000 and R150 000 are one
     keystroke apart. */
  /* THE GUARD, NOT THE WORD. This matched /confirm\(/ anywhere in the
     handler, so `if (false && confirm(...))` — which saves without ever
     asking — passed it. What matters is that declining stops the save. */
  const saver = A.slice(A.indexOf('setNoticeFundMinimum'),
                        A.indexOf('async function createNoticeFund'));
  ok('AND IT ASKS BEFORE IT SAVES, AND A NO STOPS IT',
     /if \(!confirm\(/.test(saver) && /\)\) return;/.test(saver),
     'a mistyped minimum is a figure every group is then held to: ' + saver.slice(0, 200));
  ok('and refuses a blank or negative figure',
     /raw === '' \|\| !Number\.isFinite\(min\) \|\| min < 0/.test(A),
     'an empty box must not read as zero');

  /* The panel has to say the part people do not expect. */
  ok('and the row says the change applies to new money only',
     /does not touch what a group already holds/.test(ADMIN_JS)
     && /stop a group adding less than this/.test(ADMIN_JS),
     'raising it blocks top-ups below the new figure, which is the '
     + 'surprising half');
  ok('and that the fee is charged on top of it',
     /1% fee is on top of it/.test(ADMIN_JS),
     'the minimum is tested against the amount reaching the fund, not '
     + 'the wallet spend');
}

console.log('\nand the console bundle says it changed');
{
  const m = /js\/admin\.js\?v=(\d+)/.exec(read('admin/index.html'));
  ok('admin.js carries a version', !!m, 'no ?v= on the admin bundle');
  ok('and it is past the one before this change', m && Number(m[1]) >= 247,
     'CLAUDE.md: bump admin/index.html on every admin JS change — '
     + 'the file is served immutable for a year, so a stale stamp means '
     + 'nobody sees this: ' + (m ? m[1] : '?'));
}

console.log('\nand staff are told the control exists');
{
  const at = SETUP.indexOf("'notice-fund-minimum-editable-2026-11'");
  ok('there is a feature_announcements step', at > 0);
  const step = at > 0 ? SETUP.slice(Math.max(0, at - 600), at + 2200) : '';
  ok('inserted ON CONFLICT DO NOTHING', /ON CONFLICT \(id\) DO NOTHING/.test(step));
  ok('AND IT NAMES THE PATH TO IT',
     /Console → Groups \(Stokvels\)/.test(step) && /Minimum in at a time/.test(step),
     'CLAUDE.md: a notice without where_to_find is not worth publishing');
}

/* ═══════════════════════════════════════════════════════════════════
   2. The route, driven
   ═══════════════════════════════════════════════════════════════════ */
(async () => {
  let srv;
  try {
    const { rows: [r] } = await db.query(
      `SELECT to_regclass('public.notice_funds') IS NOT NULL AS ready`);
    if (!r.ready) { console.log('\n  SKIP  no notice_funds table here'); return; }

    const clean = async () => {
      await db.query(`DELETE FROM audit_events WHERE entity_id = $1`, [FUND]).catch(() => {});
      await db.query(`DELETE FROM notice_funds WHERE id = $1`, [FUND]);
    };
    await clean();
    await db.query(
      `INSERT INTO notice_funds (id, name, notice_days, min_deposit, status, created_by)
       VALUES ($1,'Minimum Check Fund',30,0,'draft','check')`, [FUND]);

    const express = require('express');
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));

    const app = express();
    app.use(express.json());
    app.use('/api/admin/notice-funds',
            require(path.join(ROOT, 'server/routes/noticeFundAdmin.js')));
    srv = await new Promise(res => { const x = app.listen(0, () => res(x)); });

    const AS = jwt.sign({ id: 'u-nf', role: 'admin', email: 'fundmgr@example.test' },
                        process.env.JWT_SECRET);
    const call = (method, p, body) => new Promise(res => {
      const http = require('http');
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const q = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign({ Authorization: `Bearer ${AS}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s = ''; x.on('data', c => s += c);
               x.on('end', () => { let b = {}; try { b = JSON.parse(s || '{}'); } catch (_) { b = { raw: s }; }
                                   res({ status: x.statusCode, body: b }); }); });
      q.on('error', e => res({ status: 0, body: { error: e.message } }));
      if (payload) q.write(payload);
      q.end();
    });
    const minOf = async () => Number((await db.query(
      `SELECT min_deposit FROM notice_funds WHERE id = $1`, [FUND])).rows[0].min_deposit);
    const statusOf = async () => (await db.query(
      `SELECT status FROM notice_funds WHERE id = $1`, [FUND])).rows[0].status;

    console.log('\nthe route changes the minimum');
    {
      const r1 = await call('PATCH', `/api/admin/notice-funds/${FUND}`, { min_deposit: 150000 });
      ok('A MINIMUM OF R150 000 IS ACCEPTED AND STORED',
         r1.status === 200 && (await minOf()) === 150000,
         `${r1.status} ${JSON.stringify(r1.body)} — stored ${await minOf()}`);
      ok('and the answer says what it became',
         r1.body.data && Number(r1.body.data.min_deposit) === 150000,
         JSON.stringify(r1.body));

      const cents = await call('PATCH', `/api/admin/notice-funds/${FUND}`, { min_deposit: 1234.567 });
      ok('and a fraction of a cent is not stored as one',
         cents.status === 200 && (await minOf()) === 1234.57, String(await minOf()));
      /* ASSERTED IN THE SOURCE, because behaviour cannot see it:
         min_deposit is NUMERIC(18,2), so the column rounds whatever
         arrives and dropping the rounding here changes no stored value.
         It still matters that the two routes agree — a fund must not be
         created under one rule and amended under another — so the
         invariant is checked where it lives. */
      const rounder = /min = Math\.round\(raw \* 100\) \/ 100;/;
      const creator = /const min  = Math\.round\(\(parseFloat\(b\.min_deposit\) \|\| 0\) \* 100\) \/ 100;/;
      ok('AND THE TWO ROUTES ROUND THE SAME WAY',
         rounder.test(ROUTE) && creator.test(ROUTE),
         'create and amend must not disagree about what a minimum is');

      ok('zero is a real answer, not a missing one',
         (await call('PATCH', `/api/admin/notice-funds/${FUND}`, { min_deposit: 0 })).status === 200
         && (await minOf()) === 0, String(await minOf()));
    }

    console.log('\nand refuses what it should');
    {
      await call('PATCH', `/api/admin/notice-funds/${FUND}`, { min_deposit: 150000 });
      for (const [label, value] of [['a negative minimum', -1],
                                    ['a minimum that is not a number', 'lots']]) {
        const r = await call('PATCH', `/api/admin/notice-funds/${FUND}`, { min_deposit: value });
        ok(`${label} is refused`, r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
      }
      ok('  and the figure is left where it was', (await minOf()) === 150000,
         String(await minOf()));

      const empty = await call('PATCH', `/api/admin/notice-funds/${FUND}`, {});
      ok('a body with nothing in it is refused rather than saved as a no-op',
         empty.status === 400, `${empty.status} ${JSON.stringify(empty.body)}`);

      const gone = await call('PATCH', '/api/admin/notice-funds/NF-NOPE', { min_deposit: 1 });
      ok('and a fund that does not exist is a 404', gone.status === 404,
         `${gone.status} ${JSON.stringify(gone.body)}`);
    }

    console.log('\nand changes nothing it was not asked to');
    {
      /* A PATCH that rebuilt the row from a partial body would close an
         open fund the moment somebody saved a minimum. */
      await db.query(`UPDATE notice_funds SET status = 'open' WHERE id = $1`, [FUND]);
      const r = await call('PATCH', `/api/admin/notice-funds/${FUND}`, { min_deposit: 2000 });
      ok('SAVING A MINIMUM LEAVES THE STATUS ALONE',
         r.status === 200 && (await statusOf()) === 'open',
         `${r.status} — status is now ${await statusOf()}`);
      await db.query(`UPDATE notice_funds SET status = 'draft' WHERE id = $1`, [FUND]);

      /* The notice period is the group's. Not editable, on purpose. */
      /* 60, NOT 7. The column is CHECK (notice_days >= 30), so a PATCH of
         7 was refused by the database and this assertion passed against a
         route that would happily have changed it to anything legal. */
      const days = await call('PATCH', `/api/admin/notice-funds/${FUND}`,
                              { notice_days: 60, min_deposit: 2000 });
      const { rows: [d] } = await db.query(
        `SELECT notice_days FROM notice_funds WHERE id = $1`, [FUND]);
      /* THE SAVE HAS TO HAVE WORKED. Asserting only that notice_days is
         still 30 cannot tell "the route ignored the field" from "the
         route threw and changed nothing" — a 500 leaves the column at 30
         too. So: the minimum in the same body landed, and the period did
         not move. */
      ok('  and the save it was sent with succeeded',
         days.status === 200 && (await minOf()) === 2000,
         `${days.status} ${JSON.stringify(days.body)} — min is ${await minOf()}`);
      ok('AND THE NOTICE PERIOD STILL CANNOT BE CHANGED HERE',
         Number(d.notice_days) === 30,
         `notice_days is now ${d.notice_days} — a group was told a period `
         + 'and it is theirs; the route must ignore the field: '
         + JSON.stringify(days.body));
    }

    console.log('\nand writes down who changed it');
    {
      const has = await db.query(
        `SELECT to_regclass('public.audit_events') IS NOT NULL AS ready`);
      if (!has.rows[0].ready) { console.log('  SKIP  no audit_events table'); }
      else {
        await db.query(`DELETE FROM audit_events WHERE entity_id = $1`, [FUND]);
        await call('PATCH', `/api/admin/notice-funds/${FUND}`, { min_deposit: 150000 });
        /* audit.log is fire-and-forget, so give the insert a moment. */
        await new Promise(r => setTimeout(r, 300));
        const { rows } = await db.query(
          `SELECT event_type, description, user_email, metadata FROM audit_events
            WHERE entity_id = $1 AND event_type = 'notice_fund.minimum_changed'`, [FUND]);
        ok('THE CHANGE IS AUDITED BY NAME', rows.length === 1,
         `${rows.length} rows — until now the record of a minimum changing `
         + 'was a hand-typed UPDATE and nothing at all');
        ok('  naming who did it', rows.length === 1 && /fundmgr@/.test(rows[0].user_email || ''),
           rows.length ? rows[0].user_email : '');
        ok('  and what it was and became',
           rows.length === 1 && /2000\.00/.test(rows[0].description || '')
           && /150000\.00/.test(rows[0].description || ''),
           rows.length ? rows[0].description : '');
        ok('  structured too, not only in the sentence',
           rows.length === 1 && rows[0].metadata
           && Number(JSON.parse(typeof rows[0].metadata === 'string'
                ? rows[0].metadata : JSON.stringify(rows[0].metadata)).after.min_deposit) === 150000,
           rows.length ? JSON.stringify(rows[0].metadata) : '');

        /* SAVING THE SAME FIGURE IS NOT A CHANGE. A panel that re-saves
           on every visit would otherwise fill the audit trail with
           events that record nothing. */
        await db.query(`DELETE FROM audit_events WHERE entity_id = $1`, [FUND]);
        await call('PATCH', `/api/admin/notice-funds/${FUND}`, { min_deposit: 150000 });
        await new Promise(r => setTimeout(r, 300));
        const { rows: again } = await db.query(
          `SELECT 1 FROM audit_events WHERE entity_id = $1
            AND event_type = 'notice_fund.minimum_changed'`, [FUND]);
        ok('and saving the same figure logs nothing', again.length === 0,
           `${again.length} — an audit trail of non-changes is one nobody reads`);
      }
    }

    await clean();
  } catch (e) {
    fail++;
    console.log(`  ✗ the route could not be driven\n      ${e.stack || e.message}`);
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
