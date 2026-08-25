/* Pins the Cache-Control contract for static assets.

   Version-stamped URLs (js/portal.js?v=98) are immutable by construction —
   CLAUDE.md requires the number to be bumped with every change — so they can
   be cached for a year. Everything else must keep revalidating.

   The dangerous mistakes this guards are all one-liners: caching HTML (which
   carries the version pointers), caching a file whose URL has no version, or
   failing to cache the versioned ones at all, which is where we started. */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 8108;
const ROOT = path.join(__dirname, '..');
const YEAR = 31536000;

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

// Follows one redirect: the app 301s /portal/index.html to /portal/, and the
// header that matters is the one on the page that actually gets served.
const head = (p, hops = 2) => new Promise(resolve => {
  const req = http.get({ port: PORT, path: p, timeout: 8000 }, res => {
    res.resume();
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
      const next = res.headers.location.replace(/^https?:\/\/[^/]+/, '');
      return resolve(head(next, hops - 1));
    }
    resolve({ status: res.statusCode, cc: res.headers['cache-control'] || '(none)' });
  });
  req.on('error', e => resolve({ status: 0, cc: e.message }));
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, cc: 'timeout' }); });
});

(async () => {
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'production', JWT_SECRET: 't' };
  delete env.DATABASE_URL;
  const srv = spawn(process.execPath, [path.join(ROOT, 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', d => out += d);
  srv.stderr.on('data', d => out += d);

  const up = await new Promise(resolve => {
    const t0 = Date.now();
    const tick = () => {
      if (out.includes('SV Capital server started')) return resolve(true);
      if (Date.now() - t0 > 25000) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
  if (!up) { console.log('  FAIL  server never came up\n' + out.slice(-1200)); srv.kill('SIGKILL'); process.exit(1); }

  const immutable = cc => cc.includes('immutable') && cc.includes(`max-age=${YEAR}`);
  const revalidates = cc => cc.includes('no-cache') || cc.includes('no-store');

  // Versioned assets: cache hard.
  for (const p of ['/portal/js/portal.js?v=98', '/portal/css/portal.css?v=4', '/css/ci-theme.css?v=1', '/js/api.js?v=13']) {
    const r = await head(p);
    check(`versioned asset cached immutably: ${p}`, r.status === 200 && immutable(r.cc), `HTTP ${r.status} ${r.cc}`);
  }

  // Same files without a version: must still revalidate, or the mobile service
  // worker's unversioned precache entries could pin a stale copy for a year.
  for (const p of ['/portal/js/portal.js', '/portal/css/portal.css']) {
    const r = await head(p);
    check(`unversioned asset still revalidates: ${p}`, r.status === 200 && revalidates(r.cc), `HTTP ${r.status} ${r.cc}`);
  }

  // HTML carries the version pointers — caching it defeats the whole scheme.
  for (const p of ['/portal/', '/portal/index.html', '/portal/index.html?v=1']) {
    const r = await head(p);
    check(`html never cached: ${p}`, r.status === 200 && revalidates(r.cc), `HTTP ${r.status} ${r.cc}`);
  }

  // A version on something that is not js/css must not unlock immutability.
  const img = await head('/assets/logo.png?v=1');
  check('non js/css ignores the version stamp', img.status === 200 && !immutable(img.cc), `HTTP ${img.status} ${img.cc}`);

  // Unversioned images keep their existing one-day policy.
  const img2 = await head('/assets/logo.png');
  check('images keep max-age=86400', img2.status === 200 && img2.cc.includes('max-age=86400'), `HTTP ${img2.status} ${img2.cc}`);

  srv.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 4000));
  if (srv.exitCode === null && srv.signalCode === null) srv.kill('SIGKILL');
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
