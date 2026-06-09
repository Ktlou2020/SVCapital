/* ═══════════════════════════════════════════════
   SV CAPITAL — GA4 Analytics Helper
   Measurement ID: G-5LEPWC7EFP
   ═══════════════════════════════════════════════ */

'use strict';

(function () {

  /* ── Platform detection ─── */
  function _platform() {
    if (window.__SVC_NATIVE__) {
      // Native context injects __SVC_NATIVE__ = 'ios' | 'android'
      const p = window.__SVC_NATIVE__;
      if (p === 'ios' || p === 'android') return p;
    }
    return 'web';
  }

  /* ── Amount bucketing ─── */
  function _amtBucket(amount) {
    const n = parseFloat(amount) || 0;
    if (n <= 0)       return '0';
    if (n < 5000)     return '1-5k';
    if (n < 25000)    return '5-25k';
    if (n < 100000)   return '25-100k';
    return '100k+';
  }

  /* ── Safe gtag wrapper ─── */
  function track(event, params) {
    try {
      if (typeof window.gtag !== 'function') return;
      window.gtag('event', event, Object.assign({ platform: _platform() }, params || {}));
    } catch (_) {}
  }

  /* ── Set user properties + user_id ─── */
  // investor: the PORTAL.investor object (or equivalent)
  // Only non-PII fields are sent — no email, name, phone.
  function setUser(investor) {
    try {
      if (typeof window.gtag !== 'function' || !investor) return;

      const userId = investor.id || investor.investor_id || null;
      if (userId) {
        window.gtag('set', 'user_id', String(userId));
      }

      window.gtag('set', 'user_properties', {
        investor_id:     userId ? String(userId) : undefined,
        investor_status: investor.status         || undefined,
        kyc_status:      investor.kyc_status      || investor.fica_status || undefined,
        platform:        _platform(),
      });
    } catch (_) {}
  }

  /* ── Expose globals ─── */
  window.SVC = window.SVC || {};
  window.SVC.track      = track;
  window.SVC.setUser    = setUser;
  window._amtBucket     = _amtBucket;  // expose for use in portal.js

}());
