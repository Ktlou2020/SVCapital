/* Drives the real quests + referrals routers against a real Postgres.

   Four Earn Rewards badges were unreachable or wrong:

     milestone_10k / 50k / 100k — the server verified against SUM(amount) over
       status='active' only. The badges read as lifetime achievements, and the
       portal's own condition uses investors.total_invested, which is
       cumulative. So an investor whose money had matured was told by the UI
       that they qualified and refused by the server every time.

     set_maturity   — never verified, and nothing ever asked to complete it.
     first_referral — the same, and the portal could not evaluate it anyway
       since it never loads anyone else's investor record.

   Requires DATABASE_URL pointing at a scratch database. Creates and drops its
   own tables; never point it at anything real. */
'use strict';

const express = require('express');
const http    = require('http');
const path    = require('path');

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see scripts/check-quests.cjs header');
  process.exit(0);
}

const pool = require(path.join(__dirname, '..', 'db', 'pool'));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  <- ${detail}`}`);
};

const INV   = 'SV-Q1';
const FRIEND= 'SV-Q2';
const CODE  = 'SVCQ1X';

async function schema() {
  await pool.query(`DROP TABLE IF EXISTS quest_completions, investments, investors CASCADE`);
  await pool.query(`
    CREATE TABLE investors (
      id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT,
      status TEXT DEFAULT 'active', fica_status TEXT, date_joined TIMESTAMPTZ DEFAULT NOW(),
      wallet_balance NUMERIC(18,2) DEFAULT 0, total_invested NUMERIC(18,2) DEFAULT 0,
      xp_points INT DEFAULT 0, xp_level TEXT DEFAULT 'seed', investor_profile JSONB DEFAULT '{}',
      referral_code TEXT, referred_by TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE investments (
      id TEXT PRIMARY KEY, investor_id TEXT, pool_id TEXT, product_type TEXT,
      amount NUMERIC(18,2) DEFAULT 0, status TEXT DEFAULT 'active',
      maturity_instruction TEXT
    );
    CREATE TABLE quest_completions (
      id TEXT PRIMARY KEY, investor_id TEXT, quest_id TEXT, xp_awarded INT,
      data JSONB, completed_at TIMESTAMPTZ DEFAULT NOW()
    );`);
}

/* An investor whose R60,000 has fully matured — the case that was refused. */
async function seedMatured() {
  await pool.query('DELETE FROM quest_completions');
  await pool.query('DELETE FROM investments');
  await pool.query('DELETE FROM investors');
  await pool.query(`INSERT INTO investors (id, first_name, last_name, email, total_invested, referral_code)
                    VALUES ($1,'Thandi','M','q1@example.invalid', 60000, $2)`, [INV, CODE]);
  await pool.query(`INSERT INTO investments (id, investor_id, pool_id, product_type, amount, status)
                    VALUES ('I1',$1,'P1','cattle',60000,'matured')`, [INV]);
}

function buildApp() {
  const app = express();
  app.use(express.json());
  const authMod = require.resolve(path.join(__dirname, '..', 'middleware', 'auth'));
  require.cache[authMod] = { id: authMod, filename: authMod, loaded: true, exports: {
    requireAuth: (req, _res, next) => { req.user = { role: 'investor', investorId: INV, sub: INV, email: 'q1@example.invalid', id: 'u1' }; next(); },
    requireRole: () => (_q, _r, n) => n(),
  }};
  for (const m of ['quests', 'referrals']) delete require.cache[require.resolve(path.join(__dirname, '..', 'routes', m))];
  app.use('/api/quests',    require(path.join(__dirname, '..', 'routes', 'quests')));
  app.use('/api/referrals', require(path.join(__dirname, '..', 'routes', 'referrals')));
  return app;
}

let server;
const req = (method, p, body) => new Promise(resolve => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ port: server.address().port, path: p, method,
    headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => { let j = {}; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
  });
  r.on('error', e => resolve({ status: 0, body: { error: e.message } }));
  if (data) r.write(data);
  r.end();
});
const done = async () => (await pool.query('SELECT quest_id FROM quest_completions ORDER BY quest_id')).rows.map(r => r.quest_id);

(async () => {
  await schema();
  server = await new Promise(r => { const s = buildApp().listen(0, () => r(s)); });

  // ── lifetime milestones ──────────────────────────────────────────────────
  await seedMatured();
  let r = await req('POST', '/api/quests/complete', { questId: 'milestone_50k' });
  check('R50,000 milestone granted after the money matured', r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  check('  and recorded', (await done()).includes('milestone_50k'), 'not recorded');

  await seedMatured();
  r = await req('POST', '/api/quests/complete', { questId: 'milestone_100k' });
  check('R100,000 still refused at R60,000 lifetime', r.status === 403, `HTTP ${r.status}`);

  // Ledger-only investor (migrated in with no running total).
  await seedMatured();
  await pool.query('UPDATE investors SET total_invested = 0 WHERE id = $1', [INV]);
  r = await req('POST', '/api/quests/complete', { questId: 'milestone_50k' });
  check('ledger alone is enough when total_invested is missing', r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);

  // Cancelled investments must not count.
  await seedMatured();
  await pool.query(`UPDATE investors SET total_invested = 0 WHERE id = $1`, [INV]);
  await pool.query(`UPDATE investments SET status = 'cancelled' WHERE investor_id = $1`, [INV]);
  r = await req('POST', '/api/quests/complete', { questId: 'milestone_50k' });
  check('a cancelled investment does not earn a milestone', r.status === 403, `HTTP ${r.status}`);

  // ── set_maturity ─────────────────────────────────────────────────────────
  await seedMatured();
  r = await req('POST', '/api/quests/complete', { questId: 'set_maturity' });
  check('set_maturity refused with no instruction set', r.status === 403, `HTTP ${r.status}`);

  await seedMatured();
  await pool.query(`UPDATE investments SET maturity_instruction = 'reinvest' WHERE investor_id = $1`, [INV]);
  r = await req('POST', '/api/quests/complete', { questId: 'set_maturity' });
  check('set_maturity granted once an instruction exists', r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  check('  and recorded', (await done()).includes('set_maturity'), 'not recorded');

  await seedMatured();
  await pool.query(`UPDATE investments SET maturity_instruction = '' WHERE investor_id = $1`, [INV]);
  r = await req('POST', '/api/quests/complete', { questId: 'set_maturity' });
  check('an empty instruction does not count', r.status === 403, `HTTP ${r.status}`);

  // ── first_referral ───────────────────────────────────────────────────────
  await seedMatured();
  r = await req('POST', '/api/quests/complete', { questId: 'first_referral' });
  check('first_referral refused with nobody referred', r.status === 403, `HTTP ${r.status}`);

  let g = await req('GET', '/api/quests/my');
  check('quests report referralCount 0', g.body.referralCount === 0, JSON.stringify(g.body.referralCount));

  await pool.query(`INSERT INTO investors (id, first_name, last_name, email, referred_by, total_invested, status)
                    VALUES ($1,'Sipho','N','q2@example.invalid',$2, 5000, 'active')`, [FRIEND, CODE]);
  r = await req('POST', '/api/quests/complete', { questId: 'first_referral' });
  check('first_referral granted once a friend signs up', r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  check('  and recorded', (await done()).includes('first_referral'), 'not recorded');

  g = await req('GET', '/api/quests/my');
  check('quests report referralCount 1 so the portal can see it', g.body.referralCount === 1, JSON.stringify(g.body.referralCount));

  // ── referrals endpoint ───────────────────────────────────────────────────
  const ref = await req('GET', '/api/referrals/my');
  check('referrals endpoint returns the code', ref.body.code === CODE, JSON.stringify(ref.body.code));
  check('counts the signup', ref.body.total === 1 && ref.body.invested === 1, JSON.stringify(ref.body));
  check('names the referred investor', ref.body.referrals?.[0]?.firstName === 'Sipho', JSON.stringify(ref.body.referrals));
  check("does not leak another investor's balance",
    ref.body.referrals?.[0]?.invested === true && !('total_invested' in (ref.body.referrals?.[0] || {})),
    JSON.stringify(ref.body.referrals?.[0]));

  /* Registration must not create money for a referral. Testing the full
     register flow needs the whole users/investors/session apparatus; asserting
     on the route source is enough to stop the cash path being reinstated by
     accident, which is the actual risk. */
  const authSrc = require('fs').readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  check('registration no longer writes a referral_bonus transaction',
    !/INSERT INTO transactions[\s\S]{0,400}referral_bonus/.test(authSrc), 'the cash bonus insert is back');
  check('registration awards referral XP instead',
    /REFERRAL_XP/.test(authSrc) && /xp_points\s*=/.test(authSrc), 'no XP award found');

  // ── the programme pays points, not cash ──────────────────────────────────
  check('referrals endpoint reports points per referral', ref.body.pointsPerReferral === 100, JSON.stringify(ref.body.pointsPerReferral));
  check('and total points earned', ref.body.pointsEarned === 100, JSON.stringify(ref.body.pointsEarned));
  check('no rand figure is returned anywhere in the payload',
    !/bonus|amount|rand/i.test(JSON.stringify(ref.body)), JSON.stringify(ref.body));

  // Idempotency still holds.
  r = await req('POST', '/api/quests/complete', { questId: 'first_referral' });
  check('a completed quest cannot be claimed twice', r.status === 409, `HTTP ${r.status}`);

  server.close();
  await pool.end().catch(() => {});
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
