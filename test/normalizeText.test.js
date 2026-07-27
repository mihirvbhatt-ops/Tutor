// Unit tests for tools/normalizeText.js — extracted-text cleanup (roadmap
// #11). Pure function, no server/DB needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExtractedText } from '../tools/normalizeText.js';

test('collapses runs of blank lines and repeated horizontal whitespace', () => {
  const text = 'Paragraph one.\n\n\n\n\nParagraph  two   has \t extra   spaces.';
  const out = normalizeExtractedText(text);
  assert.equal(out, 'Paragraph one.\n\nParagraph two has extra spaces.');
});

test('rejoins a word broken across a line-wrap hyphen', () => {
  const text = 'The mitochondria is the organelle that produces cellular ener-\ngy through respiration.';
  const out = normalizeExtractedText(text);
  assert.match(out, /cellular energy through respiration/);
  assert.doesNotMatch(out, /ener-\n/);
});

test('leaves a genuine hyphenated compound word alone when not split across a line', () => {
  const text = 'This is a well-known fact about state-of-the-art extraction.';
  const out = normalizeExtractedText(text);
  assert.equal(out, text);
});

test('strips a header/footer line that repeats verbatim across the document', () => {
  const lines = [
    'Biology 101 — Chapter 4',
    'Cellular respiration converts glucose into usable energy.',
    'Biology 101 — Chapter 4',
    'The process occurs in the mitochondria.',
    'Biology 101 — Chapter 4',
    'ATP is the main energy currency of the cell.'
  ];
  const out = normalizeExtractedText(lines.join('\n'));
  assert.doesNotMatch(out, /Biology 101/);
  assert.match(out, /Cellular respiration converts glucose/);
  assert.match(out, /main energy currency/);
});

test('keeps a short line that appears fewer than 3 times', () => {
  const lines = [
    'Introduction',
    'Some content here.',
    'Introduction',
    'More content.'
  ];
  const out = normalizeExtractedText(lines.join('\n'));
  assert.match(out, /Introduction/);
});

test('does not strip a long repeated sentence — only short header/footer-length lines are eligible', () => {
  const longLine = 'This important sentence about cellular respiration and energy conversion is repeated intentionally for emphasis in this passage.';
  const lines = [longLine, 'Other content.', longLine, 'More content.', longLine];
  const out = normalizeExtractedText(lines.join('\n'));
  const occurrences = out.split(longLine).length - 1;
  assert.equal(occurrences, 3);
});

test('handles empty/falsy input without throwing', () => {
  assert.equal(normalizeExtractedText(''), '');
  assert.equal(normalizeExtractedText(null), null);
});
