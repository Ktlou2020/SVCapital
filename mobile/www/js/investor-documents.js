/* The two documents a client receives, built in one place.
 *
 * The account statement and the Investment Income Reference are produced by
 * the admin console and by the investor portal, and used to be two separate
 * implementations of each. They had already drifted: the portal's certificate
 * counted `payout` as income — capital coming back, declared as earnings —
 * and windowed the tax year on created_at, both of which the console's copy
 * had been corrected for. A client could hold two documents from the same
 * platform disagreeing about what they earned.
 *
 * These are the console's versions, moved verbatim. The portal now renders
 * the same markup from the same server payload (services/accountStatement and
 * services/incomeReference), so the two surfaces cannot drift again — in
 * layout or in figures.
 *
 * Ambient by design: Utils and Toast come from js/api.js and _esc from the
 * surface's own bundle. Both admin and portal load all three before any of
 * this is called.
 */
'use strict';

(function (global) {

  /* Both documents are built as a complete HTML page and then shown. The
     console opens a print window; the portal renders the same string into its
     preview pane and opens the same window from the Print button. Splitting
     build from present is what lets one implementation serve both without
     either surface reimplementing the design. */
  /* Mount a document in an iframe SCALED TO FIT its container.
   *
   * The statement is A4 landscape and lays out at 1100px; the certificate is
   * A4 portrait at 740. On a 390px phone the browser does not reflow them —
   * they are fixed-width documents — so the preview showed a sliver of a page
   * with the right-hand column off the edge.
   *
   * The frame is therefore rendered at the document's OWN width and scaled
   * down with a transform, which shrinks the whole page evenly instead of
   * squeezing its columns. Nothing about the document changes, so what
   * downloads is still A4 at full size. */
  function _mountScaled(container, html, docWidth) {
    container.innerHTML = '';
    const shell = document.createElement('div');
    shell.style.cssText = 'width:100%;overflow:hidden';
    const frame = document.createElement('iframe');
    frame.title = 'Document preview';
    frame.setAttribute('scrolling', 'no');
    frame.style.cssText = 'border:0;display:block;background:#fff;width:' + docWidth +
                          'px;transform-origin:top left';
    shell.appendChild(frame);
    container.appendChild(shell);

    const fit = () => {
      const avail = container.clientWidth || docWidth;
      /* Never scale UP: on a desktop the document is shown at its own size. */
      const scale = Math.min(1, avail / docWidth);
      frame.style.transform = scale < 1 ? 'scale(' + scale + ')' : '';
      let h = 0;
      try { h = frame.contentDocument.body.scrollHeight; } catch (_) {}
      if (h) {
        frame.style.height = (h + 24) + 'px';
        shell.style.height = Math.ceil((h + 24) * scale) + 'px';
      }
    };
    frame.addEventListener('load', fit);
    /* A phone rotating is the common case, and the scale is width-derived. */
    window.addEventListener('resize', fit);
    frame.srcdoc = html;
    return frame;
  }

  /* Show a finished document.
   *
   * window.open with window features is treated as a pop-up on mobile Safari
   * and inside the Capacitor WebView, and is refused — so "Print / Save PDF"
   * failed on a phone with nothing but a toast telling the client to change a
   * browser setting they should not have to think about. A real window is
   * still nicer on a desktop, so it is tried first and the page falls back to
   * a full-screen overlay that needs no pop-up at all. Printing from the
   * overlay prints the IFRAME, so the @page rules still apply and the output
   * is the same A4 document. */
  function _present(html, width, height) {
    const win = window.open('', '_blank', 'width=' + width + ',height=' + height);
    if (win) { win.document.write(html); win.document.close(); return true; }
    _overlay(html, width);
    return true;
  }

  function _overlay(html, docWidth) {
    const prev = document.getElementById('svc-doc-overlay');
    if (prev) prev.remove();
    const ov = document.createElement('div');
    ov.id = 'svc-doc-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#f1f5f9;' +
                       'display:flex;flex-direction:column';
    ov.innerHTML =
      '<div style="background:#1f2937;color:#fff;padding:10px 14px;display:flex;' +
           'align-items:center;gap:10px;flex-wrap:wrap">' +
        '<span style="font-size:13px;font-weight:700;flex:1;min-width:120px">Document</span>' +
        '<button id="svc-doc-print" style="border:none;padding:8px 16px;border-radius:6px;' +
          'font-size:13px;font-weight:700;background:#eda5ff;color:#111;cursor:pointer">Print / Save PDF</button>' +
        '<button id="svc-doc-close" style="border:none;padding:8px 16px;border-radius:6px;' +
          'font-size:13px;font-weight:700;background:rgba(255,255,255,0.14);color:#fff;cursor:pointer">Close</button>' +
      '</div>' +
      '<div id="svc-doc-body" style="flex:1;overflow:auto;padding:10px"></div>';
    document.body.appendChild(ov);
    /* Full size here, not scaled. The inline preview is scaled so a client can
       see the shape of the document on a phone; this is the one they read and
       print, and a 35% A4 landscape page is not readable. It scrolls both ways
       instead. */
    const body  = ov.querySelector('#svc-doc-body');
    const frame = document.createElement('iframe');
    frame.title = 'Document';
    frame.style.cssText = 'border:0;display:block;background:#fff;width:' + docWidth + 'px;height:100%';
    body.appendChild(frame);
    frame.addEventListener('load', () => {
      try {
        const h = frame.contentDocument.body.scrollHeight;
        if (h) frame.style.height = (h + 24) + 'px';
      } catch (_) {}
    });
    frame.srcdoc = html;
    ov.querySelector('#svc-doc-close').onclick = () => ov.remove();
    ov.querySelector('#svc-doc-print').onclick = () => {
      /* Print the frame, not the overlay: the document carries its own @page
         size and margins, and the overlay chrome is not part of it. */
      try { frame.contentWindow.focus(); frame.contentWindow.print(); }
      catch (_) { Toast.error('This browser could not open the print dialog'); }
    };
  }

function _openAdminTaxCertWindow(data) {
  const { investor: inv, taxYear, returns, deposits, totalReturns, totalDeposits, from, to,
          maturedInvestments = [], maturedReturns = 0, maturedUnposted = 0 } = data;

  const fmt = n => 'R ' + parseFloat(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MONTHS_LONG  = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];

  /* Dates are rendered from their own YYYY-MM-DD text, never through a Date.
     A tax year ends on a DAY, and a day has no timezone: the server used to
     send the end as an instant at 23:59:59Z, which a browser in SAST printed
     as the next morning — so this document's header read "28 February 2026"
     while the summary card beside it read "1 March 2026". */
  const ymd = s => {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  };
  const fmtDate = s => { const p = ymd(s); return p ? `${p.d} ${MONTHS_SHORT[p.m - 1]} ${p.y}` : '—'; };
  const fmtLong = s => { const p = ymd(s); return p ? `${p.d} ${MONTHS_LONG[p.m - 1]} ${p.y}` : '—'; };
  /* The row date is when the money moved, not when the row was written. */
  const rowDate = t => fmtDate(t.txn_date || t.created_at);

  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const certNo = `SVCRC-${taxYear}-${String(inv.id).replace(/\D/g,'').slice(-6)}`;
  const issuedAt = new Date().toLocaleString('en-ZA', { dateStyle: 'long', timeStyle: 'short' });
  const fromLabel = fmtLong(from);
  const toLabel   = fmtLong(to);
  const fullAddr  = [inv.street_address, inv.suburb, inv.address, inv.postal_code, inv.province].filter(Boolean).join(', ');
  /* Same asset and same resolution as the statement, so the two documents a
     client receives carry one masthead rather than two. */
  const _logoUrl  = window.location.origin + '/assets/sv-capital-logo-horizontal-outline-1.png';

  /* Newest first, on the date each list is about — the same ordering the
     statement uses, so the two documents a client receives read the same way.
     Sorted on copies: these arrays feed the totals above. An undated row sorts
     last rather than to the top of the document. */
  const _ms = v => { const d = new Date(v); return isNaN(d.getTime()) ? null : d.getTime(); };
  const _byNewest = pick => (a, b) => {
    const x = pick(a), y = pick(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  };
  const _txnMs = t => _ms(t.txn_date) ?? _ms(t.created_at);
  const returnsSorted  = returns.slice().sort(_byNewest(_txnMs));
  const depositsSorted = deposits.slice().sort(_byNewest(_txnMs));
  const maturedSorted  = maturedInvestments.slice().sort(_byNewest(m => _ms(m.end_date)));

  const returnsRows = returnsSorted.map(t => `
    <tr>
      <td>${rowDate(t)}</td>
      <td>${_esc(esc(t.description || (t.type === 'interest' ? 'Interest credited' : 'Investment return')))}</td>
      <td class="amt">${fmt(Math.abs(parseFloat(t.amount||0)))}</td>
    </tr>`).join('');

  const depositsRows = depositsSorted.map(t => `
    <tr>
      <td>${rowDate(t)}</td>
      <td>${_esc(esc(t.description || 'Client deposit'))}</td>
      <td class="amt">${fmt(Math.abs(parseFloat(t.amount||0)))}</td>
    </tr>`).join('');

  /* Returns realised at maturity live on the investment, not in the ledger, so
     they need their own section. Shown beside the credited income and never
     added to it — a holding accrued monthly and then matured appears in both,
     and one total covering the two would declare the same earnings twice. */
  const maturedRows = maturedSorted.map(m => `
    <tr>
      <td>${fmtDate(m.end_date)}</td>
      <td>${_esc(esc(m.pool_name || 'Investment'))}</td>
      <td class="amt">${fmt(Math.abs(parseFloat(m.amount||0)))}</td>
      <td class="amt">${m.return_posted
        ? fmt(Math.abs(parseFloat(m.realised_return||0)))
        : '<span style="color:#b45309;font-weight:600">Not yet posted</span>'}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>SV Capital Investment Income Reference ${taxYear-1}/${taxYear}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;background:#fff;color:#111;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-size:13px}
@page{size:A4 portrait;margin:16mm 20mm}
@media print{.no-print{display:none!important}.wrap{margin-top:0!important}}
.no-print{position:fixed;top:0;left:0;right:0;background:#1f2937;padding:9px 20px;display:flex;justify-content:space-between;align-items:center;z-index:99;gap:10px;flex-wrap:wrap}
.no-print span{color:#fff;font-size:12px;font-weight:600;flex:1}
.no-print button{background:#eda5ff;color:#111;border:none;padding:7px 16px;border-radius:5px;font-size:12px;font-weight:700;cursor:pointer}
.wrap{max-width:740px;margin:52px auto 32px;padding:24px 30px;border-top:5px solid #eda5ff}
/* Header */
.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;border-bottom:3px solid #1f2937;margin-bottom:22px}
.hdr-brand p{font-size:10px;color:#6b7280;margin-top:7px}
.hdr-right{text-align:right}
.stmt-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#9ca3af;margin-bottom:3px}
.stmt-title{font-size:20px;font-weight:800;color:#1f2937;margin-bottom:4px}
.stmt-meta{font-size:10px;color:#6b7280;line-height:1.6}
.cert-badge{text-align:right;font-size:10px;color:#555;line-height:1.6}
.cert-badge strong{display:block;font-size:12px;color:#303030;font-weight:700}
/* Warning */
.warning{background:#fff8e1;border:1.5px solid #f59e0b;border-radius:6px;padding:10px 14px;margin-bottom:20px;font-size:11px;color:#78350f;display:flex;gap:8px;align-items:flex-start}
.warning strong{display:block;margin-bottom:2px}
/* Summary boxes */
.summary{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:24px}
.sum-box{border-radius:8px;padding:16px 18px;text-align:center}
.sum-box.green{background:#f0fdf4;border:1.5px solid #22c55e}
.sum-box.blue{background:#eff6ff;border:1.5px solid #3b82f6}
.sum-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px}
.sum-box.green .sum-lbl{color:#166534}
.sum-box.blue  .sum-lbl{color:#1e40af}
.sum-amt{font-size:22px;font-weight:800}
.sum-box.green .sum-amt{color:#15803d}
.sum-box.blue  .sum-amt{color:#1d4ed8}
.sum-period{font-size:10px;margin-top:3px}
.sum-box.green .sum-period{color:#166534}
.sum-box.blue  .sum-period{color:#1e40af}
/* Investor details */
.section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#374151;margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid #e5e7eb}
.details-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 20px;margin-bottom:22px;font-size:12px}
.details-grid dt{color:#6b7280;font-weight:600}
.details-grid dd{color:#111;font-weight:500}
/* Tables */
table{width:100%;border-collapse:collapse;margin-bottom:22px;font-size:12px}
thead tr{background:#f1f5f9}
th{padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#374151}
td{padding:8px 10px;border-bottom:1px solid #f1f5f9;color:#374151}
td.amt{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
tr.total-row td{border-top:2px solid #e5e7eb;border-bottom:none;font-weight:700;background:#f8fafc}
tr.total-row td.amt{color:#111}
.empty{text-align:center;padding:16px;background:#f8fafc;border-radius:6px;color:#9ca3af;font-size:12px;margin-bottom:22px}
/* Footer */
.footer{border-top:1px solid #e5e7eb;padding-top:11px;font-size:9px;color:#6b7280;line-height:1.7;margin-top:8px}
.footer strong{color:#374151}
.stamp{display:inline-block;border:2px solid #eda5ff;color:#eda5ff;padding:4px 11px;border-radius:3px;font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-top:10px}
.stamp{display:inline-block;border:2px solid #303030;color:#303030;padding:5px 12px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-top:12px}
</style></head><body>
<div class="no-print">
  <span>SV Capital &mdash; Investment Income Reference &nbsp;&middot;&nbsp; ${taxYear-1} / ${taxYear} &nbsp;&middot;&nbsp; ${_esc(esc(inv.first_name))} ${_esc(esc(inv.last_name))}</span>
  <button onclick="window.print()">Print / Save PDF</button>
</div>
<div class="wrap">
  <div class="hdr">
    <div class="hdr-brand">
      <img src="${_logoUrl}" style="height:52px;width:auto;max-width:270px;object-fit:contain;display:block" alt="SV Capital">
      <p>FSCA Regulated Financial Services Provider &middot; <span style="color:#eda5ff;font-weight:600">www.svcapital.co.za</span></p>
    </div>
    <div class="hdr-right">
      <div class="stmt-lbl">Document Type</div>
      <div class="stmt-title">Investment Income Reference</div>
      <div class="stmt-meta">Ref: <strong>${certNo}</strong><br>Tax Year: ${fromLabel} &ndash; ${toLabel}<br>Issued: ${issuedAt}</div>
    </div>
  </div>

  <div class="warning">
    <span style="font-size:16px">⚠</span>
    <div><strong>For reference purposes only — not an official SARS tax certificate.</strong>
    This document is provided to assist the client in preparing their tax return. It has not been submitted to SARS and does not replace an official IT3(b) certificate.</div>
  </div>

  ${/* The maturity return leads whenever there is one.

        With interestCron disabled, a client whose returns come from maturities
        can never have anything in "Returns Credited" — their whole investment
        income arrives as the return portion of maturity payouts, carried on the
        pool's actual_rate. Leading with a figure that is structurally R 0,00 for
        most clients puts the number that matters below the fold. */
    maturedInvestments.length ? `<div class="summary">
    <div class="sum-box green">
      <div class="sum-lbl">Returns Realised at Maturity</div>
      <div class="sum-amt">${maturedUnposted === maturedInvestments.length ? '—' : fmt(maturedReturns)}</div>
      <div class="sum-period">${maturedInvestments.length} investment${maturedInvestments.length === 1 ? '' : 's'} matured in this year${
        maturedUnposted ? ` · ${maturedUnposted} with no posted return yet` : ''}</div>
    </div>
    <div class="sum-box green">
      <div class="sum-lbl">Returns Credited</div>
      <div class="sum-amt">${fmt(totalReturns)}</div>
      <div class="sum-period">${fromLabel} – ${toLabel}</div>
    </div>
  </div>
  <div class="summary" style="margin-top:-10px">
    <div class="sum-box blue">
      <div class="sum-lbl">Total Deposits Made</div>
      <div class="sum-amt">${fmt(totalDeposits)}</div>
      <div class="sum-period">${fromLabel} – ${toLabel}</div>
    </div>
    <div class="sum-box" style="border-color:#d4d4d4">
      <div class="sum-lbl">Reported Separately</div>
      <div style="font-size:10.5px;color:#555;line-height:1.5;margin-top:4px">
        Returns realised at maturity and returns credited are shown apart and are
        <strong>not added together</strong>. An investment whose return was credited
        during the year and which then matured appears in both figures.
      </div>
    </div>
  </div>` : `<div class="summary">
    <div class="sum-box green">
      <div class="sum-lbl">Returns Credited</div>
      <div class="sum-amt">${fmt(totalReturns)}</div>
      <div class="sum-period">${fromLabel} – ${toLabel}</div>
    </div>
    <div class="sum-box blue">
      <div class="sum-lbl">Total Deposits Made</div>
      <div class="sum-amt">${fmt(totalDeposits)}</div>
      <div class="sum-period">${fromLabel} – ${toLabel}</div>
    </div>
  </div>`}

  <div class="section-title">Investor Details</div>
  <dl class="details-grid">
    <dt>Full Name</dt><dd>${_esc(esc(inv.first_name))} ${_esc(esc(inv.last_name))}</dd>
    <dt>Investor Account</dt><dd>${esc(inv.id)}</dd>
    <dt>Email Address</dt><dd>${_esc(esc(inv.email || '—'))}</dd>
    <dt>SA ID / Passport</dt><dd>${_esc(esc(inv.id_number || '—'))}</dd>
    ${fullAddr ? `<dt>Address</dt><dd>${esc(fullAddr)}</dd>` : ''}
  </dl>

  ${maturedInvestments.length ? `
  <div class="section-title" style="color:#166534">Investments Matured in this Tax Year</div>
  ${maturedUnposted ? `<div class="warning" style="background:#fffbeb">
    <div><strong>${maturedUnposted} of these ${maturedInvestments.length} investments has no posted return.</strong>
    A return is posted when the pool is closed out. Until then the amount earned is not known,
    and it is shown as "Not yet posted" rather than as zero. The total below covers only the
    investments whose return has been posted${maturedUnposted === maturedInvestments.length
      ? ', which is none of them' : ''}.</div>
  </div>` : ''}
  <table>
    <thead><tr><th>Matured</th><th>Investment</th><th style="text-align:right">Capital</th><th style="text-align:right">Return</th></tr></thead>
    <tbody>
      ${maturedRows}
      <tr class="total-row"><td colspan="3">TOTAL RETURNS REALISED AT MATURITY</td><td class="amt">${fmt(maturedReturns)}</td></tr>
    </tbody>
  </table>` : ''}

  <div class="section-title" style="color:#166534">Returns Credited</div>
  ${returns.length ? `<table>
    <thead><tr><th>Date</th><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>
      ${returnsRows}
      <tr class="total-row"><td colspan="2">TOTAL RETURNS CREDITED</td><td class="amt">${fmt(totalReturns)}</td></tr>
    </tbody>
  </table>` : `<div class="empty">${
    /* "No returns were credited" on its own reads as "you earned nothing",
       which is wrong for a client whose whole income came from maturities —
       and that is most of them. Say where the income actually is. */
    maturedInvestments.length
      ? 'No returns or interest were credited directly to the account in this tax year. ' +
        'The investment income for this year is the return realised at maturity, shown above.'
      : 'No returns or interest were credited in this tax year.'}</div>`}

  <div class="section-title" style="color:#1e40af">Deposits Made</div>
  ${deposits.length ? `<table>
    <thead><tr><th>Date</th><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>
      ${depositsRows}
      <tr class="total-row"><td colspan="2">TOTAL DEPOSITS MADE</td><td class="amt">${fmt(totalDeposits)}</td></tr>
    </tbody>
  </table>` : `<div class="empty">No deposits recorded for this tax year.</div>`}


  <div class="footer">
    <strong>SV Capital (Pty) Ltd</strong> &mdash; FSCA Regulated Financial Services Provider.<br>
    This investment income reference is prepared for <strong>${_esc(esc(inv.first_name))} ${_esc(esc(inv.last_name))}</strong>
    (Account: ${esc(inv.id)}) and covers the ${taxYear-1}/${taxYear} tax year, ${fromLabel} to ${toLabel}.
    All amounts are in South African Rand (ZAR).<br>
    Returns credited are investment return and interest amounts credited to the investor account in the period.
    Maturity payouts are excluded from that figure because a payout returns the client's own capital along with the
    return on it; the return realised at maturity is reported in its own section. Deposits shown are funds deposited
    into the account during the same period. This document is generated for client reference only and does not
    constitute an official SARS IT3(b) interest income certificate.<br>
    <strong>Ref:</strong> ${certNo} &middot; <strong>Issued:</strong> ${issuedAt} &middot; <strong>Generated by:</strong> SV Capital Admin Console<br>
    <div class="stamp">SV Capital (Pty) Ltd &mdash; www.svcapital.co.za</div>
  </div>
</div>
</body></html>`;

  if (arguments.length > 1 && arguments[1] === 'html') return html;
  _present(html, 860, 960);
}

function _openAccountStatementWindow(data) {
  const { investor: inv, period, investments, transactions = [],
          opening_balance = 0, closing_balance = 0, paid = {},
          derived_opening_balance = 0, reconciles = true, ledger_gap = 0 } = data;

  const fmt = n => 'R ' + Math.abs(parseFloat(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = s => s ? new Date(s).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const fromLabel = new Date(period.from).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  const toLabel   = new Date(period.to).toLocaleDateString('en-ZA',   { day: 'numeric', month: 'long', year: 'numeric' });
  const issuedAt  = new Date().toLocaleString('en-ZA', { dateStyle: 'long', timeStyle: 'short' });
  const stmtRef   = 'SVCAS-' + new Date().getFullYear() + '-' + (String(inv.id).replace(/\D/g,'').slice(-6) || String(inv.id).slice(-6).toUpperCase());
  const fullAddr  = [inv.street_address, inv.suburb, inv.address, inv.postal_code, inv.province].filter(Boolean).join(', ');

  const PROD_LABELS  = { cattle:'Cattle Investment', short_term:'Short-Term Investment', solar:'Solar Investment' };
  const INSTR_LABELS = { reinvest:'Reinvest', withdraw:'Withdraw', partial_withdraw:'Partial Withdraw', rollover:'Roll Over' };
  const STATUS_CFG   = {
    active:    { cls:'sb-active',    lbl:'Active'    },
    pending:   { cls:'sb-pending',   lbl:'Pending'   },
    matured:   { cls:'sb-matured',   lbl:'Matured'   },
    paid_out:  { cls:'sb-paidout',   lbl:'Paid Out'  },
    cancelled: { cls:'sb-cancelled', lbl:'Cancelled' },
  };

  const activeInvests  = investments.filter(i => ['active','pending'].includes(i.status));
  const maturedInvests = investments.filter(i => ['matured','paid_out'].includes(i.status));

  /* ── Portfolio summary ────────────────────────────────────────────────
     What the client holds, in the two places it can be: still invested, and
     sitting in the wallet.

     The wallet figure is the CLOSING BALANCE — the wallet as at the period end,
     which is what the ledger below closes on. Using today's wallet instead
     would put a figure in the summary that the ledger never reaches, on any
     statement for a period that has already ended.

     Active capital is the sum of the investments still running. `pending`
     is included because that money has left the wallet and is committed —
     leaving it out would make the two figures fail to account for it. */
  const fmtR = n => 'R ' + Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtRSigned = n => fmtR(n) + (n < 0 ? ' Dr' : '');
  const _n = v => parseFloat(v) || 0;
  const activeCapital  = Math.round(activeInvests.reduce((a, i) => a + _n(i.amount), 0) * 100) / 100;
  const walletAtClose  = Math.round((parseFloat(data.closing_balance) || 0) * 100) / 100;
  const portfolioTotal = Math.round((activeCapital + walletAtClose) * 100) / 100;
  const maturedCapital = Math.round(maturedInvests.reduce((a, i) => a + _n(i.amount), 0) * 100) / 100;
  const maturedReturn  = Math.round(maturedInvests.reduce((a, i) =>
    a + _n(i.actual_return != null ? i.actual_return : i.expected_return), 0) * 100) / 100;

  /* An investment still marked active whose maturity date has passed has not
     been processed. The statement reports the status it finds — but the person
     about to send it should know, because the client will ask. */
  const _periodEnd = new Date(period && period.to ? period.to : Date.now());
  const overdueActive = activeInvests.filter(i => {
    const end = i.maturity_date || i.pool_end_date;
    if (!end) return false;
    const d = new Date(end);
    return !isNaN(d.getTime()) && d < _periodEnd;
  });
  /* Newest first, but on the date each table is actually about: an active
     holding is placed by when it STARTED (which is what its Date column
     shows), a matured one by when it MATURED. Sorting both by maturity date
     put the active table in an order its own first column did not explain. */
  const _ms = v => { const d = new Date(v); return isNaN(d.getTime()) ? null : d.getTime(); };
  const _byNewest = pick => (a, b) => {
    const x = pick(a), y = pick(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;              // undated rows sort last, not first
    if (y === null) return -1;
    return y - x;
  };
  const _startMs    = i => _ms(i.start_date) ?? _ms(i.created_at);
  const _maturityMs = i => _ms(i.maturity_date) ?? _ms(i.pool_end_date);
  activeInvests.sort(_byNewest(_startMs));
  maturedInvests.sort(_byNewest(_maturityMs));

  const activeHead  = '<thead><tr><th>Date</th><th>Pool Name</th><th>Product</th><th class="num">Capital</th><th>Pool Start</th><th>Pool End</th><th>Status</th></tr></thead>';
  const maturedHead = '<thead><tr><th>Date</th><th>Pool Name</th><th>Product</th><th class="num">Capital</th><th class="num">Return</th><th class="num">Rand Return</th><th>Pool Start</th><th>Pool End</th><th>Maturity Instruction</th><th>Status</th></tr></thead>';

  const getInstr = i => {
    const raw = i.maturity_instruction || i.payout_option || '';
    return { reinvest:'Reinvest', withdraw:'Withdraw', partial_withdraw:'Partial Withdraw', rollover:'Roll Over' }[raw] || (raw ? raw.replace(/_/g,' ') : '—');
  };
  const getRate = i => {
    const r = Utils.effectiveRate(i);
    return r != null ? (r * 100).toFixed(2) + '%' : '—';
  };
  const calcRandReturn = i => {
    const principal = parseFloat(i.amount) || 0;
    const rate      = Utils.effectiveRate(i) || 0;
    const startMs   = new Date(i.start_date || i.created_at).getTime();
    const endMs     = new Date(i.maturity_date || i.pool_end_date).getTime();
    if (!principal || !rate || isNaN(startMs) || isNaN(endMs) || endMs <= startMs)
      return parseFloat(i.actual_return || i.expected_return || 0);
    const days = (endMs - startMs) / 86400000;
    return principal * rate * (days / 365);
  };

  const buildActiveRows = rows => rows.map(i => {
    const cfg  = STATUS_CFG[i.status] || { cls:'sb-pending', lbl: i.status || '' };
    const prod = PROD_LABELS[i.product_type] || i.pool_name || '—';
    return '<tr>' +
      '<td>' + fmtDate(i.start_date || i.created_at) + '</td>' +
      '<td>' + esc(i.pool_name || '—') + '</td>' +
      '<td>' + esc(prod) + '</td>' +
      '<td class="num">' + fmt(i.amount) + '</td>' +
      '<td>' + fmtDate(i.pool_start_date) + '</td>' +
      '<td>' + fmtDate(i.pool_end_date) + '</td>' +
      '<td><span class="sb ' + cfg.cls + '">' + cfg.lbl + '</span></td>' +
      '</tr>';
  }).join('');

  const buildMaturedRows = rows => rows.map(i => {
    const cfg  = STATUS_CFG[i.status] || { cls:'sb-pending', lbl: i.status || '' };
    const prod = PROD_LABELS[i.product_type] || i.pool_name || '—';
    return '<tr>' +
      '<td>' + fmtDate(i.start_date || i.created_at) + '</td>' +
      '<td>' + esc(i.pool_name || '—') + '</td>' +
      '<td>' + esc(prod) + '</td>' +
      '<td class="num">' + fmt(i.amount) + '</td>' +
      '<td class="num earn">' + getRate(i) + '</td>' +
      '<td class="num earn">' + fmt(calcRandReturn(i)) + '</td>' +
      '<td>' + fmtDate(i.pool_start_date) + '</td>' +
      '<td>' + fmtDate(i.pool_end_date) + '</td>' +
      '<td>' + esc(getInstr(i)) + '</td>' +
      '<td><span class="sb ' + cfg.cls + '">' + cfg.lbl + '</span></td>' +
      '</tr>';
  }).join('');

  const emptyActive  = '<tr><td colspan="7" class="empty-row">No active investments in this period</td></tr>';
  const emptyMatured = '<tr><td colspan="10" class="empty-row">No matured investments in this period</td></tr>';

  // Build CSV for download button
  const csvRows = [
    ['Date','Pool Name','Product','Capital','Return','Rand Return','Pool Start Date','Pool End Date','Maturity Instruction','Status']
  ].concat(investments.map(i => [
    fmtDate(i.start_date || i.created_at),
    i.pool_name || '',
    PROD_LABELS[i.product_type] || i.pool_name || '',
    parseFloat(i.amount || 0).toFixed(2),
    getRate(i),
    calcRandReturn(i).toFixed(2),
    fmtDate(i.pool_start_date),
    fmtDate(i.pool_end_date),
    getInstr(i),
    (STATUS_CFG[i.status] || {}).lbl || i.status || '',
  ]));
  const csvEsc  = v => '"' + String(v).replace(/"/g, '""') + '"';
  const csvData = csvRows.map(r => r.map(csvEsc).join(',')).join('\r\n');
  const csvB64  = btoa(unescape(encodeURIComponent(csvData)));
  const csvName = 'SVC-Statement-' + inv.id + '-' + period.from.slice(0,10) + '-to-' + period.to.slice(0,10) + '.csv';

  const activeRows  = activeInvests.length  ? buildActiveRows(activeInvests)   : emptyActive;
  const maturedRows = maturedInvests.length ? buildMaturedRows(maturedInvests) : emptyMatured;
  const aCnt = activeInvests.length;
  const mCnt = maturedInvests.length;

  const _logoUrl = window.location.origin + '/assets/sv-capital-logo-horizontal-outline-1.png';

  const html = [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="UTF-8">',
    '<title>SV Capital — Investment Statement ' + fromLabel + ' to ' + toLabel + '</title>',
    '<style>',
    '*{box-sizing:border-box;margin:0;padding:0}',
    'body{font-family:Arial,Helvetica,sans-serif;background:#fff;color:#111;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-size:12px}',
    '@page{size:A4 landscape;margin:12mm 14mm}',
    '@media print{.no-print{display:none!important}.wrap{margin-top:0!important}}',
    '.no-print{position:fixed;top:0;left:0;right:0;background:#1f2937;padding:9px 20px;display:flex;justify-content:space-between;align-items:center;z-index:99;gap:10px;flex-wrap:wrap}',
    '.no-print span{color:#fff;font-size:12px;font-weight:600;flex:1}',
    '.no-print .btn-row{display:flex;gap:8px}',
    '.no-print button{border:none;padding:7px 16px;border-radius:5px;font-size:12px;font-weight:700;cursor:pointer}',
    '.btn-print{background:#eda5ff;color:#111}.btn-csv{background:#22c55e;color:#fff}',
    '.wrap{max-width:1100px;margin:52px auto 32px;padding:24px 30px;border-top:5px solid #eda5ff}',
    '.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;border-bottom:3px solid #1f2937;margin-bottom:18px}',
    '.hdr-brand h1{font-size:17px;font-weight:800;color:#1f2937}',
    '.hdr-brand p{font-size:10px;color:#6b7280;margin-top:2px}',
    '.hdr-right{text-align:right}',
    '.stmt-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#9ca3af;margin-bottom:3px}',
    '.stmt-title{font-size:20px;font-weight:800;color:#1f2937;margin-bottom:4px}',
    '.stmt-meta{font-size:10px;color:#6b7280;line-height:1.6}',
    '.info-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px}',
    '.info-box{border:1.5px solid #e5e7eb;border-radius:7px;padding:12px 14px}',
    '.info-box-title{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:#9ca3af;margin-bottom:7px}',
    '.info-grid{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:11px}',
    '.info-grid dt{color:#6b7280;font-weight:600;white-space:nowrap}',
    '.info-grid dd{color:#111;font-weight:500}',
    '.sec-hdr{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:6px 10px;border-radius:5px;margin:18px 0 8px}',
    '.sec-hdr.active-hdr{background:#dcfce7;color:#166534;border-left:3px solid #22c55e}',
    '.sec-hdr.matured-hdr{background:#dbeafe;color:#1e40af;border-left:3px solid #3b82f6}',
    'table{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:11px}',
    'thead tr{background:#f1f5f9}',
    'th{padding:6px 8px;text-align:left;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#374151;white-space:nowrap}',
    'th.num{text-align:right}',
    'td{padding:7px 8px;border-bottom:1px solid #f1f5f9;color:#374151;vertical-align:middle}',
    'td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
    'td.earn{color:#15803d;font-weight:700}',
    'tr:last-child td{border-bottom:none}',
    '.empty-row{text-align:center;padding:18px;color:#9ca3af;background:#fafafa;font-style:italic}',
    '.sb{display:inline-block;padding:2px 7px;border-radius:3px;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}',
    '.sb-active{background:#dcfce7;color:#166534}.sb-matured{background:#dbeafe;color:#1e40af}',
    '.sb-pending{background:#fef3c7;color:#92400e}.sb-paidout{background:#f3e8ff;color:#7e22ce}',
    '.sb-cancelled{background:#f1f5f9;color:#6b7280}',
    '.note{font-size:9.5px;color:#9ca3af;margin-bottom:14px}',
    '.sec-hdr.txn-hdr{background:#f5f3ff;color:#4c1d95;border-left:3px solid #eda5ff}',
    '.txn-credit{color:#15803d;font-weight:700;text-align:right;white-space:nowrap}',
    '.txn-debit{color:#b91c1c;font-weight:700;text-align:right;white-space:nowrap}',
    '.txn-bal{font-weight:700;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}',
    '.txn-type{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;display:inline-block;padding:2px 6px;border-radius:3px;white-space:nowrap}',
    '.tt-deposit,.tt-matured_funds,.tt-return,.tt-payout,.tt-referral_bonus{background:#dcfce7;color:#166534}',
    '.tt-investment,.tt-reinvestment{background:#ede9fe;color:#4c1d95}',
    '.tt-withdrawal{background:#fee2e2;color:#991b1b}',
    '.tt-fee{background:#fef3c7;color:#92400e}',
    '.footer{border-top:1px solid #e5e7eb;padding-top:11px;font-size:9px;color:#6b7280;line-height:1.7;margin-top:8px}',
    '.footer strong{color:#374151}',
    '.stamp{display:inline-block;border:2px solid #eda5ff;color:#eda5ff;padding:4px 11px;border-radius:3px;font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-top:10px}',
    '</style></head><body>',
    '<div class="no-print">',
    '  <span>SV Capital &mdash; Investment Statement &middot; ' + esc(inv.first_name) + ' ' + esc(inv.last_name) + ' &middot; ' + fromLabel + ' &ndash; ' + toLabel + '</span>',
    '  <div class="btn-row">',
    '    <button class="btn-csv" onclick="(function(){var a=document.createElement(\'a\');a.href=\'data:text/csv;base64,' + csvB64 + '\';a.download=\'' + csvName + '\';a.click()})()">&#11123; Download CSV</button>',
    '    <button class="btn-print" onclick="window.print()">&#128438; Print / Save PDF</button>',
    '  </div>',
    '</div>',
    '<div class="wrap">',
    '  <div class="hdr">',
    '    <div class="hdr-brand">',
    '      <img src="' + _logoUrl + '" style="height:52px;width:auto;max-width:270px;object-fit:contain;display:block" alt="SV Capital">',
    '      <p style="font-size:10px;color:#6b7280;margin-top:7px">FSCA Regulated Financial Services Provider &middot; <span style="color:#eda5ff;font-weight:600">www.svcapital.co.za</span></p>',
    '    </div>',
    '    <div class="hdr-right"><div class="stmt-lbl">Document Type</div><div class="stmt-title">Investment Statement</div>',
    '    <div class="stmt-meta">Ref: <strong>' + stmtRef + '</strong><br>Period: ' + fromLabel + ' &ndash; ' + toLabel + '<br>Issued: ' + issuedAt + '</div></div>',
    '  </div>',
    '  <div class="info-row">',
    '    <div class="info-box"><div class="info-box-title">Client Details</div><dl class="info-grid">',
    '      <dt>Full Name</dt><dd>' + esc(inv.first_name) + ' ' + esc(inv.last_name) + '</dd>',
    '      <dt>Investor ID</dt><dd>' + esc(inv.id) + '</dd>',
    '      <dt>Email</dt><dd>' + esc(inv.email || '—') + '</dd>',
    '      <dt>SA ID / Passport</dt><dd>' + esc(inv.id_number || '—') + '</dd>',
    (inv.mobile ? '      <dt>Mobile</dt><dd>' + esc(inv.mobile) + '</dd>' : ''),
    (fullAddr   ? '      <dt>Address</dt><dd>' + esc(fullAddr) + '</dd>'  : ''),
    '    </dl></div>',
    '    <div class="info-box"><div class="info-box-title">Statement Details</div><dl class="info-grid">',
    '      <dt>Period From</dt><dd>' + fromLabel + '</dd>',
    '      <dt>Period To</dt><dd>' + toLabel + '</dd>',
    '      <dt>Reference</dt><dd style="font-family:monospace;font-size:10px">' + stmtRef + '</dd>',
    '      <dt>Issued</dt><dd>' + issuedAt + '</dd>',
    '      <dt>Active Pools</dt><dd>' + aCnt + '</dd>',
    '      <dt>Matured Pools</dt><dd>' + mCnt + '</dd>',
    '    </dl></div>',
    '  </div>',

    // ── Portfolio summary ──────────────────────────────────────────────
    '  <div class="sec-hdr" style="background:#f8fafc;border-left:3px solid #eda5ff">Portfolio Summary &mdash; as at ' + toLabel + '</div>',
    '  <table><tbody>',
    '    <tr><td style="padding:8px 10px;font-size:11px;color:#374151">Active investment capital' +
      (aCnt ? ' <span style="color:#9ca3af">(' + aCnt + ' investment' + (aCnt !== 1 ? 's' : '') + ')</span>' : '') +
      '</td><td class="num" style="padding:8px 10px;font-weight:700;text-align:right">' + fmtR(activeCapital) + '</td></tr>',
    '    <tr><td style="padding:8px 10px;font-size:11px;color:#374151">Wallet balance</td>' +
      '<td class="num" style="padding:8px 10px;font-weight:700;text-align:right' + (walletAtClose < 0 ? ';color:#b91c1c' : '') + '">' + fmtRSigned(walletAtClose) + '</td></tr>',
    '    <tr style="border-top:2px solid #e5e7eb;background:#fafafa"><td style="padding:9px 10px;font-size:11px;font-weight:800;color:#111827">Total portfolio value</td>' +
      '<td class="num" style="padding:9px 10px;font-weight:800;text-align:right;color:#15803d">' + fmtRSigned(portfolioTotal) + '</td></tr>',
    (mCnt
      ? '    <tr><td style="padding:8px 10px;font-size:11px;color:#6b7280">Matured in this period' +
        ' <span style="color:#9ca3af">(' + mCnt + ' investment' + (mCnt !== 1 ? 's' : '') + ')</span></td>' +
        '<td class="num" style="padding:8px 10px;text-align:right;color:#6b7280">' + fmtR(maturedCapital) +
        (maturedReturn ? ' <span style="color:#15803d">+ ' + fmtR(maturedReturn) + ' return</span>' : '') + '</td></tr>'
      : ''),
    '  </tbody></table>',
    // ── Paid in this period ────────────────────────────────────────────
    // The cash side of the period, in rands, for a client who wants the one
    // number rather than the ledger. Returns PAID and returns ACCRUED are shown
    // apart and never added: an accrual is money earned that has not been
    // handed over, and summing the two reports it twice.
    '  <div class="sec-hdr" style="background:#f8fafc;border-left:3px solid #15803d">Paid in this Period &mdash; ' + fromLabel + ' to ' + toLabel + '</div>',
    '  <table><tbody>',
    /* "Paid out to you", NOT "returns paid to you".
       A maturity payout's amount is the client's CAPITAL coming back plus the
       return on it. This row belongs to a CASH section — deposited by you,
       placed into investments, fees charged — so the figure is right; calling
       it a return told a client that R346 708 of their own capital was money
       they had earned. */
    '    <tr><td style="padding:8px 10px;font-size:11px;color:#374151">Paid out to you' +
      ' <span style="color:#9ca3af">maturity payouts (capital + return) and interest</span></td>' +
      '<td class="num" style="padding:8px 10px;font-weight:800;text-align:right;color:#15803d">' + fmtR(_n(paid.returns)) + '</td></tr>',
    '    <tr><td style="padding:8px 10px;font-size:11px;color:#374151">Deposited by you</td>' +
      '<td class="num" style="padding:8px 10px;text-align:right">' + fmtR(_n(paid.deposited)) + '</td></tr>',
    '    <tr><td style="padding:8px 10px;font-size:11px;color:#374151">Placed into investments</td>' +
      '<td class="num" style="padding:8px 10px;text-align:right">' + fmtR(_n(paid.invested)) + '</td></tr>',
    (_n(paid.fees)
      ? '    <tr><td style="padding:8px 10px;font-size:11px;color:#374151">Fees charged</td>' +
        '<td class="num" style="padding:8px 10px;text-align:right;color:#b91c1c">' + fmtR(_n(paid.fees)) + '</td></tr>'
      : ''),
    (_n(paid.accrued)
      ? '    <tr style="background:#fafafa"><td style="padding:8px 10px;font-size:11px;color:#6b7280">Returns accrued, not yet paid' +
        ' <span style="color:#9ca3af">paid at maturity</span></td>' +
        '<td class="num" style="padding:8px 10px;text-align:right;color:#6b7280">' + fmtR(_n(paid.accrued)) + '</td></tr>'
      : ''),
    '  </tbody></table>',

    (overdueActive.length
      ? '  <p class="note" style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:7px 10px;border-radius:4px">' +
        overdueActive.length + ' investment' + (overdueActive.length !== 1 ? 's are' : ' is') +
        ' still marked active although ' + (overdueActive.length !== 1 ? 'their maturity dates have' : 'its maturity date has') +
        ' passed. Check whether ' + (overdueActive.length !== 1 ? 'they have' : 'it has') +
        ' been processed before sending this statement.</p>'
      : ''),

    '  <div class="sec-hdr active-hdr">Active Pools &mdash; ' + aCnt + ' investment' + (aCnt !== 1 ? 's' : '') + '</div>',
    '  <table>' + activeHead + '<tbody>' + activeRows + '</tbody></table>',
    '  <div class="sec-hdr matured-hdr">Matured Pools &mdash; ' + mCnt + ' investment' + (mCnt !== 1 ? 's' : '') + '</div>',
    '  <table>' + maturedHead + '<tbody>' + maturedRows + '</tbody></table>',
    '  <p class="note">* Expected return shown where actual return has not yet been recorded.</p>',

    // ── Transaction ledger ─────────────────────────────────────────────
    (function() {
      /* THE BALANCES COME FROM THE SERVER.
       *
       * This block used to carry its own DEBIT_TYPES — {investment,
       * reinvestment, withdrawal, fee} — with everything else treated as a
       * credit, while the opening balance above it came from
       * services/ledger.js. The two disagreed about platform_fee, gift_sent,
       * return and every type neither listed, so the opening balance and the
       * ledger printed under it were computed by different rules and the
       * document could not tie. A platform fee INCREASED the client's balance
       * as the page went down.
       *
       * One definition now, on the server, which also anchors the closing
       * balance to the actual wallet instead of re-deriving it from history. */
      const TYPE_LABELS = {
        deposit: 'Deposit', withdrawal: 'Withdrawal', investment: 'Investment',
        reinvestment: 'Reinvestment', matured_funds: 'Matured Funds',
        return: 'Return', payout: 'Maturity Payout', fee: 'Platform Fee',
        platform_fee: 'Platform Fee', referral_bonus: 'Referral Bonus',
        interest: 'Interest', gift_sent: 'Gift Sent', gift_received: 'Gift Received',
        adjustment: 'Adjustment',
      };
      const r2 = n => Math.round((n || 0) * 100) / 100;
      const money = n => 'R ' + Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const signed = n => money(n) + (n < 0 ? ' Dr' : '');

      /* Newest first. running_balance is computed on the server in date order
         and is the balance AFTER its own transaction, so reversing the display
         leaves every row's balance correct — the closing balance simply sits
         at the top and the opening at the bottom, the way a bank statement
         reads. slice() first: this must not reorder the array the summary
         figures above were derived from. */
      const rows = transactions.slice().reverse().map(t => {
        const effect = parseFloat(t.cash_effect);
        const bal    = parseFloat(t.running_balance);
        const amt    = Math.abs(parseFloat(t.amount) || 0);
        const isDebit = effect < 0;
        /* A row with no cash effect is an ACCRUAL — a `return` posted to
           total_returns, say. It belongs on the statement and must not move the
           balance, and saying so beats printing a blank the reader has to
           guess at. */
        const isAccrual = effect === 0;
        const balColor = bal < 0 ? 'color:#b91c1c' : '';
        const label  = TYPE_LABELS[t.type] || (t.type || '').replace(/_/g, ' ');
        const desc   = (t.description || '').length > 55 ? t.description.slice(0, 55) + '…' : (t.description || '—');
        const cells = isAccrual
          ? `<td colspan="2" style="text-align:center;font-size:9px;color:#9ca3af">${money(amt)} &mdash; no cash movement</td>`
          : isDebit
            ? `<td></td><td class="txn-debit">${money(amt)}</td>`
            : `<td class="txn-credit">${money(amt)}</td><td></td>`;
        return `<tr>
          <td>${fmtDate(t.txn_date)}</td>
          <td><span class="txn-type tt-${esc(t.type || '')}">${esc(label)}</span></td>
          <td style="font-size:10px;color:#6b7280;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(desc)}</td>
          ${cells}
          <td class="txn-bal" style="${balColor}">${signed(bal)}</td>
        </tr>`;
      }).join('');
      const closingBal = r2(closing_balance);
      const openFmt  = signed(r2(opening_balance));
      const closeFmt = signed(closingBal);

      /* When the transaction history does not reproduce the wallet, say so.
       *
       * The closing balance is the client's real wallet; the opening balance is
       * that figure less the period's movement. If summing the history from the
       * beginning gives something else, rows are missing or mis-typed — most
       * often a reinvestment whose matching matured_funds credit was never
       * written. That is a data problem, and printing a confident balance over
       * it is how a client with money on deposit received a statement reading
       * R24 010,73 Dr. It is stated here instead, with the size of the gap. */
      const gapNote = (reconciles === false)
        ? `  <tr><td colspan="6" style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:9px;padding:8px 10px;line-height:1.5">` +
          `<strong>Balances are anchored to the account's wallet.</strong> Summing this account's transaction history from the beginning gives ` +
          `${signed(r2(derived_opening_balance))} as the opening figure — a difference of ${money(r2(ledger_gap))}. ` +
          `That usually means a transaction is missing or recorded under a type that carries no cash effect. ` +
          `Resolve it before sending this statement to the client.</td></tr>`
        : '';
      if (!transactions.length) return '  <div class="sec-hdr txn-hdr">Transaction Ledger — No transactions in this period</div>';
      return [
        `  <div class="sec-hdr txn-hdr">Transaction Ledger — ${transactions.length} transaction${transactions.length !== 1 ? 's' : ''}</div>`,
        '  <table>',
        '  <thead><tr><th>Date</th><th>Type</th><th>Description</th><th class="num">Credit</th><th class="num">Debit</th><th class="num">Balance</th></tr></thead>',
        '  <tbody>',
        /* Closing at the top and opening at the bottom, because the rows
           between them now run newest first. Left as they were, the opening
           balance sat above the most recent transaction and the column read
           backwards through the middle of the table. */
        `  <tr style="background:#f1f5f9;border-top:2px solid #e5e7eb"><td colspan="3" style="font-size:10px;font-weight:700;color:#374151">Closing Balance — ${toLabel}</td><td></td><td></td><td class="txn-bal" style="${closingBal < 0 ? 'color:#b91c1c' : 'color:#15803d'}">${closeFmt}</td></tr>`,
        rows,
        `  <tr style="background:#f8fafc"><td colspan="3" style="font-size:10px;font-weight:700;color:#374151">Opening Balance — ${fromLabel}</td><td></td><td></td><td class="txn-bal">${openFmt}</td></tr>`,
        gapNote,
        '  </tbody></table>',
      ].join('\n');
    })(),

    '  <div class="footer">',
    '    <strong>SV Capital (Pty) Ltd</strong> &mdash; FSCA Regulated Financial Services Provider.<br>',
    '    This investment statement is prepared for <strong>' + esc(inv.first_name) + ' ' + esc(inv.last_name) + '</strong> (Account: ' + esc(inv.id) + ') and covers the period ' + fromLabel + ' to ' + toLabel + '. All amounts are in South African Rand (ZAR).<br>',
    '    Returns marked * represent projected figures based on the pool rate; actual returns are confirmed at maturity. This document does not constitute a tax certificate.<br>',
    '    <strong>Ref:</strong> ' + stmtRef + ' &middot; <strong>Issued:</strong> ' + issuedAt + ' &middot; <strong>Generated by:</strong> SV Capital Admin Console<br>',
    '    <div class="stamp">SV Capital (Pty) Ltd &mdash; www.svcapital.co.za</div>',
    '  </div>',
    '</div>',
    '</body></html>',
  ].join('\n');

  if (arguments.length > 1 && arguments[1] === 'html') return html;
  _present(html, 1100, 900);
}

  global.SVCDocs = {
    openAccountStatement: _openAccountStatementWindow,
    openIncomeReference:  _openAdminTaxCertWindow,
    /* The same page as a string, for a surface that shows it inline. */
    accountStatementHTML: d => _openAccountStatementWindow(d, 'html'),
    incomeReferenceHTML:  d => _openAdminTaxCertWindow(d, 'html'),
    /* Preview a document inside a container, scaled to fit a phone. */
    mountScaled: _mountScaled,
    /* The width each document lays out at — the statement is A4 landscape. */
    STATEMENT_WIDTH: 1100,
    CERTIFICATE_WIDTH: 860,
  };
})(window);
