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
const _safeUrl = u => (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u : '#';

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
          <span class="panel__title"><i class="fa-solid fa-list-check" style="color:#656565;margin-right:8px"></i>Action Centre</span>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px">See the next best action to unlock deposits, investing, withdrawals and statements.</div>
        </div>
        <div id="taskCompletionMeta" style="margin-left:auto;font-size:0.74rem;font-weight:700;color:#656565"></div>
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
    meta.style.cssText = 'margin-bottom:12px;padding:10px 12px;border-radius:10px;background:rgba(47,140,155,0.08);border:1px solid rgba(47,140,155,0.16);font-size:0.76rem;font-weight:700;color:#656565';
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
    _setInlineMessage('supportDraftMeta', 'Drafts auto-save on this device so you can come back later.', '#656565');
    return;
  }
  _localSet(_portalScopedKey(SUPPORT_DRAFT_KEY), JSON.stringify({ ...data, saved_at: Date.now() }));
  _setInlineMessage('supportDraftMeta', 'Draft saved locally — you can safely leave and come back.', '#656565');
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
    { label: 'Complete identity verification', done: ficaReady, tone: '#FF8215', action: 'openKycUploadModal()', cta: 'Upload documents' },
    { label: 'Add a withdrawal bank account', done: bankReady, tone: '#656565', action: 'openBankDetailsModal()', cta: 'Add bank account' },
    { label: 'Add funds to your wallet', done: hasWallet, tone: '#22c55e', action: 'openTopUpModal()', cta: 'Add funds' },
    { label: 'Confirm your risk profile', done: riskReady, tone: '#eda5ff', action: 'navigate(\'profile\', document.querySelector(\'[data-view=profile]\'))', cta: 'Review profile' },
    { label: 'Make your first investment', done: hasInvestments, tone: '#D4AF37', action: 'navigate(\'marketplace\', document.querySelector(\'[data-view=marketplace]\'))', cta: 'Browse products' },
  ];
  const doneCount = tasks.filter(t => t.done).length;
  const pending = tasks.filter(t => !t.done);
  meta.textContent = `${doneCount}/${tasks.length} complete`;
  wrap.style.display = 'block';
  if (!pending.length) {
    body.innerHTML = `
      <div class="action-centre-done">
        <div class="acd-headline">
          <div class="acd-check"><i class="fa-solid fa-circle-check"></i></div>
          <div>
            <div class="acd-title">You're set up and ready to invest confidently.</div>
            <div class="acd-sub">Top up, browse new pools, or generate your latest statement.</div>
          </div>
        </div>
        <div class="acd-actions">
          <button class="acd-btn acd-btn--ghost" onclick="navigate('statement', document.querySelector('[data-view=statement]'))"><i class="fa-solid fa-file-invoice"></i><span>Statement</span></button>
          <button class="acd-btn acd-btn--primary" onclick="navigate('marketplace', document.querySelector('[data-view=marketplace]'))"><i class="fa-solid fa-plus"></i><span>Invest more</span></button>
        </div>
      </div>`;
    return;
  }
  body.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-bottom:14px">
      ${tasks.map(task => `
        <div class="ac-task${task.done ? ' ac-task--done' : ''}" ${task.done ? '' : `role="button" tabindex="0" onclick="${task.action}"`} style="padding:12px 14px;border-radius:12px;border:1px solid rgba(0,0,0,0.06);background:${task.done ? 'rgba(34,197,94,0.06)' : 'rgba(255,255,255,0.82)'};display:flex;gap:10px;align-items:center;${task.done ? '' : 'cursor:pointer'}">
          <div style="width:24px;height:24px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:${task.done ? '#22c55e' : task.tone + '22'};color:${task.done ? '#fff' : task.tone};flex-shrink:0">
            <i class="fa-solid ${task.done ? 'fa-check' : 'fa-circle'}" style="font-size:0.7rem"></i>
          </div>
          <div style="min-width:0;flex:1">
            <div style="font-size:0.8rem;font-weight:700;color:#1a1a1a;line-height:1.35">${task.label}</div>
            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px">${task.done ? 'Completed' : task.cta}</div>
          </div>
          ${task.done ? '' : `<i class="fa-solid fa-chevron-right" style="color:${task.tone};font-size:0.8rem;flex-shrink:0"></i>`}
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

  if (affordable.length) {
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
      <span style="margin-left:auto;font-size:0.72rem;font-weight:700;color:${accent};background:${accent}14;padding:4px 10px;border-radius:999px;border:1px solid ${accent}2f">${ficaApproved ? 'Investment ready checks' : 'FICA pending — withdrawals locked'}</span>
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
          <div style="font-size:0.88rem;font-weight:800;color:${ficaApproved ? '#22c55e' : '#656565'};margin-top:6px">${ficaApproved ? 'FICA/KYC approved' : 'FICA/KYC pending'}</div>
          <div style="font-size:0.74rem;color:var(--text-muted);margin-top:4px">${ficaApproved ? (bankApproved ? 'Withdrawal bank account verified.' : inv.bank_account_number ? 'Bank account pending review.' : 'Add your bank account before your first withdrawal.') : 'You can invest and top up. Withdrawals unlock once FICA is approved.'}</div>
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
  let accent = '#656565';

  if (affordable.length) {
    title = `You can invest right now in ${affordable.length} open pool${affordable.length === 1 ? '' : 's'}.`;
    sub = 'Recommended pools below are ranked by affordability, urgency, and target return so you can act quickly.';
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
    action = "filterMarket('all')";
    actionLabel = 'Show all pools';
    accent = '#eda5ff';
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
  const list = document.getElementById('notifList');
  if (list) list.innerHTML = '<div style="padding:24px 18px;text-align:center;color:#999;font-size:0.82rem">You\'re all caught up!</div>';
  const dot = document.getElementById('notifDot');
  if (dot) { dot.classList.remove('has-unread'); dot.textContent = ''; }
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
  const inv         = PORTAL.investor;
  const investments = PORTAL.investments  || [];
  const tickets     = PORTAL.tickets      || [];
  const transactions= PORTAL.transactions || [];
  const pools       = PORTAL.pools        || [];

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
  const soon = investments.filter(i => {
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
        icon: 'fa-shield-halved', iconBg: 'rgba(237,165,255,0.13)', iconColor: '#eda5ff',
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
  const overdue = investments.filter(i => {
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
  const answered = tickets.filter(t => t.admin_response && t.admin_response.trim());
  answered.forEach(t => {
    notifs.push({
      icon: 'fa-reply', iconBg: 'rgba(47,140,155,0.1)', iconColor: '#656565',
      title: 'Support reply received',
      sub: `"${t.subject}" — our team has responded.`,
      time: t.responded_at ? Utils.timeAgo(t.responded_at) : 'Recently',
      action: "navigate('support',document.querySelector('[data-view=support]'))",
      unread: true,
    });
  });

  // 7. Pending withdrawal submitted
  const pendingWithdrawal = transactions.find(t => t.type === 'withdrawal' && t.status === 'pending');
  if (pendingWithdrawal) {
    notifs.push({
      icon: 'fa-money-bill-transfer', iconBg: 'rgba(99,102,241,0.1)', iconColor: '#656565',
      title: 'Withdrawal in progress',
      sub: `${Utils.rand(Math.abs(pendingWithdrawal.amount))} withdrawal is being processed — 1–2 business days.`,
      time: Utils.timeAgo(pendingWithdrawal.created_at || pendingWithdrawal.transaction_date),
      action: "navigate('wallet',document.querySelector('[data-view=wallet]'))",
      unread: false,
    });
  }

  // 8. New pools opened in last 14 days
  const newPools = pools.filter(p => {
    if (p.status !== 'open') return false;
    return (now - new Date(p.created_at)) < 14 * 86400000;
  });
  if (newPools.length) {
    const np = newPools[0];
    notifs.push({
      icon: 'fa-chart-line', iconBg: 'rgba(47,140,155,0.1)', iconColor: '#656565',
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
        <div class="notif-title">${_esc(n.title)}</div>
        <div class="notif-sub">${_esc(n.sub)}</div>
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
  const el = document.getElementById(`view-${view}`);
  // Guard: unknown view → bail out entirely rather than stripping .active from
  // every view and leaving a fully blank screen.
  if (!el) { console.warn('[navigate] unknown view:', view); return; }
  // Add .active FIRST so there is always at least one visible view — removes
  // the white-frame moment where all views are simultaneously display:none.
  el.classList.add('active');
  // On Android WebView, force inline styles so the CSS animation never wins
  // over a blank opacity:0 frame — the GPU compositing layer created by any
  // position:fixed overlay (e.g. tour) can prevent CSS-driven repaints.
  if (window.__SVC_NATIVE__) {
    el.style.setProperty('display',             'block', 'important');
    el.style.setProperty('opacity',             '1',     'important');
    el.style.setProperty('visibility',          'visible','important');
    el.style.setProperty('animation',           'none',  'important');
    el.style.setProperty('-webkit-animation',   'none',  'important');
    el.style.setProperty('transform',           'none',  'important');
  }
  document.querySelectorAll('.view').forEach(v => {
    if (v !== el) {
      v.classList.remove('active');
      // Clear any inline styles set by the startup watchdog so CSS display:none applies
      v.style.removeProperty('display');
      v.style.removeProperty('opacity');
      v.style.removeProperty('visibility');
      v.style.removeProperty('animation');
      v.style.removeProperty('-webkit-animation');
      v.style.removeProperty('transform');
    }
  });
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');

  // Reset viewport scroll to top on every view change.
  // window.scrollTo is the correct API regardless of which element is the
  // scroll container (body.scrollTop is a no-op when body is not the scroller).
  window.scrollTo(0, 0);

  // Auto-close sidebar on mobile when navigating
  if (window.innerWidth <= 768) closeSidebar();

  const titles = {
    overview: 'Portfolio Overview', investments: 'My Investments',
    analytics: 'Portfolio Analytics',
    transactions: 'Transactions', wallet: 'Wallet', marketplace: 'Browse Pools',
    maturity: 'When Your Investment Ends', profile: 'My Profile',
    support: 'Support', referral: 'Refer & Earn', statement: 'Account Statement',
    quests: 'Earn Rewards', learn: 'Learning Hub', subaccounts: 'My Accounts',
    documents: 'Document Vault', policies: 'Platform Policies',
    gifts: 'Send a Gift',
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
    policies: renderPoliciesView,
    gifts: loadGiftsView,
    profile: () => { renderRiskProfile(); _initPushNotifToggle(); _renderKycStatusPanel(); },
  };
  if (loaders[view]) {
    const _res = loaders[view]();
    if (_res && typeof _res.catch === 'function') _res.catch(e => console.warn('[navigate] loader failed:', view, e.message));
  }

  // End timer for the previous view, start one for this view
  if (navigate._current) SVC.timeEnd('view_' + navigate._current, 'svc_section_time', { section: navigate._current });
  navigate._current = view;
  SVC.time('view_' + view);

  SVC.track('page_view', { page_title: view, page_location: window.location.href + '#' + view, portal_view: view });

  // Sync mobile bottom nav active state
  document.querySelectorAll('.mbn-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));

  // Auto-expand "More" section when navigating to a secondary view
  const _secondaryViews = ['transactions','analytics','maturity','documents','statement','subaccounts','learn','quests','gifts','policies'];
  if (_secondaryViews.includes(view)) {
    const sec = document.getElementById('navMoreSection');
    const chev = document.getElementById('navMoreChevron');
    if (sec && sec.style.display === 'none') {
      sec.style.display = 'block';
      if (chev) chev.style.transform = 'rotate(180deg)';
    }
  }

}

function toggleNavMore() {
  const sec = document.getElementById('navMoreSection');
  const chev = document.getElementById('navMoreChevron');
  if (!sec) return;
  const open = sec.style.display !== 'none';
  sec.style.display = open ? 'none' : 'block';
  if (chev) chev.style.transform = open ? '' : 'rotate(180deg)';
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

// Expose stop function so Auth.logout() can kill the interval before redirecting
window._stopPolling = function () { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } };

document.addEventListener('DOMContentLoaded', async () => {
  _preloadLogo(); // warm logo cache for PDF generation
  Toast.init();
  initDarkMode();
  initPortalFormUX();
  // Set skeleton placeholders on overview stats while data loads
  const _skelSpan = '<span class="skeleton" style="display:inline-block;width:80px;height:20px;border-radius:4px"></span>';
  ['pov-total','pov-invested','pov-wallet','pov-returns'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = _skelSpan;
  });

  // Restore nav badge counts from cache so they appear instantly before API data arrives
  _restoreNavBadgesFromCache();

  // Immediately populate greeting from cached user so name never stays "Loading..."
  try {
    const cached = JSON.parse(localStorage.getItem('svc_user') || '{}');
    const firstName = cached.firstName || cached.first_name || '';
    const lastName  = cached.lastName  || cached.last_name  || '';
    const nameEl = document.getElementById('welcomeName');
    if (nameEl && firstName) nameEl.textContent = `${firstName} ${lastName}`.trim();
    const greetEl = document.getElementById('topbarGreeting');
    if (greetEl && firstName) greetEl.textContent = `${_timeGreeting()}, ${firstName} 👋`;
    const greetEl2 = document.getElementById('welcomeGreeting');
    if (greetEl2) greetEl2.textContent = _timeGreeting();
    const avEl = document.getElementById('welcomeAvatar');
    if (avEl && firstName) avEl.textContent = ((firstName[0] || '') + (lastName[0] || '')).toUpperCase() || '?';
  } catch (_) {}

  // Try to render from cache immediately — hides cover instantly on repeat launches.
  // We always use cached data if it exists (even if stale) and always refresh in
  // background. This keeps the UI populated during CORS outages or server downtime.
  let _cacheRendered = false;
  const _CACHE_TTL   = 10 * 60 * 1000;   // 10 min — "fresh" (skip charts on BG refresh)
  const _CACHE_STALE = 24 * 60 * 60 * 1000; // 24 h  — "stale" (show data, still refresh)
  try {
    const raw = localStorage.getItem('svc_portal_cache');
    if (raw) {
      const c = JSON.parse(raw);
      const age = c && c.cachedAt ? (Date.now() - c.cachedAt) : Infinity;
      if (c && age < _CACHE_STALE) {
        PORTAL.investor     = c.investor     || null;
        PORTAL.investments  = c.investments  || [];
        PORTAL.transactions = c.transactions || [];
        PORTAL.pools        = c.pools        || [];
        PORTAL.waitlist     = c.waitlist     || [];
        if (c.products && c.products.length) { _portalProductsCache = c.products; Utils.setProductCache(c.products); }
        try { renderOverview(); } catch (_) {}
        if (window.__SVC_HIDE_COVER) window.__SVC_HIDE_COVER();
        _cacheRendered = true;
        // Fresh cache → background refresh silently; stale → refresh but still no blocking
        const _skipCharts = age < _CACHE_TTL;
        loadPortalData(0, { skipCharts: _skipCharts }).catch(() => {});
      }
    }
  } catch (_) {}

  if (!_cacheRendered) {
    // First load or expired cache — show progressive status text during cold-start waits
    const _coverText = document.getElementById('_nativeCoverText');
    const _t1 = _coverText ? setTimeout(() => {
      if (_coverText.textContent.includes('Loading')) _coverText.textContent = 'Server waking up, please wait…';
    }, 4000) : null;
    const _t2 = _coverText ? setTimeout(() => {
      if (_coverText.textContent.includes('waking')) _coverText.textContent = 'Almost there…';
    }, 9000) : null;

    await loadPortalData();
    if (_t1) clearTimeout(_t1);
    if (_t2) clearTimeout(_t2);
    // Reveal content — remove the native loading cover now that data is ready
    if (window.__SVC_HIDE_COVER) window.__SVC_HIDE_COVER();
  }

  loadNotifications();
  checkFirstDepositPrompt();
  _checkAutoStartTour();
  load2FAStatus();
  _startPolling();
  _initPullToRefresh();

  // Watchdog: runs at 100ms, 600ms, and 1500ms to ensure the active view is visible.
  // Android WebView compositing (esp. with position:fixed overlays) can silently
  // leave the active view at opacity:0. Running the watchdog at three intervals
  // catches races between data-load, cover-hide, and browser paint cycles.
  if (window.__SVC_NATIVE__) {
    const _forceViewVisible = () => {
      const active = document.querySelector('.view.active');
      if (active) {
        active.style.setProperty('display',           'block',   'important');
        active.style.setProperty('opacity',           '1',       'important');
        active.style.setProperty('visibility',        'visible', 'important');
        active.style.setProperty('transform',         'none',    'important');
        active.style.setProperty('animation',         'none',    'important');
        active.style.setProperty('-webkit-animation', 'none',    'important');
      }
      // Re-composite the main content layer. On Android WebView the scrolling
      // content layer can be left at the clear colour (solid white) after the
      // native splash is removed, even though fixed layers (topbar/nav/drawer)
      // paint. Re-asserting display:block on an already-block element does NOT
      // invalidate that layer — only a real off→on display toggle forces the
      // relayout + repaint that rebuilds and paints it.
      const pc = document.querySelector('.page-content');
      if (pc) {
        pc.style.display = 'none';
        void pc.offsetHeight;   // synchronous reflow between writes
        pc.style.display = '';
      }
    };
    // Run at multiple intervals: before tour (100ms, 600ms, 1500ms),
    // after tour starts (3000ms, 5000ms) in case the overlay causes a blank.
    setTimeout(_forceViewVisible, 100);
    setTimeout(_forceViewVisible, 600);
    setTimeout(_forceViewVisible, 1500);
    setTimeout(_forceViewVisible, 3000);
    setTimeout(_forceViewVisible, 5000);
  }
});

async function loadPortalData(_attempt = 0, _opts = {}) {
  const MAX_ATTEMPTS = 3;
  try {
    // allSettled so a single failing endpoint never kills the whole portal load.
    const [invResult, invstResult, txnResult, poolResult, payResult, prodResult] = await Promise.allSettled([
      API.investors.list({ limit: 100 }),
      API.investments.list({ limit: 200 }),
      API.transactions.list({ limit: 200 }),
      API.pools.list({ limit: 100 }),
      loadPaymentConfig(),  // load Paystack key from server env var
      API._fetch('GET', 'products'),
    ]);

    const invRes   = invResult.status   === 'fulfilled' ? invResult.value   : { data: [] };
    const invstRes = invstResult.status === 'fulfilled' ? invstResult.value : { data: [] };
    const txnRes   = txnResult.status   === 'fulfilled' ? txnResult.value   : { data: [] };
    const poolRes  = poolResult.status  === 'fulfilled' ? poolResult.value  : { data: [] };
    const prodRes  = prodResult.status  === 'fulfilled' ? prodResult.value  : { data: [] };

    if (invResult.status === 'rejected')   console.warn('[portal] investors API failed:', invResult.reason?.message);
    if (invstResult.status === 'rejected') console.warn('[portal] investments API failed:', invstResult.reason?.message);
    if (txnResult.status === 'rejected')   console.warn('[portal] transactions API failed:', txnResult.reason?.message);
    if (poolResult.status === 'rejected')  console.warn('[portal] pools API failed:', poolResult.reason?.message);
    if (payResult.status  === 'rejected')  console.warn('[portal] payment config failed:', payResult.reason?.message);
    if (prodResult.status === 'rejected')  console.warn('[portal] products API failed:', prodResult.reason?.message);

    if (invResult.status === 'rejected' && invstResult.status === 'rejected' && txnResult.status === 'rejected') {
      throw invResult.reason;
    }

    let allInvestors     = invRes.data   || [];
    const allInvestments = invstRes.data || [];
    const allTxns        = txnRes.data   || [];

    // Only overwrite PORTAL.investor when the investors call succeeded; if it failed
    // (e.g. CORS block), keep whatever is already in PORTAL.investor from the cache.
    if (invResult.status === 'fulfilled') {
      // Find the logged-in investor by their JWT-resolved ID
      PORTAL.investor = allInvestors.find(i => i.id === DEMO_INVESTOR_ID) || null;

      // Fallback: the server already scopes investor-role list results to the authenticated user,
      // so any item in allInvestors belongs to this user — use the first one when find-by-ID fails.
      if (!PORTAL.investor && allInvestors.length > 0) {
        PORTAL.investor = allInvestors[0];
      }
    }

    // Last resort: if the list returned empty (server could not resolve investor from JWT),
    // call /api/auth/me to get the live investor_id from the DB, then use the single-record
    // GET which has the email fallback and bypasses the list isolation guard.
    if (!PORTAL.investor) {
      try {
        const meData = await API.me();
        const freshInvestorId = meData && (meData.investor_id || meData.investorId);
        if (freshInvestorId) {
          const inv = await API.investors.get(freshInvestorId).catch(() => null);
          if (inv && inv.id) {
            PORTAL.investor = inv;
            allInvestors = [inv];
          }
        }
      } catch (_) {}
    }

    const resolvedId = PORTAL.investor?.id || DEMO_INVESTOR_ID;

    // Filter investments and transactions to the resolved investor
    let myInvests = allInvestments.filter(i => i.investor_id === resolvedId);
    let myTxns    = allTxns.filter(t => t.investor_id === resolvedId);

    // Case-insensitive fallback if IDs use different casing/formats
    if (myInvests.length === 0 && allInvestments.length > 0) {
      const idLower = resolvedId.toLowerCase();
      myInvests = allInvestments.filter(i =>
        (i.investor_id || '').toLowerCase() === idLower ||
        (i.investor_name || '').toLowerCase().includes((PORTAL.investor?.first_name || '').toLowerCase())
      );
    }
    if (myTxns.length === 0 && allTxns.length > 0) {
      const idLower = resolvedId.toLowerCase();
      myTxns = allTxns.filter(t =>
        (t.investor_id || '').toLowerCase() === idLower ||
        (t.investor_name || '').toLowerCase().includes((PORTAL.investor?.first_name || '').toLowerCase())
      );
    }
    // Last-resort: if the client ID (DEMO_INVESTOR_ID fallback) doesn't match anything
    // but the server already returned scoped data, trust the server's result directly.
    // This handles the case where users.investor_id is null in the DB so the JWT carries
    // investorId: null and the client falls back to the legacy 'INV-001' placeholder.
    if (myInvests.length === 0 && allInvestments.length > 0) {
      console.warn('[portal] Client ID mismatch — using server-scoped investments directly');
      myInvests = allInvestments;
    }
    if (myTxns.length === 0 && allTxns.length > 0) {
      myTxns = allTxns;
    }

    if (!PORTAL.investor) {
      console.error('[portal] Could not resolve investor — showing empty state');
      PORTAL.investor = { id: resolvedId };
    }

    // Populate products cache from the parallel fetch so marketplace uses it immediately
    if (prodRes.data && prodRes.data.length) {
      _portalProductsCache = prodRes.data;
      Utils.setProductCache(_portalProductsCache);
    }

    // Only overwrite PORTAL state when the API call actually succeeded.
    // A rejected/CORS-blocked call returns [] which would wipe valid cached data.
    if (invstResult.status === 'fulfilled') {
      PORTAL.investments = myInvests.map(inv => ({
        ...inv,
        amount:                 parseFloat(inv.amount || inv.investment_amount || inv.principal || 0) || 0,
        maturity_date:          inv.end_date         || inv.maturity_date,
        investment_date:        inv.start_date        || inv.investment_date,
        expected_return_amount: parseFloat(inv.expected_return   != null ? inv.expected_return   : (inv.expected_return_amount   || 0)) || 0,
        actual_return_amount:   parseFloat(inv.actual_return     != null ? inv.actual_return     : (inv.actual_return_amount     || 0)) || 0,
        expected_return_rate:   parseFloat(inv.annual_rate       != null ? inv.annual_rate       : (inv.expected_return_rate     || 0)) || 0,
      }));
    }
    if (txnResult.status === 'fulfilled') PORTAL.transactions = myTxns;
    if (poolResult.status === 'fulfilled' && (poolRes.data || []).length) PORTAL.pools = poolRes.data;

    // Ensure investor object is never null so statement guard passes
    if (!PORTAL.investor) PORTAL.investor = { id: DEMO_INVESTOR_ID };

    // Load waitlist entries for this investor (non-blocking)
    const waitlistRes = await API._fetch('GET', 'tables/investment_waitlist', null, { investor_id: PORTAL.investor.id, limit: 50 }).catch(() => ({ data: [] }));
    PORTAL.waitlist = waitlistRes.data || [];

    try { SVC.setUser(PORTAL.investor); } catch (_) {}
    try { SVC.track('portal_loaded', { active_investments: PORTAL.investments.filter(i => i.status === 'active').length }); } catch (_) {}

    // Cache fresh data so the next launch renders instantly from localStorage.
    // Only overwrite each key when its API call succeeded — preserve the previous
    // cached value for any endpoint that was rejected (e.g. CORS-blocked), so a
    // partial refresh never writes an empty array over good cached data.
    try {
      let _prev = {};
      try { _prev = JSON.parse(localStorage.getItem('svc_portal_cache') || '{}'); } catch (_) {}
      const _safeCache = {
        cachedAt:     Date.now(),
        investor:     invResult.status    === 'fulfilled' ? PORTAL.investor     : (_prev.investor     || PORTAL.investor),
        investments:  invstResult.status  === 'fulfilled' ? PORTAL.investments  : (_prev.investments  || PORTAL.investments),
        transactions: txnResult.status    === 'fulfilled' ? PORTAL.transactions : (_prev.transactions || PORTAL.transactions),
        pools:        poolResult.status   === 'fulfilled' ? PORTAL.pools        : (_prev.pools        || PORTAL.pools),
        waitlist:     PORTAL.waitlist,
        products:     (_portalProductsCache && _portalProductsCache.length) ? _portalProductsCache : (_prev.products || []),
      };
      localStorage.setItem('svc_portal_cache', JSON.stringify(_safeCache));
    } catch (_) {}

    renderOverview(_opts.skipCharts);
    renderOnboardingWizard();
    updateStmtQuickStats();
    _renderBankDetailsPanel();
    // Re-populate profile if user navigated there before data loaded
    if (document.getElementById('view-profile')?.classList.contains('view--active')) {
      renderRiskProfile();
    }

    // Load gamification data (non-blocking — don't fail portal if quests fail)
    loadQuestData().catch(err => console.warn('[Quests] load error:', err.message));

    // Pre-populate nav badges non-blocking so counts appear without navigating
    _prefetchNavBadges();
  } catch (e) {
    console.error(`loadPortalData error (attempt ${_attempt + 1}):`, e);

    // Auth errors: do not retry — the session-expired overlay is already showing
    if (e.message && e.message.includes('Session expired')) return;

    // Network / timeout errors: retry with backoff (handles Railway cold-start)
    if (_attempt < MAX_ATTEMPTS - 1) {
      const delay = (_attempt + 1) * 3000; // 3 s, 6 s
      console.log(`[portal] Retrying data load in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
      return loadPortalData(_attempt + 1, _opts);
    }

    // All attempts exhausted — ensure investor stub exists so renderOverview clears "Loading..."
    if (!PORTAL.investor) PORTAL.investor = { id: DEMO_INVESTOR_ID };
    try { renderOverview(); } catch (_) {}
    if (window.__SVC_HIDE_COVER) window.__SVC_HIDE_COVER();
    Toast.error('Could not connect to server — pull down to refresh');
  }
}

/* ═══════════════════════════════════════════════
   OVERVIEW
   ═══════════════════════════════════════════════ */
function renderOverview(skipCharts) {
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

  const retEl2 = document.getElementById('pov-return');
  if (retEl2) retEl2.innerHTML = `<i class="fa-solid fa-arrow-trend-up"></i> <span>+${returnPct}% effective return · ${Utils.rand(totalRet)} earned</span>`;

  const invEl = document.getElementById('pov-invested');
  if (invEl) _animateNum(invEl, totalInvested, 'R ', '', 900);
  const walEl = document.getElementById('pov-wallet');
  if (walEl) _animateNum(walEl, inv.wallet_balance || 0, 'R ', '', 800);
  const retEl = document.getElementById('pov-returns');
  if (retEl) _animateNum(retEl, totalRet, 'R ', '', 900);
  const actEl = document.getElementById('pov-active');
  if (actEl) actEl.textContent = activeCount;

  // ── Rewards & XP stat ──────────────────────────────────────
  const referralTotal = PORTAL.transactions
    .filter(t => t.type === 'referral_bonus' && t.status !== 'rejected')
    .reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);
  const rewEl = document.getElementById('pov-rewards');
  if (rewEl) {
    const xp = PORTAL.quests?.xp || 0;
    const lvl = _getLevelForXP(xp);
    if (referralTotal > 0) {
      _animateNum(rewEl, referralTotal, 'R ', '', 900);
    } else {
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
      nextTxt.textContent = `Payout in ${days}d`;
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
        <div class="fica-alert-banner__title">Identity Verification Pending</div>
        <div class="fica-alert-banner__sub">Your documents are being reviewed — usually 1–2 business days. You can still browse products and invest in the meantime. Withdrawals unlock once your identity is verified.</div>
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
  if (perfRate)     perfRate.textContent     = returnPct + '% per year';
  if (perfPools)    perfPools.textContent    = activeCount + ' active';

  renderOverviewInvestments();
  renderOverviewTxns();
  if (!skipCharts) {
    renderPortfolioTrendChart();
    renderAllocationChart();
  }
  renderXPWidget();
  renderTaskCompletionPanel();

  // "How SV Capital works" panel — shown only to users who have never invested
  const _neverInvested = !(PORTAL.investments && PORTAL.investments.length);
  let _howPanel = document.getElementById('howItWorksPanel');
  if (_neverInvested && !_howPanel) {
    _howPanel = document.createElement('div');
    _howPanel.id = 'howItWorksPanel';
    _howPanel.style.cssText = 'margin-bottom:20px';
    _howPanel.innerHTML = `
      <div class="panel" style="border:1.5px solid rgba(0,150,255,0.2);background:linear-gradient(135deg,rgba(0,150,255,0.04),rgba(0,150,255,0.01))">
        <div class="panel__header" style="align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div>
            <span class="panel__title"><i class="fa-solid fa-seedling" style="color:#0096ff;margin-right:8px"></i>How SV Capital works</span>
            <div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px">From sign-up to earning a return — here is the full picture.</div>
          </div>
          <button class="btn btn--ghost btn--sm" style="margin-left:auto" onclick="navigate('learn', document.querySelector('[data-view=learn]'))">
            <i class="fa-solid fa-graduation-cap"></i> Learning Hub
          </button>
        </div>
        <div class="panel__body">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px">
            <div style="padding:14px;border-radius:12px;background:rgba(0,0,0,0.03)">
              <div style="width:30px;height:30px;border-radius:50%;background:rgba(0,150,255,0.12);color:#0096ff;display:flex;align-items:center;justify-content:center;margin-bottom:10px"><i class="fa-solid fa-id-card" style="font-size:0.85rem"></i></div>
              <div style="font-weight:700;font-size:0.86rem;margin-bottom:5px">1. Verify your identity</div>
              <div style="font-size:0.77rem;color:var(--text-muted);line-height:1.55">Upload your ID documents once. Required by law — usually approved within 1–2 business days.</div>
            </div>
            <div style="padding:14px;border-radius:12px;background:rgba(0,0,0,0.03)">
              <div style="width:30px;height:30px;border-radius:50%;background:rgba(0,150,255,0.12);color:#0096ff;display:flex;align-items:center;justify-content:center;margin-bottom:10px"><i class="fa-solid fa-wallet" style="font-size:0.85rem"></i></div>
              <div style="font-weight:700;font-size:0.86rem;margin-bottom:5px">2. Add funds</div>
              <div style="font-size:0.77rem;color:var(--text-muted);line-height:1.55">Transfer money into your wallet via EFT or card. Your funds sit in your wallet until you choose to invest.</div>
            </div>
            <div style="padding:14px;border-radius:12px;background:rgba(0,0,0,0.03)">
              <div style="width:30px;height:30px;border-radius:50%;background:rgba(0,150,255,0.12);color:#0096ff;display:flex;align-items:center;justify-content:center;margin-bottom:10px"><i class="fa-solid fa-chart-line" style="font-size:0.85rem"></i></div>
              <div style="font-weight:700;font-size:0.86rem;margin-bottom:5px">3. Choose an investment</div>
              <div style="font-size:0.77rem;color:var(--text-muted);line-height:1.55">Browse products and invest. Your capital is locked for a set term and earns a return. At the end of the term, everything is returned to your wallet.</div>
            </div>
          </div>
        </div>
      </div>`;
    const _heroEl = document.querySelector('#view-overview .portfolio-hero');
    if (_heroEl) _heroEl.before(_howPanel);
  } else if (!_neverInvested && _howPanel) {
    _howPanel.remove();
  }
}

/* ─── Onboarding Wizard ──────────────────────────────────────────── */
function renderOnboardingWizard() {
  const wizard = document.getElementById('onboardingWizard');
  if (!wizard) return;

  // The Action Centre is now the single onboarding checklist — retire the
  // duplicate "Getting Started" wizard so the overview isn't cluttered with
  // two identical step lists.
  wizard.style.display = 'none';
  return;

  // eslint-disable-next-line no-unreachable
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
      label: 'Identity Verification',
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
      label: 'Add Funds',
      icon: 'wallet',
      done: walletDone,
      action: 'openTopUpModal()',
      actionLabel: 'Add Funds'
    },
    {
      label: 'Make First Investment',
      icon: 'coins',
      done: investDone,
      action: "navigate('marketplace', document.querySelector('[data-view=marketplace]'))",
      actionLabel: 'Browse Products'
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
  if (!body) return;
  const active = PORTAL.investments.filter(i => i.status === 'active');

  if (!active.length) { body.innerHTML = '<div class="text-center text-muted" style="padding:24px">No active investments. <a href="#" onclick="navigate(\'marketplace\', null)" style="color:var(--gold)">Browse pools →</a></div>'; return; }

  body.innerHTML = active.map(inv => {
    const pi = Utils.productInfo(inv.product_type);
    const days = Utils.daysRemaining(inv.maturity_date);
    const pool = PORTAL.pools.find(p => p.id === inv.pool_id);
    const progress = pool ? Utils.poolFillPct(pool) : 100;
    const soon = days !== null && days <= 30;

    return `
      <div class="ov-inv">
        <div class="ov-inv__icon ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i></div>
        <div class="ov-inv__main">
          <div class="ov-inv__name">${_esc(inv.pool_name)}</div>
          <div class="ov-inv__sub">${pi.label} · ${days !== null ? `<span style="${soon ? 'color:#d97706;font-weight:700' : ''}">${days} days left</span>` : 'Active'}</div>
          <div class="ov-inv__bar"><div class="ov-inv__bar-fill" style="width:${progress}%"></div></div>
        </div>
        <div class="ov-inv__right">
          <div class="ov-inv__amount">${Utils.rand(inv.amount)}</div>
        </div>
      </div>`;
  }).join('');
}

function renderOverviewTxns() {
  const body = document.getElementById('overviewTxnBody');
  if (!body) return;
  const recent = [...PORTAL.transactions].sort((a, b) => new Date(b.transaction_date || b.created_at || 0) - new Date(a.transaction_date || a.created_at || 0)).slice(0, 5);

  if (!recent.length) { body.innerHTML = '<div class="text-center text-muted" style="padding:24px">No transactions yet</div>'; return; }

  const _txnIsPositive = t => !['withdrawal', 'fee', 'investment', 'gift_sent'].includes(t.type);
  body.innerHTML = recent.map(t => {
    const pos = _txnIsPositive(t);
    const meta = _TXN_META[t.type] || { icon: 'fa-circle-dot', color: '#9ca3af', label: (t.type || 'Transaction').replace(/_/g, ' ') };
    return `
      <div class="ov-txn">
        <div class="ov-txn__icon" style="background:${meta.color}1a;color:${meta.color}"><i class="fa-solid ${meta.icon}"></i></div>
        <div class="ov-txn__main">
          <div class="ov-txn__label">${meta.label}</div>
          <div class="ov-txn__date">${t.description ? _esc(t.description) + ' · ' : ''}${Utils.date(t.transaction_date)}</div>
        </div>
        <div class="ov-txn__amount" style="color:${pos ? '#16a34a' : '#dc2626'}">${pos ? '+' : '-'}${Utils.rand(Math.abs(t.amount))}</div>
      </div>`;
  }).join('');
}

function renderPortfolioTrendChart() {
  const canvas = document.getElementById('portfolioTrendChart');
  if (!canvas) return;
  // Skip if canvas is inside a hidden parent (mobile hides portfolio-hero__right).
  // Rendering Chart.js onto a zero-size hidden canvas creates orphan GPU
  // compositor layers on Android WebView that cause content to go blank.
  if (canvas.offsetParent === null) return;

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
      animation:           window.__SVC_NATIVE__ ? false : { duration: 600, easing: 'easeInOutQuart' },
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
  // Skip if canvas is inside a hidden parent — rendering onto a zero-size hidden canvas
  // creates orphan GPU compositor layers on Android WebView that cause content to blank.
  if (ctx.offsetParent === null) return;

  const activeInvests = PORTAL.investments.filter(i => i.status === 'active');
  const byType = {};
  activeInvests.forEach(i => {
    const type = i.product_type || 'other';
    if (!byType[type]) byType[type] = { label: Utils.productInfo(type).label, color: Utils.productInfo(type).color, amount: 0 };
    byType[type].amount += parseFloat(i.amount) || 0;
  });

  const isEmpty = !Object.keys(byType).length;
  if (isEmpty) byType['none'] = { label: 'No Investments', color: '#656565', amount: 1 };

  const labels = Object.values(byType).map(v => v.label);
  const values = Object.values(byType).map(v => v.amount);
  const colors = Object.values(byType).map(v => v.color);
  const total  = values.reduce((s, v) => s + v, 0);

  if (PORTAL.charts.alloc) PORTAL.charts.alloc.destroy();
  PORTAL.charts.alloc = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderColor: '#ffffff', borderWidth: 2, hoverOffset: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: window.__SVC_NATIVE__ ? false : undefined,
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
    const color = colors[idx] || '#656565';
    return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(0,0,0,0.06)">
      <span style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></span>
      <span style="flex:1;font-size:0.8rem;color:var(--text-primary,#1a1a1a)">${label}</span>
      <span style="font-size:0.8rem;font-weight:600;color:var(--text-primary,#1a1a1a)">${Utils.rand(amt)}</span>
      <span style="font-size:0.72rem;color:var(--text-muted,#6b7280);min-width:38px;text-align:right">${pct}%</span>
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
  const _s = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  _s('mi-capital',  Utils.rand(d.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0)));
  _s('mi-expected', Utils.rand(d.reduce((s, i) => s + (parseFloat(i.expected_return_amount) || 0), 0)));
  _s('mi-earned',   Utils.rand(d.reduce((s, i) => s + (parseFloat(i.actual_return_amount) || 0), 0)));
  _s('mi-count',    d.length);
}

function filterMyInvestments(filter, btn) {
  PORTAL.myInvFilter = filter;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderMyInvestmentCards();
  SVC.track('svc_filter_changed', { filter_type: 'my_investments', filter_value: filter });
}

function populateMyInvProductFilter() {
  const sel = document.getElementById('myInvProductFilter');
  if (!sel) return;
  const types = [...new Set((PORTAL.investments || []).map(i => i.product_type).filter(Boolean))];
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Products</option>' +
    types.map(t => `<option value="${_esc(t)}">${_esc(Utils.productInfo(t).label)}</option>`).join('');
  if (types.includes(cur)) sel.value = cur;
}

function renderMyInvestmentCards() {
  populateMyInvProductFilter();
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
    const isPaidOut = inv.status === 'matured' || inv.status === 'paid_out';

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
          <div class="mic-stat"><span class="mic-stat__label">Amount Invested</span><span class="mic-stat__value mic-stat__value--gold">${Utils.rand(Math.round(inv.amount * 0.99 * 100) / 100)}</span></div>
          <div class="mic-stat"><span class="mic-stat__label">Launch Date</span><span class="mic-stat__value">${Utils.date(inv.investment_date || inv.start_date)}</span></div>
          <div class="mic-stat"><span class="mic-stat__label">Maturity Date</span><span class="mic-stat__value">${Utils.date(inv.maturity_date)}</span></div>
          ${isPaidOut ? `
          <div class="mic-stat"><span class="mic-stat__label">Return Rate</span><span class="mic-stat__value">${Utils.pct(inv.annual_rate || inv.expected_return_rate)}</span></div>
          <div class="mic-stat"><span class="mic-stat__label">Capital + Return</span><span class="mic-stat__value" style="color:var(--green)">${Utils.rand(inv.amount + (inv.actual_return_amount || inv.expected_return_amount || 0))}</span></div>
          ` : ''}
        </div>

        ${inv.status === 'active' ? `
          <button class="btn btn--secondary btn--full btn--sm" onclick='openMaturityModal(${JSON.stringify(inv.id)})' style="margin-top:6px;font-size:0.76rem">
            <i class="fa-solid fa-hourglass-half"></i> Set Maturity Instruction
          </button>
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

  // Guard against duplicate listeners on repeated tab visits
  const _tf = document.getElementById('myTxnTypeFilter');
  if (_tf && !_tf.__txnListenerAdded) {
    _tf.addEventListener('change', renderMyTxnTable);
    _tf.__txnListenerAdded = true;
  }
}

/* Icon + accent colour per transaction type */
const _TXN_META = {
  deposit:        { icon: 'fa-download',            color: '#22c55e', label: 'Deposit' },
  investment:     { icon: 'fa-chart-line',          color: '#3b82f6', label: 'Investment' },
  return:         { icon: 'fa-arrow-trend-up',      color: '#eab308', label: 'Return Payment' },
  payout:         { icon: 'fa-money-bill-wave',     color: '#22c55e', label: 'Payout' },
  reinvestment:   { icon: 'fa-arrows-rotate',       color: '#3b82f6', label: 'Re-investment' },
  fee:            { icon: 'fa-receipt',             color: '#f59e0b', label: 'Platform Fee' },
  referral_bonus: { icon: 'fa-user-group',          color: '#eda5ff', label: 'Referral Bonus' },
  withdrawal:     { icon: 'fa-upload',              color: '#ef4444', label: 'Withdrawal' },
  gift_sent:      { icon: 'fa-gift',                color: '#f59e0b', label: 'Gift Sent' },
  gift_received:  { icon: 'fa-gift',                color: '#22c55e', label: 'Gift Received' },
  reward:         { icon: 'fa-award',               color: '#eda5ff', label: 'Reward' },
};

function _setTxnFilter(type, btn) {
  const sel = document.getElementById('myTxnTypeFilter');
  if (sel) sel.value = type;
  document.querySelectorAll('#txnFilterPills .txn-pill').forEach(p => p.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderMyTxnTable();
  SVC.track('svc_filter_changed', { filter_type: 'transactions', filter_value: type || 'all' });
}

function renderMyTxnTable() {
  const body = document.getElementById('myTxnBody');
  if (!body) return;
  const filter = document.getElementById('myTxnTypeFilter')?.value || '';
  const items = filter ? PORTAL.transactions.filter(t => t.type === filter) : PORTAL.transactions;
  const sorted = [...items].sort((a, b) => new Date(b.transaction_date || b.created_at || 0) - new Date(a.transaction_date || a.created_at || 0));

  // Summary strip — money in vs out (all transactions, unfiltered)
  const summary = document.getElementById('txnSummary');
  if (summary) {
    const _isPos = t => !['withdrawal', 'fee', 'investment', 'gift_sent'].includes(t.type);
    let moneyIn = 0, moneyOut = 0;
    PORTAL.transactions.forEach(t => {
      const amt = Math.abs(parseFloat(t.amount) || 0);
      if (t.status === 'rejected' || t.status === 'failed') return;
      if (_isPos(t)) moneyIn += amt; else moneyOut += amt;
    });
    summary.innerHTML = `
      <div class="txn-summary__item">
        <div class="txn-summary__icon" style="background:rgba(34,197,94,0.15);color:#22c55e"><i class="fa-solid fa-arrow-down"></i></div>
        <div><div class="txn-summary__label">Money In</div><div class="txn-summary__value" style="color:#22c55e">${Utils.rand(moneyIn)}</div></div>
      </div>
      <div class="txn-summary__divider"></div>
      <div class="txn-summary__item">
        <div class="txn-summary__icon" style="background:rgba(239,68,68,0.12);color:#ef4444"><i class="fa-solid fa-arrow-up"></i></div>
        <div><div class="txn-summary__label">Money Out</div><div class="txn-summary__value" style="color:#ef4444">${Utils.rand(moneyOut)}</div></div>
      </div>`;
  }

  if (!sorted.length) {
    body.innerHTML = `<div class="empty-state">
        <i class="fa-solid fa-receipt"></i>
        <div class="empty-state__title">No transactions yet</div>
        <div class="empty-state__sub">Top up your wallet or make an investment to see activity here.<br>
          <a href="#" onclick="navigate('wallet', document.querySelector('[data-view=wallet]'))" style="color:var(--gold)">Go to Wallet →</a>
        </div>
      </div>`;
    return;
  }

  const _isPosTxn = t => !['withdrawal', 'fee', 'investment', 'gift_sent'].includes(t.type);

  // Group by month for section headers
  let lastMonth = '';
  body.innerHTML = sorted.map(t => {
    const pos  = _isPosTxn(t);
    const meta = _TXN_META[t.type] || { icon: 'fa-circle-dot', color: '#9ca3af', label: (t.type || 'Transaction').replace(/_/g, ' ') };
    const d    = new Date(t.transaction_date || t.created_at || 0);
    const month = d.toLocaleString('default', { month: 'long', year: 'numeric' });
    let header = '';
    if (month !== lastMonth) { header = `<div class="txn-month">${month}</div>`; lastMonth = month; }

    return `${header}
      <div class="txn-card">
        <div class="txn-card__icon" style="background:${meta.color}1a;color:${meta.color}">
          <i class="fa-solid ${meta.icon}"></i>
        </div>
        <div class="txn-card__main">
          <div class="txn-card__title">${meta.label}</div>
          <div class="txn-card__meta">${t.description || t.reference || '—'}</div>
        </div>
        <div class="txn-card__right">
          <div class="txn-card__amount" style="color:${pos ? '#16a34a' : '#dc2626'}">${pos ? '+' : '-'}${Utils.rand(Math.abs(t.amount))}</div>
          <div class="txn-card__status txn-card__status--${(t.status || '').toLowerCase()}">${(t.status || 'completed').replace(/^\w/, c => c.toUpperCase())}</div>
        </div>
      </div>`;
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
  const typeColor = { return: '#22c55e', payout: '#ff9b0c', referral_bonus: '#eda5ff' };

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
  // Pre-render recurring tab if it's already visible (or will be on re-render)
  if (document.getElementById('walletRecurringTab')?.style.display !== 'none') _renderRecurringTab();

  const activity = document.getElementById('walletActivity');
  const walletTxns = [...PORTAL.transactions]
    .filter(t => ['deposit', 'return', 'payout', 'referral_bonus', 'withdrawal', 'gift_sent', 'gift_received'].includes(t.type))
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
    const isOut = ['withdrawal', 'gift_sent'].includes(t.type);
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

  const PRODUCT_LABELS = { cattle:'Cattle Finance', solar_7yr:'Solar Energy 7yr', solar_6yr:'Solar Energy 6yr', solar_5yr:'Solar Energy 5yr', short_term:'Short Term', smme:'SMME Finance', delivery_bike:'Delivery Bike', other:'Other' };
  const productType = inv?.recurring_product_type;
  const isActive    = !!(inv?.recurring_enabled && inv?.recurring_amount && productType);
  const day         = inv?.recurring_day || 1;

  const badge = document.getElementById('recurringActiveBadge');
  if (badge) badge.style.display = isActive ? 'inline-flex' : 'none';

  if (isActive) {
    const today     = new Date();
    const thisMonth = new Date(today.getFullYear(), today.getMonth(), day);
    const nextRun   = thisMonth > today
      ? thisMonth
      : new Date(today.getFullYear(), today.getMonth() + 1, day);
    const daysUntil = Math.ceil((nextRun - today) / 86400000);
    const suffix    = day === 1 ? 'st' : day === 2 ? 'nd' : day === 3 ? 'rd' : 'th';
    statusCard.innerHTML = `
      <div class="wallet-card__label">Recurring Investment
        <span style="background:rgba(34,197,94,0.15);color:#22c55e;font-size:0.65rem;font-weight:700;padding:2px 8px;border-radius:20px;margin-left:8px;vertical-align:middle">Active</span>
      </div>
      <div class="wallet-card__value" style="color:#ff9b0c">${Utils.rand(inv.recurring_amount)}<span style="font-size:0.85rem;font-weight:500;color:#6b7280;margin-left:4px">/ month</span></div>
      <div class="wallet-card__sub"><i class="fa-solid fa-layer-group" style="margin-right:4px"></i>${PRODUCT_LABELS[productType] || productType} &nbsp;·&nbsp; Every ${day}${suffix} of the month &nbsp;·&nbsp; Next in <strong>${daysUntil} day${daysUntil !== 1 ? 's' : ''}</strong></div>
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

  // Show active investments matching the selected product type
  const recurringInvs = productType
    ? PORTAL.investments.filter(i => i.status === 'active' && i.product_type === productType)
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
      recurring_enabled: false, recurring_amount: null,
      recurring_product_type: null, recurring_day: null,
    });
    if (PORTAL.investor) {
      PORTAL.investor.recurring_enabled      = false;
      PORTAL.investor.recurring_amount       = null;
      PORTAL.investor.recurring_product_type = null;
      PORTAL.investor.recurring_day          = null;
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
function openTopUpModal(gateway, saId) {
  _pmAmount  = 0;
  _pmGateway = null;
  _pmSaId    = saId || null;

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
  if (gateway === 'paystack') {
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
    const card = _pmEl(_pmGateway === 'paystack' ? 'gwPaystack' : 'gwEft');
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
  const map = { paystack: 'gwPaystack', eft: 'gwEft' };
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
  else if (_pmGateway === 'eft') showEftDetails();
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
          investor_id:    _pmInvestorId(),
          investor_name:  _pmInvestorName(),
          wallet_credit:  _pmAmount,
          gateway_fee:    _pmFee(_pmAmount),
          sub_account_id: _pmSaId || undefined,
          custom_fields: [
            { display_name: 'Investor ID',      variable_name: 'investor_id',    value: _pmInvestorId() },
            { display_name: 'Investor Name',    variable_name: 'investor_name',  value: _pmInvestorName() },
            { display_name: 'Wallet Credit',    variable_name: 'wallet_credit',  value: `R${_pmAmount}` },
            { display_name: 'Gateway Fee',      variable_name: 'gateway_fee',    value: `R${_pmFee(_pmAmount)}` },
            { display_name: 'Sub Account ID',   variable_name: 'sub_account_id', value: _pmSaId || '' },
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
              subAccountId: _pmSaId || undefined,
            });
            if (result.error) throw new Error(result.error);

            // Update local cache so UI reflects the new balance immediately
            if (!result.alreadyProcessed) {
              if (_pmSaId) {
                // Credit sub-account wallet locally
                const saIdx = PORTAL.subAccounts.findIndex(s => s.id === _pmSaId);
                if (saIdx !== -1) {
                  PORTAL.subAccounts[saIdx].wallet_balance =
                    Math.round(((parseFloat(PORTAL.subAccounts[saIdx].wallet_balance) || 0) + _pmAmount) * 100) / 100;
                }
              } else if (PORTAL.investor) {
                PORTAL.investor.wallet_balance = (parseFloat(PORTAL.investor.wallet_balance) || 0) + _pmAmount;
                _refreshWalletUI(PORTAL.investor.wallet_balance);
              }
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
  const isGateway = gateway === 'paystack';
  const fee = isGateway ? _pmFee(_pmAmount) : 0;
  const fmtBase = `R${_pmAmount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  _pmEl('pmSuccessAmount').innerHTML =
    `<strong style="color:#22c55e">${fmtBase}</strong> successfully credited to your wallet` +
    (fee > 0 ? `<br><span style="font-size:0.75rem;color:#6b7280">R${fee.toFixed(2)} gateway fee charged by Paystack</span>` : '');
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

    // 3. If completed, update the correct wallet in the DB.
    //    Paystack deposits are handled server-side via /api/payments/paystack/verify.
    //    For EFT/other gateways, patch the appropriate wallet client-side.
    if (status === 'completed' && gateway !== 'paystack') {
      if (_pmSaId) {
        // Sub-account deposit: credit sub-account wallet ONLY (not main investor wallet)
        const saIdx = PORTAL.subAccounts.findIndex(s => s.id === _pmSaId);
        if (saIdx !== -1) {
          const newSaBal = Math.round(((parseFloat(PORTAL.subAccounts[saIdx].wallet_balance) || 0) + _pmAmount) * 100) / 100;
          try {
            await API._fetch('PATCH', `tables/sub_accounts/${_pmSaId}`, { wallet_balance: newSaBal });
            PORTAL.subAccounts[saIdx].wallet_balance = newSaBal;
          } catch (saErr) { console.warn('Sub-account wallet update failed:', saErr); }
        }
      } else if (PORTAL.investor) {
        const newBalance = Math.round(((parseFloat(PORTAL.investor.wallet_balance) || 0) + _pmAmount) * 100) / 100;
        try {
          await API.investors.update(PORTAL.investor.id, { wallet_balance: newBalance });
        } catch (dbErr) {
          console.warn('wallet_balance PATCH failed:', dbErr.message);
        }
        PORTAL.investor.wallet_balance = newBalance;
        _refreshWalletUI(newBalance);
      }
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


/* ═══════════════════════════════════════════════
   MARKETPLACE
   ═══════════════════════════════════════════════ */
let _mktProducts = [];
let _selectedProductType = null;   // null = product grid; set = product detail

async function loadMarketplace() {
  try {
    if (!PORTAL.pools.length) {
      const res = await API.pools.list({ limit: 100 });
      PORTAL.pools = res.data || [];
    }
  } catch (err) {
    console.warn('[marketplace] failed to fetch pools:', err);
    // Render with whatever is cached — show empty state rather than "Loading..."
  }
  try { _mktProducts = await _getPortalProducts(); } catch (_) { _mktProducts = []; }
  _selectedProductType = null;   // always land on the product grid
  try {
    renderMarketplace();
  } catch (err) {
    console.error('[marketplace] renderMarketplace failed:', err);
    const grid = document.getElementById('marketplaceGrid');
    if (grid) grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><i class="fa-solid fa-triangle-exclamation"></i><div class="empty-state__title">Could not load pools</div><div class="empty-state__sub">Pull down to refresh or check your connection.</div></div>`;
  }
  try {
    SVC.track('view_item_list', { item_list_id: 'marketplace', item_list_name: 'Investment Pools', items: PORTAL.pools.slice(0, 10).map(p => ({ item_id: p.id, item_name: p.name, item_category: p.product_type })) });
  } catch (_) {}
}

function filterMarket(type) {
  PORTAL.marketFilter = type;
  renderMarketplace();
  const tabBar = document.getElementById('marketRiskTabBar');
  if (tabBar) tabBar.style.display = '';
  // Highlight the active risk pill
  document.querySelectorAll('.mkt-risk-pill').forEach(p =>
    p.classList.toggle('active', p.getAttribute('data-risk') === type)
  );
  const sel = document.getElementById('marketRiskSelect');
  if (sel && sel.value !== type) sel.value = type;
  SVC.track('svc_filter_changed', { filter_type: 'marketplace_risk', filter_value: type });
}

const _POOL_META = {
  solar:         { blurb: 'Funds solar energy installations for homes & businesses across SA.', risk: 'Moderate',     riskColor: '#f59e0b' },
  solar_7yr:     { blurb: 'Funds solar energy installations for homes & businesses across SA.', risk: 'Moderate',     riskColor: '#f59e0b' },
  solar_6yr:     { blurb: 'Funds solar energy installations for homes & businesses across SA.', risk: 'Moderate',     riskColor: '#f59e0b' },
  solar_5yr:     { blurb: 'Funds solar energy installations for homes & businesses across SA.', risk: 'Moderate',     riskColor: '#f59e0b' },
  cattle:        { blurb: 'Partner with Beefcor — SA\'s premier feedlot — and earn returns as your herd grows from 200kg to 500kg.', risk: 'Aggressive',   riskColor: '#ef4444' },
  short_term:    { blurb: 'Fund South African SMMEs through asset finance. Capital deployed into vetted businesses generating strong short-cycle returns.', risk: 'Moderate',  riskColor: '#f59e0b' },
  delivery_bike: { blurb: 'Fleet funding for delivery riders. Steady, predictable returns.',    risk: 'Conservative', riskColor: '#22c55e' },
};

// Risk profile is defined per-product in the admin console (products.risk_profile).
// This resolves the current risk label + colour for a product type from the
// live product records rather than any hardcoded value.
const _RISK_COLORS = { 'Low': '#22c55e', 'Medium': '#f59e0b', 'Medium-High': '#ff9b0c', 'High': '#ef4444' };
function _productRisk(productType) {
  const p = (_mktProducts || []).find(pr => pr.product_type === productType);
  const risk = (p && p.risk_profile) ? p.risk_profile : 'Medium';
  const color = (p && p.risk_color) ? p.risk_color : (_RISK_COLORS[risk] || '#f59e0b');
  return { risk, color };
}

// ── Product-first marketplace ────────────────────────────────────────────
// "Browse Pools" is now "Products": investors pick a product, see its details
// + factsheets + a chart, then the open pools under it, and invest from there.

function renderMarketplace() {
  // Toggle the legacy category tab-bar — not used in the product-first flow
  const tabBar = document.querySelector('#view-marketplace .tab-bar');
  if (tabBar) tabBar.style.display = 'none';
  const banner = document.querySelector('#view-marketplace .section-banner__title');
  if (_selectedProductType) { if (banner) banner.textContent = 'Product Details'; renderProductDetailView(_selectedProductType); }
  else { if (banner) banner.textContent = 'Investment Products'; renderProductsGrid(); }
}

// Count of open/waitlist pools for a product type
function _openPoolsForProduct(type) {
  return PORTAL.pools.filter(p => p.product_type === type && (p.status === 'open' || p.status === 'waitlist'));
}

function renderProductsGrid() {
  const grid = document.getElementById('marketplaceGrid');
  if (!grid) return;
  const strip = document.getElementById('mktWalletStrip');
  const walletBal = parseFloat(PORTAL.investor?.wallet_balance) || 0;
  if (strip) {
    strip.style.display = 'flex';
    const balEl = document.getElementById('mktWalletBal');
    if (balEl) { balEl.textContent = Utils.rand(walletBal); balEl.style.color = walletBal >= 500 ? 'var(--green)' : 'var(--gold)'; }
  }

  // First-time explainer strip — for users who have never invested
  const _mktHasInvested = (PORTAL.investments || []).length > 0;
  let _mktLearnStrip = document.getElementById('mktFirstTimeStrip');
  if (!_mktHasInvested) {
    if (!_mktLearnStrip) {
      _mktLearnStrip = document.createElement('div');
      _mktLearnStrip.id = 'mktFirstTimeStrip';
      _mktLearnStrip.style.cssText = 'margin-bottom:16px;padding:14px 16px;border-radius:12px;background:rgba(0,150,255,0.05);border:1px solid rgba(0,150,255,0.15);display:flex;gap:12px;align-items:flex-start';
      _mktLearnStrip.innerHTML = `
        <i class="fa-solid fa-circle-info" style="color:#0096ff;font-size:1rem;flex-shrink:0;margin-top:1px"></i>
        <div style="font-size:0.82rem;color:var(--text-muted);line-height:1.6">
          <strong style="color:var(--text)">New here?</strong>
          Each product has a minimum investment amount and a term — the period your money stays invested.
          At the end of the term, your capital is returned to your wallet along with a return based on the product's performance.
          Returns are not guaranteed and may vary.
          <a style="color:#0096ff;cursor:pointer;font-weight:600;text-decoration:none" onclick="navigate('learn', document.querySelector('[data-view=learn]'))"> Learning Hub →</a>
        </div>`;
      grid.before(_mktLearnStrip);
    }
  } else if (_mktLearnStrip) {
    _mktLearnStrip.remove();
  }

  // All active products (details + factsheets browsable even with no open pool),
  // sorted by sort order. Products with open pools rank first.
  // Risk filter reads the product's own risk_profile (set in the admin console).
  const mf = PORTAL.marketFilter || 'all';
  const products = (_mktProducts || []).filter(p => {
    if (!p.is_active) return false;
    if (mf === 'all') return true;
    return (p.risk_profile || 'Medium') === mf;
  }).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const shown = products
    .map(p => ({ p, open: _openPoolsForProduct(p.product_type) }))
    .sort((a, b) => (b.open.length > 0) - (a.open.length > 0));

  if (!shown.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <i class="fa-solid fa-box-open"></i>
      <div class="empty-state__title">No products available yet</div>
      <div class="empty-state__sub">New investment products are added regularly — check back soon or ask a question.</div>
      <div style="margin-top:12px"><button class="btn btn--primary btn--sm" onclick="navigate('support', document.querySelector('[data-view=support]'))"><i class="fa-solid fa-headset"></i> Ask a question</button></div>
    </div>`;
    return;
  }

  grid.innerHTML = shown.map(({ p, open }) => {
    const pi = Utils.productInfo(p.product_type);
    const color = Utils.productColor(p);
    const icon = p.icon || pi.icon;
    const avg = p.avg_actual_rate != null ? parseFloat(p.avg_actual_rate) : null;
    const rateLabel = avg != null ? `${(avg * 100).toFixed(2)}%` : (p.benchmark_rate ? `${(parseFloat(p.benchmark_rate) * 100).toFixed(1)}%` : '—');
    const rateSub = avg != null ? 'avg return (matured)' : 'target return';
    // soonest closing among the open pools
    const days = open.map(o => Utils.daysRemaining(o.end_date)).filter(d => d !== null);
    const soonest = days.length ? Math.min(...days) : null;
    return `
      <div class="market-pool-card mpc-v2" style="cursor:pointer" onclick="openProductDetail('${p.product_type}')">
        <div class="mpc2-accent" style="background:linear-gradient(90deg,${color},${color}88)"></div>
        <div class="mpc2-top">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
            <div class="mpc2-icon" style="background:${color}18;color:${color}"><i class="fa-solid ${icon}"></i></div>
            <span class="mpc2-badge" style="background:${color}14;color:${color};border-color:${color}30">${open.length ? `${open.length} open pool${open.length === 1 ? '' : 's'}` : 'Details & factsheets'}</span>
          </div>
          <div style="margin-top:14px">
            <div class="mpc2-title">${_esc(p.label)}</div>
            <div class="mpc2-blurb">${_esc(p.headline || p.description || '')}</div>
          </div>
        </div>
        <div class="mpc2-metrics">
          <div class="mpc2-metric">
            <div class="mpc2-metric__val" style="background:linear-gradient(135deg,${color},${color}bb);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">${rateLabel}</div>
            <div class="mpc2-metric__lbl">${rateSub}</div>
          </div>
          <div class="mpc2-metric-sep"></div>
          <div class="mpc2-metric">
            <div class="mpc2-metric__val" style="font-size:1.25rem">${Utils.rand(p.min_investment || 0)}</div>
            <div class="mpc2-metric__lbl">minimum</div>
          </div>
          <div class="mpc2-metric-sep"></div>
          <div class="mpc2-metric">
            <div class="mpc2-metric__val">${p.term_months || '—'}<span style="font-size:1rem;opacity:0.7">mo</span></div>
            <div class="mpc2-metric__lbl">term</div>
          </div>
        </div>
        <div class="mpc2-pills">
          ${soonest !== null ? `<div class="mpc2-pill${soonest <= 7 ? ' mpc2-pill--urgent' : ''}"><i class="fa-solid fa-clock"></i><span>Next pool closes in <strong>${soonest}d</strong></span></div>` : ''}
          ${p.factsheet_url ? `<div class="mpc2-pill"><i class="fa-solid fa-file-pdf"></i><span>Factsheet</span></div>` : ''}
        </div>
        <div class="mpc2-footer">
          <button class="btn btn--primary btn--full" onclick="event.stopPropagation();openProductDetail('${p.product_type}')">
            <i class="fa-solid fa-arrow-right"></i> View product & pools
          </button>
        </div>
      </div>`;
  }).join('');
}

function openProductDetail(type) {
  _selectedProductType = type;
  renderMarketplace();
  const v = document.getElementById('view-marketplace');
  if (v) v.scrollIntoView({ behavior: 'smooth', block: 'start' });
  SVC.track('select_item', { item_list_id: 'products', items: [{ item_id: type }] });
}

function backToProducts() {
  _selectedProductType = null;
  renderMarketplace();
}

async function renderProductDetailView(type) {
  const grid = document.getElementById('marketplaceGrid');
  if (!grid) return;
  const product = (_mktProducts || []).find(p => p.product_type === type) || { product_type: type, label: Utils.productInfo(type).label };
  const pi = Utils.productInfo(type);
  const color = Utils.productColor(product);
  const icon = product.icon || pi.icon;
  const open = _openPoolsForProduct(type);
  const avg = product.avg_actual_rate != null ? parseFloat(product.avg_actual_rate) : null;
  const projRate = avg != null ? avg : (product.benchmark_rate ? parseFloat(product.benchmark_rate) : (open[0] ? parseFloat(open[0].annual_rate) : 0.13));
  const keyDetails = (product.key_details || '').split('\n').map(s => s.trim()).filter(Boolean);

  // Live data panels: cattle herd status / solar telematics
  const isSolar = (type || '').startsWith('solar');
  const herdSlot = type === 'cattle'
    ? '<div id="prodHerdStatus" style="margin-bottom:16px"></div>'
    : (isSolar ? '<div id="prodSolarStatus" style="margin-bottom:16px"></div>' : '');

  grid.innerHTML = `
    <div style="grid-column:1/-1">
      <button class="btn btn--ghost btn--sm" onclick="backToProducts()" style="margin-bottom:14px"><i class="fa-solid fa-arrow-left"></i> All products</button>

      <div class="market-pool-card mpc-v2" style="cursor:default">
        <div class="mpc2-accent" style="background:linear-gradient(90deg,${color},${color}88)"></div>
        <div style="padding:16px 16px 8px">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
            <div class="mpc2-icon" style="background:${color}18;color:${color}"><i class="fa-solid ${icon}"></i></div>
            <div>
              <div style="font-size:0.72rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${color}">${_esc(product.label || '')}</div>
              <div class="mpc2-title" style="font-size:1.3rem">${_esc(product.headline || product.label || '')}</div>
            </div>
          </div>
          ${product.description ? `<p style="font-size:0.9rem;color:var(--text-muted);line-height:1.6;margin-bottom:14px">${_esc(product.description)}</p>` : ''}

          <div class="mpc2-metrics" style="margin-bottom:16px">
            <div class="mpc2-metric">
              <div class="mpc2-metric__val" style="background:linear-gradient(135deg,${color},${color}bb);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">${avg != null ? (avg * 100).toFixed(2) + '%' : (product.benchmark_rate ? (parseFloat(product.benchmark_rate) * 100).toFixed(1) + '%' : '—')}</div>
              <div class="mpc2-metric__lbl">${avg != null ? 'avg return per year' : 'target return'}</div>
            </div>
            <div class="mpc2-metric-sep"></div>
            <div class="mpc2-metric"><div class="mpc2-metric__val" style="font-size:1.25rem">${Utils.rand(product.min_investment || 0)}</div><div class="mpc2-metric__lbl">minimum</div></div>
            <div class="mpc2-metric-sep"></div>
            <div class="mpc2-metric"><div class="mpc2-metric__val">${product.term_months || '—'}<span style="font-size:1rem;opacity:0.7">mo</span></div><div class="mpc2-metric__lbl">term</div></div>
            ${product.performance_fee_pct ? `<div class="mpc2-metric-sep"></div><div class="mpc2-metric"><div class="mpc2-metric__val" style="font-size:1.2rem">${(parseFloat(product.performance_fee_pct) * 100).toFixed(0)}%</div><div class="mpc2-metric__lbl">perf. fee</div></div>` : ''}
          </div>

          ${herdSlot}

          ${keyDetails.length ? `<div style="margin-bottom:16px">
            <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:8px">Key Details</div>
            <div style="display:flex;flex-direction:column;gap:7px">
              ${keyDetails.map(d => `<div style="display:flex;gap:9px;font-size:0.86rem;color:var(--text)"><i class="fa-solid fa-arrow-right" style="color:${color};margin-top:3px;font-size:0.75rem"></i><span>${_esc(d)}</span></div>`).join('')}
            </div>
          </div>` : ''}

          ${isSolar ? '<div id="prodSolarHistory" style="margin-top:16px"></div>' : ''}
          <div id="prodTrackRecord" style="margin-top:16px"></div>
          <div id="prodFactsheets" style="margin-top:14px"></div>
        </div>
      </div>

      <div style="font-size:0.95rem;font-weight:800;color:var(--text);margin:22px 0 12px"><i class="fa-solid fa-layer-group" style="color:${color};margin-right:6px"></i>Open pools — ${open.length}</div>
      <div class="grid-3" id="productPoolsGrid"></div>
    </div>`;

  // Pools
  const poolsGrid = document.getElementById('productPoolsGrid');
  const walletBal = parseFloat(PORTAL.investor?.wallet_balance) || 0;
  const waitlist = PORTAL.waitlist || [];
  const investorId = PORTAL.investor?.id;
  const ranked = _rankMarketPools(open, walletBal);
  if (poolsGrid) {
    poolsGrid.innerHTML = ranked.length
      ? ranked.map((pool, idx) => _marketPoolCardHtml(pool, idx, walletBal, waitlist, investorId)).join('')
      : `<div class="empty-state" style="grid-column:1/-1"><i class="fa-solid fa-clock"></i><div class="empty-state__title">No open pools right now</div><div class="empty-state__sub">Pools for this product open regularly.</div></div>`;
  }

  // Live data panels
  if (type === 'cattle') _renderCattleHerdStatus('prodHerdStatus');
  if (isSolar) { _renderSolarStatus('prodSolarStatus'); _renderSolarHistory('prodSolarHistory', color); }

  // Verifiable track record (matured pools: actual vs benchmark)
  _renderProductTrackRecord(type, color);

  // Factsheets (product-level + all pool factsheets for this product)
  _renderProductFactsheets(type, product);
}

// Compound-growth projection of R10,000 over 5 years (60 months)
let _prodGrowthChart = null;
function _renderProductGrowthChart(rate, termMonths, color) {
  const canvas = document.getElementById('prodGrowthChart');
  if (!canvas || typeof Chart === 'undefined') return;
  try { if (_prodGrowthChart) { _prodGrowthChart.destroy(); _prodGrowthChart = null; } } catch (_) {}

  // Always show 5-year (60 month) window, tick every 12 months
  const totalMonths = 60;
  const labels = [], data = [];
  for (let m = 0; m <= totalMonths; m++) {
    labels.push(m === 0 ? 'Start' : (m % 12 === 0 ? `Y${m / 12}` : ''));
    data.push(Math.round(10000 * Math.pow(1 + rate, m / 12)));
  }

  // Parse hex color for gradient
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 220);
  grad.addColorStop(0, color + '55');
  grad.addColorStop(1, color + '08');

  const finalVal = data[data.length - 1];
  const startVal = data[0];

  _prodGrowthChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: color,
        backgroundColor: grad,
        fill: true,
        tension: 0.4,
        pointRadius: labels.map((l, i) => (i === 0 || i === totalMonths || (i % 12 === 0)) ? 4 : 0),
        pointBackgroundColor: color,
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        borderWidth: 2.5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => `Month ${items[0].dataIndex}`,
            label: c => `  Value: ${Utils.rand(c.parsed.y)}`,
          },
          backgroundColor: '#1a1a1a',
          titleColor: '#9ca3af',
          bodyColor: '#ffffff',
          padding: 10,
          cornerRadius: 8,
        },
        annotation: {
          annotations: {
            endLabel: {
              type: 'label',
              xValue: totalMonths,
              yValue: finalVal,
              content: [Utils.rand(finalVal)],
              color: color,
              font: { size: 10, weight: '700' },
              position: { x: 'end', y: 'center' },
              xAdjust: -4,
              yAdjust: -14,
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: true, color: 'rgba(0,0,0,0.1)' },
          ticks: {
            color: 'rgba(0,0,0,0.45)',
            font: { size: 9, weight: '600' },
            maxRotation: 0,
            callback: (val, i) => labels[i] || null,
          },
        },
        y: {
          position: 'left',
          border: { display: false },
          grid: { color: 'rgba(0,0,0,0.06)', drawTicks: false },
          ticks: {
            callback: v => 'R' + (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v),
            color: 'rgba(0,0,0,0.45)',
            font: { size: 9, weight: '600' },
            maxTicksLimit: 6,
            padding: 4,
          },
        },
      },
      layout: { padding: { top: 18, right: 12, bottom: 4, left: 4 } },
    },
  });
}

// ── Track record: matured pools' achieved return vs benchmark ──
let _trackRecordCache = null;
async function _getTrackRecord() {
  if (_trackRecordCache) return _trackRecordCache;
  try { const r = await API._fetch('GET', 'products/track-record'); _trackRecordCache = r.data || {}; }
  catch (_) { _trackRecordCache = {}; }
  return _trackRecordCache;
}

let _trackChart = null;
async function _renderProductTrackRecord(type, color) {
  const el = document.getElementById('prodTrackRecord');
  if (!el) return;
  const data = await _getTrackRecord();
  const isSolar = (type || '').startsWith('solar');
  const keys = Object.keys(data).filter(k => isSolar ? k.startsWith('solar') : k === type);
  let pools = [], paidBack = 0, sumA = 0, n = 0;
  keys.forEach(k => {
    const d = data[k];
    pools = pools.concat(d.pools || []);
    paidBack += d.total_paid_back || 0;
    sumA += (d.avg_actual_rate || 0) * (d.matured_count || 0);
    n += d.matured_count || 0;
  });
  if (!n) { el.innerHTML = ''; return; }
  pools.sort((a, b) => new Date(a.ended) - new Date(b.ended));

  // Show the average delivered return (no chart).
  el.innerHTML = `
    <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:10px"><i class="fa-solid fa-award" style="color:${color}"></i> Track record — delivered returns</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:110px;background:rgba(0,0,0,0.03);border:1px solid rgba(0,0,0,0.06);border-radius:14px;padding:14px">
        <div style="font-size:1.5rem;font-weight:900;color:${color};letter-spacing:-0.02em">${(sumA / n * 100).toFixed(2)}%</div>
        <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px">avg return achieved p.a.</div>
      </div>
      <div style="flex:1;min-width:110px;background:rgba(0,0,0,0.03);border:1px solid rgba(0,0,0,0.06);border-radius:14px;padding:14px">
        <div style="font-size:1.5rem;font-weight:900;color:var(--text);letter-spacing:-0.02em">${n}</div>
        <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px">pool${n === 1 ? '' : 's'} matured</div>
      </div>
      <div style="flex:1;min-width:110px;background:rgba(0,0,0,0.03);border:1px solid rgba(0,0,0,0.06);border-radius:14px;padding:14px">
        <div style="font-size:1.5rem;font-weight:900;color:var(--text);letter-spacing:-0.02em">${Utils.rand(paidBack)}</div>
        <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px">paid back to investors</div>
      </div>
    </div>`;
}

// ── Solar: daily generation this month (FoxESS history) ──
let _solarHistChart = null;
async function _renderSolarHistory(containerId, color) {
  const el = document.getElementById(containerId);
  if (!el) return;
  let h;
  try { h = await API._fetch('GET', 'products/solar-history'); } catch (_) { h = null; }
  if (!h || h.unavailable || !h.series || !h.series.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:8px"><i class="fa-solid fa-chart-column" style="color:${color}"></i> Daily generation this month</div>
    <div style="position:relative;height:150px"><canvas id="prodSolarHistChart"></canvas></div>`;
  const canvas = document.getElementById('prodSolarHistChart');
  if (!canvas || typeof Chart === 'undefined') return;
  try { if (_solarHistChart) { _solarHistChart.destroy(); _solarHistChart = null; } } catch (_) {}
  _solarHistChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: h.series.map(d => d.day), datasets: [{ data: h.series.map(d => d.kwh), backgroundColor: color + 'cc' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.parsed.y + ' kWh' } } },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10, font: { size: 9 }, color: 'rgba(0,0,0,0.4)' } },
                y: { ticks: { callback: v => v + ' kWh', font: { size: 9 }, color: 'rgba(0,0,0,0.4)' }, grid: { color: 'rgba(0,0,0,0.05)' } } },
    },
  });
}

async function _renderProductFactsheets(type, product) {
  const el = document.getElementById('prodFactsheets');
  if (!el) return;
  el.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> Loading factsheets…</div>`;
  const poolIds = new Set(PORTAL.pools.filter(p => p.product_type === type).map(p => p.id));
  let sheets = [];
  try {
    const res = await API._fetch('GET', 'factsheets');
    sheets = (res.data || []).filter(s => poolIds.has(s.pool_id));
  } catch (_) {}
  const productSheet = product && product.factsheet_url ? {
    file_url: product.factsheet_url, file_name: product.factsheet_name || `${product.label} factsheet`,
    created_at: product.updated_at, _product: true,
  } : null;
  const all = [productSheet, ...sheets].filter(Boolean);
  el.innerHTML = `
    <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:8px"><i class="fa-solid fa-file-pdf" style="color:#ef4444"></i> Factsheets & documents</div>
    ${all.length ? `<div style="display:flex;flex-direction:column;gap:8px">
      ${all.map(s => `<a href="${_safeUrl(s.file_url)}" target="_blank" rel="noopener" class="fs-row ${s._product ? 'fs-row--current' : ''}">
        <div class="fs-row__icon"><i class="fa-solid fa-file-pdf"></i></div>
        <div class="fs-row__info"><div class="fs-row__name">${_esc(s.file_name)}${s._product ? ' <span class="fs-current-tag">Product</span>' : ''}</div>
          <div class="fs-row__meta">${Utils.date(s.created_at)}</div></div>
        <i class="fa-solid fa-arrow-up-right-from-square fs-row__arrow"></i>
      </a>`).join('')}
    </div>` : `<div style="font-size:0.82rem;color:var(--text-muted)">No factsheets uploaded yet for this product.</div>`}`;
}

// Single open-pool card (used inside the product detail view)
function _marketPoolCardHtml(pool, idx, walletBal, waitlist, investorId) {
    const pi   = Utils.productInfo(pool.product_type);
    const pct  = Utils.poolFillPct(pool);
    const days = Utils.daysRemaining(pool.end_date);
    const meta = _POOL_META[pool.product_type] || { blurb: '', risk: 'Medium', riskColor: '#f59e0b' };
    const pr   = _productRisk(pool.product_type);   // risk profile from the product (admin console)
    const canInvest = walletBal >= _minPlusFee(pool);
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
    } else if (canInvest) {
      ctaHtml = `<button class="btn btn--primary btn--full" onclick='openInvestModal(${JSON.stringify(pool.id)})'>
                   <i class="fa-solid fa-coins"></i> Invest Now
                 </button>`;
    } else {
      ctaHtml = `<div class="pool-card__need-topup">
                   <i class="fa-solid fa-wallet"></i>
                   <span>Need ${Utils.rand(Math.max(0, _minPlusFee(pool) - walletBal))} more in wallet (incl. 1% fee)</span>
                   <button class="btn btn--ghost btn--sm" onclick="navigate('wallet',document.querySelector('[data-view=wallet]'))">Top Up</button>
                 </div>`;
    }

    const highlighted = idx === 0 && pool.status === 'open';

    // Factsheet link — loaded async into dataset on the card
    const fsAttr = `data-pool-id="${pool.id}"`;

    return `
      <div class="market-pool-card mpc-v2 ${highlighted ? 'mpc-v2--featured' : ''}" ${fsAttr}>
        <!-- Card header accent strip -->
        <div class="mpc2-accent" style="background:linear-gradient(90deg,${pi.color},${pi.color}88)"></div>

        <div class="mpc2-top">
          <!-- Icon + badges row -->
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
            <div class="mpc2-icon" style="background:${pi.color}18;color:${pi.color}">
              <i class="fa-solid ${pi.icon}"></i>
            </div>
            <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
              ${highlighted ? `<span class="mpc2-badge mpc2-badge--featured"><i class="fa-solid fa-star" style="font-size:0.6rem"></i> Best Next Step</span>` : ''}
              <span class="mpc2-badge" style="background:${pr.color}14;color:${pr.color};border-color:${pr.color}30">${pr.risk} risk</span>
              ${isWaitlisted
                ? '<span class="mpc2-badge mpc2-badge--full"><i class="fa-solid fa-lock"></i> Pool Full</span>'
                : (urgency ? '<span class="mpc2-badge mpc2-badge--urgent"><i class="fa-solid fa-fire"></i> Closing Soon</span>' : '')
              }
            </div>
          </div>

          <!-- Title + blurb -->
          <div style="margin-top:14px">
            <div class="mpc2-title">${_esc(pool.name)}</div>
            <div class="mpc2-blurb">${_esc(meta.blurb)}</div>
          </div>
        </div>

        <!-- Key metrics -->
        <div class="mpc2-metrics">
          <div class="mpc2-metric">
            <div class="mpc2-metric__val" style="background:linear-gradient(135deg,${pi.color},${pi.color}bb);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">${Utils.pct(pool.annual_rate)}</div>
            <div class="mpc2-metric__lbl">per annum</div>
          </div>
          <div class="mpc2-metric-sep"></div>
          <div class="mpc2-metric">
            <div class="mpc2-metric__val">${pool.term_months}<span style="font-size:1rem;opacity:0.7">mo</span></div>
            <div class="mpc2-metric__lbl">fixed term</div>
          </div>
          <div class="mpc2-metric-sep"></div>
          <div class="mpc2-metric">
            <div class="mpc2-metric__val" style="font-size:1.25rem">${Utils.rand(pool.min_investment)}</div>
            <div class="mpc2-metric__lbl">minimum</div>
          </div>
        </div>

        <!-- Info pills -->
        <div class="mpc2-pills">
          <div class="mpc2-pill">
            <i class="fa-solid fa-users"></i>
            <span><strong>${pool.investor_count || 0}</strong> investor${pool.investor_count !== 1 ? 's' : ''}</span>
          </div>
          ${days !== null ? `<div class="mpc2-pill${urgency ? ' mpc2-pill--urgent' : ''}">
            <i class="fa-solid fa-clock"></i>
            <span>Closes in <strong>${days}d</strong></span>
          </div>` : ''}
          ${pool.partner_name ? `<div class="mpc2-pill">
            <i class="fa-solid fa-handshake"></i>
            <span><strong>${_esc(pool.partner_name)}</strong></span>
          </div>` : ''}
        </div>

        <!-- Funding / closure progress -->
        <div class="mpc2-progress">
          ${Utils.poolIsDateTarget(pool) ? (() => {
            // Date-targeted pools have no funding goal — show days to closure, no bar.
            const left = days === null ? '—' : (days === 0 ? 'Closed' : `${days} day${days === 1 ? '' : 's'} to closure`);
            return `
              <div class="mpc2-progress__labels">
                <span><i class="fa-solid fa-clock" style="margin-right:4px"></i>${left}</span>
              </div>`;
          })() : `
            <div class="mpc2-progress__labels">
              <span>${Utils.rand(pool.raised_amount)} raised</span>
              <span style="font-weight:700;color:${pct >= 90 ? '#ef4444' : pct >= 60 ? '#f59e0b' : pi.color}">${pct}% funded</span>
            </div>
            <div class="mpc2-progress__track">
              <div class="mpc2-progress__fill" style="width:${pct}%;background:linear-gradient(90deg,${pi.color},${pi.color}aa)"></div>
            </div>`}
          ${capacityBarHtml}
        </div>

        <!-- CTA + factsheet -->
        <div class="mpc2-footer">
          <div style="flex:1">${ctaHtml}</div>
          <button class="mpc2-fs-btn" onclick="viewFactsheet('${pool.id}','${pool.name}')" title="View factsheet">
            <i class="fa-solid fa-file-pdf"></i>
          </button>
        </div>
      </div>
    `;
}

/* ─── Factsheet viewer ───────────────────────────────────────────── */
// Cache of the public products feed (factsheets, herd stats source, etc.)
let _portalProductsCache = null;
async function _getPortalProducts() {
  if (_portalProductsCache) return _portalProductsCache;
  try {
    const r = await API._fetch('GET', 'products');
    _portalProductsCache = r.data || [];
    Utils.setProductCache(_portalProductsCache);
  } catch (_) { _portalProductsCache = []; }
  return _portalProductsCache;
}

// Live cattle herd status (from the fund-management herd data), shown on the
// Cattle Investment product so investors can see the real herd behind it.
let _cattleStatsCache = null;
async function _getCattleStats() {
  if (_cattleStatsCache) return _cattleStatsCache;
  try { _cattleStatsCache = await API._fetch('GET', 'products/cattle-stats'); }
  catch (_) { _cattleStatsCache = null; }
  return _cattleStatsCache;
}

function _cattleHerdStatusCompactHtml(s) {
  if (!s || !s.total_purchased) return '';
  const mortRate = s.total_purchased ? (s.mortality_count || 0) / s.total_purchased * 100 : 0;
  const survival = (100 - mortRate).toFixed(1);
  const weight = s.avg_current_weight || s.avg_entry_weight;
  return `<div style="background:rgba(212,175,55,0.07);border:1px solid rgba(212,175,55,0.25);border-radius:10px;padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px;font-size:0.82rem;flex-wrap:wrap">
    <i class="fa-solid fa-cow" style="color:#b8902a;flex-shrink:0"></i>
    <span style="color:#303030"><strong>${(s.live_count || 0).toLocaleString('en-ZA')}</strong> cattle live</span>
    ${weight ? `<span style="color:#656565">·</span><span style="color:#303030">avg <strong>${weight}kg</strong></span>` : ''}
    <span style="color:#656565">·</span>
    <span style="color:#65ed00;font-weight:700"><i class="fa-solid fa-heart-pulse" style="font-size:0.72rem"></i> ${survival}% survival</span>
  </div>`;
}

function _cattleHerdStatusHtml(s) {
  if (!s || !s.total_purchased) return '';
  const weight   = s.avg_current_weight || s.avg_entry_weight;
  const genders  = (s.by_gender || []).filter(g => g.count > 0);
  const breeds   = (s.by_breed  || []).filter(b => b.count > 0);
  const totalG   = genders.reduce((a, g) => a + g.count, 0) || 1;
  const chip = txt => `<span style="font-size:0.76rem;background:rgba(212,175,55,0.14);color:#8a6d1f;border-radius:20px;padding:3px 11px">${txt}</span>`;

  // Weight journey: entry → current → target market weight
  const entry = s.avg_entry_weight, current = s.avg_current_weight, target = s.target_weight || 475;
  let weightBar = '';
  if (entry && current && target && target > entry) {
    const pct = Math.min(100, Math.max(0, Math.round((current - entry) / (target - entry) * 100)));
    weightBar = `
      <div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;font-size:0.7rem;color:var(--text-muted);margin-bottom:5px">
          <span>Entry ${entry}kg</span><span style="color:#8a6d1f;font-weight:700">Now ~${current}kg</span><span>Target ${target}kg</span>
        </div>
        <div style="height:8px;border-radius:5px;background:rgba(0,0,0,0.08);overflow:hidden"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#D4AF37,#b8902a)"></div></div>
        <div style="font-size:0.68rem;color:var(--text-muted);margin-top:4px">${pct}% of the way to market weight</div>
      </div>`;
  }

  // Survival / mortality
  const mortRate = s.total_purchased ? (s.mortality_count || 0) / s.total_purchased * 100 : 0;
  const mortBlock = `<div style="font-size:0.76rem;color:var(--text-muted);margin-top:8px"><i class="fa-solid fa-heart-pulse" style="color:#22c55e"></i> Survival rate <strong style="color:var(--text)">${(100 - mortRate).toFixed(1)}%</strong>${s.mortality_count ? ` · ${s.mortality_count} mortalit${s.mortality_count === 1 ? 'y' : 'ies'} of ${s.total_purchased.toLocaleString('en-ZA')}` : ''}</div>`;

  return `
    <div style="background:rgba(212,175,55,0.07);border:1px solid rgba(212,175,55,0.25);border-radius:12px;padding:14px 16px;margin-bottom:14px">
      <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#b8902a;margin-bottom:10px"><i class="fa-solid fa-cow"></i> Live Herd Status</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">
        <div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${s.total_purchased.toLocaleString('en-ZA')}</div><div style="font-size:0.7rem;color:var(--text-muted)">purchased to date</div></div>
        <div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${(s.live_count || 0).toLocaleString('en-ZA')}</div><div style="font-size:0.7rem;color:var(--text-muted)">currently live</div></div>
        ${weight ? `<div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${weight}<span style="font-size:0.78rem"> kg</span></div><div style="font-size:0.7rem;color:var(--text-muted)">average weight</div></div>` : ''}
      </div>
      ${weightBar}
      ${genders.length ? `<div style="margin-bottom:${breeds.length ? '10px' : '0'}"><div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:5px">Gender</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${genders.map(g => chip(`${_esc(g.label)}: <strong>${g.count}</strong> (${Math.round(g.count / totalG * 100)}%)`)).join('')}</div></div>` : ''}
      ${breeds.length ? `<div><div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:5px">Breeds</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${breeds.slice(0, 8).map(b => chip(`${_esc(b.label)}: <strong>${b.count}</strong>`)).join('')}</div></div>` : ''}
      ${mortBlock}
    </div>`;
}

async function _renderCattleHerdStatus(containerId, compact = false) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);padding:6px 0"><i class="fa-solid fa-spinner fa-spin"></i> Loading herd status…</div>`;
  const s = await _getCattleStats();
  el.innerHTML = compact ? _cattleHerdStatusCompactHtml(s) : _cattleHerdStatusHtml(s);
}

// Live solar telematics (FoxESS/FoxCloud) — shared across all solar terms
let _solarStatsCache = null;
async function _getSolarStats() {
  if (_solarStatsCache) return _solarStatsCache;
  try { _solarStatsCache = await API._fetch('GET', 'products/solar-stats'); }
  catch (_) { _solarStatsCache = null; }
  return _solarStatsCache;
}

function _solarStatusHtml(s) {
  if (!s || s.unavailable || (!s.total_kwh && !s.today_kwh && !s.current_power_kw)) return '';
  const kwh = v => Number(v || 0).toLocaleString('en-ZA');
  const total = s.total_kwh >= 1000 ? `${(s.total_kwh / 1000).toFixed(1)} MWh` : `${kwh(s.total_kwh)} kWh`;
  const live = (s.current_power_kw || 0) > 0;
  return `
    <div style="background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.28);border-radius:12px;padding:14px 16px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:8px;font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#1f9d57;margin-bottom:10px">
        <i class="fa-solid fa-solar-panel"></i> Live Solar Generation
        ${live ? '<span style="display:inline-flex;align-items:center;gap:5px;margin-left:auto;font-size:0.68rem;color:#22c55e;text-transform:none;letter-spacing:0"><span style="width:7px;height:7px;border-radius:50%;background:#22c55e;display:inline-block;animation:pulse 1.5s infinite"></span> generating now</span>' : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
        <div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${(s.current_power_kw || 0).toLocaleString('en-ZA')}<span style="font-size:0.78rem"> kW</span></div><div style="font-size:0.7rem;color:var(--text-muted)">generating now</div></div>
        <div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${kwh(s.today_kwh)}<span style="font-size:0.78rem"> kWh</span></div><div style="font-size:0.7rem;color:var(--text-muted)">today</div></div>
        <div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${kwh(s.month_kwh)}<span style="font-size:0.78rem"> kWh</span></div><div style="font-size:0.7rem;color:var(--text-muted)">this month</div></div>
        <div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${total}</div><div style="font-size:0.7rem;color:var(--text-muted)">total generated</div></div>
        ${s.co2_avoided_kg ? `<div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${(s.co2_avoided_kg / 1000).toFixed(1)}<span style="font-size:0.78rem"> t</span></div><div style="font-size:0.7rem;color:var(--text-muted)">CO₂ avoided</div></div>` : ''}
        ${s.device_count ? `<div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${s.device_count}</div><div style="font-size:0.7rem;color:var(--text-muted)">inverter${s.device_count === 1 ? '' : 's'}</div></div>` : ''}
      </div>
      <div style="font-size:0.68rem;color:var(--text-muted);margin-top:9px">Live data from FoxCloud${s.station_name ? ` · ${_esc(s.station_name)}` : ''}</div>
    </div>`;
}

async function _renderSolarStatus(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);padding:6px 0"><i class="fa-solid fa-spinner fa-spin"></i> Loading live solar data…</div>`;
  const s = await _getSolarStats();
  el.innerHTML = _solarStatusHtml(s);
}

async function viewFactsheet(poolId, poolName) {
  const modal = document.getElementById('factsheetModal');
  const title = document.getElementById('fsModalTitle');
  const body  = document.getElementById('fsModalBody');
  if (!modal || !body) return;

  if (title) title.textContent = `${poolName} — Factsheets`;
  body.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>`;
  Modal.open('factsheetModal');

  try {
    const [res, products] = await Promise.all([
      API._fetch('GET', `factsheets?pool_id=${poolId}`),
      _getPortalProducts(),
    ]);
    const sheets = res.data || [];

    // Also surface the product-level factsheet (managed in the admin Products area)
    const pool = (PORTAL.pools || []).find(p => p.id === poolId);
    const product = pool ? products.find(p => p.product_type === pool.product_type) : null;
    const productSheet = product && product.factsheet_url ? {
      file_url:    product.factsheet_url,
      file_name:   product.factsheet_name || `${product.label} factsheet`,
      created_at:  product.updated_at,
      is_current:  true,
      _product:    true,
    } : null;

    const all = [productSheet, ...sheets].filter(Boolean);
    if (!all.length) {
      body.innerHTML = `<div class="empty-state" style="padding:32px">
        <i class="fa-solid fa-file-pdf" style="font-size:2rem;color:var(--border-dark)"></i>
        <div class="empty-state__title" style="margin-top:12px">No factsheet uploaded yet</div>
        <div class="empty-state__sub">Contact your investment manager for product documentation.</div>
      </div>`;
      return;
    }
    body.innerHTML = `
      <p style="font-size:0.78rem;color:var(--text-muted);margin-bottom:16px">${all.length} document${all.length > 1 ? 's' : ''} available</p>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${all.map(s => `
          <a href="${_safeUrl(s.file_url)}" target="_blank" rel="noopener" class="fs-row ${s.is_current ? 'fs-row--current' : ''}">
            <div class="fs-row__icon"><i class="fa-solid fa-file-pdf"></i></div>
            <div class="fs-row__info">
              <div class="fs-row__name">${_esc(s.file_name)}${s._product ? ' <span class="fs-current-tag">Product</span>' : (s.is_current ? ' <span class="fs-current-tag">Current</span>' : '')}</div>
              <div class="fs-row__meta">${s.version ? `v${_esc(s.version)} · ` : ''}${Utils.date(s.created_at)}${s.uploaded_by ? ` · ${_esc(s.uploaded_by)}` : ''}</div>
            </div>
            <i class="fa-solid fa-arrow-up-right-from-square fs-row__arrow"></i>
          </a>`).join('')}
      </div>`;
  } catch (err) {
    body.innerHTML = `<div style="color:var(--red);text-align:center;padding:24px">Failed to load factsheets. Please try again.</div>`;
  }
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

/* Platform fee charged on every investment (1% of the amount, on top of it). */
const PLATFORM_FEE_RATE = 0.01;
function _platformFee(amount) {
  return Math.round((parseFloat(amount) || 0) * PLATFORM_FEE_RATE * 100) / 100;
}
/* Wallet needed to make the smallest allowed investment in a pool: the pool
   minimum plus the platform fee charged on that minimum. */
function _minPlusFee(pool) {
  const min = parseFloat(pool.min_investment) || 0;
  return min + _platformFee(min);
}

/* Quick-pick chip selection helper */
function openInvestModal(poolId) {
  const pool = PORTAL.pools.find(p => p.id === poolId);
  if (!pool) return;

  SVC.track('view_item', { items: [{ item_id: pool.id, item_name: pool.name, item_category: pool.product_type }] });
  SVC.track('select_item', { items: [{ item_id: pool.id, item_name: pool.name, item_category: pool.product_type }] });

  const _activeSa  = _pmSaId ? PORTAL.subAccounts.find(s => s.id === _pmSaId) : null;
  const walletBal  = _activeSa ? (parseFloat(_activeSa.wallet_balance) || 0) : (parseFloat(PORTAL.investor?.wallet_balance) || 0);
  const pi         = Utils.productInfo(pool.product_type);
  const meta       = _POOL_META[pool.product_type] || { risk: 'Medium', riskColor: '#f59e0b' };
  const pr         = _productRisk(pool.product_type);
  const maturityDt = new Date();
  maturityDt.setMonth(maturityDt.getMonth() + pool.term_months);
  const maturityStr = maturityDt.toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });

  document.getElementById('investModalTitle').textContent = `Invest in ${pool.name}`;

  document.getElementById('investModalBody').innerHTML = `
    ${_activeSa ? `<div style="background:rgba(255,155,12,0.1);border:1px solid rgba(255,155,12,0.3);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:0.82rem;color:#ff9b0c;display:flex;align-items:center;gap:8px"><i class="fa-solid fa-wallet"></i><span>Investing from <strong>${_esc(_activeSa.name)}</strong> sub-account &mdash; available: <strong>${Utils.rand(walletBal)}</strong></span></div>` : ''}
    <!-- Pool summary card -->
    <div class="invest-modal-pool-card">
      <div class="invest-modal-pool-icon" style="background:${pi.color}20;color:${pi.color}">
        <i class="fa-solid ${pi.icon}"></i>
      </div>
      <div class="invest-modal-pool-info">
        <div class="invest-modal-pool-name">${pool.name}</div>
        <div class="invest-modal-pool-meta">
          <span style="color:${pi.color};font-weight:700">${Utils.pct(pool.annual_rate)} per year</span>
          <span>·</span>
          <span>${pool.term_months}-month term</span>
          <span>·</span>
          <span class="pool-risk-badge" style="background:${pr.color}18;color:${pr.color}">${pr.risk} risk</span>
        </div>
      </div>
    </div>

    ${pool.product_type === 'cattle' ? '<div id="cattleHerdStatus"></div>' : ''}

    <!-- Wallet balance indicator -->
    ${walletBal < _minPlusFee(pool)
      ? `<div style="background:rgba(239,68,68,0.07);border:1.5px solid rgba(239,68,68,0.3);border-radius:12px;padding:14px 16px;margin-bottom:14px">
           <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
             <i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;font-size:1.1rem;flex-shrink:0"></i>
             <div>
               <div style="font-weight:700;color:#ef4444;font-size:0.9rem">Wallet top-up required</div>
               <div style="font-size:0.78rem;color:#656565;margin-top:2px">You have <strong style="color:#303030">${Utils.rand(walletBal)}</strong> — you need <strong style="color:#303030">${Utils.rand(_minPlusFee(pool))}</strong> to invest the minimum (${Utils.rand(pool.min_investment)} + ${Utils.rand(_platformFee(pool.min_investment))} fee).</div>
             </div>
           </div>
           <button class="btn btn--primary btn--sm" style="width:100%" onclick="Modal.close('investModal');navigate('wallet',document.querySelector('[data-view=wallet]'))">
             <i class="fa-solid fa-plus"></i> Top Up Wallet
           </button>
         </div>`
      : `<div class="invest-wallet-indicator invest-wallet-ok" style="margin-bottom:14px">
           <i class="fa-solid fa-wallet"></i>
           <span>Wallet: <strong>${Utils.rand(walletBal)}</strong></span>
           <span class="invest-wallet-ok-badge"><i class="fa-solid fa-circle-check"></i> Sufficient</span>
         </div>`}

    <!-- Quick-pick amount buttons -->
    <div class="form-group">
      <label class="form-label">How much would you like to invest?</label>
      <div class="invest-quickpick mb-8">
        ${[pool.min_investment, 5000, 10000, 25000].filter(v => (v + _platformFee(v)) <= walletBal || v === pool.min_investment).map(v =>
          `<button class="invest-qp-btn" onclick="document.getElementById('investAmount').value=${v};_updateInvestCalc(${v},${pool.annual_rate},${pool.term_months},${pool.min_investment},${walletBal})">${Utils.rand(v)}</button>`
        ).join('')}
      </div>
      <input type="number" class="form-input" id="investAmount"
        placeholder="Enter amount (min ${Utils.rand(pool.min_investment)})"
        min="${pool.min_investment}" max="${Math.floor(walletBal / (1 + PLATFORM_FEE_RATE))}"
        oninput="_updateInvestCalc(parseFloat(this.value)||0,${pool.annual_rate},${pool.term_months},${pool.min_investment},${walletBal})" />
    </div>
    <div id="investInsufficientBanner" style="display:none"></div>

    <!-- Wallet deduction breakdown -->
    <div id="investFeeBreakdown" style="margin-top:12px;border:1px solid rgba(0,0,0,0.08);border-radius:10px;padding:10px 14px;font-size:0.84rem">
      <div style="display:flex;justify-content:space-between;padding:3px 0;color:#656565">
        <span>Amount invested</span><span id="ic-fee-amount" style="font-weight:600;color:#303030">—</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:3px 0;color:#656565">
        <span>Platform fee (1%)</span><span id="ic-fee-fee" style="font-weight:600;color:#303030">—</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:7px 0 1px;margin-top:5px;border-top:1px dashed rgba(0,0,0,0.12);font-weight:700">
        <span>Total deducted from ${_activeSa ? 'sub-account' : 'wallet'}</span><span id="ic-fee-total" style="color:#303030">—</span>
      </div>
    </div>
  `;

  const invBtn = document.getElementById('investConfirmBtn');
  invBtn.onclick = () => _withBtn(invBtn, () => confirmInvestment(pool));
  Modal.open('investModal');
  if (pool.product_type === 'cattle') _renderCattleHerdStatus('cattleHerdStatus', true);
}

function _updateInvestCalc(amt, rate, termMonths, minInvest, walletBal) {
  const banner     = document.getElementById('investInsufficientBanner');
  const confirmBtn = document.getElementById('investConfirmBtn');
  const feeAmtEl   = document.getElementById('ic-fee-amount');
  const feeFeeEl   = document.getElementById('ic-fee-fee');
  const feeTotEl   = document.getElementById('ic-fee-total');

  const fee          = _platformFee(amt);
  const totalNeeded  = amt + fee;
  const maxAffordable = walletBal ? Math.floor(walletBal / (1 + PLATFORM_FEE_RATE)) : null;
  const overBudget   = walletBal != null && totalNeeded > walletBal + 0.005;

  if (amt >= minInvest) {
    if (feeAmtEl) feeAmtEl.textContent = Utils.rand(amt, 2);
    if (feeFeeEl) feeFeeEl.textContent = Utils.rand(fee, 2);
    if (feeTotEl) {
      feeTotEl.textContent = Utils.rand(totalNeeded, 2);
      feeTotEl.style.color = overBudget ? '#ef4444' : 'var(--text-primary,#1a1a1a)';
    }
  } else {
    if (feeAmtEl) feeAmtEl.textContent = '—';
    if (feeFeeEl) feeFeeEl.textContent = '—';
    if (feeTotEl) { feeTotEl.textContent = '—'; feeTotEl.style.color = 'var(--text-primary,#1a1a1a)'; }
  }

  if (banner) {
    if (overBudget && maxAffordable != null) {
      const canInvest = maxAffordable >= minInvest;
      banner.style.display = 'block';
      banner.innerHTML = `
        <div style="margin-top:10px;background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.25);border-radius:10px;padding:12px 14px">
          <div style="display:flex;align-items:flex-start;gap:10px">
            <i class="fa-solid fa-circle-exclamation" style="color:#ef4444;margin-top:2px;flex-shrink:0"></i>
            <div style="flex:1">
              <div style="font-size:0.83rem;font-weight:700;color:#ef4444;margin-bottom:4px">Insufficient funds including the platform fee</div>
              <div style="font-size:0.78rem;color:#656565;line-height:1.5">
                You need <strong style="color:#303030">${Utils.rand(totalNeeded, 2)}</strong> (${Utils.rand(amt)} + ${Utils.rand(fee, 2)} fee) but your wallet has <strong style="color:#303030">${Utils.rand(walletBal)}</strong>.
                ${canInvest
                  ? `The most you can invest right now is <strong style="color:#303030">${Utils.rand(maxAffordable)}</strong>.`
                  : `This exceeds your available balance even at the minimum investment.`}
              </div>
              <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
                ${canInvest ? `<button class="btn btn--secondary btn--sm" onclick="document.getElementById('investAmount').value=${maxAffordable};_updateInvestCalc(${maxAffordable},${rate},${termMonths},${minInvest},${walletBal})">Use max (${Utils.rand(maxAffordable)})</button>` : ''}
                <button class="btn btn--primary btn--sm" onclick="Modal.close('investModal');navigate('wallet',document.querySelector('[data-view=wallet]'))"><i class="fa-solid fa-plus"></i> Top Up Wallet</button>
              </div>
            </div>
          </div>
        </div>`;
      if (confirmBtn) confirmBtn.disabled = true;
    } else {
      banner.style.display = 'none';
      banner.innerHTML = '';
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }
}

async function confirmInvestment(pool) {
  const amount = parseFloat(document.getElementById('investAmount').value);
  if (!amount || amount < pool.min_investment) { Toast.error(`Minimum investment is ${Utils.rand(pool.min_investment)}`); return; }

  const _confSa = _pmSaId ? PORTAL.subAccounts.find(s => s.id === _pmSaId) : null;
  const wallet = _confSa ? (parseFloat(_confSa.wallet_balance) || 0) : (parseFloat(PORTAL.investor?.wallet_balance) || 0);
  const platformFee = _platformFee(amount);
  const totalDeducted = amount + platformFee;
  if (totalDeducted > wallet) { Toast.error(`Insufficient balance. This investment requires ${Utils.rand(totalDeducted)} (${Utils.rand(amount)} + ${Utils.rand(platformFee)} platform fee).`); return; }

  try {
    const expectedReturn = amount * pool.annual_rate * (pool.term_months / 12);
    const maturityDate = new Date();
    maturityDate.setMonth(maturityDate.getMonth() + pool.term_months);

    // Create investment (server-side hook deducts wallet + fee atomically)
    const investmentId = Utils.genId('INVST');
    await API.investments.create({
      id: investmentId,
      investor_id: PORTAL.investor?.id,
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
      investor_id: PORTAL.investor?.id,
      investor_name:    `${PORTAL.investor.first_name} ${PORTAL.investor.last_name}`,
      type:             'investment',
      amount:           amount,
      status:           'completed',
      reference:        `INVST-${Date.now()}`,
      description:      `Investment into ${pool.name}`,
      pool_id:          pool.id,
      sub_account_id:   _pmSaId || undefined,
      transaction_date: new Date().toISOString(),
    });

    // Wallet deduction and total_invested update are handled atomically server-side
    // in the investment creation hook — do not also set wallet_balance here.

    // Sub-account wallet deduction (amount + fee) and total_invested are handled
    // atomically server-side in the investment hook — do NOT also PATCH the
    // sub-account here (that would double-deduct). Optimistically update the
    // local cache for instant UI; loadPortalData() below refreshes the truth.
    if (_pmSaId) {
      const saIdx = PORTAL.subAccounts.findIndex(s => s.id === _pmSaId);
      if (saIdx !== -1) {
        const sa = PORTAL.subAccounts[saIdx];
        PORTAL.subAccounts[saIdx].wallet_balance = Math.max(0, Math.round(((parseFloat(sa.wallet_balance) || 0) - totalDeducted) * 100) / 100);
        PORTAL.subAccounts[saIdx].total_invested  = Math.round(((parseFloat(sa.total_invested) || 0) + amount) * 100) / 100;
      }
    }

    Toast.success(`Successfully invested ${Utils.rand(amount)} in ${pool.name}!`);
    Modal.close('investModal');

    SVC.track('purchase', { transaction_id: investmentId, value: amount, currency: 'ZAR', items: [{ item_id: pool.id, item_name: pool.name, item_category: pool.product_type, price: amount, quantity: 1 }] });
    SVC.track('svc_investment_created', { pool_id: pool.id, pool_name: pool.name, product_type: pool.product_type, amount, amount_bucket: _amtBucket(amount), term_months: pool.term_months, annual_rate: parseFloat(pool.annual_rate) || 0, wallet_balance_bucket: _amtBucket(PORTAL.investor?.wallet_balance), total_investments: PORTAL.investments.filter(i => i.investor_id === (PORTAL.investor?.id || DEMO_INVESTOR_ID)).length + 1 });
    if (_pmSaId) {
      SVC.track('svc_subaccount_invested', { sub_account_id: _pmSaId, amount: amount });
    }
    _pmSaId = null;  // clear after investment completes

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

  const isActive  = inv.status === 'active';
  const total     = inv.amount + (inv.actual_return_amount || inv.expected_return_amount);
  const existing  = inv.maturity_instruction || '';

  // Fetch open pools of matching product type for reinvest option
  let reinvestPools = [];
  try {
    const poolsRes = await API.pools.list({ limit: 100 });
    reinvestPools = (poolsRes.data || []).filter(p => p.status === 'open' && p.product_type === inv.product_type);
  } catch (_) { /* non-fatal */ }

  const reinvestPoolsHtml = reinvestPools.length
    ? reinvestPools.map(p => `<option value="${p.id}">${p.name} (${Utils.rand(p.min_investment)} min · ${Utils.pct(p.annual_rate)} p.a.)</option>`).join('')
    : `<option value="" disabled>No open pools available for this product type</option>`;

  // Other products the client can switch the remaining funds into.
  const _seenPt = new Set();
  const switchProductsHtml = (_mktProducts || [])
    .filter(p => p.is_active && p.product_type !== inv.product_type && !_seenPt.has(p.product_type) && _seenPt.add(p.product_type))
    .map(p => `<option value="${p.product_type}" ${inv.switch_product_type === p.product_type ? 'selected' : ''}>${_esc(p.label || p.product_type)}</option>`).join('')
    || `<option value="" disabled>No other products available</option>`;

  document.getElementById('maturityModalBody').innerHTML = `
    <div class="info-list mb-16">
      <div class="info-row"><span class="info-row__label">Pool</span><span class="info-row__value">${_esc(inv.pool_name)}</span></div>
      <div class="info-row"><span class="info-row__label">Capital</span><span class="info-row__value">${Utils.rand(inv.amount)}</span></div>
      <div class="info-row"><span class="info-row__label">Returns</span><span class="info-row__value text-green">${Utils.rand(inv.actual_return_amount || inv.expected_return_amount)}</span></div>
      <div class="info-row"><span class="info-row__label">Total Payout</span><span class="info-row__value text-gold fw-700">${Utils.rand(total)}</span></div>
    </div>

    <div class="form-group">
      <label class="form-label">Instruction Type *</label>
      <select class="form-select" id="matInstructionType">
        <option value="payout_all" ${existing==='payout_all'?'selected':''}>Payout All — Receive full capital + returns</option>
        <option value="payout_return" ${existing==='payout_return'?'selected':''}>Payout Returns Only — Keep capital reinvested</option>
        <option value="reinvest" ${existing==='reinvest'?'selected':''}>Reinvest — Roll over into same product</option>
        <option value="payout_custom" ${existing==='payout_custom'?'selected':''}>Custom Payout — Specify amount</option>
        <option value="custom_switch" ${existing==='custom_switch'?'selected':''}>Custom Switch — Payout a portion & switch the rest to another product</option>
      </select>
    </div>

    <div id="switchProductGroup" style="display:${existing==='custom_switch'?'block':'none'}">
      <div class="form-group">
        <label class="form-label">Switch Remaining Funds Into *</label>
        <select class="form-select" id="matSwitchProduct">${switchProductsHtml}</select>
      </div>
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

    <div id="customPayoutGroup" style="display:${(existing==='payout_custom'||existing==='custom_switch')?'block':'none'}">
      <div class="form-group">
        <label class="form-label">Amount to Pay Out (R)</label>
        <input type="number" class="form-input" id="matCustomAmount" placeholder="Amount to withdraw" value="${inv.custom_payout_amount || ''}" />
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
    const v = e.target.value;
    document.getElementById('customPayoutGroup').style.display  = (v === 'payout_custom' || v === 'custom_switch') ? 'block' : 'none';
    document.getElementById('reinvestPoolGroup').style.display  = v === 'reinvest'      ? 'block' : 'none';
    const sg = document.getElementById('switchProductGroup'); if (sg) sg.style.display = v === 'custom_switch' ? 'block' : 'none';
  });

  const matBtn = document.getElementById('maturityConfirmBtn');
  matBtn.onclick = () => _withBtn(matBtn, () => submitMaturityInstruction(inv));
  Modal.open('maturityModal');
}

async function submitMaturityInstruction(inv) {
  const type      = document.getElementById('matInstructionType').value;
  const needsCustom = (type === 'payout_custom' || type === 'custom_switch');
  const customAmt = needsCustom ? parseFloat(document.getElementById('matCustomAmount').value) : null;
  const reinvestPoolId = type === 'reinvest' ? (document.getElementById('matReinvestPool')?.value || null) : null;
  const switchProductType = type === 'custom_switch' ? (document.getElementById('matSwitchProduct')?.value || null) : null;
  const total = inv.amount + (inv.actual_return_amount || inv.expected_return_amount);

  if (needsCustom && (!customAmt || customAmt <= 0)) { Toast.error('Please enter a valid payout amount'); return; }
  if (needsCustom && customAmt >= total) { Toast.error(`Payout amount must be less than the total of ${Utils.rand(total)}`); return; }
  if (type === 'custom_switch' && !switchProductType) { Toast.error('Please choose a product to switch the remaining funds into'); return; }
  if (type === 'reinvest' && !reinvestPoolId) { Toast.error('Please select a pool to reinvest into, or choose another instruction type'); return; }

  try {
    // Set the instruction via the dedicated endpoint FIRST — it enforces the
    // 17:00 SAST maturity-day cutoff and rejects late submissions.
    await API._fetch('POST', 'investments/' + inv.id + '/instruction', { instruction: type });

    // Persist the amount + switch target onto the investment for the engine.
    const extra = {};
    if (needsCustom)         extra.custom_payout_amount = customAmt;
    if (switchProductType)   extra.switch_product_type  = switchProductType;
    if (Object.keys(extra).length) await API.investments.update(inv.id, extra);

    await API.maturityInstructions.create({
      id: Utils.genId('MAT'),
      investment_id: inv.id,
      investor_id: PORTAL.investor?.id,
      investor_name: `${PORTAL.investor.first_name} ${PORTAL.investor.last_name}`,
      pool_name: inv.pool_name,
      instruction: type,
      instruction_type: type,
      custom_payout_amount: customAmt || 0,
      reinvest_pool_id: reinvestPoolId,
      status: 'submitted',
      submitted_date: new Date().toISOString(),
      total_payout: total
    });

    Toast.success('Maturity instruction saved successfully!');
    SVC.track('svc_maturity_instruction', { investment_id: inv.id, action: type });
    Modal.close('maturityModal');
    PORTAL.investments = [];
    await loadPortalData();
    loadMaturity();
  } catch (e) {
    console.error('[maturity]', e);
    Toast.error(e.message || 'Failed to save instruction');
  }
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
        investor_id:    PORTAL.investor?.id,
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

  // Logo URL — absolute so it resolves correctly inside the statement div
  const logoUrl = new URL('../assets/logo.png', window.location.href).href;

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
          ${stmtKPIBox('Capital Deployed', fmtNum(totalInvested), '#656565')}
          ${stmtKPIBox('Returns Earned', fmtNum(totalReturns), '#22C55E')}
          ${stmtKPIBox('Wallet Balance', fmtNum(walletBal), '#0096ff')}
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
            ${stmtInfoRow('Matured', investments.filter(i=>['matured','paid_out'].includes(i.status)).length)}
            ${stmtInfoRow('Risk Profile', investor.risk_profile ? investor.risk_profile.charAt(0).toUpperCase() + investor.risk_profile.slice(1) : 'Moderate')}
            ${stmtInfoRow('Province', investor.province || '—')}
            ${stmtInfoRow('Referral Code', investor.referral_code || '—')}
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
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #656565">
          <div style="width:4px;height:22px;background:linear-gradient(180deg,#656565,#656565);border-radius:2px"></div>
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
      // Actual rate ACHIEVED: only meaningful once matured. While active, show "—".
      const isMatured = inv.status === 'matured' || inv.status === 'paid_out';
      const baseRate = (Number(inv.expected_return_rate) || 0) * 100;
      const expRet = Number(inv.expected_return) || 0;
      const actRet = Number(inv.actual_return) || 0;
      const achievedRate = expRet > 0 ? baseRate * (actRet / expRet) : baseRate;
      const rateCell = isMatured ? `${achievedRate.toFixed(2)}%` : '—';
      const maturity = inv.maturity_date ? fmtDate(inv.maturity_date) : '—';
      const statusColor = inv.status === 'active' ? '#656565' : inv.status === 'paid_out' ? '#22C55E' : '#9ca3af';
      return `<tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:8px 10px;font-size:10px;color:#9ca3af;font-family:monospace">${inv.id}</td>
        <td style="padding:8px 10px;font-size:11px;font-weight:600;color:#1a1a1a">${_esc(inv.pool_name) || '—'}</td>
        <td style="padding:8px 10px">
          <span style="background:${info.bg};color:${info.color};font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase;letter-spacing:0.05em">${info.label}</span>
        </td>
        <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;text-align:right;font-weight:700">${fmtNum(inv.amount)}</td>
        <td style="padding:8px 10px;font-size:11px;color:${rateCell==='—'?'#9ca3af':'#ff9b0c'};text-align:right;font-weight:700">${rateCell}</td>
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
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">ID</th>
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Pool</th>
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Product</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Amount</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Actual Rate</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Invested</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Maturity</th>
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
      const isPos = !['withdrawal', 'fee', 'investment', 'gift_sent'].includes(t.type);
      const amt = isPos ? `+${fmtNum(Math.abs(t.amount))}` : `-${fmtNum(Math.abs(t.amount))}`;
      const amtColor = isPos ? '#22C55E' : '#EF4444';
      const typeMap = {deposit:'Deposit',withdrawal:'Withdrawal',investment:'Investment',return:'Return',payout:'Payout',fee:'Fee',referral_bonus:'Referral Bonus',gift_sent:'Gift Sent',gift_received:'Gift Received',reward:'XP Reward'};
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
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #eda5ff">
          <div style="width:4px;height:22px;background:linear-gradient(180deg,#eda5ff,#eda5ff);border-radius:2px"></div>
          <h3 style="font-size:13px;font-weight:800;color:#1a1a1a;letter-spacing:0.06em;text-transform:uppercase;margin:0">Transaction Ledger</h3>
          <span style="margin-left:auto;font-size:10px;color:#9ca3af">${transactions.length} transactions · ${fmtDate(from)} — ${fmtDate(to)}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">
          ${stmtMiniBox('Total Deposits', fmtNum(totalDeposits), '#22C55E')}
          ${stmtMiniBox('Total Invested', fmtNum(totalWithdrawals), '#656565')}
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
      <div style="background:linear-gradient(135deg,#1a3a4a 0%,#0d2535 100%);padding:28px 40px;display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:14px">
          <img src="${logoUrl}" alt="" style="height:52px;width:52px;object-fit:contain;display:block">
          <div>
            <div style="font-size:20px;font-weight:900;color:#fff;letter-spacing:0.06em;line-height:1">SV CAPITAL</div>
            <div style="font-size:10px;color:rgba(255,255,255,0.6);letter-spacing:0.12em;margin-top:3px;font-weight:500">VENTURE BEYOND THE ORDINARY</div>
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
          <span style="background:rgba(255,155,12,0.1);color:#ff5229;font-size:9px;font-weight:700;padding:2px 8px;border-radius:20px;border:1px solid rgba(255,155,12,0.2);margin-left:4px">${investorId}</span>
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
  // Colours align with each product's assigned colour (see Utils.productColor).
  const base  = (window.Utils && Utils.productInfo) ? Utils.productInfo(type) : { label: '' };
  const color = (window.Utils && Utils.productColor) ? Utils.productColor(type) : (base.color || '#6b7280');
  const label = base.label || (type ? type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Investment');
  return { label, color, bg: color + '1f' };   // 8-digit hex → light tint of the product colour
}

function printStatement() {
  const stmtDoc = document.getElementById('statementDocument');
  if (!stmtDoc || !stmtDoc.innerHTML.trim()) {
    Toast.error('Please generate a statement first, then print.');
    return;
  }
  // Inject a temporary print-only area — avoids popup blockers entirely
  const styleEl = document.createElement('style');
  styleEl.id = '_svc_print_css';
  styleEl.textContent = [
    '@media print{',
    '  body { visibility: hidden !important; }',
    '  #_svc_print_area, #_svc_print_area * { visibility: visible !important; }',
    '  #_svc_print_area {',
    '    position: fixed !important; inset: 0 !important; width: 100% !important;',
    '    font-family: Poppins, sans-serif !important;',
    '    background: #fff !important;',
    '    -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important;',
    '  }',
    '  @page { size: A4; margin: 0; }',
    '}'
  ].join('');
  document.head.appendChild(styleEl);

  const area = document.createElement('div');
  area.id = '_svc_print_area';
  area.innerHTML = stmtDoc.innerHTML;
  document.body.appendChild(area);

  window.print();

  // Clean up after the print dialog closes
  setTimeout(() => { styleEl.remove(); area.remove(); }, 1000);
}

/* ── Sub-account deposit ─────────────────────── */
function openSaDeposit(saId) {
  Modal.close('saDetailModal');
  openTopUpModal(null, saId);
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
  { id: 'cultivator', label: 'Cultivator', min: 600,  icon: 'fa-spa',              color: '#656565' },
  { id: 'harvester',  label: 'Harvester',  min: 1000, icon: 'fa-wheat-awn',        color: '#ff9b0c' },
  { id: 'pioneer',    label: 'Pioneer',    min: 1500, icon: 'fa-compass',          color: '#f59e0b' },
  { id: 'architect',  label: 'Architect',  min: 2500, icon: 'fa-building-columns', color: '#eda5ff' },
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
    const data = await API._fetch('GET', 'quests/my');
    PORTAL.quests = data;

    // Auto-detect and claim milestone quests silently
    await _autoClaimMilestones();

    renderXPWidget();
    _updateXPNavBadge();

    // Update the pov-rewards stat tile — renderOverview() runs before this resolves
    const _rewEl = document.getElementById('pov-rewards');
    if (_rewEl) {
      const _xp = PORTAL.quests?.xp || 0;
      const _lvl = _getLevelForXP(_xp);
      const _refTotal = (PORTAL.transactions || [])
        .filter(t => t.type === 'referral_bonus' && t.status !== 'rejected')
        .reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);
      if (_refTotal > 0) {
        _animateNum(_rewEl, _refTotal, 'R ', '', 600);
      } else {
        _rewEl.textContent = `${_lvl.label} · ${_xp.toLocaleString('en-ZA')} XP`;
      }
    }
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
      _saveNavBadgeCache('xp', readyCount);
    } else {
      badge.style.display = 'none';
      _saveNavBadgeCache('xp', 0);
    }
  }
}

/* ─── Nav badge cache — persists counts so they show instantly on next load ─── */
const _NAV_BADGE_KEY = 'svc_nav_badges';
function _saveNavBadgeCache(key, value) {
  try {
    const cur = JSON.parse(localStorage.getItem(_NAV_BADGE_KEY) || '{}');
    cur[key] = value;
    localStorage.setItem(_NAV_BADGE_KEY, JSON.stringify(cur));
  } catch (_) {}
}
function _restoreNavBadgesFromCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(_NAV_BADGE_KEY) || '{}');
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (val > 0) { el.textContent = val; el.style.display = 'inline-flex'; }
      else el.style.display = 'none';
    };
    set('subacctsBadge', cache.subaccounts || 0);
    set('xpNavBadge',    cache.xp || 0);
    set('giftsBadge',    cache.gifts || 0);
  } catch (_) {}
}
async function _prefetchNavBadges() {
  try {
    // Sub-accounts count
    const myId = PORTAL.investor?.id;
    if (myId) {
      const res = await API._fetch('GET', 'tables/sub_accounts', null, { parent_investor_id: myId, limit: 200 });
      const all = (res.data || []).filter(a => a.parent_investor_id === myId || a.investor_id === myId);
      PORTAL.subAccounts = all;
      const sb = document.getElementById('subacctsBadge');
      if (sb) {
        sb.textContent = all.length || '';
        sb.style.display = all.length ? '' : 'none';
      }
      _saveNavBadgeCache('subaccounts', all.length);
    }
    // Received gifts count (unclaimed = pending)
    const giftsRes = await API._fetch('GET', 'gifts/received');
    const pending = (giftsRes.data || []).filter(g => g.status === 'pending').length;
    const gb = document.getElementById('giftsBadge');
    if (gb) {
      if (pending > 0) { gb.textContent = pending; gb.style.display = 'inline-flex'; }
      else gb.style.display = 'none';
    }
    _saveNavBadgeCache('gifts', pending);
  } catch (_) {}
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
  if (heroTrackLabel) heroTrackLabel.textContent = next ? `${(next.min - xp).toLocaleString('en-ZA')} XP to ${next.label}` : 'Maximum level reached!';

  // ── Quests completed count
  const questsEl = document.getElementById('questRewardsEarned');
  const completedCount = PORTAL.quests?.completedIds?.length || 0;
  if (questsEl) questsEl.textContent = `${completedCount} Quest${completedCount !== 1 ? 's' : ''}`;

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
    if (rwCash) rwCash.textContent = completedCount;
    if (rwRef)  rwRef.textContent  = `R${referralBonuses.toFixed(2)}`;
    if (rwTot)  rwTot.textContent  = `${XP_LEVELS.filter(l => l.min > 0 && xp >= l.min).length} / ${XP_LEVELS.length - 1}`;
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
          ${l.min > 0 ? `<div class="level-step__reward" style="color:${isCurrent||isDone?l.color:'#9ca3af'}">${l.min} XP</div>` : ''}
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
                    ? `<button class="btn quest-claim-btn" style="background:${quest.color}" onclick="startLearningQuest('${quest.id}')">Start</button>`
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
          <div class="pending-group__label"><i class="fa-solid fa-graduation-cap" style="color:#656565"></i> Learning modules — earn XP & knowledge</div>
          <div class="quest-cards-grid">${learnReady.map(qst => _qCard(qst, 'learning')).join('')}</div>
        </div>`;
    }

    pendingHtml = `
      <div class="pending-section mb-28">
        <div class="pending-section__header">
          <div class="pending-section__title-row">
            <div>
              <div class="pending-section__title"><i class="fa-solid fa-list-check"></i> What to do next</div>
              <div class="pending-section__sub">${totalPending} quest${totalPending !== 1 ? 's' : ''} waiting for you · <span style="color:var(--gold)">${pendingXP} XP available</span>${nextLvlXp > 0 ? ` · <span style="color:#22c55e">${nextLvlXp} XP to next level</span>` : ''}</div>
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
  if (refSection) refSection.style.display = 'none';   // Referral Rewards History hidden (feature not live)
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

  // Use Modal.open so the overlay gets the `.open` class (opacity/pointer-events);
  // setting style.display alone leaves it at opacity:0 / pointer-events:none.
  if (window.Modal && Modal.open) Modal.open('surveyModal');
  else document.getElementById('surveyModal').classList.add('open');
}

function closeSurveyModal() {
  if (window.Modal && Modal.close) Modal.close('surveyModal');
  else document.getElementById('surveyModal').classList.remove('open');
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
  if (rewardEl) rewardEl.style.display = 'none';

  document.getElementById('levelUpModal').style.display = 'flex';
  _launchConfettiParticles();
}

function closeLevelUpModal() {
  document.getElementById('levelUpModal').style.display = 'none';
}

function _launchConfettiParticles() {
  const container = document.getElementById('levelupConfetti');
  if (!container) return;
  container.innerHTML = '';
  const colors = ['#ff9b0c', '#22c55e', '#656565', '#D4AF37', '#eda5ff'];
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
    icon: 'fa-building-columns', color: '#656565',
    keyPoints: [
      'SV Capital gives investors direct access to tangible South African alternative assets',
      'Products include solar energy projects, cattle farming, and delivery-bike fleets',
      'Investment terms start from 5 months, each with a defined return rate and maturity date',
      'Every investment is backed by real, income-generating assets',
    ],
    content: `SV Capital is a South African alternative investment platform that connects investors directly with real-economy projects generating above-inflation returns. Unlike unit trusts or share portfolios, your money is put to work in tangible assets — solar panels generating electricity, cattle being raised and sold at market, and delivery-bike fleets earning daily income.

Each investment has a clearly defined term, starting from 5 months, and a set annual rate of return, so you know what to expect from the outset. Every product carries its own risk profile — from Low through to High — so you can match your investments to your appetite. Your capital is tracked in real time on this portal.

At maturity you decide what happens next: pay the funds out to your wallet, reinvest them, or switch into a different product. Reinvested funds are never charged a platform fee, so more of your money stays invested and working for you.`,
    quiz: [
      { q: 'What types of assets does SV Capital invest in?', options: ['Shares and unit trusts', 'Tangible South African alternative assets', 'Foreign currency and crypto', 'Government bonds only'], correct: 1 },
      { q: 'What is the minimum SV Capital investment term?', options: ['1–7 days', '5 months', '5 years', 'No fixed term'], correct: 1 },
      { q: 'What fee is charged when you reinvest your funds at maturity?', options: ['5%', '2%', '1%', 'No fee'], correct: 3 },
    ],
  },
  {
    id: 'learn_how_returns', track: 'explorer', order: 2,
    title: 'How Your Returns Work', readTime: 7, xp: 50,
    icon: 'fa-percent', color: '#22c55e',
    keyPoints: [
      'Returns are shown as an annual percentage rate (p.a.)',
      'Your payout = capital × annual rate × (term ÷ 12 months)',
      'Every return appears in your history as a "Return Earned" entry',
      'Reinvesting at maturity compounds your growth — and reinvestments pay no platform fee',
    ],
    content: `When you invest with SV Capital, your return is driven by two things: the product's annual rate and its term. For example, R10,000 at 14% p.a. over 12 months returns R11,400 — your R10,000 capital plus R1,400 earned.

Shorter terms are simply pro-rated. The same 14% annual rate over 5 months pays roughly R583 on R10,000. Every return you earn is credited and shown in your transaction history as a "Return Earned" entry.

The effective return you see on your dashboard is the annualised figure, so you can compare a 5-month product against a multi-year one on equal footing. When an investment matures you decide what happens next — pay out, reinvest, or switch products — and reinvested funds are never charged a platform fee.`,
    quiz: [
      { q: 'R10,000 invested at 14% p.a. for 12 months — what is the total payout?', options: ['R10,140', 'R10,700', 'R11,400', 'R12,400'], correct: 2 },
      { q: 'What does the "effective return %" on your dashboard allow you to do?', options: ['Calculate your tax', 'Compare products fairly regardless of term length', 'Predict future returns', 'Convert returns to foreign currency'], correct: 1 },
      { q: 'At 14% p.a. for 5 months, the approximate return on R10,000 is:', options: ['R1,400', 'R200', 'R583', 'R2,100'], correct: 2 },
    ],
  },
  {
    id: 'learn_solar', track: 'explorer', order: 3,
    title: 'Solar Energy Investing', readTime: 8, xp: 50,
    icon: 'fa-solar-panel', color: '#f59e0b',
    keyPoints: [
      'SV Capital funds solar panel installations for South African businesses',
      'Businesses pay structured lease or energy purchase agreements',
      'Returns typically range from 14–18% p.a. over 5–7 year terms',
      'Solar projects benefit from long-term, predictable contractual cash flows',
    ],
    content: `Solar projects work by financing the installation of commercial-scale photovoltaic (PV) systems for verified South African businesses. Once installed, the business pays a set monthly amount — either as an energy purchase agreement (EPA) or a finance lease — providing predictable monthly revenue.

SV Capital aggregates these returns and passes them to investors net of all structuring costs. Solar assets are long-duration, making them ideal for capital you can commit for several years. Loadshedding in South Africa has significantly increased demand for behind-the-meter solar, providing strong deal flow for this product.

Each solar project undergoes technical assessment, legal review, and business viability checks before being made available to investors.`,
    quiz: [
      { q: 'What do SV Capital solar projects primarily fund?', options: ['Residential rooftop panels', 'Government solar farms', 'Commercial-scale PV system installations for businesses', 'Solar panel exports'], correct: 2 },
      { q: 'Typical SV Capital solar investment returns range from:', options: ['5–8% p.a.', '14–18% p.a.', '25–30% p.a.', '1–3% p.a.'], correct: 1 },
      { q: 'What has significantly increased demand for solar in South Africa?', options: ['Rising petrol prices', 'Tax incentives alone', 'Loadshedding', 'Lower electricity tariffs'], correct: 2 },
    ],
  },
  {
    id: 'learn_cattle', track: 'explorer', order: 4,
    title: 'Cattle Farming', readTime: 8, xp: 50,
    icon: 'fa-cow', color: '#eda5ff',
    keyPoints: [
      'Cattle are bought at auction, raised on a commercial feedlot, and sold at market',
      'A cattle cycle typically runs around 12 months at 12–16% p.a.',
      'Returns are driven by weight gain (≈200kg → 500kg) and the market price at sale',
      'Cattle carries an Aggressive risk profile — higher potential returns with more variability',
    ],
    content: `SV Capital's cattle product funds the purchase of commercial beef cattle at verified South African livestock auctions, in partnership with Beefcor — one of SA's premier feedlots. The cattle are fed and managed under professional supervision as they grow from roughly 200kg to 500kg, then sold at market at the end of the cycle.

Returns are driven by weight gain and the market price at sale. SV Capital manages execution risk through diversified lots and vetted farming partners, and each batch is tracked and reported in real time.

Because cattle depends on biological growth and market prices, it carries a higher (Aggressive) risk profile than solar — with the potential for stronger returns over a shorter, roughly 12-month term.`,
    quiz: [
      { q: 'How long is a typical SV Capital cattle investment cycle?', options: ['30–60 days', 'About 12 months', '3–5 years', '10 years'], correct: 1 },
      { q: 'What drives the returns on a cattle investment?', options: ['Fixed monthly returns', 'Weight gain and the market price at sale', 'Government subsidies', 'Rental income'], correct: 1 },
      { q: 'What risk profile does the cattle product carry?', options: ['Low', 'Medium', 'Aggressive', 'No risk'], correct: 2 },
    ],
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
    content: `Diversification means not putting all your eggs in one basket — a principle that applies as much to alternative investments as to traditional ones. By spreading your capital across products like solar, cattle, and delivery-bike fleets, you reduce the impact if any single investment underperforms.

Equally important is timeline diversification. If all your investments mature at the same time, you face reinvestment risk. Staggering your investments across different start dates means you always have capital returning, which can be reinvested into new opportunities.

Our data shows that investors with 3+ active product types consistently achieve smoother returns and higher portfolio satisfaction than those concentrated in a single product.`,
    quiz: [
      { q: 'What is the primary benefit of portfolio diversification?', options: ['Guarantee higher returns', 'Reduce exposure to any single risk', 'Eliminate all risk entirely', 'Reduce the tax you pay'], correct: 1 },
      { q: 'What is "timeline diversification"?', options: ['Investing in different countries at different times', 'Staggering investments across different start dates', 'Only investing in short-term products', 'Changing products every month'], correct: 1 },
      { q: 'According to SV Capital data, investors with 3+ active product types achieve:', options: ['Lower returns overall', 'Higher tax liability', 'Smoother returns and higher portfolio satisfaction', 'Faster access to withdrawals'], correct: 2 },
    ],
  },

  // ── Builder Track (growing investor) ───────────────────
  {
    id: 'learn_risk', track: 'builder', order: 1,
    title: 'Risk vs Return', readTime: 8, xp: 50,
    icon: 'fa-scale-balanced', color: '#eda5ff',
    keyPoints: [
      'Higher potential returns always come with higher risk',
      'Each product has a published risk profile — Low, Medium, Medium-High or High',
      'Match products to your risk appetite and how long you can commit capital',
      'Diversification reduces but cannot eliminate all risk',
    ],
    content: `Every investment involves a trade-off between risk and return. At SV Capital, each product carries a published risk profile — from Low through to High — set by our investment team. Solar projects sit at the more conservative end (long, contractual cash flows), while cattle farming sits at the higher end (biological and market variability) with the potential for higher returns.

Understanding your own risk tolerance is key. If you can only commit capital for a few months, shorter-term products suit you better; if you can commit for several years and tolerate some variability, a blended portfolio tends to deliver the best long-term outcome.

The 'Know Your Risk Profile' survey in Earn Rewards calibrates our recommendations to your personal appetite, and every product page shows its risk badge so you always know what you are taking on.`,
    quiz: [
      { q: 'Which SV Capital product carries the lowest operational risk?', options: ['Cattle farming', 'Delivery bikes', 'Solar projects', 'None — they are equal'], correct: 2 },
      { q: 'How do you see the risk level of each product?', options: ['A star rating', 'A risk profile from Low to High', 'A credit score', 'It is not shown'], correct: 1 },
      { q: 'Complete the sentence: "Higher potential returns always come with…"', options: ['Lower risk', 'More regulatory protection', 'Higher risk', 'Better liquidity'], correct: 2 },
    ],
  },
  {
    id: 'learn_compounding', track: 'builder', order: 2,
    title: 'The Compounding Effect', readTime: 7, xp: 50,
    icon: 'fa-chart-line', color: '#22c55e',
    keyPoints: [
      'Compounding means earning returns on your returns, not just your original capital',
      'The longer your investment horizon, the more powerful compounding becomes',
      'Reinvesting at maturity is the single most impactful decision — and it is fee-free',
      'A 14% p.a. return, reinvested over 5 years, nearly doubles your capital',
    ],
    content: `Albert Einstein reportedly called compound interest the "eighth wonder of the world." In practice, compounding means that after your first investment matures, you reinvest both the original capital and the returns — so in the next cycle, you earn returns on a larger base.

At 14% p.a., R10,000 grows to R11,400 after year 1. Reinvested, it becomes R12,996 after year 2 — not R12,800. The difference compounds every year. After 5 years, R10,000 compounding at 14% p.a. becomes approximately R19,254 — nearly double.

The key to unlocking compounding is acting at maturity. Capital sitting idle in your wallet earns nothing. Set your maturity instruction to reinvest — reinvestments pay no platform fee, so your full balance rolls over — and let time do the work.`,
    quiz: [
      { q: 'What does "compounding" mean in investing?', options: ['Adding new capital every month', 'Earning returns on your returns, not just your original capital', 'Splitting investments into smaller portions', 'Switching between product types'], correct: 1 },
      { q: 'R10,000 compounding at 14% p.a. over 5 years grows to approximately:', options: ['R17,000', 'R19,254', 'R21,000', 'R15,500'], correct: 1 },
      { q: 'What is the single most impactful action for compounding growth?', options: ['Withdrawing all returns each year', 'Waiting 6 months before reinvesting', 'Reinvesting at maturity as quickly as possible', 'Only investing in one product'], correct: 2 },
    ],
  },
  {
    id: 'learn_tax', track: 'builder', order: 3,
    title: 'Investment Tax in South Africa', readTime: 9, xp: 50,
    icon: 'fa-receipt', color: '#64748b',
    keyPoints: [
      'Investment returns from SV Capital are generally treated as ordinary income in South Africa',
      'You are required to declare investment returns in your annual tax return (ITR12)',
      'SV Capital issues statements and an annual Investment Income Certificate to help with your tax',
      'Consult a registered tax practitioner for personalised advice',
    ],
    content: `In South Africa, income earned from investments is generally subject to income tax at your marginal rate. This applies to the returns (interest or profit share) you earn through SV Capital products. Your original capital returned at maturity is not taxable — only the profit portion is.

SARS requires you to disclose all South African and foreign income on your annual return (ITR12). Your SV Capital account statement and annual Investment Income Certificate (available under "My Statement") give a breakdown of all returns earned in each tax year, which you or your accountant can use for tax submissions.

Note that SV Capital does not deduct tax at source — you are responsible for declaring and paying tax on returns earned. If your total investment income exceeds R23,800 per year (the annual interest exemption for individuals under 65), the excess is taxable. We strongly recommend consulting a registered tax practitioner.`,
    quiz: [
      { q: 'How are SV Capital investment returns generally taxed in South Africa?', options: ['Capital gains tax only', 'Ordinary income tax at your marginal rate', 'Exempt from all tax', 'Flat 10% withholding tax'], correct: 1 },
      { q: 'Which SARS annual tax return form must you use to declare investment returns?', options: ['IT3(b)', 'IT14', 'ITR12', 'VAT201'], correct: 2 },
      { q: 'What is the annual interest exemption for South African individuals under 65?', options: ['R10,000', 'R23,800', 'R50,000', 'R100,000'], correct: 1 },
    ],
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

A balanced blend for many SV Capital investors is roughly 40% solar (stable, longer-term base), 40% cattle (higher rate, shorter term), and 20% held in reserve for opportunistic reinvestment when new pools open. Because reinvestments are fee-free, rolling capital between pools costs you nothing.`,
    quiz: [
      { q: 'What is a "laddering strategy" in investing?', options: ['Investing in ladder-manufacturing companies', 'Starting multiple investments with staggered maturity dates', 'Increasing investment amounts each cycle', 'Only investing in the highest-rate products'], correct: 1 },
      { q: 'Approximately how much does a 2-week idle period cost on R50,000 at 14% p.a.?', options: ['R50', 'R1,000', 'R380', 'R1,900'], correct: 2 },
      { q: 'A balanced portfolio blend for SV Capital investors is:', options: ['100% solar for maximum stability', '50% cattle, 50% solar', '40% solar, 40% cattle, 20% reserve', 'Equal split across all available products'], correct: 2 },
    ],
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
    quiz: [
      { q: 'What is the estate duty rate in South Africa on dutiable estates above R3.5 million?', options: ['10%', '20%', '30%', '15%'], correct: 1 },
      { q: 'What is the most important first step to protect your investment wealth for your family?', options: ['Sell all investments before you die', 'Move funds to cash at retirement', 'Ensure beneficiary details are on file and your will references investment accounts', 'Convert all investments to foreign currency'], correct: 2 },
      { q: 'In South Africa, all assets when a person dies must go through:', options: ['The South African Reserve Bank', 'SARS', 'The Master of the High Court', 'The Department of Trade and Industry'], correct: 2 },
    ],
  },
];

const LEARN_TRACKS = [
  { id: 'explorer',   label: 'Explorer',   desc: 'New to investing — start here',        icon: 'fa-compass',          color: '#656565',  minInvested: 0 },
  { id: 'builder',    label: 'Builder',    desc: 'Growing your portfolio',                icon: 'fa-hammer',           color: '#22c55e',  minInvested: 5000 },
  { id: 'strategist', label: 'Strategist', desc: 'Advanced portfolio management',         icon: 'fa-chess-knight',     color: '#eda5ff',  minInvested: 50000 },
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
          ${isDone ? `<div class="learn-done-badge"><i class="fa-solid fa-circle-check"></i> Completed</div>` : ''}
          <button class="learn-expand-btn" onclick="_toggleModule('${mod.id}')" aria-label="View module">
            <i class="fa-solid fa-chevron-down" id="lchev-${mod.id}"></i>
          </button>
        </div>
        <div class="learn-module-body" id="lbody-${mod.id}" style="display:none">
          <div class="learn-key-points">
            <div class="learn-key-points__title"><i class="fa-solid fa-list-check"></i> Key Takeaways</div>
            <ul>${mod.keyPoints.map(p => `<li>${p}</li>`).join('')}</ul>
          </div>
          <div class="learn-content-text">${mod.content.split('\n\n').map(p => `<p>${p.trim()}</p>`).join('')}</div>
          <div class="learn-module-footer">
            ${isDone
              ? `<div class="learn-earned-note"><i class="fa-solid fa-circle-check"></i> Completed — +${mod.xp} XP already earned</div>`
              : `<button class="btn btn--primary" id="lquiz-btn-${mod.id}" onclick="_showModuleQuiz('${mod.id}')">
                   <i class="fa-solid fa-circle-question"></i> Take Quiz — Earn ${mod.xp} XP
                 </button>`
            }
          </div>
          <div class="learn-quiz-section" id="lquiz-${mod.id}" style="display:none">
            <div class="learn-quiz-title"><i class="fa-solid fa-circle-question"></i> Knowledge Check — answer all questions correctly to earn XP</div>
            <div id="lquiz-questions-${mod.id}"></div>
            <div id="lquiz-footer-${mod.id}"></div>
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

/* Learning-quest "Start": jump to the Learning Hub, switch to the module's
   track, expand it, and scroll it into view. */
function startLearningQuest(modId) {
  navigate('learn', document.querySelector('[data-view=learn]'));
  const mod = LEARN_MODULES.find(m => m.id === modId);
  if (mod && typeof _setLearnTrack === 'function') _setLearnTrack(mod.track);
  setTimeout(() => {
    const body = document.getElementById(`lbody-${modId}`);
    const card = document.getElementById(`lmod-${modId}`);
    if (body && body.style.display === 'none') _toggleModule(modId);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 180);
}

function _showModuleQuiz(modId) {
  const mod = LEARN_MODULES.find(m => m.id === modId);
  if (!mod?.quiz?.length) { markModuleComplete(modId); return; }

  const btn = document.getElementById(`lquiz-btn-${modId}`);
  if (btn) btn.style.display = 'none';

  const section = document.getElementById(`lquiz-${modId}`);
  if (section) section.style.display = 'block';

  if (!window._quizState) window._quizState = {};
  window._quizState[modId] = { answers: {}, submitted: false };
  _renderQuizQuestions(modId);
}

function _renderQuizQuestions(modId) {
  const mod = LEARN_MODULES.find(m => m.id === modId);
  if (!mod?.quiz) return;

  const questionsEl = document.getElementById(`lquiz-questions-${modId}`);
  if (questionsEl) {
    questionsEl.innerHTML = mod.quiz.map((q, qi) => `
      <div class="learn-quiz-q">
        <div class="learn-quiz-q__text">${qi + 1}. ${q.q}</div>
        <div class="learn-quiz-opts">
          ${q.options.map((opt, oi) => `
            <button class="learn-quiz-opt" id="lquiz-opt-${modId}-${qi}-${oi}"
                    onclick="_selectQuizOpt('${modId}',${qi},${oi})">
              <span class="learn-quiz-opt__letter">${'ABCD'[oi]}</span>
              <span class="learn-quiz-opt__text">${opt}</span>
            </button>`).join('')}
        </div>
      </div>`).join('');
  }

  const footerEl = document.getElementById(`lquiz-footer-${modId}`);
  if (footerEl) {
    footerEl.innerHTML = `
      <button class="btn btn--primary learn-quiz-submit-btn" onclick="_submitModuleQuiz('${modId}')">
        <i class="fa-solid fa-paper-plane"></i> Submit Answers — Earn ${mod.xp} XP
      </button>`;
  }
}

function _selectQuizOpt(modId, qi, oi) {
  const state = window._quizState?.[modId];
  if (!state || state.submitted) return;
  state.answers[qi] = oi;

  const mod = LEARN_MODULES.find(m => m.id === modId);
  const numOpts = mod?.quiz?.[qi]?.options?.length || 4;
  for (let o = 0; o < numOpts; o++) {
    const el = document.getElementById(`lquiz-opt-${modId}-${qi}-${o}`);
    if (el) el.classList.toggle('learn-quiz-opt--selected', o === oi);
  }
}

async function _submitModuleQuiz(modId) {
  const state = window._quizState?.[modId];
  const mod = LEARN_MODULES.find(m => m.id === modId);
  if (!state || !mod?.quiz) return;

  for (let qi = 0; qi < mod.quiz.length; qi++) {
    if (state.answers[qi] === undefined) {
      Toast.error('Please answer all questions before submitting.');
      return;
    }
  }

  state.submitted = true;
  let allCorrect = true;

  mod.quiz.forEach((q, qi) => {
    const selected = state.answers[qi];
    const correct = q.correct;
    if (selected !== correct) allCorrect = false;
    q.options.forEach((_, oi) => {
      const el = document.getElementById(`lquiz-opt-${modId}-${qi}-${oi}`);
      if (!el) return;
      el.classList.remove('learn-quiz-opt--selected');
      if (oi === correct) el.classList.add('learn-quiz-opt--correct');
      else if (oi === selected) el.classList.add('learn-quiz-opt--wrong');
      el.disabled = true;
    });
  });

  const footerEl = document.getElementById(`lquiz-footer-${modId}`);
  if (allCorrect) {
    if (footerEl) footerEl.innerHTML = `<div class="learn-quiz-success"><i class="fa-solid fa-circle-check"></i> All correct! Awarding ${mod.xp} XP…</div>`;
    await markModuleComplete(modId);
  } else {
    if (footerEl) footerEl.innerHTML = `
      <div class="learn-quiz-fail"><i class="fa-solid fa-circle-xmark"></i> Some answers were incorrect. Review the highlighted answers above, then try again.</div>
      <button class="btn btn--secondary" style="margin-top:10px" onclick="_retryModuleQuiz('${modId}')">
        <i class="fa-solid fa-rotate-right"></i> Try Again
      </button>`;
  }
}

function _retryModuleQuiz(modId) {
  if (!window._quizState?.[modId]) return;
  window._quizState[modId] = { answers: {}, submitted: false };
  _renderQuizQuestions(modId);
}

async function markModuleComplete(modId) {
  const btn = document.querySelector(`#lmod-${modId} .btn--primary`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...'; }

  try {
    const result = await _postQuestComplete(modId, { source: 'learning_hub' });
    if (result.error) {
      if (result.error.includes('already')) {
        Toast.info('Already completed!');
      } else if (/not found/i.test(result.error)) {
        Toast.success('Module complete!');
        if (PORTAL.quests) {
          PORTAL.quests.completedIds = [...(PORTAL.quests.completedIds || []), modId];
        }
        renderLearnView();
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

/* ═════════════════════════════════════════════════════════
   PLATFORM POLICIES
   ═════════════════════════════════════════════════════════ */

const POLICY_SECTIONS = [
  {
    id: 'pol_terms',
    icon: 'fa-file-contract',
    color: '#656565',
    title: 'Terms of Service',
    apiKey: 'terms',
    staticContent: `<p><em>Last updated: June 2025 &nbsp;·&nbsp; Version 1.0</em></p>
<p>By registering for, accessing, or using the SV Capital investor portal, mobile application, or any associated services (collectively, the "Platform"), you agree to be legally bound by these Terms of Service. If you do not agree, do not use the Platform.</p>

<h4>1. Definitions</h4>
<p><strong>"SV Capital"</strong> means SV Capital (Pty) Ltd, a company registered in the Republic of South Africa, authorised as a Financial Services Provider under FSP licence number 52449.<br>
<strong>"Investor"</strong> means any natural person or juristic entity that has registered an account on the Platform.<br>
<strong>"Investment Pool"</strong> means a structured investment product offered through the Platform, including but not limited to cattle investment cycles, solar energy projects, and short-term business loan products.<br>
<strong>"FICA"</strong> means the Financial Intelligence Centre Act 38 of 2001 and all regulations promulgated thereunder.<br>
<strong>"Wallet"</strong> means the virtual account balance held in your investor profile on the Platform, representing funds available for investment.</p>

<h4>2. Eligibility and Registration</h4>
<p>To register and use the Platform, you must: (a) be a natural person of at least 18 years of age, or a duly authorised representative of a registered juristic entity; (b) be a South African citizen, permanent resident, or a foreign national with a valid passport, eligible to invest under applicable South African law; (c) complete the FICA/KYC identity verification process to the satisfaction of SV Capital; and (d) not be listed on any domestic or international sanctions, terrorist financing, or politically exposed persons lists.</p>
<p>You may not create more than one individual investor account. Corporate entities may register a separate account distinct from personal accounts. Accounts created fraudulently, or by persons not meeting the above criteria, will be terminated without notice.</p>

<h4>3. Account Security</h4>
<p>You are solely responsible for maintaining the confidentiality of your login credentials. You must notify SV Capital immediately at <strong>support@svcapital.co.za</strong> if you become aware of any unauthorised access to your account. SV Capital will not be liable for any loss arising from your failure to maintain the security of your credentials. You agree not to share your account with any third party.</p>

<h4>4. Investment Products and Services</h4>
<p>The Platform provides access to alternative investment products. Each Investment Pool has specific terms including minimum investment amounts, fixed investment terms, target annual return rates, and maturity dates. Return rates are targets and are not guaranteed. SV Capital does not guarantee any specific return on investment.</p>
<p>Once an investment is placed and confirmed, it is subject to the terms of the specific Investment Pool and may not be withdrawn before the maturity date without incurring an early exit penalty as specified in the Pool's terms. Maturity instructions must be submitted before the maturity date; failure to submit an instruction may result in automatic rollover at SV Capital's discretion.</p>

<h4>5. Deposits and Withdrawals</h4>
<p>Funds deposited to your Wallet are held in a designated trust or ring-fenced account and are not commingled with SV Capital's operating funds. Deposits are credited to your Wallet upon confirmation of receipt. Withdrawal requests are subject to: (a) verification of your bank account; (b) FICA compliance status; and (c) processing times of 1–5 business days. SV Capital reserves the right to perform enhanced due diligence before processing large withdrawals.</p>

<h4>6. Fees and Charges</h4>
<p>SV Capital charges no entry fees, exit fees, subscription fees, or management fees directly to investors. Revenue is derived from structuring and arrangement fees charged at the project/pool level, which are embedded in and already deducted from the quoted return rate presented to investors. Any third-party banking or payment processing charges incurred during deposits or withdrawals are for the investor's account.</p>

<h4>7. Prohibited Activities</h4>
<p>You agree not to: (a) use the Platform for any unlawful purpose, including money laundering, terrorist financing, or tax evasion; (b) attempt to gain unauthorised access to any part of the Platform or its underlying systems; (c) use automated tools, bots, or scripts to access or scrape the Platform; (d) misrepresent your identity or financial standing; (e) engage in any conduct that disrupts or interferes with the Platform's operation; or (f) resell or sub-license access to the Platform without SV Capital's prior written consent.</p>

<h4>8. Intellectual Property</h4>
<p>All content on the Platform, including software, text, graphics, logos, and data, is owned by or licensed to SV Capital and is protected by applicable intellectual property laws. You are granted a limited, non-exclusive, revocable licence to access and use the Platform for your personal investment purposes only. No licence to reproduce, distribute, or create derivative works is granted.</p>

<h4>9. Limitation of Liability</h4>
<p>To the fullest extent permitted by law, SV Capital, its directors, officers, employees, and agents shall not be liable for: (a) any indirect, incidental, special, consequential, or punitive damages; (b) loss of profits, revenue, data, or investment returns; (c) damages arising from your reliance on information provided on the Platform; or (d) system downtime, data loss, or security breaches not caused by SV Capital's gross negligence or wilful misconduct. SV Capital's total aggregate liability for any claim shall not exceed the total amount invested by you through the Platform in the 12 months preceding the claim.</p>

<h4>10. Indemnification</h4>
<p>You agree to indemnify and hold harmless SV Capital and its affiliates from any claims, losses, liabilities, costs, and expenses (including reasonable legal fees) arising from: (a) your use of the Platform; (b) your breach of these Terms; (c) your violation of any applicable law; or (d) any third-party claim arising from your actions on the Platform.</p>

<h4>11. Amendments</h4>
<p>SV Capital reserves the right to amend these Terms at any time. Material amendments will be communicated to registered investors via email and/or in-app notification at least 30 days before the effective date. Continued use of the Platform after the effective date constitutes acceptance of the amended Terms. If you do not accept the changes, you must cease using the Platform and request account closure.</p>

<h4>12. Termination</h4>
<p>SV Capital may suspend or terminate your account immediately if: (a) you breach these Terms; (b) we are required to do so by law or regulatory authority; (c) your FICA/KYC verification fails; or (d) we reasonably suspect fraudulent or criminal activity. Upon termination, any active investments will continue to their scheduled maturity, and remaining Wallet balances will be paid to your verified bank account within a reasonable period.</p>

<h4>13. Governing Law and Dispute Resolution</h4>
<p>These Terms are governed by the laws of the Republic of South Africa. Any dispute arising from these Terms shall first be submitted to mediation. If mediation fails, the dispute shall be referred to arbitration under the rules of the Arbitration Foundation of Southern Africa (AFSA), with proceedings conducted in English in South Africa. Nothing in this clause prevents either party from seeking urgent relief from a court of competent jurisdiction.</p>

<h4>14. Contact</h4>
<p><strong>SV Capital (Pty) Ltd</strong><br>Email: <strong>legal@svcapital.co.za</strong><br>Support: <strong>support@svcapital.co.za</strong><br>FSP No: 52449 — Regulated by the FSCA</p>`,
  },
  {
    id: 'pol_privacy',
    icon: 'fa-shield-halved',
    color: '#22c55e',
    title: 'Privacy Policy',
    apiKey: 'privacy',
    staticContent: `<p><em>Last updated: June 2025 &nbsp;·&nbsp; Version 1.0</em></p>
<p>SV Capital (Pty) Ltd ("SV Capital", "we", "us", "our") is committed to protecting your personal information and processing it lawfully, in compliance with the Protection of Personal Information Act 4 of 2013 ("POPIA") and all applicable South African data protection legislation.</p>

<h4>1. Responsible Party</h4>
<p><strong>SV Capital (Pty) Ltd</strong> is the Responsible Party for the personal information you provide. Our Information Officer is responsible for ensuring compliance with POPIA and may be contacted at <strong>privacy@svcapital.co.za</strong>.</p>

<h4>2. Personal Information We Collect</h4>
<p>We collect the following categories of personal information:</p>
<ul>
<li><strong>Identity Information:</strong> Full name, date of birth, South African ID number or passport number and expiry date, nationality, and a copy of your identity document.</li>
<li><strong>Contact Information:</strong> Email address, mobile number, physical address, and province of residence.</li>
<li><strong>Financial Information:</strong> Banking details (bank name, account number, account type, branch code), wallet balance, investment history, transaction records, and income/risk profile.</li>
<li><strong>FICA/KYC Documentation:</strong> Proof of identity, proof of address, and any source-of-funds documentation required for regulatory compliance.</li>
<li><strong>Device and Technical Information:</strong> IP address, browser type and version, operating system, session data, and usage patterns within the Platform.</li>
<li><strong>Communication Records:</strong> Support ticket content, email correspondence, and in-app messages.</li>
<li><strong>Referral Information:</strong> Where you were referred by another investor, their referral code is recorded.</li>
</ul>

<h4>3. Purposes of Processing</h4>
<p>We process your personal information for the following purposes:</p>
<ul>
<li>Opening and managing your investor account;</li>
<li>Processing investment transactions, deposits, and withdrawals;</li>
<li>Complying with FICA, FAIS, POPIA, and all applicable financial services legislation;</li>
<li>Verifying your identity and conducting risk assessments (KYC/AML);</li>
<li>Communicating with you about your investments, account status, and platform updates;</li>
<li>Generating investment certificates, account statements, and tax documentation (IT3b);</li>
<li>Preventing, detecting, and investigating fraud, money laundering, and other unlawful activity;</li>
<li>Improving the Platform and its features based on usage analytics;</li>
<li>Responding to legal or regulatory requests, court orders, or governmental inquiries;</li>
<li>Sending you transactional notifications and, with your consent, marketing communications.</li>
</ul>

<h4>4. Lawful Basis for Processing</h4>
<p>We process your personal information on the following lawful grounds:</p>
<ul>
<li><strong>Contractual necessity:</strong> Processing required to fulfil our obligations to you as an investor;</li>
<li><strong>Legal obligation:</strong> Processing required to comply with FICA, the Income Tax Act, FAIS, and POPIA;</li>
<li><strong>Consent:</strong> For direct marketing and optional communications, where you have given explicit consent;</li>
<li><strong>Legitimate interest:</strong> For fraud prevention, security monitoring, and platform improvement, where this does not override your rights.</li>
</ul>

<h4>5. Sharing of Personal Information</h4>
<p>We do not sell, rent, or trade your personal information. We may share it with:</p>
<ul>
<li><strong>Identity verification providers:</strong> For FICA/KYC checks;</li>
<li><strong>Payment processors:</strong> For processing deposits and withdrawals;</li>
<li><strong>Regulatory bodies:</strong> FSCA, FIC, SARS, and other South African authorities as required by law;</li>
<li><strong>Auditors and legal advisers:</strong> Under binding confidentiality obligations;</li>
<li><strong>Cloud service providers:</strong> Who process data on our behalf under strict data processing agreements;</li>
<li><strong>Law enforcement:</strong> Where legally compelled by court order or applicable legislation.</li>
</ul>
<p>All third parties are required to maintain the security of your information and to use it only for the purposes for which it was shared.</p>

<h4>6. Cross-Border Transfers</h4>
<p>Your personal information is primarily processed and stored within the Republic of South Africa. If any processing occurs outside South Africa, we ensure that the recipient country provides adequate protection and that appropriate safeguards (such as data processing agreements or binding corporate rules) are in place, as required by Section 72 of POPIA.</p>

<h4>7. Retention of Personal Information</h4>
<p>We retain your personal information only for as long as necessary to fulfil the purposes for which it was collected, or as required by law:</p>
<ul>
<li>FICA documentation and KYC records: minimum 5 years after account closure, as required by the Financial Intelligence Centre Act;</li>
<li>Investment records and transaction history: minimum 5 years for tax purposes;</li>
<li>Account information: retained while your account is active and for up to 7 years after closure;</li>
<li>Audit logs and access records: 3 years;</li>
<li>Support and complaint records: 3 years from resolution.</li>
</ul>

<h4>8. Security Measures</h4>
<p>We implement appropriate technical and organisational security measures including: TLS encryption for all data in transit; AES-256 encryption for sensitive data at rest; role-based access controls limiting staff access to personal information; multi-factor authentication for admin systems; regular security audits and penetration testing; and incident response procedures. Despite these measures, no system is entirely secure. We will notify you of any security breach that poses a real risk of harm to you, in accordance with POPIA.</p>

<h4>9. Cookies and Tracking</h4>
<p>The Platform uses cookies and similar technologies for session management, security, and analytics. Strictly necessary cookies cannot be disabled as they are required for the Platform to function. Analytics cookies help us understand usage patterns and are collected in pseudonymised form. You may control cookie preferences via your browser settings; however, disabling certain cookies may affect Platform functionality.</p>

<h4>10. Your Rights as a Data Subject</h4>
<p>Under POPIA, you have the right to:</p>
<ul>
<li><strong>Access:</strong> Request a copy of the personal information we hold about you;</li>
<li><strong>Correction:</strong> Request that inaccurate or incomplete information be corrected;</li>
<li><strong>Deletion:</strong> Request deletion of your personal information, subject to our legal retention obligations;</li>
<li><strong>Objection:</strong> Object to processing based on legitimate interests, including direct marketing;</li>
<li><strong>Restriction:</strong> Request that processing be restricted in certain circumstances;</li>
<li><strong>Complaint:</strong> Lodge a complaint with the Information Regulator of South Africa.</li>
</ul>
<p>To exercise any of these rights, contact our Information Officer at <strong>privacy@svcapital.co.za</strong>. We will respond within 30 days.</p>

<h4>11. Direct Marketing</h4>
<p>We may send you information about investment opportunities, platform features, and financial education content. You may opt out of marketing communications at any time by clicking "Unsubscribe" in any email, or by contacting <strong>privacy@svcapital.co.za</strong>. Transactional communications (such as investment confirmations and account statements) cannot be opted out of while your account is active.</p>

<h4>12. Changes to This Policy</h4>
<p>We may update this Privacy Policy from time to time. Material changes will be communicated via email or in-app notification before they take effect. Continued use of the Platform after the effective date constitutes acknowledgment of the updated Policy.</p>

<h4>13. Contact</h4>
<p><strong>Information Officer:</strong> privacy@svcapital.co.za<br>
<strong>General:</strong> info@svcapital.co.za<br>
<strong>Information Regulator (South Africa):</strong> inforeg.org.za &nbsp;·&nbsp; complaints.IR@justice.gov.za</p>`,
  },
  {
    id: 'pol_popia',
    icon: 'fa-lock',
    color: '#eda5ff',
    title: 'POPIA Notice',
    staticContent: `<p><em>Issued in compliance with Section 18 of the Protection of Personal Information Act 4 of 2013 (POPIA) &nbsp;·&nbsp; Version 1.0</em></p>

<h4>1. Responsible Party</h4>
<p><strong>SV Capital (Pty) Ltd</strong><br>
Financial Services Provider · FSP No. 52449<br>
Republic of South Africa<br>
Email: <strong>info@svcapital.co.za</strong></p>

<h4>2. Information Officer</h4>
<p>The designated Information Officer (IO) responsible for ensuring SV Capital's compliance with POPIA may be contacted at: <strong>privacy@svcapital.co.za</strong>. The IO is registered with the Information Regulator of South Africa in accordance with Section 55 of POPIA.</p>

<h4>3. Categories of Personal Information Processed</h4>
<p>SV Capital processes the following categories of personal information:</p>
<ul>
<li><strong>Identifying information:</strong> Full legal name, date of birth, RSA ID number or passport details, photograph (where required for KYC);</li>
<li><strong>Contact details:</strong> Email address, mobile number, physical and postal address;</li>
<li><strong>Financial information:</strong> Bank account details, investment transactions, wallet balance, income level, risk profile;</li>
<li><strong>FICA/KYC documentation:</strong> Certified copies of identity documents, proof of address, source-of-funds declarations;</li>
<li><strong>Technical data:</strong> Device identifiers, IP addresses, browser information, usage logs;</li>
<li><strong>Special categories:</strong> We do not intentionally collect special personal information as defined in Section 26 of POPIA (e.g., health, religious, or racial information).</li>
</ul>

<h4>4. Purposes of Processing</h4>
<p>Your personal information is processed for the following specific, explicit, and legitimate purposes:</p>
<ul>
<li>Investor onboarding and account management;</li>
<li>Identity verification and FICA/KYC compliance;</li>
<li>Anti-money laundering (AML) and counter-terrorist financing (CTF) screening;</li>
<li>Processing investment transactions and generating returns;</li>
<li>Producing investment certificates, account statements, and IT3(b) tax certificates;</li>
<li>Communicating investment performance, maturity notices, and regulatory updates;</li>
<li>Complying with FSCA reporting obligations, SARS requirements, and FIC directives;</li>
<li>Fraud prevention and platform security;</li>
<li>Resolving complaints and support queries.</li>
</ul>

<h4>5. Lawful Grounds for Processing</h4>
<p>Processing is carried out on the following grounds as contemplated in Section 11 of POPIA:</p>
<ul>
<li><strong>Consent (s.11(1)(a)):</strong> Where you have given specific, informed consent, including for direct marketing;</li>
<li><strong>Contract (s.11(1)(b)):</strong> Where processing is necessary for the performance of our investment services agreement with you;</li>
<li><strong>Legal obligation (s.11(1)(c)):</strong> Where we are required to process information to comply with FICA, FAIS, POPIA, and other applicable legislation;</li>
<li><strong>Legitimate interest (s.11(1)(f)):</strong> For fraud prevention, security monitoring, and platform improvement, provided this does not override your rights and interests.</li>
</ul>

<h4>6. Sources of Personal Information</h4>
<p>Personal information is collected directly from you during registration and throughout your use of the Platform. Additional information may be sourced from: identity verification bureaus (for FICA checks), credit bureaus (for risk assessment), payment processors (for banking verification), and public registers (e.g., CIPC for corporate investor verification).</p>

<h4>7. Recipients of Personal Information</h4>
<p>Your personal information may be shared with the following recipients:</p>
<ul>
<li>Identity and KYC verification service providers;</li>
<li>Payment gateway providers and banks;</li>
<li>The Financial Intelligence Centre (FIC), FSCA, SARS, and other regulatory bodies as required by law;</li>
<li>Professional advisers (attorneys, auditors, compliance officers) under confidentiality obligations;</li>
<li>Cloud infrastructure and data hosting providers under data processing agreements;</li>
<li>Law enforcement agencies pursuant to valid legal process.</li>
</ul>

<h4>8. Cross-Border Transfers of Personal Information</h4>
<p>In accordance with Section 72 of POPIA, personal information will only be transferred to a third party in a foreign country if: (a) the recipient is subject to a law, binding corporate rules, or binding agreement that provides an adequate level of protection substantially similar to POPIA; or (b) you have consented to the transfer. We will not transfer your information to jurisdictions that do not provide adequate protection without appropriate safeguards.</p>

<h4>9. Retention Periods</h4>
<table style="width:100%;border-collapse:collapse;font-size:0.87rem;margin-bottom:12px">
<thead><tr style="background:rgba(0,0,0,0.05)"><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Category</th><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Retention Period</th><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Legal Basis</th></tr></thead>
<tbody>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">FICA/KYC documentation</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">5 years after account closure</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">FIC Act s.23</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Investment and transaction records</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">5 years (tax purposes)</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Income Tax Act</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Account and profile data</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Duration of account + 7 years</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">FAIS Act</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Audit and access logs</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">3 years</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Legitimate interest</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Support and complaint records</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">3 years from resolution</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Legitimate interest</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Policy acceptance records</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Duration of account + 7 years</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Legal obligation / evidence</td></tr>
</tbody>
</table>

<h4>10. Your Rights as a Data Subject</h4>
<p>Sections 23–25 of POPIA afford you the following rights, which you may exercise by contacting our Information Officer:</p>
<ul>
<li><strong>Right of access (s.23):</strong> To request confirmation of whether we hold your personal information and to obtain a copy thereof;</li>
<li><strong>Right to correction or deletion (s.24):</strong> To request that inaccurate, incomplete, or outdated information be corrected or destroyed;</li>
<li><strong>Right to object (s.11(3)):</strong> To object to the processing of your personal information on the ground of legitimate interests or for direct marketing purposes;</li>
<li><strong>Right to restriction:</strong> To request that processing be restricted in certain circumstances (e.g., while accuracy of data is disputed);</li>
<li><strong>Right to complain:</strong> To lodge a complaint with the Information Regulator of South Africa.</li>
</ul>
<p>Requests will be responded to within 30 days. We may charge a reasonable fee for manifestly unfounded or excessive requests.</p>

<h4>11. Objection to Direct Marketing</h4>
<p>In terms of Section 69 of POPIA, you have the right to object, at any time, to your personal information being used for direct marketing purposes. To opt out, email <strong>privacy@svcapital.co.za</strong> or use the unsubscribe link in any marketing email.</p>

<h4>12. Complaints to the Information Regulator</h4>
<p>If you believe that SV Capital has infringed your rights under POPIA, you may lodge a complaint with:</p>
<p><strong>The Information Regulator (South Africa)</strong><br>
Website: <strong>inforeg.org.za</strong><br>
Email: <strong>complaints.IR@justice.gov.za</strong><br>
PAIAComplaints.IR@justice.gov.za (for PAIA complaints)</p>`,
  },
  {
    id: 'pol_risk',
    icon: 'fa-triangle-exclamation',
    color: '#d97706',
    title: 'Risk Disclaimer',
    staticContent: `<p><em>Version 1.0 &nbsp;·&nbsp; Effective June 2025</em></p>
<p><strong>Please read this Risk Disclaimer carefully before making any investment decision. By investing through the SV Capital Platform, you acknowledge that you have read, understood, and accepted the risks described herein.</strong></p>

<h4>1. General Investment Risk Warning</h4>
<p>All investments involve risk. The value of your investment, and any returns derived from it, may go down as well as up. You may receive back less than the amount you invested. Past performance of any Investment Pool or SV Capital's overall portfolio is not a reliable indicator of future performance. No investment return is guaranteed.</p>

<h4>2. Not a Deposit</h4>
<p>Investments made through SV Capital are not deposits and are not protected by any deposit insurance scheme, government guarantee, or scheme of arrangement under the Deposit Guarantee Scheme or any equivalent. Your invested capital is at risk.</p>

<h4>3. Alternative Investment Risk</h4>
<p>The products offered on this Platform are alternative investments — they differ significantly from listed equities, bonds, and traditional unit trusts. Alternative investments carry specific and heightened risks, including reduced regulatory oversight of underlying assets, less frequent valuation, and greater complexity. You should understand the nature of each Investment Pool before committing funds.</p>

<h4>4. Liquidity Risk</h4>
<p>Investment Pools have fixed terms. Once an investment is placed, your capital is locked in for the duration of the selected term. Early exit is not guaranteed and, where permitted, will attract an early exit penalty as specified in the Pool terms. You should only invest funds that you can afford to have unavailable for the full investment term. There is no secondary market for your investment interest.</p>

<h4>5. Credit and Default Risk</h4>
<p>For loan-based products, there is a risk that underlying borrowers may default on their obligations. While SV Capital structures loans with security and collateral where possible, the realisation of security may not fully recover your capital in all circumstances. SV Capital does not guarantee the creditworthiness of any borrower.</p>

<h4>6. Commodity and Market Risk</h4>
<p>Cattle investment products are subject to commodity risk. Live cattle prices are determined by market forces including supply and demand, feed costs, disease outbreaks, export restrictions, and consumer preferences. Adverse movements in beef prices may reduce or eliminate projected returns. SV Capital does not control commodity markets and cannot guarantee the price at which cattle will be sold.</p>

<h4>7. Operational Risk (Cattle)</h4>
<p>Cattle farming involves operational risks including, but not limited to: disease and mortality (including foot-and-mouth disease, anthrax, and other livestock diseases); drought and adverse weather affecting grazing and water availability; theft and security incidents; veterinary costs exceeding projections; and challenges in sourcing quality stock. Although SV Capital employs experienced farm managers and carries appropriate insurance where available, these risks cannot be entirely eliminated.</p>

<h4>8. Renewable Energy and Solar Risk</h4>
<p>Solar energy projects are subject to risks including: weather variability and reduced solar irradiance reducing output below projections; equipment failure or degradation; grid connectivity issues and load-shedding impacts; changes to government feed-in tariff or energy policy; counterparty risk of energy off-takers; and regulatory changes to the energy sector. Returns on solar projects are partly dependent on energy production volumes and prevailing energy tariffs.</p>

<h4>9. Regulatory and Compliance Risk</h4>
<p>The regulatory environment for alternative investments and financial technology in South Africa is evolving. Changes in legislation (including FICA, FAIS, or tax law), regulatory interpretation, or enforcement policy could affect SV Capital's ability to offer certain products or could impose additional compliance costs. SV Capital may be required to make changes to its products or operations in response to regulatory developments, which could affect investor returns.</p>

<h4>10. Technology and Cybersecurity Risk</h4>
<p>The Platform relies on technology infrastructure that may be subject to downtime, technical failures, data breaches, or cyberattacks. While SV Capital implements industry-standard security measures, no system is completely immune to security incidents. A technology failure could result in temporary inability to access your account or execute transactions. SV Capital maintains business continuity and disaster recovery plans to minimise the impact of such events.</p>

<h4>11. Inflation Risk</h4>
<p>The purchasing power of your returns may be eroded by inflation. If the rate of inflation exceeds the return rate of your investment, the real value of your returns will be negative even if the nominal return is positive.</p>

<h4>12. Concentration Risk</h4>
<p>Investing a significant portion of your total investable assets in any single Investment Pool or product type increases concentration risk. SV Capital recommends that you diversify your investments across different asset classes and Pool types to reduce the impact of any single investment's underperformance.</p>

<h4>13. Suitability Warning</h4>
<p>Alternative investments may not be suitable for all investors. These products are designed for investors who: understand the risks of illiquid, fixed-term investments; have an investment horizon that matches the product term; can afford to lose some or all of their invested capital; and have adequate financial resources for their day-to-day needs beyond the amounts invested. Before investing, carefully consider your investment objectives, risk tolerance, financial situation, and need for liquidity. If you are unsure, seek independent financial advice from a registered financial adviser authorised under FAIS.</p>

<h4>14. No Financial Advice</h4>
<p>Nothing on this Platform, including product descriptions, return rate projections, investment summaries, or communications from SV Capital staff (unless expressly provided by a registered financial adviser in terms of an advisory mandate), constitutes financial, investment, legal, or tax advice. Information is provided for general informational purposes only. Investment decisions are the sole responsibility of the investor.</p>

<h4>15. Tax Considerations</h4>
<p>Returns on investments may be subject to South African income tax, capital gains tax, or withholding tax depending on your tax status and the nature of the return. Interest income earned through the Platform must be declared in your annual tax return (ITR12). SV Capital issues IT3(b) certificates annually to assist with this. SV Capital does not provide tax advice; consult a registered tax practitioner for guidance specific to your circumstances.</p>

<h4>16. Forward-Looking Statements</h4>
<p>Any projected return rates, indicative timelines, or performance forecasts presented on this Platform are forward-looking statements based on current market conditions and assumptions. They do not constitute a guarantee or promise of future results. Actual outcomes may differ materially from projections.</p>`,
  },
  {
    id: 'pol_paia',
    icon: 'fa-folder-open',
    color: '#656565',
    title: 'PAIA Manual',
    staticContent: `<p><em>Published in terms of Section 51 of the Promotion of Access to Information Act 2 of 2000 (PAIA) &nbsp;·&nbsp; Version 1.0 &nbsp;·&nbsp; June 2025</em></p>

<h4>1. Contact Details of SV Capital</h4>
<p><strong>Legal Name:</strong> SV Capital (Pty) Ltd<br>
<strong>Nature of Business:</strong> Alternative Investment Platform, licensed Financial Services Provider<br>
<strong>FSP Number:</strong> 52449<br>
<strong>Email:</strong> info@svcapital.co.za<br>
<strong>PAIA Requests:</strong> privacy@svcapital.co.za<br>
<strong>Registered Country:</strong> Republic of South Africa</p>

<h4>2. Information Officer</h4>
<p>The Information Officer is responsible for administering all PAIA requests on behalf of SV Capital.</p>
<p><strong>Contact:</strong> privacy@svcapital.co.za<br>
<strong>Postal:</strong> Marked "PAIA Request — Confidential" to the registered address of SV Capital (Pty) Ltd</p>
<p>The Information Officer is registered with the Information Regulator of South Africa in accordance with POPIA s.55.</p>

<h4>3. Guide on How to Access Information</h4>
<p>The South African Human Rights Commission (SAHRC) has published a guide to assist persons who wish to access information held by private or public bodies. This guide is available on the SAHRC website at <strong>sahrc.org.za</strong>. SV Capital will, on request, provide a copy of or direct you to this guide.</p>

<h4>4. Records Available Without Submitting a PAIA Request</h4>
<p>The following records are automatically available to registered investors through the Platform without requiring a formal PAIA request:</p>
<ul>
<li>Your investor account profile and contact details;</li>
<li>Account statements and transaction history;</li>
<li>Investment certificates and confirmation documents;</li>
<li>IT3(b) interest income certificates;</li>
<li>FICA/KYC submission status and uploaded documentation (your own only);</li>
<li>Support ticket history;</li>
<li>Accepted policy documents and timestamps;</li>
<li>Platform policies (Terms of Service, Privacy Policy, POPIA Notice, Risk Disclaimer, this PAIA Manual, and the Complaints Procedure).</li>
</ul>

<h4>5. Records Available on Request (Subject to PAIA)</h4>
<p>The following categories of records may be made available on formal PAIA request, subject to the grounds for refusal set out in PAIA:</p>
<ul>
<li>Internal audit records relating to your account (where refusal grounds do not apply);</li>
<li>Communications records between you and SV Capital staff;</li>
<li>Records relating to a specific investment decision affecting your account;</li>
<li>Any other record in which you have a personal interest.</li>
</ul>
<p>Records that do not pertain to you personally, or that are subject to grounds for refusal under PAIA (including records of third parties, commercially sensitive information, and legally privileged records), will not be disclosed without the consent of the affected party or a court order.</p>

<h4>6. Grounds for Refusal</h4>
<p>In terms of PAIA, SV Capital may refuse to grant access to records on the following grounds:</p>
<ul>
<li>Records containing personal information of third parties who have not consented to disclosure;</li>
<li>Commercially sensitive information, including trade secrets, financial models, or proprietary investment strategies;</li>
<li>Legally privileged communications (attorney-client privilege);</li>
<li>Records that, if disclosed, could jeopardise a criminal investigation or legal proceedings;</li>
<li>Records whose disclosure would be contrary to any binding agreement or court order.</li>
</ul>

<h4>7. How to Submit a PAIA Request</h4>
<p>To request access to records held by SV Capital, you must:</p>
<ol>
<li>Complete Form C as prescribed by the Regulations under PAIA (available at <strong>justice.gov.za</strong>) or submit a written request containing the same information;</li>
<li>Clearly identify the record(s) you wish to access;</li>
<li>Provide a copy of your identity document;</li>
<li>State the form in which you wish to receive the record (electronic copy, printed copy, or inspection);</li>
<li>If requesting records about a third party, provide reasons and confirm you are authorised to do so;</li>
<li>Submit the request to: <strong>privacy@svcapital.co.za</strong>, marked "PAIA Request".</li>
</ol>

<h4>8. Fees</h4>
<table style="width:100%;border-collapse:collapse;font-size:0.87rem;margin-bottom:12px">
<thead><tr style="background:rgba(0,0,0,0.05)"><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Fee Type</th><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Amount</th></tr></thead>
<tbody>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Request fee (payable on submission)</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">R35.00</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Request for own personal information</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Waived</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Printed copies (A4 per page)</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">R1.10 per page</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Electronic copy (per megabyte)</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">R7.50 per MB</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Deposit (if reproduction fee exceeds R100)</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">1/3 of total fee upfront</td></tr>
</tbody>
</table>
<p>Fees are prescribed in terms of the PAIA regulations and are subject to change by the Information Regulator.</p>

<h4>9. Response Timeframes</h4>
<p>SV Capital will respond to a PAIA request within <strong>30 days</strong> of receipt of a complete request and payment of the request fee. In complex cases, this period may be extended by a further 30 days with notice to the requester. If SV Capital fails to respond within the required period, this is deemed a refusal and may be appealed to the Information Regulator.</p>

<h4>10. Internal Appeal and External Remedies</h4>
<p>If your request is refused, you may:</p>
<ul>
<li>Lodge an internal appeal in writing to the Information Officer within 60 days of the refusal, setting out the grounds of appeal;</li>
<li>Apply to the Information Regulator for a review of the refusal (at <strong>inforeg.org.za</strong>);</li>
<li>Apply to a court of competent jurisdiction for appropriate relief.</li>
</ul>

<h4>11. Date of Compilation</h4>
<p>This PAIA Manual was compiled in June 2025 and will be updated as required by law or as SV Capital's operations change. The current version is available on the Platform and will be provided free of charge upon request.</p>`,
  },
  {
    id: 'pol_complaints',
    icon: 'fa-circle-exclamation',
    color: '#ef4444',
    title: 'Complaints Procedure',
    staticContent: `<p><em>Version 1.0 &nbsp;·&nbsp; Effective June 2025</em></p>
<p>SV Capital (Pty) Ltd is committed to providing high-quality investment services and resolving all investor complaints promptly, fairly, and transparently. This procedure sets out how to lodge a complaint and what you can expect from us.</p>

<h4>1. Scope</h4>
<p>This Complaints Procedure applies to all complaints received from registered investors relating to: investment products offered on the Platform; account management and transactions; FICA/KYC processes; communications from SV Capital; data privacy and POPIA matters; and the conduct of SV Capital staff or representatives.</p>

<h4>2. What Constitutes a Complaint</h4>
<p>A complaint is any expression of dissatisfaction by an investor regarding SV Capital's products, services, conduct, or failure to act. Complaints are distinct from general queries (requests for information or assistance) and service requests (routine account actions). If in doubt, submit your concern as a complaint and SV Capital will categorise it appropriately.</p>

<h4>3. How to Lodge a Complaint</h4>
<p>You may lodge a complaint through any of the following channels:</p>
<ul>
<li><strong>In-Platform:</strong> Navigate to the Support section of this portal and submit a support ticket with category "Complaint";</li>
<li><strong>Email:</strong> Send a written complaint to <strong>complaints@svcapital.co.za</strong>;</li>
<li><strong>Compliance Officer:</strong> For escalated or serious complaints, email <strong>compliance@svcapital.co.za</strong>.</li>
</ul>
<p>When lodging a complaint, please include: your full name and investor ID; a clear description of the complaint and the events giving rise to it; the date(s) of the relevant events; any relevant reference numbers, transaction IDs, or correspondence; and the outcome or remedy you are seeking.</p>

<h4>4. Acknowledgement</h4>
<p>SV Capital will acknowledge all complaints within <strong>1 business day</strong> of receipt. The acknowledgement will confirm receipt, assign a complaint reference number, and provide the name and contact details of the person handling your complaint.</p>

<h4>5. Investigation and Resolution (Stage 1)</h4>
<p>Your complaint will be investigated by the relevant team within SV Capital. We aim to provide a full written response within <strong>5 business days</strong> of acknowledging the complaint. Where the complaint requires a more complex investigation, we will notify you of the extended timeline and provide weekly progress updates. In all cases, a final response will be provided within <strong>10 business days</strong> of acknowledgement, unless agreed otherwise with you in writing.</p>
<p>The response will set out: a summary of your complaint as understood by SV Capital; the findings of our investigation; our decision (uphold, partially uphold, or reject) and the reasons therefor; any remedial action to be taken; and information about your escalation options if you are dissatisfied.</p>

<h4>6. Escalation (Stage 2)</h4>
<p>If you are not satisfied with the Stage 1 response, you may escalate your complaint to the Compliance Officer at <strong>compliance@svcapital.co.za</strong> within <strong>30 days</strong> of receiving the Stage 1 response. Your escalation should set out: the original complaint reference number; why you are dissatisfied with the Stage 1 response; and the outcome you are seeking. The Compliance Officer will conduct an independent review and provide a final internal response within <strong>10 business days</strong>.</p>

<h4>7. External Dispute Resolution (Stage 3)</h4>
<p>If SV Capital is unable to resolve your complaint to your satisfaction through our internal process, you may refer the matter to an appropriate external body:</p>
<ul>
<li><strong>Financial Sector Conduct Authority (FSCA):</strong> For complaints relating to market conduct, FAIS, and financial services regulation. Website: <strong>fsca.co.za</strong> &nbsp;·&nbsp; Tel: 0800 110 443</li>
<li><strong>FAIS Ombud:</strong> For complaints relating to financial advice received from a financial adviser or intermediary. Website: <strong>faisombud.co.za</strong> &nbsp;·&nbsp; Tel: 012 762 5000</li>
<li><strong>Information Regulator:</strong> For complaints specifically relating to POPIA or PAIA rights. Website: <strong>inforeg.org.za</strong> &nbsp;·&nbsp; Email: complaints.IR@justice.gov.za</li>
<li><strong>National Consumer Commission (NCC):</strong> For complaints relating to consumer rights under the Consumer Protection Act. Website: <strong>thencc.org.za</strong></li>
</ul>
<p>You are not required to exhaust our internal procedure before referring a complaint to an external body, but we encourage you to do so as many matters can be resolved more efficiently through direct engagement.</p>

<h4>8. Timeframe Summary</h4>
<table style="width:100%;border-collapse:collapse;font-size:0.87rem;margin-bottom:12px">
<thead><tr style="background:rgba(0,0,0,0.05)"><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Stage</th><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Action</th><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Timeframe</th></tr></thead>
<tbody>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Receipt</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Acknowledgement issued</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">1 business day</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Stage 1</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Full written response</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">5–10 business days</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Stage 2</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Compliance Officer review</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">10 business days</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Stage 3</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">External referral</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">As per regulator</td></tr>
</tbody>
</table>

<h4>9. Record Keeping</h4>
<p>SV Capital maintains a complaints register as required by the FSCA and FAIS. All complaints are recorded with their reference number, date received, nature of complaint, response provided, and resolution outcome. This register is available for inspection by the FSCA upon request. Complaints records are retained for 5 years.</p>

<h4>10. Contact Details</h4>
<p><strong>General Support:</strong> support@svcapital.co.za<br>
<strong>Complaints:</strong> complaints@svcapital.co.za<br>
<strong>Compliance Officer:</strong> compliance@svcapital.co.za<br>
<strong>Information Officer (POPIA/PAIA):</strong> privacy@svcapital.co.za<br>
<strong>Regulator:</strong> FSCA · FSP No. 52449 · fsca.co.za</p>`,
  },
];

let _policyOpenId = null;

function renderPoliciesView() {
  const container = document.getElementById('policiesContent');
  if (!container) return;

  container.innerHTML = POLICY_SECTIONS.map(sec => `
    <div class="policy-accordion ${_policyOpenId === sec.id ? 'policy-accordion--open' : ''}" id="pacc-${sec.id}">
      <button class="policy-accordion__header" onclick="_togglePolicy('${sec.id}')">
        <div class="policy-accordion__icon" style="background:${sec.color}22;color:${sec.color}">
          <i class="fa-solid ${sec.icon}"></i>
        </div>
        <span class="policy-accordion__title">${sec.title}</span>
        <i class="fa-solid fa-chevron-down policy-accordion__chev" id="pachev-${sec.id}"
           style="${_policyOpenId === sec.id ? 'transform:rotate(180deg)' : ''}"></i>
      </button>
      <div class="policy-accordion__body" id="pabody-${sec.id}" style="display:${_policyOpenId === sec.id ? 'block' : 'none'}">
        <div class="policy-accordion__content">${sec.staticContent}</div>
      </div>
    </div>`).join('');
}

function _togglePolicy(secId) {
  _policyOpenId = _policyOpenId === secId ? null : secId;
  renderPoliciesView();
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
  // Dark mode is disabled on the native app — always force light mode and
  // clear any previously-saved dark preference.
  if (window.__SVC_NATIVE__) {
    _applyDark(false);
    return;
  }
  const saved = localStorage.getItem('svc_dark_mode');
  if (saved === 'dark') _applyDark(true);
}

function toggleDarkMode() {
  // No-op on native — dark mode is disabled there.
  if (window.__SVC_NATIVE__) return;
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
    body: 'Let us give you a quick tour of everything available to you. It takes about 2 minutes and you\'ll earn <strong>100 XP</strong> when you\'re done.',
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
    body: 'Your current investments are listed here with product type, amount, target return, and days remaining until maturity.',
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
    body: 'Explore open pools across solar, cattle, loans, and delivery bikes. Each shows its rate, term, and how much is still available.',
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
    body: 'Complete quests and surveys to earn XP and climb through 8 levels — from Seed to Luminary. Unlock badges and show off your progress.',
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
  // Tour is fully disabled on mobile (Android + iOS). Mark as done so
  // quest indicators don't show an incomplete state on first install.
  localStorage.setItem('svc_tour_done', '1');
  return;
  const inv = PORTAL.investor;
  if (!inv || (!inv.first_name && !inv.last_name && !inv.email)) return;
  // Mark as done BEFORE starting so that closing the browser tab during the
  // tour doesn't restart it on the next visit.
  localStorage.setItem('svc_tour_done', '1');
  requestAnimationFrame(() => setTimeout(startTour, 400));
}

function startTour() {
  _tourActive = true;
  _tourStep = 0;
  // Always scroll back to the top of the page before showing the tour so the
  // welcome banner (not the onboarding wizard) is at the top of the viewport.
  // On Android, WebView can restore a previous scroll position on relaunch,
  // making the top content appear to be a blank gray area.
  const pc = document.querySelector('.page-content');
  if (pc) pc.scrollTop = 0;
  document.getElementById('tourOverlay').style.display = 'block';
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

  localStorage.setItem('svc_tour_done', '1');

  if (completed) {
    const alreadyClaimed = PORTAL.quests?.completedIds?.includes('complete_tour');
    if (alreadyClaimed) {
      Toast.info('Tour complete! XP already claimed — come back any time to revisit.');
    } else {
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

  // Scroll target into view, then wait for layout to settle before positioning.
  // On mobile one rAF is not enough — the scroll hasn't completed yet, so
  // getBoundingClientRect() returns stale positions and the tooltip jumps.
  if (step.target && step.type !== 'center') {
    const el = document.querySelector(step.target);
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  }
  // Native mobile needs extra time for scroll to settle
  const scrollDelay = window.__SVC_NATIVE__ ? 350 : 80;
  setTimeout(() => _positionTour(step), scrollDelay);
}

function _positionTour(step) {
  const spotlight = document.getElementById('tourSpotlight');
  const tooltip   = document.getElementById('tourTooltip');

  const isMobile = window.innerWidth < 600 || window.__SVC_NATIVE__;

  const _centerTooltip = () => {
    spotlight.style.cssText = 'display:none';
    tooltip.style.cssText   = `
      display:flex; position:fixed;
      top:50%; left:50%; transform:translate(-50%,-50%);
      z-index:10002; max-width:440px; width:calc(100vw - 32px);`;
  };

  // On mobile always pin tooltip at bottom — avoids all jumping/positioning issues
  const _mobileTooltip = (r) => {
    const pad = 8;
    if (r) {
      spotlight.style.cssText = `
        display:block; position:fixed;
        left:${r.left - pad}px; top:${r.top - pad}px;
        width:${r.width + pad * 2}px; height:${r.height + pad * 2}px;
        border-radius:12px;
        box-shadow: 0 0 0 9999px rgba(0,0,0,0.72);
        z-index:10001; pointer-events:none;`;
    } else {
      spotlight.style.cssText = 'display:none';
    }
    const ttW = Math.min(360, window.innerWidth - 32);
    tooltip.style.cssText = `
      display:flex; position:fixed;
      bottom:90px; left:50%; transform:translateX(-50%);
      width:${ttW}px; max-width:${ttW}px;
      z-index:10002;`;
  };

  if (step.type === 'center' || !step.target) { _centerTooltip(); return; }

  const el = document.querySelector(step.target);
  if (!el) { isMobile ? _mobileTooltip(null) : _centerTooltip(); return; }

  const r  = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // If element is invisible (hidden sidebar on mobile, display:none, zero size), centre tooltip
  const isVisible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  if (!isVisible) { isMobile ? _mobileTooltip(null) : _centerTooltip(); return; }

  // Mobile: pin tooltip at bottom, spotlight on the element — no jumping
  if (isMobile) { _mobileTooltip(r); return; }

  const pad = 8;

  // Desktop spotlight with smooth transition
  spotlight.style.cssText = `
    display:block; position:fixed;
    left:${r.left - pad}px; top:${r.top - pad}px;
    width:${r.width + pad * 2}px; height:${r.height + pad * 2}px;
    border-radius:12px;
    box-shadow: 0 0 0 9999px rgba(0,0,0,0.72);
    z-index:10001; pointer-events:none;
    transition: left 0.3s ease, top 0.3s ease, width 0.3s ease, height 0.3s ease;`;

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
    const m = document.getElementById('depositPromptModal');
    if (m) { m.style.display = 'flex'; m.classList.add('open'); }
  }, 2500);
}

function dismissDepositPrompt(never) {
  const m = document.getElementById('depositPromptModal');
  if (m) { m.style.display = 'none'; m.classList.remove('open'); }
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
    color: '#656565',          bg: 'linear-gradient(135deg,#1a3d42 0%,#656565 100%)',
    tagline: 'Invest through your registered company',
    ficaDocs: ['Company Registration Certificate (COR14.3 / COR15.1A)', 'Company Tax Clearance Certificate', 'CIPC CoR39 or similar', 'Authorised signatory ID (copy)'],
  },
  trust:    {
    icon: 'fa-scale-balanced',  label: 'Trust',
    color: '#7c5cfc',           bg: 'linear-gradient(135deg,#2d1d6e 0%,#7c5cfc 100%)',
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
    { emoji: '🔮', title: 'The Power of Compounding Returns', body: 'When your returns are reinvested, those returns also generate returns. It\'s money multiplying itself!' },
    { emoji: '📊', title: 'Rule of 72', body: 'Divide 72 by your annual return rate to see how many years to double your money. At 14%: 72 ÷ 14 = just over 5 years!' },
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
    const myId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
    const res = await API._fetch('GET', 'tables/sub_accounts', null, { parent_investor_id: myId, limit: 200 });
    const all = res.data || (Array.isArray(res) ? res : []);
    PORTAL.subAccounts = all.filter(a => a.parent_investor_id === myId || a.investor_id === myId);
  } catch (e) {
    console.warn('loadSubAccounts:', e);
    PORTAL.subAccounts = [];
  }
  renderSubAccountsView();
  const badge = document.getElementById('subacctsBadge');
  if (badge) {
    badge.textContent = PORTAL.subAccounts.length || '';
    badge.style.display = PORTAL.subAccounts.length ? '' : 'none';
    _saveNavBadgeCache('subaccounts', PORTAL.subAccounts.length);
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

  if (isMinor) {
    document.getElementById('saDetailBody').innerHTML = _saMinorHub(sa);
    _saInitTipCarousel(sa);
  } else {
    document.getElementById('saDetailBody').innerHTML = _saNormalDetail(sa, meta);
  }

  Modal.open('saDetailModal');
}

function _saNormalDetail(sa, meta) {
  const balance  = parseFloat(sa.wallet_balance)  || 0;
  const invested = parseFloat(sa.total_invested)   || 0;
  const returns  = parseFloat(sa.total_returns)    || 0;

  const kycStatus = sa.kyc_status || 'missing';
  const kycMeta = {
    approved:     { label: 'FICA Verified',    icon: 'fa-circle-check',        color: '#22c55e', bg: 'rgba(34,197,94,0.15)',  border: 'rgba(34,197,94,0.3)' },
    under_review: { label: 'Under Review',     icon: 'fa-clock',               color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.3)' },
    missing:      { label: 'FICA Required',    icon: 'fa-triangle-exclamation', color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.25)' },
  }[kycStatus] || { label: kycStatus, icon: 'fa-circle-info', color: '#9ca3af', bg: 'rgba(156,163,175,0.1)', border: 'rgba(156,163,175,0.2)' };

  const ficaDocs = SA_TYPE_META[sa.account_type]?.ficaDocs || [];

  const recentTxns = (PORTAL.transactions || [])
    .filter(t => t.sub_account_id === sa.id)
    .slice(0, 5);

  const txnTypeIcon = t => ({
    deposit: 'fa-download', investment: 'fa-chart-line',
    withdrawal: 'fa-upload', return: 'fa-coins',
  }[t.type] || 'fa-circle-dot');

  return `
    <!-- ── Hero banner ── -->
    <div class="sad-hero" style="background:${meta.bg}">
      <button class="sad-close-btn" onclick="Modal.close('saDetailModal')"><i class="fa-solid fa-xmark"></i></button>
      <div class="sad-hero__type">
        <div class="sad-hero__icon"><i class="fa-solid ${meta.icon}"></i></div>
        <span class="sad-hero__type-label">${meta.label} Account</span>
      </div>
      <div class="sad-hero__name">${_esc(sa.name)}</div>
      <div class="sad-kyc-chip" style="background:${kycMeta.bg};color:${kycMeta.color};border:1px solid ${kycMeta.border}">
        <i class="fa-solid ${kycMeta.icon}"></i> ${kycMeta.label}
      </div>
      <div class="sad-stats-row">
        <div class="sad-stat">
          <div class="sad-stat__label">Wallet</div>
          <div class="sad-stat__value">${Utils.rand(balance)}</div>
        </div>
        <div class="sad-stat-divider"></div>
        <div class="sad-stat">
          <div class="sad-stat__label">Invested</div>
          <div class="sad-stat__value">${Utils.rand(invested)}</div>
        </div>
        <div class="sad-stat-divider"></div>
        <div class="sad-stat">
          <div class="sad-stat__label">Returns</div>
          <div class="sad-stat__value" style="color:#4ade80">${Utils.rand(returns)}</div>
        </div>
      </div>
    </div>

    <!-- ── Action buttons ── -->
    <div class="sad-actions">
      <button class="sad-action-btn sad-action-btn--primary" onclick="Modal.close('saDetailModal');openSaDeposit('${sa.id}')">
        <i class="fa-solid fa-wallet"></i><span>Deposit</span>
      </button>
      <button class="sad-action-btn sad-action-btn--secondary" onclick="Modal.close('saDetailModal');openSaInvest('${sa.id}')" ${kycStatus !== 'approved' ? 'disabled' : ''}>
        <i class="fa-solid fa-chart-line"></i><span>Invest</span>
      </button>
    </div>

    ${kycStatus !== 'approved' ? `
    <!-- ── FICA section ── -->
    <div class="sad-section">
      <div class="sad-section__header">
        <i class="fa-solid fa-id-card" style="color:${meta.color}"></i>
        <span>Documents Required</span>
      </div>
      <div class="sad-fica-list">
        ${ficaDocs.map((d, i) => `
          <div class="sad-fica-item" style="animation-delay:${i * 60}ms">
            <div class="sad-fica-item__num" style="background:${meta.color}22;color:${meta.color}">${i + 1}</div>
            <span>${d}</span>
          </div>`).join('')}
      </div>
      <button class="sad-upload-btn" onclick="openSaFicaUpload('${sa.id}')">
        <i class="fa-solid fa-cloud-arrow-up"></i> Upload FICA Documents
      </button>
    </div>` : ''}

    ${recentTxns.length ? `
    <!-- ── Recent activity ── -->
    <div class="sad-section">
      <div class="sad-section__header">
        <i class="fa-solid fa-clock-rotate-left" style="color:${meta.color}"></i>
        <span>Recent Activity</span>
      </div>
      <div class="sad-txn-list">
        ${recentTxns.map(t => `
          <div class="sad-txn">
            <div class="sad-txn__icon" style="background:${t.amount > 0 ? 'rgba(74,222,128,0.12)' : 'rgba(239,68,68,0.1)'}">
              <i class="fa-solid ${txnTypeIcon(t)}" style="color:${t.amount > 0 ? '#4ade80' : '#ef4444'}"></i>
            </div>
            <div class="sad-txn__info">
              <div class="sad-txn__type">${(t.type || 'transaction').replace(/_/g,' ')}</div>
              <div class="sad-txn__date">${Utils.date(t.created_at)}</div>
            </div>
            <div class="sad-txn__amount" style="color:${t.amount > 0 ? '#4ade80' : '#ef4444'}">${t.amount > 0 ? '+' : ''}${Utils.rand(t.amount)}</div>
          </div>`).join('')}
      </div>
    </div>` : ''}

    <div style="height:32px"></div>`;
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

  _pmSaId = saId;  // tag all investments made after this to the sub-account
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
    Toast.success('FICA document submitted! The admin team will review it within 1-2 business days.');
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
  const proofEl = document.getElementById('bdProofFile');
  if (proofEl) proofEl.value = '';
  Modal.open('bankDetailsModal');
}

async function saveBankDetails() {
  const bank_name            = document.getElementById('bdBankName').value.trim();
  const bank_account_type    = document.getElementById('bdAccountType').value;
  const bank_account_holder  = document.getElementById('bdAccountHolder').value.trim();
  const bank_account_number  = document.getElementById('bdAccountNumber').value.trim();
  const bank_branch_code     = document.getElementById('bdBranchCode').value.trim();
  const proofFile            = document.getElementById('bdProofFile')?.files?.[0] || null;

  if (!bank_name || !bank_account_holder || !bank_account_number || !bank_branch_code) {
    Toast.error('Please fill in all required fields'); return;
  }
  if (!proofFile) {
    Toast.error('Please attach a proof of bank account'); return;
  }

  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  const investorName = `${PORTAL.investor?.first_name || ''} ${PORTAL.investor?.last_name || ''}`.trim();
  try {
    // Read the proof of bank file as a base64 data URL so admin can view & approve it
    const proofData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(proofFile);
    });

    const bankPatch = {
      bank_name,
      bank_account_holder,
      bank_account_number,
      bank_branch_code,
      bank_account_type,
      bank_account_status: 'pending',
      bank_account_notes: null,
    };
    // Submitting bank proof puts FICA back into "in progress" unless already verified
    if (PORTAL.investor && PORTAL.investor.kyc_status !== 'approved' && PORTAL.investor.fica_status !== 'approved') {
      bankPatch.kyc_status = 'in_progress';
      bankPatch.fica_status = 'in_progress';
    }
    const updated = await API._fetch('PATCH', `tables/investors/${investorId}`, bankPatch);
    if (PORTAL.investor) Object.assign(PORTAL.investor, updated);

    // Submit the proof of bank as a KYC document for admin review.
    // Once approved (with ID + Proof of Address), the investor becomes FICA-verified.
    await API.kyc.create({
      investor_id:   investorId,
      investor_name: investorName || undefined,
      doc_type:      'proof_of_bank',
      status:        'pending',
      file_name:     proofFile.name,
      file_data:     proofData,
      notes:         `Proof of bank account for ${bank_name} — submitted with banking details.`,
    }).catch(e => console.warn('[bank details] proof upload failed:', e.message));

    // Create support ticket so admin can see and verify the bank details
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

  if (!_isInvestorFicaApproved(inv)) {
    content.innerHTML = `
      <div style="text-align:center;padding:20px 0">
        <i class="fa-solid fa-shield-halved" style="font-size:2.5rem;color:#656565;margin-bottom:16px"></i>
        <p style="font-size:0.9rem;font-weight:700;color:#1a1a1a;margin-bottom:8px">FICA verification required</p>
        <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:16px">You need to complete FICA/KYC verification before you can withdraw funds. You can still top up your wallet and invest in the meantime.</p>
        <button class="btn btn--primary" onclick="Modal.close('withdrawalModal');navigate('profile', document.querySelector('[data-view=profile]'));openKycUploadModal()"><i class="fa-solid fa-upload"></i> Complete FICA/KYC</button>
      </div>`;
    footer.style.display = 'none';
    Modal.open('withdrawalModal');
    return;
  }

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

  // Total returns = returns + payouts in the tax year
  const interestTxns = (PORTAL.transactions || []).filter(t => {
    if (!['return', 'payout'].includes(t.type)) return false;
    const d = new Date(t.created_at || t.transaction_date || 0);
    return d >= from && d <= to;
  });
  const totalInterest = interestTxns.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);

  const certNumber = `SVCIT-${taxYear}-${String(inv.id).replace(/\D/g,'').slice(-6) || Math.floor(Math.random()*900000+100000)}`;
  const generatedAt = new Date().toLocaleString('en-ZA', { dateStyle: 'long', timeStyle: 'short' });
  const fromLabel = from.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  const toLabel   = to.toLocaleDateString('en-ZA',   { day: 'numeric', month: 'long', year: 'numeric' });

  const html = `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Poppins',sans-serif;background:#fff;color:#111;-webkit-print-color-adjust:exact;print-color-adjust:exact}
@page{size:A4;margin:20mm}
@media print{.no-print{display:none!important}}
.no-print{position:fixed;top:0;left:0;right:0;background:#303030;padding:10px 24px;display:flex;justify-content:space-between;align-items:center;z-index:99}
.no-print span{color:#fff;font-size:13px;font-weight:600}
.no-print button{background:#FF9B0C;color:#fff;border:none;padding:8px 20px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer}
.wrap{max-width:700px;margin:60px auto 32px;padding:40px}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;padding-bottom:20px;border-bottom:3px solid #303030}
.logo img{height:48px;max-width:220px;object-fit:contain;display:block}
.cert-badge{background:#303030;color:#fff;padding:8px 16px;border-radius:6px;font-size:0.75rem;font-weight:700;text-align:right}
.cert-badge small{display:block;color:#9ca3af;font-size:0.65rem;font-weight:400}
h1{font-size:1.25rem;font-weight:800;color:#303030;margin:0 0 4px}
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
.stamp{display:inline-block;border:2px solid #303030;color:#303030;padding:6px 14px;border-radius:4px;font-size:0.72rem;font-weight:700;letter-spacing:0.12em;margin-top:16px;text-transform:uppercase}
</style></head><body>
<div class="no-print">
  <span>SV Capital — IT3(b) Tax Certificate ${taxYear}</span>
  <button onclick="window.print()">⬇ Save as PDF / Print</button>
</div>
<div class="wrap">
  <div class="hdr">
    <div>
      <div class="logo"><img src="${window.location.origin}/assets/full-colour-logo-horizontal-white-text.png" alt="SV Capital"></div>
      <div style="font-size:0.75rem;color:#6b7280;margin-top:6px">SV Capital (Pty) Ltd &nbsp;·&nbsp; FSCA Regulated</div>
    </div>
    <div class="cert-badge">
      IT3(b) INTEREST INCOME CERTIFICATE
      <small>Cert No: ${certNumber}</small>
      <small>Generated: ${generatedAt}</small>
    </div>
  </div>

  <h1>IT3(b) Interest Income Certificate</h1>
  <div class="subtitle">Tax Year: 1 March ${taxYear - 1} – 28 February ${taxYear} &nbsp;|&nbsp; For submission to SARS</div>

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
  ` : `<div style="text-align:center;padding:24px;background:#f8fafc;border-radius:10px;color:#6b7280;font-size:0.85rem;margin-bottom:24px">No returns recorded for this tax year.</div>`}

  <div class="footer">
    <strong>SV Capital (Pty) Ltd</strong> is a registered financial services provider regulated by the Financial Sector Conduct Authority (FSCA).<br>
    This certificate is generated in accordance with Section 11(j) of the Income Tax Act No. 58 of 1962.<br>
    Interest declared above must be included in your annual tax return (ITR12) under "Local interest income".<br>
    The IT3(b) exemption threshold for individuals under 65 is <strong>R23,800</strong> per annum (2024 tax year).
    <br><br>
    <strong>Certificate No:</strong> ${certNumber} &nbsp;·&nbsp; <strong>Date Issued:</strong> ${generatedAt}<br>
    This certificate is computer generated and does not require a signature.
    <br>
    <div class="stamp">SV Capital — IT3(b)</div>
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
    <i class="fa-solid fa-shield-halved" style="font-size:2rem;color:var(--green)"></i>
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
      label: 'Complete your FICA verification',
      desc: 'Submit your ID document and proof of address.',
      done: inv.fica_status === 'approved',
      action: "navigate('profile', document.querySelector('[data-view=profile]'))",
      actionLabel: 'Go to KYC',
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

function openInvestNowPicker() {
  const body = document.getElementById('investNowPickerBody');
  if (!body) return;

  // Build product list: use live _mktProducts if loaded, else derive from pools
  const products = (_mktProducts && _mktProducts.length)
    ? _mktProducts
    : [...new Set((PORTAL.pools || []).map(p => p.product_type))].map(t => ({ product_type: t }));

  // Count open pools per product
  const openCounts = {};
  (PORTAL.pools || []).forEach(p => {
    if (p.status === 'open') openCounts[p.product_type] = (openCounts[p.product_type] || 0) + 1;
  });

  body.innerHTML = products.map(prod => {
    const pi = Utils.productInfo(prod.product_type);
    const meta = _POOL_META[prod.product_type] || {};
    const open = openCounts[prod.product_type] || 0;
    return `
      <div onclick="selectInvestNowProduct('${_esc(prod.product_type)}')" style="display:flex;align-items:center;gap:14px;padding:14px;border:1.5px solid rgba(0,0,0,0.07);border-radius:14px;cursor:pointer;background:#fff;transition:border-color 0.15s" onmousedown="this.style.borderColor='#ff9b0c'" onmouseup="this.style.borderColor='rgba(0,0,0,0.07)'" ontouchstart="this.style.borderColor='#ff9b0c'" ontouchend="this.style.borderColor='rgba(0,0,0,0.07)'">
        <div style="width:46px;height:46px;border-radius:12px;background:${pi.color}1a;color:${pi.color};display:flex;align-items:center;justify-content:center;font-size:1.3rem;flex-shrink:0">
          <i class="fa-solid ${pi.icon}"></i>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:0.92rem;font-weight:800;color:#303030">${prod.label || pi.label}</div>
          ${meta.blurb ? `<div style="font-size:0.75rem;color:#656565;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${meta.blurb}</div>` : ''}
          <div style="font-size:0.72rem;margin-top:4px;font-weight:600;${open ? 'color:#65ed00' : 'color:#656565'}">
            <i class="fa-solid ${open ? 'fa-circle-check' : 'fa-clock'}" style="font-size:0.65rem"></i>
            ${open ? `${open} open pool${open !== 1 ? 's' : ''}` : 'No open pools currently'}
          </div>
        </div>
        <i class="fa-solid fa-chevron-right" style="color:#656565;font-size:0.8rem;flex-shrink:0"></i>
      </div>`;
  }).join('');

  Modal.open('investNowPickerModal');
}

function selectInvestNowProduct(type) {
  Modal.close('investNowPickerModal');
  navigate('marketplace', document.querySelector('[data-view=marketplace]'));
  setTimeout(() => openProductDetail(type), 200);
}

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
  if (termEl) termEl.value = '12';
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
    const ctaBar = document.getElementById('calcCTABar');
    if (ctaBar) ctaBar.style.display = 'none';
    return;
  }
  _calcPoolId = opt.value;
  const rateEl = document.getElementById('calcRate');
  const termEl = document.getElementById('calcTerm');
  if (rateEl) rateEl.value = Math.round((parseFloat(opt.dataset.rate || 0.14) * 100) * 10) / 10;
  // Set term select to closest available option
  if (termEl) {
    const poolTerm = parseInt(opt.dataset.term || 12);
    const opts = [...termEl.options];
    let closest = opts.reduce((prev, cur) => Math.abs(parseInt(cur.value) - poolTerm) < Math.abs(parseInt(prev.value) - poolTerm) ? cur : prev);
    if (closest) closest.selected = true;
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

  // Visual capital vs returns bar
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
    body.innerHTML = `<div class="ref-empty">
      <i class="fa-solid fa-user-plus"></i>
      <div>No referrals yet — share your code to get started.</div>
    </div>`;
    return;
  }
  body.innerHTML = referred.map(r => {
    const bonusTx = (PORTAL.transactions || []).find(t =>
      t.type === 'referral_bonus' &&
      (t.referred_investor_id === r.id || Math.abs(new Date(t.created_at) - new Date(r.date_joined||r.created_at)) < 86400000 * 7)
    );
    const name = `${_esc(r.first_name || '')} ${_esc(r.last_name || '')}`.trim() || 'Investor';
    const initials = name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
    const hasInvested = (r.total_invested || 0) > 0;
    const bonusChip = bonusTx
      ? `<span class="ref-person__bonus ref-person__bonus--paid">+${Utils.rand(bonusTx.amount || 0)}</span>`
      : `<span class="ref-person__bonus ref-person__bonus--pending">Pending</span>`;
    return `
    <div class="ref-person">
      <div class="ref-person__avatar">${initials}</div>
      <div class="ref-person__info">
        <div class="ref-person__name">${name}</div>
        <div class="ref-person__meta">
          <span class="ref-person__dot ${hasInvested ? 'ref-person__dot--green' : 'ref-person__dot--amber'}"></span>
          ${hasInvested ? 'Invested' : 'Not invested yet'} · ${Utils.date(r.date_joined)}
        </div>
      </div>
      ${bonusChip}
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════
   FEATURE 7: DOCUMENT VAULT
   ═══════════════════════════════════════════════ */

/* ─── KYC Document Upload ─────────────────────────────────────── */
let _kycFile = null;

function _kycFileSelected(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { Toast.error('File too large — maximum 10 MB. Please compress the image and try again.'); return; }
  _kycFile = file;
  const statusEl = document.getElementById('kycFileStatus');
  const nameEl   = document.getElementById('kycFileName');
  if (statusEl) statusEl.style.display = 'flex';
  if (nameEl)   nameEl.textContent = file.name;
  const zone = document.getElementById('kycDropZone');
  if (zone) { zone.style.borderColor = '#22c55e'; zone.style.background = 'rgba(34,197,94,0.04)'; }
  // After iOS file picker closes, blur any focused element (prevents zoom) and
  // scroll modal body to keep Submit button in view.
  setTimeout(() => {
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    const modalBody = document.querySelector('#kycUploadModal .modal__body');
    if (modalBody) modalBody.scrollTop = modalBody.scrollHeight;
  }, 150);
}

function _kycHandleDrop(event) {
  event.preventDefault();
  const zone = document.getElementById('kycDropZone');
  if (zone) zone.style.borderColor = 'rgba(255,155,12,0.35)';
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    const inp = document.getElementById('kycFileInput');
    if (inp) inp.value = '';
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
    // Reflect that documents are now being checked (unless already fully verified)
    if (inv && inv.kyc_status !== 'approved' && inv.fica_status !== 'approved') {
      await API._fetch('PATCH', `tables/investors/${inv.id}`, { kyc_status: 'in_progress', fica_status: 'in_progress' }).catch(() => {});
      Object.assign(inv, { kyc_status: 'in_progress', fica_status: 'in_progress' });
    }
    Toast.success('Document submitted! The compliance team will review it within 1–2 business days.');
    SVC.track('svc_kyc_uploaded', { doc_type: docType });
    Modal.close('kycUploadModal');
    // Refresh KYC panels with fresh data (Bug #7)
    _refreshKycPanels();
  } catch (e) {
    const msg = e?.message || '';
    if (e?.status === 413 || msg.includes('too large') || msg.includes('entity') || msg.includes('limit')) {
      Toast.error('File too large for upload. Please compress the image or use a smaller file (max 10 MB).');
    } else {
      Toast.error('Upload failed — please try again');
    }
    console.error('[submitKycDocument]', e);
  } finally {
    _kycFile = null;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit for Review'; }
  }
}

async function _refreshKycPanels() {
  if (!PORTAL.investor) return;
  let docs = [];
  try {
    const res = await API.kyc.list({ investor_id: PORTAL.investor.id, limit: 20 });
    docs = res.data || [];
    PORTAL._kycDocs = docs;
  } catch (_) {}
  _renderKycStatusPanel(docs);
  _renderKycDocsList(docs);
}

async function _renderKycStatusPanel(preloadedDocs) {
  const body = document.getElementById('kycStatusBody');
  if (!body || !PORTAL.investor) return;

  let docs = preloadedDocs;
  if (!docs) {
    try {
      const res = await API.kyc.list({ investor_id: PORTAL.investor.id, limit: 20 });
      docs = res.data || [];
    } catch (_) { docs = []; }
  }

  const inv = PORTAL.investor;
  const overallStatus = inv.fica_status || inv.kyc_status || 'pending';
  const statusColor = { approved: '#22c55e', rejected: '#ef4444', pending: '#f59e0b', in_progress: '#656565', submitted: '#656565', not_started: '#9ca3af' };
  const color = statusColor[overallStatus] || '#9ca3af';

  const typeLabel = {
    id_document: 'SA ID / Passport', proof_of_address: 'Proof of Address',
    proof_of_bank: 'Proof of Bank Account',
    selfie: 'Selfie / Liveness', tax_certificate: 'Tax Certificate', other: 'Other Document',
  };

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid rgba(0,0,0,0.07);margin-bottom:12px">
      <div style="width:40px;height:40px;border-radius:50%;background:${color}22;display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <i class="fa-solid fa-${overallStatus === 'approved' ? 'shield-halved' : overallStatus === 'rejected' ? 'circle-xmark' : 'clock'}" style="color:${color};font-size:1.1rem"></i>
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
              <div style="font-size:0.82rem;font-weight:600;color:#1a1a1a">${typeLabel[d.doc_type] || _esc(d.doc_type)}</div>
              <div style="font-size:0.72rem;color:#9ca3af">${_esc(d.file_name) || '—'} · ${Utils.date(d.created_at)}</div>
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

async function _renderKycDocsList(preloadedDocs) {
  const list = document.getElementById('kycDocsList');
  if (!list || !PORTAL.investor) return;

  let docs = preloadedDocs;
  if (!docs) {
    try {
      const res = await API.kyc.list({ investor_id: PORTAL.investor.id, limit: 20 });
      docs = res.data || [];
    } catch (_) { docs = []; }
  }
  PORTAL._kycDocs = docs;

  const inv = PORTAL.investor;
  const overallStatus = inv.fica_status || inv.kyc_status || 'pending';
  const typeLabel = {
    id_document: 'SA ID / Passport', proof_of_address: 'Proof of Address',
    proof_of_bank: 'Proof of Bank Account',
    selfie: 'Selfie / Liveness', tax_certificate: 'Tax Certificate', other: 'Other',
  };
  const requiredTypes = ['id_document', 'proof_of_address', 'proof_of_bank'];
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
              <td class="td-strong">${typeLabel[d.doc_type] || _esc(d.doc_type)}</td>
              <td class="td-muted" style="font-size:0.78rem">${_esc(d.file_name) || '—'}</td>
              <td class="td-muted">${Utils.date(d.created_at)}</td>
              <td>${Utils.statusBadge(d.status)}</td>
              <td class="td-muted" style="font-size:0.72rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(d.notes) || '—'}</td>
              <td>${
                d.file_url
                  ? `<a href="${_safeUrl(d.file_url)}" target="_blank" rel="noopener" class="btn btn--secondary btn--sm"><i class="fa-solid fa-download"></i> View</a>`
                  : d.file_data
                    ? `<button class="btn btn--secondary btn--sm" onclick="_viewKycDoc('${d.id}')"><i class="fa-solid fa-eye"></i> View</button>`
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
  const kycDoc = (PORTAL._kycDocs || []).find(d => d.id === docId);
  if (!kycDoc) { Toast.error('Document not found'); return; }
  const rawData = kycDoc.file_data || kycDoc.file_url || '';
  if (!rawData) { Toast.error('No file data available for this document'); return; }

  const fileName = kycDoc.file_name || 'document';
  const mime = rawData.startsWith('data:')
    ? (rawData.match(/^data:(.*?);/) || [])[1] || ''
    : '';
  const isImage = /image\//i.test(mime) || /\.(png|jpg|jpeg|gif|webp)$/i.test(fileName);
  const isPdf   = /pdf/i.test(mime)   || /\.pdf$/i.test(fileName);

  // Build blob URL so both images and PDFs can be embedded without popup
  let viewSrc = rawData;
  let blobUrl  = null;
  if (rawData.startsWith('data:')) {
    try {
      const [header, b64] = rawData.split(',');
      const mimeType = header.match(/:(.*?);/)?.[1] || 'application/octet-stream';
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const blob  = new Blob([bytes], { type: mimeType });
      blobUrl  = URL.createObjectURL(blob);
      viewSrc  = blobUrl;
    } catch (_) { /* fall back to raw data URI */ }
  }

  // Singleton guard — close any existing overlay before opening a new one (Bug #11)
  document.getElementById('_kycOverlay')?.remove();

  // Overlay container
  const overlay = document.createElement('div');
  overlay.id = '_kycOverlay';
  overlay.style.cssText = [
    'position:fixed','inset:0','z-index:99999',
    'background:rgba(0,0,0,0.82)',
    'display:flex','flex-direction:column',
    'align-items:center','justify-content:flex-start',
  ].join(';');

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.style.cssText = [
    'width:100%','max-width:960px',
    'display:flex','align-items:center','justify-content:space-between',
    'padding:10px 16px','box-sizing:border-box',
    'background:#1a1a1a','flex-shrink:0',
  ].join(';');
  toolbar.innerHTML = `
    <span id="_kycDocTitle" style="color:#e5e7eb;font-size:0.85rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%"></span>
    <span style="display:flex;gap:10px">
      <button id="_kycDownBtn" style="background:#ff9b0c;color:#000;border:none;border-radius:6px;padding:6px 14px;font-size:0.8rem;font-weight:600;cursor:pointer">Download</button>
      <button id="_kycCloseBtn" style="background:#374151;color:#f3f4f6;border:none;border-radius:6px;padding:6px 14px;font-size:0.8rem;font-weight:600;cursor:pointer">Close ✕</button>
    </span>
  `;
  toolbar.querySelector('#_kycDocTitle').textContent = fileName;

  // Content area
  const content = document.createElement('div');
  content.style.cssText = [
    'flex:1','width:100%','max-width:960px',
    'overflow:auto','display:flex',
    'align-items:center','justify-content:center',
    'padding:12px','box-sizing:border-box',
  ].join(';');

  if (isImage) {
    const img = document.createElement('img');
    img.src = viewSrc;
    img.style.cssText = 'max-width:100%;max-height:calc(100vh - 80px);object-fit:contain;border-radius:4px';
    img.onerror = () => { img.alt = 'Image could not be loaded'; };
    content.appendChild(img);
  } else if (isPdf) {
    const iframe = document.createElement('iframe');
    iframe.src = viewSrc;
    iframe.style.cssText = 'width:100%;height:calc(100vh - 80px);border:none;border-radius:4px;background:#fff';
    content.appendChild(iframe);
  } else {
    content.innerHTML = `<div style="color:#e5e7eb;text-align:center;padding:32px">
      <i class="fa-solid fa-file" style="font-size:3rem;display:block;margin-bottom:12px;opacity:0.5"></i>
      <p style="margin:0 0 16px">Preview not available for this file type.</p>
      <button id="_kycDlOnly" style="background:#ff9b0c;color:#000;border:none;border-radius:6px;padding:8px 20px;font-size:0.85rem;font-weight:600;cursor:pointer">Download File</button>
    </div>`;
  }

  overlay.appendChild(toolbar);
  overlay.appendChild(content);
  document.body.appendChild(overlay);

  const _cleanup = () => {
    overlay.remove();
    if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  };
  const _download = () => {
    const a = document.createElement('a');
    a.href = blobUrl || rawData;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  overlay.querySelector('#_kycCloseBtn').addEventListener('click', _cleanup);
  overlay.querySelector('#_kycDownBtn').addEventListener('click', _download);
  const dlOnly = overlay.querySelector('#_kycDlOnly');
  if (dlOnly) dlOnly.addEventListener('click', _download);
  overlay.addEventListener('click', e => { if (e.target === overlay) _cleanup(); });
}

/* ═══════════════════════════════════════════════════════
   GIFT FEATURE
═══════════════════════════════════════════════════════ */
let _giftEmailDebounce = null;
let _giftSentCache = [];
let _giftReceivedCache = [];

async function loadGiftsView() {
  const inv = PORTAL.investor;
  const balHint = document.getElementById('giftBalanceHint');
  if (balHint && inv) balHint.textContent = `Your wallet balance: ${Utils.rand(inv.wallet_balance || 0)}`;
  const fromEl = document.getElementById('previewFrom');
  if (fromEl && inv) fromEl.textContent = `From: ${inv.first_name} ${inv.last_name}`;
  updateGiftPreview();
  await Promise.all([_loadSentGifts(), _loadReceivedGifts()]);
}

function setGiftAmount(amount) {
  document.getElementById('giftAmount').value = amount;
  document.querySelectorAll('.gift-preset').forEach(b => {
    b.classList.toggle('active', parseInt(b.textContent.replace(/\D/g,'')) === amount);
  });
  updateGiftPreview();
}

function updateGiftPreview() {
  const amt = parseFloat(document.getElementById('giftAmount')?.value) || 0;
  const to  = document.getElementById('giftRecipientName')?.value?.trim()
            || document.getElementById('giftRecipientEmail')?.value?.trim()?.split('@')[0]
            || '—';
  const msg = document.getElementById('giftMessage')?.value?.trim() || '';
  const inv = PORTAL.investor;

  const amtEl = document.getElementById('previewAmount');
  const toEl  = document.getElementById('previewTo');
  const msgEl = document.getElementById('previewMessage');
  if (amtEl) amtEl.textContent = amt > 0 ? Utils.rand(amt) : 'R—';
  if (toEl)  toEl.textContent  = `To: ${to}`;
  if (msgEl) msgEl.textContent = msg ? `"${msg}"` : '';
  if (document.getElementById('previewFrom') && inv) {
    document.getElementById('previewFrom').textContent = `From: ${inv.first_name} ${inv.last_name}`;
  }
}

function onGiftEmailInput() {
  clearTimeout(_giftEmailDebounce);
  updateGiftPreview();
  const email = document.getElementById('giftRecipientEmail')?.value?.trim();
  const statusEl = document.getElementById('giftRecipientStatus');
  if (!statusEl) return;
  if (!email || !email.includes('@')) { statusEl.textContent = ''; return; }
  statusEl.textContent = '…';
  statusEl.style.color = 'var(--text-muted)';
  _giftEmailDebounce = setTimeout(async () => {
    try {
      const res = await API._fetch('GET', `gifts/check-recipient?email=${encodeURIComponent(email)}`);
      if (res.exists) {
        statusEl.textContent = `✓ ${res.name} is on SV Capital`;
        statusEl.style.color = '#22c55e';
        if (!document.getElementById('giftRecipientName').value) {
          document.getElementById('giftRecipientName').value = res.name;
          updateGiftPreview();
        }
      } else {
        statusEl.textContent = '✉ Will receive an invite email';
        statusEl.style.color = '#ff9b0c';
      }
    } catch (_) { statusEl.textContent = ''; }
  }, 500);
}

async function sendGift() {
  const btn   = document.getElementById('giftSendBtn');
  const email = document.getElementById('giftRecipientEmail')?.value?.trim();
  const name  = document.getElementById('giftRecipientName')?.value?.trim();
  const amount= parseFloat(document.getElementById('giftAmount')?.value);
  const msg   = document.getElementById('giftMessage')?.value?.trim();

  if (!email || !email.includes('@')) { Toast.error('Please enter a valid recipient email'); return; }
  if (!amount || amount < 50) { Toast.error('Minimum gift amount is R50'); return; }

  const inv = PORTAL.investor;
  const walletBal = parseFloat(inv?.wallet_balance) || 0;
  if (walletBal < amount) {
    Toast.error(`Insufficient balance — you have ${Utils.rand(walletBal)} available in your wallet`); return;
  }

  await _withBtn(btn, async () => {
    try {
      const res = await API._fetch('POST', 'gifts/send', { recipientEmail: email, recipientName: name, amount, message: msg });
      if (res.success) {
        Toast.success(res.recipientExists
          ? `🎁 Gift sent! The funds have been added to their wallet.`
          : `🎁 Gift sent! ${email} will receive an invitation to claim it.`);
        // Reset form
        document.getElementById('giftAmount').value = '';
        document.getElementById('giftRecipientEmail').value = '';
        document.getElementById('giftRecipientName').value = '';
        document.getElementById('giftMessage').value = '';
        document.getElementById('giftCharCount').textContent = '0/280';
        document.getElementById('giftRecipientStatus').textContent = '';
        document.querySelectorAll('.gift-preset').forEach(b => b.classList.remove('active'));
        updateGiftPreview();
        // Update local wallet balance immediately
        if (inv) { inv.wallet_balance = Math.max(0, (parseFloat(inv.wallet_balance)||0) - amount); }
        const balHint = document.getElementById('giftBalanceHint');
        if (balHint && inv) balHint.textContent = `Your wallet balance: ${Utils.rand(inv.wallet_balance)}`;
        // Refresh gift history and reload transactions in background
        _launchGiftConfetti();
        await _loadSentGifts();
        loadPortalData().then(() => { renderOverviewTxns(); renderWallet(); }).catch(() => {});
      }
    } catch (e) {
      Toast.error('Failed to send gift: ' + (e.message || 'unknown error'));
    }
  });
}

async function _loadSentGifts() {
  try {
    const res = await API._fetch('GET', 'gifts/my');
    _giftSentCache = res.data || [];
    _renderGiftHistory('sent');
  } catch (_) {}
}

async function _loadReceivedGifts() {
  try {
    const res = await API._fetch('GET', 'gifts/received');
    _giftReceivedCache = res.data || [];
    _renderGiftHistory('received');
  } catch (_) {}
}

function switchGiftTab(tab) {
  document.getElementById('giftTabSent').classList.toggle('active', tab === 'sent');
  document.getElementById('giftTabReceived').classList.toggle('active', tab === 'received');
  document.getElementById('giftHistorySent').style.display     = tab === 'sent'     ? '' : 'none';
  document.getElementById('giftHistoryReceived').style.display = tab === 'received' ? '' : 'none';
}

function _renderGiftHistory(type) {
  const isSent = type === 'sent';
  const data   = isSent ? _giftSentCache : _giftReceivedCache;
  const listEl = document.getElementById(isSent ? 'giftSentList' : 'giftReceivedList');
  const emptyEl= document.getElementById(isSent ? 'giftSentEmpty' : 'giftReceivedEmpty');
  if (!listEl) return;

  if (!data.length) {
    if (emptyEl) emptyEl.style.display = 'flex';
    listEl.innerHTML = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  const statusColors = { pending:'#ff9b0c', claimed:'#22c55e', expired:'#6b7280', cancelled:'#ef4444' };
  const statusLabels = { pending:'Pending — awaiting claim', claimed:'Claimed', expired:'Expired', cancelled:'Cancelled' };

  listEl.innerHTML = data.map(g => {
    const iconBg = isSent ? 'rgba(255,155,12,0.12)' : 'rgba(34,197,94,0.12)';
    const iconColor = isSent ? '#ff9b0c' : '#22c55e';
    const personName = isSent
      ? (g.r_first ? `${g.r_first} ${g.r_last}`.trim() : (g.recipient_name || g.recipient_email))
      : (g.s_first ? `${g.s_first} ${g.s_last}`.trim() : 'SV Capital Gift');
    const dateStr = Utils.date ? Utils.date(g.created_at) : new Date(g.created_at).toLocaleDateString('en-ZA');
    const msgSnippet = g.message ? `"${g.message.slice(0,60)}${g.message.length > 60 ? '…' : ''}"` : '';
    const cancelBtn = isSent && g.status === 'pending'
      ? `<button class="gift-row__cancel" onclick="cancelGift('${g.id}')">Cancel & Refund</button>` : '';

    return `<div class="gift-row">
      <div class="gift-row__icon" style="background:${iconBg};color:${iconColor}">
        <i class="fa-solid fa-${isSent ? 'paper-plane' : 'gift'}"></i>
      </div>
      <div class="gift-row__body">
        <div class="gift-row__name">${_esc ? _esc(personName) : personName}</div>
        <div class="gift-row__meta">${dateStr}${msgSnippet ? ` · ${msgSnippet}` : ''}</div>
      </div>
      <div class="gift-row__right">
        <div class="gift-row__amount">${isSent ? '-' : '+'}${Utils.rand ? Utils.rand(g.amount) : 'R'+g.amount}</div>
        <div class="gift-row__status" style="color:${statusColors[g.status]||'#888'}">${statusLabels[g.status]||g.status}</div>
        ${cancelBtn}
      </div>
    </div>`;
  }).join('');
}

async function cancelGift(giftId) {
  if (!await Confirm.ask('Cancel this gift?', { body: 'The gift amount will be refunded to your wallet.', confirmLabel: 'Cancel Gift' })) return;
  try {
    await API._fetch('DELETE', `gifts/${giftId}`);
    Toast.success('Gift cancelled — funds refunded to your wallet');
    const inv = PORTAL.investor;
    const gift = _giftSentCache.find(g => g.id === giftId);
    if (gift && inv) {
      inv.wallet_balance = (parseFloat(inv.wallet_balance)||0) + parseFloat(gift.amount);
      const balHint = document.getElementById('giftBalanceHint');
      if (balHint) balHint.textContent = `Your wallet balance: ${Utils.rand(inv.wallet_balance)}`;
    }
    await _loadSentGifts();
  } catch (e) {
    Toast.error('Failed to cancel: ' + (e.message || 'unknown error'));
  }
}

function _launchGiftConfetti() {
  const colours = ['#ff9b0c','#ff5229','#D4AF37','#22c55e','#eda5ff'];
  for (let i = 0; i < 60; i++) {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;top:${Math.random()*40}%;left:${Math.random()*100}%;
      width:${6+Math.random()*6}px;height:${6+Math.random()*6}px;
      background:${colours[Math.floor(Math.random()*colours.length)]};
      border-radius:${Math.random()>.5?'50%':'2px'};
      pointer-events:none;z-index:99999;opacity:1;
      transform:rotate(${Math.random()*360}deg);
      animation:giftConfettiFall ${1+Math.random()*1.5}s ease-out ${Math.random()*0.5}s forwards`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }
}
/* inject confetti keyframes once */
if (!document.getElementById('giftConfettiStyle')) {
  const s = document.createElement('style');
  s.id = 'giftConfettiStyle';
  s.textContent = `@keyframes giftConfettiFall{to{transform:translateY(80vh) rotate(720deg);opacity:0}}`;
  document.head.appendChild(s);
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
    body.innerHTML = `<div class="empty-state" style="padding:20px 0;border:none;background:transparent"><i class="fa-solid fa-file-circle-check"></i><div class="empty-state__title">No investment certificates yet</div><div class="empty-state__sub">Your first completed investment will unlock downloadable certificates and term sheets here.</div><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px"><button class="btn btn--primary btn--sm" onclick="navigate('marketplace', document.querySelector('[data-view=marketplace]'))"><i class="fa-solid fa-layer-group"></i> Browse pools</button><button class="btn btn--secondary btn--sm" onclick="navigate('wallet', document.querySelector('[data-view=wallet]'))"><i class="fa-solid fa-wallet"></i> Fund wallet</button></div></div>`;
    return;
  }

  body.innerHTML = investments.map(inv => {
    const pi = Utils.productInfo(inv.product_type);
    const pool = PORTAL.pools.find(p => p.id === inv.pool_id);
    const termSheet = pool && pool.term_sheet_url
      ? `<a href="${pool.term_sheet_url}" target="_blank" rel="noopener" class="doc-card__btn doc-card__btn--ghost"><i class="fa-solid fa-file-contract"></i> Term Sheet</a>` : '';
    return `
    <div class="doc-card">
      <div class="doc-card__top">
        <div class="doc-card__icon ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i></div>
        <div class="doc-card__head">
          <div class="doc-card__title">${_esc(inv.pool_name) || pi.label}</div>
          <div class="doc-card__sub">${pi.label} · ${Utils.pct(inv.expected_return_rate || inv.annual_rate)} p.a.</div>
        </div>
        <div class="doc-card__amount">${Utils.rand(inv.amount)}</div>
      </div>
      <div class="doc-card__meta">
        <span><i class="fa-solid fa-calendar-day"></i> ${Utils.date(inv.investment_date || inv.start_date)}</span>
        <span><i class="fa-solid fa-flag-checkered"></i> ${Utils.date(inv.maturity_date || inv.end_date)}</span>
        <span class="doc-card__status">${Utils.statusBadge(inv.status)}</span>
      </div>
      <div class="doc-card__actions">
        <button class="doc-card__btn doc-card__btn--primary" onclick="downloadCertificate('${inv.id}')"><i class="fa-solid fa-file-pdf"></i> Certificate</button>
        ${termSheet}
      </div>
    </div>`;
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
    body.innerHTML = `<div class="empty-state" style="padding:20px 0;border:none;background:transparent"><i class="fa-solid fa-receipt"></i><div class="empty-state__title">No deposit receipts yet</div><div class="empty-state__sub">As soon as your first wallet top-up is completed, the receipt will appear here for download.</div><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px"><button class="btn btn--primary btn--sm" onclick="openTopUpModal()"><i class="fa-solid fa-plus"></i> Top up wallet</button><button class="btn btn--secondary btn--sm" onclick="navigate('statement', document.querySelector('[data-view=statement]'))"><i class="fa-solid fa-file-invoice"></i> Generate statement</button></div></div>`;
    return;
  }

  body.innerHTML = deposits.map(t => `
    <div class="doc-card doc-card--receipt">
      <div class="doc-card__icon" style="background:rgba(34,197,94,0.14);color:#16a34a"><i class="fa-solid fa-arrow-down-to-line"></i></div>
      <div class="doc-card__head">
        <div class="doc-card__title">${t.description || 'Wallet Deposit'}</div>
        <div class="doc-card__sub">${Utils.date(t.transaction_date || t.created_at)} · ${t.reference || 'No ref'}</div>
      </div>
      <div class="doc-card__receipt-right">
        <div class="doc-card__amount" style="color:#16a34a">+${Utils.rand(Math.abs(t.amount))}</div>
        <button class="doc-card__btn doc-card__btn--ghost doc-card__btn--sm" onclick="downloadReceipt('${t.id}')"><i class="fa-solid fa-download"></i> Receipt</button>
      </div>
    </div>`).join('');
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
        <tr><td style="padding:6px 0;color:#6b7280">Target Return</td><td style="font-weight:700;color:#22c55e">${Utils.rand(inv.expected_return_amount||inv.expected_return)}</td></tr>
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

/* ── PDF: logo cache ── */
let _cachedLogoDataUrl = null;
async function _preloadLogo() {
  try {
    const url  = new URL('../assets/logo.png', window.location.href).href;
    const resp = await fetch(url);
    if (!resp.ok) return;
    const blob = await resp.blob();
    _cachedLogoDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (_) {}
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
  // Dark header band
  doc.setFillColor(26, 34, 53); // #303030
  doc.rect(0, 0, W, 38, 'F');
  // Gold accent line
  doc.setFillColor(255, 155, 12);
  doc.rect(0, 38, W, 2, 'F');
  // Logo icon (square lotus mark) + brand name text
  if (_cachedLogoDataUrl) {
    doc.addImage(_cachedLogoDataUrl, 'PNG', 9, 7, 22, 22);
  }
  const textX = _cachedLogoDataUrl ? 34 : 14;
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 155, 12);
  doc.text('SV Capital', textX, 17);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(156, 163, 175);
  doc.text('SmartVest Financial Services · FSP #52449', textX, 24);
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
  const pool = (PORTAL.pools || []).find(p => p.id === inv.pool_id) || {};

  const doc = _getPDF('portrait');
  if (!doc) return;

  const W = doc.internal.pageSize.getWidth();

  // Header
  let y = _pdfHeader(doc, 'INVESTMENT CERTIFICATE', `#${inv.id}`);

  // Certificate outer box — spans full content area
  const certBoxY = y + 6;
  doc.setFillColor(255, 249, 235);
  doc.setDrawColor(255, 155, 12);
  doc.setLineWidth(0.8);
  doc.roundedRect(14, certBoxY, W - 28, 155, 4, 4, 'FD');

  // Title strip inside outer box
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(180, 100, 0);
  doc.text('CERTIFICATE OF INVESTMENT', W / 2, certBoxY + 9, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(120, 80, 0);
  doc.text('This certifies that the investor has made a valid investment with SV Capital.', W / 2, certBoxY + 16, { align: 'center' });

  // Divider line between title and info panels
  doc.setDrawColor(255, 155, 12);
  doc.setLineWidth(0.3);
  doc.line(18, certBoxY + 21, W - 18, certBoxY + 21);

  y = certBoxY + 26;

  // Two-column info layout
  const leftX  = 14;
  const rightX = W / 2 + 4;
  const valLeft  = 70;
  const valRight = W / 2 + 54;

  doc.setFillColor(255, 255, 255);
  doc.roundedRect(leftX + 4, y, (W - 28) / 2 - 6, 68, 2, 2, 'F');
  doc.roundedRect(rightX, y, (W - 28) / 2 - 6, 68, 2, 2, 'F');

  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(107, 114, 128);
  doc.text('INVESTOR DETAILS', leftX + 8, y + 8);
  doc.text('INVESTMENT DETAILS', rightX + 4, y + 8);

  let ly = y + 16;
  let ry = y + 16;

  const infoL = (lbl, val) => {
    doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(107, 114, 128);
    doc.text(lbl, leftX + 8, ly);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(26, 26, 26);
    doc.text(String(val || '—'), valLeft, ly);
    ly += 7;
  };
  const infoR = (lbl, val) => {
    doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(107, 114, 128);
    doc.text(lbl, rightX + 4, ry);
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

  doc.setFillColor(255, 255, 255);
  doc.roundedRect(leftX + 4, y, W - 36, 26, 2, 2, 'F');

  let iy = y + 10;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold'); doc.setTextColor(107, 114, 128);
  doc.text('Start Date', leftX + 8, iy);
  doc.text('Maturity Date', W / 2 - 18, iy);
  doc.text('Status', W - 58, iy);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
  doc.setTextColor(26, 26, 26);
  doc.text(Utils.date(inv.investment_date || inv.start_date), leftX + 8, iy + 8);
  doc.text(Utils.date(inv.maturity_date || inv.end_date), W / 2 - 18, iy + 8);
  const statusColor = inv.status === 'active' ? [47, 140, 155] : inv.status === 'paid_out' ? [34, 197, 94] : [156, 163, 175];
  doc.setTextColor(...statusColor);
  doc.text((inv.status || '').toUpperCase(), W - 58, iy + 8);

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
    ['Wallet Balance',  Utils.rand(walletBal),    [0, 150, 255]],
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
    const typeMap = { deposit: 'Deposit', withdrawal: 'Withdrawal', investment: 'Investment', return: 'Return', payout: 'Payout', fee: 'Fee', referral_bonus: 'Referral Bonus', gift_sent: 'Gift Sent', gift_received: 'Gift Received', reward: 'XP Reward' };
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

  // ── Populate profile hero ─────────────────────────────────
  const fullName = [inv.first_name, inv.last_name].filter(Boolean).join(' ') || inv.name || 'Investor';
  const initials = fullName.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const _heroSet = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
  _heroSet('profileHeroAvatar', initials);
  _heroSet('profileHeroName', fullName);
  _heroSet('profileHeroEmail', inv.email);
  _heroSet('profileHeroId', inv.id);
  _heroSet('profileHeroJoined', inv.date_joined ? new Date(inv.date_joined).toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' }) : '—');
  _heroSet('profileHeroStatus', (inv.status || 'active').replace(/^\w/, c => c.toUpperCase()));

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
        <div style="font-size:0.84rem;font-weight:700;margin-bottom:6px"><i class="fa-solid fa-file-shield" style="color:var(--gold);margin-right:6px"></i>Investment Income Certificate</div>
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
        <a href="${(window.__SVC_API_BASE__ || '/api/')}statements/${s.id}/pdf" target="_blank" class="btn btn--ghost btn--sm" style="font-size:0.75rem"><i class="fa-solid fa-download"></i> PDF</a>
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
        ${hasAdminReply ? `<div style="font-size:0.78rem;color:#1a1a1a;background:rgba(47,140,155,0.08);border:1px solid rgba(47,140,155,0.2);border-radius:6px;padding:6px 10px;margin-bottom:8px"><strong style="color:#656565">Support:</strong> ${(t.admin_response || '').slice(0, 120)}${(t.admin_response || '').length > 120 ? '…' : ''}</div>` : ''}
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
  if (!slider) return;
  const on = !!(toggle && toggle.checked);
  slider.style.background = on ? '#ff9b0c' : '#ccc';
}

function openRecurringModal() {
  const inv     = PORTAL.investor;
  const toggle  = document.getElementById('recurringEnabledToggle');
  const amtEl   = document.getElementById('recurringAmount');
  const prodSel = document.getElementById('recurringProductSelect');
  const daySel  = document.getElementById('recurringDay');

  if (toggle) {
    toggle.checked = !!(inv && inv.recurring_enabled);
    updateRecurringToggleStyle();
  }
  if (amtEl && inv?.recurring_amount)         amtEl.value   = inv.recurring_amount;
  if (prodSel && inv?.recurring_product_type) prodSel.value = inv.recurring_product_type;
  if (daySel  && inv?.recurring_day)          daySel.value  = inv.recurring_day;

  Modal.open('recurringModal');
}

async function saveRecurringInvestment() {
  const toggle  = document.getElementById('recurringEnabledToggle');
  const amtEl   = document.getElementById('recurringAmount');
  const prodSel = document.getElementById('recurringProductSelect');
  const daySel  = document.getElementById('recurringDay');

  const enabled     = !!(toggle && toggle.checked);
  const amount      = parseFloat(amtEl?.value || 0);
  const productType = prodSel?.value || null;
  const day         = parseInt(daySel?.value || 1, 10);

  if (enabled) {
    if (!amount || amount < 100) { Toast.error('Please enter a monthly amount of at least R100'); return; }
    if (!productType) { Toast.error('Please select a product type'); return; }
    if (!day || day < 1 || day > 28) { Toast.error('Please select a valid day (1–28)'); return; }
  }

  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  try {
    await API._fetch('PATCH', `tables/investors/${investorId}`, {
      recurring_enabled:      enabled,
      recurring_amount:       enabled ? amount       : null,
      recurring_product_type: enabled ? productType  : null,
      recurring_day:          enabled ? day          : null,
    });

    if (PORTAL.investor) {
      PORTAL.investor.recurring_enabled      = enabled;
      PORTAL.investor.recurring_amount       = enabled ? amount      : null;
      PORTAL.investor.recurring_product_type = enabled ? productType : null;
      PORTAL.investor.recurring_day          = enabled ? day         : null;
    }

    Modal.close('recurringModal');
    SVC.track('svc_recurring_investment_set', { enabled, product_type: productType, amount, day });

    const PRODUCT_LABELS = { cattle:'Cattle Finance', solar_7yr:'Solar 7yr', solar_6yr:'Solar 6yr', solar_5yr:'Solar 5yr', short_term:'Short Term', smme:'SMME Finance', delivery_bike:'Delivery Bike', other:'Other' };
    if (enabled) {
      const suffix = day === 1 ? 'st' : day === 2 ? 'nd' : day === 3 ? 'rd' : 'th';
      Toast.success(`Recurring ${Utils.rand(amount)}/month into ${PRODUCT_LABELS[productType] || productType} set for the ${day}${suffix} of each month`);
    } else {
      Toast.success('Recurring investment disabled.');
    }

    _renderRecurringStatusSummary();
    if (document.getElementById('walletRecurringTab')?.style.display !== 'none') _renderRecurringTab();
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

  const PRODUCT_LABELS = { cattle:'Cattle Finance', solar_7yr:'Solar 7yr', solar_6yr:'Solar 6yr', solar_5yr:'Solar 5yr', short_term:'Short Term', smme:'SMME Finance', delivery_bike:'Delivery Bike', other:'Other' };
  if (inv && inv.recurring_enabled && inv.recurring_amount && inv.recurring_product_type) {
    const day    = inv.recurring_day || 1;
    const suffix = day === 1 ? 'st' : day === 2 ? 'nd' : day === 3 ? 'rd' : 'th';
    summaryEl.style.display = '';
    summaryEl.innerHTML = `<i class="fa-solid fa-check-circle" style="color:#22c55e"></i> <strong>Active:</strong> ${Utils.rand(inv.recurring_amount)}/month into ${PRODUCT_LABELS[inv.recurring_product_type] || inv.recurring_product_type} on the ${day}${suffix}`;
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
    // Native Capacitor app — push is managed by native.js on startup
    if (window.__SVC_NATIVE__) {
      localStorage.setItem(PUSH_PREF_KEY, 'true');
      if (slider) slider.style.background = '#ff9b0c';
      if (statusText) statusText.textContent = 'Enabled — you will receive investment alerts';
      Toast.success('Push notifications enabled!');
      return;
    }

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
      animation: window.__SVC_NATIVE__ ? false : undefined,
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
  const COLORS  = ['#FF9B0C','#eda5ff','#656565','#22c55e','#ef4444','#656565','#f97316','#eda5ff'];

  if (PORTAL.charts.analyticsAlloc) { PORTAL.charts.analyticsAlloc.destroy(); }
  PORTAL.charts.analyticsAlloc = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(([n]) => n),
      datasets: [{ data: entries.map(([,v]) => v), backgroundColor: COLORS, borderWidth: 2, borderColor: '#fff' }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      animation: window.__SVC_NATIVE__ ? false : undefined,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.label + ': R' + c.raw.toLocaleString('en-ZA') } } },
    },
  });

  if (list) {
    list.innerHTML = entries.map(([name, val], i) => `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${COLORS[i % COLORS.length]};flex-shrink:0"></span>
        <span style="font-size:0.78rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-body)">${_esc(name)}</span>
        <span style="font-size:0.78rem;font-weight:700;color:var(--text-body)">${total > 0 ? ((val/total)*100).toFixed(1) : 0}%</span>
      </div>`).join('') || '<p style="font-size:0.78rem;color:var(--text-muted)">No investment data yet.</p>';
  }
}

function _renderAnalyticsTimeline() {
  const tbody = document.getElementById('analyticsTimelineBody');
  if (!tbody) return;
  const invs = [...PORTAL.investments].sort((a, b) => new Date(b.start_date || b.created_at) - new Date(a.start_date || a.created_at));
  if (!invs.length) {
    tbody.innerHTML = '<div class="text-center text-muted" style="padding:24px">No investments yet.</div>';
    return;
  }
  const statusMeta = s => {
    const map = { active:'#22c55e', paid_out:'#656565', matured:'#eda5ff', cancelled:'#ef4444', pending:'#f97316' };
    return map[s] || '#9ca3af';
  };
  const fmt = v => v ? new Date(v).toLocaleDateString('en-ZA', { day:'numeric', month:'short', year:'numeric' }) : '—';
  tbody.innerHTML = invs.slice(0, 30).map(i => {
    // Connect the row to its pool so name/dates/status reflect the actual pool.
    const pool    = (PORTAL.pools || []).find(p => p.id === i.pool_id) || {};
    const capital = parseFloat(i.amount) || 0;
    const ret     = parseFloat(i.net_return) || parseFloat(i.expected_return) || 0;
    const startVal = pool.start_date || i.start_date || i.created_at;
    const endVal   = pool.end_date   || i.end_date   || i.maturity_date;
    const start   = new Date(startVal);
    const end     = new Date(endVal);
    const days    = (!isNaN(start) && !isNaN(end)) ? Math.max(0, Math.round((end - start) / 86400000)) : (i.term_days || '—');
    const status  = (pool.status === 'matured' || pool.status === 'paid_out') ? 'matured' : (i.status || pool.status);
    const sc      = statusMeta(status);
    return `
      <div class="atl-card">
        <div class="atl-card__head">
          <div class="atl-card__name">${_esc(pool.name || i.pool_name || 'Pool')}</div>
          <span class="atl-card__status" style="background:${sc}1f;color:${sc};border:1px solid ${sc}44">${String(status||'').replace('_',' ').toUpperCase()}</span>
        </div>
        <div class="atl-card__figures">
          <div><span class="atl-card__k">Invested</span><span class="atl-card__v">R ${capital.toLocaleString('en-ZA')}</span></div>
          <div><span class="atl-card__k">Target Return</span><span class="atl-card__v" style="color:#16a34a">${Utils.pct(pool.annual_rate || i.annual_rate || i.expected_return_rate || 0)}</span></div>
          <div><span class="atl-card__k">Duration</span><span class="atl-card__v">${typeof days === 'number' ? days + ' d' : days}</span></div>
        </div>
        <div class="atl-card__dates">
          <span><i class="fa-solid fa-play"></i> ${fmt(startVal)}</span>
          <span><i class="fa-solid fa-flag-checkered"></i> ${fmt(endVal)}</span>
        </div>
      </div>`;
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
  // Refer & Earn hidden — referral programme not yet live
  { label: 'Documents',                icon: 'fa-folder-open',     group: 'Navigate', action: () => navigate('documents',     document.querySelector('[data-view=documents]')) },
  { label: 'Account Statement',        icon: 'fa-file-invoice',    group: 'Navigate', action: () => navigate('statement',     document.querySelector('[data-view=statement]')) },
  { label: 'Top Up Wallet',            icon: 'fa-plus',            group: 'Actions',  action: () => openTopUpModal() },
  { label: 'Download Tax Certificate', icon: 'fa-file-shield',     group: 'Actions',  action: () => { navigate('documents', document.querySelector('[data-view=documents]')); } },
  { label: 'Download Statement PDF',   icon: 'fa-file-pdf',        group: 'Actions',  action: () => downloadStatement() },
  { label: 'Export Analytics CSV',     icon: 'fa-table',           group: 'Actions',  action: () => exportAnalyticsCSV() },
  { label: 'Submit Maturity Instruction', icon: 'fa-check-circle', group: 'Actions',  action: () => navigate('maturity', document.querySelector('[data-view=maturity]')) },
  { label: 'Sign Out',                 icon: 'fa-arrow-right-from-bracket', group: 'Actions', action: () => { localStorage.removeItem('svc_portal_cache'); localStorage.removeItem('svc_user'); sessionStorage.clear(); Auth.logout('../login.html'); } },
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

