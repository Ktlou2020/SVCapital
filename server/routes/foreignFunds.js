/* ═══════════════════════════════════════════════════════════
   Foreign investor funds — /api/foreign-funds
   Requires role: admin | director
   ═══════════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { actorFromRequest } = require('../services/ledger');
const FOREIGN = require('../services/foreignInvestor');
const audit   = require('../services/audit');

router.use(requireAuth, requireRole('admin', 'director'));

/* The process as the console needs it, so the screen is not a second
   transcription of the document. */
router.get('/reference', (_req, res) => res.json({
  inwardBank:      FOREIGN.INWARD_BANK,
  inwardRules:     FOREIGN.INWARD_RULES,
  bopInflow:       FOREIGN.BOP_INFLOW,
  bopOutflow:      FOREIGN.BOP_OUTFLOW,
  bopInflowLabel:  FOREIGN.bopLabel(FOREIGN.BOP_INFLOW),
  bopOutflowLabel: FOREIGN.bopLabel(FOREIGN.BOP_OUTFLOW),
  filingItems:     FOREIGN.FILING_ITEMS,
  payoutCostNote:  FOREIGN.PAYOUT_COST_NOTE,
  usPersonQuestion: FOREIGN.US_PERSON_QUESTION,
}));

/* Residency, and where a non-resident is paid. */
router.patch('/investors/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const b  = req.body || {};
    const { rows: [before] } = await pool.query(
      'SELECT id, residency_status, country_of_residence FROM investors WHERE id = $1', [id]);
    if (!before) return res.status(404).json({ error: 'Investor not found.' });

    const status = b.residencyStatus === undefined ? undefined
      : (b.residencyStatus === FOREIGN.NON_RESIDENT ? FOREIGN.NON_RESIDENT : FOREIGN.RESIDENT);

    /* A NAMED WHITELIST, not req.body spread into an UPDATE. This endpoint
       exists to set eight things about an investor and must not become a way
       to set a ninth — a wallet balance, a KYC status — by naming it in a
       request. */
    const fields = {
      residency_status:        status,
      country_of_residence:    b.countryOfResidence,
      foreign_bank_name:       b.foreignBankName,
      foreign_bank_country:    b.foreignBankCountry,
      foreign_swift_bic:       b.foreignSwiftBic,
      foreign_iban:            b.foreignIban,
      foreign_account_number:  b.foreignAccountNumber,
      foreign_payout_currency: b.foreignPayoutCurrency
        ? String(b.foreignPayoutCurrency).trim().toUpperCase().slice(0, 3)
        : b.foreignPayoutCurrency,
    };
    const set = [], vals = [];
    for (const [col, val] of Object.entries(fields)) {
      if (val === undefined) continue;
      vals.push(val === '' ? null : val);
      set.push(`${col} = $${vals.length}`);
    }
    if (!set.length) return res.status(400).json({ error: 'Nothing to change.' });

    vals.push(id);
    await pool.query(
      `UPDATE investors SET ${set.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`, vals);

    const actor = actorFromRequest(req, 'staff');
    await audit.log({
      actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
      action: 'investor.foreign_funds_updated', entityType: 'investors', entityId: id,
      description: `Updated foreign funds details for ${id}`,
      before, after: fields, ip: actor.ip,
    }).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error('[foreign-funds investor]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* How an inflow or a payout was reported to the Reserve Bank.
 *
 * The categories are the two the process names and nothing else. A free text
 * box here is how an investment gets filed as a loan, a gift or "other" —
 * which the process forbids in those words, because it is not a tidy-up-later
 * filing error but a different transaction on the record. */
router.patch('/transactions/:id/bop', async (req, res) => {
  try {
    const id  = String(req.params.id || '');
    const key = String((req.body && req.body.category) || '');

    const ALLOWED = {
      inflow:  FOREIGN.bopLabel(FOREIGN.BOP_INFLOW),
      outflow: FOREIGN.bopLabel(FOREIGN.BOP_OUTFLOW),
      '':      null,               // clearing it is allowed; inventing one is not
    };
    if (!(key in ALLOWED)) {
      return res.status(400).json({
        error: `Unknown BOP category. An inflow is "${ALLOWED.inflow}" and a payout is `
             + `"${ALLOWED.outflow}" — a cross-border investment may not be coded as a loan, `
             + 'a gift or other.' });
    }

    const { rows: [txn] } = await pool.query(
      'SELECT id, type, bop_category FROM transactions WHERE id = $1', [id]);
    if (!txn) return res.status(404).json({ error: 'Transaction not found.' });

    await pool.query(
      'UPDATE transactions SET bop_category = $1, updated_at = NOW() WHERE id = $2',
      [ALLOWED[key], id]);

    const actor = actorFromRequest(req, 'staff');
    await audit.log({
      actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
      action: 'transaction.bop_coded', entityType: 'transactions', entityId: id,
      description: `BOP category for ${id} set to ${ALLOWED[key] || '(cleared)'}`,
      before: { bop_category: txn.bop_category }, after: { bop_category: ALLOWED[key] },
      ip: actor.ip,
    }).catch(() => {});

    res.json({ success: true, bopCategory: ALLOWED[key] });
  } catch (err) {
    console.error('[foreign-funds bop]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* What is on file for one inflow. The whole set is sent each time and
   replaces what was there, so removing a tick is as recordable as adding
   one. */
router.put('/transactions/:id/files', async (req, res) => {
  const id    = String(req.params.id || '');
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: 'items must be a list.' });

  const unknown = items.filter(i => !FOREIGN.FILING_KEYS.includes(String(i)));
  if (unknown.length) {
    return res.status(400).json({ error: `Unknown filing item: ${unknown.join(', ')}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [txn] } = await client.query(
      'SELECT id FROM transactions WHERE id = $1', [id]);
    if (!txn) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    const actor = actorFromRequest(req, 'staff');
    await client.query('DELETE FROM foreign_inflow_files WHERE transaction_id = $1', [id]);
    for (const item of items) {
      await client.query(
        `INSERT INTO foreign_inflow_files (transaction_id, item, noted_by, noted_email, noted_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [id, item, actor.id ? String(actor.id) : null, actor.email || null]);
    }
    await client.query('COMMIT');

    res.json({ success: true, items,
               complete: FOREIGN.FILING_KEYS.every(k => items.includes(k)) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[foreign-funds files]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

router.get('/transactions/:id/files', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT item, noted_email, noted_at FROM foreign_inflow_files WHERE transaction_id = $1',
      [String(req.params.id || '')]);
    res.json({
      items: rows,
      complete: FOREIGN.FILING_KEYS.every(k => rows.some(r => r.item === k)),
    });
  } catch (err) {
    console.error('[foreign-funds files get]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
