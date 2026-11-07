#!/usr/bin/env node
/* The group workspace in isiZulu and Sesotho — complete, and held back
 * until a translator has signed it off.
 *
 * Two promises, and this file keeps both:
 *
 *  · COMPLETE. Every string the workspace routes through _svT has an
 *    isiZulu and a Sesotho entry, and the two dictionaries carry the same
 *    keys. A half-translated screen that switches language mid-sentence is
 *    worse than English.
 *  · HELD BACK. A language reaches a client only when staff list it in
 *    group_languages_live. Before that it is offered only to a reviewer
 *    (?svDraftLang=1) and is marked draft on screen. The release flags fail
 *    closed: if they cannot be read, English is all anybody gets.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-group-languages.cjs
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
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CORE = read('js/portal-core.js');

/* A sandbox the shared core can be loaded into: it declares functions and
   nothing else, so loading it runs nothing. */
function sandbox({ live = [], stored = null, search = '' } = {}) {
  const store = new Map(stored ? [['svc_group_lang', stored]] : []);
  const sess = new Map();
  const ctx = {
    window: {}, location: { search },
    localStorage: { getItem: k => store.get(k) || null, setItem: (k, v) => store.set(k, v) },
    sessionStorage: { getItem: k => sess.get(k) || null, setItem: (k, v) => sess.set(k, v) },
    _esc: s => String(s),
  };
  ctx.window.__SVREL = { live };
  vm.createContext(ctx);
  vm.runInContext(CORE, ctx);
  return ctx;
}

console.log('\ncomplete');
{
  const ctx = sandbox();
  const d = ctx._svDict();
  const zu = Object.keys(d.zu).sort(), st = Object.keys(d.st).sort();
  ok('isiZulu and Sesotho carry the same keys',
     JSON.stringify(zu) === JSON.stringify(st),
     `only in zu: ${zu.filter(k => !st.includes(k))} · only in st: ${st.filter(k => !zu.includes(k))}`);
  /* Literal keys, plus the tab keys built from the tab list ('tab.' + key). */
  const used = [...new Set([
    ...[...CORE.matchAll(/_svT\('([a-z.]+[a-z])'/g)].map(m => m[1]),
    ...ctx._svTabList().map(([key]) => 'tab.' + key),
    ...['pending', 'approved', 'rejected', 'used', 'expired'].map(x => 'status.' + x),
  ])];
  const missing = used.filter(k => !(k in d.zu) || !(k in d.st));
  ok(`every one of the ${used.length} keys the screens use is translated`, used.length > 40 && !missing.length,
     `missing: ${missing.join(', ')}`);
  const unused = zu.filter(k => !used.includes(k));
  ok('and no translation is left behind unused', !unused.length, `unused: ${unused.join(', ')}`);
  const blank = [...zu.map(k => ['zu', k, d.zu[k]]), ...st.map(k => ['st', k, d.st[k]])]
    .filter(([, , v]) => !String(v || '').trim());
  ok('no entry is blank', !blank.length, JSON.stringify(blank));
  ok('the money words are translated, not borrowed whole',
     /sayin/.test(d.zu['ap.title']) && /saen/.test(d.st['ap.title'])
     && d.zu['btn.approve'] !== 'Approve' && d.st['btn.approve'] !== 'Approve',
     'who must approve a withdrawal is the one sentence that has to be right');
  ok('each says it is a draft in its own language', !!d.zu['lang.draft'] && !!d.st['lang.draft']);
}

console.log('\nheld back until signed off');
{
  const off = sandbox({ stored: 'zu' });
  ok('with nothing released, a member who chose isiZulu still sees English',
     off._svLang() === 'en' && off._svT('btn.approve', 'Approve') === 'Approve');
  ok('and no picker is shown at all', off._svLangBar('G1') === '');

  const rev = sandbox({ stored: 'zu', search: '?svDraftLang=1' });
  ok('a reviewer with ?svDraftLang=1 sees the draft', rev._svLang() === 'zu'
     && rev._svT('btn.approve', 'Approve') === 'Vuma');
  ok('marked draft in the picker and on the screen',
     /\(draft\)/.test(rev._svLangBar('G1')) && /role="note"/.test(rev._svLangBar('G1')));

  const live = sandbox({ live: ['st'], stored: 'st' });
  ok('once released, a member gets it with no banner',
     live._svT('btn.approve', 'Approve') === 'Dumela' && !/role="note"/.test(live._svLangBar('G1')));
  const notZu = sandbox({ live: ['st'], stored: 'zu' });
  ok('releasing one language does not release the other', notZu._svLang() === 'en');
  ok('English is always the fallback for a key not yet translated',
     live._svT('no.such.key', 'Plain English') === 'Plain English');

  const setup = read('server/db/setup.js');
  ok('both flags are seeded OFF',
     /'group_languages_live', ''/.test(setup) && /'group_templates_live', 'false'/.test(setup));
  ok('and seeded without overwriting a value staff have set',
     /'group_languages_live'[\s\S]{0,400}ON CONFLICT \(key\) DO NOTHING/.test(setup));
  const legal = read('server/routes/legal.js');
  ok('the release flags fail closed',
     /catch \(_\) \{ res\.json\(\{ languages_live: \[\], templates_live: false \}\)/.test(legal));
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

(async () => {
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  try {
    const { groupResources } = require(path.join(ROOT, 'server', 'routes', 'legal.js'));
    const set = (k, v) => db.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
    console.log('\nthe flags, as staff set them');
    const fresh = await groupResources();
    ok('a fresh database releases nothing', fresh.languages_live.length === 0 && fresh.templates_live === false,
       JSON.stringify(fresh));
    await set('group_languages_live', ' ZU, st,xx,zu ');
    await set('group_templates_live', 'true');
    const after = await groupResources();
    ok('a list typed loosely is read as the languages it names, and nothing else',
       JSON.stringify(after.languages_live.sort()) === '["st","zu"]', JSON.stringify(after));
    ok('and the templates follow their own flag', after.templates_live === true);
    await set('group_languages_live', '');
    await set('group_templates_live', 'false');
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
