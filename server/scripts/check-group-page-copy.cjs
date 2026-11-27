#!/usr/bin/env node
/* What the group pages say, as a member reads them.
 *
 * From a review of the staging group screens. Each of these is a line of
 * copy or a column that was wrong, missing, or said twice — small on their
 * own, and all on the screens a committee uses to decide about money.
 *
 *   · The required-documents checklist said "Signatory's ID document"
 *     while asking for one per signatory, minimum two.
 *   · The notice account called its rate a "Projected return", which reads
 *     as a forecast of what the group WILL earn. It is an indicative rate,
 *     variable and not guaranteed, and on a regulated product the stronger
 *     disclosure is the correct one.
 *   · That card only revealed the fund's minimum after a member tapped
 *     through to the form and was refused.
 *   · The modal that opens a savings club was headed "Open a Sub-Account",
 *     the internal word for the record.
 *   · "My Accounts" was printed twice, once in the top bar and again
 *     beneath it.
 *   · Three unlabelled columns on Who is behind, and three more on Shares,
 *     one of which is a share of the pot and one of which is a debt.
 *   · Every member who accepted an invitation was listed under Members and
 *     again under Answered invitations, so counting members gave the wrong
 *     number.
 *
 * NOT DONE HERE, and deliberately: the review's Overview mock puts the
 * heading "TOTAL CONTRIBUTED" above the arrears amount. That column is
 * what each member OWES. The payload carries name, owed and periods and no
 * cumulative figure at all, so the heading would have sat above the
 * opposite of what it named. The headings below say Owing.
 *
 * Run: node server/scripts/check-group-page-copy.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const words = h => String(h).replace(/<[^>]*>/g, ' ').replace(/&mdash;/g, '—')
                            .replace(/&minus;/g, '−').replace(/&rsquo;/g, '’')
                            .replace(/\s+/g, ' ').trim();

/* The portal, run rather than read. */
function portal() {
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    document: { getElementById: () => null, querySelector: () => null,
                querySelectorAll: () => [], addEventListener() {},
                createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
                body: { appendChild() {}, classList: { add() {}, remove() {} } },
                head: { appendChild() {} } },
    location: { search: '', pathname: '/portal/', origin: 'https://x', href: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    navigator: { userAgent: '' },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    encodeURIComponent, decodeURIComponent, URLSearchParams,
    addEventListener() {}, btoa: s => Buffer.from(s, 'binary').toString('base64'),
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('js/api.js'), ctx);
  vm.runInContext(read('js/portal-core.js'), ctx);
  ctx._esc = v => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return ctx;
}

void (async () => {

/* ══ 1. The documents checklist asks for more than one ═════════════ */
console.log('\nthe checklist agrees with what it is asking for');
{
  const docs = require(path.join(ROOT, 'server', 'services', 'stokvelDocuments.js'));
  const src  = read('server/services/stokvelDocuments.js');
  ok('THE SIGNATORY ID ROW IS PLURAL',
     /Signatories’ ID documents/.test(src),
     'the row beneath it reads "3 approved, 3 sent — 3 needed, one for '
     + 'each signatory", under a heading naming one document');
  ok('and at least two are always needed',
     /MIN_SIGNATORY_IDS = [2-9]/.test(src),
     'if one could ever be enough the singular would have been right');
  ok('and a single sent file is still described in the singular',
     /A signatory&rsquo;s ID document|whose ID document this is/.test(read('js/portal-core.js')),
     'one upload really is one person’s document');
}

/* ══ 2. The notice account, before anybody commits ═════════════════ */
console.log('\nand the notice account says what it costs and what it pays');
{
  const P = portal();
  /* API is declared `const` in js/api.js, so it is in the context's
     lexical scope and NOT on the global object: assigning ctx.API creates
     a second one that the document never looks at, and _svNoticeFund then
     caught its own TypeError and returned ''. Every assertion below read
     an empty string and failed for a reason that had nothing to do with
     the card. The real object is patched from inside the context. */
  const card = async over => {
    P.__payload = { data: Object.assign({
      available: true,
      fund: { name: 'Agriculture Notice Account', notice_days: 30, min_deposit: 25000 },
      position: { value: 0, cost: 0, gain: null },
      projected: { this_rate: 0.015, next_rate: 0.014 },
      orders: [],
    }, over || {}) };
    vm.runInContext('API._fetch = async () => __payload;', P);
    return P._svNoticeFund('SA-1');
  };

  const w = words(await card());
  ok('THE MINIMUM IS ON THE CARD', /Minimum: R\s?25\s?000,00/.test(w),
     'it was only discovered after tapping through to the form and being '
     + 'refused: ' + w.slice(0, 220));
  ok('AND THE RATE IS INDICATIVE, NOT A PROJECTED RETURN',
     /Indicative rate: 1\.5% \/ month \(variable, not guaranteed\)/.test(w),
     '"Projected return" reads as a forecast of what the group will earn: '
     + w.slice(0, 260));
  ok('and the words "projected return" are gone from it',
     !/Projected return/i.test(w), w.slice(0, 260));
  ok('and it still says capital is at risk',
     /Capital is at risk and returns are not guaranteed/.test(w), w.slice(0, 260));

  /* A fund with no minimum must not advertise one. */
  const none = words(await card({
    fund: { name: 'Agriculture Notice Account', notice_days: 30, min_deposit: 0 } }));
  ok('and a fund with no minimum shows none',
     !/Minimum:/.test(none), none.slice(0, 200));
}

/* ══ 3. The modal says what it opens ═══════════════════════════════ */
console.log('\nand the modal names what is being opened');
{
  const core = read('js/portal-core.js');
  ok('A GROUP IS CALLED A GROUP', /stokvel:\s*'Open a Group'/.test(core),
     '"Open a Sub-Account" is the internal word for the record');
  ok('and a trust is not called a group',
     /trust:\s*'Open a Trust Account'/.test(core) && /business:\s*'Open a Business Account'/.test(core),
     'the same modal opens four kinds of account — renaming it outright '
     + 'would mislabel three of them');
  ok('and the step says what the step is for',
     /Set up your group wallet, pot split, and signing mandate/.test(core),
     '"Step 2 of 3" alone never said what step 2 was');
  ok('and the generic name survives for anything unnamed',
     /\|\| 'Open a Sub-Account'/.test(core));
}

/* ══ 4. Said once ══════════════════════════════════════════════════ */
console.log('\nand the page title is printed once');
{
  const html = read('portal/index.html');
  const core = read('js/portal-core.js');
  ok('THE TOP BAR STILL CARRIES IT', /subaccounts: 'My Accounts'/.test(core),
     'the titles map is what fills #topbarTitle');
  ok('and the page does not print it again',
     !/class="sa-view-title"/.test(html),
     'the same two words, one under the other');
  ok('and the line that explains the page is still there',
     /Business · Trust · Group · Minor/.test(html),
     'removing the duplicate must not take the subtitle with it');
}

/* ══ 5. Columns that say what they hold ════════════════════════════ */
console.log('\nand every money column is labelled');
{
  const core = read('js/portal-core.js');
  const heads = (core.match(/<th[^>]*>([^<]*)<\/th>/g) || [])
    .map(h => h.replace(/<[^>]*>/g, '').trim().toLowerCase());
  /* BOTH OF THEM, COUNTED. There are two "who is behind" tables — one on
     Overview and one on Money — with the same three columns. A regex for
     the header row matched whichever came first, so emptying the Overview
     one passed on the strength of the Money one. Counting the header
     cells cannot pick the wrong table. */
  const nHead = w => heads.filter(h => h === w).length;
  ok('WHO IS BEHIND NAMES ITS COLUMNS, ON BOTH SCREENS',
     nHead('member') >= 2 && nHead('owing') >= 2 && nHead('periods') >= 2,
     'three unlabelled numbers, one of them a debt — member:'
     + nHead('member') + ' owing:' + nHead('owing') + ' periods:' + nHead('periods')
     + ' (want 2 of each)');
  /* READ FROM THE HEADER CELLS, not from the file. Grepping the whole of
     portal-core for "total contributed" matched the COMMENT that explains
     why that heading is not used — the probe was satisfied by the
     reasoning for its own existence. Only the <th> text counts. */
  /* THIS ASSERTION USED TO FORBID "Total contributed" ENTIRELY, and was
     right to at the time: the arrears payload carried name, owed and
     periods and nothing cumulative, so the heading the review asked for
     would have sat above the amount each member OWES — the opposite of
     what it named.

     The figure exists now, aggregated server-side, so the heading is
     correct and the ban is obsolete. What has to stay true is the thing
     the ban was protecting: a debt is never labelled a contribution. So
     both columns must be present, which is only possible when each has
     its own number. */
  ok('the arrears name both what is owed and what has been paid',
     heads.includes('owing') && heads.includes('total contributed'),
     'Headers found: ' + heads.join(', '));
  ok('AND THE CONTRIBUTED COLUMN IS FED BY ITS OWN FIELD',
     /a\.contributed == null \? '&mdash;' : Utils\.rand\(a\.contributed\)/.test(core)
     && !/Total contributed[\s\S]{0,200}Utils\.rand\(a\.owed\)[\s\S]{0,40}<\/td>\s*<td[^>]*>\s*\$\{Utils\.rand\(a\.owed\)/.test(core),
     'the heading is only honest if the cell under it is the contributed '
     + 'figure and not the arrears one repeated');
  ok('AND THE SHARES TABLE NAMES ITS COLUMNS',
     /Share of the pot/.test(core),
     'one column is a share of the pot and one is a debt');
}

/* ══ 6. Over-committed reads as a negative ═════════════════════════ */
console.log('\nand money promised twice is shown as a shortfall');
{
  const core = read('js/portal-core.js');
  ok('A NEGATIVE CARRIES ITS SIGN IN FRONT',
     /&minus;\$\{Utils\.rand\(Math\.abs\(Number\(d\.uncommitted\)\)\)\}/.test(core),
     'Utils.rand puts the minus between the R and the digits — "R -18 '
     + '000,00" — on the one row that can go below zero');
  ok('and says so in words beside it',
     /Over-committed by /.test(core));
  ok('and the explanation names both rows rather than "that money"',
     /<strong>Approved, waiting to be sent<\/strong>/.test(core)
     && /<strong>Left to decide on<\/strong>/.test(core),
     'the sentence described one row while sitting under two');
}

/* ══ 7. Nobody is listed twice ═════════════════════════════════════ */
console.log('\nand an accepted invitation is not a second member');
{
  const P = portal();
  const res = { can_invite: false, data: [
    { id: '1', invitee_name: 'Odi',    contact: 'o@x.test', status: 'pending'  },
    { id: '2', invitee_name: 'Linda',  contact: 'l@x.test', status: 'accepted' },
    { id: '3', invitee_name: 'Ayanda', contact: 'a@x.test', status: 'accepted' },
    { id: '4', invitee_name: 'Balepi', contact: 'b@x.test', status: 'accepted' },
    { id: '5', invitee_name: 'Sipho',  contact: 's@x.test', status: 'declined' },
  ] };
  const w = words(P._svInvitations(res, 'SA-1'));

  ok('AN ACCEPTED INVITEE IS NOT LISTED AGAIN BY NAME',
     !/Linda/.test(w) && !/Ayanda/.test(w) && !/Balepi/.test(w),
     'they are in Members directly above, so the list repeated three '
     + 'people and a reader counting members got the wrong number: ' + w);
  ok('but the fact that they were invited is kept',
     /3 invitations were accepted/.test(w), w);
  ok('AND AN INVITATION THAT DID NOT BECOME A MEMBERSHIP KEEPS ITS ROW',
     /Sipho/.test(w),
     'a declined invite is nowhere else on the screen: ' + w);
  ok('and somebody still to answer keeps theirs',
     /Odi/.test(w) && /pending/.test(w), w);

  /* One accepted reads as one, not as "1 invitations were accepted". */
  const one = words(P._svInvitations({ can_invite: false, data: [
    { id: '2', invitee_name: 'Linda', contact: 'l@x.test', status: 'accepted' }] }, 'SA-1'));
  ok('and one of them is written as one',
     /1 invitation was accepted/.test(one) && /that member is/.test(one), one);
}

/* ══ 8. What each member has put in, beside what they owe ══════════ */
console.log('\nand the arrears say what each member has already paid');
{
  const P = portal();
  const roster = [{ investor_id: 'I1', status: 'active', is_signatory: true },
                  { investor_id: 'I2', status: 'active', is_signatory: true }];
  const base = {
    g: { name: 'Club', stokvel_quorum: 2, status: 'active',
         mandate_state: { has_mandate: true, quorum: 2, signatories: 2, short_by: 0 },
         setup: { schedule: { from: '2026-01-01' } } },
    shareData: { data: { wallet: 82000, invested: 0, net_assets: 82000,
                         my_share: 0, committed: 0, uncommitted: 82000 } },
    payoutData: { data: [] }, requests: { data: [] },
    members: { data: roster }, mine: [], meIsSignatory: true };
  const overview = arr => {
    P.__c = Object.assign({}, base, { contributions: { arrears: arr } });
    return words(vm.runInContext('_svOverview("SA-1", __c)', P));
  };

  /* A FIXTURE THAT REACHES THE TABLE. A group whose setup steps are not
     done renders the checklist instead of the dashboard, and every
     assertion about the arrears table would then be reading a screen
     that does not contain one — passing or failing on nothing. */
  const w = overview([{ investor_id: 'I1', name: 'Linda', owed: 500,
                        periods: 1, contributed: 4500 }]);
  ok('THE ARREARS TABLE IS WHAT IS BEING DRAWN',
     /Who is behind/.test(w) && /Linda/.test(w),
     'the setup checklist renders instead when a group is not yet going: '
     + w.slice(0, 160));
  ok('and it names a total contributed column', /Total contributed/.test(w), w.slice(0, 200));
  ok('AND SHOWS WHAT THEY HAVE PAID BESIDE WHAT THEY OWE',
     /Linda R 4.500,00 R 500,00/.test(w),
     'somebody who has paid for two years and missed one month is a '
     + 'different conversation from somebody who has never paid: '
     + (w.match(/Linda.{0,60}/) || [''])[0]);
  ok('and a payload without the figure shows a dash, not R 0,00',
     /Linda — R 500,00/.test(overview([{ investor_id: 'I1', name: 'Linda',
                                         owed: 500, periods: 1 }])),
     'a confident zero against somebody who may well have paid is worse '
     + 'than saying nothing');

  /* THE TOTAL IS THE SERVER'S, NOT A SUM OF WHAT THE PAGE HOLDS. */
  const route = read('server/routes/stokvels.js');
  ok('AND THE SERVER AGGREGATES IT RATHER THAN THE PAGE',
     /SUM\(amount_paid\)[\s\S]{0,120}GROUP BY investor_id/.test(route),
     'the rows the page already has are LIMIT 500, so summing them would '
     + 'under-report a long-running group — quietly, on the screen whose '
     + 'job is to say who is behind');
}

/* ══ 9. The notice account on Overview, reporting only ═════════════ */
console.log('\nand the notice account is reported on Overview, not acted on there');
{
  const P = portal();
  const row = async payload => {
    P.__payload = payload;
    vm.runInContext('API._fetch = async () => __payload;', P);
    return words(await vm.runInContext('_svNoticeSummary("SA-1")', P));
  };
  const FUND = { name: 'Agriculture Notice Account', notice_days: 30, min_deposit: 25000 };

  const some = await row({ data: { available: true, fund: FUND,
                                   position: { value: 51000, cost: 50000 }, orders: [] } });
  ok('IT SAYS WHAT THE GROUP HAS IN THERE',
     /Agriculture Notice Account/.test(some) && /R 51.000,00/.test(some),
     some.slice(0, 200));
  ok('and what was put in', /R 50.000,00 put in/.test(some), some.slice(0, 200));

  /* ONE PLACE TO ACT. Two cards each carrying the action is how one of
     them quietly stops showing the minimum, or shows a stale rate, and a
     committee acts on whichever they happened to open. */
  ok('AND IT CARRIES NO ACTION OF ITS OWN',
     !/Ask to move money in/.test(some) && !/Give notice/.test(some),
     'the full card on Investments is the one place to act: ' + some);
  ok('but it sends them to the card that does',
     /investments/.test(await (async () => {
       P.__payload = { data: { available: true, fund: FUND,
                               position: { value: 51000, cost: 50000 }, orders: [] } };
       vm.runInContext('API._fetch = async () => __payload;', P);
       return vm.runInContext('_svNoticeSummary("SA-1")', P);
     })()), 'a row that reports and goes nowhere is a dead end');

  const none = await row({ data: { available: true, fund: FUND,
                                   position: { value: 0, cost: 0 }, orders: [] } });
  ok('and with nothing in it says so rather than drawing a figure',
     /nothing in this yet/.test(none), none.slice(0, 200));

  ok('AND NOTHING AT ALL WHEN THE FUND IS NOT OFFERED',
     (await row({ data: { available: false } })) === '',
     'a section for a product this group cannot reach');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
