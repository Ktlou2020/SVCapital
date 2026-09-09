#!/usr/bin/env node
/* One version, both stores.
 *
 * iOS and Android drifted because their versions lived in unrelated files:
 * Android reached 5.2 while ios-config/Info.plist still said 4.1.0, so one
 * release described itself two different ways and nothing noticed. Both now
 * read mobile/version.json — this checks that they actually agree, and that
 * apply-ios-config writes the plist without disturbing the reasoning around it.
 *
 * Needs no Xcode, no simulator and no generated project.
 *
 * Run: node scripts/check-version.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MOBILE = path.join(__dirname, '..');
const { readVersion, VERSION_FILE } = require('./version');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  <- ${detail}` : ''}`); }
};

const plistPath = path.join(MOBILE, 'ios-config', 'App', 'App', 'Info.plist');
const plist = fs.readFileSync(plistPath, 'utf8');
const plistVal = key => {
  const m = plist.match(new RegExp(`<key>${key}</key>\\s*\\n\\s*<string>([^<]*)</string>`));
  return m ? m[1] : null;
};

const v = readVersion();

console.log('\nmobile/version.json is the single source');
ok('it parses and validates', !!v.versionName && !!v.androidVersionCode && !!v.iosBuildNumber);
ok('it no longer lives under android-config/',
   !fs.existsSync(path.join(MOBILE, 'android-config', 'version.json')),
   'two copies is how the platforms drifted in the first place');

console.log('\niOS matches it');
ok(`CFBundleShortVersionString is ${v.versionName}`,
   plistVal('CFBundleShortVersionString') === v.versionName,
   `plist says ${JSON.stringify(plistVal('CFBundleShortVersionString'))}`);
ok(`CFBundleVersion is ${v.iosBuildNumber}`,
   plistVal('CFBundleVersion') === String(v.iosBuildNumber),
   `plist says ${JSON.stringify(plistVal('CFBundleVersion'))}`);

console.log('\nthe two stores describe the same release');
ok('iOS marketing version equals Android versionName',
   plistVal('CFBundleShortVersionString') === v.versionName,
   'this is exactly the drift that put Android on 5.2 and iOS on 4.1.0');

// Not a rule Apple or Google enforces — a convention this project keeps so one
// number identifies a build in both stores. Worth failing loudly if broken.
ok('iOS build number equals Android versionCode',
   v.iosBuildNumber === v.androidVersionCode,
   `ios ${v.iosBuildNumber} vs android ${v.androidVersionCode}`);

console.log('\nthe plist keeps its reasoning');
ok('the closed-train rule is still documented', /90186/.test(plist));
ok('the strictly-increasing rule is still documented', /90062/.test(plist));
ok('and the build-number history explaining 87 over 1', /79, 83, 84, 85/.test(plist));
ok('the bundle identifier was not touched',
   plistVal('CFBundleIdentifier') === 'co.za.svcapital.app',
   `got ${JSON.stringify(plistVal('CFBundleIdentifier'))} — the .investor record must never be used`);

console.log('\napply:ios is idempotent and surgical');
{
  const before = fs.readFileSync(plistPath, 'utf8');
  const run = () => execFileSync(process.execPath, [path.join(__dirname, 'apply-ios-config.js')],
                                 { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = run();
  const after = fs.readFileSync(plistPath, 'utf8');
  ok('re-running changes nothing', before === after);
  ok('and says so', /already up to date/.test(out), out.trim().split('\n')[2]);
  ok('it warns that Xcode holds the values that ship', /MARKETING_VERSION/.test(out));
  ok('and that a new marketing version abandons the old train', /90186/.test(out));
}

console.log('\na bad version.json is refused, not written');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-ver-'));
  const backup = fs.readFileSync(VERSION_FILE, 'utf8');
  const plistBackup = fs.readFileSync(plistPath, 'utf8');
  const bad = [
    ['versionName as a number',   { versionName: 5.2, androidVersionCode: 87, iosBuildNumber: 87 }],
    ['versionName "five-two"',    { versionName: 'five-two', androidVersionCode: 87, iosBuildNumber: 87 }],
    ['versionCode 0',             { versionName: '5.2', androidVersionCode: 0, iosBuildNumber: 87 }],
    ['build number as a string',  { versionName: '5.2', androidVersionCode: 87, iosBuildNumber: '87' }],
  ];
  try {
    for (const [label, obj] of bad) {
      fs.writeFileSync(VERSION_FILE, JSON.stringify(obj));
      let code = 0;
      try { execFileSync(process.execPath, [path.join(__dirname, 'apply-ios-config.js')], { stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { code = e.status == null ? 1 : e.status; }
      ok(`${label} is rejected`, code !== 0, 'it was accepted — a bad version would reach a store upload');
      ok(`${label} left the plist untouched`, fs.readFileSync(plistPath, 'utf8') === plistBackup);
    }
  } finally {
    fs.writeFileSync(VERSION_FILE, backup);
    fs.writeFileSync(plistPath, plistBackup);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\nthe build numbers only ever go up');
{
  /* Play rejected a production release with:
       "it doesn't allow any existing users to upgrade to the newly added
        app bundles"
     — which is what it says when the bundle's versionCode is not above the one
     those users already have. Only Play knows the highest code ever uploaded,
     so nothing here can confirm a number is free. What it CAN confirm is the
     cheaper half: that the number never goes backwards or sideways in this
     repository, which is how a code gets reused. A reverted file, a bad merge
     resolution or an edit that lands on the previous value all show up here
     instead of after a build, an upload and a rejected release. */
  let history = [];
  try {
    const shas = execFileSync('git', ['log', '--format=%H', '--', VERSION_FILE],
      { cwd: MOBILE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
    for (const sha of shas) {
      try {
        const past = JSON.parse(execFileSync('git', ['show', `${sha}:mobile/version.json`],
          { cwd: MOBILE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
        history.push({ sha: sha.slice(0, 7), ...past });
      } catch { /* the path did not exist at that commit */ }
    }
  } catch { history = []; }

  if (!history.length) {
    console.log('  SKIP  no git history for version.json (shallow clone or not a repo)');
  } else {
    /* history[0] is HEAD's copy. Whether it counts as "earlier" depends on
       whether the working file has been edited since: on an unmodified file it
       IS the value under test and comparing would fail against itself, but on
       an edited one it is the last committed number and the new value has to
       clear it. Getting this wrong is not academic — dropping HEAD
       unconditionally let an edit back to the previously shipped code pass. */
    let dirty = false;
    try {
      execFileSync('git', ['diff', '--quiet', 'HEAD', '--', VERSION_FILE],
        { cwd: MOBILE, stdio: 'ignore' });
    } catch { dirty = true; }
    const older = dirty ? history : history.slice(1);
    const maxCode  = older.reduce((m, h) => Math.max(m, h.androidVersionCode || 0), 0);
    const maxBuild = older.reduce((m, h) => Math.max(m, h.iosBuildNumber   || 0), 0);
    const worstCode  = older.find(h => h.androidVersionCode === maxCode);
    const worstBuild = older.find(h => h.iosBuildNumber === maxBuild);

    ok(`androidVersionCode ${v.androidVersionCode} is above every earlier value`,
       !older.length || v.androidVersionCode > maxCode,
       `${maxCode} was already committed in ${worstCode && worstCode.sha} — Play refuses a code it has seen`);
    ok(`iosBuildNumber ${v.iosBuildNumber} is above every earlier value`,
       !older.length || v.iosBuildNumber > maxBuild,
       `${maxBuild} was already committed in ${worstBuild && worstBuild.sha} — App Store Connect refuses it (error 90062)`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
