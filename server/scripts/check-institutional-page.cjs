#!/usr/bin/env node
/* The institutional page says what it may, and the enquiry reaches somebody.
 *
 * This page is read by people who allocate for a living, and it makes
 * regulated claims. Two kinds of thing can go wrong with it and both are
 * worth holding in place.
 *
 * WHAT IT SAYS. The licence wording has to be exact — SmartVest Financial
 * Services (Pty) Ltd is the provider carrying FSP 52449 and SV Capital is the
 * fund manager — and the risk wording has to be there. It must also not
 * acquire a minimum: the figure was deliberately left off, and a stray
 * "from R…" would be a public offer at a price nobody agreed to. And it must
 * not drift back into the retail funnel's vocabulary, which is the whole
 * reason the page exists.
 *
 * WHAT IT DOES. The enquiry is the only public write on the platform that is
 * not a signup. It is recorded before it is emailed, because an enquiry that
 * is recorded but not emailed can be recovered from the console and one that
 * is emailed but not recorded is a person waiting on an answer nobody can
 * see. A failing mailer must not fail the request, and the honeypot must be
 * accepted and dropped rather than refused.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-institutional-page.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HTML = read('institutional.html');
const JS   = read('js/institutional.js');
const CSS  = read('css/institutional.css');

console.log('\nwhat the page says');
{
  ok('the provider and the fund manager are named exactly',
     /SmartVest Financial Services \(Pty\) Ltd/.test(HTML)
     && /FSP 52449/.test(HTML)
     && /SV Capital<\/strong> is the fund manager/.test(HTML),
     'the agreement names both; a marketing page that names one is the drift this platform already corrected once');
  ok('capital at risk is stated, not implied',
     /[Cc]apital is at risk/.test(HTML) && /no pool guarantees/i.test(HTML));
  ok('a rate shown before a pool concludes is called a target',
     /target[^.]{0,80}(not a promise|drawn from the underlying)/i.test(HTML));
  ok('past performance carries its warning',
     /[Pp]ast performance is not a guide/.test(HTML));
  ok('the Sharia position is the platform’s, unchanged',
     /no certificate is yet held/i.test(HTML),
     'every other surface says review under way and no certificate — this one may not be softer');

  /* The decision was: no figure. A minimum on a public page is an offer at a
     price, and this audience is quoted in conversation. */
  const MONEY = /R\s?\d[\d  ,]*(?:\.\d\d)?/g;
  const figures = (HTML.match(MONEY) || []).filter(m => !/R\s?52449/.test(m));
  ok('no rand figure is published on the page', figures.length === 0,
     `found ${figures.join(', ')} — a minimum here is an offer at a price`);
  ok('and no minimum is mentioned at all',
     !/minimum|from as little|starting from/i.test(HTML),
     'mandate size is set in conversation; the page says so and names no number');

  /* The retail funnel's vocabulary, which this page exists to avoid. */
  const RETAIL = ['Get Started', 'Sign Up', 'Start investing', 'quest', 'XP',
                  'leaderboard', 'reward', 'referral', 'wallet', 'top up', 'badge'];
  const found = RETAIL.filter(w => new RegExp(w.replace(/ /g, '\\s'), 'i').test(HTML));
  ok('none of the retail funnel’s language appears', found.length === 0, found.join(', '));
}

console.log('\nwhat the page does');
{
  ok('the enquiry posts to the public endpoint',
     /fetch\('\/api\/enquiries\/institutional'/.test(JS));
  ok('there is a honeypot, and it is off-screen rather than display:none',
     /name="company_website"/.test(HTML) && /\.in-hp \{[^}]*left: -9999px/.test(CSS),
     'display:none is both skipped by some autofill and looked for by scripts');
  ok('every value from the API goes in as text, never as markup',
     !/innerHTML/.test(JS),
     'a pool name is typed by a person and this page renders pool names');
  ok('a section with nothing behind it removes itself',
     /id="record"[^>]*style="display:none"/.test(HTML) && /section\.style\.display = ''/.test(JS),
     'R0 returned reads as a result rather than as an absence');
  ok('the page is indexable and declares itself',
     /name="robots" content="index, follow"/.test(HTML)
     && /rel="canonical"/.test(HTML) && /property="og:title"/.test(HTML));
  ok('the strategy table stacks rather than scrolls on a phone',
     /@media \(max-width: 720px\)[\s\S]{0,400}\.in-table thead \{ position: absolute/.test(CSS)
     && /data-label="Pools concluded"/.test(HTML),
     'five columns in 390px pushes the figures off the side into a scroller nobody finds');
}

console.log('\nand it actually reaches the published site');
{
  /* pages:build copies a named list into dist. A page that is not on the
     list is written, linked, reviewed and never served — which is where the
     terms, privacy, PAIA and complaints pages had been sitting, all four of
     them linked from this page's own footer. */
  const pkg = JSON.parse(read('package.json'));
  const build = pkg.scripts['pages:build'] || '';
  for (const page of ['institutional.html', 'terms.html', 'popia.html',
                      'paia.html', 'complaints.html']) {
    ok(`${page} is in the build`, build.includes(page),
       'it exists in the repository and would 404 on the published site');
  }
  const linked = read('index.html');
  ok('and the main site links to it',
     /href="institutional\.html"/.test(linked),
     'a page nothing links to is a page nobody finds');
}

console.log('\nthe endpoint');
{
  const SRC = read('server/routes/enquiries.js');
  const IDX = read('server/index.js');
  ok('it is mounted', /app\.use\('\/api\/enquiries'/.test(IDX));
  ok('it carries its own rate limiter, tighter than the platform’s',
     /rateLimit\(\{[\s\S]{0,200}max: 8/.test(SRC),
     'a public write with the platform-wide limit is a public write with no limit');
  ok('the ticket is written BEFORE the email is attempted',
     SRC.indexOf('INSERT INTO support_tickets') < SRC.indexOf('sendAlert'),
     'emailed but not recorded is somebody waiting on an answer nobody can see');
  ok('and a failing mailer cannot fail the request',
     /sendAlert\([\s\S]{0,200}\.catch\(/.test(SRC));
  ok('investor_id is left NULL deliberately',
     /VALUES \(\$1, NULL,/.test(SRC),
     'it is a foreign key — borrowing an id puts a stranger’s enquiry on somebody’s record');
  ok('the honeypot is accepted and dropped, not refused',
     /company_website[\s\S]{0,200}return res\.json\(\{ ok: true/.test(SRC),
     'an error tells a script what to change');
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const http = require('http');
const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

(async () => {
  let srv, mailed = 0, mailShouldThrow = false;
  try {
    const { rows } = await db.query(
      `SELECT to_regclass('public.support_tickets') IS NOT NULL AS ready`);
    if (!rows[0].ready) {
      console.log('\n  SKIP  no support_tickets table in this database');
      return;
    }
    await db.query(`DELETE FROM support_tickets WHERE category = 'institutional_enquiry'`);

    const express = require('express');
    /* The mailer is stubbed so a check never sends, and so the "a failing
       mailer must not fail the request" case can actually be driven. */
    const mailMod = require.resolve(path.join(ROOT, 'server', 'services', 'email'));
    require.cache[mailMod] = { id: mailMod, filename: mailMod, loaded: true, exports: {
      sendAlert: async () => { mailed++; if (mailShouldThrow) throw new Error('smtp down'); },
    } };
    const app = express();
    app.use(express.json());
    app.use('/api/enquiries', require(path.join(ROOT, 'server', 'routes', 'enquiries')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });

    const post = body => new Promise(res => {
      const p = Buffer.from(JSON.stringify(body));
      const q = http.request({ port: srv.address().port, path: '/api/enquiries/institutional',
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': p.length } },
        x => { let s = ''; x.on('data', c => s += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s || '{}') })); });
      q.end(p);
    });
    const tickets = async () => Number((await db.query(
      `SELECT COUNT(*)::int c FROM support_tickets WHERE category='institutional_enquiry'`)).rows[0].c);

    console.log('\nan enquiry, driven for real');
    const good = await post({ name: 'A. Allocator', capacity: 'institution',
      organisation: 'Pension Fund X', role: 'CIO', email: 'a@example.test',
      message: 'We would like to discuss enterprise finance.' });
    ok('a complete enquiry is accepted', good.status === 200 && good.body.ok === true,
       JSON.stringify(good.body));
    ok('and answers with a reference the sender can quote',
       /^ENQ-[A-Z0-9]+$/.test(good.body.reference || ''), good.body.reference);
    ok('it is on the board as a high-priority open ticket', await tickets() === 1);
    const { rows: [t] } = await db.query(
      `SELECT * FROM support_tickets WHERE category='institutional_enquiry'`);
    ok('with no investor attached', t.investor_id === null);
    ok('and priority high, status open', t.priority === 'high' && t.status === 'open');
    ok('the subject names who it is from', /Pension Fund X/.test(t.subject) && /A\. Allocator/.test(t.subject));
    ok('and the body carries everything they typed',
       /CIO/.test(t.message) && /a@example\.test/.test(t.message)
       && /enterprise finance/.test(t.message));
    ok('somebody was emailed', mailed === 1);

    console.log('\nand what it refuses');
    for (const [label, body] of [
      ['no name',       { email: 'a@example.test', message: 'x' }],
      ['no email',      { name: 'A', message: 'x' }],
      ['an email that cannot be delivered to', { name: 'A', email: 'nope', message: 'x' }],
      ['nothing to discuss', { name: 'A', email: 'a@example.test' }],
    ]) {
      const r = await post(body);
      ok(`${label} is refused`, r.status === 400, JSON.stringify(r.body));
    }
    ok('and none of them reached the board', await tickets() === 1);

    const hp = await post({ name: 'bot', email: 'b@example.test', message: 'spam',
                            company_website: 'http://spam.example' });
    ok('the honeypot is answered as a success', hp.status === 200 && hp.body.ok === true);
    ok('and writes nothing', await tickets() === 1);

    mailShouldThrow = true;
    const stillOk = await post({ name: 'B. Allocator', email: 'b@example.test',
                                 message: 'Second enquiry.' });
    ok('an enquiry still succeeds when the mailer is down', stillOk.status === 200);
    ok('and it is recorded even though no email went', await tickets() === 2,
       'the ticket is the record; the email is a convenience');

    await db.query(`DELETE FROM support_tickets WHERE category = 'institutional_enquiry'`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    if (srv) await new Promise(r => srv.close(r));
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
