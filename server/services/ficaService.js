/* ═══════════════════════════════════════════════════════
   FICA Service — core check runner used by routes + cron
   ═══════════════════════════════════════════════════════ */
'use strict';

const pool   = require('../db/pool');
const smile  = require('./smileIdentity');
const stitch = require('./stitch');

/* ─── Country code lookup ─────────────────────────────── */
const NATIONALITY_TO_CODE = {
  zimbabwean:       'ZW', namibian:    'NA', batswana:    'BW', zambian:    'ZM',
  mozambican:       'MZ', basotho:     'LS', swazi:       'SZ', kenyan:     'KE',
  nigerian:         'NG', ghanaian:    'GH', tanzanian:   'TZ', ugandan:    'UG',
  rwandan:          'RW', ethiopian:   'ET', egyptian:    'EG', moroccan:   'MA',
  british:          'GB', german:      'DE', dutch:       'NL', french:     'FR',
  portuguese:       'PT', spanish:     'ES', italian:     'IT', swiss:      'CH',
  swedish:          'SE', belgian:     'BE', american:    'US', canadian:   'CA',
  australian:       'AU', 'new zealander': 'NZ',
  emirati:          'AE', 'saudi arabian': 'SA', qatari: 'QA',
  indian:           'IN', chinese:     'CN', singaporean: 'SG',
};

function nationalityToCode(nationality) {
  return NATIONALITY_TO_CODE[(nationality || '').toLowerCase()] || 'ZW';
}

/* ─── Generate FICA check ID ──────────────────────────── */
function ficaId() {
  return `FICA-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/* ═══════════════════════════════════════════════════════════════════════
   runFicaCheck(investor, trigger)

   trigger: 'first_deposit' | 'annual_recheck' | 'manual' | 'webhook'

   1. Detect SA ID vs Passport from investor.notes field
   2. Call Smile Identity for ID check
   3. Call Stitch for bank account check (if maturity instructions exist)
   4. Write result to fica_checks table
   5. Update investor kyc_status + last_auto_fica_check
   Returns: { checkId, idStatus, bankStatus, overallStatus }
   ═══════════════════════════════════════════════════════════════════════ */
async function runFicaCheck(investor, trigger) {
  const { id: investorId, first_name, last_name, id_number, notes, date_of_birth } = investor;

  const isPassport = (notes || '').includes('DocType: Passport');

  /* ── 1. ID / Passport check ── */
  let idResult, idStatus;
  try {
    if (isPassport) {
      const natMatch = (notes || '').match(/Nationality:\s*([^.]+)/);
      const country  = natMatch ? nationalityToCode(natMatch[1].trim()) : 'ZW';
      idResult = await smile.verifyPassport({
        passportNumber: id_number,
        country,
        firstName: first_name,
        lastName:  last_name,
      });
    } else {
      idResult = await smile.verifyID({
        idNumber:  id_number,
        idType:    'NATIONAL_ID',
        country:   'ZA',
        firstName: first_name,
        lastName:  last_name,
        dob:       date_of_birth || '',
      });
    }
    idStatus = smile.mapResult(idResult);
  } catch (err) {
    console.error(`[FICA] Smile error for ${investorId}:`, err.message);
    idResult = { error: err.message };
    idStatus = 'error';
  }

  /* ── 2. Bank account check ── */
  let bankResult = null, bankStatus = 'skipped';
  try {
    const { rows: mat } = await pool.query(
      `SELECT account_number, bank_name, account_holder
       FROM maturity_instructions
       WHERE investor_id = $1 AND account_number IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [investorId]
    );

    if (mat.length > 0 && mat[0].account_number) {
      const { account_number, bank_name, account_holder } = mat[0];
      bankResult = await stitch.verifyBankAccount({
        accountNumber: account_number,
        bankId:        stitch.normaliseBankId(bank_name),
        accountHolder: account_holder || `${first_name} ${last_name}`,
      });
      bankStatus = bankResult.verified ? 'pass' : 'fail';
    }
  } catch (err) {
    console.error(`[FICA] Stitch error for ${investorId}:`, err.message);
    bankResult = { error: err.message };
    bankStatus = 'error';
  }

  /* ── 3. Derive overall status ── */
  let overallStatus;
  if (idStatus === 'error') {
    overallStatus = 'error';
  } else if (idStatus === 'pass' && (bankStatus === 'pass' || bankStatus === 'skipped')) {
    overallStatus = 'pass';
  } else if (idStatus === 'manual_review' || bankStatus === 'manual_review') {
    overallStatus = 'manual_review';
  } else if (bankStatus === 'error') {
    // Bank error shouldn't block ID pass — flag for review
    overallStatus = idStatus === 'pass' ? 'manual_review' : 'fail';
  } else {
    overallStatus = 'fail';
  }

  /* ── 4. Persist to fica_checks ── */
  const checkId = ficaId();
  await pool.query(
    `INSERT INTO fica_checks
       (id, investor_id, trigger, id_check_status, bank_check_status,
        overall_status, id_result, bank_result, check_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
    [
      checkId, investorId, trigger,
      idStatus, bankStatus, overallStatus,
      JSON.stringify(idResult || {}),
      JSON.stringify(bankResult || {}),
    ]
  );

  /* ── 5. Update investor record ── */
  const newKycStatus =
    overallStatus === 'pass'           ? 'verified' :
    overallStatus === 'fail'           ? 'rejected' :
    overallStatus === 'manual_review'  ? 'pending'  : null;

  await pool.query(
    `UPDATE investors SET
       last_auto_fica_check = NOW(),
       fica_auto_status     = $1,
       ${newKycStatus ? 'kyc_status = $3,' : ''}
       updated_at = NOW()
     WHERE id = $2`,
    newKycStatus
      ? [overallStatus, investorId, newKycStatus]
      : [overallStatus, investorId]
  );

  console.log(`[FICA] ${investorId} | ${trigger} | id:${idStatus} bank:${bankStatus} → ${overallStatus}`);
  return { checkId, idStatus, bankStatus, overallStatus };
}

module.exports = { runFicaCheck, nationalityToCode };
