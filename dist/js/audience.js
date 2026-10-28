'use strict';
/* Who is reading this, and where should they be?
 *
 * The homepage is written for a retail investor. Somebody placing a family
 * allocation or allocating for an institution reads the same page — start
 * small, top up a wallet, earn XP — and concludes we are not for them before
 * they reach a word about what we actually finance. There is a page written
 * for them; this asks the one question that gets them to it.
 *
 * The rules it keeps, each of which is a way this pattern usually goes wrong:
 *
 *  · IT IS NOT A GATE. The markup is built here, in script, so a crawler and
 *    a reader with no JavaScript get the homepage exactly as it was. Nothing
 *    is hidden behind the answer and every route out of it leads somewhere.
 *  · IT ASKS ONCE. The answer is remembered, so a returning reader is not
 *    interrogated on the doorstep every visit. Dismissing counts as an
 *    answer — somebody who closes it has told you they want the page they
 *    are on.
 *  · IT NEVER REDIRECTS BY ITSELF. A remembered answer suppresses the
 *    question; it does not move anybody. A returning institutional reader
 *    who typed the homepage in wants the homepage, and the menu carries the
 *    other page for when they want it.
 *  · IT DOES NOT INTERRUPT SOMEBODY MID-ERRAND. Arriving on a deep link, a
 *    hash, or from the institutional page itself is an intent already
 *    declared, and the question is not asked.
 *
 * Storage can throw — private windows, blocked site data — so every read and
 * write is guarded and the page works the same when it comes back empty.
 */

(function () {
  const KEY = 'svc_audience';
  const LAST_ASKED = 'svc_audience_asked_at';

  const read = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

  /* The three ways somebody arrives, in their own words rather than ours.
     "Retail" is a word the industry uses about people, not one they use
     about themselves, so it does not appear on screen. */
  const CHOICES = [
    {
      id: 'retail',
      title: 'I’m investing my own money',
      body: 'Browse the products, run the numbers and open an account online.',
      action: 'Stay here',
      href: null,
    },
    {
      id: 'private',
      title: 'I’m placing a larger personal or family allocation',
      body: 'What the capital finances, in what order things happen, and terms set in conversation. From R1 million, for a minimum of 18 months.',
      action: 'Private clients',
      href: 'private-clients.html?as=individual',
    },
    {
      id: 'institution',
      title: 'I allocate for an institution, or advise clients',
      body: 'How each pool is structured and reported, who holds the licence, and what has actually been returned.',
      action: 'Institutional',
      href: 'institutional.html?as=institution',
    },
  ];

  function shouldAsk() {
    if (read(KEY)) return false;                       // already answered
    const url = new URL(window.location.href);
    if (url.hash && url.hash !== '#') return false;    // arrived at a section
    if (url.searchParams.has('as')) return false;      // already declared
    /* Sent back here by the other page, or arriving from it: they have seen
       the question once already. */
    if (/institutional\.html/i.test(document.referrer || '')) return false;
    return true;
  }

  function remember(id) {
    write(KEY, id);
    write(LAST_ASKED, String(Date.now()));
  }

  function build() {
    const overlay = document.createElement('div');
    overlay.className = 'aud-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'audTitle');

    const box = document.createElement('div');
    box.className = 'aud-box';

    const h = document.createElement('h2');
    h.id = 'audTitle';
    h.className = 'aud-title';
    h.textContent = 'Which of these sounds most like you?';

    const sub = document.createElement('p');
    sub.className = 'aud-sub';
    sub.textContent = 'So we show you the right thing. You can change it any time from the menu.';

    box.appendChild(h);
    box.appendChild(sub);

    for (const c of CHOICES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'aud-choice';

      const t = document.createElement('span');
      t.className = 'aud-choice__title';
      t.textContent = c.title;

      const b = document.createElement('span');
      b.className = 'aud-choice__body';
      b.textContent = c.body;

      const a = document.createElement('span');
      a.className = 'aud-choice__action';
      a.textContent = c.action;

      btn.appendChild(t); btn.appendChild(b); btn.appendChild(a);
      btn.addEventListener('click', () => {
        remember(c.id);
        if (c.href) window.location.href = c.href;
        else close();
      });
      box.appendChild(btn);
    }

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'aud-skip';
    skip.textContent = 'Just looking, thanks';
    /* Dismissing IS an answer: it says "the page I am on is the one I want".
       Storing it is what stops the question being asked again tomorrow. */
    skip.addEventListener('click', () => { remember('retail'); close(); });
    box.appendChild(skip);

    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) { remember('retail'); close(); } });
    return overlay;
  }

  let node = null, lastFocus = null;

  function close() {
    if (!node) return;
    node.classList.remove('aud-open');
    document.body.style.overflow = '';
    const el = node;
    setTimeout(() => { el.remove(); }, 200);
    node = null;
    document.removeEventListener('keydown', onKey);
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (_) {} }
  }

  function onKey(e) {
    if (e.key === 'Escape' && node) { remember('retail'); close(); }
  }

  function ask() {
    if (!shouldAsk()) return;
    lastFocus = document.activeElement;
    node = build();
    document.body.appendChild(node);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => node.classList.add('aud-open'));
    const first = node.querySelector('.aud-choice');
    if (first) first.focus();
    document.addEventListener('keydown', onKey);
  }

  /* Exposed so the menu can offer it again — changing your mind is not a
     thing anybody should have to clear site data to do. */
  window.svcAskAudience = function () {
    try { localStorage.removeItem(KEY); } catch (_) {}
    if (!node) ask();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ask);
  } else {
    ask();
  }
})();
