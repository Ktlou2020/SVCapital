#!/usr/bin/env node
/* The private-client page says what it may, and lays out where it is read.
 *
 * There are three audiences and three pages now. The main site is written
 * for somebody starting out, the institutional page for a committee, and
 * this one for a person placing their own money or their family's. The
 * split is the point: an allocator and a private client want different
 * things said to them, and a page that tries to be both is neither.
 *
 * WHAT IT SAYS. The licence wording has to be exact — SmartVest Financial
 * Services (Pty) Ltd carries FSP 52449 and SV Capital is the fund manager —
 * and capital-at-risk has to be stated rather than implied. It must carry no
 * rand figure at all: a number on a public page is an offer at a price, and
 * this audience is quoted in conversation. And it must not drift into the
 * retail funnel's vocabulary, which is half the reason the page exists.
 *
 * WHAT IT SHARES. The fetch, the aggregation and the enquiry form live in
 * js/enquiry.js and both pages load it. The product families in particular
 * have been rewritten once already, when solar became three products and
 * EIF three more; a second copy of that map would have quietly stopped
 * counting solar on one page and nobody would have noticed. So: one copy,
 * asserted.
 *
 * HOW IT LAYS OUT. The measured half, because three of the four faults found
 * while building this page were invisible in the source and obvious in a
 * browser: fields 30px wider than their column under the content-box
 * default, a hero button painted in the page's ink ON the page's ink because
 * a generic link rule outranked it, and a step's paragraph auto-placed into
 * a 62px counter track one word wide. None of those can be grepped for.
 *
 * Run: node server/scripts/check-private-clients-page.cjs
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

const HTML   = read('private-clients.html');
const JS     = read('js/private-clients.js');
const CSS    = read('css/private-clients.css');
const SHARED = read('js/enquiry.js');
const INST   = read('institutional.html');

/* Prose on these pages is hand-wrapped, so a sentence that reads as one
   line in the browser is three in the source with newlines and indentation
   inside it. Every assertion below about what the page SAYS runs against a
   whitespace-flattened copy; a regex written against the raw source passes
   or fails on where somebody happened to break the line. */
const FLAT = HTML.replace(/\s+/g, ' ');

/* The hero on its own. Several rules are about what a reader is told
   BEFORE they have scrolled, and the whole-page text cannot tell the
   difference between that and a line beside the form. Sliced from <body>
   so the meta description in <head> cannot stand in for it. */
const HERO = FLAT.slice(FLAT.indexOf('<body'), FLAT.indexOf('</header>'));

console.log('\nwhat the page says');
{
  ok('the provider and the fund manager are named exactly',
     /SmartVest Financial Services \(Pty\) Ltd/.test(HTML)
     && /FSP 52449/.test(HTML)
     && /<strong>SV Capital<\/strong> is\s+appointed as the alternative fund manager/.test(FLAT));
  /* One page, one account of who does what under the licence. The About
     section was rewritten to say SmartVest administers and SV Capital is
     the appointed alternative fund manager, while the legal footer still
     said SV Capital administers each pool \u2014 the same page describing its
     own regulatory arrangement two ways, in the two places a reader is
     most likely to check it against each other. */
  {
     const smartvestAdmins = /administered by SmartVest|SmartVest[^.]{0,60}administers the funds/i.test(FLAT);
     const svcAdmins = /SV Capital[^.]{0,60}administers each pool/i.test(FLAT);
     ok('the page gives one account of who administers the funds',
        !(smartvestAdmins && svcAdmins),
        'the About section and the legal footer disagree about who administers');
     ok('and it names the appointed manager alongside the provider',
        /FSP 52449/.test(FLAT) && /SV Capital/.test(FLAT));
  }

  ok('capital at risk is stated, not implied',
     /[Cc]apital is at risk/.test(HTML) && /no pool guarantees/i.test(HTML));
  ok('and it is answered head on, not buried in the footer',
     /Is my capital guaranteed\?/.test(HTML) && /\bNo\b/.test(HTML),
     'it is the first question this reader has');
  ok('a rate shown before a pool concludes is called a target',
     /target[^.]{0,120}(not a promise|drawn from the underlying)/i.test(HTML));
  ok('past performance carries its warning',
     /[Pp]ast performance is not a guide/.test(HTML));

  /* The institutional page carries no figure at all; this one carries
     exactly one. The entry point for a private-client relationship is
     published because withholding it wastes the time of everybody it does
     not suit — but it is the only number on the page, and a second one
     appearing is how a threshold turns into a price list.

       is in the class, and in the amount, because that is the separator
     toLocaleString('en-ZA') produces everywhere else on the platform — and
     because an ordinary space lets "R1 000" sit on one line and "000" on
     the next. A guard that only knew the ordinary space would also have let
     a figure pasted from anywhere else on the platform straight through. */
  const MONEY = /R\s?\d[\d  ,]*(?:\.\d\d)?(?:\s?million|M\+?)?/gi;
  const figures = (HTML.match(MONEY) || [])
    .map(m => m.trim()).filter(m => !/R\s?52449/.test(m));
  const ENTRY = 'R1 000 000';
  /* The meta descriptions say it in words, because that is what reads well
     in a search result. Both spellings are the same amount. */
  const SAME = [ENTRY, 'R1 million'];
  ok('the entry point is published', figures.includes(ENTRY),
     `found ${JSON.stringify(figures)} — expected ${JSON.stringify(ENTRY)}`);

  /* The page no longer carries only one amount — the impact section quotes
     what the platform has deployed and paid back, which is track record and
     belongs here. What must stay true is narrower and is the thing the
     original rule was protecting: exactly ONE figure on this page may be
     presented as a threshold, a price or an entry level, and it is the one
     above. A second would be an offer at a price to an audience that is
     quoted in conversation, and it is how a threshold becomes a price list. */
  const THRESHOLD = /(minimum|min\.|as little as|starts? (?:at|from)|starting (?:at|from)|from just|entry point|invest from|ticket size)/i;
  const priced = [];
  for (const m of HTML.matchAll(MONEY)) {
    const ctx = HTML.slice(Math.max(0, m.index - 110), m.index + m[0].length + 70);
    if (THRESHOLD.test(ctx) && !/R\s?52449/.test(m[0])) priced.push(m[0].trim());
  }
  ok('and it is the only figure quoted as a threshold', priced.every(f => SAME.includes(f)),
     JSON.stringify(priced), 'one threshold is a threshold; two is a price list');
  ok('the retail minimums are nowhere on the page',
     !/R\s?500\b/.test(HTML) && !/R\s?10[  ]?000\b/.test(HTML) && !/R\s?100[  ]?000\b/.test(HTML),
     'this page quotes one entry level; the platform’s product minimums are a different conversation');
  ok('it is written so it cannot wrap across a line',
     !/R1 000 000/.test(HTML) && HTML.includes(ENTRY),
     'an ordinary space breaks "R1 000" onto one line and "000" onto the next');
  /* The heading moved from "How much do I need to place?" to "What is the
     minimum investment?" \u2014 either is fine, but whichever one the page
     asks, the number has to be in the answer rather than a referral to a
     conversation. */
  ok('the question a reader actually has is answered with it',
     new RegExp(`(How much do I need to place\\?|What is the minimum investment\\?)[\\s\\S]{0,160}${ENTRY}`).test(HTML),
     'a figure in the hero and a dodge in the FAQ is worse than neither');
  ok('nothing on the page is presented as an offer',
     /Nothing here is an offer or a solicitation/.test(HTML),
     'a published figure makes that sentence load-bearing rather than boilerplate');

  /* Whole words. As substrings these catch honest prose — "quest" inside
     "request", "XP" inside "experience" — and a check that forbids a word
     nobody meant to forbid gets disabled rather than obeyed. */
  const RETAIL = ['Get Started', 'Sign Up', 'Start investing', 'quests?', 'XP',
                  'leaderboard', 'rewards?', 'referrals?', 'wallet', 'top up', 'badges?'];
  const found = RETAIL.filter(w => new RegExp(`\\b${w.replace(/ /g, '\\s')}\\b`, 'i').test(HTML));
  ok('none of the retail funnel’s language appears', found.length === 0, found.join(', '));
}


console.log('\nhow long the money is committed for');
{
  /* 18 months is a minimum this audience has to be told before they spend
     any more time on the page — it disqualifies people, which is the point
     of saying it early. */
  ok('the minimum term is named',
     /minimum (?:term is|of) 18 months/i.test(FLAT), 'not found');
  /* From <body>, not from character zero: the meta description in <head>
     also says 18 months, and slicing from the top let it stand in for the
     hero — the assertion passed with the hero stripped of every mention.
     What a search engine is told is not what the reader sees. */
  ok('and it is in the hero, not buried further down',
     HERO.length > 200 && /18 months/.test(HERO),
     'a term minimum found after four screens has already wasted somebody’s afternoon');

  /* The trap this page walked into once. The cattle cycle underneath is
     about 120 days, and the page used to say capital came back at the end
     of it — which is the asset's rhythm, not the client's commitment, and
     reads as a four-month investment to somebody signing up for eighteen.
     The cycle may be described; repayment may not be pinned to it. */
  const SHORT_REPAY = [
    /\b\d{1,3}\s*days\b[^.]{0,40}(?:capital|your money)[^.]{0,25}(?:back|repaid|returned)/i,
    /repaid when the cycle closes/i,
    /\bshort tenors?\b/i,
  ];
  const promises = SHORT_REPAY.filter(re => re.test(FLAT));
  ok('and the cattle cycle is never offered as the term',
     promises.length === 0,
     promises.map(String).join(' | ') +
     ' — the cycle is how the asset works; the term is what the client agreed to');
}

console.log('\none business, and only one');
{
  /* The positioning: an asset-backed private lending fund in agriculture,
     with a nine-year record in cattle. Said in those words, because a
     reader who allocates to private credit is looking for that shape and
     will not go hunting for it in a description of pooled investments. */
  ok('it says what kind of fund this is',
     /asset-backed/i.test(FLAT) && /\blend(?:ing|s|er|ers)?\b/i.test(FLAT),
     'private credit is the category; the page has to name it');
  ok('and what it lends against',
     /(cattle|livestock|herd)/i.test(FLAT) && /agricultur/i.test(FLAT));
  ok('and how long it has been doing it',
     /(nine years|9 years)/i.test(FLAT) && /cattle/i.test(FLAT),
     'the track record is in cattle and is the strongest thing the page has');
  ok('the collateral is named as collateral, not implied',
     /herd (?:is the|serves as|serving as)[^.]{0,20}(security|collateral)/i.test(FLAT));

  /* THE RULE: nothing but agriculture. The platform runs other product
     types and this page is not for them. Every term below belonged to one
     of the asset classes that used to be on this page, and each one is a
     way the old positioning creeps back — usually in a sentence somebody
     adds for completeness. */
  const ELSEWHERE = {
    'solar':            /\bsolar\b/i,
    'photovoltaic':     /photovoltaic/i,
    'panels':           /\bpanels?\b/i,
    'a power offtake':  /(power purchase|\bPPA\b|selling power|clean energy|renewable)/i,
    'enterprise finance': /enterprise finance/i,
    'purchase-order finance': /purchase[- ]order/i,
    'SMMEs':            /\bSMME/i,
    'the other partner': /MoolaLend/i,
    'the ethical range': /(Murabaha|Ijara|Mudarabah|Sharia|interest-free|Islamic finance)/i,
    'short-term investment': /short[- ]term investment/i,
  };
  const strayed = Object.entries(ELSEWHERE)
    .filter(([, re]) => re.test(FLAT)).map(([name]) => name);
  ok('no other asset class appears anywhere on the page',
     strayed.length === 0, strayed.join(', ') + ' — this page is agriculture only');

  /* And the same rule where the figures come from. A page that says nine
     years in cattle while quoting the whole platform's repayments is
     attributing somebody else's book to this one, which is the
     misstatement on this page that would matter most. */
  ok('and the live figures are the cattle book, not the platform',
     /const FAMILIES = \{\s*cattle: \[[^\]]*\],?\s*\}/.test(SHARED)
     && !/solar|eif_|short_term|smme/i.test(SHARED.slice(SHARED.indexOf('const FAMILIES'),
                                                         SHARED.indexOf('async function'))),
     'the aggregation decides what the track record on this page means');
}

console.log('\nthe only way in is to ask');
{
  /* The page used to end a reader's journey by pointing them at the retail
     funnel to open an account themselves. It no longer does, on purpose: at
     this level an allocation begins with a conversation, and a self-serve
     route is both the wrong first impression and a way for somebody to
     arrive on the platform without anyone having spoken to them. */
  ok('nothing on the page opens an account',
     !/signup\.html/.test(HTML) && !/login\.html/.test(HTML),
     'a sign-up link is the self-serve route this page exists not to offer');
  ok('and no button invites them to invest directly',
     !/Invest Now|Start investing|Open an account|Invest online/i.test(HTML));
  /* The wording moved from "should you wish to invest, contact us" to an
     invitation to talk. What has to stay true is the property rather than
     the sentence: the hero offers contact as the way in. Asserted against
     the hero alone, because a route that only appears beside the form is
     not an alternative \u2014 it is the thing somebody already found. */
  ok('the page says what to do instead, where it is read first',
     /(should you wish to invest|engage directly with prospective investors|request an investment discussion)/i.test(HERO)
     && /#talk/.test(HERO),
     'removing the route without naming the alternative is a dead end');
  ok('and the form is plainly a contact form',
     /<h2>Contact us<\/h2>/.test(HTML));
  /* "There is no way to invest from this page, and that is on purpose" is
     gone at the business's request \u2014 too blunt for this reader. The
     property it protected is still held by the two assertions above: no
     account can be opened here, and nothing invites them to try. */
}

console.log('\nwhat it now tells somebody about us');
{
  ok('there is a section about SV Capital', /id="about"/.test(HTML));
  ok('naming who carries the licence, again, in full',
     /SmartVest Financial Services \(Pty\) Ltd.{0,200}FSP 52449/.test(FLAT)
     && /Financial Sector Conduct Authority/.test(FLAT));
  ok('and how a client is onboarded',
     /FICA(?:,| and)[^.]{0,60}(AML|anti-money laundering)/i.test(FLAT));
  ok('and that the operating partner is diligenced first',
     /diligence|diligenced/i.test(FLAT) && /Beefcor/.test(FLAT));
  ok('the recognition is dated rather than floated',
     (HTML.match(/20(?:25|24|18|17)/g) || []).length >= 5,
     'an award with no year is a claim with no date');

  ok('how the lending works is set out, step by step',
     /How (?:the lending works|Our Investment Structure Works)/i.test(FLAT));
  ok('naming the operator and the contract that fixes the price',
     /Beefcor/.test(FLAT) && /offtake agreement/.test(FLAT));
  ok('what secures it, and what it is insured against',
     /collateral/i.test(FLAT)
     && /disease, theft and natural\s*hazards/i.test(FLAT));
  /* The concrete condition \u2014 the cattle reach weight, the offtake is
     honoured \u2014 is now the contractual form of the same thing. What may
     not go is the conditionality: repayment depends on something, and the
     something has to be named. */
  /* Scoped to the step that makes the promise. Matched against the whole
     page this passed while the repayment step itself said nothing but
     "repayment is made" \u2014 nine other sentences mention performance, and
     any one of them satisfied it. The condition has to be attached to the
     sentence a reader takes the promise from. */
  const REPAY = FLAT.slice(FLAT.search(/Repayment follows the investment term/i));
  ok('and what has to happen before anybody is paid',
     REPAY.length > 0
     && /(determined by|depends? on)[^.]{0,140}(performance|underlying)/i.test(REPAY.slice(0, 700))
     && /(not guaranteed|is at risk)/i.test(REPAY.slice(0, 700)),
     'the mechanics without the condition is a brochure');

  ok('the impact figures are there', /id="impact"/.test(HTML));
  ok('and they say what they are figures FOR',
     /cumulative/i.test(FLAT)
     && /(not the record of (?:any )?one pool|rather than the performance of any individual investment pool)/i.test(FLAT),
     'a cumulative platform number read as a pool\u2019s record is the oldest trick in the brochure');
  ok('with past performance still carrying its warning beside them',
     /(not the record of (?:any )?one pool|individual investment pool).{0,220}(past performance is not a guide|historical results are not indicative)/i.test(FLAT));
}

console.log('\nand what it does not carry');
{
  /* Named because they were named: the retail page's social proof and its
     entry price are the two things that make this page read as the funnel
     it is meant to sit apart from. */
  ok('no investor stories',
     !/testimonial/i.test(HTML) && !/investor stories/i.test(HTML)
     && !/\u201c[^\u201d]{40,}\u201d\s*<\/?(?:p|blockquote|span)/.test(HTML),
     'a quoted individual is retail social proof, whatever the page around it says');
}

console.log('\nit is a different page, not the same page twice');
{
  ok('it has its own stylesheet',
     /css\/private-clients\.css\?v=\d+/.test(HTML) && !/css\/institutional\.css/.test(HTML));
  ok('with its own palette rather than the other page’s tokens',
     /--pc-deep:/.test(CSS) && !/--in-deep/.test(CSS));
  ok('and the only purple in it is the house purple',
     (() => {
       const hexes = [...CSS.matchAll(/#([0-9a-f]{6})\b/gi)].map(m => m[1].toLowerCase());
       /* A purple is a hex whose red and blue both clearly lead green. */
       const purples = hexes.filter(h => {
         const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
         return r > g + 20 && b > g + 20;
       });
       return purples.every(h => h === 'eda5ff');
     })(),
     'CLAUDE.md: #eda5ff is the one permitted purple across the platform');
  ok('its display face is not the institutional page’s',
     /Fraunces/.test(HTML) && /Fraunces/.test(CSS));
  ok('the two pages point at each other',
     /institutional\.html/.test(HTML) && /private-clients\.html/.test(INST),
     'a reader who picked the wrong one has to be able to cross over');
  ok('and the main site links to this one',
     /href="private-clients\.html"/.test(read('index.html')));
  ok('it is in the published build',
     JSON.parse(read('package.json')).scripts['pages:build'].includes('private-clients.html'),
     'it would exist in the repository and 404 on the live site');
  ok('it is indexable and declares itself',
     /name="robots" content="index, follow"/.test(HTML)
     && /rel="canonical"/.test(HTML) && /property="og:title"/.test(HTML));
}

console.log('\nwhat the two pages share, they share once');
{
  ok('the product types these pages report are named in exactly one file',
     ['js/enquiry.js', 'js/institutional.js', 'js/private-clients.js']
       .filter(f => /cattle_12j/.test(read(f))).length === 1,
     'a second copy is how one page starts reporting a different number from the other');
  ok('and it is the cattle book, not the whole platform',
     /const FAMILIES = \{\s*cattle: \[[^\]]*\],?\s*\};/.test(SHARED),
     'summing the other product types would attribute another book to this one');
  ok('both pages load the shared script',
     /js\/enquiry\.js\?v=\d+/.test(HTML) && /js\/enquiry\.js\?v=\d+/.test(INST));
  ok('each loads its own renderer first',
     HTML.indexOf('js/private-clients.js') < HTML.indexOf('js/enquiry.js'),
     'the listener has to be registered before enquiry.js dispatches on DOMContentLoaded');
  ok('the enquiry posts to the one public endpoint',
     /fetch\('\/api\/enquiries\/institutional'/.test(SHARED) && !/fetch\('\/api/.test(JS));
  ok('the honeypot is here too, and off-screen rather than display:none',
     /name="company_website"/.test(HTML) && /\.pc-hp \{[^}]*left: -9999px/.test(CSS));
  ok('nothing from the API is rendered as markup',
     !/innerHTML/.test(JS) && !/innerHTML/.test(SHARED),
     'these pages render figures and pool names, and a pool name is typed by a person');
  ok('a section with nothing behind it stays hidden',
     /id="returned"[^>]*style="display:none"/.test(HTML)
     && /if \(concluded <= 0\) return;/.test(SHARED),
     'nothing paid back yet is an absence, not a result');
  ok('the result line takes its styling from the page it is on',
     /data-base="pc-result"/.test(HTML) && /result\.dataset\.base/.test(SHARED),
     'otherwise one page’s stylesheet decides how the other page says "sent"');
}

/* ── Measured ───────────────────────────────────────────────────── */
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

/* Relative luminance, so "is this text readable on that ground" is a number
   rather than an opinion. WCAG's own formula. */
const lum = rgb => {
  const [r, g, b] = rgb.map(v => { const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const parse = s => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);

(async () => {
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

  const port = 9452;
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`,
    '--no-sandbox', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  const stop = () => { try { proc.kill(); } catch (_) {} site.close(); };

  try {
    /* Thirty seconds, not ten. Four checks in this suite each start their
       own Chromium, and under that the browser has taken more than ten
       seconds to answer devtools — which failed the check with "the browser
       never answered" on a run where nothing was wrong with the page. A
       check that fails on a slow afternoon is a check people learn to
       re-run rather than read. If the process has actually died, say so:
       that is a different problem from a slow start and wants a different
       answer. */
    let tabs;
    const startedAt = Date.now();
    for (let i = 0; i < 60 && !tabs; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { tabs = await devtools(port, '/json/list'); } catch (_) {}
      if (proc.exitCode !== null) break;
    }
    if (!tabs) {
      ok('the browser started', false,
         proc.exitCode !== null
           ? `chromium exited with code ${proc.exitCode} after ${Date.now() - startedAt}ms`
           : `devtools never answered in ${Date.now() - startedAt}ms`);
      stop(); return;
    }

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
      const r = await send('Runtime.evaluate', { returnByValue: true, expression: expr });
      if (r.result && r.result.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails.exception || {}));
      }
      return r.result.result.value;
    };
    const goto = async url => {
      await send('Page.navigate', { url });
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 150));
        if (await evaluate('document.readyState') === 'complete') break;
      }
      await new Promise(r => setTimeout(r, 450));
    };
    const at = async (w, mobile) => {
      await send('Emulation.setDeviceMetricsOverride',
        { width: w, height: 900, deviceScaleFactor: 1, mobile: !!mobile });
      await new Promise(r => setTimeout(r, 250));
    };

    const WIDTHS = [1600, 1280, 1024, 900, 768, 600, 414, 390, 360];

    console.log('\nit holds together at every width it is read at');
    const bad = [];
    for (const w of WIDTHS) {
      await at(w, w < 768);
      await goto(BASE + '/private-clients.html');
      const r = await evaluate(`(() => {
        const d = document.documentElement;
        /* Anything that leaves the viewport sideways. Fixed elements and the
           honeypot are parked off-screen on purpose. */
        const out = [...document.querySelectorAll('body *')].filter(e => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && (b.right > d.clientWidth + 1 || b.left < -1)
                 && getComputedStyle(e).position !== 'fixed' && !e.closest('.pc-hp');
        }).map(e => e.className || e.tagName);
        /* A field wider than the grid track holding it: the content-box
           default plus width:100% plus padding, which overlaps the columns. */
        const spill = [...document.querySelectorAll('.pc-field')].map(f => {
          const i = f.querySelector('input,select,textarea');
          return i ? Math.round(i.getBoundingClientRect().width - f.getBoundingClientRect().width) : 0;
        });
        const wrap = document.querySelector('.pc-wrap').getBoundingClientRect();
        return { side: d.scrollWidth - d.clientWidth,
                 out: [...new Set(out)].slice(0, 4),
                 spill: Math.max(0, ...spill),
                 gutter: Math.round(wrap.left + parseFloat(getComputedStyle(
                   document.querySelector('.pc-wrap')).paddingLeft)) };
      })()`);
      if (r.side || r.out.length || r.spill > 0 || r.gutter < 16) bad.push({ w, ...r });
    }
    ok('nothing scrolls sideways and nothing spills its column',
       bad.length === 0, JSON.stringify(bad.slice(0, 3)));

    console.log('\nthe things a stylesheet gets wrong quietly');
    await at(1280);
    await goto(BASE + '/private-clients.html');

    const ghost = await evaluate(`(() => {
      const b = document.querySelector('.pc-hero .pc-btn--ghost');
      return { fg: getComputedStyle(b).color,
               bg: getComputedStyle(document.querySelector('.pc-hero')).backgroundColor };
    })()`);
    ok('the hero’s outline button can actually be read on the hero',
       contrast(parse(ghost.fg), parse(ghost.bg)) >= 4.5,
       `${ghost.fg} on ${ghost.bg} — ${contrast(parse(ghost.fg), parse(ghost.bg)).toFixed(2)}:1. ` +
       'a generic link colour outranking the button rule paints it in the ground it sits on');

    /* The heading is the reference, not a width: the paragraph is capped at
       a readable measure on purpose, so "wide enough" says nothing. What the
       bug did was put the paragraph in the counter track — left offset 0 and
       62px wide, one word a line — while the heading sat correctly in column
       two. So: the two start in the same column, and the prose is not a
       sliver. */
    const steps = await evaluate(`(() => {
      const li = document.querySelector('.pc-steps li');
      const base = li.getBoundingClientRect().left;
      const h = li.querySelector('h3').getBoundingClientRect();
      const p = li.querySelector('p').getBoundingClientRect();
      return { hL: Math.round(h.left - base), pL: Math.round(p.left - base),
               pW: Math.round(p.width) };
    })()`);
    ok('a step’s prose sits beside its number, not under it in the counter track',
       steps.pL === steps.hL && steps.pL >= 60 && steps.pW > 250, JSON.stringify(steps),
       'grid auto-placement wraps it back into the 62px counter column');

    const bands = await evaluate(`(() => {
      const d = document.documentElement;
      const r = s => { const e = document.querySelector(s); const b = e.getBoundingClientRect();
                       return { l: Math.round(b.left), w: Math.round(b.width) }; };
      return { vw: d.clientWidth, hero: r('.pc-hero'), legal: r('.pc-legal') };
    })()`);
    ok('the full-bleed bands reach both edges',
       bands.hero.l === 0 && bands.hero.w === bands.vw
       && bands.legal.l === 0 && bands.legal.w === bands.vw,
       JSON.stringify(bands) + ' — the body’s default 8px margin frames them in white');

    console.log('\nand the figures are said only when there are figures');
    const before = await evaluate(`getComputedStyle(document.getElementById('returned')).display`);
    ok('the section is hidden with no API behind the page', before === 'none', before);
    await evaluate(`document.dispatchEvent(new CustomEvent('svc:track-record',
      { detail: { paid: 1234567, concluded: 1, strategies: 1, perFamily: {} } }))`);
    await new Promise(r => setTimeout(r, 300));
    const after = await evaluate(`(() => ({
      display: getComputedStyle(document.getElementById('returned')).display,
      text: document.getElementById('recordLine').textContent,
    }))()`);
    ok('and shown once something has concluded', after.display !== 'none', after.display);
    ok('with the grammar following the number',
       /\b1 cattle pool that has run its full term\b/.test(after.text), after.text);
    ok('and the amount formatted as rands', /R1\s?234\s?567/.test(after.text.replace(/ /g, ' ')),
       after.text);

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
