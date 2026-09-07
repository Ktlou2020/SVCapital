#!/usr/bin/env node
/* PE Monitor — the agreement, the statements, and the money.
 *
 * The console was built around a percentage-of-AUM fee and an entry date. The
 * signed fund management agreements are not that: they fix a rand fee,
 * escalating annually on the contract anniversary, of which SVC keeps 51%
 * under the partnership agreement. None of those three facts had a column, so
 * they lived in a free-text notes field where nothing could compute against
 * them, and the one fee calculation in the file wrote an ANNUAL figure into a
 * monthly invoice.
 *
 * Four things here are easy to get wrong in a way that produces a plausible
 * wrong number rather than an error, so each is checked against fixtures whose
 * right answer is arithmetic rather than judgement:
 *
 *   1. EBITDA. Most AFS never state it, so it is rebuilt — and the direction
 *      is the whole point. Net profit is already AFTER tax, interest and
 *      depreciation, so getting back to operating earnings means ADDING those
 *      back. Subtracting them deducts the same costs twice and understates the
 *      figure badly on exactly the geared companies where it matters. The
 *      fixture below has a right answer of R2 000 000; the subtract-instead
 *      version gives R0, which is a number that looks like it could be real.
 *
 *   2. Escalation compounds. Year three of a 7% clause is base × 1.07², not
 *      base × 1.14 and not base × 1.07.
 *
 *   3. The contract year is read off a DATE column, which arrives through the
 *      JSON API as a full ISO timestamp. Code that appends 'T00:00:00Z' to it
 *      produces an Invalid Date and silently falls back to year 1 — the fee
 *      then reads as the un-escalated base and looks perfectly reasonable.
 *
 *   4. The console duplicates (1) and (2) so a table cell does not need a
 *      round trip per row. A copy nobody checks drifts, so the same fixtures
 *      run through BOTH implementations and must agree to the cent.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-pe-monitor.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const http = require('http');
const vm   = require('vm');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_pemon_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

const F    = require(path.join(ROOT, 'server', 'services', 'peFinance.js'));
const UI   = fs.readFileSync(path.join(ROOT, 'team', 'js', 'pe-monitor.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'team', 'pe-monitor.html'), 'utf8');
const CSS  = fs.readFileSync(path.join(ROOT, 'team', 'css', 'pe-monitor.css'), 'utf8');
const DOCS = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'pe-documents.js'), 'utf8');
const EXTRACT = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'pe-extract.js'), 'utf8');
const SETUP   = fs.readFileSync(path.join(ROOT, 'server', 'db', 'setup.js'), 'utf8');
const INDEX   = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');

/* Comments blanked, newlines kept — a negative assertion must not be satisfied
   by the paragraph explaining the fix. */
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
const UI_CODE = strip(UI);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const near = (a, b) => a !== null && b !== null && Math.abs(a - b) < 0.005;

function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool;

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  const url = withDatabase(process.env.DATABASE_URL, DB_NAME);
  process.env.DATABASE_URL = url;
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  pool = new Pool({ connectionString: url, ssl: SSL, max: 2 });
  /* The teardown drops this database WITH (FORCE); pg reports the termination
     as a pool 'error', and a pool with no listener takes the process down
     after every assertion has already passed. */
  pool.on('error', () => {});
}

/* ── The console's own arithmetic, lifted and run ──────────────────────────
   Nothing here stubs the functions under test: the real source is executed. */
function liftUi() {
  const names = ['numOrNull','round2','dateOnly','todayISO','contractStart','ebitdaOf',
                 'annualGrossFee','svcSharePct','contractYearOn','feeForPeriod',
                 'feeSvcAmount','lifetimeRevenue','financialYearEndISO','addMonthsISO',
                 'afsScheduleFor','financialYearOptions','decimalToPct','pctToDecimal'];
  /* The tables and thresholds the lifted functions close over. Lifting a
     function without them gives a ReferenceError on the first call, which
     reads as though the shipped code is broken. */
  const lit = (re, label) => {
    const m = UI.match(re);
    if (!m) throw new Error(label + ' not found in team/js/pe-monitor.js');
    return 'var ' + m[0].replace(/^const /, '') + '\n';
  };
  let src = lit(/const EBITDA_ADDBACKS = \[[\s\S]*?\];/, 'EBITDA_ADDBACKS')
          + lit(/const PERIODS_PER_YEAR = \{[^}]*\};/, 'PERIODS_PER_YEAR')
          + lit(/const AFS_REQUEST_MONTHS = \d+;/, 'AFS_REQUEST_MONTHS')
          + lit(/const AFS_OVERDUE_MONTHS = \d+;/, 'AFS_OVERDUE_MONTHS');
  for (const n of names) {
    /* Substring, not regex: escaping a literal '(' from a JS string into a
       RegExp is a step this file does not need. Two shapes exist in this file
       — a function declaration ending on a line that is exactly '}', and a
       one-line arrow const ending on ';'. */
    let at = UI.indexOf('function ' + n + '(');
    if (at >= 0) {
      const end = UI.indexOf('\n}\n', at);
      if (end < 0) throw new Error(n + ' has no end marker');
      src += UI.slice(at, end + 3) + '\n';
      continue;
    }
    at = UI.indexOf('const ' + n + ' = ');
    if (at < 0) throw new Error(n + ' not found in team/js/pe-monitor.js');
    const end = UI.indexOf(';\n', at);
    if (end < 0) throw new Error(n + ' has no end marker');
    src += 'var ' + UI.slice(at + 6, end + 2) + '\n';
  }
  const ctx = vm.createContext({ console, Date, Math, Number, String, Array, JSON, parseFloat, parseInt, isNaN });
  vm.runInContext(src + '\nthis._ui = { ' + names.join(', ') + ' };', ctx);
  return ctx._ui;
}

let CURRENT_USER = { id: 'PE-ADM', email: 'a@example.test', role: 'admin', level: 'executive' };
function serve() {
  const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
  const authPath = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, children: [], paths: [],
    exports: {
      requireAuth: (req, _res, next) => { req.user = CURRENT_USER; next(); },
      requireRole: () => (_req, _res, next) => next(),
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/pe', require(path.join(ROOT, 'server', 'routes', 'pe-insights')));
  app.use('/api/pe/documents', require(path.join(ROOT, 'server', 'routes', 'pe-documents')));
  return new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

const req = (port, method, url, body, headers) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port, path: url, method,
    headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}) },
    res => {
      let b = ''; res.on('data', d => (b += d));
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(b); } catch (_) { parsed = { _raw: b.slice(0, 300) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
  r.on('error', reject); if (data) r.write(data); r.end();
});
const get = (port, url) => req(port, 'GET', url);

/* multipart, by hand — the suite has no form-data dependency and this is
   twenty lines. */
function multipart(fields, file) {
  const B = '----pecheck' + Math.random().toString(36).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(
      `--${B}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\n` +
      `Content-Type: ${file.type}\r\n\r\n`));
    parts.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${B}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${B}` };
}
const postForm = (port, url, fields, file) => new Promise((resolve, reject) => {
  const { body, type } = multipart(fields, file);
  const r = http.request({ host: '127.0.0.1', port, path: url, method: 'POST',
    headers: { 'Content-Type': type, 'Content-Length': body.length } }, res => {
      let b = ''; res.on('data', d => (b += d));
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(b); } catch (_) { parsed = { _raw: b.slice(0, 400) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
  r.on('error', reject); r.write(body); r.end();
});

/* ── Fixtures ──────────────────────────────────────────────────────────────
   ACME: EBITDA is NOT stated. Net profit 1 000 000, tax 400 000, finance cost
   250 000, depreciation 350 000. Adding back gives 2 000 000. Subtracting
   gives 0 — a number that would pass an "is it a number" assertion. */
const ACME_FIN = {
  financial_year: 2025, revenue: 10000000, net_profit: 1000000,
  tax_expense: 400000, finance_cost: 250000, depreciation: 350000,
  total_assets: 14000000, total_liabilities: 6000000, cash: 1500000,
  total_debt: 2500000, operating_cashflow: 1800000,
  current_assets: 5000000, current_liabilities: 3000000, audited: true,
};
const ACME_EBITDA = 2000000;

/* STRAIN: every red flag that can fire at once, so an assessment that
   silently stops after the first one is visible. */
const STRAIN_2025 = {
  financial_year: 2025, revenue: 20000000, net_profit: -500000,
  tax_expense: 0, finance_cost: 1200000, depreciation: 800000,
  total_assets: 9000000, total_liabilities: 11000000, cash: 100000,
  total_debt: 8000000, operating_cashflow: -300000,
  current_assets: 2000000, current_liabilities: 4000000, audited: false,
};
const STRAIN_2024 = { financial_year: 2024, revenue: 26000000, net_profit: 1400000,
  tax_expense: 600000, finance_cost: 900000, depreciation: 700000, audited: true };

/* The agreement: R600 000 a year, 7% on each anniversary of 1 March 2024,
   billed monthly, SVC keeps 51%. */
const AGREEMENT = {
  id: 'peco-chk', name: 'Checkable Holdings', sector: 'FMCG', status: 'portfolio',
  fee_basis: 'amount', fee_amount: 600000, fee_escalation_pct: 0.07,
  svc_share_pct: 0.51, holding_pct: 0.51, contract_start_date: '2024-03-01',
  fee_billing_period: 'monthly', invoice_terms_days: 30,
  financial_year_end_month: 2, partnership_name: 'SAS SVC Partnership',
};

async function seed() {
  await pool.query(`DELETE FROM pe_companies WHERE id LIKE 'peco-chk%'`);
  await pool.query(
    `INSERT INTO pe_companies (id,name,sector,status,fee_basis,fee_amount,fee_escalation_pct,
        svc_share_pct,holding_pct,contract_start_date,fee_billing_period,invoice_terms_days,
        financial_year_end_month,partnership_name,address_line1,address_province)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'12 Fredman Drive','Gauteng')`,
    ['peco-chk', AGREEMENT.name, 'FMCG', 'portfolio', 'amount', 600000, 0.07, 0.51, 0.51,
     '2024-03-01', 'monthly', 30, 2, 'SAS SVC Partnership']);
  await pool.query(
    `INSERT INTO pe_companies (id,name,sector,status,financial_year_end_month,fee_basis,fee_amount,
        fee_escalation_pct,svc_share_pct,contract_start_date,fee_billing_period)
     VALUES ('peco-chk2','Strained Checkable','Manufacturing','portfolio',2,'amount',480000,0.06,0.51,'2023-07-01','quarterly')`);
  await pool.query(`INSERT INTO pe_companies (id,name,sector,status) VALUES ('peco-chk3','Empty Checkable','FMCG','portfolio')`);

  for (const [co, f] of [['peco-chk', ACME_FIN], ['peco-chk2', STRAIN_2025], ['peco-chk2', STRAIN_2024]]) {
    const keys = Object.keys(f);
    await pool.query(
      `INSERT INTO pe_financials (id, company_id, ${keys.join(',')})
       VALUES ($1,$2,${keys.map((_, i) => `$${i + 3}`).join(',')})`,
      ['pefin-chk-' + co + '-' + f.financial_year, co, ...keys.map(k => f[k])]);
  }
}

(async () => {
  let srv, ui;
  try {
    await makeDatabase();
    await seed();
    srv = await serve();
    const port = srv.address().port;

    /* ═══ 1. EBITDA ═══ */
    console.log('\nEBITDA is rebuilt by ADDING the add-backs back');
    {
      const e = F.computeEbitda(ACME_FIN);
      ok('net profit + tax + finance cost + depreciation',
         near(e.value, ACME_EBITDA),
         `got ${e.value}, expected ${ACME_EBITDA} — ${e.value === 0 ? 'this is the subtract-instead answer' : ''}`);
      ok('and it is NOT the subtract-instead figure',
         e.value !== (ACME_FIN.net_profit - ACME_FIN.tax_expense - ACME_FIN.finance_cost - ACME_FIN.depreciation),
         'subtracting gives 0 here, which reads as a real number');
      ok('marked as derived, not as something the AFS said', e.source === 'derived');
      ok('the components are returned so the figure can be audited',
         Array.isArray(e.components) && e.components.length === 5 &&
         e.components[0].key === 'net_profit');
      ok('a stated EBITDA wins over the add-backs',
         F.computeEbitda({ ebitda: 9999, net_profit: 1, tax_expense: 1 }).value === 9999 &&
         F.computeEbitda({ ebitda: 9999, net_profit: 1 }).source === 'stated');
      ok('amortisation absent is normal and does not block the sum',
         F.computeEbitda(ACME_FIN).complete === true,
         'small-company AFS rarely carry an amortisation line');
      ok('a missing add-back is reported, because it understates the answer',
         F.computeEbitda({ net_profit: 100, tax_expense: 10 }).missing.join(',') === 'finance_cost,depreciation');
      ok('no net profit means no EBITDA, not a total of the add-backs alone',
         F.computeEbitda({ tax_expense: 10, finance_cost: 20 }).value === null,
         'a sum of add-backs wearing the EBITDA label is worse than a blank');
      ok('a loss still derives — the add-backs can carry it positive',
         near(F.computeEbitda(STRAIN_2025).value, 1500000),
         String(F.computeEbitda(STRAIN_2025).value));
    }

    /* ═══ 2. Financial position ═══ */
    console.log('\nthe position reads off the statements, and says why');
    {
      const a = F.assessFinancials(STRAIN_2025, STRAIN_2024);
      const codes = a.flags.map(f => f.code);
      ok('verdict is critical when critical things are true', a.verdict === 'critical', a.verdict);
      ok('balance-sheet insolvency is flagged', codes.includes('balance_sheet_insolvent'), codes.join(','));
      ok('current liabilities exceeding current assets is flagged', codes.includes('illiquid'));
      ok('excessive debt is flagged against EBITDA, not against revenue',
         codes.includes('excessive_debt') && near(a.metrics.net_debt_to_ebitda, 5.27),
         `net debt/EBITDA ${a.metrics.net_debt_to_ebitda}`);
      ok('operating cash burn is flagged', codes.includes('cash_burn'));
      ok('a sharp revenue fall is flagged against the prior year',
         codes.includes('revenue_collapse'), codes.join(','));
      ok('thin interest cover is flagged', codes.includes('thin_interest_cover'));
      ok('unaudited is said out loud, as context not as a fault',
         a.flags.some(f => f.code === 'unaudited' && f.level === 'info'));
      ok('a derived EBITDA is disclosed on the assessment too',
         a.flags.some(f => f.code === 'ebitda_derived' && f.level === 'info'));
      ok('critical flags sort above warnings and info',
         a.flags.findIndex(f => f.level === 'warning') > a.flags.findIndex(f => f.level === 'critical') &&
         a.flags.findIndex(f => f.level === 'info') > a.flags.findIndex(f => f.level === 'warning'));
      ok('every flag names the figures it fired on',
         a.flags.every(f => f.detail && f.detail.length > 20));
      ok('the summary states the position, not just a verdict',
         /Revenue/.test(a.summary) && /EBITDA/.test(a.summary) && /equity/.test(a.summary), a.summary);

      const clean = F.assessFinancials(ACME_FIN, null);
      ok('a sound company is not flagged into looking unsound',
         clean.verdict === 'stable' && !clean.flags.some(f => f.level === 'critical'),
         `${clean.verdict}: ${clean.flags.map(f => f.code).join(',')}`);
      ok('and its EBITDA still discloses that it was derived',
         clean.flags.some(f => f.code === 'ebitda_derived'));

      /* A company with nothing on file is not a healthy company. */
      const nothing = F.assessFinancials({ financial_year: 2025 }, null);
      ok('nothing on file does not read as "nothing wrong"',
         !/Nothing flagged/.test(nothing.summary), nothing.summary);
    }

    /* ═══ 3. Fees ═══ */
    console.log('\nthe fee escalates, compounds, and splits 51/49');
    {
      const s = F.feeSchedule(AGREEMENT, { years: 5 });
      ok('year 1 is the base fee', near(s.rows[0].gross_annual, 600000));
      ok('year 2 is base × 1.07', near(s.rows[1].gross_annual, 642000), String(s.rows[1].gross_annual));
      ok('year 3 COMPOUNDS — base × 1.07², not base × 1.14',
         near(s.rows[2].gross_annual, 686940),
         `got ${s.rows[2].gross_annual}; simple interest would give 684000`);
      ok('year 5 compounds four times', near(s.rows[4].gross_annual, 786477.61), String(s.rows[4].gross_annual));
      ok('SVC keeps 51% of the gross', near(s.rows[0].svc_share, 306000) && near(s.rows[1].svc_share, 327420));
      ok('and the partner gets the rest, to the cent',
         near(s.rows[1].svc_share + s.rows[1].partner_share, s.rows[1].gross_annual));
      ok('a monthly agreement divides by twelve for the invoice',
         near(s.rows[0].per_invoice, 50000) && s.invoicesPerYear === 12,
         'the old code wrote the ANNUAL figure into a monthly invoice');
      ok('the contract year runs from the contract start date',
         s.rows[1].period_start === '2025-03-01' && s.rows[0].period_end === '2025-02-28',
         JSON.stringify([s.rows[0].period_end, s.rows[1].period_start]));
      ok('year 1 carries no escalation', s.rows[0].escalation_applied === 0);

      const quarterly = F.feeSchedule({ ...AGREEMENT, fee_billing_period: 'quarterly' }, { years: 1 });
      ok('a quarterly agreement divides by four', near(quarterly.rows[0].per_invoice, 150000));

      /* Percentage-of-AUM agreements must keep working untouched. */
      const pct = F.feeSchedule({ fee_basis: 'percentage', aum_amount: 10000000, fee_rate: 0.02, svc_share_pct: 0.51 }, { years: 2 });
      ok('a percentage-of-AUM agreement still computes', near(pct.rows[0].gross_annual, 200000));
      ok('a company with neither basis returns no schedule rather than zero',
         F.feeSchedule({ name: 'x' }, { years: 3 }).rows.length === 0);
      ok('no escalation on file means a flat fee, not a crash',
         near(F.feeSchedule({ fee_basis: 'amount', fee_amount: 100 }, { years: 3 }).rows[2].gross_annual, 100));
      ok('the SVC share defaults to 51% when the column is null',
         F.feeSchedule({ fee_basis: 'amount', fee_amount: 1000 }, { years: 1 }).svcSharePct === 0.51);
    }

    console.log('\nlifetime revenue counts invoices, not intentions');
    {
      const co = { svc_share_pct: 0.51 };
      const rows = [
        { status: 'paid',      gross_amount: 46000, invoice_date: '2025-07-01' },
        { status: 'invoiced',  gross_amount: 46000, invoice_date: '2025-08-01' },
        { status: 'overdue',   gross_amount: 46000, invoice_date: '2025-09-01' },
        { status: 'projected', gross_amount: 46000, invoice_date: '2025-10-01' },
        { status: 'waived',    gross_amount: 46000, invoice_date: '2025-11-01' },
      ];
      const r = F.lifetimeRevenue(rows, co);
      ok('projected and waived are excluded from revenue',
         r.invoice_count === 3 && near(r.invoiced_gross, 138000),
         `${r.invoice_count} rows, ${r.invoiced_gross}`);
      ok('SVC share of the lifetime total', near(r.invoiced_svc, 70380));
      ok('paid and outstanding split correctly',
         near(r.paid_gross, 46000) && near(r.outstanding_gross, 92000));
      ok('a row with its own split overrides the company default',
         near(F.svcShareOf({ gross_amount: 1000, svc_share_pct: 0.4 }, co), 400),
         'a historical invoice raised under a different split keeps it');
      ok('amount is used when gross_amount is not set',
         near(F.svcShareOf({ amount: 1000 }, co), 510));
    }

    /* ═══ 4. AFS timing ═══ */
    console.log('\nAFS is requested three months after year end');
    {
      const co = { financial_year_end_month: 2 };
      const s = F.afsSchedule(co, 2026, '2026-04-01');
      ok('a February year end ends on the last day of February',
         s.year_end === '2026-02-28', s.year_end);
      ok('a leap year is handled', F.afsSchedule(co, 2024).year_end === '2024-02-29');
      ok('the request date is three months later', s.request_from === '2026-05-28', s.request_from);
      ok('overdue is six months later', s.overdue_from === '2026-08-28', s.overdue_from);
      ok('before the request date it is not yet due', s.status === 'not_yet', s.status);
      ok('after it, it is due', F.afsSchedule(co, 2026, '2026-06-01').status === 'due');
      ok('and after six months, overdue', F.afsSchedule(co, 2026, '2026-09-01').status === 'overdue');
      ok('a December year end works too',
         F.afsSchedule({ financial_year_end_month: 12 }, 2025, '2026-05-01').year_end === '2025-12-31');
      ok('no year end on file means no schedule, not a guessed one',
         F.afsSchedule({}, 2025) === null);

      const years = F.financialYearOptions({ financial_year_end_month: 12 }, '2026-06-01', 3, 0);
      ok('the year dropdown does not offer a year that has not ended',
         !years.includes(2026) && years[0] === 2025, JSON.stringify(years));
      ok('and it does once the year end has passed',
         F.financialYearOptions({ financial_year_end_month: 2 }, '2026-06-01', 3, 0)[0] === 2026);
    }

    /* ═══ 5. The routes ═══ */
    console.log('\nthe summary endpoint answers with all of it');
    {
      const r = await get(port, '/api/pe/company/peco-chk2/summary');
      const b = r.body;
      ok('the endpoint responds', r.status === 200, JSON.stringify(b).slice(0, 200));
      ok('with the position read off the latest year',
         b.assessment.verdict === 'critical' && b.financials[0].financial_year === 2025);
      ok('the prior year is used for the growth comparison',
         b.assessment.flags.some(f => f.code === 'revenue_collapse'));
      ok('EBITDA is returned per year with its provenance',
         b.ebitda_by_year.length === 2 && b.ebitda_by_year[0].source === 'derived' &&
         near(b.ebitda_by_year[0].ebitda, 1500000));
      ok('the fee schedule comes back escalated',
         near(b.fee_schedule.rows[1].gross_annual, 508800), String(b.fee_schedule.rows[1].gross_annual));
      ok('AFS years come back with the schedule and what was done about them',
         Array.isArray(b.afs) && b.afs[0].year_end && 'settled' in b.afs[0]);
      ok('a year with statements on file is settled',
         b.afs.some(a => a.financial_year === 2025 && a.settled));
      ok('a missing company is a 404, not an empty summary',
         (await get(port, '/api/pe/company/nope/summary')).status === 404);
      ok('a company with no statements says so rather than reading as healthy',
         (await get(port, '/api/pe/company/peco-chk3/summary')).body.assessment.verdict === 'unknown');
      /* And the console must render that as "nothing to assess", not as the
         normal layout with every metric showing a dash and a closing line
         reading "Nothing flagged on the figures filed". */
      ok('and the console draws that case as its own thing',
         /if \(a\.verdict === 'unknown' \|\| !fy\) \{[\s\S]{0,900}Nothing to assess/.test(UI),
         'a grid of em-dashes reads as though somebody looked and found nothing wrong');
    }

    console.log('\nthe AFS chase list empties as work is done');
    {
      const before = (await get(port, '/api/pe/afs-due')).body.due;
      const chk2 = before.filter(d => d.company_id === 'peco-chk2');
      ok('a company with an overdue year appears', chk2.length > 0, JSON.stringify(before.map(d => d.company_id)));
      ok('a year with statements on file never appears',
         !chk2.some(d => d.financial_year === 2025 || d.financial_year === 2024),
         JSON.stringify(chk2.map(d => d.financial_year)));

      const year = chk2[0].financial_year;
      await pool.query(
        `INSERT INTO pe_afs_requests (id,company_id,financial_year,status) VALUES ($1,'peco-chk2',$2,'received')`,
        ['peafs-chk', year]);
      const after = (await get(port, '/api/pe/afs-due')).body.due;
      ok('marking a year received removes it from the chase list',
         !after.some(d => d.company_id === 'peco-chk2' && d.financial_year === year),
         'a reminder that keeps firing is a reminder people learn to ignore');

      await req(port, 'POST', '/api/pe/company/peco-chk2/archive', { reason: 'duplicate' });
      ok('an archived client drops out of the chase list entirely',
         !(await get(port, '/api/pe/afs-due')).body.due.some(d => d.company_id === 'peco-chk2'));
      await req(port, 'POST', '/api/pe/company/peco-chk2/unarchive', {});
      ok('and comes back when restored',
         (await get(port, '/api/pe/afs-due')).body.due.some(d => d.company_id === 'peco-chk2'));
      const row = (await pool.query(`SELECT archived, archived_at FROM pe_companies WHERE id='peco-chk2'`)).rows[0];
      ok('restoring clears the archive stamp as well as the flag',
         row.archived === false && row.archived_at === null);
    }

    console.log('\ndeleting a client cannot quietly take its history');
    {
      const r = await req(port, 'DELETE', '/api/pe/company/peco-chk2', {});
      ok('a company with records refuses to delete', r.status === 409, String(r.status));
      ok('and names exactly what would be destroyed',
         r.body.attached && r.body.attached.financials === 2, JSON.stringify(r.body.attached));
      ok('and points at archiving instead', r.body.suggestion === 'archive');
      ok('the company is still there afterwards',
         (await pool.query(`SELECT 1 FROM pe_companies WHERE id='peco-chk2'`)).rowCount === 1);

      const empty = await req(port, 'DELETE', '/api/pe/company/peco-chk3', {});
      ok('a company with nothing attached deletes', empty.status === 200, JSON.stringify(empty.body));

      const forced = await req(port, 'DELETE', '/api/pe/company/peco-chk2', { force: 'true' });
      ok('force deletes, and only when asked for explicitly', forced.status === 200);
      ok('its financials went with it',
         (await pool.query(`SELECT 1 FROM pe_financials WHERE company_id='peco-chk2'`)).rowCount === 0);
    }

    /* ═══ 6. Xero import ═══ */
    console.log('\nthe Xero export imports once, however many times it is uploaded');
    {
      const CSV =
        '*ContactName,*InvoiceNumber,Reference,*InvoiceDate,*DueDate,Total,Amount Paid,Amount Due,Status,Currency\n' +
        '"Checkable Holdings, Pty Ltd",INV-0101,MGT JUL,01/07/2025,31/07/2025,"46,000.00","46,000.00",0.00,PAID,ZAR\n' +
        '"Checkable Holdings",INV-0102,MGT AUG,01/08/2025,31/08/2025,"46,000.00",0.00,"46,000.00",AUTHORISED,ZAR\n' +
        '"Checkable Holdings",,BAD,01/09/2025,30/09/2025,"46,000.00",0.00,0.00,DRAFT,ZAR\n';

      const dry = await postForm(port, '/api/pe/xero-invoices',
        { company_id: 'peco-chk', dry_run: 'true' },
        { field: 'file', name: 'invoices.csv', type: 'text/csv', data: CSV });
      ok('a dry run parses without writing', dry.status === 200 && dry.body.dry_run === true);
      ok('two invoices read, the row with no number skipped',
         dry.body.parsed_count === 2 && dry.body.skipped.length === 1,
         JSON.stringify([dry.body.parsed_count, dry.body.skipped]));
      ok('a comma inside a quoted contact name does not split the row',
         dry.body.preview[0].contact === 'Checkable Holdings, Pty Ltd',
         'splitting on commas gets every export with a comma in a name wrong, quietly');
      ok('dd/mm/yyyy is read as day-month, not month-day',
         dry.body.preview[0].invoice_date === '2025-07-01', dry.body.preview[0].invoice_date);
      ok('thousands separators are stripped from the total',
         near(dry.body.preview[0].gross_amount, 46000), String(dry.body.preview[0].gross_amount));
      ok('PAID becomes paid and AUTHORISED becomes invoiced',
         dry.body.preview[0].status === 'paid' && dry.body.preview[1].status === 'invoiced');
      ok('SVC share is computed on import', near(dry.body.preview[0].svc_share_amount, 23460));
      ok('nothing was written by the dry run',
         (await pool.query(`SELECT 1 FROM pe_fees WHERE company_id='peco-chk'`)).rowCount === 0);

      const first = await postForm(port, '/api/pe/xero-invoices', { company_id: 'peco-chk' },
        { field: 'file', name: 'invoices.csv', type: 'text/csv', data: CSV });
      ok('the real import inserts', first.body.inserted === 2 && first.body.updated === 0);
      ok('and reports the lifetime revenue it produced',
         near(first.body.lifetime_revenue.invoiced_gross, 92000) &&
         near(first.body.lifetime_revenue.invoiced_svc, 46920));

      const second = await postForm(port, '/api/pe/xero-invoices', { company_id: 'peco-chk' },
        { field: 'file', name: 'invoices.csv', type: 'text/csv', data: CSV });
      ok('re-uploading the same export UPDATES rather than duplicating',
         second.body.inserted === 0 && second.body.updated === 2,
         'an operator will re-upload; doubled revenue is worse than none');
      ok('and the lifetime total does not move',
         near(second.body.lifetime_revenue.invoiced_gross, 92000),
         String(second.body.lifetime_revenue.invoiced_gross));
      ok('the rows are marked as coming from Xero',
         (await pool.query(`SELECT 1 FROM pe_fees WHERE company_id='peco-chk' AND source='xero'`)).rowCount === 2);

      const noNum = await postForm(port, '/api/pe/xero-invoices', { company_id: 'peco-chk' },
        { field: 'file', name: 'x.csv', type: 'text/csv', data: 'Foo,Bar\n1,2\n' });
      ok('an export with no invoice number column is refused with what it saw',
         noNum.status === 400 && Array.isArray(noNum.body.headers_seen),
         JSON.stringify(noNum.body).slice(0, 160));
      const xlsx = await postForm(port, '/api/pe/xero-invoices', { company_id: 'peco-chk' },
        { field: 'file', name: 'invoices.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: 'PK' });
      ok('an .xlsx is refused with the instruction to export CSV, not a parse error',
         xlsx.status === 400 && /CSV/.test(xlsx.body.error), JSON.stringify(xlsx.body).slice(0, 160));
    }

    /* ═══ 7. Documents ═══ */
    console.log('\nspreadsheets can be attached, and filed under what they are');
    {
      const up = await postForm(port, '/api/pe/documents/upload',
        { company_id: 'peco-chk', doc_type: 'working_spreadsheet', label: 'August working pack' },
        { field: 'document', name: 'working.xlsx',
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: 'PK\x03\x04fake' });
      ok('an .xlsx uploads', up.status === 200 && up.body.ok === true, JSON.stringify(up.body).slice(0, 200));
      ok('under the kind it was filed as', up.body.doc_type === 'working_spreadsheet');

      const csv = await postForm(port, '/api/pe/documents/upload',
        { company_id: 'peco-chk', doc_type: 'xero_invoice' },
        { field: 'document', name: 'invoices.csv', type: 'application/vnd.ms-excel', data: 'a,b\n1,2' });
      ok('a .csv that Excel labels as ms-excel still uploads', csv.status === 200,
         'browsers are unreliable about Office mimetypes');

      const exe = await postForm(port, '/api/pe/documents/upload',
        { company_id: 'peco-chk' },
        { field: 'document', name: 'thing.exe', type: 'application/octet-stream', data: 'MZ' });
      ok('an unrecognised type with no telling extension is refused',
         exe.status === 400, String(exe.status));
      ok('with a 400 and an explanation, not a 500 and a stack',
         /Accepted: PDF, Word, Excel or CSV/.test(exe.body.error || ''),
         JSON.stringify(exe.body).slice(0, 200));

      /* An attachment on an update belongs to the update AND the company. */
      await pool.query(`INSERT INTO pe_updates (id,company_id,title,body,update_date)
                        VALUES ('peupd-chk','peco-chk','t','b',CURRENT_DATE)`);
      const att = await postForm(port, '/api/pe/documents/upload',
        { company_id: 'peco-chk', update_id: 'peupd-chk', doc_type: 'update' },
        { field: 'document', name: 'pack.csv', type: 'text/csv', data: 'x' });
      ok('an update attachment uploads', att.status === 200);
      const byUpdate = await get(port, '/api/pe/documents/list?update_id=peupd-chk');
      ok('and lists under the update', byUpdate.body.docs.length === 1);
      const byCompany = await get(port, '/api/pe/documents/list?company_id=peco-chk');
      ok('and still under the company, so the documents tab shows it',
         byCompany.body.docs.some(d => d.update_id === 'peupd-chk'),
         'filed against only the update it would vanish from the company tab');
    }

    /* ═══ 8. The console's copy of the arithmetic ═══ */
    console.log('\nthe console and the server agree, to the cent');
    {
      try { ui = liftUi(); } catch (e) { ok('the console arithmetic could be lifted', false, e.message); }
      if (ui) {
        ok('the console arithmetic is runnable', typeof ui.feeForPeriod === 'function');

        ok('EBITDA agrees on the derived case',
           near(ui.ebitdaOf(ACME_FIN), F.computeEbitda(ACME_FIN).value) &&
           near(ui.ebitdaOf(ACME_FIN), ACME_EBITDA),
           `console ${ui.ebitdaOf(ACME_FIN)} vs server ${F.computeEbitda(ACME_FIN).value}`);
        ok('EBITDA agrees on the stated case',
           ui.ebitdaOf({ ebitda: 1234, net_profit: 1 }) === F.computeEbitda({ ebitda: 1234, net_profit: 1 }).value);
        ok('EBITDA agrees on the loss case',
           near(ui.ebitdaOf(STRAIN_2025), F.computeEbitda(STRAIN_2025).value));

        const server = F.feeSchedule(AGREEMENT, { years: 5 });
        const mismatch = server.rows.filter(r => {
          const c = ui.feeForPeriod(AGREEMENT, r.period_start);
          return !c || !near(c.gross_annual, r.gross_annual) || !near(c.svc_annual, r.svc_share);
        });
        ok('the fee schedule agrees for every contract year',
           mismatch.length === 0,
           JSON.stringify(mismatch.map(r => [r.contract_year, r.gross_annual,
             ui.feeForPeriod(AGREEMENT, r.period_start)])));

        ok('lifetime revenue agrees',
           JSON.stringify(ui.lifetimeRevenue([
             { status: 'paid', gross_amount: 46000 }, { status: 'projected', gross_amount: 46000 },
           ], AGREEMENT).invoiced_svc) === JSON.stringify(F.lifetimeRevenue([
             { status: 'paid', gross_amount: 46000 }, { status: 'projected', gross_amount: 46000 },
           ], AGREEMENT).invoiced_svc));

        ok('the AFS schedule agrees',
           ui.afsScheduleFor({ financial_year_end_month: 2 }, 2026).year_end ===
           F.afsSchedule({ financial_year_end_month: 2 }, 2026).year_end);

        console.log('\n  and the console reads a DATE the way the API returns one');
        /* pe_companies.contract_start_date is a DATE; through the JSON table
           API it arrives as a full ISO timestamp. Code that appends
           'T00:00:00Z' to that produces an Invalid Date and falls back to
           contract year 1 — so the fee reads as the un-escalated base and
           looks entirely plausible. */
        const asTimestamp = { ...AGREEMENT, contract_start_date: '2024-03-01T00:00:00.000Z' };
        ok('the ISO-timestamp form of a DATE is normalised',
           ui.dateOnly('2024-03-01T00:00:00.000Z') === '2024-03-01' &&
           ui.dateOnly('2024-03-01') === '2024-03-01');
        ok('and the contract year is the same either way',
           ui.contractYearOn(asTimestamp, '2026-09-07') === ui.contractYearOn(AGREEMENT, '2026-09-07'),
           `${ui.contractYearOn(asTimestamp, '2026-09-07')} vs ${ui.contractYearOn(AGREEMENT, '2026-09-07')}`);
        ok('which for a 2024-03-01 start on 2026-09-07 is year 3',
           ui.contractYearOn(AGREEMENT, '2026-09-07') === 3,
           String(ui.contractYearOn(AGREEMENT, '2026-09-07')));
        ok('the day before an anniversary is still the previous year',
           ui.contractYearOn(AGREEMENT, '2025-02-28') === 1 &&
           ui.contractYearOn(AGREEMENT, '2025-03-01') === 2);
        ok('a date before the contract starts is year 1, not year zero',
           ui.contractYearOn(AGREEMENT, '2023-01-01') === 1,
           'an invoice dated early must not escalate backwards');
        ok('the escalated fee follows the contract year',
           near(ui.feeForPeriod(asTimestamp, '2026-09-07').gross_annual, 686940),
           String(ui.feeForPeriod(asTimestamp, '2026-09-07').gross_annual));

        ok('a percentage box round-trips through the decimal column',
           ui.pctToDecimal('7') === 0.07 && ui.decimalToPct(0.07) === '7',
           'a stored 0.07 rendered as 7.000000000000001 is what binary floats do');
        ok('an empty percentage stays null, not zero',
           ui.pctToDecimal('') === null,
           '0% and "not agreed yet" are different facts');
      }
    }

    /* ═══ 9. The console, structurally ═══ */
    console.log('\nthe console files things where the operator put them');
    {
      ok('a DATE is normalised before it reaches an <input type=date>',
         /el\.type === 'date' \? dateOnly\(record\[k\]\)/.test(UI_CODE),
         'an ISO timestamp in a date input renders EMPTY and saves back as null');
      ok('one field list feeds both the populate and the save',
         /function readForm\(/.test(UI_CODE) && /function fillForm\(/.test(UI_CODE) &&
         (UI_CODE.match(/const COMPANY_FIELDS = \[/g) || []).length === 1,
         'two hand-written copies is how a field takes typing and discards it');
      ok('the document kind is carried from the picker, not hard-coded to AFS',
         /fd\.append\('doc_type', \(extra && extra\.doc_type\) \|\| item\.doc_type \|\| 'AFS'\)/.test(UI_CODE),
         "it was hard-coded, so a signed agreement filed itself under 'AFS'");
      ok('the document owner is looked up, not guessed by a ternary',
         /DOC_OWNER_PARAM/.test(UI_CODE) && !/type === 'company' \? `company_id/.test(UI_CODE));
      ok('emptying a queue does not rebind it away from the registry',
         !/_(company|deal|update|bee)DocQueue = \[\];/.test(UI_CODE),
         'a fresh [] leaves remove and relabel pointed at an orphan');
      ok('the pipeline board draws from STAGE_ORDER, not a second list',
         /activeCols = STAGE_ORDER\.filter/.test(UI_CODE),
         'the two lists had already drifted once');
      ok('the three new stages are in STAGE_ORDER, in funnel order',
         (() => {
           const m = UI.match(/const STAGE_ORDER = \[([^\]]*)\]/);
           if (!m) return false;
           const arr = m[1].split(',').map(s => s.trim().replace(/'/g, ''));
           return arr.indexOf('intro_meeting') > arr.indexOf('sourcing') &&
                  arr.indexOf('drafting')      > arr.indexOf('due_diligence') &&
                  arr.indexOf('active')        > arr.indexOf('approved') &&
                  arr.indexOf('active')        < arr.indexOf('closed');
         })(), 'a stage in the wrong slot puts a later step before an earlier one');
      ok('every stage has a label, a colour and a one-line explanation',
         (() => {
           const arr = UI.match(/const STAGE_ORDER = \[([^\]]*)\]/)[1]
             .split(',').map(s => s.trim().replace(/'/g, ''));
           return arr.every(s => UI.includes(`  ${s}:`) &&
             new RegExp(`STAGE_HINT = \\{[\\s\\S]*?\\b${s}:`).test(UI));
         })());
      ok('archived clients are filtered through one function, not per list',
         /function activeCompanies\(/.test(UI_CODE) &&
         !/let companies = _companies;/.test(UI_CODE));
      ok('but a lookup by id still finds an archived company',
         /function companyById\([\s\S]{0,120}_companies\.find/.test(UI_CODE),
         'its panel still has to open');
      ok('updates order by the date they happened, not the date they were typed',
         /sort\(\(a, b\) => new Date\(updateDate\(b\)\) - new Date\(updateDate\(a\)\)\)/.test(UI_CODE),
         'an update typed today about last month jumped the queue');
      ok('a slow position load cannot land under the wrong company',
         /if \(_openCompanyId !== id\) return;/.test(UI_CODE));
      ok('reloading drops the cached summaries',
         /_summaryCache = \{\};/.test(UI_CODE),
         "last load's red flags against this load's figures");
      ok('EBITDA in the panel goes through the shared helper, not the raw column',
         /fmtR\(ebitdaOf\(latest\)\)/.test(UI_CODE) && !/fmtR\(latest\.ebitda\)/.test(UI_CODE));
      ok('a negative rand renders as -R, not R-',
         /\(v < 0 \? '-R' : 'R'\)/.test(UI_CODE));
    }

    console.log('\nthe forms ask for what the agreement says');
    {
      const need = ['fee_amount','fee_basis','fee_escalation_pct_display','svc_share_pct_display',
                    'holding_pct_display','invoice_terms_days','invoice_payable_note',
                    'fee_escalation_note','partnership_name','contract_start_date','contract_end_date',
                    'address_line1','address_line2','address_province','address_postal_code',
                    'financial_year_end_month'];
      const missing = need.filter(n => !new RegExp(`name="${n}"`).test(HTML));
      ok('the company form has every contract, address and reporting field',
         missing.length === 0, missing.join(', '));
      /* The plain fields appear quoted in COMPANY_FIELDS; the three percentage
         columns appear as unquoted object keys in COMPANY_PCT_FIELDS, mapped
         to their _display box. Either shape counts as "the save reads it". */
      const reads = n => {
        const col = n.replace('_display', '');
        return UI.includes(`'${col}'`) || new RegExp(`\\b${col}:\\s*'${col}_display'`).test(UI);
      };
      ok('and the save reads every one of them',
         need.every(reads), need.filter(n => !reads(n)).join(', '));

      const dealNeed = ['contact_name','contact_role','contact_email','contact_phone',
                        'website','registration_number','prospect_fee','prospect_fee_basis','holding_pct_display'];
      ok('the deal form has the contact person, website and prospect fee',
         dealNeed.every(n => new RegExp(`name="${n}"`).test(HTML)),
         dealNeed.filter(n => !new RegExp(`name="${n}"`).test(HTML)).join(', '));

      ok('the financials form asks for the four EBITDA add-backs',
         ['tax_expense','finance_cost','depreciation','amortisation']
           .every(n => new RegExp(`name="${n}"`).test(HTML)));
      ok('and the two current-balance subtotals the liquidity test needs',
         ['current_assets','current_liabilities'].every(n => new RegExp(`name="${n}"`).test(HTML)));
      ok('the financial year is a dropdown, not a free integer',
         /<select name="financial_year"/.test(HTML) &&
         !/<input name="financial_year"/.test(HTML),
         'typing it produced 202 and 20255 in a UNIQUE column');
      ok('a year already captured is disabled rather than hidden',
         /already captured/.test(UI),
         'a silent absence reads as "not allowed" rather than "already done"');
      ok('an update carries a date of its own',
         /name="update_date"/.test(HTML) && /update_date: f\.elements\['update_date'\]/.test(UI));
      ok('and can carry attachments',
         /id="update-doc-input"/.test(HTML) && /function queueUpdateDoc/.test(UI));
      ok('there is a meeting-note form and a BEE form',
         /id="meeting-form"/.test(HTML) && /id="bee-form"/.test(HTML));
      ok('and a Xero import that previews before it writes',
         /id="xero-modal"/.test(HTML) && /function previewXeroImport/.test(UI) &&
         /dry_run/.test(UI));
      ok('the file pickers accept spreadsheets',
         (HTML.match(/accept="[^"]*\.xlsx[^"]*"/g) || []).length >= 3,
         'the picker used to accept them and the server rejected them after upload');
      ok('and every multi-file picker asks what kind of document it is',
         /id="company-doc-type"/.test(HTML) && /id="deal-doc-type"/.test(HTML),
         "without one, queueDoc falls back to 'AFS' and a financial model " +
         'files itself under Annual Financial Statements');
      ok('the partnership name offers SAS SVC Partnership',
         /SAS SVC Partnership/.test(HTML));
      ok('the panel has a position, compliance and meetings tab',
         ['position','compliance','meetings'].every(t =>
           new RegExp(`data-tab="${t}"`).test(HTML) && new RegExp(`id="cp-${t}"`).test(HTML)));
    }

    console.log('\nFMCG is a sector everywhere a sector is offered');
    {
      ok('in both forms', (HTML.match(/<option>FMCG<\/option>/g) || []).length === 2,
         String((HTML.match(/<option>FMCG<\/option>/g) || []).length));
      ok('and in both AI extraction prompts',
         (EXTRACT.match(/Retail, FMCG, Manufacturing/g) || []).length === 2);
    }

    console.log('\nthe schema carries what the console now stores');
    {
      const cols = async (table, names) => {
        const { rows } = await pool.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name = ANY($2)`,
          [table, names]);
        return names.filter(n => !rows.some(r => r.column_name === n));
      };
      let m = await cols('pe_companies', ['contract_start_date','contract_end_date','fee_amount','fee_basis',
        'fee_escalation_pct','fee_escalation_note','invoice_terms_days','invoice_payable_note',
        'svc_share_pct','holding_pct','partnership_name','address_line1','address_line2',
        'address_province','address_postal_code','financial_year_end_month','archived','archived_at']);
      ok('pe_companies has the contract, address and archive columns', m.length === 0, m.join(', '));

      m = await cols('pe_financials', ['tax_expense','finance_cost','depreciation','amortisation',
        'current_assets','current_liabilities']);
      ok('pe_financials has the add-backs and the current subtotals', m.length === 0, m.join(', '));

      m = await cols('pe_fees', ['gross_amount','svc_share_pct','svc_share_amount','source','xero_invoice_id']);
      ok('pe_fees carries the gross, the share and where it came from', m.length === 0, m.join(', '));

      m = await cols('pe_deals', ['contact_name','contact_role','contact_email','contact_phone',
        'website','registration_number','prospect_fee','holding_pct']);
      ok('pe_deals carries the contact person and the prospect fee', m.length === 0, m.join(', '));

      m = await cols('pe_updates', ['update_date']);
      ok('pe_updates carries the date it happened', m.length === 0);

      m = await cols('pe_documents', ['update_id','bee_id','financial_year','uploaded_by']);
      ok('pe_documents can hang off an update or a BEE year', m.length === 0, m.join(', '));

      const { rows: t } = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1)`,
        [['pe_meeting_notes','pe_bee_verifications','pe_afs_requests','pe_documents']]);
      ok('the four new tables exist', t.length === 4,
         JSON.stringify(t.map(x => x.table_name)));
      ok('pe_documents is declared by the schema build, not only by its route',
         /CREATE TABLE IF NOT EXISTS pe_documents/.test(SETUP),
         'an ALTER against a table that is not there aborts the whole DO block, ' +
         'rolling back every other column silently');

      const { rows: c } = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='pe_deals_stage_check'`);
      const def = (c[0] || {}).def || '';
      ok('the stage constraint accepts the three new stages',
         ['intro_meeting','drafting','active'].every(s => def.includes(`'${s}'`)), def);
      ok('and still accepts every stage that was already there',
         ['sourcing','screening','due_diligence','ic_review','approved','closed','declined','exited']
           .every(s => def.includes(`'${s}'`)),
         'dropping one orphans the deals sitting on it');

      ok('the new tables are writable through the generic table API',
         ['pe_meeting_notes','pe_bee_verifications','pe_afs_requests']
           .every(t2 => fs.readFileSync(path.join(ROOT, 'server', 'routes', 'tables.js'), 'utf8')
             .includes(`${t2}:`)));
      ok('the insights route is mounted',
         /app\.use\('\/api\/pe',\s*require\('\.\/routes\/pe-insights'\)\)/.test(INDEX));

      /* Existing rows must not be left behind by the migration. */
      const { rows: back } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE update_date IS NULL) AS n FROM pe_updates`);
      ok('existing updates were backfilled with a date', Number(back[0].n) === 0);
    }

    console.log('\nand the front end is cache-busted past what is deployed');
    {
      const js  = HTML.match(/js\/pe-monitor\.js\?v=(\d+)/);
      const css = HTML.match(/css\/pe-monitor\.css\?v=(\d+)/);
      ok('pe-monitor.js is past v=11', js && Number(js[1]) > 11, js ? js[0] : 'no version');
      ok('pe-monitor.css is versioned at all', !!css,
         'it was unversioned, so a stylesheet change could serve stale');
      ok('the new styles are actually in the stylesheet',
         ['verdict-banner','metric-tile','flag-critical','ebitda-preview','fee-preview',
          'meeting-item','attachment-chip','pill-archived','afs-row','mini-table']
           .every(c => CSS.includes('.' + c)));
      ok('the panel tab strip wraps rather than hiding tabs off-screen',
         /\.panel-tabs \{ flex-wrap: wrap; overflow-x: visible;/.test(CSS),
         '661px of tabs in a 479px panel scrolled, and nobody looks for that');
      ok('the one canonical purple is the only purple added',
         !/#(?!eda5ff)[0-9a-f]{0,2}(a|e)[0-9a-f]{3,5}\b/i.test(
           CSS.slice(CSS.indexOf('Contract terms, financial position'))
              .match(/#[0-9a-f]{6}/gi)?.filter(h => /^#e|^#a/i.test(h)).join(' ') || ''),
         'CLAUDE.md: #eda5ff and no other purple');
      ok('spreadsheet mimetypes are accepted server-side',
         /spreadsheetml\.sheet/.test(DOCS) && /text\/csv/.test(DOCS) &&
         /ALLOWED_EXT/.test(DOCS),
         'extension as well as mimetype — browsers are unreliable on Office formats');
    }

  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    if (srv) srv.close();
    if (pool) await pool.end().catch(() => {});
    try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
