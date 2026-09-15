#!/usr/bin/env node
/* Each persona carries a character and a campaign brief, and they render.
 *
 * The Personas panel counted people and described each type in one line. That
 * tells a marketer how big a segment is and nothing they can write to. Every
 * persona now has a character built from what the survey actually returned,
 * and campaign briefs pinned to real products — the minimums, terms and
 * benchmarks are the ones seeded in server/db/setup.js, not invented.
 *
 * Two things this file is really for.
 *
 * The first is scope. PERSONA_PLAYBOOK was declared inside a function while
 * _personaPlaybookHtml sits at module scope, and the helper opens with
 * `typeof PERSONA_PLAYBOOK !== 'undefined' ? … : null` — so it returned an
 * empty string and every card rendered exactly as before, with no error
 * anywhere. A guard written to be safe turned a scope mistake into silence.
 * So the renderer is RUN here, for every persona, and asserted to produce
 * something.
 *
 * The second is FAIS. SV Capital markets under FSP 52449 and may not describe
 * any of these products as guaranteed, safe or capital-protected. Marketing
 * copy that ships in the admin console is copy somebody will paste into an
 * email, so the forbidden words are checked in the copy itself, and every
 * campaign is required to carry its own compliance note.
 *
 * Reads the shipped file. Needs no database.
 *
 * Run: node server/scripts/check-persona-playbook.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const SRC = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');

/* Lifted and run, because the failure this guards against is the renderer
   returning '' without complaint. */
const pbSrc = SRC.slice(SRC.indexOf('const PERSONA_PLAYBOOK = {'),
                        SRC.indexOf('\nfunction _personaPlaybookHtml'));
const fnAt  = SRC.indexOf('function _personaPlaybookHtml');
const fnSrc = SRC.slice(fnAt, SRC.indexOf('\n}\n', fnAt) + 3);

const ctx = {
  _esc: t => String(t == null ? '' : t).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
};
vm.createContext(ctx);
vm.runInContext(pbSrc + '\n' + fnSrc, ctx);
/* A `const` inside a vm context is a lexical binding, not a property of the
   context object, so ctx.PERSONA_PLAYBOOK is undefined even though the code
   running in there can see it perfectly well. Read out by evaluating the name. */
const PLAYBOOK = vm.runInContext('PERSONA_PLAYBOOK', ctx);

const PERSONAS = [
  ['Explorer', 50], ['Growth Seeker', 28], ['Income Investor', 17],
  ['Long-Term Planner', 2], ['Conservative Saver', 2],
];
const render = (name, count) => ctx._personaPlaybookHtml(PLAYBOOK[name] || null, count, '#fec24f');

console.log('\nboth halves are reachable from one another');
{
  ok('the playbook is at module scope', /^const PERSONA_PLAYBOOK = \{/m.test(SRC),
     'declared inside a function, the module-scope renderer cannot see it and silently renders nothing');
  ok('and so is the renderer', /^function _personaPlaybookHtml\(/m.test(SRC));
  /* The entry is looked up before the template literal, not inside the helper:
     check-markup-interpolation reads a bare `name` in a substitution as a field
     somebody can type, and the fix for that is to keep it out of the markup
     rather than to escape a helper whose own HTML would come back as entities. */
  ok('the card calls it', /\$\{_personaPlaybookHtml\(pb, count, m\.color\)\}/.test(SRC));
  ok('with the entry resolved outside the literal',
     /const pb = PERSONA_PLAYBOOK\[name\] \|\| null;/.test(SRC));
}

console.log('\nevery persona renders a brief');
for (const [name, count] of PERSONAS) {
  const html = render(name, count);
  ok(`${name} produces one`, !!html && html.length > 500, `${html ? html.length : 0} chars`);
  ok(`  it names a person`, /<div style="font-weight:600;font-size:0\.86rem/.test(html));
  ok(`  it quotes them`, /&ldquo;/.test(html) && /&rdquo;/.test(html));
  ok(`  it lists what they want, what blocks them and what fits`,
     ['Wants', 'Blocks', 'Fit'].every(l => html.includes(`>${l}<`)),
     'a character with no handles on it is a short story, not a brief');
  const campaigns = (html.match(/scale-balanced/g) || []).length;
  ok(`  it carries at least one campaign`, campaigns >= 1, `${campaigns} found`);
  ok(`  every campaign has a compliance note`,
     campaigns === (html.match(/fa-scale-balanced/g) || []).length && campaigns > 0,
     'the note is what stops the copy being pasted into an email unchecked');
}

console.log('\na persona too small to budget against says so');
{
  for (const [name, count] of PERSONAS) {
    const html = render(name, count);
    const warned = /too few to budget against/.test(html);
    ok(`${name} (${count}) ${count < 5 ? 'warns' : 'does not warn'}`, warned === (count < 5),
       'a persona standing on two people is a description of two people');
  }
  ok('an unknown persona renders nothing rather than throwing',
     render('Risk Taker', 0) === '',
     'PERSONA_META has six entries and the survey has produced five');
}

console.log('\nthe copy is FAIS-safe');
{
  /* Not a stylistic preference. Under FAIS these words misrepresent every
     product in the catalogue, and this copy is written to be pasted. */
  const FORBIDDEN = /\b(guaranteed|guarantee|risk-free|riskfree|no risk|capital[- ]protected|safe investment)\b/i;
  for (const [name] of PERSONAS) {
    const pb = PLAYBOOK[name];
    const prose = [pb.who, pb.life, pb.quote, pb.wants, pb.blocks, pb.fit,
                   ...pb.campaigns.flatMap(c => [c.ch, c.hl, c.body, c.cta])].join(' ');
    ok(`${name} promises nothing it cannot`, !FORBIDDEN.test(prose),
       (prose.match(FORBIDDEN) || [])[0]);
  }
  /* The compliance notes are the one place those words may appear, because
     that is where they are being forbidden. */
  ok('the notes are where the prohibition is stated',
     PLAYBOOK['Conservative Saver'].campaigns.some(c => /guaranteed/i.test(c.comp)),
     'the persona most likely to be misled by a softened phrase should carry the warning');
}

console.log('\nthe briefs are pinned to products that exist');
{
  const setup = fs.readFileSync(path.join(ROOT, 'server', 'db', 'setup.js'), 'utf8');
  const claims = [
    ['cattle at R500',        /min_investment: 500, term_months: 12/, /R500/],
    ['delivery bikes R3 100', /min_investment: 3100, term_months: 18/, /R3 100/],
    ['12J at R5 000',         /min_investment: 5000, term_months: 60/, /R5 000/],
  ];
  const allCopy = PERSONAS.map(([n]) => JSON.stringify(PLAYBOOK[n])).join(' ');
  for (const [label, inSetup, inCopy] of claims) {
    ok(`${label} — the seed still says so`, inSetup.test(setup),
       'if the product changed, the campaign brief quoting it is now wrong');
    ok(`${label} — and a brief quotes it`, inCopy.test(allCopy));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
