// Local (no-API) question generation — roadmap #6.
//
// Definition-pattern matching plus cloze deletion turns reference material
// directly into flashcards/short-answer/MCQ items with zero network calls.
// This only covers the "easy" tier — factual, definitional material. The
// caller (server.js) is responsible for topping this up with a small
// AI-generated "hard" tier of synthesis questions.

const MIN_TERM_WORDS = 1;
const MAX_TERM_WORDS = 6;
const MIN_DEFINITION_LEN = 10;
const MAX_DEFINITION_LEN = 400;
const MCQ_OPTION_COUNT = 4;
const CLOZE_BLANK = '_____';

// roadmap #7 — the capital-only lookahead here used to mean a sentence
// immediately after a lowercase-led one (e.g. a lowercase-conventioned term
// like "staticmethod") never registered as a boundary, fusing it onto the
// end of the previous sentence and putting it out of COPULA_RE's reach
// (that regex is anchored to the start of a sentence string). Letting any
// letter start a new sentence fixes that; GENERIC_LEAD_WORDS below still
// screens out ordinary lowercase continuations before they'd be mistaken
// for terms.
function splitSentences(content) {
  return content
    .replace(/\s+/g, ' ')
    .split(/(?<=[.?!])\s+(?=[A-Za-z0-9])/)
    .map(s => s.trim())
    .filter(Boolean);
}

// Term regex fragment shared between the glossary-line and copula-sentence
// patterns — a term of 1-6 words, no sentence-ending punctuation. roadmap #7:
// the leading character used to be capital-only, which silently excluded
// lowercase-conventioned technical vocabulary (property, staticmethod, and
// the like). GENERIC_LEAD_WORDS and (for copula sentences) the recurrence
// check below still filter out ordinary lowercase prose leads.
const TERM = `[A-Za-z][A-Za-z0-9'’\\-]*(?:\\s+[A-Za-z0-9'’\\-]+){0,${MAX_TERM_WORDS - 1}}`;

const GLOSSARY_LINE_RE = new RegExp(`^(${TERM}):\\s+(.{${MIN_DEFINITION_LEN},${MAX_DEFINITION_LEN}})$`);
// roadmap #8 — past-tense counterparts (was/were/referred to/meant/was
// defined as/was known as) alongside the existing present-tense copulas, so
// narrative/historical material phrased in the past isn't silently skipped.
const COPULA_RE = new RegExp(
  `^(${TERM})\\s+(?:is|was|are|were|refers to|referred to|means|meant|is defined as|was defined as|is known as|was known as)\\s+(.{${MIN_DEFINITION_LEN},${MAX_DEFINITION_LEN}}?)\\.?$`,
  'i'
);

// Cheap fast-path rejection: sentence-initial capitalization makes ordinary
// pronouns/determiners/quantifiers look like defined terms ("The war is...",
// "Many historians are...") — a real glossary term never starts this way.
// This is a fast-path only, not the real fix (see corroboration below): it
// can't enumerate every generic noun phrase English allows here.
const GENERIC_LEAD_WORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them',
  'their', 'he', 'she', 'his', 'her', 'we', 'us', 'our', 'i', 'you', 'your',
  'there', 'here', 'what', 'which', 'who', 'such',
  'a', 'an', 'some', 'many', 'few', 'several', 'one', 'another', 'each',
  'every', 'no', 'any', 'all', 'both', 'most'
]);

function isGenericLead(term) {
  const first = term.split(/\s+/)[0].toLowerCase();
  return GENERIC_LEAD_WORDS.has(first);
}

function cleanDefinition(def) {
  return def.trim().replace(/\.$/, '');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word search for `term` in a sentence other than `ownSentence`.
function findOtherMention(term, ownSentence, sentences) {
  const re = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
  return sentences.find(s => s !== ownSentence && re.test(s));
}

// Extracts { term, definition, sourceSentence } triples from glossary-style
// lines ("Term: definition") and copula sentences ("Term is/are/means definition.").
// Deduplicated by lower-cased term, first occurrence wins.
export function extractTerms(content) {
  const seen = new Map();
  const sentences = splitSentences(content);

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    const m = GLOSSARY_LINE_RE.exec(line);
    if (!m) continue;
    const term = m[1].trim();
    const key = term.toLowerCase();
    if (seen.has(key) || isGenericLead(term)) continue;
    const words = term.split(/\s+/).length;
    if (words < MIN_TERM_WORDS || words > MAX_TERM_WORDS) continue;
    // No corroboration required here — an explicit "Term: definition" line
    // is itself a strong, deliberate signal, unlike a sentence pulled out of
    // running prose.
    seen.set(key, { term, definition: cleanDefinition(m[2]), sourceSentence: line });
  }

  for (const sentence of sentences) {
    const m = COPULA_RE.exec(sentence);
    if (!m) continue;
    const term = m[1].trim();
    const key = term.toLowerCase();
    if (seen.has(key) || isGenericLead(term)) continue;
    // Sentence-initial capitalization alone can't tell a real proper noun
    // ("Achilles is...") from a generic subject phrase that only reads as
    // capitalized because it happens to start a sentence ("Many historians
    // are..."). Require the term to recur elsewhere in the document as
    // corroboration — real named entities get referenced more than once;
    // incidental subject phrases essentially never repeat verbatim.
    if (!findOtherMention(term, sentence, sentences)) continue;
    seen.set(key, { term, definition: cleanDefinition(m[2]), sourceSentence: sentence });
  }

  return [...seen.values()];
}

// For each term, finds one other sentence (not its own definition sentence)
// that uses it as a whole word, and blanks the term out. Gives extra
// flashcard/short-answer variety beyond the raw definition pairs.
export function extractCloze(content, terms) {
  const sentences = splitSentences(content);
  const clozes = [];

  for (const { term, sourceSentence } of terms) {
    const hit = findOtherMention(term, sourceSentence, sentences);
    if (!hit) continue;
    const wordRe = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
    clozes.push({ term, clozeText: hit.replace(wordRe, CLOZE_BLANK) });
  }

  return clozes;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildMcqItems(terms) {
  if (terms.length < MCQ_OPTION_COUNT) return [];
  const items = [];
  for (const { term, definition } of terms) {
    // Distractors must be distinct from the correct answer AND from each
    // other — two terms that happen to share identical definition text
    // would otherwise produce an MCQ showing the same option twice.
    const seenDefs = new Set([definition]);
    const distractorPool = [];
    for (const t of terms) {
      if (t.term === term || seenDefs.has(t.definition)) continue;
      seenDefs.add(t.definition);
      distractorPool.push(t.definition);
    }
    const distractors = shuffle(distractorPool).slice(0, MCQ_OPTION_COUNT - 1);
    if (distractors.length < MCQ_OPTION_COUNT - 1) continue;
    items.push({
      question: `Which of the following best defines "${term}"?`,
      answer:   definition,
      type:     'mcq',
      options:  shuffle([definition, ...distractors])
    });
  }
  return items;
}

function buildFlashcardItems(terms, clozes) {
  const fromTerms = terms.map(({ term, definition }) => ({
    question: term, answer: definition, type: 'flashcard', options: null
  }));
  const fromCloze = clozes.map(({ term, clozeText }) => ({
    question: clozeText, answer: term, type: 'flashcard', options: null
  }));
  return interleave(fromTerms, fromCloze);
}

function buildShortItems(terms, clozes) {
  const fromTerms = terms.map(({ term, definition }) => ({
    question: `What is ${term}?`, answer: definition, type: 'short', options: null
  }));
  const fromCloze = clozes.map(({ term, clozeText }) => ({
    question: `Fill in the blank: ${clozeText}`, answer: term, type: 'short', options: null
  }));
  return interleave(fromTerms, fromCloze);
}

function interleave(a, b) {
  const out = [];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

// Assembles local questions of the requested type from reference material.
// type: 'flashcard' | 'short' | 'mcq'. Returns up to `cap` items — fewer if
// the material doesn't support that many (e.g. MCQ needs >=4 distinct terms).
export function buildLocalQuestions(content, type, cap = 10) {
  const terms  = extractTerms(content);
  const clozes = extractCloze(content, terms);

  let items;
  if (type === 'mcq') {
    items = buildMcqItems(terms);
    // Not enough distinct terms to build a 4-option distractor pool at all —
    // fall back to short-answer for this batch rather than producing nothing.
    if (!items.length) items = buildShortItems(terms, clozes);
  } else if (type === 'flashcard') {
    items = buildFlashcardItems(terms, clozes);
  } else {
    items = buildShortItems(terms, clozes);
  }

  return items.slice(0, cap);
}
