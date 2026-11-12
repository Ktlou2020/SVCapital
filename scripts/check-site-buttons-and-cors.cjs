#!/usr/bin/env node
/* Two things reported on the landing pages.
 *
 * THE FORM FAILED. "CORS: origin https://www.platform.svcapital.co.za not
 * allowed" under the contact form. That host serves the same pages as
 * platform.svcapital.co.za, which IS allowed — the www. prefix was the
 * whole difference, and an enquiry from a real prospect was lost to it.
 *
 * The fix adds the www. twin of each origin already allowed BY NAME, and
 * nothing else. A pattern like *.svcapital.co.za would be shorter and would
 * make any subdomain — including one somebody else came to control — an
 * allowed origin with credentials. Both halves are asserted: the twin is
 * accepted, and the wildcard it is not does not creep in.
 *
 * THE BUTTONS DISAGREED. "Ensure that button shapes are consistent across
 * the entire website and all landing pages… some are square, some have
 * rounded edges." They were 10px on the institutional page, 2px on the
 * private-client page, and --radius (14px) on the main site: the same call
 * to action, three shapes.
 *
 * Run: node scripts/check-site-buttons-and-cors.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ── The origin rule, RUN rather than read ───────────────────────────── */
console.log('\nthe www. twin of an allowed origin is allowed');
{
  /* The real list and the real matcher, lifted out of server/index.js and
     evaluated — a hand-written copy of the rule would be a check of the
     copy. ALLOWED_ORIGINS is left unset so the production defaults apply,
     which is the list the live site falls back to. */
  const SRC = read('server/index.js');
  const from = SRC.indexOf('const ALLOWED_ORIGINS =');
  const to   = SRC.indexOf('app.use(cors(');
  ok('the CORS block was found', from > 0 && to > from,
     'a slice that missed it would assert nothing while passing');

  const vm = require('vm');
  const ctx = { process: { env: { NODE_ENV: 'production' } }, URL, console: { info() {} } };
  ctx.IS_PROD = true;
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(from, to) + '\nthis.O = EFFECTIVE_ORIGINS;', ctx);
  const O = ctx.O;

  ok('the canonical platform host is allowed',
     O.includes('https://platform.svcapital.co.za'), JSON.stringify(O));
  ok('AND ITS www. TWIN, which is the origin that was refused',
     O.includes('https://www.platform.svcapital.co.za'),
     JSON.stringify(O) + ' — this is the exact origin in the reported error');
  ok('the apex and its www. twin are both allowed',
     O.includes('https://svcapital.co.za') && O.includes('https://www.svcapital.co.za'),
     JSON.stringify(O));
  /* The bound. Adding a twin per named origin is not the same as opening
     the domain, and the difference is the whole safety of the change. */
  ok('but an unrelated subdomain is NOT allowed',
     !O.includes('https://anything.svcapital.co.za')
     && !O.some(o => o.includes('*')),
     JSON.stringify(O) + ' — a wildcard would make a subdomain somebody else '
     + 'controls an allowed origin, with credentials');
  ok('and nor is a lookalike domain',
     !O.includes('https://svcapital.co.za.evil.test')
     && !O.includes('https://wwwsvcapital.co.za'));
  /* The https-only guard, tested where it actually bites. The first version
     of this asserted that `http://www.platform…` is absent — a string the
     code never produces either way, so removing the guard changed nothing
     it could see. What removing it DOES do is mint a twin from the native
     app origins: http://localhost becomes https://www.localhost, a host
     nobody owns, allowed with credentials.

     So: every www. origin in the list must be the twin of an https origin
     that is also in the list. That holds the rule rather than one example
     of it. */
  const twins = O.filter(o => { try { return new URL(o).hostname.startsWith('www.'); }
                                catch (_) { return false; } });
  ok('some www twins were minted, so this is not passing on an empty set',
     twins.length >= 2, JSON.stringify(twins));
  const orphan = twins.filter(o => {
    const u = new URL(o);
    return u.protocol !== 'https:'
      || !O.includes(`https://${u.hostname.replace(/^www\./, '')}`);
  });
  ok('and every one is the twin of an https origin that is itself allowed',
     orphan.length === 0,
     JSON.stringify(orphan) + ' — http://localhost must not become '
     + 'https://www.localhost, a host nobody owns');
  /* The https guard, tested against a config where it actually bites.

     With the shipped origin list it cannot be observed at all: the only
     http:// origin is localhost, and https://localhost is allowed anyway,
     so removing the guard changes nothing visible. That is a property of
     today's config, not of the rule — the day an http origin for a real
     host is configured, dropping the guard would mint an https twin of it
     and allow an origin nobody asked for. So the rule is run against such
     a config here rather than left untested until it matters. */
  {
    const c2 = { process: { env: { NODE_ENV: 'production',
                   ALLOWED_ORIGINS: 'http://legacy.example.test,https://keep.example.test' } },
                 URL, console: { info() {} } };
    c2.IS_PROD = true;
    vm.createContext(c2);
    vm.runInContext(SRC.slice(from, to) + '\nthis.O = EFFECTIVE_ORIGINS;', c2);
    ok('an http origin is carried through as configured',
       c2.O.includes('http://legacy.example.test'), JSON.stringify(c2.O));
    ok('but NO https twin is minted from it',
       !c2.O.includes('https://www.legacy.example.test')
       && !c2.O.includes('https://legacy.example.test'),
       JSON.stringify(c2.O) + ' — upgrading an http origin to https, or '
       + 'minting a www twin of it, allows an origin nobody configured');
    ok('while an https origin still gets its twin',
       c2.O.includes('https://www.keep.example.test'), JSON.stringify(c2.O));
  }

  /* Capacitor's http://localhost must survive untouched. */
  ok('and the native app origins are still there',
     ['capacitor://localhost', 'http://localhost'].every(o => O.includes(o)),
     JSON.stringify(O) + ' — the phone apps post from these');
}

/* ── One button shape ────────────────────────────────────────────────── */
console.log('\nand a button is the same shape on every page');
{
  const MAIN = strip(read('css/style.css'));
  const INST = strip(read('css/institutional.css'));
  const PC   = strip(read('css/private-clients.css'));

  /* The main site's scale is the reference: .btn takes var(--radius). */
  const radius = (MAIN.match(/--radius:\s*([0-9]+)px/) || [])[1];
  ok('the main site declares a button radius', !!radius, radius);
  ok('and .btn uses it', /\.btn\s*\{[^}]*border-radius:\s*var\(--radius\)/.test(MAIN),
     'if .btn stopped using it, the landing pages would be matching nothing');

  const btnRadius = (css, sel) => {
    const m = new RegExp(sel.replace('.', '\\.') + '\\s*\\{[^}]*border-radius:\\s*([0-9]+)px')
      .exec(css);
    return m ? m[1] : null;
  };
  const inst = btnRadius(INST, '.in-btn');
  const pc   = btnRadius(PC, '.pc-btn');
  ok('the institutional page\'s button matches it',
     inst === radius, `${inst}px vs the site's ${radius}px`);
  ok('and the private-client page\'s does too',
     pc === radius, `${pc}px vs the site's ${radius}px`);
  ok('so all three agree', inst === pc && pc === radius,
     `site ${radius} · institutional ${inst} · private clients ${pc} — `
     + 'the same call to action had three shapes');

  /* Form fields on those pages were 9px and 2px. They are not buttons, but
     a 2px field beside a 14px button is the same complaint one line down.
     Read from the field rule's own selector: the first version of this
     built a regex badly and reported "opx", a number it had read from
     nowhere — an assertion failing on a value it invented. */
  const fieldRadius = (css, sel) => {
    const at = css.indexOf(sel);
    if (at < 0) return null;
    const m = /border-radius:\s*([0-9]+)px/.exec(css.slice(at, css.indexOf('}', at)));
    return m ? Number(m[1]) : null;
  };
  for (const [name, css, sel] of [['institutional', INST, '.in-field input'],
                                  ['private clients', PC, '.pc-field input']]) {
    const r = fieldRadius(css, sel);
    ok(`${name} form fields were found`, r !== null, sel);
    ok(`and ${name} fields are not square against a rounded button`,
       r !== null && r >= 6, `${r}px`);
  }
}

/* ── And the pages still say what they said ──────────────────────────── */
console.log('\nand the hero gives its buttons room');
{
  const INST = strip(read('css/institutional.css'));
  const m = /\.in-hero__actions\s*\{([^}]*)\}/.exec(INST);
  ok('the hero actions rule was found', !!m, 'nothing to measure otherwise');
  const mb = m && /margin-bottom:\s*([0-9]+)px/.exec(m[1]);
  ok('the paragraph under them does not start against them',
     !!mb && Number(mb[1]) >= 20,
     (m && m[1].trim()) + ' — they ran together and the buttons lost their weight');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
