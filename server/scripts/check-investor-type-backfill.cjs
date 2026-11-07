#!/usr/bin/env node
/* Filling in investor_type from the export, without trusting it blindly.
 *
 * The Firebase export carries investorType and the migration never read it,
 * so every imported client reads "Not set". backfill-investor-types.cjs reads
 * the same users.json and writes that one column — rather than re-running the
 * whole migration, which would also rewrite names, addresses, KYC statuses
 * and everything else staff have corrected since, on every client, to fill in
 * one field.
 *
 * What this holds:
 *
 *   previews      nothing is written without --apply
 *   never guesses a value the mapper does not recognise is reported and
 *                 SKIPPED, because calling an unknown "individual" turns an
 *                 imported trust into a natural person and the next FICA run
 *                 verifies it against Home Affairs rather than its deed
 *   defers        a type already set in the console is left alone unless
 *                 --overwrite says otherwise; the console is the more recent
 *                 authority
 *   all or none   one transaction, so the book is never half-classified
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-investor-type-backfill.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const vm   = require('vm');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_itbf_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
const SCRIPT  = path.join(ROOT, 'server', 'scripts', 'backfill-investor-types.cjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool, dbUrl, exportFile, srv;

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  dbUrl = withDatabase(process.env.DATABASE_URL, DB_NAME);
  process.env.DATABASE_URL = dbUrl;
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  pool = new Pool({ connectionString: dbUrl, ssl: SSL, max: 2 });
  pool.on('error', () => {});
}

/* An export shaped like the real one, with one record of every kind the
   script has to tell apart. */
function writeExport() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itbf-'));
  exportFile = path.join(dir, 'users.json');
  fs.writeFileSync(exportFile, JSON.stringify([
    { userAccountNumber: 'BF-IND',    investorType: 'INDIVIDUAL' },
    { userAccountNumber: 'BF-BIZ',    investorType: 'PTY_LTD' },
    { userAccountNumber: 'BF-TRUST',  investorType: 'inter vivos trust' },
    { userAccountNumber: 'BF-GROUP',  investorType: 'STOKVEL' },
    { userAccountNumber: 'BF-WEIRD',  investorType: 'NPO_SECTION_21' },
    { userAccountNumber: 'BF-SET',    investorType: 'TRUST' },
    { userAccountNumber: 'BF-AGREES', investorType: 'BUSINESS' },
    { userAccountNumber: 'BF-NONE' },
    { userAccountNumber: 'BF-GHOST',  investorType: 'BUSINESS' },
  ], null, 2));
}

async function seed() {
  const inv = (id, type) => pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, investor_type)
    VALUES ($1,'Test',$1,$1 || '@example.test','active',$2)`, [id, type]);
  await inv('BF-IND', null);
  await inv('BF-BIZ', null);
  await inv('BF-TRUST', null);
  await inv('BF-GROUP', null);
  await inv('BF-WEIRD', null);
  await inv('BF-NONE', null);
  /* Already classified in the console, and the export disagrees. */
  await inv('BF-SET', 'individual');
  /* Already classified, and the export agrees. */
  await inv('BF-AGREES', 'business');
  /* BF-GHOST is in the export and NOT in this database. */
}

const ADMIN_JS   = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');

const run = (...args) => execFileSync(process.execPath, [SCRIPT, `--file=${exportFile}`, ...args], {
  encoding: 'utf8',
  env: Object.assign({}, process.env, { DATABASE_URL: dbUrl, DATABASE_SSL: 'false' }),
});
const typeOf = async id => (await pool.query(
  `SELECT investor_type FROM investors WHERE id = $1`, [id])).rows[0].investor_type;

(async () => {
  try {
    await makeDatabase();
    writeExport();
    await seed();

    console.log('\nit previews, and writes nothing');
    {
      const out = run();
      ok('it says so', /nothing will be written/i.test(out), out.slice(0, 300));
      ok('and lists what it would set', /TO SET \(4\)/.test(out), out.slice(0, 900));
      ok('the database is untouched', (await typeOf('BF-IND')) === null);
    }

    console.log('\nand it maps the spellings the export actually uses');
    {
      const out = run('--apply');
      ok('four clients are classified', /4 client\(s\) classified/.test(out), out.slice(-400));
      ok('INDIVIDUAL → individual', (await typeOf('BF-IND')) === 'individual');
      ok('PTY_LTD → business', (await typeOf('BF-BIZ')) === 'business');
      ok('inter vivos trust → trust', (await typeOf('BF-TRUST')) === 'trust');
      ok('STOKVEL → group', (await typeOf('BF-GROUP')) === 'group');
    }

    console.log('\nand it refuses to guess at one it does not know');
    {
      ok('the unrecognised client is left unset', (await typeOf('BF-WEIRD')) === null,
         'guessing turns an imported entity into a natural person and FICA then ' +
         'verifies it against Home Affairs rather than its registration');
      const out = run();
      ok('and the value is named so it can be added',
         /NOT RECOGNISED/.test(out) && /NPO_SECTION_21/.test(out), out.slice(0, 1400));
      ok('with where to add it', /ALIASES in server\/services\/investorType\.js/.test(out));
    }

    console.log('\nand it defers to a type somebody set in the console');
    {
      ok('the conflicting one is untouched', (await typeOf('BF-SET')) === 'individual',
         'the export says trust; the console said individual more recently');
      const out = run();
      ok('the disagreement is reported, not silently resolved',
         /ALREADY SET, AND THE EXPORT DISAGREES \(1\)/.test(out), out.slice(0, 1600));
      ok('naming both answers',
         /console says Individual, export says Trust/.test(out), out.slice(0, 1600));

      run('--apply', '--overwrite');
      ok('and --overwrite does take the export', (await typeOf('BF-SET')) === 'trust');
    }

    console.log('\nand it leaves alone what it has no business touching');
    {
      ok('a client with no investorType in the export stays unset',
         (await typeOf('BF-NONE')) === null);
      ok('one that already agreed is unchanged', (await typeOf('BF-AGREES')) === 'business');
      const out = run();
      ok('a client in the export but not in this database is reported, not an error',
         /NOT IN THIS DATABASE \(1\)/.test(out), out.slice(0, 1800));
    }

    console.log('\nand a second run finds nothing left to do');
    {
      const out = run('--apply');
      ok('nothing further is written', /Nothing to write/.test(out), out.slice(-300));
      ok('and the classifications hold', (await typeOf('BF-BIZ')) === 'business');
    }

    console.log('\nand it refuses an export it cannot read rather than writing half of one');
    {
      const bad = path.join(path.dirname(exportFile), 'broken.json');
      fs.writeFileSync(bad, '{ not json');
      let threw = false;
      try {
        execFileSync(process.execPath, [SCRIPT, `--file=${bad}`, '--apply'],
          { encoding: 'utf8', env: Object.assign({}, process.env,
            { DATABASE_URL: dbUrl, DATABASE_SSL: 'false' }), stdio: 'pipe' });
      } catch (_) { threw = true; }
      ok('a malformed export is refused', threw);
      ok('and nothing was changed by it', (await typeOf('BF-BIZ')) === 'business');
    }

    /* ─── One classification, two front doors ─────────────────────── */
    console.log('\nand the console panel is the same classification, not a second one');
    {
      const CLI   = fs.readFileSync(SCRIPT, 'utf8');
      const ROUTE = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'migrate.js'), 'utf8');
      for (const [what, src] of [['the script', CLI], ['the route', ROUTE]]) {
        ok(`${what} requires the service`,
           /require\((?:'\.\.\/services\/investorTypeBackfill'|\.\.\.?[^)]*'investorTypeBackfill'[^)]*)\)/.test(src),
           'matched on the require itself, not the name appearing somewhere in the file');
        ok(`${what} holds no mapping of its own`,
           !/normaliseInvestorType\(\s*u\.investorType\s*\)/.test(src),
           'two copies of the mapping drift, and the drift is a wrong entity type');
        ok(`${what} writes nothing itself`,
           !/UPDATE investors SET investor_type/.test(src),
           'the service owns the transaction; a second writer owns half a book');
      }
      ok('the panel uploads to that route',
         /\/api\/migrate\/investor-types/.test(ADMIN_JS));
      /* The browser never parses the export: it posts the file as it stands.
         So there is no third copy of the mapping, and none can grow here —
         the one thing the panel could get wrong it is not in a position to. */
      ok('and the browser never reads investorType itself',
         !/\.investorType\b/.test(ADMIN_JS) && /fd\.append\('users', file\)/.test(ADMIN_JS),
         'the file is uploaded, not classified in the browser');
      ok('and the file never reaches the disk',
         /multer\.memoryStorage\(\)/.test(ROUTE),
         'users.json is a dump of real client records');
    }

    console.log('\nand staff can run it from the console without a database URL');
    {
      const express = require('express');
      const http    = require('http');
      const ROLE    = { id: null, email: 'panel@check.test', role: 'admin' };
      /* Auth is stubbed so the route is exercised rather than the login. The
         role is mutable so the guard itself can be tested. */
      const authMod = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
      require.cache[authMod] = { id: authMod, filename: authMod, loaded: true, exports: {
        requireAuth: (req, _r, next) => { req.user = ROLE; next(); },
        requireRole: (...roles) => (req, res, next) =>
          roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden.' }),
      } };
      const app = express();
      app.use('/api/migrate', require(path.join(ROOT, 'server', 'routes', 'migrate')));
      srv = await new Promise(r => { const x = app.listen(0, () => r(x)); });

      const post = (fields, body) => new Promise(resolve => {
        const B = '----svccheck' + Date.now() + Math.random().toString(36).slice(2);
        const parts = [];
        for (const [k, v] of Object.entries(fields)) {
          if (v === undefined) continue;
          parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
        }
        if (body !== null) {
          parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="users"; ` +
            `filename="users.json"\r\nContent-Type: application/json\r\n\r\n`));
          parts.push(Buffer.from(body === undefined ? fs.readFileSync(exportFile) : Buffer.from(body)));
          parts.push(Buffer.from('\r\n'));
        }
        parts.push(Buffer.from(`--${B}--\r\n`));
        const buf = Buffer.concat(parts);
        const req = http.request({ port: srv.address().port, path: '/api/migrate/investor-types',
          method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${B}`,
                                     'Content-Length': buf.length } }, res => {
          let out = ''; res.on('data', c => out += c);
          res.on('end', () => { let j = {}; try { j = JSON.parse(out); } catch (_) {}
                                resolve({ status: res.statusCode, body: j }); });
        });
        req.on('error', e => resolve({ status: 0, body: { error: e.message } }));
        req.end(buf);
      });

      /* Back to the state the preview section started from, so the counts the
         panel reports can be compared with the ones the CLI printed. */
      await pool.query(`UPDATE investors SET investor_type = NULL
                         WHERE id IN ('BF-IND','BF-BIZ','BF-TRUST','BF-GROUP','BF-WEIRD','BF-NONE')`);
      await pool.query(`UPDATE investors SET investor_type = 'individual' WHERE id = 'BF-SET'`);

      const prev = await post({});
      ok('a request with no apply field previews', prev.status === 200 && prev.body.applied === false,
         JSON.stringify(prev.body).slice(0, 200));
      ok('and writes nothing', (await typeOf('BF-IND')) === null);
      ok('the counts are the ones the command line prints',
         prev.body.counts && prev.body.counts.toSet === 4 && prev.body.counts.conflicts === 1
         && prev.body.counts.missing === 1 && prev.body.counts.noType === 1,
         JSON.stringify(prev.body.counts || {}));
      /* The strongest guard against the two front doors drifting: the same
         file against the same database, and the numbers the CLI PRINTS
         compared with the ones the route RETURNS. Hard-coding both would
         pass happily while they disagreed with each other. */
      {
        const cliOut = run();
        const n = re => { const m = cliOut.match(re); return m ? parseInt(m[1], 10) : -1; };
        const c = prev.body.counts || {};
        ok('the command line and the panel agree, number for number',
           n(/TO SET \((\d+)\)/) === c.toSet
           && n(/EXPORT DISAGREES \((\d+)\)/) === c.conflicts
           && n(/NOT RECOGNISED \((\d+) value/) === (prev.body.unmapped || []).length
           && n(/NOT IN THIS DATABASE \((\d+)\)/) === c.missing,
           `CLI said set=${n(/TO SET \((\d+)\)/)} conflict=${n(/EXPORT DISAGREES \((\d+)\)/)} ` +
           `unmapped=${n(/NOT RECOGNISED \((\d+) value/)} missing=${n(/NOT IN THIS DATABASE \((\d+)\)/)}; ` +
           `route said ${JSON.stringify(c)}`);
      }
      ok('broken down by type, so the panel can show what it would create',
         prev.body.byType && prev.body.byType.individual === 1 && prev.body.byType.business === 1
         && prev.body.byType.trust === 1 && prev.body.byType.group === 1,
         JSON.stringify(prev.body.byType || {}));
      /* The unrecognised values are the actionable half of a preview: a count
         alone cannot be acted on, the spelling can. */
      ok('the unrecognised value is named, not counted',
         (prev.body.unmapped || []).some(u => u.value === 'NPO_SECTION_21' && u.count === 1),
         JSON.stringify(prev.body.unmapped || []));
      ok('and the disagreement names both answers',
         (prev.body.conflicts || []).some(c => c.id === 'BF-SET' && c.was === 'individual' && c.type === 'trust'),
         JSON.stringify(prev.body.conflicts || []));

      const applied = await post({ apply: 'true' });
      ok('apply=true writes', applied.status === 200 && applied.body.applied === true
         && applied.body.written === 4, JSON.stringify(applied.body).slice(0, 200));
      ok('the four are classified', (await typeOf('BF-BIZ')) === 'business'
         && (await typeOf('BF-GROUP')) === 'group');
      ok('and the type somebody set in the console is still untouched',
         (await typeOf('BF-SET')) === 'individual',
         'overwrite was not asked for, so the console wins');
      ok('the unrecognised client is still unset', (await typeOf('BF-WEIRD')) === null);

      /* Counted before and after rather than absolutely: the CLI section above
         already overrode this client once, so the property worth asserting is
         ONE NEW ROW PER CLIENT OVERRULED PER RUN, not a total. */
      const overrides = async () => (await pool.query(
        `SELECT entity_id, description FROM audit_events
          WHERE event_type = 'investor_type_overwritten' ORDER BY created_at`)).rows;
      const before = (await overrides()).length;
      const over = await post({ apply: 'true', overwrite: 'true' });
      ok('overwrite=true takes the export', over.status === 200
         && (await typeOf('BF-SET')) === 'trust', JSON.stringify(over.body).slice(0, 160));
      /* Overruling a person is logged per client, because somebody has to be
         able to find out which answers were replaced and by whom. */
      const logged = await overrides();
      ok('and says in the audit log whose answer it replaced',
         logged.length === before + 1
         && logged[logged.length - 1].entity_id === 'BF-SET'
         && /Individual to Trust/.test(logged[logged.length - 1].description),
         `${before} → ${logged.length}: ${JSON.stringify(logged.slice(-2))}`);
      const { rows: summary } = await pool.query(
        `SELECT description FROM audit_events WHERE event_type = 'investor_types_backfilled'`);
      ok('every run is logged, not only the overrides', summary.length >= 2, String(summary.length));

      ok('a request with no file is refused with something to act on',
         await (async () => { const r = await post({}, null);
           return r.status === 400 && /users\.json/.test(r.body.error || ''); })());
      const junk = await post({ apply: 'true' }, '{ not json');
      ok('a malformed upload is refused rather than half-applied',
         junk.status === 400 && /not valid JSON/.test(junk.body.error || ''),
         JSON.stringify(junk.body).slice(0, 160));
      const empty = await post({ apply: 'true' }, '[]');
      ok('and an empty export is refused rather than reported as a clean run',
         empty.status === 400 && /no user records/.test(empty.body.error || ''),
         JSON.stringify(empty.body).slice(0, 160));

      /* A write that fails part-way must leave NOTHING, not the clients it
         reached before the failure. Forced by refusing one value at the
         database: 'group' is the last of the four the export names, so
         without a transaction the first three would already be written. */
      console.log('\nand a write that fails part-way leaves nothing behind');
      await pool.query(`UPDATE investors SET investor_type = NULL
                         WHERE id IN ('BF-IND','BF-BIZ','BF-TRUST','BF-GROUP')`);
      await pool.query(`ALTER TABLE investors
                          ADD CONSTRAINT chk_itbf_no_group
                          CHECK (investor_type IS NULL OR investor_type <> 'group')`);
      let broke;
      try {
        broke = await post({ apply: 'true' });
      } finally {
        await pool.query(`ALTER TABLE investors DROP CONSTRAINT chk_itbf_no_group`);
      }
      ok('the failure is reported rather than swallowed',
         broke.status === 500, `${broke.status} ${JSON.stringify(broke.body).slice(0, 120)}`);
      const { rows: [{ n: stragglers }] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM investors
          WHERE id IN ('BF-IND','BF-BIZ','BF-TRUST') AND investor_type IS NOT NULL`);
      ok('and the three it had already reached were rolled back',
         stragglers === 0,
         `${stragglers} client(s) kept a type from a run that failed — the book is ` +
         'half-classified, which is indistinguishable from a partial import');
      const ok2 = await post({ apply: 'true' });
      ok('so the whole thing can simply be run again', ok2.status === 200
         && (await typeOf('BF-GROUP')) === 'group' && (await typeOf('BF-IND')) === 'individual');

      ROLE.role = 'employee';
      const forbidden = await post({});
      ok('somebody who is not an admin or a director cannot call it at all',
         forbidden.status === 403, String(forbidden.status));
      ROLE.role = 'admin';
    }

    console.log('\nand the panel previews before it offers to write');
    {
      ok('the panel is in the migration utilities', /id="itypeFile"/.test(ADMIN_HTML));
      ok('Preview does not apply', /backfillInvestorTypes\(this, false\)/.test(ADMIN_HTML));
      ok('and Apply is hidden until a preview finds something to do',
         /id="itypeApplyBtn"[^>]*display:none/.test(ADMIN_HTML)
         && /applyBtn\.style\.display = \(!d\.applied && can\) \? '' : 'none'/.test(ADMIN_JS),
         'a button that writes the whole book must not be reachable before the preview');
      ok('overwriting is a deliberate tick, not the default',
         /id="itypeOverwrite"(?![^>]*checked)/.test(ADMIN_HTML));
      ok('and the confirmation says how many it would overwrite',
         /will be OVERWRITTEN/.test(ADMIN_JS));
      ok('nothing the export carries becomes markup',
         /_esc\(JSON\.stringify\(u\.value\)\)/.test(ADMIN_JS),
         'an unrecognised investorType is a string out of a file somebody else wrote');
    }

    /* The shipped renderer, lifted and run against a real payload. A copy of
       the rule here would keep agreeing with itself after the real one
       changed, and the numbers on this panel are what somebody decides to
       press Apply on. */
    console.log('\nand the preview says, in words, what pressing Apply would do');
    {
      const box = {};
      const ctx = { console, Math, Number, String, JSON, Object, Array, Boolean, Date,
                    parseFloat, parseInt, isNaN, RegExp, Set, Map, Error,
                    localStorage: { getItem: () => null, setItem() {} },
                    document: { addEventListener() {},
                      getElementById: id => (box[id] = box[id] || { innerHTML: '', style: {},
                        textContent: '', dataset: {}, classList: { add() {}, remove() {} } }) },
                    _esc: v => String(v == null ? '' : v)
                      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                      .replace(/"/g, '&quot;').replace(/'/g, '&#39;') };
      ctx.globalThis = ctx; ctx.window = ctx; ctx.self = ctx;
      vm.createContext(ctx);
      /* js/api.js for the real Utils.investorTypeLabel — the label on this
         panel has to be the one the rest of the console shows. */
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8'), ctx,
                      { filename: 'js/api.js' });
      const from = ADMIN_JS.indexOf('function _itypeBuckets');
      const to   = ADMIN_JS.indexOf('async function backfillInvestorTypes');
      ok('the renderer was found to lift', from > 0 && to > from,
         'a slice that missed it would test nothing while passing');
      vm.runInContext(ADMIN_JS.slice(from, to), ctx);

      const html = ctx._itypeBuckets({
        total: 9,
        byType: { individual: 2, business: 1, trust: 1, group: 1 },
        counts: { toSet: 5, conflicts: 1, unchanged: 3, missing: 2, unmapped: 1, noType: 1, noId: 0 },
        conflicts: [{ id: 'BF-SET', name: 'Zanele Mthembu', was: 'individual', type: 'trust' }],
        unmapped: [{ value: 'NPO_SECTION_21', count: 4 }],
      });
      ok('it names the number it would classify', /5<\/span>\s*<span[^>]*>to set/.test(html)
         || /5<\/span>[\s\S]{0,80}to set/.test(html), html.slice(0, 400));
      ok('and the four kinds in the words the console uses elsewhere',
         /Individual 2/.test(html) && /Business 1/.test(html)
         && /Trust 1/.test(html) && /Group 1/.test(html), html.slice(0, 900));
      ok('the unrecognised value is quoted exactly, so it can be added',
         html.includes('NPO_SECTION_21') && /ALIASES/.test(html)
         && /investorType\.js/.test(html),
         'a count alone cannot be acted on; the spelling can');
      ok('the disagreement names both answers and whose it was',
         /console says <strong>Individual<\/strong>/.test(html)
         && /export says <strong>Trust<\/strong>/.test(html), html.slice(-900));
      /* A blank is not a dash on this panel either: a reader cannot tell a
         figure of zero from a figure that failed to arrive. */
      const zeros = { toSet: 4, conflicts: 0, unchanged: 0, missing: 0, noType: 0, noId: 0 };
      ok('a bucket that is empty is left out rather than shown as zero',
         !/>0</.test(ctx._itypeBuckets({ counts: zeros, byType: {} }))
         && /to set/.test(ctx._itypeBuckets({ counts: zeros, byType: {} })),
         ctx._itypeBuckets({ counts: zeros, byType: {} }));
      const nasty = ctx._itypeBuckets({ counts: { conflicts: 1 }, byType: {},
        conflicts: [{ id: '<img src=x onerror=alert(1)>', name: '<b>x</b>', was: 'trust', type: 'group' }] });
      ok('and a client id out of the file never becomes markup',
         !nasty.includes('<img') && !nasty.includes('<b>'), nasty.slice(0, 300));
    }
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (srv) await new Promise(r => srv.close(r));
    if (pool) await pool.end().catch(() => {});
    /* The route and services/audit write through db/pool, whose idle
       connections would block the DROP below. */
    await require(path.join(ROOT, 'server', 'db', 'pool')).end().catch(() => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
