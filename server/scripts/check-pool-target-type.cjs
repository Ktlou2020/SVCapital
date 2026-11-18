#!/usr/bin/env node
/* Which date a pool actually needs.
 *
 * ASKED FOR: "When the target is an amount then no closing date is required,
 * the closing date is when the amount is met. The start must be optional as
 * well and will be manually added."
 *
 * A pool has one of two targets and the form asked for both regardless. It
 * hid the Target Amount on a date pool and left Close Date looking equally
 * expected either way, so an amount-goal pool — which closes when the money
 * is there, not on a date — appeared to need a date it has no use for.
 *
 *   amount goal   raises until the amount is met. No close date needed.
 *   closing date  the DATE is the target. Required, and refused without one:
 *                 a date pool with no close date has no target at all.
 *
 * WHAT THIS DOES NOT CLAIM. Nothing closes an amount-goal pool when its
 * target is reached — poolCyclerCron's sweep is `end_date IS NOT NULL`, and
 * no route caps an investment at target_amount or max_capacity. So a pool
 * left without a close date stays open past its target until somebody closes
 * it by hand. That is asserted below as the behaviour it currently is, not
 * as the behaviour anybody wants, so that the day it is implemented this
 * check fails and is updated deliberately rather than silently passing on a
 * sentence that stopped being true.
 *
 * Run: node server/scripts/check-pool-target-type.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const ADMIN_JS   = read('admin/js/admin.js');
const ADMIN_HTML = read('admin/index.html');
const CORE       = read('js/portal-core.js');
const CYCLER     = read('server/jobs/poolCyclerCron.js');

/* The rule, lifted out and run rather than restated. */
const ctx = {};
{
  const from = ADMIN_JS.indexOf('const POOL_TARGET_TYPES = {');
  const to   = ADMIN_JS.indexOf('function _syncPoolTargetType');
  const tail = ADMIN_JS.indexOf('async function saveNewPool');
  vm.createContext(ctx);
  vm.runInContext(ADMIN_JS.slice(from, to) + ADMIN_JS.slice(ADMIN_JS.indexOf('function _poolCloseDateError'), tail)
    + '\nthis.T = POOL_TARGET_TYPES; this.err = _poolCloseDateError;', ctx);
}

console.log('\nan amount-goal pool does not need a closing date');
{
  ok('the rule was found', !!ctx.T && !!ctx.err,
     'a slice that missed it would assert nothing while passing');
  ok('AMOUNT: a blank close date is accepted',
     ctx.err('amount', '') === null, String(ctx.err('amount', '')));
  ok('and so is one that is set, for a raise that must stop regardless',
     ctx.err('amount', '2026-12-31') === null,
     'leaving it optional is not the same as forbidding it');
  ok('the label says optional rather than looking required',
     /\(optional\)/.test(ctx.T.amount.closeLabel) && !/\*/.test(ctx.T.amount.closeLabel),
     ctx.T.amount.closeLabel);
  /* THE HINT AND THE CODE HAVE TO AGREE. For one commit this said "nothing
     closes it automatically", which was true then and would be a lie now;
     the auto-close exists, so the sentence has to say so. Asserted in both
     directions, because a hint that under-promises sends an operator
     hunting for a close date they do not need. */
  ok('and the hint says what happens if it is left blank',
     /stops raising by itself as soon as the target is met/i.test(ctx.T.amount.hint),
     ctx.T.amount.hint);
  ok('and does not still claim nothing closes it',
     !/Nothing closes it automatically/i.test(ctx.T.amount.hint), ctx.T.amount.hint);
}

console.log('\nwhile a closing-date pool is nothing without one');
{
  ok('DATE: a blank close date is refused',
     typeof ctx.err('date', '') === 'string', String(ctx.err('date', '')));
  ok('and the message says which setting to change instead',
     /Amount goal/.test(ctx.err('date', '')), ctx.err('date', ''));
  ok('a date that is set passes', ctx.err('date', '2026-12-31') === null);
  ok('the label carries the required mark', /\*/.test(ctx.T.date.closeLabel), ctx.T.date.closeLabel);
  /* An unknown value must land somewhere real rather than throwing. */
  ok('an unrecognised target type is treated as an amount goal',
     ctx.err('nonsense', '') === null,
     'a pool saved before the types existed must not be blocked from editing');
}

console.log('\nand both forms refuse it, on the way in and on the way out');
{
  /* THE RESULT HAS TO BE ACTED ON, not merely computed. The first version
     asserted the `const` existed, so deleting the line that reads it left
     the variable in place and the assertion passing — a form that worked out
     the right answer and saved anyway. The guard is what is asserted. */
  ok('the new-pool form refuses on it',
     /const newCloseErr = _poolCloseDateError\(/.test(ADMIN_JS)
     && /if \(newCloseErr\) \{ Toast\.error\(newCloseErr\); return; \}/.test(ADMIN_JS));
  ok('and the edit form refuses on it too',
     /const editCloseErr = _poolCloseDateError\(/.test(ADMIN_JS)
     && /if \(editCloseErr\) \{ Toast\.error\(editCloseErr\); return; \}/.test(ADMIN_JS),
     'clearing the close date of an existing date pool is the one edit that '
     + 'would quietly leave it with no target');
  ok('both read the one rule rather than keeping a copy',
     (ADMIN_JS.match(/_poolCloseDateError\(/g) || []).length === 3,
     'one definition and two call sites');
  ok('the hint and label are rendered from the table',
     /lbl\.innerHTML\s*=\s*t\.closeLabel/.test(ADMIN_JS)
     && /hint\.innerHTML\s*=\s*t\.hint/.test(ADMIN_JS));
  for (const w of ['new', 'edit']) {
    ok(`the ${w} form has somewhere to put them`,
       new RegExp(`id="${w}PoolCloseLabel"`).test(ADMIN_HTML)
       && new RegExp(`id="${w}PoolTargetHint"`).test(ADMIN_HTML));
    ok(`and the ${w} form follows the select as it changes`,
       new RegExp(`onchange="_syncPoolTargetType\\('${w}'\\)"`).test(ADMIN_HTML));
  }
  ok('an existing pool opens with the hint already written',
     /_syncPoolTargetType\('edit'\);/.test(ADMIN_JS),
     'a hint that appears only after you touch the select is no hint at all');
}

console.log('\nand the investment start date is optional on both');
{
  ok('neither form calls it automatic any more',
     !/Investment Start Date <span[^>]*>\(auto\)/.test(ADMIN_HTML),
     'it is the day the money is deployed, which is decided when it happens');
  ok('both call it optional',
     (ADMIN_HTML.match(/Investment Start Date <span[^>]*>\(optional\)/g) || []).length === 2,
     'the new pool form and the edit form');
  ok('and a blank one is still saved as null rather than today',
     /investment_start_date: document\.getElementById\('newPoolInvStartDate'\)\.value \|\| null/.test(ADMIN_JS),
     'a start date invented at save time is a deployment date nobody chose');
}

console.log('\nand a pool with no close date is not treated as expired');
{
  const from = CORE.indexOf('function _poolPastClose');
  const to   = CORE.indexOf('function _getOpenMarketplacePools');
  ok('the portal predicate was found', from > 0 && to > from);
  const c2 = { _poolEndMs: v => (v ? Date.parse(v) : null), Date };
  vm.createContext(c2);
  vm.runInContext(CORE.slice(from, to) + '\nthis.past = _poolPastClose;', c2);

  ok('A POOL WITH NO CLOSE DATE IS NEVER PAST CLOSE',
     c2.past({ end_date: null }) === false && c2.past({}) === false,
     'otherwise making the date optional would hide the pool from the marketplace '
     + 'the moment it was left blank');
  ok('while one whose date has passed still is',
     c2.past({ end_date: '2020-01-01' }) === true);
  ok('and one still to come is not',
     c2.past({ end_date: '2099-01-01' }) === false);
}

/* ── And the behaviour the hint now promises ─────────────────────────── */
console.log('\nand an amount pool really does stop raising when it is full');
{
  const TARGET = read('server/services/poolTarget.js');
  ok('there is one predicate for "full"', /const FULL = `/.test(TARGET),
     'the live path and the sweep must not disagree about it');
  ok('it only ever acts on a pool that is still open',
     /COALESCE\(status, ''\) = 'open'/.test(TARGET),
     'otherwise it would reopen the question every night for every pool');
  ok('only on an amount-goal pool',
     /COALESCE\(target_type, 'amount'\) = 'amount'/.test(TARGET),
     'a date pool stops on its date — that IS its target');
  ok('and only where a target was actually set',
     /COALESCE\(target_amount, 0\) > 0/.test(TARGET),
     'raised >= 0 is true of every pool on earth; without this the first '
     + 'sweep closes all of them');
  ok('it moves the pool to active, not closed',
     /SET status = 'active'/.test(TARGET) && !/SET status = 'closed'/.test(TARGET),
     "the cycler's own comment: closed is the end of the pool's life, after "
     + 'maturity, and cycleExpiredPools excludes it');

  /* The trap the cycler documented and this had to avoid. */
  const TABLES = read('server/routes/tables.js');
  /* Comments stripped: this file EXPLAINS the trap, so the word PATCH is
     in it on purpose and a bare search finds the explanation rather than a
     call. The lesson keeps recurring — a comment that quotes the thing it
     warns about will satisfy any assertion looking for that thing. */
  const targetCode = TARGET.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  ok('A PATCH TO active EMAILS THE WAITLIST, so this does not use one',
     /body\.status === 'active' \|\| body\.status === 'open'/.test(TABLES)
     && !/fetch\(|axios|require\('https?'\)|\/api\//.test(targetCode),
     'telling everyone waiting that a pool has opened, at the moment it '
     + 'filled, is the opposite of the news');
  ok('and writes the status with its own SQL',
     /UPDATE investment_pools/.test(targetCode) && /db\.query\(/.test(targetCode),
     targetCode.slice(0, 200));

  ok('the path that adds the money closes it in the same request',
     /closeIfTargetMet\(/.test(TABLES),
     'otherwise it is offered to everyone browsing until the next sweep');
  ok('and a failure there cannot fail the investment',
     /pool target check failed/.test(TABLES),
     'the money has already moved; the sweep closes it instead');
  ok('recording a past investment closes it too',
     /closeIfTargetMet\(/.test(read('server/services/historicalInvestment.js')));
  ok('and the nightly cycler sweeps the ones nothing called for',
     /sweepFullPools/.test(read('server/jobs/poolCyclerCron.js')),
     'a figure typed into raised_amount goes through no code at all');
  ok('the sweep runs after the two passes that can fill a pool',
     /await stopRaisingLapsedPools\(\);\s*\n[\s\S]{0,260}await sweepFullPools\(\);/
       .test(read('server/jobs/poolCyclerCron.js')),
     'a successor opened by the cycler should close on the same run if it fills');
  ok('and every close is written to the audit trail',
     /action: 'pool\.target_reached'/.test(TARGET),
     'a pool that stops taking money on its own needs a name and a time');
}


/* ── And the same thing against a real database ──────────────────────── */
async function againstDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log('\n  SKIP  DATABASE_URL not set — the behaviour half of this check needs one');
    return;
  }
  const { Pool } = require('pg');
  const SSL = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
  const DB  = 'chk_ptgt_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
  const withDb = (url, n) => { const u = new URL(url); u.pathname = '/' + n; return u.toString(); };

  let db;
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    db = new Pool({ connectionString: withDb(process.env.DATABASE_URL, DB), ssl: SSL, max: 4 });
    db.on('error', () => {});
    /* Only the columns this rule reads. The whole schema is not needed and
       building it would tie this check to every unrelated migration. */
    await db.query(`CREATE TABLE investment_pools (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, target_type TEXT,
      target_amount NUMERIC(18,2), raised_amount NUMERIC(18,2), updated_at TIMESTAMPTZ)`);

    const target = require(path.join(ROOT, 'server', 'services', 'poolTarget.js'));
    const add = (id, o) => db.query(
      `INSERT INTO investment_pools (id, name, status, target_type, target_amount, raised_amount)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, o.name || id, o.status || 'open', o.target_type === undefined ? 'amount' : o.target_type,
       o.target, o.raised]);
    const statusOf = async id =>
      (await db.query('SELECT status FROM investment_pools WHERE id = $1', [id])).rows[0].status;

    console.log('\nand against a real database, the money is what closes it');

    await add('P-UNDER', { target: 100000, raised: 99999.99 });
    await target.closeIfTargetMet(db, 'P-UNDER');
    ok('a cent short stays open', await statusOf('P-UNDER') === 'open',
       await statusOf('P-UNDER'));

    await add('P-EXACT', { target: 100000, raised: 100000 });
    const r = await target.closeIfTargetMet(db, 'P-EXACT');
    ok('EXACTLY ON TARGET STOPS RAISING', await statusOf('P-EXACT') === 'active',
       await statusOf('P-EXACT'));
    ok('and it says so to the caller', r.closed === true, JSON.stringify(r));

    await add('P-OVER', { target: 100000, raised: 150000 });
    await target.closeIfTargetMet(db, 'P-OVER');
    ok('and so does one already past it', await statusOf('P-OVER') === 'active');

    /* The investment that crosses the line is kept. Refusing it would reject
       a client mid-flow for being the one who filled the pool. */
    await add('P-CROSS', { target: 100000, raised: 0 });
    await db.query(`UPDATE investment_pools SET raised_amount = 120000 WHERE id = 'P-CROSS'`);
    await target.closeIfTargetMet(db, 'P-CROSS');
    ok('an investment that overshoots still lands, and then closes it',
       await statusOf('P-CROSS') === 'active');

    console.log('\nand it leaves alone everything that is not its business');
    await add('P-DATE', { target_type: 'date', target: 100000, raised: 200000 });
    await target.closeIfTargetMet(db, 'P-DATE');
    ok('A DATE POOL IS UNTOUCHED however full it is',
       await statusOf('P-DATE') === 'open',
       'its target is the date, not the money');

    await add('P-NOTARGET', { target: 0, raised: 500000 });
    await target.closeIfTargetMet(db, 'P-NOTARGET');
    ok('a pool with no target set is untouched',
       await statusOf('P-NOTARGET') === 'open',
       'raised >= 0 is true of every pool; this is what stops the sweep '
       + 'closing all of them');

    await add('P-NULLTYPE', { target_type: null, target: 100000, raised: 100000 });
    await target.closeIfTargetMet(db, 'P-NULLTYPE');
    ok('but a pool written before target_type existed counts as an amount pool',
       await statusOf('P-NULLTYPE') === 'active',
       'every other read in the codebase treats a missing one as "amount"');

    await add('P-MATURED', { status: 'matured', target: 100000, raised: 100000 });
    await target.closeIfTargetMet(db, 'P-MATURED');
    ok('and a pool that is not open is not reopened or restyled',
       await statusOf('P-MATURED') === 'matured');

    console.log('\nand closing is idempotent and one-way');
    const again = await target.closeIfTargetMet(db, 'P-EXACT');
    ok('closing a closed pool does nothing', again.closed === false,
       JSON.stringify(again));
    await db.query(`UPDATE investment_pools SET target_amount = 500000 WHERE id = 'P-EXACT'`);
    await target.sweep(db);
    ok('AND RAISING THE TARGET LATER DOES NOT REOPEN IT',
       await statusOf('P-EXACT') === 'active',
       'a pool that reopened itself because somebody edited a figure would '
       + 'start taking money again with nobody told');

    console.log('\nand the sweep finds the ones nothing called for');
    await add('P-SWEEP1', { target: 1000, raised: 1000 });
    await add('P-SWEEP2', { target: 1000, raised: 9999 });
    await add('P-SWEEP3', { target: 1000, raised: 999 });
    const s = await target.sweep(db);
    ok('it closes the full ones', await statusOf('P-SWEEP1') === 'active'
       && await statusOf('P-SWEEP2') === 'active');
    ok('and leaves the one still raising', await statusOf('P-SWEEP3') === 'open');
    ok('and reports how many it moved', s.closed >= 2, JSON.stringify(s.closed));
    const s2 = await target.sweep(db);
    ok('a second sweep moves nothing', s2.closed === 0, JSON.stringify(s2.closed));
  } finally {
    if (db) await db.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

againstDatabase()
  .catch(e => { fail++; console.log('  ✗ the database run failed\n      ' + e.message); })
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
