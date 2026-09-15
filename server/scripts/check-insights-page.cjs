#!/usr/bin/env node
/* Insight articles render on the server, with their own share card.
 *
 * The point of this section is that an article can be sent to somebody.
 * WhatsApp, Facebook and LinkedIn all build their preview by fetching the URL
 * and reading the Open Graph tags out of the HTML they get back, and none of
 * them run JavaScript. So an article page has to BE a document with its own
 * og:title and og:description — a client-rendered list would share as a bare
 * link carrying the site's generic title, no matter how good it looked in a
 * browser.
 *
 * That is why these are routes and not another static file, why the router is
 * mounted ahead of express.static, and why almost everything below fetches a
 * page and reads what came back rather than reading the source.
 *
 * The other half is escaping. These articles are written by staff in the admin
 * console and interpolated into an HTML string, so a title is untrusted input
 * on a public page; one of the fixtures is hostile.
 *
 * Needs a database. It creates and drops its own.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-insights-page.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const db   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const meta = (html, prop) => {
  const m = html.match(new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`));
  return m ? m[1] : null;
};

(async () => {
  let srv;
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

    const express = require('express');
    const app = express();
    app.use('/insights', require(path.join(ROOT, 'server', 'routes', 'insights.js')));
    srv = await new Promise(r => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const get = async u => { const r = await fetch(base + u); return { status: r.status, html: await r.text() }; };

    /* A hostile title and a draft, alongside whatever the seed produced. */
    await db.query(`DELETE FROM insights WHERE id LIKE 'INS-CHK-%'`);
    await db.query(
      `INSERT INTO insights (id, slug, title, industry, excerpt, body, author, read_minutes, published, published_at)
       VALUES ('INS-CHK-XSS','chk-xss',$1,'Energy',$2,'Body one.' || chr(10) || chr(10) || 'Body two.','SV Capital',3,true,NOW()),
              ('INS-CHK-DRAFT','chk-draft','A draft','Energy','Not for the public','Draft body.','SV Capital',3,false,NULL)`,
      ['<script>alert(1)</script> & "quotes"', 'Excerpt with <b>markup</b> & an ampersand']);

    console.log('\nthe listing is a real page');
    {
      const { status, html } = await get('/insights');
      ok('it answers 200', status === 200, String(status));
      ok('with an og:url of its own', meta(html, 'og:url') === 'https://platform.svcapital.co.za/insights',
         String(meta(html, 'og:url')));
      ok('the seeded articles are listed',
         html.includes('rent-is-not-interest') && html.includes('a-ppa-is-a-contract-not-a-guarantee'),
         'the page shipped empty');
      ok('each card names its industry',
         html.includes('>Logistics<') && html.includes('>Energy<') && html.includes('>Agriculture<'));
      ok('a draft is not listed', !html.includes('chk-draft'),
         'published = false must mean nobody outside the console sees it');
    }

    console.log('\nan article carries its own share card');
    {
      const { status, html } = await get('/insights/rent-is-not-interest');
      ok('it answers 200', status === 200, String(status));
      ok('og:type is article, not website', meta(html, 'og:type') === 'article', String(meta(html, 'og:type')));
      ok('og:title is the article, not the site',
         /Rent is not interest/.test(meta(html, 'og:title') || ''), String(meta(html, 'og:title')));
      ok('og:description is the excerpt',
         /A delivery fleet pays you rent/.test(meta(html, 'og:description') || ''),
         String(meta(html, 'og:description')));
      ok('og:url points at this article',
         meta(html, 'og:url') === 'https://platform.svcapital.co.za/insights/rent-is-not-interest',
         String(meta(html, 'og:url')));
      ok('an image is offered, or the card renders bare',
         (meta(html, 'og:image') || '').endsWith('.png'), String(meta(html, 'og:image')));
      ok('and the canonical matches', /rel="canonical" href="[^"]*rent-is-not-interest"/.test(html));
      ok('the body is in the HTML, not fetched later',
         html.includes('Bikes not being ridden are bikes not paying'),
         'a crawler reads the response — it does not run the page');
    }

    console.log('\nthe WhatsApp link carries the headline and the URL');
    {
      const { html } = await get('/insights/rent-is-not-interest');
      const m = html.match(/https:\/\/wa\.me\/\?text=([^"]+)/);
      ok('a wa.me link is present', !!m);
      const text = m ? decodeURIComponent(m[1]) : '';
      ok('it includes the title', /Rent is not interest/.test(text), text.slice(0, 80));
      ok('and the full article URL',
         text.includes('https://platform.svcapital.co.za/insights/rent-is-not-interest'), text.slice(-80));
      ok('encoded once, not twice', !/%25/.test(m ? m[1] : ''),
         'double-encoding sends %2520 and WhatsApp shows the escape codes');
    }

    console.log('\nstaff-written text cannot break the page');
    {
      const { html } = await get('/insights/chk-xss');
      ok('a script tag in the title is escaped',
         !/<script>alert\(1\)<\/script>/.test(html),
         'the title is written in the admin console and rendered on a public page');
      ok('it is still displayed, as text', html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
      /* Written backwards first: the original asserted the ABSENCE of &quot;,
         which is precisely what correct escaping produces, so it failed on
         working code. What matters is that the quote survives as an entity and
         the attribute still closes where it should. */
      const ogTitle = meta(html, 'og:title') || '';
      ok('a quote in the title becomes an entity', ogTitle.includes('&quot;'), ogTitle);
      ok('so the content attribute is not cut short',
         ogTitle.includes('quotes') && !/content="[^"]*"[^">]/.test(html),
         'an unescaped quote closes the attribute early and the card loses its text');
      ok('markup in the excerpt is escaped too',
         html.includes('&lt;b&gt;markup&lt;/b&gt;') && !html.includes('<b>markup</b>'));
      ok('and the ampersand is an entity', html.includes('&amp;'));
    }

    console.log('\nand the pages that should not exist do not');
    {
      ok('an unknown slug is a 404', (await get('/insights/no-such-article')).status === 404);
      ok('a draft is a 404 too', (await get('/insights/chk-draft')).status === 404,
         'unpublished must not be reachable by guessing the slug');
    }

    console.log('\nthe router is reachable at all');
    {
      const idx = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
      const mountAt  = idx.indexOf("app.use('/insights'");
      const staticAt = idx.indexOf('app.use(express.static(STATIC_DIR');
      ok('it is mounted', mountAt > 0);
      ok('BEFORE express.static', mountAt > 0 && staticAt > mountAt,
         'the static handler would answer /insights with index.html and the router would never run');
      const redirectAt = idx.indexOf('Redirect legacy .html URLs');
      ok('and before the .html redirect', mountAt < redirectAt || redirectAt < 0);
    }

    console.log('\na header image becomes the share picture');
    {
      /* A genuine 8x4 PNG rather than a string that looks like one, because the
         hero route decodes the base64 and serves the bytes. */
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAB9c2IwAAAAHElEQVQI12P8//8/AzbAxIAH' +
        'jEqOSo5KjkqOSgYAcMwD/1sJZ4kAAAAASUVORK5CYII=', 'base64');
      const uri = 'data:image/png;base64,' + png.toString('base64');
      await db.query(`UPDATE insights SET hero_image = $1, hero_alt = $2 WHERE slug = 'chk-xss'`,
                     [uri, 'A test image & "quoted" alt']);

      const { html } = await get('/insights/chk-xss');
      ok('og:image points at the article, not the site default',
         meta(html, 'og:image') === 'https://platform.svcapital.co.za/insights/chk-xss/hero',
         String(meta(html, 'og:image')));
      ok('twitter:image follows it', meta(html, 'twitter:image') === meta(html, 'og:image'));
      ok('the fixed 1200x630 dimensions are dropped',
         !/og:image:width/.test(html),
         'a staff-supplied photo is rarely exactly 1200x630 and claiming it is misdraws the card');

      /* The one that only breaks away from production. */
      const img = (html.match(/<img class="hero" src="([^"]*)"/) || [])[1];
      ok('the on-page <img> is host-relative', img === '/insights/chk-xss/hero',
         `got ${img} — an absolute production URL loads production's image on staging`);
      ok('and its alt text is escaped',
         /<img class="hero"[^>]*alt="A test image &amp; &quot;quoted&quot; alt"/.test(html),
         'alt is an attribute, so an unescaped quote closes it early');

      const r = await fetch(base + '/insights/chk-xss/hero');
      const bytes = Buffer.from(await r.arrayBuffer());
      ok('the hero route serves the image', r.status === 200, String(r.status));
      ok('with the stored content type', r.headers.get('content-type') === 'image/png',
         String(r.headers.get('content-type')));
      ok('and the exact bytes back', bytes.equals(png), `${bytes.length} vs ${png.length}`);
      ok('cached, since it never changes under its URL',
         /max-age=\d{4,}/.test(r.headers.get('cache-control') || ''),
         String(r.headers.get('cache-control')));

      const none = await fetch(base + '/insights/rent-is-not-interest/hero');
      ok('an article with no image 404s rather than serving nothing', none.status === 404, String(none.status));
      const nh = (await get('/insights/rent-is-not-interest')).html;
      ok('and falls back to the site card',
         meta(nh, 'og:image') === 'https://platform.svcapital.co.za/assets/svcapital-og.png',
         String(meta(nh, 'og:image')));

      /* A draft's image must not leak either. */
      await db.query(`UPDATE insights SET hero_image = $1 WHERE slug = 'chk-draft'`, [uri]);
      ok("a draft's image is not served", (await fetch(base + '/insights/chk-draft/hero')).status === 404,
         'published = false has to mean the whole article, picture included');

      const list = (await get('/insights')).html;
      ok('the listing card shows a thumbnail', /<img class="card-hero" src="\/insights\/chk-xss\/hero"/.test(list));

      /* Staff can also paste a URL instead of uploading. Nothing covered that
         until a mutation removed the redirect and went unnoticed. */
      const EXT = 'https://images.example.com/solar.jpg';
      await db.query(`UPDATE insights SET hero_image = $1 WHERE slug = 'chk-xss'`, [EXT]);
      const extHtml = (await get('/insights/chk-xss')).html;
      ok('an external URL is used directly as og:image', meta(extHtml, 'og:image') === EXT,
         String(meta(extHtml, 'og:image')));
      ok('and directly in the <img>, not proxied',
         new RegExp(`<img class="hero" src="${EXT.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}"`).test(extHtml),
         'sending it through our own route would make us the host of somebody else\'s image');
      const red = await fetch(base + '/insights/chk-xss/hero', { redirect: 'manual' });
      ok('the hero route redirects to it rather than 404ing',
         red.status === 302 && red.headers.get('location') === EXT,
         `${red.status} ${red.headers.get('location')}`);
      await db.query(`UPDATE insights SET hero_image = $1 WHERE slug = 'chk-xss'`, [uri]);
    }

    console.log('\nand the console can attach one');
    {
      const idx = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
      const js  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      ok('there is a file picker', /id="insHeroFile"[\s\S]{0,160}accept="image\//.test(idx));
      ok('and a place for alt text', /id="insHeroAlt"/.test(idx));
      ok('with a preview', /id="insHeroPreview"/.test(idx));
      ok('and a way to remove it', /_insClearHero\(\)/.test(js));
      ok('the size is refused in the browser', /_INS_HERO_MAX = 2 \* 1024 \* 1024/.test(js),
         'finding out at save time means finding out after writing the article');
      ok('only real image types are accepted', /\^image\\\/\(png\|jpe\?g\|webp\)\$/.test(js));
      ok('it is saved on the row', /hero_image: v\('insHero'\) \|\| null/.test(js));
      ok('and cleared as null, not an empty string', /hero_alt:\s+v\('insHeroAlt'\) \|\| null/.test(js),
         "'' is a value the hero parser would keep trying to read");
      const idxSrv = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
      ok('the body limit allows for an encoded photo',
         /app\.use\('\/api\/tables\/insights', express\.json\(\{ limit: '8mb' \}\)\)/.test(idxSrv),
         'base64 inflates a 2MB photo past the 2mb global limit');
    }

    console.log('\nthe landing page points at it');
    {
      const land = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      ok('there is a nav link', /<a href="\/insights" class="nav-link">Insights<\/a>/.test(land));
      ok('and a footer link', /<li><a href="\/insights">Insights<\/a><\/li>/.test(land));
    }

    console.log('\nit wears the same logo as the landing page');
    {
      const land = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      const landLogo = (land.match(/src="(assets\/sv-capital-logo-[^"]+)"/) || [])[1];
      ok('the landing page logo is findable', !!landLogo, String(landLogo));
      const { html } = await get('/insights');
      ok('insights uses the same asset', !!landLogo && html.includes(`/${landLogo}`),
         `landing: ${landLogo}`);
      ok('and not the bare monogram', !html.includes('logo-inline.svg'),
         'the monogram alone is not the lockup the rest of the site uses');
      /* That asset has white text, so it needs a dark ground in BOTH themes —
         on a light page it would simply disappear. */
      ok('on a dark band that does not depend on the theme',
         /\.masthead\{background:#15121b\}/.test(html),
         'a white-text logo on a light ground is an invisible logo');
      ok('and the band is full width, outside the content wrapper',
         html.indexOf('<div class="masthead">') < html.indexOf('<div class="wrap">'),
         'inside the wrapper it renders as a floating bar rather than a header');
    }

    console.log('\nInterest-Free sits under Products');
    {
      const land = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      ok('Products has a submenu', /<li class="nav-has-sub">/.test(land));
      ok('with Interest-Free inside it',
         /<ul class="nav-sub">[\s\S]{0,400}Interest-Free[\s\S]{0,80}<\/ul>/.test(land));
      ok('and All products alongside it',
         /<ul class="nav-sub">[\s\S]{0,200}All products/.test(land));
      ok('it is no longer a top-level item',
         !/<li><a href="#eif" class="nav-link" id="navEifLink"/.test(land));
      /* js/main.js hides this when no EIF product is visible. The id moved to
         the LI so the whole row goes, rather than leaving an empty bullet in
         the submenu. */
      ok('the id is on the list item, not the anchor',
         /<li id="navEifLink"[^>]*><a href="#eif"/.test(land),
         'hiding only the anchor leaves a blank row in the dropdown');
      const main = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
      ok('and main.js still toggles it', /getElementById\('navEifLink'\)/.test(main),
         'the EIF range is hidden when no EIF product is on sale');
      const css = fs.readFileSync(path.join(ROOT, 'css', 'home-ci.css'), 'utf8');
      ok('the submenu opens on keyboard focus too', /\.nav-has-sub:focus-within > \.nav-sub/.test(css),
         'hover alone is unreachable without a pointer');
      /* The inline fallback must not start until the horizontal nav has gone.
         css/style.css swaps the nav for a slide-in panel at 768px; set at 900
         the submenu expanded while the row was still horizontal, so between
         769 and 900 both items sat permanently under Products. */
      ok('the inline fallback waits for the slide-in panel',
         /@media \(max-width: 768px\)[\s\S]{0,260}\.nav-sub/.test(css),
         'above the panel breakpoint the dropdown is hover and focus only');
      ok('and not a pixel earlier', !/@media \(max-width: 900px\)[\s\S]{0,260}\.nav-sub/.test(css));
      const styleCss = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
      ok('which is where the nav actually collapses',
         /@media \(max-width: 768px\)/.test(styleCss),
         'the two breakpoints have to agree or a band of widths gets both layouts');
    }

    console.log('\nand staff can publish without a deploy');
    {
      const t = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'tables.js'), 'utf8');
      ok('insights is writable through the admin API', /insights:\s+'id',/.test(t));
      ok('by admins only', /'investor_notes', 'insights',/.test(t),
         'anything less and a client could publish to the public site');
      ok('and readable only by staff', /'investor_notes',\s*\n(?:\s*\/\*[\s\S]*?\*\/\s*\n)?\s*'insights',\n\]\);/.test(t),
         'without this an investor could GET the table and read unpublished drafts');
    }

    console.log('\nthe console has somewhere to write them');
    {
      /* The API permission alone is not an authoring surface. The first version
         of this feature shipped the table, the routes and the write access, and
         nothing in the admin console — so there was nothing to click. */
      const idx = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
      const js  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      ok('there is a nav item', /data-view="insights"/.test(idx));
      ok('and a view for it', /id="view-insights"/.test(idx));
      ok('and an editor', /id="insightModal"/.test(idx));
      ok('the loader is registered', /insights: loadInsights,/.test(js),
         'a view with no loader renders whatever the previous screen left behind');
      ok('the title is registered', /insights: 'Insight Articles',/.test(js));
      for (const fn of ['loadInsights', 'openInsightEditor', 'saveInsight',
                        'toggleInsightPublished', 'deleteInsight'])
        ok(`  ${fn} exists`, new RegExp(`function ${fn}\\(`).test(js));
      ok('a published slug is never silently rewritten',
         /if \(slug && title && !slug\.value\.trim\(\)\)/.test(js),
         'changing the slug of a live article breaks every link already sent');
      ok('and published_at is stamped once, not on every edit',
         /published && !\(existing && existing\.published_at\)/.test(js),
         'otherwise the public date jumps each time somebody fixes a typo');
    }

    await db.query(`DELETE FROM insights WHERE id LIKE 'INS-CHK-%'`);

  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
