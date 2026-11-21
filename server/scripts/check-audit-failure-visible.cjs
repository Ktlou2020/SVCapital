#!/usr/bin/env node
/* An audit row that cannot be written must not vanish quietly.
 *
 * services/audit.js tries twice — once with the actor linked, once with the
 * link dropped, because a non-UUID or deleted actor is the likeliest reason
 * the insert fails. If the second attempt fails too the event was LOST: a
 * console line, and a TODO about routing it to a SIEM.
 *
 * An audit trail that can silently lose rows is the one thing an audit
 * trail cannot be. "Nothing happened" and "something happened and we failed
 * to write it down" have to be distinguishable, and from a console line on
 * a log nobody watches they are not.
 *
 * The sink the TODO was asking for already existed: services/incidents.js
 * folds by fingerprint, throttles, and tells somebody by webhook or email.
 * So a lost event raises a CRITICAL incident, and the incident CARRIES THE
 * EVENT — the point of an audit row is that it can be reconstructed and
 * re-entered by hand, which "an audit write failed" does not allow.
 *
 * THIS IS RUN, not read. The failure is produced for real: audit_events is
 * dropped in this check's own database — every check gets its own clone, so
 * nothing else is affected — and audit.log is then called. Reading the
 * source for the word "incidents" would have passed against a version that
 * reported the failure without the event in it, which is the half that
 * matters.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-audit-failure-visible.cjs
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

/* No OPS_ALERT_* here on purpose: the incident must be RECORDED whether or
   not anybody is configured to be told, and incidents.js says so itself in
   a warning. Setting them would also mean this check tried to send mail. */
delete process.env.OPS_ALERT_EMAIL;
delete process.env.OPS_ALERT_WEBHOOK;

(async () => {
  try {
    const { rows: [r] } = await db.query(
      `SELECT to_regclass('public.platform_incidents') IS NOT NULL AS ready`);
    if (!r.ready) { console.log('\n  SKIP  no platform_incidents table in this database'); return; }

    const audit = require(path.join(ROOT, 'server', 'services', 'audit.js'));

    console.log('\na normal audit write still works');
    {
      await audit.log({
        actorEmail: 'staff@example.test', actorRole: 'admin',
        action: 'check.audit_ok', entityType: 'investors', entityId: 'INV-AUD-1',
        description: 'The ordinary path',
      });
      const { rows } = await db.query(
        `SELECT * FROM audit_events WHERE event_type = 'check.audit_ok'`);
      ok('the row is written', rows.length === 1, `${rows.length} rows`);
      ok('and nothing is reported as an incident',
         !(await db.query(
           `SELECT 1 FROM platform_incidents WHERE source = 'audit.log'`)).rows.length,
         'a successful write must not alarm anybody');
    }

    /* ── The failure, for real ───────────────────────────────────────── */
    console.log('\nand when the row cannot be written at all');
    await db.query('DROP TABLE IF EXISTS audit_events CASCADE');
    {
      let threw = null;
      try {
        await audit.log({
          actorId: 'EMP-7', actorEmail: 'treasurer@example.test', actorRole: 'director',
          action: 'payout.approved', entityType: 'transactions', entityId: 'TXN-AUD-9',
          description: 'R125 000 payout approved',
          before: { status: 'pending' }, after: { status: 'approved' },
          ip: '10.1.2.3', platform: 'admin',
        });
      } catch (e) { threw = e; }

      ok('AUDIT.LOG STILL DOES NOT THROW', !threw,
         threw && threw.message
         + ' — an audit failure must not become the reason a payout fails');

      const { rows } = await db.query(
        `SELECT * FROM platform_incidents WHERE source = 'audit.log'`);
      const inc = rows[0];
      ok('THE LOST EVENT RAISES AN INCIDENT', !!inc,
         'it ended at a console line on a log nobody watches');
      ok('and it is critical, not a warning',
         inc && inc.severity === 'critical', inc && inc.severity);
      ok('and the message names the action that was lost',
         inc && /payout\.approved/.test(inc.message || ''), inc && inc.message);

      /* THE HALF THAT MATTERS. An audit row exists so it can be
         reconstructed; an alert that says only "a write failed" leaves
         nothing to reconstruct it from. */
      const ctx = inc && (typeof inc.context === 'string' ? JSON.parse(inc.context) : inc.context);
      ok('AND IT CARRIES THE WHOLE EVENT, so it can be re-entered by hand',
         !!ctx && ctx.action === 'payout.approved' && ctx.entity_type === 'transactions'
         && ctx.entity_id === 'TXN-AUD-9' && ctx.actor_email === 'treasurer@example.test'
         && ctx.actor_role === 'director' && /R125 000/.test(String(ctx.description || '')),
         JSON.stringify(ctx));
      ok('including the actor who could not be linked',
         !!ctx && ctx.actor_id === 'EMP-7',
         'a staff member authenticated by employee number is exactly the actor '
         + 'whose id is not a UUID, which is why the first insert fails');
      ok('and the before/after it was recording',
         !!ctx && ctx.metadata && ctx.metadata.after && ctx.metadata.after.status === 'approved',
         JSON.stringify(ctx && ctx.metadata));
      ok('and BOTH failures, which are usually different faults',
         !!ctx && !!ctx.link_error && !!ctx.write_error,
         JSON.stringify({ link: ctx && ctx.link_error, write: ctx && ctx.write_error }));
      ok('and when it was lost', !!ctx && /^\d{4}-\d\d-\d\d/.test(String(ctx.lost_at || '')),
         ctx && String(ctx.lost_at));

      /* Folding is what makes this usable rather than a flood: a broken
         audit table fails on every write, and three hundred incidents
         would bury the one fault. */
      await audit.log({ action: 'payout.approved', entityType: 'transactions',
                        entityId: 'TXN-AUD-10', description: 'R98 000 payout approved' });
      const { rows: again } = await db.query(
        `SELECT occurrences FROM platform_incidents WHERE source = 'audit.log'`);
      ok('a second lost event folds into the same incident rather than flooding',
         again.length === 1 && Number(again[0].occurrences) === 2,
         `${again.length} incident(s), ${again[0] && again[0].occurrences} occurrence(s)`);
    }

    /* ── And the wiring that running one case cannot show ───────────── */
    console.log('\nand it is the platform’s own sink, not a new one');
    {
      const SRC = fs.readFileSync(path.join(ROOT, 'server', 'services', 'audit.js'), 'utf8');
      const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      const code = strip(SRC);
      ok('the TODO is gone, because it is done',
         !/TODO/.test(SRC), 'it asked for a SIEM; incidents.js is the sink it wanted');
      ok('incidents is required lazily, not at load time',
         /require\('\.\/incidents'\)\.report/.test(code)
         && !/^const .*require\('\.\/incidents'\)/m.test(code),
         'incidents requires the pool and email requires incidents — a cycle at '
         + 'load time leaves one of them half-built');
      ok('and raising the incident cannot itself throw out of log()',
         /catch \(err3\)/.test(code), code.slice(-400));
    }

  } finally {
    await db.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
