/* Reading what a browser actually drew.
 *
 * Every amount on this platform is formatted with toLocaleString('en-ZA'),
 * whose group separator is a NON-BREAKING space: "R 1 704,00" is R, U+00A0,
 * 1, U+00A0, 704 — which is right, because a printed certificate must not
 * break "R 1 704,00" across two lines.
 *
 * The headless Chromium the checks used to run against shipped a cut-down
 * ICU with no en-ZA, which fell back to "1,704.00". So a generation of
 * assertions was written against a comma, or against an ordinary space, and
 * passed. The container then upgraded from chromium-1194 to chromium-1243,
 * which has full ICU — and every one of those assertions stopped matching.
 *
 * Nobody saw it, because the same upgrade moved the binary and those checks
 * had been silently skipping their browser half ever since. When the runner
 * started reading each check's own tally instead of its exit code, seven of
 * them came back red at once, all for this.
 *
 * So: one place that takes rendered text and gives back something an
 * assertion can be written against — in either separator, and whether it
 * arrived as a character or as the &nbsp; that innerHTML serialises it to.
 */
'use strict';

const NBSP = String.fromCharCode(0xa0);

/* U+00A0 and the entity both become an ordinary space. Nothing else is
   touched, so a check that asserts on exact spacing still can. */
function nbsp(text) {
  return String(text == null ? '' : text)
    .split('&nbsp;').join(' ')
    .split(NBSP).join(' ');
}

/* The same, applied to every string in whatever a probe handed back, so a
   check normalises once at the boundary rather than at thirty comparisons.
   Shape is preserved; only strings change. */
function nbspDeep(value) {
  if (typeof value === 'string') return nbsp(value);
  if (Array.isArray(value)) return value.map(nbspDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = nbspDeep(v);
    return out;
  }
  return value;
}

/* And the stronger one, for a block of rendered prose: runs of whitespace
   collapse too, so an assertion never has to know how the markup was
   indented. */
function plain(text) {
  return nbsp(text).replace(/\s+/g, ' ').trim();
}


/* What a page probe hands back.
 *
 * Six checks each carried their own copy of this:
 *
 *   JSON.parse(raw.replace(/&quot;/g,'"').replace(/&amp;/g,'&')
 *     .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'"))
 *
 * Two things wrong with it, both invisible until the browser halves started
 * running again. &amp; is decoded SECOND, so a probe value containing the
 * literal text "&lt;" comes back as "<" — decoded twice. And nothing decodes
 * &nbsp;, which is what innerHTML makes of every non-breaking space en-ZA
 * puts between thousands, so "R 240 000,00" arrives as "R240&nbsp;000,00"
 * and matches no assertion written about money.
 *
 * Decoded in the right order, normalised once, parsed. Returns null rather
 * than throwing: the caller already asserts that the page reported. */
function readProbe(raw) {
  const decoded = String(raw == null ? '' : raw)
    .split('&quot;').join('"')
    .split('&lt;').join('<')
    .split('&gt;').join('>')
    .split('&#39;').join("'")
    .split('&nbsp;').join(' ')
    /* Last, so an escaped entity in the DATA is not decoded a second time. */
    .split('&amp;').join('&');
  try { return nbspDeep(JSON.parse(decoded)); } catch (_) { return null; }
}


/* A rendered amount, back as a number.
 *
 * "R 3 576,30" and "R3,576.30" are the same money written by two ICUs: the
 * full one groups with a non-breaking space and marks decimals with a comma,
 * the cut-down one in the old headless build used a comma and a dot. A check
 * that stripped everything but digits and dots read the first as 357 630 —
 * a hundred times the figure, and it had been reading it that way for as
 * long as the browser halves had not run.
 *
 * So: decide which separator is the decimal one by where it sits, rather
 * than assuming. The last comma or dot with one or two digits after it is
 * the decimal point; everything else is grouping. Returns NaN for a string
 * with no digits, so a caller can tell "nothing there" from zero. */
function randToNumber(text) {
  const t = nbsp(text).replace(/[^\d.,-]/g, '');
  if (!/\d/.test(t)) return NaN;
  const dec = t.match(/[.,](\d{1,2})$/);
  const whole = (dec ? t.slice(0, -dec[0].length) : t).replace(/[.,\s]/g, '');
  const sign = /^-/.test(t) ? -1 : 1;
  return sign * (Math.abs(Number(whole) || 0) + (dec ? Number(dec[1].padEnd(2, '0')) / 100 : 0));
}

module.exports = { nbsp, nbspDeep, plain, readProbe, randToNumber, NBSP };
