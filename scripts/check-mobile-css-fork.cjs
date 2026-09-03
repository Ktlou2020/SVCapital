#!/usr/bin/env node
/* mobile/src/css/ holds what the app styles differently — never a copy of a
 * shared stylesheet.
 *
 * The mobile build copies mobile/src/ over portal/ and the root js|css/ last, so
 * a file placed there does not merge with its shared counterpart, it REPLACES
 * it. mobile/src/css/ had grown nine such replacements: admin.css, ci-theme.css,
 * portal.css, portal-premium.css and five more that nothing even loaded. The
 * app therefore rendered from a snapshot of the stylesheets, and every later fix
 * to portal/css/ reached the web and stopped.
 *
 * That is invisible from either side. Nothing errors, nothing looks stale, the
 * app just renders one release behind — and the drift compounds, because the
 * only way to notice is to compare the two by eye. portal-premium.css was 869
 * lines behind by the time anyone did. What was actually lost:
 *
 *   the rewards cards          rendered unstyled — no background, no layout
 *   the policies header        the gradient panel never appeared
 *   the payment amount chips   71×27 instead of 150×44, under the 44px floor
 *   every modal footer         buttons sized to their text, not the footer
 *   the sidebar backdrop       position:static, so it dimmed nothing
 *
 * Removing the copies also surfaced a rule that was wrong on BOTH sides:
 * `.topbar-btn:not(#sidebarToggleBtn):not(.notif-btn)…{display:none}` excludes a
 * class the notification button has never carried, so the rule written to keep
 * the bell was hiding it. The app was the only place it still showed, because
 * the app was reading a copy from before the rule existed.
 *
 * So this check holds the shape that replaced it:
 *
 *   1. mobile/src/css/ contains only mobile-owned files.
 *   2. Nothing there is a near-copy of a shared stylesheet — measured by shared
 *      selectors, not by name, because renaming the copy would defeat a name
 *      check and change nothing about the problem.
 *   3. The app loads the shared sheets, then the overrides, then mobile-app.css.
 *   4. Every rule in the overrides actually differs from the shared sheets. A
 *      rule that merely restates a shared value is a fork of one line: it stops
 *      tracking the moment the shared value moves, and nothing says so.
 *   5. No `body.dark-mode` rules. initDarkMode() removes that class and empties
 *      its localStorage key, toggleDarkMode() is empty — the feature is gone,
 *      and 84 blocks of it were being carried.
 *
 * Run: node scripts/check-mobile-css-fork.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* The stylesheets mobile/src/ is copied over. A file in mobile/src/css/ whose
   name matches one of these shadows it completely. */
const SHARED = [
  'css/admin.css', 'css/admin-v2.css', 'css/admin-premium.css', 'css/brand.css',
  'css/ci-theme.css', 'css/home-ci.css', 'css/premium.css', 'css/style.css',
  'css/sv-intelligence.css', 'portal/css/portal.css', 'portal/css/portal-premium.css',
];
/* The four the app loads, in cascade order — the overrides must come after. */
const LOADED = ['css/admin.css', 'portal/css/portal.css', 'css/ci-theme.css',
                'portal/css/portal-premium.css'];
const OWNED  = ['mobile-app.css', 'mobile-overrides.css'];

/* ── A stylesheet flattened to (at-rule context, selector) → declarations ──
   Comments go first: a copy and its original differ mostly in comments, and a
   byte comparison would call two identical stylesheets different. */
function parse(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  let i = 0, buf = '';
  while (i < css.length) {
    const c = css[i];
    if (c === '{') {
      const prelude = buf.trim(); buf = '';
      if (/^@(media|supports|layer|container|scope)/.test(prelude)) { stack.push(prelude); i++; continue; }
      let depth = 1, j = i + 1, body = '';
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') { depth--; if (!depth) break; }
        body += css[j]; j++;
      }
      out.push({ ctx: stack.join(' && '), sel: prelude, decls: body.trim() });
      i = j + 1; continue;
    }
    if (c === '}') { stack.pop(); buf = ''; i++; continue; }
    buf += c; i++;
  }
  return out;
}
const normSel = s => s.split(',').map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean).sort().join(', ');
const key     = r => r.ctx + ' ||| ' + normSel(r.sel);

/* prop → value, later declaration winning, exactly as the cascade resolves it
   within one selector. Splitting on ';' has to respect parentheses or a
   `linear-gradient(a, b)` with a semicolon-free comma still parses, but an
   `rgba(…)` inside a var() fallback does not. */
function decls(rules) {
  const m = new Map();
  for (const r of rules) {
    let depth = 0, cur = '';
    const parts = [];
    for (const ch of r.decls) {
      if (ch === '(') depth++; else if (ch === ')') depth--;
      if (ch === ';' && !depth) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    for (const p of parts) {
      const t = p.trim(); if (!t) continue;
      const i = t.indexOf(':'); if (i < 1) continue;
      m.set(t.slice(0, i).trim(), t.slice(i + 1).trim().replace(/\s+/g, ' '));
    }
  }
  return m;
}
function flatten(files) {
  const m = new Map();
  for (const f of files) for (const r of parse(read(f))) {
    const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r);
  }
  return m;
}

console.log('\nmobile/src/css/ holds only what the app owns');
{
  const here = fs.readdirSync(path.join(ROOT, 'mobile/src/css')).filter(f => f.endsWith('.css'));
  const shadowNames = new Set(SHARED.map(p => path.basename(p)));
  const shadowing = here.filter(f => shadowNames.has(f));
  ok('no file there shares a name with a shared stylesheet',
     shadowing.length === 0,
     shadowing.map(f => `mobile/src/css/${f} replaces the shared one wholesale`).join('\n      '));

  const strays = here.filter(f => !OWNED.includes(f));
  ok('and the directory is only the two files the app owns',
     strays.length === 0,
     'unexpected: ' + strays.join(', ') +
     ' — a mobile-only stylesheet is fine, but it has to be linked and named ' +
     'for what it is, not left where the build will copy it over something');
}

console.log('\nand nothing there is a renamed copy of a shared stylesheet');
{
  /* By content: a copy shares almost all of its selectors with its original,
     which no genuine override does. mobile-overrides.css shares 94 selectors
     with sheets carrying well over a thousand. */
  const worst = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'mobile/src/css')).filter(f => f.endsWith('.css'))) {
    const mine = new Set(parse(read('mobile/src/css/' + f)).map(key));
    if (!mine.size) continue;
    for (const s of SHARED) {
      const theirs = new Set(parse(read(s)).map(key));
      if (!theirs.size) continue;
      let shared = 0;
      for (const k of mine) if (theirs.has(k)) shared++;
      const overlap = shared / Math.min(mine.size, theirs.size);
      if (overlap > 0.5) worst.push(`mobile/src/css/${f} shares ${Math.round(overlap * 100)}% of its rules with ${s}`);
    }
  }
  ok('no near-copy by content either', worst.length === 0, worst.join('\n      '));
}

console.log('\nthe app loads the shared sheets, then the overrides, then its own');
{
  const html = read('mobile/src/index.html');
  const links = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)]
    .map(m => m[1]).filter(h => !/^https?:/.test(h))
    .map(h => h.replace(/\?.*$/, '').replace(/^(\.\.)?\//, ''));

  for (const f of LOADED) {
    ok(`it links ${path.basename(f)}`, links.some(l => l.endsWith(path.basename(f))));
  }
  const iOv = links.findIndex(l => l.endsWith('mobile-overrides.css'));
  const iPrem = links.findIndex(l => l.endsWith('portal-premium.css'));
  const iApp = links.findIndex(l => l.endsWith('mobile-app.css'));
  ok('the overrides load after the last shared sheet', iOv > -1 && iPrem > -1 && iOv > iPrem,
     'they are overrides — before it, they lose');
  ok('and before mobile-app.css', iOv > -1 && iApp > -1 && iOv < iApp,
     'that is where these rules sat when they lived in the forked copies; ' +
     'moving them past mobile-app.css would let them win things they used to lose');
}

console.log('\nevery override is a real difference');
{
  const shared = flatten(LOADED);
  const mine   = flatten(['mobile/src/css/mobile-overrides.css']);
  const restated = [];
  for (const [k, rules] of mine) {
    if (!shared.has(k)) continue;                    /* mobile-only component */
    const a = decls(rules), b = decls(shared.get(k));
    const differs = [...a].some(([p, v]) => b.get(p) !== v);
    if (!differs) restated.push(rules[0].sel.replace(/\s+/g, ' ').slice(0, 80));
  }
  ok('no rule merely restates what the shared sheets already say',
     restated.length === 0,
     restated.join('\n      ') +
     '\n      — a rule that agrees with the shared value is a fork of one line: ' +
     'it stops tracking the moment that value moves, and nothing reports it');
}

console.log('\nand nothing carries the removed dark mode');
{
  const core = read('js/portal-core.js');
  ok('dark mode really is gone from the product',
     /function initDarkMode\(\) \{\s*document\.body\.classList\.remove\('dark-mode'\)/.test(core) &&
     /function toggleDarkMode\(\) \{\}/.test(core),
     'if it comes back, the rules that were dropped have to come back with it');
  const ov = read('mobile/src/css/mobile-overrides.css');
  ok('and the overrides do not style it',
     !/\.dark-mode/.test(ov.replace(/\/\*[\s\S]*?\*\//g, '')),
     'no element ever carries the class');
}

console.log('\nthe app keeps the two controls the shared mobile rules hide');
{
  const prem = read('portal/css/portal-premium.css');
  ok('the notification button is excluded by its real id, not a class it lacks',
     /:not\(#notifBtn\)/.test(prem) && !/:not\(\.notif-btn\)/.test(prem),
     'the markup has id="notifBtn" and no .notif-btn anywhere, so the exclusion ' +
     'matched nothing and the rule hid the bell it was written to keep');

  const html = read('mobile/src/index.html');
  const sidebarUser = (html.match(/<div class="sidebar-user">[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
  const sidebarHasSignOut = /Auth\.logout/.test(sidebarUser);
  const ov = read('mobile/src/css/mobile-overrides.css');
  ok('sign out stays reachable',
     sidebarHasSignOut || /\.topbar__actions \.btn--secondary\.btn--sm\s*\{[^}]*display:\s*inline-flex/.test(ov),
     'the shared sheet hides the topbar secondary buttons below 768px because ' +
     'the web portal\'s sidebar carries a sign-out button. The app\'s does not, ' +
     'so hiding the topbar one leaves a client with no way to sign out.');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
