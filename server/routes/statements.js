'use strict';
const router = require('express').Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
/* One definition of what counts as investment income, shared with the admin
   console's certificate — two documents reporting the same client's earnings
   must not be able to disagree. */
const { INCOME_TYPES } = require('../services/ledger');
/* The Investment Income Reference and the account statement are built by the
   same services the admin console uses, so a client and a staff member looking
   at the same period cannot be shown different figures. These routes decide
   only that the investor is themselves. */
const { buildIncomeReference } = require('../services/incomeReference');
const { buildAccountStatement } = require('../services/accountStatement');

/* The one place that answers "who is asking". The claim is investorId; reading
   it as investor_id finds nothing and falls through to the users row id, which
   is a different key entirely — that is exactly how the invest funnel came to
   file every event under an id the investors table has never heard of. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function callerInvestorId(req) {
  if (req.user && req.user.investorId) return req.user.investorId;
  if (req.user && req.user.investor_id) return req.user.investor_id;
  /* users.id is a uuid column. A token whose id is not one — a staff or
     service caller, say — made this query throw, and the route answered 500
     where it meant "you have no investor account". "Not yours" and "we broke"
     must not look the same to a client. */
  const id = req.user && req.user.id;
  if (!id || !UUID_RE.test(String(id))) return null;
  const { rows } = await pool.query('SELECT investor_id FROM users WHERE id=$1', [id]);
  return rows[0] && rows[0].investor_id;
}

/* GET /api/statements/income-reference/:year
   The same document the console produces, for the caller's own account. */
router.get('/income-reference/:year', requireAuth, async (req, res) => {
  try {
    const investorId = await callerInvestorId(req);
    if (!investorId) return res.status(403).json({ error: 'Forbidden.' });
    const data = await buildIncomeReference(pool, { investorId, year: req.params.year });
    res.json(data);
  } catch (err) {
    if (err.code === 'BAD_REQUEST') return res.status(400).json({ error: err.message });
    if (err.code === 'NOT_FOUND')   return res.status(404).json({ error: err.message });
    console.error('[statements/income-reference]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* GET /api/statements/account-statement?from=&to=
   The same document the console produces, for the caller's own account. */
router.get('/account-statement', requireAuth, async (req, res) => {
  try {
    const investorId = await callerInvestorId(req);
    if (!investorId) return res.status(403).json({ error: 'Forbidden.' });
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    const data = await buildAccountStatement(pool, { investorId, from, to });
    res.json(data);
  } catch (err) {
    if (err.code === 'BAD_REQUEST') return res.status(400).json({ error: err.message });
    if (err.code === 'NOT_FOUND')   return res.status(404).json({ error: err.message });
    console.error('[statements/account-statement]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* GET /api/statements — list available statements for the logged-in investor */
router.get('/', requireAuth, async (req, res) => {
  try {
    const investorId = req.user.investorId || (await pool.query('SELECT investor_id FROM users WHERE id=$1',[req.user.id])).rows[0]?.investor_id;
    if (!investorId) return res.json({ statements: [] });
    const { rows } = await pool.query(
      `SELECT id, period_year, period_month, created_at FROM investor_statements WHERE investor_id=$1 ORDER BY period_year DESC, period_month DESC LIMIT 24`,
      [investorId]
    );
    res.json({ statements: rows });
  } catch (e) { res.status(500).json({ error: 'Internal server error.' }); }
});

/* The South African tax year: 1 March to the end of February.
 *
 * "Tax year 2026" means 1 March 2025 to 28 February 2026. This endpoint used
 * EXTRACT(YEAR FROM created_at) — the CALENDAR year — so a certificate headed
 * "2026" covered January to December 2026 and reported the wrong ten months to
 * SARS. The portal's own date preset already used the March-to-February range,
 * so the two halves of the same feature disagreed about which period a client
 * was even asking for.
 *
 * The end is computed as "the day before 1 March", which gets 29 February right
 * in a leap year without anyone having to think about it. */
function taxYearRange(year) {
  const from = new Date(Date.UTC(year - 1, 2, 1));           // 1 March, previous year
  const to   = new Date(Date.UTC(year, 2, 1) - 86400000);    // last day of February
  return { from, to };
}

/* GET /api/statements/tax-cert/:year — IT3(b)-style summary for a SA tax year */
router.get('/tax-cert/:year', requireAuth, async (req, res) => {
  try {
    const investorId = req.user.investorId || (await pool.query('SELECT investor_id FROM users WHERE id=$1',[req.user.id])).rows[0]?.investor_id;
    if (!investorId) return res.status(403).json({ error: 'Forbidden.' });
    const year = parseInt(req.params.year, 10);
    /* +1 because the tax year ending February 2027 is already under way for
       most of calendar 2026, and a client filing early must be able to ask for
       it. */
    if (!year || year < 2020 || year > new Date().getFullYear() + 1)
      return res.status(400).json({ error: 'Invalid year.' });

    const { from, to } = taxYearRange(year);

    const [invRes, txnRes, retRes] = await Promise.all([
      pool.query('SELECT * FROM investors WHERE id=$1', [investorId]),
      /* COALESCE(transaction_date, created_at): created_at is when the row was
         written, and for anything migrated or captured after the fact that is
         months from when the money moved. Filtering on it put a client's
         income in the wrong tax year — or, when the whole ledger was imported
         at once, in no year the client could ask for. */
      pool.query(
        `SELECT type, amount, status, reference, description,
                COALESCE(transaction_date, created_at) AS txn_date, created_at
           FROM transactions
          WHERE investor_id = $1 AND status = 'completed'
            AND COALESCE(transaction_date, created_at) >= $2
            AND COALESCE(transaction_date, created_at) < ($3::date + INTERVAL '1 day')
          ORDER BY COALESCE(transaction_date, created_at)`, [investorId, from, to]),
      /* 'matured', not 'paid_out'. Setup migrates paid_out to matured on every
         boot, so this filter matched nothing and the certificate reported R0 of
         investment returns to every investor, every year. Both are accepted
         here in case a row somewhere escaped the migration. */
      pool.query(
        `SELECT pool_name, actual_return, expected_return, end_date, amount
           FROM investments
          WHERE investor_id = $1 AND status IN ('matured', 'paid_out')
            AND end_date >= $2 AND end_date <= $3
          ORDER BY end_date`, [investorId, from, to]),
    ]);

    const inv = invRes.rows[0];
    if (!inv) return res.status(404).json({ error: 'Investor not found.' });

    const num = v => parseFloat(v || 0) || 0;
    const sumType = t => txnRes.rows.filter(r => r.type === t)
                                    .reduce((s, r) => s + Math.abs(num(r.amount)), 0);

    const deposits    = sumType('deposit');
    const withdrawals = sumType('withdrawal');

    /* Income credited as transactions. The matured investments are reported
       alongside, and the two are NOT added together: a matured investment whose
       return was also accrued as transactions would otherwise be counted twice —
       which on a tax certificate means declaring income the client never
       received.

       `payout` used to be in this sum and has been removed. maturityCron's
       creditWallet writes a payout whose amount is the client's capital coming
       back PLUS the return on it; only the return portion goes to
       total_returns. Adding payout amounts here therefore declared returned
       capital as investment income. The realised return is already carried by
       maturedReturns below, from investments.actual_return. */
    const returnsPaid = INCOME_TYPES.reduce((s, t) => s + sumType(t), 0);
    const maturedReturns = retRes.rows.reduce(
      (s, r) => s + num(r.actual_return != null ? r.actual_return : r.expected_return), 0);

    res.json({
      investor: { id: inv.id, first_name: inv.first_name, last_name: inv.last_name,
                  email: inv.email, id_number: inv.id_number || '' },
      year,
      period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      deposits,
      withdrawals,
      /* The headline figure: what was credited to the investor in the period. */
      totalReturns: Math.round(returnsPaid * 100) / 100,
      /* Reported separately so a person can see where it came from, and so the
         two can be compared rather than silently summed. */
      maturedReturns: Math.round(maturedReturns * 100) / 100,
      fees: sumType('platform_fee') + sumType('fee'),
      investments: retRes.rows,
      transactions: txnRes.rows,
    });
  } catch (e) { console.error('/tax-cert error:', e.message); res.status(500).json({ error: 'Internal server error.' }); }
});

/* GET /api/statements/:id/pdf — download a specific statement as PDF */
router.get('/:id/pdf', requireAuth, async (req, res) => {
  try {
    const investorId = req.user.investorId || (await pool.query('SELECT investor_id FROM users WHERE id=$1',[req.user.id])).rows[0]?.investor_id;
    if (!investorId) return res.status(403).json({ error: 'Forbidden.' });
    const { rows } = await pool.query('SELECT * FROM investor_statements WHERE id=$1 AND investor_id=$2', [req.params.id, investorId]);
    if (!rows[0]) return res.status(404).json({ error: 'Statement not found.' });
    const buf = Buffer.from(rows[0].pdf_data, 'base64');
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="SVC-Statement-${rows[0].period_year}-${String(rows[0].period_month).padStart(2,'0')}.pdf"` });
    res.send(buf);
  } catch (e) { res.status(500).json({ error: 'Internal server error.' }); }
});

module.exports = router;
module.exports.taxYearRange = taxYearRange;
