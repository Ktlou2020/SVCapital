'use strict';
/* ═══════════════════════════════════════════════════════════
   The 30-day notice fund — a pooled fund a group holds beside its wallet.

   Always open to money coming in; money out is paid back to the GROUP'S
   WALLET no sooner than the fund's notice period (30 days at least) after
   the group asks. The schema header in db/setup.js explains the tables;
   this is every rule, in one place.

   THE RETURN IS A PROJECTED MONTHLY RATE, declared by the fund's managers
   before each month starts (notice_fund_rates) and fixed once the month
   has begun. It drives the unit price:

     · each month starts at the price the last one ended on;
     · within a month the price rises DAY BY DAY at that month's rate —
       on day d of an N-day month it is start x (1 + rate x (d-1)/N);
     · the month ends at start x (1 + rate), which the next month builds on.

   So money earns for the days it is in, and the return stays in the fund
   and compounds monthly. It is a PROJECTION: the screens call it that, and
   nothing here or on them calls it a guarantee.

   Because the price is known for every day of a month with a rate, money
   is dealt on the day: in at today's price, out at the price on the day the
   notice ends. A month with no rate declared cannot be priced, and money in
   or out waits for it rather than being dealt at a guess.

   MONEY IN leaves the group wallet, so it clears the mandate like any
   investment: the signatories approve a 'notice_deposit' authority for that
   amount into that fund, spent once. THE 1% PLATFORM FEE IS CHARGED ON TOP,
   as on the pools: the approved amount is what reaches the fund, and the
   wallet pays it plus 1%. The fund's minimum is tested against the amount
   reaching the fund, never against the wallet spend.

   MONEY OUT goes back to the group's wallet, where it is still the group's
   and still behind the mandate before it can leave, so asking for it is the
   committee's or a signatory's call.

   THE GROUP'S SHARES carry the fund at COST (stokvelShares.netAssets). A
   fee leaves the pot when it is charged and a gain enters it when it is
   realised, each shared out by reconcile.

   OFF UNTIL SWITCHED ON: notice_fund_live in platform settings.
   ═══════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const { recordTransaction, systemActor } = require('./ledger');
const { PLATFORM_FEE_PCT } = require('./poolFees');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const round6 = n => Math.round((Number(n) || 0) * 1e6) / 1e6;
const newId  = p => `${p}-${crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;
const DAY = 86400000;
const MAX_MONTHLY_RATE = 0.2;

/* The South African calendar date of an instant, as YYYY-MM-DD. */
function sastDate(when) {
  return new Date(new Date(when).getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}
const monthOf = date => `${String(date).slice(0, 7)}-01`;
function nextMonth(month) {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
function daysIn(month) {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function feeOn(amount) { return round2(round2(amount) * PLATFORM_FEE_PCT); }

async function isLive(db) {
  const { rows: [r] } = await db.query(`SELECT value FROM platform_settings WHERE key = 'notice_fund_live'`);
  return String(r && r.value || '').trim() === 'true';
}

async function openFund(db) {
  const { rows: [f] } = await db.query(
    `SELECT * FROM notice_funds WHERE status = 'open' ORDER BY created_at ASC LIMIT 1`);
  return f || null;
}

async function rates(db, fundId) {
  const { rows } = await db.query(
    `SELECT to_char(month, 'YYYY-MM-DD') AS month, monthly_rate FROM notice_fund_rates
      WHERE fund_id = $1 ORDER BY month ASC`, [fundId]);
  return rows.map(r => ({ month: r.month, rate: Number(r.monthly_rate) }));
}

/**
 * The unit price on a date, from the declared rates. Pure arithmetic over
 * `list` ({ month, rate }, ascending). Starts at 1.000000 on the first day
 * of the fund's first rated month. Returns { unit_price, price_date,
 * monthly_rate } or { missing: 'YYYY-MM' } when a month on the way has no
 * rate, or null before the fund's first month.
 */
function priceFrom(list, date) {
  if (!list.length) return null;
  const target = monthOf(date);
  const byMonth = new Map(list.map(r => [r.month, r.rate]));
  let month = list[0].month;
  if (target < month) return null;
  let price = 1;
  while (month < target) {
    if (!byMonth.has(month)) return { missing: month.slice(0, 7) };
    price *= 1 + byMonth.get(month);
    month = nextMonth(month);
  }
  if (!byMonth.has(target)) return { missing: target.slice(0, 7) };
  const r = byMonth.get(target);
  const day = Number(String(date).slice(8, 10));
  price *= 1 + r * (day - 1) / daysIn(target);
  return { unit_price: round6(price), price_date: String(date).slice(0, 10), monthly_rate: r };
}

async function priceOn(db, fundId, date) {
  return priceFrom(await rates(db, fundId), date);
}

/* The rate for this month and the next, as groups see them. */
async function projected(db, fundId, now = Date.now()) {
  const list = await rates(db, fundId);
  const thisMonth = monthOf(sastDate(now));
  const find = m => { const r = list.find(x => x.month === m); return r ? r.rate : null; };
  return { this_month: thisMonth.slice(0, 7), this_rate: find(thisMonth),
           next_month: nextMonth(thisMonth).slice(0, 7), next_rate: find(nextMonth(thisMonth)) };
}

async function position(db, fundId, groupId, now = Date.now()) {
  const { rows: [h] } = await db.query(
    `SELECT units, cost FROM notice_fund_holdings WHERE fund_id = $1 AND sub_account_id = $2`, [fundId, groupId]);
  const units = h ? Number(h.units) : 0;
  const cost  = h ? Number(h.cost) : 0;
  const p = await priceOn(db, fundId, sastDate(now));
  const price = p && p.unit_price ? p : null;
  const value = price ? round2(units * price.unit_price) : null;
  return { units: round6(units), cost: round2(cost), value, price,
           gain: value == null ? null : round2(value - cost) };
}

/* ── Declaring the month's projected rate ───────────────────────────── */

/* A month's rate can be set, and changed, until that month starts. After
   that it is fixed: groups have been dealt at it. A month that has started
   with no rate (the managers missed it) can be declared once, late, and
   is then fixed like any other — money waiting on it is dealt straight
   away by settle(). */
async function declareRate(db, { fundId, month, ratePct, by, now = Date.now() }) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return { error: 'The month is required (YYYY-MM).' };
  const pct = Number(ratePct);
  if (!(pct >= 0) || pct / 100 >= MAX_MONTHLY_RATE) return { error: 'The monthly rate must be from 0% to under 20%.' };
  const m = `${month}-01`;
  const started = m <= monthOf(sastDate(now));
  const { rows: [f] } = await db.query(`SELECT id FROM notice_funds WHERE id = $1`, [fundId]);
  if (!f) return { error: 'No such fund.' };
  const list = await rates(db, fundId);
  if (list.length && m < list[0].month) return { error: 'That is before the fund’s first month.' };
  const existing = list.find(r => r.month === m);
  if (existing && started) return { error: `${month} has started, so its rate is fixed. Groups have been dealt at it.` };
  await db.query(
    `INSERT INTO notice_fund_rates (fund_id, month, monthly_rate, declared_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (fund_id, month) DO UPDATE SET monthly_rate = EXCLUDED.monthly_rate,
            declared_by = EXCLUDED.declared_by, updated_at = NOW()`,
    [fundId, m, round6(pct / 100), by || null]);
  const settled = await settle(db, fundId, { now });
  return { declared: { fund_id: fundId, month, monthly_rate_pct: pct }, settled };
}

/* ── Money in ───────────────────────────────────────────────────────── */

/**
 * Move an approved amount from the group's wallet into the fund, dealt at
 * today's price. In the caller's transaction; the caller has checked the
 * authority and consumes it in the same transaction.
 * Returns { order } or { error }.
 */
async function subscribe(client, { group, fund, amount, authorityId, actor, now = Date.now() }) {
  amount = round2(amount);
  if (!(amount > 0)) return { error: 'An amount is required.' };
  if (fund.status !== 'open') return { error: 'The fund is not taking money at the moment.' };
  if (amount + 0.0001 < Number(fund.min_deposit || 0)) {
    return { error: `The fund takes R${Number(fund.min_deposit).toFixed(2)} or more at a time.` };
  }
  const today = sastDate(now);
  const price = await priceOn(client, fund.id, today);
  if (!price || !price.unit_price) {
    return { error: `This month’s projected rate has not been declared yet, so money cannot go into the fund today. Try again once it has.` };
  }
  const fee = feeOn(amount);
  const spend = round2(amount + fee);
  const { rows: [g] } = await client.query(
    `SELECT wallet_balance, parent_investor_id FROM sub_accounts WHERE id = $1 FOR UPDATE`, [group.id]);
  if (!g || Number(g.wallet_balance) + 0.0001 < spend) {
    return { error: `R${amount.toFixed(2)} into the fund with the 1% fee on top needs R${spend.toFixed(2)}, and the group wallet holds R${Number(g ? g.wallet_balance : 0).toFixed(2)}.` };
  }
  const units = round6(amount / price.unit_price);
  const id = newId('NFO');
  await client.query(
    `UPDATE sub_accounts SET wallet_balance = wallet_balance - $1,
            total_invested = COALESCE(total_invested, 0) + $2, updated_at = NOW() WHERE id = $3`,
    [spend, amount, group.id]);
  await client.query(
    `INSERT INTO notice_fund_orders (id, fund_id, sub_account_id, kind, status, amount, fee, units, unit_price,
                                     price_date, requested_by, authority_id, reference, completed_at)
     VALUES ($1,$2,$3,'subscription','completed',$4,$5,$6,$7,$8,$9,$10,$1,NOW())`,
    [id, fund.id, group.id, amount, fee, units, price.unit_price, today,
     actor && actor.id ? String(actor.id) : null, authorityId || null]);
  await client.query(
    `INSERT INTO notice_fund_holdings (fund_id, sub_account_id, units, cost) VALUES ($1,$2,$3,$4)
     ON CONFLICT (fund_id, sub_account_id)
     DO UPDATE SET units = notice_fund_holdings.units + EXCLUDED.units,
                   cost  = notice_fund_holdings.cost  + EXCLUDED.cost, updated_at = NOW()`,
    [fund.id, group.id, units, amount]);
  const who = actor || systemActor('noticeFund:subscribe');
  await recordTransaction(client, {
    investorId: g.parent_investor_id, subAccountId: group.id, type: 'investment', amount,
    reference: id, description: `Into ${fund.name} — ${units} units at R${price.unit_price}`,
  }, who);
  if (fee > 0) {
    await recordTransaction(client, {
      id: `FEE-${id}`, investorId: g.parent_investor_id, subAccountId: group.id, type: 'fee', amount: fee,
      reference: `FEE-${id}`, description: `1% platform fee on ${fund.name}`,
    }, who);
  }
  /* The fee has left the pot; share that out now, in this transaction. */
  await require('./stokvelShares').reconcile(client, group.id,
    { reason: `Platform fee on money into ${fund.name}`, reference: id });
  return { order: { id, kind: 'subscription', amount, fee, wallet_spend: spend, units,
                    unit_price: price.unit_price, status: 'completed' } };
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

/* Pay every withdrawal whose notice has run, at the price on the day it
   ran. One transaction each, so one group's problem cannot hold up
   another's money. A month with no declared rate leaves it waiting. */
async function settle(pool, fundId, { now = Date.now() } = {}) {
  const { rows: [fund] } = await pool.query(`SELECT * FROM notice_funds WHERE id = $1`, [fundId]);
  if (!fund) return { redemptions: 0, waiting: 0 };
  const { rows: orders } = await pool.query(
    `SELECT id FROM notice_fund_orders WHERE fund_id = $1 AND status = 'pending' AND kind = 'redemption'
        AND payable_at <= $2 ORDER BY payable_at ASC`, [fundId, new Date(now)]);
  let reds = 0, waiting = 0;
  for (const o of orders) {
    const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
    const own = client !== pool;
    try {
      if (own) await client.query('BEGIN');
      const r = await _payOne(client, fund, o.id);
      if (own) await client.query('COMMIT');
      if (r) reds++; else waiting++;
    } catch (err) {
      if (own) await client.query('ROLLBACK').catch(() => {});
      console.error(`[noticeFund] paying ${o.id} failed:`, err.message);
    } finally {
      if (own) client.release();
    }
  }
  return { redemptions: reds, waiting };
}

async function _payOne(client, fund, orderId) {
  const { rows: [o] } = await client.query(
    `SELECT * FROM notice_fund_orders WHERE id = $1 AND status = 'pending' FOR UPDATE`, [orderId]);
  if (!o) return false;
  const day = sastDate(o.payable_at);
  const p = await priceOn(client, fund.id, day);
  if (!p || !p.unit_price) return false;
  const { rows: [h] } = await client.query(
    `SELECT units, cost FROM notice_fund_holdings WHERE fund_id = $1 AND sub_account_id = $2 FOR UPDATE`,
    [fund.id, o.sub_account_id]);
  const held = h ? Number(h.units) : 0;
  const heldCost = h ? Number(h.cost) : 0;
  if (!(held > 0)) {
    await client.query(`UPDATE notice_fund_orders SET status = 'cancelled', completed_at = NOW() WHERE id = $1`, [o.id]);
    return true;
  }
  const want = o.all_units ? held : Math.min(held, round6(Number(o.amount) / p.unit_price));
  const units = held - want < 0.000001 ? held : round6(want);
  const proceeds = round2(units * p.unit_price);
  const costReleased = units === held ? round2(heldCost) : round2(heldCost * units / held);
  const gain = round2(proceeds - costReleased);
  await client.query(
    `UPDATE notice_fund_holdings SET units = GREATEST(0, units - $3), cost = GREATEST(0, cost - $4), updated_at = NOW()
      WHERE fund_id = $1 AND sub_account_id = $2`, [fund.id, o.sub_account_id, units, costReleased]);
  const { rows: [g] } = await client.query(
    `UPDATE sub_accounts SET wallet_balance = wallet_balance + $1,
            total_invested = GREATEST(0, COALESCE(total_invested, 0) - $2),
            total_returns = COALESCE(total_returns, 0) + $3, updated_at = NOW()
      WHERE id = $4 RETURNING parent_investor_id`, [proceeds, costReleased, gain, o.sub_account_id]);
  await client.query(
    `UPDATE notice_fund_orders SET status = 'completed', units = $2, unit_price = $3, price_date = $4,
            proceeds = $5, cost_released = $6, completed_at = NOW() WHERE id = $1`,
    [o.id, units, p.unit_price, day, proceeds, costReleased]);
  await recordTransaction(client, {
    investorId: g && g.parent_investor_id, subAccountId: o.sub_account_id, type: 'payout', amount: proceeds,
    reference: `${o.id}-PAID`,
    description: `From ${fund.name} after ${fund.notice_days} days' notice — ${units} units at R${p.unit_price}`,
  }, systemActor('noticeFund:settle'));
  await require('./stokvelShares').reconcile(client, o.sub_account_id,
    { reason: `${fund.name}: withdrawal priced ${day}`, reference: o.id });
  return true;
}

module.exports = { isLive, openFund, rates, priceFrom, priceOn, projected, position, feeOn,
                   declareRate, subscribe, requestRedemption, cancelRedemption, settle, sastDate };
