// ── HOME / WIZARD ─────────────────────────────────────────────────────────────
//
// Front page is a single "+ Create New Topic" action. The wizard then makes
// the source decision explicit as its own first step (Upload Data / Use AI)
// instead of burying it behind a "Skip" button — the two paths share the
// name/modes/setup steps that follow but differ on whether a material step
// comes first, hence the step *lists* below rather than a fixed step count.
let wizardPath = null; // 'upload' | 'ai'
const WIZARD_STEPS = {
  upload: ['wz-source', 'wz-material', 'wz-name', 'wz-modes', 'wz-setup'],
  ai:     ['wz-source', 'wz-name', 'wz-modes', 'wz-setup']
};
function currentWizardSteps() { return WIZARD_STEPS[wizardPath] || WIZARD_STEPS.upload; }

get('btn-create-topic').addEventListener('click', () => {
  wizardData = { topic:'', material:'', materialSource:'none' };
  wizardPath = null;
  selectedModes.clear();
  get('pills-gen-source').querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p.dataset.val === 'hybrid'));
  get('setup-gen-source').classList.add('hidden');
  uploadedFile = null;
  uploadedFileText = null;
  materialType = 'paste'; // matches the tab that's active by default
  get('file-review').classList.add('hidden');
  get('file-label').textContent = 'Drop a PDF, Word (.docx), PowerPoint (.pptx) or .txt — or tap to browse';
  get('file-drop').classList.remove('has-file');
  get('paste-area').value = '';
  get('paste-count').textContent = '';
  get('url-input').value = '';
  get('search-input').value = '';
  get('wz-name-input').value = '';
  qa('#wz-source .mode-card').forEach(c => c.classList.remove('selected'));

  get('landing').classList.add('hidden');
  get('wizard').classList.remove('hidden');
  get('wz-topic-chip').textContent = 'New Topic';
  gotoWzStep(0);
});

// Back button
get('wz-back').addEventListener('click', () => {
  if (wizardStep === 0) { resetToLanding(); return; }
  gotoWzStep(wizardStep - 1);
});

function resetToLanding() {
  get('wizard').classList.add('hidden');
  get('landing').classList.remove('hidden');
}

function renderWzDots(n, activeIdx) {
  const dotsEl = get('wz-dots');
  dotsEl.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const d = document.createElement('span');
    d.className = 'wz-dot' + (i === activeIdx ? ' active' : '');
    dotsEl.appendChild(d);
  }
}

function gotoWzStep(n) {
  const steps = currentWizardSteps();
  qa('.wz-step').forEach(s => s.classList.remove('active'));
  get(steps[n]).classList.add('active');
  wizardStep = n;
  renderWzDots(steps.length, n);
  get('wz-back').style.visibility = 'visible';
}

// Step – Source (Upload Data / Use AI)
qa('#wz-source .mode-card').forEach(card => {
  card.addEventListener('click', () => {
    wizardPath = card.dataset.path;
    if (wizardPath === 'ai') {
      wizardData.material = '';
      wizardData.materialSource = 'none';
      get('wz-name-title').textContent = 'What do you want to study?';
      get('wz-name-sub').textContent = 'AI will build explanations and questions from its own knowledge.';
      get('wz-name-input').placeholder = 'e.g. Photosynthesis, World War I, Python decorators…';
    } else {
      get('wz-name-title').textContent = 'Name your topic';
      get('wz-name-sub').textContent = '';
      get('wz-name-input').placeholder = 'e.g. Lecture 4 — Cellular Respiration';
    }
    gotoWzStep(1);
  });
});

// Source tabs
qa('.src-tab').forEach(tab => tab.addEventListener('click', () => {
  qa('.src-tab').forEach(t => t.classList.remove('active'));
  qa('.src-panel').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');
  materialType = tab.dataset.src;
  get(`src-${materialType}`).classList.add('active');
}));

// File input — extract immediately so the user can review/trim before continuing
let uploadedFileText = null;

get('file-input').addEventListener('change', async () => {
  uploadedFile = get('file-input').files[0];
  uploadedFileText = null;
  get('file-review').classList.add('hidden');
  if (!uploadedFile) return;

  get('file-label').textContent = `📄 ${uploadedFile.name} — extracting…`;
  get('file-drop').classList.add('has-file');

  const fd = new FormData();
  fd.append('file', uploadedFile);
  let data;
  try { data = await fetch('/api/upload', { method: 'POST', body: fd }).then(toResultOrThrow); }
  catch (err) { data = { error: err.message || 'Upload failed — check your connection and try again.' }; }

  if (data.error) {
    get('file-label').textContent = `⚠ ${data.error}`;
    get('file-drop').classList.remove('has-file');
    uploadedFile = null;
    return;
  }

  get('file-label').textContent = `📄 ${uploadedFile.name} — ${fmtCount(data.fullLength)} characters extracted`;
  uploadedFileText = data.content;
  showMaterialReview({
    text: data.content, fullLength: data.fullLength, hardCapped: data.hardCapped,
    noteEl: get('file-review-note'), textEl: get('file-review-text'),
    countEl: get('file-review-count'), trimWrapEl: get('file-review-trim'),
    reviewEl: get('file-review'),
    startBtn: get('btn-trim-start'), endBtn: get('btn-trim-end'), allBtn: get('btn-trim-all')
  });
});

// Shared logic for the "extracted material is long — review/trim it" panel.
function showMaterialReview({ text, fullLength, hardCapped, noteEl, textEl, countEl, trimWrapEl, reviewEl, startBtn, endBtn, allBtn }) {
  reviewEl.classList.remove('hidden');
  const long = fullLength > MATERIAL_SOFT_LIMIT;

  textEl.value = long ? text.slice(0, MATERIAL_SOFT_LIMIT) : text;

  noteEl.className = 'material-review-note' + (long ? ' warn' : '');
  noteEl.textContent = hardCapped
    ? `⚠ This file is very large — only the first ${fmtCount(fullLength)} characters could be extracted for review.`
    : long
      ? `This file has ${fmtCount(fullLength)} characters — more than the recommended ${fmtCount(MATERIAL_SOFT_LIMIT)}. Showing the first ${fmtCount(MATERIAL_SOFT_LIMIT)} below — edit freely, or use a quick trim option.`
      : `${fmtCount(fullLength)} characters extracted — ready to use.`;

  trimWrapEl.classList.toggle('hidden', !long);
  updateMaterialCount(textEl, countEl);

  textEl.oninput = () => updateMaterialCount(textEl, countEl);
  startBtn.onclick = () => { textEl.value = text.slice(0, MATERIAL_SOFT_LIMIT); updateMaterialCount(textEl, countEl); };
  endBtn.onclick   = () => { textEl.value = text.slice(-MATERIAL_SOFT_LIMIT); updateMaterialCount(textEl, countEl); };
  allBtn.onclick   = () => { textEl.value = text; updateMaterialCount(textEl, countEl); };
}

function updateMaterialCount(textEl, countEl) {
  const n = textEl.value.length;
  countEl.textContent = `${fmtCount(n)} characters`;
  countEl.classList.toggle('warn', n > MATERIAL_SOFT_LIMIT);
}

// Live counter on the paste textarea too — no more silent slicing, just visibility.
get('paste-area').addEventListener('input', () => updateMaterialCount(get('paste-area'), get('paste-count')));

// Step – Material → Name
get('btn-wz-material-next').addEventListener('click', async () => {
  const nameIdx = currentWizardSteps().indexOf('wz-name');
  if (materialType === 'paste') {
    wizardData.material = get('paste-area').value.trim();
    wizardData.materialSource = 'paste';
  } else if (materialType === 'url') {
    wizardData.material = get('url-input').value.trim();
    wizardData.materialSource = 'url';
  } else if (materialType === 'search') {
    const query = get('search-input').value.trim();
    if (!query) { alert('Enter something to search for, or switch to Paste/URL/File.'); return; }
    wizardData.material = query;
    wizardData.materialSource = 'search';
  } else if (materialType === 'file') {
    if (!uploadedFileText) { alert('Choose a file to upload, or switch to Paste/URL.'); return; }
    wizardData.material = get('file-review-text').value.trim();
    wizardData.materialSource = 'file';
    wizardData.materialFilename = uploadedFile ? uploadedFile.name : '';
  }
  gotoWzStep(nameIdx);
});

// Step – Name → Modes
get('btn-wz-name-next').addEventListener('click', () => {
  const name = get('wz-name-input').value.trim();
  if (!name) { get('wz-name-input').focus(); return; }
  wizardData.topic = name;
  get('wz-topic-chip').textContent = name;
  gotoWzStep(currentWizardSteps().indexOf('wz-modes'));
});

// Step – modes (scoped to #wz-modes — #wz-source also uses .mode-card for
// the Upload Data / Use AI choice, which has its own click handler above)
qa('#wz-modes .mode-card').forEach(card => card.addEventListener('click', () => {
  card.classList.toggle('selected');
  const m = card.dataset.mode;
  selectedModes.has(m) ? selectedModes.delete(m) : selectedModes.add(m);
}));
get('btn-wz-modes-next').addEventListener('click', () => {
  if (!selectedModes.size) { alert('Select at least one study mode.'); return; }
  // Generation source only matters for modes that actually generate
  // questions — hidden entirely for an Explanations-only session.
  const needsGenChoice = selectedModes.has('quiz') || selectedModes.has('flashcard');
  get('setup-gen-source').classList.toggle('hidden', !needsGenChoice);
  gotoWzStep(currentWizardSteps().indexOf('wz-setup'));
});

// Step 2 – question generation source pills (roadmap follow-up — made the
// AI/local/hybrid choice explicit instead of always silently using hybrid)
get('pills-gen-source').querySelectorAll('.pill').forEach(p => {
  p.addEventListener('click', () => {
    get('pills-gen-source').querySelectorAll('.pill').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
    p.classList.add('active');
    p.setAttribute('aria-pressed', 'true');
  });
});

// Step 2 – level pills
let levelSkipped = false;
get('pills-level').querySelectorAll('.pill').forEach(p => {
  p.addEventListener('click', () => {
    levelSkipped = false;
    get('pills-level').querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
    p.classList.add('active');
    get('level-skipped').classList.add('hidden');
    get('pills-level').style.opacity = '1';
  });
});
get('btn-skip-level').addEventListener('click', () => {
  levelSkipped = true;
  get('pills-level').querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
  get('pills-level').style.opacity = '.35';
  get('level-skipped').classList.remove('hidden');
});

// Step 2 – time input (hours / minutes as two native number fields).
// Previously a single free-text field with custom keydown handling to fill
// digits right-to-left — that broke inconsistently on mobile browsers
// (especially iOS Safari) because virtual keyboards don't fire keydown the
// same way a physical one does. Two native <input type="number"> fields let
// the OS handle entry, backspace, and the numeric keypad itself.
let timeSkipped = false;
const hoursInput   = get('time-hours');
const minutesInput = get('time-minutes');

function clampTimeField(input, max) {
  let digits = input.value.replace(/\D/g, '').slice(0, 2);
  if (digits !== '') {
    const n = Math.min(parseInt(digits, 10), max);
    digits = String(n);
  }
  input.value = digits;
}

hoursInput.addEventListener('input', () => { clampTimeField(hoursInput, 23); resetTimeSkippedIfNeeded(); });
minutesInput.addEventListener('input', () => { clampTimeField(minutesInput, 59); resetTimeSkippedIfNeeded(); });

function resetTimeSkippedIfNeeded() {
  if (!timeSkipped) return;
  timeSkipped = false;
  hoursInput.classList.remove('skipped');
  minutesInput.classList.remove('skipped');
  get('time-skipped').classList.add('hidden');
  get('time-input-wrap').style.opacity = '1';
}

get('btn-skip-time').addEventListener('click', () => {
  timeSkipped = true;
  hoursInput.value = '';
  minutesInput.value = '';
  hoursInput.classList.add('skipped');
  minutesInput.classList.add('skipped');
  get('time-skipped').classList.remove('hidden');
  get('time-input-wrap').style.opacity = '.35';
});
[hoursInput, minutesInput].forEach(input => input.addEventListener('focus', resetTimeSkippedIfNeeded));

function parseTime() {
  if (timeSkipped) return null;
  const h = parseInt(hoursInput.value, 10) || 0;
  const m = parseInt(minutesInput.value, 10) || 0;
  if (!h && !m) return null;
  return h * 60 + m;
}

// Begin!
let sessionAbortController = null;

get('btn-begin').addEventListener('click', async () => {
  const level = levelSkipped ? null
    : (get('pills-level').querySelector('.pill.active')?.dataset.val || 'intermediate');
  const totalMins = parseTime();
  wizardData.level     = level;
  wizardData.timeLimit = totalMins;
  wizardData.modes     = [...selectedModes];
  wizardData.genSource = get('pills-gen-source').querySelector('.pill.active')?.dataset.val || 'hybrid';
  wizardData.genCounts = countsFromInputs('wz-count');
  await runWizardSession();
});

// Cancel session
get('btn-cancel-session').addEventListener('click', () => {
  if (sessionAbortController) sessionAbortController.abort();
  resetToLanding();
});

function wizardGenBody(mode) {
  const body = { mode, source: wizardData.genSource || 'hybrid' };
  const counts = wizardData.genCounts || {};
  if (Number.isInteger(counts.aiCount))    body.aiCount    = counts.aiCount;
  if (Number.isInteger(counts.localCount)) body.localCount = counts.localCount;
  return body;
}

async function runWizardSession() {
  qa('.wz-step').forEach(s => s.classList.remove('active'));
  get('wz-loading').classList.add('active');
  get('wz-back').style.visibility = 'hidden';

  const checks = get('loading-checks');
  const msg    = get('loading-msg');
  checks.innerHTML = '';

  function addCheck(label) {
    const el = document.createElement('div');
    el.className = 'lcheck';
    el.innerHTML = `<span class="lcheck-icon">○</span><span>${label}</span>`;
    checks.appendChild(el);
    return el;
  }
  function doneCheck(el) {
    el.classList.add('done');
    el.querySelector('.lcheck-icon').textContent = '✓';
  }

  const modesArr   = [...selectedModes];
  const levelLabel = wizardData.level || 'unspecified';
  const totalMins  = wizardData.timeLimit;
  const timeLabel  = totalMins == null ? 'unspecified'
    : totalMins === 0 ? 'no limit'
    : `${Math.floor(totalMins / 60)}h ${totalMins % 60}m`.replace(/^0h /, '');

  sessionAbortController = new AbortController();
  const { signal }  = sessionAbortController;
  wizardSessionId   = `wizard-${Date.now()}`; // unique ID — no bleed from other sessions
  const cancelBtn   = get('btn-cancel-session');
  cancelBtn.textContent = '✕ Cancel';
  cancelBtn.classList.remove('visible');
  const cancelTimer = setTimeout(() => cancelBtn.classList.add('visible'), 3000);

  try {
    // ── Step 1: Save topic ────────────────────────────────────────────────
    // Saved directly via /api/topics (roadmap #10) rather than asking the
    // chat agent to echo the material back into a save_topic tool call —
    // that path silently truncated anything past ~8,000 characters. Using
    // the id this call returns (instead of re-fetching and grabbing
    // topics[0]) also fixes roadmap #11, where a stale or unrelated topic
    // could get picked up as "the one just created".
    const savingLabel = wizardData.materialSource === 'search' ? 'Searching the web…' : 'Saving topic…';
    const c1 = addCheck(savingLabel);
    msg.textContent = savingLabel;

    const scrapedServerSide = wizardData.materialSource === 'url' || wizardData.materialSource === 'search';
    const topic = await postWithRetry('/api/topics', {
      name:      wizardData.topic,
      content:   scrapedServerSide ? '' : wizardData.material,
      source:    wizardData.materialSource || 'none',
      sourceRef: scrapedServerSide ? wizardData.material : ''
    }, signal);
    if (!topic || !topic.id) throw new Error('Topic was not saved. Check your API key and try again.');
    doneCheck(c1);

    // ── Step 2: Explanation ───────────────────────────────────────────────
    if (modesArr.includes('explain')) {
      const c2 = addCheck('Generating explanation…');
      msg.textContent = 'Generating explanation…';
      const explData = await chatStream({
        message: `Generate a detailed explanation for topic ID "${topic.id}" ("${topic.name}") at ${levelLabel} level. Time available: ${timeLabel}. Call get_topic first to read the saved material, then write a structured markdown explanation with these ## sections: Overview, Key Concepts, Examples, Common Misconceptions.`,
        sessionId: wizardSessionId
      }, signal);
      if (explData.reply) await saveExpl(topic.id, { main: markdownToHtml(explData.reply), followups: [] });
      doneCheck(c2);
    }

    // ── Step 3: Quiz questions ────────────────────────────────────────────
    // Local extraction + a small AI "hard" tier (roadmap #6) — no chat/tool
    // round-trip needed for the bulk of these.
    if (modesArr.includes('quiz')) {
      const c3 = addCheck('Writing quiz questions…');
      msg.textContent = 'Writing quiz questions…';
      await postWithRetry(`/api/topics/${topic.id}/generate-questions`, wizardGenBody('quiz'), signal);
      doneCheck(c3);
    }

    // ── Step 4: Flashcards ────────────────────────────────────────────────
    if (modesArr.includes('flashcard')) {
      const c4 = addCheck('Creating flashcards…');
      msg.textContent = 'Creating flashcards…';
      await postWithRetry(`/api/topics/${topic.id}/generate-questions`, wizardGenBody('flashcard'), signal);
      doneCheck(c4);
    }

    clearTimeout(cancelTimer);
    cancelBtn.classList.remove('visible');
    msg.textContent = 'Ready!';
    await new Promise(r => setTimeout(r, 500));

    const session = { modes: modesArr, level: wizardData.level, timeLimit: wizardData.timeLimit };
    saveSession(topic.id, session);
    resetToLanding();
    get('wz-name-input').value = '';
    hoursInput.value = '';
    minutesInput.value = '';
    fillEmptyTabOrOpenNew(topic, session);

  } catch (err) {
    clearTimeout(cancelTimer);
    cancelBtn.classList.add('visible');
    if (err.name === 'AbortError') {
      resetToLanding();
    } else {
      msg.textContent = '⚠ ' + (err.message || 'Connection error. Check your network and API key.');
    }
  }
}

