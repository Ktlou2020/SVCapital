'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Own a beef animal

   Different from every other product on the platform. Everywhere else a
   client buys a share of a pool and the pool has a target return. Here they
   buy ONE animal, it carries a tag number, and what they get back is what
   that animal actually fetched. There is no target, because nobody is
   promising one: a heavy animal in a strong market pays more than a light one
   in a weak market, and the client owns the difference in both directions.

   Everything is paid before the animal walks into the feedlot — the purchase
   price and the whole feeding bill for the standing period — so there is no
   call for more money later and no way for a client to end up owing for feed
   on an animal they cannot sell.

   Three documents-worth of promises, and the code has to keep all three:

     the invoice       what they paid, itemised, before anything happened.
     the certificate   which animal is theirs, by tag.
     the payout        proceeds within seven working days of the sale.

   ═══════════════════════════════════════════════════════════════════ */

const { PLATFORM_FEE_PCT } = require('./poolFees');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* ─── What a head costs ───────────────────────────────────────────────
   Purchase price and the feed for the standing period are fixed per intake:
   every animal in a batch costs the same, whatever it weighs. The platform
   fee is 1% ON TOP, as everywhere else on the platform — the client's wallet
   pays the fee in addition to the price, and the full price reaches the
   animal.

   Insurance is not a line. Mortality cover is bought by SV Capital out of the
   purchase price, which is why a client who loses an animal is made whole
   without ever having been billed for a premium. It is stated on the invoice
   as included so that nobody reads its absence as its absence. */
function priceFor(intake) {
  const purchase = round2(intake && intake.purchase_price);
  const feed     = round2(intake && intake.feed_cost);
  const subtotal = round2(purchase + feed);
  const fee      = round2(subtotal * PLATFORM_FEE_PCT);
  return { purchase, feed, subtotal, fee, total: round2(subtotal + fee) };
}

/* ─── Seven working days ──────────────────────────────────────────────
   "Within seven working days of the sale" is a promise about a date, so it is
   computed rather than approximated. Weekends are not working days and
   neither are South African public holidays — an animal sold on the 14th of
   December does not pay out on the 23rd, and a client told the 23rd rings on
   the 23rd.

   Counting starts the day AFTER the sale: the day of sale is not one of the
   seven. */
function easterSunday(year) {
  /* Anonymous Gregorian algorithm. Good Friday and Family Day move with it,
     and they sit in the middle of the South African autumn — a payout run
     that ignores them is wrong every April. */
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const iso = d => d.toISOString().slice(0, 10);

/* A DATE column comes back from node-postgres as a Date, not a string, so
   String(row.placed_at) is "Mon Sep 21 2026 …" and slicing ten characters off
   it produces "Mon Sep 21" — which Date.parse rejects. Every date that
   crosses from a row into arithmetic goes through here. */
function isoDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : iso(v);
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function publicHolidays(year) {
  const fixed = [
    [1, 1], [3, 21], [4, 27], [5, 1], [6, 16], [8, 9], [9, 24], [12, 16], [12, 25], [12, 26],
  ].map(([m, d]) => new Date(Date.UTC(year, m - 1, d)));

  const easter = easterSunday(year);
  const goodFriday = new Date(easter); goodFriday.setUTCDate(easter.getUTCDate() - 2);
  const familyDay  = new Date(easter); familyDay.setUTCDate(easter.getUTCDate() + 1);

  const all = [...fixed, goodFriday, familyDay];
  /* The Public Holidays Act: a holiday falling on a Sunday makes the Monday
     one too. Without this, 26 December on a Sunday pays out a day early into
     a bank that is shut. */
  for (const h of [...all]) {
    if (h.getUTCDay() === 0) {
      const mon = new Date(h); mon.setUTCDate(h.getUTCDate() + 1);
      all.push(mon);
    }
  }
  return new Set(all.map(iso));
}

const _holidayCache = new Map();
function isWorkingDay(date) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const y = date.getUTCFullYear();
  if (!_holidayCache.has(y)) _holidayCache.set(y, publicHolidays(y));
  return !_holidayCache.get(y).has(iso(date));
}

function addWorkingDays(from, days) {
  const start = isoDate(from);
  if (!start) return null;
  const d = new Date(`${start}T00:00:00Z`);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isWorkingDay(d)) left--;
  }
  return d;
}

const PAYOUT_WORKING_DAYS = 7;
const payoutDueFor = soldOn => addWorkingDays(soldOn, PAYOUT_WORKING_DAYS);

/* ─── What the sale returns ───────────────────────────────────────────
   Proceeds are the sale value less the deductions taken at the point of sale
   — abattoir, transport, marketing commission — and nothing else. The
   purchase price and the feed were paid up front and are NOT taken off again;
   deducting them here would charge the client twice for the same animal.

   It can be negative on paper if an animal sells for less than the cost of
   getting it to market. It is floored at zero because a client cannot be
   asked for more money after the fact: that is the whole point of paying
   everything in advance, and SV Capital carries the remainder. */
function proceedsFor({ sale_value, sale_deduction }) {
  const gross = round2(sale_value);
  const less  = round2(sale_deduction);
  return { gross, deduction: less, proceeds: Math.max(0, round2(gross - less)) };
}

/* ═══════════════════════════════════════════════════════════════════
   The two documents

   Both are stored as rendered HTML on the row, not regenerated on demand.
   A certificate that is rebuilt from today's data is not a certificate: it
   would silently follow a corrected price or a re-tagged animal, and the
   client's copy and ours would stop agreeing. What was issued is what is
   kept.

   Self-contained for the same reason. No stylesheet from the platform, no
   image fetched at read time — a document printed in a year, or opened from
   an email attachment, has to look like the one that was issued.
   ═══════════════════════════════════════════════════════════════════ */

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const rand = n => 'R ' + (Number(n) || 0).toLocaleString('en-ZA',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const longDate = d => {
  const s = isoDate(d);
  if (!s) return '—';
  return new Date(`${s}T00:00:00Z`)
    .toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
};

const PROVIDER = 'SmartVest Financial Services (Pty) Ltd t/a SV Capital';
const FSP      = '52449';

const DOC_CSS = `
  *{box-sizing:border-box}
  body{margin:0;padding:40px;background:#fff;color:#1a1a1a;
       font-family:Georgia,'Times New Roman',serif;font-size:13px;line-height:1.6}
  h1{font-size:20px;margin:0 0 2px;letter-spacing:-.2px}
  .sub{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#6b7280;margin-bottom:26px}
  table{width:100%;border-collapse:collapse;margin:0 0 22px}
  th,td{text-align:left;vertical-align:top;padding:7px 10px;border-bottom:1px solid #e5e7eb}
  th{width:38%;font-weight:600;color:#374151}
  td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
  tr.total th,tr.total td{border-top:2px solid #1a1a1a;border-bottom:0;font-weight:700;font-size:14px}
  .band{background:#fdf6e3;border-left:4px solid #b8860b;padding:14px 16px;margin:0 0 22px}
  .foot{margin-top:28px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280}
  .tag{display:inline-block;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:22px;
       letter-spacing:.08em;background:#1a1a1a;color:#fff;padding:8px 18px;border-radius:6px}
  .clause{margin:0 0 10px}
  .clause b{display:block;margin-bottom:2px}
  @media print{body{padding:0}}`;

const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title><style>${DOC_CSS}</style></head><body>${body}</body></html>`;

const rows = pairs => pairs
  .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');

/* ─── Invoice ─────────────────────────────────────────────────────────
   Itemised, because the client is paying three different things for three
   different reasons and a single total tells them none of it. Insurance
   appears as a line at no charge rather than not appearing: it is the reason
   a dead animal is still paid for, and a client who cannot see it does not
   know they have it. */
function renderInvoice(o) {
  const p = o.price;
  const body = `
    <h1>Tax Invoice</h1>
    <div class="sub">${esc(o.invoice_no)}</div>

    <table>${rows([
      ['From',        PROVIDER],
      ['FSP number',  FSP],
      ['Billed to',   o.investor_name || '—'],
      ['Client ID',   o.investor_id],
      ['Email',       o.investor_email || '—'],
      ['Invoice date', longDate(o.issued_at)],
    ])}</table>

    <table>
      <tr><th>Item</th><th class="r">Amount</th></tr>
      <tr><td>One beef animal, tag ${esc(o.tag_number)} — ${esc(o.intake_name)}</td>
          <td class="r">${rand(p.purchase)}</td></tr>
      <tr><td>Feed and care, ${esc(o.feed_days)} days, paid in advance</td>
          <td class="r">${rand(p.feed)}</td></tr>
      <tr><td>Mortality cover for the standing period</td>
          <td class="r">Included</td></tr>
      <tr><td>Platform fee (1%)</td>
          <td class="r">${rand(p.fee)}</td></tr>
      <tr class="total"><td>Total paid from wallet</td>
          <td class="r">${rand(p.total)}</td></tr>
    </table>

    <div class="band">
      Paid in full on ${esc(longDate(o.issued_at))}. Nothing further is payable on
      this animal: the feed for the whole standing period is settled by this invoice,
      and no call for additional feed, transport or handling will be made.
    </div>

    <div class="foot">
      ${esc(PROVIDER)} · authorised financial services provider, FSP ${esc(FSP)}<br>
      This invoice is issued electronically and is valid without signature.
    </div>`;
  return page(`Invoice ${o.invoice_no}`, body);
}

/* ─── Certificate of ownership ────────────────────────────────────────
   The tag number is the document. Everything else on it is context for the
   one fact it exists to record: this animal belongs to this person.

   The risk paragraph is not boilerplate here. On every other product the
   client is told their capital is at risk against a target; here there is no
   target at all, and the honest statement of that is the difference between
   ownership and an investment that happens to mention a cow. */
function renderCertificate(o) {
  const p = o.price;
  const body = `
    <h1>Certificate of Ownership</h1>
    <div class="sub">${esc(o.certificate_no)}</div>

    <p style="margin:0 0 18px">This certifies that <b>${esc(o.investor_name || o.investor_id)}</b>
    is the sole owner of the beef animal identified below.</p>

    <p style="margin:0 0 22px"><span class="tag">${esc(o.tag_number)}</span></p>

    <table>${rows([
      ['Owner',              o.investor_name || '—'],
      ['Client ID',          o.investor_id],
      ['Tag number',         o.tag_number],
      ['Intake',             o.intake_name],
      ['Feedlot',            o.feedlot || '—'],
      ['Placed on feed',     longDate(o.placed_at)],
      ['Expected sale',      longDate(o.expected_sale_date)],
      ['Standing period',    `${o.feed_days} days, approximate`],
      ['Purchase price paid', rand(p.purchase)],
      ['Feed paid in advance', rand(p.feed)],
      ['Certificate issued', longDate(o.issued_at)],
    ])}</table>

    <div class="clause"><b>1. What is owned</b>The owner holds title to the single
    animal bearing the tag number above, and to no other animal. The animal is held
    at the feedlot named above and is managed, fed and marketed on the owner's behalf
    by ${esc(PROVIDER)}.</div>

    <div class="clause"><b>2. What is returned</b>On sale, the owner receives the
    price the animal actually fetched, less the costs of getting it to market
    (transport, abattoir and marketing commission). There is no target return and
    none is implied. A heavier animal in a stronger market returns more; a lighter
    animal in a weaker market returns less, and may return less than was paid.</div>

    <div class="clause"><b>3. Nothing further is owed</b>The purchase price and the
    feed for the standing period were paid in full before the animal was placed.
    Should costs exceed the sale value, the shortfall is carried by
    ${esc(PROVIDER)} and is not recoverable from the owner.</div>

    <div class="clause"><b>4. If the animal dies</b>The animal is insured for the
    standing period at ${esc(PROVIDER)}'s cost. If it dies or is condemned, the owner
    is refunded in full what they paid, and the claim is ours to pursue, not theirs.</div>

    <div class="clause"><b>5. Payment of proceeds</b>Proceeds are paid into the
    owner's SV Capital wallet within seven working days of the sale.</div>

    <div class="clause"><b>6. The standing period is an estimate</b>${esc(o.feed_days)} days
    is the expected time on feed. Animals are marketed when they are ready, which may be
    sooner or later. No additional feed is charged either way.</div>

    <div class="band">
      This is a certificate of ownership of livestock. It is not a deposit, it is not
      guaranteed, and it is not covered by any deposit insurance or compensation scheme.
    </div>

    <div class="foot">
      ${esc(PROVIDER)} · authorised financial services provider, FSP ${esc(FSP)}<br>
      Issued electronically in terms of the Electronic Communications and Transactions
      Act 25 of 2002.
    </div>`;
  return page(`Certificate ${o.certificate_no}`, body);
}

module.exports = {
  priceFor, proceedsFor, addWorkingDays, isWorkingDay, payoutDueFor,
  publicHolidays, easterSunday, PAYOUT_WORKING_DAYS, round2,
  renderInvoice, renderCertificate, esc, rand, longDate, isoDate, PROVIDER, FSP,
};
