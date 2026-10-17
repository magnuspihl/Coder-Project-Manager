/**
 * CPM-managed task previews: CPM (not the agent) restarts a task's preview when
 * an implementer turn ends, fully detached, and never lets that hold up the turn.
 *
 * Runs against a real temporary database. Every remote call previews make goes
 * through a mocked exec (setPreviewExecForTests), and a fake `coder` that always
 * fails sits first on PATH so nothing else can reach a real workspace either.
 * One test runs the generated start/stop scripts for real with a `sleep` (no
 * server, no ports) to prove the start detaches and the stop kills the group.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'cpm-preview-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.CODER_WORKSPACE_NAME = 'local-ws';
process.env.VSCODE_PROXY_URI = 'https://{{port}}--main--local-ws--magnus.coder.test';
process.env.CPM_PORT_RANGE_START = '47000';
process.env.CPM_PREVIEW_HEALTHCHECK_MS = '0';
process.env.CPM_WORKTREE_BASE = join(dir, 'worktrees');
process.env.CPM_CHECKPOINTS_BASE = join(dir, 'checkpoints');
const bin = join(dir, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'coder'), '#!/bin/sh\nexit 1\n');
chmodSync(join(bin, 'coder'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

let T: typeof import('./tasks.js');
let C: typeof import('./claude.js');
let P: typeof import('./preview.js');
let J: typeof import('./port-janitor.js');
let getDb: typeof import('../db/index.js').getDb;
let loadError: Error | null = null;

before(async () => {
  try {
    ({ getDb } = await import('../db/index.js'));
    T = await import('./tasks.js');
    C = await import('./claude.js');
    P = await import('./preview.js');
    J = await import('./port-janitor.js');
    getDb().prepare("INSERT INTO users (id, username) VALUES ('u', 'tester')").run();
  } catch (err) {
    loadError = err as Error; // e.g. better-sqlite3's native module isn't built in this checkout
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

const dbTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, async t => { if (loadError) return t.skip(`database unavailable: ${loadError.message.slice(0, 80)}`); await fn(); });

/** The script inside a `printf %s '<b64>' | base64 -d | sh` command, decoded; other commands as-is. */
function decode(cmd: string): string {
  return cmd.split('; ').map(part => {
    const m = /^printf %s '([A-Za-z0-9+/=]+)' \| base64 -d \| sh$/.exec(part.trim());
    return m ? Buffer.from(m[1], 'base64').toString('utf8') : part;
  }).join('\n');
}

interface Call { workspace: string; command: string }

/** A mock remote exec that records calls and answers like a workspace would. */
function mockExec(opts: { packageJson?: string | null; start?: string; hang?: boolean; fail?: string } = {}) {
  const calls: Call[] = [];
  const restore = C.setPreviewExecForTests(async (workspace, command) => {
    const script = decode(command);
    calls.push({ workspace, command: script });
    if (opts.hang) return new Promise<string>(() => {});
    if (opts.fail) throw new Error(opts.fail);
    if (script.startsWith('cat ')) return opts.packageJson ?? '';
    if (script.includes('CPM_PREVIEW_CMD')) return opts.start ?? 'cpm-preview-started 4242';
    return '';
  });
  return { calls, restore };
}

let wsCounter = 0;
function makeTask(fields: { status?: string; worktree?: string | null; projectDir?: string | null; port?: number | null; workspaceId?: string } = {}) {
  const workspaceId = fields.workspaceId ?? `w${++wsCounter}`;
  const task = T.createTask({ workspaceId, workspaceName: 'remote-ws', userId: 'u', username: 'tester', prompt: 'p' });
  T.updateTaskStatus(task.id, fields.status ?? 'awaiting_feedback');
  getDb().prepare('UPDATE tasks SET worktree_path = ?, project_dir = ?, port_range_start = ? WHERE id = ?')
    .run(fields.worktree === undefined ? '/wt/task' : fields.worktree,
      fields.projectDir === undefined ? '/home/coder/repo' : fields.projectDir,
      fields.port === undefined ? 47010 : fields.port, task.id);
  return T.getTask(task.id)!;
}

async function settled(taskId: string): Promise<import('./tasks.js').Task> {
  for (let i = 0; i < 200; i++) {
    const t = T.getTask(taskId)!;
    if (t.preview_status && t.preview_status !== 'starting') return t;
    await new Promise(r => setTimeout(r, 5));
  }
  return T.getTask(taskId)!;
}

const tick = () => new Promise(r => setImmediate(r));

// ---------------------------------------------------------------------------
// Auto-detection and working directory
// ---------------------------------------------------------------------------

test('auto-detects `npm run dev` when package.json has a dev script', () => {
  assert.equal(P.detectPreviewCommand(JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } })), 'npm run dev');
});

test('detects no preview when package.json has no dev script, is missing, or is not valid JSON', () => {
  assert.equal(P.detectPreviewCommand(JSON.stringify({ scripts: { start: 'node .', build: 'tsc' } })), null);
  assert.equal(P.detectPreviewCommand(JSON.stringify({ name: 'x' })), null);
  assert.equal(P.detectPreviewCommand(''), null);
  assert.equal(P.detectPreviewCommand(null), null);
  assert.equal(P.detectPreviewCommand('{ not json'), null);
});

test('runs the preview in the worktree, or in project_dir when the task has no worktree', () => {
  assert.equal(P.previewWorkDir({ worktree_path: '/wt/a', project_dir: '/repo' }), '/wt/a');
  assert.equal(P.previewWorkDir({ worktree_path: null, project_dir: '/repo' }), '/repo');
  assert.equal(P.previewWorkDir({ worktree_path: null, project_dir: null }), null);
});

dbTest('reads package.json from, and starts the preview in, the task worktree', async () => {
  const task = makeTask({ worktree: '/wt/one', projectDir: '/home/coder/repo' });
  const { calls, restore } = mockExec({ packageJson: '{"scripts":{"dev":"vite"}}' });
  try {
    C.firePreviewRestart(task.id);
    const t = await settled(task.id);
    assert.equal(t.preview_status, 'running');
    assert.equal(t.preview_command, 'npm run dev');
    assert.match(calls[0].command, /^cat '\/wt\/one\/package\.json'/);
    const start = calls.find(c => c.command.includes('CPM_PREVIEW_CMD'))!.command;
    assert.match(start, /cd '\/wt\/one'/);
    assert.match(start, /PORT=47010 CPM_PORT_RANGE="47010-47019"/);
    assert.match(start, /setsid/);
    assert.match(start, /AUTO_INSTALL=1/, 'an auto-detected npm run dev installs missing dependencies');
    assert.match(start, /nohup sh -c .* > '\/tmp\/cpm-preview-[0-9a-f-]+\.log' 2>&1 < \/dev\/null &/);
    assert.equal(calls.every(c => c.workspace === 'remote-ws'), true, 'everything runs on the task workspace');
  } finally { restore(); }
});

dbTest('falls back to project_dir for a task without a worktree (e.g. a repo that was empty at launch)', async () => {
  const task = makeTask({ worktree: null, projectDir: '/home/coder/fresh' });
  const { calls, restore } = mockExec({ packageJson: '{"scripts":{"dev":"next dev"}}' });
  try {
    C.firePreviewRestart(task.id);
    assert.equal((await settled(task.id)).preview_status, 'running');
    assert.match(calls[0].command, /^cat '\/home\/coder\/fresh\/package\.json'/);
    assert.match(calls.find(c => c.command.includes('CPM_PREVIEW_CMD'))!.command, /cd '\/home\/coder\/fresh'/);
  } finally { restore(); }
});

dbTest('the workspace preview command wins over auto-detection, and empty means auto-detect', async () => {
  const task = makeTask();
  P.setPreviewCommandSetting(task.workspace_id, 'npx vite --port $PORT --host');
  const { calls, restore } = mockExec({ packageJson: '{"scripts":{"dev":"vite"}}' });
  try {
    C.firePreviewRestart(task.id);
    const t = await settled(task.id);
    assert.equal(t.preview_command, 'npx vite --port $PORT --host');
    assert.equal(calls.some(c => c.command.startsWith('cat ')), false, 'no detection when a command is set');
    const start = calls.find(c => c.command.includes('CPM_PREVIEW_CMD'))!.command;
    assert.match(start, /CPM_PREVIEW_CMD='npx vite --port \$PORT --host'/);
    assert.match(start, /AUTO_INSTALL=0/, 'an explicit command never gets an automatic install');
  } finally { restore(); }
  assert.deepEqual(P.parsePreviewCommand('   '), { ok: true, value: null });
  assert.deepEqual(P.parsePreviewCommand('npm run dev\nrm -rf ~'), { ok: false, error: 'command must be a single line' });
});

dbTest('a project with no dev script and no setting gets no preview, and settings remember what detection found', async () => {
  const task = makeTask();
  const { calls, restore } = mockExec({ packageJson: '{"scripts":{"build":"tsc"}}' });
  try {
    C.firePreviewRestart(task.id);
    const t = await settled(task.id);
    assert.equal(t.preview_status, 'none');
    assert.equal(calls.some(c => c.command.includes('CPM_PREVIEW_CMD')), false, 'nothing is started');
    assert.deepEqual(P.getPreviewCommandSetting(task.workspace_id), { command: null, detected: null });
  } finally { restore(); }
  const other = makeTask();
  const m2 = mockExec({ packageJson: '{"scripts":{"dev":"vite"}}' });
  try {
    C.firePreviewRestart(other.id);
    await settled(other.id);
    assert.equal(P.getPreviewCommandSetting(other.workspace_id).detected, 'npm run dev');
  } finally { m2.restore(); }
});

// ---------------------------------------------------------------------------
// Never blocking the turn
// ---------------------------------------------------------------------------

dbTest('a hung workspace does not hold up the end of a turn: the task still moves to awaiting feedback', async () => {
  const task = makeTask({ status: 'working', worktree: null, projectDir: '/home/coder/repo' });
  T.addMessage(task.id, 'assistant', 'done');
  const { calls, restore } = mockExec({ hang: true }); // every remote call never returns
  try {
    C.finalizeTask(T.getTask(task.id)!, null);
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(T.getTask(task.id)!.status, 'awaiting_feedback');
    assert.ok(calls.length > 0, 'the preview restart was started');
  } finally { restore(); }
});

dbTest('the preview restart call returns before any remote work has finished', async () => {
  const task = makeTask();
  const { restore } = mockExec({ hang: true });
  try {
    const result = C.firePreviewRestart(task.id) as unknown;
    assert.equal(result, undefined, 'fire-and-forget: nothing to await');
  } finally { restore(); }
});

dbTest('a preview that fails to start is recorded on the task without failing it', async () => {
  const task = makeTask();
  const { restore } = mockExec({ fail: 'exited with status 255: connection refused' });
  try {
    C.firePreviewRestart(task.id);
    const t = await settled(task.id);
    assert.equal(t.preview_status, 'failed');
    assert.match(t.preview_error ?? '', /connection refused/);
    assert.equal(t.status, 'awaiting_feedback');
  } finally { restore(); }
});

dbTest('a start that reports an error (e.g. a missing directory) shows as failed with the reason', async () => {
  const task = makeTask();
  P.setPreviewCommandSetting(task.workspace_id, 'npm run dev');
  const { restore } = mockExec({ start: 'cpm-preview-error: cannot cd to /wt/task' });
  try {
    C.firePreviewRestart(task.id);
    const t = await settled(task.id);
    assert.equal(t.preview_status, 'failed');
    assert.equal(t.preview_error, 'cannot cd to /wt/task');
  } finally { restore(); }
});

dbTest('a preview that crashes right after starting shows as failed, with the end of its log', async () => {
  const task = makeTask();
  P.setPreviewCommandSetting(task.workspace_id, 'npm run dev');
  const exec = async (command: string) => {
    const script = decode(command);
    if (script.includes('CPM_PREVIEW_CMD')) return 'cpm-preview-started 4242';
    if (script.includes('kill -0 "$pid"')) return "dead running\nError: Cannot find module 'vite'";
    return '';
  };
  const outcome = await P.restartTaskPreview(task.id, { exec, rangeSize: 10, healthCheckMs: 5 });
  assert.equal(outcome.status, 'running');
  for (let i = 0; i < 100 && T.getTask(task.id)!.preview_status === 'running'; i++) await new Promise(r => setTimeout(r, 5));
  const t = T.getTask(task.id)!;
  assert.equal(t.preview_status, 'failed');
  assert.match(t.preview_error ?? '', /exited shortly after starting[\s\S]*Cannot find module 'vite'/);
});

// ---------------------------------------------------------------------------
// verification_url
// ---------------------------------------------------------------------------

dbTest('sets the preview link from the task port, on the task workspace host', async () => {
  const task = makeTask({ port: 47030 });
  const { restore } = mockExec({ packageJson: '{"scripts":{"dev":"vite"}}' });
  try {
    C.firePreviewRestart(task.id);
    const t = await settled(task.id);
    assert.equal(t.verification_url, 'https://47030--main--remote-ws--magnus.coder.test');
  } finally { restore(); }
  // A URL the agent writes later does not replace the one CPM knows is right.
  T.addMessage(task.id, 'assistant', 'See https://5173--main--remote-ws--magnus.coder.test/page');
  assert.equal(T.getTask(task.id)!.verification_url, 'https://47030--main--remote-ws--magnus.coder.test');
});

dbTest('still picks the link up from the agent message when CPM manages no preview for the task', () => {
  const task = makeTask();
  T.addMessage(task.id, 'assistant', 'Open https://5173--main--remote-ws--magnus.coder.test/page to check');
  assert.equal(T.getTask(task.id)!.verification_url, 'https://5173--main--remote-ws--magnus.coder.test/page');
});

// ---------------------------------------------------------------------------
// Restart endpoint
// ---------------------------------------------------------------------------

dbTest('Restart preview marks the preview starting and restarts it in the background', async () => {
  const task = makeTask();
  const { calls, restore } = mockExec({ packageJson: '{"scripts":{"dev":"vite"}}' });
  try {
    const res = C.requestPreviewRestart(task.id);
    assert.deepEqual(res, { ok: true });
    assert.equal(T.getTask(task.id)!.preview_status, 'starting');
    assert.equal((await settled(task.id)).preview_status, 'running');
    const killIdx = calls.findIndex(c => c.command.includes('killed-preview'));
    const startIdx = calls.findIndex(c => c.command.includes('CPM_PREVIEW_CMD'));
    assert.ok(killIdx >= 0 && killIdx < startIdx, 'the old preview is killed before the new one starts');
  } finally { restore(); }
});

dbTest('Restart preview is refused for finished tasks, tasks without ports, and unknown tasks', () => {
  const { calls, restore } = mockExec();
  try {
    for (const status of ['completed', 'failed', 'cancelled']) {
      const res = C.requestPreviewRestart(makeTask({ status }).id);
      assert.equal(res.ok, false, status);
    }
    const noPorts = C.requestPreviewRestart(makeTask({ port: null }).id);
    assert.equal(noPorts.ok, false);
    assert.deepEqual(C.requestPreviewRestart(randomUUID()), { ok: false, error: 'Task not found' });
    assert.equal(calls.length, 0, 'nothing touched a workspace');
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// Stop at terminal states
// ---------------------------------------------------------------------------

dbTest('a turn that ends in failure kills the preview, frees the ports, and does not restart it', async () => {
  const task = makeTask({ status: 'working', worktree: null, projectDir: '/home/coder/repo' });
  getDb().prepare("UPDATE tasks SET preview_status = 'running', verification_url = 'https://47010--main--remote-ws--magnus.coder.test' WHERE id = ?").run(task.id);
  const { calls, restore } = mockExec();
  try {
    C.finalizeTask(T.getTask(task.id)!, 'boom');
    for (let i = 0; i < 20; i++) await tick();
    const t = T.getTask(task.id)!;
    assert.equal(t.status, 'failed');
    assert.equal(t.port_range_start, null);
    assert.equal(t.preview_status, 'stopped');
    assert.equal(t.verification_url, null, 'no link to ports another task may get next');
    const kill = calls.find(c => c.command.includes('killed-preview'));
    assert.ok(kill, 'the preview process group is killed');
    assert.match(kill!.command, new RegExp(`cpm-preview-${task.id}\\.pid`));
    assert.equal(calls.some(c => c.command.includes('CPM_PREVIEW_CMD')), false, 'never restarted');
  } finally { restore(); }
});

dbTest('completing a task kills its preview through cleanupPortRange', async () => {
  const task = makeTask();
  getDb().prepare("UPDATE tasks SET preview_status = 'running' WHERE id = ?").run(task.id);
  T.updateTaskStatus(task.id, 'completed');
  const { calls, restore } = mockExec();
  try {
    await C.cleanupPortRange(T.getTask(task.id)!);
    assert.ok(calls.some(c => c.command.includes(`cpm-preview-${task.id}.pid`) && c.command.includes('kill -TERM "-$pid"')));
    assert.equal(T.getTask(task.id)!.preview_status, 'stopped');
  } finally { restore(); }
});

test('the port janitor treats a live task worktree preview as owned and never as an orphan', () => {
  if (loadError) return;
  const base = process.env.CPM_WORKTREE_BASE!;
  const id = '11111111-2222-3333-4444-555555555555';
  const rows = new Map([[id, { id, status: 'awaiting_feedback', deleted: false }]]);
  assert.equal(J.classifyListener(`${base}/task-${id}`, rows).kind, 'owned');
  assert.equal(J.classifyListener(`${base}/task-${id}/client`, rows).kind, 'owned');
  rows.set(id, { id, status: 'working', deleted: false });
  assert.equal(J.classifyListener(`${base}/task-${id}`, rows).kind, 'owned');
  rows.set(id, { id, status: 'completed', deleted: false });
  assert.equal(J.classifyListener(`${base}/task-${id}`, rows).kind, 'orphan');
  assert.equal(J.classifyListener('/home/coder/repo', rows).kind, 'ignore', 'a project_dir preview is never a reaping candidate');
});

// ---------------------------------------------------------------------------
// The real scripts
// ---------------------------------------------------------------------------

test('the start script returns immediately with the process detached, and the stop script kills its whole group', { timeout: 20000 }, () => {
  const taskId = randomUUID();
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  const marker = join(dir, `child-${taskId}`);
  // A command with a child of its own, to prove the whole group goes.
  const command = `sh -c 'echo $$ > ${marker}; sleep 30' & echo "port=$PORT range=$CPM_PORT_RANGE"; sleep 30`;
  const startedAt = Date.now();
  const out = execFileSync('sh', ['-c', P.buildPreviewStartCommand({ taskId, workDir: work, command, portStart: 47090, portEnd: 47099, autoInstall: false })]).toString();
  assert.ok(Date.now() - startedAt < 5000, 'did not wait for the command');
  const m = /cpm-preview-started (\d+)/.exec(out);
  assert.ok(m, out);
  const pid = parseInt(m![1], 10);
  const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
  try {
    assert.equal(alive(pid), true);
    for (let i = 0; i < 50 && !existsSync(marker); i++) execFileSync('sleep', ['0.1']);
    const child = parseInt(readFileSync(marker, 'utf8'), 10);
    assert.equal(alive(child), true);
    for (let i = 0; i < 50 && !readFileSync(P.previewLogPath(taskId), 'utf8').includes('port='); i++) execFileSync('sleep', ['0.1']);
    assert.match(readFileSync(P.previewLogPath(taskId), 'utf8'), /port=47090 range=47090-47099/);

    const stopOut = execFileSync('sh', ['-c', P.buildPreviewStopCommand(taskId)]).toString();
    assert.match(stopOut, new RegExp(`killed-preview pgid=${pid}`));
    for (let i = 0; i < 30 && (alive(pid) || alive(child)); i++) execFileSync('sleep', ['0.1']);
    assert.equal(alive(pid), false, 'the preview shell is gone');
    assert.equal(alive(child), false, 'and so is its child');
    assert.equal(existsSync(P.previewPidPath(taskId)), false);
  } finally {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(P.previewLogPath(taskId), { force: true });
    rmSync(P.previewPidPath(taskId), { force: true });
  }
});

// ---------------------------------------------------------------------------
// Installing missing dependencies (real scripts, fake package managers)
// ---------------------------------------------------------------------------

/**
 * Run the real start script in a fresh project dir whose package managers are
 * fakes that log their arguments: `ci`/`install` create node_modules, `run`
 * stays up like a dev server. Returns the start output and the logged calls
 * once the preview command itself has been reached.
 */
function startWithFakeManagers(opts: { files: string[]; nodeModules: boolean; autoInstall: boolean }) {
  const taskId = randomUUID();
  const work = mkdtempSync(join(dir, 'proj-'));
  const fakeBin = mkdtempSync(join(dir, 'fakebin-'));
  const calls = join(work, 'calls.log');
  for (const tool of ['npm', 'pnpm']) {
    writeFileSync(join(fakeBin, tool), `#!/bin/sh\necho "${tool} $*" >> '${calls}'\ncase "$1" in run) exec sleep 30;; *) mkdir -p node_modules;; esac\n`);
    chmodSync(join(fakeBin, tool), 0o755);
  }
  writeFileSync(join(work, 'package.json'), '{"scripts":{"dev":"vite"}}');
  for (const f of opts.files) writeFileSync(join(work, f), '');
  if (opts.nodeModules) mkdirSync(join(work, 'node_modules'));
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HOME: work };
  const out = execFileSync('sh', ['-c', P.buildPreviewStartCommand({
    taskId, workDir: work, command: 'npm run dev', portStart: 47090, portEnd: 47099, autoInstall: opts.autoInstall,
  })], { env }).toString();
  const read = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  for (let i = 0; i < 50 && !read().some(l => l.endsWith('run dev')); i++) execFileSync('sleep', ['0.1']);
  const lines = read();
  execFileSync('sh', ['-c', P.buildPreviewStopCommand(taskId)]);
  rmSync(P.previewLogPath(taskId), { force: true });
  return { out, calls: lines, nodeModules: existsSync(join(work, 'node_modules')) };
}

test('installs with npm ci before npm run dev when node_modules is missing and package-lock.json exists', { timeout: 20000 }, () => {
  const r = startWithFakeManagers({ files: ['package-lock.json'], nodeModules: false, autoInstall: true });
  assert.match(r.out, /cpm-preview-started \d+ installing/);
  assert.deepEqual(r.calls, ['npm ci', 'npm run dev']);
  assert.equal(r.nodeModules, true);
});

test('installs with npm install when there is no lockfile', { timeout: 20000 }, () => {
  const r = startWithFakeManagers({ files: [], nodeModules: false, autoInstall: true });
  assert.deepEqual(r.calls, ['npm install', 'npm run dev']);
});

test('installs with pnpm when the project has a pnpm lockfile', { timeout: 20000 }, () => {
  const r = startWithFakeManagers({ files: ['pnpm-lock.yaml'], nodeModules: false, autoInstall: true });
  assert.deepEqual(r.calls, ['pnpm install --frozen-lockfile', 'npm run dev']);
});

test('skips the install when node_modules already exists', { timeout: 20000 }, () => {
  const r = startWithFakeManagers({ files: ['package-lock.json'], nodeModules: true, autoInstall: true });
  assert.doesNotMatch(r.out, /installing/);
  assert.deepEqual(r.calls, ['npm run dev']);
});

test('never installs for an explicit workspace preview command, even without node_modules', { timeout: 20000 }, () => {
  const r = startWithFakeManagers({ files: ['package-lock.json'], nodeModules: false, autoInstall: false });
  assert.doesNotMatch(r.out, /installing/);
  assert.deepEqual(r.calls, ['npm run dev']);
  assert.equal(r.nodeModules, false);
});

/** Restart with a mocked workspace whose health checks answer from `phases` in turn. */
async function restartWithHealth(phases: string[]) {
  const task = makeTask();
  const answers = [...phases];
  const exec = async (command: string) => {
    const script = decode(command);
    if (script.startsWith('cat ')) return '{"scripts":{"dev":"vite"}}';
    if (script.includes('CPM_PREVIEW_CMD')) return 'cpm-preview-started 4242 installing';
    if (script.includes('kill -0 "$pid"')) return answers.length > 1 ? answers.shift()! : answers[0];
    return '';
  };
  const outcome = await P.restartTaskPreview(task.id, { exec, rangeSize: 10, healthCheckMs: 5 });
  return { task, outcome };
}

dbTest('a long install is shown as installing and not failed, then running once the server is up', async () => {
  const { task, outcome } = await restartWithHealth(['alive installing', 'alive installing', 'alive installing', 'alive running']);
  assert.equal(outcome.status, 'installing');
  assert.equal(T.getTask(task.id)!.preview_status, 'installing');
  for (let i = 0; i < 200 && T.getTask(task.id)!.preview_status === 'installing'; i++) await new Promise(r => setTimeout(r, 5));
  await new Promise(r => setTimeout(r, 50)); // the post-install check runs too
  assert.equal(T.getTask(task.id)!.preview_status, 'running');
});

dbTest('a failed install shows as failed with the install log', async () => {
  const { task } = await restartWithHealth(['alive installing', 'dead installing\nnpm ERR! 404 Not Found']);
  for (let i = 0; i < 200 && T.getTask(task.id)!.preview_status !== 'failed'; i++) await new Promise(r => setTimeout(r, 5));
  const t = T.getTask(task.id)!;
  assert.equal(t.preview_status, 'failed');
  assert.match(t.preview_error ?? '', /Installing the dependencies failed\.[\s\S]*npm ERR! 404/);
});

dbTest('a server that crashes right after its install finished is still caught', async () => {
  const { task } = await restartWithHealth(['alive installing', 'alive running', 'dead running\nError: Cannot find module']);
  for (let i = 0; i < 200 && T.getTask(task.id)!.preview_status !== 'failed'; i++) await new Promise(r => setTimeout(r, 5));
  assert.match(T.getTask(task.id)!.preview_error ?? '', /exited shortly after starting[\s\S]*Cannot find module/);
});

// ---------------------------------------------------------------------------
// Agent guidance
// ---------------------------------------------------------------------------

test('the agent is told CPM starts the preview and never to start servers itself, and still gets the URL', () => {
  if (loadError) return;
  const g = C.buildCoderUrlGuidance('remote-ws', 'https://{{port}}--main--remote-ws--magnus.coder.test', 47010, 47019);
  assert.match(g, /CPM \(re\)starts this task's preview server automatically on \$PORT \(47010\)/);
  assert.match(g, /NEVER start servers or other long-running processes yourself/);
  assert.match(g, /typecheck, build, tests/);
  assert.match(g, /https:\/\/47010--main--remote-ws--magnus\.coder\.test/);
  assert.doesNotMatch(g, /Bind any dev\/preview server you start/);
  // Even with no way to build a URL, the rule is still given.
  assert.match(C.buildCoderUrlGuidance('remote-ws', '', null, null), /NEVER start servers/);
});
