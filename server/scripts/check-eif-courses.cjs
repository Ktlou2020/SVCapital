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

    /* The right figure appearing somewhere is not enough. The course once
       stated the live minimum in its terms list while a quiz still keyed to
       the old one, and that is the half a learner is tested on. So every
       figure the learner could read AS the minimum has to be it, read field
       by field rather than from one joined blob — joining lets an option's
       figure sit next to the next field's word "minimum". */
    const fields = BY_ID[id].modules.flatMap(m => [m.content,
      ...(m.key_points || []),
      ...(m.quiz || []).flatMap(q => [q.question, ...q.options, q.explanation])]);
    const asMinimum = fields
      .flatMap(f => [...String(f || '').matchAll(/R\s?(\d[\d  ,]*\d|\d)[^.<]{0,60}?\bminimum\b/gi)])
      .map(m => +m[1].replace(/[  ,]/g, ''));
    ok(`${type}: every figure it calls the minimum IS the minimum`,
       asMinimum.length > 0 && asMinimum.every(n => n === p.min),
       asMinimum.length ? `found ${[...new Set(asMinimum)].join(', ')}`
                        : 'nothing in the course calls any figure the minimum');

    /* And a question that asks the minimum has to be answerable with it. */
    const asks = BY_ID[id].modules.flatMap(m => m.quiz || [])
      .filter(q => /\bminimum\b/i.test(q.question));
    ok(`${type}: a question about the minimum keys to an option stating it`,
       asks.length > 0 && asks.every(q => rands(p.min).some(r => q.options[q.correct].includes(r))),
       asks.map(q => q.options[q.correct]).join(' | '));
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
    /* The seed only ever reaches a brand-new database, so correcting a
       figure in it does nothing for staging or production unless a step
       repairs the rows. This drives every EIF module back to a wrong minimum
       the way those environments carry it — including the distractor that
       leaned on the minimums differing, which no figure substitution would
       reproduce — and asserts the next boot rewrites all of them.

       Driven from EACH PRODUCT'S OWN minimum, not one hardcoded 'R100 000'.
       That literal was the figure all three courses shared, and the moment
       Murabaha moved to R1 000 000 it stopped matching anything in the
       Murabaha modules: nothing was mangled, so nothing needed repairing,
       and this section went on passing while testing nothing on that course.
       A mangle that quietly matches nothing is the failure mode here, so the
       rows it touched are counted and asserted on. */
        /* THE SEED'S OWN PROSE. Every assertion above this point reads the
       quiz; the terms list is prose, and it sat saying Murabaha's minimum
       was "R100 000 — the same across all three EIF structures" for as long
       as that was true of all three. When Murabaha moved to R1 000 000 the
       sentence became false in both halves and nothing here noticed: the
       repair step rewrote the module from the seed, and the seed was what
       was wrong. A figure called the minimum in the teaching text is as
       binding as one in an answer key, so it is read the same way. */
    console.log('\nand the teaching text itself states the product\'s own minimum');
    for (const c of EIF_COURSES) {
      const type = Object.entries(COURSE_FOR).find(([, cid]) => cid === c.id);
      const want = P[type[0]].min;
      const said = [];
      for (const m of c.modules) {
        const txt = (m.content + ' ' + JSON.stringify(m.key_points))
          .replace(/<[^>]+>/g, ' ');
        /* Both orders, because the sentence that was wrong put the word
           first and a figure-first scan reads straight past it. */
        for (const re of [/R\s?(\d[\d ,\u00a0]*\d)[^.]{0,60}?minimum/gi,
                          /minimum[^.]{0,60}?R\s?(\d[\d ,\u00a0]*\d)/gi])
          for (const h of txt.matchAll(re))
            said.push({ mod: m.module_index, n: +h[1].replace(/[ ,\u00a0]/g, '') });
      }
      ok(`${c.id}: the teaching text names a minimum at all`, said.length > 0,
         'a scan that finds nothing asserts nothing');
      ok(`${c.id}: and every one of them is the product's own figure (R${want})`,
         said.every(x => x.n === want),
         said.filter(x => x.n !== want)
             .map(x => `module ${x.mod} says R${x.n}`).join(', '));
    }

console.log('\nand modules still teaching the old minimum are corrected in place');
    const setup = () => require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});
    /* Any separator between the groups: the seed writes non-breaking spaces,
       a console edit may well not. */
    const figureRe = n => new RegExp('R\\s?' + String(n)
      .replace(/\B(?=(\d{3})+(?!\d))/g, '[\\s,\u00a0]?'), 'g');
    let mangled = 0;
    for (const c of EIF_COURSES) {
      const type = Object.entries(COURSE_FOR).find(([, cid]) => cid === c.id);
      const re = figureRe(P[type[0]].min);
      const { rows: before } = await db.query(
        `SELECT module_index, content, key_points, quiz FROM course_modules
          WHERE course_id = $1`, [c.id]);
      for (const r of before) {
        const kpWas = JSON.stringify(r.key_points), qWas = JSON.stringify(r.quiz);
        const content = r.content.replace(re, 'R500');
        const key_points = kpWas.replace(re, 'R500');
        const quiz = qWas.replace(re, 'R500')
          .replace('Whichever pool happens to be open for subscription, without reference to risk',
                   'Whichever carries the lowest minimum, without reference to risk');
        if (content === r.content && key_points === kpWas && quiz === qWas) continue;
        mangled++;
        await db.query(
          `UPDATE course_modules SET content = $3, key_points = $4::jsonb, quiz = $5::jsonb
            WHERE course_id = $1 AND module_index = $2`,
          [c.id, r.module_index, content, key_points, quiz]);
      }
    }
    /* Every course must have had something to break, or the repair below is
       being asserted on modules that were already correct. */
    ok('the stale state was actually written, on every course',
       mangled >= EIF_COURSES.length, `${mangled} modules mangled`);
    await setup();
    for (const c of EIF_COURSES) {
      const { rows } = await db.query(
        `SELECT module_index, content, key_points, quiz FROM course_modules
          WHERE course_id = $1 ORDER BY module_index`, [c.id]);
      /* jsonb sorts object keys, so a stored question bears no resemblance
         to the JS literal it was written from. Compared canonically. */
      const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));
      const same = c.modules.every(m => {
        const r = rows.find(x => x.module_index === m.module_index);
        return r && r.content === m.content
          && canon(r.key_points) === canon(m.key_points)
          && canon(r.quiz) === canon(m.quiz);
      });
      ok(`${c.id}: every stale module is rewritten from the seed`, rows.length === c.modules.length && same,
         rows.filter(r => !c.modules.some(m => m.module_index === r.module_index && m.content === r.content))
             .map(r => `module ${r.module_index}: ${(r.content.match(/R500[^<]{0,30}/) || ['content differs'])[0]}`)
             .join(' | '));
      const qs = rows.flatMap(r => r.quiz || []);
      /* THE PRODUCT'S OWN minimum, not R100 000 for everything. This
         hardcoded one figure across all three courses, which held only
         while all three shared a minimum. Murabaha asks R1 000 000 now, and
         a check that insists its answer says R100 000 is asserting the bug.
         Read from EIF_PRODUCTS, like every other figure in this file. */
      const typeFor = Object.entries(COURSE_FOR).find(([, cid]) => cid === c.id);
      const wantMin = typeFor ? P[typeFor[0]].min : null;
      ok(`${c.id}: the course maps to a product`, wantMin != null, c.id);
      const wantedMin = n => {
        const d = String(n);
        const g = d.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
        return new RegExp('R(?:' + d + '|' + g.replace(/ /g, '[\\s,\u00a0]') + ')');
      };
      ok(`${c.id}: and every minimum question keys to the product's own figure`,
         wantMin != null && qs.filter(q => /\bminimum\b/i.test(q.question || ''))
           .every(q => wantedMin(wantMin).test(q.options[q.correct])),
         'want R' + wantMin + ' — got: '
         + qs.filter(q => /\bminimum\b/i.test(q.question || ''))
             .map(q => q.options[q.correct]).join(' | '));
    }

    /* THE WORD-FIRST FORM ON ITS OWN. The mangle above leaves several
       stale figures in each module, so the module is flagged by whichever
       one the detector happens to read — and a detector that only reads
       "R100 000 … minimum" still repairs the terms list as a side effect of
       catching a different sentence. This breaks ONLY "Minimum investment:
       R…", the plainest way anyone writes it, and leaves every other figure
       correct: nothing but a detector that reads the word first can see it. */
    const wfRows = [];
    for (const c of EIF_COURSES) {
      const { rows } = await db.query(
        `SELECT module_index, content FROM course_modules
          WHERE course_id = $1 AND content LIKE '%Minimum investment:%'`, [c.id]);
      for (const r of rows) {
        /* R250 000, not R500: the step also flags a module on a list of
           SUPERSEDED figures, and R500 is on it — breaking it with one of
           those flags the module by the marker path and proves nothing
           about whether the sentence itself was read. This figure is on no
           list, so the word-first pattern is the only thing that can see
           it. */
        const broken = r.content.replace(
          /(Minimum investment:<\/strong>\s*)R\s?\d[\d ,\u00a0]*\d/i, '$1R250\u00a0000');
        if (broken === r.content) continue;
        wfRows.push({ id: c.id, mod: r.module_index, was: r.content });
        await db.query(
          `UPDATE course_modules SET content = $3
            WHERE course_id = $1 AND module_index = $2`, [c.id, r.module_index, broken]);
      }
    }
    ok('a module was broken in the word-first form only', wfRows.length > 0,
       'nothing to repair means nothing asserted');
    await setup();
    for (const w of wfRows) {
      const { rows: [r] } = await db.query(
        `SELECT content FROM course_modules WHERE course_id = $1 AND module_index = $2`,
        [w.id, w.mod]);
      ok(`${w.id}: "Minimum investment: R250 000" is caught and repaired`,
         !!r && r.content === w.was,
         'the figure sits AFTER the word, which a figure-first scan reads past');
    }

    /* And having been corrected, a module is left alone — course content is
       editable in the console, and a step that rewrote it on every boot would
       quietly discard whatever was changed there. */
    await db.query(
      `UPDATE course_modules SET content = content || '<p data-check="console-edit">Edited in the console.</p>'
        WHERE course_id = $1 AND module_index = $2`,
      [EIF_COURSES[0].id, EIF_COURSES[0].modules[0].module_index]);
    await setup();
    const { rows: [edited] } = await db.query(
      `SELECT content FROM course_modules WHERE course_id = $1 AND module_index = $2`,
      [EIF_COURSES[0].id, EIF_COURSES[0].modules[0].module_index]);
    /* EVERY module, not one. The module above carries no quiz question
       about the minimum, and the modules that do are the ones that were
       being rewritten on every boot: the step read every option of such a
       question, distractors included, so "R100 000 and six months" — a
       wrong answer doing its job under a Murabaha question — made its
       module permanently stale. Four modules were rewritten on the boot
       that seeded them and on every boot since, and this assertion covered
       none of them. Each module is edited and each edit must survive. */
    const stamp = (id, idx) => `<p data-check="console-edit-${idx}">Edited.</p>`;
    for (const c of EIF_COURSES)
      for (const m of c.modules)
        await db.query(
          `UPDATE course_modules SET content = content || $3
            WHERE course_id = $1 AND module_index = $2`,
          [c.id, m.module_index, stamp(c.id, m.module_index)]);
    await setup();
    const survived = [];
    for (const c of EIF_COURSES)
      for (const m of c.modules) {
        const { rows: [r] } = await db.query(
          `SELECT content FROM course_modules WHERE course_id = $1 AND module_index = $2`,
          [c.id, m.module_index]);
        if (!r || !r.content.includes(stamp(c.id, m.module_index)))
          survived.push(`${c.id} m${m.module_index}`);
      }
    ok('a console edit survives on EVERY module, including those with a minimum question',
       survived.length === 0,
       'rewritten from the seed, discarding the edit: ' + survived.join(', '));

    ok('a console edit to an already-correct module survives the next boot',
       !!edited && edited.content.includes('data-check="console-edit"'),
       'the correction is scoped by the stale figure, not by course id');

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
