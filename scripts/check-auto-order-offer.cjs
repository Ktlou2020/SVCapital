#!/usr/bin/env node
/* The offer made once a card top-up has landed.
 *
 * Both halves of this existed already and almost nobody used them: a saved
 * card can be charged monthly (auto_topup_*, charged at 03:00 UTC), and a
 * wallet can be invested monthly into a chosen product (recurring_*, placed
 * an hour later at 04:00). Two crons, two portal screens, and production
 * reporting "0 investor(s) scheduled for today" — because both live two
 * levels down inside the wallet tab and nobody finds them.
 *
 * So the offer is made at the one moment a client has just proved they want
 * to fund the account and has a card on file to do it with. What this checks
 * is that it is made at the right moment, to the right people, and that the
 * figures it opens on are ones the platform will actually accept — a prompt
 * that suggests an amount the pool refuses is worse than no prompt.
 *
 * Run: node scripts/check-auto-order-offer.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const core = read('js/portal-core.js');

/* ── The shipped portal, in a box ──────────────────────────────────────── */

function boot({ card, settings, pools, products, investor, onFetch, dayOfMonth }) {
  const calls = [];
  const els   = Object.create(null);
  /* Modal is a lexical const inside js/api.js, so a Modal stub on the sandbox
     global does NOT shadow it — portal-core calls the real one. Opening is
     therefore observed where the real Modal leaves its mark: the class it
     adds to the overlay. Stubbing what cannot be stubbed is how a check comes
     back green on a feature that never ran. */
  const mk = id => (els[id] = els[id] || {
    id, innerHTML: '', textContent: '', value: '', style: {}, disabled: false,
    classes: new Set(),
    classList: {
      add(c) { els[id].classes.add(c); },
      remove(c) { els[id].classes.delete(c); },
      contains: c => els[id].classes.has(c),
    },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    appendChild() {}, append() {}, remove() {}, insertBefore() {}, focus() {}, click() {},
    querySelector: () => null, querySelectorAll: () => [],
  });

  /* Toast is a lexical const in js/api.js too, so the real one runs and
     builds real elements. A shared stub element would have every toast write
     over the last; a throw here would abort the caller mid-flow and, on the
     save paths, leave the modal open — which is exactly what a check would
     then report as a bug in the feature. */
  let made = 0;
  const fresh = () => mk('made-' + (++made));

  /* A clock that can be moved to a day the clamp actually has to act on.
     Asserting the default day is 1–28 while the real calendar says the 22nd
     passes whether or not anything clamps. */
  const Clock = dayOfMonth
    ? new Proxy(Date, { construct: (T, args) => {
        const d = args.length ? new T(...args) : new T();
        return new Proxy(d, { get: (t, k) => (k === 'getDate' ? () => dayOfMonth
                                                              : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
      } })
    : Date;

  const s = {
    console, Date: Clock, String, Number, Math, JSON, Object, Array, Map, Set, RegExp,
    parseFloat, parseInt, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    Promise, Error,
    setTimeout: f => { if (typeof f === 'function') f(); return 0; },
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage:   { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, location: { href: '', origin: 'http://x' },
    AbortController: function () { this.signal = null; this.abort = () => {}; },
    URLSearchParams: URLSearchParams,
    atob: str => Buffer.from(str, 'base64').toString('binary'),
    /* Stubbed at the network boundary, not at API.

       API — like Modal, Toast and Confirm — is a lexical const inside
       js/api.js. Assigning window.API does not shadow it, so portal-core
       calls the real one and the real one calls fetch. An API stub makes
       every negative case pass for the wrong reason: the offer is not made
       because the request failed, not because the guard held. */
    fetch: async (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      const pathOnly = String(url).replace(/^.*\/api\//, '').split('?')[0];
      calls.push([method, pathOnly, opts && opts.body ? JSON.parse(opts.body) : undefined]);
      let payload;
      if (onFetch) payload = onFetch(method, pathOnly, opts && opts.body ? JSON.parse(opts.body) : undefined);
      if (payload === undefined) {
        if (pathOnly === 'payments/topup-card') payload = { card };
        else if (pathOnly === 'payments/auto-topup') payload = settings;
        else payload = { success: true };
      }
      return {
        ok: true, status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
        headers: { get: () => 'application/json' },
      };
    },
    document: {
      addEventListener() {},
      body: { style: {}, classList: { add() {}, remove() {} }, appendChild() {} },
      activeElement: null,
      createElement: () => fresh(),
      querySelector: () => null, querySelectorAll: () => [],
      getElementById: id => mk(id),
    },
    Modal: { open(id) { calls.push(['modal.open', id]); }, close(id) { calls.push(['modal.close', id]); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Toast: { success() {}, error() {}, warn() {} },
    SVC: { track(n, d) { calls.push(['track', n, d]); } },
    _withBtn: (b, f) => f && f(),
    loadPortalData: async () => {},
  };
  s.window = s; s.globalThis = s; s.self = s;
  vm.createContext(s);
  vm.runInContext(read('js/api.js'), s, { filename: 'js/api.js' });
  vm.runInContext(
    'var PORTAL = { investments: [], pools: [], transactions: [], investor: null };' +
    'var _mktProducts = [];' +
    "var _esc = (x) => String(x ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')" +
    ".replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');", s);
  vm.runInContext(core, s, { filename: 'js/portal-core.js' });
  vm.runInContext('PORTAL.pools = ' + JSON.stringify(pools || []) +
                  '; _mktProducts = ' + JSON.stringify(products || []) +
                  '; PORTAL.investor = ' + JSON.stringify(
                    investor === undefined ? { id: 'INV-1', wallet_balance: 0 } : investor) + ';', s);
  const opened = () => !!(els.autoOrderModal && els.autoOrderModal.classes.has('open'));
  /* The fields only exist once something has asked for them by id, which is
     how the real DOM behaves too. `el` is the accessor the assertions use so
     a missing field fails as a named assertion rather than a TypeError. */
  const el = id => mk(id);
  return { s, calls, els, opened, el };
}

const FAR = '2099-12-31';
/* Two cattle pools on purpose: the minimum shown must be the cheaper one.
   The product record and the pool carry separate minimums and drift, and it
   is the POOL that refuses the money. */
const POOLS = [
  { id: 'P1', product_type: 'cattle',     status: 'open',   end_date: FAR, min_investment: 5000 },
  { id: 'P2', product_type: 'cattle',     status: 'open',   end_date: FAR, min_investment: 1000 },
  { id: 'P3', product_type: 'solar',      status: 'open',   end_date: FAR, min_investment: 10000 },
  { id: 'P4', product_type: 'short_term', status: 'closed', end_date: FAR, min_investment: 500 },
  { id: 'P5', product_type: 'eif_ijara',  status: 'open',   end_date: FAR, min_investment: 250 },
  { id: 'P6', product_type: 'gridfarmer', status: 'open',   end_date: '2020-01-01', min_investment: 100 },
  /* Declared LAST and cheapest, so insertion order and price order disagree.
     Without that, "cheapest first" passes on a list that was never sorted. */
  { id: 'P7', product_type: 'smme',       status: 'open',   end_date: FAR, min_investment: 200 },
];
const PRODUCTS = [
  { product_type: 'eif_ijara', category: 'eif', category_exclusive: true },
  { product_type: 'cattle',    category: 'standard' },
];
const CARD = { card_type: 'visa', last4: '4081' };
const OFF  = { auto_topup_enabled: false, auto_topup_amount: null, auto_topup_day: 1,
               auto_topup_prompt_dismissed_at: null };
const ago  = days => new Date(Date.now() - days * 86400000).toISOString();

(async () => {

console.log('\nthe offer is made after a card top-up, and only then');
{
  const CASES = [
    ['a card top-up with a saved card',    { card: CARD, settings: OFF },                                      { amount: 1000 }, true],
    ['nothing saved, so nothing to debit', { card: null, settings: OFF },                                      { amount: 1000, cardSaved: false }, false],
    ['a sub-account top-up',               { card: CARD, settings: OFF },                                      { amount: 1000, subAccount: true }, false],
    ['auto top-up already on',             { card: CARD, settings: { ...OFF, auto_topup_enabled: true } },      { amount: 1000 }, false],
    ['declined a week ago',                { card: CARD, settings: { ...OFF, auto_topup_prompt_dismissed_at: ago(7) } },   { amount: 1000 }, false],
    ['declined two years ago',             { card: CARD, settings: { ...OFF, auto_topup_prompt_dismissed_at: ago(730) } }, { amount: 1000 }, true],
    ['no investor resolved',               { card: CARD, settings: OFF, investor: null },                      { amount: 1000 }, false],
    ['the settings call fails',            { card: CARD, settings: OFF, onFetch: (m, u) => { if (u === 'payments/auto-topup') throw new Error('down'); } }, { amount: 1000 }, false],
  ];
  for (const [label, setup, pending, expected] of CASES) {
    const b = boot({ pools: POOLS, products: PRODUCTS, ...setup });
    b.s._atoRemember({ subAccount: false, cardSaved: true, ...pending });
    await b.s._maybeOfferAutoTopUp();
    ok(`${label} → ${expected ? 'offered' : 'not offered'}`, b.opened() === expected,
       `opened=${b.opened()}`);
  }

  const b = boot({ pools: POOLS, products: PRODUCTS, card: CARD, settings: OFF });
  await b.s._maybeOfferAutoTopUp();
  ok('and never without a top-up to offer it after', !b.opened());

  const twice = boot({ pools: POOLS, products: PRODUCTS, card: CARD, settings: OFF });
  twice.s._atoRemember({ amount: 1000, subAccount: false, cardSaved: true });
  await twice.s._maybeOfferAutoTopUp();
  const firstReads = twice.calls.filter(c => c[1] === 'payments/auto-topup' && c[0] === 'GET').length;
  await twice.s._maybeOfferAutoTopUp();
  ok('one top-up produces one offer, not one per page view',
     twice.calls.filter(c => c[1] === 'payments/auto-topup' && c[0] === 'GET').length === firstReads,
     'the remembered offer is consumed, so a second call does nothing');
}

console.log('\nthe day offered exists in every month');
{
  const b = boot({ pools: POOLS, products: PRODUCTS, card: CARD, settings: OFF });
  const d = b.s._atoDefaultDay();
  ok('the default day is 1–28', d >= 1 && d <= 28, String(d));
  for (const [day, want] of [[31, 28], [30, 28], [29, 28], [28, 28], [15, 15], [1, 1]]) {
    const c = boot({ pools: POOLS, products: PRODUCTS, card: CARD, settings: OFF, dayOfMonth: day });
    ok(`a top-up on the ${day}${c.s._atoOrdinal(day)} defaults to the ${want}${c.s._atoOrdinal(want)}`,
       c.s._atoDefaultDay() === want, String(c.s._atoDefaultDay()));
  }
  const opts = b.s._atoDayOptions(5);
  const days = [...opts.matchAll(/value="(\d+)"/g)].map(m => +m[1]);
  ok('and so is every option', days.length === 28 && Math.max(...days) === 28, String(Math.max(...days)));
  ok('the chosen day is preselected', /value="5" selected/.test(opts));
  ok('ordinals read correctly',
     [1,2,3,4,11,12,13,21,22,23].map(n => n + b.s._atoOrdinal(n)).join(' ') ===
     '1st 2nd 3rd 4th 11th 12th 13th 21st 22nd 23rd',
     [1,2,3,4,11,12,13,21,22,23].map(n => n + b.s._atoOrdinal(n)).join(' '));
}

console.log('\nthe products offered are ones the money can actually go into');
{
  const b = boot({ pools: POOLS, products: PRODUCTS, card: CARD, settings: OFF });
  const opts = b.s._atoProductOptions();
  const types = opts.map(o => o.productType);

  ok('a closed pool is not offered', !types.includes('short_term'), types.join(','));
  ok('a pool past its close date is not offered', !types.includes('gridfarmer'), types.join(','));
  ok('a category-exclusive product is not offered in a general picker',
     !types.includes('eif_ijara'),
     'it is reached deliberately from its own tab, not set up by accident for ever');
  ok('the ordinary products are', types.includes('cattle') && types.includes('solar'), types.join(','));

  const cattle = opts.find(o => o.productType === 'cattle');
  ok('the minimum is the CHEAPEST open pool, not whichever came first',
     cattle && cattle.min === 1000, JSON.stringify(cattle));

  ok('cheapest first, so the default selection is the affordable one',
     types[0] === 'smme' && types[types.length - 1] === 'solar', types.join(','));
  ok('and that is not merely the order the pools arrived in',
     POOLS.findIndex(p => p.product_type === 'smme') > POOLS.findIndex(p => p.product_type === 'cattle'),
     'the fixture must disagree with the sort, or the sort is untested');

  const none = boot({ pools: [], products: [], card: CARD, settings: OFF });
  ok('no open pool yields no options rather than a broken picker',
     none.s._atoProductOptions().length === 0);
}

console.log('\nthe amounts suggested are ones the platform accepts');
{
  const b = boot({ pools: POOLS, products: PRODUCTS, card: CARD, settings: OFF });
  const { svcMaxInvestable, svcWalletSpend, svcPlatformFee } = b.s;

  /* The 1% is charged ON TOP, so a R1 000 top-up does not buy R1 000 of
     product. Suggesting the top-up figure itself sets up an order that is
     short by the fee every single month. */
  const covered = svcMaxInvestable(1000);
  ok('a R1 000 top-up covers R990.10 of investment', covered === 990.10, String(covered));
  ok('and that really does cost exactly R1 000', svcWalletSpend(covered) === 1000,
     String(svcWalletSpend(covered)));
  ok('the fee on it is R9.90', svcPlatformFee(covered) === 9.90, String(svcPlatformFee(covered)));

  /* The pool minimum is a rule about the POOL, so it is tested against what
     reaches the pool, never against what leaves the wallet. */
  ok('R1 000 into a R1 000 pool is allowed, though R1 010 leaves the wallet',
     svcWalletSpend(1000) === 1010);
}

console.log('\nsetting it up writes what the crons read');
{
  const b = boot({ pools: POOLS, products: PRODUCTS, card: CARD, settings: OFF });
  b.s._atoRemember({ amount: 1000, subAccount: false, cardSaved: true });
  await b.s._maybeOfferAutoTopUp();

  ok('the offer opened so there is a form to fill', b.opened());
  b.el('atoAmount').value = '1000';
  b.el('atoDay').value    = '9';
  await b.s._atoSaveTopUp();

  const topup = b.calls.find(c => c[1] === 'payments/auto-topup' && c[0] === 'POST');
  ok('the top-up is saved through the endpoint that already existed', !!topup, JSON.stringify(b.calls.map(c => c[1])));
  ok('enabled, with the amount and the day', topup &&
     topup[2].enabled === true && topup[2].amount === 1000 && topup[2].day === 9, JSON.stringify(topup && topup[2]));

  b.el('atoProduct').value      = 'cattle';
  b.el('atoInvestAmount').value = '1000';
  await b.s._atoSaveInvest();

  const inv = b.calls.find(c => c[0] === 'PATCH' && /tables\/investors\//.test(c[1]));
  ok('the recurring investment is saved too', !!inv, JSON.stringify(b.calls.map(c => c[1])));
  ok('with the product the client picked',
     inv && inv[2].recurring_enabled === true && inv[2].recurring_product_type === 'cattle' &&
     inv[2].recurring_amount === 1000, JSON.stringify(inv && inv[2]));
  ok('on the SAME day as the top-up, which lands an hour earlier',
     inv && inv[2].recurring_day === 9, JSON.stringify(inv && inv[2]));
  ok('and the offer closes once both are set', !b.opened());
}

console.log('\n"not now" is remembered on the server, not in the browser');
{
  const b = boot({ pools: POOLS, products: PRODUCTS, card: CARD, settings: OFF });
  b.s._atoRemember({ amount: 1000, subAccount: false, cardSaved: true });
  await b.s._maybeOfferAutoTopUp();
  b.s._atoDismiss();
  ok('declining posts to the server',
     b.calls.some(c => c[0] === 'POST' && c[1] === 'payments/auto-topup/dismiss'),
     'a browser-side flag would ask again on the next device, and after a cache clear');
  ok('and closes the offer', !b.opened());

  const payments = read('server/routes/payments.js');
  ok('the endpoint exists', /router\.post\('\/auto-topup\/dismiss'/.test(payments));
  ok('and the SERVER stamps the time',
     /auto_topup_prompt_dismissed_at = NOW\(\)/.test(payments),
     'a client-supplied timestamp could be set into the future and silence the offer for ever');
  /* In the GET route's own SELECT. A default object further down that names
     the column is not the same as reading it — the portal would then decide
     whether to offer from a value the query never returned. */
  const getRoute = (payments.split("router.get('/auto-topup'")[1] || '').split('router.')[0];
  const select   = (getRoute.match(/SELECT[\s\S]*?FROM investors/) || [''])[0];
  ok('the settings endpoint SELECTS it, or the portal cannot honour it',
     /auto_topup_prompt_dismissed_at/.test(select), select.replace(/\s+/g, ' ').slice(0, 160));

  const setup = read('server/db/setup.js');
  ok('the column is added by setup',
     /ADD COLUMN auto_topup_prompt_dismissed_at TIMESTAMPTZ/.test(setup));
}

console.log('\nit is wired to a real card top-up, and not to a purchase in progress');
{
  ok('the verified Paystack path remembers the offer',
     /_atoRemember\(\{[\s\S]{0,160}subAccount:\s*!!_pmSaId/.test(core),
     'remembered rather than opened, so two modals are never stacked');
  ok('the offer is made when the payment modal closes',
     /_maybeOfferAutoTopUp\(\)\.catch/.test(core));
  ok('but dropped when the client is being returned to an invest modal',
     /if \(resumePool\) _atoBag\(\)\.pending = null;/.test(core),
     'someone mid-purchase is interrupted, not helped');
}

console.log('\nthe recurring day is clamped, like the top-up day already was');
{
  const cron = read('server/jobs/recurringCron.js');
  const investBlock = cron.slice(0, cron.indexOf('runAutoTopUps'));
  ok('the investment query clamps the chosen day to the month length',
     /LEAST\(COALESCE\(i\.recurring_day, 1\)/.test(investBlock),
     'day 31 was silently skipped in February, April, June, September and November');
  ok('and the top-up query still does', /LEAST\(i\.auto_topup_day/.test(cron));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})().catch(e => { console.error('\n  ✗ threw:', e && e.stack || e); process.exit(1); });
