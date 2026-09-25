/* ═══════════════════════════════════════════════════════════
   What was actually uploaded.

   Documents on this platform are stored as base64 `data:` URLs in ordinary
   text columns — factsheets on products and on pools, FICA documents on
   kyc_documents. Whatever ends up in those columns is later handed to a
   browser to open, and a blob URL built from one inherits THIS origin. A
   stored `data:text/html;base64,…` opened from the portal runs its script as
   the platform, with the reader's session.

   Three things let one through before this existed:

     • the factsheet route validated the mime only when it could find one —
       `if (effectiveMime && …)` — so a body with no mime_type and a file_url
       that did not start with `data:` skipped the check completely;
     • where it did find one it trusted `mime_type` from the request body, so
       claiming application/pdf beside a text/html payload passed;
     • products.factsheet_url is written through the generic /api/tables
       route, which validated nothing at all. That is the copy the client
       portal pins as "Current".

   So the type is taken from the BYTES, never from what the caller says they
   are. A file claiming to be a PDF that does not begin %PDF- is refused,
   whichever field it arrived in.

   Only the shapes the platform actually stores are accepted: a base64 data:
   URL, or an http(s) link. Everything else — javascript:, file:, a data: URL
   that is not base64 — is refused outright rather than normalised, because
   there is no legitimate way for one to reach these columns.
   ═══════════════════════════════════════════════════════════ */
'use strict';

/* Magic numbers, in the order they are tried. Enough bytes to be unambiguous
   for the formats a client or an admin actually uploads. */
const starts = (buf, sig) =>
  buf.length >= sig.length && sig.every((b, i) => buf[i] === b);

/* A PDF header is meant to be at byte zero, and in the wild is sometimes
   preceded by a byte-order mark or stray whitespace. Scanned over the first
   kilobyte, which is what file(1) does, so a real PDF from a real scanner is
   not refused on a technicality. */
function hasPdfHeader(buf) {
  const sig = Buffer.from('%PDF-', 'latin1');
  return buf.slice(0, 1024).indexOf(sig) >= 0;
}

const SNIFFERS = [
  ['application/pdf', hasPdfHeader],
  ['image/png',  b => starts(b, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
  ['image/jpeg', b => starts(b, [0xFF, 0xD8, 0xFF])],
  ['image/gif',  b => starts(b, [0x47, 0x49, 0x46, 0x38])],
  ['image/webp', b => starts(b, [0x52, 0x49, 0x46, 0x46]) &&
                      b.slice(8, 12).toString('latin1') === 'WEBP'],
];

/* The type the bytes really are, or null when they are nothing we accept. */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  for (const [mime, test] of SNIFFERS) { if (test(buf)) return mime; }
  return null;
}

/* Splits a base64 data URL. Returns null for every other shape, including a
   data: URL that is not base64 — `data:text/html,<script>` has no encoding
   marker and used to slip past a check that only looked at the prefix. */
function parseDataUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = /^data:([^;,]*)((?:;[^;,]+)*);base64,([\s\S]*)$/i.exec(s);
  if (!m) return null;
  const declared = (m[1] || '').toLowerCase();
  let bytes;
  try { bytes = Buffer.from(m[3], 'base64'); } catch (_) { return null; }
  if (!bytes.length) return null;
  return { declared, bytes };
}

const PRETTY = {
  'application/pdf': 'PDF',
  'image/png': 'PNG image', 'image/jpeg': 'JPEG image',
  'image/gif': 'GIF image', 'image/webp': 'WebP image',
};
const listOf = allow => allow.map(m => PRETTY[m] || m).join(', ');

/**
 * Validate a value destined for a stored-document column.
 *
 * @param {string}   raw       the value as submitted
 * @param {object}   opts
 * @param {string[]} opts.allow      accepted media types, by their BYTES
 * @param {number}   opts.maxBytes   decoded size ceiling
 * @returns {{ok:true, kind:'remote'|'data', mime:string|null, size:number}
 *          |{ok:false, error:string}}
 */
function validateStoredFile(raw, { allow = ['application/pdf'], maxBytes = 8 * 1024 * 1024 } = {}) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, error: 'No file was supplied.' };

  /* A link to somewhere else. Not fetched — that would make this endpoint a
     way to have the server request arbitrary URLs — so it is accepted on its
     shape alone and the browser does its own content handling. */
  if (/^https?:\/\//i.test(s)) return { ok: true, kind: 'remote', mime: null, size: 0 };

  const parsed = parseDataUrl(s);
  if (!parsed) {
    return { ok: false, error: 'A file must be uploaded, or linked with an http(s) address.' };
  }
  if (parsed.bytes.length > maxBytes) {
    /* In the unit the number is readable in: "0.0 MB" tells an admin
       nothing about a file that is over a limit measured in kilobytes. */
    const size = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    return { ok: false, error: `That file is ${size(parsed.bytes.length)}. The limit is ${size(maxBytes)}.` };
  }

  const actual = sniff(parsed.bytes);
  if (!actual || !allow.includes(actual)) {
    /* Says what it IS, not only what was wanted: an admin who uploaded a Word
       document named .pdf needs to know that is what happened. */
    return { ok: false,
      error: `Only ${listOf(allow)} can be uploaded. That file is ${actual ? (PRETTY[actual] || actual) : 'not a recognised document'}.` };
  }
  /* The label has to agree with the content. A PDF declared as text/html is
     still refused — the declaration is what a browser would act on if the
     bytes were ever served with it. */
  if (parsed.declared && !allow.includes(parsed.declared)) {
    return { ok: false, error: `That file is labelled ${parsed.declared}, which is not accepted.` };
  }
  return { ok: true, kind: 'data', mime: actual, size: parsed.bytes.length };
}

module.exports = { validateStoredFile, parseDataUrl, sniff, hasPdfHeader };
