#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   SV Capital — Accounting Sync Script
   ───────────────────────────────────────────────────────────────────────
   Reads all investor deposits, withdrawals and investments from the
   database (or falls back to seed data) and computes the correct
   double-entry journal entries for Smartvest Financial Services FSP 52449.

   Outputs:
     • A JSON file (accounting-state.json) with the full localStorage state
       ready to be loaded into team/accounting.html
     • A summary report to stdout

   Usage:
     DATABASE_URL=postgres://... node server/scripts/accounting-sync.js
     node server/scripts/accounting-sync.js           # uses seed data fallback

   Load into accounting app:
     Open team/accounting-preload.html in a browser — it auto-injects the
     generated JSON into localStorage and redirects to accounting.html.
═══════════════════════════════════════════════════════════════════════ */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs   = require('fs');
const path = require('path');

/* ─── UID helper (same logic as accounting.html) ─── */
let _uidN = 1;
function uid() { return 'acct-' + (Date.now() + _uidN++).toString(36); }

const ZAR = n => 'R ' + parseFloat(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ═══════════════════════════════════════════════════════════
   SEED DATA FALLBACK (mirrors server/db/seed.js exactly)
══════════════════════════════════════════════════════════ */
const SEED_INVESTORS = [
  { id: 'INV-001', first_name: 'Thabo',  last_name: 'Nkosi'   },
  { id: 'INV-002', first_name: 'Priya',  last_name: 'Naidoo'  },
  { id: 'INV-003', first_name: 'Sipho',  last_name: 'Zulu'    },
  { id: 'INV-004', first_name: 'Maria',  last_name: 'Santos'  },
  { id: 'INV-005', first_name: 'James',  last_name: 'Mokoena' },
];

const SEED_TRANSACTIONS = [
  { id: 'TXN-001', investor_id: 'INV-001', type: 'deposit',    amount: 100000, status: 'completed', reference: 'DEP-001', created_at: '2024-01-10' },
  { id: 'TXN-003', investor_id: 'INV-001', type: 'deposit',    amount: 75000,  status: 'completed', reference: 'DEP-002', created_at: '2024-02-25' },
  { id: 'TXN-006', investor_id: 'INV-001', type: 'deposit',    amount: 50000,  status: 'completed', reference: 'DEP-003', created_at: '2024-01-28' },
  { id: 'TXN-008', investor_id: 'INV-002', type: 'deposit',    amount: 80000,  status: 'completed', reference: 'DEP-004', created_at: '2024-01-10' },
  { id: 'TXN-011', investor_id: 'INV-002', type: 'deposit',    amount: 60000,  status: 'completed', reference: 'DEP-005', created_at: '2024-02-25' },
  { id: 'TXN-013', investor_id: 'INV-003', type: 'deposit',    amount: 70000,  status: 'completed', reference: 'DEP-006', created_at: '2024-01-20' },
];

const SEED_INVESTMENTS = [
  { id: 'INV-TXN-001', investor_id: 'INV-001', pool_name: 'Cattle Finance Q1 2024',  amount: 100000, status: 'matured', start_date: '2024-01-15', end_date: '2024-07-15', actual_return: 7415,  expected_return: 7415  },
  { id: 'INV-TXN-002', investor_id: 'INV-001', pool_name: 'Solar Energy 7-Year',      amount: 75000,  status: 'active',  start_date: '2024-03-01', end_date: null,         actual_return: 0,     expected_return: 16050 },
  { id: 'INV-TXN-003', investor_id: 'INV-001', pool_name: 'Delivery Bikes Cycle 3',   amount: 50000,  status: 'active',  start_date: '2024-02-01', end_date: null,         actual_return: 0,     expected_return: 8000  },
  { id: 'INV-TXN-004', investor_id: 'INV-002', pool_name: 'Cattle Finance Q1 2024',  amount: 80000,  status: 'matured', start_date: '2024-01-15', end_date: '2024-07-15', actual_return: 5932,  expected_return: 5932  },
  { id: 'INV-TXN-005', investor_id: 'INV-002', pool_name: 'Solar Energy 7-Year',      amount: 60000,  status: 'active',  start_date: '2024-03-01', end_date: null,         actual_return: 0,     expected_return: 12840 },
  { id: 'INV-TXN-006', investor_id: 'INV-003', pool_name: 'SMME Short-Term Q2',       amount: 30000,  status: 'active',  start_date: '2024-04-01', end_date: null,         actual_return: 0,     expected_return: 1741.5},
  { id: 'INV-TXN-007', investor_id: 'INV-003', pool_name: 'Delivery Bikes Cycle 3',   amount: 40000,  status: 'active',  start_date: '2024-02-01', end_date: null,         actual_return: 0,     expected_return: 6400  },
  { id: 'INV-TXN-008', investor_id: 'INV-004', pool_name: 'Solar Energy 7-Year',      amount: 150000, status: 'active',  start_date: '2024-03-01', end_date: null,         actual_return: 0,     expected_return: 32100 },
  { id: 'INV-TXN-009', investor_id: 'INV-004', pool_name: 'Cattle Finance Q1 2024',  amount: 100000, status: 'matured', start_date: '2024-01-15', end_date: '2024-07-15', actual_return: 7415,  expected_return: 7415  },
  { id: 'INV-TXN-010', investor_id: 'INV-005', pool_name: 'SMME Short-Term Q2',       amount: 25000,  status: 'active',  start_date: '2024-04-01', end_date: null,         actual_return: 0,     expected_return: 1451.25 },
];

/* ═══════════════════════════════════════════════════════════
   DEFAULT COA (mirrors accounting.html DEFAULT_COA)
══════════════════════════════════════════════════════════ */
const DEFAULT_COA_DEFS = [
  { code: '1000', name: 'Cash and Bank',              type: 'asset',     category: 'current',   balance: 0 },
  { code: '1100', name: 'Accounts Receivable',        type: 'asset',     category: 'current',   balance: 0 },
  { code: '1200', name: 'Inventory',                  type: 'asset',     category: 'current',   balance: 0 },
  { code: '1300', name: 'Prepaid Expenses',           type: 'asset',     category: 'current',   balance: 0 },
  { code: '1400', name: 'Other Current Assets',       type: 'asset',     category: 'current',   balance: 0 },
  { code: '1500', name: 'Client Investment Portfolio',type: 'asset',     category: 'current',   balance: 0 },
  { code: '1600', name: 'Property & Equipment',       type: 'asset',     category: 'fixed',     balance: 0 },
  { code: '1700', name: 'Intangible Assets',          type: 'asset',     category: 'fixed',     balance: 0 },
  { code: '2000', name: 'Accounts Payable',           type: 'liability', category: 'current',   balance: 0 },
  { code: '2100', name: 'Client Funds Held (FSP)',    type: 'liability', category: 'current',   balance: 0 },
  { code: '2200', name: 'Short-term Loans',           type: 'liability', category: 'current',   balance: 0 },
  { code: '2500', name: 'Long-term Loans',            type: 'liability', category: 'long_term', balance: 0 },
  { code: '3000', name: 'Share Capital',              type: 'equity',    category: 'equity',    balance: 0 },
  { code: '3100', name: 'Retained Earnings',          type: 'equity',    category: 'equity',    balance: 0 },
  { code: '4000', name: 'Sales Revenue',              type: 'revenue',   category: 'operating', balance: 0 },
  { code: '4100', name: 'Platform Fee Revenue (1%)',  type: 'revenue',   category: 'operating', balance: 0 },
  { code: '4200', name: 'Investment Return Income',   type: 'revenue',   category: 'operating', balance: 0 },
  { code: '4300', name: 'Performance Fee Income',     type: 'revenue',   category: 'operating', balance: 0 },
  { code: '4400', name: 'Management Fee Income',      type: 'revenue',   category: 'operating', balance: 0 },
  { code: '5000', name: 'Cost of Sales',              type: 'expense',   category: 'cogs',      balance: 0 },
  { code: '6000', name: 'Salaries & Wages',           type: 'expense',   category: 'operating', balance: 0 },
  { code: '6100', name: 'Rent',                       type: 'expense',   category: 'operating', balance: 0 },
  { code: '6200', name: 'Utilities',                  type: 'expense',   category: 'operating', balance: 0 },
  { code: '6300', name: 'Marketing',                  type: 'expense',   category: 'operating', balance: 0 },
  { code: '6400', name: 'Professional Fees',          type: 'expense',   category: 'operating', balance: 0 },
  { code: '6500', name: 'Bank Charges',               type: 'expense',   category: 'operating', balance: 0 },
  { code: '6600', name: 'Depreciation',               type: 'expense',   category: 'operating', balance: 0 },
  { code: '6700', name: 'Other Expenses',             type: 'expense',   category: 'other',     balance: 0 },
  { code: '6800', name: 'FSP Compliance Costs',       type: 'expense',   category: 'operating', balance: 0 },
  { code: '6810', name: 'Fund Administration Costs',  type: 'expense',   category: 'operating', balance: 0 },
];

/* ═══════════════════════════════════════════════════════════
   FETCH FROM DATABASE (if DATABASE_URL available)
══════════════════════════════════════════════════════════ */
async function fetchFromDB() {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!dbUrl) return null;
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
    const [invRes, txnDepRes, txnWdrRes, invstRes] = await Promise.all([
      pool.query("SELECT id, first_name, last_name FROM investors"),
      pool.query("SELECT id, investor_id, type, amount, status, reference, created_at FROM transactions WHERE type='deposit' AND status='completed' ORDER BY created_at"),
      pool.query("SELECT id, investor_id, type, amount, status, reference, created_at FROM transactions WHERE type='withdrawal' AND status='completed' ORDER BY created_at"),
      pool.query("SELECT id, investor_id, pool_id, amount, status, start_date, end_date, actual_return, expected_return FROM investments WHERE status IN ('active','matured','paid_out') ORDER BY start_date"),
    ]);
    // Get pool names
    const poolRes = await pool.query("SELECT id, name FROM investment_pools");
    const poolMap = {};
    for (const p of poolRes.rows) poolMap[p.id] = p.name;
    const investments = invstRes.rows.map(i => ({ ...i, pool_name: poolMap[i.pool_id] || i.pool_id }));
    await pool.end();
    return {
      investors:    invRes.rows,
      deposits:     txnDepRes.rows,
      withdrawals:  txnWdrRes.rows,
      investments,
    };
  } catch (err) {
    console.warn('[DB] Could not connect:', err.message, '— falling back to seed data');
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════
   COMPUTE JOURNAL ENTRIES
══════════════════════════════════════════════════════════ */
function computeJournalEntries(coa, investors, deposits, withdrawals, investments) {
  const byCode = {};
  for (const a of coa) byCode[a.code] = a;

  const investorMap = {};
  for (const inv of investors) investorMap[inv.id] = `${inv.first_name} ${inv.last_name}`;

  const entries   = [];
  const syncedTxn = [];
  const syncedInv = [];
  let count = 0;

  // Deposits
  for (const t of deposits) {
    const name   = investorMap[t.investor_id] || t.investor_id;
    const amount = parseFloat(t.amount) || 0;
    const fee    = Math.round(amount * 0.01 * 100) / 100;
    const date   = (t.created_at || '').toString().split('T')[0];
    const ref6   = String(t.id).slice(-6);
    entries.push(
      { id: uid(), accountId: byCode['1000'].id, type: 'debit',  amount,     description: `Investor deposit: ${name} — ${t.reference || ''}`, reference: `DEP-${ref6}`, date },
      { id: uid(), accountId: byCode['2100'].id, type: 'credit', amount,     description: `Investor deposit: ${name} — ${t.reference || ''}`, reference: `DEP-${ref6}`, date },
      { id: uid(), accountId: byCode['2100'].id, type: 'debit',  amount: fee,description: `1% platform fee on deposit: ${name}`,               reference: `FEE-${ref6}`, date },
      { id: uid(), accountId: byCode['4100'].id, type: 'credit', amount: fee,description: `1% platform fee on deposit: ${name}`,               reference: `FEE-${ref6}`, date }
    );
    syncedTxn.push(t.id);
    count++;
  }

  // Withdrawals
  for (const t of withdrawals) {
    const name   = investorMap[t.investor_id] || t.investor_id;
    const amount = parseFloat(t.amount) || 0;
    const date   = (t.created_at || '').toString().split('T')[0];
    const ref6   = String(t.id).slice(-6);
    entries.push(
      { id: uid(), accountId: byCode['2100'].id, type: 'debit',  amount, description: `Investor withdrawal: ${name}`, reference: `WDR-${ref6}`, date },
      { id: uid(), accountId: byCode['1000'].id, type: 'credit', amount, description: `Investor withdrawal: ${name}`, reference: `WDR-${ref6}`, date }
    );
    syncedTxn.push(t.id);
    count++;
  }

  // Investment allocations + payouts
  for (const inv of investments) {
    const name   = investorMap[inv.investor_id] || inv.investor_id;
    const amount = parseFloat(inv.amount) || 0;
    const date   = (inv.start_date || '').toString().split('T')[0];
    const ref6   = String(inv.id).slice(-6);

    entries.push(
      { id: uid(), accountId: byCode['1500'].id, type: 'debit',  amount, description: `Investment allocated: ${inv.pool_name || 'Pool'} — ${name}`, reference: `INV-${ref6}`, date },
      { id: uid(), accountId: byCode['2100'].id, type: 'credit', amount, description: `Investment allocated: ${inv.pool_name || 'Pool'} — ${name}`, reference: `INV-${ref6}`, date }
    );
    syncedInv.push(inv.id);

    // Payout for matured/paid_out
    if (inv.status === 'matured' || inv.status === 'paid_out') {
      const ret     = parseFloat(inv.actual_return || inv.expected_return || 0);
      const total   = amount + ret;
      const payDate = (inv.end_date || new Date().toISOString()).toString().split('T')[0];
      entries.push(
        { id: uid(), accountId: byCode['2100'].id, type: 'debit',  amount: total, description: `Investment payout: ${inv.pool_name || 'Pool'} — ${name}`,        reference: `PAY-${ref6}`, date: payDate },
        { id: uid(), accountId: byCode['1500'].id, type: 'credit', amount,        description: `Investment payout: ${inv.pool_name || 'Pool'} — ${name}`,        reference: `PAY-${ref6}`, date: payDate },
        { id: uid(), accountId: byCode['4200'].id, type: 'credit', amount: ret,   description: `Investment return income: ${inv.pool_name || 'Pool'} — ${name}`, reference: `PAY-${ref6}`, date: payDate }
      );
      syncedInv.push(inv.id + '-PAYOUT');
    }

    count++;
  }

  return { entries, syncedTxn, syncedInv, count };
}

/* ═══════════════════════════════════════════════════════════
   BALANCE SHEET SUMMARY
══════════════════════════════════════════════════════════ */
function computeBalances(coa, entries) {
  const byId = {};
  for (const a of coa) byId[a.id] = { ...a };

  for (const e of entries) {
    const acc = byId[e.accountId];
    if (!acc) continue;
    if (e.type === 'credit') acc.balance = (acc.balance || 0) + e.amount;
    else acc.balance = (acc.balance || 0) - e.amount;
  }
  return byId;
}

/* ═══════════════════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════════════════ */
async function main() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  SV Capital — Investment Accounting Sync');
  console.log('  Entity: Smartvest Financial Services (FSP 52449)');
  console.log('══════════════════════════════════════════════════════════\n');

  // Try DB first
  const db = await fetchFromDB();
  const source = db ? 'PostgreSQL database' : 'seed data fallback';
  console.log(`📦 Data source: ${source}`);

  const investors   = db ? db.investors   : SEED_INVESTORS;
  const deposits    = db ? db.deposits    : SEED_TRANSACTIONS.filter(t => t.type === 'deposit' && t.status === 'completed');
  const withdrawals = db ? db.withdrawals : [];
  const investments = db ? db.investments : SEED_INVESTMENTS;

  console.log(`   Investors:   ${investors.length}`);
  console.log(`   Deposits:    ${deposits.length}`);
  console.log(`   Withdrawals: ${withdrawals.length}`);
  console.log(`   Investments: ${investments.length}`);

  // Build COA
  const FSP_BIZ_ID = 'sv-fsp-smartvest';
  const coa = DEFAULT_COA_DEFS.map(a => ({ ...a, id: uid() }));

  // Compute journal entries
  const { entries, syncedTxn, syncedInv, count } = computeJournalEntries(coa, investors, deposits, withdrawals, investments);
  const balances = computeBalances(coa, entries);

  console.log(`\n✅ Journal entries computed: ${entries.length} (${count} source records)`);
  console.log(`   Deposits synced:     ${deposits.length}`);
  console.log(`   Withdrawals synced:  ${withdrawals.length}`);
  console.log(`   Investments synced:  ${investments.length}`);

  // Print summary
  console.log('\n── Account Balances ─────────────────────────────────────');
  const keyAccounts = ['1000','1500','2100','4100','4200','4300','4400'];
  for (const code of keyAccounts) {
    const acc = Object.values(balances).find(a => a.code === code);
    if (acc) console.log(`  ${acc.code}  ${(acc.name || '').padEnd(35)} ${ZAR(acc.balance || 0)}`);
  }

  const totalDeposits = deposits.reduce((s, t) => s + parseFloat(t.amount || 0), 0);
  const totalFees     = deposits.reduce((s, t) => s + Math.round(parseFloat(t.amount || 0) * 0.01 * 100) / 100, 0);
  const aum           = investments.filter(i => i.status === 'active').reduce((s, i) => s + parseFloat(i.amount || 0), 0);
  const totalReturns  = investments.filter(i => i.status === 'matured' || i.status === 'paid_out')
                          .reduce((s, i) => s + parseFloat(i.actual_return || i.expected_return || 0), 0);

  console.log('\n── Fund Summary ─────────────────────────────────────────');
  console.log(`  Total Deposits Received  ${ZAR(totalDeposits)}`);
  console.log(`  Platform Fees Earned     ${ZAR(totalFees)}`);
  console.log(`  Active AUM               ${ZAR(aum)}`);
  console.log(`  Total Returns Paid Out   ${ZAR(totalReturns)}`);

  // Build localStorage state
  const biz = {
    id:                 FSP_BIZ_ID,
    name:               'Smartvest Financial Services',
    registrationNumber: 'K2021/000000/07',
    vatNumber:          '4380314789',
    fspNumber:          '52449',
    country:            'ZA',
    currency:           'ZAR',
    isFSP:              true,
    createdAt:          new Date().toISOString(),
  };

  const lsState = {
    'acct_businesses':              [biz],
    'acct_active':                  FSP_BIZ_ID,
    [`acct_coa_${FSP_BIZ_ID}`]:     coa,
    [`acct_transactions_${FSP_BIZ_ID}`]: entries,
    [`acct_synced_txn_${FSP_BIZ_ID}`]:   syncedTxn,
    [`acct_synced_inv_${FSP_BIZ_ID}`]:   syncedInv,
    [`acct_last_sync_${FSP_BIZ_ID}`]:    new Date().toISOString(),
  };

  // Write JSON output
  const outPath = path.join(__dirname, '../../team/accounting-state.json');
  fs.writeFileSync(outPath, JSON.stringify(lsState, null, 2), 'utf8');
  console.log(`\n💾 State written to: ${outPath}`);
  console.log('   Open team/accounting-preload.html in a browser to load it.\n');
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
