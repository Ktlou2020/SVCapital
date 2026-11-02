'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ledger — the single definition of which transaction types move money into or
   out of a wallet.

   Extracted so every consumer derives from one place. The wallet reconciliation
   and the statement opening balance each used to carry their own type list and
   disagreed about `investment` and `fee`, which meant one of them was wrong on
   every run.

   `return` is deliberately absent. A return is an ACCRUAL: jobs/interestCron.js
   credits investors.total_returns and leaves wallet_balance alone. The cash
   reaches the wallet later, at maturity, as a `payout`. Counting both would pay
   the same money twice.

   matured_funds and reinvestment are a matched bookkeeping pair written at
   maturity (jobs/maturityCron.js) with no wallet movement — the money goes
   straight into the new investment. Both are listed so they cancel to zero;
   including either one alone invents or destroys money.

   IMPORTANT — this describes what a transaction row *represents*, not a way to
   rebuild a balance. Almost every write path already applies its effect to
   wallet_balance directly, so summing the ledger and overwriting the column
   double-counts. See the wallet audit: the column is authoritative, and this
   definition exists for reporting and reconciliation, not for repair.
   ───────────────────────────────────────────────────────────────────────────── */

/* stokvel_contribution / stokvel_contribution_received are a matched pair,
   like matured_funds and reinvestment above but with real movement on both
   sides: a member's wallet is debited and their stokvel's is credited by the
   same amount in the same transaction. Both are listed so the pair cancels
   across the platform — listing either alone would report a contribution as
   money entering or leaving SV Capital, which it never is. */
const CASH_CREDIT_TYPES = ['deposit', 'payout', 'interest', 'gift_received', 'referral_bonus', 'matured_funds',
                           'stokvel_contribution_received'];
/* `reversal` is money LEAVING because a card payment was taken back — a
   dispute the client won, or a refund. It is a debit like any other, and it
   has to be in this list: without it a reversed deposit stays counted as
   money the platform holds, and every balance derived from the ledger is
   overstated by exactly the amount somebody took back. */
const CASH_DEBIT_TYPES  = ['withdrawal', 'investment', 'reinvestment', 'fee', 'platform_fee', 'gift_sent',
                           'stokvel_contribution', 'reversal'];

/* The transaction types that are INVESTMENT INCOME — what a client earned, as
   opposed to what moved.
 *
 * `payout` is deliberately absent, and it is the reason this list exists.
 * maturityCron's creditWallet takes (amount, returnPortion) and writes a
 * payout transaction whose amount is the WHOLE credit — the client's capital
 * coming back plus the return on it — while the return portion alone goes to
 * investors.total_returns. Summing payout amounts as income therefore declares
 * the client's own capital as taxable earnings. On a document headed
 * "Investment Income" that is not a rounding problem.
 *
 * `deposit` is absent for the same reason from the other side: it is the
 * client's own money arriving, reported separately as a contribution.
 *
 * This covers income recorded AS A TRANSACTION. The return realised when an
 * investment matures is recorded on the investment (investments.actual_return),
 * not as a transaction of its own, and has to be read from there. The two must
 * be reported side by side rather than added: a maturity whose return was also
 * accrued monthly appears in both, and adding them declares income twice. */
const INCOME_TYPES = ['return', 'interest'];

const _list = arr => arr.map(t => `'${t}'`).join(',');

/* For SQL IN clauses, so no caller retypes the list. */
const incomeTypesSQL = () => _list(INCOME_TYPES);

/* SQL CASE expression for the signed cash effect of a transaction row.
   `p` prefixes the column names for queries that alias the table. */
const cashMovementSQL = (p = '') => `
  CASE
    WHEN ${p}type IN (${_list(CASH_CREDIT_TYPES)}) THEN  ${p}amount
    WHEN ${p}type IN (${_list(CASH_DEBIT_TYPES)})  THEN -${p}amount
    ELSE 0
  END`;

/* The same rule in JavaScript, for the rows already in hand.
 *
 * The SQL version and a hand-written list in the admin console had drifted:
 * the console's DEBIT_TYPES was {investment, reinvestment, withdrawal, fee} and
 * everything else — platform_fee, gift_sent, return, and any type it had never
 * heard of — counted as a credit. So a statement's opening balance came from
 * the SQL and its running balance from the other list, and the two could not
 * agree. A platform fee INCREASED the client's balance down the page.
 *
 * Exported so the one definition serves both, and returns the signed effect of
 * a single row. A type in neither list moves nothing, exactly as the SQL's
 * ELSE 0 does: `return` is an accrual and must not be counted as cash, and a
 * type nobody has classified is not something to guess about in a balance. */
function cashMovement(txn) {
  const type = String((txn && txn.type) || '');
  const amt  = Math.abs(Number(txn && txn.amount) || 0);
  if (CASH_CREDIT_TYPES.includes(type)) return amt;
  if (CASH_DEBIT_TYPES.includes(type))  return -amt;
  return 0;
}

/* Whether a row moves cash at all — the ledger prints these differently from
   the accruals, which belong on the statement but not in the balance. */
const movesCash = txn =>
  CASH_CREDIT_TYPES.includes(String((txn && txn.type) || '')) ||
  CASH_DEBIT_TYPES.includes(String((txn && txn.type) || ''));


/* ─── Writing one ──────────────────────────────────────────────────────────
   Every transaction row goes through here, because the thing it has to carry
   is the thing a call site forgets.

   A row used to say what moved, to whom, and when. It did not say WHO MOVED
   IT. A staff member crediting a wallet from the console, posting interest or
   settling a reconciliation wrote a row indistinguishable from one the client
   caused themselves — and for an FSP holding client money, "who did this" is
   the first question a dispute or a regulator asks. It is also the one answer
   that cannot be reconstructed after the fact.

   Forty INSERT INTO transactions statements across eighteen files is how that
   happened, and adding an actor column to forty call sites is how it would
   happen again: the forty-first would be written without one, and nothing
   would say so. So there is one writer, it REFUSES a row with no actor, and
   check-transaction-actor fails the build if a second INSERT appears
   anywhere else.

   actor.kind is the field that does the work. 'staff' and 'client' are
   people; 'system' is a cron, and names the job, so unattended work is never
   read as somebody's decision.                                            */

const ACTOR_KINDS = ['client', 'staff', 'system'];

/* The caller of an HTTP request, as an actor. req.user comes from the JWT —
   see signToken: { id, email, role, investorId }. */
function actorFromRequest(req, kind) {
  const u = (req && req.user) || {};
  return {
    kind: kind || (u.role && u.role !== 'investor' ? 'staff' : 'client'),
    id:    u.id || u.investorId || null,
    email: u.email || null,
    role:  u.role || null,
    ip:    (req && (req.ip || (req.headers && req.headers['x-forwarded-for']))) || null,
  };
}

/* A cron or a background service. Named, so the row says which one. */
function systemActor(jobName) {
  if (!jobName) throw new Error('systemActor needs the name of the job doing the work');
  return { kind: 'system', id: null, email: null, role: jobName, ip: null };
}

const TX_COLUMNS = ['id', 'investor_id', 'sub_account_id', 'type', 'amount', 'status',
                    'reference', 'description', 'notes', 'investment_id', 'pool_id',
                    'transaction_date', 'referred_investor_id', 'available_at', 'gateway',
                    'actor_kind', 'actor_id', 'actor_email', 'actor_role', 'actor_ip'];

/* db is a pool or a client already inside a transaction — the caller's
   choice, because most of these writes belong to a BEGIN/COMMIT that also
   moves a balance, and splitting the two would be worse than not recording
   the actor at all. */
async function recordTransaction(db, tx, actor, opts = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('recordTransaction needs a pool or client');
  if (!tx || !tx.type) throw new Error('recordTransaction needs a transaction type');
  if (!actor || !ACTOR_KINDS.includes(actor.kind)) {
    throw new Error(`recordTransaction needs an actor: ${ACTOR_KINDS.join(', ')} — `
      + `got ${JSON.stringify(actor && actor.kind)} for a ${tx.type} of ${tx.amount}`);
  }

  const row = {
    id: tx.id || null,
    investor_id: tx.investorId ?? tx.investor_id ?? null,
    sub_account_id: tx.subAccountId ?? tx.sub_account_id ?? null,
    type: tx.type,
    amount: tx.amount,
    status: tx.status || 'completed',
    reference: tx.reference ?? null,
    description: tx.description ?? null,
    notes: tx.notes ?? null,
    investment_id: tx.investmentId ?? tx.investment_id ?? null,
    pool_id: tx.poolId ?? tx.pool_id ?? null,
    transaction_date: tx.transactionDate ?? tx.transaction_date ?? null,
    referred_investor_id: tx.referredInvestorId ?? tx.referred_investor_id ?? null,
    /* When a pending withdrawal becomes available. A date already given to a
       client, so it is written with the row rather than derived later. */
    available_at: tx.availableAt ?? tx.available_at ?? null,
    /* The payment gateway this row came from, where one did. Reconciliation
       asks for exactly these rows, so it is recorded rather than guessed
       at from the shape of a reference. */
    gateway: tx.gateway ?? null,
    actor_kind: actor.kind,
    actor_id: actor.id ? String(actor.id) : null,
    actor_email: actor.email || null,
    actor_role: actor.role || null,
    actor_ip: actor.ip ? String(actor.ip).slice(0, 80) : null,
  };

  /* An id or a date the caller did not supply is filled by SQL rather than
     by a default on the column, so a row is identifiable in the statement
     that writes it. Those two columns take no parameter, so the $n are
     numbered as they are emitted — numbering them by column position and
     then dropping two is how a query ends up reading its arguments one
     place to the left. */
  const values = [];
  const placeholders = TX_COLUMNS.map((c) => {
    if (c === 'id' && row.id == null) return 'gen_random_uuid()::text';
    if (c === 'transaction_date' && row.transaction_date == null) return 'NOW()';
    values.push(row[c]);
    return `$${values.length}`;
  });

  /* Several callers write a row that a retry, a webhook replay or a second
     run of a cron must not duplicate, and rely on the unique index to say
     so. The column is named rather than freely interpolated: this string
     goes into SQL. */
  let conflict = '';
  if (opts.onConflict) {
    if (!['reference', 'id'].includes(opts.onConflict)) {
      throw new Error(`recordTransaction: onConflict must be reference or id, got ${opts.onConflict}`);
    }
    conflict = ` ON CONFLICT (${opts.onConflict}) DO NOTHING`;
  }

  const { rows } = await db.query(
    `INSERT INTO transactions (${TX_COLUMNS.join(', ')}, created_at, updated_at)
     VALUES (${placeholders.join(', ')}, NOW(), NOW())${conflict}
     RETURNING *`,
    values
  );
  /* undefined when a conflict swallowed the row — the caller asked for that
     and should check. */
  return rows[0];
}

/* The columns the writer needs, as DDL, for a check that builds a minimal
   transactions table of its own rather than running the whole schema.

   Two fixtures have now broken because a column was added here and not
   there — each failing with "column does not exist", which reads like a
   product bug and costs an hour before anybody looks at the fixture. A
   fixture generated from TX_COLUMNS cannot fall behind it. */
const TX_COLUMN_TYPES = {
  amount: 'NUMERIC(18,2)',
  transaction_date: 'TIMESTAMPTZ',
  available_at: 'TIMESTAMPTZ',
};
function transactionsFixtureDDL(table = 'transactions') {
  const cols = TX_COLUMNS.map(c =>
    c === 'id' ? 'id TEXT PRIMARY KEY' : `${c} ${TX_COLUMN_TYPES[c] || 'TEXT'}`);
  cols.push('reversed_at TIMESTAMPTZ', 'reversed_reference TEXT',
            'created_at TIMESTAMPTZ DEFAULT NOW()', 'updated_at TIMESTAMPTZ DEFAULT NOW()');
  return `CREATE TABLE ${table} (\n  ${cols.join(',\n  ')}\n)`;
}

module.exports = { CASH_CREDIT_TYPES, CASH_DEBIT_TYPES, INCOME_TYPES,
                   cashMovementSQL, incomeTypesSQL,
                   cashMovement, movesCash, CASH_MOVEMENT: cashMovement,
                   recordTransaction, actorFromRequest, systemActor, ACTOR_KINDS,
                   TX_COLUMNS, transactionsFixtureDDL };
