// Unit tests for tools/localExtract.js — the no-API question generation
// pipeline (roadmap #6). Pure functions, no server/DB needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTerms, extractCloze, buildLocalQuestions } from '../tools/localExtract.js';

const GLOSSARY = [
  'Mitochondria: the organelle that produces ATP through cellular respiration.',
  'Ribosome: the structure that synthesizes proteins from amino acids.',
  'Nucleus: the organelle that contains a cell\'s genetic material.',
  'Cytoplasm: the gel-like substance filling the interior of a cell.'
].join('\n');

test('extractTerms finds glossary-style "Term: definition" lines', () => {
  const terms = extractTerms(GLOSSARY);
  assert.equal(terms.length, 4);
  const mito = terms.find(t => t.term === 'Mitochondria');
  assert.ok(mito);
  assert.match(mito.definition, /produces ATP/);
});

test('extractTerms finds copula sentences ("X is/are Y") when the term recurs elsewhere', () => {
  const content =
    'Photosynthesis is the process by which plants convert light into chemical energy. ' +
    'Without photosynthesis, most food chains on Earth could not exist.';
  const terms = extractTerms(content);
  assert.equal(terms.length, 1);
  assert.equal(terms[0].term, 'Photosynthesis');
  assert.match(terms[0].definition, /convert light/);
});

// A copula sentence alone isn't enough — sentence-initial capitalization
// happens to every sentence regardless of whether the subject is a real
// proper noun ("Achilles is...") or a generic phrase ("Many historians
// are..."). Requiring the term to recur elsewhere is what tells them apart;
// a term mentioned exactly once has no such corroboration and is dropped.
test('extractTerms rejects a copula-sentence term that never recurs elsewhere in the document', () => {
  const content = 'Photosynthesis is the process by which plants convert light into chemical energy.';
  assert.deepEqual(extractTerms(content), []);
});

test('extractTerms rejects generic quantifier-led subjects even with a copula and a recurring word', () => {
  const content =
    'Many historians are skeptical of a literal reading of the myth. ' +
    'Some historians argue the siege has a real Bronze Age basis.';
  const terms = extractTerms(content);
  assert.deepEqual(terms, []);
});

test('extractTerms deduplicates by term, keeping the first occurrence', () => {
  const content = 'Osmosis: movement of water across a membrane.\nOsmosis: a different, later definition.';
  const terms = extractTerms(content);
  assert.equal(terms.length, 1);
  assert.match(terms[0].definition, /movement of water/);
});

test('extractCloze blanks a term out of a different sentence that uses it', () => {
  const content =
    'Enzyme: a protein that speeds up chemical reactions.\n' +
    'Without an enzyme, most biochemical reactions would happen far too slowly to sustain life.';
  const terms = extractTerms(content);
  const clozes = extractCloze(content, terms);
  assert.equal(clozes.length, 1);
  assert.match(clozes[0].clozeText, /_____/);
  assert.doesNotMatch(clozes[0].clozeText, /enzyme/i);
  assert.equal(clozes[0].term, 'Enzyme');
});

test('buildLocalQuestions("flashcard") returns term-based and cloze-based cards', () => {
  const items = buildLocalQuestions(GLOSSARY, 'flashcard', 10);
  assert.ok(items.length > 0);
  assert.ok(items.every(q => q.type === 'flashcard' && q.options === null));
  assert.ok(items.some(q => q.question === 'Mitochondria' && /ATP/.test(q.answer)));
});

test('buildLocalQuestions("mcq") builds 4-option questions when >=4 terms exist', () => {
  const items = buildLocalQuestions(GLOSSARY, 'mcq', 10);
  assert.ok(items.length > 0);
  for (const q of items) {
    assert.equal(q.type, 'mcq');
    assert.equal(q.options.length, 4);
    assert.ok(q.options.includes(q.answer));
  }
});

test('buildLocalQuestions("mcq") never shows the same option text twice, even when two terms share an identical definition', () => {
  const content = [
    'Alpha: A protective structure surrounding the cell.',
    'Beta: A protective structure surrounding the cell.',
    'Gamma: The site of protein synthesis.',
    'Delta: The powerhouse of the cell.',
    'Epsilon: Regulates what enters and exits the cell.',
    'Zeta: Stores genetic material.'
  ].join('\n');
  const items = buildLocalQuestions(content, 'mcq', 10);
  for (const q of items) {
    const uniqueOptions = new Set(q.options);
    assert.equal(uniqueOptions.size, q.options.length, `duplicate option in MCQ for "${q.question}": ${JSON.stringify(q.options)}`);
  }
});

test('buildLocalQuestions("mcq") falls back to "short" for a term whose duplicate-definition sibling leaves too few distinct distractors', () => {
  // Only 4 terms, but Alpha/Beta share one definition — only 3 distinct
  // definition texts exist total, one short of the 4 needed for a valid MCQ.
  const content = [
    'Alpha: A protective structure surrounding the cell.',
    'Beta: A protective structure surrounding the cell.',
    'Gamma: The site of protein synthesis.',
    'Delta: The powerhouse of the cell.'
  ].join('\n');
  const items = buildLocalQuestions(content, 'mcq', 10);
  assert.ok(items.length > 0);
  assert.ok(items.every(q => q.type === 'short' && q.options === null));
});

test('buildLocalQuestions("mcq") falls back to "short" when fewer than 4 terms exist', () => {
  const content = 'Osmosis: movement of water across a membrane.\nDiffusion: movement of particles from high to low concentration.';
  const items = buildLocalQuestions(content, 'mcq', 10);
  assert.ok(items.length > 0);
  assert.ok(items.every(q => q.type === 'short' && q.options === null));
});

test('buildLocalQuestions("short") produces "What is X?" questions', () => {
  const items = buildLocalQuestions(GLOSSARY, 'short', 10);
  assert.ok(items.some(q => q.question === 'What is Mitochondria?'));
});

test('buildLocalQuestions caps the returned count', () => {
  const items = buildLocalQuestions(GLOSSARY, 'flashcard', 2);
  assert.ok(items.length <= 2);
});

test('buildLocalQuestions on prose with no definitional patterns returns nothing', () => {
  const content = 'The weather changed quickly that afternoon. Everyone went inside before the storm hit.';
  assert.deepEqual(buildLocalQuestions(content, 'flashcard', 10), []);
});

// roadmap #7 — a lowercase-conventioned technical term (as in "staticmethod",
// "property") must be recognized from a glossary line, and the sentence
// boundary immediately before a lowercase-led sentence must still register so
// a copula sentence starting with one is reachable at all.
test('extractTerms finds a lowercase-led glossary term', () => {
  const content = 'staticmethod: a decorator that turns a method into one callable without an instance.';
  const terms = extractTerms(content);
  assert.equal(terms.length, 1);
  assert.equal(terms[0].term, 'staticmethod');
  assert.match(terms[0].definition, /callable without an instance/);
});

test('extractTerms finds a lowercase-led copula sentence immediately after another sentence, and recognizes the term recurring later', () => {
  const content =
    'Decorators wrap functions to extend their behavior. ' +
    'staticmethod is a decorator that turns a method into one callable without an instance. ' +
    'Unlike classmethod, staticmethod receives no implicit first argument.';
  const terms = extractTerms(content);
  const term = terms.find(t => t.term === 'staticmethod');
  assert.ok(term, 'expected "staticmethod" to be recognized as a term');
  assert.match(term.definition, /callable without an instance/);
});

// roadmap #8 — past-tense copula sentences ("X was the ...") are common in
// historical/narrative material and must not be silently skipped just
// because the pattern only covered present tense.
test('extractTerms finds a past-tense copula sentence ("X was the ...") when the term recurs elsewhere', () => {
  const content =
    'Marathon was a pivotal conflict between Athens and Persia in 490 BC. ' +
    'Historians still study Marathon for its tactical innovations.';
  const terms = extractTerms(content);
  assert.equal(terms.length, 1);
  assert.equal(terms[0].term, 'Marathon');
  assert.match(terms[0].definition, /pivotal conflict/);
});

test('extractTerms finds other past-tense copula variants (were/referred to/meant/was known as)', () => {
  const content =
    'City-states were independent political units in ancient Greece. ' +
    'Many city-states formed alliances during times of war.';
  const terms = extractTerms(content);
  const term = terms.find(t => t.term === 'City-states');
  assert.ok(term, 'expected "City-states" to be recognized from a were-copula sentence');
  assert.match(term.definition, /independent political units/);
});
