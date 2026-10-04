/**
 * The manual review trigger must answer as soon as the review is accepted: the
 * review-time verification (up to 8 minutes) and the reviewer launch run after
 * the response, and a failure there must be recorded on the task. Runs against a
 * real temporary database and a real temporary git repo (the "workspace" is this
 * machine), with only the slow reviewer launch replaced.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cpm-manual-review-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.CODER_WORKSPACE_NAME = 'local-ws';
process.env.CPM_CHECKPOINTS_BASE = join(dir, 'checkpoints'); // never touch the real checkpoint store

let T: typeof import('./tasks.js');
let getDb: typeof import('../db/index.js').getDb;
let C: typeof import('./claude.js');
let loadError: Error | null = null;
const repo = join(dir, 'repo');

before(async () => {
  try {
    ({ getDb } = await import('../db/index.js'));
    T = await import('./tasks.js');
    C = await import('./claude.js');
    getDb().prepare("INSERT INTO users (id, username) VALUES ('u', 'tester')").run();
  } catch (err) {
    loadError = err as Error; // e.g. better-sqlite3's native module isn't built in this checkout
    return;
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  writeFileSync(join(repo, 'a.txt'), 'two\n'); // an uncommitted change: something to review
});
after(() => rmSync(dir, { recursive: true, force: true }));

const skipIfNoDb = (name: string, fn: () => void | Promise<void>) =>
  test(name, async t => { if (loadError) return t.skip(`database unavailable: ${loadError.message.slice(0, 80)}`); await fn(); });

function awaitingTask(workspaceId = 'w1') {
  const task = T.createTask({ workspaceId, workspaceName: 'local-ws', userId: 'u', username: 'tester', prompt: 'p' });
  T.updateTaskStatus(task.id, 'awaiting_feedback');
  getDb().prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?').run(repo, task.id);
  return T.getTask(task.id)!;
}
const messages = (id: string) => T.getMessages(id).filter(m => m.role === 'system').map(m => m.content);

skipIfNoDb('responds immediately with the task working under the reviewer, without waiting for verification or the launch', async () => {
  const task = awaitingTask();
  const launchStarted: string[] = [];
  const launched = await C.triggerManualReview(task, () => { launchStarted.push(task.id); return new Promise<void>(() => {}); }); // never finishes
  assert.equal(launched, true);
  assert.deepEqual(launchStarted, [task.id], 'the launch is kicked off, just not awaited');
  const now = T.getTask(task.id)!;
  assert.equal(now.status, 'working');
  assert.equal(now.active_turn_role, 'reviewer');
  assert.equal(T.getMessages(task.id).find(m => /Manual review requested/.test(m.content))?.kind, 'review_started', 'tagged, not left for the client to pattern-match');
});

skipIfNoDb('records a launch failure that happens after the response as a message and hands the task back', async () => {
  const task = awaitingTask('w2');
  const launched = await C.triggerManualReview(task, async () => { throw new Error('workspace unreachable'); });
  assert.equal(launched, true);
  await new Promise(r => setImmediate(r)); // let the background rejection be handled
  const now = T.getTask(task.id)!;
  assert.equal(now.status, 'awaiting_feedback');
  assert.equal(now.active_turn_role, null);
  assert.ok(messages(task.id).some(m => /review could not be started: workspace unreachable/.test(m)));
});

skipIfNoDb('refuses synchronously (no launch) when the worktree has no changes', async () => {
  const clean = join(dir, 'clean');
  execFileSync('git', ['init', '-q', '-b', 'main', clean]);
  execFileSync('git', ['-C', clean, '-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const task = awaitingTask('w3');
  getDb().prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?').run(clean, task.id);
  let launched = false;
  const result = await C.triggerManualReview(T.getTask(task.id)!, async () => { launched = true; });
  assert.equal(result, false);
  assert.equal(launched, false);
  assert.equal(T.getTask(task.id)!.status, 'awaiting_feedback');
});
