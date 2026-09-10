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

/* ─── Rendering ───────────────────────────────────────────────────────
   Plain, self-contained HTML: it is stored verbatim, served back on its
   own, and printed. No stylesheet it could lose, no script. */
function renderAgreement(o) {
  const t = templateFor(o.product_type);
  const dt = new Date(o.drawn_at || Date.now());
  const when = dt.toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });

  const parties = [
    ['Investor',        `${o.investor_name || ''}`],
    ['Investor ID',     o.investor_id],
    ['Pool',            o.pool_name || o.pool_id || '—'],
    ['Structure',       t.gloss ? `${t.title.replace(' Investment Agreement', '')} — ${t.gloss}` : 'Standard'],
    ['Amount invested', rand(o.pool_amount_cents)],
    ['Platform fee',    rand(o.fee_cents)],
    ['Total from wallet', rand(o.amount_cents)],
    ['Term',            o.term_months ? `${o.term_months} months` : '—'],
    ['Maturity date',   o.maturity_date || '—'],
    ['Target return',   o.rate_label || '—'],
  ];

  const signed = !!o.signed_at;
  const sigBlock = signed ? `
  <section class="sig">
    <h2>Signature</h2>
    <div class="sigwrap">
      ${o.signature_png ? `<img class="sigimg" src="${esc(o.signature_png)}" alt="Signature of ${esc(o.signer_name)}">` : ''}
      <div class="signame">${esc(o.signer_name)}</div>
      <div class="sigmeta">Signed electronically on ${esc(new Date(o.signed_at).toLocaleString('en-ZA'))}</div>
    </div>
    <h3>Acknowledged</h3>
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
  body{font:14px/1.6 Georgia,"Times New Roman",serif;color:#14180f;background:#fff;
       max-width:760px;margin:0 auto;padding:40px 24px}
  h1{font-size:1.5rem;margin:0 0 4px}
  h2{font-size:1.05rem;margin:28px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}
  h3{font-size:.95rem;margin:18px 0 6px}
  .no{font-family:monospace;font-size:.85rem;color:#555}
  table{border-collapse:collapse;width:100%;margin:12px 0;font-size:.9rem}
  th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #e3e3e3;vertical-align:top}
  th{width:190px;font-weight:600;color:#444}
  .clause{margin:12px 0}
  .clause b{display:block;margin-bottom:2px}
  .acks li{margin-bottom:6px}
  .sigimg{display:block;max-width:280px;border-bottom:1px solid #333;margin-bottom:6px}
  .signame{font-weight:600}
  .sigmeta{font-size:.82rem;color:#555}
  .audit th{width:170px}
  .foot{margin-top:32px;font-size:.8rem;color:#666;border-top:1px solid #ccc;padding-top:12px}
</style></head><body>
<h1>${esc(t.title)}</h1>
<div class="no">${esc(o.agreement_no)} · drawn ${esc(when)} · template ${esc(t.key)} ${esc(t.version)}</div>

<h2>Parties and particulars</h2>
<table>${parties.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>

<h2>Terms</h2>
${t.clauses.map(([h, b]) => `<div class="clause"><b>${esc(h)}</b>${esc(b)}</div>`).join('')}

<h2>Risk</h2>
<div class="clause">The Investor’s capital is at risk. Past performance is not a guide to future returns. This agreement does not constitute financial advice, and the Investor confirms they have satisfied themselves that this investment is suitable for their circumstances.</div>
${sigBlock}
<div class="foot">SV Capital · SmartVest Financial Services · FSP #52449<br>
Signed electronically in terms of the Electronic Communications and Transactions Act 25 of 2002.</div>
</body></html>`;
}

const sha256 = text => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

module.exports = {
  ACK, TEMPLATES, templateFor, acknowledgementsFor,
  renderAgreement, sha256, toCents, fromCents, rand,
};
