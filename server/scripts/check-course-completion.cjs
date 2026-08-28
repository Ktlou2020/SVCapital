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
      const empWrites = (EMP.match(/current_module\s*:\s*([^,\n]+)/g) || []).map(s => s.split(':')[1].trim());
      ok('the employee portal writes a number, not a module id',
         empWrites.every(v => /^\d+$/.test(v)),
         `writes: ${JSON.stringify(empWrites)} — a UUID here failed every self-enrolment`);
      const dirWrites = (DIR.match(/current_module:\s*([^,\n]+)/g) || []).map(s => s.split(':')[1].trim());
      ok('and the director portal agrees', dirWrites.every(v => /^\d+$/.test(v)), JSON.stringify(dirWrites));
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

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
