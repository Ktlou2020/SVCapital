/* Locating blocks in build.gradle by brace depth.
 *
 * Shared by apply-android-config.js and check-android-config.js so both agree
 * on what "directly inside android { }" means.
 *
 * Why depth and not indentation: in the stock Capacitor build.gradle,
 * aaptOptions sits inside defaultConfig. A signingConfigs block added "after
 * aaptOptions" therefore lands inside defaultConfig — one level too deep. It
 * still works, because Groovy closures resolve owner-first and the call falls
 * through to the android extension, so nothing errors and nothing warns.
 *
 * The obvious heuristic — is there a closing brace between aaptOptions and
 * signingConfigs? — is fooled by exactly this case: aaptOptions *does* close.
 * The block that has not closed is defaultConfig. Only counting braces
 * distinguishes them.
 */
'use strict';

/* Brace depth at `pos`, counting from `from`. Depth 1 means a direct child of
   the block that opened at `from`. */
function depthAt(src, pos, from) {
  let depth = 0;
  for (let i = from; i < pos; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return depth;
}

/* Span of the block opening at `open`, as { open, end } where end is the index
   just past its closing brace. Returns null if braces are unbalanced. */
function spanFrom(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return { open, end: i + 1 };
  }
  return null;
}

/* The top-level `android { }` block. */
function findAndroidBlock(src) {
  const at = src.search(/(^|\n)android\s*\{/);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  const span = spanFrom(src, open);
  return span && { start: src[at] === '\n' ? at + 1 : at, ...span };
}

/* A named block that is a DIRECT child of the block spanning [open, end).
   Blocks nested deeper are skipped, not returned — that is the whole point. */
function findChildBlock(src, name, parentOpen, parentEnd) {
  const re = new RegExp(`(^|[\\s;{])${name}\\s*\\{`, 'g');
  re.lastIndex = parentOpen;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index);
    if (open < 0 || open >= parentEnd) return null;
    if (depthAt(src, open, parentOpen) !== 1) continue;   // nested deeper
    const span = spanFrom(src, open);
    if (!span) return null;
    return { start: m.index + (m[1] ? m[1].length : 0), ...span };
  }
  return null;
}

/* Any occurrence of `name {` inside the parent, at whatever depth, with the
   depth reported. Used to tell "missing" from "present but misplaced". */
function findAnyBlock(src, name, parentOpen, parentEnd) {
  const re = new RegExp(`(^|[\\s;{])${name}\\s*\\{`, 'g');
  re.lastIndex = parentOpen;
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open < 0 || open >= parentEnd) return null;
  const span = spanFrom(src, open);
  if (!span) return null;
  return { start: m.index + (m[1] ? m[1].length : 0), depth: depthAt(src, open, parentOpen), ...span };
}

module.exports = { depthAt, spanFrom, findAndroidBlock, findChildBlock, findAnyBlock };
