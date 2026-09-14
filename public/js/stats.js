// ── Stats view ────────────────────────────────────────────────────────────────
let statsChart = null;
let statsTopicFilterPopulated = false;

function fmtDuration(totalMs) {
  const totalMin = Math.round(totalMs / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
function fmtAvgTime(ms) {
  if (ms == null) return '–';
  return ms >= 1000 ? `${(ms/1000).toFixed(1)}s` : `${ms}ms`;
}

async function populateStatsTopicFilter() {
  const sel = get('stats-topic-filter');
  const topics = await getJson('/api/topics').catch(()=>[]);
  const current = sel.value;
  sel.innerHTML = '<option value="">All topics</option>' +
    topics.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  sel.value = current || '';
  statsTopicFilterPopulated = true;
}

async function renderStats() {
  if (!statsTopicFilterPopulated) await populateStatsTopicFilter();
  const topicId = get('stats-topic-filter').value || '';

  const [summary, sessions] = await Promise.all([
    getJson('/api/sessions/summary'),
    getJson(`/api/sessions?limit=30${topicId ? `&topicId=${encodeURIComponent(topicId)}` : ''}`)
  ]);

  get('stat-accuracy').textContent = summary.overallAccuracy != null ? summary.overallAccuracy + '%' : '–';
  get('stat-streak').textContent   = summary.streak ? `${summary.streak} day${summary.streak===1?'':'s'}` : '0 days';
  get('stat-week').textContent     = summary.sessionsThisWeek ?? 0;
  get('stat-time').textContent     = summary.totalTimeMs ? fmtDuration(summary.totalTimeMs) : '0m';

  const rows = get('stats-session-rows');
  const empty = get('stats-empty');
  const chartWrap = document.querySelector('.stats-chart-wrap');

  if (!sessions.length) {
    rows.innerHTML = '';
    empty.classList.remove('hidden');
    chartWrap.classList.add('hidden');
    if (statsChart) { statsChart.destroy(); statsChart = null; }
    return;
  }
  empty.classList.add('hidden');
  chartWrap.classList.remove('hidden');

  rows.innerHTML = sessions.map(s => `
    <tr>
      <td>${new Date(s.startedAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</td>
      <td>${esc(s.topicName)}</td>
      <td>${s.mode === 'quiz' ? 'Quiz' : 'Flashcard'}</td>
      <td>${s.accuracy != null ? s.accuracy + '%' : '–'}</td>
      <td>${fmtAvgTime(s.avgTimeMs)}</td>
      <td><button class="stats-delete-btn" data-session-id="${s.id}" title="Delete session" aria-label="Delete session">🗑</button></td>
    </tr>
  `).join('');

  rows.querySelectorAll('.stats-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this session? This only removes it from your stats — the topic and its questions are untouched.')) return;
      btn.disabled = true;
      try {
        await del(`/api/sessions/${btn.dataset.sessionId}`);
        renderStats();
      } catch {
        btn.disabled = false;
        alert('Could not delete session — try again.');
      }
    });
  });

  // Chart wants ascending session-number order, most-recent point emphasised
  const chartData = sessions.slice().sort((a,b) => a.sessionNumber - b.sessionNumber);
  const labels = chartData.map(s => s.sessionNumber);
  const accuracies = chartData.map(s => s.accuracy ?? 0);
  const pointSizes = chartData.map((s,i) => {
    const base = 3 + Math.min(6, Math.round((s.questionsAnswered||1) / 3));
    return i === chartData.length - 1 ? base + 3 : base;
  });

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6c63ff';
  const ctx = get('stats-chart');
  if (statsChart) statsChart.destroy();
  statsChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Accuracy',
        data: accuracies,
        borderColor: accent,
        backgroundColor: accent + '22',
        fill: true,
        tension: 0.3,
        pointRadius: pointSizes,
        pointBackgroundColor: accent
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const s = chartData[items[0].dataIndex];
              return new Date(s.startedAt).toLocaleDateString();
            },
            label: (item) => {
              const s = chartData[item.dataIndex];
              return [`${s.topicName} · ${s.mode}`, `${item.formattedValue}% · ${s.questionsAnswered} questions`];
            }
          }
        }
      },
      scales: {
        y: { min: 0, max: 100, ticks: { callback: v => v + '%' } },
        x: { title: { display: true, text: topicId ? 'Session number' : 'Session number (all topics)' } }
      }
    }
  });
}

get('stats-topic-filter').addEventListener('change', renderStats);

let allTopics = [];

// Sort order for the shelf — 'recent' (last studied, falling back to when it
// was added if never studied) or 'alpha' (title, A–Z). Persisted so the
// choice sticks across reloads, same pattern as SESS_KEY/SETT_KEY above.
const LIB_SORT_KEY = 'tutor_library_sort';
let librarySort = localStorage.getItem(LIB_SORT_KEY) === 'alpha' ? 'alpha' : 'recent';

function sortTopics(topics) {
  const arr = [...topics];
  if (librarySort === 'alpha') {
    arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } else {
    arr.sort((a, b) => new Date(b.lastStudiedAt || b.createdAt) - new Date(a.lastStudiedAt || a.createdAt));
  }
  return arr;
}

async function renderLibrary(query = '') {
  const shelves = get('shelves-wrap');
  const empty   = get('library-empty');
  const bcEl    = get('bookcase');
  shelves.innerHTML = '';

  if (!allTopics.length || !query) {
    allTopics = await getJson('/api/topics');
  }

  const filtered = sortTopics(query
    ? allTopics.filter(t => t.name.toLowerCase().includes(query.toLowerCase()))
    : allTopics);

  empty.classList.toggle('hidden', filtered.length > 0);

  if (!filtered.length) {
    // Shelves are permanent furniture — still show the baseline set even
    // with nothing (yet) to put on them.
    padToMinShelves(shelves, MIN_SHELVES);
    layoutShelves(bcEl, shelves);
    return;
  }

  // Distribute books across shelves — sized to the actual (narrow) bookcase column, not the full window
  const SHELF_MAX_W = Math.max(100, (bcEl?.clientWidth || 260) - 4);
  let currentShelf = null;
  let currentW     = 0;

  function newShelf() {
    const s = document.createElement('div');
    s.className = 'shelf';
    shelves.appendChild(s);
    currentShelf = s;
    currentW     = 0;
    return s;
  }

  newShelf();

  filtered.forEach(topic => {
    const style = bookStyle(topic.name);

    if (currentW + style.width + 4 > SHELF_MAX_W) {
      newShelf();
    }

    const book = document.createElement('div');
    book.className = 'book';
    book.title    = topic.name;
    book.dataset.id = topic.id;
    book.style.cssText = `
      --spine-base:${style.spineBase};
      height:${style.height}px;width:${style.width}px;
    `;
    const span = document.createElement('span');
    span.className   = 'book-title';
    setSpineTitle(span, topic.name);
    applySpineStyle(book, span, topic.name, style);
    book.appendChild(span);

    book.addEventListener('click', (e) => showModePicker(topic, e.currentTarget));
    currentShelf.appendChild(book);
    currentW += style.width + 4;
  });

  padToMinShelves(shelves, MIN_SHELVES);
  layoutShelves(bcEl, shelves);
}

function openTopicFromLibrary(topic, mode) {
  fillEmptyTabOrOpenNew(topic, null, mode);
}

// Mode picker — shown when a topic book (library shelf or a course's topic
// row) is clicked, instead of jumping straight into Explain. Picking an
// option opens the topic's Study tab directly on that mode.
let modePickerTopic = null;
function showModePicker(topic, triggerEl) {
  modePickerTopic = topic;
  get('mode-picker-title').textContent = topic.name;
  get('topic-mode-picker').classList.remove('hidden');
  positionPopoverNear(get('mode-picker-card'), triggerEl);
}
function hideModePicker() {
  modePickerTopic = null;
  get('topic-mode-picker').classList.add('hidden');
}
get('topic-mode-picker').addEventListener('click', (e) => {
  if (e.target.id === 'topic-mode-picker') hideModePicker(); // backdrop click
});
get('mode-picker-cancel').addEventListener('click', hideModePicker);
qa('.mode-picker-option').forEach(btn => btn.addEventListener('click', () => {
  const topic = modePickerTopic;
  const mode  = btn.dataset.mode;
  hideModePicker();
  if (!topic) return;
  if (mode === 'stats') showTopicStats(topic);
  else if (mode === 'edit') showTopicEdit(topic);
  else if (mode === 'delete') deleteTopicFromLibrary(topic);
  else openTopicFromLibrary(topic, mode);
}));

// ── Edit / delete a topic ("book") from the library ─────────────────────────

function hideTopicEdit() {
  get('topic-edit-overlay').classList.add('hidden');
}

async function showTopicEdit(topic) {
  const overlay = get('topic-edit-overlay');
  const card    = get('topic-edit-card');
  overlay.classList.remove('hidden');
  card.innerHTML = '<div class="empty-state" style="padding:16px">Loading…</div>';

  // listTopics() (what populates the library) omits content — fetch the
  // full topic so the textarea isn't prefilled empty.
  const full = await getJson(`/api/topics/${topic.id}`);

  card.innerHTML = `
    <div class="mode-picker-title">Edit "${esc(full.name)}"</div>
    <input type="text" id="te-name" class="wz-input" value="${esc(full.name)}"/>
    <textarea id="te-content" class="wz-textarea" rows="8">${esc(full.content || '')}</textarea>
    <div class="te-actions">
      <button class="te-btn te-primary" id="te-save">Save</button>
      <button class="te-btn" id="te-cancel">Cancel</button>
    </div>`;

  card.querySelector('#te-cancel').addEventListener('click', hideTopicEdit);
  card.querySelector('#te-save').addEventListener('click', async () => {
    const name    = card.querySelector('#te-name').value.trim();
    const content = card.querySelector('#te-content').value.trim();
    if (!name) { card.querySelector('#te-name').focus(); return; }
    await patchReq(`/api/topics/${topic.id}`, { name, content });
    hideTopicEdit();
    allTopics = [];
    renderLibrary();
  });
}
get('topic-edit-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'topic-edit-overlay') hideTopicEdit(); // backdrop click
});

async function deleteTopicFromLibrary(topic) {
  if (!confirm(`Delete "${topic.name}"? This removes its questions, attempts, and explanation — this can't be undone.`)) return;
  await del(`/api/topics/${topic.id}`);
  // Any study tab open on the now-deleted topic would otherwise keep
  // pointing at content that no longer exists.
  [...studyTabs].filter(t => t.topicId === topic.id).forEach(t => closeStudyTab(t.id));
  allTopics = [];
  renderLibrary();
}

// ── Topic stats popup ────────────────────────────────────────────────────────
// Explanation-read % + overall question accuracy, expandable into a per-type
// breakdown (flashcards, MCQs, ... whatever question types exist for this
// topic — future types like one-liners show up automatically).
async function showTopicStats(topic) {
  const overlay = get('topic-stats-overlay');
  const card    = get('topic-stats-card');
  overlay.classList.remove('hidden');
  card.innerHTML = '<div class="empty-state" style="padding:16px">Loading…</div>';

  let s;
  try {
    s = await getJson(`/api/topics/${topic.id}/stats`);
  } catch {
    card.innerHTML = `<p class="hint" style="padding:4px">Could not load stats.</p>
      <button class="mode-picker-cancel" id="ts-close">Close</button>`;
    card.querySelector('#ts-close').addEventListener('click', () => overlay.classList.add('hidden'));
    return;
  }

  const TYPE_LABELS = { flashcard: 'Flashcards', mcq: 'MCQs', short: 'Short answer' };
  const typeEntries = Object.entries(s.byType || {});
  const breakdownRows = typeEntries.length
    ? typeEntries.map(([type, d]) => statBarRow(TYPE_LABELS[type] || type, d.accuracy)).join('')
    : '<p class="hint" style="padding:4px">No questions yet.</p>';

  card.innerHTML = `
    <div class="mode-picker-title">${esc(s.topicName)}</div>
    ${statBarRow('Explanation read', s.explanationReadPct)}
    ${statBarRow('Question accuracy', s.accuracy)}
    <button class="ghost-btn wide" id="ts-toggle-breakdown">Question Stats ▾</button>
    <div class="stat-breakdown hidden" id="ts-breakdown">${breakdownRows}</div>
    <button class="mode-picker-cancel" id="ts-close">Close</button>`;

  card.querySelector('#ts-toggle-breakdown').addEventListener('click', (e) => {
    const open = get('ts-breakdown').classList.toggle('hidden');
    e.currentTarget.textContent = open ? 'Question Stats ▾' : 'Question Stats ▴';
  });
  card.querySelector('#ts-close').addEventListener('click', () => overlay.classList.add('hidden'));
}
get('topic-stats-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'topic-stats-overlay') get('topic-stats-overlay').classList.add('hidden');
});

// ── Course stats popup ───────────────────────────────────────────────────────
// Aggregate course score + one progress bar per topic (topic accuracy).
async function showCourseStats(courseId) {
  const overlay = get('course-stats-overlay');
  const card    = get('course-stats-card');
  overlay.classList.remove('hidden');
  card.innerHTML = '<div class="empty-state" style="padding:16px">Loading…</div>';

  let s;
  try {
    s = await getJson(`/api/courses/${courseId}/stats`);
  } catch {
    card.innerHTML = `<p class="hint" style="padding:4px">Could not load stats.</p>
      <button class="mode-picker-cancel" id="cs-close">Close</button>`;
    card.querySelector('#cs-close').addEventListener('click', () => overlay.classList.add('hidden'));
    return;
  }

  const topicRows = (s.topics || []).length
    ? s.topics.map(t => statBarRow(t.name, t.accuracy)).join('')
    : '<p class="hint" style="padding:4px">No topics yet.</p>';

  card.innerHTML = `
    <div class="mode-picker-title">${esc(s.courseName)}</div>
    ${statBarRow('Course score', s.aggregateAccuracy)}
    <div class="stat-breakdown">${topicRows}</div>
    <button class="mode-picker-cancel" id="cs-close">Close</button>`;

  card.querySelector('#cs-close').addEventListener('click', () => overlay.classList.add('hidden'));
}
get('course-stats-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'course-stats-overlay') get('course-stats-overlay').classList.add('hidden');
});

get('library-search').addEventListener('input', e => renderLibrary(e.target.value));

// Reflect a persisted sort choice on first paint (HTML markup hardcodes
// "recent" as the select's first option).
get('lib-sort').value = librarySort;
get('lib-sort').addEventListener('change', e => {
  librarySort = e.target.value;
  localStorage.setItem(LIB_SORT_KEY, librarySort);
  renderLibrary(get('library-search').value);
});

// Re-fill the shelf rows to the bookcase's new height whenever the window
// (and so the bookcase) resizes — otherwise the shelves stay sized for
// whatever height they were last rendered at.
let shelfResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(shelfResizeTimer);
  shelfResizeTimer = setTimeout(() => {
    layoutShelves(get('bookcase'), get('shelves-wrap'));
    layoutShelves(get('bookcase-courses'), get('courses-shelves-wrap'));
  }, 100);
});

