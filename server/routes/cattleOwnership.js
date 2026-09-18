'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Own a beef animal — /api/cattle-ownership/*

   The client-facing half of the product. Fund ops set up an intake and record
   the sale; a client buys one head and is paid what it fetched.

   The purchase is the delicate part. Four things have to happen together or
   none of them: the wallet is debited, an animal is claimed, the ownership
   row is written, and the two documents are issued. Any subset is a defect
   somebody has to unpick by hand — a client charged for an animal nobody
   allocated, or an animal marked sold that nobody paid for. So it is one
   transaction, and the animal is claimed with the same statement that reads
   it, so two tabs cannot buy the same beast.
   ═══════════════════════════════════════════════════════════════════ */

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const CO     = require('../services/cattleOwnership');

const FUND_ROLES  = ['admin', 'director', 'fund_manager'];
const requireFund = [requireAuth, requireRole(...FUND_ROLES)];

const investorOf = req => req.user.investorId || req.user.investor_id || null;
const rnd = n => Math.random().toString(36).slice(2, 2 + n).toUpperCase();

/* Sequential within the year, so the number itself says when it was issued.

   Taken from a counter, not from the highest number already on a row. Reading
   the maximum back out of cattle_ownerships looks equivalent and is not: it is
   a high-water mark, so a deleted or archived row lets the next purchase
   reissue a number that has already been on a tax invoice — and the ledger
   reference built from it collides with the one already there, which is how
   this was found.

   Incremented inside the purchase transaction, so a rolled-back purchase
   gives the number back and two concurrent ones cannot take the same. */
async function nextNumber(client, prefix) {
  const key = `${prefix}-${new Date().getUTCFullYear()}`;
  const { rows } = await client.query(
    `INSERT INTO document_sequences (key, next_value) VALUES ($1, 2)
     ON CONFLICT (key) DO UPDATE
       SET next_value = document_sequences.next_value + 1, updated_at = NOW()
     RETURNING next_value - 1 AS n`, [key]);
  return `${key}-${String(rows[0].n).padStart(6, '0')}`;
}

/* ─── GET /intakes — what is on offer ─────────────────────────────── */
router.get('/intakes', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.id, i.name, i.feedlot, i.purchase_price, i.feed_cost, i.feed_days,
              i.head_available, i.opens_at, i.closes_at, i.placed_at, i.status,
              (SELECT COUNT(*) FROM cattle_ownerships o WHERE o.intake_id = i.id) AS head_taken
         FROM cattle_intakes i
        WHERE i.status = 'open'
        ORDER BY i.opens_at NULLS LAST, i.created_at`);
    res.json({
      data: rows.map(r => ({
        ...r,
        head_taken:     Number(r.head_taken),
        head_remaining: Math.max(0, Number(r.head_available) - Number(r.head_taken)),
        price:          CO.priceFor(r),
      })),
    });
  } catch (err) {
    console.error('[cattle-ownership] intakes error:', err.message);
    res.status(500).json({ error: 'Could not load what is on offer.' });
  }
});

/* ─── POST /buy — one head ────────────────────────────────────────── */
router.post('/buy', requireAuth, async (req, res) => {
  const investorId = investorOf(req);
  if (!investorId) return res.status(403).json({ error: 'Only client accounts can own cattle.' });
  const { intake_id } = req.body || {};
  if (!intake_id) return res.status(400).json({ error: 'intake_id is required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [inv] } = await client.query(
      `SELECT id, first_name, last_name, email, wallet_balance, status, fica_status, kyc_status
         FROM investors WHERE id = $1 FOR UPDATE`, [investorId]);
    if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Client not found.' }); }
    if (String(inv.status || '') === 'suspended') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This account is suspended.' });
    }
    /* FICA before title, not after. An ownership certificate in the name of
       somebody we have not identified is worth less than the paper. */
    const fica = String(inv.fica_status || inv.kyc_status || '').toLowerCase();
    if (fica !== 'approved' && fica !== 'verified') {
      await client.query('ROLLBACK');
      return res.status(412).json({
        error: 'Your FICA documents must be approved before you can own an animal.',
        code: 'fica_required' });
    }

    const { rows: [intake] } = await client.query(
      `SELECT * FROM cattle_intakes WHERE id = $1 FOR UPDATE`, [intake_id]);
    if (!intake) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Unknown intake.' }); }
    if (intake.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This intake has closed. Please choose another.' });
    }

    const { rows: [{ taken }] } = await client.query(
      `SELECT COUNT(*)::int AS taken FROM cattle_ownerships WHERE intake_id = $1`, [intake_id]);
    if (taken >= Number(intake.head_available)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Every animal in this intake has been taken.' });
    }

    const price = CO.priceFor(intake);
    const balance = Number(inv.wallet_balance) || 0;
    if (balance + 0.001 < price.total) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Your wallet has ${CO.rand(balance)}. One animal costs ${CO.rand(price.total)}, including the 1% platform fee.`,
        code: 'insufficient_funds', required: price.total, balance });
    }

    /* Claim an animal with the statement that reads it. An unowned animal in
       this intake's cycle is taken by exactly one purchase; a second request
       finds nothing and is refused rather than sharing a tag. */
    const { rows: [animal] } = await client.query(
      `SELECT a.id, a.tag_number FROM cattle_animals a
        WHERE a.tag_number IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM cattle_ownerships o WHERE o.animal_id = a.id)
          AND COALESCE(a.sold, false) = false
          AND COALESCE(a.mortality, false) = false
        ORDER BY a.tag_number
        LIMIT 1 FOR UPDATE OF a SKIP LOCKED`);
    if (!animal) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'No tagged animal is available to allocate right now. Please try again shortly.' });
    }

    const id        = `COW-${rnd(10)}`;
    const invoiceNo = await nextNumber(client, 'INV');
    const certNo    = await nextNumber(client, 'COW');
    const placed = CO.isoDate(intake.placed_at) || CO.isoDate(intake.opens_at)
                 || new Date().toISOString().slice(0, 10);
    const expected = new Date(`${placed}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + Number(intake.feed_days || 120));
    const expectedSale = expected.toISOString().slice(0, 10);

    const docBag = {
      invoice_no: invoiceNo, certificate_no: certNo,
      investor_name: [inv.first_name, inv.last_name].filter(Boolean).join(' ') || inv.email,
      investor_id: inv.id, investor_email: inv.email,
      tag_number: animal.tag_number, intake_name: intake.name, feedlot: intake.feedlot,
      feed_days: Number(intake.feed_days || 120),
      placed_at: placed, expected_sale_date: expectedSale,
      issued_at: new Date().toISOString().slice(0, 10), price,
    };

    await client.query(
      `INSERT INTO cattle_ownerships
         (id, investor_id, intake_id, animal_id, tag_number, status,
          purchase_price, feed_cost, platform_fee, total_paid, feed_days,
          invoice_no, certificate_no, invoice_html, certificate_html, expected_sale_date)
       VALUES ($1,$2,$3,$4,$5,'owned',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, inv.id, intake.id, animal.id, animal.tag_number,
       price.purchase, price.feed, price.fee, price.total, docBag.feed_days,
       invoiceNo, certNo, CO.renderInvoice(docBag), CO.renderCertificate(docBag), expectedSale]);

    await client.query(
      'UPDATE investors SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
      [price.total, inv.id]);

    /* Two rows, because they are two different things to a client reading a
       statement: what the animal cost, and what we charged to arrange it. The
       fee is negative, as every fee on the platform must be. */
    await client.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description)
       VALUES ($1,$2,'investment',$3,'completed',$4,$5)`,
      [`TXN-${rnd(12)}`, inv.id, price.subtotal, `COW-${invoiceNo}-${id}`,
       `Beef animal ${animal.tag_number} — purchase and ${docBag.feed_days} days feed`]);
    await client.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description)
       VALUES ($1,$2,'platform_fee',$3,'completed',$4,$5)`,
      [`TXN-${rnd(12)}`, inv.id, -price.fee, `FEE-${invoiceNo}-${id}`,
       `Platform fee (1%) — beef animal ${animal.tag_number}`]);

    await client.query('COMMIT');
    res.json({ ok: true, id, tag_number: animal.tag_number,
               invoice_no: invoiceNo, certificate_no: certNo, price, expected_sale_date: expectedSale });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[cattle-ownership] buy error:', err.message);
    res.status(500).json({ error: 'Could not complete the purchase. Nothing has been charged.' });
  } finally {
    client.release();
  }
});

/* ─── GET /mine ───────────────────────────────────────────────────── */
router.get('/mine', requireAuth, async (req, res) => {
  const investorId = investorOf(req);
  if (!investorId) return res.json({ data: [] });
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.tag_number, o.status, o.purchase_price, o.feed_cost, o.platform_fee,
              o.total_paid, o.feed_days, o.invoice_no, o.certificate_no, o.purchased_at,
              o.expected_sale_date, o.sale_value, o.sale_deduction, o.proceeds,
              o.sold_at, o.payout_due_at, o.paid_at, o.mortality_at,
              i.name AS intake_name, i.feedlot, i.placed_at
         FROM cattle_ownerships o
         JOIN cattle_intakes i ON i.id = o.intake_id
        WHERE o.investor_id = $1
        ORDER BY o.purchased_at DESC`, [investorId]);
    res.json({ data: rows });
  } catch (err) {
    console.error('[cattle-ownership] mine error:', err.message);
    res.status(500).json({ error: 'Could not load your cattle.' });
  }
});

/* ─── GET /:id/invoice | /:id/certificate ─────────────────────────── */
for (const [path, column] of [['invoice', 'invoice_html'], ['certificate', 'certificate_html']]) {
  router.get(`/:id/${path}`, requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT investor_id, ${column} AS html FROM cattle_ownerships WHERE id = $1`, [req.params.id]);
      const row = rows[0];
      if (!row || !row.html) return res.status(404).send('Not found.');
      const staff = FUND_ROLES.includes(req.user.role) || req.user.role === 'staff';
      if (!staff && row.investor_id !== investorOf(req)) return res.status(403).send('Not yours.');
      res.type('html').send(row.html);
    } catch (err) {
      console.error(`[cattle-ownership] ${path} error:`, err.message);
      res.status(500).send('Could not load the document.');
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════
   Fund ops
   ═══════════════════════════════════════════════════════════════════ */

/* ─── POST /intakes — offer a batch ───────────────────────────────── */
router.post('/intakes', requireFund, async (req, res) => {
  const b = req.body || {};
  const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
  const purchase = num(b.purchase_price, NaN), feed = num(b.feed_cost, NaN);
  if (!b.name)                       return res.status(400).json({ error: 'name is required.' });
  if (!(purchase > 0))               return res.status(400).json({ error: 'purchase_price must be greater than zero.' });
  if (!(feed >= 0))                  return res.status(400).json({ error: 'feed_cost may not be negative.' });
  if (!(num(b.head_available, 0) > 0)) return res.status(400).json({ error: 'head_available must be at least one.' });

  try {
    const id = `INTK-${rnd(10)}`;
    const { rows: [row] } = await pool.query(
      `INSERT INTO cattle_intakes
         (id, name, feedlot, status, purchase_price, feed_cost, feed_days,
          sale_deduction, head_available, opens_at, closes_at, placed_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, b.name, b.feedlot || null, b.status === 'open' ? 'open' : 'draft',
       purchase, feed, num(b.feed_days, 120), num(b.sale_deduction, 0),
       num(b.head_available, 0), b.opens_at || null, b.closes_at || null,
       b.placed_at || null, b.notes || null]);
    res.json({ ok: true, intake: row, price: CO.priceFor(row) });
  } catch (err) {
    console.error('[cattle-ownership] create intake error:', err.message);
    res.status(500).json({ error: 'Could not create the intake.' });
  }
});

/* ─── PATCH /intakes/:id ──────────────────────────────────────────── */
router.patch('/intakes/:id', requireFund, async (req, res) => {
  const FIELDS = ['name', 'feedlot', 'status', 'purchase_price', 'feed_cost', 'feed_days',
                  'sale_deduction', 'head_available', 'opens_at', 'closes_at', 'placed_at', 'notes'];
  const sets = [], vals = [];
  for (const f of FIELDS) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
      vals.push(req.body[f] === '' ? null : req.body[f]);
      sets.push(`${f} = $${vals.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
  vals.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE cattle_intakes SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${vals.length} RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ error: 'Unknown intake.' });
    res.json({ ok: true, intake: rows[0] });
  } catch (err) {
    console.error('[cattle-ownership] patch intake error:', err.message);
    res.status(500).json({ error: 'Could not update the intake.' });
  }
});

/* ─── POST /:id/sold — record what the animal fetched ──────────────
   Recording the sale does not pay anybody. It sets the date the seven
   working days run from, and the payout run below pays when that date
   arrives — so a sale captured late cannot quietly pay late, and a sale
   captured twice cannot pay twice. */
router.post('/:id/sold', requireFund, async (req, res) => {
  const b = req.body || {};
  const saleValue = Number(b.sale_value);
  if (!(saleValue >= 0)) return res.status(400).json({ error: 'sale_value is required.' });
  const soldAt = CO.isoDate(b.sold_at) || new Date().toISOString().slice(0, 10);

  try {
    const { rows: [own] } = await pool.query(
      `SELECT o.*, i.sale_deduction AS intake_deduction
         FROM cattle_ownerships o JOIN cattle_intakes i ON i.id = o.intake_id
        WHERE o.id = $1`, [req.params.id]);
    if (!own) return res.status(404).json({ error: 'Unknown animal.' });
    if (own.status !== 'owned') {
      return res.status(409).json({ error: `This animal is already ${own.status}.` });
    }

    const deduction = b.sale_deduction === undefined || b.sale_deduction === null || b.sale_deduction === ''
      ? Number(own.intake_deduction) : Number(b.sale_deduction);
    const p = CO.proceedsFor({ sale_value: saleValue, sale_deduction: deduction });
    const due = CO.payoutDueFor(soldAt);

    const { rows: [row] } = await pool.query(
      `UPDATE cattle_ownerships
          SET status = 'sold', sale_value = $1, sale_deduction = $2, proceeds = $3,
              sold_at = $4, payout_due_at = $5, updated_at = NOW()
        WHERE id = $6 AND status = 'owned' RETURNING *`,
      [p.gross, p.deduction, p.proceeds, soldAt, due.toISOString().slice(0, 10), req.params.id]);
    if (!row) return res.status(409).json({ error: 'This animal is no longer owned.' });

    if (own.animal_id) {
      await pool.query(
        `UPDATE cattle_animals SET sold = true, sale_date = $1, sale_value = $2, updated_at = NOW()
          WHERE id = $3`, [soldAt, p.gross, own.animal_id]).catch(() => {});
    }
    res.json({ ok: true, ownership: row });
  } catch (err) {
    console.error('[cattle-ownership] sold error:', err.message);
    res.status(500).json({ error: 'Could not record the sale.' });
  }
});

/* ─── POST /:id/mortality — the animal died ───────────────────────────
   Insured at SV Capital's cost, so the client is made whole: everything that
   left their wallet comes back, the platform fee included. They paid for an
   animal they no longer have, and a fee retained on a service that produced
   nothing is not a fee, it is a deduction from a loss. */
router.post('/:id/mortality', requireFund, async (req, res) => {
  const when = CO.isoDate((req.body || {}).mortality_at) || new Date().toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [own] } = await client.query(
      `SELECT * FROM cattle_ownerships WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!own) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Unknown animal.' }); }
    if (own.status !== 'owned') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This animal is already ${own.status}.` });
    }

    const refund = Number(own.total_paid);
    await client.query(
      `UPDATE cattle_ownerships SET status = 'refunded', mortality_at = $1,
              mortality_note = $2, paid_at = NOW(), proceeds = $3, updated_at = NOW()
        WHERE id = $4`, [when, (req.body || {}).note || null, refund, own.id]);
    await client.query(
      'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
      [refund, own.investor_id]);
    await client.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description)
       VALUES ($1,$2,'refund',$3,'completed',$4,$5)`,
      [`TXN-${rnd(12)}`, own.investor_id, refund, `MORT-${own.certificate_no}`,
       `Mortality cover — beef animal ${own.tag_number} refunded in full`]);
    if (own.animal_id) {
      await client.query(
        `UPDATE cattle_animals SET mortality = true, mortality_date = $1, updated_at = NOW()
          WHERE id = $2`, [when, own.animal_id]).catch(() => {});
    }
    await client.query('COMMIT');
    res.json({ ok: true, refunded: refund });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[cattle-ownership] mortality error:', err.message);
    res.status(500).json({ error: 'Could not record the mortality.' });
  } finally {
    client.release();
  }
});

/* ─── GET /due — what the payout run would pay ─────────────────────── */
router.get('/due', requireFund, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.investor_id, o.tag_number, o.proceeds, o.sold_at, o.payout_due_at,
              i.first_name, i.last_name, i.email
         FROM cattle_ownerships o JOIN investors i ON i.id = o.investor_id
        WHERE o.status = 'sold' AND o.paid_at IS NULL AND o.payout_due_at <= CURRENT_DATE
        ORDER BY o.payout_due_at`);
    res.json({ data: rows, total: rows.reduce((t, r) => t + Number(r.proceeds || 0), 0) });
  } catch (err) {
    console.error('[cattle-ownership] due error:', err.message);
    res.status(500).json({ error: 'Could not load what is due.' });
  }
});

module.exports = router;
