// ── STUDY TAB ─────────────────────────────────────────────────────────────────

qa('.mode-tab').forEach(tab => tab.addEventListener('click', () => {
  const t = getActiveTab();
  if (!t || tab.classList.contains('hidden')) return;
  if (tab.dataset.mode === t.mode) return;
  switchTabMode(t, tab.dataset.mode);
}));

// Explain
async function loadExplainPanel(topicId) {
  const body = get('explain-body');
  const cached = await loadExpl(topicId);
  if (cached) { body.innerHTML = cached.main; renderFollowups(cached.followups); trackExplainScroll(); return; }

  body.innerHTML = `<div class="explain-loading"><div class="spinner"></div><p>Generating explanation…</p></div>`;
  renderFollowups([]);
  let streaming = false;
  chatStream({
    message:   `Generate a structured explanation for topic ID ${topicId}. Use markdown with ## headers. Cover: overview, key concepts, examples, common misconceptions.`,
    sessionId: studySessionId(topicId)
  }, null, chunk => {
    if (!streaming) { streaming = true; body.innerHTML = '<div class="explain-stream"></div>'; }
    body.querySelector('.explain-stream').textContent += chunk;
  })
    .then(data => {
      const html = markdownToHtml(data.reply || '');
      saveExpl(topicId, { main: html, followups: [] });
      body.innerHTML = html;
      trackExplainScroll();
    })
    .catch(() => { body.innerHTML = '<p style="color:var(--ink2)">Could not load explanation — try again.</p>'; });
}

// ── Explanation read tracking ────────────────────────────────────────────────
// Proxy for "how much of the explanation has been read": furthest % scrolled
// through the explain panel, saved server-side per topic (see topic stats
// popup). Debounced so a scroll doesn't fire a request per pixel, and also
// invoked right after content loads to catch explanations short enough to
// need no scrolling at all (fully visible = fully read).
let explainReadTimer = null;
function trackExplainScroll() {
  const tab = getActiveTab();
  if (!tab || !tab.topicId || tab.isGuide || tab.mode !== 'explain') return;
  const panel = get('panel-explain');
  const scrollable = panel.scrollHeight - panel.clientHeight;
  const pct = scrollable <= 0 ? 100 : Math.min(100, Math.round((panel.scrollTop / scrollable) * 100));
  clearTimeout(explainReadTimer);
  explainReadTimer = setTimeout(() => {
    post(`/api/topics/${tab.topicId}/explanation-read`, { pct }).catch(() => {});
  }, 600);
}
get('panel-explain').addEventListener('scroll', trackExplainScroll);

function renderFollowups(list) {
  get('explain-followups').innerHTML = (list || []).map(f => `
    <div class="followup-qa">
      <div class="followup-q">${esc(f.q)}</div>
      <div class="followup-a">${f.a}</div>
    </div>
  `).join('');
}

// Turns the explanation from a one-shot, cached-forever block of text into a
// living thread: "Simplify" / "Example" / "Different angle" chips, or a
// free-form question, all reusing the topic's existing chat session so the
// model has full context of what it already explained. No separate chat UI
// needed, and the whole thread persists in the same explain cache as before.
async function sendFollowup(topicId, question) {
  const input = get('followup-input');
  const sendBtn = get('btn-followup-send');
  input.disabled = true; sendBtn.disabled = true;
  qa('.chip-btn').forEach(b => b.disabled = true);

  const cached = (await loadExpl(topicId)) || { main: get('explain-body').innerHTML, followups: [] };
  const followups = cached.followups ? cached.followups.slice() : [];
  const pendingIdx = followups.length;

  const followupsEl = get('explain-followups');
  followupsEl.insertAdjacentHTML('beforeend', `
    <div class="followup-qa" data-pending="${pendingIdx}">
      <div class="followup-q">${esc(question)}</div>
      <div class="followup-a pending">Thinking…</div>
    </div>
  `);
  followupsEl.lastElementChild?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });

  try {
    let streamed = '';
    const data = await chatStream({ message: question, sessionId: studySessionId(topicId) }, null, chunk => {
      streamed += chunk;
      const a = followupsEl.querySelector(`[data-pending="${pendingIdx}"] .followup-a`);
      if (a) { a.classList.remove('pending'); a.textContent = streamed; }
    });
    if (!data.reply) throw new Error(data.error || 'No reply');
    const html = markdownToHtml(data.reply);
    followups.push({ q: question, a: html });
    saveExpl(topicId, { main: cached.main, followups });
    const a = followupsEl.querySelector(`[data-pending="${pendingIdx}"] .followup-a`);
    if (a) { a.classList.remove('pending'); a.innerHTML = html; }
  } catch {
    const a = followupsEl.querySelector(`[data-pending="${pendingIdx}"] .followup-a`);
    if (a) { a.classList.remove('pending'); a.textContent = 'Something went wrong — try again.'; }
  }

  input.value = '';
  input.disabled = false; sendBtn.disabled = false;
  qa('.chip-btn').forEach(b => b.disabled = false);
}

get('btn-followup-send').addEventListener('click', () => {
  const t = getActiveTab();
  const q = get('followup-input').value.trim();
  if (!t || t.isGuide || !q) return;
  sendFollowup(t.topicId, q);
});
get('followup-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') get('btn-followup-send').click();
});
qa('.chip-btn').forEach(btn => btn.addEventListener('click', () => {
  const t = getActiveTab();
  if (!t || t.isGuide) return;
  sendFollowup(t.topicId, btn.dataset.q);
}));

// Flashcards
async function loadFlashPanel(topicId) {
  const questions = await getJson(`/api/topics/${topicId}/questions`);
  flashQs = questions.filter(q => q.type === 'flashcard');
  if (!flashQs.length) flashQs = questions; // fall back to all

  if (!flashQs.length) {
    get('flash-card-scene').classList.add('hidden');
    get('flash-summary-wrap').classList.add('hidden');
    renderPanelGenChooser(get('flash-gen-empty'), {
      glyph: '🗂️',
      title: 'No flashcards yet',
      hint: 'Choose how to generate them:',
      idPrefix: 'flash-gen',
      onChoose: async (source, counts) => {
        await generateQuestions(topicId, 'flashcard', source, true, counts);
        get('flash-gen-empty').classList.add('hidden');
        await loadFlashPanel(topicId);
      }
    });
    return;
  }
  get('flash-gen-empty').classList.add('hidden');

  // Resume where the user left off, if we have a saved position for this deck.
  flashIdx = 0;
  try {
    const saved = await getJson(`/api/session-progress/${topicId}/flashcard`);
    if (saved && Number.isInteger(saved.currentIndex) && saved.currentIndex > 0 && saved.currentIndex < flashQs.length) {
      flashIdx = saved.currentIndex;
    }
  } catch {}

  await startStudySession(topicId, 'flashcard');
  renderFlashCard();
}

async function renderFlashCard() {
  // Re-entering a tab whose chooser was never resolved (switched away before
  // picking a generation source) — flashLoaded is already true, so this is
  // reached directly instead of loadFlashPanel(); re-run it to re-show the
  // chooser rather than mistaking an empty deck for a finished one below.
  if (!flashQs.length) { await loadFlashPanel(currentTopic.id); return; }
  if (flashIdx >= flashQs.length) {
    const topicId = currentTopic.id;
    const tab = getActiveTab();
    get('flash-card-scene').classList.add('hidden');
    const wrap = get('flash-summary-wrap');
    wrap.classList.remove('hidden');
    // Cache the summary the first time it's built so revisiting this tab
    // (mode switch away and back) re-renders the same result instead of
    // re-querying "last session" — which would otherwise now be this run.
    if (tab && tab.flashSummaryHtml != null) {
      wrap.innerHTML = tab.flashSummaryHtml;
    } else {
      const completedSessionId = activeStudySessionId;
      await endActiveStudySession();
      const html = await buildSessionSummaryHtml(topicId, 'flashcard', completedSessionId);
      if (tab) tab.flashSummaryHtml = html;
      wrap.innerHTML = html;
    }
    get('btn-summary-continue')?.addEventListener('click', () => {
      const tab = getActiveTab();
      if (tab) switchTabMode(tab, 'explain');
    });
    return;
  }
  get('flash-card-scene').classList.remove('hidden');
  get('flash-summary-wrap').classList.add('hidden');
  const q  = flashQs[flashIdx];
  const pct = Math.round((flashIdx / flashQs.length) * 100);
  get('flash-fill').style.width = pct + '%';
  get('flash-counter').textContent = `${flashIdx+1} / ${flashQs.length}`;
  get('flash-front').textContent   = q.question;
  get('flash-back').textContent    = q.answer;
  get('flashcard').classList.remove('flipped');
  questionShownAt = Date.now();
}

get('btn-reveal').addEventListener('click', () => get('flashcard').classList.add('flipped'));

// roadmap #15 — the flashcard panel had no exit control of its own; leaving
// mid-deck via the bottom nav left the session running in the background.
get('btn-flash-exit').addEventListener('click', () => exitStudyMode(activeTabId, 'flashcard'));

async function recordAndAdvanceFlash(correct) {
  const timeMs = questionShownAt ? Date.now() - questionShownAt : 0;
  const q = flashQs[flashIdx];
  await post('/api/record-attempt', { questionId: q.id, correct });
  recordSessionAnswer(correct, timeMs, q.question);
  flashIdx++;
  if (currentTopic) {
    if (flashIdx >= flashQs.length) {
      del(`/api/session-progress/${currentTopic.id}/flashcard`).catch(()=>{});
    } else {
      post('/api/session-progress', { topicId: currentTopic.id, mode: 'flashcard', currentIndex: flashIdx }).catch(()=>{});
    }
  }
  renderFlashCard();
}
get('btn-flash-right').addEventListener('click', () => recordAndAdvanceFlash(true));
get('btn-flash-wrong').addEventListener('click', () => recordAndAdvanceFlash(false));

// Quiz
async function loadQuizPanel(topicId) {
  const questions = await getJson(`/api/topics/${topicId}/questions`);
  quizQs = questions.filter(q => q.type === 'short' || q.type === 'mcq');
  if (!quizQs.length) quizQs = questions;

  if (!quizQs.length) {
    get('quiz-card').classList.add('hidden');
    get('quiz-summary-wrap').classList.add('hidden');
    renderPanelGenChooser(get('quiz-gen-empty'), {
      glyph: '❓',
      title: 'No quiz questions yet',
      hint: 'Choose how to generate them:',
      idPrefix: 'quiz-gen',
      onChoose: async (source, counts) => {
        await generateQuestions(topicId, 'quiz', source, true, counts);
        get('quiz-gen-empty').classList.add('hidden');
        await loadQuizPanel(topicId);
      }
    });
    return;
  }
  get('quiz-gen-empty').classList.add('hidden');

  // Resume where the user left off, if we have a saved position for this quiz.
  quizIdx = 0;
  try {
    const saved = await getJson(`/api/session-progress/${topicId}/quiz`);
    if (saved && Number.isInteger(saved.currentIndex) && saved.currentIndex > 0 && saved.currentIndex < quizQs.length) {
      quizIdx = saved.currentIndex;
    }
  } catch {}

  await startStudySession(topicId, 'quiz');
  freezeQuizClock(); // clears any leftover interval/segment before zeroing
  quizClockMs = 0; quizClockPaused = false; quizQuestionClockStart = 0;
  renderQuizQuestion();
}

async function renderQuizQuestion() {
  // Re-entering a tab whose chooser was never resolved (switched away before
  // picking a generation source) — quizLoaded is already true, so this is
  // reached directly instead of loadQuizPanel(); re-run it to re-show the
  // chooser rather than mistaking an empty set for a finished one below.
  if (!quizQs.length) { await loadQuizPanel(currentTopic.id); return; }
  const card = get('quiz-card');
  const wrap = get('quiz-summary-wrap');
  if (quizIdx >= quizQs.length) {
    const topicId = currentTopic.id;
    const tab = getActiveTab();
    freezeQuizClock();
    get('btn-quiz-pause').classList.add('hidden');
    card.classList.add('hidden');
    wrap.classList.remove('hidden');
    // Summary goes in its own wrapper, never into #quiz-card itself — quiz-card's
    // q-badge/q-text/q-options/q-feedback children are reused on every question
    // render, so overwriting quiz-card's innerHTML here would destroy them and
    // break every subsequent question render for the rest of this tab's life
    // (surfaced by invalidateTopicStudyState() forcing a real revisit reload).
    if (tab && tab.quizSummaryHtml != null) {
      wrap.innerHTML = tab.quizSummaryHtml;
    } else {
      const completedSessionId = activeStudySessionId;
      await endActiveStudySession();
      const html = await buildSessionSummaryHtml(topicId, 'quiz', completedSessionId);
      if (tab) tab.quizSummaryHtml = html;
      wrap.innerHTML = html;
    }
    get('btn-summary-continue')?.addEventListener('click', () => {
      const tab = getActiveTab();
      if (tab) switchTabMode(tab, 'explain');
    });
    return;
  }

  card.classList.remove('hidden');
  wrap.classList.add('hidden');
  get('btn-quiz-pause').classList.remove('hidden');
  const q   = quizQs[quizIdx];
  questionShownAt = Date.now();
  startQuizClockTicking();
  quizQuestionClockStart = quizClockElapsedMs();
  updateQuizPauseBtn();
  const pct = Math.round((quizIdx / quizQs.length) * 100);
  get('quiz-fill').style.width     = pct + '%';
  get('quiz-counter').textContent  = `${quizIdx+1} / ${quizQs.length}`;
  get('q-badge').textContent       = q.type.toUpperCase();
  get('q-text').textContent        = q.question;
  get('q-feedback').classList.add('hidden');
  get('q-open').classList.add('hidden');
  get('q-options').innerHTML       = '';
  get('q-answer').value            = '';
  const confirmBtn = get('btn-confirm-mcq');
  confirmBtn.classList.add('hidden');
  confirmBtn.disabled = true;

  if (q.type === 'mcq' && q.options) {
    // Picking an option only selects it — it doesn't grade or record
    // anything until Confirm is pressed, same barrier the short-answer
    // path already had via its own Submit button. A single misclick used
    // to lock in and count against stats with no way back.
    let selected = null;
    q.options.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'opt-btn';
      btn.textContent = opt;
      btn.addEventListener('click', () => {
        qa('.opt-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selected = btn;
        confirmBtn.disabled = false;
      });
      get('q-options').appendChild(btn);
    });
    confirmBtn.classList.remove('hidden');
    confirmBtn.onclick = () => { if (selected) handleMcq(q, selected.textContent, selected); };
  } else {
    get('q-open').classList.remove('hidden');
  }
}

async function handleMcq(q, chosen, btn) {
  const timeMs = quizClockElapsedMs() - quizQuestionClockStart;
  const confirmBtn = get('btn-confirm-mcq');
  confirmBtn.classList.add('hidden');
  confirmBtn.disabled = true;
  qa('.opt-btn').forEach(b => { b.disabled = true; b.classList.remove('selected'); });
  const correct = chosen.trim().toLowerCase() === q.answer.trim().toLowerCase();
  qa('.opt-btn').forEach(b => {
    if (b.textContent.trim().toLowerCase() === q.answer.trim().toLowerCase()) b.classList.add('correct');
  });
  if (!correct) btn.classList.add('wrong');
  await post('/api/record-attempt', { questionId: q.id, correct });
  recordSessionAnswer(correct, timeMs, q.question);
  showQuizFeedback(correct, q.answer);
}

get('btn-submit-answer').addEventListener('click', async () => {
  const answer = get('q-answer').value.trim();
  if (!answer) return;
  const timeMs = quizClockElapsedMs() - quizQuestionClockStart;
  const btn = get('btn-submit-answer');
  btn.disabled = true;
  const q = quizQs[quizIdx];

  try {
    // Isolated evaluation — no history, no tools, no bleed from other sessions
    const data = await postWithRetry('/api/evaluate', {
      question:      q.question,
      correctAnswer: q.answer,
      userAnswer:    answer
    });
    // Record the attempt directly (no LLM needed)
    await post('/api/record-attempt', { questionId: q.id, correct: data.correct });
    recordSessionAnswer(data.correct, timeMs, q.question);
    showQuizFeedback(data.correct, q.answer, data.feedback || '');
  } catch (err) {
    btn.disabled = false;
    showQuizFeedback(false, q.answer, 'Could not evaluate — check your connection and try again.');
  }
});

function showQuizFeedback(correct, correctAnswer, explanation='') {
  get('q-feedback').classList.remove('hidden');
  const verdict = get('q-verdict');
  verdict.textContent = correct ? '✓ Correct!' : '✗ Not quite';
  verdict.className   = 'q-verdict ' + (correct ? 'correct' : 'wrong');
  get('q-explanation').textContent = explanation || (correct ? '' : `Correct answer: ${correctAnswer}`);
}

get('btn-next-q').addEventListener('click', () => {
  quizIdx++;
  if (currentTopic) {
    if (quizIdx >= quizQs.length) {
      del(`/api/session-progress/${currentTopic.id}/quiz`).catch(()=>{});
    } else {
      post('/api/session-progress', { topicId: currentTopic.id, mode: 'quiz', currentIndex: quizIdx }).catch(()=>{});
    }
  }
  renderQuizQuestion();
});

// The quiz panel had no exit control of its own, same gap as flashcards
// (roadmap #15) — leaving mid-session only worked via the tab-close "×".
get('btn-quiz-exit').addEventListener('click', () => exitStudyMode(activeTabId, 'quiz'));

get('btn-quiz-pause').addEventListener('click', toggleQuizClockPause);

async function generateQuestions(topicId, type, source = 'hybrid', replace = true, counts = {}) {
  const mode = type === 'flashcard' ? 'flashcard' : 'quiz';
  // Local extraction + a small AI "hard" tier (roadmap #6) — bypasses the
  // chat agent loop entirely, so this no longer costs a full tool-use turn.
  // source: 'hybrid' (default) | 'local' (no API calls) | 'ai' (no local tier).
  // replace: true clears the existing set for this type first (regenerate);
  // false appends instead (Manage panel's "Add More"), keeping what's there.
  // counts: optional {aiCount, localCount} overrides — omitted/invalid ones
  // fall back to the server's own defaults for that source.
  const body = { mode, source, replace };
  if (Number.isInteger(counts.aiCount))    body.aiCount    = counts.aiCount;
  if (Number.isInteger(counts.localCount)) body.localCount = counts.localCount;
  await postWithRetry(`/api/topics/${topicId}/generate-questions`, body);
  // The question count changed either way, so any cached list/position is stale.
  del(`/api/session-progress/${topicId}/${mode}`).catch(()=>{});
  invalidateTopicStudyState(topicId);
}

// Generation used to fire silently the first time a topic had no questions
// for a mode — the user had no idea it was even happening, let alone that
// it costs an API call. This makes that moment explicit: three buttons for
// how to build the set, shown in the panel itself instead of auto-firing.
// Reused by both the quiz/flashcard panel empty-state and the Home wizard.
// Same pill (not primary/ghost) so none of the three looks "more chosen"
// than the others until the user actually picks one — brightens on click,
// same active/inactive pattern as the Replace/Add-more toggle right below it.
const GEN_SOURCES = [
  { source: 'ai',     label: '🤖 With AI' },
  { source: 'local',  label: '📖 Without AI' },
  { source: 'hybrid', label: '✨ Both' }
];

function genChooserButtonsHtml(idPrefix) {
  return GEN_SOURCES.map(({ source, label }) =>
    `<button class="pill gen-source-btn" id="${idPrefix}-${source}" data-source="${source}" aria-pressed="false">${label}</button>`
  ).join('');
}

// How many questions to pull from each source — AI and local extraction are
// separate generation mechanisms with independent costs, so they get
// independent counts instead of one shared number. Read by whichever
// gen-source button is clicked; omitted (null) counts fall back to the
// server's own defaults for that source.
const COUNT_MIN = 1;
const COUNT_MAX = 25;
const COUNT_DEFAULT = 10;

function countPickerHtml(idPrefix) {
  return `
    <div class="count-picker" role="group" aria-label="Number of questions per source">
      <label class="count-field">
        <span class="count-field-label">🤖 AI count</span>
        <input type="number" class="count-input" id="${idPrefix}-ai" min="${COUNT_MIN}" max="${COUNT_MAX}" value="${COUNT_DEFAULT}" inputmode="numeric"/>
      </label>
      <label class="count-field">
        <span class="count-field-label">📖 Local count</span>
        <input type="number" class="count-input" id="${idPrefix}-local" min="${COUNT_MIN}" max="${COUNT_MAX}" value="${COUNT_DEFAULT}" inputmode="numeric"/>
      </label>
    </div>`;
}

function readCount(id) {
  const el = get(id);
  if (!el) return null;
  const n = parseInt(el.value, 10);
  return Number.isInteger(n) && n >= COUNT_MIN && n <= COUNT_MAX ? n : null;
}

function countsFromInputs(idPrefix) {
  return { aiCount: readCount(`${idPrefix}-ai`), localCount: readCount(`${idPrefix}-local`) };
}

function renderPanelGenChooser(containerEl, { glyph, title, hint, idPrefix, onChoose }) {
  const countPrefix = `${idPrefix}-count`;
  containerEl.classList.remove('hidden');
  containerEl.innerHTML = `
    <div class="empty-glyph">${glyph}</div>
    <p class="empty-title">${esc(title)}</p>
    <p class="hint">${esc(hint)}</p>
    ${countPickerHtml(countPrefix)}
    <div class="empty-tab-actions">${genChooserButtonsHtml(idPrefix)}</div>
    <button class="primary-btn gen-confirm-btn" id="${idPrefix}-confirm" disabled>Generate</button>
    <p class="gen-error status-line err hidden" role="alert"></p>`;

  // Picking a source only selects it (brightens it, dims the other two) — it
  // doesn't fire the API call. Generate is a separate, deliberate step, so a
  // stray click near the count inputs can't kick off a generation nobody asked for.
  let selected = null;
  const sourceBtns = containerEl.querySelectorAll('.gen-source-btn');
  const confirmBtn = containerEl.querySelector('.gen-confirm-btn');
  sourceBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      sourceBtns.forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      selected = btn.dataset.source;
      confirmBtn.disabled = false;
    });
  });

  confirmBtn.addEventListener('click', async () => {
    if (!selected) return;
    sourceBtns.forEach(b => b.disabled = true);
    confirmBtn.disabled = true;
    const errEl = containerEl.querySelector('.gen-error');
    errEl.classList.add('hidden');
    const original = confirmBtn.textContent;
    confirmBtn.textContent = 'Generating…';
    try {
      await onChoose(selected, countsFromInputs(countPrefix));
    } catch (err) {
      errEl.textContent = err.message || 'Generation failed — try again.';
      errEl.classList.remove('hidden');
      sourceBtns.forEach(b => b.disabled = false);
      confirmBtn.disabled = false;
      confirmBtn.textContent = original;
    }
  });
}

// Manage panel's "Generate Questions" section — the only way to re-run
// generation for a topic that already has flashcards/quiz questions (the
// panel chooser above only ever fires on an empty set). Replace mode
// confirms first since it replaces the whole set for that type, manually-
// added questions included (deleteQuestionsByType() in db/sqlite.js);
// Add More is non-destructive — it just tops the set up — so it doesn't.
const REGEN_HINTS = {
  replace: 'Replaces all existing flashcards or quiz questions for this topic — including any added manually.',
  append:  'Adds new flashcards or quiz questions on top of what’s already there — nothing existing is touched.'
};

function renderRegenControls(topicId) {
  const rows = [
    { mode: 'flashcard', label: 'Flashcards', noun: 'flashcards',      el: get('regen-flashcard'), prefix: 'regen-fc' },
    { mode: 'quiz',      label: 'Quiz',       noun: 'quiz questions',  el: get('regen-quiz'),      prefix: 'regen-qz' }
  ];
  const status = get('regen-status');
  const hint = get('regen-hint');
  const toggle = get('regen-mode-toggle');

  let replaceMode = true;
  toggle.querySelectorAll('.pill').forEach(p => {
    const active = p.dataset.val === 'replace';
    p.classList.toggle('active', active);
    p.setAttribute('aria-pressed', String(active));
  });
  hint.textContent = REGEN_HINTS.replace;
  toggle.querySelectorAll('.pill').forEach(p => {
    p.onclick = () => {
      toggle.querySelectorAll('.pill').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
      p.classList.add('active');
      p.setAttribute('aria-pressed', 'true');
      replaceMode = p.dataset.val === 'replace';
      hint.textContent = REGEN_HINTS[p.dataset.val];
    };
  });

  rows.forEach(({ mode, label, noun, el, prefix }) => {
    // Same select-then-confirm barrier as the empty-state chooser — picking
    // a source here only selects it; Generate is the deliberate step that
    // actually spends an API call (or replaces an existing set).
    el.innerHTML = genChooserButtonsHtml(prefix) +
      `<button class="primary-btn gen-confirm-btn" id="${prefix}-confirm" style="width:auto;margin-top:0" disabled>Generate ${esc(label)}</button>`;
    const sourceBtns = el.querySelectorAll('.gen-source-btn');
    const confirmBtn = el.querySelector('.gen-confirm-btn');
    let selected = null;

    sourceBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        sourceBtns.forEach(b => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-pressed', String(b === btn));
        });
        selected = btn.dataset.source;
        confirmBtn.disabled = false;
      });
    });

    confirmBtn.addEventListener('click', async () => {
      if (!selected) return;
      const sourceLabel = (GEN_SOURCES.find(g => g.source === selected)?.label || selected)
        .replace(/^\S+\s/, ''); // drop the emoji for use inside a sentence
      if (replaceMode && !confirm(`Regenerate ${label} using ${sourceLabel}? This replaces all existing ${noun} for this topic — including any added manually.`)) {
        return;
      }
      const allBtns = [
        ...get('regen-flashcard').querySelectorAll('.gen-source-btn, .gen-confirm-btn'),
        ...get('regen-quiz').querySelectorAll('.gen-source-btn, .gen-confirm-btn')
      ];
      allBtns.forEach(b => b.disabled = true);
      status.className = 'status-line';
      status.textContent = `${replaceMode ? 'Regenerating' : 'Adding'} ${label.toLowerCase()}…`;
      try {
        await generateQuestions(topicId, mode, selected, replaceMode, countsFromInputs('regen-count'));
        status.textContent = `${label} ${replaceMode ? 'regenerated' : 'added'}.`;
        renderManageQuestions(topicId);
        refreshLiveStudyPanel(topicId);
      } catch (err) {
        status.className = 'status-line err';
        status.textContent = err.message || `${replaceMode ? 'Regeneration' : 'Generation'} failed — try again.`;
      } finally {
        allBtns.forEach(b => b.disabled = false);
      }
    });
  });
}

// ── MANAGE TOPIC PANEL (edit topic details + manual question CRUD) ──────────

function closeManagePanelUI() {
  get('topic-manage-panel').classList.add('hidden');
  get('btn-manage-topic').setAttribute('aria-expanded', 'false');
  get('btn-manage-topic').focus();
}

get('btn-manage-topic').addEventListener('click', () => {
  if (!currentTopic) return;
  const panel = get('topic-manage-panel');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  get('btn-manage-topic').setAttribute('aria-expanded', String(opening));
  if (opening) {
    openManagePanel(currentTopic.id);
    get('btn-manage-close').focus();
  }
});
get('btn-manage-close').addEventListener('click', closeManagePanelUI);
// Escape closes the panel from anywhere inside it, same as the ✕ button.
get('topic-manage-panel').addEventListener('keydown', e => {
  if (e.key === 'Escape') closeManagePanelUI();
});

async function openManagePanel(topicId) {
  get('mt-details-status').textContent = '';
  get('mt-details-status').className = 'status-line';
  const topic = await getJson(`/api/topics/${topicId}`);
  get('mt-name').value    = topic.name || '';
  get('mt-content').value = topic.content || '';
  get('mt-add-question-form').classList.add('hidden');
  renderManageQuestions(topicId);
  renderRegenControls(topicId);
}

get('mt-cancel-details').addEventListener('click', () => {
  if (currentTopic) openManagePanel(currentTopic.id);
});

get('mt-save-details').addEventListener('click', async () => {
  if (!currentTopic) return;
  const name    = get('mt-name').value.trim();
  const content = get('mt-content').value.trim();
  const status  = get('mt-details-status');
  if (!name) { status.textContent = 'Name is required.'; status.className = 'status-line err'; return; }

  try {
    const updated = await patchReq(`/api/topics/${currentTopic.id}`, { name, content });

    currentTopic.name = updated.name;
    const activeTab = getActiveTab();
    if (activeTab) { activeTab.topicName = updated.name; renderStudyTabsBar(); }
    get('study-topic-name').textContent = updated.name;
    allTopics = []; // force library to re-fetch with the new name
    status.textContent = 'Saved.';
    status.className = 'status-line ok';
  } catch {
    status.textContent = 'Could not save — try again.';
    status.className = 'status-line err';
  }
});

// ── Question list ─────────────────────────────────────────────────────────────
async function renderManageQuestions(topicId) {
  const list = get('mt-questions-list');
  list.innerHTML = '<p class="mt-q-empty">Loading…</p>';
  const questions = await getJson(`/api/topics/${topicId}/questions`);

  if (!questions.length) {
    list.innerHTML = '<p class="mt-q-empty">No questions yet — add one below.</p>';
    return;
  }

  list.innerHTML = '';
  questions.forEach(q => list.appendChild(renderQuestionRow(q, topicId)));
}

// Manage panel question list — lets you see at a glance whether a question
// was AI-written, locally pattern-extracted, or typed in by hand, since
// they read very differently (AI/local also cost differently to redo).
const ORIGIN_BADGES = {
  ai:     { label: '🤖 AI',          cls: 'origin-ai' },
  local:  { label: '📖 Algorithmic', cls: 'origin-local' },
  manual: { label: '✎ Manual',       cls: 'origin-manual' }
};
function originBadgeHtml(origin) {
  const b = ORIGIN_BADGES[origin];
  return b
    ? `<span class="mt-q-origin-badge ${b.cls}">${b.label}</span>`
    : `<span class="mt-q-origin-badge origin-unknown">Unknown source</span>`;
}

function renderQuestionRow(q, topicId) {
  const row = document.createElement('div');
  row.className = 'mt-q-row';
  row.dataset.id = q.id;

  function renderView() {
    row.innerHTML = `
      <div class="mt-q-row-top">
        <span class="mt-q-type-badge">${esc(q.type)}</span>
        ${originBadgeHtml(q.origin)}
        <span class="mt-q-text">${esc(q.question)}</span>
      </div>
      <div class="mt-q-answer">${esc(q.answer)}${q.options ? ' · Options: ' + esc(q.options.join(', ')) : ''}</div>
      <div class="mt-q-row-actions">
        <button class="mt-q-edit">Edit</button>
        <button class="mt-q-delete">Delete</button>
      </div>`;
    row.querySelector('.mt-q-edit').addEventListener('click', renderEdit);
    row.querySelector('.mt-q-delete').addEventListener('click', async () => {
      if (!confirm('Delete this question?')) return;
      await del(`/api/questions/${q.id}`);
      row.remove();
      const list = get('mt-questions-list');
      if (!list.children.length) list.innerHTML = '<p class="mt-q-empty">No questions yet — add one below.</p>';
      // Reset any in-progress quiz/flashcard runtime state — question set changed.
      del(`/api/session-progress/${topicId}/quiz`).catch(()=>{});
      del(`/api/session-progress/${topicId}/flashcard`).catch(()=>{});
      invalidateTopicStudyState(topicId);
      refreshLiveStudyPanel(topicId);
    });
  }

  function renderEdit() {
    row.innerHTML = `
      <div class="mt-q-edit-form">
        <select class="mt-q-edit-type">
          <option value="short"${q.type==='short'?' selected':''}>Short answer</option>
          <option value="mcq"${q.type==='mcq'?' selected':''}>Multiple choice</option>
          <option value="flashcard"${q.type==='flashcard'?' selected':''}>Flashcard</option>
        </select>
        <textarea class="mt-q-edit-question" rows="2">${esc(q.question)}</textarea>
        <textarea class="mt-q-edit-answer" rows="2">${esc(q.answer)}</textarea>
        <input type="text" class="mt-q-edit-options" placeholder="MCQ options, comma-separated" value="${esc((q.options||[]).join(', '))}"/>
        <div class="manage-actions">
          <button class="ghost-btn mt-q-edit-cancel" style="width:auto">Cancel</button>
          <button class="primary-btn mt-q-edit-save" style="width:auto;margin-top:0">Save</button>
        </div>
      </div>`;
    row.querySelector('.mt-q-edit-cancel').addEventListener('click', renderView);
    row.querySelector('.mt-q-edit-save').addEventListener('click', async () => {
      const type     = row.querySelector('.mt-q-edit-type').value;
      const question = row.querySelector('.mt-q-edit-question').value.trim();
      const answer   = row.querySelector('.mt-q-edit-answer').value.trim();
      const optsRaw  = row.querySelector('.mt-q-edit-options').value.trim();
      const options  = type === 'mcq' && optsRaw ? optsRaw.split(',').map(s => s.trim()).filter(Boolean) : null;
      if (!question || !answer) return;

      const updated = await patchReq(`/api/questions/${q.id}`, { question, answer, type, options });

      Object.assign(q, updated);
      del(`/api/session-progress/${topicId}/quiz`).catch(()=>{});
      del(`/api/session-progress/${topicId}/flashcard`).catch(()=>{});
      invalidateTopicStudyState(topicId);
      refreshLiveStudyPanel(topicId);
      renderView();
    });
  }

  renderView();
  return row;
}

// ── Add question form ─────────────────────────────────────────────────────────
get('mt-add-question-toggle').addEventListener('click', () => {
  const form = get('mt-add-question-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) {
    get('mt-q-question').value = '';
    get('mt-q-answer').value   = '';
    get('mt-q-options').value  = '';
    get('mt-q-type').value     = 'short';
  }
});
get('mt-q-cancel').addEventListener('click', () => get('mt-add-question-form').classList.add('hidden'));

get('mt-q-save').addEventListener('click', async () => {
  if (!currentTopic) return;
  const type     = get('mt-q-type').value;
  const question = get('mt-q-question').value.trim();
  const answer   = get('mt-q-answer').value.trim();
  const optsRaw  = get('mt-q-options').value.trim();
  const options  = type === 'mcq' && optsRaw ? optsRaw.split(',').map(s => s.trim()).filter(Boolean) : null;

  if (!question || !answer) { alert('Question and answer are required.'); return; }
  if (type === 'mcq' && (!options || options.length < 2)) { alert('Add at least two comma-separated options for a multiple-choice question.'); return; }

  await post(`/api/topics/${currentTopic.id}/questions`, { question, answer, type, options });

  del(`/api/session-progress/${currentTopic.id}/quiz`).catch(()=>{});
  del(`/api/session-progress/${currentTopic.id}/flashcard`).catch(()=>{});
  invalidateTopicStudyState(currentTopic.id);
  refreshLiveStudyPanel(currentTopic.id);

  get('mt-add-question-form').classList.add('hidden');
  renderManageQuestions(currentTopic.id);
});

