#!/usr/bin/env node
/* Sharing a referral — the link, the message and the picture.
 *
 * The bug this exists to hold shut: every referral ever shared pointed at
 * /register?ref=CODE, and /register was not a route. The SPA catch-all
 * answered with the landing page, ?ref= went with it, and nobody who clicked
 * a shared link ever reached the signup form. The dashboard's displayed link
 * had already been moved to /signup; the WhatsApp button had not, so the two
 * disagreed and the one people actually pressed was the broken one.
 *
 * So the first thing asserted here is that the URL the share builds is a URL
 * the server answers with the form — checked against the routing, not against
 * a second copy of the string.
 *
 * Run: node server/scripts/check-referral-share.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read  = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CORE   = read('js/portal-core.js');
const SERVER = read('server/index.js');
const SIGNUP = read('signup.html');

/* The shipped builders, lifted and run. */
function lift() {
  const names = ['svcPublicOrigin', 'svcShareOrigin', 'svcReferralLink',
                 'svcReferralMessage', 'svcCopyToClipboard'];
  let src = '';
  for (const n of names) {
    const m = CORE.match(new RegExp(`(?:async )?function ${n}\\([\\s\\S]*?\\n\\}`, 'm'));
    if (!m) throw new Error(`could not lift ${n} from js/portal-core.js`);
    src += m[0] + '\n';
  }
  const ctx = { encodeURIComponent, String, Promise,
                /* Deliberately the address the app really has: a link built
                   from window.location.origin instead of svcShareOrigin()
                   then reads as https://localhost, which is the bug. */
                window: { __SVC_NATIVE__: true, location: { origin: 'https://localhost' } } };
  ctx.File = function File(parts, name, opts) { this.parts = parts; this.name = name; this.type = (opts || {}).type; };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.api = { ' + names.join(', ') + ' };', ctx);
  return ctx.api;
}
const A = lift();
const PUBLIC = A.svcPublicOrigin();

const CODE = 'SVCY2GTUG';
const LINK = A.svcReferralLink(CODE);

console.log('\nthe link goes somewhere that exists');
{
  ok('it carries the code as ?ref=', /[?&]ref=SVCY2GTUG(&|$)/.test(LINK), LINK);
  ok('and it is absolute, so it survives being pasted anywhere',
     /^https?:\/\//.test(LINK), LINK);
  ok('and built on the public address even from inside the app',
     LINK.startsWith(PUBLIC + '/'), LINK);

  /* The whole point. Whatever path the share builds, the server has to answer
     it with the signup form — not with the landing page via the catch-all. */
  /* Resolved the way the server resolves it, not by matching a string: an
     explicit app.get serving the form, or a <path>.html sitting at the root
     for the .html fallback to find. Neither, and the request falls through to
     the catch-all, which answers every unknown path with the landing page —
     which is exactly how this went unnoticed. */
  const p = LINK.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  const srv = strip(SERVER);
  const routed = new RegExp(`app\\.get\\('${p.replace(/\//g, '\\/')}',[\\s\\S]{0,240}signupFile`).test(srv) &&
                 /const signupFile = path\.join\(__dirname, '\.\.', 'signup\.html'\)/.test(srv);
  const isFile = fs.existsSync(path.join(ROOT, `${p.slice(1)}.html`)) &&
                 /params\.get\('ref'\)/.test(read(`${p.slice(1)}.html`));
  ok(`${p} is served with the signup form`, routed || isFile,
     'it falls through to the catch-all: the landing page, and the code is thrown away');

  ok('/register specifically is routed, so links already sent still work',
     /app\.get\('\/register',[\s\S]{0,240}signupFile/.test(srv),
     'every invite in somebody’s WhatsApp history stays broken');

  /* Registered before the .html redirect and before express.static, or the
     static handler answers first and the query string is lost. */
  const iRegister = SERVER.indexOf("app.get('/register'");
  const iStatic   = SERVER.indexOf('app.use(express.static(');
  const iRedirect = SERVER.indexOf("if (!req.path.endsWith('.html')) return next();");
  ok('and it is mounted before the static handler and the .html redirect',
     iRegister > 0 && iRegister < iStatic && iRegister < iRedirect,
     `register@${iRegister} static@${iStatic} redirect@${iRedirect}`);

  ok('the signup form reads the code back out of the URL',
     /params\.get\('ref'\)/.test(read('signup.html')),
     'the referral arrives and is silently dropped at the form');
}

console.log('\na share leaves the device, so it never carries this device\u2019s address');
{
  /* The bug this is here for: inside the app the page is served from
     localhost, so every referral shared from a phone would have been a link
     that opens nothing. */
  ok('the app sends the public address, not its own',
     A.svcShareOrigin({ __SVC_NATIVE__: true, location: { origin: 'https://localhost' } }) === PUBLIC,
     A.svcShareOrigin({ __SVC_NATIVE__: true, location: { origin: 'https://localhost' } }));
  /* Android with androidScheme https serves from https://localhost, which the
     localhost rule below also catches — so the native flag is checked against
     a host only it can rule out, or removing it would change nothing here. */
  ok('whatever host the shell happens to serve from',
     A.svcShareOrigin({ __SVC_NATIVE__: true, location: { origin: 'https://svcapital-production.up.railway.app' } }) === PUBLIC,
     'the app would hand somebody the Railway host');
  ok('and so does a Capacitor page that forgot to flag itself',
     A.svcShareOrigin({ location: { origin: 'capacitor://localhost' } }) === PUBLIC);
  ok('a browser on localhost does not share localhost either',
     A.svcShareOrigin({ location: { origin: 'http://localhost:3000' } }) === PUBLIC);
  ok('nor 127.0.0.1',
     A.svcShareOrigin({ location: { origin: 'http://127.0.0.1:8080' } }) === PUBLIC);
  ok('but staging keeps sharing staging, so a test invite is testable',
     A.svcShareOrigin({ location: { origin: 'https://svcapital-staging.up.railway.app' } })
       === 'https://svcapital-staging.up.railway.app');
  ok('and the live site shares itself',
     A.svcShareOrigin({ location: { origin: PUBLIC } }) === PUBLIC);
  ok('the public address is the one the reset emails and og:url already use',
     PUBLIC === 'https://platform.svcapital.co.za' &&
     read('server/routes/auth.js').includes(PUBLIC), PUBLIC);
}

console.log('\nthe page shows the link it actually sends');
{
  /* They were two strings for a while — the dashboard said /signup, the share
     button said /register, and only one of them was a route. Whichever a
     client uses has to be the one that was tested. */
  const dash = (CORE.match(/async function loadReferralDashboard\([\s\S]*?\n\}/) || [''])[0];
  ok('the displayed link is built by the shared builder',
     /svcReferralLink\(code\)/.test(dash),
     'the link on screen and the link in the message can drift apart');
  ok('and not from this device\u2019s own address',
     !/window\.location\.origin/.test(dash),
     'the app would show a client a localhost link to copy');
  /* It used to copy exactly what was on screen — the bare URL — which is the
     paste the client reported. The link stays on screen to be read; what goes
     to the clipboard is the invite around it. */
  ok('the link is still shown, so it can be read',
     /linkEl\.textContent = refLink/.test(dash));
}

console.log('\nthe message says what the client asked it to say');
{
  const msg = A.svcReferralMessage(CODE, LINK);
  ok('it names the programme and the return',
     /Join SV Capital and start earning inflation-beating returns!/.test(msg), msg);
  ok('it quotes the referral code', msg.includes(`Use my referral code ${CODE}`), msg);
  ok('and it ends with the link, so the preview card attaches to it',
     msg.trim().endsWith(LINK), msg);
}

console.log('\nthe picture rides on the link, not on an attachment');
{
  /* This is the bug, and the first version of this file asserted the cause of
     it. navigator.share({ files, text }) looks like it sends both; WhatsApp
     keeps the file and drops the text, so the client got a picture with no
     sentence, no code and no link — which is the only part that carries the
     referral at all. */
  const core = strip(CORE);
  ok('nothing is attached as a file',
     !/navigator\.share\s*\(/.test(core) && !/canShare/.test(core),
     'WhatsApp keeps the attachment and throws the message away');

  /* Which makes the Open Graph card the only thing putting the image in the
     conversation — so it is not a nicety any more, it is the mechanism. */
  ok('the invite image is shipped',
     fs.existsSync(path.join(ROOT, 'assets/referral-invite.png')));
  {
    const d = fs.readFileSync(path.join(ROOT, 'assets/referral-invite.png'));
    const w = d.readUInt32BE(16), h = d.readUInt32BE(20);
    ok('and it is square at 1080, which is what the networks crop to',
       w === 1080 && h === 1080, `${w}x${h}`);
    ok('and the file is whole, not a header with nothing behind it',
       d.length > 20000 && d.slice(-8).toString('latin1').includes('IEND'),
       `${d.length} bytes`);
    /* WhatsApp gives up on a preview image well before this; 88KB is nowhere
       near it, but a replacement dropped in by hand could be. */
    ok('and small enough for WhatsApp to fetch as a preview',
       d.length < 600 * 1024, `${Math.round(d.length / 1024)}KB`);
  }
  ok('the signup page carries og:image',
     /<meta property="og:image" content="([^"]+)"/.test(SIGNUP));
  const ogImage = (SIGNUP.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || '';
  ok('pointing at that file',
     ogImage.endsWith('/assets/referral-invite.png'), ogImage);
  ok('by absolute URL, because the crawler has no page to resolve against',
     /^https:\/\//.test(ogImage), ogImage);
  ok('og:url names the link the message actually contains',
     ((SIGNUP.match(/<meta property="og:url" content="([^"]+)"/) || [])[1] || '').endsWith('/register'),
     'the card would describe a different page from the one being opened');
  ok('and the dimensions are declared, so the card renders before the fetch',
     /og:image:width" content="1080"/.test(SIGNUP) && /og:image:height" content="1080"/.test(SIGNUP));
}

console.log('\nevery button hands over the whole message');
{
  const share = (CORE.match(/async function shareReferral\([\s\S]*?\n\}/) || [''])[0];
  const copy  = (CORE.match(/async function copyReferralLink\([\s\S]*?\n\}/) || [''])[0];

  ok('WhatsApp gets the message, not just the link',
     /wa\.me\/\?text=\$\{encodeURIComponent\(msg\)\}/.test(share) &&
     /const msg = svcReferralMessage\(/.test(share), share);
  ok('copying gets the message too',
     /svcCopyToClipboard\(msg\)/.test(share),
     'a pasted URL arrives as a card with no sentence and no code to type in');
  ok('and so does the small button beside the link',
     /svcCopyToClipboard\(svcReferralMessage\(/.test(copy), copy);
  ok('neither copies the bare URL any more',
     !/writeText\(link\)/.test(CORE) && !/getElementById\('referralLink'\)\.textContent/.test(copy),
     'that is the paste the client reported');

  /* Both buttons in both shells call into the above, so a shell that wired a
     button to something else would not be covered by any of it. */
  for (const shell of ['portal/index.html', 'mobile/src/index.html']) {
    const html = read(shell);
    ok(`${shell} wires WhatsApp to the shared function`,
       /onclick="shareReferral\('whatsapp'\)"/.test(html));
    ok(`${shell} wires copy to the shared function`,
       /onclick="copyReferralLink\(\)"/.test(html));
    ok(`${shell} does not still offer a bare-link copy`,
       !/Copy Link<\/button>/.test(html),
       'the label promised a link and that is what it gave');
  }
}

console.log('\ncopying works where the modern clipboard does not');
{
  /* navigator.clipboard is undefined outside a secure context and in older
     WebViews — not failing, absent — so without a fallback the button did
     nothing at all and said nothing about it. */
  const seen = [];
  const doc = () => ({
    createElement: () => ({ setAttribute() {}, select() {}, style: {}, set value(v) { seen.push(v); } }),
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => true,
  });
  const run = async (nav, d) => A.svcCopyToClipboard('the whole invite', nav, d);

  (async () => {
    let written = null;
    ok('the modern API is used when it is there',
       (await run({ clipboard: { writeText: async t => { written = t; } } }, doc())) === true &&
       written === 'the whole invite');

    seen.length = 0;
    ok('and the old one when it is not',
       (await run({}, doc())) === true && seen[0] === 'the whole invite',
       JSON.stringify(seen));

    seen.length = 0;
    ok('a rejected write falls back rather than failing silently',
       (await run({ clipboard: { writeText: async () => { throw new Error('denied'); } } }, doc())) === true &&
       seen[0] === 'the whole invite');

    ok('and when neither works it says so rather than claiming success',
       (await run({}, { createElement: doc().createElement, body: doc().body, execCommand: () => false })) === false);
    ok('with no document at all, it does not throw',
       (await run({}, null)) === false);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}


