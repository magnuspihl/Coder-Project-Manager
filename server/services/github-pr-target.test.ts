import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubRepoSlug, resolveGhPrTarget } from './github-pr-target.js';

const BRANCH = 'task/palisade-scheduling-has-improved-but-as--c987145c';

test('reads owner and repo from https, ssh and web-style GitHub URLs', () => {
  const want = { owner: 'magnuspihl', repo: 'palisade' };
  assert.deepEqual(parseGitHubRepoSlug('https://github.com/magnuspihl/palisade'), want);
  assert.deepEqual(parseGitHubRepoSlug('https://github.com/magnuspihl/palisade.git'), want);
  assert.deepEqual(parseGitHubRepoSlug('https://github.com/magnuspihl/palisade/'), want);
  assert.deepEqual(parseGitHubRepoSlug('git@github.com:magnuspihl/palisade.git'), want);
  assert.deepEqual(parseGitHubRepoSlug('ssh://git@github.com/magnuspihl/palisade.git'), want);
});

test('does not treat non-github.com remotes as GitHub repos', () => {
  assert.equal(parseGitHubRepoSlug('https://github.example.com/org/repo'), null);
  assert.equal(parseGitHubRepoSlug('https://dev.azure.com/org/proj/_git/repo'), null);
  assert.equal(parseGitHubRepoSlug(''), null);
  assert.equal(parseGitHubRepoSlug(null), null);
});

test('fork PRs target the upstream repo and name the fork owner on the head branch', () => {
  // The Palisade failure: origin is the fork, upstream is someone else's repo.
  assert.deepEqual(
    resolveGhPrTarget(BRANCH, 'https://github.com/magnuspihl/palisade', 'https://github.com/Shakes63/palisade'),
    { repo: 'Shakes63/palisade', head: `magnuspihl:${BRANCH}` },
  );
});

test('a normal PR is pinned to origin and uses the bare branch name', () => {
  assert.deepEqual(
    resolveGhPrTarget(BRANCH, 'https://github.com/magnuspihl/cpm'),
    { repo: 'magnuspihl/cpm', head: BRANCH },
  );
});

test('a base remote pointing at the same repo as origin is not treated as a fork', () => {
  assert.deepEqual(
    resolveGhPrTarget(BRANCH, 'git@github.com:magnuspihl/palisade.git', 'https://github.com/MagnusPihl/Palisade'),
    { repo: 'MagnusPihl/Palisade', head: BRANCH },
  );
});

test('an unreadable upstream never falls back to opening the PR on the fork', () => {
  assert.deepEqual(
    resolveGhPrTarget(BRANCH, 'https://github.com/magnuspihl/palisade', 'https://ghe.example.com/org/palisade'),
    { repo: null, head: BRANCH },
  );
});

test('non-GitHub remotes leave repo selection to gh', () => {
  assert.deepEqual(
    resolveGhPrTarget(BRANCH, 'https://ghe.example.com/org/repo'),
    { repo: null, head: BRANCH },
  );
});
