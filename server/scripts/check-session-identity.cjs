#!/usr/bin/env node
/* Whose session a browser hands back.
 *
 * REPORTED: a stokvel invitation's "Sign in to SV Capital" link landed the
 * recipient in somebody else's profile.
 *
 * The link carries no token — it is `/portal/?view=groups` and nothing more,
 * which is deliberate and is why the email can safely be forwarded. The
 * identity came from the browser.
 *
 * svc_refresh is an httpOnly cookie with a THIRTY DAY life. The 401 handler
 * in js/api.js posted it to /auth/refresh on every 401, including the 401 of
 * somebody who had never signed in on that browser at all. The invitation
 * link opens the portal, the portal fetches, the fetch 401s with no token,
 * and /auth/refresh did exactly what it exists to do: it returned a valid
 * access token for whoever that cookie belonged to. The new recipient was
 * signed in as the last person to use that browser, with no password and no
 * prompt. On a shared phone — the normal case for a savings group — that is
 * every invitation.
 *
 * A refresh may now only EXTEND a session this browser already has, and only
 * as the same account. Anything else is a sign-in, and a sign-in happens on
 * the login screen.
 *
 * The real js/api.js is loaded and driven. A hand-written copy of the rule
 * would be a check of the copy.
 *
 * Run: node server/scripts/check-session-identity.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* A token the real Auth.getToken() will parse: it decodes the payload and
   checks exp, so a made-up string would be discarded before any of this
   was exercised. */
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwtFor = (id, { expired = false } = {}) => 'h.' + b64({
  id, email: `u${id}@example.test`,
  exp: Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600),
}) + '.s';

function newStore() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    get size() { return m.size; },
    _dump: () => Object.fromEntries(m),
  };
}

/* One browser. `calls` records every request the code makes, which is what
   the first assertion below is really about: the bug was a request that
   should never have been sent. */
function browser({ local = {}, session = {}, onFetch }) {
  const localStorage = newStore(), sessionStorage = newStore();
  Object.entries(local).forEach(([k, v]) => localStorage.setItem(k, v));
  Object.entries(session).forEach(([k, v]) => sessionStorage.setItem(k, v));

  const calls = [];
  const loc = { pathname: '/portal/', href: '/portal/' };
  const ctx = {
    localStorage, sessionStorage, console: { warn() {}, log() {}, error() {} },
    atob: s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('binary'),
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    setTimeout, clearTimeout, AbortController, URLSearchParams,
    /* A document that records nothing but does not throw: api.js binds an
       ESC handler at the end of the file, and the file is loaded whole. */
    document: {
      addEventListener() {}, getElementById: () => null,
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} },
                              addEventListener() {}, appendChild() {} }),
      body: { style: {}, appendChild() {} },
      querySelectorAll: () => [],
    },
    fetch: async (url, opts = {}) => {
      calls.push({ url: String(url), method: (opts.method || 'GET').toUpperCase() });
      return onFetch(String(url), opts);
    },
  };
  ctx.window = ctx;
  ctx.window.location = loc;
  ctx.self = ctx;
  vm.createContext(ctx);
  /* Auth and API are top-level `const` in a classic script, which makes them
     script-scoped and NOT properties of the context. Handed out explicitly. */
  vm.runInContext(SRC + '\n;this.__Auth = Auth; this.__API = API;', ctx);
  return { Auth: ctx.__Auth, API: ctx.__API, calls, localStorage, sessionStorage, loc };
}

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body,
});

async function main() {
/* ── 1. The reported bug ─────────────────────────────────────────────── */
console.log('\na browser with no session is never handed one');
{
  /* Nobody signed in here. The server still holds a 30-day refresh cookie
     for USER 7, the last person to use this browser, and would honour it. */
  const b = browser({
    onFetch: async (url) => {
      if (url.includes('auth/refresh')) return json({ token: jwtFor(7) });
      if (url.includes('auth/logout')) return json({ ok: true });
      return json({ error: 'Unauthorized' }, 401);
    },
  });
  let threw = null;
  {
    try { await b.API._fetch('GET', 'portal/me'); } catch (e) { threw = e; }

    ok('the request was attempted', b.calls.some(c => c.url.includes('portal/me')));
    ok('AND /auth/refresh WAS NEVER CALLED',
       !b.calls.some(c => c.url.includes('auth/refresh')),
       JSON.stringify(b.calls) + ' — the cookie belongs to whoever used this '
       + 'browser last; posting it signs the new person in as them');
    ok('no token was adopted',
       !b.localStorage.getItem('svc_token') && !b.sessionStorage.getItem('svc_token'),
       JSON.stringify({ local: b.localStorage._dump(), session: b.sessionStorage._dump() }));
    ok('the leftover refresh cookie is cleared rather than left for 30 days',
       b.calls.some(c => c.url.includes('auth/logout') && c.method === 'POST'),
       JSON.stringify(b.calls));
    ok('and they are sent to the login screen',
       String(b.loc.href).includes('login'), b.loc.href);
    ok('the caller is told the session ended', !!threw && /log in again/i.test(threw.message),
       threw && threw.message);
  }
}
/* ── 2. A real session is still extended ─────────────────────────────── */
console.log('\nbut a session already here is still extended silently');
{
  /* TWO DIFFERENT TOKENS FOR THE SAME PERSON. The first version of this
     stored a live token and had the server accept it, so the request
     succeeded outright and no 401 — and therefore no refresh — ever
     happened. It passed the "succeeded" assertion while testing nothing.
     The stored token is one the server has revoked; only the one the
     refresh issues is accepted. */
  const stale = jwtFor(42), fresh = jwtFor(42) + 'X';
  const b = browser({
    local: { svc_token: stale, svc_user: JSON.stringify({ id: 42, email: 'a@example.test' }) },
    onFetch: async (url, opts) => {
      if (url.includes('auth/refresh')) return json({ token: fresh });
      const auth = (opts.headers || {}).Authorization || '';
      if (!auth.includes(fresh)) return json({ error: 'Unauthorized' }, 401);
      return json({ data: 'mine' });
    },
  });
  let out = null, err = null;
  try { out = await b.API._fetch('GET', 'portal/me'); } catch (e) { err = e; }
  ok('the first attempt really was refused',
     b.calls.filter(c => c.url.includes('portal/me')).length === 2,
     JSON.stringify(b.calls) + ' — without a 401 there is no refresh to test');
  ok('the refresh was attempted', b.calls.some(c => c.url.includes('auth/refresh')),
     JSON.stringify(b.calls) + (err ? ' — ' + err.message : ''));
  ok('the request succeeded on the retry', !!out && out.data === 'mine',
     JSON.stringify(out) + (err ? ' — ' + err.message : ''));
  ok('and they were NOT bounced to login', !String(b.loc.href).includes('login'), b.loc.href);
  /* The refresh carries no user, and the guard in scenario 3 reads one. */
  ok('the identity survives the refresh',
     (b.Auth.getUser() || {}).id === 42, JSON.stringify(b.Auth.getUser())
     + ' — losing it blinds the different-account guard on the next refresh');
}

/* ── 2b. The session the refresh exists for ──────────────────────────── */
console.log('\nand an access token that has simply aged out is renewed, not ejected');
{
  /* THE REGRESSION THE GATE ALMOST SHIPPED. getToken() returns null for an
     expired token — and used to delete svc_user with it — so "does this
     browser have a session?" answered no for exactly the case a silent
     refresh is for. Gating the refresh on a valid token would have signed
     every user out the moment their access token aged out, which is the
     ordinary course of events and not a security event at all. */
  const aged = jwtFor(42, { expired: true });
  const fresh = jwtFor(42) + 'Z';
  const b = browser({
    local: { svc_token: aged, svc_user: JSON.stringify({ id: 42, email: 'a@example.test' }) },
    onFetch: async (url, opts) => {
      if (url.includes('auth/refresh')) return json({ token: fresh });
      const auth = (opts.headers || {}).Authorization || '';
      if (!auth.includes(fresh)) return json({ error: 'Unauthorized' }, 401);
      return json({ data: 'mine' });
    },
  });
  ok('the aged token is not offered', b.Auth.getToken() === null,
     String(b.Auth.getToken()));
  ok('but the browser still knows whose session this is',
     (b.Auth.getUser() || {}).id === 42, JSON.stringify(b.Auth.getUser())
     + ' — without this the refresh below is refused and they are logged out');
  let out = null, err = null;
  try { out = await b.API._fetch('GET', 'portal/me'); } catch (e) { err = e; }
  ok('THE SESSION IS RENEWED SILENTLY', !!out && out.data === 'mine',
     (err ? err.message : JSON.stringify(out))
     + ' — an expired token is the normal case, not an intruder');
  ok('and they stay where they were', !String(b.loc.href).includes('login'), b.loc.href);
}

/* ── 3. A refresh that comes back as somebody else ───────────────────── */
console.log('\nand a refresh that answers as a different account is refused');
{
  /* User 42's access token is stale; the cookie belongs to user 7. This is
     the same bug arriving by another door, and the tempting read is that
     the newer credential wins. It must not: the person at the screen is 42. */
  const b = browser({
    local: { svc_token: jwtFor(42), svc_user: JSON.stringify({ id: 42, email: 'a@example.test' }) },
    onFetch: async (url) => {
      if (url.includes('auth/refresh')) return json({ token: jwtFor(7) });
      if (url.includes('auth/logout')) return json({ ok: true });
      return json({ error: 'Unauthorized' }, 401);
    },
  });
  let threw = null;
  try { await b.API._fetch('GET', 'portal/me'); } catch (e) { threw = e; }
  ok('the other account\'s token is NOT stored',
     b.localStorage.getItem('svc_token') !== jwtFor(7)
     && !b.sessionStorage.getItem('svc_token'),
     JSON.stringify({ local: b.localStorage._dump(), session: b.sessionStorage._dump() }));
  ok('the request is NOT retried as them',
     b.calls.filter(c => c.url.includes('portal/me')).length === 1,
     JSON.stringify(b.calls) + ' — a retry here returns another client\'s money');
  ok('everything is cleared', !b.localStorage.getItem('svc_token')
     && !b.localStorage.getItem('svc_user'),
     JSON.stringify(b.localStorage._dump()));
  ok('and the session is reported as ended', !!threw && /log in again/i.test(threw.message),
     threw && threw.message);
}

/* ── 4. One session, in one place ────────────────────────────────────── */
console.log('\nand signing in replaces whatever was there');
{
  /* getToken() reads localStorage first. Somebody signing in WITHOUT
     "remember me" wrote to sessionStorage while an earlier account's token
     sat in localStorage outranking it — so the new sign-in produced the old
     account. */
  const b = browser({
    local: { svc_token: jwtFor(7), svc_user: JSON.stringify({ id: 7 }) },
    onFetch: async () => json({}),
  });
  const mine = jwtFor(42);
  b.Auth.setToken(mine, { id: 42, email: 'a@example.test' }, false);
  ok('the stale token is gone from localStorage',
     !b.localStorage.getItem('svc_token'), JSON.stringify(b.localStorage._dump()));
  ok('the stale user is gone with it',
     !b.localStorage.getItem('svc_user'), JSON.stringify(b.localStorage._dump()));
  ok('THE TOKEN IN HAND IS THE ONE RETURNED',
     b.Auth.getToken() === mine,
     'got ' + String(b.Auth.getToken()).slice(0, 24) + '… — the previous account outranked it');
  ok('and the person signed in is the one who signed in',
     (b.Auth.getUser() || {}).id === 42, JSON.stringify(b.Auth.getUser()));
}

/* ── 5. A refresh must not move the session ──────────────────────────── */
console.log('\nand a refresh does not outlive the tab it was issued in');
{
  /* "Remember me" unticked means the session dies with the tab. A refresh
     called setToken with no user, which defaulted to localStorage and
     quietly promoted it — leaving a live token on a shared phone for the
     next person. */
  const b = browser({
    session: { svc_token: jwtFor(42), svc_user: JSON.stringify({ id: 42 }) },
    onFetch: async () => json({}),
  });
  b.Auth.setToken(jwtFor(42));
  ok('it stays in sessionStorage', !!b.sessionStorage.getItem('svc_token'),
     JSON.stringify(b.sessionStorage._dump()));
  ok('and is NOT promoted to localStorage', !b.localStorage.getItem('svc_token'),
     JSON.stringify(b.localStorage._dump())
     + ' — a session-only login must not survive the tab closing');
}

/* ── 6. The email still carries no capability ────────────────────────── */
console.log('\nand the invitation email still carries no way in');
{
  const EMAIL = fs.readFileSync(path.join(ROOT, 'server', 'services', 'email.js'), 'utf8');
  const at = EMAIL.indexOf('function sendStokvelInvite');
  const fn = EMAIL.slice(at, EMAIL.indexOf('\n}', at));
  ok('the invite function was found', at > 0 && fn.length > 200);
  ok('the signed-in link is the plain portal, with no token on it',
     /\$\{BASE_URL\}\/portal\/\?view=groups/.test(fn)
     && !/token|jti|otp|magic/i.test(fn),
     'a link that signs somebody in is a link that can be forwarded');
}

/* ── 6b. And it points at the environment that sent it ───────────────── */
console.log('\nand a staging email does not send people to the live platform');
{
  /* The same report, one layer out. The invitation read "Staging has invited
     you" and linked to platform.svcapital.co.za, because BASE_URL falls back
     to production's address and NO environment sets it. A tester following
     that link left staging entirely and arrived on the live site, where the
     invitation does not exist and the browser is signed in as somebody else
     — "the link took me to another profile", and nothing on staging could
     ever explain it. */
  const vm = require('vm');
  const EMAIL = fs.readFileSync(path.join(ROOT, 'server', 'services', 'email.js'), 'utf8');
  const from = EMAIL.indexOf('const _railwayEnv');
  const to   = EMAIL.indexOf('const escHtml');
  ok('the base-url block was found', from > 0 && to > from,
     'a slice that missed it would assert nothing while passing');

  const resolve = env => {
    const ctx = { process: { env }, URL };
    vm.createContext(ctx);
    vm.runInContext(EMAIL.slice(from, to) + '\nthis.B = BASE_URL; this.H = BASE_HOST;', ctx);
    return { url: ctx.B, host: ctx.H };
  };

  const prod = resolve({ RAILWAY_ENVIRONMENT_NAME: 'production',
                         RAILWAY_PUBLIC_DOMAIN: 'svcapital-production.up.railway.app' });
  ok('PRODUCTION IS UNCHANGED', prod.url === 'https://platform.svcapital.co.za',
     prod.url + ' — production sets no BASE_URL either, so the fallback IS production');

  const stg = resolve({ RAILWAY_ENVIRONMENT_NAME: 'staging',
                        RAILWAY_PUBLIC_DOMAIN: 'svcapital-staging.up.railway.app' });
  ok('AND STAGING LINKS TO STAGING',
     stg.url === 'https://svcapital-staging.up.railway.app',
     stg.url + ' — this is the link that took a tester onto the live platform');

  const fd = resolve({ RAILWAY_ENVIRONMENT_NAME: 'Future Developments',
                       RAILWAY_PUBLIC_DOMAIN: 'svcapital-future-developments.up.railway.app' });
  ok('as does any other environment, with no variable to remember',
     fd.url === 'https://svcapital-future-developments.up.railway.app', fd.url);

  ok('an explicit BASE_URL still wins, which is how a custom domain is set',
     resolve({ BASE_URL: 'https://custom.example', RAILWAY_ENVIRONMENT_NAME: 'staging',
               RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }).url === 'https://custom.example');
  ok('and a machine with no Railway variables still gets production',
     resolve({}).url === 'https://platform.svcapital.co.za', resolve({}).url);

  /* The signature, which named the live host as plain text whatever the
     links said. */
  ok('the footer names the host it actually links to', stg.host === 'svcapital-staging.up.railway.app',
     stg.host + ' — a staging email claimed the live platform in its own signature');
  ok('and production\'s signature is unchanged',
     prod.host === 'platform.svcapital.co.za', prod.host);
  ok('the footer no longer hardcodes it',
     !/>platform\.svcapital\.co\.za<\/a>/.test(EMAIL), 'server/services/email.js');
}

/* ── 7. The screen says whose it is ──────────────────────────────────── */
console.log('\nand the groups screen says which account is looking at it');
{
  const CORE = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
  const at = CORE.indexOf('function _svWhoAmINote');
  const fn = at < 0 ? '' : CORE.slice(at, CORE.indexOf('\n}', at));
  ok('the note exists', fn.length > 200,
     'the recipient had no way to tell whose account they had landed in');
  ok('it names the signed-in address', /signed in as .{0,80}\$\{_esc\(email\)\}/s.test(fn),
     'the address is the one fact that settles it');
  ok('and offers the way out', /Auth\.logout\(/.test(fn) && /Not you\?/.test(fn), fn.slice(0, 200));
  ok('the address is escaped', /_esc\(email\)/.test(fn),
     'an address is user-supplied and lands in markup here');
  ok('it says nothing when nobody is signed in',
     /if \(!email\) return '';/.test(fn),
     'a note about the wrong account on the login screen helps nobody');
  ok('and the groups view renders it when no invitation is waiting',
     /\$\{invites\.length \? '' : _svWhoAmINote\(\)\}/.test(CORE),
     'the confusing case is arriving and finding nothing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
