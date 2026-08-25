#!/usr/bin/env node
/* apply-android-config must produce a correct build.gradle from any starting
 * point, and check-android-config must reject the ones that are wrong.
 *
 * The bug being guarded: signingConfigs nested inside defaultConfig. It works
 * — Groovy closures resolve owner-first — so nothing errors, nothing warns,
 * and the only symptom is that someone later moves code and loses signing.
 * The previous check looked for a closing brace between aaptOptions and
 * signingConfigs, which passes the exact case it was meant to catch: aaptOptions
 * does close; the block still open is defaultConfig.
 *
 * Builds throwaway android/ projects in a temp dir, so this needs no Android
 * SDK, no keystore and no `cap add android`.
 *
 * Run: node scripts/check-apply-android.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MOBILE = path.join(__dirname, '..');
const blocks = require('./gradle-blocks');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  <- ${detail}` : ''}`); }
};

/* The stock Capacitor 6 app/build.gradle, trimmed to what matters. Note
   aaptOptions sitting inside defaultConfig — that placement is what makes the
   "add it after aaptOptions" instruction land one level too deep. */
const STOCK = `apply plugin: 'com.android.application'

android {
    namespace "co.za.svcapital.app"
    compileSdk rootProject.ext.compileSdkVersion
    defaultConfig {
        applicationId "co.za.svcapital.app"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
        aaptOptions {
            ignoreAssetsPattern '!.svn:!.git'
        }
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}

dependencies {
    implementation project(':capacitor-android')
}
`;

/* Same file, but with signingConfigs nested inside defaultConfig — the real
   world state this exists to catch and repair.

   Everything else here is CORRECT: the loader is present and the release
   buildType does reference signingConfigs.release. Misplacement is the only
   defect, so a check that passes this file is blind to it specifically, rather
   than being rescued by some other problem it happens to notice. */
const MISPLACED = STOCK
  .replace(`apply plugin: 'com.android.application'
`, `apply plugin: 'com.android.application'

def keystorePropertiesFile = rootProject.file("key.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}
`)
  .replace(`            ignoreAssetsPattern '!.svn:!.git'
        }
`, `            ignoreAssetsPattern '!.svn:!.git'
        }
        signingConfigs {
            release {
                keyAlias keystoreProperties['keyAlias']
            }
        }
`)
  .replace(`        release {
            minifyEnabled false`, `        release {
            signingConfig signingConfigs.release
            minifyEnabled false`);

/* Seed the fixture from android-config so it is conformant in every respect
   except the one under test. An empty variables.gradle would make
   check:android exit non-zero on SDK mismatches, and every "it rejects this"
   assertion would pass for the wrong reason. */
function copyInto(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src)) copyInto(path.join(src, e), path.join(dest, e));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function makeProject(gradleText) {
  const CONFIG = path.join(MOBILE, 'android-config');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-android-'));
  fs.mkdirSync(path.join(root, 'app', 'src', 'main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'build.gradle'), gradleText);
  copyInto(path.join(CONFIG, 'variables.gradle'), path.join(root, 'variables.gradle'));
  copyInto(path.join(CONFIG, 'app/src/main/res'), path.join(root, 'app/src/main/res'));
  copyInto(path.join(CONFIG, 'app/src/main/AndroidManifest.xml'), path.join(root, 'app/src/main/AndroidManifest.xml'));
  return root;
}

/* apply-android-config resolves android/ relative to itself, so the project is
   swapped in at mobile/android for the duration of the run and restored after.
   A real android/ present in this checkout is moved aside, never deleted. */
function withProject(gradleText, fn) {
  const real   = path.join(MOBILE, 'android');
  const stash  = path.join(MOBILE, `.android-checkstash-${process.pid}`);
  const staged = makeProject(gradleText);
  const hadReal = fs.existsSync(real);
  if (hadReal) fs.renameSync(real, stash);
  fs.renameSync(staged, real);
  try { return fn(real); }
  finally {
    fs.rmSync(real, { recursive: true, force: true });
    if (hadReal) fs.renameSync(stash, real);
  }
}

const run = (script) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [path.join(__dirname, script)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
};

/* Structural assertions on a produced build.gradle. */
function inspect(text) {
  const a = blocks.findAndroidBlock(text);
  if (!a) return { error: 'no android { } block' };
  const direct = blocks.findChildBlock(text, 'signingConfigs', a.open, a.end);
  const any    = blocks.findAnyBlock(text, 'signingConfigs', a.open, a.end);
  const bt     = blocks.findChildBlock(text, 'buildTypes', a.open, a.end);
  const rel    = bt && blocks.findChildBlock(text, 'release', bt.open, bt.end);
  return {
    directDepth: any ? any.depth : null,
    isDirect: !!direct,
    signsRelease: !!rel && /signingConfig\s+signingConfigs\.release/.test(text.slice(rel.open, rel.end)),
    versionCode: (text.match(/versionCode\s+(\d+)/) || [])[1],
    versionName: (text.match(/versionName\s+"([^"]*)"/) || [])[1],
    guardedLoader: /if \(keystorePropertiesFile\.exists\(\)\)/.test(text),
    count: (text.match(/signingConfigs\s*\{/g) || []).length,
  };
}

const wantVersion = JSON.parse(fs.readFileSync(path.join(MOBILE, 'android-config', 'version.json'), 'utf8'));

console.log('\nfrom a stock Capacitor build.gradle');
const fromStock = withProject(STOCK, (root) => {
  const r = run('apply-android-config.js');
  ok('apply:android succeeds', r.code === 0, r.out.trim().split('\n').slice(-2).join(' '));
  const text = fs.readFileSync(path.join(root, 'app', 'build.gradle'), 'utf8');
  const i = inspect(text);
  ok('signingConfigs is a direct child of android { }', i.isDirect, `depth ${i.directDepth}`);
  ok('release buildType sets signingConfig signingConfigs.release', i.signsRelease);
  ok(`versionCode is ${wantVersion.versionCode}`, i.versionCode === String(wantVersion.versionCode), `got ${i.versionCode}`);
  ok(`versionName is ${JSON.stringify(wantVersion.versionName)}`, i.versionName === wantVersion.versionName, `got ${JSON.stringify(i.versionName)}`);
  ok('the keystore loader is guarded against a missing key.properties', i.guardedLoader);
  ok('check:android accepts the result', run('check-android-config.js').code === 0);
  return text;
});

console.log('\nsigningConfigs nested inside defaultConfig — the bug');
withProject(MISPLACED, (root) => {
  const pre = inspect(fs.readFileSync(path.join(root, 'app', 'build.gradle'), 'utf8'));
  ok('the fixture really is misplaced (depth 2, not 1)', pre.directDepth === 2 && !pre.isDirect, `depth ${pre.directDepth}`);

  const before = run('check-android-config.js');
  ok('check:android REJECTS it', before.code !== 0, 'it passed — the misplacement is invisible');
  ok('and says where it actually is', /inside defaultConfig/.test(before.out), before.out.trim().slice(-160));

  const r = run('apply-android-config.js');
  ok('apply:android repairs it', r.code === 0);
  ok('and reports the move', /removed signingConfigs from 2 levels too deep/.test(r.out), r.out.trim());

  const text = fs.readFileSync(path.join(root, 'app', 'build.gradle'), 'utf8');
  const i = inspect(text);
  ok('signingConfigs is now a direct child', i.isDirect, `depth ${i.directDepth}`);
  ok('the stray copy is gone — exactly one block remains', i.count === 1, `found ${i.count}`);
  ok('check:android now accepts it', run('check-android-config.js').code === 0);
  ok('result matches what a stock project produces', text === fromStock,
     'repairing and building fresh should converge on the same file');
});

console.log('\nre-running must change nothing');
withProject(STOCK, (root) => {
  run('apply-android-config.js');
  const once = fs.readFileSync(path.join(root, 'app', 'build.gradle'), 'utf8');
  const second = run('apply-android-config.js');
  const twice = fs.readFileSync(path.join(root, 'app', 'build.gradle'), 'utf8');
  ok('idempotent — the file is byte-identical', once === twice);
  ok('and it says so', /already up to date/.test(second.out), second.out.trim());
});

console.log('\nmissing signingConfig line alone is still caught');
withProject(STOCK.replace('    buildTypes {', `    signingConfigs {
        release {
            keyAlias "x"
        }
    }

    buildTypes {`), () => {
  const r = run('check-android-config.js');
  ok('check:android rejects an unsigned release buildType', r.code !== 0);
  ok('and names the consequence', /unsigned and Play will reject it/.test(r.out), r.out.trim().slice(-120));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
