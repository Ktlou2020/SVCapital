/* ═══════════════════════════════════════════════════════════
   Sub-accounts — /api/sub-accounts
   Requires role: admin | director
   ═══════════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordTransaction, actorFromRequest } = require('../services/ledger');
const audit  = require('../services/audit');

router.use(requireAuth, requireRole('admin', 'director'));

/* Close a minor's sub-account and sweep what is left in it back to the
 * person who opened it.
 *
 * MINORS ONLY, and the refusal is deliberate rather than a filter on the
 * button. A stokvel is held by its members and governed by a mandate — a
 * staff member closing one and moving the pot to the chairperson's personal
 * wallet would be taking a group's money on one person's say-so, which is
 * exactly what the mandate exists to prevent. A trust and a business are
 * separate legal persons for the same reason. A minor's account is the one
 * case where the parent genuinely IS the account holder, so sweeping to
 * them returns the money to whose it already was.
 *
 * WHERE THE MONEY GOES is not a choice this endpoint offers. It goes to
 * parent_investor_id — the person who opened the account — because any
 * other destination is a staff member deciding where a client's money
 * should land.
 *
 * IT REFUSES WHILE INVESTMENTS ARE LIVE. The wallet balance is only the
 * uninvested part; capital in an open pool is not here to sweep, and
 * closing the account around it would leave investments belonging to an
 * account that no longer exists. Mature or withdraw them first.
 */
router.post('/:id/close', async (req, res) => {
  const saId   = String(req.params.id || '');
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* FOR UPDATE is what makes a second click harmless. Without it two
       requests both read 'active', both sweep the balance, and the parent
       is credited twice for money that existed once. */
    const { rows: [sa] } = await client.query(
      `SELECT id, name, account_type, status, parent_investor_id,
              COALESCE(wallet_balance, 0) AS wallet_balance
         FROM sub_accounts WHERE id = $1 FOR UPDATE`, [saId]);

    if (!sa) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sub-account not found.' });
    }
    if (String(sa.account_type || '').toLowerCase() !== 'minor') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Only minor accounts can be closed here. A group, trust or business '
             + 'account is held by its members or is a separate legal person, and its '
             + 'money is not the parent account holder\'s to receive.' });
    }
    if (String(sa.status || '') === 'closed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That account is already closed.' });
    }
    if (!sa.parent_investor_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'That account has no parent account holder, so there is nowhere to '
             + 'return its balance to.' });
    }

    const { rows: [live] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM investments
        WHERE sub_account_id = $1 AND COALESCE(status, '') IN ('active', 'pending')`, [saId]);
    if (live.n > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `That account still holds ${live.n} investment${live.n === 1 ? '' : 's'}. `
             + 'Mature or withdraw them before closing it — the wallet balance is only '
             + 'the uninvested part.' });
    }

    const { rows: [parent] } = await client.query(
      'SELECT id, first_name, last_name FROM investors WHERE id = $1 FOR UPDATE',
      [sa.parent_investor_id]);
    if (!parent) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The parent account holder no longer exists.' });
    }

    const swept = Math.round((Number(sa.wallet_balance) || 0) * 100) / 100;
    const actor = actorFromRequest(req, 'staff');

    if (swept > 0) {
      const reference = 'SAC-' + require('crypto').randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
      const parentName = `${parent.first_name || ''} ${parent.last_name || ''}`.trim() || parent.id;

      /* Zeroed by subtracting the figure that was read under the lock, not
         by `= 0`: if anything landed between the read and here, assigning
         zero would swallow it. */
      await client.query(
        `UPDATE sub_accounts SET wallet_balance = wallet_balance - $1, updated_at = NOW()
          WHERE id = $2`, [swept, saId]);
      await client.query(
        `UPDATE investors SET wallet_balance = COALESCE(wallet_balance, 0) + $1, updated_at = NOW()
          WHERE id = $2`, [swept, parent.id]);

      /* The same two types the parent→sub-account transfer already uses,
         in the other direction: out of the sub-account, into the main
         wallet. One vocabulary for one movement. */
      await recordTransaction(client, {
        investorId: parent.id, subAccountId: saId,
        type: 'transfer_out', amount: swept, reference,
        description: `Closing ${sa.name} — balance returned to ${parentName}`,
      }, actor);
      await recordTransaction(client, {
        investorId: parent.id, subAccountId: null,
        type: 'transfer_in', amount: swept, reference: reference + '-IN',
        description: `Balance returned from ${sa.name} on closure`,
      }, actor);
    }

    await client.query(
      `UPDATE sub_accounts SET status = 'closed', closed_at = NOW(), updated_at = NOW()
        WHERE id = $1`, [saId]);

    await client.query('COMMIT');

    await audit.log({
      actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
      action: 'sub_account.closed', entityType: 'sub_accounts', entityId: saId,
      description: `Closed minor account ${sa.name} (${saId})`
                 + (swept > 0 ? ` and returned R${swept.toFixed(2)} to ${parent.id}` : ' with a zero balance')
                 + (reason ? ` — ${reason}` : ''),
      before: { status: sa.status, wallet_balance: sa.wallet_balance },
      after:  { status: 'closed', wallet_balance: 0 },
      ip: actor.ip,
    }).catch(err => console.error('[sub-account close] audit failed:', err.message));

    res.json({ success: true, swept, parentInvestorId: parent.id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[sub-account close]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

module.exports = router;
