#!/usr/bin/env node
/* The homepage asks who is reading it — once, and without standing in the way.
 *
 * The homepage is written for somebody investing their own money. A person
 * placing a family allocation, or allocating for an institution, reads the
 * same page and leaves. There is now a page written for them, and the
 * chooser is the one question that gets them to it.
 *
 * Every way this pattern goes wrong is a thing somebody shipped once:
 *
 *  · AS A GATE. Markup in the HTML, hidden by CSS, revealed by script — and
 *    a crawler, a reader with JavaScript off, and the link preview all get a
 *    homepage that is a modal. So the markup is built in script and
 *    index.html must stay clean of it.
 *  · ASKING EVERY VISIT. Only an answer that is stored stops the question,
 *    and that means EVERY exit path has to store one, the dismissal and the
 *    Escape key included. Miss one and the reader who closes it is asked
 *    again tomorrow, and the day after.
 *  · REDIRECTING ON THE REMEMBERED ANSWER. Convenient for one visit and
 *    infuriating for ever: somebody who typed the homepage in cannot reach
 *    it again. A stored answer suppresses the question and moves nobody.
 *  · INTERRUPTING SOMEBODY MID-ERRAND. A deep link, a hash, an ?as= — an
 *    intent already declared. Not a person to stop and interview.
 *
 * The static half reads the source. The measured half drives the real page in
 * a real browser through the whole state sequence, because every one of those
 * four properties is about what happens on a second visit, and no amount of
 * grepping sees a second visit. It is skipped — loudly — when there is no
 * browser to drive.
 *
 * Run: node server/scripts/check-audience-chooser.cjs
 */
'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const JS    = read('js/audience.js');
const HOME  = read('index.html');
const CSS   = read('css/style.css');
const INST  = read('institutional.html');
const INSTJ = read('js/institutional.js');

/* ── It is not a gate ───────────────────────────────────────────── */
console.log('\nit is not a gate');
{
  ok('the homepage ships without a line of the chooser in it',
     !/aud-overlay|aud-box|aud-choice|aud-skip/.test(HOME),
     'markup in the page is markup a crawler, a no-JS reader and the link preview all get');
  ok('and without its question written anywhere in the document',
     !/sounds most like you/i.test(HOME));
  ok('the overlay is built element by element',
     /document\.createElement\('div'\)/.test(JS) && /document\.createElement\('button'\)/.test(JS));
  ok('nothing is rendered through innerHTML',
     !/innerHTML/.test(JS),
     'the copy is ours today and comes from somewhere else the day somebody makes it editable');
  ok('the homepage loads it, with a cache stamp',
     /<script src="js\/audience\.js\?v=\d+"><\/script>/.test(HOME),
     'an unstamped script is served immutable for a year');
}

/* ── It asks once ───────────────────────────────────────────────── */
console.log('\nit asks once');
{
  ok('the answer is stored under one key',
     /const KEY = 'svc_audience'/.test(JS));
  ok('a stored answer suppresses the question',
     /if \(read\(KEY\)\) return false/.test(JS));

  /* The point of the next three: a path out that does not store is a path
     that re-asks tomorrow. There are four — choosing, dismissing, Escape,
     and clicking the backdrop — and each must call remember(). */
  const click  = (JS.match(/btn\.addEventListener\('click',[\s\S]*?\}\);/)  || [''])[0];
  const skip   = (JS.match(/skip\.addEventListener\('click',[\s\S]*?\}\);/) || [''])[0];
  const back   = (JS.match(/overlay\.addEventListener\('click',[\s\S]*?\}\);/) || [''])[0];
  const esc    = (JS.match(/function onKey\([\s\S]*?\n  \}/) || [''])[0];
  ok('choosing stores the answer',     /remember\(c\.id\)/.test(click), click.trim());
  ok('dismissing stores one too',      /remember\('retail'\)/.test(skip),
     'somebody who closes it has told you the page they are on is the one they want');
  ok('clicking the backdrop as well',  /remember\('retail'\)/.test(back), back.trim());
  ok('and so does Escape',             /remember\('retail'\)/.test(esc), esc.trim());
  ok('all four paths are accounted for',
     (JS.match(/remember\(/g) || []).length >= 5,
     'four call sites plus the definition');

  ok('storage is guarded, both ways',
     /getItem\(k\); \} catch/.test(JS) && /setItem\(k, v\); \} catch/.test(JS),
     'a private window throws on access, and the page has to work anyway');
}

/* ── It never redirects by itself ───────────────────────────────── */
console.log('\nit never redirects by itself');
{
  const navs = JS.match(/window\.location\.href\s*=/g) || [];
  ok('there is exactly one navigation in the file', navs.length === 1, `${navs.length} found`);

  const clickBody = (JS.match(/btn\.addEventListener\('click',[\s\S]*?\n      \}\);/) || [''])[0];
  ok('and it is inside the click handler, behind a chosen destination',
     /if \(c\.href\) window\.location\.href = c\.href/.test(clickBody),
     'anywhere else and a returning reader cannot reach the homepage they asked for');

  const should = (JS.match(/function shouldAsk\(\)[\s\S]*?\n  \}/) || [''])[0];
  ok('the suppression path cannot navigate',
     !!should && !/location\.href\s*=/.test(should), should.trim());

  ok('staying put is a real option, with no destination',
     /id: 'retail',[\s\S]{0,320}?href: null/.test(JS),
     'the first choice must not move anybody');
}

/* ── It does not interrupt somebody mid-errand ──────────────────── */
console.log('\nit does not interrupt somebody mid-errand');
{
  const should = (JS.match(/function shouldAsk\(\)[\s\S]*?\n  \}/) || [''])[0];
  ok('a hash means they came for a section',
     /url\.hash && url\.hash !== '#'/.test(should) && /return false/.test(should));
  ok('an ?as= means they have already said',
     /url\.searchParams\.has\('as'\)/.test(should));
  ok('and arriving from the other page counts as having been asked',
     /institutional\\.html\/i\.test\(document\.referrer/.test(should));
}

/* ── Changing your mind ─────────────────────────────────────────── */
console.log('\nchanging your mind does not need site data cleared');
{
  ok('the question can be re-opened from script',
     /window\.svcAskAudience = function/.test(JS));
  ok('re-opening clears the stored answer first',
     /removeItem\(KEY\)/.test(JS),
     'otherwise shouldAsk() suppresses the very question being asked for');
  ok('the menu offers it',
     /svcAskAudience/.test(HOME),
     'a chooser only reachable on a first visit is a chooser nobody can correct');
}

/* ── The destinations exist ─────────────────────────────────────── */
console.log('\nthe destinations exist and arrive set up');
{
  const hrefs = [...JS.matchAll(/href: '([^']+)'/g)].map(m => m[1]);
  ok('both routes out point at the institutional page', hrefs.length === 2
     && hrefs.every(h => h.startsWith('institutional.html?as=')), hrefs.join(', '));
  ok('that page is on disk and published', fs.existsSync(path.join(ROOT, 'institutional.html'))
     && /institutional\.html/.test(read('package.json')));

  /* A cross-file contract: the chooser's ?as= values are only useful if the
     form's select actually has options with those values. */
  const opts = [...INST.matchAll(/<option value="([^"]+)">/g)].map(m => m[1]);
  for (const h of hrefs) {
    const want = h.split('as=')[1];
    ok(`the form has a capacity option for "${want}"`, opts.includes(want), opts.join(', '));
  }
  ok('the page reads ?as= and preselects it',
     /searchParams\.get\('as'\)/.test(INSTJ) && /sel\.value = match\.value/.test(INSTJ));
  ok('and ignores a value it does not recognise rather than guessing',
     /\[\.\.\.sel\.options\]\.find\(o => o\.value === want\)/.test(INSTJ)
     && /if \(match\)/.test(INSTJ));
}

/* ── Housekeeping ───────────────────────────────────────────────── */
console.log('\nit cleans up after itself');
{
  const close = (JS.match(/function close\(\)[\s\S]*?\n  \}/) || [''])[0];
  ok('the scroll lock is released', /document\.body\.style\.overflow = ''/.test(close),
     'a page left at overflow:hidden cannot be scrolled and nothing on screen says why');
  ok('the key listener is removed', /removeEventListener\('keydown', onKey\)/.test(close),
     'the question can be re-opened, so a listener left behind is added again each time');
  ok('focus is returned to where it was', /lastFocus\.focus\(\)/.test(close));
  ok('and it is moved into the dialog when it opens',
     /querySelector\('\.aud-choice'\)[\s\S]{0,60}focus\(\)/.test(JS));
  ok('the overlay is announced as a dialog',
     /setAttribute\('role', 'dialog'\)/.test(JS) && /aria-modal/.test(JS)
     && /aria-labelledby/.test(JS));
  ok('the styling is in the shared stylesheet, with motion opt-out',
     /\.aud-overlay \{/.test(CSS)
     && /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.aud-overlay/.test(CSS));
}

/* ── Measured ───────────────────────────────────────────────────── */
/* Found rather than named: the bundled build is versioned (chromium-1194 one
   week, chromium-1243 the next), and a hardcoded path skips quietly for ever
   after the next image update. */
const CHROME = (() => {
  const base = '/opt/pw-browsers';
  const link = path.join(base, 'chromium');
  if (fs.existsSync(link)) return link;
  if (!fs.existsSync(base)) return null;
  for (const dir of fs.readdirSync(base)
        .filter(d => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
    for (const inner of ['chrome-linux64', 'chrome-linux']) {
      const bin = path.join(base, dir, inner, 'chrome');
      if (fs.existsSync(bin)) return bin;
    }
  }
  return null;
})();

if (!CHROME) {
  console.log('\n  SKIP  no chromium under /opt/pw-browsers — the measured half did not run');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
               '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon' };

const devtools = (port, p) => new Promise((res, rej) =>
  http.get({ host: '127.0.0.1', port, path: p }, r => {
    let s = ''; r.on('data', c => s += c); r.on('end', () => res(JSON.parse(s)));
  }).on('error', rej));

(async () => {
  /* Served over http, not file://. localStorage is the whole subject here and
     a file:// origin is opaque — the second visit would look like a first. */
  const site = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${site.address().port}`;

  const port = 9446;
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`,
    '--no-sandbox', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  const stop = () => { try { proc.kill(); } catch (_) {} site.close(); };

  try {
    let tabs;
    for (let i = 0; i < 25 && !tabs; i++) {
      await new Promise(r => setTimeout(r, 400));
      try { tabs = await devtools(port, '/json/list'); } catch (_) {}
    }
    if (!tabs) { ok('the browser started', false, 'devtools never answered'); stop(); return; }

    const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const pending = new Map();
    ws.onmessage = ev => { const d = JSON.parse(ev.data);
      if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params) => new Promise(r => {
      const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

    await send('Page.enable');
    await send('Runtime.enable');

    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    /* A navigation that differs only in the hash is a SAME-DOCUMENT one: the
       page does not reload and the script does not run again, so a hash step
       would be measuring the last step's page and passing for it. Hence the
       blank page in between — the only way to be sure the arrival is real. */
    const goto = async url => {
      if (url.includes('#')) {
        await send('Page.navigate', { url: 'about:blank' });
        await new Promise(r => setTimeout(r, 250));
      }
      await send('Page.navigate', { url });
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 150));
        try { if (await evaluate('document.readyState') === 'complete') break; } catch (_) {}
      }
      await new Promise(r => setTimeout(r, 400));
    };
    /* What the page looks like from the reader's side, in one object. */
    const STATE = `({
      shown:   !!document.querySelector('.aud-overlay'),
      choices: [...document.querySelectorAll('.aud-choice__title')].length,
      stored:  (() => { try { return localStorage.getItem('svc_audience'); } catch (_) { return 'THREW'; } })(),
      locked:  document.body.style.overflow === 'hidden',
      focused: document.activeElement ? document.activeElement.className : null,
      page:    location.pathname.split('/').pop() + location.search,
    })`;

    console.log('\nthe first visit');
    await goto(BASE + '/index.html');
    await evaluate(`localStorage.clear()`);
    await goto(BASE + '/index.html');
    let s = await evaluate(STATE);
    ok('the question is asked', s.shown === true, JSON.stringify(s));
    ok('with all three answers on it', s.choices === 3, String(s.choices));
    ok('the page behind it does not scroll', s.locked === true);
    ok('and focus has moved into it', /aud-choice/.test(s.focused || ''), String(s.focused));

    console.log('\nanswering it');
    await evaluate(`[...document.querySelectorAll('.aud-choice')][2].click()`);
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 150));
      if ((await evaluate(`location.pathname`)).includes('institutional')) break;
    }
    await new Promise(r => setTimeout(r, 500));
    s = await evaluate(STATE);
    ok('the institutional reader lands on their page', /^institutional\.html/.test(s.page), s.page);
    ok('carrying what they said, so the form arrives set up', s.page.includes('as=institution'), s.page);
    ok('and the answer is remembered', s.stored === 'institution', String(s.stored));
    ok('the capacity is preselected', await evaluate(`document.getElementById('enqCapacity').value`) === 'institution');

    console.log('\ncoming back to the homepage');
    await goto(BASE + '/index.html');
    s = await evaluate(STATE);
    ok('they are not interrogated a second time', s.shown === false, JSON.stringify(s));
    ok('and they are not bounced off the page they asked for', s.page === 'index.html', s.page);
    ok('the answer is still there', s.stored === 'institution', String(s.stored));

    console.log('\nchanging their mind from the menu');
    await evaluate(`window.svcAskAudience()`);
    await new Promise(r => setTimeout(r, 400));
    s = await evaluate(STATE);
    ok('the question comes back on request', s.shown === true, JSON.stringify(s));

    console.log('\nwalking away from it');
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await new Promise(r => setTimeout(r, 600));
    s = await evaluate(STATE);
    ok('Escape closes it', s.shown === false, JSON.stringify(s));
    ok('closing counts as an answer', s.stored === 'retail', String(s.stored));
    ok('and the page scrolls again', s.locked === false);
    await goto(BASE + '/index.html');
    s = await evaluate(STATE);
    ok('so it is not asked again on the next visit', s.shown === false, JSON.stringify(s));

    console.log('\narriving mid-errand');
    await evaluate(`localStorage.clear()`);
    await goto(BASE + '/index.html#products');
    s = await evaluate(STATE);
    ok('a deep link is left alone', s.shown === false, JSON.stringify(s));
    ok('and nothing was decided on their behalf', s.stored === null, String(s.stored));

    await evaluate(`localStorage.clear()`);
    await goto(BASE + '/index.html?as=institution');
    s = await evaluate(STATE);
    ok('a declared capacity is not re-asked', s.shown === false, JSON.stringify(s));

    console.log('\nthe other page takes the reader at their word');
    await goto(BASE + '/institutional.html?as=individual');
    ok('a private individual arrives as one',
       await evaluate(`document.getElementById('enqCapacity').value`) === 'individual');
    await goto(BASE + '/institutional.html?as=nonsense');
    ok('and a value nobody offered is ignored, not guessed at',
       await evaluate(`document.getElementById('enqCapacity').value`) === 'institution',
       'the select should be left on its own first option');

    ws.close();
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    stop();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
