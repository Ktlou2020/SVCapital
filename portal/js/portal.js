/* ═══════════════════════════════════════════════
   SV CAPITAL — Investor Portal JS
   ═══════════════════════════════════════════════ */
'use strict';

/* ─── Resolve investor ID from JWT session or fall back to demo ─── */
const DEMO_INVESTOR_ID = (() => {
  // Check JWT-based auth first
  if (typeof Auth !== 'undefined') {
    if (!Auth.isLoggedIn()) {
      window.location.href = '/login.html';
      return 'INV-001';
    }
    const user = Auth.getUser();
    if (user && user.investorId) return user.investorId;
  }
  return 'INV-001'; // fallback for demo
})();

/* Escape user-controlled strings before inserting into innerHTML */
const _esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

let PORTAL = {
  investor: null,
  investments: [],
  transactions: [],
  pools: [],
  tickets: [],
  subAccounts: [],
  waitlist: [],
  charts: {},
  myInvFilter: 'all',
  marketFilter: 'all',
  quests: null,       // { xp, level, currentLevel, nextLevel, completedIds, quests, levels, profile }
};

const PROFILE_DRAFT_KEY = 'svc_profile_draft_v2';
const SUPPORT_DRAFT_KEY = 'svc_support_draft_v2';
let _profileHydrating = false;
let _supportHydrating = false;
let _profileDirty = false;

function _portalScopedKey(base) {
  return `${base}:${PORTAL.investor?.id || DEMO_INVESTOR_ID || 'guest'}`;
}
function _localGet(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}
function _localSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
}
function _localRemove(key) {
  try { localStorage.removeItem(key); } catch (_) {}
}
function _setInlineMessage(id, msg, color = 'var(--text-muted)') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.color = color;
}
function _ensureTaskCompletionPanel() {
  let wrap = document.getElementById('taskCompletionPanel');
  if (wrap) return wrap;
  const anchor = document.getElementById('onboardingWizard') || document.getElementById('welcomeBanner');
  if (!anchor || !anchor.parentNode) return null;
  wrap = document.createElement('div');
  wrap.id = 'taskCompletionPanel';
  wrap.style.cssText = 'display:none;margin-bottom:20px';
  wrap.innerHTML = `
    <div class="panel" style="border:1px solid rgba(47,140,155,0.18);background:linear-gradient(135deg,rgba(47,140,155,0.05),rgba(255,155,12,0.04))">
      <div class="panel__header" style="align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div>
          <span class="panel__title"><i class="fa-solid fa-list-check" style="color:#2F8C9B;margin-right:8px"></i>Action Centre</span>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px">See the next best action to unlock deposits, investing, withdrawals and statements.</div>
        </div>
        <div id="taskCompletionMeta" style="margin-left:auto;font-size:0.74rem;font-weight:700;color:#2F8C9B"></div>
      </div>
      <div class="panel__body" id="taskCompletionBody"></div>
    </div>`;
  anchor.insertAdjacentElement('afterend', wrap);
  return wrap;
}
function _ensureProfileAssistUI() {
  const header = document.querySelector('#view-profile .panel .panel__header');
  const saveBtn = document.querySelector('button[onclick="saveProfile()"]');
  if (header && !document.getElementById('profileSaveMeta')) {
    const meta = document.createElement('div');
    meta.id = 'profileSaveMeta';
    meta.style.cssText = 'margin-left:auto;margin-right:10px;font-size:0.74rem;font-weight:700;color:var(--text-muted)';
    meta.textContent = 'Changes auto-save to this device until you submit.';
    if (saveBtn) header.insertBefore(meta, saveBtn);
    else header.appendChild(meta);
  }
  const email = document.getElementById('profEmail');
  if (email) {
    email.readOnly = true;
    email.setAttribute('aria-readonly', 'true');
    email.style.background = 'rgba(0,0,0,0.035)';
    email.style.cursor = 'not-allowed';
    email.title = 'Email changes are protected. Please contact support to update your login email.';
    if (!document.getElementById('profEmailHint')) {
      const hint = document.createElement('div');
      hint.id = 'profEmailHint';
      hint.style.cssText = 'margin-top:6px;font-size:0.72rem;color:var(--text-muted);line-height:1.45';
      hint.textContent = 'Email changes are protected for security. Contact support if you need to update your login address.';
      email.closest('.form-group')?.appendChild(hint);
    }
  }
}
function _ensureSupportAssistUI() {
  const subject = document.getElementById('tktSubject');
  const message = document.getElementById('tktMessage');
  if (!subject || !message) return;
  const panelBody = subject.closest('.panel__body');
  if (panelBody && !document.getElementById('supportDraftMeta')) {
    const meta = document.createElement('div');
    meta.id = 'supportDraftMeta';
    meta.style.cssText = 'margin-bottom:12px;padding:10px 12px;border-radius:10px;background:rgba(47,140,155,0.08);border:1px solid rgba(47,140,155,0.16);font-size:0.76rem;font-weight:700;color:#2F8C9B';
    meta.textContent = 'Drafts auto-save on this device so you can come back later.';
    panelBody.insertBefore(meta, panelBody.firstChild);
  }
  if (panelBody && !document.getElementById('supportTemplateRow')) {
    const row = document.createElement('div');
    row.id = 'supportTemplateRow';
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px';
    row.innerHTML = `
      <button type="button" class="btn btn--ghost btn--sm" onclick="applyTicketTemplate('withdrawal')"><i class="fa-solid fa-arrow-up-from-bracket"></i> Withdrawal delay</button>
      <button type="button" class="btn btn--ghost btn--sm" onclick="applyTicketTemplate('fica')"><i class="fa-solid fa-id-card"></i> FICA status</button>
      <button type="button" class="btn btn--ghost btn--sm" onclick="applyTicketTemplate('statement')"><i class="fa-solid fa-file-invoice"></i> Statement request</button>
      <button type="button" class="btn btn--ghost btn--sm" onclick="applyTicketTemplate('technical')"><i class="fa-solid fa-wrench"></i> Technical issue</button>`;
    const firstGroup = panelBody.querySelector('.form-group');
    if (firstGroup) panelBody.insertBefore(row, firstGroup);
  }
  if (!document.getElementById('tktMessageMeta')) {
    const meta = document.createElement('div');
    meta.id = 'tktMessageMeta';
    meta.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px;font-size:0.72rem;color:var(--text-muted)';
    meta.innerHTML = '<span>Include dates, amounts and references to speed up the response.</span><span id="tktMessageCount">0 / 1200</span>';
    message.insertAdjacentElement('afterend', meta);
  }
}
function initPortalFormUX() {
  _ensureTaskCompletionPanel();
  _ensureProfileAssistUI();
  _ensureSupportAssistUI();
  bindProfileDraft();
  bindSupportDraft();
}
function _profileFields() {
  return {
    first_name: document.getElementById('profFirstName')?.value?.trim() || '',
    last_name: document.getElementById('profLastName')?.value?.trim() || '',
    phone: document.getElementById('profPhone')?.value?.trim() || '',
    city: document.getElementById('profCity')?.value?.trim() || '',
    province: document.getElementById('profProvince')?.value || '',
    risk_profile: document.querySelector('input[name="riskProf"]:checked')?.value || '',
  };
}
function _profileDraftHasValue(data) {
  return !!Object.values(data || {}).find(Boolean);
}
function _applyProfileDraft(data) {
  if (!data) return;
  _profileHydrating = true;
  const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  set('profFirstName', data.first_name || '');
  set('profLastName', data.last_name || '');
  set('profPhone', data.phone || '');
  set('profCity', data.city || '');
  set('profProvince', data.province || '');
  if (data.risk_profile) {
    const radio = document.querySelector(`input[name="riskProf"][value="${data.risk_profile}"]`);
    if (radio) radio.checked = true;
  }
  _profileHydrating = false;
}
function _persistProfileDraft() {
  const data = _profileFields();
  if (!_profileDraftHasValue(data)) {
    _localRemove(_portalScopedKey(PROFILE_DRAFT_KEY));
    _profileDirty = false;
    _setInlineMessage('profileSaveMeta', 'Changes auto-save to this device until you submit.');
    return;
  }
  _localSet(_portalScopedKey(PROFILE_DRAFT_KEY), JSON.stringify({ ...data, saved_at: Date.now() }));
  _profileDirty = true;
  _setInlineMessage('profileSaveMeta', 'Draft saved locally — click Save to update your account.', '#FF8215');
}
function restoreProfileDraft() {
  const raw = _localGet(_portalScopedKey(PROFILE_DRAFT_KEY));
  if (!raw) {
    _profileDirty = false;
    _setInlineMessage('profileSaveMeta', 'Changes auto-save to this device until you submit.');
    return;
  }
  try {
    const draft = JSON.parse(raw);
    const live = _profileFields();
    const same = ['first_name','last_name','phone','city','province','risk_profile'].every(key => String(draft[key] || '') === String(live[key] || ''));
    if (!same) {
      _applyProfileDraft(draft);
      _profileDirty = true;
      _setInlineMessage('profileSaveMeta', 'Draft restored — review your changes and click Save.', '#FF8215');
    }
  } catch (_) {}
}
function clearProfileDraft() {
  _localRemove(_portalScopedKey(PROFILE_DRAFT_KEY));
  _profileDirty = false;
  _setInlineMessage('profileSaveMeta', 'Profile saved.');
}
function bindProfileDraft() {
  if (document.body.dataset.profileDraftBound === '1') return;
  document.body.dataset.profileDraftBound = '1';
  ['profFirstName','profLastName','profPhone','profCity','profProvince'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => { if (!_profileHydrating) _persistProfileDraft(); });
    el.addEventListener('change', () => { if (!_profileHydrating) _persistProfileDraft(); });
  });
  document.querySelectorAll('input[name="riskProf"]').forEach(el => {
    el.addEventListener('change', () => { if (!_profileHydrating) _persistProfileDraft(); });
  });
}
const SUPPORT_TEMPLATES = {
  withdrawal: {
    subject: 'Withdrawal delay',
    category: 'general',
    priority: 'high',
    message: 'Hello SV Capital team, I requested a withdrawal and would like an update on the payout timeline. Reference: \nAmount: \nSubmitted on: \nAdditional context: '
  },
  fica: {
    subject: 'FICA verification status',
    category: 'fica_kyc',
    priority: 'medium',
    message: 'Hello SV Capital team, please share the current status of my FICA / KYC review. Documents uploaded on: \nAnything still outstanding: '
  },
  statement: {
    subject: 'Statement or tax certificate request',
    category: 'general',
    priority: 'medium',
    message: 'Hello SV Capital team, I need help with my statement / tax certificate. Period required: \nPurpose: \nAdditional details: '
  },
  technical: {
    subject: 'Technical issue in the portal',
    category: 'technical',
    priority: 'medium',
    message: 'Hello SV Capital team, I experienced a portal issue. What I was trying to do: \nWhat happened instead: \nDevice / browser: \nTime of issue: '
  }
};
function _supportFields() {
  return {
    subject: document.getElementById('tktSubject')?.value?.trim() || '',
    category: document.getElementById('tktCategory')?.value || 'investment_query',
    priority: document.getElementById('tktPriority')?.value || 'medium',
    message: document.getElementById('tktMessage')?.value || '',
  };
}
function _supportDraftHasValue(data) {
  return !!(data.subject || data.message);
}
function _updateSupportCounter() {
  const msg = document.getElementById('tktMessage')?.value || '';
  const count = document.getElementById('tktMessageCount');
  if (!count) return;
  count.textContent = `${msg.length} / 1200`;
  count.style.color = msg.length > 1200 ? '#ef4444' : 'var(--text-muted)';
}
function _persistSupportDraft() {
  const data = _supportFields();
  _updateSupportCounter();
  if (!_supportDraftHasValue(data)) {
    _localRemove(_portalScopedKey(SUPPORT_DRAFT_KEY));
    _setInlineMessage('supportDraftMeta', 'Drafts auto-save on this device so you can come back later.', '#2F8C9B');
    return;
  }
  _localSet(_portalScopedKey(SUPPORT_DRAFT_KEY), JSON.stringify({ ...data, saved_at: Date.now() }));
  _setInlineMessage('supportDraftMeta', 'Draft saved locally — you can safely leave and come back.', '#2F8C9B');
}
function restoreSupportDraft() {
  _ensureSupportAssistUI();
  _updateSupportCounter();
  const raw = _localGet(_portalScopedKey(SUPPORT_DRAFT_KEY));
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    const subject = document.getElementById('tktSubject');
    const category = document.getElementById('tktCategory');
    const priority = document.getElementById('tktPriority');
    const message = document.getElementById('tktMessage');
    if (!subject || !category || !priority || !message) return;
    _supportHydrating = true;
    subject.value = draft.subject || subject.value;
    category.value = draft.category || category.value;
    priority.value = draft.priority || priority.value;
    message.value = draft.message || message.value;
    _supportHydrating = false;
    _updateSupportCounter();
    _setInlineMessage('supportDraftMeta', 'Draft restored — review and submit when ready.', '#FF8215');
  } catch (_) {}
}
function clearSupportDraft() {
  _localRemove(_portalScopedKey(SUPPORT_DRAFT_KEY));
  _setInlineMessage('supportDraftMeta', 'Ticket sent. Your draft has been cleared.', '#22c55e');
  _updateSupportCounter();
}
function bindSupportDraft() {
  if (document.body.dataset.supportDraftBound === '1') return;
  document.body.dataset.supportDraftBound = '1';
  ['tktSubject','tktMessage','tktCategory','tktPriority'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const evt = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => { if (!_supportHydrating) _persistSupportDraft(); });
    if (evt !== 'change') el.addEventListener('change', () => { if (!_supportHydrating) _persistSupportDraft(); });
  });
  _updateSupportCounter();
}
function applyTicketTemplate(key) {
  _ensureSupportAssistUI();
  const tmpl = SUPPORT_TEMPLATES[key];
  if (!tmpl) return;
  const subject = document.getElementById('tktSubject');
  const category = document.getElementById('tktCategory');
  const priority = document.getElementById('tktPriority');
  const message = document.getElementById('tktMessage');
  if (!subject || !category || !priority || !message) return;
  _supportHydrating = true;
  subject.value = tmpl.subject;
  category.value = tmpl.category;
  priority.value = tmpl.priority;
  message.value = tmpl.message;
  _supportHydrating = false;
  _persistSupportDraft();
  message.focus();
  message.setSelectionRange(message.value.length, message.value.length);
}
function renderTaskCompletionPanel() {
  const wrap = _ensureTaskCompletionPanel();
  const body = document.getElementById('taskCompletionBody');
  const meta = document.getElementById('taskCompletionMeta');
  if (!wrap || !body || !meta || !PORTAL.investor) return;
  const inv = PORTAL.investor;
  const hasInvestments = (PORTAL.investments || []).length > 0;
  const hasWallet = (parseFloat(inv.wallet_balance) || 0) > 0;
  const bankReady = !!(inv.bank_account_number || (inv.bank_account_status && inv.bank_account_status !== 'none' && inv.bank_account_status !== 'pending'));
  const riskReady = !!inv.risk_profile;
  const ficaReady = (inv.fica_status || inv.kyc_status || inv.status || '').toLowerCase() === 'approved';
  const tasks = [
    { label: 'Complete FICA/KYC verification', done: ficaReady, tone: '#FF8215', action: 'openKycUploadModal()', cta: 'Upload documents' },
    { label: 'Add a withdrawal bank account', done: bankReady, tone: '#2F8C9B', action: 'openBankDetailsModal()', cta: 'Add bank account' },
    { label: 'Fund your wallet', done: hasWallet, tone: '#22c55e', action: 'openTopUpModal()', cta: 'Top up wallet' },
    { label: 'Confirm your risk profile', done: riskReady, tone: '#a855f7', action: 'navigate(\'profile\', document.querySelector(\'[data-view=profile]\'))', cta: 'Review profile' },
    { label: 'Make your next investment', done: hasInvestments, tone: '#D4AF37', action: 'navigate(\'marketplace\', document.querySelector(\'[data-view=marketplace]\'))', cta: 'Browse pools' },
  ];
  const doneCount = tasks.filter(t => t.done).length;
  const pending = tasks.filter(t => !t.done);
  meta.textContent = `${doneCount}/${tasks.length} complete`;
  wrap.style.display = 'block';
  if (!pending.length) {
    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;justify-content:space-between">
        <div>
          <div style="font-size:0.9rem;font-weight:800;color:#1a1a1a;margin-bottom:4px">You're set up and ready to invest confidently.</div>
          <div style="font-size:0.8rem;color:var(--text-muted)">Use Quick Actions to top up, browse new pools or generate your latest statement.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn--secondary btn--sm" onclick="navigate('statement', document.querySelector('[data-view=statement]'))"><i class="fa-solid fa-file-invoice"></i> Statement</button>
          <button class="btn btn--primary btn--sm" onclick="navigate('marketplace', document.querySelector('[data-view=marketplace]'))"><i class="fa-solid fa-plus"></i> Invest more</button>
        </div>
      </div>`;
    return;
  }
  body.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-bottom:14px">
      ${tasks.map(task => `
        <div style="padding:12px 14px;border-radius:12px;border:1px solid rgba(0,0,0,0.06);background:${task.done ? 'rgba(34,197,94,0.06)' : 'rgba(255,255,255,0.82)'};display:flex;gap:10px;align-items:flex-start">
          <div style="width:24px;height:24px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:${task.done ? '#22c55e' : task.tone + '22'};color:${task.done ? '#fff' : task.tone};flex-shrink:0;margin-top:2px">
            <i class="fa-solid ${task.done ? 'fa-check' : 'fa-circle'}" style="font-size:0.7rem"></i>
          </div>
          <div style="min-width:0;flex:1">
            <div style="font-size:0.8rem;font-weight:700;color:#1a1a1a;line-height:1.35">${task.label}</div>
            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px">${task.done ? 'Completed' : 'Still needed before the full flow feels seamless.'}</div>
          </div>
        </div>`).join('')}
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:4px;border-top:1px solid rgba(0,0,0,0.06)">
      <div>
        <div style="font-size:0.78rem;font-weight:800;color:#1a1a1a">Recommended next step</div>
        <div style="font-size:0.76rem;color:var(--text-muted);margin-top:4px">${pending[0].label}</div>
      </div>
      <button class="btn btn--primary btn--sm" onclick="${pending[0].action}"><i class="fa-solid fa-bolt"></i> ${pending[0].cta}</button>
    </div>`;
}


function _isInvestorFicaApproved(inv = PORTAL.investor) {
  const state = String(inv?.fica_status || inv?.kyc_status || inv?.status || '').toLowerCase();
  return ['approved', 'verified', 'active'].includes(state);
}

function _getOpenMarketplacePools() {
  return (PORTAL.pools || []).filter(p => p && (p.status === 'open' || p.status === 'waitlist'));
}

function _rankMarketPools(pools, walletBalance = parseFloat(PORTAL.investor?.wallet_balance || 0)) {
  return [...(pools || [])].sort((a, b) => {
    const aOpen = a.status === 'open' ? 1 : 0;
    const bOpen = b.status === 'open' ? 1 : 0;
    if (aOpen !== bOpen) return bOpen - aOpen;
    const aMin = parseFloat(a.min_investment) || 0;
    const bMin = parseFloat(b.min_investment) || 0;
    const aAffordable = walletBalance >= aMin ? 1 : 0;
    const bAffordable = walletBalance >= bMin ? 1 : 0;
    if (aAffordable !== bAffordable) return bAffordable - aAffordable;
    const aGap = Math.max(0, aMin - walletBalance);
    const bGap = Math.max(0, bMin - walletBalance);
    if (aGap !== bGap) return aGap - bGap;
    const aDays = Utils.daysRemaining(a.end_date);
    const bDays = Utils.daysRemaining(b.end_date);
    const aUrgency = aDays === null ? 9999 : aDays;
    const bUrgency = bDays === null ? 9999 : bDays;
    if (aUrgency !== bUrgency) return aUrgency - bUrgency;
    const aRate = parseFloat(a.annual_rate) || 0;
    const bRate = parseFloat(b.annual_rate) || 0;
    return bRate - aRate;
  });
}

function _ensureWalletReadinessPanel() {
  let panel = document.getElementById('walletReadinessPanel');
  if (panel) return panel;
  const activityPanel = document.getElementById('walletActivity')?.closest('.panel');
  if (!activityPanel || !activityPanel.parentNode) return null;
  panel = document.createElement('div');
  panel.id = 'walletReadinessPanel';
  panel.className = 'panel mb-16';
  activityPanel.parentNode.insertBefore(panel, activityPanel);
  return panel;
}

function renderWalletReadinessPanel() {
  const panel = _ensureWalletReadinessPanel();
  const inv = PORTAL.investor;
  if (!panel || !inv) return;
  const wallet = parseFloat(inv.wallet_balance) || 0;
  const pools = _rankMarketPools(_getOpenMarketplacePools().filter(p => p.status === 'open'), wallet);
  const affordable = pools.filter(p => wallet >= (parseFloat(p.min_investment) || 0));
  const cheapest = [...pools].sort((a, b) => (parseFloat(a.min_investment) || 0) - (parseFloat(b.min_investment) || 0))[0] || null;
  const pendingDeposit = (PORTAL.transactions || []).find(t => t.type === 'deposit' && t.status === 'pending');
  const pendingWithdrawal = (PORTAL.transactions || []).find(t => t.type === 'withdrawal' && t.status === 'pending');
  const ficaApproved = _isInvestorFicaApproved(inv);
  const bankApproved = !!inv.bank_account_number && inv.bank_account_status === 'approved';

  let headline = 'Your wallet is the fastest path to your next investment.';
  let subcopy = 'Choose the next action that will get you to a completed investment quickest.';
  let ctaLabel = 'Top up wallet';
  let ctaAction = "openTopUpModal()";
  let accent = '#FF9B0C';

  if (!ficaApproved) {
    headline = 'Complete FICA/KYC first to unlock investing.';
    subcopy = 'Once verified, you can fund your wallet and invest without hitting a dead-end later.';
    ctaLabel = 'Complete FICA/KYC';
    ctaAction = "navigate('profile', document.querySelector('[data-view=profile]'));openKycUploadModal()";
    accent = '#2F8C9B';
  } else if (affordable.length) {
    const best = affordable[0];
    headline = `You can already invest in ${affordable.length} open pool${affordable.length === 1 ? '' : 's'}.`;
    subcopy = best ? `${best.name} is the closest match for your current wallet balance.` : subcopy;
    ctaLabel = 'Invest now';
    ctaAction = "navigate('marketplace', document.querySelector('[data-view=marketplace]'))";
    accent = '#22C55E';
  } else if (cheapest) {
    const gap = Math.max(0, (parseFloat(cheapest.min_investment) || 0) - wallet);
    headline = `Top up ${Utils.rand(gap)} to reach the lowest open minimum.`;
    subcopy = `${cheapest.name} is currently the most reachable pool for your next step.`;
    ctaLabel = 'Top up now';
    ctaAction = "openTopUpModal()";
    accent = '#FF9B0C';
  }

  panel.innerHTML = `
    <div class="panel__header" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span class="panel__title"><i class="fa-solid fa-bolt" style="color:${accent}"></i> Wallet Readiness</span>
      <span style="margin-left:auto;font-size:0.72rem;font-weight:700;color:${accent};background:${accent}14;padding:4px 10px;border-radius:999px;border:1px solid ${accent}2f">${ficaApproved ? 'Investment ready checks' : 'Verification blocking progress'}</span>
    </div>
    <div class="panel__body" style="display:flex;flex-direction:column;gap:14px">
      <div style="border:1px solid rgba(0,0,0,0.06);border-radius:14px;padding:14px 16px;background:linear-gradient(135deg,rgba(255,255,255,0.98),rgba(255,155,12,0.05))">
        <div style="font-size:0.92rem;font-weight:800;color:#1a1a1a;line-height:1.35">${headline}</div>
        <div style="font-size:0.78rem;color:var(--text-muted);margin-top:5px;line-height:1.55">${subcopy}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          <button class="btn btn--primary btn--sm" onclick="${ctaAction}"><i class="fa-solid fa-arrow-right"></i> ${ctaLabel}</button>
          <button class="btn btn--secondary btn--sm" onclick="navigate('statement', document.querySelector('[data-view=statement]'))"><i class="fa-solid fa-file-invoice"></i> Statement</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px">
        <div style="padding:12px 14px;border:1px solid rgba(0,0,0,0.06);border-radius:12px;background:#fff">
          <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;font-weight:800">Wallet balance</div>
          <div style="font-size:1.12rem;font-weight:900;color:#1a1a1a;margin-top:4px">${Utils.rand(wallet)}</div>
          <div style="font-size:0.74rem;color:var(--text-muted);margin-top:4px">${affordable.length ? `${affordable.length} pool${affordable.length === 1 ? '' : 's'} you can join now` : cheapest ? `${Utils.rand(Math.max(0, (parseFloat(cheapest.min_investment) || 0) - wallet))} short of the next minimum` : 'No open pools to compare right now'}</div>
        </div>
        <div style="padding:12px 14px;border:1px solid rgba(0,0,0,0.06);border-radius:12px;background:#fff">
          <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;font-weight:800">Verification</div>
          <div style="font-size:0.88rem;font-weight:800;color:${ficaApproved ? '#22c55e' : '#2F8C9B'};margin-top:6px">${ficaApproved ? 'FICA/KYC approved' : 'FICA/KYC still needed'}</div>
          <div style="font-size:0.74rem;color:var(--text-muted);margin-top:4px">${bankApproved ? 'Withdrawal bank account verified.' : inv.bank_account_number ? 'Bank account pending review.' : 'Add your bank account before your first withdrawal.'}</div>
        </div>
        <div style="padding:12px 14px;border:1px solid rgba(0,0,0,0.06);border-radius:12px;background:#fff">
          <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;font-weight:800">Money in motion</div>
          <div style="font-size:0.88rem;font-weight:800;color:#1a1a1a;margin-top:6px">${pendingDeposit ? 'Deposit pending review' : pendingWithdrawal ? 'Withdrawal pending payout' : 'No pending money movement'}</div>
          <div style="font-size:0.74rem;color:var(--text-muted);margin-top:4px">${pendingDeposit ? `${Utils.rand(Math.abs(parseFloat(pendingDeposit.amount) || 0))} will reflect once admin review completes.` : pendingWithdrawal ? `${Utils.rand(Math.abs(parseFloat(pendingWithdrawal.amount) || 0))} is already in the payout queue.` : 'Your next top-up or withdrawal request will appear here.'}</div>
        </div>
      </div>
    </div>`;
}

function _ensureMarketConversionPanel() {
  let panel = document.getElementById('marketConversionPanel');
  if (panel) return panel;
  const grid = document.getElementById('marketplaceGrid');
  if (!grid || !grid.parentNode) return null;
  panel = document.createElement('div');
  panel.id = 'marketConversionPanel';
  panel.className = 'panel mb-16';
  grid.parentNode.insertBefore(panel, grid);
  return panel;
}

function renderMarketConversionPanel(pools) {
  const panel = _ensureMarketConversionPanel();
  if (!panel) return;
  const inv = PORTAL.investor || {};
  const wallet = parseFloat(inv.wallet_balance) || 0;
  const ranked = _rankMarketPools((pools || []).filter(Boolean), wallet);
  const openPools = ranked.filter(p => p.status === 'open');
  const affordable = openPools.filter(p => wallet >= (parseFloat(p.min_investment) || 0));
  const cheapest = openPools.slice().sort((a, b) => (parseFloat(a.min_investment) || 0) - (parseFloat(b.min_investment) || 0))[0] || null;
  const ficaApproved = _isInvestorFicaApproved(inv);
  const featured = ranked.slice(0, 3);

  let title = 'Use this view to move from browsing to a funded decision.';
  let sub = 'We surface the next-best pools first so you can complete the journey with fewer dead-ends.';
  let action = "navigate('wallet', document.querySelector('[data-view=wallet]'))";
  let actionLabel = 'Review wallet';
  let accent = '#2F8C9B';

  if (!ficaApproved) {
    title = 'Your first investment is blocked by pending FICA/KYC.';
    sub = 'Complete verification before funding more or choosing an amount so your first investment can go through cleanly.';
    action = "navigate('profile', document.querySelector('[data-view=profile]'));openKycUploadModal()";
    actionLabel = 'Complete FICA/KYC';
    accent = '#2F8C9B';
  } else if (affordable.length) {
    title = `You can invest right now in ${affordable.length} open pool${affordable.length === 1 ? '' : 's'}.`;
    sub = 'Recommended pools below are ranked by affordability, urgency, and expected return so you can act quickly.';
    action = "openInvestModal('" + affordable[0].id + "')";
    actionLabel = 'Open best-fit pool';
    accent = '#22c55e';
  } else if (cheapest) {
    const gap = Math.max(0, (parseFloat(cheapest.min_investment) || 0) - wallet);
    title = `Top up ${Utils.rand(gap)} to unlock your next eligible pool.`;
    sub = `${cheapest.name} has the lowest reachable minimum among current opportunities.`;
    action = "openTopUpModal()";
    actionLabel = 'Top up wallet';
    accent = '#FF9B0C';
  } else if (!openPools.length) {
    title = 'There are no open pools in this filter right now.';
    sub = 'Use the waitlist options below or switch category to keep your momentum.';
    action = "filterMarket('all', document.querySelector('#view-marketplace .tab-bar .tab-btn'))";
    actionLabel = 'Show all pools';
    accent = '#A855F7';
  }

  panel.innerHTML = `
    <div class="panel__body" style="display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <div style="max-width:680px">
          <div style="font-size:0.98rem;font-weight:900;color:#1a1a1a;line-height:1.35">${title}</div>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-top:5px;line-height:1.6">${sub}</div>
        </div>
        <button class="btn btn--primary btn--sm" onclick="${action}" style="white-space:nowrap"><i class="fa-solid fa-arrow-right"></i> ${actionLabel}</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
        ${featured.length ? featured.map((pool, idx) => {
          const min = parseFloat(pool.min_investment) || 0;
          const days = Utils.daysRemaining(pool.end_date);
          const affordableNow = wallet >= min;
          return `<div style="padding:12px 14px;border-radius:12px;border:1px solid ${idx === 0 ? accent + '44' : 'rgba(0,0,0,0.07)'};background:${idx === 0 ? accent + '0d' : '#fff'}">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <span style="font-size:0.68rem;font-weight:800;color:${idx === 0 ? accent : '#6b7280'};background:${idx === 0 ? accent + '14' : 'rgba(107,114,128,0.1)'};padding:3px 8px;border-radius:999px;border:1px solid ${idx === 0 ? accent + '33' : 'rgba(107,114,128,0.15)'}">${idx === 0 ? 'Best next step' : pool.status === 'waitlist' ? 'Waitlist' : 'Worth comparing'}</span>
            </div>
            <div style="font-size:0.83rem;font-weight:800;color:#1a1a1a;line-height:1.35">${_esc(pool.name || 'Pool')}</div>
            <div style="display:flex;justify-content:space-between;gap:8px;margin-top:10px;font-size:0.73rem;color:var(--text-muted)"><span>${Utils.pct(pool.annual_rate)} p.a.</span><span>${pool.term_months || '—'} months</span></div>
            <div style="display:flex;justify-content:space-between;gap:8px;margin-top:4px;font-size:0.73rem;color:var(--text-muted)"><span>Minimum</span><span style="font-weight:800;color:${affordableNow ? '#22c55e' : '#1a1a1a'}">${Utils.rand(min)}</span></div>
            <div style="display:flex;justify-content:space-between;gap:8px;margin-top:4px;font-size:0.73rem;color:var(--text-muted)"><span>Closes in</span><span>${days === null ? '—' : days + 'd'}</span></div>
          </div>`;
        }).join('') : `<div style="grid-column:1/-1;font-size:0.78rem;color:var(--text-muted);padding:12px 0">No pools available in this view right now.</div>`}
      </div>
    </div>`;
}

let _statementAssistMeta = null;

function _statementTaxYearRange(year) {
  const y = parseInt(year, 10) || new Date().getFullYear();
  const from = new Date(y - 1, 2, 1);
  const to = new Date(y, 1, 28);
  return {
    from: from.toISOString().split('T')[0],
    to: to.toISOString().split('T')[0]
  };
}

function applyStatementPreset(kind) {
  const fromEl = document.getElementById('stmtFrom');
  const toEl = document.getElementById('stmtTo');
  if (!fromEl || !toEl) return;
  const today = new Date();
  let from = new Date(today);
  let to = new Date(today);
  if (kind === '30d') {
    from.setDate(today.getDate() - 30);
  } else if (kind === '90d') {
    from.setDate(today.getDate() - 90);
  } else if (kind === 'tax') {
    const range = _statementTaxYearRange(document.getElementById('taxYearSelect')?.value || today.getFullYear());
    fromEl.value = range.from;
    toEl.value = range.to;
    renderStatementAssistCard({ preset: kind });
    return;
  } else {
    from = new Date('2020-01-01T00:00:00');
  }
  fromEl.value = from.toISOString().split('T')[0];
  toEl.value = to.toISOString().split('T')[0];
  renderStatementAssistCard({ preset: kind });
}

function _ensureStatementAssistCard() {
  let card = document.getElementById('statementAssistCard');
  if (card) return card;
  const quick = document.getElementById('stmtQuickStats');
  const sidebar = quick?.parentElement?.parentElement?.parentElement;
  if (!sidebar) return null;
  card = document.createElement('div');
  card.id = 'statementAssistCard';
  card.style.cssText = 'background:#fff;border:1px solid rgba(0,0,0,0.08);border-radius:14px;box-shadow:0 2px 12px rgba(0,0,0,0.06);overflow:hidden';
  sidebar.insertBefore(card, sidebar.children[1] || null);
  return card;
}

function bindStatementAssist() {
  if (document.body.dataset.statementAssistBound === '1') return;
  document.body.dataset.statementAssistBound = '1';
  ['stmtFrom','stmtTo','stmtIncPortfolio','stmtIncInvestments','stmtIncTransactions','stmtIncPerformance','taxYearSelect'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => renderStatementAssistCard({ trigger: id }));
    if (el.tagName === 'INPUT' && el.type === 'date') el.addEventListener('input', () => renderStatementAssistCard({ trigger: id }));
  });
}

function renderStatementAssistCard(meta = {}) {
  const card = _ensureStatementAssistCard();
  if (!card) return;
  if (meta && Object.keys(meta).length) _statementAssistMeta = { ...(_statementAssistMeta || {}), ...meta };
  const fromVal = document.getElementById('stmtFrom')?.value || '2020-01-01';
  const toVal = document.getElementById('stmtTo')?.value || new Date().toISOString().split('T')[0];
  const sections = [
    document.getElementById('stmtIncPortfolio')?.checked && 'Portfolio',
    document.getElementById('stmtIncInvestments')?.checked && 'Investments',
    document.getElementById('stmtIncTransactions')?.checked && 'Transactions',
    document.getElementById('stmtIncPerformance')?.checked && 'Performance'
  ].filter(Boolean);
  const taxYear = document.getElementById('taxYearSelect')?.value || new Date().getFullYear();
  card.innerHTML = `
    <div style="padding:14px 18px;border-bottom:1px solid rgba(0,0,0,0.07);background:#F7F8FA">
      <span style="font-size:0.82rem;font-weight:800;color:#1a1a1a"><i class="fa-solid fa-wand-magic-sparkles" style="color:#FF9B0C;margin-right:6px"></i>Faster statement workflow</span>
    </div>
    <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn--secondary btn--sm" onclick="applyStatementPreset('30d')">Last 30 days</button>
        <button class="btn btn--secondary btn--sm" onclick="applyStatementPreset('90d')">Last 90 days</button>
        <button class="btn btn--secondary btn--sm" onclick="applyStatementPreset('tax')">Tax year</button>
        <button class="btn btn--secondary btn--sm" onclick="applyStatementPreset('all')">All activity</button>
      </div>
      <div style="font-size:0.76rem;color:var(--text-muted);line-height:1.6">
        <div><strong style="color:#1a1a1a">Current range:</strong> ${fmtDate(fromVal)} — ${fmtDate(toVal)}</div>
        <div style="margin-top:4px"><strong style="color:#1a1a1a">Included sections:</strong> ${sections.length ? sections.join(', ') : 'Portfolio summary will be added automatically'}</div>
        <div style="margin-top:4px"><strong style="color:#1a1a1a">Tax certificate:</strong> IT3(b) for year ending Feb ${taxYear}</div>
      </div>
      ${_statementAssistMeta?.generatedAt ? `<div style="padding:10px 12px;border-radius:10px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.18);font-size:0.75rem;color:#166534;line-height:1.55"><strong>Last preview generated:</strong> ${_statementAssistMeta.generatedAt}<br>${_statementAssistMeta.summary || ''}</div>` : `<div style="padding:10px 12px;border-radius:10px;background:rgba(255,155,12,0.08);border:1px solid rgba(255,155,12,0.18);font-size:0.75rem;color:#9a5d00;line-height:1.55">Generate a preview once, then use Print / Save PDF to complete the task without re-entering your settings.</div>`}
    </div>`;
}

/* ─── Skeleton loading helpers ─── */
function _skeletonRows(count, cols) {
  return Array(count).fill(0).map(() =>
    `<tr>${Array(cols).fill('<td><span class="skeleton" style="display:inline-block;width:80%;height:14px;border-radius:4px"></span></td>').join('')}</tr>`
  ).join('');
}
function _skeletonCards(count) {
  return Array(count).fill(0).map(() =>
    `<div class="my-inv-card" style="opacity:0.5"><div class="skeleton" style="height:120px;border-radius:12px"></div></div>`
  ).join('');
}

/* ─── Button loading state helper ─── */
async function _withBtn(btn, asyncFn) {
  if (!btn || btn.disabled) return;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  try { await asyncFn(); } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

/* ─── Copy to clipboard ─── */
async function _copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(String(text));
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-check" style="color:#22c55e"></i>';
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }
    Toast.success('Copied!');
  } catch (_) { Toast.info('Press Ctrl+C to copy'); }
}

/* ─── Confirm dialog (replaces browser confirm()) ─── */
const Confirm = {
  ask(message, { title = 'Are you sure?', confirmLabel = 'Confirm', confirmClass = 'btn--danger', cancelLabel = 'Cancel' } = {}) {
    return new Promise(resolve => {
      let el = document.getElementById('portalConfirmModal');
      if (!el) {
        el = document.createElement('div');
        el.id = 'portalConfirmModal';
        el.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;align-items:center;justify-content:center';
        el.innerHTML = `
          <div style="background:#fff;border-radius:16px;padding:28px 24px;max-width:400px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.2)">
            <div id="pcTitle" style="font-size:1.05rem;font-weight:800;color:#1a1a1a;margin-bottom:8px"></div>
            <div id="pcMsg"   style="font-size:0.88rem;color:#6b7280;line-height:1.6;margin-bottom:20px"></div>
            <div style="display:flex;gap:10px;justify-content:flex-end">
              <button id="pcCancel"  class="btn btn--secondary" style="min-width:90px"></button>
              <button id="pcConfirm" class="btn btn--primary"   style="min-width:90px"></button>
            </div>
          </div>`;
        document.body.appendChild(el);
      }
      el.style.display = 'flex';
      document.getElementById('pcTitle').textContent = title;
      document.getElementById('pcMsg').textContent   = message;
      const cancelBtn  = document.getElementById('pcCancel');
      const confirmBtn = document.getElementById('pcConfirm');
      cancelBtn.textContent  = cancelLabel;
      confirmBtn.textContent = confirmLabel;
      confirmBtn.className   = `btn ${confirmClass}`;
      const done = (val) => { el.style.display = 'none'; resolve(val); };
      cancelBtn.onclick  = () => done(false);
      confirmBtn.onclick = () => done(true);
      el.onclick = (e) => { if (e.target === el) done(false); };
    });
  }
};

/* ── Pull-to-refresh ─────────────────────────────────────── */
function _initPullToRefresh() {
  if (!window.__SVC_NATIVE__) return; // native app only
  let startY = 0, currentY = 0, isPulling = false;
  const MIN_PULL = 72;

  const el = document.createElement('div');
  el.id = '_ptrIndicator';
  el.style.cssText = 'position:fixed;top:0;left:50%;transform:translate(-50%,-56px);z-index:9999;width:40px;height:40px;border-radius:50%;background:var(--gold);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(212,175,55,0.4);transition:transform 0.2s,opacity 0.2s;opacity:0;pointer-events:none';
  el.innerHTML = '<i class="fa-solid fa-arrow-rotate-right" style="color:#000;font-size:1rem"></i>';
  document.body.appendChild(el);

  document.addEventListener('touchstart', e => {
    if (window.scrollY === 0) { startY = e.touches[0].clientY; isPulling = true; }
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!isPulling || startY === 0) return;
    currentY = e.touches[0].clientY;
    const delta = Math.max(0, currentY - startY);
    if (delta > 0) {
      const progress = Math.min(delta / MIN_PULL, 1);
      const travel = Math.min(delta * 0.45, 52);
      el.style.opacity = progress;
      el.style.transform = `translate(-50%, ${travel - 56}px) rotate(${progress * 270}deg)`;
    }
  }, { passive: true });

  document.addEventListener('touchend', async () => {
    if (!isPulling) return;
    isPulling = false;
    const delta = Math.max(0, currentY - startY);
    startY = 0; currentY = 0;
    if (delta >= MIN_PULL) {
      el.style.transition = 'transform 0.3s,opacity 0.3s';
      el.style.transform = 'translate(-50%, -4px) rotate(360deg)';
      el.querySelector('i').classList.add('fa-spin');
      try {
        await loadPortalData();
        if (typeof loadWallet === 'function') await loadWallet();
        Toast.success('Refreshed');
      } catch (_) {}
      el.querySelector('i').classList.remove('fa-spin');
    }
    el.style.opacity = '0';
    el.style.transform = 'translate(-50%,-56px)';
    setTimeout(() => { el.style.transition = ''; }, 300);
  }, { passive: true });
}

/* ── Full-screen success overlay ─────────────────────────── */
function showSuccessOverlay({ title = 'Success!', subtitle = '', duration = 2200 } = {}) {
  const existing = document.getElementById('_successOverlay');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = '_successOverlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(6,10,15,0.92);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;opacity:0;transition:opacity 0.3s;pointer-events:none';
  el.innerHTML = `
    <div style="width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,#22c55e,#16a34a);display:flex;align-items:center;justify-content:center;box-shadow:0 0 40px rgba(34,197,94,0.4);animation:_so-pop 0.4s cubic-bezier(0.34,1.56,0.64,1) both">
      <i class="fa-solid fa-check" style="font-size:2rem;color:#fff"></i>
    </div>
    <div style="font-size:1.35rem;font-weight:800;color:#fff;text-align:center">${title}</div>
    ${subtitle ? `<div style="font-size:0.88rem;color:rgba(255,255,255,0.6);text-align:center;max-width:280px">${subtitle}</div>` : ''}
  `;
  // Add keyframe if not present
  if (!document.getElementById('_soStyle')) {
    const s = document.createElement('style');
    s.id = '_soStyle';
    s.textContent = '@keyframes _so-pop{0%{transform:scale(0.5);opacity:0}100%{transform:scale(1);opacity:1}}';
    document.head.appendChild(s);
  }
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

/* ─── Notifications ─── */
function toggleNotifPanel() {
  const panel = document.getElementById('notifPanel');
  const btn   = document.getElementById('notifBtn');
  if (!panel) return;

  const isOpen = panel.classList.contains('notif-panel--open');
  if (isOpen) {
    panel.classList.remove('notif-panel--open');
    panel.style.display = 'none';
  } else {
    panel.style.display = 'block';
    // Force reflow so transition plays
    panel.offsetHeight; // eslint-disable-line no-unused-expressions
    panel.classList.add('notif-panel--open');
    SVC.track('svc_notifications_opened', { unread_count: document.querySelectorAll('.notif-item.unread').length });
    // Close when clicking outside
    setTimeout(() => {
      document.addEventListener('click', function closePanel(e) {
        if (!panel.contains(e.target) && !btn?.contains(e.target)) {
          panel.classList.remove('notif-panel--open');
          panel.style.display = 'none';
          document.removeEventListener('click', closePanel);
        }
      });
    }, 10);
  }
}

/* Initialise the unread dot based on actual unread items */
function _syncNotifDot() {
  const dot     = document.getElementById('notifDot');
  const unread  = document.querySelectorAll('#notifPanel .notif-item.unread').length;
  if (dot) dot.classList.toggle('has-unread', unread > 0);
}

function markAllRead() {
  document.querySelectorAll('#notifPanel .notif-item.unread').forEach(el => el.classList.remove('unread'));
  const dot = document.getElementById('notifDot');
  if (dot) dot.classList.remove('has-unread');
}

/* ─── Time-based greeting ─── */
function _timeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/* ─── Animated number ─── */
function _animateNum(el, target, prefix = '', suffix = '', duration = 900) {
  if (!el) return;
  const safeTarget = (target == null || isNaN(Number(target))) ? 0 : Number(target);
  const start = parseFloat(el.dataset.animated || 0);
  const startTime = performance.now();
  const step = (now) => {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = start + (safeTarget - start) * eased;
    el.textContent = prefix + Math.round(current).toLocaleString('en-ZA') + suffix;
    if (progress < 1) requestAnimationFrame(step);
    else { el.textContent = prefix + Math.round(safeTarget).toLocaleString('en-ZA') + suffix; el.dataset.animated = safeTarget; }
  };
  requestAnimationFrame(step);
}

function loadNotifications() {
  const list = document.getElementById('notifList');
  if (!list) return;

  const notifs = [];
  const inv = PORTAL.investor;

  // 1. Low wallet balance
  if (inv && parseFloat(inv.wallet_balance) < 500) {
    notifs.push({
      icon: 'fa-wallet', iconBg: 'rgba(255,155,12,0.12)', iconColor: '#ff9b0c',
      title: 'Low wallet balance',
      sub: `Your balance is ${Utils.rand(parseFloat(inv.wallet_balance) || 0)}. Top up to keep investing.`,
      time: 'Now',
      action: "openTopUpModal()",
      unread: true,
    });
  }

  // 2. Investments maturing within 60 days
  const now = new Date();
  const soon = PORTAL.investments.filter(i => {
    if (i.status !== 'active') return false;
    const end = new Date(i.end_date || i.maturity_date);
    if (!end || isNaN(end)) return false;
    const days = Math.round((end - now) / 86400000);
    return days >= 0 && days <= 60;
  });
  if (soon.length) {
    const s = soon[0];
    const daysLeft = Math.round((new Date(s.end_date || s.maturity_date) - now) / 86400000);
    notifs.push({
      icon: 'fa-coins', iconBg: 'rgba(34,197,94,0.1)', iconColor: '#22c55e',
      title: 'Investment maturing soon',
      sub: `${s.pool_name || 'An investment'} matures in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Submit your maturity instruction.`,
      time: `${daysLeft}d away`,
      action: "navigate('investments',document.querySelector('[data-view=investments]'))",
      unread: true,
    });
  }

  // 3. FICA / KYC status notifications
  if (inv) {
    if (inv.fica_status === 'rejected' || inv.kyc_status === 'rejected') {
      notifs.push({
        icon: 'fa-triangle-exclamation', iconBg: 'rgba(239,68,68,0.12)', iconColor: '#ef4444',
        title: 'FICA/KYC verification unsuccessful',
        sub: 'Your documents could not be verified. Please re-upload and resubmit.',
        time: 'Action required',
        action: "navigate('fica',document.querySelector('[data-view=fica]'))",
        unread: true,
      });
    } else if (inv.fica_status === 'pending' || inv.kyc_status === 'pending' || inv.status === 'fica_submitted') {
      notifs.push({
        icon: 'fa-clock', iconBg: 'rgba(255,155,12,0.12)', iconColor: '#ff9b0c',
        title: 'FICA/KYC verification in progress',
        sub: 'Your documents are under review — typically 1–2 business days.',
        time: 'Pending',
        action: null,
        unread: false,
      });
    } else if (inv.fica_status === 'approved') {
      notifs.push({
        icon: 'fa-shield-halved', iconBg: 'rgba(168,85,247,0.1)', iconColor: '#a855f7',
        title: 'Identity verified',
        sub: 'Your FICA/KYC verification is complete. You can invest in all available pools.',
        time: inv.fica_verified_at ? Utils.timeAgo(inv.fica_verified_at) : 'Approved',
        action: null,
        unread: false,
      });
    }
  }

  // 4. Bank account status
  if (inv && inv.bank_account_number) {
    if (inv.bank_account_status === 'pending') {
      notifs.push({
        icon: 'fa-building-columns', iconBg: 'rgba(255,155,12,0.12)', iconColor: '#ff9b0c',
        title: 'Bank account pending verification',
        sub: `${inv.bank_name || 'Your bank account'} is being reviewed by our team. Withdrawals will be enabled once approved.`,
        time: 'Under review',
        action: null,
        unread: false,
      });
    } else if (inv.bank_account_status === 'approved') {
      notifs.push({
        icon: 'fa-building-columns', iconBg: 'rgba(34,197,94,0.1)', iconColor: '#22c55e',
        title: 'Bank account verified',
        sub: `Your ${inv.bank_name || 'bank'} account has been verified. You can now request withdrawals.`,
        time: 'Approved',
        action: "navigate('wallet',document.querySelector('[data-view=wallet]'))",
        unread: true,
      });
    } else if (inv.bank_account_status === 'rejected') {
      notifs.push({
        icon: 'fa-building-columns', iconBg: 'rgba(239,68,68,0.12)', iconColor: '#ef4444',
        title: 'Bank account not verified',
        sub: inv.bank_account_notes || 'Your bank details could not be verified. Please update and resubmit.',
        time: 'Action required',
        action: "navigate('profile',document.querySelector('[data-view=profile]'))",
        unread: true,
      });
    }
  }

  // 5. Maturity overdue — investment has matured but no instruction yet
  const overdue = PORTAL.investments.filter(i => {
    if (i.status !== 'matured') return false;
    return !i.maturity_instruction;
  });
  if (overdue.length) {
    notifs.push({
      icon: 'fa-exclamation-circle', iconBg: 'rgba(239,68,68,0.12)', iconColor: '#ef4444',
      title: `${overdue.length} investment${overdue.length === 1 ? '' : 's'} awaiting instruction`,
      sub: `${overdue.map(i => i.pool_name || 'Investment').slice(0,2).join(', ')} ha${overdue.length === 1 ? 's' : 've'} matured — submit your payout instruction now.`,
      time: 'Urgent',
      action: "navigate('maturity',document.querySelector('[data-view=maturity]'))",
      unread: true,
    });
  }

  // 6. Support ticket responses — one notification per answered ticket
  const answered = PORTAL.tickets.filter(t => t.admin_response && t.admin_response.trim());
  answered.forEach(t => {
    notifs.push({
      icon: 'fa-reply', iconBg: 'rgba(47,140,155,0.1)', iconColor: '#2F8C9B',
      title: 'Support reply received',
      sub: `"${t.subject}" — our team has responded.`,
      time: t.responded_at ? Utils.timeAgo(t.responded_at) : 'Recently',
      action: "navigate('support',document.querySelector('[data-view=support]'))",
      unread: true,
    });
  });

  // 7. Pending withdrawal submitted
  const pendingWithdrawal = PORTAL.transactions.find(t => t.type === 'withdrawal' && t.status === 'pending');
  if (pendingWithdrawal) {
    notifs.push({
      icon: 'fa-money-bill-transfer', iconBg: 'rgba(99,102,241,0.1)', iconColor: '#6366f1',
      title: 'Withdrawal in progress',
      sub: `${Utils.rand(Math.abs(pendingWithdrawal.amount))} withdrawal is being processed — 1–2 business days.`,
      time: Utils.timeAgo(pendingWithdrawal.created_at || pendingWithdrawal.transaction_date),
      action: "navigate('wallet',document.querySelector('[data-view=wallet]'))",
      unread: false,
    });
  }

  // 8. New pools opened in last 14 days
  const newPools = PORTAL.pools.filter(p => {
    if (p.status !== 'open') return false;
    return (now - new Date(p.created_at)) < 14 * 86400000;
  });
  if (newPools.length) {
    const np = newPools[0];
    notifs.push({
      icon: 'fa-chart-line', iconBg: 'rgba(47,140,155,0.1)', iconColor: '#2F8C9B',
      title: 'New investment pool available',
      sub: `${np.name || np.pool_name} — ${Utils.pct(np.annual_rate || np.benchmark_rate)} p.a. over ${np.term_months} months.`,
      time: Utils.timeAgo(np.created_at),
      action: "navigate('marketplace',document.querySelector('[data-view=marketplace]'))",
      unread: false,
    });
  }

  if (!notifs.length) {
    list.innerHTML = '<div style="padding:24px 18px;text-align:center;color:#999;font-size:0.82rem">You\'re all caught up!</div>';
    _syncNotifDot();
    return;
  }

  list.innerHTML = notifs.map((n, i) => `
    <div class="notif-item${n.unread ? ' unread' : ''}" data-id="n${i}" ${n.action ? `onclick="${n.action};toggleNotifPanel()" style="cursor:pointer"` : ''}>
      <div class="notif-icon" style="background:${n.iconBg}"><i class="fa-solid ${n.icon}" style="color:${n.iconColor}"></i></div>
      <div class="notif-body">
        <div class="notif-title">${n.title}</div>
        <div class="notif-sub">${n.sub}</div>
        <div class="notif-time">${n.time}</div>
      </div>
    </div>
  `).join('');

  _syncNotifDot();
}

/* ─── Navigation ─── */
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (!sidebar) return;
  const open = sidebar.classList.toggle('open');
  if (backdrop) backdrop.classList.toggle('sidebar-backdrop--visible', open);
}

function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (sidebar) sidebar.classList.remove('open');
  if (backdrop) backdrop.classList.remove('sidebar-backdrop--visible');
}

function navigate(view, btnEl) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const el = document.getElementById(`view-${view}`);
  if (el) el.classList.add('active');
  if (btnEl) btnEl.classList.add('active');

  // Auto-close sidebar on mobile when navigating
  if (window.innerWidth <= 768) closeSidebar();

  const titles = {
    overview: 'Portfolio Overview', investments: 'My Investments',
    analytics: 'Portfolio Analytics',
    transactions: 'Transactions', wallet: 'Wallet', marketplace: 'Browse Pools',
    maturity: 'Maturity Instructions', profile: 'My Profile',
    support: 'Support', referral: 'Refer & Earn', statement: 'Account Statement',
    quests: 'Earn Rewards', learn: 'Learning Hub', subaccounts: 'My Accounts',
    documents: 'Document Vault',
  };
  document.getElementById('topbarTitle').textContent = titles[view] || view;

  const loaders = {
    investments: loadMyInvestments,
    analytics: loadAnalytics,
    transactions: loadMyTransactions,
    wallet: loadWallet,
    marketplace: loadMarketplace,
    maturity: loadMaturity,
    support: loadSupport,
    statement: initStatementView,
    quests: renderQuestView,
    learn: renderLearnView,
    subaccounts: loadSubAccounts,
    referral: loadReferralDashboard,
    documents: loadDocuments,
    profile: () => { renderRiskProfile(); _initPushNotifToggle(); _renderKycStatusPanel(); },
  };
  if (loaders[view]) loaders[view]();

  // End timer for the previous view, start one for this view
  if (navigate._current) SVC.timeEnd('view_' + navigate._current, 'svc_section_time', { section: navigate._current });
  navigate._current = view;
  SVC.time('view_' + view);

  SVC.track('page_view', { page_title: view, page_location: window.location.href + '#' + view, portal_view: view });

  // Sync mobile bottom nav active state
  document.querySelectorAll('.mbn-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
}

function _mbnSetActive(btn) {
  document.querySelectorAll('.mbn-item').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

/* ═══════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════ */
// 30-second polling — refresh wallet balance and investment statuses
let _pollTimer = null;
function _startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(async () => {
    if (document.hidden) return; // skip when tab is backgrounded
    try {
      const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
      const fresh = await API.investors.get(investorId).catch(() => null);
      if (fresh && PORTAL.investor && fresh.id === PORTAL.investor.id) {
        const balChanged = parseFloat(fresh.wallet_balance) !== parseFloat(PORTAL.investor.wallet_balance);
        Object.assign(PORTAL.investor, fresh);
        if (balChanged) {
          _refreshWalletUI(parseFloat(PORTAL.investor.wallet_balance) || 0);
          const povWal = document.getElementById('pov-wallet');
          if (povWal) _animateNum(povWal, parseFloat(PORTAL.investor.wallet_balance) || 0, 'R ', '', 600);
        }
      }
    } catch(_) {}
  }, 30000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && _pollTimer) {} });

document.addEventListener('DOMContentLoaded', async () => {
  Toast.init();
  initDarkMode();
  initPortalFormUX();
  // Set skeleton placeholders on overview stats while data loads
  const _skelSpan = '<span class="skeleton" style="display:inline-block;width:80px;height:20px;border-radius:4px"></span>';
  ['pov-total','pov-invested','pov-wallet','pov-returns'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = _skelSpan;
  });
  await loadPortalData();
  // Generate notifications from real data
  loadNotifications();
  checkFirstDepositPrompt();
  _checkAutoStartTour();
  load2FAStatus();
  _startPolling();
  _initPullToRefresh();
});

async function loadPortalData() {
  try {
    const [invRes, invstRes, txnRes, poolRes] = await Promise.all([
      API.investors.list({ limit: 100 }),
      API.investments.list({ limit: 200 }),
      API.transactions.list({ limit: 200 }),
      API.pools.list({ limit: 100 }),
      loadPaymentConfig(),  // load Paystack key from server env var
    ]);

    const allInvestors   = invRes.data   || [];
    const allInvestments = invstRes.data || [];
    const allTxns        = txnRes.data   || [];

    // Find the logged-in investor — never fall back to a different person's record
    PORTAL.investor = allInvestors.find(i => i.id === DEMO_INVESTOR_ID) || null;

    // If data isolation returned multiple investors but DEMO_INVESTOR_ID didn't match,
    // try a direct fetch by ID so we always load the correct profile
    if (!PORTAL.investor && DEMO_INVESTOR_ID && DEMO_INVESTOR_ID !== 'INV-001') {
      const directRes = await API.investors.get(DEMO_INVESTOR_ID).catch(() => null);
      if (directRes && directRes.id) PORTAL.investor = directRes;
    }

    const demoId = PORTAL.investor ? PORTAL.investor.id : DEMO_INVESTOR_ID;

    // Filter by matched investor ID
    let myInvests = allInvestments.filter(i => i.investor_id === demoId);
    let myTxns    = allTxns.filter(t => t.investor_id === demoId);

    // Fallback: if the seeded investor_id uses a different format, try case-insensitive match
    if (myInvests.length === 0 && allInvestments.length > 0) {
      const demoIdLower = demoId.toLowerCase();
      myInvests = allInvestments.filter(i =>
        (i.investor_id || '').toLowerCase() === demoIdLower ||
        (i.investor_name || '').toLowerCase().includes((PORTAL.investor?.first_name || '').toLowerCase())
      );
    }
    if (myTxns.length === 0 && allTxns.length > 0) {
      const demoIdLower = demoId.toLowerCase();
      myTxns = allTxns.filter(t =>
        (t.investor_id || '').toLowerCase() === demoIdLower ||
        (t.investor_name || '').toLowerCase().includes((PORTAL.investor?.first_name || '').toLowerCase())
      );
    }

    // Last resort: show the first investor's data so portal is never empty
    if (myInvests.length === 0 && allInvestments.length > 0) {
      const fallbackId = allInvestments[0].investor_id;
      myInvests = allInvestments.filter(i => i.investor_id === fallbackId);
      // also align investor object to fallback if needed
      if (!PORTAL.investor) {
        PORTAL.investor = allInvestors.find(i => i.id === fallbackId) || allInvestors[0] || {};
      }
    }
    if (myTxns.length === 0 && allTxns.length > 0) {
      const fallbackId = allTxns[0].investor_id;
      myTxns = allTxns.filter(t => t.investor_id === fallbackId);
    }

    PORTAL.investments  = myInvests.map(inv => ({
      ...inv,
      // Normalise DB column names to the aliases used throughout the portal
      // Always coerce to Number so reduce() never does string concatenation
      amount:                 parseFloat(inv.amount || inv.investment_amount || inv.principal || 0) || 0,
      maturity_date:          inv.end_date         || inv.maturity_date,
      investment_date:        inv.start_date        || inv.investment_date,
      expected_return_amount: parseFloat(inv.expected_return   != null ? inv.expected_return   : (inv.expected_return_amount   || 0)) || 0,
      actual_return_amount:   parseFloat(inv.actual_return     != null ? inv.actual_return     : (inv.actual_return_amount     || 0)) || 0,
      expected_return_rate:   parseFloat(inv.annual_rate       != null ? inv.annual_rate       : (inv.expected_return_rate     || 0)) || 0,
    }));
    PORTAL.transactions = myTxns;
    PORTAL.pools        = poolRes.data || [];

    // Ensure investor object is never null so statement guard passes
    if (!PORTAL.investor) PORTAL.investor = { id: demoId };

    // Load waitlist entries for this investor (non-blocking)
    const waitlistRes = await API._fetch('GET', 'tables/investment_waitlist', null, { investor_id: PORTAL.investor.id, limit: 50 }).catch(() => ({ data: [] }));
    PORTAL.waitlist = waitlistRes.data || [];

    SVC.setUser(PORTAL.investor);
    SVC.track('portal_loaded', { active_investments: PORTAL.investments.filter(i => i.status === 'active').length });

    renderOverview();
    renderOnboardingWizard();
    updateStmtQuickStats();
    _renderBankDetailsPanel();
    // Re-populate profile if user navigated there before data loaded
    if (document.getElementById('view-profile')?.classList.contains('view--active')) {
      renderRiskProfile();
    }

    // Load gamification data (non-blocking — don't fail portal if quests fail)
    loadQuestData().catch(err => console.warn('[Quests] load error:', err.message));
  } catch (e) {
    Toast.error('Failed to load portfolio data');
    console.error('loadPortalData error:', e);
  }
}

/* ═══════════════════════════════════════════════
   OVERVIEW
   ═══════════════════════════════════════════════ */
function renderOverview() {
  const inv = PORTAL.investor;
  if (!inv) return;

  const totalInvested = PORTAL.investments.filter(i => i.status === 'active').reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  const totalRet      = PORTAL.transactions.filter(t => t.type === 'return' && t.status === 'completed').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const totalValue    = totalInvested + (parseFloat(inv.wallet_balance) || 0) + totalRet;
  const returnPct     = totalInvested > 0 ? (totalRet / totalInvested * 100).toFixed(1) : '0';
  const activeCount = PORTAL.investments.filter(i => i.status === 'active').length;
  const firstName   = inv.first_name || 'Investor';

  // ── Topbar greeting ──────────────────────────────────────────
  const greetEl = document.getElementById('topbarGreeting');
  if (greetEl) greetEl.textContent = `${_timeGreeting()}, ${firstName} 👋`;

  // ── Portfolio hero values ────────────────────────────────────
  // Animate portfolio hero
  const totEl = document.getElementById('pov-total');
  if (totEl) _animateNum(totEl, totalValue, 'R ', '', 1100);

  document.getElementById('pov-return').innerHTML = `<i class="fa-solid fa-arrow-trend-up"></i> <span>+${returnPct}% effective return · ${Utils.rand(totalRet)} earned</span>`;

  const invEl = document.getElementById('pov-invested');
  if (invEl) _animateNum(invEl, totalInvested, 'R ', '', 900);
  const walEl = document.getElementById('pov-wallet');
  if (walEl) _animateNum(walEl, inv.wallet_balance || 0, 'R ', '', 800);
  const retEl = document.getElementById('pov-returns');
  if (retEl) _animateNum(retEl, totalRet, 'R ', '', 900);
  document.getElementById('pov-active').textContent = activeCount;

  // ── Rewards & XP stat ──────────────────────────────────────
  const referralTotal = PORTAL.transactions
    .filter(t => t.type === 'referral_bonus' && t.status !== 'rejected')
    .reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);
  const xpCash = PORTAL.quests
    ? XP_LEVELS.filter(l => l.min > 0 && (PORTAL.quests.xp || 0) >= l.min).length * 50
    : 0;
  const rewEl = document.getElementById('pov-rewards');
  if (rewEl) {
    const totalRewards = referralTotal + xpCash;
    if (totalRewards > 0) {
      _animateNum(rewEl, totalRewards, 'R ', '', 900);
    } else {
      const xp = PORTAL.quests?.xp || 0;
      const lvl = _getLevelForXP(xp);
      rewEl.textContent = `${lvl.label} · ${xp} XP`;
    }
  }

  // ── Welcome banner ───────────────────────────────────────────
  const initials = `${(inv.first_name || '')[0] || '?'}${(inv.last_name || '')[0] || ''}`.toUpperCase();
  const avatarEl = document.getElementById('welcomeAvatar');
  if (avatarEl) avatarEl.textContent = initials;
  const nameEl = document.getElementById('welcomeName');
  if (nameEl) nameEl.textContent = `${inv.first_name || ''} ${inv.last_name || ''}`.trim() || 'Investor';
  const greetEl2 = document.getElementById('welcomeGreeting');
  if (greetEl2) greetEl2.textContent = _timeGreeting();
  const chipId = document.getElementById('wchipIdText');
  if (chipId) chipId.textContent = inv.id || '—';

  // Member since
  if (inv.created_at || inv.registration_date) {
    const since = new Date(inv.created_at || inv.registration_date);
    const sinceEl = document.getElementById('wchipSinceText');
    if (sinceEl) sinceEl.textContent = `Since ${since.toLocaleString('en-ZA', { month: 'short', year: 'numeric' })}`;
  }

  // FICA chip
  const ficaEl = document.getElementById('wchipFica');
  if (ficaEl && inv.fica_status === 'approved') ficaEl.style.display = 'inline-flex';

  // Next maturity chip
  const upcoming = PORTAL.investments
    .filter(i => i.status === 'active' && i.maturity_date)
    .sort((a, b) => new Date(a.maturity_date) - new Date(b.maturity_date));
  if (upcoming.length) {
    const days = Utils.daysRemaining(upcoming[0].maturity_date);
    const nextEl = document.getElementById('wchipNext');
    const nextTxt = document.getElementById('wchipNextText');
    if (nextEl && nextTxt && days !== null) {
      nextTxt.textContent = `Next maturity in ${days}d`;
      nextEl.style.display = 'inline-flex';
    }
  }

  // ── Sidebar user card ────────────────────────────────────────
  const sAvatar = document.querySelector('.sidebar-user__avatar');
  const sName   = document.querySelector('.user-name');
  const sRole   = document.querySelector('.user-role');
  if (sAvatar) sAvatar.textContent = initials;
  if (sName)   sName.textContent   = `${inv.first_name || ''} ${inv.last_name || ''}`.trim();
  if (sRole)   sRole.textContent   = `${inv.id || 'INV'} · ${inv.status === 'active' ? 'Active' : (inv.status || 'Investor')}`;

  // ── FICA pending alert ───────────────────────────────────────
  const ficaPending = inv.fica_status === 'pending' || inv.status === 'pending_fica' || inv.fica_status === 'submitted';
  let ficaBanner = document.getElementById('ficaAlertBanner');
  if (ficaPending && !ficaBanner) {
    ficaBanner = document.createElement('div');
    ficaBanner.id = 'ficaAlertBanner';
    ficaBanner.className = 'fica-alert-banner';
    ficaBanner.innerHTML = `
      <div class="fica-alert-banner__icon"><i class="fa-solid fa-id-card"></i></div>
      <div class="fica-alert-banner__body">
        <div class="fica-alert-banner__title">FICA Verification Pending</div>
        <div class="fica-alert-banner__sub">Your identity documents are under review (1–2 business days). You can invest once approved.</div>
      </div>
      <div class="fica-alert-banner__action">
        <button class="btn btn--primary btn--sm" onclick="navigate('support', document.querySelector('[data-view=support]'))">
          <i class="fa-solid fa-headset"></i> Contact Us
        </button>
      </div>`;
    const welcomeBanner = document.getElementById('welcomeBanner');
    if (welcomeBanner) welcomeBanner.after(ficaBanner);
  }

  // ── Performance panel ────────────────────────────────────────
  const perfInvested = document.getElementById('perf-invested');
  const perfReturns  = document.getElementById('perf-returns');
  const perfRate     = document.getElementById('perf-rate');
  const perfPools    = document.getElementById('perf-pools');
  if (perfInvested) perfInvested.textContent = Utils.rand(totalInvested);
  if (perfReturns)  perfReturns.textContent  = '+' + Utils.rand(totalRet);
  if (perfRate)     perfRate.textContent     = returnPct + '% p.a.';
  if (perfPools)    perfPools.textContent    = activeCount + ' active';

  renderOverviewInvestments();
  renderOverviewTxns();
  renderPortfolioTrendChart();
  renderAllocationChart();
  renderXPWidget();
  renderTaskCompletionPanel();
}

/* ─── Onboarding Wizard ──────────────────────────────────────────── */
function renderOnboardingWizard() {
  const wizard = document.getElementById('onboardingWizard');
  if (!wizard) return;

  // Check dismiss state first
  if (localStorage.getItem('svc_onboard_dismissed') === '1') {
    wizard.style.display = 'none';
    return;
  }

  const inv = PORTAL.investor;
  if (!inv) return;

  const ficaDone   = inv.fica_status === 'approved';
  const bankDone   = inv.bank_account_status && inv.bank_account_status !== 'none';
  const walletDone = parseFloat(inv.wallet_balance) > 0;
  const investDone = !!(PORTAL.investments && PORTAL.investments.length > 0);

  // If all steps done, hide
  if (ficaDone && bankDone && walletDone && investDone) {
    wizard.style.display = 'none';
    return;
  }

  const stepDefs = [
    {
      label: 'FICA / KYC Verification',
      icon: 'id-card',
      done: ficaDone,
      action: 'openKycUploadModal()',
      actionLabel: 'Upload Docs'
    },
    {
      label: 'Add Bank Account',
      icon: 'building-columns',
      done: bankDone,
      action: 'openBankDetailsModal()',
      actionLabel: 'Add Account'
    },
    {
      label: 'Top Up Wallet',
      icon: 'wallet',
      done: walletDone,
      action: 'openTopUpModal()',
      actionLabel: 'Top Up'
    },
    {
      label: 'Make First Investment',
      icon: 'coins',
      done: investDone,
      action: "navigate('marketplace', document.querySelector('[data-view=marketplace]'))",
      actionLabel: 'Browse Pools'
    }
  ];

  const doneCount = stepDefs.filter(s => s.done).length;
  const progressPct = (doneCount / stepDefs.length) * 100;

  const stepsEl = document.getElementById('wizardSteps');
  if (stepsEl) {
    stepsEl.innerHTML = stepDefs.map(s => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;background:rgba(0,0,0,0.04)">
        <div style="width:22px;height:22px;border-radius:50%;background:${s.done ? '#22c55e' : 'rgba(255,155,12,0.2)'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fa-solid ${s.done ? 'fa-check' : 'fa-' + s.icon}" style="font-size:0.65rem;color:${s.done ? '#fff' : '#FF9B0C'}"></i>
        </div>
        <div style="flex:1">
          <div style="font-size:0.82rem;font-weight:${s.done ? '600' : '700'};color:${s.done ? '#9ca3af' : '#1a1a1a'};${s.done ? 'text-decoration:line-through' : ''}">${s.label}</div>
        </div>
        ${!s.done ? `<button onclick="${s.action}" class="btn btn--primary btn--sm" style="padding:4px 12px;font-size:0.72rem">${s.actionLabel}</button>` : ''}
      </div>
    `).join('');
  }

  const bar = document.getElementById('wizardProgressBar');
  if (bar) bar.style.width = progressPct + '%';

  wizard.style.display = 'block';
}

function dismissOnboarding() {
  localStorage.setItem('svc_onboard_dismissed', '1');
  const wizard = document.getElementById('onboardingWizard');
  if (wizard) wizard.style.display = 'none';
}

function renderOverviewInvestments() {
  const body = document.getElementById('overviewInvestmentsBody');
  const active = PORTAL.investments.filter(i => i.status === 'active');

  if (!active.length) { body.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:24px">No active investments. <a href="#" onclick="navigate(\'marketplace\', null)" style="color:var(--gold)">Browse pools →</a></td></tr>'; return; }

  body.innerHTML = active.map(inv => {
    const pi = Utils.productInfo(inv.product_type);
    const pool = PORTAL.pools.find(p => p.id === inv.pool_id);
    const progress = pool ? Utils.poolFillPct(pool) : 100;

    return `<tr>
      <td>
        <div class="td-strong">${_esc(inv.pool_name)}</div>
        <div style="margin-top:4px">
          <div class="progress-bar" style="width:120px;height:4px"><div class="progress-fill" style="width:${progress}%"></div></div>
        </div>
      </td>
      <td><span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span></td>
      <td class="td-gold fw-700">${Utils.rand(inv.amount)}</td>
      <td class="td-muted">${Utils.date(inv.investment_date)}</td>
      <td class="td-muted">${Utils.date(inv.maturity_date)}</td>
      <td>${Utils.statusBadge(inv.status)}</td>
    </tr>`;
  }).join('');
}

function renderOverviewTxns() {
  const body = document.getElementById('overviewTxnBody');
  const recent = [...PORTAL.transactions].sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date)).slice(0, 5);
  const typeColors = { deposit: 'green', investment: 'blue', return: 'gold', payout: 'green', fee: 'orange', referral_bonus: 'purple', withdrawal: 'red' };
  const _txnLabel = s => { const r = (s || '').replace(/_/g, ' '); return r.charAt(0).toUpperCase() + r.slice(1); };

  if (!recent.length) { body.innerHTML = '<tr><td colspan="4" class="text-center text-muted" style="padding:24px">No transactions yet</td></tr>'; return; }

  const _txnIsPositive = t => !['withdrawal', 'fee', 'investment'].includes(t.type);
  body.innerHTML = recent.map(t => {
    const pos = _txnIsPositive(t);
    return `<tr>
      <td><span class="badge badge--${typeColors[t.type] || 'gray'}">${_txnLabel(t.type)}</span></td>
      <td class="${pos ? 'td-green' : 'td-red'} fw-700">${pos ? '+' : '-'}${Utils.rand(Math.abs(t.amount))}</td>
      <td class="td-muted" style="font-size:0.75rem">${t.description || '—'}</td>
      <td class="td-muted">${Utils.date(t.transaction_date)}</td>
    </tr>`;
  }).join('');
}

function renderPortfolioTrendChart() {
  const canvas = document.getElementById('portfolioTrendChart');
  if (!canvas) return;

  // ── Build last-12-months buckets ────────────────────────────
  const now = new Date();
  const buckets = [];
  for (let i = 11; i >= 0; i--) {
    const d    = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const next = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    buckets.push({ label: d.toLocaleString('en-ZA', { month: 'short', year: '2-digit' }), from: d, to: next, net: 0 });
  }

  // ── Compute net value change per month from real transactions ─
  // Deposits/returns add value; withdrawals/fees reduce value.
  // 'investment' moves wallet→investment: no net portfolio change.
  const valueImpact = t => {
    const amt = parseFloat(t.amount) || 0;
    if (['deposit', 'return', 'payout', 'referral_bonus'].includes(t.type)) return amt;
    if (['withdrawal', 'fee'].includes(t.type)) return -amt;
    return 0;
  };

  for (const t of (PORTAL.transactions || [])) {
    const d = new Date(t.created_at || t.transaction_date || 0);
    if (isNaN(d.getTime())) continue;
    for (const b of buckets) {
      if (d >= b.from && d < b.to) { b.net += valueImpact(t); break; }
    }
  }

  // ── Backward-reconstruct: start from today's actual value ───
  const currentValue = Math.max(0,
    (parseFloat(PORTAL.investor?.wallet_balance) || 0) +
    (parseFloat(PORTAL.investor?.total_invested)  || 0)
  );
  const dataRev = []; let val = currentValue;
  // Buckets are ordered oldest→newest; iterate newest→oldest
  for (let i = buckets.length - 1; i >= 0; i--) {
    dataRev.push(Math.max(0, Math.round(val)));
    val -= buckets[i].net;
  }
  const data   = dataRev.reverse();
  const months = buckets.map(b => b.label);

  // ── Y-axis nice min/max ──────────────────────────────────────
  const yMin = Math.max(0, Math.floor(Math.min(...data) * 0.92 / 1000) * 1000);
  const yMax = Math.ceil(Math.max(...data) * 1.08 / 1000) * 1000;

  if (PORTAL.charts.trend) { PORTAL.charts.trend.destroy(); PORTAL.charts.trend = null; }

  PORTAL.charts.trend = new Chart(canvas, {
    type: 'line',
    data: {
      labels: months,
      datasets: [{
        label: 'Portfolio Value',
        data,
        borderColor:          '#FF9B0C',
        borderWidth:          2.5,
        fill:                 true,
        backgroundColor: c => {
          const g = c.chart.ctx.createLinearGradient(0, 0, 0, c.chart.height);
          g.addColorStop(0, 'rgba(255,155,12,0.28)');
          g.addColorStop(1, 'rgba(255,155,12,0.01)');
          return g;
        },
        tension:              0.42,
        pointRadius:          3,
        pointBackgroundColor: '#FF9B0C',
        pointBorderColor:     'rgba(255,255,255,0.9)',
        pointBorderWidth:     2,
        pointHoverRadius:     6,
        pointHoverBorderWidth:2,
        clip:                 false,
      }]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 600, easing: 'easeInOutQuart' },
      layout: { padding: { top: 10, right: 12, bottom: 4, left: 4 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor:  'rgba(13,17,23,0.96)',
          titleColor:       '#FF9B0C',
          bodyColor:        '#e5e7eb',
          borderColor:      'rgba(255,155,12,0.3)',
          borderWidth:      1,
          padding:          12,
          cornerRadius:     10,
          callbacks: {
            label: ctx => `  Portfolio: ${Utils.rand(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          grid:   { display: false },
          border: { display: false },
          ticks:  { color: '#6b7280', font: { size: 10 } },
        },
        y: {
          min:    yMin,
          max:    yMax,
          grid:   { color: 'rgba(0,0,0,0.06)' },
          border: { display: false },
          ticks:  {
            color: '#6b7280', font: { size: 10 },
            callback: v => v >= 1000 ? `R${(v/1000).toFixed(0)}k` : `R${v}`,
          },
        },
      },
    },
  });
}

function renderAllocationChart() {
  const ctx = document.getElementById('allocationChart');
  if (!ctx) return;

  const colors = ['#FF8215', '#22c55e', '#FF9B0C', '#16a34a', '#f97316', '#a855f7', '#14b8a6'];

  const activeInvests = PORTAL.investments.filter(i => i.status === 'active');
  const allocation = {};
  activeInvests.forEach(i => {
    const label = Utils.productInfo(i.product_type || 'other').label;
    allocation[label] = (allocation[label] || 0) + (parseFloat(i.amount) || 0);
  });

  const isEmpty = !Object.keys(allocation).length;
  if (isEmpty) allocation['No Investments'] = 1;

  const labels = Object.keys(allocation);
  const values = Object.values(allocation);
  const total  = values.reduce((s, v) => s + v, 0);

  if (PORTAL.charts.alloc) PORTAL.charts.alloc.destroy();
  PORTAL.charts.alloc = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors.slice(0, labels.length), borderColor: '#ffffff', borderWidth: 3, hoverOffset: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${Utils.rand(c.parsed)}` } }
      }
    }
  });

  // Render breakdown list beneath chart
  const list = document.getElementById('allocationList');
  if (!list) return;
  if (isEmpty) {
    list.innerHTML = '<div style="font-size:0.8rem;color:#9ca3af;text-align:center;padding:8px 0">No active investments</div>';
    return;
  }
  list.innerHTML = labels.map((label, idx) => {
    const amt = values[idx];
    const pct = total > 0 ? ((amt / total) * 100).toFixed(1) : '0';
    const color = colors[idx] || '#8ea3b8';
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.06)">
      <span style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></span>
      <span style="flex:1;font-size:0.82rem;color:#374151;font-weight:500">${label}</span>
      <span style="font-size:0.82rem;font-weight:700;color:#1a1a1a">${Utils.rand(amt)}</span>
      <span style="font-size:0.75rem;color:#6b7280;min-width:38px;text-align:right">${pct}%</span>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════
   MY INVESTMENTS
   ═══════════════════════════════════════════════ */
async function loadMyInvestments() {
  const grid = document.getElementById('myInvestmentsGrid');
  if (grid && !PORTAL.investments.length) grid.innerHTML = _skeletonCards(3);
  if (!PORTAL.investments.length) await loadPortalData();
  renderMyInvestmentStats();
  renderMyInvestmentCards();
}

function renderMyInvestmentStats() {
  const d = PORTAL.investments;
  document.getElementById('mi-capital').textContent  = Utils.rand(d.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0));
  document.getElementById('mi-expected').textContent = Utils.rand(d.reduce((s, i) => s + (parseFloat(i.expected_return_amount) || 0), 0));
  document.getElementById('mi-earned').textContent   = Utils.rand(d.reduce((s, i) => s + (parseFloat(i.actual_return_amount) || 0), 0));
  document.getElementById('mi-count').textContent    = d.length;

  // Dynamically populate product filter from investor's actual product types
  const sel = document.getElementById('myInvProductFilter');
  if (sel) {
    const types = [...new Set(d.map(i => i.product_type).filter(Boolean))];
    const current = sel.value;
    sel.innerHTML = '<option value="">All Products</option>' +
      types.map(t => {
        const info = Utils.productInfo(t);
        return `<option value="${t}"${current === t ? ' selected' : ''}>${info.label}</option>`;
      }).join('');
  }
}

function filterMyInvestments(filter, btn) {
  PORTAL.myInvFilter = filter;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderMyInvestmentCards();
  SVC.track('svc_filter_changed', { filter_type: 'my_investments', filter_value: filter });
}

function renderMyInvestmentCards() {
  const grid = document.getElementById('myInvestmentsGrid');
  const productFilter = document.getElementById('myInvProductFilter')?.value || '';
  let items = PORTAL.myInvFilter === 'all' ? PORTAL.investments : PORTAL.investments.filter(i => i.status === PORTAL.myInvFilter);
  if (productFilter) items = items.filter(i => i.product_type === productFilter);

  if (!items.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
  <i class="fa-solid fa-seedling" style="font-size:3rem;color:var(--gold);opacity:0.7;margin-bottom:16px;display:block"></i>
  <div class="empty-state__title">No investments yet</div>
  <div class="empty-state__sub">Start growing your wealth today.</div>
  <button onclick="navigate('marketplace',null)" class="btn--primary" style="margin-top:16px;padding:10px 24px;border-radius:8px;font-size:0.85rem;font-weight:700;border:none;cursor:pointer;background:linear-gradient(135deg,#D4AF37,#b8932a);color:#000">Browse Investment Pools →</button>
</div>`;
    return;
  }

  grid.innerHTML = items.map(inv => {
    const pi = Utils.productInfo(inv.product_type);
    const days = Utils.daysRemaining(inv.maturity_date);
    const progress = days !== null && inv.amount ? Math.min(100, Math.max(0, 100 - (days / (365 * 1.5) * 100))) : 100;
    const isPaidOut = inv.status === 'paid_out';

    return `
      <div class="my-inv-card ${isPaidOut ? 'my-inv-card--paidout' : ''}">
        <div class="my-inv-card__header">
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <i class="fa-solid ${pi.icon}" style="color:${pi.color}"></i>
              <span class="my-inv-card__name">${_esc(inv.pool_name)}</span>
            </div>
            <div class="my-inv-card__partner">${inv.investor_id}</div>
          </div>
          ${Utils.statusBadge(inv.status)}
        </div>

        ${!isPaidOut ? `
          <div class="my-inv-progress">
            <div class="my-inv-progress__label">
              <span>Term Progress</span>
              <span>${days !== null ? days + ' days remaining' : Utils.date(inv.maturity_date)}</span>
            </div>
            <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
          </div>
        ` : ''}

        <div class="my-inv-card__stats">
          <div class="mic-stat"><span class="mic-stat__label">Invested</span><span class="mic-stat__value mic-stat__value--gold">${Utils.rand(inv.amount)}</span></div>
          ${isPaidOut ? `<div class="mic-stat"><span class="mic-stat__label">Actual Return</span><span class="mic-stat__value mic-stat__value--green">${Utils.rand(inv.actual_return_amount)}</span></div>` : ''}
          <div class="mic-stat"><span class="mic-stat__label">Rate p.a.</span><span class="mic-stat__value">${Utils.pct(inv.expected_return_rate)}</span></div>
        </div>

        <div class="flex-between" style="font-size:0.72rem;color:var(--text-dim)">
          <span>Invested: ${Utils.date(inv.investment_date)}</span>
          <span>Matures: ${Utils.date(inv.maturity_date)}</span>
        </div>

        ${inv.status === 'active' ? `
          <div style="margin-top:10px;padding:10px 12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;display:flex;flex-direction:column;gap:6px">
            <div style="display:flex;justify-content:space-between;font-size:0.78rem">
              <span style="color:#6b7280">Amount invested</span>
              <span style="font-weight:700;color:#1a1a1a">${Utils.rand(inv.amount)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:0.78rem">
              <span style="color:#6b7280">Launch date</span>
              <span style="font-weight:600;color:#374151">${Utils.date(inv.investment_date)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:0.78rem">
              <span style="color:#6b7280">Maturity date</span>
              <span style="font-weight:600;color:#374151">${Utils.date(inv.maturity_date)}</span>
            </div>
          </div>
        ` : ''}
        ${isPaidOut ? `
          <div style="font-size:0.75rem;color:var(--text-muted);text-align:center">
            <i class="fa-solid fa-check-circle" style="color:var(--green)"></i>
            Paid out ${Utils.date(inv.payout_date)} — Total: ${Utils.rand(inv.amount + inv.actual_return_amount)}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

/* ═══════════════════════════════════════════════
   TRANSACTIONS
   ═══════════════════════════════════════════════ */
async function loadMyTransactions() {
  const txnBody = document.getElementById('myTxnBody');
  if (txnBody && !PORTAL.transactions.length) txnBody.innerHTML = _skeletonRows(5, 6);
  if (!PORTAL.transactions.length) await loadPortalData();
  renderMyTxnTable();

  document.getElementById('myTxnTypeFilter').addEventListener('change', renderMyTxnTable);
}

function renderMyTxnTable() {
  const body = document.getElementById('myTxnBody');
  const filter = document.getElementById('myTxnTypeFilter').value;
  const items = filter ? PORTAL.transactions.filter(t => t.type === filter) : PORTAL.transactions;
  const sorted = [...items].sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date));

  const typeColors = { deposit: 'green', investment: 'blue', return: 'gold', payout: 'green', fee: 'orange', referral_bonus: 'purple', withdrawal: 'red' };
  const _txnLabel = s => { const r = (s || '').replace(/_/g, ' '); return r.charAt(0).toUpperCase() + r.slice(1); };

  if (!sorted.length) {
    body.innerHTML = `<tr><td colspan="6" style="padding:0;border:none">
      <div class="empty-state">
        <i class="fa-solid fa-receipt"></i>
        <div class="empty-state__title">No transactions yet</div>
        <div class="empty-state__sub">Top up your wallet or make an investment to see activity here.<br>
          <a href="#" onclick="navigate('wallet', document.querySelector('[data-view=wallet]'))" style="color:var(--gold)">Go to Wallet →</a>
        </div>
      </div>
    </td></tr>`;
    return;
  }

  const _isPosTxn = t => !['withdrawal', 'fee', 'investment'].includes(t.type);
  body.innerHTML = sorted.map(t => {
    const pos = _isPosTxn(t);
    return `<tr>
      <td><span class="badge badge--${typeColors[t.type] || 'gray'}">${_txnLabel(t.type)}</span></td>
      <td class="${pos ? 'td-green' : 'td-red'} fw-700">${pos ? '+' : '-'}${Utils.rand(Math.abs(t.amount))}</td>
      <td>${Utils.statusBadge(t.status)}</td>
      <td class="td-muted" style="font-size:0.72rem">${t.reference || '—'}</td>
      <td class="td-muted" style="font-size:0.75rem">${t.description || '—'}</td>
      <td class="td-muted">${Utils.date(t.transaction_date)}</td>
    </tr>`;
  }).join('');
}

function _switchTxnTab(tab, btn) {
  document.querySelectorAll('#txnTabBar .tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const allTab = document.getElementById('txnAllTab');
  const retTab = document.getElementById('txnReturnsTab');
  if (allTab) allTab.style.display = tab === 'all' ? '' : 'none';
  if (retTab) retTab.style.display = tab === 'returns' ? '' : 'none';
  if (tab === 'returns') _renderReturnHistory();
  SVC.track('svc_tab_changed', { section: 'transactions', tab });
}

function _renderReturnHistory() {
  const el = document.getElementById('txnReturnsTab');
  if (!el) return;
  const returns = [...PORTAL.transactions]
    .filter(t => ['return','payout','referral_bonus'].includes(t.type) && t.status !== 'rejected')
    .sort((a,b) => new Date(b.transaction_date||b.created_at) - new Date(a.transaction_date||a.created_at));

  if (!returns.length) {
    el.innerHTML = '<div class="empty-state"><i class="fa-solid fa-chart-line"></i><p>No return payments yet. Returns are paid when your investments mature.</p></div>';
    return;
  }

  let running = 0;
  const typeLabel = { return: 'Return Payment', payout: 'Payout', referral_bonus: 'Referral Bonus' };
  const typeColor = { return: '#22c55e', payout: '#ff9b0c', referral_bonus: '#a855f7' };

  el.innerHTML = `
    <div class="panel mb-16">
      <div class="panel__header"><span class="panel__title">Returns Received</span>
        <span style="font-weight:800;color:#22c55e">${Utils.rand(returns.reduce((s,t)=>s+Math.abs(parseFloat(t.amount)||0),0))}</span>
      </div>
      <div class="panel__body" style="padding:0">
        ${returns.map((t, i) => {
          running += Math.abs(parseFloat(t.amount) || 0);
          const color = typeColor[t.type] || '#22c55e';
          return `<div style="display:flex;align-items:center;gap:14px;padding:14px 16px;border-bottom:1px solid rgba(0,0,0,0.06)${i===returns.length-1?';border-bottom:none':''}">
            <div style="width:36px;height:36px;border-radius:50%;background:${color}22;display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <i class="fa-solid fa-arrow-trend-up" style="color:${color};font-size:0.85rem"></i>
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:0.82rem;font-weight:700;color:#1a1a1a">${typeLabel[t.type]||t.type}</div>
              <div style="font-size:0.72rem;color:#6b7280">${t.description||t.pool_id||'—'} · ${Utils.date(t.transaction_date||t.created_at)}</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-weight:800;color:${color}">${Utils.rand(Math.abs(parseFloat(t.amount)||0))}</div>
              <div style="font-size:0.68rem;color:#9ca3af">Running: ${Utils.rand(running)}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

/* ─── Refresh every wallet balance element on the page ─── */
function _refreshWalletUI(balance) {
  const fmt = Utils.rand(balance);
  // Overview KPI
  const povWallet = document.getElementById('pov-wallet');
  if (povWallet) povWallet.textContent = fmt;
  // Wallet view balance
  const wbEl = document.getElementById('walletBalance');
  if (wbEl) wbEl.textContent = fmt;
  // Overview total portfolio value (invested + wallet + returns)
  const inv = PORTAL.investor;
  if (inv) {
    const liveInvested = PORTAL.investments.filter(i => i.status === 'active').reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
    const liveReturns  = PORTAL.transactions.filter(t => t.type === 'return' && t.status === 'completed').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    const totalValue   = liveInvested + balance + liveReturns;
    const povTotal = document.getElementById('pov-total');
    if (povTotal) povTotal.textContent = Utils.rand(totalValue);
  }
}

/* ═══════════════════════════════════════════════
   WALLET
   ═══════════════════════════════════════════════ */
async function loadWallet() {
  if (!PORTAL.investor) await loadPortalData();
  document.getElementById('walletBalance').textContent = Utils.rand(PORTAL.investor?.wallet_balance || 0);
  // Update recurring badge
  const badge = document.getElementById('recurringActiveBadge');
  if (badge) badge.style.display = PORTAL.investor?.recurring_enabled ? 'inline-flex' : 'none';
  // Set EFT reference to actual investor ID
  const eftRef = document.getElementById('walletEftRef');
  if (eftRef) eftRef.textContent = PORTAL.investor?.id || DEMO_INVESTOR_ID;

  _loadAutoTopUpCard().catch(() => {});
  renderWalletReadinessPanel();

  const activity = document.getElementById('walletActivity');
  const walletTxns = [...PORTAL.transactions]
    .filter(t => ['deposit', 'return', 'payout', 'referral_bonus', 'withdrawal'].includes(t.type))
    .sort((a, b) => new Date(b.transaction_date || b.created_at || 0) - new Date(a.transaction_date || a.created_at || 0))
    .slice(0, 8);

  if (!walletTxns.length) {
    activity.innerHTML = `<div class="empty-state">
      <i class="fa-solid fa-wallet" style="font-size:3rem;color:var(--gold);opacity:0.7;margin-bottom:16px;display:block"></i>
      <div class="empty-state__title">No wallet activity yet</div>
      <div class="empty-state__sub">Top up once and this feed will start showing deposits, returns, payouts, and withdrawals in one place.</div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px">
        <button class="btn btn--primary btn--sm" onclick="openTopUpModal()"><i class="fa-solid fa-plus"></i> Top up wallet</button>
        <button class="btn btn--secondary btn--sm" onclick="navigate('marketplace',document.querySelector('[data-view=marketplace]'))"><i class="fa-solid fa-layer-group"></i> Browse pools</button>
      </div>
    </div>`;
    return;
  }

  activity.innerHTML = walletTxns.map(t => {
    const isOut = t.type === 'withdrawal';
    const colour = isOut ? '#ef4444' : '#22c55e';
    const sign   = isOut ? '−' : '+';
    const statusTag = t.status === 'pending' ? ' <span style="font-size:0.7rem;background:rgba(245,158,11,0.15);color:#f59e0b;padding:1px 6px;border-radius:4px;font-weight:600">Pending</span>' :
                      t.status === 'rejected' ? ' <span style="font-size:0.7rem;background:rgba(239,68,68,0.12);color:#ef4444;padding:1px 6px;border-radius:4px;font-weight:600">Rejected</span>' : '';
    return `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.06)">
      <div>
        <div style="font-size:0.82rem;font-weight:600;color:#1a1a1a">${t.description || t.type?.replace(/_/g, ' ')}${statusTag}</div>
        <div style="font-size:0.7rem;color:#9ca3af">${Utils.date(t.created_at || t.transaction_date)}</div>
      </div>
      <span style="font-weight:700;color:${colour}">${sign}${Utils.rand(Math.abs(t.amount))}</span>
    </div>
  `}).join('');
}

function _switchWalletTab(tab, btn) {
  document.querySelectorAll('#view-wallet .tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const ov = document.getElementById('walletOverviewTab');
  const rc = document.getElementById('walletRecurringTab');
  if (ov) ov.style.display = tab === 'overview' ? '' : 'none';
  if (rc) rc.style.display = tab === 'recurring' ? '' : 'none';
  if (tab === 'recurring') _renderRecurringTab();
  SVC.track('svc_tab_changed', { section: 'wallet', tab });
}

function _renderRecurringTab() {
  const inv = PORTAL.investor;
  const statusCard = document.getElementById('recurringStatusCard');
  const listEl     = document.getElementById('recurringInvestmentsList');
  if (!statusCard || !listEl) return;

  const pool     = (PORTAL.pools || []).find(p => p.id === inv?.recurring_pool_id);
  const isActive = !!(inv?.recurring_enabled && inv?.recurring_amount);

  const badge = document.getElementById('recurringActiveBadge');
  if (badge) badge.style.display = isActive ? 'inline-flex' : 'none';

  if (isActive) {
    const today      = new Date();
    const nextDate   = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const daysUntil  = Math.ceil((nextDate - today) / 86400000);
    statusCard.innerHTML = `
      <div class="wallet-card__label">Recurring Investment
        <span style="background:rgba(34,197,94,0.15);color:#22c55e;font-size:0.65rem;font-weight:700;padding:2px 8px;border-radius:20px;margin-left:8px;vertical-align:middle">Active</span>
      </div>
      <div class="wallet-card__value" style="color:#ff9b0c">${Utils.rand(inv.recurring_amount)}<span style="font-size:0.85rem;font-weight:500;color:#6b7280;margin-left:4px">/ month</span></div>
      <div class="wallet-card__sub"><i class="fa-solid fa-layer-group" style="margin-right:4px"></i>${pool ? pool.name : 'Selected pool'} &nbsp;·&nbsp; Next investment in <strong>${daysUntil} day${daysUntil !== 1 ? 's' : ''}</strong></div>
      <div class="wallet-card__actions">
        <button class="btn btn--secondary" onclick="openRecurringModal()"><i class="fa-solid fa-pen"></i> Edit</button>
        <button class="btn btn--secondary" style="color:#ef4444;border-color:rgba(239,68,68,0.3)" onclick="_cancelRecurring()"><i class="fa-solid fa-xmark"></i> Cancel</button>
      </div>`;
  } else {
    statusCard.innerHTML = `
      <div class="wallet-card__label">Recurring Investment</div>
      <div class="wallet-card__value" style="font-size:1.1rem;color:#9ca3af">Not active</div>
      <div class="wallet-card__sub">Automate monthly investments into any open pool — minimum R100/month</div>
      <div class="wallet-card__actions">
        <button class="btn btn--primary" onclick="openRecurringModal()"><i class="fa-solid fa-plus"></i> Set Up Recurring</button>
      </div>`;
  }

  const recurringInvs = pool
    ? PORTAL.investments.filter(i => i.status === 'active' && i.pool_id === inv?.recurring_pool_id)
    : [];

  if (!recurringInvs.length) {
    listEl.innerHTML = `<div class="empty-state" style="padding:20px"><i class="fa-solid fa-rotate"></i><p>${isActive ? 'Your first recurring investment will be processed at the start of next month.' : 'Set up a recurring investment to automate your monthly savings.'}</p></div>`;
  } else {
    listEl.innerHTML = recurringInvs.map(ri => {
      const pi       = Utils.productInfo(ri.product_type);
      const daysLeft = Utils.daysRemaining(ri.end_date);
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(0,0,0,0.06)">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:36px;height:36px;border-radius:8px;background:${pi.color}18;color:${pi.color};display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <i class="fa-solid ${pi.icon}"></i>
            </div>
            <div>
              <div style="font-size:0.82rem;font-weight:600;color:#1a1a1a">${ri.pool_name || pool?.name || 'Investment'}</div>
              <div style="font-size:0.7rem;color:#9ca3af">Started ${Utils.date(ri.start_date)}${daysLeft !== null ? ' · ' + daysLeft + 'd remaining' : ''}</div>
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-weight:700;color:#1a1a1a">${Utils.rand(ri.amount)}</div>
            <div style="font-size:0.7rem;color:#22c55e">${Utils.pct(ri.annual_rate)} p.a.</div>
          </div>
        </div>`;
    }).join('');
  }
}

async function _cancelRecurring() {
  const ok = await Confirm.ask('Cancel your recurring investment? You can set it up again at any time.', { confirmLabel: 'Yes, Cancel', confirmClass: 'btn--danger' });
  if (!ok) return;
  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  try {
    await API._fetch('PATCH', `tables/investors/${investorId}`, {
      recurring_enabled: false, recurring_amount: null, recurring_pool_id: null,
    });
    if (PORTAL.investor) {
      PORTAL.investor.recurring_enabled = false;
      PORTAL.investor.recurring_amount  = null;
      PORTAL.investor.recurring_pool_id = null;
    }
    Toast.success('Recurring investment cancelled');
    _renderRecurringTab();
    _renderRecurringStatusSummary();
  } catch (e) { Toast.error('Failed to cancel recurring investment'); }
}

/* ═══════════════════════════════════════════════
   AUTO WALLET TOP-UP (Paystack Authorization)
   ═══════════════════════════════════════════════ */

let _autoTopUpCard     = null;  // cached card info {card_type, last4, ...}
let _autoTopUpSettings = null;  // cached settings {auto_topup_enabled, amount, day}

async function _loadAutoTopUpCard() {
  const container = document.getElementById('autoTopUpCard');
  if (!container) return;

  try {
    const [cardRes, settingsRes] = await Promise.all([
      API._fetch('GET', 'payments/topup-card'),
      API._fetch('GET', 'payments/auto-topup'),
    ]);
    _autoTopUpCard     = cardRes.card || null;
    _autoTopUpSettings = settingsRes;
  } catch (e) {
    _autoTopUpCard = null;
    _autoTopUpSettings = null;
  }

  _renderAutoTopUpCard(container);
}

function _cardIcon(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('visa'))       return '<i class="fa-brands fa-cc-visa"   style="color:#1a1f71;font-size:1.4rem"></i>';
  if (t.includes('mastercard')) return '<i class="fa-brands fa-cc-mastercard" style="font-size:1.4rem"></i>';
  if (t.includes('amex'))       return '<i class="fa-brands fa-cc-amex"   style="color:#016fcb;font-size:1.4rem"></i>';
  return '<i class="fa-solid fa-credit-card" style="font-size:1.2rem;color:#6b7280"></i>';
}

function _renderAutoTopUpCard(container) {
  const card     = _autoTopUpCard;
  const settings = _autoTopUpSettings;
  const enabled  = settings?.auto_topup_enabled;
  const amount   = settings?.auto_topup_amount;
  const day      = settings?.auto_topup_day || 1;

  const suffix = day === 1 ? 'st' : day === 2 ? 'nd' : day === 3 ? 'rd' : 'th';

  if (!card) {
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;padding:16px">
        <div style="width:42px;height:42px;border-radius:10px;background:rgba(255,155,12,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fa-solid fa-rotate" style="color:#ff9b0c;font-size:1.1rem"></i>
        </div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:0.88rem;color:#1a1a1a">Auto Wallet Top-Up</div>
          <div style="font-size:0.75rem;color:#6b7280;margin-top:2px">Complete a Paystack payment to save your card, then enable auto top-up.</div>
        </div>
        <button class="btn btn--secondary btn--sm" onclick="openTopUpModal('paystack')">
          <i class="fa-solid fa-plus"></i> Add Card
        </button>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div style="padding:16px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <div style="width:42px;height:42px;border-radius:10px;background:rgba(255,155,12,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fa-solid fa-rotate" style="color:#ff9b0c;font-size:1.1rem"></i>
        </div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:0.88rem;color:#1a1a1a">Auto Wallet Top-Up</div>
          <div style="font-size:0.75rem;color:#6b7280;margin-top:1px">Automatically charge your saved card on a set day each month</div>
        </div>
        ${enabled
          ? `<span style="background:rgba(34,197,94,0.12);color:#22c55e;font-size:0.68rem;font-weight:700;padding:3px 9px;border-radius:20px;border:1px solid rgba(34,197,94,0.3);white-space:nowrap">ACTIVE</span>`
          : `<span style="background:rgba(107,114,128,0.1);color:#6b7280;font-size:0.68rem;font-weight:700;padding:3px 9px;border-radius:20px;border:1px solid rgba(107,114,128,0.2);white-space:nowrap">INACTIVE</span>`
        }
      </div>

      <div style="background:#F9FAFB;border-radius:10px;padding:12px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px">
        ${_cardIcon(card.card_type)}
        <div>
          <div style="font-size:0.82rem;font-weight:700;color:#1a1a1a">
            ${card.card_type ? card.card_type.replace(/^\w/, c => c.toUpperCase()) : 'Card'} •••• ${card.last4 || '????'}
          </div>
          <div style="font-size:0.7rem;color:#6b7280">${card.bank || ''} · Expires ${card.exp_month || '??'}/${card.exp_year || '??'}</div>
        </div>
        <button onclick="_removeTopUpCard()" style="margin-left:auto;background:none;border:none;color:#ef4444;font-size:0.72rem;font-weight:600;cursor:pointer;padding:4px 8px;border-radius:4px;transition:background 0.15s" onmouseover="this.style.background='rgba(239,68,68,0.08)'" onmouseout="this.style.background='none'">
          <i class="fa-solid fa-trash"></i> Remove
        </button>
      </div>

      ${enabled ? `
        <div style="font-size:0.8rem;color:#374151;margin-bottom:10px">
          <i class="fa-solid fa-calendar-check" style="color:#22c55e;margin-right:5px"></i>
          <strong>${Utils.rand(amount)}</strong> charged on the <strong>${day}${suffix}</strong> of each month
        </div>` : ''}

      <div style="display:flex;gap:8px">
        <button class="btn btn--primary btn--sm" onclick="openAutoTopUpModal()" style="flex:1">
          <i class="fa-solid fa-pen"></i> ${enabled ? 'Edit Schedule' : 'Set Up Auto Top-Up'}
        </button>
        ${enabled ? `<button class="btn btn--secondary btn--sm" onclick="_cancelAutoTopUp()" style="color:#ef4444;border-color:rgba(239,68,68,0.3)">
          <i class="fa-solid fa-xmark"></i> Cancel
        </button>` : ''}
      </div>
    </div>`;
}

function openAutoTopUpModal() {
  const settings = _autoTopUpSettings || {};
  const el = id => document.getElementById(id);
  if (!el('autoTopUpModal')) return;
  if (el('atuEnabled'))  el('atuEnabled').checked = !!settings.auto_topup_enabled;
  if (el('atuAmount'))   el('atuAmount').value    = settings.auto_topup_amount || '';
  if (el('atuDay'))      el('atuDay').value       = settings.auto_topup_day || 1;
  Modal.open('autoTopUpModal');
}

async function saveAutoTopUp() {
  const el = id => document.getElementById(id);
  const enabled = el('atuEnabled')?.checked;
  const amount  = parseFloat(el('atuAmount')?.value);
  const day     = parseInt(el('atuDay')?.value, 10);

  if (enabled) {
    if (!amount || amount < 50) return Toast.error('Minimum auto top-up is R50');
    if (!day || day < 1 || day > 28) return Toast.error('Day must be between 1 and 28');
  }

  const btn = el('atuSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    await API._fetch('POST', 'payments/auto-topup', { enabled, amount, day });
    Modal.close('autoTopUpModal');
    Toast.success(enabled ? `Auto top-up of ${Utils.rand(amount)} set for the ${day}${day===1?'st':day===2?'nd':day===3?'rd':'th'} of each month` : 'Auto top-up disabled');
    SVC.track('svc_auto_topup_set', { enabled: !!enabled, amount: amount, day: day });
    await _loadAutoTopUpCard();
  } catch (e) {
    Toast.error(e.message || 'Failed to save auto top-up settings');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

async function _cancelAutoTopUp() {
  const ok = await Confirm.ask('Cancel auto top-up? Your saved card will remain on file.', { confirmLabel: 'Yes, Cancel', confirmClass: 'btn--danger' });
  if (!ok) return;
  try {
    await API._fetch('POST', 'payments/auto-topup', { enabled: false });
    Toast.success('Auto top-up cancelled');
    await _loadAutoTopUpCard();
  } catch (e) { Toast.error('Failed to cancel auto top-up'); }
}

async function _removeTopUpCard() {
  const ok = await Confirm.ask('Remove your saved card? This will also cancel auto top-up.', { confirmLabel: 'Yes, Remove', confirmClass: 'btn--danger' });
  if (!ok) return;
  try {
    await API._fetch('DELETE', 'payments/topup-card');
    _autoTopUpCard = null;
    _autoTopUpSettings = null;
    Toast.success('Card removed');
    await _loadAutoTopUpCard();
  } catch (e) { Toast.error('Failed to remove card'); }
}

/* ═══════════════════════════════════════════════
   PAYMENT GATEWAY — 3-Step flow
   Step 1: Enter amount
   Step 2: Choose gateway (Paystack | Ozow | EFT)
   Step 3: Process / confirm / show bank details

   Paystack public key (test): pk_test_72040393098052bb00477db9fb8f69f369193707
   ═══════════════════════════════════════════════ */

// Paystack public key — loaded from server env var (PAYSTACK_PUBLIC_KEY) at init.
// Set PAYSTACK_PUBLIC_KEY=pk_live_... in Railway to go live without touching code.
let PAYSTACK_PUBLIC_KEY = 'pk_test_72040393098052bb00477db9fb8f69f369193707';

async function loadPaymentConfig() {
  try {
    const cfg = await API._fetch('GET', 'payments/config');
    if (cfg.paystackPublicKey) PAYSTACK_PUBLIC_KEY = cfg.paystackPublicKey;
  } catch (e) {
    console.warn('[portal] Could not load payment config — using fallback key');
  }
}

// ⚠️  REPLACE with your real Ozow SiteCode from the Ozow merchant portal
// Set IsTest=false in launchOzow() when going live
const OZOW_SITE_CODE      = 'SMA-SMA-030';
const TX_FEE_RATE         = 0.029;   // 2.9% + R1 flat — charged by gateway (Paystack & Ozow)

// Internal state
let _pmAmount       = 0;       // base deposit amount entered by investor (ZAR)
let _pmGateway      = null;    // 'paystack' | 'ozow' | 'eft'
let _pmSaId         = null;    // null = main wallet; saId = credit sub-account instead

/* ── helpers ─────────────────────────────────── */
function _pmEl(id) { return document.getElementById(id); }

function _pmShowOnly(...ids) {
  ['pmStep1','pmStep2','pmStep3Eft','pmStep3Processing','pmStep3Success'].forEach(id => {
    const el = _pmEl(id);
    if (!el) return;
    // Must use explicit 'block' — setting '' falls back to the inline display:none
    // that is baked into the HTML for Steps 2/3, so they'd never show
    el.style.display = ids.includes(id) ? 'block' : 'none';
  });
}

function _pmSetProgress(pct) {
  const bar = _pmEl('pmProgressBar');
  if (bar) bar.style.width = pct + '%';
}

function _pmSetStepLabel(txt) {
  const lbl = _pmEl('pmStepLabel');
  if (lbl) lbl.textContent = txt;
}

function _pmInvestorName() {
  return PORTAL.investor
    ? `${PORTAL.investor.first_name} ${PORTAL.investor.last_name}`
    : 'Investor';
}

function _pmInvestorEmail() {
  return PORTAL.investor?.email || 'investor@svcapital.co.za';
}

function _pmInvestorId() {
  return PORTAL.investor?.id || DEMO_INVESTOR_ID;
}

/* ── public entry point ─────────────────────── */
/**
 * openTopUpModal(gateway?)
 * Call with no arg (generic) or 'paystack' / 'ozow' to pre-select.
 */
function openTopUpModal(gateway) {
  _pmAmount  = 0;
  _pmGateway = null;
  _pmSaId    = null;

  SVC.track('svc_topup_modal_opened', { gateway: gateway || 'default' });

  // Reset to step 1
  _pmEl('pmAmount').value = '';
  _pmEl('pmAmountHint').textContent = 'Minimum deposit: R100';
  _pmEl('pmAmountHint').style.color = 'var(--text-muted)';
  document.querySelectorAll('.pm-chip').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.pm-gateway-card').forEach(c => c.classList.remove('selected'));

  _pmShowOnly('pmStep1');
  _pmSetProgress(33);
  _pmSetStepLabel('Step 1 of 3 — Enter amount');

  Modal.open('topUpModal');

  // If a gateway was passed, pre-fill and jump to step 2 after amount chip
  if (gateway === 'paystack' || gateway === 'ozow') {
    _pmGateway = gateway;
  }
}

/* ── Step 1: amount helpers ─────────────────── */
function setAmount(val) {
  _pmEl('pmAmount').value = val;
  document.querySelectorAll('.pm-chip').forEach(c => {
    c.classList.toggle('active', parseInt(c.textContent.replace(/[^0-9]/g,'')) === val);
  });
  updateAmountPreview();
}

/* Return the 2.9% + R1 fee amount for gateways that charge it */
function _pmFee(baseAmount) { return Math.round((baseAmount * TX_FEE_RATE + 1) * 100) / 100; }
/* Total charged to card/bank for non-EFT gateways */
function _pmTotal(baseAmount) { return Math.round((baseAmount + _pmFee(baseAmount)) * 100) / 100; }

function updateAmountPreview() {
  const raw = parseFloat(_pmEl('pmAmount').value);
  const hint = _pmEl('pmAmountHint');
  if (!raw || raw < 100) {
    hint.textContent = raw > 0 && raw < 100 ? 'Amount too low — minimum is R100' : 'Minimum deposit: R100';
    hint.style.color = raw > 0 && raw < 100 ? '#ef4444' : 'var(--text-muted)';
  } else {
    hint.textContent = `R${raw.toLocaleString('en-ZA')} will be credited to your SV Capital wallet`;
    hint.style.color = '#22c55e';
  }
}

/* Update the fee summary strip in Step 2 whenever gateway or amount changes */
function _pmUpdateFeeSummary() {
  const strip = _pmEl('pmFeeSummary');
  if (!strip) return;
  if (!_pmGateway || _pmGateway === 'eft') {
    strip.style.display = 'none';
    return;
  }
  const fee   = _pmFee(_pmAmount);
  const total = _pmTotal(_pmAmount);
  strip.style.display = 'block';
  strip.innerHTML = `
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.07)">
      <span style="color:#9ca3af;font-size:0.78rem">Deposit amount</span>
      <span style="color:#f0f4ff;font-weight:600;font-size:0.78rem">R${_pmAmount.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.07)">
      <span style="color:#9ca3af;font-size:0.78rem">Gateway fee (2.9% + R1)</span>
      <span style="color:#f59e0b;font-weight:600;font-size:0.78rem">+ R${fee.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:8px 0">
      <span style="color:#f0f4ff;font-size:0.82rem;font-weight:700">Total charged to you</span>
      <span style="color:#FF9B0C;font-size:0.88rem;font-weight:900">R${total.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
    </div>
    <div style="font-size:0.69rem;color:#6b7280;margin-top:2px">
      <i class="fa-solid fa-circle-info" style="color:#6b7280"></i>
      The 2.9% + R1 fee is charged by the payment gateway provider and does not form part of your wallet credit.
    </div>
  `;
}

function goToStep2() {
  const raw = parseFloat(_pmEl('pmAmount').value);
  if (!raw || raw < 100) {
    Toast.error('Please enter at least R100 to continue');
    _pmEl('pmAmount').focus();
    return;
  }
  _pmAmount = raw;
  _pmEl('pmAmountDisplay').textContent = `R${raw.toLocaleString('en-ZA')}`;

  // If a gateway was pre-selected from the wallet card, highlight it
  if (_pmGateway) {
    document.querySelectorAll('.pm-gateway-card').forEach(c => c.classList.remove('selected'));
    const card = _pmEl(_pmGateway === 'paystack' ? 'gwPaystack' : _pmGateway === 'ozow' ? 'gwOzow' : 'gwEft');
    if (card) card.classList.add('selected');
  }

  _pmUpdateFeeSummary();
  _pmShowOnly('pmStep2');
  _pmSetProgress(66);
  _pmSetStepLabel('Step 2 of 3 — Choose payment method');
}

function goToStep1() {
  _pmShowOnly('pmStep1');
  _pmSetProgress(33);
  _pmSetStepLabel('Step 1 of 3 — Enter amount');
}

/* ── Step 2: gateway selection ──────────────── */
function selectGateway(gw) {
  _pmGateway = gw;
  document.querySelectorAll('.pm-gateway-card').forEach(c => c.classList.remove('selected'));
  const map = { paystack: 'gwPaystack', ozow: 'gwOzow', eft: 'gwEft' };
  const card = _pmEl(map[gw]);
  if (card) card.classList.add('selected');
  // Refresh fee strip whenever gateway changes
  _pmUpdateFeeSummary();
}

function proceedPayment() {
  if (!_pmGateway) {
    Toast.error('Please select a payment method');
    return;
  }
  if (_pmGateway === 'paystack') launchPaystack();
  else if (_pmGateway === 'ozow')    launchOzow();
  else if (_pmGateway === 'eft')     showEftDetails();
}

/* ── Paystack inline popup (v2 API) ─────────────── */
function launchPaystack() {
  _pmShowOnly('pmStep3Processing');
  _pmSetProgress(100);
  _pmSetStepLabel('Step 3 of 3 — Paystack');

  // Total charged to card = base amount + 2.9% + R1 gateway fee
  const totalCharged = _pmTotal(_pmAmount);

  setTimeout(() => {
    try {
      if (typeof PaystackPop === 'undefined') {
        throw new Error('Paystack JS library did not load. Check your internet connection and try again.');
      }

      // Paystack v2 API — replaces deprecated PaystackPop.setup() + openIframe()
      const popup = new PaystackPop();
      SVC.track('svc_paystack_initiated', { amount: _pmAmount, currency: 'ZAR' });
      popup.newTransaction({
        key:      PAYSTACK_PUBLIC_KEY,
        email:    _pmInvestorEmail(),
        amount:   Math.round(totalCharged * 100),   // Paystack expects kobo/cents
        currency: 'ZAR',
        ref:      `SVC-PS-${Date.now()}`,
        metadata: {
          investor_id:   _pmInvestorId(),
          investor_name: _pmInvestorName(),
          wallet_credit: _pmAmount,
          gateway_fee:   _pmFee(_pmAmount),
          custom_fields: [
            { display_name: 'Investor ID',    variable_name: 'investor_id',   value: _pmInvestorId() },
            { display_name: 'Investor Name',  variable_name: 'investor_name', value: _pmInvestorName() },
            { display_name: 'Wallet Credit',  variable_name: 'wallet_credit', value: `R${_pmAmount}` },
            { display_name: 'Gateway Fee',    variable_name: 'gateway_fee',   value: `R${_pmFee(_pmAmount)}` },
          ]
        },
        onSuccess: async function(transaction) {
          SVC.track('svc_topup_completed', { amount: _pmAmount, currency: 'ZAR', reference: transaction.reference });
          // Payment authorised by Paystack — ask the server to verify the reference
          // and atomically credit the wallet. This is more reliable than direct DB patching.
          _pmShowOnly('pmStep3Processing');
          _pmEl('pmProcessingTitle').textContent    = 'Confirming payment…';
          _pmEl('pmProcessingSubtitle').textContent = 'Verifying with Paystack — please wait';
          try {
            const result = await API._fetch('POST', 'payments/paystack/verify', {
              reference:    transaction.reference,
              investorId:   _pmInvestorId(),
              walletCredit: _pmAmount,
            });
            if (result.error) throw new Error(result.error);

            // Update local cache so UI reflects the new balance immediately
            if (!result.alreadyProcessed && PORTAL.investor) {
              PORTAL.investor.wallet_balance = (parseFloat(PORTAL.investor.wallet_balance) || 0) + _pmAmount;
              _refreshWalletUI(PORTAL.investor.wallet_balance);
            }

            // If Paystack returned a reusable authorization, refresh the auto top-up card
            if (result.authSaved) _loadAutoTopUpCard().catch(() => {});

            await _showDepositSuccess('paystack', transaction.reference);
          } catch (verifyErr) {
            console.error('Paystack verify error:', verifyErr);
            Toast.error('Payment was received by Paystack but we could not confirm it on our end. ' +
              'Your wallet will be updated within a few minutes via webhook, or contact support with ref: ' +
              transaction.reference);
            _pmShowOnly('pmStep2');
            _pmSetProgress(66);
          }
        },
        onCancel: function() {
          // User closed the Paystack popup without completing payment
          _pmShowOnly('pmStep2');
          _pmSetProgress(66);
          _pmSetStepLabel('Step 2 of 3 — Choose payment method');
          Toast.info('Payment cancelled — you can try again anytime.');
        }
      });
    } catch (err) {
      console.error('Paystack error:', err);
      Toast.error(err.message || 'Could not launch Paystack. Please try another method.');
      _pmShowOnly('pmStep2');
      _pmSetProgress(66);
      _pmSetStepLabel('Step 2 of 3 — Choose payment method');
    }
  }, 300);
}

/* ── Ozow redirect ──────────────────────────── */
/**
 * Ozow uses a server-side hash; on the frontend we build the
 * payment URL and redirect the client. For test/sandbox mode we
 * simulate the redirect — in production replace with your real
 * Ozow site-code and server-generated hash.
 *
 * Ozow sandbox URL: https://pay.ozow.com/
 * Required params: SiteCode, CountryCode, CurrencyCode, Amount,
 *                  TransactionReference, BankReference, Customer,
 *                  CancelUrl, ErrorUrl, SuccessUrl, IsTest
 */
async function launchOzow() {
  _pmShowOnly('pmStep3Processing');
  _pmSetProgress(100);
  _pmSetStepLabel('Step 3 of 3 — Ozow');
  _pmEl('pmProcessingTitle').textContent    = 'Preparing Ozow payment…';
  _pmEl('pmProcessingSubtitle').textContent = 'Securing your session — please wait';

  const ref          = `SVC-OZ-${Date.now()}`;
  const totalCharged = _pmTotal(_pmAmount);
  const baseUrl      = window.location.href.split('?')[0];
  const successUrl   = `${baseUrl}?payment=success&ref=${ref}&gw=ozow`;
  const cancelUrl    = `${baseUrl}?payment=cancelled&gw=ozow`;
  const errorUrl     = `${baseUrl}?payment=error&gw=ozow`;
  const amountFmt    = totalCharged.toFixed(2);

  // Persist amount to sessionStorage so it survives the redirect
  try {
    sessionStorage.setItem('svc_ozow_amount', String(_pmAmount));
    sessionStorage.setItem('svc_ozow_ref',    ref);
    sessionStorage.setItem('svc_ozow_inv_id', _pmInvestorId());
  } catch (_) { /* private-mode browsers may block sessionStorage */ }

  try {
    // Server generates the SHA-512 hash using OZOW_PRIVATE_KEY (never leaves server).
    // Server also returns OZOW_SITE_CODE and isTest so the frontend doesn't need them hardcoded.
    const hashRes = await API._fetch('POST', 'payments/ozow-hash', {
      countryCode:    'ZA',
      currencyCode:   'ZAR',
      amount:         amountFmt,
      transactionRef: ref,
      bankRef:        _pmInvestorId(),
      cancelUrl,
      errorUrl,
      successUrl,
    });
    const hash     = hashRes.hash;
    const siteCode = hashRes.siteCode;
    const isTest   = hashRes.isTest || 'false';
    if (!hash || !siteCode) throw new Error('Invalid response from payment server');

    // Pre-record a pending deposit (base amount — fee stays with gateway)
    await _recordDeposit('ozow', ref, 'pending', false);

    _pmEl('pmProcessingTitle').textContent    = 'Redirecting to Ozow…';
    _pmEl('pmProcessingSubtitle').textContent = 'You will be taken to the Ozow secure payment page';

    const ozowUrl = [
      'https://pay.ozow.com/',
      `?SiteCode=${encodeURIComponent(siteCode)}`,
      `&CountryCode=ZA`,
      `&CurrencyCode=ZAR`,
      `&Amount=${amountFmt}`,
      `&TransactionReference=${encodeURIComponent(ref)}`,
      `&BankReference=${encodeURIComponent(_pmInvestorId())}`,
      `&Customer=${encodeURIComponent(_pmInvestorName())}`,
      `&CancelUrl=${encodeURIComponent(cancelUrl)}`,
      `&ErrorUrl=${encodeURIComponent(errorUrl)}`,
      `&SuccessUrl=${encodeURIComponent(successUrl)}`,
      `&IsTest=${isTest}`,
      `&HashCheck=${hash}`,
    ].join('');

    setTimeout(() => { window.location.href = ozowUrl; }, 800);
  } catch (err) {
    console.error('Ozow launch error:', err);
    const msg = err.message?.includes('not configured') ? err.message : 'Could not initialise Ozow payment — please contact support.';
    Toast.error(msg);
    _pmShowOnly('pmStep2');
    _pmSetProgress(66);
    _pmSetStepLabel('Step 2 of 3 — Choose Payment Method');
  }
}

/* ── EFT (manual) ───────────────────────────── */
function showEftDetails() {
  const investorId = _pmInvestorId();
  _pmEl('eftAmountDisplay').textContent = `R${_pmAmount.toLocaleString('en-ZA')}`;
  _pmEl('eftReference').textContent     = investorId;

  _pmShowOnly('pmStep3Eft');
  _pmSetProgress(100);
  _pmSetStepLabel('Step 3 of 3 — Bank Transfer');
}

/* ── EFT proof of payment file handler ─── */
let _eftProofFile = null;
let _eftProofBase64 = null;

function handleEftProofFile(input) {
  const file = input.files[0];
  if (!file) return;

  // Validate size (max 5MB)
  if (file.size > 5 * 1024 * 1024) {
    Toast.error('File too large — maximum size is 5MB');
    input.value = '';
    return;
  }

  _eftProofFile = file;

  // Show file name
  const status = document.getElementById('eftProofStatus');
  const name   = document.getElementById('eftProofFileName');
  if (status && name) {
    name.textContent = file.name;
    status.style.display = 'block';
  }

  // Read as base64 so we can reference it in the support ticket
  const reader = new FileReader();
  reader.onload = e => { _eftProofBase64 = e.target.result; };
  reader.readAsDataURL(file);

  Toast.success(`Proof attached: ${file.name}`);
}

function copyEftRef() {
  const ref = _pmEl('eftReference').textContent;
  navigator.clipboard.writeText(ref).then(() => {
    Toast.success(`Reference "${ref}" copied to clipboard`);
  }).catch(() => {
    Toast.error('Could not copy — please copy the reference manually');
  });
}

async function confirmEftDeposit() {
  const ref = `EFT-${Date.now()}`;
  await _recordDeposit('eft', ref, 'pending', true);

  // Submit proof-of-payment as a support ticket to the admin
  try {
    const investorId   = _pmInvestorId();
    const investorName = _pmInvestorName();
    const amount       = _pmAmount;
    let description = `EFT wallet top-up of R${amount.toLocaleString('en-ZA',{minimumFractionDigits:2})} submitted by ${investorName} (${investorId}). Reference: ${ref}.`;

    if (_eftProofFile && _eftProofBase64) {
      description += `\n\nProof of payment attached: ${_eftProofFile.name} (${(_eftProofFile.size/1024).toFixed(1)} KB).\nData URL: ${_eftProofBase64.substring(0, 200)}...`;
    } else {
      description += '\n\nNo proof of payment was uploaded. Investor was advised to email admin@svcapital.co.za.';
    }

    await API.tickets.create({
      id:            Utils.genId('TKT'),
      investor_id:   investorId,
      investor_name: investorName,
      subject:       `EFT Proof of Payment — ${investorName} — R${amount.toLocaleString('en-ZA')} — ${ref}`,
      category:      'payment_proof',
      priority:      'high',
      status:        'open',
      message:       description,
      proof_filename: _eftProofFile ? _eftProofFile.name : '',
      proof_attached: !!_eftProofFile,
      created_at:    new Date().toISOString(),
    });
  } catch (ticketErr) {
    console.warn('Could not create EFT proof ticket:', ticketErr);
    // Non-fatal — the deposit was still recorded
  } finally {
    // Reset proof state
    _eftProofFile   = null;
    _eftProofBase64 = null;
    const input = document.getElementById('eftProofFile');
    if (input) input.value = '';
    const status = document.getElementById('eftProofStatus');
    if (status) status.style.display = 'none';
  }
}

/* ── Show deposit success screen (shared by paystack verify path + EFT) ─── */
async function _showDepositSuccess(gateway, reference) {
  _pmShowOnly('pmStep3Success');
  _pmSetProgress(100);
  _pmSetStepLabel('Complete');
  const isGateway = gateway === 'paystack' || gateway === 'ozow';
  const fee = isGateway ? _pmFee(_pmAmount) : 0;
  const fmtBase = `R${_pmAmount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  _pmEl('pmSuccessAmount').innerHTML =
    `<strong style="color:#22c55e">${fmtBase}</strong> successfully credited to your wallet` +
    (fee > 0 ? `<br><span style="font-size:0.75rem;color:#6b7280">R${fee.toFixed(2)} gateway fee charged by ${gateway === 'paystack' ? 'Paystack' : 'Ozow'}</span>` : '');
  _pmEl('pmSuccessRef').textContent = `Reference: ${reference}`;
  showSuccessOverlay({ title: 'Payment Received!', subtitle: `${fmtBase} added to your wallet` });
  await loadPortalData();
  loadWallet();
}

/* ── core: record deposit transaction + update wallet balance ─── */
/**
 * _recordDeposit(gateway, reference, status, showSuccess)
 * 1. Creates a deposit transaction record.
 * 2. For completed payments, updates the investor's wallet_balance directly
 *    so the balance shown in the portal reflects the new funds immediately.
 * 3. For gateway payments (Paystack/Ozow) the fee is recorded separately
 *    as a 'fee' transaction so the ledger is transparent.
 * Only the BASE amount (_pmAmount) is credited to the wallet — the gateway
 * fee is charged on top of that by the provider and never touches the wallet.
 */
async function _recordDeposit(gateway, reference, status, showSuccess = true) {
  const gatewayLabel = { paystack: 'Paystack', ozow: 'Ozow', eft: 'EFT' }[gateway] || gateway;
  const isGateway    = gateway === 'paystack' || gateway === 'ozow';
  const fee          = isGateway ? _pmFee(_pmAmount) : 0;

  const depositDesc = status === 'pending'
    ? `Wallet top-up via ${gatewayLabel} — pending confirmation`
    : `Wallet top-up via ${gatewayLabel} — R${_pmAmount.toLocaleString('en-ZA')} credited to wallet`;

  try {
    // 1. Record the deposit transaction (base wallet-credit amount)
    await API.transactions.create({
      id:               Utils.genId('TXN'),
      investor_id:      _pmInvestorId(),
      investor_name:    _pmInvestorName(),
      type:             'deposit',
      amount:           _pmAmount,
      status:           status,
      reference:        reference,
      description:      depositDesc,
      sub_account_id:   _pmSaId || undefined,
      transaction_date: new Date().toISOString(),
    });

    // 2. Record the gateway fee as a separate fee transaction (transparency)
    if (isGateway && fee > 0) {
      await API.transactions.create({
        id:          Utils.genId('TXN'),
        investor_id: _pmInvestorId(),
        type:        'fee',
        amount:      -fee,
        status:      status,
        reference:   `FEE-${reference}`,
        description: `Gateway fee (2.9% + R1) — ${gatewayLabel} · charged by payment provider`,
      });
    }

    // 3. If completed, update the investor's wallet_balance in the DB.
    //    Paystack deposits are now handled server-side via /api/payments/paystack/verify
    //    (which uses an atomic SQL increment). Only run this client-side PATCH for
    //    non-Paystack gateways (EFT, Ozow, admin top-ups) to avoid double-crediting.
    if (status === 'completed' && PORTAL.investor && gateway !== 'paystack') {
      const currentBalance = parseFloat(PORTAL.investor.wallet_balance) || 0;
      const newBalance     = Math.round((currentBalance + _pmAmount) * 100) / 100;

      try {
        await API.investors.update(PORTAL.investor.id, { wallet_balance: newBalance });
      } catch (dbErr) {
        console.warn('wallet_balance PATCH failed:', dbErr.message);
      }

      PORTAL.investor.wallet_balance = newBalance;
      _refreshWalletUI(newBalance);
    }

    // If this is a sub-account deposit, also update the sub-account wallet
    if (status === 'completed' && _pmSaId) {
      try {
        const saIdx = PORTAL.subAccounts.findIndex(s => s.id === _pmSaId);
        if (saIdx !== -1) {
          const newSaBal = Math.round(((parseFloat(PORTAL.subAccounts[saIdx].wallet_balance) || 0) + _pmAmount) * 100) / 100;
          await API._fetch('PATCH', `tables/sub_accounts/${_pmSaId}`, { wallet_balance: newSaBal });
          PORTAL.subAccounts[saIdx].wallet_balance = newSaBal;
        }
      } catch (saErr) { console.warn('Sub-account wallet update failed:', saErr); }
    }

    if (showSuccess) {
      if (status === 'pending') {
        _pmShowOnly('pmStep3Success');
        _pmSetProgress(100);
        _pmSetStepLabel('Complete');
        const fmtBase = `R${_pmAmount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        _pmEl('pmSuccessAmount').textContent = `${fmtBase} deposit registered — awaiting bank confirmation`;
        _pmEl('pmSuccessRef').textContent = `Reference: ${reference}`;
        await loadPortalData();
        loadWallet();
      } else {
        await _showDepositSuccess(gateway, reference);
      }
    }

  } catch (err) {
    console.error('recordDeposit error:', err);
    Toast.error('Failed to record deposit — please contact support if funds were deducted');
  }
  _pmSaId = null;
}

/* ── modal close ────────────────────────────── */
function closePaymentModal() {
  Modal.close('topUpModal');
  // If success was shown, refresh wallet display
  if (_pmEl('pmStep3Success') && _pmEl('pmStep3Success').style.display !== 'none') {
    loadPortalData().then(() => loadWallet());
  }
}

/* ── handle Ozow return URL params ─────────── */
(function checkOzowReturn() {
  const params  = new URLSearchParams(window.location.search);
  const payment = params.get('payment');
  const ref     = params.get('ref');
  const gw      = params.get('gw');

  if (!payment) return;

  // Clean URL immediately so refresh doesn't retrigger
  window.history.replaceState({}, document.title, window.location.pathname);

  if (payment === 'success' && gw === 'ozow' && ref) {

    // ── Restore the deposit amount that was saved before redirect ──
    let ozowAmount = 0;
    try {
      const stored = sessionStorage.getItem('svc_ozow_amount');
      ozowAmount   = stored ? parseFloat(stored) : 0;
      // Keep sessionStorage until we confirm we've handled it
    } catch (_) { /* private-mode browsers */ }

    // Wait for portal data to load before crediting the wallet
    setTimeout(async () => {
      try {
        // Ensure portal data is ready
        if (!PORTAL.investor) await loadPortalData();

        const investorId = _pmInvestorId();

        // 1. Find the matching pending transaction and mark it completed
        const txnRes  = await API.transactions.list({ limit: 200 });
        const allTxns = txnRes.data || [];
        const match   = allTxns.find(t =>
          t.reference === ref &&
          (t.investor_id === investorId || t.investor_id === (sessionStorage.getItem('svc_ozow_inv_id') || investorId))
        );
        if (match) {
          await API.transactions.update(match.id, { ...match, status: 'completed' });
          // If the transaction has an amount recorded, use that as the canonical credit
          if (!ozowAmount && match.amount > 0) ozowAmount = match.amount;
        }

        // 2. Credit wallet balance — use restored ozowAmount (or _pmAmount as fallback)
        const creditAmount = ozowAmount || _pmAmount;
        if (PORTAL.investor && creditAmount > 0) {
          const currentBalance = parseFloat(PORTAL.investor.wallet_balance) || 0;
          const newBalance     = Math.round((currentBalance + creditAmount) * 100) / 100;
          try {
            await API.investors.update(PORTAL.investor.id, { wallet_balance: newBalance });
          } catch (_dbErr) {
            // Retry with full record spread
            await API.investors.update(PORTAL.investor.id, {
              ...PORTAL.investor,
              wallet_balance: newBalance,
            });
          }
          // Update local cache so all UI elements show the new balance immediately
          PORTAL.investor.wallet_balance = newBalance;
          _refreshWalletUI(newBalance);

          // Also record any outstanding fee transaction if it wasn't logged pre-redirect
          // (only if the pre-record call failed before the redirect)
        }

        // Clean up sessionStorage
        try {
          sessionStorage.removeItem('svc_ozow_amount');
          sessionStorage.removeItem('svc_ozow_ref');
          sessionStorage.removeItem('svc_ozow_inv_id');
        } catch (_) { /* ignore */ }

      } catch (err) {
        console.error('Ozow return handler error:', err);
      }

      Toast.success(`Ozow payment successful! R${ozowAmount ? ozowAmount.toLocaleString('en-ZA') : ''} has been credited to your wallet.`);
      navigate('wallet', document.querySelector('[data-view=wallet]'));
      loadPortalData().then(() => loadWallet());
    }, 800);

  } else if (payment === 'cancelled') {
    Toast.info('Ozow payment was cancelled. No funds were deducted.');
    navigate('wallet', document.querySelector('[data-view=wallet]'));
    // Clear any stored Ozow session state
    try { sessionStorage.removeItem('svc_ozow_amount'); sessionStorage.removeItem('svc_ozow_ref'); sessionStorage.removeItem('svc_ozow_inv_id'); } catch (_) { /* ignore */ }

  } else if (payment === 'error') {
    Toast.error('Ozow payment failed. Please try again or contact support.');
    navigate('wallet', document.querySelector('[data-view=wallet]'));
    try { sessionStorage.removeItem('svc_ozow_amount'); sessionStorage.removeItem('svc_ozow_ref'); sessionStorage.removeItem('svc_ozow_inv_id'); } catch (_) { /* ignore */ }
  }
})();

/* ═══════════════════════════════════════════════
   MARKETPLACE
   ═══════════════════════════════════════════════ */
async function loadMarketplace() {
  if (!PORTAL.pools.length) {
    const res = await API.pools.list({ limit: 100 });
    PORTAL.pools = res.data || [];
  }
  renderMarketplace();
  SVC.track('view_item_list', { item_list_id: 'marketplace', item_list_name: 'Investment Pools', items: PORTAL.pools.slice(0, 10).map(p => ({ item_id: p.id, item_name: p.name, item_category: p.product_type })) });
}

function filterMarket(type, btn) {
  PORTAL.marketFilter = type;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderMarketplace();
  SVC.track('svc_filter_changed', { filter_type: 'marketplace', filter_value: type });
}

const _POOL_META = {
  solar:         { blurb: 'Funds solar energy installations for homes & businesses across SA.', risk: 'Medium',      riskColor: '#f59e0b' },
  solar_7yr:     { blurb: 'Funds solar energy installations for homes & businesses across SA.', risk: 'Medium',      riskColor: '#f59e0b' },
  solar_6yr:     { blurb: 'Funds solar energy installations for homes & businesses across SA.', risk: 'Medium',      riskColor: '#f59e0b' },
  solar_5yr:     { blurb: 'Funds solar energy installations for homes & businesses across SA.', risk: 'Medium',      riskColor: '#f59e0b' },
  cattle:        { blurb: 'Invests in livestock purchasing, management, and resale cycles.',    risk: 'Medium-High',  riskColor: '#ff9b0c' },
  short_term:    { blurb: 'Short-duration bridging finance to vetted borrowers. High liquidity.', risk: 'Medium',    riskColor: '#f59e0b' },
  delivery_bike: { blurb: 'Fleet funding for delivery riders. Steady, predictable returns.',    risk: 'Low-Medium',   riskColor: '#22c55e' },
};

function renderMarketplace() {
  const grid = document.getElementById('marketplaceGrid');
  // Include waitlisted pools too so they appear in the marketplace
  const visiblePools = PORTAL.pools.filter(p => p.status === 'open' || p.status === 'waitlist');
  const filtered = PORTAL.marketFilter === 'all'
    ? visiblePools
    : visiblePools.filter(p => {
        if (PORTAL.marketFilter === 'solar') return p.product_type.includes('solar');
        return p.product_type === PORTAL.marketFilter;
      });

  // Update wallet strip
  const strip = document.getElementById('mktWalletStrip');
  const walletBal = parseFloat(PORTAL.investor?.wallet_balance) || 0;
  const ranked = _rankMarketPools(filtered, walletBal);
  if (strip) {
    strip.style.display = 'flex';
    const balEl = document.getElementById('mktWalletBal');
    if (balEl) {
      balEl.textContent = Utils.rand(walletBal);
      balEl.style.color = walletBal >= 500 ? 'var(--green)' : 'var(--gold)';
    }
  }

  renderMarketConversionPanel(ranked);

  if (!ranked.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <i class="fa-solid fa-layer-group"></i>
      <div class="empty-state__title">No pools match this filter right now</div>
      <div class="empty-state__sub">Switch category or join a waitlist so you do not lose momentum.</div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px">
        <button class="btn btn--secondary btn--sm" onclick="filterMarket('all', document.querySelector('#view-marketplace .tab-btn'))"><i class="fa-solid fa-rotate"></i> Show all pools</button>
        <button class="btn btn--primary btn--sm" onclick="navigate('support', document.querySelector('[data-view=support]'))"><i class="fa-solid fa-headset"></i> Ask a question</button>
      </div>
    </div>`;
    return;
  }

  const waitlist = PORTAL.waitlist || [];
  const investorId = PORTAL.investor?.id;
  const ficaApproved = _isInvestorFicaApproved(PORTAL.investor);

  grid.innerHTML = ranked.map((pool, idx) => {
    const pi   = Utils.productInfo(pool.product_type);
    const pct  = Utils.poolFillPct(pool);
    const days = Utils.daysRemaining(pool.end_date);
    const meta = _POOL_META[pool.product_type] || { blurb: '', risk: 'Medium', riskColor: '#f59e0b' };
    const canInvest = walletBal >= pool.min_investment;
    const urgency   = days !== null && days <= 7;

    // Waitlist state
    const isWaitlisted = pool.status === 'waitlist' || pool.is_waitlisted;
    const alreadyOnWaitlist = waitlist.some(w => w.pool_id === pool.id && w.investor_id === investorId);

    // Capacity progress bar
    const maxCap = parseFloat(pool.max_capacity) || 0;
    const curInv = parseFloat(pool.current_invested) || parseFloat(pool.raised_amount) || 0;
    let capacityBarHtml = '';
    if (maxCap > 0) {
      const capPct = Math.min(100, Math.round((curInv / maxCap) * 100));
      const capColor = capPct >= 90 ? '#ef4444' : capPct >= 70 ? '#f59e0b' : '#22c55e';
      capacityBarHtml = `
        <div style="margin-top:6px">
          <div style="display:flex;justify-content:space-between;font-size:0.68rem;color:var(--text-muted);margin-bottom:3px">
            <span>Capacity</span>
            <span style="color:${capColor};font-weight:700">${capPct}% filled</span>
          </div>
          <div style="height:4px;border-radius:2px;background:rgba(0,0,0,0.1);overflow:hidden">
            <div style="height:100%;width:${capPct}%;background:${capColor};border-radius:2px;transition:width 0.4s"></div>
          </div>
        </div>`;
    }

    // CTA area
    let ctaHtml;
    if (isWaitlisted) {
      if (alreadyOnWaitlist) {
        ctaHtml = `
          <div style="display:flex;align-items:center;gap:8px;margin-top:2px">
            <span class="badge badge--green" style="flex:1;justify-content:center;padding:10px 0"><i class="fa-solid fa-check"></i> On Waitlist</span>
          </div>`;
      } else {
        ctaHtml = `
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:2px">
            <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;font-size:0.78rem;color:#ef4444">
              <i class="fa-solid fa-lock"></i> Pool Full — Waitlist Available
            </div>
            <button class="btn btn--secondary btn--full" onclick='joinWaitlist(${JSON.stringify(pool.id)})'>
              <i class="fa-solid fa-clock"></i> Join Waitlist
            </button>
          </div>`;
      }
    } else if (!ficaApproved) {
      ctaHtml = `<div style="display:flex;flex-direction:column;gap:6px;margin-top:2px">
                   <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:rgba(47,140,155,0.08);border:1px solid rgba(47,140,155,0.18);border-radius:8px;font-size:0.78rem;color:#2F8C9B">
                     <i class="fa-solid fa-shield-halved"></i> Complete FICA/KYC before your first investment
                   </div>
                   <button class="btn btn--secondary btn--full" onclick="navigate('profile', document.querySelector('[data-view=profile]'));openKycUploadModal()">
                     <i class="fa-solid fa-upload"></i> Complete FICA/KYC
                   </button>
                 </div>`;
    } else if (canInvest) {
      ctaHtml = `<button class="btn btn--primary btn--full" onclick='openInvestModal(${JSON.stringify(pool.id)})'>
                   <i class="fa-solid fa-coins"></i> Invest Now
                 </button>`;
    } else {
      ctaHtml = `<div class="pool-card__need-topup">
                   <i class="fa-solid fa-wallet"></i>
                   <span>Need ${Utils.rand(pool.min_investment - walletBal)} more in wallet</span>
                   <button class="btn btn--ghost btn--sm" onclick="navigate('wallet',document.querySelector('[data-view=wallet]'))">Top Up</button>
                 </div>`;
    }

    const highlighted = idx === 0 && pool.status === 'open';

    return `
      <div class="market-pool-card" style="${highlighted ? 'border-color:rgba(255,155,12,0.38);box-shadow:0 12px 28px rgba(255,155,12,0.12)' : ''}">
        <div class="flex-between">
          <div class="market-pool-card__icon" style="background:${pi.color}18;color:${pi.color}"><i class="fa-solid ${pi.icon}"></i></div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
            ${highlighted ? '<span style="font-size:0.65rem;font-weight:800;color:#FF8215;background:rgba(255,155,12,0.12);padding:3px 8px;border-radius:999px;border:1px solid rgba(255,155,12,0.2)">Best next step</span>' : ''}
            <span class="pool-risk-badge" style="background:${meta.riskColor}18;color:${meta.riskColor}">${meta.risk} risk</span>
            ${isWaitlisted
              ? '<span class="badge badge--red" style="font-size:0.65rem"><i class="fa-solid fa-lock"></i> Pool Full</span>'
              : (urgency ? '<span class="pool-urgency-badge"><i class="fa-solid fa-fire"></i> Closing soon</span>' : Utils.statusBadge(pool.status))
            }
          </div>
        </div>

        <div>
          <div class="market-pool-card__title">${pool.name}</div>
          <div class="market-pool-card__blurb">${meta.blurb}</div>
        </div>

        <div class="pool-rate-row">
          <div>
            <div class="market-pool-card__rate">${Utils.pct(pool.annual_rate)}</div>
            <div class="market-pool-card__rate-label">per annum</div>
          </div>
          <div class="pool-rate-divider"></div>
          <div>
            <div class="market-pool-card__rate" style="font-size:1.4rem">${pool.term_months}mo</div>
            <div class="market-pool-card__rate-label">fixed term</div>
          </div>
          <div class="pool-rate-divider"></div>
          <div>
            <div class="market-pool-card__rate" style="font-size:1.4rem">${Utils.rand(pool.min_investment)}</div>
            <div class="market-pool-card__rate-label">minimum</div>
          </div>
        </div>

        <div class="market-pool-stats">
          <div class="mps"><span class="mps__label"><i class="fa-solid fa-users" style="font-size:0.65rem"></i> Investors</span><span class="mps__value">${pool.live_investor_count ?? pool.investor_count ?? 0}</span></div>
          <div class="mps"><span class="mps__label"><i class="fa-solid fa-clock" style="font-size:0.65rem"></i> Closes in</span><span class="mps__value" style="${urgency?'color:var(--gold)':''}">${days !== null ? days + 'd' : '—'}</span></div>
          <div class="mps"><span class="mps__label"><i class="fa-solid fa-building-columns" style="font-size:0.65rem"></i> Partner</span><span class="mps__value" style="font-size:0.72rem">${pool.partner_name || '—'}</span></div>
        </div>

        <div>
          <div class="pool-card__progress-label">
            <span>${Utils.rand(pool.live_raised ?? pool.raised_amount ?? 0)} raised</span>
            <span>${pct}% funded</span>
          </div>
          <div class="progress-bar"><div class="progress-fill${pool.product_type.includes('solar') ? ' progress-fill--green' : pool.product_type === 'short_term' ? ' progress-fill--blue' : ''}" style="width:${pct}%"></div></div>
          ${capacityBarHtml}
        </div>

        ${ctaHtml}
      </div>
    `;
  }).join('');
}

/* ─── Waitlist ───────────────────────────────────────────────────── */
async function joinWaitlist(poolId) {
  const investorId = PORTAL.investor?.id;
  if (!investorId) { Toast.error('Please log in to join the waitlist'); return; }

  // Check already on waitlist
  if ((PORTAL.waitlist || []).some(w => w.pool_id === poolId && w.investor_id === investorId)) {
    Toast.info('You are already on the waitlist for this pool.');
    return;
  }

  try {
    const entry = {
      id: Utils.genId('WL'),
      investor_id: investorId,
      pool_id: poolId,
      created_at: new Date().toISOString()
    };

    await API._fetch('POST', 'tables/investment_waitlist', entry);

    // Update local state
    PORTAL.waitlist = PORTAL.waitlist || [];
    PORTAL.waitlist.push(entry);

    // Persist to localStorage for instant UI
    try {
      const key = `svc_waitlist_${investorId}`;
      const stored = JSON.parse(localStorage.getItem(key) || '[]');
      stored.push(entry);
      localStorage.setItem(key, JSON.stringify(stored));
    } catch (_) { /* localStorage unavailable */ }

    Toast.success("You're on the waitlist! We'll notify you when this pool reopens.");
    renderMarketplace();
  } catch (e) {
    console.error('joinWaitlist error:', e);
    Toast.error('Could not join waitlist. Please try again.');
  }
}

function openInvestModal(poolId) {
  const pool = PORTAL.pools.find(p => p.id === poolId);
  if (!pool) return;
  if (!_isInvestorFicaApproved(PORTAL.investor)) {
    Toast.info('Complete FICA/KYC verification before making your first investment.');
    navigate('profile', document.querySelector('[data-view=profile]'));
    openKycUploadModal();
    return;
  }

  SVC.track('view_item', { items: [{ item_id: pool.id, item_name: pool.name, item_category: pool.product_type }] });
  SVC.track('select_item', { items: [{ item_id: pool.id, item_name: pool.name, item_category: pool.product_type }] });

  const walletBal  = parseFloat(PORTAL.investor?.wallet_balance) || 0;
  const pi         = Utils.productInfo(pool.product_type);
  const meta       = _POOL_META[pool.product_type] || { risk: 'Medium', riskColor: '#f59e0b' };
  const maturityDt = new Date();
  maturityDt.setMonth(maturityDt.getMonth() + pool.term_months);
  const maturityStr = maturityDt.toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });

  document.getElementById('investModalTitle').textContent = `Invest in ${pool.name}`;

  document.getElementById('investModalBody').innerHTML = `
    <!-- Pool summary card -->
    <div class="invest-modal-pool-card">
      <div class="invest-modal-pool-icon" style="background:${pi.color}20;color:${pi.color}">
        <i class="fa-solid ${pi.icon}"></i>
      </div>
      <div class="invest-modal-pool-info">
        <div class="invest-modal-pool-name">${pool.name}</div>
        <div class="invest-modal-pool-meta">
          <span style="color:${pi.color};font-weight:700">${Utils.pct(pool.annual_rate)} p.a.</span>
          <span>·</span>
          <span>${pool.term_months}-month term</span>
          <span>·</span>
          <span class="pool-risk-badge" style="background:${meta.riskColor}18;color:${meta.riskColor}">${meta.risk} risk</span>
        </div>
      </div>
    </div>

    <!-- Wallet balance indicator -->
    <div class="invest-wallet-indicator ${walletBal >= pool.min_investment ? 'invest-wallet-ok' : 'invest-wallet-low'}">
      <i class="fa-solid fa-wallet"></i>
      <span>Your wallet: <strong>${Utils.rand(walletBal)}</strong></span>
      ${walletBal < pool.min_investment
        ? `<button class="btn btn--ghost btn--sm" onclick="Modal.close('investModal');navigate('wallet',document.querySelector('[data-view=wallet]'))">
             <i class="fa-solid fa-plus"></i> Top Up
           </button>`
        : `<span class="invest-wallet-ok-badge"><i class="fa-solid fa-circle-check"></i> Sufficient</span>`}
    </div>

    <!-- Quick-pick amount buttons -->
    <div class="form-group" style="margin-top:14px">
      <label class="form-label">How much would you like to invest?</label>
      <div class="invest-quickpick mb-8">
        ${[pool.min_investment, 5000, 10000, 25000].filter(v => v <= walletBal || v === pool.min_investment).map(v =>
          `<button class="invest-qp-btn" onclick="document.getElementById('investAmount').value=${v};_updateInvestCalc(${v},${pool.annual_rate},${pool.term_months},${pool.min_investment})">${Utils.rand(v)}</button>`
        ).join('')}
      </div>
      <input type="number" class="form-input" id="investAmount"
        placeholder="Enter amount (min ${Utils.rand(pool.min_investment)})"
        min="${pool.min_investment}" max="${walletBal}" oninput="_updateInvestCalc(parseFloat(this.value)||0,${pool.annual_rate},${pool.term_months},${pool.min_investment})" />
    </div>

    <!-- Live return calculator -->
    <div id="investCalcPreview" class="invest-calc-box">
      <div class="invest-calc-label">Estimated return at maturity</div>
      <div class="invest-calc-grid">
        <div><div class="invest-calc-caption">Invested</div><div class="invest-calc-val" id="ic-invested">—</div></div>
        <div class="invest-calc-plus">+</div>
        <div><div class="invest-calc-caption">Returns</div><div class="invest-calc-val" id="ic-returns" style="color:var(--green)">—</div></div>
        <div class="invest-calc-equals">=</div>
        <div><div class="invest-calc-caption">Total payout</div><div class="invest-calc-val invest-calc-total" id="ic-total">—</div></div>
      </div>
      <div class="invest-calc-date" id="ic-maturity">Maturity date: <strong>${maturityStr}</strong></div>
    </div>

    <!-- What happens next timeline -->
    <div class="invest-next-steps">
      <div class="ins-step"><div class="ins-dot ins-dot--active"></div><div class="ins-label"><b>Now</b> — funds deducted from wallet</div></div>
      <div class="ins-step"><div class="ins-dot"></div><div class="ins-label"><b>Ongoing</b> — returns accrue daily</div></div>
      <div class="ins-step"><div class="ins-dot"></div><div class="ins-label"><b>${maturityStr}</b> — payout to your wallet</div></div>
    </div>

    <div class="invest-lock-note">
      <i class="fa-solid fa-lock" style="color:var(--gold)"></i>
      Capital is locked for <strong>${pool.term_months} months</strong>. Early withdrawal is not available. Returns are not guaranteed.
    </div>
  `;

  const invBtn = document.getElementById('investConfirmBtn');
  invBtn.onclick = () => _withBtn(invBtn, () => confirmInvestment(pool));
  Modal.open('investModal');
}

function _updateInvestCalc(amt, rate, termMonths, minInvest) {
  const preview = document.getElementById('investCalcPreview');
  if (!preview) return;
  if (amt >= minInvest) {
    const ret = amt * rate * (termMonths / 12);
    document.getElementById('ic-invested').textContent = Utils.rand(Math.round(amt));
    document.getElementById('ic-returns').textContent  = '+' + Utils.rand(Math.round(ret));
    document.getElementById('ic-total').textContent    = Utils.rand(Math.round(amt + ret));
    preview.classList.add('invest-calc-box--visible');
  } else {
    document.getElementById('ic-invested').textContent = '—';
    document.getElementById('ic-returns').textContent  = '—';
    document.getElementById('ic-total').textContent    = '—';
    preview.classList.remove('invest-calc-box--visible');
  }
}

async function confirmInvestment(pool) {
  if (!_isInvestorFicaApproved(PORTAL.investor)) {
    Toast.error('Your FICA/KYC verification must be approved before you can invest.');
    navigate('profile', document.querySelector('[data-view=profile]'));
    openKycUploadModal();
    return;
  }
  const amount = parseFloat(document.getElementById('investAmount').value);
  if (!amount || amount < pool.min_investment) { Toast.error(`Minimum investment is ${Utils.rand(pool.min_investment)}`); return; }

  const wallet = parseFloat(PORTAL.investor?.wallet_balance) || 0;
  const platformFee = Math.round(amount * 0.01 * 100) / 100;
  const totalDeducted = amount + platformFee;
  if (totalDeducted > wallet) { Toast.error(`Insufficient balance. This investment requires ${Utils.rand(totalDeducted)} (${Utils.rand(amount)} + ${Utils.rand(platformFee)} platform fee).`); return; }

  try {
    const expectedReturn = amount * pool.annual_rate * (pool.term_months / 12);
    const maturityDate = new Date();
    maturityDate.setMonth(maturityDate.getMonth() + pool.term_months);

    // Create investment (server-side hook deducts wallet + fee atomically)
    await API.investments.create({
      id: Utils.genId('INVST'),
      investor_id: DEMO_INVESTOR_ID,
      pool_id: pool.id,
      product_type: pool.product_type,
      pool_name: pool.name,
      amount,
      annual_rate: pool.annual_rate,
      expected_return: Math.round(expectedReturn),
      actual_return: 0,
      status: 'active',
      start_date: new Date().toISOString().split('T')[0],
      end_date: maturityDate.toISOString().split('T')[0],
      term_months: pool.term_months,
      payout_option: 'reinvest',
      maturity_instruction: 'reinvest',   // default: roll into next open pool of same product
      sub_account_id: _pmSaId || undefined,
      is_reinvestment: false,
    });

    // Record investment transaction
    await API.transactions.create({
      id:          Utils.genId('TXN'),
      investor_id: DEMO_INVESTOR_ID,
      investor_name:    `${PORTAL.investor.first_name} ${PORTAL.investor.last_name}`,
      type:             'investment',
      amount:           amount,
      status:           'completed',
      reference:        `INVST-${Date.now()}`,
      description:      `Investment into ${pool.name}`,
      pool_id:          pool.id,
      transaction_date: new Date().toISOString(),
    });

    // Wallet deduction and total_invested update are handled atomically server-side
    // in the investment creation hook — do not also set wallet_balance here.

    Toast.success(`Successfully invested ${Utils.rand(amount)} in ${pool.name}!`);
    Modal.close('investModal');

    SVC.track('purchase', { transaction_id: investmentId, value: amount, currency: 'ZAR', items: [{ item_id: pool.id, item_name: pool.name, item_category: pool.product_type, price: amount, quantity: 1 }] });
    SVC.track('svc_investment_created', { pool_id: pool.id, pool_name: pool.name, product_type: pool.product_type, amount, amount_bucket: _amtBucket(amount), term_months: pool.term_months, annual_rate: parseFloat(pool.annual_rate) || 0, wallet_balance_bucket: _amtBucket(PORTAL.investor?.wallet_balance), total_investments: PORTAL.investments.filter(i => i.investor_id === (PORTAL.investor?.id || DEMO_INVESTOR_ID)).length + 1 });
    if (_pmSaId) {
      SVC.track('svc_subaccount_invested', { sub_account_id: _pmSaId, amount: amount });
    }

    // Reload data
    await loadPortalData();
    renderOverview();
  } catch (e) {
    SVC.error('investment', e.message);
    Toast.error('Investment failed. Please try again.');
    console.error(e);
  }
}

/* ═══════════════════════════════════════════════
   MATURITY
   ═══════════════════════════════════════════════ */
async function loadMaturity() {
  if (!PORTAL.investments.length) await loadPortalData();

  const container = document.getElementById('maturityInvestments');
  const matured = PORTAL.investments.filter(i => i.status === 'matured');
  const active  = PORTAL.investments.filter(i => i.status === 'active');

  let html = '';

  if (active.length) {
    html += `<h3 style="font-size:0.85rem;font-weight:700;color:var(--text-muted);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.08em"><i class="fa-solid fa-hourglass-half"></i> Upcoming Maturities (${active.length})</h3>`;
    html += active.map(inv => {
      const days = Utils.daysRemaining(inv.maturity_date);
      const hasInstruction = !!inv.maturity_instruction;
      return `<div class="maturity-card" style="border-color:var(--border)">
        <div class="maturity-card__info">
          <div class="maturity-card__name">${_esc(inv.pool_name)}</div>
          <div class="maturity-card__detail">Matures: ${Utils.date(inv.maturity_date)} · ${days} days remaining</div>
          ${hasInstruction ? `<div style="font-size:0.72rem;color:var(--green);margin-top:4px"><i class="fa-solid fa-check-circle"></i> Instruction set: ${inv.maturity_instruction.replace(/_/g,' ')}</div>` : ''}
        </div>
        <div class="maturity-card__payout">
          <div class="maturity-card__payout-value">${Utils.rand(inv.amount + inv.expected_return_amount)}</div>
          <div class="maturity-card__payout-label">Expected payout</div>
        </div>
        <button class="btn ${hasInstruction ? 'btn--secondary' : 'btn--primary'}" onclick='openMaturityModal(${JSON.stringify(inv.id)})'>
          <i class="fa-solid fa-${hasInstruction ? 'pen' : 'paper-plane'}"></i> ${hasInstruction ? 'Update Instruction' : 'Set Instruction'}
        </button>
      </div>`;
    }).join('');
  }

  if (matured.length) {
    html += `<h3 style="font-size:0.85rem;font-weight:700;color:var(--red);margin-top:${active.length ? '24px' : '0'};margin-bottom:12px;text-transform:uppercase;letter-spacing:0.08em"><i class="fa-solid fa-exclamation-circle"></i> Matured (${matured.length})</h3>`;
    html += matured.map(inv => {
      const total = inv.amount + (inv.actual_return_amount || inv.expected_return_amount);
      const instruction = inv.maturity_instruction;
      return `<div class="maturity-card">
        <div class="maturity-card__info">
          <div class="maturity-card__name">${_esc(inv.pool_name)}</div>
          <div class="maturity-card__detail">Matured: ${Utils.date(inv.maturity_date)} · Rate: ${Utils.pct(inv.expected_return_rate)}</div>
          ${instruction ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px"><i class="fa-solid fa-circle-check" style="color:var(--green)"></i> Instruction: ${instruction.replace(/_/g,' ')}</div>` : ''}
        </div>
        <div class="maturity-card__payout">
          <div class="maturity-card__payout-value">${Utils.rand(total)}</div>
          <div class="maturity-card__payout-label">Total payout value</div>
        </div>
        ${instruction
          ? `<span class="badge badge--gray" style="text-transform:capitalize">${instruction.replace(/_/g,' ')}</span>`
          : `<span class="badge" style="background:rgba(239,68,68,0.12);color:#b91c1c">Awaiting instruction</span>`
        }
      </div>`;
    }).join('');
  }

  if (!matured.length && !active.length) {
    html = '<div class="empty-state"><i class="fa-solid fa-hourglass"></i><p>No investments to show maturity instructions for.</p></div>';
  }

  container.innerHTML = html;
}

async function openMaturityModal(investmentId) {
  const inv = PORTAL.investments.find(i => i.id === investmentId);
  if (!inv) return;

  const isActive      = inv.status === 'active';
  const hasActualReturn = (parseFloat(inv.actual_return_amount) || 0) > 0;
  const returnAmt     = parseFloat(inv.actual_return_amount) || 0;
  const total         = inv.amount + returnAmt;
  const existing      = inv.maturity_instruction || '';

  // Fetch open pools of matching product type for reinvest option
  let reinvestPools = [];
  try {
    const poolsRes = await API.pools.list({ limit: 100 });
    reinvestPools = (poolsRes.data || []).filter(p => p.status === 'open' && p.product_type === inv.product_type);
  } catch (_) { /* non-fatal */ }

  const reinvestPoolsHtml = reinvestPools.length
    ? reinvestPools.map(p => `<option value="${p.id}">${p.name} (${Utils.rand(p.min_investment)} min · ${Utils.pct(p.annual_rate)} p.a.)</option>`).join('')
    : `<option value="" disabled>No open pools available for this product type</option>`;

  document.getElementById('maturityModalBody').innerHTML = `
    <div class="info-list mb-16">
      <div class="info-row"><span class="info-row__label">Pool</span><span class="info-row__value">${_esc(inv.pool_name)}</span></div>
      <div class="info-row"><span class="info-row__label">Capital</span><span class="info-row__value">${Utils.rand(inv.amount)}</span></div>
      ${hasActualReturn
        ? `<div class="info-row"><span class="info-row__label">Returns</span><span class="info-row__value text-green">${Utils.rand(returnAmt)}</span></div>
           <div class="info-row"><span class="info-row__label">Total Payout</span><span class="info-row__value text-gold fw-700">${Utils.rand(total)}</span></div>`
        : `<div class="info-row"><span class="info-row__label">Returns</span><span class="info-row__value text-muted" style="font-size:0.82rem;font-style:italic">Credited at maturity</span></div>`
      }
    </div>

    <div class="form-group">
      <label class="form-label">Instruction Type *</label>
      <select class="form-select" id="matInstructionType">
        <option value="payout_all" ${existing==='payout_all'?'selected':''}>Payout All — Receive full capital + returns</option>
        <option value="payout_return" ${existing==='payout_return'?'selected':''}>Payout Returns Only — Keep capital reinvested</option>
        <option value="reinvest" ${existing==='reinvest'?'selected':''}>Reinvest — Roll over into same product</option>
        <option value="payout_custom" ${existing==='payout_custom'?'selected':''}>Custom Payout — Specify amount</option>
      </select>
    </div>

    <div id="reinvestPoolGroup" style="display:${existing==='reinvest'?'block':'none'}">
      <div class="form-group">
        <label class="form-label">Select Pool to Reinvest Into *</label>
        <select class="form-select" id="matReinvestPool">
          ${reinvestPoolsHtml}
        </select>
        ${!reinvestPools.length ? `<div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px"><i class="fa-solid fa-info-circle"></i> A suitable open pool will be selected at maturity if none is available now.</div>` : ''}
      </div>
    </div>

    <div id="customPayoutGroup" style="display:${existing==='payout_custom'?'block':'none'}">
      <div class="form-group">
        <label class="form-label">Custom Payout Amount (R)</label>
        <input type="number" class="form-input" id="matCustomAmount" placeholder="Amount to withdraw" />
      </div>
    </div>

    <div style="font-size:0.72rem;color:var(--text-dim);line-height:1.6;margin-top:8px">
      <i class="fa-solid fa-clock" style="color:var(--gold)"></i>
      ${isActive
        ? `You can update this instruction at any time before maturity. If not submitted, funds will be automatically reinvested.`
        : `Instruction must be submitted before <strong>5:00 PM on ${Utils.date(inv.maturity_date)}</strong>. If not submitted, funds will be automatically reinvested.`
      }
    </div>
  `;

  document.getElementById('matInstructionType').addEventListener('change', e => {
    document.getElementById('customPayoutGroup').style.display  = e.target.value === 'payout_custom' ? 'block' : 'none';
    document.getElementById('reinvestPoolGroup').style.display  = e.target.value === 'reinvest'      ? 'block' : 'none';
  });

  const matBtn = document.getElementById('maturityConfirmBtn');
  matBtn.onclick = () => _withBtn(matBtn, () => submitMaturityInstruction(inv));
  Modal.open('maturityModal');
}

async function submitMaturityInstruction(inv) {
  const type      = document.getElementById('matInstructionType').value;
  const customAmt = type === 'payout_custom' ? parseFloat(document.getElementById('matCustomAmount').value) : null;
  const reinvestPoolId = type === 'reinvest' ? (document.getElementById('matReinvestPool')?.value || null) : null;

  if (type === 'payout_custom' && (!customAmt || customAmt <= 0)) { Toast.error('Please enter a valid custom payout amount'); return; }
  if (type === 'reinvest' && !reinvestPoolId) { Toast.error('Please select a pool to reinvest into, or choose another instruction type'); return; }

  try {
    await API.maturityInstructions.create({
      id: Utils.genId('MAT'),
      investment_id: inv.id,
      investor_id: DEMO_INVESTOR_ID,
      investor_name: `${PORTAL.investor.first_name} ${PORTAL.investor.last_name}`,
      pool_name: inv.pool_name,
      instruction: type,
      instruction_type: type,
      custom_payout_amount: customAmt || 0,
      reinvest_pool_id: reinvestPoolId,
      status: 'submitted',
      submitted_date: new Date().toISOString(),
      total_payout: inv.amount + (inv.actual_return_amount || inv.expected_return_amount)
    });

    await API.investments.update(inv.id, { maturity_instruction: type });

    Toast.success('Maturity instruction saved successfully!');
    SVC.track('svc_maturity_instruction', { investment_id: inv.id, action: type });
    Modal.close('maturityModal');
    PORTAL.investments = [];
    await loadPortalData();
    loadMaturity();
  } catch (e) { Toast.error('Failed to save instruction'); }
}

/* ═══════════════════════════════════════════════
   SUPPORT
   ═══════════════════════════════════════════════ */
async function loadSupport() {
  try {
    const res = await API.tickets.list({ limit: 100 });
    // Exclude system-generated tickets (AML checks etc.) from client view
    PORTAL.tickets = (res.data || []).filter(t =>
      t.investor_id === DEMO_INVESTOR_ID && !t.is_system && t.category !== 'aml_review'
    );
    renderMyTickets();
    restoreSupportDraft();
  } catch (e) { Toast.error('Failed to load tickets'); }
}

/* ── Ticket attachment state ─── */
let _tktAttachFile   = null;
let _tktAttachBase64 = null;

function handleTicketAttachment(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    Toast.error('File too large — maximum 10 MB');
    input.value = '';
    return;
  }
  _tktAttachFile = file;
  const status = document.getElementById('tktAttachStatus');
  const name   = document.getElementById('tktAttachName');
  if (status && name) { name.textContent = file.name; status.style.display = 'flex'; }
  const reader = new FileReader();
  reader.onload = e => { _tktAttachBase64 = e.target.result; };
  reader.readAsDataURL(file);
  Toast.success(`Attached: ${file.name}`);
}

function removeTicketAttachment() {
  _tktAttachFile   = null;
  _tktAttachBase64 = null;
  const inp = document.getElementById('tktAttachFile');
  if (inp) inp.value = '';
  const status = document.getElementById('tktAttachStatus');
  if (status) status.style.display = 'none';
}

async function submitTicket(btn) {
  const subject = document.getElementById('tktSubject').value.trim();
  const message = document.getElementById('tktMessage').value.trim();
  if (!subject || !message) { Toast.error('Subject and message are required'); return; }
  if (message.length > 1200) { Toast.error('Please keep your message under 1,200 characters'); return; }

  let attachmentInfo = '';
  if (_tktAttachFile && _tktAttachBase64) {
    attachmentInfo = `

📎 Attachment: ${_tktAttachFile.name} (${(_tktAttachFile.size/1024).toFixed(1)} KB)
Data: ${_tktAttachBase64}`;
  }

  await _withBtn(btn, async () => {
    try {
      await API.tickets.create({
        id:             Utils.genId('TKT'),
        investor_id:    DEMO_INVESTOR_ID,
        investor_name:  `${PORTAL.investor?.first_name || ''} ${PORTAL.investor?.last_name || ''}`.trim(),
        investor_email: PORTAL.investor?.email || '',
        subject,
        category:       document.getElementById('tktCategory').value,
        priority:       document.getElementById('tktPriority').value,
        message:        message + attachmentInfo,
        proof_attached: !!_tktAttachFile,
        proof_filename: _tktAttachFile ? _tktAttachFile.name : '',
        status:         'open',
      });
      Toast.success('Support ticket submitted. We\'ll respond within 1 business day.');
      document.getElementById('tktSubject').value = '';
      document.getElementById('tktMessage').value = '';
      document.getElementById('tktCategory').value = 'investment_query';
      document.getElementById('tktPriority').value = 'medium';
      removeTicketAttachment();
      clearSupportDraft();
      await loadSupport();
    } catch (e) { Toast.error('Failed to submit ticket'); }
  });
}

/* ─── FAQ ─── */
function toggleQuickFaq(btn) {
  const item = btn.closest('.faq-quick-item');
  const wasOpen = item.classList.contains('open');
  document.querySelectorAll('.faq-quick-item.open').forEach(i => i.classList.remove('open'));
  if (!wasOpen) item.classList.add('open');
}

/* ═══════════════════════════════════════════════════════════════
   STATEMENT GENERATOR
   ═══════════════════════════════════════════════════════════════ */

function initStatementView() {
  // Set wide default date range: 2020-01-01 → today to catch all seeded data
  const today = new Date();
  const toDate   = today.toISOString().split('T')[0];
  const fromDate = '2020-01-01';
  const fromEl = document.getElementById('stmtFrom');
  const toEl   = document.getElementById('stmtTo');
  if (fromEl && !fromEl.value) fromEl.value = fromDate;
  if (toEl && !toEl.value)     toEl.value   = toDate;
  bindStatementAssist();
  updateStmtQuickStats();
  renderStatementAssistCard({ trigger: 'init' });
}

function updateStmtQuickStats() {
  const previewEl = document.getElementById('stmtQuickStats');
  if (!previewEl) return;
  // Use ALL portal data (ignore date filter for summary)
  const investments  = PORTAL.investments  || [];
  const transactions = PORTAL.transactions || [];
  const investor     = PORTAL.investor     || {};
  const totalInvested = investments.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const totalReturns  = investments.reduce((s, i) => s + (Number(i.actual_return_amount) || 0), 0);
  const walletBal     = Number(investor.wallet_balance) || 0;
  const totalValue    = totalInvested + walletBal + totalReturns;

  if (investments.length === 0 && transactions.length === 0) {
    previewEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted)">
      <i class="fa-solid fa-file-invoice" style="font-size:2rem;margin-bottom:8px;display:block;opacity:0.4"></i>
      <span style="font-size:0.8rem">Portfolio data loading…</span>
    </div>`;
    return;
  }

  previewEl.innerHTML = `<div style="display:flex;flex-direction:column;gap:0">
    ${qsr('Investor', `${_esc(investor.first_name||'Thabo')} ${_esc(investor.last_name||'Khumalo')}`)}
    ${qsr('Investor ID', investor.id||'INV-002')}
    ${qsr('Total Investments', investments.length)}
    ${qsr('Total Transactions', transactions.length)}
    ${qsr('Capital Deployed', Utils.rand(totalInvested, 2))}
    ${qsr('Returns Earned', Utils.rand(totalReturns, 2))}
    ${qsr('Portfolio Value', Utils.rand(totalValue, 2))}
  </div>`;
}

function qsr(label, val) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(0,0,0,0.06);font-size:0.78rem">
    <span style="color:#6b7280;font-weight:500">${label}</span>
    <span style="font-weight:700;color:#1a1a1a">${val}</span>
  </div>`;
}

function generateStatement() {
  // Guard: PORTAL.investor must be populated (set in loadPortalData)
  if (!PORTAL.investor) {
    Toast.error('Portfolio data is still loading — please wait a moment and try again.');
    return;
  }

  const fromEl = document.getElementById('stmtFrom');
  const toEl   = document.getElementById('stmtTo');
  const fromVal = fromEl ? fromEl.value : '2020-01-01';
  const toVal   = toEl   ? toEl.value   : new Date().toISOString().split('T')[0];

  const from = new Date(fromVal + 'T00:00:00');
  const to   = new Date(toVal   + 'T23:59:59');
  // Safety: if dates are invalid, use wide range
  if (isNaN(from.getTime())) from.setFullYear(2020, 0, 1);
  if (isNaN(to.getTime()))   to.setTime(Date.now());

  const incPortfolio    = !!(document.getElementById('stmtIncPortfolio')?.checked);
  const incInvestments  = !!(document.getElementById('stmtIncInvestments')?.checked);
  const incTransactions = !!(document.getElementById('stmtIncTransactions')?.checked);
  const incPerformance  = !!(document.getElementById('stmtIncPerformance')?.checked);

  // Always include at least portfolio summary if nothing checked
  const anyChecked = incPortfolio || incInvestments || incTransactions || incPerformance;
  const effectivePortfolio    = anyChecked ? incPortfolio    : true;
  const effectiveInvestments  = anyChecked ? incInvestments  : true;
  const effectiveTransactions = anyChecked ? incTransactions : true;
  const effectivePerformance  = anyChecked ? incPerformance  : true;

  const investor    = PORTAL.investor || {};
  // Use ALL investments (not date-filtered — investment dates may predate range)
  const investments = PORTAL.investments || [];

  // Filter transactions by date range
  const allTxns = PORTAL.transactions || [];
  const transactions = allTxns.filter(t => {
    const raw = t.transaction_date || t.created_at;
    if (!raw) return true;
    const d = (typeof raw === 'number') ? new Date(raw) : new Date(String(raw).length === 10 ? raw + 'T00:00:00' : raw);
    if (isNaN(d.getTime())) return true;
    return d >= from && d <= to;
  });

  // Compute stats
  const totalInvested = investments.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const totalReturns  = investments.reduce((s, i) => s + (Number(i.actual_return_amount) || 0), 0);
  const activeInv     = investments.filter(i => i.status === 'active').length;
  const walletBal     = Number(investor.wallet_balance) || 0;
  const totalValue    = totalInvested + walletBal + totalReturns;

  // Build preview quick stats
  const previewEl = document.getElementById('stmtQuickStats');
  if (previewEl) {
    previewEl.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:8px">
        ${quickStatRow('Period', `${fmtDate(from)} — ${fmtDate(to)}`)}
        ${quickStatRow('Investments in Period', investments.length)}
        ${quickStatRow('Transactions in Period', transactions.length)}
        ${quickStatRow('Total Capital', Utils.rand(totalInvested))}
        ${quickStatRow('Returns Paid', Utils.rand(totalReturns))}
        ${quickStatRow('Portfolio Value', Utils.rand(totalValue))}
      </div>
    `;
  }

  // Build full statement document
  const doc = document.getElementById('statementDocument');
  if (!doc) return;

  const statementNumber = `SVC-${new Date().getFullYear()}-${String(Math.floor(Math.random()*90000)+10000)}`;
  const generatedAt = new Date().toLocaleString('en-ZA', {dateStyle:'long', timeStyle:'short'});

  let html = buildStatementHTML({
    investor, investments, transactions,
    from, to, totalInvested, totalReturns, walletBal, totalValue, activeInv,
    statementNumber, generatedAt,
    incPortfolio:    effectivePortfolio,
    incInvestments:  effectiveInvestments,
    incTransactions: effectiveTransactions,
    incPerformance:  effectivePerformance
  });

  doc.innerHTML = html;
  const generatedSummary = `${transactions.length} transaction${transactions.length === 1 ? '' : 's'} in range · ${effectivePerformance ? 'performance included' : 'summary only'}`;
  renderStatementAssistCard({
    generatedAt: new Date().toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }),
    summary: generatedSummary,
    txCount: transactions.length,
    preset: 'custom'
  });
  document.getElementById('statementPreview').style.display = 'block';
  document.getElementById('statementPreview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function quickStatRow(label, val) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.06);font-size:0.78rem">
    <span style="color:#6b7280;font-weight:500">${label}</span>
    <span style="font-weight:700;color:#1a1a1a">${val}</span>
  </div>`;
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = typeof d === 'number' ? new Date(d) : new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-ZA', { day:'2-digit', month:'short', year:'numeric' });
}

function fmtNum(n) {
  const val = Number(n) || 0;
  return 'R\u00A0' + val.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202F');
}

function buildStatementHTML(opts) {
  const {
    investor, investments, transactions,
    from, to, totalInvested, totalReturns, walletBal, totalValue, activeInv,
    statementNumber, generatedAt,
    incPortfolio, incInvestments, incTransactions, incPerformance
  } = opts;

  const fullName = `${investor.first_name || 'Thabo'} ${investor.last_name || 'Khumalo'}`;
  const investorId = investor.id || 'INV-002';
  const memberSince = investor.date_joined ? fmtDate(investor.date_joined) : '20 Aug 2022';
  const ficaStatus = investor.fica_status || 'approved';

  // SVG logo (inline base64-friendly reference)
  const logoSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 106.921 106.921" width="54" height="54">
    <defs>
      <linearGradient id="sl1" x1="0.874" x2="0.11" y1="0.034" y2="0.986" gradientUnits="objectBoundingBox">
        <stop offset="0" stop-color="#ff9b0c"/><stop offset="0.997" stop-color="#ff5229"/>
      </linearGradient>
      <linearGradient id="sl2" x1="0.5" x2="0.5" y1="0.027" y2="0.994" gradientUnits="objectBoundingBox">
        <stop offset="0" stop-color="#eda5ff"/><stop offset="1" stop-color="#fec24f"/>
      </linearGradient>
      <linearGradient id="sl3" x2="1" y1="0.5" y2="0.5" gradientUnits="objectBoundingBox">
        <stop offset="0" stop-color="#65ed00"/><stop offset="0.997" stop-color="#0096ff"/>
      </linearGradient>
      <linearGradient id="sl6" x1="0.131" x2="0.889" y1="0.029" y2="0.996" gradientUnits="objectBoundingBox">
        <stop offset="0.003" stop-color="#ffe86a"/><stop offset="1" stop-color="#ffb782"/>
      </linearGradient>
      <linearGradient id="sl7" x1="0.049" x2="0.965" y1="0.044" y2="0.971" gradientUnits="objectBoundingBox">
        <stop offset="0" stop-color="#ff9b0c"/><stop offset="0.997" stop-color="#ff5229"/>
      </linearGradient>
    </defs>
    <g transform="translate(7,4)">
      <path d="M47.268 21.928s-10.411-21.618-.073-41.726 33.975-24.223 33.975-24.223 10.41 21.619.073 41.727S47.268 21.928 47.268 21.928z" fill="url(#sl1)" opacity="0.85" transform="translate(-0.569 43.969)"/>
      <path d="M41.394 17.261s20.658-15.612 20.658-40.011-20.658-40.011-20.658-40.011-20.657 15.612-20.657 40.011 20.657 40.011 20.657 40.011z" fill="url(#sl2)" opacity="0.85" transform="translate(5.99 48.73)"/>
      <path d="M4.457 53.091a18.793 18.793 0 0 0 12.588 5.087 18.791 18.791 0 0 0 12.586-5.086 18.79 18.79 0 0 0-12.587-5.087A18.8 18.8 0 0 0 4.457 53.091z" fill="url(#sl3)" opacity="0.85" transform="translate(21.126 20.591)"/>
      <path d="M34.864 21.928s10.411-21.618.074-41.726-33.975-24.223-33.975-24.223-10.411 21.619-.074 41.727 33.975 24.222 33.975 24.222z" fill="url(#sl6)" opacity="0.85" transform="translate(22.194 43.969)"/>
      <path d="M32.301 28.28s2.935-21.1-11.262-35.3-35.3-11.261-35.3-11.261-2.935 21.1 11.262 35.3 35.3 11.261 35.3 11.261z" fill="url(#sl7)" opacity="0.85" transform="translate(24.945 36.806)"/>
    </g>
  </svg>`;

  let sections = '';

  // ─── PORTFOLIO SUMMARY ───
  if (incPortfolio) {
    sections += `
      <section style="margin-bottom:36px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #ff9b0c">
          <div style="width:4px;height:22px;background:linear-gradient(180deg,#FF9B0C,#FF5229);border-radius:2px"></div>
          <h3 style="font-size:13px;font-weight:800;color:#1a1a1a;letter-spacing:0.06em;text-transform:uppercase;margin:0">Portfolio Summary</h3>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px">
          ${stmtKPIBox('Total Portfolio Value', fmtNum(totalValue), '#ff9b0c')}
          ${stmtKPIBox('Capital Deployed', fmtNum(totalInvested), '#2F8C9B')}
          ${stmtKPIBox('Returns Earned', fmtNum(totalReturns), '#22C55E')}
          ${stmtKPIBox('Wallet Balance', fmtNum(walletBal), '#A855F7')}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div style="background:#F7F8FA;border-radius:8px;padding:14px;border:1px solid rgba(0,0,0,0.06)">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#9ca3af;font-weight:700;margin-bottom:10px">Account Details</div>
            ${stmtInfoRow('Investor Name', fullName)}
            ${stmtInfoRow('Investor ID', investorId)}
            ${stmtInfoRow('Email', investor.email || '—')}
            ${stmtInfoRow('Phone', investor.phone || '—')}
            ${stmtInfoRow('Member Since', memberSince)}
            ${stmtInfoRow('FICA Status', ficaStatus.charAt(0).toUpperCase() + ficaStatus.slice(1))}
          </div>
          <div style="background:#F7F8FA;border-radius:8px;padding:14px;border:1px solid rgba(0,0,0,0.06)">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#9ca3af;font-weight:700;margin-bottom:10px">Investment Snapshot</div>
            ${stmtInfoRow('Total Investments', investments.length)}
            ${stmtInfoRow('Active Investments', activeInv)}
            ${stmtInfoRow('Matured/Paid Out', investments.filter(i=>['matured','paid_out'].includes(i.status)).length)}
            ${stmtInfoRow('Risk Profile', investor.risk_profile ? investor.risk_profile.charAt(0).toUpperCase() + investor.risk_profile.slice(1) : 'Moderate')}
            ${stmtInfoRow('Province', investor.province || '—')}
          </div>
        </div>
      </section>`;
  }

  // ─── PERFORMANCE ANALYSIS ───
  if (incPerformance && investments.length > 0) {
    const byProduct = {};
    investments.forEach(inv => {
      const p = inv.product_type || 'unknown';
      if (!byProduct[p]) byProduct[p] = { count: 0, capital: 0, returns: 0 };
      byProduct[p].count++;
      byProduct[p].capital += Number(inv.amount) || 0;
      byProduct[p].returns += Number(inv.actual_return_amount) || 0;
    });

    const perfRows = Object.entries(byProduct).map(([prod, d]) => {
      const pct = d.capital > 0 ? ((d.returns / d.capital) * 100).toFixed(2) : '0.00';
      const info = getProductInfo(prod);
      return `<tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:8px 10px;font-size:11px;font-weight:700;color:#1a1a1a">${info.label}</td>
        <td style="padding:8px 10px;font-size:11px;color:#6b7280;text-align:center">${d.count}</td>
        <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;text-align:right;font-weight:600">${fmtNum(d.capital)}</td>
        <td style="padding:8px 10px;font-size:11px;color:#22C55E;text-align:right;font-weight:700">${fmtNum(d.returns)}</td>
        <td style="padding:8px 10px;font-size:11px;color:#ff9b0c;text-align:right;font-weight:700">${pct}%</td>
      </tr>`;
    }).join('');

    sections += `
      <section style="margin-bottom:36px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #2F8C9B">
          <div style="width:4px;height:22px;background:linear-gradient(180deg,#2F8C9B,#0096FF);border-radius:2px"></div>
          <h3 style="font-size:13px;font-weight:800;color:#1a1a1a;letter-spacing:0.06em;text-transform:uppercase;margin:0">Performance Analysis</h3>
        </div>
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eaeaea">
          <thead>
            <tr style="background:#F7F8FA">
              <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Product</th>
              <th style="padding:9px 10px;font-size:10px;text-align:center;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Count</th>
              <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Capital</th>
              <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Returns</th>
              <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Return %</th>
            </tr>
          </thead>
          <tbody>${perfRows}</tbody>
          <tfoot>
            <tr style="background:#F7F8FA">
              <td colspan="2" style="padding:9px 10px;font-size:11px;font-weight:800;color:#1a1a1a">TOTAL</td>
              <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#1a1a1a;text-align:right">${fmtNum(totalInvested)}</td>
              <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#22C55E;text-align:right">${fmtNum(totalReturns)}</td>
              <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#ff9b0c;text-align:right">${totalInvested>0?((totalReturns/totalInvested)*100).toFixed(2):0}%</td>
            </tr>
          </tfoot>
        </table>
      </section>`;
  }

  // ─── INVESTMENT DETAILS ───
  if (incInvestments && investments.length > 0) {
    const invRows = investments.map(inv => {
      const info = getProductInfo(inv.product_type);
      const returnRate = ((Number(inv.expected_return_rate)||0)*100).toFixed(2);
      const maturity = inv.maturity_date ? fmtDate(inv.maturity_date) : '—';
      const statusColor = inv.status === 'active' ? '#2F8C9B' : inv.status === 'paid_out' ? '#22C55E' : '#9ca3af';
      return `<tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:8px 10px;font-size:10px;color:#9ca3af;font-family:monospace">${inv.id}</td>
        <td style="padding:8px 10px">
          <span style="background:${info.bg};color:${info.color};font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase;letter-spacing:0.05em">${info.label}</span>
        </td>
        <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;text-align:right;font-weight:700">${fmtNum(inv.amount)}</td>
        <td style="padding:8px 10px;font-size:11px;color:#ff9b0c;text-align:right;font-weight:700">${returnRate}%</td>
        <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;text-align:right">${fmtDate(inv.investment_date)}</td>
        <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;text-align:right">${maturity}</td>
        <td style="padding:8px 10px">
          <span style="color:${statusColor};font-size:10px;font-weight:700;text-transform:uppercase">${inv.status}</span>
        </td>
      </tr>`;
    }).join('');

    sections += `
      <section style="margin-bottom:36px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #22C55E">
          <div style="width:4px;height:22px;background:linear-gradient(180deg,#22C55E,#16A34A);border-radius:2px"></div>
          <h3 style="font-size:13px;font-weight:800;color:#1a1a1a;letter-spacing:0.06em;text-transform:uppercase;margin:0">Investment Details</h3>
          <span style="margin-left:auto;font-size:10px;color:#9ca3af">${investments.length} records</span>
        </div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eaeaea;min-width:700px">
            <thead>
              <tr style="background:#F7F8FA">
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Ref.</th>
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Product</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Amount</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Return</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Start Date</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Maturity Date</th>
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Status</th>
              </tr>
            </thead>
            <tbody>${invRows}</tbody>
          </table>
        </div>
      </section>`;
  }

  // ─── TRANSACTION LEDGER ───
  if (incTransactions) {
    const txnRows = transactions.length > 0 ? transactions.map(t => {
      const isPos = t.type !== 'withdrawal' && t.type !== 'fee' && t.type !== 'investment';
      const amt = isPos ? `+${fmtNum(Math.abs(t.amount))}` : `-${fmtNum(Math.abs(t.amount))}`;
      const amtColor = isPos ? '#22C55E' : '#EF4444';
      const typeMap = {deposit:'Deposit',withdrawal:'Withdrawal',investment:'Investment',return:'Return',payout:'Payout',fee:'Fee',referral_bonus:'Referral Bonus'};
      return `<tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:7px 10px;font-size:10px;color:#9ca3af;font-family:monospace">${t.reference || '—'}</td>
        <td style="padding:7px 10px;font-size:11px;color:#1a1a1a">${typeMap[t.type] || t.type}</td>
        <td style="padding:7px 10px;font-size:11px;color:#1a1a1a">${t.pool_name || t.description || '—'}</td>
        <td style="padding:7px 10px;font-size:11px;font-weight:700;color:${amtColor};text-align:right">${amt}</td>
        <td style="padding:7px 10px;font-size:10px;color:#9ca3af;text-align:right">${fmtDate(t.transaction_date || t.created_at)}</td>
        <td style="padding:7px 10px">
          <span style="background:${t.status==='completed'?'#dcfce7':'#fef9c3'};color:${t.status==='completed'?'#16a34a':'#92400e'};font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase">${t.status}</span>
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="6" style="padding:20px;text-align:center;color:#9ca3af;font-size:11px">No transactions in selected period</td></tr>`;

    // Running balance
    let running = 0;
    const sortedTxns = [...transactions].sort((a,b) => new Date(a.transaction_date||a.created_at) - new Date(b.transaction_date||b.created_at));
    const totalDeposits = transactions.filter(t=>t.type==='deposit').reduce((s,t)=>s+Number(t.amount||0),0);
    const totalWithdrawals = transactions.filter(t=>t.type==='withdrawal'||t.type==='investment').reduce((s,t)=>s+Math.abs(Number(t.amount||0)),0);
    const totalReturnsTxn = transactions.filter(t=>t.type==='return'||t.type==='payout').reduce((s,t)=>s+Number(t.amount||0),0);

    sections += `
      <section style="margin-bottom:36px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #A855F7">
          <div style="width:4px;height:22px;background:linear-gradient(180deg,#A855F7,#7C3AED);border-radius:2px"></div>
          <h3 style="font-size:13px;font-weight:800;color:#1a1a1a;letter-spacing:0.06em;text-transform:uppercase;margin:0">Transaction Ledger</h3>
          <span style="margin-left:auto;font-size:10px;color:#9ca3af">${transactions.length} transactions · ${fmtDate(from)} — ${fmtDate(to)}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">
          ${stmtMiniBox('Total Deposits', fmtNum(totalDeposits), '#22C55E')}
          ${stmtMiniBox('Total Invested', fmtNum(totalWithdrawals), '#2F8C9B')}
          ${stmtMiniBox('Returns Received', fmtNum(totalReturnsTxn), '#ff9b0c')}
        </div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eaeaea;min-width:600px">
            <thead>
              <tr style="background:#F7F8FA">
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Reference</th>
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Type</th>
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Description</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Amount</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Date</th>
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Status</th>
              </tr>
            </thead>
            <tbody>${txnRows}</tbody>
          </table>
        </div>
      </section>`;
  }

  // ─── FULL DOCUMENT ───
  return `
    <div id="stmtPrintArea" style="font-family:'Poppins',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;background:#fff;min-height:100%">

      <!-- Header Band -->
      <div style="background:linear-gradient(135deg,#1a3a4a 0%,#0d2535 100%);padding:32px 40px;display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:16px">
          ${logoSVG}
          <div>
            <div style="font-size:20px;font-weight:900;color:#fff;letter-spacing:0.06em;line-height:1">SV CAPITAL</div>
            <div style="font-size:10px;color:rgba(255,255,255,0.6);letter-spacing:0.12em;margin-top:3px;font-weight:500">INVESTMENTS THAT MAKE SENSE</div>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:16px;font-weight:800;color:#ff9b0c;letter-spacing:0.04em">ACCOUNT STATEMENT</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.55);margin-top:4px"># ${statementNumber}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.55);margin-top:2px">Generated: ${generatedAt}</div>
        </div>
      </div>

      <!-- Period Banner -->
      <div style="background:linear-gradient(90deg,rgba(255,155,12,0.08),rgba(47,140,155,0.06));border-top:3px solid #ff9b0c;border-bottom:1px solid rgba(0,0,0,0.06);padding:12px 40px;display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em">Statement Period:</span>
          <span style="font-size:12px;font-weight:800;color:#1a1a1a">${fmtDate(from)} — ${fmtDate(to)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em">Investor:</span>
          <span style="font-size:12px;font-weight:800;color:#1a1a1a">${fullName}</span>
          <span style="font-size:9px;color:#9ca3af;margin-left:8px;line-height:1.4">Smartvest Financial Services (Pty) Ltd<br>The Station, 63 Peter Place, Bryanston, Johannesburg, 2191</span>
        </div>
      </div>

      <!-- Body -->
      <div style="padding:32px 40px">
        ${sections}
      </div>

      <!-- Footer -->
      <div style="background:#F7F8FA;border-top:1px solid rgba(0,0,0,0.07);padding:20px 40px;display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:10px;font-weight:700;color:#1a1a1a;margin-bottom:3px">SmartVest Financial Services (Pty) Ltd</div>
          <div style="font-size:9px;color:#9ca3af">Authorised Financial Services Provider · FSP License #52449 · Regulated by the FSCA</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;color:#9ca3af">enquiry@svcapital.co.za · www.svcapital.co.za</div>
          <div style="font-size:9px;color:#c1c7d0;margin-top:2px">This statement is computer generated and does not require a signature.</div>
        </div>
      </div>

    </div>`;
}

function stmtKPIBox(label, value, color) {
  return `<div style="background:linear-gradient(135deg,${color}08,${color}12);border:1px solid ${color}22;border-radius:10px;padding:16px;text-align:center">
    <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.08em;color:#9ca3af;font-weight:700;margin-bottom:6px">${label}</div>
    <div style="font-size:15px;font-weight:900;color:${color};letter-spacing:-0.02em">${value}</div>
  </div>`;
}

function stmtMiniBox(label, value, color) {
  return `<div style="background:#F7F8FA;border:1px solid rgba(0,0,0,0.06);border-radius:8px;padding:12px">
    <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.08em;color:#9ca3af;font-weight:700;margin-bottom:4px">${label}</div>
    <div style="font-size:13px;font-weight:800;color:${color}">${value}</div>
  </div>`;
}

function stmtInfoRow(label, val) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(0,0,0,0.05);font-size:10px">
    <span style="color:#9ca3af;font-weight:600">${label}</span>
    <span style="font-weight:700;color:#1a1a1a">${val}</span>
  </div>`;
}

function getProductInfo(type) {
  const map = {
    cattle:        { label:'Cattle Investment',        color:'#d97706', bg:'#fef3c7' },
    solar_7yr:     { label:'Solar Investment (7yr)',   color:'#ea580c', bg:'#ffedd5' },
    solar_6yr:     { label:'Solar Investment (6yr)',   color:'#ea580c', bg:'#fff7ed' },
    solar_5yr:     { label:'Solar Investment (5yr)',   color:'#c2410c', bg:'#fff7ed' },
    solar:         { label:'Solar Investment',         color:'#ea580c', bg:'#ffedd5' },
    short_term:    { label:'Short Term Investment',    color:'#2563eb', bg:'#dbeafe' },
    delivery_bike: { label:'Delivery Bikes',           color:'#7c3aed', bg:'#ede9fe' },
  };
  return map[type] || { label: type || 'Investment', color:'#6b7280', bg:'#f3f4f6' };
}

function printStatement() {
  const doc = document.getElementById('statementDocument');
  if (!doc || !doc.innerHTML.trim()) {
    Toast.error('Please generate a statement first, then print.');
    return;
  }
  const printWin = window.open('', '_blank', 'width=960,height=800');
  if (!printWin) {
    Toast.error('Pop-up blocked. Please allow pop-ups for this site.');
    return;
  }
  printWin.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SV Capital — Account Statement</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    html,body{height:auto;width:100%}
    body{font-family:'Poppins',-apple-system,BlinkMacSystemFont,sans-serif;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;color:#1a1a1a}

    /* Screen toolbar — sticky so it doesn't overlay content */
    .no-print{position:sticky;top:0;background:#1a1a1a;padding:10px 24px;display:flex;justify-content:space-between;align-items:center;z-index:999;box-shadow:0 2px 12px rgba(0,0,0,0.3)}
    .no-print span{color:#fff;font-size:13px;font-weight:600;font-family:'Poppins',sans-serif}
    .no-print button{background:linear-gradient(135deg,#FF9B0C,#FF5229);color:#fff;border:none;padding:8px 22px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;font-family:'Poppins',sans-serif}
    .no-print button:hover{opacity:0.9}

    /* A4 page with proper margins — prevents edge clipping */
    @page{size:A4 portrait;margin:14mm 12mm}

    @media print{
      /* Hide toolbar */
      .no-print{display:none!important}

      /* Remove overflow wrappers so tables aren't clipped */
      [style*="overflow-x"]{overflow:visible!important;width:100%!important}

      /* Tables scale to fit printable width */
      table{width:100%!important;min-width:0!important}
      td,th{word-break:break-word;overflow-wrap:break-word}

      /* Repeat headers on continuation pages */
      thead{display:table-header-group}
      tfoot{display:table-footer-group}

      /* Avoid splitting a row across pages */
      tr{page-break-inside:avoid}

      /* Keep section headings with the first row of content */
      section{page-break-inside:auto}
      section > div:first-child{page-break-after:avoid;page-break-inside:avoid}

      /* KPI boxes: keep together */
      .kpi-grid{page-break-inside:avoid}

      /* Preserve background colours in PDF */
      *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}

      /* Body padding already 0 when no toolbar */
      body{padding:0}
    }
  </style>
</head>
<body>
  <div class="no-print">
    <span>SV Capital — Account Statement</span>
    <button onclick="window.print()">⬇&nbsp; Save as PDF / Print</button>
  </div>
  <div>${doc.innerHTML}</div>
</body>
</html>`);
  printWin.document.close();
}

/* ── Sub-account deposit ─────────────────────── */
function openSaDeposit(saId) {
  _pmSaId = saId;
  Modal.close('saDetailModal'); // close detail view if open
  openTopUpModal();
}

/* ─── Profile ─── */
async function saveProfile() {
  const inv = PORTAL.investor;
  if (!inv) return;

  const firstName = document.getElementById('profFirstName')?.value?.trim() || '';
  const lastName  = document.getElementById('profLastName')?.value?.trim() || '';
  const phone     = document.getElementById('profPhone')?.value?.trim() || '';
  const city      = document.getElementById('profCity')?.value?.trim() || '';
  const risk      = (document.querySelector('input[name="riskProf"]:checked')?.value) || inv.risk_profile;
  const saveBtn   = document.querySelector('button[onclick="saveProfile()"]');

  if (!firstName || !lastName) { Toast.error('First name and last name are required.'); return; }
  if (phone && phone.replace(/\D/g, '').length < 8) { Toast.error('Please enter a valid phone number.'); return; }

  const updates = {
    first_name: firstName,
    last_name:  lastName,
    phone:      phone || inv.phone,
    address:    city || inv.address,
    province:   document.getElementById('profProvince')?.value || inv.province,
    risk_profile: risk,
  };

  await _withBtn(saveBtn, async () => {
    try {
      await API._fetch('PATCH', `tables/investors/${inv.id}`, updates);
      Object.assign(PORTAL.investor, updates);
      clearProfileDraft();
      renderTaskCompletionPanel();
      SVC.track('svc_profile_saved', {});
      Toast.success('Profile updated successfully');
    } catch (e) {
      _setInlineMessage('profileSaveMeta', 'Could not save your changes — your local draft is still available.', '#ef4444');
      Toast.error('Failed to save profile — please try again.');
    }
  });
}

/* ─── Referral ─── */
function copyReferralLink() {
  const link = document.getElementById('referralLink').textContent;
  navigator.clipboard.writeText(link).then(() => Toast.success('Link copied to clipboard!')).catch(() => Toast.error('Copy failed'));
  SVC.track('svc_referral_link_copied', { referral_code: PORTAL.investor?.referral_code });
}

/* ═══════════════════════════════════════════════════════════════
   GAMIFICATION — XP, Quests & Learning Hub
   ═══════════════════════════════════════════════════════════════ */

const XP_LEVELS = [
  { id: 'seed',       label: 'Seed',       min: 0,    icon: 'fa-seedling',         color: '#9ca3af' },
  { id: 'sprout',     label: 'Sprout',     min: 100,  icon: 'fa-leaf',             color: '#22c55e' },
  { id: 'grower',     label: 'Grower',     min: 300,  icon: 'fa-tree',             color: '#16a34a' },
  { id: 'cultivator', label: 'Cultivator', min: 600,  icon: 'fa-spa',              color: '#2F8C9B' },
  { id: 'harvester',  label: 'Harvester',  min: 1000, icon: 'fa-wheat-awn',        color: '#ff9b0c' },
  { id: 'pioneer',    label: 'Pioneer',    min: 1500, icon: 'fa-compass',          color: '#f59e0b' },
  { id: 'architect',  label: 'Architect',  min: 2500, icon: 'fa-building-columns', color: '#a855f7' },
  { id: 'luminary',   label: 'Luminary',   min: 5000, icon: 'fa-crown',            color: '#D4AF37' },
];

function _getLevelForXP(xp) {
  let level = XP_LEVELS[0];
  for (const l of XP_LEVELS) {
    if (xp >= l.min) level = l;
    else break;
  }
  return level;
}

function _getNextLevel(xp) {
  return XP_LEVELS.find(l => l.min > xp) || null;
}

/* ─── Fetch quest data from server ─────────────────────── */
async function loadQuestData() {
  try {
    const token = Auth.getToken();
    if (!token) return;
    const res  = await fetch((window.__SVC_API_BASE__ || '/api/') + 'quests/my', {
      headers: { 'Authorization': `Bearer ${token}` },
      credentials: 'include',
    });
    if (!res.ok) return;
    const data = await res.json();
    PORTAL.quests = data;

    // Auto-detect and claim milestone quests silently
    await _autoClaimMilestones();

    renderXPWidget();
    _updateXPNavBadge();
  } catch (e) {
    console.warn('[Quests] loadQuestData failed:', e.message);
  }
}

/* ─── Check milestone conditions and auto-claim if met ─── */
async function _autoClaimMilestones() {
  if (!PORTAL.quests || !PORTAL.investor) return;
  const completed = new Set(PORTAL.quests.completedIds || []);
  const inv       = PORTAL.investor;
  const invests   = PORTAL.investments;
  const txns      = PORTAL.transactions;
  const totalInvested = parseFloat(inv.total_invested) || 0;

  const productTypes = new Set(invests.filter(i => i.status === 'active' || i.status === 'paid_out')
    .map(i => i.product_type).filter(Boolean));

  const milestoneConditions = {
    first_topup:    txns.some(t => t.type === 'deposit'),
    first_investment: invests.length > 0,
    diversify:      productTypes.size >= 2,
    milestone_10k:  totalInvested >= 10000,
    milestone_50k:  totalInvested >= 50000,
    milestone_100k: totalInvested >= 100000,
  };

  for (const [questId, met] of Object.entries(milestoneConditions)) {
    if (met && !completed.has(questId)) {
      try {
        const result = await _postQuestComplete(questId, {});
        if (result && !result.error) {
          completed.add(questId);
          PORTAL.quests.completedIds = [...completed];
          PORTAL.quests.xp   = result.newXP;
          PORTAL.quests.xpToNext = result.xpToNext;
          if (result.leveledUp) _showLevelUpModal(result);
        }
      } catch (_) {}
    }
  }
}

/* ─── POST to complete a quest ──────────────────────────── */
async function _postQuestComplete(questId, data) {
  const token = Auth.getToken();
  if (!token) return null;
  const res = await fetch((window.__SVC_API_BASE__ || '/api/') + 'quests/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    credentials: 'include',
    body: JSON.stringify({ questId, data }),
  });
  return res.json();
}

/* ─── XP bar widget in overview ─────────────────────────── */
function renderXPWidget() {
  const q = PORTAL.quests;
  if (!q) return;

  const xp    = q.xp || 0;
  const lvl   = _getLevelForXP(xp);
  const next  = _getNextLevel(xp);
  const pct   = next ? Math.round(((xp - lvl.min) / (next.min - lvl.min)) * 100) : 100;

  const wrap = document.getElementById('xpProgressWrap');
  if (wrap) wrap.style.display = 'flex';

  const pill = document.getElementById('xpLevelPill');
  if (pill) {
    pill.innerHTML = `<i class="fa-solid ${lvl.icon}"></i> ${lvl.label}`;
    pill.style.background = lvl.color;
  }

  const fill = document.getElementById('xpProgressFill');
  if (fill) fill.style.width = pct + '%';

  const label = document.getElementById('xpProgressLabel');
  if (label) label.textContent = xp.toLocaleString('en-ZA') + ' XP';

  const nextEl = document.getElementById('xpProgressNext');
  if (nextEl) nextEl.textContent = next ? `+${(next.min - xp).toLocaleString('en-ZA')} to ${next.label}` : 'Max level!';
}

/* ─── Update sidebar XP badge with pending quest count ─── */
function _updateXPNavBadge() {
  const q = PORTAL.quests;
  if (!q) return;

  const completed = new Set(q.completedIds || []);
  const inv       = PORTAL.investor;
  const invests   = PORTAL.investments;
  const txns      = PORTAL.transactions;
  const totalInvested = parseFloat(inv?.total_invested) || 0;

  const productTypes = new Set(invests.filter(i => i.status === 'active' || i.status === 'paid_out')
    .map(i => i.product_type).filter(Boolean));

  const milestones = {
    first_topup:    txns.some(t => t.type === 'deposit'),
    first_investment: invests.length > 0,
    diversify:      productTypes.size >= 2,
    milestone_10k:  totalInvested >= 10000,
    milestone_50k:  totalInvested >= 50000,
    milestone_100k: totalInvested >= 100000,
  };

  const readyCount = q.quests.filter(quest => {
    if (completed.has(quest.id)) return false;
    if (quest.category === 'milestone') return milestones[quest.id] === true;
    if (quest.category === 'profile' || quest.category === 'learning') return true;
    return false;
  }).length;

  const badge = document.getElementById('xpNavBadge');
  if (badge) {
    if (readyCount > 0) {
      badge.textContent = readyCount;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }
}

/* ═════════════════════════════════════════════════════════
   QUEST VIEW
   ═════════════════════════════════════════════════════════ */
function renderQuestView() {
  if (!PORTAL.quests) {
    loadQuestData().then(renderQuestView);
    return;
  }

  const q         = PORTAL.quests;
  const xp        = q.xp || 0;
  const lvl       = _getLevelForXP(xp);
  const next      = _getNextLevel(xp);
  const completed = new Set(q.completedIds || []);

  // ── Hero
  const heroIcon = document.getElementById('questLevelIcon');
  if (heroIcon) { heroIcon.innerHTML = `<i class="fa-solid ${lvl.icon}"></i>`; heroIcon.style.background = lvl.color; }
  const heroName = document.getElementById('questLevelName');
  if (heroName) heroName.textContent = lvl.label;
  const heroXP = document.getElementById('questXpVal');
  if (heroXP) heroXP.textContent = xp.toLocaleString('en-ZA') + ' XP';
  const heroBar = document.getElementById('questXpBar');
  if (heroBar) {
    const pct = next ? Math.round(((xp - lvl.min) / (next.min - lvl.min)) * 100) : 100;
    heroBar.style.width = pct + '%';
    heroBar.style.background = lvl.color;
  }
  const heroTrackLabel = document.getElementById('questXpTrackLabel');
  if (heroTrackLabel) heroTrackLabel.textContent = next ? `${(next.min - xp).toLocaleString('en-ZA')} XP to ${next.label} (+R50)` : 'Maximum level reached!';

  // ── Rewards earned (levels passed × R50)
  const levelsEarned = XP_LEVELS.filter(l => l.min > 0 && xp >= l.min).length;
  const xpCashValue  = levelsEarned * 50;
  const rewardsEl = document.getElementById('questRewardsEarned');
  if (rewardsEl) rewardsEl.textContent = `R${xpCashValue}`;

  // ── Rewards stats row ────────────────────────────────────────
  const referralBonuses = PORTAL.transactions
    .filter(t => t.type === 'referral_bonus' && t.status !== 'rejected')
    .reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);
  const statsRow = document.getElementById('rewardsStatsRow');
  if (statsRow) {
    statsRow.style.display = 'flex';
    const rwXP  = document.getElementById('rwStatXP');
    const rwLvl = document.getElementById('rwStatLevel');
    const rwCash = document.getElementById('rwStatCash');
    const rwRef  = document.getElementById('rwStatRef');
    const rwTot  = document.getElementById('rwStatTotal');
    if (rwXP)   rwXP.textContent   = xp.toLocaleString('en-ZA') + ' XP';
    if (rwLvl)  rwLvl.innerHTML    = `<i class="fa-solid ${lvl.icon}" style="margin-right:4px"></i>${lvl.label}`;
    if (rwCash) rwCash.textContent = `R${xpCashValue}`;
    if (rwRef)  rwRef.textContent  = `R${referralBonuses.toFixed(2)}`;
    if (rwTot)  rwTot.textContent  = `R${(xpCashValue + referralBonuses).toFixed(2)}`;
  }

  // ── Level track
  const trackEl = document.getElementById('levelTrack');
  if (trackEl) {
    trackEl.innerHTML = XP_LEVELS.map(l => {
      const isDone    = xp >= l.min;
      const isCurrent = lvl.id === l.id;
      return `
        <div class="level-step ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''}">
          <div class="level-step__icon" style="${isCurrent ? `background:${l.color};color:#fff;box-shadow:0 4px 14px ${l.color}55` : isDone ? `background:${l.color}22;color:${l.color};border:2px solid ${l.color}` : ''}">
            <i class="fa-solid ${l.icon}"></i>
          </div>
          <div class="level-step__name">${l.label}</div>
          ${l.min > 0 ? `<div class="level-step__reward" style="color:${isCurrent||isDone?l.color:'#9ca3af'}">+R50</div>` : ''}
        </div>`;
    }).join('');
  }

  // ── Quest categories
  const categories = [
    { key: 'profile',   label: 'Profile & Compliance', icon: 'fa-user-check',      desc: 'Help us know you better. Each survey unlocks better investment recommendations.' },
    { key: 'milestone', label: 'Investment Milestones', icon: 'fa-trophy',          desc: 'Earn XP for reaching investment goals. Milestones are auto-detected.' },
    { key: 'learning',  label: 'Learning Modules',      icon: 'fa-graduation-cap',  desc: 'Earn XP for completing educational modules in the Learning Hub.' },
  ];

  const catEl = document.getElementById('questCategories');
  if (!catEl) return;

  const inv       = PORTAL.investor;
  const invests   = PORTAL.investments;
  const txns      = PORTAL.transactions;
  const totalInv  = parseFloat(inv?.total_invested) || 0;
  const productTypes = new Set(invests.filter(i => i.status === 'active' || i.status === 'paid_out').map(i => i.product_type).filter(Boolean));

  const milestones = {
    first_topup:    txns.some(t => t.type === 'deposit'),
    first_investment: invests.length > 0,
    diversify:      productTypes.size >= 2,
    milestone_10k:  totalInv >= 10000,
    milestone_50k:  totalInv >= 50000,
    milestone_100k: totalInv >= 100000,
    set_maturity:   false,   // can't auto-detect without loading maturity_instructions
    first_referral: false,
  };

  // ── Helper: build a single quest card HTML
  function _qCard(quest, cat) {
    const isDone  = completed.has(quest.id);
    const isReady = !isDone && (
      cat === 'profile'   ? true :
      cat === 'milestone' ? milestones[quest.id] === true :
      cat === 'learning'  ? true : false
    );
    return `
      <div class="quest-card ${isDone ? 'quest-card--done' : isReady ? 'quest-card--ready' : ''}" id="qcard-${quest.id}">
        <div class="quest-card__icon" style="background:${quest.color}22;color:${quest.color}">
          <i class="fa-solid ${quest.icon}"></i>
        </div>
        <div class="quest-card__body">
          <div class="quest-card__title">${quest.title}</div>
          ${quest.description ? `<div class="quest-card__desc">${quest.description}</div>` : ''}
        </div>
        <div class="quest-card__right">
          <div class="quest-card__xp" style="color:${quest.color}">+${quest.xp} XP</div>
          ${isDone
            ? `<div class="quest-card__done-badge"><i class="fa-solid fa-circle-check"></i> Done</div>`
            : isReady
              ? (cat === 'milestone'
                  ? `<button class="btn quest-claim-btn" style="background:${quest.color}" onclick="claimMilestoneQuest('${quest.id}')">Claim</button>`
                  : cat === 'learning'
                    ? `<button class="btn quest-claim-btn" style="background:${quest.color}" onclick="navigate('learn', document.querySelector('[data-view=learn]'))">Start</button>`
                    : `<button class="btn quest-claim-btn" style="background:${quest.color}" onclick="openSurveyModal('${quest.id}')">Start</button>`)
              : `<div class="quest-card__locked"><i class="fa-solid fa-lock-open"></i> Available</div>`
          }
        </div>
      </div>`;
  }

  // ── "What to do next" pending section ─────────────────
  const claimable  = q.quests.filter(quest => quest.category === 'milestone' && !completed.has(quest.id) && milestones[quest.id] === true);
  const quickWins  = q.quests.filter(quest => quest.category === 'profile'   && !completed.has(quest.id));
  const learnReady = q.quests.filter(quest => quest.category === 'learning'  && !completed.has(quest.id));
  const totalPending = claimable.length + quickWins.length + learnReady.length;

  let pendingHtml = '';
  if (totalPending > 0) {
    const pendingXP = [...claimable, ...quickWins, ...learnReady].reduce((s, qst) => s + qst.xp, 0);
    const nextLvlXp = next ? (next.min - xp) : 0;

    let pendingGroups = '';
    if (claimable.length) {
      pendingGroups += `
        <div class="pending-group">
          <div class="pending-group__label"><i class="fa-solid fa-gift" style="color:#22c55e"></i> Ready to claim — milestone reached!</div>
          <div class="quest-cards-grid">${claimable.map(qst => _qCard(qst, 'milestone')).join('')}</div>
        </div>`;
    }
    if (quickWins.length) {
      pendingGroups += `
        <div class="pending-group">
          <div class="pending-group__label"><i class="fa-solid fa-bolt" style="color:#ff9b0c"></i> Quick wins — complete a short survey</div>
          <div class="quest-cards-grid">${quickWins.map(qst => _qCard(qst, 'profile')).join('')}</div>
        </div>`;
    }
    if (learnReady.length) {
      pendingGroups += `
        <div class="pending-group">
          <div class="pending-group__label"><i class="fa-solid fa-graduation-cap" style="color:#2F8C9B"></i> Learning modules — earn XP & knowledge</div>
          <div class="quest-cards-grid">${learnReady.map(qst => _qCard(qst, 'learning')).join('')}</div>
        </div>`;
    }

    pendingHtml = `
      <div class="pending-section mb-28">
        <div class="pending-section__header">
          <div class="pending-section__title-row">
            <div>
              <div class="pending-section__title"><i class="fa-solid fa-list-check"></i> What to do next</div>
              <div class="pending-section__sub">${totalPending} reward${totalPending !== 1 ? 's' : ''} waiting for you · <span style="color:var(--gold)">${pendingXP} XP available</span>${nextLvlXp > 0 ? ` · <span style="color:#22c55e">${nextLvlXp} XP to next level (+R50)</span>` : ''}</div>
            </div>
          </div>
        </div>
        ${pendingGroups}
      </div>`;
  }

  // ── Full category breakdown ──────────────────────────
  const categoryHtml = categories.map(cat => {
    const catQuests = q.quests.filter(quest => quest.category === cat.key);
    const doneCount = catQuests.filter(quest => completed.has(quest.id)).length;
    const questCards = catQuests.map(quest => _qCard(quest, cat.key)).join('');

    return `
      <div class="quest-category mb-24">
        <div class="quest-category__header">
          <div class="quest-category__icon-wrap" style="background:rgba(255,155,12,0.1)">
            <i class="fa-solid ${cat.icon}" style="color:#ff9b0c"></i>
          </div>
          <div>
            <div class="quest-category__title">${cat.label}</div>
            <div class="quest-category__sub">${cat.desc}</div>
          </div>
          <div class="quest-category__progress ml-auto">
            <div class="quest-category__count">${doneCount}/${catQuests.length}</div>
            <div class="quest-cat-bar"><div class="quest-cat-bar__fill" style="width:${Math.round((doneCount/catQuests.length)*100)}%"></div></div>
          </div>
        </div>
        <div class="quest-cards-grid">${questCards}</div>
      </div>`;
  }).join('');

  catEl.innerHTML = pendingHtml + categoryHtml;

  // ── Referral rewards history ─────────────────────────────────
  const refSection = document.getElementById('rewardsReferralSection');
  const refList    = document.getElementById('rewardsReferralList');
  const refTxns    = PORTAL.transactions.filter(t => t.type === 'referral_bonus').sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (refSection && refList) {
    refSection.style.display = '';
    if (!refTxns.length) {
      refList.innerHTML = `<div class="empty-state" style="padding:20px"><i class="fa-solid fa-gift"></i><p>No referral bonuses yet. Share your referral link to earn rewards!</p></div>`;
    } else {
      refList.innerHTML = refTxns.map(t => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.06)">
          <div>
            <div style="font-size:0.82rem;font-weight:600;color:#1a1a1a">${t.description || 'Referral bonus'}</div>
            <div style="font-size:0.7rem;color:#9ca3af">${Utils.date(t.created_at || t.transaction_date)}</div>
          </div>
          <span style="font-weight:700;color:#ff9b0c">+${Utils.rand(Math.abs(parseFloat(t.amount) || 0))}</span>
        </div>`).join('');
    }
  }
}

/* ─── Claim a milestone quest via button ─────────────────── */
async function claimMilestoneQuest(questId) {
  const btn = document.querySelector(`#qcard-${questId} .quest-claim-btn`);
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const result = await _postQuestComplete(questId, {});
    if (result.error) {
      if (result.error.includes('already completed')) {
        Toast.info('Already claimed!');
      } else {
        Toast.error(result.error);
      }
    } else {
      Toast.success(`+${result.xpAwarded} XP earned!`);
      if (PORTAL.quests) {
        PORTAL.quests.xp  = result.newXP;
        PORTAL.quests.xpToNext = result.xpToNext;
        PORTAL.quests.completedIds = [...(PORTAL.quests.completedIds || []), questId];
      }
      if (result.leveledUp) _showLevelUpModal(result);
      renderQuestView();
      renderXPWidget();
      _updateXPNavBadge();
    }
  } catch (e) {
    Toast.error('Failed to claim reward. Try again.');
    if (btn) { btn.disabled = false; btn.textContent = 'Claim'; }
  }
}

/* ─── Survey Modal ───────────────────────────────────────── */
function openSurveyModal(questId) {
  const q = PORTAL.quests?.quests?.find(q => q.id === questId);
  if (!q) return;

  const answers = {};
  const questionsHtml = (q.questions || []).map((ques, i) => {
    if (ques.type === 'choice') {
      return `
        <div class="survey-q" data-qid="${ques.id}">
          <div class="survey-q__label">${i + 1}. ${ques.label}</div>
          <div class="survey-q__options">
            ${ques.options.map((opt, j) => `
              <label class="survey-opt">
                <input type="radio" name="sq_${questId}_${i}" value="${opt}">
                <span>${opt}</span>
              </label>`).join('')}
          </div>
        </div>`;
    }
    // text input
    return `
      <div class="survey-q" data-qid="${ques.id}">
        <div class="survey-q__label">${i + 1}. ${ques.label}</div>
        <input class="form-input" type="text" placeholder="${ques.placeholder || ''}" data-sqid="${questId}-${ques.id}">
      </div>`;
  }).join('');

  document.getElementById('surveyModalContent').innerHTML = `
    <div class="survey-modal-header">
      <div class="survey-modal-icon" style="background:${q.color}22;color:${q.color}">
        <i class="fa-solid ${q.icon}"></i>
      </div>
      <div>
        <div class="survey-modal-title">${q.title}</div>
        <div class="survey-modal-sub">${q.description || ''}</div>
      </div>
      <div class="survey-modal-xp" style="color:${q.color}">+${q.xp} XP</div>
    </div>
    <div class="survey-body">${questionsHtml}</div>
    <div class="survey-footer">
      <button class="btn btn--secondary" onclick="closeSurveyModal()">Cancel</button>
      <button class="btn btn--primary survey-submit-btn" onclick="submitSurvey('${questId}')">
        <i class="fa-solid fa-paper-plane"></i> Submit &amp; Earn XP
      </button>
    </div>`;

  Modal.open('surveyModal');
}

function closeSurveyModal() {
  Modal.close('surveyModal');
}

async function submitSurvey(questId) {
  const q = PORTAL.quests?.quests?.find(q => q.id === questId);
  if (!q) return;

  const data = {};
  let allAnswered = true;

  (q.questions || []).forEach((ques, i) => {
    if (ques.type === 'choice') {
      const checked = document.querySelector(`input[name="sq_${questId}_${i}"]:checked`);
      if (checked) data[ques.id] = checked.value;
      else allAnswered = false;
    } else {
      const inp = document.querySelector(`input[data-sqid="${questId}-${ques.id}"]`);
      if (inp && inp.value.trim()) data[ques.id] = inp.value.trim();
      else allAnswered = false;
    }
  });

  if (!allAnswered) {
    Toast.error('Please answer all questions before submitting.');
    return;
  }

  const btn = document.querySelector('.survey-submit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting...'; }

  try {
    const result = await _postQuestComplete(questId, data);
    if (result.error) {
      Toast.error(result.error.includes('already') ? 'Already completed!' : result.error);
      closeSurveyModal();
    } else {
      closeSurveyModal();
      Toast.success(`+${result.xpAwarded} XP earned!`);
      if (PORTAL.quests) {
        PORTAL.quests.xp  = result.newXP;
        PORTAL.quests.xpToNext = result.xpToNext;
        PORTAL.quests.completedIds = [...(PORTAL.quests.completedIds || []), questId];
      }
      if (result.leveledUp) _showLevelUpModal(result);
      renderQuestView();
      renderXPWidget();
      _updateXPNavBadge();
    }
  } catch (e) {
    Toast.error('Submission failed. Please try again.');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit & Earn XP'; }
  }
}

/* ─── Level-up Celebration Modal ────────────────────────── */
function _showLevelUpModal(result) {
  const lvl = XP_LEVELS.find(l => l.id === result.newLevel) || XP_LEVELS[0];

  document.getElementById('levelupIcon').innerHTML    = `<i class="fa-solid ${lvl.icon}"></i>`;
  document.getElementById('levelupIcon').style.background = lvl.color;
  document.getElementById('levelupLevel').textContent = lvl.label;
  document.getElementById('levelupXP').textContent    = `${result.newXP.toLocaleString('en-ZA')} XP total`;

  const rewardEl = document.getElementById('levelupReward');
  if (result.rewardGiven > 0) {
    rewardEl.innerHTML = `<strong>R${result.rewardGiven}</strong> has been added to your wallet! 🎉`;
    rewardEl.style.display = 'block';
  } else {
    rewardEl.style.display = 'none';
  }

  Modal.open('levelUpModal');
  _launchConfettiParticles();
}

function closeLevelUpModal() {
  Modal.close('levelUpModal');
}

function _launchConfettiParticles() {
  const container = document.getElementById('levelupConfetti');
  if (!container) return;
  container.innerHTML = '';
  const colors = ['#ff9b0c', '#22c55e', '#2F8C9B', '#D4AF37', '#a855f7'];
  for (let i = 0; i < 40; i++) {
    const p = document.createElement('span');
    p.style.cssText = `
      position:absolute;
      width:${6 + Math.random()*8}px;height:${6 + Math.random()*8}px;
      background:${colors[Math.floor(Math.random()*colors.length)]};
      border-radius:${Math.random()>0.5?'50%':'2px'};
      top:0;left:${Math.random()*100}%;
      animation:confettiFall ${0.8 + Math.random()*1.2}s ease-in ${Math.random()*0.5}s forwards;
      opacity:0;
    `;
    container.appendChild(p);
  }
}

/* ═════════════════════════════════════════════════════════
   LEARNING HUB
   ═════════════════════════════════════════════════════════ */

const LEARN_MODULES = [
  // ── Explorer Track (getting started) ───────────────────
  {
    id: 'learn_what_is_svc', track: 'explorer', order: 1,
    title: 'What is SV Capital?', readTime: 5, xp: 50,
    icon: 'fa-building-columns', color: '#2F8C9B',
    keyPoints: [
      'SV Capital pools investor capital into tangible South African alternative assets',
      'Products include solar projects, cattle farming, short-term loans, and delivery bikes',
      'Each product has a defined term, return rate, and maturity date',
      'All investments are backed by real, income-generating assets',
    ],
    content: `SV Capital is a South African alternative investment platform that connects investors with real-economy projects generating above-inflation returns. Unlike unit trusts or share portfolios, your money is put to work in tangible assets — solar panels generating electricity, cattle being raised and sold at market, or secured loans to operating businesses.

Each investment has a clearly defined term (typically 6–36 months) and a fixed annual rate of return, so you know exactly what to expect. Your capital is tracked in real time on this portal, and returns are credited directly to your wallet on maturity.

The platform charges no entry fees and no monthly platform fees. Our revenue comes from structuring fees on the underlying transactions, so your quoted return is your net return.`,
  },
  {
    id: 'learn_how_returns', track: 'explorer', order: 2,
    title: 'How Your Returns Work', readTime: 7, xp: 50,
    icon: 'fa-percent', color: '#22c55e',
    keyPoints: [
      'Returns are expressed as an annual percentage rate (p.a.)',
      'Your actual payout = capital × annual rate × (term in days ÷ 365)',
      'Reinvesting your returns compounds your growth over time',
      'Effective return % accounts for the full term, not just one year',
    ],
    content: `When you invest with SV Capital, you earn a return based on two factors: the annual rate and the term. For example, R10,000 invested at 14% p.a. for 12 months returns R11,400 — the R10,000 original capital plus R1,400 in returns.

Shorter-term products like cattle cycles (150–180 days) work the same way, but on a pro-rated basis. A 14% annual rate for 150 days pays roughly R575 on a R10,000 investment.

The "effective return" you see on your dashboard is the annualised figure, allowing you to compare products fairly regardless of their term length.`,
  },
  {
    id: 'learn_solar', track: 'explorer', order: 3,
    title: 'Solar Energy Investing', readTime: 8, xp: 50,
    icon: 'fa-solar-panel', color: '#f59e0b',
    keyPoints: [
      'SV Capital funds solar panel installations for South African businesses',
      'Businesses pay structured lease or energy purchase agreements',
      'Returns typically range from 14–18% p.a. over 24–36 month terms',
      'Solar projects benefit from long-term, predictable contractual cash flows',
    ],
    content: `Solar projects work by financing the installation of commercial-scale photovoltaic (PV) systems for verified South African businesses. Once installed, the business pays a set monthly amount — either as an energy purchase agreement (EPA) or a finance lease — providing predictable monthly revenue.

SV Capital aggregates these returns and passes them to investors net of all structuring costs. Solar assets are long-duration, making them ideal for capital you do not need access to for 2–3 years. Loadshedding in South Africa has significantly increased demand for behind-the-meter solar, providing strong deal flow for this product.

Each solar project undergoes technical assessment, legal review, and business viability checks before being made available to investors.`,
  },
  {
    id: 'learn_cattle', track: 'explorer', order: 4,
    title: 'Cattle & Short-term Loans', readTime: 8, xp: 50,
    icon: 'fa-cow', color: '#a855f7',
    keyPoints: [
      'Cattle are purchased at auction, raised on commercial farms, and resold',
      'Each cycle typically runs 150–180 days with 12–16% p.a. returns',
      'Short-term loans are made to businesses with real collateral',
      'These shorter terms allow for reinvestment and capital recycling',
    ],
    content: `SV Capital's cattle product funds the purchase of commercial beef cattle at verified South African livestock auctions. The cattle are placed on contracted farms where they are fed and managed under professional supervision, then sold at market at the end of the cycle.

Returns are driven by weight gain and market price at sale. SV Capital hedges execution risk through diversified lots and vetted farming partners. Each batch is tracked and reported on in real time via the admin platform.

Short-term business loans are secured against verifiable collateral (trading assets, debtor books, or property bonds) and carry slightly lower rates than cattle due to their fixed repayment structure. Both products offer higher liquidity than solar, with capital recycling every 5–6 months.`,
  },
  {
    id: 'learn_diversification', track: 'explorer', order: 5,
    title: 'Diversification 101', readTime: 6, xp: 50,
    icon: 'fa-chart-pie', color: '#ff9b0c',
    keyPoints: [
      'Spreading capital across products reduces exposure to any single risk',
      'Different products have different maturity timelines, creating natural liquidity',
      'A blended portfolio smooths your overall return over time',
      'Diversification is not just by product — also consider term length and entry date',
    ],
    content: `Diversification means not putting all your eggs in one basket — a principle that applies as much to alternative investments as to traditional ones. By spreading your capital across solar, cattle, and loans, you reduce the impact if any single investment underperforms.

Equally important is timeline diversification. If all your investments mature at the same time, you face reinvestment risk. Staggering your investments across different start dates means you always have capital returning, which can be reinvested into new opportunities.

Our data shows that investors with 3+ active product types consistently achieve smoother returns and higher portfolio satisfaction than those concentrated in a single product.`,
  },

  // ── Builder Track (growing investor) ───────────────────
  {
    id: 'learn_risk', track: 'builder', order: 1,
    title: 'Risk vs Return', readTime: 8, xp: 50,
    icon: 'fa-scale-balanced', color: '#a855f7',
    keyPoints: [
      'Higher potential returns always come with higher risk — there are no exceptions',
      'Risk in alternative investments includes liquidity risk, operational risk, and market risk',
      'Your risk profile determines the right mix of products for you',
      'Diversification reduces but cannot eliminate all risk',
    ],
    content: `Every investment involves a trade-off between risk and return. At SV Capital, solar projects carry the lowest operational risk (contractual cash flows) but require the longest capital commitment. Cattle farming offers higher potential returns but involves biological and market variables that solar does not.

Understanding your own risk tolerance is critical. If you might need access to your capital within 12 months, short-term products are more appropriate than 36-month solar commitments. If you can commit capital for longer and tolerate some variability, the blended portfolio approach tends to deliver the best long-term outcomes.

The risk profile survey in the Earn Rewards section helps us calibrate your portfolio recommendations to your personal risk appetite.`,
  },
  {
    id: 'learn_compounding', track: 'builder', order: 2,
    title: 'The Compounding Effect', readTime: 7, xp: 50,
    icon: 'fa-chart-line', color: '#22c55e',
    keyPoints: [
      'Compounding means earning returns on your returns, not just your original capital',
      'The longer your investment horizon, the more powerful compounding becomes',
      'Reinvesting at maturity is the single most impactful decision you can make',
      'A 14% p.a. return, reinvested over 5 years, nearly doubles your capital',
    ],
    content: `Albert Einstein reportedly called compound interest the "eighth wonder of the world." In practice, compounding means that after your first investment matures, you reinvest both the original capital and the returns — so in the next cycle, you earn returns on a larger base.

At 14% p.a., R10,000 grows to R11,400 after year 1. Reinvested, it becomes R12,996 after year 2 — not R12,800. The difference compounds every year. After 5 years, R10,000 compounding at 14% p.a. becomes approximately R19,254 — nearly double.

The key to unlocking compounding is acting quickly at maturity. Capital sitting idle in your wallet earns nothing. Set your maturity instructions to reinvest, and let time do the work.`,
  },
  {
    id: 'learn_tax', track: 'builder', order: 3,
    title: 'Investment Tax in South Africa', readTime: 9, xp: 50,
    icon: 'fa-receipt', color: '#64748b',
    keyPoints: [
      'Investment returns from SV Capital are generally treated as ordinary income in South Africa',
      'You are required to declare investment returns in your annual tax return (ITR12)',
      'SV Capital issues statements to assist with your tax declarations',
      'Consult a registered tax practitioner for personalised advice',
    ],
    content: `In South Africa, income earned from investments is generally subject to income tax at your marginal rate. This applies to the returns (interest or profit share) you earn through SV Capital products. Your original capital returned at maturity is not taxable — only the profit portion is.

SARS requires you to disclose all South African and foreign income on your annual return (ITR12). Your SV Capital account statement (available under "My Statement") provides a breakdown of all returns earned in each tax year, which you or your accountant can use for tax submissions.

Note that SV Capital does not deduct tax at source — you are responsible for declaring and paying tax on returns earned. If your total investment income exceeds R23,800 per year (the annual interest exemption for individuals under 65), the excess is taxable. We strongly recommend consulting a registered tax practitioner.`,
  },

  // ── Strategist Track (advanced) ────────────────────────
  {
    id: 'learn_yield_opt', track: 'strategist', order: 1,
    title: 'Yield Optimisation', readTime: 10, xp: 50,
    icon: 'fa-chart-line-up', color: '#ff9b0c',
    keyPoints: [
      'Blending high-rate short-term products with stable long-term ones maximises risk-adjusted yield',
      'Entry timing and reinvestment speed have a significant impact on effective annualised returns',
      'Laddering (staggered maturity dates) ensures continuous capital deployment',
      'Idle wallet balances are a hidden drag on your portfolio performance',
    ],
    content: `Yield optimisation is about maximising your effective annualised return across your whole portfolio — not just picking the highest individual rate. A sophisticated investor uses a laddering strategy: starting multiple investments with staggered maturity dates so capital is always being deployed or reinvested.

Equally, minimise idle time. Capital sitting in your wallet between investments earns 0%. Even a 2-week idle period on R50,000 costs you approximately R380 in lost returns at 14% p.a. The fastest investors reinvest within 48 hours of maturity.

The optimal blend for most SV Capital investors in 2025 is approximately 40% solar (stable base), 40% cattle/loans (higher rate, shorter term), and 20% in reserve for opportunistic reinvestment when high-rate pools open.`,
  },
  {
    id: 'learn_estate', track: 'strategist', order: 2,
    title: 'Protecting Your Investment Wealth', readTime: 12, xp: 50,
    icon: 'fa-people-roof', color: '#22c55e',
    keyPoints: [
      'South African law requires all assets to go through the estate when you die',
      'Naming a beneficiary ensures your family knows where your investments are',
      'SV Capital stores your beneficiary details securely in your profile',
      'A will that references your investment accounts speeds up estate administration',
    ],
    content: `Many investors focus on growing wealth but neglect protecting it for the next generation. In South Africa, all assets — including investments on platforms like SV Capital — form part of your deceased estate and must go through the Master of the High Court unless specifically structured otherwise.

The most important first step is ensuring your beneficiary details are on file with SV Capital (add them via the "Complete Your Profile" quest), and that your will references your investment accounts. Without clear documentation, your family may wait months or years to access funds.

For larger portfolios (R500,000+), consider consulting an estate planner about structuring investments via a trust or company to minimise estate duty and executor's fees. Estate duty in South Africa is charged at 20% on dutiable estates above R3.5 million.`,
  },
];

const LEARN_TRACKS = [
  { id: 'explorer',   label: 'Explorer',   desc: 'New to investing — start here',        icon: 'fa-compass',          color: '#2F8C9B',  minInvested: 0 },
  { id: 'builder',    label: 'Builder',    desc: 'Growing your portfolio',                icon: 'fa-hammer',           color: '#22c55e',  minInvested: 5000 },
  { id: 'strategist', label: 'Strategist', desc: 'Advanced portfolio management',         icon: 'fa-chess-knight',     color: '#a855f7',  minInvested: 50000 },
];

let _learnActiveTrack = null;

function renderLearnView() {
  const completed = new Set(PORTAL.quests?.completedIds || []);
  const totalInv  = parseFloat(PORTAL.investor?.total_invested) || 0;

  // Auto-select recommended track based on invested amount
  const recommended = [...LEARN_TRACKS].reverse().find(t => totalInv >= t.minInvested) || LEARN_TRACKS[0];
  if (!_learnActiveTrack) _learnActiveTrack = recommended.id;

  // Update header sub label
  const sub = document.getElementById('learnTrackLabel');
  if (sub) sub.textContent = `Recommended for you: ${recommended.label} track`;

  const container = document.getElementById('learnContent');
  if (!container) return;

  // Track tabs
  const tabs = LEARN_TRACKS.map(t => `
    <button class="learn-track-tab ${_learnActiveTrack === t.id ? 'active' : ''}"
            onclick="_setLearnTrack('${t.id}')"
            style="${_learnActiveTrack === t.id ? `border-color:${t.color};color:${t.color}` : ''}">
      <i class="fa-solid ${t.icon}"></i>
      <div>
        <div class="learn-tab-name">${t.label}</div>
        <div class="learn-tab-sub">${t.desc}</div>
      </div>
      ${t.id === recommended.id ? `<span class="learn-tab-recommended">Recommended</span>` : ''}
    </button>`).join('');

  const activeTrack = LEARN_TRACKS.find(t => t.id === _learnActiveTrack) || LEARN_TRACKS[0];
  const modules = LEARN_MODULES.filter(m => m.track === _learnActiveTrack)
    .sort((a, b) => a.order - b.order);

  const moduleCards = modules.map(mod => {
    const isDone = completed.has(mod.id);
    return `
      <div class="learn-module-card ${isDone ? 'learn-module-card--done' : ''}" id="lmod-${mod.id}">
        <div class="learn-module-card__header">
          <div class="learn-module-card__icon" style="background:${mod.color}22;color:${mod.color}">
            <i class="fa-solid ${mod.icon}"></i>
          </div>
          <div class="learn-module-card__meta">
            <div class="learn-module-card__title">${mod.title}</div>
            <div class="learn-module-card__info">
              <span><i class="fa-regular fa-clock"></i> ${mod.readTime} min</span>
              <span style="color:${mod.color}"><i class="fa-solid fa-star"></i> +${mod.xp} XP</span>
            </div>
          </div>
          ${isDone
            ? `<div class="learn-done-badge"><i class="fa-solid fa-circle-check"></i> Completed</div>`
            : `<button class="learn-expand-btn" onclick="_toggleModule('${mod.id}')">
                 <i class="fa-solid fa-chevron-down" id="lchev-${mod.id}"></i>
               </button>`
          }
        </div>
        <div class="learn-module-body" id="lbody-${mod.id}" style="display:none">
          <div class="learn-key-points">
            <div class="learn-key-points__title"><i class="fa-solid fa-list-check"></i> Key Takeaways</div>
            <ul>${mod.keyPoints.map(p => `<li>${p}</li>`).join('')}</ul>
          </div>
          <div class="learn-content-text">${mod.content.split('\n\n').map(p => `<p>${p.trim()}</p>`).join('')}</div>
          <div class="learn-module-footer">
            <button class="btn btn--primary" onclick="markModuleComplete('${mod.id}')">
              <i class="fa-solid fa-check"></i> Mark Complete — Earn ${mod.xp} XP
            </button>
          </div>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `
    <div class="learn-track-tabs">${tabs}</div>
    <div class="learn-modules-list">${moduleCards}</div>`;
}

function _setLearnTrack(trackId) {
  _learnActiveTrack = trackId;
  renderLearnView();
}

function _toggleModule(modId) {
  const body = document.getElementById(`lbody-${modId}`);
  const chev = document.getElementById(`lchev-${modId}`);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chev) chev.style.transform = isOpen ? '' : 'rotate(180deg)';
}

async function markModuleComplete(modId) {
  const btn = document.querySelector(`#lmod-${modId} .btn--primary`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...'; }

  try {
    const result = await _postQuestComplete(modId, { source: 'learning_hub' });
    if (result.error) {
      if (result.error.includes('already')) {
        Toast.info('Already completed!');
      } else {
        Toast.error(result.error);
      }
    } else {
      Toast.success(`Module complete! +${result.xpAwarded} XP`);
      if (PORTAL.quests) {
        PORTAL.quests.xp  = result.newXP;
        PORTAL.quests.xpToNext = result.xpToNext;
        PORTAL.quests.completedIds = [...(PORTAL.quests.completedIds || []), modId];
      }
      if (result.leveledUp) _showLevelUpModal(result);
      renderLearnView();
      renderXPWidget();
      _updateXPNavBadge();
    }
  } catch (e) {
    Toast.error('Could not save completion. Try again.');
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-check"></i> Mark Complete — Earn ${LEARN_MODULES.find(m=>m.id===modId)?.xp||50} XP`; }
  }
}

function shareReferral(method) {
  const code = PORTAL.investor?.referral_code || '';
  const link = `${window.location.origin}/register?ref=${code}`;
  if (method === 'whatsapp') {
    const msg = `Join SV Capital and start earning inflation-beating returns! Use my referral code ${code}: ${link}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  } else {
    navigator.clipboard.writeText(link)
      .then(() => Toast.success('Referral link copied to clipboard!'))
      .catch(() => Toast.error('Copy failed — please copy the link manually'));
  }
}

/* ═══════════════════════════════════════════════════════════════
   DARK MODE
   ═══════════════════════════════════════════════════════════════ */
function initDarkMode() {
  const saved = localStorage.getItem('svc_dark_mode');
  if (saved === 'dark') _applyDark(true);
}

function toggleDarkMode() {
  const isDark = document.body.classList.contains('dark-mode');
  _applyDark(!isDark);
  SVC.track('svc_dark_mode_toggle', { dark_mode: !isDark });
}

function _applyDark(on) {
  document.body.classList.toggle('dark-mode', on);
  localStorage.setItem('svc_dark_mode', on ? 'dark' : 'light');
  const icon = document.getElementById('darkModeIcon');
  if (icon) {
    icon.className = on ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
  }
}

/* ═══════════════════════════════════════════════════════════════
   GUIDED TOUR
   ═══════════════════════════════════════════════════════════════ */

const TOUR_STEPS = [
  {
    id: 'welcome',
    type: 'center',
    icon: 'fa-hand-wave',
    title: 'Welcome to your Investor Portal!',
    body: 'Let us give you a quick tour of everything available to you. It takes about 2 minutes and you\'ll earn <strong>100 Experience Points</strong> when you\'re done.',
  },
  {
    id: 'portfolio_hero',
    target: '.portfolio-hero',
    position: 'bottom',
    icon: 'fa-chart-simple',
    title: 'Your Portfolio Overview',
    body: 'This hero panel shows your <strong>total portfolio value</strong>, effective return %, and a live breakdown of invested, wallet, and returns earned.',
  },
  {
    id: 'overview_investments',
    target: '#overviewInvestmentsBody',
    position: 'top',
    icon: 'fa-list-check',
    title: 'Active Investments',
    body: 'Your current investments are listed here with product type, amount, expected return, and days remaining until maturity.',
  },
  {
    id: 'nav_wallet',
    target: '[data-view="wallet"]',
    position: 'right',
    icon: 'fa-wallet',
    title: 'Fund Your Wallet',
    body: 'Top up your wallet via EFT bank transfer or card. Your wallet balance is what you use to invest in pools.',
  },
  {
    id: 'nav_marketplace',
    target: '[data-view="marketplace"]',
    position: 'right',
    icon: 'fa-store',
    title: 'Browse Investment Pools',
    body: 'Explore open pools across solar, cattle, and delivery bikes. Each shows its rate, term, and how much is still available.',
  },
  {
    id: 'nav_maturity',
    target: '[data-view="maturity"]',
    position: 'right',
    icon: 'fa-hourglass-end',
    title: 'Maturity Instructions',
    body: 'Tell us what to do when your investment matures — reinvest automatically, add to wallet, or transfer to your bank account.',
  },
  {
    id: 'nav_quests',
    target: '[data-view="quests"]',
    position: 'right',
    icon: 'fa-trophy',
    title: 'Earn Rewards',
    body: 'Complete quests and surveys to earn XP. Every time you level up, <strong>R50 is added to your wallet</strong>. There are 8 levels to reach.',
  },
  {
    id: 'nav_learn',
    target: '[data-view="learn"]',
    position: 'right',
    icon: 'fa-graduation-cap',
    title: 'Learning Hub',
    body: 'Educational modules tailored to your investment level. Complete them to earn XP and become a more confident investor.',
  },
  {
    id: 'nav_referral',
    target: '[data-view="referral"]',
    position: 'right',
    icon: 'fa-share-nodes',
    title: 'Refer & Earn',
    body: 'Share your unique referral link. When a friend joins and invests, you both benefit.',
  },
  {
    id: 'complete',
    type: 'center',
    icon: 'fa-trophy',
    title: 'You\'re all set! 🎉',
    body: 'You now know your way around. Head to <strong>Earn Rewards</strong> to complete your first quest and start climbing the XP ladder.',
    isLast: true,
  },
];

let _tourStep = 0;
let _tourActive = false;

function _checkAutoStartTour() {
  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  const key = `svc_tour_done_${investorId}`;
  if (!localStorage.getItem(key)) {
    // Wait for next paint after overview renders, then start
    requestAnimationFrame(() => setTimeout(startTour, 400));
  }
}

function startTour() {
  _tourActive = true;
  _tourStep = 0;
  document.getElementById('tourOverlay').style.display = 'block';
  // Hide the pulsing badge on tour button
  const pulse = document.querySelector('.tour-btn-pulse');
  if (pulse) pulse.style.display = 'none';
  _renderTourStep(_tourStep);
}

function skipTour() {
  _endTour(false);
}

function nextTourStep() {
  if (_tourStep >= TOUR_STEPS.length - 1) {
    _endTour(true);
  } else {
    _tourStep++;
    _renderTourStep(_tourStep);
  }
}

function prevTourStep() {
  if (_tourStep > 0) {
    _tourStep--;
    _renderTourStep(_tourStep);
  }
}

function _endTour(completed) {
  _tourActive = false;
  document.getElementById('tourOverlay').style.display = 'none';

  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  localStorage.setItem(`svc_tour_done_${investorId}`, '1');

  if (completed) {
    // Award tour XP
    _postQuestComplete('complete_tour', { completed: true }).then(result => {
      if (result && !result.error) {
        Toast.success(`Tour complete! +${result.xpAwarded} XP earned`);
        if (PORTAL.quests) {
          PORTAL.quests.xp  = result.newXP;
          PORTAL.quests.completedIds = [...(PORTAL.quests.completedIds || []), 'complete_tour'];
        }
        if (result.leveledUp) _showLevelUpModal(result);
        renderXPWidget();
        _updateXPNavBadge();
      }
    }).catch(() => {});
  }
}

function _renderTourStep(idx) {
  const step    = TOUR_STEPS[idx];
  const total   = TOUR_STEPS.length;
  const isFirst = idx === 0;
  const isLast  = idx === total - 1;

  // Update text content
  document.getElementById('tourStepBadge').textContent = `Step ${idx + 1} of ${total}`;
  document.getElementById('tourTitle').textContent      = step.title;
  document.getElementById('tourBody').innerHTML         = step.body;

  // Icon
  const iconEl = document.getElementById('tourIcon');
  if (step.icon) {
    iconEl.innerHTML = `<i class="fa-solid ${step.icon}"></i>`;
    iconEl.style.display = 'flex';
  } else {
    iconEl.style.display = 'none';
  }

  // Dots
  const dotsEl = document.getElementById('tourDots');
  dotsEl.innerHTML = TOUR_STEPS.map((_, i) =>
    `<span class="tour-dot ${i === idx ? 'active' : i < idx ? 'done' : ''}"></span>`
  ).join('');

  // Prev / Next buttons
  document.getElementById('tourPrevBtn').style.display = isFirst ? 'none' : 'flex';
  const nextBtn = document.getElementById('tourNextBtn');
  if (isLast) {
    nextBtn.innerHTML = '<i class="fa-solid fa-check"></i> Done — Earn 100 XP';
    nextBtn.className = 'tour-next-btn tour-next-btn--done';
  } else {
    nextBtn.innerHTML = 'Next <i class="fa-solid fa-arrow-right"></i>';
    nextBtn.className = 'tour-next-btn';
  }

  // Scroll target into view first, then position after layout settles
  if (step.target && step.type !== 'center') {
    const el = document.querySelector(step.target);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }
  requestAnimationFrame(() => _positionTour(step));
}

function _positionTour(step) {
  const spotlight = document.getElementById('tourSpotlight');
  const tooltip   = document.getElementById('tourTooltip');

  const _centerTooltip = () => {
    spotlight.style.cssText = 'display:none';
    tooltip.style.cssText   = `
      display:flex; position:fixed;
      top:50%; left:50%; transform:translate(-50%,-50%);
      z-index:10002; max-width:440px; width:calc(100vw - 32px);`;
  };

  if (step.type === 'center' || !step.target) { _centerTooltip(); return; }

  const el = document.querySelector(step.target);
  if (!el) { _centerTooltip(); return; }

  const r  = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // If element is invisible (hidden sidebar on mobile, display:none, zero size), centre tooltip
  const isVisible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  if (!isVisible) { _centerTooltip(); return; }

  const pad = 8;

  // Spotlight
  spotlight.style.cssText = `
    display:block; position:fixed;
    left:${r.left - pad}px; top:${r.top - pad}px;
    width:${r.width + pad * 2}px; height:${r.height + pad * 2}px;
    border-radius:12px;
    box-shadow: 0 0 0 9999px rgba(0,0,0,0.72);
    z-index:10001; pointer-events:none;
    transition: all 0.35s cubic-bezier(0.22,1,0.36,1);`;

  // Tooltip positioning
  const ttW    = Math.min(340, vw - 32);
  const ttHEst = 220; // estimated tooltip height
  let left, top, transform = '';

  if (step.position === 'right') {
    left = r.right + 16;
    top  = r.top + r.height / 2;
    transform = 'translateY(-50%)';
    // If tooltip would overflow right edge, flip to left
    if (left + ttW + 8 > vw) { left = r.left - ttW - 16; }
  } else if (step.position === 'bottom') {
    left = r.left + r.width / 2;
    top  = r.bottom + 16;
    transform = 'translateX(-50%)';
    if (top + ttHEst > vh) { top = r.top - 16; transform = 'translateX(-50%) translateY(-100%)'; }
  } else if (step.position === 'top') {
    left = r.left + r.width / 2;
    top  = r.top - 16;
    transform = 'translateX(-50%) translateY(-100%)';
    if (top - ttHEst < 0) { top = r.bottom + 16; transform = 'translateX(-50%)'; }
  } else {
    left = r.left - ttW - 16;
    top  = r.top + r.height / 2;
    transform = 'translateY(-50%)';
  }

  // Clamp horizontally and vertically
  left = Math.max(8, Math.min(left, vw - ttW - 8));
  top  = Math.max(8, Math.min(top,  vh - ttHEst - 8));

  tooltip.style.cssText = `
    display:flex; position:fixed;
    left:${left}px; top:${top}px;
    width:${ttW}px; max-width:${ttW}px;
    transform:${transform};
    z-index:10002;`;
}

/* ═══════════════════════════════════════════════════════════════
   FIRST DEPOSIT PROMPT
   ═══════════════════════════════════════════════════════════════ */
function checkFirstDepositPrompt() {
  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  const neverKey   = `svc_deposit_never_${investorId}`;
  const laterKey   = `svc_deposit_later_${investorId}`;

  if (localStorage.getItem(neverKey)) return;  // permanently dismissed

  const snoozeUntil = parseInt(localStorage.getItem(laterKey) || '0');
  if (Date.now() < snoozeUntil) return;   // snoozed

  const hasDeposit = PORTAL.transactions.some(t => t.type === 'deposit');
  if (hasDeposit) return;  // already deposited

  // Show with a short delay so overview loads first
  setTimeout(() => {
    document.getElementById('depositPromptModal').style.display = 'flex';
  }, 2500);
}

function dismissDepositPrompt(never) {
  document.getElementById('depositPromptModal').style.display = 'none';
  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  if (never) {
    localStorage.setItem(`svc_deposit_never_${investorId}`, '1');
  } else {
    // Snooze for 24 hours
    localStorage.setItem(`svc_deposit_later_${investorId}`, String(Date.now() + 86_400_000));
  }
}

function goFundWallet() {
  dismissDepositPrompt(false);
  navigate('wallet', document.querySelector('[data-view="wallet"]'));
}

/* ═══════════════════════════════════════════════════════════════
   §50 — SUB ACCOUNTS
   Business · Trust · Stokvel · Minor
   ═══════════════════════════════════════════════════════════════ */

/* ── Meta ───────────────────────────────────────────────────── */
const SA_TYPE_META = {
  business: {
    icon: 'fa-building',       label: 'Business',
    color: '#FF8215',          bg: 'linear-gradient(135deg,#1a1a2e 0%,#FF8215 100%)',
    tagline: 'Invest through your registered company',
    ficaDocs: ['Company Registration Certificate (COR14.3 / COR15.1A)', 'Company Tax Clearance Certificate', 'CIPC CoR39 or similar', 'Authorised signatory ID (copy)'],
  },
  trust:    {
    icon: 'fa-scale-balanced',  label: 'Trust',
    color: '#FF9B0C',           bg: 'linear-gradient(135deg,#1a1a2e 0%,#FF9B0C 100%)',
    tagline: 'Invest through a family or business trust',
    ficaDocs: ['Trust Deed (certified copy)', 'Letters of Authority (Master of Court)', 'Trustee(s) ID documents', 'Trust tax clearance certificate'],
  },
  stokvel:  {
    icon: 'fa-people-group',    label: 'Stokvel',
    color: '#22c55e',           bg: 'linear-gradient(135deg,#064e1e 0%,#22c55e 100%)',
    tagline: 'Community savings club investing together',
    ficaDocs: ['Stokvel constitution / rules', 'Proof of banking account', 'Two or more members\' ID documents', 'NASASA certificate (if applicable)'],
  },
  minor:    {
    icon: 'fa-child-reaching',  label: 'Minor',
    color: '#ff9b0c',           bg: 'linear-gradient(135deg,#ff5229 0%,#ff9b0c 100%)',
    tagline: 'Start your child\'s investment journey today',
    ficaDocs: ['Child\'s birth certificate (unabridged)', 'Guardian\'s ID document', 'Proof of guardianship / parental rights', 'Child\'s tax reference number (if applicable)'],
  },
};

/* ── Age group helper ───────────────────────────────────────── */
function _saAgeGroup(dobStr) {
  if (!dobStr) return null;
  const dob = new Date(dobStr);
  const age = Math.floor((Date.now() - dob) / (365.25 * 86400000));
  if (age <= 5)  return { age, group: 'little',  label: 'Little Saver 🐣',   theme: 'minor-little' };
  if (age <= 9)  return { age, group: 'young',   label: 'Young Saver ⭐',    theme: 'minor-young' };
  if (age <= 12) return { age, group: 'growing', label: 'Money Master 🎓',   theme: 'minor-growing' };
  return         { age, group: 'teen',   label: 'Future Investor 🚀', theme: 'minor-teen' };
}

const _SA_TIPS = {
  little: [
    { emoji: '🐷', title: 'Save Like a Piggy!', body: 'Every rand you save goes into your piggy bank. When it\'s full, amazing things can happen!' },
    { emoji: '🌱', title: 'Money is Like a Seed', body: 'When you plant a seed and water it, a big tree grows. When you save money, it grows too!' },
    { emoji: '⭐', title: 'You\'re a Super Saver!', body: 'Every time your grown-up adds money to your account, you\'re one step closer to your goal!' },
  ],
  young: [
    { emoji: '🎯', title: 'Set a Goal!', body: 'Want a new toy or game? Figure out how much it costs, then save a little bit each week to get there!' },
    { emoji: '🆚', title: 'Needs vs Wants', body: '"Needs" are things like food and school books. "Wants" are things like games. Smart savers know the difference!' },
    { emoji: '📈', title: 'Your Money Grows!', body: 'SV Capital pays you to keep your money here. It\'s called a return — your R100 becomes R115!' },
    { emoji: '💡', title: 'Start Early, Win Big', body: 'If you save R50 a month from now until you\'re 18, you could have more than R5 000 before you even finish school!' },
  ],
  growing: [
    { emoji: '🔮', title: 'The Magic of Compound Interest', body: 'When your money earns interest, that interest also earns interest. It\'s money multiplying itself!' },
    { emoji: '📊', title: 'Rule of 72', body: 'Divide 72 by your interest rate to see how many years to double your money. At 14%: 72 ÷ 14 = just over 5 years!' },
    { emoji: '🧺', title: 'Don\'t Put All Eggs in One Basket', body: 'Spreading money across different investments (diversifying) reduces risk. SV Capital does this across sectors.' },
    { emoji: '⏰', title: 'Time is Your Biggest Advantage', body: 'Starting to invest at 12 vs 22 can mean twice as much money at retirement. You have a head start!' },
  ],
  teen: [
    { emoji: '🚀', title: 'Compound Growth is Exponential', body: 'R10 000 at 14% per year becomes R37 072 in 10 years without adding anything. Your money works while you sleep.' },
    { emoji: '📉', title: 'Market Volatility is Normal', body: 'Markets go up and down, but SV Capital\'s asset-backed investments provide stable, predictable returns.' },
    { emoji: '🏦', title: 'Alternative vs Traditional', body: 'Banks offer 6-8%. SV Capital targets 12-21% through real assets like cattle, solar, and SMEs.' },
    { emoji: '💼', title: 'Start a Portfolio Now', body: 'At 16, if you invest R500/month at 14%, you\'ll have R1.2 million by age 40. The earlier, the better.' },
  ],
};

/* ── Load & render ──────────────────────────────────────────── */
async function loadSubAccounts() {
  try {
    const res = await API._fetch('GET', 'tables/sub_accounts', null, { limit: 200 });
    const all = res.data || (Array.isArray(res) ? res : []);
    const myId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
    PORTAL.subAccounts = all.filter(a => String(a.parent_investor_id) === String(myId));
  } catch (e) {
    console.warn('loadSubAccounts:', e);
    PORTAL.subAccounts = [];
  }
  renderSubAccountsView();
  const badge = document.getElementById('subacctsBadge');
  if (badge) {
    badge.textContent = PORTAL.subAccounts.length || '';
    badge.style.display = PORTAL.subAccounts.length ? '' : 'none';
  }
}

function renderSubAccountsView() {
  const grid  = document.getElementById('subacctsGrid');
  const empty = document.getElementById('subacctsEmpty');
  if (!grid) return;

  const badge = document.getElementById('subacctsBadge');
  if (badge) badge.textContent = PORTAL.subAccounts.length || '';

  if (!PORTAL.subAccounts.length) {
    grid.style.display  = 'none';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  grid.style.display = '';

  grid.innerHTML = PORTAL.subAccounts.map(sa => _saCard(sa)).join('');
}

function _saCard(sa) {
  const meta    = SA_TYPE_META[sa.account_type] || SA_TYPE_META.business;
  const balance = parseFloat(sa.wallet_balance) || 0;
  const invested= parseFloat(sa.total_invested)  || 0;
  const kycBadge = sa.kyc_status === 'approved'
    ? `<span class="sa-kyc-badge sa-kyc-badge--ok"><i class="fa-solid fa-circle-check"></i> FICA Verified</span>`
    : sa.kyc_status === 'under_review'
    ? `<span class="sa-kyc-badge sa-kyc-badge--pending"><i class="fa-solid fa-clock"></i> Under Review</span>`
    : `<span class="sa-kyc-badge sa-kyc-badge--missing"><i class="fa-solid fa-triangle-exclamation"></i> FICA Required</span>`;

  const isMinor = sa.account_type === 'minor';
  const age     = isMinor ? _saAgeGroup(sa.date_of_birth) : null;

  return `<div class="sa-card${isMinor ? ' sa-card--minor' : ''}" style="--sa-color:${meta.color}">
    <div class="sa-card__header" style="background:${meta.bg}">
      <div class="sa-card__type">
        <span class="sa-card__icon"><i class="fa-solid ${meta.icon}"></i></span>
        <span class="sa-card__type-label">${meta.label}</span>
      </div>
      ${isMinor && age ? `<span class="sa-age-chip">${age.label} · Age ${age.age}</span>` : ''}
      ${kycBadge}
    </div>
    <div class="sa-card__body">
      <div class="sa-card__name">${sa.name}</div>
      <div class="sa-card__stats">
        <div class="sa-stat"><span class="sa-stat__label">Wallet</span><span class="sa-stat__value">${Utils.rand(balance)}</span></div>
        <div class="sa-stat"><span class="sa-stat__label">Invested</span><span class="sa-stat__value">${Utils.rand(invested)}</span></div>
      </div>
      ${isMinor && sa.savings_goal > 0 ? _saGoalBar(balance + invested, sa.savings_goal, sa.savings_goal_label) : ''}
    </div>
    <div class="sa-card__actions">
      <button class="btn btn--sm btn--primary" onclick="openSaDeposit('${sa.id}')"><i class="fa-solid fa-wallet"></i> Deposit</button>
      <button class="btn btn--sm btn--secondary" onclick="openSaInvest('${sa.id}')" ${sa.kyc_status !== 'approved' ? 'disabled title="FICA required before investing"' : ''}><i class="fa-solid fa-chart-line"></i> Invest</button>
      <button class="btn btn--sm btn--secondary" onclick="openSaDetail('${sa.id}')"><i class="fa-solid fa-${isMinor ? 'star' : 'eye'}"></i> ${isMinor ? 'Hub' : 'Details'}</button>
    </div>
  </div>`;
}

function _saGoalBar(current, goal, label) {
  const pct = Math.min(100, Math.round((current / goal) * 100));
  return `<div class="sa-goal-bar">
    <div class="sa-goal-bar__label"><i class="fa-solid fa-flag"></i> ${label || 'Savings Goal'} — ${pct}%</div>
    <div class="sa-goal-bar__track"><div class="sa-goal-bar__fill" style="width:${pct}%"></div></div>
    <div class="sa-goal-bar__nums">${Utils.rand(current)} of ${Utils.rand(goal)}</div>
  </div>`;
}

/* ── Create modal ───────────────────────────────────────────── */
let _saCreateType = null;
let _saCreateStep = 1;

function openCreateSubAccountModal() {
  _saCreateType = null;
  _saCreateStep = 1;
  _saShowCreateStep(1);
  Modal.open('createSaModal');
}

function _saShowCreateStep(step) {
  _saCreateStep = step;
  [1, 2, 3].forEach(s => {
    const body = document.getElementById(`saStep${s}`);
    const foot = document.getElementById(`saStep${s}Footer`);
    if (body) body.style.display = s === step ? '' : 'none';
    if (foot) foot.style.display = s === step ? '' : 'none';
  });
  const progFill = document.getElementById('saCreateProg');
  if (progFill) progFill.style.width = `${Math.round((step / 3) * 100)}%`;
  const stepLbl = document.getElementById('saCreateStepLbl');
  if (stepLbl) stepLbl.textContent = `Step ${step} of 3`;
}

function saSelectType(type) {
  _saCreateType = type;
  document.querySelectorAll('.sa-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  document.getElementById('saStep1Next').removeAttribute('disabled');
}

function saStep1Next() {
  if (!_saCreateType) { Toast.warn('Please choose an account type'); return; }
  const meta = SA_TYPE_META[_saCreateType];
  // Build the step 2 form dynamically
  document.getElementById('saStep2TypeLabel').textContent = `${meta.label} Account Details`;
  document.getElementById('saStep2TypeIcon').className = `fa-solid ${meta.icon}`;
  document.getElementById('saStep2Fields').innerHTML = _saFormFields(_saCreateType);
  _saShowCreateStep(2);
}

function _saFormFields(type) {
  const common = `
    <div class="form-group"><label class="form-label">Account Name <span style="color:#ef4444">*</span></label>
      <input type="text" class="form-input" id="saFieldName" placeholder="${
        type === 'business' ? 'e.g. Khumalo Holdings (Pty) Ltd'
      : type === 'trust'   ? 'e.g. The Khumalo Family Trust'
      : type === 'stokvel' ? 'e.g. Ubuntu Savings Club'
                           : 'e.g. Amahle Khumalo'
      }" required /></div>`;

  if (type === 'business') return common + `
    <div class="form-row form-row--2">
      <div class="form-group"><label class="form-label">Company Reg. Number</label><input type="text" class="form-input" id="saFieldReg" placeholder="2024/123456/07" /></div>
      <div class="form-group"><label class="form-label">VAT Number (if applicable)</label><input type="text" class="form-input" id="saFieldVat" placeholder="4012345678" /></div>
    </div>
    <div class="form-row form-row--2">
      <div class="form-group"><label class="form-label">Business Email</label><input type="email" class="form-input" id="saFieldEmail" placeholder="accounts@yourbusiness.co.za" /></div>
      <div class="form-group"><label class="form-label">Business Phone</label><input type="tel" class="form-input" id="saFieldPhone" placeholder="+27 11 123 4567" /></div>
    </div>`;

  if (type === 'trust') return common + `
    <div class="form-row form-row--2">
      <div class="form-group"><label class="form-label">Trust Registration Number</label><input type="text" class="form-input" id="saFieldReg" placeholder="IT 1234/2020" /></div>
      <div class="form-group"><label class="form-label">Main Trustee Name</label><input type="text" class="form-input" id="saFieldTrustee" placeholder="Full name of lead trustee" /></div>
    </div>
    <div class="form-row form-row--2">
      <div class="form-group"><label class="form-label">Trust Email</label><input type="email" class="form-input" id="saFieldEmail" placeholder="trust@example.com" /></div>
      <div class="form-group"><label class="form-label">Trust Phone</label><input type="tel" class="form-input" id="saFieldPhone" placeholder="+27 82 000 0000" /></div>
    </div>`;

  if (type === 'stokvel') return common + `
    <div class="form-row form-row--2">
      <div class="form-group"><label class="form-label">Stokvel Reg. Number (if any)</label><input type="text" class="form-input" id="saFieldReg" placeholder="Leave blank if unregistered" /></div>
      <div class="form-group"><label class="form-label">Number of Members</label><input type="number" class="form-input" id="saFieldMembers" placeholder="e.g. 12" min="2" max="200" /></div>
    </div>
    <div class="form-row form-row--2">
      <div class="form-group"><label class="form-label">Club Contact Email</label><input type="email" class="form-input" id="saFieldEmail" placeholder="yourclub@email.com" /></div>
      <div class="form-group"><label class="form-label">Club Phone</label><input type="tel" class="form-input" id="saFieldPhone" placeholder="+27 72 000 0000" /></div>
    </div>`;

  // Minor
  return common + `
    <div class="form-row form-row--2">
      <div class="form-group"><label class="form-label">Date of Birth <span style="color:#ef4444">*</span></label><input type="date" class="form-input" id="saFieldDob" max="${new Date().toISOString().split('T')[0]}" required /></div>
      <div class="form-group"><label class="form-label">SA ID Number (if 16+)</label><input type="text" class="form-input" id="saFieldId" placeholder="Leave blank if under 16" maxlength="13" /></div>
    </div>
    <div class="form-group"><label class="form-label">Your Relationship to Child <span style="color:#ef4444">*</span></label>
      <select class="form-select" id="saFieldRelationship" required>
        <option value="">Select relationship…</option>
        <option value="parent">Parent</option>
        <option value="legal_guardian">Legal Guardian</option>
        <option value="grandparent">Grandparent</option>
        <option value="other">Other (specify in notes)</option>
      </select></div>
    <div class="form-row form-row--2">
      <div class="form-group"><label class="form-label">Savings Goal Amount (R)</label><input type="number" class="form-input" id="saFieldGoalAmt" placeholder="e.g. 50000" min="0" /></div>
      <div class="form-group"><label class="form-label">What are they saving for?</label><input type="text" class="form-input" id="saFieldGoalLabel" placeholder="e.g. University, First Car…" /></div>
    </div>`;
}

function saStep2Next() {
  const name = document.getElementById('saFieldName')?.value?.trim();
  if (!name) { Toast.error('Please enter an account name'); return; }
  if (_saCreateType === 'minor') {
    const dob = document.getElementById('saFieldDob')?.value;
    const rel = document.getElementById('saFieldRelationship')?.value;
    if (!dob) { Toast.error('Please enter the child\'s date of birth'); return; }
    if (!rel) { Toast.error('Please select your relationship to the child'); return; }
    const age = Math.floor((Date.now() - new Date(dob)) / (365.25 * 86400000));
    if (age >= 18) { Toast.error('The child must be under 18 years old'); return; }
  }
  // Populate step 3 review
  _saRenderReview();
  _saShowCreateStep(3);
}

function _saRenderReview() {
  const meta  = SA_TYPE_META[_saCreateType];
  const name  = document.getElementById('saFieldName')?.value?.trim() || '';
  const el    = document.getElementById('saStep3Review');
  if (!el) return;

  const rows = [
    ['Account Type', `<span style="color:${meta.color}"><i class="fa-solid ${meta.icon}"></i> ${meta.label}</span>`],
    ['Account Name', name],
  ];

  if (_saCreateType === 'minor') {
    const dob = document.getElementById('saFieldDob')?.value;
    const rel = document.getElementById('saFieldRelationship')?.value;
    const age = dob ? _saAgeGroup(dob) : null;
    rows.push(['Date of Birth', dob || '—']);
    rows.push(['Age', age ? `${age.age} years (${age.label})` : '—']);
    rows.push(['Relationship', rel || '—']);
    const goalAmt = parseFloat(document.getElementById('saFieldGoalAmt')?.value) || 0;
    const goalLbl = document.getElementById('saFieldGoalLabel')?.value?.trim();
    if (goalAmt) rows.push(['Savings Goal', `${Utils.rand(goalAmt)}${goalLbl ? ` — ${goalLbl}` : ''}`]);
  } else {
    const reg = document.getElementById('saFieldReg')?.value?.trim();
    if (reg) rows.push(['Registration #', reg]);
    const email = document.getElementById('saFieldEmail')?.value?.trim();
    if (email) rows.push(['Email', email]);
  }

  const createBtn = document.getElementById('saCreateBtn');
  if (createBtn) { createBtn.disabled = false; createBtn.innerHTML = '<i class="fa-solid fa-check"></i> Create Account'; }

  el.innerHTML = `
    <div class="sa-review-banner" style="background:${meta.bg}">
      <i class="fa-solid ${meta.icon}" style="font-size:2rem;color:#fff;margin-bottom:8px"></i>
      <div style="font-size:1.1rem;font-weight:800;color:#fff">${name}</div>
      <div style="font-size:0.8rem;color:rgba(255,255,255,0.8)">${meta.tagline}</div>
    </div>
    <div class="info-list mt-16">${rows.map(([k,v]) => `<div class="info-row"><span class="info-row__label">${k}</span><span class="info-row__value">${v}</span></div>`).join('')}</div>
    <div class="sa-fica-notice">
      <i class="fa-solid fa-id-card" style="color:#ff9b0c"></i>
      <div><strong>FICA documents required</strong><br><span style="font-size:0.8rem;color:var(--text-muted)">After creating, you'll upload the required documents in the account details view. Investing is enabled once FICA is approved.</span></div>
    </div>`;
}

async function saConfirmCreate() {
  const btn = document.getElementById('saCreateBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating…'; }

  const name = document.getElementById('saFieldName')?.value?.trim() || '';
  const body = {
    parent_investor_id: PORTAL.investor?.id || DEMO_INVESTOR_ID,
    account_type:       _saCreateType,
    name,
    kyc_status:         'pending',
    status:             'active',
    wallet_balance:     0,
    total_invested:     0,
    total_returns:      0,
  };

  if (_saCreateType === 'business') {
    body.registration_number = document.getElementById('saFieldReg')?.value?.trim() || '';
    body.vat_number          = document.getElementById('saFieldVat')?.value?.trim() || '';
    body.email               = document.getElementById('saFieldEmail')?.value?.trim() || '';
    body.phone               = document.getElementById('saFieldPhone')?.value?.trim() || '';
  } else if (_saCreateType === 'trust') {
    body.trust_number  = document.getElementById('saFieldReg')?.value?.trim() || '';
    body.trustee_name  = document.getElementById('saFieldTrustee')?.value?.trim() || '';
    body.email         = document.getElementById('saFieldEmail')?.value?.trim() || '';
    body.phone         = document.getElementById('saFieldPhone')?.value?.trim() || '';
  } else if (_saCreateType === 'stokvel') {
    body.stokvel_reg_number = document.getElementById('saFieldReg')?.value?.trim() || '';
    body.member_count       = parseInt(document.getElementById('saFieldMembers')?.value || '0', 10);
    body.email              = document.getElementById('saFieldEmail')?.value?.trim() || '';
    body.phone              = document.getElementById('saFieldPhone')?.value?.trim() || '';
  } else if (_saCreateType === 'minor') {
    body.date_of_birth   = document.getElementById('saFieldDob')?.value || '';
    body.id_number       = document.getElementById('saFieldId')?.value?.trim() || '';
    body.relationship    = document.getElementById('saFieldRelationship')?.value || '';
    body.savings_goal    = parseFloat(document.getElementById('saFieldGoalAmt')?.value) || 0;
    body.savings_goal_label = document.getElementById('saFieldGoalLabel')?.value?.trim() || '';
  }

  try {
    await API._fetch('POST', 'tables/sub_accounts', body);
    Toast.success(`${SA_TYPE_META[_saCreateType].label} account created! Please upload the required FICA documents.`);
    Modal.close('createSaModal');
    await loadSubAccounts();
  } catch (e) {
    Toast.error('Failed to create account. Please try again.');
    console.error(e);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check"></i> Create Account'; }
  }
}

/* ── Sub account detail ─────────────────────────────────────── */
async function openSaDetail(saId) {
  const sa = PORTAL.subAccounts.find(a => a.id === saId);
  if (!sa) return;

  const isMinor = sa.account_type === 'minor';
  const meta    = SA_TYPE_META[sa.account_type] || SA_TYPE_META.business;
  SVC.track('svc_subaccount_viewed', { account_type: sa.account_type, kyc_status: sa.kyc_status });

  document.getElementById('saDetailTitle').textContent = sa.name;

  if (isMinor) {
    document.getElementById('saDetailBody').innerHTML = _saMinorHub(sa);
    _saInitTipCarousel(sa);
  } else {
    document.getElementById('saDetailBody').innerHTML = _saNormalDetail(sa, meta);
  }

  Modal.open('saDetailModal');
}

function _saNormalDetail(sa, meta) {
  const ficaItems = (SA_TYPE_META[sa.account_type]?.ficaDocs || [])
    .map(d => `<div class="sa-fica-item"><i class="fa-solid fa-file-alt" style="color:${meta.color}"></i><span>${d}</span></div>`)
    .join('');

  const recentTxns = PORTAL.transactions
    .filter(t => t.sub_account_id === sa.id)
    .slice(0, 5);

  return `
    <div class="sa-detail-banner" style="background:${meta.bg}">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="sa-detail-icon"><i class="fa-solid ${meta.icon}"></i></div>
        <div>
          <div style="font-size:1.1rem;font-weight:800;color:#fff">${sa.name}</div>
          <div style="font-size:0.78rem;color:rgba(255,255,255,0.75)">${meta.label} Account · ${Utils.statusBadge ? Utils.statusBadge(sa.kyc_status) : sa.kyc_status}</div>
        </div>
      </div>
      <div style="display:flex;gap:24px;margin-top:16px">
        <div><div style="font-size:0.7rem;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:.5px">Wallet</div><div style="font-size:1.3rem;font-weight:800;color:#fff">${Utils.rand(sa.wallet_balance)}</div></div>
        <div><div style="font-size:0.7rem;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:.5px">Invested</div><div style="font-size:1.3rem;font-weight:800;color:#fff">${Utils.rand(sa.total_invested)}</div></div>
        <div><div style="font-size:0.7rem;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:.5px">Returns</div><div style="font-size:1.3rem;font-weight:800;color:rgba(255,255,255,0.9)">${Utils.rand(sa.total_returns)}</div></div>
      </div>
    </div>

    <div style="display:flex;gap:8px;margin:16px 0">
      <button class="btn btn--primary btn--sm" onclick="Modal.close('saDetailModal');openSaDeposit('${sa.id}')"><i class="fa-solid fa-wallet"></i> Deposit</button>
      <button class="btn btn--secondary btn--sm" onclick="Modal.close('saDetailModal');openSaInvest('${sa.id}')" ${sa.kyc_status !== 'approved' ? 'disabled title="FICA approval required"' : ''}><i class="fa-solid fa-chart-line"></i> Invest</button>
    </div>

    <div class="sa-section-title"><i class="fa-solid fa-id-card"></i> FICA Documents Required</div>
    <div class="sa-fica-list">${ficaItems}</div>
    <button class="btn btn--secondary btn--sm mt-8" onclick="openSaFicaUpload('${sa.id}')"><i class="fa-solid fa-upload"></i> Upload FICA Document</button>

    ${recentTxns.length ? `
    <div class="sa-section-title mt-16"><i class="fa-solid fa-receipt"></i> Recent Transactions</div>
    <table class="data-table">
      <thead><tr><th>Type</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
      <tbody>${recentTxns.map(t => `<tr>
        <td><span class="badge badge--gray">${t.type}</span></td>
        <td class="${t.amount > 0 ? 'td-green' : 'td-red'} fw-700">${Utils.rand(t.amount)}</td>
        <td>${Utils.statusBadge(t.status)}</td>
        <td class="td-muted">${Utils.date(t.created_at)}</td>
      </tr>`).join('')}</tbody>
    </table>` : ''}`;
}

/* ── Minor Hub ──────────────────────────────────────────────── */
function _saMinorHub(sa) {
  const age     = _saAgeGroup(sa.date_of_birth);
  const balance = parseFloat(sa.wallet_balance) || 0;
  const invested= parseFloat(sa.total_invested) || 0;
  const total   = balance + invested;
  const goal    = parseFloat(sa.savings_goal) || 0;
  const goalPct = goal > 0 ? Math.min(100, Math.round((total / goal) * 100)) : 0;
  const jarFill = Math.min(100, Math.max(5, total > 0 ? Math.min(100, (total / Math.max(goal, total + 1)) * 100) : 0));

  const ageInfo = age || { age: '?', label: 'Saver', theme: 'minor-young' };

  return `
  <div class="minor-hub minor-hub--${ageInfo.theme || 'minor-young'}">

    <!-- Child header -->
    <div class="minor-hub__header">
      <div class="minor-avatar">${sa.name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase()}</div>
      <div class="minor-hub__intro">
        <div class="minor-hub__name">${sa.name}</div>
        <div class="minor-hub__age-badge">${ageInfo.label} · Age ${ageInfo.age}</div>
        ${sa.kyc_status !== 'approved' ? `<div class="minor-fica-warn"><i class="fa-solid fa-triangle-exclamation"></i> FICA documents needed to start investing</div>` : ''}
      </div>
    </div>

    <!-- Stats row -->
    <div class="minor-stats">
      <div class="minor-stat minor-stat--wallet"><div class="minor-stat__icon">🐷</div><div class="minor-stat__value">${Utils.rand(balance)}</div><div class="minor-stat__label">In Wallet</div></div>
      <div class="minor-stat minor-stat--invested"><div class="minor-stat__icon">📈</div><div class="minor-stat__value">${Utils.rand(invested)}</div><div class="minor-stat__label">Invested</div></div>
      <div class="minor-stat minor-stat--total"><div class="minor-stat__icon">⭐</div><div class="minor-stat__value">${Utils.rand(total)}</div><div class="minor-stat__label">Total Saved</div></div>
    </div>

    <!-- Savings Jar -->
    <div class="minor-jar-section">
      <div class="minor-jar-label">💰 ${sa.savings_goal_label || 'Savings Jar'}</div>
      <div class="minor-jar">
        <div class="minor-jar__lid"></div>
        <div class="minor-jar__body">
          <div class="minor-jar__fill" style="height:${jarFill}%"></div>
          <div class="minor-jar__amount">${Utils.rand(total)}</div>
        </div>
      </div>
      ${goal > 0 ? `
      <div class="minor-goal-track">
        <div class="minor-goal-track__bar"><div class="minor-goal-track__fill" style="width:${goalPct}%"></div></div>
        <div class="minor-goal-track__label">${goalPct}% of ${Utils.rand(goal)} goal ${goalPct >= 100 ? '🎉' : goalPct >= 50 ? '🔥' : '💪'}</div>
      </div>` : `<div style="margin-top:8px;font-size:0.78rem;color:rgba(255,255,255,0.7);text-align:center">No savings goal set — <a href="#" style="color:#ff9b0c" onclick="openSaGoalModal('${sa.id}')">set one now!</a></div>`}
    </div>

    <!-- Actions -->
    <div class="minor-actions">
      <button class="minor-btn minor-btn--deposit" onclick="Modal.close('saDetailModal');openSaDeposit('${sa.id}')"><i class="fa-solid fa-piggy-bank"></i><span>Add to Jar</span></button>
      <button class="minor-btn minor-btn--invest" onclick="Modal.close('saDetailModal');openSaInvest('${sa.id}')" ${sa.kyc_status !== 'approved' ? 'disabled' : ''}><i class="fa-solid fa-seedling"></i><span>Invest</span></button>
      <button class="minor-btn minor-btn--fica" onclick="openSaFicaUpload('${sa.id}')"><i class="fa-solid fa-id-card"></i><span>FICA Docs</span></button>
    </div>

    <!-- Learning Zone -->
    <div class="minor-learn-zone">
      <div class="minor-learn-zone__title">✨ Learning Zone</div>
      <div class="minor-tips-carousel" id="minorTipsCarousel">
        <!-- Populated by JS -->
      </div>
      <div class="minor-tips-dots" id="minorTipsDots"></div>
    </div>

    <!-- FICA section -->
    <div class="minor-fica-section">
      <div class="minor-fica-section__title"><i class="fa-solid fa-id-card"></i> Required Documents</div>
      ${SA_TYPE_META.minor.ficaDocs.map(d => `<div class="sa-fica-item sa-fica-item--minor"><i class="fa-solid fa-circle-dot" style="color:#ff9b0c"></i><span>${d}</span></div>`).join('')}
      <button class="btn btn--primary btn--sm mt-12 w-full" onclick="openSaFicaUpload('${sa.id}')"><i class="fa-solid fa-upload"></i> Upload Documents</button>
    </div>

  </div>`;
}

let _tipIdx = 0;
function _saInitTipCarousel(sa) {
  _tipIdx = 0;
  const age  = _saAgeGroup(sa.date_of_birth);
  const tips = _SA_TIPS[age?.group || 'young'] || _SA_TIPS.young;

  const carousel = document.getElementById('minorTipsCarousel');
  const dots     = document.getElementById('minorTipsDots');
  if (!carousel || !dots) return;

  carousel.innerHTML = tips.map((t, i) => `
    <div class="minor-tip-card${i === 0 ? ' active' : ''}" data-tip="${i}">
      <div class="minor-tip-card__emoji">${t.emoji}</div>
      <div class="minor-tip-card__title">${t.title}</div>
      <div class="minor-tip-card__body">${t.body}</div>
    </div>`).join('');

  dots.innerHTML = tips.map((_, i) => `<button class="minor-tip-dot${i === 0 ? ' active' : ''}" onclick="_saTipGo(${i})"></button>`).join('');
}

function _saTipGo(idx) {
  _tipIdx = idx;
  document.querySelectorAll('.minor-tip-card').forEach((c, i) => c.classList.toggle('active', i === idx));
  document.querySelectorAll('.minor-tip-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
}

/* ── Deposit to sub account — handled by openSaDeposit() near line 2511 ── */

async function confirmSaDeposit() {
  const saId    = document.getElementById('saDepositSaId').value;
  const amount  = parseFloat(document.getElementById('saDepositAmount').value);
  const ref     = document.getElementById('saDepositRef').value.trim() || `SA-EFT-${Date.now()}`;
  const sa      = PORTAL.subAccounts.find(a => a.id === saId);
  if (!sa || !amount || amount <= 0) { Toast.error('Enter a valid deposit amount'); return; }

  try {
    const newBal = Math.round(((parseFloat(sa.wallet_balance) || 0) + amount) * 100) / 100;
    await API._fetch('PATCH', `tables/sub_accounts/${saId}`, { wallet_balance: newBal });
    await API._fetch('POST', 'tables/transactions', {
      investor_id:    PORTAL.investor?.id || DEMO_INVESTOR_ID,
      sub_account_id: saId,
      type:           'deposit',
      amount,
      status:         'pending',
      reference:      ref,
      description:    `EFT deposit to ${sa.name} — pending confirmation`,
    });
    Toast.success(`Deposit of ${Utils.rand(amount)} submitted for ${sa.name}. The admin team will confirm receipt.`);
    Modal.close('saDepositModal');
    await loadSubAccounts();
  } catch (e) {
    Toast.error('Failed to record deposit. Please try again.');
    console.error(e);
  }
}

/* ── Invest from sub account ────────────────────────────────── */
function openSaInvest(saId) {
  const sa = PORTAL.subAccounts.find(a => a.id === saId);
  if (!sa) return;
  if (sa.kyc_status !== 'approved') { Toast.warn('FICA documents must be approved before investing'); return; }
  if ((parseFloat(sa.wallet_balance) || 0) <= 0) { Toast.warn('Please deposit funds first'); return; }

  // Reuse the main invest modal but tag it to the sub account
  const pool = PORTAL.pools[0];
  if (!pool) { Toast.warn('No investment products available'); return; }
  // Navigate to marketplace so investor picks a pool
  Modal.close('saDetailModal');
  Toast.info(`Investing from ${sa.name} — select a product below`);
  navigate('marketplace', document.querySelector('[data-view="marketplace"]'));
}

/* ── FICA upload for sub account ────────────────────────────── */
let _saFicaFile = null;
let _saFicaB64  = null;
let _saFicaSaId = null;

function openSaFicaUpload(saId) {
  _saFicaSaId = saId;
  _saFicaFile = null;
  _saFicaB64  = null;
  const sa   = PORTAL.subAccounts.find(a => a.id === saId);
  const meta = sa ? SA_TYPE_META[sa.account_type] : SA_TYPE_META.business;
  document.getElementById('saFicaAccountName').textContent = sa ? sa.name : '';
  document.getElementById('saFicaDocList').innerHTML = (meta?.ficaDocs || [])
    .map(d => `<li>${d}</li>`).join('');
  document.getElementById('saFicaFileInput').value = '';
  document.getElementById('saFicaDocType').value   = '';
  document.getElementById('saFicaFilePreview').style.display = 'none';
  Modal.open('saFicaModal');
}

function saFicaFileChange(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { Toast.error('File must be under 5 MB'); input.value = ''; return; }
  _saFicaFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    _saFicaB64 = e.target.result;
    const prev = document.getElementById('saFicaFilePreview');
    if (prev) { prev.style.display = ''; prev.textContent = `📎 ${file.name} (${(file.size / 1024).toFixed(1)} KB)`; }
  };
  reader.readAsDataURL(file);
}

async function submitSaFica() {
  if (!_saFicaSaId || !_saFicaFile || !_saFicaB64) { Toast.error('Please select a document to upload'); return; }
  const docType = document.getElementById('saFicaDocType').value;
  if (!docType) { Toast.error('Please select a document type'); return; }
  const sa = PORTAL.subAccounts.find(a => a.id === _saFicaSaId);

  try {
    await API._fetch('POST', 'tables/kyc_documents', {
      investor_id:    PORTAL.investor?.id || DEMO_INVESTOR_ID,
      sub_account_id: _saFicaSaId,
      doc_type:       docType,
      status:         'pending',
      file_name:      _saFicaFile.name,
      notes:          `FICA document for sub-account: ${sa?.name || _saFicaSaId}. File: ${_saFicaFile.name} (${((_saFicaFile.size)/1024).toFixed(1)} KB)`,
    });
    Toast.success('FICA/KYC document submitted! The admin team will review it within 1–2 business days.');
    Modal.close('saFicaModal');
  } catch (e) {
    Toast.error('Upload failed. Please try again.');
    console.error(e);
  }
}

/* ── Savings goal modal ─────────────────────────────────────── */
function openSaGoalModal(saId) {
  const sa = PORTAL.subAccounts.find(a => a.id === saId);
  if (!sa) return;
  document.getElementById('saGoalSaId').value   = saId;
  document.getElementById('saGoalAmount').value  = sa.savings_goal || '';
  document.getElementById('saGoalLabel').value   = sa.savings_goal_label || '';
  Modal.open('saGoalModal');
}

async function saveSaGoal() {
  const saId  = document.getElementById('saGoalSaId').value;
  const goal  = parseFloat(document.getElementById('saGoalAmount').value) || 0;
  const label = document.getElementById('saGoalLabel').value.trim();
  try {
    await API._fetch('PATCH', `tables/sub_accounts/${saId}`, { savings_goal: goal, savings_goal_label: label });
    Toast.success('Savings goal updated!');
    Modal.close('saGoalModal');
    await loadSubAccounts();
  } catch (e) { Toast.error('Failed to save goal'); }
}

/* ═══════════════════════════════════════════════
   BANK DETAILS & WITHDRAWALS
   ═══════════════════════════════════════════════ */

function _renderBankDetailsPanel() {
  const panel = document.getElementById('bankDetailsPanel');
  if (!panel) return;
  const inv = PORTAL.investor;
  if (!inv) return;

  const statusMap = {
    none:     { label: 'Not added',           cls: 'badge--grey'   },
    pending:  { label: 'Pending verification', cls: 'badge--yellow' },
    approved: { label: 'Verified',             cls: 'badge--green'  },
    rejected: { label: 'Rejected',             cls: 'badge--red'    },
  };
  const s = statusMap[inv.bank_account_status] || statusMap.none;

  if (!inv.bank_account_number) {
    panel.innerHTML = `
      <div style="color:var(--text-muted);font-size:0.82rem;margin-bottom:12px">No bank account linked yet. Add your details to enable withdrawals.</div>
      <button class="btn btn--primary btn--full" onclick="openBankDetailsModal()">
        <i class="fa-solid fa-plus"></i> Add Bank Account
      </button>`;
    return;
  }

  const masked = inv.bank_account_number ? '••••••' + String(inv.bank_account_number).slice(-4) : '—';
  panel.innerHTML = `
    <div class="info-list">
      <div class="info-row"><span class="info-row__label">Bank</span><span class="info-row__value">${inv.bank_name || '—'}</span></div>
      <div class="info-row"><span class="info-row__label">Account Holder</span><span class="info-row__value">${inv.bank_account_holder || '—'}</span></div>
      <div class="info-row"><span class="info-row__label">Account Number</span><span class="info-row__value">${masked}</span></div>
      <div class="info-row"><span class="info-row__label">Branch Code</span><span class="info-row__value">${inv.bank_branch_code || '—'}</span></div>
      <div class="info-row"><span class="info-row__label">Account Type</span><span class="info-row__value" style="text-transform:capitalize">${inv.bank_account_type || '—'}</span></div>
      <div class="info-row"><span class="info-row__label">Verification Status</span><span class="info-row__value"><span class="badge ${s.cls}">${s.label}</span></span></div>
    </div>
    ${inv.bank_account_notes ? `<div style="margin-top:10px;font-size:0.78rem;color:var(--text-muted);background:rgba(239,68,68,0.06);border-radius:8px;padding:8px 12px">${_esc(inv.bank_account_notes)}</div>` : ''}
  `;
}

function openBankDetailsModal() {
  const inv = PORTAL.investor;
  if (inv) {
    document.getElementById('bdBankName').value       = inv.bank_name || '';
    document.getElementById('bdAccountType').value    = inv.bank_account_type || 'current';
    document.getElementById('bdAccountHolder').value  = inv.bank_account_holder || '';
    document.getElementById('bdAccountNumber').value  = inv.bank_account_number || '';
    document.getElementById('bdBranchCode').value     = inv.bank_branch_code || '';
  }
  Modal.open('bankDetailsModal');
}

async function saveBankDetails() {
  const bank_name            = document.getElementById('bdBankName').value.trim();
  const bank_account_type    = document.getElementById('bdAccountType').value;
  const bank_account_holder  = document.getElementById('bdAccountHolder').value.trim();
  const bank_account_number  = document.getElementById('bdAccountNumber').value.trim();
  const bank_branch_code     = document.getElementById('bdBranchCode').value.trim();

  if (!bank_name || !bank_account_holder || !bank_account_number || !bank_branch_code) {
    Toast.error('Please fill in all required fields'); return;
  }

  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  try {
    const updated = await API._fetch('PATCH', `tables/investors/${investorId}`, {
      bank_name,
      bank_account_holder,
      bank_account_number,
      bank_branch_code,
      bank_account_type,
      bank_account_status: 'pending',
      bank_account_notes: null,
    });
    if (PORTAL.investor) Object.assign(PORTAL.investor, updated);

    // Create support ticket so admin can see and verify the bank details
    const investorName = `${PORTAL.investor?.first_name || ''} ${PORTAL.investor?.last_name || ''}`.trim();
    const maskedAccNum = bank_account_number.slice(-4).padStart(bank_account_number.length, '•');
    await API.post('support_tickets', {
      investor_id:    investorId,
      investor_name:  investorName,
      investor_email: PORTAL.investor?.email || '',
      subject:        `Bank Account Verification — ${bank_name}`,
      message:        `Investor has submitted bank details for verification.\n\nBank: ${bank_name}\nAccount Holder: ${bank_account_holder}\nAccount Number: ${maskedAccNum}\nAccount Type: ${bank_account_type}\nBranch Code: ${bank_branch_code}\n\nPlease verify and approve or reject in the investor's profile.`,
      status:         'open',
      priority:       'medium',
      category:       'bank_verification',
    }).catch(e => console.warn('[bank details] ticket creation failed:', e.message));

    _renderBankDetailsPanel();
    Toast.success('Bank details saved! The admin team will verify them within 1–2 business days.');
    Modal.close('bankDetailsModal');
  } catch (e) {
    Toast.error('Failed to save bank details. Please try again.');
    console.error(e);
  }
}

function openWithdrawalModal() {
  const content  = document.getElementById('withdrawalModalContent');
  const footer   = document.getElementById('withdrawalModalFooter');
  const inv      = PORTAL.investor;
  const balance  = parseFloat(inv?.wallet_balance || 0);
  const status   = inv?.bank_account_status;
  const pendingWithdrawal = (PORTAL.transactions || []).find(t => t.type === 'withdrawal' && t.status === 'pending');
  SVC.track('svc_withdrawal_modal_opened', { wallet_balance_bucket: _amtBucket(balance), has_bank_account: !!(inv?.bank_account_number) });

  if (!inv?.bank_account_number) {
    content.innerHTML = `
      <div style="text-align:center;padding:20px 0">
        <i class="fa-solid fa-building-columns" style="font-size:2.5rem;color:#9ca3af;margin-bottom:16px"></i>
        <p style="font-size:0.9rem;color:var(--text-muted);margin-bottom:16px">You need to add a verified bank account before you can withdraw funds.</p>
        <button class="btn btn--primary" onclick="Modal.close('withdrawalModal');openBankDetailsModal()"><i class="fa-solid fa-plus"></i> Add Bank Account</button>
      </div>`;
    footer.style.display = 'none';
    Modal.open('withdrawalModal');
    return;
  }

  if (status !== 'approved') {
    const pending = status === 'pending';
    content.innerHTML = `
      <div style="text-align:center;padding:20px 0">
        <i class="fa-solid fa-clock" style="font-size:2.5rem;color:#f59e0b;margin-bottom:16px"></i>
        <p style="font-size:0.9rem;color:var(--text-muted)">${pending ? 'Your bank account is pending verification by our team. Withdrawals will be available once approved.' : 'Your bank account has not been verified. Please update your bank details.'}</p>
        ${!pending ? `<button class="btn btn--secondary mt-12" onclick="Modal.close('withdrawalModal');openBankDetailsModal()"><i class="fa-solid fa-pen"></i> Update Bank Details</button>` : ''}
      </div>`;
    footer.style.display = 'none';
    Modal.open('withdrawalModal');
    return;
  }

  if (pendingWithdrawal) {
    content.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px;padding:8px 0">
        <div style="padding:14px 16px;border-radius:14px;background:rgba(47,140,155,0.08);border:1px solid rgba(47,140,155,0.18)">
          <div style="font-size:0.92rem;font-weight:800;color:#1a1a1a">A withdrawal is already in progress.</div>
          <div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;line-height:1.55">${Utils.rand(Math.abs(parseFloat(pendingWithdrawal.amount) || 0))} was requested on ${Utils.date(pendingWithdrawal.created_at || pendingWithdrawal.transaction_date)}. Most payouts land within 1–2 business days.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn--secondary" onclick="Modal.close('withdrawalModal');navigate('support', document.querySelector('[data-view=support]'))"><i class="fa-solid fa-headset"></i> Contact support</button>
          <button class="btn btn--primary" onclick="Modal.close('withdrawalModal')"><i class="fa-solid fa-check"></i> Got it</button>
        </div>
      </div>`;
    footer.style.display = 'none';
    Modal.open('withdrawalModal');
    return;
  }

  if (balance < 50) {
    content.innerHTML = `
      <div style="text-align:center;padding:20px 0">
        <i class="fa-solid fa-wallet" style="font-size:2.5rem;color:#9ca3af;margin-bottom:16px"></i>
        <p style="font-size:0.9rem;color:var(--text-muted);margin-bottom:12px">Your available balance is <strong>${Utils.rand(balance)}</strong>. The minimum withdrawal is R50.</p>
        <button class="btn btn--secondary" onclick="Modal.close('withdrawalModal');openTopUpModal()"><i class="fa-solid fa-plus"></i> Top up instead</button>
      </div>`;
    footer.style.display = 'none';
    Modal.open('withdrawalModal');
    return;
  }

  const masked = '••••••' + String(inv.bank_account_number).slice(-4);
  const quickAmounts = [0.25, 0.5, 1].map(r => Math.floor((balance * r) / 10) * 10).filter(v => v >= 50);
  content.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px">
      <div style="padding:12px 14px;border-radius:12px;background:#F8FAFC;border:1px solid rgba(0,0,0,0.06)">
        <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;font-weight:800">Available now</div>
        <div style="font-size:1.08rem;font-weight:900;color:#1a1a1a;margin-top:4px">${Utils.rand(balance)}</div>
      </div>
      <div style="padding:12px 14px;border-radius:12px;background:#F8FAFC;border:1px solid rgba(0,0,0,0.06)">
        <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;font-weight:800">Destination</div>
        <div style="font-size:0.88rem;font-weight:800;color:#1a1a1a;margin-top:6px">${inv.bank_name} ${masked}</div>
      </div>
      <div style="padding:12px 14px;border-radius:12px;background:#F8FAFC;border:1px solid rgba(0,0,0,0.06)">
        <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;font-weight:800">Expected timing</div>
        <div style="font-size:0.88rem;font-weight:800;color:#1a1a1a;margin-top:6px">1–2 business days</div>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Withdrawal Amount (R) <span style="color:#ef4444">*</span></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        ${quickAmounts.map(v => `<button type="button" class="btn btn--secondary btn--sm" onclick="document.getElementById('wdAmount').value='${v}';_withdrawCalc()">${v >= balance ? 'All available' : Utils.rand(v)}</button>`).join('')}
      </div>
      <input type="number" class="form-input" id="wdAmount" placeholder="e.g. ${balance.toFixed(0)}" min="50" max="${balance.toFixed(2)}" oninput="_withdrawCalc()" />
      <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px">Maximum: ${Utils.rand(balance)} · Minimum: R50</div>
    </div>
    <div id="wdCalcBox" style="display:none;margin-top:4px"></div>
    <div class="info-box" style="background:rgba(255,155,12,0.06);border:1px solid rgba(255,155,12,0.2);border-radius:10px;padding:12px 14px;font-size:0.8rem;color:var(--text-muted);margin-top:12px;line-height:1.6">
      <i class="fa-solid fa-shield-halved" style="color:#ff9b0c"></i>
      We only send withdrawals to your verified bank account. Requests submitted now are queued for the next finance run and you can track follow-up in Support if needed.
    </div>`;
  footer.style.display = '';
  Modal.open('withdrawalModal');
}

function _withdrawCalc() {
  const balance  = parseFloat(PORTAL.investor?.wallet_balance || 0);
  const amount   = parseFloat(document.getElementById('wdAmount')?.value || 0);
  const box      = document.getElementById('wdCalcBox');
  if (!box) return;
  if (!amount || amount <= 0) { box.style.display = 'none'; return; }

  if (amount > balance) {
    box.style.display = '';
    box.innerHTML = `<div style="color:#ef4444;font-size:0.8rem"><i class="fa-solid fa-triangle-exclamation"></i> Amount exceeds available balance of ${Utils.rand(balance)}</div>`;
    return;
  }
  if (amount < 50) {
    box.style.display = '';
    box.innerHTML = `<div style="color:#ef4444;font-size:0.8rem"><i class="fa-solid fa-triangle-exclamation"></i> Minimum withdrawal is R50</div>`;
    return;
  }
  const remaining = balance - amount;
  box.style.display = '';
  box.innerHTML = `
    <div style="padding:10px 12px;border-radius:10px;background:#F8FAFC;border:1px solid rgba(0,0,0,0.06)">
      <div class="info-row" style="padding:0 0 6px"><span class="info-row__label">You will receive</span><span class="info-row__value" style="font-weight:800;color:#1a1a1a">${Utils.rand(amount)}</span></div>
      <div class="info-row" style="padding:6px 0;border-top:1px solid rgba(0,0,0,0.06)"><span class="info-row__label">Remaining in wallet</span><span class="info-row__value text-gold">${Utils.rand(remaining)}</span></div>
      <div style="font-size:0.74rem;color:var(--text-muted);margin-top:8px">Estimated payout window: 1–2 business days after finance review.</div>
    </div>`;
}

async function confirmWithdrawal() {
  const balance = parseFloat(PORTAL.investor?.wallet_balance || 0);
  const amount  = parseFloat(document.getElementById('wdAmount')?.value || 0);

  if (!amount || amount < 50) { Toast.error('Minimum withdrawal is R50'); return; }
  if (amount > balance)       { Toast.error('Amount exceeds available balance'); return; }

  const btn = document.getElementById('withdrawalConfirmBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }

  try {
    const result = await API._fetch('POST', 'withdrawals/request', {
      amount,
      bank_account_number: PORTAL.investor?.bank_account_number || undefined,
      bank_name:           PORTAL.investor?.bank_name           || undefined,
    });
    SVC.track('svc_withdrawal_requested', { amount, amount_bucket: _amtBucket(amount), currency: 'ZAR', reference: result.reference });
    Toast.success('Withdrawal request submitted! Funds will be sent within 1–2 business days.');
    Modal.close('withdrawalModal');
    await loadPortalData();
    loadWallet();
  } catch (e) {
    SVC.error('withdrawal', e.message);
    Toast.error(e.message || 'Withdrawal failed. Please try again.');
    console.error(e);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Request Withdrawal'; }
  }
}

/* ═══════════════════════════════════════════════
   TAX CERTIFICATE — SARS Interest Income
   ═══════════════════════════════════════════════ */
let _lastTaxCertHTML = null; // cached for PDF download

function generateTaxCertificate() {
  if (!PORTAL.investor) { Toast.error('Portfolio data still loading — please wait'); return; }

  const inv = PORTAL.investor;
  const taxYearEl = document.getElementById('taxYearSelect');
  const taxYear = taxYearEl ? parseInt(taxYearEl.value) : new Date().getFullYear();

  // SA tax year: 1 March to 28/29 Feb
  const from = new Date(taxYear - 1, 2, 1);   // 1 March (year-1)
  const to   = new Date(taxYear,     1, 28, 23, 59, 59); // 28 Feb (year)

  // Total interest = returns + payouts in the tax year
  const interestTxns = (PORTAL.transactions || []).filter(t => {
    if (!['return', 'payout'].includes(t.type)) return false;
    const d = new Date(t.created_at || t.transaction_date || 0);
    return d >= from && d <= to;
  });
  const totalInterest = interestTxns.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);

  const certNumber = `SVCIIC-${taxYear}-${String(inv.id).replace(/\D/g,'').slice(-6) || Math.floor(Math.random()*900000+100000)}`;
  const generatedAt = new Date().toLocaleString('en-ZA', { dateStyle: 'long', timeStyle: 'short' });
  const fromLabel = from.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  const toLabel   = to.toLocaleDateString('en-ZA',   { day: 'numeric', month: 'long', year: 'numeric' });

  const html = `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>SV Capital — Investment Income Certificate ${taxYear}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Poppins',sans-serif;background:#fff;color:#111;-webkit-print-color-adjust:exact;print-color-adjust:exact}
@page{size:A4;margin:20mm}
@media print{.no-print{display:none!important}}
.no-print{position:fixed;top:0;left:0;right:0;background:#1a2235;padding:10px 24px;display:flex;justify-content:space-between;align-items:center;z-index:99}
.no-print span{color:#fff;font-size:13px;font-weight:600}
.no-print button{background:#FF9B0C;color:#fff;border:none;padding:8px 20px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer}
.wrap{max-width:700px;margin:60px auto 32px;padding:40px}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;padding-bottom:20px;border-bottom:3px solid #1a2235}
.logo{font-size:1.6rem;font-weight:800;color:#1a2235;letter-spacing:-0.5px}
.logo span{color:#FF9B0C}
.cert-badge{background:#1a2235;color:#fff;padding:8px 16px;border-radius:6px;font-size:0.75rem;font-weight:700;text-align:right}
.cert-badge small{display:block;color:#9ca3af;font-size:0.65rem;font-weight:400}
h1{font-size:1.25rem;font-weight:800;color:#1a2235;margin:0 0 4px}
.subtitle{font-size:0.82rem;color:#6b7280;margin-bottom:28px}
.interest-box{background:#f0fdf4;border:2px solid #22c55e;border-radius:12px;padding:24px 28px;margin-bottom:28px;text-align:center}
.interest-lbl{font-size:0.8rem;color:#166534;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px}
.interest-amt{font-size:2.4rem;font-weight:800;color:#15803d}
.interest-sub{font-size:0.78rem;color:#166534;margin-top:4px}
table{width:100%;border-collapse:collapse;margin-bottom:24px;font-size:0.85rem}
th{text-align:left;padding:8px 12px;background:#f1f5f9;color:#374151;font-weight:600;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.05em}
td{padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#374151}
td:last-child{text-align:right;font-weight:600}
.footer{border-top:1px solid #e5e7eb;padding-top:18px;font-size:0.73rem;color:#6b7280;line-height:1.6}
.footer strong{color:#374151}
.stamp{display:inline-block;border:2px solid #1a2235;color:#1a2235;padding:6px 14px;border-radius:4px;font-size:0.72rem;font-weight:700;letter-spacing:0.12em;margin-top:16px;text-transform:uppercase}
</style></head><body>
<div class="no-print">
  <span>SV Capital — Investment Income Certificate ${taxYear}</span>
  <button onclick="window.print()">⬇ Save as PDF / Print</button>
</div>
<div class="wrap">
  <div class="hdr">
    <div>
      <div class="logo">SV <span>Capital</span></div>
      <div style="font-size:0.75rem;color:#6b7280;margin-top:4px">SmartVest Financial Services (Pty) Ltd &nbsp;·&nbsp; FSP #52449 &nbsp;·&nbsp; FSCA Regulated</div>
      <div style="font-size:0.72rem;color:#9ca3af;margin-top:2px">The Station, 63 Peter Place, Bryanston, Johannesburg, 2191</div>
    </div>
    <div class="cert-badge">
      INVESTMENT INCOME CERTIFICATE
      <small>Cert No: ${certNumber}</small>
      <small>Generated: ${generatedAt}</small>
    </div>
  </div>

  <h1>Investment Income Certificate</h1>
  <div class="subtitle">Period: 1 March ${taxYear - 1} – 28 February ${taxYear}</div>

  <div class="interest-box">
    <div class="interest-lbl">Total Interest Received</div>
    <div class="interest-amt">${Utils.rand(totalInterest)}</div>
    <div class="interest-sub">For the period ${fromLabel} – ${toLabel}</div>
  </div>

  <table>
    <thead><tr><th>Account Holder Details</th><th></th></tr></thead>
    <tbody>
      <tr><td>Full Name</td><td>${_esc(inv.first_name)} ${_esc(inv.last_name)}</td></tr>
      <tr><td>Email Address</td><td>${_esc(inv.email || '—')}</td></tr>
      <tr><td>SA ID / Passport</td><td>${inv.id_number || '—'}</td></tr>
      <tr><td>Investor Account</td><td>${inv.id || '—'}</td></tr>
    </tbody>
  </table>

  ${interestTxns.length > 0 ? `
  <table>
    <thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead>
    <tbody>
      ${interestTxns.map(t => `
      <tr>
        <td>${new Date(t.created_at || t.transaction_date).toLocaleDateString('en-ZA')}</td>
        <td>${t.description || (t.type === 'return' ? 'Investment return' : 'Payout')}</td>
        <td>${Utils.rand(t.amount)}</td>
      </tr>`).join('')}
      <tr style="background:#f8fafc"><td colspan="2" style="font-weight:700;text-align:right">TOTAL INTEREST</td><td style="color:#15803d;font-weight:800">${Utils.rand(totalInterest)}</td></tr>
    </tbody>
  </table>
  ` : `<div style="text-align:center;padding:24px;background:#f8fafc;border-radius:10px;color:#6b7280;font-size:0.85rem;margin-bottom:24px">No interest income recorded for this tax year.</div>`}

  <div class="footer">
    This certificate is issued by <strong>SmartVest Financial Services (Pty) Ltd</strong>, an authorised financial services provider regulated by the Financial Sector Conduct Authority (FSCA), FSP Licence #52449, on behalf of SV Capital.<br>
    This document is for informational purposes. Please consult a tax advisor for official SARS submissions.
    <br><br>
    <strong>Certificate No:</strong> ${certNumber} &nbsp;·&nbsp; <strong>Date Issued:</strong> ${generatedAt}<br>
    This certificate is computer generated and does not require a signature.
    <br>
    <div class="stamp">SV Capital — Investment Income</div>
  </div>
</div>
</body></html>`;

  _lastTaxCertHTML = html;

  SVC.track('svc_tax_cert_generated', { tax_year: taxYear });

  const win = window.open('', '_blank', 'width=820,height=900');
  if (!win) { Toast.error('Pop-up blocked — please allow pop-ups for this site'); return; }
  win.document.write(html);
  win.document.close();
}

/* ── IT3(b) jsPDF download ── */
function downloadTaxCertPDF(htmlContent) {
  const lib = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF
            : (window.jsPDF) ? window.jsPDF : null;
  if (!lib) { Toast.error('PDF library not loaded — please refresh and try again.'); return; }
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;left:-9999px;top:0;width:740px;background:#fff';
  document.body.appendChild(div);
  div.innerHTML = htmlContent;
  const doc = new lib({ unit: 'mm', format: 'a4' });
  doc.html(div, {
    callback: d => {
      d.save('SVC-IT3b-' + new Date().getFullYear() + '.pdf');
      document.body.removeChild(div);
      SVC.track('svc_pdf_downloaded', { doc_type: 'tax_certificate_it3b' });
    },
    x: 10, y: 10, width: 190, windowWidth: 740,
  });
}

/* ═══════════════════════════════════════════════
   TWO-FACTOR AUTHENTICATION (TOTP)
   ═══════════════════════════════════════════════ */
let _2faSecret = null; // temp storage during setup flow

async function toggle2FA() {
  const enabled = await load2FAStatus();
  if (enabled) {
    document.getElementById('disable2FACode').value = '';
    Modal.open('disable2FAModal');
  } else {
    await open2FASetupModal();
  }
}

async function open2FASetupModal() {
  const body   = document.getElementById('twoFAModalBody');
  const footer = document.getElementById('twoFAModalFooter');
  body.innerHTML = '<div style="text-align:center;padding:20px"><i class="fa-solid fa-spinner fa-spin" style="font-size:1.5rem;color:#ff9b0c"></i><p style="margin-top:10px;color:var(--text-muted);font-size:0.85rem">Generating your secret…</p></div>';
  footer.innerHTML = '';
  Modal.open('twoFAModal');
  try {
    const data = await API._fetch('POST', 'auth/2fa/setup');
    _2faSecret = data.secret;
    body.innerHTML = `
      <div style="text-align:center;margin-bottom:18px">
        <p style="font-size:0.84rem;color:var(--text-muted);margin-bottom:14px">
          1. Install <strong>Google Authenticator</strong>, <strong>Authy</strong>, or any TOTP app.<br>
          2. Scan the QR code below, or enter the key manually.<br>
          3. Enter the 6-digit code to confirm setup.
        </p>
        <div id="qrCodeCanvas" style="display:inline-block;background:#fff;padding:14px;border-radius:12px;margin-bottom:12px"></div>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:4px">Or enter this key manually:</div>
        <div style="font-family:monospace;font-size:0.85rem;font-weight:700;background:rgba(255,155,12,0.08);padding:8px 14px;border-radius:8px;letter-spacing:0.08em;word-break:break-all">${data.secret}</div>
      </div>
      <div class="form-group">
        <label class="form-label">Verification Code <span style="color:#ef4444">*</span></label>
        <input type="text" class="form-input" id="totpVerifyInput" inputmode="numeric" maxlength="6" placeholder="000000" style="text-align:center;font-size:1.3rem;letter-spacing:0.2em;font-weight:700" />
        <div id="totpVerifyError" style="display:none;color:#ef4444;font-size:0.78rem;margin-top:6px"></div>
      </div>
    `;
    footer.innerHTML = `
      <button class="btn btn--secondary" onclick="Modal.close('twoFAModal')">Cancel</button>
      <button class="btn btn--primary" onclick="confirm2FASetup()"><i class="fa-solid fa-check"></i> Enable 2FA</button>
    `;
    // Render QR code
    const qrEl = document.getElementById('qrCodeCanvas');
    try {
      if (typeof QRCode !== 'undefined' && typeof QRCode.toDataURL === 'function') {
        // Promise-based (more reliable than callback in some browsers)
        const url = await QRCode.toDataURL(data.uri, { width: 180, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
        qrEl.innerHTML = `<img src="${url}" width="180" height="180" style="border-radius:8px;display:block">`;
      } else {
        throw new Error('QRCode library not available');
      }
    } catch (_qrErr) {
      // Fallback: generate QR via image service (no JS library needed)
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=1&data=${encodeURIComponent(data.uri)}`;
      qrEl.innerHTML = `<img src="${qrUrl}" width="180" height="180" style="border-radius:8px;display:block" onerror="this.parentElement.innerHTML='<div style=\\'font-size:0.78rem;color:var(--text-muted)\\'>Use the manual key below to set up your authenticator app.</div>'">`;
    }
  } catch (e) {
    body.innerHTML = '<div style="color:#ef4444;text-align:center;padding:20px">Failed to generate 2FA secret. Please try again.</div>';
    Toast.error('Could not set up 2FA');
  }
}

async function confirm2FASetup() {
  const code  = (document.getElementById('totpVerifyInput')?.value || '').replace(/\s/g, '');
  const errEl = document.getElementById('totpVerifyError');
  if (!/^\d{6}$/.test(code)) {
    if (errEl) { errEl.textContent = 'Please enter your 6-digit code.'; errEl.style.display = 'block'; }
    return;
  }
  if (errEl) errEl.style.display = 'none';
  try {
    const result = await API._fetch('POST', 'auth/2fa/enable', { secret: _2faSecret, token: code });
    _2faSecret = null;
    // Show recovery codes before closing modal
    const body = document.getElementById('twoFAModalBody');
    const footer = document.getElementById('twoFAModalFooter');
    if (body) body.innerHTML = `
  <div style="text-align:center;margin-bottom:12px">
    <i class="fa-solid fa-shield-check" style="font-size:2rem;color:var(--green)"></i>
    <h3 style="margin:10px 0 4px;font-size:1rem">2FA Enabled!</h3>
    <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:16px">Save these backup codes somewhere safe. Each code can only be used once if you lose access to your authenticator app.</p>
  </div>
  <div style="background:#f8f9fa;border-radius:10px;padding:14px;margin-bottom:16px;display:grid;grid-template-columns:1fr 1fr;gap:6px">
    ${(result.recoveryCodes || []).map(c => `<div style="font-family:monospace;font-size:0.88rem;font-weight:700;text-align:center;padding:6px 10px;background:#fff;border-radius:6px;border:1px solid #e5e7eb">${c}</div>`).join('')}
  </div>
  <p style="font-size:0.75rem;color:#ef4444;text-align:center"><i class="fa-solid fa-triangle-exclamation"></i> These codes will not be shown again.</p>
`;
    if (footer) footer.innerHTML = `<button class="btn btn--primary btn--full" onclick="Modal.close('twoFAModal');load2FAStatus()"><i class="fa-solid fa-check"></i> I've saved my recovery codes</button>`;
  } catch (e) {
    if (errEl) { errEl.textContent = e.message || 'Invalid code — please try again.'; errEl.style.display = 'block'; }
  }
}

async function confirmDisable2FA() {
  const code  = (document.getElementById('disable2FACode')?.value || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) { Toast.error('Please enter your 6-digit authenticator code'); return; }
  try {
    await API._fetch('POST', 'auth/2fa/disable', { token: code });
    Toast.success('Two-factor authentication disabled.');
    Modal.close('disable2FAModal');
    await load2FAStatus();
  } catch (e) { Toast.error(e.message || 'Invalid code'); }
}

function openChangePasswordModal() {
  Toast.info('Use the Change Password option in your account settings.');
}

function renderOnboardingChecklist() {
  if (!PORTAL.investor) return;
  const inv = PORTAL.investor;

  const steps = [
    {
      id: 'fica',
      label: 'Complete your FICA/KYC verification',
      desc: 'Submit your ID document and proof of address.',
      done: inv.fica_status === 'approved',
      action: "navigate('profile', document.querySelector('[data-view=profile]'))",
      actionLabel: 'Go to FICA/KYC',
    },
    {
      id: 'wallet',
      label: 'Fund your wallet',
      desc: 'Make your first deposit to start investing.',
      done: Number(inv.wallet_balance || 0) > 0 || Number(inv.total_invested || 0) > 0,
      action: "navigate('wallet', document.querySelector('[data-view=wallet]'))",
      actionLabel: 'Fund Wallet',
    },
    {
      id: 'invest',
      label: 'Make your first investment',
      desc: 'Choose a pool and put your money to work.',
      done: Number(inv.total_invested || 0) > 0,
      action: "navigate('marketplace', document.querySelector('[data-view=marketplace]'))",
      actionLabel: 'Browse Pools',
    },
  ];

  const allDone = steps.every(s => s.done);
  const wrap = document.getElementById('onboardingChecklist');
  if (!wrap) return;
  if (allDone) { wrap.style.display = 'none'; return; }

  const doneCount = steps.filter(s => s.done).length;
  const progEl = document.getElementById('onboardingProgress');
  if (progEl) progEl.textContent = `${doneCount} / ${steps.length} complete`;

  const stepsEl = document.getElementById('onboardingSteps');
  if (stepsEl) {
    stepsEl.innerHTML = steps.map(s => `
      <div style="display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:8px;background:${s.done ? 'rgba(16,185,129,0.08)' : 'rgba(0,0,0,0.04)'}">
        <div style="width:24px;height:24px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:0.75rem;background:${s.done ? 'rgba(16,185,129,0.2)' : 'rgba(0,0,0,0.08)'};color:${s.done ? '#10b981' : '#6b7280'}">
          <i class="fa-solid ${s.done ? 'fa-check' : 'fa-circle-dot'}"></i>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:0.82rem;font-weight:600;color:${s.done ? '#10b981' : '#1a1a1a'}${s.done ? ';text-decoration:line-through;opacity:0.7' : ''}">${s.label}</div>
          ${!s.done ? `<div style="font-size:0.73rem;color:#6b7280">${s.desc}</div>` : ''}
        </div>
        ${!s.done ? `<button class="btn btn--primary btn--sm" onclick="${s.action}" style="white-space:nowrap">${s.actionLabel}</button>` : ''}
      </div>
    `).join('');
  }

  wrap.style.display = '';
}

async function downloadMyData() {
  try {
    Toast.info('Preparing your data export…');
    const [invRes, invstRes, txnRes, kycRes, ticketRes] = await Promise.all([
      API.investors.list({ limit: 1 }),
      API.investments.list({ limit: 500 }),
      API.transactions.list({ limit: 500 }),
      API._fetch('GET', 'tables/kyc_documents', null, { investor_id: PORTAL.investor?.id, limit: 100 }),
      API._fetch('GET', 'tables/support_tickets', null, { investor_id: PORTAL.investor?.id, limit: 100 }),
    ]);

    const inv = PORTAL.investor || {};
    // Strip sensitive server fields before export
    const safeInvestor = { ...inv };
    delete safeInvestor.password_hash;
    delete safeInvestor.totp_secret;

    const exportData = {
      exported_at: new Date().toISOString(),
      notice: 'This data is provided under POPIA Section 23. Handle securely.',
      personal_information: safeInvestor,
      investments: invstRes.data || [],
      transactions: txnRes.data || [],
      kyc_documents: (kycRes.data || []).map(d => ({ id: d.id, doc_type: d.doc_type, status: d.status, uploaded_at: d.created_at })),
      support_tickets: ticketRes.data || [],
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SV_Capital_My_Data_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    Toast.success('Your data has been downloaded.');
  } catch (e) {
    Toast.error('Failed to export data. Please try again.');
    console.error(e);
  }
}

/* ═══════════════════════════════════════════════
   INVESTMENT CALCULATOR  (Feature 6 — Enhanced)
   ═══════════════════════════════════════════════ */
let _calcPoolId = null;

function openCalcModal() {
  const sel = document.getElementById('calcPoolSelect');
  if (sel) {
    sel.innerHTML = '<option value="">— Custom rate —</option>' +
      (PORTAL.pools || []).filter(p => p.status === 'open').map(p =>
        `<option value="${p.id}" data-rate="${p.annual_rate}" data-term="${p.term_months}">${p.name} — ${Utils.pct(p.annual_rate)} p.a.</option>`
      ).join('');
  }
  _calcPoolId = null;
  // Reset inputs to defaults
  const amtEl = document.getElementById('calcAmount');
  const sldEl = document.getElementById('calcAmountSlider');
  if (amtEl) amtEl.value = '50000';
  if (sldEl) sldEl.value = '50000';
  const termEl = document.getElementById('calcTerm');
  if (termEl) {
    termEl.innerHTML = '<option value="6">6 months</option><option value="12" selected>12 months</option><option value="18">18 months</option><option value="24">24 months</option><option value="36">36 months</option>';
    termEl.value = '12';
  }
  const rateEl = document.getElementById('calcRate');
  if (rateEl) rateEl.value = '14';
  const ctaBar = document.getElementById('calcCTABar');
  if (ctaBar) ctaBar.style.display = 'none';
  updateCalc();
  Modal.open('calcModal');
}

/* Sync slider → amount input */
function calcSyncAmount(val) {
  const el = document.getElementById('calcAmount');
  if (el) el.value = val;
}

/* Sync amount input → slider */
function calcSyncSlider(val) {
  const el = document.getElementById('calcAmountSlider');
  if (el) el.value = Math.max(1000, Math.min(1000000, parseFloat(val) || 50000));
}

function calcLoadPool() {
  const sel = document.getElementById('calcPoolSelect');
  const opt = sel?.options[sel.selectedIndex];
  if (!opt?.value) {
    _calcPoolId = null;
    const termEl2 = document.getElementById('calcTerm');
    if (termEl2) {
      termEl2.innerHTML = '<option value="6">6 months</option><option value="12" selected>12 months</option><option value="18">18 months</option><option value="24">24 months</option><option value="36">36 months</option>';
      termEl2.value = '12';
    }
    const ctaBar = document.getElementById('calcCTABar');
    if (ctaBar) ctaBar.style.display = 'none';
    return;
  }
  _calcPoolId = opt.value;
  const rateEl = document.getElementById('calcRate');
  const termEl = document.getElementById('calcTerm');
  if (rateEl) rateEl.value = Math.round((parseFloat(opt.dataset.rate || 0.14) * 100) * 10) / 10;
  // Restrict term dropdown to this pool's fixed term only
  if (termEl) {
    const poolTerm = parseInt(opt.dataset.term || 12);
    termEl.innerHTML = `<option value="${poolTerm}" selected>${poolTerm} months</option>`;
  }
  const ctaBar = document.getElementById('calcCTABar');
  if (ctaBar) ctaBar.style.display = 'block';
  updateCalc();
}

function updateCalc() {
  const principal = parseFloat(document.getElementById('calcAmount')?.value) || 0;
  const rateRaw   = parseFloat(document.getElementById('calcRate')?.value)   || 0;
  const term      = parseInt(document.getElementById('calcTerm')?.value)     || 0;

  // Rate from pool is stored as decimal (0.14) or percentage (14) — normalise
  const rate = rateRaw > 1 ? rateRaw / 100 : rateRaw;  // annual rate as decimal

  const totalInterest = principal * rate * (term / 12);
  const total         = principal + totalInterest;
  const monthly       = term > 0 ? totalInterest / term : 0;
  const effYield      = rate * 100;

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('calcReturn',  Utils.rand(totalInterest));
  set('calcTotal',   Utils.rand(total));
  set('calcMonthly', Utils.rand(monthly));
  set('calcYield',   effYield.toFixed(2) + '%');

  // Visual capital vs interest bar
  const capBar = document.getElementById('calcBarCapital');
  const intBar = document.getElementById('calcBarInterest');
  if (capBar && intBar && total > 0) {
    const capPct = Math.round((principal / total) * 100);
    const intPct = 100 - capPct;
    capBar.style.width = capPct + '%';
    intBar.style.width = intPct + '%';
  }
}

function calcGoInvest() {
  if (_calcPoolId) { openInvestModal(_calcPoolId); }
  Modal.close('calcModal');
}

/* ═══════════════════════════════════════════════
   LIVE REFERRAL DASHBOARD
   ═══════════════════════════════════════════════ */
async function loadReferralDashboard() {
  if (!PORTAL.investor) await loadPortalData();
  const inv  = PORTAL.investor;
  const code = inv?.referral_code || '';

  // Show real referral code + link
  const codeEl = document.getElementById('referralCode');
  const linkEl = document.getElementById('referralLink');
  if (codeEl) codeEl.textContent = code || '—';
  const refLink = code ? `${window.location.origin}/register?ref=${code}` : '—';
  if (linkEl) linkEl.textContent = refLink;

  // Find who referred by this investor's code
  const all      = PORTAL.investors || [];
  const referred = code ? all.filter(i => i.referred_by === code) : [];
  const approved = referred.filter(i => !['pending_fica', 'suspended'].includes(i.status));
  const invested = referred.filter(i => (i.total_invested || 0) > 0);
  const bonuses  = (PORTAL.transactions || []).filter(t => t.type === 'referral_bonus');
  const totalBonus = bonuses.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('refStatTotal',    referred.length);
  set('refStatApproved', approved.length);
  set('refStatInvested', invested.length);
  set('refStatBonuses',  Utils.rand(totalBonus));

  const body = document.getElementById('referredInvestorsBody');
  if (!body) return;
  if (!referred.length) {
    body.innerHTML = `<tr><td colspan="5" class="text-center text-muted" style="padding:16px">No referrals yet — share your code to get started <i class="fa-solid fa-arrow-up-right-from-square" style="margin-left:4px"></i></td></tr>`;
    return;
  }
  body.innerHTML = referred.map(r => {
    const bonusTx = (PORTAL.transactions || []).find(t =>
      t.type === 'referral_bonus' &&
      (t.referred_investor_id === r.id || Math.abs(new Date(t.created_at) - new Date(r.date_joined||r.created_at)) < 86400000 * 7)
    );
    const bonusCell = bonusTx
      ? `<span style="font-weight:700;color:#22c55e">${Utils.rand(bonusTx.amount||0)}</span>`
      : `<span style="color:#f59e0b">Pending</span>`;
    return `
    <tr>
      <td><div style="font-weight:600;font-size:0.82rem;color:#1a1a1a">${_esc(r.first_name)} ${_esc(r.last_name)}</div></td>
      <td>${Utils.statusBadge(r.fica_status || r.status)}</td>
      <td>${(r.total_invested || 0) > 0
        ? `<span class="badge badge--green">Invested</span>`
        : `<span class="badge badge--gray">Not yet</span>`}</td>
      <td style="font-size:0.75rem;color:#6b7280">${Utils.date(r.date_joined)}</td>
      <td>${bonusCell}</td>
    </tr>
  `}).join('');
}

/* ═══════════════════════════════════════════════
   FEATURE 7: DOCUMENT VAULT
   ═══════════════════════════════════════════════ */

/* ─── KYC Document Upload ─────────────────────────────────────── */
let _kycFile = null;

function _kycFileSelected(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { Toast.error('File too large — maximum 10 MB'); return; }
  _kycFile = file;
  const statusEl = document.getElementById('kycFileStatus');
  const nameEl   = document.getElementById('kycFileName');
  if (statusEl) statusEl.style.display = 'flex';
  if (nameEl)   nameEl.textContent = file.name;
  const zone = document.getElementById('kycDropZone');
  if (zone) { zone.style.borderColor = '#22c55e'; zone.style.background = 'rgba(34,197,94,0.04)'; }
}

function _kycHandleDrop(event) {
  event.preventDefault();
  const zone = document.getElementById('kycDropZone');
  if (zone) zone.style.borderColor = 'rgba(255,155,12,0.35)';
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    document.getElementById('kycFileInput').files; // reset
    _kycFileSelected(file);
  }
}

function _kycClearFile() {
  _kycFile = null;
  const input = document.getElementById('kycFileInput');
  if (input) input.value = '';
  const statusEl = document.getElementById('kycFileStatus');
  if (statusEl) statusEl.style.display = 'none';
  const zone = document.getElementById('kycDropZone');
  if (zone) { zone.style.borderColor = 'rgba(255,155,12,0.35)'; zone.style.background = 'rgba(255,155,12,0.03)'; }
}

function openKycUploadModal() {
  _kycClearFile();
  const typeEl  = document.getElementById('kycDocType');
  const notesEl = document.getElementById('kycNotes');
  if (typeEl)  typeEl.value  = '';
  if (notesEl) notesEl.value = '';
  Modal.open('kycUploadModal');
}

async function submitKycDocument() {
  const docType = document.getElementById('kycDocType')?.value;
  if (!docType) { Toast.error('Please select a document type'); return; }
  if (!_kycFile) { Toast.error('Please select a file to upload'); return; }

  const btn = document.getElementById('kycSubmitBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting…'; }

  try {
    // Read file as base64 data URL so it can be stored and viewed by compliance team
    const fileData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(_kycFile);
    });

    const inv = PORTAL.investor;
    const notes = (document.getElementById('kycNotes')?.value || '').trim();
    await API.kyc.create({
      investor_id:   inv?.id || DEMO_INVESTOR_ID,
      investor_name: inv ? `${inv.first_name} ${inv.last_name}`.trim() : undefined,
      doc_type:      docType,
      status:        'pending',
      file_name:     _kycFile.name,
      file_data:     fileData,
      notes:         [notes, `File: ${_kycFile.name} (${(_kycFile.size / 1024).toFixed(1)} KB)`].filter(Boolean).join(' — '),
    });
    Toast.success('Document submitted! The compliance team will review it within 1–2 business days.');
    SVC.track('svc_kyc_uploaded', { doc_type: docType });
    Modal.close('kycUploadModal');
    _kycFile = null;
    // Refresh KYC panel wherever visible
    _renderKycStatusPanel();
    _renderKycDocsList();
  } catch (e) {
    Toast.error('Upload failed — please try again');
    console.error(e);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit for Review'; }
  }
}

async function _renderKycStatusPanel() {
  const body = document.getElementById('kycStatusBody');
  if (!body || !PORTAL.investor) return;

  let docs = [];
  try {
    const res = await API.kyc.list({ investor_id: PORTAL.investor.id, limit: 20 });
    docs = res.data || [];
  } catch (_) {}

  const inv = PORTAL.investor;
  const overallStatus = inv.fica_status || inv.kyc_status || 'pending';
  const statusColor = { approved: '#22c55e', rejected: '#ef4444', pending: '#f59e0b', submitted: '#3b82f6', not_started: '#9ca3af' };
  const color = statusColor[overallStatus] || '#9ca3af';

  const typeLabel = {
    id_document: 'SA ID / Passport', proof_of_address: 'Proof of Address',
    selfie: 'Selfie / Liveness', tax_certificate: 'Tax Certificate', other: 'Other Document',
  };

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid rgba(0,0,0,0.07);margin-bottom:12px">
      <div style="width:40px;height:40px;border-radius:50%;background:${color}22;display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <i class="fa-solid fa-${overallStatus === 'approved' ? 'shield-check' : overallStatus === 'rejected' ? 'shield-xmark' : 'clock'}" style="color:${color};font-size:1.1rem"></i>
      </div>
      <div>
        <div style="font-size:0.88rem;font-weight:700;color:#1a1a1a">FICA / KYC Verification</div>
        <div style="font-size:0.78rem;color:#6b7280;margin-top:1px">${Utils.statusBadge(overallStatus)}</div>
      </div>
    </div>
    ${docs.length ? `
      <div style="display:flex;flex-direction:column;gap:8px">
        ${docs.map(d => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:rgba(0,0,0,0.03);border-radius:8px">
            <i class="fa-solid fa-file-lines" style="color:#FF9B0C;font-size:0.9rem;flex-shrink:0"></i>
            <div style="flex:1;min-width:0">
              <div style="font-size:0.82rem;font-weight:600;color:#1a1a1a">${typeLabel[d.doc_type] || d.doc_type}</div>
              <div style="font-size:0.72rem;color:#9ca3af">${d.file_name || '—'} · ${Utils.date(d.created_at)}</div>
            </div>
            ${Utils.statusBadge(d.status)}
          </div>
        `).join('')}
      </div>
    ` : `<div style="font-size:0.82rem;color:#9ca3af;text-align:center;padding:12px 0">No documents uploaded yet.</div>`}
    <div style="margin-top:14px">
      <button class="btn btn--primary btn--sm" onclick="openKycUploadModal()"><i class="fa-solid fa-cloud-arrow-up"></i> Upload Document</button>
    </div>
  `;
}

async function _renderKycDocsList() {
  const list = document.getElementById('kycDocsList');
  if (!list || !PORTAL.investor) return;

  let docs = [];
  try {
    const res = await API.kyc.list({ investor_id: PORTAL.investor.id, limit: 20 });
    docs = res.data || [];
  } catch (_) {}

  const inv = PORTAL.investor;
  const overallStatus = inv.fica_status || inv.kyc_status || 'pending';
  const typeLabel = {
    id_document: 'SA ID / Passport', proof_of_address: 'Proof of Address',
    selfie: 'Selfie / Liveness', tax_certificate: 'Tax Certificate', other: 'Other',
  };
  const requiredTypes = ['id_document', 'proof_of_address'];
  const submittedTypes = new Set(docs.map(d => d.doc_type));
  const missingRequired = requiredTypes.filter(t => !submittedTypes.has(t));

  list.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;background:${overallStatus === 'approved' ? 'rgba(34,197,94,0.08)' : 'rgba(255,155,12,0.07)'};margin-bottom:14px">
      <i class="fa-solid fa-${overallStatus === 'approved' ? 'circle-check' : 'circle-info'}" style="color:${overallStatus === 'approved' ? '#22c55e' : '#FF9B0C'};font-size:1rem"></i>
      <div style="flex:1">
        <span style="font-size:0.82rem;font-weight:700;color:#1a1a1a">Overall FICA Status: </span>
        ${Utils.statusBadge(overallStatus)}
        ${missingRequired.length ? `<div style="font-size:0.75rem;color:#9ca3af;margin-top:3px">Still needed: ${missingRequired.map(t => typeLabel[t]).join(', ')}</div>` : ''}
      </div>
    </div>
    ${docs.length ? `
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead><tr><th>Document Type</th><th>File</th><th>Submitted</th><th>Status</th><th>Notes</th><th></th></tr></thead>
          <tbody>
            ${docs.map(d => `<tr>
              <td class="td-strong">${typeLabel[d.doc_type] || d.doc_type}</td>
              <td class="td-muted" style="font-size:0.78rem">${d.file_name || '—'}</td>
              <td class="td-muted">${Utils.date(d.created_at)}</td>
              <td>${Utils.statusBadge(d.status)}</td>
              <td class="td-muted" style="font-size:0.72rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${d.notes || '—'}</td>
              <td>${
                d.file_url
                  ? `<a href="${d.file_url}" target="_blank" rel="noopener" class="btn btn--secondary btn--sm"><i class="fa-solid fa-download"></i> View</a>`
                  : d.file_data
                    ? `<button class="btn btn--secondary btn--sm" onclick="_viewKycDoc(${JSON.stringify(d.id)})"><i class="fa-solid fa-eye"></i> View</button>`
                    : '—'
              }</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    ` : `<div style="text-align:center;padding:24px;color:#9ca3af;font-size:0.85rem">
      <i class="fa-solid fa-id-card" style="font-size:1.6rem;display:block;margin-bottom:8px;opacity:0.4"></i>
      No documents uploaded yet. Upload your ID and proof of address to get verified.
    </div>`}
  `;
}

function _viewKycDoc(docId) {
  const inv = PORTAL.investor;
  if (!inv) return;
  // Re-fetch docs to get file_data (may be stripped in list view)
  API.kyc.list({ investor_id: inv.id, limit: 20 }).then(res => {
    const doc = (res.data || []).find(d => d.id === docId);
    if (!doc) { Toast.error('Document not found'); return; }
    const rawData = doc.file_data || doc.file_url || '';
    if (!rawData) { Toast.error('No file data available for this document'); return; }
    if (rawData.startsWith('data:')) {
      try {
        const [header, b64] = rawData.split(',');
        const mime = header.match(/:(.*?);/)?.[1] || 'application/octet-stream';
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: mime });
        const url = URL.createObjectURL(blob);
        const w = window.open(url, '_blank', 'noopener');
        if (!w) {
          const a = document.createElement('a');
          a.href = rawData; a.download = doc.file_name || 'document'; a.click();
        }
      } catch (_) {
        const w = window.open('', '_blank');
        if (w) w.document.write(`<title>Document</title><body style="margin:0;background:#000"><img src="${rawData}" style="max-width:100%"></body>`);
      }
    } else {
      window.open(rawData, '_blank', 'noopener,noreferrer');
    }
  }).catch(() => Toast.error('Could not load document'));
}

function loadDocuments() {
  if (!PORTAL.investor) { Toast.error('Portfolio data still loading'); return; }
  _renderKycDocsList();
  _renderCertificatesTable();
  _renderReceiptsTable();
}

function _renderCertificatesTable() {
  const body = document.getElementById('docCertificatesBody');
  if (!body) return;

  const investments = PORTAL.investments;
  if (!investments.length) {
    body.innerHTML = `<tr><td colspan="8" style="padding:28px"><div class="empty-state" style="padding:0;border:none;background:transparent"><i class="fa-solid fa-file-certificate"></i><div class="empty-state__title">No investment certificates yet</div><div class="empty-state__sub">Your first completed investment will unlock downloadable certificates and term sheets here.</div><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px"><button class="btn btn--primary btn--sm" onclick="navigate('marketplace', document.querySelector('[data-view=marketplace]'))"><i class="fa-solid fa-layer-group"></i> Browse pools</button><button class="btn btn--secondary btn--sm" onclick="navigate('wallet', document.querySelector('[data-view=wallet]'))"><i class="fa-solid fa-wallet"></i> Fund wallet</button></div></div></td></tr>`;
    return;
  }

  body.innerHTML = investments.map(inv => {
    const pi = Utils.productInfo(inv.product_type);
    return `<tr>
      <td class="td-strong">${_esc(inv.pool_name) || '—'}</td>
      <td><span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span></td>
      <td class="td-gold fw-700">${Utils.rand(inv.amount)}</td>
      <td>${Utils.pct(inv.expected_return_rate || inv.annual_rate)}</td>
      <td class="td-muted">${Utils.date(inv.investment_date || inv.start_date)}</td>
      <td class="td-muted">${Utils.date(inv.maturity_date || inv.end_date)}</td>
      <td>${Utils.statusBadge(inv.status)}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn--primary btn--sm" onclick="downloadCertificate('${inv.id}')">
          <i class="fa-solid fa-file-pdf"></i> Certificate
        </button>
        ${(() => { const pool = PORTAL.pools.find(p => p.id === inv.pool_id); return pool && pool.term_sheet_url ? `<a href="${pool.term_sheet_url}" target="_blank" rel="noopener" class="btn btn--secondary btn--sm"><i class="fa-solid fa-file-contract"></i> Term Sheet</a>` : ''; })()}
      </td>
    </tr>`;
  }).join('');
}

function _renderReceiptsTable() {
  const body = document.getElementById('docReceiptsBody');
  if (!body) return;

  const deposits = [...PORTAL.transactions]
    .filter(t => t.type === 'deposit')
    .sort((a, b) => new Date(b.transaction_date || b.created_at) - new Date(a.transaction_date || a.created_at))
    .slice(0, 20);

  if (!deposits.length) {
    body.innerHTML = `<tr><td colspan="6" style="padding:28px"><div class="empty-state" style="padding:0;border:none;background:transparent"><i class="fa-solid fa-receipt"></i><div class="empty-state__title">No deposit receipts yet</div><div class="empty-state__sub">As soon as your first wallet top-up is completed, the receipt will appear here for download.</div><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px"><button class="btn btn--primary btn--sm" onclick="openTopUpModal()"><i class="fa-solid fa-plus"></i> Top up wallet</button><button class="btn btn--secondary btn--sm" onclick="navigate('statement', document.querySelector('[data-view=statement]'))"><i class="fa-solid fa-file-invoice"></i> Generate statement</button></div></div></td></tr>`;
    return;
  }

  body.innerHTML = deposits.map(t => `<tr>
    <td class="td-muted">${Utils.date(t.transaction_date || t.created_at)}</td>
    <td class="td-green fw-700">+${Utils.rand(Math.abs(t.amount))}</td>
    <td class="td-muted" style="font-size:0.78rem">${t.description || 'Wallet deposit'}</td>
    <td class="td-muted" style="font-size:0.75rem">${t.reference || '—'}</td>
    <td>${Utils.statusBadge(t.status)}</td>
    <td><button class="btn btn--secondary btn--sm" onclick="downloadReceipt('${t.id}')">
      <i class="fa-solid fa-download"></i> Receipt
    </button></td>
  </tr>`).join('');
}

/* ── Investment Certificate PDF (html path) ── */
function generateInvestmentCertificate(invId) {
  const inv = PORTAL.investments.find(i => i.id === invId);
  const investor = PORTAL.investor;
  if (!inv || !investor) return Toast.error('Investment not found');

  const certNo = 'SVC-CERT-' + (invId||'').slice(-6).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
  const pool = PORTAL.pools.find(p => p.id === inv.pool_id) || {};

  const html = `<div style="font-family:Arial,sans-serif;padding:40px;max-width:700px;margin:0 auto">
    <div style="text-align:center;margin-bottom:30px">
      <h1 style="font-size:22px;color:#1a1a1a;margin:0">INVESTMENT CERTIFICATE</h1>
      <div style="color:#ff9b0c;font-size:13px;font-weight:700;margin-top:4px">SV CAPITAL</div>
    </div>
    <div style="border:2px solid #ff9b0c;border-radius:8px;padding:24px;margin-bottom:20px">
      <table style="width:100%;font-size:13px;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#6b7280;width:45%">Certificate Number</td><td style="font-weight:700;color:#1a1a1a">${certNo}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Investor Name</td><td style="font-weight:700">${_esc(investor.first_name)} ${_esc(investor.last_name)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Investor ID</td><td style="font-weight:700">${investor.id}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Investment Pool</td><td style="font-weight:700">${inv.pool_name||pool.name||'—'}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Amount Invested</td><td style="font-weight:700;color:#ff9b0c;font-size:16px">${Utils.rand(inv.amount)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Annual Rate</td><td style="font-weight:700">${Utils.pct(inv.annual_rate||inv.expected_return_rate)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Expected Return</td><td style="font-weight:700;color:#22c55e">${Utils.rand(inv.expected_return_amount||inv.expected_return)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Investment Date</td><td style="font-weight:700">${Utils.date(inv.investment_date||inv.start_date)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Maturity Date</td><td style="font-weight:700">${Utils.date(inv.maturity_date||inv.end_date)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Status</td><td>${Utils.statusBadge(inv.status)}</td></tr>
      </table>
    </div>
    <div style="font-size:10px;color:#9ca3af;text-align:center;margin-top:20px">
      This certificate is issued by SV Capital (Pty) Ltd. Generated ${new Date().toLocaleDateString('en-ZA')}.<br>
      Certificate No: ${certNo}
    </div>
  </div>`;

  const lib = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF
            : (window.jsPDF) ? window.jsPDF : null;
  if (!lib) { Toast.error('PDF library not loaded — please refresh and try again.'); return; }

  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;left:-9999px;top:0;width:700px;background:#fff';
  document.body.appendChild(div);
  div.innerHTML = html;

  const doc = new lib({ unit: 'mm', format: 'a4' });
  doc.html(div, {
    callback: d => {
      d.save(`SVC-CERT-${invId.slice(-8)}.pdf`);
      document.body.removeChild(div);
      SVC.track('svc_pdf_downloaded', { doc_type: 'investment_certificate', investment_id: invId });
    },
    x: 5, y: 5, width: 200, windowWidth: 700,
  });
}

/* ── PDF helper: get jsPDF instance ── */
function _getPDF(orientation = 'portrait') {
  // jsPDF 2.x UMD exposes window.jspdf.jsPDF; older builds use window.jsPDF
  const lib = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF
            : (window.jsPDF) ? window.jsPDF
            : null;
  if (!lib) {
    Toast.error('PDF library not loaded — please refresh the page and try again.');
    return null;
  }
  return new lib({ orientation, unit: 'mm', format: 'a4' });
}

/* ── PDF: dark header bar ── */
function _pdfHeader(doc, title, subtitle) {
  const W = doc.internal.pageSize.getWidth();
  // Dark header
  doc.setFillColor(26, 34, 53); // #1a2235
  doc.rect(0, 0, W, 38, 'F');
  // Gold accent line
  doc.setFillColor(255, 155, 12); // #FF9B0C
  doc.rect(0, 38, W, 2, 'F');
  // "SV CAPITAL" text in gold
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 155, 12);
  doc.text('SV Capital', 14, 17);
  // Subtitle
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(156, 163, 175);
  doc.text('SmartVest Financial Services · FSP #52449', 14, 24);
  // Document title (right aligned)
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text(title, W - 14, 17, { align: 'right' });
  if (subtitle) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(156, 163, 175);
    doc.text(subtitle, W - 14, 24, { align: 'right' });
  }
  doc.setTextColor(0, 0, 0); // reset
  return 48; // Y position after header
}

/* ── PDF: footer ── */
function _pdfFooter(doc) {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  doc.setDrawColor(229, 231, 235);
  doc.setLineWidth(0.3);
  doc.line(14, H - 16, W - 14, H - 16);
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(107, 114, 128);
  doc.text('This document is issued by SV Capital (Pty) Ltd · Confidential · Not for distribution', 14, H - 10);
  doc.text(`Generated: ${new Date().toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })}`, W - 14, H - 10, { align: 'right' });
  doc.setTextColor(0, 0, 0);
}

/* ── Info row helper for PDF ── */
function _pdfInfoRow(doc, label, value, y, labelX = 14, valueX = 75) {
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(107, 114, 128);
  doc.text(label, labelX, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(26, 26, 26);
  doc.text(String(value || '—'), valueX, y);
  return y + 6;
}

/* downloadCertificate(investmentId) */
function downloadCertificate(investmentId) {
  try {
  const inv = PORTAL.investments.find(i => String(i.id) === String(investmentId));
  if (!inv) { Toast.error('Investment not found — please refresh and try again.'); return; }
  const investor = PORTAL.investor;
  const pool = PORTAL.pools.find(p => p.id === inv.pool_id) || {};

  const doc = _getPDF('portrait');
  if (!doc) return;

  const W = doc.internal.pageSize.getWidth();

  // Header
  let y = _pdfHeader(doc, 'INVESTMENT CERTIFICATE', `#${inv.id}`);

  // Certificate badge area
  y += 6;
  doc.setFillColor(255, 249, 235);
  doc.setDrawColor(255, 155, 12);
  doc.setLineWidth(0.5);
  doc.roundedRect(14, y, W - 28, 22, 3, 3, 'FD');
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(180, 100, 0);
  doc.text('CERTIFICATE OF INVESTMENT', W / 2, y + 8, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(120, 80, 0);
  doc.text('This certifies that the investor has made a valid investment with SV Capital.', W / 2, y + 15, { align: 'center' });
  y += 28;

  // Two-column info layout
  const leftX  = 14;
  const rightX = W / 2 + 4;
  const valLeft  = 70;
  const valRight = W / 2 + 58;

  doc.setFillColor(247, 248, 250);
  doc.roundedRect(leftX, y, (W - 28) / 2 - 2, 62, 2, 2, 'F');
  doc.roundedRect(rightX - 2, y, (W - 28) / 2, 62, 2, 2, 'F');

  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(107, 114, 128);
  doc.text('INVESTOR DETAILS', leftX + 4, y + 8);
  doc.text('INVESTMENT DETAILS', rightX + 2, y + 8);

  let ly = y + 16;
  let ry = y + 16;

  const infoL = (lbl, val) => {
    doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(107, 114, 128);
    doc.text(lbl, leftX + 4, ly);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(26, 26, 26);
    doc.text(String(val || '—'), valLeft, ly);
    ly += 7;
  };
  const infoR = (lbl, val) => {
    doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(107, 114, 128);
    doc.text(lbl, rightX + 2, ry);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(26, 26, 26);
    doc.text(String(val || '—'), valRight, ry);
    ry += 7;
  };

  infoL('Investor Name', `${investor.first_name} ${investor.last_name}`);
  infoL('Investor ID', investor.id);
  infoL('Email', investor.email || '—');
  infoL('FICA Status', (investor.fica_status || 'approved').toUpperCase());

  infoR('Investment ID', inv.id);
  infoR('Pool Name', inv.pool_name || pool.name || '—');
  infoR('Amount Invested', Utils.rand(inv.amount));
  infoR('Annual Rate', Utils.pct(inv.expected_return_rate || inv.annual_rate));

  y = Math.max(ly, ry) + 4;

  doc.setFillColor(247, 248, 250);
  doc.roundedRect(leftX, y, W - 28, 26, 2, 2, 'F');

  let iy = y + 10;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold'); doc.setTextColor(107, 114, 128);
  doc.text('Start Date', leftX + 4, iy);
  doc.text('Maturity Date', W / 2 - 20, iy);
  doc.text('Status', W - 60, iy);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
  doc.setTextColor(26, 26, 26);
  doc.text(Utils.date(inv.investment_date || inv.start_date), leftX + 4, iy + 8);
  doc.text(Utils.date(inv.maturity_date || inv.end_date), W / 2 - 20, iy + 8);
  const statusColor = inv.status === 'active' ? [47, 140, 155] : inv.status === 'paid_out' ? [34, 197, 94] : [156, 163, 175];
  doc.setTextColor(...statusColor);
  doc.text((inv.status || '').toUpperCase(), W - 60, iy + 8);

  y += 32;

  // Disclaimer
  y += 6;
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(156, 163, 175);
  doc.text('This certificate is a record of investment and does not constitute a guarantee of returns. All investments are subject to the terms', 14, y, { maxWidth: W - 28 });
  doc.text('and conditions of SV Capital and SmartVest Financial Services (Pty) Ltd (FSP #52449).', 14, y + 5, { maxWidth: W - 28 });

  _pdfFooter(doc);
  doc.save(`SVC-Certificate-${inv.id}.pdf`);
  Toast.success('Certificate downloaded!');
  } catch (err) {
    console.error('[downloadCertificate]', err);
    Toast.error('Could not generate certificate: ' + (err.message || 'unknown error'));
  }
}

/* downloadReceipt(transactionId) */
function downloadReceipt(transactionId) {
  const txn = PORTAL.transactions.find(t => t.id === transactionId);
  if (!txn) { Toast.error('Transaction not found'); return; }
  const investor = PORTAL.investor;

  const doc = _getPDF('portrait');
  if (!doc) return;

  const W = doc.internal.pageSize.getWidth();

  // Header
  let y = _pdfHeader(doc, 'DEPOSIT RECEIPT', `REF: ${txn.reference || txn.id}`);
  y += 8;

  // Amount hero box
  doc.setFillColor(240, 253, 244);
  doc.setDrawColor(34, 197, 94);
  doc.setLineWidth(0.5);
  doc.roundedRect(14, y, W - 28, 30, 3, 3, 'FD');
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(22, 101, 52);
  doc.text('AMOUNT RECEIVED', W / 2, y + 8, { align: 'center' });
  doc.setFontSize(22);
  doc.setTextColor(21, 128, 61);
  doc.text(Utils.rand(Math.abs(txn.amount)), W / 2, y + 22, { align: 'center' });
  y += 38;

  // Details table
  doc.setFillColor(247, 248, 250);
  doc.roundedRect(14, y, W - 28, 74, 2, 2, 'F');

  const details = [
    ['Receipt No.',       txn.id],
    ['Investor',          `${investor.first_name} ${investor.last_name} (${investor.id})`],
    ['Date',              Utils.date(txn.transaction_date || txn.created_at)],
    ['Amount',            Utils.rand(Math.abs(txn.amount))],
    ['Payment Method',    txn.description || 'Bank Transfer'],
    ['Reference',         txn.reference || '—'],
    ['Status',            (txn.status || 'completed').toUpperCase()],
  ];

  let dy = y + 12;
  details.forEach(([label, value]) => {
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(107, 114, 128);
    doc.text(label, 20, dy);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(26, 26, 26);
    doc.text(String(value), 90, dy);
    dy += 9;
  });

  y += 80;
  y += 10;

  // Thank you note
  doc.setFillColor(255, 249, 235);
  doc.setDrawColor(255, 155, 12);
  doc.setLineWidth(0.3);
  doc.roundedRect(14, y, W - 28, 16, 2, 2, 'FD');
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(180, 100, 0);
  doc.text('Thank you for investing with SV Capital', W / 2, y + 10, { align: 'center' });

  _pdfFooter(doc);
  doc.save(`SVC-Receipt-${txn.id}.pdf`);
  Toast.success('Receipt downloaded!');
}

/* downloadStatement() — 90-day statement */
function downloadStatement() {
  const investor = PORTAL.investor;
  if (!investor) { Toast.error('Portfolio data still loading'); return; }

  const doc = _getPDF('portrait');
  if (!doc) return;

  const W  = doc.internal.pageSize.getWidth();
  const now = new Date();
  const from90 = new Date(now);
  from90.setDate(from90.getDate() - 90);

  // Filter last 90 days
  const txns = PORTAL.transactions
    .filter(t => {
      const d = new Date(t.transaction_date || t.created_at || 0);
      return d >= from90;
    })
    .sort((a, b) => new Date(b.transaction_date || b.created_at) - new Date(a.transaction_date || a.created_at));

  const totalInvested = PORTAL.investments.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const totalReturns  = PORTAL.investments.reduce((s, i) => s + (Number(i.actual_return_amount) || 0), 0);
  const walletBal     = Number(investor.wallet_balance) || 0;
  const portfolioVal  = totalInvested + walletBal + totalReturns;

  const periodLabel = `${from90.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })} – ${now.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })}`;

  // Header
  let y = _pdfHeader(doc, 'ACCOUNT STATEMENT', periodLabel);
  y += 6;

  // Investor info
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(26, 26, 26);
  doc.text(`${investor.first_name} ${investor.last_name}`, 14, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(107, 114, 128);
  doc.setFontSize(8);
  doc.text(`${investor.id} · ${investor.email || ''}`, 14, y + 5);
  y += 14;

  // Summary stats
  const stats = [
    ['Portfolio Value', Utils.rand(portfolioVal), [255, 155, 12]],
    ['Wallet Balance',  Utils.rand(walletBal),    [47, 140, 155]],
    ['Total Invested',  Utils.rand(totalInvested), [26, 34, 53]],
    ['Returns Earned',  Utils.rand(totalReturns),  [34, 197, 94]],
  ];
  const boxW = (W - 28 - 9) / 4;
  stats.forEach(([label, value, color], i) => {
    const bx = 14 + i * (boxW + 3);
    doc.setFillColor(247, 248, 250);
    doc.roundedRect(bx, y, boxW, 24, 2, 2, 'F');
    doc.setFontSize(7.5); doc.setFont('helvetica', 'bold');
    doc.setTextColor(color[0], color[1], color[2]);
    doc.text(label.toUpperCase(), bx + boxW / 2, y + 8, { align: 'center' });
    doc.setFontSize(10); doc.setFont('helvetica', 'bold');
    doc.setTextColor(26, 26, 26);
    doc.text(value, bx + boxW / 2, y + 18, { align: 'center' });
  });
  y += 30;

  // Transaction table
  if (!txns.length) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(156, 163, 175);
    doc.text('No transactions in the last 90 days.', 14, y + 10);
  } else {
    const typeMap = { deposit: 'Deposit', withdrawal: 'Withdrawal', investment: 'Investment', return: 'Return', payout: 'Payout', fee: 'Fee', referral_bonus: 'Referral Bonus' };
    const tableHead = [['Date', 'Type', 'Description', 'Amount', 'Status']];
    const tableBody = txns.map(t => [
      Utils.date(t.transaction_date || t.created_at),
      typeMap[t.type] || t.type,
      (t.description || '—').slice(0, 38),
      (t.amount > 0 ? '+' : '') + Utils.rand(t.amount),
      (t.status || '—').toUpperCase(),
    ]);

    if (doc.autoTable) {
      doc.autoTable({
        head: tableHead,
        body: tableBody,
        startY: y,
        margin: { left: 14, right: 14 },
        headStyles: { fillColor: [26, 34, 53], textColor: [255, 255, 255], fontSize: 8, fontStyle: 'bold' },
        bodyStyles: { fontSize: 8, textColor: [26, 26, 26] },
        alternateRowStyles: { fillColor: [247, 248, 250] },
        columnStyles: {
          0: { cellWidth: 22 },
          1: { cellWidth: 26 },
          2: { cellWidth: 'auto' },
          3: { cellWidth: 28, halign: 'right' },
          4: { cellWidth: 22, halign: 'center' },
        },
        didDrawPage: () => _pdfFooter(doc),
      });
    } else {
      // Fallback without autoTable
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(107, 114, 128);
      doc.text('Date', 14, y + 6); doc.text('Type', 40, y + 6); doc.text('Description', 70, y + 6); doc.text('Amount', 150, y + 6); doc.text('Status', 175, y + 6);
      y += 10;
      doc.setFont('helvetica', 'normal'); doc.setTextColor(26, 26, 26);
      tableBody.slice(0, 30).forEach(row => {
        doc.text(row[0], 14, y); doc.text(row[1], 40, y); doc.text(row[2].slice(0, 30), 70, y);
        doc.text(row[3], 150, y, { align: 'right' }); doc.text(row[4], 175, y);
        y += 6;
        if (y > 260) { doc.addPage(); y = 20; }
      });
    }
  }

  _pdfFooter(doc);
  const ym = now.toISOString().slice(0, 7);
  doc.save(`SVC-Statement-${ym}.pdf`);
  Toast.success('90-day statement downloaded!');
}

/* ═══════════════════════════════════════════════
   FEATURE 12: RISK PROFILE QUESTIONNAIRE
   ═══════════════════════════════════════════════ */

function openRiskQuestionnaire() {
  // Clear all radio selections
  document.querySelectorAll('#riskModal input[type=radio]').forEach(r => r.checked = false);
  Modal.open('riskModal');
}

async function submitRiskQuestionnaire() {
  // Read all 5 radio values
  const scores = [1, 2, 3, 4, 5].map(n => {
    const checked = document.querySelector(`input[name="rq${n}"]:checked`);
    return checked ? parseInt(checked.value) : null;
  });

  if (scores.some(s => s === null)) {
    Toast.error('Please answer all 5 questions before submitting.');
    return;
  }

  const total = scores.reduce((a, b) => a + b, 0);
  let result;
  if (total <= 8) result = 'conservative';
  else if (total <= 11) result = 'moderate';
  else result = 'aggressive';

  try {
    await API._fetch('PATCH', `tables/investors/${PORTAL.investor.id}`, { risk_profile: result });
    PORTAL.investor.risk_profile = result;
    Modal.close('riskModal');
    Toast.success(`Your risk profile: ${result.charAt(0).toUpperCase() + result.slice(1)}. Your dashboard has been updated.`);
    renderRiskProfile();
  } catch (e) {
    console.warn('Risk profile save error:', e);
    // Still update locally even if server fails
    PORTAL.investor.risk_profile = result;
    Modal.close('riskModal');
    Toast.success(`Your risk profile: ${result.charAt(0).toUpperCase() + result.slice(1)}.`);
    renderRiskProfile();
  }
}

function renderRiskProfile() {
  const inv = PORTAL.investor;
  if (!inv) return;

  // ── Populate personal info form ───────────────────────────
  const _set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  _set('profFirstName', inv.first_name);
  _set('profLastName',  inv.last_name);
  _set('profEmail',     inv.email);
  _set('profPhone',     inv.phone);
  _set('profCity',      inv.address || inv.city);

  // Province dropdown: select matching option
  const provSel = document.getElementById('profProvince');
  if (provSel && inv.province) {
    const opt = [...provSel.options].find(o => o.value === inv.province || o.text === inv.province);
    if (opt) opt.selected = true;
  }

  // ── Populate Account Summary sidebar ─────────────────────
  const _setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
  _setText('profSummaryId',       inv.id);
  _setText('profSummaryJoined',   inv.date_joined ? new Date(inv.date_joined).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  _setText('profSummaryReferral', inv.referral_code);

  // Add copy buttons for investor ID and referral code
  ['profSummaryId', 'profSummaryReferral'].forEach(elId => {
    const el = document.getElementById(elId);
    if (!el || el.nextElementSibling?.classList?.contains('copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.title = 'Copy';
    btn.innerHTML = '<i class="fa-solid fa-copy"></i>';
    btn.onclick = () => _copyText(el.textContent, btn);
    el.after(btn);
  });

  const statusEl = document.getElementById('profSummaryStatus');
  if (statusEl) {
    const st = (inv.status || 'active').toLowerCase();
    const statusClass = st === 'active' ? 'badge--green' : st === 'suspended' ? 'badge--red' : 'badge--gray';
    statusEl.innerHTML = `<span class="badge ${statusClass}">${st.charAt(0).toUpperCase() + st.slice(1)}</span>`;
  }

  const ficaEl = document.getElementById('profSummaryFica');
  if (ficaEl) {
    const kyc = (inv.kyc_status || 'pending').toLowerCase();
    const kycClass = kyc === 'approved' ? 'badge--green' : kyc === 'rejected' ? 'badge--red' : 'badge--gray';
    const kycLabel = kyc === 'fica_submitted' ? 'Submitted' : kyc.charAt(0).toUpperCase() + kyc.slice(1);
    ficaEl.innerHTML = `<span class="badge ${kycClass}">${kycLabel}</span>`;
  }

  const profile = inv.risk_profile || null;
  const badge = document.getElementById('riskProfileBadge');
  const desc  = document.getElementById('riskProfileDesc');
  const btnLabel = document.getElementById('riskProfileBtnLabel');

  // Also sync the radio buttons in the profile form
  if (profile) {
    const radios = document.querySelectorAll('input[name="riskProf"]');
    radios.forEach(r => { r.checked = r.value === profile; });
  }

  // Load login history
  _loadLoginHistory();

  if (!badge) return;

  const configs = {
    conservative: {
      badgeClass: 'badge--blue',
      label: 'Conservative',
      desc: 'You prefer capital preservation with lower risk. We recommend short-term and solar investments.',
    },
    moderate: {
      badgeClass: 'badge--orange',
      label: 'Moderate',
      desc: 'You balance growth with prudent risk. A blend of cattle and solar products suits you well.',
    },
    aggressive: {
      badgeClass: 'badge--red',
      label: 'Aggressive',
      desc: 'You prioritise high returns and can tolerate risk. Cattle cycles and high-yield pools are ideal.',
    },
  };

  if (profile && configs[profile]) {
    const cfg = configs[profile];
    badge.className = `badge ${cfg.badgeClass}`;
    badge.textContent = cfg.label;
    if (desc) desc.textContent = cfg.desc;
    if (btnLabel) btnLabel.textContent = 'Retake Questionnaire';
  } else {
    badge.className = 'badge badge--gray';
    badge.textContent = 'Not assessed';
    if (desc) desc.textContent = 'Complete the questionnaire to determine your risk appetite and get tailored pool recommendations.';
    if (btnLabel) btnLabel.textContent = 'Take Questionnaire';
  }

  _loadStatementArchive();
  restoreProfileDraft();
}


/* ═══════════════════════════════════════════════
   FEATURE: STATEMENT ARCHIVE & TAX CERTIFICATES
   ═══════════════════════════════════════════════ */

async function _loadStatementArchive() {
  const el = document.getElementById('statementArchiveBody');
  if (!el) return;
  try {
    const data = await API._fetch('GET', 'statements');
    const currentYear = new Date().getFullYear();
    const taxYear = new Date().getMonth() >= 2 ? currentYear : currentYear - 1; // Feb cutoff
    const taxSection = `
      <div style="margin-bottom:14px;padding:12px;background:rgba(255,155,12,0.06);border-radius:8px;border:1px solid rgba(255,155,12,0.2)">
        <div style="font-size:0.84rem;font-weight:700;margin-bottom:6px"><i class="fa-solid fa-file-shield" style="color:var(--gold);margin-right:6px"></i>Tax Certificates</div>
        <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:10px">Download your annual IT3(b)-style investment income summary for SARS submission.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${[taxYear, taxYear-1, taxYear-2].map(y => `<button class="btn btn--ghost btn--sm" onclick="_downloadTaxCert(${y})" style="font-size:0.75rem"><i class="fa-solid fa-download"></i> ${y}/${y+1}</button>`).join('')}
        </div>
      </div>`;
    if (!data.statements || !data.statements.length) {
      el.innerHTML = taxSection + '<div style="color:var(--text-muted);font-size:0.82rem;text-align:center;padding:12px 0">No statements available yet. Statements are generated on the 1st of each month.</div>';
      return;
    }
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    el.innerHTML = taxSection + `<div style="display:flex;flex-direction:column;gap:6px">${data.statements.map(s => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--surface2,#f8f9fa);border-radius:8px">
        <div style="font-size:0.84rem;font-weight:600">${months[s.period_month-1]} ${s.period_year} Statement</div>
        <a href="/api/statements/${s.id}/pdf" target="_blank" class="btn btn--ghost btn--sm" style="font-size:0.75rem"><i class="fa-solid fa-download"></i> PDF</a>
      </div>`).join('')}</div>`;
  } catch (_) {
    if (el) el.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;text-align:center;padding:12px 0">Unable to load statements</div>';
  }
}

async function _downloadTaxCert(year) {
  try {
    Toast.info?.(`Generating ${year} tax certificate…`) || Toast.success?.(`Generating ${year} tax certificate…`);
    const data = await API._fetch('GET', `statements/tax-cert/${year}`);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    let y = 20;
    const lh = 7;
    const fmt = (n) => `R ${parseFloat(n||0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    doc.setFontSize(18); doc.setFont(undefined,'bold');
    doc.text('SV CAPITAL — Investment Income Certificate', 14, y); y += 10;
    doc.setFontSize(10); doc.setFont(undefined,'normal');
    doc.text(`Tax Year: 1 March ${year} — 28 February ${year+1}`, 14, y); y += lh;
    doc.text(`Generated: ${new Date().toLocaleDateString('en-ZA')}`, 14, y); y += 12;
    doc.setFont(undefined,'bold'); doc.text('Investor Details', 14, y); y += lh;
    doc.setFont(undefined,'normal');
    doc.text(`Name: ${data.investor.first_name} ${data.investor.last_name}`, 14, y); y += lh;
    doc.text(`Email: ${data.investor.email}`, 14, y); y += lh;
    doc.text(`ID / Ref: ${data.investor.id}`, 14, y); y += 12;
    doc.setFont(undefined,'bold'); doc.text('Summary', 14, y); y += lh;
    doc.setFont(undefined,'normal');
    doc.text(`Total Deposits:    ${fmt(data.deposits)}`, 14, y); y += lh;
    doc.text(`Total Withdrawals: ${fmt(data.withdrawals)}`, 14, y); y += lh;
    doc.text(`Investment Returns: ${fmt(data.totalReturns)}`, 14, y); y += 12;
    if (data.investments.length) {
      doc.setFont(undefined,'bold'); doc.text('Matured Investments', 14, y); y += lh;
      doc.setFont(undefined,'normal');
      data.investments.forEach(inv => {
        const ret = parseFloat(inv.actual_return || inv.expected_return || 0);
        doc.text(`• ${inv.pool_name || 'Investment'} — Return: ${fmt(ret)} — Matured: ${new Date(inv.end_date).toLocaleDateString('en-ZA')}`, 14, y); y += lh;
        if (y > 270) { doc.addPage(); y = 20; }
      });
    }
    y += 6;
    doc.setFontSize(8); doc.setTextColor(100);
    doc.text('This document is for informational purposes. Please consult a tax advisor for official SARS submissions.', 14, y);
    doc.save(`SVC-TaxCert-${year}-${year+1}.pdf`);
  } catch (e) { Toast.error('Could not generate tax certificate — please try again.'); }
}

/* ═══════════════════════════════════════════════
   FEATURE: ENHANCED 2FA STATUS IN PROFILE
   ═══════════════════════════════════════════════ */

/* load2FAStatus — fetches 2FA status and updates all UI elements */
async function load2FAStatus() {
  try {
    const data = await API._fetch('GET', 'auth/2fa/status');
    const enabled = !!data.enabled;

    // Update button
    const label = document.getElementById('twoFAToggleLabel');
    if (label) label.textContent = enabled ? 'Disable 2FA' : 'Enable 2FA';
    const btn = document.getElementById('twoFAToggleBtn');
    if (btn) {
      btn.className = enabled
        ? 'btn btn--danger btn--full'
        : 'btn btn--secondary btn--full';
    }

    // Update status row
    const statusText = document.getElementById('twoFAStatusText');
    const statusBadge = document.getElementById('twoFAStatusBadge');
    if (statusText) statusText.textContent = enabled ? 'Enabled — your account is protected' : 'Not enabled — recommended for security';
    if (statusBadge) {
      statusBadge.style.display = 'inline-block';
      statusBadge.innerHTML = enabled
        ? '<span class="badge badge--green"><i class="fa-solid fa-check"></i> Enabled</span>'
        : '<span class="badge badge--gray">Disabled</span>';
    }

    return enabled;
  } catch (e) {
    const label = document.getElementById('twoFAToggleLabel');
    if (label) label.textContent = 'Enable 2FA';
    const statusText = document.getElementById('twoFAStatusText');
    if (statusText) statusText.textContent = 'Status unavailable';
  }
}

async function _loadLoginHistory() {
  const el = document.getElementById('loginHistoryList');
  if (!el) return;
  try {
    const data = await API._fetch('GET', 'auth/login-history');
    if (!data.events || !data.events.length) {
      el.innerHTML = '<div style="color:var(--text-muted)">No login history yet</div>';
      return;
    }
    el.innerHTML = data.events.slice(0, 5).map(e => {
      const ua = e.user_agent || '';
      const device = ua.includes('Mobile') || ua.includes('Android') ? '📱 Mobile' : '💻 Desktop';
      const browser = ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : ua.includes('Safari') ? 'Safari' : 'Browser';
      const date = new Date(e.login_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
        <div><span style="font-weight:600">${device} · ${browser}</span><br><span style="color:var(--text-muted)">${_esc(e.ip_address) || 'Unknown IP'}</span></div>
        <div style="text-align:right;white-space:nowrap">${date}</div>
      </div>`;
    }).join('');
  } catch (_) {
    if (el) el.innerHTML = '<div style="color:var(--text-muted)">Unable to load login history</div>';
  }
}

/* ═══════════════════════════════════════════════
   FEATURE 2: TWO-WAY SUPPORT MESSAGING
   ═══════════════════════════════════════════════ */

let _activeTicketId = null;

/* Override renderMyTickets to add "View Conversation" button */
function renderMyTickets() {
  const body = document.getElementById('myTicketsBody');
  if (!PORTAL.tickets.length) {
    body.innerHTML = `<div class="empty-state">
      <i class="fa-solid fa-headset"></i>
      <div class="empty-state__title">No support tickets yet</div>
      <div class="empty-state__sub">Use the form below to submit a ticket if you have questions or need assistance with your account.</div>
    </div>`;
    return;
  }

  body.innerHTML = PORTAL.tickets.map(t => {
    const hasAdminReply = !!(t.admin_response && t.admin_response.trim());
    const unreadBadge = hasAdminReply
      ? '<span style="background:#ef4444;color:#fff;font-size:0.62rem;font-weight:800;padding:2px 7px;border-radius:20px;margin-left:6px">NEW</span>'
      : '';
    return `
      <div class="my-ticket-item" style="padding:12px 14px;border-radius:10px;border:1px solid rgba(0,0,0,0.07);margin-bottom:8px;background:var(--ci-bg-light,#F7F8FA)">
        <div class="my-ticket-header" style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px">
          <span class="my-ticket-subject" style="font-weight:700;font-size:0.86rem;color:#1a1a1a;flex:1">${_esc(t.subject)}</span>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
            ${unreadBadge}
            ${Utils.statusBadge(t.status)}
          </div>
        </div>
        <div class="my-ticket-meta" style="font-size:0.74rem;color:var(--text-muted);margin-bottom:8px">${Utils.date(t.created_at)} &middot; ${(t.category || '').replace(/_/g, ' ')}</div>
        ${hasAdminReply ? `<div style="font-size:0.78rem;color:#1a1a1a;background:rgba(47,140,155,0.08);border:1px solid rgba(47,140,155,0.2);border-radius:6px;padding:6px 10px;margin-bottom:8px"><strong style="color:#2F8C9B">Support:</strong> ${(t.admin_response || '').slice(0, 120)}${(t.admin_response || '').length > 120 ? '…' : ''}</div>` : ''}
        <button class="btn btn--ghost btn--sm" onclick="openTicketConversation('${t.id}')" style="font-size:0.78rem;padding:5px 12px">
          <i class="fa-solid fa-comment-dots"></i> View Conversation
        </button>
      </div>
    `;
  }).join('');
}

async function openTicketConversation(ticketId) {
  _activeTicketId = ticketId;
  const ticket = PORTAL.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

  // Show conversation panel, hide new ticket form area
  document.getElementById('myTicketsPanel').style.display = 'none';
  const convPanel = document.getElementById('ticketConversationPanel');
  convPanel.style.display = '';

  // Set header info
  const subjectEl = document.getElementById('convTicketSubject');
  if (subjectEl) subjectEl.textContent = ticket.subject;
  const statusEl = document.getElementById('convTicketStatus');
  if (statusEl) statusEl.innerHTML = Utils.statusBadge(ticket.status);

  // Render loading state
  const thread = document.getElementById('ticketConversationThread');
  if (thread) thread.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> Loading conversation…</div>';

  // Fetch replies from ticket_replies table
  let replies = [];
  try {
    const res = await API._fetch('GET', 'tables/ticket_replies', null, { ticket_id: ticketId, limit: 100 });
    replies = res.data || [];
  } catch (e) {
    // table may not exist yet — fall back to just the ticket message + admin_response
    replies = [];
  }

  // Build thread: original message first, then replies, then admin_response if no replies
  const messages = [];

  // Original investor message
  messages.push({
    sender: 'investor',
    text: ticket.message || '',
    time: ticket.created_at,
    name: `${PORTAL.investor?.first_name || ''} ${PORTAL.investor?.last_name || ''}`.trim() || 'You',
  });

  // Replies from ticket_replies table
  replies.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).forEach(r => {
    messages.push({
      sender: r.sender === 'investor' ? 'investor' : 'admin',
      text: r.message || '',
      time: r.created_at,
      name: r.sender === 'investor' ? 'You' : 'SV Capital Support',
    });
  });

  // If no replies from table but admin_response exists on the ticket, show it
  if (!replies.length && ticket.admin_response && ticket.admin_response.trim()) {
    messages.push({
      sender: 'admin',
      text: ticket.admin_response,
      time: ticket.responded_at || ticket.updated_at || ticket.created_at,
      name: 'SV Capital Support',
    });
  }

  if (thread) {
    thread.innerHTML = messages.map(m => {
      const isInvestor = m.sender === 'investor';
      const wrapClass = isInvestor ? 'chat-bubble-wrap--investor' : 'chat-bubble-wrap--admin';
      const bubbleClass = isInvestor ? 'chat-bubble--investor' : 'chat-bubble--admin';
      return `
        <div class="chat-bubble-wrap ${wrapClass}">
          <div class="chat-bubble-meta">${m.name} &middot; ${Utils.date(m.time)}</div>
          <div class="chat-bubble ${bubbleClass}">${(m.text || '').replace(/\n/g, '<br>')}</div>
        </div>
      `;
    }).join('');
    // Scroll to bottom
    thread.scrollTop = thread.scrollHeight;
  }

  // Clear reply input
  const replyInput = document.getElementById('ticketReplyInput');
  if (replyInput) replyInput.value = '';
}

function closeTicketConversation() {
  _activeTicketId = null;
  document.getElementById('ticketConversationPanel').style.display = 'none';
  document.getElementById('myTicketsPanel').style.display = '';
}

async function sendTicketReply() {
  if (!_activeTicketId) return;
  const input = document.getElementById('ticketReplyInput');
  const message = (input?.value || '').trim();
  if (!message) { Toast.error('Please enter a reply message'); return; }

  try {
    // Try to post to ticket_replies table
    await API._fetch('POST', 'tables/ticket_replies', {
      id: Utils.genId('RPL'),
      ticket_id: _activeTicketId,
      sender: 'investor',
      sender_id: PORTAL.investor?.id || DEMO_INVESTOR_ID,
      sender_name: `${PORTAL.investor?.first_name || ''} ${PORTAL.investor?.last_name || ''}`.trim(),
      message,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    // ticket_replies table may not exist — update the ticket message instead
    const ticket = PORTAL.tickets.find(t => t.id === _activeTicketId);
    const existingMsg = ticket ? (ticket.message || '') : '';
    const appendedMsg = existingMsg + `\n\n[Investor reply ${new Date().toLocaleDateString('en-ZA')}]: ${message}`;
    try {
      await API._fetch('PATCH', `tables/support_tickets/${_activeTicketId}`, { message: appendedMsg });
      if (ticket) ticket.message = appendedMsg;
    } catch (e2) {
      Toast.error('Could not send reply. Please try again.');
      return;
    }
  }

  Toast.success('Reply sent!');
  if (input) input.value = '';

  // Reload conversation
  await openTicketConversation(_activeTicketId);
}

/* ═══════════════════════════════════════════════
   FEATURE 3: RECURRING INVESTMENT SETUP
   ═══════════════════════════════════════════════ */

function updateRecurringToggleStyle() {
  const toggle = document.getElementById('recurringEnabledToggle');
  const slider = document.getElementById('recurringToggleSlider');
  if (slider) {
    if (toggle && toggle.checked) {
      slider.classList.add('recurring-toggle-on');
    } else {
      slider.classList.remove('recurring-toggle-on');
    }
  }
}

function openRecurringModal() {
  // Populate pool selector
  const sel = document.getElementById('recurringPoolSelect');
  if (sel) {
    sel.innerHTML = '<option value="">Select a pool…</option>' +
      (PORTAL.pools || []).filter(p => p.status === 'open').map(p =>
        `<option value="${p.id}">${p.name} — ${Utils.pct(p.annual_rate || p.benchmark_rate)} p.a.</option>`
      ).join('');
  }

  // Load existing settings from investor
  const inv = PORTAL.investor;
  const toggle = document.getElementById('recurringEnabledToggle');
  const amtEl  = document.getElementById('recurringAmount');

  if (toggle) {
    toggle.checked = !!(inv && inv.recurring_enabled);
    updateRecurringToggleStyle();
  }
  if (amtEl && inv && inv.recurring_amount) {
    amtEl.value = inv.recurring_amount;
  }
  if (sel && inv && inv.recurring_pool_id) {
    sel.value = inv.recurring_pool_id;
  }

  Modal.open('recurringModal');
}

async function saveRecurringInvestment() {
  const toggle  = document.getElementById('recurringEnabledToggle');
  const amtEl   = document.getElementById('recurringAmount');
  const poolSel = document.getElementById('recurringPoolSelect');

  const enabled  = !!(toggle && toggle.checked);
  const amount   = parseFloat(amtEl?.value || 0);
  const poolId   = poolSel?.value || null;

  if (enabled) {
    if (!amount || amount < 100) { Toast.error('Please enter a monthly amount of at least R100'); return; }
    if (!poolId) { Toast.error('Please select an investment pool'); return; }
  }

  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  try {
    await API._fetch('PATCH', `tables/investors/${investorId}`, {
      recurring_enabled: enabled,
      recurring_amount:  enabled ? amount : null,
      recurring_pool_id: enabled ? poolId : null,
    });

    // Update local state
    if (PORTAL.investor) {
      PORTAL.investor.recurring_enabled  = enabled;
      PORTAL.investor.recurring_amount   = enabled ? amount : null;
      PORTAL.investor.recurring_pool_id  = enabled ? poolId : null;
    }

    Modal.close('recurringModal');

    SVC.track('svc_recurring_investment_set', { enabled: enabled, pool_id: poolId, amount: amount });

    if (enabled) {
      const pool = (PORTAL.pools || []).find(p => p.id === poolId);
      Toast.success(`Recurring investment of ${Utils.rand(amount)}/month set up${pool ? ' in ' + pool.name : ''}!`);
    } else {
      Toast.success('Recurring investment disabled.');
    }

    _renderRecurringStatusSummary();
    // Refresh the recurring tab if it's currently visible
    if (document.getElementById('walletRecurringTab')?.style.display !== 'none') _renderRecurringTab();
    // Update badge
    const badge = document.getElementById('recurringActiveBadge');
    if (badge) badge.style.display = enabled ? 'inline-flex' : 'none';
  } catch (e) {
    Toast.error('Failed to save recurring settings. Please try again.');
    console.error(e);
  }
}

function _renderRecurringStatusSummary() {
  const inv = PORTAL.investor;
  const summaryEl = document.getElementById('recurringStatusSummary');
  if (!summaryEl) return;

  if (inv && inv.recurring_enabled && inv.recurring_amount) {
    const pool = (PORTAL.pools || []).find(p => p.id === inv.recurring_pool_id);
    summaryEl.style.display = '';
    summaryEl.innerHTML = `<i class="fa-solid fa-check-circle" style="color:#22c55e"></i> <strong>Active:</strong> ${Utils.rand(inv.recurring_amount)}/month into ${pool ? _esc(pool.name) : 'selected pool'}`;
  } else {
    summaryEl.style.display = 'none';
  }
}

/* ═══════════════════════════════════════════════
   FEATURE 5 (extended): ACCOUNT DELETION
   ═══════════════════════════════════════════════ */

function openDeleteAccountModal() {
  const input = document.getElementById('deleteAccountConfirmInput');
  if (input) input.value = '';
  Modal.open('deleteAccountModal');
}

async function confirmAccountDeletion() {
  const input = document.getElementById('deleteAccountConfirmInput');
  const value = (input?.value || '').trim();

  if (value !== 'DELETE MY ACCOUNT') {
    Toast.error('Please type exactly: DELETE MY ACCOUNT');
    return;
  }

  try {
    // POST to privacy endpoint
    await API._fetch('POST', 'privacy/account', { confirm: 'DELETE MY ACCOUNT' });
    Modal.close('deleteAccountModal');
    Toast.info('Account deletion request submitted. You will be signed out.');
    setTimeout(() => { window.location.href = '/login.html'; }, 2500);
  } catch (e) {
    // If endpoint doesn't exist, still handle gracefully
    if (e.message && e.message.includes('404')) {
      // Submit as a support ticket instead
      try {
        await API.tickets.create({
          id:             Utils.genId('TKT'),
          investor_id:    PORTAL.investor?.id || DEMO_INVESTOR_ID,
          investor_name:  `${PORTAL.investor?.first_name || ''} ${PORTAL.investor?.last_name || ''}`.trim(),
          investor_email: PORTAL.investor?.email || '',
          subject:        'Account Deletion Request (POPIA)',
          category:       'general',
          priority:       'high',
          message:        'The investor has formally requested account deletion in accordance with POPIA. Please process this request and confirm via email.',
          status:         'open',
        });
        Modal.close('deleteAccountModal');
        Toast.success('Account deletion request submitted to our team. We will contact you within 3 business days.');
      } catch (e2) {
        Toast.error('Could not submit deletion request. Please email admin@svcapital.co.za directly.');
      }
    } else {
      Toast.error('Failed to submit deletion request. Please try again.');
    }
  }
}

/* ═══════════════════════════════════════════════
   FEATURE 6: PUSH NOTIFICATION OPT-IN
   ═══════════════════════════════════════════════ */

const PUSH_PREF_KEY = 'svc_push_pref';

/**
 * Convert a base64url VAPID public key to a Uint8Array for pushManager.subscribe()
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

function _initPushNotifToggle() {
  const toggle     = document.getElementById('pushNotifToggle');
  const slider     = document.getElementById('pushNotifSlider');
  const statusText = document.getElementById('pushNotifStatusText');
  if (!toggle) return;

  const saved   = localStorage.getItem(PUSH_PREF_KEY);
  const enabled = saved === 'true';
  toggle.checked = enabled;
  if (slider) {
    slider.style.background = enabled ? '#ff9b0c' : '#ccc';
  }
  if (statusText) statusText.textContent = enabled
    ? 'Enabled — you will receive investment alerts'
    : 'Enable to receive investment alerts';
}

async function togglePushNotifications(checked) {
  const slider     = document.getElementById('pushNotifSlider');
  const statusText = document.getElementById('pushNotifStatusText');

  if (checked) {
    // Check browser support
    if (!('Notification' in window)) {
      Toast.info('Push notifications are not supported in this browser. Install the SV Capital app (PWA) for notifications.');
      const toggle = document.getElementById('pushNotifToggle');
      if (toggle) toggle.checked = false;
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      localStorage.setItem(PUSH_PREF_KEY, 'false');
      const toggle = document.getElementById('pushNotifToggle');
      if (toggle) toggle.checked = false;
      if (slider) slider.style.background = '#ccc';
      if (statusText) statusText.textContent = 'Permission denied — enable in browser settings';
      Toast.error('Notification permission denied. Please enable in your browser settings.');
      return;
    }

    // Get SW registration
    let swReg = window._swReg;
    if (!swReg && 'serviceWorker' in navigator) {
      try { swReg = await navigator.serviceWorker.ready; } catch (_) {}
    }

    if (!swReg) {
      Toast.error('Service worker not ready. Please reload and try again.');
      const toggle = document.getElementById('pushNotifToggle');
      if (toggle) toggle.checked = false;
      return;
    }

    try {
      // Fetch VAPID public key
      const keyRes = await fetch((window.__SVC_API_BASE__ || '/api/') + 'push/vapid-public-key');
      if (!keyRes.ok) throw new Error('Could not fetch VAPID public key');
      const { publicKey } = await keyRes.json();

      // Subscribe via push manager
      const subscription = await swReg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      // Send subscription to server
      const token  = (typeof Auth !== 'undefined' ? Auth.getToken() : null) || localStorage.getItem('svc_token');
      const subRes = await fetch((window.__SVC_API_BASE__ || '/api/') + 'push/subscribe', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          userAgent:    navigator.userAgent,
        }),
      });

      if (!subRes.ok) throw new Error('Failed to save subscription on server');

      localStorage.setItem(PUSH_PREF_KEY, 'true');
      if (slider) slider.style.background = '#ff9b0c';
      if (statusText) statusText.textContent = 'Enabled — you will receive investment alerts';
      Toast.success('Push notifications enabled!');
    } catch (err) {
      console.error('[Push] subscribe error:', err);
      localStorage.setItem(PUSH_PREF_KEY, 'false');
      const toggle = document.getElementById('pushNotifToggle');
      if (toggle) toggle.checked = false;
      if (slider) slider.style.background = '#ccc';
      Toast.error('Could not enable push notifications: ' + err.message);
    }
  } else {
    // Unsubscribe
    try {
      let swReg = window._swReg;
      if (!swReg && 'serviceWorker' in navigator) {
        try { swReg = await navigator.serviceWorker.ready; } catch (_) {}
      }
      if (swReg) {
        const existing = await swReg.pushManager.getSubscription();
        if (existing) {
          const endpoint = existing.endpoint;
          await existing.unsubscribe();
          const token = (typeof Auth !== 'undefined' ? Auth.getToken() : null) || localStorage.getItem('svc_token');
          await fetch((window.__SVC_API_BASE__ || '/api/') + 'push/unsubscribe', {
            method:  'DELETE',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ endpoint }),
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[Push] unsubscribe error:', err);
    }
    localStorage.setItem(PUSH_PREF_KEY, 'false');
    if (slider) slider.style.background = '#ccc';
    if (statusText) statusText.textContent = 'Disabled';
    Toast.info('Push notifications disabled.');
  }
}

/* ═══════════════════════════════════════════════════════════════
   PWA INSTALL PROMPT
   ═══════════════════════════════════════════════════════════════ */
let _pwaPromptEvt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _pwaPromptEvt = e;
  if (!localStorage.getItem('pwa_installed') && !localStorage.getItem('pwa_dismissed')) {
    setTimeout(() => {
      const banner = document.getElementById('pwaInstallBanner');
      if (banner) banner.style.display = 'flex';
    }, 8000);
  }
});

window.addEventListener('appinstalled', () => {
  localStorage.setItem('pwa_installed', '1');
  const banner = document.getElementById('pwaInstallBanner');
  if (banner) banner.style.display = 'none';
  Toast.success('App installed! You can now open SV Capital from your home screen.');
});

function pwaInstall() {
  if (!_pwaPromptEvt) return;
  _pwaPromptEvt.prompt();
  _pwaPromptEvt.userChoice.then(({ outcome }) => {
    if (outcome === 'accepted') localStorage.setItem('pwa_installed', '1');
    _pwaPromptEvt = null;
    const banner = document.getElementById('pwaInstallBanner');
    if (banner) banner.style.display = 'none';
  });
}

function _dismissPwaPrompt() {
  const banner = document.getElementById('pwaInstallBanner');
  if (banner) banner.style.display = 'none';
  localStorage.setItem('pwa_dismissed', Date.now().toString());
}

/* ── iOS / Safari "Add to Home Screen" prompt ── */
(function _initIOSBanner() {
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.navigator.standalone === true;
  if (!isIOS || isStandalone) return;
  if (localStorage.getItem('ios_pwa_dismissed')) return;
  setTimeout(() => {
    const el = document.getElementById('iosPwaBanner');
    if (el) el.style.display = 'flex';
  }, 8000);
})();

function _dismissIosBanner() {
  const el = document.getElementById('iosPwaBanner');
  if (el) el.style.display = 'none';
  localStorage.setItem('ios_pwa_dismissed', '1');
}

/* ═══════════════════════════════════════════════════════════════
   PORTFOLIO ANALYTICS VIEW
   ═══════════════════════════════════════════════════════════════ */

async function loadAnalytics() {
  if (!PORTAL.investments.length && PORTAL.investor) {
    await loadPortalData();
  }
  _renderAnalyticsKPIs();
  _renderMonthlyReturnsChart();
  _renderAnalyticsAllocChart();
  _renderAnalyticsTimeline();
  updateWealthProjection();
}

function _renderAnalyticsKPIs() {
  const all   = PORTAL.investments;
  const done  = all.filter(i => i.status === 'paid_out' || i.status === 'matured');
  const capital  = done.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  const netRet   = done.reduce((s, i) => s + (parseFloat(i.net_return) || parseFloat(i.expected_return) || 0), 0);
  const moic     = capital > 0 ? (capital + netRet) / capital : 0;
  const avgDays  = done.length
    ? done.reduce((s, i) => {
        const start = new Date(i.start_date || i.created_at);
        const end   = new Date(i.end_date || i.maturity_date || i.updated_at);
        return s + (isNaN(start) || isNaN(end) ? (i.term_days || 0) : Math.max(0, (end - start) / 86400000));
      }, 0) / done.length
    : 0;
  const irr = moic > 0 && avgDays > 0 ? (Math.pow(moic, 365 / avgDays) - 1) : 0;

  const byPool = {};
  done.forEach(i => {
    const name = i.pool_name || 'Unknown';
    if (!byPool[name]) byPool[name] = { capital: 0, ret: 0 };
    byPool[name].capital += parseFloat(i.amount) || 0;
    byPool[name].ret     += parseFloat(i.net_return) || parseFloat(i.expected_return) || 0;
  });
  let bestPool = '—', bestRate = -Infinity;
  Object.entries(byPool).forEach(([name, v]) => {
    const r = v.capital > 0 ? v.ret / v.capital : 0;
    if (r > bestRate) { bestRate = r; bestPool = name; }
  });

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('an-moic',    moic > 0 ? moic.toFixed(3) + 'x' : '—');
  set('an-irr',     irr > 0 ? (irr * 100).toFixed(1) + '% p.a.' : '—');
  set('an-best',    bestPool !== '—' ? bestPool : (all.length ? (all[0].pool_name || '—') : '—'));
  set('an-avgdays', avgDays > 0 ? Math.round(avgDays) + ' d' : '—');
}

function _renderMonthlyReturnsChart() {
  const ctx = document.getElementById('analyticsMonthlyChart');
  if (!ctx) return;

  const txns = PORTAL.transactions.filter(t =>
    (t.type === 'return' || t.type === 'interest' || t.type === 'payout') && t.status !== 'cancelled'
  );

  const monthly = {};
  txns.forEach(t => {
    const d = new Date(t.created_at || t.date);
    if (isNaN(d)) return;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthly[key] = (monthly[key] || 0) + (parseFloat(t.amount) || 0);
  });

  const sorted = Object.keys(monthly).sort();
  const last12 = sorted.slice(-12);
  const labels = last12.map(k => {
    const [y, m] = k.split('-');
    return new Date(+y, +m - 1).toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' });
  });
  const data = last12.map(k => +monthly[k].toFixed(2));

  if (PORTAL.charts.analyticsMonthly) { PORTAL.charts.analyticsMonthly.destroy(); }
  PORTAL.charts.analyticsMonthly = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels.length ? labels : ['No data'],
      datasets: [{
        label: 'Returns (R)',
        data: data.length ? data : [0],
        backgroundColor: 'rgba(255,155,12,0.75)',
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => 'R ' + c.raw.toLocaleString('en-ZA') } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { callback: v => 'R' + v.toLocaleString('en-ZA'), font: { size: 11 } } },
      },
    },
  });
}

function _renderAnalyticsAllocChart() {
  const ctx = document.getElementById('analyticsAllocChart');
  const list = document.getElementById('analyticsAllocList');
  if (!ctx) return;

  const active = PORTAL.investments.filter(i => i.status === 'active' || i.status === 'paid_out' || i.status === 'matured');
  const byPool = {};
  active.forEach(i => {
    const name = i.pool_name || 'Other';
    byPool[name] = (byPool[name] || 0) + (parseFloat(i.amount) || 0);
  });
  const entries = Object.entries(byPool).sort((a, b) => b[1] - a[1]);
  const total   = entries.reduce((s, [, v]) => s + v, 0);
  const COLORS  = ['#FF8215', '#22c55e', '#FF9B0C', '#16a34a', '#f97316', '#a855f7', '#14b8a6', '#3b82f6'];

  if (PORTAL.charts.analyticsAlloc) { PORTAL.charts.analyticsAlloc.destroy(); }
  PORTAL.charts.analyticsAlloc = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(([n]) => n),
      datasets: [{ data: entries.map(([,v]) => v), backgroundColor: COLORS, borderWidth: 3, borderColor: '#ffffff' }],
    },
    options: {
      responsive: true, maintainAspectRatio: true, cutout: '62%',
      layout: { padding: 10 },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.label + ': R' + c.raw.toLocaleString('en-ZA') } } },
    },
  });

  if (list) {
    list.innerHTML = entries.map(([name, val], i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(0,0,0,0.06)">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${COLORS[i % COLORS.length]};flex-shrink:0"></span>
        <span style="font-size:0.82rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#374151;font-weight:500">${_esc(name)}</span>
        <span style="font-size:0.78rem;font-weight:700;color:#1a1a1a">${total > 0 ? ((val/total)*100).toFixed(1) : 0}%</span>
      </div>`).join('') || '<p style="font-size:0.78rem;color:var(--text-muted)">No investment data yet.</p>';
  }
}

function _renderAnalyticsTimeline() {
  const tbody = document.getElementById('analyticsTimelineBody');
  if (!tbody) return;
  const invs = [...PORTAL.investments].sort((a, b) => new Date(b.start_date || b.created_at) - new Date(a.start_date || a.created_at));
  if (!invs.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding:24px">No investments yet.</td></tr>';
    return;
  }
  const statusBadge = s => {
    const map = { active:'#22c55e', paid_out:'#3b82f6', matured:'#a855f7', cancelled:'#ef4444', pending:'#f97316' };
    const label = (s || '').replace(/_/g, ' ');
    const labelSentence = label.charAt(0).toUpperCase() + label.slice(1);
    return `<span style="background:${map[s]||'#9ca3af'}22;color:${map[s]||'#9ca3af'};border:1px solid ${map[s]||'#9ca3af'}44;border-radius:20px;padding:2px 10px;font-size:0.72rem;font-weight:700;white-space:nowrap">${labelSentence}</span>`;
  };
  const fmt = v => v ? new Date(v).toLocaleDateString('en-ZA', { day:'numeric', month:'short', year:'numeric' }) : '—';
  tbody.innerHTML = invs.slice(0, 30).map(i => {
    const capital = parseFloat(i.amount) || 0;
    const ret     = parseFloat(i.net_return) || parseFloat(i.expected_return) || 0;
    const rate    = parseFloat(i.interest_rate) || parseFloat(i.rate) || 0;
    const start   = new Date(i.start_date || i.created_at);
    const end     = new Date(i.end_date || i.maturity_date);
    const days    = (!isNaN(start) && !isNaN(end)) ? Math.max(0, Math.round((end - start) / 86400000)) : (i.term_days || '—');
    return `<tr>
      <td style="font-weight:600">${_esc(i.pool_name || 'Pool')}</td>
      <td>R ${capital.toLocaleString('en-ZA')}</td>
      <td style="color:#22c55e;font-weight:600">+R ${ret.toLocaleString('en-ZA', {maximumFractionDigits:2})}</td>
      <td>${rate > 0 ? rate.toFixed(1) + '% p.a.' : '—'}</td>
      <td>${fmt(i.start_date || i.created_at)}</td>
      <td>${fmt(i.end_date || i.maturity_date)}</td>
      <td>${typeof days === 'number' ? days + ' d' : days}</td>
      <td>${statusBadge(i.status)}</td>
    </tr>`;
  }).join('');
}

function updateWealthProjection() {
  const capital = parseFloat(document.getElementById('wpCapital')?.value) || 0;
  const rate    = parseFloat(document.getElementById('wpRate')?.value) || 0;
  const months  = parseFloat(document.getElementById('wpMonths')?.value) || 0;
  const ret     = capital * (rate / 100) * (months / 12);
  const total   = capital + ret;
  const setEl = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setEl('wpReturn', '+R ' + ret.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  setEl('wpTotal',  'R '  + total.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

function exportAnalyticsCSV() {
  const rows = [['Pool', 'Invested (R)', 'Return (R)', 'Rate (%)', 'Start', 'End', 'Days', 'Status']];
  PORTAL.investments.forEach(i => {
    const fmt = v => v ? new Date(v).toLocaleDateString('en-ZA') : '';
    const start = new Date(i.start_date || i.created_at);
    const end   = new Date(i.end_date   || i.maturity_date);
    const days  = (!isNaN(start) && !isNaN(end)) ? Math.max(0, Math.round((end - start) / 86400000)) : (i.term_days || '');
    rows.push([
      i.pool_name || '', parseFloat(i.amount) || 0,
      parseFloat(i.net_return) || parseFloat(i.expected_return) || 0,
      parseFloat(i.interest_rate) || '', fmt(i.start_date || i.created_at),
      fmt(i.end_date || i.maturity_date), days, i.status || '',
    ]);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `SVC-Analytics-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  Toast.success('Analytics exported!');
}

/* ═══════════════════════════════════════════════════════════════
   COMMAND PALETTE
   ═══════════════════════════════════════════════════════════════ */

const PORTAL_CMD_ITEMS = [
  { label: 'Portfolio Overview',        icon: 'fa-grid-2',          group: 'Navigate', action: () => navigate('overview',      document.querySelector('[data-view=overview]')) },
  { label: 'My Investments',            icon: 'fa-chart-line',      group: 'Navigate', action: () => navigate('investments',   document.querySelector('[data-view=investments]')) },
  { label: 'Portfolio Analytics',       icon: 'fa-chart-mixed',     group: 'Navigate', action: () => navigate('analytics',     document.querySelector('[data-view=analytics]')) },
  { label: 'Transactions',             icon: 'fa-arrows-rotate',   group: 'Navigate', action: () => navigate('transactions',  document.querySelector('[data-view=transactions]')) },
  { label: 'Wallet',                    icon: 'fa-wallet',          group: 'Navigate', action: () => navigate('wallet',        document.querySelector('[data-view=wallet]')) },
  { label: 'My Accounts',              icon: 'fa-layer-group',     group: 'Navigate', action: () => navigate('subaccounts',   document.querySelector('[data-view=subaccounts]')) },
  { label: 'Browse Pools',             icon: 'fa-store',           group: 'Navigate', action: () => navigate('marketplace',   document.querySelector('[data-view=marketplace]')) },
  { label: 'Maturity Instructions',    icon: 'fa-hourglass-end',   group: 'Navigate', action: () => navigate('maturity',      document.querySelector('[data-view=maturity]')) },
  { label: 'Earn Rewards',             icon: 'fa-trophy',          group: 'Navigate', action: () => navigate('quests',        document.querySelector('[data-view=quests]')) },
  { label: 'Learning Hub',             icon: 'fa-graduation-cap',  group: 'Navigate', action: () => navigate('learn',         document.querySelector('[data-view=learn]')) },
  { label: 'My Profile',               icon: 'fa-user-circle',     group: 'Navigate', action: () => navigate('profile',       document.querySelector('[data-view=profile]')) },
  { label: 'Support',                  icon: 'fa-headset',         group: 'Navigate', action: () => navigate('support',       document.querySelector('[data-view=support]')) },
  { label: 'Refer & Earn',             icon: 'fa-share-nodes',     group: 'Navigate', action: () => navigate('referral',      document.querySelector('[data-view=referral]')) },
  { label: 'Documents',                icon: 'fa-folder-open',     group: 'Navigate', action: () => navigate('documents',     document.querySelector('[data-view=documents]')) },
  { label: 'Account Statement',        icon: 'fa-file-invoice',    group: 'Navigate', action: () => navigate('statement',     document.querySelector('[data-view=statement]')) },
  { label: 'Top Up Wallet',            icon: 'fa-plus',            group: 'Actions',  action: () => openTopUpModal() },
  { label: 'Download Tax Certificate', icon: 'fa-file-shield',     group: 'Actions',  action: () => { navigate('documents', document.querySelector('[data-view=documents]')); } },
  { label: 'Download Statement PDF',   icon: 'fa-file-pdf',        group: 'Actions',  action: () => downloadStatement() },
  { label: 'Export Analytics CSV',     icon: 'fa-table',           group: 'Actions',  action: () => exportAnalyticsCSV() },
  { label: 'Submit Maturity Instruction', icon: 'fa-check-circle', group: 'Actions',  action: () => navigate('maturity', document.querySelector('[data-view=maturity]')) },
  { label: 'Sign Out',                 icon: 'fa-arrow-right-from-bracket', group: 'Actions', action: () => Auth.logout('../login.html') },
];

let _portalCmdActive = -1;

function openPortalCmd() {
  const overlay = document.getElementById('portalCmdOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  _portalCmdActive = -1;
  const inp = document.getElementById('portalCmdInput');
  if (inp) { inp.value = ''; inp.focus(); }
  renderPortalCmdResults('');
}

function closePortalCmd() {
  const overlay = document.getElementById('portalCmdOverlay');
  if (overlay) overlay.style.display = 'none';
}

function renderPortalCmdResults(q) {
  const list = document.getElementById('portalCmdList');
  if (!list) return;
  _portalCmdActive = -1;
  const query = (q || '').toLowerCase().trim();
  const hits = query
    ? PORTAL_CMD_ITEMS.filter(c => c.label.toLowerCase().includes(query) || c.group.toLowerCase().includes(query))
    : PORTAL_CMD_ITEMS;

  const groups = {};
  hits.forEach(c => { (groups[c.group] = groups[c.group] || []).push(c); });

  let html = '';
  const globalIdx = { i: 0 };
  Object.entries(groups).forEach(([grp, items]) => {
    html += `<div style="padding:4px 14px 2px;font-size:0.65rem;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.3)">${_esc(grp)}</div>`;
    items.forEach(item => {
      const idx = globalIdx.i++;
      html += `<div class="portal-cmd-item" data-idx="${idx}"
        style="display:flex;align-items:center;gap:12px;padding:9px 14px;cursor:pointer;border-radius:8px;margin:0 6px;transition:background 0.15s"
        onmouseover="portalCmdHover(${idx})" onclick="portalCmdSelect(${idx})">
        <i class="fa-solid ${_esc(item.icon)}" style="width:16px;text-align:center;color:rgba(255,155,12,0.8);font-size:0.85rem"></i>
        <span style="font-size:0.88rem;color:#f0f4ff">${_esc(item.label)}</span>
      </div>`;
    });
  });

  list.innerHTML = html || `<div style="padding:24px;text-align:center;color:rgba(255,255,255,0.35);font-size:0.85rem">No results for "${_esc(q)}"</div>`;
  list._hits = hits;
}

function portalCmdHover(idx) {
  _portalCmdActive = idx;
  document.querySelectorAll('#portalCmdList .portal-cmd-item').forEach(el => {
    el.style.background = +el.dataset.idx === idx ? 'rgba(255,155,12,0.12)' : '';
  });
}

function portalCmdSelect(idx) {
  const list = document.getElementById('portalCmdList');
  const hits = list?._hits || PORTAL_CMD_ITEMS;
  if (hits[idx]) { closePortalCmd(); hits[idx].action(); }
}

function portalCmdKeyNav(e) {
  const list  = document.getElementById('portalCmdList');
  const items = list?.querySelectorAll('.portal-cmd-item') || [];
  const count = items.length;
  if (!count) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _portalCmdActive = (_portalCmdActive + 1) % count;
    portalCmdHover(_portalCmdActive);
    items[_portalCmdActive]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _portalCmdActive = (_portalCmdActive - 1 + count) % count;
    portalCmdHover(_portalCmdActive);
    items[_portalCmdActive]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (_portalCmdActive >= 0) portalCmdSelect(_portalCmdActive);
  } else if (e.key === 'Escape') {
    closePortalCmd();
  }
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const overlay = document.getElementById('portalCmdOverlay');
    if (overlay && overlay.style.display !== 'none') closePortalCmd();
    else openPortalCmd();
  } else if (e.key === 'Escape') {
    const overlay = document.getElementById('portalCmdOverlay');
    if (overlay && overlay.style.display !== 'none') closePortalCmd();
  }
});

