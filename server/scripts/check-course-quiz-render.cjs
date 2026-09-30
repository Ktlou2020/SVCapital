#!/usr/bin/env node
/* A seeded course quiz can be read.
 *
 * course_modules.quiz is JSONB. node-pg parses JSONB, and the tables route
 * sends what it gets, so the reader receives an ARRAY. Both readers in
 * team/js/employee.js did
 *
 *     try { questions = JSON.parse(mod.quiz || '[]'); } catch { questions = []; }
 *
 * which throws "Unexpected token 'o', \"[object Obj\"... is not valid JSON" on
 * every module the server has round-tripped, and both caught it and returned
 * an empty list. An empty quiz means "this module has none — generate one", so
 * the reader went to the AI generator, and when that could not run it said
 *
 *     Quiz Unavailable — Could not generate quiz questions.
 *
 * on a module whose questions were sitting in the database the whole time.
 * Measured across every seeded module: 0 of 39 readable.
 *
 * It hid because the AI path patched the cache with JSON.stringify(questions),
 * so a quiz generated in that session parsed and a seeded one never did — and
 * because every stored quiz failed the same way, nothing looked inconsistent.
 *
 * The same fault, on course_progress.quiz_scores, is already fixed and
 * documented a few hundred lines above in that file. This is its twin.
 *
 * Needs a database for the second half:
 *   DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-course-quiz-render.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'team', 'js', 'employee.js'), 'utf8');

/* Assertions about CODE are made against code. The comment that explains this
   fix quotes the expression it replaced, and a bare search finds that quote —
   which would fail the check for describing itself. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* The real helper, lifted out of the real file and run — not re-implemented. */
const _moduleQuiz = (() => {
  const from = SRC.indexOf('function _moduleQuiz(mod)');
  const to   = SRC.indexOf('function renderQuiz(mod)');
  if (from < 0 || to < 0) return null;
  // eslint-disable-next-line no-eval
  return eval(`(${SRC.slice(from, to).trim()})`);
})();

console.log('\nthe quiz is read, not re-parsed');
{
  ok('there is a _moduleQuiz helper', typeof _moduleQuiz === 'function');
  ok('and nothing still calls JSON.parse on mod.quiz',
     !/JSON\.parse\(\s*mod\.quiz/.test(CODE),
     'the column is JSONB — the driver has already parsed it');
  ok('both readers go through the helper',
     (CODE.match(/_moduleQuiz\(mod\)/g) || []).length >= 2,
     'renderQuiz and selectAnswer each counted the questions their own way');
  ok('the AI path caches an array, like the database gives',
     !/cached\.quiz = JSON\.stringify\(questions\)/.test(CODE),
     'caching a string is what kept the seeded case from ever being noticed');
  ok('and the sibling fix on quiz_scores is still in place',
     /function _courseScores\(prog\)/.test(SRC),
     'same fault, same file — they document each other');
}

console.log('\nit copes with every shape the column is served as');
if (_moduleQuiz) {
  const q = n => Array.from({ length: n }, (_, i) => ({ question: `Q${i}`, options: ['a', 'b'], correct: 0 }));
  ok('an array, which is what node-pg returns', _moduleQuiz({ quiz: q(3) }).length === 3);
  ok('a JSON string, which is what the AI path used to cache',
     _moduleQuiz({ quiz: JSON.stringify(q(2)) }).length === 2);
  ok('null, meaning there really is no quiz', _moduleQuiz({ quiz: null }).length === 0);
  ok('an empty array', _moduleQuiz({ quiz: [] }).length === 0);
  ok('a string that is not JSON', _moduleQuiz({ quiz: 'not json' }).length === 0);
  ok('a missing module', _moduleQuiz(undefined).length === 0 && _moduleQuiz({}).length === 0);
  ok('and drops entries that could not be answered',
     _moduleQuiz({ quiz: [{ question: 'no options' }, { options: ['a'] }, { question: 'ok', options: ['a', 'b'] }] }).length === 1,
     'a question with no options renders as a blank list the learner cannot pass');
}

/* ── Against what is actually stored ──────────────────────────────── */
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\n  (skipping the stored-quiz half — DATABASE_URL not set)');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  const { Pool } = require('pg');
  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

    console.log('\nand every quiz the platform ships is readable');
    const { rows } = await db.query(
      `SELECT course_id, module_index, quiz FROM course_modules
        WHERE jsonb_array_length(COALESCE(quiz, '[]'::jsonb)) > 0
        ORDER BY course_id, module_index`);
    ok('there are seeded quizzes to read at all', rows.length > 0, `${rows.length} module(s)`);

    /* Exactly what res.json puts on the wire, fed to the real helper. */
    const wire = rows.map(r => JSON.parse(JSON.stringify(r)));
    const unreadable = wire.filter(r => _moduleQuiz(r).length === 0);
    ok(`all ${wire.length} of them come back with their questions`,
       unreadable.length === 0,
       unreadable.map(r => `${r.course_id} module ${r.module_index}`).join(', '));

    const legacyBroken = wire.filter(r => {
      try { return JSON.parse(r.quiz || '[]').length === 0; } catch (_) { return true; }
    });
    ok('and the old expression really could not read any of them',
       legacyBroken.length === wire.length,
       'if this ever passes with a smaller number the column has changed type');

    const totalQs = wire.reduce((a, r) => a + _moduleQuiz(r).length, 0);
    ok(`${totalQs} questions reachable across ${new Set(wire.map(r => r.course_id)).size} course(s)`,
       totalQs >= wire.length * 3);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
