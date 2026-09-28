// roadmap #16 — public/app.js (~65% of the codebase) had no tests at all.
// Loads the real index.html into jsdom and evaluates the real frontend source
// against it (not a copy/extraction), so these exercise production code.
// `runScripts: 'outside-only'` means the <script src="..."> tags in the
// markup do NOT auto-fetch/run — we eval the files' own source into the
// window ourselves, after stubbing fetch (no real network in a test run) and
// Chart (loaded from a CDN in the real page, never used at module-load time).
//
// roadmap #24 — app.js was split into public/js/*.js (classic, non-module
// scripts, loaded in the same dependency order in index.html). Concatenating
// them in that same order and eval-ing as one string reproduces exactly what
// the browser does: classic scripts share one global lexical environment, so
// this is the same trick as before, just fed from 8 files instead of 1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

// Same order as the <script src="/js/..."> tags in index.html.
const JS_FILES = ['core', 'wizard', 'study', 'library', 'stats', 'settings-ui', 'courses', 'init'];
const appJs = JS_FILES
  .map(name => fs.readFileSync(path.join(__dirname, `../public/js/${name}.js`), 'utf8'))
  .join('\n');

let dom, win, T;

before(() => {
  dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  win = dom.window;
  win.fetch = () => Promise.reject(new Error('no network in tests'));
  win.Chart = class { destroy() {} };
  // roadmap #18 — production loads this from a CDN <script> tag (see
  // index.html); the npm package gives the same 9.1.6 API for tests.
  win.marked = marked;

  // Exposes the handful of top-level `const`/`function` bindings we want to
  // test onto window.__T — evaluated as one script with app.js so it shares
  // app.js's top-level lexical scope (those bindings aren't `window.x`
  // properties on their own; `const`/arrow functions never are, even for
  // classic non-module scripts).
  const trailer = `
window.__T = {
  esc, markdownToHtml, formatClock, quizClockElapsedMs, computeSpineStyle,
  statBarRow, fmtCount, wizardGenBody, countsFromInputs, loadExplainPanel, addExplainModeIfAvailable,
  bookStyle, createBookElement
};`;
  win.eval(appJs + '\n' + trailer);
  T = win.__T;
});

after(() => { dom.window.close(); });

test('app.js evaluates against the real index.html with no thrown errors', () => {
  assert.ok(win.document.getElementById('btn-begin'), 'sanity check: real DOM loaded');
  assert.ok(T.markdownToHtml, 'trailer executed, meaning app.js ran to completion');
});

// ── esc — XSS-safety-relevant, used to inject user-provided text into innerHTML ──

test('esc escapes HTML-significant characters', () => {
  assert.equal(T.esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(T.esc('Tom & Jerry'), 'Tom &amp; Jerry');
});

test('esc treats null/undefined as empty string rather than the literal text "null"', () => {
  assert.equal(T.esc(null), '');
  assert.equal(T.esc(undefined), '');
});

// ── markdownToHtml ────────────────────────────────────────────────────────────

test('markdownToHtml renders ## headers and **bold**', () => {
  const html = T.markdownToHtml('## Heading\n\nSome **bold** text.');
  assert.match(html, /<h2>Heading<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
});

test('markdownToHtml escapes raw HTML in the source instead of passing it through', () => {
  const html = T.markdownToHtml('<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img'), 'raw <img> must not reach the DOM unescaped');
});

test('markdownToHtml renders a bullet list as <ul><li>', () => {
  const html = T.markdownToHtml('- one\n- two');
  assert.match(html, /<ul>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<li>two<\/li>/);
});

test('markdownToHtml renders fenced code blocks (roadmap #18 gap)', () => {
  const html = T.markdownToHtml('```js\nconst x = 1;\n```');
  assert.match(html, /<pre><code/);
  assert.match(html, /const x = 1;/);
});

test('markdownToHtml renders tables (roadmap #18 gap)', () => {
  const html = T.markdownToHtml('| Col1 | Col2 |\n|---|---|\n| a | b |');
  assert.match(html, /<table>/);
  assert.match(html, /<th>Col1<\/th>/);
  assert.match(html, /<td>a<\/td>/);
});

test('markdownToHtml renders nested lists (roadmap #18 gap)', () => {
  const html = T.markdownToHtml('- a\n  - nested\n- b');
  assert.match(html, /<li>a<ul>\s*<li>nested<\/li>/);
});

test('markdownToHtml rejects markdown link syntax with an error instead of an unsanitized href', () => {
  const html = T.markdownToHtml('See [this page](javascript:alert(1)) for more.');
  assert.ok(!html.includes('<a '), 'must never emit a real anchor — marked does not sanitize href schemes');
  assert.match(html, /md-error/);
  assert.match(html, /supported/);
});

test('markdownToHtml rejects markdown image syntax the same way as links', () => {
  const html = T.markdownToHtml('![alt](javascript:alert(1))');
  assert.ok(!html.includes('<img'));
  assert.match(html, /md-error/);
});

// ── formatClock / quizClockElapsedMs — quiz timer (roadmap #10 shipped v1.97) ──

test('formatClock renders mm:ss, zero-padded', () => {
  assert.equal(T.formatClock(0), '00:00');
  assert.equal(T.formatClock(65000), '01:05');
  assert.equal(T.formatClock(3600000), '60:00');
});

test('formatClock never goes negative on a slightly-off elapsed value', () => {
  assert.equal(T.formatClock(-500), '00:00');
});

// ── statBarRow — shared stats-popup percentage bar ───────────────────────────

test('statBarRow renders a percentage and clamps width to [0,100]', () => {
  assert.match(T.statBarRow('Accuracy', 150), /width:100%/);
  assert.match(T.statBarRow('Accuracy', 150), />150%</);
  assert.match(T.statBarRow('Accuracy', -10), /width:0%/);
});

test('statBarRow renders a dash placeholder, not "0%", when pct is null (nothing attempted yet)', () => {
  const html = T.statBarRow('Accuracy', null);
  assert.match(html, /stat-bar-pct">–</); // displayed percentage text is "–", not "0%"
  assert.match(html, /width:0%/);          // the bar itself still renders empty
});

test('statBarRow escapes its label', () => {
  const html = T.statBarRow('<b>x</b>', 50);
  assert.ok(!html.includes('<b>x</b>'));
});

// ── fmtCount ──────────────────────────────────────────────────────────────────

test('fmtCount adds thousands separators', () => {
  assert.equal(T.fmtCount(1234567), (1234567).toLocaleString());
});

// ── computeSpineStyle — deterministic per-title book-spine styling ───────────

test('computeSpineStyle is deterministic for the same title', () => {
  const opts = { heightBase: 200, widthBase: 30, widthSpan: 10 };
  const a = T.computeSpineStyle('Photosynthesis', opts);
  const b = T.computeSpineStyle('Photosynthesis', opts);
  assert.deepEqual(a, b);
});

test('computeSpineStyle produces different styling for different titles', () => {
  const opts = { heightBase: 200, widthBase: 30, widthSpan: 10 };
  const a = T.computeSpineStyle('Photosynthesis', opts);
  const b = T.computeSpineStyle('World War 2', opts);
  assert.notDeepEqual(a, b);
});

// ── wizardGenBody — question-generation request body for the wizard ─────────

test('wizardGenBody defaults to hybrid source with no explicit wizardData', () => {
  const body = T.wizardGenBody('quiz');
  assert.equal(body.mode, 'quiz');
  assert.equal(body.source, 'hybrid');
});

// ── Question-count inputs ───────────────────────────────────────────────────

test('countsFromInputs clamps an over-limit count to that source\'s maximum and shows it in the input', () => {
  const ai = win.document.getElementById('wz-count-ai');
  const local = win.document.getElementById('wz-count-local');
  ai.value = '40';
  local.value = '80';
  const counts = T.countsFromInputs('wz-count');
  assert.deepEqual({ ...counts }, { aiCount: 25, localCount: 50 });
  assert.equal(ai.value, '25');
  assert.equal(local.value, '50');
});

test('countsFromInputs keeps an in-range count and treats a blank one as "use the server default"', () => {
  win.document.getElementById('wz-count-ai').value = '';
  win.document.getElementById('wz-count-local').value = '38';
  const counts = T.countsFromInputs('wz-count');
  assert.deepEqual({ ...counts }, { aiCount: null, localCount: 38 });
});

// ── Wizard file input reset ─────────────────────────────────────────────────

test('starting a new topic clears the file input so re-picking the same file fires "change" again', () => {
  const input = win.document.getElementById('file-input');
  let assigned = null;
  // jsdom can't hold a real file selection; stand in for one that survived
  // from the previous wizard run and record what the reset writes.
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => 'C:\\fakepath\\guide.docx',
    set: v => { assigned = v; }
  });
  win.document.getElementById('btn-create-topic').click();
  delete input.value;
  assert.equal(assigned, '');
});

// ── Explain panel: saved explanations never depend on the AI ────────────────

// Routes fetch() by URL; records every URL requested so a test can assert
// the agent (/api/chat) was never called.
function stubFetch(routes) {
  const calls = [];
  win.fetch = async url => {
    calls.push(String(url));
    const hit = Object.entries(routes).find(([prefix]) => String(url) === prefix);
    const [status, body] = hit ? hit[1] : [500, { error: 'unexpected' }];
    return { ok: status < 400, status, json: async () => body }; // jsdom has no Response
  };
  return calls;
}

test('loadExplainPanel shows a saved explanation without calling the AI', async () => {
  const calls = stubFetch({ '/api/topics/t1/explanation': [200, { main: '<h2>Overview</h2><p>Saved.</p>', followups: [] }] });
  await T.loadExplainPanel('t1');
  const body = win.document.getElementById('explain-body');
  assert.equal(body.querySelector('h2').textContent, 'Overview');
  assert.ok(!calls.some(u => u.includes('/api/chat')));
});

test('loadExplainPanel with nothing saved and no API key shows a notice and the saved material instead of failing', async () => {
  const calls = stubFetch({
    '/api/topics/t2/explanation': [200, null],
    '/api/settings/api-key': [200, { hasKey: false }],
    '/api/topics/t2': [200, { id: 't2', content: 'Photosynthesis: light to chemical energy.\n<b>not html</b>' }]
  });
  await T.loadExplainPanel('t2');
  const body = win.document.getElementById('explain-body');
  assert.match(body.textContent, /No explanation saved for this topic yet/);
  assert.match(body.textContent, /Photosynthesis: light to chemical energy\./);
  assert.equal(body.querySelector('b'), null, 'saved material is escaped, not rendered as HTML');
  assert.ok(win.document.getElementById('btn-explain-add-key'));
  assert.ok(!calls.some(u => u.includes('/api/chat')), 'no doomed agent request');
});

test('loadExplainPanel reports a failed read of the saved explanation instead of regenerating over it', async () => {
  const calls = stubFetch({ '/api/topics/t3/explanation': [500, { error: 'db busy' }] });
  await T.loadExplainPanel('t3');
  const body = win.document.getElementById('explain-body');
  assert.match(body.textContent, /Couldn’t load the saved explanation/);
  assert.ok(win.document.getElementById('btn-explain-retry'));
  assert.ok(!calls.some(u => u.includes('/api/chat')));
});

// ── Explain section for topics created without "Explain" ────────────────────

test('addExplainModeIfAvailable adds Explain when the topic has saved material, even though it was not picked', async () => {
  stubFetch({
    '/api/topics/t4/explanation': [200, null],
    '/api/topics/t4': [200, { id: 't4', content: 'Hunter-gatherer: society that forages.' }]
  });
  const tab = { id: 'x1', topicId: 't4', modes: ['flashcard', 'quiz'] };
  await T.addExplainModeIfAvailable(tab);
  assert.deepEqual([...tab.modes], ['explain', 'flashcard', 'quiz']);
});

test('addExplainModeIfAvailable adds Explain when a saved explanation exists', async () => {
  stubFetch({
    '/api/topics/t5/explanation': [200, { main: '<h2>Overview</h2>', followups: [] }],
    '/api/topics/t5': [200, { id: 't5', content: '' }]
  });
  const tab = { id: 'x2', topicId: 't5', modes: ['quiz'] };
  await T.addExplainModeIfAvailable(tab);
  assert.deepEqual([...tab.modes], ['explain', 'quiz']);
});

test('addExplainModeIfAvailable leaves the sections alone when there is nothing to explain from', async () => {
  stubFetch({
    '/api/topics/t6/explanation': [200, null],
    '/api/topics/t6': [200, { id: 't6', content: '   ' }]
  });
  const tab = { id: 'x3', topicId: 't6', modes: ['quiz'] };
  await T.addExplainModeIfAvailable(tab);
  assert.deepEqual([...tab.modes], ['quiz']);
});

// ── Custom book covers ──────────────────────────────────────────────────────

test('bookStyle with no cover renders exactly as before (automatic look unchanged)', () => {
  assert.deepEqual({ ...T.bookStyle('Photosynthesis', null) }, { ...T.bookStyle('Photosynthesis') });
});

test('bookStyle applies a custom size, spine colour, band colour, band size and type', () => {
  const s = T.bookStyle('Photosynthesis', { size: 'large', color: '#112233', bandColor: '#aa0000', bandSize: 'thick', bandType: 'two-end' });
  assert.equal(s.width, 36);
  assert.ok(s.height >= 96);
  assert.match(s.spineBase, /#112233/);
  assert.match(s.spineBase, /#aa0000/);
  assert.equal(s.finish, 'finish-matte');
  assert.match(s.titleColor, /#aa0000/);
  // "thick" two-end bands are wider than the automatic ones
  const thin = T.bookStyle('Photosynthesis', { bandSize: 'thin', bandType: 'two-end', bandColor: '#aa0000' });
  assert.ok(s.titleClear < thin.titleClear);
});

test('bookStyle with bandType "none" draws no band at all', () => {
  const s = T.bookStyle('Photosynthesis', { bandType: 'none', color: '#112233' });
  assert.equal(s.spineBase, '#112233');
});

test('createBookElement builds the same spine the library shelf shows', () => {
  const { book, style } = T.createBookElement('Trojan War', { size: 'small' });
  assert.equal(book.style.width, `${style.width}px`);
  assert.equal(book.querySelector('.book-title').textContent, 'TrojanWar');
});
