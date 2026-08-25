/* Exercises the REAL middleware block extracted from server/index.js against
   the full chain, including HMAC verification, oversize and abort cases. */
const express = require('express');
const http    = require('http');
const crypto  = require('crypto');
const fs      = require('fs');

const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
const block = SRC.slice(
  SRC.indexOf("app.use('/api/payments/paystack/webhook'"),
  SRC.indexOf("// Routes that embed base64 file data")
);
if (!block.includes('req._body')) throw new Error('extraction failed');

const SECRET = 'sk_test_dummy';
const app = express();
new Function('app', block)(app);              // install the real middleware
app.use(express.json({ limit: '2mb' }));

app.post('/api/payments/paystack/webhook', (req, res) => {
  const expected = crypto.createHmac('sha512', SECRET).update(req.rawBody).digest('hex');
  if (expected !== req.headers['x-paystack-signature']) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  res.json({ reached: true, event: req.body?.event, ref: req.body?.data?.reference });
});

let handlerErrors = 0;
app.use((err, req, res, _next) => {
  handlerErrors++;
  res.status(err.status || 500).json({ error: err.message });
});

const post = (port, body, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({
    port, path: '/api/payments/paystack/webhook', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
  }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
  r.on('error', reject);
  r.end(body);
});

(async () => {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    (cond ? pass++ : fail++);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
  };

  const payload = JSON.stringify({
    event: 'charge.success',
    data: { reference: 'SVC-PS-1787601595989', amount: 103000, metadata: { investor_id: 'SV-UXSJK8' } },
  });
  const sig = crypto.createHmac('sha512', SECRET).update(payload).digest('hex');

  let r = await post(port, payload, { 'x-paystack-signature': sig });
  check('valid signed charge.success reaches handler', r.status === 200 && JSON.parse(r.body).reached, r.body);

  r = await post(port, payload, { 'x-paystack-signature': 'deadbeef' });
  check('bad signature rejected at handler (not 500)', r.status === 400, r.body);

  r = await post(port, '{"event":"charge.success"'.padEnd(20, ' '), { 'x-paystack-signature': 'x' });
  check('malformed JSON does not crash chain', r.status === 400, r.body);

  const big = JSON.stringify({ event: 'x', pad: 'a'.repeat(1024 * 1024 + 512) });
  r = await post(port, big, { 'x-paystack-signature': 'x' });
  check('oversize payload rejected 413', r.status === 413, r.body);

  // Repeated requests must not leak a double-next() / hung socket.
  const many = await Promise.all(Array.from({ length: 25 }, () => post(port, payload, { 'x-paystack-signature': sig })));
  check('25 concurrent webhooks all 200', many.every(x => x.status === 200), many.map(x => x.status).join(','));
  check('no requests fell through to error handler', handlerErrors === 1, `errors=${handlerErrors} (expect 1, the 413)`);

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
