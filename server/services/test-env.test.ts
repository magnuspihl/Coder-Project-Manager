/**
 * "Can this worktree run its tests at all?" — the pre-check before a review
 * (and the install it triggers), and telling a broken environment apart from a
 * broken test after one. The pre-check script is run for real with `sh`, in
 * temporary project directories, with fake package managers first on PATH.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTestEnvCommand,
  environmentFailure,
  environmentProblem,
  parseTestEnvOutput,
  preReviewGate,
  reviewStatusView,
  runnerRequirements,
  suiteUnrunnable,
  type TestEnvCheck,
} from './test-env.js';
import { INSTALL_MARKER } from './install-script.js';
import type { TestProfile } from './test-runners.js';

const tsxProfile: TestProfile = { runner: 'node-test', command: 'node --import tsx --test', source: 'detected' };
const vitestProfile: TestProfile = { runner: 'vitest', source: 'detected' };

// Captured from real runs of the harness's own run command in a directory with no node_modules.
const TSX_MISSING = `node:internal/modules/package_json_reader:314
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
        ^
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /tmp/cpm-envprobe-Fej5/
    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:314:9)`;
const NPX_MISSING = `npm error npx canceled due to missing packages and no YES option: ["vitest@5.1.1"]
npm error A complete log of this run can be found in: /home/coder/.npm/_logs/x-debug-0.log`;

// ---------------------------------------------------------------------------
// What the runner needs
// ---------------------------------------------------------------------------

test('a node:test profile run through tsx needs the tsx package and installed dependencies', () => {
  const r = runnerRequirements(tsxProfile);
  assert.deepEqual(r.packages, ['tsx']);
  assert.equal(r.nodeDeps, true);
});

test('vitest and jest profiles need their own package; pytest needs its Python module; go needs the go binary', () => {
  assert.deepEqual(runnerRequirements(vitestProfile).packages, ['vitest']);
  assert.deepEqual(runnerRequirements({ runner: 'jest', source: 'detected' }).packages, ['jest']);
  assert.deepEqual(runnerRequirements({ runner: 'pytest', source: 'detected' }).python, { interpreter: 'python3', module: 'pytest' });
  assert.equal(runnerRequirements({ runner: 'go', source: 'detected' }).command, 'go');
  assert.equal(runnerRequirements({ runner: 'go', source: 'detected' }).nodeDeps, false);
});

// ---------------------------------------------------------------------------
// Classifying a run: environment vs test
// ---------------------------------------------------------------------------

test('a run that fails because the tsx package is missing is an environment failure', () => {
  assert.match(environmentFailure(tsxProfile, TSX_MISSING) ?? '', /"tsx" is not installed/);
});

test('a run where npx cannot find vitest is an environment failure', () => {
  assert.match(environmentFailure(vitestProfile, NPX_MISSING) ?? '', /not installed/);
});

test('a test with a wrong relative import, or importing a package the project lacks, is a broken test — not the environment', () => {
  assert.equal(environmentFailure(tsxProfile, "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/w/src/nope.ts' imported from /w/src/a.cpm-proof.test.ts"), null);
  assert.equal(environmentFailure(tsxProfile, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'supertest' imported from /w/a.cpm-proof.test.ts"), null);
  assert.equal(environmentFailure(tsxProfile, 'AssertionError: expected 1 to equal 2'), null);
});

test('a suite that errored before running any test is unrunnable', () => {
  assert.match(suiteUnrunnable({ passed: 0, failed: 0, skipped: 0, failedNames: [], error: TSX_MISSING }) ?? '', /tests could not run: the whole suite errored before running any test/);
});

test('a suite that ran tests, found none, or timed out is not called unrunnable', () => {
  assert.equal(suiteUnrunnable({ passed: 3, failed: 1, skipped: 0, failedNames: ['x'], error: 'one file did not load' }), null);
  assert.equal(suiteUnrunnable({ passed: 0, failed: 0, skipped: 0, failedNames: [], error: 'No tests ran' }), null);
  assert.equal(suiteUnrunnable({ passed: 0, failed: 0, skipped: 0, failedNames: [], error: 'The suite timed out' }), null);
  assert.equal(suiteUnrunnable({ passed: 5, failed: 0, skipped: 0, failedNames: [] }), null);
  assert.equal(suiteUnrunnable(undefined), null);
});

test('after a review, a suite that could not run makes the environment the problem without re-checking', async () => {
  let rechecked = false;
  const reason = await environmentProblem({
    suite: { passed: 0, failed: 0, skipped: 0, failedNames: [], error: TSX_MISSING },
    proofs: [],
    recheck: async () => { rechecked = true; return { status: 'ok', missing: [] }; },
  });
  assert.match(reason ?? '', /tests could not run/);
  assert.equal(rechecked, false);
});

test('after a review, a proof that failed to load triggers a re-check, which decides whether the environment is broken', async () => {
  const loadFailure = { status: 'unproven', reason: 'The test could not run', output: "Cannot find package 'zod' imported from /w/src/x.ts" };
  const missing: TestEnvCheck = { status: 'missing', missing: ['node_modules'] };
  assert.match(await environmentProblem({ proofs: [loadFailure], recheck: async () => missing }) ?? '', /no dependencies installed in the worktree/);
  assert.equal(await environmentProblem({ proofs: [loadFailure], recheck: async () => ({ status: 'ok', missing: [] }) }), null,
    'with the environment fine, a load failure is the test\'s own problem');
});

test('after a review, refuted and confirmed proofs never trigger an environment re-check', async () => {
  let rechecked = false;
  const recheck = async (): Promise<TestEnvCheck> => { rechecked = true; return { status: 'missing', missing: ['node_modules'] }; };
  const reason = await environmentProblem({
    proofs: [
      { status: 'refuted', reason: 'The test passes on the current code', output: '' },
      { status: 'confirmed', reason: 'The test fails on the current code', output: 'AssertionError' },
    ],
    recheck,
  });
  assert.equal(reason, null);
  assert.equal(rechecked, false);
});

// ---------------------------------------------------------------------------
// The pre-check gate
// ---------------------------------------------------------------------------

test('the pre-check lets the review proceed when the runner is installed, was just installed, or could not be checked', () => {
  for (const status of ['ok', 'installed', 'unknown'] as const) {
    assert.deepEqual(preReviewGate({ status, missing: [] }), { proceed: true }, status);
  }
});

test('the pre-check stops the review with a plain reason and the install log tail when the install failed', () => {
  const gate = preReviewGate({ status: 'install-failed', missing: ['node_modules'], installCommand: 'npm ci', installExit: 1, logTail: 'npm error 404 onnxruntime-node' });
  assert.equal(gate.proceed, false);
  if (gate.proceed) return;
  assert.match(gate.reason, /^tests could not run: no dependencies installed in the worktree/);
  assert.match(gate.reason, /npm ci\) failed with exit code 1/);
  assert.equal(gate.log, 'npm error 404 onnxruntime-node');
});

test('unrecognisable pre-check output is "unknown", never a verdict', () => {
  assert.equal(parseTestEnvOutput('').status, 'unknown');
  assert.equal(parseTestEnvOutput('Connection refused').status, 'unknown');
});

// ---------------------------------------------------------------------------
// The pre-check script, for real
// ---------------------------------------------------------------------------

const base = mkdtempSync(join(tmpdir(), 'cpm-test-env-'));
test.after(() => rmSync(base, { recursive: true, force: true }));

/**
 * A project with a lockfile and fake package managers that log their calls.
 * An install "succeeds" by creating node_modules/tsx, or fails (after creating a
 * partial node_modules) when a `fail-install` file is present, or creates
 * node_modules without tsx when `install-without-tsx` is present.
 */
function makeProject(files: Record<string, string> = {}) {
  const work = mkdtempSync(join(base, 'proj-'));
  const fakeBin = mkdtempSync(join(base, 'bin-'));
  const calls = join(work, 'calls.log');
  for (const tool of ['npm', 'pnpm', 'yarn']) {
    writeFileSync(join(fakeBin, tool), `#!/bin/sh
if [ "$1" = --version ]; then echo 1.22.19; exit 0; fi
echo "${tool} $*" >> '${calls}'
mkdir -p node_modules
if [ -f fail-install ]; then echo "npm error 404 Not Found - GET https://example.invalid/onnxruntime-cuda.tgz"; exit 1; fi
[ -f install-without-tsx ] || { mkdir -p node_modules/tsx && echo '{}' > node_modules/tsx/package.json; }
exit 0
`);
    chmodSync(join(fakeBin, tool), 0o755);
  }
  writeFileSync(join(work, 'package.json'), '{"devDependencies":{"tsx":"^4"}}');
  writeFileSync(join(work, 'package-lock.json'), '{"v":1}');
  for (const [f, c] of Object.entries(files)) writeFileSync(join(work, f), c);
  const read = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { work, fakeBin, read };
}

function check(project: ReturnType<typeof makeProject>, install: boolean, profile: TestProfile = tsxProfile) {
  const cmd = buildTestEnvCommand(profile, project.work, { install, logPath: join(project.work, 'install.log'), timeoutSec: 30 });
  const out = execFileSync('sh', ['-c', cmd], { env: { ...process.env, PATH: `${project.fakeBin}:${process.env.PATH}`, HOME: project.work } }).toString();
  return parseTestEnvOutput(out);
}

test('the pre-check passes without installing anything when the runner is already installed', { timeout: 20000 }, () => {
  const project = makeProject();
  mkdirSync(join(project.work, 'node_modules/tsx'), { recursive: true });
  writeFileSync(join(project.work, 'node_modules/tsx/package.json'), '{}');
  assert.equal(check(project, true).status, 'ok');
  assert.deepEqual(project.read(), [], 'a working node_modules is never reinstalled');
});

test('the pre-check installs missing dependencies the way the preview does, and the review proceeds', { timeout: 20000 }, () => {
  const project = makeProject();
  const result = check(project, true);
  assert.equal(result.status, 'installed');
  assert.equal(result.installCommand, 'npm ci');
  assert.deepEqual(project.read(), ['npm ci']);
  assert.ok(existsSync(join(project.work, INSTALL_MARKER)), 'the preview\'s install marker is written, so the preview does not install again');
  assert.deepEqual(preReviewGate(result), { proceed: true });
});

test('a failed install makes the pre-check report install-failed with the end of the install log', { timeout: 20000 }, () => {
  const project = makeProject({ 'fail-install': '' });
  const result = check(project, true);
  assert.equal(result.status, 'install-failed');
  assert.equal(result.installExit, 1);
  assert.match(result.logTail ?? '', /404 Not Found/);
  assert.equal(existsSync(join(project.work, INSTALL_MARKER)), false, 'no success marker after a failed install');
  const gate = preReviewGate(result);
  assert.equal(gate.proceed, false);
});

test('when the install succeeds but the runner is still missing, the pre-check reports it missing', { timeout: 20000 }, () => {
  const project = makeProject({ 'install-without-tsx': '' });
  const result = check(project, true);
  assert.equal(result.status, 'missing');
  assert.deepEqual(result.missing, ['package:tsx']);
  assert.equal(preReviewGate(result).proceed, false);
});

test('a check without install only reports what is missing and installs nothing', { timeout: 20000 }, () => {
  const project = makeProject();
  const result = check(project, false);
  assert.equal(result.status, 'missing');
  assert.deepEqual(result.missing, ['node_modules', 'package:tsx']);
  assert.deepEqual(project.read(), []);
});

test('a non-Node runner that is not installed is reported missing, with no install attempted', { timeout: 20000 }, () => {
  const project = makeProject();
  const result = check(project, true, { runner: 'go', command: 'cpm-no-such-go-binary test', source: 'user' });
  assert.equal(result.status, 'missing');
  assert.deepEqual(result.missing, ['command:cpm-no-such-go-binary']);
  assert.deepEqual(project.read(), []);
});

test('the pre-check waits for a dependency install already running in the same directory instead of racing it', { timeout: 30000 }, async t => {
  try { execFileSync('sh', ['-c', 'command -v flock']); } catch { return t.skip('flock is not available'); }
  const project = makeProject();
  // Another CPM install (the preview's) holds the lock, then finishes the install.
  const lock = `/tmp/cpm-install-$(cd '${project.work}' && pwd -P | cksum | cut -d' ' -f1).lock`;
  const holder = spawn('sh', ['-c', `exec 9>"${lock}"; flock 9; echo held; sleep 1; mkdir -p node_modules/tsx && echo '{}' > node_modules/tsx/package.json`], { cwd: project.work });
  await new Promise<void>(resolve => holder.stdout.once('data', () => resolve()));
  const result = check(project, true);
  assert.equal(result.status, 'installed', 'it saw the other install\'s result once the lock was free');
  assert.deepEqual(project.read(), [], 'and did not run a second install');
});

// ---------------------------------------------------------------------------
// The status shown to MCP callers
// ---------------------------------------------------------------------------

const turn = (outcome: string, extra: Record<string, unknown> = {}) => ({
  role: 'reviewer', completed_at: '2026-11-21T00:00:00Z', review_outcome: outcome, review_summary: `${outcome} summary`, review_proofs: null, ...extra,
});

test('the latest review shows as passed only when it actually passed', () => {
  assert.equal(reviewStatusView([turn('pass')], {}).passed, true);
  for (const o of ['fail', 'partial', 'unverified']) assert.equal(reviewStatusView([turn(o)], {}).passed, false, o);
  assert.deepEqual(reviewStatusView([], {}), { outcome: null, passed: false, summary: null });
});

test('an unverified review carries its reason, and a failed preview install marks the worktree not testable', () => {
  const view = reviewStatusView(
    [turn('pass'), turn('unverified', { review_proofs: JSON.stringify({ mode: 'proof', proofs: [], unverified: { reason: 'tests could not run: no dependencies installed in the worktree' } }) })],
    { preview_status: 'failed', preview_error: 'Installing the dependencies failed.\nnpm error 404' },
  );
  assert.equal(view.outcome, 'unverified');
  assert.equal(view.passed, false);
  assert.equal(view.unverified_reason, 'tests could not run: no dependencies installed in the worktree');
  assert.match(view.worktree_not_testable ?? '', /dependency install failed/);
  assert.equal(reviewStatusView([turn('pass')], { preview_status: 'failed', preview_error: 'The preview exited shortly after starting.' }).worktree_not_testable, undefined,
    'a preview that failed for another reason says nothing about the tests');
});
