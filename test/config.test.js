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
