// Automated regression suite for the Express API (roadmap #8).
// Runs against a throwaway SQLite file via TUTOR_DB_PATH, never the real
// tutor.db, and never calls the Anthropic API — only validation-error paths
// of /api/chat and /api/evaluate are exercised (real generation still
// requires manual testing with a live API key).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, '.test-tutor.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });

// roadmap #3 — /api/evaluate now consults the saved inference routing, so
// this suite needs its own throwaway config file too. Without it these tests
// would read the developer's real db/config.json and take a different code
// path the moment they'd routed grading to a local model.
const TEST_CONFIG = path.join(__dirname, '.test-api-config.json');
fs.rmSync(TEST_CONFIG, { force: true });

process.env.TUTOR_DB_PATH = TEST_DB;
process.env.TUTOR_CONFIG_PATH = TEST_CONFIG;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test-not-a-real-key';

const { app, initDb } = await import('../server.js');
const { saveTopic, saveQuestions } = await import('../db/sqlite.js');

let server, base;

before(async () => {
  await initDb();
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
  fs.rmSync(TEST_CONFIG, { force: true });
});

const get   = p        => fetch(base + p);
const post  = (p, b)   => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const patch = (p, b)   => fetch(base + p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const del   = p        => fetch(base + p, { method: 'DELETE' });

function seedTopic(name = 'Photosynthesis') {
  return saveTopic({ name, content: 'Plants convert light into energy.', source: 'paste' });
}

// ── #7 — error responses use a real HTTP status, never a 200 with {error} ───

test('unknown /api route returns 404 JSON, not an HTML fallthrough page', async () => {
  const res = await get('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.ok(body.error);
});

test('GET /api/topics/:id for a missing topic returns 404 with an error body', async () => {
  const res = await get('/api/topics/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});

test('PATCH /api/topics/:id for a missing topic returns 404', async () => {
  const res = await patch('/api/topics/nope', { name: 'x' });
  assert.equal(res.status, 404);
});

test('GET /api/courses/:id for a missing course returns 404', async () => {
  const res = await get('/api/courses/nope');
  assert.equal(res.status, 404);
});

test('POST /api/chat without a message returns 400, not a 200 with an error body', async () => {
  const res = await post('/api/chat', { sessionId: 'test' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
});

test('POST /api/evaluate without required fields returns 400', async () => {
  const res = await post('/api/evaluate', { question: 'What is 2+2?' });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});

test('POST /api/settings/search-key without an apiKey returns 400 (never reaches the config file)', async () => {
  const res = await post('/api/settings/search-key', { provider: 'tavily' });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});

test('POST /api/settings/search-key with an unknown provider returns 400 (never reaches the config file)', async () => {
  const res = await post('/api/settings/search-key', { apiKey: 'some-key', provider: 'bing' });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});

test('POST /api/topics with source "search" but no query returns 400', async () => {
  const res = await post('/api/topics', { name: 'No Query Topic', source: 'search' });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});

test('POST /api/upload with no file returns 400', async () => {
  const res = await fetch(base + '/api/upload', { method: 'POST', body: new FormData() });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});

test('POST /api/topics/:id/questions with missing fields returns 400', async () => {
  const topic = seedTopic('Error Path Topic');
  const res = await post(`/api/topics/${topic.id}/questions`, { question: 'Q only' });
  assert.equal(res.status, 400);
});

test('POST /api/sessions/start without topicId/mode returns 400', async () => {
  const res = await post('/api/sessions/start', { mode: 'quiz' });
  assert.equal(res.status, 400);
});

// ── Data endpoint CRUD (no LLM round-trip needed) ───────────────────────────

test('topics: create (via db seed), read, update, delete round-trip through the API', async () => {
  const topic = seedTopic('CRUD Topic');

  let res = await get(`/api/topics/${topic.id}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, 'CRUD Topic');

  res = await patch(`/api/topics/${topic.id}`, { name: 'Renamed Topic' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, 'Renamed Topic');

  res = await del(`/api/topics/${topic.id}`);
  assert.equal(res.status, 200);

  res = await get(`/api/topics/${topic.id}`);
  assert.equal(res.status, 404);
});

test('questions: manual add/edit/delete round-trip through the API', async () => {
  const topic = seedTopic('Question CRUD Topic');

  let res = await post(`/api/topics/${topic.id}/questions`, {
    question: 'Capital of France?', answer: 'Paris', type: 'short'
  });
  assert.equal(res.status, 200);
  const q = await res.json();
  assert.equal(q.answer, 'Paris');

  res = await patch(`/api/questions/${q.id}`, { answer: 'Paris, France' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).answer, 'Paris, France');

  res = await del(`/api/questions/${q.id}`);
  assert.equal(res.status, 200);

  res = await get(`/api/topics/${topic.id}/questions`);
  assert.deepEqual(await res.json(), []);
});

test('session-progress: save, read, and clear a resumption index', async () => {
  const topic = seedTopic('Progress Topic');

  let res = await post('/api/session-progress', { topicId: topic.id, mode: 'quiz', currentIndex: 3 });
  assert.equal(res.status, 200);

  res = await get(`/api/session-progress/${topic.id}/quiz`);
  assert.equal((await res.json()).currentIndex, 3);

  res = await del(`/api/session-progress/${topic.id}/quiz`);
  assert.equal(res.status, 200);

  res = await get(`/api/session-progress/${topic.id}/quiz`);
  assert.equal((await res.json()).currentIndex, 0);
});

test('record-attempt updates topic progress stats', async () => {
  const topic = seedTopic('Attempt Topic');
  const [q] = saveQuestions(topic.id, [{ question: 'Q1', answer: 'A1', type: 'short' }]);

  let res = await post('/api/record-attempt', { questionId: q.id, correct: true });
  assert.equal(res.status, 200);

  res = await get(`/api/topics/${topic.id}/progress`);
  assert.equal(res.status, 200);
  const progress = await res.json();
  assert.equal(progress.attempted, 1);
  assert.equal(progress.correct, 1);
});

test('GET /api/fonts returns an array', async () => {
  const res = await get('/api/fonts');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

// ── #4 — packaged installer & update mechanism ──────────────────────────────
// package.json's repository.url still carries the OWNER/REPO placeholder in
// this checkout, so the endpoint must report itself as unconfigured rather
// than querying GitHub for a repo that doesn't exist.
test('GET /api/update-check reports unconfigured against the placeholder repository URL', async () => {
  const res = await get('/api/update-check');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, false);
  assert.equal(typeof body.currentVersion, 'string');
});

// ── #6/#7 — session-summary comparisons never include the in-progress run ──
// listSessions() only returns endedAt IS NOT NULL rows, so a session that
// hasn't been ended yet can never be picked up as "last time" — the bug this
// guards against is comparing a run's own not-yet-closed row against itself.

test('an in-progress session never appears in the "last session" comparison list', async () => {
  const topic = seedTopic('Self Comparison Topic');

  const s1 = await (await post('/api/sessions/start', { topicId: topic.id, mode: 'quiz' })).json();
  await patch(`/api/sessions/${s1.id}`, { correct: true, timeMs: 500 });
  await post(`/api/sessions/${s1.id}/end`, {});

  let res = await get(`/api/sessions?topicId=${topic.id}&mode=quiz&limit=2`);
  let sessions = await res.json();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, s1.id);
  assert.equal(sessions[0].accuracy, 100);

  // Start a second run — while it's still open, the "last session" lookup
  // (as buildSessionSummaryHtml in app.js performs before ending the run)
  // must still resolve to s1, never to the still-open s2.
  const s2 = await (await post('/api/sessions/start', { topicId: topic.id, mode: 'quiz' })).json();
  await patch(`/api/sessions/${s2.id}`, { correct: false, timeMs: 800 });

  res = await get(`/api/sessions?topicId=${topic.id}&mode=quiz&limit=2`);
  sessions = await res.json();
  assert.equal(sessions.length, 1, 'the open session must not be counted as a "last session" yet');
  assert.equal(sessions[0].id, s1.id);

  await post(`/api/sessions/${s2.id}/end`, {});
  res = await get(`/api/sessions?topicId=${topic.id}&mode=quiz&limit=2`);
  sessions = await res.json();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, s2.id, 'most recent completed session should sort first');
  assert.equal(sessions[0].accuracy, 0);
  assert.equal(sessions[1].id, s1.id);
});

test('GET /api/sessions/summary reflects only ended sessions', async () => {
  const res = await get('/api/sessions/summary');
  assert.equal(res.status, 200);
  const summary = await res.json();
  assert.ok(typeof summary.totalSessions === 'number');
});

// ── #8 — local similarity pre-check short-circuits /api/evaluate ────────────
// A near-exact match or a clearly off-topic answer must resolve without ever
// reaching the Anthropic client — these calls use a fake API key (see top of
// file), so if either fell through to the real request path the test would
// hang/fail on auth rather than returning a fast, deterministic result.

test('POST /api/evaluate auto-accepts a near-exact match without calling the API', async () => {
  const res = await post('/api/evaluate', {
    question: 'What powers photosynthesis?',
    correctAnswer: 'Sunlight provides the energy for photosynthesis',
    userAnswer: 'sunlight provides the energy for photosynthesis'
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.correct, true);
});

test('POST /api/evaluate auto-rejects a clearly off-topic answer without calling the API', async () => {
  const res = await post('/api/evaluate', {
    question: 'What is the capital of France?',
    correctAnswer: 'Paris is the capital of France',
    userAnswer: 'The chicken crossed the road because it was hungry'
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.correct, false);
});

// ── #3 — local inference provider settings & routing ────────────────────────
// The Ollama adapter itself is covered in test/inferenceProvider.test.js
// against a stub server. These cover the settings surface: what the app
// refuses to save, and that routing choices survive a round trip. Nothing
// here reaches a real Ollama — the host defaults to a loopback port with
// nothing listening, which is exactly the "not running" case to assert on.

test('GET /api/settings/local-model reports the defaults and both capability sets', async () => {
  const res = await get('/api/settings/local-model');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, null);
  assert.deepEqual(body.routing, { grading: 'anthropic', generation: 'anthropic', agent: 'anthropic' });
  assert.deepEqual(body.callSites, ['grading', 'generation', 'agent']);
  // The UI needs these to explain what changes when a call site goes local.
  assert.equal(body.capabilities.anthropic.promptCaching, true);
  assert.equal(body.capabilities.ollama.constrainedJson, true);
});

test('POST /api/settings/local-model requires a model name', async () => {
  const res = await post('/api/settings/local-model', { host: 'http://127.0.0.1:11434' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /model is required/);
});

test('POST /api/settings/local-model refuses to save when the host is unreachable', async () => {
  // Same contract as the Anthropic key endpoint: validate before saving so a
  // broken setup surfaces in Settings, not mid-quiz.
  const res = await post('/api/settings/local-model', { host: 'http://127.0.0.1:1', model: 'llama3.1' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Can't reach Ollama/);
});

test('POST /api/settings/inference-routing refuses local routing with no model configured', async () => {
  const res = await post('/api/settings/inference-routing', { grading: 'ollama' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Configure a local model/);
  // And nothing was persisted by the rejected call.
  const after = await (await get('/api/settings/local-model')).json();
  assert.equal(after.routing.grading, 'anthropic');
});

test('POST /api/settings/inference-routing accepts an all-Anthropic round trip', async () => {
  const res = await post('/api/settings/inference-routing', {
    grading: 'anthropic', generation: 'anthropic', agent: 'anthropic'
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.routing, { grading: 'anthropic', generation: 'anthropic', agent: 'anthropic' });
  assert.deepEqual(body.warnings, []);
});

test('DELETE /api/settings/local-model clears the model and reports reset routing', async () => {
  const res = await del('/api/settings/local-model');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.routing, { grading: 'anthropic', generation: 'anthropic', agent: 'anthropic' });
});

test('/api/evaluate reports which engine graded the answer', async () => {
  // Provenance labelling — the UI needs this to show the user what produced
  // a result, so a quality change after switching providers is visible
  // rather than silent. The heuristic tier answers this one.
  const res = await post('/api/evaluate', {
    question: 'What powers photosynthesis?',
    correctAnswer: 'Sunlight provides the energy for photosynthesis',
    userAnswer: 'sunlight provides the energy for photosynthesis'
  });
  assert.equal((await res.json()).engine, 'heuristic');
});

// ── #6 — hybrid local + AI question generation ──────────────────────────────
// Uses a fake API key (see top of file), so the AI "hard" tier call fails
// fast (401, non-retryable per withRetry's skip list) — the endpoint must
// still return the locally-extracted items rather than failing the batch.

test('POST /api/topics/:id/generate-questions (flashcard) returns local flashcards even when the AI hard tier fails', async () => {
  const topic = saveTopic({
    name: 'Cell Biology',
    content:
      "Mitochondria: the organelle that produces ATP through cellular respiration.\n" +
      "Ribosome: the structure that synthesizes proteins from amino acids.\n" +
      "Nucleus: the organelle that contains a cell's genetic material.\n" +
      "Cytoplasm is the gel-like substance filling the interior of a cell.",
    source: 'paste'
  });

  const res = await post(`/api/topics/${topic.id}/generate-questions`, { mode: 'flashcard' });
  assert.equal(res.status, 200);
  const questions = await res.json();
  assert.ok(questions.length > 0, 'expected at least the locally-extracted flashcards');
  assert.ok(questions.every(q => q.type === 'flashcard'));
  assert.ok(questions.some(q => q.question === 'Mitochondria'));
});

test('POST /api/topics/:id/generate-questions (quiz) produces 4-option mcq from a glossary-style topic', async () => {
  const topic = saveTopic({
    name: 'Geometry Terms',
    content:
      'Acute angle: an angle less than 90 degrees.\n' +
      'Obtuse angle: an angle greater than 90 degrees.\n' +
      'Right angle: an angle of exactly 90 degrees.\n' +
      'Straight angle: an angle of exactly 180 degrees.',
    source: 'paste'
  });

  const res = await post(`/api/topics/${topic.id}/generate-questions`, { mode: 'quiz' });
  assert.equal(res.status, 200);
  const questions = await res.json();
  const mcqs = questions.filter(q => q.type === 'mcq');
  assert.ok(mcqs.length > 0, 'expected mcq questions from a 4-term glossary');
  for (const q of mcqs) {
    assert.equal(q.options.length, 4);
    assert.ok(q.options.includes(q.answer));
  }
});

test('POST /api/topics/:id/generate-questions with an invalid mode returns 400', async () => {
  const topic = seedTopic('Bad Mode Topic');
  const res = await post(`/api/topics/${topic.id}/generate-questions`, { mode: 'nonsense' });
  assert.equal(res.status, 400);
});

test('POST /api/topics/:id/generate-questions for a missing topic returns 404', async () => {
  const res = await post('/api/topics/nope/generate-questions', { mode: 'quiz' });
  assert.equal(res.status, 404);
});

// ── #8 — data export / backup ───────────────────────────────────────────────
// The failure mode worth guarding against here isn't a 500, it's an export
// that succeeds while being incomplete or stale — a backup nobody discovers
// is broken until they need it.

test('GET /api/export returns a self-describing JSON dump of every table', async () => {
  const topic = seedTopic('Exportable Topic');
  saveQuestions(topic.id, [{ question: 'Exported Q', answer: 'Exported A', type: 'short' }]);

  const res = await get('/api/export');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  // Without a filename the browser saves it as "export" with no extension.
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename="ai-tutor-export-\d{4}-\d{2}-\d{2}\.json"/);

  const body = await res.json();
  assert.equal(body.format, 'ai-tutor-export');
  assert.equal(body.version, 1);
  assert.equal(typeof body.exportedAt, 'string');
  assert.equal(typeof body.schemaVersion, 'number');

  // Every table the app writes to has to be present, even when empty —
  // a missing key is indistinguishable from "you had no courses".
  for (const table of ['topics', 'questions', 'attempts', 'history', 'courses',
                       'course_topics', 'progress_state', 'sessions',
                       'explanations', 'explanation_reads']) {
    assert.ok(Array.isArray(body.data[table]), `${table} missing from export`);
    assert.equal(body.counts[table], body.data[table].length, `${table} count disagrees with its rows`);
  }

  const exported = body.data.topics.find(t => t.id === topic.id);
  assert.ok(exported, 'seeded topic missing from the export');
  assert.equal(exported.name, 'Exportable Topic');
  // Full rows, not the trimmed listTopics() projection — the reference
  // material is the bulk of what a user would be losing.
  assert.equal(exported.content, 'Plants convert light into energy.');
  assert.ok(body.data.questions.some(q => q.question === 'Exported Q'));
});

test('GET /api/export/db returns a real SQLite file containing the newest writes', async () => {
  seedTopic('Snapshot Topic');

  const res = await get('/api/export/db');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename="ai-tutor-backup-\d{4}-\d{2}-\d{2}\.db"/);

  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString('utf8'), 'SQLite format 3');

  // The point of VACUUM INTO over a plain file copy: in WAL mode a topic
  // written moments ago may still live only in tutor.db-wal, and a snapshot
  // that silently omits it is a backup that quietly loses recent work.
  assert.ok(buf.includes(Buffer.from('Snapshot Topic', 'utf8')),
    'snapshot is missing a row written just before the export (WAL not checkpointed)');
});

test('the export carries no API key — secrets live in config.json, not the database', async () => {
  const res = await get('/api/export');
  const raw = await res.text();
  assert.ok(!raw.includes(process.env.ANTHROPIC_API_KEY), 'API key leaked into the data export');
});
