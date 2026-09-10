#!/usr/bin/env node
/* An investor's money does not move without a signed agreement.
 *
 * The whole design rests on one statement in tables.js that reads and claims
 * an agreement at once, inside the same transaction that debits the wallet.
 * If it can be satisfied twice, one signature funds two investments; if it
 * matches loosely, a signature for R1 000 funds R100 000. So the statement is
 * LIFTED out of the shipped file and run here, rather than retyped — a copy
 * would keep passing after the original changed.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-investment-agreement-gate.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const db   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const TABLES = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'tables.js'), 'utf8');
const AG     = require(path.join(ROOT, 'server', 'services', 'agreements.js'));

/* The shipped claim, taken from the file. Fails loudly rather than falling
   back to a hand-written copy: a check that silently tests its own SQL is
   worse than no check. */
function liftClaimSql() {
  const m = TABLES.match(/`(UPDATE investment_agreements[\s\S]*?RETURNING id, agreement_no)`/);
  if (!m) throw new Error('could not lift the claim statement from tables.js');
  return m[1];
}

(async () => {
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

    console.log('\nthe wording and the tick boxes come from one place');
    {
      for (const t of ['eif_murabaha', 'eif_ijara', 'eif_mudarabah']) {
        const tpl = AG.templateFor(t);
        ok(`${t} has its own contract`, tpl.key === t, tpl.key);
        const acks = AG.acknowledgementsFor(t);
        ok(`${t} states every acknowledgement it asks for`,
           acks.length > 0 && acks.every(a => a.text && a.text.length > 20),
           JSON.stringify(acks));
      }
      /* The sentence that does the work in each structure. If the contract
         does not say it, the tick box is asserting something the document
         does not support. */
      const says = (t, re) => AG.templateFor(t).clauses.some(([, body]) => re.test(body));
      ok('the Mudarabah contract says the loss falls on the capital',
         says('eif_mudarabah', /loss of the venture falls on the capital/i));
      ok('the Ijara contract says the rent stops',
         says('eif_ijara', /rent stops/i));
      ok('the Murabaha contract says the mark-up does not grow with time',
         says('eif_murabaha', /does not increase with time/i));
      ok('an unknown product still gets a contract rather than a dead end',
         AG.templateFor('something_new').key === 'standard');
    }

    console.log('\nthe seal detects a changed byte');
    {
      const base = { agreement_no: 'AGR-2026-000001', investor_id: 'INV-1',
                     investor_name: 'Test Investor', pool_id: 'POOL-X', pool_name: 'Pool X',
                     product_type: 'eif_ijara', amount_cents: 100000,
                     pool_amount_cents: 99010, fee_cents: 990, drawn_at: new Date('2026-01-01') };
      const a = AG.renderAgreement(base);
      const b = AG.renderAgreement({ ...base, amount_cents: 100001 });
      ok('the same input hashes the same', AG.sha256(a) === AG.sha256(a));
      ok('one cent different is a different document', AG.sha256(a) !== AG.sha256(b));
      ok('the amount actually appears in the document', /R1\s?000,00|R1,000\.00|1 000,00/.test(a),
         a.slice(a.indexOf('Total from wallet'), a.indexOf('Total from wallet') + 120));
    }

    console.log('\none signature funds one investment, and only the right one');
    {
      const CLAIM = liftClaimSql();
      const mk = async (o) => {
        const id = 'AGR-t-' + Math.random().toString(36).slice(2, 10);
        await db.query(
          `INSERT INTO investment_agreements
             (id, agreement_no, investor_id, pool_id, product_type, amount_cents,
              pool_amount_cents, fee_cents, template_key, template_version, status, signed_at)
           VALUES ($1,$2,$3,$4,'standard',$5,$5,0,'standard','v1',$6,NOW())`,
          [id, 'AGR-T-' + id.slice(-8), o.investor, o.pool, o.cents, o.status || 'signed']
        );
        return id;
      };
      const claim = (investor, poolId, required, invId) =>
        db.query(CLAIM, [investor, poolId, Math.round(required * 100), invId]);

      const A = await mk({ investor: 'INV-A', pool: 'POOL-A', cents: 100000 });

      const first = await claim('INV-A', 'POOL-A', 1000, 'INVST-1');
      ok('a matching signed agreement is claimed', first.rows.length === 1,
         JSON.stringify(first.rows));

      const second = await claim('INV-A', 'POOL-A', 1000, 'INVST-2');
      ok('and cannot be claimed a second time', second.rows.length === 0,
         'one signature funded two investments');

      const { rows: [after] } = await db.query(
        `SELECT status, investment_id, funded_at FROM investment_agreements WHERE id=$1`, [A]);
      ok('the claim records which investment consumed it',
         after.status === 'funded' && after.investment_id === 'INVST-1' && !!after.funded_at,
         JSON.stringify(after));

      await mk({ investor: 'INV-B', pool: 'POOL-B', cents: 100000 });
      const cent = await claim('INV-B', 'POOL-B', 1000.01, 'INVST-3');
      ok('one cent off does not match', cent.rows.length === 0,
         'a signature for R1 000,00 funded R1 000,01');

      const other = await claim('INV-B', 'POOL-OTHER', 1000, 'INVST-4');
      ok('another pool does not match', other.rows.length === 0,
         'a signature for one pool funded a different one');

      const someoneElse = await claim('INV-C', 'POOL-B', 1000, 'INVST-5');
      ok('another investor does not match', someoneElse.rows.length === 0,
         'one investor’s signature funded another investor’s investment');

      await mk({ investor: 'INV-D', pool: 'POOL-D', cents: 100000, status: 'drawn' });
      const unsigned = await claim('INV-D', 'POOL-D', 1000, 'INVST-6');
      ok('a drawn but unsigned agreement does not match', unsigned.rows.length === 0,
         'reading the contract counted as signing it');

      /* Left claimable, to prove the negatives above were about the
         condition under test and not about the fixture being broken. */
      const stillThere = await claim('INV-B', 'POOL-B', 1000, 'INVST-7');
      ok('the fixture it kept refusing was in fact claimable', stillThere.rows.length === 1,
         'every negative above may have passed for the wrong reason');
    }

    console.log('\nthe gate sits where the money moves');
    {
      const src = TABLES.replace(/\/\*[\s\S]*?\*\//g, '');
      const iTx    = src.indexOf('_invClient.query(\'BEGIN\')');
      const iClaim = src.indexOf('UPDATE investment_agreements');
      const iDeduct= src.indexOf('SET wallet_balance = wallet_balance -');
      const iCommit= src.indexOf('_invClient.query(\'COMMIT\')');
      ok('the claim is inside the wallet transaction',
         iTx > -1 && iClaim > iTx && iClaim < iCommit,
         `begin ${iTx}, claim ${iClaim}, commit ${iCommit}`);
      ok('and happens before the wallet is debited',
         iClaim > -1 && iDeduct > -1 && iClaim < iDeduct,
         'the money would move first and the signature be checked after');
      ok('a missing signature refuses with a code the client can act on',
         /agreement_required/.test(src) && /412/.test(src));
      ok('reinvestments are exempt, or maturity processing stops',
         /req\.user\.role === 'investor' && !isReinvestment/.test(src));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
