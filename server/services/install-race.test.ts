/**
 * The turn-end race between the preview's dependency install and the harness's
 * test runs. Both start when a turn ends; the preview's `npm ci` deletes and
 * re-extracts node_modules, so a test run that overlaps it finds no tsx.
 *
 * The real scripts are run with `sh` in temporary projects, with a fake npm
 * first on PATH whose `npm ci` wipes node_modules, takes a while, and restores it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDependencySettleCommand, parseDependencySettleOutput } from './test-env.js';
import { INSTALL_MARKER } from './install-script.js';

// preview.ts resolves the database path when it is imported: never the real one.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'cpm-race-db-')), 'test.db');
const P = await import('./preview.js');

const hasFlock = (() => { try { execFileSync('sh', ['-c', 'command -v flock']); return true; } catch { return false; } })();

const LOCK = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', devDependencies: { tsx: '^4' } },
    'node_modules/tsx': { version: '4.19.2', dev: true },
    'node_modules/@esbuild/darwin-arm64': { version: '0.23.1', dev: true, optional: true },
  },
};

function makeProject(opts: { installSeconds?: number } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'cpm-race-'));
  const fakeBin = join(work, '.bin');
  mkdirSync(fakeBin);
  const calls = join(work, 'calls.log');
  writeFileSync(join(fakeBin, 'npm'), `#!/bin/sh
echo "npm $*" >> '${calls}'
case "$1" in
  ci|install)
    rm -rf node_modules
    sleep ${opts.installSeconds ?? 0}
    mkdir -p node_modules/tsx && echo '{}' > node_modules/tsx/package.json
    echo "npm $* done" >> '${calls}' ;;
  run) exec sleep 30 ;;
esac
exit 0
`);
  chmodSync(join(fakeBin, 'npm'), 0o755);
  writeFileSync(join(work, 'package.json'), '{"scripts":{"dev":"vite"},"devDependencies":{"tsx":"^4"}}');
  writeFileSync(join(work, 'package-lock.json'), JSON.stringify(LOCK));
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HOME: work };
  const read = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { work, env, read };
}
type Project = ReturnType<typeof makeProject>;

/** What npm records after installing LOCK on Linux: the darwin-only optional package was skipped. */
const RECORDED = { ...LOCK, packages: { 'node_modules/tsx': LOCK.packages['node_modules/tsx'] } };

/** A node_modules the way a plain `npm ci` leaves it: packages and npm's own record, but no CPM marker. */
function agentInstalled(project: Project, recorded: object = RECORDED) {
  mkdirSync(join(project.work, 'node_modules/tsx'), { recursive: true });
  writeFileSync(join(project.work, 'node_modules/tsx/package.json'), '{}');
  writeFileSync(join(project.work, 'node_modules/.package-lock.json'), JSON.stringify(recorded));
}

/** A node_modules with the runner in it but nothing saying it matches the lockfile. */
function unknownInstall(project: Project) {
  mkdirSync(join(project.work, 'node_modules/tsx'), { recursive: true });
  writeFileSync(join(project.work, 'node_modules/tsx/package.json'), '{}');
}

const tsxPresent = (project: Project) => existsSync(join(project.work, 'node_modules/tsx/package.json'));

function startPreview(project: Project) {
  const taskId = randomUUID();
  const out = execFileSync('sh', ['-c', P.buildPreviewStartCommand({
    taskId, workDir: project.work, command: 'npm run dev', portStart: 47190, portEnd: 47199, autoInstall: true,
  })], { env: project.env }).toString();
  const stop = () => {
    execFileSync('sh', ['-c', P.buildPreviewStopCommand(taskId)]);
    rmSync(P.previewLogPath(taskId), { force: true });
  };
  return { out, stop, log: () => (existsSync(P.previewLogPath(taskId)) ? readFileSync(P.previewLogPath(taskId), 'utf8') : '') };
}

function settle(project: Project, install = true) {
  const cmd = buildDependencySettleCommand(project.work, { install, logPath: join(project.work, 'install.log'), timeoutSec: 30 });
  return parseDependencySettleOutput(execFileSync('sh', ['-c', cmd], { env: project.env }).toString());
}

async function waitFor(cond: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 50));
  }
}

test('a verification starting while the preview is installing waits for that install before running any test', { timeout: 30000, skip: !hasFlock && 'flock is not available' }, async () => {
  const project = makeProject({ installSeconds: 2 });
  unknownInstall(project);
  const preview = startPreview(project);
  try {
    assert.match(preview.out, /installing/, 'the preview decided to install (no marker)');
    await waitFor(() => project.read().includes('npm ci'));
    // This is the overlap from task c426e065: mid-install, the runner is gone.
    assert.equal(tsxPresent(project), false, 'while the preview\'s npm ci runs, node_modules has no tsx — a test run now would fail');

    const started = Date.now();
    const result = settle(project);
    const waited = Date.now() - started;

    assert.ok(tsxPresent(project), 'when the settle step returns, the install has finished and tsx is back');
    assert.ok(project.read().includes('npm ci done'), 'the preview\'s install had completed');
    assert.ok(waited >= 1000, `the settle step waited for the install (${waited} ms)`);
    assert.equal(result.status, 'current', 'it found the preview\'s marker and had nothing to do');
    assert.equal(project.read().filter(l => l === 'npm ci').length, 1, 'no second install was run');
  } finally {
    preview.stop();
  }
});

test('when the verification gets there first it installs, and the preview then finds nothing to install', { timeout: 30000, skip: !hasFlock && 'flock is not available' }, async () => {
  const project = makeProject();
  unknownInstall(project);
  const result = settle(project);
  assert.equal(result.status, 'installed');
  assert.equal(result.installCommand, 'npm ci');
  assert.ok(existsSync(join(project.work, INSTALL_MARKER)), 'the preview\'s marker is written');

  const preview = startPreview(project);
  try {
    assert.doesNotMatch(preview.out, /installing/);
    await waitFor(() => project.read().includes('npm run dev'));
    assert.deepEqual(project.read().filter(l => !l.endsWith('done')), ['npm ci', 'npm run dev'], 'the preview went straight to its dev server — nothing can wipe node_modules under the tests');
  } finally {
    preview.stop();
  }
});

test('a preview that started installing just after the verification\'s install skips its own install', { timeout: 30000, skip: !hasFlock && 'flock is not available' }, async () => {
  const project = makeProject({ installSeconds: 1 });
  unknownInstall(project);
  // The verification's install is running (holding the lock) when the preview starts.
  const cmd = buildDependencySettleCommand(project.work, { install: true, logPath: join(project.work, 'install.log'), timeoutSec: 30 });
  const running = spawn('sh', ['-c', cmd], { env: project.env });
  const done = new Promise<void>(r => running.on('exit', () => r()));
  await waitFor(() => project.read().includes('npm ci'));
  const preview = startPreview(project);
  try {
    assert.match(preview.out, /installing/, 'the marker was gone mid-install, so the preview meant to install');
    await done;
    await waitFor(() => project.read().includes('npm run dev'));
    assert.equal(project.read().filter(l => l === 'npm ci').length, 1, 'only one npm ci ran');
    assert.match(preview.log(), /installed meanwhile by another CPM install/);
  } finally {
    preview.stop();
  }
});

test('when the task\'s preview never installs, the verification leaves a stale node_modules alone', { timeout: 20000 }, () => {
  const project = makeProject();
  unknownInstall(project);
  assert.equal(settle(project, false).status, 'stale');
  assert.deepEqual(project.read(), [], 'nothing was installed or deleted');
  assert.ok(tsxPresent(project));
});

test('a project without package.json has nothing to settle', { timeout: 20000 }, () => {
  const project = makeProject();
  rmSync(join(project.work, 'package.json'));
  assert.equal(settle(project).status, 'none');
  assert.deepEqual(project.read(), []);
});

test('a failed install is reported with the end of its log, and no marker is written', { timeout: 20000 }, () => {
  const project = makeProject();
  writeFileSync(join(project.env.PATH!.split(':')[0], 'npm'), '#!/bin/sh\necho "npm error 404 Not Found"; exit 1\n');
  const result = settle(project);
  assert.equal(result.status, 'install-failed');
  assert.equal(result.installExit, 1);
  assert.match(result.logTail ?? '', /404 Not Found/);
  assert.equal(existsSync(join(project.work, INSTALL_MARKER)), false);
});

// ---------------------------------------------------------------------------
// A plain `npm ci` by the agent is recognised
// ---------------------------------------------------------------------------

test('the preview does not reinstall a node_modules the agent installed with a plain npm ci — it records the marker instead', { timeout: 20000 }, async () => {
  const project = makeProject();
  agentInstalled(project);
  const preview = startPreview(project);
  try {
    assert.doesNotMatch(preview.out, /installing/);
    await waitFor(() => project.read().includes('npm run dev'));
    assert.deepEqual(project.read(), ['npm run dev']);
    assert.ok(existsSync(join(project.work, INSTALL_MARKER)), 'the marker now records that node_modules matches the lockfile');
  } finally {
    preview.stop();
  }
});

test('the verification recognises an agent-installed node_modules and records the marker without installing', { timeout: 20000 }, () => {
  const project = makeProject();
  agentInstalled(project);
  assert.equal(settle(project).status, 'recorded');
  assert.deepEqual(project.read(), []);
  assert.equal(settle(project).status, 'current', 'and next time the marker alone settles it');
});

test('a node_modules installed for a different version of a package is not taken as current', { timeout: 20000 }, () => {
  const project = makeProject();
  agentInstalled(project, { ...LOCK, packages: { ...LOCK.packages, 'node_modules/tsx': { version: '4.7.0', dev: true } } });
  assert.equal(settle(project).status, 'installed');
  assert.deepEqual(project.read(), ['npm ci', 'npm ci done']);
});

test('a node_modules missing a required package is not taken as current, but a missing optional one is fine', { timeout: 20000 }, () => {
  const missingRequired = makeProject();
  agentInstalled(missingRequired, { ...LOCK, packages: { 'node_modules/@esbuild/darwin-arm64': LOCK.packages['node_modules/@esbuild/darwin-arm64'] } });
  assert.equal(settle(missingRequired).status, 'installed');

  const missingOptional = makeProject();
  agentInstalled(missingOptional, RECORDED);
  assert.equal(settle(missingOptional).status, 'recorded');
});

test('a package npm recorded but whose directory has since been deleted is not taken as current', { timeout: 20000 }, () => {
  const project = makeProject();
  agentInstalled(project);
  rmSync(join(project.work, 'node_modules/tsx'), { recursive: true });
  assert.equal(settle(project).status, 'installed');
});

test('without a package-lock.json, npm\'s record is not trusted and a project without the marker still installs', { timeout: 20000 }, () => {
  const project = makeProject();
  agentInstalled(project);
  rmSync(join(project.work, 'package-lock.json'));
  // No lockfile → the deps file is package.json and the command npm install.
  assert.equal(settle(project).status, 'installed');
  assert.equal(project.read()[0], 'npm install');
});

test('unrecognisable settle output is unknown, never a verdict', () => {
  assert.deepEqual(parseDependencySettleOutput('ssh: connection reset'), { status: 'unknown' });
});
