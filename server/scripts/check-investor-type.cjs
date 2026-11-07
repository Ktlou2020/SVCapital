#!/usr/bin/env node
/* What kind of client this is — individual, business, trust or group.
 *
 * The platform had no answer. investors held a natural person and nothing
 * else: entities lived as sub_accounts beneath somebody, so the console could
 * tell you a client HAD a trust without telling you the client WAS one. The
 * Firebase export has carried the answer all along in a field called
 * investorType, and the import never read it — the mapping lists name,
 * surname, kycStatus, status and a dozen more, and that one fell on the floor.
 *
 * It matters now because FICA verification differs by entity: a person is
 * checked against Home Affairs, a company against CIPC, a trust against its
 * deed and trustees. A provider integration that cannot tell them apart will
 * run an ID check against a trust's registration number.
 *
 * THE ASSERTION THAT MATTERS MOST is about a direction, not a mapping: an
 * investorType nobody recognised must become NOTHING, never 'individual'.
 * Guessing turns an imported trust into a person, silently and permanently,
 * and the next FICA run verifies it as one. An unknown is a question somebody
 * can see and close; a wrong answer is not.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-investor-type.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_invtype_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const IT = require(path.join(ROOT, 'server', 'services', 'investorType.js'));

/* ═══ 1. The rule ═══════════════════════════════════════════════════ */
console.log('\nit recognises the four kinds, however the export spells them');
{
  for (const t of ['individual', 'business', 'trust', 'group']) {
    ok(`${t} round-trips`, IT.normaliseInvestorType(t) === t);
    ok(`and ${t.toUpperCase()} does too`, IT.normaliseInvestorType(t.toUpperCase()) === t,
       'an export written by another system chose its own letter case');
  }
  const aliases = [
    ['COMPANY', 'business'], ['Pty Ltd', 'business'], ['PTY_LTD', 'business'],
    ['CLOSE_CORPORATION', 'business'], ['juristic person', 'business'],
    ['NATURAL_PERSON', 'individual'], ['Person', 'individual'],
    ['inter vivos trust', 'trust'], ['TESTAMENTARY', 'trust'],
    ['STOKVEL', 'group'], ['Savings Group', 'group'], ['investment club', 'group'],
  ];
  for (const [raw, want] of aliases) {
    ok(`"${raw}" is ${want}`, IT.normaliseInvestorType(raw) === want,
       `got ${JSON.stringify(IT.normaliseInvestorType(raw))}`);
  }
}

console.log('\nand an unknown becomes NOTHING, never a person');
{
  /* The whole point. Each of these is a plausible export value nobody has
     taught the mapper yet; every one of them must come back null. */
  for (const raw of ['PARTNERSHIP_FOREIGN', 'NPO', 'FUND', 'wizard', 'xyz', '???', '42']) {
    ok(`"${raw}" is not guessed`, IT.normaliseInvestorType(raw) === null,
       `got ${JSON.stringify(IT.normaliseInvestorType(raw))} — guessing turns an ` +
       'imported entity into a natural person and the next FICA run verifies it as one');
  }
  ok('and nothing at all is nothing', IT.normaliseInvestorType('') === null
     && IT.normaliseInvestorType(null) === null
     && IT.normaliseInvestorType(undefined) === null);
  ok('an unrecognised value reads as "Not set", not as a type',
     IT.investorTypeLabel('wizard') === 'Not set' && IT.investorTypeLabel(null) === 'Not set',
     'so a bad value written straight to the API fails to UNKNOWN rather than to a wrong kind');
}

/* ═══ 2. The browser agrees ═════════════════════════════════════════ */
console.log('\nand the console calls them the same four things the server does');
{
  const s = { console, Math, JSON, Object, Array, String, Number, Date, RegExp,
              parseFloat, parseInt, isNaN, localStorage: { getItem: () => null, setItem() {} },
              navigator: { userAgent: 'node' }, location: { href: '', origin: '' },
              document: { addEventListener() {}, getElementById: () => null },
              setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
              fetch: () => Promise.reject(new Error('no network')) };
  s.window = s; s.globalThis = s; s.self = s;
  vm.createContext(s);
  vm.runInContext(read('js/api.js'), s, { filename: 'js/api.js' });
  const U = vm.runInContext('typeof Utils !== "undefined" ? Utils : null', s);

  ok('the browser exposes the types', !!(U && U.INVESTOR_TYPES));
  ok('and they are the server\'s list exactly',
     JSON.stringify(U.INVESTOR_TYPES) === JSON.stringify(IT.INVESTOR_TYPES),
     `${JSON.stringify(U.INVESTOR_TYPES)} vs ${JSON.stringify(IT.INVESTOR_TYPES)}`);
  for (const t of IT.INVESTOR_TYPES) {
    ok(`and labels ${t} the same way`, U.investorTypeLabel(t) === IT.investorTypeLabel(t),
       `${U.investorTypeLabel(t)} vs ${IT.investorTypeLabel(t)}`);
  }
  ok('including the unset case',
     U.investorTypeLabel(null) === IT.investorTypeLabel(null),
     'a client reading "Not set" in one place and a dash in another is two answers');
}

/* ═══ 3. The import reads the field it had been dropping ════════════ */
console.log('\nthe import reads investorType and will not guess at it');
{
  const MIG = strip(read('server/scripts/migrate-from-firebase.js'));
  ok('it reads u.investorType', /normaliseInvestorType\(u\.investorType\)/.test(MIG),
     'it mapped a dozen other fields and never this one');
  ok('it writes the column', /investor_type/.test(MIG));
  ok('and a re-run does not wipe a type set by hand',
     /investor_type\s*=\s*COALESCE\(EXCLUDED\.investor_type,\s*investors\.investor_type\)/.test(MIG),
     'somebody correcting an import in the console must not lose it to the next run');
  ok('it collects what it could not map', /unmappedTypes/.test(MIG));
  ok('and NAMES those values instead of defaulting them',
     /were not recognised and were/.test(MIG) && /left UNSET rather than guessed/.test(MIG),
     'an unmapped value that silently becomes individual is the failure this exists to prevent');
}

/* ═══ 4. Against the real schema ════════════════════════════════════ */
function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool;

(async () => {
  try {
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
    const url = withDatabase(process.env.DATABASE_URL, DB_NAME);
    process.env.DATABASE_URL = url;
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
    const q = console.log; console.log = () => {};
    try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
    pool = new Pool({ connectionString: url, ssl: SSL, max: 2 });
    pool.on('error', () => {});

    console.log('\nthe column exists and does not assert a type nobody gave it');
    const { rows: [col] } = await pool.query(`
      SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_name = 'investors' AND column_name = 'investor_type'`);
    ok('investors.investor_type exists', !!col, 'nothing below can hold without it');
    ok('it is nullable', col && col.is_nullable === 'YES');
    /* A DEFAULT on ADD COLUMN backfills every existing row in one statement.
       On a book of imported clients that writes "individual" across trusts
       and companies nobody has classified yet. */
    ok('and has NO default', col && col.column_default === null,
       `default ${JSON.stringify(col && col.column_default)} — a default would ` +
       'silently call every existing client an individual');

    await pool.query(`
      INSERT INTO investors (id, first_name, last_name, email, status)
      VALUES ('IT-OLD','Legacy','Client','legacy@example.test','active')`);
    const { rows: [old] } = await pool.query(
      `SELECT investor_type FROM investors WHERE id = 'IT-OLD'`);
    ok('a row written without one stays unset', old.investor_type === null,
       JSON.stringify(old));

    console.log('\nand signup records a natural person, because that is what it creates');
    const AUTH = strip(read('server/routes/auth.js'));
    ok('the signup insert names the column', /investor_type/.test(AUTH));
    ok("and writes 'individual'", /'individual',\s*'pending',\s*'active'/.test(AUTH),
       'this form signs up a person; an entity arrives as a sub-account they open');

    console.log('\nand the console shows it per client, and lets staff fix it');
    const ADMIN = strip(read('admin/js/admin.js'));
    const HTML  = strip(read('admin/index.html'));
    ok('the clients list has a Type column',
       /data-sort="investor_type"[^>]*>Type</.test(HTML), 'this is the question that was asked');
    ok('and every row renders the badge', /<td style="overflow:hidden">\$\{typeBadge\}<\/td>/.test(ADMIN));
    ok('the client detail names it', /Investor Type<\/span>/.test(ADMIN));
    ok('it is editable, because an import can be wrong',
       /id="ipf-investor_type"/.test(ADMIN));
    ok('and saving an empty choice stores nothing rather than an empty string',
       /investor_type:\s*document\.getElementById\('ipf-investor_type'\)\.value \|\| null/.test(ADMIN),
       "'' is not the same as unknown");
    ok('the badge is built from the shared labels',
       /Utils\.investorTypeLabel/.test(ADMIN),
       'a second label table in the console is a second answer');
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (pool) await pool.end().catch(() => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
