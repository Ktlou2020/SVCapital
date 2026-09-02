#!/usr/bin/env node
/* mobile/www must be what the build produces.
 *
 * mobile/www is a build artifact. Its own build script says so: "Edit
 * mobile/src/, never mobile/www/", and it begins by deleting the directory
 * outright. But nothing enforced that, and two files had drifted:
 *
 *   portal-premium.css carried 93 lines of measured mobile layout fixes that
 *   existed in no source. The next build would have deleted them.
 *
 *   portal.css carried the toast fix — the one that stopped clients tapping
 *   Submit twice because nothing on screen told them the first tap worked.
 *   That would have gone the same way, and the symptom would have come back
 *   with no commit to blame, because deleting it requires no edit: just
 *   running the build.
 *
 * A build artifact that cannot be rebuilt is worse than no artifact. The edit
 * survives only until someone runs the build, and then it disappears silently
 * — no diff, no error, and the change is months old by the time anyone
 * notices.
 *
 * So: build into a temp directory and compare, file for file, against what is
 * committed. This never writes to mobile/www.
 *
 * If it fails, the fix is to move the difference INTO mobile/src (which wins
 * over the shared layers) and rebuild — not to re-edit mobile/www.
 *
 * Run: node scripts/check-mobile-build-reproducible.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT  = path.join(__dirname, '..');
const WWW   = path.join(ROOT, 'mobile', 'www');
const BUILD = path.join(ROOT, 'mobile', 'scripts', 'build.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function listFiles(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

console.log('\nthe build reproduces the committed artifact');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobilebuild-'));
const out = path.join(tmp, 'www');

let built = true;
try {
  execFileSync(process.execPath, [BUILD], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    env: { ...process.env, SVC_BUILD_OUT: out },
  });
} catch (err) {
  built = false;
  ok('the build runs', false, (err.stderr || err.stdout || err.message || '').toString().slice(0, 400));
}

if (built) {
  ok('the build runs', true);

  const wantFiles = listFiles(WWW).sort();
  const gotFiles  = listFiles(out).sort();

  /* Files the artifact has that a build does not produce are the dangerous
     ones: they are edits to mobile/www that the next build deletes. */
  const orphaned = wantFiles.filter(f => !gotFiles.includes(f));
  const extra    = gotFiles.filter(f => !wantFiles.includes(f));

  ok('every file in mobile/www is produced by the build',
     orphaned.length === 0,
     `only in mobile/www, so the next build deletes them: ${orphaned.slice(0, 12).join(', ')}`);
  ok('and the build produces nothing that is missing from mobile/www',
     extra.length === 0,
     `built but not committed: ${extra.slice(0, 12).join(', ')}`);

  const differing = [];
  for (const f of wantFiles) {
    if (!gotFiles.includes(f)) continue;
    const a = fs.readFileSync(path.join(WWW, f));
    const b = fs.readFileSync(path.join(out, f));
    if (!a.equals(b)) differing.push(f);
  }
  ok('and every file matches byte for byte',
     differing.length === 0,
     differing.length
       ? `edited in mobile/www instead of mobile/src — move the change into ` +
         `mobile/src and rebuild:\n      ${differing.slice(0, 12).join('\n      ')}`
       : '');

  /* Naming the files the app cannot run without, rather than counting them:
     an empty build compares equal to an empty artifact and would otherwise
     pass every assertion above. */
  const MUST_SHIP = ['index.html', 'sw.js', 'js/portal.js', 'js/portal-core.js',
                     'css/portal.css', 'css/portal-premium.css', 'css/mobile-app.css'];
  const missing = MUST_SHIP.filter(f => !wantFiles.includes(f));
  ok('the app’s own files are actually in there',
     missing.length === 0,
     `missing: ${missing.join(', ')} — an empty build equals an empty artifact`);
}

console.log('\nand the output override cannot delete something by accident');
{
  /* The build begins by removing its output directory. */
  const guard = path.join(tmp, 'notempty');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'keep.txt'), 'do not delete me');
  let refused = false;
  try {
    execFileSync(process.execPath, [BUILD], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
      env: { ...process.env, SVC_BUILD_OUT: guard },
    });
  } catch (_) { refused = true; }
  ok('a non-empty SVC_BUILD_OUT is refused', refused);
  ok('and its contents are still there',
     fs.existsSync(path.join(guard, 'keep.txt')),
     'the build rm -rf’s its output directory before writing');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
