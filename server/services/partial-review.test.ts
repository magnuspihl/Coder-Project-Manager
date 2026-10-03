/**
 * A partial review (nothing wrong in what the reviewer saw, but it did not see
 * all of the change) is its own outcome: persisted as 'partial', never closing
 * findings, never completing a deferred completion, never sent to the implementer.
 * Runs the real routing against a temporary database.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cpm-partial-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.CODER_WORKSPACE_NAME = 'local-ws';
process.env.CPM_CHECKPOINTS_BASE = join(dir, 'checkpoints');

let T: typeof import('./tasks.js');
let C: typeof import('./claude.js');
let getDb: typeof import('../db/index.js').getDb;
let loadError: Error | null = null;

before(async () => {
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

const decision = { outcome: 'pass' as const, summary: 'nothing wrong in what I read' };
const diff = (omitted: string[]) => ({
  text: '', changed: ['seen.ts', ...omitted], shown: ['seen.ts'], exempt: [],
  omitted: omitted.map(path => ({ path, reason: 'too large for the diff budget' })),
});

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

dbTest('a partial outcome is persisted and read back as partial, not pass', () => {
  const { task, turn } = reviewedTask('w-persist');
  T.completeTaskTurn(turn.id, 'partial', 'Partial review — not seen: a.ts');
  const back = T.getTaskTurns(task.id).find(t => t.id === turn.id)!;
  assert.equal(back.review_outcome, 'partial');
  assert.notEqual(back.review_outcome, 'pass');
});

dbTest('a pass over unread files is recorded as partial: it keeps open findings open, cancels the deferred completion and sends nothing to the implementer', () => {
  const { task, turn, finding } = reviewedTask('w-route');
  C._reviewContextsForTest.set(turn.id, { mode: 'opinion', profile: null, diff: diff(['core.ts']), toolCalls: [] });
  C.routeVerifiedReview(task, turn.id, decision, 'opinion', [], null);

  const stored = T.getTaskTurns(task.id).find(t => t.id === turn.id)!;
  assert.equal(stored.review_outcome, 'partial');
  assert.match(stored.review_summary ?? '', /Partial review — not seen: core\.ts/);
  assert.deepEqual(JSON.parse(stored.review_proofs!).coverage.unreviewed.map((u: { path: string }) => u.path), ['core.ts']);
  assert.equal(JSON.parse(stored.review_proofs!).verdict, undefined, 'one source of truth: the verdict lives in review_outcome only');

  const now = T.getTask(task.id)!;
  assert.equal(now.pending_complete, 0, 'a partial review is not the "review passed" a deferred completion waits for');
  assert.equal(now.status, 'awaiting_feedback');
  assert.equal(now.review_loop_count, 0, 'nothing was sent back to the implementer');
  assert.equal(T.getReviewFindings(task.id).find(f => f.id === finding.id)!.state, 'open', 'a pass would have closed it');
  assert.ok(T.getMessages(task.id).some(m => m.role === 'system' && /Partial review — not seen: core\.ts/.test(m.content)));
  assert.deepEqual(C.unreviewedFilesOfLatestReview(task.id), ['core.ts']);
});

dbTest('the same pass with every file covered is a real pass and does close open findings', () => {
  const { task, turn, finding } = reviewedTask('w-pass');
  T.setPendingComplete(task.id, false); // a deferred completion would try real git work; not under test here
  C._reviewContextsForTest.set(turn.id, { mode: 'opinion', profile: null, diff: diff([]), toolCalls: [] });
  C.routeVerifiedReview(task, turn.id, decision, 'opinion', [], null);
  assert.equal(T.getTaskTurns(task.id).find(t => t.id === turn.id)!.review_outcome, 'pass');
  assert.equal(T.getReviewFindings(task.id).find(f => f.id === finding.id)!.state, 'verified');
  assert.deepEqual(C.unreviewedFilesOfLatestReview(task.id), []);
});
