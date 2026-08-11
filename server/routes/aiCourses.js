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
    const stream = await client.messages.stream({
      model: 'claude-opus-5',
      max_tokens: 6000,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: prompt }],
    });

    const message = await stream.finalMessage();
    const text = message.content.find(b => b.type === 'text')?.text || '';

    // Extract JSON — strip any markdown fences Claude may add
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude did not return a valid JSON object');
    const data = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(data.modules) || data.modules.length < 3) {
      throw new Error('Expected 3 modules in generated content');
    }

    const courseId = `CRS-AI-${Date.now()}`;
    const color    = CAT_COLORS[category] || '#eda5ff';
    const xpTotal  = 200;
    const xpSplit  = [0.30, 0.35, 0.35];

    // Write course to DB (server-side so bypasses ADMIN_WRITE_TABLES)
    const { rows: [course] } = await pool.query(
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
    );

    // Write modules
    const modules = [];
    for (let i = 0; i < 3; i++) {
      const m = data.modules[i];
      const { rows: [mod] } = await pool.query(
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

    console.log(`[ai-courses] Generated "${title}" for emp ${empId || role} — ${modules.length} modules`);
    res.json({ course, modules });

  } catch (err) {
    console.error('[ai-courses] generation error:', err.message);
    res.status(500).json({ error: 'Course generation failed: ' + err.message });
  }
});

module.exports = router;
