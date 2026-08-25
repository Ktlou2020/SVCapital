/* Drives the real investments router against a real Postgres.

   The portal used to apply a pool-wide maturity instruction with Promise.all
   over the investments — one or two writes each, no transaction — so a failure
   partway left some carrying the new instruction and the rest on the old one,
   on the setting that decides whether money pays out or reinvests. The single
   investment path had the same flaw in miniature: the instruction was written,
   then the custom amount followed as a separate PATCH.

   Requires DATABASE_URL pointing at a scratch database. Creates and drops its
   own tables; never point it at anything real. */
'use strict';

const express = require('express');
const http    = require('http');
const path    = require('path');

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see scripts/check-maturity-instruction.cjs header');
  process.exit(0);
}

const pool = require(path.join(__dirname, '..', 'db', 'pool'));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

const INVESTOR = 'SV-TEST01';
const OTHER    = 'SV-TEST02';
const POOL     = 'POOL-TEST';

async function schema() {
  await pool.query(`DROP TABLE IF EXISTS investments, investors, audit_events CASCADE`);
  await pool.query(`
    CREATE TABLE investors (
      id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT
    );
    CREATE TABLE investments (
      id TEXT PRIMARY KEY,
      investor_id TEXT,
      pool_id TEXT,
      pool_name TEXT,
      amount NUMERIC(18,2) DEFAULT 0,
      actual_return_amount NUMERIC(18,2) DEFAULT 0,
      status TEXT DEFAULT 'active',
      end_date DATE,
      maturity_instruction TEXT,
      custom_payout_amount NUMERIC(18,2),
      switch_product_type TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE audit_events (
      id SERIAL PRIMARY KEY, actor_id TEXT, actor_email TEXT, actor_role TEXT,
      action TEXT, entity_type TEXT, entity_id TEXT, description TEXT,
      changes JSONB, ip_address TEXT, user_agent TEXT, platform TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function seed() {
  await pool.query(`DELETE FROM investments`);
  await pool.query(`DELETE FROM investors`);
  await pool.query(`INSERT INTO investors (id, first_name, last_name, email) VALUES
    ($1,'Test','Investor','test@example.invalid'), ($2,'Other','Person','other@example.invalid')`, [INVESTOR, OTHER]);
  const future = '2099-12-31';
  await pool.query(`INSERT INTO investments
      (id, investor_id, pool_id, pool_name, amount, actual_return_amount, status, end_date, maturity_instruction) VALUES
      ('INV-1',$1,$3,'Test Pool',1000, 100,'active',$4,'reinvest'),
      ('INV-2',$1,$3,'Test Pool',2000, 200,'active',$4,'reinvest'),
      ('INV-3',$1,$3,'Test Pool',3000,   0,'active',$4,'reinvest'),
      ('INV-4',$1,$3,'Test Pool',500,    0,'matured',$4,'reinvest'),
      ('INV-5',$2,$3,'Test Pool',9000,   0,'active',$4,'reinvest')`,
    [INVESTOR, OTHER, POOL, future]);
}

const state = async () => (await pool.query(
  `SELECT id, maturity_instruction, custom_payout_amount, switch_product_type FROM investments ORDER BY id`)).rows;

function buildApp(user) {
  const app = express();
  app.use(express.json());
  // Stand in for requireAuth: the router only reads req.user.
  const authMod = require.resolve(path.join(__dirname, '..', 'middleware', 'auth'));
  require.cache[authMod] = {
    id: authMod, filename: authMod, loaded: true, exports: {
      requireAuth: (req, _res, next) => { req.user = user(); next(); },
      requireRole: () => (req, _res, next) => next(),
    },
  };
  delete require.cache[require.resolve(path.join(__dirname, '..', 'routes', 'investments'))];
  app.use('/api/investments', require(path.join(__dirname, '..', 'routes', 'investments')));
  return app;
}

let CURRENT = { role: 'investor', investorId: INVESTOR, email: 'test@example.invalid', id: 'u1' };
const app = buildApp(() => CURRENT);
let server;

const post = (p, body) => new Promise(resolve => {
  const data = JSON.stringify(body);
  const req = http.request({ port: server.address().port, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => { let j = {}; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
  });
  req.on('error', e => resolve({ status: 0, body: { error: e.message } }));
  req.end(data);
});

(async () => {
  await schema();
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });

  // ── pool-wide, happy path ────────────────────────────────────────────────
  await seed();
  let r = await post(`/api/investments/pool/${POOL}/instruction`, { instruction: 'payout_all' });
  check('pool route is reachable, not shadowed by /:id/instruction', r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  check('reports how many it changed', r.body.updated === 3, JSON.stringify(r.body));
  let s = await state();
  check('applies to every active investment in the pool',
    s.filter(i => ['INV-1','INV-2','INV-3'].includes(i.id)).every(i => i.maturity_instruction === 'payout_all'),
    JSON.stringify(s));
  check('leaves a matured investment alone',
    s.find(i => i.id === 'INV-4').maturity_instruction === 'reinvest', JSON.stringify(s));
  check("never touches another investor's row in the same pool",
    s.find(i => i.id === 'INV-5').maturity_instruction === 'reinvest', JSON.stringify(s));

  // ── the whole point: all-or-nothing ──────────────────────────────────────
  await seed();
  // INV-1 is worth 1100 (1000 + 100 posted). 1500 exceeds it; INV-2 and INV-3
  // would have accepted it. Under the old client loop those two would have been
  // written before the third failed.
  r = await post(`/api/investments/pool/${POOL}/instruction`, { instruction: 'payout_custom', custom_payout_amount: 1500 });
  check('rejects when one investment cannot take the amount', r.status === 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  // The message has to be actionable: "exceeds the value" alone leaves the
  // client re-typing blind, and does not explain why 1500 looked reasonable.
  const plain = t => String(t || '').replace(/[\s\u00a0\u202f]/g, '');
  check('names the amount that was refused', plain(r.body.error).includes('R1500,00'), r.body.error);
  check('names the smallest ceiling in the pool (INV-1 at 1100)', plain(r.body.error).includes('R1100,00'), r.body.error);
  check('explains that the amount lands on each investment', /each investment/i.test(r.body.error || ''), r.body.error);
  s = await state();
  check('ALL-OR-NOTHING: no investment changed on that rejection',
    s.filter(i => i.investor_id !== OTHER).every(i => i.maturity_instruction === 'reinvest')
      && s.every(i => i.custom_payout_amount === null),
    JSON.stringify(s));

  // ── companion fields land in the same write ──────────────────────────────
  await seed();
  r = await post(`/api/investments/pool/${POOL}/instruction`, { instruction: 'custom_switch', custom_payout_amount: 100, switch_product_type: 'cattle' });
  s = await state();
  check('custom amount and switch target written with the instruction',
    r.status === 200 && s.filter(i => ['INV-1','INV-2','INV-3'].includes(i.id))
      .every(i => i.maturity_instruction === 'custom_switch' && Number(i.custom_payout_amount) === 100 && i.switch_product_type === 'cattle'),
    JSON.stringify(s));

  // ── incoherent combinations refused outright ─────────────────────────────
  await seed();
  for (const [label, body] of [
    ['payout_custom with no amount',   { instruction: 'payout_custom' }],
    ['payout_custom with zero',        { instruction: 'payout_custom', custom_payout_amount: 0 }],
    ['payout_custom with negative',    { instruction: 'payout_custom', custom_payout_amount: -5 }],
    ['switch_product with no target',  { instruction: 'switch_product' }],
    ['an instruction that is not one', { instruction: 'drop_tables' }],
  ]) {
    const rr = await post(`/api/investments/pool/${POOL}/instruction`, body);
    check(`refuses ${label}`, rr.status === 400, `HTTP ${rr.status} ${JSON.stringify(rr.body)}`);
  }
  s = await state();
  check('none of those refusals wrote anything',
    s.every(i => i.maturity_instruction === 'reinvest'), JSON.stringify(s));

  // ── single-investment path writes extras atomically too ──────────────────
  await seed();
  r = await post('/api/investments/INV-1/instruction', { instruction: 'payout_custom', custom_payout_amount: 250 });
  s = await state();
  const one = s.find(i => i.id === 'INV-1');
  check('single investment: instruction and amount in one write',
    r.status === 200 && one.maturity_instruction === 'payout_custom' && Number(one.custom_payout_amount) === 250,
    JSON.stringify(one));
  check('single investment: does not touch its pool siblings',
    s.find(i => i.id === 'INV-2').maturity_instruction === 'reinvest', JSON.stringify(s));

  await seed();
  r = await post('/api/investments/INV-1/instruction', { instruction: 'payout_custom' });
  s = await state();
  check('single investment: refuses payout_custom with no amount', r.status === 400, `HTTP ${r.status}`);
  check('single investment: nothing written on refusal',
    s.find(i => i.id === 'INV-1').maturity_instruction === 'reinvest', JSON.stringify(s));

  // ── over-ceiling on a single investment names both figures ───────────────
  await seed();
  r = await post('/api/investments/INV-1/instruction', { instruction: 'payout_custom', custom_payout_amount: 5000 });
  check('single investment: over-ceiling refused', r.status === 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  check('single investment: names the amount and the ceiling',
    plain(r.body.error).includes('R5000,00') && plain(r.body.error).includes('R1100,00'), r.body.error);
  s = await state();
  check('single investment: nothing written when over ceiling',
    s.find(i => i.id === 'INV-1').maturity_instruction === 'reinvest', JSON.stringify(s));

  // ── ownership ────────────────────────────────────────────────────────────
  await seed();
  CURRENT = { role: 'investor', investorId: OTHER, email: 'other@example.invalid', id: 'u2' };
  r = await post('/api/investments/INV-1/instruction', { instruction: 'payout_all' });
  check("cannot set another investor's instruction", r.status === 403, `HTTP ${r.status}`);
  r = await post(`/api/investments/pool/${POOL}/instruction`, { instruction: 'payout_all' });
  s = await state();
  check('pool route scopes to the caller, not the pool',
    r.body.updated === 1 && s.find(i => i.id === 'INV-1').maturity_instruction === 'reinvest'
      && s.find(i => i.id === 'INV-5').maturity_instruction === 'payout_all',
    JSON.stringify(s));
  CURRENT = { role: 'investor', investorId: INVESTOR, email: 'test@example.invalid', id: 'u1' };

  // ── cutoff ───────────────────────────────────────────────────────────────
  await seed();
  await pool.query(`UPDATE investments SET end_date = '2020-01-01' WHERE id = 'INV-2'`);
  r = await post(`/api/investments/pool/${POOL}/instruction`, { instruction: 'payout_all' });
  check('one past-cutoff investment blocks the whole pool', r.status === 403 && r.body.code === 'INSTRUCTION_CUTOFF', `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  s = await state();
  check('nothing written when the cutoff blocks it',
    s.filter(i => i.investor_id !== OTHER).every(i => i.maturity_instruction === 'reinvest'), JSON.stringify(s));

  // Staff bypass the cutoff.
  CURRENT = { role: 'admin', investorId: null, email: 'admin@example.invalid', id: 'a1' };
  r = await post(`/api/investments/pool/${POOL}/instruction`, { instruction: 'payout_all', investor_id: INVESTOR });
  check('staff may set it past the cutoff on behalf of an investor', r.status === 200 && r.body.updated === 3, `HTTP ${r.status} ${JSON.stringify(r.body)}`);

  // ── empty pool ───────────────────────────────────────────────────────────
  r = await post('/api/investments/pool/POOL-NOPE/instruction', { instruction: 'payout_all', investor_id: INVESTOR });
  check('unknown pool is a 404, not a silent success', r.status === 404, `HTTP ${r.status}`);

  server.close();
  await pool.end().catch(() => {});
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
