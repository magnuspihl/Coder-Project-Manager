/**
 * A review must never "pass" when its tests could not run.
 *
 * The incident: a worktree with no node_modules. The reviewer's proof failed
 * with "Cannot find package 'tsx'", the whole suite ran zero tests, the proof
 * was classified unproven (advisory, non-blocking) — and the review was
 * recorded as a PASS. Here the proofs are run for real through the harness's
 * own run command (in temp directories, with and without the runner
 * installed) and routed through the real review routing against a temporary
 * database.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewDecision, ReviewIssue } from './review-verdict.js';
import type { TestProfile } from './test-runners.js';

const dir = mkdtempSync(join(tmpdir(), 'cpm-unverified-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.CODER_WORKSPACE_NAME = 'local-ws';
process.env.CPM_CHECKPOINTS_BASE = join(dir, 'checkpoints');

let T: typeof import('./tasks.js');
let C: typeof import('./claude.js');
let R: typeof import('./review-proof.js');
let IO: typeof import('./review-io.js');
let getDb: typeof import('../db/index.js').getDb;
let loadError: Error | null = null;

before(async () => {
  R = await import('./review-proof.js');
  IO = await import('./review-io.js');
  try {
    ({ getDb } = await import('../db/index.js'));
    T = await import('./tasks.js');
    C = await import('./claude.js');
    getDb().prepare("INSERT INTO users (id, username) VALUES ('u', 'tester')").run();
  } catch (err) {
    loadError = err as Error;
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

const dbTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, async t => { if (loadError) return t.skip(`database unavailable: ${loadError.message.slice(0, 80)}`); await fn(); });

/**
 * Runs the harness's scripts locally, as sshExec does for the local workspace.
 * NODE_TEST_CONTEXT is dropped: inherited from this test run, it would make the
 * proof's own `node --test` report to us instead of printing its TAP report.
 */
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const localExec = (cmd: string, timeoutMs = 60000) => new Promise<string>((resolve, reject) => {
  execFile('sh', ['-c', cmd], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: childEnv }, (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)));
});

const tsxProfile: TestProfile = { runner: 'node-test', command: 'node --import tsx --test', source: 'detected' };
const plainNode: TestProfile = { runner: 'node-test', source: 'detected' };
const failDecision: ReviewDecision = { outcome: 'fail', summary: 'empty input crashes the parser' };
const passDecision: ReviewDecision = { outcome: 'pass', summary: 'looks right' };

/** Write and run one proof for real in an empty temp worktree (no node_modules anywhere up the tree). */
async function runProof(profile: TestProfile, path: string, content: string) {
  const worktree = mkdtempSync(join(dir, 'wt-'));
  const issue: ReviewIssue = { text: 'empty input crashes the parser', requirement: 'must accept empty input', proofPath: path };
  return R.verifyProofs({ issues: [issue], files: [{ path, content }], profile, io: IO.makeProofIO(localExec, worktree, profile) });
}

const PASSING_TEST = "import test from 'node:test';\ntest('parses empty input', () => {});\n";

// ---------------------------------------------------------------------------
// The outcome, decided from real runs
// ---------------------------------------------------------------------------

test('a proof that cannot run because a module is missing makes the review unverified, not pass', { timeout: 60000 }, async () => {
  const verified = await runProof(tsxProfile, 'src/parse.cpm-proof.test.ts', PASSING_TEST);
  assert.equal(verified[0].proof.status, 'unproven');
  assert.equal(verified[0].proof.environment, true, 'the runner, not the test, is what failed');
  assert.match(verified[0].proof.output, /Cannot find package 'tsx'/);
  assert.equal(R.repairable(verified).length, 0, 'no reviewer repair round is spent on a missing runner');

  const routed = R.routeReview('proof', failDecision, verified);
  assert.equal(routed.outcome, 'unverified');
  assert.notEqual(routed.outcome, 'pass');
  assert.match(routed.unverifiedReason ?? '', /^tests could not run: .*"tsx" is not installed/);
  assert.deepEqual(R.toStored(routed, verified).unverified, { reason: routed.unverifiedReason });
});

test('a refuted proof — it runs and passes — still lets the review pass', { timeout: 60000 }, async () => {
  const verified = await runProof(plainNode, 'src/parse.cpm-proof.test.mjs', PASSING_TEST);
  assert.equal(verified[0].proof.status, 'refuted');
  const routed = R.routeReview('proof', failDecision, verified);
  assert.equal(routed.outcome, 'pass');
  assert.equal(routed.unverifiedReason, undefined);
});

test('a proof that runs and fails still fails the review, even when the environment was reported broken', { timeout: 60000 }, async () => {
  const failing = "import test from 'node:test';\nimport assert from 'node:assert';\ntest('parses empty input', () => { assert.equal(1, 2); });\n";
  const verified = await runProof(plainNode, 'src/parse.cpm-proof.test.mjs', failing);
  assert.equal(verified[0].proof.status, 'confirmed');
  assert.equal(R.routeReview('proof', failDecision, verified, 'tests could not run: the whole suite errored').outcome, 'fail');
});

test('a suite that errors before running any test makes a finding-free review unverified', () => {
  const routed = R.routeReview('proof', passDecision, [], 'tests could not run: the whole suite errored before running any test (Cannot find package \'tsx\')');
  assert.equal(routed.outcome, 'unverified');
});

test('an opinion-mode review is unaffected: the reviewer\'s word stands', () => {
  assert.equal(R.routeReview('opinion', passDecision, [], 'tests could not run: anything').outcome, 'pass');
});

// ---------------------------------------------------------------------------
// What the task looks like afterwards
// ---------------------------------------------------------------------------

/** An awaiting task with an open blocking finding from an earlier review and a deferred completion. */
function reviewedTask(workspaceId: string) {
  const task = T.createTask({ workspaceId, workspaceName: 'local-ws', userId: 'u', username: 'tester', prompt: 'p' });
  T.updateTaskStatus(task.id, 'working');
  T.setPendingComplete(task.id, true);
  const earlier = T.createTaskTurn({ taskId: task.id, role: 'reviewer' });
  T.completeTaskTurn(earlier.id, 'fail', 'earlier');
  const [finding] = T.createReviewFindings(task.id, earlier.id, [{ body: 'earlier problem', severity: 'blocking' }]);
  const turn = T.createTaskTurn({ taskId: task.id, role: 'reviewer' });
  return { task: T.getTask(task.id)!, turn, finding };
}

dbTest('an unverified review is recorded as unverified: the task returns to awaiting feedback, open findings stay open, a deferred completion is cancelled and nothing goes to the implementer', async () => {
  const verified = await runProof(tsxProfile, 'src/parse.cpm-proof.test.ts', PASSING_TEST);
  const { task, turn, finding } = reviewedTask('w-unverified');
  C.routeVerifiedReview(task, turn.id, failDecision, 'proof', verified, tsxProfile);

  const stored = T.getTaskTurns(task.id).find(t => t.id === turn.id)!;
  assert.equal(stored.review_outcome, 'unverified');
  assert.match(stored.review_summary ?? '', /^Unverified — tests could not run: /);
  assert.doesNotMatch(stored.review_summary ?? '', /does not block/, 'the old "pass, does not block" wording is gone');
  assert.match(JSON.parse(stored.review_proofs!).unverified.reason, /tests could not run/);

  const now = T.getTask(task.id)!;
  assert.equal(now.status, 'awaiting_feedback');
  assert.equal(now.pending_complete, 0, 'an unverified review is not the "review passed" a deferred completion waits for');
  assert.equal(now.review_loop_count, 0, 'nothing was sent back to the implementer');
  assert.equal(T.getReviewFindings(task.id).find(f => f.id === finding.id)!.state, 'open', 'a pass would have closed it');
  const advisory = T.getReviewFindings(task.id).filter(f => f.turn_id === turn.id);
  assert.deepEqual(advisory.map(f => f.severity), ['advisory'], 'the reviewer\'s finding is kept, as advisory');
  const msg = T.getMessages(task.id).find(m => m.kind === 'unverified_review');
  assert.ok(msg, 'the conversation says why');
  assert.match(msg!.content, /tests could not run/i);
  assert.match(msg!.content, /NOT a pass/);
});

dbTest('a finding-free review whose suite could not run is recorded as unverified', () => {
  const { task, turn } = reviewedTask('w-suite');
  C.routeVerifiedReview(task, turn.id, passDecision, 'proof', [], tsxProfile, 'tests could not run: the whole suite errored before running any test');
  assert.equal(T.getTaskTurns(task.id).find(t => t.id === turn.id)!.review_outcome, 'unverified');
  assert.equal(T.getTask(task.id)!.status, 'awaiting_feedback');
});

dbTest('a review whose proof ran and was refuted still passes and closes outstanding findings', async () => {
  const verified = await runProof(plainNode, 'src/parse.cpm-proof.test.mjs', PASSING_TEST);
  const { task, turn, finding } = reviewedTask('w-pass');
  T.setPendingComplete(task.id, false); // a deferred completion would try real git work; not under test here
  C.routeVerifiedReview(task, turn.id, failDecision, 'proof', verified, plainNode, null);
  assert.equal(T.getTaskTurns(task.id).find(t => t.id === turn.id)!.review_outcome, 'pass');
  assert.equal(T.getReviewFindings(task.id).find(f => f.id === finding.id)!.state, 'verified');
  assert.equal(T.getMessages(task.id).some(m => m.kind === 'unverified_review'), false);
});

dbTest('an unverified review records no reviewed tree, so the next review re-reads every file instead of carrying them over', async () => {
  const { pickBaselineReview } = await import('./review-coverage.js');
  const { task, turn } = reviewedTask('w-baseline');
  const fullyShown = { text: '', changed: ['seen.ts'], shown: ['seen.ts'], exempt: [], carried: [], omitted: [], tree: 'b'.repeat(40) };
  C._reviewContextsForTest.set(turn.id, { mode: 'proof', profile: tsxProfile, diff: fullyShown, toolCalls: [] });
  C.routeVerifiedReview(task, turn.id, passDecision, 'proof', [], tsxProfile, 'tests could not run: no dependencies installed in the worktree');

  const stored = T.getTaskTurns(task.id).find(t => t.id === turn.id)!;
  assert.equal(stored.review_outcome, 'unverified');
  assert.equal(JSON.parse(stored.review_proofs!).coverage.reviewedTree, undefined);
  assert.equal(pickBaselineReview([{ turnNumber: stored.turn_number, stored: stored.review_proofs }]), null);
});
