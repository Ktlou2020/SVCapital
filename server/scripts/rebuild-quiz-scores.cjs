#!/usr/bin/env node
/* Rebuild course_progress.quiz_scores from the activity feed.
 *
 * WHY THIS IS NEEDED
 *
 * quiz_scores is JSONB, so node-pg returns it as an object. Every reader in the
 * employee portal did JSON.parse(prog.quiz_scores || '{}'), which throws on an
 * object, and every one of them caught the throw and returned {}. So each save
 * wrote only the module just finished and discarded the ones before it.
 *
 * The row therefore remembers at most ONE module — the last one passed. That is
 * why nobody could finish a course: modules_completed never got past 1.
 *
 * The passes themselves were not lost. completeModule wrote an activity_feed
 * row for every module it saved:
 *
 *   type  = 'course_complete'
 *   title = 'Module completed: <module title>'
 *   body  = '+<xp> XP earned in <course title>'
 *
 * That is enough to rebuild which modules each employee actually passed.
 *
 * WHAT IT CANNOT RECOVER
 *
 * The mark. The feed records that a module was passed, not what was scored, and
 * quiz_scores only ever held the last one. Reconstructed entries are therefore
 * written at the course's pass_score — the only figure the evidence supports.
 * Any real score still on the row is preserved as-is and never overwritten.
 * overall_quiz_score is recomputed from the mix, so it will read low for anyone
 * repaired this way. That is honest: the true average is not recoverable.
 *
 * XP IS NOT TOUCHED. awardXP ran at the time regardless of the failed save, and
 * course_progress.xp_earned is an INT that round-tripped correctly, so it is
 * already right. Re-awarding here would double it.
 *
 * SAFETY
 *
 * Read-only by default, inside an explicit READ ONLY transaction, so a bug in
 * this file cannot write. It reports what it would change and stops. Writing
 * requires --apply, which runs the whole repair in one transaction that rolls
 * back on any error.
 *
 *   node server/scripts/rebuild-quiz-scores.cjs                  # audit, writes nothing
 *   node server/scripts/rebuild-quiz-scores.cjs --apply          # repair
 *   node server/scripts/rebuild-quiz-scores.cjs --employee E-1   # scope to one person
 *   node server/scripts/rebuild-quiz-scores.cjs --no-complete    # fill scores, never finish a course
 */
'use strict';

const { Pool } = require('pg');

const ARGV        = process.argv.slice(2);
const APPLY       = ARGV.includes('--apply');
const NO_COMPLETE = ARGV.includes('--no-complete');
const ONLY_EMP    = (i => i > -1 ? ARGV[i + 1] : null)(ARGV.indexOf('--employee'));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 2,
});

const money = n => Number(n).toFixed(0);

/* The same three shapes the portal's _courseScores handles: the object the
   driver returns, the '{}' the employee portal seeds, the '[]' director.js did.
   An array carries no per-module scores, so it normalises to empty. */
function readScores(raw) {
  if (!raw) return {};
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { return {}; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return v;
}

/* '+52 XP earned in Welcome to SV Capital' → { xp: 52, course: 'Welcome to SV Capital' }
   The course title is taken as everything after the LAST ' XP earned in ', so a
   course whose own title contains that phrase still resolves. */
function parseBody(body) {
  if (typeof body !== 'string') return null;
  const at = body.lastIndexOf(' XP earned in ');
  if (at < 0) return null;
  const xp = parseInt((body.slice(0, at).match(/\+?(\d+)\s*$/) || [])[1], 10);
  const course = body.slice(at + ' XP earned in '.length).trim();
  if (!course) return null;
  return { xp: isNaN(xp) ? null : xp, course };
}

(async () => {
  const client = await pool.connect();
  let exitCode = 0;
  try {
    await client.query(`SET statement_timeout = '120s'`);
    await client.query('BEGIN');
    if (!APPLY) await client.query('SET TRANSACTION READ ONLY');

    console.log(APPLY
      ? '\nREBUILDING quiz scores from the activity feed — writing.\n'
      : '\nAUDIT ONLY — this transaction is READ ONLY and will write nothing.\n');

    const { rows: courses } = await client.query(
      `SELECT id, title, COALESCE(pass_score, 60) AS pass_score FROM employee_courses`);
    const { rows: modules } = await client.query(
      `SELECT id, course_id, title, module_index, COALESCE(xp_reward, 50) AS xp_reward
         FROM course_modules`);
    const { rows: progress } = await client.query(
      `SELECT p.*, e.first_name, e.last_name
         FROM course_progress p
         LEFT JOIN employees e ON e.id = p.employee_id
        ${ONLY_EMP ? 'WHERE p.employee_id = $1' : ''}`,
      ONLY_EMP ? [ONLY_EMP] : []);
    const { rows: feed } = await client.query(
      `SELECT employee_id, title, body, created_at
         FROM activity_feed
        WHERE type = 'course_complete'
          AND title LIKE 'Module completed: %'
          ${ONLY_EMP ? 'AND employee_id = $1' : ''}
        ORDER BY created_at ASC`,
      ONLY_EMP ? [ONLY_EMP] : []);

    console.log(`${courses.length} courses, ${modules.length} modules, ` +
                `${progress.length} progress rows, ${feed.length} module-completion feed entries\n`);

    /* Title → courses. Titles are not unique by constraint, so a duplicate is
       reported rather than guessed at. */
    const coursesByTitle = new Map();
    for (const c of courses) {
      const k = c.title.trim().toLowerCase();
      if (!coursesByTitle.has(k)) coursesByTitle.set(k, []);
      coursesByTitle.get(k).push(c);
    }
    const modsByCourse = new Map();
    for (const m of modules) {
      if (!modsByCourse.has(m.course_id)) modsByCourse.set(m.course_id, []);
      modsByCourse.get(m.course_id).push(m);
    }
    for (const list of modsByCourse.values())
      list.sort((a, b) => (a.module_index || 0) - (b.module_index || 0));

    /* ── Resolve every feed entry to (employee, course, module) ──────── */
    const evidence = new Map();          // `${empId}::${courseId}` → Map(modId → created_at)
    const unresolved = [];
    let resolved = 0;

    for (const row of feed) {
      const modTitle = row.title.slice('Module completed: '.length).trim();
      const parsed   = parseBody(row.body);
      if (!parsed) { unresolved.push({ row, why: 'body does not name a course' }); continue; }

      const hits = coursesByTitle.get(parsed.course.trim().toLowerCase()) || [];
      if (hits.length === 0) { unresolved.push({ row, why: `no course titled "${parsed.course}"` }); continue; }
      if (hits.length > 1)   { unresolved.push({ row, why: `${hits.length} courses share the title "${parsed.course}"` }); continue; }
      const course = hits[0];

      let cands = (modsByCourse.get(course.id) || [])
        .filter(m => m.title.trim().toLowerCase() === modTitle.toLowerCase());
      /* Two modules in one course may share a title. The feed also carries the
         XP the module was worth, which usually separates them. */
      if (cands.length > 1 && parsed.xp != null) {
        const byXp = cands.filter(m => Number(m.xp_reward) === parsed.xp);
        if (byXp.length === 1) cands = byXp;
      }
      if (cands.length === 0) { unresolved.push({ row, why: `no module "${modTitle}" in ${course.id}` }); continue; }
      if (cands.length > 1)   { unresolved.push({ row, why: `"${modTitle}" is ambiguous within ${course.id}` }); continue; }

      const key = `${row.employee_id}::${course.id}`;
      if (!evidence.has(key)) evidence.set(key, new Map());
      const seen = evidence.get(key);
      /* A module completed twice keeps the FIRST pass — that is when it was
         genuinely earned. */
      if (!seen.has(cands[0].id)) seen.set(cands[0].id, row.created_at);
      resolved++;
    }

    console.log(`resolved ${resolved} of ${feed.length} feed entries to a module`);
    if (unresolved.length) {
      console.log(`\n${unresolved.length} could not be resolved and are IGNORED:`);
      const grouped = new Map();
      for (const u of unresolved) grouped.set(u.why, (grouped.get(u.why) || 0) + 1);
      for (const [why, n] of [...grouped].sort((a, b) => b[1] - a[1]).slice(0, 12))
        console.log(`   ${String(n).padStart(4)} × ${why}`);
    }

    /* ── Work out the change for each progress row ───────────────────── */
    const plan = [];
    for (const p of progress) {
      const mods = modsByCourse.get(p.course_id) || [];
      if (!mods.length) continue;                       // nothing to reconstruct against
      const course = courses.find(c => c.id === p.course_id);
      if (!course) continue;

      const existing = readScores(p.quiz_scores);
      const known    = evidence.get(`${p.employee_id}::${p.course_id}`) || new Map();

      const rebuilt = { ...existing };
      const added   = [];
      for (const [modId] of known) {
        if (rebuilt[modId] === undefined) {
          rebuilt[modId] = Number(course.pass_score);   // the only figure the evidence supports
          added.push(modId);
        }
      }
      /* Only modules this course still has. A key left by a module that was
         later regenerated must not count towards completion. */
      const modIds    = mods.map(m => m.id);
      const doneNow   = modIds.filter(id => rebuilt[id] !== undefined).length;
      const doneBefore= modIds.filter(id => existing[id] !== undefined).length;
      const allDone   = doneNow >= mods.length;
      const marks     = modIds.map(id => Number(rebuilt[id])).filter(n => !isNaN(n));

      const willComplete = allDone && p.status !== 'completed' && !NO_COMPLETE;
      if (!added.length && doneNow === doneBefore && !willComplete) continue;

      const stamps = [...known.values()].filter(Boolean).sort();
      plan.push({
        p, course, added, doneBefore, doneNow, total: mods.length, willComplete,
        updates: {
          quiz_scores:        JSON.stringify(rebuilt),
          modules_completed:  doneNow,
          current_module:     willComplete ? mods.length : Math.min(doneNow + 1, mods.length),
          overall_quiz_score: marks.length ? Math.round(marks.reduce((a, b) => a + b, 0) / marks.length) : 0,
          ...(willComplete ? {
            status:         'completed',
            completed_at:   (stamps[stamps.length - 1] || new Date()),
            certificate_id: p.certificate_id || `CERT-${p.employee_id}-${p.course_id}-${Date.now()}`,
            kpi_applied:    true,
          } : {}),
        },
      });
    }

    if (!plan.length) {
      console.log('\nNothing to rebuild — no progress row gains a module from the feed.');
    } else {
      console.log(`\n${plan.length} progress row(s) would change:\n`);
      const byEmp = new Map();
      for (const it of plan) {
        const who = `${it.p.first_name || ''} ${it.p.last_name || ''}`.trim() || it.p.employee_id;
        if (!byEmp.has(who)) byEmp.set(who, []);
        byEmp.get(who).push(it);
      }
      for (const [who, items] of [...byEmp].sort()) {
        console.log(`  ${who}`);
        for (const it of items) {
          const mark = it.willComplete ? '  ← COMPLETES, certificate issued' : '';
          console.log(`     ${it.course.title}`);
          console.log(`        modules passed ${it.doneBefore}/${it.total} → ${it.doneNow}/${it.total}` +
                      `   (+${it.added.length} from the feed, at pass_score ${money(it.course.pass_score)})${mark}`);
        }
      }
      const completing = plan.filter(i => i.willComplete).length;
      console.log(`\n  ${plan.length} rows repaired, ${completing} course(s) would be marked complete.`);
      if (completing && !NO_COMPLETE)
        console.log('  Pass --no-complete to fill the scores without finishing any course.');
    }

    if (APPLY && plan.length) {
      for (const it of plan) {
        const keys = Object.keys(it.updates);
        const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        await client.query(
          `UPDATE course_progress SET ${sets}, updated_at = NOW() WHERE id = $${keys.length + 1}`,
          [...keys.map(k => it.updates[k]), it.p.id]);
      }
      await client.query('COMMIT');
      console.log(`\nApplied. ${plan.length} row(s) updated in one transaction.`);
      console.log('XP was NOT touched — it was awarded at the time and is already correct.');
    } else {
      await client.query('ROLLBACK');
      console.log(APPLY
        ? '\nNothing to apply.'
        : '\nNo changes were made. Re-run with --apply to write them.');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nFailed, nothing was written:', err.message);
    exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
    process.exit(exitCode);
  }
})();
