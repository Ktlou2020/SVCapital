#!/usr/bin/env node
/* Staff were taught the wrong minimum investment for cattle.
 *
 * The onboarding course said R5 000 — in its module text, in its key points,
 * and as the CORRECT ANSWER to its own quiz question. The cattle product is
 * min_investment 500, and the sales course already told a different story, so
 * staff were certified on a figure that contradicted both the product and
 * another course, and then quoted it to clients.
 *
 * Two halves, and the second is the one that is easy to skip:
 *
 *   the seed is corrected, so a new environment is right;
 *
 *   courses insert ON CONFLICT DO NOTHING, so every environment that already
 *   has them keeps the wrong text for ever unless something repairs the rows.
 *   A seed fix alone would have looked complete and changed nothing in
 *   production.
 *
 * The quiz is rebuilt structurally rather than by string replacement, because
 * quiz is JSONB: Postgres sorts object keys and normalises whitespace, so the
 * stored text bears no resemblance to the JS literal it came from and a
 * REPLACE on quiz::text matches nothing while reporting success. That is
 * asserted here by storing the fixture the way the app does and checking the
 * repair still finds it.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-course-cattle-minimum.cjs
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

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const QUESTION = 'What is the minimum investment amount for SV Capital cattle farming products?';

/* The seed is NOT asserted by reading setup.js as text.
 *
 * The first version did, and it failed: the repair step further down that file
 * contains the wrong strings on purpose — they are what its SQL searches for —
 * so a negative match on "R5 000" found the fix rather than the fault. The same
 * trap as asserting against a comment that explains a bug.
 *
 * The seeded ROWS are the evidence. setup.js is run into a fresh database
 * below and the courses are read back from it, which is also what a new
 * environment would actually get.
 * ─────────────────────────────────────────────────────────────────────── */

/* ── The repair, against rows that already hold the wrong figure ──────── */
const DB_NAME = 'chk_course_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool;

(async () => {
  try {
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
    const url = withDatabase(process.env.DATABASE_URL, DB_NAME);
    process.env.DATABASE_URL = url;
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
    const q = console.log; console.log = () => {};
    let result;
    try { result = await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
    pool = new Pool({ connectionString: url, ssl: SSL, max: 2 });
    /* The teardown drops this database WITH (FORCE), which terminates whatever
       is still connected to it. pg reports that as an 'error' event on the pool,
       and a pool with no listener for one takes the process down — so a check
       that passed every assertion exits non-zero, at random, with a stack that
       names pg and not the drop. The termination is expected. The crash is not. */
    pool.on('error', () => {});

    const unexpected = ((result && result.failures) || []).filter(f => !/COO account/i.test(f.name || ''));
    ok('setup ran', unexpected.length === 0, JSON.stringify(unexpected));

    console.log('\nthe seeded course teaches the product’s real minimum');
    {
      const { rows: prod } = await pool.query(
        `SELECT min_investment FROM products WHERE product_type = 'cattle' LIMIT 1`);
      ok('the cattle product is min_investment 500',
         prod.length && Math.abs(Number(prod[0].min_investment) - 500) < 0.005,
         `${prod.length ? prod[0].min_investment : 'no cattle product'} — this is the figure ` +
         `every course has to agree with`);

      const { rows: mods } = await pool.query(
        `SELECT content, key_points::text AS kp FROM course_modules
          WHERE content ILIKE '%cattle%' AND content ILIKE '%Minimum investment%'`);
      ok('a seeded cattle module was found', mods.length > 0);
      ok('and none of them says R5 000',
         mods.every(m => !/R5 000/.test(m.content) && !/R5 000/.test(m.kp)),
         JSON.stringify(mods.map(m => (m.content.match(/Minimum investment[^<]*<[^>]*>[^<]*/) || [''])[0])));
      ok('they say R500',
         mods.some(m => /R500/.test(m.content)),
         'the sales course already said R500; the onboarding course did not');

      const { rows: qs } = await pool.query(
        `SELECT quiz FROM course_modules WHERE quiz::text LIKE '%cattle farming%'`);
      const seeded = qs.flatMap(r => r.quiz).filter(x => x && x.question === QUESTION);
      ok('the seeded quiz asks the minimum-investment question', seeded.length > 0);
      ok('offers R500 and marks it correct',
         seeded.every(x => x.options[x.correct] === 'R500'),
         JSON.stringify(seeded.map(x => ({ o: x.options, c: x.correct }))));
      ok('and explains R500, not R5 000',
         seeded.every(x => /R500/.test(x.explanation) && !/R5 000/.test(x.explanation)));
    }

    console.log('\nan environment already holding R5 000 is repaired');

    /* Written the way the app writes it — a JS object through node-postgres
       into JSONB — so Postgres normalises it exactly as it does in production.
       A fixture hand-written as text would not prove anything about that. */
    await pool.query(
      `INSERT INTO employee_courses (id, title, description, category, modules_count, quiz_questions)
       VALUES ('CRS-TEST-OLD', 'Legacy onboarding', 'x', 'company_culture', 1, 1)
       ON CONFLICT (id) DO NOTHING`);
    await pool.query(
      `INSERT INTO course_modules (id, course_id, module_index, title, content, key_points, quiz)
       VALUES ('MOD-TEST-OLD', 'CRS-TEST-OLD', 1, 'Cattle', $1, $2::jsonb, $3::jsonb)`,
      ['<h3>Cattle</h3><ul><li>Minimum investment: <strong>R5 000</strong></li></ul>',
       JSON.stringify(['Minimum investment is R5 000', 'Herds are insured']),
       JSON.stringify([
         { question: 'Unrelated question', options: ['a', 'b'], correct: 1, explanation: 'x' },
         { question: QUESTION, options: ['R1 000', 'R2 500', 'R5 000', 'R10 000'], correct: 2,
           explanation: 'The minimum investment for cattle farming is R5 000, keeping it accessible while maintaining viable pool sizes.' },
       ])]);

    /* The stored form is nothing like the literal it came from — which is why
       a text replacement on it silently does nothing. */
    const { rows: [before] } = await pool.query(`SELECT quiz::text AS t FROM course_modules WHERE id='MOD-TEST-OLD'`);
    ok('JSONB reordered and reformatted the stored quiz',
       !before.t.includes('"options": ["R1 000", "R2 500", "R5 000", "R10 000"], "correct": 2'),
       'if this ever matched, the string-replacement version would have worked and this note is wrong');

    /* Re-run setup: step 12 is a repair and must be idempotent. */
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
    const q2 = console.log; console.log = () => {};
    try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q2; }

    const { rows: [m] } = await pool.query(
      `SELECT content, key_points::text AS kp, quiz FROM course_modules WHERE id='MOD-TEST-OLD'`);

    ok('the module text now says R500',
       m.content.includes('<strong>R500</strong>') && !m.content.includes('R5 000'), m.content);
    ok('the key points now say R500',
       m.kp.includes('Minimum investment is R500') && !m.kp.includes('R5 000'), m.kp);

    const quiz = m.quiz;
    const target = quiz.find(x => x.question === QUESTION);
    ok('the quiz question survived the rebuild', !!target, JSON.stringify(quiz));
    if (target) {
      ok('its options now offer R500', target.options.includes('R500'), JSON.stringify(target.options));
      ok('and the correct index points at R500',
         target.options[target.correct] === 'R500',
         `correct ${target.correct} → ${target.options[target.correct]} — moving the options ` +
         `without the index just teaches a different wrong answer`);
      ok('the explanation says R500', /R500/.test(target.explanation) && !/R5 000/.test(target.explanation),
         target.explanation);
    }
    ok('the unrelated question is untouched, and still first',
       quiz.length === 2 && quiz[0].question === 'Unrelated question' && quiz[0].correct === 1,
       JSON.stringify(quiz.map(x => x.question)));

    /* A repair that only works once is a repair that half-ran on a restart. */
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
    const q3 = console.log; console.log = () => {};
    try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q3; }
    const { rows: [again] } = await pool.query(
      `SELECT content, quiz FROM course_modules WHERE id='MOD-TEST-OLD'`);
    ok('running it again changes nothing',
       again.content === m.content &&
       JSON.stringify(again.quiz) === JSON.stringify(m.quiz));

    console.log('\nand the shipped courses agree with each other');
    {
      const { rows } = await pool.query(
        `SELECT id, course_id FROM course_modules
          WHERE content LIKE '%R5 000%' AND content ILIKE '%cattle%'`);
      ok('no seeded cattle module still teaches R5 000',
         rows.length === 0, JSON.stringify(rows));
      const { rows: qrows } = await pool.query(
        `SELECT id FROM course_modules WHERE quiz::text LIKE '%cattle farming is R5 000%'`);
      ok('and no quiz still marks R5 000 correct', qrows.length === 0, JSON.stringify(qrows));
    }

  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    if (pool) await pool.end().catch(() => {});
    try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
