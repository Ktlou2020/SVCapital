#!/usr/bin/env node
/* The rate the notice account declares, worked out from the maize book.
 *
 * THE RULE THE BUSINESS SET: take the trading facility's return for the
 * month; below 1.5% that IS the rate; above it, cap it at 1.5%. The admin
 * can still declare by hand, and that path is untouched.
 *
 * WHY THE CAP IS THE PRODUCT. The book can have a very good month. Paying
 * it all over sets an expectation the next month cannot meet, and the
 * promise of a notice account — the money is there in thirty days — is
 * paid for out of the spread. The cap is what makes a good month fund a
 * bad one, so it is checked from both sides: a month under it passes
 * through untouched, a month over it is cut to exactly 1.5%, and the
 * figure the book actually made is still reported beside it. A capped
 * month that reported only 1.5% would hide the one thing somebody will
 * ask about.
 *
 * AND NOTHING HERE DECLARES ANYTHING. stl_facilities says in its own
 * header that its rows come from a spreadsheet maintained by hand and must
 * not feed investor payouts. So this works out a figure and returns it;
 * declaring is still noticeFund.declareRate, pressed by a person. That is
 * asserted too — a service that quietly wrote a rate would have broken a
 * rule the platform set itself.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-notice-fund-rate.cjs
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
const strip = s => String(s).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const F = 'STLF-RATE-1';

(async () => {
  try {
    const { rows: [r] } = await db.query(
      `SELECT to_regclass('public.stl_facility_loads') IS NOT NULL AS ready`);
    if (!r.ready) { console.log('\n  SKIP  no trading facility tables here'); return; }

    const rate = require(path.join(ROOT, 'server', 'services', 'noticeFundRate.js'));

    const clean = async () => {
      await db.query(`DELETE FROM stl_facility_loads WHERE facility_id LIKE 'STLF-RATE-%'`);
      await db.query(`DELETE FROM stl_facilities WHERE id LIKE 'STLF-RATE-%'`);
    };
    await clean();

    /* R100 000 of our capital, so a rand of margin is a basis point and the
       arithmetic can be read off the page. */
    await db.query(
      `INSERT INTO stl_facilities (id, name, partner_name, our_name, our_column, our_capital,
                                   funded_from, status)
       VALUES ($1,'Grain Co maize facility','Grain Co','SV Capital','SV Capital from Pool A (R)',
               100000,'Short-term investment product','active')`, [F]);

    const load = async (ref, ours, paidOut, buyerPaid) => db.query(
      `INSERT INTO stl_facility_loads (id, facility_id, load_ref, our_margin, payout_date, date_buyer_paid)
       VALUES ($1,$2,$3,$4,$5::date,$6::date)`,
      [`STLL-${ref}`, F, ref, ours, paidOut, buyerPaid]);

    console.log('\na month under the cap is the rate itself');
    {
      /* R800 on R100 000 = 0.8%. */
      await load('A1', 500, '2026-09-10', '2026-09-08');
      await load('A2', 300, '2026-09-27', '2026-09-25');
      const out = await rate.facilityMonth(db, { facilityId: F, month: '2026-09' });
      ok('it reads the facility by name', out.facility && out.facility.name === 'Grain Co maize facility',
         JSON.stringify(out.facility));
      ok('OUR SHARE IS SUMMED, not the facility’s margin', out.realised === 800, String(out.realised));
      ok('over the capital actually at risk', out.capital === 100000, String(out.capital));
      ok('AND THE RATE IS THAT FIGURE', out.rate === 0.008, String(out.rate));
      ok('the cap is not applied', out.cap_applied === false, JSON.stringify(out));
      ok('and both loads counted', out.loads === 2, String(out.loads));
    }

    console.log('\nand a month over it is cut to 1.5%');
    {
      /* R3 100 on R100 000 = 3.1%, which is a very good month. */
      await load('B1', 2000, '2026-10-05', '2026-10-03');
      await load('B2', 1100, '2026-10-21', '2026-10-19');
      const out = await rate.facilityMonth(db, { facilityId: F, month: '2026-10' });
      ok('THE BOOK’S OWN FIGURE IS STILL REPORTED', out.raw === 0.031, String(out.raw));
      ok('AND THE RATE IS THE CAP', out.rate === 0.015, String(out.rate));
      ok('and it says it was capped',
         out.cap_applied === true,
         'a month cut from 3.1% to 1.5% that reported only "1.5%" would hide the '
         + 'one thing somebody is going to ask about');
      ok('the cap is 1.5%, from one definition', rate.CAP === 0.015, String(rate.CAP));
    }

    console.log('\nand a load that has not settled earns nothing yet');
    {
      /* our_margin NULL: the buyer has paid but the split is not done. */
      await db.query(
        `INSERT INTO stl_facility_loads (id, facility_id, load_ref, our_margin, payout_date, date_buyer_paid)
         VALUES ('STLL-C1',$1,'C1',NULL,NULL,'2026-11-04')`, [F]);
      const out = await rate.facilityMonth(db, { facilityId: F, month: '2026-11' });
      ok('AN UNSETTLED LOAD IS NOT A ZERO-MARGIN LOAD',
         out.realised === 0 && out.loads === 0,
         JSON.stringify(out) + ' — our_margin is NULL until the margin is split, and '
         + 'counting it as earned-nothing would understate a month that is simply not done');
      ok('so the month reads as nothing earned yet, not as a loss', out.rate === 0, String(out.rate));
    }

    console.log('\nand a month is the month the money landed');
    {
      /* Paid out in December, buyer paid in November. The money was ours in
         December, and that is the month it counts in. */
      await load('D1', 900, '2026-12-02', '2026-11-28');
      const nov = await rate.facilityMonth(db, { facilityId: F, month: '2026-11' });
      const dec = await rate.facilityMonth(db, { facilityId: F, month: '2026-12' });
      ok('PAYOUT DATE DECIDES, not the day the buyer paid',
         nov.realised === 0 && dec.realised === 900,
         `November ${nov.realised}, December ${dec.realised}`);
      ok('and the basis is stated rather than left to be guessed at',
         /paid out/.test(dec.basis || ''), dec.basis);

      /* A sheet that has not recorded a payout yet still has a month. */
      await load('E1', 400, null, '2026-12-14');
      const dec2 = await rate.facilityMonth(db, { facilityId: F, month: '2026-12' });
      ok('and with no payout recorded it falls back to the day the buyer paid',
         dec2.realised === 1300, String(dec2.realised));
    }

    console.log('\nand it refuses rather than inventing a denominator');
    {
      await db.query(`UPDATE stl_facilities SET our_capital = NULL WHERE id = $1`, [F]);
      const out = await rate.facilityMonth(db, { facilityId: F, month: '2026-09' });
      ok('NO CAPITAL, NO RATE', !!out.error,
         'a return is margin over capital; with the denominator unknown there is '
         + 'no rate to offer and guessing one would be inventing it');
      ok('and it says what to do instead',
         /by hand|sync/i.test(out.error || ''), out.error);
      await db.query(`UPDATE stl_facilities SET our_capital = 100000 WHERE id = $1`, [F]);

      ok('a month that is not a month is refused',
         !!(await rate.facilityMonth(db, { facilityId: F, month: 'later' })).error);
      ok('and a facility that is not there',
         !!(await rate.facilityMonth(db, { facilityId: 'nope', month: '2026-09' })).error);
    }

    console.log('\nand nothing it does declares a rate');
    {
      const SRC = strip(fs.readFileSync(
        path.join(ROOT, 'server', 'services', 'noticeFundRate.js'), 'utf8'));
      ok('THE SERVICE WRITES NOTHING',
         !/INSERT|UPDATE|DELETE/i.test(SRC),
         'the loads come from a spreadsheet somebody maintains by hand, and '
         + 'stl_facilities says in its own header that such a document must not '
         + 'feed investor payouts');
      ok('and declaring is still a separate, deliberate act',
         /declareRate/.test(strip(fs.readFileSync(
           path.join(ROOT, 'server', 'routes', 'noticeFundAdmin.js'), 'utf8'))),
         'the POST a person presses');

      const ADMIN = strip(fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8'));
      ok('the console only FILLS the figure in, it does not submit it',
         /function useFacilityRate/.test(ADMIN)
         && !/useFacilityRate[\s\S]{0,600}declareNoticeFundRate\(/.test(ADMIN),
         'a button that worked a rate out and published it in one press is how a '
         + 'hand-edited sheet comes to move a client’s money');
      ok('and it shows the uncapped figure beside the capped one',
         /cap_applied/.test(ADMIN) && /d\.raw/.test(ADMIN), 'admin/js/admin.js');
    }

    await clean();
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
