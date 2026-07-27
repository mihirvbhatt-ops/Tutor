// BYO search-provider adapter (roadmap #1) — a thin, provider-specific fetch
// per supported provider, normalized to a single {title, url}[] shape so the
// caller (server.js) never needs to know which provider is configured. The
// full page text isn't fetched here — that's scrapeUrl's job (already
// SSRF-hardened), reused as-is for whatever URLs a search turns up.
const FETCH_TIMEOUT_MS = 10000;

async function tavilySearch(query, apiKey, count) {
  const res = await fetch('https://api.tavily.com/search', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ api_key: apiKey, query, max_results: count }),
    signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Tavily search failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map(r => ({ title: r.title, url: r.url }));
}

async function braveSearch(query, apiKey, count) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
    signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Brave search failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).map(r => ({ title: r.title, url: r.url }));
}

async function serperSearch(query, apiKey, count) {
  const res = await fetch('https://google.serper.dev/search', {
    method:  'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ q: query, num: count }),
    signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Serper search failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.organic || []).map(r => ({ title: r.title, url: r.link }));
}

const PROVIDERS = { tavily: tavilySearch, brave: braveSearch, serper: serperSearch };

export function isKnownProvider(provider) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, provider);
}

// Same convention as scraper.js: return { error } on failure rather than
// throwing, so callers get one consistent shape to check regardless of
// which stage (config, network, provider response) went wrong.
export async function webSearch(query, provider, apiKey, count = 5) {
  const search = PROVIDERS[provider];
  if (!search) return { error: `Unknown search provider: ${provider}` };
  if (!apiKey) return { error: 'No search API key configured' };
  try {
    const results = await search(query, apiKey, count);
    return { results };
  } catch (err) {
    return { error: err.message };
  }
}
