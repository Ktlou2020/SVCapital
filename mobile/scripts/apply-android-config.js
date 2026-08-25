#!/usr/bin/env node
/* Apply android-config/ to the generated android/ project.
 *
 * android/ is gitignored — Capacitor regenerates it from a stock template, so
 * every store build starts from a project that knows nothing about this app's
 * SDK levels, manifest, icons, signing, or version. Those all live in
 * android-config/ and have until now been copied in by hand.
 *
 * Two of those steps are easy to get wrong and neither fails loudly:
 *
 *   1. signingConfigs must be a DIRECT child of `android { }`. In the stock
 *      build.gradle, aaptOptions sits inside defaultConfig, so adding the block
 *      "after aaptOptions" lands it one level too deep. Groovy resolves
 *      owner-first, so it still works and reports nothing — until someone moves
 *      code around and it silently stops applying.
 *
 *   2. Forgetting `signingConfig signingConfigs.release` inside buildTypes.release
 *      produces an unsigned AAB. Debug builds are unaffected and nothing
 *      complains until Play rejects the upload.
 *
 * This does all of it deterministically and is safe to re-run: it locates the
 * `android { }` block by brace depth rather than by matching indentation, and
 * skips work that is already correct.
 *
 * Run: npm run apply:android
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const blocks = require('./gradle-blocks');

const MOBILE  = path.join(__dirname, '..');
const CONFIG  = path.join(MOBILE, 'android-config');
const ANDROID = path.join(MOBILE, 'android');
const GRADLE  = path.join(ANDROID, 'app', 'build.gradle');

const changes = [];
const notes   = [];

function die(msg, hint) {
  console.error(`[apply:android] ${msg}`);
  if (hint) console.error(`[apply:android] ${hint}`);
  process.exit(1);
}

if (!fs.existsSync(ANDROID))
  die('mobile/android/ not generated yet — nothing to apply.', 'run `npm run add:android` first, then re-run this.');
if (!fs.existsSync(GRADLE))
  die(`missing ${path.relative(MOBILE, GRADLE)} — the android project looks incomplete.`);

/* ── 1. Copy the static config in ──────────────────────────────────────── */

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dest, entry));
    return;
  }
  const next = fs.readFileSync(src);
  if (fs.existsSync(dest) && fs.readFileSync(dest).equals(next)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, next);
  changes.push(`updated ${path.relative(MOBILE, dest)}`);
}

// res/ carries strings.xml, whose package_name has drifted from the appId
// before — copying the whole tree is what keeps it in step.
copyRecursive(path.join(CONFIG, 'app/src/main/res'), path.join(ANDROID, 'app/src/main/res'));
copyRecursive(path.join(CONFIG, 'app/src/main/AndroidManifest.xml'), path.join(ANDROID, 'app/src/main/AndroidManifest.xml'));
copyRecursive(path.join(CONFIG, 'variables.gradle'), path.join(ANDROID, 'variables.gradle'));

/* ── 2. Edit build.gradle ──────────────────────────────────────────────── */

let gradle = fs.readFileSync(GRADLE, 'utf8');
const before = gradle;

const androidOpen = gradle.indexOf('{', gradle.search(/(^|\n)android\s*\{/));
if (androidOpen < 0) die('could not find the `android { }` block in build.gradle.');
let androidEnd = -1;
{
  let depth = 0;
  for (let i = androidOpen; i < gradle.length; i++) {
    if (gradle[i] === '{') depth++;
    else if (gradle[i] === '}' && --depth === 0) { androidEnd = i; break; }
  }
}
if (androidEnd < 0) die('the `android { }` block is unbalanced — refusing to edit it.');

/* 2a. keystore loader, above `android {`.
   Guarded: a missing key.properties must not break debug builds or a fresh
   clone. The stock patch used a bare FileInputStream, which throws. */
const LOADER = `def keystorePropertiesFile = rootProject.file("key.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

`;
if (!gradle.includes('keystorePropertiesFile')) {
  const anchor = gradle.search(/(^|\n)android\s*\{/);
  const at = gradle[anchor] === '\n' ? anchor + 1 : anchor;
  gradle = gradle.slice(0, at) + LOADER + gradle.slice(at);
  changes.push('added the keystore properties loader');
  notes.push('the loader is guarded — a missing key.properties no longer breaks debug builds');
}

/* 2b. signingConfigs, as a DIRECT child of android { }.
   If one already exists but at the wrong depth, it is removed and rewritten in
   the right place — leaving the stray copy behind would keep the misleading
   structure that caused the problem. */
{
  const android = blocks.findAndroidBlock(gradle);
  const direct  = blocks.findChildBlock(gradle, 'signingConfigs', android.open, android.end);
  const any     = blocks.findAnyBlock(gradle, 'signingConfigs', android.open, android.end);

  if (any && !direct) {
    // Cut the misplaced block, including the whole lines it sits on.
    const from = gradle.lastIndexOf('\n', any.start) + 1;
    let to = any.end;
    while (to < gradle.length && gradle[to] !== '\n') to++;
    gradle = gradle.slice(0, from) + gradle.slice(to + 1);
    changes.push(`removed signingConfigs from ${any.depth} level${any.depth === 1 ? '' : 's'} too deep`);
  }

  if (!direct || (any && !direct)) {
    const a2 = blocks.findAndroidBlock(gradle);
    const bt = blocks.findChildBlock(gradle, 'buildTypes', a2.open, a2.end);
    if (!bt) die('could not find a top-level buildTypes block inside `android { }`.');
    const BLOCK = `    signingConfigs {
        release {
            if (keystorePropertiesFile.exists()) {
                keyAlias      keystoreProperties['keyAlias']
                keyPassword   keystoreProperties['keyPassword']
                storeFile     file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
            }
        }
    }

`;
    const lineStart = gradle.lastIndexOf('\n', bt.start) + 1;
    gradle = gradle.slice(0, lineStart) + BLOCK + gradle.slice(lineStart);
    changes.push('added signingConfigs as a direct child of `android { }`');
  }
}

/* 2c. signingConfig inside buildTypes.release. */
{
  const android = blocks.findAndroidBlock(gradle);
  const bt  = blocks.findChildBlock(gradle, 'buildTypes', android.open, android.end);
  const rel = bt && blocks.findChildBlock(gradle, 'release', bt.open, bt.end);
  if (!rel) die('could not find buildTypes.release in build.gradle.');
  if (!/signingConfig\s+signingConfigs\.release/.test(gradle.slice(rel.open, rel.end))) {
    const at = rel.open + 1;
    gradle = gradle.slice(0, at) + '\n            signingConfig signingConfigs.release' + gradle.slice(at);
    changes.push('set signingConfig signingConfigs.release on the release buildType');
  }
}

/* 2d. version, from android-config/version.json. */
{
  const vPath = path.join(CONFIG, 'version.json');
  if (!fs.existsSync(vPath)) die('missing android-config/version.json.');
  const v = JSON.parse(fs.readFileSync(vPath, 'utf8'));
  if (!Number.isInteger(v.versionCode) || v.versionCode < 1)
    die(`version.json has an invalid versionCode: ${JSON.stringify(v.versionCode)}`);
  if (typeof v.versionName !== 'string' || !v.versionName.trim())
    die(`version.json has an invalid versionName: ${JSON.stringify(v.versionName)}`);

  const curCode = (gradle.match(/versionCode\s+(\d+)/) || [])[1];
  const curName = (gradle.match(/versionName\s+"([^"]*)"/) || [])[1];
  if (curCode !== String(v.versionCode)) {
    gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${v.versionCode}`);
    changes.push(`versionCode ${curCode} → ${v.versionCode}`);
  }
  if (curName !== v.versionName) {
    gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${v.versionName}"`);
    changes.push(`versionName ${JSON.stringify(curName)} → ${JSON.stringify(v.versionName)}`);
  }
}

if (gradle !== before) fs.writeFileSync(GRADLE, gradle);

/* ── 3. Report ─────────────────────────────────────────────────────────── */

console.log('[apply:android] android-config/ → android/');
if (!changes.length) console.log('                already up to date');
for (const c of changes) console.log(`                ${c}`);
for (const n of notes)   console.log(`                note: ${n}`);

if (!fs.existsSync(path.join(ANDROID, 'key.properties')))
  console.log('\n[apply:android] key.properties not present — a release build will be UNSIGNED.\n' +
              '                see README "Signing" before building for the store.');
if (!fs.existsSync(path.join(ANDROID, 'app', 'google-services.json')))
  console.log('[apply:android] google-services.json not present — push notifications will not work.');

console.log('\n[apply:android] verify with: npm run check:android');
