#!/usr/bin/env node
/* What the public site asks search engines to index.
 *
 * sitemap.xml listed five /fund/ URLs at priority 0.6-0.8. Four of them are
 * not product pages: fund/index.html is the Fund Management Operations
 * Console — fund runs, payout schedules, compliance, the audit trail, the
 * fee ledger — and cattle, solar and shortterm are NAV dashboards with cost
 * ledgers and herd reconciliation on them. Every one of them carried
 * <meta name="robots" content="index, follow"> and a description promising
 * investment returns, so the site was asking Google to index staff tooling
 * and advertise it as a product.
 *
 * All a crawler could read of those pages was "Loading NAV… Loading cycles…
 * Loading animals…", which is thin content on the primary domain, and the
 * labels of the internal console become searchable even though the data
 * behind them needs a login.
 *
 * Meanwhile institutional, private-clients and stokvels — the three
 * audiences the site is written for — were not in the sitemap at all.
 *
 * ── THE ORDERING TRAP THIS CHECK EXISTS TO HOLD ──────────────────────
 *
 * The instinct is to put Disallow: /fund/ in robots.txt. That does not
 * remove anything: a page that cannot be crawled cannot be seen to carry
 * noindex, so whatever is already indexed stays, as a bare URL, with no
 * way to shift it. The removal has to be the meta tag, read on a normal
 * crawl; the Disallow comes later, once they have gone. So this check
 * fails if a Disallow for those paths appears while the pages still
 * depend on being crawled.
 *
 * Run: node server/scripts/check-public-seo.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* Staff tooling that lives under a public path. */
const CONSOLES = ['fund/index.html', 'fund/cattle.html',
                  'fund/solar.html', 'fund/shortterm.html'];
/* Pages a prospective client should be able to find. */
const PUBLIC = ['index.html', 'private-clients.html', 'institutional.html',
                'stokvels.html', 'fund/gridfarmer.html', 'get-app.html',
                'terms.html', 'popia.html', 'paia.html', 'complaints.html'];

const SITEMAP = read('sitemap.xml');
const ROBOTS  = read('robots.txt');
const ORIGIN  = 'https://platform.svcapital.co.za/';
const locs = [...SITEMAP.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
/* Somebody's signed statement that the console pages are out of the index,
   which is the one thing a script cannot find out for itself. */
const DEINDEX_CONFIRMED =
  /^\s*#\s*de-indexed-confirmed:\s*\d{4}-\d{2}-\d{2}\s+\S/mi.test(ROBOTS);
const paths = locs.map(u => u.replace(ORIGIN, '')).map(p => p === '' ? 'index.html' : p);

/* ══ 1. The consoles are not advertised ════════════════════════════ */
console.log('\nthe fund consoles are not offered to search engines');
{
  for (const c of CONSOLES) {
    ok(`${c} is not in the sitemap`, !paths.includes(c),
       'it is staff tooling, and all a crawler can read of it is '
       + '"Loading NAV…": ' + locs.filter(l => l.includes(c)).join(', '));
    const html = read(c);
    const meta = (html.match(/<meta\s+name="robots"\s+content="([^"]*)"/i) || [])[1] || '';
    ok(`  and it says noindex`, /noindex/i.test(meta),
       'the meta tag is what actually removes a page from the index, and '
       + `this one said "${meta}"`);
    /* AND THE GATE HAS A KEY, or this check forbids the very change
       robots.txt tells the next person to make. Once the pages really
       have dropped out of the index, the Disallow is right — somebody
       just has to say they checked, in the file, where it is reviewable.
       Until that line is there, a Disallow is premature and undoes the
       removal it was meant to finish. */
    ok(`  which is the directive that can be READ`,
       !new RegExp(`^\\s*Disallow:\\s*/${c.split('/')[0]}/\\s*$`, 'mi').test(ROBOTS)
       || DEINDEX_CONFIRMED,
       'robots.txt disallows the directory these pages are in, so the '
       + 'noindex above can never be crawled and anything already indexed '
       + 'is frozen there. If they have genuinely dropped out of the '
       + 'index, record it in robots.txt as a line reading '
       + '"# de-indexed-confirmed: <yyyy-mm-dd> <who>" and this passes');
  }
}

/* ══ 2. The product page under /fund/ is still a product page ══════ */
console.log('\nbut the one real product page under /fund/ still is one');
{
  const g = read('fund/gridfarmer.html');
  const meta = (g.match(/<meta\s+name="robots"\s+content="([^"]*)"/i) || [])[1] || '';
  ok('GRIDFARMER IS STILL INDEXABLE', /index/i.test(meta) && !/noindex/i.test(meta),
     'it is a marketing page with its own headings — a blanket rule over '
     + `/fund/ takes it down with the consoles: "${meta}"`);
  ok('and it is in the sitemap', paths.includes('fund/gridfarmer.html'),
     paths.join(', '));
  ok('and robots.txt allows it back if /fund/ is ever disallowed',
     !/^\s*Disallow:\s*\/fund\/\s*$/mi.test(ROBOTS)
     || /^\s*Allow:\s*\/fund\/gridfarmer\.html\s*$/mi.test(ROBOTS),
     'a Disallow: /fund/ without the matching Allow delists the one page '
     + 'under there that should be found');
}

/* ══ 3. Every page worth finding is listed ═════════════════════════ */
console.log('\nand every page a client should find is listed');
{
  for (const p of PUBLIC)
    ok(`${p} is in the sitemap`, paths.includes(p),
       'the three audience pages were missing entirely, so the sitemap '
       + 'offered the home page and the legal notices: ' + paths.join(', '));

  /* A sitemap that names a page which does not exist teaches a crawler to
     trust it less, and nothing else notices. */
  for (const p of paths)
    ok(`  ${p} exists on disk`, fs.existsSync(path.join(ROOT, p)),
       'a 404 in the sitemap is a self-inflicted crawl error');

  ok('AND EVERY URL IS ABSOLUTE AND ON THE CANONICAL HOST',
     locs.length > 0 && locs.every(l => l.startsWith(ORIGIN)),
     'a sitemap may only list URLs on its own host: '
     + locs.filter(l => !l.startsWith(ORIGIN)).join(', '));
  ok('and nothing is listed twice',
     new Set(paths).size === paths.length,
     paths.filter((p, i) => paths.indexOf(p) !== i).join(', '));
}

/* ══ 4. The rest of the private platform stays private ═════════════ */
console.log('\nand the parts that were already private still are');
{
  for (const dir of ['/portal/', '/admin/', '/api/', '/ifa/', '/team/'])
    ok(`${dir} is disallowed`,
       new RegExp(`^\\s*Disallow:\\s*${dir.replace(/\//g, '\\/')}\\s*$`, 'mi').test(ROBOTS),
       'the client portal, the console and the staff area are not for '
       + 'crawlers');
  ok('AND NO PRIVATE AREA LEAKED INTO THE SITEMAP',
     !paths.some(p => /^(portal|admin|api|ifa|team)\//.test(p)),
     paths.join(', '));
  ok('and robots.txt still points at the sitemap',
     new RegExp('^\\s*Sitemap:\\s*' + ORIGIN + 'sitemap\\.xml\\s*$', 'mi').test(ROBOTS),
     'without it the sitemap is only found if it is submitted by hand');
}

/* ══ 5. Every public page is a document, and shareable ════════════ */
console.log('\nand every public page is a whole document');
{
  /* fund/gridfarmer.html began at its <title>: no doctype, no html, head
     or body element, no charset, no viewport. A browser renders that in
     quirks mode, guesses the encoding for every em dash on the page, and
     on a phone lays it out at desktop width and zoomed out — on the one
     real product page under /fund/. Nothing caught it because nothing
     looked at the shape of the document, only at its tags. */
  for (const p of PUBLIC) {
    const h = read(p);
    ok(`${p} has a doctype`, /^\s*<!DOCTYPE html>/i.test(h),
       'without one the browser renders in quirks mode');
    ok(`  and html, head and body`,
       /<html[^>]*>/i.test(h) && /<head[\s>]/i.test(h) && /<body[\s>]/i.test(h),
       'a fragment served as a page is not a page');
    ok(`  and declares its language`, /<html[^>]+lang="[a-z-]+"/i.test(h),
       'a screen reader and a search engine both ask');
    ok(`  and its character set`, /<meta[^>]+charset=/i.test(h),
       'every em dash on the page is a guess without it');
    ok(`  AND A VIEWPORT`, /<meta[^>]+name="viewport"/i.test(h),
       'without it a phone lays the page out at desktop width and zooms '
       + 'out — on a site whose clients are mostly on phones');
  }
}

/* ══ 6. And can be shared without looking broken ═══════════════════ */
console.log('\nand carries a share card that is not blank');
{
  const SHARE = PUBLIC.filter(p => p !== 'index.html');
  const img = /<meta property="og:image" content="([^"]+)"/i;
  for (const p of ['index.html', ...SHARE]) {
    const h = read(p);
    const m = h.match(img);
    ok(`${p} has an og:image`, !!m,
       'WhatsApp and LinkedIn render a share with no picture at all, '
       + 'which on a financial site reads as a broken or spoofed link');
    ok(`  and a twitter card`, /name="twitter:card"/i.test(h));
    if (m) {
      /* AND THE FILE IS REALLY THERE. An og:image pointing at a 404 is
         the same blank card, and nothing but a share would show it. */
      const rel = m[1].replace('https://platform.svcapital.co.za/', '');
      ok(`  and that image exists on disk`, fs.existsSync(path.join(ROOT, rel)), rel);
    }
  }
}

/* ══ 7. Descriptions that survive the search result ════════════════ */
console.log('\nand a description short enough to be read');
{
  for (const p of PUBLIC) {
    const d = (read(p).match(/<meta name="description" content="([^"]*)"/i) || [])[1];
    ok(`${p} has a description`, !!d, 'the snippet is written by Google without one');
    /* Google truncates near 155-160. Anything past that is written for
       nobody. Matched to the closing double quote and NOT to [^"\']*,
       which stops at the apostrophe in "SV Capital\'s" and reports a
       137-character description as 10 — that misreading is why this
       assertion names the length it found. */
    if (d) ok(`  and it is ${d.length} characters, within 155`, d.length <= 155,
              'the tail is cut off in every search result: ' + d);
  }
}

/* ══ 8. Structured data that matches the page ══════════════════════ */
console.log('\nand structured data that describes what is really there');
{
  for (const p of ['index.html', 'institutional.html', 'private-clients.html',
                   'stokvels.html', 'fund/gridfarmer.html']) {
    const h = read(p);
    const raw = (h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i) || [])[1];
    ok(`${p} carries structured data`, !!raw);
    if (!raw) continue;
    let g = null;
    ok(`  and it is valid JSON`, (() => { try { g = JSON.parse(raw); return true; }
                                          catch (e) { return false; } })(),
       'invalid JSON-LD is ignored in full, silently');
    if (!g) continue;
    /* A FAQPage whose questions are not on the page is a structured data
       violation, and none of these pages has an FAQ section. */
    const types = (g['@graph'] || [g]).map(n => n['@type']);
    /* LOOKED FOR IN WHAT A READER SEES, NOT IN THE MARKUP THAT CLAIMS IT.
       Scanning the whole file for /faq/ matches the word "FAQPage" inside
       the JSON-LD itself, so the claim proved itself. Stripping scripts
       was not enough either: the COMMENT above that block explains why
       there is no FAQPage on these pages, and the word "FAQ" in that
       sentence satisfied the probe just as well. Comments and styles are
       not on the page any more than a script is. */
    const body = h.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                  .replace(/<!--[\s\S]*?-->/g, ' ');
    const visible = /faq|frequently asked|<summary/i.test(body);
    ok(`  and claims no FAQ this page does not have`,
       !types.includes('FAQPage') || visible,
       'marking up answers a reader cannot see is what Google penalises');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
