/* ═══════════════════════════════════════════════════════════════════
   SV INTELLIGENCE — AI Data Assistant
   Works in both Investor Portal and Admin Console.
   All analysis is done client-side using real platform data from the
   RESTful Table API. No external LLM calls — everything is rule-based
   smart analysis of actual portfolio/operations data.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

/* ─────────────────────────────────────────────────────────────────
   MODE DETECTION: 'portal' or 'admin' based on URL path
   ───────────────────────────────────────────────────────────────── */
const SVI_MODE = window.location.pathname.includes('/admin/') ? 'admin' : 'portal';

/* ─────────────────────────────────────────────────────────────────
   SHARED DATA CACHE
   ───────────────────────────────────────────────────────────────── */
const SVI = {
  open:        false,
  ready:       false,
  thinking:    false,
  data: {
    investors:    [],
    pools:        [],
    investments:  [],
    transactions: [],
    tickets:      [],
    kyc:          [],
    maturity:     [],
  },
  // For portal mode: the current investor
  investor: null,
  myInvestments:  [],
  myTransactions: [],
};

/* ─────────────────────────────────────────────────────────────────
   BOOTSTRAP — inject HTML into <body>, load data
   ───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  _sviInjectHTML();
  _sviBindEvents();
  _sviLoadData();
});

function _sviInjectHTML() {
  const initials = SVI_MODE === 'admin' ? 'AM' : 'TK';
  const userLabel = SVI_MODE === 'admin' ? 'Admin' : 'Investor';

  document.body.insertAdjacentHTML('beforeend', `
    <!-- SV Intelligence FAB -->
    <button class="svi-fab" id="sviFab" title="SV Intelligence — AI Assistant" onclick="sviToggle()">
      <i class="fa-solid fa-robot" id="sviFabIcon"></i>
      <span class="svi-fab__badge" id="sviFabBadge" data-count="3">3</span>
    </button>

    <!-- SV Intelligence Panel -->
    <div class="svi-panel" id="sviPanel">

      <!-- Header -->
      <div class="svi-header">
        <div class="svi-header__icon">
          <i class="fa-solid fa-robot"></i>
        </div>
        <div class="svi-header__text">
          <div class="svi-header__title">SV Intelligence</div>
          <div class="svi-header__sub">AI-powered data insights · ${SVI_MODE === 'admin' ? 'Admin Console' : 'Investor Portal'}</div>
        </div>
        <button class="svi-header__close" onclick="sviToggle()" title="Close">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <!-- Status bar -->
      <div class="svi-status" id="sviStatus">
        <div class="svi-status__dot" id="sviStatusDot"></div>
        <span id="sviStatusText">Loading your data…</span>
      </div>

      <!-- Quick-ask chips -->
      <div class="svi-chips" id="sviChips"></div>

      <!-- Message thread -->
      <div class="svi-thread" id="sviThread"></div>

      <!-- Input -->
      <div class="svi-input-row">
        <textarea class="svi-input" id="sviInput"
          placeholder="Ask about your ${SVI_MODE === 'admin' ? 'platform data…' : 'portfolio…'}"
          rows="1"
          onkeydown="sviInputKeydown(event)"
          oninput="sviInputResize(this)"
        ></textarea>
        <button class="svi-send-btn" id="sviSendBtn" onclick="sviSend()" title="Send">
          <i class="fa-solid fa-paper-plane"></i>
        </button>
      </div>

      <div class="svi-powered">Powered by <span>SV Intelligence</span> · All data is from your live platform</div>

    </div>
  `);
}

/* ─────────────────────────────────────────────────────────────────
   TOGGLE PANEL
   ───────────────────────────────────────────────────────────────── */
function sviToggle() {
  SVI.open = !SVI.open;
  const panel = document.getElementById('sviPanel');
  const icon  = document.getElementById('sviFabIcon');
  if (!panel) return;

  if (SVI.open) {
    panel.classList.add('svi-panel--open');
    document.getElementById('sviFabBadge').dataset.count = '0';
    document.getElementById('sviFabBadge').style.display = 'none';
    icon.className = 'fa-solid fa-xmark';
    // Show welcome if thread is empty
    if (!document.getElementById('sviThread').children.length) {
      _sviWelcome();
    }
  } else {
    panel.classList.remove('svi-panel--open');
    icon.className = 'fa-solid fa-robot';
  }
}

/* ─────────────────────────────────────────────────────────────────
   EVENTS — keyboard, resize
   ───────────────────────────────────────────────────────────────── */
function _sviBindEvents() {
  // Close on outside click
  document.addEventListener('click', e => {
    const panel = document.getElementById('sviPanel');
    const fab   = document.getElementById('sviFab');
    if (SVI.open && panel && !panel.contains(e.target) && !fab?.contains(e.target)) {
      sviToggle();
    }
  });
}

function sviInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sviSend();
  }
}

function sviInputResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 110) + 'px';
}

/* ─────────────────────────────────────────────────────────────────
   DATA LOADING
   ───────────────────────────────────────────────────────────────── */
async function _sviLoadData() {
  try {
    _sviSetStatus('thinking', 'Loading platform data…');

    if (SVI_MODE === 'admin') {
      const [invR, poolR, invstR, txnR, tktR, kycR, matR] = await Promise.all([
        API.investors.list({ limit: 200 }),
        API.pools.list({ limit: 100 }),
        API.investments.list({ limit: 200 }),
        API.transactions.list({ limit: 200 }),
        API.tickets.list({ limit: 200 }),
        API.kyc.list({ limit: 100 }),
        API.maturityInstructions.list({ limit: 100 }),
      ]);
      SVI.data.investors    = invR.data   || [];
      SVI.data.pools        = poolR.data  || [];
      SVI.data.investments  = invstR.data || [];
      SVI.data.transactions = txnR.data   || [];
      SVI.data.tickets      = tktR.data   || [];
      SVI.data.kyc          = kycR.data   || [];
      SVI.data.maturity     = matR.data   || [];

    } else {
      // Portal mode — load everything and then filter to current investor
      const [invR, poolR, invstR, txnR, tktR] = await Promise.all([
        API.investors.list({ limit: 200 }),
        API.pools.list({ limit: 100 }),
        API.investments.list({ limit: 200 }),
        API.transactions.list({ limit: 200 }),
        API.tickets.list({ limit: 100 }),
      ]);
      SVI.data.investors    = invR.data   || [];
      SVI.data.pools        = poolR.data  || [];
      SVI.data.investments  = invstR.data || [];
      SVI.data.transactions = txnR.data   || [];
      SVI.data.tickets      = tktR.data   || [];

      // Identify current investor using the actual session investor ID
      const _currentInvId = (typeof DEMO_INVESTOR_ID !== 'undefined' ? DEMO_INVESTOR_ID : null)
                          || (typeof Auth !== 'undefined' && Auth.getUser ? Auth.getUser()?.investorId : null);
      SVI.investor = (_currentInvId ? SVI.data.investors.find(i => i.id === _currentInvId) : null)
                  || SVI.data.investors.find(i => i.status === 'active')
                  || SVI.data.investors[0]
                  || null;

      // Fall back to portal cache if API returned no investor record
      if (!SVI.investor && typeof PORTAL !== 'undefined' && PORTAL.investor) {
        SVI.investor = PORTAL.investor;
      }

      if (SVI.investor) {
        const id = SVI.investor.id;
        SVI.myInvestments  = SVI.data.investments.filter(i => i.investor_id === id);
        SVI.myTransactions = SVI.data.transactions.filter(t => t.investor_id === id);
        // If empty, try to use PORTAL's cached data
        if (!SVI.myInvestments.length  && typeof PORTAL !== 'undefined') SVI.myInvestments  = PORTAL.investments  || [];
        if (!SVI.myTransactions.length && typeof PORTAL !== 'undefined') SVI.myTransactions = PORTAL.transactions || [];
      }
    }

    SVI.ready = true;
    _sviSetStatus('ready', 'Connected · data up to date');
    _sviPopulateChips();

  } catch (err) {
    console.error('SVI data load error:', err);
    _sviSetStatus('ready', 'Some data unavailable — analysis may be limited');
    SVI.ready = true;
    _sviPopulateChips();
  }
}

/* ─────────────────────────────────────────────────────────────────
   STATUS BAR
   ───────────────────────────────────────────────────────────────── */
function _sviSetStatus(state, text) {
  const dot  = document.getElementById('sviStatusDot');
  const span = document.getElementById('sviStatusText');
  if (!dot || !span) return;
  dot.className = 'svi-status__dot' + (state === 'thinking' ? ' thinking' : '');
  span.textContent = text;
}

/* ─────────────────────────────────────────────────────────────────
   QUICK-ASK CHIPS
   ───────────────────────────────────────────────────────────────── */
function _sviPopulateChips() {
  const container = document.getElementById('sviChips');
  if (!container) return;

  const chips = SVI_MODE === 'admin'
    ? [
        { label: '📊 Platform Summary',   q: 'Give me a full platform summary'       },
        { label: '💰 AUM & Returns',       q: 'What is the total AUM and returns paid?'},
        { label: '👥 Investor Stats',      q: 'Tell me about investor activity'        },
        { label: '🏊 Pool Health',         q: 'How are the investment pools performing?'},
        { label: '⚠️ Pending Actions',     q: 'What needs my attention today?'         },
        { label: '🎫 Support Tickets',     q: 'Summarise open support tickets'         },
        { label: '📋 KYC Review',          q: 'How many KYC documents need review?'    },
        { label: '📈 Transactions',        q: 'Show me a transaction breakdown'        },
      ]
    : [
        { label: '📊 My Portfolio',         q: 'Give me a summary of my portfolio'      },
        { label: '💰 Returns Analysis',     q: 'How are my returns looking?'            },
        { label: '🏊 Best Pools',           q: 'Which open pools should I consider?'    },
        { label: '💳 Wallet Status',        q: 'What is my wallet balance?'             },
        { label: '⏰ Maturing Soon',        q: 'Do I have any investments maturing soon?'},
        { label: '📈 Transaction History',  q: 'Give me a summary of my transactions'   },
        { label: '🔒 Portfolio Risk',       q: 'What is my portfolio risk profile?'     },
        { label: '💡 Smart Tips',           q: 'Give me smart investment tips based on my data'},
      ];

  container.innerHTML = chips.map(c =>
    `<button class="svi-chip" onclick="sviAsk(${JSON.stringify(c.q)})">${c.label}</button>`
  ).join('');
}

/* ─────────────────────────────────────────────────────────────────
   WELCOME MESSAGE
   ───────────────────────────────────────────────────────────────── */
function _sviWelcome() {
  const name = SVI_MODE === 'admin'
    ? 'Ayanda'
    : (SVI.investor ? SVI.investor.first_name : 'there');

  const msg = SVI_MODE === 'admin'
    ? `👋 Hi ${name}! I'm **SV Intelligence**, your AI data assistant for the admin console.\n\nI can analyse your platform data in real time — investor trends, AUM, pool performance, pending KYC, support tickets, transaction flows, and more.\n\nTap a quick-ask chip above or type your question below.`
    : `👋 Hi ${name}! I'm **SV Intelligence**, your personal AI portfolio assistant.\n\nI've analysed your live portfolio data and I'm ready to answer questions about your investments, returns, wallet, maturing pools, and more.\n\nTap a chip above or ask me anything.`;

  _sviAddMessage('ai', msg);

  // Automatically add a proactive insight on load
  setTimeout(() => {
    if (SVI.ready) _sviProactiveInsight();
  }, 800);
}

/* ─────────────────────────────────────────────────────────────────
   PROACTIVE INSIGHT ON OPEN
   ───────────────────────────────────────────────────────────────── */
function _sviProactiveInsight() {
  if (SVI_MODE === 'admin') {
    const pending = SVI.data.kyc.filter(k => k.status === 'pending').length;
    const openTix = SVI.data.tickets.filter(t => t.status === 'open').length;
    const pendingTxn = SVI.data.transactions.filter(t => t.status === 'pending' && t.type === 'deposit').length;
    const parts = [];
    if (pending > 0)    parts.push(`🔴 **${pending} KYC document${pending > 1 ? 's' : ''}** awaiting review`);
    if (openTix > 0)    parts.push(`🎫 **${openTix} open support ticket${openTix > 1 ? 's' : ''}** need attention`);
    if (pendingTxn > 0) parts.push(`⏳ **${pendingTxn} pending deposit${pendingTxn > 1 ? 's' : ''}** in the transaction ledger`);

    if (parts.length > 0) {
      _sviAddMessage('ai', `**Here's what needs your attention right now:**\n\n${parts.join('\n')}\n\nAsk me about any of these or use the chips above.`);
    }
  } else {
    // Portal: check for maturing investments
    const soon = SVI.myInvestments.filter(i => {
      const days = Utils.daysRemaining(i.maturity_date);
      return i.status === 'active' && days !== null && days <= 60;
    });
    const wallet = parseFloat(SVI.investor?.wallet_balance) || 0;

    if (soon.length > 0) {
      const names = soon.map(i => `**${i.pool_name}** (${Utils.daysRemaining(i.maturity_date)}d)`).join(', ');
      _sviAddMessage('ai', `⏰ **Heads up!** You have ${soon.length} investment${soon.length > 1 ? 's' : ''} maturing soon: ${names}.\n\nMake sure to submit your maturity instructions to avoid delays in your payout.`);
    } else if (wallet < 500 && SVI.myInvestments.length > 0) {
      _sviAddMessage('ai', `💳 Your wallet balance is **${Utils.rand(wallet)}**, which is below R500. Top up to stay ready to invest in new pools when they open.`);
    }
  }
}

/* ─────────────────────────────────────────────────────────────────
   PUBLIC: sviAsk(question) — called by chips or external code
   ───────────────────────────────────────────────────────────────── */
function sviAsk(question) {
  const input = document.getElementById('sviInput');
  if (input) { input.value = question; sviInputResize(input); }
  sviSend();
}

/* ─────────────────────────────────────────────────────────────────
   SEND HANDLER
   ───────────────────────────────────────────────────────────────── */
async function sviSend() {
  const input   = document.getElementById('sviInput');
  const sendBtn = document.getElementById('sviSendBtn');
  if (!input) return;

  const question = input.value.trim();
  if (!question) return;

  // Reset input
  input.value = '';
  input.style.height = 'auto';
  if (sendBtn) sendBtn.disabled = true;

  // Show user message
  _sviAddMessage('user', question);

  // Show typing indicator
  const typingId = _sviAddTyping();

  // Set status to thinking
  _sviSetStatus('thinking', 'Analysing your data…');
  SVI.thinking = true;

  // Simulate a brief thinking delay for UX realism
  await _sviDelay(600 + Math.random() * 600);

  // Generate the answer
  let answer;
  try {
    answer = await _sviAnswer(question.toLowerCase());
  } catch (e) {
    console.error('SVI answer error:', e);
    answer = "I couldn't complete that analysis. Please try rephrasing your question.";
  }

  // Remove typing, add answer
  _sviRemoveTyping(typingId);
  _sviAddMessage('ai', answer);

  _sviSetStatus('ready', 'Connected · data up to date');
  SVI.thinking = false;
  if (sendBtn) sendBtn.disabled = false;
  input.focus();
}

/* ─────────────────────────────────────────────────────────────────
   ANSWER ENGINE — routes questions to handlers
   ───────────────────────────────────────────────────────────────── */
async function _sviAnswer(q) {
  if (SVI_MODE === 'admin') return _sviAdminAnswer(q);
  return _sviPortalAnswer(q);
}

/* ═══════════════════════════════════════════════════════
   PORTAL ANSWER ENGINE
   ═══════════════════════════════════════════════════════ */
function _sviPortalAnswer(q) {
  const inv = SVI.investor || {};
  const myInv = SVI.myInvestments;
  const myTxn = SVI.myTransactions;
  const pools = SVI.data.pools;

  // ── Portfolio summary ─────────────────────────────────────────
  if (_q(q, ['portfolio', 'summary', 'overview', 'tell me about'])) {
    const totalInv   = parseFloat(inv.total_invested) || myInv.reduce((s,i) => s + (i.amount||0), 0);
    const totalRet   = parseFloat(inv.total_returns)  || 0;
    const wallet     = parseFloat(inv.wallet_balance) || 0;
    const active     = myInv.filter(i => i.status === 'active');
    const matured    = myInv.filter(i => i.status === 'matured' || i.status === 'paid_out');
    const effectiveR = totalInv > 0 ? ((totalRet / totalInv) * 100).toFixed(1) : '0';
    const totalValue = totalInv + wallet;

    return _sviBlock(
      `Here's your **complete portfolio snapshot**, ${inv.first_name || 'Investor'}:`,
      [
        { icon: 'fa-coins',         cls: 'orange', label: 'Total Portfolio Value', value: Utils.rand(totalValue),          sub: `Invested + wallet`               },
        { icon: 'fa-chart-line',    cls: 'green',  label: 'Total Invested',        value: Utils.rand(totalInv),            sub: `${active.length} active position${active.length !== 1 ? 's' : ''}` },
        { icon: 'fa-trending-up',   cls: 'teal',   label: 'Returns Earned',        value: Utils.rand(totalRet),            sub: `${effectiveR}% effective return`   },
        { icon: 'fa-wallet',        cls: 'blue',   label: 'Wallet Balance',        value: Utils.rand(wallet),              sub: `Available to invest`               },
      ],
      `You have **${active.length}** active investment${active.length !== 1 ? 's' : ''} and **${matured.length}** completed.\n\n` +
      (active.length === 0 ? `💡 *No active investments yet — browse open pools to get started!*` :
        `Your portfolio is ${totalInv > 50000 ? 'well-diversified' : 'growing steadily'}. ${
          effectiveR > 12 ? '🔥 Strong performance above 12% effective return!' :
          effectiveR > 8  ? '✅ Solid returns above 8%.' :
          '📈 Keep building — returns compound over time.'
        }`)
    );
  }

  // ── Returns / earnings ───────────────────────────────────────
  if (_q(q, ['return', 'earn', 'yield', 'profit', 'gain', 'performance', 'how much'])) {
    const totalInv  = parseFloat(inv.total_invested) || myInv.reduce((s,i) => s + (i.amount||0), 0);
    const totalRet  = parseFloat(inv.total_returns)  || 0;
    const active    = myInv.filter(i => i.status === 'active');
    const expectedTotal = active.reduce((s,i) => s + (i.expected_return_amount||0), 0);
    const effectiveR = totalInv > 0 ? ((totalRet / totalInv) * 100).toFixed(1) : '0';
    const bestPool  = active.sort((a,b) => (b.expected_return_rate||0) - (a.expected_return_rate||0))[0];

    let html = `**Your returns analysis:**\n\n`;
    html += _sviDataList([
      { label: 'Total Invested',           value: Utils.rand(totalInv),     cls: '' },
      { label: 'Returns Already Earned',   value: Utils.rand(totalRet),     cls: 'up' },
      { label: 'Expected (Active Pools)',  value: Utils.rand(expectedTotal), cls: 'gold' },
      { label: 'Effective Return Rate',    value: effectiveR + '%',          cls: 'up' },
    ]);
    if (bestPool) {
      html += `\n\n🏆 **Best performing pool:** ${bestPool.pool_name} at **${Utils.pct(bestPool.expected_return_rate)} p.a.**`;
    }
    if (parseFloat(effectiveR) > 14) {
      html += `\n\n🔥 *Your effective return of ${effectiveR}% beats most traditional bank savings rates by 2–3×!*`;
    }
    return html;
  }

  // ── Wallet / balance ─────────────────────────────────────────
  if (_q(q, ['wallet', 'balance', 'money', 'available', 'cash', 'top up', 'topup', 'fund'])) {
    const wallet = parseFloat(inv.wallet_balance) || 0;
    const minPool = pools.filter(p => p.status === 'open').sort((a,b) => a.min_investment - b.min_investment)[0];

    let html = `💳 **Your wallet balance is ${Utils.rand(wallet)}.**\n\n`;
    if (wallet < 100) {
      html += `⚠️ Your wallet is almost empty. Top up to stay ready to invest when new pools open.\n\n`;
      html += `**Ways to add funds:**\n- 💳 Paystack (instant EFT / card)\n- 🏦 Ozow (direct bank EFT)\n- 📨 Manual bank transfer (1–2 business days)`;
    } else if (minPool && wallet >= minPool.min_investment) {
      html += `✅ You have enough to invest in **${minPool.pool_name}** (min: ${Utils.rand(minPool.min_investment)}).\n\nGo to **Browse Pools** to invest now.`;
    } else if (minPool) {
      html += `You need **${Utils.rand(minPool.min_investment - wallet)} more** to reach the minimum for **${minPool.pool_name}** (${Utils.rand(minPool.min_investment)} min).\n\nTop up your wallet to start investing.`;
    }
    return html;
  }

  // ── Maturing investments ─────────────────────────────────────
  if (_q(q, ['matur', 'expir', 'end', 'soon', 'coming up', 'upcoming', 'next'])) {
    const active = myInv.filter(i => i.status === 'active');
    if (!active.length) return `You don't have any active investments yet. Visit **Browse Pools** to get started!`;

    const sorted = active.sort((a,b) => new Date(a.maturity_date) - new Date(b.maturity_date));
    const soon   = sorted.filter(i => Utils.daysRemaining(i.maturity_date) <= 90);

    let html = `**Your investment maturity timeline:**\n\n`;
    html += _sviDataList(sorted.slice(0, 6).map(i => {
      const days = Utils.daysRemaining(i.maturity_date);
      return {
        label: i.pool_name,
        value: days !== null ? `${days}d` : '—',
        cls:   days !== null && days <= 30 ? 'down' : days !== null && days <= 60 ? 'gold' : 'up'
      };
    }));

    if (soon.length > 0) {
      html += `\n\n⏰ **${soon.length} investment${soon.length > 1 ? 's' : ''} mature${soon.length === 1 ? 's' : ''} within 90 days.**\n\nSubmit your maturity instructions (payout or reinvest) in **Maturity Instructions** so funds aren't delayed.`;
    } else {
      html += `\n\n✅ *No investments maturing in the next 90 days — you're in good shape.*`;
    }
    return html;
  }

  // ── Open pools / marketplace ──────────────────────────────────
  if (_q(q, ['pool', 'invest', 'option', 'available', 'open', 'best pool', 'recommend', 'consider', 'browse'])) {
    const open = pools.filter(p => p.status === 'open').sort((a,b) => b.benchmark_rate - a.benchmark_rate);
    if (!open.length) return `There are no open investment pools at the moment. Check back soon — new pools open regularly.`;

    const wallet = parseFloat(inv.wallet_balance) || 0;
    const canInvest = open.filter(p => wallet >= p.min_investment);

    let html = `🏊 **Open investment pools right now** (sorted by rate):\n\n`;
    html += _sviDataList(open.slice(0, 6).map(p => ({
      label: `${p.pool_name} · ${p.term_months}mo`,
      value: Utils.pct(p.benchmark_rate) + ' p.a.',
      cls:   'gold'
    })));

    if (canInvest.length > 0) {
      html += `\n\n✅ With your wallet of **${Utils.rand(wallet)}**, you can invest in **${canInvest.length}** of these pools right now.`;
    } else if (wallet > 0) {
      html += `\n\n💳 Your wallet has **${Utils.rand(wallet)}** — top up to meet the minimum and start investing.`;
    }

    // Recommendation
    const top = open[0];
    html += `\n\n💡 **Highest rate:** **${top.pool_name}** at ${Utils.pct(top.benchmark_rate)} p.a. for ${top.term_months} months (min ${Utils.rand(top.min_investment)}).`;
    return html;
  }

  // ── Transactions ─────────────────────────────────────────────
  if (_q(q, ['transaction', 'history', 'activity', 'deposit', 'withdrawal', 'payment', 'recent'])) {
    const deposits    = myTxn.filter(t => t.type === 'deposit'    && t.amount > 0);
    const investments = myTxn.filter(t => t.type === 'investment' && t.amount < 0);
    const returns     = myTxn.filter(t => t.type === 'return'     && t.amount > 0);
    const totalDep    = deposits.reduce((s,t)    => s + (t.amount||0), 0);
    const totalInvTxn = investments.reduce((s,t) => s + Math.abs(t.amount||0), 0);
    const totalRet    = returns.reduce((s,t)     => s + (t.amount||0), 0);

    let html = `📊 **Your transaction summary** (${myTxn.length} total records):\n\n`;
    html += _sviDataList([
      { label: 'Total Deposits',   value: Utils.rand(totalDep),    cls: 'up'   },
      { label: 'Total Invested',   value: Utils.rand(totalInvTxn), cls: 'gold' },
      { label: 'Returns Received', value: Utils.rand(totalRet),    cls: 'up'   },
      { label: 'Transactions',     value: myTxn.length + ' records', cls: ''   },
    ]);

    const recent = [...myTxn].sort((a,b) => new Date(b.transaction_date) - new Date(a.transaction_date)).slice(0, 3);
    if (recent.length) {
      html += `\n\n**Most recent:**\n`;
      recent.forEach(t => {
        html += `• ${Utils.date(t.transaction_date)} — ${t.type} **${t.amount > 0 ? '+' : ''}${Utils.rand(t.amount)}** (${t.status})\n`;
      });
    }
    return html;
  }

  // ── Risk profile ──────────────────────────────────────────────
  if (_q(q, ['risk', 'diversif', 'profile', 'allocation', 'spread', 'exposure'])) {
    const active = myInv.filter(i => i.status === 'active');
    if (!active.length) return `You don't have any active investments yet to assess risk profile.`;

    const byProduct = {};
    let totalAmt = 0;
    active.forEach(i => {
      const label = Utils.productInfo(i.product_type).label;
      byProduct[label] = (byProduct[label] || 0) + (i.amount || 0);
      totalAmt += (i.amount || 0);
    });

    const sorted = Object.entries(byProduct).sort((a,b) => b[1] - a[1]);
    const maxPct = sorted.length ? (sorted[0][1] / totalAmt * 100).toFixed(0) : 0;

    let html = `🔒 **Your portfolio risk & allocation:**\n\n`;
    html += _sviDataList(sorted.map(([label, amt]) => ({
      label,
      value: Utils.rand(amt) + ` (${(amt/totalAmt*100).toFixed(0)}%)`,
      cls: (amt/totalAmt) > 0.6 ? 'down' : 'up'
    })));

    html += `\n\n`;
    if (sorted.length === 1) {
      html += `⚠️ **Concentration risk:** 100% of your portfolio is in **${sorted[0][0]}**. Consider diversifying across multiple products to reduce risk.`;
    } else if (parseFloat(maxPct) > 70) {
      html += `⚠️ **Moderate concentration:** ${maxPct}% in **${sorted[0][0]}**. Consider spreading across additional pools.`;
    } else {
      html += `✅ **Well-diversified** across ${sorted.length} product type${sorted.length > 1 ? 's' : ''}. Good risk management!`;
    }
    return html;
  }

  // ── Smart tips ────────────────────────────────────────────────
  if (_q(q, ['tip', 'advice', 'suggest', 'recommend', 'smart', 'help me', 'what should', 'next step', 'improve'])) {
    const wallet     = parseFloat(inv.wallet_balance) || 0;
    const totalInv   = parseFloat(inv.total_invested) || myInv.reduce((s,i) => s + (i.amount||0), 0);
    const active     = myInv.filter(i => i.status === 'active');
    const openPools  = pools.filter(p => p.status === 'open');
    const soon       = active.filter(i => Utils.daysRemaining(i.maturity_date) <= 60);

    const tips = [];

    if (wallet < 500)          tips.push(`💳 **Top up your wallet** — with only ${Utils.rand(wallet)}, you'll miss out when new pools open.`);
    if (active.length === 0)   tips.push(`🚀 **Start investing** — browse the ${openPools.length} open pool${openPools.length !== 1 ? 's' : ''} available right now.`);
    if (active.length === 1)   tips.push(`🔀 **Diversify** — you're concentrated in one pool. Add a second product type to spread risk.`);
    if (soon.length > 0)       tips.push(`⏰ **Submit maturity instructions** for ${soon.length} investment${soon.length > 1 ? 's' : ''} maturing in the next 60 days.`);
    if (totalInv > 0 && active.length > 2) tips.push(`🏆 **Reinvest returns** — compounding your earnings into new pools accelerates wealth building.`);
    if (openPools.length > 0) {
      const best = openPools.sort((a,b) => b.benchmark_rate - a.benchmark_rate)[0];
      tips.push(`📈 **Best rate available:** ${best.pool_name} at ${Utils.pct(best.benchmark_rate)} p.a. — ${Utils.rand(best.min_investment)} minimum.`);
    }
    if (!tips.length) tips.push(`✅ **Your portfolio looks healthy!** Keep investing consistently to benefit from compounding returns.`);

    return `💡 **SV Intelligence Tips for you:**\n\n${tips.join('\n\n')}`;
  }

  // ── Investments list ──────────────────────────────────────────
  if (_q(q, ['my investment', 'active investment', 'current investment', 'list'])) {
    const active = myInv.filter(i => i.status === 'active');
    if (!active.length) return `You don't have any active investments. Visit **Browse Pools** to get started!`;

    let html = `📋 **Your ${active.length} active investment${active.length > 1 ? 's' : ''}:**\n\n`;
    html += _sviDataList(active.map(i => ({
      label: `${i.pool_name} · ${Utils.date(i.maturity_date)}`,
      value: Utils.rand(i.amount),
      cls:   'gold'
    })));

    const total = active.reduce((s,i) => s + (i.amount||0), 0);
    const totalExp = active.reduce((s,i) => s + (i.expected_return_amount||0), 0);
    html += `\n\n**Total active: ${Utils.rand(total)}** · Expected returns: **${Utils.rand(totalExp)}**`;
    return html;
  }

  // ── Default fallback ──────────────────────────────────────────
  return _sviFallback(q, 'portal');
}

/* ═══════════════════════════════════════════════════════
   ADMIN ANSWER ENGINE
   ═══════════════════════════════════════════════════════ */
function _sviAdminAnswer(q) {
  const data = SVI.data;

  // ── Platform summary ─────────────────────────────────────────
  if (_q(q, ['summary', 'overview', 'platform', 'full', 'brief', 'tell me', 'dashboard', 'snapshot'])) {
    const totalInv      = data.investments.filter(i => i.status === 'active');
    const totalAUM      = totalInv.reduce((s,i) => s + (i.amount||0), 0);
    const totalReturns  = data.transactions.filter(t => t.type === 'return' || t.type === 'payout').reduce((s,t) => s + Math.abs(t.amount||0), 0);
    const activeInv     = data.investors.filter(i => i.status === 'active').length;
    const openPools     = data.pools.filter(p => p.status === 'open').length;
    const pendingKYC    = data.kyc.filter(k => k.status === 'pending').length;
    const openTickets   = data.tickets.filter(t => t.status === 'open').length;
    const pendingDep    = data.transactions.filter(t => t.status === 'pending' && t.type === 'deposit').length;

    return _sviBlock(
      `📊 **SV Capital Platform Snapshot:**`,
      [
        { icon: 'fa-users',       cls: 'blue',   label: 'Active Investors', value: activeInv.toString(),       sub: `of ${data.investors.length} total`            },
        { icon: 'fa-coins',       cls: 'orange', label: 'Total AUM',        value: Utils.rand(totalAUM),        sub: `${totalInv.length} active investments`         },
        { icon: 'fa-chart-line',  cls: 'green',  label: 'Returns Paid',     value: Utils.rand(totalReturns),    sub: 'total paid out to investors'                  },
        { icon: 'fa-layer-group', cls: 'teal',   label: 'Open Pools',       value: openPools.toString(),        sub: `of ${data.pools.length} total pools`           },
      ],
      `**Action items:** ${pendingKYC} KYC pending · ${openTickets} open tickets · ${pendingDep} pending deposits\n\n` +
      (pendingKYC + openTickets + pendingDep > 0 ? `⚠️ *There are ${pendingKYC + openTickets + pendingDep} items that need your attention.*` : `✅ *No outstanding action items — platform is running smoothly.*`)
    );
  }

  // ── AUM & returns ─────────────────────────────────────────────
  if (_q(q, ['aum', 'return', 'paid', 'payout', 'earn', 'performance', 'money', 'financial'])) {
    const allInvested   = data.investments.reduce((s,i) => s + (i.amount||0), 0);
    const activeAUM     = data.investments.filter(i => i.status === 'active').reduce((s,i) => s + (i.amount||0), 0);
    const totalPaid     = data.transactions.filter(t => ['return','payout'].includes(t.type)).reduce((s,t) => s + Math.abs(t.amount||0), 0);
    const totalDeposits = data.transactions.filter(t => t.type === 'deposit' && t.status === 'completed').reduce((s,t) => s + (t.amount||0), 0);
    const walletTotal   = data.investors.reduce((s,i) => s + (parseFloat(i.wallet_balance)||0), 0);
    const expectedTotal = data.investments.filter(i => i.status === 'active').reduce((s,i) => s + (i.expected_return_amount||0), 0);

    let html = `💰 **AUM & Financial Performance:**\n\n`;
    html += _sviDataList([
      { label: 'Active AUM',              value: Utils.rand(activeAUM),     cls: 'gold' },
      { label: 'Total Ever Invested',     value: Utils.rand(allInvested),   cls: ''     },
      { label: 'Returns Paid to Date',    value: Utils.rand(totalPaid),     cls: 'up'   },
      { label: 'Total Investor Wallets',  value: Utils.rand(walletTotal),   cls: 'blue' },
      { label: 'Expected Future Returns', value: Utils.rand(expectedTotal), cls: 'gold' },
      { label: 'Total Deposits (comp.)',  value: Utils.rand(totalDeposits), cls: 'up'   },
    ]);
    return html;
  }

  // ── Investors ─────────────────────────────────────────────────
  if (_q(q, ['investor', 'client', 'member', 'user', 'activity', 'active', 'signed up'])) {
    const active    = data.investors.filter(i => i.status === 'active').length;
    const pending   = data.investors.filter(i => i.status === 'pending' || i.status === 'pending_fica').length;
    const suspended = data.investors.filter(i => i.status === 'suspended').length;
    const totalW    = data.investors.reduce((s,i) => s + (parseFloat(i.wallet_balance)||0), 0);
    const totalInv  = data.investors.reduce((s,i) => s + (parseFloat(i.total_invested)||0), 0);

    // Top investors by investment
    const topInv = [...data.investors].sort((a,b) => (b.total_invested||0) - (a.total_invested||0)).slice(0, 5);

    let html = `👥 **Investor Management Overview:**\n\n`;
    html += _sviDataList([
      { label: 'Active Investors',    value: active.toString(),      cls: 'up'   },
      { label: 'Pending FICA/Setup',  value: pending.toString(),     cls: pending > 0 ? 'down' : '' },
      { label: 'Suspended',           value: suspended.toString(),   cls: suspended > 0 ? 'down' : '' },
      { label: 'Total Wallet Funds',  value: Utils.rand(totalW),     cls: 'gold' },
      { label: 'Platform AUM',        value: Utils.rand(totalInv),   cls: 'gold' },
    ]);

    if (topInv.length > 0) {
      html += `\n\n**Top 5 investors by portfolio:**\n`;
      topInv.forEach((inv, idx) => {
        html += `${idx+1}. ${inv.first_name} ${inv.last_name} — ${Utils.rand(inv.total_invested||0)}\n`;
      });
    }
    return html;
  }

  // ── Pools ─────────────────────────────────────────────────────
  if (_q(q, ['pool', 'fund', 'perform', 'product', 'health', 'fill', 'target'])) {
    const open    = data.pools.filter(p => p.status === 'open');
    const active  = data.pools.filter(p => p.status === 'active');
    const matured = data.pools.filter(p => p.status === 'matured' || p.status === 'paid_out');
    const totalTarget  = data.pools.reduce((s,p) => s + (p.target_amount||0), 0);
    const totalRaised  = data.pools.reduce((s,p) => s + (p.raised_amount||0), 0);

    let html = `🏊 **Investment Pool Health:**\n\n`;
    html += _sviDataList([
      { label: 'Open (Accepting)',  value: open.length.toString(),    cls: 'up'   },
      { label: 'Active (Deployed)', value: active.length.toString(),  cls: 'gold' },
      { label: 'Matured/Paid Out',  value: matured.length.toString(), cls: ''     },
      { label: 'Total Target AUM',  value: Utils.rand(totalTarget),   cls: ''     },
      { label: 'Total Raised',      value: Utils.rand(totalRaised),   cls: 'up'   },
      { label: 'Fill Rate',         value: totalTarget > 0 ? (totalRaised/totalTarget*100).toFixed(0)+'%' : '—', cls: 'gold' },
    ]);

    const topPool = [...open].sort((a,b) => b.benchmark_rate - a.benchmark_rate)[0];
    if (topPool) html += `\n\n🏆 **Highest-rate open pool:** ${topPool.pool_name} at ${Utils.pct(topPool.benchmark_rate)} p.a.`;

    // Pools close to target
    const nearFull = open.filter(p => p.target_amount && (p.raised_amount||0)/p.target_amount > 0.8);
    if (nearFull.length) {
      html += `\n\n⚡ **Filling fast:** ${nearFull.map(p => `${p.pool_name} (${Utils.poolFillPct(p)}%)`).join(', ')}`;
    }
    return html;
  }

  // ── Pending actions / what needs attention ───────────────────
  if (_q(q, ['pending', 'attention', 'action', 'today', 'urgent', 'todo', 'need', 'require'])) {
    const pendingKYC  = data.kyc.filter(k => k.status === 'pending').length;
    const urgentTix   = data.tickets.filter(t => t.status === 'open' && t.priority === 'urgent').length;
    const highTix     = data.tickets.filter(t => t.status === 'open' && t.priority === 'high').length;
    const openTix     = data.tickets.filter(t => t.status === 'open').length;
    const pendingDep  = data.transactions.filter(t => t.status === 'pending' && t.type === 'deposit').length;
    const pendingMat  = data.maturity.filter(m => m.status === 'pending').length;
    const pendingInv  = data.investors.filter(i => i.status === 'pending_fica' || i.status === 'pending').length;

    const total = pendingKYC + openTix + pendingDep + pendingMat + pendingInv;

    let html = total > 0
      ? `⚠️ **${total} item${total > 1 ? 's' : ''} need${total === 1 ? 's' : ''} your attention:**\n\n`
      : `✅ **No pending actions — platform is running smoothly!**\n\n`;

    const rows = [];
    if (pendingKYC > 0)  rows.push({ label: 'KYC documents to review',     value: pendingKYC.toString(),  cls: 'down' });
    if (urgentTix > 0)   rows.push({ label: 'Urgent support tickets',       value: urgentTix.toString(),   cls: 'down' });
    if (highTix > 0)     rows.push({ label: 'High-priority tickets',        value: highTix.toString(),     cls: 'gold' });
    if (pendingDep > 0)  rows.push({ label: 'Pending deposits (ledger)',     value: pendingDep.toString(),  cls: 'gold' });
    if (pendingMat > 0)  rows.push({ label: 'Maturity instructions to act', value: pendingMat.toString(),  cls: 'gold' });
    if (pendingInv > 0)  rows.push({ label: 'Investors awaiting activation',value: pendingInv.toString(),  cls: 'gold' });
    if (rows.length) html += _sviDataList(rows);

    if (total === 0) html += `All KYC reviews, tickets, deposits, and maturity instructions are up to date.`;
    return html;
  }

  // ── Support tickets ──────────────────────────────────────────
  if (_q(q, ['ticket', 'support', 'query', 'complaint', 'help', 'open ticket'])) {
    const open     = data.tickets.filter(t => t.status === 'open');
    const urgent   = open.filter(t => t.priority === 'urgent');
    const high     = open.filter(t => t.priority === 'high');
    const resolved = data.tickets.filter(t => t.status === 'resolved').length;

    let html = `🎫 **Support Ticket Summary:**\n\n`;
    html += _sviDataList([
      { label: 'Open Tickets',     value: open.length.toString(),     cls: open.length > 0 ? 'down' : '' },
      { label: 'Urgent Priority',  value: urgent.length.toString(),   cls: urgent.length > 0 ? 'down' : '' },
      { label: 'High Priority',    value: high.length.toString(),     cls: high.length > 0 ? 'gold' : '' },
      { label: 'Resolved',         value: resolved.toString(),        cls: 'up'  },
    ]);

    const recent = open.sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 3);
    if (recent.length) {
      html += `\n\n**Most recent open tickets:**\n`;
      recent.forEach(t => {
        html += `• **${t.id}** — ${t.subject || 'No subject'} [${t.priority}]\n`;
      });
    }
    return html;
  }

  // ── KYC / FICA ───────────────────────────────────────────────
  if (_q(q, ['kyc', 'fica', 'document', 'verification', 'compliance', 'id', 'identity'])) {
    const pending   = data.kyc.filter(k => k.status === 'pending').length;
    const review    = data.kyc.filter(k => k.status === 'under_review').length;
    const approved  = data.kyc.filter(k => k.status === 'approved').length;
    const rejected  = data.kyc.filter(k => k.status === 'rejected').length;

    let html = `📋 **KYC / FICA Compliance Status:**\n\n`;
    html += _sviDataList([
      { label: 'Pending Review',   value: pending.toString(),  cls: pending > 0 ? 'down' : '' },
      { label: 'Under Review',     value: review.toString(),   cls: review > 0 ? 'gold' : ''  },
      { label: 'Approved',         value: approved.toString(), cls: 'up'                       },
      { label: 'Rejected',         value: rejected.toString(), cls: rejected > 0 ? 'down' : '' },
    ]);

    if (pending > 0) html += `\n\n⚠️ **${pending} document${pending > 1 ? 's' : ''} need${pending === 1 ? 's' : ''} your review.** Go to **KYC / FICA** to approve or reject.`;
    else html += `\n\n✅ *No documents pending review.*`;
    return html;
  }

  // ── Transactions ─────────────────────────────────────────────
  if (_q(q, ['transaction', 'ledger', 'deposit', 'payment', 'breakdown', 'history', 'flow'])) {
    const completed = data.transactions.filter(t => t.status === 'completed');
    const pending   = data.transactions.filter(t => t.status === 'pending');
    const deposits  = data.transactions.filter(t => t.type === 'deposit' && t.status === 'completed');
    const invTxns   = data.transactions.filter(t => t.type === 'investment');
    const retTxns   = data.transactions.filter(t => ['return','payout'].includes(t.type));
    const feeTxns   = data.transactions.filter(t => t.type === 'fee');

    const totalDep  = deposits.reduce((s,t) => s + (t.amount||0), 0);
    const totalInvT = invTxns.reduce((s,t) => s + Math.abs(t.amount||0), 0);
    const totalRetT = retTxns.reduce((s,t) => s + Math.abs(t.amount||0), 0);
    const totalFees = feeTxns.reduce((s,t) => s + Math.abs(t.amount||0), 0);

    let html = `📈 **Transaction Ledger Breakdown** (${data.transactions.length} total):\n\n`;
    html += _sviDataList([
      { label: 'Completed',              value: completed.length.toString(),   cls: 'up'                                 },
      { label: 'Pending',                value: pending.length.toString(),     cls: pending.length > 0 ? 'gold' : ''    },
      { label: 'Total Deposits (comp.)', value: Utils.rand(totalDep),          cls: 'up'                                 },
      { label: 'Total Invested',         value: Utils.rand(totalInvT),         cls: 'gold'                               },
      { label: 'Returns & Payouts',      value: Utils.rand(totalRetT),         cls: 'up'                                 },
      { label: 'Gateway Fees Collected', value: Utils.rand(totalFees),         cls: ''                                   },
    ]);

    if (pending.length > 0) {
      html += `\n\n⏳ **${pending.length} pending transaction${pending.length > 1 ? 's' : ''}** — go to Transactions to update their status.`;
    }
    return html;
  }

  // ── Default fallback ──────────────────────────────────────────
  return _sviFallback(q, 'admin');
}

/* ─────────────────────────────────────────────────────────────────
   FALLBACK
   ───────────────────────────────────────────────────────────────── */
function _sviFallback(q, mode) {
  const adminSuggestions = `• "Platform summary"\n• "What needs attention today?"\n• "Pool performance"\n• "AUM and returns"\n• "KYC review status"\n• "Support ticket summary"`;
  const portalSuggestions = `• "My portfolio summary"\n• "What are my returns?"\n• "Which pools are open?"\n• "My wallet balance"\n• "Investments maturing soon"\n• "Smart tips for me"`;

  return `I don't have a specific analysis for that question yet.\n\nHere are things I can help with:\n\n${mode === 'admin' ? adminSuggestions : portalSuggestions}\n\nOr try one of the quick-ask chips above.`;
}

/* ─────────────────────────────────────────────────────────────────
   HTML RENDERING HELPERS
   ───────────────────────────────────────────────────────────────── */

/** Render a message with icon cards on top */
function _sviBlock(intro, cards, body) {
  let html = `${intro}\n\n`;
  html += `<div class="svi-data-list">`;
  cards.forEach(c => {
    html += `
      <div class="svi-insight-card">
        <div class="svi-insight-card__icon svi-insight-card__icon--${c.cls}">
          <i class="fa-solid ${c.icon}"></i>
        </div>
        <div class="svi-insight-card__body">
          <div class="svi-insight-card__label">${c.label}</div>
          <div class="svi-insight-card__value">${c.value}</div>
          ${c.sub ? `<div class="svi-insight-card__sub">${c.sub}</div>` : ''}
        </div>
      </div>`;
  });
  html += `</div>`;
  if (body) html += `\n\n${body}`;
  return html;
}

/** Render a compact key-value data list */
function _sviDataList(rows) {
  return `<div class="svi-data-list">${rows.map(r => `
    <div class="svi-data-row">
      <span class="svi-data-row__label">${r.label}</span>
      <span class="svi-data-row__value ${r.cls || ''}">${r.value}</span>
    </div>`).join('')}</div>`;
}

/* ─────────────────────────────────────────────────────────────────
   MESSAGE THREAD
   ───────────────────────────────────────────────────────────────── */
function _sviAddMessage(role, text) {
  const thread = document.getElementById('sviThread');
  if (!thread) return;

  const initials = role === 'ai'
    ? 'SV'
    : (SVI_MODE === 'admin' ? 'AM' : 'TK');

  const div = document.createElement('div');
  div.className = `svi-msg svi-msg--${role}`;
  div.innerHTML = `
    <div class="svi-msg__avatar">${initials}</div>
    <div class="svi-msg__bubble">${_sviMarkdown(text)}</div>
  `;
  thread.appendChild(div);
  thread.scrollTop = thread.scrollHeight;
}

function _sviAddTyping() {
  const thread = document.getElementById('sviThread');
  if (!thread) return null;
  const id = 'svi-typing-' + Date.now();
  thread.insertAdjacentHTML('beforeend', `
    <div class="svi-msg svi-msg--ai svi-typing" id="${id}">
      <div class="svi-msg__avatar">SV</div>
      <div class="svi-msg__bubble">
        <span class="svi-typing-dot"></span>
        <span class="svi-typing-dot"></span>
        <span class="svi-typing-dot"></span>
      </div>
    </div>
  `);
  thread.scrollTop = thread.scrollHeight;
  return id;
}

function _sviRemoveTyping(id) {
  if (id) document.getElementById(id)?.remove();
}

/* ─────────────────────────────────────────────────────────────────
   LIGHTWEIGHT MARKDOWN → HTML
   Supports: **bold**, *italic*, \n → <br>, bullet lists
   ───────────────────────────────────────────────────────────────── */
function _sviMarkdown(text) {
  // Escape basic XSS but keep existing HTML from _sviBlock / _sviDataList
  // Only process lines that don't start with < (i.e. not already HTML)
  const lines = text.split('\n');
  const processed = lines.map(line => {
    if (line.trim().startsWith('<')) return line; // already HTML
    // Bullet points
    if (line.match(/^[•\-\*] /)) {
      const content = line.replace(/^[•\-\*] /, '');
      return `<span style="display:block;padding-left:10px">• ${_sviInlineFormat(content)}</span>`;
    }
    // Numbered list
    if (line.match(/^\d+\. /)) {
      return `<span style="display:block;padding-left:10px">${_sviInlineFormat(line)}</span>`;
    }
    return _sviInlineFormat(line);
  });
  return processed.join('<br>');
}

function _sviInlineFormat(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

/* ─────────────────────────────────────────────────────────────────
   UTILITIES
   ───────────────────────────────────────────────────────────────── */

/** Simple question keyword matcher */
function _q(question, keywords) {
  return keywords.some(kw => question.includes(kw));
}

function _sviDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
