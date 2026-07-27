import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const CACHE_TTL_MS = 60 * 60 * 1000; // GitHub's unauthenticated rate limit is 60 req/hr per IP
const FETCH_TIMEOUT_MS = 5000;

let cache = null; // { expiresAt, result }

// package.json's repository.url still carries the OWNER/REPO placeholder until
// this project is pushed to a real GitHub repo — treat that as "not configured"
// rather than querying GitHub for a repo that doesn't exist.
export function parseRepo(url) {
  const match = typeof url === 'string' && url.match(/github\.com[:/]+([^/]+)\/([^/.]+)/);
  if (!match) return null;
  const [, owner, repo] = match;
  if (owner === 'OWNER' || repo === 'REPO') return null;
  return { owner, repo };
}

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function checkForUpdate() {
  const currentVersion = pkg.version;
  const repo = parseRepo(pkg.repository && pkg.repository.url);
  if (!repo) return { configured: false, currentVersion };

  if (cache && cache.expiresAt > Date.now()) return cache.result;

  try {
    const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ai-tutor-update-check' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);

    const data = await res.json();
    const latestVersion = String(data.tag_name || '').replace(/^v/, '') || null;
    const result = {
      configured:      true,
      currentVersion,
      latestVersion,
      updateAvailable: latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false,
      releaseUrl:      data.html_url || null
    };
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, result };
    return result;
  } catch (err) {
    // Network hiccups or GitHub being unreachable shouldn't ever surface as an
    // app error — silently fall back to "no update known" and try again next time.
    return { configured: true, currentVersion, latestVersion: null, updateAvailable: false, releaseUrl: null, error: err.message };
  }
}
