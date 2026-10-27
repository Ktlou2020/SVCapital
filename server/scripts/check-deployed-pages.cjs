#!/usr/bin/env node
/* A page is published to both hosts, or it is not published.
 *
 * This platform ships its front end twice. Railway builds the Dockerfile and
 * serves the repository root behind the API; Cloudflare takes what
 * `pages:build` copies into dist/. Each has its own hand-written list of
 * which root HTML files to include, and neither has ever known about the
 * other.
 *
 * So a page could be — and was — written, styled, linked from the main
 * menu, checked, announced and published, and still answer "Not found" on
 * one of the two hosts. institutional.html and private-clients.html went out
 * on Cloudflare and were absent from the Docker image for three commits. The
 * menu carried both links on Railway the whole time, because index.html,
 * css/ and js/ are copied wholesale and only the per-page list had the gap.
 * Nothing in the suite compared the two lists, so nothing failed.
 *
 * It is the same shape of fault as terms.html, popia.html, paia.html and
 * complaints.html sitting in the repository and 404ing on the published site
 * — found then, fixed in one of the two lists, and left uncovered in the
 * other.
 *
 * Three comparisons, because the drift runs in three directions: a page in
 * one list and not the other, a listed page that does not exist, and a page
 * on disk that neither list mentions. The last one is why the deliberate
 * exclusions are named here rather than inferred: a scratch file nobody
 * ships is fine, a real page nobody ships is the bug.
 *
 * Run: node server/scripts/check-deployed-pages.cjs
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

/* Root pages that are deliberately not served anywhere. Named, not guessed:
   the point of the list is that adding a page to the repository and to
   neither host has to be a decision somebody wrote down. */
const NOT_PUBLISHED = ['test.html'];

const DOCKER = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const PKG    = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BUILD  = PKG.scripts['pages:build'] || '';

const sorted = a => [...a].sort();
const inImage = sorted(
  [...DOCKER.matchAll(/^COPY\s+([\w.-]+\.html)\s/gm)].map(m => m[1]));
const inPages = sorted(
  [...BUILD.matchAll(/(?:^|\s)([\w.-]+\.html)(?=\s)/g)].map(m => m[1]));
const onDisk  = sorted(fs.readdirSync(ROOT).filter(f => /\.html$/.test(f)));

console.log('\nthe two hosts ship the same set of pages');
{
  const onlyImage = inImage.filter(f => !inPages.includes(f));
  const onlyPages = inPages.filter(f => !inImage.includes(f));
  ok('every page in the Docker image is in the Cloudflare build',
     onlyImage.length === 0, onlyImage.join(', ') + ' — live on Railway, 404 on the published site');
  ok('and every page in the Cloudflare build is in the Docker image',
     onlyPages.length === 0, onlyPages.join(', ') + ' — live on the published site, 404 on Railway');
  ok('neither list is empty', inImage.length > 0 && inPages.length > 0,
     `image ${inImage.length}, pages ${inPages.length} — the parser found nothing, which is not the same as agreement`);
}

console.log('\nand every page they ship exists');
{
  const missing = sorted(new Set([...inImage, ...inPages]))
    .filter(f => !fs.existsSync(path.join(ROOT, f)));
  ok('no list names a file that is not there', missing.length === 0, missing.join(', '));
}

console.log('\nand no page is quietly shipped by neither');
{
  const orphans = onDisk.filter(f => !inImage.includes(f) && !inPages.includes(f)
                                     && !NOT_PUBLISHED.includes(f));
  ok('every root page is either published or deliberately excluded',
     orphans.length === 0,
     orphans.join(', ') + ' — add it to both lists, or to NOT_PUBLISHED in this file');
  const gone = NOT_PUBLISHED.filter(f => !fs.existsSync(path.join(ROOT, f)));
  ok('and the exclusion list has no leftovers in it', gone.length === 0,
     gone.join(', ') + ' — the file is gone; take it off the list');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
