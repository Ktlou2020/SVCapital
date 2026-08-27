#!/usr/bin/env node
/* The dashboard must not present a partial or failed load as a complete one.
 *
 * It is the first screen anyone opens and its four tiles get quoted. It read a
 * capped page of each table, summed the rows in the browser, and compared
 * nothing against the row count the API already returns beside them. Past its
 * cap a tile simply stops growing, with no symptom — the analytics tab was
 * given a guard for exactly this and the dashboard never got one.
 *
 * It also loaded with Promise.all, so one failing query blanked the whole page,
 * and a separate 30-second refresh carried its OWN copy of the load and the
 * four sums — with a different investor limit — while rewriting the tiles
 * without touching any banner.
 *
 * These are asserted against the shipped file. The banner behaviour is
 * exercised by running the real functions against a DOM stub, not by matching
 * the markup: a check that only greps for a string passes on a banner that is
 * built and never shown.
 *
 * No database, no browser.
 *
 * Run: node scripts/check-dashboard-integrity.cjs
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

/* Pull the banner functions out of the shipped file and run them. Sliced to the
   closing brace at column 0 so a comment or a long template cannot truncate
   the capture the way a fixed character window would. */
function extract(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in admin/js/admin.js`);
  const end = SRC.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`could not find the end of ${name}`);
  return SRC.slice(start, end + 3);
}

function makeDom() {
  const els = {};
  const mk = id => (els[id] = { id, style: { display: 'none' }, innerHTML: '', textContent: '' });
  ['an-truncation', 'ds-truncation', 'ds-load-errors',
   'ds-investors', 'ds-invested', 'ds-returns', 'ds-pools'].forEach(mk);
  return {
    els,
    document: { getElementById: id => els[id] || null },
  };
}

function runBanners(fnNames) {
  const dom = makeDom();
  const sandbox = {
    document: dom.document,
    _esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    _analyticsKpisFromServer: true,
    console, Number, String, Math, JSON, Array, Object,
  };
  vm.createContext(sandbox);
  for (const n of fnNames) vm.runInContext(extract(n), sandbox);
  return { sandbox, els: dom.els };
}

(async () => {
  try {
    console.log('\nthe shipped dashboard reads its sources safely');
    ok('the load is isolated, not all-or-nothing',
       /const settled = await Promise\.allSettled\(DASH_SOURCES\.map/.test(SRC),
       'Promise.all means one failing query blanks the whole page');
    ok('a failed source is recorded rather than swallowed',
       /failedSources\.push\(s\.label\)/.test(SRC));
    ok('and the page still renders with the others',
       /STATE\[s\.key\] = \[\];/.test(SRC));
    ok('the row count the API returns is actually read',
       /total: Number\(r\.value\?\.total\)/.test(SRC),
       'the true COUNT(*) has always been in the response; nothing looked at it');

    console.log('\nthere is one load path, not two');
    {
      const bodies = SRC.match(/API\.investors\.list\(\{ limit: \d+ \}\)/g) || [];
      const dashDup = SRC.match(/API\.transactions\.list\(\{ limit: 5000 \}\)[\s\S]{0,400}?ds-returns/g) || [];
      ok('the 30-second refresh calls the shared function',
         /await _refreshDashboardTotals\(\); renderPendingActions\(\)/.test(SRC));
      ok('it no longer carries its own copy of the four sums', dashDup.length === 0,
         'a second copy drifted once already — its investor limit was 5000 against the first load\'s 10000');
      ok('the refresh reports failures instead of swallowing them',
         /auto-refresh failed/.test(SRC) && !/\}\s*catch \(_\) \{\}\s*\n\s*\}, 30000\)/.test(SRC));
      ok('only one investor limit is used for the dashboard',
         (SRC.match(/API\.investors\.list\(\{ limit: 10000 \}\)/g) || []).length === 1 &&
         /DASH_SOURCES/.test(SRC), JSON.stringify(bodies.slice(0, 4)));
    }

    console.log('\nthe truncation banner is shared, not copied');
    ok('one renderer builds both banners',
       /function _renderTruncationBanner\(elId, loadedVsTotal, tail\)/.test(SRC),
       'two copies of a warning about wrong numbers is how one goes stale');
    ok('analytics uses it', /_renderTruncationBanner\('an-truncation'/.test(SRC));
    ok('the dashboard uses it',  /_renderTruncationBanner\('ds-truncation'/.test(SRC));

    console.log('\nit fires only when a table is genuinely short');
    {
      const { els } = runBanners(['_renderTruncationBanner', '_analyticsTruncation', '_dashboardTruncation']);
      const call = (fn, counts) => {
        const { sandbox, els: e } = runBanners(['_renderTruncationBanner', '_analyticsTruncation', '_dashboardTruncation']);
        const shown = vm.runInContext(`${fn}(${JSON.stringify(counts)})`, sandbox);
        return { shown, el: e[fn === '_dashboardTruncation' ? 'ds-truncation' : 'an-truncation'] };
      };

      const complete = call('_dashboardTruncation', [
        { label: 'Investments',  loaded: 1200, total: 1200 },
        { label: 'Transactions', loaded: 4300, total: 4300 },
      ]);
      ok('a complete load shows nothing', complete.shown === false &&
         complete.el.style.display === 'none' && complete.el.innerHTML === '');

      const short = call('_dashboardTruncation', [
        { label: 'Investments',  loaded: 1200, total: 1200 },
        { label: 'Transactions', loaded: 5000, total: 8412 },
      ]);
      ok('a short table shows the banner', short.shown === true && short.el.style.display === '');
      ok('naming the table, both counts and the shortfall',
         /Transactions/.test(short.el.innerHTML) &&
         /5,000/.test(short.el.innerHTML) && /8,412/.test(short.el.innerHTML) &&
         /3,412/.test(short.el.innerHTML), short.el.innerHTML.slice(0, 400));
      ok('and does not name the table that was complete',
         !/<strong>Investments<\/strong>/.test(short.el.innerHTML));
      ok('it says not to report the figures',
         /do not report them/i.test(short.el.innerHTML));

      /* A total the API did not supply must not be read as zero — that would
         make every complete load look short. */
      const unknown = call('_dashboardTruncation', [
        { label: 'Transactions', loaded: 5000, total: NaN },
      ]);
      ok('an unknown total is not treated as a shortfall', unknown.shown === false);
      void els;
    }

    console.log('\na failed source is distinguished from a zero figure');
    {
      const { sandbox, els } = runBanners(['_dashboardLoadErrors']);
      const none = vm.runInContext(`_dashboardLoadErrors([])`, sandbox);
      ok('nothing failed shows nothing', none === false && els['ds-load-errors'].innerHTML === '');

      const one = vm.runInContext(`_dashboardLoadErrors(['Transactions'])`, sandbox);
      ok('a failure is shown', one === true && els['ds-load-errors'].style.display === '');
      ok('naming the source', /Transactions/.test(els['ds-load-errors'].innerHTML));
      ok('and saying zero means missing, not zero',
         /not because the figure is zero/.test(els['ds-load-errors'].innerHTML),
         'this is the whole point of the banner');
      ok('with a retry', /loadDashboard\(\)/.test(els['ds-load-errors'].innerHTML));

      const two = vm.runInContext(`_dashboardLoadErrors(['Investments','Transactions'])`, sandbox);
      ok('two failures read as a sentence',
         two === true && /Investments and Transactions/.test(els['ds-load-errors'].innerHTML),
         els['ds-load-errors'].innerHTML.slice(0, 200));
    }

    console.log('\nthe page has somewhere to put them');
    {
      const html = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
      ok('the dashboard has a truncation anchor', /id="ds-truncation"/.test(html));
      ok('and a load-error anchor', /id="ds-load-errors"/.test(html));
      ok('both start hidden',
         /id="ds-load-errors"[^>]*display:none/.test(html) &&
         /id="ds-truncation"[^>]*display:none/.test(html));
      ok('they sit above the tiles they qualify',
         html.indexOf('id="ds-truncation"') < html.indexOf('id="dashStats"'),
         'a warning below the numbers it applies to is a warning nobody reads');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  }
  process.exit(fail ? 1 : 0);
})();
