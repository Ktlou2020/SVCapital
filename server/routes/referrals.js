/* ═══════════════════════════════════════════════════════════
   GET /api/referrals/my — this investor's referral code, link and signups

   The portal's Refer & Earn dashboard used to build its stats from
   PORTAL.investors, filtering for `referred_by === myCode`. That array is
   never populated in the investor portal — an investor only ever loads their
   own record — so Total / Approved / Invested read zero no matter how many
   people had actually signed up.

   The referred investors are people this investor personally invited, so
   naming them back is reasonable. How much they invested is not: that is
   reduced to a yes/no, and nothing else about them is returned.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

router.get('/my', requireAuth, async (req, res) => {
  const investorId = req.user.investorId || req.user.sub;
  if (!investorId) return res.status(400).json({ error: 'No investorId on token.' });

  try {
    const { rows: me } = await pool.query(
      'SELECT referral_code FROM investors WHERE id = $1',
      [investorId]
    );
    const code = me[0]?.referral_code || null;

    if (!code) {
      return res.json({ code: null, total: 0, approved: 0, invested: 0, referrals: [] });
    }

    const { rows } = await pool.query(
      `SELECT first_name, last_name, status, fica_status, date_joined,
              (COALESCE(total_invested, 0) > 0) AS has_invested
         FROM investors
        WHERE referred_by = $1
        ORDER BY date_joined DESC NULLS LAST
        LIMIT 200`,
      [code]
    );

    const referrals = rows.map(r => ({
      firstName:  r.first_name || '',
      lastName:   r.last_name  || '',
      status:     r.fica_status || r.status || null,
      // Deliberately a boolean — another investor's balance is not this
      // investor's business, only whether the referral converted.
      invested:   !!r.has_invested,
      joinedAt:   r.date_joined || null,
    }));

    const { REFERRAL_XP } = require('./quests');

    res.json({
      code,
      total:    referrals.length,
      // Points, not rand — the programme rewards XP only.
      pointsPerReferral: REFERRAL_XP,
      pointsEarned:      referrals.length * REFERRAL_XP,
      // "Approved" mirrors what the dashboard already counted: anyone past the
      // pending/suspended states.
      approved: referrals.filter(r => !['pending_fica', 'suspended'].includes(r.status)).length,
      invested: referrals.filter(r => r.invested).length,
      referrals,
    });
  } catch (err) {
    console.error('[referrals/my] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
