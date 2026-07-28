// Unit tests for tools/inferenceProvider.js (roadmap #3). Unlike the search
// provider tests — which only cover pre-flight validation because there's no
// way to exercise Tavily/Brave without a real key — Ollama speaks plain HTTP
// on a host we control, so a throwaway node:http server stands in for it.
// That means the real request/response and NDJSON streaming paths are
// covered here, not just the argument checks; nothing external is contacted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  probeOllama, ollamaComplete, isKnownProvider, capabilitiesOf, CALL_SITES, DEFAULT_OLLAMA_HOST
} from '../tools/inferenceProvider.js';

// A stand-in Ollama. Each test sets `handler` to whatever that case needs;
// requests are recorded so tests can assert on what was actually sent.
let server, host, handler, received;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, body: body ? JSON.parse(body) : null });
      handler(req, res, body ? JSON.parse(body) : null);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { await new Promise(resolve => server.close(resolve)); });

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// Default: a healthy Ollama with one model pulled that supports tools.
function healthy(req, res) {
  if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5:14b' }] });
  if (req.url === '/api/show') return json(res, 200, { capabilities: ['completion', 'tools'] });
  if (req.url === '/api/chat') return json(res, 200, { message: { content: '{"correct":true,"feedback":"Good."}' }, done: true });
  return json(res, 404, { error: 'not found' });
}

test.beforeEach(() => { handler = healthy; received = []; });

// ── Static metadata ─────────────────────────────────────────────────────────

test('isKnownProvider recognizes both providers and rejects anything else', () => {
  assert.equal(isKnownProvider('anthropic'), true);
  assert.equal(isKnownProvider('ollama'), true);
  assert.equal(isKnownProvider('openai'), false);
  assert.equal(isKnownProvider(''), false);
});

test('capabilities describe the differences the call sites branch on', () => {
  assert.equal(capabilitiesOf('anthropic').promptCaching, true);
  assert.equal(capabilitiesOf('ollama').promptCaching, false);
  assert.equal(capabilitiesOf('ollama').constrainedJson, true);
  assert.equal(capabilitiesOf('ollama').serverSideSearch, false);
  assert.equal(capabilitiesOf('unknown'), null);
});

test('Ollama tool support is null (unknown) rather than a provider-wide boolean', () => {
  // It's model-dependent, so only the probe can answer it — a static false
  // would wrongly rule out models that do support tools.
  assert.equal(capabilitiesOf('ollama').nativeTools, null);
  assert.equal(capabilitiesOf('anthropic').nativeTools, true);
});

test('CALL_SITES matches the three routable LLM entry points', () => {
  assert.deepEqual(CALL_SITES, ['grading', 'generation', 'agent']);
});

// ── Probe ───────────────────────────────────────────────────────────────────

test('probeOllama reports the pulled models and confirms tool support', async () => {
  const result = await probeOllama({ host, model: 'llama3.1:8b' });
  assert.equal(result.ok, true);
  assert.equal(result.hasModel, true);
  assert.equal(result.supportsTools, true);
  assert.deepEqual(result.models, ['llama3.1:8b', 'qwen2.5:14b']);
});

test('probeOllama accepts a bare model name for a tag-qualified model', async () => {
  // `ollama run llama3.1` resolves to :latest, so users type the bare name.
  const result = await probeOllama({ host, model: 'llama3.1' });
  assert.equal(result.hasModel, true);
});

test('probeOllama flags a model that is not pulled without failing outright', async () => {
  const result = await probeOllama({ host, model: 'mistral:7b' });
  assert.equal(result.ok, true);
  assert.equal(result.hasModel, false);
});

test('probeOllama leaves supportsTools null when Ollama does not report capabilities', async () => {
  handler = (req, res) => {
    if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'llama3.1:8b' }] });
    return json(res, 200, {}); // older build: no capabilities array
  };
  const result = await probeOllama({ host, model: 'llama3.1:8b' });
  // null means "couldn't tell", which the routing endpoint warns about
  // rather than blocking on — distinct from an explicit false.
  assert.equal(result.supportsTools, null);
});

test('probeOllama reports an explicit false for a model without tool support', async () => {
  handler = (req, res) => {
    if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'gemma:2b' }] });
    return json(res, 200, { capabilities: ['completion'] });
  };
  const result = await probeOllama({ host, model: 'gemma:2b' });
  assert.equal(result.supportsTools, false);
});

test('probeOllama returns an actionable error when nothing is listening', async () => {
  const result = await probeOllama({ host: 'http://127.0.0.1:1', model: 'llama3.1' });
  assert.match(result.error, /Can't reach Ollama/);
  assert.match(result.error, /ollama serve/);
  assert.equal(result.ok, undefined);
});

test('probeOllama surfaces a non-200 from the host as an error', async () => {
  handler = (req, res) => json(res, 500, { error: 'boom' });
  const result = await probeOllama({ host, model: 'llama3.1' });
  assert.match(result.error, /HTTP 500/);
});

test('probeOllama normalizes a trailing slash on the host', async () => {
  const result = await probeOllama({ host: `${host}/`, model: 'llama3.1:8b' });
  assert.equal(result.ok, true);
  assert.equal(result.host, host);
  assert.equal(received[0].url, '/api/tags'); // not '//api/tags'
});

// ── Completion ──────────────────────────────────────────────────────────────

test('ollamaComplete refuses without a model rather than calling the host', async () => {
  const result = await ollamaComplete({ host, messages: [{ role: 'user', content: 'hi' }] });
  assert.match(result.error, /No local model configured/);
  assert.equal(received.length, 0);
});

test('ollamaComplete returns the model text for a non-streaming call', async () => {
  const result = await ollamaComplete({
    host, model: 'llama3.1:8b', messages: [{ role: 'user', content: 'grade this' }]
  });
  assert.equal(result.text, '{"correct":true,"feedback":"Good."}');
  assert.equal(received[0].body.stream, false);
});

test('ollamaComplete sends the system prompt as a leading system message', async () => {
  await ollamaComplete({
    host, model: 'llama3.1:8b', system: 'You are an evaluator.',
    messages: [{ role: 'user', content: 'grade this' }]
  });
  assert.deepEqual(received[0].body.messages, [
    { role: 'system', content: 'You are an evaluator.' },
    { role: 'user', content: 'grade this' }
  ]);
});

test('ollamaComplete passes a JSON schema through as the constrained format', async () => {
  const schema = { type: 'object', properties: { correct: { type: 'boolean' } }, required: ['correct'] };
  await ollamaComplete({
    host, model: 'llama3.1:8b', jsonSchema: schema, maxTokens: 200,
    messages: [{ role: 'user', content: 'grade this' }]
  });
  // This is what makes the local grading path safe to JSON.parse directly,
  // instead of needing the Anthropic path's salvage-the-intent fallback.
  assert.deepEqual(received[0].body.format, schema);
  assert.equal(received[0].body.options.num_predict, 200);
});

test('ollamaComplete omits format entirely when no schema is given', async () => {
  await ollamaComplete({ host, model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal('format' in received[0].body, false);
});

test('ollamaComplete surfaces Ollama\'s own error message for a failed call', async () => {
  handler = (req, res) => json(res, 404, { error: "model 'ghost' not found, try pulling it first" });
  const result = await ollamaComplete({ host, model: 'ghost', messages: [{ role: 'user', content: 'hi' }] });
  assert.match(result.error, /try pulling it first/);
});

test('ollamaComplete reports an unreachable host instead of throwing', async () => {
  const result = await ollamaComplete({
    host: 'http://127.0.0.1:1', model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }]
  });
  assert.match(result.error, /Can't reach Ollama/);
});

// ── Streaming ───────────────────────────────────────────────────────────────

test('ollamaComplete streams NDJSON chunks through onDelta and returns the full text', async () => {
  handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: 'Photo' }, done: false }) + '\n');
    res.write(JSON.stringify({ message: { content: 'synthesis' }, done: false }) + '\n');
    res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
  };
  const deltas = [];
  const result = await ollamaComplete({
    host, model: 'llama3.1:8b', onDelta: t => deltas.push(t),
    messages: [{ role: 'user', content: 'explain' }]
  });
  assert.deepEqual(deltas, ['Photo', 'synthesis']);
  assert.equal(result.text, 'Photosynthesis');
  assert.equal(received[0].body.stream, true);
});

test('ollamaComplete reassembles a chunk split mid-line', async () => {
  handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const line = JSON.stringify({ message: { content: 'hello' }, done: false }) + '\n';
    // Deliberately split the JSON mid-object across two writes — the real
    // transport does this and a naive per-chunk parse would drop the token.
    res.write(line.slice(0, 12));
    setTimeout(() => {
      res.write(line.slice(12));
      res.end(JSON.stringify({ done: true }) + '\n');
    }, 10);
  };
  const deltas = [];
  const result = await ollamaComplete({
    host, model: 'llama3.1:8b', onDelta: t => deltas.push(t),
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.deepEqual(deltas, ['hello']);
  assert.equal(result.text, 'hello');
});

test('ollamaComplete surfaces an error delivered mid-stream', async () => {
  handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: 'partial' }, done: false }) + '\n');
    res.end(JSON.stringify({ error: 'out of memory' }) + '\n');
  };
  const result = await ollamaComplete({
    host, model: 'llama3.1:8b', onDelta: () => {}, messages: [{ role: 'user', content: 'hi' }]
  });
  assert.ok(result.error, 'a mid-stream error should not be reported as success');
});

test('an abort signal cancels an in-flight call', async () => {
  handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: 'slow' }, done: false }) + '\n');
    // Never ends — only the abort below resolves this call.
  };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const result = await ollamaComplete({
    host, model: 'llama3.1:8b', signal: controller.signal,
    onDelta: () => {}, messages: [{ role: 'user', content: 'hi' }]
  });
  assert.ok(result.error, 'an aborted call should return an error, not hang');
});

test('the default host points at Ollama\'s loopback port', () => {
  assert.equal(DEFAULT_OLLAMA_HOST, 'http://127.0.0.1:11434');
});
