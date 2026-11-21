#!/usr/bin/env node
/* One refresh at a time, and one sign-out.
 *
 * OBSERVED IN PRODUCTION, on a real phone. A single expired session
 * produced three 401s on data endpoints and then SIX POSTs to
 * /auth/refresh inside seventeen milliseconds, every one of them 401.
 *
 * The portal fires several requests in parallel at boot. Each met the same
 * dead token, each got a 401, and each independently started its own
 * refresh — then, when the refresh also failed, each independently posted a
 * logout and raised its own session-expired overlay.
 *
 * Nothing about it was unsafe: the session really had ended and nothing
 * leaked. What it did was hammer the auth endpoint, spend a client's
 * battery and data redoing work already in progress, and bury the 4xx line
 * in monitoring so nothing else could be seen in it.
 *
 * THIS IS A CONCURRENCY BUG, so it is RUN rather than read. Reading the
 * source for the word "once" would have passed against the broken version
 * too — what matters is how many requests actually leave when ten callers
 * meet one dead token at the same instant.
 *
 * Run: node server/scripts/check-token-refresh-storm.cjs
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

const SRC = read('js/api.js');

/* ── A browser, near enough ──────────────────────────────────────────
   The two helpers are driven for real against a fetch that counts what
   leaves. Only the pieces they touch are stood up. */
function load({ refreshOk = false, freshToken = null }) {
  const calls = { refresh: 0, logout: 0, cleared: 0, overlay: 0, redirect: 0 };
  const store = () => {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null),
             setItem: (k, v) => m.set(k, String(v)),
             removeItem: k => m.delete(k), clear: () => m.clear() };
  };
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, Date, Math, String, Number, Boolean,
    localStorage: store(), sessionStorage: store(),
    navigator: { userAgent: 'check' },
    document: { cookie: '', addEventListener() {} },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    atob: b => Buffer.from(b, 'base64').toString('binary'),
    btoa: b => Buffer.from(b, 'binary').toString('base64'),
    async fetch(url, opts) {
      const u = String(url);
      if (u.includes('auth/refresh')) {
        calls.refresh++;
        /* A real request takes time; without a tick here every caller
           would be serialised by accident and the test would pass on a
           broken implementation. */
        await new Promise(r => setTimeout(r, 15));
        return { ok: refreshOk, status: refreshOk ? 200 : 401,
                 json: async () => ({ token: freshToken }) };
      }
      if (u.includes('auth/logout')) { calls.logout++; return { ok: true, status: 204 }; }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  };
  ctx.window = ctx;
  ctx.location = { pathname: '/portal/', href: '' };
  Object.defineProperty(ctx, 'location', {
    get: () => ctx._loc, set: v => { ctx._loc = v; }, configurable: true });
  ctx._loc = { pathname: '/portal/', get href() { return ''; },
               set href(v) { calls.redirect++; } };
  vm.createContext(ctx);

  /* Only what the two helpers need, plus a stand-in Auth whose clear() is
     counted. */
  const from = SRC.indexOf('let _svcRefreshInFlight');
  const to   = SRC.indexOf('/* ─── Platform tag');
  const decl = SRC.slice(from, to);
  const h1   = SRC.slice(SRC.indexOf('function _svcRefreshOnce'),
                         SRC.indexOf('/* The give-up.'));
  const h2   = SRC.slice(SRC.indexOf('async function _svcEndSession'),
                         SRC.indexOf('    if (r.status === 401) {'));
  vm.runInContext(
    decl + h1 + h2
    + `\nconst Auth = { clear() { _calls.cleared++; } };`
    + `\nthis.refreshOnce = _svcRefreshOnce;`
    + `\nthis.endSession  = _svcEndSession;`
    + `\nthis.reset = () => { _svcSessionEnded = false; };`
    + `\nthis.ended = () => _svcSessionEnded;`,
    Object.assign(ctx, { _calls: calls }));
  return { ctx, calls };
}

(async () => {

console.log('\nten requests meeting one dead token ask once between them');
{
  const { ctx, calls } = load({ refreshOk: true, freshToken: 'TOK' });
  const out = await Promise.all(Array.from({ length: 10 }, () => ctx.refreshOnce('/api/')));
  ok('ONE REQUEST LEAVES, NOT TEN', calls.refresh === 1,
     `${calls.refresh} — production saw six in seventeen milliseconds`);
  ok('and every caller gets the token', out.every(t => t === 'TOK'), JSON.stringify(out));
}

console.log('\nand a later 401 is not served a stale answer');
{
  const { ctx, calls } = load({ refreshOk: true, freshToken: 'TOK' });
  await ctx.refreshOnce('/api/');
  await ctx.refreshOnce('/api/');
  ok('THE IN-FLIGHT PROMISE IS CLEARED WHEN IT SETTLES', calls.refresh === 2,
     `${calls.refresh} — a shared promise that is never released would replay `
     + 'one answer for the life of the page, so a session could never be renewed twice');
}

console.log('\nand a failing refresh is shared too, which is the reported case');
{
  const { ctx, calls } = load({ refreshOk: false });
  const out = await Promise.all(Array.from({ length: 6 }, () => ctx.refreshOnce('/api/')));
  ok('six callers, one request', calls.refresh === 1, String(calls.refresh));
  ok('and all of them are told no', out.every(t => t === null), JSON.stringify(out));
}

console.log('\nand the sign-out happens once however many requests reach it');
{
  const { ctx, calls } = load({ refreshOk: false });
  let overlays = 0;
  await Promise.all(Array.from({ length: 8 }, () =>
    ctx.endSession('/api/', () => { overlays++; }, () => {})));
  ok('ONE LOGOUT, NOT EIGHT', calls.logout === 1,
     `${calls.logout} — each parallel request posted its own`);
  ok('the session is cleared once', calls.cleared === 1, String(calls.cleared));
  ok('and the client is told once',
     overlays === 1, `${overlays} overlays — eight of them stack on one screen`);
}

console.log('\nand it re-arms, so the NEXT expiry is not swallowed');
{
  const { ctx, calls } = load({ refreshOk: false });
  await ctx.endSession('/api/', () => {}, () => {});
  ok('the teardown is marked done', ctx.ended() === true);
  ctx.reset();                       // what Auth.setToken does on a sign-in
  await ctx.endSession('/api/', () => {}, () => {});
  ok('A SIGN-IN RE-ARMS IT', calls.logout === 2,
     `${calls.logout} — somebody signed out by an expiry, who signs back in, must `
     + 'still be signed out by the next one rather than left with failing requests '
     + 'and a screen that never says why');
}

/* ── And the wiring, which running the helpers cannot show ─────────── */
console.log('\nand the 401 handler uses them rather than its own fetch');
{
  const handler = SRC.slice(SRC.indexOf('    if (r.status === 401) {'),
                            SRC.indexOf("throw new Error('Session expired"));
  ok('the refresh goes through the shared one',
     /_svcRefreshOnce\(_API_BASE\)/.test(handler), handler.slice(0, 200));
  ok('AND THERE IS NO SECOND REFRESH FETCH LEFT IN IT',
     !/fetch\([^)]*auth\/refresh/.test(handler),
     'a direct call here is the storm coming back');
  ok('the give-up goes through the shared one',
     /_svcEndSession\(_API_BASE/.test(handler), handler.slice(-300));
  ok('and no second logout fetch is left in it',
     !/fetch\([^)]*auth\/logout/.test(handler), 'the logout is inside _svcEndSession');
  ok('a successful refresh re-arms the teardown',
     /_svcSessionEnded = false/.test(handler), handler.slice(0, 400));

  const setTok = SRC.slice(SRC.indexOf('setToken(token, user'), SRC.indexOf('const held ='));
  ok('and so does a real sign-in', /_svcSessionEnded = false/.test(setTok), setTok.slice(0, 200));

  /* The identity guard this sits inside must survive the change: a refresh
     that comes back as somebody else is a session that has ended. */
  ok('THE DIFFERENT-ACCOUNT GUARD IS STILL THERE',
     /sub === mine/.test(handler),
     'an expired token for one person and a cookie for another must not sign '
     + 'the reader in as the other person');

  ok('the state is declared before the code that reads it',
     SRC.indexOf('let _svcSessionEnded') < SRC.indexOf('setToken(token, user'),
     'Auth.setToken reads it and is defined hundreds of lines earlier');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})().catch(e => { console.error(e); process.exit(1); });
