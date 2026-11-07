'use strict';
/* Reading investor_type out of the Firebase export, and writing nothing else.
 *
 * The export has carried investorType all along and the migration never read
 * it, so every imported client reads "Not set" in the console. Re-running the
 * migration now WOULD set it — and would also rewrite first_name, last_name,
 * email, phone, id_number, date_of_birth, kyc_status, fica_status, status,
 * risk_profile, occupation, notes, address and province from a file that
 * predates every correction staff have made since the import, on every
 * client, to fill in one column.
 *
 * So this reads the same users.json and touches investor_type.
 *
 * ── WHAT IT WILL NOT DO ───────────────────────────────────────────────
 *
 * GUESS. A value normaliseInvestorType does not recognise is reported and
 * skipped, never defaulted to 'individual': that would turn an imported trust
 * into a natural person, silently and permanently, and the next FICA run
 * would verify it against Home Affairs instead of its deed and trustees. An
 * unknown is a question somebody can see and close; a wrong answer is not.
 *
 * OVERRULE THE CONSOLE. A type somebody has already set by hand is left
 * alone and the disagreement is reported, unless overwrite says otherwise.
 * The console is the more recent authority.
 *
 * HALF-FINISH. One transaction. A book that is half-classified shows a
 * mixture nobody can tell apart from a partial import.
 *
 * survey() reads and never writes; execute() writes. Both the command-line
 * script and the console panel call these, so there is one classification and
 * one write, not two that drift — the same split as services/productReimport.
 */

const { normaliseInvestorType, investorTypeLabel } = require('./investorType');
const audit = require('./audit');

/* The export is an array. A hand-assembled file is sometimes wrapped, so
   those two shapes are read as well rather than rejected on a formality. */
function recordsOf(raw) {
  const all = Array.isArray(raw) ? raw : (raw && (raw.users || raw.data)) || [];
  return Array.isArray(all) ? all : [];
}

const nameOf = r => [r.first_name, r.last_name].filter(Boolean).join(' ') || r.id;

/* ── The survey. Reads; never writes. ───────────────────────────────── */
async function survey(db, { records }) {
  const all = recordsOf(records);
  if (!all.length) {
    const e = new Error('That file holds no user records.');
    e.status = 400; throw e;
  }

  /* What the export says, per account number. */
  const wanted   = new Map();   // id → canonical type
  const unmapped = new Map();   // raw value → count
  let noType = 0, noId = 0;
  for (const u of all) {
    const id = u && u.userAccountNumber;
    if (!id) { noId++; continue; }
    if (!u.investorType) { noType++; continue; }
    const t = normaliseInvestorType(u.investorType);
    if (!t) {
      const raw = String(u.investorType);
      unmapped.set(raw, (unmapped.get(raw) || 0) + 1);
      continue;
    }
    wanted.set(String(id), t);
  }

  /* What the database has. Only the ones the export actually names. */
  const ids = [...wanted.keys()];
  const { rows: current } = ids.length
    ? await db.query(
        `SELECT id, first_name, last_name, investor_type
           FROM investors WHERE id = ANY($1::text[])`, [ids])
    : { rows: [] };
  const have = new Map(current.map(r => [r.id, r]));

  const toSet = [], conflicts = [], unchanged = [], missing = [];
  for (const [id, type] of wanted) {
    const row = have.get(id);
    if (!row)                        { missing.push({ id, type }); continue; }
    if (!row.investor_type)          { toSet.push({ id, type, name: nameOf(row) }); continue; }
    if (row.investor_type === type)  { unchanged.push(id); continue; }
    conflicts.push({ id, type, was: row.investor_type, name: nameOf(row) });
  }

  const byType = {};
  for (const t of toSet) byType[t.type] = (byType[t.type] || 0) + 1;

  return {
    total: all.length,
    toSet, conflicts, unchanged, missing,
    unmapped: [...unmapped].map(([value, count]) => ({ value, count })),
    noType, noId, byType,
  };
}

/* ── The write. One transaction, or none. ───────────────────────────── */
async function execute(db, { survey: s, overwrite = false, source = 'cli', actor } = {}) {
  const writes = overwrite ? [...s.toSet, ...s.conflicts] : s.toSet;
  if (!writes.length) return { written: 0, overwritten: 0, warnings: [] };

  const client = await db.connect();
  let written = 0;
  try {
    await client.query('BEGIN');
    for (const w of writes) {
      const { rowCount } = await client.query(
        `UPDATE investors SET investor_type = $2, updated_at = NOW() WHERE id = $1`,
        [w.id, w.type]);
      written += rowCount;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  /* Audited after the commit: a failed audit row must not undo a write that
     succeeded, and an audit row for a write that rolled back would be a lie.
     The overrides are logged one by one because each one overruled a person;
     the fills are one row, because they filled a blank. */
  const warnings = [];
  const who = {
    actorId: (actor && actor.id) || null,
    actorEmail: (actor && actor.email) || 'cli',
    actorRole: (actor && actor.role) || 'admin',
  };
  if (overwrite) {
    for (const c of s.conflicts) {
      await audit.log({ ...who,
        action: 'investor_type_overwritten',
        entityType: 'investor', entityId: c.id,
        description: `Investor type changed from ${investorTypeLabel(c.was)} to ` +
          `${investorTypeLabel(c.type)} from the Firebase export (${source}), ` +
          'overruling the value set in the console.',
        before: { investor_type: c.was },
        after:  { investor_type: c.type, source },
      }).catch(e => warnings.push(`${c.id} written, but the audit row failed: ${e.message}`));
    }
  }
  await audit.log({ ...who,
    action: 'investor_types_backfilled',
    entityType: 'investor', entityId: null,
    description: `${s.toSet.length} unclassified client(s) given an investor type from ` +
      `${source}` + (overwrite ? `, and ${s.conflicts.length} overwritten` : '') +
      `. ${s.unmapped.length} unrecognised value(s) skipped; ` +
      `${s.unchanged.length} already correct.`,
    after: { filled: s.toSet.length, overwritten: overwrite ? s.conflicts.length : 0,
             by_type: s.byType, skipped_unrecognised: s.unmapped, source },
  }).catch(() => {});

  return { written, overwritten: overwrite ? s.conflicts.length : 0, warnings };
}

module.exports = { survey, execute, recordsOf };
