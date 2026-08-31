'use strict';
const router = require('express').Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

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
      pool.query(
        `SELECT type, amount, status, created_at, reference, description
           FROM transactions
          WHERE investor_id = $1 AND status = 'completed'
            AND created_at >= $2 AND created_at < ($3::date + INTERVAL '1 day')
          ORDER BY created_at`, [investorId, from, to]),
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

    /* Interest and returns credited as transactions are what an investor was
       actually paid in the period. The matured investments are reported
       alongside, and the two are NOT added together: a matured investment whose
       return was credited as a transaction would otherwise be counted twice —
       which on a tax certificate means declaring income the client never
       received. */
    const returnsPaid = sumType('return') + sumType('payout') + sumType('interest');
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
