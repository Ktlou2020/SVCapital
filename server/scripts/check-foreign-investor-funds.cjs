#!/usr/bin/env node
/* The Foreign Investor Funds Process, as the platform runs it.
 *
 * Source: SV Capital internal process, effective 17 November 2026. Four
 * hard rules — no US persons, rands only, the investor pays all FX costs,
 * and the reference is always their account number — plus a banking detail,
 * two BOP categories and a four-item file per inflow.
 *
 * EVERY ONE OF THOSE IS A FACT THAT NOW LIVES IN MORE THAN ONE PLACE. The
 * server holds it in services/foreignInvestor.js; the portal has to draw it
 * without being able to require() that file, and the console has to offer
 * the same filing items the server will accept. A bank account number that
 * is right in two of three places is money sent somewhere else, and a filing
 * key that is right in the console and wrong on the server is a tick
 * recorded against nothing. So the copies are held to the original here
 * rather than the duplication being wished away.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-foreign-investor-funds.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* Comments stripped before any assertion: the comment above each copy
   explains what it must agree with and therefore quotes the very value
   being looked for. Three times this week. */
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const F = require(path.join(ROOT, 'server', 'services', 'foreignInvestor.js'));

/* ── Who the process applies to ──────────────────────────────────────── */
console.log('\nresidency decides, not nationality');
{
  ok('a South African living in London is a NON-RESIDENT',
     F.isNonResident({ nationality: 'South African', country_of_residence: 'United Kingdom' }),
     'nationality is not what the Reserve Bank\'s reporting turns on');
  ok('and a Kenyan living here is NOT',
     !F.isNonResident({ nationality: 'Kenyan', country_of_residence: 'South Africa' }),
     'the opposite mistake, and the more expensive one — it would put a local '
     + 'client through a cross-border process');
  ok('the status staff set beats the country',
     F.isNonResident({ residency_status: 'non_resident', country_of_residence: 'South Africa' })
     && !F.isNonResident({ residency_status: 'resident', country_of_residence: 'Germany' }),
     'an override that the data overrules back is not an override');
  ok('and an investor with neither reads as resident',
     !F.isNonResident({}) && !F.isNonResident({ country_of_residence: '' }),
     'every client who signed up before this existed has neither, and the '
     + 'platform was South-African-only — guessing the other way would show '
     + 'them all a panel about sending money from abroad');
}

/* ── The US person question ──────────────────────────────────────────── */
console.log('\nand the US person answer has three states, not two');
{
  ok('yes is yes', F.usPersonAnswer(true) === true && F.usPersonAnswer('yes') === true);
  ok('no is no',  F.usPersonAnswer(false) === false && F.usPersonAnswer('no') === false);
  ok('AND NO ANSWER IS NOT A NO',
     F.usPersonAnswer(undefined) === null && F.usPersonAnswer('') === null,
     'the declaration IS the control — an account opened without one has '
     + 'nothing behind it, so a missing answer must not read as a negative one');
}

/* ── The copies ──────────────────────────────────────────────────────── */
console.log('\nand the portal draws the SERVER\'S banking details, not its own');
{
  const CORE = strip(read('js/portal-core.js'));
  const at   = CORE.indexOf('function _svcForeignFunding');
  const blk  = at < 0 ? '' : CORE.slice(at, CORE.indexOf('\n}', at));
  ok('the portal\'s copy was found', at > 0 && blk.length > 200,
     'a slice that missed it would assert nothing while passing');
  ok('and the slice is code, not its comment',
     !/check-foreign-investor-funds asserts/.test(blk), blk.slice(0, 120));

  for (const [field, value] of Object.entries(F.INWARD_BANK)) {
    if (field === 'noIban') continue;
    ok(`${field} agrees with the server (${value})`,
       blk.includes(`'${value}'`),
       `${value} is not in the portal's copy — a bank account number that is `
       + 'right in one of two places is money sent somewhere else');
  }
  /* The four rules are what a client is told BEFORE they pay, and each one
     is a way the payment goes wrong if they are not. */
  for (const rule of F.INWARD_RULES) {
    const head = rule.slice(0, 34);
    ok(`the portal carries the rule "${head}…"`, blk.includes(head), head);
  }
  ok('and says South Africa has no IBAN',
     /does not use IBAN/.test(blk),
     'a foreign bank asks for one and a client cannot fill it; saying so is '
     + 'the difference between a stuck payment and a sent one');

  /* And it is shown to the right people. */
  ok('THE PANEL IS FOR NON-RESIDENTS ONLY',
     /function svcIsNonResident/.test(CORE)
     && /svcIsNonResident\(PORTAL\.investor\)/.test(CORE),
     'a South African paying from a South African bank does not need a SWIFT code');
  for (const file of ['portal/index.html', 'mobile/www/index.html'])
    ok(`${file.split('/')[0]} has somewhere to draw it`,
       read(file).includes('id="walletForeignPanel"'), file);
}

console.log('\nand the console offers the filing items the server will accept');
{
  const ADMIN = strip(read('admin/js/admin.js'));
  for (const key of F.FILING_KEYS)
    ok(`the console knows ${key}`, ADMIN.includes(`'${key}'`),
       'the server refuses an item it does not know, so a key that is right '
       + 'in one place and wrong in the other is a tick recorded against nothing');
  ok('and it uses the server\'s outflow code verbatim',
     ADMIN.includes('510/02'), F.bopLabel(F.BOP_OUTFLOW));
  ok('the panel is for non-residents only',
     /function _isNonResidentInvestor/.test(ADMIN)
     && /_isNonResidentInvestor\(inv\)/.test(ADMIN));
  ok('and only money in and out can carry a BOP category',
     /\['deposit', 'withdrawal'\]\.includes\(t\.type\)/.test(ADMIN),
     'an internal transfer or a fee never crosses a border and has no '
     + 'category to carry');
}

/* ── The BOP categories ──────────────────────────────────────────────── */
console.log('\nand a cross-border investment is never a loan, a gift or other');
{
  ok('the inflow category is the one the process names',
     F.BOP_INFLOW.label === 'Investment by a non-resident individual', F.BOP_INFLOW.label);
  ok('AND THE PAYOUT IS 510/02',
     F.BOP_OUTFLOW.code === '510/02'
     && /Disinvestment by a non-resident individual/.test(F.BOP_OUTFLOW.label),
     F.bopLabel(F.BOP_OUTFLOW));
  ok('the three forbidden codings are written down',
     ['loan', 'gift', 'other'].every(w => F.BOP_INFLOW_FORBIDDEN.includes(w)),
     JSON.stringify(F.BOP_INFLOW_FORBIDDEN));

  /* The endpoint takes a KEY and looks the label up, so a category cannot be
     typed in at all. */
  const ROUTE = strip(read('server/routes/foreignFunds.js'));
  ok('the endpoint maps a key to a label rather than taking one',
     /const ALLOWED = \{/.test(ROUTE) && /if \(!\(key in ALLOWED\)\)/.test(ROUTE),
     'a free text box here is exactly how an investment gets filed as a loan');
  ok('and the investor update is a named whitelist',
     /const fields = \{/.test(ROUTE) && !/Object\.assign\(.*req\.body/.test(ROUTE),
     'spreading req.body into an UPDATE turns this into a way to set a '
     + 'wallet balance');
}

/* ── The ledger carries it ───────────────────────────────────────────── */
console.log('\nand the transaction row remembers how it was reported');
{
  const L = require(path.join(ROOT, 'server', 'services', 'ledger.js'));
  ok('bop_category is a transaction column', L.TX_COLUMNS.includes('bop_category'),
     L.TX_COLUMNS.join(', '));
  ok('and so is payout_currency', L.TX_COLUMNS.includes('payout_currency'));
  ok('so every fixture built from the column list has them too',
     /bop_category/.test(L.transactionsFixtureDDL()) && /payout_currency/.test(L.transactionsFixtureDDL()),
     'a check whose fixture lacks the column would pass while the real insert fails');
}

/* ── The signup gate ─────────────────────────────────────────────────── */
console.log('\nand the signup form asks before it can be submitted');
{
  const SIGNUP = strip(read('signup.html'));
  ok('the declaration is on the form', /name="usPerson"/.test(SIGNUP));
  ok('with both answers', /value="yes"/.test(SIGNUP) && /value="no"/.test(SIGNUP));
  ok('IT IS NOT A TICK BOX',
     !/id="usPersonCheck"/.test(SIGNUP) && /type="radio"/.test(SIGNUP),
     'a box you tick to confirm you are NOT something is read as consent and '
     + 'clicked through');
  ok('an unanswered question is refused',
     /us === null/.test(SIGNUP) && /Please answer the US citizen/.test(SIGNUP),
     'a missing declaration is not a negative one');
  ok('and a yes stops the signup there',
     /us === true/.test(SIGNUP) && /showUsPersonBlock\(\)/.test(SIGNUP), 'signup.html');
  ok('country of residence is sent as a field, not buried in a note',
     /countryOfResidence:/.test(SIGNUP), 'signup.html');
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

(async () => {
  let srv;
  try {
    const { rows: [r] } = await db.query(
      `SELECT to_regclass('public.foreign_inflow_files') IS NOT NULL AS ready`);
    if (!r.ready) { console.log('\n  SKIP  schema not applied in this database'); return; }

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/auth',          require(path.join(ROOT, 'server', 'routes', 'auth.js')));
    app.use('/api/foreign-funds', require(path.join(ROOT, 'server', 'routes', 'foreignFunds.js')));
    srv = await new Promise(x => { const s = app.listen(0, () => x(s)); });

    const call = (method, p, body, token) => new Promise(res => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const q = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign(token ? { Authorization: `Bearer ${token}` } : {},
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s = ''; x.on('data', c => s += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s || '{}') })); });
      if (payload) q.write(payload);
      q.end();
    });
    const staff = jwt.sign({ id: 'u-ff', email: 'ops@example.test', role: 'admin' },
                           process.env.JWT_SECRET, { expiresIn: '1h' });

    const signup = extra => call('POST', '/api/auth/register', Object.assign({
      email: `ff-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`,
      password: 'Abcdefgh12', firstName: 'Foreign', lastName: 'Applicant',
      termsAccepted: true, popiaAccepted: true, ficaConsent: true,
    }, extra));

    console.log('\nand the server refuses a US person before an account exists');
    {
      const before = (await db.query(`SELECT COUNT(*)::int AS n FROM investors`)).rows[0].n;
      const res = await signup({ countryOfResidence: 'United States', usPerson: true });
      ok('THE REGISTRATION IS REFUSED', res.status === 403,
         `${res.status} ${JSON.stringify(res.body).slice(0, 140)}`);
      ok('and says why, in the process\'s own terms',
         /US citizens or US persons/.test(res.body.error || ''), res.body.error);
      const after = (await db.query(`SELECT COUNT(*)::int AS n FROM investors`)).rows[0].n;
      ok('AND NOTHING WAS WRITTEN', after === before,
         `${before} → ${after} — declining after the account exists leaves a US `
         + 'person on the platform, which is the thing the rule avoids');
    }

    console.log('\nand a non-resident who does not answer is refused too');
    {
      const res = await signup({ countryOfResidence: 'Germany' });
      ok('it is refused', res.status === 400, `${res.status} ${JSON.stringify(res.body).slice(0, 140)}`);
      ok('and asks for the answer', /US citizen/.test(res.body.error || ''), res.body.error);
    }

    console.log('\nand a non-resident who declares is accepted and recorded');
    {
      const email = `ff-ok-${Date.now()}@example.test`;
      const res = await signup({ email, countryOfResidence: 'United Kingdom', usPerson: false });
      ok('the registration succeeds', res.status === 200 || res.status === 201,
         `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
      const { rows: [inv] } = await db.query(
        `SELECT i.* FROM investors i JOIN users u ON u.investor_id = i.id
          WHERE lower(u.email) = lower($1)`, [email]);
      ok('the investor exists', !!inv);
      if (inv) {
        ok('country of residence is a COLUMN now', inv.country_of_residence === 'United Kingdom',
           String(inv.country_of_residence) + ' — it used to live only inside a notes string');
        ok('and they are marked non-resident', inv.residency_status === 'non_resident',
           String(inv.residency_status));
        ok('THE DECLARATION IS KEPT, not just acted on',
           inv.us_person === false, String(inv.us_person));
        ok('with when it was made', !!inv.us_person_declared_at, String(inv.us_person_declared_at));
        ok('and the wording it was made against',
           inv.us_person_declaration_version === F.US_PERSON_VERSION,
           String(inv.us_person_declaration_version)
           + ' — a declaration is evidence, and evidence has to say what was agreed to');
      }
    }

    console.log('\nand a South African is not asked at all');
    {
      const email = `ff-sa-${Date.now()}@example.test`;
      const res = await signup({ email, countryOfResidence: 'South Africa' });
      ok('the registration succeeds with no declaration',
         res.status === 200 || res.status === 201, `${res.status}`);
      const { rows: [inv] } = await db.query(
        `SELECT residency_status, us_person FROM investors i
           JOIN users u ON u.investor_id = i.id WHERE lower(u.email) = lower($1)`, [email]);
      ok('and they are marked resident', inv && inv.residency_status === 'resident',
         inv && String(inv.residency_status));
      ok('with no declaration recorded', inv && inv.us_person === null,
         inv && String(inv.us_person)
         + ' — "was never asked" and "declared they are not" are different facts');
    }

    console.log('\nand an inflow cannot be coded as something it was not');
    {
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance,
                                residency_status, country_of_residence)
         VALUES ('INV-FF-1','Nadia','Abroad','ff-1@example.test','active',0,
                 'non_resident','United Kingdom')
         ON CONFLICT (id) DO NOTHING`);
      await db.query(
        `INSERT INTO transactions (id, investor_id, type, amount, status, reference, actor_kind)
         VALUES ('TXN-FF-1','INV-FF-1','deposit',25000,'completed','FF-REF-1','staff')
         ON CONFLICT (id) DO NOTHING`);

      for (const bad of F.BOP_INFLOW_FORBIDDEN) {
        const res = await call('PATCH', '/api/foreign-funds/transactions/TXN-FF-1/bop',
                               { category: bad }, staff);
        ok(`"${bad}" is refused`, res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);
      }
      const good = await call('PATCH', '/api/foreign-funds/transactions/TXN-FF-1/bop',
                              { category: 'inflow' }, staff);
      ok('and the one real category is accepted', good.status === 200, JSON.stringify(good.body));
      const { rows: [t] } = await db.query(
        `SELECT bop_category FROM transactions WHERE id = 'TXN-FF-1'`);
      ok('and stored verbatim', t.bop_category === F.bopLabel(F.BOP_INFLOW), String(t.bop_category));
    }

    console.log('\nand the file for an inflow is recorded, item by item');
    {
      const bad = await call('PUT', '/api/foreign-funds/transactions/TXN-FF-1/files',
                             { items: ['payment_confirmation', 'something_else'] }, staff);
      ok('an item the server does not know is refused', bad.status === 400,
         `${bad.status} ${JSON.stringify(bad.body)}`);

      const part = await call('PUT', '/api/foreign-funds/transactions/TXN-FF-1/files',
                              { items: ['payment_confirmation'] }, staff);
      ok('a partial file is accepted', part.status === 200, JSON.stringify(part.body));
      ok('and reported as incomplete', part.body.complete === false, String(part.body.complete));

      const full = await call('PUT', '/api/foreign-funds/transactions/TXN-FF-1/files',
                              { items: F.FILING_KEYS }, staff);
      ok('ALL FOUR MAKES IT COMPLETE', full.body.complete === true, JSON.stringify(full.body));

      /* Unticking has to be as recordable as ticking, or the checklist only
         ever grows and stops describing anything. */
      const undo = await call('PUT', '/api/foreign-funds/transactions/TXN-FF-1/files',
                              { items: [] }, staff);
      ok('and removing everything is recorded too', undo.status === 200 && undo.body.complete === false,
         JSON.stringify(undo.body));
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM foreign_inflow_files WHERE transaction_id = 'TXN-FF-1'`);
      ok('with nothing left behind', rows[0].n === 0, String(rows[0].n));
    }

    console.log('\nand a client cannot reach any of it');
    {
      const tok = jwt.sign({ id: 'u-c', role: 'investor', investorId: 'INV-FF-1' },
                           process.env.JWT_SECRET, { expiresIn: '1h' });
      const res = await call('PATCH', '/api/foreign-funds/investors/INV-FF-1',
                             { residencyStatus: 'resident' }, tok);
      ok('the role is refused', res.status === 403 || res.status === 401, String(res.status));
    }

    await db.query(`DELETE FROM transactions WHERE id = 'TXN-FF-1'`);
    await db.query(`DELETE FROM investors WHERE id = 'INV-FF-1'`);
    await db.query(`DELETE FROM users WHERE email LIKE 'ff-%@example.test'`);
    await db.query(`DELETE FROM investors WHERE email LIKE 'ff-%@example.test'`);
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
