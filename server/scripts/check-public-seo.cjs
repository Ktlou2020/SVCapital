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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
