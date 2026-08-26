#!/usr/bin/env node
/* Approving a KYC document must update everything, together.
 *
 * Three faults, all of which showed on one screen:
 *
 *   1. The list query omits file_data by design — they are base64 blobs. The
 *      console read that absence as "no file" and told staff the investor must
 *      re-upload, on every document held that way, while hiding the buttons
 *      that would have opened it. The file was in the database the whole time.
 *
 *   2. The promote ran `WHERE fica_status != 'approved'`. fica_status came from
 *      an ALTER with DEFAULT 'pending', and a default only applies to new rows,
 *      so every investor predating it holds NULL. `NULL != 'approved'` is NULL,
 *      not true — those investors were never promoted however many documents
 *      were approved, and still received the approval email.
 *
 *   3. The document, the investor record and the support tickets were updated
 *      by separate queries, each with .catch(() => {}). Approved in one place
 *      and not another was a normal outcome, and nothing reported it.
 *
 * Needs a database:
 *   DATABASE_URL=postgres://… DATABASE_SSL=false node server/scripts/check-kyc-approval.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see server/scripts/check-kyc-approval.cjs header');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const ROOT = path.join(__dirname, '..', '..');

async function schema() {
  await pool.query('DROP TABLE IF EXISTS kyc_documents, support_tickets, investors CASCADE');
  await pool.query(`
    CREATE TABLE investors (
      id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT,
      status TEXT, kyc_status TEXT, fica_status TEXT,
      fica_approved_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE kyc_documents (
      id TEXT PRIMARY KEY, investor_id TEXT, doc_type TEXT, status TEXT,
      file_name TEXT, file_url TEXT, file_data TEXT,
      sub_account_id TEXT, investor_name TEXT, notes TEXT,
      reviewed_by TEXT, reviewed_at TIMESTAMPTZ, submitted_at TIMESTAMPTZ,
      reviewed_date TIMESTAMPTZ, expiry_date DATE, doc_subtype TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE support_tickets (
      id TEXT PRIMARY KEY, investor_id TEXT, category TEXT, status TEXT,
      admin_response TEXT, responded_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
}

(async () => {
  try {
    await schema();

    /* ── 1. A stored file must not read as "no file" ─────────────────── */
    console.log('\na document with its file in the database');
    await pool.query(`INSERT INTO investors (id, first_name, last_name, email, fica_status)
                      VALUES ('S-11766','Leonard','Burger','lb@x.invalid', NULL)`);
    await pool.query(`INSERT INTO kyc_documents (id, investor_id, doc_type, status, file_name, file_data)
                      VALUES ('K1','S-11766','id_document','approved','1000298165.jpg','data:image/jpeg;base64,AAAA')`);
    await pool.query(`INSERT INTO kyc_documents (id, investor_id, doc_type, status, file_name)
                      VALUES ('K2','S-11766','proof_of_address','approved','missing.jpg')`);

    // The real list projection, blob excluded.
    const listSql = `
      SELECT id, investor_id, doc_type, status, file_url, file_name,
             (file_data IS NOT NULL AND file_data <> '') AS has_file_data
      FROM kyc_documents WHERE investor_id = $1 ORDER BY id`;
    const { rows } = await pool.query(listSql, ['S-11766']);
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));

    ok('the list still does not ship the blob',
       !('file_data' in byId.K1), Object.keys(byId.K1).join(','));
    ok('but reports that a file is stored', byId.K1.has_file_data === true);
    ok('and reports honestly when one is not', byId.K2.has_file_data === false);

    const tables = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'tables.js'), 'utf8');
    ok('the route actually selects has_file_data',
       /\(file_data IS NOT NULL AND file_data <> ''\) AS has_file_data/.test(tables));
    const admin = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
    ok('and the console reads it rather than the absent blob',
       /k\.has_file_data \|\| k\.file_data/.test(admin),
       'reading k.file_data alone is always undefined in the list');

    /* ── 2. The promote must not skip NULL fica_status ───────────────── */
    console.log('\nan investor whose fica_status predates the column default');
    const promote = `
      UPDATE investors
         SET fica_status = 'approved', kyc_status = 'approved',
             status = CASE WHEN status IN ('pending','pending_fica','fica_submitted') THEN 'active' ELSE status END,
             fica_approved_at = COALESCE(fica_approved_at, NOW()), updated_at = NOW()
       WHERE id = $1 AND COALESCE(fica_status, '') <> 'approved'`;
    const r1 = await pool.query(promote, ['S-11766']);
    ok('a NULL fica_status is promoted', r1.rowCount === 1, `rowCount ${r1.rowCount}`);

    const after = (await pool.query(`SELECT fica_status, kyc_status FROM investors WHERE id='S-11766'`)).rows[0];
    ok('and the record says approved', after.fica_status === 'approved' && after.kyc_status === 'approved',
       JSON.stringify(after));

    // The old comparison, for the record.
    await pool.query(`UPDATE investors SET fica_status = NULL WHERE id='S-11766'`);
    const rOld = await pool.query(
      `UPDATE investors SET fica_status='approved' WHERE id=$1 AND fica_status != 'approved'`, ['S-11766']);
    ok('the old comparison really did skip it', rOld.rowCount === 0,
       `it updated ${rOld.rowCount} row(s) — the bug would not reproduce`);

    ok('re-running the promote is idempotent',
       (await pool.query(promote, ['S-11766'])).rowCount === 1 &&
       (await pool.query(promote, ['S-11766'])).rowCount === 0);

    ok('the route uses the NULL-safe form',
       /COALESCE\(fica_status, ''\) <> 'approved'/.test(tables),
       'server/routes/tables.js still uses the comparison that skips NULL');

    /* ── 3. Everything moves together, or not at all ─────────────────── */
    console.log('\nthe approval updates every place at once');
    await pool.query(`INSERT INTO support_tickets (id, investor_id, category, status)
                      VALUES ('T1','S-11766','fica_submission','open'),
                             ('T2','S-11766','kyc','in_progress'),
                             ('T3','S-11766','withdrawal','open')`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(promote, ['S-11766']);
      await client.query(
        `UPDATE support_tickets SET status='resolved', responded_at=NOW(), updated_at=NOW()
          WHERE investor_id=$1 AND status IN ('open','in_progress','under_review')
            AND category IN ('fica_submission','kyc_submission','fica','kyc','document_verification')`,
        ['S-11766']);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

    const t = Object.fromEntries((await pool.query(
      `SELECT id, status FROM support_tickets WHERE investor_id='S-11766'`)).rows.map(x => [x.id, x.status]));
    ok('the KYC tickets resolve', t.T1 === 'resolved' && t.T2 === 'resolved', JSON.stringify(t));
    ok('an unrelated ticket is untouched', t.T3 === 'open', JSON.stringify(t));

    // A failure part-way must leave nothing applied.
    await pool.query(`UPDATE investors SET fica_status=NULL WHERE id='S-11766'`);
    await pool.query(`UPDATE support_tickets SET status='open' WHERE id='T1'`);
    const c2 = await pool.connect();
    let threw = false;
    try {
      await c2.query('BEGIN');
      await c2.query(promote, ['S-11766']);
      await c2.query(`UPDATE support_tickets SET status='resolved' WHERE no_such_column = 1`);
      await c2.query('COMMIT');
    } catch (_) { threw = true; await c2.query('ROLLBACK').catch(() => {}); } finally { c2.release(); }

    const rolled = (await pool.query(`SELECT fica_status FROM investors WHERE id='S-11766'`)).rows[0];
    ok('a mid-way failure rolls the whole approval back', threw && rolled.fica_status === null,
       `fica_status is ${JSON.stringify(rolled.fica_status)} — a partial approval survived`);

    ok('the route runs the side effects in one transaction',
       /kycClient\.query\('BEGIN'\)/.test(tables) && /kycClient\.query\('COMMIT'\)/.test(tables));
    ok('and reports a failure instead of swallowing it',
       /\[kyc\] approval side effects failed/.test(tables),
       'these were .catch(() => {}) — approved here but not there, silently');
    ok('the approval email waits until the record actually says approved',
       /WHERE id = \$1 AND fica_status = 'approved'[\s\S]{0,200}sendKycApproved/.test(tables),
       'it used to send even when the promote had done nothing');

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await pool.query('DROP TABLE IF EXISTS kyc_documents, support_tickets, investors CASCADE').catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
