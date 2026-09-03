#!/usr/bin/env node
/* Rewards: the ladder, the catalogue, and the leaderboard.
 *
 * THE HUB SHIPPED TWO MODULES THAT COULD NOT BE COMPLETED. LEARN_MODULES has
 * ten entries; the quest catalogue had eight. POST /complete answers 404 for a
 * quest id it does not know, so a client who read the two strategist modules
 * was told "Quest not found", was paid no XP, and could never finish the Hub.
 * Nothing connected the two lists, so nothing noticed. They are asserted
 * against each other here.
 *
 * The rest is about a leaderboard being auditable. investors.xp_points and
 * investors.xp_level are stored figures; quest_completions is what actually
 * happened. Either can drift from the other — an award written without a
 * completion row, a level set by hand — and a ranking that silently papers
 * over that is a ranking nobody can check. The endpoint reports the
 * disagreement instead of choosing a side, and that is asserted too.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-rewards.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
/* A name no other process can pick.
 *
 * A check failed intermittently with FATAL 57P01, "terminating connection due
 * to administrator command" — which in this suite only comes from
 * DROP DATABASE ... WITH (FORCE), confirmed by the forced checkpoint the
 * server logs immediately after it. Something dropped a database out from
 * under a running check.
 *
 * process.pid alone is not unique enough to rule that out: one suite run
 * spawns two hundred short-lived processes and a container recycles pids, so
 * two checks can pick the same database name minutes apart. The random suffix
 * costs nothing and removes the only way two processes can name the same
 * database. */
const DB_NAME = 'chk_rewards_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

/* The auth stub goes in BEFORE anything requires the router. The catalogue and
   ladder assertions below require quests.js, which requires the real auth
   middleware — once that is cached, installing the stub afterwards changes
   nothing and every request comes back 401. */
let CURRENT_USER = { id: 'ADM', email: 'a@example.test', role: 'admin' };
{
  const authPath = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, children: [], paths: [],
    exports: {
      requireAuth: (req, _res, next) => { req.user = CURRENT_USER; next(); },
      requireRole: (...roles) => (req, res, next) =>
        roles.includes(req.user && req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' }),
    },
  };
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ── The two lists that have to agree ──────────────────────────────────── */
console.log('\nthe Learning Hub and the quest catalogue');
{
  const quests = require(path.join(ROOT, 'server', 'routes', 'quests.js'));
  const CAT    = quests.QUESTS || [];
  const learningQuests = CAT.filter(q => q.category === 'learning').map(q => q.id).sort();

  /* LEARN_MODULES is client-side and duplicated across the two portal bundles.
     Read from the web copy; check-portal-split holds the copies together. */
  const portal = fs.readFileSync(path.join(ROOT, 'portal', 'js', 'portal.js'), 'utf8');
  const at  = portal.indexOf('const LEARN_MODULES = [');
  const end = portal.indexOf('const LEARN_TRACKS', at);
  const chunk = at > -1 ? portal.slice(at, end) : '';
  const modules = [...chunk.matchAll(/id:\s*'([a-z0-9_]+)'/g)].map(m => m[1]).sort();

  ok('the Learning Hub was found', modules.length > 0, 'LEARN_MODULES not located');
  ok('every module a client can read is a quest they can be paid for',
     modules.every(m => learningQuests.includes(m)),
     `missing from the catalogue: ${modules.filter(m => !learningQuests.includes(m)).join(', ')} — ` +
     `POST /complete answers 404 for an id it does not know, so the module is unfinishable`);
  ok('and every learning quest is a module a client can actually reach',
     learningQuests.every(q => modules.includes(q)),
     `in the catalogue but not in the Hub: ${learningQuests.filter(q => !modules.includes(q)).join(', ')}`);
  ok('the two lists are the same length',
     modules.length === learningQuests.length,
     `${modules.length} modules vs ${learningQuests.length} learning quests`);

  const dupes = CAT.map(q => q.id).filter((id, i, a) => a.indexOf(id) !== i);
  ok('no quest id appears twice in the catalogue', dupes.length === 0, dupes.join(', '));
}

/* ── The ladder ───────────────────────────────────────────────────────── */
console.log('\nthe XP ladder');
{
  const { XP_LEVELS, getLevelForXP } = require(path.join(ROOT, 'server', 'routes', 'quests.js'));
  ok('it starts at zero', XP_LEVELS[0].min === 0, String(XP_LEVELS[0].min));
  ok('and only ever climbs',
     XP_LEVELS.every((l, i) => i === 0 || l.min > XP_LEVELS[i - 1].min),
     JSON.stringify(XP_LEVELS.map(l => l.min)));
  ok('a client on exactly a threshold is on that level',
     XP_LEVELS.every(l => getLevelForXP(l.min).id === l.id));
  ok('and one XP short of it is not',
     XP_LEVELS.slice(1).every(l => getLevelForXP(l.min - 1).id !== l.id));
  ok('nobody falls off the top',
     getLevelForXP(10 ** 9).id === XP_LEVELS[XP_LEVELS.length - 1].id);
}

/* ── The endpoint ─────────────────────────────────────────────────────── */
function withDatabase(url, name) {
  const u = new URL(url); u.pathname = '/' + name; return u.toString();
}
/* max: 2 — these checks are single-threaded and never need more; the pg
   default is 10 per pool and this file opens two.

   This was originally introduced as a fix for an intermittent failure, on the
   theory that idle connections were exhausting max_connections. That theory
   was WRONG: the server log carries not one "sorry, too many clients already"
   in the whole session. The real error was FATAL 57P01, a forced DROP
   DATABASE terminating a live connection. The cap is kept because it is
   correct on its own terms, not because it fixed anything. */
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool;

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  const url = withDatabase(process.env.DATABASE_URL, DB_NAME);
  process.env.DATABASE_URL = url;
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  pool = new Pool({ connectionString: url, ssl: SSL, max: 2 });
}

/* Four clients, arranged so rank, ties and drift all have something to be
   wrong about:
     RW-1  1200 XP  → Harvester, 3 quests inc. 2 learning
     RW-2  1200 XP  → Harvester, ties with RW-1 but got there later
     RW-3     0 XP  → Seed, has read nothing
     RW-4   400 XP  → Grower, but investors.xp_level says 'luminary' (drift)
   RW-5 is archived and must not appear at all. */
async function seed() {
  await pool.query(`DELETE FROM quest_completions WHERE investor_id LIKE 'RW-%'`);
  await pool.query(`DELETE FROM investments       WHERE id LIKE 'RW-%'`);
  await pool.query(`DELETE FROM investment_pools  WHERE id LIKE 'RW-%'`);
  await pool.query(`DELETE FROM investors         WHERE id LIKE 'RW-%'`);

  await pool.query(`
    INSERT INTO investors (id,first_name,last_name,email,status,kyc_status,total_invested,xp_points,xp_level,date_joined)
    VALUES ('RW-1','Ann','First','ann@example.test','active','verified',50000,1200,'harvester', NOW() - INTERVAL '100 days'),
           ('RW-2','Bea','Tied','bea@example.test','active','verified',10000,1200,'harvester', NOW() - INTERVAL '90 days'),
           ('RW-3','Cal','Quiet','cal@example.test','active','pending',    0,   0,'seed',      NOW() - INTERVAL '10 days'),
           ('RW-4','Dee','Drift','dee@example.test','active','verified', 5000, 400,'luminary',  NOW() - INTERVAL '50 days'),
           ('RW-5','Eve','Gone','eve@example.test','archived','verified',   0,   0,'seed',      NOW() - INTERVAL '5 days')`);

  const C = [
    ['RW-1', 'learn_what_is_svc', 50, '30 days'],
    ['RW-1', 'learn_how_returns', 50, '20 days'],
    ['RW-1', 'complete_profile',  75, '40 days'],
    ['RW-2', 'learn_what_is_svc', 50, '10 days'],
    /* A completion for an id that is not in the catalogue: it happened, it was
       paid, and it must still be reported. */
    ['RW-4', 'learn_retired_topic', 25, '15 days'],
  ];
  /* The migrated shape: real investments, a blank investors.total_invested.
     These clients are not new — they have years behind them — and the stored
     column is the one thing that does not know it. */
  await pool.query(`
    INSERT INTO investment_pools (id,name,product_type,status,annual_rate,term_months,
        start_date,end_date,maturity_date,min_investment)
    VALUES ('RW-P1','Short Term Investment - Legacy','short_term','matured',0.13,12,
            CURRENT_DATE-400, CURRENT_DATE-40, CURRENT_DATE-40, 500)`);
  await pool.query(`
    INSERT INTO investments (id,investor_id,pool_id,pool_name,amount,status,start_date,end_date,
        annual_rate,term_months,expected_return,actual_return,product_type,maturity_instruction)
    VALUES ('RW-I1','RW-3','RW-P1','Short Term Investment - Legacy',75000,'matured',
            CURRENT_DATE-400, CURRENT_DATE-40, 0.13,12,0,0,'short_term','reinvest'),
           ('RW-I2','RW-3','RW-P1','Short Term Investment - Legacy',9999,'cancelled',
            CURRENT_DATE-400, CURRENT_DATE-40, 0.13,12,0,0,'short_term','reinvest')`);

  for (const [who, quest, xp, ago] of C) {
    await pool.query(
      `INSERT INTO quest_completions (id,investor_id,quest_id,xp_awarded,completed_at)
       VALUES ($1,$2,$3,$4, NOW() - $5::interval)`,
      [`${who}-${quest}`, who, quest, xp, ago]);
  }
}

function serve() {
  const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
  /* Re-required so it binds to the scratch database this check just built,
     rather than the pool it captured when the ladder was read above. */
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'routes', 'quests.js'))];
  const app = express();
  app.use(express.json());
  app.use('/api/quests', require(path.join(ROOT, 'server', 'routes', 'quests')));
  return new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

const get = (port, url) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: url }, res => {
    let b = ''; res.on('data', d => (b += d));
    res.on('end', () => {
      let body; try { body = JSON.parse(b); } catch (_) { body = { _raw: b.slice(0, 200) }; }
      resolve({ status: res.statusCode, body });
    });
  }).on('error', reject);
});

(async () => {
  let srv;
  try {
    await makeDatabase();
    await seed();
    srv = await serve();
    const port = srv.address().port;

    const { status, body: d } = await get(port, '/api/quests/leaderboard');
    console.log('\nthe leaderboard');
    ok('answers', status === 200, `${status} ${JSON.stringify(d).slice(0, 160)}`);
    if (status !== 200) throw new Error('cannot continue');

    const by = Object.fromEntries(d.investors.map(i => [i.id, i]));

    ok('an archived client is not ranked',
       !by['RW-5'], 'archived accounts are not in the game');

    console.log('\nranking');
    ok('the highest score is first',
       by['RW-1'].rank === 1, `RW-1 rank ${by['RW-1'].rank}`);
    ok('a tie shares the rank rather than inventing an order',
       by['RW-2'].rank === 1,
       `RW-2 rank ${by['RW-2'].rank} — both are on 1200 XP`);
    ok('and the next score takes the rank after the tied pair',
       by['RW-4'].rank === 3,
       `RW-4 rank ${by['RW-4'].rank} — two clients are ahead, so this is third, not second`);
    ok('a client who has earned nothing is still listed',
       !!by['RW-3'] && by['RW-3'].xp === 0,
       'they are the ones worth chasing');

    console.log('\ninvested is the lifetime figure, not the stored column');
    ok('a client with investments but a blank stored total is not shown as R0',
       by['RW-3'].total_invested === 75000,
       `${by['RW-3'].total_invested} — investors.total_invested is 0 on migrated ` +
       `accounts, and reading it alone put R 0,00 beside clients who had earned ` +
       `the R10k, R50k and R100k badges on the same page`);
    ok('and a cancelled investment is not counted as money placed',
       by['RW-3'].total_invested === 75000,
       'the 9 999 cancelled row must not be in the total');
    ok('a stored total higher than the ledger still wins',
       by['RW-1'].total_invested === 50000,
       `${by['RW-1'].total_invested} — the stored column is a lifetime total that ` +
       `maturity never reduces, so it can legitimately exceed the open ledger`);

    console.log('\nlevels come from the XP, not from the stored column');
    ok('1200 XP is Harvester', by['RW-1'].level_id === 'harvester', by['RW-1'].level_id);
    ok('400 XP is Grower',     by['RW-4'].level_id === 'grower',    by['RW-4'].level_id);
    ok('and a stored level that disagrees is FLAGGED, not obeyed',
       by['RW-4'].level_drifted === true && by['RW-4'].stored_level === 'luminary',
       `drifted=${by['RW-4'].level_drifted} stored=${by['RW-4'].stored_level} — the row says ` +
       `luminary, the XP says grower; a leaderboard that silently picks one cannot be audited`);
    ok('a client whose stored level agrees is not flagged',
       by['RW-1'].level_drifted === false);
    ok('progress to the next level is a percentage of THIS level, not of the ladder',
       by['RW-4'].level_progress === Math.round((400 - 300) / (600 - 300) * 100),
       `${by['RW-4'].level_progress}% — 400 XP is a third of the way from Grower to Cultivator`);
    ok('and the top of the ladder reports no next level',
       d.levels.length > 0 && by['RW-1'].next_level !== undefined);

    console.log('\nlearning and quests');
    ok('learning modules are counted apart from other quests',
       by['RW-1'].learning_completed === 2 && by['RW-1'].quests_completed === 3,
       JSON.stringify({ l: by['RW-1'].learning_completed, q: by['RW-1'].quests_completed }));
    ok('the Hub total is the catalogue’s, not a number typed twice',
       d.learning_total === 10, String(d.learning_total));
    ok('XP that does not match the completions is flagged',
       by['RW-1'].xp_drifted === true && by['RW-1'].xp_from_quests === 175,
       `${by['RW-1'].xp_from_quests} awarded by quests vs ${by['RW-1'].xp} stored`);

    console.log('\nthe catalogue reports its own take-up');
    {
      const cat = Object.fromEntries(d.catalogue.map(q => [q.id, q]));
      ok('a quest two clients finished says so',
         cat['learn_what_is_svc'].completed_by === 2, String(cat['learn_what_is_svc'].completed_by));
      ok('and a quest nobody has finished is present with a zero',
         cat['learn_estate'] && cat['learn_estate'].completed_by === 0,
         'a quest nobody completes is the most useful row on the page');
      ok('a completion for an id no longer in the catalogue is reported, not dropped',
         (d.orphaned_quests || []).some(q => q.id === 'learn_retired_topic' && q.completed_by === 1),
         `${JSON.stringify(d.orphaned_quests)} — the XP was paid; hiding it makes the totals unexplainable`);
    }

    console.log('\nand it is not a client-facing endpoint');
    {
      CURRENT_USER = { id: 'INV', email: 'c@example.test', role: 'investor' };
      const asClient = await get(port, '/api/quests/leaderboard');
      ok('an investor cannot read the whole book’s standings',
         asClient.status === 403, `${asClient.status}`);
      const detail = await get(port, '/api/quests/investor/RW-1');
      ok('nor another client’s detail', detail.status === 403, `${detail.status}`);
      CURRENT_USER = { id: 'ADM', email: 'a@example.test', role: 'admin' };
    }

    console.log('\none client’s detail, for the console’s overview');
    {
      const { status: st, body: one } = await get(port, '/api/quests/investor/RW-1');
      ok('answers', st === 200, `${st}`);
      ok('with the same level the leaderboard gives',
         one.level_id === by['RW-1'].level_id, `${one.level_id} vs ${by['RW-1'].level_id}`);
      ok('and the completions, newest first',
         one.completions.length === 3 &&
         new Date(one.completions[0].completed_at) >= new Date(one.completions[2].completed_at),
         JSON.stringify(one.completions.map(c => c.quest_id)));
      ok('each named from the catalogue rather than shown as a raw id',
         one.completions.every(c => c.title && c.title !== c.quest_id));
      const missing = await get(port, '/api/quests/investor/NOPE');
      ok('an unknown client is a 404, not an empty scoreboard', missing.status === 404, `${missing.status}`);
    }

  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    if (srv) srv.close();
    if (pool) await pool.end().catch(() => {});
    try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
