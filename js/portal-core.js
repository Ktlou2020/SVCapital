/* ═══════════════════════════════════════════════
   SV CAPITAL — Portal core
   Shared by the web portal (portal/js/portal.js) and the native app
   (mobile/src/js/portal.js). Both used to carry their own copy of every
   function in here; the copies drifted, and the drift shipped bugs.

   Only function declarations live here — nothing runs at load. Top-level
   state (PORTAL, constants, IIFEs) stays in the platform files, which run
   after this one, so a function defined here sees that state by the time it
   is called.

   Loaded before portal.js on both surfaces. Do not add executable statements.
   ═══════════════════════════════════════════════ */

'use strict';

function _relativeAge(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1)  return 'a moment ago';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return `on ${new Date(ts).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function _staleBannerEl() {
  let el = document.getElementById('staleDataBanner');
  if (el) return el;
  const host = document.querySelector('main.page-content');
  if (!host) return null;
  el = document.createElement('div');
  el.id = 'staleDataBanner';
  el.className = 'stale-banner';
  // role=status so the notice is announced without stealing focus mid-task.
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.hidden = true;
  host.insertBefore(el, host.firstChild);
  return el;
}

function showStaleDataNotice() {
  // Nothing cached means the tables already show their own "could not reach
  // server" row — a second warning about stale figures would be untrue.
  if (!_cacheStampedAt) return;
  const el = _staleBannerEl();
  if (!el) return;
  el.innerHTML = `
    <i class="fa-solid fa-triangle-exclamation stale-banner__icon" aria-hidden="true"></i>
    <span class="stale-banner__text">These figures were last updated <strong>${_esc(_relativeAge(_cacheStampedAt))}</strong> — we couldn't reach the server, so they may be out of date.</span>
    <button type="button" class="stale-banner__retry" onclick="retryPortalRefresh(this)">Try again</button>`;
  el.hidden = false;
}

function clearStaleDataNotice() {
  const el = document.getElementById('staleDataBanner');
  if (el) el.hidden = true;
}

async function retryPortalRefresh(btn) {
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> Checking…';
  }
  try {
    await loadPortalData();
  } finally {
    // loadPortalData clears the notice itself on success. If it failed it has
    // already re-shown it, which rebuilds this button — so only restore the
    // label when the node is somehow still ours.
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  }
}

function _showPartnerModal(name) {
  const p = PARTNER_PROFILES[name];
  if (!p) return;
  document.getElementById('pip-modal')?.remove();
  const vid = p.youtubeId ? `<a href="https://www.youtube.com/watch?v=${p.youtubeId}" target="_blank" rel="noopener" style="display:block;position:relative;border-radius:10px;overflow:hidden;margin-bottom:14px;text-decoration:none"><img src="https://img.youtube.com/vi/${p.youtubeId}/mqdefault.jpg" style="width:100%;display:block" loading="lazy"><span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4)"><i class="fa-solid fa-play" style="font-size:2rem;color:#fff"></i></span></a>` : '';
  const el = document.createElement('div');
  el.id = 'pip-modal';
  el.innerHTML = `<div id="pip-modal-bd" style="position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:99998;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(6px)"><div style="background:#1c1c1e;border:1px solid rgba(255,255,255,.15);border-radius:18px;padding:24px 22px;max-width:360px;width:100%;position:relative;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.8)"><button onclick="document.getElementById('pip-modal').remove()" style="position:absolute;top:14px;right:14px;background:rgba(255,255,255,.1);border:none;border-radius:50%;width:30px;height:30px;cursor:pointer;color:rgba(255,255,255,.8);display:flex;align-items:center;justify-content:center;font-size:.9rem;line-height:1"><i class="fa-solid fa-xmark"></i></button><div style="font-weight:700;font-size:1.05rem;color:#fff;margin-bottom:3px;padding-right:36px">${_esc(name)}</div><div style="font-size:.75rem;color:#eda5ff;margin-bottom:14px;line-height:1.45">${_esc(p.tagline)}</div>${vid}<p style="font-size:.8rem;color:rgba(255,255,255,.8);line-height:1.65;margin:0 0 16px">${_esc(p.profile)}</p><a href="${_safeUrl(p.website)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:7px;font-size:.8rem;color:#eda5ff;text-decoration:none;border:1px solid rgba(237,165,255,.3);border-radius:20px;padding:7px 16px"><i class="fa-solid fa-arrow-up-right-from-square"></i> Visit website</a></div></div>`;
  document.body.appendChild(el);
  document.getElementById('pip-modal-bd').addEventListener('click', e => { if (e.target === e.currentTarget) el.remove(); });
  const _onKey = e => { if (e.key === 'Escape') { el.remove(); document.removeEventListener('keydown', _onKey); } };
  document.addEventListener('keydown', _onKey);
}

function _partnerInfoBtn(name) {
  if (!PARTNER_PROFILES[name]) return '';
  return `<button type="button" onclick="_showPartnerModal('${_esc(name)}')" aria-label="About ${_esc(name)}" style="background:none;border:none;cursor:pointer;padding:0 4px;color:inherit;opacity:.55;font-size:.85em;vertical-align:middle;line-height:1;transition:color .15s,opacity .15s" onmouseenter="this.style.color='#eda5ff';this.style.opacity='1'" onmouseleave="this.style.color='';this.style.opacity='.55'"><i class="fa-solid fa-circle-info"></i></button>`;
}

function _partnerNameLink(name, display) {
  if (!PARTNER_PROFILES[name]) return _esc(display || name);
  return `<span onclick="_showPartnerModal('${_esc(name)}')" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px" onmouseenter="this.style.color='#eda5ff'" onmouseleave="this.style.color=''">${_esc(display || name)}</span>`;
}

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
    <div class="panel" style="border:1px solid rgba(47,140,155,0.18);background:linear-gradient(135deg,rgba(47,140,155,0.05),rgba(254,194,79,0.04))">
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

function _profileDraftHasValue(data) {
  return !!Object.values(data || {}).find(Boolean);
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
  _setInlineMessage('profileSaveMeta', 'Draft saved locally — click Save to update your account.', '#fec24f');
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
      _setInlineMessage('profileSaveMeta', 'Draft restored — review your changes and click Save.', '#fec24f');
    }
  } catch (_) {}
}

function clearProfileDraft() {
  _localRemove(_portalScopedKey(PROFILE_DRAFT_KEY));
  _profileDirty = false;
  _setInlineMessage('profileSaveMeta', 'Profile saved.');
}

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
    _setInlineMessage('supportDraftMeta', 'Draft restored — review and submit when ready.', '#fec24f');
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
  const ficaReady = _isInvestorFicaApproved(inv);
  const tasks = [
    { label: 'Complete identity verification', done: ficaReady, tone: '#fec24f', action: 'openKycUploadModal()', cta: 'Upload documents' },
    { label: 'Add a withdrawal bank account', done: bankReady, tone: '#656565', action: 'openBankDetailsModal()', cta: 'Add bank account' },
    { label: 'Add funds to your wallet', done: hasWallet, tone: '#22c55e', action: 'openTopUpModal()', cta: 'Add funds' },
    { label: 'Confirm your risk profile', done: riskReady, tone: '#eda5ff', action: 'navigate(\'profile\', document.querySelector(\'[data-view=profile]\'))', cta: 'Review profile' },
    { label: 'Make your first investment', done: hasInvestments, tone: '#fec24f', action: 'navigate(\'marketplace\', document.querySelector(\'[data-view=marketplace]\'))', cta: 'Browse products' },
  ];
  const doneCount = tasks.filter(t => t.done).length;
  const pending = tasks.filter(t => !t.done);
  meta.textContent = `${doneCount}/${tasks.length} complete`;
  if (!pending.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
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

/* Normalise a raw fica/kyc status value (handles capitalised external provider values) */
function _normFicaStatus(s) {
  const MAP = { Approved:'approved', Verified:'approved', Declined:'rejected', Unverified:'not_started', Outstanding:'pending', Pending:'pending' };
  return MAP[String(s || '').trim()] || String(s || '').trim().toLowerCase();
}

function _isInvestorFicaApproved(inv = PORTAL.investor) {
  const ficaN = _normFicaStatus(inv?.fica_status);
  const kycN  = _normFicaStatus(inv?.kyc_status);
  const OK    = ['approved', 'verified', 'active'];
  return OK.includes(ficaN) || OK.includes(kycN) || OK.includes(String(inv?.status || '').toLowerCase());
}

function _poolEndMs(dateStr) {
  if (!dateStr) return null;
  if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, mo, dy] = dateStr.split('-').map(Number);
    return new Date(y, mo - 1, dy, 23, 58, 0, 0).getTime();
  }
  return new Date(dateStr).getTime();
}

/* Has this pool stopped taking money?
 *
 * Status alone does not answer that. The cycler deploys a pool on its
 * INVESTMENT START DATE, which an admin can set days or weeks after the close
 * date, and for all of those days the pool still reads 'open' — so the
 * marketplace kept offering a pool whose raising window had shut. The close
 * date is the honest answer, and _poolEndMs already carries the convention
 * that a date-only end_date means the end of that day.
 *
 * A pool with no close date is left alone: it has not demonstrably closed,
 * and guessing that it has would take a live pool off the marketplace. */
function _poolPastClose(p) {
  const endMs = _poolEndMs(p && p.end_date);
  return endMs !== null && !isNaN(endMs) && Date.now() > endMs;
}

function _getOpenMarketplacePools() {
  return (PORTAL.pools || []).filter(p => {
    if (!p) return false;
    if (_poolPastClose(p)) return false;
    // Status otherwise comes from the database — the cron manages transitions.
    return p.status === 'open' || p.status === 'waitlist';
  });
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
  const openPools = ranked.filter(p => p.status === 'open' && !_poolPastClose(p));
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
    accent = '#fec24f';
  } else if (!openPools.length) {
    title = 'There are no open pools in this filter right now.';
    sub = 'Use the waitlist options below or switch category to keep your momentum.';
    action = "filterMarket('all', document.querySelector('#view-marketplace .tab-bar .tab-btn'))";
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
            <div style="display:flex;justify-content:space-between;gap:8px;margin-top:10px;font-size:0.73rem;color:var(--text-muted)"><span>${Utils.pct(pool.annual_rate)} benchmark</span><span>${pool.term_months || '—'} months</span></div>
            <div style="display:flex;justify-content:space-between;gap:8px;margin-top:4px;font-size:0.73rem;color:var(--text-muted)"><span>Minimum</span><span style="font-weight:800;color:${affordableNow ? '#22c55e' : '#1a1a1a'}">${Utils.rand(min)}</span></div>
            <div style="display:flex;justify-content:space-between;gap:8px;margin-top:4px;font-size:0.73rem;color:var(--text-muted)"><span>Closes in</span><span>${days === null ? '—' : days + 'd'}</span></div>
          </div>`;
        }).join('') : `<div style="grid-column:1/-1;font-size:0.78rem;color:var(--text-muted);padding:12px 0">No pools available in this view right now.</div>`}
      </div>
    </div>`;
}

/* The full transaction history, for the statement only.
 *
 * The portal loads one 200-row page of transactions for everyday use, which is
 * fine for a dashboard and is NOT fine for a statement: the balances here are
 * derived by working backwards from today's wallet, so a missing row does not
 * merely omit a line, it throws the opening balance out by that amount. A
 * client with a long history would have been handed a document that looked
 * precise and was not.
 *
 * Paged on demand rather than on every load, so nobody waits for four hundred
 * rows to see their dashboard. If it cannot finish, it says so and the document
 * prints the caveat rather than a balance it cannot stand behind.
 */
async function loadFullTransactionHistory() {
  const PAGE = 100;
  let page = 1, all = [];
  try {
    for (;;) {
      const res = await API.transactions.list({ limit: PAGE, page });
      const rows = (res && res.data) || [];
      all = all.concat(rows);
      if (rows.length < PAGE) break;
      if (res.total > 0 && all.length >= res.total) break;
      if (++page > 200) break;
    }
  } catch (_) {
    return { transactions: all, complete: false };
  }
  return { transactions: all, complete: true };
}

/* ═══════════════════════════════════════════════════════════════════════
   STATEMENT ARITHMETIC

   One source of truth for what a statement says, because there were two and
   they disagreed: the web and mobile builders carried their own copies of the
   credit/debit classification and mobile's knew about 'reinvestment' while the
   web's did not — so the same client's statement showed different totals
   depending on where they opened it.

   Everything here is a pure function of the rows it is given. The document
   builders render; they do not compute.
   ═══════════════════════════════════════════════════════════════════════ */

/* How each transaction type moves the wallet.
 *
 * The old classification was two allow-lists and nothing else, so a type in
 * NEITHER list — 'adjustment', and 'reinvestment' on the web — rendered a dash
 * in both the debit and credit columns and counted toward no total at all.
 * That is real money moving in a client's wallet, absent from the statement of
 * that wallet.
 *
 * So there is a fallback now, and it reads the SIGN of the amount. An
 * adjustment is stored signed precisely because it can go either way, and a
 * type nobody has classified yet is far better placed by its sign than
 * silently dropped. */
/* WHAT COUNTS AS INCOME.
 *
 * `return` and `interest`. NOT `payout`: a payout's amount is the client's
 * CAPITAL COMING BACK plus the return on it — maturityCron credits the whole
 * sum in one row and books only the return portion to total_returns. Anything
 * that sums payouts and calls the result "returns" reports a client's own
 * money back to them as earnings, and the figure spikes in exactly the months
 * a holding matured.
 *
 * This is the same definition as server/services/ledger.js INCOME_TYPES and
 * the one both tax documents use. It is deliberately NOT the same as the
 * credit/debit direction below — a payout very much is a cash credit; it just
 * is not income.
 *
 * A function rather than a const because portal-core carries no top-level
 * state: the file is shared by two bundles and a second declaration of the
 * same name is a redeclaration error. */
function _isIncomeTxn(t) {
  return ['return', 'interest'].includes(String(t && t.type || ''));
}

function _stmtDirection(t) {
  const CREDIT = ['deposit', 'return', 'payout', 'referral_bonus', 'gift_received', 'reward', 'interest', 'refund'];
  const DEBIT  = ['withdrawal', 'investment', 'reinvestment', 'platform_fee', 'fee', 'gift_sent'];
  const type = String(t && t.type || '');
  if (CREDIT.includes(type)) return 'credit';
  if (DEBIT.includes(type))  return 'debit';
  const amt = Number(t && t.amount) || 0;
  if (amt < 0) return 'debit';
  if (amt > 0) return 'credit';
  return 'none';
}

function _stmtLabel(t) {
  const LABELS = {
    deposit: 'Deposit', withdrawal: 'Withdrawal', investment: 'Investment',
    reinvestment: 'Reinvestment', return: 'Return', payout: 'Payout',
    fee: 'Fee', platform_fee: 'Platform Fee', referral_bonus: 'Referral Bonus',
    gift_sent: 'Gift Sent', gift_received: 'Gift Received', reward: 'XP Reward',
    adjustment: 'Adjustment', interest: 'Interest', refund: 'Refund',
  };
  const type = String(t && t.type || '');
  return LABELS[type] || type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || '—';
}

/* Only a completed transaction moved money.
 *
 * Every total on the statement used to include pending AND rejected rows —
 * every status except 'cancelled' counted. A client whose R50 000 deposit was
 * rejected saw "Total Deposits R50 000" on a document headed with their name.
 * Pending and rejected rows are still LISTED, because leaving them out would
 * be its own kind of lie, but they are excluded from every figure and marked
 * as excluded. */
function _stmtCounts(t) {
  return String(t && t.status || 'completed') === 'completed';
}

/* The signed effect of one transaction on the wallet, in rands. */
function _stmtNet(t) {
  if (!_stmtCounts(t)) return 0;
  const dir = _stmtDirection(t);
  const amt = Math.abs(Number(t && t.amount) || 0);
  return dir === 'credit' ? amt : dir === 'debit' ? -amt : 0;
}

function _stmtDate(t) {
  const raw = t && (t.transaction_date || t.created_at);
  if (!raw) return null;
  const d = (typeof raw === 'number') ? new Date(raw)
          : new Date(String(raw).length === 10 ? raw + 'T00:00:00' : raw);
  return isNaN(d.getTime()) ? null : d;
}

/* Everything the statement document needs, computed once.
 *
 * THE BALANCES ARE DERIVED BACKWARDS FROM TODAY. The only balance the platform
 * stores is the wallet as it stands right now, so the closing balance on a
 * statement to some past date is today's wallet minus everything that has
 * happened since, and the opening balance is that closing figure minus the
 * period's own movements. That makes the statement reconcile — opening plus
 * credits minus debits equals closing — which is the thing that turns a list of
 * transactions into a statement.
 *
 * It also makes the statement DEPENDENT ON HAVING EVERY TRANSACTION. A missing
 * row does not just omit a line, it throws the opening balance out by that
 * amount. `complete` says whether the caller supplied the full history, and the
 * document says so on its face when it did not, rather than presenting a
 * balance it cannot stand behind. */
function computeStatementFigures(opts) {
  const investor     = (opts && opts.investor) || {};
  const allTxns      = (opts && opts.transactions) || [];
  const allInvest    = (opts && opts.investments) || [];
  const from         = opts && opts.from;
  const to           = opts && opts.to;
  const complete     = !(opts && opts.complete === false);

  const inPeriod = t => { const d = _stmtDate(t); return d && d >= from && d <= to; };
  const afterTo  = t => { const d = _stmtDate(t); return d && d > to; };

  const transactions = allTxns.filter(inPeriod)
    .sort((a, b) => (_stmtDate(a) || 0) - (_stmtDate(b) || 0));

  const counted   = transactions.filter(_stmtCounts);
  const excluded  = transactions.filter(t => !_stmtCounts(t));

  const credits = counted.filter(t => _stmtDirection(t) === 'credit')
                         .reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
  const debits  = counted.filter(t => _stmtDirection(t) === 'debit')
                         .reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);

  const walletNow = Number(investor.wallet_balance) || 0;
  const since     = allTxns.filter(afterTo).reduce((s, t) => s + _stmtNet(t), 0);
  const closing   = _stmtRound(walletNow - since);
  const opening   = _stmtRound(closing - (credits - debits));

  /* Compared in cents: 0.1 + 0.2 is not 0.3 in binary floating point, and a
     statement that cried "does not balance" over that would be worse than one
     that never checked. */
  const ties = Math.round(opening * 100) + Math.round(credits * 100)
             - Math.round(debits * 100) === Math.round(closing * 100);

  const byType = {};
  for (const t of counted) {
    const k = String(t.type || 'other');
    byType[k] = _stmtRound((byType[k] || 0) + Math.abs(Number(t.amount) || 0));
  }

  /* Investments that were live at any point in the period. */
  const investments = allInvest.filter(inv => {
    const start = new Date(inv.start_date || inv.investment_date || inv.created_at || 0);
    const end   = inv.end_date ? new Date(inv.end_date)
                : (inv.maturity_date ? new Date(inv.maturity_date) : null);
    if (isNaN(start.getTime())) return false;
    if (inv.status === 'active') return start <= to;
    if (end && !isNaN(end.getTime())) return start <= to && end >= from;
    return start >= from && start <= to;
  });

  /* Capital placed DURING the period. The old figure summed every investment
     the client had ever made and printed it beside "Investments in Period" on a
     statement covering three months. */
  const capitalInPeriod = _stmtRound(allInvest.filter(inv => {
    const start = new Date(inv.start_date || inv.investment_date || inv.created_at || 0);
    return !isNaN(start.getTime()) && start >= from && start <= to;
  }).reduce((s, i) => s + (Number(i.amount) || 0), 0));

  const activeInvestments = allInvest.filter(i => i.status === 'active');
  const activeInvAmt = _stmtRound(activeInvestments.reduce((s, i) => s + (Number(i.amount) || 0), 0));

  return {
    from, to, complete,
    transactions, counted, excluded,
    investments,
    credits:  _stmtRound(credits),
    debits:   _stmtRound(debits),
    opening, closing, ties,
    net:      _stmtRound(credits - debits),
    byType,
    deposits:    byType.deposit || 0,
    withdrawals: byType.withdrawal || 0,
    /* INCOME, not cash returned.
     *
     * This summed `payout` as well, and a payout's amount is the client's
     * CAPITAL COMING BACK plus the return on it — maturityCron credits the
     * whole sum and books only the return portion to total_returns. So a
     * client whose R19 000 holding matured inside the window was shown that
     * R19 000 as money they had earned.
     *
     * Income is `return` and `interest`, which is what services/ledger.js
     * says and what both tax documents now count. The cash that actually
     * moved at maturity is visible in the ledger and in the closing balance;
     * it does not belong in a figure labelled "Returns". */
    returns:     _stmtRound((byType.return || 0) + (byType.interest || 0)),
    fees:        _stmtRound((byType.platform_fee || 0) + (byType.fee || 0)),
    capitalInPeriod,
    activeInvCount: activeInvestments.length,
    activeInvAmt,
    walletNow: _stmtRound(walletNow),
    /* Portfolio value is a TODAY figure — active investments plus the wallet as
       it stands. It is returned under a name that says so, because it was
       printed on historical statements labelled as though it belonged to the
       period. */
    portfolioValueToday: _stmtRound(activeInvAmt + walletNow),
  };
}

function _stmtRound(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/* A statement number that means something.
 *
 * It was `SVC-<year>-<five random digits>`: regenerating the same statement
 * gave a different reference every time, and two different statements could
 * collide. A reference nobody can look anything up by is decoration. This is
 * derived from the investor and the period, so the same statement always
 * carries the same number and two different ones cannot share it. */
function statementNumber_sa(subAccountId) {
  let h = 5381;
  const seed = String(subAccountId || '');
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  return `SVC-SA-${h.toString(36).toUpperCase().slice(0, 6)}`;
}

function statementNumber(investorId, from, to) {
  const iso = d => { try { return new Date(d).toISOString().slice(0, 10).replace(/-/g, ''); } catch (_) { return '00000000'; } };
  let h = 5381;
  const seed = `${investorId || ''}|${iso(from)}|${iso(to)}`;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  return `SVC-${iso(from).slice(0, 4)}-${iso(from).slice(4)}${iso(to).slice(4)}-${h.toString(36).toUpperCase().slice(0, 4)}`;
}

/* The South African tax year: 1 March to the end of February.
 *
 * The end date was hardcoded to the 28th, which silently drops 29 February in a
 * leap year — a whole day of transactions missing from a tax statement, in the
 * years nobody thinks to check. Computed as the day before 1 March instead, so
 * a leap year needs no special case. UTC throughout, and matched to
 * taxYearRange in server/routes/statements.js, because a preset and an endpoint
 * that disagree about the period are worse than either being wrong alone. */
function _statementTaxYearRange(year) {
  const y = parseInt(year, 10) || new Date().getFullYear();
  const from = new Date(Date.UTC(y - 1, 2, 1));
  const to   = new Date(Date.UTC(y, 2, 1) - 86400000);
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

/* ── Pull-to-refresh ─────────────────────────────────────── */
function _initPullToRefresh() {
  if (!window.__SVC_NATIVE__) return; // native app only
  let startY = 0, currentY = 0, isPulling = false;
  const MIN_PULL = 72;

  const el = document.createElement('div');
  el.id = '_ptrIndicator';
  el.style.cssText = 'position:fixed;top:0;left:50%;transform:translate(-50%,-56px);z-index:9999;width:40px;height:40px;border-radius:50%;background:var(--gold);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(254,194,79,0.4);transition:transform 0.2s,opacity 0.2s;opacity:0;pointer-events:none';
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

function _getReadNotifs() {
  try { return new Set(JSON.parse(localStorage.getItem(_NOTIF_READ_KEY) || '[]')); } catch(_) { return new Set(); }
}

function _saveReadNotifs(s) {
  try { localStorage.setItem(_NOTIF_READ_KEY, JSON.stringify([...s])); } catch(_) {}
}

function markAllRead() {
  const dismissed = _getReadNotifs();
  document.querySelectorAll('#notifList .notif-item[data-nid]').forEach(el => { if (el.dataset.nid) dismissed.add(el.dataset.nid); });
  _saveReadNotifs(dismissed);
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
  /* Reduced motion: land on the value immediately. Besides the motion itself,
     the count-up rewrites textContent every frame — inside a live region that
     is a screen reader reading a balance sixty times a second. */
  if (Utils.reducedMotion && Utils.reducedMotion()) {
    el.textContent = prefix + Number(safeTarget).toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + suffix;
    el.dataset.animated = safeTarget;
    return;
  }
  const start = parseFloat(el.dataset.animated || 0);
  const startTime = performance.now();
  const step = (now) => {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = start + (safeTarget - start) * eased;
    el.textContent = prefix + Number(current).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + suffix;
    if (progress < 1) requestAnimationFrame(step);
    else { el.textContent = prefix + Number(safeTarget).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + suffix; el.dataset.animated = safeTarget; }
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

  const _dismissed = _getReadNotifs();
  const _notif = (obj) => { if (obj.nid && _dismissed.has(obj.nid)) obj.unread = false; return obj; };

  // 1. Low wallet balance
  if (inv && parseFloat(inv.wallet_balance) < 500) {
    notifs.push(_notif({
      nid: 'low-bal',
      icon: 'fa-wallet', iconBg: 'rgba(254,194,79,0.12)', iconColor: '#fec24f',
      title: 'Low wallet balance',
      sub: `Your balance is ${Utils.rand(parseFloat(inv.wallet_balance) || 0)}. Top up to keep investing.`,
      time: 'Now',
      action: "openTopUpModal()",
      unread: true,
    }));
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
    notifs.push(_notif({
      nid: `mat-soon-${s.id}`,
      icon: 'fa-coins', iconBg: 'rgba(34,197,94,0.1)', iconColor: '#22c55e',
      title: 'Investment maturing soon',
      sub: `${s.pool_name || 'An investment'} matures in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Submit your maturity instruction.`,
      time: `${daysLeft}d away`,
      action: "navigate('investments',document.querySelector('[data-view=investments]'))",
      unread: true,
    }));
  }

  // 3. FICA / KYC status notifications
  if (inv) {
    const _fN = _normFicaStatus(inv.fica_status);
    const _kN = _normFicaStatus(inv.kyc_status);
    if (_fN === 'rejected' || _kN === 'rejected') {
      notifs.push(_notif({
        nid: 'fica-rej',
        icon: 'fa-triangle-exclamation', iconBg: 'rgba(239,68,68,0.12)', iconColor: '#ef4444',
        title: 'FICA/KYC verification unsuccessful',
        sub: 'Your documents could not be verified. Please re-upload and resubmit.',
        time: 'Action required',
        action: "navigate('fica',document.querySelector('[data-view=fica]'))",
        unread: true,
      }));
    } else if (_fN === 'approved' || _kN === 'approved' || _kN === 'verified') {
      notifs.push({
        icon: 'fa-shield-halved', iconBg: 'rgba(237,165,255,0.1)', iconColor: '#eda5ff',
        title: 'Identity verified',
        sub: 'Your FICA/KYC verification is complete. You can invest in all available pools.',
        time: inv.fica_verified_at ? Utils.timeAgo(inv.fica_verified_at) : 'KYC Verified',
        action: null,
        unread: false,
      });
    } else if (_fN === 'in_progress' || _kN === 'in_progress' || _fN === 'submitted' || _kN === 'submitted') {
      notifs.push(_notif({
        nid: 'fica-submitted',
        icon: 'fa-file-circle-check', iconBg: 'rgba(254,194,79,0.12)', iconColor: '#fec24f',
        title: 'FICA documents submitted',
        sub: 'Your documents have been received and will be reviewed within 1–2 business days. We\'ll notify you once verified.',
        time: 'Pending Review',
        action: "navigate('fica',document.querySelector('[data-view=fica]'))",
        unread: true,
      }));
    } else if (_fN === 'not_started' || (!inv.fica_status && !inv.kyc_status)) {
      // No FICA uploaded — prompt to get started
    } else if (_fN === 'pending' || _kN === 'pending' || inv.status === 'fica_submitted') {
      notifs.push({
        icon: 'fa-clock', iconBg: 'rgba(254,194,79,0.12)', iconColor: '#fec24f',
        title: 'FICA/KYC verification in progress',
        sub: 'Your documents are under review — typically 1–2 business days.',
        time: 'Pending Review',
        action: null,
        unread: false,
      });
    }
  }

  // 4. Bank account status
  if (inv && inv.bank_account_number) {
    if (inv.bank_account_status === 'pending') {
      notifs.push({
        icon: 'fa-building-columns', iconBg: 'rgba(254,194,79,0.12)', iconColor: '#fec24f',
        title: 'Bank account pending verification',
        sub: `${inv.bank_name || 'Your bank account'} is being reviewed by our team. Withdrawals will be enabled once approved.`,
        time: 'Under review',
        action: null,
        unread: false,
      });
    } else if (inv.bank_account_status === 'approved') {
      notifs.push(_notif({
        nid: 'bank-app',
        icon: 'fa-building-columns', iconBg: 'rgba(34,197,94,0.1)', iconColor: '#22c55e',
        title: 'Bank account verified',
        sub: `Your ${inv.bank_name || 'bank'} account has been verified. You can now request withdrawals.`,
        time: 'Approved',
        action: "navigate('wallet',document.querySelector('[data-view=wallet]'))",
        unread: true,
      }));
    } else if (inv.bank_account_status === 'rejected') {
      notifs.push(_notif({
        nid: 'bank-rej',
        icon: 'fa-building-columns', iconBg: 'rgba(239,68,68,0.12)', iconColor: '#ef4444',
        title: 'Bank account not verified',
        sub: inv.bank_account_notes || 'Your bank details could not be verified. Please update and resubmit.',
        time: 'Action required',
        action: "navigate('profile',document.querySelector('[data-view=profile]'))",
        unread: true,
      }));
    }
  }

  // 5. Maturity overdue — investment has matured but no instruction yet
  const overdue = investments.filter(i => {
    if (i.status !== 'matured') return false;
    return !i.maturity_instruction;
  });
  if (overdue.length) {
    notifs.push(_notif({
      nid: `mat-due-${overdue.map(i=>i.id).sort().join('-')}`,
      icon: 'fa-exclamation-circle', iconBg: 'rgba(239,68,68,0.12)', iconColor: '#ef4444',
      title: `${overdue.length} investment${overdue.length === 1 ? '' : 's'} awaiting instruction`,
      sub: `${overdue.map(i => i.pool_name || 'Investment').slice(0,2).join(', ')} ha${overdue.length === 1 ? 's' : 've'} matured — submit your payout instruction now.`,
      time: 'Urgent',
      action: "navigate('maturity',document.querySelector('[data-view=maturity]'))",
      unread: true,
    }));
  }

  // 6. Support ticket responses — one notification per answered ticket
  const answered = tickets.filter(t => t.admin_response && t.admin_response.trim());
  answered.forEach(t => {
    notifs.push(_notif({
      nid: `tkt-${t.id}-${t.responded_at || 'x'}`,
      icon: 'fa-reply', iconBg: 'rgba(47,140,155,0.1)', iconColor: '#656565',
      title: 'Support reply received',
      sub: `"${t.subject}" — our team has responded.`,
      time: t.responded_at ? Utils.timeAgo(t.responded_at) : 'Recently',
      action: "navigate('support',document.querySelector('[data-view=support]'))",
      unread: true,
    }));
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
      sub: `${np.name || np.pool_name} — ${Utils.pct(np.annual_rate || np.benchmark_rate)} benchmark over ${np.term_months} months.`,
      time: Utils.timeAgo(np.created_at),
      action: "navigate('marketplace',document.querySelector('[data-view=marketplace]'))",
      unread: false,
    });
  }

  // 9. Recently confirmed investments (placed within the last 14 days)
  const recentInvests = investments.filter(i => {
    const created = i.created_at || i.investment_date;
    if (!created) return false;
    return (now - new Date(created)) < 14 * 86400000 && (i.status === 'active' || i.status === 'pending_funds' || i.status === 'pending');
  });
  recentInvests.forEach(ri => {
    notifs.push(_notif({
      nid: `inv-conf-${ri.id}`,
      icon: 'fa-circle-check', iconBg: 'rgba(34,197,94,0.1)', iconColor: '#22c55e',
      title: 'Investment confirmed',
      sub: `${ri.pool_name || 'Your investment'} of ${Utils.rand(Math.abs(parseFloat(ri.amount) || 0))} has been placed and is now active.`,
      time: Utils.timeAgo(ri.created_at || ri.investment_date),
      action: "navigate('investments',document.querySelector('[data-view=investments]'))",
      unread: true,
    }));
  });

  if (!notifs.length) {
    list.innerHTML = '<div style="padding:24px 18px;text-align:center;color:#999;font-size:0.82rem">You\'re all caught up!</div>';
    _syncNotifDot();
    return;
  }

  list.innerHTML = notifs.map((n, i) => `
    <div class="notif-item${n.unread ? ' unread' : ''}" data-id="n${i}" data-nid="${_esc(n.nid || '')}" ${n.action ? `onclick="${n.action};toggleNotifPanel()" style="cursor:pointer"` : ''}>
      <div class="notif-icon" style="background:${n.iconBg}"><i class="fa-solid ${n.icon}" style="color:${n.iconColor}"></i></div>
      <div class="notif-body">
        <div class="notif-title">${_esc(n.title)}</div>
        <div class="notif-sub">${_esc(n.sub)}</div>
        <div class="notif-time">${_esc(n.time)}</div>
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
    profile: () => { renderRiskProfile(); _initPushNotifToggle(); _refreshInvestorThenKyc(); },
  };
  if (loaders[view]) loaders[view]();

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
    loadNotifications();
  }, 30000);
}

function renderOverview(skipCharts) {
  const inv = PORTAL.investor;
  if (!inv) return;

  const totalInvested = PORTAL.investments.filter(i => i.status === 'active').reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  // Returns are posted by setting the pool's actual_rate, which the server joins onto
  // each investment as pool_actual_rate — and that happens while the pool is still
  // active. Gating this on status === 'matured' meant a posted return stayed invisible
  // here until the pool matured, even though My Investments and the statement already
  // counted it off the same field. Count anything matured OR carrying a posted rate.
  // Returns earned, via the shared definition in js/api.js so this tile, My
  // Investments, the statement and the admin console cannot drift apart again.
  const earningInvs   = (PORTAL.investments || []).filter(i => i.status !== 'cancelled');
  // Earned, not projected: only a declared return moves this figure or the
  // portfolio value beside it. The target is illustrative and shown separately.
  const totalRet      = Utils.earnedReturns(earningInvs);
  const earnedBase    = earningInvs
    .filter(i => Utils.postedReturn(i))
    .reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  const totalValue    = Utils.portfolioValue(PORTAL.investments, inv.wallet_balance);
  const returnPct     = earnedBase > 0 ? (totalRet / earnedBase * 100).toFixed(1) : '0';
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
  if (retEl2) {
    // Only posted returns appear against a holding. A benchmark belongs on the
    // pool, before investing — quoting it here reads as money in hand.
    retEl2.innerHTML = totalRet > 0
      ? `<i class="fa-solid fa-arrow-trend-up"></i> <span>+${returnPct}% return posted · ${Utils.rand(totalRet)} earned</span>`
      : `<i class="fa-solid fa-hourglass-half"></i> <span>No returns posted yet</span>`;
  }

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
  if (inv.date_joined || inv.created_at || inv.registration_date) {
    const since = new Date(inv.date_joined || inv.created_at || inv.registration_date);
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
      // Was hardcoded to "Payout", which is wrong whenever the instruction is to
      // reinvest — and wrong by default, since no instruction means auto-reinvest.
      nextTxt.textContent = `${Utils.maturityOutcome(upcoming[0]).label} in ${days}d`;
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
  const _ficaNP = _normFicaStatus(inv.fica_status);
  const ficaPending = _ficaNP === 'pending' || _ficaNP === 'not_started' || _ficaNP === 'submitted' || _ficaNP === 'in_progress' || inv.status === 'pending_fica';
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
        <div style="width:22px;height:22px;border-radius:50%;background:${s.done ? '#22c55e' : 'rgba(254,194,79,0.2)'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fa-solid ${s.done ? 'fa-check' : 'fa-' + s.icon}" style="font-size:0.65rem;color:${s.done ? '#fff' : '#fec24f'}"></i>
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
  // Anchor matches the hero KPI: active investments + wallet balance.
  const currentValue = Math.max(0,
    (parseFloat(PORTAL.investor?.wallet_balance) || 0) +
    (PORTAL.investments || []).filter(i => i.status === 'active').reduce((s, i) => s + (parseFloat(i.amount) || 0), 0)
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
        borderColor:          '#fec24f',
        borderWidth:          2.5,
        fill:                 true,
        backgroundColor: c => {
          const g = c.chart.ctx.createLinearGradient(0, 0, 0, c.chart.height);
          g.addColorStop(0, 'rgba(254,194,79,0.28)');
          g.addColorStop(1, 'rgba(254,194,79,0.01)');
          return g;
        },
        tension:              0.42,
        pointRadius:          3,
        pointBackgroundColor: '#fec24f',
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
          titleColor:       '#fec24f',
          bodyColor:        '#e5e7eb',
          borderColor:      'rgba(254,194,79,0.3)',
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

async function loadMyInvestments() {
  const grid = document.getElementById('myInvestmentsGrid');
  if (grid && !PORTAL.investments.length) grid.innerHTML = _skeletonCards(3);
  if (!PORTAL.investments.length) await loadPortalData();
  renderMyInvestmentStats();
  renderMyInvestmentCards();
}

function renderMyInvestmentStats() {
  const d = PORTAL.investments;

  /* Capital Deployed is present tense: money at work right now.

     It was `!is_reinvestment` across every status, which answers neither
     question cleanly and errs in both directions at once — it counted capital
     from investments that matured or paid out years ago, while excluding
     reinvestments, which are deployed capital. A rolled-over investment is
     working money whatever funded it.

     Active only, so nothing is double-counted: when an investment matures and
     rolls over, the original leaves this figure as the reinvestment enters. */
  document.getElementById('mi-capital').textContent = Utils.rand(
    d.filter(i => i.status === 'active')
     .reduce((s, i) => s + (parseFloat(i.amount) || 0), 0));

  // Earned means declared. 0 here is a true statement, not a missing figure.
  // Cumulative across the portfolio, which is what "earned" implies.
  document.getElementById('mi-earned').textContent   = Utils.rand(Utils.earnedReturns(d));
  document.getElementById('mi-count').textContent    = d.length;
}

function filterMyInvestments(filter, btn) {
  PORTAL.myInvFilter = filter;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderMyInvestmentCards();
  SVC.track('svc_filter_changed', { filter_type: 'my_investments', filter_value: filter });
}

function populateMyInvProductFilter() {
  const container = document.getElementById('myInvProductFilter');
  if (!container) return;
  const types = [...new Set((PORTAL.investments || []).map(i => i.product_type).filter(Boolean))];
  const cur = container.dataset.activeType || '';
  const items = [
    { value: '', icon: 'fa-layer-group', label: 'All' },
    ...types.map(t => {
      const pi = Utils.productInfo(t);
      return { value: t, icon: pi.icon, label: (pi.label || t).replace(/\s*\(\d+yr\)/gi, '').replace(/\s+Investments?\b/gi, '').trim(), color: pi.color };
    })
  ];
  container.innerHTML = items.map(item => `
    <button class="prod-type-tile${item.value === cur ? ' active' : ''}"
            data-type="${_esc(item.value)}"
            onclick="filterMyInvProduct('${_esc(item.value)}')"
            ${item.color ? `style="--tile-color:${item.color}"` : ''}>
      <i class="fa-solid ${item.icon}"></i>
      <span>${_esc(item.label)}</span>
    </button>`).join('');
}

function filterMyInvProduct(type) {
  const container = document.getElementById('myInvProductFilter');
  if (!container) return;
  container.dataset.activeType = type;
  container.querySelectorAll('.prod-type-tile').forEach(b =>
    b.classList.toggle('active', b.dataset.type === type)
  );
  renderMyInvestmentCards();
}

function _groupInvsByPool(investments) {
  const map = new Map();
  for (const inv of investments) {
    const key = inv.pool_id || ('_solo_' + inv.id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(inv);
  }
  for (const group of map.values()) {
    group.sort((a, b) => new Date(a.investment_date || a.start_date || a.created_at) - new Date(b.investment_date || b.start_date || b.created_at));
  }
  return [...map.values()];
}

function toggleInvBreakdown(uid) {
  const el = document.getElementById('breakdown-' + uid);
  const icon = document.getElementById('icon-' + uid);
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : 'block';
  if (icon) icon.className = open ? 'fa-solid fa-list' : 'fa-solid fa-list-ul';
}

function renderMyInvestmentCards() {
  populateMyInvProductFilter();
  const grid = document.getElementById('myInvestmentsGrid');
  const _pf = document.getElementById('myInvProductFilter');
  const productFilter = _pf?.dataset?.activeType || _pf?.value || '';
  let items = PORTAL.myInvFilter === 'all' ? PORTAL.investments : PORTAL.investments.filter(i => i.status === PORTAL.myInvFilter);
  if (productFilter) items = items.filter(i => i.product_type === productFilter);

  if (!items.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
  <i class="fa-solid fa-seedling" style="font-size:3rem;color:var(--gold);opacity:0.7;margin-bottom:16px;display:block"></i>
  <div class="empty-state__title">No investments yet</div>
  <div class="empty-state__sub">Start growing your wealth today.</div>
  <button onclick="navigate('marketplace',null)" class="btn--primary" style="margin-top:16px;padding:10px 24px;border-radius:8px;font-size:0.85rem;font-weight:700;border:none;cursor:pointer;background:linear-gradient(135deg,#fec24f,#fec24f);color:#000">Browse Investment Pools →</button>
</div>`;
    return;
  }

  // Soonest maturity first — what a client needs to act on comes first, not
  // whatever order the API happened to return.
  const groups = _groupInvsByPool(items).sort((a, b) => Utils.byGroupMaturity(a, b));

  grid.innerHTML = groups.map(group => {
    const inv = group[0];
    const pi = Utils.productInfo(inv.product_type);
    const days = Utils.daysRemaining(inv.maturity_date);
    const progress = days !== null ? Math.min(100, Math.max(0, 100 - (days / (365 * 1.5) * 100))) : 100;
    const isPaidOut = inv.status === 'matured' || inv.status === 'paid_out';
    const multiple = group.length > 1;
    const totalAmount = group.reduce((s, i) => s + (i.amount || 0), 0);
    // Posted only — the benchmark fallback here showed an unearned figure.
    const totalReturn = Utils.earnedReturns(group);
    /* Returns are posted by setting the pool's actual rate, and that happens
       while the pool is still active. The stats below only showed return
       figures once the investment had matured, so a client whose returns had
       already been declared saw nothing here — sometimes for months. null when
       nothing has been posted, which is what keeps a projection off the card. */
    const posted = Utils.postedReturnTotal(group);
    const uid = 'pool_' + (inv.pool_id || inv.id);
    const _poolRec = inv.pool_id ? (PORTAL.pools || []).find(p => p.id === inv.pool_id) : null;
    const _poolInvStart = _poolRec?.investment_start_date || (_poolRec?.end_date ? (() => { const _d = new Date(_poolRec.end_date); _d.setDate(_d.getDate() + 1); return _d.toISOString().split('T')[0]; })() : null);
    const _invStartDate = _poolInvStart || inv.investment_date || inv.start_date;

    const breakdownRows = multiple ? group.map(i => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid var(--border);font-size:0.78rem">
        <span style="color:var(--text-muted)">${Utils.date(i.investment_date || i.start_date || i.created_at)}</span>
        <span style="color:var(--gold);font-weight:700">${Utils.rand(i.amount)}</span>
      </div>`).join('') : '';

    return `
      <div class="my-inv-card ${isPaidOut ? 'my-inv-card--paidout' : ''}">
        <div class="my-inv-card__header">
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <i class="fa-solid ${pi.icon}" style="color:${pi.color}"></i>
              <span class="my-inv-card__name">${_esc(inv.pool_name)}</span>
            </div>
            <div class="my-inv-card__partner">${inv.investor_id}${multiple ? ` · <span style="color:var(--gold)">${group.length} investments</span>` : ''}</div>
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
          <div class="mic-stat"><span class="mic-stat__label">${multiple ? 'Total Invested' : 'Amount Invested'}</span><span class="mic-stat__value mic-stat__value--gold">${Utils.rand(totalAmount)}</span></div>
          <div class="mic-stat"><span class="mic-stat__label">Start Date</span><span class="mic-stat__value">${Utils.date(_invStartDate)}</span></div>
          <div class="mic-stat"><span class="mic-stat__label">Maturity Date</span><span class="mic-stat__value">${Utils.date(inv.maturity_date)}</span></div>
          ${isPaidOut ? `
          <div class="mic-stat"><span class="mic-stat__label">Return Rate</span><span class="mic-stat__value">${(() => { const _r = Utils.effectiveRate(inv); return _r != null ? Utils.pct(_r) : '—'; })()}</span></div>
          <div class="mic-stat"><span class="mic-stat__label">Capital + Return</span><span class="mic-stat__value" style="color:var(--green)">${Utils.rand(totalAmount + totalReturn)}</span></div>
          ` : posted ? `
          <div class="mic-stat"><span class="mic-stat__label">Actual Rate</span><span class="mic-stat__value" style="color:var(--green)">${Utils.pct(posted.rate)}</span></div>
          <div class="mic-stat"><span class="mic-stat__label">Returns Earned</span><span class="mic-stat__value" style="color:var(--green)">${Utils.rand(posted.amount)}</span></div>
          ` : ''}
        </div>

        ${multiple ? `
          <button class="btn btn--ghost btn--full btn--sm" onclick="toggleInvBreakdown('${uid}')" style="margin-top:4px;font-size:0.73rem">
            <i class="fa-solid fa-list" id="icon-${uid}"></i> View ${group.length} investments
          </button>
          <div id="breakdown-${uid}" style="display:none;padding:0 2px">
            ${breakdownRows}
          </div>
        ` : ''}

        ${inv.status === 'active' ? (() => {
          /* The button read "Set Maturity Instruction" whether or not one was
             already set, so the only way to find out was to open the modal —
             one investment at a time. State first, then an action that says
             what it will do. */
          const st = Utils.maturityInstructionState(group);
          const call = multiple
            ? `openPoolMaturityModal(${JSON.stringify(inv.pool_id)})`
            : `openMaturityModal(${JSON.stringify(inv.id)})`;

          const CUE = {
            all:     { icon: 'fa-circle-check',           color: '#22c55e', lead: 'Instruction set' },
            partial: { icon: 'fa-circle-half-stroke',     color: '#fec24f', lead: 'Partly set' },
            mixed:   { icon: 'fa-circle-half-stroke',     color: '#fec24f', lead: 'Instructions differ' },
            none:    { icon: 'fa-triangle-exclamation',   color: '#fec24f', lead: 'No instruction set' },
          }[st.state];

          // Only chase the client when the decision is actually close.
          const urgent = st.state !== 'all' && days !== null && days <= 30;
          const colour = st.state === 'all' ? CUE.color : (urgent ? '#ff5229' : CUE.color);

          return `
          <div style="display:flex;align-items:center;gap:7px;margin-top:8px;padding:7px 10px;border-radius:8px;
                      background:${colour}14;border:1px solid ${colour}33;font-size:0.74rem">
            <i class="fa-solid ${urgent && st.state !== 'all' ? 'fa-triangle-exclamation' : CUE.icon}" style="color:${colour}"></i>
            <span style="color:var(--text-muted)">${CUE.lead}</span>
            ${st.state === 'all' || st.state === 'partial' || st.state === 'mixed'
              ? `<span style="margin-left:auto;color:${colour};font-weight:700;text-align:right">${_esc(st.label)}</span>`
              : `<span style="margin-left:auto;color:${colour};font-weight:700">${urgent ? `${days} day${days === 1 ? '' : 's'} left` : 'Optional for now'}</span>`}
          </div>
          <button class="btn btn--secondary btn--full btn--sm" onclick='${call}' style="margin-top:6px;font-size:0.76rem">
            <i class="fa-solid ${st.state === 'none' ? 'fa-hourglass-half' : 'fa-pen-to-square'}"></i>
            ${st.state === 'none' ? 'Set Maturity Instruction' : 'Change Maturity Instruction'}
          </button>`;
        })() : ''}
      </div>
    `;
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
  const typeColor = { return: '#22c55e', payout: '#fec24f', referral_bonus: '#eda5ff' };

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
    // Through the shared definition. This element is also written by
    // renderPortfolioHero; the two used different formulas, so which figure a
    // client saw depended on which rendered last.
    const totalValue   = Utils.portfolioValue(PORTAL.investments, balance);
    const povTotal = document.getElementById('pov-total');
    if (povTotal) povTotal.textContent = Utils.rand(totalValue);
  }
}

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
    const statusTag = t.status === 'pending' ? ' <span style="font-size:0.7rem;background:rgba(254,194,79,0.15);color:#fec24f;padding:1px 6px;border-radius:4px;font-weight:600">Pending</span>' :
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

  const PRODUCT_LABELS = { cattle:'Cattle Finance', solar_7yr:'Solar Energy 7yr', solar_6yr:'Solar Energy 6yr', solar_5yr:'Solar Energy 5yr', short_term:'Short Term', smme:'Short Term', delivery_bike:'Delivery Bike', other:'Other' };
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
      <div class="wallet-card__value" style="color:#fec24f">${Utils.rand(inv.recurring_amount)}<span style="font-size:0.85rem;font-weight:500;color:#6b7280;margin-left:4px">/ month</span></div>
      <div class="wallet-card__sub"><i class="fa-solid fa-layer-group" style="margin-right:4px"></i>${PRODUCT_LABELS[productType] || productType} &nbsp;·&nbsp; Every ${day}${suffix} of the month &nbsp;·&nbsp; Next in <strong>${daysUntil} day${daysUntil !== 1 ? 's' : ''}</strong></div>
      <div class="wallet-card__actions">
        <button class="btn btn--secondary" onclick="openRecurringModal()"><i class="fa-solid fa-pen"></i> Edit</button>
        <button class="btn btn--secondary" style="color:#ef4444;border-color:rgba(239,68,68,0.3)" onclick="_cancelRecurring()"><i class="fa-solid fa-xmark"></i> Cancel</button>
      </div>`;
  } else {
    statusCard.innerHTML = `
      <div class="wallet-card__label">Recurring Investment</div>
      <div class="wallet-card__value" style="font-size:1.1rem;color:#9ca3af">Not active</div>
      <div class="wallet-card__sub">Automate monthly investments into any open pool each month</div>
      <div class="wallet-card__actions">
        <button class="btn btn--primary" onclick="openRecurringModal()"><i class="fa-solid fa-plus"></i> Set Up Recurring</button>
      </div>`;
  }

  // Show all active investments placed by the recurring cron (INV-RC- prefix),
  // plus any active investments matching the currently configured product type
  const recurringInvs = (PORTAL.investments || []).filter(i =>
    i.status === 'active' && (
      (i.id && i.id.startsWith('INV-RC-')) ||
      (productType && i.product_type === productType)
    )
  );

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
        <div style="width:42px;height:42px;border-radius:10px;background:rgba(254,194,79,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fa-solid fa-rotate" style="color:#fec24f;font-size:1.1rem"></i>
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
        <div style="width:42px;height:42px;border-radius:10px;background:rgba(254,194,79,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fa-solid fa-rotate" style="color:#fec24f;font-size:1.1rem"></i>
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
  const isEnabled = !!settings.auto_topup_enabled;
  if (el('atuEnabled'))  el('atuEnabled').checked = isEnabled;
  // Sync the custom toggle span colour to match the checkbox state
  const toggleSpan = el('autoTopUpModal').querySelector('label span');
  if (toggleSpan) toggleSpan.style.background = isEnabled ? '#fec24f' : '#ccc';
  if (el('atuAmount'))   el('atuAmount').value    = settings.auto_topup_amount || '';
  if (el('atuDay'))      el('atuDay').value       = settings.auto_topup_day || 1;
  updateAutoTopUpFee();
  Modal.open('autoTopUpModal');
}

function updateAutoTopUpFee() {
  const net = parseFloat(document.getElementById('atuAmount')?.value) || 0;
  const bd  = document.getElementById('atuFeeBreakdown');
  if (!bd) return;
  if (net < 50) { bd.style.display = 'none'; return; }
  const rawFee = _pmFee(net);
  const fee    = Math.min(rawFee, 800);
  const gross  = Math.round((net + fee) * 100) / 100;
    const fmt    = v => Utils.rand(v);   // was a hand-rolled 'R 1 234.56' — one formatter now
  bd.style.display = 'block';
  document.getElementById('atuFeeNet').textContent   = fmt(net);
  document.getElementById('atuFeeAmt').textContent   = '+ ' + fmt(Math.round(fee * 100) / 100);
  document.getElementById('atuFeeGross').textContent = fmt(gross);
}

async function saveAutoTopUp() {
  const el = id => document.getElementById(id);
  const enabled = el('atuEnabled')?.checked;
  const amount  = parseFloat(el('atuAmount')?.value);
  const day     = parseInt(el('atuDay')?.value, 10);

  if (enabled) {
    if (!amount || amount < 50) return Toast.error('Minimum auto top-up is R50');
    if (!day || day < 1 || day > 31) return Toast.error('Day must be between 1 and 31');
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

async function loadPaymentConfig() {
  try {
    const cfg = await API._fetch('GET', 'payments/config');
    if (cfg.paystackPublicKey) PAYSTACK_PUBLIC_KEY = cfg.paystackPublicKey;
  } catch (e) {
    console.warn('[portal] Could not load payment config — using fallback key');
  }
}

function _trackFunnel(event_type, params = {}) {
  const token = localStorage.getItem('svc_token') || sessionStorage.getItem('svc_token');
  if (!token) return;
  fetch('/api/analytics/invest-funnel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    credentials: 'include',
    body: JSON.stringify({ event_type, ...params }),
  }).catch(() => {});
}

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

function _pmTotal(baseAmount) { return Math.round((baseAmount + _pmFee(baseAmount)) * 100) / 100; }

function updateAmountPreview() {
  const raw = parseFloat(_pmEl('pmAmount').value);
  const hint = _pmEl('pmAmountHint');
  if (!raw || raw < 100) {
    hint.textContent = raw > 0 && raw < 100 ? 'Amount too low — minimum is R100' : 'Minimum deposit: R100';
    hint.style.color = raw > 0 && raw < 100 ? '#ef4444' : 'var(--text-muted)';
  } else {
    hint.textContent = `${Utils.rand(raw)} will be credited to your SV Capital wallet`;
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
      <span style="color:#f0f4ff;font-weight:600;font-size:0.78rem">${Utils.rand(_pmAmount)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.07)">
      <span style="color:#9ca3af;font-size:0.78rem">Gateway fee (2.9% + R1)</span>
      <span style="color:#fec24f;font-weight:600;font-size:0.78rem">+ ${Utils.rand(fee)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:8px 0">
      <span style="color:#f0f4ff;font-size:0.82rem;font-weight:700">Total charged to you</span>
      <span style="color:#fec24f;font-size:0.88rem;font-weight:900">${Utils.rand(total)}</span>
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
  _pmEl('pmAmountDisplay').textContent = `${Utils.rand(raw)}`;

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
        channels: ['card'],  // card-only so we always get a reusable auth for auto top-up
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
          SVC.track('svc_topup_cancelled', { amount: _pmAmount, currency: 'ZAR', gateway: 'paystack' });
          _trackFunnel('topup_cancelled', { gateway: 'paystack', amount_bucket: _amtBucket(_pmAmount) });
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
  _pmEl('eftAmountDisplay').textContent = `${Utils.rand(_pmAmount)}`;

  let eftRef = investorId;
  let hintHtml = 'Always use your <strong style="color:#f0f4ff">Investor ID as the payment reference</strong> so we can match your deposit. Funds reflect within 1–2 business days.';
  if (_pmSaId) {
    const sa = (PORTAL.subAccounts || []).find(s => s.id === _pmSaId);
    if (sa?.sa_reference) {
      eftRef = sa.sa_reference;
      hintHtml = `Always use the <strong style="color:#f0f4ff">Sub-Account Reference (${sa.sa_reference})</strong> as your payment reference so we can credit the correct sub-account. Funds reflect within 1–2 business days.`;
    }
  }
  _pmEl('eftReference').textContent = eftRef;
  const hint = document.getElementById('eftRefHint');
  if (hint) hint.innerHTML = hintHtml;

  _pmShowOnly('pmStep3Eft');
  _pmSetProgress(100);
  _pmSetStepLabel('Step 3 of 3 — Bank Transfer');
}

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
    let description = `EFT wallet top-up of ${Utils.rand(amount)} submitted by ${investorName} (${investorId}). Reference: ${ref}.`;

    if (_eftProofFile && _eftProofBase64) {
      description += `\n\nProof of payment attached: ${_eftProofFile.name} (${(_eftProofFile.size/1024).toFixed(1)} KB).`;
    } else {
      description += '\n\nNo proof of payment was uploaded. Investor was advised to email admin@svcapital.co.za.';
    }

    await API.tickets.create({
      id:            Utils.genId('TKT'),
      investor_id:   investorId,
      investor_name: investorName,
      subject:       `EFT Proof of Payment — ${investorName} — ${Utils.rand(amount)} — ${ref}`,
      category:      'payment_proof',
      priority:      'high',
      status:        'open',
      message:       description,
      proof_filename: _eftProofFile ? _eftProofFile.name : '',
      proof_attached: !!_eftProofFile,
      file_url:       _eftProofBase64 || null,
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
  const fmtBase = `${Utils.rand(_pmAmount)}`;
  _pmEl('pmSuccessAmount').innerHTML =
    `<strong style="color:#22c55e">${fmtBase}</strong> successfully credited to your wallet` +
    (fee > 0 ? `<br><span style="font-size:0.75rem;color:#6b7280">${Utils.rand(fee)} gateway fee charged by Paystack</span>` : '');
  _pmEl('pmSuccessRef').textContent = `Reference: ${reference}`;
  showSuccessOverlay({ title: 'Payment Received!', subtitle: `${fmtBase} added to your wallet` });
  await loadPortalData();
  if (_pmSaId) await loadSubAccounts();
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
    : `Wallet top-up via ${gatewayLabel} — ${Utils.rand(_pmAmount)} credited to wallet`;

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
            renderSubAccountsView();
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
        const fmtBase = `${Utils.rand(_pmAmount)}`;
        _pmEl('pmSuccessAmount').textContent = `${fmtBase} deposit registered — awaiting bank confirmation`;
        _pmEl('pmSuccessRef').textContent = `Reference: ${reference}`;
        await loadPortalData();
        if (_pmSaId) await loadSubAccounts();
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

function filterMarket(type, btn) {
  PORTAL.marketFilter = type;
  const bar = document.getElementById('marketRiskTabBar');
  if (bar) bar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderMarketplace();
  if (bar) bar.style.display = '';   // renderMarketplace hides .tab-bar; keep risk filter visible
  SVC.track('svc_filter_changed', { filter_type: 'marketplace_risk', filter_value: type });
}

function _productRisk(productType) {
  const p = (_mktProducts || []).find(pr => pr.product_type === productType);
  const risk = (p && p.risk_profile) ? p.risk_profile : 'Medium';
  const color = (p && p.risk_color) ? p.risk_color : (_RISK_COLORS[risk] || '#fec24f');
  return { risk, color };
}

/* ═══════════════════════════════════════════════════════════════════════
   Ethical and Interest-Free (EIF)
   ═══════════════════════════════════════════════════════════════════════

   A sub-category of the same marketplace, not a second one. EIF products are
   ordinary rows in `products` carrying category = 'eif'; they are pooled,
   filled, invested in and matured by the machinery every other product uses.
   What changes here is presentation and vocabulary.

   The vocabulary is the point. A client who will not take riba is not served
   by a screen that offers them a "target return p.a." on a Murabaha — the
   number may be right and the word still wrong. So the same fields are read
   and different labels are drawn over them.

   The offering appears only while an active EIF product exists. Deactivating
   all three in the admin console takes the tab, the banner and the FAQ off the
   portal — the is_active switch the platform already has, rather than a second
   flag somebody has to remember. */

function EIF_ACCENT()   { return '#65ed00'; }        /* CI lime — see css/ci-theme.css */
function EIF_CATEGORY() { return 'eif'; }
function EIF_LABEL()    { return 'Ethical &amp; Interest-Free'; }
/* A leaf, not a mosque. The offering is built for clients who will not take
   riba, but the name they gave it is not a denominational one and neither is
   the eligibility — a client of any faith or none can hold these. A religious
   mark on the tab, and on the badge these products carry out in the
   all-products grid, would narrow an offering that is deliberately open. */
function EIF_ICON()     { return 'fa-leaf'; }

function _isEifProduct(p) { return ((p && p.category) || 'standard') === EIF_CATEGORY(); }

function _eifProducts() {
  return (_mktProducts || []).filter(p => p && p.is_active && _isEifProduct(p));
}

/* Whether the offering exists at all on this environment. */
function _eifIsLive() { return _eifProducts().length > 0; }

function _mktCategory() { return PORTAL.marketCategory || 'all'; }

/* The category tabs, drawn above the risk filter. Only rendered when there is
   a second category to choose — on an environment with no EIF products this
   returns the marketplace exactly as it was. */
function renderMarketCategoryTabs() {
  const host = document.getElementById('mktCategoryTabs');
  if (!host) return;
  if (!_eifIsLive() || _selectedProductType) { host.innerHTML = ''; host.style.display = 'none'; return; }
  const cur = _mktCategory();
  const accent = EIF_ACCENT();
  host.style.display = '';
  host.innerHTML = `
    <button class="mkt-cat-tab${cur === 'all' ? ' active' : ''}" onclick="filterMarketCategory('all', this)">
      <i class="fa-solid fa-layer-group"></i><span>All products</span>
    </button>
    <button class="mkt-cat-tab mkt-cat-tab--eif${cur === 'eif' ? ' active' : ''}"
            style="--cat-accent:${accent}" onclick="filterMarketCategory('eif', this)">
      <i class="fa-solid ${EIF_ICON()}"></i><span>${EIF_LABEL()}</span>
    </button>`;
}

function filterMarketCategory(cat, btn) {
  PORTAL.marketCategory = cat;
  const host = document.getElementById('mktCategoryTabs');
  if (host) host.querySelectorAll('.mkt-cat-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  /* Leaving a product detail open while the category changes under it would
     show a conventional product inside the EIF section. */
  _selectedProductType = null;
  renderMarketplace();
  SVC.track('svc_filter_changed', { filter_type: 'marketplace_category', filter_value: cat });
}

/* The headline figure's label. Same number as every other product — this is
   `benchmark_rate` or the achieved average — under a word that does not
   describe it as a rate of interest on money lent. */
function _rateSubLabel(p, isAvg, termMonths) {
  if (_isEifProduct(p)) {
    /* No period suffix. EIF benchmark_rate is annualised on every one of these
       products, and an early draft appended the term to all of them — which
       put "TARGET PROFIT SHARE (36 MO)" beside 12.5% on the Ijara, saying the
       lease pays 12.5% over three years rather than each year. The suffix
       exists for short_term, whose stored rate really is a period rate. */
    return isAvg ? 'PROFIT SHARE ACHIEVED P.A.' : 'TARGET PROFIT SHARE P.A.';
  }
  const isSt = p.product_type === 'short_term';
  if (isAvg) return isSt && termMonths ? `AVG RETURN (${termMonths} MO)` : 'AVG RETURN P.A.';
  return isSt && termMonths ? `TARGET RETURN (${termMonths} MO)` : 'TARGET RETURN P.A.';
}

/* The section header. States the principles and says plainly where the
   governance stands — the copy claims no certificate, because there is not one
   yet. The wording lives in a row (product_faqs, "Is this offering Sharia
   certified?") so it can be corrected without a deploy; this strip is the
   short version and is deliberately the same claim. */
function _eifBannerHtml() {
  const a = EIF_ACCENT();
  const principles = [
    ['fa-ban',            'No riba',          'Return comes from trade, rent or enterprise — never from lending money.'],
    ['fa-cubes',          'Backed by assets', 'Every structure sits on goods, an asset or a business that actually exists.'],
    ['fa-scale-balanced', 'Shared risk',      'If the underlying venture does not perform, neither does the return.'],
    ['fa-filter-circle-xmark', 'Screened sectors', 'No conventional lending, alcohol, tobacco, pork, gambling or weapons.'],
  ];
  return `
    <div class="eif-banner" style="--eif:${a}">
      <div class="eif-banner__head">
        <div class="eif-banner__mark"><i class="fa-solid ${EIF_ICON()}"></i></div>
        <div>
          <div class="eif-banner__title">Ethical &amp; Interest-Free</div>
          <div class="eif-banner__sub">Investments structured so the return is earned by trade, by ownership or by enterprise — not by charging for the use of money.</div>
        </div>
      </div>
      <div class="eif-principles">
        ${principles.map(([icon, t, d]) => `
          <div class="eif-principle">
            <i class="fa-solid ${icon}"></i>
            <div><strong>${t}</strong><span>${d}</span></div>
          </div>`).join('')}
      </div>
      <div class="eif-governance">
        <i class="fa-solid fa-circle-info"></i>
        <span><strong>Sharia advisory review is under way.</strong> These products are structured on established Islamic finance principles. We do not yet hold a Sharia certificate and do not claim one — the advisor, certificate and date will be published here as soon as it is issued. Please take your own advice in the meantime.</span>
      </div>
    </div>`;
}

/* ── The offering's FAQ ────────────────────────────────────────────────────
   Rows from product_faqs, not markup. Cached on PORTAL for the session; a
   failure leaves the section without its FAQ rather than without its
   products. */
async function loadEifFaqs() {
  if (PORTAL.eifFaqs) return PORTAL.eifFaqs;
  try {
    const res = await API._fetch('GET', 'products/faqs', null, { category: 'eif' });
    PORTAL.eifFaqs = (res && res.data) || [];
  } catch (err) {
    console.warn('[eif] could not load FAQs:', err);
    PORTAL.eifFaqs = [];
  }
  return PORTAL.eifFaqs;
}

function _eifFaqHtml(faqs) {
  if (!faqs || !faqs.length) return '';
  return `
    <div class="panel eif-faq" style="--eif:${EIF_ACCENT()};margin-top:20px">
      <div class="panel__header"><span class="panel__title">Questions about this offering</span></div>
      <div class="panel__body">
        ${faqs.map(f => `
          <div class="faq-quick-item">
            <button class="faq-quick-q" onclick="toggleQuickFaq(this)">${_esc(f.question)}<i class="fa-solid fa-chevron-down"></i></button>
            <div class="faq-quick-a">${_esc(f.answer)}</div>
          </div>`).join('')}
      </div>
    </div>`;
}

/* ── The interest-free election ────────────────────────────────────────────
   The platform credits interest imported from 3PIM into investor wallets. A
   client who chose this offering keeps their money in that same wallet, so
   this is where they say they do not want it. Not implied by holding an EIF
   product — some clients hold both kinds and want the interest. */
async function loadEifElection() {
  try {
    const res = await API._fetch('GET', 'products/eif/election');
    PORTAL.eifElection = !!(res && res.interest_free_election);
  } catch (err) {
    console.warn('[eif] could not read the interest election:', err);
    PORTAL.eifElection = null;          // unknown — the toggle says so
  }
  return PORTAL.eifElection;
}

function _eifElectionHtml() {
  const on = PORTAL.eifElection === true;
  const unknown = PORTAL.eifElection === null || PORTAL.eifElection === undefined;
  return `
    <div class="eif-election" style="--eif:${EIF_ACCENT()}">
      <div class="eif-election__text">
        <strong>Decline interest on my wallet balance</strong>
        <span>Money waiting in your wallet sits in the platform's client account, and interest earned on it is normally credited to you each period. Turn this on and none of it will be paid into your wallet or your sub-accounts.</span>
      </div>
      ${unknown
        ? '<span class="eif-election__err">Could not load this setting — reload the page to try again.</span>'
        : `<button class="eif-switch${on ? ' on' : ''}" role="switch" aria-checked="${on}"
                   aria-label="Decline interest on my wallet balance"
                   onclick="toggleEifElection(${on ? 'false' : 'true'})"><span></span></button>`}
    </div>`;
}

async function toggleEifElection(next) {
  const want = next === true;
  try {
    await API._fetch('PUT', 'products/eif/election', { interest_free_election: want });
    PORTAL.eifElection = want;
    Toast.success(want
      ? 'Interest will no longer be credited to your wallet.'
      : 'Interest will be credited to your wallet again.');
  } catch (err) {
    console.error('[eif] could not save the interest election:', err);
    Toast.error('Could not save that — please try again.');
  }
  renderMarketplace();
}

function renderMarketplace() {
  // Risk filter bar: visible on the product grid, hidden inside a product detail
  const tabBar = document.getElementById('marketRiskTabBar');
  if (tabBar) tabBar.style.display = _selectedProductType ? 'none' : '';
  /* The two shells title this view differently — .section-banner__title on the
     web, .mkt-hero__title in the app. Ask for both; whichever is absent is
     null and the assignment below is skipped. */
  const banner = document.querySelector('#view-marketplace .section-banner__title')
              || document.querySelector('#view-marketplace .mkt-hero__title');
  renderMarketCategoryTabs();
  if (_selectedProductType) { if (banner) banner.textContent = 'Product Details'; renderProductDetailView(_selectedProductType); }
  else {
    if (banner) banner.textContent = _mktCategory() === 'eif' ? 'Ethical & Interest-Free' : 'Investment Products';
    renderProductsGrid();
  }

  // Sub-account context banner
  let saBanner = document.getElementById('mktSaContextBanner');
  if (_pmSaId) {
    const _sa = (PORTAL.subAccounts || []).find(s => s.id === _pmSaId);
    if (_sa) {
      if (!saBanner) {
        saBanner = document.createElement('div');
        saBanner.id = 'mktSaContextBanner';
        saBanner.style.cssText = 'margin-bottom:14px;padding:10px 14px;border-radius:10px;background:rgba(237,165,255,0.1);border:1px solid rgba(237,165,255,0.3);display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:0.83rem';
        const grid = document.getElementById('marketplaceGrid');
        if (grid) grid.before(saBanner);
      }
      saBanner.innerHTML = `<span style="display:flex;align-items:center;gap:8px"><i class="fa-solid fa-wallet" style="color:#eda5ff"></i> Investing from sub-account <strong style="color:#eda5ff">${_esc(_sa.name)}</strong> &mdash; available: <strong>${Utils.rand(parseFloat(_sa.wallet_balance)||0)}</strong></span><button class="btn btn--ghost btn--sm" style="white-space:nowrap" onclick="_cancelSaInvestMode()"><i class="fa-solid fa-xmark"></i> Cancel</button>`;
      saBanner.style.display = 'flex';
    }
  } else if (saBanner) {
    saBanner.style.display = 'none';
  }
}

function _cancelSaInvestMode() {
  _pmSaId = null;
  renderMarketplace();
}

function renderProductsGrid() {
  const grid = document.getElementById('marketplaceGrid');
  if (!grid) return;
  const strip = document.getElementById('mktWalletStrip');
  const _saGrid = _pmSaId ? (PORTAL.subAccounts || []).find(s => s.id === _pmSaId) : null;
  const walletBal = _saGrid ? (parseFloat(_saGrid.wallet_balance) || 0) : (parseFloat(PORTAL.investor?.wallet_balance) || 0);
  if (strip) {
    strip.style.display = 'flex';
    const balEl = document.getElementById('mktWalletBal');
    if (balEl) { balEl.textContent = (_saGrid ? _saGrid.name + ': ' : '') + Utils.rand(walletBal); balEl.style.color = walletBal >= 500 ? 'var(--green)' : 'var(--gold)'; }
  }

  /* The EIF section header, above the grid. Drawn as its own node so the grid
     itself stays a plain product grid — the section is a frame around the same
     component, not a second implementation of it. */
  const inEif = _mktCategory() === 'eif';
  let eifHead = document.getElementById('eifSectionHead');
  if (inEif) {
    if (!eifHead) {
      eifHead = document.createElement('div');
      eifHead.id = 'eifSectionHead';
      grid.before(eifHead);
    }
    eifHead.innerHTML = _eifBannerHtml() + _eifElectionHtml();
    eifHead.style.display = '';
    /* Both are fetched once and re-render when they land. */
    if (PORTAL.eifElection === undefined) loadEifElection().then(renderMarketplace);
    if (!PORTAL.eifFaqs) loadEifFaqs().then(renderMarketplace);
  } else if (eifHead) {
    eifHead.style.display = 'none';
  }

  let eifFaq = document.getElementById('eifSectionFaq');
  if (inEif && PORTAL.eifFaqs && PORTAL.eifFaqs.length) {
    if (!eifFaq) {
      eifFaq = document.createElement('div');
      eifFaq.id = 'eifSectionFaq';
      grid.after(eifFaq);
    }
    eifFaq.innerHTML = _eifFaqHtml(PORTAL.eifFaqs);
    eifFaq.style.display = '';
  } else if (eifFaq) {
    eifFaq.style.display = 'none';
  }

  // First-time explainer strip — for users who have never invested
  const _mktHasInvested = (PORTAL.investments || []).length > 0;
  let _mktLearnStrip = document.getElementById('mktFirstTimeStrip');
  /* Not inside the EIF section: its banner already explains what these are and
     two stacked explainer strips read as clutter rather than as help. */
  if (!_mktHasInvested && !inEif) {
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
  // Filtered by risk level (Conservative / Moderate / Aggressive).
  const mf = PORTAL.marketFilter || 'all';
  /* The category narrows first, then risk within it. "All products" really is
     all of them — an EIF product is a product, and a client browsing
     everything should see it, badged. The EIF tab is the one that excludes. */
  const cat = _mktCategory();
  const products = (_mktProducts || []).filter(p => {
    if (!p.is_active) return false;
    if (cat === 'eif' && !_isEifProduct(p)) return false;
    if (mf === 'all') return true;
    return (p.risk_profile || 'Medium') === mf;   // risk from the product (admin console)
  }).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const shown = products
    .map(p => ({ p, open: _openPoolsForProduct(p.product_type) }))
    .sort((a, b) => (b.open.length > 0) - (a.open.length > 0));

  if (!shown.length) {
    /* Inside a section, an empty grid usually means the risk filter excluded
       everything rather than that the section is empty. Saying "no products
       available" there sends the reader looking for a fault that is one tab
       away. */
    const filteredOut = inEif && mf !== 'all' && _eifProducts().length > 0;
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <i class="fa-solid fa-box-open"></i>
      <div class="empty-state__title">${filteredOut ? `No ${_esc(mf)} products in this section` : 'No products available yet'}</div>
      <div class="empty-state__sub">${filteredOut
        ? 'Set the risk filter back to All to see the rest of the Ethical &amp; Interest-Free range.'
        : 'New investment products are added regularly — check back soon or ask a question.'}</div>
      <div style="margin-top:12px">${filteredOut
        ? `<button class="btn btn--primary btn--sm" onclick="filterMarket('all', document.querySelector('#marketRiskTabBar .tab-btn'))">Show all risk levels</button>`
        : `<button class="btn btn--primary btn--sm" onclick="navigate('support', document.querySelector('[data-view=support]'))"><i class="fa-solid fa-headset"></i> Ask a question</button>`}</div>
    </div>`;
    return;
  }

  grid.innerHTML = shown.map(({ p, open }) => {
    const pi = Utils.productInfo(p.product_type);
    const color = Utils.productColor(p);
    const icon = p.icon || pi.icon;
    const avg = p.avg_actual_rate > 0 ? parseFloat(p.avg_actual_rate) : null;
    const poolRate = open[0] ? parseFloat(open[0].annual_rate) : null;
    const rateLabel = avg != null ? `${(avg * 100).toFixed(2)}%` : (p.benchmark_rate ? `${(parseFloat(p.benchmark_rate) * 100).toFixed(1)}%` : (poolRate != null ? `${(poolRate * 100).toFixed(1)}%` : '—'));
    const termMonths = p.term_months || (open[0] && open[0].term_months) || null;
    const rateSub = _rateSubLabel(p, avg != null, termMonths);
    const eif = _isEifProduct(p);
    // soonest closing among the open pools
    const days = open.map(o => Utils.daysRemaining(o.end_date)).filter(d => d !== null);
    const soonest = days.length ? Math.min(...days) : null;
    return `
      <div class="market-pool-card mpc-v2${eif ? ' mpc-v2--eif' : ''}" style="cursor:pointer" onclick="openProductDetail('${p.product_type}')">
        <div class="mpc2-accent" style="background:linear-gradient(90deg,${color},${color}88)"></div>
        <div class="mpc2-top">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
            <div class="mpc2-icon" style="background:${color}18;color:${color}"><i class="fa-solid ${icon}"></i></div>
            <span class="mpc2-badge" style="background:${color}14;color:${color};border-color:${color}30">${open.length ? `${open.length} open pool${open.length === 1 ? '' : 's'}` : 'Details & factsheets'}</span>
          </div>
          ${eif && cat !== 'eif' ? `<div class="eif-tag"><i class="fa-solid ${EIF_ICON()}"></i> Interest-free</div>` : ''}
          <div style="margin-top:14px">
            <div class="mpc2-title">${_esc((p.label || '').replace(/\s*\(\d+yr\)/gi, '').trim())}</div>
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
            <div class="mpc2-metric__val">${termMonths || '—'}<span style="font-size:1rem;opacity:0.7">mo</span></div>
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

function _renderProductGrowthChart(rate, termMonths, color) {
  const canvas = document.getElementById('prodGrowthChart');
  if (!canvas || typeof Chart === 'undefined') return;
  try { if (_prodGrowthChart) { _prodGrowthChart.destroy(); _prodGrowthChart = null; } } catch (_) {}
  const months = Math.max(1, Math.min(120, parseInt(termMonths) || 12));
  const labels = [], data = [];
  for (let m = 0; m <= months; m++) { labels.push(m === 0 ? 'Start' : `M${m}`); data.push(Math.round(10000 * Math.pow(1 + rate, m / 12))); }
  _prodGrowthChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets: [{ data, borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => Utils.rand(c.parsed.y) } } },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6, color: 'rgba(0,0,0,0.4)', font: { size: 9 } } },
                y: { ticks: { callback: v => 'R' + (v / 1000).toFixed(0) + 'k', color: 'rgba(0,0,0,0.4)', font: { size: 9 } }, grid: { color: 'rgba(0,0,0,0.05)' } } },
    },
  });
}

async function _getTrackRecord() {
  if (_trackRecordCache) return _trackRecordCache;
  try { const r = await API._fetch('GET', 'products/track-record'); _trackRecordCache = r.data || {}; }
  catch (_) { _trackRecordCache = {}; }
  return _trackRecordCache;
}

function _fmtShort(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return 'R' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return 'R' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return 'R' + (n / 1e3).toFixed(1) + 'K';
  return 'R' + n.toFixed(0);
}

async function _renderProductTrackRecord(type, color) {
  const el = document.getElementById('prodTrackRecord');
  if (!el) return;
  el.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> Loading past performance…</div>`;
  try {
  const data = await _getTrackRecord();
  const isSolar = (type || '').startsWith('solar');
  const keys = Object.keys(data).filter(k => isSolar ? k.startsWith('solar') : k === type);
  let pools = [], paidBack = 0, sumA = 0, nA = 0, nTotal = 0;
  keys.forEach(k => {
    const d = data[k];
    pools = pools.concat(d.pools || []);
    paidBack  += d.total_paid_back || 0;
    sumA      += (d.avg_actual_rate || 0) * (d.matured_count || 0);
    nA        += d.matured_count || 0;
    nTotal    += d.matured_count || 0;
  });
  if (!nTotal) { el.innerHTML = ''; return; }
  pools.sort((a, b) => new Date(b.ended) - new Date(a.ended)); // newest first

  const avgRate = nA ? (sumA / nA * 100).toFixed(2) : '—';

  const poolRows = pools.map(p => {
    const rateColor = p.actual_rate > 0 && p.benchmark_rate > 0
      ? (p.actual_rate >= p.benchmark_rate ? '#22c55e' : '#f59e0b')
      : '#9ca3af';
    const statusLabel = p.status === 'paid_out' ? 'Paid Out' : 'Matured';
    const statusColor = p.status === 'paid_out' ? '#22c55e' : '#eda5ff';
    return `<tr>
      <td style="font-weight:600;font-size:0.82rem">${_esc(p.name)}</td>
      <td style="text-align:center;font-size:0.82rem">${p.term_months ? p.term_months + ' mo' : '—'}</td>
      <td style="text-align:center">
        <span style="font-weight:700;color:${rateColor};font-size:0.85rem">${p.actual_rate > 0 ? (p.actual_rate * 100).toFixed(2) + '%' : '—'}</span>
        ${p.benchmark_rate > 0 ? `<div style="font-size:0.68rem;color:var(--text-muted)">target ${(p.benchmark_rate * 100).toFixed(2)}%</div>` : ''}
      </td>
      <td style="text-align:right;font-size:0.82rem;font-variant-numeric:tabular-nums">${(p.live_raised ?? p.raised_amount ?? 0) > 0 ? Utils.rand(p.live_raised ?? p.raised_amount) : '—'}</td>
      <td style="text-align:center;font-size:0.78rem;color:var(--text-muted)">${p.ended ? Utils.date(p.ended) : '—'}</td>
      <td style="text-align:center"><span style="font-size:0.7rem;font-weight:700;color:${statusColor};background:${statusColor}18;border-radius:20px;padding:2px 9px">${statusLabel}</span></td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div style="margin-bottom:6px">
      <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);margin-bottom:12px">
        <i class="fa-solid fa-chart-line" style="color:${color};margin-right:5px"></i>Past Performance
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px">
        <div style="background:${color}12;border:1px solid ${color}30;border-radius:12px;padding:12px 8px;text-align:center;min-width:0">
          <div style="font-size:clamp(0.85rem,4vw,1.5rem);font-weight:900;color:${color};letter-spacing:-0.02em;overflow-wrap:break-word">${avgRate}%</div>
          <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-top:3px">${_isEifProduct((_mktProducts || []).find(x => x.product_type === type)) ? 'Avg profit share p.a.' : 'Avg return p.a.'}</div>
        </div>
        <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px 8px;text-align:center;min-width:0">
          <div style="font-size:clamp(0.85rem,4vw,1.5rem);font-weight:900;color:var(--text);letter-spacing:-0.02em;overflow-wrap:break-word">${nTotal}</div>
          <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-top:3px">Pool${nTotal === 1 ? '' : 's'} completed</div>
        </div>
        <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px 8px;text-align:center;min-width:0">
          <div style="font-size:clamp(0.85rem,4vw,1.5rem);font-weight:900;color:var(--text);letter-spacing:-0.02em;white-space:nowrap">${_fmtShort(paidBack)}</div>
          <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-top:3px">Invested to date</div>
        </div>
      </div>

      <p style="font-size:0.65rem;color:var(--text-muted);margin-top:10px;line-height:1.5;opacity:0.7">
        <i class="fa-solid fa-circle-info" style="margin-right:4px"></i>Past performance is not a guarantee of future returns. Investment returns may vary.
      </p>
    </div>`;
  } catch (e) {
    el.innerHTML = '';
  }
}

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

/* ── Factsheets & documents ────────────────────────────────────────────
   This is an archive, and it grows by one sheet a month for as long as a
   product exists. Rendered flat it was a wall of near-identical rows —
   "April 2025 - Factsheet", "October 2023 - Factsheet" — in the order the
   API happened to return them, each stamped with its UPLOAD date, which for
   a bulk import is the same day for all of them. Nothing to scan by, and it
   pushed the open pools off the bottom of the screen.

   So: newest first, by the period in the sheet's own name rather than by
   when someone uploaded it; grouped by year; the recent handful shown and
   the rest behind one tap; and a search box once the list is long enough to
   need one. */

/* This file carries no top-level state and runs nothing at load — see
   check-portal-split. So the collapsed/searching state lives on the rendered
   list element itself, which suits it better anyway: it belongs to that list,
   and re-rendering the product page resets it without anyone remembering to.

   The month table is memoised on the function object rather than built at
   load, for the same reason. */
function _fsMonths() {
  if (!_fsMonths._map) {
    const names = ['january','february','march','april','may','june',
                   'july','august','september','october','november','december'];
    const map = {};
    names.forEach((n, i) => { map[n] = i; map[n.slice(0, 3)] = i; });
    map.sept = 8;
    _fsMonths._map = map;
  }
  return _fsMonths._map;
}

/* Sheets shown before "show all", and the list length that earns a search box. */
function _fsCollapsedCount() { return 4; }
function _fsSearchAt()       { return 8; }

/* The period a factsheet covers.

   period_date is the real answer — a column, set from the pool the sheet
   belongs to. Reading the month out of file_name is the fallback for rows
   written before that column existed, and it is why this used to be guesswork:
   a sheet named in any other way had no place in the order.

   Sorting on the upload date is what made the list look shuffled — most of
   these were imported on one day. And the upload date is NOT the fallback of
   last resort either: it is on the same numeric scale as a period but means
   something different, so a document uploaded last week outranked every dated
   sheet and sat at the top of the archive. Unreadable ones sort to the end
   instead, ordered among themselves by upload. */
function _fsPeriod(sheet) {
  const months = _fsMonths();
  if (sheet && sheet.period_date) {
    const t = new Date(sheet.period_date);
    if (!isNaN(t)) return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1);
  }
  const name = String((sheet && sheet.file_name) || '');
  const m = name.match(/([A-Za-z]{3,9})[\s\-_]+(20\d{2})/);
  if (m && months[m[1].toLowerCase()] != null) {
    return Date.UTC(Number(m[2]), months[m[1].toLowerCase()], 1);
  }
  const y = name.match(/\b(20\d{2})\b/);
  if (y) return Date.UTC(Number(y[1]), 0, 1);
  return null;
}

function _fsUploaded(sheet) {
  const t = sheet && sheet.created_at ? Date.parse(sheet.created_at) : NaN;
  return isNaN(t) ? 0 : t;
}

/* Newest period first; anything undated after all of it. */
function _fsCompare(a, b) {
  const pa = _fsPeriod(a), pb = _fsPeriod(b);
  if (pa === null && pb === null) return _fsUploaded(b) - _fsUploaded(a);
  if (pa === null) return 1;
  if (pb === null) return -1;
  return pb - pa;
}

/* The heading a sheet files under. */
function _fsYear(sheet) {
  const p = _fsPeriod(sheet);
  return p === null ? 'Other' : String(new Date(p).getUTCFullYear());
}

/* Rows and year headings are shown or hidden in place rather than re-rendered,
   so typing in the search box does not cost the input its focus on every
   keystroke. */
function _fsApplyVisibility() {
  const list = document.getElementById('fsList');
  if (!list) return;
  const limit    = _fsCollapsedCount();
  const expanded = list.getAttribute('data-fs-expanded') === '1';
  const input    = document.getElementById('fsFilter');
  const q        = String((input && input.value) || '').trim().toLowerCase();
  const searching = q.length > 0;

  let shown = 0;
  const visibleYears = new Set();
  list.querySelectorAll('[data-fs-kind="row"]').forEach(row => {
    const matches = !searching || (row.getAttribute('data-fs-text') || '').includes(q);
    /* A search looks through the whole archive — collapsing it would hide the
       one sheet the person is searching for and report nothing found. */
    const visible = matches && (searching || expanded || shown < limit);
    if (visible) { shown++; visibleYears.add(row.getAttribute('data-fs-year')); }
    row.style.display = visible ? '' : 'none';
  });

  list.querySelectorAll('[data-fs-kind="year"]').forEach(h => {
    h.style.display = visibleYears.has(h.getAttribute('data-fs-year')) ? '' : 'none';
  });

  const total  = list.querySelectorAll('[data-fs-kind="row"]').length;
  const toggle = document.getElementById('fsToggle');
  if (toggle) {
    /* Hidden while searching: the collapse is not what is limiting the list
       then, so offering to expand it would be a lie about why a sheet is not
       on screen. Hidden too when everything fits — a control that does
       nothing still has to be read before it can be dismissed. */
    if (searching || total <= limit) {
      toggle.style.display = 'none';
    } else {
      toggle.style.display = '';
      toggle.innerHTML = expanded
        ? `Show fewer <i class="fa-solid fa-chevron-up"></i>`
        : `Show all ${total} factsheets <i class="fa-solid fa-chevron-down"></i>`;
    }
  }

  const empty = document.getElementById('fsEmpty');
  if (empty) empty.style.display = shown === 0 ? '' : 'none';
}

function _toggleFsList() {
  const list = document.getElementById('fsList');
  if (!list) return;
  list.setAttribute('data-fs-expanded', list.getAttribute('data-fs-expanded') === '1' ? '0' : '1');
  _fsApplyVisibility();
}

/* Reads the input directly, so nothing has to be kept in step with it. */
function _filterFsRows() { _fsApplyVisibility(); }

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
  // Reveal factsheet buttons for pools that have at least one sheet
  sheets.forEach(s => {
    const btn = document.getElementById(`fsBtn-${s.pool_id}`);
    if (btn) btn.style.display = '';
  });
  const productSheet = product && product.factsheet_url ? {
    file_url: product.factsheet_url, file_name: product.factsheet_name || `${product.label} factsheet`,
    created_at: product.updated_at, _product: true,
  } : null;

  /* The same sheet reaches this list once per pool it is attached to, so
     "April 2024 - Factsheet" appeared twice in a row with nothing to tell the
     two entries apart. Keyed on the file, since that is what opens. */
  const seen = new Set();
  const archive = sheets.filter(s => {
    const key = `${s.file_url || ''}|${s.file_name || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort(_fsCompare);

  // The product-level sheet is the current one and is pinned above the archive.
  const all = [productSheet, ...archive].filter(Boolean);

  // If there's a product-level factsheet, reveal buttons for ALL pools of this product
  if (productSheet) {
    poolIds.forEach(pid => {
      const btn = document.getElementById(`fsBtn-${pid}`);
      if (btn) btn.style.display = '';
    });
  }

  if (!all.length) {
    el.innerHTML = `
      <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:8px"><i class="fa-solid fa-file-pdf" style="color:#ef4444"></i> Factsheets &amp; documents</div>
      <div style="font-size:0.82rem;color:var(--text-muted)">No factsheets uploaded yet for this product.</div>`;
    return;
  }

  _fsDocCache = all;

  const row = (s, i, year) => `
    <a href="#" onclick="event.preventDefault();_openFsDoc(${i})"
       class="fs-row ${s._product ? 'fs-row--current' : ''}"
       data-fs-kind="row" data-fs-year="${year}"
       data-fs-text="${_esc(String(s.file_name || '').toLowerCase())} ${year}">
      <div class="fs-row__icon"><i class="fa-solid fa-file-pdf"></i></div>
      <div class="fs-row__info">
        <div class="fs-row__name">${_esc(s.file_name)}${s._product ? ' <span class="fs-current-tag">Current</span>' : ''}</div>
        <div class="fs-row__meta">Uploaded ${Utils.date(s.created_at)}</div>
      </div>
      <i class="fa-solid fa-arrow-up-right-from-square fs-row__arrow"></i>
    </a>`;

  /* Built in one pass so the index passed to _openFsDoc stays the index into
     _fsDocCache. A year heading is emitted when the year changes, which means
     the headings follow the sort rather than being computed separately from
     it — the two cannot disagree. */
  const parts = [];
  let lastYear = null;
  all.forEach((s, i) => {
    const year = s._product ? 'current' : _fsYear(s);
    if (year !== lastYear && !s._product) {
      parts.push(`<div data-fs-kind="year" data-fs-year="${year}"
        style="font-size:0.68rem;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted);margin:10px 0 2px">${year}</div>`);
      lastYear = year;
    }
    parts.push(row(s, i, year));
  });

  const searchable = archive.length >= _fsSearchAt();

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
      <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted)">
        <i class="fa-solid fa-file-pdf" style="color:#ef4444"></i> Factsheets &amp; documents
        <span style="font-weight:800;color:var(--text)">${all.length}</span>
      </div>
      ${searchable ? `<input type="search" id="fsFilter" placeholder="Search month or year…"
        oninput="_filterFsRows()" autocomplete="off"
        style="flex:1;min-width:150px;font-size:0.8rem;padding:6px 10px;border-radius:8px;
               border:1px solid rgba(128,128,128,0.28);background:transparent;color:var(--text)">` : ''}
    </div>
    <div id="fsList" data-fs-expanded="0" style="display:flex;flex-direction:column;gap:8px">${parts.join('')}</div>
    <div id="fsEmpty" style="display:none;font-size:0.82rem;color:var(--text-muted);padding:10px 2px">
      No factsheet matches that.</div>
    <button type="button" id="fsToggle" onclick="_toggleFsList()"
      style="margin-top:10px;width:100%;font-size:0.78rem;font-weight:700;color:var(--text-muted);
             background:transparent;border:1px dashed rgba(128,128,128,0.3);border-radius:9px;
             padding:8px;cursor:pointer"></button>`;

  _fsApplyVisibility();
}

async function _getPortalProducts() {
  if (_portalProductsCache && _portalProductsCache.length) return _portalProductsCache;
  try {
    const r = await API._fetch('GET', 'products');
    _portalProductsCache = r.data || null;
    if (_portalProductsCache && _portalProductsCache.length) Utils.setProductCache(_portalProductsCache);
  } catch (_) { _portalProductsCache = null; }
  return _portalProductsCache || [];
}

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
  return `<div style="background:rgba(254,194,79,0.07);border:1px solid rgba(254,194,79,0.25);border-radius:10px;padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px;font-size:0.82rem;flex-wrap:wrap">
    <i class="fa-solid fa-cow" style="color:#fec24f;flex-shrink:0"></i>
    <span style="color:var(--text)"><strong>${(s.live_count || 0).toLocaleString('en-ZA')}</strong> cattle live</span>
    ${weight ? `<span style="color:var(--text-muted)">·</span><span style="color:var(--text)">avg <strong>${weight}kg</strong></span>` : ''}
    <span style="color:var(--text-muted)">·</span>
    <span style="color:#65ed00;font-weight:700"><i class="fa-solid fa-heart-pulse" style="font-size:0.72rem"></i> ${survival}% survival</span>
  </div>`;
}

function _cattleHerdStatusHtml(s) {
  if (!s || !s.total_purchased) return '';
  const weight  = s.avg_current_weight || s.avg_entry_weight;
  const genders = (s.by_gender || []).filter(g => g.count > 0 && (g.label || '').toLowerCase() !== 'unspecified');
  const breeds  = (s.by_breed  || []).filter(b => b.count > 0 && (b.label || '').toLowerCase() !== 'unspecified');
  const totalG  = genders.reduce((a, g) => a + g.count, 0) || 1;
  const totalB  = breeds.reduce((a, b) => a + b.count, 0) || 1;

  const gChip = txt => `<span style="font-size:0.73rem;background:rgba(254,194,79,0.15);color:#8a6d1f;border-radius:6px;padding:3px 9px;font-weight:600;white-space:nowrap">${txt}</span>`;
  const bChip = txt => `<span style="font-size:0.73rem;background:rgba(0,0,0,0.05);color:var(--text-muted);border-radius:6px;padding:3px 9px;white-space:nowrap">${txt}</span>`;

  const mortRate = s.total_purchased ? (s.mortality_count || 0) / s.total_purchased * 100 : 0;
  const survival = (100 - mortRate).toFixed(1);

  return `
    <div style="background:rgba(254,194,79,0.06);border:1px solid rgba(254,194,79,0.22);border-radius:12px;padding:14px 16px;margin-top:16px;margin-bottom:14px">

      <!-- Header row -->
      <div style="display:flex;align-items:center;margin-bottom:12px">
        <span style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#b8860b"><i class="fa-solid fa-cow" style="margin-right:5px"></i>Live Herd Status</span>
        <span style="margin-left:auto;display:inline-flex;align-items:center;gap:4px;background:rgba(34,197,94,0.1);border-radius:100px;padding:2px 9px;font-size:0.67rem;color:#16a34a;font-weight:700">
          <span style="width:6px;height:6px;border-radius:50%;background:#22c55e;display:inline-block"></span>Live
        </span>
      </div>

      <!-- Stat strip: Total · Weight · Survival.
           A grid, not a flex row. Every item was flex:0 0 auto with a flex:1
           spacer pushing survival to the right, all inside overflow:hidden —
           so nothing could shrink and on a phone the survival stat was CLIPPED
           by the container instead of wrapping. auto-fit wraps it onto a
           second line when three do not fit.

           The dividers went with it: a 1px separator is a single-row idea, and
           once the row can wrap it lands at the start of a line. -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:10px 16px;border:1px solid rgba(0,0,0,0.07);border-radius:8px;padding:10px 14px;margin-bottom:12px">
        <div style="min-width:0">
          <div style="font-size:1.15rem;font-weight:800;color:var(--text);line-height:1.1">${s.total_purchased.toLocaleString('en-ZA')}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px">purchased to date</div>
        </div>
        ${weight ? `<div style="min-width:0">
          <div style="font-size:1.15rem;font-weight:800;color:var(--text);line-height:1.1">${weight}<span style="font-size:0.78rem;font-weight:600"> kg</span></div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px">average weight</div>
        </div>` : ''}
        <div style="min-width:0">
          <div style="font-size:1.15rem;font-weight:800;color:#16a34a;line-height:1.1"><i class="fa-solid fa-heart-pulse" style="font-size:0.8rem;margin-right:3px"></i>${survival}%</div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px">survival rate</div>
        </div>
      </div>

      <!-- Breakdown grid: Gender | Breeds -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px">
        ${genders.length ? `<div>
          <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:6px">Gender</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap">${genders.map(g => gChip(`${_esc(g.label)} <strong>${Math.round(g.count / totalG * 100)}%</strong>`)).join('')}</div>
        </div>` : ''}
        ${breeds.length ? `<div>
          <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:6px">Breeds</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap">${breeds.slice(0, 4).map(b => bChip(`${_esc(b.label)} ${Math.round(b.count / totalB * 100)}%`)).join('')}</div>
        </div>` : ''}
      </div>
    </div>`;
}

async function _renderCattleHerdStatus(containerId, compact = false) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);padding:6px 0"><i class="fa-solid fa-spinner fa-spin"></i> Loading herd status…</div>`;
  const s = await _getCattleStats();
  el.innerHTML = compact ? _cattleHerdStatusCompactHtml(s) : _cattleHerdStatusHtml(s);
}

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
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px">
        <div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${(s.current_power_kw || 0).toLocaleString('en-ZA')}<span style="font-size:0.78rem"> kW</span></div><div style="font-size:0.7rem;color:var(--text-muted)">generating now</div></div>
        <div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${kwh(s.today_kwh)}<span style="font-size:0.78rem"> kWh</span></div><div style="font-size:0.7rem;color:var(--text-muted)">today</div></div>
        <div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${kwh(s.month_kwh)}<span style="font-size:0.78rem"> kWh</span></div><div style="font-size:0.7rem;color:var(--text-muted)">this month</div></div>
        <div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${total}</div><div style="font-size:0.7rem;color:var(--text-muted)">total generated</div></div>
        ${s.co2_avoided_kg ? `<div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${(s.co2_avoided_kg / 1000).toFixed(1)}<span style="font-size:0.78rem"> t</span></div><div style="font-size:0.7rem;color:var(--text-muted)">CO₂ avoided</div></div>` : ''}
        ${s.device_count ? `<div><div style="font-size:1.15rem;font-weight:800;color:var(--text)">${s.device_count}</div><div style="font-size:0.7rem;color:var(--text-muted)">inverter${s.device_count === 1 ? '' : 's'}</div></div>` : ''}
      </div>
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
        ${(() => { _fsDocCache = all; return all.map((s, i) => `
          <a href="#" onclick="event.preventDefault();_openFsDoc(${i})" class="fs-row ${s.is_current ? 'fs-row--current' : ''}">
            <div class="fs-row__icon"><i class="fa-solid fa-file-pdf"></i></div>
            <div class="fs-row__info">
              <div class="fs-row__name">${_esc(s.file_name)}${s._product ? ' <span class="fs-current-tag">Product</span>' : (s.is_current ? ' <span class="fs-current-tag">Current</span>' : '')}</div>
              <div class="fs-row__meta">${s.version ? `v${_esc(s.version)} · ` : ''}${Utils.date(s.created_at)}${s.uploaded_by ? ` · ${_esc(s.uploaded_by)}` : ''}</div>
            </div>
            <i class="fa-solid fa-arrow-up-right-from-square fs-row__arrow"></i>
          </a>`).join(''); })()}
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

function _maturityProductIcon(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('cattle'))   return 'cow';
  if (t.includes('solar'))    return 'solar-panel';
  if (t.includes('delivery')) return 'bicycle';
  if (t.includes('short'))    return 'clock-rotate-left';
  return 'chart-line';
}

function _maturityProductColor(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('cattle'))   return '#fec24f';   // brand gold
  if (t.includes('solar'))    return '#65ed00';   // brand green
  if (t.includes('delivery')) return '#eda5ff';   // brand lavender
  if (t.includes('short'))    return '#0096ff';   // brand blue
  return '#fec24f';                               // brand orange
}

function _maturityInstructionLabel(key) {
  // One map, in js/api.js. This one covered four of the six the server
  // accepts, so a client who chose a custom payout saw "payout custom".
  return Utils.instructionLabel(key) || 'Not set';
}

async function loadMaturity() {
  if (!PORTAL.investments.length) await loadPortalData();

  const container = document.getElementById('maturityInvestments');
  const matured = PORTAL.investments.filter(i => i.status === 'matured');
  const active  = PORTAL.investments.filter(i => i.status === 'active');

  let html = '';

  if (active.length) {
    // Soonest first — the section is called Upcoming Maturities.
    const activeGroups = _groupInvsByPool(active).sort((a, b) => Utils.byGroupMaturity(a, b));
    html += `
      <div class="mc2-section-header">
        <span class="mc2-section-header__icon"><i class="fa-solid fa-hourglass-half"></i></span>
        <span class="mc2-section-header__title">Upcoming Maturities</span>
        <span class="mc2-section-header__count">${activeGroups.length}</span>
      </div>`;

    html += activeGroups.map(group => {
      const inv         = group[0];
      const days        = Utils.daysRemaining(inv.maturity_date);
      const color       = _maturityProductColor(inv.product_type);
      const icon        = _maturityProductIcon(inv.product_type);
      const urgencyCls  = days <= 7 ? 'soon' : days <= 30 ? 'near' : 'far';
      const stripColor  = days <= 7 ? '#ff5229' : days <= 30 ? '#fec24f' : '#65ed00';
      const multiple    = group.length > 1;
      const uid         = 'mat_' + (inv.pool_id || inv.id);

      const start    = new Date(inv.start_date || inv.created_at).getTime();
      const end      = new Date(inv.maturity_date).getTime();
      const progress = (start && end && end > start)
        ? Math.min(100, Math.max(2, Math.round((Date.now() - start) / (end - start) * 100)))
        : 50;

      const totalAmount  = group.reduce((s, i) => s + (i.amount || 0), 0);
      // Posted only. This said "Expected return" and showed a benchmark on an
      // investment that had earned nothing.
      const _postedTot   = Utils.postedReturnTotal(group);
      const totalReturn  = _postedTot ? _postedTot.amount : 0;
      const productLabel = Utils.productInfo ? (Utils.productInfo(inv.product_type)||{}).label : inv.product_type;

      /* Pool-level instruction state, from the shared definition. The local
         version used `new Set(...).size === 1`, which called a pool fully set
         when one of three investments had an instruction — the other two
         contribute nothing to the set, so it still had one member. */
      const _instrState = Utils.maturityInstructionState(group);
      const poolInstr   = _instrState.instruction;
      const hasMixed    = _instrState.state === 'mixed';
      const instrSet    = _instrState.state !== 'none';
      const instrLabel  = _instrState.state === 'none' ? 'No instruction set yet' : _instrState.label;

      const modalCall = multiple
        ? `openPoolMaturityModal(${JSON.stringify(inv.pool_id)})`
        : `openMaturityModal(${JSON.stringify(inv.id)})`;

      const indivRows = multiple ? group.map(i => {
        const hasInstr = !!i.maturity_instruction;
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid var(--border);gap:8px">
            <div style="font-size:0.78rem;min-width:0">
              <div style="color:var(--gold);font-weight:700">${Utils.rand(i.amount)}</div>
              <div style="color:var(--text-muted);font-size:0.72rem">${Utils.date(i.investment_date || i.start_date || i.created_at)}</div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
              <span style="font-size:0.72rem;color:${hasInstr ? 'var(--green)' : 'var(--text-muted)'}">
                <i class="fa-solid fa-${hasInstr ? 'circle-check' : 'circle-exclamation'}"></i>
                ${hasInstr ? _maturityInstructionLabel(i.maturity_instruction) : 'Not set'}
              </span>
              <button class="btn btn--ghost btn--sm" style="font-size:0.72rem;padding:3px 8px" onclick='openMaturityModal(${JSON.stringify(i.id)})'>
                ${hasInstr ? 'Update' : 'Set'}
              </button>
            </div>
          </div>`;
      }).join('') : '';

      return `
      <div class="mc2 mc2--active" data-id="${_esc(inv.id)}">
        <div class="mc2__strip" style="background:${stripColor}"></div>
        <div class="mc2__body">
          <div class="mc2__header">
            <div class="mc2__icon" style="background:${color}1a;color:${color}">
              <i class="fa-solid fa-${icon}"></i>
            </div>
            <div class="mc2__titles">
              <div class="mc2__name">${_esc(inv.pool_name)}</div>
              <div class="mc2__sub">${inv.term_months ? inv.term_months + '-month term' : ''}${productLabel ? ' · ' + _esc(productLabel) : ''}${multiple ? ` · <span style="color:var(--gold)">${group.length} investments</span>` : ''}</div>
            </div>
            <div class="mc2__badge mc2__badge--${urgencyCls}">
              <i class="fa-solid fa-clock"></i>
              ${days === 0 ? 'Today' : days === 1 ? '1 day' : days + ' days'}
            </div>
          </div>

          <div class="mc2__stats">
            <div class="mc2__stat">
              <div class="mc2__stat-val">${Utils.rand(totalAmount)}</div>
              <div class="mc2__stat-lbl">${multiple ? 'Total invested' : 'Invested'}</div>
            </div>
            <div class="mc2__stat">
              <div class="mc2__stat-val mc2__stat-val--gold">${totalReturn ? '+' + Utils.rand(totalReturn) : '—'}</div>
              <div class="mc2__stat-lbl">Return posted</div>
            </div>
            <div class="mc2__stat">
              <div class="mc2__stat-val">${Utils.date(inv.maturity_date)}</div>
              <div class="mc2__stat-lbl">Maturity date</div>
            </div>
          </div>

          <div class="mc2__progress-wrap">
            <div class="mc2__progress-meta">
              <span>${Utils.date(inv.start_date)}</span>
              <span>${progress}% complete</span>
              <span>${Utils.date(inv.maturity_date)}</span>
            </div>
            <div class="mc2__progress-bar">
              <div class="mc2__progress-fill" style="width:${progress}%;background:${stripColor}"></div>
            </div>
          </div>

          <div class="mc2__footer">
            <div class="mc2__instruction ${instrSet ? 'mc2__instruction--set' : 'mc2__instruction--unset'}">
              <i class="fa-solid fa-${instrSet ? 'circle-check' : 'circle-exclamation'}"></i>
              ${instrLabel}
            </div>
            <button class="mc2__cta ${instrSet ? 'mc2__cta--secondary' : 'mc2__cta--primary'}"
                    onclick='${modalCall}'>
              <i class="fa-solid fa-${instrSet ? 'pen' : 'paper-plane'}"></i>
              ${instrSet ? 'Update' : 'Set Instruction'}
            </button>
          </div>

          ${multiple ? `
          <div style="border-top:1px solid var(--border);margin-top:8px;padding-top:4px">
            <button class="btn btn--ghost btn--full btn--sm" onclick="toggleInvBreakdown('${uid}')" style="font-size:0.73rem;color:var(--text-muted)">
              <i class="fa-solid fa-list" id="icon-${uid}"></i> Individual instructions (${group.length})
            </button>
            <div id="breakdown-${uid}" style="display:none;padding:0 2px">
              ${indivRows}
            </div>
          </div>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  if (matured.length) {
    // Most recently matured first — for these, latest is what matters.
    const maturedGroups = _groupInvsByPool(matured).sort((a, b) => Utils.byGroupMaturity(a, b));
    if (active.length) {
      html += `<div class="mc2-section-divider">
        <div class="mc2-section-divider__line"></div>
        <div class="mc2-section-divider__label"><i class="fa-solid fa-circle-check"></i> Matured (${maturedGroups.length})</div>
        <div class="mc2-section-divider__line"></div>
      </div>`;
    } else {
      html += `<div class="mc2-section-header">
        <span class="mc2-section-header__icon" style="color:#22c55e"><i class="fa-solid fa-circle-check"></i></span>
        <span class="mc2-section-header__title" style="color:#22c55e">Matured</span>
        <span class="mc2-section-header__count" style="background:rgba(34,197,94,0.1);color:#16a34a">${maturedGroups.length}</span>
      </div>`;
    }

    html += maturedGroups.map(group => {
      const inv         = group[0];
      const totalAmount = group.reduce((s, i) => s + (i.amount || 0), 0);
      // A matured investment with no return recorded has earned nothing on
      // record — quoting its benchmark instead would invent the figure.
      const totalReturn = Utils.earnedReturns(group);
      const total       = totalAmount + totalReturn;
      const color       = _maturityProductColor(inv.product_type);
      const icon        = _maturityProductIcon(inv.product_type);
      // Shared definition — see the note in the active section above.
      const _instrState2 = Utils.maturityInstructionState(group);
      const poolInstr   = _instrState2.instruction;
      const hasMixed    = _instrState2.state === 'mixed';
      const instrSet    = _instrState2.state !== 'none';
      const instrLabel  = _instrState2.state === 'none' ? 'Awaiting instruction' : _instrState2.label;

      return `
      <div class="mc2 mc2--matured">
        <div class="mc2__strip" style="background:#65ed00"></div>
        <div class="mc2__body">
          <div class="mc2__header">
            <div class="mc2__icon" style="background:${color}1a;color:${color}">
              <i class="fa-solid fa-${icon}"></i>
            </div>
            <div class="mc2__titles">
              <div class="mc2__name">${_esc(inv.pool_name)}</div>
              <div class="mc2__sub">Matured ${Utils.date(inv.maturity_date)}${group.length > 1 ? ` · <span style="color:var(--gold)">${group.length} investments</span>` : ''}</div>
            </div>
            <div class="mc2__badge mc2__badge--done">
              <i class="fa-solid fa-circle-check"></i> Matured
            </div>
          </div>

          <div class="mc2__payout">
            <i class="fa-solid fa-sack-dollar" style="color:#22c55e;font-size:1.1rem"></i>
            <div>
              <div class="mc2__payout-val">${Utils.rand(total)}</div>
              <div class="mc2__payout-lbl">Total payout value</div>
            </div>
          </div>

          <div class="mc2__footer">
            <div class="mc2__instruction ${instrSet ? 'mc2__instruction--set' : 'mc2__instruction--unset'}">
              <i class="fa-solid fa-${instrSet ? 'circle-check' : 'circle-exclamation'}"></i>
              ${instrLabel}
            </div>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  if (!matured.length && !active.length) {
    html = '<div class="empty-state"><i class="fa-solid fa-hourglass"></i><p>No investments to show maturity instructions for.</p></div>';
  }

  container.innerHTML = html;
}

/* The reason a maturity instruction was refused belongs NEXT TO THE FORM, not
   only in a toast. Toasts on this portal were invisible and off-screen until
   today, and even fixed they are the wrong home for a form error: they expire,
   they sit away from the field, and on a phone the client may be scrolled past
   them. The toast still fires — it is how every other action reports — but the
   modal now states it too, and keeps stating it until the client changes
   something. */
function _matShowError(msg) {
  const el = document.getElementById('matError');
  if (el) {
    el.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="margin-right:6px"></i>${_esc(msg)}`;
    el.style.display = 'block';
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  Toast.error(msg);
}

/* The chosen product, or null. Reads the selected OPTION so a disabled
   placeholder resolves to nothing rather than to an empty string that looks
   like a choice. */
function _matSelectedProduct(type) {
  if (type !== 'switch_product' && type !== 'custom_switch') return null;
  const sel = document.getElementById('matSwitchProductType');
  const opt = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
  if (!opt || opt.disabled) return null;
  return (opt.value || '').trim() || null;
}

function _matClearError() {
  const el = document.getElementById('matError');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

/* A function, not a top-level const. This file is shared by the portal and the
   app and must contain nothing that runs at load — check-portal-split enforces
   that, and it caught this the moment it was written. */
function _matErrorSlot() {
  return `<div id="matError" role="alert" style="display:none;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.4);color:#ef4444;border-radius:10px;padding:11px 13px;font-size:0.85rem;line-height:1.5;font-weight:600;margin-bottom:14px"></div>`;
}

/* An instruction the client cannot complete must not be offerable. When no
   other product has a pool, "Switch Product" led to a select with nothing in it
   but a disabled placeholder — the client picked the instruction, could not pick
   a product, and got an error they could not act on. */
function _switchOptionAttrs(canSwitch) {
  return canSwitch ? '' : ' disabled';
}
function _switchUnavailableNote(canSwitch) {
  return canSwitch ? '' : ` <span style="opacity:.7">(no other product is open right now)</span>`;
}

async function openMaturityModal(investmentId) {
  const inv = PORTAL.investments.find(i => i.id === investmentId);
  if (!inv) return;

  const isDeliveryBike = (inv.product_type || '').includes('delivery_bike');
  const isActive      = inv.status === 'active';
  const hasActualRate = !!(inv.actual_return_amount && inv.actual_return_amount > 0);
  const total         = hasActualRate ? inv.amount + inv.actual_return_amount : null;

  // Delivery bike: force payout_all — no reinvest options
  const existing = isDeliveryBike
    ? (inv.maturity_instruction === 'reinvest' || !inv.maturity_instruction ? 'payout_all' : inv.maturity_instruction)
    : (inv.maturity_instruction || '');

  // All product types for switch option (resolved at maturity, pool may not be open yet)
  const allProductTypes = [...new Set(
    (PORTAL.pools || []).filter(p => p.product_type && p.product_type !== inv.product_type).map(p => p.product_type)
  )];
  const canSwitch = allProductTypes.length > 0;
  const switchProductsHtml = canSwitch
    ? allProductTypes.map(pt => {
        const pi = Utils.productInfo(pt);
        return `<option value="${pt}" ${existing==='switch_product' && inv.switch_product_type===pt?'selected':''}>${pi.label || pt}</option>`;
      }).join('')
    : `<option value="" disabled>No other product types available</option>`;

  const poolNote = `<div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px"><i class="fa-solid fa-info-circle"></i> The first available open pool for this product will be assigned when your investment matures.</div>`;

  document.getElementById('maturityModalBody').innerHTML = `
    ${_matErrorSlot()}
    <div class="info-list mb-16">
      <div class="info-row"><span class="info-row__label">Pool</span><span class="info-row__value">${_esc(inv.pool_name)}</span></div>
      <div class="info-row"><span class="info-row__label">Capital</span><span class="info-row__value">${Utils.rand(inv.amount)}</span></div>
      ${hasActualRate ? `
      <div class="info-row"><span class="info-row__label">Actual Rate (Achieved)</span><span class="info-row__value text-green">${Utils.rand(inv.actual_return_amount)}</span></div>
      <div class="info-row"><span class="info-row__label">Total Payout</span><span class="info-row__value text-gold fw-700">${Utils.rand(total)}</span></div>
      ` : ''}
    </div>

    <div class="form-group">
      <label class="form-label">Instruction Type *</label>
      <select class="form-select" id="matInstructionType">
        <option value="payout_all"     ${existing==='payout_all'    ?'selected':''}>Payout All — Receive full capital + returns</option>
        ${isDeliveryBike ? `
        <option value="switch_product" ${existing==='switch_product'?'selected':''}${_switchOptionAttrs(canSwitch)}>Switch Product — into a different product${_switchUnavailableNote(canSwitch)}</option>
        ` : `
        <option value="payout_return"  ${existing==='payout_return' ?'selected':''}>Payout Returns Only — keep capital invested</option>
        <option value="reinvest"       ${existing==='reinvest'      ?'selected':''}>Reinvest — roll over into the same product</option>
        <option value="switch_product" ${existing==='switch_product'?'selected':''}${_switchOptionAttrs(canSwitch)}>Switch Product — into a different product${_switchUnavailableNote(canSwitch)}</option>
        <option value="payout_custom"  ${existing==='payout_custom' ?'selected':''}>Custom Payout — take an amount, reinvest the rest</option>
        <option value="custom_switch"  ${existing==='custom_switch' ?'selected':''}${_switchOptionAttrs(canSwitch)}>Custom Switch — take an amount, switch the rest${_switchUnavailableNote(canSwitch)}</option>
        `}
      </select>
    </div>

    ${!isDeliveryBike ? `
    <div id="reinvestGroup" style="display:${existing==='reinvest'?'block':'none'}">
      <div style="font-size:0.72rem;color:var(--text-dim);padding:10px 12px;background:rgba(254,194,79,0.06);border-radius:8px;border:1px solid rgba(254,194,79,0.15)">
        <i class="fa-solid fa-rotate" style="color:var(--gold);margin-right:4px"></i>
        Your full payout will be rolled into the next available open pool for <strong>${Utils.productInfo(inv.product_type).label}</strong>. ${poolNote}
      </div>
    </div>
    ` : ''}

    <div id="switchProductGroup" style="display:${(existing==='switch_product'||existing==='custom_switch')?'block':'none'}">
      <div class="form-group">
        <label class="form-label">Switch to Product *</label>
        <select class="form-select" id="matSwitchProductType">
          ${switchProductsHtml}
        </select>
        ${poolNote}
      </div>
    </div>

    ${!isDeliveryBike ? `
    <div id="customPayoutGroup" style="display:${(existing==='payout_custom'||existing==='custom_switch')?'block':'none'}">
      <div class="form-group">
        <label class="form-label">Amount to Pay Out (R)</label>
        <input type="number" class="form-input" id="matCustomAmount" placeholder="Amount to withdraw" max="${total ?? ''}" value="${inv.custom_payout_amount || ''}" />
        <div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px"><i class="fa-solid fa-info-circle"></i> The remaining balance is reinvested (Custom Payout) or switched to the chosen product (Custom Switch).</div>
      </div>
    </div>
    ` : `<div id="customPayoutGroup" style="display:none"></div>`}

    <div style="font-size:0.72rem;color:var(--text-dim);line-height:1.6;margin-top:8px">
      <i class="fa-solid fa-clock" style="color:var(--gold)"></i>
      ${isActive
        ? `You can update this instruction at any time before maturity. If not submitted, funds will be automatically ${isDeliveryBike ? 'paid out to your wallet' : 'reinvested'}.`
        : `Instruction must be submitted before <strong>5:00 PM on ${Utils.date(inv.maturity_date)}</strong>. If not submitted, funds will be automatically ${isDeliveryBike ? 'paid out to your wallet' : 'reinvested'}.`
      }
    </div>
  `;

  document.getElementById('matInstructionType').addEventListener('change', e => {
    _matClearError();
    const v = e.target.value;
    document.getElementById('switchProductGroup').style.display  = (v === 'switch_product' || v === 'custom_switch') ? 'block' : 'none';
    if (!isDeliveryBike) {
      document.getElementById('reinvestGroup').style.display      = v === 'reinvest'       ? 'block' : 'none';
      document.getElementById('customPayoutGroup').style.display  = (v === 'payout_custom' || v === 'custom_switch') ? 'block' : 'none';
    }
  });

  const matBtn = document.getElementById('maturityConfirmBtn');
  matBtn.onclick = () => _withBtn(matBtn, () => submitMaturityInstruction(inv));
  Modal.open('maturityModal');
}

async function submitMaturityInstruction(inv) {
  const type              = document.getElementById('matInstructionType').value;
  // Capital plus what has actually been declared. A benchmark must not raise
  // the amount a client may request; the server enforces the real ceiling.
  const total             = (parseFloat(inv.amount) || 0) + Utils.earnedReturns([inv]);
  const needsCustom       = (type === 'payout_custom' || type === 'custom_switch');
  const customAmt         = needsCustom ? parseFloat(document.getElementById('matCustomAmount')?.value || 0) : null;
  /* Read from the SELECTED OPTION, not the select's value. They agree in every
     ordinary case; they differ when the only option is the disabled "no other
     product types" placeholder, and reading the option makes that state
     obvious here rather than sending an empty product the server refuses with
     a message the client cannot act on. */
  const switchProductType = _matSelectedProduct(type);

  _matClearError();
  if (needsCustom && (!customAmt || customAmt <= 0))  { _matShowError('Enter the amount you want paid out.'); return; }
  if (needsCustom && customAmt >= total)              { _matShowError(`The payout amount must be less than ${Utils.rand(total)}, the value of this investment.`); return; }
  if ((type === 'switch_product' || type === 'custom_switch') && !switchProductType) {
    _matShowError('Choose the product to switch into. If the list is empty, no other product has an open pool right now — choose a different instruction or contact support.');
    return;
  }

  try {
    // One request, one transaction. The custom amount and switch target used to
    // be a second PATCH sent after this call: between the two the investment
    // read "pay out a custom amount" with no amount, and if the PATCH failed it
    // stayed that way. The endpoint enforces the 17:00 SAST cutoff and now
    // writes the companion fields alongside the instruction.
    await API._fetch('POST', 'investments/' + inv.id + '/instruction', {
      instruction:          type,
      custom_payout_amount: customAmt,
      switch_product_type:  switchProductType,
    });

    Toast.success('Maturity instruction saved successfully!');
    SVC.track('svc_maturity_instruction', { investment_id: inv.id, action: type });
    Modal.close('maturityModal');
    PORTAL.investments = [];
    await loadPortalData();
    loadMaturity();
  } catch (e) {
    console.error('[maturity]', e, { instruction: type, switch_product_type: switchProductType, custom_payout_amount: customAmt });
    _matShowError(e.message || 'Could not save this instruction. Please try again.');
  }
}

async function openPoolMaturityModal(poolId) {
  const poolInvs = PORTAL.investments.filter(i => i.pool_id === poolId && i.status === 'active');
  if (!poolInvs.length) return;
  const first = poolInvs[0];

  const isDeliveryBike = (first.product_type || '').includes('delivery_bike');
  const totalAmount    = poolInvs.reduce((s, i) => s + (i.amount || 0), 0);

  // Preselects the dropdown. Same semantics as before — an instruction when
  // one choice covers the pool or part of it, blank when they differ.
  let   existing     = Utils.maturityInstructionState(poolInvs).instruction || '';
  if (isDeliveryBike && (existing === 'reinvest' || !existing)) existing = 'payout_all';

  const allProductTypes = [...new Set(
    (PORTAL.pools || []).filter(p => p.product_type && p.product_type !== first.product_type).map(p => p.product_type)
  )];
  const canSwitch = allProductTypes.length > 0;
  const switchProductsHtml = canSwitch
    ? allProductTypes.map(pt => { const pi = Utils.productInfo(pt); return `<option value="${pt}">${pi.label || pt}</option>`; }).join('')
    : `<option value="" disabled>No other product types available</option>`;
  const poolNote = `<div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px"><i class="fa-solid fa-info-circle"></i> The first available open pool for this product will be assigned when your investment matures.</div>`;

  document.getElementById('maturityModalBody').innerHTML = `
    ${_matErrorSlot()}
    <div class="info-list mb-16">
      <div class="info-row"><span class="info-row__label">Pool</span><span class="info-row__value">${_esc(first.pool_name)}</span></div>
      <div class="info-row"><span class="info-row__label">Investments</span><span class="info-row__value">${poolInvs.length}</span></div>
      <div class="info-row"><span class="info-row__label">Total Capital</span><span class="info-row__value text-gold fw-700">${Utils.rand(totalAmount)}</span></div>
    </div>
    <div style="font-size:0.8rem;color:var(--text-muted);background:rgba(254,194,79,0.08);border:1px solid rgba(254,194,79,0.2);border-radius:8px;padding:10px 12px;margin-bottom:16px">
      <i class="fa-solid fa-layer-group" style="color:var(--gold);margin-right:6px"></i>
      This instruction applies to all ${poolInvs.length} investments in this pool. To set per-investment instructions expand <strong>Individual instructions</strong> on the card.
    </div>
    <div class="form-group">
      <label class="form-label">Instruction Type *</label>
      <select class="form-select" id="matInstructionType">
        <option value="payout_all"     ${existing==='payout_all'    ?'selected':''}>Payout All — Receive full capital + returns</option>
        ${isDeliveryBike ? `
        <option value="switch_product" ${existing==='switch_product'?'selected':''}${_switchOptionAttrs(canSwitch)}>Switch Product — into a different product${_switchUnavailableNote(canSwitch)}</option>
        ` : `
        <option value="payout_return"  ${existing==='payout_return' ?'selected':''}>Payout Returns Only — keep capital invested</option>
        <option value="reinvest"       ${existing==='reinvest'      ?'selected':''}>Reinvest — roll over into the same product</option>
        <option value="switch_product" ${existing==='switch_product'?'selected':''}${_switchOptionAttrs(canSwitch)}>Switch Product — into a different product${_switchUnavailableNote(canSwitch)}</option>
        <option value="payout_custom"  ${existing==='payout_custom' ?'selected':''}>Custom Payout — take an amount, reinvest the rest</option>
        <option value="custom_switch"  ${existing==='custom_switch' ?'selected':''}${_switchOptionAttrs(canSwitch)}>Custom Switch — take an amount, switch the rest${_switchUnavailableNote(canSwitch)}</option>
        `}
      </select>
    </div>
    ${!isDeliveryBike ? `
    <div id="reinvestGroup" style="display:${existing==='reinvest'?'block':'none'}">
      <div style="font-size:0.72rem;color:var(--text-dim);padding:10px 12px;background:rgba(254,194,79,0.06);border-radius:8px;border:1px solid rgba(254,194,79,0.15)">
        <i class="fa-solid fa-rotate" style="color:var(--gold);margin-right:4px"></i>
        Your full payout will be rolled into the next available open pool for <strong>${Utils.productInfo(first.product_type).label}</strong>. ${poolNote}
      </div>
    </div>
    ` : ''}
    <div id="switchProductGroup" style="display:${(existing==='switch_product'||existing==='custom_switch')?'block':'none'}">
      <div class="form-group">
        <label class="form-label">Switch to Product *</label>
        <select class="form-select" id="matSwitchProductType">${switchProductsHtml}</select>
        ${poolNote}
      </div>
    </div>
    ${!isDeliveryBike ? `
    <div id="customPayoutGroup" style="display:${(existing==='payout_custom'||existing==='custom_switch')?'block':'none'}">
      <div class="form-group">
        <label class="form-label">Amount to Pay Out (R) — applied per investment</label>
        <input type="number" class="form-input" id="matCustomAmount" placeholder="Amount per investment" />
      </div>
    </div>
    ` : `<div id="customPayoutGroup" style="display:none"></div>`}
    <div style="font-size:0.72rem;color:var(--text-dim);line-height:1.6;margin-top:8px">
      <i class="fa-solid fa-clock" style="color:var(--gold)"></i>
      You can update this instruction at any time before maturity. If not submitted, funds will be automatically ${isDeliveryBike ? 'paid out to your wallet' : 'reinvested'}.
    </div>
  `;

  document.getElementById('matInstructionType').addEventListener('change', e => {
    _matClearError();
    const v = e.target.value;
    document.getElementById('switchProductGroup').style.display  = (v === 'switch_product' || v === 'custom_switch') ? 'block' : 'none';
    if (!isDeliveryBike) {
      document.getElementById('reinvestGroup').style.display      = v === 'reinvest' ? 'block' : 'none';
      document.getElementById('customPayoutGroup').style.display  = (v === 'payout_custom' || v === 'custom_switch') ? 'block' : 'none';
    }
  });

  const matBtn = document.getElementById('maturityConfirmBtn');
  matBtn.onclick = () => _withBtn(matBtn, () => submitPoolMaturityInstruction(poolId));
  Modal.open('maturityModal');
}

async function submitPoolMaturityInstruction(poolId) {
  const poolInvs = PORTAL.investments.filter(i => i.pool_id === poolId && i.status === 'active');
  if (!poolInvs.length) return;

  const type              = document.getElementById('matInstructionType').value;
  const needsCustom       = (type === 'payout_custom' || type === 'custom_switch');
  const customAmt         = needsCustom ? parseFloat(document.getElementById('matCustomAmount')?.value || 0) : null;
  const switchProductType = _matSelectedProduct(type);

  _matClearError();
  if (needsCustom && (!customAmt || customAmt <= 0)) { _matShowError('Enter the amount you want paid out.'); return; }
  if ((type === 'switch_product' || type === 'custom_switch') && !switchProductType) {
    _matShowError('Choose the product to switch into. If the list is empty, no other product has an open pool right now — choose a different instruction or contact support.');
    return;
  }

  try {
    /* One request, applied to the whole pool inside a single transaction.
       This was Promise.all over the investments with one or two writes each
       and no transaction: a failure partway left some carrying the new
       instruction and the rest on the old one — on the setting that decides
       whether the money pays out or reinvests — reported as one generic error
       with no way to tell which had taken. It also sent one confirmation
       e-mail per investment for a single decision. */
    const r = await API._fetch('POST', 'investments/pool/' + poolId + '/instruction', {
      instruction:          type,
      custom_payout_amount: customAmt,
      switch_product_type:  switchProductType,
    });
    const n = r?.updated ?? poolInvs.length;
    Toast.success(`Maturity instruction applied to ${n} investment${n === 1 ? '' : 's'}!`);
    SVC.track('svc_pool_maturity_instruction', { pool_id: poolId, action: type });
    Modal.close('maturityModal');
    PORTAL.investments = [];
    await loadPortalData();
    loadMaturity();
  } catch (e) {
    console.error('[pool maturity]', e, { instruction: type, switch_product_type: switchProductType, custom_payout_amount: customAmt });
    _matShowError(e.message || 'Could not save this instruction. Please try again.');
  }
}

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
  if (_tktAttachFile) {
    attachmentInfo = `\n\n📎 Attachment: ${_tktAttachFile.name} (${(_tktAttachFile.size/1024).toFixed(1)} KB)`;
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
        file_url:       _tktAttachBase64 || null,
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
  const totalInvested = investments.filter(i => !i.is_reinvestment).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  // Earned, not projected — a target return must never move portfolio value.
  const totalReturns  = Utils.earnedReturns(investments);
  const walletBal     = Number(investor.wallet_balance) || 0;
  const totalValue    = Utils.portfolioValue(investments, walletBal);

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

async function generateStatement() {
  // Guard: PORTAL.investor must be populated (set in loadPortalData)
  if (!PORTAL.investor) {
    Toast.error('Portfolio data is still loading — please wait a moment and try again.');
    return;
  }

  /* Fetched once per session. The dashboard's 200-row page is enough for the
     dashboard; a statement needs all of it. */
  if (!PORTAL._fullHistory) {
    const btn = document.getElementById('stmtGenerateBtn');
    const label = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading your history…'; }
    PORTAL._fullHistory = await loadFullTransactionHistory();
    if (btn) { btn.disabled = false; if (label) btn.innerHTML = label; }
  }
  const _hist = PORTAL._fullHistory;

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

  const investor       = PORTAL.investor || {};
  const allInvestments = PORTAL.investments || [];
  const allTxns        = (_hist && _hist.transactions && _hist.transactions.length)
                          ? _hist.transactions : (PORTAL.transactions || []);

  /* All the arithmetic in one place, shared with the mobile app. The balances
     only reconcile if every transaction is present, so whether the portal
     managed to load the full history is passed in and printed on the document
     when it did not. */
  const F = computeStatementFigures({
    investor, transactions: allTxns, investments: allInvestments,
    from, to, complete: !!(_hist && _hist.complete),
  });

  const transactions  = F.transactions;
  const investments   = F.investments;
  const walletBal     = F.walletNow;
  const totalValue    = F.portfolioValueToday;
  const totalDeposits = F.deposits;
  const totalReturns  = F.returns;
  const activeInv     = F.activeInvCount;
  const totalCapital  = F.capitalInPeriod;
  const activeInvAmt  = F.activeInvAmt;

  // Build preview quick stats
  const previewEl = document.getElementById('stmtQuickStats');
  if (previewEl) {
    previewEl.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:8px">
        ${quickStatRow('Period', `${fmtDate(from)} — ${fmtDate(to)}`)}
        ${quickStatRow('Investments in Period', investments.length)}
        ${quickStatRow('Transactions in Period', transactions.length)}
        ${quickStatRow('Capital Placed in Period', Utils.rand(totalCapital))}
        ${quickStatRow('Returns in Period', Utils.rand(totalReturns))}
        ${quickStatRow('Closing Balance', Utils.rand(F.closing))}
        ${quickStatRow('Portfolio Value (today)', Utils.rand(totalValue))}
      </div>
    `;
  }

  // Build full statement document
  const doc = document.getElementById('statementDocument');
  if (!doc) return;

  const stmtNo = statementNumber(investor.id, from, to);
  const generatedAt = new Date().toLocaleString('en-ZA', {dateStyle:'long', timeStyle:'short'});

  /* THE SAME DOCUMENT THE CONSOLE PRODUCES.
   *
   * The portal used to assemble its own statement from whatever the browser
   * had cached, with its own idea of which transaction types move cash. Two
   * implementations of one document is two answers to "what is my balance",
   * and a client can hold both. It now asks the server for the same payload
   * the console reads and renders it with the same builder — see
   * js/investor-documents.js and server/services/accountStatement.js.
   *
   * It goes in an IFRAME. The document is a complete HTML page whose stylesheet
   * targets bare `table`, `th`, `td` and `body`; dropped into a div those rules
   * would escape and restyle the portal around it. */
  let stmtData;
  try {
    stmtData = await API._fetch('GET',
      `statements/account-statement?from=${encodeURIComponent(fromVal)}&to=${encodeURIComponent(toVal)}`);
  } catch (err) {
    doc.innerHTML = `<div style="padding:24px;text-align:center;color:#b91c1c;font-size:0.85rem">
      Could not generate your statement: ${_esc(err.message || 'error')}<br>
      <button class="btn btn--secondary btn--sm" style="margin-top:10px" onclick="generateStatement()">Try again</button>
    </div>`;
    return;
  }
  PORTAL._lastStatement = stmtData;

  /* Scaled to fit rather than squeezed. The statement is an A4 LANDSCAPE
     document that lays out at 1100px and does not reflow — on a phone the
     unscaled frame showed a sliver of the page with the right-hand column off
     the edge. What downloads is unaffected: still A4, still full size. */
  SVCDocs.mountScaled(doc, SVCDocs.accountStatementHTML(stmtData), SVCDocs.STATEMENT_WIDTH);
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

/* ── Sub-account deposit ─────────────────────── */
function openSaDeposit(saId) {
  Modal.close('saDetailModal');
  openTopUpModal(null, saId);
}

/* ─── Referral ─── */
function copyReferralLink() {
  const link = document.getElementById('referralLink').textContent;
  navigator.clipboard.writeText(link).then(() => Toast.success('Link copied to clipboard!')).catch(() => Toast.error('Copy failed'));
  SVC.track('svc_referral_link_copied', { referral_code: PORTAL.investor?.referral_code });
}

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

    // Update the pov-rewards stat tile — renderOverview() runs before this
    // resolves so the tile would otherwise stay at "Seed · 0 XP" indefinitely
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
/* One definition of what each milestone requires.

   These badges are lifetime achievements — "R50,000 Invested", "Join the R50k
   club" — not statements about a current balance, so they count every
   investment the client has ever made, excluding only cancelled ones. An
   investor whose money has matured and cycled keeps what they earned.
   investors.total_invested is itself cumulative (only ever incremented, never
   reduced at maturity); the ledger sum is a fallback for investors migrated in
   without one.

   This map used to be written out three times. That is how set_maturity came
   to be hardcoded false in one copy and missing from the other two, and
   first_referral with it — so neither badge could ever unlock, however many
   instructions were set or friends referred. */
function _milestoneConditions() {
  const inv     = PORTAL.investor     || {};
  const invests = PORTAL.investments   || [];
  const txns    = PORTAL.transactions  || [];
  const quests  = PORTAL.quests        || {};

  const lifetime = invests.filter(i => i.status !== 'cancelled');
  const stored   = parseFloat(inv.total_invested) || 0;
  const ledger   = lifetime.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  const totalInvested = Math.max(stored, ledger);

  const productTypes = new Set(lifetime.map(i => i.product_type).filter(Boolean));

  return {
    first_topup:      txns.some(t => t.type === 'deposit'),
    first_investment: lifetime.length > 0,
    diversify:        productTypes.size >= 2,
    milestone_10k:    totalInvested >= 10000,
    milestone_50k:    totalInvested >= 50000,
    milestone_100k:   totalInvested >= 100000,
    // Met as soon as any investment carries an instruction.
    set_maturity:     lifetime.some(i => i.maturity_instruction),
    /* The portal only ever loads its own investor, so it cannot see who signed
       up under this referral code. The count arrives with the quests. */
    first_referral:   (quests.referralCount || 0) > 0,
  };
}

async function _autoClaimMilestones() {
  if (!PORTAL.quests || !PORTAL.investor) return;
  const completed = new Set(PORTAL.quests.completedIds || []);
  const milestoneConditions = _milestoneConditions();

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
  const milestones = _milestoneConditions();

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

function renderQuestView() {
  if (!PORTAL.quests) {
    const _catEl = document.getElementById('questCategories');
    if (_catEl && !_catEl.dataset.questLoading) {
      _catEl.dataset.questLoading = '1';
      _catEl.innerHTML = '<div style="text-align:center;padding:40px 16px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin" style="font-size:1.4rem;margin-bottom:10px;display:block"></i>Loading quests…</div>';
    }
    if (!_catEl?.dataset.questLoading || _catEl.dataset.questLoading === '1') {
      if (_catEl) _catEl.dataset.questLoading = '2';
      loadQuestData().then(() => {
        if (_catEl) delete _catEl.dataset.questLoading;
        renderQuestView();
      });
    }
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
    if (rwRef)  rwRef.textContent  = `${Utils.rand(referralBonuses)}`;
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
  const milestones = _milestoneConditions();

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
          <div class="pending-group__label"><i class="fa-solid fa-bolt" style="color:#fec24f"></i> Quick wins — complete a short survey</div>
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
          <div class="quest-category__icon-wrap" style="background:rgba(254,194,79,0.1)">
            <i class="fa-solid ${cat.icon}" style="color:#fec24f"></i>
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

  // Load existing feedback state for the Leave a Review card
  loadMyFeedback();
}

function setFbStar(n) {
  _fbRating = n;
  document.querySelectorAll('.fb-star').forEach(s => {
    s.style.color = parseInt(s.dataset.v) <= n ? '#fec24f' : '#d1d5db';
  });
}

async function loadMyFeedback() {
  try {
    const res = await fetch((window.__SVC_API_BASE__ || '/api/') + 'testimonials/my', {
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('svc_token') || '') },
    });
    const { data } = await res.json();
    if (data) {
      const wrap = document.getElementById('feedbackFormWrap');
      const done = document.getElementById('feedbackSubmitted');
      const statusEl = document.getElementById('feedbackSubmittedStatus');
      if (wrap) wrap.style.display = 'none';
      if (done) done.style.display = '';
      if (statusEl) {
        const msgs = { pending: 'Your review is pending admin approval.', approved: '✓ Your review is live on the homepage!', rejected: 'Your review was not approved. You can resubmit.' };
        statusEl.textContent = msgs[data.status] || '';
        if (data.status === 'rejected') {
          statusEl.innerHTML += ` <button class="btn btn--sm btn--ghost" style="margin-top:8px;display:block" onclick="document.getElementById('feedbackFormWrap').style.display='';document.getElementById('feedbackSubmitted').style.display='none'">Edit & Resubmit</button>`;
          if (wrap) wrap.style.display = '';
          if (done) done.style.display = 'none';
          // Pre-fill
          const bodyEl = document.getElementById('feedbackBody');
          const lblEl = document.getElementById('feedbackProductLabel');
          if (bodyEl) bodyEl.value = data.body || '';
          if (lblEl) lblEl.value = data.product_label || '';
          setFbStar(data.rating || 0);
        }
      }
    }
  } catch (_) {}
}

async function submitFeedback() {
  const btn = document.getElementById('feedbackSubmitBtn');
  const msg = document.getElementById('feedbackMsg');
  const body = document.getElementById('feedbackBody')?.value?.trim();
  const productLabel = document.getElementById('feedbackProductLabel')?.value?.trim();

  if (!_fbRating) { if (msg) { msg.style.display = ''; msg.style.color = '#ef4444'; msg.textContent = 'Please select a star rating.'; } return; }
  if (!body || body.length < 20) { if (msg) { msg.style.display = ''; msg.style.color = '#ef4444'; msg.textContent = 'Please write at least 20 characters.'; } return; }

  if (btn) btn.disabled = true;
  if (msg) msg.style.display = 'none';

  try {
    const res = await fetch((window.__SVC_API_BASE__ || '/api/') + 'testimonials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('svc_token') || '') },
      body: JSON.stringify({ rating: _fbRating, body, product_label: productLabel }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submission failed');

    const wrap = document.getElementById('feedbackFormWrap');
    const done = document.getElementById('feedbackSubmitted');
    const statusEl = document.getElementById('feedbackSubmittedStatus');
    if (wrap) wrap.style.display = 'none';
    if (done) done.style.display = '';
    if (statusEl) statusEl.textContent = 'Your review is pending admin approval.';

    if (data.xpAwarded > 0) {
      Toast.success(`+${data.xpAwarded} XP earned for your feedback! 🌟`);
      if (PORTAL.quests) {
        PORTAL.quests.xp = (PORTAL.quests.xp || 0) + data.xpAwarded;
        renderXPWidget && renderXPWidget();
        _updateXPNavBadge && _updateXPNavBadge();
      }
    } else {
      Toast.success('Feedback submitted — thank you!');
    }
  } catch (err) {
    if (msg) { msg.style.display = ''; msg.style.color = '#ef4444'; msg.textContent = err.message; }
    if (btn) btn.disabled = false;
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
  const colors = ['#fec24f', '#22c55e', '#656565', '#fec24f', '#eda5ff'];
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

function initDarkMode() {
  document.body.classList.remove('dark-mode');
  localStorage.removeItem('svc_dark_mode');
}

function toggleDarkMode() {}

function _applyDark() { document.body.classList.remove('dark-mode'); }

function _checkAutoStartTour() {
  // Tour disabled on native Android — on-device UX is different enough that
  // the desktop-oriented tour is confusing. Users can still tap the tour
  // button manually if the topbar button is visible.
  if (window.__SVC_NATIVE__) return;
  if (localStorage.getItem('svc_tour_done')) return;
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

async function checkFirstDepositPrompt() {
  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  const neverKey   = `svc_deposit_never_${investorId}`;
  const laterKey   = `svc_deposit_later_${investorId}`;

  if (localStorage.getItem(neverKey)) return;  // permanently dismissed

  const snoozeUntil = parseInt(localStorage.getItem(laterKey) || '0');
  if (Date.now() < snoozeUntil) return;   // snoozed

  const hasDeposit = PORTAL.transactions.some(t => t.type === 'deposit');
  if (hasDeposit) return;  // already deposited

  // Populate product pills from products marked display_on_homepage
  try {
    const products = await _getPortalProducts();
    const el = document.getElementById('depositPromptProducts');
    if (el) {
      const visible = products.filter(p => p.display_on_homepage && p.is_active);
      el.innerHTML = visible.map(p =>
        `<span><i class="fa-solid ${p.icon || 'fa-circle'}"></i> ${p.label}</span>`
      ).join('');
    }
  } catch (_) {}

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

/* ── Load & render ──────────────────────────────────────────── */
async function loadSubAccounts() {
  try {
    const myId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
    const res = await API._fetch('GET', 'tables/sub_accounts', null, { parent_investor_id: myId, limit: 200 });
    const all = res.data || (Array.isArray(res) ? res : []);
    PORTAL.subAccounts = all.filter(a => a.parent_investor_id === myId || a.investor_id === myId);
    // Derive total_invested from actual investment records — more reliable than the DB field
    // which may be stale if investments were created before the column was maintained.
    if (Array.isArray(PORTAL.investments)) {
      PORTAL.subAccounts.forEach(sa => {
        const invs = PORTAL.investments.filter(i => i.sub_account_id === sa.id);
        const computed = invs.reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0);
        if (computed > 0) sa.total_invested = computed;
      });
    }
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
      <button class="btn btn--sm btn--secondary" onclick="openSaInvest('${sa.id}')"><i class="fa-solid fa-chart-line"></i> Invest</button>
      ${sa.kyc_status === 'approved' ? `<button class="btn btn--sm btn--ghost" onclick="openSaWithdrawal('${sa.id}')"><i class="fa-solid fa-arrow-up-from-bracket"></i> Withdraw</button>` : ''}
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

function openCreateSubAccountModal(preselectedType) {
  _saCreateType = null;
  _saCreateStep = 1;
  Modal.open('createSaModal');
  if (preselectedType) {
    saSelectType(preselectedType);
    saStep1Next();
  } else {
    _saShowCreateStep(1);
  }
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
      <i class="fa-solid fa-id-card" style="color:#fec24f"></i>
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

  const saAllTxns = PORTAL.transactions
    .filter(t => t.sub_account_id === sa.id);

  const saInvs = (PORTAL.investments || []).filter(i => i.sub_account_id === sa.id);

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

    <div style="display:flex;gap:8px;margin:16px 0;flex-wrap:wrap">
      <button class="btn btn--primary btn--sm" onclick="Modal.close('saDetailModal');openSaDeposit('${sa.id}')"><i class="fa-solid fa-wallet"></i> Deposit</button>
      <button class="btn btn--secondary btn--sm" onclick="Modal.close('saDetailModal');openSaInvest('${sa.id}')"><i class="fa-solid fa-chart-line"></i> Invest</button>
      ${sa.kyc_status === 'approved' ? `<button class="btn btn--secondary btn--sm" onclick="openSaWithdrawal('${sa.id}')"><i class="fa-solid fa-arrow-up-from-bracket"></i> Withdraw</button>` : ''}
      <button class="btn btn--ghost btn--sm" onclick="Modal.close('saDetailModal');downloadSaStatement('${sa.id}','${sa.name}')"><i class="fa-solid fa-file-pdf"></i> Statement</button>
      <button class="btn btn--ghost btn--sm" onclick="openSaBankDetails('${sa.id}')"><i class="fa-solid fa-building-columns"></i> Banking</button>
    </div>

    <div class="sa-section-title mt-16"><i class="fa-solid fa-building-columns"></i> Banking Details</div>
    <div style="padding:10px 0;font-size:0.82rem;color:var(--text-muted)">
      ${sa.sa_bank_name
        ? `<div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-weight:700;color:var(--text)">${sa.sa_bank_name}</div>
              <div>${sa.sa_bank_holder} · ****${(sa.sa_bank_number||'').slice(-4)} · ${sa.sa_bank_type || 'current'}</div>
            </div>
            <span class="badge badge--${sa.sa_bank_status === 'pending' ? 'orange' : sa.sa_bank_status === 'approved' ? 'green' : 'gray'}">${sa.sa_bank_status || 'none'}</span>
          </div>`
        : `<span style="color:var(--text-dim)">No banking details on file</span>`}
    </div>

    ${saInvs.length ? `
    <div class="sa-section-title"><i class="fa-solid fa-chart-line"></i> Active Investments</div>
    <table class="data-table">
      <thead><tr><th>Pool</th><th>Status</th><th>Matures In</th><th>Amount</th><th></th></tr></thead>
      <tbody>${saInvs.map(inv => {
        const pi = Utils.productInfo(inv.product_type);
        const daysLeft = inv.maturity_date ? Math.max(0, Math.ceil((new Date(inv.maturity_date) - Date.now()) / 86400000)) : null;
        return `<tr style="cursor:pointer" onclick="Modal.close('saDetailModal');navigate('investments',document.querySelector('[data-view=investments]'))">
          <td><span style="display:inline-flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:${pi.color};flex-shrink:0;display:inline-block"></span>${inv.pool_name || 'Investment'}</span></td>
          <td>${Utils.statusBadge(inv.status)}</td>
          <td class="td-muted">${daysLeft !== null ? `${daysLeft}d` : '—'}</td>
          <td class="td-green fw-700">${Utils.rand(inv.amount)}</td>
          <td>${inv.status === 'matured' && !inv.maturity_instruction ? `<button class="btn btn--ghost btn--sm" style="font-size:0.7rem;padding:2px 8px;white-space:nowrap" onclick="event.stopPropagation();Modal.close('saDetailModal');openMaturityModal('${inv.id}')">Give Instruction</button>` : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>` : ''}

    <div class="sa-section-title mt-16"><i class="fa-solid fa-id-card"></i> FICA Documents Required</div>
    <div class="sa-fica-list">${ficaItems}</div>
    <button class="btn btn--secondary btn--sm mt-8" onclick="openSaFicaUpload('${sa.id}')"><i class="fa-solid fa-upload"></i> Upload FICA Document</button>

    ${saAllTxns.length ? `
    <div class="sa-section-title mt-16"><i class="fa-solid fa-receipt"></i> All Transactions (${saAllTxns.length})</div>
    ${saAllTxns.length > 10 ? `<div style="max-height:320px;overflow-y:auto">` : ''}
    <table class="data-table">
      <thead><tr><th>Type</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
      <tbody>${saAllTxns.map(t => { const _p = !['withdrawal','fee','investment','gift_sent'].includes(t.type); return `<tr>
        <td><span class="badge badge--gray">${t.type}</span></td>
        <td class="${_p ? 'td-green' : 'td-red'} fw-700">${_p ? '' : '-'}${Utils.rand(Math.abs(t.amount))}</td>
        <td>${Utils.statusBadge(t.status)}</td>
        <td class="td-muted">${Utils.date(t.created_at)}</td>
      </tr>`; }).join('')}</tbody>
    </table>
    ${saAllTxns.length > 10 ? `</div>` : ''}` : ''}`;
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

  const ageInfo     = age || { age: '?', label: 'Saver', theme: 'minor-young' };
  const saInvsM     = (PORTAL.investments || []).filter(i => i.sub_account_id === sa.id);
  const saAllTxnsM  = (PORTAL.transactions || []).filter(t => t.sub_account_id === sa.id);

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
      </div>` : `<div style="margin-top:8px;font-size:0.78rem;color:rgba(255,255,255,0.7);text-align:center">No savings goal set — <a href="#" style="color:#fec24f" onclick="openSaGoalModal('${sa.id}')">set one now!</a></div>`}
    </div>

    <!-- Actions -->
    <div class="minor-actions">
      <button class="minor-btn minor-btn--deposit" onclick="Modal.close('saDetailModal');openSaDeposit('${sa.id}')"><i class="fa-solid fa-piggy-bank"></i><span>Add to Jar</span></button>
      <button class="minor-btn minor-btn--invest" onclick="Modal.close('saDetailModal');openSaInvest('${sa.id}')"><i class="fa-solid fa-seedling"></i><span>Invest</span></button>
      <button class="minor-btn minor-btn--fica" onclick="openSaFicaUpload('${sa.id}')"><i class="fa-solid fa-id-card"></i><span>FICA Docs</span></button>
    </div>
    <div style="display:flex;gap:8px;padding:0 22px 16px">
      <button class="btn btn--ghost btn--sm" style="flex:1" onclick="Modal.close('saDetailModal');downloadSaStatement('${sa.id}','${sa.name}')"><i class="fa-solid fa-file-pdf"></i> Statement</button>
      <button class="btn btn--ghost btn--sm" style="flex:1" onclick="openSaBankDetails('${sa.id}')"><i class="fa-solid fa-building-columns"></i> Banking</button>
    </div>

    ${saInvsM.length ? `
    <!-- Active Investments -->
    <div class="minor-investments">
      <div class="minor-investments__title"><i class="fa-solid fa-chart-line" style="color:#4ade80;margin-right:6px"></i>Active Investments</div>
      ${saInvsM.map(inv => {
        const pi = Utils.productInfo(inv.product_type);
        const daysLeft = inv.maturity_date ? Math.max(0, Math.ceil((new Date(inv.maturity_date) - Date.now()) / 86400000)) : null;
        return `<div class="minor-inv-row" onclick="Modal.close('saDetailModal');navigate('investments',document.querySelector('[data-view=investments]'))">
          <div class="minor-inv-row__icon" style="background:${pi.color}22;color:${pi.color}"><i class="fa-solid ${pi.icon}"></i></div>
          <div class="minor-inv-row__info">
            <div class="minor-inv-row__name">${inv.pool_name || 'Investment'}</div>
            <div class="minor-inv-row__sub">${daysLeft !== null ? `${daysLeft} days remaining` : inv.status}</div>
          </div>
          <div class="minor-inv-row__amount">${Utils.rand(inv.amount)}</div>
        </div>`;
      }).join('')}
    </div>` : ''}

    <!-- Learning Zone -->
    <div class="minor-learn-zone">
      <div class="minor-learn-zone__title">✨ Learning Zone</div>
      <div class="minor-tips-carousel" id="minorTipsCarousel">
        <!-- Populated by JS -->
      </div>
      <div class="minor-tips-dots" id="minorTipsDots"></div>
    </div>

    <!-- Banking Details -->
    <div class="minor-investments" style="margin-top:12px">
      <div class="minor-investments__title"><i class="fa-solid fa-building-columns" style="color:#eda5ff;margin-right:6px"></i>Banking Details</div>
      ${sa.sa_bank_name
        ? `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
            <div>
              <div style="font-size:0.82rem;font-weight:700;color:#fff">${sa.sa_bank_name}</div>
              <div style="font-size:0.72rem;color:rgba(255,255,255,0.6)">${sa.sa_bank_holder || ''} · ****${(sa.sa_bank_number||'').slice(-4)} · ${sa.sa_bank_type||'current'}</div>
            </div>
            <span class="badge badge--${sa.sa_bank_status==='approved'?'green':sa.sa_bank_status==='pending'?'orange':'gray'}" style="font-size:0.65rem">${sa.sa_bank_status||'none'}</span>
          </div>`
        : `<div style="font-size:0.78rem;color:rgba(255,255,255,0.5);padding:4px 0">No banking details — tap Banking above to add</div>`}
    </div>

    <!-- All Transactions -->
    ${saAllTxnsM.length ? `
    <div class="minor-investments" style="margin-top:12px">
      <div class="minor-investments__title"><i class="fa-solid fa-receipt" style="color:#fec24f;margin-right:6px"></i>All Transactions (${saAllTxnsM.length})</div>
      <div style="${saAllTxnsM.length > 8 ? 'max-height:240px;overflow-y:auto' : ''}">
        ${saAllTxnsM.map(t => `
        <div class="minor-inv-row">
          <div class="minor-inv-row__icon" style="background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.7)"><i class="fa-solid fa-receipt" style="font-size:0.8rem"></i></div>
          <div class="minor-inv-row__info">
            <div class="minor-inv-row__name">${t.description || t.type}</div>
            <div class="minor-inv-row__sub">${Utils.date(t.created_at || t.transaction_date)}</div>
          </div>
          <div class="minor-inv-row__amount" style="color:${!['withdrawal','fee','investment','gift_sent'].includes(t.type)?'#4ade80':'#ef4444'}">${['withdrawal','fee','investment','gift_sent'].includes(t.type)?'-':''}${Utils.rand(Math.abs(t.amount))}</div>
        </div>`).join('')}
      </div>
    </div>` : ''}

    <!-- FICA section -->
    <div class="minor-fica-section">
      <div class="minor-fica-section__title"><i class="fa-solid fa-id-card"></i> Required Documents</div>
      ${SA_TYPE_META.minor.ficaDocs.map(d => `<div class="sa-fica-item sa-fica-item--minor"><i class="fa-solid fa-circle-dot" style="color:#fec24f"></i><span>${d}</span></div>`).join('')}
      <button class="btn btn--primary btn--sm mt-12 w-full" onclick="openSaFicaUpload('${sa.id}')"><i class="fa-solid fa-upload"></i> Upload Documents</button>
    </div>

  </div>`;
}

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

async function confirmSaDeposit() {
  const saId    = document.getElementById('saDepositSaId').value;
  const amount  = parseFloat(document.getElementById('saDepositAmount').value);
  const ref     = document.getElementById('saDepositRef').value.trim() || `SA-EFT-${Date.now()}`;
  const sa      = PORTAL.subAccounts.find(a => a.id === saId);
  if (!sa || !amount || amount <= 0) { Toast.error('Enter a valid deposit amount'); return; }

  try {
    // Do NOT credit wallet_balance here — EFT funds are unconfirmed until admin verifies receipt.
    // Admin manually credits the balance once the bank transfer clears.
    await API._fetch('POST', 'tables/transactions', {
      investor_id:    PORTAL.investor?.id || DEMO_INVESTOR_ID,
      sub_account_id: saId,
      type:           'deposit',
      amount,
      status:         'pending',
      reference:      ref,
      description:    `EFT deposit to ${sa.name} — awaiting admin confirmation`,
    });
    Toast.success(`Deposit of ${Utils.rand(amount)} submitted for ${sa.name}. Your balance will be updated once we confirm receipt of the funds.`);
    Modal.close('saDepositModal');
    await loadSubAccounts();
  } catch (e) {
    Toast.error('Failed to record deposit. Please try again.');
    console.error(e);
  }
}

/* ── Invest from sub account ────────────────────────────────── */
function _showSaNoFundsPrompt(sa, minNeeded) {
  const bal     = parseFloat(sa.wallet_balance) || 0;
  const isEmpty = bal <= 0;
  document.getElementById('saNoFundsTitle').textContent = isEmpty
    ? `${sa.name}'s wallet is empty`
    : `Insufficient funds in ${sa.name}'s wallet`;
  document.getElementById('saNoFundsMsg').textContent = isEmpty
    ? `You need to deposit funds into ${sa.name}'s wallet before you can invest.`
    : `The cheapest open product requires a minimum of ${Utils.rand(minNeeded)}. The 1% platform fee is taken from your wallet amount (already included). Current balance: ${Utils.rand(bal)}.`;
  document.getElementById('saNoFundsBal').textContent   = Utils.rand(bal);
  document.getElementById('saNoFundsDepositBtn').onclick = () => {
    Modal.close('saNoFundsModal');
    openSaDeposit(sa.id);
  };
  Modal.open('saNoFundsModal');
}

function openSaInvest(saId) {
  const sa = PORTAL.subAccounts.find(a => a.id === saId);
  if (!sa) return;
  const bal      = parseFloat(sa.wallet_balance) || 0;
  const openPools = (PORTAL.pools || []).filter(p => p.status === 'open' && !_poolPastClose(p));
  const poolMins  = openPools.map(p => parseFloat(p.min_investment)).filter(v => v > 0);
  const minNeeded = poolMins.length ? Math.min(...poolMins) : 0;
  if (bal <= 0 || (minNeeded > 0 && bal < minNeeded)) { _showSaNoFundsPrompt(sa, minNeeded); return; }

  _pmSaId = saId;
  Modal.close('saDetailModal');
  Toast.info(`Investing from ${sa.name} — select a product below`);
  navigate('marketplace', document.querySelector('[data-view="marketplace"]'));
}

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
  if (!_saFicaSaId) { Toast.error('No sub-account selected'); return; }
  if (!_saFicaFile || !_saFicaB64) {
    Toast.error('An attachment is required — please select a file to upload');
    const inp = document.getElementById('saFicaFileInput');
    if (inp) { inp.style.outline = '2px solid #ef4444'; setTimeout(() => { inp.style.outline = ''; }, 2500); }
    return;
  }
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
      file_data:      _saFicaB64,
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

function openSaBankDetails(saId) {
  _saBankSaId = saId;
  const sa = PORTAL.subAccounts.find(s => s.id === saId);
  if (!sa) return;
  const f = id => document.getElementById(id);
  if (f('saBankName'))   f('saBankName').value   = sa.sa_bank_name   || '';
  if (f('saBankHolder')) f('saBankHolder').value  = sa.sa_bank_holder || '';
  if (f('saBankNumber')) f('saBankNumber').value  = sa.sa_bank_number || '';
  if (f('saBankBranch')) f('saBankBranch').value  = sa.sa_bank_branch || '';
  if (f('saBankType'))   f('saBankType').value    = sa.sa_bank_type   || 'current';
  Modal.open('saBankModal');
}

async function saveSaBankDetails() {
  const fv = id => document.getElementById(id)?.value?.trim();
  const name      = fv('saBankName');
  const holder    = fv('saBankHolder');
  const number    = fv('saBankNumber');
  const branch    = fv('saBankBranch');
  const type      = fv('saBankType') || 'current';
  const proofFile = document.getElementById('saBankProof')?.files?.[0] || null;

  if (!name || !holder || !number) { Toast.warn('Please fill in bank name, account holder, and account number'); return; }
  const sa = PORTAL.subAccounts.find(s => s.id === _saBankSaId);
  const hasExisting = !!(sa?.sa_bank_number);
  if (!proofFile && !hasExisting) { Toast.warn('Please attach proof of bank account (statement or confirmation letter)'); return; }

  try {
    let proofData = null;
    if (proofFile) {
      proofData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(proofFile);
      });
    }

    await API._fetch('PATCH', `tables/sub_accounts/${_saBankSaId}`, {
      sa_bank_name:   name,
      sa_bank_holder: holder,
      sa_bank_number: number,
      sa_bank_branch: branch,
      sa_bank_type:   type,
      sa_bank_status: 'pending',
    });
    if (sa) { Object.assign(sa, { sa_bank_name: name, sa_bank_holder: holder, sa_bank_number: number, sa_bank_branch: branch, sa_bank_type: type, sa_bank_status: 'pending' }); }

    const maskedNum = number.slice(-4).padStart(number.length, '•');
    const investorId   = PORTAL.investor?.id;
    const investorName = `${PORTAL.investor?.first_name || ''} ${PORTAL.investor?.last_name || ''}`.trim();

    if (proofData) await API.kyc.create({
      investor_id:    investorId,
      investor_name:  investorName || undefined,
      doc_type:       'proof_of_bank',
      status:         'pending',
      file_name:      proofFile.name,
      file_data:      proofData,
      notes:          `Sub-account banking: ${sa?.name || _saBankSaId} — ${name} ${maskedNum}`,
    }).catch(e => console.warn('[saBankDetails] KYC doc failed:', e.message));

    Modal.close('saBankModal');
    Toast.success('Banking details submitted — the admin team will verify within 1–2 business days.');
    await loadSubAccounts();
  } catch (err) {
    Toast.error('Failed to save banking details');
    console.error(err);
  }
}

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
  // Proof is required for first-time submission; optional when updating existing details
  const hasExistingBank = !!(PORTAL.investor?.bank_account_number);
  if (!proofFile && !hasExistingBank) {
    Toast.error('Please attach a proof of bank account'); return;
  }

  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  const investorName = `${PORTAL.investor?.first_name || ''} ${PORTAL.investor?.last_name || ''}`.trim();
  try {
    // Read the proof of bank file as a base64 data URL so admin can view & approve it
    let proofData = null;
    if (proofFile) {
      proofData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(proofFile);
      });
    }

    const bankPatch = {
      bank_name,
      bank_account_holder,
      bank_account_number,
      bank_branch_code,
      bank_account_type,
      bank_account_status: 'pending',
      bank_account_notes: null,
    };
    const updated = await API._fetch('PATCH', `tables/investors/${investorId}`, bankPatch);
    if (PORTAL.investor) Object.assign(PORTAL.investor, updated);

    // Create a KYC document entry only when the investor attached a proof file
    const maskedAccNum = bank_account_number.slice(-4).padStart(bank_account_number.length, '•');
    if (proofData) await API.kyc.create({
      investor_id:   investorId,
      investor_name: investorName || undefined,
      doc_type:      'proof_of_bank',
      status:        'pending',
      file_name:     proofFile.name,
      file_data:     proofData,
      notes:         `Bank account submitted: ${bank_name} — ${maskedAccNum}`,
    }).catch(e => console.warn('[bank details] KYC doc failed:', e.message));

    _renderBankDetailsPanel();
    Toast.success('Bank details saved! The admin team will verify them within 1–2 business days.');
    Modal.close('bankDetailsModal');
  } catch (e) {
    Toast.error('Failed to save bank details. Please try again.');
    console.error(e);
  }
}

function openSaWithdrawal(saId) {
  _saWithdrawalId = saId;
  const content = document.getElementById('withdrawalModalContent');
  const footer  = document.getElementById('withdrawalModalFooter');
  const sa      = (PORTAL.subAccounts || []).find(s => s.id === saId);
  if (!sa) { Toast.error('Sub-account not found'); return; }
  const balance = parseFloat(sa.wallet_balance || 0);

  if (sa.kyc_status !== 'approved') {
    content.innerHTML = `
      <div style="text-align:center;padding:20px 0">
        <i class="fa-solid fa-shield-halved" style="font-size:2.5rem;color:#656565;margin-bottom:16px"></i>
        <p style="font-size:0.9rem;font-weight:700;color:#1a1a1a;margin-bottom:8px">FICA verification required</p>
        <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:16px">${sa.name} needs completed FICA/KYC before withdrawals. Upload the required documents from the sub-account details page.</p>
      </div>`;
    footer.style.display = 'none';
    Modal.open('withdrawalModal');
    return;
  }

  if (!sa.sa_bank_number) {
    content.innerHTML = `
      <div style="text-align:center;padding:20px 0">
        <i class="fa-solid fa-building-columns" style="font-size:2.5rem;color:#9ca3af;margin-bottom:16px"></i>
        <p style="font-size:0.9rem;color:var(--text-muted);margin-bottom:16px">You need to add a verified bank account to ${sa.name} before withdrawing.</p>
        <button class="btn btn--primary" onclick="Modal.close('withdrawalModal');openSaBankDetails('${sa.id}')"><i class="fa-solid fa-plus"></i> Add Bank Account</button>
      </div>`;
    footer.style.display = 'none';
    Modal.open('withdrawalModal');
    return;
  }

  if (sa.sa_bank_status !== 'approved') {
    content.innerHTML = `
      <div style="text-align:center;padding:20px 0">
        <i class="fa-solid fa-clock" style="font-size:2.5rem;color:#fec24f;margin-bottom:16px"></i>
        <p style="font-size:0.9rem;color:var(--text-muted)">${sa.sa_bank_status === 'pending' ? 'The bank account for ' + sa.name + ' is pending verification. Withdrawals will be available once approved.' : 'Bank account not verified. Please update bank details.'}</p>
      </div>`;
    footer.style.display = 'none';
    Modal.open('withdrawalModal');
    return;
  }

  const pendingWithdrawal = (PORTAL.transactions || []).find(t => t.sub_account_id === saId && t.type === 'withdrawal' && t.status === 'pending');
  if (pendingWithdrawal) {
    content.innerHTML = `
      <div style="padding:14px 16px;border-radius:14px;background:rgba(47,140,155,0.08);border:1px solid rgba(47,140,155,0.18)">
        <div style="font-size:0.92rem;font-weight:800;color:#1a1a1a">A withdrawal for ${sa.name} is already in progress.</div>
        <div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;line-height:1.55">${Utils.rand(Math.abs(parseFloat(pendingWithdrawal.amount)||0))} was requested on ${Utils.date(pendingWithdrawal.created_at||pendingWithdrawal.transaction_date)}. Most payouts land within 1–2 business days.</div>
      </div>`;
    footer.style.display = 'none';
    Modal.open('withdrawalModal');
    return;
  }

  if (balance < 50) {
    content.innerHTML = `
      <div style="text-align:center;padding:20px 0">
        <i class="fa-solid fa-wallet" style="font-size:2.5rem;color:#9ca3af;margin-bottom:16px"></i>
        <p style="font-size:0.9rem;color:var(--text-muted)">The available balance for ${sa.name} is <strong>${Utils.rand(balance)}</strong>. The minimum withdrawal is R50.</p>
      </div>`;
    footer.style.display = 'none';
    Modal.open('withdrawalModal');
    return;
  }

  const masked = '••••••' + String(sa.sa_bank_number).slice(-4);
  const quickAmounts = [0.25, 0.5, 1].map(r => Math.floor((balance * r) / 10) * 10).filter(v => v >= 50);
  content.innerHTML = `
    <div style="margin-bottom:10px;padding:8px 12px;border-radius:8px;background:rgba(237,165,255,0.08);border:1px solid rgba(237,165,255,0.2);font-size:0.8rem;color:var(--text-muted)">
      <i class="fa-solid fa-folder-open" style="color:#eda5ff;margin-right:6px"></i>Withdrawing from <strong>${Utils.esc ? Utils.esc(sa.name) : sa.name}</strong>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px">
      <div style="padding:12px 14px;border-radius:12px;background:#F8FAFC;border:1px solid rgba(0,0,0,0.06)">
        <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;font-weight:800">Available now</div>
        <div style="font-size:1.08rem;font-weight:900;color:#1a1a1a;margin-top:4px">${Utils.rand(balance)}</div>
      </div>
      <div style="padding:12px 14px;border-radius:12px;background:#F8FAFC;border:1px solid rgba(0,0,0,0.06)">
        <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;font-weight:800">Destination</div>
        <div style="font-size:0.88rem;font-weight:800;color:#1a1a1a;margin-top:6px">${sa.sa_bank_name || ''} ${masked}</div>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Withdrawal Amount (R) <span style="color:#ef4444">*</span></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        ${quickAmounts.map(v => `<button type="button" class="btn btn--secondary btn--sm" onclick="document.getElementById('wdAmount').value='${v}';_withdrawCalcSa(${balance})">${v >= balance ? 'All available' : Utils.rand(v)}</button>`).join('')}
      </div>
      <input type="number" class="form-input" id="wdAmount" placeholder="e.g. ${balance.toFixed(0)}" min="50" max="${balance.toFixed(2)}" oninput="_withdrawCalcSa(${balance})" />
      <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px">Maximum: ${Utils.rand(balance)} · Minimum: R50</div>
    </div>
    <div id="wdCalcBox" style="display:none;margin-top:4px"></div>
    <div class="info-box" style="background:rgba(254,194,79,0.06);border:1px solid rgba(254,194,79,0.2);border-radius:10px;padding:12px 14px;font-size:0.8rem;color:var(--text-muted);margin-top:12px;line-height:1.6">
      <i class="fa-solid fa-shield-halved" style="color:#fec24f"></i>
      Funds are sent only to the verified bank account on file for this sub-account. Requests are reviewed within 1–2 business days.
    </div>`;
  footer.style.display = '';
  Modal.open('withdrawalModal');
}

function _withdrawCalcSa(balance) {
  const amount = parseFloat(document.getElementById('wdAmount')?.value || 0);
  const box    = document.getElementById('wdCalcBox');
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
  box.style.display = '';
  box.innerHTML = `
    <div style="padding:10px 12px;border-radius:10px;background:#F8FAFC;border:1px solid rgba(0,0,0,0.06)">
      <div class="info-row" style="padding:0 0 6px"><span class="info-row__label">You will receive</span><span class="info-row__value" style="font-weight:800;color:#1a1a1a">${Utils.rand(amount)}</span></div>
      <div class="info-row" style="padding:6px 0;border-top:1px solid rgba(0,0,0,0.06)"><span class="info-row__label">Remaining in sub-account wallet</span><span class="info-row__value text-gold">${Utils.rand(balance - amount)}</span></div>
    </div>`;
}

function openWithdrawalModal() {
  _saWithdrawalId = null;
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
        <i class="fa-solid fa-clock" style="font-size:2.5rem;color:#fec24f;margin-bottom:16px"></i>
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
    <div class="info-box" style="background:rgba(254,194,79,0.06);border:1px solid rgba(254,194,79,0.2);border-radius:10px;padding:12px 14px;font-size:0.8rem;color:var(--text-muted);margin-top:12px;line-height:1.6">
      <i class="fa-solid fa-shield-halved" style="color:#fec24f"></i>
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
  const amount = parseFloat(document.getElementById('wdAmount')?.value || 0);
  const btn    = document.getElementById('withdrawalConfirmBtn');

  if (_saWithdrawalId) {
    const sa      = (PORTAL.subAccounts || []).find(s => s.id === _saWithdrawalId);
    const balance = parseFloat(sa?.wallet_balance || 0);
    if (!amount || amount < 50) { Toast.error('Minimum withdrawal is R50'); return; }
    if (amount > balance)       { Toast.error('Amount exceeds available balance'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
    try {
      const result = await API._fetch('POST', 'withdrawals/request', {
        amount,
        sub_account_id:      _saWithdrawalId,
        bank_account_number: sa.sa_bank_number || undefined,
        bank_name:           sa.sa_bank_name   || undefined,
      });
      Toast.success('Withdrawal request submitted! Funds will be sent within 1–2 business days.');
      Modal.close('withdrawalModal');
      _saWithdrawalId = null;
      await loadPortalData();
    } catch (e) {
      Toast.error(e.message || 'Withdrawal failed. Please try again.');
      console.error(e);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Request Withdrawal'; }
    }
    return;
  }

  const balance = parseFloat(PORTAL.investor?.wallet_balance || 0);
  if (!amount || amount < 50) { Toast.error('Minimum withdrawal is R50'); return; }
  if (amount > balance)       { Toast.error('Amount exceeds available balance'); return; }

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

async function generateTaxCertificate() {
  /* THE SAME DOCUMENT THE CONSOLE PRODUCES.
   *
   * This used to build its own certificate from whatever the browser had
   * cached, and it was wrong in the two ways the console's copy had already
   * been corrected for: it counted `payout` as income — a payout is the
   * client's capital coming back PLUS the return on it, so returned capital
   * was declared as taxable earnings — and it windowed the tax year on
   * created_at, which on a migrated ledger is one import timestamp across
   * every row.
   *
   * It now asks the server for the same payload the console reads and renders
   * it with the same builder. A client and a staff member looking at the same
   * tax year cannot be shown different figures, or a different document.
   *
   * The realised return still comes from the POOL's posted rate, which is the
   * part a client-side rebuild cannot get right: investments.actual_return
   * defaults to 0 rather than NULL, so anything reading it directly reports
   * R 0,00 against every matured holding. */
  if (!PORTAL.investor) { Toast.error('Portfolio data still loading — please wait'); return; }

  const taxYearEl = document.getElementById('taxYearSelect');
  const taxYear = taxYearEl ? parseInt(taxYearEl.value) : new Date().getFullYear();

  let data;
  try {
    data = await API._fetch('GET', `statements/income-reference/${taxYear}`);
  } catch (err) {
    Toast.error('Could not generate your income reference: ' + (err.message || 'please try again'));
    return;
  }

  /* Parked on PORTAL rather than in a module-level variable: portal-core.js
     carries no top-level state, because the file is shared by two bundles and
     a second declaration of the same name is a redeclaration error. */
  PORTAL._lastTaxCertHTML = SVCDocs.incomeReferenceHTML(data);
  PORTAL._lastTaxCert     = data;

  SVC.track('svc_tax_cert_generated', { tax_year: taxYear });
  SVCDocs.openIncomeReference(data);
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
  body.innerHTML = '<div style="text-align:center;padding:20px"><i class="fa-solid fa-spinner fa-spin" style="font-size:1.5rem;color:#fec24f"></i><p style="margin-top:10px;color:var(--text-muted);font-size:0.85rem">Generating your secret…</p></div>';
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
        <div style="font-family:monospace;font-size:0.85rem;font-weight:700;background:rgba(254,194,79,0.08);padding:8px 14px;border-radius:8px;letter-spacing:0.08em;word-break:break-all">${data.secret}</div>
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

function openInvestNowPicker() {
  const body = document.getElementById('investNowPickerBody');
  if (!body) return;

  const products = (_mktProducts && _mktProducts.length)
    ? _mktProducts
    : [...new Set((PORTAL.pools || []).map(p => p.product_type))].map(t => ({ product_type: t }));

  const openCounts = {};
  (PORTAL.pools || []).forEach(p => {
    if (p.status === 'open' && !_poolPastClose(p)) openCounts[p.product_type] = (openCounts[p.product_type] || 0) + 1;
  });

  body.innerHTML = products.map(prod => {
    const pi = Utils.productInfo(prod.product_type);
    const meta = _POOL_META[prod.product_type] || {};
    const open = openCounts[prod.product_type] || 0;
    return `
      <div onclick="selectInvestNowProduct('${_esc(prod.product_type)}')" style="display:flex;align-items:center;gap:14px;padding:14px;border:1.5px solid rgba(0,0,0,0.07);border-radius:14px;cursor:pointer;background:var(--panel-bg,#fff);transition:border-color 0.15s" onmouseenter="this.style.borderColor='#fec24f'" onmouseleave="this.style.borderColor='rgba(0,0,0,0.07)'">
        <div style="width:46px;height:46px;border-radius:12px;background:${pi.color}1a;color:${pi.color};display:flex;align-items:center;justify-content:center;font-size:1.3rem;flex-shrink:0">
          <i class="fa-solid ${pi.icon}"></i>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:0.92rem;font-weight:800;color:var(--text-primary,#1a1a1a)">${prod.label || pi.label}</div>
          ${meta.blurb ? `<div style="font-size:0.75rem;color:var(--text-muted,#6b7280);margin-top:2px">${meta.blurb}</div>` : ''}
          <div style="font-size:0.72rem;margin-top:4px;font-weight:600;${open ? 'color:#65ed00' : 'color:#9ca3af'}">
            <i class="fa-solid ${open ? 'fa-circle-check' : 'fa-clock'}" style="font-size:0.65rem"></i>
            ${open ? `${open} open pool${open !== 1 ? 's' : ''}` : 'No open pools currently'}
          </div>
        </div>
        <i class="fa-solid fa-chevron-right" style="color:#9ca3af;font-size:0.8rem;flex-shrink:0"></i>
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
      (PORTAL.pools || []).filter(p => p.status === 'open' && !_poolPastClose(p) && p.product_type !== 'delivery_bikes' && p.product_type !== 'delivery_bike').map(p =>
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

async function loadReferralDashboard() {
  if (!PORTAL.investor) await loadPortalData();
  const inv  = PORTAL.investor;
  const code = inv?.referral_code || '';

  /* The link used to point at /register, which is not a route — it fell
     through to the SPA catch-all and served the landing page, so nobody
     clicking a referral link ever reached the signup form. The page is
     /signup, and it reads ?ref= to pre-fill the code. */
  const codeEl = document.getElementById('referralCode');
  const linkEl = document.getElementById('referralLink');
  if (codeEl) codeEl.textContent = code || '—';
  const refLink = code ? `${window.location.origin}/signup?ref=${code}` : '—';
  if (linkEl) linkEl.textContent = refLink;

  /* Who signed up under this code has to come from the server. This used to
     filter PORTAL.investors, which the investor portal never populates — an
     investor only ever loads their own record — so every stat read zero no
     matter how many people had joined. */
  let referred = [], approved = 0, invested = 0, points = 0;
  let POINTS_PER_REFERRAL = 100;
  try {
    const r = await API._fetch('GET', 'referrals/my');
    referred = r?.referrals    || [];
    approved = r?.approved     || 0;
    invested = r?.invested     || 0;
    points   = r?.pointsEarned || 0;
    POINTS_PER_REFERRAL = r?.pointsPerReferral || POINTS_PER_REFERRAL;
  } catch (e) {
    console.warn('[referrals] could not load:', e.message);
  }

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('refStatTotal',    referred.length);
  set('refStatApproved', approved);
  set('refStatInvested', invested);
  // Points, not rand — referring earns XP towards the next level, not cash.
  set('refStatBonuses',  points ? `${points} XP` : '0 XP');

  const body = document.getElementById('referredInvestorsBody');
  if (!body) return;
  if (!referred.length) {
    body.innerHTML = `<tr><td colspan="5" class="text-center text-muted" style="padding:16px">No referrals yet — share your code to get started <i class="fa-solid fa-arrow-up-right-from-square" style="margin-left:4px"></i></td></tr>`;
    return;
  }
  body.innerHTML = referred.map(r => {
    // Every signup earns the same points; there is no per-referral cash to
    // chase up, so nothing here is ever "pending".
    const bonusCell = `<span style="font-weight:700;color:#22c55e">+${POINTS_PER_REFERRAL} XP</span>`;
    return `
    <tr>
      <td><div style="font-weight:600;font-size:0.82rem;color:#1a1a1a">${_esc(r.firstName)} ${_esc(r.lastName)}</div></td>
      <td>${Utils.statusBadge(r.status)}</td>
      <td>${r.invested
        ? `<span class="badge badge--green">Invested</span>`
        : `<span class="badge badge--gray">Not yet</span>`}</td>
      <td style="font-size:0.75rem;color:#6b7280">${Utils.date(r.joinedAt)}</td>
      <td>${bonusCell}</td>
    </tr>
  `}).join('');
}

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
  if (zone) zone.style.borderColor = 'rgba(254,194,79,0.35)';
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    // Bug #10 fix: actually reset the input value (the old line was a no-op read)
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
  if (zone) { zone.style.borderColor = 'rgba(254,194,79,0.35)'; zone.style.background = 'rgba(254,194,79,0.03)'; }
}

function _kycDocTypeChanged(val) {
  const grp = document.getElementById('kycDocSubtypeGroup');
  if (grp) grp.style.display = val === 'id_document' ? '' : 'none';
}

function openKycUploadModal(docType) {
  _kycClearFile();
  const typeEl     = document.getElementById('kycDocType');
  const notesEl    = document.getElementById('kycNotes');
  const subtypeEl  = document.getElementById('kycDocSubtype');
  const subtypeGrp = document.getElementById('kycDocSubtypeGroup');
  if (typeEl)     typeEl.value     = docType || '';
  if (notesEl)    notesEl.value    = '';
  if (subtypeEl)  subtypeEl.value  = '';
  if (subtypeGrp) subtypeGrp.style.display = docType === 'id_document' ? '' : 'none';
  Modal.open('kycUploadModal');
}

async function submitKycDocument() {
  const docType = document.getElementById('kycDocType')?.value;
  if (!docType) { Toast.error('Please select a document type'); return; }
  if (!_kycFile) {
    Toast.error('An attachment is required — please select a file to upload');
    const dz = document.getElementById('kycDropZone');
    if (dz) { dz.style.borderColor = '#ef4444'; setTimeout(() => { dz.style.borderColor = 'rgba(255,155,12,0.35)'; }, 2500); }
    return;
  }

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
    const notes      = (document.getElementById('kycNotes')?.value || '').trim();
    const docSubtype = document.getElementById('kycDocSubtype')?.value || '';

    if (docType === 'id_document' && !docSubtype) {
      Toast.error('Please select the ID document type (SA ID, Passport, or Asylum Permit)');
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit for Review'; }
      return;
    }

    const subtypeLabels = { rsa_id: 'SA ID', passport: 'Passport', asylum_permit: 'Asylum Permit' };
    const noteParts = [notes];
    if (docSubtype) noteParts.push(`DocType: ${subtypeLabels[docSubtype] || docSubtype}`);
    noteParts.push(`File: ${_kycFile.name} (${(_kycFile.size / 1024).toFixed(1)} KB)`);

    await API.kyc.create({
      investor_id:   inv?.id || DEMO_INVESTOR_ID,
      investor_name: inv ? `${inv.first_name} ${inv.last_name}`.trim() : undefined,
      doc_type:      docType,
      doc_subtype:   docSubtype || undefined,
      status:        'pending',
      file_name:     _kycFile.name,
      file_data:     fileData,
      notes:         noteParts.filter(Boolean).join(' — '),
    });
    // Reflect that documents are now being checked (unless already fully verified)
    if (inv && inv.kyc_status !== 'approved' && inv.fica_status !== 'approved') {
      /* The documents themselves uploaded fine above; only this status flag is at
         risk. It used to swallow the failure AND update local state regardless, so the
         investor saw "verification in progress" while the server still had them as not
         started — and their KYC gates whether they can invest at all. Only reflect
         locally what the server actually accepted. */
      try {
        await API._fetch('PATCH', `tables/investors/${inv.id}`, { kyc_status: 'in_progress', fica_status: 'in_progress' });
        Object.assign(inv, { kyc_status: 'in_progress', fica_status: 'in_progress' });
      } catch (statusErr) {
        console.error('[kyc] status update failed:', statusErr.message);
        Toast.warning('Documents uploaded. Your verification status will refresh shortly.');
      }
    }
    Toast.success('Document submitted! The compliance team will review it within 1–2 business days.');
    SVC.track('svc_kyc_uploaded', { doc_type: docType });
    Modal.close('kycUploadModal');
    // Refresh both KYC panels with a single shared fetch (Bug #7 fix)
    _refreshKycPanels();
  } catch (e) {
    // Bug #15 fix: also check HTTP status 413, not just message keywords
    const msg = e?.message || '';
    if (e?.status === 413 || msg.includes('too large') || msg.includes('entity') || msg.includes('limit')) {
      Toast.error('File too large for upload. Please compress the image or use a smaller file (max 10 MB).');
    } else {
      Toast.error('Upload failed — please try again');
    }
    console.error('[submitKycDocument]', e);
  } finally {
    // Bug #8/12 fix: always clear _kycFile reference — prevents stale large object
    // sitting in memory after a failed upload
    _kycFile = null;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit for Review'; }
  }
}

// Refresh the investor record from the server so that admin-side KYC/FICA
// status changes (approvals, rejections) are immediately visible on the portal
// without requiring a full page reload. Called whenever the profile tab opens.
async function _refreshInvestorThenKyc() {
  try {
    if (PORTAL.investor?.id) {
      const fresh = await API.investors.get(PORTAL.investor.id).catch(() => null);
      if (fresh && fresh.id) Object.assign(PORTAL.investor, fresh);
    }
  } catch (_) {}
  _refreshKycPanels();
}

// Bug #7 fix: single fetch shared between both panel renderers to avoid two
// back-to-back identical API calls after every upload.
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

// Bug #7 fix: accepts optional pre-fetched docs from _refreshKycPanels()
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
  const overallNorm   = _normFicaStatus(overallStatus);
  const statusColor   = { approved: '#22c55e', verified: '#22c55e', rejected: '#ef4444', pending: '#fec24f', in_progress: '#fec24f', submitted: '#fec24f', not_started: '#9ca3af' };
  const color = statusColor[overallNorm] || '#9ca3af';

  // Bug #13 fix: shared label map — 'other' is 'Other Document' in both panels
  const typeLabel = {
    id_document: 'SA ID / Passport', proof_of_address: 'Proof of Address',
    proof_of_bank: 'Proof of Bank Account',
    selfie: 'Selfie / Liveness', tax_certificate: 'Tax Certificate', other: 'Other Document',
  };

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid rgba(0,0,0,0.07);margin-bottom:12px">
      <div style="width:40px;height:40px;border-radius:50%;background:${color}22;display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <i class="fa-solid fa-${overallNorm === 'approved' || overallNorm === 'verified' ? 'shield-check' : overallNorm === 'rejected' ? 'shield-xmark' : overallNorm === 'not_started' ? 'circle-xmark' : 'clock'}" style="color:${color};font-size:1.1rem"></i>
      </div>
      <div>
        <div style="font-size:0.88rem;font-weight:700;color:#1a1a1a">FICA / KYC Verification</div>
        <div style="font-size:0.78rem;color:#6b7280;margin-top:1px">${Utils.ficaBadge(overallStatus)}</div>
      </div>
    </div>
    ${docs.length ? `
      <div style="display:flex;flex-direction:column;gap:8px">
        ${docs.map(d => `
          <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 10px;background:${d.status === 'rejected' ? 'rgba(239,68,68,0.05)' : 'rgba(0,0,0,0.03)'};border:${d.status === 'rejected' ? '1px solid rgba(239,68,68,0.2)' : '1px solid transparent'};border-radius:8px">
            <i class="fa-solid fa-file-lines" style="color:${d.status === 'rejected' ? '#ef4444' : '#fec24f'};font-size:0.9rem;flex-shrink:0;margin-top:2px"></i>
            <div style="flex:1;min-width:0">
              <div style="font-size:0.82rem;font-weight:600;color:#1a1a1a">${typeLabel[d.doc_type] || _esc(d.doc_type)}</div>
              <div style="font-size:0.72rem;color:#9ca3af">${_esc(d.file_name)} · ${Utils.date(d.created_at)}</div>
              ${d.status === 'rejected' ? `<button class="btn btn--secondary btn--sm" style="margin-top:6px;font-size:0.72rem" onclick="openKycUploadModal('${d.doc_type}')"><i class="fa-solid fa-rotate-right"></i> Replace &amp; Resubmit</button>` : ''}
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
    <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;background:${overallStatus === 'approved' ? 'rgba(34,197,94,0.08)' : 'rgba(254,194,79,0.07)'};margin-bottom:14px">
      <i class="fa-solid fa-${overallStatus === 'approved' ? 'circle-check' : 'circle-info'}" style="color:${overallStatus === 'approved' ? '#22c55e' : '#fec24f'};font-size:1rem"></i>
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
            ${docs.map(d => `<tr${d.status === 'rejected' ? ' style="background:rgba(239,68,68,0.03)"' : ''}>
              <td class="td-strong">${typeLabel[d.doc_type] || _esc(d.doc_type)}</td>
              <td class="td-muted" style="font-size:0.78rem">${_esc(d.file_name)}</td>
              <td class="td-muted">${Utils.date(d.created_at)}</td>
              <td>${Utils.statusBadge(d.status)}</td>
              <td class="td-muted" style="font-size:0.72rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(d.notes)}</td>
              <td style="white-space:nowrap">${
                d.status === 'rejected'
                  ? `<button class="btn btn--secondary btn--sm" onclick="openKycUploadModal('${d.doc_type}')"><i class="fa-solid fa-rotate-right"></i> Resubmit</button>`
                  : d.file_url
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
      <button id="_kycDownBtn" style="background:#fec24f;color:#000;border:none;border-radius:6px;padding:6px 14px;font-size:0.8rem;font-weight:600;cursor:pointer">Download</button>
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
      <button id="_kycDlOnly" style="background:#fec24f;color:#000;border:none;border-radius:6px;padding:8px 20px;font-size:0.85rem;font-weight:600;cursor:pointer">Download File</button>
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
  const walletBal = parseFloat(inv?.wallet_balance) || 0;

  const amtEl = document.getElementById('previewAmount');
  const toEl  = document.getElementById('previewTo');
  const msgEl = document.getElementById('previewMessage');
  if (amtEl) amtEl.textContent = amt > 0 ? Utils.rand(amt) : 'R—';
  if (toEl)  toEl.textContent  = `To: ${to}`;
  if (msgEl) msgEl.textContent = msg ? `"${msg}"` : '';
  if (document.getElementById('previewFrom') && inv) {
    document.getElementById('previewFrom').textContent = `From: ${inv.first_name} ${inv.last_name}`;
  }

  // Inline balance check
  const balHint = document.getElementById('giftBalanceHint');
  const sendBtn = document.getElementById('giftSendBtn');
  const overBudget = amt > 0 && walletBal > 0 && amt > walletBal;
  if (balHint) {
    if (overBudget) {
      balHint.innerHTML = `<span style="color:#ef4444"><i class="fa-solid fa-circle-exclamation"></i> Amount exceeds your wallet balance of ${Utils.rand(walletBal)}</span>`;
    } else {
      balHint.textContent = `Your wallet balance: ${Utils.rand(walletBal)}`;
    }
  }
  if (sendBtn) sendBtn.disabled = overBudget;
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
        statusEl.style.color = '#fec24f';
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

  const statusColors = { pending:'#fec24f', claimed:'#22c55e', expired:'#6b7280', cancelled:'#ef4444' };
  const statusLabels = { pending:'Pending — awaiting claim', claimed:'Claimed', expired:'Expired', cancelled:'Cancelled' };

  listEl.innerHTML = data.map(g => {
    const iconBg = isSent ? 'rgba(254,194,79,0.12)' : 'rgba(34,197,94,0.12)';
    const iconColor = isSent ? '#fec24f' : '#22c55e';
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
  const colours = ['#fec24f','#ff5229','#fec24f','#22c55e','#eda5ff'];
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

function loadDocuments() {
  if (!PORTAL.investor) { Toast.error('Portfolio data still loading'); return; }
  _renderKycDocsList();
  _renderCertificatesTable();
  _renderReceiptsTable();
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
      <div style="color:#fec24f;font-size:13px;font-weight:700;margin-top:4px">SV CAPITAL</div>
    </div>
    <div style="border:2px solid #fec24f;border-radius:8px;padding:24px;margin-bottom:20px">
      <table style="width:100%;font-size:13px;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#6b7280;width:45%">Certificate Number</td><td style="font-weight:700;color:#1a1a1a">${certNo}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Investor Name</td><td style="font-weight:700">${_esc(investor.first_name)} ${_esc(investor.last_name)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Investor ID</td><td style="font-weight:700">${investor.id}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Investment Pool</td><td style="font-weight:700">${inv.pool_name||pool.name||'—'}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Amount Invested</td><td style="font-weight:700;color:#fec24f;font-size:16px">${Utils.rand(inv.amount)}</td></tr>
        ${(() => {
          // "Annual Rate" is the contracted figure. Once a return is posted it
          // is no longer what this row is showing, so the label follows it.
          const _b = Utils.rateBasis({ ...inv, pool_actual_rate: inv.pool_actual_rate ?? pool.actual_rate });
          // Only a posted rate is stated. The contracted benchmark belongs on
          // the pool listing, not on a certificate of what is held.
          return _b && _b.posted
            ? `<tr><td style="padding:6px 0;color:#6b7280">Return Achieved</td><td style="font-weight:700">${Utils.pct(_b.rate)}</td></tr>`
            : '';
        })()}
        ${(() => {
          // A certificate states facts. Only a posted return goes on it.
          const _p = Utils.postedReturn({ ...inv, pool_actual_rate: inv.pool_actual_rate ?? pool.actual_rate });
          return _p ? `<tr><td style="padding:6px 0;color:#6b7280">Return Posted</td><td style="font-weight:700;color:#22c55e">${Utils.rand(_p.amount)}</td></tr>` : '';
        })()}
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

async function _preloadLogo() {
  try {
    const toDataUrl = async (url) => {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    };
    _cachedLogoDataUrl        = await toDataUrl(new URL('../assets/logo.png',         window.location.href).href);
    _cachedLogoOutlineDataUrl = await toDataUrl(new URL('../assets/logo-outline.png', window.location.href).href);
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

/* ── PDF: watermark (centred logo outline at low opacity) ── */
function _pdfWatermark(doc) {
  if (!_cachedLogoOutlineDataUrl) return;
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const size = 100; // mm
  doc.saveGraphicsState?.();
  // jsPDF doesn't support native opacity for images; draw at reduced opacity via GState if available
  try { doc.setGState(new doc.GState({ opacity: 0.05 })); } catch (_) {}
  doc.addImage(_cachedLogoOutlineDataUrl, 'PNG', (W - size) / 2, (H - size) / 2, size, size);
  try { doc.setGState(new doc.GState({ opacity: 1 })); } catch (_) {}
  doc.restoreGraphicsState?.();
}

/* ── PDF: dark header bar ── */
function _pdfHeader(doc, title, subtitle) {
  const W = doc.internal.pageSize.getWidth();
  // Dark header band
  doc.setFillColor(48, 48, 48); // #303030
  doc.rect(0, 0, W, 38, 'F');
  // Gold accent line
  doc.setFillColor(255, 155, 12);
  doc.rect(0, 38, W, 3, 'F');
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
  doc.text('SV Capital (Pty) Ltd', textX, 24);
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
  _pdfWatermark(doc);

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
  doc.roundedRect(leftX + 4, y, (W - 28) / 2 - 6, 62, 2, 2, 'F');
  doc.roundedRect(rightX, y, (W - 28) / 2 - 6, 62, 2, 2, 'F');

  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(107, 114, 128);
  doc.text('INVESTOR DETAILS', leftX + 8, y + 8);
  doc.text('INVESTMENT DETAILS', rightX + 4, y + 8);

  let ly = y + 16;
  let ry = y + 16;

  /* Values are wrapped to the width left inside their own panel. doc.text()
     takes a point, not a box, and draws straight past the edge of the page if
     the string is long enough — which a migrated investment id
     ("INV-MIGR-" plus a 20-character key) comfortably is. It ran over the
     panel, over the certificate border and off the sheet.

     The panel's right edge is derived from the same expressions that drew it,
     so the two cannot drift apart. */
  const PANEL_W    = (W - 28) / 2 - 6;
  const leftValMax  = (leftX + 4 + PANEL_W) - valLeft  - 5;
  const rightValMax = (rightX + PANEL_W)    - valRight - 5;
  const LINE = 4.2;

  const infoAt = (lbl, val, lblX, valX, maxW, atY) => {
    doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(107, 114, 128);
    doc.text(lbl, lblX, atY);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(26, 26, 26);
    const lines = doc.splitTextToSize(String(val || '—'), maxW);
    doc.text(lines, valX, atY);
    return Math.max(7, lines.length * LINE + 2.8);
  };
  const infoL = (lbl, val) => { ly += infoAt(lbl, val, leftX + 8,  valLeft,  leftValMax,  ly); };
  const infoR = (lbl, val) => { ry += infoAt(lbl, val, rightX + 4, valRight, rightValMax, ry); };

  infoL('Investor Name', `${investor.first_name} ${investor.last_name}`);
  infoL('Investor ID', investor.id);
  infoL('Email', investor.email || '—');
  const _ficaPdfLabels = { approved:'KYC VERIFIED', verified:'KYC VERIFIED', rejected:'REJECTED', Declined:'REJECTED', not_started:'NO FICA UPLOADED', Unverified:'NO FICA UPLOADED', submitted:'PENDING REVIEW', in_progress:'PENDING REVIEW', pending:'PENDING REVIEW', Pending:'PENDING REVIEW', Outstanding:'PENDING REVIEW', Approved:'KYC VERIFIED' };
  infoL('FICA Status', _ficaPdfLabels[investor.fica_status] || _ficaPdfLabels[_normFicaStatus(investor.fica_status)] || 'PENDING REVIEW');

  infoR('Investment ID', inv.id);
  infoR('Pool Name', inv.pool_name || pool.name || '—');
  infoR('Amount Invested', Utils.rand(inv.amount));

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
  doc.text('This certificate is a record of investment and does not constitute a guarantee of returns. All investments are subject to the terms and conditions of SV Capital.', leftX + 4, y, { maxWidth: W - 36 });
  y += 8;
  doc.setFontSize(6.5);
  doc.text('IMPORTANT NOTICE: This investment is not a regulated financial product under the Financial Sector Conduct Authority (FSCA) and is not covered by the Financial Advisory and Intermediary Services Act (FAIS) or the Collective Investment Schemes Control Act (CISCA). This investment is managed solely by SV Capital (Pty) Ltd. Investors should be aware that their capital is at risk and there is no guarantee of returns. Past performance is not indicative of future results.', leftX + 4, y, { maxWidth: W - 36 });

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

/* downloadSaStatement() — sub-account statement (matches main investor statement structure) */
function downloadSaStatement(saId, saName) {
  const sa           = (PORTAL.subAccounts || []).find(a => a.id === saId) || { id: saId, name: saName, wallet_balance: 0 };
  const investments  = (PORTAL.investments  || []).filter(i => i.sub_account_id === saId);
  const transactions = (PORTAL.transactions || []).filter(t => t.sub_account_id === saId);
  const investor     = PORTAL.investor || {};

  /* Same arithmetic as the main statement, over this sub-account's rows only.
     It used to count every transaction whose status was not 'cancelled' — so a
     PENDING or REJECTED deposit was reported to the client as money in the
     account. Over a whole account life, so the range is deliberately open. */
  const _saF = computeStatementFigures({
    investor: { wallet_balance: sa.wallet_balance },
    transactions, investments,
    from: new Date(0), to: new Date(8640000000000000),
    complete: true,
  });

  const walletBal     = _saF.walletNow;
  const activeInvAmt  = _saF.activeInvAmt;
  const totalValue    = _saF.portfolioValueToday;
  const totalDeposits = _saF.deposits;
  const totalReturns  = _saF.returns;
  const totalInvested = totalDeposits;
  const activeInv     = _saF.activeInvCount;

  const now           = new Date();
  const generatedAt   = now.toLocaleString('en-ZA', { dateStyle: 'long', timeStyle: 'short' });
  /* Stable, not random: the same sub-account statement must carry the same
     reference every time it is produced. */
  const statementNumber = statementNumber_sa(sa.id);
  const logoUrl       = `${window.location.origin}/assets/sv-capital-logo-horizontal-outline-1.png`;
  const logoOutlineUrl = new URL('../assets/logo-outline.png', window.location.href).href;
  const saType        = sa.type ? sa.type.charAt(0).toUpperCase() + sa.type.slice(1) : 'Sub-Account';
  const parentName    = `${investor.first_name || ''} ${investor.last_name || ''}`.trim() || 'Parent Investor';

  // ─── PORTFOLIO SUMMARY ───
  const summarySection = `
    <section style="margin-bottom:36px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #fec24f">
        <div style="width:4px;height:22px;background:linear-gradient(180deg,#fec24f,#FF5229);border-radius:2px"></div>
        <h3 style="font-size:13px;font-weight:800;color:#1a1a1a;letter-spacing:0.06em;text-transform:uppercase;margin:0">Portfolio Summary</h3>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px">
        ${stmtKPIBox('Total Portfolio Value', fmtNum(totalValue), '#fec24f')}
        ${stmtKPIBox('Deposits', fmtNum(totalDeposits), '#656565')}
        ${stmtKPIBox('Returns Earned', fmtNum(totalReturns), '#22C55E')}
        ${stmtKPIBox('Wallet Balance', fmtNum(walletBal), '#0096ff')}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div style="background:#F7F8FA;border-radius:8px;padding:14px;border:1px solid rgba(0,0,0,0.06)">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#9ca3af;font-weight:700;margin-bottom:10px">Account Details</div>
          ${stmtInfoRow('Account Name', _esc(sa.name))}
          ${stmtInfoRow('Account ID', sa.id)}
          ${stmtInfoRow('Account Type', saType)}
          ${stmtInfoRow('Parent Investor', parentName)}
          ${stmtInfoRow('Investor ID', investor.id || '—')}
          ${stmtInfoRow('Email', investor.email || '—')}
        </div>
        <div style="background:#F7F8FA;border-radius:8px;padding:14px;border:1px solid rgba(0,0,0,0.06)">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#9ca3af;font-weight:700;margin-bottom:10px">Investment Snapshot</div>
          ${stmtInfoRow('Total Investments', investments.length)}
          ${stmtInfoRow('Active Investments', activeInv)}
          ${stmtInfoRow('Matured', investments.filter(i => ['matured', 'paid_out'].includes(i.status)).length)}
          ${stmtInfoRow('Total Transactions', transactions.length)}
          ${stmtInfoRow('Total Deposits', fmtNum(transactions.filter(t => t.type === 'deposit').reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0)))}
          ${stmtInfoRow('Fees Charged', fmtNum(transactions.filter(t => t.type === 'fee').reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0)))}
        </div>
      </div>
    </section>`;

  // ─── PERFORMANCE ANALYSIS ───
  let performanceSection = '';
  if (investments.length > 0) {
    const byProduct = {};
    investments.forEach(inv => {
      const p = (inv.product_type === 'smme' ? 'short_term' : inv.product_type) || 'unknown';
      if (!byProduct[p]) byProduct[p] = { count: 0, capital: 0, returns: 0 };
      byProduct[p].count++;
      if (!inv.is_reinvestment) byProduct[p].capital += Number(inv.amount) || 0;
      byProduct[p].returns += Utils.investmentReturn(inv);
    });
    const perfRows = Object.entries(byProduct).map(([prod, d]) => {
      const pct  = d.capital > 0 ? ((d.returns / d.capital) * 100).toFixed(2) : '0.00';
      const info = getProductInfo(prod);
      return `<tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:8px 10px;font-size:11px;font-weight:700;color:#1a1a1a">${info.label}</td>
        <td style="padding:8px 10px;font-size:11px;color:#6b7280;text-align:center">${d.count}</td>
        <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;text-align:right;font-weight:600">${fmtNum(d.capital)}</td>
        <td style="padding:8px 10px;font-size:11px;color:#22C55E;text-align:right;font-weight:700">${fmtNum(d.returns)}</td>
        <td style="padding:8px 10px;font-size:11px;color:#fec24f;text-align:right;font-weight:700">${pct}%</td>
      </tr>`;
    }).join('');
    performanceSection = `
      <section style="margin-bottom:36px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #656565">
          <div style="width:4px;height:22px;background:#656565;border-radius:2px"></div>
          <h3 style="font-size:13px;font-weight:800;color:#1a1a1a;letter-spacing:0.06em;text-transform:uppercase;margin:0">Performance Analysis</h3>
        </div>
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eaeaea">
          <thead><tr style="background:#F7F8FA">
            <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Product</th>
            <th style="padding:9px 10px;font-size:10px;text-align:center;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Count</th>
            <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Capital</th>
            <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Returns</th>
            <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Return %</th>
          </tr></thead>
          <tbody>${perfRows}</tbody>
          <tfoot><tr style="background:#F7F8FA">
            <td colspan="2" style="padding:9px 10px;font-size:11px;font-weight:800;color:#1a1a1a">TOTAL</td>
            <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#1a1a1a;text-align:right">${fmtNum(totalInvested)}</td>
            <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#22C55E;text-align:right">${fmtNum(totalReturns)}</td>
            <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#fec24f;text-align:right">${totalInvested > 0 ? ((totalReturns / totalInvested) * 100).toFixed(2) : 0}%</td>
          </tr></tfoot>
        </table>
      </section>`;
  }

  // ─── INVESTMENT DETAILS ───
  let investmentSection = '';
  if (investments.length > 0) {
    /* Newest first. This table mixes active and matured holdings, so it is
       ordered by the date each one began — the one date every row has. */
    const _saMs = v => { const d = new Date(v); return isNaN(d.getTime()) ? null : d.getTime(); };
    const _saStart = i => _saMs(i.start_date) ?? _saMs(i.created_at);
    const invSorted = investments.slice().sort((a, b) => {
      const x = _saStart(a), y = _saStart(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return y - x;
    });
    const invRows = invSorted.map(inv => {
      const info       = getProductInfo(inv.product_type);
      const poolRate2  = (Number(inv.pool_actual_rate) || 0) * 100;
      const rateCell   = poolRate2 > 0 ? `${poolRate2.toFixed(2)}%` : '—';
      const statusColor = inv.status === 'active' ? '#656565' : inv.status === 'paid_out' ? '#22C55E' : '#9ca3af';
      return `<tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:8px 10px;font-size:10px;color:#9ca3af;font-family:monospace">${inv.id}</td>
        <td style="padding:8px 10px;font-size:11px;font-weight:600;color:#1a1a1a">${_esc(inv.pool_name) || '—'}</td>
        <td style="padding:8px 10px"><span style="background:${info.bg};color:${info.color};font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase;letter-spacing:0.05em">${info.label}</span></td>
        <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;text-align:right;font-weight:700">${fmtNum(inv.amount)}</td>
        <td style="padding:8px 10px;font-size:11px;color:${rateCell === '—' ? '#9ca3af' : '#fec24f'};text-align:right;font-weight:700">${rateCell}</td>
        <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;text-align:right">${fmtDate(inv.investment_date)}</td>
        <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;text-align:right">${inv.maturity_date ? fmtDate(inv.maturity_date) : '—'}</td>
        <td style="padding:8px 10px"><span style="color:${statusColor};font-size:10px;font-weight:700;text-transform:uppercase">${inv.status}</span></td>
      </tr>`;
    }).join('');
    investmentSection = `
      <section style="margin-bottom:36px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #22C55E">
          <div style="width:4px;height:22px;background:linear-gradient(180deg,#22C55E,#16A34A);border-radius:2px"></div>
          <h3 style="font-size:13px;font-weight:800;color:#1a1a1a;letter-spacing:0.06em;text-transform:uppercase;margin:0">Investment Details</h3>
          <span style="margin-left:auto;font-size:10px;color:#9ca3af">${investments.length} records</span>
        </div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eaeaea;min-width:700px">
            <thead><tr style="background:#F7F8FA">
              <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">ID</th>
              <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Pool</th>
              <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Product</th>
              <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Amount</th>
              <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Actual Rate</th>
              <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Invested</th>
              <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Maturity</th>
              <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Status</th>
            </tr></thead>
            <tbody>${invRows}</tbody>
          </table>
        </div>
      </section>`;
  }

  // ─── TRANSACTION LEDGER ───
  const typeMap = { deposit: 'Deposit', withdrawal: 'Withdrawal', investment: 'Investment', return: 'Return', payout: 'Payout', fee: 'Fee', referral_bonus: 'Referral Bonus', gift_sent: 'Gift Sent', gift_received: 'Gift Received', reward: 'XP Reward', transfer_in: 'Transfer In', transfer_out: 'Transfer Out' };
  const sortedTxns = [...transactions].sort((a, b) => new Date(b.transaction_date || b.created_at) - new Date(a.transaction_date || a.created_at));
  const txnRows = sortedTxns.length > 0 ? sortedTxns.map(t => {
    const isPos    = !['withdrawal', 'fee', 'investment', 'gift_sent', 'transfer_out'].includes(t.type);
    const amt      = isPos ? `+${fmtNum(Math.abs(t.amount))}` : `-${fmtNum(Math.abs(t.amount))}`;
    const amtColor = isPos ? '#22C55E' : '#EF4444';
    return `<tr style="border-bottom:1px solid #f0f0f0">
      <td style="padding:7px 10px;font-size:10px;color:#9ca3af;font-family:monospace">${t.reference || '—'}</td>
      <td style="padding:7px 10px;font-size:11px;color:#1a1a1a">${typeMap[t.type] || t.type}</td>
      <td style="padding:7px 10px;font-size:11px;color:#1a1a1a">${t.description || '—'}</td>
      <td style="padding:7px 10px;font-size:11px;font-weight:700;color:${amtColor};text-align:right">${amt}</td>
      <td style="padding:7px 10px;font-size:11px;color:#9ca3af;text-align:right">${fmtDate(t.transaction_date || t.created_at)}</td>
      <td style="padding:7px 10px">
        <span style="background:${t.status === 'completed' ? '#dcfce7' : '#fef9c3'};color:${t.status === 'completed' ? '#16a34a' : '#92400e'};font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase">${t.status || '—'}</span>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" style="padding:20px;text-align:center;color:#9ca3af;font-size:11px">No transactions found for this account</td></tr>`;

  const totalTransferIn  = transactions.filter(t => t.type === 'transfer_in').reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
  const totalFees        = transactions.filter(t => t.type === 'fee').reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);

  const ledgerSection = `
    <section style="margin-bottom:36px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #eda5ff">
        <div style="width:4px;height:22px;background:#eda5ff;border-radius:2px"></div>
        <h3 style="font-size:13px;font-weight:800;color:#1a1a1a;letter-spacing:0.06em;text-transform:uppercase;margin:0">Transaction Ledger</h3>
        <span style="margin-left:auto;font-size:10px;color:#9ca3af">${transactions.length} transactions · all time</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">
        ${stmtMiniBox('Total Deposits', fmtNum(totalDeposits + totalTransferIn), '#22C55E')}
        ${stmtMiniBox('Total Invested', fmtNum(totalInvested), '#656565')}
        ${stmtMiniBox('Fees Charged', fmtNum(totalFees), '#EF4444')}
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eaeaea;min-width:600px">
          <thead><tr style="background:#F7F8FA">
            <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Reference</th>
            <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Type</th>
            <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Description</th>
            <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Amount</th>
            <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Date</th>
            <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Status</th>
          </tr></thead>
          <tbody>${txnRows}</tbody>
        </table>
      </div>
    </section>`;

  // ─── FULL DOCUMENT ───
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SV Capital — Sub-Account Statement · ${_esc(sa.name)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Poppins',-apple-system,BlinkMacSystemFont,sans-serif;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;color:#1a1a1a}
    @page{size:A4;margin:0}
    @media print{.no-print{display:none!important}.print-body{padding-top:0!important}}
    .no-print{position:fixed;top:0;left:0;right:0;background:#1a1a1a;padding:12px 24px;display:flex;justify-content:space-between;align-items:center;z-index:999;box-shadow:0 2px 12px rgba(0,0,0,0.3)}
    .no-print span{color:#fff;font-size:13px;font-weight:600}
    .no-print button{background:linear-gradient(135deg,#fec24f,#FF5229);color:#fff;border:none;padding:8px 22px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer}
    .print-body{padding-top:52px}
  </style>
</head>
<body>
  <div class="no-print">
    <span>SV Capital — Sub-Account Statement · ${_esc(sa.name)}</span>
    <button onclick="window.print()">⬇&nbsp; Save as PDF / Print</button>
  </div>
  <div class="print-body">
    <div style="font-family:'Poppins',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;background:#fff;min-height:100%;position:relative">
      <div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:0;opacity:0.04;width:480px;height:480px;background:url('${logoOutlineUrl}') center/contain no-repeat;print-color-adjust:exact;-webkit-print-color-adjust:exact"></div>
      <div style="background:#303030;padding:24px 40px;display:flex;align-items:center;justify-content:space-between;position:relative;z-index:1">
        <div style="background:#fff;padding:8px 14px;border-radius:8px;display:inline-block"><img src="${logoUrl}" alt="SV Capital" style="height:40px;width:auto;max-width:220px;object-fit:contain;display:block"></div>
        <div style="text-align:right">
          <div style="font-size:16px;font-weight:800;color:#fec24f;letter-spacing:0.04em">SUB-ACCOUNT STATEMENT</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.55);margin-top:4px"># ${statementNumber}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.55);margin-top:2px">Generated: ${generatedAt}</div>
        </div>
      </div>
      <div style="background:linear-gradient(90deg,rgba(254,194,79,0.08),rgba(47,140,155,0.06));border-top:3px solid #fec24f;border-bottom:1px solid rgba(0,0,0,0.06);padding:12px 40px;display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em">Account:</span>
          <span style="font-size:12px;font-weight:800;color:#1a1a1a">${_esc(sa.name)}</span>
          <span style="background:rgba(237,165,255,0.12);color:#c070d8;font-size:9px;font-weight:700;padding:2px 8px;border-radius:20px;border:1px solid rgba(237,165,255,0.25);margin-left:4px">${saType}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em">Investor:</span>
          <span style="font-size:12px;font-weight:800;color:#1a1a1a">${parentName}</span>
          <span style="background:rgba(254,194,79,0.1);color:#ff5229;font-size:9px;font-weight:700;padding:2px 8px;border-radius:20px;border:1px solid rgba(254,194,79,0.2);margin-left:4px">${investor.id || ''}</span>
        </div>
      </div>
      <div style="padding:32px 40px">
        ${summarySection}
        ${performanceSection}
        ${investmentSection}
        ${ledgerSection}
      </div>
      <div style="background:#F7F8FA;border-top:3px solid #fec24f;padding:20px 40px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">
          <div>
            <div style="font-size:10px;font-weight:700;color:#1a1a1a;margin-bottom:3px">SV Capital (Pty) Ltd</div>
            <div style="font-size:9px;color:#9ca3af">enquiry@svcapital.co.za · www.svcapital.co.za</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:9px;color:#c1c7d0">This statement is computer generated and does not require a signature.</div>
          </div>
        </div>
        <div style="font-size:7.5px;color:#b0b8c4;border-top:1px solid rgba(0,0,0,0.06);padding-top:8px;line-height:1.5">
          IMPORTANT NOTICE: This investment is not a regulated financial product under the Financial Sector Conduct Authority (FSCA) and is not covered by the Financial Advisory and Intermediary Services Act (FAIS) or the Collective Investment Schemes Control Act (CISCA). This investment is managed solely by SV Capital (Pty) Ltd. Capital is at risk and returns are not guaranteed.
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

  const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, '_blank');
  if (!win) {
    const a = document.createElement('a');
    a.href = url;
    a.download = `SVC-Statement-${(saName || 'Account').replace(/[^a-zA-Z0-9_-]/g, '-')}-${now.toISOString().slice(0, 10)}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    Toast.success('Statement downloaded — open in a browser to save as PDF.');
  }
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

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

async function _loadStatementArchive() {
  const el = document.getElementById('statementArchiveBody');
  if (!el) return;
  try {
    const data = await API._fetch('GET', 'statements');
    const currentYear = new Date().getFullYear();
    const taxYear = new Date().getMonth() >= 2 ? currentYear : currentYear - 1; // Feb cutoff
    const taxSection = `
      <div style="margin-bottom:14px;padding:12px;background:rgba(254,194,79,0.06);border-radius:8px;border:1px solid rgba(254,194,79,0.2)">
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
        const ret = Utils.earnedReturns([inv]);
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

function updateRecurringToggleStyle() {
  const toggle = document.getElementById('recurringEnabledToggle');
  const slider = document.getElementById('recurringToggleSlider');
  if (!slider) return;
  const on = !!(toggle && toggle.checked);
  slider.style.background = on ? '#fec24f' : '#ccc';
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
  if (amtEl && inv?.recurring_amount) amtEl.value = inv.recurring_amount;
  if (daySel && inv?.recurring_day)   daySel.value = inv.recurring_day;

  // Populate product types from pools that currently have an open pool
  if (prodSel) {
    const openProductTypes = [...new Set(
      (PORTAL.pools || [])
        .filter(p => p.status === 'open' && !_poolPastClose(p))
        .map(p => p.product_type)
        .filter(Boolean)
    )];
    prodSel.innerHTML = '<option value="">Select a product…</option>' +
      openProductTypes.map(pt => `<option value="${pt}">${Utils.productInfo(pt).label || pt}</option>`).join('');
    if (inv?.recurring_product_type) prodSel.value = inv.recurring_product_type;
  }

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
    if (!day || day < 1 || day > 31) { Toast.error('Please select a valid day (1–31)'); return; }

    // Validate against the open pool's minimum investment
    const openPool = (PORTAL.pools || []).find(p => p.status === 'open' && !_poolPastClose(p) && p.product_type === productType);
    if (openPool) {
      const minInvest = parseFloat(openPool.min_investment) || 0;
      if (amount < minInvest) {
        Toast.error(`Minimum investment for this product is ${Utils.rand(minInvest)}`);
        return;
      }
      const platformFee = Math.round(amount * 0.01 * 100) / 100;
      const totalRequired = amount + platformFee;
      const walletBal = parseFloat(PORTAL.investor?.wallet_balance) || 0;
      if (walletBal < totalRequired) {
        Toast.warn(`Note: your wallet (${Utils.rand(walletBal)}) will need at least ${Utils.rand(totalRequired)} on the chosen day (${Utils.rand(amount)} + ${Utils.rand(platformFee)} platform fee).`);
      }
    }
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

    const PRODUCT_LABELS = { cattle:'Cattle Finance', solar_7yr:'Solar 7yr', solar_6yr:'Solar 6yr', solar_5yr:'Solar 5yr', short_term:'Short Term', smme:'Short Term', delivery_bike:'Delivery Bike', other:'Other' };
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

  const PRODUCT_LABELS = { cattle:'Cattle Finance', solar_7yr:'Solar 7yr', solar_6yr:'Solar 6yr', solar_5yr:'Solar 5yr', short_term:'Short Term', smme:'Short Term', delivery_bike:'Delivery Bike', other:'Other' };
  if (inv && inv.recurring_enabled && inv.recurring_amount && inv.recurring_product_type) {
    const day    = inv.recurring_day || 1;
    const suffix = day === 1 ? 'st' : day === 2 ? 'nd' : day === 3 ? 'rd' : 'th';
    summaryEl.style.display = '';
    summaryEl.innerHTML = `<i class="fa-solid fa-check-circle" style="color:#22c55e"></i> <strong>Active:</strong> ${Utils.rand(inv.recurring_amount)}/month into ${PRODUCT_LABELS[inv.recurring_product_type] || inv.recurring_product_type} on the ${day}${suffix}`;
  } else {
    summaryEl.style.display = 'none';
  }
}

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
    slider.style.background = enabled ? '#fec24f' : '#ccc';
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
      if (slider) slider.style.background = '#fec24f';
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
      if (slider) slider.style.background = '#fec24f';
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

function _dismissIosBanner() {
  const el = document.getElementById('iosPwaBanner');
  if (el) el.style.display = 'none';
  localStorage.setItem('ios_pwa_dismissed', '1');
}

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
        const actual = isNaN(start) || isNaN(end) ? 0 : Math.max(0, (end - start) / 86400000);
        const expected = (parseFloat(i.term_months) || 0) * 30;
        return s + Math.max(actual, expected, 30);
      }, 0) / done.length
    : 0;
  // Weighted-average annual rate across all investments (contracted rate × amount)
  const totalAmt = all.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  // effectiveRate, not annual_rate: a pool-level posted return leaves the
  // investment's own rate at "0.0000" (truthy), which zeroed its contribution
  // and dragged the whole weighted average down.
  const weightedRate = totalAmt > 0
    ? all.reduce((s, i) => s + (Utils.effectiveRate(i) || 0) * (parseFloat(i.amount) || 0), 0) / totalAmt
    : 0;
  const irr = weightedRate > 0 ? weightedRate
    : (moic > 0 && avgDays > 0 ? (Math.pow(moic, 365 / avgDays) - 1) : 0);

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
  set('an-irr',     irr > 0 ? Math.min(irr * 100, 9999).toFixed(2) + '% p.a.' : '—');
  set('an-best',    bestPool !== '—' ? bestPool : (all.length ? (all[0].pool_name || '—') : '—'));
  set('an-avgdays', avgDays > 0 ? Math.round(avgDays) + ' d' : '—');
}

function _renderMonthlyReturnsChart() {
  const ctx = document.getElementById('analyticsMonthlyChart');
  if (!ctx) return;

  /* Completed only. A pending or rejected return charted as earned tells the
     client they made money they have not been paid. */
  /* Income only. Including `payout` charted the client's returned CAPITAL as
     a return, so the month a holding matured showed a spike the size of the
     holding itself. See _isIncomeTxn. */
  const txns = PORTAL.transactions.filter(t => _isIncomeTxn(t) && _stmtCounts(t));

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
        backgroundColor: 'rgba(254,194,79,0.75)',
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
    if (!byPool[name]) byPool[name] = { amount: 0, product_type: i.product_type || 'other' };
    byPool[name].amount += parseFloat(i.amount) || 0;
  });
  const entries = Object.entries(byPool).sort((a, b) => b[1].amount - a[1].amount);
  const total   = entries.reduce((s, [, v]) => s + v.amount, 0);
  const colors  = entries.map(([, v]) => Utils.productColor(v.product_type));

  if (PORTAL.charts.analyticsAlloc) { PORTAL.charts.analyticsAlloc.destroy(); }
  PORTAL.charts.analyticsAlloc = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(([n]) => n),
      datasets: [{ data: entries.map(([, v]) => v.amount), backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }],
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
        <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${colors[i]};flex-shrink:0"></span>
        <span style="font-size:0.78rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-body)">${_esc(name)}</span>
        <span style="font-size:0.78rem;font-weight:700;color:var(--text-body)">${total > 0 ? ((val.amount/total)*100).toFixed(1) : 0}%</span>
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
    const map = { active:'#22c55e', paid_out:'#656565', matured:'#eda5ff', cancelled:'#ef4444', pending:'#f97316', open:'#22c55e', closed:'#656565' };
    return map[s] || '#9ca3af';
  };
  const fmt = v => v ? new Date(v).toLocaleDateString('en-ZA', { day:'numeric', month:'short', year:'numeric' }) : '—';
  tbody.innerHTML = invs.slice(0, 30).map(i => {
    const pool    = (PORTAL.pools || []).find(p => p.id === i.pool_id) || {};
    const capital = parseFloat(i.amount) || 0;
    const startVal = pool.start_date || i.start_date || i.created_at;
    const endVal   = pool.end_date   || i.end_date   || i.maturity_date;
    const start   = new Date(startVal);
    const end     = new Date(endVal);
    const days    = (!isNaN(start) && !isNaN(end)) ? Math.max(0, Math.round((end - start) / 86400000)) : (i.term_days || '—');
    const status  = (pool.status === 'matured' || pool.status === 'paid_out') ? 'matured' : (i.status || pool.status);
    const sc      = statusMeta(status);
    // Returns are posted while a pool is still running, not only once it
    // matures — gating this on isMatured hid a real, posted figure behind the
    // target rate on every active investment.
    const _num        = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
    const actualRate  = _num(i.pool_actual_rate) || _num(pool.actual_rate);
    const targetRate  = _num(pool.annual_rate) || _num(i.annual_rate) || _num(i.expected_return_rate);
    const posted      = actualRate > 0;
    const rateVal     = posted ? actualRate : targetRate;
    const rateLbl     = posted ? 'Return Achieved' : 'Target Return';
    return `
      <div class="atl-card">
        <div class="atl-card__head">
          <div class="atl-card__name">${_esc(pool.name || i.pool_name || 'Pool')}</div>
          <span class="atl-card__status" style="background:${sc}1f;color:${sc};border:1px solid ${sc}44">${String(status||'').replace('_',' ').toUpperCase()}</span>
        </div>
        <div class="atl-card__figures">
          <div><span class="atl-card__k">Invested</span><span class="atl-card__v">R ${capital.toLocaleString('en-ZA')}</span></div>
          <div><span class="atl-card__k">${rateLbl}</span><span class="atl-card__v" style="color:${posted ? '#eda5ff' : '#16a34a'}">${Utils.pct(rateVal)}</span></div>
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
  const rows = [['Pool', 'Invested (R)', 'Return (% p.a.)', 'Rate Basis', 'Start', 'End', 'Days', 'Status']];
  PORTAL.investments.forEach(i => {
    const pool = (PORTAL.pools || []).find(p => p.id === i.pool_id) || {};
    const fmt = v => v ? new Date(v).toLocaleDateString('en-ZA') : '';
    const startVal = pool.start_date || i.start_date || i.created_at;
    const endVal   = pool.end_date   || i.end_date   || i.maturity_date;
    const start = new Date(startVal);
    const end   = new Date(endVal);
    const days  = (!isNaN(start) && !isNaN(end)) ? Math.max(0, Math.round((end - start) / 86400000)) : (i.term_days || '');
    const status = (pool.status === 'matured' || pool.status === 'paid_out') ? 'matured' : (i.status || pool.status || '');
    rows.push([
      pool.name || i.pool_name || '', parseFloat(i.amount) || 0,
      ...(() => {
        // Mirror the timeline card beside it: a posted return wins over the
        // target, and the basis is named so the two columns can't be confused.
        const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
        const actual = n(i.pool_actual_rate) || n(pool.actual_rate);
        if (actual > 0) return [Utils.pct(actual), 'Achieved'];
        return [Utils.pct(n(pool.annual_rate) || n(i.annual_rate) || n(i.expected_return_rate)), 'Target'];
      })(),
      fmt(startVal), fmt(endVal), days, status,
    ]);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `SVC-Analytics-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  Toast.success('Analytics exported!');
}

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
        <i class="fa-solid ${_esc(item.icon)}" style="width:16px;text-align:center;color:rgba(254,194,79,0.8);font-size:0.85rem"></i>
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
    el.style.background = +el.dataset.idx === idx ? 'rgba(254,194,79,0.12)' : '';
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
