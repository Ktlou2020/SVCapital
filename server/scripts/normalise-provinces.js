/**
 * One-off script: normalise all province values to canonical SA names.
 * Run: DATABASE_URL=<url> node server/scripts/normalise-provinces.js
 */
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
});

// Canonical SA province names
const PROVINCE_MAP = {
  // Gauteng
  'gp':                    'Gauteng',
  'gauteng':               'Gauteng',
  'gauteng province':      'Gauteng',

  // Western Cape
  'wc':                    'Western Cape',
  'western cape':          'Western Cape',
  'western cape province': 'Western Cape',
  'westerncape':           'Western Cape',

  // Eastern Cape
  'ec':                    'Eastern Cape',
  'eastern cape':          'Eastern Cape',
  'eastern cape province': 'Eastern Cape',
  'easterncape':           'Eastern Cape',

  // KwaZulu-Natal
  'kzn':                   'KwaZulu-Natal',
  'kwazulu-natal':         'KwaZulu-Natal',
  'kwazulu natal':         'KwaZulu-Natal',
  'kwa-zulu natal':        'KwaZulu-Natal',
  'kwa zulu natal':        'KwaZulu-Natal',
  'kwazulunatal':          'KwaZulu-Natal',
  'natal':                 'KwaZulu-Natal',

  // Limpopo
  'lp':                    'Limpopo',
  'limpopo':               'Limpopo',
  'limpopo province':      'Limpopo',

  // Mpumalanga
  'mp':                    'Mpumalanga',
  'mpumalanga':            'Mpumalanga',
  'mpumalanga province':   'Mpumalanga',

  // Northern Cape
  'nc':                    'Northern Cape',
  'northern cape':         'Northern Cape',
  'northern cape province':'Northern Cape',
  'northerncape':          'Northern Cape',

  // North West
  'nw':                    'North West',
  'north west':            'North West',
  'north west province':   'North West',
  'northwest':             'North West',
  'north-west':            'North West',

  // Free State
  'fs':                    'Free State',
  'free state':            'Free State',
  'free state province':   'Free State',
  'freestate':             'Free State',
};

function canonical(raw) {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return PROVINCE_MAP[key] || null;
}

async function run() {
  console.log('🗺  Province normalisation starting…\n');

  // ── investors.province ─────────────────────────────────────
  const { rows: investors } = await pool.query(
    `SELECT id, province FROM investors WHERE province IS NOT NULL AND province != ''`
  );
  console.log(`Found ${investors.length} investors with a province value.`);

  let invChanged = 0, invSkipped = 0;
  for (const inv of investors) {
    const norm = canonical(inv.province);
    if (!norm) {
      console.log(`  ⚠  investor ${inv.id}: unrecognised province "${inv.province}" — skipped`);
      invSkipped++;
      continue;
    }
    if (norm === inv.province.trim()) { invSkipped++; continue; }
    await pool.query(`UPDATE investors SET province = $1 WHERE id = $2`, [norm, inv.id]);
    console.log(`  ✓  investor ${inv.id}: "${inv.province}" → "${norm}"`);
    invChanged++;
  }
  console.log(`\nInvestors: ${invChanged} updated, ${invSkipped} already correct / unrecognised.\n`);

  // ── employees.address_province ──────────────────────────────
  const { rows: employees } = await pool.query(
    `SELECT id, address_province FROM employees WHERE address_province IS NOT NULL AND address_province != ''`
  );
  console.log(`Found ${employees.length} employees with an address_province value.`);

  let empChanged = 0, empSkipped = 0;
  for (const emp of employees) {
    const norm = canonical(emp.address_province);
    if (!norm) {
      console.log(`  ⚠  employee ${emp.id}: unrecognised province "${emp.address_province}" — skipped`);
      empSkipped++;
      continue;
    }
    if (norm === emp.address_province.trim()) { empSkipped++; continue; }
    await pool.query(`UPDATE employees SET address_province = $1 WHERE id = $2`, [norm, emp.id]);
    console.log(`  ✓  employee ${emp.id}: "${emp.address_province}" → "${norm}"`);
    empChanged++;
  }
  console.log(`\nEmployees: ${empChanged} updated, ${empSkipped} already correct / unrecognised.\n`);

  console.log('✅ Province normalisation complete.');
  await pool.end();
}

run().catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
