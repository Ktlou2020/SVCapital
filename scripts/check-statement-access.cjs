#!/usr/bin/env node
/* The statement and the Investment Income Reference are reachable.
 *
 * Both were withdrawn from the portal and the app in August, and not by
 * deleting them: the view, the panels and the buttons all stayed in the DOM
 * behind inline display:none, and the command-palette entries were commented
 * out. That is six entry points on the web and five in the app, and the
 * original removal needed three commits precisely because closing the drawer
 * tab left the rest reachable.
 *
 * Turning them back on has the same shape in reverse, so this asserts what a
 * client can actually see rather than what the markup says. The page is loaded
 * in headless Chromium with its real stylesheets and the COMPUTED display is
 * read, because a control can be re-enabled in the HTML and still be hidden by
 * a rule in the CSS — which is exactly the failure this would otherwise miss.
 *
 * The app shell is checked too. mobile/src is the source; mobile/www is built
 * from it, and check-mobile-build-reproducible.cjs holds those two together.
 *
 * Scripts are stripped before loading. The portal's auth guard redirects a
 * logged-out visitor to login.html, so with scripts live there is no page left
 * to measure; and this is a question about markup and CSS, which is what the
 * original removal was verified against too. It also means the drawer is in
 * its resting state, so the navigation entry is compared against a SIBLING tab
 * rather than asserted visible outright — every tab in a closed drawer
 * computes as hidden, and asserting otherwise fails for the wrong reason.
 *
 * Run: node scripts/check-statement-access.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

if (!CHROME) {
  console.log('  SKIP  no headless Chromium — nothing was rendered');
  process.exit(0);
}

/* Load a shell with a <base> so its relative stylesheets still resolve from a
   temp copy, and report the computed display of the controls we care about.
   Scripts are left to fail — there is no API here — which is the point: this
   is about what CSS and markup do before any data arrives. */
function inspect(shellRelPath) {
  const abs = path.join(ROOT, shellRelPath);
  const baseHref = 'file://' + path.dirname(abs) + '/';
  let html = fs.readFileSync(abs, 'utf8');

  const probe = `
<div id="__probe"></div>
<script>
(function () {
  /* Visible WITHIN ITS VIEW. Only one .view is active at a time and the rest
     are display:none, so with no script running to activate one, walking all
     the way to <body> reports every panel on the page as hidden. The walk
     stops at the .view boundary, which is the question actually being asked:
     when a client opens this view, is the control there? */
  function shown(el) {
    if (!el) return null;
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.classList && n.classList.contains('view')) break;
      var cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  }
  /* The nearest enclosing .panel, so a heading tells us about its whole card. */
  function panelSaying(text) {
    var all = [].slice.call(document.querySelectorAll('.panel__title, .panel__header'));
    var h = all.filter(function (e) { return (e.textContent || '').indexOf(text) > -1; })[0];
    if (!h) return null;
    for (var n = h; n && n.nodeType === 1; n = n.parentElement) {
      if (n.classList && n.classList.contains('panel')) return n;
    }
    return h;
  }
  function buttonSaying(text) {
    return [].slice.call(document.querySelectorAll('button, a')).filter(function (e) {
      return (e.textContent || '').replace(/\\s+/g, ' ').indexOf(text) > -1;
    })[0] || null;
  }
  /* A nav tab's OWN computed display, not whether the drawer happens to be
     open. An ancestor's display:none does not change a child's computed
     display, so this reads the tab itself — and comparing it with a sibling
     tab says whether this one carries a rule the others do not. Walking to
     <body> instead would report every tab as hidden in a closed drawer, and
     re-hiding just this one would still "match". */
  function ownDisplay(el) { return el ? getComputedStyle(el).display : null; }
  var out = {
    navTab:        ownDisplay(document.querySelector('[data-view=statement]')),
    navSibling:    ownDisplay(document.querySelector('[data-view=documents]')),
    statementView: !!document.getElementById('view-statement'),
    archivePanel:  shown(document.getElementById('statementArchivePanel')),
    accountPanel:  shown(panelSaying('Account Statement')),
    incomePanel:   shown(panelSaying('Investment Income Certificate')),
    txnButton:     shown(buttonSaying('Get Transactions Statement')),
    invButton:     shown(buttonSaying('Get Investment Statement')),
  };
  document.getElementById('__probe').textContent = JSON.stringify(out);
})();
<\/script>`;

  /* Strip every script: the portal's auth guard navigates away otherwise. */
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<head(\s[^>]*)?>/i, m => m + `\n<base href="${baseHref}">`);
  html = html.includes('</body>') ? html.replace('</body>', probe + '\n</body>') : html + probe;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stmtaccess-'));
  const file = path.join(tmp, 'shell.html');
  fs.writeFileSync(file, html);

  let dom = '';
  try {
    dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=6000', '--dump-dom', 'file://' + file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) { dom = (err.stdout || '').toString(); }
  fs.rmSync(tmp, { recursive: true, force: true });

  const m = dom.match(/id="__probe">([\s\S]*?)<\/div>/);
  try {
    return JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
  } catch (_) { return null; }
}

/* [shell, label, whether this surface carries the My Investments button] */
const SHELLS = [
  ['portal/index.html',     'the investor portal', true],
  ['mobile/src/index.html', 'the mobile app',      false],
];

for (const [shell, label, hasInvButton] of SHELLS) {
  console.log(`\n${label}`);
  const r = inspect(shell);
  ok('the shell rendered', !!r, 'no probe came back');
  if (!r) continue;

  ok('the statement view is in the shell',   r.statementView === true);
  /* Parity, not absolute visibility: a closed drawer hides all of its tabs. */
  ok('“My Statement” is as visible as its neighbours',
     r.navTab !== null && r.navTab !== 'none' && r.navTab === r.navSibling,
     `statement=${r.navTab} documents=${r.navSibling} — it is hidden by inline ` +
     `display:none or a CSS rule that its sibling tabs do not carry`);
  ok('the monthly statement archive shows',  r.archivePanel === true);
  ok('the Account Statement panel shows',    r.accountPanel === true);
  ok('the Investment Income Certificate panel shows', r.incomePanel === true);
  ok('the Transactions statement button shows', r.txnButton === true);
  if (hasInvButton) {
    ok('the My Investments statement button shows', r.invButton === true);
  }
}

console.log('\nthe entry points that do not live in the shell');
{
  /* The command palette and two in-page buttons are built in JS, and were
     commented out rather than deleted — so their absence is invisible in the
     rendered DOM above until a client goes looking. */
  const files = [['portal/js/portal.js', 'the portal'], ['mobile/src/js/portal.js', 'the app']];
  for (const [rel, label] of files) {
    const s = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    ok(`${label} command palette offers the statement`,
       /label: 'Account Statement'/.test(s));
    ok(`${label} command palette offers the tax certificate`,
       /label: 'Download Tax Certificate'/.test(s));
    ok(`${label} command palette offers the statement PDF`,
       /label: 'Download Statement PDF'/.test(s));
    ok(`${label} next-step panel links to the statement`,
       /fa-file-invoice"><\/i> Statement<\/button>/.test(s),
       'the button was replaced by a comment');
    ok(`${label} empty receipts list offers to generate one`,
       /fa-file-invoice"><\/i> Generate statement<\/button>/.test(s));
  }

  ok('and nothing still says these are not offered',
     !/statements are not offered|tax certificates are not offered|not offered in the app/
       .test([...files.map(f => f[0]), 'portal/index.html', 'mobile/src/index.html']
         .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n')),
     'a stale comment outlives the decision it explains');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
