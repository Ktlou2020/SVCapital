'use strict';
/* What the institutional and private-client pages have in common.
 *
 * There are two pages now, written for two different readers, and they share
 * exactly two mechanisms: the concluded-pool figures they both quote, and the
 * enquiry form they both end with. Both were written once for the
 * institutional page and both are the kind of thing that drifts the moment
 * there is a second copy — and the map below says WHICH of the platform's
 * product types belong to the book these pages describe. A second copy of
 * that on another page is how one of them quietly starts reporting a
 * different number from the other.
 *
 * So the data and the form live here, and each page keeps only its own way of
 * SHOWING the figures: the institutional page sets them as tiles, the
 * private-client page says them in a sentence. The totals arrive on a
 * `svc:track-record` event, which a page listens for if it has something to
 * do with them and ignores if it does not.
 *
 * Two rules carried over unchanged. Nothing goes into a page as markup — a
 * pool name is typed by a person. And a figure that is not available is not
 * shown as a zero: this file does not dispatch at all when nothing has
 * concluded, because "R0 returned" reads as a result rather than an absence.
 */

(function () {
  /* CATTLE ONLY, and that is the point rather than an oversight.
     These two pages present one business — asset-backed lending against
     commercial livestock — and the platform runs other product types that
     have nothing to do with it. Summing the lot and calling the total a
     track record would attribute somebody else's book to this one, which
     on a page quoting a nine-year record in cattle is the misstatement
     that matters most.

     Two stored types, because a cattle pool can be written under the
     Section 12J wrapper and both are the same lending. */
  const FAMILIES = {
    cattle: ['cattle', 'cattle_12j'],
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

    /* Nothing concluded, nothing said. */
    if (concluded <= 0) return;

    document.dispatchEvent(new CustomEvent('svc:track-record', {
      detail: { paid, concluded, perFamily },
    }));
  }

  /* The home page asks who somebody is and sends them on with the answer.
     Honouring it saves them saying it twice — and an enquiry that arrives
     already labelled is one the team can read faster. Anything unrecognised
     is ignored rather than guessed at, and each page's own first option is
     what an unlabelled arrival gets. */
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
      /* Each page styles its own result line, so the class prefix comes off
         the element rather than being hardcoded to one page's stylesheet. */
      const say = (text, good) => {
        const base = result.dataset.base || 'in-result';
        result.textContent = text;
        result.className = `${base} ${base}${good ? '--ok' : '--bad'}`;
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
