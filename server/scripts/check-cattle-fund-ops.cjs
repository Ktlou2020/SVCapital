#!/usr/bin/env node
/* The cattle book: who may write it, what it saves, and whether it adds up.
 *
 * Four separate defects, all in the same corner of Fund Ops, all of the kind
 * that reads fine and behaves badly:
 *
 * 1. EVERY route under /api/cattle carried `requireAuth` alone. requireAuth
 *    accepts any valid token — an investor's included — so DELETE
 *    /api/cattle/purge, which empties cattle_cycles and cattle_animals, was
 *    reachable by every logged-in client on the platform. The comment above it
 *    said "requires authenticated director session". It did not.
 *
 * 2. cattle_animals had no exit_mass column, but the Add/Edit Animal form
 *    collects Exit Mass and sends it, and the generic table API builds its
 *    INSERT from the body keys. So every save from that form died on
 *    `column "exit_mass" does not exist` and the console said
 *    "Error saving animal: API 500". No animal could be added or edited by
 *    hand at all — and exit mass is the only record of what an animal gained.
 *
 * 3. The CSV importer counted attempts, not rows. It incremented once per
 *    INSERT issued and swallowed every per-row error, so it reported "200
 *    saved" whether 200 landed or none did — a duplicate suppressed by ON
 *    CONFLICT and a row the database refused both counted as saved.
 *
 * 4. Nothing ever compared the cycle header's counts against the animals on
 *    file, and NAV multiplies the HEADER: herd value is no_live × mass ×
 *    price. A live count three too high is not a miscount, it is a valuation
 *    of three animals that do not exist.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-cattle-fund-ops.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const path    = require('path');
const http    = require('http');
const express = require('express');
const pool    = require(path.join(__dirname, '..', 'db', 'pool'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* requireAuth is stubbed to take the role from a header so one server can act
   as any caller. requireRole is deliberately NOT stubbed — it is the thing
   under test, and a check that stubs its own subject proves nothing. */
const authMod  = require.resolve(path.join(__dirname, '..', 'middleware', 'auth'));
const realAuth = require(authMod);
require.cache[authMod].exports = {
  ...realAuth,
  requireAuth: (req, _r, next) => {
    req.user = { role: req.headers['x-role'] || 'investor', id: 'u-cattle', email: 'c@chk.test' };
    next();
  },
};

const app = express();
app.use(express.json());
app.use('/api/cattle', require(path.join(__dirname, '..', 'routes', 'cattle')));

let server;
const call = (method, p, role, body) => new Promise(res => {
  const d = body ? JSON.stringify(body) : null;
  const headers = { 'x-role': role };
  if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
  const r = http.request({ port: server.address().port, path: p, method, headers }, x => {
    let s = ''; x.on('data', c => s += c);
    x.on('end', () => { let j = {}; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); });
  });
  r.on('error', () => res({ status: 0, body: {} }));
  if (d) r.write(d);
  r.end();
});

const CYC = 'CYC-CHK-1', CYC2 = 'CYC-CHK-2';
async function cleanup() {
  await pool.query(`DELETE FROM cattle_animals WHERE tag_number LIKE 'CHK-%' OR batch_name LIKE 'CHK %'`);
  await pool.query(`DELETE FROM cattle_cycles  WHERE id LIKE 'CYC-CHK-%' OR batch_name LIKE 'CHK %'`);
}

(async () => {
  try {
    server = app.listen(0);
    await new Promise(r => server.on('listening', r));
    await cleanup();

    /* ── 1. the fund book is not writable by clients ───────────────────── */
    console.log('\nwho may write the cattle book');
    {
      const wall = [
        ['DELETE', '/api/cattle/purge'],
        ['POST',   '/api/cattle/import/animals'],
        ['POST',   '/api/cattle/import/cycles'],
        ['POST',   '/api/cattle/cycles'],
        ['GET',    '/api/cattle/reconcile'],
        ['GET',    '/api/cattle/animals/stats'],
      ];
      for (const [m, p] of wall) {
        const r = await call(m, p, 'investor', m === 'GET' ? null : { records: [] });
        ok(`an investor is refused ${m} ${p.replace('/api/cattle', '')}`, r.status === 403,
           `got ${r.status} — requireAuth alone accepts an investor's token`);
      }
      /* The one that empties both tables is narrower still. */
      const fm = await call('DELETE', '/api/cattle/purge', 'fund_manager', { confirm: 'DELETE ALL CATTLE DATA' });
      ok('and a fund_manager cannot purge — admin or director only', fm.status === 403, `got ${fm.status}`);

      const noPhrase = await call('DELETE', '/api/cattle/purge', 'director', {});
      ok('a director purging without the confirmation phrase is refused',
         noPhrase.status === 400 && noPhrase.body.error === 'confirmation_required',
         `got ${noPhrase.status} ${JSON.stringify(noPhrase.body)} — the console asked the operator to ` +
         '"type OK" over a confirm() with nothing to type into');
    }

    /* ── 2. exit mass ──────────────────────────────────────────────────── */
    console.log('\nsaving an animal from the console');
    {
      const { rows } = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'cattle_animals' AND column_name = 'exit_mass'`);
      ok('cattle_animals has an exit_mass column', rows.length === 1,
         'the form collects Exit Mass and the table renders it; without the column every save 500s');

      /* The exact body fund/js/cattle.js:saveAnimalForm() sends, through the
         same INSERT the generic table API builds from it. */
      const body = {
        id: 'ANM-CHK-1', tag_number: 'CHK-A1', batch_no: 'CHK 1', batch_name: 'CHK Batch',
        breed: 'Bonsmara', gender: 'Steer', entry_mass: 220, exit_mass: 310,
        status: 'sold', cycle_id: null, sale_batch: 'Lot 3', sale_date: '2026-08-01',
        sold: true, mortality: false, notes: null,
      };
      const keys = Object.keys(body);
      let saved = null, err = null;
      try {
        const { rows: r } = await pool.query(
          `INSERT INTO cattle_animals (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING exit_mass`,
          Object.values(body));
        saved = r[0].exit_mass;
      } catch (e) { err = e.message; }
      ok('the form body saves, exit mass and all', err === null, err);
      ok('and the weight it gained is retrievable', Number(saved) === 310, String(saved));

      const stats = await call('GET', '/api/cattle/animals/stats?search=CHK-A1', 'fund_manager');
      ok('average gain is reported over the animals actually weighed',
         Number(stats.body.avg_gain) === 90 && stats.body.weighed === 1,
         JSON.stringify(stats.body));
      await pool.query(`DELETE FROM cattle_animals WHERE id = 'ANM-CHK-1'`);
    }

    /* ── 3. the importer tells the truth ──────────────────────────────── */
    console.log('\nwhat the importer reports');
    {
      await call('POST', '/api/cattle/import/cycles', 'fund_manager',
        { records: [{ batch_name: 'CHK Batch', no_purchased: 10, no_live: 10, purchase_value: 100000, status: 'active' }] });

      /* One good row, one duplicate of it, one the database will refuse. */
      const first = await call('POST', '/api/cattle/import/animals', 'fund_manager', {
        records: [{ tag_number: 'CHK-B1', batch_name: 'CHK Batch', entry_mass: 200, exit_mass: 280 }],
      });
      ok('a good row is reported as one saved', first.body.inserted === 1, JSON.stringify(first.body));

      const second = await call('POST', '/api/cattle/import/animals', 'fund_manager', {
        records: [
          { tag_number: 'CHK-B1', batch_name: 'CHK Batch', entry_mass: 200 },            // duplicate
          { tag_number: 'CHK-B2', batch_name: 'CHK Batch', entry_mass: 210 },            // good
          { tag_number: 'CHK-B3', batch_name: 'CHK Batch', mortality_date: 'banana' },   // refused
        ],
      });
      ok('a re-imported row is reported as skipped, not saved', second.body.skipped === 1,
         JSON.stringify(second.body));
      ok('a row the database refuses is reported as failed, not saved',
         second.body.inserted === 1 && second.body.failed === 1,
         `inserted ${second.body.inserted}, failed ${second.body.failed} — this used to report 2 saved`);
      ok('and the failed row is named so it can be fixed',
         (second.body.failures || []).some(f => f.row === 'CHK-B3'),
         JSON.stringify(second.body.failures));
      ok('one bad row does not take the rest of the chunk with it',
         (await pool.query(`SELECT 1 FROM cattle_animals WHERE tag_number = 'CHK-B2'`)).rows.length === 1,
         'without a per-row SAVEPOINT the aborted transaction poisons every later insert');
    }

    /* ── 4. header vs animals ─────────────────────────────────────────── */
    console.log('\nreconciling the cycle headers against the animals');
    {
      await pool.query(`DELETE FROM cattle_animals WHERE tag_number LIKE 'CHK-%'`);
      await pool.query(`DELETE FROM cattle_cycles WHERE batch_name = 'CHK Batch'`);
      await pool.query(
        `INSERT INTO cattle_cycles (id, batch_name, status, no_purchased, no_live, no_sold, mortalities, purchase_value, cycle_start_date)
         VALUES ($1, 'CHK Batch', 'active', 10, 10, 0, 0, 100000, NOW())`, [CYC]);

      /* Eight animals on file against a header claiming ten live. */
      for (let i = 1; i <= 8; i++)
        await pool.query(
          `INSERT INTO cattle_animals (id, tag_number, batch_name, cycle_id, entry_mass, status)
           VALUES ($1, $2, 'CHK Batch', $3, 220, 'active')`, [`ANM-CHK-${i}`, `CHK-C${i}`, CYC]);

      const rec = await call('GET', '/api/cattle/reconcile', 'director');
      const mine = (rec.body.mismatched || []).find(c => c.id === CYC);
      ok('a header claiming more live animals than exist is reported', !!mine,
         JSON.stringify(rec.body.totals));
      if (mine) {
        const live = mine.checks.find(c => c.key === 'live');
        ok('with the size of the gap', live && live.header === 10 && live.counted === 8,
           JSON.stringify(mine.checks));
        ok('and ranked high, because NAV multiplies the live count',
           mine.severity === 'high', mine.severity);
      }
      ok('the head NAV counts but cannot point at is totalled',
         rec.body.totals.liveOverstated === 2, JSON.stringify(rec.body.totals));

      /* An animal that names its batch but lost its link. */
      await pool.query(
        `INSERT INTO cattle_animals (id, tag_number, batch_name, cycle_id, entry_mass, status)
         VALUES ('ANM-CHK-9', 'CHK-C9', 'CHK Batch', NULL, 220, 'active')`);
      const rec2 = await call('GET', '/api/cattle/reconcile', 'director');
      ok('an unlinked animal is reported as an orphan',
         (rec2.body.orphans || []).some(o => o.tagNumber === 'CHK-C9'));
      ok('and flagged as relinkable, because its batch name still names a cycle',
         (rec2.body.relinkable || []).some(o => o.tagNumber === 'CHK-C9'));

      const relink = await call('POST', '/api/cattle/reconcile/relink', 'director');
      ok('relinking reattaches it to that cycle', relink.body.relinked >= 1, JSON.stringify(relink.body));
      const { rows: rl } = await pool.query(`SELECT cycle_id FROM cattle_animals WHERE tag_number = 'CHK-C9'`);
      ok('to the right cycle', rl[0] && rl[0].cycle_id === CYC, JSON.stringify(rl));

      /* An ambiguous batch name must NOT be guessed at. */
      await pool.query(
        `INSERT INTO cattle_cycles (id, batch_name, status, no_purchased, no_live)
         VALUES ($1, 'CHK Batch', 'active', 0, 0)`, [CYC2]);
      await pool.query(
        `INSERT INTO cattle_animals (id, tag_number, batch_name, cycle_id, entry_mass, status)
         VALUES ('ANM-CHK-10', 'CHK-C10', 'CHK Batch', NULL, 220, 'active')`);
      const relink2 = await call('POST', '/api/cattle/reconcile/relink', 'director');
      const { rows: rl2 } = await pool.query(`SELECT cycle_id FROM cattle_animals WHERE tag_number = 'CHK-C10'`);
      ok('an animal whose batch name matches two cycles is left alone',
         relink2.body.relinked === 0 && rl2[0].cycle_id === null,
         'guessing which of two cycles an animal belongs to is not reconciliation');
      await pool.query(`DELETE FROM cattle_cycles WHERE id = $1`, [CYC2]);

      /* A header that does not balance against itself, with no animals to
         compare it to at all. */
      await pool.query(
        `INSERT INTO cattle_cycles (id, batch_name, status, no_purchased, no_live, no_sold, mortalities)
         VALUES ('CYC-CHK-3', 'CHK Batch Imbalanced', 'active', 100, 90, 5, 2)`);
      const rec3 = await call('GET', '/api/cattle/reconcile', 'director');
      ok('a header whose parts do not sum to its total is reported on its own',
         (rec3.body.imbalanced || []).some(c => c.id === 'CYC-CHK-3'),
         '90 live + 5 sold + 2 dead is not 100 purchased, and needs no animal records to see');
      ok('a header-only cycle is not reported as four separate mismatches',
         (rec3.body.headerOnly || []).some(c => c.id === 'CYC-CHK-3') &&
         !(rec3.body.mismatched || []).some(c => c.id === 'CYC-CHK-3'),
         'importing headers without animals is normal and must not drown the real gaps');
      await pool.query(`DELETE FROM cattle_cycles WHERE id = 'CYC-CHK-3'`);
    }

    /* ── 5. deleting a cycle does not silently cut its animals loose ──── */
    console.log('\ndeleting a cycle that still has animals');
    {
      const blocked = await call('DELETE', `/api/cattle/cycles/${CYC}`, 'director');
      ok('is refused, and says how many would be unlinked',
         blocked.status === 409 && blocked.body.linkedAnimals >= 8,
         `${blocked.status} ${JSON.stringify(blocked.body)} — ON DELETE SET NULL orphans them silently`);
      const { rows: still } = await pool.query(`SELECT 1 FROM cattle_cycles WHERE id = $1`, [CYC]);
      ok('and the cycle is still there', still.length === 1);

      const forced = await call('DELETE', `/api/cattle/cycles/${CYC}?orphan=1`, 'director');
      ok('acknowledging it goes through', forced.status === 200, JSON.stringify(forced.body));
      const { rows: orph } = await pool.query(
        `SELECT COUNT(*)::int n FROM cattle_animals WHERE tag_number LIKE 'CHK-C%' AND cycle_id IS NULL`);
      ok('and the animals survive, unlinked rather than deleted', orph[0].n >= 8, JSON.stringify(orph[0]));
    }

    /* ── 6. purge, once it is allowed to run ──────────────────────────── */
    console.log('\nthe purge itself');
    {
      const r = await call('DELETE', '/api/cattle/purge', 'director', { confirm: 'DELETE ALL CATTLE DATA' });
      ok('a director with the phrase may empty the tables', r.status === 200, JSON.stringify(r.body));
      ok('and it reports what it removed',
         r.body.deleted && typeof r.body.deleted.animals === 'number', JSON.stringify(r.body));
    }

    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
    await cleanup().catch(() => {});
  } finally {
    try { server && server.close(); } catch (_) { /* already down */ }
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
