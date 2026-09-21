#!/usr/bin/env node
/* The KYC page, with a real book behind it.
 *
 * Reported as "the page lags and each action takes more than a minute, which
 * makes approving KYC documentation difficult to complete". Measured against
 * 5 000 documents and 4 600 clients, one approval took 7.5 seconds on a
 * machine far faster than anybody's laptop, and three things caused it:
 *
 *   Every row looked its client up with STATE.investors.find() — a scan of
 *   the whole book, per row, in the row map AND in the search filter. Twenty
 *   three million comparisons for one render.
 *
 *   Every render wrote all 5 000 rows into the DOM.
 *
 *   Every approval called loadKYC(), re-fetching all 5 000 documents and
 *   re-rendering all 5 000 rows in order to change one of them.
 *
 * The shipped renderKYCTable is lifted and RUN here against that many rows,
 * because the assertions worth having are about what it does at that size.
 * A regex proving the word "Map" appears still matches after the lookup goes
 * back to a scan.
 *
 * Run: node server/scripts/check-kyc-page-speed.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function slice(name) {
  let at = SRC.indexOf(`async function ${name}(`);
  if (at < 0) at = SRC.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} not found in admin/js/admin.js`);
  const end = SRC.indexOf('\n}\n', at);
  if (end < 0) throw new Error(`could not find the end of ${name}`);
  return SRC.slice(at, end + 3);
}
function sliceConst(decl, endToken) {
  const at = SRC.indexOf(decl);
  if (at < 0) throw new Error(`${decl} not found`);
  const end = SRC.indexOf(endToken, at);
  if (end < 0) throw new Error(`end of ${decl} not found`);
  return SRC.slice(at, end + endToken.length);
}

/* A book the size of the real one. */
const DOCS = 5000, CLIENTS = 4600;
const investors = Array.from({ length: CLIENTS }, (_, i) => ({
  id: `C-${i}`, first_name: `First${i}`, last_name: `Last${i}`,
  bank_name: 'Capitec', bank_account_holder: `First${i} Last${i}`,
  bank_account_number: '1234567890', bank_account_status: 'pending',
}));
const kyc = Array.from({ length: DOCS }, (_, i) => ({
  id: `K-${i}`, investor_id: `C-${i % CLIENTS}`,
  doc_type: ['id_document', 'proof_of_address', 'proof_of_bank'][i % 3],
  status: ['pending', 'approved', 'rejected', 'under_review'][i % 4],
  file_name: `doc${i}.png`, has_file_data: true,
  submitted_at: new Date(Date.now() - i * 3600e3).toISOString(),
}));

function makeEnv(filters = {}) {
  const els = {};
  const el = (id, value) => (els[id] = { id, value: value || '', innerHTML: '', textContent: '',
    checked: false, insertAdjacentHTML(_, h) { this.innerHTML += h; } });
  el('kycBody');
  el('kycStatusFilter',  filters.status  || '');
  el('kycDocTypeFilter', filters.docType || '');
  el('kycSearch',        filters.search  || '');
  ['kyc-pending', 'kyc-review', 'kyc-approved', 'kyc-rejected', 'kycBadge', 'kycSelectAll'].forEach(i => el(i));

  const sandbox = {
    document: { getElementById: id => els[id] || null, querySelectorAll: () => [] },
    STATE: { kyc, investors, subAccounts: [] },
    KYC_SORT: { key: null, dir: 'asc' },
    _kycSelected: new Set(),
    _sortRows: (_t, rows) => rows,
    _esc: v => String(v == null ? '' : v).replace(/[<>&"']/g, c =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])),
    _emptyRow: () => '<tr><td>empty</td></tr>',
    /* Stubs, enumerated from what renderKYCTable actually reaches for rather
       than discovered one crash at a time — a stub found by trial and error is
       a stub whose absence looks exactly like the defect under test. */
    Utils: { date: d => String(d || '').slice(0, 10), initials: () => 'AB',
             statusBadge: st => `<span class="badge">${st}</span>`,
             rand: n => `R ${n}`, timeAgo: () => 'just now' },
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    sliceConst('let _invIndex = null, _invIndexSrc = null;', ';') + '\n' +
    slice('_investorById') + '\n' +
    sliceConst('const KYC_RENDER_CAP =', ';') + '\n' +
    slice('renderKYCTable'), sandbox);
  /* `const` inside runInContext is lexical, not a property of the context
     object, so it has to be asked for by name rather than read off it. */
  sandbox.__cap = vm.runInContext('KYC_RENDER_CAP', sandbox);
  return { sandbox, els };
}

const rowCount = html => (html.match(/<tr[\s>]/g) || []).length;

console.log('\nit draws a bounded number of rows, however big the book');
{
  const { sandbox, els } = makeEnv();
  const t0 = Date.now();
  sandbox.renderKYCTable();
  const ms = Date.now() - t0;
  const rows = rowCount(els.kycBody.innerHTML);

  ok(`${DOCS} documents do not become ${DOCS} rows`, rows <= sandbox.__cap + 1,
     `${rows} rows drawn`);
  ok('and the cap is a sensible size', sandbox.__cap >= 100 && sandbox.__cap <= 1000,
     String(sandbox.__cap));
  /* Generous: this runs on whatever the check happens to be on. It is here to
     catch a return to the quadratic lookup, which was seconds, not to police
     milliseconds. */
  ok('and it renders quickly', ms < 900, `${ms} ms for ${DOCS} documents`);
  ok('a truncated list says so',
     /Showing the first \d+ of [\d , ]+ documents/.test(els.kycBody.innerHTML),
     'a cap nobody is told about is a list that lies about how much there is');
}

console.log('\nand the filters still see everything');
{
  /* The property that makes a cap safe. K-4000 sits far past the 300 drawn,
     and its client is C-4000 — the modulo means only documents below 4600
     have a client whose number matches their own. */
  const { sandbox, els } = makeEnv({ search: 'first4000 ' });
  sandbox.renderKYCTable();
  const html = els.kycBody.innerHTML;
  ok('a document past the cap is still findable by search', html.includes('K-4000'),
     'capping the list before filtering would hide most of the book');
  ok('and only their rows come back', rowCount(html) <= 3, `${rowCount(html)} rows`);

  const byStatus = makeEnv({ status: 'pending' });
  byStatus.sandbox.renderKYCTable();
  ok('the status filter runs over all of them too',
     !/approved|rejected/.test(byStatus.els.kycBody.innerHTML.replace(/Showing[\s\S]*/, '')),
     'a filter applied after the cap would only filter what was already drawn');
}

console.log('\nthe client lookup is indexed, not a scan per row');
{
  const { sandbox } = makeEnv();
  ok('_investorById finds one', sandbox._investorById('C-4599')?.first_name === 'First4599');
  ok('and misses gracefully', sandbox._investorById('nobody') === undefined &&
     sandbox._investorById(null) === undefined);
  /* The index has to notice when the array behind it is replaced, or the page
     shows last load's clients after a refresh. */
  sandbox.STATE.investors = [{ id: 'C-4599', first_name: 'Renamed', last_name: 'X' }];
  ok('it rebuilds when the book is replaced',
     sandbox._investorById('C-4599')?.first_name === 'Renamed',
     'a cached index would show the previous load');

  const body = slice('renderKYCTable');
  ok('and nothing in the table scans the array any more',
     !/STATE\.investors\.find\(/.test(body),
     'one scan of 4 600 clients per row is 23 million comparisons a render');
}

console.log('\nan action changes one row, not the whole page');
{
  /* rejectKyc only opens the reason dialog; _submitRejection is what writes. */
  for (const [fn, label] of [['approveKyc', 'approving'], ['_submitRejection', 'rejecting']]) {
    const src = slice(fn);
    ok(`${label} does not re-fetch every document`,
       !/await loadKYC\(\);/.test(src.replace(/catch \(e\)[\s\S]*$/, '')),
       'reloading 5 000 rows to change one of them took 7.5 seconds');
    ok(`${label} patches the row it changed`, /_kycApplyLocal\(/.test(src));
  }
  /* The one place a full reload is still right. */
  ok('but a FAILED rejection does reload',
     /catch \(e\)[\s\S]{0,400}await loadKYC\(\)\.catch/.test(slice('_submitRejection')),
     'after a failure the row’s real state is unknown, and guessing is how a screen starts lying');

  const apply = slice('_kycApplyLocal');
  ok('the patch redraws from memory, with no request',
     /renderKYCStats\(\);[\s\S]{0,60}renderKYCTable\(\);/.test(apply) && !/API\./.test(apply));
  ok('and writes the client status beside the document',
     /investorPatch/.test(apply), 'the row shows both, so both have to move together');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
