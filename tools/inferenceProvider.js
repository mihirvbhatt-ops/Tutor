// BYO inference-provider adapter (roadmap #3) — Anthropic stays the default
// for every LLM call; this adds Ollama as an opt-in local alternative the
// user enables per call site from Settings, rather than one global swap.
//
// Deliberately scoped to Ollama only. The Anthropic path stays exactly where
// it is in server.js, keeping its prompt-cache breakpoints, streaming and
// retry behaviour untouched — cache_control and the server-side web_search
// tool are Anthropic-specific optimisations with no Ollama equivalent, and
// flattening both providers into one lowest-common-denominator interface
// would quietly throw away the caching work that shipped in v1.93/v1.95.
// Callers branch on the configured routing and use whichever path applies.
//
// Same convention as scraper.js and webSearchProvider.js: return { error }
// on failure rather than throwing, so callers get one consistent shape to
// check regardless of which stage (config, network, model) went wrong.

export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

// Local generation is far slower than a hosted API — a 7B model writing a
// couple hundred tokens on laptop hardware routinely takes tens of seconds,
// so webSearchProvider.js's 10s timeout would abort nearly every real call.
// The probe gets a short timeout instead: it's a metadata lookup, and a
// Settings form shouldn't hang for two minutes when Ollama isn't running.
const GENERATE_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5_000;

// The call sites the user can independently route. These mirror the three
// LLM entry points in server.js: /api/evaluate (grading), the single-shot
// question generator (generation), and the multi-turn tool loop (agent).
export const CALL_SITES = ['grading', 'generation', 'agent'];

// Per-provider capability descriptor. Call sites branch on the capability
// they actually need, not on the provider's name — that keeps a third
// provider from requiring a new branch at every call site.
//
// nativeTools is null for Ollama rather than true/false on purpose: tool
// support there is model-dependent, not provider-wide, so it can only be
// answered by probing the specific model (see probeOllama below).
const CAPABILITIES = {
  anthropic: {
    streaming:         true,
    nativeTools:       true,
    constrainedJson:   false, // JSON comes from prompting + a fallback parser
    promptCaching:     true,
    serverSideSearch:  true
  },
  ollama: {
    streaming:         true,
    nativeTools:       null,  // model-dependent — probe before relying on it
    constrainedJson:   true,  // schema-constrained at the sampler, can't emit invalid JSON
    promptCaching:     false,
    serverSideSearch:  false  // route through tools/webSearchProvider.js instead
  }
};

export function isKnownProvider(provider) {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, provider);
}

export function capabilitiesOf(provider) {
  return CAPABILITIES[provider] || null;
}

// Trailing slashes would produce '//api/chat' — harmless on most servers but
// not worth relying on, and it makes the host echoed back in errors messier.
function normalizeHost(host) {
  return (host || DEFAULT_OLLAMA_HOST).replace(/\/+$/, '');
}

// AbortSignal.any landed in Node 20.3; engines allows >=20.0, so fall back
// to whichever signal is available rather than crashing on an older 20.x.
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal;
}

// Ollama being unreachable is by far the most common failure here (not
// running, wrong port, model never pulled), and a raw fetch TypeError
// ("fetch failed") tells the user nothing actionable. These stay
// user-facing on purpose — unlike the API errors clientSafeMessage() hides
// in server.js, everything here is about the user's own local setup, so
// naming the host and the fix is the whole point.
function connectionError(host, err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return { error: `Ollama at ${host} didn't respond in time.` };
  }
  return { error: `Can't reach Ollama at ${host} — is it running? (\`ollama serve\`)` };
}

// ── Preflight probe ──────────────────────────────────────────────────────────
// Mirrors the Anthropic key's models.list() check in server.js: validate
// before saving, so a bad setup surfaces in Settings instead of silently
// breaking the next real generation. Answers three things the UI needs to
// warn about separately — host reachable, model actually pulled, and whether
// that model advertises tool support (which the agent call site requires).
export async function probeOllama({ host, model } = {}) {
  const base = normalizeHost(host);

  let tags;
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return { error: `Ollama at ${base} returned HTTP ${res.status}.` };
    tags = await res.json();
  } catch (err) {
    return connectionError(base, err);
  }

  // Ollama reports names tag-qualified ("llama3.1:8b"); accept a bare model
  // name too, since that's what users typically type and what `ollama run`
  // accepts — it resolves to the :latest tag.
  const models = (tags.models || []).map(m => m.name).filter(Boolean);
  const hasModel = !model || models.some(n => n === model || n.split(':')[0] === model);

  // Only meaningful once we know the model exists. supportsTools stays null
  // (rather than false) when Ollama is too old to report capabilities — the
  // difference between "this model can't" and "we couldn't tell" matters for
  // whether the UI blocks the agent call site or just warns about it.
  let supportsTools = null;
  if (model && hasModel) {
    try {
      const res = await fetch(`${base}/api/show`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model }),
        signal:  AbortSignal.timeout(PROBE_TIMEOUT_MS)
      });
      if (res.ok) {
        const info = await res.json();
        if (Array.isArray(info.capabilities)) supportsTools = info.capabilities.includes('tools');
      }
    } catch {
      // Non-fatal: the host answered /api/tags, so it's up. Leave
      // supportsTools null and let the caller treat it as "unknown".
    }
  }

  return { ok: true, host: base, models, hasModel, supportsTools };
}

// ── Completion ───────────────────────────────────────────────────────────────
// Single entry point for both one-shot and streaming calls. Passing a
// jsonSchema turns on Ollama's schema-constrained decoding, which enforces
// shape at the sampler — the model literally cannot emit invalid JSON, so
// callers don't need the salvage-the-intent text parser the Anthropic path
// falls back on (server.js /api/evaluate).
export async function ollamaComplete({
  host, model, system, messages, maxTokens, jsonSchema, signal, onDelta
} = {}) {
  const base = normalizeHost(host);
  if (!model) return { error: 'No local model configured — set one in Settings.' };

  const streaming = typeof onDelta === 'function';
  const body = {
    model,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    stream:   streaming,
    ...(jsonSchema ? { format: jsonSchema } : {}),
    ...(maxTokens ? { options: { num_predict: maxTokens } } : {})
  };

  let res;
  try {
    res = await fetch(`${base}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  withTimeout(signal, GENERATE_TIMEOUT_MS)
    });
  } catch (err) {
    return connectionError(base, err);
  }

  if (!res.ok) {
    // Ollama puts a useful message in the body for the common setup errors
    // ("model 'x' not found, try pulling it first"), so surface it rather
    // than a bare status code.
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* non-JSON body */ }
    return { error: detail || `Ollama returned HTTP ${res.status}.` };
  }

  try {
    return streaming
      ? { text: await readStream(res, onDelta) }
      : { text: ((await res.json()).message?.content || '').trim() };
  } catch (err) {
    return connectionError(base, err);
  }
}

// Ollama streams newline-delimited JSON, one object per token chunk, with a
// final {done:true}. Normalized here to the same onDelta(text) callback the
// Anthropic MessageStream path uses, so /api/chat's SSE contract doesn't
// need to know which provider produced the tokens.
async function readStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // A chunk can split mid-line, so the trailing partial stays buffered
    // until the rest of it arrives.
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let chunk;
      try { chunk = JSON.parse(line); } catch { continue; }
      if (chunk.error) throw new Error(chunk.error);
      const text = chunk.message?.content;
      if (text) { full += text; onDelta(text); }
    }
  }
  return full.trim();
}
