#!/usr/bin/env node
/* When something breaks, somebody finds out.
 *
 * Every error on this platform went to console.error and nowhere else. The
 * Express handler logged a line and returned a 500. unhandledRejection
 * logged a stack. Seventeen crons each caught, logged and carried on. All of
 * it landed in a log nobody watches, so the first person to know a payout
 * had failed was the client whose money had not arrived.
 *
 * Two failures, and only one of them is noisy. A job that THROWS at least
 * leaves a stack. A job that silently stops being scheduled produces no
 * exception, no log line and no incident at all — which is why heartbeats
 * exist alongside the error reporting and are checked just as hard here.
 *
 * Run: DATABASE_URL=… node server/scripts/check-incidents.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const incidents = require(path.join(ROOT, 'server', 'services', 'incidents.js'));

console.log('the same fault twice is one incident, not two');
{
  const a = incidents.fingerprintOf({ source: 'job:maturityCron', severity: 'error',
    message: 'investment INV-3041 not found' });
  const b = incidents.fingerprintOf({ source: 'job:maturityCron', severity: 'error',
    message: 'investment INV-9977 not found' });
  ok('ids are folded out of the message', a === b,
     'a loop over three hundred investors is three hundred incidents, and the '
     + 'one real fault is invisible among them');
  /* With a NUMERIC id the digit rule folds it anyway, so this is the case
     that actually tests the id rule: two ids that differ in letters. */
  ok('including ids that are not just a number',
     incidents.fingerprintOf({ source: 's', message: 'unknown pool POOL-CATTLE-NOV' })
     === incidents.fingerprintOf({ source: 's', message: 'unknown pool POOL-SOLAR-MAR' }));

  const c = incidents.fingerprintOf({ source: 'job:maturityCron', severity: 'error',
    message: 'could not reach the bank' });
  ok('but a different fault is a different incident', a !== c);

  const d = incidents.fingerprintOf({ source: 'POST /api/withdrawals', severity: 'error',
    message: 'investment INV-3041 not found' });
  ok('and the same message from somewhere else is too', a !== d,
     'where it happened is part of what it is');

  ok('amounts are folded out as well',
     incidents.fingerprintOf({ source: 's', message: 'wallet short by R1 200,50' })
     === incidents.fingerprintOf({ source: 's', message: 'wallet short by R95,00' }));
  ok('and dates',
     incidents.fingerprintOf({ source: 's', message: 'no rate posted for 2026-11-02' })
     === incidents.fingerprintOf({ source: 's', message: 'no rate posted for 2025-01-14' }));
  ok('a quoted value is not what makes two faults different',
     incidents.fingerprintOf({ source: 's', message: 'unknown pool "Cattle November"' })
     === incidents.fingerprintOf({ source: 's', message: 'unknown pool "Solar March"' }));
}

console.log('\nand every unattended job is watched');
{
  const jobsDir = path.join(ROOT, 'server', 'jobs');
  const jobs = fs.readdirSync(jobsDir).filter(f => /Cron\.js$/.test(f));
  ok('there are jobs to watch', jobs.length > 10, `${jobs.length} found`);

  const direct = jobs.filter(f => /require\('node-cron'\)/.test(read(`server/jobs/${f}`)));
  ok('no job schedules itself straight through node-cron',
     direct.length === 0,
     direct.join(', ') + '\n      require(\'./_watched\') instead — the one that '
     + 'does not is exactly the one nobody will notice has stopped');

  const watched = read('server/jobs/_watched.js');
  ok('the wrapper records a heartbeat either side of a run',
     /incidents\.runJob\(/.test(watched));
  ok('and derives how long each job may go quiet from its own schedule',
     /function maxSilenceFor/.test(watched) && /periodMinutes/.test(watched));

  /* The heuristic itself, because a wrong allowance is either a false alarm
     at 3am or a job down for a week that nobody hears about. */
  const m = incidents => incidents;
  const W = require(path.join(ROOT, 'server', 'jobs', '_watched.js'));
  ok('a daily job is allowed about two days', W.maxSilenceFor('0 4 * * *') === 1440 * 2 + 60,
     String(W.maxSilenceFor('0 4 * * *')));
  ok('an hourly job about two hours', W.maxSilenceFor('17 * * * *') === 60 * 2 + 60,
     String(W.maxSilenceFor('17 * * * *')));
  ok('a weekly job about two weeks', W.maxSilenceFor('0 7 * * 2') === 10080 * 2 + 60,
     String(W.maxSilenceFor('0 7 * * 2')));
  ok('and a monthly job about two months', W.maxSilenceFor('0 4 1 * *') === 44640 * 2 + 60,
     String(W.maxSilenceFor('0 4 1 * *')));
  ok('an every-N-hours job is read as N hours, not as daily',
     W.maxSilenceFor('0 */4 * * *') === 240 * 2 + 60,
     String(W.maxSilenceFor('0 */4 * * *')));

  const sweep = read('server/jobs/heartbeatCron.js');
  ok('the sweep does not claim to watch itself',
     /cron\.schedule\([\s\S]{0,800}\{ watch: false/.test(sweep),
     'a sweep that has stopped cannot notice that it has stopped, and '
     + 'pretending otherwise is the most misleading green light on the platform');
  ok('and it is started at boot', /startHeartbeatCron\(\)/.test(read('server/index.js')));
}

console.log('\nand the places errors actually surface are wired in');
{
  const idx = read('server/index.js');
  ok('the express error handler records before it answers',
     /app\.use\(\(err, req, res, _next\) => \{[\s\S]{0,400}incidents\.report\(/.test(idx));
  ok('a background promise that rejects is recorded',
     /unhandledRejection[\s\S]{0,400}incidents\.report\(/.test(idx));
  ok('and so is a crash, before the process goes down',
     /uncaughtException[\s\S]{0,500}incidents\.report\(/.test(idx));
  ok('but recording a crash cannot become what hangs the shutdown',
     /Promise\.race\(\[[\s\S]{0,300}setTimeout/.test(idx),
     'a reporter that never resolves would turn a crash into a hang');
}

console.log('\nand a client is never shown any of it');
{
  const ops = read('server/routes/opsconsole.js');
  ok('the incidents feed is behind the admin guard',
     /router\.get\('\/incidents', requireAuth, requireRole\(\.\.\.ADMIN_OR_DIRECTOR\)/.test(ops),
     'a stack trace names internal files and a context carries whichever '
     + 'route threw; neither is a client’s business');
  ok('and so is marking one dealt with',
     /router\.patch\('\/incidents\/:id', requireAuth, requireRole\(\.\.\.ADMIN_OR_DIRECTOR\)/.test(ops));
}

(async () => {
  if (!process.env.DATABASE_URL) {
    fail++;
    console.log('\n  ✗ the recording half needs a database');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  const pool = require(path.join(ROOT, 'server', 'db', 'pool.js'));
  try {
    console.log('\nand it actually records, folds and throttles');
    const err = new Error('investment INV-1234 could not be matured');
    const first  = await incidents.report(err, { source: 'job:checkCron', severity: 'error' });
    ok('the first occurrence is recorded', !!first && Number(first.occurrences) === 1,
       JSON.stringify(first && { o: first.occurrences }));
    ok('and somebody is told about it', !!first && first.should_notify === true);

    const second = await incidents.report(
      new Error('investment INV-9999 could not be matured'),
      { source: 'job:checkCron', severity: 'error' });
    ok('the same fault again is the same row, counted',
       !!second && second.fingerprint === first.fingerprint
       && Number(second.occurrences) === 2,
       JSON.stringify(second && { f: second.fingerprint === first.fingerprint, o: second.occurrences }));
    ok('and nobody is told a second time',
       !!second && second.should_notify === false,
       'an alerting system that floods is one people turn off, and a system '
       + 'people turn off is the one we already had');

    await pool.query(
      `UPDATE platform_incidents SET resolved_at = NOW(), resolved_by = 'someone'
        WHERE fingerprint = $1`, [first.fingerprint]);
    const third = await incidents.report(
      new Error('investment INV-7777 could not be matured'),
      { source: 'job:checkCron', severity: 'error' });
    ok('a fault that was marked dealt with and happens again is open again',
       !!third && third.resolved_at === null && third.should_notify === true,
       'somebody said it was handled and it was not; staying closed would be '
       + 'the system agreeing with them');

    console.log('\nand a job that simply stops is noticed');
    await incidents.jobFinished('checkFakeJob', { maxSilenceMinutes: 60 });
    let late = await incidents.overdueJobs();
    ok('a job that has just run is not overdue',
       !late.some(j => j.job === 'checkFakeJob'), JSON.stringify(late.map(j => j.job)));

    await pool.query(
      `UPDATE job_heartbeats SET last_finished_at = NOW() - INTERVAL '5 hours'
        WHERE job = 'checkFakeJob'`);
    late = await incidents.overdueJobs();
    const mine = late.find(j => j.job === 'checkFakeJob');
    ok('one that has gone quiet past its own allowance is',
       !!mine && Math.round(Number(mine.quiet_minutes)) >= 290,
       JSON.stringify(late.map(j => ({ j: j.job, q: Math.round(Number(j.quiet_minutes)) }))));

    await incidents.sweepOverdueJobs();
    const { rows: raised } = await pool.query(
      `SELECT severity, message FROM platform_incidents WHERE source = 'heartbeat:checkFakeJob'`);
    ok('and the sweep raises it as a critical incident',
       raised.length === 1 && raised[0].severity === 'critical',
       JSON.stringify(raised));
    ok('saying how long it has been down and how often it should run',
       /minutes/.test(raised[0] ? raised[0].message : '')
       && /at least every/.test(raised[0] ? raised[0].message : ''),
       raised[0] && raised[0].message);

    /* A job down for a week must not send an alert an hour for ever. */
    await incidents.sweepOverdueJobs();
    const { rows: again } = await pool.query(
      `SELECT occurrences FROM platform_incidents WHERE source = 'heartbeat:checkFakeJob'`);
    ok('a job that stays down is still one incident',
       again.length === 1 && Number(again[0].occurrences) === 2,
       JSON.stringify(again));

    console.log('\nand reporting never makes things worse');
    const broken = { query: () => Promise.reject(new Error('database is gone')) };
    const saved = pool.query;
    pool.query = broken.query;
    let threw = null;
    try { await incidents.report(new Error('while the database is down'), { source: 'x' }); }
    catch (e) { threw = e; }
    pool.query = saved;
    ok('an error raised while recording an error is swallowed',
       threw === null,
       'the reporter throwing inside the error handler replaces one fault '
       + 'with two and loses the original');
  } catch (e) {
    fail++;
    console.log(`  ✗ the recording half threw\n      ${e.stack || e.message}`);
  } finally {
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
