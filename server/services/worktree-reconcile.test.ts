/**
 * Cleaning up worktrees left behind by deleted tasks must never wake a stopped
 * workspace (`coder ssh` auto-starts one), and must actually finish when the
 * leftover is a plain directory git no longer lists as a worktree — otherwise
 * it is retried after every restart, starting the workspace each time.
 *
 * Runs against a real temporary database and git repo (the "local-ws" workspace
 * is this machine). Remote workspaces go through a fake `coder` on PATH that only
 * records its calls, and their status comes from a mocked Coder API.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cpm-worktree-reconcile-'));
const base = join(dir, 'worktrees');
const repo = join(dir, 'repo');
const coderLog = join(dir, 'coder-calls.log');
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.CODER_WORKSPACE_NAME = 'local-ws';
process.env.CPM_WORKTREE_BASE = base;
process.env.CPM_CHECKPOINTS_BASE = join(dir, 'checkpoints');
process.env.CODER_URL = 'http://coder.test';
process.env.CODER_SESSION_TOKEN = 'test-token';

// A fake `coder` that records every call and succeeds, so a test can tell
// whether anything SSHed into a workspace (which would have started it).
const bin = join(dir, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'coder'), `#!/bin/sh\necho "$*" >> '${coderLog}'\nexit 0\n`);
chmodSync(join(bin, 'coder'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

// Workspace status as the Coder API reports it; a missing entry is an API error.
const workspaceStatus = new Map<string, string>();
globalThis.fetch = (async (url: string | URL) => {
  const name = decodeURIComponent(String(url).split('/').pop() || '');
  const status = workspaceStatus.get(name);
  if (!status) return new Response('boom', { status: 500 });
  return new Response(JSON.stringify({ latest_build: { status } }), { status: 200 });
}) as typeof fetch;

let T: typeof import('./tasks.js');
let G: typeof import('./git.js');
let getDb: typeof import('../db/index.js').getDb;
let loadError: Error | null = null;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString();

before(async () => {
  try {
    ({ getDb } = await import('../db/index.js'));
    T = await import('./tasks.js');
    G = await import('./git.js');
    getDb().prepare("INSERT INTO users (id, username) VALUES ('u', 'tester')").run();
  } catch (err) {
    loadError = err as Error; // e.g. better-sqlite3's native module isn't built in this checkout
    return;
  }
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
});
after(() => rmSync(dir, { recursive: true, force: true }));

const skipIfNoDb = (name: string, fn: () => void | Promise<void>) =>
  test(name, async t => { if (loadError) return t.skip(`database unavailable: ${loadError.message.slice(0, 80)}`); await fn(); });

/** A task on `workspaceName` that owns a worktree path; deleted unless told otherwise. */
function taskWithWorktree(workspaceName: string, opts: { path?: string; deleted?: boolean } = {}) {
  const task = T.createTask({ workspaceId: `id-${workspaceName}`, workspaceName, userId: 'u', username: 'tester', prompt: 'p' });
  const path = opts.path ?? join(base, `task-${task.id}`);
  getDb().prepare('UPDATE tasks SET worktree_path = ?, project_dir = ?, deleted_at = ? WHERE id = ?')
    .run(path, repo, opts.deleted === false ? null : new Date().toISOString(), task.id);
  return T.getTask(task.id)!;
}
const coderCalls = () => (existsSync(coderLog) ? readFileSync(coderLog, 'utf8').trim().split('\n') : []);
const warnings = (id: string) => T.getMessages(id).filter(m => /could not remove git worktree/.test(m.content));

skipIfNoDb('cleans up a leftover task directory that git no longer lists as a worktree', async () => {
  const task = taskWithWorktree('local-ws');
  mkdirSync(join(task.worktree_path!, 'frontend'), { recursive: true }); // untracked build output, no .git
  writeFileSync(join(task.worktree_path!, 'frontend', 'bundle.js'), 'x');

  await G.reconcileLeakedWorktrees();

  assert.equal(existsSync(task.worktree_path!), false, 'the leftover directory is gone');
  assert.equal(T.getTask(task.id)!.worktree_path, null, 'so it is not retried after the next restart');
  assert.deepEqual(warnings(task.id), []);
});

skipIfNoDb('still removes a real worktree through git, together with its branch', async () => {
  const task = taskWithWorktree('local-ws', { deleted: false });
  git('worktree', 'add', '-q', '-b', 'task/real', task.worktree_path!);
  getDb().prepare("UPDATE tasks SET git_branch = 'task/real' WHERE id = ?").run(task.id);

  assert.equal(await G.removeTaskWorktree(T.getTask(task.id)!), true);

  assert.equal(existsSync(task.worktree_path!), false);
  assert.doesNotMatch(git('worktree', 'list'), /task-/);
  assert.equal(git('branch', '--list', 'task/real').trim(), '');
});

skipIfNoDb('never deletes a directory that is not the task\'s own worktree path', async () => {
  const elsewhere = join(dir, 'not-a-worktree');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'precious.txt'), 'keep me');
  const task = taskWithWorktree('local-ws', { path: elsewhere, deleted: false });

  assert.equal(await G.removeTaskWorktree(task), false);

  assert.equal(readFileSync(join(elsewhere, 'precious.txt'), 'utf8'), 'keep me');
  assert.equal(T.getTask(task.id)!.worktree_path, elsewhere, 'left in place for a person to look at');
});

skipIfNoDb('does not SSH into (and so does not start) a stopped workspace to clean up after deleted tasks', async () => {
  workspaceStatus.set('Forge', 'stopped');
  const task = taskWithWorktree('Forge');
  rmSync(coderLog, { force: true });

  await G.reconcileLeakedWorktrees();

  assert.deepEqual(coderCalls().filter(c => c.includes('Forge')), [], 'no coder ssh to the stopped workspace');
  assert.equal(T.getTask(task.id)!.worktree_path, task.worktree_path, 'kept for a later sweep');
  assert.deepEqual(warnings(task.id), [], 'skipping is not reported as a failed removal');
});

skipIfNoDb('does not SSH into a workspace whose status cannot be checked', async () => {
  const task = taskWithWorktree('Unknowable'); // the mocked API errors for this one
  rmSync(coderLog, { force: true });

  await G.reconcileLeakedWorktrees();

  assert.deepEqual(coderCalls().filter(c => c.includes('Unknowable')), []);
  assert.equal(T.getTask(task.id)!.worktree_path, task.worktree_path);
});

skipIfNoDb('still cleans up after deleted tasks on a workspace that is already running', async () => {
  workspaceStatus.set('Foundry', 'running');
  const task = taskWithWorktree('Foundry');
  rmSync(coderLog, { force: true });

  await G.reconcileLeakedWorktrees();

  assert.ok(coderCalls().some(c => c.startsWith('ssh Foundry') && c.includes('git worktree remove')), 'removal ran over SSH');
  assert.equal(T.getTask(task.id)!.worktree_path, null);
});
