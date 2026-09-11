'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Referral codes

   A code identifies who gets credited when somebody signs up, and the
   lookup is `WHERE referral_code = $1 LIMIT 1`. So two investors sharing a
   code is not a cosmetic clash: LIMIT 1 picks one of them and the other
   silently loses every referral they make.

   Signup generated `'SVC' + 5 random base36` with no uniqueness check and
   no unique index behind it, so a collision was a matter of time rather
   than of chance being unkind.

   Ambiguous characters are left out. A code is read off a phone screen and
   typed into another one, and 0/O and 1/I/L are where that goes wrong.
   ═══════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  // no I, L, O, 0, 1
const LENGTH   = 6;

function newCode() {
  const bytes = crypto.randomBytes(LENGTH);
  let out = '';
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return 'SVC' + out;
}

/* Claims a code for this investor, retrying on collision. The unique index
   is what actually decides it — checking for a free code and then writing it
   is two statements with a gap in the middle, and the gap is the bug. */
async function assignCode(client, investorId, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    const code = newCode();
    try {
      const { rowCount } = await client.query(
        `UPDATE investors SET referral_code = $1, updated_at = NOW()
          WHERE id = $2 AND (referral_code IS NULL OR referral_code = '')`,
        [code, investorId]
      );
      if (rowCount) return code;
      /* Already had one — return it rather than overwriting a code the
         investor may already have shared. */
      const { rows } = await client.query(
        'SELECT referral_code FROM investors WHERE id = $1', [investorId]);
      return (rows[0] && rows[0].referral_code) || null;
    } catch (err) {
      if (err.code !== '23505') throw err;   // not a uniqueness violation
    }
  }
  throw new Error('Could not allocate a unique referral code.');
}

module.exports = { newCode, assignCode, ALPHABET, LENGTH };
