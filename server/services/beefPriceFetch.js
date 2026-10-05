'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   The weekly beef price, fetched from the RPO market report.

   READ THIS BEFORE CHANGING THE PATTERNS.

   The source page is the RPO weeklikse bees- EN SKAAP-markverslag — the weekly
   CATTLE AND SHEEP report. Both animals are on it, both are quoted in rands per
   kilogram, and in South Africa their Class A bands overlap: beef runs around
   R65–R75 and lamb around R70–R100. A price range therefore CANNOT tell them
   apart. Only the label can, and only if the label is read in its beef context.

   So the extractor is built to fail rather than guess:

     · it must first locate a beef section by name. No anchor, no extraction.
     · it only reads labels inside that section, and stops at the first sheep
       heading it meets.
     · every candidate must carry a per-kilogram unit next to the number.
     · a value outside a wide but closed band is dropped.
     · a week-ending date must be found and be recent.

   Any of those failing stores NOTHING and writes the reason to
   beef_price_fetches, where the report shows it. An empty section that says
   "last fetch could not find the beef table" is worth far more than a lamb
   price sitting on a board pack labelled as beef.

   The patterns below are written against the published structure of that
   report but have NOT been run against the live page from this environment —
   rpo.co.za is denied by the network egress policy here, so the page could not
   be read. They are deliberately conservative for that reason. The first run
   against the real page will either store a price or write down exactly what it
   saw in `candidates`, which is what to tune from.
   ═══════════════════════════════════════════════════════════════════════════ */

const pool = require('../db/pool');

const SOURCE_URL = process.env.RPO_REPORT_URL
  || 'https://rpo.co.za/weeklikse-bees-en-skaap-markverslag/';
const SOURCE_NAME = 'RPO weekly report';
const TIMEOUT_MS  = 20000;

/* Where beef starts, in both languages the report uses. */
/* No trailing \b on the Afrikaans words. The report writes compounds —
   "Beesvleis", "Skaapvleis" — and \bskaap\b does NOT match "Skaapvleis",
   because the v after it is a word character. That single missing match left
   the whole sheep table inside the beef section. */
const BEEF_ANCHORS  = [/\bbees/i, /\bbeef\b/i, /\bcattle\b/i];
/* And where it ends. Everything after one of these belongs to the other animal. */
const SHEEP_ANCHORS = [/\bskaap/i, /\bskape/i, /\blam(?!b?da)/i, /\bsheep\b/i, /\bmutton\b/i, /\blamb/i];

/* A category is only recognised by a label that cannot mean the other animal. */
const CATEGORIES = [
  { key: 'class_a', basis: 'carcass', label: /\bklas\s*a\b|\bclass\s*a\b|\ba[\s-]?graad\b/i },
  { key: 'class_c', basis: 'carcass', label: /\bklas\s*c\b|\bclass\s*c\b|\bc[\s-]?graad\b/i },
  { key: 'weaner',  basis: 'live',    label: /\bspeenkalwer|\bspeener|\bweaner/i },
];

/* Wide enough not to reject a real move, closed enough that a price per head or
   a per-tonne figure cannot get in. */
const MIN_PER_KG = 15;
const MAX_PER_KG = 250;

const strip = html => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(tr|p|div|h\d|li|table)>/gi, '\n')
  .replace(/<\/t[dh]>/gi, ' | ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
  .replace(/[ \t ]+/g, ' ');

/* "R 72,50/kg", "72.50 R/kg", "R72,50 per kg" — the comma is a decimal point
   in South African copy, and reading it as a thousands separator turns R72,50
   into R7 250. */
const PER_KG = /(?:R\s*)?(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:c\/kg|R\/kg|\/\s*kg|per\s*kg|R\s*per\s*kg)/i;

function parseAmount(raw) {
  const n = parseFloat(String(raw).replace(',', '.'));
  return isFinite(n) ? n : null;
}

/* The week the report covers. Accepts a few shapes without inventing one. */
function findWeekEnding(text) {
  const MONTHS = {
    jan: 0, feb: 1, mar: 2, maa: 2, apr: 3, may: 4, mei: 4, jun: 5, jul: 6,
    aug: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11, des: 11,
  };
  let m = text.match(/(\d{1,2})\s+([A-Za-zÀ-ÿ]{3,10})\s+(20\d{2})/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon != null) return new Date(Date.UTC(+m[3], mon, +m[1]));
  }
  m = text.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = text.match(/(\d{1,2})[-/](\d{1,2})[-/](20\d{2})/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return null;
}

/* Cut the text down to the beef part, or refuse.
 *
 * The page title is "weeklikse bees- en skaap-markverslag" — it names BOTH
 * animals before any price, so the first beef word on the page is in the
 * title and so is the first sheep word. Anchoring to either one is how a lamb
 * price ends up labelled as beef.
 *
 * So every beef word is a CANDIDATE start, and each candidate is judged:
 *
 *   span   = from that word to the next sheep word after it
 *   accept = the span holds at least one category label, and no category
 *            appears in it twice
 *
 * The title fails because the span from its "bees" to its "skaap" is nine
 * characters of prose with no price in it. A sheep-only page fails every
 * candidate and is refused outright rather than having its lamb prices read as
 * beef. A real beef heading passes, whether the sheep table is above it or
 * below it. */
function allMatches(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const out = [];
  let m;
  while ((m = g.exec(text)) !== null) {
    out.push(m.index);
    if (m.index === g.lastIndex) g.lastIndex++;
  }
  return out;
}

function labelsIn(span) {
  const found = [];
  for (const c of CATEGORIES) {
    for (const idx of allMatches(span, c.label)) found.push({ key: c.key, idx });
  }
  return found.sort((a, b) => a.idx - b.idx);
}

function beefSection(text) {
  const starts = [...new Set(BEEF_ANCHORS.flatMap(a => allMatches(text, a)))].sort((a, b) => a - b);
  const sheep  = [...new Set(SHEEP_ANCHORS.flatMap(a => allMatches(text, a)))].sort((a, b) => a - b);

  /* "No beef section on this page" and "a beef section I did not trust" are
     different facts and the log has to tell them apart — one means the page
     moved, the other means the boundary is wrong. So a skipped candidate is
     kept with its reason rather than dropped. */
  const rejected = [];
  for (const start of starts) {
    const nextSheep = sheep.find(i => i > start);
    const span = text.slice(start, nextSheep === undefined ? text.length : nextSheep);
    const labels = labelsIn(span);
    if (!labels.length) continue;                       /* prose, like the title */
    const keys = labels.map(l => l.key);
    if (new Set(keys).size !== keys.length) {
      const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
      rejected.push({ why: `${[...new Set(dup)].join(', ')} appears more than once`,
                      span: span.trim().slice(0, 200) });
      continue;
    }
    return { span, rejected };
  }
  return { span: null, rejected };
}

function extract(html) {
  const text = strip(html);
  const { span: section, rejected } = beefSection(text);
  if (!section) {
    if (rejected.length) {
      return { ok: false, reason: 'rejected',
               detail: 'Found a beef section but its boundary is wrong — ' + rejected[0].why +
                       '. Nothing was stored, because the extra price may belong to the sheep table.',
               candidates: rejected };
    }
    return { ok: false, reason: 'no_match',
             detail: 'Could not find a beef section on the page. The report may have been restructured.',
             candidates: [] };
  }

  const week = findWeekEnding(section) || findWeekEnding(text);
  const candidates = [];
  for (const line of section.split('\n')) {
    const cat = CATEGORIES.find(c => c.label.test(line));
    if (!cat) continue;
    const m = line.match(PER_KG);
    if (!m) continue;
    const value = parseAmount(m[1]);
    candidates.push({ category: cat.key, basis: cat.basis, value, line: line.trim().slice(0, 120) });
  }

  if (!candidates.length) {
    return { ok: false, reason: 'no_match',
             detail: 'Found the beef section but no labelled per-kilogram price in it.',
             candidates: [] };
  }

  const kept = [], dropped = [];
  for (const c of candidates) {
    if (c.value == null || c.value < MIN_PER_KG || c.value > MAX_PER_KG) {
      dropped.push({ ...c, why: `outside R${MIN_PER_KG}–R${MAX_PER_KG}/kg` });
    } else if (kept.some(k => k.category === c.category)) {
      /* Belt and braces. beefSection already refuses a span with a repeated
         category, so reaching here means the two labels were on one line. */
      return { ok: false, reason: 'rejected',
               detail: 'Two prices for the same category on one line, so the section boundary is wrong. ' +
                       'Nothing was stored, because the second may belong to the sheep table.',
               candidates };
    } else kept.push(c);
  }
  if (!kept.length) {
    return { ok: false, reason: 'rejected',
             detail: `Every price found was outside R${MIN_PER_KG}–R${MAX_PER_KG}/kg.`,
             candidates: dropped };
  }
  if (!week) {
    return { ok: false, reason: 'rejected',
             detail: 'Found prices but no date for the week they cover, so they cannot be filed.',
             candidates: kept };
  }
  const ageDays = (Date.now() - week.getTime()) / 86400000;
  if (ageDays > 21 || ageDays < -1) {
    return { ok: false, reason: 'rejected',
             detail: `The page's week ending ${week.toISOString().slice(0, 10)} is not a recent week — ` +
                     'it may be a cached or archived report.',
             candidates: kept };
  }

  return { ok: true, weekEnding: week.toISOString().slice(0, 10), prices: kept, candidates };
}

async function fetchPage() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SOURCE_URL, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'SVCapital-report/1.0 (+https://platform.svcapital.co.za)' },
    });
    const body = res.ok ? await res.text() : '';
    return { status: res.status, ok: res.ok, body };
  } finally { clearTimeout(t); }
}

/* One run. Writes at most one row per category, never overwrites a price a
   person captured by hand, and always writes a log row. */
async function runBeefPriceFetch({ triggeredBy = null } = {}) {
  let outcome = 'unreachable', detail = null, status = null, stored = 0, candidates = null, weekEnding = null;

  try {
    const page = await fetchPage();
    status = page.status;
    if (!page.ok) {
      detail = `The page answered ${page.status}.`;
    } else {
      const got = extract(page.body);
      candidates = got.candidates || null;
      if (!got.ok) {
        outcome = got.reason;
        detail  = got.detail;
      } else {
        weekEnding = got.weekEnding;
        for (const pr of got.prices) {
          /* A hand-captured price is somebody's judgement and the fetcher does
             not quietly replace it. It only fills a gap, or updates a figure it
             put there itself. */
          const { rowCount } = await pool.query(
            `INSERT INTO beef_market_prices
               (week_ending, category, basis, rand_per_kg, source, source_url, captured_by)
             VALUES ($1,$2,$3,$4,$5,$6,NULL)
             ON CONFLICT (week_ending, category) DO UPDATE
               SET rand_per_kg = EXCLUDED.rand_per_kg, captured_at = NOW()
             WHERE beef_market_prices.captured_by IS NULL`,
            [got.weekEnding, pr.category, pr.basis, pr.value, SOURCE_NAME, SOURCE_URL]);
          stored += rowCount;
        }
        outcome = 'stored';
        detail  = `Week ending ${got.weekEnding}: ` +
                  got.prices.map(p => `${p.category} R${p.value}/kg`).join(', ') +
                  (stored < got.prices.length
                    ? ` — ${got.prices.length - stored} left alone because somebody captured them by hand.`
                    : '');
      }
    }
  } catch (err) {
    detail = `Could not reach the page: ${err.message}`;
  }

  await pool.query(
    `INSERT INTO beef_price_fetches (outcome, http_status, stored, detail, candidates, triggered_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [outcome, status, stored, detail, candidates ? JSON.stringify(candidates) : null, triggeredBy]
  ).catch(e => console.error('[beefPriceFetch] could not log the run:', e.message));

  console.log(`[beefPriceFetch] ${outcome}: ${detail || ''}`);
  return { outcome, stored, detail, weekEnding, httpStatus: status, candidates };
}

async function lastFetch() {
  const { rows: [r] } = await pool.query(
    `SELECT ran_at, outcome, stored, detail, http_status, triggered_by
       FROM beef_price_fetches ORDER BY ran_at DESC LIMIT 1`);
  return r || null;
}

module.exports = {
  runBeefPriceFetch, lastFetch, extract, beefSection, findWeekEnding, strip,
  SOURCE_URL, SOURCE_NAME, MIN_PER_KG, MAX_PER_KG,
};
