'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   PE Monitor — the arithmetic, in one place.

   EBITDA, the financial-position read, the fee schedule and the AFS due date
   are each needed by a route, by the console and by the check suite. Anything
   computed in more than one of those drifts, and a fee that reads one number
   on the client card and another on the invoice is not a cosmetic defect.

   Every function here is pure: numbers in, numbers out, no pool, no clock
   except where a date is passed in. That is what makes it checkable.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Postgres NUMERIC comes back as a string, forms come back as strings, and a
   blank input is ''. null means "not on file" and must stay distinguishable
   from 0 — a company with no debt and a company whose debt we have not been
   given are different companies. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[\s,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const round2 = n => (n === null ? null : Math.round(n * 100) / 100);

/* ── EBITDA ────────────────────────────────────────────────────────────────
   Earnings Before Interest, Tax, Depreciation and Amortisation. Many sets of
   annual financial statements never state it — it is not an IFRS line item —
   so it has to be rebuilt from the income statement by ADDING BACK the four
   things the name says are excluded:

       EBITDA = net profit + tax + finance cost + depreciation + amortisation

   The add-back direction is the whole point and is easy to get backwards.
   Net profit is already after tax, after interest and after depreciation; you
   are walking back UP the income statement to operating earnings, so each of
   those comes back on. Subtracting them instead would deduct the same costs a
   second time and understate EBITDA badly on any geared or asset-heavy
   company — exactly the companies where the number matters most.

   Returns the components as well as the total. A derived figure that cannot
   be audited on screen is a figure nobody should act on. */
function computeEbitda(fin) {
  const f = fin || {};
  const stated = num(f.ebitda);
  if (stated !== null) {
    return { value: round2(stated), source: 'stated', components: null, complete: true, missing: [] };
  }

  const parts = [
    ['net_profit',   num(f.net_profit),   'Net profit'],
    ['tax_expense',  num(f.tax_expense),  'Tax'],
    ['finance_cost', num(f.finance_cost), 'Finance cost'],
    ['depreciation', num(f.depreciation), 'Depreciation'],
    ['amortisation', num(f.amortisation), 'Amortisation'],
  ];

  /* Net profit is the base. Without it there is nothing to add back to, and a
     total built from the add-backs alone would be a meaningless number wearing
     the EBITDA label. */
  if (num(f.net_profit) === null) {
    return {
      value: null, source: 'derived', complete: false,
      components: parts.map(([key, value, label]) => ({ key, label, value })),
      missing: ['net_profit'],
    };
  }

  /* Amortisation is genuinely absent from many small-company AFS and is
     usually nil there; the others being absent is worth saying out loud,
     because each one missing makes the answer too low. */
  const missing = parts
    .filter(([key, value]) => value === null && key !== 'amortisation' && key !== 'net_profit')
    .map(([key]) => key);

  const value = parts.reduce((sum, [, v]) => sum + (v || 0), 0);
  return {
    value: round2(value),
    source: 'derived',
    complete: missing.length === 0,
    components: parts.map(([key, v, label]) => ({ key, label, value: v })),
    missing,
  };
}

/* EBITDA for a row whichever way it came — the number the rest of the app
   should use. */
function ebitdaOf(fin) {
  return computeEbitda(fin).value;
}

/* ── Financial position and red flags ─────────────────────────────────────
   Deterministic, from the statements on file. Nothing here is a judgement
   call dressed as a number: each flag names the figures it fired on so the
   reader can disagree with it.

   Levels: 'critical' — act now; 'warning' — ask the question; 'info' —
   context, not a problem. */
const GEARING_WARN = 3;      // net debt / EBITDA
const GEARING_CRIT = 4;
const COVER_WARN   = 2;      // EBITDA / finance cost
const COVER_CRIT   = 1;
const CURRENT_WARN = 1;      // current assets / current liabilities

function assessFinancials(fin, prior) {
  const f = fin || {};
  const flags   = [];
  const metrics = {};
  const add = (level, code, title, detail) => flags.push({ level, code, title, detail });

  const assets      = num(f.total_assets);
  const liabilities = num(f.total_liabilities);
  const equityOnFile = num(f.equity);
  const cash        = num(f.cash);
  const debt        = num(f.total_debt);
  const revenue     = num(f.revenue);
  const netProfit   = num(f.net_profit);
  const opCash      = num(f.operating_cashflow);
  const finCost     = num(f.finance_cost);
  const curAssets   = num(f.current_assets);
  const curLiabs    = num(f.current_liabilities);
  const eb          = computeEbitda(f);

  /* Equity as stated, else assets less liabilities. A company can file one and
     not the other. */
  const equity = equityOnFile !== null ? equityOnFile
               : (assets !== null && liabilities !== null ? assets - liabilities : null);

  metrics.ebitda        = eb.value;
  metrics.ebitda_source = eb.source;
  metrics.equity        = round2(equity);
  metrics.net_debt      = (debt !== null) ? round2(debt - (cash || 0)) : null;

  /* ── Balance-sheet insolvency ── liabilities exceed assets. In South African
     law this is one of the two solvency tests directors are on the hook for,
     so it is reported as critical rather than as a ratio. */
  if (equity !== null && equity < 0) {
    add('critical', 'balance_sheet_insolvent', 'Balance-sheet insolvent',
        `Liabilities exceed assets — equity is ${fmtR(equity)}. The company is technically insolvent on the figures filed.`);
  } else if (equity !== null && assets !== null && assets > 0 && equity / assets < 0.1) {
    add('warning', 'thin_equity', 'Very thin equity buffer',
        `Equity of ${fmtR(equity)} is under 10% of ${fmtR(assets)} total assets — little room before insolvency.`);
  }

  /* ── Liquidity ── the second solvency test: can it pay what falls due in the
     next twelve months. */
  if (curAssets !== null && curLiabs !== null && curLiabs > 0) {
    const ratio = curAssets / curLiabs;
    metrics.current_ratio = Math.round(ratio * 100) / 100;
    if (ratio < CURRENT_WARN) {
      add('critical', 'illiquid', 'Current liabilities exceed current assets',
          `Current ratio ${metrics.current_ratio.toFixed(2)} — ${fmtR(curLiabs)} falls due within a year against ${fmtR(curAssets)} of current assets.`);
    } else if (ratio < 1.2) {
      add('warning', 'tight_liquidity', 'Tight liquidity',
          `Current ratio ${metrics.current_ratio.toFixed(2)} — little headroom on short-term obligations.`);
    }
  }

  /* ── Gearing ── debt measured against the earnings that service it. Net of
     cash, because cash on hand can retire debt. */
  if (eb.value !== null && eb.value > 0 && metrics.net_debt !== null) {
    const gearing = metrics.net_debt / eb.value;
    metrics.net_debt_to_ebitda = Math.round(gearing * 100) / 100;
    if (gearing >= GEARING_CRIT) {
      add('critical', 'excessive_debt', 'Excessive debt',
          `Net debt is ${metrics.net_debt_to_ebitda.toFixed(2)}× EBITDA (${fmtR(metrics.net_debt)} against ${fmtR(eb.value)}). Above ${GEARING_CRIT}× is generally beyond what lenders will refinance.`);
    } else if (gearing >= GEARING_WARN) {
      add('warning', 'high_debt', 'High debt load',
          `Net debt is ${metrics.net_debt_to_ebitda.toFixed(2)}× EBITDA — above the ${GEARING_WARN}× mark.`);
    }
  } else if (eb.value !== null && eb.value <= 0 && (debt || 0) > 0) {
    add('critical', 'debt_no_earnings', 'Debt with no earnings to service it',
        `${fmtR(debt)} of debt against EBITDA of ${fmtR(eb.value)}.`);
  }

  /* ── Interest cover ── */
  if (eb.value !== null && finCost !== null && finCost > 0) {
    const cover = eb.value / finCost;
    metrics.interest_cover = Math.round(cover * 100) / 100;
    if (cover < COVER_CRIT) {
      add('critical', 'cannot_cover_interest', 'Earnings do not cover interest',
          `EBITDA of ${fmtR(eb.value)} against ${fmtR(finCost)} of finance cost — cover of ${metrics.interest_cover.toFixed(2)}×.`);
    } else if (cover < COVER_WARN) {
      add('warning', 'thin_interest_cover', 'Thin interest cover',
          `EBITDA covers finance cost only ${metrics.interest_cover.toFixed(2)}× — under ${COVER_WARN}×.`);
    }
  }

  /* ── Earnings and cash ── */
  if (netProfit !== null && netProfit < 0) {
    add('warning', 'loss_making', 'Loss-making year',
        `Net loss of ${fmtR(Math.abs(netProfit))} for the year.`);
  }
  if (opCash !== null && opCash < 0) {
    add('critical', 'cash_burn', 'Operations consumed cash',
        `Operating cash flow of ${fmtR(opCash)} — the business funded itself from something other than trading.`);
  }
  if (eb.value !== null && eb.value < 0) {
    add('critical', 'negative_ebitda', 'Negative EBITDA',
        `EBITDA of ${fmtR(eb.value)} — unprofitable before interest, tax and depreciation.`);
  }

  /* ── Margins and growth, against the prior year where we have one ── */
  if (revenue !== null && revenue > 0) {
    if (eb.value !== null) {
      metrics.ebitda_margin = Math.round((eb.value / revenue) * 10000) / 10000;
      if (metrics.ebitda_margin < 0.05 && eb.value > 0) {
        add('warning', 'thin_margin', 'Thin EBITDA margin',
            `${(metrics.ebitda_margin * 100).toFixed(1)}% of ${fmtR(revenue)} revenue.`);
      }
    }
    if (netProfit !== null) metrics.net_margin = Math.round((netProfit / revenue) * 10000) / 10000;
  }

  const priorRevenue = prior ? num(prior.revenue) : null;
  if (revenue !== null && priorRevenue !== null && priorRevenue > 0) {
    const growth = (revenue - priorRevenue) / priorRevenue;
    metrics.revenue_growth = Math.round(growth * 10000) / 10000;
    if (growth <= -0.20) {
      add('critical', 'revenue_collapse', 'Revenue fell sharply',
          `Down ${(Math.abs(growth) * 100).toFixed(1)}% on the prior year, ${fmtR(priorRevenue)} to ${fmtR(revenue)}.`);
    } else if (growth < 0) {
      add('warning', 'revenue_decline', 'Revenue declined',
          `Down ${(Math.abs(growth) * 100).toFixed(1)}% on the prior year.`);
    }
  }

  const priorEbitda = prior ? ebitdaOf(prior) : null;
  if (eb.value !== null && priorEbitda !== null && priorEbitda > 0 && eb.value < priorEbitda * 0.7) {
    add('warning', 'ebitda_decline', 'EBITDA down sharply',
        `${fmtR(priorEbitda)} to ${fmtR(eb.value)} year on year.`);
  }

  /* ── Provenance ── not a financial problem, but it changes how much weight
     any of the above carries. */
  if (f.audited === false || f.audited === 'false') {
    add('info', 'unaudited', 'Unaudited figures',
        'These statements are not marked as audited — treat the figures above as management accounts.');
  }
  if (eb.source === 'derived') {
    add('info', 'ebitda_derived', 'EBITDA was derived, not stated',
        eb.complete
          ? 'The AFS did not state EBITDA; it was rebuilt by adding tax, finance cost, depreciation and amortisation back to net profit.'
          : `The AFS did not state EBITDA and it was rebuilt from an incomplete income statement — missing ${eb.missing.join(', ')}, so the figure is understated.`);
  }

  const order = { critical: 0, warning: 1, info: 2 };
  flags.sort((a, b) => order[a.level] - order[b.level]);

  const criticals = flags.filter(x => x.level === 'critical').length;
  const warnings  = flags.filter(x => x.level === 'warning').length;
  const verdict = criticals ? 'critical' : warnings ? 'watch' : 'stable';

  return { verdict, flags, metrics, summary: summarise(f, metrics, verdict, criticals, warnings) };
}

function summarise(f, m, verdict, criticals, warnings) {
  const bits = [];
  const revenue = num(f.revenue);
  if (revenue !== null) bits.push(`Revenue ${fmtR(revenue)}`);
  if (m.ebitda !== null && m.ebitda !== undefined) {
    bits.push(`EBITDA ${fmtR(m.ebitda)}${m.ebitda_source === 'derived' ? ' (derived)' : ''}`);
  }
  if (m.ebitda_margin !== undefined) bits.push(`margin ${(m.ebitda_margin * 100).toFixed(1)}%`);
  if (m.equity !== null && m.equity !== undefined) bits.push(`equity ${fmtR(m.equity)}`);
  if (m.net_debt_to_ebitda !== undefined) bits.push(`net debt ${m.net_debt_to_ebitda.toFixed(2)}× EBITDA`);

  const head = bits.length ? bits.join(' · ') : 'Not enough on file to read a position.';
  const tail = verdict === 'critical'
    ? ` ${criticals} issue${criticals === 1 ? '' : 's'} needing attention.`
    : verdict === 'watch'
      ? ` ${warnings} thing${warnings === 1 ? '' : 's'} to watch.`
      : bits.length ? ' Nothing flagged on these figures.' : '';
  return head + tail;
}

function fmtR(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const s = Math.abs(v).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return (v < 0 ? '-R' : 'R') + s;
}

/* ── Fees ─────────────────────────────────────────────────────────────────
   The fund management agreement fixes a rand fee, not a percentage of AUM,
   escalating annually on the contract anniversary. SVC bills the whole fee
   and keeps its share of it — 51% under the partnership agreements, held per
   company because it is a term of that company's agreement, not a constant.

       gross for contract year N = base × (1 + escalation) ^ (N - 1)
       SVC share                 = gross × svc_share_pct
       partner share             = gross − SVC share

   Compounding, not simple: an escalation clause raises the fee that is
   actually being charged, and the following year raises that one again.

   A percentage-of-AUM company keeps working — fee_basis says which shape the
   agreement is, and the percentage path is the old behaviour untouched. */
function annualGrossFee(company) {
  const c = company || {};
  const basis = c.fee_basis || (num(c.fee_amount) !== null ? 'amount' : 'percentage');
  if (basis === 'amount') {
    const amt = num(c.fee_amount);
    return amt === null ? null : round2(amt);
  }
  const aum  = num(c.aum_amount);
  const rate = num(c.fee_rate);
  if (aum === null || rate === null) return null;
  return round2(aum * rate);
}

const PERIODS_PER_YEAR = { monthly: 12, quarterly: 4, annual: 1 };

/* One row per contract year. `from` is the contract start date — the
   anniversary the escalation clause runs off, which is why (b) had to become
   an explicit contract date rather than being inferred from entry_date. */
function feeSchedule(company, opts) {
  const c     = company || {};
  const years = Math.max(1, Math.min(30, (opts && opts.years) || 5));
  const base  = annualGrossFee(c);
  if (base === null) return { base: null, rows: [], svcSharePct: null, escalationPct: null };

  const esc   = num(c.fee_escalation_pct) || 0;
  const share = num(c.svc_share_pct);
  const svcPct = share === null ? 0.51 : share;
  const start = parseDate(c.contract_start_date || c.entry_date);
  const period = PERIODS_PER_YEAR[c.fee_billing_period] ? c.fee_billing_period : 'annual';
  const perYear = PERIODS_PER_YEAR[period];

  const rows = [];
  for (let n = 1; n <= years; n++) {
    const gross = round2(base * Math.pow(1 + esc, n - 1));
    const svc   = round2(gross * svcPct);
    rows.push({
      contract_year: n,
      period_start: start ? addYears(start, n - 1) : null,
      period_end:   start ? addDays(addYears(start, n), -1) : null,
      gross_annual: gross,
      svc_share:    svc,
      partner_share: round2(gross - svc),
      per_invoice:  round2(gross / perYear),
      svc_per_invoice: round2(svc / perYear),
      escalation_applied: n === 1 ? 0 : esc,
    });
  }
  return {
    base, rows, svcSharePct: svcPct, escalationPct: esc,
    billingPeriod: period, invoicesPerYear: perYear,
    basis: c.fee_basis || (num(c.fee_amount) !== null ? 'amount' : 'percentage'),
  };
}

/* SVC's cut of a fee row that already exists — an invoice raised, or one
   imported from Xero. Explicit share on the row wins over the company's. */
function svcShareOf(feeRow, company) {
  const gross = num(feeRow && (feeRow.gross_amount !== null && feeRow.gross_amount !== undefined
                                ? feeRow.gross_amount : feeRow.amount));
  if (gross === null) return null;
  const own = num(feeRow && feeRow.svc_share_pct);
  const co  = num(company && company.svc_share_pct);
  const pct = own !== null ? own : (co !== null ? co : 0.51);
  return round2(gross * pct);
}

/* Lifetime revenue from a client: what has actually been billed and what has
   actually been paid, gross and at SVC's share. Only rows that represent real
   invoices count — a 'projected' fee is a plan, not revenue, and a waived one
   is neither. */
function lifetimeRevenue(feeRows, company) {
  const rows = Array.isArray(feeRows) ? feeRows : [];
  const out = {
    invoiced_gross: 0, invoiced_svc: 0,
    paid_gross: 0, paid_svc: 0,
    outstanding_gross: 0, outstanding_svc: 0,
    invoice_count: 0, paid_count: 0, first_invoice: null, last_invoice: null,
  };
  for (const r of rows) {
    if (!['invoiced', 'paid', 'overdue'].includes(r.status)) continue;
    const gross = num(r.gross_amount !== null && r.gross_amount !== undefined ? r.gross_amount : r.amount);
    if (gross === null) continue;
    const svc = svcShareOf(r, company) || 0;
    out.invoiced_gross += gross;
    out.invoiced_svc   += svc;
    out.invoice_count  += 1;
    if (r.status === 'paid') { out.paid_gross += gross; out.paid_svc += svc; out.paid_count += 1; }
    else                     { out.outstanding_gross += gross; out.outstanding_svc += svc; }
    const d = r.invoice_date || r.period_start;
    if (d) {
      if (!out.first_invoice || d < out.first_invoice) out.first_invoice = d;
      if (!out.last_invoice  || d > out.last_invoice)  out.last_invoice  = d;
    }
  }
  for (const k of ['invoiced_gross','invoiced_svc','paid_gross','paid_svc','outstanding_gross','outstanding_svc']) {
    out[k] = round2(out[k]);
  }
  return out;
}

/* ── AFS ──────────────────────────────────────────────────────────────────
   Annual financial statements are requested three months after the financial
   year end. The Companies Act gives most companies six months to prepare
   them, so three months is when it is reasonable to ASK, not when they are
   late — which is why the reminder has both a due date and an overdue date. */
const AFS_REQUEST_MONTHS  = 3;
const AFS_OVERDUE_MONTHS  = 6;

function financialYearEnd(fyEndMonth, year) {
  const m = parseInt(fyEndMonth, 10);
  if (!Number.isFinite(m) || m < 1 || m > 12) return null;
  const y = parseInt(year, 10);
  if (!Number.isFinite(y)) return null;
  /* Last day of that month: day 0 of the next month. */
  return new Date(Date.UTC(y, m, 0));
}

function afsSchedule(company, year, today) {
  const fye = financialYearEnd(company && company.financial_year_end_month, year);
  if (!fye) return null;
  const now = today ? new Date(today) : new Date();
  const requestFrom = addMonths(fye, AFS_REQUEST_MONTHS);
  const overdueFrom = addMonths(fye, AFS_OVERDUE_MONTHS);
  return {
    financial_year: year,
    year_end:     iso(fye),
    request_from: iso(requestFrom),
    overdue_from: iso(overdueFrom),
    status: now >= overdueFrom ? 'overdue' : now >= requestFrom ? 'due' : 'not_yet',
    days_until_due: Math.ceil((requestFrom - now) / 86400000),
  };
}

/* The financial years a company can sensibly file, newest first — what the
   year dropdown is built from, rather than a free-typed integer that lands
   1900 or 20255 in the database. */
function financialYearOptions(company, today, back, forward) {
  const now = today ? new Date(today) : new Date();
  const m = parseInt(company && company.financial_year_end_month, 10);
  const yearNow = now.getUTCFullYear();
  /* If this year's year-end has not passed, the newest year that can have
     statements is last year. */
  let newest = yearNow;
  if (Number.isFinite(m) && m >= 1 && m <= 12) {
    const thisYearEnd = financialYearEnd(m, yearNow);
    if (thisYearEnd && now < thisYearEnd) newest = yearNow - 1;
  } else if (now.getUTCMonth() < 2) {
    newest = yearNow - 1;
  }
  const span = Number.isFinite(back) ? back : 10;
  const ahead = Number.isFinite(forward) ? forward : 1;
  const out = [];
  for (let y = newest + ahead; y >= newest - span; y--) out.push(y);
  return out;
}

/* ── date helpers ── UTC throughout: these are calendar dates off a contract,
   not instants, and a local-timezone Date rolls them a day either way. */
function parseDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v).length <= 10 ? String(v) + 'T00:00:00Z' : v);
  return isNaN(d.getTime()) ? null : d;
}
function addYears(d, n)  { const x = new Date(d.getTime()); x.setUTCFullYear(x.getUTCFullYear() + n); return iso(x); }
function addDays(v, n)   { const d = parseDate(v); if (!d) return null; d.setUTCDate(d.getUTCDate() + n); return iso(d); }
function addMonths(d, n) { const x = new Date(d.getTime()); x.setUTCMonth(x.getUTCMonth() + n); return x; }
function iso(d) { const x = d instanceof Date ? d : parseDate(d); return x ? x.toISOString().slice(0, 10) : null; }

/* Invoice due date from the terms in the agreement — "payable 30 days from
   invoice", and the console has to be able to say when that is. */
function invoiceDueDate(invoiceDate, company) {
  const d = parseDate(invoiceDate);
  if (!d) return null;
  const days = num(company && company.invoice_terms_days);
  return addDays(d, days === null ? 30 : days);
}

module.exports = {
  num, round2, fmtR,
  computeEbitda, ebitdaOf,
  assessFinancials,
  annualGrossFee, feeSchedule, svcShareOf, lifetimeRevenue,
  financialYearEnd, afsSchedule, financialYearOptions, invoiceDueDate,
  AFS_REQUEST_MONTHS, AFS_OVERDUE_MONTHS,
  GEARING_WARN, GEARING_CRIT, COVER_WARN, COVER_CRIT,
};
