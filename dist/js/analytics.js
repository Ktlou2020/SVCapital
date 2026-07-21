/* ═══════════════════════════════════════════════
   SV CAPITAL — GA4 Analytics Helper
   Measurement ID: G-5LEPWC7EFP
   ═══════════════════════════════════════════════ */

'use strict';

(function () {

  /* ── Platform detection ─────────────────────── */
  function _platform() {
    if (window.__SVC_NATIVE__) {
      const p = window.__SVC_NATIVE__;
      if (p === 'ios' || p === 'android') return p;
    }
    return 'web';
  }

  /* ── Amount bucketing ───────────────────────── */
  function _amtBucket(amount) {
    const n = parseFloat(amount) || 0;
    if (n <= 0)       return '0';
    if (n < 5000)     return '1-5k';
    if (n < 25000)    return '5-25k';
    if (n < 100000)   return '25-100k';
    return '100k+';
  }

  /* ── Safe gtag wrapper ──────────────────────── */
  function track(event, params) {
    try {
      if (typeof window.gtag !== 'function') return;
      window.gtag('event', event, Object.assign({ platform: _platform() }, params || {}));
    } catch (_) {}
  }

  /* ── Error tracking ─────────────────────────── */
  function trackError(context, message, code) {
    track('svc_error', {
      error_context: context || 'unknown',
      error_message: String(message || '').slice(0, 150),
      error_code:    code  || undefined,
    });
  }

  /* ── Section timing ─────────────────────────── */
  const _timers = {};

  function time(key) {
    _timers[key] = performance.now();
  }

  function timeEnd(key, event, params) {
    const start = _timers[key];
    if (start == null) return;
    const duration_ms = Math.round(performance.now() - start);
    delete _timers[key];
    track(event || 'svc_section_time', Object.assign({ duration_ms }, params || {}));
  }

  /* ── Set user properties + user_id ─────────── */
  // No PII — no email, name, phone number
  function setUser(investor) {
    try {
      if (typeof window.gtag !== 'function' || !investor) return;

      const userId = investor.id || investor.investor_id || null;
      if (userId) window.gtag('set', 'user_id', String(userId));

      const totalInvested = parseFloat(investor.total_invested) || 0;
      const walletBalance = parseFloat(investor.wallet_balance)  || 0;

      // Count active investments if PORTAL is available
      let activeInvestments = 0;
      try {
        if (window.PORTAL && Array.isArray(window.PORTAL.investments)) {
          activeInvestments = window.PORTAL.investments.filter(i => i.status === 'active').length;
        }
      } catch (_) {}

      window.gtag('set', 'user_properties', {
        investor_id:            userId             ? String(userId) : undefined,
        investor_status:        investor.status    || undefined,
        kyc_status:             investor.kyc_status || investor.fica_status || undefined,
        total_invested_bucket:  _amtBucket(totalInvested),
        wallet_bucket:          _amtBucket(walletBalance),
        active_investments:     activeInvestments  || undefined,
        has_recurring:          investor.recurring_enabled ? 'yes' : 'no',
        has_auto_topup:         investor.auto_topup_enabled ? 'yes' : 'no',
        referral_code:          investor.referral_code     || undefined,
        platform:               _platform(),
      });
    } catch (_) {}
  }

  /* ── Expose globals ─────────────────────────── */
  window.SVC          = window.SVC || {};
  window.SVC.track     = track;
  window.SVC.setUser   = setUser;
  window.SVC.error     = trackError;
  window.SVC.time      = time;
  window.SVC.timeEnd   = timeEnd;
  window._amtBucket    = _amtBucket;

}());
