import * as cheerio from 'cheerio';
import dns from 'node:dns/promises';
import net from 'node:net';

// roadmap #13 — uploaded documents flow into the model's context, so a
// prompt-injected file could ask the agent to scrape an internal address
// (localhost, a private IP, or a cloud metadata endpoint) and hand the
// response back. Mitigations: only http(s) is allowed, every hostname
// (including each redirect hop, resolved individually) is checked against
// loopback/private/link-local ranges before it's fetched, redirects are
// followed manually instead of automatically so each hop gets that same
// check, and both a request timeout and a response-size cap bound the fetch.
const MAX_REDIRECTS   = 5;
const MAX_BYTES        = 2 * 1024 * 1024; // 2MB
const FETCH_TIMEOUT_MS = 8000;

export function isBlockedIp(ip) {
  const type = net.isIP(ip);
  if (!type) return true; // not a literal IP — treat as unsafe

  if (type === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return true;                          // loopback
    if (a === 10) return true;                            // private
    if (a === 172 && b >= 16 && b <= 31) return true;      // private
    if (a === 192 && b === 168) return true;               // private
    if (a === 169 && b === 254) return true;               // link-local (incl. 169.254.169.254 cloud metadata)
    if (a === 0) return true;                              // "this network"
    return false;
  }

  const lower = ip.toLowerCase();
  if (lower === '::1') return true;                       // loopback
  if (lower.startsWith('fe80:')) return true;              // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('::ffff:')) return isBlockedIp(lower.slice(7)); // IPv4-mapped
  return false;
}

async function hostIsSafe(hostname) {
  if (hostname.toLowerCase() === 'localhost') return false;
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every(a => !isBlockedIp(a.address));
}

async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader();
  if (!reader) return await res.text(); // no stream available — fall back
  const decoder = new TextDecoder();
  let received = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      reader.cancel().catch(() => {});
      return null;
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

export async function scrapeUrl(url, { maxChars = 8000 } = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return { error: 'Invalid URL' };
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return { error: `Blocked URL scheme: ${target.protocol}` };
    }
    if (!(await hostIsSafe(target.hostname))) {
      return { error: 'Blocked: URL resolves to a private, loopback, or link-local address' };
    }

    let res;
    try {
      res = await fetch(target, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AITutorBot/1.0)' },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
    } catch (err) {
      return { error: `Fetch failed: ${err.message}` };
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      try {
        target = new URL(res.headers.get('location'), target);
      } catch {
        return { error: 'Invalid redirect location' };
      }
      continue;
    }

    if (!res.ok) return { error: `HTTP ${res.status}` };

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return { error: `Not HTML (${ct})` };

    const body = await readCapped(res, MAX_BYTES);
    if (body == null) return { error: `Response too large (over ${MAX_BYTES} bytes)` };

    const $ = cheerio.load(body);
    $('script, style, nav, footer, header, noscript, svg, iframe').remove();

    const title = $('title').first().text().trim();
    let text = $('article').text() || $('main').text() || $('body').text();
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > maxChars) text = text.slice(0, maxChars) + ' …[truncated]';

    return { url: target.toString(), title, text };
  }

  return { error: 'Too many redirects' };
}
