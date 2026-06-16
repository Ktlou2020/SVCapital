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
    color: '#D4AF37',
    partner: 'Beefcor',
    infoItems: [
      { label: 'Partner', value: 'Beefcor Feedlot' },
      { label: 'Benchmark', value: '13.00% p.a.' },
      { label: 'Perf. Fee', value: '20% above benchmark' },
      { label: 'Pool Type', value: 'Time-based pool' },
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
      { label: 'Location', value: 'Cape Town, SA' },
      { label: 'Returns', value: 'Annual payouts' },
      { label: 'Capital', value: 'End of term' },
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
      { label: 'Location', value: 'Cape Town, SA' },
      { label: 'Returns', value: 'Annual payouts' },
      { label: 'Capital', value: 'End of term' },
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
    color: '#3b82f6',
    partner: 'MoolaLend',
    infoItems: [
      { label: 'Partner', value: 'MoolaLend Pty Ltd' },
      { label: 'Focus', value: 'SMME Finance' },
      { label: 'Benchmark', value: '12.00% p.a.' },
      { label: 'Pool Type', value: 'Time-based pool' },
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
      { label: 'Platforms', value: 'Mr D, Takealot, UberEats' },
      { label: 'Min. Fleet', value: '5 bikes per pool' },
      { label: 'Pool Type', value: 'Targeted amount' },
    ]
  }
};

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
  initHeroChart();
  initCalculator();
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

  if (!toggle || !navLinks) return;

  toggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
  });

  // Close on link click
  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => navLinks.classList.remove('open'));
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!toggle.contains(e.target) && !navLinks.contains(e.target)) {
      navLinks.classList.remove('open');
    }
  });
}

/* ═══════════════════════════════════════════════
   HERO CHART
   ═══════════════════════════════════════════════ */
function initHeroChart() {
  const canvas = document.getElementById('heroChart');
  if (!canvas) return;

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
        borderColor: '#D4AF37',
        borderWidth: 2,
        fill: true,
        backgroundColor: (ctx) => {
          const gradient = ctx.chart.ctx.createLinearGradient(0, 0, 0, 80);
          gradient.addColorStop(0, 'rgba(212,175,55,0.25)');
          gradient.addColorStop(1, 'rgba(212,175,55,0)');
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
  sliderEl.style.background = `linear-gradient(to right, #D4AF37 0%, #D4AF37 ${pct}%, #243040 ${pct}%, #243040 100%)`;

  // Update chart
  updateCalcChart(amount, returnsEarned, product);
}

function updateCalcChart(amount, totalReturns, product) {
  const canvas = document.getElementById('calcChart');
  if (!canvas) return;

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
            gradient.addColorStop(0, 'rgba(212,175,55,0.9)');
            gradient.addColorStop(1, 'rgba(212,175,55,0.3)');
            return gradient;
          },
          borderColor: '#D4AF37',
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
            color: '#8ea3b8',
            font: { size: 11 },
            boxWidth: 12,
            boxHeight: 12,
          }
        },
        tooltip: {
          backgroundColor: 'rgba(13,17,23,0.95)',
          titleColor: '#f0f4f8',
          bodyColor: '#8ea3b8',
          borderColor: 'rgba(212,175,55,0.3)',
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
          ticks: { color: '#4a6080', font: { size: 10 } }
        },
        y: {
          stacked: true,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            color: '#4a6080',
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
