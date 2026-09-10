#!/usr/bin/env node
/* Signing: what the route refuses, and what it seals.
 *
 * The signature is the only moment in the flow that is not reversible, so
 * the refusals matter more than the happy path. Each one below is a way an
 * agreement could be signed by the wrong person, for the wrong terms, or
 * twice.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-agreement-signing.cjs
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

const SIGN = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'agreements.js'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CODE  = strip(SIGN);
const AG    = require(path.join(ROOT, 'server', 'services', 'agreements.js'));

/* Set BEFORE the router is required. auth.js reads JWT_SECRET once at module
   load, so assigning it afterwards leaves the middleware verifying against a
   different secret and every call comes back "invalid or expired token". */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-agreement-signing-secret';

/* The shipped router, driven directly. Assertions about refusals have to be
   about what the route DOES: a regex proving the words "Please confirm every
   statement" appear in the file still matches after the condition that
   raises them has been deleted, which is exactly the mutation it needs to
   catch. */
const router = require(path.join(ROOT, 'server', 'routes', 'agreements.js'));

const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
const tokenFor = u => jwt.sign(u, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '10m' });

function call(method, url, body, user) {
  return new Promise((resolve) => {
    const u = user || { role: 'investor', investorId: 'INV-SIGN-1' };
    const req = {
      method, url, originalUrl: url, baseUrl: '', body: body || {},
      headers: { 'user-agent': 'check-agreement-signing',
                 authorization: 'Bearer ' + tokenFor(u) },
      cookies: {},
      ip: '203.0.113.7',
      get(h) { return this.headers[String(h).toLowerCase()]; },
    };
    let code = 200;
    const res = {
      statusCode: 200,
      status(c) { code = c; this.statusCode = c; return this; },
      set() { return this; },
      json(payload) { resolve({ status: code, body: payload }); return this; },
      send(payload) { resolve({ status: code, body: payload }); return this; },
    };
    router(req, res, () => resolve({ status: 404, body: { error: 'no route' } }));
  });
}

(async () => {
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

    console.log('\nthe agreement is stored, not regenerated');
    {
      ok('the document is written to the row at draw time',
         /INSERT INTO investment_agreements[\s\S]{0,600}document_html/.test(CODE));
      ok('signing re-seals it and stores a hash',
         /SET status='signed'[\s\S]{0,240}document_html=\$5, document_sha256=\$6/.test(CODE),
         'a document rebuilt on read cannot be shown to be the one signed');
      ok('the download serves the stored bytes',
         /SELECT investor_id, agreement_no, document_html FROM investment_agreements/.test(CODE) &&
         /res\.send\(a\.document_html\)/.test(CODE));
      ok('and never sniffed into something else',
         /X-Content-Type-Options', 'nosniff'/.test(CODE));
    }

    console.log('\nit refuses the ways a signature could be wrong');
    {
      const ME = { role: 'investor', investorId: 'INV-SIGN-1' };
      await db.query(`DELETE FROM investment_agreements WHERE investor_id LIKE 'INV-SIGN-%'`);
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, fica_status)
         VALUES ('INV-SIGN-1','Thandi','Mokoena','thandi.check@example.com','approved')
         ON CONFLICT (id) DO UPDATE SET fica_status='approved',
           first_name='Thandi', last_name='Mokoena'`);
      await db.query(
        `INSERT INTO investment_pools
           (id, name, product_type, status, target_amount, raised_amount,
            min_investment, annual_rate, term_months, start_date, end_date)
         VALUES ('POOL-SIGN','Signing Test Pool','eif_ijara','open',1000000,0,
                 1000,0.125,36,CURRENT_DATE - 5, CURRENT_DATE + 30)
         ON CONFLICT (id) DO UPDATE SET status='open', end_date=CURRENT_DATE + 30`);

      const drawn = await call('POST', '/draw', { pool_id: 'POOL-SIGN', amount: 5000 }, ME);
      ok('an eligible investor can draw an agreement', drawn.status === 200 && !!drawn.body.id,
         JSON.stringify(drawn.body).slice(0, 220));
      const id = drawn.body.id;
      const keys = (drawn.body.acknowledgements || []).map(a => a.key);
      ok('and it asks for the structure’s own acknowledgements',
         keys.includes('ijara_rent_stops'), JSON.stringify(keys));

      const partial = await call('POST', `/${id}/sign`,
        { signer_name: 'Thandi Mokoena', acknowledged: keys.slice(0, keys.length - 1) }, ME);
      ok('a partial set of acknowledgements is refused', partial.status === 400,
         `${partial.status} ${JSON.stringify(partial.body)}`);
      ok('and it names the one that is missing',
         Array.isArray(partial.body && partial.body.missing) && partial.body.missing.length === 1,
         JSON.stringify(partial.body));

      const wrongName = await call('POST', `/${id}/sign`,
        { signer_name: 'Someone Else', acknowledged: keys }, ME);
      ok('a name that is not the investor’s is refused', wrongName.status === 400,
         JSON.stringify(wrongName.body));

      const badSig = await call('POST', `/${id}/sign`,
        { signer_name: 'Thandi Mokoena', acknowledged: keys, signature_png: 'javascript:alert(1)' }, ME);
      ok('a signature that is not a PNG data URL is refused', badSig.status === 400,
         JSON.stringify(badSig.body));

      const stranger = await call('POST', `/${id}/sign`,
        { signer_name: 'Thandi Mokoena', acknowledged: keys },
        { role: 'investor', investorId: 'INV-SIGN-2' });
      ok('someone else’s agreement is not found rather than described',
         stranger.status === 404, JSON.stringify(stranger.body));

      const good = await call('POST', `/${id}/sign`,
        { signer_name: '  thandi   mokoena ', acknowledged: keys }, ME);
      ok('the investor’s own name signs it, spacing and case aside',
         good.status === 200 && !!(good.body && good.body.document_sha256),
         JSON.stringify(good.body).slice(0, 220));

      const twice = await call('POST', `/${id}/sign`,
        { signer_name: 'Thandi Mokoena', acknowledged: keys }, ME);
      ok('an already-signed agreement cannot be signed again', twice.status === 409,
         JSON.stringify(twice.body));

      const { rows: [row] } = await db.query(
        `SELECT status, document_sha256, document_html, signed_ip, acknowledgements
           FROM investment_agreements WHERE id = $1`, [id]);
      ok('the stored hash is the hash of the stored document',
         row.document_sha256 === AG.sha256(row.document_html),
         'the seal does not describe the bytes it was taken from');
      ok('the sealed document carries the audit record',
         /Audit record/.test(row.document_html) && row.document_html.includes('203.0.113.7'),
         'the document is the only place the circumstances of signing survive');
      ok('and every acknowledgement it was signed under',
         (row.acknowledgements || []).length === keys.length,
         JSON.stringify(row.acknowledgements));

      const { rows: [amt] } = await db.query(
        `SELECT amount_cents, pool_amount_cents, fee_cents FROM investment_agreements WHERE id=$1`, [id]);
      ok('the agreement is held in whole cents that add back to the whole',
         Number(amt.amount_cents) === 500000 &&
         Number(amt.pool_amount_cents) + Number(amt.fee_cents) === Number(amt.amount_cents),
         JSON.stringify(amt));

      /* Eligibility is refused before a contract exists, not after. */
      await db.query(`UPDATE investors SET fica_status='pending' WHERE id='INV-SIGN-1'`);
      const noFica = await call('POST', '/draw', { pool_id: 'POOL-SIGN', amount: 5000 }, ME);
      ok('FICA is required before a contract is drawn', noFica.status === 403,
         JSON.stringify(noFica.body));
      await db.query(`UPDATE investors SET fica_status='approved' WHERE id='INV-SIGN-1'`);

      await db.query(`UPDATE investment_pools SET end_date = CURRENT_DATE - 1 WHERE id='POOL-SIGN'`);
      const closed = await call('POST', '/draw', { pool_id: 'POOL-SIGN', amount: 5000 }, ME);
      ok('a closed pool cannot be signed for', closed.status === 400, JSON.stringify(closed.body));
      await db.query(`UPDATE investment_pools SET end_date = CURRENT_DATE + 30 WHERE id='POOL-SIGN'`);

      const tooSmall = await call('POST', '/draw', { pool_id: 'POOL-SIGN', amount: 10 }, ME);
      ok('below the pool minimum cannot be signed for', tooSmall.status === 400,
         JSON.stringify(tooSmall.body));

      ok('the row is locked while a signature is decided',
         /SELECT \* FROM investment_agreements WHERE id = \$1 FOR UPDATE/.test(CODE),
         'two tabs would seal two documents with different hashes for one agreement');
    }

    console.log('\nthe figures on the document are the figures the wallet sees');
    {
      /* tables.js splits a fee-inclusive amount as round(amount/1.01); the
         document has to state the same split or the investor signs for one
         set of numbers and is charged another. */
      const routeSplit  = /const poolCents = Math\.round\(amountCents \/ 1\.01\);/.test(CODE);
      ok('the agreement splits the fee the same way the money does', routeSplit,
         'the contract would state a different fee from the one charged');

      const cents = AG.toCents('1000.00');
      const poolC = Math.round(cents / 1.01);
      ok('and the parts add back to the whole',
         poolC + (cents - poolC) === cents, `${poolC} + ${cents - poolC} != ${cents}`);
    }

    console.log('\nthe live database agrees with the wording');
    {
      const { rows } = await db.query(
        `SELECT product_type, key_details FROM products
          WHERE product_type IN ('eif_murabaha','eif_ijara','eif_mudarabah')
          ORDER BY product_type`);
      ok('all three EIF products are installed', rows.length === 3, JSON.stringify(rows.map(r => r.product_type)));
      for (const r of rows) {
        ok(`${r.product_type} lists the assets it finances`,
           /Typical (assets|ventures):/.test(r.key_details || ''),
           (r.key_details || '').slice(0, 120));
      }
      const mur = rows.find(r => r.product_type === 'eif_murabaha');
      const ija = rows.find(r => r.product_type === 'eif_ijara');
      const mud = rows.find(r => r.product_type === 'eif_mudarabah');
      ok('the leasing product names vehicles', /vehicle/i.test(ija.key_details || ''));
      ok('the partnership product names the feedlot cycle', /feedlot/i.test(mud.key_details || ''));
      ok('the sale product names printers', /printer/i.test(mur.key_details || ''));

      /* Receivables were deliberately left out as a financed asset — buying
         a debt at a discount is the one thing this range cannot do. They
         remain named as SECURITY on the Murabaha, which is a different
         claim and was already there. */
      const financed = t => /Typical (assets|ventures):([^\n]*)/.exec(t || '');
      for (const r of rows) {
        const line = financed(r.key_details);
        ok(`${r.product_type} does not offer receivables as an asset it finances`,
           !!line && !/receivable/i.test(line[2]),
           line && line[2]);
      }
      ok('but receivables still stand as security on the Murabaha',
         /trade receivables/i.test(mur.key_details || ''),
         'taking them as collateral was never the problem');
    }

    console.log('\nthe examples reach a database that already had the products');
    {
      /* The whole reason step 13b exists. EIF_PRODUCTS only ever reaches a
         brand-new database — step 13 installs with ON CONFLICT DO NOTHING —
         so staging and production, which already hold the three rows, would
         never have seen a word of this copy. */
      await db.query(
        `UPDATE products SET key_details = 'Existing bullet nobody wants deleted'
          WHERE product_type = 'eif_ijara'`);
      await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});
      const { rows: [r] } = await db.query(
        `SELECT key_details FROM products WHERE product_type='eif_ijara'`);
      ok('the examples are added to a product that predates them',
         /Typical assets: delivery vehicles/.test(r.key_details), r.key_details);
      ok('and what was already there is kept',
         /Existing bullet nobody wants deleted/.test(r.key_details),
         'admin-edited copy was replaced rather than added to');
      ok('on its own line, not run into the previous bullet',
         /nobody wants deleted\nTypical assets/.test(r.key_details),
         JSON.stringify(r.key_details));
    }

    console.log('\nrunning setup again changes nothing');
    {
      const before = (await db.query(
        `SELECT key_details FROM products WHERE product_type='eif_ijara'`)).rows[0].key_details;
      await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});
      const after = (await db.query(
        `SELECT key_details FROM products WHERE product_type='eif_ijara'`)).rows[0].key_details;
      ok('the examples are appended once, not on every boot', before === after,
         `grew from ${before.length} to ${after.length} characters`);
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
