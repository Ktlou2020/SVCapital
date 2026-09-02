/* ═══════════════════════════════════════════════════════
   Investor Gamification — Quests & XP
   GET  /api/quests/my       — list quests + investor XP status
   POST /api/quests/complete — complete a quest, award XP, level-up bonus
   ═══════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

/* ─── XP Level thresholds ─── */
const XP_LEVELS = [
  { id: 'seed',       label: 'Seed',       min: 0    },
  { id: 'sprout',     label: 'Sprout',     min: 100  },
  { id: 'grower',     label: 'Grower',     min: 300  },
  { id: 'cultivator', label: 'Cultivator', min: 600  },
  { id: 'harvester',  label: 'Harvester',  min: 1000 },
  { id: 'pioneer',    label: 'Pioneer',    min: 1500 },
  { id: 'architect',  label: 'Architect',  min: 2500 },
  { id: 'luminary',   label: 'Luminary',   min: 5000 },
];

function getLevelForXP(xp) {
  let level = XP_LEVELS[0];
  for (const l of XP_LEVELS) {
    if (xp >= l.min) level = l;
    else break;
  }
  return level;
}


/* LIFETIME INVESTED — one definition, two callers.
 *
 * investors.total_invested is a running total that is only ever incremented
 * when an investment is made. It is never reduced at maturity, so it IS a
 * lifetime figure — but it is also blank on accounts migrated in without one,
 * and those clients are not new: they have years of investments behind them.
 *
 * Taking the greater of the stored total and the sum over investments cannot
 * invent money — both are evidence of capital actually placed — and it is what
 * the milestone badges have always used. The leaderboard read the stored column
 * on its own and showed R0,00 against clients who had earned the R10k, R50k and
 * R100k badges, which the same page was displaying two columns to the left. */
const LIFETIME_INVESTED_SQL = `GREATEST(
    COALESCE(i.total_invested, 0),
    COALESCE((SELECT SUM(amount) FROM investments
               WHERE investor_id = i.id AND COALESCE(status,'') <> 'cancelled'), 0))`;

/* ─── Quest catalogue ─────────────────────────────────── */
const QUESTS = [
  // Profile & Compliance — data collection surveys
  {
    id: 'complete_profile', title: 'Complete Your Profile',
    category: 'profile', xp: 75, icon: 'fa-user-check', color: '#656565',
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
    category: 'profile', xp: 100, icon: 'fa-shield-halved', color: '#eda5ff',
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
    category: 'profile', xp: 75, icon: 'fa-crosshairs', color: '#fec24f',
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
    category: 'profile', xp: 75, icon: 'fa-briefcase', color: '#fec24f',
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
  { id: 'complete_tour',  title: 'Take the Platform Tour',    category: 'milestone', xp: 100, icon: 'fa-map',               color: '#fec24f', description: 'Complete the guided portal tour to learn your way around.' },
  { id: 'first_topup',    title: 'First Wallet Top-up',       category: 'milestone', xp: 50,  icon: 'fa-wallet',            color: '#fec24f', description: 'Fund your wallet for the first time.' },
  { id: 'first_investment', title: 'First Investment',        category: 'milestone', xp: 100, icon: 'fa-arrow-trend-up',   color: '#65ed00', description: 'Make your very first investment with SV Capital.' },
  { id: 'diversify',      title: 'Diversify Your Portfolio',  category: 'milestone', xp: 150, icon: 'fa-chart-pie',         color: '#fec24f', description: 'Invest across 2 or more different product types.' },
  { id: 'milestone_10k',  title: 'R10,000 Invested',          category: 'milestone', xp: 100, icon: 'fa-money-bill-wave',   color: '#65ed00', description: 'Reach R10,000 in total investments.' },
  { id: 'milestone_50k',  title: 'R50,000 Invested',          category: 'milestone', xp: 150, icon: 'fa-gem',               color: '#eda5ff', description: 'Join the R50k investment club.' },
  { id: 'milestone_100k', title: 'R100,000 Invested',         category: 'milestone', xp: 200, icon: 'fa-crown',             color: '#fec24f', description: 'Reach R100,000 in total investments.' },
  { id: 'set_maturity',   title: 'Set Maturity Instructions', category: 'milestone', xp: 75,  icon: 'fa-hourglass-half',    color: '#fec24f', description: 'Configure what happens when your investment matures.' },
  { id: 'first_referral', title: 'Refer Your First Friend',   category: 'milestone', xp: 100, icon: 'fa-share-nodes',       color: '#0096ff', description: 'Get someone to join SV Capital via your referral link.' },
  // Community
  { id: 'leave_feedback', title: 'Leave Us a Review', category: 'community', xp: 50, icon: 'fa-star', color: '#fec24f', description: 'Share your experience with SV Capital to help other investors.' },
  // Learning Modules — marked complete by investor
  { id: 'learn_what_is_svc',      title: 'What is SV Capital?',       category: 'learning', xp: 50, icon: 'fa-building-columns', color: '#0096ff' },
  { id: 'learn_how_returns',      title: 'How Your Returns Work',      category: 'learning', xp: 50, icon: 'fa-percent',          color: '#65ed00' },
  { id: 'learn_solar',            title: 'Solar Energy Investing',     category: 'learning', xp: 50, icon: 'fa-solar-panel',      color: '#fec24f' },
  { id: 'learn_cattle',           title: 'Cattle & Short-term Loans',  category: 'learning', xp: 50, icon: 'fa-cow',              color: '#eda5ff' },
  { id: 'learn_diversification',  title: 'Diversification 101',        category: 'learning', xp: 50, icon: 'fa-chart-pie',        color: '#fec24f' },
  { id: 'learn_risk',             title: 'Risk vs Return',             category: 'learning', xp: 50, icon: 'fa-scale-balanced',   color: '#eda5ff' },
  { id: 'learn_compounding',      title: 'The Compounding Effect',     category: 'learning', xp: 50, icon: 'fa-chart-line',       color: '#65ed00' },
  { id: 'learn_tax',              title: 'Investment Tax in SA',       category: 'learning', xp: 50, icon: 'fa-receipt',          color: '#fec24f' },
  /* The Learning Hub's two strategist modules. They were missing here, and
     /complete answers 404 for a quest id it does not know — so a client who
     finished them was told "Quest not found" and paid no XP, and the Hub could
     not be completed at all. The ids and the 50 XP are the modules' own, from
     LEARN_MODULES; check-rewards-catalogue keeps the two lists in step. */
  { id: 'learn_yield_opt',        title: 'Yield Optimisation',         category: 'learning', xp: 50, icon: 'fa-chart-line',       color: '#fec24f' },
  { id: 'learn_estate',           title: 'Protecting Your Investment Wealth', category: 'learning', xp: 50, icon: 'fa-people-roof', color: '#22c55e' },
];

/* ────────────────────────────────────────────────────────
   GET /api/quests/my
   ──────────────────────────────────────────────────────── */
router.get('/my', requireAuth, async (req, res) => {
  const investorId = req.user.investorId || req.user.sub;
  if (!investorId) return res.status(400).json({ error: 'No investorId on token.' });

  try {
    const [cmpRes, invRes, refRes] = await Promise.all([
      pool.query(
        'SELECT quest_id, completed_at, xp_awarded, data FROM quest_completions WHERE investor_id = $1',
        [investorId]
      ),
      pool.query(
        'SELECT xp_points, xp_level, investor_profile FROM investors WHERE id = $1',
        [investorId]
      ),
      /* The portal cannot see who signed up under this investor's code — it
         only ever loads its own investor — so the Refer Your First Friend
         condition is unknowable client-side. Send the count with the quests. */
      pool.query(
        `SELECT COUNT(*)::int AS n FROM investors
          WHERE referred_by IS NOT NULL AND referred_by <> ''
            AND referred_by = (SELECT referral_code FROM investors WHERE id = $1)`,
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
      referralCount: refRes.rows[0]?.n || 0,
    });
  } catch (err) {
    console.error('[Quests GET] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ────────────────────────────────────────────────────────
   POST /api/quests/complete
   Body: { questId, data: {} }
   ──────────────────────────────────────────────────────── */
router.post('/complete', requireAuth, async (req, res) => {
  const investorId = req.user.investorId || req.user.sub;
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

    /* ── Milestone verification ──────────────────────────────────────────
       These badges read as lifetime achievements — "R50,000 Invested", "Join
       the R50k club" — so they are earned once and kept. The check used to
       sum only status='active', which meant an investor whose investments had
       matured could no longer claim one, and an already-claimed badge was
       simply unreachable for anyone whose money had cycled.

       Two sources, whichever is higher:
         investors.total_invested — only ever incremented when an investment is
           made, never reduced at maturity, so it is already a lifetime total
           and it is the figure the portal itself shows.
         SUM over investments — the ledger, excluding cancelled, which covers
           investors migrated in without a running total.
       Taking the greater of the two cannot invent a milestone: both are
       evidence of money actually invested.
       ─────────────────────────────────────────────────────────────────── */
    const MILESTONE_AMOUNTS = { milestone_10k: 10000, milestone_50k: 50000, milestone_100k: 100000, milestone_250k: 250000 };

    if (MILESTONE_AMOUNTS[questId]) {
      const { rows } = await pool.query(
        /* The same rule the leaderboard reads — see LIFETIME_INVESTED_SQL. */
        `SELECT ${LIFETIME_INVESTED_SQL} AS lifetime FROM investors i WHERE i.id = $1`,
        [investorId]
      );
      const lifetime = parseFloat(rows[0].lifetime) || 0;
      if (lifetime < MILESTONE_AMOUNTS[questId]) {
        return res.status(403).json({ error: 'Milestone requirement not met.' });
      }
    }

    /* Set Maturity Instructions — met once any investment carries one. Nothing
       verified this before, and nothing ever asked to complete it either, so
       the badge was unreachable however many instructions were set. */
    if (questId === 'set_maturity') {
      const { rows } = await pool.query(
        `SELECT 1 FROM investments
          WHERE investor_id = $1 AND maturity_instruction IS NOT NULL
            AND maturity_instruction <> '' LIMIT 1`,
        [investorId]
      );
      if (!rows.length) {
        return res.status(403).json({ error: 'No maturity instruction has been set yet.' });
      }
    }

    /* Refer Your First Friend — met once somebody has registered against this
       investor's referral code. Same story: never verified, never requested. */
    if (questId === 'first_referral') {
      const { rows } = await pool.query(
        `SELECT 1 FROM investors
          WHERE referred_by IS NOT NULL AND referred_by <> ''
            AND referred_by = (SELECT referral_code FROM investors WHERE id = $1)
          LIMIT 1`,
        [investorId]
      );
      if (!rows.length) {
        return res.status(403).json({ error: 'No referral has signed up yet.' });
      }
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
    const leveledUp = newLvl.id !== prevLvl.id;

    // Update investor — save direct columns + merge extra keys into investor_profile
    const ALLOWED_PROFILE_KEYS = [
      'risk_tolerance', 'investment_goal', 'experience_level', 'time_horizon',
      'survey_completed_at', 'onboarding_step',
      // risk_profile_survey
      'risk_reaction', 'savings_pct', 'return_preference',
      // investment_goals
      'saving_for', 'income_need', 'liquidity', 'product_interest',
      // background_survey
      'employment_status', 'income_bracket', 'dependents', 'investment_experience', 'heard_via',
    ];
    const safeData = {};
    for (const k of ALLOWED_PROFILE_KEYS) {
      if (data[k] !== undefined) safeData[k] = data[k];
    }

    if (questId === 'complete_profile') {
      // Save occupation + address to their own columns; employer/next_of_kin/kin_contact go into investor_profile JSON
      const profileExtra = {};
      if (data.employer)    profileExtra.employer    = String(data.employer).slice(0, 200);
      if (data.next_of_kin) profileExtra.next_of_kin = String(data.next_of_kin).slice(0, 200);
      if (data.kin_contact) profileExtra.kin_contact = String(data.kin_contact).slice(0, 200);
      const mergedProfile = JSON.stringify({ ...safeData, ...profileExtra });

      await pool.query(
        `UPDATE investors SET
           xp_points        = $1,
           xp_level         = $2,
           investor_profile = COALESCE(investor_profile, '{}') || $3::jsonb,
           occupation       = COALESCE(NULLIF($4,''), occupation),
           address          = COALESCE(NULLIF($5,''), address),
           updated_at       = NOW()
         WHERE id = $6`,
        [newXP, newLvl.id, mergedProfile,
         data.occupation ? String(data.occupation).slice(0, 200) : '',
         data.address    ? String(data.address).slice(0, 500)    : '',
         investorId]
      );
    } else {
      await pool.query(
        `UPDATE investors SET
           xp_points        = $1,
           xp_level         = $2,
           investor_profile = COALESCE(investor_profile, '{}') || $3::jsonb,
           updated_at       = NOW()
         WHERE id = $4`,
        [newXP, newLvl.id, JSON.stringify(safeData), investorId]
      );
    }

    const nextLevel = XP_LEVELS.find(l => l.min > newXP) || null;
    console.log(`[Quests] ${investorId} completed ${questId} +${quest.xp}XP → ${newLvl.id}`);

    res.json({
      success: true, xpAwarded: quest.xp, newXP,
      prevLevel: prevLvl.id, newLevel: newLvl.id,
      leveledUp, rewardGiven: 0, nextLevel,
      xpToNext: nextLevel ? nextLevel.min - newXP : 0,
    });
  } catch (err) {
    console.error('[Quests POST] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* Referring is rewarded in XP, not cash. Exported so the registration route
   awards it using this file's level thresholds rather than a second copy of
   them — the duplicate-definition habit is what put three different milestone
   maps in the portal and left two badges permanently locked. */
const REFERRAL_XP = 100;

/* ═══════════════════════════════════════════════════════════
   GET /api/quests/leaderboard   — admin, director, staff
   Every investor's standing, ranked. Computed here because this is where the
   ladder and the catalogue live; a second copy of either would be a second
   answer to "what level is this client".
   ═══════════════════════════════════════════════════════════ */
router.get('/leaderboard', requireAuth, requireRole('admin', 'director', 'staff'), async (req, res) => {
  try {
    const LEARNING_IDS  = QUESTS.filter(q => q.category === 'learning').map(q => q.id);
    const XP_AVAILABLE  = QUESTS.reduce((s, q) => s + (q.xp || 0), 0);

    /* One pass. Counting quests per investor in SQL rather than pulling every
       completion row keeps this the same shape whether the book is fifty
       clients or fifty thousand. */
    const { rows } = await pool.query(
      `SELECT i.id, i.first_name, i.last_name, i.email, i.kyc_status, i.status,
              i.date_joined,
              ${LIFETIME_INVESTED_SQL} AS total_invested,
              COALESCE(i.xp_points, 0) AS xp_points,
              i.xp_level AS stored_level,
              COALESCE(c.done, 0)         AS quests_completed,
              COALESCE(c.learning, 0)     AS learning_completed,
              COALESCE(c.xp_awarded, 0)   AS xp_from_quests,
              c.last_completed_at
         FROM investors i
         LEFT JOIN (
           SELECT investor_id,
                  COUNT(*)                                        AS done,
                  COUNT(*) FILTER (WHERE quest_id = ANY($1::text[])) AS learning,
                  SUM(COALESCE(xp_awarded, 0))                    AS xp_awarded,
                  MAX(completed_at)                               AS last_completed_at
             FROM quest_completions
            GROUP BY investor_id
         ) c ON c.investor_id = i.id
        WHERE COALESCE(i.status, 'active') <> 'archived'`,
      [LEARNING_IDS]);

    const num = v => Number(v) || 0;
    const investors = rows.map(r => {
      const xp    = num(r.xp_points);
      const level = getLevelForXP(xp);
      const next  = XP_LEVELS.find(l => l.min > xp) || null;
      const span  = next ? next.min - level.min : 0;
      return {
        id: r.id,
        name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || r.id,
        email: r.email,
        kyc_status: r.kyc_status,
        date_joined: r.date_joined,
        total_invested: num(r.total_invested),
        xp,
        level_id: level.id,
        level_label: level.label,
        level_index: XP_LEVELS.findIndex(l => l.id === level.id),
        next_level: next ? next.label : null,
        xp_to_next: next ? next.min - xp : 0,
        /* How far through the current level, for a progress bar that means
           something at every level rather than only the first. */
        level_progress: span > 0 ? Math.round(((xp - level.min) / span) * 100) : 100,
        quests_completed:   num(r.quests_completed),
        learning_completed: num(r.learning_completed),
        last_activity: r.last_completed_at,
        /* Reported, not reconciled. investors.xp_level is a stored copy and
           xp_points is a running total; either can drift from the completions
           that produced them, and a leaderboard that quietly papers over that
           is a leaderboard nobody can audit. */
        stored_level: r.stored_level || null,
        level_drifted: !!r.stored_level && r.stored_level !== level.id,
        xp_from_quests: num(r.xp_from_quests),
        xp_drifted: num(r.xp_from_quests) !== xp,
      };
    });

    /* Rank on XP, ties broken by who got there first — two clients on the same
       score should not swap places between one page load and the next. */
    investors.sort((a, b) => b.xp - a.xp ||
      new Date(a.last_activity || a.date_joined || 0) - new Date(b.last_activity || b.date_joined || 0));
    let rank = 0, seen = 0, lastXp = null;
    for (const inv of investors) {
      seen++;
      if (inv.xp !== lastXp) { rank = seen; lastXp = inv.xp; }
      inv.rank = rank;                    // equal scores share a rank
    }

    /* How many clients have finished each quest. A quest nobody completes is
       the most useful row on the page — it is either too hard, unreachable, or
       missing from the catalogue the client is served — and it only shows up
       if it is counted rather than inferred from an absence. */
    const { rows: perQuest } = await pool.query(
      `SELECT quest_id, COUNT(*)::int AS done, SUM(COALESCE(xp_awarded,0))::int AS xp
         FROM quest_completions GROUP BY quest_id`);
    const doneBy = Object.fromEntries(perQuest.map(r => [r.quest_id, r]));
    const catalogue = QUESTS.map(q => ({
      id: q.id, title: q.title, category: q.category, xp: q.xp,
      completed_by: (doneBy[q.id] || {}).done || 0,
    }));
    /* Completions whose quest is no longer in the catalogue. They happened and
       they were paid; hiding them would make the XP totals unexplainable. */
    const orphaned = perQuest
      .filter(r => !QUESTS.some(q => q.id === r.quest_id))
      .map(r => ({ id: r.quest_id, title: r.quest_id, category: 'unknown', xp: 0,
                   completed_by: r.done, orphaned: true }));

    res.json({
      levels: XP_LEVELS,
      learning_total: LEARNING_IDS.length,
      xp_available: XP_AVAILABLE,
      quest_total: QUESTS.length,
      catalogue,
      orphaned_quests: orphaned,
      investors,
    });
  } catch (e) {
    console.error('[quests/leaderboard]', e.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* GET /api/quests/investor/:id — one client's standing, for the console's
   investor overview. Same ladder, same catalogue, same computation as the
   leaderboard; only the shape differs. */
router.get('/investor/:id', requireAuth, requireRole('admin', 'director', 'staff'), async (req, res) => {
  try {
    const investorId = req.params.id;
    const LEARNING_IDS = QUESTS.filter(q => q.category === 'learning').map(q => q.id);

    const [invRes, compRes] = await Promise.all([
      pool.query('SELECT id, first_name, last_name, xp_points, xp_level, total_invested FROM investors WHERE id = $1', [investorId]),
      pool.query('SELECT quest_id, xp_awarded, completed_at FROM quest_completions WHERE investor_id = $1 ORDER BY completed_at DESC', [investorId]),
    ]);
    if (!invRes.rows[0]) return res.status(404).json({ error: 'Investor not found.' });

    const inv   = invRes.rows[0];
    const xp    = Number(inv.xp_points) || 0;
    const level = getLevelForXP(xp);
    const next  = XP_LEVELS.find(l => l.min > xp) || null;
    const span  = next ? next.min - level.min : 0;

    const byId = Object.fromEntries(QUESTS.map(q => [q.id, q]));
    const completions = compRes.rows.map(r => ({
      quest_id: r.quest_id,
      /* A completion whose quest is no longer in the catalogue still happened
         and still counts; it is named as unknown rather than dropped. */
      title:    (byId[r.quest_id] || {}).title    || r.quest_id,
      category: (byId[r.quest_id] || {}).category || 'unknown',
      xp_awarded: Number(r.xp_awarded) || 0,
      completed_at: r.completed_at,
    }));

    const learningDone = completions.filter(c => LEARNING_IDS.includes(c.quest_id)).length;

    res.json({
      investor_id: inv.id,
      xp,
      level_id: level.id, level_label: level.label,
      level_index: XP_LEVELS.findIndex(l => l.id === level.id),
      level_count: XP_LEVELS.length,
      next_level: next ? next.label : null,
      xp_to_next: next ? next.min - xp : 0,
      level_progress: span > 0 ? Math.round(((xp - level.min) / span) * 100) : 100,
      stored_level: inv.xp_level || null,
      level_drifted: !!inv.xp_level && inv.xp_level !== level.id,
      learning_completed: learningDone,
      learning_total: LEARNING_IDS.length,
      quests_completed: completions.length,
      quest_total: QUESTS.length,
      completions,
      levels: XP_LEVELS,
    });
  } catch (e) {
    console.error('[quests/investor]', e.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
module.exports.XP_LEVELS     = XP_LEVELS;
module.exports.getLevelForXP = getLevelForXP;
module.exports.REFERRAL_XP   = REFERRAL_XP;
module.exports.QUESTS        = QUESTS;
