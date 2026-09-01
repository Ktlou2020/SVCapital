#!/usr/bin/env node
/* A pool past its close date must not be offered to anyone.
 *
 * The marketplace decided this on status alone, with a comment saying to trust
 * the database because the cron manages transitions. That was true while the
 * cycler deployed a pool the morning after it closed. It is not true now: the
 * cycler deploys a pool on its INVESTMENT START DATE, which an admin can set
 * days or weeks after the close date, and for all of those days the pool still
 * reads 'open'. It kept appearing in the marketplace, in the calculator, in
 * the recurring-investment product list, and as the cheapest pool a
 * sub-account was measured against — after it had stopped raising.
 *
 * Two halves, because there are two places this can go wrong:
 *   · the browser, which decides what to show
 *   · the server, which decides what is allowed — a stale tab, a bookmarked
 *     modal, or a pool list loaded before midnight all reach it with a pool
 *     the marketplace would no longer offer
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node scripts/check-marketplace-close-date.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const CORE   = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
const WEB    = fs.readFileSync(path.join(ROOT, 'portal', 'js', 'portal.js'), 'utf8');
const MOB    = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'js', 'portal.js'), 'utf8');
const TABLES = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'tables.js'), 'utf8');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function sliceFn(src, name) {
  const at = src.search(new RegExp(`(async\\s+)?function ${name}\\(`));
  if (at < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('(', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  i = src.indexOf('{', i); depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at, i + 1);
}

const dayOffset = n => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

/* Each pool is named for what it is. The one that matters most is CLOSED_OPEN:
   closed a week ago, still 'open' because its investment start date has not
   arrived — precisely the state the cycler now leaves a pool in. */
const POOLS = [
  { id: 'RAISING',     product_type: 'cattle',     status: 'open',     end_date: dayOffset(20),  min_investment: 5000 },
  { id: 'CLOSING_NOW', product_type: 'cattle',     status: 'open',     end_date: dayOffset(0),   min_investment: 1000 },
  { id: 'CLOSED_OPEN', product_type: 'cattle',     status: 'open',     end_date: dayOffset(-7),  min_investment: 100  },
  { id: 'CLOSED_YDAY', product_type: 'short_term', status: 'open',     end_date: dayOffset(-1),  min_investment: 250  },
  { id: 'WAITLIST_OK', product_type: 'short_term', status: 'waitlist', end_date: dayOffset(10),  min_investment: 2000 },
  { id: 'WAITLIST_LATE', product_type: 'short_term', status: 'waitlist', end_date: dayOffset(-3), min_investment: 50 },
  { id: 'ACTIVE',      product_type: 'cattle',     status: 'active',   end_date: dayOffset(30),  min_investment: 1000 },
  /* No close date at all. Left alone deliberately: it has not demonstrably
     closed, and taking a live pool off the marketplace on a guess is worse
     than leaving an undated one on it. */
  { id: 'NO_END',      product_type: 'cattle',     status: 'open',     end_date: null,           min_investment: 7500 },
];

console.log('\nthe browser: what the marketplace offers');

if (!CHROME) {
  console.log('  SKIP  no headless Chromium — the filters were not run');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mktclose-'));
  fs.writeFileSync(path.join(tmp, 'stub.js'), `
${sliceFn(CORE, '_poolEndMs')}
${sliceFn(CORE, '_poolPastClose')}
${sliceFn(CORE, '_getOpenMarketplacePools')}
/* The per-product lists, taken from each platform's own file and renamed so
   the two can be exercised side by side. They differ — mobile also admits
   'filling' — and both have to exclude a closed pool. */
${sliceFn(WEB, '_openPoolsForProduct').replace('_openPoolsForProduct', '_webPoolsForProduct')}
${sliceFn(MOB, '_openPoolsForProduct').replace('_openPoolsForProduct', '_mobPoolsForProduct')}
`);

  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="probe"></div>
<script>const ERRORS=[];window.onerror=m=>ERRORS.push(String(m));<\/script>
<script>const PORTAL = { pools: ${JSON.stringify(POOLS).replace(/</g, '\\u003c')}, investor: { wallet_balance: 100000 } };<\/script>
<script src="./stub.js"><\/script>
<script>
const out = { errors: ERRORS };
const ids = list => list.map(p => p.id).sort();
try {
  out.marketplace = ids(_getOpenMarketplacePools());
  out.webCattle   = ids(_webPoolsForProduct('cattle'));
  out.mobShort    = ids(_mobPoolsForProduct('short_term'));
  out.pastClose   = PORTAL.pools.filter(p => _poolPastClose(p)).map(p => p.id).sort();
  /* Cheapest open pool: the number a sub-account's balance is measured
     against before it may invest. CLOSED_OPEN has a R100 minimum, so if a
     closed pool still counts, the gate opens on a pool nobody can buy. */
  const open = _getOpenMarketplacePools().filter(p => p.status === 'open');
  const mins = open.map(p => parseFloat(p.min_investment)).filter(v => v > 0);
  out.cheapest = mins.length ? Math.min.apply(null, mins) : 0;
} catch (e) { out.threw = String(e && e.message || e); }
document.getElementById('probe').textContent = JSON.stringify(out);
<\/script></body></html>`;
  fs.writeFileSync(path.join(tmp, 'p.html'), page);

  let dom = '';
  try {
    dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=5000', '--dump-dom', 'file://' + path.join(tmp, 'p.html')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 40000, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) { dom = (err.stdout || '').toString(); }

  const m = dom.match(/id="probe">([\s\S]*?)<\/div>/);
  let r = null;
  try {
    r = JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
  } catch (_) {}

  ok('the filters ran', !!r && !r.threw, r ? r.threw : (m ? m[1] : dom).slice(0, 300));
  if (r && !r.threw) {
    ok('nothing threw', (r.errors || []).length === 0, JSON.stringify(r.errors));

    ok('a pool closed a week ago but still marked open is excluded',
       !r.marketplace.includes('CLOSED_OPEN'),
       `marketplace: ${JSON.stringify(r.marketplace)}`);
    ok('so is one that closed yesterday', !r.marketplace.includes('CLOSED_YDAY'));
    ok('and a waitlist pool past its close date', !r.marketplace.includes('WAITLIST_LATE'));

    ok('a pool still raising is offered', r.marketplace.includes('RAISING'));
    /* The boundary the whole month-end sequence turns on: a pool closing today
       takes money all day and receives tonight's rollovers at 23:00. */
    ok('and one closing TODAY is still offered', r.marketplace.includes('CLOSING_NOW'),
       'the close date is inclusive — this pool takes money until the end of the day');
    ok('a waitlist pool inside its window is still offered', r.marketplace.includes('WAITLIST_OK'));
    ok('a pool with no close date is left alone', r.marketplace.includes('NO_END'),
       'it has not demonstrably closed; guessing takes a live pool off the marketplace');
    ok('an active pool is not offered, as before', !r.marketplace.includes('ACTIVE'));

    console.log('\n  the per-product lists behind each product page');
    ok('web: the closed cattle pool is gone, the raising ones remain',
       !r.webCattle.includes('CLOSED_OPEN') &&
       r.webCattle.includes('RAISING') && r.webCattle.includes('CLOSING_NOW'),
       JSON.stringify(r.webCattle));
    ok('mobile: the closed short_term pools are gone, the waitlist one remains',
       !r.mobShort.includes('CLOSED_YDAY') && !r.mobShort.includes('WAITLIST_LATE') &&
       r.mobShort.includes('WAITLIST_OK'),
       JSON.stringify(r.mobShort));

    console.log('\n  the sub-account invest gate');
    ok('the cheapest open pool is a pool that can actually be bought',
       r.cheapest === 1000,
       `cheapest minimum is R${r.cheapest} — CLOSED_OPEN's R100 must not set the bar`);
  }

  if (!process.env.DUMP) fs.rmSync(tmp, { recursive: true, force: true });
}

/* ── Every place a pool is offered, not just the marketplace ────────── */
console.log('\nevery site that treats a pool as investable applies it');
const SITES = [
  ["the marketplace list",            /function _getOpenMarketplacePools\(\)[\s\S]{0,300}_poolPastClose/],
  ["the affordable/cheapest figures", /const openPools = ranked\.filter\(p => p\.status === 'open' && !_poolPastClose\(p\)\)/],
  ["the sub-account invest gate",     /function openSaInvest\([\s\S]{0,400}_poolPastClose/],
  ["the per-product open counts",     /openCounts\[p\.product_type\][\s\S]{0,10}/],
  ["the calculator's pool dropdown",  /calcPoolSelect[\s\S]{0,400}_poolPastClose/],
  ["recurring investment products",   /openProductTypes[\s\S]{0,200}_poolPastClose/],
  ["recurring minimum validation",    /const openPool = \(PORTAL\.pools \|\| \[\]\)\.find\(p => p\.status === 'open' && !_poolPastClose\(p\)/],
];
for (const [label, re] of SITES) {
  ok(label, re.test(CORE), 'no close-date guard at this site');
}
/* That one entry is deliberately loose above; assert the count site properly. */
ok('the per-product open counts, precisely',
   /if \(p\.status === 'open' && !_poolPastClose\(p\)\) openCounts/.test(CORE),
   'a product still advertising "1 open pool" that cannot be invested in');

ok('the web portal\'s per-product list', /_poolPastClose\(p\)\) return false;/.test(WEB));
ok('the mobile portal\'s per-product list', /_poolPastClose\(p\)\) return false;/.test(MOB));

/* ── The server, which is the one that matters ─────────────────────── */
console.log('\nthe server refuses what the browser would no longer offer');
ok('the pool is read for status and close date on an investment POST',
   /past_close[\s\S]{0,200}FROM investment_pools WHERE id = \$1/.test(TABLES),
   'the browser is not a security boundary');

/* One regex covering condition AND body, deliberately. Asserting the 400
   separately passes while the branch around it is unreachable — which is
   exactly what a mutation of the condition produces, and exactly the failure
   a check like this exists to catch. */
const GATE = /if \(req\.user\.role === 'investor' && !isReinvestment\) \{[\s\S]{0,1200}?past_close\)[\s\S]{0,300}?status\(400\)/;
ok('a closed pool is a 400, inside a branch investors actually reach',
   GATE.test(TABLES),
   'either the 400 is gone or the branch containing it can no longer be entered');
ok('and so is a pool whose status has left the raising states',
   /if \(req\.user\.role === 'investor' && !isReinvestment\) \{[\s\S]{0,1800}?\['open', 'waitlist', 'filling'\]\.includes[\s\S]{0,200}?status\(400\)/.test(TABLES));
ok('reinvestments are exempt — the maturity engine picks its own target',
   /!isReinvestment\) \{[\s\S]{0,1200}past_close/.test(TABLES),
   'blocking these would strand rollovers the engine has already chosen');
ok('staff are exempt — late allocations are a real corrections workflow',
   /req\.user\.role === 'investor' &&[\s\S]{0,1200}past_close/.test(TABLES),
   'an EFT that cleared after the cut-off has to be placeable by someone');

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  DATABASE_URL not set — the SQL predicate was not executed');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* The predicate itself, run by Postgres rather than reasoned about. CURRENT_DATE
   is the server's, and the server is UTC while the business is UTC+2 — so this
   also pins which way the boundary leans. */
/* pg is a server dependency and this file lives in scripts/, so it is resolved
   from there rather than from a node_modules that does not exist here. */
const { Pool } = require(path.join(ROOT, 'server', 'node_modules', 'pg'));
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

(async () => {
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.investment_pools') IS NOT NULL AS ok`);
    if (!ready[0].ok) {
      console.log('\n  SKIP  no investment_pools table in this database');
    } else {
      await db.query(`DELETE FROM investment_pools WHERE id LIKE 'MC-%'`);
      for (const p of POOLS) {
        await db.query(
          `INSERT INTO investment_pools (id,name,product_type,status,annual_rate,term_months,
              start_date,end_date,maturity_date,min_investment)
           VALUES ($1,$2,$3,$4,0.16,12,CURRENT_DATE-30,$5::date,CURRENT_DATE+365,$6)`,
          [`MC-${p.id}`, `close-date fixture ${p.id}`, p.product_type, p.status,
           p.end_date, p.min_investment]);
      }
      const { rows } = await db.query(
        `SELECT id, status,
                (end_date IS NOT NULL AND end_date < CURRENT_DATE) AS past_close
           FROM investment_pools WHERE id LIKE 'MC-%' ORDER BY id`);
      const by = Object.fromEntries(rows.map(r => [r.id.slice(3), r]));

      console.log('\n  the SQL predicate, executed');
      ok('a pool closed a week ago reads as past its close date',
         by.CLOSED_OPEN.past_close === true);
      ok('one closing today does not — it still takes money',
         by.CLOSING_NOW.past_close === false,
         'strict less-than; at 23:00 SAST the server is still on the same UTC date');
      ok('one closing in three weeks does not', by.RAISING.past_close === false);
      ok('a pool with no close date does not', by.NO_END.past_close === false,
         'NULL end_date must not read as closed, or every undated pool becomes unbuyable');
    }
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.query(`DELETE FROM investment_pools WHERE id LIKE 'MC-%'`).catch(() => {});
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
