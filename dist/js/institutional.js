'use strict';
/* How the institutional page shows the concluded-pool figures.
 *
 * The fetch, the aggregation and the enquiry form are in js/enquiry.js, which
 * this page and the private-client page both load — see the note at the top of
 * that file for why. This is only the part that is particular to an allocator
 * reading it: three figures set large, and the two numeric columns of the
 * strategy table filled in.
 *
 * The listener is registered at parse time, before enquiry.js dispatches on
 * DOMContentLoaded, which is why the script order in the page matters. The
 * event does not fire at all when no pool has concluded, so the section stays
 * display:none rather than reporting a zero.
 */

(function () {
  const rand = n => 'R' + Math.round(Number(n) || 0).toLocaleString('en-ZA');
  const pct  = n => (Number(n) * 100).toFixed(2) + '%';

  document.addEventListener('svc:track-record', e => {
    const { paid, concluded, perFamily, strategies } = e.detail;

    const host    = document.getElementById('recordFigures');
    const section = document.getElementById('record');
    if (host && section) {
      const figures = [
        [rand(paid), 'capital and return paid back to investors from concluded pools'],
        [String(concluded), concluded === 1 ? 'pool concluded and settled' : 'pools concluded and settled'],
        [String(strategies), 'strategies with a completed cycle'],
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
    }

    /* The per-strategy columns. A row with nothing concluded keeps its dash
       rather than being filled with a zero. */
    for (const row of document.querySelectorAll('#strategyRows tr[data-type]')) {
      const f = perFamily[row.dataset.type];
      if (!f || !f.pools) continue;
      const poolsCell = row.querySelector('[data-cell="pools"]');
      const rateCell  = row.querySelector('[data-cell="rate"]');
      if (poolsCell) poolsCell.textContent = String(f.pools);
      if (rateCell && f.rate) rateCell.textContent = pct(f.rate) + ' p.a.';
    }
  });
})();
