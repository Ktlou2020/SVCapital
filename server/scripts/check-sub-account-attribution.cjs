#!/usr/bin/env node
/* A sub-account's money is the sub-account's.
 *
 * A sub-account invests out of ITS OWN wallet, and the database has always
 * recorded that correctly: investments.sub_account_id and
 * transactions.sub_account_id are both written, and the sub-account's wallet
 * is the one debited. The fault was entirely in the reading.
 *
 * Every list in the admin console resolved the name as
 *   investor_name || look up investor_id
 * and BOTH of those are the parent. So a minor's investment appeared as the
 * parent's, with nothing on the row to say otherwise. The portal made it
 * worse by writing the parent's name INTO transactions.investor_name on every
 * sub-account transaction ever created — so the stored value agreed with the
 * wrong answer.
 *
 * That is why the resolver reads sub_account_id FIRST, ahead of the stored
 * name: it corrects every historic row without a migration. A check that only
 * tested new rows would pass while years of records still read wrong.
 *
 * Run: node server/scripts/check-sub-account-attribution.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ADMIN  = read('admin/js/admin.js');
const PORTAL = read('portal/js/portal.js');
const CORE   = read('js/portal-core.js');
const FS     = read('server/routes/factsheets.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* The resolver, lifted out and run against the row shapes it will meet. */
function loadResolver() {
  const ctx = {
    STATE: {
      investors:   [{ id: 'PV1', first_name: 'Thandi', last_name: 'Mokoena' }],
      subAccounts: [{ id: 'SA1', parent_investor_id: 'PV1', name: 'Lesedi Mokoena', account_type: 'minor' }],
    },
    _esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  };
  ctx._investorLabel = id => {
    const i = ctx.STATE.investors.find(x => x.id === id);
    return i ? `${i.first_name} ${i.last_name}`.trim() : id;
  };
  const grab = (from, to) => ADMIN.slice(ADMIN.indexOf(from), ADMIN.indexOf(to));
  const src = grab('function _actorOf(', 'async function bulkSendLoginInvites');
  const vm = require('vm');
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

console.log('\nwhose money it is');
{
  const ctx = loadResolver();

  const sub = { investor_id: 'PV1', sub_account_id: 'SA1', investor_name: 'Thandi Mokoena' };
  const a = ctx._actorOf(sub);
  ok('a sub-account row names the SUB-ACCOUNT', a.name === 'Lesedi Mokoena', `got ${a.name}`);
  ok('even though the stored name says the parent',
     sub.investor_name === 'Thandi Mokoena' && a.name !== sub.investor_name,
     'the portal wrote the parent onto every sub-account transaction ever made');
  ok('and the parent stays on the row, so it is traceable',
     a.parentName === 'Thandi Mokoena' && a.isSub === true);
  ok('on one line it reads as both',
     ctx._actorLine(sub) === 'Lesedi Mokoena (sub-account of Thandi Mokoena)',
     ctx._actorLine(sub));

  const parent = { investor_id: 'PV1', investor_name: 'Thandi Mokoena' };
  ok('a parent row is unchanged',
     ctx._actorOf(parent).name === 'Thandi Mokoena' && ctx._actorOf(parent).isSub === false);
  ok('and still resolves with no stored name',
     ctx._actorOf({ investor_id: 'PV1' }).name === 'Thandi Mokoena');

  /* A sub-account the console has not loaded must not silently become the
     parent — that is the original bug wearing a different hat. */
  const orphan = ctx._actorOf({ investor_id: 'PV1', sub_account_id: 'SA-GONE' });
  ok('an unknown sub-account is still marked as one, not folded into the parent',
     orphan.isSub === true && orphan.name !== 'Thandi Mokoena', JSON.stringify(orphan.name));

  ok('the cell escapes the names it renders',
     ctx._actorCell({ investor_id: 'PV1', sub_account_id: 'SA1' }).includes('Lesedi Mokoena')
     && !/<script/i.test(ctx._actorCell({ investor_id: 'PV1', sub_account_id: 'SA1' })));
}

console.log('\nthe console reads it everywhere, not in one place');
{
  ok('sub_account_id is checked before the stored name',
     /const saId = row && row\.sub_account_id;[\s\S]{0,200}if \(saId\)/.test(ADMIN),
     'trusting investor_name keeps every past row wrong');
  /* Scoped to the RENDERERS. Inside _actorOf itself the same expression is
     correct — that is the branch for a row with no sub-account — so a scan of
     the whole file flags the fix as the bug. */
  {
    const resolverStart = ADMIN.indexOf('function _actorOf(');
    const resolverEnd   = ADMIN.indexOf('async function bulkSendLoginInvites');
    const renderers = ADMIN.slice(0, resolverStart) + ADMIN.slice(resolverEnd);
    ok('and no row renderer still falls back to investor_name alone',
       !/investor_name \|\| _investorLabel\(/.test(renderers)
       && !/\$\{_esc\(inv\.investor_name \|\| inv\.investor_id\)\}/.test(renderers)
       && !/\$\{_esc\(t\.investor_name \|\| t\.investor_id\)\}/.test(renderers),
       'one missed site is a screen that still names the parent');
  }
  /* Named sites, not a count. A count passes while one screen quietly goes
     back to naming the parent, which is the whole bug. */
  {
    const uses = (from, to, what) => {
      const i = ADMIN.indexOf(from);
      const seg = i === -1 ? '' : ADMIN.slice(i, ADMIN.indexOf(to, i) === -1 ? i + 2500 : ADMIN.indexOf(to, i));
      return new RegExp(what).test(seg);
    };
    ok('recent investments resolve through it',
       uses('function renderRecentInvestments', '\n}', '_actorCell\\('));
    ok('the pool investor list resolves through it',
       /const name = _actorLine\(i\);/.test(ADMIN),
       'this one named the parent on every sub-account holding in a pool');
    ok('the maturity list resolves through it',
       /const name  = _actorLine\(i\);/.test(ADMIN));
    ok('and the export resolver does too',
       /return t \? _actorLine\(t\) : id;/.test(ADMIN));
  }
  ok('the markup cell is not escaped a second time',
     !/_esc\(_actorCell\(/.test(ADMIN),
     'escaping it prints the markup as text');
}

console.log('\nthe sub-account screen shows what is behind its numbers');
{
  ok('investments are listed, not just counted',
     /const saInvRows = \(STATE\.investments \|\| \[\]\)[\s\S]{0,120}sub_account_id === sa\.id/.test(ADMIN));
  ok('and so are the transactions',
     /const saTxnRows = \(STATE\.transactions \|\| \[\]\)[\s\S]{0,120}sub_account_id === sa\.id/.test(ADMIN));
  ok('both are rendered',
     /Investments \(\$\{saInvRows\.length\}\)/.test(ADMIN)
     && /Transactions \(\$\{saTxnRows\.length\}\)/.test(ADMIN),
     'counting them and listing nothing is what the screen did before');
  ok('an empty one says so rather than showing a blank panel',
     /has not invested yet/.test(ADMIN) && /Nothing has moved through this sub-account yet/.test(ADMIN));
  ok('the money moves the same way it does on a statement',
     /\['withdrawal','investment','reinvestment','fee','platform_fee','gift_sent'\]\.includes\(t\.type\)/.test(ADMIN),
     'a second sign rule is a second answer to which way the money went');
}

console.log('\nthe portal stops writing the wrong name');
{
  ok('a sub-account transaction carries the sub-account’s name',
     /const _actorName = _pmSaId/.test(PORTAL)
     && /investor_name:\s*_actorName/.test(PORTAL),
     'this sent the parent on every sub-account transaction');
  ok('and falls back to the parent when the sub-account cannot be resolved',
     /\?\?|\|\|/.test(PORTAL.slice(PORTAL.indexOf('const _actorName'), PORTAL.indexOf('await API.transactions.create'))),
     'a missing name must not write undefined');
  ok('the portal files BOTH the investment and the transaction against it',
     (PORTAL.match(/sub_account_id:\s*_pmSaId \|\| undefined/g) || []).length >= 2,
     'the id is what every reader resolves from — one of the two is not enough');
  ok('and the client’s own sub-account view filters on that id',
     /sub_account_id === sa\.id/.test(CORE));
}

console.log('\na factsheet filed under the wrong month can be corrected');
{
  /* The period was write-once: settable on upload and nowhere else. The upload
     form carries a period field, so editing it there and pressing the button
     looked like a correction and was not — it did nothing without a file, and
     made a SECOND copy with one. */
  ok('there is a route to change it',
     /router\.patch\('\/:id', requireAuth, requireRole\('admin', 'director'\)/.test(FS));
  ok('a bad period is refused rather than stored',
     /period_date must be a date, as YYYY-MM-DD/.test(FS));
  ok('a blank clears it, for a document that is not a monthly sheet',
     /req\.body\.period_date === null \|\| req\.body\.period_date === ''/.test(FS));
  ok('a house-pattern name follows the period',
     /const wasCanonical = existing\.file_name === canonicalName\(existing\.period_date\)/.test(FS),
     'otherwise "April 2026 - Factsheet" sits filed under September');
  ok('and a name somebody chose is left exactly as typed',
     /if \(wasCanonical && next\) put\('file_name', next\)/.test(FS));
  ok('the FILE is never touched',
     !/file_url/.test(FS.slice(FS.indexOf("router.patch('/:id'"), FS.indexOf('/* DELETE /api/factsheets/:id */'))),
     'the bytes behind an id must stay the bytes somebody read under that id');
  ok('an empty name is refused', /Give the factsheet a name/.test(FS));
  ok('a change with nothing in it is refused', /Nothing to change/.test(FS));
  ok('and the edit is audited', /action:\s*'factsheet\.update'/.test(FS));
  ok('a failed upload now leaves a trace',
     /\[factsheets\] upload failed:/.test(FS),
     'it answered 500 and logged nothing, so "Upload failed" was all anyone had');
  ok('the console offers the edit on each sheet',
     /editFactsheetMeta\('\$\{s\.id\}','\$\{poolId\}'\)/.test(ADMIN));
  ok('and says plainly that the PDF is not replaced',
     /The PDF itself is not changed/.test(ADMIN));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
