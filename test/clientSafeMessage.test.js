// Unit tests for clientSafeMessage (roadmap #9) — genericizes error text
// before it reaches a client response, except for NoApiKeyError's message,
// which is deliberately user-facing rather than an accidental internal leak.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test-not-a-real-key';
const { clientSafeMessage } = await import('../server.js');

test('passes through the message for a NO_API_KEY error', () => {
  const err = Object.assign(new Error('No Anthropic API key configured — add one in Settings.'), { code: 'NO_API_KEY' });
  assert.equal(clientSafeMessage(err), err.message);
});

test('genericizes a raw internal error (e.g. a filesystem or SQLite exception)', () => {
  const err = new Error('ENOENT: no such file or directory, open \'/Users/someone/tutor/db/tutor.db\'');
  assert.equal(clientSafeMessage(err), 'Something went wrong — please try again.');
});

test('genericizes even when the error has an unrelated .code (e.g. a Node system error code)', () => {
  const err = Object.assign(new Error('SQLITE_CONSTRAINT: NOT NULL constraint failed'), { code: 'SQLITE_CONSTRAINT' });
  assert.equal(clientSafeMessage(err), 'Something went wrong — please try again.');
});

test('accepts a custom fallback message', () => {
  const err = new Error('some internal detail');
  assert.equal(clientSafeMessage(err, 'Custom fallback.'), 'Custom fallback.');
});

test('handles a null/undefined error without throwing', () => {
  assert.equal(clientSafeMessage(undefined), 'Something went wrong — please try again.');
});
