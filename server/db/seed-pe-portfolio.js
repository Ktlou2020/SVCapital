/* One-time seed: PE Portfolio companies from signed partnership agreements */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pool = require('./pool');

const companies = [
  {
    id:                  'peco-hb-svc-2025',
    name:                'Hillermann Brothers Properties Proprietary Limited',
    sector:              'Property',
    registration_number: '2001/016603/07',
    status:              'portfolio',
    aum_amount:          300000000.00,
    entry_date:          '2025-07-01',
    fee_billing_period:  'monthly',
    notes: [
      'Partnership: Hillerman Brothers (HB SVC Partnership)',
      'Partners: The EHH Trust (IT1257/2001 N), The FEH Trust (IT1258/2001 N), The IKH Trust (IT1259/2001 N), The GJH Trust (IT1260/2001 N)',
      'SV Capital entity: SV Capital Private Equity (2025/427021/07)',
      'SV Capital equity stake: 51%',
      'Monthly management fee: R10,400 (SVC share: R5,304 | Partner share: R5,096)',
    ].join('\n'),
  },
  {
    id:                  'peco-sas-svc-2025',
    name:                'Scientific Aquatic Services Pty Ltd',
    sector:              'Other',
    sub_sector:          'Aquatic Services',
    registration_number: '2022/495100/07',
    status:              'portfolio',
    aum_amount:          1000.00,
    entry_date:          '2025-07-01',
    fee_billing_period:  'monthly',
    contact_name:        'Stephen van Staden',
    notes: [
      'Partnership: Stephen van Staden (SAS SVC Partnership)',
      'Partner: Stephen van Staden (ID: 7907135015088)',
      'SV Capital entity: SV Capital Private Equity (2025/427021/07)',
      'SV Capital equity stake: 51%',
      'Monthly management fee: R40,000 (SVC share: R20,400 | Partner share: R19,600)',
    ].join('\n'),
  },
  {
    id:                  'peco-gma-svc-2025',
    name:                'GM Associates Proprietary Limited',
    sector:              'Other',
    registration_number: '2013/194929/07',
    status:              'portfolio',
    aum_amount:          50000000.00,
    entry_date:          '2025-07-01',
    fee_billing_period:  'monthly',
    notes: [
      'Partnership: GIANT KINGFISHER INVESTMENTS PROPRIETARY LIMITED (GMA SVC PARTNERSHIP)',
      'Partner: Giant Kingfisher Investments (Pty) Ltd (2024/673575/07)',
      'SV Capital entity: SV Capital Private Equity (2025/427021/07)',
      'SV Capital equity stake: 51%',
      'Monthly management fee: R40,000 (SVC share: R20,400 | Partner share: R19,600)',
    ].join('\n'),
  },
  {
    id:                  'peco-edelsenz-svc-2025',
    name:                'EdelSenz Proprietary Limited',
    sector:              'Other',
    registration_number: '2025/137242/07',
    status:              'portfolio',
    aum_amount:          25000000.00,
    entry_date:          '2025-08-01',
    fee_billing_period:  'monthly',
    notes: [
      'Partnership: EdelSenz Proprietary Limited (EDELSENZ SVC)',
      'Partners: Karen Lynell Meyer (860421 0027 083), Yolande Schulz (851108 0016 080), Xalo Holdings (Pty) Ltd (2022/878106/07)',
      'SV Capital entity: SV Capital Private Equity (2025/427021/07)',
      'SV Capital equity stake: 51%',
      'Monthly management fee: R6,500 (SVC share: R3,315 | Partner share: R3,185)',
    ].join('\n'),
  },
  {
    id:                  'peco-steelstudio-svc-2026',
    name:                'New Steel Studio Proprietary Limited',
    sector:              'Manufacturing',
    registration_number: '2017/155319/07',
    status:              'portfolio',
    aum_amount:          null,
    entry_date:          '2026-08-01',
    fee_billing_period:  'monthly',
    notes: [
      'Partnership: Steel Studio SVC Partnership',
      'Partners: Oxford Nominees, SA Kobo Property Investments, Blue Jackel Fritz Investments, Timeless Traditions Holdings, Robert Charles Sines, Seashore Investments',
      'SV Capital entity: SV Capital Private Equity (2025/427021/07)',
      'SV Capital equity stake: 51%',
      'Monthly management fee: R10,500 (SVC share: R5,355 | Partner share: R5,145)',
    ].join('\n'),
  },
];

// Monthly management fees (one current-month record per company)
// Columns: company_id, fee_total, fee_svc (51%), entry_date
const feeData = [
  { companyId: 'peco-hb-svc-2025',         entryDate: '2025-07-01', totalFee: 10400.00 },
  { companyId: 'peco-sas-svc-2025',         entryDate: '2025-07-01', totalFee: 40000.00 },
  { companyId: 'peco-gma-svc-2025',         entryDate: '2025-07-01', totalFee: 40000.00 },
  { companyId: 'peco-edelsenz-svc-2025',    entryDate: '2025-08-01', totalFee: 6500.00  },
  { companyId: 'peco-steelstudio-svc-2026', entryDate: '2026-08-01', totalFee: 10500.00 },
];

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure pe_companies table exists (harmless if already there)
    await client.query(`
      CREATE TABLE IF NOT EXISTS pe_companies (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        sector          TEXT,
        sub_sector      TEXT,
        country         TEXT DEFAULT 'South Africa',
        city            TEXT,
        description     TEXT,
        website         TEXT,
        registration_number TEXT,
        vat_number      TEXT,
        founded_year    INT,
        employee_count  INT,
        status          TEXT DEFAULT 'prospect',
        aum_amount      NUMERIC(18,2),
        fee_rate        NUMERIC(8,6),
        fee_billing_period TEXT,
        entry_date      DATE,
        contact_name    TEXT,
        contact_email   TEXT,
        contact_phone   TEXT,
        notes           TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pe_fees (
        id              TEXT PRIMARY KEY,
        company_id      TEXT NOT NULL REFERENCES pe_companies(id) ON DELETE CASCADE,
        period_start    DATE NOT NULL,
        period_end      DATE NOT NULL,
        fee_type        TEXT DEFAULT 'management',
        amount          NUMERIC(18,2) NOT NULL,
        status          TEXT DEFAULT 'invoiced',
        invoice_date    DATE,
        due_date        DATE,
        paid_date       DATE,
        invoice_number  TEXT,
        notes           TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Insert companies (skip if already exists)
    for (const co of companies) {
      const cols  = Object.keys(co);
      const vals  = Object.values(co);
      const phs   = cols.map((_, i) => `$${i + 1}`).join(', ');
      const colStr = cols.join(', ');
      await client.query(
        `INSERT INTO pe_companies (${colStr}) VALUES (${phs})
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           sector = EXCLUDED.sector,
           registration_number = EXCLUDED.registration_number,
           status = EXCLUDED.status,
           aum_amount = EXCLUDED.aum_amount,
           entry_date = EXCLUDED.entry_date,
           notes = EXCLUDED.notes,
           updated_at = NOW()`,
        vals
      );
      console.log(`  ✅  ${co.name}`);
    }

    // Insert initial fee records (skip if company already has a fee for that period)
    for (const fd of feeData) {
      const entry  = new Date(fd.entryDate);
      const pStart = fd.entryDate;
      // period_end = last day of the same month
      const pEnd = new Date(entry.getFullYear(), entry.getMonth() + 1, 0).toISOString().split('T')[0];
      const feeId  = `pefee-seed-${fd.companyId}`;

      await client.query(
        `INSERT INTO pe_fees (id, company_id, period_start, period_end, fee_type, amount, status, notes)
         VALUES ($1, $2, $3, $4, 'management', $5, 'invoiced',
                 'Initial management fee — 51% SV Capital share: R' || round($5 * 0.51)::text ||
                 ' | 49% partner share: R' || round($5 * 0.49)::text)
         ON CONFLICT (id) DO NOTHING`,
        [feeId, fd.companyId, pStart, pEnd, fd.totalFee]
      );
      console.log(`  💰  Fee for ${fd.companyId}: R${fd.totalFee.toLocaleString()} (${pStart} – ${pEnd})`);
    }

    await client.query('COMMIT');
    console.log('\n✅  Seed complete — 5 portfolio companies + 5 fee records inserted.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌  Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
