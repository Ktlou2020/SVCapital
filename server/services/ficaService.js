/* ═══════════════════════════════════════════════════════
   FICA Service — core check runner used by routes + cron
   ═══════════════════════════════════════════════════════ */
'use strict';

const pool   = require('../db/pool');
const smile     = require('./smileIdentity');
const stitch    = require('./stitch');
const datanamix = require('./datanamix');

/* ─── Country code lookup ─────────────────────────────── */
const NATIONALITY_TO_CODE = {
  /* investors.nationality defaults to South African, so this map has to be able
     to answer for it. It could not: every other entry here is a foreign
     nationality, because the only caller is the passport branch below and the
     signup form only asks the question on the international path. A default
     the codebase's own mapper throws on is a trap laid for whoever wires the
     column into a verification call. */
  'south african':  'ZA',
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
  const nationalityCode = NATIONALITY_TO_CODE[(nationality || '').toLowerCase()];
  if (!nationalityCode) {
    console.error('[ficaService] Unknown nationality:', nationality);
    throw new Error('Unsupported nationality: ' + nationality);
  }
  return nationalityCode;
}

/* ─── Generate FICA check ID ──────────────────────────── */
function ficaId() {
  return `FICA-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/* ═══════════════════════════════════════════════════════════════════════
   runFicaCheck(investor, trigger)

   trigger: 'first_deposit' | 'annual_recheck' | 'manual' | 'webhook'

   1. Detect SA ID vs Passport from investor.notes field
   2. ID check — Datanamix Real-Time IDV (Home Affairs) for an SA ID when
      DATANAMIX_ENV is set; Smile Identity for passports, and for everything
      when it is not
   3. Bank account check — Datanamix AVS when enabled, otherwise Stitch
   4. Sanctions / PEP screen — Datanamix when enabled, otherwise skipped
   5. Write result to fica_checks table
   6. Update investor kyc_status + last_auto_fica_check
   Returns: { checkId, idStatus, bankStatus, sanctionsStatus, overallStatus }
   ═══════════════════════════════════════════════════════════════════════ */
async function runFicaCheck(investor, trigger) {
  const { id: investorId, first_name, last_name, id_number, notes, date_of_birth } = investor;

  // Prefer doc_subtype from kyc_documents if available; fall back to legacy notes field
  let isPassport = (notes || '').includes('DocType: Passport');
  try {
    const { rows: latestIdDoc } = await pool.query(
      `SELECT doc_subtype FROM kyc_documents WHERE investor_id = $1 AND doc_type = 'id_document' AND doc_subtype IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [investorId]
    );
    if (latestIdDoc[0]?.doc_subtype) {
      isPassport = latestIdDoc[0].doc_subtype === 'passport';
    }
  } catch (_) {}

  const useDatanamix = datanamix.enabled();

  /* ── 1. ID / Passport check ──
     Datanamix's Real-Time IDV reads Home Affairs, which knows SA ID numbers
     and nothing else, so a passport still goes to Smile. */
  let idResult, idStatus;
  try {
    if (useDatanamix && !isPassport) {
      const raw    = await datanamix.verifyIdRealtime({ idNumber: id_number });
      const mapped = datanamix.mapIdResult(raw, investor);
      idStatus = mapped.status;
      idResult = { provider: 'datanamix', product: 'realtime_idv', reasons: mapped.reasons, response: raw };
      if (idStatus === 'error') idResult.error = mapped.reasons.join('; ') || 'Datanamix returned no answer';
    } else if (isPassport) {
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
    if (!idStatus) idStatus = smile.mapResult(idResult);
  } catch (err) {
    const provider = useDatanamix && !isPassport ? 'datanamix' : 'smile';
    console.error(`[FICA] ${provider} ID error for ${investorId}:`, err.message);
    idResult = { provider, error: err.message };
    idStatus = 'error';
  }

  /* ── 2. Bank account check ── */
  let bankResult = null, bankStatus = 'skipped';
  if (useDatanamix) {
    ({ bankResult, bankStatus } = await _datanamixBank(investor, isPassport));
  } else try {
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

  /* ── 3. Sanctions / PEP screen ── */
  let sanctionsResult = null, sanctionsStatus = 'skipped';
  if (useDatanamix) {
    try {
      let country = 'ZA';
      if (isPassport) {
        const natMatch = (notes || '').match(/Nationality:\s*([^.]+)/);
        try { country = nationalityToCode(natMatch ? natMatch[1].trim() : investor.nationality); } catch (_) { country = 'ZA'; }
      }
      const raw    = await datanamix.screenIndividual({
        reference:   `SVC-${investorId}`,
        firstName:   first_name,
        lastName:    last_name,
        dateOfBirth: date_of_birth,
        idNumber:    id_number,
        country,
      });
      const mapped = datanamix.mapSanctionsResult(raw);
      sanctionsStatus = mapped.status;
      sanctionsResult = { provider: 'datanamix', product: 'sanctions_standard', ...mapped, response: raw };
    } catch (err) {
      console.error(`[FICA] Datanamix sanctions error for ${investorId}:`, err.message);
      sanctionsResult = { provider: 'datanamix', error: err.message };
      sanctionsStatus = 'error';
    }
  }

  /* ── 4. Derive overall status ── */
  let overallStatus;
  if (idStatus === 'error') {
    overallStatus = 'error';
  } else if (idStatus === 'fail') {
    overallStatus = 'fail';
  } else if (sanctionsStatus === 'hit') {
    /* A possible sanctions or PEP match is never ours to clear or to act on
       automatically: it goes to a person, whatever else passed. */
    overallStatus = 'manual_review';
  } else if (idStatus === 'pass' && (bankStatus === 'pass' || bankStatus === 'skipped')
             && (sanctionsStatus === 'clear' || sanctionsStatus === 'skipped')) {
    overallStatus = 'pass';
  } else if (idStatus === 'manual_review' || bankStatus === 'manual_review') {
    overallStatus = 'manual_review';
  } else if (bankStatus === 'error' || sanctionsStatus === 'error') {
    // A bank or screening error shouldn't block an ID pass — but it is not a
    // pass either: somebody has to look.
    overallStatus = idStatus === 'pass' && bankStatus !== 'fail' ? 'manual_review' : 'fail';
  } else {
    overallStatus = 'fail';
  }

  /* ── 5. Persist to fica_checks ── */
  const checkId = ficaId();
  await pool.query(
    `INSERT INTO fica_checks
       (id, investor_id, trigger, id_check_status, bank_check_status,
        sanctions_check_status, overall_status, id_result, bank_result,
        sanctions_result, check_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
    [
      checkId, investorId, trigger,
      idStatus, bankStatus, sanctionsStatus, overallStatus,
      JSON.stringify(idResult || {}),
      JSON.stringify(bankResult || {}),
      JSON.stringify(sanctionsResult || {}),
    ]
  );

  /* ── 6. Update investor record ── */
  const newKycStatus =
    overallStatus === 'pass'           ? 'verified' :
    overallStatus === 'fail'           ? 'rejected' :
    overallStatus === 'manual_review'  ? 'pending'  :
    overallStatus === 'error'          ? 'pending'  : null;

  /* THE STAMP IS NOT WRITTEN WHEN THE PROVIDER ERRORED.
   *
   * last_auto_fica_check is the column the nightly sweep's first-deposit
   * batch tests for: `WHERE last_auto_fica_check IS NULL`. Stamping it on
   * every outcome meant an error — a provider that is down, or whose
   * credentials are not configured — counted as having checked the person.
   * One such sweep silently marked every depositor as checked and dropped
   * them out of that batch for a YEAR, until the annual window reopened.
   *
   * That is what production has been doing: the sweep has reported
   * "0 annual re-checks, 0 first-deposit checks" every night, with no
   * provider keys set and so no verification ever performed.
   *
   * An error means we did not check them. The row in fica_checks records
   * that the attempt happened and what went wrong; the investor stays in
   * the queue, which is where somebody not yet verified belongs. */
  const checked = overallStatus !== 'error';
  const sets = [
    checked ? 'last_auto_fica_check = NOW()' : null,
    'fica_auto_status = $1',
    newKycStatus ? 'kyc_status = $3' : null,
    'updated_at = NOW()',
  ].filter(Boolean);

  await pool.query(
    `UPDATE investors SET ${sets.join(', ')} WHERE id = $2`,
    newKycStatus
      ? [overallStatus, investorId, newKycStatus]
      : [overallStatus, investorId]
  );

  /* And say so where somebody can act. A verification provider that cannot
     answer is not a client's problem and not a thing to leave in a log:
     until it is fixed, nobody is being verified at all. Incidents fold by
     fingerprint, so a sweep of fifty raises one row with a count, not fifty.
     Reported, never thrown — a broken alerter must not also lose the check. */
  if (!checked) {
    try {
      await require('./incidents').report(
        new Error('FICA verification is not running: the ID provider returned an error. '
                + 'No investor can be verified until it answers. '
                + `Last: ${(idResult && idResult.error) || 'unknown error'}`),
        { source: 'fica', severity: 'critical' });
    } catch (e) { console.error('[FICA] could not raise incident:', e.message); }
  }

  /* A possible sanctions/PEP match is a compliance event with a deadline,
     not a status to be found by whoever next opens this client. Raised on
     its own fingerprint per investor, so two hits are two rows. */
  if (sanctionsStatus === 'hit') {
    try {
      await require('./incidents').report(
        new Error(`Possible sanctions/PEP match for investor ${investorId} `
                + `(${first_name || ''} ${last_name || ''}). Their FICA check is held for review: `
                + (sanctionsResult.reasons || []).slice(0, 3).join('; ')),
        { source: 'fica', severity: 'critical' });
    } catch (e) { console.error('[FICA] could not raise sanctions incident:', e.message); }
  }

  console.log(`[FICA] ${investorId} | ${trigger} | id:${idStatus} bank:${bankStatus} sanctions:${sanctionsStatus} → ${overallStatus}`);
  return { checkId, idStatus, bankStatus, sanctionsStatus, overallStatus };
}

/* ─── Datanamix AVS for the account we would pay this client into ────
   The profile's bank details first — they are what payouts use — and the
   latest maturity instruction's when the profile has none, which is where
   the Stitch path has always looked. */
async function _datanamixBank(investor, isPassport) {
  const { id: investorId, first_name, last_name, id_number } = investor;
  let acct = null;
  try {
    const { rows: [p] } = await pool.query(
      `SELECT bank_name, bank_account_number, bank_branch_code, bank_account_type,
              bank_account_holder, phone, email
         FROM investors WHERE id = $1`, [investorId]);
    if (p && p.bank_account_number) {
      acct = { number: p.bank_account_number, bank: p.bank_name, branch: p.bank_branch_code,
               type: p.bank_account_type, phone: p.phone, email: p.email };
    } else {
      const { rows: [m] } = await pool.query(
        `SELECT account_number, bank_name, branch_code
           FROM maturity_instructions
          WHERE investor_id = $1 AND account_number IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`, [investorId]);
      if (m && m.account_number) {
        acct = { number: m.account_number, bank: m.bank_name, branch: m.branch_code,
                 phone: p && p.phone, email: p && p.email };
      }
    }
  } catch (err) {
    return { bankStatus: 'error', bankResult: { provider: 'datanamix', error: err.message } };
  }

  if (!acct) return { bankStatus: 'skipped', bankResult: null };

  const branch = acct.branch || datanamix.universalBranchCode(acct.bank);
  if (!branch) {
    return { bankStatus: 'manual_review', bankResult: { provider: 'datanamix',
      reasons: [`No branch code on file and none known for "${acct.bank || 'unnamed bank'}"`] } };
  }

  try {
    const raw = await datanamix.verifyBankAccount({
      reference:     `SVC-${investorId}`,
      idNumber:      id_number,
      identityType:  isPassport ? 'Passport' : 'IDNumber',
      firstName:     first_name,
      lastName:      last_name,
      accountNumber: acct.number,
      branchCode:    branch,
      accountType:   acct.type,
      mobile:        acct.phone,
      email:         acct.email,
    });
    const mapped = datanamix.mapAvsResult(raw);
    return { bankStatus: mapped.status,
             bankResult: { provider: 'datanamix', product: 'avs', reasons: mapped.reasons, response: raw } };
  } catch (err) {
    console.error(`[FICA] Datanamix AVS error for ${investorId}:`, err.message);
    return { bankStatus: 'error', bankResult: { provider: 'datanamix', error: err.message } };
  }
}

module.exports = { runFicaCheck, nationalityToCode };
