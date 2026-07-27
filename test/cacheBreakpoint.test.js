// Unit tests for markCacheBreakpoint (roadmap #13) — the sliding
// cache_control marker runAgent() places on the last message each turn.
// Pure mutation logic, no server/DB/API calls needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test-not-a-real-key';
const { markCacheBreakpoint } = await import('../server.js');

test('wraps a plain string message into a single cached text block', () => {
  const messages = [{ role: 'user', content: 'Explain photosynthesis' }];
  markCacheBreakpoint(messages);
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: 'Explain photosynthesis', cache_control: { type: 'ephemeral' } }
  ]);
});

test('marks only the last block of the last message when content is already an array', () => {
  const messages = [
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'get_topic', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] }
  ];
  markCacheBreakpoint(messages);
  assert.equal(messages[2].content[0].cache_control.type, 'ephemeral');
  assert.equal(messages[1].content[0].cache_control, undefined);
  assert.equal(messages[1].content[1].cache_control, undefined);
});

test('moves the breakpoint forward each turn instead of accumulating one per turn', () => {
  const messages = [{ role: 'user', content: 'first turn' }];
  markCacheBreakpoint(messages);
  assert.ok(messages[0].content[0].cache_control);

  // Simulate the next turn: a tool round-trip gets appended, then the
  // breakpoint is re-marked — the turn-1 marker must not survive.
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'thinking' }] });
  messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] });
  markCacheBreakpoint(messages);

  assert.equal(messages[0].content[0].cache_control, undefined);
  assert.equal(messages[1].content[0].cache_control, undefined);
  assert.equal(messages[2].content[0].cache_control.type, 'ephemeral');

  // Never more than one breakpoint across the whole array.
  const totalBreakpoints = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
    .filter(b => b.cache_control).length;
  assert.equal(totalBreakpoints, 1);
});

test('does nothing on an empty messages array', () => {
  const messages = [];
  assert.doesNotThrow(() => markCacheBreakpoint(messages));
});
