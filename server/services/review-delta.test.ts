/**
 * Review signal quality: a re-review is measured against what changed since the
 * last fully covered review, and files that need no review (the reviewer's own
 * proof tests, captured fixtures) are not owed a read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessCoverage, buildReviewDiff, carriedNote, carryOver, coverageOutcome, exemptReason, pickBaselineReview,
  type CoverageReport, type ReviewBaseline,
} from './review-coverage.js';
import { getReviewDiffInfo, type Exec } from './review-io.js';

const fileDiff = (path: string, body = '+x') => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n${body}\n`;

// ---------------------------------------------------------------------------
// Exemptions
// ---------------------------------------------------------------------------

test("the reviewer's own proof tests are exempt from the read obligation", () => {
  assert.match(exemptReason('server/services/added-exports-apostrophe.cpm-proof.test.ts') ?? '', /proof test/);
  assert.match(exemptReason('tests/test_x.cpm_proof.py') ?? '', /proof test/);
  assert.equal(exemptReason('server/services/proof-of-concept.test.ts'), null, 'only the harness-written naming counts');
});

test('captured test-runner fixtures (data under a fixtures directory) are exempt', () => {
  for (const p of [
    'server/services/__fixtures__/test-runners/vitest-pass.json',
    'server/services/__fixtures__/test-runners/pytest-fail.xml',
    'server/services/__fixtures__/test-runners/node-pass.tap',
    'test/fixtures/out.txt',
    'pkg/testdata/golden.snap',
  ]) assert.match(exemptReason(p) ?? '', /fixture/, p);
});

test('a code file in a fixtures directory is NOT exempt, and neither is data outside one', () => {
  assert.equal(exemptReason('server/services/__fixtures__/helper.ts'), null);
  assert.equal(exemptReason('test/fixtures/make_data.py'), null);
  assert.equal(exemptReason('config/settings.json'), null);
});

test('exempt files are listed as exempt, with their reasons, and owe no read', () => {
  const diff = buildReviewDiff(
    fileDiff('a.ts') + fileDiff('x/__fixtures__/o.json') + fileDiff('x/y.cpm-proof.test.ts'),
    [], 32_000,
  );
  assert.deepEqual(diff.changed, ['a.ts']);
  assert.deepEqual(diff.exempt.map(e => e.path).sort(), ['x/__fixtures__/o.json', 'x/y.cpm-proof.test.ts']);
});

// ---------------------------------------------------------------------------
// Delta coverage (pure)
// ---------------------------------------------------------------------------

const baseline: ReviewBaseline = { reviewNumber: 1, reviewed: ['claude.ts', 'review-io.test.ts', 'edited.ts'], changedSince: ['edited.ts'] };

test('a file unchanged since a fully covered review is carried over, with the reason recorded', () => {
  const { owed, carried } = carryOver(['claude.ts', 'edited.ts', 'brand-new.ts'], baseline);
  assert.deepEqual(carried, [{ path: 'claude.ts', reason: 'covered by review 1, unchanged since' }]);
  assert.deepEqual(owed, ['edited.ts', 'brand-new.ts'], 'a file changed after being covered, or never covered, is owed again');
});

test('with no baseline every file is owed (today\'s merge-base behaviour)', () => {
  assert.deepEqual(carryOver(['a.ts'], null), { owed: ['a.ts'], carried: [] });
});

test('buildReviewDiff leaves carried files out of the diff and the obligation, and says so', () => {
  const diff = buildReviewDiff(fileDiff('claude.ts') + fileDiff('edited.ts'), ['review-io.test.ts'], 32_000, { baseline });
  assert.deepEqual(diff.changed, ['edited.ts']);
  assert.deepEqual(diff.carried.map(c => c.path).sort(), ['claude.ts', 'review-io.test.ts']);
  assert.doesNotMatch(diff.text, /diff --git a\/claude\.ts/);
  assert.match(carriedNote(diff), /RE-REVIEW[\s\S]*claude\.ts/);
});

test('a "review remaining files" run stays scoped: the baseline is ignored', () => {
  const diff = buildReviewDiff(fileDiff('claude.ts') + fileDiff('edited.ts'), [], 32_000, { baseline, onlyFiles: ['claude.ts'] });
  assert.deepEqual(diff.changed, ['claude.ts']);
  assert.deepEqual(diff.carried, []);
});

const stored = (cov: Partial<CoverageReport>) => JSON.stringify({ mode: 'proof', proofs: [], coverage: { reviewed: [], readViaTool: [], unreviewed: [], exempt: [], claimUnverified: false, stoppedByTurnCap: false, ...cov } });

test('the baseline is the latest review that was complete and recorded its tree', () => {
  const tree = 'a'.repeat(40);
  const pick = pickBaselineReview([
    { turnNumber: 1, stored: stored({ reviewedTree: 'b'.repeat(40), reviewed: ['old.ts'] }) },
    { turnNumber: 2, stored: stored({ reviewedTree: tree, reviewed: ['a.ts'], carried: [{ path: 'c.ts', reason: 'r' }] }) },
    { turnNumber: 3, stored: stored({ reviewedTree: 'c'.repeat(40), unreviewed: [{ path: 'z.ts', reason: 'never opened' }] }) },
    { turnNumber: 4, stored: stored({ reviewed: ['no-tree.ts'] }) },
    { turnNumber: 5, stored: null },
  ]);
  assert.deepEqual(pick, { reviewNumber: 2, tree, reviewed: ['a.ts', 'c.ts'] });
  assert.equal(pickBaselineReview([{ turnNumber: 1, stored: 'not json' }]), null, 'no usable earlier review: merge-base behaviour');
});

test('only a complete, unscoped review records its tree', () => {
  const tree = 'd'.repeat(40);
  const diff = { ...buildReviewDiff(fileDiff('a.ts'), [], 32_000, { tree }) };
  const calls = [{ name: 'Read', input: { file_path: '/wt/a.ts' } }];
  assert.equal(assessCoverage({ diff, worktree: '/wt', toolCalls: calls }).reviewedTree, tree);
  assert.equal(assessCoverage({ diff, worktree: '/wt', toolCalls: calls, scoped: true }).reviewedTree, undefined);
  const partial = buildReviewDiff(fileDiff('a.ts'), ['u.ts'], 32_000, { tree });
  assert.equal(assessCoverage({ diff: partial, worktree: '/wt', toolCalls: [] }).reviewedTree, undefined);
});

test("task 7c43422d, reconstructed: noise files and already-covered files no longer make the re-review partial", () => {
  const raw = [
    'server/services/claude.ts', 'server/services/review-io.test.ts', 'server/services/added-exports.ts',
    'server/services/__fixtures__/test-runners/jest-pass.json', 'server/services/__fixtures__/test-runners/node-pass.tap',
    'server/services/__fixtures__/test-runners/pytest-pass.xml', 'server/services/added-exports-apostrophe.cpm-proof.test.ts',
    'server/services/added-exports-python-import-tidy.cpm-proof.test.ts',
  ].map(p => fileDiff(p)).join('');
  const prior: ReviewBaseline = {
    reviewNumber: 1,
    reviewed: ['server/services/claude.ts', 'server/services/review-io.test.ts', 'server/services/added-exports.ts'],
    changedSince: ['server/services/added-exports.ts'],
  };
  const diff = buildReviewDiff(raw, [], 32_000, { baseline: prior });
  assert.deepEqual(diff.changed, ['server/services/added-exports.ts'], 'only the file that changed since is owed');
  // Everything the diff showed counts as seen; nothing is left unreviewed.
  const report = assessCoverage({ diff, worktree: '/wt', toolCalls: [] });
  assert.deepEqual(report.unreviewed, []);
  assert.equal(coverageOutcome('pass', report), 'pass');
});

// ---------------------------------------------------------------------------
// Delta coverage against a real git repository
// ---------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
const exec: Exec = (command, timeout = 60000, maxBuffer = 8 * 1024 * 1024) =>
  new Promise((res, rej) => {
    execFile('bash', ['-c', command], { timeout, maxBuffer }, (err, stdout) => (err && !stdout ? rej(err) : res(stdout.trim())));
  });

function taskRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cpm-delta-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 0;\n');
  writeFileSync(join(dir, 'b.ts'), 'export const b = 0;\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'task/x');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
  mkdirSync(join(dir, 'fx/__fixtures__'), { recursive: true });
  writeFileSync(join(dir, 'fx/__fixtures__/out.json'), '{}\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'work');
  return dir;
}

async function review(dir: string, prior?: { tree: string; reviewed: string[] }) {
  return getReviewDiffInfo(exec, dir, 32_000, { baselineReview: prior ? { reviewNumber: 1, ...prior } : null });
}

test('real repo: a file unchanged since the covered review is carried over; one changed afterwards is owed again', async () => {
  const dir = taskRepo();
  try {
    const first = await review(dir);
    assert.match(first.tree ?? '', /^[0-9a-f]{40}/, 'the reviewed tree is recorded');
    assert.deepEqual(first.changed.sort(), ['a.ts', 'b.ts']);
    assert.deepEqual(first.exempt.map(e => e.path), ['fx/__fixtures__/out.json']);

    writeFileSync(join(dir, 'b.ts'), 'export const b = 2;\n'); // uncommitted edit after the review
    const second = await review(dir, { tree: first.tree!, reviewed: ['a.ts', 'b.ts'] });
    assert.deepEqual(second.changed, ['b.ts']);
    assert.deepEqual(second.carried, [{ path: 'a.ts', reason: 'covered by review 1, unchanged since' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real repo: capturing the tree leaves the real index and working tree untouched', async () => {
  const dir = taskRepo();
  try {
    writeFileSync(join(dir, 'new.ts'), 'export {};\n');
    const before = git(dir, 'status', '--porcelain');
    await review(dir);
    assert.equal(git(dir, 'status', '--porcelain'), before, 'untracked stays untracked, nothing is staged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real repo: an amend or rebase that keeps a file\'s content keeps it carried over', async () => {
  const dir = taskRepo();
  try {
    const first = await review(dir);
    git(dir, 'commit', '-q', '--amend', '-m', 'work (reworded)'); // new commit id, same tree
    const second = await review(dir, { tree: first.tree!, reviewed: ['a.ts', 'b.ts'] });
    assert.deepEqual(second.changed, []);
    assert.equal(second.carried.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real repo: a reviewed tree that no longer exists falls back to the merge-base', async () => {
  const dir = taskRepo();
  try {
    const gone = 'e'.repeat(40);
    const diff = await review(dir, { tree: gone, reviewed: ['a.ts', 'b.ts'] });
    assert.deepEqual(diff.changed.sort(), ['a.ts', 'b.ts'], 'everything owed, as without a baseline');
    assert.deepEqual(diff.carried, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real repo: a "review remaining files" run ignores the baseline', async () => {
  const dir = taskRepo();
  try {
    const first = await review(dir);
    const scoped = await getReviewDiffInfo(exec, dir, 32_000, { onlyFiles: ['a.ts'], baselineReview: { reviewNumber: 1, tree: first.tree!, reviewed: ['a.ts', 'b.ts'] } });
    assert.deepEqual(scoped.changed, ['a.ts']);
    assert.deepEqual(scoped.carried, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
