/* js/api.js is loaded by the web portal, admin, ifa, the login pages AND the
   native app. It used to be forked into mobile/src/js/api.js, and that fork
   went stale: it lost ficaBadge (which mobile called, so the FICA panel threw),
   lost randShort, rendered R0 where the shared file rendered R0.00, and counted
   one fewer day remaining on every investment.

   The fork is gone. This guards the two things that replaced it: that the
   native-only behaviour still branches on __SVC_NATIVE__, and that the build
   really does serve the shared file to the app. */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT   = path.resolve(__dirname, '../..');
const SHARED = path.join(ROOT, 'js', 'api.js');
const BUILT  = path.join(ROOT, 'mobile', 'www', 'js', 'api.js');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

// ── the fork must stay gone ────────────────────────────────────────────────
check('no forked copy of api.js under mobile/src',
  !fs.existsSync(path.join(ROOT, 'mobile', 'src', 'js', 'api.js')),
  'mobile/src/js/api.js is back — the drift will start again');

check('the app is built with the shared api.js',
  fs.existsSync(BUILT) && fs.readFileSync(BUILT, 'utf8') === fs.readFileSync(SHARED, 'utf8'),
  'mobile/www/js/api.js differs from js/api.js — run mobile/scripts/build.js');

// ── load the real file into a DOM-ish sandbox, once per platform ───────────
function load(isNative) {
  const listeners = {};
  const nodes = [];
  const win = {
    __SVC_NATIVE__: isNative || undefined,
    location: { pathname: '/portal/', href: '/portal/' },
    matchMedia: () => ({ matches: false }),
    localStorage: { _d: {}, getItem(k){return this._d[k] ?? null;}, setItem(k,v){this._d[k]=String(v);}, removeItem(k){delete this._d[k];} },
    sessionStorage: { _d: {}, getItem(k){return this._d[k] ?? null;}, setItem(k,v){this._d[k]=String(v);}, removeItem(k){delete this._d[k];} },
    addEventListener(){}, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  };
  win.window = win;
  const el = () => ({
    id: '', className: '', style: { cssText: '' }, innerHTML: '', children: [],
    setAttribute(){}, appendChild(c){ this.children.push(c); },
    addEventListener(t,f){ listeners[t] = f; }, append(){}, remove(){},
  });
  win.document = {
    _byId: {},
    getElementById(id){ return this._byId[id] || null; },
    createElement(){ return el(); },
    body: {
      appendChild(n) {
        nodes.push(n);
        if (n.id) win.document._byId[n.id] = n;
        // A real DOM parses innerHTML into findable nodes; register any ids in
        // it so getElementById works for children (the overlay's button).
        for (const m of String(n.innerHTML || '').matchAll(/id="([^"]+)"/g)) {
          win.document._byId[m[1]] = el();
        }
      },
    },
    addEventListener(){}, querySelector(){ return null; },
  };
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(SHARED, 'utf8'), ctx, { filename: 'api.js' });
  // const/let declarations do not become properties of the context object, so
  // pull the bindings out with a trailing expression evaluated in the same scope.
  const api = vm.runInContext(
    '({ Utils, Auth, API, _svcPlatform, _showSessionExpiredOverlay })', ctx, { filename: 'bindings' });
  return { ctx: api, win, nodes };
}

// ── web ────────────────────────────────────────────────────────────────────
{
  const { ctx, win } = load(false);
  check('web: Utils.ficaBadge exists', typeof ctx.Utils.ficaBadge === 'function', 'missing');
  check('web: Utils.randShort exists', typeof ctx.Utils.randShort === 'function', 'missing');
  check('web: rand(null) is R0.00', ctx.Utils.rand(null) === 'R0.00', ctx.Utils.rand(null));
  check('web: platform tag is web', ctx._svcPlatform() === 'web', ctx._svcPlatform());

  // The overlay must exist but must not have been rendered on web.
  check('web: overlay helper is defined', typeof ctx._showSessionExpiredOverlay === 'function', 'missing');
  check('web: nothing rendered at load', Object.keys(win.document._byId).length === 0, 'rendered something');

  // Auth.clear must leave the portal cache alone — the web idle-logout path
  // deliberately keeps it so a re-login renders instantly instead of blank.
  win.localStorage.setItem('svc_portal_cache', '{"x":1}');
  win.localStorage.setItem('svc_token', 't');
  ctx.Auth.clear();
  check('web: clear() keeps svc_portal_cache (stuck-loading fix depends on it)',
    win.localStorage.getItem('svc_portal_cache') === '{"x":1}', 'cache was removed');
  check('web: clear() still drops the token', win.localStorage.getItem('svc_token') === null, 'token survived');
}

// ── native ─────────────────────────────────────────────────────────────────
{
  const { ctx, win } = load(true);
  check('native: same Utils are present', typeof ctx.Utils.ficaBadge === 'function' && typeof ctx.Utils.randShort === 'function', 'missing');
  check('native: rand(null) matches web', ctx.Utils.rand(null) === 'R0.00', ctx.Utils.rand(null));

  ctx._showSessionExpiredOverlay();
  const overlay = win.document._byId['_svcSessionExpired'];
  check('native: session-expired overlay renders', !!overlay, 'not rendered');
  check('native: overlay explains itself', !!overlay && /Session Expired/.test(overlay.innerHTML), 'no message');
  check('native: overlay offers a way back', !!overlay && /Log In Again/.test(overlay.innerHTML), 'no button');

  // Calling twice must not stack overlays.
  const before = Object.keys(win.document._byId).length;
  ctx._showSessionExpiredOverlay();
  check('native: overlay is not duplicated', Object.keys(win.document._byId).length === before, 'stacked');

  win.localStorage.setItem('svc_portal_cache', '{"x":1}');
  ctx.Auth.clear();
  check('native: clear() also keeps the cache (instant re-login render)',
    win.localStorage.getItem('svc_portal_cache') === '{"x":1}', 'cache was removed');
}

// ── both surfaces agree on the numbers that used to drift ──────────────────
{
  const w = load(false).ctx.Utils, n = load(true).ctx.Utils;
  const d = new Date(); d.setDate(d.getDate() + 3);
  const iso = x => x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0') + '-' + String(x.getDate()).padStart(2,'0');
  check('days remaining agrees across platforms', w.daysRemaining(iso(d)) === n.daysRemaining(iso(d)),
    `${w.daysRemaining(iso(d))} vs ${n.daysRemaining(iso(d))}`);
  check('currency agrees across platforms', w.rand(1234.5) === n.rand(1234.5), `${w.rand(1234.5)} vs ${n.rand(1234.5)}`);
  check('dates agree across platforms', w.date('2026-07-31') === n.date('2026-07-31'), `${w.date('2026-07-31')} vs ${n.date('2026-07-31')}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
