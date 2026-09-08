/* ════════════════════════════════════════════════════════════
   AI Course Generation
   POST /api/ai/generate-course  — generate a real 3-module course via Claude
   ════════════════════════════════════════════════════════════ */
'use strict';

const router   = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const pool     = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const client = new Anthropic();

const CAT_COLORS = {
  compliance:             '#22c55e',
  products:               '#fec24f',
  finance:                '#60a5fa',
  operations:             '#f97316',
  sales:                  '#00d4aa',
  professional_development: '#eda5ff',
  leadership:             '#a78bfa',
  client_service:         '#fb923c',
};

/* Claude, with the same 529 handling the document-extraction route has had all
   along. Without it a moment's overload is reported to the person generating a
   course as an outright failure, and the only remedy anyone knows is to press
   the button again — which is what this does, three times, spaced out. */
async function generateWithRetry(prompt) {
  const MAX = 3;
  for (let attempt = 0; attempt <= MAX; attempt++) {
    try {
      const stream = await client.messages.stream({
        model: 'claude-opus-5',
        /* Was 6000, shared with adaptive thinking. A course of this shape is
           about 3 200 tokens of JSON before the model has thought about
           anything — see the truncation note in the handler. */
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: prompt }],
      });
      return await stream.finalMessage();
    } catch (err) {
      const overloaded = err.status === 529 || /overloaded/i.test(err.message || '');
      if (overloaded && attempt < MAX) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 3000)); // 3s, 6s, 9s
        continue;
      }
      if (overloaded) {
        throw new Error('The AI service is busy. It was retried three times over half a minute — ' +
                        'please wait a moment and generate again.');
      }
      throw err;
    }
  }
}

/* Find the JSON object in the reply.

   This was `text.match(/\{[\s\S]*\}/)`, which is greedy: on a reply that
   stops mid-object it still matches, running from the first brace to whatever
   the last closing brace happens to be — an inner one — and hands JSON.parse
   something that was never a whole object. The parser then complains about a
   position in the middle of a quiz array, which reads like the model returned
   nonsense rather than like the answer being cut short.

   Matching braces instead means an unbalanced reply is recognised as
   unbalanced, and said so. */
function parseCourseJson(text) {
  const start = text.indexOf('{');
  if (start < 0) {
    throw new Error('The AI did not return a course — it replied with text instead of the ' +
                    'expected structure. Try generating again.');
  }
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) {
    throw new Error('The generated course was cut off before it finished. Try a narrower ' +
                    'focus, or a shorter title, and generate again.');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error('The generated course could not be read back (' + e.message + '). ' +
                    'Generate again — this is usually not repeatable.');
  }
}

/* The same job for a JSON array — the quiz routes below return one.

   They had the same greedy /\[[\s\S]*\]/ and the same silence about
   stop_reason, so a quiz cut off at max_tokens reported a parse error from
   somewhere in the middle of an options list. Three questions with
   explanations do not always fit in 1500 tokens. */
function parseJsonArray(text, stopReason) {
  if (stopReason === 'max_tokens') {
    throw new Error('The generated questions were longer than the space allowed and were cut ' +
                    'off before they finished. Try again.');
  }
  const start = text.indexOf('[');
  if (start < 0) {
    throw new Error('The AI replied with text instead of questions. Try again.');
  }
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('The generated questions were cut off before they finished. Try again.');
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch (e) { throw new Error('The generated questions could not be read back (' + e.message + '). Try again.'); }
}

/* A quiz nobody can pass is worse than no quiz: it renders, and every answer
   is marked wrong. */
function validateQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length) throw new Error('No questions were returned.');
  questions.forEach((q, i) => {
    if (!q || !q.question) throw new Error(`Question ${i + 1} has no question text.`);
    if (!Array.isArray(q.options) || q.options.length < 2) {
      throw new Error(`Question ${i + 1} has no answer options.`);
    }
    if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length) {
      throw new Error(`Question ${i + 1} marks an answer that is not one of its options.`);
    }
  });
  return questions;
}

/* Everything the writes below assume, checked before any of them run.

   'Expected 3 modules in generated content' was the only check, so a course
   whose third module came back with no content, or with a quiz that was not a
   list, was written anyway — and the reader opens that to a blank page. A
   course that looks created and is not usable is the worst outcome here. */
function validateCourse(data) {
  if (!data || typeof data !== 'object') throw new Error('The AI returned no course data.');
  if (!Array.isArray(data.modules)) throw new Error('The AI returned no modules for this course.');
  if (data.modules.length < 3) {
    throw new Error(`The AI returned ${data.modules.length} module` +
      `${data.modules.length === 1 ? '' : 's'} instead of 3. Generate again.`);
  }
  const faults = [];
  for (let i = 0; i < 3; i++) {
    const m = data.modules[i] || {};
    const n = i + 1;
    if (!m.title) faults.push(`module ${n} has no title`);
    if (!m.content || String(m.content).trim().length < 40) faults.push(`module ${n} has no lesson content`);
    if (!Array.isArray(m.key_points) || !m.key_points.length) faults.push(`module ${n} has no key points`);
    if (!Array.isArray(m.quiz) || !m.quiz.length) faults.push(`module ${n} has no quiz`);
    else {
      m.quiz.forEach((q, qi) => {
        if (!q || !q.question) faults.push(`module ${n} question ${qi + 1} has no question text`);
        else if (!Array.isArray(q.options) || q.options.length < 2) {
          faults.push(`module ${n} question ${qi + 1} has no answer options`);
        } else if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length) {
          /* An out-of-range answer index is the quiet one: the quiz renders,
             and no answer is ever right. */
          faults.push(`module ${n} question ${qi + 1} marks an answer that is not one of its options`);
        }
      });
    }
  }
  if (faults.length) {
    throw new Error('The generated course was incomplete — ' + faults.slice(0, 3).join('; ') +
      (faults.length > 3 ? `, and ${faults.length - 3} more` : '') + '. Generate again.');
  }
}

router.post('/generate-course', requireAuth, async (req, res) => {
  const { title, focus, category, difficulty, kpi_dimension } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const role = req.user.role || 'staff';
  const empId = req.user.empId;

  const prompt = `You are a professional Learning & Development specialist for SV Capital, a South African alternative investment firm regulated under FAIS/FSCA. Generate a structured 3-module professional development course.

COURSE REQUEST
Title: "${title}"
Focus / Goal: "${focus || title}"
Category: ${category || 'professional_development'}
Difficulty: ${difficulty || 'intermediate'}
Employee Role: ${role}
KPI Dimension to boost: ${kpi_dimension || 'task_completion_rate'}

SV CAPITAL CONTEXT (weave into content throughout)
- We manage alternative investments: cattle farming, solar energy, short-term lending
- Regulated by FSCA under FAIS — all advice and communication must comply
- We use an EVA pool model: 60% individual KPI-weighted, 40% collective team performance
- Our clients are HNW individuals investing R5 000–R500 000+
- Our platform is called SV Capital — investor portal at platform.svcapital.co.za
- Team uses OKRs, KPI scores across 8 dimensions, and 360° peer feedback

REQUIRED OUTPUT FORMAT — return ONLY valid JSON, no markdown, no explanation:
{
  "description": "2-sentence course description specific to SV Capital context",
  "learning_objectives": "Concrete outcomes: what the employee will be able to DO after completing this course",
  "modules": [
    {
      "title": "Module 1 title",
      "estimated_minutes": 15,
      "content": "<h3>Section Title</h3><p>Detailed paragraph with SV Capital-specific context...</p><h3>Another Section</h3><p>More content...</p><ul><li>Practical point</li><li>Practical point</li></ul><p>Closing paragraph linking to KPIs and EVA pool.</p>",
      "key_points": [
        "Specific, actionable takeaway 1",
        "Specific, actionable takeaway 2",
        "Specific, actionable takeaway 3",
        "Specific, actionable takeaway 4",
        "Specific, actionable takeaway 5"
      ],
      "quiz": [
        {
          "question": "Clear question testing understanding of module content",
          "options": ["Wrong option", "Correct answer", "Wrong option", "Wrong option"],
          "correct": 1,
          "explanation": "Why this answer is correct and how it applies to SV Capital"
        },
        {
          "question": "Second question",
          "options": ["Option A", "Option B", "Option C", "Option D"],
          "correct": 0,
          "explanation": "Explanation"
        },
        {
          "question": "Third question",
          "options": ["Option A", "Option B", "Option C", "Option D"],
          "correct": 2,
          "explanation": "Explanation"
        }
      ]
    },
    { "title": "Module 2 title — Core Strategies", "estimated_minutes": 18, "content": "...", "key_points": [...], "quiz": [...] },
    { "title": "Module 3 title — Advanced Application", "estimated_minutes": 20, "content": "...", "key_points": [...], "quiz": [...] }
  ]
}

RULES:
- Each module must have EXACTLY 5 key_points and EXACTLY 3 quiz questions
- Content must include real HTML tags (<h3>, <p>, <ul>, <li>)
- All content must be specific and practical — no filler or generic advice
- Correct answer index (0-3) must vary across questions — not always the same index
- Return ONLY the JSON object, starting with { and ending with }`;

  try {
    const message = await generateWithRetry(prompt);
    const text = message.content.find(b => b.type === 'text')?.text || '';

    /* THE ANSWER WAS CUT OFF, NOT MALFORMED.

       max_tokens was 6000, and thinking: adaptive draws from that same budget.
       A course of the shape this prompt asks for is about 3 200 tokens of JSON
       on its own — the nine seeded standard courses average exactly that — so
       the two together sat at or over the limit. When they did, the response
       stopped mid-object, the greedy /\{[\s\S]*\}/ below matched as far as
       some inner closing brace, and JSON.parse reported

           Expected ',' or ']' after array element in JSON at position 406

       which tells the person generating a course nothing at all. It is the
       shape of the failure being reported: the overlay runs through its steps
       and no course appears.

       stop_reason is checked BEFORE the text is parsed, because a truncated
       body is not a parsing problem and must not be reported as one. */
    if (message.stop_reason === 'max_tokens') {
      throw new Error(
        'The generated course was longer than the space allowed and was cut off before it ' +
        'finished. Try a narrower focus, or a shorter title, and generate again.');
    }

    const data = parseCourseJson(text);
    validateCourse(data);

    const courseId = `CRS-AI-${Date.now()}`;
    const color    = CAT_COLORS[category] || '#eda5ff';
    const xpTotal  = 200;
    const xpSplit  = [0.30, 0.35, 0.35];

    /* One transaction for the course and its modules.

       They were separate statements, so a module that failed to insert left a
       course row behind with fewer modules than it claims — which the reader
       opens to a blank page, and which nothing ever cleans up. A half-created
       course is worse than none: it looks created. */
    const db = await pool.connect();
    let course, modules;
    try {
      await db.query('BEGIN');

    ({ rows: [course] } = await db.query(
      `INSERT INTO employee_courses
         (id, title, description, category, difficulty, estimated_minutes, xp_reward,
          role_target, kpi_dimension, kpi_boost_points, modules_count,
          quiz_questions, pass_score, status, ai_generated, learning_objectives,
          thumbnail_icon, thumbnail_color, is_required, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [courseId, title, data.description,
       category || 'professional_development', difficulty || 'intermediate',
       53, xpTotal,
       role, kpi_dimension || 'task_completion_rate', 10, 3,
       3, 60, 'active', true, data.learning_objectives,
       'fa-robot', color, false, true]
    ));

      modules = [];
      for (let i = 0; i < 3; i++) {
        const m = data.modules[i];
        const { rows: [mod] } = await db.query(
          `INSERT INTO course_modules
             (course_id, module_index, title, estimated_minutes, xp_reward, content, key_points, quiz)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING *`,
          [courseId, i + 1, m.title, m.estimated_minutes || 15,
           Math.round(xpTotal * xpSplit[i]),
           m.content,
           JSON.stringify(m.key_points),
           JSON.stringify(m.quiz)]
        );
        modules.push(mod);
      }

      await db.query('COMMIT');
    } catch (dbErr) {
      await db.query('ROLLBACK').catch(() => {});
      throw dbErr;
    } finally {
      db.release();
    }

    console.log(`[ai-courses] Generated "${title}" for emp ${empId || role} — ${modules.length} modules`);
    res.json({ course, modules });

  } catch (err) {
    console.error('[ai-courses] generation error:', err.message);
    /* The message reaches the person who pressed the button, so it has to say
       what to do about it. err.message is already written that way for the
       cases this route raises itself. */
    res.status(500).json({ error: 'Course generation failed: ' + err.message });
  }
});

/* ── POST /api/ai/generate-quiz/:moduleId  — generate quiz for one module ── */
router.post('/generate-quiz/:moduleId', requireAuth, async (req, res) => {
  const { moduleId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT cm.*, ec.title AS course_title
       FROM course_modules cm
       JOIN employee_courses ec ON ec.id = cm.course_id
       WHERE cm.id = $1`,
      [moduleId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Module not found' });
    const mod = rows[0];

    const prompt = `You are a professional L&D specialist for SV Capital, a South African alternative investment firm.
Generate exactly 3 quiz questions for the following course module.

Course: "${mod.course_title}"
Module: "${mod.title}"
Content:
${(mod.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 3000)}

Return ONLY valid JSON — an array of 3 objects:
[
  {
    "question": "Clear question testing understanding of module content",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct": 1,
    "explanation": "Why this answer is correct and how it applies at SV Capital"
  }
]
Rules:
- Vary the correct index (0-3) across questions — not always the same
- Questions must be answerable from the module content only
- Return ONLY the JSON array`;

    const message = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = message.content.find(b => b.type === 'text')?.text || '';
    const questions = validateQuestions(parseJsonArray(text, message.stop_reason));

    await pool.query(
      `UPDATE course_modules SET quiz = $2 WHERE id = $1`,
      [moduleId, JSON.stringify(questions)]
    );

    res.json({ questions });
  } catch (err) {
    console.error('[ai-courses] generate-quiz error:', err.message);
    res.status(500).json({ error: 'Quiz generation failed: ' + err.message });
  }
});

/* ── POST /api/ai/backfill-quizzes  — generate quizzes for ALL modules missing them (admin) ── */
router.post('/backfill-quizzes', requireAuth, async (req, res) => {
  if (!['admin', 'director', 'ceo'].includes((req.user.role || '').toLowerCase())) {
    return res.status(403).json({ error: 'Admin only' });
  }
  try {
    const { rows: modules } = await pool.query(`
      SELECT cm.*, ec.title AS course_title
      FROM course_modules cm
      JOIN employee_courses ec ON ec.id = cm.course_id
      WHERE cm.quiz IS NULL OR cm.quiz::text = '[]' OR cm.quiz::text = 'null'
      ORDER BY cm.course_id, cm.module_index
    `);

    if (!modules.length) return res.json({ updated: 0, message: 'All modules already have quizzes' });

    let updated = 0;
    const errors = [];
    for (const mod of modules) {
      try {
        const prompt = `You are a professional L&D specialist for SV Capital, a South African alternative investment firm.
Generate exactly 3 quiz questions for the following course module.

Course: "${mod.course_title}"
Module: "${mod.title}"
Content:
${(mod.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 3000)}

Return ONLY valid JSON — an array of 3 objects:
[
  {
    "question": "Clear question testing understanding of module content",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct": 1,
    "explanation": "Why this answer is correct and how it applies at SV Capital"
  }
]
Rules: vary correct index (0-3) across questions. Return ONLY the JSON array.`;

        const message = await client.messages.create({
          model: 'claude-opus-5',
          max_tokens: 4000,
          messages: [{ role: 'user', content: prompt }],
        });
        const text = message.content.find(b => b.type === 'text')?.text || '';
        const questions = validateQuestions(parseJsonArray(text, message.stop_reason));

        await pool.query(`UPDATE course_modules SET quiz = $2 WHERE id = $1`, [mod.id, JSON.stringify(questions)]);
        updated++;
        console.log(`[ai-courses] backfill: quiz added to module "${mod.title}"`);
      } catch (e) {
        errors.push({ module: mod.title, error: e.message });
        console.error(`[ai-courses] backfill error for "${mod.title}":`, e.message);
      }
    }

    res.json({ updated, total: modules.length, errors });
  } catch (err) {
    console.error('[ai-courses] backfill-quizzes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
