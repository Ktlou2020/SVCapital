/* ═══════════════════════════════════════════════════════════
   Insight article bodies — the one place article markup is turned
   into HTML.

   Authors could not format an article at all: the body was stored as plain
   text and rendered with `String(body).split(/\n{2,}/).map(t => '<p>' + esc(t)
   + '</p>')`, so a bold word, a bullet list or a centred line was impossible.
   The escaping was not the problem and has not been relaxed — these pages are
   server-rendered and public, so a script that reached this string would run
   for every visitor, and for the crawler that builds the share card.

   WHAT THIS DOES INSTEAD OF STRIPPING. Everything is escaped first, and then
   the handful of patterns that are allowed are restored. That inversion is
   the whole safety argument: a stripper has to think of every dangerous
   thing, and whatever it fails to think of goes through. Here, anything this
   file does not explicitly recognise is already inert text by the time it is
   considered, so the failure mode of a gap in the allowlist is a tag shown as
   words — visible, harmless, and reported rather than executed.

   WHAT IS ALLOWED. Block: p, h2, h3, ul, ol, li, blockquote. Inline: strong,
   em, u, a, br. Alignment is a CLASS from a fixed set, never a style
   attribute: "ta-center" cannot carry a url, an expression or a second
   declaration, and `style` can. No id, no data-*, no event handlers, no
   class other than the three.

   LINKS are rebuilt rather than passed through, and only http, https, mailto
   and site-relative paths survive. The scheme is tested after the whitespace
   and control characters a browser ignores are removed, because "java\tscript:"
   is a scheme a naive test reads as relative.

   ONE DEFINITION. The admin console normalises what its editor produces so an
   author sees roughly what will be stored, but that is a convenience and this
   is the gate: the console is a client, and a client cannot be trusted with
   what a public page renders. check-insights-formatting asserts that every
   construct the console's toolbar can produce survives this file, so the two
   cannot drift into disagreeing about what an article may contain.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const ALIGN_CLASSES = ['ta-left', 'ta-center', 'ta-right'];

/* Tags with no attributes at all. */
const PLAIN_TAGS = ['p', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'strong', 'em', 'u'];

/* Tags that may carry one alignment class. Inline tags are absent on
   purpose: aligning half a sentence means nothing, and allowing the
   attribute there widens the surface for no gain. */
const ALIGNABLE = ['p', 'h2', 'h3', 'li', 'blockquote'];

/* b and i are what contenteditable produces in several browsers however the
   editor is configured. Normalised rather than allowed, so the stored markup
   has one spelling of bold and the stylesheet has one selector. */
const NORMALISE = { b: 'strong', i: 'em' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Undo the escaping of a captured attribute value so it can be inspected as
   the author wrote it. Only ever applied to a value that is re-escaped
   before it goes back into the output. */
function unesc(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/* Is this a url a reader can safely be sent to?
 *
 * The allowlist is what makes it safe: three schemes plus site-relative, so
 * admitting a fourth has to be deliberate. "java\tscript:alert(1)" is
 * refused by that list alone — it matches none of the three.
 *
 * The control characters are removed for a different reason than it first
 * appears, and the distinction is worth keeping straight. It is NOT a guard
 * against a scheme smuggled past the regex: that trick works only where the
 * raw string is tested and the raw string is emitted, and here the cleaned
 * string is both tested and emitted, so what the browser parses is exactly
 * what was checked. It is NORMALISATION — a url copied out of a PDF or a
 * Word document frequently arrives with a line break in the middle of it,
 * and an author pasting one should get a working link rather than a silent
 * refusal they cannot see the cause of. */
function safeUrl(raw) {
  const u = String(raw || '').replace(/[\u0000- \u007f- ]/g, '').trim();
  if (!u) return null;
  if (/^https?:\/\/[^/]/i.test(u)) return u;
  if (/^mailto:[^@\s]+@[^@\s]+$/i.test(u)) return u;
  /* Site-relative only. "//evil.test" is protocol-relative and leaves the
     site, which is why the second character is checked. */
  if (/^\/(?!\/)/.test(u)) return u;
  return null;
}

/* Does this body use markup at all, or is it one of the plain-text articles
   written before there was any way to format one? Those must keep rendering
   exactly as they did — blank lines into paragraphs — or every article
   published so far collapses into a single block on the next deploy. */
function looksLikeMarkup(body) {
  return /<\s*\/?\s*(p|h2|h3|ul|ol|li|blockquote|strong|em|u|b|i|a|br)\b/i.test(String(body || ''));
}

/* The legacy path, unchanged in behaviour. */
function renderPlainText(body) {
  return String(body == null ? '' : body)
    .split(/\n{2,}/)
    .map(t => t.trim())
    .filter(Boolean)
    .map(t => `<p>${esc(t)}</p>`)
    .join('');
}

function renderMarkup(body) {
  /* Step one: the whole thing becomes text. Nothing below can introduce a
     tag that was not explicitly matched, because there are no live angle
     brackets left to find. */
  let s = esc(body);

  /* Normalise the two tags browsers substitute, before anything else reads
     them, so the rules below only need one spelling. */
  for (const [from, to] of Object.entries(NORMALISE)) {
    s = s.replace(new RegExp(`&lt;${from}&gt;`, 'gi'), `&lt;${to}&gt;`)
         .replace(new RegExp(`&lt;/${from}&gt;`, 'gi'), `&lt;/${to}&gt;`);
  }

  /* Blocks carrying one alignment class. Done before the bare-tag rule so
     `<p class="ta-center">` is not left behind by it. */
  const alignAlt = ALIGN_CLASSES.join('|');
  for (const tag of ALIGNABLE) {
    s = s.replace(
      new RegExp(`&lt;${tag} class=&quot;(${alignAlt})&quot;&gt;`, 'gi'),
      (_m, cls) => `<${tag} class="${cls.toLowerCase()}">`);
  }

  /* Bare open and close tags. */
  for (const tag of PLAIN_TAGS) {
    s = s.replace(new RegExp(`&lt;${tag}&gt;`, 'gi'), `<${tag}>`)
         .replace(new RegExp(`&lt;/${tag}&gt;`, 'gi'), `</${tag}>`);
  }

  /* br, in the three spellings an editor emits. */
  s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>');

  /* Links, rebuilt from the href alone, and matched AS A PAIR with their
     closing tag.
     
     Rewriting the open tag on its own and restoring every `</a>` separately
     left a rejected link as `click</a>` — the words survived, as intended,
     followed by a close tag for an element that was never opened. Harmless,
     but malformed, and it is the kind of thing that renders differently in
     two browsers. Matching the pair means a refused link loses both halves
     and keeps its sentence.
     
     The href capture stops at the escaped quote rather than at any
     ampersand, so a query string survives. Anchors cannot nest, so the
     non-greedy inner capture cannot swallow a second link. */
  s = s.replace(
    /&lt;a href=&quot;((?:(?!&quot;).)*)&quot;&gt;([\s\S]*?)&lt;\/a&gt;/gi,
    (_m, href, inner) => {
      const u = safeUrl(unesc(href));
      if (!u) return inner;
      return `<a href="${esc(u)}" rel="noopener nofollow" target="_blank">${inner}</a>`;
    });
  /* An anchor tag that did not form a pair stays escaped. Visible to the
     author as text, which is what a broken link should look like. */

  return s;
}

/* The only entry point. */
function renderArticleBody(body) {
  const raw = String(body == null ? '' : body);
  if (!raw.trim()) return '';
  return looksLikeMarkup(raw) ? renderMarkup(raw) : renderPlainText(raw);
}

module.exports = {
  renderArticleBody,
  looksLikeMarkup,
  safeUrl,
  ALIGN_CLASSES,
  PLAIN_TAGS,
  ALIGNABLE,
};
