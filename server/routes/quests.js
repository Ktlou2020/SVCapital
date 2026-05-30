/* ═══════════════════════════════════════════════════════
   Investor Gamification — Quests & XP
   GET  /api/quests/my       — list quests + investor XP status
   POST /api/quests/complete — complete a quest, award XP, level-up bonus
   ═══════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

/* ─── XP Level thresholds — each level-up pays R50 ─── */
const XP_LEVELS = [
  { id: 'seed',       label: 'Seed',       min: 0,    reward: 0  },
  { id: 'sprout',     label: 'Sprout',     min: 100,  reward: 50 },
  { id: 'grower',     label: 'Grower',     min: 300,  reward: 50 },
  { id: 'cultivator', label: 'Cultivator', min: 600,  reward: 50 },
  { id: 'harvester',  label: 'Harvester',  min: 1000, reward: 50 },
  { id: 'pioneer',    label: 'Pioneer',    min: 1500, reward: 50 },
  { id: 'architect',  label: 'Architect',  min: 2500, reward: 50 },
  { id: 'luminary',   label: 'Luminary',   min: 5000, reward: 50 },
];

function getLevelForXP(xp) {
  let level = XP_LEVELS[0];
  for (const l of XP_LEVELS) {
    if (xp >= l.min) level = l;
    else break;
  }
  return level;
}

/* ─── Quest catalogue ─────────────────────────────────── */
const QUESTS = [
  // Profile & Compliance — data collection surveys
  {
    id: 'complete_profile', title: 'Complete Your Profile',
    category: 'profile', xp: 75, icon: 'fa-user-check', color: '#2F8C9B',
    description: 'Add your occupation, employer, and full residential address.',
    type: 'survey',
    questions: [
      { id: 'occupation',    label: 'What is your occupation?',             type: 'text',   placeholder: 'e.g. Software Engineer' },
      { id: 'employer',      label: 'Who is your employer?',                type: 'text',   placeholder: 'e.g. ABC (Pty) Ltd / Self-employed' },
      { id: 'address',       label: 'What is your residential address?',    type: 'text',   placeholder: 'Street, suburb, city, postal code' },
      { id: 'next_of_kin',   label: 'Name of next of kin / beneficiary',    type: 'text',   placeholder: 'Full name' },
      { id: 'kin_contact',   label: 'Next of kin phone or email',           type: 'text',   placeholder: '+27... / email@address.com' },
    ],
  },
  {
    id: 'risk_profile_survey', title: 'Know Your Risk Profile',
    category: 'profile', xp: 100, icon: 'fa-shield-halved', color: '#a855f7',
    description: 'Help us tailor your investment recommendations to your risk appetite.',
    type: 'survey',
    questions: [
      {
        id: 'investment_goal', label: 'What is your primary investment goal?', type: 'choice',
        options: ['Capital growth', 'Regular income', 'Capital preservation', 'Balanced growth & income'],
      },
      {
        id: 'risk_reaction', label: 'If your portfolio lost 20% in a month, you would:', type: 'choice',
        options: ['Sell everything immediately', 'Sell some to reduce exposure', 'Hold and wait for recovery', 'Buy more at the lower price'],
      },
      {
        id: 'time_horizon', label: 'How long do you plan to keep money invested?', type: 'choice',
        options: ['Less than 1 year', '1–3 years', '3–7 years', '7+ years'],
      },
      {
        id: 'savings_pct', label: 'What % of your total savings are you investing with SV Capital?', type: 'choice',
        options: ['Less than 10%', '10–25%', '25–50%', 'More than 50%'],
      },
      {
        id: 'return_preference', label: 'Which scenario do you prefer?', type: 'choice',
        options: ['Stable 8% every year', 'Average 12% with some variation', 'Average 16% with higher variation', 'Maximum returns regardless of swings'],
      },
    ],
  },
  {
    id: 'investment_goals', title: 'Set Your Investment Goals',
    category: 'profile', xp: 75, icon: 'fa-bullseye-arrow', color: '#FF8215',
    description: 'Tell us what you\'re building towards so we can match the right products.',
    type: 'survey',
    questions: [
      {
        id: 'saving_for', label: 'What are you primarily investing for?', type: 'choice',
        options: ['Retirement security', "Children's education", 'Property purchase', 'Wealth building / financial freedom'],
      },
      {
        id: 'income_need', label: 'Do you need regular income from your investments?', type: 'choice',
        options: ['No — I reinvest everything', 'R500–R2,000/month', 'R2,000–R5,000/month', 'R5,000+/month'],
      },
      {
        id: 'liquidity', label: 'How important is quick access to your funds?', type: 'choice',
        options: ['Very important — I may need funds at short notice', 'Somewhat important', 'Not very important', 'Not important — long-term only'],
      },
      {
        id: 'product_interest', label: 'Which SV Capital product interests you most?', type: 'choice',
        options: ['Solar energy projects (14–18% p.a.)', 'Cattle farming (12–16% p.a.)', 'Short-term loans (10–14% p.a.)', 'Delivery bike fleet (8–12% p.a.)'],
      },
    ],
  },
  {
    id: 'background_survey', title: 'Financial Background',
    category: 'profile', xp: 75, icon: 'fa-briefcase', color: '#f59e0b',
    description: 'Share your financial background so we can serve you better.',
    type: 'survey',
    questions: [
      {
        id: 'employment_status', label: 'What is your employment status?', type: 'choice',
        options: ['Employed (full-time / part-time)', 'Self-employed / Business owner', 'Retired', 'Other'],
      },
      {
        id: 'income_bracket', label: 'Approximate gross annual income?', type: 'choice',
        options: ['Under R200,000', 'R200,000–R500,000', 'R500,000–R1,000,000', 'Over R1,000,000'],
      },
      {
        id: 'dependents', label: 'Do you have financial dependents?', type: 'choice',
        options: ['None', '1–2 dependents', '3–4 dependents', '5+ dependents'],
      },
      {
        id: 'investment_experience', label: 'How would you rate your investment experience?', type: 'choice',
        options: ['Beginner — new to investing', 'Some experience — a few years', 'Experienced — 5+ years', 'Expert / professional investor'],
      },
      {
        id: 'heard_via', label: 'How did you first hear about SV Capital?', type: 'choice',
        options: ['Friend or family referral', 'Social media', 'Financial advisor (IFA)', 'Online search / advertising'],
      },
    ],
  },
  // Investment Milestones — auto-detected from investor data
  { id: 'complete_tour',  title: 'Take the Platform Tour',    category: 'milestone', xp: 100, icon: 'fa-map',               color: '#2F8C9B', description: 'Complete the guided portal tour to learn your way around.' },
  { id: 'first_topup',    title: 'First Wallet Top-up',       category: 'milestone', xp: 50,  icon: 'fa-wallet',            color: '#2F8C9B', description: 'Fund your wallet for the first time.' },
  { id: 'first_investment', title: 'First Investment',        category: 'milestone', xp: 100, icon: 'fa-chart-line-up',     color: '#22c55e', description: 'Make your very first investment with SV Capital.' },
  { id: 'diversify',      title: 'Diversify Your Portfolio',  category: 'milestone', xp: 150, icon: 'fa-chart-pie',         color: '#FF8215', description: 'Invest across 2 or more different product types.' },
  { id: 'milestone_10k',  title: 'R10,000 Invested',          category: 'milestone', xp: 100, icon: 'fa-money-bill-trend-up', color: '#22c55e', description: 'Reach R10,000 in total investments.' },
  { id: 'milestone_50k',  title: 'R50,000 Invested',          category: 'milestone', xp: 150, icon: 'fa-gem',               color: '#a855f7', description: 'Join the R50k investment club.' },
  { id: 'milestone_100k', title: 'R100,000 Invested',         category: 'milestone', xp: 200, icon: 'fa-crown',             color: '#D4AF37', description: 'Reach R100,000 in total investments.' },
  { id: 'set_maturity',   title: 'Set Maturity Instructions', category: 'milestone', xp: 75,  icon: 'fa-hourglass-end',     color: '#f59e0b', description: 'Configure what happens when your investment matures.' },
  { id: 'first_referral', title: 'Refer Your First Friend',   category: 'milestone', xp: 100, icon: 'fa-share-nodes',       color: '#2F8C9B', description: 'Get someone to join SV Capital via your referral link.' },
  // Learning Modules — marked complete by investor
  { id: 'learn_what_is_svc',      title: 'What is SV Capital?',       category: 'learning', xp: 50, icon: 'fa-building-columns', color: '#2F8C9B' },
  { id: 'learn_how_returns',      title: 'How Your Returns Work',      category: 'learning', xp: 50, icon: 'fa-percent',          color: '#22c55e' },
  { id: 'learn_solar',            title: 'Solar Energy Investing',     category: 'learning', xp: 50, icon: 'fa-solar-panel',      color: '#f59e0b' },
  { id: 'learn_cattle',           title: 'Cattle & Short-term Loans',  category: 'learning', xp: 50, icon: 'fa-cow',              color: '#a855f7' },
  { id: 'learn_diversification',  title: 'Diversification 101',        category: 'learning', xp: 50, icon: 'fa-chart-pie',        color: '#FF8215' },
  { id: 'learn_risk',             title: 'Risk vs Return',             category: 'learning', xp: 50, icon: 'fa-scale-balanced',   color: '#a855f7' },
  { id: 'learn_compounding',      title: 'The Compounding Effect',     category: 'learning', xp: 50, icon: 'fa-chart-line',       color: '#22c55e' },
  { id: 'learn_tax',              title: 'Investment Tax in SA',       category: 'learning', xp: 50, icon: 'fa-receipt',          color: '#64748b' },
];

/* ────────────────────────────────────────────────────────
   GET /api/quests/my
   ──────────────────────────────────────────────────────── */
router.get('/my', requireAuth, async (req, res) => {
  const investorId = req.user.investorId;
  if (!investorId) return res.status(400).json({ error: 'No investorId on token.' });

  try {
    const [cmpRes, invRes] = await Promise.all([
      pool.query(
        'SELECT quest_id, completed_at, xp_awarded, data FROM quest_completions WHERE investor_id = $1',
        [investorId]
      ),
      pool.query(
        'SELECT xp_points, xp_level, investor_profile FROM investors WHERE id = $1',
        [investorId]
      ),
    ]);

    const xp      = invRes.rows[0]?.xp_points        || 0;
    const level   = invRes.rows[0]?.xp_level         || 'seed';
    const profile = invRes.rows[0]?.investor_profile || {};

    const currentLevel = getLevelForXP(xp);
    const nextLevel    = XP_LEVELS.find(l => l.min > xp) || null;

    res.json({
      xp, level, currentLevel, nextLevel,
      xpToNext:    nextLevel ? nextLevel.min - xp : 0,
      completions: cmpRes.rows,
      completedIds: cmpRes.rows.map(c => c.quest_id),
      quests:      QUESTS,
      levels:      XP_LEVELS,
      profile,
    });
  } catch (err) {
    console.error('[Quests GET] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────────────────
   POST /api/quests/complete
   Body: { questId, data: {} }
   ──────────────────────────────────────────────────────── */
router.post('/complete', requireAuth, async (req, res) => {
  const investorId = req.user.investorId;
  if (!investorId) return res.status(400).json({ error: 'No investorId on token.' });

  const { questId, data = {} } = req.body || {};
  if (!questId) return res.status(400).json({ error: 'questId is required.' });

  const quest = QUESTS.find(q => q.id === questId);
  if (!quest) return res.status(404).json({ error: 'Quest not found.' });

  try {
    // Idempotency — don't double-award
    const { rows: existing } = await pool.query(
      'SELECT id FROM quest_completions WHERE investor_id = $1 AND quest_id = $2',
      [investorId, questId]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Quest already completed.' });
    }

    // Record completion
    const cId = `QC-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    await pool.query(
      `INSERT INTO quest_completions (id, investor_id, quest_id, xp_awarded, data, completed_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [cId, investorId, questId, quest.xp, JSON.stringify(data)]
    );

    // Read current XP + wallet
    const { rows: inv } = await pool.query(
      'SELECT xp_points, wallet_balance FROM investors WHERE id = $1',
      [investorId]
    );
    const prevXP  = inv[0]?.xp_points || 0;
    const newXP   = prevXP + quest.xp;
    const prevLvl = getLevelForXP(prevXP);
    const newLvl  = getLevelForXP(newXP);
    const leveledUp   = newLvl.id !== prevLvl.id;
    const rewardGiven = leveledUp ? newLvl.reward : 0;
    const newWallet   = (parseFloat(inv[0]?.wallet_balance) || 0) + rewardGiven;

    // Update investor — merge survey data into investor_profile
    await pool.query(
      `UPDATE investors SET
         xp_points          = $1,
         xp_level           = $2,
         wallet_balance      = $3,
         investor_profile    = COALESCE(investor_profile, '{}') || $4::jsonb,
         updated_at          = NOW()
       WHERE id = $5`,
      [newXP, newLvl.id, newWallet, JSON.stringify(data), investorId]
    );

    // Credit reward transaction
    if (rewardGiven > 0) {
      const txnId = `TXN-REWARD-${Date.now()}`;
      await pool.query(
        `INSERT INTO transactions (id, investor_id, type, amount, status, description, created_at)
         VALUES ($1,$2,'reward',$3,'completed',$4,NOW())`,
        [txnId, investorId, rewardGiven, `Level-up reward — ${newLvl.label} 🎉`]
      );
    }

    const nextLevel = XP_LEVELS.find(l => l.min > newXP) || null;
    console.log(`[Quests] ${investorId} completed ${questId} +${quest.xp}XP → ${newLvl.id}${leveledUp ? ` (+R${rewardGiven})` : ''}`);

    res.json({
      success: true, xpAwarded: quest.xp, newXP,
      prevLevel: prevLvl.id, newLevel: newLvl.id,
      leveledUp, rewardGiven, nextLevel,
      xpToNext: nextLevel ? nextLevel.min - newXP : 0,
    });
  } catch (err) {
    console.error('[Quests POST] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
