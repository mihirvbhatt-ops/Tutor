// Import is the half of "your data is yours" that can do damage: a merge
// that overwrites, duplicates, or half-applies is worse than no import at
// all. These call db/sqlite.js's importData() directly, against a throwaway
// DB file, never the real tutor.db.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, '.test-import.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
process.env.TUTOR_DB_PATH = TEST_DB;

const db = await import('../db/sqlite.js');

before(async () => { await db.initDb(); });
after(() => {
  db.closeDb();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

const asFile = obj => Buffer.from(JSON.stringify(obj));
const rowsOf = table => db.exportAll().data[table];

function exportWith(data, overrides = {}) {
  const { schemaVersion } = db.exportAll();
  return asFile({ format: 'ai-tutor-export', version: 1, schemaVersion, data, ...overrides });
}

// Must run first: it needs the database to hold nothing but the seed topic.
test('an untouched seed topic gives way to the studied copy of it in the file', () => {
  const local = db.saveTopic({ name: 'Trojan War', content: 'seeded', source: 'seed' });
  const file = exportWith({
    topics: [{ id: 'old-seed', name: 'Trojan War', content: 'seeded', source: 'seed', sourceRef: '', createdAt: '2026-01-01T00:00:00.000Z' }]
  });

  db.importData(file);
  const topics = rowsOf('topics');
  assert.deepEqual(topics.map(t => t.id), ['old-seed'], 'expected one Trojan War, not two');
  assert.equal(db.getTopic(local.id), null);
});

test('rows already here are left exactly as they are', () => {
  const topic = db.saveTopic({ name: 'Mine', content: 'current notes', source: 'paste' });
  const file = exportWith({
    topics: [{ id: topic.id, name: 'Stale name', content: 'old notes', source: 'paste', sourceRef: '', createdAt: '2020-01-01T00:00:00.000Z' }]
  });

  const result = db.importData(file);
  assert.equal(result.imported.topics, 0);
  assert.equal(result.skipped.topics, 1);
  assert.equal(db.getTopic(topic.id).content, 'current notes');
});

test('attempts and chat history are matched on content, so a repeat import never duplicates them', () => {
  const topic = db.saveTopic({ name: 'Attempted', content: 'x', source: 'paste' });
  const [q] = db.saveQuestions(topic.id, [{ question: 'Q', answer: 'A', type: 'short' }]);
  db.recordAttempt(q.id, true);
  const file = asFile(db.exportAll());
  const before = rowsOf('attempts').length;

  // Same ids in the file as in the database: nothing to add.
  assert.equal(db.importData(file).imported.attempts, 0);

  // Deleting the topic takes its attempts with it; the import brings them
  // back once, under whatever ids are free now.
  db.deleteTopic(topic.id);
  assert.equal(rowsOf('attempts').length, before - 1);
  assert.equal(db.importData(file).imported.attempts, 1);
  assert.equal(db.importData(file).imported.attempts, 0);
  assert.equal(rowsOf('attempts').length, before);
});

test('a file from an older schema imports, with missing columns taking their defaults', () => {
  const file = exportWith({
    topics: [{ id: 'legacy-topic', name: 'Legacy', content: 'c', source: 'paste', sourceRef: '', createdAt: '2024-01-01T00:00:00.000Z' }],
    questions: [{ id: 'legacy-q', topicId: 'legacy-topic', question: 'Q', answer: 'A', type: 'open', options: null }]
  }, { schemaVersion: 1 });

  db.importData(file);
  const q = rowsOf('questions').find(r => r.id === 'legacy-q');
  assert.equal(q.origin, null);
  assert.equal(q.type, 'short', "the 'open' -> 'short' rename applies to imported rows too");
  assert.equal(rowsOf('topics').find(t => t.id === 'legacy-topic').cover, null);
});

test('a file from a newer schema, an unknown format version, or a malformed section is refused', () => {
  const { schemaVersion } = db.exportAll();
  const before = JSON.stringify(db.exportAll().data);
  const bad = [
    exportWith({ topics: [] }, { schemaVersion: schemaVersion + 1 }),
    exportWith({ topics: [] }, { version: 99 }),
    exportWith({ topics: 'nope' }),
    exportWith({ topics: [{ id: { nested: true } }] }),
    Buffer.from('SQLite format 3\0 but then nothing a database would contain')
  ];
  for (const file of bad) assert.throws(() => db.importData(file), db.ImportError);
  assert.equal(JSON.stringify(db.exportAll().data), before, 'a refused import must change nothing');
});

test('a failure partway through rolls the whole import back', () => {
  const before = rowsOf('topics').length;
  // The topic row is fine; the attempt has no timestamp, which the table's
  // NOT NULL constraint rejects after the topic has already been inserted.
  const file = exportWith({
    topics: [{ id: 'half-1', name: 'Half', content: 'c', source: 'paste', sourceRef: '', createdAt: '2024-01-01T00:00:00.000Z' }],
    attempts: [{ questionId: 'q', correct: 1, attemptedAt: null }]
  });
  assert.throws(() => db.importData(file));
  assert.equal(rowsOf('topics').length, before);
});
