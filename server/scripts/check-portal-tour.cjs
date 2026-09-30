#!/usr/bin/env node
/* The guided tour points at things that are actually there.
 *
 * The tour is nine coach-marks over the portal, and the only thing holding it
 * to the interface is a CSS selector per step. Nothing enforced that the
 * selector matched, and when it did not the code did the polite thing:
 *
 *     const el = document.querySelector(step.target);
 *     if (!el) { isMobile ? _mobileTooltip(null) : _centerTooltip(); return; }
 *
 * — a centred tooltip and no spotlight. So a step describing a menu item
 * while highlighting nothing looks like a design choice, not a fault, and the
 * tour had drifted that way twice over:
 *
 *   · the sidebar folded Maturity, Learning Hub and Earn Rewards into a
 *     "More" group that is display:none until opened, so those three steps
 *     measured zero and spotlit nothing;
 *   · several data-view selectors match twice — once in the desktop sidebar,
 *     once in the phone bottom bar — and querySelector takes the first in
 *     document order, which on a phone is the hidden one.
 *
 * And the words had drifted from the labels: "Browse Investment Pools" for a
 * menu item called Invest, "Maturity Instructions" for one called When
 * Investment Ends, and a list of maturity options that included transferring
 * to a bank account, which is not one of them — a payout lands in the wallet
 * and is withdrawn from there.
 *
 * This reads the real portal HTML, so a step can only pass by pointing at
 * markup that exists.
 *
 * No database.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-portal-tour-secret';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const HTML   = read('portal/index.html');
const WEB    = read('portal/js/portal.js');
const MOBILE = read('mobile/src/js/portal.js');
const CORE   = read('js/portal-core.js');

/* The steps, taken from the source rather than re-typed here. */
function steps(src) {
  const start = src.indexOf('const TOUR_STEPS = [');
  const end   = src.indexOf('\n];', start);
  if (start < 0 || end < 0) return null;
  // eslint-disable-next-line no-eval
  return eval(src.slice(start + 'const TOUR_STEPS = '.length, end + 2));
}
const STEPS = steps(WEB);

/* Where the sidebar hides its less-used items. Everything between the opening
   tag of #navMoreSection and the </div> that closes it. */
const MORE = (() => {
  const i = HTML.indexOf('id="navMoreSection"');
  if (i < 0) return '';
  const from = HTML.lastIndexOf('<div', i);
  return HTML.slice(from, HTML.indexOf('</div>', HTML.indexOf('<!-- More toggle -->') > 0 ? i : i) + 6000);
})();

/* A crude but honest stand-in for querySelectorAll: how many times the
   selector's distinguishing text appears in the page. */
const occurrences = (hay, needle) => hay.split(needle).length - 1;
const selectorText = sel =>
  sel.startsWith('#') ? `id="${sel.slice(1)}"`
  : sel.startsWith('.') ? `class="${sel.slice(1)}`
  : sel.replace(/^\[|\]$/g, '');

console.log('\nthe steps are still a list of steps');
{
  ok('TOUR_STEPS parses out of the web portal', Array.isArray(STEPS) && STEPS.length > 0);
  ok('and the mobile copy is byte-identical',
     WEB.slice(WEB.indexOf('const TOUR_STEPS = ['), WEB.indexOf('\n];', WEB.indexOf('const TOUR_STEPS = [')))
     === MOBILE.slice(MOBILE.indexOf('const TOUR_STEPS = ['), MOBILE.indexOf('\n];', MOBILE.indexOf('const TOUR_STEPS = ['))),
     'the two surfaces must tell the same story');
  ok('it opens and closes on a centred card',
     STEPS[0].type === 'center' && STEPS[STEPS.length - 1].type === 'center');
  ok('every step has a title and a body',
     STEPS.every(s => s.title && s.body));
  ok('every step has an icon', STEPS.every(s => /^fa-/.test(s.icon || '')));
}

console.log('\nevery step points at markup that exists');
{
  for (const s of STEPS.filter(s => s.target)) {
    const text = selectorText(s.target);
    ok(`${s.id} → ${s.target}`, occurrences(HTML, text) > 0,
       'the spotlight silently falls back to a centred card when it matches nothing');
  }
}

console.log('\nand a step behind the More fold says to open it');
{
  const hidden = ['maturity', 'quests', 'learn'];
  for (const view of hidden) {
    ok(`the sidebar still keeps ${view} inside the More group`,
       MORE.includes(`data-view="${view}"`),
       'if it has been promoted, drop the reveal from its step');
  }
  for (const s of STEPS.filter(s => s.target && /data-view="(maturity|quests|learn)"/.test(s.target))) {
    ok(`${s.id} carries reveal: navMore`, s.reveal === 'navMore',
       'without it the step describes a menu item the client cannot see');
  }
  ok('and the tour knows how to act on that',
     /step\.reveal === 'navMore'/.test(CORE) && /toggleNavMore\(\)/.test(CORE));
}

console.log('\nthe spotlight lands on the copy the client can see');
{
  ok('the target is resolved through _tourEl, not querySelector',
     !/const el = document\.querySelector\(step\.target\)/.test(CORE),
     'querySelector returns the first match, which on a phone is the hidden sidebar');
  ok('both the scroll and the positioning use it',
     (CORE.match(/_tourEl\(step\)/g) || []).length >= 2);
  ok('it tests for being on screen, not merely laid out',
     /function _tourOnScreen\(el\)[\s\S]*?r\.top < window\.innerHeight && r\.left < window\.innerWidth/.test(CORE),
     'a phone keeps the sidebar off-canvas, where it still measures 260x44');
  ok('and _tourEl picks by that test',
     /function _tourEl\(step\)[\s\S]*?all\.find\(_tourOnScreen\)/.test(CORE));
  ok('when nothing is on screen it opens the sidebar the item lives in',
     /function _tourEl\(step\)[\s\S]*?sidebar\.contains\(el\)[\s\S]*?toggleSidebar\(\)/.test(CORE),
     'My Investments and everything under More exist only in the sidebar');
  ok('and the tour puts the sidebar back when it ends',
     /function _endTour\(completed\)[\s\S]*?closeSidebar\(\)/.test(CORE));
  ok('and still returns something when none are on screen',
     /function _tourEl\(step\)[\s\S]*?return hit \|\| all\[0\] \|\| null/.test(CORE));

  /* Revealing something slides it in, and scrollIntoView is smooth, so a
     position taken once is a position the target is still moving away from. */
  ok('the spotlight follows its target while the tour is up',
     /window\.addEventListener\('scroll', _tourTrack, true\)/.test(CORE)
     && /window\.addEventListener\('resize', _tourTrack\)/.test(CORE));
  ok('and lets go of it afterwards',
     /window\.removeEventListener\('scroll', _tourTrack, true\)/.test(CORE)
     && /window\.removeEventListener\('resize', _tourTrack\)/.test(CORE),
     'a listener repositioning a hidden overlay on every scroll is a leak');
  ok('the tracking is throttled to a frame',
     /function _tourTrack\(\)[\s\S]*?_tourTrack\.pending[\s\S]*?requestAnimationFrame/.test(CORE));
  ok('and it stops as soon as the tour is not active',
     /function _tourTrack\(\)[\s\S]*?if \(!_tourActive\) return;/.test(CORE));
  ok('a late repositioning pass cannot land on the wrong step',
     /if \(_tourActive && _tourStep === idx\) _positionTour\(step\);/.test(CORE));

  /* The selectors that match in both navs are the reason _tourEl exists. */
  for (const view of ['wallet', 'marketplace']) {
    ok(`data-view="${view}" really does appear in both navs`,
       occurrences(HTML, `data-view="${view}"`) >= 2);
  }
}

console.log('\nthe words match the menu');
{
  /* The visible text of the sidebar button, with the icon and the badge
     stripped — what a client reading the menu sees. */
  const label = view => {
    const i = HTML.indexOf(`data-view="${view}"`);
    if (i < 0) return '';
    const open  = HTML.indexOf('>', i) + 1;
    const close = HTML.indexOf('</button>', open);
    return HTML.slice(open, close)
      .replace(/<span class="[a-z-]*badge"[\s\S]*?<\/span>/g, '')
      .replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  };
  const byId = id => STEPS.find(s => s.id === id);
  for (const [id, view] of [['nav_wallet', 'wallet'], ['nav_marketplace', 'marketplace'],
                            ['nav_investments', 'investments'], ['nav_maturity', 'maturity'],
                            ['nav_quests', 'quests'], ['nav_learn', 'learn']]) {
    const s = byId(id);
    ok(`${id} is titled the way the menu names it — "${label(view)}"`,
       !!s && label(view).toLowerCase().includes(s.title.toLowerCase()),
       s ? `step says "${s.title}"` : 'step missing');
  }
}

console.log('\nand say true things about the platform');
{
  const byId = id => STEPS.find(s => s.id === id) || {};
  const wallet = byId('nav_wallet').body || '';
  ok('the wallet step names the account the money actually goes to',
     /Smartvest Financial Services/i.test(wallet),
     'a client paying by EFT sees that name on their statement, not SV Capital');
  ok('and says why it is not SV Capital',
     /SV Capital/.test(wallet) && /FSP/i.test(wallet));
  ok('and tells them to use their Investor ID as the reference',
     /Investor ID/.test(wallet));
  ok('the EFT panel really is in that name',
     /Account Name<\/span><span class="info-row__value">Smartvest Financial Services</.test(HTML),
     'the step would otherwise be quoting a name the screen does not show');

  const invest = byId('nav_marketplace').body || '';
  ok('the invest step says the fee is charged on top', /on top of it/.test(invest));

  const mat = byId('nav_maturity').body || '';
  ok('the maturity step no longer offers a transfer to a bank account',
     !/bank account/i.test(mat) || /withdraw/i.test(mat),
     'a payout lands in the wallet; withdrawing is a separate step');
  ok('and it lists instructions the screen actually offers',
     /roll it over/i.test(mat) && /switch/i.test(mat) && /only the returns/i.test(mat));
  for (const opt of ['payout_all', 'payout_return', 'reinvest', 'switch_product']) {
    ok(`the portal still offers ${opt}`, CORE.includes(`value="${opt}"`));
  }

  const quests = byId('nav_quests').body || '';
  const LEVELS = require(path.join(ROOT, 'server', 'routes', 'quests.js')).XP_LEVELS;
  ok(`the rewards step counts the levels right (${LEVELS.length})`,
     quests.includes(`${LEVELS.length} levels`), quests);
  ok('and names the first and last of them',
     quests.includes(LEVELS[0].label) && quests.includes(LEVELS[LEVELS.length - 1].label));
}

console.log('\nthe success message reports what was invested, not what was spent');
{
  /* R500 into a R500 pool costs R505 out of the wallet. The web portal put
     the R505 in the sentence that says "invested", so the fee was counted as
     capital in the one message the client actually reads. */
  for (const [name, src, amt, total] of [['web', WEB, 'poolAmount', 'walletSpend'],
                                         ['mobile', MOBILE, 'amount', 'totalDeducted']]) {
    const line = (src.match(/Toast\.success\(`Invested[^`]*`\)/) || [''])[0];
    ok(`${name}: the amount invested is the pool amount`,
       line.includes(`Utils.rand(${amt})} in `), line || 'no such message');
    ok(`${name}: the fee is named separately`, /platform fee of \$\{Utils\.rand\(/.test(line));
    ok(`${name}: and the wallet total is named too`,
       line.includes(`\${Utils.rand(${total})} left your wallet`), line);
    ok(`${name}: the old wording is gone`, !/Successfully invested/.test(src));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
