'use strict';
/* ═══════════════════════════════════════════════════════════
   A group's own documents — its constitution, proof of its bank account,
   and its signatories' identity documents.

   Until now there was nowhere in the app to send them. The public page
   promised we would ask for them, and the first a group heard of it was a
   refused withdrawal. They are uploaded here, by the committee or a
   signatory, and reviewed by staff in the console like any other FICA
   document.

   THEIR OWN DOCUMENT TYPES, ON PURPOSE. When staff approve a document, the
   console promotes the UPLOADER's personal FICA once their id_document,
   proof_of_address and proof_of_bank are approved — and that query does not
   look at sub_account_id. A treasurer who uploaded a signatory's ID as an
   'id_document' for the group would, on approval, have it counted towards
   their own verification. So a group's documents are stokvel_* types, which
   that query never matches, and doc_subtype records WHOSE identity document
   a signatory's ID is.

   WHO SEES WHAT. Every member can see which documents the group has sent
   and where each stands — that is the group's own paperwork. Nobody can
   download them here: a signatory's ID is personal information, and the
   other members have no need of a copy. Staff read them in the console.

   WHEN THE GROUP IS VERIFIED. An approved constitution, an approved proof
   of bank account, and approved IDs for as many signatories as the mandate
   requires (never fewer than two). Checked by verified(), called from the
   console's approval hook in routes/tables.js, so the rule is written once.
   ═══════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const TYPES = {
  stokvel_constitution: { label: 'Constitution or rules', need: 1 },
  stokvel_bank_proof:   { label: 'Proof of the group’s bank account', need: 1 },
  stokvel_signatory_id: { label: 'Signatory’s ID document', need: 'signatories' },
  stokvel_resolution:   { label: 'Minutes or resolution appointing the signatories', need: 0 },
};
const MAX_BYTES = 5 * 1024 * 1024;
const DATA_URL  = /^data:(application\/pdf|image\/jpeg|image\/png|image\/webp|image\/heic);base64,([A-Za-z0-9+/=]+)$/;
const MIN_SIGNATORY_IDS = 2;

function signatoriesNeeded(group) {
  return Math.max(MIN_SIGNATORY_IDS, Number(group && group.stokvel_quorum) || 0);
}

async function list(db, groupId) {
  const { rows } = await db.query(
    `SELECT d.id, d.doc_type, d.doc_subtype, d.file_name, d.status, d.notes,
            COALESCE(d.submitted_at, d.created_at) AS submitted_at,
            u.first_name AS uploaded_by_name,
            s.first_name AS signatory_first_name, s.last_name AS signatory_last_name
       FROM kyc_documents d
       LEFT JOIN investors u ON u.id = d.investor_id
       LEFT JOIN investors s ON s.id = d.doc_subtype
      WHERE d.sub_account_id = $1 AND d.doc_type LIKE 'stokvel\\_%'
      ORDER BY COALESCE(d.submitted_at, d.created_at) DESC`, [groupId]);
  return rows;
}

/* Where each requirement stands: 'approved', 'pending', 'rejected' or
   'missing'. A newer document of a type supersedes an older one, so a
   rejected constitution followed by a new upload reads as pending. */
function requirements(rows, group) {
  const latest = new Map();
  for (const r of rows) {                     // rows arrive newest first
    const key = r.doc_type === 'stokvel_signatory_id' ? `${r.doc_type}:${r.doc_subtype}` : r.doc_type;
    if (!latest.has(key)) latest.set(key, r);
  }
  const one = type => {
    const r = latest.get(type);
    return { type, label: TYPES[type].label, status: r ? r.status : 'missing', notes: r && r.status === 'rejected' ? r.notes : null };
  };
  const ids = [...latest.entries()].filter(([k]) => k.startsWith('stokvel_signatory_id:')).map(([, r]) => r);
  const need = signatoriesNeeded(group);
  const approvedIds = ids.filter(r => r.status === 'approved').length;
  const sentIds = ids.filter(r => r.status !== 'rejected').length;
  return {
    items: [
      one('stokvel_constitution'),
      one('stokvel_bank_proof'),
      { type: 'stokvel_signatory_id', label: TYPES.stokvel_signatory_id.label, need,
        approved: approvedIds, sent: sentIds,
        status: approvedIds >= need ? 'approved' : sentIds >= need ? 'pending' : 'missing',
        rejected: ids.filter(r => r.status === 'rejected').map(r =>
          ({ name: [r.signatory_first_name, r.signatory_last_name].filter(Boolean).join(' '), notes: r.notes })) },
    ],
  };
}

function verified(rows, group) {
  return requirements(rows, group).items.every(i => i.status === 'approved');
}
/* Everything required has been sent and none of it is waiting on the group. */
function allSent(rows, group) {
  return requirements(rows, group).items.every(i => i.status === 'approved' || i.status === 'pending');
}

/* Shape-check an upload. Returns { doc } or { error }. */
function parseUpload(body) {
  const b = body || {};
  const docType = String(b.doc_type || '');
  if (!TYPES[docType]) return { error: 'Choose what kind of document this is.' };
  const fileName = String(b.file_name || '').trim().slice(0, 160);
  if (!fileName) return { error: 'The file needs a name.' };
  const m = DATA_URL.exec(String(b.file_data || ''));
  if (!m) return { error: 'Send a PDF, or a photo (JPG, PNG, WEBP or HEIC).' };
  const bytes = Math.floor(m[2].length * 3 / 4);
  if (bytes > MAX_BYTES) return { error: 'The file must be under 5 MB.' };
  const signatory = String(b.signatory_investor_id || '').trim() || null;
  if (docType === 'stokvel_signatory_id' && !signatory) {
    return { error: 'Say whose ID document this is.' };
  }
  return { doc: { docType, fileName, fileData: String(b.file_data), signatory: docType === 'stokvel_signatory_id' ? signatory : null, bytes } };
}

/**
 * Store a group document. The caller has checked the uploader may.
 * Returns { id, status, group_status } or { error }.
 */
async function upload(client, group, uploaderId, doc) {
  let signatoryName = null;
  if (doc.signatory) {
    /* A signatory, or somebody asked to be one: their ID is needed before
       they confirm, so the committee can send it while the group is still
       setting up. Anybody else's ID has no place in the group's file. */
    const { rows: [m] } = await client.query(
      `SELECT i.first_name, i.last_name FROM stokvel_members sm JOIN investors i ON i.id = sm.investor_id
        WHERE sm.sub_account_id = $1 AND sm.investor_id = $2 AND sm.status = 'active'
          AND (sm.is_signatory OR sm.signatory_nominated_at IS NOT NULL)`, [group.id, doc.signatory]);
    if (!m) return { error: 'That person is not a signatory of this group, or asked to be one.' };
    signatoryName = [m.first_name, m.last_name].filter(Boolean).join(' ');
  }
  const { rows: [u] } = await client.query(`SELECT first_name, last_name FROM investors WHERE id = $1`, [uploaderId]);
  const uploader = u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : uploaderId;
  const id = 'KYC-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
  await client.query(
    `INSERT INTO kyc_documents (id, investor_id, sub_account_id, doc_type, doc_subtype, status,
                                file_name, file_data, investor_name, notes, submitted_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,NOW())`,
    [id, uploaderId, group.id, doc.docType, doc.signatory, doc.fileName, doc.fileData,
     `${group.name} (group)`,
     `Group document for ${group.name} (${group.id}): ${TYPES[doc.docType].label}`
       + (signatoryName ? ` — ${signatoryName}` : '')
       + `. Uploaded by ${uploader}. ${(doc.bytes / 1024).toFixed(0)} KB.`]);

  /* Under review once everything required is in, not on the first file: a
     group that has sent one of three documents is not "being checked". */
  let groupStatus = group.kyc_status || 'pending';
  if (groupStatus !== 'approved') {
    const rows = await list(client, group.id);
    const next = allSent(rows, group) ? 'under_review' : 'pending';
    if (next !== groupStatus) {
      await client.query(`UPDATE sub_accounts SET kyc_status = $2, updated_at = NOW() WHERE id = $1`, [group.id, next]);
      groupStatus = next;
    }
  }
  return { id, status: 'pending', group_status: groupStatus };
}

/* Called by the console when a document of a group is approved or
   rejected. Approves the group once the requirements are met; puts a
   group under review back to pending when something it sent is rejected,
   so its checklist asks again. Returns 'approved', 'pending' or null. */
async function afterReview(db, groupId) {
  const { rows: [g] } = await db.query(
    `SELECT id, name, kyc_status, stokvel_quorum, account_type, parent_investor_id FROM sub_accounts WHERE id = $1`, [groupId]);
  if (!g || g.account_type !== 'stokvel' || g.kyc_status === 'approved') return null;
  const rows = await list(db, groupId);
  if (verified(rows, g)) {
    await db.query(`UPDATE sub_accounts SET kyc_status = 'approved', updated_at = NOW() WHERE id = $1`, [groupId]);
    return 'approved';
  }
  if (g.kyc_status === 'under_review' && !allSent(rows, g)) {
    await db.query(`UPDATE sub_accounts SET kyc_status = 'pending', updated_at = NOW() WHERE id = $1`, [groupId]);
    return 'pending';
  }
  return null;
}

module.exports = { TYPES, MAX_BYTES, signatoriesNeeded, list, requirements, verified, allSent,
                   parseUpload, upload, afterReview };
