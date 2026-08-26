// roadmap #4 — the sql.js fallback (db/sqlite.js's automatic path when
// better-sqlite3 fails to load) had never been exercised end-to-end: every
// dev machine and CI runner has a working native build, so the fallback
// only existed on paper. TUTOR_FORCE_SQLJS=1 forces initDb() into the real
// fallback branch (see db/sqlite.js) rather than a stand-in for it, so this
// suite runs the actual sql.js code path — same schema, same migrations,
// same query()/run()/persist() helpers every other test exercises against
// better-sqlite3.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, '.test-sqljs-fallback.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });

process.env.TUTOR_DB_PATH = TEST_DB;
process.env.TUTOR_FORCE_SQLJS = '1';

const db = await import('../db/sqlite.js');

before(async () => { await db.initDb(); });
after(() => {
  delete process.env.TUTOR_FORCE_SQLJS;
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

function freshTopic(overrides = {}) {
  return db.saveTopic({ name: 'Photosynthesis', content: 'Light -> chemical energy', source: 'paste', ...overrides });
}

test('TUTOR_FORCE_SQLJS actually lands on the sql.js backend, not silently on better-sqlite3', () => {
  assert.equal(db.exportAll().backend, 'sql.js');
});

test('schema and migrations applied: all ten tables exist and schemaVersion reflects every migration', () => {
  const { data, schemaVersion } = db.exportAll();
  for (const table of ['topics', 'questions', 'attempts', 'history', 'courses',
                       'course_topics', 'progress_state', 'sessions',
                       'explanations', 'explanation_reads']) {
    assert.ok(Array.isArray(data[table]), `${table} missing — schema didn't apply on sql.js`);
  }
  // Highest migration version in db/sqlite.js's MIGRATIONS list at time of
  // writing; bump this alongside a new migration, same as any other schema test.
  assert.equal(schemaVersion, 3);
});

test('CRUD round-trips correctly on sql.js: topic, questions, attempts, progress', () => {
  const t = freshTopic();
  assert.equal(db.getTopic(t.id).content, 'Light -> chemical energy');

  const [q1, q2] = db.saveQuestions(t.id, [
    { question: 'Q1', answer: 'A1', type: 'short' },
    { question: 'Q2', answer: 'A2', type: 'short' }
  ]);
  db.recordAttempt(q1.id, true);
  db.recordAttempt(q2.id, false);

  const progress = db.getTopicProgress(t.id);
  assert.equal(progress.attempted, 2);
  assert.equal(progress.correct, 1);

  db.updateTopic(t.id, { name: 'Renamed' });
  assert.equal(db.getTopic(t.id).name, 'Renamed');

  db.deleteTopic(t.id);
  assert.equal(db.getTopic(t.id), null);
});

test('withTransaction rolls back the whole batch on sql.js the same way it does on better-sqlite3 (roadmap #20)', () => {
  const t = freshTopic();
  const batch = [
    { question: 'Good one', answer: 'A1', type: 'short' },
    { question: { bad: 'not a string' }, answer: 'A2', type: 'short' }, // throws on bind
    { question: 'Never reached', answer: 'A3', type: 'short' }
  ];

  assert.throws(() => db.saveQuestions(t.id, batch));

  // The transaction wrapper's whole point is that "Good one" doesn't survive
  // either — sql.js's BEGIN/COMMIT/ROLLBACK is driven by plain db.run(sql)
  // calls rather than better-sqlite3's db.exec(), a different enough code
  // path (see withTransaction in db/sqlite.js) that it needed its own check
  // rather than assuming parity.
  assert.deepEqual(db.getQuestions(t.id), []);
});

test('a bad bind value does not leak a prepared statement and silently break every later write (roadmap #4)', () => {
  // sql.js's own db.run(sql, params) prepares and binds in one call; if
  // bind() throws, its cleanup is never reached and the statement leaks.
  // Once that happened, every export() afterwards kept returning the
  // snapshot from before the leak — reads through the live connection
  // stayed correct, but nothing further was ever actually saved to disk,
  // with no error at the time it stopped. db/sqlite.js's run() now prepares
  // and frees in its own try/finally specifically to prevent this; this
  // test is here so a regression shows up as a failure, not as silence.
  const t = freshTopic();
  assert.throws(() => db.saveQuestions(t.id, [{ question: { not: 'a string' }, answer: 'A', type: 'short' }]));

  db.saveTopic({ name: 'Written After A Bad Bind', content: 'x', source: 'paste' });
  const raw = fs.readFileSync(TEST_DB);
  assert.ok(raw.includes(Buffer.from('Written After A Bad Bind')),
    'a write after a bad-bind error did not reach disk — the earlier failure leaked a statement and broke persistence');
});

test('courses cascade correctly on sql.js', () => {
  const course = db.createCourse({ name: 'Biology 101' });
  const t = freshTopic();
  db.addTopicToCourse({ courseId: course.id, topicId: t.id });
  assert.equal(db.getCourse(course.id).topics.length, 1);

  db.deleteCourse(course.id);
  assert.equal(db.getCourse(course.id), null);
  assert.ok(db.getTopic(t.id), 'deleting a course must not cascade to its topics');
});

test('sessions round-trip and feed the stats summary on sql.js', () => {
  const t = freshTopic();
  const session = db.startSession(t.id, 'quiz');
  db.recordSessionAnswer(session.id, true, 1200);
  db.endSession(session.id);

  const rows = db.listSessions({ topicId: t.id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].correctCount, 1);

  const summary = db.getStatsSummary();
  assert.ok(summary.totalSessions >= 1);
});

test('writes actually reach disk — persist() runs after every write, not just at process exit', () => {
  // File size isn't a reliable signal here: a small write can land in space
  // an earlier delete already freed, leaving the byte count unchanged even
  // though persist() ran correctly. Checking for the row's own bytes in the
  // file is what actually proves the write reached disk.
  freshTopic({ name: 'Disk Persistence Check Marker' });
  const raw = fs.readFileSync(TEST_DB);
  assert.ok(raw.includes(Buffer.from('Disk Persistence Check Marker')),
    'tutor.db does not contain a row just written — persist() may not be firing on the sql.js path');
});

test('a saved topic survives a simulated restart — the file sql.js wrote back is the file it reads on the next boot', async () => {
  const t = freshTopic({ name: 'Restart Survivor' });

  // initDb() is safe to call again: it's exactly what happens on a real
  // process restart, just without actually exiting this one. Since backend
  // is forced to sql.js again, this re-reads TEST_DB from disk into a brand
  // new in-memory SQL.Database — proving persist()'s writes are real, not
  // an artifact of both "sides" sharing the same in-memory object.
  await db.initDb();

  assert.equal(db.getTopic(t.id).name, 'Restart Survivor');
});

test('exportDbSnapshot() on sql.js returns real SQLite bytes containing current data', () => {
  freshTopic({ name: 'Snapshot Marker Topic' });
  const buf = db.exportDbSnapshot();
  assert.equal(buf.subarray(0, 15).toString('utf8'), 'SQLite format 3');
  assert.ok(buf.includes(Buffer.from('Snapshot Marker Topic', 'utf8')));
});
