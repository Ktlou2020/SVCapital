#!/usr/bin/env node
/* An invitation sends a new member to the app.
 *
 * ASKED FOR: "When a group member gets invited, they need to be pushed to
 * download the app and sign up there rather than via web."
 *
 * A stokvel is run from a phone — contributions, approvals, the roster — and
 * a member who signs up in a browser has to be talked into installing the app
 * later, at a point when nothing is prompting them to. The invitation is the
 * one moment they are already being asked to do something.
 *
 * Two bounds on that, and both are asserted here because both are easy to
 * lose:
 *
 *   THE BROWSER IS STILL REACHABLE. Someone invited at a desk, or without a
 *   smartphone, still has to be able to join. The web link is demoted, not
 *   removed; an invitation that strands a member is worse than one that sends
 *   them to the wrong surface.
 *
 *   NOBODY WITH AN ACCOUNT IS SENT TO A STORE. They are signing in, not
 *   signing up, and their link opens the app if they have it. Being told to
 *   download what you already have is how a prompt stops being read.
 *
 * Run: node server/scripts/check-app-invite.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const LINKS = require(path.join(ROOT, 'server', 'services', 'appLinks.js'));

/* The real email builder, with only its transport swapped, so what is
   asserted is what would be sent rather than a restatement of it. */
function renderInvite(opts) {
  const P = path.join(ROOT, 'server', 'services') + path.sep;
  const src = read('server/services/email.js').replace(
    'async function _send({ to, subject, html, text, type }) {',
    /* globalThis, not `this`: inside a vm a function's `this` is not the
       context object, so the capture went nowhere and every assertion below
       read undefined. */
    'async function _send({ to, subject, html, text, type }) { globalThis.__cap = { to, subject, html, text }; return;');
  const ctx = {
    require: r => (r === './pushService' ? {}
                 : r === '../db/pool' ? { query: async () => ({ rows: [] }) }
                 : require(P + r.replace(/^\.\//, ''))),
    module: { exports: {} }, console: { log() {}, warn() {}, error() {} },
    process, Buffer, URL,
  };
  ctx.exports = ctx.module.exports;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src + '\n;this.__invite = sendStokvelInvite;', ctx);
  ctx.__invite('member@example.test', opts);
  return ctx.__cap || {};
}

const INVITE = {
  inviteeName: 'Balepi', inviterName: 'Thabo', stokvelName: 'Club 3',
  expiresAt: '2026-12-04', terms: '2 signatories must approve before any money leaves.',
  asSignatory: true, inviteId: 'INV-123',
};

/* ── Somebody with no account ────────────────────────────────────────── */
console.log('\nsomebody invited who has no account is sent to the app');
{
  const m = renderInvite({ ...INVITE, alreadyAUser: false });
  ok('the email was built', !!m.html && m.html.length > 500,
     'nothing rendered means nothing asserted');

  ok('IT CARRIES THE APP STORE LINK', m.html.includes(LINKS.IOS_URL), LINKS.IOS_URL);
  ok('AND THE GOOGLE PLAY LINK', m.html.includes(LINKS.ANDROID_URL), LINKS.ANDROID_URL);
  ok('the app is the thing it asks for', /Get the SV Capital app/.test(m.html),
     'the heading above the buttons');
  ok('and it says to sign up with THIS address, which is what finds the invite',
     /THIS email address/.test(m.html),
     'an account under another address is an account with no invitation in it');

  /* The bound: demoted, not deleted. */
  ok('the browser is still reachable', /signup\.html\?invite=INV-123/.test(m.html),
     'somebody at a desk, or without a smartphone, still has to be able to join');
  ok('but quietly, under the buttons', /or continue in your browser/.test(m.html),
     m.html.slice(m.html.indexOf('Get the SV Capital app'), m.html.indexOf('Get the SV Capital app') + 200));
  /* Order on the page is the whole of "pushed to the app": a browser link
     ABOVE the stores is the old email with extra buttons. */
  ok('and the stores come FIRST',
     m.html.indexOf(LINKS.IOS_URL) < m.html.indexOf('signup.html'),
     'a web link above the stores is the old invitation with buttons added');

  /* The text part is what a plain-text client and most screen readers get. */
  ok('the plain-text copy names the app too', /\/get-app/.test(m.text), m.text);
  ok('as ONE url, not two store addresses', !/apps\.apple\.com/.test(m.text),
     m.text + ' — two store links is most of a text message');
  ok('and still offers the browser', /signup\.html/.test(m.text), m.text);
}

/* ── Somebody who already has one ────────────────────────────────────── */
console.log('\nand somebody who already has an account is not sent to a store');
{
  const m = renderInvite({ ...INVITE, alreadyAUser: true });
  ok('the email was built', !!m.html && m.html.length > 500);
  ok('NO STORE LINKS AT ALL',
     !m.html.includes(LINKS.IOS_URL) && !m.html.includes(LINKS.ANDROID_URL),
     'they are signing in, not signing up — and telling somebody to install '
     + 'what they already have is how a prompt stops being read');
  ok('they are sent to their groups', /portal\/\?view=groups/.test(m.html), m.html.slice(0, 200));
  ok('and the text part agrees', /portal\/\?view=groups/.test(m.text) && !/get-app/.test(m.text),
     m.text);
}

/* ── The SMS, where there is room for one link ───────────────────────── */
console.log('\nand the SMS points at one link that sorts the phone out');
{
  const SMS = read('server/services/sms.js');
  const at  = SMS.indexOf('async function sendStokvelInvite');
  /* COMMENTS STRIPPED. They are long here and they quote the very strings
     being looked for — the comment explaining /get-app contains "/get-app",
     so changing the code to /signup left the assertion passing on the
     explanation of what the code no longer did. */
  const fn  = SMS.slice(at, SMS.indexOf('\n}', at))
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  ok('the invite SMS was found', at > 0 && fn.length > 200);
  ok('and the slice really is code, not its comment',
     !/COMMENTS STRIPPED|stokvel is run from a phone/.test(fn), fn.slice(0, 160));
  ok('a new member is sent to the app', /\/get-app/.test(fn), fn.slice(0, 400));
  ok('and told to use THIS number', /THIS number/.test(fn),
     'the number is what the invitation is addressed to');
  ok('an existing member is not', !/get-app[\s\S]*alreadyAUser \?/.test(fn)
     && /Sign in and the invite is at the top/.test(fn), fn.slice(0, 400));
  /* And the host is no longer typed in — the bug the email footer had. */
  ok('the host comes from the one definition',
     /SMS_BASE_HOST/.test(SMS) && !/'platform\.svcapital\.co\.za/.test(SMS),
     'this said platform.svcapital.co.za whatever environment sent it');
}

/* ── One set of store URLs ───────────────────────────────────────────── */
console.log('\nand there is one set of store addresses, not four');
{
  /* The browser copy, evaluated rather than pattern-matched. */
  const BANNER = read('js/app-banner.js');
  const from = BANNER.indexOf('function svcAppStore');
  const to   = BANNER.indexOf('function svcMobileOS');
  ok('the browser copy was found', from > 0 && to > from);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(BANNER.slice(from, to) + '\nthis.S = svcAppStore();', ctx);

  ok('the iOS url agrees with the browser banner', ctx.S.ios === LINKS.IOS_URL,
     `${ctx.S.ios} vs ${LINKS.IOS_URL}`);
  ok('and the Android url does too', ctx.S.android === LINKS.ANDROID_URL,
     `${ctx.S.android} vs ${LINKS.ANDROID_URL}`);
  ok('and the App Store id is the numeric one', ctx.S.iosAppId === LINKS.IOS_APP_ID,
     `${ctx.S.iosAppId} vs ${LINKS.IOS_APP_ID} — apps.apple.com resolves the `
     + 'name itself, so the number is the part that cannot go stale');

  /* And the marketing page, which had its own pair. */
  const HOME = read('index.html');
  ok('the home page points at the same app',
     HOME.includes(LINKS.IOS_URL) && HOME.includes(`id=${LINKS.ANDROID_ID}`),
     'a store id corrected in one place and not the others sends part of the '
     + 'audience to a page that does not exist');
}

/* ── The page the one link lands on ──────────────────────────────────── */
console.log('\nand the page that link lands on works before any script runs');
{
  const PAGE = read('get-app.html');
  ok('the page exists and is a document', /^<!DOCTYPE html>/i.test(PAGE.trim()));
  ok('BOTH STORES ARE IN THE MARKUP', PAGE.includes(LINKS.IOS_URL) && PAGE.includes(LINKS.ANDROID_URL),
     'the redirect is a convenience; a page that is blank without JavaScript '
     + 'is the end of the line for whoever lands on it');
  ok('and so is the browser route', /href="signup\.html"/.test(PAGE), 'get-app.html');
  ok('it tells them which address to sign up with',
     /email address or cell number your invitation was sent to/.test(PAGE), 'get-app.html');

  /* THE PAGE'S OWN SCRIPT, RUN. The first version of this restated the
     user-agent rule in the check and asserted on the restatement, which
     proves only that I can write the same regex twice: deleting the whole
     script from the page would have passed it. The script is lifted out and
     executed against fake navigators, and where it sends the browser is
     read off the fake location. */
  const from = PAGE.indexOf('<script>', PAGE.indexOf('</div>'));
  const to   = PAGE.indexOf('</script>', from);
  ok('the redirect script was found', from > 0 && to > from,
     'a slice that missed it would assert nothing while passing');
  const script = PAGE.slice(PAGE.indexOf('>', from) + 1, to);

  const land = (ua, { maxTouchPoints = 0, navType = 'navigate' } = {}) => {
    let went = null;
    const timers = [];
    const ctx = {
      navigator: { userAgent: ua, maxTouchPoints },
      document: { getElementById: id => ({ href: id === 'android' ? LINKS.ANDROID_URL : LINKS.IOS_URL }) },
      performance: { getEntriesByType: () => [{ type: navType }] },
      window: null,
      setTimeout: fn => { timers.push(fn); return 0; },
    };
    /* location.replace is what the page calls; href is captured too, in
       case it ever falls back to assigning that instead. */
    ctx.window = {
      addEventListener: () => {},
      location: { replace: u => { went = u; }, set href(u) { went = u; }, get href() { return ''; } },
    };
    vm.createContext(ctx);
    vm.runInContext(script, ctx);
    timers.forEach(fn => fn());
    return went;
  };

  ok('AN ANDROID PHONE IS SENT TO PLAY',
     land('Mozilla/5.0 (Linux; Android 14) Mobile Safari') === LINKS.ANDROID_URL,
     String(land('Mozilla/5.0 (Linux; Android 14) Mobile Safari')));
  ok('AN IPHONE IS SENT TO THE APP STORE',
     land('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari') === LINKS.IOS_URL,
     String(land('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari')));
  ok('an iPad reporting itself as a Mac is still an iPad',
     land('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', { maxTouchPoints: 5 }) === LINKS.IOS_URL,
     String(land('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', { maxTouchPoints: 5 })));
  ok('AND A DESKTOP IS LEFT ALONE',
     land('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120') === null,
     String(land('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120'))
     + ' — there is nothing to install there, and bouncing somebody at a '
     + 'laptop into a store listing hides the only link that helps them');
  ok('a real Mac is left alone too',
     land('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', { maxTouchPoints: 0 }) === null,
     'a Mac without touch points is a Mac');
  ok('AND A PAGE REOPENED WITH THE BACK BUTTON DOES NOT BOUNCE',
     land('Mozilla/5.0 (Linux; Android 14) Mobile Safari', { navType: 'back_forward' }) === null,
     'a phone returning from the store would be thrown straight back at it, '
     + 'and could never reach the browser link');
  ok('the page is published by the site build',
     /get-app\.html/.test(read('package.json')),
     'a page the build does not copy is a dead link in every SMS');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
