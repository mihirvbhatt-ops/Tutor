import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';

import { toolDefinitions, executeTool } from './tools/study.js';
import {
  getApiKey, getApiKeySource, getProvider, saveApiKey, clearApiKey,
  getSearchProvider, getSearchApiKey, getSearchApiKeySource, saveSearchConfig, clearSearchConfig
} from './db/config.js';
import { localGrade } from './tools/similarity.js';
import { buildLocalQuestions } from './tools/localExtract.js';
import { extractDocxText, extractPptxText } from './tools/fileExtract.js';
import { normalizeExtractedText } from './tools/normalizeText.js';
import { scrapeUrl } from './tools/scraper.js';
import { webSearch, isKnownProvider } from './tools/webSearchProvider.js';
import { checkForUpdate } from './tools/updateCheck.js';
import {
  initDb,
  appendHistory, getHistory, clearHistory,
  saveTopic, listTopics, getTopic, updateTopic, deleteTopic,
  getQuestions, getTopicProgress, recordAttempt,
  addQuestion, updateQuestion, deleteQuestion, saveQuestions, deleteQuestionsByType,
  getTopicStats, recordExplanationRead,
  createCourse, listCourses, getCourse, deleteCourse, getCourseStats,
  addTopicToCourse, removeTopicFromCourse, reorderCourseTopics,
  saveProgress, getProgress, clearProgress,
  startSession, recordSessionAnswer, endSession, deleteSession, listSessions, getStatsSummary,
  saveExplanation, getExplanation
} from './db/sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3001;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// roadmap #3 — the key can now be set from Settings (db/config.js) instead
// of only via .env, and can change at runtime without a restart, so the
// client is built fresh per call rather than once at module load. Every
// call site that needs one goes through requireApiKey() first, which throws
// a distinguishable, pre-flight error (no wasted round-trip to Anthropic)
// when no key is configured yet — callers surface err.code to the frontend
// so it can offer a "Go to Settings" action instead of a generic failure.
class NoApiKeyError extends Error {
  constructor() {
    super('No Anthropic API key configured — add one in Settings.');
    this.code = 'NO_API_KEY';
    this.status = 400;
  }
}
function requireApiKey() {
  const apiKey = getApiKey();
  if (!apiKey) throw new NoApiKeyError();
  return new Anthropic({ apiKey });
}

// ── System prompt ─────────────────────────────────────────────────────────────

// Static — no interpolated values — so it can be cached in full via
// cache_control. Today's date is appended as a separate, uncached system
// block at call time instead of being baked in here, since interpolating it
// into this string would bust the cache on every single day.
const SYSTEM_PROMPT = `You are a focused AI tutor. Your only job is to help the user learn.

You have tools for: study topics, questions/flashcards, attempt recording, courses/syllabi, web scraping, and web search.

Core study rules:
- Always call get_topic before explaining, quizzing, or making flashcards — work from saved material, not your own knowledge.
- If get_topic comes back with little or no reference material, use web_search to find real, current sources on the topic before explaining or writing questions — don't fall back on unaided training knowledge, which can be outdated. Never use web_search when solid reference material already exists; work from that material instead of second-guessing it.
- EXPLAIN: structure as → core concept → key details → worked example → common misconceptions.
- QUIZ: call save_questions before presenting. Generate exactly the number of questions the user asked for; if they didn't give a count, default to 10 mcq-type questions so grading happens locally with no extra API calls. Walk through one at a time, record_attempt after each, give brief feedback.
- FLASHCARD: present front, wait for response, reveal back, ask if they got it, call record_attempt.
- PROGRESS: call get_topic_progress, summarise accuracy, strengths, what to revisit.

Course / syllabus rules:
- When asked to create a course or syllabus: call create_course, then add_topic_to_course for each topic in order (position 0, 1, 2…). Set prerequisiteId where one topic must come before another.
- When asked for a study guide for a course: call get_course to get the ordered topic list, then call get_topic for each one in order, then write a comprehensive markdown guide with ## sections per topic and cross-references between related topics.

Lecture summarisation rules:
- When given lecture content to summarise: save it as a topic using save_topic, then write a structured summary with these ## sections: Overview, Key Points, Definitions, Notable Figures/Dates/Statistics. Also call save_questions to generate flashcards from the key points and definitions — the number the user asked for, or 8 by default if they didn't specify.
- Return the structured summary as your final text response.

Keep responses tight. If asked about something unrelated to studying, politely redirect.`;

// roadmap #1 — Anthropic's own server-side web search tool: Claude invokes
// it and Anthropic executes the search directly, so results land as content
// blocks in the same response with no client round trip — unlike the tools
// in tools/study.js, which this app must dispatch and execute itself (see
// executeTool below; a server_tool_use block never reaches that switch).
// max_uses bounds searches per agent turn so one request can't spiral into
// an unbounded number of billed searches.
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 };

// Tool definitions are static for the life of the process, so mark the last
// one with a cache breakpoint — the prompt-cache write covers every tool
// schema up to and including it (~1,800 tokens), reused read-only on every
// subsequent call in the session instead of being resent at full price.
const CACHED_TOOLS = [...toolDefinitions, WEB_SEARCH_TOOL].map((t, i, arr) =>
  i === arr.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t
);

// ── Retry wrapper ─────────────────────────────────────────────────────────────
// Retries a function up to maxAttempts times with exponential back-off.
// Skips retrying on auth/bad-request errors (those won't self-heal).

// roadmap #20 — a 429's Retry-After header (seconds, or an HTTP date) tells
// us exactly how long the API wants us to back off; ignoring it and retrying
// on our own fixed schedule risks hammering the API again mid-cooldown.
function retryDelayMs(err, fallbackMs) {
  const status = err.status ?? err.statusCode;
  if (status !== 429) return fallbackMs;
  const header = err.headers?.['retry-after'];
  if (!header) return fallbackMs;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : fallbackMs;
}

async function withRetry(fn, maxAttempts = 3, baseDelayMs = 1200) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.status ?? err.statusCode;
      if (err.noRetry || status === 400 || status === 401 || status === 403) throw err; // non-retryable
      if (attempt < maxAttempts) {
        const delay = retryDelayMs(err, baseDelayMs * attempt);
        console.warn(`API call failed (attempt ${attempt}/${maxAttempts}): ${err.message} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Agent loop ─────────────────────────────────────────────────────────────────
// sessionId scopes history so different topics and wizard runs never bleed together.

// roadmap #13 — Anthropic caps a request at 4 cache breakpoints total; the
// system prompt and tool schemas already use one each (see above), leaving
// room for exactly one more. Rather than adding a fresh breakpoint every
// turn (which would blow that cap by turn 3 of a tool-calling loop), this
// strips whatever breakpoint was left on an earlier message and re-places
// a single sliding one on the true last block of the last message — so
// turn N+1 reads turn N's growing prefix from cache instead of paying for
// it again. A plain string message gets wrapped into a one-block array
// first since cache_control only attaches to a content block, not a string.
function markCacheBreakpoint(messages) {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const block of m.content) delete block.cache_control;
    }
  }
  const last = messages[messages.length - 1];
  if (!last) return;
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(last.content) && last.content.length) {
    last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
  }
}

// roadmap #14 — each turn streams via the Anthropic SDK's MessageStream
// instead of a single blocking create() call, forwarding text deltas to
// onDelta as they arrive (so callers can render partial output live instead
// of showing a spinner for the full multi-turn duration) and threading the
// caller's AbortSignal through so a client disconnect actually cancels the
// in-flight generation server-side rather than running — and being billed —
// to completion anyway. finalMessage() resolves to the same Message shape
// `.create()` returned, so the tool-calling loop below is unchanged.
// Once any delta has been forwarded for a turn, a failure on that turn is
// not retried (would duplicate text already shown to the caller) — it's
// marked non-retryable and surfaces as a real error instead.
async function runAgent(userMessage, sessionId = 'global', { onDelta, signal } = {}) {
  const client = requireApiKey(); // throws before anything is recorded to history
  appendHistory('user', userMessage, sessionId);
  let messages = [...getHistory(sessionId)];
  const MAX_TURNS = 10;
  let finalText = '';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    markCacheBreakpoint(messages);
    let streamedAny = false;
    const response = await withRetry(async () => {
      const stream = client.messages.stream({
        model:      'claude-sonnet-4-6',
        max_tokens: 2000,
        // Tools cached above; system prompt cached here as its own breakpoint
        // (layers on top of the cached tools); today's date rides along
        // uncached in a second block so it never invalidates either cache.
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: `Today's date: ${new Date().toISOString().slice(0, 10)}.` }
        ],
        tools:      CACHED_TOOLS,
        messages
      }, { signal });
      if (onDelta) stream.on('text', delta => { streamedAny = true; onDelta(delta); });
      try {
        return await stream.finalMessage();
      } catch (err) {
        if (streamedAny) err.noRetry = true;
        throw err;
      }
    });

    if (response.stop_reason !== 'tool_use') {
      finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      messages.push({ role: 'assistant', content: response.content });
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        let result;
        try {
          // Tool calls also get one retry — network hiccups during file I/O etc.
          result = await withRetry(() => executeTool(block.name, block.input), 2, 800);
        } catch (err) {
          result = { error: err.message };
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  if (!finalText) finalText = '(Reached tool call limit — try a more focused question.)';
  appendHistory('assistant', finalText, sessionId);
  return finalText;
}

// ── Middleware ────────────────────────────────────────────────────────────────

// roadmap #7 — gzip/brotli-compresses every response (static app.js/styles.css
// on cold load, and JSON API responses) instead of shipping a frontend
// bundler/build step. Captures most of the transfer-weight win with none of
// the added build-process complexity (stale dist output, sourcemaps, service
// worker cache-key changes) that a real bundler would introduce.
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Chat endpoint ─────────────────────────────────────────────────────────────

// roadmap #14 — streams the reply over SSE (a 'delta' event per text chunk,
// then one 'done' event carrying the full reply, matching the old
// { reply } shape for callers that just want the final text) instead of
// blocking on the full multi-turn agent loop and returning one blob.
// Disconnecting the client aborts the in-flight Anthropic call via the
// AbortController below rather than leaving it to run to completion unread.
app.post('/api/chat', async (req, res) => {
  const { message, sessionId = 'global' } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // res 'close' (not req 'close') fires only when the underlying connection
  // actually goes away — req 'close' fires as soon as the request body has
  // finished arriving, which is almost immediately, aborting every call
  // before the reply could ever be sent. The writableEnded check keeps a
  // normal, already-finished response from tripping this on its own way out.
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  try {
    const reply = await runAgent(message, sessionId, {
      signal: controller.signal,
      onDelta: text => send('delta', { text })
    });
    send('done', { reply });
  } catch (err) {
    if (!controller.signal.aborted) {
      if (err.code !== 'NO_API_KEY') console.error(err);
      send('error', { error: err.message, code: err.code });
    }
  } finally {
    res.end();
  }
});

app.post('/api/chat/reset', (req, res) => {
  const { sessionId } = req.body || {};
  clearHistory(sessionId || null);
  res.json({ ok: true });
});

// ── Dedicated quiz evaluation endpoint ───────────────────────────────────────
// Completely isolated from session history — a fresh API call every time.
// Returns { correct: boolean, feedback: string }
// This fixes: inconsistency from history bleed, wasted tool-call overhead,
// and the full agent loop round-trip for a simple right/wrong judgement.
//
// Ahead of the API call, a local (no-network) similarity pre-check handles
// the confident ends of the distribution for free: near-exact matches are
// auto-accepted and clearly off-topic answers are auto-rejected. Only the
// ambiguous middle band — where judging a paraphrase actually needs real
// understanding — still reaches the model, on the cheaper Haiku tier since
// this is an isolated classification task, not open-ended tutoring.

app.post('/api/evaluate', async (req, res) => {
  const { question, correctAnswer, userAnswer } = req.body;
  if (!question || !userAnswer) {
    return res.status(400).json({ error: 'question and userAnswer are required' });
  }

  if (correctAnswer) {
    const { decision } = localGrade(correctAnswer, userAnswer);
    if (decision === 'accept') {
      return res.json({ correct: true, feedback: 'Matches the expected answer.' });
    }
    if (decision === 'reject') {
      return res.json({ correct: false, feedback: `Doesn't match — the expected answer was: ${correctAnswer}` });
    }
  }

  try {
    const client = requireApiKey();
    const response = await withRetry(() => client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 200,
      system:     'You are a quiz answer evaluator. Accept answers that demonstrate correct understanding even if worded differently from the model answer. Be fair and brief. Respond ONLY with valid JSON — no markdown, no explanation outside the JSON.',
      messages: [{
        role: 'user',
        content: `Question: ${question}\nModel answer: ${correctAnswer}\nStudent answered: "${userAnswer}"\n\nRespond with this exact JSON shape:\n{"correct": true, "feedback": "one concise sentence"}`
      }]
    }));

    const raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    let result;
    try {
      result = JSON.parse(raw.replace(/^```json|^```|```$/gm, '').trim());
    } catch {
      // Claude didn't return clean JSON — parse intent from text.
      // roadmap #12 — a plain positive-keyword scan false-positived on
      // phrases like "That's not correct" (contains "correct"), marking
      // wrong answers as right. Negation phrases are checked first so
      // they win over the substring match they contain.
      let correct;
      if (/\b(incorrect|inaccurate|isn'?t (?:quite )?(?:correct|right)|not (?:quite )?(?:correct|right)|wrong)\b/i.test(raw)) {
        correct = false;
      } else {
        correct = /\b(correct|right|yes|good|well done|exactly|spot on)\b/i.test(raw);
      }
      result = { correct, feedback: raw.slice(0, 200) };
    }
    res.json(result);
  } catch (err) {
    if (err.code !== 'NO_API_KEY') console.error(err);
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

// ── Hybrid question generation (roadmap #6) ─────────────────────────────────
// Local extraction (tools/localExtract.js) covers the "easy" definitional
// tier — flashcards, short-answer, and MCQ from pattern-matched terms/cloze
// sentences — with zero API calls. This covers only the small, fixed "hard"
// synthesis tier (why/how/compare) that local extraction can't produce.
// One isolated call, no tools, no session history — same spirit as
// /api/evaluate's Haiku fallback, just on the main model since generation
// quality matters more here than a right/wrong judgement call.

const HARD_TIER_COUNT = 3;
// "AI only" generation has no local tier alongside it to cover the easy,
// factual half of the set, so it asks for a full-size set instead of just
// the small hard-tier count — same target size local extraction aims for.
const FULL_AI_COUNT = 10;

async function generateHardQuestions(topic, type, count, { fullSet = false } = {}) {
  const client = requireApiKey();
  const shapeHint = type === 'mcq'
    ? '"type":"mcq","options":[four strings, one of which equals answer exactly]'
    : `"type":"${type}"`;

  // The hard tier is deliberately synthesis-only (why/how/compare) since it
  // exists to cover what local extraction can't. "AI only" mode has nothing
  // else covering plain factual recall, so it needs a well-rounded mix instead.
  let system = fullSet
    ? 'You write clear study questions from reference material — a well-rounded mix of straightforward ' +
      'factual/definitional recall and deeper why/how/compare/relate understanding. Respond ONLY with a ' +
      'valid JSON array — no markdown, no explanation outside the JSON.'
    : 'You write hard, synthesis-level study questions from reference material — the kind that need ' +
      'real understanding (why/how/compare/relate), not recall of a single fact. Respond ONLY with a ' +
      'valid JSON array — no markdown, no explanation outside the JSON.';

  // roadmap #1 — a "Use AI" topic has no reference material at all (empty
  // content), so unlike the agent loop's tools (static/cached across every
  // call — see CACHED_TOOLS above), this single-shot call can just check
  // topic.content directly and only pay for search when there's actually
  // nothing to work from.
  const noMaterial = !topic.content?.trim();
  if (noMaterial) system += ' No reference material was provided for this topic — use web_search to find accurate, current information about it before writing questions.';

  const response = await withRetry(() => client.messages.create({
    model:      'claude-sonnet-4-6',
    // Scales with count — the fixed 1200 the hard tier used is enough for
    // 3 questions but truncates a full-size 10-question "AI only" set.
    max_tokens: Math.max(1200, count * 350),
    system,
    ...(noMaterial ? { tools: [WEB_SEARCH_TOOL] } : {}),
    messages: [{
      role: 'user',
      // roadmap #12 — split off the reference material as its own cached
      // block. Quiz and flashcard generation both call this for the same
      // topic back-to-back (see app.js), so the second call reads this
      // block from cache instead of paying full price for it again. The
      // per-call instructions (type/count vary) stay outside the cached
      // prefix so they never bust the cache.
      content: [
        {
          type: 'text',
          text: `Reference material for "${topic.name}":\n${topic.content}`,
          cache_control: { type: 'ephemeral' }
        },
        {
          type: 'text',
          text:
            `Write exactly ${count} ${fullSet ? '' : 'hard '}questions of type "${type}" from this material. Each array element: ` +
            `{"question":"...","answer":"...",${shapeHint}}. ` +
            (type === 'mcq'
              ? 'Write plausible wrong options grounded in the same material, not random text.'
              : 'The answer should be concise and gradable — a sentence or two, not an essay.')
        }
      ]
    }]
  }));

  const raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^```json|^```|```$/gm, '').trim());
  } catch {
    return []; // Malformed output — local items still stand on their own.
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(q => q && q.question && q.answer)
    .map(q => ({ question: q.question, answer: q.answer, type, options: type === 'mcq' ? (q.options || null) : null }));
}

const LOCAL_CAP = 10;
const COUNT_MIN = 1;
const COUNT_MAX = 25;

// Caller-supplied override for how many questions to generate from each
// source, so "With AI"/"Without AI"/"Both" aren't stuck at fixed sizes.
// Falls back to the previous hardcoded default when omitted or out of range.
function clampCount(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= COUNT_MIN && n <= COUNT_MAX ? n : fallback;
}

function normalizeQuestionText(text) {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

app.post('/api/topics/:id/generate-questions', async (req, res) => {
  const topic = getTopic(req.params.id);
  if (!topic) return res.status(404).json({ error: 'Not found' });

  const { mode, source = 'hybrid', replace = true, aiCount, localCount } = req.body;
  if (!['flashcard', 'quiz'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be "flashcard" or "quiz"' });
  }
  if (!['hybrid', 'local', 'ai'].includes(source)) {
    return res.status(400).json({ error: 'source must be "hybrid", "local", or "ai"' });
  }
  const itemType = mode === 'flashcard' ? 'flashcard' : 'mcq';
  const resolvedLocalCap = clampCount(localCount, LOCAL_CAP);
  const resolvedAiCount  = clampCount(aiCount, source === 'ai' ? FULL_AI_COUNT : HARD_TIER_COUNT);

  // 'local' — zero-API-call pattern extraction only. 'ai' — skips local
  // extraction entirely and asks the model for a full well-rounded set.
  // 'hybrid' (default) — local for the easy tier, a small AI tier on top
  // for the synthesis-style questions local extraction can't produce.
  const localItems = (source === 'ai' ? [] : buildLocalQuestions(topic.content, itemType, resolvedLocalCap))
    .map(q => ({ ...q, origin: 'local' }));

  let aiItems = [];
  if (source !== 'local') {
    try {
      aiItems = (source === 'ai'
        ? await generateHardQuestions(topic, itemType, resolvedAiCount, { fullSet: true })
        : await generateHardQuestions(topic, itemType, resolvedAiCount)).map(q => ({ ...q, origin: 'ai' }));
    } catch (err) {
      if (err.code !== 'NO_API_KEY') console.warn(`[generate-questions] AI generation failed: ${err.message}`);
      if (source === 'ai') {
        return res.status(err.status || 500).json({
          error: err.code === 'NO_API_KEY' ? err.message : 'AI question generation failed — check the API key and try again.',
          code: err.code
        });
      }
    }
  }

  const rawAll = [...localItems, ...aiItems];
  if (!rawAll.length) {
    const error = source === 'local'
      ? 'No definitional patterns found in this material for local extraction — try "With AI" or "Both" instead.'
      : 'Could not generate any questions — check the API key and try again.';
    return res.status(500).json({ error });
  }

  // Local extraction is deterministic — same content in, same items out —
  // so clicking "Add More" repeatedly on unchanged material used to append
  // an identical batch every single time. Drop anything that duplicates
  // another item in this same batch, and (for append mode) anything that
  // duplicates a question already saved for this topic/type.
  const existingKeys = replace
    ? new Set()
    : new Set(getQuestions(topic.id).filter(q => q.type === itemType).map(q => normalizeQuestionText(q.question)));
  const seen = new Set();
  const all = rawAll.filter(q => {
    const key = normalizeQuestionText(q.question);
    if (existingKeys.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!all.length) {
    return res.status(500).json({
      error: 'No new questions — everything generated already matches what\'s already saved. Try a different source, a different count, or add more reference material.'
    });
  }

  // replace=true (default) — this endpoint doubles as "regenerate" for
  // topics that already have questions (Manage panel), and generate-questions
  // only ever produces one type per call, so clearing leaves other types
  // (e.g. manually-added 'short' questions) untouched. Only clears the old
  // set once the new one is confirmed non-empty, so a failed generation
  // never wipes out an existing question set for nothing.
  // replace=false — "Add More" in the Manage panel: appends instead, for
  // topping up a set without losing what's already there (and any stats
  // already recorded against those questions).
  if (replace) deleteQuestionsByType(topic.id, itemType);
  res.json(saveQuestions(topic.id, all));
});

// ── File upload ───────────────────────────────────────────────────────────────

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { originalname, mimetype, buffer } = req.file;
    const ext = originalname.split('.').pop().toLowerCase();
    let text = '';
    let isDocumentExtraction = true; // PDF/DOCX/PPTX carry page/slide artifacts worth normalizing; plain text doesn't

    if (mimetype === 'application/pdf' || ext === 'pdf') {
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
      text = (await pdfParse(buffer)).text;

    } else if (
      mimetype.includes('wordprocessingml') ||
      mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      ext === 'docx'
    ) {
      text = await extractDocxText(buffer);

    } else if (
      mimetype.includes('presentationml') ||
      mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      ext === 'pptx'
    ) {
      text = extractPptxText(buffer);

    } else if (mimetype.startsWith('text/') || ext === 'txt') {
      text = buffer.toString('utf-8');
      isDocumentExtraction = false;

    } else {
      return res.status(400).json({
        error: `Unsupported file type: .${ext}. Supported: PDF, DOCX, PPTX, TXT`
      });
    }

    if (isDocumentExtraction) text = normalizeExtractedText(text);

    if (!text.trim()) return res.status(400).json({ error: 'No text could be extracted from this file.' });

    // No more silent truncation-without-warning. We hand back the full extracted
    // text (and its length) so the client can show the user exactly how much
    // material there is and let them choose what to keep. The only limit here
    // is a generous hard safety cap purely to stop a pathological file (e.g. a
    // 500-page PDF) from producing an unworkable multi-megabyte payload.
    const HARD_CAP = 300000;
    const hardCapped = text.length > HARD_CAP;
    const content = hardCapped ? text.slice(0, HARD_CAP) : text;

    res.json({ filename: originalname, content, length: content.length, fullLength: text.length, hardCapped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Data endpoints (no LLM round-trip) ───────────────────────────────────────

// How many search results to scrape per query — enough to assemble a
// reasonable amount of material without turning one topic creation into a
// dozen outbound page fetches.
const SEARCH_RESULT_COUNT = 4;

// roadmap #10 — saves the topic directly via SQL insert instead of routing
// through the chat agent, which previously had to echo the full reference
// material back inside a save_topic tool call capped at max_tokens: 2000
// (~8,000 characters) — silently truncating or failing on anything longer,
// while billing a full round-trip just to transcribe text the server
// already has. For a 'url' source with no content given, scrapes server-side
// (no model involved) since the agent no longer performs that step either.
app.post('/api/topics', async (req, res) => {
  try {
    const { name, source } = req.body;
    let { content = '', sourceRef = '' } = req.body;
    if (!name || !source) return res.status(400).json({ error: 'name and source are required' });

    if (source === 'url' && !content) {
      const target = sourceRef || req.body.url;
      if (!target) return res.status(400).json({ error: 'sourceRef (URL) is required for source "url"' });
      const scraped = await scrapeUrl(target);
      if (scraped.error) return res.status(400).json({ error: scraped.error });
      content = scraped.text;
      sourceRef = target;
    }

    // roadmap #1 — a BYO search-provider key (Tavily/Brave/Serper, Settings)
    // finds candidate pages for a query with no reference material given,
    // then reuses scrapeUrl (already SSRF-hardened) to pull each page's text
    // — same trust boundary as the 'url' source above, just multiple pages
    // instead of one the user picked themselves.
    if (source === 'search' && !content) {
      const query = sourceRef || req.body.query;
      if (!query) return res.status(400).json({ error: 'sourceRef (search query) is required for source "search"' });

      const provider = getSearchProvider();
      const apiKey = getSearchApiKey();
      if (!apiKey) return res.status(400).json({ error: 'No search API key configured — add one in Settings.', code: 'NO_SEARCH_KEY' });

      const found = await webSearch(query, provider, apiKey, SEARCH_RESULT_COUNT);
      if (found.error) return res.status(400).json({ error: found.error });
      if (!found.results.length) return res.status(400).json({ error: 'No search results for that query — try rephrasing it.' });

      const scraped = await Promise.all(found.results.map(r => scrapeUrl(r.url)));
      const sections = found.results
        .map((r, i) => ({ r, s: scraped[i] }))
        .filter(({ s }) => !s.error)
        .map(({ r, s }) => `# ${s.title || r.title}\nSource: ${s.url}\n\n${s.text}`);
      if (!sections.length) return res.status(400).json({ error: 'Could not read any of the search results — try a different query.' });

      content = normalizeExtractedText(sections.join('\n\n---\n\n'));
      sourceRef = query;
    }

    res.status(201).json(saveTopic({ name, content, source, sourceRef }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/topics',                   (req, res) => res.json(listTopics()));
app.get('/api/topics/:id',               (req, res) => {
  const t = getTopic(req.params.id);
  t ? res.json(t) : res.status(404).json({ error: 'Not found' });
});
app.patch('/api/topics/:id',             (req, res) => {
  const t = updateTopic(req.params.id, req.body);
  t ? res.json(t) : res.status(404).json({ error: 'Not found' });
});
app.delete('/api/topics/:id',            (req, res) => res.json(deleteTopic(req.params.id)));
app.get('/api/topics/:id/questions',     (req, res) => res.json(getQuestions(req.params.id)));
app.get('/api/topics/:id/progress',      (req, res) => res.json(getTopicProgress(req.params.id)));

// ── Topic stats popup (explanation read % + overall/per-type question accuracy) ──
app.get('/api/topics/:id/stats', (req, res) => {
  const s = getTopicStats(req.params.id);
  s ? res.json(s) : res.status(404).json({ error: 'Not found' });
});
app.post('/api/topics/:id/explanation-read', (req, res) => {
  const { pct } = req.body;
  if (pct == null || Number.isNaN(Number(pct))) return res.status(400).json({ error: 'pct required' });
  res.json(recordExplanationRead(req.params.id, Number(pct)));
});

// ── Explanation cache (main text + follow-up thread), shared server-side ────
app.get('/api/topics/:id/explanation',  (req, res) => res.json(getExplanation(req.params.id)));
app.post('/api/topics/:id/explanation', (req, res) => {
  const { main, followups } = req.body;
  if (!main) return res.status(400).json({ error: 'main is required' });
  res.json(saveExplanation(req.params.id, { main, followups }));
});

// ── Manual question creation & editing ───────────────────────────────────────
app.post('/api/topics/:id/questions', (req, res) => {
  const { question, answer, type, options } = req.body;
  if (!question || !answer || !type) {
    return res.status(400).json({ error: 'question, answer and type are required' });
  }
  res.json(addQuestion(req.params.id, { question, answer, type, options, origin: 'manual' }));
});
app.patch('/api/questions/:id', (req, res) => {
  const q = updateQuestion(req.params.id, req.body);
  q ? res.json(q) : res.status(404).json({ error: 'Not found' });
});
app.delete('/api/questions/:id', (req, res) => res.json(deleteQuestion(req.params.id)));

// ── Session resumption (quiz / flashcard position) ───────────────────────────
app.get('/api/session-progress/:topicId/:mode', (req, res) => {
  res.json(getProgress(req.params.topicId, req.params.mode) || { currentIndex: 0 });
});
app.post('/api/session-progress', (req, res) => {
  const { topicId, mode, currentIndex } = req.body;
  if (!topicId || !mode || currentIndex == null) {
    return res.status(400).json({ error: 'topicId, mode and currentIndex are required' });
  }
  res.json(saveProgress(topicId, mode, currentIndex));
});
app.delete('/api/session-progress/:topicId/:mode', (req, res) => {
  res.json(clearProgress(req.params.topicId, req.params.mode));
});

// ── Course / Syllabus endpoints ───────────────────────────────────────────────
app.post('/api/courses',      (req, res) => res.json(createCourse(req.body)));
app.get('/api/courses',       (req, res) => res.json(listCourses()));
app.get('/api/courses/:id',   (req, res) => {
  const c = getCourse(req.params.id);
  c ? res.json(c) : res.status(404).json({ error: 'Not found' });
});
app.delete('/api/courses/:id', (req, res) => res.json(deleteCourse(req.params.id)));
app.get('/api/courses/:id/stats', (req, res) => {
  const s = getCourseStats(req.params.id);
  s ? res.json(s) : res.status(404).json({ error: 'Not found' });
});
app.post('/api/courses/:id/topics', (req, res) => {
  res.json(addTopicToCourse({ courseId: req.params.id, ...req.body }));
});
app.delete('/api/courses/:id/topics/:topicId', (req, res) => {
  res.json(removeTopicFromCourse(req.params.id, req.params.topicId));
});
app.patch('/api/courses/:id/reorder', (req, res) => {
  res.json(reorderCourseTopics(req.params.id, req.body.orderedTopicIds));
});

// ── Direct attempt recording (no LLM round-trip needed) ─────────────────────
app.post('/api/record-attempt', (req, res) => {
  const { questionId, correct } = req.body;
  if (!questionId) return res.status(400).json({ error: 'questionId required' });
  const result = recordAttempt(questionId, !!correct);
  res.json(result);
});

// ── Session-level stats (accuracy/time tracked per quiz or flashcard run) ────
// Topic-level and question-level stats are backlog items — see roadmap.
app.post('/api/sessions/start', (req, res) => {
  const { topicId, mode } = req.body;
  if (!topicId || !mode) return res.status(400).json({ error: 'topicId and mode are required' });
  res.json(startSession(topicId, mode));
});
app.patch('/api/sessions/:id', (req, res) => {
  const { correct, timeMs } = req.body;
  res.json(recordSessionAnswer(req.params.id, !!correct, timeMs));
});
app.post('/api/sessions/:id/end', (req, res) => res.json(endSession(req.params.id)));
app.delete('/api/sessions/:id', (req, res) => res.json(deleteSession(req.params.id)));
app.get('/api/sessions', (req, res) => {
  const { topicId, mode, limit } = req.query;
  res.json(listSessions({ topicId: topicId || null, mode: mode || null, limit: limit ? parseInt(limit, 10) : null }));
});
app.get('/api/sessions/summary', (req, res) => res.json(getStatsSummary()));

// ── Font discovery ────────────────────────────────────────────────────────────
// Drop any .woff2 / .woff / .ttf / .otf into public/fonts/ and they appear
// automatically in the Settings font picker.
const FONTS_DIR  = path.join(__dirname, 'public', 'fonts');
const FONT_EXTS  = new Set(['.woff2', '.woff', '.ttf', '.otf']);
// Suffixes to strip when deriving a family name from filename
const WEIGHT_RX  = /[-_](Regular|Bold|Italic|Light|Medium|SemiBold|ExtraBold|Black|Thin|Heavy|BoldItalic|LightItalic|MediumItalic)$/i;

function scanFonts() {
  if (!fs.existsSync(FONTS_DIR)) return [];
  const files = fs.readdirSync(FONTS_DIR)
    .filter(f => FONT_EXTS.has(path.extname(f).toLowerCase()));

  const families = {};
  for (const file of files) {
    const ext    = path.extname(file);
    const base   = path.basename(file, ext);
    const family = base.replace(WEIGHT_RX, '').replace(/[-_]/g, ' ').trim();
    if (!families[family]) families[family] = [];
    families[family].push(file);
  }
  return Object.entries(families).map(([family, files]) => ({ family, files }));
}

app.get('/api/fonts', (req, res) => res.json(scanFonts()));

// ── Packaged installer & update mechanism (roadmap #4) ──────────────────────
app.get('/api/update-check', async (req, res) => res.json(await checkForUpdate()));

// ── Settings: AI provider / API key (roadmap #3) ────────────────────────────
// The key never round-trips back to the client once saved — only a status
// and a last-4-characters preview, enough to confirm which key is active
// without re-displaying the secret itself.
function keyPreview(key) {
  return key ? `…${key.slice(-4)}` : null;
}

app.get('/api/settings/api-key', (req, res) => {
  const apiKey = getApiKey();
  res.json({
    hasKey:     !!apiKey,
    source:     getApiKeySource(), // 'env' | 'file' | null
    provider:   getProvider(),
    keyPreview: keyPreview(apiKey)
  });
});

app.post('/api/settings/api-key', async (req, res) => {
  const { apiKey, provider = 'anthropic' } = req.body;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return res.status(400).json({ error: 'apiKey is required' });
  }
  const trimmed = apiKey.trim();

  // Live-validate before saving — models.list() costs no tokens, so a bad
  // key is caught immediately instead of silently breaking every AI feature
  // on the next real generation call.
  try {
    await new Anthropic({ apiKey: trimmed }).models.list();
  } catch {
    return res.status(400).json({ error: 'That key was rejected by Anthropic — double check it and try again.' });
  }

  saveApiKey(trimmed, provider);
  res.status(201).json({ ok: true, keyPreview: keyPreview(trimmed), shadowedByEnv: !!process.env.ANTHROPIC_API_KEY });
});

app.delete('/api/settings/api-key', (req, res) => {
  clearApiKey();
  res.json({ ok: true });
});

// ── Settings: search provider / API key (roadmap #1) ────────────────────────
// Optional — only needed for the wizard's "Search" material source. Same
// shape and precedence rules as the Anthropic key above (db/config.js).
app.get('/api/settings/search-key', (req, res) => {
  const apiKey = getSearchApiKey();
  res.json({
    hasKey:     !!apiKey,
    source:     getSearchApiKeySource(), // 'env' | 'file' | null
    provider:   getSearchProvider(),
    keyPreview: keyPreview(apiKey)
  });
});

app.post('/api/settings/search-key', async (req, res) => {
  const { apiKey, provider = 'tavily' } = req.body;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return res.status(400).json({ error: 'apiKey is required' });
  }
  if (!isKnownProvider(provider)) {
    return res.status(400).json({ error: `Unknown search provider: ${provider}` });
  }
  const trimmed = apiKey.trim();

  // Live-validate before saving, same rationale as the Anthropic key — a bad
  // key should fail here, not silently on the next topic creation. Search
  // providers don't offer a free key-check endpoint, so this costs one real
  // search against the user's own quota.
  const check = await webSearch('test', provider, trimmed, 1);
  if (check.error) {
    return res.status(400).json({ error: `That key was rejected by ${provider}: ${check.error}` });
  }

  saveSearchConfig(trimmed, provider);
  const envVar = { tavily: 'TAVILY_API_KEY', brave: 'BRAVE_API_KEY', serper: 'SERPER_API_KEY' }[provider];
  res.status(201).json({ ok: true, keyPreview: keyPreview(trimmed), shadowedByEnv: !!process.env[envVar] });
});

app.delete('/api/settings/search-key', (req, res) => {
  clearSearchConfig();
  res.json({ ok: true });
});

// ── Fallback error handling ───────────────────────────────────────────────────
// Most routes above already validate input and return 400/404 with a real
// status code. This is the safety net for anything that still throws
// unexpectedly (e.g. a DB call given a malformed id) — without it, an
// uncaught synchronous error falls through to Express's default handler,
// which sends an HTML page instead of JSON, breaking every fetch-based caller
// that expects `{ error }` back. Every failure path in the API now ends up
// as real JSON with a non-2xx status, never a silent 200.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err?.status || 500).json({ error: err?.message || 'Internal server error', code: err?.code });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
// Only listen when this file is run directly (`node server.js`) — importing
// it (e.g. from the test suite) should just wire up `app` without binding a
// port, so tests can start their own instance on an ephemeral port.

if (import.meta.url === `file://${process.argv[1]}`) {
  await initDb();
  app.listen(PORT, () => console.log(`AI Tutor running at http://localhost:${PORT}`));
}

export { app, initDb, markCacheBreakpoint, CACHED_TOOLS };
