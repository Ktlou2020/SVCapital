#!/usr/bin/env node
/* A deposit can read COMPLETED and still never have moved a wallet.
 *
 * Both crediting paths — the tables API's PATCH hook and /admin/eft-approve —
 * write the row and the balance inside one transaction, guarded the same way:
 *
 *     UPDATE transactions SET status='completed' … WHERE id=$1 AND status <> 'completed'
 *
 * The guard is what stops a double credit on a retry or a double-click, and it
 * is right. What is wrong is what happens when it matches nothing. The row is
 * already completed, so no balance is moved — correctly, because something
 * else is assumed to have moved it — and the approval then resolves the
 * ticket, tells the investor the money is in their wallet, and returns
 * ok: true. If nothing ever did move it, there is now a completed deposit, a
 * resolved ticket, a client who has been told, and no money.
 *
 * Three ways a row gets to that state:
 *
 *   ALREADY-COMPLETED  something set status='completed' without crediting —
 *                      a direct edit, an import, the old three-call console
 *                      flow — and the approval then skipped its own credit.
 *   NULL-STATUS        `status <> 'completed'` is NULL, not true, for a NULL
 *                      status. The UPDATE matches nothing and the credit is
 *                      skipped exactly as above, silently.
 *   SUB-ACCOUNT        the row carries sub_account_id, so the money credited
 *                      the SUB-ACCOUNT's wallet. The parent's balance is
 *                      untouched and correctly so — the deposit shows on the
 *                      parent's transaction list, which is where this looks
 *                      like a missing credit and is not one.
 *
 * audit_events settles which. /admin/eft-approve records credited:true|false
 * in the metadata of every eft_deposit_approved row, so an approval that
 * credited nothing says so in its own audit trail.
 *
 * The ledger reconciliation is the backstop for deposits that predate that
 * route or were completed some other way: wallet_balance against the signed
 * sum of the investor's own cash transactions, using the platform's single
 * definition of what moves cash (services/ledger.js), never a second copy.
 *
 * READ-ONLY. Every statement is a SELECT. Safe against production.
 *
 * Run:
 *   DATABASE_URL="<url>" node server/scripts/audit-eft-credit-gap.cjs
 *   …add --ref EFT-1787761776618   to look at one deposit
 *   …add --investor S-111946       to look at one client
 *   …add --csv                     to write eft-credit-gap.csv alongside
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See the header of this file.');
  process.exit(2);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const ledger = require(path.join(__dirname, '..', 'services', 'ledger'));

const ARGV = process.argv.slice(2);
const val  = n => { const i = ARGV.indexOf(n); return i > -1 ? (ARGV[i + 1] || '') : ''; };
const REF      = val('--ref');
const INVESTOR = val('--investor');
const WANT_CSV = ARGV.includes('--csv');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  statement_timeout: 120000,
});

const money = n => 'R' + Number(n || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const H = s => console.log(`\n${s}\n${'─'.repeat(s.length)}`);
const day = d => (d ? new Date(d).toISOString().slice(0, 10) : '—');

async function hasColumn(table, col) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [table, col]);
  return rows.length > 0;
}

(async () => {
  try {
    const where = [`t.type = 'deposit'`];
    const args  = [];
    if (REF)      { args.push(REF);      where.push(`t.reference = $${args.length}`); }
    if (INVESTOR) { args.push(INVESTOR); where.push(`t.investor_id = $${args.length}`); }

    /* Every completed deposit, with the approval that claims to have credited
       it. The audit row is matched on the reference inside its description,
       because that is the only link the two share. */
    const { rows: deposits } = await db.query(`
      SELECT t.id, t.investor_id, t.sub_account_id, t.amount, t.status, t.reference,
             t.description, t.created_at, t.updated_at,
             i.first_name, i.last_name, i.wallet_balance,
             sa.name AS sub_account_name, sa.wallet_balance AS sub_wallet
        FROM transactions t
        LEFT JOIN investors i     ON i.id  = t.investor_id
        LEFT JOIN sub_accounts sa ON sa.id = t.sub_account_id
       WHERE ${where.join(' AND ')}
         AND COALESCE(t.status, '') = 'completed'
       ORDER BY t.created_at DESC`, args);

    H(`${deposits.length} completed deposit(s)${REF ? ` on ${REF}` : ''}${INVESTOR ? ` for ${INVESTOR}` : ''}`);
    if (!deposits.length) {
      console.log('  Nothing matched. A deposit that is still pending is not this fault —');
      console.log('  it has not been approved yet.');
      return;
    }

    /* The approvals that reported crediting nothing. One query, then matched
       in memory: the reference lives inside the description text. */
    const { rows: approvals } = await db.query(`
      SELECT entity_id, description, metadata, created_at, user_email
        FROM audit_events
       WHERE event_type IN ('eft_deposit_approved', 'eft_deposit_approved_amount_corrected')
       ORDER BY created_at`);
    const approvalFor = ref => approvals.filter(a =>
      String(a.description || '').includes(ref) ||
      String((a.metadata && a.metadata.before && a.metadata.before.reference) || '') === ref);

    /* The backstop: what each investor's own cash transactions say their
       wallet should be. Uses the platform's definition of a cash move. */
    const ids = [...new Set(deposits.map(d => d.investor_id).filter(Boolean))];
    const { rows: ledgerRows } = await db.query(`
      SELECT investor_id,
             COALESCE(SUM(${ledger.cashMovementSQL('')}), 0) AS net
        FROM transactions
       WHERE investor_id = ANY($1::text[])
         AND COALESCE(status, '') = 'completed'
         AND sub_account_id IS NULL
       GROUP BY investor_id`, [ids]);
    const netBy = new Map(ledgerRows.map(r => [r.investor_id, Number(r.net)]));

    const hasAudit = await hasColumn('audit_events', 'metadata');
    const rows = [];
    for (const d of deposits) {
      const amt  = Number(d.amount);
      const appr = hasAudit ? approvalFor(d.reference) : [];
      const saidCredited = appr.map(a => {
        const after = (a.metadata && a.metadata.after) || {};
        return after.credited;
      });
      /* false, explicitly, from the route that knows. Not "missing". */
      const skipped = saidCredited.some(v => v === false);
      const confirmed = saidCredited.some(v => v === true);

      let verdict, detail;
      if (d.sub_account_id) {
        verdict = 'sub-account';
        detail  = `credited ${d.sub_account_name || d.sub_account_id}, whose wallet is ` +
                  `${money(d.sub_wallet)} — the parent's balance is untouched, correctly`;
      } else if (skipped) {
        verdict = 'NOT CREDITED';
        detail  = 'the approval recorded credited:false — the row was already completed ' +
                  '(or its status was NULL) when it ran, so the balance was never moved';
      } else if (confirmed) {
        verdict = 'credited';
        detail  = 'the approval recorded credited:true';
      } else {
        verdict = 'unproven';
        detail  = 'no approval audit row carries this reference — completed by some other ' +
                  'path, so only the ledger below can speak for it';
      }

      const net = netBy.get(d.investor_id);
      const bal = Number(d.wallet_balance);
      const gap = (net == null || d.sub_account_id) ? null : Math.round((bal - net) * 100) / 100;

      rows.push({ reference: d.reference, investor: d.investor_id,
                  who: `${d.first_name || ''} ${d.last_name || ''}`.trim(),
                  amount: amt, when: day(d.created_at), verdict, detail,
                  wallet: bal, ledger: net, gap });
    }

    const bad = rows.filter(r => r.verdict === 'NOT CREDITED');
    const unproven = rows.filter(r => r.verdict === 'unproven');
    const sub = rows.filter(r => r.verdict === 'sub-account');

    H('What each completed deposit actually did to a wallet');
    console.log(`  ${String(bad.length).padStart(4)}  ${money(bad.reduce((s, r) => s + r.amount, 0)).padStart(14)}  approved, recorded, NOT credited`);
    console.log(`  ${String(sub.length).padStart(4)}  ${money(sub.reduce((s, r) => s + r.amount, 0)).padStart(14)}  credited a sub-account, not the parent`);
    console.log(`  ${String(unproven.length).padStart(4)}  ${money(unproven.reduce((s, r) => s + r.amount, 0)).padStart(14)}  no approval row — see the ledger column`);
    console.log(`  ${String(rows.length - bad.length - sub.length - unproven.length).padStart(4)}  ` +
                `${money(rows.filter(r => r.verdict === 'credited').reduce((s, r) => s + r.amount, 0)).padStart(14)}  credited, as recorded`);

    for (const group of [['NOT CREDITED', bad], ['sub-account', sub], ['unproven', unproven]]) {
      if (!group[1].length) continue;
      H(group[0]);
      for (const r of group[1]) {
        console.log(`  ${r.reference}  ${money(r.amount).padStart(13)}  ${r.when}  ` +
                    `${r.investor} ${r.who}`);
        console.log(`      ${r.detail}`);
        if (r.gap != null) {
          console.log(`      wallet ${money(r.wallet)} · its own transactions say ${money(r.ledger)}` +
                      ` · difference ${money(r.gap)}` +
                      (Math.abs(r.gap + r.amount) < 0.01
                        ? '  ← short by exactly this deposit'
                        : ''));
        }
      }
    }

    H('Reading this');
    console.log('  A wallet that is short by exactly the deposit amount is this fault, and the');
    console.log('  repair is a manual credit for that amount with the reference in the note —');
    console.log('  Admin console → Clients → the client → Admin → Manual Credit, which audits.');
    console.log('  Do not re-approve the ticket: the row is already completed, so the approval');
    console.log('  will skip the credit again, which is how it got here.');
    console.log('\n  A wallet that reconciles has been credited and the deposit is fine.');
    console.log('  A difference that is not this deposit is a different question — the wallet');
    console.log('  has other unexplained movement, and audit-subaccount-money.cjs is the tool.');

    if (WANT_CSV) {
      const out = path.join(process.cwd(), 'eft-credit-gap.csv');
      const head = 'reference,investor,who,amount,date,verdict,wallet,ledger,difference\n';
      fs.writeFileSync(out, head + rows.map(r =>
        [r.reference, r.investor, `"${r.who}"`, r.amount, r.when, r.verdict,
         r.wallet, r.ledger == null ? '' : r.ledger, r.gap == null ? '' : r.gap].join(',')).join('\n') + '\n');
      console.log(`\n  Written: ${out}`);
    }
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
