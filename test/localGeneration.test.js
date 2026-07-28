// Unit tests for the local question-generation guards (roadmap #3). These
// are the parts that exist *because* the model is small — a context budget
// so reference material can't silently overflow, and an MCQ shape check
// because a 7B gets the four-options-one-of-which-is-the-answer invariant
// wrong often enough to matter. Both are pure, so neither needs a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test-not-a-real-key';
const {
  budgetMaterial, isUsableMcq, localQuestionSchema, LOCAL_MATERIAL_CHAR_BUDGET
} = await import('../server.js');

// ── Context budget ──────────────────────────────────────────────────────────

test('material within budget is passed through untouched and unflagged', () => {
  const text = 'Photosynthesis converts light into chemical energy.';
  assert.deepEqual(budgetMaterial(text), { text, truncated: false });
});

test('material at exactly the budget is not trimmed', () => {
  const text = 'x'.repeat(LOCAL_MATERIAL_CHAR_BUDGET);
  assert.equal(budgetMaterial(text).truncated, false);
});

test('oversized material is trimmed and reported, never silently', () => {
  // The v1.98 "long topics silently truncated" bug came from dropping
  // material without saying so; the flag is what keeps this from repeating.
  const result = budgetMaterial('x'.repeat(LOCAL_MATERIAL_CHAR_BUDGET + 5000));
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= LOCAL_MATERIAL_CHAR_BUDGET);
});

test('trimming prefers a paragraph break over cutting mid-sentence', () => {
  // A paragraph boundary sits comfortably past the halfway mark, so the cut
  // should land there rather than at the raw character limit.
  const head = 'a'.repeat(LOCAL_MATERIAL_CHAR_BUDGET - 100);
  const result = budgetMaterial(`${head}\n\n${'b'.repeat(5000)}`);
  assert.equal(result.truncated, true);
  assert.equal(result.text, head);
  assert.equal(result.text.endsWith('b'), false);
});

test('a paragraph break too early in the text is ignored in favour of the budget', () => {
  // Cutting at a break in the first few characters would throw away almost
  // all the material — a hard cut keeps far more of it.
  const result = budgetMaterial(`intro\n\n${'c'.repeat(LOCAL_MATERIAL_CHAR_BUDGET * 2)}`);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length > LOCAL_MATERIAL_CHAR_BUDGET / 2);
});

// ── MCQ shape guard ─────────────────────────────────────────────────────────

test('a well-formed MCQ with the answer among four options is usable', () => {
  assert.equal(isUsableMcq({
    answer: 'Chlorophyll',
    options: ['Chlorophyll', 'Melanin', 'Keratin', 'Haemoglobin']
  }), true);
});

test('an MCQ whose correct answer is not among its options is rejected', () => {
  // This is the unanswerable case — the whole reason the guard exists.
  assert.equal(isUsableMcq({
    answer: 'Chlorophyll',
    options: ['Melanin', 'Keratin', 'Haemoglobin', 'Insulin']
  }), false);
});

test('an MCQ without exactly four options is rejected', () => {
  const answer = 'Chlorophyll';
  assert.equal(isUsableMcq({ answer, options: [answer, 'Melanin', 'Keratin'] }), false);
  assert.equal(isUsableMcq({ answer, options: [answer, 'Melanin', 'Keratin', 'Insulin', 'Urea'] }), false);
});

test('an MCQ with missing or non-array options is rejected rather than throwing', () => {
  assert.equal(isUsableMcq({ answer: 'Chlorophyll', options: null }), false);
  assert.equal(isUsableMcq({ answer: 'Chlorophyll' }), false);
  assert.equal(isUsableMcq({ answer: 'Chlorophyll', options: 'Chlorophyll' }), false);
});

// ── Constrained-decoding schema ─────────────────────────────────────────────

test('the mcq schema pins options to exactly four and requires them', () => {
  const schema = localQuestionSchema('mcq');
  assert.equal(schema.type, 'array');
  assert.equal(schema.items.properties.options.minItems, 4);
  assert.equal(schema.items.properties.options.maxItems, 4);
  assert.deepEqual(schema.items.required, ['question', 'answer', 'options']);
});

test('non-mcq schemas omit options entirely', () => {
  for (const type of ['flashcard', 'short']) {
    const schema = localQuestionSchema(type);
    assert.equal('options' in schema.items.properties, false);
    assert.deepEqual(schema.items.required, ['question', 'answer']);
  }
});
