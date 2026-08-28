#!/usr/bin/env node
/* The quiz-score rebuild must reconstruct only what the feed proves.
 *
 * The damage this repairs: quiz_scores is JSONB, the portal read it with
 * JSON.parse, that threw on the object the driver returns, and every catch
 * returned {} — so each save wrote only the module just finished. Rows remember
 * one module; the earlier passes survive only in activity_feed.
 *
 * Two things make this script dangerous enough to check hard rather than eyeball:
 * it awards certificates, and it is pointed at production by hand. So the
 * fixture below rebuilds the exact damage — a row holding one module, a feed
 * holding three — and then asserts on what the script does to it, including
 * that the audit path physically cannot write.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-rebuild-quiz-scores.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const SCRIPT = path.join(__dirname, 'rebuild-quiz-scores.cjs');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function run(args) {
  try {
    return execFileSync('node', [SCRIPT, ...args],
      { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  } catch (err) {
    return (err.stdout || '') + (err.stderr || '');
  }
}

const CRS = 'CHK-RQ-CRS', EMP = 'CHK-RQ-EMP', PRG = 'CHK-RQ-PRG';
const MODS = [
  { id: 'CHK-RQ-M1', idx: 1, title: 'Our Mission, Vision & Values', xp: 45 },
  { id: 'CHK-RQ-M2', idx: 2, title: 'How SV Capital Makes Money',   xp: 52 },
  { id: 'CHK-RQ-M3', idx: 3, title: 'Your Role in Our Growth Story', xp: 53 },
];
const COURSE_TITLE = 'CHK Welcome to SV Capital';

async function cleanup() {
  await pool.query(`DELETE FROM activity_feed   WHERE employee_id = $1`, [EMP]).catch(() => {});
  await pool.query(`DELETE FROM course_progress WHERE employee_id = $1`, [EMP]).catch(() => {});
  await pool.query(`DELETE FROM course_modules  WHERE course_id LIKE 'CHK-RQ-%'`).catch(() => {});
  await pool.query(`DELETE FROM employee_courses WHERE id LIKE 'CHK-RQ-%'`).catch(() => {});
  await pool.query(`DELETE FROM employees       WHERE id = $1`, [EMP]).catch(() => {});
}

/* The damage, exactly as the portal produced it: three modules genuinely
   passed, three feed rows written, and a progress row that remembers only the
   last one because every read before it threw. */
async function seed({ feedModules = MODS, courseId = CRS, courseTitle = COURSE_TITLE } = {}) {
  await cleanup();
  await pool.query(
    `INSERT INTO employees (id, first_name, last_name, email, status, role)
     VALUES ($1,'Rebuild','Fixture','chk-rq@example.test','active','staff')`, [EMP]);
  await pool.query(
    `INSERT INTO employee_courses (id, title, description, pass_score, modules_count, is_required)
     VALUES ($1, $2, 'fixture', 60, 3, true)`, [courseId, courseTitle]);
  for (const m of MODS) {
    await pool.query(
      `INSERT INTO course_modules (id, course_id, module_index, title, xp_reward)
       VALUES ($1,$2,$3,$4,$5)`, [m.id, courseId, m.idx, m.title, m.xp]);
  }
  await pool.query(
    `INSERT INTO course_progress
       (id, employee_id, course_id, status, current_module, modules_completed,
        quiz_scores, overall_quiz_score, xp_earned, kpi_applied, started_at)
     VALUES ($1,$2,$3,'in_progress',1,to_jsonb(1),$4,0,150,false,NOW())`,
    [PRG, EMP, courseId, JSON.stringify({ [MODS[2].id]: 100 })]);

  let t = Date.parse('2026-08-20T09:00:00Z');
  for (const m of feedModules) {
    await pool.query(
      `INSERT INTO activity_feed (employee_id, type, title, body, icon, color, xp_shown, is_public, created_at)
       VALUES ($1,'course_complete',$2,$3,'fa-graduation-cap','#eda5ff',$4,false,$5)`,
      [EMP, `Module completed: ${m.title}`, `+${m.xp} XP earned in ${courseTitle}`,
       m.xp, new Date(t += 3600000).toISOString()]);
  }
}

const readProg = async () => (await pool.query(
  `SELECT * FROM course_progress WHERE id = $1`, [PRG])).rows[0];

(async () => {
  try {
    const { rows: t } = await pool.query(
      `SELECT to_regclass('course_progress') a, to_regclass('activity_feed') b,
              to_regclass('course_modules') c, to_regclass('employee_courses') d`);
    if (!t[0].a || !t[0].b || !t[0].c || !t[0].d) {
      console.log('  SKIP  course tables not present in this database');
      await pool.end(); process.exit(0);
    }

    console.log('\nthe audit reports the repair and writes nothing');
    {
      await seed();
      const before = await readProg();
      const out = run([]);

      ok('it says it is read only', /READ ONLY and will write nothing/.test(out), out.slice(0, 300));
      ok('it resolves all three feed entries',
         /resolved 3 of 3 feed entries/.test(out), out.slice(0, 600));
      ok('it reports the row going from 1 of 3 to 3 of 3',
         /modules passed 1\/3 → 3\/3/.test(out), out);
      ok('and names the two modules it recovered',
         /\+2 from the feed, at pass_score 60/.test(out), out);
      ok('it flags that the course would complete',
         /← COMPLETES, certificate issued/.test(out), out);
      ok('it names the employee, not just an id',
         /Rebuild Fixture/.test(out), out.slice(-800));

      const after = await readProg();
      ok('the row is untouched by the audit',
         JSON.stringify(after.quiz_scores) === JSON.stringify(before.quiz_scores) &&
         after.status === before.status &&
         String(after.modules_completed) === String(before.modules_completed),
         `before ${JSON.stringify(before.quiz_scores)} after ${JSON.stringify(after.quiz_scores)}`);
    }

    console.log('\n--apply rebuilds the row');
    {
      await seed();
      const before = await readProg();
      const out = run(['--apply']);
      ok('it reports writing', /Applied\. 1 row\(s\) updated/.test(out), out.slice(-400));

      const after = await readProg();
      const scores = after.quiz_scores;
      ok('all three modules are recorded', Object.keys(scores).length === 3, JSON.stringify(scores));
      ok('the module that already had a real score keeps it',
         scores[MODS[2].id] === 100,
         'a reconstructed pass_score must never overwrite a mark that survived');
      ok('the recovered ones are written at the pass score, not invented',
         scores[MODS[0].id] === 60 && scores[MODS[1].id] === 60, JSON.stringify(scores));
      ok('modules_completed matches', Number(after.modules_completed) === 3, String(after.modules_completed));
      ok('the course is marked complete', after.status === 'completed', after.status);
      ok('a certificate id is issued', /^CERT-/.test(after.certificate_id || ''), after.certificate_id);
      ok('completed_at is the last pass in the feed, not now',
         after.completed_at && new Date(after.completed_at).getUTCFullYear() === 2026 &&
         new Date(after.completed_at).getUTCDate() === 20,
         String(after.completed_at));
      ok('current_module lands on the last module', Number(after.current_module) === 3,
         String(after.current_module));
      ok('overall_quiz_score is the mean of what is known',
         Number(after.overall_quiz_score) === 73, String(after.overall_quiz_score));

      ok('XP is not re-awarded', Number(after.xp_earned) === Number(before.xp_earned),
         `${before.xp_earned} → ${after.xp_earned} — awardXP already ran at the time`);
    }

    console.log('\nit is idempotent');
    {
      const first  = await readProg();
      const out    = run(['--apply']);
      const second = await readProg();
      ok('a second run finds nothing to do',
         /Nothing to rebuild/.test(out) || /Nothing to apply/.test(out), out.slice(-300));
      ok('and changes nothing',
         JSON.stringify(second.quiz_scores) === JSON.stringify(first.quiz_scores) &&
         second.certificate_id === first.certificate_id,
         'a re-run must not mint a second certificate');
    }

    console.log('\nit reconstructs only what the feed proves');
    {
      /* Two of three modules in the feed: the row must be repaired to 2/3 and
         must NOT be completed. Awarding a certificate for a module nobody has
         evidence of passing is the worst thing this script could do. */
      await seed({ feedModules: [MODS[0], MODS[2]] });
      run(['--apply']);
      const after = await readProg();
      ok('a partial feed gives partial credit',
         Object.keys(after.quiz_scores).length === 2, JSON.stringify(after.quiz_scores));
      ok('and the course is NOT completed', after.status !== 'completed', after.status);
      ok('no certificate is issued', !after.certificate_id, String(after.certificate_id));
      ok('current_module points at the module still to do',
         Number(after.current_module) === 3, String(after.current_module));
    }

    console.log('\n--no-complete fills scores without finishing anything');
    {
      await seed();
      const out = run(['--no-complete', '--apply']);
      const after = await readProg();
      ok('the scores are still rebuilt', Object.keys(after.quiz_scores).length === 3,
         JSON.stringify(after.quiz_scores));
      ok('but the status is left alone', after.status === 'in_progress', after.status);
      ok('and no certificate is minted', !after.certificate_id, String(after.certificate_id));
      ok('it reported the rebuild', /Applied\. 1 row\(s\) updated/.test(out), out.slice(-300));
      /* The row is now 3/3 but still in_progress, so a plain audit must still
         offer to finish it — and must say how to decline. */
      const audit = run([]);
      ok('a later audit still offers to complete it',
         /← COMPLETES, certificate issued/.test(audit), audit.slice(-600));
      ok('and names the flag that declines',
         /Pass --no-complete/.test(audit), audit.slice(-400));
    }

    console.log('\nambiguous evidence is skipped, not guessed');
    {
      /* Two courses sharing a title: the feed names a title, so the module
         cannot be attributed to one of them. It must be reported and ignored. */
      await seed();
      await pool.query(
        `INSERT INTO employee_courses (id, title, description, pass_score, modules_count)
         VALUES ('CHK-RQ-CRS2', $1, 'duplicate title', 60, 3)`, [COURSE_TITLE]);
      const out = run([]);
      ok('the duplicate title is reported',
         /courses share the title/.test(out), out.slice(0, 900));
      ok('none of those entries is resolved',
         /resolved 0 of 3 feed entries/.test(out), out.slice(0, 600));
      ok('and nothing is planned from them',
         /Nothing to rebuild/.test(out), out.slice(-300));
      await pool.query(`DELETE FROM employee_courses WHERE id = 'CHK-RQ-CRS2'`);
    }

    console.log('\na feed entry naming a course that no longer exists is ignored');
    {
      await seed();
      await pool.query(
        `INSERT INTO activity_feed (employee_id, type, title, body, created_at)
         VALUES ($1,'course_complete','Module completed: Ghost Module',
                 '+40 XP earned in A Course That Was Deleted', NOW())`, [EMP]);
      const out = run([]);
      ok('it is counted as unresolved', /no course titled/.test(out), out.slice(0, 900));
      ok('the real three still resolve', /resolved 3 of 4 feed entries/.test(out), out.slice(0, 600));
      ok('and the genuine repair still happens', /modules passed 1\/3 → 3\/3/.test(out), out);
    }

    console.log('\n--employee scopes the repair');
    {
      await seed();
      const out = run(['--employee', 'NOBODY-AT-ALL']);
      ok('an unknown employee plans nothing', /Nothing to rebuild/.test(out), out.slice(-300));
      ok('and reads no feed entries', /0 module-completion feed entries/.test(out), out.slice(0, 500));
    }

    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
    await cleanup().catch(() => {});
  } finally {
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
