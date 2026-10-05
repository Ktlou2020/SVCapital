#!/usr/bin/env node
/* The monthly director report.
 *
 * This is a board pack. Every number on it will be read as a statement about
 * the business, so the checks below are about the ARITHMETIC being defensible,
 * not about the screen rendering.
 *
 * The four that matter most, and why each is a mistake already made on this
 * platform:
 *
 *   THE BRIDGE TIES.    Opening + inflows − outflows must equal closing. It is
 *                       built from one definition measured at two instants, so
 *                       it ties by construction — and the residual is still
 *                       computed and shown, because a bridge that silently
 *                       plugs its own gap is worse than no bridge.
 *
 *   RETURNS ARE NOT IN  A return is earned on principal, not added to it, so it
 *   THE BRIDGE.         never was AUM. Subtracting it would make the bridge
 *                       wrong by exactly that amount.
 *
 *   PAYOUT IS NOT       maturityCron writes a payout whose amount is the
 *   INCOME.             client's capital back PLUS the return. The old report
 *                       summed those as "returns distributed" and overstated it
 *                       by the whole capital in any month with maturities.
 *
 *   MONTHS ARE SAST.    date_trunc runs in the database's timezone, which is
 *                       UTC and was never set. A deposit at 01:30 on the 1st in
 *                       Johannesburg is 23:30 on the last of the previous month
 *                       in UTC. Same fault the pool cycler had.
 *
 * Needs a database:
 *   DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-director-report.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT  = path.join(__dirname, '..', '..');
const read  = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SVC   = read('server/services/directorReport.js');
const SVCC  = strip(SVC);
const ROUTE = strip(read('server/routes/directorReport.js'));
const CRON  = strip(read('server/jobs/directorReportCron.js'));
const DIR   = read('team/js/director.js');
const HTML  = read('team/director.html');
const INDEX = strip(read('server/index.js'));
const SETUP = read('server/db/setup.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

console.log('\nthe month is the business’s month');
{
  ok('the window is cut in SAST, not the database’s timezone',
     /const BUSINESS_TZ = 'Africa\/Johannesburg'/.test(SVCC)
     && /date_trunc\('month', \(now\(\) AT TIME ZONE \$2\)/.test(SVCC),
     'date_trunc runs in UTC, so 01:30 on the 1st in Johannesburg files under last month');
  ok('and no bare date_trunc on now() survives',
     !/date_trunc\('month', now\(\)\s*[-)]/.test(SVCC));
  ok('the period is stated on the report itself',
     /periodStart: w\.start, periodEnd: w\.next/.test(SVCC)
     && /SAST/.test(DIR),
     'a reader cannot check a boundary that is not shown');
}

console.log('\nwhat AUM is');
{
  ok('AUM is principal live at an instant',
     /const LIVE_AT = n => `[\s\S]{0,400}i\.start_date <= \$\$\{n\}::date/.test(SVC));
  ok('an investment leaves when it is processed, not when its end date passes',
     /i\.status = 'active'\s*\n\s*OR COALESCE\(i\.maturity_processed_at/.test(SVC),
     'a row still active with an old end date is a maturity the cron has not run, not money gone');
  ok('and every AUM figure uses that one definition',
     (SVCC.match(/\$\{LIVE_AT\(1\)\}/g) || []).length >= 5,
     'a second definition is a second answer to the same question');
}

console.log('\nthe bridge');
{
  ok('the residual is computed, not absorbed',
     /const residual = closing\.aum - expected;/.test(SVCC));
  ok('and reported either way',
     /reconciles: Math\.abs\(residual\) < 0\.01/.test(SVCC)
     && /Does not reconcile/.test(DIR) && /Reconciles exactly/.test(DIR));
  ok('returns are kept OUT of it',
     !/expected[\s\S]{0,120}realised|opening\.aum[^;]*returns/.test(SVCC)
     && /never inside it/.test(DIR),
     'a return is earned on principal, so subtracting it breaks the bridge by that amount');
  /* investments.status can be NULL on an old row. A bare negation is NULL and
     drops it; COALESCE to 'active' makes it read as still live and ALSO drops
     it, while looking guarded. Either way it sits in opening, leaves closing,
     and appears in no movement. */
  ok('a NULL status does not drop an investment out of the movements',
     !/i\.status <> 'active'/.test(SVCC)
     && !/COALESCE\(i\.status, 'active'\) <> 'active'/.test(SVCC)
     && (SVCC.match(/COALESCE\(i\.status, ''\) <> 'active'/g) || []).length >= 4,
     "COALESCE to '' — defaulting to 'active' is the same bug wearing a guard");
  ok('and LIVE_AT agrees with it, so the two sides cannot disagree',
     /i\.status = 'active'/.test(SVCC),
     'LIVE_AT treats a NULL status as not active and lets the date decide');
  ok('a rollover is shown on both sides rather than netted away',
     /rolledOut: outRoll, returnedToInvestors: outPaid/.test(SVCC)
     && /reinvested: inRe/.test(SVCC));
}

console.log('\nincome is not capital coming back');
{
  ok('income comes from the ledger’s definition',
     /incomeTypesSQL\(\)/.test(SVCC) && /require\('\.\/ledger'\)/.test(SVCC));
  ok('and payout is never summed as income',
     !/type = 'payout'|'payout'\)[\s\S]{0,80}SUM/.test(SVCC),
     'a payout is the client’s capital back plus the return on it');
  ok('accrued and realised are reported side by side, not added',
     /accruedThisMonth:[\s\S]{0,200}realisedOnMaturity:/.test(SVCC)
     && /never added/.test(DIR),
     'a maturity accrued monthly appears in both; adding them books it twice');
}

console.log('\nthe investor figures');
{
  ok('"active investor" means money in a pool, not a row marked active',
     /COUNT\(DISTINCT i\.investor_id\)[\s\S]{0,120}\$\{LIVE_AT\(1\)\}/.test(SVC)
     && /not a row marked active/.test(DIR),
     'counting registrations flatters the number every time somebody signs up');
  ok('concentration is the top ten’s share of AUM',
     /ORDER BY aum DESC LIMIT 10/.test(SVCC) && /top10SharePct/.test(SVCC));
  ok('withdrawals count completed ones only',
     /type = 'withdrawal' AND status = 'completed'/.test(SVCC),
     'a pending withdrawal is a request, not money gone');
  ok('and both the number and the people are counted',
     /COUNT\(\*\)::int AS n, COUNT\(DISTINCT investor_id\)::int AS people/.test(SVCC));
  ok('KYC and FICA are reported separately',
     /kycByStatus/.test(SVCC) && /ficaByStatus/.test(SVCC) && /They disagree/.test(DIR));
}

console.log('\nthe assets behind the money');
{
  ok('the cattle price trend says what it is measuring',
     /priceBasis:/.test(SVCC) && /Not a market beef index/.test(SVCC),
     'our own realised price is not a market quote and must not read as one');
  ok('absent solar generation is reported as absent, never as zero',
     /generationNote: generation \? null/.test(SVCC)
     && /This is not a reading of zero/.test(SVCC),
     'a zero reads as "the fleet generated nothing", which is a different claim');
  ok('and the inverter cloud cannot fail the whole report',
     /catch \(e\) \{ generationError = e\.message; \}/.test(SVCC));
  ok('short term reports what was funded and what is overdue',
     /fundedThisMonth/.test(SVCC) && /overdueDeals/.test(SVCC));
}

console.log('\nthe beef market, which is not the same claim as our own price');
{
  ok('the market price is stored with where it came from and who captured it',
     /CREATE TABLE IF NOT EXISTS beef_market_prices/.test(SETUP)
     && /captured_by   TEXT/.test(SETUP) && /source        TEXT NOT NULL/.test(SETUP),
     'a fetched price and a keyed-in price are both legitimate but not the same claim');
  ok('one price per category per week',
     /UNIQUE \(week_ending, category\)/.test(SETUP));
  ok('the basis is set from the category, never taken from the caller',
     /const basis = CATEGORIES\[category\];/.test(ROUTE)
     && !/req\.body[\s\S]{0,40}basis/.test(ROUTE),
     'Class A is a carcass price and a weaner is live; letting a form choose is letting it be wrong');
  ok('and a price per HEAD cannot be keyed into a per-kilogram column',
     /price <= 0 \|\| price > 500/.test(ROUTE),
     'R19 000 in that column gets multiplied by 475 kilograms');
  ok('a week that has not happened is refused',
     /new Date\(week_ending\) > new Date\(\)/.test(ROUTE));
  ok('capturing a price is directors only, like the rest of the report',
     /router\.post\('\/beef-prices', requireDirector/.test(ROUTE));
  ok('and it is audited', /action:\s*'beef_price\.capture'/.test(ROUTE));

  ok('a carcass price gets the dressing step and a live one does not',
     /classA\.basis === 'carcass' \? dressing : 1/.test(SVCC),
     'skipping it overstates every animal by about 43%');
  ok('the dressing percentage is a stored assumption, not a number in code',
     /setting_key IN \('target_sale_weight_kg','dressing_pct'\)/.test(SVCC)
     && /'dressing_pct', '0\.57'/.test(SETUP));
  ok('and the projection shows the three numbers it was built from',
     /kg live[\s\S]{0,120}dressing[\s\S]{0,120}carcass/.test(DIR),
     'an estimate that hides its inputs reads as a measurement');
  ok('our realised price and the market price stay apart',
     /priceBasis:/.test(SVCC) && /basisNote:/.test(SVCC)
     && /not a sale/.test(SVCC),
     'what we got and what the market is are different claims');
  ok('a stale price says how old it is',
     /staleWeeks:/.test(SVCC) && /week\$\{p\.staleWeeks === 1 \? '' : 's'\} old/.test(DIR),
     'a board pack must not present a month-old price as current');
  ok('and an empty section says so rather than showing a zero',
     /available: false/.test(SVCC) && /No published beef price has been captured yet/.test(SVCC));

  /* There is no fetcher yet, on purpose. If one is added it must be written
     against the real page, not guessed — this assertion is here so that
     adding one is a deliberate act that updates the check. */
  ok('nothing claims to fetch the RPO report automatically',
     !/fetch\(['"`]https:\/\/rpo\.co\.za/.test(SVCC) && !/cheerio|jsdom/.test(SVCC),
     'a parser written against a page nobody has read puts unchecked prices on a board pack');
}

console.log('\nwho may read it');
{
  ok('it is mounted', /app\.use\('\/api\/director-report'/.test(INDEX));
  ok('directors only',
     /const requireDirector = \[requireAuth, requireRole\('director'\)\]/.test(ROUTE),
     'it names the ten largest investors and what each holds');
  ok('on both routes',
     (ROUTE.match(/router\.get\('[^']*', requireDirector/g) || []).length >= 2);
  ok('a malformed month is refused rather than silently becoming last month',
     /\^\\d\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$/.test(ROUTE) && /status\(400\)/.test(ROUTE));
  ok('and reading it is audited',
     /action:\s*'director_report\.view'/.test(ROUTE));
}

console.log('\none source of truth');
{
  ok('the emailed report reads the same service',
     /require\('\.\.\/services\/directorReport'\)/.test(CRON)
     && /report\.buildReport\(null\)/.test(CRON));
  ok('and no longer runs its own AUM query',
     !/SELECT COALESCE\(SUM\(amount\),0\) AS aum FROM investments/.test(CRON),
     'two sets of queries is two answers to "what was AUM in September"');
  ok('the dashboard does not recompute anything either',
     !/SELECT |FROM investments/.test(DIR.slice(DIR.indexOf('async function renderMonthlyReport'),
                                                DIR.indexOf('function downloadReportPDF'))),
     'a number worked out in the browser is a third answer');
}

console.log('\nthe screen and the PDF');
{
  ok('Monthly Report is in the director sidebar', /data-view="monthly-report"/.test(HTML));
  ok('and has a view to render into', /id="view-monthly-report"/.test(HTML));
  ok('navTo renders it', /'monthly-report': renderMonthlyReport/.test(DIR));
  ok('the PDF button is the screen’s action',
     /view === 'monthly-report'[\s\S]{0,200}downloadReportPDF\(\)/.test(DIR));
  ok('the PDF carries the whole report, not one table',
     (DIR.match(/\n  section\('/g) || []).length >= 6
     && /chart\('rptWaterfall'/.test(DIR));
  ok('a chart that will not serialise does not lose the PDF',
     /catch \(_\) \{ \/\* a tainted or empty canvas/.test(DIR));
  ok('the month defaults to one that has ENDED',
     /_reportMonths\[1\] \|\| _reportMonths\[0\]/.test(DIR),
     'a part-month report reads as a collapse in AUM on the 3rd');

  /* Colour never carries identity alone: the platform's own product colours
     fail CVD separation against each other. */
  ok('the product split labels every bar',
     /font-weight:700">\$\{escH\(p\.label\)\}/.test(DIR));
  ok('and an unreadable stored colour is swapped rather than shown',
     /function _rptBarColour\(/.test(DIR) && /enough chroma to read as a colour/.test(DIR));
  ok('charts with one series carry no legend box',
     (DIR.match(/legend: \{ display: false \}/g) || []).length >= 3);

  /* Targeted rather than blanket: the tile and row helpers take values their
     callers have already formatted, so scanning every ${…} just flags those.
     What matters is the fields that carry TEXT somebody typed — a pool name, a
     province, an investor's name — reaching innerHTML raw. */
  const view = DIR.slice(DIR.indexOf('async function renderMonthlyReport'), DIR.indexOf('function _drawReportCharts'));
  const TEXTY = ['p.label', 'p.name', 'p.productLabel', 'p.status', 'p.province',
                 't.name', 'x.name', 'b.band', 'c.priceBasis', 's.generationNote',
                 'r.periodStart', 'r.periodEnd', 'r.generatedAt', 'r.monthLabel'];
  /* p.color is deliberately absent: it never reaches markup directly, only
     through _rptBarColour, which returns either a hex its own regex matched or
     one of five literals. */

  /* Exact: find the nearest escH( before the occurrence and check its matching
     close paren falls after it — so escH(new Date(r.generatedAt)…) counts,
     while a bare ${p.name} does not. A regex cannot do this; [^}] walks into
     the nested template literals these panels are built from. */
  const insideEscH = (src, at) => {
    let from = src.lastIndexOf('escH(', at);
    while (from !== -1) {
      let depth = 0;
      for (let k = from + 4; k < src.length; k++) {
        if (src[k] === '(') depth++;
        else if (src[k] === ')') { depth--; if (depth === 0) return k > at; }
      }
      from = src.lastIndexOf('escH(', from - 1);
    }
    return false;
  };

  const unescaped = [];
  for (const f of TEXTY) {
    let at = -1;
    while ((at = view.indexOf(f, at + 1)) !== -1) {
      if (/[\w.$]/.test(view[at - 1] || '')) continue;        /* part of a longer name */
      const frag = view.slice(at, at + 34).split('\n')[0];
      /* A ternary choosing between two string literals never emits the field. */
      if (/^[\w.]+ === '[^']*' \?/.test(frag)) continue;
      if (insideEscH(view, at)) continue;
      unescaped.push(f + ' @ ' + frag);
    }
  }
  ok('every field carrying text somebody typed goes through escH',
     unescaped.length === 0, unescaped.join(' | '));

}

/* ── Against a database ────────────────────────────────────────────── */
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\n  (skipping the database half — DATABASE_URL not set)');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  const { Pool } = require('pg');
  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

    /* A September whose answer is known before the code runs. */
    await db.query(`DELETE FROM transactions; DELETE FROM investments;
                    DELETE FROM investment_pools; DELETE FROM investors`);
    await db.query(`INSERT INTO investors (id, first_name, last_name, email, province, status, date_joined)
                    VALUES ('RV1','A','One','rv1@check.invalid','Gauteng','active','2025-01-01'),
                           ('RV2','B','Two','rv2@check.invalid','Limpopo','active','2026-09-05')`);
    await db.query(`INSERT INTO investment_pools (id, name, product_type, status, term_months, start_date, end_date, investment_start_date)
                    VALUES ('RP1','Pool One','short_term','active',6,'2026-03-01','2026-03-31','2026-04-01')`);
    /* live before and after the month                                     200 */
    /* matures 20 Sep and is rolled over                                    80 */
    /* matures 25 Sep and is paid back                                      50 */
    /* starts 10 Sep, new money                                             60 */
    /* starts 20 Sep, the rollover landing                                  80 */
    await db.query(`INSERT INTO investments (id, investor_id, pool_id, amount, status, start_date, end_date, product_type, actual_return, maturity_instruction)
      VALUES ('RI-HOLD','RV1','RP1',200,'active','2026-05-01','2027-05-01','short_term',0,'reinvest'),
             ('RI-ROLL','RV1','RP1', 80,'matured','2026-03-20','2026-09-20','short_term',8,'reinvest'),
             ('RI-PAID','RV2','RP1', 50,'matured','2026-03-25','2026-09-25','short_term',5,'payout'),
             ('RI-NEW','RV2','RP1',  60,'active','2026-09-10','2027-03-10','short_term',0,NULL),
             ('RI-RNEW','RV1','RP1', 80,'active','2026-09-20','2027-03-20','short_term',0,NULL)`);
    await db.query(`UPDATE investments SET maturity_processed_at = '2026-09-20 21:00+02' WHERE id='RI-ROLL'`);
    await db.query(`UPDATE investments SET maturity_processed_at = '2026-09-25 21:00+02' WHERE id='RI-PAID'`);
    await db.query(`INSERT INTO transactions (id, investor_id, type, amount, status, investment_id, transaction_date)
      VALUES ('RT1','RV1','reinvestment',80,'completed','RI-RNEW','2026-09-20'),
             ('RT2','RV1','matured_funds',80,'completed','RI-ROLL','2026-09-20'),
             ('RT3','RV2','payout',55,'completed','RI-PAID','2026-09-25'),
             ('RT4','RV1','return',7,'completed',NULL,'2026-09-30'),
             ('RT5','RV2','withdrawal',30,'completed',NULL,'2026-09-28'),
             ('RT6','RV2','withdrawal',12,'pending',NULL,'2026-09-29')`);

    const svc = require(path.join(ROOT, 'server', 'services', 'directorReport.js'));
    const rep = await svc.buildReport('2026-09');
    const m = rep.aum.movement;

    console.log('\nthe arithmetic, against a month whose answer is known');
    ok('opening is 330', m.opening === 330, `got ${m.opening}`);
    ok('new capital is 60', m.newCapital === 60, `got ${m.newCapital}`);
    ok('reinvested is 80', m.reinvested === 80, `got ${m.reinvested}`);
    ok('rolled out is 80', m.rolledOut === 80, `got ${m.rolledOut}`);
    ok('returned to investors is 50', m.returnedToInvestors === 50, `got ${m.returnedToInvestors}`);
    ok('closing is 340', m.closing === 340, `got ${m.closing}`);
    ok('and the bridge ties with nothing left over',
       m.reconciles && m.residual === 0, `residual ${m.residual}`);
    ok('closing equals opening plus the movements',
       m.closing === m.opening + m.newCapital + m.reinvested - m.rolledOut - m.returnedToInvestors);

    ok('income is the 7 accrued, not the 55 that was paid out',
       rep.returns.accruedThisMonth === 7, `got ${rep.returns.accruedThisMonth}`);
    ok('and the realised return on maturities is 13, reported apart',
       rep.returns.realisedOnMaturity === 13, `got ${rep.returns.realisedOnMaturity}`);
    ok('reinvestment rate is 80 of 130',
       Math.round(rep.returns.reinvestment.reinvestedPct) === 62,
       `got ${rep.returns.reinvestment.reinvestedPct}`);

    ok('two investors still hold money', rep.investors.activeInvestors === 2,
       `got ${rep.investors.activeInvestors}`);
    ok('one withdrawal, by one investor, of 30',
       rep.investors.withdrawals.count === 1 && rep.investors.withdrawals.investors === 1
       && rep.investors.withdrawals.total === 30);
    ok('and the pending one is counted apart',
       rep.investors.withdrawals.pendingCount === 1 && rep.investors.withdrawals.pendingTotal === 12);

    /* The beef projection, worked out by hand first:
       72.50 R/kg carcass x 475 kg live x 0.57 dressing = 19 629.375 a head. */
    await db.query(`DELETE FROM beef_market_prices`);
    await db.query(`INSERT INTO beef_market_prices (week_ending, category, basis, rand_per_kg, source)
                    VALUES ('2026-08-29','class_a','carcass',69.40,'check'),
                           ('2026-09-26','class_a','carcass',72.50,'check')`);
    const beef = (await svc.buildReport('2026-09')).underlying.cattle.market;
    ok('the market price is picked up', beef.available && beef.classANow === 72.5,
       `got ${beef.classANow}`);
    ok('the move across the month is +4.47%',
       Math.abs(beef.classAChangePct - 4.4668) < 0.01, `got ${beef.classAChangePct}`);
    ok('a finished animal projects at 19 629.38',
       Math.abs(beef.projectedPerHead - 19629.375) < 0.01, `got ${beef.projectedPerHead}`);

    /* The same price quoted LIVE must not get the dressing step. */
    await db.query(`UPDATE beef_market_prices SET basis = 'live' WHERE category = 'class_a'`);
    const live = (await svc.buildReport('2026-09')).underlying.cattle.market;
    ok('and a live-basis price skips the dressing step',
       Math.abs(live.projectedPerHead - 72.50 * 475) < 0.01, `got ${live.projectedPerHead}`);
    await db.query(`DELETE FROM beef_market_prices`);
    const none = (await svc.buildReport('2026-09')).underlying.cattle.market;
    ok('with nothing captured the section is empty, not zero',
       none.available === false && none.projectedPerHead === undefined);

    /* The same month again, with the paid-out investment's status NULLed — the
       state every row written before the column got its default is in. */
    await db.query(`UPDATE investments SET status = NULL WHERE id = 'RI-PAID'`);
    const nulled = await svc.buildReport('2026-09');
    ok('a NULL-status maturity still counts as money returned',
       nulled.aum.movement.returnedToInvestors === 50,
       `got ${nulled.aum.movement.returnedToInvestors}`);
    ok('and the bridge still ties',
       nulled.aum.movement.reconciles && nulled.aum.movement.residual === 0,
       `residual ${nulled.aum.movement.residual}`);
    await db.query(`UPDATE investments SET status = 'matured' WHERE id = 'RI-PAID'`);

    /* A maturity dated 20 Sep 23:00 SAST is 21:00 UTC the same day — but one
       dated 1 Oct 00:30 SAST is 30 Sep 22:30 UTC, and a UTC month would put
       it in September. */
    await db.query(`INSERT INTO investments (id, investor_id, pool_id, amount, status, start_date, end_date, product_type)
                    VALUES ('RI-EDGE','RV1','RP1',999,'active','2026-10-01','2027-04-01','short_term')`);
    const again = await svc.buildReport('2026-09');
    ok('an investment starting 1 October is not September’s',
       again.aum.movement.newCapital === 60, `got ${again.aum.movement.newCapital}`);
    ok('nor is it in September’s closing AUM',
       again.aum.movement.closing === 340, `got ${again.aum.movement.closing}`);
    const oct = await svc.buildReport('2026-10');
    ok('and October picks it up', oct.aum.movement.newCapital === 999,
       `got ${oct.aum.movement.newCapital}`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
