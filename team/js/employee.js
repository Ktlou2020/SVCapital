/* ═══════════════════════════════════════════════════════════════════════
   SV Capital — Employee Self-Service Portal  (World-Class Edition)
   team/js/employee.js
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

/* ─── API helpers ────────────────────────────────────────────────────── */
const BASE = '/api/';
let _authFailed = false;
const get = async p => {
  if (_authFailed) return { data: [], total: 0 };
  try {
    const r = await fetch(BASE + p);
    if (r.status === 401) {
      if (!_authFailed) {
        _authFailed = true;
        if (typeof StaffAuth !== 'undefined') StaffAuth.clearSession();
        window.location.replace('login.html');
      }
      return { data: [], total: 0 };
    }
    return r.ok ? r.json() : { data: [], total: 0 };
  } catch { return { data: [], total: 0 }; }
};
const post   = async (p,b) => { const r = await fetch(BASE+p,{method:'POST',  headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); return r.json(); };
const patch  = async (p,b) => { const r = await fetch(BASE+p,{method:'PATCH', headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); return r.json(); };
const put    = async (p,b) => { const r = await fetch(BASE+p,{method:'PUT',   headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); return r.json(); };
const del    = async p     => { await fetch(BASE+p,{method:'DELETE'}); };

async function fetchAll(table) {
  let page=1, all=[];
  while(true) {
    const r = await get(`tables/${table}?limit=100&page=${page}`);
    all = all.concat(r.data||[]);
    if ((r.data||[]).length < 100) break;
    if (r.total > 0 && all.length >= r.total) break;
    page++;
  }
  return all;
}

/* ─── Formatters / Helpers ───────────────────────────────────────────── */
const isTrue = v => v === true || v === 'true' || v === 1 || v === '1';
const zarM   = v => { const n=Number(v)||0; return n>=1e6?`R${(n/1e6).toFixed(1)}M`:n>=1e3?`R${(n/1e3).toFixed(0)}k`:`R${n.toLocaleString()}`; };
const timeAgo = iso => {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff/60000);
  if (m<1) return 'just now';
  if (m<60) return `${m}m ago`;
  const h = Math.floor(m/60); if (h<24) return `${h}h ago`;
  const d = Math.floor(h/24); if (d<7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-ZA',{day:'numeric',month:'short'});
};
const kpiColor = v => v>=90?'#00d4aa':v>=75?'#4fc3f7':v>=60?'#fec24f':v>=40?'#ffb347':'#ff5b5b';
const LEVELS = [
  {level:1,title:'Analyst',   minXP:0,   color:'#adb5bd'},
  {level:2,title:'Associate', minXP:500, color:'#5cb85c'},
  {level:3,title:'Senior',    minXP:1200,color:'#00d4aa'},
  {level:4,title:'Lead',      minXP:2500,color:'#4fc3f7'},
  {level:5,title:'Director',  minXP:4500,color:'#eda5ff'},
  {level:6,title:'MVP',       minXP:7000,color:'#fec24f'},
];
function getLevel(xp) { let l=LEVELS[0]; for(const L of LEVELS){if(xp>=L.minXP)l=L;} return l; }
function getXpProgress(xp) {
  const l=getLevel(xp), idx=LEVELS.indexOf(l), next=LEVELS[idx+1];
  if(!next) return {pct:100,current:xp-l.minXP,needed:0,nextTitle:'MAX'};
  const cur=xp-l.minXP, need=next.minXP-l.minXP;
  return {pct:Math.round(cur/need*100),current:cur,needed:need,nextTitle:next.title};
}
const catColors = {
  aum_growth:'#eda5ff',technical:'#4fc3f7',compliance:'#0984e3',
  leadership:'#fec24f',client_relations:'#fd79a8',innovation:'#00d4aa',soft_skills:'#ffb347'
};
const KPI_DIMS = ['revenue_contribution','client_satisfaction','task_completion_rate',
  'response_time_score','compliance_score','innovation_score','team_collaboration','attendance_score'];
const KPI_LABELS = {
  revenue_contribution:'Revenue Contribution', client_satisfaction:'Client Satisfaction',
  task_completion_rate:'Task Completion', response_time_score:'Response Time',
  compliance_score:'Compliance', innovation_score:'Innovation',
  team_collaboration:'Team Collaboration', attendance_score:'Attendance'
};

/* ─── State ───────────────────────────────────────────────────────────── */
let _emp         = null;
let _employees   = [];
let _courses     = [];
let _modules     = {};
let _progress    = [];
let _kpiScores   = [];
let _achievements= [];
let _evaPeriods  = [];
let _leaveReqs   = [];
let _checkins    = [];
let _okrs        = [];
let _peerFeedback= [];
let _pulseSurveys= [];
let _pulseResp   = [];
let _oneOnOnes   = [];
let _learningPaths=[];
let _activityFeed= [];
let _notes       = [];
let _payslips    = [];
let _currentView = 'dashboard';

// Reader state
let _readerCourse  = null;
let _readerModules = [];
let _readerModIdx  = 0;
let _readerMode    = 'lesson';
let _quizAnswers   = {};
let _quizSubmitted = false;

// Note editor state
let _noteEditing = null;

// Pulse state
let _pulseAnswers = {};

/* ═══ INIT ═══════════════════════════════════════════════════════════ */
async function init() {
  showLoader(true);

  // Identify the logged-in employee from the session
  const session = StaffAuth.getSession();
  if (!session || !session.empId) {
    document.getElementById('globalLoader').innerHTML =
      '<p style="color:#ff5b5b;text-align:center;margin-top:40px">Session expired. <a href="login.html" style="color:#eda5ff">Sign in again</a>.</p>';
    return;
  }
  const myEmpId = session.empId;

  // ?id= param: only managers/team-access users may view another employee's dashboard.
  // Regular staff are always shown their own profile regardless of URL params.
  const canViewOthers = StaffAuth.canAccess(session, 'team');
  const rawUrlId = new URLSearchParams(location.search).get('id');
  const urlEmpId = (canViewOthers && rawUrlId) ? rawUrlId : null;

  // Target employee: URL param (managers only) or self
  const targetEmpId = urlEmpId || myEmpId;
  const [
    emps, courses, progList, kpis, achs, periods, leaves, checkins,
    okrs, feedback, surveys, pulseResp, oneOnOnes, paths, feed, notes
  ] = await Promise.all([
    fetchAll('employees'),
    fetchAll('employee_courses'),
    fetchAll('course_progress'),
    fetchAll('kpi_scores'),
    fetchAll('achievements'),
    fetchAll('eva_periods'),
    fetchAll('leave_requests'),
    fetchAll('daily_checkins'),
    fetchAll('okrs'),
    fetchAll('peer_feedback'),
    fetchAll('pulse_surveys'),
    fetchAll('pulse_responses'),
    fetchAll('one_on_ones'),
    fetchAll('learning_paths'),
    fetchAll('activity_feed'),
    fetchAll('personal_notes')
  ]);

  _employees    = emps;
  _courses      = courses.filter(c=>isTrue(c.status==='active'||c.status));
  _evaPeriods   = periods;
  _okrs         = okrs;
  _peerFeedback = feedback;
  _pulseSurveys = surveys;
  _pulseResp    = pulseResp;
  _oneOnOnes    = oneOnOnes;
  _learningPaths= paths;
  _activityFeed = feed;

  _emp = emps.find(e => e.id === targetEmpId) || emps.find(e => e.id === myEmpId);
  if (!_emp) {
    document.getElementById('globalLoader').innerHTML =
      '<p style="color:#ff5b5b;text-align:center;margin-top:40px">Employee profile not found. Please <a href="login.html" style="color:#eda5ff">sign in</a> again.</p>';
    return;
  }

  _progress     = progList.filter(p=>p.employee_id===_emp.id);
  _kpiScores    = kpis.filter(k=>k.employee_id===_emp.id);
  _achievements = achs.filter(a=>a.employee_id===_emp.id);
  _leaveReqs    = leaves.filter(l=>l.employee_id===_emp.id);
  _checkins     = checkins.filter(c=>c.employee_id===_emp.id).sort((a,b)=>new Date(b.checkin_date)-new Date(a.checkin_date));
  _notes        = notes.filter(n=>n.employee_id===_emp.id);

  // Load payslips for this employee
  try {
    const psRes = await get(`tables/payslips?employee_id=${_emp.id}&sort=pay_period&order=desc&limit=100`);
    _payslips = (psRes.data || []).filter(p => p.employee_id === _emp.id);
  } catch(_) { _payslips = []; }

  buildEmpSwitcher();
  renderTopbar();
  showLoader(false);
  navigate(_currentView, document.querySelector(`.sidebar-nav-btn[data-view="${_currentView}"]`));
  await autoStreakCheck();
  checkBirthdays();
}

/* ─── Topbar / Avatar ─────────────────────────────────────────────────── */
function renderTopbar() {
  if (!_emp) return;
  const xp = Number(_emp.xp_points)||0;
  const lv = getLevel(xp);
  const pr = getXpProgress(xp);
  const el = document.getElementById('sidebar-avatar');
  if (el) {
    el.textContent = _emp.avatar_initials || (_emp.first_name||'?')[0];
    el.style.background = _emp.avatar_color || '#eda5ff';
  }
  const nameEl = document.getElementById('sidebar-profile-name');
  if (nameEl) nameEl.textContent = `${_emp.first_name||''} ${_emp.last_name||''}`.trim();
  const roleEl = document.getElementById('sidebar-profile-role');
  if (roleEl) roleEl.textContent = _emp.role || _emp.department || '—';
  const xpEl = document.getElementById('xp-bar');
  if (xpEl) { xpEl.style.width = pr.pct + '%'; }
  const xpLbl = document.getElementById('xp-label');
  if (xpLbl) xpLbl.textContent = `${pr.current}/${pr.needed||'MAX'} XP to ${pr.nextTitle}`;
  const lvEl = document.getElementById('level-chip');
  if (lvEl) { lvEl.textContent = lv.title; lvEl.style.background=`${lv.color}20`; lvEl.style.color=lv.color; }
}

function buildEmpSwitcher() {
  // The employee switcher dropdown was removed — "My Dashboard" only ever shows
  // the signed-in user's own profile. Only reveal the Team Dashboard shortcut to
  // users who actually have team-management access.
  const session = (typeof StaffAuth !== 'undefined') ? StaffAuth.getSession() : null;
  const canViewTeam = session && StaffAuth.canAccess(session, 'team');
  const teamLink = document.getElementById('teamDashLink');
  if (teamLink) teamLink.style.display = canViewTeam ? '' : 'none';
}

/* ═══ NAVIGATION ════════════════════════════════════════════════════ */
function navigate(view, btn) {
  _currentView = view;
  document.querySelectorAll('.emp-view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.sidebar-nav-btn').forEach(b=>b.classList.remove('active'));
  const vEl = document.getElementById('view-'+view);
  if (vEl) vEl.classList.add('active');
  if (btn) btn.classList.add('active');
  // Lazy render
  const renders = {
    dashboard:    renderDashboard,
    courses:      renderCourses,
    kpis:         renderMyKpis,
    checkin:      renderCheckin,
    leave:        renderMyLeave,
    achievements: renderMyAchievements,
    okrs:         renderOkrs,
    feedback:     renderFeedback,
    pulse:        renderPulse,
    oneonone:     renderOneOnOnes,
    paths:        renderPaths,
    feed:         renderActivityFeed,
    journal:      renderJournal,
    eva:          renderEvaPayslip,
    payslips:     renderPayslips,
    profile:      renderProfile,
    calendar:     renderLeaveCalendar
  };
  if (renders[view]) renders[view]();
}

/* ═══ AUTOMATION ENGINE ═════════════════════════════════════════════ */
async function awardXP(amount, reason='') {
  if (!_emp) return;
  const cur = Number(_emp.xp_points)||0;
  const newXp = cur + amount;
  const wasLevel = getLevel(cur).title;
  const updated = await patch(`tables/employees/${_emp.id}`, {xp_points: newXp});
  _emp.xp_points = newXp;
  renderTopbar();
  showXpPopup(amount);
  const newLevel = getLevel(newXp).title;
  if (newLevel !== wasLevel) {
    showToast(`🎉 Level Up! You are now ${newLevel}!`, 'success');
    const actEl = await post('tables/activity_feed', {
      employee_id: _emp.id, type:'level_up',
      title:`Level Up! You're now ${newLevel}`,
      body:`You've reached the ${newLevel} level with ${newXp} XP!`,
      icon:'fa-star', color:'#fec24f', xp_shown:0, is_public:true,
      created_at: new Date().toISOString()
    });
    _activityFeed.unshift(actEl);
  }
}

async function autoBoostKpi(dimension, points) {
  if (!dimension || !KPI_DIMS.includes(dimension)) return;
  const month = new Date().toISOString().slice(0,7);
  let kpi = _kpiScores.find(k=>k.period_month===month);
  if (!kpi) {
    kpi = await post('tables/kpi_scores', {
      employee_id:_emp.id, period_month:month,
      revenue_contribution:50, client_satisfaction:50,
      task_completion_rate:50, response_time_score:50,
      compliance_score:50, innovation_score:50,
      team_collaboration:50, attendance_score:50,
      overall_score:50, submitted_by:'system', submitted_at:new Date().toISOString()
    });
    _kpiScores.push(kpi);
  }
  const cur = Number(kpi[dimension])||50;
  const nv  = Math.min(100, cur+points);
  const update = {}; update[dimension]=nv;
  const updated = await patch(`tables/kpi_scores/${kpi.id}`, update);
  Object.assign(kpi, updated);
}

async function autoAwardCourseBadge(course) {
  const badge = await post('tables/achievements', {
    employee_id:_emp.id,
    badge_id:`BADGE-CRS-${course.id}`,
    badge_name:`${course.title} Graduate`,
    badge_icon:'🎓', badge_color:'#eda5ff',
    category:'milestone',
    description:`Completed the course: ${course.title}`,
    xp_awarded:50, awarded_at:new Date().toISOString(), awarded_by:'system'
  });
  _achievements.push(badge);
  await awardXP(50, 'Course badge');
}

async function autoCheckBadgeUnlocks(earned) {
  const milestones = [
    {id:'BADGE-5COURSES',  count:5,  name:'Course Collector', icon:'📚', desc:'Completed 5 courses'},
    {id:'BADGE-10COURSES', count:10, name:'Knowledge Seeker',  icon:'🔭', desc:'Completed 10 courses'},
    {id:'BADGE-STREAK7',   streak:7, name:'7-Day Streak',      icon:'🔥', desc:'7 consecutive check-ins'},
    {id:'BADGE-STREAK30',  streak:30,name:'Habit Hero',        icon:'⚡', desc:'30 consecutive check-ins'},
  ];
  for (const m of milestones) {
    if (earned.find(e=>e.badge_id===m.id)) continue;
    const completed = _progress.filter(p=>p.status==='completed').length;
    const streak    = Number(_emp.streak_days)||0;
    if ((m.count && completed>=m.count) || (m.streak && streak>=m.streak)) {
      const badge = await post('tables/achievements', {
        employee_id:_emp.id, badge_id:m.id, badge_name:m.name,
        badge_icon:m.icon, badge_color:'#fec24f', category:'milestone',
        description:m.desc, xp_awarded:100, awarded_at:new Date().toISOString(), awarded_by:'system'
      });
      _achievements.push(badge);
      showToast(`🏅 Badge unlocked: ${m.name}!`, 'success');
      await awardXP(100, 'Milestone badge');
    }
  }
}

async function autoStreakCheck() {
  if (!_emp) return;
  if (!_checkins.length) return;
  const last = _checkins[0];
  const lastDate = new Date(last.checkin_date).toDateString();
  const todayStr = new Date().toDateString();
  const yestStr  = new Date(Date.now()-86400000).toDateString();
  if (lastDate !== todayStr && lastDate !== yestStr) {
    const s = Number(_emp.streak_days)||0;
    if (s > 0) {
      await patch(`tables/employees/${_emp.id}`, {streak_days:0});
      _emp.streak_days = 0;
      showToast('Streak reset — check in daily to keep your streak! 💪', 'error');
    }
  }
}

/* ═══ COURSE ENGINE ═════════════════════════════════════════════════ */
async function openCourse(courseId) {
  const course = _courses.find(c=>c.id===courseId);
  if (!course) return;

  // Load modules if not cached
  if (!_modules[courseId]) {
    const mods = await fetchAll('course_modules');
    _modules[courseId] = mods.filter(m=>m.course_id===courseId).sort((a,b)=>(Number(a.module_index)||0)-(Number(b.module_index)||0));
  }
  _readerCourse  = course;
  _readerModules = _modules[courseId];

  if (!_readerModules.length) {
    // Trigger AI generation for this course
    await startAiGenerationForCourse(courseId);
    return;
  }

  // Resume from progress
  let prog = _progress.find(p=>p.course_id===courseId);
  if (!prog) {
    prog = await post('tables/course_progress', {
      employee_id:_emp.id, course_id:courseId,
      status:'in_progress', current_module:_readerModules[0]?.id||'',
      modules_completed:0, quiz_scores:'{}', overall_quiz_score:0,
      xp_earned:0, kpi_applied:false, started_at:new Date().toISOString()
    });
    _progress.push(prog);
  } else if (prog.status !== 'completed') {
    await patch(`tables/course_progress/${prog.id}`, {status:'in_progress'});
    prog.status = 'in_progress';
  }

  const doneIds = (() => { try { return JSON.parse(prog.quiz_scores||'{}'); } catch { return {}; } });
  const completedMods = Object.keys(doneIds());
  _readerModIdx = 0;
  for (let i=0; i<_readerModules.length; i++) {
    if (!completedMods.includes(_readerModules[i].id)) { _readerModIdx = i; break; }
    if (i === _readerModules.length-1) _readerModIdx = i; // all done, show last
  }
  _readerMode = 'lesson';
  _quizAnswers = {};
  _quizSubmitted = false;

  const overlay = document.getElementById('course-reader');
  overlay.classList.add('open');
  renderReader();
}

function closeCourseReader() {
  document.getElementById('course-reader').classList.remove('open');
  _readerCourse = null;
  if (_currentView === 'courses') renderCourses();
}

function renderReader() {
  if (!_readerCourse || !_readerModules.length) return;
  const mod = _readerModules[_readerModIdx];
  const prog = _progress.find(p=>p.course_id===_readerCourse.id);
  const scores = (() => { try { return JSON.parse(prog?.quiz_scores||'{}'); } catch { return {}; } })();
  const totalMods = _readerModules.length;

  // Topbar
  document.getElementById('reader-course-title').textContent = _readerCourse.title;
  document.getElementById('reader-progress').textContent = `Module ${_readerModIdx+1} of ${totalMods}`;

  // Nav sidebar
  document.getElementById('reader-nav-list').innerHTML = _readerModules.map((m,i)=>`
    <div class="reader-nav-item ${i===_readerModIdx?'active':''} ${scores[m.id]!==undefined?'done':''}"
         onclick="jumpToModule(${i})">
      <span class="reader-nav-num">${scores[m.id]!==undefined?'<i class="fa-solid fa-check" style="font-size:0.55rem"></i>':i+1}</span>
      <span>${m.title}</span>
    </div>`).join('');

  // Content
  document.getElementById('reader-content').innerHTML =
    _readerMode === 'quiz' ? renderQuiz(mod) : renderLessonContent(mod, scores);
}

function renderLessonContent(mod, scores) {
  const done = scores && scores[mod.id] !== undefined;
  let kps = '';
  try { const pts = JSON.parse(mod.key_points||'[]'); kps = pts.map(p=>`<li>${p}</li>`).join(''); } catch { kps=''; }
  return `
    <div class="lesson-title">${mod.title}</div>
    <div class="lesson-meta">
      <span><i class="fa-regular fa-clock"></i> ~${mod.estimated_minutes||8} min</span>
      <span><i class="fa-solid fa-star"></i> +${mod.xp_reward||50} XP on completion</span>
    </div>
    <div class="lesson-body">${mod.content||'<p>Content loading...</p>'}</div>
    ${kps?`<div class="key-points-box"><h4><i class="fa-solid fa-lightbulb"></i> &nbsp;Key Takeaways</h4><ul>${kps}</ul></div>`:''}
    <div class="lesson-actions">
      ${done
        ? `<button class="btn btn--success btn--lg" disabled><i class="fa-solid fa-check"></i> Module Completed</button>`
        : `<button class="btn btn--primary btn--lg" onclick="startQuiz()"><i class="fa-solid fa-pen-to-square"></i> Take Quiz to Proceed</button>`
      }
      ${_readerModIdx > 0 ? `<button class="btn btn--secondary" onclick="prevModule()"><i class="fa-solid fa-arrow-left"></i> Previous</button>` : ''}
    </div>`;
}

function renderQuiz(mod) {
  let questions = [];
  try { questions = JSON.parse(mod.quiz||'[]'); } catch { questions=[]; }
  if (!questions.length) {
    return `<div class="quiz-wrap">
      <div class="quiz-title">Quick Knowledge Check</div>
      <p class="text-muted">No quiz questions for this module.</p>
      <div class="lesson-actions mt-2">
        <button class="btn btn--success btn--lg" onclick="completeModule(${JSON.stringify(mod).replace(/"/g,"'")},100,${mod.xp_reward||50})">
          <i class="fa-solid fa-check"></i> Mark Complete
        </button>
      </div></div>`;
  }

  return `<div class="quiz-wrap">
    <div class="quiz-title">Module Quiz</div>
    <div class="quiz-sub">Answer all questions to complete this module and earn XP.</div>
    ${questions.map((q,qi)=>`
      <div class="quiz-question" id="q-${qi}">
        <div class="q-text">Q${qi+1}. ${q.question}</div>
        <div class="quiz-options">
          ${q.options.map((o,oi)=>`
            <div class="quiz-option ${_quizAnswers[qi]===oi?'selected':''}"
                 onclick="selectAnswer(${qi},${oi})" id="opt-${qi}-${oi}">
              <div class="opt-radio"></div>
              <span>${o}</span>
            </div>`).join('')}
        </div>
        <div class="quiz-explanation" id="exp-${qi}">${q.explanation||''}</div>
      </div>`).join('')}
    <div class="lesson-actions mt-2">
      <button class="btn btn--primary btn--lg" id="submit-quiz-btn"
              onclick="submitQuiz('${mod.id}',${JSON.stringify(questions).replace(/'/g,'\\x27').replace(/"/g,'&quot;')},${mod.xp_reward||50})"
              ${Object.keys(_quizAnswers).length<questions.length?'disabled':''}>
        <i class="fa-solid fa-check"></i> Submit Quiz
      </button>
      <button class="btn btn--secondary" onclick="_readerMode='lesson';renderReader()">
        <i class="fa-solid fa-book-open"></i> Back to Lesson
      </button>
    </div>
  </div>`;
}

function startQuiz() { _readerMode='quiz'; _quizAnswers={}; _quizSubmitted=false; renderReader(); }

function selectAnswer(qi, oi) {
  if (_quizSubmitted) return;
  _quizAnswers[qi] = oi;
  document.querySelectorAll(`#q-${qi} .quiz-option`).forEach((el,idx)=>{
    el.classList.toggle('selected', idx===oi);
    el.querySelector('.opt-radio').style.background = idx===oi?'var(--accent)':'';
  });
  const mod = _readerModules[_readerModIdx];
  let qs=[]; try{qs=JSON.parse(mod.quiz||'[]');}catch{}
  const btn = document.getElementById('submit-quiz-btn');
  if (btn) btn.disabled = Object.keys(_quizAnswers).length < qs.length;
}

function submitQuiz(modId, questionsJson, xpReward) {
  _quizSubmitted = true;
  let questions=[]; try{questions=JSON.parse(questionsJson);}catch{questions=questionsJson;}
  if (!Array.isArray(questions)) questions=[];
  let correct=0;
  questions.forEach((q,qi)=>{
    const chosen = _quizAnswers[qi];
    const isCorrect = chosen === q.correct;
    if(isCorrect) correct++;
    document.querySelectorAll(`#q-${qi} .quiz-option`).forEach((el,idx)=>{
      el.style.pointerEvents='none';
      if(idx===q.correct) el.classList.add('show-correct');
      if(idx===chosen && !isCorrect) el.classList.add('incorrect');
      if(idx===chosen && isCorrect) el.classList.add('correct');
    });
    const exp = document.getElementById(`exp-${qi}`);
    if(exp) exp.classList.add('show');
  });
  const score = Math.round(correct/questions.length*100);
  const mod = _readerModules[_readerModIdx];
  const pass = score >= (Number(_readerCourse.pass_score)||60);

  const content = document.getElementById('reader-content');
  const resultHtml = `<div class="quiz-result mt-2">
    <div class="quiz-score-circle">${score}%</div>
    <h3>${pass?'🎉 Excellent! Module Complete!':'📖 Keep Learning'}</h3>
    <p>${pass?`You scored ${correct}/${questions.length}. +${xpReward} XP earned!`:`You scored ${correct}/${questions.length}. Review the lesson and try again.`}</p>
    <div class="lesson-actions mt-2" style="justify-content:center">
      ${pass
        ? `<button class="btn btn--success btn--lg" onclick="completeModuleNow('${modId}',${score},${xpReward})">
             <i class="fa-solid fa-arrow-right"></i> Continue
           </button>`
        : `<button class="btn btn--primary" onclick="startQuiz()">
             <i class="fa-solid fa-rotate"></i> Retry Quiz
           </button>
           <button class="btn btn--secondary" onclick="_readerMode='lesson';renderReader()">Review Lesson</button>`
      }
    </div></div>`;
  if (content) content.insertAdjacentHTML('beforeend', resultHtml);
  document.getElementById('submit-quiz-btn').style.display='none';
}

async function completeModuleNow(modId, score, xpReward) {
  const mod = _readerModules.find(m=>m.id===modId);
  if (!mod) return;
  await completeModule(mod, score, xpReward);
}

async function completeModule(mod, score, xpReward) {
  const prog = _progress.find(p=>p.course_id===_readerCourse.id);
  if (!prog) return;

  // Update quiz scores
  let scores = {}; try { scores=JSON.parse(prog.quiz_scores||'{}'); } catch{}
  scores[mod.id] = score;
  const modsDone = Object.keys(scores).length;
  const allDone  = modsDone >= _readerModules.length;

  const updates = {
    quiz_scores: JSON.stringify(scores),
    modules_completed: modsDone,
    xp_earned: (Number(prog.xp_earned)||0) + xpReward
  };

  if (allDone) {
    updates.status = 'completed';
    updates.completed_at = new Date().toISOString();
    updates.certificate_id = `CERT-${_emp.id}-${_readerCourse.id}-${Date.now()}`;
    updates.kpi_applied = true;
  }
  const updated = await patch(`tables/course_progress/${prog.id}`, updates);
  Object.assign(prog, updated);

  await awardXP(xpReward, 'Module completion');
  if (_readerCourse.kpi_dimension) {
    await autoBoostKpi(_readerCourse.kpi_dimension, Number(_readerCourse.kpi_boost_points)||5);
  }

  // Log to activity feed
  await post('tables/activity_feed', {
    employee_id:_emp.id, type:'course_complete',
    title:`Module completed: ${mod.title}`,
    body:`+${xpReward} XP earned in ${_readerCourse.title}`,
    icon:'fa-graduation-cap', color:'#eda5ff',
    xp_shown:xpReward, is_public:false,
    created_at:new Date().toISOString()
  });

  if (allDone) {
    await autoAwardCourseBadge(_readerCourse);
    await autoCheckBadgeUnlocks(_achievements);
    showCourseCelebration(_readerCourse, prog.certificate_id);
    return;
  }

  // Move to next module
  _readerModIdx++;
  _readerMode = 'lesson';
  _quizAnswers = {};
  _quizSubmitted = false;
  renderReader();
  showToast(`Module ${modsDone} complete! +${xpReward} XP`, 'success');
}

function showCourseCelebration(course, certId) {
  launchConfetti();
  showToast(`🎉 Course complete! "${course.title}" finished. Certificate issued!`, 'success');
  // Show certificate
  openCertificate(certId, course);
}

function jumpToModule(idx) {
  const prog = _progress.find(p=>p.course_id===_readerCourse?.id);
  const scores = (() => { try { return JSON.parse(prog?.quiz_scores||'{}'); } catch { return {}; } })();
  const mod = _readerModules[idx];
  if (!mod) return;
  // Allow jump only if previous done or same
  _readerModIdx = idx;
  _readerMode = 'lesson';
  _quizAnswers = {};
  _quizSubmitted = false;
  renderReader();
}

function prevModule() {
  if (_readerModIdx > 0) { _readerModIdx--; _readerMode='lesson'; _quizAnswers={}; _quizSubmitted=false; renderReader(); }
}

/* ─── Certificate ────────────────────────────────────────────────── */
function openCertificate(certId, course) {
  const prog = _progress.find(p=>p.course_id===course.id);
  const date = prog?.completed_at ? new Date(prog.completed_at).toLocaleDateString('en-ZA',{day:'numeric',month:'long',year:'numeric'}) : 'May 2025';
  const el = document.getElementById('certificate-overlay');
  el.innerHTML = `
    <div class="certificate">
      <button onclick="document.getElementById('certificate-overlay').classList.remove('open')"
              class="btn btn--ghost btn--sm" style="position:absolute;top:14px;right:14px">
        <i class="fa-solid fa-xmark"></i>
      </button>
      <div class="cert-seal"><i class="fa-solid fa-award"></i></div>
      <div class="cert-issued">Certificate of Completion</div>
      <div class="cert-name">${_emp.first_name} ${_emp.last_name}</div>
      <div class="cert-phrase">has successfully completed</div>
      <div class="cert-course">${course.title}</div>
      <div class="cert-date">Completed on ${date}</div>
      <div class="cert-footer">
        <div class="cert-sig">
          <div class="cert-sig-line"></div>
          <div class="cert-sig-name">SV Capital Leadership</div>
          <div class="cert-sig-role">Learning & Development</div>
        </div>
        <div class="cert-id">ID: ${certId||'CERT-'+Date.now()}</div>
      </div>
    </div>`;
  el.classList.add('open');
}

function openCertificateByProgress(progId) {
  const prog = _progress.find(p=>p.id===progId);
  if (!prog) return;
  const course = _courses.find(c=>c.id===prog.course_id);
  if (!course) return;
  openCertificate(prog.certificate_id, course);
}

/* ─── AI Course Generation ────────────────────────────────────────── */
async function openAiGenModal() {
  document.getElementById('aiGenModal').classList.add('open');
}
function closeAiGenModal() {
  document.getElementById('aiGenModal').classList.remove('open');
}

async function startAiGenerationForCourse(courseId) {
  const course = _courses.find(c=>c.id===courseId)||{ id:courseId, title:'Custom Course', role_target:_emp.role, category:'aum_growth', kpi_dimension:'revenue_contribution', kpi_boost_points:8, xp_reward:150 };
  await runAiGeneration(course, '');
}

async function startAiGeneration() {
  const title = document.getElementById('ai-title').value.trim();
  const focus = document.getElementById('ai-focus').value.trim();
  if (!title) { showToast('Please enter a course title.','error'); return; }
  closeAiGenModal();
  const cat = document.getElementById('ai-cat').value || 'aum_growth';
  const dim = document.getElementById('ai-dim').value || 'revenue_contribution';

  const course = await post('tables/employee_courses', {
    id: `CRS-AI-${Date.now()}`,
    title, role_target: _emp.role||'all',
    department: _emp.department||'General',
    category: cat, difficulty:'intermediate',
    description: focus||`AI-generated course for ${_emp.role}: ${title}`,
    learning_objectives: `Build expertise in: ${title}`,
    estimated_minutes: 45, xp_reward:200,
    kpi_dimension: dim, kpi_boost_points:10,
    modules_count:3, quiz_questions:3, pass_score:60,
    status:'active', ai_generated:true,
    thumbnail_icon:'fa-robot',
    thumbnail_color: catColors[cat]||'#eda5ff'
  });
  _courses.push(course);
  await runAiGeneration(course, focus);
}

async function runAiGeneration(course, focus) {
  const ov = document.getElementById('ai-gen-overlay');
  ov.classList.add('open');
  const steps = ['Analysing role & objectives','Structuring 3 modules','Generating lesson content','Building quiz questions','Enrolling you in the course'];

  function setStep(idx) {
    document.querySelectorAll('.ai-gen-step').forEach((el,i)=>{
      el.className = 'ai-gen-step' + (i<idx?' done':i===idx?' active':'');
    });
  }

  setStep(0); await sleep(600);
  setStep(1); await sleep(700);
  const mods = buildModuleTemplates(course, focus);
  setStep(2); await sleep(800);
  for (const m of mods) {
    const saved = await post('tables/course_modules', {...m, course_id:course.id});
    if (!_modules[course.id]) _modules[course.id]=[]; _modules[course.id].push(saved);
  }
  setStep(3); await sleep(600);
  setStep(4); await sleep(500);

  // Enroll
  if (!_progress.find(p=>p.course_id===course.id)) {
    const prog = await post('tables/course_progress', {
      employee_id:_emp.id, course_id:course.id,
      status:'in_progress', current_module:_modules[course.id][0]?.id||'',
      modules_completed:0, quiz_scores:'{}', overall_quiz_score:0,
      xp_earned:0, kpi_applied:false, started_at:new Date().toISOString()
    });
    _progress.push(prog);
  }

  ov.classList.remove('open');
  showToast(`✨ Course "${course.title}" generated! 3 modules ready.`,'success');

  // Open reader
  _readerCourse = course;
  _readerModules = _modules[course.id]||[];
  _readerModIdx = 0; _readerMode='lesson'; _quizAnswers={}; _quizSubmitted=false;
  document.getElementById('course-reader').classList.add('open');
  renderReader();
}

const sleep = ms => new Promise(r=>setTimeout(r,ms));

function buildModuleTemplates(course, focus) {
  const role = course.role_target||_emp.role||'professional';
  const field = (course.category||'aum_growth').replace('_',' ');
  const fo = focus||`${field} best practices for ${role}s`;
  const diff = course.difficulty||'intermediate';
  const mods = [
    { module_index:1, title:`Foundations of ${course.title}`, estimated_minutes:12, xp_reward:Math.round(Number(course.xp_reward||150)*0.3) },
    { module_index:2, title:`Core Strategies & Application`, estimated_minutes:16, xp_reward:Math.round(Number(course.xp_reward||150)*0.35) },
    { module_index:3, title:`Advanced Practice & Impact`,    estimated_minutes:18, xp_reward:Math.round(Number(course.xp_reward||150)*0.35) },
  ];
  return mods.map((m,i)=>({
    ...m,
    content:   buildModuleContent(i+1, m.title, role, field, fo, diff),
    key_points: JSON.stringify(buildKeyPoints(m.title, field, i+1)),
    quiz:       JSON.stringify(buildQuiz(m.title, field, i+1)),
  }));
}

function buildModuleContent(num, title, role, field, focusNote, diff) {
  const intros = [
    `<p>Welcome to Module ${num}. As a <strong>${role}</strong> at SV Capital, understanding ${field} is directly tied to your ability to grow AUM and deliver exceptional client outcomes. This module lays the groundwork.</p>`,
    `<p>In this module, we move from theory into practice. You'll learn the core strategies that top-performing ${role}s use to drive results in ${field}.</p>`,
    `<p>This final module elevates your mastery. We explore advanced techniques that set the best apart — and how to apply them in your specific context at SV Capital.</p>`,
  ];
  return `${intros[num-1]}
<h3>The SV Capital Context</h3>
<p>Our firm operates at the intersection of alternative investments and high-net-worth client relationships. Every skill you develop in ${field} translates directly to stronger client trust, better deal flow, and a larger share of the EVA pool.</p>
<h3>Focus: ${focusNote}</h3>
<p>The highest-performing teams systematically apply the principles in this module. Research shows that professionals who invest in structured learning in their core domain outperform peers by 23% on revenue metrics within 12 months.</p>
<h3>Key Principle ${num}</h3>
<p>At the <strong>${diff}</strong> level, the most important skill is intentional execution. That means understanding <em>why</em> each approach works, not just <em>how</em>. This module gives you both.</p>
<ul>
  <li>Apply a structured framework rather than ad-hoc approaches</li>
  <li>Measure your impact against KPIs that matter to the business</li>
  <li>Build repeatable processes that compound over time</li>
  <li>Communicate your value in the language of AUM growth and client outcomes</li>
</ul>
<p>Complete the quiz below to lock in these concepts and earn your XP towards the EVA pool boost.</p>`;
}

function buildKeyPoints(title, field, num) {
  const banks = [
    [`Define your goal in terms of measurable client outcomes`, `Map every activity to AUM growth or retention`,
     `Use data to identify the highest-leverage actions each week`, `Build trust through consistency and communication`,
     `Review and iterate: what got measured got improved`],
    [`Apply the 80/20 rule — focus on the 20% that drives 80% of results`,
     `Anticipate client needs before they're expressed`,
     `Use structured frameworks to make decisions faster and better`,
     `Collaborate across the team to amplify individual impact`,
     `Document what works — build institutional knowledge`],
    [`Master the nuance — advanced performance comes from edge-case handling`,
     `Develop a personal system for continuous improvement`,
     `Use feedback loops: KPI trends, peer feedback, and 1-on-1 insights`,
     `Position yourself as the go-to expert on your KPI dimension`,
     `Link your personal goals to the team EVA pool for maximum alignment`],
  ];
  return banks[Math.min(num-1,2)];
}

function buildQuiz(title, field, num) {
  const banks = [
    [
      {question:`What is the primary metric used to evaluate performance at SV Capital?`,
       options:['Number of meetings held','Assets Under Management growth','Email response time','Office attendance'],
       correct:1,explanation:'AUM growth is the north star — it captures revenue-generating capacity and client trust simultaneously.'},
      {question:`Which approach best describes the SV Capital performance philosophy?`,
       options:['Individual heroics','Seniority-based reward','KPI-linked EVA sharing','Flat equal pay'],
       correct:2,explanation:'The EVA pool rewards individual KPI performance and collective team results, aligning everyone around growth.'},
      {question:`When beginning a new ${field} initiative, what should you do first?`,
       options:['Launch immediately to gain advantage','Define measurable outcomes and KPI links','Wait for manager approval on everything','Copy what competitors do'],
       correct:1,explanation:'Clear measurable outcomes ensure effort translates to KPI improvement and EVA pool contribution.'},
    ],
    [
      {question:`A client has not responded to two follow-up messages. What is the best next step?`,
       options:['Abandon the relationship','Escalate immediately to management','Try a different channel with fresh context','Send the same message again'],
       correct:2,explanation:'Different channels often reach clients who miss emails. Fresh context shows you understand their time constraints.'},
      {question:`Which of the following is the most effective way to increase your revenue_contribution KPI?`,
       options:['Close more deals regardless of fit','Build deeper relationships with fewer HNW clients','Increase number of cold calls','Focus only on existing clients'],
       correct:1,explanation:'Deep HNW relationships yield larger mandates, better referrals, and longer retention — the highest-ROI activity.'},
      {question:`How does the EVA pool work at SV Capital?`,
       options:['It is split equally regardless of KPI','It rewards only the top performer','60% is individual KPI-weighted, 40% is collective','It is paid out monthly regardless of company performance'],
       correct:2,explanation:'The 60/40 split incentivises both personal excellence and team collaboration — two pillars of SV Capital\'s culture.'},
    ],
    [
      {question:`What is the most effective signal that you are performing at the "Lead" level or above?`,
       options:['Having the highest XP score','Consistently mentoring others while hitting personal KPIs','Completing all assigned courses','Attending all team meetings'],
       correct:1,explanation:'Leadership means elevating others while delivering results. This is what distinguishes Lead from Senior performers.'},
      {question:`How should you use KPI trend data from your performance charts?`,
       options:['Ignore it — the manager will handle it','Use it to identify patterns and proactively address declining dimensions','Only look at it during performance reviews','Share only positive trends with the team'],
       correct:1,explanation:'Proactive interpretation of your own data is a hallmark of high performers — it drives course corrections before they become problems.'},
      {question:`A peer gives you 360° feedback highlighting a weak KPI dimension. What is the best response?`,
       options:['Dispute the feedback','Thank them and ask for specific examples to act on','Ignore it if your manager hasn\'t raised it','Give them negative feedback in return'],
       correct:1,explanation:'360° feedback is a gift. Specific examples unlock targeted improvement. High performers seek and act on honest feedback.'},
    ],
  ];
  return banks[Math.min(num-1,2)];
}

/* ═══ VIEW: DASHBOARD ═══════════════════════════════════════════════ */
function renderDashboard() {
  if (!_emp) return;
  const xp   = Number(_emp.xp_points)||0;
  const lv   = getLevel(xp);
  const pr   = getXpProgress(xp);
  const streak = Number(_emp.streak_days)||0;
  const thisMonth = new Date().toISOString().slice(0,7);
  const todayISO  = new Date().toISOString().slice(0,10); // YYYY-MM-DD for date comparisons

  // Upcoming birthdays in the next 30 days (all employees)
  const upcomingBirthdays = _employees
    .filter(e => e.birth_date)
    .map(e => {
      const thisYear = new Date().getFullYear();
      const [,bm,bd] = e.birth_date.split('-');
      let bdStr = `${thisYear}-${bm}-${bd}`;
      if (bdStr < todayISO) bdStr = `${thisYear+1}-${bm}-${bd}`;
      const daysUntil = Math.round(
        (new Date(bdStr+'T12:00:00Z') - new Date(todayISO+'T12:00:00Z')) / 864e5
      );
      return { emp: e, bdStr, daysUntil };
    })
    .filter(x => x.daysUntil <= 30)
    .sort((a, b) => a.daysUntil - b.daysUntil);
  const kpi  = _kpiScores.find(k=>k.period_month===thisMonth)||_kpiScores[0]||{};
  const done = _progress.filter(p=>p.status==='completed').length;
  const eva  = calcMyEVA();
  const recentFeed = _activityFeed.filter(f=>f.employee_id===_emp.id).slice(0,5);
  const myOkr = _okrs.find(o=>o.employee_id===_emp.id && o.period_month===thisMonth);
  const openOoo = _oneOnOnes.find(o=>o.employee_id===_emp.id && o.status==='scheduled');
  const activePulse = _pulseSurveys.find(s=>s.status==='active');
  const alreadyResponded = activePulse && _pulseResp.find(r=>r.employee_id===_emp.id && r.survey_id===activePulse.id);
  const todayStr = new Date().toDateString();
  const checkedIn = _checkins.length && new Date(_checkins[0].checkin_date).toDateString()===todayStr;
  const moodMap = {'😊':'Excellent','🙂':'Good','😐':'Neutral','😔':'Low','😓':'Stressed'};
  const recentMoods = _checkins.slice(0,5).map(c=>c.mood||'😐');
  const stressedCount = recentMoods.filter(m=>m==='😓').length;

  const el = document.getElementById('view-dashboard');
  el.innerHTML = `
    <!-- Profile Hero -->
    <div class="profile-hero">
      <div class="hero-avatar" style="background:${_emp.avatar_color||'#eda5ff'}">${_emp.avatar_initials||(_emp.first_name||'?')[0]}</div>
      <div class="hero-info">
        <h2>${_emp.first_name} ${_emp.last_name}</h2>
        <div class="hero-role">${_emp.role||''} · ${_emp.department||''}</div>
        <span class="hero-level" style="background:${lv.color}20;color:${lv.color}">
          <i class="fa-solid fa-star" style="font-size:0.6rem"></i> ${lv.title}
        </span>
        <div class="xp-track mt-1"><div class="xp-fill" id="xp-bar" style="width:${pr.pct}%"></div></div>
        <div class="xp-label" id="xp-label">${pr.current}/${pr.needed||'MAX'} XP → ${pr.nextTitle}</div>
      </div>
      <div class="hero-stats">
        <div class="hero-stat">
          <div class="hero-stat-val text-gold">${done}</div>
          <div class="hero-stat-lbl">Courses</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-val text-accent">${_achievements.length}</div>
          <div class="hero-stat-lbl">Badges</div>
        </div>
        <div class="hero-stat">
          <div class="streak-display"><i class="fa-solid fa-fire"></i> ${streak}</div>
          <div class="hero-stat-lbl">Day Streak</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-val text-success">${eva}</div>
          <div class="hero-stat-lbl">EVA Share</div>
        </div>
      </div>
    </div>

    <!-- Notifications row -->
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">
      ${!checkedIn ? `<div class="burnout-alert" style="flex:1;min-width:200px;padding:12px 16px;cursor:pointer" onclick="navigate('checkin',document.querySelector('[data-view=checkin]'))">
        <i class="fa-solid fa-sun" style="color:#fec24f"></i>
        <p><strong style="color:#fec24f">Daily check-in pending</strong> — Start your day right, earn XP & keep your streak!</p>
      </div>` : ''}
      ${activePulse && !alreadyResponded ? `<div class="burnout-alert" style="flex:1;min-width:200px;padding:12px 16px;background:rgba(0,212,170,0.06);border-color:rgba(0,212,170,0.25);cursor:pointer" onclick="navigate('pulse',document.querySelector('[data-view=pulse]'))">
        <i class="fa-solid fa-poll" style="color:var(--accent2)"></i>
        <p><strong style="color:var(--accent2)">Pulse survey available</strong> — 3 quick questions, helps leadership make better decisions.</p>
      </div>` : ''}
      ${openOoo ? `<div class="burnout-alert" style="flex:1;min-width:200px;padding:12px 16px;background:rgba(237,165,255,0.06);border-color:rgba(237,165,255,0.25);cursor:pointer" onclick="navigate('oneonone',document.querySelector('[data-view=oneonone]'))">
        <i class="fa-solid fa-comments" style="color:var(--accent)"></i>
        <p><strong style="color:var(--accent)">1-on-1 scheduled</strong> — ${new Date(openOoo.scheduled_date).toLocaleDateString('en-ZA',{weekday:'short',day:'numeric',month:'short'})}</p>
      </div>` : ''}
      ${stressedCount>=3 ? `<div class="burnout-alert">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <p><strong>Wellbeing check:</strong> You've logged stressed moods recently. Consider talking to your manager or checking the wellbeing resources below.</p>
      </div>` : ''}
    </div>

    <!-- Stats cards -->
    <div class="cards-grid">
      <div class="stat-card" style="cursor:pointer" onclick="navigate('kpis',document.querySelector('[data-view=kpis]'))">
        <div class="stat-card-icon" style="background:rgba(0,212,170,0.15);color:var(--accent2)"><i class="fa-solid fa-chart-bar"></i></div>
        <div class="stat-card-val">${Math.round(Number(kpi.overall_score)||0)}%</div>
        <div class="stat-card-lbl">Overall KPI Score</div>
        <div class="stat-card-trend up"><i class="fa-solid fa-arrow-trend-up"></i> View breakdown →</div>
      </div>
      <div class="stat-card" style="cursor:pointer" onclick="navigate('okrs',document.querySelector('[data-view=okrs]'))">
        <div class="stat-card-icon" style="background:rgba(237,165,255,0.15);color:var(--accent)"><i class="fa-solid fa-bullseye"></i></div>
        <div class="stat-card-val">${myOkr?Math.round(Number(myOkr.overall_progress)||0)+'%':'—'}</div>
        <div class="stat-card-lbl">OKR Progress</div>
        <div class="stat-card-trend up"><i class="fa-solid fa-arrow-right"></i> View OKRs →</div>
      </div>
      <div class="stat-card" style="cursor:pointer" onclick="navigate('courses',document.querySelector('[data-view=courses]'))">
        <div class="stat-card-icon" style="background:rgba(249,200,70,0.15);color:var(--gold)"><i class="fa-solid fa-graduation-cap"></i></div>
        <div class="stat-card-val">${_progress.filter(p=>p.status==='in_progress').length}</div>
        <div class="stat-card-lbl">Courses In Progress</div>
        <div class="stat-card-trend up">${done} completed total →</div>
      </div>
      <div class="stat-card" style="cursor:pointer" onclick="navigate('feedback',document.querySelector('[data-view=feedback]'))">
        <div class="stat-card-icon" style="background:rgba(253,121,168,0.15);color:#fd79a8"><i class="fa-solid fa-hands-clapping"></i></div>
        <div class="stat-card-val">${_peerFeedback.filter(f=>f.to_employee_id===_emp.id).length}</div>
        <div class="stat-card-lbl">Kudos Received</div>
        <div class="stat-card-trend up">View all →</div>
      </div>
    </div>

    <!-- Activity Feed preview -->
    <div class="section-head"><i class="fa-solid fa-bolt"></i> Recent Activity</div>
    <div class="chart-container" style="padding:16px 20px">
      ${recentFeed.length ? recentFeed.map(f=>`
        <div class="feed-item">
          <div class="feed-icon-wrap" style="background:${f.color||'#eda5ff'}20;color:${f.color||'#eda5ff'}">
            <i class="fa-solid ${f.icon||'fa-bolt'}"></i>
          </div>
          <div class="feed-body">
            <strong>${f.title||''}</strong>
            <p>${f.body||''}</p>
            <div class="feed-time">${timeAgo(f.created_at)}</div>
          </div>
          ${Number(f.xp_shown)>0?`<div class="feed-xp">+${f.xp_shown} XP</div>`:''}
        </div>`).join('') : `<div class="empty-state"><i class="fa-solid fa-bolt"></i><p>No recent activity yet.</p></div>`}
      <button class="btn btn--ghost btn--sm mt-2" onclick="navigate('feed',document.querySelector('[data-view=feed]'))">
        View all activity <i class="fa-solid fa-arrow-right"></i>
      </button>
    </div>

    <!-- My Profile Summary -->
    <div class="section-head" style="margin-top:28px"><i class="fa-solid fa-id-card"></i> My Profile</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">

      <div class="chart-container" style="padding:20px">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
          <div style="width:52px;height:52px;border-radius:14px;background:${_emp.avatar_color||'#eda5ff'};display:flex;align-items:center;justify-content:center;font-size:1.3rem;font-weight:800;color:#fff;flex-shrink:0">${_emp.avatar_initials||(_emp.first_name||'?')[0]}</div>
          <div>
            <div style="font-size:1rem;font-weight:700">${_emp.first_name} ${_emp.last_name}</div>
            <div style="font-size:0.78rem;color:var(--muted)">${_emp.role||'—'} · ${_emp.department||'—'}</div>
            ${_emp.employee_number ? `<div style="font-size:0.7rem;font-family:monospace;color:var(--accent);margin-top:2px">${_emp.employee_number}</div>` : ''}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:7px">
          <div style="display:flex;align-items:center;gap:8px;font-size:0.8rem">
            <i class="fa-solid fa-envelope" style="color:var(--muted);width:14px;text-align:center"></i>
            <span style="color:var(--muted);min-width:80px;font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Email</span>
            <span style="color:var(--text)">${_emp.email||'—'}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;font-size:0.8rem">
            <i class="fa-solid fa-phone" style="color:var(--muted);width:14px;text-align:center"></i>
            <span style="color:var(--muted);min-width:80px;font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Phone</span>
            <span style="color:${_emp.phone?'var(--text)':'var(--muted)'}">${_emp.phone||'Not set'}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;font-size:0.8rem">
            <i class="fa-solid fa-location-dot" style="color:var(--muted);width:14px;text-align:center"></i>
            <span style="color:var(--muted);min-width:80px;font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Address</span>
            <span style="color:${_emp.address_city?'var(--text)':'var(--muted)'}">${_emp.address_city?[_emp.address_city,_emp.address_province].filter(Boolean).join(', '):'Not set'}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;font-size:0.8rem">
            <i class="fa-solid fa-id-badge" style="color:var(--muted);width:14px;text-align:center"></i>
            <span style="color:var(--muted);min-width:80px;font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">ID Number</span>
            <span style="color:${_emp.id_number?'var(--text)':'var(--muted)'}">${_emp.id_number?'••••••••••••••':'Not uploaded'}</span>
          </div>
        </div>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
          <button class="btn btn--primary btn--sm" onclick="navigate('profile',document.querySelector('[data-view=profile]'))">
            <i class="fa-solid fa-pen"></i> Edit My Profile
          </button>
        </div>
      </div>

      <div class="chart-container" style="padding:20px">
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:14px">Account Status</div>
        ${[
          ['fa-building-columns','Banking Details', _emp.bank_account_number ? 'Configured' : 'Not set', !!_emp.bank_account_number],
          ['fa-file-image','Proof of Banking', _emp.proof_of_banking_url ? 'Uploaded' : 'Missing', !!_emp.proof_of_banking_url],
          ['fa-id-card','Proof of ID', _emp.proof_of_id_url ? 'Uploaded' : 'Not uploaded', !!_emp.proof_of_id_url],
          ['fa-location-dot','Home Address', (_emp.address_line1||_emp.address_city) ? 'On file' : 'Not set', !!((_emp.address_line1||_emp.address_city))],
          ['fa-file-invoice-dollar','Payslips', _payslips.length ? `${_payslips.length} on file` : 'None yet', _payslips.length > 0],
        ].map(([icon,label,val,ok])=>`
          <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
            <i class="fa-solid ${icon}" style="color:var(--muted);width:14px;text-align:center;font-size:0.82rem"></i>
            <span style="flex:1;font-size:0.8rem;color:var(--text)">${label}</span>
            <span style="font-size:0.72rem;font-weight:600;padding:2px 8px;border-radius:20px;${ok?'background:rgba(0,212,170,0.12);color:var(--accent2)':'background:rgba(255,91,91,0.1);color:var(--danger)'}">${val}</span>
          </div>`).join('')}
        <div style="margin-top:14px">
          <button class="btn btn--ghost btn--sm" onclick="navigate('profile',document.querySelector('[data-view=profile]'))">
            View full profile <i class="fa-solid fa-arrow-right"></i>
          </button>
        </div>
      </div>

    </div>

    <!-- Team Events -->
    <div class="section-head" style="margin-top:28px;display:flex;align-items:center">
      <i class="fa-solid fa-calendar-star"></i> Team Events
      <a href="#" onclick="navigate('calendar',document.querySelector('[data-view=calendar]'));return false"
         style="margin-left:auto;font-size:0.72rem;font-weight:600;color:var(--accent);text-decoration:none">
        Full calendar <i class="fa-solid fa-arrow-right" style="font-size:0.65rem"></i>
      </a>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:8px">

      <!-- Upcoming Birthdays -->
      <div class="chart-container" style="padding:20px">
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:14px">
          <i class="fa-solid fa-cake-candles" style="color:#fec24f;margin-right:5px"></i>Upcoming Birthdays
        </div>
        ${upcomingBirthdays.length ? upcomingBirthdays.map(({ emp, bdStr, daysUntil }) => {
          const label = daysUntil === 0 ? '🎉 Today!' : daysUntil === 1 ? 'Tomorrow' : `in ${daysUntil} day${daysUntil!==1?'s':''}`;
          const dateLabel = new Date(bdStr+'T12:00:00Z').toLocaleDateString('en-ZA',{day:'numeric',month:'short'});
          return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
            <div style="width:32px;height:32px;border-radius:50%;background:${emp.avatar_color||'#eda5ff'};display:flex;align-items:center;justify-content:center;font-size:0.68rem;font-weight:800;color:#fff;flex-shrink:0">${emp.avatar_initials||(emp.first_name||'?')[0]}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:0.82rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${emp.first_name} ${emp.last_name}</div>
              <div style="font-size:0.72rem;color:var(--muted)">${dateLabel}</div>
            </div>
            <span style="font-size:0.7rem;font-weight:600;padding:2px 8px;border-radius:20px;white-space:nowrap;background:rgba(249,200,70,0.12);color:#fec24f">${label}</span>
          </div>`;
        }).join('')
        : `<div style="font-size:0.82rem;color:var(--muted);padding:8px 0"><i class="fa-solid fa-calendar-check" style="margin-right:6px"></i>No birthdays in the next 30 days.</div>`}
      </div>

      <!-- On Leave Today -->
      <div class="chart-container" style="padding:20px">
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:14px">
          <i class="fa-solid fa-umbrella-beach" style="color:var(--accent);margin-right:5px"></i>On Leave Today
        </div>
        <div id="dash-leave-today" style="font-size:0.82rem;color:var(--muted)">
          <i class="fa-solid fa-circle-notch fa-spin" style="font-size:0.85rem;margin-right:6px"></i>Loading…
        </div>
      </div>

    </div>`;

  // Populate "On Leave Today" async after the DOM is painted
  get('tables/leave-calendar').then(res => {
    const leaveToday = (res.data || []).filter(l => l.start_date <= todayISO && l.end_date >= todayISO);
    const slot = document.getElementById('dash-leave-today');
    if (!slot) return;
    if (!leaveToday.length) {
      slot.innerHTML = `<span style="color:var(--accent2)"><i class="fa-solid fa-circle-check" style="margin-right:5px"></i>Nobody on leave today.</span>`;
      return;
    }
    slot.innerHTML = leaveToday.map(l => {
      const emp = _employees.find(e => e.id === l.employee_id) || l;
      const initials = emp.avatar_initials || ((emp.first_name||'?')[0] + (emp.last_name||'')[0]).toUpperCase();
      return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
        <div style="width:32px;height:32px;border-radius:50%;background:${emp.avatar_color||'#eda5ff'};display:flex;align-items:center;justify-content:center;font-size:0.68rem;font-weight:800;color:#fff;flex-shrink:0">${initials}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:0.82rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${emp.first_name||''} ${emp.last_name||''}</div>
          <div style="font-size:0.72rem;color:var(--muted)">${l.leave_type||'Leave'} · back ${l.end_date}</div>
        </div>
      </div>`;
    }).join('');
  }).catch(() => {
    const slot = document.getElementById('dash-leave-today');
    if (slot) slot.innerHTML = `<span style="color:var(--muted)">Could not load leave data.</span>`;
  });
}

/* ═══ VIEW: COURSES ═════════════════════════════════════════════════ */
function renderCourses() {
  const myCourseIds = _progress.map(p=>p.course_id);
  const myActive = _courses.filter(c=>myCourseIds.includes(c.id));
  const recommended = _courses.filter(c=>
    !myCourseIds.includes(c.id) && (c.role_target===_emp.role||c.role_target==='all')
  ).slice(0,6);
  const completedIds = _progress.filter(p=>p.status==='completed').map(p=>p.course_id);

  const el = document.getElementById('view-courses');
  el.innerHTML = `
    <div class="view-header">
      <div><h1>My Learning</h1><div class="view-sub">Courses, certificates &amp; AI-generated learning</div></div>
      <div class="view-header-actions">
        <button class="btn btn--primary" onclick="openAiGenModal()"><i class="fa-solid fa-robot"></i> AI Generate</button>
      </div>
    </div>

    <!-- AI Banner -->
    <div class="ai-banner">
      <div class="ai-banner-icon"><i class="fa-solid fa-brain"></i></div>
      <div class="ai-banner-text">
        <h3>AI Course Generator</h3>
        <p>Tell us what you want to learn and we'll instantly generate a structured 3-module course with quizzes, key points, and automatic KPI boosts.</p>
      </div>
      <button class="btn btn--primary" onclick="openAiGenModal()"><i class="fa-solid fa-plus"></i> Create Course</button>
    </div>

    <!-- In Progress -->
    ${myActive.length ? `<div class="section-head"><i class="fa-solid fa-play"></i> In Progress <span class="section-count">${myActive.filter(c=>!completedIds.includes(c.id)).length}</span></div>
    <div class="courses-grid">
      ${myActive.filter(c=>!completedIds.includes(c.id)).map(c=>courseCardHTML(c,'inprog')).join('')}
    </div>` : ''}

    <!-- Completed -->
    ${completedIds.length ? `<div class="section-head"><i class="fa-solid fa-check-circle"></i> Completed <span class="section-count">${completedIds.length}</span></div>
    <div class="courses-grid">
      ${myActive.filter(c=>completedIds.includes(c.id)).map(c=>courseCardHTML(c,'done')).join('')}
    </div>` : ''}

    <!-- Recommended -->
    <div class="section-head"><i class="fa-solid fa-sparkles"></i> Recommended for You <span class="section-count">${recommended.length}</span></div>
    <div class="courses-grid">
      ${recommended.map(c=>courseCardHTML(c,'rec')).join('')}
      ${!recommended.length?`<div class="empty-state"><i class="fa-solid fa-check"></i><p>You've enrolled in all available courses!</p></div>`:''}
    </div>`;
}

function courseCardHTML(c, mode) {
  const prog = _progress.find(p=>p.course_id===c.id);
  const pct  = prog ? Math.round((Number(prog.modules_completed)||0)/(Number(c.modules_count)||1)*100) : 0;
  const isDone = prog?.status==='completed';
  const diffC = {beginner:'#00d4aa',intermediate:'#fec24f',advanced:'#ff6b6b'}[c.difficulty]||'#6b7280';
  return `<div class="course-card ${isDone?'completed':''}" onclick="${isDone?`openCertificateByProgress('${prog?.id}')`:`openCourse('${c.id}')`}">
    <div class="course-banner" style="background:${c.thumbnail_color||'#eda5ff'}20">
      <i class="fa-solid ${c.thumbnail_icon||'fa-book'}" style="color:${c.thumbnail_color||'#eda5ff'}"></i>
      <span class="diff-badge" style="background:${diffC}20;color:${diffC}">${c.difficulty||'intermediate'}</span>
      ${isDone?`<span style="position:absolute;top:8px;left:8px;font-size:0.65rem;font-weight:700;padding:2px 8px;border-radius:10px;background:rgba(0,212,170,0.2);color:var(--accent2)">✓ Done</span>`:''}
    </div>
    <div class="course-progress-bar"><div class="course-progress-bar-fill" style="width:${pct}%"></div></div>
    <div class="course-body">
      <h4>${c.title}</h4>
      <p>${(c.description||'').slice(0,80)}${(c.description||'').length>80?'…':''}</p>
    </div>
    <div class="course-footer">
      <i class="fa-regular fa-clock"></i> ${c.estimated_minutes||30}m &nbsp;
      <i class="fa-solid fa-layer-group"></i> ${c.modules_count||3} modules
      ${isDone?`<span class="xp-chip" style="background:rgba(0,212,170,0.15);color:var(--accent2)">✓ Certificate</span>`:`<span class="xp-chip">+${c.xp_reward||100} XP</span>`}
    </div>
  </div>`;
}

/* ═══ VIEW: MY KPIs ═════════════════════════════════════════════════ */
function renderMyKpis() {
  const thisMonth = new Date().toISOString().slice(0,7);
  const kpi = _kpiScores.find(k=>k.period_month===thisMonth)||_kpiScores[0]||{};
  const history = _kpiScores.slice().sort((a,b)=>b.period_month.localeCompare(a.period_month)).slice(0,6);
  const el = document.getElementById('view-kpis');
  el.innerHTML = `
    <div class="view-header"><div><h1>My KPIs</h1><div class="view-sub">Performance across 8 dimensions + trend charts</div></div></div>
    <div class="two-col">
      <div>
        <div class="section-head"><i class="fa-solid fa-chart-bar"></i> Current Period: ${kpi.period_month||thisMonth}</div>
        ${KPI_DIMS.map(dim=>{
          const val = Math.round(Number(kpi[dim])||0);
          const col = kpiColor(val);
          return `<div class="kpi-dim-row">
            <div class="kpi-dim-label">${KPI_LABELS[dim]}</div>
            <div class="kpi-track"><div class="kpi-fill" style="width:${val}%;background:${col}"></div></div>
            <div class="kpi-val" style="color:${col}">${val}</div>
          </div>`;
        }).join('')}
        <div class="section-head mt-3"><i class="fa-solid fa-link"></i> Course → KPI Map</div>
        <div class="chart-container">
          ${_courses.filter(c=>c.kpi_dimension).slice(0,5).map(c=>`
            <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:0.8rem">
              <i class="fa-solid ${c.thumbnail_icon||'fa-book'}" style="color:${c.thumbnail_color};width:16px"></i>
              <span style="flex:1">${c.title}</span>
              <span class="chip chip-purple">+${c.kpi_boost_points||5} ${KPI_LABELS[c.kpi_dimension]||c.kpi_dimension}</span>
            </div>`).join('')}
        </div>
      </div>
      <div>
        <div class="section-head"><i class="fa-solid fa-chart-line"></i> Trend (Last 6 Months)</div>
        <div class="chart-container" style="height:280px">
          <canvas id="kpi-trend-chart"></canvas>
        </div>
        <div class="section-head mt-2"><i class="fa-solid fa-spider-web"></i> Dimension Radar</div>
        <div class="chart-container" style="height:280px">
          <canvas id="kpi-radar-chart"></canvas>
        </div>
      </div>
    </div>
    <div class="section-head mt-2"><i class="fa-solid fa-table"></i> Score History</div>
    <div class="data-table-wrap chart-container" style="padding:0">
      <table class="data-table">
        <thead><tr><th>Period</th>${KPI_DIMS.map(d=>`<th>${KPI_LABELS[d].split(' ')[0]}</th>`).join('')}<th>Overall</th></tr></thead>
        <tbody>${history.map(k=>`<tr>
          <td>${k.period_month}</td>
          ${KPI_DIMS.map(d=>`<td style="color:${kpiColor(Number(k[d])||0)}">${Math.round(Number(k[d])||0)}</td>`).join('')}
          <td style="font-weight:700;color:${kpiColor(Number(k.overall_score)||0)}">${Math.round(Number(k.overall_score)||0)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  // Draw charts
  setTimeout(()=>drawKpiCharts(history, kpi), 50);
}

function drawKpiCharts(history, current) {
  const trendCtx = document.getElementById('kpi-trend-chart');
  const radarCtx = document.getElementById('kpi-radar-chart');
  if (!trendCtx || !radarCtx) return;
  const labels = history.map(k=>k.period_month).reverse();
  if (window._kpiTrendChart) window._kpiTrendChart.destroy();
  window._kpiTrendChart = new Chart(trendCtx, {
    type:'line',
    data: {
      labels,
      datasets:[{
        label:'Overall KPI',
        data: history.map(k=>Math.round(Number(k.overall_score)||0)).reverse(),
        borderColor:'#eda5ff',backgroundColor:'rgba(237,165,255,0.1)',
        fill:true, tension:0.4, pointBackgroundColor:'#eda5ff', pointRadius:4
      },{
        label:'Revenue',
        data: history.map(k=>Math.round(Number(k.revenue_contribution)||0)).reverse(),
        borderColor:'#00d4aa',backgroundColor:'transparent',
        tension:0.4, pointRadius:3, borderDash:[4,4]
      }]
    },
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{labels:{color:'#6b7280',font:{size:10}}}},
      scales:{x:{ticks:{color:'#6b7280',font:{size:10}},grid:{color:'rgba(255,255,255,0.04)'}},
              y:{min:0,max:100,ticks:{color:'#6b7280',font:{size:10}},grid:{color:'rgba(255,255,255,0.04)'}}}}
  });
  if (window._kpiRadarChart) window._kpiRadarChart.destroy();
  window._kpiRadarChart = new Chart(radarCtx, {
    type:'radar',
    data:{
      labels: KPI_DIMS.map(d=>KPI_LABELS[d].split(' ')[0]),
      datasets:[{
        label:'This Month',
        data: KPI_DIMS.map(d=>Math.round(Number(current[d])||0)),
        borderColor:'#eda5ff',backgroundColor:'rgba(237,165,255,0.15)',
        pointBackgroundColor:'#eda5ff'
      }]
    },
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{labels:{color:'#6b7280',font:{size:10}}}},
      scales:{r:{min:0,max:100,ticks:{display:false},grid:{color:'rgba(255,255,255,0.06)'},
                 pointLabels:{color:'#6b7280',font:{size:10}},
                 angleLines:{color:'rgba(255,255,255,0.06)'}}}}
  });
}

/* ═══ VIEW: OKRs ════════════════════════════════════════════════════ */
function renderOkrs() {
  const myOkrs = _okrs.filter(o=>o.employee_id===_emp.id).sort((a,b)=>b.period_month.localeCompare(a.period_month));
  const el = document.getElementById('view-okrs');
  el.innerHTML = `
    <div class="view-header">
      <div><h1>My OKRs</h1><div class="view-sub">Objectives &amp; Key Results — linked to KPI boosts</div></div>
      <div class="view-header-actions">
        <button class="btn btn--primary" onclick="openOkrModal()"><i class="fa-solid fa-plus"></i> New OKR</button>
      </div>
    </div>
    ${!myOkrs.length ? `<div class="empty-state"><i class="fa-solid fa-bullseye"></i><h3>No OKRs yet</h3><p>Set your first Objective &amp; Key Results to get started.</p></div>` : ''}
    ${myOkrs.map(okr=>okrCardHTML(okr)).join('')}`;
}

function okrCardHTML(okr) {
  const overall = Math.round(Number(okr.overall_progress)||0);
  const statusColors = {on_track:'var(--accent2)',at_risk:'var(--warn)',completed:'var(--accent2)',draft:'var(--muted)'};
  const sc = statusColors[okr.status]||'var(--muted)';
  const krs = [
    {label:'KR1',text:okr.kr1_text,prog:Number(okr.kr1_progress)||0,target:Number(okr.kr1_target)||100},
    {label:'KR2',text:okr.kr2_text,prog:Number(okr.kr2_progress)||0,target:Number(okr.kr2_target)||100},
    {label:'KR3',text:okr.kr3_text,prog:Number(okr.kr3_progress)||0,target:Number(okr.kr3_target)||100},
  ].filter(kr=>kr.text);
  return `<div class="okr-card">
    <div class="okr-header">
      <div class="okr-icon"><i class="fa-solid fa-bullseye"></i></div>
      <div style="flex:1">
        <div class="okr-objective">${okr.objective||'Untitled OKR'}</div>
        <div class="okr-period">${okr.period_month} &middot; <span class="okr-status-chip" style="background:${sc}20;color:${sc}">${okr.status||'draft'}</span></div>
        ${okr.kpi_dimension?`<div style="font-size:0.72rem;color:var(--muted);margin-top:4px">
          <i class="fa-solid fa-link"></i> Completion boosts <strong>${KPI_LABELS[okr.kpi_dimension]||okr.kpi_dimension}</strong> by +${okr.kpi_boost_on_complete||10} pts
        </div>`:''}
      </div>
      <div class="okr-overall">
        <div class="okr-pct">${overall}%</div>
        <div class="okr-pct-lbl">Overall</div>
      </div>
    </div>
    ${krs.map(kr=>`<div class="kr-row">
      <div class="kr-top">
        <span class="kr-label">${kr.label}</span>
        <span class="kr-text">${kr.text}</span>
        <span class="kr-pct" style="color:${kpiColor(kr.prog)}">${Math.round(kr.prog)}%</span>
      </div>
      <div class="kr-track"><div class="kr-fill" style="width:${kr.prog}%;background:${kpiColor(kr.prog)}"></div></div>
    </div>`).join('')}
    ${okr.manager_notes?`<div class="oneone-section"><div class="oneone-section-title">Manager Note</div><p>${okr.manager_notes}</p></div>`:''}
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn--ghost btn--sm" onclick="openOkrProgress('${okr.id}')"><i class="fa-solid fa-pen"></i> Update Progress</button>
      ${overall>=100?`<button class="btn btn--success btn--sm" onclick="completeOkr('${okr.id}')"><i class="fa-solid fa-star"></i> Mark Complete</button>`:''}
    </div>
  </div>`;
}

function openOkrModal(id) {
  const okr = id ? _okrs.find(o=>o.id===id) : null;
  const m = document.getElementById('generic-modal');
  m.innerHTML = `<div class="modal">
    <div class="modal-header"><h3>${okr?'Edit OKR':'New OKR'}</h3><button class="btn btn--ghost btn--sm" onclick="closeModal('generic-modal')"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="modal-body">
      <div class="form-group"><label>Objective</label><input id="okr-obj" value="${okr?.objective||''}" placeholder="e.g. Grow AUM by 15% this quarter" /></div>
      <div class="form-group"><label>Key Result 1</label><input id="okr-kr1" value="${okr?.kr1_text||''}" placeholder="e.g. Close R25M in new mandates" /></div>
      <div class="form-group"><label>Key Result 2</label><input id="okr-kr2" value="${okr?.kr2_text||''}" placeholder="e.g. Onboard 3 new HNW clients" /></div>
      <div class="form-group"><label>Key Result 3</label><input id="okr-kr3" value="${okr?.kr3_text||''}" placeholder="e.g. Achieve 90%+ client satisfaction" /></div>
      <div class="form-row">
        <div class="form-group"><label>Period</label><input id="okr-period" value="${okr?.period_month||new Date().toISOString().slice(0,7)}" /></div>
        <div class="form-group"><label>KPI Dimension</label>
          <select id="okr-dim">${KPI_DIMS.map(d=>`<option value="${d}" ${okr?.kpi_dimension===d?'selected':''}>${KPI_LABELS[d]}</option>`).join('')}</select>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn--secondary" onclick="closeModal('generic-modal')">Cancel</button>
      <button class="btn btn--primary" onclick="submitOkr('${id||''}')">Save OKR</button>
    </div>
  </div>`;
  document.getElementById('generic-modal').classList.add('open');
}

async function submitOkr(id) {
  const obj = document.getElementById('okr-obj').value.trim();
  if (!obj) { showToast('Objective is required','error'); return; }
  const data = {
    employee_id:_emp.id, period_month:document.getElementById('okr-period').value,
    objective:obj, kr1_text:document.getElementById('okr-kr1').value,
    kr2_text:document.getElementById('okr-kr2').value, kr3_text:document.getElementById('okr-kr3').value,
    kr1_progress:0,kr2_progress:0,kr3_progress:0,overall_progress:0,
    kpi_dimension:document.getElementById('okr-dim').value, kpi_boost_on_complete:10,
    status:'on_track', created_at:new Date().toISOString()
  };
  if (id) { const r=await patch(`tables/okrs/${id}`,data); Object.assign(_okrs.find(o=>o.id===id)||{},r); }
  else { const r=await post('tables/okrs',data); _okrs.push(r); }
  closeModal('generic-modal');
  renderOkrs();
  showToast('OKR saved!','success');
}

function openOkrProgress(id) {
  const okr = _okrs.find(o=>o.id===id); if(!okr) return;
  const m = document.getElementById('generic-modal');
  m.innerHTML = `<div class="modal">
    <div class="modal-header"><h3>Update OKR Progress</h3><button class="btn btn--ghost btn--sm" onclick="closeModal('generic-modal')"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="modal-body">
      ${[1,2,3].filter(n=>okr[`kr${n}_text`]).map(n=>`
        <div class="form-group">
          <label>KR${n}: ${okr[`kr${n}_text`]}</label>
          <div style="display:flex;align-items:center;gap:10px">
            <input type="range" min="0" max="100" value="${okr[`kr${n}_progress`]||0}" id="kr${n}-slider"
                   oninput="document.getElementById('kr${n}-val').textContent=this.value+'%'"
                   style="flex:1;accent-color:var(--accent)" />
            <span id="kr${n}-val" style="min-width:36px;font-weight:700">${okr[`kr${n}_progress`]||0}%</span>
          </div>
        </div>`).join('')}
    </div>
    <div class="modal-footer">
      <button class="btn btn--secondary" onclick="closeModal('generic-modal')">Cancel</button>
      <button class="btn btn--primary" onclick="saveOkrProgress('${id}')">Save Progress</button>
    </div>
  </div>`;
  document.getElementById('generic-modal').classList.add('open');
}

async function saveOkrProgress(id) {
  const okr = _okrs.find(o=>o.id===id); if(!okr) return;
  const krs = [1,2,3].filter(n=>okr[`kr${n}_text`]);
  const vals = krs.map(n=>Number(document.getElementById(`kr${n}-slider`)?.value||0));
  const overall = Math.round(vals.reduce((s,v)=>s+v,0)/vals.length);
  const updates = {};
  krs.forEach((n,i)=>{ updates[`kr${n}_progress`]=vals[i]; });
  updates.overall_progress = overall;
  if (overall>=100) updates.status='completed';
  const r = await patch(`tables/okrs/${id}`, updates);
  Object.assign(okr, r);
  closeModal('generic-modal');
  if (overall>=100) await completeOkr(id, true);
  else renderOkrs();
  showToast('OKR progress updated!','success');
}

async function completeOkr(id, alreadyUpdated=false) {
  const okr = _okrs.find(o=>o.id===id); if(!okr) return;
  if (!alreadyUpdated) {
    const r=await patch(`tables/okrs/${id}`,{status:'completed',overall_progress:100});
    Object.assign(okr,r);
  }
  if (okr.kpi_dimension) await autoBoostKpi(okr.kpi_dimension, Number(okr.kpi_boost_on_complete)||10);
  await awardXP(100, 'OKR completed');
  showToast('🎯 OKR Completed! KPI boost applied + 100 XP earned!','success');
  renderOkrs();
}

/* ═══ VIEW: FEEDBACK / KUDOS ════════════════════════════════════════ */
function renderFeedback() {
  const received = _peerFeedback.filter(f=>f.to_employee_id===_emp.id);
  const given    = _peerFeedback.filter(f=>f.from_employee_id===_emp.id);
  const public360 = _peerFeedback.filter(f=>isTrue(f.is_public)).slice(0,20);

  function empName(id) { const e=_employees.find(e=>e.id===id); return e?`${e.first_name} ${e.last_name}`:'Team Member'; }
  function empAv(id)   { const e=_employees.find(e=>e.id===id); return {init:e?.avatar_initials||'?',col:e?.avatar_color||'#eda5ff'}; }

  const el = document.getElementById('view-feedback');
  el.innerHTML = `
    <div class="view-header">
      <div><h1>Feedback &amp; Kudos</h1><div class="view-sub">Recognition wall, 360° feedback &amp; give kudos</div></div>
      <div class="view-header-actions">
        <button class="btn btn--primary" onclick="openKudosModal()"><i class="fa-solid fa-hands-clapping"></i> Give Kudos</button>
        <button class="btn btn--secondary" onclick="openFeedbackModal()"><i class="fa-solid fa-comments"></i> 360° Feedback</button>
      </div>
    </div>

    <!-- Give Kudos quick form -->
    <div class="give-kudos-form">
      <h4><i class="fa-solid fa-star text-gold"></i> &nbsp;Recognise a Teammate</h4>
      <div class="form-row">
        <div class="form-group"><label>To</label>
          <select id="kudos-to">
            ${_employees.filter(e=>e.id!==_emp.id).map(e=>`<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>KPI Dimension</label>
          <select id="kudos-dim">${KPI_DIMS.map(d=>`<option value="${d}">${KPI_LABELS[d]}</option>`).join('')}</select>
        </div>
      </div>
      <div class="form-group"><label>Your message</label>
        <textarea id="kudos-msg" rows="2" placeholder="What did they do that impressed you?"></textarea>
      </div>
      <button class="btn btn--primary" onclick="submitKudos()"><i class="fa-solid fa-paper-plane"></i> Send Kudos (+25 XP)</button>
    </div>

    <div class="feedback-tabs">
      <button class="feedback-tab active" onclick="switchFeedbackTab('received',this)">Received (${received.length})</button>
      <button class="feedback-tab" onclick="switchFeedbackTab('given',this)">Given (${given.length})</button>
      <button class="feedback-tab" onclick="switchFeedbackTab('team',this)">Team Wall</button>
    </div>

    <div id="feedback-panel">
      ${received.map(f=>{const av=empAv(f.from_employee_id); return `
        <div class="kudos-card">
          <div class="kudos-avatar" style="background:${av.col}">${av.init}</div>
          <div class="kudos-body">
            <div class="kudos-top">
              <span class="kudos-from">${empName(f.from_employee_id)}</span>
              <span class="kudos-kpi">${KPI_LABELS[f.kpi_dimension]||f.kpi_dimension}</span>
              <span class="kudos-time">${timeAgo(f.created_at)}</span>
            </div>
            <div class="kudos-msg">${f.message||''}</div>
            ${f.xp_awarded?`<div class="kudos-xp">+${f.xp_awarded} XP awarded to them</div>`:''}
          </div>
          ${f.type==='kudos'?`<span style="font-size:1.4rem">👏</span>`:`<span style="font-size:1.4rem">💬</span>`}
        </div>`}).join('') || `<div class="empty-state"><i class="fa-solid fa-heart"></i><p>No kudos received yet. You've got this!</p></div>`}
    </div>`;
}

function switchFeedbackTab(tab, btn) {
  document.querySelectorAll('.feedback-tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  const panel = document.getElementById('feedback-panel');
  const received = _peerFeedback.filter(f=>f.to_employee_id===_emp.id);
  const given    = _peerFeedback.filter(f=>f.from_employee_id===_emp.id);
  const teamPub  = _peerFeedback.filter(f=>isTrue(f.is_public)&&f.type==='kudos').slice(0,20);
  function empName(id) { const e=_employees.find(e=>e.id===id); return e?`${e.first_name} ${e.last_name}`:'Team Member'; }
  function empAv(id)   { const e=_employees.find(e=>e.id===id); return {init:e?.avatar_initials||'?',col:e?.avatar_color||'#eda5ff'}; }
  const list = tab==='received'?received:tab==='given'?given:teamPub;
  panel.innerHTML = list.map(f=>{
    const av = empAv(tab==='received'?f.from_employee_id:tab==='given'?f.to_employee_id:f.from_employee_id);
    const name = tab==='received'?empName(f.from_employee_id):tab==='given'?empName(f.to_employee_id):
      `${empName(f.from_employee_id)} → ${empName(f.to_employee_id)}`;
    return `<div class="kudos-card">
      <div class="kudos-avatar" style="background:${av.col}">${av.init}</div>
      <div class="kudos-body">
        <div class="kudos-top">
          <span class="kudos-from">${name}</span>
          <span class="kudos-kpi">${KPI_LABELS[f.kpi_dimension]||f.kpi_dimension}</span>
          <span class="kudos-time">${timeAgo(f.created_at)}</span>
        </div>
        <div class="kudos-msg">${f.message||''}</div>
      </div>
      ${f.type==='kudos'?`<span style="font-size:1.4rem">👏</span>`:`<span style="font-size:1.4rem">💬</span>`}
    </div>`;
  }).join('') || `<div class="empty-state"><i class="fa-solid fa-comment-slash"></i><p>Nothing here yet.</p></div>`;
}

async function submitKudos() {
  const to  = document.getElementById('kudos-to').value;
  const dim = document.getElementById('kudos-dim').value;
  const msg = document.getElementById('kudos-msg').value.trim();
  if (!msg) { showToast('Write a message before sending.','error'); return; }
  const rec = await post('tables/peer_feedback',{
    from_employee_id:_emp.id, to_employee_id:to, type:'kudos',
    kpi_dimension:dim, message:msg, rating:5, is_public:true,
    period_month:new Date().toISOString().slice(0,7),
    created_at:new Date().toISOString(), xp_awarded:25
  });
  _peerFeedback.push(rec);
  document.getElementById('kudos-msg').value='';
  await awardXP(25,'Kudos given');
  showToast('Kudos sent! +25 XP earned.','success');
  renderFeedback();
}

function openKudosModal()   { /* inline form is enough */ showToast('Use the quick form above to send kudos!','info'); }
function openFeedbackModal(){ /* inline form handles it */
  const el = document.getElementById('generic-modal');
  el.innerHTML = `<div class="modal">
    <div class="modal-header"><h3>Give 360° Feedback</h3><button class="btn btn--ghost btn--sm" onclick="closeModal('generic-modal')"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="modal-body">
      <div class="form-group"><label>To</label>
        <select id="fb360-to">${_employees.filter(e=>e.id!==_emp.id).map(e=>`<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('')}</select>
      </div>
      <div class="form-group"><label>KPI Dimension</label>
        <select id="fb360-dim">${KPI_DIMS.map(d=>`<option value="${d}">${KPI_LABELS[d]}</option>`).join('')}</select>
      </div>
      <div class="form-group"><label>Rating (1-5)</label>
        <input type="number" id="fb360-rating" min="1" max="5" value="4" /></div>
      <div class="form-group"><label>Feedback</label>
        <textarea id="fb360-msg" rows="4" placeholder="Constructive, specific, helpful..."></textarea>
      </div>
      <div class="form-group"><label style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" id="fb360-priv" />Make this private (only visible to the recipient)</label>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn--secondary" onclick="closeModal('generic-modal')">Cancel</button>
      <button class="btn btn--primary" onclick="submit360()">Send Feedback (+15 XP)</button>
    </div>
  </div>`;
  el.classList.add('open');
}

async function submit360() {
  const to=document.getElementById('fb360-to').value;
  const msg=document.getElementById('fb360-msg').value.trim();
  if(!msg){showToast('Write feedback first.','error');return;}
  const r=await post('tables/peer_feedback',{
    from_employee_id:_emp.id, to_employee_id:to, type:'360_feedback',
    kpi_dimension:document.getElementById('fb360-dim').value,
    message:msg, rating:Number(document.getElementById('fb360-rating').value)||4,
    is_public:!document.getElementById('fb360-priv').checked,
    period_month:new Date().toISOString().slice(0,7),
    created_at:new Date().toISOString(), xp_awarded:15
  });
  _peerFeedback.push(r);
  closeModal('generic-modal');
  await awardXP(15,'360 feedback given');
  showToast('Feedback sent! +15 XP','success');
}

/* ═══ VIEW: PULSE SURVEY ════════════════════════════════════════════ */
function renderPulse() {
  const active = _pulseSurveys.find(s=>s.status==='active');
  const done   = active && _pulseResp.find(r=>r.employee_id===_emp.id&&r.survey_id===active.id);
  const history= _pulseSurveys.filter(s=>s.status==='closed');
  const el = document.getElementById('view-pulse');
  el.innerHTML = `
    <div class="view-header"><div><h1>Pulse Surveys</h1><div class="view-sub">Weekly 3-question team wellbeing check-in</div></div></div>
    ${done ? `<div class="pulse-submitted">
      <i class="fa-solid fa-check-circle"></i>
      <h3>Already submitted this week!</h3>
      <p>Thanks for your input. Results help leadership make better decisions.</p>
    </div>` : active ? `
    <div class="pulse-card" id="pulse-form">
      <h3>📊 Weekly Pulse — Week ${active.week}</h3>
      <div class="pulse-week">3 quick questions · Takes under 60 seconds</div>
      ${[['r1',active.q1,1],[' r2',active.q2,2],['r3',active.q3,3]].map(([key,q,n])=>`
        <div class="pulse-question">
          <div class="q-text">${n}. ${q}</div>
          <div class="pulse-scale">
            ${[1,2,3,4,5].map(v=>`<button class="pulse-btn" data-key="${key.trim()}" data-val="${v}"
              onclick="selectPulse('${key.trim()}',${v},this)">${v}</button>`).join('')}
          </div>
        </div>`).join('')}
      <div class="pulse-question">
        <div class="q-text">4. eNPS: How likely are you to recommend SV Capital as a great place to work? (0–10)</div>
        <div class="pulse-scale pulse-enps" id="enps-scale">
          ${[0,1,2,3,4,5,6,7,8,9,10].map(v=>`<button class="pulse-btn" data-key="enps" data-val="${v}"
            onclick="selectPulse('enps',${v},this)">${v}</button>`).join('')}
        </div>
      </div>
      <div class="form-group mt-2"><label>Optional: Anything on your mind?</label>
        <textarea id="pulse-comment" rows="2" placeholder="Share any thoughts or blockers..."></textarea>
      </div>
      <button class="btn btn--primary mt-2" onclick="submitPulse('${active.id}','${active.week}')">Submit Pulse +20 XP</button>
    </div>` : `<div class="empty-state"><i class="fa-solid fa-poll"></i><h3>No active survey</h3><p>Check back next Monday!</p></div>`}

    <div class="section-head mt-3"><i class="fa-solid fa-history"></i> Previous Surveys</div>
    ${history.map(s=>{
      const myR = _pulseResp.find(r=>r.employee_id===_emp.id&&r.survey_id===s.id);
      return `<div class="wellbeing-card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>${s.week}</strong>
          ${myR?`<span class="chip chip-green">Submitted</span>`:`<span class="chip chip-gray">Missed</span>`}
        </div>
        ${myR?`<div style="font-size:0.78rem;color:var(--muted);margin-top:6px">
          Energy: <strong>${myR.r1}/5</strong> &nbsp;·&nbsp;
          Clarity: <strong>${myR.r2}/5</strong> &nbsp;·&nbsp;
          Support: <strong>${myR.r3}/5</strong> &nbsp;·&nbsp;
          eNPS: <strong>${myR.enps}/10</strong>
        </div>`:''}
      </div>`;
    }).join('')}`;
  _pulseAnswers={};
}

function selectPulse(key, val, btn) {
  _pulseAnswers[key]=val;
  btn.closest('.pulse-scale').querySelectorAll('.pulse-btn').forEach(b=>b.classList.remove('selected'));
  btn.classList.add('selected');
}

async function submitPulse(surveyId, week) {
  if (!_pulseAnswers.r1||!_pulseAnswers.r2||!_pulseAnswers.r3||_pulseAnswers.enps===undefined) {
    showToast('Please answer all questions first.','error'); return;
  }
  const r = await post('tables/pulse_responses',{
    survey_id:surveyId, employee_id:_emp.id, week,
    r1:_pulseAnswers.r1, r2:_pulseAnswers.r2, r3:_pulseAnswers.r3,
    enps:_pulseAnswers.enps,
    open_comment:document.getElementById('pulse-comment').value||'',
    submitted_at:new Date().toISOString()
  });
  _pulseResp.push(r);
  await awardXP(20,'Pulse survey');
  renderPulse();
  showToast('Pulse submitted! +20 XP','success');
}

/* ═══ VIEW: 1-ON-1s ════════════════════════════════════════════════ */
function renderOneOnOnes() {
  const mine = _oneOnOnes.filter(o=>o.employee_id===_emp.id).sort((a,b)=>new Date(b.scheduled_date)-new Date(a.scheduled_date));
  const el = document.getElementById('view-oneonone');
  el.innerHTML = `
    <div class="view-header">
      <div><h1>1-on-1s</h1><div class="view-sub">Meeting notes, action items &amp; growth conversations</div></div>
      <div class="view-header-actions">
        <button class="btn btn--primary" onclick="openNewOneOnOneModal()"><i class="fa-solid fa-calendar-plus"></i> Request 1-on-1</button>
      </div>
    </div>
    ${!mine.length?`<div class="empty-state"><i class="fa-solid fa-comments"></i><p>No 1-on-1s scheduled yet.</p></div>`:''}
    ${mine.map(o=>{
      let actions=[]; try{actions=JSON.parse(o.action_items||'[]');}catch{}
      const topics = Array.isArray(o.topics)?o.topics:(o.topics||'').split(',').filter(Boolean);
      return `<div class="oneone-card">
        <div class="oneone-header">
          <div class="oneone-date"><i class="fa-solid fa-calendar"></i> ${new Date(o.scheduled_date).toLocaleDateString('en-ZA',{weekday:'short',day:'numeric',month:'long',year:'numeric'})}</div>
          <span class="oneone-status status-${o.status}">${o.status}</span>
          ${o.mood_rating?`<span style="font-size:0.85rem">${['','😓','😔','😐','🙂','😊'][Number(o.mood_rating)||0]||''}</span>`:''}
          ${topics.length?`<div style="display:flex;gap:4px;flex-wrap:wrap">${topics.map(t=>`<span class="chip chip-gray">${t}</span>`).join('')}</div>`:''}
        </div>
        ${o.agenda?`<div class="oneone-section"><div class="oneone-section-title">Agenda</div><p>${o.agenda}</p></div>`:''}
        ${o.employee_notes?`<div class="oneone-section"><div class="oneone-section-title">Your Notes</div><p>${o.employee_notes}</p></div>`:''}
        ${o.manager_notes?`<div class="oneone-section"><div class="oneone-section-title">Manager Notes</div><p>${o.manager_notes}</p></div>`:''}
        ${actions.length?`<div class="oneone-section">
          <div class="oneone-section-title">Action Items</div>
          ${actions.map((a,ai)=>`<div class="action-item ${a.done?'done':''}">
            <div class="action-check" onclick="toggleAction('${o.id}',${ai})">${a.done?'<i class="fa-solid fa-check" style="font-size:0.6rem;color:#fff"></i>':''}</div>
            <span class="action-text">${a.task||a.text||''}</span>
            ${a.due?`<span class="action-due">${a.due}</span>`:''}
          </div>`).join('')}
        </div>`:''}
        ${o.status==='scheduled'?`<button class="btn btn--ghost btn--sm mt-1" onclick="addNotesToOneOnOne('${o.id}')">
          <i class="fa-solid fa-pen"></i> Add my notes
        </button>`:''}
      </div>`;
    }).join('')}`;
}

async function toggleAction(oooId, idx) {
  const o = _oneOnOnes.find(o=>o.id===oooId); if(!o) return;
  let actions=[]; try{actions=JSON.parse(o.action_items||'[]');}catch{}
  if(!actions[idx]) return;
  actions[idx].done = !actions[idx].done;
  const r=await patch(`tables/one_on_ones/${oooId}`,{action_items:JSON.stringify(actions)});
  o.action_items=JSON.stringify(actions);
  renderOneOnOnes();
  if(actions[idx].done) { await awardXP(10,'Action item'); showToast('Action item done! +10 XP','success'); }
}

function addNotesToOneOnOne(id) {
  const o=_oneOnOnes.find(x=>x.id===id); if(!o) return;
  const el=document.getElementById('generic-modal');
  el.innerHTML=`<div class="modal">
    <div class="modal-header"><h3>Add My Notes</h3><button class="btn btn--ghost btn--sm" onclick="closeModal('generic-modal')"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="modal-body">
      <div class="form-group"><label>Agenda points you want to discuss</label>
        <textarea id="ooo-agenda" rows="3" placeholder="Topics you want to raise...">${o.agenda||''}</textarea></div>
      <div class="form-group"><label>Your notes / preparation</label>
        <textarea id="ooo-enotes" rows="4" placeholder="Anything you want to share with your manager...">${o.employee_notes||''}</textarea></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn--secondary" onclick="closeModal('generic-modal')">Cancel</button>
      <button class="btn btn--primary" onclick="saveOneOnOneNotes('${id}')">Save Notes</button>
    </div>
  </div>`;
  el.classList.add('open');
}

async function saveOneOnOneNotes(id) {
  const r=await patch(`tables/one_on_ones/${id}`,{
    agenda:document.getElementById('ooo-agenda').value,
    employee_notes:document.getElementById('ooo-enotes').value
  });
  Object.assign(_oneOnOnes.find(o=>o.id===id)||{},r);
  closeModal('generic-modal');
  renderOneOnOnes();
  showToast('Notes saved!','success');
}

function openNewOneOnOneModal() {
  const el=document.getElementById('generic-modal');
  el.innerHTML=`<div class="modal">
    <div class="modal-header"><h3>Request 1-on-1</h3><button class="btn btn--ghost btn--sm" onclick="closeModal('generic-modal')"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="modal-body">
      <div class="form-group"><label>Preferred Date</label><input type="date" id="ooo-date" /></div>
      <div class="form-group"><label>Topics (comma-separated)</label><input id="ooo-topics" placeholder="development, workload, okr" /></div>
      <div class="form-group"><label>Agenda / What you want to discuss</label>
        <textarea id="ooo-new-agenda" rows="3" placeholder="Describe what you'd like to cover..."></textarea></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn--secondary" onclick="closeModal('generic-modal')">Cancel</button>
      <button class="btn btn--primary" onclick="submitNewOneOnOne()">Request Meeting</button>
    </div>
  </div>`;
  el.classList.add('open');
}

async function submitNewOneOnOne() {
  const d=document.getElementById('ooo-date').value;
  if(!d){showToast('Please select a date.','error');return;}
  const topicsStr=document.getElementById('ooo-topics').value;
  const topics=topicsStr.split(',').map(t=>t.trim()).filter(Boolean);
  const r=await post('tables/one_on_ones',{
    employee_id:_emp.id, manager_id:'MGR001',
    scheduled_date:d+'T10:00:00Z', status:'scheduled',
    agenda:document.getElementById('ooo-new-agenda').value,
    employee_notes:'',manager_notes:'',action_items:'[]',
    mood_rating:0, topics, next_date:'', created_at:new Date().toISOString()
  });
  _oneOnOnes.push(r);
  closeModal('generic-modal');
  renderOneOnOnes();
  showToast('1-on-1 requested!','success');
}

/* ═══ VIEW: LEARNING PATHS ══════════════════════════════════════════ */
function renderPaths() {
  const relevantPaths = _learningPaths.filter(p=>
    p.role_target==='all' || p.role_target===_emp.role ||
    (_emp.department && p.role_target===_emp.department)
  );
  const el = document.getElementById('view-paths');
  el.innerHTML = `
    <div class="view-header"><div><h1>Learning Paths</h1><div class="view-sub">Structured journeys to career growth</div></div></div>
    ${!relevantPaths.length?`<div class="empty-state"><i class="fa-solid fa-road"></i><p>No learning paths available for your role yet.</p></div>`:''}
    ${relevantPaths.map(path=>{
      let courseIds=[]; try{courseIds=Array.isArray(path.course_ids)?path.course_ids:JSON.parse(path.course_ids||'[]');}catch{}
      const total=courseIds.length;
      const done=courseIds.filter(cid=>_progress.find(p=>p.course_id===cid&&p.status==='completed')).length;
      const pct=total?Math.round(done/total*100):0;
      return `<div class="path-card">
        <div class="path-header">
          <div class="path-icon" style="background:${path.thumbnail_color||'#eda5ff'}20;color:${path.thumbnail_color||'#eda5ff'}">
            <i class="fa-solid ${path.thumbnail_icon||'fa-road'}"></i>
          </div>
          <div class="path-info">
            <h4>${path.title}</h4>
            <p>${path.description||''}</p>
            <div class="path-badges mt-1">
              ${isTrue(path.is_mandatory)?`<span class="path-badge-chip mandatory"><i class="fa-solid fa-lock"></i> Mandatory</span>`:''}
              ${path.deadline_days?`<span class="path-badge-chip">${path.deadline_days}d deadline</span>`:''}
              <span class="path-badge-chip"><i class="fa-solid fa-star"></i> +${path.xp_bonus||0} XP on completion</span>
              ${path.badge_reward?`<span class="path-badge-chip"><i class="fa-solid fa-medal"></i> ${path.badge_reward}</span>`:''}
            </div>
          </div>
          <div style="text-align:right;min-width:60px">
            <div style="font-size:1.4rem;font-weight:800;color:${kpiColor(pct)}">${pct}%</div>
            <div style="font-size:0.68rem;color:var(--muted)">${done}/${total} done</div>
          </div>
        </div>
        <div class="kpi-track"><div class="kpi-fill" style="width:${pct}%;background:${path.thumbnail_color||'#eda5ff'}"></div></div>
        <div class="path-steps mt-1">
          ${courseIds.map((cid,i)=>{
            const c=_courses.find(x=>x.id===cid)||{title:cid};
            const isDone=_progress.find(p=>p.course_id===cid&&p.status==='completed');
            const isActive=!isDone&&(!i||courseIds.slice(0,i).every(id=>_progress.find(p=>p.course_id===id&&p.status==='completed')));
            return `<div class="path-step ${isDone?'done':isActive?'active':''}" onclick="${isDone?`openCertificateByProgress('${_progress.find(p=>p.course_id===cid)?.id||''}')`:`openCourse('${cid}')`}">
              ${isDone?`<i class="fa-solid fa-check" style="font-size:0.7rem"></i>`:`<span>${i+1}</span>`}
              ${c.title||cid}
            </div>`;
          }).join('')}
        </div>
        ${pct>=100?`<button class="btn btn--success btn--sm mt-2" onclick="completePath('${path.id}')">
          <i class="fa-solid fa-trophy"></i> Claim Path Reward (+${path.xp_bonus||0} XP)
        </button>`:''}
      </div>`;
    }).join('')}`;
}

async function completePath(pathId) {
  const path=_learningPaths.find(p=>p.id===pathId); if(!path) return;
  await awardXP(Number(path.xp_bonus)||200,'Learning path completed');
  if(path.badge_reward) {
    const b=await post('tables/achievements',{
      employee_id:_emp.id, badge_id:`BADGE-PATH-${pathId}`,
      badge_name:path.badge_reward, badge_icon:'🏆', badge_color:'#fec24f',
      category:'milestone', description:`Completed learning path: ${path.title}`,
      xp_awarded:50, awarded_at:new Date().toISOString(), awarded_by:'system'
    });
    _achievements.push(b);
  }
  showToast(`🏆 Path "${path.title}" complete! +${path.xp_bonus||200} XP and ${path.badge_reward||'badge'} earned!`,'success');
  renderPaths();
}

/* ═══ VIEW: ACTIVITY FEED ═══════════════════════════════════════════ */
function renderActivityFeed() {
  const feed = _activityFeed.filter(f=>f.employee_id===_emp.id)
    .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const el = document.getElementById('view-feed');
  el.innerHTML = `
    <div class="view-header"><div><h1>Activity Feed</h1><div class="view-sub">Your achievements &amp; activity</div></div></div>
    <div class="chart-container" style="padding:16px 20px">
      ${feed.length ? feed.map(f=>`
        <div class="feed-item">
          <div class="feed-icon-wrap" style="background:${f.color||'#eda5ff'}20;color:${f.color||'#eda5ff'}">
            <i class="fa-solid ${f.icon||'fa-bolt'}"></i>
          </div>
          <div class="feed-body">
            <strong>${f.title||''}</strong>
            <p>${f.body||''}</p>
            <div class="feed-time">${timeAgo(f.created_at)}</div>
          </div>
          ${Number(f.xp_shown)>0?`<div class="feed-xp">+${f.xp_shown} XP</div>`:''}
        </div>`).join('')
       : `<div class="empty-state"><i class="fa-solid fa-bolt"></i><p>No activity yet.</p></div>`}
    </div>`;
}

/* ═══ VIEW: CHECK-IN ════════════════════════════════════════════════ */
function renderCheckin() {
  const todayStr = new Date().toDateString();
  const alreadyDone = _checkins.length && new Date(_checkins[0].checkin_date).toDateString()===todayStr;
  const moodEmojis = ['😊','🙂','😐','😔','😓'];
  const moodLabels = ['Excellent','Good','Neutral','Low','Stressed'];
  const streak = Number(_emp.streak_days)||0;
  const recentMoods = _checkins.slice(0,7);
  const el = document.getElementById('view-checkin');

  if (alreadyDone) {
    const today=_checkins[0];
    el.innerHTML=`
      <div class="view-header"><div><h1>Daily Check-in</h1></div></div>
      <div class="checkin-card">
        <div class="flex-gap mb-2"><i class="fa-solid fa-check-circle text-success" style="font-size:1.5rem"></i>
          <h3>You've checked in today! ${today.mood||'🙂'}</h3>
        </div>
        <p class="text-muted">Feeling: ${moodLabels[moodEmojis.indexOf(today.mood)]||today.mood||'—'}</p>
        ${today.tasks_planned?`<p class="text-muted mt-1">Tasks planned: ${today.tasks_planned}</p>`:''}
        <div class="streak-display mt-2"><i class="fa-solid fa-fire"></i> ${streak}-day streak</div>
      </div>
      ${renderCheckinHistory(recentMoods)}`;
    return;
  }

  el.innerHTML=`
    <div class="view-header"><div><h1>Daily Check-in</h1><div class="view-sub">Start your day · Earn XP · Keep your streak</div></div></div>
    <div class="checkin-card">
      <h3>Good ${getTimeOfDay()}, ${_emp.first_name}! 👋</h3>
      <div class="sub">How are you feeling today?</div>
      <div class="mood-grid" id="mood-grid">
        ${moodEmojis.map((e,i)=>`<button class="mood-btn" onclick="selectMood('${e}',this)">
          ${e}<span>${moodLabels[i]}</span></button>`).join('')}
      </div>
      <div class="form-group">
        <label>What's your top 3 tasks for today?</label>
        <textarea id="ci-tasks" rows="3" placeholder="1. Client call with Bergvliet trust&#10;2. Complete AUM module 2&#10;3. Update pipeline CRM"></textarea>
      </div>
      <div class="form-group">
        <label>Anything on your mind? (optional)</label>
        <textarea id="ci-notes" rows="2" placeholder="Blockers, wins, thoughts..."></textarea>
      </div>
      <div class="flex-gap mt-2">
        <div class="streak-display"><i class="fa-solid fa-fire"></i> ${streak}-day streak</div>
        <button class="btn btn--primary btn--lg" id="ci-submit" onclick="submitCheckin()" disabled>
          <i class="fa-solid fa-sun"></i> Check In &amp; Earn 20 XP
        </button>
      </div>
    </div>
    ${renderCheckinHistory(recentMoods)}`;
}

function renderCheckinHistory(recentMoods) {
  if(!recentMoods.length) return '';
  return `<div class="section-head mt-2"><i class="fa-solid fa-calendar-week"></i> Recent Mood History</div>
    <div class="wellbeing-card">
      <div class="mood-history">
        ${recentMoods.map(c=>`<div class="mood-dot" title="${new Date(c.checkin_date).toLocaleDateString('en-ZA',{weekday:'short',day:'numeric',month:'short'})}">
          ${c.mood||'😐'}
          <span class="mood-date">${new Date(c.checkin_date).toLocaleDateString('en-ZA',{weekday:'short'})}</span>
        </div>`).join('')}
      </div>
    </div>`;
}

let _selectedMood = '';
function selectMood(emoji, btn) {
  _selectedMood = emoji;
  document.querySelectorAll('.mood-btn').forEach(b=>b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('ci-submit').disabled = false;
}

async function submitCheckin() {
  if (!_selectedMood) { showToast('Select your mood first!','error'); return; }
  const tasks=document.getElementById('ci-tasks').value;
  const notes=document.getElementById('ci-notes').value;
  const todayStr=new Date().toISOString().slice(0,10);
  const streak=(Number(_emp.streak_days)||0)+1;
  const rec=await post('tables/daily_checkins',{
    employee_id:_emp.id, checkin_date:todayStr,
    mood:_selectedMood, tasks_planned:tasks, tasks_completed:'',
    notes, xp_awarded:20, streak_contribution:1
  });
  _checkins.unshift(rec);
  await patch(`tables/employees/${_emp.id}`,{streak_days:streak});
  _emp.streak_days=streak;
  await awardXP(20,'Daily check-in');
  await autoBoostKpi('attendance_score', 1);
  if(streak%7===0) showToast(`🔥 ${streak}-day streak milestone! +50 bonus XP!`,'success');
  if(_selectedMood==='😓') showToast('💙 Noticed you\'re feeling stressed. Your wellbeing matters — reach out to your manager.','info');
  renderCheckin();
  showToast('Checked in! +20 XP, streak updated 🔥','success');
}

function getTimeOfDay() {
  const h=new Date().getHours(); return h<12?'morning':h<17?'afternoon':'evening';
}

/* ═══ VIEW: LEAVE ═══════════════════════════════════════════════════ */
function renderMyLeave() {
  const statusCols = {pending:'chip-gold',approved:'chip-green',rejected:'chip-red',cancelled:'chip-gray'};
  const el = document.getElementById('view-leave');
  el.innerHTML=`
    <div class="view-header">
      <div><h1>My Leave</h1><div class="view-sub">Request &amp; track leave</div></div>
      <div class="view-header-actions">
        <button class="btn btn--primary" onclick="openLeaveModal()"><i class="fa-solid fa-plus"></i> Request Leave</button>
      </div>
    </div>
    <div class="data-table-wrap chart-container" style="padding:0">
      <table class="data-table">
        <thead><tr><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th>EVA Impact</th></tr></thead>
        <tbody>${_leaveReqs.length?_leaveReqs.map(l=>`<tr>
          <td>${l.leave_type||'—'}</td>
          <td>${l.start_date||'—'}</td>
          <td>${l.end_date||'—'}</td>
          <td>${l.days_requested||'—'}</td>
          <td><span class="chip ${statusCols[l.status]||'chip-gray'}">${l.status||'pending'}</span></td>
          <td style="color:var(--warn)">${l.eva_impact_pct?`-${l.eva_impact_pct}%`:'—'}</td>
        </tr>`).join(''):`<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:32px">No leave requests yet.</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

function openLeaveModal() {
  const el=document.getElementById('generic-modal');
  el.innerHTML=`<div class="modal">
    <div class="modal-header"><h3>Request Leave</h3><button class="btn btn--ghost btn--sm" onclick="closeModal('generic-modal')"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="modal-body">
      <div class="form-group"><label>Leave Type</label>
        <select id="lv-type">
          <option>Annual</option><option>Sick</option><option>Study</option><option>Family Responsibility</option><option>Unpaid</option>
        </select>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Start Date</label><input type="date" id="lv-start" /></div>
        <div class="form-group"><label>End Date</label><input type="date" id="lv-end" /></div>
      </div>
      <div class="form-group"><label>Reason</label><textarea id="lv-reason" rows="3"></textarea></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn--secondary" onclick="closeModal('generic-modal')">Cancel</button>
      <button class="btn btn--primary" onclick="submitLeave()">Submit Request</button>
    </div>
  </div>`;
  el.classList.add('open');
}

async function submitLeave() {
  const start=document.getElementById('lv-start').value;
  const end=document.getElementById('lv-end').value;
  if(!start||!end){showToast('Select start and end dates.','error');return;}
  const days=Math.max(1,Math.round((new Date(end)-new Date(start))/86400000)+1);
  const r=await post('tables/leave_requests',{
    employee_id:_emp.id, leave_type:document.getElementById('lv-type').value,
    start_date:start, end_date:end, days_requested:days,
    reason:document.getElementById('lv-reason').value, status:'pending'
  });
  _leaveReqs.push(r);
  closeModal('generic-modal');
  renderMyLeave();
  showToast('Leave request submitted!','success');
}

/* ═══ VIEW: ACHIEVEMENTS ════════════════════════════════════════════ */
function renderMyAchievements() {
  const allDefs=[
    {id:'BADGE-FIRST-COURSE',  icon:'🎓', name:'First Finish',      desc:'Complete your first course',          xp:50},
    {id:'BADGE-5COURSES',      icon:'📚', name:'Course Collector',  desc:'Complete 5 courses',                  xp:100},
    {id:'BADGE-10COURSES',     icon:'🔭', name:'Knowledge Seeker',  desc:'Complete 10 courses',                 xp:200},
    {id:'BADGE-STREAK7',       icon:'🔥', name:'7-Day Streak',      desc:'Check in for 7 consecutive days',     xp:70},
    {id:'BADGE-STREAK30',      icon:'⚡', name:'Habit Hero',        desc:'30-day check-in streak',              xp:300},
    {id:'BADGE-KUDOS5',        icon:'👏', name:'Team Player',       desc:'Give 5 kudos to teammates',           xp:50},
    {id:'BADGE-OKR-FIRST',     icon:'🎯', name:'Goal Setter',       desc:'Complete your first OKR',             xp:100},
    {id:'BADGE-PULSE5',        icon:'📊', name:'Consistent Voice',  desc:'Submit 5 pulse surveys',              xp:50},
  ];
  const earned = _achievements;
  const done = _progress.filter(p=>p.status==='completed').length;
  const kudosGiven = _peerFeedback.filter(f=>f.from_employee_id===_emp.id&&f.type==='kudos').length;
  const okrsDone = _okrs.filter(o=>o.employee_id===_emp.id&&o.status==='completed').length;
  const pulseDone = _pulseResp.filter(r=>r.employee_id===_emp.id).length;
  const streak = Number(_emp.streak_days)||0;

  const el=document.getElementById('view-achievements');
  el.innerHTML=`
    <div class="view-header"><div><h1>Achievements</h1><div class="view-sub">Badges, milestones &amp; recognition wall</div></div></div>
    <div class="cards-grid" style="max-width:600px">
      <div class="stat-card">
        <div class="stat-card-icon" style="background:rgba(249,200,70,0.15);color:var(--gold)"><i class="fa-solid fa-medal"></i></div>
        <div class="stat-card-val">${earned.length}</div>
        <div class="stat-card-lbl">Badges Earned</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-icon" style="background:rgba(237,165,255,0.15);color:var(--accent)"><i class="fa-solid fa-star"></i></div>
        <div class="stat-card-val">${Number(_emp.xp_points)||0}</div>
        <div class="stat-card-lbl">Total XP</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-icon" style="background:rgba(255,91,91,0.15);color:var(--danger)"><i class="fa-solid fa-fire"></i></div>
        <div class="stat-card-val">${streak}</div>
        <div class="stat-card-lbl">Current Streak</div>
      </div>
    </div>
    <div class="section-head"><i class="fa-solid fa-trophy"></i> Your Badges</div>
    <div class="ach-wall">
      ${allDefs.map(def=>{
        const e=earned.find(b=>b.badge_id===def.id);
        return `<div class="ach-tile ${e?'':'locked'}">
          <span class="ach-tile-icon">${def.icon}</span>
          <div class="ach-tile-name">${def.name}</div>
          <div class="ach-tile-xp">+${def.xp} XP</div>
          <div style="font-size:0.65rem;color:var(--muted);margin-top:3px">${e?`Earned ${timeAgo(e.awarded_at)}`:def.desc}</div>
          ${!e?`<i class="fa-solid fa-lock ach-lock"></i>`:''}
        </div>`;
      }).join('')}
    </div>
    <div class="section-head mt-2"><i class="fa-solid fa-graduation-cap"></i> Course Certificates (${_progress.filter(p=>p.status==='completed').length})</div>
    ${_progress.filter(p=>p.status==='completed').map(p=>{
      const c=_courses.find(x=>x.id===p.course_id)||{title:p.course_id,thumbnail_icon:'fa-book',thumbnail_color:'#eda5ff'};
      return `<div class="wellbeing-card" style="display:flex;align-items:center;gap:14px;cursor:pointer" onclick="openCertificateByProgress('${p.id}')">
        <i class="fa-solid ${c.thumbnail_icon||'fa-book'}" style="font-size:1.3rem;color:${c.thumbnail_color||'#eda5ff'}"></i>
        <div style="flex:1">
          <div style="font-weight:700;font-size:0.88rem">${c.title}</div>
          <div style="font-size:0.72rem;color:var(--muted)">Completed ${p.completed_at?timeAgo(p.completed_at):'recently'}</div>
        </div>
        <button class="btn btn--ghost btn--sm"><i class="fa-solid fa-certificate"></i> View</button>
      </div>`;
    }).join('') || `<div class="empty-state" style="padding:24px"><i class="fa-solid fa-graduation-cap"></i><p>Complete courses to earn certificates.</p></div>`}`;
}

/* ═══ VIEW: JOURNAL ═════════════════════════════════════════════════ */
function renderJournal() {
  const el = document.getElementById('view-journal');
  const pinned = _notes.filter(n=>isTrue(n.pinned));
  const others = _notes.filter(n=>!isTrue(n.pinned));
  el.innerHTML=`
    <div class="view-header">
      <div><h1>Personal Journal</h1><div class="view-sub">Private notes, ideas &amp; work reflections</div></div>
      <div class="view-header-actions">
        <button class="btn btn--primary" onclick="openNoteEditor(null)"><i class="fa-solid fa-plus"></i> New Note</button>
      </div>
    </div>
    ${pinned.length?`<div class="section-head"><i class="fa-solid fa-thumbtack"></i> Pinned</div>
    <div class="notes-grid">${pinned.map(n=>noteCardHTML(n)).join('')}</div>`:''}
    <div class="section-head"><i class="fa-solid fa-note-sticky"></i> All Notes <span class="section-count">${_notes.length}</span></div>
    <div class="notes-grid">
      ${others.map(n=>noteCardHTML(n)).join('')}
      ${!_notes.length?`<div class="empty-state"><i class="fa-solid fa-pen"></i><p>No notes yet. Start writing!</p></div>`:''}
    </div>`;
}

function noteCardHTML(n) {
  return `<div class="note-card ${isTrue(n.pinned)?'pinned':''}" onclick="openNoteEditor('${n.id}')">
    ${isTrue(n.pinned)?`<i class="fa-solid fa-thumbtack note-pin"></i>`:''}
    <div class="note-title">${n.title||'Untitled'}</div>
    <div class="note-preview">${(n.content||'').replace(/<[^>]+>/g,'').slice(0,120)}${(n.content||'').length>120?'…':''}</div>
    <div class="note-footer">
      <span class="note-date">${timeAgo(n.updated_at||n.created_at)}</span>
      ${isTrue(n.is_private)?`<span class="note-private"><i class="fa-solid fa-lock"></i>Private</span>`:`<span class="note-private"><i class="fa-solid fa-users"></i>Shared</span>`}
    </div>
  </div>`;
}

function openNoteEditor(noteId) {
  _noteEditing = noteId ? _notes.find(n=>n.id===noteId)||null : null;
  const overlay = document.getElementById('note-editor');
  overlay.innerHTML=`<div class="note-editor-box">
    <div class="note-editor-top">
      <input id="note-title" value="${_noteEditing?.title||''}" placeholder="Note title..." />
      <label style="display:flex;gap:6px;align-items:center;font-size:0.78rem;color:var(--muted);white-space:nowrap">
        <input type="checkbox" id="note-pin" ${isTrue(_noteEditing?.pinned)?'checked':''} /> Pin
      </label>
      <label style="display:flex;gap:6px;align-items:center;font-size:0.78rem;color:var(--muted);white-space:nowrap">
        <input type="checkbox" id="note-private" ${_noteEditing?isTrue(_noteEditing.is_private)?'checked':'':'checked'} /> Private
      </label>
      <button class="btn btn--ghost btn--sm" onclick="closeNoteEditor()"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="note-editor-body">
      <textarea id="note-content" placeholder="Write your thoughts...">${_noteEditing?.content||''}</textarea>
    </div>
    <div class="note-editor-footer">
      ${_noteEditing?`<button class="btn btn--ghost btn--sm" onclick="deleteNote('${_noteEditing.id}')"><i class="fa-solid fa-trash"></i></button>`:''}
      <div style="flex:1"></div>
      <button class="btn btn--secondary" onclick="closeNoteEditor()">Cancel</button>
      <button class="btn btn--primary" onclick="saveNote('${noteId||''}')"><i class="fa-solid fa-floppy-disk"></i> Save</button>
    </div>
  </div>`;
  overlay.classList.add('open');
}

function closeNoteEditor() { document.getElementById('note-editor').classList.remove('open'); }

async function saveNote(id) {
  const title=document.getElementById('note-title').value||'Untitled';
  const content=document.getElementById('note-content').value;
  const pinned=document.getElementById('note-pin').checked;
  const priv=document.getElementById('note-private').checked;
  const now=new Date().toISOString();
  if(id&&id!=='') {
    const r=await patch(`tables/personal_notes/${id}`,{title,content,pinned,is_private:priv,updated_at:now});
    Object.assign(_notes.find(n=>n.id===id)||{},r);
  } else {
    const r=await post('tables/personal_notes',{employee_id:_emp.id,title,content,pinned,is_private:priv,created_at:now,updated_at:now});
    _notes.unshift(r);
  }
  closeNoteEditor();
  renderJournal();
  showToast('Note saved!','success');
}

async function deleteNote(id) {
  if(!confirm('Delete this note?')) return;
  await del(`tables/personal_notes/${id}`);
  _notes=_notes.filter(n=>n.id!==id);
  closeNoteEditor();
  renderJournal();
  showToast('Note deleted.','info');
}

/* ═══ VIEW: EVA PAYSLIP ══════════════════════════════════════════ */
const EMP_AUM_RATE = 0.025; // 2.5% of AUM = gross revenue

function renderEvaPayslip() {
  const latest = _evaPeriods.sort((a,b)=>b.period_month.localeCompare(a.period_month))[0]||{};
  const kpi    = _kpiScores.find(k=>k.period_month===latest.period_month)||_kpiScores[0]||{};

  // Derive revenue from AUM using 2.5% rule
  const aum        = Number(latest.total_aum)||0;
  const grossRev   = aum > 0 ? aum * EMP_AUM_RATE : (Number(latest.gross_revenue)||0);
  const opCosts    = Number(latest.operational_costs)||0;
  const evaPool    = Math.max(0, grossRev - opCosts);
  const teamPct    = (Number(latest.team_pool_pct)||50) / 100;
  const teamPool   = Number(latest.team_pool_amount) || (evaPool * teamPct);

  const empWeight  = Number(_emp.eva_weight)||1;
  const allW       = _employees.filter(e=>e.status!=='inactive').reduce((s,e)=>s+(Number(e.eva_weight)||1),0)||1;
  const score      = Number(kpi.overall_score)||75;
  const indSplit   = Number(latest.individual_split_pct||60)/100;
  const colSplit   = 1-indSplit;
  const headcount  = _employees.filter(e=>e.status!=='inactive').length||1;
  const indPool    = teamPool * indSplit;
  const colPool    = teamPool * colSplit;
  const indShare   = indPool * (empWeight/allW) * (score/100);
  const colShare   = colPool / headcount;
  const totalEva   = indShare + colShare;
  const base       = Number(_emp.base_salary)||50000;

  const el=document.getElementById('view-eva');
  el.innerHTML=`
    <div class="view-header"><div><h1>EVA Statement</h1><div class="view-sub">Your performance bonus breakdown — ${latest.period_month||'—'}</div></div></div>

    <!-- Revenue formula explanation -->
    <div style="background:rgba(0,212,170,0.07);border:1px solid rgba(0,212,170,0.2);border-radius:10px;padding:14px 18px;margin-bottom:20px;font-size:0.82rem">
      <div style="font-weight:700;color:var(--accent2);margin-bottom:6px"><i class="fa-solid fa-calculator"></i> &nbsp;Revenue Formula: 2.5% × AUM</div>
      <div style="color:var(--muted)">
        Gross Revenue = 2.5% × ${zarM(aum)} AUM = <strong style="color:var(--accent2)">${zarM(grossRev)}</strong>
        &nbsp;·&nbsp; EVA Pool = Revenue − Costs = <strong>${zarM(evaPool)}</strong>
        &nbsp;·&nbsp; Team Share (${Math.round(teamPct*100)}%) = <strong>${zarM(teamPool)}</strong>
      </div>
    </div>

    <div class="eva-payslip">
      <div class="payslip-header">
        <div>
          <div class="payslip-company">SV Capital (Pty) Ltd</div>
          <div class="payslip-name">${_emp.first_name} ${_emp.last_name}</div>
          <div class="payslip-period">${_emp.role||''} · Period: ${latest.period_month||'—'}</div>
        </div>
        <div class="payslip-logo"><i class="fa-solid fa-bolt"></i></div>
      </div>
      <div class="payslip-body">
        <div class="payslip-row"><span class="label">Base Salary</span><span class="value">${zarM(base)}/month</span></div>
        <div class="payslip-row"><span class="label">Total AUM</span><span class="value">${zarM(aum)}</span></div>
        <div class="payslip-row"><span class="label">Gross Revenue (2.5% × AUM)</span><span class="value" style="color:var(--accent2)">${zarM(grossRev)}</span></div>
        <div class="payslip-row"><span class="label">Operational Costs</span><span class="value">${zarM(opCosts)}</span></div>
        <div class="payslip-row"><span class="label">EVA Pool (Revenue − Costs)</span><span class="value">${zarM(evaPool)}</span></div>
        <div class="payslip-row"><span class="label">Team Pool (${Math.round(teamPct*100)}%)</span><span class="value">${zarM(teamPool)}</span></div>
        <div class="payslip-row"><span class="label">Individual Pool (${Math.round(indSplit*100)}%)</span><span class="value">${zarM(indPool)}</span></div>
        <div class="payslip-row"><span class="label">Collective Pool (${Math.round(colSplit*100)}%)</span><span class="value">${zarM(colPool)}</span></div>
        <div class="payslip-row"><span class="label">Your KPI Score</span><span class="value" style="color:${kpiColor(score)}">${Math.round(score)}%</span></div>
        <div class="payslip-row"><span class="label">Your EVA Weight</span><span class="value">${empWeight}× (of total ${allW.toFixed(1)})</span></div>
        <div class="payslip-row"><span class="label">Individual Share</span><span class="value">${zarM(indShare)}</span></div>
        <div class="payslip-row"><span class="label">Collective Share (÷${headcount} headcount)</span><span class="value">${zarM(colShare)}</span></div>
        <div class="payslip-row highlight total">
          <span class="label">Total EVA Bonus</span>
          <span class="value">${zarM(totalEva)}</span>
        </div>
        <div class="payslip-row"><span class="label">Status</span><span class="value"><span class="chip ${latest.status==='paid'?'chip-green':latest.status==='finalised'?'chip-purple':'chip-gold'}">${latest.status||'pending'}</span></span></div>
      </div>
      <div class="payslip-footer">Formula: Revenue=2.5%×AUM · EVA=Revenue−Costs · Individual=TeamPool×${Math.round(indSplit*100)}%×(weight/Σweights)×(KPI/100) · Collective=TeamPool×${Math.round(colSplit*100)}%÷headcount</div>
    </div>
    <div class="section-head mt-3"><i class="fa-solid fa-lightbulb"></i> How to Increase Your EVA</div>
    <div class="chart-container">
      ${KPI_DIMS.map(dim=>{
        const val=Math.round(Number(kpi[dim])||0);
        const potential=Math.min(100,val+10);
        const gain=potential-val;
        return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:0.82rem">
          <span style="min-width:160px;color:var(--muted)">${KPI_LABELS[dim]}</span>
          <div class="kpi-track" style="flex:1"><div class="kpi-fill" style="width:${val}%;background:${kpiColor(val)}"></div></div>
          <span style="min-width:36px;font-weight:700;color:${kpiColor(val)}">${val}</span>
          ${gain>0?`<span style="font-size:0.7rem;color:var(--accent2);min-width:90px">+${gain} pts → +${zarM(totalEva*0.05)} EVA</span>`:'<span style="min-width:90px"></span>'}
        </div>`;
      }).join('')}
      <div style="margin-top:14px;font-size:0.78rem;color:var(--muted)">
        Tip: Complete a course to boost KPI dimensions directly. Each +10 point KPI improvement can increase your EVA bonus by ~${zarM(totalEva*0.05)}.
      </div>
    </div>
    ${_evaPeriods.length>1?`<div class="section-head mt-2"><i class="fa-solid fa-history"></i> History</div>
    <div class="data-table-wrap chart-container" style="padding:0">
      <table class="data-table">
        <thead><tr><th>Period</th><th>Team Pool</th><th>KPI Score</th><th>Status</th></tr></thead>
        <tbody>${_evaPeriods.slice(0,6).map(p=>`<tr>
          <td>${p.period_month}</td>
          <td>${zarM(Number(p.team_pool_amount)||0)}</td>
          <td>${Math.round(Number(_kpiScores.find(k=>k.period_month===p.period_month)?.overall_score)||0)}%</td>
          <td><span class="chip ${p.status==='paid'?'chip-green':p.status==='finalised'?'chip-purple':'chip-gold'}">${p.status||'pending'}</span></td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`:''}`;
}

/* ═══ BIRTHDAY SYSTEM ═══════════════════════════════════════════════ */
function checkBirthdays() {
  const today = new Date();
  const todayMD = `${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  _employees.forEach(async emp => {
    if (!emp.birth_date) return;
    const bd = emp.birth_date; // YYYY-MM-DD
    const empMD = bd.slice(5); // MM-DD
    if (empMD !== todayMD) return;

    const isMe = emp.id === _emp.id;
    const name = isMe ? 'your birthday' : `${emp.first_name} ${emp.last_name}'s birthday`;

    // Show banner
    const banner = document.createElement('div');
    banner.style.cssText = `position:fixed;top:0;left:72px;right:0;z-index:800;
      background:linear-gradient(90deg,rgba(249,200,70,0.95),rgba(255,179,71,0.95));
      color:#0e0f13;padding:10px 20px;font-size:0.85rem;font-weight:700;
      display:flex;align-items:center;gap:12px;box-shadow:0 2px 16px rgba(0,0,0,0.3)`;
    banner.innerHTML = `<span style="font-size:1.4rem">🎂</span>
      <span>${isMe ? '🎉 Happy Birthday to YOU!' : `🎂 Today is ${emp.first_name} ${emp.last_name}'s birthday!`}
      ${isMe ? ' The whole team wishes you an amazing day!' : ' Wish them a happy birthday!'}</span>
      ${!isMe ? `<button onclick="openKudosForBirthday('${emp.id}')" style="margin-left:auto;background:#0e0f13;color:#fec24f;border:none;padding:5px 14px;border-radius:6px;font-weight:700;cursor:pointer;font-size:0.78rem">
        Send 🎂 Wishes
      </button>` : ''}
      <button onclick="this.parentElement.remove()" style="background:transparent;border:none;cursor:pointer;font-size:1rem;margin-left:${isMe?'auto':'8px'}">✕</button>`;
    document.body.prepend(banner);

    // Auto-award birthday XP to the person (only if viewing as that person)
    if (isMe) {
      const today_str = new Date().toISOString().slice(0,10);
      const alreadyAwarded = _activityFeed.find(f=>
        f.employee_id===emp.id && f.type==='badge_earned' && f.title.includes('Birthday') &&
        f.created_at && f.created_at.slice(0,10)===today_str
      );
      if (!alreadyAwarded) {
        await awardXP(100, 'Birthday bonus!');
        showToast('🎂 Happy Birthday! +100 XP bonus from the team!', 'success');
        const act = await post('tables/activity_feed', {
          employee_id: emp.id, type: 'badge_earned',
          title: '🎂 Birthday! +100 XP',
          body: `Happy Birthday ${emp.first_name}! The SV Capital team celebrates you today.`,
          icon: 'fa-cake-candles', color: '#fec24f',
          xp_shown: 100, is_public: true,
          created_at: new Date().toISOString()
        });
        _activityFeed.unshift(act);
      }
    }
  });
}

function openKudosForBirthday(empId) {
  const emp = _employees.find(e=>e.id===empId); if (!emp) return;
  navigate('feedback', document.querySelector('[data-view=feedback]'));
  setTimeout(()=>{
    const sel = document.getElementById('kudos-to');
    if (sel) sel.value = empId;
    const msg = document.getElementById('kudos-msg');
    if (msg) msg.value = `Happy Birthday ${emp.first_name}! 🎂 Wishing you a wonderful day and an amazing year ahead!`;
    msg?.focus();
  }, 300);
}

/* ═══ VIEW: PROFILE ═════════════════════════════════════════════════ */
function renderProfile() {
  if (!_emp) return;
  const el = document.getElementById('view-profile');
  const hasBanking = _emp.bank_account_number;
  const bd = _emp.birth_date;
  const age = bd ? Math.floor((Date.now()-new Date(bd).getTime())/(1000*60*60*24*365.25)) : null;
  const bdFormatted = bd ? new Date(bd+'T12:00:00').toLocaleDateString('en-ZA',{day:'numeric',month:'long',year:'numeric'}) : 'Not set';
  const nextBday = bd ? getNextBirthday(bd) : null;

  const addrParts = [_emp.address_line1, _emp.address_line2, _emp.address_city, _emp.address_province, _emp.address_postal_code].filter(Boolean);
  const addrDisplay = addrParts.length ? addrParts.join(', ') : 'Not set';

  el.innerHTML = `
    <div class="view-header">
      <div><h1>My Profile</h1><div class="view-sub">Personal details, banking information &amp; documents</div></div>
      <div class="view-header-actions">
        <button class="btn btn--primary" id="editProfileBtn"><i class="fa-solid fa-pen"></i> Edit Profile</button>
      </div>
    </div>

    <div class="two-col" style="gap:20px">
      <!-- Personal details -->
      <div>
        <div class="section-head"><i class="fa-solid fa-user"></i> Personal Information</div>
        <div class="chart-container" style="padding:0">
          ${profileRow('fa-id-card','Full Name',`${_emp.first_name} ${_emp.last_name}`)}
          ${_emp.employee_number ? profileRow('fa-id-badge','Employee No.',`<span style="font-family:monospace">${_emp.employee_number}</span>`) : ''}
          ${profileRow('fa-envelope','Email',_emp.email||'—')}
          ${profileRow('fa-phone','Phone',_emp.phone||'—')}
          ${profileRow('fa-briefcase','Role',`${_emp.role||'—'} · ${_emp.department||'—'}`)}
          ${profileRow('fa-calendar-check','Start Date',_emp.start_date?new Date(_emp.start_date).toLocaleDateString('en-ZA',{day:'numeric',month:'long',year:'numeric'}):'—')}
          ${profileRow('fa-id-badge','ID Number',_emp.id_number?maskId(_emp.id_number):'Not set')}
          ${profileRow('fa-phone-volume','Emergency Contact',_emp.emergency_contact_name?`${_emp.emergency_contact_name} · ${_emp.emergency_contact_phone||''}` :'Not set')}
          ${profileRow('fa-align-left','Bio',_emp.bio||'—')}
        </div>

        <div class="section-head mt-3"><i class="fa-solid fa-map-marker-alt"></i> Address</div>
        <div class="chart-container" style="padding:0">
          ${profileRow('fa-location-dot','Address',addrDisplay)}
        </div>

        <div class="section-head mt-3">
          <i class="fa-solid fa-cake-candles text-gold"></i> Birthday
        </div>
        <div class="chart-container" style="padding:0">
          ${profileRow('fa-calendar','Date of Birth',bdFormatted)}
          ${age ? profileRow('fa-hourglass','Age',`${age} years old`) : ''}
          ${nextBday ? profileRow('fa-party-horn','Next Birthday',`${nextBday.label} — ${nextBday.daysAway===0?'🎂 TODAY!':nextBday.daysAway+' days away'}`) : ''}
        </div>
      </div>

      <!-- Banking details + Documents -->
      <div>
        <div class="section-head">
          <i class="fa-solid fa-building-columns"></i> Banking Information
          <span style="margin-left:auto;font-size:0.68rem;color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0">
            <i class="fa-solid fa-lock"></i> Encrypted · Admin only
          </span>
        </div>
        <div class="chart-container" style="padding:0">
          ${profileRow('fa-building-columns','Bank Name',_emp.bank_name||'Not set')}
          ${profileRow('fa-credit-card','Account Number',_emp.bank_account_number?maskAccount(_emp.bank_account_number):'Not set')}
          ${profileRow('fa-wallet','Account Type',_emp.bank_account_type||'—')}
          ${profileRow('fa-hashtag','Branch Code',_emp.bank_branch_code||'—')}
          ${profileRow('fa-user-check','Account Holder',_emp.bank_account_holder||'—')}
        </div>

        <div class="section-head mt-3"><i class="fa-solid fa-file-upload"></i> Proof of Banking</div>
        <div class="chart-container">
          ${_emp.proof_of_banking_url
            ? `<div style="display:flex;align-items:center;gap:12px;padding:4px 0">
                <i class="fa-solid fa-file-pdf" style="color:var(--danger);font-size:1.3rem"></i>
                <div style="flex:1">
                  <div style="font-size:0.85rem;font-weight:600">${_emp.proof_of_banking_url.split('/').pop()}</div>
                  <div style="font-size:0.72rem;color:var(--muted)">Proof of banking on file</div>
                </div>
                <span class="chip chip-green"><i class="fa-solid fa-check"></i> Uploaded</span>
              </div>`
            : `<div style="border:2px dashed var(--border);border-radius:10px;padding:28px;text-align:center">
                <i class="fa-solid fa-cloud-upload" style="font-size:2rem;color:var(--muted);margin-bottom:10px;display:block"></i>
                <div style="font-size:0.85rem;font-weight:600;margin-bottom:4px">No document uploaded yet</div>
                <div style="font-size:0.75rem;color:var(--muted);margin-bottom:14px">Upload a bank confirmation letter, statement header, or cancelled cheque</div>
                <label class="btn btn--secondary" style="cursor:pointer">
                  <i class="fa-solid fa-upload"></i> Upload Document
                  <input id="bankingDocInput" type="file" accept=".pdf,.jpg,.jpeg,.png" style="display:none" />
                </label>
              </div>`
          }
        </div>

        <div class="section-head mt-3"><i class="fa-solid fa-passport"></i> Proof of ID</div>
        <div class="chart-container">
          ${_emp.proof_of_id_url
            ? `<div style="display:flex;align-items:center;gap:12px;padding:4px 0">
                <i class="fa-solid fa-file-pdf" style="color:var(--danger);font-size:1.3rem"></i>
                <div style="flex:1">
                  <div style="font-size:0.85rem;font-weight:600">${_emp.proof_of_id_url.split('/').pop()}</div>
                  <div style="font-size:0.72rem;color:var(--muted)">Proof of ID on file</div>
                </div>
                <span class="chip chip-green"><i class="fa-solid fa-check"></i> Uploaded</span>
              </div>`
            : `<div style="border:2px dashed var(--border);border-radius:10px;padding:28px;text-align:center">
                <i class="fa-solid fa-id-card" style="font-size:2rem;color:var(--muted);margin-bottom:10px;display:block"></i>
                <div style="font-size:0.85rem;font-weight:600;margin-bottom:4px">No ID document uploaded yet</div>
                <div style="font-size:0.75rem;color:var(--muted);margin-bottom:14px">Upload a copy of your SA ID or passport</div>
                <label class="btn btn--secondary" style="cursor:pointer">
                  <i class="fa-solid fa-upload"></i> Upload ID Document
                  <input id="idDocInput" type="file" accept=".pdf,.jpg,.jpeg,.png" style="display:none" />
                </label>
              </div>`
          }
        </div>

        <div class="section-head mt-3"><i class="fa-solid fa-shield-halved"></i> Account Security</div>
        <div class="chart-container" style="padding:0">
          ${profileRow('fa-key','Password','••••••••')}
          ${profileRow('fa-clock','Last Login',timeAgo(new Date().toISOString()))}
          ${profileRow('fa-circle-check','Profile Status',`<span class="chip ${hasBanking?'chip-green':'chip-gold'}">${hasBanking?'Complete':'Banking Pending'}</span>`)}
        </div>
      </div>
    </div>

    <!-- Payslips -->
    <div style="margin-top:24px">
      <div class="section-head"><i class="fa-solid fa-file-invoice-dollar"></i> My Payslips</div>
      ${_payslips.length === 0
        ? `<div class="chart-container" style="text-align:center;padding:28px;color:var(--muted)">
             <i class="fa-solid fa-file-invoice-dollar" style="font-size:1.8rem;margin-bottom:10px;display:block;opacity:0.35"></i>
             <div style="font-size:0.82rem">No payslips on record yet.</div>
           </div>`
        : `<div class="chart-container" style="padding:0">
             ${_payslips.map(p => {
               const [yr, mo] = p.pay_period.split('-');
               const moLabel = ['January','February','March','April','May','June','July','August','September','October','November','December'][(parseInt(mo,10)||1)-1] || mo;
               return `<div style="display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid var(--border)">
                 <div style="width:36px;height:36px;border-radius:9px;background:rgba(237,165,255,0.08);color:var(--accent);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                   <i class="fa-solid fa-file-invoice-dollar"></i>
                 </div>
                 <div style="flex:1">
                   <div style="font-size:0.85rem;font-weight:700">${moLabel} ${yr}</div>
                   <div style="font-size:0.72rem;color:var(--muted)">Nett pay: R ${Number(p.nett_pay||0).toLocaleString('en-ZA',{minimumFractionDigits:2})}</div>
                 </div>
                 <button class="btn btn--secondary btn--sm" id="dl-${p.id}">
                   <i class="fa-solid fa-download"></i> Download
                 </button>
               </div>`;
             }).join('')}
           </div>`
      }
    </div>`;

  document.getElementById('editProfileBtn')?.addEventListener('click', openProfileEditModal);
  document.getElementById('bankingDocInput')?.addEventListener('change', function() { handleBankingDocUpload(this); });
  document.getElementById('idDocInput')?.addEventListener('change', function() { handleIdDocUpload(this); });
  _payslips.forEach(p => {
    document.getElementById(`dl-${p.id}`)?.addEventListener('click', () => downloadPayslip(p.id));
  });
}

function profileRow(icon, label, value) {
  return `<div style="display:flex;align-items:center;gap:12px;padding:11px 18px;border-bottom:1px solid var(--border);font-size:0.83rem">
    <i class="fa-solid ${icon}" style="width:16px;color:var(--muted);text-align:center"></i>
    <span style="color:var(--muted);min-width:140px">${label}</span>
    <span style="color:var(--text);flex:1">${value}</span>
  </div>`;
}

function maskAccount(num) {
  const s = String(num);
  return '•'.repeat(Math.max(0,s.length-4)) + s.slice(-4);
}
function maskId(id) {
  const s = String(id);
  return s.slice(0,6) + '•'.repeat(Math.max(0,s.length-8)) + s.slice(-2);
}

function getNextBirthday(bdStr) {
  if (!bdStr) return null;
  const today = new Date();
  const thisYear = today.getFullYear();
  const [,mm,dd] = bdStr.split('-').map(Number);
  let next = new Date(thisYear, mm-1, dd);
  if (next < today && !(next.toDateString()===today.toDateString())) next.setFullYear(thisYear+1);
  const diff = Math.round((next-today)/(1000*60*60*24));
  return {
    label: next.toLocaleDateString('en-ZA',{day:'numeric',month:'long',year:'numeric'}),
    daysAway: diff < 0 ? 0 : diff
  };
}

function handleBankingDocUpload(input) {
  const file = input.files[0]; if (!file) return;
  const fakePath = `uploads/banking/${_emp.id}_${file.name}`;
  patch(`tables/employees/${_emp.id}`, { proof_of_banking_url: fakePath }).then(r=>{
    _emp.proof_of_banking_url = fakePath;
    renderProfile();
    showToast(`Banking document "${file.name}" uploaded successfully!`, 'success');
  });
}

function handleIdDocUpload(input) {
  const file = input.files[0]; if (!file) return;
  const fakePath = `uploads/id/${_emp.id}_${file.name}`;
  patch(`tables/employees/${_emp.id}`, { proof_of_id_url: fakePath }).then(r=>{
    _emp.proof_of_id_url = fakePath;
    renderProfile();
    showToast(`ID document "${file.name}" uploaded successfully!`, 'success');
  });
}

function downloadPayslip(id) {
  const p = _payslips.find(x => x.id === id);
  if (!p || !_emp) { showToast('Payslip not found', 'error'); return; }
  const w = window.open('', '_blank', 'width=900,height=720');
  if (!w) { showToast('Allow pop-ups to download payslips', 'error'); return; }
  w.document.write(buildEmpPayslipHTML(p, _emp));
  w.document.close();
  w.onload = () => w.print();
}

function buildEmpPayslipHTML(p, emp) {
  const fmt = n => Number(n||0).toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2});
  const maskAcc = n => { const s=String(n||''); return s.length>4?'*'.repeat(s.length-4)+s.slice(-4):s; };
  const rph = (Number(emp.base_salary||0)/173.33).toFixed(5);
  const payDateFmt = (p.pay_date||'').replace(/-/g,'/');
  const startFmt = emp.start_date?emp.start_date.slice(0,10).replace(/-/g,'/'):'—';
  const empCode = emp.employee_number||emp.id;
  const addrParts = [emp.address_line1,emp.address_line2,emp.address_city,emp.address_province,emp.address_postal_code].filter(Boolean);
  const addrHtml = addrParts.length?addrParts.join(', '):'—';
  const [yr,mo] = (p.pay_period||'').split('-');
  const moLabel = ['January','February','March','April','May','June','July','August','September','October','November','December'][(parseInt(mo,10)||1)-1]||mo;
  const LOGO = 'PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4KPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGhlaWdodD0iMTA2LjkyMSIgdmlld0JveD0iMCAwIDQzMS4yMTggMTA2LjkyMSIgd2lkdGg9IjQzMS4yMTgiPgogIDxkZWZzPgogICAgPGxpbmVhckdyYWRpZW50IGdyYWRpZW50VW5pdHM9Im9iamVjdEJvdW5kaW5nQm94IiBpZD0ibGluZWFyLWdyYWRpZW50IiB4MT0iMC44NzQiIHgyPSIwLjExIiB5MT0iMC4wMzQiIHkyPSIwLjk4NiI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2ZmOWIwYyIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjAuMjA0IiBzdG9wLWNvbG9yPSIjZmY5NDBlIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMC40OTIiIHN0b3AtY29sb3I9IiNmZjgyMTUiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIwLjgyNyIgc3RvcC1jb2xvcj0iI2ZmNjQyMSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjAuOTk3IiBzdG9wLWNvbG9yPSIjZmY1MjI5Ii8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGdyYWRpZW50VW5pdHM9Im9iamVjdEJvdW5kaW5nQm94IiBpZD0ibGluZWFyLWdyYWRpZW50LTIiIHgxPSIwLjUiIHgyPSIwLjUiIHkxPSIwLjAyNyIgeTI9IjAuOTk0Ij4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjZWRhNWZmIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMC4xNzUiIHN0b3AtY29sb3I9IiNlZmE5ZTUiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIwLjU0OSIgc3RvcC1jb2xvcj0iI2Y1YjNhNCIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNmZWMyNGYiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgZ3JhZGllbnRVbml0cz0ib2JqZWN0Qm91bmRpbmdCb3giIGlkPSJsaW5lYXItZ3JhZGllbnQtMyIgeDI9IjEiIHkxPSIwLjUiIHkyPSIwLjUiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiM2NWVkMDAiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIwLjk5NyIgc3RvcC1jb2xvcj0iIzAwOTZmZiIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBncmFkaWVudFVuaXRzPSJvYmplY3RCb3VuZGluZ0JveCIgaWQ9ImxpbmVhci1ncmFkaWVudC00IiB4Mj0iMSIgeTE9IjAuNSIgeTI9IjAuNSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMC4wMDMiIHN0b3AtY29sb3I9IiMwMDk2ZmYiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNjVlZDAwIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGhyZWY9IiNsaW5lYXItZ3JhZGllbnQtMyIgaWQ9ImxpbmVhci1ncmFkaWVudC01IiB4MT0iMC45NDMiIHgyPSIwLjAyNyIgeTE9IjAuMDQ0IiB5Mj0iMC45ODYiLz4KICAgIDxsaW5lYXJHcmFkaWVudCBncmFkaWVudFVuaXRzPSJvYmplY3RCb3VuZGluZ0JveCIgaWQ9ImxpbmVhci1ncmFkaWVudC02IiB4MT0iMC4xMzEiIHgyPSIwLjg4OSIgeTE9IjAuMDI5IiB5Mj0iMC45OTYiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAuMDAzIiBzdG9wLWNvbG9yPSIjZmZlODZhIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI2ZmYjc4MiIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBncmFkaWVudFVuaXRzPSJvYmplY3RCb3VuZGluZ0JveCIgaWQ9ImxpbmVhci1ncmFkaWVudC03IiB4MT0iMC4wNDkiIHgyPSIwLjk2NSIgeTE9IjAuMDQ0IiB5Mj0iMC45NzEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNmZjliMGMiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIwLjk5NyIgc3RvcC1jb2xvcj0iI2ZmNTIyOSIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBncmFkaWVudFVuaXRzPSJvYmplY3RCb3VuZGluZ0JveCIgaWQ9ImxpbmVhci1ncmFkaWVudC04IiB4MT0iMC41IiB4Mj0iMC41IiB5MT0iMC4wNTYiIHkyPSIwLjg5MSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2ZlYzI0ZiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNlZmE5ZTYiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDxnIGlkPSJMb2dvIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwKSI+CiAgICA8ZyBkYXRhLW5hbWU9Ikdyb3VwIDMxNDEiIGlkPSJHcm91cF8zMTQxIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMzg2MyAzMjY5LjgyNSkiPgogICAgICA8cGF0aCBkPSJNLTE0My4xNTYtMTMuMi0xNDguMTE1LDBoLTIuNTA4TC0xNTUuNi0xMy4yaDIuMzE4bDMuOTE0LDEwLjk4MiwzLjkzMy0xMC45ODJabTEyLjczLDcuNzE0YTYuNzcxLDYuNzcxLDAsMCwxLS4wNzYsMS4wNjRoLThhMi45LDIuOSwwLDAsMCwuOTMxLDIuMDE0LDIuOTM5LDIuOTM5LDAsMCwwLDIuMDUyLjc2LDIuNTM0LDIuNTM0LDAsMCwwLDIuNDctMS40NjNoMi4zMzdBNC43MTYsNC43MTYsMCwwLDEtMTMyLjQzLS43NTFhNS4wNDUsNS4wNDUsMCwwLDEtMy4wODguOTIyQTUuMzQ3LDUuMzQ3LDAsMCwxLTEzOC4yMDYtLjVhNC44LDQuOCwwLDAsMS0xLjg2Mi0xLjksNS44LDUuOCwwLDAsMS0uNjc0LTIuODQxLDUuOTMyLDUuOTMyLDAsMCwxLC42NTYtMi44NDEsNC42MSw0LjYxLDAsMCwxLDEuODQzLTEuODksNS40ODUsNS40ODUsMCwwLDEsMi43MjYtLjY2NSw1LjMzMiw1LjMzMiwwLDAsMSwyLjY0MS42NDYsNC41NjUsNC41NjUsMCwwLDEsMS44LDEuODE1QTUuNDY1LDUuNDY1LDAsMCwxLTEzMC40MjUtNS40OTFabS0yLjI2MS0uNjg0YTIuNDY1LDIuNDY1LDAsMCwwLS44NTUtMS45MTksMy4wNTcsMy4wNTcsMCwwLDAtMi4wNzEtLjcyMiwyLjc4MiwyLjc4MiwwLDAsMC0xLjkxOS43MTMsMi45NzgsMi45NzgsMCwwLDAtLjk1LDEuOTI4Wm0xMS00LjQ2NWE0LjcsNC43LDAsMCwxLDIuMjE0LjUxMywzLjY0OCwzLjY0OCwwLDAsMSwxLjUyOSwxLjUyLDUsNSwwLDAsMSwuNTUxLDIuNDMyVjBoLTIuMTQ3Vi01Ljg1MmEzLjAzOSwzLjAzOSwwLDAsMC0uNy0yLjE1NywyLjUsMi41LDAsMCwwLTEuOTE5LS43NSwyLjUzMywyLjUzMywwLDAsMC0xLjkyOS43NSwzLjAxMywzLjAxMywwLDAsMC0uNzEyLDIuMTU3VjBoLTIuMTY2Vi0xMC40NjloMi4xNjZ2MS4yYTMuNTg1LDMuNTg1LDAsMCwxLDEuMzU4LTEuMDA3QTQuMzQzLDQuMzQzLDAsMCwxLTEyMS42ODYtMTAuNjRaTS0xMTAuNzgtOC43djUuNzk1YTEuMTEyLDEuMTEyLDAsMCwwLC4yNzUuODQ2LDEuMzcsMS4zNywwLDAsMCwuOTQuMjU2aDEuMzNWMGgtMS43MWEzLjMsMy4zLDAsMCwxLTIuMjQyLS42ODQsMi44MTksMi44MTksMCwwLDEtLjc3OS0yLjIyM1YtOC43SC0xMTQuMnYtMS43NjdoMS4yMzV2LTIuNmgyLjE4NXYyLjZoMi41NDZWLTguN1ptMTUuMzUyLTEuNzY3VjBoLTIuMTY2Vi0xLjIzNWEzLjUwNiwzLjUwNiwwLDAsMS0xLjM0LDEuMDE2LDQuMjQ3LDQuMjQ3LDAsMCwxLTEuNzU3LjM3MUE0LjcsNC43LDAsMCwxLTEwMi45LS4zNjFhMy43MDYsMy43MDYsMCwwLDEtMS41MzktMS41MkE0LjkzMSw0LjkzMSwwLDAsMS0xMDUtNC4zMTN2LTYuMTU2aDIuMTQ3djUuODMzYTMuMDM5LDMuMDM5LDAsMCwwLC43LDIuMTU3LDIuNSwyLjUsMCwwLDAsMS45MTkuNzUxLDIuNTMzLDIuNTMzLDAsMCwwLDEuOTI5LS43NTEsMy4wMTMsMy4wMTMsMCwwLDAsLjcxMi0yLjE1N3YtNS44MzNabTYuMzQ2LDEuNTJhMy40LDMuNCwwLDAsMSwxLjI2My0xLjI0NSwzLjczNywzLjczNywwLDAsMSwxLjg3MS0uNDQ3Vi04LjRILTg2LjVhMi42MzgsMi42MzgsMCwwLDAtMS45MjkuNjQ2LDMuMDg5LDMuMDg5LDAsMCwwLS42NTUsMi4yNDJWMGgtMi4xNjZWLTEwLjQ2OWgyLjE2NlptMTYuMDU1LDMuNDU4QTYuNzcyLDYuNzcyLDAsMCwxLTczLjEtNC40MjdoLThhMi45LDIuOSwwLDAsMCwuOTMxLDIuMDE0LDIuOTM5LDIuOTM5LDAsMCwwLDIuMDUyLjc2LDIuNTM0LDIuNTM0LDAsMCwwLDIuNDctMS40NjNoMi4zMzdBNC43MTYsNC43MTYsMCwwLDEtNzUuMDMxLS43NTFhNS4wNDUsNS4wNDUsMCwwLDEtMy4wODguOTIyQTUuMzQ3LDUuMzQ3LDAsMCwxLTgwLjgwNy0uNWE0LjgsNC44LDAsMCwxLTEuODYyLTEuOSw1LjgsNS44LDAsMCwxLS42NzQtMi44NDEsNS45MzIsNS45MzIsMCwwLDEsLjY1NS0yLjg0MSw0LjYxLDQuNjEsMCwwLDEsMS44NDMtMS44OSw1LjQ4NSw1LjQ4NSwwLDAsMSwyLjcyNy0uNjY1LDUuMzMyLDUuMzMyLDAsMCwxLDIuNjQxLjY0Niw0LjU2NSw0LjU2NSwwLDAsMSwxLjgwNSwxLjgxNUE1LjQ2NSw1LjQ2NSwwLDAsMS03My4wMjctNS40OTFabS0yLjI2MS0uNjg0YTIuNDY1LDIuNDY1LDAsMCwwLS44NTUtMS45MTksMy4wNTcsMy4wNTcsMCwwLDAtMi4wNzEtLjcyMiwyLjc4MiwyLjc4MiwwLDAsMC0xLjkxOS43MTMsMi45NzgsMi45NzgsMCwwLDAtLjk1LDEuOTI4Wm0xOS4wNTctLjYwOGEyLjkyLDIuOTIsMCwwLDEsMS44MDUsMS4xMjEsMy4zLDMuMywwLDAsMSwuNzQxLDIuMTA5LDMuMjY4LDMuMjY4LDAsMCwxLS41MjMsMS44MTUsMy41NDEsMy41NDEsMCwwLDEtMS41MSwxLjI3Myw1LjM0LDUuMzQsMCwwLDEtMi4zLjQ2NUgtNjMuM1YtMTMuMmg1LjAzNWE1LjQsNS40LDAsMCwxLDIuMzE4LjQ1NiwzLjQsMy40LDAsMCwxLDEuNDYzLDEuMjI2LDMuMTE2LDMuMTE2LDAsMCwxLC40OTQsMS43MkEyLjk0NSwyLjk0NSwwLDAsMS01NC42LTcuOSwzLjU0LDMuNTQsMCwwLDEtNTYuMjMxLTYuNzgzWm0tNC45LS44NzRoMi42NzlhMi41NzMsMi41NzMsMCwwLDAsMS42NjItLjQ4NCwxLjY5MiwxLjY5MiwwLDAsMCwuNi0xLjQsMS43MjYsMS43MjYsMCwwLDAtLjYtMS40LDIuNTA2LDIuNTA2LDAsMCwwLTEuNjYyLS41aC0yLjY3OVptMi45MjYsNS44OUEyLjU4OSwyLjU4OSwwLDAsMC01Ni40NzgtMi4zYTEuODM4LDEuODM4LDAsMCwwLC42MjctMS40ODIsMS45MjMsMS45MjMsMCwwLDAtLjY2NS0xLjUzOSwyLjYyMiwyLjYyMiwwLDAsMC0xLjc2Ny0uNTdoLTIuODV2NC4xMjNabTE3LjgtMy43MjRhNi43NzIsNi43NzIsMCwwLDEtLjA3NiwxLjA2NGgtOGEyLjksMi45LDAsMCwwLC45MzEsMi4wMTQsMi45MzksMi45MzksMCwwLDAsMi4wNTIuNzYsMi41MzQsMi41MzQsMCwwLDAsMi40Ny0xLjQ2M2gyLjMzN2E0LjcxNiw0LjcxNiwwLDAsMS0xLjcyLDIuMzY2QTUuMDQ1LDUuMDQ1LDAsMCwxLTQ1LjUuMTcxLDUuMzQ3LDUuMzQ3LDAsMCwxLTQ4LjE4NC0uNWE0LjgsNC44LDAsMCwxLTEuODYyLTEuOSw1LjgsNS44LDAsMCwxLS42NzQtMi44NDEsNS45MzIsNS45MzIsMCwwLDEsLjY1Ni0yLjg0MSw0LjYxLDQuNjEsMCwwLDEsMS44NDMtMS44OUE1LjQ4NSw1LjQ4NSwwLDAsMS00NS41LTEwLjY0YTUuMzMyLDUuMzMyLDAsMCwxLDIuNjQxLjY0Niw0LjU2NSw0LjU2NSwwLDAsMSwxLjgwNSwxLjgxNUE1LjQ2NSw1LjQ2NSwwLDAsMS00MC40LTUuNDkxWm0tMi4yNjEtLjY4NGEyLjQ2NSwyLjQ2NSwwLDAsMC0uODU1LTEuOTE5LDMuMDU3LDMuMDU3LDAsMCwwLTIuMDcxLS43MjIsMi43ODIsMi43ODIsMCwwLDAtMS45MTkuNzEzLDIuOTc4LDIuOTc4LDAsMCwwLS45NSwxLjkyOFptMTUuMTQzLTQuMjk0LTYuNDIyLDE1LjM5aC0yLjI0MmwyLjEyOC01LjA5Mi00LjEyMy0xMC4zaDIuNDEzbDIuOTQ1LDcuOTgsMy4wNTktNy45OFpNLTIwLjAxNi4xNzFBNS4zNjEsNS4zNjEsMCwwLDEtMjIuNy0uNWE0Ljg0NSw0Ljg0NSwwLDAsMS0xLjg4MS0xLjksNS43MzEsNS43MzEsMCwwLDEtLjY4NC0yLjg0MSw1LjYyMSw1LjYyMSwwLDAsMSwuNy0yLjgzMSw0Ljg1Niw0Ljg1NiwwLDAsMSwxLjkxOS0xLjksNS41NjgsNS41NjgsMCwwLDEsMi43MTctLjY2NSw1LjU2OCw1LjU2OCwwLDAsMSwyLjcxNy42NjUsNC44NTYsNC44NTYsMCwwLDEsMS45MTksMS45LDUuNjIxLDUuNjIxLDAsMCwxLC43LDIuODMxQTUuNSw1LjUsMCwwLDEtMTUuMy0yLjQxMyw1LDUsMCwwLDEtMTcuMjcxLS41LDUuNjY4LDUuNjY4LDAsMCwxLTIwLjAxNi4xNzFabTAtMS44ODFhMy4yMjMsMy4yMjMsMCwwLDAsMS41NjgtLjQsMy4wNCwzLjA0LDAsMCwwLDEuMTg4LTEuMiwzLjg0OCwzLjg0OCwwLDAsMCwuNDU2LTEuOTM4LDMuOTI4LDMuOTI4LDAsMCwwLS40MzctMS45MjlBMi45NSwyLjk1LDAsMCwwLTE4LjQtOC4zNmEzLjE3LDMuMTcsMCwwLDAtMS41NTgtLjQsMy4xMTcsMy4xMTcsMCwwLDAtMS41NDkuNCwyLjg0OCwyLjg0OCwwLDAsMC0xLjEzLDEuMTg3LDQuMDc1LDQuMDc1LDAsMCwwLS40MTgsMS45MjksMy42NzMsMy42NzMsMCwwLDAsLjg2NSwyLjYxMkEyLjg1NywyLjg1NywwLDAsMC0yMC4wMTYtMS43MVptMTQuMTkzLTguOTNhNC43LDQuNywwLDAsMSwyLjIxNC41MTMsMy42NDgsMy42NDgsMCwwLDEsMS41MywxLjUyQTUsNSwwLDAsMS0xLjUzLTYuMTc1VjBILTMuNjc3Vi01Ljg1MmEzLjAzOSwzLjAzOSwwLDAsMC0uNy0yLjE1N0EyLjUsMi41LDAsMCwwLTYuMy04Ljc1OWEyLjUzMywyLjUzMywwLDAsMC0xLjkyOS43NUEzLjAxMywzLjAxMywwLDAsMC04Ljk0LTUuODUyVjBoLTIuMTY2Vi0xMC40NjlILTguOTR2MS4yYTMuNTg1LDMuNTg1LDAsMCwxLDEuMzU5LTEuMDA3QTQuMzQzLDQuMzQzLDAsMCwxLTUuODI0LTEwLjY0Wk0xLjgzMy01LjI4MmE1Ljc5NCw1Ljc5NCwwLDAsMSwuNjU1LTIuNzkzQTQuOCw0LjgsMCwwLDEsNC4yNzUtOS45NjVhNC44Miw0LjgyLDAsMCwxLDIuNTE4LS42NzUsNC45MSw0LjkxLDAsMCwxLDIuMDIzLjQ0N0E0LjE0LDQuMTQsMCwwLDEsMTAuNC05LjAwNlYtMTQuMDZoMi4xODVWMEgxMC40Vi0xLjU3N0E0LjA1NSw0LjA1NSwwLDAsMSw4LjkzLS4zMjMsNC41NjksNC41NjksMCwwLDEsNi43NzMuMTcxYTQuNjg1LDQuNjg1LDAsMCwxLTIuNS0uNjkzQTQuODk1LDQuODk1LDAsMCwxLDIuNDg5LTIuNDYxLDUuOTYyLDUuOTYyLDAsMCwxLDEuODMzLTUuMjgyWm04LjU2OS4wMzhhMy43OTEsMy43OTEsMCwwLDAtLjQ0Ni0xLjg4MUEzLjEzNCwzLjEzNCwwLDAsMCw4Ljc4Ny04LjM0MWEzLjA1NywzLjA1NywwLDAsMC0xLjU1OC0uNDE4LDMuMTEyLDMuMTEyLDAsMCwwLTEuNTU4LjQwOEEzLjA4MSwzLjA4MSwwLDAsMCw0LjUtNy4xNTRhMy43MzcsMy43MzcsMCwwLDAtLjQ0NywxLjg3MiwzLjksMy45LDAsMCwwLC40NDcsMS45QTMuMTUsMy4xNSwwLDAsMCw1LjY4MS0yLjEzOGEzLjAyMSwzLjAyMSwwLDAsMCwxLjU0OS40MjgsMy4wNTcsMy4wNTcsMCwwLDAsMS41NTgtLjQxOEEzLjExOSwzLjExOSwwLDAsMCw5Ljk1Ni0zLjM1MywzLjg0NSwzLjg0NSwwLDAsMCwxMC40LTUuMjQ0Wk0yNS41NjUtOC43djUuNzk1YTEuMTEyLDEuMTEyLDAsMCwwLC4yNzYuODQ2LDEuMzcsMS4zNywwLDAsMCwuOTQuMjU2aDEuMzNWMEgyNi40YTMuMywzLjMsMCwwLDEtMi4yNDItLjY4NCwyLjgxOSwyLjgxOSwwLDAsMS0uNzc5LTIuMjIzVi04LjdIMjIuMTQ1di0xLjc2N0gyMy4zOHYtMi42aDIuMTg1djIuNmgyLjU0NlYtOC43Wk0zNi44NS0xMC42NGE0LjM5MSw0LjM5MSwwLDAsMSwyLjEzOC41MTMsMy42NTEsMy42NTEsMCwwLDEsMS40ODIsMS41Miw1LjA3Miw1LjA3MiwwLDAsMSwuNTQyLDIuNDMyVjBIMzguODY0Vi01Ljg1MmEzLjAzOSwzLjAzOSwwLDAsMC0uNy0yLjE1NywyLjUsMi41LDAsMCwwLTEuOTE5LS43NSwyLjUzMywyLjUzMywwLDAsMC0xLjkyOS43NUEzLjAxMywzLjAxMywwLDAsMCwzMy42LTUuODUyVjBIMzEuNDM1Vi0xNC4wNkgzMy42djQuODA3QTMuNjMyLDMuNjMyLDAsMCwxLDM1LTEwLjI3OSw0LjY2OSw0LjY2OSwwLDAsMSwzNi44NS0xMC42NFpNNTQuNjkxLTUuNDkxYTYuNzcyLDYuNzcyLDAsMCwxLS4wNzYsMS4wNjRoLThhMi45LDIuOSwwLDAsMCwuOTMxLDIuMDE0LDIuOTM5LDIuOTM5LDAsMCwwLDIuMDUyLjc2LDIuNTM0LDIuNTM0LDAsMCwwLDIuNDctMS40NjNoMi4zMzdhNC43MTYsNC43MTYsMCwwLDEtMS43MiwyLjM2NkE1LjA0NSw1LjA0NSwwLDAsMSw0OS42LjE3MSw1LjM0Nyw1LjM0NywwLDAsMSw0Ni45MTEtLjVhNC44LDQuOCwwLDAsMS0xLjg2Mi0xLjksNS44LDUuOCwwLDAsMS0uNjc0LTIuODQxLDUuOTMyLDUuOTMyLDAsMCwxLC42NTYtMi44NDEsNC42MSw0LjYxLDAsMCwxLDEuODQzLTEuODlBNS40ODUsNS40ODUsMCwwLDEsNDkuNi0xMC42NGE1LjMzMiw1LjMzMiwwLDAsMSwyLjY0MS42NDYsNC41NjUsNC41NjUsMCwwLDEsMS44MDUsMS44MTVBNS40NjUsNS40NjUsMCwwLDEsNTQuNjkxLTUuNDkxWk01Mi40My02LjE3NWEyLjQ2NSwyLjQ2NSwwLDAsMC0uODU1LTEuOTE5QTMuMDU3LDMuMDU3LDAsMCwwLDQ5LjUtOC44MTZhMi43ODIsMi43ODIsMCwwLDAtMS45MTkuNzEzLDIuOTc4LDIuOTc4LDAsMCwwLS45NSwxLjkyOFpNNzAuNDQyLjEzM2E2Ljg0LDYuODQsMCwwLDEtMy4zOTEtLjg2NEE2LjQwNiw2LjQwNiwwLDAsMSw2NC42LTMuMTQ1YTYuOCw2LjgsMCwwLDEtLjktMy40ODcsNi43NDQsNi43NDQsMCwwLDEsLjktMy40NzcsNi40MjYsNi40MjYsMCwwLDEsMi40NTEtMi40LDYuODQsNi44NCwwLDAsMSwzLjM5MS0uODY0LDYuODc3LDYuODc3LDAsMCwxLDMuNDEuODY0LDYuMzU4LDYuMzU4LDAsMCwxLDIuNDQyLDIuNCw2LjgsNi44LDAsMCwxLC44OTMsMy40NzcsNi44NTIsNi44NTIsMCwwLDEtLjg5MywzLjQ4N0E2LjMzOCw2LjMzOCwwLDAsMSw3My44NTMtLjczMSw2Ljg3Nyw2Ljg3NywwLDAsMSw3MC40NDIuMTMzWm0wLTEuODgxYTQuNTUyLDQuNTUyLDAsMCwwLDIuMzM3LS42LDQuMTQ5LDQuMTQ5LDAsMCwwLDEuNjA1LTEuNzEsNS40OTEsNS40OTEsMCwwLDAsLjU3OS0yLjU3NUE1LjQzMyw1LjQzMywwLDAsMCw3NC4zODUtOS4yYTQuMSw0LjEsMCwwLDAtMS42MDUtMS42OTEsNC42MDksNC42MDksMCwwLDAtMi4zMzctLjU4OSw0LjYwOSw0LjYwOSwwLDAsMC0yLjMzNy41ODlBNC4xLDQuMSwwLDAsMCw2Ni41LTkuMmE1LjQzMyw1LjQzMywwLDAsMC0uNTc5LDIuNTY1QTUuNDkxLDUuNDkxLDAsMCwwLDY2LjUtNC4wNTZhNC4xNDksNC4xNDksMCwwLDAsMS42MDUsMS43MUE0LjU1Miw0LjU1MiwwLDAsMCw3MC40NDItMS43NDhabTEyLjM2OS03LjJhMy40LDMuNCwwLDAsMSwxLjI2My0xLjI0NSwzLjczNywzLjczNywwLDAsMSwxLjg3MS0uNDQ3Vi04LjRIODUuNGEyLjYzOCwyLjYzOCwwLDAsMC0xLjkyOS42NDYsMy4wODksMy4wODksMCwwLDAtLjY1NSwyLjI0MlYwSDgwLjY0NlYtMTAuNDY5aDIuMTY2Wm01LjczOCwzLjY2N0E1Ljc5NCw1Ljc5NCwwLDAsMSw4OS4yLTguMDc1YTQuOCw0LjgsMCwwLDEsMS43ODYtMS44OTEsNC44Miw0LjgyLDAsMCwxLDIuNTE4LS42NzUsNC45MSw0LjkxLDAsMCwxLDIuMDIzLjQ0Nyw0LjE0LDQuMTQsMCwwLDEsMS41ODcsMS4xODdWLTE0LjA2SDk5LjNWMEg5Ny4xMThWLTEuNTc3QTQuMDU1LDQuMDU1LDAsMCwxLDk1LjY0Ni0uMzIzYTQuNTY5LDQuNTY5LDAsMCwxLTIuMTU3LjQ5NCw0LjY4NSw0LjY4NSwwLDAsMS0yLjUtLjY5M0E0Ljg5NSw0Ljg5NSwwLDAsMSw4OS4yLTIuNDYxLDUuOTYyLDUuOTYyLDAsMCwxLDg4LjU0OS01LjI4MlptOC41NjkuMDM4YTMuNzkxLDMuNzkxLDAsMCwwLS40NDctMS44ODFBMy4xMzQsMy4xMzQsMCwwLDAsOTUuNS04LjM0MWEzLjA1NywzLjA1NywwLDAsMC0xLjU1OC0uNDE4LDMuMTEyLDMuMTEyLDAsMCwwLTEuNTU4LjQwOCwzLjA4MSwzLjA4MSwwLDAsMC0xLjE2OSwxLjIsMy43MzcsMy43MzcsMCwwLDAtLjQ0NiwxLjg3MiwzLjksMy45LDAsMCwwLC40NDYsMS45QTMuMTUsMy4xNSwwLDAsMCw5Mi40LTIuMTM4YTMuMDIxLDMuMDIxLDAsMCwwLDEuNTQ5LjQyOEEzLjA1NywzLjA1NywwLDAsMCw5NS41LTIuMTI4YTMuMTE5LDMuMTE5LDAsMCwwLDEuMTY5LTEuMjI1QTMuODQ1LDMuODQ1LDAsMCwwLDk3LjExOC01LjI0NFptNy40NjctNi42MTJhMS4zNDIsMS4zNDIsMCwwLDEtLjk4OC0uNCwxLjM0MiwxLjM0MiwwLDAsMS0uNC0uOTg4LDEuMzQyLDEuMzQyLDAsMCwxLC40LS45ODgsMS4zNDIsMS4zNDIsMCwwLDEsLjk4OC0uNCwxLjMxOSwxLjMxOSwwLDAsMSwuOTY5LjQsMS4zNDIsMS4zNDIsMCwwLDEsLjQuOTg4LDEuMzQyLDEuMzQyLDAsMCwxLS40Ljk4OEExLjMxOSwxLjMxOSwwLDAsMSwxMDQuNTg1LTExLjg1NlptMS4wNjQsMS4zODdWMGgtMi4xNjZWLTEwLjQ2OVptOS40NjItLjE3MWE0LjcsNC43LDAsMCwxLDIuMjE0LjUxMywzLjY0OCwzLjY0OCwwLDAsMSwxLjUyOSwxLjUyLDUsNSwwLDAsMSwuNTUxLDIuNDMyVjBoLTIuMTQ3Vi01Ljg1MmEzLjAzOSwzLjAzOSwwLDAsMC0uNy0yLjE1NywyLjUsMi41LDAsMCwwLTEuOTE5LS43NSwyLjUzMywyLjUzMywwLDAsMC0xLjkyOS43NUEzLjAxMywzLjAxMywwLDAsMCwxMTItNS44NTJWMGgtMi4xNjZWLTEwLjQ2OUgxMTJ2MS4yYTMuNTg1LDMuNTg1LDAsMCwxLDEuMzU4LTEuMDA3QTQuMzQzLDQuMzQzLDAsMCwxLDExNS4xMTEtMTAuNjRabTcuNjU3LDUuMzU4YTUuNzk0LDUuNzk0LDAsMCwxLC42NTUtMi43OTMsNC44LDQuOCwwLDAsMSwxLjc4Ni0xLjg5MSw0Ljc4NSw0Ljc4NSwwLDAsMSwyLjUtLjY3NSw0LjU3LDQuNTcsMCwwLDEsMi4xNTcuNDg0LDQuMzc2LDQuMzc2LDAsMCwxLDEuNDczLDEuMjA3di0xLjUyaDIuMTg1VjBoLTIuMTg1Vi0xLjU1OGE0LjMsNC4zLDAsMCwxLTEuNSwxLjIzNSw0LjYyNiw0LjYyNiwwLDAsMS0yLjE2Ni40OTQsNC42LDQuNiwwLDAsMS0yLjQ3LS42OTMsNC45MTgsNC45MTgsMCwwLDEtMS43NzctMS45MzhBNS45NjIsNS45NjIsMCwwLDEsMTIyLjc2OS01LjI4MlptOC41NjkuMDM4YTMuNzkxLDMuNzkxLDAsMCwwLS40NDctMS44ODEsMy4xMzQsMy4xMzQsMCwwLDAtMS4xNjktMS4yMTYsMy4wNTcsMy4wNTcsMCwwLDAtMS41NTgtLjQxOCwzLjExMiwzLjExMiwwLDAsMC0xLjU1OC40MDgsMy4wODEsMy4wODEsMCwwLDAtMS4xNjksMS4yLDMuNzM3LDMuNzM3LDAsMCwwLS40NDYsMS44NzIsMy45LDMuOSwwLDAsMCwuNDQ2LDEuOSwzLjE1LDMuMTUsMCwwLDAsMS4xNzgsMS4yNDQsMy4wMjEsMy4wMjEsMCwwLDAsMS41NDkuNDI4LDMuMDU3LDMuMDU3LDAsMCwwLDEuNTU4LS40MTgsMy4xMTgsMy4xMTgsMCwwLDAsMS4xNjktMS4yMjVBMy44NDUsMy44NDUsMCwwLDAsMTMxLjMzOC01LjI0NFptOC41MzEtMy43YTMuNCwzLjQsMCwwLDEsMS4yNjQtMS4yNDVBMy43MzcsMy43MzcsMCwwLDEsMTQzLTEwLjY0Vi04LjRoLS41NTFhMi42MzgsMi42MzgsMCwwLDAtMS45MjguNjQ2LDMuMDg5LDMuMDg5LDAsMCwwLS42NTYsMi4yNDJWMEgxMzcuN1YtMTAuNDY5aDIuMTY2Wm0xNS44ODQtMS41MkwxNDkuMzMsNC45MjFoLTIuMjQybDIuMTI4LTUuMDkyLTQuMTIzLTEwLjNoMi40MTNsMi45NDUsNy45OCwzLjA1OS03Ljk4WiIgZGF0YS1uYW1lPSJQYXRoIDE2NTAiIGZpbGw9IiMzMDMwMzAiIGlkPSJQYXRoXzE2NTAiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDQxMzggLTMxODIuNDk3KSIvPgogICAgICA8cGF0aCBkPSJNMjg2Ljg2NS05NS4wNDZhMTAuNTkzLDEwLjU5MywwLDAsMS00LjI1OS04LjM5NGgxMC40NzNhMy45MDcsMy45MDcsMCwwLDAsMS4xLDIuNzA2LDMuNTM4LDMuNTM4LDAsMCwwLDIuNDU1Ljg1MSwzLjU0NywzLjU0NywwLDAsMCwyLjIzLS42NzYsMi4yNDIsMi4yNDIsMCwwLDAsLjg3Ny0xLjg3OSwyLjY1OSwyLjY1OSwwLDAsMC0xLjQ1My0yLjQwNiwyNS42ODYsMjUuNjg2LDAsMCwwLTQuNzExLTEuOSw0Mi4xOSw0Mi4xOSwwLDAsMS01LjU4Ny0yLjIzLDEwLjcsMTAuNywwLDAsMS0zLjcwOC0zLjE1Nyw4Ljc1Myw4Ljc1MywwLDAsMS0xLjU3OC01LjQzNyw5LjkxMiw5LjkxMiwwLDAsMSwxLjctNS44MzksMTAuNTM1LDEwLjUzNSwwLDAsMSw0LjcxLTMuNjgzLDE3LjU4OSwxNy41ODksMCwwLDEsNi44MTYtMS4yNTNxNi4xNjMsMCw5Ljg0NywyLjg4MmExMC4zNjcsMTAuMzY3LDAsMCwxLDMuOTMzLDguMDkzSDI5OS4wNDNhMy4xNTMsMy4xNTMsMCwwLDAtLjk3Ny0yLjQwNiwzLjUxNywzLjUxNywwLDAsMC0yLjM4LS44LDIuNTQ3LDIuNTQ3LDAsMCwwLTEuOC42NTEsMi40LDIuNCwwLDAsMC0uNywxLjg1NCwyLjI4MywyLjI4MywwLDAsMCwuNzc3LDEuNzI4LDcuMTE4LDcuMTE4LDAsMCwwLDEuOTI5LDEuMjUzcTEuMTUyLjUyNiwzLjQwOCwxLjMyN2E0Mi4wNzEsNDIuMDcxLDAsMCwxLDUuNTM2LDIuMjgsMTEuMywxMS4zLDAsMCwxLDMuNzU4LDMuMTU4LDguMTE0LDguMTE0LDAsMCwxLDEuNTc5LDUuMTM2LDEwLjQsMTAuNCwwLDAsMS0xLjU3OSw1LjY2MywxMC44MzQsMTAuODM0LDAsMCwxLTQuNTU5LDMuOTU5LDE1LjksMTUuOSwwLDAsMS03LjA0MSwxLjQ1M0ExNi41NjQsMTYuNTY0LDAsMCwxLDI4Ni44NjUtOTUuMDQ2WiIgZGF0YS1uYW1lPSJQYXRoIDE1ODAiIGZpbGw9IiMzMDMwMzAiIGlkPSJQYXRoXzE1ODAiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDM2OTcuOTIgLTMxMTkuNjg5KSIvPgogICAgICA8cGF0aCBkPSJNMzYyLjUxNC0xMjcuNjA2LDM1MC4zMzctOTIuMjc3SDMzNy43NTlsLTEyLjIyNy0zNS4zMjloMTAuNTIzbDguMDE4LDI1LjUwNiw3Ljk2OC0yNS41MDZaIiBkYXRhLW5hbWU9IlBhdGggMTU4MSIgZmlsbD0iIzMwMzAzMCIgaWQ9IlBhdGhfMTU4MSIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMzY4Ny4wMTUgLTMxMTkuODc3KSIvPgogICAgICA8cGF0aCBkPSJNMzk5LjMyMi0xMTkuNDMyYTE1LjY2MywxNS42NjMsMCwwLDEsNi4xODgtNi4zNjUsMTguMzI2LDE4LjMyNiwwLDAsMSw5LjIyMS0yLjI4LDE3LjQ5LDE3LjQ5LDAsMCwxLDExLjEyNSwzLjUzMywxNi4wMjksMTYuMDI5LDAsMCwxLDUuODEyLDkuNkg0MjEuMUE3LjA4OSw3LjA4OSwwLDAsMCw0MTguNDY0LTExOGE3LjE1Nyw3LjE1NywwLDAsMC0zLjg4My0xLjA1Myw2LjcyMiw2LjcyMiwwLDAsMC01LjQzOCwyLjQzLDkuOCw5LjgsMCwwLDAtMi4wMjksNi40ODksOS44ODMsOS44ODMsMCwwLDAsMi4wMjksNi41NCw2LjcyMiw2LjcyMiwwLDAsMCw1LjQzOCwyLjQzLDcuMTU4LDcuMTU4LDAsMCwwLDMuODgzLTEuMDUzLDcuMDg1LDcuMDg1LDAsMCwwLDIuNjMxLTMuMDU2aDEwLjU3M2ExNi4wMjksMTYuMDI5LDAsMCwxLTUuODEyLDkuNiwxNy40OSwxNy40OSwwLDAsMS0xMS4xMjUsMy41MzMsMTguMzExLDE4LjMxMSwwLDAsMS05LjIyMS0yLjI4LDE1LjY1MiwxNS42NTIsMCwwLDEtNi4xODgtNi4zNjQsMTkuNTQyLDE5LjU0MiwwLDAsMS0yLjE4LTkuMzQ2QTE5LjQzNCwxOS40MzQsMCwwLDEsMzk5LjMyMi0xMTkuNDMyWiIgZGF0YS1uYW1lPSJQYXRoIDE1ODIiIGZpbGw9IiMzMDMwMzAiIGlkPSJQYXRoXzE1ODIiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDM2NjguODIzIC0zMTE5Ljc1OCkiLz4KICAgICAgPHBhdGggZD0iTTQ3NC41NjMtOTguMDRINDYyLjAzNWwtMS45LDUuNzYzSDQ0OS44MDlsMTIuODc4LTM1LjMyOWgxMS4zMjZsMTIuODI4LDM1LjMyOUg0NzYuNDY3Wm0tMi40NTUtNy41MTdMNDY4LjMtMTE2Ljk4MmwtMy43NTksMTEuNDI1WiIgZGF0YS1uYW1lPSJQYXRoIDE1ODMiIGZpbGw9IiMzMDMwMzAiIGlkPSJQYXRoXzE1ODMiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDM2NTUuNDQzIC0zMTE5Ljg3NykiLz4KICAgICAgPHBhdGggZD0iTTUzMy41NDMtMTA5Ljk5MmExMC42ODUsMTAuNjg1LDAsMCwxLTQuNDYsNC4yMDksMTUuNDI5LDE1LjQyOSwwLDAsMS03LjI5MSwxLjU3OGgtNC44NjF2MTEuOTI2aC05LjgyMnYtMzUuMzI5aDE0LjY4M2ExNS45NDMsMTUuOTQzLDAsMCwxLDcuMjQxLDEuNSwxMC4zNCwxMC4zNCwwLDAsMSw0LjQ4NSw0LjE1OSwxMi4yMSwxMi4yMSwwLDAsMSwxLjUsNi4xMTRBMTEuNzIxLDExLjcyMSwwLDAsMSw1MzMuNTQzLTEwOS45OTJaTTUyNS0xMTUuODNxMC0zLjg1OC00LjE2LTMuODU5aC0zLjkwOXY3LjY2N2gzLjkwOVE1MjUtMTEyLjAyMSw1MjUtMTE1LjgzWiIgZGF0YS1uYW1lPSJQYXRoIDE1ODQiIGZpbGw9IiMzMDMwMzAiIGlkPSJQYXRoXzE1ODQiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDM2NDAuODg2IC0zMTE5Ljg3NykiLz4KICAgICAgPHBhdGggZD0iTTU2My4wMTMtMTI3LjYwNnYzNS4zMjloLTkuODIydi0zNS4zMjlaIiBkYXRhLW5hbWU9IlBhdGggMTU4NSIgZmlsbD0iIzMwMzAzMCIgaWQ9IlBhdGhfMTU4NSIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMzYyOS4xOCAtMzExOS44NzcpIi8+CiAgICAgIDxwYXRoIGQ9Ik02MDMuMTg0LTEyNy42MDZ2Ny44MThoLTkuNDIxdjI3LjUxMWgtOS44MjJ2LTI3LjUxMWgtOS4zMnYtNy44MThaIiBkYXRhLW5hbWU9IlBhdGggMTU4NiIgZmlsbD0iIzMwMzAzMCIgaWQ9IlBhdGhfMTU4NiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMzYyMy43MzUgLTMxMTkuODc3KSIvPgogICAgICA8cGF0aCBkPSJNNjQyLjctOTguMDRINjMwLjE3NmwtMS45LDUuNzYzSDYxNy45NDlsMTIuODc4LTM1LjMyOWgxMS4zMjVMNjU0Ljk4LTkyLjI3N0g2NDQuNjA4Wm0tMi40NTYtNy41MTctMy44MDktMTEuNDI1LTMuNzU4LDExLjQyNVoiIGRhdGEtbmFtZT0iUGF0aCAxNTg3IiBmaWxsPSIjMzAzMDMwIiBpZD0iUGF0aF8xNTg3IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgzNjEyLjcyOCAtMzExOS44NzcpIi8+CiAgICAgIDxwYXRoIGQ9Ik02ODUuMDcxLTk5Ljc5NGgxMC45NzR2Ny41MTdoLTIwLjh2LTM1LjMyOWg5LjgyMloiIGRhdGEtbmFtZT0iUGF0aCAxNTg4IiBmaWxsPSIjMzAzMDMwIiBpZD0iUGF0aF8xNTg4IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgzNTk4LjE3MiAtMzExOS44NzcpIi8+CiAgICAgIDxnIGRhdGEtbmFtZT0iR3JvdXAgMzE0MSIgaWQ9Ikdyb3VwXzMxNDEtMiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMzg2MyAtMzI2OS44MjUpIj4KICAgICAgICA8cGF0aCBkPSJNMTg2LjgzNy03OC4wNDFzLTEwLjQxMS0yMS42MTgtLjA3My00MS43MjYsMzMuOTc1LTI0LjIyMywzMy45NzUtMjQuMjIzLDEwLjQxLDIxLjYxOS4wNzMsNDEuNzI3UzE4Ni44MzctNzguMDQxLDE4Ni44MzctNzguMDQxWiIgZGF0YS1uYW1lPSJQYXRoIDE2MTMiIGZpbGw9InVybCgjbGluZWFyLWdyYWRpZW50KSIgaWQ9IlBhdGhfMTYxMyIgb3BhY2l0eT0iMC44IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMTM5LjU2OSAxNTcuOTY5KSIvPgogICAgICAgIDxwYXRoIGQ9Ik0xODAuOTYzLTgyLjcwOHMyMC42NTgtMTUuNjEyLDIwLjY1OC00MC4wMTEtMjAuNjU4LTQwLjAxMS0yMC42NTgtNDAuMDExLTIwLjY1NywxNS42MTItMjAuNjU3LDQwLjAxMVMxODAuOTYzLTgyLjcwOCwxODAuOTYzLTgyLjcwOFoiIGRhdGEtbmFtZT0iUGF0aCAxNjE0IiBmaWxsPSJ1cmwoI2xpbmVhci1ncmFkaWVudC0yKSIgaWQ9IlBhdGhfMTYxNCIgb3BhY2l0eT0iMC44IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMTM0LjAxIDE2Mi43MykiLz4KICAgICAgICA8cGF0aCBkPSJNMTQ0LjAyNi00Ni44NzhhMTguNzkzLDE4Ljc5MywwLDAsMCwxMi41ODgsNS4wODdBMTguNzkxLDE4Ljc5MSwwLDAsMCwxNjkuMi00Ni44NzdhMTguNzksMTguNzksMCwwLDAtMTIuNTg3LTUuMDg3QTE4LjgsMTguOCwwLDAsMCwxNDQuMDI2LTQ2Ljg3OFoiIGRhdGEtbmFtZT0iUGF0aCAxNjE2IiBmaWxsPSJ1cmwoI2xpbmVhci1ncmFkaWVudC0zKSIgaWQ9IlBhdGhfMTYxNiIgb3BhY2l0eT0iMC44IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMTI5Ljg3NCAxMzQuNTkxKSIvPgogICAgICAgIDxwYXRoIGQ9Ik0xOTcuMTE1LTQ2Ljg3OEExOC43OSwxOC43OSwwLDAsMCwyMDkuNy00MS43OTFhMTguNzk0LDE4Ljc5NCwwLDAsMCwxMi41ODgtNS4wODZBMTguNzkzLDE4Ljc5MywwLDAsMCwyMDkuNy01MS45NjQsMTguNzkxLDE4Ljc5MSwwLDAsMCwxOTcuMTE1LTQ2Ljg3OFoiIGRhdGEtbmFtZT0iUGF0aCAxNjE3IiBmaWxsPSJ1cmwoI2xpbmVhci1ncmFkaWVudC00KSIgaWQ9IlBhdGhfMTYxNyIgb3BhY2l0eT0iMC44IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMTQzLjM2MiAxMzQuNTkxKSIvPgogICAgICAgIDxwYXRoIGQ9Ik0xODguMTkzLTcxLjY4OXMtMi45MzUtMjEuMSwxMS4yNjItMzUuMywzNS4zLTExLjI2MSwzNS4zLTExLjI2MSwyLjkzNiwyMS4xLTExLjI2MSwzNS4zUzE4OC4xOTMtNzEuNjg5LDE4OC4xOTMtNzEuNjg5WiIgZGF0YS1uYW1lPSJQYXRoIDE2MTgiIGZpbGw9InVybCgjbGluZWFyLWdyYWRpZW50LTUpIiBpZD0iUGF0aF8xNjE4IiBvcGFjaXR5PSIwLjgiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC0xNDEuMDMxIDE1MS40OTQpIi8+CiAgICAgICAgPHBhdGggZD0iTTE3NC40MzMtNzguMDQxczEwLjQxMS0yMS42MTguMDc0LTQxLjcyNi0zMy45NzUtMjQuMjIzLTMzLjk3NS0yNC4yMjMtMTAuNDExLDIxLjYxOS0uMDc0LDQxLjcyN1MxNzQuNDMzLTc4LjA0MSwxNzQuNDMzLTc4LjA0MVoiIGRhdGEtbmFtZT0iUGF0aCAxNjE5IiBmaWxsPSJ1cmwoI2xpbmVhci1ncmFkaWVudC02KSIgaWQ9IlBhdGhfMTYxOSIgb3BhY2l0eT0iMC44IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMTI3LjgwNiAxNTcuOTY5KSIvPgogICAgICAgIDxwYXRoIGQ9Ik0xNzEuODctNzEuNjg5czIuOTM1LTIxLjEtMTEuMjYyLTM1LjMtMzUuMy0xMS4yNjEtMzUuMy0xMS4yNjEtMi45MzUsMjEuMSwxMS4yNjIsMzUuM1MxNzEuODctNzEuNjg5LDE3MS44Ny03MS42ODlaIiBkYXRhLW5hbWU9IlBhdGggMTYyMCIgZmlsbD0idXJsKCNsaW5lYXItZ3JhZGllbnQtNykiIGlkPSJQYXRoXzE2MjAiIG9wYWNpdHk9IjAuOCIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTEyNS4wNTUgMTUxLjQ5NCkiLz4KICAgICAgICA8cGF0aCBkPSJNMTg2LjI3LTI2LjA5czUuMDc0LTMuODM1LDUuMDc0LTkuODI3LTUuMDc0LTkuODI4LTUuMDc0LTkuODI4UzE4MS4yLTQxLjkxLDE4MS4yLTM1LjkxNywxODYuMjctMjYuMDksMTg2LjI3LTI2LjA5WiIgZGF0YS1uYW1lPSJQYXRoIDE2MTUiIGZpbGw9InVybCgjbGluZWFyLWdyYWRpZW50LTgpIiBpZD0iUGF0aF8xNjE1IiBvcGFjaXR5PSIwLjgiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC0xMzkuMzE4IDEzMy4wMSkiLz4KICAgICAgICA8ZyBkYXRhLW5hbWU9Ikdyb3VwIDMwMzgiIGlkPSJHcm91cF8zMDM4IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSg4OS4xODcgMTMuNDQxKSI+CiAgICAgICAgICA8cGF0aCBkPSJNMTIyLjYxNSwxOC4wMTh2LjY3NEgxMjEuNXYzLjQ5MWgtLjgzNVYxOC42OTNoLTEuMTF2LS42NzRaIiBkYXRhLW5hbWU9IlBhdGggMTYyMyIgZmlsbD0iIzMwMzAzMCIgaWQ9IlBhdGhfMTYyMyIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTExOS41NTkgLTE4LjAxOCkiLz4KICAgICAgICAgIDxwYXRoIGQ9Ik0xMjguODcsMTguMDE4bC0xLjMyNSwzLjEtMS4zMjQtMy4xaC0uOTV2NC4xNjZoLjgzNnYtMi43MWwxLjEyMSwyLjcxaC42MzNsMS4xMTYtMi43MXYyLjcxaC44MzZWMTguMDE4WiIgZGF0YS1uYW1lPSJQYXRoIDE2MjQiIGZpbGw9IiMzMDMwMzAiIGlkPSJQYXRoXzE2MjQiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC0xMjEuMDEgLTE4LjAxOCkiLz4KICAgICAgICA8L2c+CiAgICAgIDwvZz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPg==';
  const hasBanking = emp.bank_name || emp.bank_account_number;
  const bankSection = hasBanking ? `
<div class="bank">
  <div class="bank-lbl">&#128197; Payment Paid To</div>
  <div class="bank-grid">
    <div><div class="bk-l">Bank</div><div class="bk-v">${emp.bank_name||'—'}</div></div>
    <div><div class="bk-l">Account Number</div><div class="bk-v">${emp.bank_account_number?maskAcc(emp.bank_account_number):'—'}</div></div>
    <div><div class="bk-l">Account Type</div><div class="bk-v">${emp.bank_account_type||'—'}</div></div>
    <div><div class="bk-l">Account Holder</div><div class="bk-v">${emp.bank_account_holder||emp.first_name+' '+emp.last_name}</div></div>
  </div>
</div>` : '';

  const bonusRow = Number(p.bonus||0)>0 ? `<tr><td>Bonus / Commission</td><td></td><td class="r">${fmt(p.bonus)}</td><td></td><td></td><td></td></tr>` : '';
  const otherEarnRow = Number(p.other_earnings||0)>0 ? `<tr><td>Other earnings</td><td></td><td class="r">${fmt(p.other_earnings)}</td><td></td><td></td><td></td></tr>` : '';
  const otherDedRow = Number(p.other_deductions||0)>0 ? `<tr><td></td><td></td><td></td><td>Other deductions</td><td></td><td class="r">${fmt(p.other_deductions)}</td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<title>Payslip ${moLabel} ${yr} ${emp.first_name} ${emp.last_name}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{background:#e8edf2}
body{font-family:Arial,Helvetica,sans-serif;font-size:9.5pt;color:#1a1a1a;min-height:100vh;padding:24px 0}
.page{background:#fff;max-width:820px;margin:0 auto;box-shadow:0 4px 40px rgba(0,0,0,0.18);border-radius:3px;overflow:hidden}
.hdr{background:linear-gradient(135deg,#0d2535 0%,#1a3a4a 100%);padding:22px 30px;display:flex;justify-content:space-between;align-items:flex-start}
.hdr-co-name{font-size:14pt;font-weight:900;color:#fff;letter-spacing:-0.02em;margin-bottom:7px}
.hdr-co-addr{font-size:8pt;color:rgba(255,255,255,0.6);line-height:1.65}
.hdr-right{text-align:right;min-width:180px}
.hdr-pd-lbl{font-size:7pt;font-weight:700;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px}
.hdr-pd-val{font-size:13pt;font-weight:800;color:#fec24f;margin-bottom:12px;letter-spacing:0.02em}
.hdr-logo{width:170px;height:auto;display:block;margin-left:auto}
.emp-strip{padding:16px 30px;background:#f7f9fc;border-bottom:2px solid #e2e8f0;display:grid;grid-template-columns:1fr 1fr;gap:4px 36px}
.er{display:flex;padding:2.5px 0;font-size:8.5pt}
.el{font-weight:700;color:#6b7280;min-width:128px;flex-shrink:0;font-size:7.5pt;text-transform:uppercase;letter-spacing:.04em}
.ev{color:#111827;font-weight:500}
.sec{background:#0d2535;color:#fff;font-size:7pt;font-weight:800;text-transform:uppercase;letter-spacing:.12em;padding:6px 30px}
.tw{padding:0 30px}
table{width:100%;border-collapse:collapse;font-size:8.8pt}
th{font-size:7pt;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;padding:9px 5px 7px;border-bottom:1.5px solid #cbd5e1;text-align:left}
th.r,td.r{text-align:right}
td{padding:5.5px 5px;border-bottom:1px solid #f1f5f9;vertical-align:top;color:#374151}
.tr-tot td{font-weight:700;border-top:1.5px solid #94a3b8;border-bottom:1.5px solid #94a3b8;background:#f8fafc;color:#0f172a;padding:8px 5px}
.tr-nett td{font-weight:800;font-size:11.5pt;color:#0d2535;padding:10px 5px;border-bottom:2.5px solid #fec24f}
.tr-nett td.r{color:#fec24f}
.bank{padding:14px 30px 16px;background:#fffbf5;border-top:1.5px solid #fed7aa;border-bottom:1.5px solid #fed7aa;margin-top:4px}
.bank-lbl{font-size:7.5pt;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#b45309;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.bank-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px 16px}
.bk-l{font-size:7pt;color:#92400e;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}
.bk-v{font-size:9pt;color:#431407;font-weight:600}
.ftr{padding:11px 30px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid #e2e8f0;background:#f9fafb}
.ftr-l{font-size:6.5pt;color:#9ca3af;font-style:italic}
.ftr-r{font-size:6.5pt;color:#9ca3af}
.print-row{padding:18px;text-align:center;background:#f0f4f8}
.pbtn{padding:11px 36px;background:linear-gradient(135deg,#fec24f,#FF5229);color:#fff;border:none;border-radius:8px;font-size:10pt;font-weight:700;cursor:pointer;font-family:Arial;letter-spacing:.02em;box-shadow:0 3px 12px rgba(255,130,21,0.35)}
@media print{html{background:#fff}body{padding:0}.page{box-shadow:none;border-radius:0}.print-row{display:none}}
</style></head>
<body><div class="page">

<div class="hdr">
  <div>
    <div class="hdr-co-name">Smartvest Capital (Pty) Ltd</div>
    <div class="hdr-co-addr">The Station · 63 Peter Place · Bryanston<br>Johannesburg · 2191<br>Reg. No: 2017/499533/07 &nbsp;|&nbsp; FSP Licence: #52449</div>
  </div>
  <div class="hdr-right">
    <div class="hdr-pd-lbl">Pay Date</div>
    <div class="hdr-pd-val">${payDateFmt}</div>
    <img class="hdr-logo" src="data:image/svg+xml;base64,${LOGO}" alt="SV Capital"/>
  </div>
</div>

<div class="emp-strip">
  <div>
    <div class="er"><span class="el">Employee</span><span class="ev">${emp.first_name} ${emp.last_name}</span></div>
    <div class="er"><span class="el">Job Title</span><span class="ev">${emp.role||'—'}</span></div>
    <div class="er"><span class="el">Address</span><span class="ev">${addrHtml}</span></div>
  </div>
  <div>
    <div class="er"><span class="el">Employee Code</span><span class="ev">${empCode}</span></div>
    <div class="er"><span class="el">Identity Number</span><span class="ev">${emp.id_number||'—'}</span></div>
    <div class="er"><span class="el">Employed From</span><span class="ev">${startFmt}</span></div>
    <div class="er"><span class="el">Rate Per Hour</span><span class="ev">R ${rph}</span></div>
  </div>
</div>

<div class="sec" style="margin-top:14px">Earnings &amp; Deductions — ${moLabel} ${yr}</div>
<div class="tw" style="padding-top:10px">
<table>
  <thead><tr>
    <th style="width:32%">Earnings</th><th style="width:10%">Units</th>
    <th class="r" style="width:15%">Amount (R)</th>
    <th style="width:25%">Deductions</th>
    <th class="r" style="width:8%">Opening Bal.</th>
    <th class="r" style="width:10%">Amount (R)</th>
  </tr></thead>
  <tbody>
    <tr><td>Basic salary</td><td></td><td class="r">${fmt(p.basic_salary)}</td><td>PAYE Tax</td><td></td><td class="r">${fmt(p.tax)}</td></tr>
    ${bonusRow}
    ${otherEarnRow}
    <tr><td></td><td></td><td></td><td>Unemployment Insurance Fund</td><td></td><td class="r">${fmt(p.uif_employee)}</td></tr>
    ${otherDedRow}
  </tbody>
  <tfoot>
    <tr class="tr-tot"><td>Total Earnings</td><td></td><td class="r">${fmt(p.total_earnings)}</td><td>Total Deductions</td><td></td><td class="r">${fmt(p.total_deductions)}</td></tr>
    <tr class="tr-nett"><td colspan="3"></td><td><strong>Nett Pay</strong></td><td></td><td class="r"><strong>${fmt(p.nett_pay)}</strong></td></tr>
  </tfoot>
</table>
</div>

<div class="sec" style="margin-top:14px">Company Contributions &amp; Year-to-Date Totals</div>
<div class="tw" style="padding-top:10px;padding-bottom:12px">
<table>
  <thead><tr>
    <th style="width:30%">Company Contributions</th><th class="r" style="width:20%">Amount (R)</th>
    <th style="width:30%">YTD Totals</th><th class="r" style="width:20%">Amount (R)</th>
  </tr></thead>
  <tbody>
    <tr><td>Unemployment Insurance Fund</td><td class="r">${fmt(p.uif_company)}</td><td><b>Taxable earnings</b></td><td class="r"><b>${fmt(p.ytd_taxable_earnings)}</b></td></tr>
    <tr><td></td><td></td><td><b>Taxable company contributions</b></td><td class="r"><b>${fmt(p.ytd_taxable_company_contributions||0)}</b></td></tr>
    <tr><td></td><td></td><td><b>Taxable fringe benefits</b></td><td class="r"><b>${fmt(p.ytd_taxable_fringe_benefits||0)}</b></td></tr>
    <tr><td></td><td></td><td><b>Provision for tax on annual bonus</b></td><td class="r"><b>${fmt(p.ytd_provision_annual_bonus||0)}</b></td></tr>
    <tr><td></td><td></td><td><b>Tax paid</b></td><td class="r"><b>${fmt(p.ytd_tax_paid)}</b></td></tr>
  </tbody>
</table>
</div>

${bankSection}

<div class="ftr">
  <div class="ftr-l">CONFIDENTIAL — This payslip is for the named employee only and must not be shared.</div>
  <div class="ftr-r">Smartvest Capital (Pty) Ltd &nbsp;·&nbsp; ${moLabel} ${yr}</div>
</div>

<div class="print-row">
  <button class="pbtn" onclick="window.print()">Download / Save as PDF</button>
</div>
</div></body></html>`;
}

function openProfileEditModal() {
  const el = document.getElementById('generic-modal');
  el.innerHTML = `<div class="modal" style="width:600px;max-height:90vh;display:flex;flex-direction:column">
    <div class="modal-header">
      <i class="fa-solid fa-user" style="color:var(--accent)"></i>
      <h3>Edit My Profile</h3>
      <button class="btn btn--ghost btn--sm" style="margin-left:auto" id="profModalClose"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="modal-body" style="overflow-y:auto;flex:1">
      <div class="section-head" style="margin-top:0">Contact Information</div>
      <div class="form-row">
        <div class="form-group"><label>Phone</label><input id="prof-phone" value="${_emp.phone||''}" placeholder="+27 82 000 0000" inputmode="tel" /></div>
        <div class="form-group"><label>Date of Birth</label><input type="date" id="prof-dob" value="${_emp.birth_date||''}" /></div>
      </div>
      <div class="form-group"><label>SA ID Number</label><input id="prof-idnum" value="${_emp.id_number||''}" placeholder="YYMMDD0000000" inputmode="numeric" /></div>
      <div class="form-group"><label>Bio</label><textarea id="prof-bio" rows="2">${_emp.bio||''}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label>Emergency Contact Name</label><input id="prof-ecname" value="${_emp.emergency_contact_name||''}" /></div>
        <div class="form-group"><label>Emergency Contact Phone</label><input id="prof-ecphone" value="${_emp.emergency_contact_phone||''}" placeholder="+27 82 000 0000" inputmode="tel" /></div>
      </div>

      <div class="section-head">Address</div>
      <div class="form-group"><label>Address Line 1</label><input id="prof-addr1" value="${_emp.address_line1||''}" placeholder="Street address" /></div>
      <div class="form-group"><label>Address Line 2</label><input id="prof-addr2" value="${_emp.address_line2||''}" placeholder="Suburb / Complex (optional)" /></div>
      <div class="form-row">
        <div class="form-group"><label>City</label><input id="prof-city" value="${_emp.address_city||''}" /></div>
        <div class="form-group"><label>Province</label>
          <select id="prof-province">
            <option value="">Select province…</option>
            ${['Gauteng','Western Cape','KwaZulu-Natal','Eastern Cape','Free State','Limpopo','Mpumalanga','North West','Northern Cape'].map(p=>`<option value="${p}" ${_emp.address_province===p?'selected':''}>${p}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group" style="max-width:200px"><label>Postal Code</label><input id="prof-postal" value="${_emp.address_postal_code||''}" placeholder="0000" inputmode="numeric" maxlength="4" /></div>

      <div class="section-head">Banking Details</div>
      <div class="form-group"><label>Bank Name</label>
        <select id="prof-bank">
          ${['First National Bank','Standard Bank','Nedbank','Absa Bank','Capitec Bank','Investec','Mercantile Bank','African Bank'].map(b=>`<option ${_emp.bank_name===b?'selected':''}>${b}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Account Number</label><input id="prof-accnum" value="${_emp.bank_account_number||''}" placeholder="Account number" inputmode="numeric" /></div>
        <div class="form-group"><label>Account Type</label>
          <select id="prof-acctype">
            ${['Cheque','Savings','Transmission'].map(t=>`<option ${_emp.bank_account_type===t?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Branch Code</label><input id="prof-branch" value="${_emp.bank_branch_code||''}" placeholder="6-digit code" inputmode="numeric" /></div>
        <div class="form-group"><label>Account Holder Name</label><input id="prof-holder" value="${_emp.bank_account_holder||''}" placeholder="As on bank account" /></div>
      </div>

      <div class="section-head">Documents</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:4px">
        <div>
          <div style="font-size:0.78rem;font-weight:600;margin-bottom:6px;color:var(--muted)">Proof of Banking</div>
          <label class="btn btn--secondary btn--sm" style="cursor:pointer;width:100%;justify-content:center">
            <i class="fa-solid fa-upload"></i> ${_emp.proof_of_banking_url ? 'Replace' : 'Upload'}
            <input id="prof-bankdoc" type="file" accept=".pdf,.jpg,.jpeg,.png" style="display:none" />
          </label>
          ${_emp.proof_of_banking_url ? `<div style="font-size:0.7rem;color:var(--success);margin-top:4px"><i class="fa-solid fa-check"></i> On file</div>` : ''}
        </div>
        <div>
          <div style="font-size:0.78rem;font-weight:600;margin-bottom:6px;color:var(--muted)">Proof of ID</div>
          <label class="btn btn--secondary btn--sm" style="cursor:pointer;width:100%;justify-content:center">
            <i class="fa-solid fa-upload"></i> ${_emp.proof_of_id_url ? 'Replace' : 'Upload'}
            <input id="prof-iddoc" type="file" accept=".pdf,.jpg,.jpeg,.png" style="display:none" />
          </label>
          ${_emp.proof_of_id_url ? `<div style="font-size:0.7rem;color:var(--success);margin-top:4px"><i class="fa-solid fa-check"></i> On file</div>` : ''}
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn--secondary" id="profModalCancel">Cancel</button>
      <button class="btn btn--primary" id="profModalSave"><i class="fa-solid fa-floppy-disk"></i> Save Profile</button>
    </div>
  </div>`;
  el.classList.add('open');

  document.getElementById('profModalClose').addEventListener('click', () => closeModal('generic-modal'));
  document.getElementById('profModalCancel').addEventListener('click', () => closeModal('generic-modal'));
  document.getElementById('profModalSave').addEventListener('click', saveProfile);
  document.getElementById('prof-bankdoc').addEventListener('change', function() { handleBankingDocUpload(this); closeModal('generic-modal'); });
  document.getElementById('prof-iddoc').addEventListener('change', function() { handleIdDocUpload(this); closeModal('generic-modal'); });
}

async function saveProfile() {
  // Empty values are sent as null. This matters for DATE columns like
  // birth_date — Postgres rejects '' (invalid date), which previously failed
  // the whole save so nothing (incl. ID number) persisted.
  const val = id => { const v = (document.getElementById(id)?.value || '').trim(); return v === '' ? null : v; };
  const birth_date = val('prof-dob');
  const id_number  = val('prof-idnum');
  const updates = {
    phone:                   val('prof-phone'),
    birth_date,
    id_number,
    bio:                     val('prof-bio'),
    emergency_contact_name:  val('prof-ecname'),
    emergency_contact_phone: val('prof-ecphone'),
    address_line1:           val('prof-addr1'),
    address_line2:           val('prof-addr2'),
    address_city:            val('prof-city'),
    address_province:        val('prof-province'),
    address_postal_code:     val('prof-postal'),
    bank_name:               val('prof-bank'),
    bank_account_number:     val('prof-accnum'),
    bank_account_type:       val('prof-acctype'),
    bank_branch_code:        val('prof-branch'),
    bank_account_holder:     val('prof-holder'),
  };
  const r = await patch(`tables/employees/${_emp.id}`, updates);
  if (r && r.error) { showToast(r.error || 'Could not save profile — please try again.', 'error'); return; }
  Object.assign(_emp, r);
  // Reflect locally in case the API response omits a field on this view
  _emp.birth_date = birth_date;
  _emp.id_number  = id_number;
  closeModal('generic-modal');
  renderProfile();
  renderTopbar();
  showToast('Profile updated successfully!', 'success');
}

/* ═══ VIEW: LEAVE CALENDAR ══════════════════════════════════════════ */
function renderLeaveCalendar() {
  const el = document.getElementById('view-calendar');
  const allLeave = []; // will load all employees' approved leave

  // Load everyone's APPROVED leave from the shared team calendar endpoint
  get('tables/leave-calendar').then(res => {
    const approved = res.data || [];

    const today = new Date();
    const calYear  = today.getFullYear();
    const calMonth = today.getMonth(); // 0-indexed

    renderCalendarView(el, approved, calYear, calMonth);
  });

  el.innerHTML = `
    <div class="view-header">
      <div><h1>Team Leave Calendar</h1><div class="view-sub">See who is on leave &amp; plan accordingly</div></div>
      <div class="view-header-actions">
        <button class="btn btn--primary" onclick="navigate('leave',document.querySelector('[data-view=leave]'))">
          <i class="fa-solid fa-plus"></i> Request Leave
        </button>
      </div>
    </div>
    <div id="cal-loading" style="text-align:center;padding:40px;color:var(--muted)">
      <i class="fa-solid fa-calendar-days" style="font-size:2rem;margin-bottom:10px;display:block;opacity:0.4"></i>
      Loading calendar…
    </div>`;
}

function renderCalendarView(container, leaveList, year, month) {
  const today = new Date();
  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month+1, 0);
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const dayNames   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // Build leave map: date-str → [employee records]
  // Use string-based date arithmetic to avoid timezone shifts (toISOString
  // converts to UTC, which can move a local-midnight date to the previous day).
  const leaveMap = {};
  leaveList.forEach(l => {
    // Normalise to YYYY-MM-DD regardless of whether pg returned a Date object
    // or an ISO timestamp string (e.g. "2026-07-09T00:00:00.000Z").
    const startStr = (l.start_date instanceof Date ? l.start_date : new Date(l.start_date + (String(l.start_date).length === 10 ? 'T12:00:00Z' : ''))).toISOString().slice(0,10);
    const endStr   = (l.end_date   instanceof Date ? l.end_date   : new Date(l.end_date   + (String(l.end_date  ).length === 10 ? 'T12:00:00Z' : ''))).toISOString().slice(0,10);
    // The shared calendar embeds the employee's display fields on each leave
    // row (staff can't read other employees' records directly).
    const emp = _employees.find(e=>e.id===l.employee_id) || {
      id: l.employee_id,
      first_name: l.first_name || 'Employee',
      last_name:  l.last_name || '',
      avatar_color: l.avatar_color || '#eda5ff',
      avatar_initials: l.avatar_initials || ((l.first_name||'E')[0] + (l.last_name||'')[0]).toUpperCase(),
    };
    // Iterate every calendar day in the leave range using UTC noon to stay
    // safely inside the intended calendar day regardless of client timezone.
    let cur = startStr;
    while (cur <= endStr) {
      if (!leaveMap[cur]) leaveMap[cur] = [];
      leaveMap[cur].push({ emp, leave: l });
      const next = new Date(cur + 'T12:00:00Z');
      next.setUTCDate(next.getUTCDate() + 1);
      cur = next.toISOString().slice(0,10);
    }
  });

  // Build birthdays for this month
  const bdMap = {};
  _employees.forEach(emp => {
    if (!emp.birth_date) return;
    const [,bm,bd] = emp.birth_date.split('-').map(Number);
    if (bm-1 === month) {
      const key = `${year}-${String(bm).padStart(2,'0')}-${String(bd).padStart(2,'0')}`;
      if (!bdMap[key]) bdMap[key] = [];
      bdMap[key].push(emp);
    }
  });

  // Calendar grid cells
  const startDow = firstDay.getDay(); // 0=Sun
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= lastDay.getDate(); d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  // Legend
  const legendColors = {};
  _employees.forEach((e,i) => {
    legendColors[e.id] = e.avatar_color || `hsl(${i*60},65%,55%)`;
  });

  const html = `
    <div class="view-header">
      <div><h1>Team Leave Calendar</h1><div class="view-sub">See who is on leave &amp; plan accordingly</div></div>
      <div class="view-header-actions">
        <button class="btn btn--secondary btn--sm" onclick="shiftCalMonth(-1)">&larr; Prev</button>
        <span style="font-weight:700;font-size:0.9rem;min-width:120px;text-align:center">${monthNames[month]} ${year}</span>
        <button class="btn btn--secondary btn--sm" onclick="shiftCalMonth(1)">Next &rarr;</button>
        <button class="btn btn--primary" onclick="navigate('leave',document.querySelector('[data-view=leave]'))">
          <i class="fa-solid fa-plus"></i> Request Leave
        </button>
      </div>
    </div>

    <!-- Legend -->
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
      <span style="font-size:0.72rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:0.05em">Team:</span>
      ${_employees.map(e=>`<div style="display:flex;align-items:center;gap:5px;font-size:0.75rem">
        <div style="width:10px;height:10px;border-radius:50%;background:${e.avatar_color||'#eda5ff'}"></div>
        ${e.first_name}
      </div>`).join('')}
      <span style="margin-left:8px;font-size:0.72rem;color:var(--muted)">|</span>
      <div style="display:flex;align-items:center;gap:5px;font-size:0.75rem">
        <span style="font-size:0.9rem">🎂</span> Birthday
      </div>
    </div>

    <!-- Calendar grid -->
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
      <!-- Day headers -->
      <div style="display:grid;grid-template-columns:repeat(7,1fr);background:var(--surface2)">
        ${dayNames.map(d=>`<div style="padding:10px;text-align:center;font-size:0.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">${d}</div>`).join('')}
      </div>

      <!-- Day cells -->
      <div style="display:grid;grid-template-columns:repeat(7,1fr)">
        ${cells.map(d=>{
          if (!d) return `<div style="min-height:80px;border:1px solid var(--border);opacity:0.2"></div>`;
          const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          const isToday = dateStr === today.toISOString().slice(0,10);
          const onLeave = leaveMap[dateStr] || [];
          const bdays   = bdMap[dateStr] || [];
          const isWeekend = new Date(dateStr).getDay()===0||new Date(dateStr).getDay()===6;
          return `<div style="min-height:80px;border:1px solid var(--border);padding:6px 8px;
              background:${isToday?'rgba(237,165,255,0.12)':isWeekend?'rgba(255,255,255,0.01)':'transparent'};
              position:relative">
            <div style="font-size:0.8rem;font-weight:${isToday?'800':'600'};color:${isToday?'var(--accent)':'var(--text)'}">
              ${d}
            </div>
            ${bdays.map(emp=>`<div style="font-size:0.65rem;background:rgba(249,200,70,0.15);border-radius:4px;padding:1px 4px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fec24f">
              🎂 ${emp.first_name}
            </div>`).join('')}
            ${onLeave.slice(0,3).map(({emp,leave})=>`
              <div title="${emp.first_name} ${emp.last_name} — ${leave.leave_type}" style="font-size:0.65rem;border-radius:4px;padding:1px 5px;margin-top:2px;
                   background:${emp.avatar_color||'#eda5ff'}25;color:${emp.avatar_color||'#eda5ff'};
                   white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                ${emp.avatar_initials||emp.first_name[0]}  ${emp.first_name}
              </div>`).join('')}
            ${onLeave.length>3?`<div style="font-size:0.6rem;color:var(--muted);margin-top:1px">+${onLeave.length-3} more</div>`:''}
          </div>`;
        }).join('')}
      </div>
    </div>

    <!-- Who is on leave this month -->
    <div class="section-head mt-3"><i class="fa-solid fa-calendar-xmark"></i> Leave This Month</div>
    ${leaveList.filter(l=>{
        const sm=l.start_date.slice(0,7); const em=l.end_date.slice(0,7);
        const ym=`${year}-${String(month+1).padStart(2,'0')}`;
        return sm===ym||em===ym||(sm<ym&&em>ym);
      }).length
      ? leaveList.filter(l=>{
          const sm=l.start_date.slice(0,7); const em=l.end_date.slice(0,7);
          const ym=`${year}-${String(month+1).padStart(2,'0')}`;
          return sm===ym||em===ym||(sm<ym&&em>ym);
        }).map(l=>{
          const emp=_employees.find(e=>e.id===l.employee_id)||{ first_name:l.first_name, last_name:l.last_name, avatar_color:l.avatar_color, avatar_initials:l.avatar_initials };
          const sc={approved:'chip-green',pending:'chip-gold',rejected:'chip-red'};
          return `<div class="kudos-card">
            <div class="kudos-avatar" style="background:${emp.avatar_color||'#eda5ff'}">${emp.avatar_initials||'?'}</div>
            <div class="kudos-body">
              <div class="kudos-top">
                <span class="kudos-from">${emp.first_name||''} ${emp.last_name||''}</span>
                <span class="kudos-kpi">${l.leave_type||'Leave'}</span>
                <span class="chip ${sc[l.status]||'chip-gray'}" style="margin-left:auto">${l.status}</span>
              </div>
              <div class="kudos-msg">${l.start_date.slice(0,10)} → ${l.end_date.slice(0,10)} &nbsp;·&nbsp; ${l.days_requested||'?'} days
                ${l.reason?` &nbsp;·&nbsp; "${l.reason}"`:''}
              </div>
            </div>
          </div>`;
        }).join('')
      : `<div class="empty-state" style="padding:24px"><i class="fa-solid fa-calendar-check"></i><p>No leave requests this month.</p></div>`
    }

    <!-- Upcoming Birthdays -->
    <div class="section-head mt-3"><i class="fa-solid fa-cake-candles text-gold"></i> Team Birthdays This Month</div>
    ${Object.entries(bdMap).length
      ? Object.entries(bdMap).map(([dateStr,emps])=>`
          <div class="kudos-card">
            <span style="font-size:1.8rem">🎂</span>
            <div class="kudos-body">
              <div class="kudos-top">
                ${emps.map(e=>`<span class="kudos-from">${e.first_name} ${e.last_name}</span>`).join(', ')}
                <span class="kudos-time">${new Date(dateStr+'T12:00:00').toLocaleDateString('en-ZA',{day:'numeric',month:'long'})}</span>
              </div>
              <div class="kudos-msg">Birthday celebration! Don't forget to wish them well 🎉</div>
            </div>
          </div>`)
        .join('')
      : `<div class="empty-state" style="padding:24px"><i class="fa-solid fa-cake-candles"></i><p>No birthdays this month.</p></div>`
    }`;

  container.innerHTML = html;
}

// Calendar navigation state
let _calYear  = new Date().getFullYear();
let _calMonth = new Date().getMonth();

function shiftCalMonth(dir) {
  _calMonth += dir;
  if (_calMonth > 11) { _calMonth = 0; _calYear++; }
  if (_calMonth < 0)  { _calMonth = 11; _calYear--; }
  const el = document.getElementById('view-calendar');
  get('tables/leave-calendar').then(res => {
    renderCalendarView(el, res.data || [], _calYear, _calMonth);
  });
}

/* ═══ UTILITIES ═════════════════════════════════════════════════════ */
function calcMyEVA() {
  const latest    = _evaPeriods.sort((a,b)=>b.period_month.localeCompare(a.period_month))[0]||{};
  const kpi       = _kpiScores.find(k=>k.period_month===latest.period_month)||_kpiScores[0]||{};
  // Revenue formula: 2.5% of AUM
  const aum       = Number(latest.total_aum)||0;
  const grossRev  = aum > 0 ? aum * EMP_AUM_RATE : (Number(latest.gross_revenue)||0);
  const opCosts   = Number(latest.operational_costs)||0;
  const evaPool   = Math.max(0, grossRev - opCosts);
  const teamPct   = (Number(latest.team_pool_pct)||50) / 100;
  const teamPool  = Number(latest.team_pool_amount) || (evaPool * teamPct);
  const empWeight = Number(_emp.eva_weight)||1;
  const allW      = _employees.filter(e=>e.status!=='inactive').reduce((s,e)=>s+(Number(e.eva_weight)||1),0)||1;
  const score     = Number(kpi.overall_score)||75;
  const indSplit  = Number(latest.individual_split_pct||60)/100;
  const colSplit  = 1-indSplit;
  const headcount = _employees.filter(e=>e.status!=='inactive').length||1;
  const total     = (teamPool*indSplit*(empWeight/allW)*(score/100)) + (teamPool*colSplit/headcount);
  return zarM(total);
}

function showLoader(show) {
  const el = document.getElementById('globalLoader');
  if (el) el.style.display = show?'flex':'none';
}

function showToast(msg, type='info') {
  const c = document.getElementById('toast-container');
  if(!c) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(()=>el.remove(),4000);
}

function showXpPopup(amount) {
  const el = document.createElement('div');
  el.className = 'xp-popup';
  el.textContent = `+${amount} XP`;
  el.style.left = Math.random()*200+100+'px';
  el.style.top  = '50%';
  document.body.appendChild(el);
  setTimeout(()=>el.remove(),1600);
}

function launchConfetti() {
  const cols=['#eda5ff','#00d4aa','#fec24f','#ff6b6b','#4fc3f7'];
  for(let i=0;i<60;i++) {
    const el=document.createElement('div');
    el.className='confetti-piece';
    el.style.cssText=`left:${Math.random()*100}vw;top:-10px;background:${cols[Math.floor(Math.random()*cols.length)]};--dur:${0.8+Math.random()*1.5}s;animation-delay:${Math.random()*0.5}s`;
    document.body.appendChild(el);
    setTimeout(()=>el.remove(),2500);
  }
}

function closeModal(id) { document.getElementById(id).classList.remove('open'); }

window.navigate = navigate;
window.openProfileEditModal = openProfileEditModal;
window.saveProfile = saveProfile;
window.handleBankingDocUpload = handleBankingDocUpload;
window.handleIdDocUpload = handleIdDocUpload;
window.downloadPayslip   = downloadPayslip;
window.openKudosForBirthday = openKudosForBirthday;
window.shiftCalMonth = shiftCalMonth;
window.openCourse = openCourse;
window.closeCourseReader = closeCourseReader;
window.jumpToModule = jumpToModule;
window.prevModule = prevModule;
window.startQuiz = startQuiz;
window.selectAnswer = selectAnswer;
window.submitQuiz = submitQuiz;
window.completeModuleNow = completeModuleNow;
window.openCertificateByProgress = openCertificateByProgress;
window.openAiGenModal = openAiGenModal;
window.closeAiGenModal = closeAiGenModal;
window.startAiGeneration = startAiGeneration;
window.openOkrModal = openOkrModal;
window.submitOkr = submitOkr;
window.openOkrProgress = openOkrProgress;
window.saveOkrProgress = saveOkrProgress;
window.completeOkr = completeOkr;
window.submitKudos = submitKudos;
window.openKudosModal = openKudosModal;
window.openFeedbackModal = openFeedbackModal;
window.submit360 = submit360;
window.switchFeedbackTab = switchFeedbackTab;
window.selectPulse = selectPulse;
window.submitPulse = submitPulse;
window.toggleAction = toggleAction;
window.addNotesToOneOnOne = addNotesToOneOnOne;
window.saveOneOnOneNotes = saveOneOnOneNotes;
window.openNewOneOnOneModal = openNewOneOnOneModal;
window.submitNewOneOnOne = submitNewOneOnOne;
window.completePath = completePath;
window.openLeaveModal = openLeaveModal;
window.submitLeave = submitLeave;
window.selectMood = selectMood;
window.submitCheckin = submitCheckin;
window.openNoteEditor = openNoteEditor;
window.closeNoteEditor = closeNoteEditor;
window.saveNote = saveNote;
window.deleteNote = deleteNote;
window.closeModal = closeModal;
window.toggleHelpPanel = toggleHelpPanel;

/* ═══════════════════════════════════════════════════════════════════════
   HELP & ONBOARDING SYSTEM
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Help content per view ──────────────────────────────────────────── */
const HELP_CONTENT = {
  dashboard: {
    title: 'Dashboard',
    icon: 'fa-house',
    intro: 'Your personal command centre. Everything important at a glance.',
    sections: [
      { heading: 'Profile Hero', icon: 'fa-user-circle', color: '#eda5ff',
        text: 'Shows your name, role, current XP level, and daily streak. The XP bar at the top tracks your progress to the next level. Click the avatar (bottom of sidebar) to jump to Achievements.' },
      { heading: 'Smart Notifications', icon: 'fa-bell', color: '#fec24f',
        text: 'Context-aware reminders appear here automatically — daily check-in reminder, active pulse surveys, upcoming 1-on-1s, and wellbeing alerts (3+ stressed check-ins triggers a burnout warning).' },
      { heading: 'Stats Cards', icon: 'fa-chart-bar', color: '#00d4aa',
        text: 'Quick KPI overview, your estimated EVA bonus share, courses completed this month, and streak count. These update in real time as you take actions.' },
      { heading: 'Recent Activity', icon: 'fa-bolt', color: '#fec24f',
        text: 'The last few things you\'ve done — course completions, kudos, check-ins, OKR milestones. Full history is in the Activity Feed view (⚡ in sidebar).' },
    ]
  },
  courses: {
    title: 'My Courses',
    icon: 'fa-book-open',
    intro: 'Your learning library. Complete courses to earn XP, boost KPI dimensions, and unlock certificates.',
    sections: [
      { heading: 'Course Cards', icon: 'fa-layer-group', color: '#eda5ff',
        text: 'Each card shows: title, category, difficulty, estimated time, XP reward, and which KPI dimension it boosts. Colour-coded by category (purple = AUM Growth, teal = Innovation, pink = Client Relations, etc.).' },
      { heading: 'Starting a Course', icon: 'fa-play', color: '#00d4aa',
        text: 'Click "Start Course" or "Continue" to open the Course Reader. Use the left panel to jump between modules. Complete the quiz at the end of each module to progress.' },
      { heading: 'Quizzes', icon: 'fa-question-circle', color: '#fec24f',
        text: 'Each module ends with a multiple-choice quiz. You need to score above the pass mark (usually 70%) to complete the module and earn XP. You can retry if you don\'t pass.' },
      { heading: 'Certificates', icon: 'fa-certificate', color: '#e84393',
        text: 'Completing a full course generates a certificate with your name, date, and a unique certificate ID. View all certificates in the Achievements view.' },
      { heading: 'AI Course Generator', icon: 'fa-robot', color: '#eda5ff',
        text: 'Click "Generate with AI" to create a personalised 3-module course on any topic. Enter a title, focus area, category and the KPI you want to boost. The system generates full lesson content and quizzes tailored to your role in seconds.' },
    ]
  },
  paths: {
    title: 'Learning Paths',
    icon: 'fa-road',
    intro: 'Structured course sequences designed for your role. Think of them as curated learning journeys.',
    sections: [
      { heading: 'Mandatory vs Optional', icon: 'fa-flag', color: '#e84393',
        text: 'Paths marked "Mandatory" must be completed. They often have a deadline and are tied to compliance or onboarding requirements. Optional paths earn bonus XP and badges.' },
      { heading: 'Path Progress', icon: 'fa-stairs', color: '#00d4aa',
        text: 'Courses in a path unlock sequentially. Complete course 1 to unlock course 2. A progress bar shows your overall path completion percentage.' },
      { heading: 'Path Rewards', icon: 'fa-trophy', color: '#fec24f',
        text: 'Completing a full learning path awards bonus XP on top of the individual course XP, plus a special path completion badge.' },
    ]
  },
  kpis: {
    title: 'My KPIs',
    icon: 'fa-chart-bar',
    intro: 'Your 8 performance dimensions tracked monthly. KPIs directly determine your individual EVA bonus share.',
    sections: [
      { heading: '8 KPI Dimensions', icon: 'fa-sliders', color: '#eda5ff',
        text: 'Revenue Contribution, Client Satisfaction, Task Completion, Response Time, Compliance Score, Innovation Score, Team Collaboration, and Attendance. Each scored 0–100.' },
      { heading: 'How Scores are Set', icon: 'fa-pen', color: '#fec24f',
        text: 'Your manager scores you monthly in the Team Dashboard. You can boost your own scores by: completing courses (auto-boost), completing OKRs (+10 pts), giving kudos, and maintaining daily check-in streaks (attendance).' },
      { heading: 'Trend Chart', icon: 'fa-chart-line', color: '#00d4aa',
        text: 'The line chart shows your score trends across the last 6 months. The radar chart compares your profile shape against the ideal 100% benchmark.' },
      { heading: 'KPI & EVA Link', icon: 'fa-link', color: '#e84393',
        text: 'Your overall score × your EVA weight determines your individual pool share. A 10-point KPI improvement can meaningfully increase your bonus. The improvement table at the bottom shows exactly how much.' },
    ]
  },
  okrs: {
    title: 'My OKRs',
    icon: 'fa-bullseye',
    intro: 'Objectives and Key Results. Set your goals, track progress, and earn XP + KPI boosts on completion.',
    sections: [
      { heading: 'What is an OKR?', icon: 'fa-info-circle', color: '#eda5ff',
        text: 'An Objective is a qualitative goal ("I want to improve client satisfaction"). Key Results are measurable milestones that prove you\'ve hit it (3 per objective). When all 3 KRs reach 100%, the OKR is complete.' },
      { heading: 'Creating an OKR', icon: 'fa-plus', color: '#00d4aa',
        text: 'Click "+ New OKR". Set your objective, add 3 key results with targets, and link it to a KPI dimension. Each OKR completion auto-boosts that KPI by +10 points and awards +100 XP.' },
      { heading: 'Updating Progress', icon: 'fa-arrows-alt', color: '#fec24f',
        text: 'Click any OKR card to update key result progress with sliders. The overall % auto-calculates. Your manager can also add notes.' },
    ]
  },
  feedback: {
    title: 'Feedback & Kudos',
    icon: 'fa-hands-clapping',
    intro: 'Recognise great work, request 360° feedback, and build a culture of appreciation.',
    sections: [
      { heading: 'Giving Kudos', icon: 'fa-heart', color: '#e84393',
        text: 'Select a colleague, choose a KPI dimension their work exemplifies, write a message, and send. You earn +25 XP for every kudos you give. Kudos are visible on the team wall (if marked public).' },
      { heading: '360° Feedback', icon: 'fa-circle-nodes', color: '#eda5ff',
        text: 'Request structured feedback from peers across multiple KPI dimensions, with a 1–5 rating and comments. This helps build a more accurate picture of your performance.' },
      { heading: 'Received / Given / Team Wall Tabs', icon: 'fa-tab', color: '#00d4aa',
        text: 'Switch between feedback you\'ve received, feedback you\'ve given, and the public team kudos wall where everyone\'s recognition is visible.' },
    ]
  },
  pulse: {
    title: 'Pulse Survey',
    icon: 'fa-poll',
    intro: 'A quick weekly survey to measure team health, engagement, and satisfaction.',
    sections: [
      { heading: 'The Survey', icon: 'fa-clipboard-list', color: '#eda5ff',
        text: 'Each week contains 3 short questions plus an eNPS (Employee Net Promoter Score) question. Surveys take 2–3 minutes. Complete it to earn +20 XP.' },
      { heading: 'eNPS', icon: 'fa-chart-bar', color: '#00d4aa',
        text: 'On a scale of 0–10, how likely are you to recommend SV Capital as a great place to work? This is the Employee Net Promoter Score — a global standard metric for employee engagement.' },
      { heading: 'Previous Responses', icon: 'fa-history', color: '#fec24f',
        text: 'View your past survey responses below the current survey. Your answers help leadership understand team morale trends over time.' },
    ]
  },
  oneonone: {
    title: '1-on-1s',
    icon: 'fa-comments',
    intro: 'Structured one-on-one meetings with your manager. Track agendas, action items, and notes.',
    sections: [
      { heading: 'Upcoming & Past Meetings', icon: 'fa-calendar', color: '#eda5ff',
        text: 'Upcoming meetings show the date, agenda, and any topics you\'ve submitted. Past meetings show outcomes, manager notes, and action items.' },
      { heading: 'Action Items', icon: 'fa-check-square', color: '#00d4aa',
        text: 'Action items from 1-on-1s appear here. Tick them off when done — each completed action earns +10 XP. Your manager tracks completion rates.' },
      { heading: 'Adding Pre-Meeting Notes', icon: 'fa-pen', color: '#fec24f',
        text: 'Before a meeting, click "Add Notes" to submit talking points, questions, or updates you want to cover. Your manager can see these in advance.' },
      { heading: 'Requesting a Meeting', icon: 'fa-plus', color: '#e84393',
        text: 'Click "Request 1-on-1" to propose a new meeting. Add an agenda and any topics. Your manager will confirm the time.' },
    ]
  },
  checkin: {
    title: 'Daily Check-in',
    icon: 'fa-sun',
    intro: 'A 30-second daily ritual that builds your streak, earns XP, and helps the business track team wellbeing.',
    sections: [
      { heading: 'Mood Selector', icon: 'fa-face-smile', color: '#fec24f',
        text: 'Choose from 5 moods: Energised 🔥, Happy 😊, Neutral 😐, Stressed 😰, or Exhausted 😴. Be honest — your responses are anonymised in aggregate reporting. Streak and XP are awarded regardless of mood.' },
      { heading: 'Tasks', icon: 'fa-list-check', color: '#00d4aa',
        text: 'Enter how many tasks you planned for the day and how many you completed yesterday. This feeds your task completion KPI over time.' },
      { heading: 'Streak System', icon: 'fa-fire', color: '#e84393',
        text: 'Check in every day to build a streak. At 7-day milestones you earn +50 bonus XP. Miss a day and the streak resets to 0. Streaks also boost your Attendance KPI score.' },
      { heading: 'Burnout Detection', icon: 'fa-triangle-exclamation', color: '#ef4444',
        text: 'If you log "Stressed" or "Exhausted" 3 or more days in a row, a wellbeing alert appears on your dashboard and a notification is triggered for your manager. This is designed to help, not penalise.' },
    ]
  },
  leave: {
    title: 'My Leave',
    icon: 'fa-calendar-days',
    intro: 'Submit, track and manage your leave requests.',
    sections: [
      { heading: 'Leave Types', icon: 'fa-tags', color: '#eda5ff',
        text: 'Annual Leave, Sick Leave, Study Leave, Family Responsibility Leave, and Unpaid Leave. Each type has different balances and EVA implications.' },
      { heading: 'EVA Impact', icon: 'fa-chart-line', color: '#e84393',
        text: 'Extended leave can reduce your EVA bonus share for that period. The "EVA Impact %" shown on each request indicates the reduction. This resets next period.' },
      { heading: 'Approval Process', icon: 'fa-check-double', color: '#00d4aa',
        text: 'Once submitted, your manager reviews your request in the Team Dashboard. Status changes from "pending" → "approved" or "rejected". You\'ll see the updated status here.' },
      { heading: 'Leave Calendar', icon: 'fa-calendar-week', color: '#fec24f',
        text: 'See the full team leave calendar in the 📅 calendar view (sidebar). Plan leave to avoid clashing with critical team coverage periods.' },
    ]
  },
  achievements: {
    title: 'Achievements',
    icon: 'fa-trophy',
    intro: 'Your badge collection, certificates, and XP milestones.',
    sections: [
      { heading: 'Earning Badges', icon: 'fa-medal', color: '#fec24f',
        text: 'Badges are awarded automatically for milestones: completing 5 courses, 7-day streak, giving 10 kudos, 100% OKR completion, and more. Each badge awards bonus XP.' },
      { heading: 'Certificates', icon: 'fa-certificate', color: '#eda5ff',
        text: 'Every completed course generates a certificate. Click any certificate to open the printable PDF-ready certificate overlay with your name, date, and unique ID.' },
      { heading: 'XP & Levels', icon: 'fa-star', color: '#00d4aa',
        text: 'Analyst (0) → Associate (500) → Senior (1,200) → Lead (2,500) → Director (4,500) → MVP (7,000). Your level is displayed on your profile and the leaderboard.' },
    ]
  },
  feed: {
    title: 'Activity Feed',
    icon: 'fa-bolt',
    intro: 'A chronological record of all your XP events, milestones, and notable actions.',
    sections: [
      { heading: 'What Appears Here', icon: 'fa-list', color: '#eda5ff',
        text: 'Course completions, badges earned, kudos given and received, OKR milestones, level-ups, streak milestones, and onboarding steps. All timestamped.' },
      { heading: 'Public vs Private', icon: 'fa-eye', color: '#00d4aa',
        text: 'Some events are public (visible to the whole team on the team dashboard) — like level-ups and badges. Others are private — like personal notes and journal entries.' },
    ]
  },
  journal: {
    title: 'Journal',
    icon: 'fa-pen-to-square',
    intro: 'Your completely private digital journal. Reflect, plan, and write freely.',
    sections: [
      { heading: 'Privacy', icon: 'fa-lock', color: '#eda5ff',
        text: '100% private. No manager, director, or admin can see your journal entries. This is your personal space.' },
      { heading: 'Creating Notes', icon: 'fa-plus', color: '#00d4aa',
        text: 'Click "New Note" to open the editor. Add a title, write your content, and choose whether to pin it. Pinned notes appear at the top of your journal.' },
      { heading: 'Editing & Deleting', icon: 'fa-pen', color: '#fec24f',
        text: 'Click any note to edit it. Use the delete button to remove it permanently. Edits are saved with a timestamp.' },
    ]
  },
  eva: {
    title: 'EVA Statement',
    icon: 'fa-money-bill-trend-up',
    intro: 'Your transparent payslip-style breakdown of how your EVA bonus is calculated.',
    sections: [
      { heading: 'The Formula', icon: 'fa-calculator', color: '#eda5ff',
        text: 'Gross Revenue = Total AUM × 2.5%. EVA Pool = Revenue − Costs. Team Pool = EVA Pool × 50%. Your share = (KPI Score × EVA Weight) / All Weights × Individual Pool + Collective Pool / Headcount.' },
      { heading: 'Individual vs Collective', icon: 'fa-users', color: '#00d4aa',
        text: '60% of the Team Pool is split based on KPI performance (weighted). The other 40% is split equally among all active employees — the "collective" share. You earn both.' },
      { heading: 'EVA Weight', icon: 'fa-weight-scale', color: '#fec24f',
        text: 'Your EVA weight (0.5–2.0) is set by your role. A weight of 1.8 (Investment Analyst) means you get 1.8× more individual pool allocation than someone with weight 1.0.' },
      { heading: 'Improving Your Share', icon: 'fa-trending-up', color: '#e84393',
        text: 'Boost your KPI scores by completing courses, hitting OKRs, maintaining streaks, and giving kudos. The improvement table at the bottom shows the exact ZAR impact of a 10-point KPI increase.' },
    ]
  },
  profile: {
    title: 'My Profile',
    icon: 'fa-id-card',
    intro: 'Your personal and banking details. Keep everything up to date for accurate EVA payments.',
    sections: [
      { heading: 'Personal Details', icon: 'fa-user', color: '#eda5ff',
        text: 'Your name, email, phone, date of birth, and SA ID number. The ID number determines your login PIN (last 4 digits). Keep this accurate.' },
      { heading: 'Banking Details', icon: 'fa-building-columns', color: '#00d4aa',
        text: 'Your bank account details for EVA bonus payments. Account number is masked for security (•••••1234). Click Edit to update. Upload proof of banking using the upload button.' },
      { heading: 'Emergency Contact', icon: 'fa-phone-volume', color: '#e84393',
        text: 'Add an emergency contact name and phone number. This is only accessed by HR in genuine emergencies.' },
      { heading: 'Sensitive Field Masking', icon: 'fa-eye-slash', color: '#fec24f',
        text: 'SA ID number and bank account number are masked in the display for your protection. Only you can see and edit them.' },
    ]
  },
  calendar: {
    title: 'Leave Calendar',
    icon: 'fa-calendar-days',
    intro: 'Full team leave visibility. See who is off when and plan accordingly.',
    sections: [
      { heading: 'The Monthly Grid', icon: 'fa-calendar', color: '#eda5ff',
        text: 'A full month grid showing all approved leave. Each employee has a unique colour. Leave blocks span the correct days. Use the arrows to navigate months.' },
      { heading: 'Birthday Overlays', icon: 'fa-birthday-cake', color: '#fec24f',
        text: 'A 🎂 chip appears on each team member\'s birthday. The "Birthdays This Month" section below the grid lists everyone celebrating this month.' },
      { heading: 'Who\'s On Leave', icon: 'fa-user-clock', color: '#e84393',
        text: 'The "On Leave Today" section at the bottom shows everyone currently on leave with their leave type and return date.' },
      { heading: 'Requesting Leave', icon: 'fa-plus', color: '#00d4aa',
        text: 'Click "Request Leave" in the top-right to jump to the My Leave view where you can submit a new request.' },
    ]
  },
};

/* ── Help Panel State & Toggle ──────────────────────────────────────── */
let _helpPanelOpen = false;

function toggleHelpPanel() {
  _helpPanelOpen = !_helpPanelOpen;
  const panel   = document.getElementById('helpPanel');
  const overlay = document.getElementById('helpOverlay');
  const btn     = document.getElementById('helpBtn');
  if (_helpPanelOpen) {
    panel.style.right   = '0';
    overlay.style.display = 'block';
    if (btn) btn.style.transform = 'scale(0.9)';
    renderHelpContent(_currentView);
  } else {
    panel.style.right   = '-420px';
    overlay.style.display = 'none';
    if (btn) btn.style.transform = '';
  }
}

function renderHelpContent(view) {
  const content = HELP_CONTENT[view] || HELP_CONTENT.dashboard;
  const contextLabel = document.getElementById('help-context-label');
  if (contextLabel) contextLabel.textContent = 'Viewing: ' + (content.title || view);

  const body = document.getElementById('helpPanelBody');
  if (!body) return;

  body.innerHTML = `
    <!-- View intro -->
    <div style="background:rgba(237,165,255,0.08);border:1px solid rgba(237,165,255,0.15);border-radius:12px;padding:14px 16px;margin-bottom:20px;display:flex;gap:12px;align-items:flex-start">
      <i class="fa-solid ${content.icon}" style="color:#eda5ff;font-size:1rem;margin-top:2px;flex-shrink:0"></i>
      <div>
        <div style="font-size:0.88rem;font-weight:800;color:#e8eaf6;margin-bottom:4px">${content.title}</div>
        <div style="font-size:0.78rem;color:#9ca3af;line-height:1.6">${content.intro}</div>
      </div>
    </div>

    <!-- Sections -->
    ${content.sections.map(s => `
      <div style="margin-bottom:18px;padding-bottom:18px;border-bottom:1px solid rgba(255,255,255,0.06)">
        <div style="display:flex;align-items:center;gap:9px;margin-bottom:8px">
          <div style="width:28px;height:28px;border-radius:7px;background:${s.color}20;color:${s.color};display:flex;align-items:center;justify-content:center;font-size:0.75rem;flex-shrink:0"><i class="fa-solid ${s.icon}"></i></div>
          <div style="font-size:0.82rem;font-weight:700;color:#e8eaf6">${s.heading}</div>
        </div>
        <div style="font-size:0.78rem;color:#9ca3af;line-height:1.7;padding-left:37px">${s.text}</div>
      </div>
    `).join('')}

    <!-- Quick nav -->
    <div style="background:var(--surface2,#1a1c24);border-radius:10px;padding:14px;margin-top:8px">
      <div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6b7280;margin-bottom:10px">Jump to view</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${Object.entries(HELP_CONTENT).map(([key, hc]) => `
          <button onclick="navigate('${key}',document.querySelector('[data-view=${key}]'));toggleHelpPanel();" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:4px 10px;font-size:0.72rem;font-weight:600;color:#9ca3af;cursor:pointer;font-family:inherit;transition:all 0.15s" onmouseover="this.style.background='rgba(237,165,255,0.12)';this.style.color='#eda5ff'" onmouseout="this.style.background='rgba(255,255,255,0.05)';this.style.color='#9ca3af'">
            <i class="fa-solid ${hc.icon}" style="margin-right:4px;font-size:0.68rem"></i>${hc.title}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

/* ── Auto-update help when navigating ──────────────────────────────── */
const _origNavigate = window.navigate;
window.navigate = function(view, btn) {
  _origNavigate(view, btn);
  if (_helpPanelOpen) renderHelpContent(view);
};

/* ── Onboarding Banner ──────────────────────────────────────────────── */
async function checkOnboardingBanner() {
  if (!_emp) return;
  const ob = await fetchAll('employee_onboarding').then(list => list.find(o => o.employee_id === _emp.id));
  if (!ob || ob.status === 'completed') return;

  const banner = document.getElementById('onboarding-banner');
  const msgEl  = document.getElementById('ob-welcome-msg');
  const chipsEl= document.getElementById('ob-task-chips');
  const pctEl  = document.getElementById('ob-progress-text');
  if (!banner) return;

  const pct = ob.tasks_total > 0 ? Math.round((ob.tasks_completed||0) / ob.tasks_total * 100) : 0;
  const tasksLeft = (ob.tasks_total||0) - (ob.tasks_completed||0);

  if (msgEl) msgEl.textContent = ob.welcome_message || 'Complete your onboarding steps to get fully set up.';
  if (pctEl) pctEl.textContent = pct + '%';

  // Show next 3 incomplete tasks as chips
  const defaultTasks = [
    { title:'Complete Profile',       view:'profile',   icon:'fa-id-card' },
    { title:'Banking Details',        view:'profile',   icon:'fa-building-columns' },
    { title:'SV Capital Orientation', view:'courses',   icon:'fa-gem' },
    { title:'Platform Walkthrough',   view:'courses',   icon:'fa-laptop-code' },
    { title:'Compliance Course',      view:'courses',   icon:'fa-shield-halved' },
    { title:'First Check-in',         view:'checkin',   icon:'fa-sun' },
    { title:'Set First OKR',          view:'okrs',      icon:'fa-bullseye' },
    { title:'Give Kudos',             view:'feedback',  icon:'fa-hands-clapping' },
  ];

  if (chipsEl) {
    const incomplete = defaultTasks.slice(ob.tasks_completed||0, (ob.tasks_completed||0) + 3);
    chipsEl.innerHTML = incomplete.map(t => `
      <button onclick="navigate('${t.view}',document.querySelector('[data-view=${t.view}]'))" style="display:inline-flex;align-items:center;gap:6px;background:rgba(254,194,79,0.1);border:1px solid rgba(254,194,79,0.25);border-radius:20px;padding:4px 12px;font-size:0.72rem;font-weight:600;color:#fec24f;cursor:pointer;font-family:inherit;transition:background 0.15s">
        <i class="fa-solid ${t.icon}" style="font-size:0.68rem"></i> ${t.title}
      </button>
    `).join('') + `<span style="font-size:0.72rem;color:#6b7280;align-self:center">${tasksLeft} tasks remaining</span>`;
  }

  // Push content down to make room for banner
  banner.style.display = 'block';
  const empLayout = document.querySelector('.emp-layout');
  if (empLayout) empLayout.style.paddingTop = '100px';
}

document.addEventListener('DOMContentLoaded', init);
document.addEventListener('DOMContentLoaded', () => {
  // Run onboarding check after main init
  setTimeout(checkOnboardingBanner, 1500);
});

/* ═══════════════════════════════════════════════════════════════════════
   ONBOARDING TASK PERSISTENCE ENGINE
   Evaluates real employee data to determine which onboarding tasks are
   complete, PATCHes the employee_onboarding record, and handles the
   completion ceremony when all required tasks are done.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Task completion evaluator ──────────────────────────────────────── */
function evaluateOnboardingTasks() {
  if (!_emp) return { completed: [], total: 10, count: 0 };

  // Course completions
  const completedCourseIds = _progress
    .filter(p => p.status === 'completed')
    .map(p => p.course_id);

  // Determine per-task completion
  const tasks = [
    // 1 complete_profile: phone + DOB + ID number + emergency contact all set
    { key:'complete_profile',   done: !!((_emp.phone||'').trim() && (_emp.birth_date||'').trim() && (_emp.id_number||'').trim() && (_emp.emergency_contact_name||'').trim()) },
    // 2 add_banking: bank name + account number set
    { key:'add_banking',        done: !!((_emp.bank_name||'').trim() && (_emp.bank_account_number||'').trim()) },
    // 3 SV Capital Orientation course
    { key:'course_orientation', done: completedCourseIds.includes('CRS-OB-001') },
    // 4 Platform Walkthrough course
    { key:'course_platform',    done: completedCourseIds.includes('CRS-OB-002') },
    // 5 Compliance course
    { key:'course_compliance',  done: completedCourseIds.includes('CRS-OB-003') },
    // 6 first check-in: at least one checkin exists
    { key:'first_checkin',      done: _checkins.length > 0 },
    // 7 first OKR: at least one OKR created
    { key:'set_first_okr',      done: _okrs.length > 0 },
    // 8 first kudos: at least one outgoing kudos
    { key:'give_first_kudos',   done: _peerFeedback.filter(f => f.from_employee_id === _emp.id && f.type === 'kudos').length > 0 },
    // 9 view EVA statement: tracked in localStorage
    { key:'view_eva_statement', done: localStorage.getItem(`ob_eva_viewed_${_emp.id}`) === '1' },
    // 10 proof of banking uploaded
    { key:'upload_proof_banking', done: !!((_emp.proof_of_banking_url||'').trim()) },
  ];

  const completed = tasks.filter(t => t.done).map(t => t.key);
  return { completed, total: tasks.length, count: completed.length, tasks };
}

/* ── Required task keys (must all be done for completion) ──────────── */
const REQUIRED_TASK_KEYS = [
  'complete_profile', 'add_banking', 'course_orientation',
  'course_platform',  'course_compliance', 'first_checkin', 'upload_proof_banking'
];

/* ── Main sync function — call after any onboarding-relevant action ─ */
let _obRecord = null; // cached onboarding record for current employee
let _obSyncing = false;

async function syncOnboardingProgress() {
  if (!_emp || _obSyncing) return;
  _obSyncing = true;
  try {
    // Fetch or use cached onboarding record
    if (!_obRecord) {
      const all = await fetchAll('employee_onboarding');
      _obRecord = all.find(o => o.employee_id === _emp.id) || null;
    }
    if (!_obRecord || _obRecord.status === 'completed') return;

    const { count, completed, total, tasks } = evaluateOnboardingTasks();
    const wasCount = Number(_obRecord.tasks_completed) || 0;

    // Check if all REQUIRED tasks are done
    const allRequiredDone = REQUIRED_TASK_KEYS.every(k => completed.includes(k));
    const isNowComplete   = allRequiredDone;

    if (count === wasCount && !isNowComplete) return; // nothing changed

    const updates = { tasks_completed: count };
    if (isNowComplete) {
      updates.status       = 'completed';
      updates.completed_at = new Date().toISOString();
    }

    const updated = await patch(`tables/employee_onboarding/${_obRecord.id}`, updates);
    Object.assign(_obRecord, updated);

    // Refresh banner
    if (isNowComplete) {
      await handleOnboardingCompletion();
    } else {
      // Refresh progress display on banner
      refreshOnboardingBanner(count, total, completed, tasks);
    }

    // Notify director if just completed
    if (isNowComplete && _obRecord.created_by) {
      await notifyDirectorOnboardingComplete();
    }

  } finally {
    _obSyncing = false;
  }
}

/* ── Refresh banner without full re-fetch ──────────────────────────── */
function refreshOnboardingBanner(count, total, completed, tasks) {
  const pctEl  = document.getElementById('ob-progress-text');
  const chipsEl= document.getElementById('ob-task-chips');
  const banner  = document.getElementById('onboarding-banner');
  if (!banner || banner.style.display === 'none') return;

  const pct = total > 0 ? Math.round(count / total * 100) : 0;
  if (pctEl) pctEl.textContent = pct + '%';

  const allTasks = [
    { key:'complete_profile',    title:'Complete Profile',       view:'profile',   icon:'fa-id-card' },
    { key:'add_banking',         title:'Banking Details',        view:'profile',   icon:'fa-building-columns' },
    { key:'course_orientation',  title:'SV Capital Orientation', view:'courses',   icon:'fa-gem' },
    { key:'course_platform',     title:'Platform Walkthrough',   view:'courses',   icon:'fa-laptop-code' },
    { key:'course_compliance',   title:'Compliance Course',      view:'courses',   icon:'fa-shield-halved' },
    { key:'first_checkin',       title:'First Check-in',         view:'checkin',   icon:'fa-sun' },
    { key:'set_first_okr',       title:'Set First OKR',          view:'okrs',      icon:'fa-bullseye' },
    { key:'give_first_kudos',    title:'Give Kudos',             view:'feedback',  icon:'fa-hands-clapping' },
    { key:'view_eva_statement',  title:'View EVA Statement',     view:'eva',       icon:'fa-money-bill-trend-up' },
    { key:'upload_proof_banking',title:'Upload Proof of Banking',view:'profile',   icon:'fa-file-invoice' },
  ];

  const incomplete = allTasks.filter(t => !completed.includes(t.key)).slice(0, 3);
  const tasksLeft  = total - count;

  if (chipsEl) {
    chipsEl.innerHTML = incomplete.map(t => `
      <button onclick="navigate('${t.view}',document.querySelector('[data-view=${t.view}]'))" style="display:inline-flex;align-items:center;gap:6px;background:rgba(254,194,79,0.1);border:1px solid rgba(254,194,79,0.25);border-radius:20px;padding:4px 12px;font-size:0.72rem;font-weight:600;color:#fec24f;cursor:pointer;font-family:inherit;transition:background 0.15s">
        <i class="fa-solid ${t.icon}" style="font-size:0.68rem"></i> ${t.title}
      </button>
    `).join('') + `<span style="font-size:0.72rem;color:#6b7280;align-self:center">${tasksLeft} task${tasksLeft!==1?'s':''} remaining</span>`;
  }
}

/* ── Onboarding completion ceremony ────────────────────────────────── */
async function handleOnboardingCompletion() {
  const banner = document.getElementById('onboarding-banner');

  // Award bonus XP for completing onboarding
  await awardXP(150, 'Onboarding journey completed');
  launchConfetti();

  // Log to activity feed
  await post('tables/activity_feed', {
    employee_id: _emp.id,
    type:        'onboarding_completed',
    title:       '🎉 Onboarding journey complete!',
    body:        'You have completed all required onboarding tasks. Welcome to the team!',
    icon:        'fa-rocket',
    color:       '#fec24f',
    xp_shown:    150,
    is_public:   true,
    created_at:  new Date().toISOString(),
  });

  // Replace banner with congratulations state
  if (banner) {
    banner.style.background = 'linear-gradient(135deg,#0a1f0a,#0b0c10)';
    banner.style.borderBottomColor = 'rgba(0,212,170,0.5)';
    banner.innerHTML = `
      <div style="max-width:900px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:16px">
        <div style="width:44px;height:44px;border-radius:12px;background:rgba(0,212,170,0.15);border:1px solid rgba(0,212,170,0.4);display:flex;align-items:center;justify-content:center;font-size:1.3rem;flex-shrink:0">🎉</div>
        <div style="flex:1">
          <div style="font-size:0.9rem;font-weight:800;color:#00d4aa;margin-bottom:2px">Onboarding complete! Welcome to SV Capital! 🚀</div>
          <div style="font-size:0.78rem;color:#9ca3af;line-height:1.4">You've completed all required onboarding steps and earned <strong style="color:#fec24f">+150 bonus XP</strong>. You're officially ready to go — the team is excited to have you!</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
          <span style="font-size:1.6rem;font-weight:900;color:#00d4aa">100%</span>
          <button class="btn btn--ghost btn--sm" onclick="document.getElementById('onboarding-banner').style.display='none';document.querySelector('.emp-layout').style.paddingTop=''" style="font-size:0.7rem;padding:4px 10px">Dismiss</button>
        </div>
      </div>
    `;
    banner.style.display = 'block';
    // Auto-dismiss after 12 seconds
    setTimeout(() => {
      banner.style.display = 'none';
      const empLayout = document.querySelector('.emp-layout');
      if (empLayout) empLayout.style.paddingTop = '';
    }, 12000);
  }

  showToast('🎉 Onboarding complete! +150 bonus XP awarded. Welcome to the team!', 'success');
}

/* ── Director notification on completion ───────────────────────────── */
async function notifyDirectorOnboardingComplete() {
  if (!_obRecord || !_obRecord.created_by) return;
  try {
    await post('tables/activity_feed', {
      employee_id: _obRecord.created_by,
      type:        'onboarding_completed_notification',
      title:       `✅ ${_emp.first_name} ${_emp.last_name} completed onboarding!`,
      body:        `${_emp.first_name} ${_emp.last_name} (${_emp.role || 'Employee'}) has completed all required onboarding tasks and is fully set up on the platform.`,
      icon:        'fa-user-check',
      color:       '#00d4aa',
      xp_shown:    0,
      is_public:   false,
      created_at:  new Date().toISOString(),
    });
  } catch(e) { /* non-critical — don't block */ }
}

/* ── Hook into triggering actions ───────────────────────────────────── */

// Wrap saveProfile to sync after
const _origSaveProfile = saveProfile;
saveProfile = async function() {
  await _origSaveProfile.apply(this, arguments);
  setTimeout(syncOnboardingProgress, 500);
};

// Wrap submitCheckin to sync after
const _origSubmitCheckin = submitCheckin;
submitCheckin = async function() {
  await _origSubmitCheckin.apply(this, arguments);
  setTimeout(syncOnboardingProgress, 500);
};

// Wrap submitOkr to sync after
const _origSubmitOkr = submitOkr;
submitOkr = async function() {
  await _origSubmitOkr.apply(this, arguments);
  setTimeout(syncOnboardingProgress, 500);
};

// Wrap submitKudos to sync after
const _origSubmitKudos = submitKudos;
submitKudos = async function() {
  await _origSubmitKudos.apply(this, arguments);
  setTimeout(syncOnboardingProgress, 500);
};

// Wrap completeModule to sync after course completion
const _origCompleteModule = completeModule;
completeModule = async function() {
  await _origCompleteModule.apply(this, arguments);
  setTimeout(syncOnboardingProgress, 800);
};

// Wrap handleBankingDocUpload to sync after upload
const _origHandleBankingDocUpload = handleBankingDocUpload;
handleBankingDocUpload = function() {
  _origHandleBankingDocUpload.apply(this, arguments);
  setTimeout(syncOnboardingProgress, 1000);
};

// Track EVA statement view — called when navigate fires for 'eva' view
const _origNavigateForOb = window.navigate;
window.navigate = function(view, btn) {
  _origNavigateForOb(view, btn);
  if (view === 'eva' && _emp) {
    if (localStorage.getItem(`ob_eva_viewed_${_emp.id}`) !== '1') {
      localStorage.setItem(`ob_eva_viewed_${_emp.id}`, '1');
      setTimeout(syncOnboardingProgress, 500);
    }
  }
};

// Export syncOnboardingProgress for use from window scope
window.syncOnboardingProgress = syncOnboardingProgress;

/* ═══════════════════════════════════════════════════════════════
   VIEW: MY PAYSLIPS
   ═══════════════════════════════════════════════════════════════ */

function renderPayslips() {
  const el = document.getElementById('view-payslips');
  if (!el) return;

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  const ytdYear   = new Date().getFullYear();
  const ytdSlips  = _payslips.filter(p => p.pay_period && p.pay_period.startsWith(String(ytdYear)));
  const ytdGross  = ytdSlips.reduce((s, p) => s + (Number(p.gross_pay) || 0), 0);
  const ytdNett   = ytdSlips.reduce((s, p) => s + (Number(p.nett_pay)  || 0), 0);
  const ytdEva    = ytdSlips.reduce((s, p) => s + (Number(p.eva_bonus) || 0), 0);
  const latest    = _payslips[0] || null;
  const latestNett = latest ? Number(latest.nett_pay) || 0 : 0;

  el.innerHTML = `
    <div class="view-header">
      <div><h1>My Payslips</h1><div class="view-sub">Full pay history, YTD summary & individual downloads</div></div>
      <div class="view-header-actions">
        <button class="btn btn--secondary" onclick="exportPayslipsCSV()"><i class="fa-solid fa-table"></i> Export CSV</button>
        <button class="btn btn--primary" onclick="exportPayslipsPDF()"><i class="fa-solid fa-file-pdf"></i> Full History PDF</button>
      </div>
    </div>

    <!-- YTD KPI tiles -->
    <div class="cards-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:24px">
      <div class="stat-card">
        <div class="stat-card-icon" style="background:rgba(237,165,255,0.15);color:var(--accent)"><i class="fa-solid fa-coins"></i></div>
        <div class="stat-card-val">R ${ytdGross.toLocaleString('en-ZA',{maximumFractionDigits:0})}</div>
        <div class="stat-card-lbl">Gross Pay YTD ${ytdYear}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-icon" style="background:rgba(0,212,170,0.15);color:var(--accent2)"><i class="fa-solid fa-hand-holding-dollar"></i></div>
        <div class="stat-card-val">R ${ytdNett.toLocaleString('en-ZA',{maximumFractionDigits:0})}</div>
        <div class="stat-card-lbl">Nett Pay YTD ${ytdYear}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-icon" style="background:rgba(249,200,70,0.15);color:var(--gold)"><i class="fa-solid fa-bolt"></i></div>
        <div class="stat-card-val">R ${ytdEva.toLocaleString('en-ZA',{maximumFractionDigits:0})}</div>
        <div class="stat-card-lbl">EVA Bonuses YTD</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-icon" style="background:rgba(255,91,91,0.12);color:#ff5b5b"><i class="fa-solid fa-file-invoice-dollar"></i></div>
        <div class="stat-card-val">R ${latestNett.toLocaleString('en-ZA',{maximumFractionDigits:0})}</div>
        <div class="stat-card-lbl">Last Month Nett</div>
      </div>
    </div>

    ${_payslips.length === 0
      ? `<div class="chart-container" style="text-align:center;padding:48px;color:var(--muted)">
           <i class="fa-solid fa-file-invoice-dollar" style="font-size:2.5rem;margin-bottom:14px;display:block;opacity:0.25"></i>
           <div style="font-size:0.9rem;font-weight:600;margin-bottom:6px">No payslips on record yet</div>
           <div style="font-size:0.78rem">Payslips are generated at the end of each pay period by the finance team.</div>
         </div>`
      : `<div class="chart-container" style="padding:0;overflow-x:auto">
           <table class="data-table" style="min-width:600px">
             <thead>
               <tr>
                 <th>Pay Period</th>
                 <th>Base Salary</th>
                 <th>EVA Bonus</th>
                 <th>Gross Pay</th>
                 <th>Deductions</th>
                 <th>Nett Pay</th>
                 <th>Status</th>
                 <th></th>
               </tr>
             </thead>
             <tbody id="payslipsTableBody">
               ${_payslips.map((p, i) => {
                 const [yr, mo] = (p.pay_period || '—').split('-');
                 const moLabel = MONTHS[(parseInt(mo, 10) || 1) - 1] || mo;
                 const gross  = Number(p.gross_pay) || 0;
                 const nett   = Number(p.nett_pay)  || 0;
                 const base   = Number(p.base_salary) || Number(p.basic_salary) || 0;
                 const eva    = Number(p.eva_bonus) || 0;
                 const ded    = gross - nett;
                 const st     = p.status || 'pending';
                 const stCol  = st === 'paid' ? '#00d4aa' : st === 'finalised' ? '#eda5ff' : '#fec24f';
                 return `<tr>
                   <td style="font-weight:700">${moLabel} ${yr}</td>
                   <td>R ${base.toLocaleString('en-ZA',{maximumFractionDigits:2})}</td>
                   <td style="color:var(--gold)">R ${eva.toLocaleString('en-ZA',{maximumFractionDigits:2})}</td>
                   <td>R ${gross.toLocaleString('en-ZA',{maximumFractionDigits:2})}</td>
                   <td style="color:#ff5b5b">−R ${ded.toLocaleString('en-ZA',{maximumFractionDigits:2})}</td>
                   <td style="font-weight:800;color:var(--accent2)">R ${nett.toLocaleString('en-ZA',{maximumFractionDigits:2})}</td>
                   <td><span style="background:${stCol}18;color:${stCol};border:1px solid ${stCol}40;border-radius:20px;padding:2px 10px;font-size:0.72rem;font-weight:700">${st}</span></td>
                   <td><button class="btn btn--secondary btn--sm" id="psDl-${i}" data-pid="${p.id}"><i class="fa-solid fa-download"></i></button></td>
                 </tr>`;
               }).join('')}
             </tbody>
           </table>
         </div>`
    }`;

  _payslips.forEach((p, i) => {
    document.getElementById(`psDl-${i}`)?.addEventListener('click', () => downloadPayslip(p.id));
  });
}

function exportPayslipsCSV() {
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const rows = [['Pay Period','Base Salary','EVA Bonus','Gross Pay','Deductions','Nett Pay','Status']];
  _payslips.forEach(p => {
    const [yr, mo] = (p.pay_period || '').split('-');
    const moLabel  = MONTHS[(parseInt(mo,10)||1)-1] || mo;
    const gross    = Number(p.gross_pay)   || 0;
    const nett     = Number(p.nett_pay)    || 0;
    const base     = Number(p.base_salary) || Number(p.basic_salary) || 0;
    const eva      = Number(p.eva_bonus)   || 0;
    rows.push([`${moLabel} ${yr}`, base.toFixed(2), eva.toFixed(2), gross.toFixed(2), (gross-nett).toFixed(2), nett.toFixed(2), p.status||'pending']);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download = `SVC-Payslips-${_emp?.first_name||'Employee'}-${new Date().getFullYear()}.csv`;
  a.click(); showToast('Payslips CSV exported', 'success');
}

function exportPayslipsPDF() {
  if (!window.jspdf) { showToast('PDF library not loaded', 'error'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });
  const W = doc.internal.pageSize.getWidth();
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  doc.setFont('helvetica','bold'); doc.setFontSize(16); doc.setTextColor(124,92,252);
  doc.text('SV Capital — Payslip History', 14, 18);
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(107,114,128);
  doc.text(`Employee: ${_emp?.first_name||''} ${_emp?.last_name||''} · ${_emp?.role||''} · Generated: ${new Date().toLocaleDateString('en-ZA')}`, 14, 25);

  const rows = _payslips.map(p => {
    const [yr, mo] = (p.pay_period||'').split('-');
    const moLabel  = MONTHS[(parseInt(mo,10)||1)-1]||mo;
    const gross    = Number(p.gross_pay)   || 0;
    const nett     = Number(p.nett_pay)    || 0;
    const base     = Number(p.base_salary) || Number(p.basic_salary) || 0;
    const eva      = Number(p.eva_bonus)   || 0;
    return [`${moLabel} ${yr}`, `R ${base.toFixed(2)}`, `R ${eva.toFixed(2)}`, `R ${gross.toFixed(2)}`, `-R ${(gross-nett).toFixed(2)}`, `R ${nett.toFixed(2)}`, p.status||'pending'];
  });

  doc.autoTable({
    startY: 30,
    head: [['Period','Base','EVA Bonus','Gross','Deductions','Nett','Status']],
    body: rows,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [124,92,252], textColor: 255, fontStyle:'bold' },
    alternateRowStyles: { fillColor: [245,245,252] },
    columnStyles: { 5: { fontStyle:'bold', textColor:[0,212,170] } },
    margin: { left:14, right:14 },
  });

  doc.save(`SVC-Payslips-${_emp?.first_name||'Employee'}-${new Date().getFullYear()}.pdf`);
  showToast('Payslip history PDF downloaded', 'success');
}

/* ═══════════════════════════════════════════════════════════════
   COMMAND PALETTE
   ═══════════════════════════════════════════════════════════════ */

const EMP_CMD_ITEMS = [
  { label:'Dashboard',           icon:'fa-house',              group:'Navigate', action:()=>navigate('dashboard',   document.querySelector('[data-view=dashboard]')) },
  { label:'My Courses',          icon:'fa-book-open',          group:'Navigate', action:()=>navigate('courses',     document.querySelector('[data-view=courses]')) },
  { label:'Learning Paths',      icon:'fa-road',               group:'Navigate', action:()=>navigate('paths',       document.querySelector('[data-view=paths]')) },
  { label:'My KPIs',             icon:'fa-chart-bar',          group:'Navigate', action:()=>navigate('kpis',        document.querySelector('[data-view=kpis]')) },
  { label:'My OKRs',             icon:'fa-bullseye',           group:'Navigate', action:()=>navigate('okrs',        document.querySelector('[data-view=okrs]')) },
  { label:'Feedback & Kudos',    icon:'fa-hands-clapping',     group:'Navigate', action:()=>navigate('feedback',    document.querySelector('[data-view=feedback]')) },
  { label:'Pulse Survey',        icon:'fa-poll',               group:'Navigate', action:()=>navigate('pulse',       document.querySelector('[data-view=pulse]')) },
  { label:'1-on-1s',             icon:'fa-comments',           group:'Navigate', action:()=>navigate('oneonone',    document.querySelector('[data-view=oneonone]')) },
  { label:'Daily Check-in',      icon:'fa-sun',                group:'Navigate', action:()=>navigate('checkin',     document.querySelector('[data-view=checkin]')) },
  { label:'My Leave',            icon:'fa-umbrella-beach',     group:'Navigate', action:()=>navigate('leave',       document.querySelector('[data-view=leave]')) },
  { label:'Leave Calendar',      icon:'fa-calendar-days',      group:'Navigate', action:()=>navigate('calendar',    document.querySelector('[data-view=calendar]')) },
  { label:'EVA Statement',       icon:'fa-money-bill-trend-up',group:'Navigate', action:()=>navigate('eva',         document.querySelector('[data-view=eva]')) },
  { label:'My Payslips',         icon:'fa-file-invoice-dollar',group:'Navigate', action:()=>navigate('payslips',    document.querySelector('[data-view=payslips]')) },
  { label:'Achievements',        icon:'fa-trophy',             group:'Navigate', action:()=>navigate('achievements',document.querySelector('[data-view=achievements]')) },
  { label:'Activity Feed',       icon:'fa-bolt',               group:'Navigate', action:()=>navigate('feed',        document.querySelector('[data-view=feed]')) },
  { label:'Journal',             icon:'fa-pen-to-square',      group:'Navigate', action:()=>navigate('journal',     document.querySelector('[data-view=journal]')) },
  { label:'My Profile',          icon:'fa-id-card',            group:'Navigate', action:()=>navigate('profile',     document.querySelector('[data-view=profile]')) },
  { label:'Export Payslips CSV', icon:'fa-table',              group:'Actions',  action:()=>{ navigate('payslips',document.querySelector('[data-view=payslips]')); setTimeout(exportPayslipsCSV,300); } },
  { label:'Download Payslips PDF',icon:'fa-file-pdf',          group:'Actions',  action:()=>{ navigate('payslips',document.querySelector('[data-view=payslips]')); setTimeout(exportPayslipsPDF,300); } },
  { label:'Generate AI Course',  icon:'fa-robot',              group:'Actions',  action:()=>{ if(typeof openAiGenModal==='function') openAiGenModal(); } },
  { label:'Go to Team Dashboard',icon:'fa-people-group',       group:'Actions',  action:()=>{ window.location.href='index.html'; } },
  { label:'Go to App Hub',       icon:'fa-grid-2',             group:'Actions',  action:()=>{ window.location.href='hub.html'; } },
];

let _empCmdActive = -1;

function openEmpCmd() {
  const overlay = document.getElementById('empCmdOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  _empCmdActive = -1;
  const inp = document.getElementById('empCmdInput');
  if (inp) { inp.value = ''; inp.focus(); }
  renderEmpCmdResults('');
}

function closeEmpCmd() {
  const overlay = document.getElementById('empCmdOverlay');
  if (overlay) overlay.style.display = 'none';
}

function renderEmpCmdResults(q) {
  const list = document.getElementById('empCmdList');
  if (!list) return;
  _empCmdActive = -1;
  const query = (q || '').toLowerCase().trim();
  const hits  = query ? EMP_CMD_ITEMS.filter(c => c.label.toLowerCase().includes(query) || c.group.toLowerCase().includes(query)) : EMP_CMD_ITEMS;

  const groups = {};
  hits.forEach(c => { (groups[c.group] = groups[c.group] || []).push(c); });

  let html = '';
  const gIdx = { i: 0 };
  Object.entries(groups).forEach(([grp, items]) => {
    html += `<div style="padding:4px 14px 2px;font-size:0.63rem;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.25)">${grp}</div>`;
    items.forEach(item => {
      const idx = gIdx.i++;
      html += `<div class="emp-cmd-item" data-idx="${idx}"
        style="display:flex;align-items:center;gap:12px;padding:9px 14px;cursor:pointer;border-radius:8px;margin:0 6px;transition:background 0.12s"
        onmouseover="empCmdHover(${idx})" onclick="empCmdSelect(${idx})">
        <i class="fa-solid ${item.icon}" style="width:16px;text-align:center;color:rgba(237,165,255,0.85);font-size:0.85rem"></i>
        <span style="font-size:0.88rem;color:#e2e4f0">${item.label}</span>
      </div>`;
    });
  });

  list.innerHTML = html || `<div style="padding:24px;text-align:center;color:rgba(255,255,255,0.3);font-size:0.85rem">No results for "${q}"</div>`;
  list._hits = hits;
}

function empCmdHover(idx) {
  _empCmdActive = idx;
  document.querySelectorAll('#empCmdList .emp-cmd-item').forEach(el => {
    el.style.background = +el.dataset.idx === idx ? 'rgba(237,165,255,0.15)' : '';
  });
}

function empCmdSelect(idx) {
  const list = document.getElementById('empCmdList');
  const hits = list?._hits || EMP_CMD_ITEMS;
  if (hits[idx]) { closeEmpCmd(); hits[idx].action(); }
}

function empCmdKeyNav(e) {
  const list  = document.getElementById('empCmdList');
  const items = list?.querySelectorAll('.emp-cmd-item') || [];
  const count = items.length;
  if (!count) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _empCmdActive = (_empCmdActive + 1) % count;
    empCmdHover(_empCmdActive);
    items[_empCmdActive]?.scrollIntoView({ block:'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _empCmdActive = (_empCmdActive - 1 + count) % count;
    empCmdHover(_empCmdActive);
    items[_empCmdActive]?.scrollIntoView({ block:'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (_empCmdActive >= 0) empCmdSelect(_empCmdActive);
  } else if (e.key === 'Escape') {
    closeEmpCmd();
  }
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const overlay = document.getElementById('empCmdOverlay');
    if (overlay && overlay.style.display !== 'none') closeEmpCmd();
    else openEmpCmd();
  } else if (e.key === 'Escape') {
    const overlay = document.getElementById('empCmdOverlay');
    if (overlay && overlay.style.display !== 'none') closeEmpCmd();
  }
});
