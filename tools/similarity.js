// Local text-similarity heuristics for quiz grading — no API call, no
// external dependency. Sits ahead of /api/evaluate's LLM call: near-exact
// matches are auto-accepted, clearly off-topic answers are auto-rejected,
// and only the ambiguous middle band still needs the model's judgement.

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in',
  'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to',
  'was', 'were', 'with'
]);

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return normalize(text).split(' ').filter(w => w && !STOPWORDS.has(w));
}

function jaccard(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  if (!setA.size && !setB.size) return 1;
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

function levenshteinRatio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  return maxLen ? 1 - levenshtein(a, b) / maxLen : 1;
}

const ACCEPT_THRESHOLD = 0.92;
const REJECT_MIN_ANSWER_TOKENS = 3;

// Returns { decision: 'accept'|'reject'|'ambiguous', similarity }.
// 'accept'/'reject' are confident enough to skip the API entirely;
// 'ambiguous' means fall through to the model as before.
export function localGrade(correctAnswer, userAnswer) {
  const normA = normalize(correctAnswer);
  const normB = normalize(userAnswer);
  const tokensA = tokenize(correctAnswer);
  const tokensB = tokenize(userAnswer);

  const charSim  = levenshteinRatio(normA, normB);
  const tokenSim = jaccard(tokensA, tokensB);
  const similarity = Math.max(charSim, tokenSim);

  if (similarity >= ACCEPT_THRESHOLD) {
    return { decision: 'accept', similarity };
  }

  // Auto-reject only on zero shared vocabulary — character-level similarity
  // isn't used here, since two unrelated sentences of ordinary length still
  // share plenty of letters/substrings by chance and would falsely inflate
  // it. Word overlap is the trustworthy signal: a genuinely correct but
  // differently-worded answer almost always shares at least one keyword
  // with the model answer on these quiz-style questions, so zero overlap
  // plus a substantive answer is a strong "wrong topic" signal.
  if (tokenSim === 0 && tokensB.length >= REJECT_MIN_ANSWER_TOKENS) {
    return { decision: 'reject', similarity };
  }

  return { decision: 'ambiguous', similarity };
}

// Search-query matching reuses this same char+token similarity computation
// against a lower bar than answer-grading's ACCEPT_THRESHOLD: a search query
// only needs to be close enough that the material it already turned up is
// still relevant (reordered words, a dropped filler word, singular/plural),
// not near-exact wording — there's no model in the loop here to catch a
// borderline case the way /api/evaluate's ambiguous band does, so this stays
// conservative rather than trying to match paraphrases.
const QUERY_MATCH_THRESHOLD = 0.82;

// candidates: [{ id, query, ... }]. Returns the best-scoring candidate at or
// above the threshold (plus its similarity), or null if none qualifies.
export function findSimilarQuery(query, candidates) {
  const normQ = normalize(query);
  const tokensQ = tokenize(query);

  let best = null;
  for (const candidate of candidates) {
    const charSim = levenshteinRatio(normQ, normalize(candidate.query));
    const tokenSim = jaccard(tokensQ, tokenize(candidate.query));
    const similarity = Math.max(charSim, tokenSim);
    if (similarity >= QUERY_MATCH_THRESHOLD && (!best || similarity > best.similarity)) {
      best = { ...candidate, similarity };
    }
  }
  return best;
}
