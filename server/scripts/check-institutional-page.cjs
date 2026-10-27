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
const JS   = read('js/institutional.js');   /* this page's renderer */
const SHARED = read('js/enquiry.js');       /* the fetch and the form, shared */
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

  /* The decision was: no figure for the mandate. A minimum on a public page
     is an offer at a price, and this audience is quoted in conversation.

     The page now quotes platform figures in the impact section — what has
     been deployed, what has been paid back — and that is track record, not
     a price. So the rule is the narrower one it always meant: NOTHING on
     this page may be presented as a threshold, a minimum or an entry level.

       is in the money class because that is the separator
     toLocaleString('en-ZA') produces — R100 000, not R100 000 — so a figure
     pasted from anywhere else on the platform would have slipped straight
     past a guard that only knew the ordinary space. */
  const MONEY = /R\s?\d[\d  ,]*(?:\.\d\d)?(?:\s?million|M\+?)?/gi;
  const THRESHOLD = /(minimum|min\.|as little as|starts? (?:at|from)|starting (?:at|from)|from just|entry point|invest from|ticket size)/i;
  const priced = [];
  for (const m of HTML.matchAll(MONEY)) {
    if (/R\s?52449/.test(m[0])) continue;
    const ctx = HTML.slice(Math.max(0, m.index - 110), m.index + m[0].length + 70);
    if (THRESHOLD.test(ctx)) priced.push(m[0].trim());
  }
  ok('no figure on the page is quoted as a threshold', priced.length === 0,
     `found ${priced.join(', ')} — a minimum here is an offer at a price`);
  ok('and no minimum is mentioned at all',
     !/minimum|from as little|starting from/i.test(HTML),
     'mandate size is set in conversation; the page says so and names no number');
  ok('the retail minimums in particular are nowhere near it',
     !/R\s?500\b/.test(HTML) && !/R\s?10[  ]?000\b/.test(HTML) && !/R\s?100[  ]?000\b/.test(HTML));

  /* The retail funnel's vocabulary, which this page exists to avoid.
     Matched on whole words. As loose substrings these bite honest prose and
     would have to be worked around rather than obeyed: "quest" is inside
     "request", and "XP" is inside "experience" and "expect". A check that
     forbids a word nobody meant to forbid gets disabled, not satisfied. */
  const RETAIL = ['Get Started', 'Sign Up', 'Start investing', 'quests?', 'XP',
                  'leaderboard', 'rewards?', 'referrals?', 'wallet', 'top up', 'badges?'];
  const found = RETAIL.filter(w =>
    new RegExp(`\\b${w.replace(/ /g, '\\s')}\\b`, 'i').test(HTML));
  ok('none of the retail funnel’s language appears', found.length === 0, found.join(', '));
}

console.log('\nwhat the page does');
{
  ok('the enquiry posts to the public endpoint',
     /fetch\('\/api\/enquiries\/institutional'/.test(SHARED));
  ok('there is a honeypot, and it is off-screen rather than display:none',
     /name="company_website"/.test(HTML) && /\.in-hp \{[^}]*left: -9999px/.test(CSS),
     'display:none is both skipped by some autofill and looked for by scripts');
  ok('every value from the API goes in as text, never as markup',
     !/innerHTML/.test(JS) && !/innerHTML/.test(SHARED),
     'a pool name is typed by a person and this page renders pool names');
  ok('a section with nothing behind it removes itself',
     /id="record"[^>]*style="display:none"/.test(HTML) && /section\.style\.display = ''/.test(JS)
     && /if \(concluded <= 0\) return;/.test(SHARED),
     'R0 returned reads as a result rather than as an absence');
  ok('the renderer is loaded before the script that dispatches to it',
     HTML.indexOf('js/institutional.js') < HTML.indexOf('js/enquiry.js'),
     'the listener has to be registered before enquiry.js fires on DOMContentLoaded');
  ok('the page is indexable and declares itself',
     /name="robots" content="index, follow"/.test(HTML)
     && /rel="canonical"/.test(HTML) && /property="og:title"/.test(HTML));
}

/* Prose on these pages is hand-wrapped, so a sentence that reads as one
   line in the browser is three in the source with newlines and indentation
   inside it. Every assertion below about what the page SAYS runs against a
   whitespace-flattened copy; a regex written against the raw source passes
   or fails on where somebody happened to break the line. */
const FLAT = HTML.replace(/\s+/g, ' ');

console.log('\none business, and only one');
{
  /* The positioning: an asset-backed private lending fund in agriculture,
     with a nine-year record in cattle. Said in those words, because a
     reader who allocates to private credit is looking for that shape and
     will not go hunting for it in a description of pooled investments. */
  ok('it says what kind of fund this is',
     /asset-backed/i.test(FLAT) && /\blend(?:ing|s|er|ers)?\b/i.test(FLAT),
     'private credit is the category; the page has to name it');
  ok('and what it lends against',
     /(cattle|livestock|herd)/i.test(FLAT) && /agricultur/i.test(FLAT));
  ok('and how long it has been doing it',
     /(nine years|9 years)/i.test(FLAT) && /cattle/i.test(FLAT),
     'the track record is in cattle and is the strongest thing the page has');
  ok('the collateral is named as collateral, not implied',
     /(the herd is the (security|collateral)|herd as the collateral|herd itself)/i.test(FLAT));

  /* THE RULE: nothing but agriculture. The platform runs other product
     types and this page is not for them. Every term below belonged to one
     of the asset classes that used to be on this page, and each one is a
     way the old positioning creeps back — usually in a sentence somebody
     adds for completeness. */
  const ELSEWHERE = {
    'solar':            /\bsolar\b/i,
    'photovoltaic':     /photovoltaic/i,
    'panels':           /\bpanels?\b/i,
    'a power offtake':  /(power purchase|\bPPA\b|selling power|clean energy|renewable)/i,
    'enterprise finance': /enterprise finance/i,
    'purchase-order finance': /purchase[- ]order/i,
    'SMMEs':            /\bSMME/i,
    'the other partner': /MoolaLend/i,
    'the ethical range': /(Murabaha|Ijara|Mudarabah|Sharia|interest-free|Islamic finance)/i,
    'short-term investment': /short[- ]term investment/i,
  };
  const strayed = Object.entries(ELSEWHERE)
    .filter(([, re]) => re.test(FLAT)).map(([name]) => name);
  ok('no other asset class appears anywhere on the page',
     strayed.length === 0, strayed.join(', ') + ' — this page is agriculture only');

  /* And the same rule where the figures come from. A page that says nine
     years in cattle while quoting the whole platform's repayments is
     attributing somebody else's book to this one, which is the
     misstatement on this page that would matter most. */
  ok('and the live figures are the cattle book, not the platform',
     /const FAMILIES = \{\s*cattle: \[[^\]]*\],?\s*\}/.test(SHARED)
     && !/solar|eif_|short_term|smme/i.test(SHARED.slice(SHARED.indexOf('const FAMILIES'),
                                                         SHARED.indexOf('async function'))),
     'the aggregation decides what the track record on this page means');
}

console.log('\nthe only way in is to ask');
{
  /* The page used to end a reader's journey by pointing them at the retail
     funnel to open an account themselves. It no longer does, on purpose: at
     this level an allocation begins with a conversation, and a self-serve
     route is both the wrong first impression and a way for somebody to
     arrive on the platform without anyone having spoken to them. */
  ok('nothing on the page opens an account',
     !/signup\.html/.test(HTML) && !/login\.html/.test(HTML),
     'a sign-up link is the self-serve route this page exists not to offer');
  ok('and no button invites them to invest directly',
     !/Invest Now|Start investing|Open an account|Invest online/i.test(HTML));
  ok('the page says what to do instead, where it is read first',
     /[Ss]hould you wish to invest.{0,160}(contact us|#talk|#enquiry)/i.test(FLAT),
     'removing the route without naming the alternative is a dead end');
  ok('and the form is plainly a contact form',
     /<h2>Contact us<\/h2>/.test(HTML));
  ok('it says why there is nothing to click, rather than leaving a gap',
     /no way to invest from this page/i.test(FLAT),
     'an absence somebody notices and cannot explain reads as a broken page');
}

console.log('\nwhat it now tells somebody about us');
{
  ok('there is a section about SV Capital', /id="about"/.test(HTML));
  ok('naming who carries the licence, again, in full',
     /SmartVest Financial Services \(Pty\) Ltd.{0,200}FSP 52449/.test(FLAT)
     && /Financial Sector Conduct Authority/.test(FLAT));
  ok('and how a client is onboarded', /FICA and AML/.test(FLAT));
  ok('and that the operating partner is diligenced first',
     /diligence|diligenced/i.test(FLAT) && /Beefcor/.test(FLAT));
  ok('the recognition is dated rather than floated',
     (HTML.match(/20(?:25|24|18|17)/g) || []).length >= 5,
     'an award with no year is a claim with no date');

  ok('how the lending works is set out, step by step',
     /How the lending works/.test(FLAT));
  ok('naming the operator and the contract that fixes the price',
     /Beefcor/.test(FLAT) && /offtake agreement/.test(FLAT));
  ok('what secures it, and what it is insured against',
     /insured against disease, theft and natural hazards/.test(FLAT));
  ok('and what has to happen before anybody is paid',
     /reach weight/.test(FLAT) && /offtake has to be honoured/.test(FLAT),
     'the mechanics without the condition is a brochure');

  ok('the impact figures are there', /id="impact"/.test(HTML));
  ok('and they say what they are figures FOR',
     /(platform-wide|the whole platform|across (?:all|every))/i.test(FLAT)
     && /not the record of (?:any )?one pool/i.test(FLAT),
     'a cumulative platform number read as a pool\u2019s record is the oldest trick in the brochure');
  ok('with past performance still carrying its warning beside them',
     /not the record of (?:any )?one pool.{0,200}[Pp]ast performance is not a guide/i.test(FLAT));
}

console.log('\nand what it does not carry');
{
  /* Named because they were named: the retail page's social proof and its
     entry price are the two things that make this page read as the funnel
     it is meant to sit apart from. */
  ok('no investor stories',
     !/testimonial/i.test(HTML) && !/investor stories/i.test(HTML)
     && !/\u201c[^\u201d]{40,}\u201d\s*<\/?(?:p|blockquote|span)/.test(HTML),
     'a quoted individual is retail social proof, whatever the page around it says');
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

  /* The split. This page is now addressed to institutions, family offices
     and advisers; somebody placing their own money has a page of their own
     and must not have to read about investment committees to discover that
     this is not it. */
  ok('it does not present itself as the private-client page as well',
     !/Institutional &(amp;)? [Pp]rivate [Cc]lients/.test(HTML),
     'two audiences, two pages — the title said it served both');
  ok('and it sends a private reader across, above the fold',
     /private-clients\.html/.test(HTML.slice(0, HTML.indexOf('id="record"'))),
     'the footer is not where somebody decides a page is not for them');
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
