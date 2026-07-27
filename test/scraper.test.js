// roadmap #13 — SSRF guardrails on the URL scraper. Only exercises paths that
// resolve without a real network call (literal IPs, invalid schemes) so the
// suite stays offline-safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeUrl, isBlockedIp } from '../tools/scraper.js';

test('isBlockedIp blocks loopback, private, and link-local (incl. cloud metadata) v4 ranges', () => {
  assert.equal(isBlockedIp('127.0.0.1'), true);
  assert.equal(isBlockedIp('10.0.0.5'), true);
  assert.equal(isBlockedIp('172.16.0.1'), true);
  assert.equal(isBlockedIp('172.31.255.255'), true);
  assert.equal(isBlockedIp('192.168.1.1'), true);
  assert.equal(isBlockedIp('169.254.169.254'), true); // cloud metadata endpoint
  assert.equal(isBlockedIp('0.0.0.0'), true);
});

test('isBlockedIp allows public v4 addresses and the 172.32 range just outside the private block', () => {
  assert.equal(isBlockedIp('8.8.8.8'), false);
  assert.equal(isBlockedIp('172.32.0.1'), false);
  assert.equal(isBlockedIp('172.15.255.255'), false);
});

test('isBlockedIp blocks loopback, link-local, and unique-local v6 addresses', () => {
  assert.equal(isBlockedIp('::1'), true);
  assert.equal(isBlockedIp('fe80::1'), true);
  assert.equal(isBlockedIp('fc00::1'), true);
  assert.equal(isBlockedIp('fd12:3456::1'), true);
  assert.equal(isBlockedIp('::ffff:127.0.0.1'), true); // IPv4-mapped loopback
});

test('isBlockedIp allows a public v6 address', () => {
  assert.equal(isBlockedIp('2001:4860:4860::8888'), false);
});

test('scrapeUrl rejects a non-http(s) scheme without making any request', async () => {
  const result = await scrapeUrl('ftp://example.com/file.txt');
  assert.match(result.error, /Blocked URL scheme/);
});

test('scrapeUrl rejects a malformed URL', async () => {
  const result = await scrapeUrl('not a url');
  assert.equal(result.error, 'Invalid URL');
});

test('scrapeUrl blocks a literal loopback IP target', async () => {
  const result = await scrapeUrl('http://127.0.0.1:9999/');
  assert.match(result.error, /Blocked: URL resolves to/);
});

test('scrapeUrl blocks the cloud metadata endpoint', async () => {
  const result = await scrapeUrl('http://169.254.169.254/latest/meta-data/');
  assert.match(result.error, /Blocked: URL resolves to/);
});

test('scrapeUrl blocks literal "localhost" without a DNS lookup', async () => {
  const result = await scrapeUrl('http://localhost:9999/');
  assert.match(result.error, /Blocked: URL resolves to/);
});
