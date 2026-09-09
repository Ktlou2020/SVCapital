#!/usr/bin/env node
/* A statement shows the life of the INVESTMENT, not of the pool.
 *
 * The two date columns on the Active and Matured tables were headed "Pool
 * Start" and "Pool End" and rendered investment_pools.start_date and
 * .end_date. Those are the FUNDRAISING WINDOW — when the pool opened to money
 * and when it shut. They are not the life of anything placed in it: a pool
 * that closed to new money on 31 August 2025 holds investments maturing on
 * 31 August 2026. A client reading their statement saw a twelve-month holding
 * described as a two-month one.
 *
 * The same mistake was in three more places, all of them using the pool's
 * CLOSE as a fallback for the investment's maturity:
 *
 *   · The overdue check. An active investment with no maturity date of its own
 *     was compared against the pool's close — so it was flagged "past
 *     maturity" from the day the pool stopped raising, which is months or
 *     years early, on a document going to a client's accountant.
 *   · The sort on the matured table, which mixed two different quantities into
 *     one ordering key.
 *   · The last-resort return projection, which prorated an annual rate over
 *     the raise window rather than the term — far too few days, every time.
 *
 * So there is now ONE definition of when an investment starts and matures, and
 * the pool's raise window is not part of it. The pool's own maturity_date IS a
 * legitimate fallback — everyone in a pool matures when the pool does — and so
 * is start + term_months. Past that it is unknown, and says so.
 *
 * Run: node scripts/check-statement-investment-dates.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = fs.readFileSync(path.join(ROOT, 'js', 'investor-documents.js'), 'utf8');
const SVC  = fs.readFileSync(path.join(ROOT, 'server', 'services', 'accountStatement.js'), 'utf8');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

/* Comments blanked, newlines kept, so a negative assertion cannot be satisfied
   by the paragraph explaining the fix. */
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
const CODE = strip(DOCS);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ── The fixtures ─────────────────────────────────────────────────────────
   Every pool below has a raise window that is NOTHING like the life of the
   investment in it, which is the whole point: if the document ever falls back
   to a pool date the wrong answer is unmistakable rather than plausible. */
const INVESTMENTS = [
  /* The row the client queried. Its pool raised through January 2025 and its
     start_date is holding what belongs in investment_start_date, which is why
     the window reads backwards — see check-pool-window.cjs. The investment
     itself ran six months. */
  { id: 'M1', status: 'matured', pool_name: 'Short Term Investment - January 2025',
    product_type: 'short_term', amount: 105000, actual_return: 4242, annual_rate: 0.0404,
    start_date: '2025-01-01', maturity_date: '2025-06-30',
    pool_start_date: '2025-02-01', pool_end_date: '2025-01-31',
    maturity_instruction: 'reinvest' },
  /* A fourteen-month cattle holding out of a two-month raise. */
  { id: 'M2', status: 'matured', pool_name: 'Cattle Investment - August 2025',
    product_type: 'cattle', amount: 29242, actual_return: 3576.30, annual_rate: 0.1223,
    start_date: '2025-07-01', maturity_date: '2026-08-31',
    pool_start_date: '2025-07-01', pool_end_date: '2025-08-31',
    maturity_instruction: 'reinvest' },

  /* ── active, exercising the maturity hierarchy ── */
  { id: 'A1', status: 'active', pool_name: 'Cattle Investment - March 2026', product_type: 'cattle',
    amount: 15000, annual_rate: 0.1483,
    start_date: '2026-03-01', maturity_date: '2027-03-01',
    pool_start_date: '2026-03-01', pool_end_date: '2026-03-31' },
  /* No maturity on the investment. The POOL's maturity is the fallback; the
     pool's close (31 May 2026) must never be. */
  { id: 'A2', status: 'active', pool_name: 'Short Term Investment - May 2026', product_type: 'short_term',
    amount: 8000, annual_rate: 0.04,
    start_date: '2026-05-01', maturity_date: null,
    pool_start_date: '2026-05-01', pool_end_date: '2026-05-31',
    pool_maturity_date: '2026-11-30' },
  /* Nothing but a term. */
  { id: 'A3', status: 'active', pool_name: 'Solar Investment - June 2026', product_type: 'solar',
    amount: 20000, annual_rate: 0.13, term_months: 12,
    start_date: '2026-06-01', maturity_date: null,
    pool_start_date: '2026-06-01', pool_end_date: '2026-06-30' },
  /* Nothing at all. Its pool closed long ago — which under the old code made
     it "past maturity" on a document going to a client. */
  { id: 'A4', status: 'active', pool_name: 'Unknown Term Pool', product_type: 'cattle',
    amount: 5000, annual_rate: 0.14,
    start_date: '2026-07-01', maturity_date: null,
    pool_start_date: '2025-01-01', pool_end_date: '2025-01-31' },
];

const DATA = {
  investor: { id: 'INV-000123', first_name: 'Test', last_name: 'Investor', email: 't@example.test' },
  period: { from: '2024-09-01', to: '2026-09-01' },
  opening_balance: 0, closing_balance: 0, transactions: [],
  investments: INVESTMENTS,
};

console.log('\nthe pool\'s raise window is not the investment\'s life');
{
  ok('the document no longer reads the pool window at all',
     !/pool_start_date/.test(CODE) && !/pool_end_date/.test(CODE),
     'those columns rendered when the pool opened and shut to new money');
  ok('there is one definition of when an investment starts',
     /function investmentStart\(/.test(CODE));
  ok('and one of when it matures', /function investmentMaturity\(/.test(CODE));
  ok('the maturity falls back to the POOL\'S MATURITY, never its close',
     /pool_maturity_date/.test(CODE) && !/pool_end_date/.test(CODE),
     'everyone in a pool matures when the pool does; nobody matures when it stops raising');
  ok('and then to the term on the investment', /term_months/.test(CODE));
  ok('the server sends both pool dates so the two can be told apart',
     /p\.maturity_date AS pool_maturity_date/.test(SVC) && /i\.term_months/.test(SVC));

  ok('the columns are labelled for what they now show',
     /Investment Start<\/th>/.test(DOCS) && /Investment Maturity<\/th>/.test(DOCS) &&
     !/>Pool Start</.test(DOCS) && !/>Pool End</.test(DOCS));
  ok('and so are the CSV headings',
     /'Investment Start Date','Investment Maturity Date'/.test(DOCS) &&
     !/Pool Start Date/.test(DOCS) && !/Pool End Date/.test(DOCS));
  ok('the duplicate leading Date column is gone',
     !/<th>Date<\/th><th>Pool Name<\/th>/.test(DOCS),
     'it rendered start_date, the same value the new first column shows');
  ok('the empty-row colspans followed the columns',
     /colspan="6" class="empty-row">No active/.test(DOCS) &&
     /colspan="9" class="empty-row">No matured/.test(DOCS),
     'a colspan left behind leaves a ragged row on an empty statement');

  const v = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8')
    .match(/investor-documents\.js\?v=(\d+)/);
  ok('investor-documents.js is cache-busted past 4', v && Number(v[1]) > 4,
     v ? v[0] : 'no version query string');
  ok('and the mobile bundle carries the same file',
     fs.readFileSync(path.join(ROOT, 'mobile', 'www', 'js', 'investor-documents.js'), 'utf8') === DOCS,
     'mobile/www is built from js/ — a stale copy serves the old columns');
}

console.log('\nthe three places that used the pool close as a maturity');
{
  ok('the overdue check reads the investment\'s maturity',
     /const end = investmentMaturity\(i\);/.test(CODE),
     'it compared against the pool close, flagging live holdings as past maturity');
  ok('the matured table sorts on the investment\'s maturity',
     /_maturityMs = i => \{ const d = investmentMaturity\(i\)/.test(CODE));
  ok('and the active table on the investment\'s start',
     /_startMs\s+= i => \{ const d = investmentStart\(i\)/.test(CODE));
  ok('the return projection measures the investment\'s term',
     /const start = investmentStart\(i\);\s*\n\s*const end   = investmentMaturity\(i\);/.test(CODE),
     'it prorated an annual rate over the raise window — far too few days');
  ok('nothing is left comparing against a pool close',
     !/maturity_date \|\| i\.pool_end_date/.test(CODE));
}

/* ── Rendered ───────────────────────────────────────────────────────────── */
console.log('\nthe document, rendered');
if (!CHROME) {
  console.log('  SKIP  no headless Chromium');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'invdates-'));
  fs.copyFileSync(path.join(ROOT, 'js', 'api.js'), path.join(tmp, 'api.js'));
  fs.copyFileSync(path.join(ROOT, 'js', 'investor-documents.js'), path.join(tmp, 'docs.js'));

  const page = `<!DOCTYPE html><html><body><div id="doc"></div><div id="probe"></div>
<script>const ERRORS = []; window.onerror = m => ERRORS.push(String(m));<\/script>
<script src="./api.js"><\/script>
<script src="./docs.js"><\/script>
<script>
const out = { errors: ERRORS };
try {
  document.getElementById('doc').innerHTML =
    SVCDocs.accountStatementHTML(${JSON.stringify(DATA).replace(/</g, '\\u003c')});
  out.rendered = 'ok';
} catch (e) { out.rendered = 'THREW: ' + e.message; }
const tables = [...document.querySelectorAll('#doc table')];
const grab = t => t ? {
  cols: [...t.querySelectorAll('th')].map(th => th.textContent.trim()),
  rows: [...t.querySelectorAll('tbody tr')].map(r => [...r.querySelectorAll('td')].map(c => c.textContent.trim())),
} : null;
out.active  = grab(tables.find(t => t.innerHTML.includes('Investment Maturity') && !t.innerHTML.includes('Rand Return')));
out.matured = grab(tables.find(t => t.innerHTML.includes('Rand Return')));
const txt = document.getElementById('doc').textContent || '';
out.saysOverdue = /past (its |their )?maturity|overdue/i.test(txt);
out.mentionsPoolStart = /Pool Start|Pool End/.test(txt);
document.getElementById('probe').textContent = JSON.stringify(out);
<\/script></body></html>`;
  fs.writeFileSync(path.join(tmp, 'p.html'), page);

  let dom = '';
  try {
    dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
      '--allow-file-access-from-files', '--virtual-time-budget=5000', '--dump-dom',
      'file://' + path.join(tmp, 'p.html')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 40000, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) { dom = (err.stdout || '').toString(); }

  const m = dom.match(/id="probe">([\s\S]*?)<\/div>/);
  let r = null;
  try {
    r = JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
  } catch (_) { /* reported below */ }

  ok('the page reported', !!r, (m ? m[1] : dom).slice(0, 300));
  if (r) {
    ok('the statement renders', r.rendered === 'ok', r.rendered);
    ok('nothing threw', (r.errors || []).length === 0, JSON.stringify(r.errors));
    ok('and the words "Pool Start" and "Pool End" are gone from it',
       r.mentionsPoolStart === false);

    const A = r.active || { cols: [], rows: [] };
    const M = r.matured || { cols: [], rows: [] };
    ok('both tables lead with the investment\'s own dates',
       A.cols.slice(0, 2).join('|') === 'Investment Start|Investment Maturity' &&
       M.cols.slice(0, 2).join('|') === 'Investment Start|Investment Maturity',
       JSON.stringify([A.cols.slice(0, 2), M.cols.slice(0, 2)]));

    const row = (t, name) => (t.rows || []).find(x => (x[2] || '').includes(name)) || [];

    /* The reported row: six months of investment out of a January raise. */
    const jan = row(M, 'January 2025');
    ok('the queried row shows the investment ran 01 Jan to 30 Jun 2025',
       jan[0] === '01 Jan 2025' && jan[1] === '30 Jun 2025',
       JSON.stringify(jan.slice(0, 2)) + ' — the pool window was 01 Feb 2025 to 31 Jan 2025');

    const cattle = row(M, 'August 2025');
    ok('a fourteen-month holding is not shown as a two-month one',
       cattle[0] === '01 Jul 2025' && cattle[1] === '31 Aug 2026',
       JSON.stringify(cattle.slice(0, 2)) + ' — the pool closed 31 Aug 2025');

    /* The maturity hierarchy, in the rendered document. */
    const a1 = row(A, 'March 2026');
    ok('an investment with its own maturity uses it', a1[1] === '01 Mar 2027', JSON.stringify(a1.slice(0, 2)));
    const a2 = row(A, 'May 2026');
    ok('one without falls to the POOL\'S MATURITY, not the pool\'s close',
       a2[1] === '30 Nov 2026',
       `${a2[1]} — the pool closed 31 May 2026, which is what it used to show`);
    const a3 = row(A, 'June 2026');
    ok('and then to start + term_months', a3[1] === '01 Jun 2027', JSON.stringify(a3.slice(0, 2)));
    const a4 = row(A, 'Unknown Term');
    /* Tested as "not a date" rather than as an em-dash: --dump-dom hands the
       character back in an encoding this file cannot compare against, and the
       thing that matters is that no date was borrowed from anywhere. */
    ok('with nothing to go on it shows no date rather than borrowing a pool one',
       !!a4[1] && !/\d/.test(a4[1]),
       `${JSON.stringify(a4[1])} — the pool close was 31 Jan 2025`);

    /* The overdue banner. A4's pool closed in January 2025; the investment
       started in July 2026 and has no maturity. Under the old fallback it was
       "past maturity" — on a document going to a client's accountant. */
    ok('no live holding is called past maturity because its pool stopped raising',
       r.saysOverdue === false,
       'A4 opened after its pool closed and has no maturity of its own');
  }
  if (!process.env.DUMP) fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
