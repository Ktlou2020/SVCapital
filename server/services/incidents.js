'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   incidents — what broke, and telling somebody.

   Every error on this platform went to console.error and nowhere else. The
   Express error handler logged a line and returned a 500. unhandledRejection
   logged a stack. The FICA, maturity, payout, interest and recurring crons
   each caught, logged, and carried on. All of it landed in a log nobody
   watches, so the first person to know a payout had failed was the client
   whose money had not arrived.

   Three things are needed and only three:

   FOLDING. The same fault in a loop is one incident with a count, not ten
   thousand rows and ten thousand emails. Incidents are keyed by a
   FINGERPRINT derived from where it happened and what the message looks
   like once the variable parts are taken out — ids, amounts, timestamps and
   quoted values — so "investment INV-3 not found" and "investment INV-9 not
   found" are one fault seen twice.

   THROTTLING. Somebody is told the first time a fingerprint appears, and at
   most once an hour after that. An alerting system that floods is one people
   turn off, and a system people turn off is the one we already had.

   NOT MAKING THINGS WORSE. Reporting must never throw, never block the
   request it is reporting on, and never recurse — an error raised while
   recording an error is swallowed to the console, which is exactly where we
   started and exactly the right place for that one case.

   Where alerts go is a setting, not a vendor: OPS_ALERT_EMAIL for email and
   OPS_ALERT_WEBHOOK for anything that takes a JSON POST (Slack, Teams, a
   pager). Both can be set, neither has to be, and nothing here depends on an
   account anybody has to go and open.
   ───────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');
const pool   = require('../db/pool');

const ALERT_EMAIL   = (process.env.OPS_ALERT_EMAIL || '').trim();
const ALERT_WEBHOOK = (process.env.OPS_ALERT_WEBHOOK || '').trim();
const THROTTLE_MIN  = Number(process.env.OPS_ALERT_THROTTLE_MINUTES || 60);

const SEVERITIES = ['warning', 'error', 'critical'];

/* What makes two errors the same error.

   Ids, amounts, dates, hex blobs and quoted values are the parts that differ
   between occurrences of one fault, so they come out before fingerprinting.
   Without this, a loop over three hundred investors is three hundred
   incidents and the one real fault is invisible among them. */
function _normalise(message) {
  return String(message || '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[A-Z]{2,6}-[A-Z0-9-]{4,}\b/g, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?\b/g, '<date>')
    /* No \b at the front: in "R1 200,50" the digit follows a letter, so a
       word boundary never matches there and only "200,50" was folded,
       leaving "R1 <n>" and "R95,<n>" as two different faults. A run of
       digits with separators only ever BETWEEN digits, instead. */
    .replace(/\d+(?:[  ,.]\d+)*/g, '<n>')
    .replace(/"[^"]*"|'[^']*'/g, '<v>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

function fingerprintOf({ source, message, severity }) {
  const basis = `${severity || 'error'}|${source || 'unknown'}|${_normalise(message)}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

/* The one thing a reporter must never do is throw. Anything that goes wrong
   in here goes to the console — which is where every error went before this
   module existed, and is the right floor to fall back to. */
function _swallow(what, err) {
  try { console.error(`[incidents] ${what}:`, err && err.message ? err.message : err); }
  catch (_) { /* nothing left to try */ }
}

/* Record an occurrence, and say whether this is the moment to tell somebody.
   Returns the row, or null if it could not be written — the caller never
   depends on either. */
async function report(err, context = {}) {
  try {
    const severity = SEVERITIES.includes(context.severity) ? context.severity : 'error';
    const message  = String(
      (err && err.message) || (typeof err === 'string' ? err : '') || 'Unknown error'
    ).slice(0, 2000);
    const stack = err && err.stack ? String(err.stack).slice(0, 8000) : null;
    const source = String(context.source || 'unknown').slice(0, 120);
    const fingerprint = fingerprintOf({ source, message, severity });

    /* One statement: the row is created or its counters move, and the
       decision to notify is made by the database rather than by reading and
       then writing, which two workers would both win. */
    const { rows } = await pool.query(
      `INSERT INTO platform_incidents
         (id, fingerprint, severity, source, message, stack, context,
          occurrences, first_seen, last_seen, notified_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, 1, NOW(), NOW(), NULL)
       ON CONFLICT (fingerprint) DO UPDATE SET
         occurrences = platform_incidents.occurrences + 1,
         last_seen   = NOW(),
         severity    = EXCLUDED.severity,
         message     = EXCLUDED.message,
         stack       = COALESCE(EXCLUDED.stack, platform_incidents.stack),
         context     = EXCLUDED.context,
         /* The decision to notify is made HERE, against the row as it was
            before this update, and recorded by clearing notified_at. It
            cannot be made in RETURNING: there the table already refers to
            the updated row, so "was it resolved before this happened" reads
            as "is it resolved now", which this statement has just set to
            NULL — and a fault somebody wrongly marked dealt with would come
            back silently. */
         notified_at = CASE
           WHEN platform_incidents.notified_at IS NULL
             OR platform_incidents.notified_at < NOW() - ($7 || ' minutes')::interval
             OR platform_incidents.resolved_at IS NOT NULL
           THEN NULL ELSE platform_incidents.notified_at END,
         /* A resolved incident that happens again is open again: somebody
            said it was dealt with and it was not. */
         resolved_at = NULL,
         resolved_by = NULL
       RETURNING *, (notified_at IS NULL) AS should_notify`,
      [fingerprint, severity, source, message, stack,
       JSON.stringify(context.details || context.detail || null),
       String(THROTTLE_MIN)]
    );

    const row = rows[0];
    if (!row) return null;

    /* The console line stays. Logs are still where somebody reading a
       deploy looks first, and this one now carries the fingerprint so a log
       line and an incident can be matched up. */
    console.error(`[incident ${fingerprint}] ${severity} in ${source}: ${message}`);

    if (row.should_notify) {
      await pool.query(
        'UPDATE platform_incidents SET notified_at = NOW() WHERE fingerprint = $1',
        [fingerprint]
      ).catch(e => _swallow('could not stamp notified_at', e));
      /* Not awaited: telling somebody must not hold up the request that
         went wrong, and a failed send must not become a second incident. */
      setImmediate(() => _notify(row).catch(e => _swallow('notify failed', e)));
    }
    return row;
  } catch (e) {
    _swallow('could not record an incident', e);
    return null;
  }
}

async function _notify(row) {
  const title = `[SV Capital] ${row.severity} in ${row.source}`;
  const body  = [
    row.message,
    '',
    `Seen ${row.occurrences} time(s), first at ${row.first_seen}.`,
    row.context ? `Context: ${JSON.stringify(row.context)}` : null,
    '',
    (row.stack || '').split('\n').slice(0, 12).join('\n'),
  ].filter(Boolean).join('\n');

  if (ALERT_WEBHOOK) {
    try {
      await fetch(ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `${title}\n${body}`, incident: {
          fingerprint: row.fingerprint, severity: row.severity,
          source: row.source, message: row.message, occurrences: row.occurrences } }),
      });
    } catch (e) { _swallow('webhook', e); }
  }

  if (ALERT_EMAIL) {
    try {
      /* Required here rather than at the top: email.js requires the pool and
         a circular require at load time leaves one of the two half-built. */
      const email = require('./email');
      if (typeof email.sendOpsAlert === 'function') {
        await email.sendOpsAlert(ALERT_EMAIL, { subject: title, body });
      }
    } catch (e) { _swallow('email', e); }
  }

  if (!ALERT_WEBHOOK && !ALERT_EMAIL) {
    /* Said once per incident, not per occurrence, and it is itself the
       thing somebody should act on: the incident is recorded and visible in
       the console, but nobody was told. */
    console.warn('[incidents] no OPS_ALERT_EMAIL or OPS_ALERT_WEBHOOK set — '
      + `incident ${row.fingerprint} was recorded but nobody was told`);
  }
}

/* ─── Heartbeats ──────────────────────────────────────────────────────────
   An error that is reported is the easy half. A cron that simply stops
   running reports nothing at all — no exception, no log line, no incident,
   just maturities that are never paid. So each job says when it started and
   when it finished, and anything overdue becomes an incident of its own. */

async function jobStarted(job) {
  try {
    await pool.query(
      `INSERT INTO job_heartbeats (job, last_started_at, runs)
       VALUES ($1, NOW(), 0)
       ON CONFLICT (job) DO UPDATE SET last_started_at = NOW()`, [job]);
  } catch (e) { _swallow(`heartbeat start for ${job}`, e); }
}

async function jobFinished(job, { error = null, startedAt = null, maxSilenceMinutes = null } = {}) {
  try {
    const ms = startedAt ? Date.now() - new Date(startedAt).getTime() : null;
    await pool.query(
      `INSERT INTO job_heartbeats
         (job, last_started_at, last_finished_at, last_error, last_duration_ms,
          runs, failures, max_silence_minutes)
       VALUES ($1, NOW(), NOW(), $2, $3, 1, $4, $5)
       ON CONFLICT (job) DO UPDATE SET
         last_finished_at = NOW(),
         last_error       = $2,
         last_duration_ms = COALESCE($3, job_heartbeats.last_duration_ms),
         runs             = job_heartbeats.runs + 1,
         failures         = job_heartbeats.failures + $4,
         max_silence_minutes = COALESCE($5, job_heartbeats.max_silence_minutes)`,
      [job, error ? String(error).slice(0, 2000) : null, ms, error ? 1 : 0, maxSilenceMinutes]);
  } catch (e) { _swallow(`heartbeat finish for ${job}`, e); }
}

/* Run a job with both halves wired: the heartbeat either side, and any
   throw turned into an incident rather than an unhandled rejection. The
   job's own internal error handling is untouched; this is the outer net. */
async function runJob(job, fn, { maxSilenceMinutes = null } = {}) {
  const startedAt = new Date();
  await jobStarted(job);
  try {
    const out = await fn();
    await jobFinished(job, { startedAt, maxSilenceMinutes });
    return out;
  } catch (err) {
    await jobFinished(job, { startedAt, maxSilenceMinutes, error: err && err.message });
    await report(err, { source: `job:${job}`, severity: 'critical',
                        details: { job, startedAt } });
    return null;
  }
}

/* Which jobs have gone quiet for longer than they said they would. Returns
   them rather than reporting them, so the caller decides — the sweep that
   runs this is itself a job, and a sweep that raised incidents while being
   tested would be its own problem. */
async function overdueJobs(now = new Date()) {
  try {
    const { rows } = await pool.query(
      `SELECT job, last_finished_at, max_silence_minutes, last_error,
              EXTRACT(EPOCH FROM ($1::timestamptz - COALESCE(last_finished_at, last_started_at))) / 60
                AS quiet_minutes
         FROM job_heartbeats
        WHERE max_silence_minutes IS NOT NULL
          AND COALESCE(last_finished_at, last_started_at)
              < $1::timestamptz - (max_silence_minutes || ' minutes')::interval
        ORDER BY quiet_minutes DESC`, [now]);
    return rows;
  } catch (e) { _swallow('overdue sweep', e); return []; }
}

/* The sweep itself: one incident per job that has gone quiet. Folded like
   any other, so a job that stays down does not send an email every hour
   for ever — it sends one, then one an hour at most, and the occurrence
   count says how long it has been down. */
async function sweepOverdueJobs(now = new Date()) {
  const late = await overdueJobs(now);
  for (const j of late) {
    await report(
      new Error(`${j.job} has not finished for ${Math.round(j.quiet_minutes)} minutes, `
        + `and should run at least every ${j.max_silence_minutes}`),
      { source: `heartbeat:${j.job}`, severity: 'critical',
        details: { job: j.job, lastFinishedAt: j.last_finished_at, lastError: j.last_error } });
  }
  return late;
}

module.exports = {
  report, fingerprintOf, _normalise,
  jobStarted, jobFinished, runJob,
  overdueJobs, sweepOverdueJobs,
  SEVERITIES,
};
