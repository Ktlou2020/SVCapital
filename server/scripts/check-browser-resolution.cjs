#!/usr/bin/env node
/* Every check that drives a browser finds it the same way.
 *
 * Twenty-seven of them named the binary instead:
 *
 *   ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', …]
 *
 * Playwright shipped 1243, which installs to chrome-linux64 rather than
 * chrome-linux, and all twenty-seven stopped finding it on the same day.
 * Not one failed. Each prints "SKIP no headless Chromium" and exits 0, so
 * the suite reported a full green while nineteen browser halves had not run
 * for weeks — every XSS-escaping assertion, every render, every measured
 * layout among them. It was found by making the runner read each check's own
 * tally rather than its exit code.
 *
 * One file had already worked it out and left a comment saying the bundled
 * build is versioned and "a hardcoded path skips quietly for ever". The
 * lesson was learned in one place and copied nowhere. So this check exists
 * to make the copying unnecessary: one resolver, and nobody writing a
 * twenty-eighth path by hand.
 *
 * Run: node server/scripts/check-browser-resolution.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const DIRS = [path.join(ROOT, 'server', 'scripts'), path.join(ROOT, 'scripts')];
const checks = [];
for (const dir of DIRS) {
  for (const f of fs.readdirSync(dir).filter(f => /^check-.*\.cjs$/.test(f))) {
    /* Not itself: the paths above are quoted in its own header as the thing
       that went wrong, and a check cannot be the counter-example it names. */
    if (path.join(dir, f) === __filename) continue;
    checks.push({ rel: path.relative(ROOT, path.join(dir, f)),
                  src: fs.readFileSync(path.join(dir, f), 'utf8') });
  }
}

console.log('one resolver, and no check naming a binary itself');
{
  ok('there are checks to look at', checks.length > 100, `${checks.length} found`);

  /* A path with a version in it, or an inner directory named, is a path that
     stops working when the image moves. */
  const named = checks.filter(c =>
    /\/opt\/pw-browsers\/[^'"\s]*(chrome-linux|chromium-\d)/.test(c.src));
  ok('no check names a chromium binary by path',
     named.length === 0,
     named.map(c => c.rel).join('\n      ')
     + '\n      use require(.../scripts/lib/chromium.cjs).findChromium()');

  const browserChecks = checks.filter(c => /SKIP\s+no (headless Chromium|chromium)/i.test(c.src));
  ok('every check that can skip for want of a browser uses the resolver',
     browserChecks.every(c => /findChromium\(\)/.test(c.src)),
     browserChecks.filter(c => !/findChromium\(\)/.test(c.src)).map(c => c.rel).join(', '));
  console.log(`  ${browserChecks.length} checks drive a browser`);
}

console.log('\nand the resolver finds what is actually installed here');
{
  const { findChromium, PW_BROWSERS } = require(path.join(ROOT, 'scripts', 'lib', 'chromium.cjs'));
  const found = findChromium();

  if (!fs.existsSync(PW_BROWSERS)) {
    /* Said plainly rather than skipped: this check is about resolution, and
       on a machine with no browsers installed there is nothing to resolve.
       The runner holds the count, so this cannot quietly become the normal
       outcome. */
    ok('a machine with no browsers resolves to nothing, not to a guess',
       found === null, String(found));
  } else {
    ok('it found one', !!found, `nothing under ${PW_BROWSERS}`);
    ok('and it is a file, not a directory',
       !!found && fs.statSync(found).isFile(),
       'the unversioned "chromium" entry is a symlink to the binary in some '
       + 'images and a directory in others; handing a directory to --headless '
       + 'fails in a way that reads like a crash');
    ok('and it is executable',
       !!found && !!(fs.statSync(found).mode & 0o111), String(found));
    console.log(`  ${found}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
