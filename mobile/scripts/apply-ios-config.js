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


/* ── Deployment target ──────────────────────────────────────────────────
 *
 * Capacitor's stock project pins IPHONEOS_DEPLOYMENT_TARGET to the framework
 * floor (13.0 on Capacitor 6), and App Store Connect warns on anything below
 * 15.0 — a warning now, a rejection from Spring 2027. mobile/ios/ is
 * regenerated and gitignored, so the number has to be re-applied every time
 * rather than set once in Xcode and forgotten.
 *
 * Three places, and all three matter:
 *   project.pbxproj  every build configuration, debug and release
 *   Podfile          the platform line
 *   Podfile          a post_install hook, because each pod carries its own
 *                    target and one built for 13.0 drags the archive's
 *                    effective minimum back down with it
 * ─────────────────────────────────────────────────────────────────────── */
const SETTINGS_FILE = path.join(MOBILE, 'ios-config', 'build-settings.json');
const PBXPROJ = path.join(MOBILE, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const PODFILE = path.join(MOBILE, 'ios', 'App', 'Podfile');

function readDeploymentTarget() {
  if (!fs.existsSync(SETTINGS_FILE)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch (_) { die('ios-config/build-settings.json is not valid JSON.'); }
  const t = raw && raw.iosDeploymentTarget;
  if (!t || !/^\d+(\.\d+)?$/.test(String(t))) {
    die('ios-config/build-settings.json: iosDeploymentTarget must be a version like "15.0".');
  }
  if (parseFloat(t) < 15) {
    notes.push(`iosDeploymentTarget is ${t}; App Store Connect requires 15.0 from Spring 2027`);
  }
  return String(t);
}

function applyDeploymentTarget(target) {
  if (!target) { notes.push('no ios-config/build-settings.json — deployment target left as generated'); return; }

  if (fs.existsSync(PBXPROJ)) {
    const before = fs.readFileSync(PBXPROJ, 'utf8');
    /* Every configuration, not just the first: a project carries Debug and
       Release, and an archive is built from Release. */
    const after = before.replace(/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/g,
                                 `IPHONEOS_DEPLOYMENT_TARGET = ${target};`);
    if (after !== before) { fs.writeFileSync(PBXPROJ, after); changes.push(`project.pbxproj → iOS ${target}`); }
    if (!/IPHONEOS_DEPLOYMENT_TARGET/.test(after)) {
      notes.push('project.pbxproj declares no IPHONEOS_DEPLOYMENT_TARGET — set it in Xcode once');
    }
  } else {
    notes.push('mobile/ios/App/App.xcodeproj not generated — deployment target not applied');
  }

  if (fs.existsSync(PODFILE)) {
    let pod = fs.readFileSync(PODFILE, 'utf8');
    const orig = pod;
    if (/^platform :ios/m.test(pod)) {
      pod = pod.replace(/^platform :ios, ?'[0-9.]+'/m, `platform :ios, '${target}'`);
    } else {
      pod = `platform :ios, '${target}'\n` + pod;
    }
    /* Pods override the app's target unless they are told not to. Without this
       the archive reports the LOWEST target among its pods, which is the
       number App Store Connect reads. */
    const HOOK_MARK = '# svc: pin pod deployment targets';
    if (!pod.includes(HOOK_MARK)) {
      pod += `\n${HOOK_MARK}\npost_install do |installer|\n` +
             `  installer.pods_project.targets.each do |t|\n` +
             `    t.build_configurations.each do |c|\n` +
             `      c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${target}'\n` +
             `    end\n  end\nend\n`;
    } else {
      pod = pod.replace(/(IPHONEOS_DEPLOYMENT_TARGET'\] = ')[0-9.]+(')/, `$1${target}$2`);
    }
    if (pod !== orig) {
      fs.writeFileSync(PODFILE, pod);
      changes.push(`Podfile → iOS ${target} (run \`pod install\` in mobile/ios/App)`);
    }
  } else {
    notes.push('mobile/ios/App/Podfile not generated — platform line not applied');
  }
}

const deploymentTarget = readDeploymentTarget();
applyDeploymentTarget(deploymentTarget);

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
