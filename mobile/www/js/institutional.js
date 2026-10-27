'use strict';
/* How the institutional page shows what the cattle book has repaid.
 *
 * The fetch, the aggregation and the enquiry form are in js/enquiry.js, which
 * this page and the private-client page both load — see the note at the top of
 * that file for why, including why the figures cover cattle and nothing else.
 *
 * This is only the part particular to an allocator reading it: three figures,
 * set large. The strategy table that used to sit beside them is gone with the
 * other asset classes; one line of business does not need a table to compare
 * itself against.
 *
 * The listener is registered at parse time, before enquiry.js dispatches on
 * DOMContentLoaded, which is why the script order in the page matters. The
 * event does not fire at all when no pool has concluded, so the section stays
 * display:none rather than reporting a zero.
 */

(function () {
  const rand = n => 'R' + Math.round(Number(n) || 0).toLocaleString('en-ZA');

  document.addEventListener('svc:track-record', e => {
    const { paid, concluded } = e.detail;

    const host    = document.getElementById('recordFigures');
    const section = document.getElementById('record');
    if (!host || !section) return;

    const figures = [
      [rand(paid), 'capital and return repaid to lenders from pools that have closed out'],
      [String(concluded), concluded === 1 ? 'pool run to term and settled'
                                          : 'pools run to term and settled'],
      ['9 years', 'lending in the cattle market, since the first pool'],
    ];
    for (const [val, label] of figures) {
      const wrap = document.createElement('div');
      wrap.className = 'in-figure';
      const v = document.createElement('div');
      v.className = 'in-figure__val';
      v.textContent = val;
      const l = document.createElement('div');
      l.className = 'in-figure__label';
      l.textContent = label;
      wrap.appendChild(v); wrap.appendChild(l);
      host.appendChild(wrap);
    }
    section.style.display = '';
  });
})();
