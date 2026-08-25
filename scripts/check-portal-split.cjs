/* portal/js/portal.js and mobile/src/js/portal.js were a 13k-line fork of each
   other. 333 of their functions were byte-identical; those now live once in
   js/portal-core.js, loaded before each platform file on both surfaces.

   The arrangement only works because of how classic scripts share scope:

     - a top-level `function f(){}` becomes a global property, so core's
       functions and the platform's can call each other freely;
     - top-level const/let live in a shared global lexical environment and must
       be declared exactly once, so they stay in the platform files;
     - core therefore must contain ONLY function declarations. If anything in
       it executed at load, it could touch a const the platform file has not
       declared yet and throw.

   This guards those invariants, and that core still reaches both surfaces. */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CORE     = path.join(ROOT, 'js/portal-core.js');
const WEB      = path.join(ROOT, 'portal/js/portal.js');
const MOB      = path.join(ROOT, 'mobile/src/js/portal.js');
const MOB_BUILT= path.join(ROOT, 'mobile/www/js/portal-core.js');
const WEB_HTML = path.join(ROOT, 'portal/index.html');
const MOB_HTML = path.join(ROOT, 'mobile/src/index.html');
const SW       = path.join(ROOT, 'mobile/src/sw.js');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

const read = f => fs.readFileSync(f, 'utf8');
const fnNames = src => [...src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1]);

const core = read(CORE), web = read(WEB), mob = read(MOB);

// ── core must be inert ─────────────────────────────────────────────────────
const topLevelState = [...core.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
check('core declares no top-level state', topLevelState.length === 0,
  `found: ${topLevelState.join(', ')} — these belong in the platform files, and duplicating a const across scripts is a redeclaration error`);

/* Walk the top level, skipping whole function bodies. Judging lines
   individually does not work: this file is full of multi-line HTML template
   literals whose content sits at column 0 and would look like code. Core is
   generated, so every function ends on a line that is exactly "}". */
const coreLines = core.split('\n');
const stray = [];
for (let i = 0; i < coreLines.length; i++) {
  const l = coreLines[i];
  if (/^(?:async\s+)?function\s/.test(l)) {
    while (i < coreLines.length && coreLines[i] !== '}') i++;   // skip the body
    continue;
  }
  if (!l.trim()) continue;
  if (/^\s/.test(l)) continue;                                  // indented: inside something
  if (/^\s*(\/\/|\/\*|\*|\*\/)/.test(l)) continue;             // comment
  if (/^['"]use strict['"];?$/.test(l.trim())) continue;        // directive
  stray.push({ l, n: i + 1 });
}
check('core contains no load-time executable statements', stray.length === 0,
  stray.slice(0, 3).map(s => `line ${s.n}: ${s.l.slice(0, 60)}`).join(' | '));

// ── no function may be declared twice ──────────────────────────────────────
const coreFns = new Set(fnNames(core));
for (const [label, src] of [['web portal.js', web], ['mobile portal.js', mob]]) {
  const dupes = fnNames(src).filter(n => coreFns.has(n));
  check(`${label} does not redeclare a core function`, dupes.length === 0,
    `${dupes.join(', ')} — a platform copy shadowing core is how the fork starts again`);
}

// ── the platform files must still differ only where they mean to ───────────
const webOnly = fnNames(web), mobOnly = fnNames(mob);
check('core carries the bulk of the shared code', coreFns.size > webOnly.length && coreFns.size > mobOnly.length,
  `core ${coreFns.size}, web ${webOnly.length}, mobile ${mobOnly.length}`);

// ── load order ─────────────────────────────────────────────────────────────
for (const [label, file] of [['portal', WEB_HTML], ['mobile', MOB_HTML]]) {
  const html = read(file);
  const iCore = html.indexOf('portal-core.js');
  const iPlat = html.search(/<script src="js\/portal\.js/);
  check(`${label} loads portal-core.js`, iCore !== -1, 'script tag missing');
  check(`${label} loads it before portal.js`, iCore !== -1 && iPlat !== -1 && iCore < iPlat,
    `core at ${iCore}, portal at ${iPlat} — core must be first or its functions are not yet defined`);
}

// ── the app actually ships it ──────────────────────────────────────────────
check('mobile build includes portal-core.js', fs.existsSync(MOB_BUILT), 'run mobile/scripts/build.js');
check('mobile build matches the shared source',
  fs.existsSync(MOB_BUILT) && read(MOB_BUILT) === core, 'stale build');
check('service worker precaches portal-core.js', /portal-core\.js/.test(read(SW)),
  'offline PWA would load portal.js without its core');

console.log(`\n  core ${coreFns.size} fns / ${core.split('\n').length} lines · web ${webOnly.length} fns · mobile ${mobOnly.length} fns`);
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
