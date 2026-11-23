#!/usr/bin/env node
/* An approved authority is a thing to carry out, not a thing to file.
 *
 * THE DEFECT, found by driving the money flows in a browser. A stokvel
 * request has five states — pending, approved, rejected, used, expired.
 * The server moves it to 'approved' the moment the last signatory agrees,
 * and it stays spendable until something consumes it: mandate.authorityFor
 * asks whether it is SATISFIED and never what its status is, and
 * mandate.consume marks the spent one 'used'.
 *
 * The client only ever knew 'pending'. Every carry-it-out button was gated
 * on `satisfied && status === 'pending'` — a condition that cannot hold,
 * because the vote that makes a request satisfied is the same vote that
 * takes it out of 'pending'. So:
 *
 *   · "Pay the group out" could never render.
 *   · "Settle this exit" could never render.
 *   · "Move it into the fund" could never render.
 *   · stokvelInvestAuthority filtered on 'pending', found no authority for
 *     an approved investment, and told the member "A group investment
 *     needs the signatories to approve it first. Open the group, request
 *     an investment into this pool, and place it once they have" — about
 *     the investment they had already had approved.
 *   · and the approved row was filed under RECENT, beside the history,
 *     under a heading that read "Nothing awaiting approval."
 *
 * Seen live: a payout approved 2 of 2, satisfied, with no way to pay it;
 * R 10 000 approved into Solar Energy 7-Year, refused at the marketplace.
 *
 * WHY THESE ASSERTIONS DRIVE RATHER THAN READ. A dead branch leaves its
 * source behind: grepping for "Pay the group out" passed for as long as
 * the button could never appear. Every assertion below calls the renderer
 * with a payload and reads what comes out.
 *
 * Run: node server/scripts/check-stokvel-authority.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* A comment that explains a fix quotes the thing it warns about. */
const strip = src => String(src).replace(/\/\*[\s\S]*?\*\//g, ' ')
                                .replace(/^\s*\/\/.*$/gm, ' ');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ── The portal, loaded once and driven many times ─────────────────── */
function portal() {
  const ctx = { window: {}, document: { getElementById: () => null },
                location: { search: '' },
                localStorage: { getItem: () => null, setItem() {} },
                sessionStorage: { getItem: () => null, setItem() {} },
                Utils: { rand: n => 'R ' + Number(n || 0).toFixed(2), date: d => String(d || '') },
                encodeURIComponent, console };
  vm.createContext(ctx);
  vm.runInContext(read('js/portal-core.js'), ctx);
  /* The bundle provides these; portal-core expects them. The same
     stand-ins check-group-ux-pass and check-group-schedule use. */
  ctx._esc = v => String(v == null ? '' : v);
  ctx.PORTAL = { investor: { id: 'INV-1' }, transactions: [], stokvels: [], subAccounts: [], pools: [] };
  return ctx;
}

const REQ = over => Object.assign({
  id: 'SWR-1', kind: 'withdrawal', amount: 2000, status: 'pending',
  approvals: 1, required: 2, satisfied: false, votes: [],
  requested_by_name: 'Zanele', bank_name: 'FNB',
}, over || {});

/* ══ 1. What "live" means, as a predicate ═══════════════════════════ */
console.log('\nan authority is live until something spends it');
{
  const P = portal();
  ok('a request still being voted on is live',
     P._svAuthorityLive(REQ({ status: 'pending' })) === true);
  ok('AND SO IS ONE THE SIGNATORIES HAVE APPROVED',
     P._svAuthorityLive(REQ({ status: 'approved' })) === true,
     'this is the state every carry-it-out button needs, and the one the '
     + 'client did not know about');
  ok('a spent one is not',
     P._svAuthorityLive(REQ({ status: 'used' })) === false,
     'an authority that has been consumed must never offer its button again');
  ok('nor is a rejected or expired one',
     P._svAuthorityLive(REQ({ status: 'rejected' })) === false
     && P._svAuthorityLive(REQ({ status: 'expired' })) === false);
  ok('and nothing at all is not live',
     P._svAuthorityLive(null) === false
     && P._svAuthorityLive({}) === false
     && P._svAuthorityLive(REQ({ status: '' })) === false,
     'a missing status must not read as live');

  ok('READY IS APPROVED AND NOT YET SPENT',
     P._svAuthorityReady(REQ({ status: 'approved', satisfied: true })) === true,
     'the one state in which a member may carry something out');
  ok('an unsatisfied request is not ready',
     P._svAuthorityReady(REQ({ status: 'pending', satisfied: false })) === false);
  ok('AND A SPENT ONE IS NOT READY EVEN THOUGH IT WAS SATISFIED',
     P._svAuthorityReady(REQ({ status: 'used', satisfied: true })) === false,
     'satisfied stays true on a used authority — if readiness ignored the '
     + 'status, one approval would pay the group out twice');
}

/* ══ 2. The buttons that carry money, driven ════════════════════════ */
console.log('\nand an approved authority offers the thing it authorises');
{
  const P = portal();
  const render = rows => P._svWithdrawals({ data: rows }, true, 'SA-1',
    { g: { stokvel_quorum: 2 }, signatories: 2, canPropose: true });

  const CASES = [
    ['payout',         'Pay the group out',      { payout_id: 'SPO-1', payout_label: 'December' }],
    ['exit',           'Settle this exit',       { exit_name: 'Nomsa' }],
    ['notice_deposit', 'Move it into the fund',  { fund_name: 'the 30-day notice fund' }],
    ['investment',     'Place this investment',  { pool_id: 'POOL-2', pool_name: 'Solar 7-Year' }],
  ];

  for (const [kind, label, extra] of CASES) {
    const approved = render([REQ(Object.assign({ kind, status: 'approved', satisfied: true }, extra))]);
    ok(`AN APPROVED ${kind.toUpperCase()} OFFERS “${label}”`,
       approved.includes(label),
       'this button was gated on satisfied && status === "pending", which '
       + 'cannot both be true: ' + approved.slice(0, 220));

    const waiting = render([REQ(Object.assign({ kind, status: 'pending', satisfied: false }, extra))]);
    ok(`and one the signatories have not carried does not`,
       !waiting.includes(label),
       'a member must not be able to move money the mandate has not released');

    const spent = render([REQ(Object.assign({ kind, status: 'used', satisfied: true }, extra))]);
    ok(`and a spent one does not offer it again`,
       !spent.includes(label),
       'the second press would be refused by the server, but offering it at '
       + 'all says the money has not moved when it has');
  }

  /* The vote itself is a different gate and must NOT follow. */
  const approved = render([REQ({ status: 'approved', satisfied: true })]);
  ok('an approved request no longer asks for a vote',
     !/voteStokvelRequest\('SA-1','SWR-1','approve'\)/.test(approved),
     'voting is for a request still pending; a second Approve on a carried '
     + 'one would be a 409 the member cannot act on');
  const pending = render([REQ({ status: 'pending' })]);
  ok('and one still pending does',
     /voteStokvelRequest\('SA-1','SWR-1','approve'\)/.test(pending), pending.slice(0, 200));
}

/* ══ 3. Where an approved authority is filed ════════════════════════ */
console.log('\nand it is listed as live, not as history');
{
  const P = portal();
  const render = rows => P._svWithdrawals({ data: rows }, false, 'SA-1',
    { g: { stokvel_quorum: 2 }, signatories: 2 });

  const live = render([REQ({ status: 'approved', satisfied: true, kind: 'payout', payout_id: 'SPO-1' })]);
  ok('AN APPROVED, UNSPENT AUTHORITY IS NOT “NOTHING AWAITING APPROVAL”',
     !live.includes('Nothing awaiting approval'),
     'the group was told the matter was closed while the money had not '
     + 'moved: ' + live.slice(0, 240));

  const empty = render([REQ({ status: 'used', satisfied: true })]);
  ok('and a group whose authorities are all spent is told so',
     empty.includes('Nothing awaiting approval'),
     'the empty state still has to exist');

  /* The badge on the Decisions tab counts what there is to do. */
  const badge = html => (String(html).match(/aria-label="(\d+) waiting"/) || [])[1];
  const tabs = rows => P._svWsTabs('SA-1', 'overview',
    { requests: { data: rows }, contributions: { data: [] },
      tabCtx: { hasMoney: true, hasSchedule: true, waiting: 1, proposals: 0,
                signatories: 2, committee: true, hasDocuments: true, iAmNominated: false } });
  ok('AND THE TAB BADGE COUNTS AN APPROVED ONE TOO',
     badge(tabs([REQ({ status: 'approved', satisfied: true })])) === '1',
     'a button nobody is sent to is a button nobody presses');
  ok('and does not count a spent one',
     badge(tabs([REQ({ status: 'used', satisfied: true })])) === undefined,
     'a badge that never clears is a badge people stop reading');
}

/* ══ 4. Placing the investment — the defect itself ══════════════════ */
console.log('\nand an approved investment can actually be placed');
{
  const P = portal();
  const authority = async rows => {
    P.API = { _fetch: async () => ({ data: rows }) };
    return P.stokvelInvestAuthority('SA-1', 'POOL-2', 10000);
  };
  const INV = over => REQ(Object.assign(
    { kind: 'investment', pool_id: 'POOL-2', pool_name: 'Solar 7-Year', amount: 10000 }, over));

  /* An async section, as an IIFE rather than a top-level return: a bare
     `return` outside a function is illegal in a script parse, and
     check-js-parses parses every shipped file as one. */
  void (async () => {
    const got = await authority([INV({ status: 'approved', satisfied: true })]);
    ok('AN APPROVED AUTHORITY IS THE ONE IT PLACES AGAINST',
       got.authority_id === 'SWR-1',
       'it filtered on status === "pending", so the only row that could '
       + 'place the investment was the only row never considered: '
       + JSON.stringify(got));

    const spent = await authority([INV({ status: 'used', satisfied: true })]);
    ok('and a spent authority does not place a second investment',
       !!spent.error,
       'the server would refuse it, but the member would have signed an '
       + 'agreement first: ' + JSON.stringify(spent));

    const rejected = await authority([INV({ status: 'rejected', satisfied: false })]);
    ok('nor does a rejected one',
       !!rejected.error, JSON.stringify(rejected));

    const waiting = await authority([INV({ status: 'pending', approvals: 1, required: 2 })]);
    ok('one still waiting says how far it has got',
       /1 of 2/.test(waiting.error || ''),
       'the member needs to know whether to chase or to wait: ' + JSON.stringify(waiting));

    const wrong = await authority([INV({ status: 'approved', satisfied: true, amount: 9000 })]);
    ok('AND AN APPROVAL FOR ANOTHER FIGURE NAMES THAT FIGURE',
       /9000\.00/.test(wrong.error || '') && /10000\.00/.test(wrong.error || ''),
       'signatories approve a sum, and the sum is what is approved: '
       + JSON.stringify(wrong));

    const elsewhere = await authority([INV({ status: 'approved', satisfied: true, pool_id: 'POOL-9' })]);
    ok('and an approval into another pool does not release this one',
       !!elsewhere.error && /approve it first/.test(elsewhere.error),
       'an authority is for a named pool: ' + JSON.stringify(elsewhere));

    /* ══ 5. The payout panel, where a member actually looks ═════════ */
    console.log('\nand the payouts panel says where the payout has got to');
    {
      const Q = portal();
      const planned = { id: 'SPO-1', label: 'December 2026', status: 'planned',
                        pay_on: '2026-12-01', authority_id: null };
      const render = reqs => Q._svPayouts({ data: [planned], can_plan: true, my_share_now: 3000 },
                                          'SA-1', reqs);

      const none = render({ data: [] });
      ok('with nobody asked yet it offers to ask',
         none.includes('Ask the signatories'), none.slice(0, 200));

      const asked = render({ data: [REQ({ kind: 'payout', payout_id: 'SPO-1',
                                          status: 'pending', approvals: 1, required: 2 })] });
      ok('ONCE ASKED IT DOES NOT ASK AGAIN',
         !asked.includes('Ask the signatories'),
         'stokvel_payouts.authority_id is only written when the payout RUNS, '
         + 'so the button never went away and a second press raised a second '
         + 'authority for the same distribution: ' + asked.slice(0, 240));
      ok('and says how far it has got instead',
         /1 of 2/.test(asked), asked.slice(0, 240));

      const ready = render({ data: [REQ({ kind: 'payout', payout_id: 'SPO-1', id: 'SWR-P',
                                          status: 'approved', satisfied: true,
                                          approvals: 2, required: 2 })] });
      ok('AND ONCE APPROVED IT OFFERS TO PAY THE GROUP OUT',
         ready.includes('Pay the group out')
         && /runStokvelPayout\('SA-1','SPO-1','SWR-P'\)/.test(ready),
         'the only other place this button exists is the approvals panel, '
         + 'which is not where a member looks for a payout: ' + ready.slice(0, 260));
      ok('and stops saying it needs their approval',
         !/needs the signatories&rsquo; approval/.test(ready), ready.slice(0, 260));

      const other = render({ data: [REQ({ kind: 'payout', payout_id: 'SPO-OTHER',
                                          status: 'approved', satisfied: true })] });
      ok('an approval for a DIFFERENT payout releases nothing',
         !other.includes('Pay the group out'),
         'a payout is authorised by name: ' + other.slice(0, 200));
    }

    /* ══ 6. The client and the server agree what spendable means ════ */
    console.log('\nand the server means the same thing by it');
    {
      const ROUTES  = strip(read('server/routes/stokvels.js'));
      const MANDATE = strip(read('server/services/stokvelMandate.js'));
      const SETUP   = strip(read('server/db/setup.js'));

      ok('the last approval moves the request to approved',
         /else if \(state\.satisfied\)\s+status = 'approved';/.test(ROUTES),
         'this is why pending-only was wrong on the client');
      ok('AND THE SERVER SPENDS ON SATISFIED, NOT ON STATUS',
         /if \(!state\.satisfied\) return \{ error:/.test(MANDATE)
         && !/authority\.status === 'pending'/.test(MANDATE),
         'the client now relies on an approved authority still being '
         + 'spendable; if the server ever required pending, every button '
         + 'this check restores would 403');
      ok('and marks a spent one used',
         /SET status = 'used', used_at = NOW\(\)/.test(MANDATE),
         'this is what stops an authority being spent twice');

      /* A sixth status would silently be treated as dead by the client. */
      const states = (SETUP.match(/CHECK \(status IN \('pending','approved','rejected','used','expired'\)\)/g) || []).length;
      ok('and the five states are still the five the client knows',
         states === 1,
         'a new status would fall outside both lists and read as spent — '
         + 'add it to _svAuthorityLive, or to this check, deliberately');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}
