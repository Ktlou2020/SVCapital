#!/usr/bin/env node
/* What FICA stops, and what it does not.
 *
 * THE RULE, confirmed by the business and now written once: money may
 * reach this platform before we have identified who sent it, and may not
 * leave until we have. A client invests at any FICA status. A client
 * withdraws only once approved. Nothing an unverified client pays in can
 * be taken out again by them, which is what stops the platform being used
 * to move money.
 *
 * ── WHAT WAS ACTUALLY THERE ──────────────────────────────────────────
 *
 * INVESTING WAS GATED, one step upstream of where anybody looked. The
 * investment itself had no FICA check at all — but an investor's money
 * does not move without a matching signed agreement (routes/tables.js),
 * and routes/agreements.js refused to DRAW an agreement until FICA was
 * approved. The symptom reported from production was a client with a
 * funded wallet, a filled-in amount, and "Your FICA verification must be
 * approved before you can sign an investment agreement."
 *
 * WITHDRAWING WAS GATED THREE TIMES, differently:
 *
 *   withdrawals.js  personal      fica='approved' OR kyc='verified'
 *   withdrawals.js  sub-account   kyc='approved'
 *   tables.js       generic       fica IN (approved,verified)
 *                                   OR kyc IN (approved,verified)
 *
 * The first disagreed with the third about a real client. Document
 * approval writes kyc_status='approved', and the personal route did not
 * accept that value. The portal posts to the personal route, so the
 * strictest gate was the live one and a FICA-approved client was told
 * their verification was incomplete. That state is not hypothetical:
 * routes/manualCredit.js carries a backfill written to repair investors
 * whose fica_status is out of step with an approved kyc_status.
 *
 * The third tested for fica_status='verified', which the column's own
 * constraint does not permit and nothing writes. It read as generosity
 * and was dead.
 *
 * AND THE AGREEMENT GATE READ THE TWO COLUMNS WITH `||`, so a truthy
 * 'pending' in the first meant the second was never looked at — it
 * refused clients who were, in fact, approved.
 *
 * ── HOW THIS CHECK WORKS ─────────────────────────────────────────────
 *
 * The gates are driven through the real routes over a real database,
 * because a grep for ficaRefusal passes against a route that calls it
 * and ignores the answer. The predicate's own truth table is unit
 * tested, since the interesting values are the ones no fixture happens
 * to carry.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-fica-gates.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const db   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
/* Comments quote the rules they replaced, including the exact strings
   this check scans for. Scanning the source with them still in is how a
   probe comes to find its own explanation and report the bug as live. */
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const ACCESS       = require(path.join(ROOT, 'server/services/withdrawalAccess.js'));
const WITHDRAWALS  = read('server/routes/withdrawals.js');
const AGREEMENTS   = read('server/routes/agreements.js');
const TABLES       = read('server/routes/tables.js');
const SETUP        = read('server/db/setup.js');

const INV_OK   = 'INV-FICA-OK';     // kyc_status approved, fica_status NULL
const INV_NO   = 'INV-FICA-NO';     // nothing approved
const SA_OK    = 'SA-FICA-OK';
const SA_NO    = 'SA-FICA-NO';

/* ═══════════════════════════════════════════════════════════════════
   1. One question, and what it answers
   ═══════════════════════════════════════════════════════════════════ */
console.log('\nthere is one question, and it is asked of both columns');
{
  ok('withdrawalAccess answers it',
     typeof ACCESS.ficaCleared === 'function' && typeof ACCESS.ficaRefusal === 'function');

  const T = [
    [{ fica_status: 'approved' },                        true,  'fica approved'],
    [{ kyc_status:  'approved' },                        true,  'kyc approved — the value the personal route refused'],
    [{ kyc_status:  'verified' },                        true,  'kyc verified — what the automated check writes'],
    [{ fica_status: 'pending', kyc_status: 'approved' }, true,  'approved behind a stale pending'],
    [{ fica_status: 'APPROVED' },                        true,  'case and whitespace do not decide it'],
    [{ fica_status: 'pending' },                         false, 'pending'],
    [{ fica_status: 'rejected', kyc_status: 'rejected' }, false, 'rejected'],
    [{ fica_status: 'submitted' },                       false, 'submitted but not decided'],
    [{ kyc_status:  'under_review' },                    false, 'a group still being reviewed'],
    [{},                                                 false, 'a row with neither column'],
    [null,                                               false, 'no row at all'],
  ];
  for (const [holder, want, label] of T) {
    ok(`  ${label} → ${want ? 'cleared' : 'refused'}`,
       ACCESS.ficaCleared(holder) === want, JSON.stringify(holder));
  }

  /* THE `||` BUG, NAMED. This is the one that made agreements.js refuse
     approved clients, and it is invisible in a fixture whose fica_status
     happens to be NULL. */
  ok('A STALE fica_status DOES NOT HIDE AN APPROVED kyc_status',
     ACCESS.ficaCleared({ fica_status: 'pending', kyc_status: 'approved' }) === true,
     '`fica_status || kyc_status` reads the second only when the first is '
     + 'falsy, so a pending first column refused a client who was approved');

  /* Narrowed deliberately: the column's constraint does not allow it and
     nothing writes it. If that changes, this says so rather than letting
     a live value be quietly refused. */
  ok("fica_status = 'verified' is not accepted, because nothing writes it",
     ACCESS.ficaCleared({ fica_status: 'verified' }) === false
     && !ACCESS.FICA_CLEARED_FICA_STATUS.includes('verified'));
  /* STRIPPED, because tables.js now carries a comment saying it used to
     accept fica_status = 'verified' — and this scan found that sentence
     and reported the value as live. */
  const writesIt = fs.readdirSync(path.join(ROOT, 'server/routes'))
    .filter(f => /\.js$/.test(f))
    .some(f => /fica_status\s*=\s*'verified'/.test(
      strip(read(path.join('server/routes', f)))));
  ok('  and still nothing does', !writesIt,
     "something now writes fica_status='verified' — add it to "
     + 'FICA_CLEARED_FICA_STATUS or those clients cannot withdraw');
}

console.log('\nand the refusal it hands back says what to do');
{
  ok('cleared gets no refusal', ACCESS.ficaRefusal({ kyc_status: 'approved' }) === null);
  const personal = ACCESS.ficaRefusal({ fica_status: 'pending' }) || '';
  ok('and a refusal is a sentence, not a boolean', personal.length > 40, personal);
  ok('  naming FICA / KYC', /FICA/.test(personal) && /KYC/.test(personal), personal);

  /* The sub-account message was "Sub-account FICA/KYC verification is
     required before withdrawing funds." — it named neither the account
     nor anything to do about it, and "your verification" sends the owner
     to their own screen, where there is nothing to fix. */
  const group = ACCESS.ficaRefusal({ kyc_status: 'pending' }, { accountName: 'Puno Stokvel' }) || '';
  ok('A SUB-ACCOUNT REFUSAL NAMES THE ACCOUNT', /Puno Stokvel/.test(group), group);
  ok('  and says the documents are its own, not the owner’s',
     /separately/.test(group) && !/your FICA/.test(group), group);
}

/* ═══════════════════════════════════════════════════════════════════
   2. Every withdrawal gate asks it, and none keeps its own
   ═══════════════════════════════════════════════════════════════════ */
console.log('\nand all three withdrawal gates ask that one question');
{
  const W = strip(WITHDRAWALS);
  const T = strip(TABLES);

  ok('the personal route asks it', /access\.ficaRefusal\(investor\)/.test(W), W.slice(0, 80));
  ok('the sub-account route asks it, about the sub-account',
     /access\.ficaRefusal\(saRow,\s*\{\s*accountName/.test(W));
  ok('and the generic transaction route asks it',
     /ficaRefusal\(ficaRows\[0\]\)/.test(T));

  /* NO SECOND ANSWER ANYWHERE. A route that keeps its own comparison is
     a route that will drift from this one, which is how the three came
     to disagree in the first place. */
  const inlineW = (W.match(/(?:fica|kyc)_status\s*[=!]==/g) || []);
  ok('THE WITHDRAWAL ROUTES KEEP NO COMPARISON OF THEIR OWN',
     inlineW.length === 0, 'still comparing by hand: ' + inlineW.join(', '));

  /* tables.js is a 2 800-line file that legitimately reads these columns
     elsewhere (FICA approval, status normalisation), so the ban is
     scoped to its withdrawal gate. */
  /* ANCHORED IN THE RAW FILE AND STRIPPED AFTERWARDS. The anchor is a
     comment, and looking for it in text whose comments have been removed
     found nothing — the assertion failed against a gate that was fine. */
  const at = TABLES.indexOf('Withdrawal FICA gate');
  ok('the withdrawal gate in tables.js is findable', at > 0,
     'the comment this assertion slices on has gone');
  const gate = at > 0 ? strip(TABLES.slice(at, at + 1400)) : '';
  const inlineT = (gate.match(/(?:fica|kyc)_status\s*[=!]==/g) || []);
  ok('  and it keeps none either', inlineT.length === 0, inlineT.join(', '));
}

/* ═══════════════════════════════════════════════════════════════════
   3. Investing is not gated on FICA
   ═══════════════════════════════════════════════════════════════════ */
console.log('\nand nothing refuses an investment for want of FICA');
{
  const A = strip(AGREEMENTS);
  ok('THE AGREEMENT IS DRAWN WHATEVER THE FICA STATUS',
     !/must be approved before you can sign/.test(A)
     && !/return res\.status\(403\)[^\n]*FICA/.test(A),
     'this was the gate that actually stopped unverified clients '
     + 'investing, because an investment will not fund without a signed '
     + 'agreement');

  /* The exact string from the production screenshot, gone from the whole
     repository rather than from one file. */
  const msg = 'Your FICA verification must be approved before you can sign';
  const hits = ['server/routes/agreements.js', 'js/portal-core.js', 'portal/js/portal.js']
    .filter(f => fs.existsSync(path.join(ROOT, f)) && read(f).includes(msg));
  ok('  and the message a client saw is gone with it', hits.length === 0, hits.join(', '));

  /* The investment POST never had a FICA gate and must not grow one. */
  const T = strip(TABLES);
  const at = T.indexOf("if (table === 'investments') {\n      const rawAmount");
  const block = at > 0 ? T.slice(at, at + 6000) : T;
  ok('and the investment itself still has none',
     !/(?:fica|kyc)_status/.test(block),
     'a gate added here would stop investing just as surely: ' + block.slice(0, 160));
}

console.log('\nbut the fact is recorded, because the status moves afterwards');
{
  const A = strip(AGREEMENTS);
  ok('the agreement records whether we had identified them at signing',
     /fica_cleared_at_signing/.test(A) && /ACCESS\.ficaCleared\(inv\)/.test(A),
     'without it, a client verified next week looks in the record as '
     + 'though they had been verified all along, and nobody can answer '
     + '"which agreements were signed before we knew who they were"');
  ok('and the column exists for a new database',
     /fica_cleared_at_signing\s+BOOLEAN/.test(SETUP));
  ok('AND IS ADDED TO AN EXISTING ONE',
     /ALTER TABLE investment_agreements[\s\S]{0,120}ADD COLUMN IF NOT EXISTS fica_cleared_at_signing/.test(SETUP),
     'CREATE TABLE IF NOT EXISTS adds nothing to a table that already '
     + 'exists, which is every database but a brand new one');
}

/* ═══════════════════════════════════════════════════════════════════
   4. The handbook, which taught the opposite
   ═══════════════════════════════════════════════════════════════════ */
console.log('\nand the handbook teaches the rule the platform applies');
{
  /* SCOPED TO THE COURSE DEFINITION. The migration below has to quote
     the wrong sentence in order to replace it, so scanning the whole
     file for that sentence found the fix and reported it as the bug. */
  const coursesAt  = SETUP.indexOf('const STANDARD_COURSES = [');
  const coursesEnd = SETUP.indexOf('async function seedStandardCourses', coursesAt);
  ok('the course definitions are still findable',
     coursesAt > 0 && coursesEnd > coursesAt, `${coursesAt} → ${coursesEnd}`);
  const COURSES = coursesAt > 0 ? SETUP.slice(coursesAt, coursesEnd) : '';
  ok('and there is a body of course text to check', COURSES.length > 20000,
     String(COURSES.length));

  ok('THE CLAIM THAT CLIENTS CANNOT INVEST UNTIL APPROVED IS GONE',
     !/Clients cannot invest until their FICA status is Approved/.test(COURSES),
     'staff were trained on a rule the platform does not apply');
  ok('and the graded quiz answer no longer marks the truth wrong',
     !/clients cannot invest until FICA status is Approved/.test(COURSES)
     && !/No investment can be processed until the client/.test(COURSES),
     'the explanation told them FICA was "a hard gate" on investing');
  ok('it now says which way round it is',
     /can invest before their FICA status is Approved/.test(COURSES)
     && /cannot withdraw/i.test(COURSES));
  ok('and the quiz asks that',
     /They can invest, but they cannot withdraw until FICA is Approved/.test(COURSES));

  /* THE SEED CANNOT REACH AN EXISTING DATABASE. seedStandardCourses
     inserts ON CONFLICT (id) DO NOTHING and writes modules only when
     that insert created a row. Correcting the text above and stopping
     would leave the wrong lesson live everywhere and look fixed. */
  ok('SEEDING STILL CANNOT OVERWRITE AN EXISTING COURSE',
     /INSERT INTO employee_courses[\s\S]{0,700}ON CONFLICT \(id\) DO NOTHING/.test(SETUP),
     'if this ever changes, the migration below stops being the only way '
     + 'the correction reaches production');
  ok('SO THERE IS A MIGRATION THAT REWRITES IT',
     /UPDATE course_modules[\s\S]{0,400}Clients cannot invest until their FICA status is Approved/.test(SETUP),
     'without it the fix is invisible on every database that already has '
     + 'the course, production included');
  ok('  which also replaces the graded answer',
     /UPDATE course_modules\s+SET quiz = \$1::jsonb, key_points = \$2::jsonb/.test(SETUP));
  /* BOTH STATEMENTS, NOT ONE. This asserted only the content UPDATE's
     guard, so deleting the quiz UPDATE's guard passed — and an
     unguarded rewrite runs on every deploy, overwriting a quiz somebody
     has since edited. Two statements, two guards, two assertions. */
  ok('  and the text rewrite is matched on the old text',
     /WHERE content LIKE '%Clients cannot invest until their FICA status is Approved%'/.test(SETUP),
     'an unconditional rewrite would overwrite a module somebody has '
     + 'since edited, every deploy');
  ok('  AND SO IS THE QUIZ REWRITE',
     /SET quiz = \$1::jsonb[\s\S]{0,200}AND quiz::text LIKE '%clients cannot invest until FICA status is Approved%'/.test(SETUP),
     'the quiz is the half that marks somebody wrong, and rewriting it '
     + 'unconditionally every deploy is how an edit made in the console '
     + 'quietly disappears');
}

console.log('\nand the setting that described a rule nothing applied is gone');
{
  ok('kyc_required is out of the seeded settings',
     !/'kyc_required'.*KYC required before investment/.test(SETUP));
  ok('AND DELETED FROM DATABASES THAT HAVE IT',
     /DELETE FROM platform_settings WHERE key = 'kyc_required'/.test(SETUP),
     "platform_settings seeds with ON CONFLICT DO UPDATE, so dropping the "
     + 'line leaves the row sitting in the console’s Settings panel for '
     + 'staff to read and toggle');
  const readers = ['server', 'js', 'admin', 'portal'].filter(d => {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) return false;
    const walk = p => fs.readdirSync(p, { withFileTypes: true }).some(e => {
      const full = path.join(p, e.name);
      if (e.isDirectory()) return e.name !== 'node_modules' && walk(full);
      if (!/\.(js|cjs)$/.test(e.name)) return false;
      if (/setup\.js$|seed\.js$|check-fica-gates\.cjs$/.test(e.name)) return false;
      return read(path.relative(ROOT, full)).includes('kyc_required');
    });
    return walk(dir);
  });
  ok('  and nothing ever read it', readers.length === 0, readers.join(', '));
}

/* ═══════════════════════════════════════════════════════════════════
   5. The gates, driven for real
   ═══════════════════════════════════════════════════════════════════ */
(async () => {
  let srv;
  try {
    const { rows: [r] } = await db.query(
      `SELECT to_regclass('public.sub_accounts') IS NOT NULL AS ready`);
    if (!r.ready) { console.log('\n  SKIP  no sub_accounts table here'); return; }

    const clean = async () => {
      await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-FICA-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-FICA-%'`);
      await db.query(`DELETE FROM investors WHERE id LIKE 'INV-FICA-%'`);
    };
    await clean();

    /* THE FIXTURE IS THE WHOLE POINT: kyc_status approved with
       fica_status NULL is precisely the client the personal route
       refused, and precisely the state manualCredit's backfill exists to
       repair. A fixture with both columns approved would pass against
       the old code. */
    await db.query(
      `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance,
                              kyc_status, fica_status)
       VALUES ($1,'Thandi','Cleared','fica-ok@example.test','active',10000,'approved',NULL)`,
      [INV_OK]);
    await db.query(
      `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance,
                              kyc_status, fica_status)
       VALUES ($1,'Sipho','Unverified','fica-no@example.test','active',10000,'pending','pending')`,
      [INV_NO]);
    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, wallet_balance,
                                 kyc_status, status)
       VALUES ($1,$2,'minor','Verified Child',5000,'approved','active')`, [SA_OK, INV_OK]);
    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, wallet_balance,
                                 kyc_status, status)
       VALUES ($1,$2,'minor','Unverified Child',5000,'pending','active')`, [SA_NO, INV_OK]);

    const express = require('express');
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/withdrawals', require(path.join(ROOT, 'server/routes/withdrawals.js')));
    app.use('/api/agreements',  require(path.join(ROOT, 'server/routes/agreements.js')));
    srv = await new Promise(res => { const x = app.listen(0, () => res(x)); });

    const call = (method, p, token, body) => new Promise(res => {
      const http = require('http');
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const q = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign({ Authorization: `Bearer ${token}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s = ''; x.on('data', c => s += c);
               x.on('end', () => { let b = {}; try { b = JSON.parse(s || '{}'); } catch (_) { b = { raw: s }; }
                                   res({ status: x.statusCode, body: b }); }); });
      q.on('error', e => res({ status: 0, body: { error: e.message } }));
      if (payload) q.write(payload);
      q.end();
    });
    const tok = id => jwt.sign({ id: 'u-' + id, role: 'investor', investorId: id },
                               process.env.JWT_SECRET);

    console.log('\nthe withdrawal gate, through the route a client reaches');
    {
      const refused = await call('POST', '/api/withdrawals/request', tok(INV_NO),
                                 { amount: 100, bank_name: 'Test', account_number: '1' });
      ok('AN UNVERIFIED CLIENT IS REFUSED', refused.status === 403,
         `${refused.status} ${JSON.stringify(refused.body).slice(0, 200)}`);
      ok('  and told it is FICA', /FICA/.test(refused.body.error || ''),
         refused.body.error);

      /* The client the old gate refused. Anything but 403 is the fix. */
      const allowed = await call('POST', '/api/withdrawals/request', tok(INV_OK),
                                 { amount: 100, bank_name: 'Test', account_number: '1' });
      ok('A CLIENT WITH kyc_status APPROVED IS NOT REFUSED FOR FICA',
         allowed.status !== 403 || !/FICA/i.test(allowed.body.error || ''),
         `${allowed.status} ${JSON.stringify(allowed.body).slice(0, 200)} — this is `
         + 'the client the personal route turned away while the generic route '
         + 'would have paid them');
    }

    console.log('\nand the same question asked of a sub-account');
    {
      const refused = await call('POST', '/api/withdrawals/request', tok(INV_OK),
                                 { amount: 100, sub_account_id: SA_NO,
                                   bank_name: 'Test', account_number: '1' });
      ok('AN UNVERIFIED SUB-ACCOUNT IS REFUSED EVEN THOUGH ITS OWNER IS CLEARED',
         refused.status === 403 && /FICA/.test(refused.body.error || ''),
         `${refused.status} ${JSON.stringify(refused.body).slice(0, 200)}`);
      ok('  and the refusal names the account',
         /Unverified Child/.test(refused.body.error || ''), refused.body.error);

      const allowed = await call('POST', '/api/withdrawals/request', tok(INV_OK),
                                 { amount: 100, sub_account_id: SA_OK,
                                   bank_name: 'Test', account_number: '1' });
      ok('and a verified one is not refused for FICA',
         allowed.status !== 403 || !/FICA/i.test(allowed.body.error || ''),
         `${allowed.status} ${JSON.stringify(allowed.body).slice(0, 200)}`);
    }

    console.log('\nand drawing an agreement, which is what gated investing');
    {
      /* agreementsEnabled() reads an env var; with it off the route
         answers {required:false} and proves nothing about the gate. */
      process.env.INVESTMENT_AGREEMENTS_ENABLED = 'true';
      const drawn = await call('POST', '/api/agreements/draw', tok(INV_NO),
                               { pool_id: 'POOL-FICA-NONE', amount: 1000 });
      ok('AN UNVERIFIED CLIENT IS NOT REFUSED FOR FICA',
         drawn.status !== 403 || !/FICA/i.test(drawn.body.error || ''),
         `${drawn.status} ${JSON.stringify(drawn.body).slice(0, 200)} — a 404 for `
         + 'the made-up pool is the right answer here; a 403 about FICA is the bug');
      ok('  and specifically not with the message from the screenshot',
         !/must be approved before you can sign/.test(drawn.body.error || ''),
         drawn.body.error);
    }

    await clean();
  } catch (e) {
    fail++;
    console.log(`  ✗ the live gates could not be driven\n      ${e.message}`);
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
