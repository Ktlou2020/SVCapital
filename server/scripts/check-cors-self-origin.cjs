#!/usr/bin/env node
/* An instance has to allow the address it is served from.
 *
 * Every environment was expected to appear in a hand-kept list and the list
 * only ever had staging in it. So a new environment served its own sign-in
 * page and then refused the sign-in, with the browser naming the very host
 * the page had come from:
 *
 *   CORS: origin https://svcapital-future-developments.up.railway.app not allowed
 *
 * Production's own railway.app address was refused the same way. A list of
 * every environment's hostname is a list that is wrong the day the next
 * environment is created, so the instance reads its own from Railway instead.
 *
 * Driven against a real server rather than read: what matters is which
 * origins the shipped middleware accepts, and a regex proving the variable is
 * mentioned still passes after the value stops reaching the list.
 *
 * Run: node server/scripts/check-cors-self-origin.cjs
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 8119;
const ROOT = path.join(__dirname, '..', '..');
const SELF = 'svcapital-somewhere-new.up.railway.app';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const probe = (origin, p = '/api/products') => new Promise(resolve => {
  const req = http.get({ port: PORT, path: p, timeout: 8000, headers: { Origin: origin } }, res => {
    res.resume();
    resolve({ status: res.statusCode, allow: res.headers['access-control-allow-origin'] || null });
  });
  req.on('error', () => resolve({ status: 0, allow: null }));
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, allow: null }); });
});

(async () => {
  /* ALLOWED_ORIGINS deliberately does NOT mention SELF: that is the state a
     duplicated environment inherits, and the one that broke. */
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env,
      PORT: String(PORT), NODE_ENV: 'production', JWT_SECRET: 'check-cors-secret',
      ALLOWED_ORIGINS: 'https://platform.svcapital.co.za',
      RAILWAY_PUBLIC_DOMAIN: SELF,
      SEED_CATTLE_DEMO: '', SEED_CATTLE_DEMO_PASSWORD: '',
      DATABASE_URL: process.env.DATABASE_URL || 'postgresql://nobody@127.0.0.1:1/none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = () => { try { child.kill('SIGKILL'); } catch (_) {} };

  /* The server answers routes before the database is reachable, which is what
     this needs: CORS is decided in middleware, above any query. */
  for (let i = 0; i < 80; i++) {
    const r = await probe('https://platform.svcapital.co.za');
    if (r.status) break;
    await new Promise(r2 => setTimeout(r2, 250));
  }

  console.log('\nan instance allows the address it is served from');
  {
    const self = await probe(`https://${SELF}`);
    ok('its own Railway domain is allowed',
       self.allow === `https://${SELF}`,
       `Access-Control-Allow-Origin: ${self.allow}`);
    ok('even though ALLOWED_ORIGINS does not mention it',
       self.allow !== null,
       'a duplicated environment inherits somebody else’s list and refuses itself');
  }

  console.log('\nand still allows the ones it always did');
  {
    for (const o of ['https://platform.svcapital.co.za',
                     'https://svcapital-staging.up.railway.app',
                     'capacitor://localhost']) {
      const r = await probe(o);
      ok(`${o} is allowed`, r.allow === o, `Access-Control-Allow-Origin: ${r.allow}`);
    }
  }

  console.log('\nand refuses the ones it should');
  {
    /* The middle two are the point. An allowed origin EXTENDED by an
       attacker's domain is what a startsWith or an indexOf lets through, and
       it reads as a harmless relaxation in a diff. Origins are matched whole
       or not at all. */
    for (const o of ['https://evil.example.com',
                     `https://${SELF}.evil.com`,
                     'https://platform.svcapital.co.za.evil.com',
                     `https://evil.com?x=https://${SELF}`,
                     'http://svcapital-somewhere-new.up.railway.app']) {
      const r = await probe(o);
      ok(`${o} is refused`, r.allow === null, `Access-Control-Allow-Origin: ${r.allow}`);
    }
  }

  done();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
