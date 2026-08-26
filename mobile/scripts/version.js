/* Read and validate mobile/version.json.
 *
 * Shared by apply-android-config, apply-ios-config and both checks, so the two
 * platforms cannot disagree about the version the way they did when Android
 * read android-config/version.json and iOS had its own numbers hand-written
 * into Info.plist — Android reached 5.2 while iOS still said 4.1.0.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const VERSION_FILE = path.join(__dirname, '..', 'version.json');

/* Throws with a message naming the field, so a bad edit fails at the top of a
   build rather than producing a store upload with the wrong number on it. */
function readVersion() {
  if (!fs.existsSync(VERSION_FILE))
    throw new Error('mobile/version.json is missing — it is the source of truth for both stores.');

  let v;
  try { v = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')); }
  catch (e) { throw new Error(`mobile/version.json is not valid JSON: ${e.message}`); }

  if (typeof v.versionName !== 'string' || !/^\d+(\.\d+){1,2}$/.test(v.versionName.trim()))
    throw new Error(`versionName must look like 5.2 or 5.2.1 — got ${JSON.stringify(v.versionName)}`);

  for (const key of ['androidVersionCode', 'iosBuildNumber']) {
    if (!Number.isInteger(v[key]) || v[key] < 1)
      throw new Error(`${key} must be a positive integer — got ${JSON.stringify(v[key])}`);
  }

  return {
    versionName: v.versionName.trim(),
    androidVersionCode: v.androidVersionCode,
    iosBuildNumber: v.iosBuildNumber,
  };
}

module.exports = { readVersion, VERSION_FILE };
