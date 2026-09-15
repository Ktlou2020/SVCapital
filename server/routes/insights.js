/* ═══════════════════════════════════════════════════════════
   Insights — public articles, SERVER-RENDERED.

   Rendered on the server rather than fetched by the page, because the point of
   this section is that an article can be shared. WhatsApp, Facebook and
   LinkedIn all build their preview card by fetching the URL and reading the
   Open Graph tags out of the HTML they get back — and none of them run
   JavaScript. A client-rendered article would share as a bare link with the
   site's generic title, whatever the page looked like in a browser.

   So each article is a real HTML document with its own og:title,
   og:description and og:url. That is the whole reason these are routes and not
   another static file.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');

const SITE = (process.env.PUBLIC_SITE_URL || 'https://platform.svcapital.co.za').replace(/\/+$/, '');

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* Meta content is an ATTRIBUTE, so it cannot carry a newline or a stray quote
   without breaking the tag it sits in — and a broken og:description is a share
   card with no text on it. */
const attr = (s, max) => {
  const flat = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const cut  = flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
  return esc(cut);
};

const fmtDate = d => d
  ? new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' })
  : '';

/* Shared chrome. Kept in one place so an article and the index cannot drift
   into looking like two different sites. */
function page({ title, description, url, bodyHtml, articleMeta }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${attr(description, 300)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="${articleMeta ? 'article' : 'website'}">
<meta property="og:site_name" content="SV Capital">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${attr(title, 120)}">
<meta property="og:description" content="${attr(description, 300)}">
<meta property="og:image" content="${SITE}/assets/svcapital-og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${attr(title, 120)}">
<meta name="twitter:description" content="${attr(description, 200)}">
<meta name="twitter:image" content="${SITE}/assets/svcapital-og.png">
${articleMeta || ''}
<link rel="icon" href="/assets/favicon-32.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;700;800&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<style>
  :root{
    --ink:#15121b; --soft:#4e4759; --faint:#877e93;
    --ground:#faf8fb; --panel:#fff; --rule:#e6e0ec; --brand:#8b3fb0; --mark:#eda5ff;
  }
  @media (prefers-color-scheme:dark){:root{
    --ink:#f1ebf5; --soft:#b5abc2; --faint:#877e93;
    --ground:#121019; --panel:#1b1724; --rule:#302940; --brand:#eda5ff;
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--ink);
       font-family:Manrope,system-ui,sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased}
  a{color:var(--brand)}
  .wrap{max-width:860px;margin:0 auto;padding:0 20px 80px}
  /* The same horizontal lockup the landing page uses, which is a white-text
     asset — so the header keeps its own dark band in both themes rather than
     the logo vanishing on a light ground. It also reads as the same site. */
  .masthead{background:#15121b}
  header.top{display:flex;align-items:center;gap:14px;padding:16px 20px;flex-wrap:wrap;
             max-width:860px;margin:0 auto}
  header.top img{height:40px;width:auto;display:block}
  header.top nav{margin-left:auto;display:flex;gap:18px;font-size:.88rem;font-weight:700}
  header.top nav a{text-decoration:none;color:#eda5ff}
  @media (max-width:520px){header.top img{height:32px}header.top nav{gap:13px;font-size:.82rem}}
  h1{font-family:'Source Serif 4',Georgia,serif;font-size:clamp(1.9rem,5vw,2.7rem);line-height:1.15;margin:26px 0 10px;text-wrap:balance}
  .lede{font-size:1.1rem;color:var(--soft);margin:0 0 18px;max-width:62ch}
  .tag{display:inline-block;font-size:.7rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase;
       padding:5px 10px;border-radius:999px;background:var(--mark);color:#15121b}
  .meta{font-size:.82rem;color:var(--faint);margin-bottom:26px}
  article p{font-family:'Source Serif 4',Georgia,serif;font-size:1.12rem;color:var(--ink);margin:0 0 20px;max-width:66ch}
  .grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));margin-top:26px}
  .card{background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:9px;text-decoration:none;color:inherit}
  /* align-self, not display:inline-block — a flex column stretches its children
     to the full width whatever their display is, which turned every industry
     tag into a full-width bar. */
  .card .tag,article + .share .tag{align-self:flex-start}
  .tag{align-self:flex-start}
  .card:hover{border-color:var(--brand)}
  .card h2{font-family:'Source Serif 4',Georgia,serif;font-size:1.16rem;margin:0;line-height:1.3;text-wrap:balance}
  .card p{margin:0;font-size:.92rem;color:var(--soft)}
  .card .meta{margin:0;font-size:.76rem}
  .share{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:32px 0 0;padding-top:22px;border-top:1px solid var(--rule)}
  .share span{font-size:.84rem;color:var(--faint)}
  .wa{display:inline-flex;align-items:center;gap:8px;background:#25D366;color:#08240f;text-decoration:none;
      font-weight:800;font-size:.9rem;padding:10px 16px;border-radius:999px}
  .wa svg{width:17px;height:17px;fill:currentColor}
  .copy{font:inherit;font-weight:700;font-size:.9rem;cursor:pointer;background:transparent;
        border:1px solid var(--rule);color:var(--soft);padding:10px 16px;border-radius:999px}
  .copy:focus-visible,.wa:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
  .back{display:inline-block;margin:26px 0 0;font-size:.9rem;font-weight:700;text-decoration:none}
  footer.legal{margin-top:54px;padding-top:20px;border-top:1px solid var(--rule);font-size:.78rem;color:var(--faint)}
  .empty{background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:30px;text-align:center;color:var(--soft)}
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<div class="masthead"><header class="top">
    <a href="/"><img src="/assets/sv-capital-logo-horizontal-white-text.png" alt="SV Capital"></a>
    <nav>
      <a href="/insights">Insights</a>
      <a href="/#products">Products</a>
      <a href="/signup">Get started</a>
    </nav>
  </header></div>
<div class="wrap">
  ${bodyHtml}
  <footer class="legal">
    Nothing on this page is financial advice. Every SV Capital investment carries risk, returns are not
    guaranteed and you can get back less than you invest.<br>
    SV Capital (Pty) Ltd is operated by Smartvest Financial Services (Pty) Ltd, FSP 52449, an authorised
    financial services provider.
  </footer>
</div>
</body>
</html>`;
}

const WA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 14.4c-.3-.2-1.7-.9-2-1-.3-.1-.5-.2-.7.1-.2.3-.7 1-.9 1.2-.2.2-.3.2-.6.1-.3-.2-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.5-.5c.1-.2.2-.3.3-.5 0-.2 0-.4 0-.5 0-.2-.7-1.6-.9-2.2-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.2.2 2.1 3.2 5.1 4.4.7.3 1.3.5 1.7.6.7.2 1.4.2 1.9.1.6-.1 1.7-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.1-.3-.2-.6-.3zM12 2C6.5 2 2 6.5 2 12c0 1.8.5 3.4 1.3 4.9L2 22l5.3-1.4c1.4.8 3 1.2 4.7 1.2 5.5 0 10-4.5 10-10S17.5 2 12 2z"/></svg>';

/* ── GET /insights ─────────────────────────────────────── */
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT slug, title, industry, excerpt, read_minutes, hero_colour, published_at
         FROM insights
        WHERE published = true
        ORDER BY published_at DESC NULLS LAST, created_at DESC
        LIMIT 60`);

    const cards = rows.map(a => `
      <a class="card" href="/insights/${encodeURIComponent(a.slug)}">
        <span class="tag" style="background:${esc(a.hero_colour || '#eda5ff')}">${esc(a.industry)}</span>
        <h2>${esc(a.title)}</h2>
        <p>${esc(a.excerpt)}</p>
        <p class="meta">${fmtDate(a.published_at)} &middot; ${Number(a.read_minutes) || 4} min read</p>
      </a>`).join('');

    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(page({
      title: 'Insights — SV Capital',
      description: 'How the industries behind SV Capital investments actually work — agriculture, energy, logistics and more, explained plainly.',
      url: `${SITE}/insights`,
      bodyHtml: `
        <h1>Insights</h1>
        <p class="lede">How the industries behind these investments actually work. Written plainly, including
           the parts that are uncomfortable.</p>
        ${rows.length ? `<div class="grid">${cards}</div>`
                      : `<div class="empty">No articles published yet. Check back shortly.</div>`}`,
    }));
  } catch (err) {
    console.error('[insights] list error:', err.message);
    res.status(500).type('html').send(page({
      title: 'Insights — SV Capital',
      description: 'SV Capital insights.',
      url: `${SITE}/insights`,
      bodyHtml: '<h1>Insights</h1><div class="empty">We could not load the articles just now. Please try again shortly.</div>',
    }));
  }
});

/* ── GET /insights/:slug ───────────────────────────────── */
router.get('/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT slug, title, industry, excerpt, body, author, read_minutes, hero_colour, published_at
         FROM insights WHERE slug = $1 AND published = true LIMIT 1`, [String(req.params.slug)]);

    if (!rows[0]) {
      return res.status(404).type('html').send(page({
        title: 'Article not found — SV Capital',
        description: 'That article is not available.',
        url: `${SITE}/insights`,
        bodyHtml: '<h1>Not found</h1><div class="empty">That article has moved or is no longer published.</div><a class="back" href="/insights">&larr; All insights</a>',
      }));
    }

    const a   = rows[0];
    const url = `${SITE}/insights/${encodeURIComponent(a.slug)}`;
    const paras = String(a.body).split(/\n{2,}/).map(t => `<p>${esc(t.trim())}</p>`).join('');

    /* The share text is built here, URL-encoded once, so what WhatsApp opens is
       the headline and the link rather than a naked URL. */
    const waText = encodeURIComponent(`${a.title}\n\n${url}`);

    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(page({
      title: `${a.title} — SV Capital`,
      description: a.excerpt,
      url,
      articleMeta:
        `<meta property="article:section" content="${attr(a.industry, 60)}">` +
        (a.published_at ? `\n<meta property="article:published_time" content="${new Date(a.published_at).toISOString()}">` : ''),
      bodyHtml: `
        <span class="tag" style="background:${esc(a.hero_colour || '#eda5ff')}">${esc(a.industry)}</span>
        <h1>${esc(a.title)}</h1>
        <p class="lede">${esc(a.excerpt)}</p>
        <p class="meta">${esc(a.author || 'SV Capital')} &middot; ${fmtDate(a.published_at)} &middot; ${Number(a.read_minutes) || 4} min read</p>
        <article>${paras}</article>
        <div class="share">
          <span>Share this</span>
          <a class="wa" href="https://wa.me/?text=${waText}" target="_blank" rel="noopener">${WA_ICON} WhatsApp</a>
          <button class="copy" type="button" data-url="${esc(url)}">Copy link</button>
        </div>
        <a class="back" href="/insights">&larr; All insights</a>
        <script>
          document.querySelector('.copy').addEventListener('click', function () {
            var b = this;
            var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy link'; }, 1600); };
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(b.dataset.url).then(done, function () { b.textContent = b.dataset.url; });
              } else { b.textContent = b.dataset.url; }
            } catch (e) { b.textContent = b.dataset.url; }
          });
        </script>`,
    }));
  } catch (err) {
    console.error('[insights] article error:', err.message);
    res.status(500).type('html').send(page({
      title: 'Insights — SV Capital', description: 'SV Capital insights.', url: `${SITE}/insights`,
      bodyHtml: '<h1>Insights</h1><div class="empty">We could not load that article just now.</div>',
    }));
  }
});

module.exports = router;
