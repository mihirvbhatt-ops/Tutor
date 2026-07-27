/**
 * db/sqlite.js — study-only SQLite store.
 *
 * Tables:
 *   topics    — saved study material
 *   questions — generated Q&A / flashcards per topic
 *   attempts  — right/wrong record per question per attempt
 *   history   — chat conversation memory (capped at 40 messages)
 *
 * Backend: better-sqlite3 (native) when available — writes go straight to
 * disk statement-by-statement, so a flashcard attempt no longer rewrites the
 * entire database file. Falls back automatically to sql.js (pure JS, no
 * native compile) if better-sqlite3 fails to load on this machine — in that
 * fallback mode every write still re-serialises the whole DB to disk, same
 * as before, so performance will degrade as data grows. Install/rebuild
 * better-sqlite3 to get native performance back.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable so the automated test suite can point at a throwaway file
// instead of the real tutor.db.
const DB_PATH = process.env.TUTOR_DB_PATH || path.join(__dirname, 'tutor.db');

let db;
let backend; // 'better-sqlite3' | 'sql.js'

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS topics (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      content   TEXT NOT NULL,
      source    TEXT NOT NULL,
      sourceRef TEXT DEFAULT '',
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS questions (
      id       TEXT PRIMARY KEY,
      topicId  TEXT NOT NULL,
      question TEXT NOT NULL,
      answer   TEXT NOT NULL,
      type     TEXT NOT NULL,        -- 'short' | 'mcq' | 'flashcard'
      options  TEXT DEFAULT NULL,    -- JSON array for MCQ
      origin   TEXT DEFAULT NULL,    -- 'ai' | 'local' | 'manual' — NULL for rows saved before this existed
      FOREIGN KEY (topicId) REFERENCES topics(id)
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      questionId  TEXT NOT NULL,
      correct     INTEGER NOT NULL,
      attemptedAt TEXT NOT NULL,
      FOREIGN KEY (questionId) REFERENCES questions(id)
    );
    CREATE TABLE IF NOT EXISTS history (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL DEFAULT 'global',
      role      TEXT NOT NULL,
      content   TEXT NOT NULL,
      ts        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS courses (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      createdAt   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS course_topics (
      id             TEXT PRIMARY KEY,
      courseId       TEXT NOT NULL,
      topicId        TEXT NOT NULL,
      position       INTEGER NOT NULL DEFAULT 0,
      prerequisiteId TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS progress_state (
      id           TEXT PRIMARY KEY,   -- "{topicId}:{mode}"
      topicId      TEXT NOT NULL,
      mode         TEXT NOT NULL,      -- 'quiz' | 'flashcard'
      currentIndex INTEGER NOT NULL DEFAULT 0,
      updatedAt    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,
      topicId           TEXT NOT NULL,
      mode              TEXT NOT NULL,          -- 'quiz' | 'flashcard'
      startedAt         TEXT NOT NULL,
      endedAt           TEXT DEFAULT NULL,
      questionsAnswered INTEGER NOT NULL DEFAULT 0,
      correctCount      INTEGER NOT NULL DEFAULT 0,
      totalTimeMs       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS explanations (
      topicId   TEXT PRIMARY KEY,
      main      TEXT NOT NULL,
      followups TEXT NOT NULL DEFAULT '[]',  -- JSON array of {q, a}
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (topicId) REFERENCES topics(id)
    );

    CREATE TABLE IF NOT EXISTS explanation_reads (
      topicId   TEXT PRIMARY KEY,
      readPct   INTEGER NOT NULL DEFAULT 0,  -- furthest scroll % reached, monotonic
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (topicId) REFERENCES topics(id)
    );

    -- roadmap #5 — indexes on the foreign-key columns actually hit by WHERE
    -- clauses (explanations/explanation_reads already have topicId as their
    -- PRIMARY KEY, and progress_state is always looked up by its composite
    -- id, so neither needs one here).
    CREATE INDEX IF NOT EXISTS idx_questions_topicId ON questions(topicId);
    CREATE INDEX IF NOT EXISTS idx_attempts_questionId ON attempts(questionId);
    CREATE INDEX IF NOT EXISTS idx_course_topics_courseId ON course_topics(courseId);
    CREATE INDEX IF NOT EXISTS idx_sessions_topicId ON sessions(topicId);
`;

export async function initDb() {
  try {
    // Preferred path: native SQLite, no in-memory export/rewrite needed.
    const { default: Database } = await import('better-sqlite3');
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    backend = 'better-sqlite3';
    db.exec(SCHEMA_SQL);
    runMigrations();
    console.log('[db] better-sqlite3 (native) — direct disk writes, no full-file rewrite per write.');
  } catch (err) {
    // No prebuilt binary for this platform/arch and nothing to compile with —
    // fall back to the pure-JS engine so the app still runs.
    console.warn(`[db] better-sqlite3 unavailable (${err.message.split('\n')[0]}) — falling back to sql.js.`);
    console.warn(`[db] Run "npm rebuild better-sqlite3" or reinstall it for native write performance.`);
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    db = fs.existsSync(DB_PATH)
      ? new SQL.Database(fs.readFileSync(DB_PATH))
      : new SQL.Database();
    backend = 'sql.js';
    db.run(`PRAGMA journal_mode = WAL;`);
    db.run(SCHEMA_SQL);
    runMigrations();
    persist();
  }
}

// roadmap #27 — migrations were three unconditional, order-dependent
// statements re-run (and re-swallowed-on-failure) on every single startup,
// with no record anywhere of which ones a given tutor.db had actually
// applied. That's fine right up until a migration stops being safely
// re-runnable (not every ALTER TABLE is idempotent the way "add a column"
// or "rename a value" are) — at which point there's no way to tell a fresh
// DB from one three versions behind, short of reading the schema by eye.
//
// SQLite's `user_version` pragma (an integer it reserves for exactly this,
// untouched by anything else) now records the highest migration number
// applied. Each migration below runs at most once per database, in order,
// and every one of them still has to be additive — this only adds
// *visibility* into that discipline, it doesn't replace it. Numbers are
// permanent once shipped: never renumber or edit a past entry, only append.
const MIGRATIONS = [
  {
    version: 1,
    description: "history: add sessionId column (isolate chat history per session)",
    run: () => run(`ALTER TABLE history ADD COLUMN sessionId TEXT NOT NULL DEFAULT 'global'`)
  },
  {
    version: 2,
    // roadmap #6 — the 'open' question type was replaced by 'short'. Same
    // free-text UI/grading path, just renamed; existing rows keep working.
    description: "questions: rename type 'open' -> 'short'",
    run: () => run(`UPDATE questions SET type = 'short' WHERE type = 'open'`)
  },
  {
    version: 3,
    // Manage panel shows whether each question is AI-written or locally
    // extracted. Rows from before this existed stay NULL ("Unknown source")
    // rather than guessing.
    description: "questions: add origin column ('ai' | 'local' | 'manual' | NULL)",
    run: () => run(`ALTER TABLE questions ADD COLUMN origin TEXT DEFAULT NULL`)
  }
];

function getUserVersion() {
  if (backend === 'better-sqlite3') return db.pragma('user_version', { simple: true });
  const res = db.exec('PRAGMA user_version;');
  return res[0]?.values?.[0]?.[0] ?? 0;
}

function setUserVersion(v) {
  if (backend === 'better-sqlite3') db.pragma(`user_version = ${v}`);
  else db.run(`PRAGMA user_version = ${v}`);
}

function runMigrations() {
  const startVersion = getUserVersion();
  const pending = MIGRATIONS.filter(m => m.version > startVersion);

  for (const m of pending) {
    // Each one still individually swallows its own failure (e.g. a column
    // that somehow already exists on a DB the version pragma doesn't know
    // about) rather than block startup — the version bump is what makes it
    // safe to swallow, since a real failure here is nearly always "already
    // applied," not "silently lost data."
    try { m.run(); } catch {}
    setUserVersion(m.version);
  }

  if (pending.length) {
    console.log(`[db] applied migration(s) ${pending.map(m => `#${m.version} (${m.description})`).join(', ')} — schema now at v${getUserVersion()}.`);
  } else {
    console.log(`[db] schema up to date at v${startVersion}.`);
  }
}

function persist() {
  // Only sql.js needs this: it keeps the whole DB in memory and has to
  // serialise and rewrite the entire file after every write. better-sqlite3
  // writes directly to disk per-statement, so this is a no-op for it.
  if (backend !== 'sql.js' || !db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// roadmap #20 — runs fn's writes as one all-or-nothing transaction so a
// failure partway through a multi-row batch (e.g. saveQuestions) rolls back
// instead of leaving some rows committed. Without this, server.js's tool-call
// retry would re-run the whole batch on top of whatever partially landed,
// duplicating rows.
function withTransaction(fn) {
  const exec = sql => { backend === 'better-sqlite3' ? db.exec(sql) : db.run(sql); };
  exec('BEGIN');
  try {
    const result = fn();
    exec('COMMIT');
    persist();
    return result;
  } catch (err) {
    exec('ROLLBACK');
    throw err;
  }
}

function query(sql, params = []) {
  if (backend === 'better-sqlite3') {
    return db.prepare(sql).all(...params);
  }
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  if (backend === 'better-sqlite3') {
    db.prepare(sql).run(...params);
    return; // already on disk — no export/rewrite pass needed
  }
  db.run(sql, params);
  persist();
}

// ── Topics ────────────────────────────────────────────────────────────────────

export function saveTopic({ name, content, source, sourceRef = '' }) {
  const id = genId();
  const createdAt = new Date().toISOString();
  run(`INSERT INTO topics (id, name, content, source, sourceRef, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`, [id, name, content, source, sourceRef, createdAt]);
  return { id, name, source, sourceRef, createdAt };
}

export function listTopics() {
  return query(`
    SELECT t.id, t.name, t.source, t.sourceRef, t.createdAt,
           (SELECT MAX(startedAt) FROM sessions WHERE topicId = t.id) AS lastStudiedAt
    FROM topics t
    ORDER BY t.createdAt DESC
  `).map(t => ({ ...t, ...topicStats(t.id) }));
}

export function getTopic(id) {
  const rows = query(`SELECT * FROM topics WHERE id = ?`, [id]);
  return rows[0] || null;
}

export function updateTopic(id, { name, content } = {}) {
  const topic = getTopic(id);
  if (!topic) return null;
  const newName    = name !== undefined && name !== null ? name : topic.name;
  const newContent = content !== undefined && content !== null ? content : topic.content;
  run(`UPDATE topics SET name = ?, content = ? WHERE id = ?`, [newName, newContent, id]);
  return getTopic(id);
}

export function deleteTopic(id) {
  const qids = query(`SELECT id FROM questions WHERE topicId = ?`, [id]).map(q => q.id);
  if (qids.length) {
    const ph = qids.map(() => '?').join(',');
    run(`DELETE FROM attempts WHERE questionId IN (${ph})`, qids);
    run(`DELETE FROM questions WHERE topicId = ?`, [id]);
  }
  run(`DELETE FROM explanations WHERE topicId = ?`, [id]);
  run(`DELETE FROM explanation_reads WHERE topicId = ?`, [id]);
  run(`DELETE FROM topics WHERE id = ?`, [id]);
  return { ok: true };
}

// ── Explanations ──────────────────────────────────────────────────────────────
// One cached explanation thread (main text + follow-up Q&A) per topic, shared
// across every browser/device instead of living only in one browser's
// localStorage — so a topic seeded on one machine shows its explanation
// everywhere the topic is opened.

export function saveExplanation(topicId, { main, followups = [] }) {
  const updatedAt = new Date().toISOString();
  run(`INSERT INTO explanations (topicId, main, followups, updatedAt) VALUES (?, ?, ?, ?)
       ON CONFLICT(topicId) DO UPDATE SET main = excluded.main, followups = excluded.followups, updatedAt = excluded.updatedAt`,
    [topicId, main, JSON.stringify(followups), updatedAt]);
  return { main, followups };
}

export function getExplanation(topicId) {
  const rows = query(`SELECT main, followups FROM explanations WHERE topicId = ?`, [topicId]);
  if (!rows[0]) return null;
  return { main: rows[0].main, followups: JSON.parse(rows[0].followups || '[]') };
}

// ── Questions ─────────────────────────────────────────────────────────────────

export function saveQuestions(topicId, questions) {
  return withTransaction(() => {
    const saved = [];
    for (const q of questions) {
      const id = genId();
      run(`INSERT INTO questions (id, topicId, question, answer, type, options, origin)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, topicId, q.question, q.answer, q.type,
         q.options ? JSON.stringify(q.options) : null, q.origin || null]);
      saved.push({ id, topicId, question: q.question, answer: q.answer, type: q.type, options: q.options || null, origin: q.origin || null });
    }
    return saved;
  });
}

export function getQuestions(topicId) {
  return query(`SELECT * FROM questions WHERE topicId = ?`, [topicId])
    .map(q => ({ ...q, options: q.options ? JSON.parse(q.options) : null }));
}

// Add a single manually-authored question (reuses saveQuestions under the hood).
export function addQuestion(topicId, q) {
  return saveQuestions(topicId, [q])[0];
}

export function updateQuestion(id, { question, answer, type, options, origin } = {}) {
  const rows = query(`SELECT * FROM questions WHERE id = ?`, [id]);
  const existing = rows[0];
  if (!existing) return null;

  const newQuestion = question !== undefined && question !== null ? question : existing.question;
  const newAnswer   = answer   !== undefined && answer   !== null ? answer   : existing.answer;
  const newType     = type     !== undefined && type     !== null ? type     : existing.type;
  const newOptions  = options !== undefined
    ? (options ? JSON.stringify(options) : null)
    : existing.options;
  // origin isn't user-editable from the Manage panel form today — this is
  // here for maintenance/backfill scripts (see roadmap: legacy questions
  // saved before origin tracking existed came back as NULL/"Unknown source").
  const newOrigin   = origin !== undefined ? origin : existing.origin;

  run(`UPDATE questions SET question = ?, answer = ?, type = ?, options = ?, origin = ? WHERE id = ?`,
    [newQuestion, newAnswer, newType, newOptions, newOrigin, id]);

  const r = query(`SELECT * FROM questions WHERE id = ?`, [id])[0];
  return { ...r, options: r.options ? JSON.parse(r.options) : null };
}

export function deleteQuestion(id) {
  run(`DELETE FROM attempts WHERE questionId = ?`, [id]);
  run(`DELETE FROM questions WHERE id = ?`, [id]);
  return { ok: true };
}

// Clears every question of one type for a topic (and their attempts) before
// a regenerate call saves a fresh set — generate-questions only ever
// produces one type per call ('flashcard' or 'mcq'), so this leaves any
// other type (e.g. manually-added 'short' questions) untouched.
export function deleteQuestionsByType(topicId, type) {
  const qids = query(`SELECT id FROM questions WHERE topicId = ? AND type = ?`, [topicId, type]).map(q => q.id);
  if (qids.length) {
    const ph = qids.map(() => '?').join(',');
    run(`DELETE FROM attempts WHERE questionId IN (${ph})`, qids);
    run(`DELETE FROM questions WHERE topicId = ? AND type = ?`, [topicId, type]);
  }
  return { ok: true, deleted: qids.length };
}

// ── Attempts & progress ───────────────────────────────────────────────────────

export function recordAttempt(questionId, correct) {
  run(`INSERT INTO attempts (questionId, correct, attemptedAt) VALUES (?, ?, ?)`,
    [questionId, correct ? 1 : 0, new Date().toISOString()]);
  return { questionId, correct };
}

function topicStats(topicId) {
  const qids = query(`SELECT id FROM questions WHERE topicId = ?`, [topicId]).map(q => q.id);
  if (!qids.length) return { totalQuestions: 0, attempted: 0, correct: 0, accuracy: null };

  const ph = qids.map(() => '?').join(',');
  const allAttempts = query(
    `SELECT questionId, correct FROM attempts WHERE questionId IN (${ph}) ORDER BY id ASC`, qids);

  const latest = {};
  for (const a of allAttempts) latest[a.questionId] = !!a.correct;

  const attempted = Object.keys(latest).length;
  const correct   = Object.values(latest).filter(Boolean).length;
  return {
    totalQuestions: qids.length,
    attempted,
    correct,
    accuracy: attempted ? Math.round((correct / attempted) * 100) : null
  };
}

export function getTopicProgress(topicId) {
  const topic = getTopic(topicId);
  if (!topic) return { error: 'Topic not found' };

  const stats = topicStats(topicId);
  const questions = getQuestions(topicId);

  const weakQuestions = questions.filter(q => {
    const last = query(`SELECT correct FROM attempts WHERE questionId = ? ORDER BY id DESC LIMIT 1`, [q.id]);
    return last.length > 0 && !last[0].correct;
  }).map(q => ({ id: q.id, question: q.question }));

  return { topicId, topicName: topic.name, ...stats, weakQuestions };
}

// Same accuracy math as topicStats(), but broken out per question type
// ('flashcard' | 'mcq' | 'short', and whatever types get added later —
// pick this up automatically with no code changes here).
function questionTypeStats(topicId) {
  const questions = query(`SELECT id, type FROM questions WHERE topicId = ?`, [topicId]);
  const byType = {};
  for (const q of questions) {
    (byType[q.type] ??= []).push(q.id);
  }

  const result = {};
  for (const [type, qids] of Object.entries(byType)) {
    const ph = qids.map(() => '?').join(',');
    const allAttempts = query(
      `SELECT questionId, correct FROM attempts WHERE questionId IN (${ph}) ORDER BY id ASC`, qids);

    const latest = {};
    for (const a of allAttempts) latest[a.questionId] = !!a.correct;

    const attempted = Object.keys(latest).length;
    const correct   = Object.values(latest).filter(Boolean).length;
    result[type] = {
      totalQuestions: qids.length,
      attempted,
      correct,
      accuracy: attempted ? Math.round((correct / attempted) * 100) : null
    };
  }
  return result;
}

// ── Explanation read tracking ────────────────────────────────────────────────
// Tracks the furthest % scrolled through a topic's explanation as a proxy for
// how much of it has actually been read. Monotonic — scrolling back up never
// lowers the recorded value.

export function recordExplanationRead(topicId, pct) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const existing = query(`SELECT readPct FROM explanation_reads WHERE topicId = ?`, [topicId])[0];
  const newPct = Math.max(existing?.readPct ?? 0, clamped);
  const updatedAt = new Date().toISOString();
  run(`INSERT INTO explanation_reads (topicId, readPct, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(topicId) DO UPDATE SET readPct = excluded.readPct, updatedAt = excluded.updatedAt`,
    [topicId, newPct, updatedAt]);
  return { topicId, readPct: newPct };
}

function explanationReadPct(topicId) {
  const row = query(`SELECT readPct FROM explanation_reads WHERE topicId = ?`, [topicId])[0];
  return row ? row.readPct : 0;
}

// Full stats breakdown for a topic's stats popup: explanation read %, overall
// question accuracy, and accuracy broken out per question type.
export function getTopicStats(topicId) {
  const topic = getTopic(topicId);
  if (!topic) return null;
  return {
    topicId,
    topicName: topic.name,
    explanationReadPct: explanationReadPct(topicId),
    ...topicStats(topicId),
    byType: questionTypeStats(topicId)
  };
}

// ── History ───────────────────────────────────────────────────────────────────
// Every message is tagged with a sessionId so different topics and wizard runs
// never bleed into each other. Pass the same sessionId on every call within
// one logical conversation.

export function appendHistory(role, content, sessionId = 'global') {
  const val = typeof content === 'string' ? content : JSON.stringify(content);
  run(`INSERT INTO history (sessionId, role, content, ts) VALUES (?, ?, ?, ?)`,
    [sessionId, role, val, new Date().toISOString()]);
  // Keep the last 40 messages *per session* so no single session blows up
  run(`DELETE FROM history WHERE sessionId = ? AND id NOT IN
    (SELECT id FROM history WHERE sessionId = ? ORDER BY id DESC LIMIT 40)`,
    [sessionId, sessionId]);
}

export function getHistory(sessionId = 'global') {
  return query(`SELECT role, content FROM history WHERE sessionId = ? ORDER BY id ASC`,
    [sessionId]);
}

export function clearHistory(sessionId = null) {
  // Pass a sessionId to clear just that session; omit to wipe everything
  if (sessionId) run(`DELETE FROM history WHERE sessionId = ?`, [sessionId]);
  else           run(`DELETE FROM history`);
}

// ── Courses ───────────────────────────────────────────────────────────────────

export function createCourse({ name, description = '' }) {
  const id = genId();
  const createdAt = new Date().toISOString();
  run(`INSERT INTO courses (id, name, description, createdAt) VALUES (?, ?, ?, ?)`,
    [id, name, description, createdAt]);
  return { id, name, description, createdAt };
}

export function listCourses() {
  return query(`SELECT * FROM courses ORDER BY createdAt DESC`).map(c => ({
    ...c,
    ...courseSummary(c.id)
  }));
}

export function getCourse(id) {
  const course = query(`SELECT * FROM courses WHERE id = ?`, [id])[0];
  if (!course) return null;
  return { ...course, topics: courseTopicsWithProgress(id) };
}

export function deleteCourse(id) {
  run(`DELETE FROM course_topics WHERE courseId = ?`, [id]);
  run(`DELETE FROM courses WHERE id = ?`, [id]);
  return { ok: true };
}

export function addTopicToCourse({ courseId, topicId, position, prerequisiteId = null }) {
  // Remove any existing entry for this topic in this course first
  run(`DELETE FROM course_topics WHERE courseId = ? AND topicId = ?`, [courseId, topicId]);
  const id = genId();
  if (position == null) {
    const row = query(`SELECT MAX(position) as m FROM course_topics WHERE courseId = ?`, [courseId])[0];
    position = (row.m ?? -1) + 1;
  }
  run(`INSERT INTO course_topics (id, courseId, topicId, position, prerequisiteId) VALUES (?, ?, ?, ?, ?)`,
    [id, courseId, topicId, position, prerequisiteId || null]);
  return { id, courseId, topicId, position, prerequisiteId };
}

export function removeTopicFromCourse(courseId, topicId) {
  run(`DELETE FROM course_topics WHERE courseId = ? AND topicId = ?`, [courseId, topicId]);
  return { ok: true };
}

export function reorderCourseTopics(courseId, orderedTopicIds) {
  orderedTopicIds.forEach((tid, i) =>
    run(`UPDATE course_topics SET position = ? WHERE courseId = ? AND topicId = ?`, [i, courseId, tid]));
  return { ok: true };
}

function courseSummary(courseId) {
  const topics = courseTopicsWithProgress(courseId);
  const done   = topics.filter(t => (t.accuracy ?? 0) >= 70).length;
  return { topicCount: topics.length, completedCount: done };
}

// Course stats popup: a per-topic progress bar (topic accuracy) plus one
// aggregate bar for the whole course — correct/attempted summed across every
// question in every topic, not an average of the topics' percentages, so a
// topic with more attempts weighs proportionally more.
export function getCourseStats(courseId) {
  const course = query(`SELECT * FROM courses WHERE id = ?`, [courseId])[0];
  if (!course) return null;

  const topics = courseTopicsWithProgress(courseId);
  const totalAttempted = topics.reduce((s, t) => s + t.attempted, 0);
  const totalCorrect   = topics.reduce((s, t) => s + t.correct, 0);

  return {
    courseId,
    courseName: course.name,
    aggregateAccuracy: totalAttempted ? Math.round((totalCorrect / totalAttempted) * 100) : null,
    topics: topics.map(t => ({
      id: t.id, name: t.name, position: t.position,
      totalQuestions: t.totalQuestions, attempted: t.attempted,
      correct: t.correct, accuracy: t.accuracy
    }))
  };
}

// ── Session resumption (quiz / flashcard position) ───────────────────────────
// Persists the in-progress index for a topic+mode so closing the app mid-quiz
// or mid-deck doesn't lose your place. Cleared automatically on completion or
// whenever the underlying question set is regenerated.

export function saveProgress(topicId, mode, currentIndex) {
  const id = `${topicId}:${mode}`;
  const updatedAt = new Date().toISOString();
  run(`INSERT INTO progress_state (id, topicId, mode, currentIndex, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET currentIndex = excluded.currentIndex, updatedAt = excluded.updatedAt`,
    [id, topicId, mode, currentIndex, updatedAt]);
  return { topicId, mode, currentIndex };
}

export function getProgress(topicId, mode) {
  const id = `${topicId}:${mode}`;
  const rows = query(`SELECT * FROM progress_state WHERE id = ?`, [id]);
  return rows[0] || null;
}

export function clearProgress(topicId, mode) {
  const id = `${topicId}:${mode}`;
  run(`DELETE FROM progress_state WHERE id = ?`, [id]);
  return { ok: true };
}

// ── Session-level stats ──────────────────────────────────────────────────────
// One row per quiz/flashcard run. Topic-level and question-level stats
// (mastery velocity, weak-spot tracking, per-question time trend) are
// intentionally NOT here yet — see roadmap backlog.

export function startSession(topicId, mode) {
  const id = genId();
  const startedAt = new Date().toISOString();
  run(`INSERT INTO sessions (id, topicId, mode, startedAt) VALUES (?, ?, ?, ?)`,
    [id, topicId, mode, startedAt]);
  return { id, topicId, mode, startedAt };
}

export function recordSessionAnswer(sessionId, correct, timeMs = 0) {
  run(`UPDATE sessions
       SET questionsAnswered = questionsAnswered + 1,
           correctCount      = correctCount + ?,
           totalTimeMs       = totalTimeMs + ?
       WHERE id = ?`,
    [correct ? 1 : 0, Math.max(0, Math.round(timeMs) || 0), sessionId]);
  return { ok: true };
}

export function endSession(sessionId) {
  run(`UPDATE sessions SET endedAt = ? WHERE id = ? AND endedAt IS NULL`,
    [new Date().toISOString(), sessionId]);
  return { ok: true };
}

// Removes a single logged session (e.g. a test run, or one you just want
// off your stats) — the question/answer data it was based on is untouched,
// only the stats-page record of having run it.
export function deleteSession(id) {
  run(`DELETE FROM sessions WHERE id = ?`, [id]);
  return { ok: true };
}

// Returns completed sessions, oldest-first internally (so sessionNumber counts
// up in study order), then reversed to most-recent-first for display. When
// topicId is omitted, sessionNumber counts across every topic in chronological
// order — labelled "session #" on the chart, but hover/tooltip should show
// the real date since numbers aren't comparable topic-to-topic.
export function listSessions({ topicId = null, mode = null, limit = null } = {}) {
  let sql = `SELECT * FROM sessions WHERE endedAt IS NOT NULL`;
  const params = [];
  if (topicId) { sql += ` AND topicId = ?`; params.push(topicId); }
  if (mode)    { sql += ` AND mode = ?`;    params.push(mode); }
  sql += ` ORDER BY startedAt ASC`;
  const rows = query(sql, params);

  const withStats = rows.map((r, i) => ({
    ...r,
    sessionNumber: i + 1,
    accuracy: r.questionsAnswered ? Math.round((r.correctCount / r.questionsAnswered) * 100) : null,
    avgTimeMs: r.questionsAnswered ? Math.round(r.totalTimeMs / r.questionsAnswered) : null,
    topicName: (getTopic(r.topicId) || {}).name || 'Unknown topic'
  }));

  const mostRecentFirst = withStats.slice().reverse();
  return limit ? mostRecentFirst.slice(0, limit) : mostRecentFirst;
}

// roadmap #6 — the totals below used to be computed by pulling every
// completed session row into Node and .reduce()/.filter()-ing over all of
// them; SQLite now does the SUM/COUNT directly, so only one summary row (plus
// one small distinct-days list for the streak) ever crosses the boundary,
// regardless of how many sessions have been logged.
export function getStatsSummary() {
  const totals = query(`
    SELECT COUNT(*)                             AS totalSessions,
           COALESCE(SUM(questionsAnswered), 0)  AS totalQuestions,
           COALESCE(SUM(correctCount), 0)       AS totalCorrect,
           COALESCE(SUM(totalTimeMs), 0)        AS totalTimeMs
    FROM sessions
    WHERE endedAt IS NOT NULL
  `)[0];
  const overallAccuracy = totals.totalQuestions
    ? Math.round((totals.totalCorrect / totals.totalQuestions) * 100)
    : null;

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { sessionsThisWeek } = query(
    `SELECT COUNT(*) AS sessionsThisWeek FROM sessions WHERE endedAt IS NOT NULL AND endedAt >= ?`,
    [weekAgo]
  )[0];

  // Streak = consecutive calendar days (UTC) with at least one completed
  // session, counting back from today (or yesterday, if none logged yet today).
  // The day-by-day walk is inherently sequential, not a plain aggregate, so
  // it stays in JS — but it now walks a DISTINCT day list (one row per
  // active day) instead of every session row.
  const dayRows = query(
    `SELECT DISTINCT substr(endedAt, 1, 10) AS day FROM sessions WHERE endedAt IS NOT NULL`
  );
  const days = new Set(dayRows.map(r => r.day));
  let streak = 0;
  const cursor = new Date();
  if (!days.has(cursor.toISOString().slice(0, 10))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return {
    overallAccuracy, streak, sessionsThisWeek,
    totalTimeMs: totals.totalTimeMs, totalSessions: totals.totalSessions
  };
}

function courseTopicsWithProgress(courseId) {
  const rows = query(`
    SELECT ct.id as ctId, ct.position, ct.prerequisiteId,
           t.id, t.name, t.source, t.createdAt
    FROM course_topics ct
    JOIN topics t ON t.id = ct.topicId
    WHERE ct.courseId = ?
    ORDER BY ct.position ASC
  `, [courseId]);

  if (!rows.length) return [];

  // roadmap #5 — one aggregate query for every topic's stats instead of
  // topicStats() in a per-topic loop (2 queries each: question ids, then
  // attempts) — a 10-topic course used to run 21 queries; this runs 1,
  // regardless of topic count. "Latest attempt per question" is picked via
  // an id = MAX(id) correlated subquery, matching topicStats()'s same
  // latest-attempt-wins semantics.
  const topicIds = rows.map(r => r.id);
  const ph = topicIds.map(() => '?').join(',');
  const statRows = query(`
    SELECT q.topicId AS topicId,
           COUNT(DISTINCT q.id) AS totalQuestions,
           COUNT(la.questionId) AS attempted,
           SUM(la.correct) AS correct
    FROM questions q
    LEFT JOIN attempts la
      ON la.questionId = q.id
     AND la.id = (SELECT MAX(a2.id) FROM attempts a2 WHERE a2.questionId = q.id)
    WHERE q.topicId IN (${ph})
    GROUP BY q.topicId
  `, topicIds);

  const statsByTopic = {};
  for (const s of statRows) {
    statsByTopic[s.topicId] = {
      totalQuestions: s.totalQuestions,
      attempted: s.attempted,
      correct: s.correct || 0,
      accuracy: s.attempted ? Math.round(((s.correct || 0) / s.attempted) * 100) : null
    };
  }

  return rows.map(r => ({
    ctId: r.ctId, id: r.id, name: r.name,
    source: r.source, position: r.position,
    prerequisiteId: r.prerequisiteId,
    ...(statsByTopic[r.id] || { totalQuestions: 0, attempted: 0, correct: 0, accuracy: null })
  }));
}
