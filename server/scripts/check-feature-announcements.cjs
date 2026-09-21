#!/usr/bin/env node
/* Telling staff a feature exists, and where it is.
 *
 * A feature nobody is told about is a feature nobody uses, and the people it
 * costs most are the staff answering a client's question about a screen that
 * moved under them overnight.
 *
 * Three things have to hold or the mechanism is worse than nothing.
 *
 *   Dismissal is per person AND per notice. A "seen everything up to here"
 *   watermark is cheaper and wrong: somebody who clears one notice has not
 *   read the other three, and a watermark cannot tell the difference.
 *
 *   One person's dismissal is not another's. Two staff sharing a read state
 *   means the second never hears about anything.
 *
 *   A dismissal survives a reload, and a redeploy. Held in a browser it would
 *   be per-device; re-asserted by setup it would come back after somebody
 *   switched it off.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-feature-announcements.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const db   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-announcements-secret';
const router = require(path.join(ROOT, 'server', 'routes', 'announcements.js'));
const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));

function call(method, url, user, body) {
  return new Promise(resolve => {
    const req = {
      method, url, originalUrl: url, baseUrl: '', body: body || {}, params: {}, query: {},
      headers: { authorization: 'Bearer ' + jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '10m' }) },
      cookies: {}, get(h) { return this.headers[String(h).toLowerCase()]; },
    };
    let code = 200;
    const res = {
      statusCode: 200,
      status(c) { code = c; this.statusCode = c; return this; },
      setHeader() { return this; }, set() { return this; },
      json(p) { resolve({ status: code, body: p }); return this; },
      send(p) { resolve({ status: code, body: p }); return this; },
    };
    router(req, res, () => resolve({ status: 404, body: { error: 'no route' } }));
  });
}

const AYANDA = { id: 'a1', email: 'Ayanda@SVCapital.co.za', role: 'admin' };
const LINDA  = { id: 'a2', email: 'linda@svcapital.co.za',  role: 'fund_manager' };
const CLIENT = { id: 'c1', email: 'client@example.com', role: 'investor', investorId: 'AN-1' };

const unread = async u => (await call('GET', '/', u)).body.unread;

(async () => {
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});
    await db.query(`DELETE FROM feature_announcements WHERE id LIKE 'ANNCHK-%'`);
    await db.query(
      `INSERT INTO feature_announcements (id, title, body, where_to_find, area, audience, published_at)
       VALUES ('ANNCHK-1','One','Body one','Clients → Overview','admin','staff', NOW() - INTERVAL '2 days'),
              ('ANNCHK-2','Two','Body two','Portal → Refer','portal','staff', NOW() - INTERVAL '1 day'),
              ('ANNCHK-3','Three','Body three','Everywhere','both','clients', NOW()),
              ('ANNCHK-4','Off','Body four','Nowhere','admin','staff', NOW())`);
    await db.query(`UPDATE feature_announcements SET active = false WHERE id = 'ANNCHK-4'`);

    const base = await unread(AYANDA);

    console.log('\nstaff are told, and told where');
    {
      const list = (await call('GET', '/', AYANDA)).body.data;
      const mine = list.filter(a => a.id.startsWith('ANNCHK-'));
      ok('staff notices are shown', mine.some(a => a.id === 'ANNCHK-1'));
      ok('every notice says where to find it',
         mine.every(a => a.where_to_find && a.where_to_find.length > 3),
         'the field release notes leave out is the only one somebody can act on');
      ok('newest first', mine[0].id === 'ANNCHK-2', mine.map(a => a.id).join(','));
      ok('a switched-off notice is not shown', !mine.some(a => a.id === 'ANNCHK-4'),
         'deactivating one has to actually stop it');
      ok('and a client-audience notice is not shown to staff',
         !mine.some(a => a.id === 'ANNCHK-3'));
    }

    console.log('\ndismissal is per notice, not a watermark');
    {
      await call('POST', '/ANNCHK-1/dismiss', AYANDA);
      const after = (await call('GET', '/', AYANDA)).body.data.filter(a => a.id.startsWith('ANNCHK-'));
      ok('the dismissed one goes', !after.some(a => a.id === 'ANNCHK-1'));
      /* ANNCHK-2 is NEWER than the one dismissed, and ANNCHK-1 is older — a
         "seen up to here" watermark would have taken both. */
      ok('and the others stay', after.some(a => a.id === 'ANNCHK-2'),
         'a watermark cannot tell "I read this one" from "I read everything"');
      ok('the count follows', await unread(AYANDA) === base - 1);
    }

    console.log('\none person’s dismissal is their own');
    {
      const lindaSees = (await call('GET', '/', LINDA)).body.data;
      ok('Linda still has it', lindaSees.some(a => a.id === 'ANNCHK-1'),
         'two staff sharing a read state means the second never hears anything');
      /* The address is the key and it is not case-sensitive anywhere else a
         person types it. */
      ok('and the same person in different case is the same person',
         (await unread({ ...AYANDA, email: 'AYANDA@svcapital.CO.ZA' })) === await unread(AYANDA),
         'they would be told everything again after a re-login');
    }

    console.log('\nand it survives being clicked twice, and a reload');
    {
      const again = await call('POST', '/ANNCHK-1/dismiss', AYANDA);
      ok('dismissing twice is not an error', again.status === 200,
         'a double-click or a retry after a dropped response means the same thing');
      ok('and does not double-count', await unread(AYANDA) === base - 1);
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM feature_announcement_reads WHERE announcement_id = 'ANNCHK-1'`);
      ok('one row per person per notice', rows[0].n === 1);
      ok('held on the server, not in a browser',
         /feature_announcement_reads/.test(read('server/routes/announcements.js')) &&
         !/localStorage/.test(read('server/routes/announcements.js')),
         'a per-device dismissal tells somebody again on their laptop');
      const restored = await call('POST', '/ANNCHK-1/restore', AYANDA);
      ok('and it can be undone', restored.status === 200 && await unread(AYANDA) === base);
    }

    console.log('\nclients cannot see or write staff notices');
    {
      const c = await call('GET', '/', CLIENT);
      ok('a client sees no staff notice',
         !(c.body.data || []).some(a => a.id === 'ANNCHK-1' || a.id === 'ANNCHK-2'));
      ok('but would see one addressed to them',
         (c.body.data || []).some(a => a.id === 'ANNCHK-3'),
         'the audience column has to actually route');
      ok('a client cannot publish', (await call('POST', '/', CLIENT, { title: 'x', body: 'y' })).status === 403);
      ok('nor a fund manager', (await call('POST', '/', LINDA, { title: 'x', body: 'y' })).status === 403);
      const made = await call('POST', '/', AYANDA, { id: 'ANNCHK-9', title: 'New', body: 'B', where_to_find: 'W' });
      ok('an admin can', made.status === 200 && made.body.announcement.id === 'ANNCHK-9');
      ok('and a notice with no body is refused',
         (await call('POST', '/', AYANDA, { title: 'x' })).status === 400);
    }

    console.log('\nthe seed announces without overwriting');
    {
      const setup = read('server/db/setup.js');
      const step = (setup.match(/await step\("19\. Announce[\s\S]*?\n    \}\);/) || [''])[0];
      ok('there is a seeding step', step.length > 0);
      ok('it never re-asserts a notice', /ON CONFLICT \(id\) DO NOTHING/.test(step),
         'a notice would come back after somebody edited or switched it off');
      ok('every seeded notice says where to find it',
         (step.match(/where:/g) || []).length === (step.match(/title:/g) || []).length,
         'a notice without it is not worth publishing');
      ok('and the rule is written down',
         /## Announcing a New Feature/.test(read('CLAUDE.md')),
         'a convention nobody recorded is a convention that lasts one session');
    }

    console.log('\nthe console shows them');
    {
      const admin = read('admin/js/admin.js');
      ok('the dashboard has somewhere to put them', /id="adminAnnouncements"/.test(read('admin/index.html')));
      ok('and asks for them when it opens', /_loadAnnouncements\(\);/.test(admin));
      ok('not blocking the figures somebody came for',
         /_showLoadingBar\(\);[\s\S]{0,220}_loadAnnouncements\(\);/.test(admin) &&
         !/await _loadAnnouncements/.test(admin));
      ok('the card is removed only after the server has it',
         /await API\._fetch\('POST', `announcements[\s\S]{0,140}card\.remove\(\)/.test(admin),
         'removing it first and failing quietly is how it comes back tomorrow');
      ok('and a failed dismissal says so',
         /catch[\s\S]{0,200}Could not dismiss that/.test(admin));
    }

    await db.query(`DELETE FROM feature_announcements WHERE id LIKE 'ANNCHK-%'`);
  } catch (e) {
    console.error(e); fail++;
  } finally { await db.end().catch(() => {}); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
