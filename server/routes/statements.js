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

/* GET /api/statements/tax-cert/:year — generate IT3b-style tax summary for a tax year */
router.get('/tax-cert/:year', requireAuth, async (req, res) => {
  try {
    const investorId = req.user.investorId || (await pool.query('SELECT investor_id FROM users WHERE id=$1',[req.user.id])).rows[0]?.investor_id;
    if (!investorId) return res.status(403).json({ error: 'Forbidden.' });
    const year = parseInt(req.params.year, 10);
    if (!year || year < 2020 || year > new Date().getFullYear()) return res.status(400).json({ error: 'Invalid year.' });

    const [invRes, txnRes, retRes] = await Promise.all([
      pool.query('SELECT * FROM investors WHERE id=$1', [investorId]),
      pool.query(`SELECT type, amount, status, created_at, reference FROM transactions WHERE investor_id=$1 AND EXTRACT(YEAR FROM created_at)=$2 AND status='completed' ORDER BY created_at`, [investorId, year]),
      pool.query(`SELECT pool_name, actual_return, expected_return, end_date FROM investments WHERE investor_id=$1 AND status='paid_out' AND EXTRACT(YEAR FROM end_date)=$2`, [investorId, year]),
    ]);

    const inv = invRes.rows[0];
    if (!inv) return res.status(404).json({ error: 'Investor not found.' });
    const deposits = txnRes.rows.filter(t => t.type === 'deposit').reduce((s, t) => s + parseFloat(t.amount||0), 0);
    const withdrawals = txnRes.rows.filter(t => t.type === 'withdrawal').reduce((s, t) => s + parseFloat(t.amount||0), 0);
    const totalReturns = retRes.rows.reduce((s, r) => s + parseFloat(r.actual_return || r.expected_return || 0), 0);

    res.json({
      investor: { id: inv.id, first_name: inv.first_name, last_name: inv.last_name, email: inv.email, id_number: inv.id_number || '' },
      year,
      deposits,
      withdrawals,
      totalReturns,
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
