'use strict';
/* Deposits left Pending by a decline that only closed the ticket.
 *
 * The portal pre-creates a pending deposit row when an investor submits proof
 * of payment. The console's EFT decline updated the support ticket and nothing
 * else, so that row stayed 'pending' forever: the client was told their proof
 * was rejected and went on seeing the deposit as Pending in their transactions.
 * Fixed going forward by POST /api/admin/eft-decline; this finds the rows
 * already stranded.
 *
 * HOW ONE IS IDENTIFIED
 *
 * A payment_proof ticket that is resolved, whose deposit is still pending. Had
 * it been approved the deposit would read 'completed', so a resolved ticket
 * over a pending deposit means the ticket was actioned and the deposit was not.
 *
 * That is necessary but not sufficient, and the difference decides whether a
 * client is owed an explanation or owed money, so candidates are split by what
 * the admin actually told them:
 *
 *   DECLINED   the response says declined or rejected. The client has been told
 *              the money is not coming; marking the deposit rejected agrees
 *              with that. The only group that is ever written.
 *   APPROVED   the response says approved or credited — an approval that did
 *              not finish. The client may genuinely have paid, so marking it
 *              rejected would be the opposite of the truth. NEVER written.
 *   UNCLEAR    no response, or one that says neither. A person reads it.
 *
 * The CLI report and the ops console both run this, so the two cannot disagree
 * about which group a client falls into.
 */

/* The reference the portal writes onto both the ticket subject and the deposit.
   Falling back to the ticket id matches what eft-approve and eft-decline do. */
const FIND = `
  SELECT t.id            AS ticket_id,
         t.investor_id,
         t.subject,
         t.admin_response,
         t.responded_at,
         x.id            AS deposit_id,
         x.amount,
         x.status        AS deposit_status,
         x.reference,
         x.created_at    AS deposit_created,
         i.first_name, i.last_name, i.email
    FROM support_tickets t
    JOIN transactions x
      ON x.investor_id = t.investor_id
     AND x.type = 'deposit'
     AND x.reference = COALESCE(substring(t.subject from 'EFT-[[:alnum:]_]+'), t.id)
    LEFT JOIN investors i ON i.id = t.investor_id
   WHERE t.category = 'payment_proof'
     AND t.status IN ('resolved', 'closed')
     AND x.status = 'pending'
   ORDER BY t.responded_at NULLS LAST, x.created_at`;

const BACKFILL_NOTE =
  'EFT deposit declined by admin — closed by backfill, the ticket was declined but the deposit was left pending.';

function classify(row) {
  const r = String(row.admin_response || '').toLowerCase();
  if (/declin|reject|resubmit/.test(r)) return 'DECLINED';
  if (/approv|credit/.test(r))          return 'APPROVED';
  return 'UNCLEAR';
}

const num = v => Number(v || 0);
const round2 = n => Math.round(n * 100) / 100;

async function findStrandedEftDeposits(db) {
  const { rows } = await db.query(FIND);

  const groups = { DECLINED: [], APPROVED: [], UNCLEAR: [] };
  for (const r of rows) {
    groups[classify(r)].push({
      ticketId:   r.ticket_id,
      depositId:  r.deposit_id,
      investorId: r.investor_id,
      name:       `${r.first_name || ''} ${r.last_name || ''}`.trim() || null,
      email:      r.email || null,
      reference:  r.reference,
      amount:     num(r.amount),
      respondedAt: r.responded_at,
      depositCreated: r.deposit_created,
      adminResponse: r.admin_response || null,
    });
  }

  const total = g => round2(groups[g].reduce((s, r) => s + r.amount, 0));
  return {
    groups,
    totals: {
      declined:  { n: groups.DECLINED.length, value: total('DECLINED') },
      approved:  { n: groups.APPROVED.length, value: total('APPROVED') },
      unclear:   { n: groups.UNCLEAR.length,  value: total('UNCLEAR') },
    },
    count: rows.length,
    verdict: rows.length ? 'found' : 'clean',
  };
}

/* Closes the DECLINED group and nothing else.
 *
 * The ids are re-derived here from the same query rather than taken from the
 * caller. A console that posted a list of ids could close an APPROVED one by
 * sending it — deliberately or through a stale page — and the guarantee that
 * this group is never written has to hold at the place that writes, not at the
 * place that renders.
 *
 * A credited deposit is protected TWICE, deliberately: the query above only
 * returns rows still at 'pending', and the UPDATE repeats the condition. Either
 * one alone is enough — mutation-tested, removing one still holds and removing
 * both does not — and that is the point. The second is what stands between a
 * stale caller and a credited deposit marked refused, the day someone changes
 * this to accept ids from outside. */
async function closeDeclinedEftDeposits(db) {
  const report = await findStrandedEftDeposits(db);
  const ids = report.groups.DECLINED.map(r => r.depositId);
  if (!ids.length) return { closed: 0, report };

  const { rowCount } = await db.query(
    `UPDATE transactions
        SET status = 'rejected',
            description = CASE WHEN COALESCE(description, '') = '' THEN $2
                               ELSE description || ' | ' || $2 END,
            updated_at = NOW()
      WHERE id = ANY($1::text[])
        AND status = 'pending'`,
    [ids, BACKFILL_NOTE]);

  return { closed: rowCount, report };
}

module.exports = { findStrandedEftDeposits, closeDeclinedEftDeposits, classify, BACKFILL_NOTE };
