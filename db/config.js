// Local, file-based app config — currently just the AI provider + API key.
// roadmap #3 — the only way to set ANTHROPIC_API_KEY used to be a .env file,
// unusable by anyone who isn't comfortable with environment variables. This
// gives Settings a place to write a key to instead: a small JSON file next
// to tutor.db, created with owner-only permissions since it holds a secret.
//
// The environment variable still wins when present — that keeps the existing
// dev/CI workflow (and this project's own test suite, which sets a fake key
// via ANTHROPIC_API_KEY) working unchanged; the file is only ever the
// fallback the Settings UI writes to.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Overridable for tests, same pattern as TUTOR_DB_PATH in db/sqlite.js.
const CONFIG_PATH = process.env.TUTOR_CONFIG_PATH || path.join(__dirname, 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(next) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  // Belt-and-suspenders: if the file already existed with looser permissions
  // (e.g. created before this project enforced 0o600), writeFileSync's mode
  // option only applies on creation — force it on every write instead.
  fs.chmodSync(CONFIG_PATH, 0o600);
}

export function getApiKey() {
  return process.env.ANTHROPIC_API_KEY || readConfig().apiKey || null;
}

// 'env' | 'file' | null — lets the UI explain *why* a key is or isn't active,
// and warn that a file-saved key is shadowed while the env var is set.
export function getApiKeySource() {
  if (process.env.ANTHROPIC_API_KEY) return 'env';
  if (readConfig().apiKey) return 'file';
  return null;
}

export function getProvider() {
  return readConfig().provider || 'anthropic';
}

export function saveApiKey(apiKey, provider = 'anthropic') {
  writeConfig({ ...readConfig(), apiKey, provider });
}

export function clearApiKey() {
  const config = readConfig();
  delete config.apiKey;
  writeConfig(config);
}

// ── Search provider / API key (roadmap #1) ──────────────────────────────────
// Same file, same precedence rules as the Anthropic key above: each
// provider's own conventional env var wins when set (so an existing
// TAVILY_API_KEY etc. in a dev's shell just works), the saved file is the
// fallback the Settings UI writes to.
const SEARCH_ENV_VARS = { tavily: 'TAVILY_API_KEY', brave: 'BRAVE_API_KEY', serper: 'SERPER_API_KEY' };

export function getSearchProvider() {
  return readConfig().searchProvider || 'tavily';
}

export function getSearchApiKey() {
  const envVar = SEARCH_ENV_VARS[getSearchProvider()];
  return (envVar && process.env[envVar]) || readConfig().searchApiKey || null;
}

// 'env' | 'file' | null — same rationale as getApiKeySource above.
export function getSearchApiKeySource() {
  const envVar = SEARCH_ENV_VARS[getSearchProvider()];
  if (envVar && process.env[envVar]) return 'env';
  if (readConfig().searchApiKey) return 'file';
  return null;
}

export function saveSearchConfig(apiKey, provider = 'tavily') {
  writeConfig({ ...readConfig(), searchApiKey: apiKey, searchProvider: provider });
}

export function clearSearchConfig() {
  const config = readConfig();
  delete config.searchApiKey;
  writeConfig(config);
}
