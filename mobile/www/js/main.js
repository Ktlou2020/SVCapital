/* ═══════════════════════════════════════════════
   SV CAPITAL — Main JavaScript
   ═══════════════════════════════════════════════ */

'use strict';

/* ─── Investment Products Data ─── */
const PRODUCTS = {
  cattle: {
    name: 'Cattle Investment',
    rate: 0.1483,
    minInvest: 500,
    term: 12,
    termUnit: 'months',
    termYears: 1,
    icon: 'fa-cow',
    color: '#fec24f',
    partner: 'Beefcor',
    infoItems: [
      { label: 'Partner', value: 'Beefcor Feedlot' },
      { label: 'Benchmark', value: '13.00% p.a.' },
      { label: 'Perf. Fee', value: '20% above benchmark' },
      { label: 'Pool Type', value: 'Time-based pool' },
      { label: 'Sector', value: 'Agriculture' },
    ]
  },
  solar7: {
    name: 'Solar Investment (7yr)',
    rate: 0.2140,
    minInvest: 10000,
    term: 84,
    termUnit: 'months',
    termYears: 7,
    icon: 'fa-solar-panel',
    color: '#4CAF50',
    partner: 'The Solar Experts',
    infoItems: [
      { label: 'Partner', value: 'The Solar Experts' },
      { label: 'Benchmark', value: '13.00% p.a.' },
      { label: 'Perf. Fee', value: 'N/A' },
      { label: 'Pool Type', value: 'Time-based pool' },
      { label: 'Sector', value: 'Renewable Energy' },
    ]
  },
  solar5: {
    name: 'Solar Investment (5yr)',
    rate: 0.0641,
    minInvest: 10000,
    term: 60,
    termUnit: 'months',
    termYears: 5,
    icon: 'fa-solar-panel',
    color: '#4CAF50',
    partner: 'The Solar Experts',
    infoItems: [
      { label: 'Partner', value: 'The Solar Experts' },
      { label: 'Benchmark', value: '13.00% p.a.' },
      { label: 'Perf. Fee', value: 'N/A' },
      { label: 'Pool Type', value: 'Time-based pool' },
      { label: 'Sector', value: 'Renewable Energy' },
    ]
  },
  short: {
    name: 'Short-Term Investment',
    rate: 0.1392,
    minInvest: 1000,
    term: 5,
    termUnit: 'months',
    termYears: 5/12,
    icon: 'fa-bolt',
    color: '#656565',
    partner: 'MoolaLend',
    infoItems: [
      { label: 'Partner', value: 'MoolaLend Pty Ltd' },
      { label: 'Benchmark', value: '12.00% p.a.' },
      { label: 'Perf. Fee', value: 'N/A' },
      { label: 'Pool Type', value: 'Time-based pool' },
      { label: 'Sector', value: 'SMME Finance' },
    ]
  },
  delivery: {
    name: 'Delivery Bike Investment',
    rate: 0.1205,
    minInvest: 3100,
    term: 18,
    termUnit: 'months',
    termYears: 1.5,
    icon: 'fa-motorcycle',
    color: '#f97316',
    partner: 'OnFleet',
    infoItems: [
      { label: 'Partner', value: 'OnFleet Pty Ltd' },
      { label: 'Benchmark', value: 'N/A' },
      { label: 'Perf. Fee', value: 'N/A' },
      { label: 'Pool Type', value: 'Targeted amount' },
      { label: 'Sector', value: 'Last-Mile Delivery' },
    ]
  }
};

/* ─── Partner info profiles ─── */
const _pipEsc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const _pipSafeUrl = u => (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u : '#';
const PARTNER_PROFILES = {
  'Beefcor': {
    tagline: 'Producers of quality cattle since 1973',
    profile: 'Beefcor is a vertically integrated South African cattle feedlot founded in 1973, marketing over 70,000 cattle per year. They manage the full value chain from livestock procurement to branded beef in retail stores. Beefcor hosts SA\'s first commercially viable biogas plant at their Bronkhorstspruit facility.',
    website: 'https://www.beefcor.com',
    youtubeId: 'mTIcSDeggtQ',
  },
  'MoolaLend': {
    tagline: 'Your chomie in funding — SA\'s PO finance specialist',
    profile: 'MoolaLend is a Bryanston-based boutique lender that specialises in Purchase Order (PO) finance for South African SMEs. They fund government tenders and private-sector purchase orders from R50,000, enabling businesses to fulfil contracts without upfront capital. Incorporated in 2021 and listed in FundingHub\'s Top 10 PO Funding Lenders in SA, MoolaLend takes a partner-first approach to SME lending.',
    website: 'https://moolalend-production.up.railway.app/',
  },
  'The Solar Experts': {
    tagline: 'Cape Town\'s trusted solar design & installation specialists',
    profile: 'The Solar Experts is a Somerset West-based solar energy company with over 612 completed installations across the Western Cape since 2019. They serve residential and commercial clients with systems from 5 kW to 250 kW, handled entirely by in-house electrical staff.',
    website: 'https://thesolarexperts.co.za',
  },
  'OnFleet': {
    tagline: 'Rent to Own. Ride. Earn. Own.',
    profile: 'OnFleet Africa runs South Africa\'s leading rent-to-own delivery motorcycle programme. Riders with no deposit access a bike for R650–R850/week and own it outright after 18 months — with free monthly servicing included. Around 60% of riders re-enter a new contract at the 18-month mark, renting out their first bike for additional income.',
    website: 'https://portal.onfleet.africa',
  },
};

function _showPartnerModal(name) {
  const p = PARTNER_PROFILES[name];
  if (!p) return;
  document.getElementById('pip-modal')?.remove();
  const vid = p.youtubeId ? `<a href="https://www.youtube.com/watch?v=${p.youtubeId}" target="_blank" rel="noopener" style="display:block;position:relative;border-radius:10px;overflow:hidden;margin-bottom:14px;text-decoration:none"><img src="https://img.youtube.com/vi/${p.youtubeId}/mqdefault.jpg" style="width:100%;display:block" loading="lazy"><span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4)"><i class="fa-solid fa-play" style="font-size:2rem;color:#fff"></i></span></a>` : '';
  const el = document.createElement('div');
  el.id = 'pip-modal';
  el.innerHTML = `<div id="pip-modal-bd" style="position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:99998;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(6px)"><div style="background:#1c1c1e;border:1px solid rgba(255,255,255,.15);border-radius:18px;padding:24px 22px;max-width:360px;width:100%;position:relative;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.8)"><button onclick="document.getElementById('pip-modal').remove()" style="position:absolute;top:14px;right:14px;background:rgba(255,255,255,.1);border:none;border-radius:50%;width:30px;height:30px;cursor:pointer;color:rgba(255,255,255,.8);display:flex;align-items:center;justify-content:center;font-size:.9rem;line-height:1"><i class="fa-solid fa-xmark"></i></button><div style="font-weight:700;font-size:1.05rem;color:#fff;margin-bottom:3px;padding-right:36px">${_pipEsc(name)}</div><div style="font-size:.75rem;color:#eda5ff;margin-bottom:14px;line-height:1.45">${_pipEsc(p.tagline)}</div>${vid}<p style="font-size:.8rem;color:rgba(255,255,255,.8);line-height:1.65;margin:0 0 16px">${_pipEsc(p.profile)}</p><a href="${_pipSafeUrl(p.website)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:7px;font-size:.8rem;color:#eda5ff;text-decoration:none;border:1px solid rgba(237,165,255,.3);border-radius:20px;padding:7px 16px"><i class="fa-solid fa-arrow-up-right-from-square"></i> Visit website</a></div></div>`;
  document.body.appendChild(el);
  document.getElementById('pip-modal-bd').addEventListener('click', e => { if (e.target === e.currentTarget) el.remove(); });
  const _onKey = e => { if (e.key === 'Escape') { el.remove(); document.removeEventListener('keydown', _onKey); } };
  document.addEventListener('keydown', _onKey);
}

function _partnerInfoBtn(name) {
  if (!PARTNER_PROFILES[name]) return '';
  return `<button type="button" onclick="_showPartnerModal('${_pipEsc(name)}')" aria-label="About ${_pipEsc(name)}" style="background:none;border:none;cursor:pointer;padding:0 4px;color:inherit;opacity:.55;font-size:.85em;vertical-align:middle;line-height:1;transition:color .15s,opacity .15s" onmouseenter="this.style.color='#eda5ff';this.style.opacity='1'" onmouseleave="this.style.color='';this.style.opacity='.55'"><i class="fa-solid fa-circle-info"></i></button>`;
}

function _partnerNameLink(name, display) {
  if (!PARTNER_PROFILES[name]) return _pipEsc(display || name);
  return `<span onclick="_showPartnerModal('${_pipEsc(name)}')" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px" onmouseenter="this.style.color='#eda5ff'" onmouseleave="this.style.color=''">${_pipEsc(display || name)}</span>`;
}

/* ─── FAQ Data ─── */
const FAQ_DATA = {
  general: [
    {
      q: 'Who owns and runs SV Capital?',
      a: 'SV Capital is a South African alternative investment platform founded by experienced finance professionals with deep expertise in chartered accounting and financial strategy. Our mission is simple: democratise access to real, asset-backed investments for every South African, from R500.'
    },
    {
      q: 'How do I get started?',
      a: 'Sign up on the SV Capital app (available on Apple App Store and Google Play), complete your FICA verification (takes under 5 minutes), fund your wallet via EFT or instant payment, and choose an open investment pool. That\'s it.'
    },
    {
      q: 'Do you have a mobile app?',
      a: 'Yes! The SV Capital app is available on both the Apple App Store and Google Play Store. It gives you real-time visibility into your portfolio, pool progress, and payout tracking — all from your phone.'
    },
    {
      q: 'Can I withdraw my funds early?',
      a: 'Early withdrawals are not permitted. Your funds are locked in until the end of the investment term. If you\'re unsure about committing, you can store funds in your wallet until you\'re ready. At maturity, you have multiple payout options including reinvest, partial payout, or full withdrawal.'
    }
  ],
  products: [
    {
      q: 'What investment products are available?',
      a: 'SV Capital currently offers four investment products: Cattle Investment (12 months, min R500), Solar Investment (5, 6, or 7-year terms, min R10,000), Short-Term Investment (5 months, min R1,000), and Delivery Bike Investment (18 months, min R3,100).'
    },
    {
      q: 'Do I own the cattle or solar panels?',
      a: 'No — you own a percentage stake in an investment pool, not the physical asset directly. For cattle, you share ownership of a herd with other investors proportional to your investment. For solar, ownership of the panels transfers to the property at end of term. This structure allows diversified, professionally managed investments from accessible minimums.'
    },
    {
      q: 'What happens when my investment matures?',
      a: 'Before 5:00 PM on the last day of your investment term, you must submit a maturity instruction via the SV Capital platform. Options are: Reinvest (same product), Switch Products (another open pool), Payout Custom (partial withdrawal + reinvest), Payout Return (only returns paid out), or Payout All (full capital + returns withdrawn). If no instruction is received, funds are automatically reinvested.'
    },
    {
      q: 'What is the cattle 99% guarantee?',
      a: 'Our partner Beefcor guarantees 99% of the cattle herd. This means if one cow in a herd of 100 dies, it\'s considered industry norm and absorbed. Any losses above 1% are reimbursed by Beefcor — a testament to their experience and confidence in their feedlot operations.'
    },
    {
      q: 'Can I switch pools after investing?',
      a: 'No — once you have invested in a pool, switching to another pool is not possible. We recommend taking your time and keeping funds in your wallet until you\'re confident about your product selection.'
    }
  ],
  compliance: [
    {
      q: 'Is SV Capital regulated?',
      a: 'Yes. All fund collections and disbursements are handled by SmartVest Financial Services, a licensed Financial Services Provider authorised by the Financial Sector Conduct Authority (FSCA), formerly known as the FSB, under FSP license number 52449.'
    },
    {
      q: 'Is my money safe?',
      a: 'SV Capital conducts rigorous due diligence on all investment partners before entering any agreements. Partners like Beefcor, The Solar Experts, MoolaLend, and OnFleet all have proven track records in their respective industries. That said, all investments carry risk and returns are not guaranteed.'
    },
    {
      q: 'What due diligence does SV Capital perform?',
      a: 'Before any partnership, SV Capital performs comprehensive due diligence including financial analysis, operational reviews, track record verification, legal compliance checks, and ongoing monitoring throughout the investment lifecycle. We only partner with companies that meet our stringent standards.'
    }
  ],
  returns: [
    {
      q: 'Are returns guaranteed?',
      a: 'No. As with all investments, returns are not guaranteed. Returns depend on the performance of the underlying assets and market conditions. SV Capital carefully selects and manages investment products to reduce risk, but we encourage all investors to understand the risks before committing capital.'
    },
    {
      q: 'How do I declare tax on my returns?',
      a: 'SV Capital does not issue tax certificates, and returns are not automatically reported to SARS. We recommend consulting a qualified tax practitioner for guidance on the correct classification of these returns in your tax submission. You can also contact SARS directly for guidance.'
    },
    {
      q: 'What is the difference between Average Return and Benchmark?',
      a: 'The Average Return shows the historical performance of the investment — what investors have actually earned on average. The Benchmark is SV Capital\'s target rate — the performance standard we aim to achieve. For cattle, if returns exceed the 13% benchmark, the excess is split 80% to investors and 20% to SV Capital (the performance fee).'
    },
    {
      q: 'How does the cattle performance fee work?',
      a: 'The performance fee applies only if returns exceed the benchmark rate of 13% p.a. At maturity (12 months), any returns above the 13% benchmark are split 80% to the investor and 20% to SV Capital. If returns are 13% or below, no performance fee is charged.'
    }
  ]
};

/* ─── Modal Content Templates ─── */
const MODAL_DATA = {
  cattle: {
    eyebrow: 'Cattle Investment',
    title: 'Grow with the herd.',
    desc: 'Partner with Beefcor, one of South Africa\'s most respected feedlots, and watch your returns grow alongside the cattle. Each investment pool funds a herd of cattle that enters at 200–230kg and is raised to 450–500kg before sale to an abattoir.',
    stats: [
      { label: 'Avg. Return', val: '14.83% p.a.' },
      { label: 'Minimum', val: 'R500' },
      { label: 'Term', val: '12 Months' }
    ],
    points: [
      'Cattle enter feedlot at 200–230kg and are raised to 450–500kg',
      'Returns are determined by weight gain and market price per kilogram',
      'Beefcor guarantees 99% cattle survival rate',
      '9 consecutive years of delivering consistent returns',
      'Supports South Africa\'s agricultural economy',
      'Performance fee: 20% on returns above 13% benchmark'
    ]
  },
  solar: {
    eyebrow: 'Solar Investment',
    title: 'Power the future. Earn from it.',
    desc: 'Your capital funds solar panel installations across Cape Town, generating clean electricity sold through long-term contracts. Annual returns are distributed throughout the term, with your full capital returned at the end.',
    stats: [
      { label: 'Best Return', val: '21.40% p.a.' },
      { label: 'Minimum', val: 'R10,000' },
      { label: 'Terms', val: '5 / 6 / 7 yrs' }
    ],
    points: [
      'Partner: The Solar Experts, based in Cape Town',
      'Three term options: 5yr (6.41%), 6yr (15.53%), 7yr (21.40% p.a.)',
      'Annual returns distributed every 12 months',
      'Full capital returned at end of term',
      'You do not own the panels — they transfer to the property at term end',
      'Contributes to South Africa\'s renewable energy transition'
    ]
  },
  short: {
    eyebrow: 'Short-Term Investment',
    title: 'Fast capital. Real returns.',
    desc: 'A 5-month investment vehicle that funds SMME purchase order finance through MoolaLend. Quick turnaround, strong annualised returns, and direct impact on South African small businesses.',
    stats: [
      { label: 'Avg. Return', val: '13.92% p.a.' },
      { label: 'Minimum', val: 'R1,000' },
      { label: 'Term', val: '5 Months' }
    ],
    points: [
      'Powered by MoolaLend Pty Ltd, SMME finance specialists',
      'Funds purchase order finance for South African small businesses',
      'Annualised return: 13.92% — pro-rated to 5 months',
      'Rigorous due diligence on each financed project',
      'Supports job creation in the SMME sector',
      'Auto-reinvest option available at maturity'
    ]
  },
  delivery: {
    eyebrow: 'Delivery Bike Investment',
    title: 'Ride the delivery revolution.',
    desc: 'Invest in a fleet of delivery bikes leased to qualified riders operating on Mr D, Takealot, and UberEats. Weekly rental payments generate your returns as South Africa\'s last-mile delivery economy booms.',
    stats: [
      { label: 'Avg. Return', val: '12.05% p.a.' },
      { label: 'Minimum', val: 'R3,100' },
      { label: 'Term', val: '18 Months' }
    ],
    points: [
      'Partner: OnFleet Pty Ltd, delivery fleet management',
      'Bikes leased to qualified riders on Mr D, Takealot & UberEats',
      'Weekly rental payments from riders',
      'Minimum fleet of 5 bikes per pool for risk diversification',
      'Targeted amount pool structure (not time-based)',
      'Creates income opportunities for gig economy workers'
    ]
  }
};

/* ═══════════════════════════════════════════════
   INITIALISATION
   ═══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initNavbar();
  initDeferredVisuals();
  initFAQ();
  initScrollAnimations();
  initMobileNav();
  initCountUps();
});

/* ═══════════════════════════════════════════════
   NAVBAR
   ═══════════════════════════════════════════════ */
function initNavbar() {
  const navbar = document.getElementById('navbar');
  const scrollThreshold = 60;

  const handleScroll = () => {
    if (window.scrollY > scrollThreshold) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
  };

  window.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();
}

/* ═══════════════════════════════════════════════
   MOBILE NAV
   ═══════════════════════════════════════════════ */
function initMobileNav() {
  const toggle = document.getElementById('mobileToggle');
  const navLinks = document.getElementById('navLinks');
  const overlay = document.getElementById('navOverlay');

  if (!toggle || !navLinks) return;

  const closeMenu = () => {
    navLinks.classList.remove('open');
    document.body.classList.remove('no-scroll');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
  };

  const openMenu = () => {
    navLinks.classList.add('open');
    document.body.classList.add('no-scroll');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close menu');
    const firstLink = navLinks.querySelector('a');
    setTimeout(() => firstLink?.focus(), 30);
  };

  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'navLinks');

  toggle.addEventListener('click', () => {
    if (navLinks.classList.contains('open')) closeMenu();
    else openMenu();
  });

  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', closeMenu);
  });

  overlay?.addEventListener('click', closeMenu);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && navLinks.classList.contains('open')) closeMenu();
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) closeMenu();
  });
}

function initDeferredVisuals() {
  const runHeroChart = () => {
    if (document.getElementById('heroChart')) initHeroChart();
  };

  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(runHeroChart, { timeout: 1200 });
  } else {
    setTimeout(runHeroChart, 120);
  }

  const calcSection = document.getElementById('calculator');
  let calculatorReady = false;
  const runCalculator = () => {
    if (calculatorReady) return;
    calculatorReady = true;
    initCalculator();
  };

  if (calcSection && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          runCalculator();
          observer.disconnect();
        }
      });
    }, { rootMargin: '160px 0px' });

    observer.observe(calcSection);
  } else {
    runCalculator();
  }
}

/* ═══════════════════════════════════════════════
   HERO CHART
   ═══════════════════════════════════════════════ */
function initHeroChart() {
  const canvas = document.getElementById('heroChart');
  if (!canvas || typeof Chart === 'undefined') return;

  // Generate a nice upward-trending portfolio line
  const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const baseValue = 100000;
  const data = labels.map((_, i) => {
    const growth = baseValue * Math.pow(1 + 0.1483/12, i);
    const noise = (Math.random() - 0.4) * 800;
    return Math.round(growth + noise);
  });

  new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: '#fec24f',
        borderWidth: 2,
        fill: true,
        backgroundColor: (ctx) => {
          const gradient = ctx.chart.ctx.createLinearGradient(0, 0, 0, 80);
          gradient.addColorStop(0, 'rgba(254,194,79,0.25)');
          gradient.addColorStop(1, 'rgba(254,194,79,0)');
          return gradient;
        },
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 0,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false }
      },
      animation: {
        duration: 2000,
        easing: 'easeInOutQuart'
      }
    }
  });
}

/* ═══════════════════════════════════════════════
   INVESTMENT CALCULATOR
   ═══════════════════════════════════════════════ */
let calcChart = null;
let currentCalcProduct = 'cattle';

function initCalculator() {
  const tabs = document.querySelectorAll('.calc-tab');
  const slider = document.getElementById('calcAmountSlider');
  const amountDisplay = document.getElementById('calcAmountDisplay');

  if (!slider) return;

  // Tab switching
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentCalcProduct = tab.dataset.calc;
      updateCalculator();
    });
  });

  // Slider input
  slider.addEventListener('input', () => {
    const val = parseInt(slider.value);
    amountDisplay.textContent = formatRand(val);
    updateCalculator();
  });

  updateCalculator();
}

function updateCalculator() {
  const product = PRODUCTS[currentCalcProduct];
  const slider = document.getElementById('calcAmountSlider');
  if (!slider) return;

  let amount = parseInt(slider.value);

  // Enforce minimum
  if (amount < product.minInvest) {
    amount = product.minInvest;
    slider.value = amount;
  }

  // Update display
  document.getElementById('calcAmountDisplay').textContent = formatRand(amount);

  // Calculate returns
  const ratePerYear = product.rate;
  const years = product.termYears;
  let returnsEarned, totalPayout;

  if (currentCalcProduct === 'solar7' || currentCalcProduct === 'solar5') {
    // Solar: annual returns + capital at end
    returnsEarned = amount * ratePerYear * years;
    totalPayout = amount + returnsEarned;
  } else {
    // Others: lump sum at maturity
    returnsEarned = amount * ratePerYear * years;
    totalPayout = amount + returnsEarned;
  }

  // Update result display
  document.getElementById('calcProductName').textContent = product.name;
  document.getElementById('calcTerm').textContent =
    product.term + ' ' + product.termUnit;
  document.getElementById('calcTotal').textContent = formatRand(Math.round(totalPayout));
  document.getElementById('calcReturns').textContent = '+' + formatRand(Math.round(returnsEarned));
  document.getElementById('calcRate').textContent = (product.rate * 100).toFixed(2) + '% p.a.';

  // Info grid
  const infoGrid = document.getElementById('calcInfoGrid');
  if (infoGrid) {
    infoGrid.innerHTML = product.infoItems.map(item => `
      <div class="calc-info-item">
        <span class="calc-info-item__label">${item.label}</span>
        <span class="calc-info-item__val">${item.value}</span>
      </div>
    `).join('');
  }

  // Update slider gradient
  const sliderEl = document.getElementById('calcAmountSlider');
  const min = parseInt(sliderEl.min);
  const max = parseInt(sliderEl.max);
  const val = parseInt(sliderEl.value);
  const pct = ((val - min) / (max - min)) * 100;
  sliderEl.style.background = `linear-gradient(to right, #fec24f 0%, #fec24f ${pct}%, #243040 ${pct}%, #243040 100%)`;

  // Update chart
  updateCalcChart(amount, returnsEarned, product);
}

function updateCalcChart(amount, totalReturns, product) {
  const canvas = document.getElementById('calcChart');
  if (!canvas || typeof Chart === 'undefined') return;

  const years = Math.max(1, Math.round(product.termYears));
  const labels = [];
  const principalData = [];
  const returnsData = [];

  for (let y = 0; y <= years; y++) {
    labels.push(y === 0 ? 'Start' : `Year ${y}`);
    principalData.push(amount);
    const yearFraction = y / years;
    returnsData.push(Math.round(totalReturns * yearFraction));
  }

  const ctx = canvas.getContext('2d');

  if (calcChart) {
    calcChart.destroy();
  }

  calcChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Principal',
          data: principalData,
          backgroundColor: 'rgba(255,255,255,0.08)',
          borderColor: 'rgba(255,255,255,0.15)',
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          label: 'Returns',
          data: returnsData,
          backgroundColor: (ctx) => {
            const gradient = ctx.chart.ctx.createLinearGradient(0, 0, 0, 180);
            gradient.addColorStop(0, 'rgba(254,194,79,0.9)');
            gradient.addColorStop(1, 'rgba(254,194,79,0.3)');
            return gradient;
          },
          borderColor: '#fec24f',
          borderWidth: 1,
          borderRadius: 4,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          labels: {
            color: '#656565',
            font: { size: 11 },
            boxWidth: 12,
            boxHeight: 12,
          }
        },
        tooltip: {
          backgroundColor: 'rgba(13,17,23,0.95)',
          titleColor: '#f0f4f8',
          bodyColor: '#656565',
          borderColor: 'rgba(254,194,79,0.3)',
          borderWidth: 1,
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${formatRand(ctx.parsed.y)}`
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#656565', font: { size: 10 } }
        },
        y: {
          stacked: true,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            color: '#656565',
            font: { size: 10 },
            callback: (val) => 'R' + (val >= 1000 ? (val/1000).toFixed(0) + 'k' : val)
          }
        }
      }
    }
  });
}

/* ═══════════════════════════════════════════════
   FAQ
   ═══════════════════════════════════════════════ */
function initFAQ() {
  const cats = document.querySelectorAll('.faq-cat');
  const faqList = document.getElementById('faqList');

  if (!faqList) return;

  function renderFAQs(category) {
    const items = FAQ_DATA[category] || [];
    faqList.innerHTML = items.map((item, i) => `
      <div class="faq-item fade-up" style="animation-delay:${i * 0.05}s">
        <button class="faq-question" onclick="toggleFAQ(this)">
          <span>${item.q}</span>
          <i class="fa-solid fa-chevron-down"></i>
        </button>
        <div class="faq-answer">${item.a}</div>
      </div>
    `).join('');

    // Trigger fade-up animation
    setTimeout(() => {
      faqList.querySelectorAll('.fade-up').forEach(el => el.classList.add('visible'));
    }, 50);
  }

  cats.forEach(cat => {
    cat.addEventListener('click', () => {
      cats.forEach(c => c.classList.remove('active'));
      cat.classList.add('active');
      renderFAQs(cat.dataset.cat);
    });
  });

  renderFAQs('general');
}

window.toggleFAQ = function(btn) {
  const item = btn.closest('.faq-item');
  const wasOpen = item.classList.contains('open');

  // Close all
  document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));

  // Open clicked if it was closed
  if (!wasOpen) {
    item.classList.add('open');
  }
};

/* ═══════════════════════════════════════════════
   MODALS
   ═══════════════════════════════════════════════ */
window.openModal = function(productKey) {
  const data = MODAL_DATA[productKey];
  if (!data) return;

  const content = document.getElementById('modalContent');
  content.innerHTML = `
    <span class="modal-eyebrow">${data.eyebrow}</span>
    <h2>${data.title}</h2>
    <p>${data.desc}</p>
    <div class="modal-stats">
      ${data.stats.map(s => `
        <div class="modal-stat">
          <span class="modal-stat__label">${s.label}</span>
          <span class="modal-stat__val">${s.val}</span>
        </div>
      `).join('')}
    </div>
    ${data.herdHtml || ''}
    ${data.trackHtml || ''}
    <h4 style="color:var(--white); margin-bottom:12px; font-size:0.9rem; text-transform:uppercase; letter-spacing:0.08em;">Key Details</h4>
    <ul>
      ${data.points.map(p => `<li>${p}</li>`).join('')}
    </ul>
    <a href="https://app.svcapital.co.za/register" class="btn btn--gold btn--full" target="_blank" style="margin-top:8px;">
      Start Investing <i class="fa-solid fa-arrow-right"></i>
    </a>
    <p style="font-size:0.72rem; color:var(--text-dim); margin-top:12px; text-align:center;">
      Past performance is not a guarantee of future returns. All investments carry risk.
    </p>
  `;

  document.getElementById('modalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
};

window.closeModal = function() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.body.style.overflow = '';
};

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

/* ═══════════════════════════════════════════════
   SCROLL ANIMATIONS
   ═══════════════════════════════════════════════ */
function initScrollAnimations() {
  // Legacy fade-up classes
  const targets = [
    '.product-card',
    '.step',
    '.stat-card',
    '.award-card',
    '.compliance-item',
    '.compare-callout',
    '.app-cta',
    '.calc-controls',
    '.calc-results',
    '.sdg-badge',
  ];

  targets.forEach(selector => {
    document.querySelectorAll(selector).forEach(el => {
      if (!el.classList.contains('fade-up') && !el.dataset.reveal) {
        el.classList.add('fade-up');
      }
    });
  });

  const fadeObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const delay = entry.target.closest('.products-grid, .stats-grid, .sdg-badges')
            ? Array.from(entry.target.parentElement.children).indexOf(entry.target) * 80
            : 0;
          setTimeout(() => entry.target.classList.add('visible'), delay);
          fadeObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.08, rootMargin: '0px 0px -30px 0px' }
  );

  document.querySelectorAll('.fade-up').forEach(el => fadeObserver.observe(el));

  // Data-reveal system
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -30px 0px' }
  );

  document.querySelectorAll('[data-reveal]').forEach(el => revealObserver.observe(el));
}

/* ═══════════════════════════════════════════════
   COUNTUP ANIMATIONS
   ═══════════════════════════════════════════════ */
function initCountUps() {
  const countTargets = [
    { id: 'stat1', end: 3000, suffix: '+' },
    { id: 'stat2', end: 200, suffix: 'M+' },
    { id: 'stat3', end: 700, suffix: '+' },
    { id: 'stat4', end: 30, suffix: 'M+' },
    { id: 'stat5', end: 9, suffix: '' },
  ];

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const target = countTargets.find(t => t.id === entry.target.id);
          if (!target) return;

          // CountUp library check (handles both module and global patterns)
          const CU = (typeof CountUp !== 'undefined' && CountUp.CountUp)
            ? CountUp.CountUp
            : (typeof CountUp !== 'undefined' ? CountUp : null);

          if (CU) {
            try {
              const cu = new CU(entry.target, target.end, {
                duration: 2.5,
                useEasing: true,
                separator: ',',
              });
              if (!cu.error) cu.start();
            } catch(e) {
              // Fallback: just set the number
              entry.target.textContent = target.end.toLocaleString('en-ZA');
            }
          } else {
            entry.target.textContent = target.end.toLocaleString('en-ZA');
          }

          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.5 }
  );

  countTargets.forEach(({ id }) => {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  });
}

/* ═══════════════════════════════════════════════
   UTILITY FUNCTIONS
   ═══════════════════════════════════════════════ */
function formatRand(amount) {
  return 'R' + amount.toLocaleString('en-ZA');
}

/* ─── Solar Tier Tabs ─── */
document.querySelectorAll('.tier').forEach(tier => {
  tier.addEventListener('click', function() {
    const tiers = this.closest('.product-card__tiers').querySelectorAll('.tier');
    tiers.forEach(t => t.classList.remove('tier--active'));
    this.classList.add('tier--active');
  });
});

/* ─── Active Nav Link Highlighting ─── */
function initActiveNav() {
  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('.nav-link');

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          navLinks.forEach(link => {
            link.classList.remove('active');
            if (link.getAttribute('href') === '#' + entry.target.id) {
              link.classList.add('active');
            }
          });
        }
      });
    },
    { threshold: 0.4 }
  );

  sections.forEach(section => observer.observe(section));
}

document.addEventListener('DOMContentLoaded', initActiveNav);

/* ─── Smooth anchor scroll offset for fixed nav ─── */
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function(e) {
    const target = document.querySelector(this.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    const offset = 80;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
  });
});

/* ─── Live average returns (auto-calculated from matured pools) ───────────
   Pulls the public products feed and overrides the displayed average return
   on the product cards, the detail modal, and the calculator with the real
   achieved average across each product's matured pools. Falls back silently
   to the static copy when there is no matured-pool data yet. */
async function _applyLiveProductAverages() {
  let products = [];
  try {
    const r = await fetch('/api/products');
    if (!r.ok) return;
    const d = await r.json();
    products = d.data || [];
  } catch (_) { return; }
  if (!products.length) return;

  // Populate the shared Utils cache so productInfo() returns API colors everywhere
  if (typeof Utils !== 'undefined') Utils.setProductCache(products);

  const avgByType = {}, prodByType = {};
  products.forEach(p => {
    prodByType[p.product_type] = p;
    const a = p.avg_actual_rate != null ? parseFloat(p.avg_actual_rate) : null;
    const c = parseInt(p.matured_pool_count) || 0;
    if (a != null && !isNaN(a) && c > 0) avgByType[p.product_type] = a;
  });

  // Map each home-page product key → the product_type(s) it represents.
  // `primary` is the single product whose admin-managed copy backs the modal.
  const homeMap = {
    cattle:   { types: ['cattle'], primary: 'cattle' },
    solar:    { types: ['solar_7yr', 'solar_6yr', 'solar_5yr'], primary: 'solar_7yr' },
    short:    { types: ['short_term', 'smme'], primary: 'short_term' },
    delivery: { types: ['delivery_bike'], primary: 'delivery_bike' },
  };

  const fmtR = n => 'R' + Number(n || 0).toLocaleString('en-ZA');

  const avgForHome = key => {
    const vals = (homeMap[key].types || []).map(t => avgByType[t]).filter(v => v != null);
    if (!vals.length) return null;
    if (key === 'solar') return Math.max(...vals);           // headline shows best
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };

  Object.keys(homeMap).forEach(key => {
    const rate = avgForHome(key);
    const prod = prodByType[homeMap[key].primary];

    // 1) Average return (auto-calculated) — card + modal + calculator
    if (rate != null) {
      const pct = (rate * 100).toFixed(2) + '%';
      const card = document.querySelector(`.product-card[data-product="${key}"]`);
      const goldEl = card && card.querySelector('.stat__value--gold');
      if (goldEl) goldEl.textContent = pct;
      if (typeof MODAL_DATA !== 'undefined' && MODAL_DATA[key] && Array.isArray(MODAL_DATA[key].stats)) {
        const st = MODAL_DATA[key].stats.find(s => /return/i.test(s.label));
        if (st) st.val = pct + ' p.a.';
      }
      if (typeof PRODUCTS !== 'undefined' && PRODUCTS[key]) PRODUCTS[key].rate = rate;
    }

    // 2) Apply API color to product card elements on the homepage
    const primaryType = homeMap[key].primary;
    const apiColor = prodByType[primaryType]?.color;
    if (apiColor) {
      const card = document.querySelector(`.product-card[data-product="${key}"]`);
      if (card) {
        const bg   = card.querySelector('.product-card__bg');
        const icon = card.querySelector('.product-card__icon');
        const gold = card.querySelector('.stat__value--gold');
        if (bg)   bg.style.background = `radial-gradient(circle at top right, ${apiColor}18, transparent)`;
        if (icon) icon.style.color = apiColor;
        if (gold) gold.style.color = apiColor;
      }
    }

    // 3) Admin-managed product detail copy → "View Details" modal
    if (prod && typeof MODAL_DATA !== 'undefined' && MODAL_DATA[key]) {
      const m = MODAL_DATA[key];
      if (prod.label)       m.eyebrow = prod.label.replace(/\s*\(\d+yr\)/gi, '').trim();
      if (prod.headline)    m.title   = prod.headline;
      if (prod.description) m.desc    = prod.description;
      if (prod.key_details) {
        const pts = prod.key_details.split('\n').map(s => s.trim()).filter(Boolean);
        if (pts.length) m.points = pts;
      }
      if (Array.isArray(m.stats)) {
        const minSt  = m.stats.find(s => /min/i.test(s.label));
        if (minSt && prod.min_investment != null)  minSt.val  = fmtR(prod.min_investment);
        const termSt = m.stats.find(s => /term/i.test(s.label));
        if (termSt && prod.term_months != null && key !== 'solar') termSt.val = `${prod.term_months} Months`;
      }
    }
  });

  // 3) Show/hide product cards and calculator tabs based on display_on_homepage
  const calcKeyMap = {
    cattle:   ['cattle'],
    solar:    ['solar_7yr', 'solar_6yr', 'solar_5yr'],
    short:    ['short_term', 'smme'],
    delivery: ['delivery_bike'],
  };
  const calcTabMap = {
    cattle:   'cattle',
    solar7:   'solar',
    solar5:   'solar',
    short:    'short',
    delivery: 'delivery',
  };

  const homeVisible = {};
  Object.keys(calcKeyMap).forEach(homeKey => {
    homeVisible[homeKey] = calcKeyMap[homeKey].some(t => {
      const p = prodByType[t];
      return p && p.display_on_homepage !== false;
    });
  });

  document.querySelectorAll('.product-card[data-product]').forEach(card => {
    const key = card.dataset.product;
    if (key in homeVisible) card.style.display = homeVisible[key] ? '' : 'none';
  });

  const allTabs = document.querySelectorAll('.calc-tab[data-calc]');
  allTabs.forEach(tab => {
    const homeKey = calcTabMap[tab.dataset.calc];
    const visible = homeKey ? homeVisible[homeKey] : true;
    tab.style.display = visible ? '' : 'none';
    if (!visible && tab.classList.contains('active')) {
      const first = Array.from(allTabs).find(t => {
        const hk = calcTabMap[t.dataset.calc];
        return hk ? homeVisible[hk] : true;
      });
      if (first) { first.classList.add('active'); currentCalcProduct = first.dataset.calc; updateCalculator(); }
      tab.classList.remove('active');
    }
  });

  // Next pool closing — soonest open-pool closing date across all products
  _showNextPoolClosing(products);
}

function _showNextPoolClosing(products) {
  let soonest = null, soonestProduct = null;
  (products || []).forEach(p => {
    if (!p.next_closing_date) return;
    const d = new Date(p.next_closing_date);
    if (isNaN(d)) return;
    if (!soonest || d < soonest) { soonest = d; soonestProduct = p; }
  });
  if (!soonest) return;

  const days = Math.max(0, Math.ceil((soonest - Date.now()) / 86400000));
  const dateStr = soonest.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  const header = document.querySelector('#products .section-header');
  if (!header || document.getElementById('nextPoolClosing')) return;

  const el = document.createElement('div');
  el.id = 'nextPoolClosing';
  el.style.cssText = 'display:inline-flex;align-items:center;gap:10px;margin-top:16px;padding:9px 18px;border-radius:999px;background:rgba(254,194,79,0.12);border:1px solid rgba(254,194,79,0.3);color:#b8702a;font-weight:700;font-size:0.86rem';
  el.innerHTML = `<i class="fa-solid fa-clock"></i> Next pool closes ${dateStr}${days <= 60 ? ` — <span style="color:#e0571a">${days} day${days === 1 ? '' : 's'} left</span>` : ''}${soonestProduct && soonestProduct.label ? ` · ${soonestProduct.label}` : ''}`;
  header.appendChild(el);
}

document.addEventListener('DOMContentLoaded', _applyLiveProductAverages);

/* ─── Live cattle herd status on the Cattle Investment product ─────────────
   Pulls aggregated herd data (purchased to date, breeds, average weight) from
   the fund-management herd and surfaces it on the home page cattle card and
   its "View Details" modal. */
async function _applyCattleHerdStatus() {
  let s;
  try {
    const r = await fetch('/api/products/cattle-stats');
    if (!r.ok) return;
    s = await r.json();
  } catch (_) { return; }
  if (!s || !s.total_purchased) return;

  const num    = n => Number(n || 0).toLocaleString('en-ZA');
  const esc    = x => String(x == null ? '' : x).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const weight = s.avg_current_weight || s.avg_entry_weight;

  // Rich "Live Herd Status" block injected into the cattle "View Details" modal
  if (typeof MODAL_DATA !== 'undefined' && MODAL_DATA.cattle) {
    const genders = (s.by_gender || []).filter(g => g.count > 0);
    const breeds  = (s.by_breed  || []).filter(b => b.count > 0);
    const totalG  = genders.reduce((a, g) => a + g.count, 0) || 1;
    const chip = txt => `<span style="font-size:0.78rem;background:rgba(255,255,255,0.08);color:#fff;border-radius:20px;padding:3px 11px">${txt}</span>`;

    // Weight journey + survival
    const entry = s.avg_entry_weight, current = s.avg_current_weight, target = s.target_weight || 475;
    let weightBar = '';
    if (entry && current && target && target > entry) {
      const wp = Math.min(100, Math.max(0, Math.round((current - entry) / (target - entry) * 100)));
      weightBar = `<div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--text-dim);margin-bottom:5px"><span>Entry ${entry}kg</span><span style="color:#fec24f;font-weight:700">Now ~${current}kg</span><span>Target ${target}kg</span></div>
        <div style="height:9px;border-radius:5px;background:rgba(255,255,255,0.08);overflow:hidden"><div style="height:100%;width:${wp}%;background:linear-gradient(90deg,#fec24f,#fec24f)"></div></div>
        <div style="font-size:0.7rem;color:var(--text-dim);margin-top:4px">${wp}% of the way to market weight</div></div>`;
    }
    const mortRate = s.total_purchased ? (s.mortality_count || 0) / s.total_purchased * 100 : 0;
    const mortLine = `<div style="font-size:0.76rem;color:var(--text-dim);margin-top:10px"><i class="fa-solid fa-heart-pulse" style="color:#22c55e"></i> Survival rate <strong style="color:#fff">${(100 - mortRate).toFixed(1)}%</strong>${s.mortality_count ? ` · ${s.mortality_count} of ${num(s.total_purchased)}` : ''}</div>`;

    MODAL_DATA.cattle.herdHtml = `
      <div style="background:rgba(254,194,79,0.08);border:1px solid rgba(254,194,79,0.28);border-radius:14px;padding:16px 18px;margin:6px 0 18px">
        <div style="font-size:0.78rem;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:#fec24f;margin-bottom:12px"><i class="fa-solid fa-cow"></i> Live Herd Status</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px">
          <div><div style="font-size:1.3rem;font-weight:800;color:#fff">${num(s.total_purchased)}</div><div style="font-size:0.72rem;color:var(--text-dim)">purchased to date</div></div>
          <div><div style="font-size:1.3rem;font-weight:800;color:#fff">${num(s.live_count)}</div><div style="font-size:0.72rem;color:var(--text-dim)">currently live</div></div>
          ${weight ? `<div><div style="font-size:1.3rem;font-weight:800;color:#fff">${weight}<span style="font-size:0.85rem"> kg</span></div><div style="font-size:0.72rem;color:var(--text-dim)">average weight</div></div>` : ''}
        </div>
        ${weightBar}
        ${genders.length ? `<div style="margin-bottom:${breeds.length ? '12px' : '0'}"><div style="font-size:0.72rem;color:var(--text-dim);margin-bottom:6px">Gender</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${genders.map(g => chip(`${esc(g.label)}: <strong>${g.count}</strong> (${Math.round(g.count / totalG * 100)}%)`)).join('')}</div></div>` : ''}
        ${breeds.length ? `<div><div style="font-size:0.72rem;color:var(--text-dim);margin-bottom:6px">Breeds</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${breeds.slice(0, 8).map(b => chip(`${esc(b.label)}: <strong>${b.count}</strong>`)).join('')}</div></div>` : ''}
        ${mortLine}
      </div>`;
  }

  // Compact live-herd line on the cattle product card
  const detail = document.querySelector('.product-card[data-product="cattle"] .product-card__detail');
  if (detail && !detail.querySelector('[data-herd-row]')) {
    const row = document.createElement('div');
    row.className = 'detail-row';
    row.setAttribute('data-herd-row', '1');
    row.innerHTML = `<i class="fa-solid fa-cow"></i><span>${num(s.total_purchased)} cattle to date${weight ? ` · avg ${weight}kg` : ''}</span>`;
    detail.insertBefore(row, detail.firstChild);
  }
}

document.addEventListener('DOMContentLoaded', _applyCattleHerdStatus);

/* ─── Track record on the "View Details" modal (matured pools) ─────────────
   Shows pools matured, average achieved return, total paid back, and a bar
   per matured pool — the verifiable performance behind each product. */
async function _applyTrackRecord() {
  let data;
  try {
    const r = await fetch('/api/products/track-record');
    if (!r.ok) return;
    data = (await r.json()).data || {};
  } catch (_) { return; }

  const fam = { cattle: ['cattle'], solar: ['solar_7yr', 'solar_6yr', 'solar_5yr'], short: ['short_term', 'smme'], delivery: ['delivery_bike'] };
  const rand = n => 'R' + Number(n || 0).toLocaleString('en-ZA');

  Object.keys(fam).forEach(key => {
    if (typeof MODAL_DATA === 'undefined' || !MODAL_DATA[key]) return;
    let pools = [], paid = 0, sumA = 0, n = 0;
    fam[key].forEach(t => {
      const d = data[t]; if (!d) return;
      pools = pools.concat(d.pools || []);
      paid += d.total_paid_back || 0;
      sumA += (d.avg_actual_rate || 0) * (d.matured_count || 0);
      n += d.matured_count || 0;
    });
    if (!n) return;

    // Show the average delivered return only (no per-pool bar graph).
    MODAL_DATA[key].trackHtml = `
      <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px 18px;margin:6px 0 18px">
        <div style="font-size:0.78rem;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:#fec24f;margin-bottom:12px"><i class="fa-solid fa-award"></i> Track Record</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
          <div><div style="font-size:1.5rem;font-weight:800;color:#fec24f">${(sumA / n * 100).toFixed(2)}%</div><div style="font-size:0.72rem;color:var(--text-dim)">avg return achieved p.a.</div></div>
          <div><div style="font-size:1.5rem;font-weight:800;color:#fff">${n}</div><div style="font-size:0.72rem;color:var(--text-dim)">pool${n === 1 ? '' : 's'} matured</div></div>
          <div><div style="font-size:1.5rem;font-weight:800;color:#fff">${rand(paid)}</div><div style="font-size:0.72rem;color:var(--text-dim)">paid back</div></div>
        </div>
      </div>`;
  });
}

document.addEventListener('DOMContentLoaded', _applyTrackRecord);

/* ─── Live solar telematics (FoxESS / FoxCloud) on the Solar product ───────
   All three solar terms share one physical installation, so a single live
   feed (generation now, today, this month, total, CO₂ avoided) is surfaced
   on the home page solar card and its "View Details" modal. */
async function _applySolarTelemetry() {
  let s;
  try {
    const r = await fetch('/api/products/solar-stats');
    if (!r.ok) return;
    s = await r.json();
  } catch (_) { return; }
  if (!s || s.unavailable || (!s.total_kwh && !s.today_kwh && !s.current_power_kw)) return;

  const kwh = v => Number(v || 0).toLocaleString('en-ZA');
  const total = s.total_kwh >= 1000 ? `${(s.total_kwh / 1000).toFixed(1)} MWh` : `${kwh(s.total_kwh)} kWh`;
  const live = (s.current_power_kw || 0) > 0;
  const stat = (val, lbl) => `<div><div style="font-size:1.3rem;font-weight:800;color:#fff">${val}</div><div style="font-size:0.72rem;color:var(--text-dim)">${lbl}</div></div>`;

  if (typeof MODAL_DATA !== 'undefined' && MODAL_DATA.solar) {
    MODAL_DATA.solar.herdHtml = `
      <div style="background:rgba(34,197,94,0.09);border:1px solid rgba(34,197,94,0.3);border-radius:14px;padding:16px 18px;margin:6px 0 18px">
        <div style="display:flex;align-items:center;gap:8px;font-size:0.78rem;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:#34d27f;margin-bottom:12px">
          <i class="fa-solid fa-solar-panel"></i> Live Solar Generation
          ${live ? '<span style="display:inline-flex;align-items:center;gap:5px;margin-left:auto;font-size:0.7rem;color:#22c55e;text-transform:none;letter-spacing:0"><span style="width:7px;height:7px;border-radius:50%;background:#22c55e;display:inline-block"></span> generating now</span>' : ''}
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
          ${stat(`${(s.current_power_kw || 0).toLocaleString('en-ZA')}<span style="font-size:0.85rem"> kW</span>`, 'generating now')}
          ${stat(`${kwh(s.today_kwh)}<span style="font-size:0.85rem"> kWh</span>`, 'today')}
          ${stat(`${kwh(s.month_kwh)}<span style="font-size:0.85rem"> kWh</span>`, 'this month')}
          ${stat(total, 'total generated')}
          ${s.co2_avoided_kg ? stat(`${(s.co2_avoided_kg / 1000).toFixed(1)}<span style="font-size:0.85rem"> t</span>`, 'CO₂ avoided') : ''}
          ${s.device_count ? stat(s.device_count, `inverter${s.device_count === 1 ? '' : 's'}`) : ''}
        </div>
        <div style="font-size:0.7rem;color:var(--text-dim);margin-top:10px">Live data from FoxCloud${s.station_name ? ` · ${String(s.station_name).replace(/[<>&]/g, '')}` : ''}</div>
      </div>`;
  }

  // Live-generation line on the solar product card
  const card = document.querySelector('.product-card[data-product="solar"]');
  const descEl = card && card.querySelector('.product-card__desc');
  if (descEl && !card.querySelector('[data-solar-row]')) {
    const row = document.createElement('div');
    row.setAttribute('data-solar-row', '1');
    row.style.cssText = 'display:inline-flex;align-items:center;gap:7px;margin-top:10px;padding:5px 12px;border-radius:999px;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.3);color:#1f9d57;font-weight:700;font-size:0.78rem';
    row.innerHTML = `<i class="fa-solid fa-solar-panel"></i> ${live ? `Generating ${(s.current_power_kw || 0).toLocaleString('en-ZA')} kW now` : `${total} generated to date`}`;
    descEl.insertAdjacentElement('afterend', row);
  }
}

document.addEventListener('DOMContentLoaded', _applySolarTelemetry);
