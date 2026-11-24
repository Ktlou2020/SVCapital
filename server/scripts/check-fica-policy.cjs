#!/usr/bin/env node
/* WHICH FICA CHECK A CLIENT IS DUE, AND WHAT IT COSTS TO GET IT WRONG.
 *
 * Three rules, and every one of them is about not spending a provider call
 * — or about spending one that was never spent:
 *
 *   1. The automated route starts at R2 000. Under it the client submits
 *      documents and a person reads them. The amount tested is what
 *      reaches the POOL: a R2 000 placement costs R2 020 from the wallet
 *      and it is the R2 000 that is the investment, exactly as a pool
 *      minimum is tested against the pool amount.
 *
 *   2. The trigger is the INVESTMENT. A deposit used to fire the automated
 *      check and placing the money fired nothing, because nothing watched
 *      investments at all.
 *
 *   3. An approved client who was never screened gets the screen, and only
 *      the screen. sanctions_check_status defaults to 'skipped', so there
 *      is a population of clients who went through ID and bank and never
 *      past a sanctions or PEP list.
 *
 *   4. Nothing repeats inside twelve months — and the screen carries its
 *      own stamp, because a screen-only run must not push a client's
 *      annual full re-check out by a year.
 *
 * THE TRAP THIS CHECK EXISTS FOR is the join between the sweep's SELECT
 * lists and the policy's inputs. The policy reads kyc_status, fica_status,
 * last_auto_fica_check and last_sanctions_check. A batch that selects a
 * shorter list hands it an undefined, and an approved client queued for a
 * full annual re-check reads as never screened and gets a screen instead.
 * Nothing throws. The queue still reports a number. So the sweep is driven
 * here for real and asked which check each client actually got.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-fica-policy.cjs
 */
'use strict';

const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const POLICY = require(path.join(ROOT, 'server', 'services', 'ficaPolicy.js'));

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

/* A client, as the policy meets one. */
const WHO = over => Object.assign({
  id: 'INV-FP', kyc_status: 'pending', fica_status: null,
  residency_status: 'resident',
  last_auto_fica_check: null, last_sanctions_check: null,
}, over || {});

const ago = months => {
  const d = new Date(); d.setMonth(d.getMonth() - months); return d;
};

void (async () => {
  try {

/* ══ 1. The threshold ══════════════════════════════════════════════ */
console.log('\nthe automated route starts at R2 000');
{
  ok('IT IS R2 000', POLICY.AUTO_MIN_INVESTMENT === 2000,
     String(POLICY.AUTO_MIN_INVESTMENT));

  ok('a R2 000 investment is checked automatically',
     POLICY.scope(WHO(), { investedAmount: 2000 }).scope === 'full',
     'at the threshold, not above it — "a minimum of R2 000" includes '
     + 'R2 000: ' + JSON.stringify(POLICY.scope(WHO(), { investedAmount: 2000 })));
  ok('and so is a larger one',
     POLICY.scope(WHO(), { investedAmount: 50000 }).scope === 'full');

  const under = POLICY.scope(WHO(), { investedAmount: 1999.99 });
  ok('A RAND UNDER IT GOES TO THE MANUAL ROUTE', under.scope === 'manual',
     'this is the whole rule: ' + JSON.stringify(under));
  ok('and says why, where staff will read it',
     /manual/i.test(under.reason || '') && /R2[ ,\u00a0]?000/.test(under.reason || ''),
     'fica_auto_status says "manual" and said nothing about why: '
     + JSON.stringify(under.reason));
  ok('and R500 does too',
     POLICY.scope(WHO(), { investedAmount: 500 }).scope === 'manual');

  /* THE POOL AMOUNT, NOT THE WALLET SPEND. The 1% fee rides on top, so a
     R2 000 investment takes R2 020 out of the wallet. Testing the wallet
     figure would let a R1 980 investment through on its fee. */
  ok('AND IT IS THE AMOUNT THAT REACHES THE POOL',
     POLICY.scope(WHO(), { investedAmount: 1980 }).scope === 'manual'
     && POLICY.scope(WHO(), { investedAmount: 2000 }).scope === 'full',
     'R1 980 plus 1% is R1 999,80 out of the wallet, and it is still a '
     + 'R1 980 investment');

  /* No amount means nothing to test: the annual sweep and a manual
     trigger are not an investment asking. */
  ok('and a check with no amount in front of it is not refused on amount',
     POLICY.scope(WHO()).scope === 'full',
     'the annual re-check and the console trigger carry no amount, and '
     + 'defaulting them to zero would end the automated route entirely');
}

/* ══ 2. Twelve months ══════════════════════════════════════════════ */
console.log('\nand nothing is re-run inside twelve months');
{
  ok('a client checked a month ago is not checked again',
     POLICY.scope(WHO({ last_auto_fica_check: ago(1), last_sanctions_check: ago(1) }),
                  { investedAmount: 50000 }).scope === 'none',
     'every investment they place would otherwise be a fresh set of '
     + 'provider calls');
  ok('nor one checked eleven months ago',
     POLICY.scope(WHO({ last_auto_fica_check: ago(11), last_sanctions_check: ago(11) }))
       .scope === 'none');
  ok('AND ONE CHECKED THIRTEEN MONTHS AGO IS',
     POLICY.scope(WHO({ last_auto_fica_check: ago(13), last_sanctions_check: ago(13) }))
       .scope === 'full',
     'the annual re-check is the other half of the same window');
  ok('and the window is twelve months, not a year of somebody else’s',
     POLICY.RECHECK_MONTHS === 12, String(POLICY.RECHECK_MONTHS));

  /* A PERSON ASKING IS NOT A SWEEP. Staff re-run a check when a client
     corrects the detail that failed; the window would make that a year. */
  ok('BUT A STAFF MEMBER CAN STILL RUN ONE BY HAND',
     POLICY.scope(WHO({ last_auto_fica_check: ago(1) }), { force: true }).scope === 'full',
     'otherwise a client who fixes their bank details waits out the window');
  ok('and even then a non-resident is not run automatically',
     POLICY.scope(WHO({ residency_status: 'non_resident' }), { force: true }).scope === 'manual',
     'Home Affairs holds South African ID numbers only, so the check '
     + 'would record a failure that means nothing');
}

/* ══ 3. Approved, never screened ═══════════════════════════════════ */
console.log('\nand an approved client who was never screened gets the screen');
{
  for (const [what, who] of [
    ['kyc_status approved',  WHO({ kyc_status: 'approved' })],
    ['kyc_status verified',  WHO({ kyc_status: 'verified' })],
    ['fica_status approved', WHO({ fica_status: 'approved' })],
  ]) {
    const d = POLICY.scope(who);
    ok(`${what} with no screen on record → the screen alone`,
       d.scope === 'sanctions_only',
       'the automated path writes "verified" and the manual document path '
       + 'writes "approved"; a rule that knows one of them exempts the '
       + 'others: ' + JSON.stringify(d));
  }

  ok('A CLIENT WHO IS NOT APPROVED IS NOT GIVEN A SCREEN ON ITS OWN',
     POLICY.scope(WHO({ kyc_status: 'pending' })).scope === 'full',
     'they have not been through ID or bank either — the screen alone '
     + 'would leave them half checked and reading as done');

  /* NOT HELD BEHIND THE WINDOW. A screen that never ran is a hole, not a
     repeat, and leaving a known-unscreened approved client for up to a
     year is the thing being fixed. */
  ok('AND THE WINDOW DOES NOT HOLD IT BACK',
     POLICY.scope(WHO({ kyc_status: 'approved', last_auto_fica_check: ago(2) }))
       .scope === 'sanctions_only',
     'checked two months ago and never screened: waiting ten more months '
     + 'to read a sanctions list is the gap, not the fix');

  /* ── THE TWO POPULATIONS. The difference between them is one column
     being NULL, and reading them the same way breaks one or the other. */
  ok('A CLIENT APPROVED BY HAND, NEVER AUTO-CHECKED, GETS THE SCREEN ONLY',
     POLICY.scope(WHO({ kyc_status: 'approved', last_auto_fica_check: null }))
       .scope === 'sanctions_only',
     'a person read their documents and approved them; nothing automated '
     + 'has ever run, so "the full check is due" is true of every manually '
     + 'approved client forever, and a full check is four paid calls to '
     + 're-answer what a person answered');
  ok('AND AN APPROVED CLIENT WHOSE OWN AUTOMATED CHECK HAS AGED OUT GETS IT IN FULL',
     POLICY.scope(WHO({ kyc_status: 'approved', last_auto_fica_check: ago(13),
                        last_sanctions_check: ago(13) })).scope === 'full',
     'every candidate for the annual re-check is approved, so treating '
     + '"approved" as "screen only" would end the annual re-check for '
     + 'everybody: ' + JSON.stringify(POLICY.scope(WHO({
         kyc_status: 'approved', last_auto_fica_check: ago(13),
         last_sanctions_check: ago(13) }))));

  ok('once screened, the screen is inside the window like everything else',
     POLICY.scope(WHO({ kyc_status: 'approved', last_auto_fica_check: ago(2),
                        last_sanctions_check: ago(2) })).scope === 'none');
  ok('AND A SCREEN THAT HAS AGED OUT RUNS ON ITS OWN',
     POLICY.scope(WHO({ kyc_status: 'approved', last_auto_fica_check: ago(6),
                        last_sanctions_check: ago(14) })).scope === 'sanctions_only',
     'a list changes under a client who has not, so the screen goes stale '
     + 'on its own schedule — and the rest of their check is not re-run '
     + 'to deliver it');
}

/* ══ 4. The sweep, driven ══════════════════════════════════════════ */
console.log('\nand the sweep hands each client the check it queued them for');
{
  const { rows: ready } = await db.query(
    `SELECT to_regclass('public.fica_checks') IS NOT NULL AS ok`);
  if (!ready[0].ok) {
    console.log('  SKIP  no fica tables here');
  } else {
    const col = async name => (await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='investors' AND column_name=$1`, [name])).rowCount > 0;
    ok('investors carries last_sanctions_check',  await col('last_sanctions_check'),
       'the screen needs its own stamp or it defers the full re-check');
    ok('and fica_manual_reason', await col('fica_manual_reason'),
       'so staff opening a manual client can see why they are manual');

    /* THE JOIN. The sweep narrows with SQL and runFicaCheck decides with
       the policy, so every batch's SELECT must carry the four columns the
       policy reads. This drives the real queries and asks what came back. */
    const cron = require(path.join(ROOT, 'server', 'jobs', 'ficaCron.js'));
    const src  = require('fs').readFileSync(
      path.join(ROOT, 'server', 'jobs', 'ficaCron.js'), 'utf8');
    for (const c of ['kyc_status', 'fica_status',
                     'last_auto_fica_check', 'last_sanctions_check']) {
      ok(`every batch selects ${c}`,
         new RegExp(`COLS\\s*=\\s*\`[^\`]*${c}`).test(src)
         && (src.match(/SELECT \$\{COLS\}/g) || []).length >= 3,
         'one column list for all three batches, or a batch hands the '
         + 'policy an undefined and an approved client due for a full '
         + 're-check reads as never screened');
    }
    ok('AND THE SWEEP IS THE ONE THAT RUNS THEM',
       typeof cron.runFicaSweep === 'function', 'server/jobs/ficaCron.js');
    ok('with the threshold read from the policy, not written again',
       /POLICY\.AUTO_MIN_INVESTMENT/.test(src) && !/>= 2000/.test(src),
       'a number copied into a query is one that goes stale: ' + src.slice(0, 1));
    ok('and the window read from it too',
       /POLICY\.RECHECK_INTERVAL_SQL/.test(src) && !/INTERVAL '1 year'/.test(src),
       'the annual batch had its own interval literal');
    ok('AND THE DEPOSIT TRIGGER IS GONE',
       !/first_deposit/.test(src) && /first_investment/.test(src),
       'a deposit is not a purchase, and the batch that swept every '
       + 'depositor is what the R2 000 rule replaces');
  }
}

/* ══ 4b. A screen-only run, actually run ═══════════════════════════ */
console.log('\nand a screen on its own moves only what it answered');
{
  const { rows: ready } = await db.query(
    `SELECT to_regclass('public.fica_checks') IS NOT NULL AS ok`);
  if (!ready[0].ok) {
    console.log('  SKIP  no fica tables here');
  } else {
    /* The service holds a reference to the datanamix module's exports and
       reads the functions off it at call time, so replacing them here is
       what the real runFicaCheck sees. Nothing reaches a provider. */
    const datanamix = require(path.join(ROOT, 'server', 'services', 'datanamix.js'));
    const { runFicaCheck } = require(path.join(ROOT, 'server', 'services', 'ficaService.js'));
    let verdict = 'clear';
    datanamix.enabled            = () => true;
    datanamix.screenIndividual   = async () => ({ stubbed: true });
    datanamix.mapSanctionsResult = () => ({ status: verdict, reasons: ['stub'] });
    /* If the scope leaks and the other steps run, these answer — and the
       assertions below catch it, because a screen-only run must record
       them as skipped rather than as passes it never obtained. */
    datanamix.verifyIdRealtime   = async () => ({ stubbed: true });
    datanamix.mapIdResult        = () => ({ status: 'pass', reasons: [] });
    datanamix.verifyBankAccount  = async () => ({ stubbed: true });
    datanamix.mapAvsResult       = () => ({ status: 'pass', reasons: [] });
    datanamix.verifyAddress      = async () => ({ stubbed: true });
    datanamix.mapAddressResult   = () => ({ status: 'pass', reasons: [] });

    const seed = async (id, over) => {
      await db.query(`DELETE FROM fica_checks WHERE investor_id = $1`, [id]);
      await db.query(`DELETE FROM investors WHERE id = $1`, [id]);
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, phone, status,
                                kyc_status, fica_status, id_number, nationality,
                                last_auto_fica_check, last_sanctions_check, wallet_balance)
         VALUES ($1,'Thandi','Mokoena',$2,'0760000009','active',$3,$4,
                 '8001015009087','South Africa',$5,$6,0)`,
        [id, id.toLowerCase() + '@example.test', over.kyc_status || 'approved',
         over.fica_status || null, over.last_auto_fica_check || null,
         over.last_sanctions_check || null]);
    };
    const investor = async id => (await db.query(
      `SELECT kyc_status, fica_status, last_auto_fica_check, last_sanctions_check
         FROM investors WHERE id = $1`, [id])).rows[0];
    const latestCheck = async id => (await db.query(
      `SELECT trigger, id_check_status, bank_check_status, sanctions_check_status,
              address_check_status, overall_status
         FROM fica_checks WHERE investor_id = $1
        ORDER BY check_date DESC, created_at DESC LIMIT 1`, [id])).rows[0];

    /* ── A clear screen on an approved, never-screened client ── */
    const WAS = ago(6);
    await seed('INV-FP-CLEAR', { kyc_status: 'approved', last_auto_fica_check: WAS });
    const before = await investor('INV-FP-CLEAR');
    const r = await runFicaCheck(
      { ...before, id: 'INV-FP-CLEAR', first_name: 'Thandi', last_name: 'Mokoena',
        id_number: '8001015009087', nationality: 'South Africa', notes: '',
        date_of_birth: '1980-01-01' },
      'sanctions_backfill');
    const c = await latestCheck('INV-FP-CLEAR');
    const a = await investor('INV-FP-CLEAR');

    ok('THE SCREEN RAN', c && c.sanctions_check_status === 'clear',
       'a screen-only run that records nothing has screened nobody: '
       + JSON.stringify(c) + ' ' + JSON.stringify(r));
    ok('and NOTHING ELSE DID',
       c && c.id_check_status === 'skipped' && c.bank_check_status === 'skipped'
       && c.address_check_status === 'skipped',
       'the whole point of the scope is one provider call instead of four: '
       + JSON.stringify(c));
    ok('and three skips are not read as a failure',
       c && c.overall_status === 'pass',
       'the status logic requires an ID pass for an overall pass, so an '
       + 'unscoped derivation rejects a client it never checked: '
       + JSON.stringify(c));
    ok('AND THE CLIENT IS STILL APPROVED BY THE ROUTE THAT APPROVED THEM',
       a.kyc_status === 'approved',
       'writing "verified" over an "approved" set by a person who read '
       + 'their documents relabels a manual approval as an automated one: '
       + a.kyc_status);
    ok('THE SCREEN IS STAMPED', a.last_sanctions_check != null,
       'or it is queued again tomorrow night, and every night');
    ok('AND THE FULL CHECK IS NOT',
       a.last_auto_fica_check != null
       && Math.abs(new Date(a.last_auto_fica_check) - WAS) < 60000,
       'stamping it would push this client’s annual re-check out by a year '
       + 'on the strength of one list being read: '
       + `${a.last_auto_fica_check} was ${WAS.toISOString()}`);
    ok('and the policy now says they are done',
       POLICY.scope(a).scope === 'none', JSON.stringify(POLICY.scope(a)));

    /* ── A hit holds them ── */
    verdict = 'hit';
    await seed('INV-FP-HIT', { kyc_status: 'approved', last_auto_fica_check: WAS });
    const hb = await investor('INV-FP-HIT');
    await runFicaCheck(
      { ...hb, id: 'INV-FP-HIT', first_name: 'Thandi', last_name: 'Mokoena',
        id_number: '8001015009087', nationality: 'South Africa', notes: '',
        date_of_birth: '1980-01-01' },
      'sanctions_backfill');
    const hc = await latestCheck('INV-FP-HIT');
    const ha = await investor('INV-FP-HIT');
    ok('A HIT GOES TO A PERSON', hc && hc.overall_status === 'manual_review',
       'a possible sanctions or PEP match is never ours to clear: '
       + JSON.stringify(hc));
    ok('and holds the client while it is read',
       ha.kyc_status === 'pending',
       'leaving them approved on a possible match is the one outcome the '
       + 'screen exists to prevent: ' + ha.kyc_status);

    /* ── AND WITH NO SCREENING PROVIDER, NOTHING IS RECORDED ──
       Without Datanamix the screen cannot run, so a screen-only run is
       three skips and nothing else. Writing that as a check would mark a
       client screened when no list was read — the same failure as
       stamping last_auto_fica_check on a provider error, which once
       dropped every depositor out of the queue for a year. This branch
       is only reachable with the provider off, so it is tested with the
       provider off; a mutation inside it survives any test that leaves
       the stub enabled. */
    verdict = 'clear';
    datanamix.enabled = () => false;
    await seed('INV-FP-NOPROV', { kyc_status: 'approved', last_auto_fica_check: WAS });
    const nb = await investor('INV-FP-NOPROV');
    const nr = await runFicaCheck(
      { ...nb, id: 'INV-FP-NOPROV', first_name: 'Thandi', last_name: 'Mokoena',
        id_number: '8001015009087', nationality: 'South Africa', notes: '',
        date_of_birth: '1980-01-01' },
      'sanctions_backfill');
    const na = await investor('INV-FP-NOPROV');
    ok('A SCREEN WITH NO PROVIDER RECORDS NO CHECK',
       (await latestCheck('INV-FP-NOPROV')) == null,
       'a fica_checks row with every step skipped says this client was '
       + 'screened, and they were not: ' + JSON.stringify(nr));
    ok('and stamps nothing, so they stay in the queue',
       na.last_sanctions_check == null && na.last_auto_fica_check != null
       && Math.abs(new Date(na.last_auto_fica_check) - WAS) < 60000,
       'stamped, they drop out of the backfill having never been screened: '
       + JSON.stringify(na));
    ok('and the client is left exactly as they were',
       na.kyc_status === 'approved', na.kyc_status);
    datanamix.enabled = () => true;

    await db.query(`DELETE FROM fica_checks WHERE investor_id LIKE 'INV-FP-%'`);
    await db.query(`DELETE FROM investors   WHERE id LIKE 'INV-FP-%'`);
  }
}

/* ══ 5. The investment hook ════════════════════════════════════════ */
console.log('\nand placing an investment is what sets it off');
{
  const t = require('fs').readFileSync(
    path.join(ROOT, 'server', 'routes', 'tables.js'), 'utf8');
  /* THE FICA HOOK'S OWN BLOCK, not any line in the file that mentions
     investments. tables.js has other hooks on the same table — an email
     one three lines down — so a probe for the condition alone passes
     while the FICA hook sits on deposits. The block is cut out from its
     own comment to its runFicaCheck call and read on its own. */
  const block = (t.match(/FICA investment hook[\s\S]*?runFicaCheck\([^;]*;/) || [''])[0];
  ok('THE FICA HOOK IS ON INVESTMENTS',
     /table === 'investments'/.test(block) && !/'deposit'/.test(block),
     'nothing watched investments at all before this, and the file has '
     + 'other hooks on the same table: ' + block.slice(0, 200));
  ok('and it hands the policy the amount that reached the pool',
     /investedAmount: clean\.amount/.test(block),
     'the hook must not decide the threshold itself — three copies of a '
     + 'number is two that go stale: ' + block.slice(-160));
  ok('and asks for the investment trigger, not the deposit one',
     /'first_investment'/.test(block) && !/'first_deposit'/.test(block),
     block.slice(-160));
  ok('AND THE DEPOSIT HOOK IS GONE',
     !/FICA deposit hook/.test(t) && !/'first_deposit'/.test(t),
     'leaving it would check every depositor and the rule would do '
     + 'nothing');
}

/* ══ 6. Every place that lists who is due ══════════════════════════ */
console.log('\nand nowhere keeps its own copy of the rule');
{
  const f = require('fs').readFileSync(
    path.join(ROOT, 'server', 'routes', 'fica.js'), 'utf8');
  /* THE QUEUE ENDPOINT WAS A FIFTH COPY. It listed every depositor, so
     staff reading the FICA pipeline saw a queue of people the sweep was
     never going to touch — a screen that disagrees with the job behind
     it is worse than no screen. */
  ok('THE QUEUE LISTS INVESTORS, NOT DEPOSITORS',
     /FROM investments v/.test(f) && !/t\.type = 'deposit'/.test(f),
     'the console would show a queue that never drains: ' + f.slice(0, 1));
  ok('and takes the threshold from the policy',
     /POLICY\.AUTO_MIN_INVESTMENT/.test(f) && !/>= 2000/.test(f));
  ok('AND LISTS THE APPROVED CLIENTS WHO WERE NEVER SCREENED',
     /neverScreened/.test(f) && /last_sanctions_check IS NULL/.test(f),
     '"who is approved without a sanctions check" had nowhere to be read');
  ok('and a staff member running one by hand still overrides the window',
     /\{ force: true \}/.test(f),
     'a client who corrects their bank details cannot be made to wait a year');

  /* A COLUMN STAFF CANNOT SEE IS THE LOG LINE IT REPLACED. */
  const a = require('fs').readFileSync(
    path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
  ok('THE CONSOLE SHOWS WHETHER A CLIENT HAS BEEN SCREENED',
     /cell\('Screened'/.test(a),
     'a client can be fully approved and never have been past a sanctions '
     + 'list, and "Checked" does not say so');
  ok('and why a client is on the manual route',
     /fica_manual_reason/.test(a) && /On the manual route/.test(a),
     'fica_auto_status said "manual" and nothing said why');
  /* EVERY INVESTOR SELECT IN HERE, not one of them.
   *
   * Two endpoints in this file select the same columns in nearly the same
   * order and both end "FROM investors WHERE id = $1", so an assertion
   * anchored on that shape reads whichever comes first — it passed against
   * a mutation that emptied the other one. There is no need to pick: the
   * invariant is that they AGREE, because a client who reads as screened
   * on the pipeline list and unscreened on their own page is a defect
   * whichever query is wrong. SELECT * carries everything by definition. */
  /* Within one template literal: [\s\S]*? runs past a closing backtick
     and stitches a fica_checks select onto the next query's FROM, which
     reported two queries that do not exist. */
  const investorSelects = (f.match(/SELECT[^`]*?FROM investors/g) || []);
  const thin = investorSelects.filter(q =>
    !/SELECT \*/.test(q)
    && !(/last_sanctions_check/.test(q) && /fica_manual_reason/.test(q)));
  ok('EVERY INVESTOR SELECT HERE SENDS BOTH NEW COLUMNS',
     investorSelects.length >= 3 && thin.length === 0,
     `${investorSelects.length} investor selects, ${thin.length} missing a `
     + 'column the console reads — it would show "Never" for everybody and '
     + 'no reason at all: ' + thin.map(q => q.slice(0, 90)).join(' || '));
  ok('AND NAMES THE NEW TRIGGERS',
     /first_investment: 'First investment'/.test(a)
     && /sanctions_backfill: 'Sanctions screen'/.test(a),
     'an unnamed trigger renders as its own identifier');
}

  } catch (err) {
    fail += 1;
    console.log('  ✗ the check itself fell over\n      ' + (err && err.stack || err));
  } finally {
    await db.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
