#!/usr/bin/env node
/* An employee must be able to finish a course.
 *
 * Reported as "they get to the end and can't submit". Three defects stacked:
 *
 *   1. course_progress.certificate_id was never created. The employee portal
 *      writes it on the FINAL module — the one that marks a course complete —
 *      so every module saved fine until the last, which failed with
 *      "column does not exist".
 *
 *   2. current_module is INT, and director.js writes 1, but employee.js wrote
 *      the module's UUID. Director-assigned courses enrolled; self-enrolment
 *      failed with "invalid input syntax for type integer".
 *
 *   3. post() and patch() in the team portal returned r.json() without looking
 *      at r.ok, so a 500 came back as { error: … } — a truthy object the caller
 *      stored as if it were the saved row. The progress record became an error
 *      object, the later lookup for it found nothing, and completeModule hit
 *      `if (!prog) return;` and did nothing. That is why a broken submit
 *      produced no error: there was nothing to see.
 *
 * The third is why the other two survived, so it is checked hardest.
 *
 * The payloads are read out of team/js/employee.js rather than written here —
 * a check carrying its own copy would still pass after someone adds a field
 * the table does not have, which is defect 1 exactly.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-course-completion.cjs
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
const EMP  = fs.readFileSync(path.join(ROOT, 'team', 'js', 'employee.js'), 'utf8');
const DIR  = fs.readFileSync(path.join(ROOT, 'team', 'js', 'director.js'), 'utf8');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* Every key the team portals write to course_progress, read from the source.
   Object literals only — enough for these call sites, and a miss shows up as a
   missing key rather than a false pass. */
function writtenKeys(src) {
  const keys = new Set();
  const re = /(post|patch)\(\s*[`'"]tables\/course_progress[^`'"]*[`'"]\s*,\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex - 1, depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    const body = src.slice(re.lastIndex, i);
    for (const k of body.matchAll(/(?:^|[\s,{])([a-z_][a-z0-9_]*)\s*:/gi)) keys.add(k[1]);
  }
  return keys;
}

/* The completion PATCH builds its object separately, as `updates`. */
function updateKeys(src) {
  const at = src.indexOf('const updates = {');
  if (at < 0) return new Set();
  let i = src.indexOf('{', at), depth = 0, end = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const keys = new Set();
  for (const k of src.slice(at, end).matchAll(/(?:^|[\s,{])([a-z_][a-z0-9_]*)\s*:/gi)) keys.add(k[1]);
  /* Assigned conditionally after the literal, on the final module. */
  const tail = src.slice(end, end + 600);
  for (const k of tail.matchAll(/updates\.([a-z_][a-z0-9_]*)\s*=/gi)) keys.add(k[1]);
  return keys;
}

(async () => {
  try {
    const { rows: cols } = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'course_progress'`);
    if (!cols.length) { console.log('  SKIP  course_progress not present in this database'); await pool.end(); process.exit(0); }
    const have = new Map(cols.map(c => [c.column_name, c.data_type]));

    console.log('\nevery column the portal writes exists');
    {
      const keys = new Set([...writtenKeys(EMP), ...writtenKeys(DIR), ...updateKeys(EMP)]);
      ok('the payload keys were found at all', keys.size >= 8, JSON.stringify([...keys]));
      const missing = [...keys].filter(k => !have.has(k));
      ok('none of them is missing from the table', missing.length === 0,
         `missing: ${JSON.stringify(missing)} — this is how certificate_id broke the final module`);
      ok('certificate_id specifically', have.has('certificate_id'),
         'written on the last module of every course, and never created');
    }

    console.log('\ncurrent_module is written as the type it is declared');
    {
      ok('the column is an integer', have.get('current_module') === 'integer', have.get('current_module'));
      /* What matters is that no write is a module IDENTIFIER — that is the
         defect. Requiring a bare digit was too strict: it failed the moment
         current_module started advancing as `Math.min(modsDone + 1, …)`, which
         is a perfectly good integer expression. A UUID reaches this column only
         via mod.id / module.id / _readerModules[…].id, so reject those. */
      const isModuleId = v => /\bmod(ule)?\b[^,]*\.id\b/.test(v) || /_readerModules\[[^\]]*\]\.id/.test(v);
      const writesOf = src => (src.match(/current_module\s*:\s*([^,\n]+)/g) || [])
        .map(s => s.slice(s.indexOf(':') + 1).trim());
      const empWrites = writesOf(EMP);
      ok('the employee portal writes an index, not a module id',
         empWrites.length > 0 && !empWrites.some(isModuleId),
         `writes: ${JSON.stringify(empWrites)} — a UUID here failed every self-enrolment`);
      const dirWrites = writesOf(DIR);
      ok('and the director portal agrees',
         dirWrites.length > 0 && !dirWrites.some(isModuleId), JSON.stringify(dirWrites));
    }

    console.log('\na write that fails is not reported as a success');
    {
      ok('the team portal checks the response status',
         /if \(!r\.ok\)/.test(EMP),
         'returning r.json() blind turns a 500 into a truthy { error } the caller stores');
      ok('and throws rather than returning the error body',
         /const err = new Error\(why\);/.test(EMP) && /throw err;/.test(EMP));
      ok('post, patch and put all go through it',
         /const post\s+= \(p, b\) => _send\('POST'/.test(EMP) &&
         /const patch\s+= \(p, b\) => _send\('PATCH'/.test(EMP) &&
         /const put\s+= \(p, b\) => _send\('PUT'/.test(EMP));
      ok('a non-JSON error body does not mask the failure',
         /catch \(_\) \{ \/\* a non-JSON body on an error is still an error \*\/ \}/.test(EMP));
    }

    console.log('\nand the employee is told when it fails');
    {
      /* The paren matters: there is a completeModuleNow wrapper, and the
         prefix match landed on it — a four-line function that delegates, where
         none of these assertions could ever hold. */
      const at = EMP.indexOf('async function completeModule(');
      const fn = EMP.slice(at, EMP.indexOf('\n}\n', at));
      ok('a failed submit shows a message',
         /Could not save your progress/.test(fn), fn.slice(0, 500));
      ok('and stops rather than celebrating unsaved progress',
         /showToast\([^)]*Could not save your progress[\s\S]{0,120}?return;/.test(fn),
         'the XP award and the celebration sit below this point');

      const openAt = EMP.indexOf('let prog = _progress.find');
      const openFn = EMP.slice(openAt, openAt + 1400);
      ok('a failed enrolment refuses to open the course',
         /Could not start this course/.test(openFn) && /return;/.test(openFn),
         'pushing an error object into _progress is what made every later module a no-op');
    }

    console.log('\nthe completion actually round-trips');
    {
      await pool.query(`DELETE FROM course_progress WHERE id = 'CHK-CP-1'`).catch(() => {});
      await pool.query(`DELETE FROM employees WHERE id = 'CHK-EMP-1'`).catch(() => {});
      await pool.query(`INSERT INTO employees (id, first_name, last_name, email, status, role)
                        VALUES ('CHK-EMP-1','Test','Staff','chk@example.test','active','staff')`);
      await pool.query(`INSERT INTO course_progress (id, employee_id, course_id, status, current_module)
                        VALUES ('CHK-CP-1','CHK-EMP-1','CHK-CRS-1','in_progress', 1)`);

      const cert = `CERT-CHK-EMP-1-CHK-CRS-1-${Date.now()}`;
      await pool.query(
        `UPDATE course_progress
            SET status = 'completed', completed_at = NOW(), certificate_id = $1, kpi_applied = true
          WHERE id = 'CHK-CP-1'`, [cert]);
      const { rows: [row] } = await pool.query(
        `SELECT status, certificate_id FROM course_progress WHERE id = 'CHK-CP-1'`);

      ok('the course can be marked complete', row.status === 'completed', JSON.stringify(row));
      ok('and the certificate id is stored, not discarded',
         row.certificate_id === cert, JSON.stringify(row.certificate_id));

      await pool.query(`DELETE FROM course_progress WHERE id = 'CHK-CP-1'`);
      await pool.query(`DELETE FROM employees WHERE id = 'CHK-EMP-1'`);
    }

    /* ── The JSONB read, which is what actually broke completion ────────
     *
     * quiz_scores is JSONB. node-pg returns JSONB as a parsed OBJECT, and every
     * reader in the portal did JSON.parse(prog.quiz_scores || '{}') — which
     * throws "[object Object] is not valid JSON" on anything the server has
     * round-tripped. Each site caught the throw and returned {}.
     *
     * So the scores reset to empty on every read: module 1 saved, module 2 read
     * {} and saved only itself, module 3 the same. modules_completed never got
     * past 1, `allDone` was never true for a 3-module course, and the course
     * could not be finished. Then the unclamped _readerModIdx++ ran anyway,
     * which is where "Module 7 of 3" came from.
     *
     * Asserted against a real column, not a hand-written string, because the
     * whole defect is that the value's TYPE is not what the code assumed.
     */
    console.log('\nthe scores survive a real JSONB round-trip');
    {
      ok('quiz_scores is JSONB, so it comes back parsed',
         (have.get('quiz_scores') || '').includes('json'),
         `declared as ${have.get('quiz_scores')}`);

      await pool.query(`DELETE FROM course_progress WHERE id = 'CHK-CP-2'`).catch(() => {});
      await pool.query(`DELETE FROM employees WHERE id = 'CHK-EMP-2'`).catch(() => {});
      await pool.query(`INSERT INTO employees (id, first_name, last_name, email, status, role)
                        VALUES ('CHK-EMP-2','Test','Staff','chk2@example.test','active','staff')`);
      await pool.query(`INSERT INTO course_progress (id, employee_id, course_id, status, current_module, quiz_scores)
                        VALUES ('CHK-CP-2','CHK-EMP-2','CHK-CRS-2','in_progress', 1, '{}')`);

      const { rows: [back] } = await pool.query(
        `UPDATE course_progress SET quiz_scores = $1 WHERE id = 'CHK-CP-2' RETURNING *`,
        [JSON.stringify({ 'mod-a': 100 })]);

      ok('the driver hands it back as an object, not a string',
         back.quiz_scores !== null && typeof back.quiz_scores === 'object',
         `got ${typeof back.quiz_scores}`);

      /* The negative control: the code that shipped, against the real value. */
      let oldThrew = false;
      try { JSON.parse(back.quiz_scores || '{}'); } catch (_) { oldThrew = true; }
      ok('the old JSON.parse form throws on it — this was the defect', oldThrew,
         'if this passes, the column type changed and the note above is stale');

      /* The shipped helper, lifted out of employee.js and run for real. */
      const at = EMP.indexOf('function _courseScores(');
      ok('_courseScores exists to replace it', at >= 0,
         'every quiz_scores read must go through one normaliser');

      if (at >= 0) {
        let i = EMP.indexOf('{', at), depth = 0;
        for (; i < EMP.length; i++) {
          if (EMP[i] === '{') depth++;
          else if (EMP[i] === '}') { depth--; if (depth === 0) break; }
        }
        const fn = new Function(EMP.slice(at, i + 1) + '; return _courseScores;')();

        ok('it reads the object the driver returns',
           fn(back)['mod-a'] === 100, JSON.stringify(fn(back)));
        ok('and the string the portal seeds',
           Object.keys(fn({ quiz_scores: '{}' })).length === 0);
        ok('and the array director.js used to seed, as empty',
           Object.keys(fn({ quiz_scores: '[]' })).length === 0,
           'an array carries no per-module scores');
        ok('a null column is empty, not a throw', Object.keys(fn({ quiz_scores: null })).length === 0);
        ok('and so is corrupt text', Object.keys(fn({ quiz_scores: 'garbage' })).length === 0);
      }

      /* Walk all three modules the way the portal does — save, read back, save
         again — and require that the third one completes the course. Under the
         old read this loop never got past one recorded module. */
      let seen = {};
      for (const modId of ['mod-a', 'mod-b', 'mod-c']) {
        const { rows: [cur] } = await pool.query(
          `SELECT quiz_scores FROM course_progress WHERE id = 'CHK-CP-2'`);
        const raw = cur.quiz_scores;
        seen = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
        seen[modId] = 100;
        await pool.query(`UPDATE course_progress SET quiz_scores = $1, modules_completed = $2
                           WHERE id = 'CHK-CP-2'`, [JSON.stringify(seen), Object.keys(seen).length]);
      }
      const { rows: [final] } = await pool.query(
        `SELECT quiz_scores, modules_completed FROM course_progress WHERE id = 'CHK-CP-2'`);
      ok('three modules accumulate rather than overwriting',
         Object.keys(final.quiz_scores).length === 3, JSON.stringify(final.quiz_scores));
      ok('so a 3-module course reaches allDone',
         Number(final.modules_completed) >= 3, JSON.stringify(final.modules_completed));

      await pool.query(`DELETE FROM course_progress WHERE id = 'CHK-CP-2'`);
      await pool.query(`DELETE FROM employees WHERE id = 'CHK-EMP-2'`);
    }

    console.log('\nnothing parses quiz_scores by hand any more');
    {
      /* Scanned with comments blanked. The fix's own explanation quotes the
         broken call — `JSON.parse(prog.quiz_scores || '{}')` — so a raw scan
         reports the comment describing the defect as the defect. Blanking
         preserves line numbers so a genuine hit still points somewhere. */
      const blankComments = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                                  .replace(/^\s*\/\/.*$/gm, ' ');
      const stray = [];
      [['employee.js', EMP], ['director.js', DIR]].forEach(([name, src]) => {
        blankComments(src).split('\n').forEach((ln, i) => {
          if (/JSON\.parse\([^)]*quiz_scores/.test(ln)) stray.push(`${name}:${i + 1}`);
        });
      });
      ok('every read goes through the normaliser', stray.length === 0,
         `still parsing by hand at ${stray.join(', ')}`);
    }

    console.log('\nthe module index cannot run past the last module');
    {
      /* "Module 7 of 3": renderReader set the topbar, rendered the nav, then
         threw reading .title of undefined. The header advanced and the content
         stayed frozen on the previous quiz — with a Complete Course button
         still bound to a module that was already scored, so clicking it just
         repeated the same no-op. */
      const at = EMP.indexOf('function renderReader()');
      const fn = EMP.slice(at, EMP.indexOf('\n}\n', at));
      ok('renderReader clamps the index before using it',
         /_readerModIdx > _readerModules\.length - 1/.test(fn) &&
         /_readerModIdx = _readerModules\.length - 1/.test(fn),
         fn.slice(0, 400));
      ok('and the bare _readerModIdx++ is gone',
         !/^\s*_readerModIdx\+\+;/m.test(EMP),
         'stepping one forward walked off the end whenever a module was re-submitted');
      ok('the next module is found rather than assumed',
         /findIndex\(m => scores\[m\.id\] === undefined\)/.test(EMP));
    }

    console.log('\na finished course is finished');
    {
      const at = EMP.indexOf('async function openCourse(');
      const fn = EMP.slice(at, at + 1200);
      ok('a completed course opens its certificate, not the reader',
         /status==='completed'/.test(fn) && /openCertificate\(/.test(fn),
         fn.slice(0, 400));

      ok('the progress bar reads 100% once complete',
         /isDone \? 100 :/.test(EMP),
         'it divided modules_completed by modules_count, and that was stuck at 1');
      ok('the completion writes a status the card can key off',
         /updates\.status = 'completed';/.test(EMP));
      ok('current_module advances with progress',
         /current_module: Math\.min\(modsDone \+ 1/.test(EMP),
         'seeded to 1 at enrolment and never moved, so the director view read module 1 forever');
      ok('overall_quiz_score is computed rather than left at 0',
         /overall_quiz_score: marks\.length/.test(EMP));
      ok('the list is re-rendered even when the reader was opened elsewhere',
         /renderCourses\(\);/.test(EMP.slice(EMP.indexOf('function showCourseCelebration'),
                                              EMP.indexOf('function showCourseCelebration') + 700)),
         'closeCourseReader only re-renders on the courses view');
      ok('a side effect failing cannot swallow the celebration',
         /const _side = async \(what, fn\) =>/.test(EMP),
         'XP, KPI, feed and badges were all awaited unguarded before the celebration');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
