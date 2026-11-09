#!/usr/bin/env node
/* Reporting an outside trading facility, with only OUR share of it.
 *
 * SV Capital put R141 990 into Grain Co's maize facility. Grain Co buys a
 * load of maize for about R120 000, sells it, and the MARGIN is split between
 * two pools by their capital on the day the load was bought; Pool A's share
 * is then split 60/40 between Grain Co and us.
 *
 * WHICH IS WHY A LOAD IS NOT A LOAN, and the first thing asserted here.
 * shortterm_loans holds one borrower, one principal, one repayment. Sixteen
 * loads written as loan rows would report R1.9m deployed against capital at
 * risk of R141 990 — an overstatement of thirteen times, on the console a
 * fund manager reads.
 *
 * THE TRAP THAT NEARLY GOT SHIPPED. The sheet is built from a template whose
 * sample rows are italic, and its legend still says "Load # in italics =
 * EXAMPLE row". Every live load is italic, because the real data was typed
 * over those rows and kept their formatting. An importer that believed the
 * legend would have discarded the whole facility and reported nothing; one
 * that believed the opposite, on a sheet where the samples HAD been left,
 * would report money that does not exist. So rows are chosen by CONTENT — a
 * number, a purchase date, a cost — and the check holds a fixture with
 * italic live rows AND non-italic blanks to prove formatting is ignored.
 *
 * Also held here:
 *
 *   · an unsettled load has NO share, stored NULL and shown as a dash, never
 *     R0,00 — zero reads as "earned nothing on it" and most of this facility
 *     at any moment is simply not due yet
 *   · our share is checked against the sheet's OWN Pool A margin, not
 *     re-derived from the displayed pool percentage, which is rounded to one
 *     decimal and made four live loads look wrong by cents the first time
 *   · a load that disappears from the sheet is reported, never deleted
 *   · the sync previews, and only staff can run it
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-trading-facility.cjs
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

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const svc  = require(path.join(ROOT, 'server', 'services', 'grainFacility.js'));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 3 });

/* A sheet shaped like the real one. The live rows are class "s9" (ITALIC,
   exactly as the operator's are) and the blank template rows are "s10" (not
   italic) — the wrong way round from the legend, which is the point. Real
   trading figures are not committed; these are invented. */
const LOADS_HTML = `<html><head><style>
  .s9  { font-style:italic; color:#1f4fbf; }
  .s10 { color:#1f4fbf; }
</style></head><body><table>
<tr><td class="s2">1</td><td class="s2">Loads log</td></tr>
<tr><td class="s2">2</td><td class="s2">Load # in italics = EXAMPLE row</td></tr>
<tr><td>4</td><td>Load #</td><td>Date bought</td><td></td><td>Tons</td><td>SAFAX</td>
    <td>Buy price (R/t)</td><td>Sell price (R/t)</td><td>Date buyer paid</td>
    <td>Pool A payout date</td><td>Load cost (R)</td><td>Margin (R)</td>
    <td>Pool A capital on date</td><td>Pool B capital on date</td><td>Pool A %</td>
    <td>Pool B %</td><td>Pool A margin (R)</td><td>Grain Co from Pool A (R)</td>
    <td>SV Capital from Pool A (R)</td><td>To Pool B bucket (R)</td><td>Pool A status</td></tr>
<!-- settled, pool wholly ours -->
<tr><td>5</td><td class="s9">1</td><td class="s9">06 Oct 2026</td><td></td><td class="s9">37.7</td>
    <td class="s9">R 3,995</td><td class="s9">R 3,495</td><td class="s9">R 3,745</td>
    <td class="s9">07 Oct 2026</td><td class="s9">12 Oct 2026</td><td class="s9">R 100,000.00</td>
    <td class="s9">R 10,000.00</td><td class="s9">R 141,990.00</td><td class="s9">-</td>
    <td class="s9">100.0%</td><td class="s9">0.0%</td><td class="s9">R 10,000.00</td>
    <td class="s9">R 6,000.00</td><td class="s9">R 4,000.00</td><td class="s9">-</td>
    <td class="s9">Paid</td></tr>
<!-- settled, pool shared: the DISPLAYED 22.1% does not reproduce the share,
     but 40% of the sheet's own Pool A margin does, exactly -->
<tr><td>6</td><td class="s9">2</td><td class="s9">27 Oct 2026</td><td></td><td class="s9">36.2</td>
    <td class="s9">R 3,832</td><td class="s9">R 3,332</td><td class="s9">R 3,582</td>
    <td class="s9">02 Nov 2026</td><td class="s9">02 Nov 2026</td><td class="s9">R 120,618</td>
    <td class="s9">R 9,050</td><td class="s9">R 141,990</td><td class="s9">R 500,000</td>
    <td class="s9">22.1%</td><td class="s9">77.9%</td><td class="s9">R 2,001.60</td>
    <td class="s9">R 1,200.96</td><td class="s9">R 800.64</td><td class="s9">R 7,048.40</td>
    <td class="s9">Paid</td></tr>
<!-- bought, buyer has NOT paid: there is no share yet -->
<tr><td>7</td><td class="s9">3</td><td class="s9">05 Nov 2026</td><td></td><td class="s9">35.4</td>
    <td class="s9">R 3,824</td><td class="s9">R 3,324</td><td class="s9">R 3,574</td>
    <td class="s9"></td><td class="s9"></td><td class="s9">R 117,670</td>
    <td class="s9">R 8,850</td><td class="s9">R 141,990</td><td class="s9">R 500,000</td>
    <td class="s9">22.1%</td><td class="s9">77.9%</td><td class="s9">R 1,956.90</td>
    <td class="s9"></td><td class="s9"></td><td class="s9"></td>
    <td class="s9">Awaiting buyer</td></tr>
<!-- the sheet's own arithmetic does not tie: 40% of 2,000.00 is 800.00 -->
<tr><td>8</td><td class="s9">4</td><td class="s9">06 Nov 2026</td><td></td><td class="s9">30.0</td>
    <td class="s9">R 3,800</td><td class="s9">R 3,300</td><td class="s9">R 3,550</td>
    <td class="s9">07 Nov 2026</td><td class="s9">07 Nov 2026</td><td class="s9">R 99,000</td>
    <td class="s9">R 9,000</td><td class="s9">R 141,990</td><td class="s9">R 500,000</td>
    <td class="s9">22.1%</td><td class="s9">77.9%</td><td class="s9">R 2,000.00</td>
    <td class="s9">R 1,200.00</td><td class="s9">R 950.00</td><td class="s9">R 7,000.00</td>
    <td class="s9">Paid</td></tr>
<!-- buyer HAS paid, and the sheet has not worked out our share yet. Its
     repayment period is a known fact; our earnings on it are not. -->
<tr><td>8b</td><td class="s9">5</td><td class="s9">07 Nov 2026</td><td></td><td class="s9">20.0</td>
    <td class="s9">R 3,800</td><td class="s9">R 3,300</td><td class="s9">R 3,500</td>
    <td class="s9">09 Nov 2026</td><td class="s9"></td><td class="s9">R 60,000</td>
    <td class="s9">R 4,000</td><td class="s9">R 141,990</td><td class="s9">R 500,000</td>
    <td class="s9">22.1%</td><td class="s9">77.9%</td><td class="s9">R 884.00</td>
    <td class="s9"></td><td class="s9"></td><td class="s9"></td>
    <td class="s9">Awaiting Pool A split</td></tr>
<!-- blank template rows: NOT italic, and must be skipped anyway -->
<tr><td>9</td><td class="s10">6</td><td class="s10"></td><td></td><td class="s10"></td>
    <td class="s10"></td><td class="s10"></td><td class="s10"></td><td class="s10"></td>
    <td class="s10"></td><td class="s10"></td><td class="s10"></td></tr>
<tr><td>10</td><td class="s10">7</td><td class="s10"></td><td></td><td class="s10"></td>
    <td class="s10"></td><td class="s10"></td><td class="s10"></td><td class="s10"></td>
    <td class="s10"></td><td class="s10"></td><td class="s10"></td></tr>
</table></body></html>`;

const CAPITAL_HTML = `<html><body><table>
<tr><td>4</td><td>Investor</td><td>Pool (A/B)</td><td>Amount (R)</td><td>Date in</td>
    <td>Date out</td><td>Pool B returns to date (R)</td><td>Notes</td></tr>
<tr><td>5</td><td class="s9">SV Capital</td><td class="s9">A</td><td class="s9">R 141,990</td>
    <td class="s9">06 Oct 2026</td><td class="s9"></td><td class="s9"></td><td class="s9"></td></tr>
<tr><td>6</td><td class="s9">BridgeWorks</td><td class="s9">B</td><td class="s9">R 500,000</td>
    <td class="s9">27 Oct 2026</td><td class="s9"></td><td class="s9">R 29,032.26</td><td class="s9"></td></tr>
<tr><td>7</td><td class="s9">SV Capital</td><td class="s9">A</td><td class="s9">R 50,000</td>
    <td class="s9">01 Nov 2026</td><td class="s9">15 Nov 2026</td><td class="s9"></td><td class="s9">withdrawn</td></tr>
</table></body></html>`;

(async () => {
  try {
    const { rows: [has] } = await pool.query(
      `SELECT to_regclass('public.stl_facility_loads') IS NOT NULL AS ok`);
    if (!has.ok) { console.log('  SKIP  schema predates trading facilities'); process.exit(0); }

    /* ── A load is not a loan ─────────────────────────────────────── */
    console.log('\na load is activity inside a facility, not a loan');
    {
      const SETUP = fs.readFileSync(path.join(ROOT, 'server', 'db', 'setup.js'), 'utf8');
      ok('facilities have their own table', /CREATE TABLE IF NOT EXISTS stl_facilities/.test(SETUP));
      ok('and the loads hang off it', /stl_facility_loads/.test(SETUP)
         && /REFERENCES stl_facilities\(id\)/.test(SETUP));
      /* The overstatement this avoids, stated as a number so the next person
         reads why rather than guessing. */
      const ROUTE = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'facilities.js'), 'utf8');
      ok('nothing writes a load into shortterm_loans',
         !/INSERT INTO shortterm_loans/.test(ROUTE),
         'sixteen R120k loads as loan rows would report R1.9m against R141,990 at risk');
      ok('one row per load, so a re-read restates rather than duplicates',
         /stl_facility_loads_uniq[\s\S]{0,120}facility_id, load_ref/.test(SETUP));
    }

    /* ── Formatting is not data ───────────────────────────────────── */
    console.log('\nrows are chosen by what is in them, never by how they look');
    const warnings = [];
    const parsed = svc.parseLoads(LOADS_HTML, {
      ourColumn: 'sv capital from pool a (r)', ourSharePct: 0.40, warnings });
    ok('the italic live rows are all read',
       parsed.loads.length === 5,
       `${parsed.loads.length} load(s) — the operator's live rows are italic, because the real `
       + 'data was typed over the template’s samples and kept their styling');
    ok('and the non-italic blank template rows are not',
       parsed.skipped === 2 && !parsed.loads.some(l => l.load_ref === '6')
       && !parsed.loads.some(l => l.load_ref === '7'),
       `skipped ${parsed.skipped}`);
    ok('the parser contains no notion of italics at all',
       !/italic|font-style/.test(
         fs.readFileSync(path.join(ROOT, 'server', 'services', 'grainFacility.js'), 'utf8')
           .replace(/\/\*[\s\S]*?\*\//g, '')),
       'believing the legend would have discarded the whole facility');

    /* ── Our share, and only ours ─────────────────────────────────── */
    console.log('\nand each load reports our share, not the facility’s');
    {
      const l1 = parsed.loads.find(l => l.load_ref === '1');
      const l2 = parsed.loads.find(l => l.load_ref === '2');
      ok('a load whose pool is wholly ours gives us 40% of its margin',
         l1.our_margin === 4000 && l1.margin_total === 10000, JSON.stringify(l1));
      ok('and a shared pool gives us 40% of the POOL’s margin, not the load’s',
         l2.our_margin === 800.64 && l2.margin_total === 9050,
         'the load made R9,050; R800.64 of it is ours');
      ok('the load cost is kept, as context and not as our exposure',
         l1.load_cost === 100000, String(l1.load_cost));
    }

    /* ── Unsettled is not zero ────────────────────────────────────── */
    console.log('\nand a load the buyer has not paid for has no share yet');
    {
      const l3 = parsed.loads.find(l => l.load_ref === '3');
      ok('our share is NULL, not 0', l3.our_margin === null, JSON.stringify(l3.our_margin));
      ok('and it is marked unsettled', l3.settled === false);
      ok('so it is not counted as earned',
         svc.summarise(parsed.loads, 141990).our_margin_earned === 4000 + 800.64 + 950,
         JSON.stringify(svc.summarise(parsed.loads, 141990)));
      /* R0,00 against a load would read as a loss-making trade. */
      ok('nothing turns an unsettled load into zero',
         !parsed.loads.some(l => !l.settled && l.our_margin === 0));
    }

    /* ── The arithmetic check, and the false alarm it must not raise ── */
    console.log('\nand the sheet’s own arithmetic is checked, on the step we rely on');
    {
      ok('a load whose share does not tie is flagged by name',
         warnings.length === 1 && /Load 4/.test(warnings[0]), JSON.stringify(warnings));
      ok('and the flag quotes both figures',
         /950\.00/.test(warnings[0]) && /800\.00/.test(warnings[0]), warnings[0]);
      /* THE FALSE ALARM. Load 2's share cannot be reproduced from the
         DISPLAYED 22.1%: 9050 × 0.221 × 0.4 = 800.02, not 800.64. Deriving it
         that way flagged four live loads, and a verification that cries wolf
         is the one somebody turns off. */
      ok('but a load whose share ties to the sheet’s own pool margin is NOT flagged',
         !warnings.some(w => /Load 2/.test(w)),
         'its share is not reproducible from the pool % the sheet PRINTS, which is '
         + 'rounded to one decimal; it is exactly 40% of the pool margin the sheet gives');
      ok('and the flagged load is still imported, not dropped',
         !!parsed.loads.find(l => l.load_ref === '4'),
         'a figure to question is reported with the question, not silently removed');
    }

    /* ── Our capital ──────────────────────────────────────────────── */
    console.log('\nand our capital is what is actually at risk');
    {
      const c = svc.parseCapital(CAPITAL_HTML, { ourName: 'SV Capital' });
      ok('only our own deposits are read', c.deposits.length === 2
         && c.deposits.every(d => d.investor === 'SV Capital'), JSON.stringify(c.deposits));
      ok('the other pool’s investor is not ours to report',
         !c.deposits.some(d => /BridgeWorks/.test(d.investor)));
      ok('and money taken back out is not still at risk',
         c.capital === 141990,
         `${c.capital} — R141,990 in, plus R50,000 that was withdrawn again`);
      const s = svc.summarise(parsed.loads, c.capital);
      ok('the return is measured on our capital, not the facility’s turnover',
         s.return_on_capital === Math.round((5750.64 / 141990) * 10000) / 10000,
         JSON.stringify(s.return_on_capital));
      ok('and it is not annualised off three weeks of trading',
         !/annual/i.test(JSON.stringify(s)), Object.keys(s).join(','));
    }

    /* ── Money words ─────────────────────────────────────────────── */
    console.log('\nand it reads the sheet’s own number formats');
    {
      ok('"R 131,761.50" is 131761.5', svc.money('R 131,761.50') === 131761.5);
      ok('a dash is nothing, not zero', svc.money('-') === null && svc.money('') === null,
         'the sheet writes an empty figure as a dash');
      ok('a negative is negative', svc.money('-R 4,032') === -4032);
      ok('"22.1%" is 0.221', svc.pct('22.1%') === 0.221);
      ok('"06 Oct 2026" is 2026-10-06', svc.isoDate('06 Oct 2026') === '2026-10-06');
      ok('and a date it does not recognise is null, not a guess',
         svc.isoDate('6/10/26') === null,
         'a date read wrong puts a load in the wrong month, which is what this reports on');
    }

    /* ── A sheet that has changed shape ───────────────────────────── */
    console.log('\nand a sheet that no longer looks like itself is refused, not guessed at');
    {
      const noCol = LOADS_HTML.replace('SV Capital from Pool A (R)', 'Our bit');
      let threw = null;
      try { svc.parseLoads(noCol, { ourColumn: 'sv capital from pool a (r)', ourSharePct: 0.4 }); }
      catch (e) { threw = e; }
      ok('a missing share column is refused by name', !!threw
         && /sv capital from pool a/i.test(threw.message), threw && threw.message);
      let threw2 = null;
      try { svc.parseLoads('<html><body><p>unpublished</p></body></html>',
              { ourColumn: 'x', ourSharePct: 0.4 }); }
      catch (e) { threw2 = e; }
      ok('and a page with no loads table at all is refused', !!threw2
         && /no loads table/i.test(threw2.message), threw2 && threw2.message);
      /* Columns are found by name, so a note inserted above the table moves
         every row and changes nothing. */
      const shifted = LOADS_HTML.replace('<tr><td class="s2">1</td>',
        '<tr><td class="s2">0</td><td class="s2">a new note</td></tr><tr><td class="s2">1</td>');
      const again = svc.parseLoads(shifted, {
        ourColumn: 'sv capital from pool a (r)', ourSharePct: 0.40 });
      ok('a row inserted above the table does not shift the reading',
         again.loads.length === 5 && again.loads[0].our_margin === 4000,
         `${again.loads.length} load(s)`);
    }

    /* ── The report, and what it refuses to be ───────────────────── */
    console.log('\nand it is a report, not a ledger');
    {
      const ROUTE = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'facilities.js'), 'utf8');
      /* The fetch, the plan and the write moved into services/facilitySync
         when the schedule needed them too, so these look where the code
         lives now rather than where it was first written. */
      const SYNC0 = fs.readFileSync(path.join(ROOT, 'server', 'services', 'facilitySync.js'), 'utf8');
      ok('it previews unless told to apply',
         /const apply = String\(\(req\.body \|\| \{\}\)\.apply\) === 'true'/.test(ROUTE)
         && /\{ apply, actor/.test(ROUTE));
      ok('and the service writes nothing until told to',
         /if \(!apply\) return plan;/.test(SYNC0));
      ok('staff only', /requireRole\(\.\.\.STAFF\)/.test(ROUTE)
         && /const STAFF\s*=\s*\['admin', 'director', 'fund_manager'\]/.test(ROUTE));
      ok('and only a published Google sheet is fetched',
         /docs\\\.google\\\.com/.test(SYNC0),
         'an arbitrary URL from a database row is a request this server makes on somebody’s behalf');
      ok('the fetch has a timeout and a size cap',
         /FETCH_TIMEOUT_MS/.test(SYNC0) && /MAX_BYTES/.test(SYNC0),
         'a read with no ceiling can hang a worker');
      ok('a load that vanishes from the sheet is reported, never deleted',
         /no_longer_in_sheet/.test(SYNC0) && !/DELETE FROM stl_facility_loads/.test(SYNC0),
         'a row disappearing from somebody else’s spreadsheet is not authority to drop ours');
      ok('nothing here credits a wallet or touches investor returns',
         !/wallet_balance/.test(ROUTE) && !/recordTransaction/.test(ROUTE)
         && !/investor_allocations/.test(ROUTE));
      /* The sheet is an outside document; a name out of it reaching the page
         unescaped is the same bug as a client-typed one. */
      const UI = fs.readFileSync(path.join(ROOT, 'fund', 'js', 'shortterm.js'), 'utf8');
      ok('and nothing the sheet says becomes markup',
         /_stlEsc\(l\.status/.test(UI) && /_stlEsc\(l\.load_ref\)/.test(UI));
      ok('the screen says where the figures came from',
         /come from a spreadsheet the operator maintains/.test(UI));
      ok('and says the load cost is not ours',
         /NOT ours/.test(UI), 'it is the figure somebody would read as a return');
      ok('an unsettled load shows as unsettled, not as R0,00',
         /l\.settled \? stlfmt\.zar\(l\.our_margin\) : /.test(UI)
         && /not settled/.test(UI));
    }

    /* ── Registered, not hardcoded ────────────────────────────────── */
    console.log('\nand the facility is registered, with no loads read on deploy');
    {
      await require(path.join(ROOT, 'server', 'db', 'setup.js'))();
      const { rows: [f] } = await pool.query(
        `SELECT * FROM stl_facilities WHERE id = 'FAC-GRAINCO'`);
      ok('the Grain Co facility exists', !!f, 'registered by setup');
      ok('with our share on it, not in the code',
         f && Number(f.our_share_pct) === 0.4, f && String(f.our_share_pct));
      ok('and the column its sheet holds our share in',
         f && f.our_column === 'SV Capital from Pool A (R)', f && f.our_column);
      ok('its sheet URLs are the published ones',
         f && /^https:\/\/docs\.google\.com\/spreadsheets\/d\/e\//.test(f.loads_url)
         && /gid=/.test(f.loads_url), f && f.loads_url);
      ok('and a deploy reads no loads',
         (await pool.query(`SELECT COUNT(*)::int AS n FROM stl_facility_loads
                             WHERE facility_id = 'FAC-GRAINCO'`)).rows[0].n === 0,
         'a deploy must not silently restate what the fund reports');
      ok('nor has it been synced', f && f.last_synced_at === null);
      /* The capital is short-term investors' money, which makes this margin
         what BACKS what they are paid. Recorded, said on screen, and
         deliberately not wired into what anybody is paid. */
      ok('it records that short-term investors funded it',
         f && f.funded_from === 'short_term', f && String(f.funded_from));
      const UI2 = fs.readFileSync(path.join(ROOT, 'fund', 'js', 'shortterm.js'), 'utf8');
      ok('and the screen says so',
         /Funded from the short-term investment/.test(UI2));
      ok('while saying plainly that it drives no payout',
         /not<\/strong> fed into NAV or into any payout/.test(UI2),
         'a hand-edited spreadsheet must not move what a client is paid');
      const ROUTE2 = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'facilities.js'), 'utf8');
      ok('and nothing in the route touches the NAV engine or a schedule',
         !/return_schedules/.test(ROUTE2) && !/LoanNAV/.test(ROUTE2)
         && !/UPDATE investments/.test(ROUTE2));
    }
    /* ── Tons and timing ─────────────────────────────────────────── */
    console.log('\nand it reports the tons funded and how long the money is out');
    {
      /* A fixed as-at date, so "outstanding for N days" is the same answer
         every time this runs rather than growing by one a day. */
      const a = svc.summarise(parsed.loads, 141990, '2026-11-10');
      ok('tons are counted across every load, paid for or not',
         a.tons_total === 159.3, String(a.tons_total));
      ok('and settled tons apart from tons still out',
         a.tons_settled === 103.9 && a.tons_awaiting === 55.4,
         `${a.tons_settled} settled / ${a.tons_awaiting} out`);
      /* Tons are funded when the load is BOUGHT. Counting only settled ones
         would understate what the facility has put through. */
      ok('so the total is the tons funded, not the tons earned on',
         a.tons_total > a.tons_settled);

      ok('the average buyer repayment period is the mean of purchase to payment',
         a.days_to_buyer_payment.value === 2.5, JSON.stringify(a.days_to_buyer_payment));
      /* The count and the range are what make an average honest. Three loads
         is not a trend, and 1–6 days is a different fact from "about 3". */
      ok('and it carries how many loads it is drawn from, and the spread',
         a.days_to_buyer_payment.n === 4 && a.days_to_buyer_payment.min === 1
         && a.days_to_buyer_payment.max === 6, JSON.stringify(a.days_to_buyer_payment));
      ok('the lag from the buyer paying to our pool being paid is its own figure',
         a.days_buyer_paid_to_payout.value === 1.7 && a.days_buyer_paid_to_payout.n === 3,
         JSON.stringify(a.days_buyer_paid_to_payout));
      ok('unsettled loads are aged from the day asked about',
         a.days_outstanding_unsettled.value === 4 && a.days_outstanding_unsettled.n === 2,
         JSON.stringify(a.days_outstanding_unsettled));
      ok('and the oldest one is named, not averaged away',
         a.oldest_unsettled && a.oldest_unsettled.load_ref === '3'
         && a.oldest_unsettled.days === 5, JSON.stringify(a.oldest_unsettled));
      /* THE CASE A MUTATION EXPOSED. Load 5's buyer has paid and the sheet
         has not yet worked out our share. Its repayment period is a known
         fact about the trade and belongs in that average; our earnings on it
         do not exist yet. Measuring the average over settled loads only
         would bias it towards whatever the bookkeeping has caught up on. */
      ok('a load the buyer paid for but whose share is not worked out yet counts in the period',
         a.days_to_buyer_payment.n === 4
         && parsed.loads.find(l => l.load_ref === '5').date_buyer_paid === '2026-11-09',
         JSON.stringify(a.days_to_buyer_payment));
      ok('but is not counted as earned', a.our_margin_earned === 5750.64
         && parsed.loads.find(l => l.load_ref === '5').our_margin === null,
         String(a.our_margin_earned));
      ok('and still reads as awaiting settlement',
         parsed.loads.find(l => l.load_ref === '5').settled === false
         && a.awaiting_settlement === 2, String(a.awaiting_settlement));
      ok('the report says which day it was drawn for',
         a.as_at === '2026-11-10', a.as_at);

      /* AN EMPTY AVERAGE IS NOT ZERO. "0 days" reads as instant payment,
         which is the opposite of nothing to measure. */
      /* Loads the buyer has not paid for AT ALL — the only set with nothing
         to measure, now that one unsettled load has a payment date. */
      const none = svc.summarise(parsed.loads.filter(l => !l.date_buyer_paid), 141990, '2026-11-10');
      ok('an average with nothing behind it is null, not 0',
         none.days_to_buyer_payment.value === null && none.days_to_buyer_payment.n === 0,
         JSON.stringify(none.days_to_buyer_payment));
      ok('and it earns nothing rather than earning zero per ton',
         none.our_margin_earned === 0 && none.our_margin_per_ton === null,
         JSON.stringify({ e: none.our_margin_earned, t: none.our_margin_per_ton }));

      ok('our margin per ton is over settled tons only',
         a.our_margin_per_ton === Math.round((5750.64 / 103.9) * 100) / 100,
         String(a.our_margin_per_ton));
      ok('and our average per settled load over the settled ones only',
         a.our_avg_per_settled_load === Math.round((5750.64 / 3) * 100) / 100,
         String(a.our_avg_per_settled_load));

      /* The facility's trading margin and our return on capital differ by
         more than tenfold here. Conflating them is the single most
         misleading thing this report could do, so they are separate keys. */
      ok('the facility’s gross trading margin is on ITS cost',
         a.facility_margin_on_cost === Math.round((28050 / 319618) * 10000) / 10000,
         String(a.facility_margin_on_cost));
      ok('and is nowhere near our return on capital, which is the point of keeping them apart',
         a.facility_margin_on_cost !== a.return_on_capital
         && a.facility_cost_settled === 319618, JSON.stringify(
           { margin_on_cost: a.facility_margin_on_cost, roc: a.return_on_capital }));
      ok('a missing tonnage is counted, so the total is never read as complete',
         svc.summarise([{ settled: true, our_margin: 1, tons: null, load_cost: 1 }], 1, '2026-11-10')
           .tons_missing_on_loads === 1);
      /* Calendar days, parsed as UTC midnight. A 'YYYY-MM-DD' given to
         new Date() unzoned is local midnight in some runtimes, and
         subtracting two of those on a server off the business day is wrong
         by one whole day. */
      ok('days are counted as calendar days, from the dates as written',
         svc.daysBetween('2026-10-30', '2026-11-09') === 10
         && svc.daysBetween('2026-11-05', '2026-11-05') === 0);
      ok('and a missing date gives no number rather than a wrong one',
         svc.daysBetween(null, '2026-11-09') === null
         && svc.daysBetween('2026-11-09', null) === null);
    }

    /* ── One write path, two callers ──────────────────────────────── */
    console.log('\nand the button and the schedule are the same operation');
    {
      const ROUTE = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'facilities.js'), 'utf8');
      const CRON  = fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'facilitySyncCron.js'), 'utf8');
      for (const [what, src] of [['the route', ROUTE], ['the schedule', CRON]]) {
        ok(`${what} calls services/facilitySync`, /services\/facilitySync/.test(src));
        ok(`${what} has no write of its own`,
           !/INSERT INTO stl_facility_loads/.test(src),
           'two upserts drift, and the drift is a figure a fund manager reads');
      }
      ok('the schedule goes through the watched wrapper, not node-cron',
         /require\('\.\/_watched'\)/.test(CRON) && !/require\('node-cron'\)/.test(CRON),
         'a schedule that silently stops being scheduled produces nothing, and a '
         + 'stale report looks exactly like a correct one');
      ok('it applies rather than previewing, because it has nobody to show a preview to',
         /apply: true/.test(CRON));
      ok('and one facility failing does not stop the others',
         /for \(const f of rows\)/.test(CRON) && /failed\+\+/.test(CRON)
         && /catch \(err\)/.test(CRON),
         'an unpublished sheet on one facility must not take the rest of the report with it');
      ok('it is started at boot', /startFacilitySyncCron\(\)/.test(
         fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8')));
      /* A run that changed nothing must not write an audit row, or the runs
         that moved a figure are buried among the quiet ones. */
      const SYNC = fs.readFileSync(path.join(ROOT, 'server', 'services', 'facilitySync.js'), 'utf8');
      ok('a quiet scheduled run writes no audit row',
         /if \(added\.length \|\| newlySettled\.length \|\| changed\.length \|\| warnings\.length\)/.test(SYNC));
      ok('and the schedule still cannot delete a load',
         !/DELETE FROM stl_facility_loads/.test(SYNC) && /no_longer_in_sheet/.test(SYNC));
      ok('nor reach a wallet, a schedule, NAV or a payout',
         !/wallet_balance/.test(SYNC) && !/return_schedules/.test(SYNC)
         && !/recordTransaction/.test(SYNC) && !/UPDATE investments/.test(SYNC));
    }

    /* ── Against the target ──────────────────────────────────────── */
    console.log('\nand it says whether the capital here earns its target');
    {
      const a = svc.summarise(parsed.loads, 141990, '2026-11-09');
      const F = { target_rate: 0.08, target_months: 5, capital_since: '2026-10-06' };
      const c = svc.coverage(a, F, '2026-11-09');
      ok('the period runs in calendar months from the day the capital went in',
         c.period_start === '2026-10-06' && c.period_end === '2027-03-06'
         && c.period_days === 151, JSON.stringify(
           { s: c.period_start, e: c.period_end, d: c.period_days }));
      ok('the whole-period target is the rate on our capital',
         c.target_full_period === 11359.2, String(c.target_full_period));
      /* Pro rata on days, NOT a monthly rate compounded: 8% over five months
         is one rate over one period, and compounding 1.6% a month would
         invent a target nobody set. */
      ok('and the target so far is pro rata on days elapsed',
         c.days_elapsed === 34
         && c.target_to_date === Math.round(11359.2 * (34 / 151) * 100) / 100,
         JSON.stringify({ d: c.days_elapsed, t: c.target_to_date }));
      ok('earned is measured against it', c.earned === 5750.64
         && c.surplus === Math.round((5750.64 - c.target_to_date) * 100) / 100,
         JSON.stringify({ e: c.earned, s: c.surplus }));
      /* One of the two is always zero. A single figure that could be either
         sign is one somebody reads with the wrong sign. */
      ok('a surplus means no shortfall', c.shortfall === 0);
      /* Both figures, because they answer different questions: 2.2x the
         target SO FAR, and half the whole five-month target already. */
      ok('and the cover is stated both to date and against the whole period',
         c.cover_to_date === Math.round((5750.64 / c.target_to_date) * 1000) / 1000
         && c.cover_full_period === Math.round((5750.64 / 11359.2) * 1000) / 1000
         && c.cover_to_date > 1 && c.cover_full_period < 1,
         JSON.stringify({ td: c.cover_to_date, full: c.cover_full_period }));

      /* THE SCOPE. This is cover on the capital in THIS facility, not on the
         short-term book, which is larger and deployed elsewhere too. */
      ok('the capital it was computed on is named in the result',
         c.on_capital === 141990, String(c.on_capital));

      console.log('\nand it is a target, never a debt');
      const words = JSON.stringify(c).toLowerCase();
      ok('nothing in it is called owed, due or arrears',
         !/owed|arrears/.test(words) && !/"due/.test(words),
         'a shortfall against a target is a fact to act on, not a liability');
      ok('and the words used are surplus and shortfall',
         'surplus' in c && 'shortfall' in c);

      console.log('\nand a behind-target facility says so plainly');
      const thin = svc.coverage({ our_margin_earned: 500, our_capital: 141990,
                                  as_at: '2026-11-09' }, F, '2026-11-09');
      ok('a shortfall is reported', thin.shortfall > 0 && thin.surplus === 0,
         JSON.stringify({ s: thin.surplus, sf: thin.shortfall }));
      ok('and cover below one', thin.cover_to_date < 1, String(thin.cover_to_date));

      console.log('\nand it refuses to work it out on a guess');
      for (const [what, f2] of [
        ['no target rate',   { target_months: 5, capital_since: '2026-10-06' }],
        ['no target period', { target_rate: 0.08, capital_since: '2026-10-06' }],
      ]) {
        const u = svc.coverage(a, f2, '2026-11-09');
        ok(`with ${what} it says so instead of answering`,
           u.known === false && u.missing.length > 0, JSON.stringify(u));
      }
      const noCap = svc.coverage(svc.summarise(parsed.loads, null, '2026-11-09'), F, '2026-11-09');
      ok('and with no capital figure it names that as what is missing',
         noCap.known === false && /capital/.test(noCap.missing.join(' ')),
         JSON.stringify(noCap.missing));

      console.log('\nand the period has an end');
      const after = svc.coverage(a, F, '2027-06-01');
      ok('past the end, the target is the whole target and not more',
         after.target_to_date === after.target_full_period
         && after.days_elapsed === after.period_days, JSON.stringify(
           { t: after.target_to_date, f: after.target_full_period }));
      ok('and it says the period has ended', after.period_complete === true);

      /* THE BUG THAT ONLY AN END-TO-END RUN FOUND. node-postgres hands a DATE
         column back as a JS Date, and the first version concatenated it onto
         'T00:00:00Z' — an Invalid Date whose toISOString() THREW, 500ing the
         whole facility screen. The check had passed throughout, because it
         called coverage() with a string the way a test does and not with the
         row shape the route actually holds. */
      console.log('\nand it takes the date in whatever shape the caller holds it');
      const asDate = svc.coverage(a,
        { target_rate: 0.08, target_months: 5, capital_since: new Date('2026-10-06T00:00:00Z') },
        '2026-11-09');
      ok('a Date out of the database works, not only an ISO string',
         asDate.known === true && asDate.period_start === '2026-10-06'
         && asDate.period_end === '2027-03-06', JSON.stringify(asDate).slice(0, 150));
      ok('and gives the same answer as the string did',
         asDate.target_to_date === c.target_to_date
         && asDate.cover_to_date === c.cover_to_date);
      ok('a timestamp is read as its calendar day',
         svc._asIsoDay(new Date('2026-10-06T22:30:00Z')) === '2026-10-06'
         && svc._asIsoDay('2026-10-06T00:00:00.000Z') === '2026-10-06');
      /* A REPORT MUST NOT THROW. An unreadable date is the same answer as any
         other missing input: said, not crashed. */
      let threw3 = false, out3 = null;
      try {
        out3 = svc.coverage(a, { target_rate: 0.08, target_months: 5,
                                 capital_since: 'not a date' }, '2026-11-09');
      } catch (_) { threw3 = true; }
      ok('and an unreadable date is reported rather than thrown',
         !threw3 && out3 && out3.known === false,
         threw3 ? 'it threw, which 500s the whole screen' : JSON.stringify(out3));
      ok('with what was wrong named', !threw3 && /capital went in/.test((out3.missing || []).join(' ')),
         JSON.stringify(out3 && out3.missing));
      /* ABSENT is not the same as UNREADABLE. With no capital_since at all —
         a facility whose capital sheet has not been read yet — the first
         load is a fair proxy, and the result SAYS it is one, so a figure
         resting on it is not read as resting on the real date. */
      const proxy = svc.coverage(a, { target_rate: 0.08, target_months: 5 }, '2026-11-09');
      ok('with no start date at all it falls back to the first load',
         proxy.known === true && proxy.period_start === a.first_load,
         JSON.stringify({ s: proxy.period_start, f: a.first_load }));
      ok('and says the start date is a stand-in',
         proxy.period_start_is_proxy === true, String(proxy.period_start_is_proxy));
      ok('while a real start date is not flagged as one',
         c.period_start_is_proxy === false, String(c.period_start_is_proxy));

      console.log('\nand the start date is the capital still in, not money taken back');
      const SYNC1 = fs.readFileSync(path.join(ROOT, 'server', 'services', 'facilitySync.js'), 'utf8');
      ok('a withdrawn deposit does not pull the start date earlier',
         /deposits\.filter\(d => !d\.date_out && d\.date_in\)/.test(SYNC1),
         'money that has been taken back out is not capital the target runs on');
      ok('and it is stored rather than re-derived on every read',
         /capital_since = COALESCE/.test(SYNC1));
    }

    /* ── The panel renders ─────────────────────────────────────────
       THE WHOLE FILE IS LOADED AND THE VIEW IS RUN, not a slice of it with
       the awkward parts stubbed.

       The first version lifted the functions it wanted and supplied `fmt`
       itself, because `fmt` was not in the slice. That hid the bug: the
       formatter in this file is called stlfmt, every `fmt.zar(...)` in the
       facilities view was a ReferenceError, and production hung on "Reading
       facilities…" with both API calls returning 200. A check that stubs the
       thing that is missing proves only that the stub works.

       So: the real file, in a context holding nothing but the browser
       globals it may legitimately expect. Anything it references that it did
       not define is a ReferenceError here, exactly as in the browser. This is
       the third bug of this shape in this work — a placeholder written as
       text, a helper out of scope, and now a misnamed global — and all three
       are invisible to node --check. */
    console.log('\nand the screen renders what it was given');
    {
      const vm = require('vm');
      const UI = fs.readFileSync(path.join(ROOT, 'fund', 'js', 'shortterm.js'), 'utf8');
      const box = {};
      const node = () => ({ innerHTML: '', style: {}, textContent: '', value: '', files: [],
                            classList: { add() {}, remove() {} }, addEventListener() {} });
      const ctx = { console: { log() {}, warn() {}, error() {} },
                    Math, Number, String, Object, Array, Boolean, Date, JSON,
                    parseFloat, parseInt, isNaN, RegExp, Set, Map, Error,
                    encodeURIComponent, setTimeout, clearTimeout,
                    fetch: async () => { throw new Error('the check makes no requests'); },
                    localStorage: { getItem: () => null, setItem() {} },
                    location: { replace() {}, href: '' },
                    document: { getElementById: id => (box[id] = box[id] || node()),
                                querySelector: () => node(), querySelectorAll: () => [],
                                createElement: () => node(), addEventListener() {}, body: node() } };
      ctx.globalThis = ctx; ctx.window = ctx; ctx.self = ctx;
      vm.createContext(ctx);
      let loadErr = null;
      try { vm.runInContext(UI, ctx); } catch (e) { loadErr = e; }
      ok('the console script loads', !loadErr, loadErr && loadErr.message);

      /* The payload shapes the route really returns, taken from a live run. */
      const FAC = { id: 'FAC-GRAINCO', name: 'Grain Co maize facility', partner_name: 'Grain Co',
                    our_name: 'SV Capital', funded_from: 'short_term', our_share_pct: 0.4,
                    last_synced_at: '2026-11-09T07:24:24.982Z', warnings: [] };
      const SUM = svc.summarise(parsed.loads, 141990, '2026-11-09');
      const COV = svc.coverage(SUM, { target_rate: 0.08, target_months: 5,
                                      capital_since: '2026-10-06' }, '2026-11-09');
      ctx.stlGet = async p => /loads/.test(p)
        ? { data: parsed.loads, facility: FAC, summary: SUM, coverage: COV }
        : { data: [FAC] };

      let threwR = null;
      await ctx.renderFacilitiesView().catch(e => { threwR = e; });
      const html = (box['stl-view-facilities'] || {}).innerHTML || '';
      /* THE ASSERTION THAT WOULD HAVE CAUGHT IT. A throw here leaves the
         spinner up and the screen dead, with the API returning 200 — which
         is exactly what it looked like in production. */
      ok('the facilities view renders without throwing', !threwR,
         threwR && `${threwR.constructor.name}: ${threwR.message}`);
      ok('and replaces the loading spinner',
         html.length > 800 && !/Reading facilities/.test(html), html.slice(0, 160));

      ok('it shows the coverage panel', /Against the target/.test(html));
      ok('the tons and timing panel', /Tons funded to date/.test(html)
         && /Average buyer repayment period/.test(html));
      ok('our share column, headed as ours', /OUR SHARE/.test(html));
      ok('and the facility’s own margin marked not ours',
         /not ours/.test(html) && /not our money/.test(html));
      ok('an unsettled load reads as unsettled rather than R0,00',
         /not settled/.test(html) && !/>R0,00</.test(html));
      ok('it says where the figures came from and that it re-reads itself',
         /come from a spreadsheet the operator maintains/.test(html)
         && /re-read on its own every 6 hours/.test(html));
      ok('and that this is short-term money that drives no payout',
         /Funded from the short-term investment/.test(html)
         && /not<\/strong> fed into NAV or into any payout/.test(html));
      ok('nothing renders an unresolved placeholder', !/\$\{/.test(html),
         'a ${...} in the output means a template literal was written as text');

      /* The empty and error paths render too — a facility list that is empty
         must say so rather than leaving the spinner, which is the same
         failure wearing different clothes. */
      ctx.stlGet = async () => ({ data: [] });
      await ctx.renderFacilitiesView().catch(() => {});
      ok('with no facilities it says so rather than spinning',
         /No trading facilities/.test((box['stl-view-facilities'] || {}).innerHTML || ''));
      ctx.stlGet = async () => { throw new Error('API 500: boom'); };
      await ctx.renderFacilitiesView().catch(() => {});
      ok('and a failing request shows the failure rather than spinning',
         /Could not load/.test((box['stl-view-facilities'] || {}).innerHTML || ''));

      /* The day formatters, directly: an average over nothing shown as
         "0 days" would read as the buyer paying instantly. */
      ok('an average of days reads as days', ctx._stlDays({ value: 2.7, n: 3 }) === '2.7 days');
      ok('one day is not "1 days"', ctx._stlDays({ value: 1, n: 2 }) === '1 day');
      ok('and nothing to average is a dash, never 0 days',
         ctx._stlDays({ value: null, n: 0 }) === '—' && ctx._stlDays(null) === '—');
      ok('the range says what the average is drawn from',
         /Over 3 loads/.test(ctx._stlRange({ value: 2.7, n: 3, min: 1, max: 6 }, 'x')));
      ok('a behind-target facility says behind, not ahead',
         /Behind target by/.test(ctx._stlCoverage(Object.assign({}, COV,
           { earned: 500, surplus: 0, shortfall: 2057.7, cover_to_date: 0.195 }), {})));
      ok('and one with no target says so rather than showing zero',
         /Not worked out yet/.test(ctx._stlCoverage({ known: false, missing: ['the target rate'] }, {})));
    }
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    await pool.end().catch(() => {});
    await require(path.join(ROOT, 'server', 'db', 'pool')).end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
