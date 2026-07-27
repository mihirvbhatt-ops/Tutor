// Unit tests for tools/webSearchProvider.js (roadmap #1). Only the
// pre-flight validation paths are covered here — same philosophy as the
// rest of this suite (see test/api.test.js), which never calls a real
// external API; provider response parsing needs manual testing with a real
// key, same as AI generation does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webSearch, isKnownProvider } from '../tools/webSearchProvider.js';

test('isKnownProvider recognizes the three supported providers and rejects anything else', () => {
  assert.equal(isKnownProvider('tavily'), true);
  assert.equal(isKnownProvider('brave'), true);
  assert.equal(isKnownProvider('serper'), true);
  assert.equal(isKnownProvider('bing'), false);
  assert.equal(isKnownProvider(''), false);
});

test('webSearch errors on an unknown provider without making any request', async () => {
  const result = await webSearch('test query', 'bing', 'some-key');
  assert.equal(result.error, 'Unknown search provider: bing');
});

test('webSearch errors when no API key is given, for every known provider', async () => {
  for (const provider of ['tavily', 'brave', 'serper']) {
    const result = await webSearch('test query', provider, null);
    assert.equal(result.error, 'No search API key configured');
  }
});
