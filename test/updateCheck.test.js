// Unit tests for tools/updateCheck.js — GitHub-release version comparison and
// repo-URL parsing (roadmap #4). Pure functions, no server/DB or network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepo, compareVersions } from '../tools/updateCheck.js';

test('parseRepo extracts owner/repo from an HTTPS GitHub URL', () => {
  assert.deepEqual(parseRepo('git+https://github.com/anthropics/tutor.git'), { owner: 'anthropics', repo: 'tutor' });
});

test('parseRepo extracts owner/repo from an SSH GitHub URL', () => {
  assert.deepEqual(parseRepo('git@github.com:anthropics/tutor.git'), { owner: 'anthropics', repo: 'tutor' });
});

test('parseRepo treats the OWNER/REPO placeholder as not configured', () => {
  assert.equal(parseRepo('git+https://github.com/OWNER/REPO.git'), null);
});

test('parseRepo returns null for a non-GitHub or missing URL', () => {
  assert.equal(parseRepo('git+https://gitlab.com/anthropics/tutor.git'), null);
  assert.equal(parseRepo(undefined), null);
});

test('compareVersions orders by numeric segment, not lexically', () => {
  assert.ok(compareVersions('1.100.0', '1.99.0') > 0, '1.100.0 must be newer than 1.99.0');
  assert.ok(compareVersions('1.9.0', '1.10.0') < 0);
  assert.equal(compareVersions('1.100.0', '1.100.0'), 0);
});

test('compareVersions handles differing segment counts', () => {
  assert.ok(compareVersions('1.100', '1.100.1') < 0);
  assert.ok(compareVersions('2', '1.99.99') > 0);
});
