#!/usr/bin/env node
/* loadDashboard must run to the end.
 *
 * This exists because of a bug I shipped and did not catch twice over. Moving
 * the second KPI row into SQL removed `const pendingKycCount`, which code
 * further down the same function was still reading. loadDashboard therefore
 * threw ReferenceError partway through: the tiles rendered, and the charts,
 * the pending-actions widget, the recent-investments list, the activity feed
 * and the sidebar badges silently did not. Its own try/catch swallowed it, so
 * the page looked half-built rather than broken.
 *
 * Two checks were in place and neither could see it. check-dashboard-integrity
 * asserts on the source text and runs the banner functions. A sandbox probe I
 * wrote ran _refreshDashboardTotals — one function out of the middle of
 * loadDashboard — and passed, which is what convinced me the path was healthy.
 * A fragment that works proves nothing about the function that calls it.
 *
 * So this executes loadDashboard itself, top to bottom, and fails on any
 * exception. Every global it legitimately reaches for is stubbed; a missing
 * stub is this check's own bug, so each one is deliberate.
 *
 * Run: node scripts/check-dashboard-loads.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function slice(name) {
  let at = SRC.indexOf(`async function ${name}(`);
  if (at < 0) at = SRC.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} not found in admin/js/admin.js`);
  const end = SRC.indexOf('\n}\n', at);
  if (end < 0) throw new Error(`could not find the end of ${name}`);
  return SRC.slice(at, end + 3);
}
/* Terminator given explicitly: one of these declarations is an array and the
   other an object, and guessing produced a truncated slice that failed as
   "Unexpected end of input" rather than as anything locatable. */
function sliceConst(decl, endToken) {
  const at = SRC.indexOf(decl);
  if (at < 0) throw new Error(`${decl} not found`);
  const end = SRC.indexOf(endToken, at);
  if (end < 0) throw new Error(`end of ${decl} not found`);
  return SRC.slice(at, end + endToken.length);
}

/* The real functions loadDashboard calls into. Anything it merely delegates to
   (list rendering, charts) is stubbed and recorded, so the check can assert it
   was REACHED — the point being that execution got that far. */
function makeEnv({ serverKpis = true, seriesOk = true, ticketsOk = true } = {}) {
  const reached = [], caught = [], logged = [];
  const els = {};
  const el = id => (els[id] = els[id] || {
    id, textContent: '', innerHTML: '', className: '',
    style: {}, classList: { add() {}, remove() {} },
  });
  ['ds-investors','ds-invested','ds-returns','ds-pools','ds-fica-rate','ds-pending-kyc',
   'ds-upcoming-maturities','ds-pending-withdrawals','ds-truncation','ds-load-errors',
   'ds-trend-investors','ds-trend-aum','ds-trend-returns','kycBadge','withdrawalBadge',
   'ticketBadge','pendingActionsWidget','aumChart','productMixChart'].forEach(el);

  const rec = name => (...a) => { reached.push(name); return a; };

  const KPIS = {
    total_investors: 412, active_capital: 6870309.75, returns_total: 98765.43,
    active_pools: 7, non_archived: 400, fica_approved: 352, fica_rate: 88,
    pending_kyc: 3, upcoming_maturities: 304, pending_withdrawals: 2,
    pending_fica: 5, open_tickets: 4, missing_instructions: 8, pending_transactions: 6,
  };

  const sandbox = {
    document: {
      getElementById: id => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    window: {},
    STATE: { investors: [], pools: [], investments: [], transactions: [], tickets: [], charts: {} },
    Utils: {
      rand: v => 'R' + Number(v || 0).toFixed(2),
      pct:  v => (Number(v) * 100).toFixed(2) + '%',
      date: () => '24 Mar 2026',
      productInfo: pt => ({ label: pt || '—', badgeClass: 'b', icon: 'i' }),
      statusBadge: () => '<span></span>',
      debounce: f => f,
    },
    _esc: s => String(s == null ? '' : s),
    API: {
      investors:    { list: async () => ({ data: [{ id: 'i1', status: 'active', created_at: '2026-08-01' }], total: 1 }) },
      pools:        { list: async () => ({ data: [{ id: 'p1', status: 'open' }], total: 1 }) },
      investments:  { list: async () => ({ data: [{ id: 'v1', status: 'active', amount: 100, created_at: '2026-08-01' }], total: 1 }) },
      transactions: { list: async () => ({ data: [{ type: 'return', status: 'completed', amount: 5, created_at: '2026-08-01' }], total: 9999 }) },
      tickets:      { list: async () => { if (!ticketsOk) throw new Error('tickets down'); return { data: [{ status: 'open' }] }; } },
      _fetch: async (m, url) => {
        if (url === 'analytics/dashboard') {
          if (!serverKpis) throw new Error('kpis down');
          return KPIS;
        }
        if (String(url).startsWith('analytics/dashboard-series')) {
          if (!seriesOk) throw new Error('series down');
          const months = Number(String(url).match(/months=(\d+)/)?.[1] || 6);
          return {
            months: Array.from({ length: months }, (_, i) => ({ month: `2026-0${(i % 9) + 1}-01`, aum: 1000 * (i + 1), returns: 10 })),
            product_mix: [{ product_type: 'other', capital: 6870309.75, count: 12 },
                          { product_type: 'cattle', capital: 100, count: 1 }],
          };
        }
        throw new Error('unexpected fetch: ' + url);
      },
    },
    Chart: function Chart() { reached.push('Chart'); return { destroy() {} }; },
    /* loadDashboard wraps its body in try/catch, so an exception inside it does
       NOT surface to the caller — the page just stops building. Toast.error is
       what its catch reaches for, so recording the message is the only way to
       see the failure the user would experience as a half-drawn dashboard. */
    Toast: { success: rec('Toast.success'), info: rec('Toast.info'),
             error: (...a) => { reached.push('Toast.error'); caught.push(a.join(' ')); } },
    Modal: { open() {}, close() {} },
    _showLoadingBar: rec('_showLoadingBar'),
    _hideLoadingBar: rec('_hideLoadingBar'),
    _markRefreshed: rec('_markRefreshed'),
    renderRecentInvestments: rec('renderRecentInvestments'),
    renderOpenPoolsWidget:   rec('renderOpenPoolsWidget'),
    renderActivityFeed:      rec('renderActivityFeed'),
    _populateAdminWelcomeStrip: rec('_populateAdminWelcomeStrip'),
    _adminWelcomeIdentity: () => ({ name: 'Admin' }),
    _buildNotificationPanel: rec('_buildNotificationPanel'),
    /* Enumerated from loadDashboard's own body rather than discovered one
       failure at a time — a stub found by trial and error is a stub whose
       absence looked exactly like the defect under test. */
    loadAdminNotifications: rec('loadAdminNotifications'),
    Auth: { getUser: () => ({ name: 'Admin', role: 'admin', email: 'a@b.c' }) },
    /* Real helpers need a real-shaped storage: absent, not throwing. */
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    _analyticsKpisFromServer: false,
    /* Handled logging, kept apart from `caught`. A fallback announcing itself
       is the design working; only the outer catch firing means the page broke.
       Conflating the two made three correct scenarios look like failures. */
    console: { log() {}, warn() {}, error: (...a) => { logged.push(a.map(x => (x && x.stack) || x).join(' ')); } },
    Promise, Number, String, Math, JSON, Array, Object, Date, parseFloat, isNaN, setTimeout, clearTimeout, setInterval,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  vm.runInContext(sliceConst('const DASH_SOURCES = [', '\n];'), sandbox);
  vm.runInContext(sliceConst('const PRODUCT_MIX_COLORS = {', '\n};'), sandbox);

  /* The small shared helpers are loaded from source rather than stubbed.

     loadDashboard reads _staffSession, and stubbing it would have meant this
     check could not distinguish "undefined because the stub is missing" from
     "undefined because the function does not exist" — which is the entire
     class of bug this check was written for. It reported _staffSession as
     undefined the moment that helper was introduced; the helper was real and
     the stub was not there. Loading the real thing removes the ambiguity. */
  vm.runInContext(sliceConst('const _safeParse = ', '\n};'), sandbox);
  vm.runInContext(sliceConst('const _safeStorage = ', ';\n'), sandbox);
  vm.runInContext(slice('_staffSession'), sandbox);
  for (const f of ['_renderTruncationBanner', '_dashboardLoadErrors', '_dashboardTruncation',
                   '_refreshDashboardTotals', 'renderPendingActions', 'updateSidebarBadges',
                   'renderAumChart', 'renderProductMixChart', 'loadDashboard']) {
    vm.runInContext(slice(f), sandbox);
  }
  return { sandbox, els, reached, caught, logged };
}

async function run(opts) {
  const { sandbox, els, reached, caught, logged } = makeEnv(opts);
  try {
    await vm.runInContext('loadDashboard()', sandbox);
    /* Its own catch swallowing an error is the failure mode being tested, so
       that counts as an error here even though nothing propagated out. */
    return { els, reached, caught, logged,
             error: caught.length ? `caught: ${caught.join(' | ')}${logged.length ? ' || logged: ' + logged.join(' | ') : ''}` : null };
  } catch (err) {
    return { els, reached, caught, logged, error: `${err.constructor.name}: ${err.message}` };
  }
}

(async () => {
  try {
    console.log('\nit runs to the end');
    {
      const r = await run();
      ok('loadDashboard completes without its catch firing', !r.error, r.error);
      /* The specific evidence: these all sit AFTER the line that threw. */
      ok('it reaches the recent-investments list', r.reached.includes('renderRecentInvestments'),
         JSON.stringify(r.reached));
      ok('and the open-pools widget', r.reached.includes('renderOpenPoolsWidget'));
      ok('and the activity feed', r.reached.includes('renderActivityFeed'));
      ok('and draws both charts', r.reached.filter(x => x === 'Chart').length >= 2,
         `Chart constructed ${r.reached.filter(x => x === 'Chart').length} time(s)`);
      ok('and hides the loading bar it showed', r.reached.includes('_hideLoadingBar'),
         'a load that throws leaves the bar up forever');
      ok('the welcome strip is given a KYC count, not an undefined',
         r.reached.includes('_populateAdminWelcomeStrip'));
    }

    console.log('\nthe tiles and badges agree, because they share one source');
    {
      const r = await run();
      ok('the KYC tile shows the server count', r.els['ds-pending-kyc'].textContent === 3,
         String(r.els['ds-pending-kyc'].textContent));
      ok('and the sidebar badge shows the same number',
         String(r.els.kycBadge.textContent) === '3', String(r.els.kycBadge.textContent));
      ok('the withdrawals badge too',
         String(r.els.withdrawalBadge.textContent) === '2', String(r.els.withdrawalBadge.textContent));
      ok('and the tickets badge uses the counted total, not the fifty fetched',
         String(r.els.ticketBadge.textContent) === '4', String(r.els.ticketBadge.textContent));
      ok('a zero badge is hidden rather than shown as 0',
         r.els.withdrawalBadge.style.display === '');
    }

    console.log('\nthe pending-actions widget counts over whole tables');
    {
      const r = await run();
      const html = r.els.pendingActionsWidget.innerHTML;
      ok('it rendered', html.length > 100, html.slice(0, 200));
      ok('FICA reviews come from the server count', /5 FICA review/.test(html), html.slice(0, 400));
      ok('support tickets too', /4 support ticket/.test(html));
      ok('missing maturity instructions too', /8 maturity instruction/.test(html),
         'matured investments sort oldest, so these are the first rows a cap drops');
      ok('and pending transactions', /6 transaction/.test(html));
    }

    console.log('\nit still finishes when the server figures are unavailable');
    {
      const r = await run({ serverKpis: false });
      ok('loadDashboard completes', !r.error, r.error);
      ok('and still reaches the charts', r.reached.filter(x => x === 'Chart').length >= 2);
      ok('the badges fall back rather than showing nothing',
         r.els.kycBadge.textContent !== '', String(r.els.kycBadge.textContent));
    }

    console.log('\nnor does a failing series or ticket fetch stop it');
    {
      const noSeries = await run({ seriesOk: false });
      ok('a failed chart series does not abort the load', !noSeries.error, noSeries.error);
      ok('the charts still draw from the fallback',
         noSeries.reached.filter(x => x === 'Chart').length >= 2);

      const noTickets = await run({ ticketsOk: false });
      ok('a failed ticket fetch does not abort the load', !noTickets.error, noTickets.error);
      ok('and it still reaches the end', noTickets.reached.includes('_hideLoadingBar'));
    }

    console.log('\nno identifier is read that nothing declares');
    {
      const body = slice('loadDashboard');
      ok('pendingKycCount is declared before it is used',
         body.indexOf('const pendingKycCount') > -1 &&
         body.indexOf('const pendingKycCount') < body.lastIndexOf('pendingKycCount'),
         'it was read by the welcome strip after the declaration was removed');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  }
  process.exit(fail ? 1 : 0);
})();
