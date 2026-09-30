#!/usr/bin/env node
/* Staff training on the three Ethical & Interest-Free structures.
 *
 * The offering is the one place on this platform where a confident, helpful,
 * WRONG sentence from a staff member is a compliance problem rather than a
 * service one — "it's Sharia certified" (it is not), "you'll get 14.5%" (it is
 * a projection off a venture's own numbers). These courses exist to stop that,
 * so two things have to be true of them and neither is true by accident.
 *
 * FIRST, the figures have to be the product's figures. A course that teaches
 * a 36-month Ijara after someone shortens it to 24 in EIF_PRODUCTS is worse
 * than no course: staff would quote it with confidence. Every parameter
 * asserted here is READ OUT of EIF_PRODUCTS rather than restated, so the
 * check fails the day the two disagree.
 *
 * SECOND, the quiz has to test something. The first draft of these had the
 * correct answer as the longest option in 92% of questions and at index 1 in
 * 86% — every compliance question in all three courses was passable by
 * picking the second, longest option without reading a word. A quiz with a
 * tell is not an assessment, it is a formality with a pass rate.
 *
 * Needs a database for the seeding half only:
 *   DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-eif-courses.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT  = path.join(__dirname, '..', '..');
const read  = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SETUP = read('server/db/setup.js');
const { EIF_COURSES } = require(path.join(ROOT, 'server', 'db', 'courses-eif.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const BY_ID = Object.fromEntries(EIF_COURSES.map(c => [c.id, c]));
const COURSE_FOR = {
  eif_murabaha:  'CRS-PROD-EIF-MURABAHA-001',
  eif_ijara:     'CRS-PROD-EIF-IJARA-001',
  eif_mudarabah: 'CRS-PROD-EIF-MUDARABAH-001',
};
const allText = c => JSON.stringify(c);

/* The product parameters, read out of EIF_PRODUCTS rather than restated. */
function products() {
  const block = (SETUP.match(/const EIF_PRODUCTS = \[[\s\S]*?\n\];/) || [''])[0];
  const out = {};
  for (const m of block.matchAll(/product_type: '(eif_[a-z]+)'[\s\S]*?min_investment: (\d+), term_months: (\d+), benchmark_rate: ([\d.]+)[\s\S]*?risk_profile: '([^']+)'/g)) {
    out[m[1]] = { min: +m[2], term: +m[3], rate: +m[4], risk: m[5] };
  }
  return out;
}
const P = products();

console.log('\nthere is a course for each structure, and it is wired in');
{
  ok('EIF_PRODUCTS still defines three structures', Object.keys(P).length === 3, JSON.stringify(Object.keys(P)));
  for (const [type, id] of Object.entries(COURSE_FOR)) {
    ok(`${type} has a course`, !!BY_ID[id], id);
  }
  ok('the courses are spread into STANDARD_COURSES, so they seed',
     /require\('\.\/courses-eif'\)/.test(SETUP) && /\.\.\.EIF_COURSES,/.test(SETUP),
     'a course file nothing reads teaches nobody');
  ok('and no id collides with a course already seeded',
     EIF_COURSES.every(c => (SETUP.match(new RegExp(`id: '${c.id}'`, 'g')) || []).length === 0),
     'ON CONFLICT DO NOTHING would silently skip a duplicate');
}

console.log('\nevery course is set up to be done, and to count');
{
  for (const c of EIF_COURSES) {
    ok(`${c.id}: required, for all roles`, c.is_required === true && c.role_target === 'all');
    ok(`${c.id}: four modules, and says so`, c.modules.length === 4 && c.modules_count === 4);
    const q = c.modules.reduce((a, m) => a + m.quiz.length, 0);
    ok(`${c.id}: ${q} questions, and says so`, q === c.quiz_questions, `declares ${c.quiz_questions}`);
    const xp = c.modules.reduce((a, m) => a + m.xp_reward, 0);
    ok(`${c.id}: module XP adds up to the course XP (${c.xp_reward})`, xp === c.xp_reward, `modules total ${xp}`);
    ok(`${c.id}: carries XP and a KPI dimension`,
       c.xp_reward > 0 && !!c.kpi_dimension && c.kpi_boost_points > 0);
    ok(`${c.id}: every module has content, key points and a quiz`,
       c.modules.every(m => m.content && m.content.length > 400 && m.key_points.length >= 3 && m.quiz.length >= 3));
  }
}

console.log('\nthe figures taught are the product\'s own figures');
{
  /* Read out of EIF_PRODUCTS. Change a term there and this fails until the
     course agrees with it again. */
  const rands = n => {
    const d = String(n);
    const grouped = d.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return [`R${d}`, `R${grouped}`, `R${grouped.replace(/ /g, '\u00a0')}`, `R${d.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`];
  };
  for (const [type, id] of Object.entries(COURSE_FOR)) {
    const t = allText(BY_ID[id]);
    const p = P[type];
    ok(`${type}: the course states the R${p.min} minimum`,
       rands(p.min).some(r => t.includes(r)), `looked for ${rands(p.min).join(' or ')}`);
    ok(`${type}: the course states the ${p.term}-month term`,
       new RegExp(`${p.term}[- ]month|${p.term} months`).test(t)
       || (p.term === 6  && /six[- ]month|six months/i.test(t))
       || (p.term === 12 && /twelve[- ]month|twelve months/i.test(t))
       || (p.term === 36 && /thirty-six month|three-year|three years/i.test(t)));
    const pct = (p.rate * 100).toFixed(1).replace(/\.0$/, '');
    ok(`${type}: the course states the ${pct}% rate`, t.includes(`${pct}%`));
    ok(`${type}: the terms list gives the risk profile as ${p.risk}`,
       new RegExp(`Risk profile:</strong> ${p.risk}(<|\\s[^<]*<)`).test(BY_ID[id].modules.map(m => m.content).join(' ')),
       'a bare mention passes on prose like "Medium rather than Low"');
  }
  ok('Mudarabah teaches the 80/20 split that EIF_PRODUCTS records',
     /80% investors, 20% manager/.test(SETUP)
     && /80%[^.]*investors[^.]*20%/.test(allText(BY_ID['CRS-PROD-EIF-MUDARABAH-001'])));
}

console.log('\nthe compliance lines are in every course');
{
  for (const c of EIF_COURSES) {
    const t = allText(c);
    ok(`${c.id}: says no certificate is held`,
       /do not yet hold a certificate|We do not yet hold|no certificate/i.test(t));
    /* Everything the course TEACHES: prose, key points, and the explanation
       under each answer. Deliberately excludes the quiz options, because a
       wrong option has to be able to contain the claim — that is the whole
       point of asking. */
    const taught = [c.description, c.learning_objectives,
      ...c.modules.flatMap(m => [m.content, ...m.key_points, ...m.quiz.map(q => q.explanation)])].join(' ');
    ok(`${c.id}: the teaching never asserts the offering IS certified`,
       !/\bis Sharia certified\b|\bare certified\b|\bSharia[- ]compliant\b|\bfully compliant\b|\bcertified by\b/i.test(taught),
       'the only place those words may appear is inside a quiz option marked wrong');
    /* An option that ASSERTS certification, as against one that denies it —
       the correct answer necessarily mentions the certificate in order to say
       there is not one, so a bare keyword match would flag the right answer. */
    const claims = c.modules.flatMap(m => m.quiz.flatMap(q =>
      q.options.map((o, i) => ({ o, wrong: i !== q.correct }))))
      .filter(x => /certif|sharia[- ]compliant|signed these products off/i.test(x.o))
      .filter(x => !/\b(no|not|never|without)\b/i.test(x.o));
    ok(`${c.id}: puts the certification claim in front of the learner as a wrong answer`,
       claims.length > 0 && claims.every(x => x.wrong),
       claims.length ? claims.filter(x => !x.wrong).map(x => x.o).join(' | ')
                     : 'each course is required on its own, so each must ask this');
    ok(`${c.id}: teaches the fee as charged ON TOP`,
       /charged on top|on top of the amount/i.test(taught));
    ok(`${c.id}: and never anywhere says it comes out of the investment`,
       !/deducted from it|deducted from the (amount|investment)|taken (out )?of the amount|comes out of the amount/i.test(taught),
       'the fee is charged on top on every product on this platform');
    ok(`${c.id}: teaches that EIF settles in cash at maturity`,
       /pays out in cash|settles in cash/i.test(t) && /no rollover|do not roll over/i.test(t));
    ok(`${c.id}: lists the excluded sectors`,
       /gambling/i.test(t) && /tobacco/i.test(t) && /adult entertainment/i.test(t));
    ok(`${c.id}: names the provider and the fund manager correctly`,
       /SmartVest Financial Services \(Pty\) Ltd/.test(t) && /FSP 52449/.test(t)
       && /SV Capital is the fund manager/.test(t) && !/t\/a SV Capital/.test(t));
  }
  ok('Mudarabah refuses to let the target be described as a promise',
     /target[^.]*not a promise/i.test(allText(BY_ID['CRS-PROD-EIF-MUDARABAH-001'])));
  ok('and teaches that a loss falls on the capital',
     /loss falls on the capital/i.test(allText(BY_ID['CRS-PROD-EIF-MUDARABAH-001'])));
  {
    /* The single most dangerous thing to get wrong here: an operating partner
       who shared a cash loss would be guaranteeing the capital, and a
       guaranteed partnership is a loan. */
    const m = BY_ID['CRS-PROD-EIF-MUDARABAH-001'];
    const mTaught = [m.description, m.learning_objectives,
      ...m.modules.flatMap(x => [x.content, ...x.key_points, ...x.quiz.map(q => q.explanation)])].join(' ');
    ok('and never says the loss is shared, or that the operator covers any of it',
       !/loss(es)? (are|is) shared|shar(e|es|ing) the loss|operat\w+ (partner )?(covers|contributes to|bears) (the |a |any )?loss/i
         .test(mTaught.replace(/rather than shar\w+ the loss/gi, '')
                      .replace(/rather than contributing to the loss/gi, '')),
       'the operator forfeits profit; requiring them to cover a cash loss makes it a loan');
  }
}

console.log('\nthe quiz is an assessment, not a formality');
{
  const qs = EIF_COURSES.flatMap(c => c.modules.flatMap(m => m.quiz));
  ok('every question has four distinct options',
     qs.every(q => q.options.length === 4 && new Set(q.options).size === 4));
  ok('every answer key points at an option that exists',
     qs.every(q => Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length));
  ok('every question explains its answer',
     qs.every(q => q.explanation && q.explanation.length > 60));
  ok('no question is asked twice across the three courses',
     new Set(qs.map(q => q.question)).size === qs.length,
     'somebody taking all three should not answer the same question three times');

  /* The two tells the first draft had. */
  const spread = qs.reduce((a, q) => (a[q.correct] = (a[q.correct] || 0) + 1, a), {});
  const worst = Math.max(...Object.values(spread));
  ok(`the answer key is spread across the options (worst position holds ${worst}/${qs.length})`,
     worst <= qs.length * 0.45, JSON.stringify(spread));
  ok('all four positions are used', Object.keys(spread).length === 4, JSON.stringify(spread));

  const longest = qs.filter(q => {
    const L = q.options.map(o => o.length);
    return L[q.correct] === Math.max(...L);
  });
  ok(`the key is not simply the longest option (${longest.length}/${qs.length})`,
     longest.length <= qs.length * 0.7,
     'if the wordiest option is always right, the quiz can be passed without reading');
  const blatant = qs.filter(q => {
    const L = q.options.map(o => o.length).sort((a, b) => b - a);
    return q.options[q.correct].length === L[0] && L[0] - L[1] > 18;
  });
  ok(`and never longest by a mile (${blatant.length} question(s))`, blatant.length === 0,
     blatant.map(q => q.question).join(' | '));
}

/* ── The half that needs a database ───────────────────────────────── */
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\n  (skipping the seeding half — DATABASE_URL not set)');
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

    console.log('\nand they actually reach the database');
    const { rows } = await db.query(`
      SELECT c.id, c.xp_reward, c.is_required, c.pass_score,
             COUNT(m.id)::int AS modules,
             COALESCE(SUM(jsonb_array_length(m.quiz)), 0)::int AS questions,
             COALESCE(SUM(m.xp_reward), 0)::int AS module_xp
        FROM employee_courses c
        LEFT JOIN course_modules m ON m.course_id = c.id
       WHERE c.id LIKE 'CRS-PROD-EIF-%'
       GROUP BY c.id, c.xp_reward, c.is_required, c.pass_score
       ORDER BY c.id`);
    const seen = Object.fromEntries(rows.map(r => [r.id, r]));
    for (const c of EIF_COURSES) {
      const r = seen[c.id];
      ok(`${c.id} is seeded with its modules`,
         !!r && r.modules === c.modules.length && r.questions === c.quiz_questions,
         r ? `${r.modules} modules, ${r.questions} questions` : 'not seeded');
      ok(`${c.id} carries its XP into the row`,
         !!r && r.xp_reward === c.xp_reward && r.module_xp === c.xp_reward,
         r ? `course ${r.xp_reward}, modules ${r.module_xp}` : '');
    }
    ok('and a second run does not duplicate a module',
       await (async () => {
         await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});
         const { rows: [n] } = await db.query(
           `SELECT COUNT(*)::int c FROM course_modules m
             WHERE m.course_id LIKE 'CRS-PROD-EIF-%'`);
         return n.c === EIF_COURSES.reduce((a, x) => a + x.modules.length, 0);
       })(), 'seeding runs on every boot');
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
