// roadmap #3 — db/config.js resolves the Anthropic API key from the
// environment (dev/CI override) or a local 0600 JSON file (what the
// Settings UI writes to). Runs against a throwaway config file, never the
// real db/config.json, and restores the real ANTHROPIC_API_KEY afterward so
// this file's env mutation can't leak into other test files.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_CONFIG = path.join(__dirname, '.test-config.json');
fs.rmSync(TEST_CONFIG, { force: true });
process.env.TUTOR_CONFIG_PATH = TEST_CONFIG;

const ORIGINAL_ENV_KEY = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const cfg = await import('../db/config.js');

beforeEach(() => fs.rmSync(TEST_CONFIG, { force: true }));
after(() => {
  fs.rmSync(TEST_CONFIG, { force: true });
  if (ORIGINAL_ENV_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_ENV_KEY;
});

test('getApiKey/getApiKeySource return null when neither env nor file is set', () => {
  assert.equal(cfg.getApiKey(), null);
  assert.equal(cfg.getApiKeySource(), null);
});

test('saveApiKey persists to the file, and getApiKey/getApiKeySource pick it up', () => {
  cfg.saveApiKey('sk-ant-file-key');
  assert.equal(cfg.getApiKey(), 'sk-ant-file-key');
  assert.equal(cfg.getApiKeySource(), 'file');
});

test('saveApiKey writes the file with owner-only (0600) permissions', () => {
  cfg.saveApiKey('sk-ant-file-key');
  const mode = fs.statSync(TEST_CONFIG).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('the environment variable takes precedence over a saved file key', () => {
  cfg.saveApiKey('sk-ant-file-key');
  process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
  assert.equal(cfg.getApiKey(), 'sk-ant-env-key');
  assert.equal(cfg.getApiKeySource(), 'env');
  delete process.env.ANTHROPIC_API_KEY;
});

test('getProvider defaults to "anthropic" and reflects whatever saveApiKey was given', () => {
  assert.equal(cfg.getProvider(), 'anthropic');
  cfg.saveApiKey('sk-ant-file-key', 'anthropic');
  assert.equal(cfg.getProvider(), 'anthropic');
});

test('clearApiKey removes the key but leaves the rest of the config (provider) intact', () => {
  cfg.saveApiKey('sk-ant-file-key', 'anthropic');
  cfg.clearApiKey();
  assert.equal(cfg.getApiKey(), null);
  assert.equal(cfg.getProvider(), 'anthropic');
});

// ── Search provider / API key (roadmap #1) ──────────────────────────────────
const ORIGINAL_ENV = { TAVILY_API_KEY: process.env.TAVILY_API_KEY, BRAVE_API_KEY: process.env.BRAVE_API_KEY };
delete process.env.TAVILY_API_KEY;
delete process.env.BRAVE_API_KEY;
after(() => {
  for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
    if (val === undefined) delete process.env[key]; else process.env[key] = val;
  }
});

test('getSearchProvider defaults to "tavily" when nothing is configured', () => {
  assert.equal(cfg.getSearchProvider(), 'tavily');
});

test('getSearchApiKey/getSearchApiKeySource return null when neither env nor file is set', () => {
  assert.equal(cfg.getSearchApiKey(), null);
  assert.equal(cfg.getSearchApiKeySource(), null);
});

test('saveSearchConfig persists provider + key, and getSearchApiKey/getSearchApiKeySource pick it up', () => {
  cfg.saveSearchConfig('tvly-file-key', 'brave');
  assert.equal(cfg.getSearchProvider(), 'brave');
  assert.equal(cfg.getSearchApiKey(), 'tvly-file-key');
  assert.equal(cfg.getSearchApiKeySource(), 'file');
});

test('the matching provider env var takes precedence over a saved file key', () => {
  cfg.saveSearchConfig('tvly-file-key', 'tavily');
  process.env.TAVILY_API_KEY = 'tvly-env-key';
  assert.equal(cfg.getSearchApiKey(), 'tvly-env-key');
  assert.equal(cfg.getSearchApiKeySource(), 'env');
  delete process.env.TAVILY_API_KEY;
});

test('an env var for a different provider than the one configured is ignored', () => {
  cfg.saveSearchConfig('tvly-file-key', 'tavily');
  process.env.BRAVE_API_KEY = 'brave-env-key'; // configured provider is tavily, not brave
  assert.equal(cfg.getSearchApiKey(), 'tvly-file-key');
  assert.equal(cfg.getSearchApiKeySource(), 'file');
  delete process.env.BRAVE_API_KEY;
});

test('clearSearchConfig removes the key but leaves the provider and the Anthropic key intact', () => {
  cfg.saveApiKey('sk-ant-file-key', 'anthropic');
  cfg.saveSearchConfig('tvly-file-key', 'serper');
  cfg.clearSearchConfig();
  assert.equal(cfg.getSearchApiKey(), null);
  assert.equal(cfg.getSearchProvider(), 'serper');
  assert.equal(cfg.getApiKey(), 'sk-ant-file-key');
});

// ── Local inference provider / routing (roadmap #3) ─────────────────────────
const ORIGINAL_OLLAMA_HOST = process.env.OLLAMA_HOST;
delete process.env.OLLAMA_HOST;
after(() => {
  if (ORIGINAL_OLLAMA_HOST === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = ORIGINAL_OLLAMA_HOST;
});

test('getLocalModelConfig defaults to the loopback host with no model configured', () => {
  assert.deepEqual(cfg.getLocalModelConfig(), { host: 'http://127.0.0.1:11434', model: null });
  assert.equal(cfg.getLocalModelHostSource(), 'default');
});

test('saveLocalModelConfig persists host and model', () => {
  cfg.saveLocalModelConfig('http://192.168.1.50:11434', 'llama3.1:8b');
  assert.deepEqual(cfg.getLocalModelConfig(), { host: 'http://192.168.1.50:11434', model: 'llama3.1:8b' });
  assert.equal(cfg.getLocalModelHostSource(), 'file');
});

test('OLLAMA_HOST takes precedence over a saved host, matching the API-key rules', () => {
  cfg.saveLocalModelConfig('http://192.168.1.50:11434', 'llama3.1:8b');
  process.env.OLLAMA_HOST = 'http://10.0.0.9:11434';
  assert.equal(cfg.getLocalModelConfig().host, 'http://10.0.0.9:11434');
  assert.equal(cfg.getLocalModelHostSource(), 'env');
  // The model is unaffected — only the host has an env-var equivalent.
  assert.equal(cfg.getLocalModelConfig().model, 'llama3.1:8b');
  delete process.env.OLLAMA_HOST;
});

test('an empty host falls back to the default rather than being saved blank', () => {
  cfg.saveLocalModelConfig('   ', 'llama3.1:8b');
  assert.equal(cfg.getLocalModelConfig().host, 'http://127.0.0.1:11434');
});

test('getInferenceRouting defaults every call site to anthropic', () => {
  assert.deepEqual(cfg.getInferenceRouting(), {
    grading: 'anthropic', generation: 'anthropic', agent: 'anthropic'
  });
});

test('saveInferenceRouting persists per-call-site choices independently', () => {
  cfg.saveInferenceRouting({ grading: 'ollama' });
  assert.deepEqual(cfg.getInferenceRouting(), {
    grading: 'ollama', generation: 'anthropic', agent: 'anthropic'
  });
  cfg.saveInferenceRouting({ generation: 'ollama' });
  assert.deepEqual(cfg.getInferenceRouting(), {
    grading: 'ollama', generation: 'ollama', agent: 'anthropic'
  });
});

test('unknown providers and unknown call sites are ignored, not persisted', () => {
  cfg.saveInferenceRouting({ grading: 'openai', nonsense: 'ollama' });
  const routing = cfg.getInferenceRouting();
  assert.equal(routing.grading, 'anthropic'); // rejected value left at the default
  assert.equal('nonsense' in routing, false);
});

test('routing can be moved back to anthropic after being set local', () => {
  cfg.saveInferenceRouting({ grading: 'ollama' });
  cfg.saveInferenceRouting({ grading: 'anthropic' });
  assert.equal(cfg.getInferenceRouting().grading, 'anthropic');
});

test('clearLocalModelConfig also resets routing so nothing points at a missing model', () => {
  cfg.saveLocalModelConfig('http://127.0.0.1:11434', 'llama3.1:8b');
  cfg.saveInferenceRouting({ grading: 'ollama', generation: 'ollama' });
  cfg.clearLocalModelConfig();
  assert.equal(cfg.getLocalModelConfig().model, null);
  assert.deepEqual(cfg.getInferenceRouting(), {
    grading: 'anthropic', generation: 'anthropic', agent: 'anthropic'
  });
});

test('clearLocalModelConfig leaves the Anthropic and search keys intact', () => {
  cfg.saveApiKey('sk-ant-file-key', 'anthropic');
  cfg.saveSearchConfig('tvly-file-key', 'tavily');
  cfg.saveLocalModelConfig('http://127.0.0.1:11434', 'llama3.1:8b');
  cfg.clearLocalModelConfig();
  assert.equal(cfg.getApiKey(), 'sk-ant-file-key');
  assert.equal(cfg.getSearchApiKey(), 'tvly-file-key');
});
