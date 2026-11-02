/* Where the headless Chromium actually is.
 *
 * Thirty-two checks drive a real browser, and twenty-seven of them named it:
 *
 *   ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
 *    '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(fs.existsSync)
 *
 * Playwright then shipped 1243, which installs to chrome-linux64 rather than
 * chrome-linux, and every one of those twenty-seven stopped finding it. None
 * of them failed: each prints "SKIP no headless Chromium" and exits 0, so the
 * suite went on reporting a full green while nineteen browser halves had not
 * run for weeks — every XSS-escaping assertion, every render, every measured
 * layout among them.
 *
 * One file knew. check-audience-chooser already carried a comment saying the
 * bundled build is versioned "chromium-1194 one week, chromium-1243 the next,
 * and a hardcoded path skips quietly for ever", and resolved it properly. The
 * lesson was learned in one place and copied nowhere, which is the argument
 * for this module existing rather than a twenty-eighth correct copy of it.
 *
 * So: find it by shape, not by name — newest version first, both layouts —
 * and let the caller say what it could not do without one.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const BASE = process.env.PW_BROWSERS_PATH || '/opt/pw-browsers';

/* Both layouts Playwright has used, and the unversioned symlink some images
   leave behind. */
const INNER = ['chrome-linux64', 'chrome-linux'];

function findChromium() {
  /* An explicit path wins, so a machine with Chrome somewhere else can say so
     rather than lose the measured half of the suite. */
  const named = process.env.CHROME_PATH;
  if (named && fs.existsSync(named)) return named;

  if (!fs.existsSync(BASE)) return null;

  /* Some images leave an unversioned "chromium" beside the versioned
     directories. It is a SYMLINK TO THE BINARY in this one and a directory
     in others, and five checks returned it without looking which — handing
     a directory to --headless on any image where it is one. statSync
     follows the link, so this tells the two apart. */
  const plain = path.join(BASE, 'chromium');
  try { if (fs.statSync(plain).isFile()) return plain; } catch (_) { /* not there */ }

  /* Newest first: a container that has upgraded in place holds both. */
  const versioned = fs.readdirSync(BASE)
    .filter(d => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));

  for (const dir of [...versioned, 'chromium']) {
    for (const inner of INNER) {
      const bin = path.join(BASE, dir, inner, 'chrome');
      if (fs.existsSync(bin)) return bin;
    }
    /* chromium_headless_shell ships the same engine under another name. */
    const shell = path.join(BASE, dir, 'chrome-linux64', 'headless_shell');
    if (fs.existsSync(shell)) return shell;
  }
  return null;
}

module.exports = { findChromium, PW_BROWSERS: BASE };
