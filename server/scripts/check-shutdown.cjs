/* Reproduces the production shutdown signature.

   Railway logged "[SIGTERM] Graceful shutdown initiated…" and then nothing —
   no "HTTP server closed", no "DB pool closed" — followed by Postgres
   reporting "connection reset by peer" and the container stopping. That is
   server.close() never calling back and the platform SIGKILLing us.

   Node 20's close() already drops idle keep-alive sockets, so an idle socket
   does not reproduce it. A connection in the middle of a request does: close()
   waits for it indefinitely. Here that is a socket which sends partial headers
   and never finishes them.

   Without the closeAllConnections backstop this measures ~15s and no callback;
   with it, ~3s and a clean close. Railway's stop grace is 3-10s, so the
   difference is whether the pool drains or the process is killed mid-flight. */
const { spawn } = require('child_process');
const net  = require('net');
const path = require('path');

const PORT = 8104;
const ROOT = path.join(__dirname, '..');
const GRACE_CEILING_MS = 6000;   // must beat the platform's stop grace

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

(async () => {
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'production', JWT_SECRET: 't' };
  delete env.DATABASE_URL;   // exercise shutdown with the DB already unreachable

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
  if (!up) {
    console.log('  FAIL  server never came up\n' + out.slice(-1200));
    srv.kill('SIGKILL');
    process.exit(1);
  }

  // Open a connection and stall it mid-request: headers started, never ended.
  const stalled = net.connect(PORT, '127.0.0.1');
  stalled.on('error', () => {});
  await new Promise(r => stalled.once('connect', r));
  stalled.write('GET /api/health HTTP/1.1\r\nHost: localhost\r\n');
  await new Promise(r => setTimeout(r, 1200));
  check('a request-in-flight connection is open before SIGTERM', !stalled.destroyed, 'socket died early');

  const t0 = Date.now();
  srv.kill('SIGTERM');
  const exited = await new Promise(resolve => {
    const iv = setInterval(() => {
      if (srv.exitCode !== null || srv.signalCode !== null) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > 20000) { clearInterval(iv); resolve(false); }
    }, 100);
  });
  const took = Date.now() - t0;

  check('exits despite the stalled connection', exited, `still running after ${took}ms`);
  check(`exits inside the platform grace period (<${GRACE_CEILING_MS}ms)`, exited && took < GRACE_CEILING_MS, `took ${took}ms`);
  check('server.close() callback actually fired', out.includes('[shutdown] HTTP server closed'), out.slice(-500));
  check('shutdown reached the pool-close step', /\[shutdown\] (DB pool closed|DB pool close error)/.test(out), out.slice(-500));
  check('did not fall through to the force-exit timer',
    !out.includes('Forced exit after timeout'), 'force timer fired — close() still wedged');
  check('logged uptime and memory for restart attribution',
    /\[shutdown\] uptime \d+s · rss \d+MB/.test(out), out.slice(-500));

  try { stalled.destroy(); } catch (_) {}
  if (srv.exitCode === null && srv.signalCode === null) srv.kill('SIGKILL');
  console.log(`\n  ${pass} passed, ${fail} failed  (shutdown took ${took}ms)`);
  process.exit(fail ? 1 : 0);
})();
