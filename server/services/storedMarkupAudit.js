/* ═══════════════════════════════════════════════════════════
   Stored-markup audit — text already in the database that the
   admin console would render as markup.

   The write paths are closed: non-privileged writes have their text stripped,
   and email and id_number are refused outright. Neither of those reaches rows
   that are ALREADY stored — written before that fix, or brought in by the
   Firebase migration, which passed through no sanitiser at all.

   One implementation, two front ends: the admin endpoint
   (GET /api/admin/stored-markup-audit) and the CLI
   (server/scripts/audit-stored-markup.cjs). The logic lives here because two
   copies of a security check drift, and then they disagree about whether
   anything is wrong.

   READ-ONLY. Every statement is a SELECT.
   ═══════════════════════════════════════════════════════════ */
'use strict';

/* Where investor-controlled text lands, and which columns the console
   interpolates. Explicit rather than "every text column": a false positive on
   a field nobody renders is noise, and noise is how a real finding gets
   skimmed past. */
const TARGETS = [
  { table: 'investors',        id: 'id', cols: ['first_name', 'last_name', 'email', 'address', 'street_address', 'suburb', 'occupation'] },
  { table: 'sub_accounts',     id: 'id', cols: ['name'] },
  { table: 'support_tickets',  id: 'id', cols: ['subject', 'message'] },
  { table: 'transactions',     id: 'id', cols: ['description', 'reference'] },
  { table: 'investment_pools', id: 'id', cols: ['name', 'description'] },
];

/* Columns whose quotes are structural rather than suspicious.

   investors.notes holds a JSON array — [{"note":…,"admin_email":…}] — so every
   populated row contains double quotes and every one of them was reported as
   attribute-breaking. On the first production run that was most of the
   findings, burying the handful that were real: three investors whose names
   contain an apostrophe.

   They are still scanned for EXECUTABLE content, because a script tag in an
   admin note would be a genuine finding. Only the quote check is skipped, and
   only where quotes are part of the format. */
const STRUCTURED_JSON = new Set(['investors.notes']);

/* Scanned for markup but not for quotes. Listed here rather than dropped from
   TARGETS entirely: excluding the column outright would stop the audit looking
   for the thing that actually matters in it. */
const JSON_COLS = [{ table: 'investors', id: 'id', cols: ['notes'] }];

/* A tag, an inline handler, or a javascript: url — the things that would
   actually run. Deliberately narrower than "contains < or >": a description
   reading "R < 100" is not a finding. */
const EXECUTABLE = col => `(
     ${col} ~* '<[a-z][^>]*>'
  OR ${col} ~* 'on[a-z]+\\s*='
  OR ${col} ~* 'javascript:'
)`;

/* Quotes and stray brackets — these truncate an HTML attribute rather than
   executing. An apostrophe in a surname is ordinary, so these are counted
   separately and never reported as an incident. */
const BREAKING = col => `(${col} ~ '[<>"'']')`;

async function hasTable(db, t) {
  const { rows } = await db.query(`SELECT to_regclass('public.' || $1) IS NOT NULL AS ok`, [t]);
  return rows[0].ok;
}
async function hasColumn(db, t, c) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int n FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`, [t, c]);
  return rows[0].n > 0;
}

/* `limit` caps rows per column, not overall: a single noisy column must not
   crowd out a genuine finding in another one. */
async function runStoredMarkupAudit(db, { limit = 200 } = {}) {
  const perColumn = Math.min(1000, Math.max(1, parseInt(limit, 10) || 200));
  const executable = [], breaking = [];
  const scanned = [], skipped = [];

  for (const t of [...TARGETS, ...JSON_COLS]) {
    if (!await hasTable(db, t.table)) { skipped.push(t.table); continue; }
    for (const col of t.cols) {
      if (!await hasColumn(db, t.table, col)) { skipped.push(`${t.table}.${col}`); continue; }
      scanned.push(`${t.table}.${col}`);

      const ex = EXECUTABLE(col);
      const { rows: hits } = await db.query(
        `SELECT ${t.id} AS row_id, ${col} AS value FROM ${t.table}
          WHERE ${col} IS NOT NULL AND ${ex} LIMIT ${perColumn}`);
      for (const h of hits) {
        executable.push({ table: t.table, column: col, rowId: h.row_id, value: String(h.value).slice(0, 400) });
      }

      /* Skipped where quotes are part of the column's format — see
         STRUCTURED_JSON. The markup scan above still ran. */
      if (STRUCTURED_JSON.has(`${t.table}.${col}`)) continue;

      /* AND NOT the executable predicate, so a row is reported once, at its
         worst severity, rather than appearing in both lists. */
      const { rows: soft } = await db.query(
        `SELECT ${t.id} AS row_id, ${col} AS value FROM ${t.table}
          WHERE ${col} IS NOT NULL AND ${BREAKING(col)} AND NOT ${ex} LIMIT ${perColumn}`);
      for (const s of soft) {
        breaking.push({ table: t.table, column: col, rowId: s.row_id, value: String(s.value).slice(0, 400) });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    scanned, skipped,
    quotesNotChecked: [...STRUCTURED_JSON],
    executable, breaking,
    totals: { executable: executable.length, breaking: breaking.length },
    verdict: executable.length ? 'executable-found'
           : breaking.length   ? 'attribute-breaking-only'
           : 'clean',
  };
}

module.exports = { runStoredMarkupAudit, TARGETS, STRUCTURED_JSON };
