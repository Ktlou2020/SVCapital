'use strict';
/* The institutional page: live figures in, one enquiry out.
 *
 * Two rules it keeps, both of which the rest of this site learned the hard
 * way. Nothing is written into the page as markup — every value goes in as
 * text, because a pool name is typed by a person. And a figure that is not
 * available is not shown as a zero: a section with nothing behind it removes
 * itself, because "R0 returned" reads as a result and an empty table reads as
 * a fact. */

(function () {
  const rand = n => 'R' + Math.round(Number(n) || 0).toLocaleString('en-ZA');
  const pct  = n => (Number(n) * 100).toFixed(2) + '%';

  /* The strategies as the page lists them, mapped to the product types the
     platform actually stores. Solar is three products and EIF is three more;
     each row sums its own family. */
  const FAMILIES = {
    cattle:     ['cattle', 'cattle_12j'],
    solar:      ['solar', 'solar_5yr', 'solar_6yr', 'solar_7yr'],
    short_term: ['short_term', 'smme'],
    eif:        ['eif_murabaha', 'eif_ijara', 'eif_mudarabah'],
  };

  async function loadRecord() {
    let data;
    try {
      const r = await fetch('/api/products/track-record');
      if (!r.ok) return;
      data = (await r.json()).data || {};
    } catch (_) { return; }

    let paid = 0, concluded = 0;
    const perFamily = {};

    for (const [family, types] of Object.entries(FAMILIES)) {
      let fPaid = 0, fPools = 0, weighted = 0;
      for (const t of types) {
        const d = data[t];
        if (!d) continue;
        const n = Number(d.matured_count) || 0;
        fPools   += n;
        fPaid    += Number(d.total_paid_back) || 0;
        /* avg_actual_rate from this endpoint is annualised — the per-period
           figure is carried separately as period_rate. Weighted by the number
           of pools so a strategy with one pool does not count as much as one
           with ten. */
        weighted += (Number(d.avg_actual_rate) || 0) * n;
      }
      perFamily[family] = { pools: fPools, rate: fPools ? weighted / fPools : null, paid: fPaid };
      paid      += fPaid;
      concluded += fPools;
    }

    /* The headline figures, only when there is something to report. */
    if (concluded > 0) {
      const host = document.getElementById('recordFigures');
      const section = document.getElementById('record');
      const figures = [
        [rand(paid), 'capital and return paid back to investors from concluded pools'],
        [String(concluded), concluded === 1 ? 'pool concluded and settled' : 'pools concluded and settled'],
        [String(Object.values(perFamily).filter(f => f.pools > 0).length), 'strategies with a completed cycle'],
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

    /* And the per-strategy columns. A row with nothing concluded keeps its
       dash rather than being filled with a zero. */
    for (const row of document.querySelectorAll('#strategyRows tr[data-type]')) {
      const f = perFamily[row.dataset.type];
      if (!f || !f.pools) continue;
      const poolsCell = row.querySelector('[data-cell="pools"]');
      const rateCell  = row.querySelector('[data-cell="rate"]');
      if (poolsCell) poolsCell.textContent = String(f.pools);
      if (rateCell && f.rate) rateCell.textContent = pct(f.rate) + ' p.a.';
    }
  }

  /* The homepage asks who somebody is and sends them here with the answer.
     Honouring it saves them saying it twice — and an enquiry that arrives
     already labelled is one the team can read faster. Anything unrecognised
     is ignored rather than guessed at. */
  function preselectCapacity() {
    const want = new URL(window.location.href).searchParams.get('as');
    if (!want) return;
    const sel = document.getElementById('enqCapacity');
    if (!sel) return;
    const match = [...sel.options].find(o => o.value === want);
    if (match) sel.value = match.value;
  }

  function wireForm() {
    const form   = document.getElementById('enquiryForm');
    const result = document.getElementById('enqResult');
    const btn    = document.getElementById('enqSubmit');
    if (!form) return;

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const say = (text, good) => {
        result.textContent = text;
        result.className = 'in-result ' + (good ? 'in-result--ok' : 'in-result--bad');
      };

      const body = {
        name:         form.name.value.trim(),
        capacity:     form.capacity.value,
        organisation: form.organisation.value.trim(),
        role:         form.role.value.trim(),
        email:        form.email.value.trim(),
        phone:        form.phone.value.trim(),
        message:      form.message.value.trim(),
        company_website: form.company_website.value,
      };

      /* Said here as well as on the server, so a mistake is answered without
         a round trip. The server is what actually decides. */
      if (!body.name)    return say('Please tell us your name.', false);
      if (!body.email)   return say('Please give us an email address we can reply to.', false);
      if (!body.message) return say('Please tell us what you would like to discuss.', false);

      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = 'Sending…';
      try {
        const r = await fetch('/api/enquiries/institutional', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) {
          say(out.error || 'That did not send. Please email enquiry@svcapital.co.za.', false);
        } else {
          form.reset();
          say(`Thank you — your enquiry is with us, reference ${out.reference}. ` +
              'Somebody will come back to you directly.', true);
        }
      } catch (_) {
        say('That did not send. Please email enquiry@svcapital.co.za and we will pick it up.', false);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadRecord(); wireForm(); preselectCapacity();
  });
})();
