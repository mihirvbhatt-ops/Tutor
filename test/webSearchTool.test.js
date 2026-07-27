// Unit tests for the native web search tool wiring (roadmap #1) — verifies
// CACHED_TOOLS carries the correct Anthropic tool shape and that the prompt
// cache breakpoint still lands on the true last tool. Pure data checks, no
// server/DB/API calls needed (this repo's test suite never calls the real
// Anthropic API — see test/api.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test-not-a-real-key';
const { CACHED_TOOLS } = await import('../server.js');

test('CACHED_TOOLS includes the native web_search tool with a use cap', () => {
  const webSearch = CACHED_TOOLS.find(t => t.name === 'web_search');
  assert.ok(webSearch, 'expected a tool named web_search');
  assert.equal(webSearch.type, 'web_search_20250305');
  assert.ok(webSearch.max_uses > 0, 'max_uses must bound searches per turn');
});

test('the cache breakpoint sits on the true last tool (web_search), not the last study.js tool', () => {
  const last = CACHED_TOOLS[CACHED_TOOLS.length - 1];
  assert.equal(last.name, 'web_search');
  assert.deepEqual(last.cache_control, { type: 'ephemeral' });
  const withoutBreakpoint = CACHED_TOOLS.filter(t => t.cache_control);
  assert.equal(withoutBreakpoint.length, 1, 'exactly one tool should carry the cache breakpoint');
});
