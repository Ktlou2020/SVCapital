#!/usr/bin/env node
/* The switch that decides whether a group is offered the notice account.
 *
 * Every group-facing notice-fund route is gated on
 * platform_settings.notice_fund_live, and the console's own panel told
 * staff for months that the switch lived in "Settings → notice_fund_live".
 * There was no such screen. The flag could only be changed by writing to
 * the database by hand, which meant the product had a kill switch nobody
 * present could reach — in either direction. A group could not be offered
 * the account without a developer, and could not be un-offered it in a
 * hurry either, which is the direction that matters.
 *
 * OFF IS THE DEFAULT AND MUST STAY THE DEFAULT. Reading the setting
 * upserts 'false': an environment nobody has asked must not begin offering
 * a financial product because somebody opened a settings page. Turning it
 * on is an admin or a director, and it is audited, because it is the
 * moment the account becomes something a group can be sold.
 *
 * Run: DATABASE_URL=… node server/scripts/check-notice-fund-switch.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = src => String(src).replace(/\/\*[\s\S]*?\*\//g, ' ')
                                .replace(/^\s*\/\/.*$/gm, ' ');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

(async () => {
  let srv;
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.platform_settings') IS NOT NULL AS a,
              to_regclass('public.notice_funds')      IS NOT NULL AS b`);
    if (!ready[0].a || !ready[0].b) { console.log('\n  SKIP  no settings or fund tables here'); return; }

    const noticeFund = require(path.join(ROOT, 'server', 'services', 'noticeFund.js'));

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/settings', require(path.join(ROOT, 'server', 'routes', 'settings.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });

    const tok = role => jwt.sign({ id: 'u-' + role, role, email: role + '@svcapital.test',
                                   firstName: 'A', lastName: 'B' },
                                 process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = (method, p, token, body) => new Promise(res => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign({ Authorization: `Bearer ${token}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s = ''; x.on('data', c => s += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s || '{}') })); });
      if (payload) r.write(payload);
      r.end();
    });
    const get = who => call('GET', '/api/settings/notice-fund-live', tok(who));
    const put = (who, enabled) => call('PUT', '/api/settings/notice-fund-live', tok(who), { enabled });
    const stored = async () => (await db.query(
      `SELECT value FROM platform_settings WHERE key = 'notice_fund_live'`)).rows[0];

    await db.query(`DELETE FROM platform_settings WHERE key = 'notice_fund_live'`);

    console.log('\nan environment nobody has asked does not offer it');
    {
      ok('THE SETTING IS NOT THERE TO BEGIN WITH', !(await stored()),
         'the state this check starts from');
      ok('AND isLive SAYS NO', (await noticeFund.isLive(db)) === false,
         'the gate every group-facing notice route reads');
      const r = await get('admin');
      ok('reading it says off', r.status === 200 && r.body.enabled === false, JSON.stringify(r.body));
      const row = await stored();
      ok('AND READING IT WROTE false, NOT true',
         row && String(row.value) === 'false',
         'opening a settings page must never be what starts offering a '
         + 'financial product: ' + JSON.stringify(row));
      ok('and isLive still says no after the read',
         (await noticeFund.isLive(db)) === false);
    }

    console.log('\nand turning it on is somebody’s decision, by name');
    {
      const r = await put('admin', true);
      ok('an admin can offer it', r.status === 200 && r.body.enabled === true, JSON.stringify(r.body));
      ok('AND THE GATE OPENS', (await noticeFund.isLive(db)) === true,
         'this is the only thing that matters about the switch');
      ok('and reading it back says so', (await get('director')).body.enabled === true);
    }

    console.log('\nand it can be taken away again in a hurry');
    {
      const r = await put('director', false);
      ok('a director can stop offering it', r.status === 200 && r.body.enabled === false,
         JSON.stringify(r.body));
      ok('AND THE GATE SHUTS', (await noticeFund.isLive(db)) === false,
         'the direction that matters: a product that cannot be withdrawn '
         + 'quickly is a product that cannot be launched carefully');
    }

    console.log('\nand it is not everybody’s switch');
    {
      for (const who of ['investor', 'employee', 'support']) {
        const r = await put(who, true);
        ok(`a ${who} cannot turn it on`, r.status === 401 || r.status === 403,
           JSON.stringify({ status: r.status, body: r.body }));
      }
      ok('AND IT IS STILL OFF AFTER ALL THAT',
         (await noticeFund.isLive(db)) === false,
         'a refused request that changed something is worse than no check');
      const nonsense = await put('admin', 'yes please');
      ok('and it takes a boolean, not a word',
         nonsense.status === 400,
         '"yes please" is not false, and a truthy string would turn it on: '
         + JSON.stringify(nonsense.body));
    }

    console.log('\nand there is an account to offer');
    {
      const SETUP = strip(read('server/db/setup.js'));
      ok('setup creates the Agriculture Notice Account',
         /INSERT INTO notice_funds[\s\S]{0,200}Agriculture Notice Account/.test(SETUP),
         'the switch is pointless without something behind it');
      /* The one that bit: openFund takes the OLDEST OPEN fund, so a fund
         planted open by setup shadows every fund set up afterwards. The
         existing notice-fund check broke on exactly that, with its own
         fund's rates invisible behind this one. */
      ok('AND IT ARRIVES AS A DRAFT, NOT OPEN',
         /Agriculture Notice Account',30,0,\$1,'draft'/.test(SETUP),
         'openFund takes the oldest OPEN fund — one planted open here would '
         + 'shadow anybody else\u2019s, and a group would be offered this '
         + 'fund\u2019s rates rather than theirs, with nothing on screen to '
         + 'say why');
      ok('AND SETUP DOES NOT TURN THE SWITCH ON',
         !/notice_fund_live','true'/.test(SETUP)
         && /notice_fund_live','false'/.test(SETUP),
         'a deploy that started offering a financial product to every '
         + 'environment would be the worst possible version of this');
      ok('and it will not reopen a fund somebody closed',
         /ON CONFLICT \(id\) DO NOTHING/.test(SETUP),
         'a redeploy must not undo an operational decision');
      ok('and it will not overwrite the switch either',
         /notice_fund_live[\s\S]{0,160}ON CONFLICT \(key\) DO NOTHING/.test(SETUP),
         SETUP.slice(SETUP.indexOf('notice_fund_live'), SETUP.indexOf('notice_fund_live') + 200));
    }

    console.log('\nand the console offers the switch rather than naming a screen');
    {
      const ADMIN = strip(read('admin/js/admin.js'));
      ok('THE PANEL HAS A BUTTON',
         /setNoticeFundLive\(/.test(ADMIN),
         'it used to say "Settings → notice_fund_live" about a page that '
         + 'did not exist');
      ok('and it calls the route that exists',
         /settings\/notice-fund-live/.test(ADMIN), 'admin/js/admin.js');
      ok('and it asks before offering a financial product to every group',
         /if \(!confirm\(ask\)\) return;/.test(ADMIN),
         'this is the switch that makes it sellable');
    }

    await db.query(`DELETE FROM platform_settings WHERE key = 'notice_fund_live'`);
  } catch (err) {
    fail += 1;
    console.log('  ✗ the check itself fell over\n      ' + (err && err.stack || err));
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
