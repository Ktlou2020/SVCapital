'use strict';
/* How the private-client page shows the concluded-pool figures.
 *
 * The fetch, the aggregation and the enquiry form are in js/enquiry.js, which
 * this page and the institutional page both load — see the note at the top of
 * that file for why.
 *
 * The institutional page sets these as three tiles, which is what somebody
 * comparing managers wants. This reader is not comparing managers, they are
 * checking whether anything has actually happened, so it is said to them in
 * one sentence. The figures inside it are marked up so they can be set apart
 * typographically, and every one of them is written as text — nothing on
 * either page is rendered as markup.
 *
 * The event does not fire at all when no pool has concluded, so the section
 * stays display:none rather than saying nothing has been paid back in a
 * sentence that reads like a result.
 */

(function () {
  const rand = n => 'R' + Math.round(Number(n) || 0).toLocaleString('en-ZA');

  document.addEventListener('svc:track-record', e => {
    const { paid, concluded, strategies } = e.detail;
    const line    = document.getElementById('recordLine');
    const section = document.getElementById('returned');
    if (!line || !section) return;

    /* Built as a run of text and figures rather than a template, so the
       grammar follows the numbers instead of reading "1 pools". */
    const fig = v => {
      const s = document.createElement('span');
      s.className = 'pc-record__fig';
      s.textContent = v;
      return s;
    };
    const text = v => document.createTextNode(v);

    const parts = [
      text('Across '),
      fig(String(concluded)),
      text(concluded === 1 ? ' pool that has run its full term, ' : ' pools that have run their full term, '),
      fig(rand(paid)),
      text(' has gone back to investors as capital and return, across '),
      fig(String(strategies)),
      text(' of the four strategies.'),
    ];
    for (const p of parts) line.appendChild(p);
    section.style.display = '';
  });
})();
