#!/usr/bin/env node
/* Generating a course either produces one or says why not.
 *
 * The report was: "the platform loads like it's generating the course but it
 * doesn't get created." The overlay runs through its five steps and nothing
 * appears.
 *
 * WHAT WAS WRONG
 *
 * max_tokens was 6000, and thinking: adaptive draws from that same budget. A
 * course of the shape this prompt asks for — three modules, each with HTML
 * lesson content, five key points and three quiz questions with four options
 * and an explanation apiece — is about 3 200 tokens of JSON on its own; the
 * nine seeded standard courses in setup.js average exactly that, and they are
 * on the terse side of what the prompt demands. The two together sat at or
 * over the limit.
 *
 * When they did, the reply stopped mid-object. The extraction was
 * `text.match(/\{[\s\S]*\}/)` — greedy, so on a truncated reply it still
 * matched, running from the first brace to whatever the last closing brace
 * happened to be, an inner one, and handed JSON.parse something that was never
 * a whole object. What came back to the person who pressed the button was
 *
 *     Course generation failed: Expected ',' or ']' after array element in
 *     JSON at position 406 (line 1 column 407)
 *
 * stop_reason was never looked at, so the one fact that explained it — that the
 * answer had been cut off — was in the response and thrown away.
 *
 * Three more, in the same handler:
 *   · No retry on a 529. The extraction routes have had one all along; this
 *     reported a moment's overload as an outright failure.
 *   · The course and its three modules were four separate statements with no
 *     transaction, so a module that failed left a course row behind claiming
 *     three modules and having fewer. That opens to a blank page and nothing
 *     ever cleans it up. A half-created course is worse than none: it looks
 *     created.
 *   · The only content check was "are there 3 modules". A module with no
 *     lesson text, or a quiz whose correct index is not one of its options —
 *     a quiz that renders and marks every answer wrong — was written anyway.
 *
 * Every case below is driven through the REAL route with Claude stubbed, so
 * these are the responses a user would actually get.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-ai-course-generation.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_aicourse_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

const SRC = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'aiCourses.js'), 'utf8');
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
const CODE = strip(SRC);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool;

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  const url = withDatabase(process.env.DATABASE_URL, DB_NAME);
  process.env.DATABASE_URL = url;
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  pool = new Pool({ connectionString: url, ssl: SSL, max: 2 });
  /* The teardown drops this database WITH (FORCE); pg reports the termination
     as a pool 'error', and a pool with no listener takes the process down
     after every assertion has already passed. */
  pool.on('error', () => {});
}

/* ── The stubbed model ───────────────────────────────────────────────────
   Only the transport is replaced. The prompt, the parsing, the validation and
   the writes are the shipped ones. */
let RESPONSE = null, THROW = null, CALLS = 0, LAST_PARAMS = null;

function stubClaude() {
  const sdk = require.resolve(path.join(ROOT, 'server', 'node_modules', '@anthropic-ai/sdk'));
  require.cache[sdk] = { id: sdk, filename: sdk, loaded: true, children: [], paths: [],
    exports: class Anthropic {
      constructor() {
        const call = async params => {
          CALLS++; LAST_PARAMS = params;
          if (THROW) throw THROW;
          return RESPONSE;
        };
        this.messages = {
          create: call,
          stream: async params => { const m = await call(params); return { finalMessage: async () => m }; },
        };
      }
    } };
}

function serve() {
  const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
  const authPath = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, children: [], paths: [],
    exports: { requireAuth: (req, _r, n) => { req.user = { role: 'admin', empId: 'AIC-E1' }; n(); },
               requireRole: () => (_a, _b, n) => n() } };
  const app = express();
  app.use(express.json());
  app.use('/api/ai', require(path.join(ROOT, 'server', 'routes', 'aiCourses')));
  return new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

const post = (port, url, body) => new Promise((resolve, reject) => {
  const d = JSON.stringify(body || {});
  const r = http.request({ host: '127.0.0.1', port, path: url, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, res => {
      let b = ''; res.on('data', c => (b += c));
      res.on('end', () => { let j; try { j = JSON.parse(b); } catch (_) { j = { _raw: b.slice(0, 300) }; }
        resolve({ status: res.statusCode, body: j }); });
    });
  r.on('error', reject); r.write(d); r.end();
});

/* A module of the shape and LENGTH the prompt actually asks for. A stub whose
   lesson content is twenty characters would sail past a content check that
   real output has to clear. */
const lesson = '<h3>Why this matters at SV Capital</h3><p>' +
  'Detailed prose on FAIS obligations, the EVA pool and how the two meet in practice. '.repeat(5) +
  '</p><ul><li>Practical point</li><li>Practical point</li></ul>';
const mod = n => ({
  title: `Module ${n}`, estimated_minutes: 15, content: lesson,
  key_points: ['a', 'b', 'c', 'd', 'e'],
  quiz: [0, 1, 2].map(i => ({ question: `q${i}`, options: ['a', 'b', 'c', 'd'],
                              correct: i, explanation: 'because' })),
});
const course = (mods) => JSON.stringify({
  description: 'A course.', learning_objectives: 'Do the thing.', modules: mods,
});
const FULL = course([mod(1), mod(2), mod(3)]);
const reply = (text, stop) => ({ content: [{ type: 'text', text }], stop_reason: stop || 'end_turn' });

const getJson = (port, url) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: url }, res => {
    let b = ''; res.on('data', c => (b += c));
    res.on('end', () => { let j; try { j = JSON.parse(b); } catch (_) { j = { _raw: b.slice(0, 200) }; }
      resolve({ status: res.statusCode, body: j }); });
  }).on('error', reject);
});

(async () => {
  let srv;
  try {
    stubClaude();
    await makeDatabase();
    srv = await serve();
    const port = srv.address().port;

    /* Generation is a job now, so "what does the user get" means: queue it,
       then wait for the job to settle and report what the poll returns. Every
       assertion below still goes through the real routes. */
    const queue = (title, body) => post(port, '/api/ai/generate-course', Object.assign({ title }, body));
    async function gen(title, body) {
      const q = await queue(title, body);
      if (q.status !== 202 || !q.body.job) return { status: q.status, body: q.body, job: null };
      /* Long enough to outlast the 529 backoff below (3+6+9 = 18s), because a
         check that gives up before the code does reports a working retry as a
         job that never settled. */
      for (let i = 0; i < 2400; i++) {
        const r = await getJson(port, '/api/ai/course-jobs/' + q.body.job.id);
        const j = r.body.job;
        if (j && j.status === 'done')   return { status: 200, body: r.body, job: j };
        if (j && j.status === 'failed') return { status: 500, body: { error: j.error }, job: j };
        await new Promise(r2 => setTimeout(r2, 25));
      }
      return { status: 0, body: { error: 'job never settled' }, job: null };
    }
    const countCourses = async t =>
      Number((await pool.query('SELECT COUNT(*) n FROM employee_courses WHERE title = $1', [t])).rows[0].n);

    console.log('\na course that generates cleanly is created');
    {
      RESPONSE = reply(FULL); THROW = null;
      const r = await gen('Clean Course');
      ok('the job finishes and the poll carries the course', r.status === 200 && r.body.course,
         JSON.stringify(r.body).slice(0, 200));
      ok('with its three modules', (r.body.modules || []).length === 3);
      ok('and they are on the database', await countCourses('Clean Course') === 1);
      const mods = await pool.query(
        'SELECT * FROM course_modules WHERE course_id = $1 ORDER BY module_index', [r.body.course.id]);
      ok('each module carries its lesson content and quiz',
         mods.rows.length === 3 && mods.rows.every(m => m.content && (m.quiz || []).length === 3));
      ok('markdown fences around the JSON are still tolerated',
         (RESPONSE = reply('```json\n' + FULL + '\n```'), (await gen('Fenced Course')).status === 200));
    }

    console.log('\nand the answer being cut off says so');
    {
      /* This is the reported failure. The old code produced
         "Expected ',' or ']' after array element in JSON at position 406". */
      RESPONSE = reply(FULL.slice(0, 420), 'max_tokens'); THROW = null;
      const r = await gen('Truncated Course');
      ok('a max_tokens stop is reported as the answer being cut off',
         r.status === 500 && /cut off/i.test(r.body.error || ''), r.body.error);
      ok('and NOT as a JSON parse error',
         !/JSON at position|Unexpected|Expected ',' or/.test(r.body.error || ''),
         'that message told the person nothing about what to do');
      ok('the message says what to do about it',
         /narrower focus|shorter title/i.test(r.body.error || ''), r.body.error);
      ok('nothing was written', await countCourses('Truncated Course') === 0);

      /* stop_reason is the authoritative signal and the brace matcher is the
         fallback, so each has to be shown working ALONE. Here the JSON is
         complete and valid — only stop_reason says the model ran out of room,
         and a course built from it would be missing whatever it was still
         going to say. */
      RESPONSE = reply(FULL, 'max_tokens');
      const r3 = await gen('Complete But Capped Course');
      ok('a complete-looking object that stopped at max_tokens is still refused',
         r3.status === 500 && /cut off/i.test(r3.body.error || ''),
         `${r3.status}: ${r3.body.error || JSON.stringify(r3.body).slice(0, 120)}`);
      ok('because nothing else could have told us it was short',
         await countCourses('Complete But Capped Course') === 0);

      /* Cut off without stop_reason set — the brace matcher has to notice on
         its own, because the greedy regex it replaced did not. */
      RESPONSE = reply(FULL.slice(0, 420), 'end_turn');
      const r2 = await gen('Silently Cut Course');
      ok('an unbalanced object is caught even when stop_reason does not say so',
         r2.status === 500 && /cut off/i.test(r2.body.error || ''), r2.body.error);
      ok('and still writes nothing', await countCourses('Silently Cut Course') === 0);
    }

    console.log('\nthe other ways it can come back wrong');
    {
      RESPONSE = reply('I am not able to help with that.'); THROW = null;
      const r = await gen('Prose Course');
      ok('a reply with no course in it says exactly that',
         r.status === 500 && /replied with text/i.test(r.body.error || ''), r.body.error);

      RESPONSE = reply(course([mod(1), mod(2)]));
      const r2 = await gen('Two Module Course');
      ok('too few modules names how many came back',
         r2.status === 500 && /returned 2 modules instead of 3/.test(r2.body.error || ''), r2.body.error);

      const noContent = mod(3); noContent.content = '';
      RESPONSE = reply(course([mod(1), mod(2), noContent]));
      const r3 = await gen('Empty Module Course');
      ok('a module with no lesson content is refused, not written',
         r3.status === 500 && /module 3 has no lesson content/.test(r3.body.error || ''), r3.body.error);
      ok('so the reader never opens a blank page', await countCourses('Empty Module Course') === 0);

      const badQuiz = mod(3); badQuiz.quiz[0].correct = 7;
      RESPONSE = reply(course([mod(1), mod(2), badQuiz]));
      const r4 = await gen('Unanswerable Course');
      ok('a quiz whose right answer is not one of its options is refused',
         r4.status === 500 && /marks an answer that is not one of its options/.test(r4.body.error || ''),
         r4.body.error);
      ok('which is the quiet one — it renders, and every answer is wrong',
         await countCourses('Unanswerable Course') === 0);

      const noQuiz = mod(2); noQuiz.quiz = [];
      RESPONSE = reply(course([mod(1), noQuiz, mod(3)]));
      const r5 = await gen('No Quiz Course');
      ok('a module with no quiz at all is refused',
         r5.status === 500 && /module 2 has no quiz/.test(r5.body.error || ''), r5.body.error);
    }

    console.log('\nan overloaded service is waited out, not surrendered to');
    {
      CALLS = 0;
      THROW = Object.assign(new Error('Overloaded'), { status: 529 });
      /* Timed from queueing to the job settling, not from the POST — the POST
         returns in milliseconds now, which is the whole point. */
      const t0 = Date.now();
      const queued = await queue('Overloaded Course');
      const postMs = Date.now() - t0;
      const r = await gen('Overloaded Course 2');
      const secs = (Date.now() - t0) / 1000;
      ok('queueing returns at once even though the work will take half a minute',
         queued.status === 202 && postMs < 2000, `${postMs}ms`);
      ok('it is retried rather than failed on the first 529', CALLS >= 4, `${CALLS} attempts`);
      ok('with a backoff between attempts', secs >= 17 && secs < 90, `${secs.toFixed(1)}s`);
      ok('and only then reported, in words a person can act on',
         r.status === 500 && /busy/i.test(r.body.error || '') && /again/i.test(r.body.error || ''),
         r.body.error);
      THROW = null;
    }

    console.log('\na course is written whole or not at all');
    {
      /* A module the database will refuse, so the second of the three inserts
         fails after the course row is already in. */
      const huge = mod(2); huge.estimated_minutes = 999999999999;
      RESPONSE = reply(course([mod(1), huge, mod(3)])); THROW = null;
      const r = await gen('Rollback Course');
      ok('the failure is reported', r.status === 500, JSON.stringify(r.body).slice(0, 160));
      ok('and no course row is left behind claiming modules it does not have',
         await countCourses('Rollback Course') === 0,
         'a half-created course looks created, which is worse than none');
      const orphans = await pool.query(
        `SELECT COUNT(*) n FROM course_modules m
          WHERE NOT EXISTS (SELECT 1 FROM employee_courses c WHERE c.id = m.course_id)`);
      ok('and no orphan modules either', Number(orphans.rows[0].n) === 0);
    }

    console.log('\ngeneration is a job, and the request does not wait for it');
    {
      /* The reason for all of this: the browser used to hold a connection open
         for the minute or two Claude takes, and anything between the two that
         gives up on an idle response took the work with it — with no record
         that the attempt had happened. */
      RESPONSE = reply(FULL); THROW = null;
      const t0 = Date.now();
      const q = await queue('Queued Course');
      const ms = Date.now() - t0;
      ok('the POST returns 202 with a job, not the course', q.status === 202 && q.body.job && !q.body.course,
         `${q.status}: ${JSON.stringify(q.body).slice(0, 140)}`);
      ok('and it returns immediately', ms < 2000, `${ms}ms`);
      ok('the job is recorded before any generating starts',
         Number((await pool.query('SELECT COUNT(*) n FROM ai_course_jobs WHERE id = $1',
           [q.body.job.id])).rows[0].n) === 1,
         'the record has to outlive the connection');

      /* Wait it out, then check the row carries the outcome. */
      let job = null;
      for (let i = 0; i < 400; i++) {
        const r = await getJson(port, '/api/ai/course-jobs/' + q.body.job.id);
        job = r.body.job;
        if (job.status === 'done' || job.status === 'failed') { var final = r.body; break; }
        await new Promise(r2 => setTimeout(r2, 25));
      }
      ok('the job finishes as done', job && job.status === 'done', JSON.stringify(job));
      ok('and the finished course travels with the last poll',
         final && final.course && (final.modules || []).length === 3,
         'so the page does not need a second round trip');
      ok('the course id is derived from the job id',
         job.course_id === 'CRS-AI-' + job.id, `${job.course_id} vs CRS-AI-${job.id}`);

      const again = await queue('Queued Course');
      ok('a second press while one is running returns the job already going',
         again.status === 202 && again.body.job, JSON.stringify(again.body).slice(0, 120));

      ok('an unknown job id is a 404, so the page stops rather than spinning',
         (await getJson(port, '/api/ai/course-jobs/no-such-job')).status === 404);

      const latest = await getJson(port, '/api/ai/course-jobs');
      ok('the caller can find their most recent job after a refresh',
         latest.status === 200 && latest.body.job && latest.body.job.id,
         JSON.stringify(latest.body).slice(0, 140));

      ok('a title is still required, and refused before a job is made',
         (await post(port, '/api/ai/generate-course', { title: '  ' })).status === 400);
    }

    console.log('\nand a restart cannot strand one');
    {
      /* The course insert commits before the job row is updated. A process
         that dies in that gap leaves a real course and a job that never heard
         about it — so the reconciliation has to look, not assume. */
      await pool.query(
        `INSERT INTO ai_course_jobs (id, employee_id, title, status, stage, started_at)
         VALUES ('rc-lost','AIC-E1','Lost To Restart','running','Generating lesson content',NOW()),
                ('rc-saved','AIC-E1','Saved Before Restart','running','Saving modules and quizzes',NOW()),
                ('rc-queued','AIC-E1','Never Started','queued','Queued',NULL)`);
      await pool.query(
        `INSERT INTO employee_courses (id,title,description,category,xp_reward,is_active)
         VALUES ('CRS-AI-rc-saved','Saved Before Restart','d','professional_development',200,true)`);

      const q2 = console.log; console.log = () => {};
      try {
        delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
        await require(path.join(ROOT, 'server', 'db', 'setup.js'))();
      } finally { console.log = q2; }

      const row = async id =>
        (await pool.query('SELECT * FROM ai_course_jobs WHERE id = $1', [id])).rows[0];
      const saved = await row('rc-saved');
      ok('a job whose course was already written is recovered, not failed',
         saved.status === 'done' && saved.course_id === 'CRS-AI-rc-saved',
         `${saved.status} / ${saved.course_id} — failing it would tell somebody their course was lost while it sat in their list`);
      const lost = await row('rc-lost');
      ok('one whose course was not written is failed, and says why',
         lost.status === 'failed' && /server restarted/i.test(lost.error || ''), lost.error);
      const never = await row('rc-queued');
      ok('and one that never started is failed too, not left queued forever',
         never.status === 'failed', never.status);
      ok('nothing is left running for a page to poll at forever',
         Number((await pool.query(
           `SELECT COUNT(*) n FROM ai_course_jobs WHERE status IN ('queued','running')`)).rows[0].n) === 0);
    }

    console.log('\nthe budget the whole thing turned on');
    {
      RESPONSE = reply(FULL); THROW = null;
      await gen('Budget Probe');
      ok('generation asks for room well past what a course needs',
         LAST_PARAMS.max_tokens >= 12000,
         `max_tokens ${LAST_PARAMS.max_tokens} — a course is ~3 200 tokens of JSON before thinking`);
      ok('and it still thinks, because the content is better for it',
         LAST_PARAMS.thinking && LAST_PARAMS.thinking.type === 'adaptive',
         JSON.stringify(LAST_PARAMS.thinking));
      ok('the old budget is gone', !/max_tokens: 6000/.test(CODE));
      ok('and the greedy object regex with it',
         !/text\.match\(\/\\\{\[\\s\\S\]\*\\\}\//.test(CODE) && /function parseCourseJson/.test(CODE),
         'it matched to an inner brace on a truncated reply and called it JSON');
    }

    console.log('\nand the quiz routes had the same fault');
    {
      ok('the greedy array regex is gone from both',
         !/text\.match\(\/\\\[\[\\s\\S\]\*\\\]\//.test(CODE) && /function parseJsonArray/.test(CODE));
      ok('they check stop_reason too',
         (CODE.match(/parseJsonArray\(text, message\.stop_reason\)/g) || []).length === 2,
         'generate-quiz and backfill-quizzes');
      ok('and validate the answer index before writing',
         (CODE.match(/validateQuestions\(parseJsonArray/g) || []).length === 2);
      ok('with room for three questions and their explanations',
         !/max_tokens: 1500/.test(CODE) && (CODE.match(/max_tokens: 4000/g) || []).length === 2);

      /* Driven, not just read: a truncated quiz must not overwrite a good one. */
      const c = await pool.query(
        `SELECT id, quiz FROM course_modules ORDER BY created_at LIMIT 1`);
      const modId = c.rows[0].id;
      const before = JSON.stringify(c.rows[0].quiz);
      RESPONSE = reply('[{"question":"q","options":["a","b"', 'max_tokens');
      const q = await post(port, `/api/ai/generate-quiz/${modId}`, {});
      ok('a truncated quiz is refused', q.status === 500 && /cut off/i.test(q.body.error || ''), q.body.error);
      const after = await pool.query(`SELECT quiz FROM course_modules WHERE id = $1`, [modId]);
      ok('and the quiz already on the module is untouched',
         JSON.stringify(after.rows[0].quiz) === before);

      RESPONSE = reply(JSON.stringify([{ question: 'q', options: ['a', 'b'], correct: 5, explanation: 'e' }]));
      const q2 = await post(port, `/api/ai/generate-quiz/${modId}`, {});
      ok('so is one whose answer is not among its options',
         q2.status === 500 && /not one of its options/.test(q2.body.error || ''), q2.body.error);
    }

    console.log('\nthe page polls, and its labels match the stages the server sends');
    {
      const EMP = fs.readFileSync(path.join(ROOT, 'team', 'js', 'employee.js'), 'utf8');
      const EMP_CODE = strip(EMP);
      ok('the page polls rather than holding the request open',
         /function pollCourseJob\(/.test(EMP_CODE) && /ai\/course-jobs\//.test(EMP_CODE));
      ok('it stops on a 404 instead of spinning',
         /if \(r\.status === 404\)/.test(EMP_CODE));
      ok('but a dropped poll or a 500 is retried, because the work is on the server',
         /await sleep\(AI_POLL_MS\);\s*continue;/.test(EMP_CODE));
      ok('it does not go through get\(\), which returns an empty object for every failure',
         /await fetch\(BASE \+ `ai\/course-jobs\//.test(EMP_CODE),
         'through that helper a dropped poll and a missing job look identical');
      ok('and it gives up eventually rather than polling for ever',
         /AI_POLL_TIMEOUT/.test(EMP_CODE));
      ok('a failed job surfaces the job\'s own message',
         /throw new Error\(job\.error/.test(EMP_CODE));

      /* Every stage the server sets must light a step up. A stage with no
         mapping leaves the overlay frozen on the previous one, which is the
         behaviour this whole change was meant to replace. */
      const serverStages = [...SRC.matchAll(/setStage\(jobId, '([^']+)'\)/g)].map(m => m[1])
        .concat([...SRC.matchAll(/stage='([^']+)'/g)].map(m => m[1]));
      const mapped = new Set([...EMP.matchAll(/^\s*'([^']+)':\s*\d,?$/gm)].map(m => m[1]));
      const unmapped = [...new Set(serverStages)].filter(x => !mapped.has(x));
      ok('every stage the server sets has a step on the page',
         unmapped.length === 0,
         `unmapped: ${unmapped.join(', ')} — the overlay would freeze on the previous one`);
      ok('the page is cache-busted so the old synchronous client is not served',
         (() => { const m = fs.readFileSync(path.join(ROOT, 'team', 'employee.html'), 'utf8')
                    .match(/employee\.js\?v=(\d+)/); return m && Number(m[1]) > 3; })(),
         'a cached client would POST and wait for a body that never comes');
    }

  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    if (srv) srv.close();
    if (pool) await pool.end().catch(() => {});
    try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
