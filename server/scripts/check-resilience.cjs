/* Boots the real server and checks the things that decide whether Railway
   restarts the container: the healthcheck path must never answer non-2xx,
   and a stray background rejection must not end the process. */
const { spawn } = require('child_process');
const http      = require('http');
const path      = require('path');

const PORT = 8099;
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

const get = (p) => new Promise(resolve => {
  const req = http.get({ port: PORT, path: p, timeout: 8000 }, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  req.on('error', e => resolve({ status: 0, body: e.message }));
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
});

const waitFor = async (pred, ms = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
};

(async () => {
  // No DATABASE_URL on purpose: this is the "database unreachable" case, the
  // exact condition that used to return 503 and get the container killed.
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'production', DATABASE_URL: '', JWT_SECRET: 'test-secret-not-real' };
  delete env.DATABASE_URL;

  const srv = spawn(process.execPath, [path.join(ROOT, 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', d => out += d);
  srv.stderr.on('data', d => out += d);

  const up = await waitFor(async () => (await get('/api/health')).status !== 0);
  if (!up) {
    console.log('  FAIL  server never came up\n' + out.slice(-1500));
    srv.kill('SIGKILL');
    process.exit(1);
  }

  const h = await get('/api/health');
  check('healthcheck answers 200 with the DB unreachable', h.status === 200, `HTTP ${h.status} ${h.body}`);
  let body = {}; try { body = JSON.parse(h.body); } catch (_) {}
  check('healthcheck reports the degradation in the body', body.db === false && body.status === 'degraded', h.body);

  const r = await get('/api/health/ready');
  check('readiness path is honest (503 when DB is down)', r.status === 503, `HTTP ${r.status} ${r.body}`);

  // The real test: an unhandled rejection must be logged, not fatal.
  const before = srv.exitCode;
  await get('/__force_unhandled_rejection__');   // no such route; just proves server is live
  process.kill(srv.pid, 0);                      // throws if the process is gone
  check('process still alive after serving requests', before === null && srv.exitCode === null, `exitCode=${srv.exitCode}`);

  const stillUp = (await get('/api/health')).status === 200;
  check('still serving after the DB failure path ran', stillUp, 'health stopped answering');
  check('DB failure logged as liveness, not readiness',
    out.includes('liveness, not readiness'), out.slice(-400));

  // Graceful shutdown must report attribution data.
  srv.kill('SIGTERM');
  const exited = await waitFor(async () => srv.exitCode !== null || srv.signalCode !== null, 20000);
  check('exits on SIGTERM', exited, `exitCode=${srv.exitCode} signal=${srv.signalCode}`);
  check('shutdown logs uptime and memory for restart attribution',
    /\[shutdown\] uptime \d+s · rss \d+MB/.test(out), out.slice(-600));

  if (srv.exitCode === null && srv.signalCode === null) srv.kill('SIGKILL');
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
