'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   node-cron, with somebody watching.

   Seventeen jobs run unattended on this server: maturities, payouts,
   interest, recurring investments, FICA re-checks, statements, stokvel
   contributions. Each of them caught its own errors, logged a line, and
   carried on. Nothing anywhere knew whether a job had run at all.

   Those are two different failures and only one of them is noisy. A job that
   THROWS at least leaves a stack in a log. A job that silently stops being
   scheduled — a container that restarted badly, a timezone that moved it off
   the end of the day, a require that failed at boot — produces no exception,
   no log line and no incident. Just maturities that are never paid, and a
   client who finds out before we do.

   So every job is wrapped here instead: a heartbeat either side of each run,
   any throw turned into an incident, and the heartbeat row carrying how long
   this job may go quiet before that is itself a fault. The sweep that reads
   those rows is in services/incidents.

   Jobs use this by requiring it in place of node-cron. check-job-watch fails
   the build if one goes back to requiring node-cron directly, because the
   one that does is exactly the one nobody will notice has stopped.
   ───────────────────────────────────────────────────────────────────────── */

const path      = require('path');
const cron      = require('node-cron');
const incidents = require('../services/incidents');

/* Who is calling, taken from the stack rather than asked for. Passing a name
   at every call site is a thing to forget, and a job named wrongly is worse
   than one named automatically — "maturityCron" is what the file is called
   and what anybody reading an alert will search for. */
function _callerJob() {
  const orig = Error.prepareStackTrace;
  try {
    const e = {};
    Error.prepareStackTrace = (_, frames) => frames;
    Error.captureStackTrace(e, _callerJob);
    for (const frame of e.stack || []) {
      const file = frame.getFileName && frame.getFileName();
      if (file && file !== __filename && !file.includes('node:')) {
        return path.basename(file).replace(/\.js$/, '');
      }
    }
  } catch (_) { /* fall through */ }
  finally { Error.prepareStackTrace = orig; }
  return 'unknown-job';
}

/* How long this schedule may reasonably go quiet.

   A HEURISTIC, and deliberately a generous one: the cost of guessing too
   tight is a false alarm at 3am, which teaches people to ignore alarms. Read
   off the coarsest field that is pinned, then doubled with an hour added, so
   a daily job has to miss two days before anybody is woken. */
function periodMinutes(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length < 5) return null;
  const [minute, hour, dom, , dow] = f;
  if (dom !== '*') return 44640;        // monthly
  if (dow !== '*') return 10080;        // weekly
  if (hour !== '*' && !hour.includes('*/')) return 1440;  // daily
  if (hour.includes('*/')) {
    const every = Number(hour.split('*/')[1]) || 1;
    return every * 60;
  }
  if (minute !== '*') return 60;        // hourly
  return 1;                             // every minute
}

function maxSilenceFor(expr) {
  const p = periodMinutes(expr);
  return p == null ? null : p * 2 + 60;
}

/* The same signature node-cron has, so a job changes its require and
   nothing else. opts.job overrides the derived name; opts.maxSilenceMinutes
   overrides the derived allowance; opts.watch === false opts a job out,
   which exists for the sweep itself. */
function schedule(expr, fn, opts = {}) {
  const job = opts.job || _callerJob();
  const maxSilenceMinutes = opts.watch === false ? null
    : (opts.maxSilenceMinutes != null ? opts.maxSilenceMinutes : maxSilenceFor(expr));

  const wrapped = async (...args) => {
    if (opts.watch === false) return fn(...args);
    return incidents.runJob(job, () => fn(...args), { maxSilenceMinutes });
  };

  /* node-cron is given only the options it knows about. */
  const { job: _j, maxSilenceMinutes: _m, watch: _w, ...cronOpts } = opts;
  return cron.schedule(expr, wrapped, cronOpts);
}

module.exports = { ...cron, schedule, periodMinutes, maxSilenceFor, _callerJob };
