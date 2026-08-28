#!/usr/bin/env node
/* An investor must not be able to store markup that the admin console renders.
 *
 * The chain that existed:
 *
 *   1. PATCH /api/tables/investors/:id — `investors` is not in
 *      ADMIN_WRITE_TABLES, and it IS in INVESTOR_COLS keyed on `id`, so an
 *      investor passes the ownership check on their own row.
 *   2. first_name, last_name and email were not in INVESTOR_PROTECTED_COLS,
 *      and that endpoint applies no sanitisation at all. The stripHtml in
 *      auth.js guards signup, not this route — sign up clean, then PATCH.
 *   3. admin.js built innerHTML from those fields unescaped, in a session that
 *      can reach manual credit, bulk KYC approval and the pool remap.
 *
 * The fix is sanitisation, not blocking — because blocking was wrong. Both
 * portals' Edit Profile does send first_name and last_name, so refusing those
 * columns would have made the PATCH succeed while silently dropping the names,
 * which to the investor looks like it saved. An earlier draft of this fix did
 * exactly that; the assertion about the portal below is what caught it.
 *
 * So every non-privileged write has its text stripped of markup, and only the
 * two columns nothing sends — email and id_number, a login field and a KYC
 * field — are refused outright.
 *
 * Deliberately touches no database. The suite shares one scratch database and
 * several checks rebuild its schema to suit themselves — investors goes from
 * 62 columns to 0 to 4 as they run. An earlier version of this file called the
 * same ensureSchema helper the others use, which recreated the full schema
 * mid-sequence and broke the two maturity checks that follow it. Nothing here
 * needs a database anyway: what is asserted is which columns the write paths
 * refuse, and whether the render site escapes.
 *
 * Run: node server/scripts/check-investor-text-writes.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'tables.js'), 'utf8');
const ADM  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* Comments stripped before matching, so an explanation of the old behaviour
   cannot satisfy an assertion about the new one. */
const decomment = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

(async () => {
  try {
    console.log('\nthe write paths are closed at source');
    {
      const code = decomment(SRC);
      ok('a stripMarkup helper exists', /const stripMarkup = v =>/.test(code));
      ok('tags are removed, not entity-encoded',
         /replace\(\/<\[\^>\]\*>\/g, ''\)/.test(code),
         'encoding on write would double up against escaping at render, showing &amp;lt; to the operator');
      ok('bare angle brackets go too', /replace\(\/\[<>\]\/g, ''\)/.test(code));
      ok('applied on every write path, not just PATCH',
         (code.match(/for \(const k of Object\.keys\(body\)\) body\[k\] = stripMarkup\(body\[k\]\)/g) || []).length === 3,
         'POST, PUT and PATCH all reach these columns');
      ok('admin-authored text is left alone',
         /if \(!isPrivileged\) \{[\s\S]{0,300}?stripMarkup/.test(code),
         'templates and product copy may legitimately contain markup');
    }

    console.log('\nstripMarkup actually neutralises a payload');
    {
      /* Run the shipped helper rather than trust its regex by eye. */
      const at = SRC.indexOf('const stripMarkup = v =>');
      const strip = eval('(' + SRC.slice(SRC.indexOf('v =>', at), SRC.indexOf(';', at)) + ')');

      ok('a script tag stops being a tag',
         !/<script/i.test(strip('<script>alert(1)</script>')), strip('<script>alert(1)</script>'));
      ok('an image with an onerror handler stops being an element',
         !/[<>]/.test(strip('<img src=x onerror=alert(1)>')), strip('<img src=x onerror=alert(1)>'));
      ok('an unclosed tag cannot survive as a bracket either',
         !/[<>]/.test(strip('<div')), strip('<div'));
      ok('and a normal name is untouched',
         strip('Thandi Mokoena') === 'Thandi Mokoena');
      ok('an apostrophe survives, because O\'Brien is a name and not an attack',
         strip("O'Brien") === "O'Brien",
         'the render side escapes quotes; stripping them here would corrupt real data');
      ok('non-strings pass through unharmed',
         strip(42) === 42 && strip(null) === null && strip(true) === true,
         'a numeric amount or a boolean flag must not become a string');
    }

    console.log('\nthe identity columns are actually in the protected set');
    {
      /* Read the set itself, with comments removed — the fix carries a comment
         naming these columns, which a naive grep would match. */
      const at  = SRC.indexOf('const INVESTOR_PROTECTED_COLS = new Set([');
      ok('the set was found', at > -1);
      const body = decomment(SRC.slice(at, SRC.indexOf(']);', at)));
      for (const col of ['email', 'id_number']) {
        ok(`${col} is protected`, new RegExp(`'${col}'`).test(body), body.replace(/\s+/g, ' ').slice(0, 200));
      }
      /* And these are deliberately NOT protected. Blocking them would break
         Edit Profile in both portals — the PATCH would succeed while silently
         dropping the names. They are the fields the XSS came through, so they
         are covered by stripMarkup instead: the markup goes, the feature stays. */
      for (const col of ['first_name', 'last_name']) {
        ok(`${col} stays writable, because the portal saves it`,
           !new RegExp(`'${col}'`).test(body),
           'blocking it would silently break Edit Profile');
      }
      ok('and the money and status columns are still there',
         /'wallet_balance'/.test(body) && /'fica_status'/.test(body) &&
         /'kyc_status'/.test(body) && /'total_invested'/.test(body),
         'the new entries must not have displaced the old');
    }

    console.log('\nownership alone was never a guard here');
    {
      const code = decomment(SRC);
      ok('investors is still an investor-owned table',
         /investors:\s+'id',/.test(code),
         'that is exactly why the columns had to be protected — the owner IS the attacker');
      ok('and is still not admin-write-only',
         !/ADMIN_WRITE_TABLES = new Set\(\[[^\]]*'investors'/.test(code),
         'making the whole table admin-only would break the portal profile save');
    }

    console.log('\nthe portal still writes what it legitimately needs to');
    {
      const portal = fs.readFileSync(path.join(ROOT, 'portal', 'js', 'portal.js'), 'utf8');
      const at = portal.indexOf("await API._fetch('PATCH', `tables/investors/${inv.id}`, updates)");
      ok('the profile save was found', at > -1);
      const near = portal.slice(Math.max(0, at - 900), at);
      ok('it sends the names, which is why they must stay writable',
         /first_name:/.test(near) && /last_name:/.test(near),
         'an earlier draft of this fix blocked them and would have broken this');
      ok('and does not send email or id_number, which is why those can be blocked',
         !/email:/.test(near) && !/id_number:/.test(near), near.slice(-400));
    }

    console.log('\nthe sink the console rendered is escaped');
    {
      const at   = ADM.indexOf('txnDrop.innerHTML = matches.map');
      ok('the investor search dropdown was found', at > -1);
      const frag = ADM.slice(at, ADM.indexOf(".join('');", at));
      ok('the name is escaped', /\$\{_esc\(name\)\}/.test(frag), frag.slice(0, 300));
      ok('the email is escaped', /_esc\(inv\.email\)/.test(frag));
      ok('the id is escaped', /_esc\(inv\.id\)/.test(frag));
      ok('including inside data-name, which a quote walked straight out of',
         /data-name="\$\{_esc\(name\)\}"/.test(frag), frag.slice(0, 300));
      ok('nothing in that fragment is still interpolated raw',
         !/\$\{(inv\.(first_name|last_name|email|id)|name)\}/.test(frag),
         frag.slice(0, 400));
    }

    console.log('\n_esc is strong enough for an attribute, not just a text node');
    {
      ok('it escapes double quotes', /replace\(\/"\/g,'&quot;'\)/.test(ADM));
      ok('and single quotes', /replace\(\/'\/g,'&#39;'\)/.test(ADM),
         "onclick='…' is single-quoted throughout this file");
      ok('and ampersand first, so the others are not double-encoded',
         /_esc = \(s\) => String\(s \?\? ''\)\.replace\(\/&\/g,'&amp;'\)/.test(ADM));
    }

    console.log('\nwhat is already stored is a separate question');
    {
      /* The write paths only govern what arrives from now on. Rows written
         earlier, or brought in by the migration, passed through no sanitiser. */
      const auditPath = path.join(ROOT, 'server', 'scripts', 'audit-stored-markup.cjs');
      ok('there is an audit for data already in the table', fs.existsSync(auditPath));
      const aud = decomment(fs.readFileSync(auditPath, 'utf8'));
      ok('it separates what would execute from what merely breaks an attribute',
         /EXECUTABLE/.test(aud) && /BREAKING/.test(aud),
         'an apostrophe in a surname is not an incident; a script tag is');
      ok('and it writes nothing',
         !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b\s/.test(aud));
      ok('bounded by a statement timeout, so it is safe against production',
         /statement_timeout/.test(aud));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  }
  process.exit(fail ? 1 : 0);
})();
