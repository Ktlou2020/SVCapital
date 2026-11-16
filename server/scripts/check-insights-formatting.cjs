#!/usr/bin/env node
/* Formatting an Insights article.
 *
 * REPORTED: "The editor does not allow us to apply basic formatting, such as
 * bold text, bullet points, or text alignment, across published articles on
 * the Insights page."
 *
 * It did not, and could not. The body was a plain textarea whose placeholder
 * read "Plain text — no HTML", and the article route rendered it with
 * `split(/\n{2,}/).map(t => '<p>' + esc(t) + '</p>')`. Every character an
 * author typed arrived on the page escaped, so a bold word was impossible by
 * construction, not by oversight.
 *
 * The escaping was never the bug and is not relaxed here. These pages are
 * server-rendered and public: a script that reached that string would run for
 * every reader and for the crawler that builds the WhatsApp share card.
 * services/articleMarkup.js escapes everything FIRST and then restores a
 * fixed allowlist, so a gap in the allowlist shows a tag as words rather than
 * running it.
 *
 * TWO HALVES, AND THE SEAM BETWEEN THEM. The console normalises what its
 * editor produces so an author sees what will be stored; the server decides
 * what actually renders. Two allowlists can drift, and the failure when they
 * do is silent — an author formats something, sees it in the editor, and
 * finds it plain on the site. So this drives the REAL toolbar in a REAL
 * browser and feeds what it produces through the REAL server renderer. If
 * the two ever disagree, a formatting button stops working here first.
 *
 * Run: node server/scripts/check-insights-formatting.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const { renderArticleBody, safeUrl } = require(path.join(ROOT, 'server', 'services', 'articleMarkup.js'));

/* Everything the server is allowed to emit. Anything left after removing
   these is live markup that got through, which is the only question that
   matters about this file. */
const ALLOWED_OUT = new RegExp(
  '</?(?:p|h2|h3|ul|ol|li|blockquote|strong|em|u|br)(?: class="ta-(?:left|center|right)")?>'
  + '|<a href="[^"]*" rel="noopener nofollow" target="_blank">|</a>', 'g');
const liveResidue = html => html.replace(ALLOWED_OUT, '').match(/<[a-zA-Z!/]/g) || [];

/* ── The gate ────────────────────────────────────────────────────────── */
console.log('\nnothing an article body contains reaches the page as live markup');
{
  const attacks = {
    'a script tag':            '<p>hi</p><script>alert(1)</script>',
    'an image with onerror':   '<p><img src=x onerror=alert(1)></p>',
    'a javascript: link':      '<p><a href="javascript:alert(1)">click</a></p>',
    'javascript: split by a tab': '<p><a href="java\tscript:alert(1)">click</a></p>',
    'javascript: with a newline': '<p><a href="java\nscript:alert(1)">click</a></p>',
    'a data: url':             '<p><a href="data:text/html,<script>alert(1)</script>">click</a></p>',
    'a protocol-relative url': '<p><a href="//evil.test/steal">click</a></p>',
    'a style attribute':       '<p style="position:fixed;inset:0">x</p>',
    'an inline handler':       '<p onclick="alert(1)">x</p>',
    'an svg with onload':      '<svg onload=alert(1)></svg>',
    'an iframe':               '<iframe src="https://evil.test"></iframe>',
    'a class nobody allowed':  '<p class="ta-evil">x</p>',
    'an attribute broken out of': '<p class="ta-center" onload="alert(1)">x</p>',
    'a form':                  '<form action="https://evil.test"><input name="p"></form>',
    'a meta refresh':          '<meta http-equiv="refresh" content="0;url=https://evil.test">',
  };
  for (const [name, body] of Object.entries(attacks)) {
    const out = renderArticleBody(body);
    ok(`${name} is inert`, liveResidue(out).length === 0, out.slice(0, 160));
  }
  /* And the words are kept, because an article that silently loses a
     sentence is its own kind of broken. */
  ok('a refused link keeps its words and loses only the anchor',
     renderArticleBody('<p><a href="javascript:x">click</a> rest</p>') === '<p>click rest</p>',
     renderArticleBody('<p><a href="javascript:x">click</a> rest</p>'));
  ok('and leaves no close tag for an element it never opened',
     !/<\/a>/.test(renderArticleBody('<p><a href="javascript:x">click</a></p>')),
     renderArticleBody('<p><a href="javascript:x">click</a></p>'));
}

/* ── The links that should work ──────────────────────────────────────── */
console.log('\nwhile a real link still works');
{
  ok('https survives', /href="https:\/\/svcapital\.co\.za\/x\?a=1&amp;b=2"/.test(
     renderArticleBody('<p><a href="https://svcapital.co.za/x?a=1&b=2">l</a></p>')),
     renderArticleBody('<p><a href="https://svcapital.co.za/x?a=1&b=2">l</a></p>')
     + ' — a query string must survive the ampersand escaping');
  ok('mailto survives', !!safeUrl('mailto:someone@example.test'));
  ok('a site-relative path survives', safeUrl('/insights') === '/insights');
  ok('but // is not relative', safeUrl('//evil.test') === null);
  ok('and a bare word is not a url', safeUrl('evil.test') === null,
     String(safeUrl('evil.test')));
  /* What the control-character cleaning is ACTUALLY for. Asserting it stops
     "java\tscript:" proves nothing — the scheme allowlist refuses that on its
     own, so removing the cleaning changed no result and the assertion passed
     either way. Its real effect is that a url copied out of a PDF, which
     arrives with a line break in it, still becomes a link. */
  ok('a url pasted with a line break in it still links',
     safeUrl('https://svcapital.co.za/in\nsights') === 'https://svcapital.co.za/insights',
     String(safeUrl('https://svcapital.co.za/in\nsights')));
  ok('and one with a tab in it does too',
     safeUrl('https://svcapital.co.za/a\tb') === 'https://svcapital.co.za/ab',
     String(safeUrl('https://svcapital.co.za/a\tb')));
  ok('every outgoing link carries rel=noopener',
     /rel="noopener nofollow"/.test(renderArticleBody('<p><a href="https://x.test/">l</a></p>')));
}

/* ── Articles written before any of this existed ─────────────────────── */
console.log('\nand every article published so far renders exactly as it did');
{
  const legacy = 'First paragraph.\n\nSecond paragraph.\n\nThird.';
  ok('blank lines still become paragraphs',
     renderArticleBody(legacy) === '<p>First paragraph.</p><p>Second paragraph.</p><p>Third.</p>',
     renderArticleBody(legacy));
  ok('and its text is still escaped',
     renderArticleBody('5 < 6 & "quoted"') === '<p>5 &lt; 6 &amp; &quot;quoted&quot;</p>',
     renderArticleBody('5 < 6 & "quoted"'));
  ok('an empty body renders nothing rather than an empty paragraph',
     renderArticleBody('') === '' && renderArticleBody('   ') === '');
}

/* ── The published page can actually show it ─────────────────────────── */
console.log('\nand the page has styles for what an author can now write');
{
  const ROUTE = read('server/routes/insights.js');
  ok('the route renders through the one gate',
     /renderArticleBody\(a\.body\)/.test(ROUTE)
     && !/split\(\/\\n\{2,\}\/\)/.test(ROUTE),
     'a second copy of this rule is a second answer to what an article may contain');
  for (const sel of ['article h2', 'article h3', 'article ul', 'article li',
                     'article blockquote', 'article strong', 'article a']) {
    ok(`${sel} is styled`, new RegExp(sel.replace(/ /g, '\\s+') + '\\s*[,{]').test(ROUTE),
       'unstyled markup is its own version of "formatting does not work"');
  }
  for (const c of ['ta-left', 'ta-center', 'ta-right']) {
    ok(`.${c} is styled on the page`, new RegExp('\\.' + c + '\\s*\\{').test(ROUTE), c);
  }
}

/* ── The seam: the real toolbar, in a real browser ───────────────────── */
async function throughTheEditor() {
  console.log('\nand every button on the toolbar produces something the server keeps');

  const ADMIN_JS   = read('admin/js/admin.js');
  const ADMIN_HTML = read('admin/index.html');

  /* The editor's own source, lifted out rather than reimplemented — a
     reimplementation here would test this file against itself. */
  const jsFrom = ADMIN_JS.indexOf('/* ── Insight article editor');
  const jsTo   = ADMIN_JS.indexOf('function openInsightEditor(');
  ok('the editor source was found', jsFrom > 0 && jsTo > jsFrom,
     'a slice that missed it would assert nothing while passing');
  const EDITOR_JS = ADMIN_JS.slice(jsFrom, jsTo);

  const htmlFrom = ADMIN_HTML.indexOf('<div class="ins-tb"');
  const htmlTo   = ADMIN_HTML.indexOf('</textarea>', htmlFrom);
  ok('the toolbar markup was found', htmlFrom > 0 && htmlTo > htmlFrom);
  const TOOLBAR = ADMIN_HTML.slice(htmlFrom, htmlTo + '</textarea>'.length);

  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (_) {
    ok('playwright is available to drive the toolbar', false,
       'without a browser the two allowlists are never compared');
    return;
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><meta charset="utf-8"><body>
    ${TOOLBAR}
    <script>
      /* The two helpers admin.js has and this page does not. */
      function _esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
      const Toast={info(){},error(){},success(){},warning(){}};
      ${EDITOR_JS}
      _insInitEditor();
    <\/script></body>`);

  /* Put words in, select them all, press a button, read what would be
     stored. Exactly what an author does. */
  const run = async (steps) => {
    await page.evaluate(() => { document.getElementById('insBodyRich').innerHTML = ''; });
    await page.click('#insBodyRich');
    await page.keyboard.type(steps.type || 'Hello world');
    if (steps.selectAll) await page.keyboard.press('Control+A');
    for (const sel of steps.press || []) await page.click(sel);
    return page.evaluate(() => { _insSync(); return document.getElementById('insBody').value; });
  };

  const cases = [
    { name: 'BOLD',        press: ['[data-ins-cmd="bold"]'],              want: /<strong>Hello world<\/strong>/ },
    { name: 'italic',      press: ['[data-ins-cmd="italic"]'],            want: /<em>Hello world<\/em>/ },
    { name: 'underline',   press: ['[data-ins-cmd="underline"]'],         want: /<u>Hello world<\/u>/ },
    { name: 'BULLET LIST', press: ['[data-ins-cmd="insertUnorderedList"]'], want: /<ul><li>Hello world<\/li><\/ul>/ },
    { name: 'numbered list', press: ['[data-ins-cmd="insertOrderedList"]'], want: /<ol><li>Hello world<\/li><\/ol>/ },
    { name: 'heading',     press: ['[data-ins-block="h2"]'],              want: /<h2>Hello world<\/h2>/ },
    { name: 'sub-heading', press: ['[data-ins-block="h3"]'],              want: /<h3>Hello world<\/h3>/ },
    { name: 'quote',       press: ['[data-ins-block="blockquote"]'],      want: /<blockquote>Hello world<\/blockquote>/ },
    { name: 'CENTRE',      press: ['[data-ins-align="ta-center"]'],       want: /class="ta-center"/ },
    { name: 'align right', press: ['[data-ins-align="ta-right"]'],        want: /class="ta-right"/ },
  ];

  for (const c of cases) {
    const stored = await run({ selectAll: true, press: c.press });
    ok(`${c.name} is stored`, c.want.test(stored), JSON.stringify(stored));
    /* And the half that was actually reported: does it survive publishing? */
    const published = renderArticleBody(stored);
    ok(`  …and SURVIVES the server`, c.want.test(published),
       JSON.stringify(published) + ' — the editor kept it and the page dropped it, '
       + 'which is the drift this check exists to catch');
    ok(`  …with nothing live added`, liveResidue(published).length === 0, published.slice(0, 120));
  }

  /* Two formats at once, which is where a normaliser that rebuilds rather
     than patches tends to lose one of them. */
  {
    await page.evaluate(() => { document.getElementById('insBodyRich').innerHTML = ''; });
    await page.click('#insBodyRich');
    await page.keyboard.type('Hello world');
    await page.keyboard.press('Control+A');
    await page.click('[data-ins-cmd="bold"]');
    await page.click('[data-ins-block="h2"]');
    await page.click('[data-ins-align="ta-center"]');
    const stored = await page.evaluate(() => { _insSync(); return document.getElementById('insBody').value; });
    const out = renderArticleBody(stored);
    ok('a centred bold heading keeps all three', /<h2 class="ta-center"><strong>/.test(out),
       JSON.stringify(out));
  }

  /* Pasting. The reason this is here: pasted Word markup looks right in the
     editor and arrives plain on the site, so the author formats something
     twice and believes the feature is broken. */
  {
    await page.evaluate(() => {
      const el = document.getElementById('insBodyRich');
      el.innerHTML = '';
      el.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', 'Pasted line one\n\nPasted line two');
      dt.setData('text/html', '<p style="color:red"><script>alert(1)<\/script>Pasted <b>line</b> one</p>');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    const stored = await page.evaluate(() => { _insSync(); return document.getElementById('insBody').value; });
    ok('a paste arrives as text, in paragraphs', /<p>Pasted line one<\/p><p>Pasted line two<\/p>/.test(stored),
       JSON.stringify(stored));
    ok('and brings no script with it', !/script|alert|color:red/i.test(stored), JSON.stringify(stored));
  }

  /* An article written before any of this opens without changing. */
  {
    const legacy = 'First paragraph.\n\nSecond paragraph.';
    const reread = await page.evaluate(b => {
      _insWriteEditor(b); _insSync();
      return document.getElementById('insBody').value;
    }, legacy);
    ok('an old plain-text article opens as paragraphs',
       reread === '<p>First paragraph.</p><p>Second paragraph.</p>', JSON.stringify(reread));
    ok('and publishes identically to how it did before',
       renderArticleBody(reread) === renderArticleBody(legacy),
       `${renderArticleBody(reread)} vs ${renderArticleBody(legacy)}`);
  }

  await browser.close();
}

throughTheEditor()
  .catch(e => { fail++; console.log('  ✗ the browser run failed\n      ' + e.message); })
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
