'use strict';
/* ═══════════════════════════════════════════════════════════
   What is my share?

   The question every stokvel member actually asks, and the one the platform
   could not answer. Contributions were tracked per member; everything else
   the group earned or spent landed on one undifferentiated wallet — interest
   from the 3PIM import, returns at maturity, the 1% fee on an investment —
   so the pot had a total and no owners.

   THE INVARIANT. Everything here exists to keep this true:

     Σ active members' shares
       = sub_accounts.wallet_balance
       + Σ active investments at COST for this sub-account
       − Σ unpaid exit debts

   Investments are carried at COST and income enters a share only when it is
   actually credited. That is the recognition rule the platform already keeps
   — services/ledger.js: "a return is an ACCRUAL… the cash reaches the wallet
   later, at maturity, as a payout" — and marking to expected_return would
   allocate a projection as though it were somebody's money.

   WHY ONLY ONE EVENT IS HOOKED. Nine code paths credit a stokvel wallet,
   across six files: maturityCron, stokvelContributions, payments (×2),
   tables (×2), manualCredit (×2) and interest. Hooking each is the mistake
   this codebase has already paid for once — jobs/maturityCron.js records
   that every money path split to sub-accounts EXCEPT maturity, which left
   them "permanently short by everything it had invested". So only
   contribution, the one event that names a member, is written at the point
   it happens. Everything else is placed by reconcile(), which compares net
   assets to the sum of allocations and shares out the difference. A tenth
   path nobody hooks is still allocated correctly on the next reconcile,
   which makes the invariant the mechanism rather than a test of it.

   NUMERIC ARRIVES AS A STRING from node-postgres. Every figure read off a
   row is passed through Number() exactly once, here, because this feature
   has already produced that bug: round2(amount_paid + want) with "0.00" and
   500 concatenated to "0.00500", settled as a cent, and the member paid
   twice. Subtraction coerces and looks fine, which is why it survived being
   read.
   ═══════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const round2 = v => Math.round(Number(v || 0) * 100) / 100;
const cents  = v => Math.round(Number(v || 0) * 100);
const fmtR   = v => 'R' + Number(v || 0).toLocaleString('en-ZA',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const newId  = p => p + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();

/* ── Net assets ────────────────────────────────────────────────────
   Everything the group owns, wherever it is sitting. Cash alone would mean
   investing the pot made every member's share collapse. */
async function netAssets(client, subAccountId) {
  const { rows: [row] } = await client.query(
    `SELECT COALESCE(a.wallet_balance, 0)                      AS wallet,
            COALESCE((SELECT SUM(i.amount) FROM investments i
                       WHERE i.sub_account_id = a.id
                         AND i.status = 'active'), 0)          AS invested,
            COALESCE((SELECT SUM(d.amount_owed - d.amount_paid)
                        FROM stokvel_exit_debts d
                       WHERE d.sub_account_id = a.id
                         AND d.status = 'owing'), 0)           AS owed
       FROM sub_accounts a WHERE a.id = $1`, [subAccountId]);
  if (!row) return { wallet: 0, invested: 0, owed: 0, total: 0 };
  const wallet   = round2(row.wallet);
  const invested = round2(row.invested);
  const owed     = round2(row.owed);
  return { wallet, invested, owed, total: round2(wallet + invested - owed) };
}

/* Active members, in a stable order so a pro-rata remainder lands on the
   same person twice rather than wandering. */
async function activeMembers(client, subAccountId) {
  const { rows } = await client.query(
    `SELECT investor_id FROM stokvel_members
      WHERE sub_account_id = $1 AND status = 'active'
      ORDER BY investor_id`, [subAccountId]);
  return rows.map(r => r.investor_id);
}

async function allocatedTotals(client, subAccountId) {
  const { rows } = await client.query(
    `SELECT investor_id, COALESCE(SUM(amount), 0) AS total
       FROM stokvel_allocations WHERE sub_account_id = $1
      GROUP BY investor_id`, [subAccountId]);
  const out = new Map();
  for (const r of rows) out.set(r.investor_id, round2(r.total));
  return out;
}

async function arrearsOf(client, subAccountId) {
  const { rows } = await client.query(
    `SELECT investor_id, COALESCE(SUM(amount_due - amount_paid), 0) AS owed
       FROM stokvel_contributions
      WHERE sub_account_id = $1 AND status = 'due'
        AND (amount_due - amount_paid) > 0
      GROUP BY investor_id`, [subAccountId]);
  const out = new Map();
  for (const r of rows) out.set(r.investor_id, round2(r.owed));
  return out;
}

/* ── Splitting an amount ───────────────────────────────────────────
   In CENTS, with the remainder to the largest holder, so the parts always
   sum to the whole. Splitting R10 three ways and rounding each part gives
   R3.33 three times and loses a cent; over a year of monthly interest a
   stokvel's books drift away from its wallet by small amounts that nobody
   can account for, which is exactly the argument this feature exists to
   end. Ties break on the id, so the same split twice is the same split. */
function splitPro(amount, weights) {
  const total = cents(amount);
  if (!total) return new Map();
  const ids = [...weights.keys()];
  const sumW = ids.reduce((n, id) => n + Math.max(0, cents(weights.get(id))), 0);

  const out = new Map();
  /* Nobody has a positive holding yet — the first credit into a new group,
     or one whose members have all been paid out. Shared equally, because
     pro-rata on nothing has no answer and dropping it would invent a
     discrepancy that reconcile would then try to allocate forever. */
  if (sumW <= 0) {
    const each = Math.floor(Math.abs(total) / ids.length) * Math.sign(total);
    let left = total - each * ids.length;
    ids.forEach((id, i) => out.set(id, each + (i === 0 ? left : 0)));
    return out;
  }

  let placed = 0;
  for (const id of ids) {
    const w = Math.max(0, cents(weights.get(id)));
    const part = Math.trunc(total * w / sumW);
    out.set(id, part);
    placed += part;
  }
  /* The remainder, to whoever holds most. Never dropped. */
  const rest = total - placed;
  if (rest !== 0) {
    const biggest = ids.reduce((best, id) =>
      Math.max(0, cents(weights.get(id))) > Math.max(0, cents(weights.get(best))) ? id : best, ids[0]);
    out.set(biggest, out.get(biggest) + rest);
  }
  return out;
}

async function write(client, subAccountId, rows, { kind, reason, reference }) {
  for (const [investorId, amtCents] of rows) {
    if (!amtCents) continue;
    await client.query(
      `INSERT INTO stokvel_allocations (id, sub_account_id, investor_id, kind, amount, reason, reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newId('SAL'), subAccountId, investorId, kind, amtCents / 100, reason || null, reference || null]);
  }
}

/* ── The one hooked event ──────────────────────────────────────────
   A contribution is the only movement that names a member, so it is the
   only one written where it happens. */
async function allocateContribution(client, { subAccountId, investorId, amount, reference, periodLabel }) {
  const amt = round2(amount);
  if (!(amt > 0)) return { allocated: 0 };
  await client.query(
    `INSERT INTO stokvel_allocations (id, sub_account_id, investor_id, kind, amount, reason, reference)
     VALUES ($1,$2,$3,'contribution',$4,$5,$6)`,
    [newId('SAL'), subAccountId, investorId, amt,
     periodLabel ? `Contribution for ${periodLabel}` : 'Contribution', reference || null]);
  return { allocated: amt };
}

/* ── Reconcile ─────────────────────────────────────────────────────
   Everything that is not a contribution. The group's net assets have moved
   and the share ledger has not; the difference belongs to the members in
   proportion to what they already hold.

   EXIT DEBTS ARE PAID FIRST, out of cash, before any of it reaches current
   members. A leaver's share was crystallised on the day they left: the
   principal is owed to them and the growth since is not theirs, so the debt
   is senior to current members' income and earns nothing itself. */
async function reconcile(client, subAccountId, { reason, reference } = {}) {
  const paid = await payExitDebts(client, subAccountId, reference);

  const assets  = await netAssets(client, subAccountId);
  const members = await activeMembers(client, subAccountId);
  if (!members.length) return { ...paid, allocated: 0, reason: 'no active members' };

  const held = await allocatedTotals(client, subAccountId);
  let heldSum = 0;
  const weights = new Map();
  for (const id of members) {
    const h = held.get(id) || 0;
    weights.set(id, h);
    heldSum = round2(heldSum + h);
  }
  /* Allocations belonging to people who have left are not part of the live
     split: their payout row cancelled their share, so what is left against
     them is zero and harmless either way. Summing only active members is
     what keeps the invariant about ACTIVE shares. */
  const gap = round2(assets.total - heldSum);
  if (cents(gap) === 0) return { ...paid, allocated: 0 };

  const kind = gap > 0 ? 'income' : 'cost';
  const parts = splitPro(gap, weights);
  await write(client, subAccountId, parts, {
    kind,
    reason: reason || (gap > 0 ? 'Group earnings shared out' : 'Group costs shared out'),
    reference,
  });
  return { ...paid, allocated: gap, kind };
}

/* Cash towards what the group owes people who have left. Oldest debt first,
   and only as far as the wallet goes. */
async function payExitDebts(client, subAccountId, reference) {
  const { rows: debts } = await client.query(
    `SELECT d.id, d.investor_id, d.amount_owed, d.amount_paid
       FROM stokvel_exit_debts d
      WHERE d.sub_account_id = $1 AND d.status = 'owing'
      ORDER BY d.created_at ASC
      FOR UPDATE`, [subAccountId]);
  if (!debts.length) return { debtsPaid: 0 };

  const { rows: [acc] } = await client.query(
    'SELECT wallet_balance FROM sub_accounts WHERE id = $1 FOR UPDATE', [subAccountId]);
  let cash = round2(acc && acc.wallet_balance);
  let total = 0;

  for (const d of debts) {
    if (cents(cash) <= 0) break;
    const outstanding = round2(Number(d.amount_owed) - Number(d.amount_paid));
    if (cents(outstanding) <= 0) continue;
    const pay = round2(Math.min(outstanding, cash));
    if (cents(pay) <= 0) continue;

    await client.query(
      'UPDATE sub_accounts SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
      [pay, subAccountId]);
    await client.query(
      'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
      [pay, d.investor_id]);
    const nowPaid = round2(Number(d.amount_paid) + pay);
    const done = cents(nowPaid) >= cents(d.amount_owed);
    await client.query(
      `UPDATE stokvel_exit_debts
          SET amount_paid = $2, status = $3,
              settled_at = CASE WHEN $3 = 'settled' THEN NOW() ELSE settled_at END,
              updated_at = NOW()
        WHERE id = $1`, [d.id, nowPaid, done ? 'settled' : 'owing']);
    await client.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'deposit', $2, 'completed', $3, $4, NOW(), NOW())`,
      [d.investor_id, pay, reference || newId('SXD'),
       'Stokvel exit settlement' + (done ? '' : ' (part payment)')]);

    cash = round2(cash - pay);
    total = round2(total + pay);
  }
  return { debtsPaid: total };
}

/* ── What everybody's share is ─────────────────────────────────────
   Read-only. 'contribution' is the sum of the ledger; 'equal' is the
   classic stokvel split, where the pot divides by head and your own arrears
   come off your share. */
async function sharesOf(client, subAccountId) {
  const { rows: [acc] } = await client.query(
    'SELECT share_basis, wallet_balance FROM sub_accounts WHERE id = $1', [subAccountId]);
  const basis   = (acc && acc.share_basis) || 'contribution';
  const assets  = await netAssets(client, subAccountId);
  const members = await activeMembers(client, subAccountId);
  const arrears = await arrearsOf(client, subAccountId);

  if (!members.length) return { basis, assets, shares: [] };

  if (basis === 'equal') {
    const parts = splitPro(assets.total, new Map(members.map(id => [id, 1])));
    return {
      basis, assets,
      shares: members.map(id => ({
        investor_id: id,
        share: round2((parts.get(id) || 0) / 100 - (arrears.get(id) || 0)),
        gross: round2((parts.get(id) || 0) / 100),
        arrears: arrears.get(id) || 0,
      })),
    };
  }

  const held = await allocatedTotals(client, subAccountId);
  return {
    basis, assets,
    shares: members.map(id => ({
      investor_id: id,
      share: round2(held.get(id) || 0),
      gross: round2(held.get(id) || 0),
      arrears: arrears.get(id) || 0,
    })),
  };
}

async function shareFor(client, subAccountId, investorId) {
  const out = await sharesOf(client, subAccountId);
  const row = out.shares.find(s => s.investor_id === investorId);
  return row ? row.share : 0;
}

/* ── Settling an exit ──────────────────────────────────────────────
   Called inside the transaction that has already cleared the mandate: an
   exit is group money leaving, so no single person does this.

   Arrears come off what is paid out and the money STAYS IN THE POT for the
   remaining members, which is the whole point of having chased it. Their
   outstanding obligations are marked waived against this settlement rather
   than left due against somebody who is no longer a member. */
async function settleExit(client, { subAccountId, investorId, authorityId, reference }) {
  const ref = reference || newId('SXT');

  /* ── Hand the account on, if this is the person who opened it ──────
     sub_accounts.parent_investor_id is the account's owner and it grants
     access on its own. A chairperson who exits and keeps it would be paid
     out and still see the wallet, the roster and every member's share — and
     could still invite people, since mayInvite reads the same column. It is
     also whose name the group's contribution receipts are filed under
     (stokvelContributions.pay), so leaving it pointed at somebody who has
     gone puts the group's money in a former member's records.

     Handed to the committee first, longest-standing before newest, so the
     successor is the most likely person to actually be running the group.
     This is NOT a transfer of signing power: the mandate is a separate
     thing and is untouched here. */
  const { rows: [owner] } = await client.query(
    'SELECT parent_investor_id FROM sub_accounts WHERE id = $1 FOR UPDATE', [subAccountId]);
  const isOwner = owner && owner.parent_investor_id === investorId;
  if (isOwner) {
    const { rows: [heir] } = await client.query(
      `SELECT investor_id FROM stokvel_members
        WHERE sub_account_id = $1 AND status = 'active' AND investor_id <> $2
        ORDER BY CASE role WHEN 'chairperson' THEN 0 WHEN 'treasurer' THEN 1
                           WHEN 'secretary'   THEN 2 ELSE 3 END,
                 joined_at ASC NULLS LAST, investor_id ASC
        LIMIT 1`, [subAccountId, investorId]);
    if (!heir) {
      /* Refused rather than left ownerless. A stokvel whose last member is
         leaving is a stokvel that is closing, and closing an account is a
         different conversation from one member walking away from a group
         that carries on. */
      return { error: 'This member opened the stokvel and there is no other active member to hand it to. '
                    + 'A group with nobody left in it should be closed with us rather than emptied one member at a time.' };
    }
    await client.query(
      'UPDATE sub_accounts SET parent_investor_id = $2, updated_at = NOW() WHERE id = $1',
      [subAccountId, heir.investor_id]);
    await client.query(
      `UPDATE stokvel_members SET role = 'chairperson', updated_at = NOW()
        WHERE sub_account_id = $1 AND investor_id = $2`,
      [subAccountId, heir.investor_id]);
  }

  const gross = await shareFor(client, subAccountId, investorId);
  const arrears = (await arrearsOf(client, subAccountId)).get(investorId) || 0;
  const net = round2(Math.max(0, gross - arrears));

  const { rows: [acc] } = await client.query(
    'SELECT wallet_balance FROM sub_accounts WHERE id = $1 FOR UPDATE', [subAccountId]);
  const cash = round2(acc && acc.wallet_balance);
  const payNow = round2(Math.min(net, Math.max(0, cash)));
  const queued = round2(net - payNow);

  if (cents(payNow) > 0) {
    await client.query(
      'UPDATE sub_accounts SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
      [payNow, subAccountId]);
    await client.query(
      'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
      [payNow, investorId]);
    await client.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'deposit', $2, 'completed', $3, $4, NOW(), NOW())`,
      [investorId, payNow, ref, 'Stokvel exit settlement']);
  }

  /* The payout allocation is the FULL net share, not only what cash covered.
     Their claim on the pot is extinguished either way; the unpaid part
     becomes a debt of the group, which net assets then subtracts. Writing
     only the paid part would leave the rest looking like it was still
     theirs AND owed to them. */
  if (cents(net) > 0) {
    await client.query(
      `INSERT INTO stokvel_allocations (id, sub_account_id, investor_id, kind, amount, reason, reference)
       VALUES ($1,$2,$3,'payout',$4,$5,$6)`,
      [newId('SAL'), subAccountId, investorId, -net, 'Exit settlement', ref]);
  }
  if (cents(arrears) > 0) {
    /* What they owed stays in the pot. Recorded as an adjustment against
       them so the ledger says where it went, and their obligations are
       closed rather than left due against a non-member. */
    await client.query(
      `INSERT INTO stokvel_allocations (id, sub_account_id, investor_id, kind, amount, reason, reference)
       VALUES ($1,$2,$3,'adjustment',$4,$5,$6)`,
      [newId('SAL'), subAccountId, investorId, -arrears,
       'Arrears withheld from exit settlement', ref]);
    await client.query(
      `UPDATE stokvel_contributions SET status = 'waived', updated_at = NOW()
        WHERE sub_account_id = $1 AND investor_id = $2 AND status = 'due'`,
      [subAccountId, investorId]);
  }
  if (cents(queued) > 0) {
    await client.query(
      `INSERT INTO stokvel_exit_debts
         (id, sub_account_id, investor_id, amount_owed, approved_via)
       VALUES ($1,$2,$3,$4,$5)`,
      [newId('SXD'), subAccountId, investorId, queued, authorityId || null]);
  }

  await client.query(
    `UPDATE stokvel_members
        SET status = 'exited', is_signatory = false, exited_at = NOW(), updated_at = NOW()
      WHERE sub_account_id = $1 AND investor_id = $2`,
    [subAccountId, investorId]);

  /* AND THEN SHARE OUT WHAT THE EXIT RELEASED.
     
     The arrears withheld stayed in the pot but belonged to nobody until this
     ran: the leaver's ledger was zeroed and the remaining members' shares
     were untouched, so the group's assets exceeded the sum of its shares by
     exactly the amount withheld. The check caught it as "out by 500" — real
     money with no owner, which is the one thing this ledger exists to
     prevent.
     
     Done through reconcile rather than by hand, because reconcile already
     knows how to divide an amount among the members who remain, and the
     member who just left is no longer among them. Ordered after the
     membership row is updated for exactly that reason. */
  await reconcile(client, subAccountId, {
    reason: arrears > 0 ? 'Arrears released by an exit' : 'Shared out after an exit',
    reference: ref,
  });

  return { gross, arrears, net, paid: payNow, queued, reference: ref };
}

/* ─── Attributing an amount to one member ──────────────────────────
   For money that reached the group wallet by a path with no owner on it: a
   staff manual credit, an EFT approval, a refund. Those are shared pro-rata
   by reconcile, which is right for interest and for a maturity and wrong
   when the money was actually one member's.

   THE ORDER MATTERS AND IS THE WHOLE TRICK. reconcile() runs FIRST, so
   whatever was pending is shared out and we are always in the same case:
   the amount has been divided between the members in proportion to their
   holdings. Taking it back on those same proportions then reverses that
   share-out EXACTLY — sharing pro-rata leaves the proportions unchanged, so
   the weights used to give it out are the weights that take it back — and
   the member is credited the whole amount.

   Without the leading reconcile this would have to know whether the money
   had already been shared, and would be wrong half the time.

   Net effect on the sum of shares is ZERO, because no money moves: this
   says whose the money was, not that there is more of it. The invariant is
   therefore untouched, which is the test the check makes of it. */
async function attribute(client, { subAccountId, investorId, amount, reason, actor }) {
  const amt = round2(amount);
  if (!(amt > 0)) return { error: 'An amount is required.' };

  const { rows: [m] } = await client.query(
    `SELECT 1 FROM stokvel_members
      WHERE sub_account_id = $1 AND investor_id = $2 AND status = 'active'`,
    [subAccountId, investorId]);
  if (!m) return { error: 'That person is not an active member of this stokvel.' };

  await reconcile(client, subAccountId, { reason: 'Shared out before attributing' });

  const assets = await netAssets(client, subAccountId);
  if (cents(amt) > cents(assets.total)) {
    /* Attributing more than the group holds would hand one member a share
       larger than the pot and push somebody else negative. Whatever has
       gone wrong, it is not fixed from here. */
    return { error: `This stokvel holds ${fmtR(assets.total)}. `
                  + `You cannot attribute ${fmtR(amt)} of it to one member.` };
  }

  const members = await activeMembers(client, subAccountId);
  const held = await allocatedTotals(client, subAccountId);
  const weights = new Map(members.map(id => [id, held.get(id) || 0]));

  const ref = newId('SAT');
  const why = String(reason || '').slice(0, 200)
    || 'Attributed to this member by staff';

  /* Taken back from everybody on the proportions it was given out on... */
  const back = splitPro(-amt, weights);
  await write(client, subAccountId, back, {
    kind: 'adjustment', reference: ref,
    reason: `Reversing the share-out of ${fmtR(amt)}: ${why}`,
  });
  /* ...and given to the member it belonged to. */
  await client.query(
    `INSERT INTO stokvel_allocations (id, sub_account_id, investor_id, kind, amount, reason, reference)
     VALUES ($1,$2,$3,'adjustment',$4,$5,$6)`,
    [newId('SAL'), subAccountId, investorId, amt,
     why + (actor ? ` (by ${String(actor).slice(0, 60)})` : ''), ref]);

  return { attributed: amt, reference: ref };
}

/* ─── Paying the whole group out on a date ─────────────────────────
   The December payout. The exit settlement applied to everyone at once and
   WITHOUT the membership change: nobody leaves, the pot resets, the
   schedule keeps running.

   Paid into each member's OWN SV WALLET rather than out to fifteen bank
   accounts. One internal move each, and they then withdraw individually
   under the ordinary notice — which is also what stops a distribution
   becoming fifteen bank payments that each have to clear.

   Arrears come off, exactly as on an exit, and what a member owed STAYS IN
   THE POT for the others. The reconcile at the end is what gives it to
   them; without it that money would sit in the group's assets owned by
   nobody, which is the bug the exit settlement had and the check caught.

   A pot that cannot cover everybody takes the same path an exit does: each
   member is paid what is there, pro-rata, and the rest is recorded as owed.
   Nothing is redeemed early to make a distribution happen. */
async function payOut(client, { payoutId }) {
  const { rows: [po] } = await client.query(
    `SELECT * FROM stokvel_payouts WHERE id = $1 FOR UPDATE`, [payoutId]);
  if (!po) return { error: 'No such payout.' };
  if (po.status !== 'planned') return { error: `That payout is already ${po.status}.` };

  const subAccountId = po.sub_account_id;
  const ref = newId('SPO');

  await reconcile(client, subAccountId, { reason: 'Shared out before the payout', reference: ref });

  const members = await activeMembers(client, subAccountId);
  if (!members.length) return { error: 'This stokvel has no active members to pay.' };

  const basis   = await sharesOf(client, subAccountId);
  const arrears = await arrearsOf(client, subAccountId);

  /* What each member is owed, before the cash is considered. */
  const want = new Map();
  let total = 0;
  for (const id of members) {
    const row = basis.shares.find(x => x.investor_id === id) || { gross: 0 };
    const owed = arrears.get(id) || 0;
    const net  = round2(Math.max(0, round2(row.gross) - owed));
    want.set(id, { gross: round2(row.gross), arrears: owed, net });
    total = round2(total + net);
  }

  /* The cash, shared on what each is owed rather than first-come. A
     distribution that paid the first few in full and the rest nothing would
     be a worse answer than everybody waiting together. */
  const { rows: [acc] } = await client.query(
    'SELECT wallet_balance FROM sub_accounts WHERE id = $1 FOR UPDATE', [subAccountId]);
  const cash = round2(acc && acc.wallet_balance);
  const payable = round2(Math.min(total, Math.max(0, cash)));
  const cut = payable < total
    ? splitPro(payable, new Map([...want].map(([id, w]) => [id, w.net])))
    : new Map([...want].map(([id, w]) => [id, cents(w.net)]));

  const lines = [];
  let n = 0;
  for (const id of members) {
    n += 1;
    const w = want.get(id);
    const paid   = round2((cut.get(id) || 0) / 100);
    const queued = round2(w.net - paid);

    if (cents(paid) > 0) {
      await client.query(
        'UPDATE sub_accounts SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
        [paid, subAccountId]);
      await client.query(
        'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
        [paid, id]);
      /* A reference PER MEMBER. transactions.reference is unique, so one
         reference across fifteen payments is fourteen rows that never get
         written \u2014 and the first attempt here failed on exactly that. The
         payout's own reference stays the common prefix, so the set is still
         findable as one distribution. */
      await client.query(
        `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'deposit', $2, 'completed', $3, $4, NOW(), NOW())`,
        [id, paid, `${ref}-${String(n).padStart(3, '0')}`, `Stokvel payout \u2014 ${po.label}`]);
    }
    /* The allocation is the FULL net, not only what cash covered: their
       claim on the pot is extinguished either way, and the unpaid part
       becomes a debt of the group, which net assets then subtracts. */
    if (cents(w.net) > 0) {
      await client.query(
        `INSERT INTO stokvel_allocations (id, sub_account_id, investor_id, kind, amount, reason, reference)
         VALUES ($1,$2,$3,'payout',$4,$5,$6)`,
        [newId('SAL'), subAccountId, id, -w.net, `Payout \u2014 ${po.label}`, ref]);
    }
    if (cents(w.arrears) > 0) {
      await client.query(
        `INSERT INTO stokvel_allocations (id, sub_account_id, investor_id, kind, amount, reason, reference)
         VALUES ($1,$2,$3,'adjustment',$4,$5,$6)`,
        [newId('SAL'), subAccountId, id, -w.arrears,
         `Arrears withheld from the ${po.label} payout`, ref]);
      await client.query(
        `UPDATE stokvel_contributions SET status = 'waived', updated_at = NOW()
          WHERE sub_account_id = $1 AND investor_id = $2 AND status = 'due'`,
        [subAccountId, id]);
    }
    if (cents(queued) > 0) {
      await client.query(
        `INSERT INTO stokvel_exit_debts
           (id, sub_account_id, investor_id, amount_owed, approved_via)
         VALUES ($1,$2,$3,$4,$5)`,
        [newId('SXD'), subAccountId, id, queued, po.authority_id || null]);
    }

    await client.query(
      `INSERT INTO stokvel_payout_lines (id, payout_id, investor_id, share, arrears, net, paid, queued)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (payout_id, investor_id) DO NOTHING`,
      [newId('SPL'), po.id, id, w.gross, w.arrears, w.net, paid, queued]);
    lines.push({ investor_id: id, ...w, paid, queued });
  }

  await client.query(
    `UPDATE stokvel_payouts SET status = 'paid', paid_at = NOW(), updated_at = NOW()
      WHERE id = $1`, [po.id]);

  /* What the arrears released belongs to the members who remain, exactly as
     on an exit. Nobody has left, so it goes back to the same people. */
  await reconcile(client, subAccountId, {
    reason: `Shared out after the ${po.label} payout`, reference: ref });

  return { payout: po.id, label: po.label, reference: ref,
           total, paid: payable, queued: round2(total - payable), lines };
}

/* ── The invariant, as a question ──────────────────────────────────
   Used by the check and by the audit script. Returns the two sides and the
   difference; a healthy stokvel has a difference of zero. */
async function audit(client, subAccountId) {
  const assets = await netAssets(client, subAccountId);
  const members = await activeMembers(client, subAccountId);
  const held = await allocatedTotals(client, subAccountId);
  let shares = 0;
  for (const id of members) shares = round2(shares + (held.get(id) || 0));
  return { assets: assets.total, shares, difference: round2(assets.total - shares), parts: assets };
}

module.exports = {
  netAssets, sharesOf, shareFor, allocateContribution, reconcile, attribute,
  payExitDebts, settleExit, payOut, audit, splitPro, activeMembers, arrearsOf,
};
