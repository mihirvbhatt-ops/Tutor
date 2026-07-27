// ── Library view toggle (Topics ↔ Courses) ────────────────────────────────────

// ── Courses ───────────────────────────────────────────────────────────────────
async function renderCourses() {
  const wrap  = get('courses-shelves-wrap');
  const empty = get('courses-empty');
  const bcCoursesEl = get('bookcase-courses');
  if (!wrap) return;
  wrap.innerHTML = '';
  empty.classList.add('hidden');

  const courses = await getJson('/api/courses');

  empty.classList.toggle('hidden', courses.length > 0);

  if (!courses.length) {
    // Shelves are permanent furniture — still show the baseline set even
    // with nothing (yet) to put on them.
    padToMinShelves(wrap, MIN_SHELVES);
    layoutShelves(bcCoursesEl, wrap);
    return;
  }

  // Render courses as books on shelves (same layout algorithm as topics) — sized to the narrow bookcase column
  const SHELF_MAX_W = Math.max(100, (bcCoursesEl?.clientWidth || 260) - 4);
  let shelf = null, shelfW = 0;

  function newCourseShelf() {
    const s = document.createElement('div');
    s.className = 'shelf';
    wrap.appendChild(s);
    shelf = s; shelfW = 0;
  }

  newCourseShelf();

  for (const course of courses) {
    const st = courseStyle(course.name);
    if (shelfW + st.width + 4 > SHELF_MAX_W) {
      newCourseShelf();
    }
    const book = document.createElement('div');
    book.className = 'book course-book';
    book.title = course.name;
    book.dataset.courseId = course.id;
    book.style.cssText = `--spine-base:${st.spineBase};height:${st.height}px;width:${st.width}px;`;
    const span = document.createElement('span');
    span.className = 'book-title';
    setSpineTitle(span, course.name);
    applySpineStyle(book, span, course.name, st);
    book.appendChild(span);
    book.addEventListener('click', (e) => openCourseDetail(course.id, course.name, e.currentTarget));
    shelf.appendChild(book);
    shelfW += st.width + 4;
  }

  padToMinShelves(wrap, MIN_SHELVES);
  layoutShelves(bcCoursesEl, wrap);
}

let openCourseId = null;

async function openCourseDetail(courseId, courseName, triggerEl) {
  const panel = get('course-detail-panel');

  // Toggle closed if same course clicked again
  if (openCourseId === courseId && !panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    openCourseId = null;
    return;
  }
  openCourseId = courseId;
  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="empty-state" style="padding:16px">Loading…</div>';
  positionPopoverNear(panel, triggerEl);

  const course = await getJson(`/api/courses/${courseId}`);
  const pct = course.topics?.length
    ? Math.round(course.topics.filter(t => (t.accuracy ?? 0) >= 70).length / course.topics.length * 100) : 0;

  const topicRows = (course.topics || []).map(t => {
    const prereqMet = !t.prerequisiteId ||
      (course.topics.find(x => x.id === t.prerequisiteId)?.accuracy ?? 0) >= 70;
    const cls  = (t.accuracy ?? 0) >= 70 ? 'done' : !prereqMet ? 'locked' : 'open';
    const stat = (t.accuracy ?? 0) >= 70 ? `✓ ${t.accuracy}%` : !prereqMet ? '🔒' : t.attempted ? `${t.accuracy}%` : '○';
    return `<div class="detail-topic-row" data-tid="${t.id}" data-locked="${cls === 'locked'}">
      <span class="dtr-num">${t.position + 1}</span>
      <span class="dtr-name">${esc(t.name)}</span>
      <span class="dtr-stat ${cls}">${stat}</span>
    </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="course-detail-name">${esc(course.name)}</div>
    ${course.description ? `<div class="course-detail-desc">${esc(course.description)}</div>` : ''}
    <div class="course-detail-actions">
      <button class="cd-btn primary-cd" id="cd-guide">📄 Study Guide</button>
      <button class="cd-btn" id="cd-stats">📊 Stats</button>
      <button class="cd-btn" id="cd-add">+ Add Topics</button>
      <button class="cd-btn danger-cd" id="cd-delete">Delete</button>
    </div>
    <div class="detail-topic-list">${topicRows || '<p class="hint" style="padding:4px">No topics yet — tap + Add Topics.</p>'}</div>
    <div class="add-topics-wrap" id="cd-add-wrap">
      <p style="font-size:.82rem;color:var(--ink2);margin-bottom:8px">Select topics to add:</p>
      <div class="topic-check-list" id="cd-topic-checks"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="ghost-btn" id="cd-add-cancel">Cancel</button>
        <button class="primary-btn" id="cd-add-save" style="margin-top:0">Add Selected</button>
      </div>
    </div>`;
  positionPopoverNear(panel, triggerEl); // content just grew (from "Loading…") — reposition to the new size

  // Topic rows — open in Study
  panel.querySelectorAll('.detail-topic-row').forEach(row => {
    if (row.dataset.locked === 'true') return;
    row.addEventListener('click', async () => {
      const all = await getJson('/api/topics');
      const t = all.find(x => x.id === row.dataset.tid);
      if (t) showModePicker(t, row);
    });
  });

  panel.querySelector('#cd-guide').addEventListener('click', () => generateStudyGuide(courseId, course.name));
  panel.querySelector('#cd-stats').addEventListener('click', () => showCourseStats(courseId));

  panel.querySelector('#cd-delete').addEventListener('click', async () => {
    if (!confirm(`Delete course "${course.name}"? Topics are kept.`)) return;
    await del(`/api/courses/${courseId}`);
    panel.classList.add('hidden');
    openCourseId = null;
    renderCourses();
  });

  // Add topics
  const addWrap = panel.querySelector('#cd-add-wrap');
  panel.querySelector('#cd-add').addEventListener('click', async () => {
    addWrap.classList.toggle('open');
    if (addWrap.classList.contains('open')) {
      const checks = panel.querySelector('#cd-topic-checks');
      const inCourse = new Set((course.topics || []).map(t => t.id));
      const all = await getJson('/api/topics');
      checks.innerHTML = '';
      for (const t of all) {
        const item = document.createElement('label');
        item.className = 'topic-check-item';
        item.innerHTML = `<input type="checkbox" value="${t.id}" ${inCourse.has(t.id) ? 'checked' : ''}/> ${esc(t.name)}`;
        checks.appendChild(item);
      }
    }
  });
  panel.querySelector('#cd-add-cancel').addEventListener('click', () => addWrap.classList.remove('open'));
  panel.querySelector('#cd-add-save').addEventListener('click', async () => {
    const checked = [...panel.querySelectorAll('#cd-topic-checks input:checked')].map(c => c.value);
    const inCourse = new Set((course.topics || []).map(t => t.id));
    let pos = (course.topics || []).length;
    for (const tid of checked) {
      if (!inCourse.has(tid)) {
        await post(`/api/courses/${courseId}/topics`, { topicId: tid, position: pos++ });
      }
    }
    addWrap.classList.remove('open');
    openCourseDetail(courseId, course.name); // refresh detail
    renderCourses();
  });
}

// Close the course detail panel when clicking anywhere outside it — book
// clicks are excluded since openCourseDetail() already handles opening a
// different course or toggling the same one closed.
document.addEventListener('click', (e) => {
  const panel = get('course-detail-panel');
  if (panel.classList.contains('hidden')) return;
  if (panel.contains(e.target) || e.target.closest('.course-book')) return;
  panel.classList.add('hidden');
  openCourseId = null;
});

// New course form
get('btn-new-course').addEventListener('click', () => {
  get('new-course-form').classList.toggle('hidden');
});
get('btn-nc-cancel').addEventListener('click', () => {
  get('new-course-form').classList.add('hidden');
});
get('btn-nc-create').addEventListener('click', async () => {
  const name = get('nc-name').value.trim();
  if (!name) { get('nc-name').focus(); return; }
  const desc = get('nc-desc').value.trim();
  await post('/api/courses', { name, description: desc });
  get('nc-name').value = '';
  get('nc-desc').value = '';
  get('new-course-form').classList.add('hidden');
  renderCourses();
});

// ── Study guide generation ────────────────────────────────────────────────────
async function generateStudyGuide(courseId, courseName) {
  const tab = newStudyTabState(`guide-${courseId}-${newTabId()}`, `Study Guide: ${courseName}`, ['explain'], null, null);
  tab.isGuide = true;
  studyTabs.push(tab);
  showView('study');
  switchToTab(tab.id); // isGuide tabs skip auto-loading in ensureModeLoaded — we render below instead

  get('study-meta').textContent = 'Generating…';

  const sid = `guide-${courseId}-${Date.now()}`;
  let streaming = false;
  const data = await chatStream({
    message: `Generate a comprehensive study guide for the course named "${courseName}" (course ID: ${courseId}).
Call get_course first to get the ordered topic list.
Then call get_topic for each topic in order.
Write a well-structured markdown study guide with:
- A brief ## Course Overview at the top
- One ## section per topic covering key concepts, definitions, and examples
- Cross-references where topics relate to each other (e.g. "see also: Topic X")
- A ## Quick Reference at the end with the most important points from each topic`,
    sessionId: sid
  }, null, chunk => {
    // Only paint into the live DOM if this guide's tab is still the one
    // showing — the user may have switched away while this generates.
    if (!(getActiveTab() && getActiveTab().id === tab.id)) return;
    const body = get('explain-body');
    if (!streaming) { streaming = true; body.innerHTML = '<div class="explain-stream"></div>'; }
    body.querySelector('.explain-stream').textContent += chunk;
  });

  let wrapperHtml = `<p class="hint">Something went wrong generating this guide — try again.</p>`;
  if (data.reply) {
    const html = markdownToHtml(data.reply);
    wrapperHtml = `
      <div class="guide-header">
        <div class="guide-title">Study Guide — ${esc(courseName)}</div>
        <button class="download-btn" id="btn-download-guide">⬇ Download .txt</button>
      </div>
      <div class="explain-body">${html}</div>`;
  }
  tab.explainHtml = wrapperHtml;

  // Only touch the live DOM if this guide's tab is still the one showing —
  // the user may have switched to another tab while this was generating.
  if (getActiveTab() && getActiveTab().id === tab.id) {
    get('explain-body').innerHTML = wrapperHtml;
    get('study-meta').textContent = `Course · ${courseName}`;
    get('btn-download-guide')?.addEventListener('click', () => {
      const blob = new Blob([data.reply || ''], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `StudyGuide_${courseName.replace(/\s+/g, '_')}.txt`;
      a.click();
    });
  }
}

