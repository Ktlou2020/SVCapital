'use strict';
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const _admin = requireRole('admin', 'director', 'staff');

/* ── GET /api/analytics/kpis/period ─────────────────────────
   The same figures over a date range, against the range immediately before it.

   The distinction this endpoint exists to enforce: some of these are FLOWS and
   some are STOCKS, and mixing them is how a dashboard misleads.

     FLOWS   money or records that moved during a window. Net deposits,
             returns paid, platform revenue, new investors, new investments.
             A range scopes them; a prior-period comparison means something.

     STOCKS  what is true right now. Active capital, active investments,
             total investors. A date range does not scope them, and
             "Active Capital, last 30 days, up 12%" is not a fact about
             anything — so they are returned separately and labelled as of now.

   Boundaries are Johannesburg days: `from` starts at 00:00 SAST, `to` ends at
   24:00 SAST, so a range never half-includes a local day. The prior period is
   the same number of days ending the instant `from` begins — no gap, no
   overlap.
   ─────────────────────────────────────────────────────────── */
router.get('/kpis/period', requireAuth, _admin, async (req, res) => {
  try {
    const TZ = 'Africa/Johannesburg';
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    const days = Math.min(1826, Math.max(1, parseInt(req.query.days, 10) || 30));

    const explicit = isDate(req.query.from) && isDate(req.query.to);
    if ((req.query.from || req.query.to) && !explicit) {
      return res.status(400).json({ error: 'from and to must both be YYYY-MM-DD.' });
    }
    if (explicit && req.query.from > req.query.to) {
      return res.status(400).json({ error: 'from must not be after to.' });
    }

    /* A local date becomes an instant by anchoring it to the zone, so a day
       boundary is midnight in Johannesburg rather than in UTC. `to` is
       inclusive to the caller, hence +1 day and a half-open comparison. */
    const anchor = d => `((${d})::timestamp AT TIME ZONE '${TZ}')`;
    const today  = `((NOW() AT TIME ZONE '${TZ}')::date)`;

    const params = explicit ? [req.query.from, req.query.to] : [days];
    const F = explicit ? anchor('$1::date')       : anchor(`${today} - ($1::int - 1)`);
    const T = explicit ? anchor('$2::date + 1')   : anchor(`${today} + 1`);
    const SPAN = `(${T} - ${F})`;
    const PF   = `(${F} - ${SPAN})`;   // prior period: same length, ending
    const PT   = F;                    // exactly where this one begins

    const when = 'COALESCE(transaction_date, created_at)';
    /* Flows only: things that MOVED inside the window. */
    const flows = (a, b, prefix) => `
      COALESCE((SELECT SUM(CASE WHEN type = 'deposit' THEN ABS(amount) ELSE -ABS(amount) END)
                  FROM transactions
                 WHERE status = 'completed' AND type IN ('deposit','withdrawal')
                   AND ${when} >= ${a} AND ${when} < ${b}), 0)        AS ${prefix}_net_deposits,
      COALESCE((SELECT SUM(ABS(amount)) FROM transactions
                 WHERE status = 'completed' AND type IN ('return','payout')
                   AND ${when} >= ${a} AND ${when} < ${b}), 0)        AS ${prefix}_returns_paid,
      COALESCE((SELECT SUM(ABS(amount)) FROM transactions
                 WHERE status = 'completed' AND type IN ('fee','platform_fee')
                   AND ${when} >= ${a} AND ${when} < ${b}), 0)        AS ${prefix}_platform_revenue,
      (SELECT COUNT(*) FROM investors
        WHERE COALESCE(date_joined, created_at) >= ${a}
          AND COALESCE(date_joined, created_at) <  ${b})              AS ${prefix}_new_investors,
      (SELECT COUNT(*) FROM investments
        WHERE created_at >= ${a} AND created_at < ${b})               AS ${prefix}_new_investments`;

    const { rows: [r] } = await pool.query(`
      SELECT ${F} AS period_from, ${T} AS period_to,
             ${PF} AS prior_from, ${PT} AS prior_to,
             ${flows(F, T, 'cur')},
             ${flows(PF, PT, 'pri')},
             /* Stocks: true right now, deliberately untouched by the range. */
             COALESCE((SELECT SUM(ABS(amount)) FROM investments WHERE status = 'active'), 0)
                                                                      AS active_capital,
             (SELECT COUNT(*) FROM investments WHERE status = 'active') AS active_investments,
             (SELECT COUNT(*) FROM investors)                           AS total_investors
    `, params);

    const n = v => Number(v) || 0;
    const round2 = v => Math.round(n(v) * 100) / 100;
    const metric = key => {
      const current = round2(r[`cur_${key}`]);
      const prior   = round2(r[`pri_${key}`]);
      return {
        current, prior, change: round2(current - prior),
        /* No percentage against a zero base. "Up 100%" from nothing is not a
           rate of change, it is a first occurrence, and rendering it as growth
           is the most common way these dashboards flatter themselves. */
        change_pct: prior === 0 ? null : round2(((current - prior) / Math.abs(prior)) * 100),
      };
    };

    return res.json({
      range: {
        from: r.period_from, to: r.period_to,
        prior_from: r.prior_from, prior_to: r.prior_to,
        days: explicit ? null : days, explicit, timezone: TZ,
      },
      flows: {
        net_deposits:     metric('net_deposits'),
        returns_paid:     metric('returns_paid'),
        platform_revenue: metric('platform_revenue'),
        new_investors:    metric('new_investors'),
        new_investments:  metric('new_investments'),
      },
      stocks: {
        active_capital:     round2(r.active_capital),
        active_investments: n(r.active_investments),
        total_investors:    n(r.total_investors),
        note: 'As of now — a date range does not scope these.',
      },
      computed_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[analytics/kpis/period]', err);
    return res.status(500).json({ error: 'Failed to compute period KPIs: ' + err.message });
  }
});

/* ── GET /api/analytics/kpis ────────────────────────────────
   The six headline tiles, computed over EVERY row.

   They were summed in the browser from three lists fetched one page deep at
   5,000 rows, so past that they were quietly wrong — and "Total Investors"
   was the plainest case of all: it read the length of the fetched array, so a
   platform with more than 5,000 investors reported exactly 5,000.

   Same definitions as the client used, so the numbers do not move for anyone
   under the page limit — only for those over it, where they become correct:

     Total AUM         completed deposits less completed withdrawals, at 0
     Active Capital    amount of investments with status 'active'
     Total Investors   every investor row
     Returns YTD       completed return + payout since 1 Jan, Johannesburg
     Platform Revenue  completed fee transactions
     Active Investments count of them

   ABS() throughout because a fee is stored negative — the platform fee must
   read negative in a ledger, but it is revenue when totalled.
   ─────────────────────────────────────────────────────────── */
router.get('/kpis', requireAuth, _admin, async (req, res) => {
  try {
    const { rows: [k] } = await pool.query(`
      SELECT
        GREATEST(0, COALESCE((
          SELECT SUM(CASE WHEN type = 'deposit' THEN ABS(amount) ELSE -ABS(amount) END)
            FROM transactions
           WHERE status = 'completed' AND type IN ('deposit','withdrawal')), 0)) AS total_aum,

        COALESCE((SELECT SUM(ABS(amount)) FROM investments
                   WHERE status = 'active'), 0)                                  AS active_capital,

        (SELECT COUNT(*) FROM investors)                                         AS total_investors,

        COALESCE((
          SELECT SUM(ABS(amount)) FROM transactions
           WHERE status = 'completed' AND type IN ('return','payout')
             AND COALESCE(transaction_date, created_at)
                 >= DATE_TRUNC('year', NOW() AT TIME ZONE 'Africa/Johannesburg')
        ), 0)                                                                    AS returns_ytd,

        COALESCE((SELECT SUM(ABS(amount)) FROM transactions
                   WHERE status = 'completed' AND type IN ('fee','platform_fee')), 0)
                                                                                 AS platform_revenue,

        (SELECT COUNT(*) FROM investments WHERE status = 'active')               AS active_investments
    `);

    return res.json({
      total_aum:          Number(k.total_aum),
      active_capital:     Number(k.active_capital),
      total_investors:    Number(k.total_investors),
      returns_ytd:        Number(k.returns_ytd),
      platform_revenue:   Number(k.platform_revenue),
      active_investments: Number(k.active_investments),
      computed_at:        new Date().toISOString(),
    });
  } catch (err) {
    console.error('[analytics/kpis]', err);
    return res.status(500).json({ error: 'Failed to compute KPIs: ' + err.message });
  }
});

/* ── GET /api/analytics/dashboard ────────────────────────────────────
   The dashboard's tiles, counted in SQL over every row.

   They were summed in the browser from one page of each table — investors
   capped at 10,000, investments and transactions at 5,000. Past a cap a tile
   simply stops growing and nothing says so. Transactions crosses first, since
   every investment writes several rows (deposit, investment, fee,
   matured_funds, reinvestment, payout), so Returns was the figure most likely
   to be quietly short.

   Definitions are kept identical to the browser versions they replace, so the
   numbers do not change meaning on the way to being correct. The one
   deliberate difference is upcoming maturities: the browser read
   i.maturity_date, which is a column on investment_pools and does not exist on
   investments, so the guard `!i.maturity_date` rejected every row and the tile
   read 0 permanently. Here it is end_date, which is the column that holds it.
   ──────────────────────────────────────────────────────────────────── */
router.get('/dashboard', requireAuth, _admin, async (req, res) => {
  try {
    const { rows: [d] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM investors)                                        AS total_investors,

        COALESCE((SELECT SUM(ABS(amount)) FROM investments
                   WHERE status = 'active'), 0)                                 AS active_capital,

        /* type = 'return' only, and all time — the tile's own definition.
           Deliberately NOT the analytics returns_ytd, which also counts
           payouts and is scoped to the year. Two tiles, two questions. */
        COALESCE((SELECT SUM(ABS(amount)) FROM transactions
                   WHERE status = 'completed' AND type = 'return'), 0)          AS returns_total,

        (SELECT COUNT(*) FROM investment_pools
          WHERE COALESCE(status,'') IN ('open','active','filling'))             AS active_pools,

        (SELECT COUNT(*) FROM investors
          WHERE COALESCE(status,'') <> 'archived')                              AS non_archived,

        (SELECT COUNT(*) FROM investors
          WHERE COALESCE(status,'') <> 'archived'
            AND (fica_status = 'approved' OR kyc_status = 'approved'))          AS fica_approved,

        (SELECT COUNT(*) FROM investors
          WHERE COALESCE(status,'') <> 'archived'
            AND (fica_status IN ('pending','in_progress','submitted')
                 OR kyc_status = 'pending'))                                    AS pending_kyc,

        /* end_date, not maturity_date — see the note above. */
        (SELECT COUNT(*) FROM investments
          WHERE status = 'active'
            AND end_date IS NOT NULL
            AND end_date >= CURRENT_DATE
            AND end_date <= CURRENT_DATE + 90)                                  AS upcoming_maturities,

        (SELECT COUNT(*) FROM transactions
          WHERE type = 'withdrawal' AND status = 'pending')                     AS pending_withdrawals
    `);

    const n = v => Number(v) || 0;
    const nonArchived = n(d.non_archived);
    return res.json({
      total_investors:     n(d.total_investors),
      active_capital:      n(d.active_capital),
      returns_total:       n(d.returns_total),
      active_pools:        n(d.active_pools),
      non_archived:        nonArchived,
      fica_approved:       n(d.fica_approved),
      /* Computed here so the percentage and its two inputs cannot disagree,
         and guarded — no investors is 0%, not a division by zero. */
      fica_rate:           nonArchived ? Math.round((n(d.fica_approved) / nonArchived) * 100) : 0,
      pending_kyc:         n(d.pending_kyc),
      upcoming_maturities: n(d.upcoming_maturities),
      pending_withdrawals: n(d.pending_withdrawals),
      computed_at:         new Date().toISOString(),
    });
  } catch (err) {
    console.error('[analytics/dashboard]', err);
    return res.status(500).json({ error: 'Failed to compute dashboard figures: ' + err.message });
  }
});

/* ── GET /api/analytics/dashboard-series ─────────────────────────────
   The dashboard's two charts, over every row.

   Both were built in the browser from a capped page. The cap takes the most
   recent rows (the list endpoint orders by date DESC), which is harmless for a
   this-month-vs-last-month trend and wrong for anything cumulative: the oldest
   investments are exactly the ones missing, so an all-time AUM curve
   understates every point and understates the earliest months most.

   The AUM series also had a defect that had nothing to do with truncation. It
   filtered `inv.status === 'active'` — the status NOW — while walking back
   through months. An investment that matured last month was therefore excluded
   from every historical point, including the months it was live. That is not
   AUM over time; it is current holdings plotted by start date. Here an
   investment counts toward a month if it had started by then and had not yet
   ended: live as at that date, which is what the chart claims to show.
   ──────────────────────────────────────────────────────────────────── */
router.get('/dashboard-series', requireAuth, _admin, async (req, res) => {
  const months = Math.min(60, Math.max(1, parseInt(req.query.months, 10) || 6));
  try {
    /* One row per month, whether or not anything happened in it — a month with
       no activity is a real zero, not a gap the chart should skip over. */
    const { rows: series } = await pool.query(`
      WITH months AS (
        SELECT (DATE_TRUNC('month', CURRENT_DATE) - (n || ' months')::interval)::date AS m_start
          FROM generate_series($1::int - 1, 0, -1) AS n
      ),
      bounds AS (
        SELECT m_start,
               (m_start + INTERVAL '1 month - 1 day')::date AS m_end
          FROM months
      )
      SELECT b.m_start, b.m_end,
             COALESCE((
               SELECT SUM(ABS(i.amount)) FROM investments i
                WHERE COALESCE(i.status,'') NOT IN ('cancelled','rejected','failed')
                  AND COALESCE(i.start_date, i.created_at::date) <= b.m_end
                  AND (i.end_date IS NULL OR i.end_date > b.m_end)
             ), 0) AS aum,
             COALESCE((
               SELECT SUM(ABS(t.amount)) FROM transactions t
                WHERE t.status = 'completed' AND t.type = 'return'
                  AND COALESCE(t.transaction_date, t.created_at::date) BETWEEN b.m_start AND b.m_end
             ), 0) AS returns
        FROM bounds b
       ORDER BY b.m_start`, [months]);

    /* Every product type that actually holds capital, including ones no chart
       was written for. The browser version summed into a fixed map and dropped
       anything absent from it — so the migrated pools carrying 'other' added
       nothing to the mix at all, and a new product would be invisible until
       someone remembered to add a key. */
    const { rows: mix } = await pool.query(`
      SELECT COALESCE(NULLIF(COALESCE(ip.product_type, i.product_type), ''), 'unclassified') AS product_type,
             COALESCE(SUM(ABS(i.amount)), 0) AS capital,
             COUNT(*)::int                    AS count
        FROM investments i
        LEFT JOIN investment_pools ip ON ip.id = i.pool_id
       WHERE i.status = 'active'
       GROUP BY 1
       HAVING SUM(ABS(i.amount)) > 0
       ORDER BY 2 DESC`);

    return res.json({
      months: series.map(r => ({
        month:   String(r.m_start).slice(0, 10),
        aum:     Number(r.aum),
        returns: Number(r.returns),
      })),
      product_mix: mix.map(r => ({
        product_type: r.product_type,
        capital:      Number(r.capital),
        count:        r.count,
      })),
      computed_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[analytics/dashboard-series]', err);
    return res.status(500).json({ error: 'Failed to compute dashboard series: ' + err.message });
  }
});

/* ── GET /api/analytics/revenue ─────────────────────────── */
router.get('/revenue', requireAuth, _admin, async (req, res) => {
  try {
    const months = Math.min(parseInt(req.query.months, 10) || 12, 36);
    const [monthlyRows, productRows, allTimeRow, periodRow] = await Promise.all([
      pool.query(`
        SELECT DATE_TRUNC('month', created_at) AS month,
               COUNT(*) AS fee_count,
               SUM(ABS(amount)) AS fee_total
        FROM transactions
        WHERE type IN ('fee','platform_fee') AND status = 'completed'
          AND created_at >= NOW() - ($1 || ' months')::INTERVAL
        GROUP BY 1 ORDER BY 1
      `, [months]),
      pool.query(`
        SELECT COALESCE(i.product_type, 'unknown') AS product_type,
               COUNT(t.id) AS fee_count,
               SUM(ABS(t.amount)) AS fee_total
        FROM transactions t
        LEFT JOIN investments i ON i.id = t.investment_id
        WHERE t.type IN ('fee','platform_fee') AND t.status = 'completed'
          AND t.created_at >= NOW() - ($1 || ' months')::INTERVAL
        GROUP BY 1 ORDER BY fee_total DESC
      `, [months]),
      pool.query(`
        SELECT SUM(ABS(amount)) AS total_all_time
        FROM transactions WHERE type IN ('fee','platform_fee') AND status = 'completed'
      `),
      pool.query(`
        SELECT SUM(ABS(amount)) AS total_period, COUNT(*) AS count_period
        FROM transactions
        WHERE type IN ('fee','platform_fee') AND status = 'completed'
          AND created_at >= NOW() - ($1 || ' months')::INTERVAL
      `, [months]),
    ]);
    res.json({
      months,
      monthly:        monthlyRows.rows.map(r => ({ month: r.month, count: parseInt(r.fee_count), total: parseFloat(r.fee_total || 0) })),
      by_product:     productRows.rows.map(r => ({ product_type: r.product_type, count: parseInt(r.fee_count), total: parseFloat(r.fee_total || 0) })),
      total_all_time: parseFloat(allTimeRow.rows[0]?.total_all_time || 0),
      total_period:   parseFloat(periodRow.rows[0]?.total_period || 0),
      count_period:   parseInt(periodRow.rows[0]?.count_period || 0),
    });
  } catch (err) {
    console.error('[analytics-extra] revenue error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/analytics/maturity-reinvestment ────────────── */
router.get('/maturity-reinvestment', requireAuth, _admin, async (req, res) => {
  try {
    const [maturedRow, reinvestRow, monthlyRows] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) AS total_matured,
               SUM(amount) AS total_capital,
               COUNT(*) FILTER (WHERE payout_option = 'reinvest') AS elected_reinvest
        FROM investments WHERE status = 'matured'
      `),
      pool.query(`
        SELECT COUNT(*) AS reinvested, SUM(amount) AS reinvested_capital
        FROM investments WHERE is_reinvestment = true AND status IN ('active','matured')
      `),
      pool.query(`
        SELECT DATE_TRUNC('month', updated_at) AS month,
               COUNT(*) AS matured,
               COUNT(*) FILTER (WHERE payout_option = 'reinvest') AS reinvested,
               SUM(amount) AS capital
        FROM investments
        WHERE status = 'matured' AND updated_at >= NOW() - INTERVAL '12 months'
        GROUP BY 1 ORDER BY 1
      `),
    ]);
    const m = maturedRow.rows[0];
    const r = reinvestRow.rows[0];
    const totalMatured  = parseInt(m?.total_matured || 0);
    const actualReinvested = parseInt(r?.reinvested || 0);
    res.json({
      total_matured:      totalMatured,
      total_capital:      parseFloat(m?.total_capital || 0),
      elected_reinvest:   parseInt(m?.elected_reinvest || 0),
      actual_reinvested:  actualReinvested,
      reinvested_capital: parseFloat(r?.reinvested_capital || 0),
      reinvestment_rate:  totalMatured > 0 ? parseFloat((actualReinvested / totalMatured).toFixed(3)) : 0,
      monthly: monthlyRows.rows.map(r => ({
        month: r.month, matured: parseInt(r.matured),
        reinvested: parseInt(r.reinvested), capital: parseFloat(r.capital || 0),
      })),
    });
  } catch (err) {
    console.error('[analytics-extra] maturity-reinvestment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/analytics/ifa-performance ──────────────────── */
router.get('/ifa-performance', requireAuth, _admin, async (req, res) => {
  try {
    const [ifaRows, totalRow] = await Promise.all([
      pool.query(`
        SELECT
          f.id, f.first_name, f.last_name, f.email, f.company_name,
          f.commission_rate, f.status,
          COUNT(DISTINCT i.id) AS client_count,
          COUNT(DISTINCT inv.id) FILTER (WHERE inv.status = 'active') AS active_investments,
          COALESCE(SUM(i.total_invested), 0) AS total_aum,
          COALESCE(SUM(i.wallet_balance), 0) AS total_wallet
        FROM ifas f
        LEFT JOIN investors i   ON i.ifa_id = f.id
        LEFT JOIN investments inv ON inv.investor_id = i.id
        GROUP BY f.id, f.first_name, f.last_name, f.email, f.company_name, f.commission_rate, f.status
        ORDER BY total_aum DESC
      `),
      pool.query(`
        SELECT COUNT(DISTINCT id) AS total_with_ifa, COALESCE(SUM(total_invested),0) AS total_aum_via_ifa
        FROM investors WHERE ifa_id IS NOT NULL
      `),
    ]);
    res.json({
      ifas: ifaRows.rows.map(r => ({
        id:                 r.id,
        name:               `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        email:              r.email,
        company:            r.company_name,
        commission_rate:    parseFloat(r.commission_rate || 0),
        status:             r.status,
        client_count:       parseInt(r.client_count || 0),
        active_investments: parseInt(r.active_investments || 0),
        total_aum:          parseFloat(r.total_aum || 0),
        total_wallet:       parseFloat(r.total_wallet || 0),
      })),
      total_investors_via_ifa: parseInt(totalRow.rows[0]?.total_with_ifa || 0),
      total_aum_via_ifa:       parseFloat(totalRow.rows[0]?.total_aum_via_ifa || 0),
    });
  } catch (err) {
    console.error('[analytics-extra] ifa-performance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/analytics/sub-accounts ────────────────────── */
router.get('/sub-accounts', requireAuth, _admin, async (req, res) => {
  try {
    const [summaryRow, byTypeRows, monthlyRows] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'active') AS active,
          -- COALESCE: a NULL status is neither active nor dormant otherwise, so
          -- active + dormant did not add up to total.
          COUNT(*) FILTER (WHERE COALESCE(status, '') <> 'active') AS dormant,
          COUNT(*) FILTER (WHERE wallet_balance > 0) AS funded,
          COALESCE(SUM(wallet_balance), 0) AS total_balance,
          COALESCE(SUM(total_invested), 0) AS total_invested,
          COALESCE(SUM(total_returns), 0) AS total_returns,
          AVG(wallet_balance) FILTER (WHERE wallet_balance > 0) AS avg_balance
        FROM sub_accounts
      `),
      pool.query(`
        SELECT account_type,
               COUNT(*) AS count,
               COALESCE(SUM(wallet_balance), 0) AS balance,
               COALESCE(SUM(total_invested), 0) AS invested
        FROM sub_accounts
        GROUP BY account_type ORDER BY count DESC
      `),
      pool.query(`
        SELECT DATE_TRUNC('month', created_at) AS month, COUNT(*) AS new_accounts
        FROM sub_accounts WHERE created_at >= NOW() - INTERVAL '12 months'
        GROUP BY 1 ORDER BY 1
      `),
    ]);
    const s = summaryRow.rows[0];
    res.json({
      total:          parseInt(s?.total || 0),
      active:         parseInt(s?.active || 0),
      dormant:        parseInt(s?.dormant || 0),
      funded:         parseInt(s?.funded || 0),
      total_balance:  parseFloat(s?.total_balance || 0),
      total_invested: parseFloat(s?.total_invested || 0),
      total_returns:  parseFloat(s?.total_returns || 0),
      avg_balance:    parseFloat(s?.avg_balance || 0),
      by_type:     byTypeRows.rows.map(r => ({ type: r.account_type, count: parseInt(r.count), balance: parseFloat(r.balance || 0), invested: parseFloat(r.invested || 0) })),
      monthly_new: monthlyRows.rows.map(r => ({ month: r.month, count: parseInt(r.new_accounts) })),
    });
  } catch (err) {
    console.error('[analytics-extra] sub-accounts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/analytics/interest-history ─────────────────── */
router.get('/interest-history', requireAuth, _admin, async (req, res) => {
  try {
    const [listRows, totalRow] = await Promise.all([
      pool.query(`
        SELECT period, total_interest, accounts_credited, accounts_skipped,
               accounts_unmatched, applied_at, status, pim_file_name
        FROM interest_distributions
        ORDER BY applied_at DESC NULLS LAST, created_at DESC
        LIMIT 24
      `),
      pool.query(`
        SELECT COUNT(*) AS distributions,
               COALESCE(SUM(total_interest), 0) AS grand_total,
               COALESCE(SUM(accounts_credited), 0) AS total_accounts_credited
        FROM interest_distributions WHERE status = 'applied'
      `),
    ]);
    res.json({
      distributions: listRows.rows.map(r => ({
        period:            r.period,
        total_interest:    parseFloat(r.total_interest || 0),
        accounts_credited: parseInt(r.accounts_credited || 0),
        accounts_skipped:  parseInt(r.accounts_skipped || 0),
        accounts_unmatched: parseInt(r.accounts_unmatched || 0),
        applied_at:        r.applied_at,
        status:            r.status,
        pim_file_name:     r.pim_file_name,
      })),
      summary: {
        distribution_count:      parseInt(totalRow.rows[0]?.distributions || 0),
        grand_total:             parseFloat(totalRow.rows[0]?.grand_total || 0),
        total_accounts_credited: parseInt(totalRow.rows[0]?.total_accounts_credited || 0),
      },
    });
  } catch (err) {
    console.error('[analytics-extra] interest-history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/analytics/withdrawals ─────────────────────── */
router.get('/withdrawals', requireAuth, _admin, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 90, 365);
    const [monthlyRows, summaryRow, recentRows] = await Promise.all([
      pool.query(`
        SELECT DATE_TRUNC('month', created_at) AS month,
               COUNT(*) AS count,
               SUM(ABS(amount)) AS volume
        FROM transactions
        WHERE type = 'withdrawal'
          AND created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY 1 ORDER BY 1
      `, [days]),
      pool.query(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(ABS(amount)), 0) AS total_volume,
               COALESCE(AVG(ABS(amount)), 0) AS avg_amount,
               COUNT(*) FILTER (WHERE status = 'completed') AS completed,
               COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
               COUNT(*) FILTER (WHERE status = 'rejected')  AS rejected
        FROM transactions
        WHERE type = 'withdrawal'
          AND created_at >= NOW() - ($1 || ' days')::INTERVAL
      `, [days]),
      pool.query(`
        SELECT t.id, t.amount, t.status, t.created_at,
               COALESCE(i.first_name || ' ' || i.last_name, i.email) AS investor_name
        FROM transactions t
        LEFT JOIN investors i ON i.id = t.investor_id
        WHERE t.type = 'withdrawal'
          AND t.created_at >= NOW() - ($1 || ' days')::INTERVAL
        ORDER BY t.created_at DESC LIMIT 10
      `, [days]),
    ]);
    const s = summaryRow.rows[0];
    res.json({
      days,
      summary: {
        total:        parseInt(s?.total || 0),
        total_volume: parseFloat(s?.total_volume || 0),
        avg_amount:   parseFloat(s?.avg_amount || 0),
        completed:    parseInt(s?.completed || 0),
        pending:      parseInt(s?.pending || 0),
        rejected:     parseInt(s?.rejected || 0),
      },
      monthly: monthlyRows.rows.map(r => ({ month: r.month, count: parseInt(r.count), volume: parseFloat(r.volume || 0) })),
      recent:  recentRows.rows.map(r => ({ id: r.id, amount: parseFloat(r.amount || 0), status: r.status, investor_name: r.investor_name, created_at: r.created_at })),
    });
  } catch (err) {
    console.error('[analytics-extra] withdrawals error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/analytics/platform-fees ───────────────────── */
router.get('/platform-fees', requireAuth, _admin, async (req, res) => {
  try {
    const { period = 'month', from, to } = req.query;

    // Build date filter
    let dateClause = '';
    let dateParams = [];
    if (from && to) {
      dateClause = `AND t.created_at >= $1::date AND t.created_at < ($2::date + INTERVAL '1 day')`;
      dateParams = [from, to];
    } else if (period === 'week') {
      dateClause = `AND t.created_at >= DATE_TRUNC('week', NOW())`;
    } else if (period === 'month') {
      dateClause = `AND t.created_at >= DATE_TRUNC('month', NOW())`;
    } else if (period === 'year') {
      dateClause = `AND t.created_at >= DATE_TRUNC('year', NOW())`;
    }
    // period === 'all' → no date filter

    // Breakdown granularity
    const truncUnit = (period === 'week' || period === 'month') ? 'day' : 'month';

    // Match fees by type OR by reference pattern (FEE-...) — catches all recording paths
    const feeFilter = `(t.type IN ('fee', 'platform_fee') OR t.reference LIKE 'FEE-%') AND COALESCE(t.status, '') <> 'cancelled'`;

    const [summaryRow, breakdownRows, txnRows, topRows] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) AS count,
               COALESCE(SUM(ABS(t.amount)), 0) AS total,
               COALESCE(AVG(ABS(t.amount)), 0) AS avg
        FROM transactions t
        WHERE ${feeFilter}
          ${dateClause}
      `, dateParams),

      pool.query(`
        SELECT DATE_TRUNC('${truncUnit}', t.created_at) AS period,
               COUNT(*) AS count,
               SUM(ABS(t.amount)) AS total
        FROM transactions t
        WHERE ${feeFilter}
          ${dateClause}
        GROUP BY 1 ORDER BY 1
      `, dateParams),

      pool.query(`
        SELECT t.id, t.amount, t.created_at, t.reference, t.description,
               t.investment_id, t.pool_id,
               COALESCE(i.first_name || ' ' || i.last_name, i.email, t.investor_id) AS investor_name,
               COALESCE(p.name, p2.name) AS pool_name
        FROM transactions t
        LEFT JOIN investors i ON i.id = t.investor_id
        LEFT JOIN investment_pools p ON p.id = t.pool_id
        LEFT JOIN investments inv ON inv.id = t.investment_id
        LEFT JOIN investment_pools p2 ON p2.id = inv.pool_id
        WHERE ${feeFilter}
          ${dateClause}
        ORDER BY t.created_at DESC
        LIMIT 500
      `, dateParams),

      pool.query(`
        SELECT MAX(COALESCE(i.first_name || ' ' || i.last_name, i.email, t.investor_id)) AS investor_name,
               COUNT(*) AS count,
               SUM(ABS(t.amount)) AS total
        FROM transactions t
        LEFT JOIN investors i ON i.id = t.investor_id
        WHERE ${feeFilter}
          ${dateClause}
        GROUP BY t.investor_id ORDER BY total DESC LIMIT 10
      `, dateParams),
    ]);

    const s = summaryRow.rows[0];
    res.json({
      period,
      summary: {
        count: parseInt(s?.count || 0),
        total: parseFloat(s?.total || 0),
        avg:   parseFloat(s?.avg   || 0),
      },
      breakdown: breakdownRows.rows.map(r => ({
        period: r.period,
        count:  parseInt(r.count),
        total:  parseFloat(r.total || 0),
      })),
      transactions: txnRows.rows.map(r => ({
        id:            r.id,
        amount:        parseFloat(r.amount || 0),
        created_at:    r.created_at,
        reference:     r.reference,
        description:   r.description,
        investment_id: r.investment_id,
        pool_name:     r.pool_name || '—',
        investor_name: r.investor_name || '—',
      })),
      top_investors: topRows.rows.map(r => ({
        investor_name: r.investor_name || '—',
        count:  parseInt(r.count),
        total:  parseFloat(r.total || 0),
      })),
    });
  } catch (err) {
    console.error('[analytics-extra] platform-fees error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
