/* ═══════════════════════════════════════════════════════
   KYC Reconciliation

   The approval path now updates the document, the investor record and the
   support tickets in one transaction. That stops them diverging in future.
   It does not repair the ones already divergent, and it cannot help when a
   record is changed outside that path — a status edited directly, a document
   imported, a transaction that rolled back.

   Logging a failure is not closing the loop. This is: it runs the same two
   rules on a schedule, so a record that drifts is corrected within the hour
   rather than waiting for someone to notice.

   Both rules are idempotent and narrow. Neither invents an approval — each
   only makes a record agree with documents that were already approved.
   ═══════════════════════════════════════════════════════ */
'use strict';

const cron = require('node-cron');
const pool = require('../db/pool');
const { KYC_TICKET_MATCH, KYC_TICKET_OPEN } = require('../services/kycTickets');

/* Every investor whose three required documents are approved. bank_statement
   counts as proof_of_bank — migrated clients carry the older type. */
const ALL_DOCS_APPROVED = `
  EXISTS (SELECT 1 FROM kyc_documents d WHERE d.investor_id = inv.id
           AND d.status = 'approved' AND d.doc_type = 'id_document')
  AND EXISTS (SELECT 1 FROM kyc_documents d WHERE d.investor_id = inv.id
           AND d.status = 'approved' AND d.doc_type = 'proof_of_address')
  AND EXISTS (SELECT 1 FROM kyc_documents d WHERE d.investor_id = inv.id
           AND d.status = 'approved' AND d.doc_type IN ('proof_of_bank','bank_statement'))`;

async function runKycReconcile() {
  const started = Date.now();
  let promoted = 0, resolved = 0;

  try {
    /* 1. Documents all approved, record not. COALESCE because fica_status is
       NULL on every investor predating the column's default, and
       `NULL <> 'approved'` is NULL rather than true. */
    const promote = await pool.query(`
      UPDATE investors inv
         SET fica_status      = 'approved',
             kyc_status       = 'approved',
             status           = CASE WHEN inv.status IN ('pending','pending_fica','fica_submitted')
                                     THEN 'active' ELSE inv.status END,
             fica_approved_at = COALESCE(inv.fica_approved_at, NOW()),
             updated_at       = NOW()
       WHERE COALESCE(inv.fica_status, '') <> 'approved'
         AND ${ALL_DOCS_APPROVED}
       RETURNING inv.id`);
    promoted = promote.rowCount;
    if (promoted) {
      console.warn(`[kycReconcile] promoted ${promoted} investor(s) whose documents were already approved: ` +
                   promote.rows.slice(0, 20).map(r => r.id).join(', ') + (promoted > 20 ? ' …' : ''));
    }

    /* 2. Investor verified, KYC ticket still open. Matched on a predicate, not
       a list of category names — the portal's own quick-ticket uses 'fica_kyc',
       which no list here ever included. */
    const close = await pool.query(`
      UPDATE support_tickets t
         SET status         = 'resolved',
             admin_response = CASE
               WHEN t.admin_response IS NULL OR t.admin_response = ''
                 THEN $1 ELSE t.admin_response || E'\n' || $1 END,
             responded_at   = COALESCE(t.responded_at, NOW()),
             updated_at     = NOW()
       WHERE ${KYC_TICKET_OPEN.replace(/\bstatus\b/g, 't.status')}
         AND ${KYC_TICKET_MATCH.replace(/\bcategory\b/g, 't.category')}
         AND EXISTS (SELECT 1 FROM investors i
                      WHERE i.id = t.investor_id AND i.fica_status = 'approved')
       RETURNING t.id`,
      ['[System] All KYC/FICA documents have been verified and approved. Account is now active.']);
    resolved = close.rowCount;
    if (resolved) {
      console.warn(`[kycReconcile] resolved ${resolved} KYC ticket(s) left open for already-verified investors: ` +
                   close.rows.slice(0, 20).map(r => r.id).join(', ') + (resolved > 20 ? ' …' : ''));
    }

    /* Silence is the expected state. Anything found here is drift the approval
       path should have handled, so it is worth saying so rather than counting
       it as routine work done. */
    if (!promoted && !resolved) {
      console.log(`[kycReconcile] nothing to reconcile (${Date.now() - started}ms).`);
    } else {
      console.warn(`[kycReconcile] corrected ${promoted} investor(s) and ${resolved} ticket(s) — ` +
                   'these should have been handled at approval time.');
    }
  } catch (err) {
    console.error('[kycReconcile] failed:', err.message);
  }

  return { promoted, resolved };
}

function startKycReconcile() {
  // Hourly. Two narrow UPDATEs, so the cost is close to nothing, and an hour
  // is short enough that a client rarely sees the inconsistent state.
  cron.schedule('17 * * * *', () => {
    runKycReconcile().catch(e => console.error('[kycReconcile] unhandled:', e.message));
  }, { timezone: 'UTC' });
  console.log('[kycReconcile] scheduled hourly at :17 UTC');
}

module.exports = { startKycReconcile, runKycReconcile };
