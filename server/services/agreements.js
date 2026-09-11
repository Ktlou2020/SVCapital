'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Investment agreements — the wording, the rendering, and the seal.

   One place, because three things have to agree and drift silently if
   they live apart: the acknowledgements the investor ticks, the clauses
   the document states, and the version number recorded against both.

   Nothing here writes to the database. The route owns that.
   ═══════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

/* Money is compared, not displayed, so it is held in cents. A signed
   agreement is matched to an investment on an exact amount, and an exact
   comparison on a float is not a comparison. */
const toCents   = v => Math.round((parseFloat(v) || 0) * 100);
const fromCents = c => (Number(c) || 0) / 100;
const rand      = c => 'R' + fromCents(c).toLocaleString('en-ZA',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ─── The acknowledgements ────────────────────────────────────────────
   Each is ticked on its own. A single box covering everything is not an
   acknowledgement of anything in particular, and it is the first thing an
   ombud asks about.

   The wording of each one restates a term that costs the investor money if
   they misunderstood it — for the EIF structures, the specific thing that
   separates the return from interest. */
const ACK = {
  target_not_promise: 'I understand the figure shown is a target, not a promise, and that my capital is at risk.',
  fee_inclusive:      'I understand the 1% platform fee is taken from the amount I am investing, not added to it.',
  term_locked:        'I understand my capital is committed until the maturity date and cannot be withdrawn on demand.',
  mudarabah_loss:     'I understand that if the venture loses money the loss falls on the capital I provided, and the operating partner forfeits their share of the profit instead of covering it.',
  ijara_rent_stops:   'I understand my return is rent on an asset the pool owns, and that the rent stops if the asset cannot be used.',
  murabaha_fixed:     'I understand my return is a share of a mark-up fixed at the time of sale, which does not grow if the buyer pays late.',
};

/* ─── The templates ───────────────────────────────────────────────────
   version is bumped whenever the wording below changes. It is stored on
   every agreement so that a document signed under v1 can still be
   explained after v2 ships. Never edit a version in place. */
const TEMPLATES = {
  standard: {
    key: 'standard', version: 'v1',
    title: 'Investment Agreement',
    acks: ['target_not_promise', 'fee_inclusive', 'term_locked'],
    clauses: [
      ['The investment', 'The Investor commits the Investment Amount to the Pool named above for the stated term. The amount placed in the Pool is the Investment Amount less the platform fee.'],
      ['Return', 'The rate shown is a target return based on the Pool’s own projections. It is not guaranteed. The Investor’s capital is at risk and may be returned in part or not at all.'],
      ['Term', 'Capital is committed until the maturity date and is not repayable on demand. Early withdrawal is at SV Capital’s discretion and may carry a cost.'],
      ['Platform fee', 'A platform fee of 1% is taken from the Investment Amount at the time of investment. It is deducted from the amount invested and is not charged in addition to it.'],
      ['Maturity', 'At maturity the Investor’s standing instruction applies. Where no instruction is given, the capital and any return are reinvested into the next available pool of the same type.'],
    ],
  },
  eif_murabaha: {
    key: 'eif_murabaha', version: 'v1',
    title: 'Murabaha Investment Agreement',
    gloss: 'cost-plus sale',
    acks: ['murabaha_fixed', 'fee_inclusive', 'term_locked'],
    clauses: [
      ['The structure', 'SV Capital purchases goods and takes ownership of them before selling them on to a buyer at a price and mark-up disclosed in full before the sale. The Investor’s return is a share of that mark-up.'],
      ['Why this is not interest', 'The return arises from a trade in goods that were actually bought and actually sold. It is fixed at the moment of sale and does not increase with time or with late payment.'],
      ['Assets financed', 'Typical assets include production equipment sold on to an operator, agricultural inputs purchased ahead of a planting season, and livestock sold on to a feedlot.'],
      ['Late payment', 'A buyer who pays late owes the same amount they always owed. No penalty charge accrues to the Investor.'],
      ['Platform fee', 'A platform fee of 1% is taken from the Investment Amount at the time of investment, not added to it.'],
    ],
  },
  eif_ijara: {
    key: 'eif_ijara', version: 'v1',
    title: 'Ijara Investment Agreement',
    gloss: 'lease',
    acks: ['ijara_rent_stops', 'fee_inclusive', 'term_locked'],
    clauses: [
      ['The structure', 'The Pool purchases an income-producing asset and holds title to it for the life of the lease. The asset is leased to an operator and the Investor’s return is a share of the rental.'],
      ['Why this is not interest', 'Because the Pool owns the asset it carries the risks of ownership. If the asset cannot be used, the rent stops. That risk is what makes the income rent rather than a charge for the use of money.'],
      ['Assets financed', 'Typical assets include delivery vehicles leased to a logistics operator and production equipment leased to its user.'],
      ['Owner’s costs', 'Insurance and major maintenance are borne by the Pool as owner, not by the lessee.'],
      ['End of term', 'The lease may provide an option to transfer the asset to the lessee at the end of the term.'],
    ],
  },
  eif_mudarabah: {
    key: 'eif_mudarabah', version: 'v1',
    title: 'Mudarabah Investment Agreement',
    gloss: 'profit-sharing partnership',
    acks: ['mudarabah_loss', 'target_not_promise', 'fee_inclusive', 'term_locked'],
    clauses: [
      ['The structure', 'The Investor provides capital (rabb al-mal) and a vetted operating partner provides the work (mudarib). Profit is divided on a ratio agreed before any capital is deployed, being 80% to investors and 20% to the operating partner.'],
      ['Loss', 'A loss of the venture falls on the capital. The operating partner forfeits their share of the profit rather than contributing to the loss, and does not owe the Investor the shortfall.'],
      ['Why nothing is promised', 'No return is promised in advance. A promised return on a partnership would be the thing this structure exists to avoid. The figure shown is drawn from the venture’s own projections.'],
      ['Ventures financed', 'Typical ventures include a cattle feedlot cycle and a maize season funded from inputs through to harvest.'],
      ['Reporting', 'The Investor receives reporting on the underlying venture each quarter.'],
    ],
  },
};

/* An EIF product signs its own contract; everything else signs the standard
   one. Falling back rather than throwing is deliberate: a new product type
   must not make investing impossible before someone writes its wording. */
function templateFor(productType) {
  return TEMPLATES[String(productType || '')] || TEMPLATES.standard;
}

function acknowledgementsFor(productType) {
  return templateFor(productType).acks.map(k => ({ key: k, text: ACK[k] }));
}

/* ─── The clauses every agreement carries ─────────────────────────────
   The structure-specific clauses in TEMPLATES say what the investment IS.
   These say how the relationship works, and they are the ones an ombud asks
   for: what we are and are not doing for the client, what the money buys,
   when they can have it back, what we may do with their information, and
   where they go when they are unhappy.

   Numbered when rendered, so a clause can be cited in a letter. */
const COMMON_CLAUSES = [
  ['This agreement', 'This agreement records the terms on which the Investor places the Investment Amount with SmartVest Financial Services (Pty) Ltd, trading as SV Capital, an authorised financial services provider, FSP number 52449, for investment in the Pool identified above.'],
  ['No advice has been given', 'SV Capital has provided factual information about this product. It has NOT provided financial advice as contemplated in the Financial Advisory and Intermediary Services Act. The Investor confirms that they have chosen this investment themselves, that they have satisfied themselves that it suits their circumstances, objectives and risk tolerance, and that they may seek independent advice before signing.'],
  ['How the capital is applied', 'The Investment Amount is applied to the Pool and deployed into the underlying assets described in this agreement. The Investor does not hold title to any individual asset and has no right to direct how a particular asset is managed.'],
  ['Fees', 'The fees set out in the Fees and charges table above are the only fees payable on this investment. The platform fee is charged in addition to the Investment Amount and is paid from the Investor’s wallet at the time of investment. Any management or operational fee is deducted from the Pool and reduces the return. No fee not listed in that table will be charged on this investment without the Investor’s written agreement.'],
  ['Return', 'Any rate shown is a TARGET drawn from the Pool’s own projections. It is not a guarantee, a promise, or a debt owed to the Investor. Returns may be lower than the target, may be nil, and the capital itself may be reduced or lost.'],
  ['Term and liquidity', 'The Investment Amount is committed for the term stated above and is not repayable on demand. There is no secondary market. Early withdrawal is at SV Capital’s sole discretion, depends on the underlying assets being realisable, and may carry a cost or a reduced return.'],
  ['Maturity', 'At maturity the Investor’s standing instruction applies. Where no instruction has been given, the capital and any return are reinvested into the next available pool of the same type. An instruction may be changed at any time before maturity through the portal.'],
  ['Reporting', 'The Investor may view their position in the portal at any time and receives a statement covering the investment, its transactions and its fees. Pools with an operating partner are reported on quarterly.'],
  ['FICA and sanctions', 'SV Capital is obliged to identify and verify the Investor under the Financial Intelligence Centre Act, and to report certain transactions. The Investor undertakes that the funds invested are from a lawful source and that the information given for verification is true. SV Capital may delay or refuse a transaction to meet these obligations.'],
  ['Personal information', 'Personal information is processed in terms of the Protection of Personal Information Act and SV Capital’s privacy notice, for the purposes of administering this investment and meeting legal obligations. The signature captured with this agreement is used to evidence this agreement and for no other purpose.'],
  ['Complaints', 'A complaint should first be made to SV Capital in writing, and will be acknowledged and addressed under its internal complaints process. An Investor who remains dissatisfied may refer the matter to the Ombud for Financial Services Providers.'],
  ['Conflicts of interest', 'SV Capital maintains a conflicts of interest management policy, available on request. Where SV Capital or an associate has an interest in an underlying asset or counterparty, that interest is disclosed in the Pool documentation.'],
  ['Cession', 'The Investor may not cede, transfer or encumber this investment or any right under this agreement without SV Capital’s prior written consent.'],
  ['Changes to these terms', 'These terms apply to this investment for its full term and are not varied by any later change to SV Capital’s standard terms. A variation of this agreement is effective only if recorded in writing and agreed by both parties.'],
  ['Electronic signature', 'This agreement is signed electronically in terms of the Electronic Communications and Transactions Act 25 of 2002. The parties agree that the electronic signature recorded with this agreement, together with the audit record set out in it, has the same effect as a handwritten signature.'],
  ['Whole agreement', 'This agreement, together with the Pool documentation it refers to, is the whole agreement between the parties on its subject matter. Governing law is that of the Republic of South Africa.'],
];

/* ─── Fees ────────────────────────────────────────────────────────────
   Every charge that touches the investment, in one table, with the rand
   figure beside the percentage. A fee disclosed only as a percentage is a
   fee the client has to work out, and the ones they do not work out are the
   ones they complain about later.

   A fee of zero is LISTED AS NONE rather than omitted. An absent row reads
   as an oversight; "None" is a statement that the pool does not charge it,
   and it is the line that protects us when somebody asks whether there was
   an operational fee. */
function feeSchedule(o) {
  const pool = Math.max(0, Number(o.pool_amount_cents) || 0);
  const pct  = v => {
    const n = parseFloat(v) || 0;
    /* Stored as a percentage on the pool (2 means 2%), which is how the
       console's "Upfront management fee (%)" field writes it. */
    return n;
  };
  const onPool = p => Math.round(pool * (p / 100));

  const FREQ = {
    once:      'Once, upfront',
    upfront:   'Once, upfront',
    annual:    'Each year of the term',
    annually:  'Each year of the term',
    monthly:   'Each month of the term',
    quarterly: 'Each quarter of the term',
    maturity:  'Once, at maturity',
  };
  const freq = f => FREQ[String(f || '').toLowerCase()] || 'Once, upfront';

  const rows = [];

  rows.push({
    name:   'Platform fee',
    rate:   '1.00%',
    base:   'of the amount invested',
    when:   'Once, when the investment is made',
    amount: Number(o.fee_cents) || 0,
    note:   'Charged in addition to the amount invested. The wallet pays both.',
  });

  const mgmt = pct(o.management_fee_pct);
  rows.push({
    name:   'Management fee',
    rate:   mgmt > 0 ? mgmt.toFixed(2) + '%' : 'None',
    base:   mgmt > 0 ? 'of the amount invested' : '—',
    when:   mgmt > 0 ? freq(o.management_fee_frequency) : '—',
    amount: mgmt > 0 ? onPool(mgmt) : 0,
    note:   mgmt > 0
      ? 'Deducted from the pool, not from the wallet. It reduces the return, and the target return shown is stated before it.'
      : 'This pool charges no management fee.',
    none:   mgmt <= 0,
  });

  const ops = pct(o.operational_fee_pct);
  rows.push({
    name:   'Operational fee',
    rate:   ops > 0 ? ops.toFixed(2) + '%' : 'None',
    base:   ops > 0 ? 'of the amount invested' : '—',
    when:   ops > 0 ? freq(o.operational_fee_frequency) : '—',
    amount: ops > 0 ? onPool(ops) : 0,
    note:   ops > 0
      ? 'Covers the running costs of the underlying assets and is deducted from the pool.'
      : 'This pool charges no operational fee.',
    none:   ops <= 0,
  });

  const perf = (parseFloat(o.performance_fee_pct) || 0) * 100;
  const bench = (parseFloat(o.benchmark_rate) || 0) * 100;
  rows.push({
    name:   'Performance fee',
    rate:   perf > 0 ? perf.toFixed(2) + '%' : 'None',
    base:   perf > 0 ? `of any return above the ${bench.toFixed(2)}% benchmark` : '—',
    when:   perf > 0 ? 'Once, at maturity, and only if the benchmark is beaten' : '—',
    amount: null,
    note:   perf > 0
      ? 'Nothing is payable unless the return exceeds the benchmark. It cannot be charged on a loss.'
      : 'This pool charges no performance fee.',
    none:   perf <= 0,
  });

  return rows;
}

/* ─── Rendering ───────────────────────────────────────────────────────
   Plain, self-contained HTML: it is stored verbatim, served back on its
   own, and printed. No stylesheet it could lose, no script. */
/* The pool's own facts, shaped for the renderer. One place, because the draw
   and the sign paths both build the document and a field added to one and
   forgotten in the other changes the bytes between what was read and what was
   sealed — and the hash would then describe a document nobody saw. */
function poolFacts(p) {
  const d = v => v ? new Date(v).toLocaleDateString('en-ZA',
    { year: 'numeric', month: 'long', day: 'numeric' }) : null;
  return {
    pool_id: p.id, pool_name: p.name, product_type: p.product_type,
    term_months: p.term_months,
    start_date: d(p.investment_start_date),
    maturity_date: d(p.maturity_date),
    rate_label: p.annual_rate ? `${(parseFloat(p.annual_rate) * 100).toFixed(2)}% target` : null,
    management_fee_pct: p.management_fee_pct,
    management_fee_frequency: p.management_fee_frequency,
    operational_fee_pct: p.operational_fee_pct,
    operational_fee_frequency: p.operational_fee_frequency,
    performance_fee_pct: p.performance_fee_pct,
    benchmark_rate: p.benchmark_rate,
  };
}

function renderAgreement(o) {
  const t = templateFor(o.product_type);
  const dt = new Date(o.drawn_at || Date.now());
  const when = dt.toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });
  const fees = feeSchedule(o);

  const rows = pairs => pairs
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');

  const parties = rows([
    ['Provider',        'SmartVest Financial Services (Pty) Ltd t/a SV Capital'],
    ['FSP number',      '52449'],
    ['Investor',        o.investor_name || '—'],
    ['Investor ID',     o.investor_id],
    ['Email',           o.investor_email || '—'],
    ['Agreement number', o.agreement_no],
    ['Date drawn',      when],
  ]);

  const investment = rows([
    ['Pool',              o.pool_name || o.pool_id || '—'],
    ['Structure',         t.gloss ? `${t.term || t.title.replace(' Investment Agreement', '')} — ${t.gloss}` : 'Standard'],
    ['Amount invested',   rand(o.pool_amount_cents)],
    ['Platform fee (1%)', rand(o.fee_cents)],
    ['Total from wallet', rand(o.amount_cents)],
    ['Term',              o.term_months ? `${o.term_months} months` : '—'],
    ['Investment starts', o.start_date || '—'],
    ['Maturity date',     o.maturity_date || '—'],
    ['Target return',     o.rate_label || '—'],
    ['At maturity',       o.maturity_instruction || 'Reinvested into the next pool of the same type, unless instructed otherwise'],
  ]);

  const feeRows = fees.map(f => `
    <tr${f.none ? ' class="none"' : ''}>
      <th>${esc(f.name)}</th>
      <td class="r">${esc(f.rate)}</td>
      <td>${esc(f.base)}</td>
      <td>${esc(f.when)}</td>
      <td class="r">${f.none ? '—' : (f.amount === null ? 'On the return' : rand(f.amount))}</td>
    </tr>
    <tr${f.none ? ' class="none"' : ''}><td class="note" colspan="5">${esc(f.note)}</td></tr>`).join('');

  /* Numbered across both sets so a clause can be cited in a letter. */
  let n = 0;
  const clause = ([h, b]) => `<div class="clause"><b>${++n}. ${esc(h)}</b>${esc(b)}</div>`;
  const structureClauses = t.clauses.map(clause).join('');
  const commonClauses    = COMMON_CLAUSES.map(clause).join('');

  const signed = !!o.signed_at;
  const sigBlock = signed ? `
  <section class="sig">
    <h2>Signature</h2>
    <div class="sigwrap">
      ${o.signature_png ? `<img class="sigimg" src="${esc(o.signature_png)}" alt="Signature of ${esc(o.signer_name)}">` : ''}
      <div class="signame">${esc(o.signer_name)}</div>
      <div class="sigmeta">Signed electronically on ${esc(new Date(o.signed_at).toLocaleString('en-ZA'))}</div>
    </div>
    <h3>Acknowledged before signing</h3>
    <ul class="acks">
      ${(o.acknowledgements || []).map(a => `<li>${esc(a.text)}</li>`).join('')}
    </ul>
    <h3>Audit record</h3>
    <table class="audit">
      <tr><th>Agreement number</th><td>${esc(o.agreement_no)}</td></tr>
      <tr><th>Template</th><td>${esc(t.key)} ${esc(t.version)}</td></tr>
      <tr><th>Drawn</th><td>${esc(dt.toISOString())}</td></tr>
      <tr><th>Signed</th><td>${esc(new Date(o.signed_at).toISOString())}</td></tr>
      <tr><th>Signed from</th><td>${esc(o.signed_ip || '—')}</td></tr>
      <tr><th>Device</th><td>${esc(o.signed_user_agent || '—')}</td></tr>
    </table>
  </section>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(t.title)} — ${esc(o.agreement_no)}</title>
<style>
  body{font:14px/1.62 Georgia,"Times New Roman",serif;color:#14180f;background:#fff;
       max-width:780px;margin:0 auto;padding:40px 24px}
  h1{font-size:1.5rem;margin:0 0 4px}
  h2{font-size:1.05rem;margin:30px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}
  h3{font-size:.95rem;margin:18px 0 6px}
  .no{font-family:monospace;font-size:.82rem;color:#555}
  table{border-collapse:collapse;width:100%;margin:12px 0;font-size:.9rem}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #e3e3e3;vertical-align:top}
  th{font-weight:600;color:#444}
  table.kv th{width:190px}
  table.fees th{width:135px}
  table.fees td.r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  table.fees thead th{background:#f4f4f1;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em}
  table.fees td.note{font-size:.8rem;color:#555;padding-top:0;border-bottom:1px solid #e3e3e3}
  table.fees tr.none th,table.fees tr.none td{color:#777}
  .clause{margin:13px 0}
  .clause b{display:block;margin-bottom:2px}
  .acks li{margin-bottom:6px}
  .sigimg{display:block;max-width:280px;border-bottom:1px solid #333;margin-bottom:6px}
  .signame{font-weight:600}
  .sigmeta{font-size:.82rem;color:#555}
  .audit th{width:170px}
  .risk{border-left:3px solid #8f5406;padding:10px 14px;background:#fdf6ec;margin:12px 0}
  .foot{margin-top:34px;font-size:.8rem;color:#666;border-top:1px solid #ccc;padding-top:12px}
  @media print{body{padding:0}h2{page-break-after:avoid}.clause{page-break-inside:avoid}}
</style></head><body>
<h1>${esc(t.title)}</h1>
<div class="no">${esc(o.agreement_no)} · drawn ${esc(when)} · template ${esc(t.key)} ${esc(t.version)}</div>

<h2>1. Parties</h2>
<table class="kv">${parties}</table>

<h2>2. The investment</h2>
<table class="kv">${investment}</table>

<h2>3. Fees and charges</h2>
<p style="font-size:.86rem;color:#555;margin:0 0 8px">Every charge that applies to this
investment is listed here, with the rand amount on the figures above. A fee shown as
<em>None</em> is not charged on this pool.</p>
<table class="fees">
  <thead><tr><th>Fee</th><th class="r">Rate</th><th>Charged on</th><th>When</th><th class="r">Amount</th></tr></thead>
  <tbody>${feeRows}</tbody>
</table>

<h2>4. How this structure works</h2>
${structureClauses}

<h2>5. General terms</h2>
${commonClauses}

<h2>6. Risk</h2>
<div class="risk">The Investor’s capital is at risk and may be reduced or lost in full.
Any return shown is a target and not a guarantee. Past performance is not a guide to future
returns. This investment is not a deposit, it is not guaranteed by SV Capital or by any
third party, and it is not covered by any deposit insurance or compensation scheme. The
Investor confirms that they can bear a loss of the amount invested.</div>
${sigBlock}
<div class="foot">SmartVest Financial Services (Pty) Ltd t/a SV Capital · authorised financial services provider, FSP 52449<br>
Signed electronically in terms of the Electronic Communications and Transactions Act 25 of 2002.</div>
</body></html>`;
}

const sha256 = text => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

module.exports = {
  ACK, TEMPLATES, COMMON_CLAUSES, templateFor, acknowledgementsFor, feeSchedule,
  renderAgreement, poolFacts, sha256, toCents, fromCents, rand,
};
