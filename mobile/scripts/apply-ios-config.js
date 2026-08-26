#!/usr/bin/env node
/* Write mobile/version.json into ios-config/Info.plist, and into the generated
 * Xcode project if one exists.
 *
 * iOS and Android drifted apart because their versions lived in unrelated
 * files: Android reached 5.2 while Info.plist still said 4.1.0, so one release
 * described itself two different ways. Both now read mobile/version.json.
 *
 * What this CANNOT do: mobile/ios/ is gitignored and, at archive time, the
 * Xcode project — not Info.plist — is the source of truth. Where the project
 * sets MARKETING_VERSION / CURRENT_PROJECT_VERSION in build settings rather
 * than in the plist, those have to be changed in Xcode. This says so rather
 * than reporting success it cannot vouch for.
 *
 * Run: npm run apply:ios
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { readVersion } = require('./version');

const MOBILE   = path.join(__dirname, '..');
const TEMPLATE = path.join(MOBILE, 'ios-config', 'App', 'App', 'Info.plist');
const PROJECT  = path.join(MOBILE, 'ios', 'App', 'App', 'Info.plist');

const changes = [];
const notes   = [];

function die(msg) { console.error(`[apply:ios] ${msg}`); process.exit(1); }

let v;
try { v = readVersion(); } catch (e) { die(e.message); }

/* Replace the <string> that follows a given <key> in a plist. Deliberately
   narrow: it matches one key/value pair and leaves the surrounding comments —
   which carry the closed-train reasoning — untouched. */
function setPlistString(text, key, value) {
  const re = new RegExp(`(<key>${key}</key>\\s*\\n\\s*<string>)([^<]*)(</string>)`);
  const m = text.match(re);
  if (!m) return { text, before: null, found: false };
  if (m[2] === String(value)) return { text, before: m[2], found: true, changed: false };
  return { text: text.replace(re, `$1${value}$3`), before: m[2], found: true, changed: true };
}

function applyTo(file, label) {
  if (!fs.existsSync(file)) return false;
  let text = fs.readFileSync(file, 'utf8');
  const original = text;

  for (const [key, value] of [
    ['CFBundleShortVersionString', v.versionName],
    ['CFBundleVersion', v.iosBuildNumber],
  ]) {
    const r = setPlistString(text, key, value);
    if (!r.found) { notes.push(`${label}: no ${key} in the plist — set it in Xcode`); continue; }
    text = r.text;
    if (r.changed) changes.push(`${label}: ${key} ${JSON.stringify(r.before)} → ${JSON.stringify(String(value))}`);
  }

  if (text !== original) fs.writeFileSync(file, text);
  return true;
}

if (!applyTo(TEMPLATE, 'ios-config')) die('missing mobile/ios-config/App/App/Info.plist.');

const hasProject = applyTo(PROJECT, 'ios');
if (!hasProject) {
  notes.push('mobile/ios/ not generated — run `npm run add:ios` on macOS, then copy ios-config/ in');
}

console.log('[apply:ios] mobile/version.json → Info.plist');
console.log(`            version ${v.versionName} · build ${v.iosBuildNumber}`);
if (!changes.length) console.log('            already up to date');
for (const c of changes) console.log(`            ${c}`);
for (const n of notes)   console.log(`            note: ${n}`);

console.log(`
[apply:ios] Xcode holds the values that actually ship. If the project sets
            MARKETING_VERSION / CURRENT_PROJECT_VERSION in build settings,
            change them there too — General → Identity, or the build settings
            editor. \`npm run check:ios\` compares the two and will say so.

[apply:ios] ${v.versionName} is a NEW marketing version. Anything already
            uploaded under the previous one stays there: a train cannot be
            reopened once its build is approved for sale (error 90186).`);
