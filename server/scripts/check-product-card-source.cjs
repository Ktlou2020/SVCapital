#!/usr/bin/env node
/* A product card says what the admin console holds, not what somebody typed.
 *
 * Every figure on the landing page's product cards was written into
 * index.html by hand. The "View Details" modal behind each one has read the
 * product record for a long time — label, description, minimum, term — so a
 * product edited in the console changed its detail view and left the card in
 * front of it saying something else. The EIF cards were still offering a
 * R500 minimum months after all three products moved to R100 000, and
 * nothing on the page was wrong enough for anyone to notice.
 *
 * Two halves, and the second is why this is a check and not a commit message:
 *
 *   · the card takes label, description, minimum, term and — where there is
 *     no achieved average to prefer — the target rate, from the product;
 *   · a product the API does not carry leaves the markup ALONE. An absent
 *     field must not blank a card. That is what keeps the page readable when
 *     the API is unreachable, and it is the half a careless rewrite breaks.
 *
 * The updater is lifted out of main.js and run against a stand-in DOM, so
 * this tests the code that ships rather than a description of it.
 *
 * Run: node server/scripts/check-product-card-source.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ── A DOM just big enough for the block under test ─────────────── */
function El(tag, cls, text) {
  return {
    tag, cls: cls || '', textContent: text || '', style: {}, children: [],
    querySelector(sel) { return this.find(sel)[0] || null; },
    querySelectorAll(sel) { return this.find(sel); },
    find(sel) {
      const want = sel.replace(/^\./, '');
      const out = [];
      for (const c of this.children) {
        if (c.cls.split(/\s+/).includes(want)) out.push(c);
        out.push(...c.find(sel));
      }
      return out;
    },
    add(c) { this.children.push(c); return c; },
  };
}

function makeCard({ title, desc, rate, min, term, rateLabel = 'Target Share' }) {
  const card = El('article', 'product-card');
  card.add(El('h3', 'product-card__title', title));
  card.add(El('p', 'product-card__desc', desc));
  const stats = card.add(El('div', 'product-card__stats'));
  const mk = (label, value, gold) => {
    const st = stats.add(El('div', 'stat'));
    st.add(El('span', 'stat__label', label));
    st.add(El('span', 'stat__value' + (gold ? ' stat__value--gold' : ''), value));
  };
  mk(rateLabel, rate, true); mk('Min. Invest', min); mk('Term', term);
  return card;
}

/* ── The code that ships, lifted ────────────────────────────────── */
function lift(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const i = src.indexOf('    if (prod) {\n      const card = document.querySelector');
  const j = src.indexOf('    // 2) Apply API color', i);
  if (i === -1 || j === -1) return null;
  return src.slice(i, j);
}

function render(block, { key = 'eif_murabaha', prod, rate = null, card }) {
  const ctx = {
    document: { querySelector: sel =>
      (new RegExp(`\\[data-product="${key}"\\]`).test(sel) ? card : null) },
    key, prod, rate, parseFloat, console,
    fmtR: n => 'R' + Number(n || 0).toLocaleString('en-ZA'),
  };
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  /* toLocaleString('en-ZA') separates thousands with a NON-BREAKING space,
     which renders identically and compares unequal. Normalised here rather
     than written into the expectation, so the assertion stays readable. */
  const flat = v => String(v == null ? '' : v).replace(/\u00a0/g, ' ');
  const read = re => {
    const st = card.querySelectorAll('.stat')
      .find(s => re.test(s.querySelector('.stat__label').textContent));
    return st ? st.querySelector('.stat__value').textContent : null;
  };
  return {
    title: flat(card.querySelector('.product-card__title').textContent),
    desc:  flat(card.querySelector('.product-card__desc').textContent),
    rate:  flat(read(/share|return/i)), min: flat(read(/min/i)), term: flat(read(/term/i)),
  };
}

for (const file of ['js/main.js', 'mobile/src/js/main.js']) {
  console.log(`\n${file}`);
  const block = lift(file);
  ok('the card updater is there to be run', !!block,
     'it is lifted by its opening line — if that moved, this check is testing nothing');
  if (!block) continue;

  const STALE = { title: 'Murabaha Trade Finance', desc: 'hand-written copy',
                  rate: '11.50%', min: 'R500', term: '6 mo' };
  const PROD  = { label: 'Murabaha Trade Finance',
                  description: 'SV Capital buys goods a business needs and sells them on at a mark-up.',
                  min_investment: 100000, term_months: 6, benchmark_rate: 0.0925 };

  {
    const out = render(block, { prod: PROD, card: makeCard(STALE) });
    ok('the minimum comes from the product record', out.min === 'R100 000', out.min);
    ok('and the description with it', /sells them on at a mark-up/.test(out.desc), out.desc);
    ok('and the title', out.title === 'Murabaha Trade Finance', out.title);
    ok('the target rate is the product’s when nothing has been achieved yet',
       out.rate === '9.25%', out.rate);
  }

  {
    /* An achieved average is written by the block before this one, so this
       must not overwrite it with the target. */
    const out = render(block, { prod: PROD, rate: 0.0932, card: makeCard({ ...STALE, rate: '9.32%' }) });
    ok('an achieved average is left alone', out.rate === '9.32%', out.rate);
  }

  {
    const out = render(block, { prod: null, card: makeCard(STALE) });
    ok('a product the API does not carry leaves the card untouched',
       out.min === 'R500' && out.rate === '11.50%' && out.desc === 'hand-written copy',
       JSON.stringify(out));
  }

  {
    const out = render(block, { prod: { label: 'Murabaha Trade Finance' }, card: makeCard(STALE) });
    ok('and a field it does not carry is not blanked',
       out.min === 'R500' && out.term === '6 mo' && out.desc === 'hand-written copy',
       JSON.stringify(out));
  }

  {
    /* Solar is three products behind one card, so its term is a range the
       card states for itself — the same exception the modal already makes. */
    const out = render(block, { key: 'solar', prod: { ...PROD, term_months: 84 },
                                card: makeCard({ ...STALE, term: '5 / 6 / 7 yrs' }) });
    ok('solar keeps the term range its own card states', out.term === '5 / 6 / 7 yrs', out.term);
  }
}

console.log('\nand the markup a client reads before the API answers is not a wrong figure');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const setup = fs.readFileSync(path.join(ROOT, 'server', 'db', 'setup.js'), 'utf8');
  const block = (setup.match(/const EIF_PRODUCTS = \[[\s\S]*?\n\];/) || [''])[0];
  const mins = [...block.matchAll(/product_type: '(eif_\w+)'[\s\S]*?min_investment: (\d+)/g)];
  ok('EIF_PRODUCTS still names a minimum for each', mins.length === 3, String(mins.length));
  for (const [, type, min] of mins) {
    const i = html.indexOf(`data-product="${type}"`);
    const card = i === -1 ? '' : html.slice(i, html.indexOf('</article>', i));
    const want = 'R' + Number(min).toLocaleString('en-US');
    ok(`${type}: the card's own minimum matches the product`, card.includes(want),
       `card does not say ${want} — on a slow connection this is the figure that is read`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
