'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Investment agreements
     POST /api/agreements/draw            — draw one for review
     POST /api/agreements/:id/sign        — sign it
     GET  /api/agreements/:id             — its state
     GET  /api/agreements/:id/document    — the sealed document
     GET  /api/agreements                 — the investor's own

   Drawing is free and repeatable; signing is the act that counts, and
   tables.js will not let an investor's money move without one.
   ═══════════════════════════════════════════════════════════════════ */

const router  = require('express').Router();
const crypto  = require('crypto');
const pool    = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const AG      = require('../services/agreements');

/* Long enough to read the document and think, short enough that an
   abandoned draft is not still hanging around tomorrow claiming a price
   that has since moved. */
const VALID_MINUTES = 30;

const investorOf = req => req.user.investorId || req.user.investor_id;

/* AGR-2026-000481. Sequential within the year so the number itself says
   roughly when, and a gap is visible. */
async function nextAgreementNo(client) {
  const year = new Date().getFullYear();
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM investment_agreements
      WHERE agreement_no LIKE $1`, [`AGR-${year}-%`]
  );
  return `AGR-${year}-${String(rows[0].n + 1).padStart(6, '0')}`;
}

/* ─── POST /draw ─────────────────────────────────────────────────────── */
router.post('/draw', requireAuth, async (req, res) => {
  const investorId = investorOf(req);
  if (!investorId) return res.status(403).json({ error: 'Only investor accounts can sign investment agreements.' });

  const { pool_id, amount, sub_account_id } = req.body;
  const amountCents = AG.toCents(amount);
  if (!pool_id)          return res.status(400).json({ error: 'pool_id is required.' });
  if (amountCents <= 0)  return res.status(400).json({ error: 'amount must be greater than zero.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [inv] } = await client.query(
      `SELECT id, first_name, last_name, fica_status, kyc_status
         FROM investors WHERE id = $1`, [investorId]
    );
    if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Investor not found.' }); }

    /* FICA before a contract, not after. An agreement signed by someone we
       have not identified is worth less than the time it took to read. */
    const fica = String(inv.fica_status || inv.kyc_status || '').toLowerCase();
    if (fica !== 'approved' && fica !== 'verified') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Your FICA verification must be approved before you can sign an investment agreement.' });
    }

    const { rows: [p] } = await client.query(
      `SELECT id, name, product_type, term_months, annual_rate, min_investment, status,
              maturity_date,
              (end_date IS NOT NULL AND end_date < CURRENT_DATE) AS past_close
         FROM investment_pools WHERE id = $1`, [pool_id]
    );
    if (!p) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Unknown pool.' }); }
    if (p.past_close || !['open', 'waitlist', 'filling'].includes(String(p.status || ''))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This pool is no longer open to new investments.' });
    }
    /* `amount` is what reaches the POOL. The minimum is a rule about the
       pool, so it is tested against that and not against the wallet spend. */
    const minCents = AG.toCents(p.min_investment);
    if (minCents && amountCents < minCents) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Minimum investment for this pool is ${AG.rand(minCents)}.` });
    }

    /* The same arithmetic tables.js applies when the money moves, so the
       document states the figures the wallet will actually see. The fee is
       charged on top, and totalCents is what the gate matches the signature
       against — it is what leaves the wallet. */
    const poolCents  = amountCents;
    const feeCents   = Math.round(poolCents * 0.01);
    const totalCents = poolCents + feeCents;

    /* One live draft per investor per pool. Re-opening the modal should not
       leave a trail of drawn agreements nobody signed. */
    await client.query(
      `UPDATE investment_agreements SET status = 'lapsed', lapsed_at = NOW()
        WHERE investor_id = $1 AND pool_id = $2 AND status = 'drawn'`,
      [investorId, pool_id]
    );

    const id  = 'AGR-' + crypto.randomUUID();
    const no  = await nextAgreementNo(client);
    const t   = AG.templateFor(p.product_type);
    const acks = AG.acknowledgementsFor(p.product_type);
    const drawnAt = new Date();

    const html = AG.renderAgreement({
      ...AG.poolFacts(p),
      agreement_no: no, investor_id: investorId,
      investor_name: `${inv.first_name || ''} ${inv.last_name || ''}`.trim(),
      investor_email: inv.email,
      amount_cents: totalCents, pool_amount_cents: poolCents, fee_cents: feeCents,
      drawn_at: drawnAt,
    });

    await client.query(
      `INSERT INTO investment_agreements
         (id, agreement_no, investor_id, pool_id, product_type, sub_account_id,
          amount_cents, pool_amount_cents, fee_cents,
          template_key, template_version, status, document_html, drawn_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'drawn',$12,$13,$14)`,
      [id, no, investorId, p.id, p.product_type, sub_account_id || null,
       totalCents, poolCents, feeCents, t.key, t.version, html, drawnAt,
       new Date(drawnAt.getTime() + VALID_MINUTES * 60000)]
    );

    await client.query('COMMIT');
    res.json({
      ok: true, id, agreement_no: no, template: t.key, template_version: t.version,
      title: t.title, acknowledgements: acks, document_html: html,
      amount: AG.fromCents(totalCents), pool_amount: AG.fromCents(poolCents),
      fee: AG.fromCents(feeCents), expires_in_minutes: VALID_MINUTES,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[agreements/draw]', err.message);
    res.status(500).json({ error: 'Could not draw the agreement. Please try again.' });
  } finally {
    client.release();
  }
});

/* ─── POST /:id/sign ─────────────────────────────────────────────────── */
router.post('/:id/sign', requireAuth, async (req, res) => {
  const investorId = investorOf(req);
  if (!investorId) return res.status(403).json({ error: 'Only investor accounts can sign investment agreements.' });

  const { signer_name, signature_png, acknowledged } = req.body;
  const ticked = Array.isArray(acknowledged) ? acknowledged : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* FOR UPDATE: signing twice in two tabs would otherwise produce two
       sealed documents for one agreement, with different hashes. */
    const { rows: [a] } = await client.query(
      `SELECT * FROM investment_agreements WHERE id = $1 FOR UPDATE`, [req.params.id]
    );
    if (!a || a.investor_id !== investorId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Agreement not found.' });
    }
    if (a.status !== 'drawn') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: a.status === 'signed' || a.status === 'funded'
        ? 'This agreement has already been signed.'
        : 'This agreement has lapsed. Please start again.' });
    }
    if (a.expires_at && new Date(a.expires_at) < new Date()) {
      await client.query(
        `UPDATE investment_agreements SET status='lapsed', lapsed_at=NOW() WHERE id=$1`, [a.id]);
      await client.query('COMMIT');
      return res.status(409).json({ error: 'This agreement expired before it was signed. Please start again.' });
    }

    /* Every acknowledgement, individually. Accepting a partial set would
       make the separate tick boxes decorative. */
    const required = AG.acknowledgementsFor(a.product_type);
    const missing  = required.filter(r => !ticked.includes(r.key));
    if (missing.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Please confirm every statement before signing.',
        missing: missing.map(m => m.key),
      });
    }

    const { rows: [inv] } = await client.query(
      `SELECT first_name, last_name, email FROM investors WHERE id = $1`, [investorId]);
    const expected = `${inv.first_name || ''} ${inv.last_name || ''}`.trim().toLowerCase().replace(/\s+/g, ' ');
    const given    = String(signer_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!given) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Please type your full name to sign.' }); }
    if (given !== expected) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The name you typed does not match the name on your account.' });
    }

    /* A data URL for a small PNG, or nothing. Anything else is not a
       signature and must not be written into a document we will serve. */
    let sig = String(signature_png || '');
    if (sig && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The signature image was not in a format we can accept.' });
    }
    if (sig.length > 200000) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The signature image is too large.' });
    }

    const signedAt = new Date();
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const ua = String(req.headers['user-agent'] || '').slice(0, 400);

    /* Sealed here and never rendered again. The stored bytes are the
       agreement; the hash is what proves they have not moved since. */
    /* The same facts, through the same helper, as at draw time. Building the
       two documents from two different SELECTs is how the sealed copy comes
       to differ from the one that was read — and the hash would then describe
       a document nobody saw. */
    const { rows: [p] } = await client.query(
      `SELECT ip.id, ip.name, ip.product_type, ip.term_months, ip.annual_rate,
              ip.maturity_date, ip.investment_start_date,
              ip.management_fee_pct, ip.management_fee_frequency,
              ip.operational_fee_pct, ip.operational_fee_frequency,
              pr.performance_fee_pct, pr.benchmark_rate
         FROM investment_pools ip
         LEFT JOIN products pr ON pr.product_type = ip.product_type
        WHERE ip.id = $1`, [a.pool_id]);
    const sealed = AG.renderAgreement({
      ...AG.poolFacts(p || {}),
      product_type: a.product_type,
      agreement_no: a.agreement_no, investor_id: investorId,
      investor_name: `${inv.first_name || ''} ${inv.last_name || ''}`.trim(),
      investor_email: inv.email,
      amount_cents: Number(a.amount_cents),
      pool_amount_cents: Number(a.pool_amount_cents),
      fee_cents: Number(a.fee_cents),
      drawn_at: a.drawn_at,
      signed_at: signedAt, signer_name: String(signer_name).trim(),
      signature_png: sig || null, acknowledgements: required,
      signed_ip: ip, signed_user_agent: ua,
    });
    const hash = AG.sha256(sealed);

    await client.query(
      `UPDATE investment_agreements
          SET status='signed', signer_name=$2, signature_png=$3,
              acknowledgements=$4::jsonb, document_html=$5, document_sha256=$6,
              signed_ip=$7, signed_user_agent=$8, signed_at=$9
        WHERE id=$1`,
      [a.id, String(signer_name).trim(), sig || null,
       JSON.stringify(required), sealed, hash, ip || null, ua || null, signedAt]
    );
    await client.query('COMMIT');

    res.json({ ok: true, id: a.id, agreement_no: a.agreement_no,
               signed_at: signedAt, document_sha256: hash });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[agreements/sign]', err.message);
    res.status(500).json({ error: 'Could not record the signature. Please try again.' });
  } finally {
    client.release();
  }
});

/* ─── GET /:id ───────────────────────────────────────────────────────── */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [a] } = await pool.query(
      `SELECT id, agreement_no, investor_id, pool_id, product_type, status,
              amount_cents, pool_amount_cents, fee_cents, template_key, template_version,
              document_sha256, drawn_at, signed_at, funded_at, expires_at, investment_id
         FROM investment_agreements WHERE id = $1`, [req.params.id]);
    if (!a) return res.status(404).json({ error: 'Agreement not found.' });
    const investorId = investorOf(req);
    if (investorId && a.investor_id !== investorId) return res.status(404).json({ error: 'Agreement not found.' });
    res.json({ ok: true, agreement: {
      ...a,
      amount: AG.fromCents(a.amount_cents),
      pool_amount: AG.fromCents(a.pool_amount_cents),
      fee: AG.fromCents(a.fee_cents),
    } });
  } catch (err) {
    console.error('[agreements/get]', err.message);
    res.status(500).json({ error: 'Could not load the agreement.' });
  }
});

/* ─── GET /:id/document ──────────────────────────────────────────────── */
router.get('/:id/document', requireAuth, async (req, res) => {
  try {
    const { rows: [a] } = await pool.query(
      `SELECT investor_id, agreement_no, document_html FROM investment_agreements WHERE id = $1`,
      [req.params.id]);
    if (!a || !a.document_html) return res.status(404).json({ error: 'Agreement not found.' });
    const investorId = investorOf(req);
    if (investorId && a.investor_id !== investorId) return res.status(404).json({ error: 'Agreement not found.' });

    /* Served as a document, from stored bytes. nosniff because the body is
       HTML we rendered and must not be re-interpreted as anything else. */
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', `inline; filename="${a.agreement_no}.html"`);
    res.send(a.document_html);
  } catch (err) {
    console.error('[agreements/document]', err.message);
    res.status(500).json({ error: 'Could not load the agreement.' });
  }
});

/* ─── GET / ──────────────────────────────────────────────────────────── */
router.get('/', requireAuth, async (req, res) => {
  const investorId = investorOf(req);
  if (!investorId) return res.status(403).json({ error: 'Only investor accounts have agreements.' });
  try {
    const { rows } = await pool.query(
      `SELECT id, agreement_no, pool_id, product_type, status, amount_cents,
              template_key, template_version, document_sha256,
              drawn_at, signed_at, funded_at, investment_id
         FROM investment_agreements
        WHERE investor_id = $1 AND status <> 'drawn'
        ORDER BY COALESCE(signed_at, drawn_at) DESC`, [investorId]);
    res.json({ ok: true, agreements: rows.map(r => ({ ...r, amount: AG.fromCents(r.amount_cents) })) });
  } catch (err) {
    console.error('[agreements/list]', err.message);
    res.status(500).json({ error: 'Could not load your agreements.' });
  }
});

module.exports = router;
