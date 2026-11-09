'use strict';
/* ═══════════════════════════════════════════════════════════
   An external trading facility, read out of a published Google Sheet.

   The Grain Co maize facility runs on one bank account and two pools. Each
   load of maize is bought and sold, and the MARGIN on it is split between the
   pools by their capital on the day the load was bought — then Pool A's share
   is split again between Grain Co and SV Capital. SV Capital's capital sits in
   the account; it is not the principal of any load.

   WHICH IS WHY A LOAD IS NOT A LOAN. shortterm_loans holds one borrower, one
   principal and one repayment, and a load written as a loan row would report
   a R120 000 exposure per load against capital at risk that is one figure for
   the whole facility. The loads are ACTIVITY inside a facility, reported with
   only our own share of each one.

   ── WHAT IT WILL NOT DO ───────────────────────────────────────────────

   FILTER ON FORMATTING. The sheet is built from a template whose sample rows
   were italic, and the legend still says "Load # in italics = EXAMPLE row".
   The real data was typed over those rows and kept their styling, so every
   live load reads as italic. An importer that believed the legend would have
   discarded the entire facility. Rows are chosen by CONTENT: a load needs a
   number, a purchase date and a cost.

   INVENT OUR SHARE. Margin is split only once the buyer has paid, so a load
   that has not settled has no share yet. That is stored as NULL, never 0 —
   zero reads as "earned nothing on it" and null reads as "not due yet", and
   on a facility that is mostly unsettled the difference is the whole report.

   TRUST THE SHEET'S ARITHMETIC. our_margin is recomputed from the margin, the
   pool percentage and our share, and a row that disagrees with the sheet by
   more than a cent is flagged rather than imported quietly. A spreadsheet is
   a document somebody edits by hand; a fund report built on one that has had
   a formula dragged over should say so rather than add up.

   IT IS A REPORT, NOT A LEDGER. Nothing here moves money, credits a wallet or
   touches investor returns. It records what an outside document says, with the
   date it said it.
   ═══════════════════════════════════════════════════════════ */

const SHARE_TOLERANCE = 0.01;      // one cent

/* ── Reading the published HTML ──────────────────────────────────────
   A published sheet's /pubhtml/sheet?gid=N is a plain table. Parsed with
   regular expressions rather than a DOM library because that is the whole
   dependency saved for one well-formed table, and the shape is asserted by
   the check against a real copy of the page. */
function cellsOf(html) {
  const rows = [];
  const tables = String(html || '').match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const t of tables) {
    const trs = t.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const tr of trs) {
      const cs = tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
      rows.push(cs.map(c => unentity(c.replace(/<[^>]+>/g, ''))));
    }
  }
  return rows;
}

function unentity(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/ /g, ' ').trim();
}

/* "R 131,761.50" → 131761.5, "-R 4,032" → -4032, "-" and "" → null.
   NULL and 0 are different answers and this never conflates them. */
function money(v) {
  const s = unentity(v);
  if (!s || s === '-' || s === '—' || s === '–') return null;
  const neg = /^-/.test(s) || /^\(.*\)$/.test(s);
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/* "100.0%" → 1, "22.1%" → 0.221, blank → null. */
function pct(v) {
  const s = unentity(v);
  if (!s || s === '-') return null;
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

/* "06 Oct 2026" → "2026-10-06". Returns null rather than guessing at a
   format it does not recognise: a date read wrong puts a load in the wrong
   month, and a month is what this facility reports on. */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
                 jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function isoDate(v) {
  const s = unentity(v);
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (!mo) return null;
    return `${m[3]}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? s : null;
}

/* ── The header row, found by its contents ───────────────────────────
   Not by row number: a sheet gains a note above the table and every index
   below it moves. The header is the row that names the load and its cost. */
function headerIndex(rows, must) {
  for (let i = 0; i < rows.length; i++) {
    const joined = rows[i].map(c => c.toLowerCase()).join('|');
    if (must.every(m => joined.includes(m))) return i;
  }
  return -1;
}

function columnMap(header) {
  const map = {};
  header.forEach((h, i) => { const k = unentity(h).toLowerCase(); if (k) map[k] = i; });
  /* Looked up by the words the sheet uses. A renamed column is a missing
     column, reported by name, rather than silently read off the old index. */
  const find = (...names) => {
    for (const n of names) if (map[n] !== undefined) return map[n];
    for (const n of names) {
      const hit = Object.keys(map).find(k => k.startsWith(n));
      if (hit) return map[hit];
    }
    return undefined;
  };
  return { map, find };
}

/* ── Loads ───────────────────────────────────────────────────────────
   `ourColumn` names the column holding OUR share, e.g.
   "sv capital from pool a (r)". Passed in rather than hardcoded so the
   facility's settings decide whose share is being reported. */
function parseLoads(html, { ourColumn, ourSharePct, warnings = [] } = {}) {
  const rows = cellsOf(html);
  const hi = headerIndex(rows, ['load #', 'margin']);
  if (hi < 0) {
    const e = new Error('That sheet has no loads table — no header row naming "Load #" and "Margin".');
    e.status = 422; throw e;
  }
  const { find } = columnMap(rows[hi]);
  const col = {
    ref:       find('load #'),
    bought:    find('date bought'),
    tons:      find('tons'),
    safax:     find('safax'),
    buy:       find('buy price (r/t)', 'buy price'),
    sell:      find('sell price (r/t)', 'sell price'),
    paid:      find('date buyer paid'),
    payout:    find('pool a payout date'),
    cost:      find('load cost (r)', 'load cost'),
    margin:    find('margin (r)', 'margin'),
    poolPct:   find('pool a %'),
    poolMargin:find('pool a margin (r)'),
    ours:      find(String(ourColumn || '').toLowerCase()),
    status:    find('pool a status', 'status'),
  };
  for (const [k, v] of Object.entries({ 'Load #': col.ref, 'Date bought': col.bought,
                                        'Load cost (R)': col.cost, 'Margin (R)': col.margin })) {
    if (v === undefined) {
      const e = new Error(`That sheet is missing the "${k}" column.`);
      e.status = 422; throw e;
    }
  }
  if (col.ours === undefined) {
    const e = new Error(`That sheet has no "${ourColumn}" column — which is the only figure `
                      + 'this report is about.');
    e.status = 422; throw e;
  }

  const at = (r, i) => (i === undefined ? '' : (r[i] === undefined ? '' : r[i]));
  const loads = [];
  let skipped = 0;
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    const ref = unentity(at(r, col.ref));
    const bought = isoDate(at(r, col.bought));
    const cost = money(at(r, col.cost));
    /* CONTENT, NOT FORMATTING. A load is a row with a number, a purchase
       date and a cost. The template's blank rows have the first and nothing
       else; its sample rows were overwritten with live data and kept their
       italics, so styling says nothing about whether a row is real. */
    if (!/^\d+$/.test(ref)) { continue; }
    if (!bought || cost === null) { skipped++; continue; }

    const margin = money(at(r, col.margin));
    const poolPct = pct(at(r, col.poolPct));
    const poolMargin = money(at(r, col.poolMargin));
    const ours = money(at(r, col.ours));
    const paid = isoDate(at(r, col.paid));

    /* The sheet's own arithmetic, re-done — on the step that concerns us,
       and no further.

       The first version of this re-derived the pool split from the "Pool A %"
       column and cried wolf on four live loads. That column is DISPLAYED to
       one decimal (22.1%) and computed at full precision, so re-deriving from
       what is printed is wrong by cents every time. A verification that
       produces false alarms is worse than none: it is the one somebody turns
       off, and then it is not there for the real error either.

       So this checks our share against the sheet's OWN Pool A margin, which
       is the claim we actually rely on: whatever the split came to, 40% of it
       is ours. Exact to the cent on every live load. The pool split itself is
       Grain Co's arithmetic on Grain Co's capital and is not ours to re-do. */
    if (ours !== null && poolMargin !== null && ourSharePct) {
      const expect = Math.round(poolMargin * ourSharePct * 100) / 100;
      if (Math.abs(expect - ours) > SHARE_TOLERANCE) {
        warnings.push(`Load ${ref}: the sheet says our share is ${ours.toFixed(2)}, but `
          + `${(ourSharePct * 100).toFixed(1)}% of its own Pool A margin of `
          + `${poolMargin.toFixed(2)} is ${expect.toFixed(2)}.`);
      }
    }

    loads.push({
      load_ref: ref,
      date_bought: bought,
      tons: money(at(r, col.tons)),
      safax: money(at(r, col.safax)),
      buy_price: money(at(r, col.buy)),
      sell_price: money(at(r, col.sell)),
      date_buyer_paid: paid,
      payout_date: isoDate(at(r, col.payout)),
      load_cost: cost,
      margin_total: margin,
      pool_pct: poolPct,
      pool_margin: poolMargin,
      /* NULL where the buyer has not paid: the margin is not split until
         they do, so there is no share yet. Not zero. */
      our_margin: ours,
      status: unentity(at(r, col.status)) || null,
      settled: ours !== null,
    });
  }
  return { loads, skipped, warnings };
}

/* ── The investor register, for OUR capital in the facility ───────────
   The one number that is actually at risk, as against the sum of the loads. */
function parseCapital(html, { ourName }) {
  const rows = cellsOf(html);
  const hi = headerIndex(rows, ['investor', 'amount']);
  if (hi < 0) return { deposits: [], capital: null };
  const { find } = columnMap(rows[hi]);
  const col = { who: find('investor'), pool: find('pool (a/b)', 'pool'),
                amount: find('amount (r)', 'amount'),
                din: find('date in'), dout: find('date out') };
  const want = String(ourName || '').toLowerCase();
  const deposits = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    const who = unentity(col.who === undefined ? '' : r[col.who] || '');
    const amt = money(col.amount === undefined ? '' : r[col.amount] || '');
    if (!who || amt === null) continue;
    if (who.toLowerCase() !== want) continue;
    deposits.push({ investor: who, pool: unentity(col.pool === undefined ? '' : r[col.pool] || ''),
                    amount: amt, date_in: isoDate(col.din === undefined ? '' : r[col.din] || ''),
                    date_out: isoDate(col.dout === undefined ? '' : r[col.dout] || '') });
  }
  /* Money still in: a deposit with a date out has been taken back. */
  const capital = deposits.length
    ? deposits.reduce((t, d) => t + (d.date_out ? 0 : d.amount), 0) : null;
  return { deposits, capital };
}

/* ── What the report says ────────────────────────────────────────────
   Totals over OUR share only. Settled and unsettled are counted apart
   because a facility whose loads have not been paid for yet has earned
   nothing, and one number covering both would say otherwise. */
function summarise(loads, capital) {
  const settled = loads.filter(l => l.settled);
  const earned = settled.reduce((t, l) => t + (l.our_margin || 0), 0);
  const awaiting = loads.filter(l => !l.settled);
  return {
    loads: loads.length,
    settled: settled.length,
    awaiting_settlement: awaiting.length,
    our_margin_earned: Math.round(earned * 100) / 100,
    /* The facility's gross margin is NOT our money and is reported as
       context only, clearly labelled, because it is the figure somebody
       would otherwise read as a return. */
    facility_margin_settled: Math.round(
      settled.reduce((t, l) => t + (l.margin_total || 0), 0) * 100) / 100,
    our_capital: capital,
    /* Return on our capital, only where capital is known. Not annualised:
       the facility is weeks old and an annualised figure off three weeks of
       trading is a projection dressed as a measurement. */
    return_on_capital: (capital && capital > 0)
      ? Math.round((earned / capital) * 10000) / 10000 : null,
    first_load: loads.reduce((m, l) => (!m || l.date_bought < m) ? l.date_bought : m, null),
    last_load: loads.reduce((m, l) => (!m || l.date_bought > m) ? l.date_bought : m, null),
  };
}

module.exports = { cellsOf, money, pct, isoDate, headerIndex, columnMap,
                   parseLoads, parseCapital, summarise, SHARE_TOLERANCE };
