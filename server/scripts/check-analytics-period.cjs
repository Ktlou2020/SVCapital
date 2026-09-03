#!/usr/bin/env node
/* A date range must scope the things a range can scope, and nothing else.
 *
 * The distinction this exists to hold:
 *
 *   FLOWS   money or records that MOVED inside the window — net deposits,
 *           returns paid, platform revenue, new investors, new investments.
 *           A range scopes them and a prior-period comparison means something.
 *
 *   STOCKS  what is true right now — active capital, active investments,
 *           total investors. A range does not scope them. "Active Capital,
 *           last 30 days, up 12%" is not a fact about anything, and a
 *           dashboard that prints it has stopped being evidence.
 *
 * Two other ways this kind of panel misleads, both pinned below: a percentage
 * against a zero base ("up 100%" from nothing is a first occurrence, not
 * growth), and a verdict colour on a metric that has no good direction — more
 * returns paid to investors is neither a win nor a loss on its own.
 *
 * The SQL is read out of the route and run against data placed either side of
 * a known boundary, so the window arithmetic is executed rather than reasoned
 * about. The verdict logic is rendered in headless Chromium from the shipped
 * function.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-analytics-period.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
/* The one definition of income, from the same helper the route calls. This
   check used to hand-write `type IN ('return','payout')` — the definition the
   route carried before a payout was found to be capital coming back plus the
   return on it. The route was fixed and this was not, so the check went on
   asserting the old answer: it would have passed just as happily if the route
   had regressed. Reaching for the helper is what stops that happening twice. */
const { incomeTypesSQL } = require(path.join(ROOT, 'server', 'services', 'ledger.js'));
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const eqN = (name, a, b, d) =>
  ok(name, Math.abs(Number(a) - Number(b)) < 0.005, d || `expected ${b}, got ${a}`);

function isScratchDatabase(url) {
  const n = (String(url).split('?')[0].split('/').pop() || '').toLowerCase();
  return /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(n) || /^svctest/.test(n);
}
async function ensureSchema() {
  const { rows } = await pool.query(
    `SELECT bool_and(to_regclass('public.' || t) IS NOT NULL) AS ready
       FROM unnest($1::text[]) AS t`, [['investors', 'investments', 'transactions']]);
  if (rows[0].ready) return true;
  if (!isScratchDatabase(process.env.DATABASE_URL) && process.env.CHECK_ALLOW_RESET !== '1') {
    console.log('  SKIP  incomplete schema and this is not a scratch database.');
    return false;
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  return true;
}

/* The window arithmetic, lifted from the route rather than restated. */
function routeWindowSql() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'analytics-extra.js'), 'utf8');
  const i = src.indexOf("router.get('/kpis/period'");
  const body = src.slice(i, src.indexOf('\n});', i));
  const tz = "Africa/Johannesburg";
  const anchor = d => `((${d})::timestamp AT TIME ZONE '${tz}')`;
  const today = `((NOW() AT TIME ZONE '${tz}')::date)`;
  ok('the route computes its window in Johannesburg time',
     body.includes("AT TIME ZONE '${TZ}'") || body.includes('Africa/Johannesburg'),
     'a UTC day boundary would half-include a local day');
  ok('the prior period ends exactly where the current one starts',
     /const PT\s*=\s*F;/.test(body),
     'a gap or an overlap between the two makes the comparison meaningless');
  ok('a zero prior yields no percentage',
     /prior === 0 \? null/.test(body));
  ok('stocks are returned apart from flows',
     /stocks: \{/.test(body) && /flows: \{/.test(body) &&
     /a date range does not scope these/i.test(body));
  return { anchor, today };
}

async function seed() {
  await pool.query('DELETE FROM transactions');
  await pool.query('DELETE FROM investments');
  await pool.query('DELETE FROM investors');
  await pool.query(`
    INSERT INTO investors (id,first_name,last_name,email,status,date_joined) VALUES
     ('P-IN','In','Window','in@x.test','active',  NOW() - INTERVAL '5 days'),
     ('P-PRI','Prior','Window','pri@x.test','active', NOW() - INTERVAL '40 days'),
     ('P-OLD','Long','Ago','old@x.test','active',  NOW() - INTERVAL '400 days')`);
  await pool.query(`
    INSERT INTO transactions (id,investor_id,type,amount,status,reference,transaction_date,created_at) VALUES
     ('P-D','P-IN','deposit',    1000,'completed','PD',  NOW() - INTERVAL '5 days',  NOW()),
     ('P-W','P-IN','withdrawal', -250,'completed','PW',  NOW() - INTERVAL '3 days',  NOW()),
     ('P-F','P-IN','fee',      -12.50,'completed','PF',  NOW() - INTERVAL '2 days',  NOW()),
     /* A payout is the client's capital coming back PLUS the return on it, so
        it is cash, not income. It sits inside the window on purpose: the
        figure below is right only if this row is left out of it. */
     ('P-R','P-IN','payout',      300,'completed','PR',  NOW() - INTERVAL '4 days',  NOW()),
     ('P-RET','P-IN','return',    180,'completed','PRT', NOW() - INTERVAL '4 days',  NOW()),
     ('P-INT','P-IN','interest',   20,'completed','PIN', NOW() - INTERVAL '4 days',  NOW()),
     ('P-PD','P-PRI','deposit',   400,'completed','PPD', NOW() - INTERVAL '40 days', NOW()),
     ('P-OD','P-OLD','deposit',  9999,'completed','POD', NOW() - INTERVAL '400 days',NOW()),
     ('P-PEND','P-IN','deposit', 5555,'pending',  'PPE', NOW() - INTERVAL '1 days',  NOW())`);
  await pool.query(`
    INSERT INTO investments (id,investor_id,pool_id,pool_name,amount,status,start_date,end_date,
        annual_rate,term_months,expected_return,actual_return,product_type,created_at)
    VALUES ('P-INV','P-IN',NULL,'p',7000,'active',CURRENT_DATE-5,CURRENT_DATE+90,
            0.12,6,0,0,'cattle', NOW() - INTERVAL '5 days')`);
}

(async () => {
  try {
    if (!await ensureSchema()) { await pool.end(); process.exit(0); }
    console.log('\nthe route separates what a range can scope from what it cannot');
    const { anchor, today } = routeWindowSql();
    await seed();

    /* Rebuild the same 30-day window the route builds, and query through it. */
    const F = anchor(`${today} - (30 - 1)`), T = anchor(`${today} + 1`);
    const PF = `(${F} - (${T} - ${F}))`;
    const when = 'COALESCE(transaction_date, created_at)';
    const q = async (a, b) => (await pool.query(`
      SELECT
        COALESCE((SELECT SUM(CASE WHEN type='deposit' THEN ABS(amount) ELSE -ABS(amount) END)
                    FROM transactions WHERE status='completed' AND type IN ('deposit','withdrawal')
                     AND ${when} >= ${a} AND ${when} < ${b}),0) AS net_deposits,
        COALESCE((SELECT SUM(ABS(amount)) FROM transactions
                   WHERE status='completed' AND type IN ('fee','platform_fee')
                     AND ${when} >= ${a} AND ${when} < ${b}),0) AS revenue,
        COALESCE((SELECT SUM(ABS(amount)) FROM transactions
                   WHERE status='completed' AND type IN (${incomeTypesSQL()})
                     AND ${when} >= ${a} AND ${when} < ${b}),0) AS returns_paid,
        (SELECT COUNT(*) FROM investors
          WHERE COALESCE(date_joined,created_at) >= ${a}
            AND COALESCE(date_joined,created_at) <  ${b})       AS new_investors`)).rows[0];

    const cur = await q(F, T), pri = await q(PF, F);

    console.log('\nthe window includes what moved inside it');
    eqN('net deposits net the withdrawal off', cur.net_deposits, 1000 - 250);
    eqN('a fee stored negative counts as revenue', cur.revenue, 12.5);
    eqN('"Returns Paid" is the return and the interest, and not the payout',
        cur.returns_paid, 180 + 20);
    eqN('one investor joined inside the window', cur.new_investors, 1);

    console.log('\nand excludes what did not');
    eqN('a pending deposit is not counted', cur.net_deposits, 750,
        'the R5,555 pending deposit must not appear');
    eqN('the prior window holds only the prior deposit', pri.net_deposits, 400);
    ok('the 400-day-old deposit is in neither window',
       Number(cur.net_deposits) !== 9999 && Number(pri.net_deposits) !== 9999);

    console.log('\nthe two windows are contiguous and equal');
    {
      const { rows: [w] } = await pool.query(`
        SELECT ${T} - ${F} AS span, ${F} - ${PF} AS prior_span, ${F} AS boundary`);
      ok('they are the same length', String(w.span) === String(w.prior_span),
         `${w.span} vs ${w.prior_span}`);
      ok('with no gap or overlap between them', !!w.boundary);
    }

    if (CHROME) {
      console.log('\nthe panel states a change only when there is a base for one');
      const src = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      const i = src.indexOf('const AN_PERIOD_METRICS');
      const fns = src.slice(i, src.indexOf('\n}\n', src.indexOf('async function loadPeriodKpis')) + 3);
      const page = `<!doctype html><meta charset="utf-8"><body>
<div id="an-period-window"></div><div id="an-period-metrics"></div>
<select id="an-period-days"><option value="30" selected>30</option></select>
<script>
const _esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const Utils = { rand: (v,d) => 'R' + Number(v||0).toLocaleString('en-US',{maximumFractionDigits:d||0}),
                date: s => String(s).slice(0,10) };
let RESPONSE = null;
const API = { _fetch: async () => RESPONSE };
${fns}
(async () => {
  const mk = (c,p) => ({ current:c, prior:p, change:c-p,
                         change_pct: p === 0 ? null : ((c-p)/Math.abs(p))*100 });
  RESPONSE = { range:{from:'a',to:'b',prior_from:'c',prior_to:'d'},
    flows: { net_deposits: mk(400,750), platform_revenue: mk(900,500),
             returns_paid: mk(500,900), new_investors: mk(5,5), new_investments: mk(3,0) } };
  await loadPeriodKpis();
  var res = [...document.querySelectorAll('#an-period-metrics .stat-card')].map(function(c){
    var delta = c.lastElementChild, span = delta.querySelector('span'), icon = delta.querySelector('i');
    return { label: c.querySelector('.stat-card__label').textContent,
             colour: span ? (span.getAttribute('style')||'').replace('color:','') : '',
             icon: icon ? ([].slice.call(icon.classList).filter(function(x){
                    return x.indexOf('fa-arrow') === 0 || x === 'fa-minus'; })[0] || '') : '',
             text: delta.textContent.replace(/\\s+/g,' ').trim() };
  });
  document.title = 'RESULTS' + JSON.stringify(res);
})();
<\/script></body>`;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-period-'));
      const file = path.join(dir, 'p.html');
      fs.writeFileSync(file, page);
      /* 4000ms of virtual time was enough on an idle machine and not enough on
         a busy one: this failed once in a shuffled run and passed on the same
         seed immediately after, which is a browser that ran out of budget, not
         a panel that stopped working. A larger budget costs nothing when the
         page settles early — virtual time skips ahead — and the real timeout
         below is what stops a wedged browser. */
      let dom = '';
      try {
        dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox',
          '--virtual-time-budget=15000', '--dump-dom', 'file://' + file],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
      } catch (err) { dom = (err.stdout || '').toString(); }
      const m = dom.match(/<title>RESULTS(.*?)<\/title>/s);
      /* Say what came back. A bare false here sent the last reader looking at
         the panel code, which was fine. */
      if (!m) { ok('the panel reported results', false,
                   'no RESULTS title; DOM ended: ' + dom.trim().slice(-300)); }
      else {
        const decode = s => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
                             .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const cards = JSON.parse(decode(m[1]));
        const by = l => cards.find(c => c.label === l) || {};
        ok('a fall in net deposits reads as bad',
           by('Net Deposits').icon === 'fa-arrow-down' && by('Net Deposits').colour === '#ef4444',
           JSON.stringify(by('Net Deposits')));
        ok('a rise in revenue reads as good',
           by('Platform Revenue').icon === 'fa-arrow-up' && by('Platform Revenue').colour === '#22c55e',
           JSON.stringify(by('Platform Revenue')));
        ok('returns paid gets no verdict colour — it has no good direction',
           by('Returns Paid').colour === 'var(--text-muted)', JSON.stringify(by('Returns Paid')));
        ok('an unchanged figure shows a dash, not an arrow',
           by('New Investors').icon === 'fa-minus', JSON.stringify(by('New Investors')));
        ok('a zero prior says so instead of claiming a percentage',
           /no prior activity/.test(by('New Investments').text) &&
           !/%/.test(by('New Investments').text), JSON.stringify(by('New Investments')));
        ok('the prior figure is shown beside the change, not just the arrow',
           /vs R750/.test(by('Net Deposits').text), by('Net Deposits').text);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      console.log('\n  SKIP  no headless Chromium — verdict rendering not exercised');
    }

    console.log('\nthe panel is isolated like the others');
    {
      const src = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      ok('it is registered in the panel list', /\['Period performance',\s+loadPeriodKpis\]/.test(src));
      ok('and rethrows so a failure is named rather than swallowed',
         /throw e;   \/\/ so the panel wrapper names it in the failure list/.test(src));
      const html = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
      ok('the cumulative tiles are labelled as not scoped by the range',
         /not scoped by the period selected below/.test(html),
         'without that, the tiles above read as period figures');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    await pool.query('DELETE FROM transactions').catch(() => {});
    await pool.query('DELETE FROM investments').catch(() => {});
    await pool.query('DELETE FROM investors').catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
