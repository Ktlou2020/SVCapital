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

    /* The shipped resolver, not a copy of it. It moved out of the cron and into
       a service once three other sites turned out to have the same fault. */
    const { staffRecipients } = require(path.join(ROOT, 'server', 'services', 'staffRecipients.js'));
    const alertRecipients = staffRecipients;
    ok('the shared resolver is importable', typeof staffRecipients === 'function',
       'without this the check can only read the source, which is how the bug survived');

    /* Every site that needs a staff list uses the one resolver. A fourth copy
       of the broken query is exactly how this got to four sites. */
    const SITES = [
      [path.join('server', 'jobs', 'withdrawalAlertCron.js'), 'withdrawalAlertCron'],
      [path.join('server', 'jobs', 'directorReportCron.js'),  'directorReportCron'],
      [path.join('server', 'routes', 'tables.js'),            'tables (kyc + leave)'],
    ];
    for (const [rel, label] of SITES) {
      const src = decomment(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      ok(`${label} calls the shared resolver`, /staffRecipients\(\)/.test(src));
      ok(`${label} reports a fallback`, /warnIfNotUsers\(/.test(src),
         'a silent fallback is indistinguishable from a delivery in a log');
      ok(`${label} no longer asks users for a staff role`,
         !/FROM users WHERE role IN \('director'\s*,\s*'admin'\)/.test(src) &&
         !/role IN \('admin', 'director'\)/.test(src),
         'users holds investors — that query has always returned nobody');
    }

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
      /* The reporting moved into the service with the resolver, so the cron
         calls it and the service is what must actually raise the error. Both
         halves are asserted: a call to a function that says nothing is the same
         silence with an extra hop. */
      ok('the cron reports an empty primary source', /warnIfNotUsers\(source, 'withdrawalAlertCron'\)/.test(src),
         'production printed "Alerted 0 admin(s)" on console.log three times a day');
      const svc = decomment(fs.readFileSync(path.join(ROOT, 'server', 'services', 'staffRecipients.js'), 'utf8'));
      ok('and the shared reporter raises it as an error',
         /function warnIfNotUsers[\s\S]{0,300}console\.error/.test(svc),
         'console.log for this reads exactly like a successful delivery');
      ok('it says nothing when the primary source worked',
         /if \(source === 'users'\) return;/.test(svc),
         'a warning on every send trains people to ignore it');
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

    /* ── Standing copies on the withdrawal alert ────────────────────────
       Two people are copied on this alert whether or not they hold a staff
       account. They are additive to whoever staffRecipients() resolves, and
       they must not produce a second copy for somebody already on that list
       — the alert fires three times a day, and a duplicate three times a day
       is how a real alert becomes something people filter away. */
    console.log('\nthe standing copies on the withdrawal alert');
    {
      const SR = require(path.join(ROOT, 'server', 'services', 'staffRecipients.js'));
      const staff = [{ id: 'u1', email: 'kagiso@svcapital.co.za', first_name: 'Kagiso' }];
      const out   = SR.withStandingCopies(staff, 'withdrawal');
      const mails = out.map(r => String(r.email).toLowerCase());

      ok('Odireleng is copied', mails.includes('odireleng@svcapital.co.za'), mails.join(', '));
      ok('Balepi is copied',    mails.includes('balepi@svcapital.co.za'),    mails.join(', '));
      ok('the resolved staff are still there', mails.includes('kagiso@svcapital.co.za'));
      ok('and nobody is added twice', new Set(mails).size === mails.length, mails.join(', '));

      /* The address is written with a capital in one place and lowercase in
         another; they are one person either way. */
      const dup = SR.withStandingCopies(
        [{ id: 'u1', email: 'ODIRELENG@SVCAPITAL.CO.ZA', first_name: 'Odi' }], 'withdrawal');
      ok('somebody already on the list is not copied again, whatever the case',
         dup.filter(r => String(r.email).toLowerCase() === 'odireleng@svcapital.co.za').length === 1,
         JSON.stringify(dup.map(r => r.email)));

      ok('the copies are marked as such, so the log can say so',
         out.filter(r => r.standingCopy).length === 2);
      ok('and they carry a name, so the email does not open "Hi there"',
         out.filter(r => r.standingCopy).every(r => /^[A-Z][a-z]+$/.test(r.first_name || '')),
         JSON.stringify(out.filter(r => r.standingCopy).map(r => r.first_name)));

      ok('a local part that is not a plain name falls back rather than mangling',
         SR.nameFromEmail('finance.team@x.co') === null &&
         SR.nameFromEmail('ops-2@x.co') === null &&
         SR.nameFromEmail('Balepi@x.co') === 'Balepi');

      /* Only this alert. FICA, leave and the director report resolve their
         recipients the same way and were not asked for. */
      ok('no other notification gains these recipients',
         SR.withStandingCopies(staff, 'fica').length === 1 &&
         SR.withStandingCopies(staff, 'director_report').length === 1);

      const prev = process.env.WITHDRAWAL_ALERT_ALSO;
      try {
        process.env.WITHDRAWAL_ALERT_ALSO = 'someone@else.co';
        const overridden = SR.withStandingCopies(staff, 'withdrawal').map(r => r.email);
        ok('the list can be changed without a deploy',
           overridden.includes('someone@else.co') &&
           !overridden.some(e => /odireleng/i.test(e)), JSON.stringify(overridden));
        process.env.WITHDRAWAL_ALERT_ALSO = '';
        ok('and switched off entirely',
           SR.withStandingCopies(staff, 'withdrawal').length === 1);
      } finally {
        if (prev === undefined) delete process.env.WITHDRAWAL_ALERT_ALSO;
        else process.env.WITHDRAWAL_ALERT_ALSO = prev;
      }

      const cron = fs.readFileSync(
        path.join(ROOT, 'server', 'jobs', 'withdrawalAlertCron.js'), 'utf8');
      ok('the cron actually mails the combined list, not the resolved one',
         /const admins = withStandingCopies\(staff, 'withdrawal'\)/.test(cron) &&
         /for \(const admin of admins\)/.test(cron),
         'building the list and then mailing something else is the whole failure this check exists for');
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
