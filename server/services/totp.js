'use strict';
const crypto = require('crypto');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function b32Decode(str) {
  str = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of str) {
    const idx = B32.indexOf(ch); if (idx < 0) continue;
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[19] & 0xf;
  return String(((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

function generateSecret() { return b32Encode(crypto.randomBytes(20)); }

function verify(secret, token) {
  // TODO(security): Add replay protection — persist last_used_counter per secret in DB.
  // Reject any code whose counter <= last_used_counter. Requires adding a totp_last_counter
  // column to the investors/employees table. Until then, codes are valid for the full ~90s window.
  const key = b32Decode(secret);
  const t = Math.floor(Date.now() / 30000);
  for (const w of [-1, 0, 1]) {
    const expected = Buffer.from(String(hotp(key, t+w)).padStart(6, '0'));
    const actual = Buffer.from(String(token).trim().padStart(6, '0'));
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) { return true; }
  }
  return false;
}

function otpauthUri(secret, email, issuer = 'SV Capital') {
  return `otpauth://totp/${encodeURIComponent(issuer + ':' + email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

module.exports = { generateSecret, verify, otpauthUri };
