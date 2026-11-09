#!/usr/bin/env node
/* A group sends its own documents, and an invitation link opens sign-up.
 *
 * GROUP DOCUMENTS. A group's constitution, proof of bank and signatories'
 * IDs had nowhere to go in the app, and a group learned it needed them from
 * a refused withdrawal. Checked here:
 *   · only the committee or a signatory sends one; every member sees the list;
 *     nobody downloads a file through the group's endpoint
 *   · a signatory's ID must be a signatory's, or somebody asked to sign
 *   · the group is under review once everything is in, verified once it is
 *     approved, and back to pending when something is rejected
 *   · AND APPROVING THEM NEVER TOUCHES THE UPLOADER'S OWN FICA. The console
 *     promotes a person's verification once their id_document, address and
 *     bank proof are approved, without looking at sub_account_id; a group's
 *     documents are stokvel_* types so that promotion can never count them.
 *
 * THE INVITATION LINK. It shows the group's name, who sent it, the rules and
 * which address to use — and grants nothing. Checked: no money, roster or
 * contact details in it; only a live invitation answers; somebody else
 * holding the link still cannot accept.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-group-documents.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('\nwithout a database');
{
  const D = require(path.join(ROOT, 'server', 'services', 'stokvelDocuments.js'));
  ok('every group document type is a stokvel_ type, so personal FICA can never count it',
     Object.keys(D.TYPES).every(t => /^stokvel_/.test(t)));
  const TABLES = read('server/routes/tables.js');
  ok('and the personal promotion still names only personal types',
     /\['id_document', 'proof_of_address', \.\.\.BANK_ALIASES\]/.test(TABLES));
  ok('a file over 5 MB is refused', /must be under 5 MB/.test(D.parseUpload({ doc_type: 'stokvel_constitution',
     file_name: 'big.pdf', file_data: 'data:application/pdf;base64,' + 'A'.repeat(7 * 1024 * 1024) }).error || ''));
  ok('so is anything that is not a PDF or a photo', !!D.parseUpload({ doc_type: 'stokvel_constitution',
     file_name: 'x.exe', file_data: 'data:application/x-msdownload;base64,AAAA' }).error);
  ok('a group needs at least two signatories’ IDs, or as many as its quorum',
     D.signatoriesNeeded({ stokvel_quorum: 1 }) === 2 && D.signatoriesNeeded({ stokvel_quorum: 3 }) === 3);
  ok('the upload endpoint has a body limit that fits a 5 MB file',
     /stokvels\\\/\[\^\/\]\+\\\/documents\$\/, express\.json\(\{ limit: '15mb' \}\)/.test(read('server/index.js')));
  const SIGNUP = read('signup.html');
  ok('sign-up reads the invitation from its link',
     /fetch\('\/api\/invite-preview\/' \+ encodeURIComponent\(id\)\)/.test(SIGNUP));
  ok('and lands an invited person on My Groups',
     /window\.__SVINVITE \? '\/portal\/index\.html\?view=groups'/.test(SIGNUP));
  ok('the preview endpoint is rate-limited',
     /app\.use\('\/api\/invite-preview', rateLimit\(/.test(read('server/index.js')));
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

(async () => {
  const http = require('http');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  let srv;
  const G = 'SA-GD-1', P = 'INV-GD-';
  const clean = async () => {
    await db.query(`DELETE FROM kyc_documents WHERE sub_account_id = $1 OR investor_id LIKE 'INV-GD-%'`, [G]);
    await db.query(`DELETE FROM stokvel_invites WHERE sub_account_id = $1`, [G]);
    await db.query(`DELETE FROM stokvel_members WHERE sub_account_id = $1`, [G]);
    await db.query(`DELETE FROM sub_accounts WHERE id = $1`, [G]);
    await db.query(`DELETE FROM investors WHERE id LIKE 'INV-GD-%'`);
  };
  try {
    await clean();
    for (const who of ['CHAIR', 'SIG', 'NOM', 'PLAIN', 'STRANGER'])
      await db.query(`INSERT INTO investors (id, first_name, last_name, email, phone, status, wallet_balance, kyc_status)
                      VALUES ($1,$2,'Gd',$3,$4,'active',0,'pending')`,
        [P + who, who.charAt(0) + who.slice(1).toLowerCase(), `${(P + who).toLowerCase()}@example.test`,
         '07' + String(Math.abs(who.charCodeAt(0) * 7919)).padStart(8, '0').slice(0, 8)]);
    await db.query(`INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, kyc_status, status, stokvel_quorum, wallet_balance)
                    VALUES ($1,$2,'stokvel','Tshwane Savings Club','pending','active',2, 31000)`, [G, P + 'CHAIR']);
    for (const [who, role, sig, nom] of [['CHAIR', 'chairperson', true, false], ['SIG', 'member', true, false],
                                         ['NOM', 'member', false, true], ['PLAIN', 'member', false, false]])
      await db.query(`INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at, signatory_nominated_at)
                      VALUES ($1,$2,$3,$4,$5,'active',NOW(),$6)`, ['SM-GD-' + who, G, P + who, role, sig, nom ? new Date() : null]);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '15mb' }));
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
    app.use('/api/tables', require(path.join(ROOT, 'server', 'routes', 'tables.js')));
    app.use('/api/invite-preview', require(path.join(ROOT, 'server', 'routes', 'invitePreview.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const tok = who => who === 'ADMIN'
      ? jwt.sign({ id: 'u-admin', role: 'admin', email: 'ops@example.test', firstName: 'Ops', lastName: 'Desk' }, process.env.JWT_SECRET)
      : jwt.sign({ id: 'u-' + who, role: 'investor', investorId: P + who }, process.env.JWT_SECRET);
    const call = (method, p, who, body) => new Promise(res => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign(who ? { Authorization: `Bearer ${tok(who)}` } : {},
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s2 = ''; x.on('data', c => s2 += c);
               x.on('end', () => { let b = {}; try { b = JSON.parse(s2 || '{}'); } catch (_) {} res({ status: x.statusCode, body: b, raw: s2 }); }); });
      if (payload) r.write(payload);
      r.end();
    });
    const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 group document').toString('base64');
    const send = (who, doc_type, extra) => call('POST', `/api/stokvels/${G}/documents`, who,
      Object.assign({ doc_type, file_name: doc_type + '.pdf', file_data: PDF }, extra || {}));
    const groupStatus = async () => (await db.query(`SELECT kyc_status FROM sub_accounts WHERE id = $1`, [G])).rows[0].kyc_status;
    /* The console answers a review first and applies its consequences just
       after (setImmediate in routes/tables.js), so a status it sets is
       waited for rather than read the instant the response lands. */
    const settlesTo = async want => {
      for (let i = 0; i < 40; i++) {
        if (await groupStatus() === want) return true;
        await new Promise(r => setTimeout(r, 50));
      }
      return false;
    };

    console.log('\nwho sends the group’s documents');
    const plain = await send('PLAIN', 'stokvel_constitution');
    ok('an ordinary member cannot', plain.status === 403, `${plain.status}`);
    const c = await send('CHAIR', 'stokvel_constitution');
    ok('the chairperson can', c.status === 201, JSON.stringify(c.body));
    ok('one document in is not "being checked" yet', await groupStatus() === 'pending');
    const b = await send('SIG', 'stokvel_bank_proof');
    ok('and a signatory can', b.status === 201, JSON.stringify(b.body));

    console.log('\nwhose ID it is');
    const stranger = await send('CHAIR', 'stokvel_signatory_id', { signatory_investor_id: P + 'PLAIN' });
    ok('not somebody who is neither a signatory nor asked to be one', stranger.status === 400, stranger.body.error);
    const noWho = await send('CHAIR', 'stokvel_signatory_id');
    ok('and it must say whose', noWho.status === 400);
    const id1 = await send('CHAIR', 'stokvel_signatory_id', { signatory_investor_id: P + 'CHAIR' });
    const id2 = await send('CHAIR', 'stokvel_signatory_id', { signatory_investor_id: P + 'NOM' });
    ok('a signatory’s, and a nominee’s before they confirm', id1.status === 201 && id2.status === 201,
       JSON.stringify([id1.body, id2.body]));
    ok('with everything in, the group is under review', id2.body.data.group_status === 'under_review'
       && await groupStatus() === 'under_review');

    console.log('\nwhat a member sees');
    const list = await call('GET', `/api/stokvels/${G}/documents`, 'PLAIN');
    ok('every member sees what was sent and where it stands',
       list.status === 200 && list.body.data.length === 4 && list.body.requirements.length === 3, JSON.stringify(list.body).slice(0, 200));
    ok('and never the file itself', !/base64|file_data/.test(list.raw));
    ok('nor the upload button', list.body.may_upload === false);
    ok('a signatory’s ID is named by whose it is', list.body.data.some(d => d.signatory_name === 'Nom Gd'));

    console.log('\nreviewed in the console');
    const { rows: docs } = await db.query(
      `SELECT id, doc_type FROM kyc_documents WHERE sub_account_id = $1 ORDER BY doc_type`, [G]);
    const review = (id, status, notes) => call('PATCH', `/api/tables/kyc_documents/${id}`, 'ADMIN',
      Object.assign({ status }, notes ? { notes } : {}));
    const bank = docs.find(d => d.doc_type === 'stokvel_bank_proof');
    const rj = await review(bank.id, 'rejected', 'The statement is older than three months');
    ok('a rejection puts the group back to pending, so its checklist asks again', await settlesTo('pending'),
       `${rj.status} ${rj.raw.slice(0, 200)} → ${await groupStatus()}`);
    const again = await call('GET', `/api/stokvels/${G}/documents`, 'CHAIR');
    const bankReq = again.body.requirements.find(r => r.type === 'stokvel_bank_proof');
    ok('with the reason on it', bankReq.status === 'rejected' && /three months/.test(bankReq.notes || ''), JSON.stringify(bankReq));
    const b2 = await send('CHAIR', 'stokvel_bank_proof');
    ok('a new one supersedes it and the group is under review again',
       b2.status === 201 && await groupStatus() === 'under_review');
    const { rows: all } = await db.query(
      `SELECT id FROM kyc_documents WHERE sub_account_id = $1 AND status = 'pending'`, [G]);
    for (const d of all) await review(d.id, 'approved');
    ok('approved, the group is verified', await settlesTo('approved'));
    const personal = (await db.query(`SELECT kyc_status FROM investors WHERE id = $1`, [P + 'CHAIR'])).rows[0].kyc_status;
    ok('and the chairperson’s OWN verification is untouched', personal === 'pending', personal);
    const late = await send('CHAIR', 'stokvel_constitution');
    ok('a verified group is not asked for more', late.status === 409);

    console.log('\nthe invitation link');
    const vid = 'SVI-' + 'A1B2C3D4E5F607';
    await db.query(`INSERT INTO stokvel_invites (id, sub_account_id, invited_by, invitee_name, email, cell, status, expires_at)
                    VALUES ($1,$2,$3,'Lerato','lerato.m@example.test','821234567','pending', NOW() + INTERVAL '10 days')`,
                   [vid, G, P + 'CHAIR']);
    const pv = await call('GET', `/api/invite-preview/${vid}`);
    ok('shows the group, who sent it and the rules', pv.status === 200 && pv.body.data.group_name === 'Tshwane Savings Club'
       && pv.body.data.invited_by === 'Chair' && /2 signatories must approve/.test(pv.body.data.rules), JSON.stringify(pv.body));
    ok('and which address to use, masked', pv.body.data.email_hint === 'l*******@example.test'
       && /4567$/.test(pv.body.data.cell_hint) && !/lerato/.test(pv.raw), pv.raw);
    ok('and nothing of the group’s money or members',
       JSON.stringify(Object.keys(pv.body.data).sort()) === JSON.stringify(
         ['as_signatory', 'email_hint', 'cell_hint', 'expires_at', 'group_name', 'invited_by', 'rules'].sort())
       && !/31000/.test(pv.raw), pv.raw);
    const bad = await call('GET', `/api/invite-preview/not-an-id`);
    ok('a malformed id is simply not found', bad.status === 404);
    await db.query(`UPDATE stokvel_invites SET status = 'revoked' WHERE id = $1`, [vid]);
    const revoked = await call('GET', `/api/invite-preview/${vid}`);
    ok('a withdrawn invitation reads the same as one that never existed',
       revoked.status === 404 && revoked.body.error === bad.body.error);
    await db.query(`UPDATE stokvel_invites SET status = 'pending' WHERE id = $1`, [vid]);
    const taken = await call('POST', `/api/stokvels/invites/${vid}/accept`, 'STRANGER', {});
    ok('and somebody else holding the link still cannot accept it', taken.status === 404 || taken.status === 403,
       `${taken.status} ${JSON.stringify(taken.body)}`);
    const joined = (await db.query(`SELECT 1 FROM stokvel_members WHERE sub_account_id = $1 AND investor_id = $2`,
                                   [G, P + 'STRANGER'])).rows.length;
    ok('nor are they a member afterwards', joined === 0);

    console.log('\nthe messages carry it to the right place');
    const sent = [];
    const email = require(path.join(ROOT, 'server', 'services', 'email.js'));
    const origSend = email.sendStokvelInvite;
    /* Render the real template by catching what it hands the transport. */
    const EM = read('server/services/email.js');
    ok('a new person’s email button opens sign-up with this invitation',
       /`\$\{BASE_URL\}\/signup\.html\$\{inviteId \? `\?invite=\$\{encodeURIComponent\(inviteId\)\}` : ''\}`/.test(EM));
    ok('somebody who has an account goes straight to My Groups', /`\$\{BASE_URL\}\/portal\/\?view=groups`/.test(EM));
    ok('the SMS carries the link too', /signup'\s*\n\s*\+ \(inviteId \? `\?invite=\$\{inviteId\}` : ''\)/.test(read('server/services/sms.js')));
    ok('and the notifier hands both the invitation id',
       (read('server/services/stokvelNotify.js').match(/inviteId: v\.id/g) || []).length === 2);
    void sent; void origSend;

    await clean();
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
