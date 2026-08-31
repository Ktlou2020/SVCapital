#!/usr/bin/env node
/* The Fund Ops console read and wrote a database that does not exist.
 *
 * check-schema-contract proves the columns exist; this proves the console
 * behaves once they do. The two halves matter separately, because most of what
 * was wrong here was not a missing column but the console's reaction to one:
 * a failed write into a catch that shows a generic toast, or a read of a field
 * that is simply undefined and renders as a dash.
 *
 * WHAT WAS BROKEN
 *
 *   fund_runs      sixteen columns the console wrote did not exist, so no run
 *                  could be created, started, completed, edited or have its
 *                  returns calculated — and the four seeded runs rendered
 *                  R0 / 0% / 0 investors, because the console read
 *                  capital_deployed while the seed wrote principal_amount.
 *   audit_events   nine wrong columns, into a catch that calls itself
 *                  "non-blocking". The compliance trail has never recorded one
 *                  event, and an empty audit screen looks like a quiet week.
 *   return_schedules  Mark Paid wrote actual_payout_date (the column is
 *                  paid_at), and every row read investor_name, pool_name and
 *                  scheduled_payout_date — none of which are columns.
 *   fund_notifications  read severity (the column is priority), so every
 *                  notification rendered grey "info" and the critical badge
 *                  could never fire; dismiss wrote a column that did not exist.
 *   fund_pools     fetched on the risk dashboard. No such table, ever.
 *
 * And two that made every number quietly wrong rather than absent:
 *
 *   apiGet fetched ONE 200-row page and the dashboard summed it as the whole
 *   book. intFetchAll paginated but swallowed errors mid-way, returning a
 *   partial list indistinguishable from a complete one.
 *
 * Run: node scripts/check-fund-ops-console.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'fund', 'js', 'fund.js'), 'utf8');
const SEED = fs.readFileSync(path.join(ROOT, 'server', 'db', 'seed.js'), 'utf8');
const SETUP= fs.readFileSync(path.join(ROOT, 'server', 'db', 'setup.js'), 'utf8');

/* Comments here quote the old column names to explain the defects; scanning
   them would find the fix's own description and report the bug as present. */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

console.log('\nthe console and the seed name the same columns');
{
  /* The decisive evidence that the console was on the wrong vocabulary: the
     seed inserts these, so whatever the console reads must be these. */
  const seeded = (/INSERT INTO fund_runs\s*\(([^)]*)\)/.exec(SEED) || [])[1] || '';
  const cols = seeded.split(',').map(c => c.trim()).filter(Boolean);
  ok('the seed still writes the schema vocabulary',
     cols.includes('principal_amount') && cols.includes('annual_rate') &&
     cols.includes('investor_count') && cols.includes('net_return'),
     cols.join(', '));

  for (const [wrong, right] of [
    ['capital_deployed',      'principal_amount'],
    ['benchmark_rate',        'annual_rate'],
    ['total_return_gross',    'gross_return'],
    ['total_return_net',      'net_return'],
    ['management_fee_amount', 'management_fee'],
    ['performance_fee_amount','performance_fee'],
    ['total_investors',       'investor_count'],
  ]) {
    ok(`a fund run's ${right} is read as ${right}, not ${wrong}`,
       !new RegExp(`\\b(?:r|run|updates|before)\\.${wrong}\\b`).test(CODE),
       `the seeded runs render R0 while the console reads ${wrong}`);
  }
  /* capital_deployed IS a real solar_projects column — the rename had to be
     scoped, and over-reaching would have broken three solar totals. */
  ok("solar's own capital_deployed is left alone",
     /p\.capital_deployed/.test(CODE),
     'solar_projects really does have this column');
}

console.log('\nthe audit trail can actually record');
{
  ok('it writes event_type, not action',
     /event_type:\s*action \?/.test(CODE) && !/^\s*action,$/m.test(CODE));
  ok('the summary goes to description', /description:\s*changeSummary/.test(CODE));
  ok('the actor goes to user_email',    /user_email:/.test(CODE));
  ok('and what has no column goes to metadata',
     /metadata:\s*\{[^}]*entity_name[\s\S]{0,200}before_state/.test(CODE),
     'severity, entity name and the before/after states have no columns of their own');
  ok('no fabricated ip_address is sent',
     !/ip_address:\s*'127\.0\.0\.1'/.test(CODE),
     'a browser cannot know its own address, and a made-up one in an audit record is worse than none');

  ok('metadata is read as an object, not JSON.parse-d',
     /typeof m === 'object'/.test(SRC) && !/JSON\.parse\(e\.(before|after)_state\)/.test(CODE),
     'node-pg returns JSONB as an object; JSON.parse on it throws');
  ok('a server-written event still renders',
     /_audMeta\(e\)\.action \|\| String\(e\.event_type/.test(CODE),
     'this table also holds events the platform wrote, which carry no metadata');
}

console.log('\nthe other tables are addressed by their real columns');
{
  ok('Mark Paid writes paid_at', /paid_at:\s*new Date\(\)\.toISOString\(\)/.test(CODE));
  ok('and no longer writes actual_payout_date', !/actual_payout_date/.test(CODE));
  /* The helper keeps s.investor_name as a first choice on purpose — a row that
     does carry a denormalised name should use it. What must be gone is the
     RENDER SITES reading it directly, since for a real return_schedules row it
     is always undefined. */
  ok('a schedule resolves its investor through the helper',
     /const _schedInvestor\s*=/.test(SRC));
  ok('and no render site reads investor_name off the row',
     !/\$\{_esc\(s\.investor_name/.test(CODE) && !/\$\{s\.investor_name/.test(CODE),
     'return_schedules has no investor_name column, so every row showed a dash');
  ok('nor pool_name', !/\$\{_esc\(s\.pool_name/.test(CODE) && !/\$\{s\.pool_name/.test(CODE));
  ok('and use expected_date for the payout date',
     /_schedDate\s*=\s*s => s\.expected_date/.test(SRC),
     'scheduled_payout_date has never existed, so every date sort was on Invalid Date');
  ok('notifications fall back to priority',
     /_notifSeverity\s*=\s*n => n\.severity \|\| n\.priority/.test(SRC),
     'the column is priority; every notification rendered as grey info');
  ok('the risk dashboard fetches investment_pools',
     !/intFetchAll\('fund_pools'\)/.test(CODE) && /intFetchAll\('investment_pools'\)/.test(CODE));
}

console.log('\nthe panels that only READ are on real columns too');
{
  /* check-schema-contract catches writes, because a write announces itself with
     a 500. A READ of a column that does not exist is silent: it is undefined,
     it renders as a dash or totals to zero, and the panel looks like a quiet
     month. These are the ones found by reading each panel against the real
     schema, and they are pinned here because nothing mechanical guards them. */
  ok('the fee ledger totals fee_ledger.amount',
     /_feeAmount\s*=\s*f =>[\s\S]{0,80}f\.amount/.test(SRC) &&
     !/parseFloat\(f\.fee_amount\)/.test(CODE),
     'fee_amount is not a column — the whole ledger totalled R0');
  ok('and buckets by accrued_at',
     /_feeDate\s*=\s*f => f\.accrued_at/.test(SRC) &&
     !/\bfmt\.date\(f\.fee_date\)|key = f\.fee_date|\(b\.fee_date/.test(CODE),
     'fee_date is not a column, so the timeline chart had nothing to bucket by');
  ok('a fee names its run through fund_run_id',
     /_feeRunName/.test(SRC) && !/f\.run_name/.test(CODE),
     'fee_ledger has no run_name; it has fund_run_id');
  ok('the CSV exports the real basis column',
     /parseFloat\(f\.basis\)/.test(CODE) && !/f\.capital_base/.test(CODE));

  /* `p.name || p.pool_name || p.id` is fine — name is tried first. What must
     not survive is a site that reaches for pool_name BEFORE name. */
  ok('a pool is named by investment_pools.name first',
     !/_esc\((?:ctx\.nextPool|p|pool)\.pool_name/.test(CODE),
     'investment_pools has name; pool_name has never been a column on it');
  ok('the obligations table resolves its investor',
     !/\$\{_esc\(p\.investor_name/.test(CODE));
  ok('and shows the schedule\'s net_return, not a total_payout that is not there',
     !/fmt\.rand\(p\.total_payout\)/.test(CODE));
  ok('the Mark Paid audit entry names real fields',
     !/sched\.investor_name/.test(CODE) && !/sched\.total_payout/.test(CODE));
}

console.log('\nthe migration adds only what has no equivalent');
{
  for (const c of ['pool_id', 'pool_name', 'run_type', 'actual_rate',
                   'management_fee_pct', 'performance_fee_pct', 'created_by', 'completed_date'])
    ok(`fund_runs gains ${c}`,
       new RegExp(`ALTER TABLE fund_runs ADD COLUMN ${c}\\b`).test(SETUP));
  ok('but NOT a second column for capital',
     !/ALTER TABLE fund_runs ADD COLUMN capital_deployed/.test(SETUP),
     'principal_amount already means this; two columns for one thing is how the drift started');
  ok('investor_allocations gains the console model it is the only writer of',
     /ALTER TABLE investor_allocations ADD COLUMN expected_payout/.test(SETUP) &&
     /ALTER TABLE investor_allocations ADD COLUMN investor_name/.test(SETUP));
  ok('fund_notifications gains is_dismissed',
     /ALTER TABLE fund_notifications ADD COLUMN is_dismissed/.test(SETUP));
}

console.log('\nthe payout schedule and fees are generated, not hand-entered');
{
  ok('the console asks the server for a plan first',
     /apiFetch\(`fund\/runs\/\$\{runId\}\/plan`\)/.test(CODE),
     'the operator must see the split before it is written');
  ok('and posts nothing but the run id to generate',
     /apiFetch\(`fund\/runs\/\$\{_genRunId\}\/generate`[\s\S]{0,140}body: '\{\}'/.test(CODE),
     'a client that posts amounts can pay the wrong person the wrong figure');
  ok('the confirmation says it does not pay anyone',
     /does not pay anyone/.test(CODE),
     'generation records what is owed; paying is a separate act');
  ok('the split is checked to tie on screen', /_genTies/.test(CODE));
  ok('and that check compares whole cents',
     /Math\.round\(plan\.totals\.net \* 100\) === Math\.round/.test(CODE),
     '0.1 + 0.2 is not 0.3 in binary floating point; a naive compare would cry wolf');

  ok('a schedule can actually be marked paid',
     /SCHED_PAYABLE\.includes\(status\)/.test(CODE) &&
     /SCHED_PAYABLE = \['pending'/.test(CODE),
     "the button was shown only for 'scheduled', which the table does not allow");
  ok('the schedule row reads amount_invested, not capital_amount',
     !/s\.capital_amount/.test(CODE) && /parseFloat\(s\.amount_invested\)/.test(CODE));
  ok('and computes the payout rather than reading a column that is not there',
     /const _schedPayout/.test(SRC) && !/\b[sp]\.total_payout\b/.test(CODE) &&
     /fmt\.rand\(capital \+ net\)/.test(CODE),
     'return_schedules has no total_payout — every obligation figure summed undefined');
  ok('and fund_runs keeps its own total_payout',
     /run\.total_payout|r\.total_payout/.test(CODE) || !/total_payout/.test(CODE),
     'that column is real on fund_runs; the scoping had to spare it');
  ok('the status counters use the statuses the table allows',
     !/x\.status==='scheduled'\)\.length/.test(CODE) && /x\.status === 'overdue'/.test(CODE));
}

console.log('\nno total is computed over part of the book');
{
  ok('the one-page helper is gone entirely',
     !/const apiGet\s*=/.test(CODE),
     'a helper that silently returns a first page is what the next person reaches for');
  ok('the dashboard pages through every table it sums',
     /fetchAllRows\('fund_runs'\)[\s\S]{0,200}fetchAllRows\('investments'\)/.test(CODE));
  ok('and a mid-pagination failure is not swallowed',
     !/catch\s*\(\s*e\s*\)\s*\{\s*break;\s*\}/.test(CODE),
     'returning three pages of five as though they were the book is worse than an error');
  ok('paging cannot spin forever', /refusing to page past/.test(SRC));
}

console.log('\nvalues from the database are text, not markup');
{
  ok('the console has an escaper at all', /^const _esc = /m.test(SRC));
  ok('and it matches the admin console\'s', /&#39;/.test(SRC) && /&quot;/.test(SRC));
  ok('a markup-returning helper is not escaped as a whole',
     !/_esc\(card\(/.test(CODE),
     'escaping the finished card would show the operator its HTML');
  ok('its tainted argument is escaped instead',
     /card\('fa-chart-pie'[^)]*_esc\(maxSeg\.name\)/.test(CODE));
}

console.log('\nNUMERIC arrives as a string and is treated as one');
{
  ok('the returns chart does not call toFixed on a row field',
     !/\(\s*r\.(gross|net)_return\s*\|\|\s*0\s*\)\.toFixed/.test(CODE),
     '("147329.70"||0).toFixed(0) is a TypeError — a non-empty string is truthy');
  ok('it parses first', /Math\.round\(parseFloat\(r\.gross_return\)/.test(CODE));

  /* Run the shipped expression both ways to show the difference is real. */
  const sandbox = { out: null };
  vm.createContext(sandbox);
  let threw = false;
  try { vm.runInContext('("147329.70"||0).toFixed(0)', sandbox); } catch (_) { threw = true; }
  ok('and the old form genuinely throws on a NUMERIC string', threw,
     'if this ever stops throwing, the assertion above is not testing anything');
  ok('while the new form gives the number', vm.runInContext('Math.round(parseFloat("147329.70")||0)', sandbox) === 147330);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
