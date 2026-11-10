'use strict';
/* ═══════════════════════════════════════════════════════════
   The 30-day notice fund — a pooled fund a group holds beside its wallet.

   Always open to money coming in; money out is paid back to the GROUP'S
   WALLET no sooner than the fund's notice period (30 days at least) after
   the group asks. The schema header in db/setup.js explains the tables;
   this is every rule, in one place.

   MONEY IN leaves the group wallet, so it clears the mandate like any
   investment: the signatories approve a 'notice_deposit' authority for that
   amount into that fund, and it is spent once. The rands leave the wallet
   at once and buy units at the first price published on or after that day.

   MONEY OUT goes back to the group's wallet, where it is still the group's
   and still behind the mandate before it can leave. So asking for it is the
   committee's or a signatory's call, not a vote; what protects the group is
   that it can only ever land in the group's own wallet. It is priced at the
   first price on or after the day its notice ends, and paid then.

   THE GROUP'S SHARES carry the fund at COST, as they carry every investment
   (stokvelShares.netAssets includes holdings and money waiting for a price).
   A gain is shared out when it is realised, on redemption, by reconcile —
   the platform's rule that a projection is nobody's money yet.

   PRICES ARE POSTED BY STAFF (the fund's managers), and posting one settles
   every order it prices, in the same call. A daily job settles anything a
   price posted earlier now covers.

   OFF UNTIL SWITCHED ON. notice_fund_live in platform settings. While off,
   staff can create the fund and post prices; groups see nothing.
   ═══════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const { recordTransaction, systemActor } = require('./ledger');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const round6 = n => Math.round((Number(n) || 0) * 1e6) / 1e6;
const newId  = p => `${p}-${crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;
const DAY = 86400000;

/* The South African calendar date of an instant, as YYYY-MM-DD. Prices are
   dated in SAST and a deposit at 23:30 on the 30th belongs to the 30th. */
function sastDate(when) {
  return new Date(new Date(when).getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

async function isLive(db) {
  const { rows: [r] } = await db.query(`SELECT value FROM platform_settings WHERE key = 'notice_fund_live'`);
  return String(r && r.value || '').trim() === 'true';
}

/* The fund groups are offered: the open one. */
async function openFund(db) {
  const { rows: [f] } = await db.query(
    `SELECT * FROM notice_funds WHERE status = 'open' ORDER BY created_at ASC LIMIT 1`);
  return f || null;
}

async function latestPrice(db, fundId) {
  const { rows: [p] } = await db.query(
    `SELECT unit_price, price_date FROM notice_fund_prices WHERE fund_id = $1
      ORDER BY price_date DESC LIMIT 1`, [fundId]);
  return p ? { unit_price: Number(p.unit_price), price_date: sastDate(p.price_date) } : null;
}

/* Where a group stands in a fund. Value is at the latest price and is an
   indication; cost is what its shares carry. */
async function position(db, fundId, groupId) {
  const { rows: [h] } = await db.query(
    `SELECT units, cost FROM notice_fund_holdings WHERE fund_id = $1 AND sub_account_id = $2`, [fundId, groupId]);
  const units = h ? Number(h.units) : 0;
  const cost  = h ? Number(h.cost) : 0;
  const price = await latestPrice(db, fundId);
  const { rows: [w] } = await db.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'subscription'), 0) AS waiting_in
       FROM notice_fund_orders WHERE fund_id = $1 AND sub_account_id = $2 AND status = 'pending'`, [fundId, groupId]);
  const value = price ? round2(units * price.unit_price) : null;
  return { units: round6(units), cost: round2(cost), value, price,
           waiting_in: round2(w.waiting_in), gain: value == null ? null : round2(value - cost) };
}

/* ── Money in ───────────────────────────────────────────────────────── */

/**
 * Move an approved amount from the group's wallet into the fund. In the
 * caller's transaction; the caller has checked the authority with
 * stokvelMandate.authorityFor and consumes it in the same transaction.
 * Returns { order } or { error }.
 */
async function subscribe(client, { group, fund, amount, authorityId, actor }) {
  amount = round2(amount);
  if (!(amount > 0)) return { error: 'An amount is required.' };
  if (fund.status !== 'open') return { error: 'The fund is not taking money at the moment.' };
  if (amount + 0.0001 < Number(fund.min_deposit || 0)) {
    return { error: `The fund takes R${Number(fund.min_deposit).toFixed(2)} or more at a time.` };
  }
  const { rows: [g] } = await client.query(
    `SELECT wallet_balance, parent_investor_id FROM sub_accounts WHERE id = $1 FOR UPDATE`, [group.id]);
  if (!g || Number(g.wallet_balance) + 0.0001 < amount) {
    return { error: `The group wallet holds R${Number(g ? g.wallet_balance : 0).toFixed(2)}, less than R${amount.toFixed(2)}.` };
  }
  const id = newId('NFO');
  await client.query(
    `UPDATE sub_accounts SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2`, [amount, group.id]);
  await client.query(
    `INSERT INTO notice_fund_orders (id, fund_id, sub_account_id, kind, amount, requested_by, authority_id, reference)
     VALUES ($1,$2,$3,'subscription',$4,$5,$6,$1)`,
    [id, fund.id, group.id, amount, actor && actor.id ? String(actor.id) : null, authorityId || null]);
  await recordTransaction(client, {
    investorId: g.parent_investor_id, subAccountId: group.id, type: 'investment', amount,
    reference: id, description: `Into ${fund.name} — units priced at the next published price`,
  }, actor || systemActor('noticeFund:subscribe'));
  return { order: { id, kind: 'subscription', amount, status: 'pending' } };
}

/* ── Money out ──────────────────────────────────────────────────────── */

async function requestRedemption(client, { group, fund, amount, all, actorId }) {
  const pos = await position(client, fund.id, group.id);
  if (!(pos.units > 0)) return { error: 'The group holds nothing in the fund yet.' };
  let amt = null;
  if (!all) {
    amt = round2(amount);
    if (!(amt > 0)) return { error: 'Say how much, or ask for everything.' };
    if (pos.value != null && amt > pos.value + 0.005) {
      return { error: `That is more than the group's holding is worth (about R${pos.value.toFixed(2)}). Ask for everything instead.` };
    }
  }
  const id = newId('NFO');
  const payableAt = new Date(Date.now() + Number(fund.notice_days || 30) * DAY);
  try {
    await client.query(
      `INSERT INTO notice_fund_orders (id, fund_id, sub_account_id, kind, amount, all_units, requested_by, payable_at, reference)
       VALUES ($1,$2,$3,'redemption',$4,$5,$6,$7,$1)`,
      [id, fund.id, group.id, amt, !!all, actorId, payableAt]);
  } catch (e) {
    if (e.code === '23505') return { error: 'The group already has a withdrawal from the fund waiting. Cancel it first to change it.' };
    throw e;
  }
  return { order: { id, kind: 'redemption', amount: amt, all: !!all, payable_at: payableAt, status: 'pending' } };
}

async function cancelRedemption(client, { group, orderId, actorId }) {
  const { rowCount } = await client.query(
    `UPDATE notice_fund_orders SET status = 'cancelled', cancelled_by = $3, completed_at = NOW()
      WHERE id = $1 AND sub_account_id = $2 AND kind = 'redemption' AND status = 'pending'`,
    [orderId, group.id, actorId]);
  return rowCount ? { cancelled: true } : { error: 'No withdrawal from the fund is waiting with that id.' };
}

/* ── Pricing ────────────────────────────────────────────────────────── */

/* Post a price and settle what it prices. A price, once posted, is the
   price orders were dealt at, so it is not overwritten: a correction is a
   decision for the fund's managers to make by hand, with the orders
   in front of them. */
async function postPrice(db, { fundId, priceDate, unitPrice, postedBy }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(priceDate || ''))) return { error: 'A price date is required (YYYY-MM-DD).' };
  const price = Number(unitPrice);
  if (!(price > 0)) return { error: 'The unit price must be more than zero.' };
  if (priceDate > sastDate(Date.now())) return { error: 'A price cannot be posted for a date that has not happened.' };
  try {
    await db.query(
      `INSERT INTO notice_fund_prices (fund_id, price_date, unit_price, posted_by) VALUES ($1,$2,$3,$4)`,
      [fundId, priceDate, price, postedBy || null]);
  } catch (e) {
    if (e.code === '23505') return { error: `A price for ${priceDate} is already posted. Prices are not overwritten.` };
    if (e.code === '23503') return { error: 'No such fund.' };
    throw e;
  }
  const settled = await settle(db, fundId);
  return { posted: { fund_id: fundId, price_date: priceDate, unit_price: price }, settled };
}

/* The price that deals an order: the first on or after its date. */
async function priceOnOrAfter(db, fundId, date) {
  const { rows: [p] } = await db.query(
    `SELECT unit_price, price_date FROM notice_fund_prices
      WHERE fund_id = $1 AND price_date >= $2 ORDER BY price_date ASC LIMIT 1`, [fundId, date]);
  return p ? { unit_price: Number(p.unit_price), price_date: sastDate(p.price_date) } : null;
}

/* Settle every pending order a posted price now covers. One transaction
   per order, so one group's problem cannot hold up another's money. */
async function settle(pool, fundId) {
  const { rows: fundRows } = await pool.query(`SELECT * FROM notice_funds WHERE id = $1`, [fundId]);
  const fund = fundRows[0];
  if (!fund) return { subscriptions: 0, redemptions: 0 };
  const { rows: orders } = await pool.query(
    `SELECT id FROM notice_fund_orders WHERE fund_id = $1 AND status = 'pending'
      ORDER BY requested_at ASC`, [fundId]);
  let subs = 0, reds = 0, waiting = 0;
  for (const o of orders) {
    const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
    const own = client !== pool;
    try {
      if (own) await client.query('BEGIN');
      const r = await _settleOne(client, fund, o.id);
      if (own) await client.query('COMMIT');
      if (r === 'subscription') subs++; else if (r === 'redemption') reds++; else waiting++;
    } catch (err) {
      if (own) await client.query('ROLLBACK').catch(() => {});
      console.error(`[noticeFund] settling ${o.id} failed:`, err.message);
    } finally {
      if (own) client.release();
    }
  }
  return { subscriptions: subs, redemptions: reds, waiting };
}

async function _settleOne(client, fund, orderId) {
  const { rows: [o] } = await client.query(
    `SELECT * FROM notice_fund_orders WHERE id = $1 AND status = 'pending' FOR UPDATE`, [orderId]);
  if (!o) return null;
  if (o.kind === 'subscription') {
    const p = await priceOnOrAfter(client, fund.id, sastDate(o.requested_at));
    if (!p) return null;
    const units = round6(Number(o.amount) / p.unit_price);
    await client.query(
      `INSERT INTO notice_fund_holdings (fund_id, sub_account_id, units, cost) VALUES ($1,$2,$3,$4)
       ON CONFLICT (fund_id, sub_account_id)
       DO UPDATE SET units = notice_fund_holdings.units + EXCLUDED.units,
                     cost  = notice_fund_holdings.cost  + EXCLUDED.cost, updated_at = NOW()`,
      [fund.id, o.sub_account_id, units, o.amount]);
    await client.query(
      `UPDATE notice_fund_orders SET status = 'completed', units = $2, unit_price = $3, price_date = $4, completed_at = NOW()
        WHERE id = $1`, [o.id, units, p.unit_price, p.price_date]);
    return 'subscription';
  }

  /* A redemption: only once its notice has run, at the first price on or
     after that day. */
  if (new Date(o.payable_at) > new Date()) return null;
  const p = await priceOnOrAfter(client, fund.id, sastDate(o.payable_at));
  if (!p) return null;
  const { rows: [h] } = await client.query(
    `SELECT units, cost FROM notice_fund_holdings WHERE fund_id = $1 AND sub_account_id = $2 FOR UPDATE`,
    [fund.id, o.sub_account_id]);
  const held = h ? Number(h.units) : 0;
  const heldCost = h ? Number(h.cost) : 0;
  if (!(held > 0)) {
    await client.query(`UPDATE notice_fund_orders SET status = 'cancelled', completed_at = NOW() WHERE id = $1`, [o.id]);
    return 'redemption';
  }
  const want = o.all_units ? held : Math.min(held, round6(Number(o.amount) / p.unit_price));
  const units = held - want < 0.000001 ? held : round6(want);
  const proceeds = round2(units * p.unit_price);
  const costReleased = units === held ? round2(heldCost) : round2(heldCost * units / held);
  await client.query(
    `UPDATE notice_fund_holdings SET units = GREATEST(0, units - $3), cost = GREATEST(0, cost - $4), updated_at = NOW()
      WHERE fund_id = $1 AND sub_account_id = $2`, [fund.id, o.sub_account_id, units, costReleased]);
  const gain = round2(proceeds - costReleased);
  const { rows: [g] } = await client.query(
    `UPDATE sub_accounts SET wallet_balance = wallet_balance + $1,
            total_returns = COALESCE(total_returns, 0) + $2, updated_at = NOW()
      WHERE id = $3 RETURNING parent_investor_id`, [proceeds, gain, o.sub_account_id]);
  await client.query(
    `UPDATE notice_fund_orders SET status = 'completed', units = $2, unit_price = $3, price_date = $4,
            proceeds = $5, cost_released = $6, completed_at = NOW() WHERE id = $1`,
    [o.id, units, p.unit_price, p.price_date, proceeds, costReleased]);
  await recordTransaction(client, {
    investorId: g && g.parent_investor_id, subAccountId: o.sub_account_id, type: 'payout', amount: proceeds,
    reference: `${o.id}-PAID`,
    description: `From ${fund.name} after ${fund.notice_days} days' notice — ${units} units at R${p.unit_price}`,
  }, systemActor('noticeFund:settle'));
  /* A gain or a loss is realised now, and is shared out now. */
  await require('./stokvelShares').reconcile(client, o.sub_account_id,
    { reason: `${fund.name}: withdrawal priced ${p.price_date}`, reference: o.id });
  return 'redemption';
}

module.exports = { isLive, openFund, latestPrice, position, subscribe, requestRedemption,
                   cancelRedemption, postPrice, settle, sastDate };
