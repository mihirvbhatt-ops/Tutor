// roadmap #16 — db/sqlite.js had no tests directly against it (only
// indirectly, through the HTTP layer in api.test.js). These call the store
// functions straight, against a throwaway DB file, never the real tutor.db.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, '.test-sqlite-direct.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
process.env.TUTOR_DB_PATH = TEST_DB;

const db = await import('../db/sqlite.js');

before(async () => { await db.initDb(); });
after(() => {
  db.closeDb();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

// Every test creates its own topic/course/session with a fresh generated id
// and scopes its assertions to that id, so tests don't need shared-state
// cleanup between them — except the history tests below, which each use
// their own distinct sessionId for the same reason.
function freshTopic(overrides = {}) {
  return db.saveTopic({ name: 'Photosynthesis', content: 'Light -> chemical energy', source: 'paste', ...overrides });
}

// ── Topics ───────────────────────────────────────────────────────────────────

test('saveTopic/getTopic round-trip content exactly, including large payloads', () => {
  const big = 'x'.repeat(50000);
  const t = db.saveTopic({ name: 'Big', content: big, source: 'paste' });
  const fetched = db.getTopic(t.id);
  assert.equal(fetched.content.length, 50000);
  assert.equal(fetched.name, 'Big');
});

test('updateTopic patches only the given fields, leaving the rest untouched', () => {
  const t = freshTopic();
  const updated = db.updateTopic(t.id, { name: 'New Name' });
  assert.equal(updated.name, 'New Name');
  assert.equal(updated.content, 'Light -> chemical energy'); // untouched
});

test('updateTopic on a missing id returns null', () => {
  assert.equal(db.updateTopic('does-not-exist', { name: 'x' }), null);
});

test('deleteTopic cascades to its questions and attempts', () => {
  const t = freshTopic();
  const [q] = db.saveQuestions(t.id, [{ question: 'Q1', answer: 'A1', type: 'short' }]);
  db.recordAttempt(q.id, true);

  db.deleteTopic(t.id);

  assert.equal(db.getTopic(t.id), null);
  assert.deepEqual(db.getQuestions(t.id), []);
  const progress = db.getTopicProgress(t.id);
  assert.equal(progress.error, 'Topic not found');
});

// ── Questions / saveQuestions transaction (roadmap #20 regression) ──────────

test('saveQuestions inserts every question and getQuestions returns them all', () => {
  const t = freshTopic();
  const saved = db.saveQuestions(t.id, [
    { question: 'Q1', answer: 'A1', type: 'short' },
    { question: 'Q2', answer: 'A2', type: 'mcq', options: ['A2', 'x', 'y', 'z'] }
  ]);
  assert.equal(saved.length, 2);
  const fetched = db.getQuestions(t.id);
  assert.equal(fetched.length, 2);
  assert.deepEqual(fetched.find(q => q.question === 'Q2').options, ['A2', 'x', 'y', 'z']);
});

test('saveQuestions rolls back the whole batch if one insert fails partway through (roadmap #20)', () => {
  const t = freshTopic();
  // A question with type: null violates no schema constraint directly, but an
  // undefined/invalid `type` combined with a non-string `question` (an object,
  // which sqlite can't bind) throws mid-loop — simulates the "partial success
  // then failure" scenario the transaction wrapper exists to prevent.
  const batch = [
    { question: 'Good one', answer: 'A1', type: 'short' },
    { question: { bad: 'not a string' }, answer: 'A2', type: 'short' }, // throws on bind
    { question: 'Never reached', answer: 'A3', type: 'short' }
  ];

  assert.throws(() => db.saveQuestions(t.id, batch));

  // Transaction must have rolled back — none of the batch should be visible,
  // including "Good one" which would otherwise have committed before the
  // failing row and left a duplicate behind on a caller's retry.
  assert.deepEqual(db.getQuestions(t.id), []);
});

test('addQuestion adds a single question reusing saveQuestions', () => {
  const t = freshTopic();
  const q = db.addQuestion(t.id, { question: 'Solo', answer: 'A', type: 'short' });
  assert.equal(q.question, 'Solo');
  assert.equal(db.getQuestions(t.id).length, 1);
});

test('updateQuestion changes only supplied fields and preserves options round-trip', () => {
  const t = freshTopic();
  const [q] = db.saveQuestions(t.id, [{ question: 'Q1', answer: 'A1', type: 'mcq', options: ['A1', 'B', 'C', 'D'] }]);
  const updated = db.updateQuestion(q.id, { answer: 'A1-revised' });
  assert.equal(updated.answer, 'A1-revised');
  assert.equal(updated.question, 'Q1');
  assert.deepEqual(updated.options, ['A1', 'B', 'C', 'D']);
});

test('deleteQuestion removes the question and its attempts', () => {
  const t = freshTopic();
  const [q] = db.saveQuestions(t.id, [{ question: 'Q1', answer: 'A1', type: 'short' }]);
  db.recordAttempt(q.id, true);
  db.deleteQuestion(q.id);
  assert.deepEqual(db.getQuestions(t.id), []);
});

test('deleteQuestionsByType only removes the matching type, leaving other types intact', () => {
  const t = freshTopic();
  db.saveQuestions(t.id, [
    { question: 'F1', answer: 'A', type: 'flashcard' },
    { question: 'M1', answer: 'A', type: 'mcq', options: ['A', 'B', 'C', 'D'] }
  ]);
  const result = db.deleteQuestionsByType(t.id, 'flashcard');
  assert.equal(result.deleted, 1);
  const remaining = db.getQuestions(t.id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].type, 'mcq');
});

// ── Progress / attempts ──────────────────────────────────────────────────────

test('getTopicProgress computes accuracy from latest attempts and flags weak questions', () => {
  const t = freshTopic();
  const [q1, q2] = db.saveQuestions(t.id, [
    { question: 'Q1', answer: 'A', type: 'short' },
    { question: 'Q2', answer: 'A', type: 'short' }
  ]);
  db.recordAttempt(q1.id, true);
  db.recordAttempt(q2.id, false);

  const progress = db.getTopicProgress(t.id);
  assert.equal(progress.attempted, 2);
  assert.equal(progress.correct, 1);
  assert.equal(progress.accuracy, 50);
  assert.deepEqual(progress.weakQuestions.map(w => w.id), [q2.id]);
});

test('getTopicProgress for a missing topic returns an error, not a throw', () => {
  const result = db.getTopicProgress('nope');
  assert.equal(result.error, 'Topic not found');
});

// ── Explanations ──────────────────────────────────────────────────────────────

test('saveExplanation upserts — a second save for the same topic overwrites, not duplicates', () => {
  const t = freshTopic();
  db.saveExplanation(t.id, { main: '<p>v1</p>', followups: [] });
  db.saveExplanation(t.id, { main: '<p>v2</p>', followups: [{ q: 'why?', a: 'because' }] });
  const got = db.getExplanation(t.id);
  assert.equal(got.main, '<p>v2</p>');
  assert.deepEqual(got.followups, [{ q: 'why?', a: 'because' }]);
});

test('getExplanation for a topic with none saved returns null', () => {
  const t = freshTopic();
  assert.equal(db.getExplanation(t.id), null);
});

// ── History (capped at 40 per session) ───────────────────────────────────────

test('appendHistory caps each session at the most recent 40 messages', () => {
  const sid = 'cap-test';
  for (let i = 0; i < 45; i++) db.appendHistory('user', `msg-${i}`, sid);
  const hist = db.getHistory(sid);
  assert.equal(hist.length, 40);
  assert.equal(hist[0].content, 'msg-5');   // oldest 5 evicted
  assert.equal(hist[39].content, 'msg-44'); // newest kept
});

test('history is isolated per sessionId', () => {
  db.appendHistory('user', 'in session A', 'session-a');
  db.appendHistory('user', 'in session B', 'session-b');
  assert.equal(db.getHistory('session-a').length, 1);
  assert.equal(db.getHistory('session-b').length, 1);
  assert.equal(db.getHistory('session-a')[0].content, 'in session A');
});

test('clearHistory(sessionId) only clears that session; clearHistory() with no arg wipes all', () => {
  db.appendHistory('user', 'a', 'sess-a');
  db.appendHistory('user', 'b', 'sess-b');
  db.clearHistory('sess-a');
  assert.equal(db.getHistory('sess-a').length, 0);
  assert.equal(db.getHistory('sess-b').length, 1);
  db.clearHistory();
  assert.equal(db.getHistory('sess-b').length, 0);
});

// ── Courses ───────────────────────────────────────────────────────────────────

test('addTopicToCourse without an explicit position appends to the end', () => {
  const course = db.createCourse({ name: 'Bio 101' });
  const t1 = freshTopic({ name: 'Cells' });
  const t2 = freshTopic({ name: 'Genetics' });
  db.addTopicToCourse({ courseId: course.id, topicId: t1.id, position: 0 });
  const added = db.addTopicToCourse({ courseId: course.id, topicId: t2.id, position: null });
  assert.equal(added.position, 1);
});

test('reorderCourseTopics rewrites positions to match the given order', () => {
  const course = db.createCourse({ name: 'Bio 101' });
  const t1 = freshTopic({ name: 'Cells' });
  const t2 = freshTopic({ name: 'Genetics' });
  db.addTopicToCourse({ courseId: course.id, topicId: t1.id, position: 0 });
  db.addTopicToCourse({ courseId: course.id, topicId: t2.id, position: 1 });

  db.reorderCourseTopics(course.id, [t2.id, t1.id]);

  const got = db.getCourse(course.id);
  const byId = Object.fromEntries(got.topics.map(t => [t.id, t.position]));
  assert.equal(byId[t2.id], 0);
  assert.equal(byId[t1.id], 1);
});

test('deleteCourse removes its course_topics links but leaves the topics themselves', () => {
  const course = db.createCourse({ name: 'Bio 101' });
  const t1 = freshTopic({ name: 'Cells' });
  db.addTopicToCourse({ courseId: course.id, topicId: t1.id, position: 0 });
  db.deleteCourse(course.id);
  assert.equal(db.getCourse(course.id), null);
  assert.notEqual(db.getTopic(t1.id), null); // topic itself survives
});

// ── Sessions ──────────────────────────────────────────────────────────────────

test('startSession/recordSessionAnswer/endSession accumulates accuracy for an ended session', () => {
  const t = freshTopic();
  const s = db.startSession(t.id, 'quiz');
  db.recordSessionAnswer(s.id, true, 500);
  db.recordSessionAnswer(s.id, false, 800);
  db.endSession(s.id);

  const [row] = db.listSessions({ topicId: t.id });
  assert.equal(row.questionsAnswered, 2);
  assert.equal(row.correctCount, 1);
  assert.equal(row.accuracy, 50);
  assert.notEqual(row.endedAt, null);
});

test('an in-progress (never-ended) session does not appear in listSessions', () => {
  const t = freshTopic();
  db.startSession(t.id, 'flashcard');
  assert.equal(db.listSessions({ topicId: t.id }).length, 0);
});

test('deleteSession removes an ended session from listSessions', () => {
  const t = freshTopic();
  const s = db.startSession(t.id, 'flashcard');
  db.endSession(s.id);
  assert.equal(db.listSessions({ topicId: t.id }).length, 1);
  db.deleteSession(s.id);
  assert.equal(db.listSessions({ topicId: t.id }).length, 0);
});
