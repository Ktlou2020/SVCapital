'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   The monthly director report, computed once.

   Both the emailed report and the Director Panel dashboard read this. They
   used to be two sets of queries, which is two answers to "what was AUM in
   September" that nothing keeps in step.

   Three decisions are load-bearing, and each is a thing that has already gone
   wrong somewhere on this platform:

   MONTH BOUNDARIES ARE SAST.  date_trunc runs in the DATABASE's timezone,
   which is UTC and was never set. A transaction at 01:30 on 1 October in
   Johannesburg is 23:30 on 30 September in UTC, so a UTC month boundary files
   it under the wrong month — and a month-end report is read precisely at the
   boundary. Same fault the pool cycler had.

   AUM IS PRINCIPAL LIVE AT AN INSTANT.  An investment is in AUM from its
   start_date until it matures. Returns are NOT in AUM: a return is earned on
   the principal, not added to it, and the cash reaches the wallet at maturity.
   This matters for the waterfall below.

   THE WATERFALL RECONCILES, OR IT SAYS SO.  Opening + inflows − outflows must
   equal closing exactly. It is computed from the same definition at two
   instants, with the movements derived from the same table, so it ties by
   construction — but a row can always be edited by hand in a way no rule
   predicts, so the residual is computed and reported rather than absorbed. A
   bridge that silently plugs its own gap is worse than no bridge.

   "Returns paid out" is reported beside the bridge and never inside it. It is
   real money leaving the business, but it never was AUM, so subtracting it
   from AUM would make the bridge wrong by exactly that amount.
   ═══════════════════════════════════════════════════════════════════════════ */

const pool = require('../db/pool');
const { incomeTypesSQL } = require('./ledger');

const BUSINESS_TZ = 'Africa/Johannesburg';

/* An investment is in AUM at instant $n when it had started and had not yet
   left. maturity_processed_at is when the maturity job actually handled it;
   rows matured before that column existed fall back to end_date, and a row
   still marked active has not left however old its end_date is — that is a
   maturity the cron has not run yet, not money that has gone. */
const LIVE_AT = n => `
  i.start_date IS NOT NULL
  AND i.start_date <= $${n}::date
  AND (
    i.status = 'active'
    OR COALESCE(i.maturity_processed_at::date, i.payout_date::date, i.end_date) > $${n}::date
  )`;

const num = v => Number(v || 0);
/* node-pg hands DATE and TIMESTAMPTZ back as JS Date objects, which stringify
   as "Thu Oct 01 2026 …". Every date leaving this service is normalised to
   YYYY-MM-DD here, once, so no consumer has to guess the shape. */
const isoDate = d => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const t = new Date(d);
  return isNaN(t) ? null : t.toISOString().slice(0, 10);
};
const pct = (a, b) => (b ? (a / b) * 100 : null);

/* The month being reported, and the one before it, as SAST dates.
   `month` is 'YYYY-MM'; absent, it is the month that has just ended. */
async function monthWindow(month) {
  const { rows: [r] } = await pool.query(
    `SELECT
       CASE WHEN $1::text IS NULL
            THEN date_trunc('month', (now() AT TIME ZONE $2) - INTERVAL '1 month')::date
            ELSE ($1 || '-01')::date END                        AS start,
       CASE WHEN $1::text IS NULL
            THEN date_trunc('month', (now() AT TIME ZONE $2))::date
            ELSE (($1 || '-01')::date + INTERVAL '1 month')::date END AS next`,
    [month || null, BUSINESS_TZ]);
  const iso = d => new Date(d).toISOString().slice(0, 10);
  return {
    start: iso(r.start),
    next:  iso(r.next),                       /* exclusive — the 1st of the next month */
    prevStart: iso(new Date(new Date(r.start).setMonth(new Date(r.start).getMonth() - 1))),
    label: new Date(r.start).toLocaleString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

/* ─── AUM ──────────────────────────────────────────────────────────────── */

async function aumAt(dateISO) {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(SUM(i.amount),0) AS aum, COUNT(*)::int AS n
       FROM investments i WHERE ${LIVE_AT(1)}`, [dateISO]);
  return { aum: num(r.aum), count: r.n };
}

/* The bridge. Every figure comes from investments, so the two ends and the
   movements between them cannot be measuring different things. */
async function aumMovement(w) {
  /* Opening is the instant BEFORE the month starts. */
  const dayBefore = new Date(w.start); dayBefore.setDate(dayBefore.getDate() - 1);
  const opening = await aumAt(dayBefore.toISOString().slice(0, 10));
  const closing = await aumAt(new Date(new Date(w.next).getTime() - 86400000).toISOString().slice(0, 10));

  /* In: investments that started during the month, split by where the money
     came from. A reinvestment transaction means the capital rolled out of a
     maturing investment rather than arriving from outside. */
  const { rows: [inflow] } = await pool.query(
    `SELECT
       COALESCE(SUM(i.amount) FILTER (WHERE t.id IS NULL), 0) AS new_capital,
       COALESCE(SUM(i.amount) FILTER (WHERE t.id IS NOT NULL), 0) AS reinvested,
       COUNT(*) FILTER (WHERE t.id IS NULL)::int     AS new_count,
       COUNT(*) FILTER (WHERE t.id IS NOT NULL)::int AS reinvested_count
     FROM investments i
     LEFT JOIN LATERAL (
       SELECT 1 AS id FROM transactions t2
        WHERE t2.investment_id = i.id AND t2.type = 'reinvestment' AND t2.status = 'completed'
        LIMIT 1) t ON true
    WHERE i.start_date >= $1::date AND i.start_date < $2::date`,
    [w.start, w.next]);

  /* Out: investments that left AUM during the month, split by whether the
     capital went back to the investor or straight into a new investment.
     The rolled-over half is the same money as the reinvested figure above —
     it appears on both sides and nets to nothing, which is what a rollover is.

     The status test COALESCEs to '', not to 'active'. Two traps, one line.
     A bare negation is NULL for a NULL status, not true, so the row drops out.
     But defaulting to 'active' makes it read as still live — which also drops
     it, and silently, because it looks guarded. LIVE_AT treats a NULL status
     as NOT active: the equality is not true, so the date decides. This side
     has to agree, or an investment sits in the opening balance, leaves the
     closing one, and appears in neither movement — and the bridge stops tying
     with nothing on screen to say why. */
  const { rows: [outflow] } = await pool.query(
    `SELECT
       COALESCE(SUM(i.amount) FILTER (WHERE i.maturity_instruction = 'reinvest'
                                        OR i.maturity_instruction IS NULL AND r.id IS NOT NULL), 0) AS rolled_over,
       COALESCE(SUM(i.amount) FILTER (WHERE NOT (i.maturity_instruction = 'reinvest'
                                        OR i.maturity_instruction IS NULL AND r.id IS NOT NULL)), 0) AS returned,
       COUNT(*)::int AS matured_count
     FROM investments i
     LEFT JOIN LATERAL (
       SELECT 1 AS id FROM transactions t2
        WHERE t2.investment_id = i.id AND t2.type = 'matured_funds' AND t2.status = 'completed'
        LIMIT 1) r ON true
    WHERE COALESCE(i.status, '') <> 'active'
      AND COALESCE(i.maturity_processed_at::date, i.payout_date::date, i.end_date) >= $1::date
      AND COALESCE(i.maturity_processed_at::date, i.payout_date::date, i.end_date) <  $2::date`,
    [w.start, w.next]);

  const inNew   = num(inflow.new_capital);
  const inRe    = num(inflow.reinvested);
  const outRoll = num(outflow.rolled_over);
  const outPaid = num(outflow.returned);

  const expected = opening.aum + inNew + inRe - outRoll - outPaid;
  /* Anything the five lines above do not explain. Hand-edited rows, a status
     changed outside the maturity job, an investment back-dated into a closed
     month. Shown, never hidden. */
  const residual = closing.aum - expected;

  return {
    opening: opening.aum, openingCount: opening.count,
    newCapital: inNew, newCount: inflow.new_count,
    reinvested: inRe,   reinvestedCount: inflow.reinvested_count,
    rolledOut: outRoll, returnedToInvestors: outPaid, maturedCount: outflow.matured_count,
    residual,
    closing: closing.aum, closingCount: closing.count,
    reconciles: Math.abs(residual) < 0.01,
  };
}

/* A rolling window ending with the reported month. Each point is AUM on the
   last day of that month, measured the same way as everything above. */
async function aumTrend(w, months = 6) {
  const out = [];
  for (let back = months - 1; back >= 0; back--) {
    const d = new Date(w.next);
    d.setMonth(d.getMonth() - back);
    const last = new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
    const { aum, count } = await aumAt(last);
    out.push({
      month: last.slice(0, 7),
      label: new Date(last).toLocaleString('en-ZA', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
      aum, investments: count,
    });
  }
  for (let i = 1; i < out.length; i++) {
    out[i].changePct = pct(out[i].aum - out[i - 1].aum, out[i - 1].aum);
  }
  return out;
}

/* AUM by product, with the product's own label and colour so the dashboard
   and the PDF cannot invent their own names for things. */
async function aumByProduct(w) {
  const closeDay = new Date(new Date(w.next).getTime() - 86400000).toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(i.product_type,''), 'unknown') AS product_type,
            COALESCE(p.label, INITCAP(REPLACE(COALESCE(NULLIF(i.product_type,''),'unknown'),'_',' '))) AS label,
            COALESCE(p.color, '#656565') AS color,
            SUM(i.amount) AS aum, COUNT(*)::int AS investments,
            COUNT(DISTINCT i.investor_id)::int AS investors
       FROM investments i
       LEFT JOIN products p ON p.product_type = i.product_type
      WHERE ${LIVE_AT(1)}
      GROUP BY 1,2,3 ORDER BY aum DESC`, [closeDay]);
  const total = rows.reduce((s, r) => s + num(r.aum), 0);
  return rows.map(r => ({
    productType: r.product_type, label: r.label, color: r.color,
    aum: num(r.aum), investments: r.investments, investors: r.investors,
    sharePct: pct(num(r.aum), total),
  }));
}

/* The pools carrying the money, largest first, with the date each matures —
   which is the pool's close date plus its term, and is what a director is
   actually asking when they ask "when does this come back". */
async function topPools(w, limit = 5) {
  const closeDay = new Date(new Date(w.next).getTime() - 86400000).toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT ip.id, ip.name, ip.product_type, ip.status, ip.annual_rate, ip.actual_rate,
            ip.end_date AS close_date, ip.term_months,
            COALESCE(ip.investment_start_date, ip.end_date + 1) AS investment_start,
            (COALESCE(ip.investment_start_date, ip.end_date + 1)
               + (COALESCE(ip.term_months,0) || ' months')::interval)::date AS maturity_date,
            COALESCE(p.label, ip.product_type) AS product_label,
            SUM(i.amount) AS aum, COUNT(*)::int AS investments,
            COUNT(DISTINCT i.investor_id)::int AS investors
       FROM investments i
       JOIN investment_pools ip ON ip.id = i.pool_id
       LEFT JOIN products p ON p.product_type = ip.product_type
      WHERE ${LIVE_AT(1)}
      GROUP BY ip.id, ip.name, ip.product_type, ip.status, ip.annual_rate, ip.actual_rate,
               ip.end_date, ip.term_months, ip.investment_start_date, p.label
      ORDER BY aum DESC LIMIT $2`, [closeDay, limit]);
  return rows.map(r => ({
    id: r.id, name: r.name, productType: r.product_type, productLabel: r.product_label,
    status: r.status, closeDate: isoDate(r.close_date), maturityDate: isoDate(r.maturity_date),
    termMonths: r.term_months, annualRate: num(r.annual_rate), actualRate: num(r.actual_rate),
    aum: num(r.aum), investments: r.investments, investors: r.investors,
  }));
}

/* ─── Investors ────────────────────────────────────────────────────────── */

/* "Active investor" means someone whose money is actually in a pool at the
   close of the month — not someone with a row marked active, which includes
   everyone who ever signed up and never invested. Growth measured on the
   second definition flatters itself every time somebody registers. */
async function investorStats(w) {
  const closeDay = new Date(new Date(w.next).getTime() - 86400000).toISOString().slice(0, 10);
  const prevClose = new Date(new Date(w.start).getTime() - 86400000).toISOString().slice(0, 10);

  const invested = async d => {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(DISTINCT i.investor_id)::int AS n, COALESCE(SUM(i.amount),0) AS aum
         FROM investments i WHERE ${LIVE_AT(1)}`, [d]);
    return { count: r.n, aum: num(r.aum) };
  };
  const now  = await invested(closeDay);
  const prev = await invested(prevClose);

  const { rows: [reg] } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE date_joined >= $1::date AND date_joined < $2::date)::int AS joined,
            COUNT(*) FILTER (WHERE COALESCE(status,'active') = 'active')::int AS registered
       FROM investors WHERE archived_at IS NULL`, [w.start, w.next]);

  /* Concentration. The top ten investors' share of AUM is the figure that
     says how much of the book walks out if a handful of people leave. */
  const { rows: top } = await pool.query(
    `SELECT i.investor_id, v.first_name, v.last_name, SUM(i.amount) AS aum
       FROM investments i LEFT JOIN investors v ON v.id = i.investor_id
      WHERE ${LIVE_AT(1)}
      GROUP BY i.investor_id, v.first_name, v.last_name
      ORDER BY aum DESC LIMIT 10`, [closeDay]);
  const top10 = top.reduce((s, r) => s + num(r.aum), 0);

  return {
    activeInvestors: now.count,
    previousActiveInvestors: prev.count,
    growth: now.count - prev.count,
    growthPct: pct(now.count - prev.count, prev.count),
    joinedThisMonth: reg.joined,
    registeredInvestors: reg.registered,
    /* AUM per investor, not per investment — "average investment size" asked
       as AUM over investors is the average HOLDING. Both are given, because
       they differ whenever one person holds several investments. */
    avgHoldingPerInvestor: now.count ? now.aum / now.count : 0,
    avgInvestmentSize: await avgTicket(closeDay),
    top10SharePct: pct(top10, now.aum),
    top10Aum: top10,
    topInvestors: top.map((r, idx) => ({
      rank: idx + 1,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.investor_id,
      aum: num(r.aum), sharePct: pct(num(r.aum), now.aum),
    })),
  };
}

async function avgTicket(d) {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(AVG(i.amount),0) AS avg FROM investments i WHERE ${LIVE_AT(1)}`, [d]);
  return num(r.avg);
}

/* Withdrawals in the month: how many, by how many people, and how much.
   Only `completed` — a pending withdrawal is a request, not money gone. */
async function withdrawalStats(w) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n, COUNT(DISTINCT investor_id)::int AS people,
            COALESCE(SUM(amount),0) AS total
       FROM transactions
      WHERE type = 'withdrawal' AND status = 'completed'
        AND COALESCE(transaction_date, created_at) >= $1::date
        AND COALESCE(transaction_date, created_at) <  $2::date`, [w.start, w.next]);
  const { rows: [pend] } = await pool.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total
       FROM transactions WHERE type = 'withdrawal' AND status = 'pending'`);
  return {
    count: r.n, investors: r.people, total: num(r.total),
    avg: r.n ? num(r.total) / r.n : 0,
    pendingCount: pend.n, pendingTotal: num(pend.total),
  };
}

/* KYC and FICA. Two different things that get spoken of as one: kyc_status on
   the investor is the manual review, fica_checks is the automated ID and bank
   verification. Reported separately because they disagree, and the gap is the
   point. */
async function complianceStats() {
  const { rows: kyc } = await pool.query(
    `SELECT COALESCE(NULLIF(kyc_status,''),'pending') AS status, COUNT(*)::int AS n
       FROM investors WHERE archived_at IS NULL AND COALESCE(status,'active') = 'active'
      GROUP BY 1 ORDER BY n DESC`);
  const { rows: fica } = await pool.query(
    `SELECT COALESCE(NULLIF(f.overall_status,''),'pending') AS status, COUNT(DISTINCT f.investor_id)::int AS n
       FROM fica_checks f GROUP BY 1 ORDER BY n DESC`);
  const { rows: [docs] } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int  AS pending,
            COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
            COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
       FROM kyc_documents`);
  const total = kyc.reduce((s, r) => s + r.n, 0);
  const verified = kyc.filter(r => /verified|approved/i.test(r.status)).reduce((s, r) => s + r.n, 0);
  return {
    kycByStatus: kyc, ficaByStatus: fica, documents: docs,
    investorsCounted: total, verified, verifiedPct: pct(verified, total),
  };
}

/* Where the money comes from, and roughly who from. Province is on the
   investor; age comes from date_of_birth, which is free text on this table,
   so anything that is not a date simply does not land in a band rather than
   throwing the whole report. */
async function demographics(w) {
  const closeDay = new Date(new Date(w.next).getTime() - 86400000).toISOString().slice(0, 10);
  const { rows: provinces } = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(v.province),''), 'Not given') AS province,
            COUNT(DISTINCT i.investor_id)::int AS investors, SUM(i.amount) AS aum
       FROM investments i JOIN investors v ON v.id = i.investor_id
      WHERE ${LIVE_AT(1)} GROUP BY 1 ORDER BY aum DESC`, [closeDay]);
  const { rows: ages } = await pool.query(
    `WITH live AS (
       SELECT DISTINCT i.investor_id, v.date_of_birth FROM investments i
         JOIN investors v ON v.id = i.investor_id WHERE ${LIVE_AT(1)}),
     aged AS (
       SELECT CASE WHEN date_of_birth ~ '^\\d{4}-\\d{2}-\\d{2}'
                   THEN date_part('year', age((date_of_birth)::date)) END AS yrs
         FROM live)
     SELECT CASE WHEN yrs IS NULL THEN 'Not given'
                 WHEN yrs < 25 THEN 'Under 25' WHEN yrs < 35 THEN '25-34'
                 WHEN yrs < 45 THEN '35-44'    WHEN yrs < 55 THEN '45-54'
                 WHEN yrs < 65 THEN '55-64'    ELSE '65+' END AS band,
            COUNT(*)::int AS investors
       FROM aged GROUP BY 1 ORDER BY 1`, [closeDay]);
  const totalAum = provinces.reduce((s, r) => s + num(r.aum), 0);
  return {
    provinces: provinces.map(r => ({ province: r.province, investors: r.investors,
      aum: num(r.aum), sharePct: pct(num(r.aum), totalAum) })),
    ageBands: ages,
  };
}

/* ─── Returns ──────────────────────────────────────────────────────────── */

/* What investors did with money that matured: rolled it over, or took it.
   Measured on the capital, because a rate quoted on headcount says something
   different from a rate quoted on rands and the rands is what matters. */
async function reinvestmentRate(w) {
  const { rows: [r] } = await pool.query(
    `SELECT
       COALESCE(SUM(i.amount) FILTER (WHERE roll.id IS NOT NULL), 0) AS reinvested,
       COALESCE(SUM(i.amount) FILTER (WHERE roll.id IS NULL), 0)     AS paid_out,
       COUNT(*) FILTER (WHERE roll.id IS NOT NULL)::int AS reinvested_count,
       COUNT(*) FILTER (WHERE roll.id IS NULL)::int     AS paid_out_count
     FROM investments i
     LEFT JOIN LATERAL (
       SELECT 1 AS id FROM transactions t
        WHERE t.investment_id = i.id AND t.type = 'matured_funds' AND t.status = 'completed'
        LIMIT 1) roll ON true
    WHERE COALESCE(i.status, '') <> 'active'
      AND COALESCE(i.maturity_processed_at::date, i.payout_date::date, i.end_date) >= $1::date
      AND COALESCE(i.maturity_processed_at::date, i.payout_date::date, i.end_date) <  $2::date`,
    [w.start, w.next]);
  const re = num(r.reinvested), out = num(r.paid_out), total = re + out;
  return {
    reinvested: re, paidOut: out, total,
    reinvestedPct: pct(re, total), paidOutPct: pct(out, total),
    reinvestedCount: r.reinvested_count, paidOutCount: r.paid_out_count,
  };
}

/* Income in the month, and the realised return on what matured in it.
   Reported side by side and never added: ledger.js is explicit that a
   maturity whose return was also accrued monthly appears in both, so adding
   them declares the same money twice. */
async function returnsStats(w) {
  const { rows: [accrued] } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
      WHERE type IN (${incomeTypesSQL()}) AND status = 'completed'
        AND COALESCE(transaction_date, created_at) >= $1::date
        AND COALESCE(transaction_date, created_at) <  $2::date`, [w.start, w.next]);
  const { rows: realised } = await pool.query(
    `SELECT COALESCE(NULLIF(i.product_type,''),'unknown') AS product_type,
            COALESCE(p.label, INITCAP(REPLACE(COALESCE(NULLIF(i.product_type,''),'unknown'),'_',' '))) AS label,
            COALESCE(SUM(i.actual_return),0) AS realised,
            COALESCE(SUM(i.amount),0) AS capital, COUNT(*)::int AS matured
       FROM investments i LEFT JOIN products p ON p.product_type = i.product_type
      WHERE COALESCE(i.status, '') <> 'active'
        AND COALESCE(i.maturity_processed_at::date, i.payout_date::date, i.end_date) >= $1::date
        AND COALESCE(i.maturity_processed_at::date, i.payout_date::date, i.end_date) <  $2::date
      GROUP BY 1,2 ORDER BY realised DESC`, [w.start, w.next]);
  return {
    accruedThisMonth: num(accrued.total),
    realisedOnMaturity: realised.reduce((s, r) => s + num(r.realised), 0),
    byProduct: realised.map(r => ({
      productType: r.product_type, label: r.label,
      realised: num(r.realised), capital: num(r.capital), matured: r.matured,
      /* The return actually delivered on the capital that matured, which is
         the only honest per-product performance figure available here. */
      realisedPct: pct(num(r.realised), num(r.capital)),
    })),
  };
}

/* Six months of realised return by product, so a director can see whether a
   product is trending up or down rather than reading one month in isolation. */
async function returnsTrend(w, months = 6) {
  const { rows } = await pool.query(
    `SELECT to_char(COALESCE(i.maturity_processed_at::date, i.payout_date::date, i.end_date), 'YYYY-MM') AS month,
            COALESCE(NULLIF(i.product_type,''),'unknown') AS product_type,
            COALESCE(p.label, INITCAP(REPLACE(COALESCE(NULLIF(i.product_type,''),'unknown'),'_',' '))) AS label,
            COALESCE(SUM(i.actual_return),0) AS realised, COALESCE(SUM(i.amount),0) AS capital
       FROM investments i LEFT JOIN products p ON p.product_type = i.product_type
      WHERE COALESCE(i.status, '') <> 'active'
        AND COALESCE(i.maturity_processed_at::date, i.payout_date::date, i.end_date) >= ($1::date - ($3::int - 1) * INTERVAL '1 month')
        AND COALESCE(i.maturity_processed_at::date, i.payout_date::date, i.end_date) <  $2::date
      GROUP BY 1,2,3 ORDER BY 1`, [w.start, w.next, months]);
  return rows.map(r => ({
    month: r.month, productType: r.product_type, label: r.label,
    realised: num(r.realised), capital: num(r.capital),
    realisedPct: pct(num(r.realised), num(r.capital)),
  }));
}

/* ─── The underlying assets ────────────────────────────────────────────── */

/* Cattle. Head under management, what was sold in the month and at what
   price, and the direction the realised price per head is moving.

   There is no market beef index on this platform, so "price trend" here is
   OUR OWN realised selling price per head, cycle by cycle. That is a real
   trend and it is the one that feeds returns — but it is a lagging figure
   from completed sales, not a forward market quote, and it is labelled as
   such rather than dressed up as a market view. */
async function cattleStats(w) {
  const { rows: [herd] } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE COALESCE(sold,false) = false
                               AND COALESCE(mortality,false) = false
                               AND COALESCE(status,'active') = 'active')::int AS under_management,
            COUNT(*) FILTER (WHERE COALESCE(sold,false))::int      AS sold_all_time,
            COUNT(*) FILTER (WHERE COALESCE(mortality,false))::int AS mortalities_all_time,
            COUNT(*)::int AS head_ever
       FROM cattle_animals`);

  const { rows: [soldMonth] } = await pool.query(
    `SELECT COUNT(*)::int AS head, COALESCE(SUM(sale_value),0) AS value,
            COALESCE(AVG(NULLIF(sale_value,0)),0) AS avg_price
       FROM cattle_animals
      WHERE COALESCE(sold,false) AND sale_date >= $1::date AND sale_date < $2::date`,
    [w.start, w.next]);

  const { rows: [mortMonth] } = await pool.query(
    `SELECT COUNT(*)::int AS head FROM cattle_animals
      WHERE COALESCE(mortality,false) AND mortality_date >= $1::date AND mortality_date < $2::date`,
    [w.start, w.next]);

  /* Realised price per head across the last completed cycles — the trend. */
  const { rows: cycles } = await pool.query(
    `SELECT batch_name, cycle_no, sale_date, no_sold, no_purchased, mortalities,
            selling_price_per_head, avg_cattle_cost, total_selling_price,
            purchase_value, net_return_pct, status
       FROM cattle_cycles
      WHERE sale_date IS NOT NULL AND sale_date < $1::date
      ORDER BY sale_date DESC LIMIT 6`, [w.next]);
  const trend = cycles.slice().reverse().map(c => ({
    batch: c.batch_name, cycleNo: c.cycle_no, saleDate: isoDate(c.sale_date),
    headSold: c.no_sold, pricePerHead: num(c.selling_price_per_head),
    costPerHead: num(c.avg_cattle_cost), netReturnPct: num(c.net_return_pct) ,
    marginPerHead: num(c.selling_price_per_head) - num(c.avg_cattle_cost),
  }));
  const latest = trend[trend.length - 1], prior = trend[trend.length - 2];
  return {
    underManagement: herd.under_management,
    soldAllTime: herd.sold_all_time, mortalitiesAllTime: herd.mortalities_all_time,
    soldThisMonth: soldMonth.head, soldValueThisMonth: num(soldMonth.value),
    avgSalePriceThisMonth: num(soldMonth.avg_price),
    mortalitiesThisMonth: mortMonth.head,
    pricePerHeadTrend: trend,
    latestPricePerHead: latest ? latest.pricePerHead : null,
    pricePerHeadChangePct: latest && prior ? pct(latest.pricePerHead - prior.pricePerHead, prior.pricePerHead) : null,
    /* Said plainly on the report rather than left for somebody to assume. */
    priceBasis: 'Realised selling price per head from completed SV Capital cycles. Not a market beef index — no external price feed is connected.',
  };
}

/* Solar. Capacity and capital are ours; generation comes from the inverters
   through the FoxESS cloud, so it can be unavailable without that meaning
   anything is wrong with the fleet. Absent is reported as absent. */
async function solarStats() {
  const { rows: [fleet] } = await pool.query(
    `SELECT COUNT(*)::int AS projects,
            COUNT(*) FILTER (WHERE COALESCE(status,'active') = 'active')::int AS active,
            COALESCE(SUM(capacity_kw),0)      AS capacity_kw,
            COALESCE(SUM(capital_deployed),0) AS capital_deployed,
            COALESCE(SUM(actual_return),0)    AS actual_return
       FROM solar_projects`);
  const { rows: sites } = await pool.query(
    `SELECT id, project_name, location, capacity_kw, status, capital_deployed,
            annual_rate, maturity_date, foxess_device_sn
       FROM solar_projects WHERE COALESCE(status,'active') = 'active'
      ORDER BY capacity_kw DESC NULLS LAST LIMIT 10`);

  /* getSolarStats walks every device on the account and sums them. It throws
     without an API key and can time out, and neither is a reason to fail a
     report whose other fourteen sections are fine — so it is caught and the
     absence is reported as an absence rather than as a zero. A zero would
     read as "the fleet generated nothing", which is a different claim. */
  let generation = null, generationError = null;
  try {
    const foxess = require('./foxess');
    const g = await foxess.getSolarStats();
    if (g) generation = {
      todayKwh: num(g.today_kwh), monthKwh: num(g.month_kwh),
      totalKwh: num(g.total_kwh), currentKw: num(g.current_power_kw ?? g.power_kw),
      devices: g.devices ?? g.device_count ?? null, station: g.station_name ?? null,
    };
  } catch (e) { generationError = e.message; }

  return {
    projects: fleet.projects, activeProjects: fleet.active,
    capacityKw: num(fleet.capacity_kw),
    capitalDeployed: num(fleet.capital_deployed),
    actualReturn: num(fleet.actual_return),
    sites: sites.map(s => ({
      id: s.id, name: s.project_name, location: s.location,
      capacityKw: num(s.capacity_kw), status: s.status,
      capitalDeployed: num(s.capital_deployed), annualRate: num(s.annual_rate),
      maturityDate: isoDate(s.maturity_date), metered: !!s.foxess_device_sn,
    })),
    generation,
    generationNote: generation ? null
      : `Generation comes from the inverter cloud and was not available when this report was built${generationError ? ` (${generationError})` : ''}. This is not a reading of zero.`,
  };
}

/* Short term. The deals the money was lent into, and what came back. */
async function shortTermStats(w) {
  const { rows: [book] } = await pool.query(
    `SELECT COUNT(*)::int AS deals,
            COUNT(*) FILTER (WHERE COALESCE(status,'active') = 'active')::int AS open_deals,
            COALESCE(SUM(amount_disbursed) FILTER (WHERE COALESCE(status,'active') = 'active'),0) AS outstanding,
            COALESCE(SUM(interest_amount),0) AS interest_all_time
       FROM shortterm_loans`);
  const { rows: [month] } = await pool.query(
    `SELECT COUNT(*)::int AS funded, COALESCE(SUM(amount_disbursed),0) AS disbursed,
            COALESCE(AVG(NULLIF(interest_rate,0)),0) AS avg_rate
       FROM shortterm_loans
      WHERE disbursement_date >= $1::date AND disbursement_date < $2::date`, [w.start, w.next]);
  const { rows: [repaid] } = await pool.query(
    `SELECT COUNT(*)::int AS deals, COALESCE(SUM(total_repayable),0) AS repaid
       FROM shortterm_loans
      WHERE actual_repayment_date >= $1::date AND actual_repayment_date < $2::date`, [w.start, w.next]);
  const { rows: [overdue] } = await pool.query(
    `SELECT COUNT(*)::int AS deals, COALESCE(SUM(total_repayable - COALESCE(partial_repayments,0)),0) AS amount
       FROM shortterm_loans
      WHERE COALESCE(status,'active') = 'active' AND repayment_date < $1::date`, [w.next]);
  return {
    deals: book.deals, openDeals: book.open_deals,
    outstanding: num(book.outstanding), interestAllTime: num(book.interest_all_time),
    fundedThisMonth: month.funded, disbursedThisMonth: num(month.disbursed),
    avgRateThisMonth: num(month.avg_rate),
    repaidDeals: repaid.deals, repaidAmount: num(repaid.repaid),
    overdueDeals: overdue.deals, overdueAmount: num(overdue.amount),
  };
}

/* ─── The whole thing ──────────────────────────────────────────────────── */

async function buildReport(month) {
  const w = await monthWindow(month);
  const [movement, trend, byProduct, pools, investors, withdrawals,
         compliance, demo, reinvest, returns, retTrend,
         cattle, solar, shortTerm] = await Promise.all([
    aumMovement(w), aumTrend(w, 6), aumByProduct(w), topPools(w, 5),
    investorStats(w), withdrawalStats(w), complianceStats(), demographics(w),
    reinvestmentRate(w), returnsStats(w), returnsTrend(w, 6),
    cattleStats(w), solarStats(), shortTermStats(w),
  ]);

  const prev = trend.length > 1 ? trend[trend.length - 2].aum : movement.opening;
  return {
    generatedAt: new Date().toISOString(),
    month: w.start.slice(0, 7), monthLabel: w.label,
    periodStart: w.start, periodEnd: w.next,
    aum: {
      closing: movement.closing, opening: movement.opening,
      changePct: pct(movement.closing - prev, prev),
      change: movement.closing - prev,
      movement, trend, byProduct,
    },
    pools,
    investors: { ...investors, withdrawals, compliance, demographics: demo },
    returns: { ...returns, reinvestment: reinvest, trend: retTrend },
    underlying: { cattle, solar, shortTerm },
  };
}

module.exports = {
  monthWindow, aumAt, aumMovement, aumTrend, aumByProduct, topPools,
  investorStats, withdrawalStats, complianceStats, demographics,
  reinvestmentRate, returnsStats, returnsTrend,
  cattleStats, solarStats, shortTermStats, buildReport,
  LIVE_AT, BUSINESS_TZ, num, pct, isoDate,
};
