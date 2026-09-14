#!/usr/bin/env node
/* A pending withdrawal alert always reaches somebody, and the COO seed stops
 * failing on every boot.
 *
 * Production ran this three times a day:
 *
 *     [withdrawalAlertCron] Alerted 0 admin(s) — 3 pending withdrawal(s).
 *
 * at info level. Three clients were waiting on their money and no email went
 * anywhere, because the recipient query asked `users WHERE role IN
 * ('admin','director')` and production has nobody with either role. An alert
 * that reaches nobody is worse than no alert at all: the log reads like it
 * worked.
 *
 * The same boot also failed step 6 every single time:
 *
 *     ❌ 6. Seed COO employee record for:
 *        duplicate key value violates unique constraint "employees_pkey"
 *        Key (id)=(EMP-COO-001) already exists.
 *
 * because the statement hardcoded that id and its ON CONFLICT named `email`,
 * which cannot catch a primary key collision. Some other employee holds that
 * id in production — so the fix must not take it from them.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-withdrawal-alert-reach.cjs
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
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const db   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const CRON = fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'withdrawalAlertCron.js'), 'utf8');
const decomment = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const clearStaff = async () => {
  await db.query(`DELETE FROM users WHERE email LIKE '%@alertchk.test'`);
  await db.query(`DELETE FROM employees WHERE email LIKE '%@alertchk.test'`);
};

(async () => {
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

    /* The shipped resolver, not a copy of it. */
    const { alertRecipients } = require(path.join(ROOT, 'server', 'jobs', 'withdrawalAlertCron.js'));
    ok('the job exposes how it picks recipients', typeof alertRecipients === 'function',
       'without this the check can only read the source, which is how the bug survived');

    /* Anything already in the database would decide the answer before the
       fixtures do — this check has to own the whole staff list. */
    const { rows: [{ n: realUsers }] } = await db.query(
      `SELECT count(*)::int n FROM users WHERE role IN ('admin','director','fund_manager')`);
    const { rows: [{ n: realStaff }] } = await db.query(
      `SELECT count(*)::int n FROM employees WHERE level IN ('executive','lead') AND COALESCE(status,'')='active'`);
    await db.query(`UPDATE users SET role = 'chk_parked' WHERE role IN ('admin','director','fund_manager')`);
    await db.query(`UPDATE employees SET level = 'chk_parked' WHERE level IN ('executive','lead')`);
    await clearStaff();

    console.log('\nwith nobody at all, the alert still goes somewhere');
    {
      const r = await alertRecipients();
      ok('a recipient is produced', r.to.length === 1, JSON.stringify(r));
      ok('and it is named as a fallback', r.source === 'fallback', r.source);
      ok('not an empty list', r.to.every(x => x.email && x.email.includes('@')), JSON.stringify(r.to));
    }

    console.log('\nsenior staff are asked before the fallback');
    {
      await db.query(
        `INSERT INTO employees (id, first_name, last_name, email, role, level, status)
         VALUES ('EMP-ALERTCHK-1','Ops','Lead','ops@alertchk.test','COO','executive','active')`);
      const r = await alertRecipients();
      ok('the employee is used', r.source === 'employees' && r.to.length === 1, JSON.stringify(r));
      ok('with the address the email needs', r.to[0].email === 'ops@alertchk.test', JSON.stringify(r.to));

      /* A resigned employee is not an escalation path. */
      await db.query(`UPDATE employees SET status = 'inactive' WHERE email = 'ops@alertchk.test'`);
      const r2 = await alertRecipients();
      ok('an inactive one is skipped', r2.source === 'fallback', r2.source);
      await db.query(`UPDATE employees SET status = 'active' WHERE email = 'ops@alertchk.test'`);
    }

    console.log('\nbut a staff user wins over both');
    {
      for (const [email, role] of [['a@alertchk.test','admin'], ['d@alertchk.test','director'], ['f@alertchk.test','fund_manager']]) {
        await db.query(
          `INSERT INTO users (email, password_hash, role, first_name, last_name)
           VALUES ($1, 'x', $2, 'Chk', 'User')`, [email, role]);
      }
      const r = await alertRecipients();
      ok('users are preferred', r.source === 'users', r.source);
      /* fund_manager is a staff role everywhere else in this codebase and was
         the only one this query left out. */
      ok('and fund_manager is one of them',
         r.to.some(x => x.email === 'f@alertchk.test'),
         JSON.stringify(r.to.map(x => x.email)));
      ok('along with admin and director',
         ['a@alertchk.test','d@alertchk.test'].every(e => r.to.some(x => x.email === e)),
         JSON.stringify(r.to.map(x => x.email)));
    }

    console.log('\nreaching nobody is reported as a failure, not as a send');
    {
      const src = decomment(CRON);
      ok('an empty primary source logs an error',
         /if \(source !== 'users'\) \{[\s\S]{0,200}console\.error/.test(src),
         'production printed "Alerted 0 admin(s)" on console.log three times a day');
      ok('and the count line says where they came from',
         /recipient\(s\) from \$\{source\}/.test(src),
         '"Alerted 3 admin(s)" does not tell you the fallback caught it');
      ok('the old admin-only query is gone',
         !/role IN \('admin', 'director'\) AND email IS NOT NULL/.test(src));
    }

    console.log('\nthe COO seed survives an id that belongs to someone else');
    {
      await db.query(`DELETE FROM employees WHERE email = 'coo@svcapital.co.za'`);
      await db.query(`DELETE FROM employees WHERE id = 'EMP-COO-001'`);
      /* Exactly production's shape: EMP-COO-001 taken, by a different person. */
      await db.query(
        `INSERT INTO employees (id, first_name, last_name, email, role, level, status)
         VALUES ('EMP-COO-001','Someone','Else','someone.else@alertchk.test','Analyst','junior','active')`);

      const warned = [];
      const w = console.warn, l = console.log;
      console.warn = (...a) => warned.push(a.join(' '));
      console.log  = (...a) => warned.push(a.join(' '));
      let res;
      try {
        delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
        res = await require(path.join(ROOT, 'server', 'db', 'setup.js'))();
      } finally { console.warn = w; console.log = l; }

      ok('step 6 no longer fails',
         !(res.failures || []).some(f => /COO employee record/.test(f.name)),
         JSON.stringify(res.failures));

      const { rows: [other] } = await db.query(
        `SELECT email FROM employees WHERE id = 'EMP-COO-001'`);
      ok("and the other employee keeps their id",
         other && other.email === 'someone.else@alertchk.test',
         JSON.stringify(other) + ' — a seed must never take a real staff record');

      const { rows: [coo] } = await db.query(
        `SELECT id, level, status FROM employees WHERE email = 'coo@svcapital.co.za'`);
      ok('the COO record still gets created', !!coo, 'under a different id');
      ok('under an id of its own', coo && coo.id !== 'EMP-COO-001', JSON.stringify(coo));
      ok('as an active executive', coo && coo.level === 'executive' && coo.status === 'active', JSON.stringify(coo));
      ok('and the collision is explained in the log',
         warned.some(x => /EMP-COO-001 already belongs to/.test(x)),
         warned.filter(x => /COO/.test(x)).join(' | ') || '(nothing said)');
    }

    console.log('\nand an existing COO row is updated rather than re-inserted');
    {
      const before = (await db.query(`SELECT count(*)::int n FROM employees WHERE email = 'coo@svcapital.co.za'`)).rows[0].n;
      await db.query(`UPDATE employees SET level = 'junior', status = 'inactive' WHERE email = 'coo@svcapital.co.za'`);

      delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
      const res2 = await (async () => {
        const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {};
        try { return await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); }
        finally { console.log = l; console.warn = w; }
      })();

      ok('the step passes on a second boot',
         !(res2.failures || []).some(f => /COO employee record/.test(f.name)),
         JSON.stringify(res2.failures));
      const after = (await db.query(`SELECT count(*)::int n, min(level) lvl, min(status) st FROM employees WHERE email = 'coo@svcapital.co.za'`)).rows[0];
      ok('no duplicate row appears', after.n === before, `${before} → ${after.n}`);
      ok('and the record is put back the way it should be',
         after.lvl === 'executive' && after.st === 'active',
         JSON.stringify(after));
    }

    await clearStaff();
    await db.query(`DELETE FROM employees WHERE id = 'EMP-COO-001'`);
    await db.query(`UPDATE users SET role = 'director' WHERE role = 'chk_parked'`).catch(() => {});
    await db.query(`UPDATE employees SET level = 'executive' WHERE level = 'chk_parked'`).catch(() => {});
    if (realUsers || realStaff) console.log(`  (restored ${realUsers} user(s) and ${realStaff} employee(s) parked for this check)`);

  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
