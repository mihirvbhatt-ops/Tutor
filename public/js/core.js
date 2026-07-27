// ── Service Worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator)
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(()=>{}));

// ── Helpers ───────────────────────────────────────────────────────────────────
const get   = id  => document.getElementById(id);
const qa    = sel => document.querySelectorAll(sel);
const esc   = s   => { const d=document.createElement('div'); d.textContent=s??''; return d.innerHTML; };

// A labeled percentage bar with the % shown to its right — the shared visual
// for course/topic/question stats popups. `pct` of null/undefined renders an
// empty bar with a "–" (nothing attempted yet) instead of claiming 0%.
function statBarRow(label, pct) {
  const width = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const display = pct == null ? '–' : `${pct}%`;
  return `<div class="stat-bar-row">
    <span class="stat-bar-label">${esc(label)}</span>
    <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${width}%"></div></div>
    <span class="stat-bar-pct">${display}</span>
  </div>`;
}

// Positions a position:fixed popover next to the element that triggered it
// (a clicked book, typically) instead of leaving it centered or stuck
// wherever it happens to sit in the document — preferring its right side,
// falling back to its left, and clamped so it always stays fully on screen
// regardless of which edge of the shelf the book was on. `el` must already
// be visible (not display:none) so its real size can be measured.
function positionPopoverNear(el, triggerEl) {
  if (!triggerEl) return; // no anchor given — leave the CSS default (centered) in place
  const margin = 10;
  const t = triggerEl.getBoundingClientRect();
  const r = el.getBoundingClientRect();

  let left = t.right + margin;
  if (left + r.width > window.innerWidth - margin) left = t.left - r.width - margin;
  if (left < margin) left = Math.max(margin, Math.min(window.innerWidth - r.width - margin, t.left));

  let top = t.top;
  if (top + r.height > window.innerHeight - margin) top = window.innerHeight - r.height - margin;
  if (top < margin) top = margin;

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.transform = 'none';
}

// Every request goes through one of these helpers, all of which treat a
// non-2xx response as a real failure (throwing, so it lands in the caller's
// .catch/try-catch) instead of silently resolving with a { error } body that
// looks identical to a success payload — the old behaviour that made every
// caller responsible for manually checking data.error itself.
async function toResultOrThrow(r) {
  let data;
  try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
const getJson = (url, signal) => fetch(url, { signal }).then(toResultOrThrow);
const post  = (url, body, signal) => fetch(url, {
  method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body), signal
}).then(toResultOrThrow);
const patchReq = (url, body) => fetch(url, {
  method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
}).then(toResultOrThrow);
const del = (url) => fetch(url, { method: 'DELETE' }).then(toResultOrThrow);

// Retries a POST up to maxAttempts — skips on AbortError (user cancelled)
async function postWithRetry(url, body, signal, maxAttempts = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await post(url, body, signal); }
    catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

// roadmap #14 — /api/chat streams its reply over SSE instead of one JSON
// blob, so callers can render text as it arrives instead of showing a
// spinner for the full multi-turn generation. Resolves with { reply }, the
// same shape postWithRetry used to hand back, so callers that don't care
// about live text (wizard steps, the study-guide generator) need no other
// changes; onDelta is only for callers that want to paint chunks live.
async function chatOnce(body, signal, onDelta) {
  const res = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal
  });
  if (!res.ok) {
    let data = {};
    try { data = await res.json(); } catch {}
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', reply = null, errMsg = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = chunk.match(/^event: (.+)$/m)?.[1];
      const raw   = chunk.match(/^data: (.+)$/m)?.[1];
      if (!event || !raw) continue;
      const data = JSON.parse(raw);
      if (event === 'delta') onDelta?.(data.text);
      else if (event === 'done') reply = data.reply;
      else if (event === 'error') errMsg = data.error;
    }
  }
  if (errMsg) throw new Error(errMsg);
  return { reply };
}

// Retries only the connect phase — once any delta has reached onDelta,
// re-running the request would duplicate text already shown, so a failure
// past that point is surfaced instead of retried (mirrors the server's
// own no-retry-after-streamed-output rule in withRetry/runAgent).
async function chatStream(body, signal, onDelta, maxAttempts = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let streamedAny = false;
    try {
      return await chatOnce(body, signal, text => { streamedAny = true; onDelta?.(text); });
    } catch (err) {
      if (err.name === 'AbortError' || streamedAny) throw err;
      lastErr = err;
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentTopic  = null;   // { id, name, level, timeLimit, modes }
let wizardData    = {};     // built across wizard steps
let wizardStep    = 0;
let uploadedFile  = null;

// Session IDs isolate history between topics and wizard runs.
// Each wizard run gets a unique ID; each study topic uses 'study-{topicId}'.
let wizardSessionId = null;
function studySessionId(topicId) { return `study-${topicId}`; }
let materialType  = 'none'; // 'paste'|'url'|'file'|'none'
let selectedModes = new Set();

// Recommended max characters of reference material per topic — keeps prompts
// fast and affordable. Never enforced silently: the UI always shows the count
// and lets the user choose what to keep instead of quietly cutting text off.
const MATERIAL_SOFT_LIMIT = 20000;
const fmtCount = n => n.toLocaleString();

// Quiz + Flash runtime state
let quizQs = [], quizIdx = 0;
let flashQs = [], flashIdx = 0;

// ── Quiz clock ────────────────────────────────────────────────────────────────
// A pausable stopwatch for the active quiz session (elapsed time, not a
// countdown). Only ticks while the quiz panel is actually the one showing —
// switching tabs/modes freezes it via snapshotMode/restoreMode below, same as
// pausing does, so time spent elsewhere never counts toward it. Per-question
// timeMs (recordSessionAnswer) is derived from this same clock rather than
// wall-clock time, so pausing mid-question also stops that question's timer.
let quizClockMs = 0;            // accumulated elapsed ms, frozen while not ticking
let quizClockResumedAt = null;  // Date.now() when the current ticking segment began, or null
let quizClockPaused = false;    // explicit user pause, persists across tab/mode switches
let quizClockTimerId = null;    // setInterval driving the on-screen tick
let quizQuestionClockStart = 0; // quizClockElapsedMs() at the moment the current question was shown

function quizClockElapsedMs() {
  return quizClockMs + (quizClockResumedAt ? Date.now() - quizClockResumedAt : 0);
}
function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function renderQuizClock() {
  const el = get('quiz-clock');
  if (el) el.textContent = formatClock(quizClockElapsedMs());
}
// Stops the ticking interval and folds whatever elapsed into quizClockMs.
// Idempotent — safe to call whether or not the clock is currently ticking.
function freezeQuizClock() {
  if (quizClockResumedAt) { quizClockMs += Date.now() - quizClockResumedAt; quizClockResumedAt = null; }
  if (quizClockTimerId) { clearInterval(quizClockTimerId); quizClockTimerId = null; }
  renderQuizClock();
}
// Resumes ticking unless the user has explicitly paused. Idempotent.
function startQuizClockTicking() {
  if (quizClockPaused || quizClockResumedAt) return;
  quizClockResumedAt = Date.now();
  renderQuizClock();
  quizClockTimerId = setInterval(renderQuizClock, 1000);
}
function updateQuizPauseBtn() {
  const btn = get('btn-quiz-pause');
  if (!btn) return;
  btn.textContent = quizClockPaused ? '▶' : '⏸';
  btn.title = quizClockPaused ? 'Resume' : 'Pause';
  get('quiz-card')?.classList.toggle('quiz-paused', quizClockPaused);
}
function toggleQuizClockPause() {
  if (quizClockPaused) {
    quizClockPaused = false;
    startQuizClockTicking();
  } else {
    freezeQuizClock();
    quizClockPaused = true;
  }
  updateQuizPauseBtn();
}

// ── Session-level stats tracking ─────────────────────────────────────────────
// A "session" = one visit to the Quiz or Flashcard panel for a topic. Ended
// automatically on completion, on switching modes/views, or on page unload.
let activeStudySessionId = null;
let questionShownAt = null;
let sessionAnswers = []; // [{ question, correct }] for the run in progress — powers the end-of-session summary

async function endActiveStudySession() {
  if (!activeStudySessionId) return;
  const id = activeStudySessionId;
  activeStudySessionId = null;
  try { await post(`/api/sessions/${id}/end`, {}); } catch {}
}

async function startStudySession(topicId, mode) {
  await endActiveStudySession();
  sessionAnswers = [];
  try {
    const s = await post('/api/sessions/start', { topicId, mode });
    activeStudySessionId = s.id || null;
  } catch { activeStudySessionId = null; }
}

function recordSessionAnswer(correct, timeMs = null, questionText = '') {
  sessionAnswers.push({ question: questionText, correct });
  if (!activeStudySessionId) return;
  const t = timeMs != null ? timeMs : (questionShownAt ? Date.now() - questionShownAt : 0);
  patchReq(`/api/sessions/${activeStudySessionId}`, { correct, timeMs: t }).catch(()=>{});
}

// Builds the end-of-session summary HTML: accuracy this run vs. last time for
// this topic+mode, what was missed, and a suggested next action. Called after
// the session has been ended (so "last time" no longer includes this run) —
// but the just-ended session is still the most recent row in the DB, so the
// completedSessionId is explicitly excluded from the comparison lookup to
// avoid comparing the run against itself.
async function buildSessionSummaryHtml(topicId, mode, completedSessionId = null) {
  const answered = sessionAnswers.length;
  const correct  = sessionAnswers.filter(a => a.correct).length;
  const thisAccuracy = answered ? Math.round((correct / answered) * 100) : null;
  const missed = sessionAnswers.filter(a => !a.correct && a.question);

  let lastAccuracy = null;
  let hasPriorSession = false;
  try {
    // Fetch more than one in case the most recent rows are the one we just
    // completed, or an earlier session that was ended with 0 questions
    // answered (accuracy: null — e.g. the user left the panel before
    // answering anything). Skip both when looking for "last time", so a
    // genuine prior result further back isn't reported as "first session".
    const prior = await getJson(`/api/sessions?topicId=${encodeURIComponent(topicId)}&mode=${mode}&limit=10`);
    const priorExcludingThis = prior.filter(s => s.id !== completedSessionId);
    hasPriorSession = priorExcludingThis.length > 0;
    const lastWithAccuracy = priorExcludingThis.find(s => s.accuracy != null);
    if (lastWithAccuracy) lastAccuracy = lastWithAccuracy.accuracy;
  } catch {}

  let comparisonLine;
  if (lastAccuracy == null) {
    comparisonLine = hasPriorSession
      ? `First scored ${mode} session for this topic.`
      : `First completed ${mode} session for this topic.`;
  } else if (thisAccuracy > lastAccuracy) {
    comparisonLine = `↑ Up from ${lastAccuracy}% last time`;
  } else if (thisAccuracy < lastAccuracy) {
    comparisonLine = `↓ Down from ${lastAccuracy}% last time`;
  } else {
    comparisonLine = `Same as last time (${lastAccuracy}%)`;
  }

  let suggestion;
  if (!answered) {
    suggestion = 'No questions answered this run.';
  } else if (missed.length) {
    suggestion = 'Revisit the missed questions below before moving on.';
  } else if (thisAccuracy != null && thisAccuracy >= 85) {
    suggestion = mode === 'flashcard'
      ? 'Strong recall — try Quiz mode next for a deeper check.'
      : 'Great grasp of this material — consider starting a new topic.';
  } else {
    suggestion = 'Keep practising this set — accuracy improves with repetition.';
  }

  const missedList = missed.length
    ? `<ul class="summary-missed-list">${missed.slice(0,5).map(m => `<li>${esc(m.question)}</li>`).join('')}</ul>
       ${missed.length > 5 ? `<p class="hint">+ ${missed.length - 5} more</p>` : ''}`
    : `<p class="hint">${answered ? 'No misses this run — nice work.' : ''}</p>`;

  return `
    <div class="session-summary">
      <p class="summary-title">Session complete</p>
      <div class="summary-stat-row">
        <span class="summary-stat-value">${thisAccuracy != null ? thisAccuracy + '%' : '–'}</span>
        <span class="summary-stat-sub">${comparisonLine}</span>
      </div>
      <p class="summary-subhead">To revisit</p>
      ${missedList}
      <p class="summary-suggestion">${esc(suggestion)}</p>
      <button class="primary-btn" id="btn-summary-continue">Continue</button>
    </div>
  `;
}

window.addEventListener('beforeunload', () => {
  // End every open tab's in-progress session, not just the currently visible one.
  const active = studyTabs.find(t => t.id === activeTabId);
  if (active) snapshotMode(active, active.mode);
  const ids = new Set();
  studyTabs.forEach(t => { if (t.quizSessionId) ids.add(t.quizSessionId); if (t.flashSessionId) ids.add(t.flashSessionId); });
  ids.forEach(id => {
    navigator.sendBeacon?.(`/api/sessions/${id}/end`, new Blob([JSON.stringify({})], { type: 'application/json' }));
  });
});

// ── Study tabs ────────────────────────────────────────────────────────────────
// Each open tab is its own topic instance with independent quiz/flashcard
// progress and its own session-stats tracking per mode — so the same topic
// (or a different one) can be open several times over, side by side.
let studyTabs   = [];
let activeTabId = null;
let tabCounter  = 0;
const newTabId = () => `tab${++tabCounter}_${Date.now().toString(36)}`;

function newStudyTabState(topicId, topicName, modes, level, timeLimit, startMode) {
  return {
    id: newTabId(), topicId, topicName,
    // modes == null (omitted) defaults to all three; an explicit [] (empty
    // tab, no topic yet) is respected as-is so no mode sub-tabs show.
    modes: modes != null ? modes : ['explain','flashcard','quiz'],
    level: level || null, timeLimit: timeLimit != null ? timeLimit : null,
    mode: startMode || 'explain', isGuide: false, explainHtml: null,
    quizQs: [], quizIdx: 0, quizLoaded: false, quizSessionId: null, quizShownAt: null, quizAnswers: [], quizSummaryHtml: null,
    quizClockMs: 0, quizClockPaused: false, quizQuestionClockStart: 0,
    flashQs: [], flashIdx: 0, flashLoaded: false, flashSessionId: null, flashShownAt: null, flashAnswers: [], flashSummaryHtml: null
  };
}

function getActiveTab() { return studyTabs.find(t => t.id === activeTabId) || null; }

// Adding, editing, deleting, or regenerating a topic's questions already
// clears the server-side session-progress row (see callers), but any Study
// tab that had already visited Quiz/Flashcard mode for this topic keeps its
// quizLoaded/flashLoaded flag stuck true — so ensureModeLoaded() skips
// reloading and renderQuizQuestion()/renderFlashCard() just replay whatever
// was cached, including a completed run's summary HTML from before the edit.
// Revisiting that tab then shows a stale "same as last time" comparison that
// no longer matches the current question set. Reset every open tab's cached
// state for this topic (and the live globals too, if one of them is active)
// so a revisit always reloads fresh.
function invalidateTopicStudyState(topicId) {
  studyTabs.forEach(t => {
    if (t.topicId !== topicId) return;
    t.quizQs = []; t.quizIdx = 0; t.quizLoaded = false; t.quizSummaryHtml = null; t.quizAnswers = [];
    t.quizClockMs = 0; t.quizClockPaused = false; t.quizQuestionClockStart = 0;
    t.flashQs = []; t.flashIdx = 0; t.flashLoaded = false; t.flashSummaryHtml = null; t.flashAnswers = [];
    if (t.id === activeTabId) {
      quizQs = []; quizIdx = 0; flashQs = []; flashIdx = 0; sessionAnswers = [];
      freezeQuizClock();
      quizClockMs = 0; quizClockPaused = false; quizQuestionClockStart = 0;
    }
  });
}

// Manage-panel edits (generate, manual add/edit/delete) happen in a panel
// docked above the study tabs — if the tab actually on screen is showing the
// topic/mode just changed, reload it immediately so the new questions show
// up without switching tabs away and back, let alone a full page reload.
function refreshLiveStudyPanel(topicId) {
  const active = getActiveTab();
  if (!active || active.topicId !== topicId) return;
  if (active.mode === 'flashcard')    { active.flashLoaded = true; loadFlashPanel(topicId); }
  else if (active.mode === 'quiz')    { active.quizLoaded = true; loadQuizPanel(topicId); }
}

// Opens a brand-new tab for a topic — always adds a new tab rather than
// reusing one, so the same topic (or the same mode) can be open more than
// once at a time.
function openStudyTab(topic, session, startMode) {
  const sess = session || loadSession(topic.id) || {};
  const tab = newStudyTabState(topic.id, topic.name, sess.modes, sess.level, sess.timeLimit, startMode);
  studyTabs.push(tab);
  showView('study');
  switchToTab(tab.id);
}

// Opens a blank tab with no topic assigned — a placeholder the user can fill
// in later by picking a topic from its own prompt (see renderEmptyTabPrompt),
// without it being redirected into yet another brand-new tab.
function openEmptyTab() {
  const tab = newStudyTabState(null, 'New tab', [], null, null);
  studyTabs.push(tab);
  showView('study');
  switchToTab(tab.id);
}

// When set, the next topic opened via Library/Home fills THIS tab in place
// instead of creating a new one — used so picking a topic from an empty
// tab's own prompt doesn't leave the empty tab behind as clutter.
let fillTargetTabId = null;

function fillEmptyTabOrOpenNew(topic, session, startMode) {
  const sess = session || loadSession(topic.id) || {};
  const target = fillTargetTabId ? studyTabs.find(t => t.id === fillTargetTabId && !t.topicId) : null;
  fillTargetTabId = null;
  if (target) {
    target.topicId   = topic.id;
    target.topicName = topic.name;
    target.modes     = sess.modes != null && sess.modes.length ? sess.modes : ['explain','flashcard','quiz'];
    target.level     = sess.level || null;
    target.timeLimit  = sess.timeLimit != null ? sess.timeLimit : null;
    target.mode = startMode || 'explain';
    showView('study');
    switchToTab(target.id);
    return;
  }
  openStudyTab(topic, sess, startMode);
}

// Pulls the live globals (quizQs/quizIdx/etc.) for whichever mode is
// currently showing back into the tab object, before we switch away from it.
function snapshotMode(tab, mode) {
  if (!tab) return;
  if (mode === 'quiz') {
    tab.quizQs = quizQs; tab.quizIdx = quizIdx;
    tab.quizSessionId = activeStudySessionId;
    tab.quizShownAt = questionShownAt;
    tab.quizAnswers = sessionAnswers;
    // Freeze the clock while this tab isn't the one showing — only ticks
    // while its quiz panel is actually visible (see startQuizClockTicking).
    freezeQuizClock();
    tab.quizClockMs = quizClockMs;
    tab.quizClockPaused = quizClockPaused;
    tab.quizQuestionClockStart = quizQuestionClockStart;
  } else if (mode === 'flashcard') {
    tab.flashQs = flashQs; tab.flashIdx = flashIdx;
    tab.flashSessionId = activeStudySessionId;
    tab.flashShownAt = questionShownAt;
    tab.flashAnswers = sessionAnswers;
  }
}

// Loads a tab's saved mode state back into the live globals.
function restoreMode(tab, mode) {
  currentTopic = { id: tab.topicId, name: tab.topicName, modes: tab.modes, level: tab.level, timeLimit: tab.timeLimit };
  if (mode === 'quiz') {
    quizQs = tab.quizQs || []; quizIdx = tab.quizIdx || 0;
    activeStudySessionId = tab.quizSessionId || null;
    questionShownAt = tab.quizShownAt || null;
    sessionAnswers = tab.quizAnswers || [];
    quizClockMs = tab.quizClockMs || 0;
    quizClockPaused = !!tab.quizClockPaused;
    quizQuestionClockStart = tab.quizQuestionClockStart || 0;
    quizClockResumedAt = null; // (re)started explicitly once the panel is actually shown
  } else if (mode === 'flashcard') {
    flashQs = tab.flashQs || []; flashIdx = tab.flashIdx || 0;
    activeStudySessionId = tab.flashSessionId || null;
    questionShownAt = tab.flashShownAt || null;
    sessionAnswers = tab.flashAnswers || [];
  } else {
    activeStudySessionId = null; // explain mode has no stats session
  }
}

// The bar (and its + button) is always visible, even with zero tabs open —
// it's the one consistent place to start a tab, rather than only being
// reachable via Library/Home.
function renderStudyTabsBar() {
  const bar = get('study-tabs-bar');
  bar.classList.remove('hidden');
  const ico = t => !t.topicId ? '🗋' : t.isGuide ? '📑' : t.mode === 'quiz' ? '❓' : t.mode === 'flashcard' ? '🗂️' : '📖';
  const chips = studyTabs.map(t => `
    <button class="study-tab-chip ${t.id === activeTabId ? 'active' : ''}" data-tab="${t.id}">
      <span class="tab-mode-ico">${ico(t)}</span>
      <span class="tab-name">${esc(t.topicName)}</span>
      <span class="tab-close" data-close="${t.id}">×</span>
    </button>
  `).join('');
  // Chips live in their own scrollable strip; the + button sits outside it,
  // pinned to the right edge of the bar so it's always reachable and never
  // scrolls out of view behind a long row of open tabs.
  bar.innerHTML = `<div class="study-tabs-scroll">${chips}</div>
    <button class="study-tab-add" id="btn-add-study-tab" title="Open another tab">+</button>`;
  qa('.study-tab-chip').forEach(chip => chip.addEventListener('click', (e) => {
    if (e.target.dataset.close) return;
    switchToTab(chip.dataset.tab);
  }));
  qa('.tab-close').forEach(x => x.addEventListener('click', (e) => {
    e.stopPropagation();
    closeStudyTab(e.target.dataset.close);
  }));
  get('btn-add-study-tab').addEventListener('click', openAddTabMenu);
}

// "+" button: duplicate the current topic into a new tab (same topic, e.g.
// to run Quiz and Flashcards side by side), open a blank tab to fill in
// later, or jump to Library/Home to open a different topic as a new tab.
function openAddTabMenu() {
  const current = getActiveTab();
  qa('.add-tab-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'add-tab-menu';
  menu.innerHTML = `
    ${current && current.topicId ? `<button data-action="duplicate">↗ Open "${esc(current.topicName)}" in a new tab</button>` : ''}
    <button data-action="empty">🗋 Open an empty tab</button>
    <button data-action="library">📚 Choose from Library</button>
    <button data-action="home">＋ Start a new topic</button>
  `;
  document.body.appendChild(menu);
  const btn = get('btn-add-study-tab');
  const r = btn.getBoundingClientRect();
  menu.style.top  = (r.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - r.right) + 'px';

  menu.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (action === 'duplicate' && current) {
      openStudyTab({ id: current.topicId, name: current.topicName }, {
        modes: current.modes, level: current.level, timeLimit: current.timeLimit
      });
    } else if (action === 'empty') {
      openEmptyTab();
    } else if (action === 'library') {
      showView('library');
    } else if (action === 'home') {
      showView('home');
    }
    menu.remove();
  });
  setTimeout(() => {
    document.addEventListener('click', function closeMenu(e) {
      if (!menu.contains(e.target) && e.target !== btn) { menu.remove(); document.removeEventListener('click', closeMenu); }
    });
  }, 0);
}

function showStudyEmpty() {
  get('study-empty').classList.remove('hidden');
  get('study-active').classList.add('hidden');
}

function renderStudyHeader(tab) {
  get('study-empty').classList.add('hidden');
  get('study-active').classList.remove('hidden');
  get('study-topic-name').textContent = tab.topicName;
  const level = tab.level || '';
  const time  = tab.timeLimit ? (tab.timeLimit === '0' || tab.timeLimit === 0 ? 'No limit' : tab.timeLimit + ' min') : '';
  get('study-meta').textContent = [level, time].filter(Boolean).join(' · ')
    || (tab.isGuide ? 'Study guide' : !tab.topicId ? 'Empty tab' : '');
  get('topic-manage-panel').classList.add('hidden');
  get('btn-manage-topic').classList.toggle('hidden', !!tab.isGuide || !tab.topicId);
}

// Shown in the explain-panel slot for a tab that has no topic assigned yet.
// Picking a topic from here fills THIS tab in place (see fillEmptyTabOrOpenNew)
// rather than opening yet another new one.
// Toggles between the full-panel empty-tab placeholder and the normal
// explanation content (body + follow-up thread), which live in separate
// containers so the placeholder can center over the whole panel instead of
// being squeezed into explain-body's narrower reading column.
function showExplainEmptyState(show) {
  get('explain-empty-state').classList.toggle('hidden', !show);
  get('explain-body').classList.toggle('hidden', show);
  get('explain-followups').classList.toggle('hidden', show);
}

function renderEmptyTabPrompt(tab) {
  showExplainEmptyState(true);
  get('explain-followup-bar')?.classList.add('hidden');
  get('explain-empty-state').innerHTML = `
    <div class="empty-glyph">🗋</div>
    <p class="empty-title">Empty tab</p>
    <p class="hint">Pick a topic to study here.</p>
    <div class="empty-tab-actions">
      <button class="primary-btn" id="btn-empty-tab-library">📚 Choose from Library</button>
      <button class="ghost-btn" id="btn-empty-tab-home">＋ Start a new topic</button>
    </div>`;
  get('btn-empty-tab-library')?.addEventListener('click', () => { fillTargetTabId = tab.id; showView('library'); });
  get('btn-empty-tab-home')?.addEventListener('click', () => { fillTargetTabId = tab.id; showView('home'); });
}

function renderModeBar(tab) {
  qa('.mode-tab').forEach(mt => {
    const available = tab.modes.includes(mt.dataset.mode);
    mt.classList.toggle('hidden', !available);
    mt.classList.toggle('active', mt.dataset.mode === tab.mode);
  });
}

function showModePanel(mode) {
  qa('.study-panel').forEach(p => p.classList.remove('active'));
  get(`panel-${mode}`).classList.add('active');
}

// Loads a mode's data the first time a tab shows it; on repeat visits (tab
// switch or mode switch back) it just re-renders from the state already
// restored onto the globals — no refetch, and no duplicate session started.
function ensureModeLoaded(tab, mode) {
  if (!tab.topicId) { renderEmptyTabPrompt(tab); return; }
  if (tab.isGuide) {
    showExplainEmptyState(false);
    get('explain-body').innerHTML = tab.explainHtml || `<div class="explain-loading"><div class="spinner"></div><p>Building study guide from all topics…</p></div>`;
    get('explain-followups').innerHTML = '';
    get('explain-followup-bar')?.classList.add('hidden');
    return;
  }
  if (mode === 'explain') {
    showExplainEmptyState(false);
    get('explain-followup-bar')?.classList.remove('hidden');
    loadExplainPanel(tab.topicId);
    return;
  }
  if (mode === 'quiz') {
    if (tab.quizLoaded) { renderQuizQuestion(); } else { tab.quizLoaded = true; loadQuizPanel(tab.topicId); }
    return;
  }
  if (mode === 'flashcard') {
    if (tab.flashLoaded) { renderFlashCard(); } else { tab.flashLoaded = true; loadFlashPanel(tab.topicId); }
  }
}

function switchToTab(tabId) {
  const outgoing = getActiveTab();
  if (outgoing) snapshotMode(outgoing, outgoing.mode);
  activeTabId = tabId;
  const tab = getActiveTab();
  if (!tab) { currentTopic = null; renderStudyTabsBar(); showStudyEmpty(); return; }
  restoreMode(tab, tab.mode);
  renderStudyTabsBar();
  renderStudyHeader(tab);
  renderModeBar(tab);
  showModePanel(tab.mode);
  ensureModeLoaded(tab, tab.mode);
}

function switchTabMode(tab, newMode) {
  snapshotMode(tab, tab.mode);
  tab.mode = newMode;
  restoreMode(tab, newMode);
  renderStudyTabsBar();
  renderModeBar(tab);
  showModePanel(newMode);
  ensureModeLoaded(tab, newMode);
}

// discardMode: when a mode's session should be thrown away instead of ended
// (see exitStudyMode) — that mode's session is DELETEd from stats entirely
// rather than just stamped with an endedAt, since the user was told exiting
// means the run isn't saved. Any other session on the tab (e.g. the other
// mode, if it also has one) is still ended normally.
function closeStudyTab(tabId, discardMode = null) {
  const idx = studyTabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  if (tabId === activeTabId) snapshotMode(studyTabs[idx], studyTabs[idx].mode);
  const closed = studyTabs[idx];
  const discardId = discardMode === 'quiz' ? closed.quizSessionId
                   : discardMode === 'flashcard' ? closed.flashSessionId
                   : null;
  [closed.quizSessionId, closed.flashSessionId].filter(Boolean).forEach(id => {
    if (id === discardId) del(`/api/sessions/${id}`).catch(()=>{});
    else post(`/api/sessions/${id}/end`, {}).catch(()=>{});
  });
  studyTabs.splice(idx, 1);

  if (activeTabId !== tabId) { renderStudyTabsBar(); return; }
  activeTabId = null;
  const next = studyTabs[idx] || studyTabs[idx - 1];
  if (next) switchToTab(next.id);
  else { currentTopic = null; renderStudyTabsBar(); showStudyEmpty(); }
}

// Exiting a quiz/flashcard mid-session used to just end the session while
// silently leaving the saved resumption index in place, so reopening the
// same topic/mode picked back up exactly where you left off. This clears
// that index too, so the next visit always starts at question 1 — and
// warns first, since both the session and the saved position are gone
// for good once confirmed.
function exitStudyMode(tabId, mode) {
  const tab = studyTabs.find(t => t.id === tabId);
  if (!tab) return;
  const label = mode === 'quiz' ? 'quiz' : 'flashcard deck';
  const ok = confirm(
    `Exit this ${label}? This deletes your current session — progress won't be saved, and next time you'll start over from question 1.`
  );
  if (!ok) return;
  if (tab.topicId) del(`/api/session-progress/${tab.topicId}/${mode}`).catch(()=>{});
  closeStudyTab(tabId, mode);
}

// Explanation cache: stored server-side (see /api/topics/:id/explanation),
// not in localStorage — so a follow-up thread (see loadExplainPanel/
// sendFollowup) persists across tab switches, mode switches, page reloads,
// AND different browsers/devices, instead of being stuck on whichever
// machine first generated it.
async function saveExpl(id, data) {
  try { await post(`/api/topics/${id}/explanation`, data); } catch {}
}
async function loadExpl(id) {
  try { return await getJson(`/api/topics/${id}/explanation`); } catch { return null; }
}

// Sessions (mode/level/time prefs per topic)
const SESS_KEY = 'tutor_sessions';
function saveSession(id, data) {
  const s = JSON.parse(localStorage.getItem(SESS_KEY)||'{}');
  s[id] = data; localStorage.setItem(SESS_KEY, JSON.stringify(s));
}
function loadSession(id) {
  const s = JSON.parse(localStorage.getItem(SESS_KEY)||'{}');
  return s[id] || null;
}

// ── Settings ──────────────────────────────────────────────────────────────────
const SETT_KEY = 'tutor_settings';
const DFLT_SETTINGS = {
  fontFamily:'system', fontSize:16,
  accentColor:'#6c63ff', bgColorDark:'#0f1117', bgColorLight:'#f4f1eb', darkMode:true
};
const FONTS = {
  system : '-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif',
  serif  : 'Georgia,"Times New Roman",serif',
  mono   : '"SF Mono","Consolas","Courier New",monospace',
  humanist: '"Gill Sans","Optima","Segoe UI",sans-serif'
};

function loadSettings() {
  try { return { ...DFLT_SETTINGS, ...JSON.parse(localStorage.getItem(SETT_KEY)||'{}') }; }
  catch { return { ...DFLT_SETTINGS }; }
}
function saveSettings(s) { localStorage.setItem(SETT_KEY, JSON.stringify(s)); }
function applySettings(s) {
  const root = document.documentElement;
  root.style.setProperty('--font', FONTS[s.fontFamily] || FONTS.system);
  root.style.setProperty('--fsize', s.fontSize + 'px');
  setAccent(s.accentColor);
  document.body.classList.toggle('light', !s.darkMode);
  setBg(s.darkMode ? s.bgColorDark : s.bgColorLight, s.darkMode);
}
function setAccent(hex) {
  const [r,g,b] = hex.match(/\w\w/g).map(x=>parseInt(x,16));
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent2', `rgb(${Math.round(r*.5)},${Math.round(g*.5)},${Math.round(b*.5)})`);
  document.documentElement.style.setProperty('--glow', `rgba(${r},${g},${b},.18)`);
}
// Derives the two panel-layer shades from the base background colour. Dark
// mode lightens successive layers so panels lift off a near-black base;
// light mode darkens them slightly instead, so panels read against a light
// base. This runs for whichever colour is active, custom or preset — fixing
// the earlier bug where light mode's panel colours were hardcoded in CSS and
// ignored whatever background the user picked.
function setBg(hex, dark) {
  const [r,g,b] = hex.match(/\w\w/g).map(x=>parseInt(x,16));
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  let bg2, bg3;
  if (dark) {
    bg2 = `rgb(${clamp(r*1.6+8)},${clamp(g*1.6+8)},${clamp(b*1.6+8)})`;
    bg3 = `rgb(${clamp(r*2.2+14)},${clamp(g*2.2+14)},${clamp(b*2.2+14)})`;
  } else {
    bg2 = `rgb(${clamp(r*0.94-10)},${clamp(g*0.94-10)},${clamp(b*0.94-10)})`;
    bg3 = `rgb(${clamp(r*0.88-18)},${clamp(g*0.88-18)},${clamp(b*0.88-18)})`;
  }
  document.documentElement.style.setProperty('--bg', hex);
  document.documentElement.style.setProperty('--bg2', bg2);
  document.documentElement.style.setProperty('--bg3', bg3);
}

let settings = loadSettings();
applySettings(settings);

// ── Navigation ───────────────────────────────────────────────────────────────
const views   = qa('.view');
const navBtns = qa('.nav-btn');
let   activeView = 'home';

// .view panels slide in/out purely via CSS transform (see .view.active in
// styles.css) — .main itself is never meant to scroll and sits at
// overflow:hidden. But Chromium can still nudge .main's native scroll
// position on its own (e.g. focus-driven scroll-into-view on a child that's
// mid-transform), and since overflow:hidden only suppresses user-driven
// scrolling, that offset sticks around and desyncs every panel's visual
// position from its transform. Pin it at 0 so the transform is always the
// only thing that moves a panel.
const mainEl = document.querySelector('.main');
mainEl.addEventListener('scroll', () => {
  mainEl.scrollLeft = 0;
  mainEl.scrollTop = 0;
});

function showView(name) {
  views.forEach(v => {
    const n = v.id.replace('view-','');
    v.classList.toggle('active', n === name);
    v.classList.toggle('left',   n !== name && v.classList.contains('active'));
  });
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name !== 'study') {
    // Sessions now belong to tabs, not to view visibility — just make sure
    // the active tab's in-memory state is flushed before we navigate away.
    const active = getActiveTab();
    if (active) snapshotMode(active, active.mode);
  }
  activeView = name;
  if (name === 'library') { renderLibrary(); renderCourses(); }
  if (name === 'settings') syncSettingsUI();
  if (name === 'stats') renderStats();
  if (name === 'study' && !getActiveTab()) renderStudyTabsBar();
}

navBtns.forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));

get('btn-goto-library').addEventListener('click', () => showView('library'));

