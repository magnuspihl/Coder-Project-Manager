/**
 * Why agent-box reviews ran in opinion mode, and what makes them proof mode.
 *
 * The incident (agent-box task 6134c00e, 2026-11-21): both review turns were
 * `review_mode: "opinion"` and nothing was test-verified, although `npm test`
 * passes 405/405 in that worktree. agent-box's script is
 * `tsx --test test/*.test.ts test/*.test.mts`; detection only knew
 * `node … --test`, so `detectProfile` returned null and the review fell back to
 * opinion mode — reading like an ordinary pass.
 *
 * The fixture is agent-box's real package.json and root listing. The run tests
 * build an agent-box-shaped project in a temp dir (tests in test/, one .mts) and
 * run it for real through the harness's own run command — with a private copy
 * of tsx, or with none at all (the case that must end unverified).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRunCommand, detectProfile, explainDetectProfile, parseRunOutput, RESULT_MARKER, type TestProfile } from './test-runners.js';
import type { ReviewDecision } from './review-verdict.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, '__fixtures__', 'agent-box', name), 'utf8');
const agentBox = { packageJson: fixture('package.json'), rootFiles: fixture('root-listing.txt').split('\n').filter(Boolean) };
const pj = (test: string, extra: Record<string, unknown> = {}) => JSON.stringify({ scripts: { test }, ...extra });

const dir = mkdtempSync(join(tmpdir(), 'cpm-detect-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.CODER_WORKSPACE_NAME = 'local-ws';
process.env.CPM_CHECKPOINTS_BASE = join(dir, 'checkpoints');

let T: typeof import('./tasks.js');
let C: typeof import('./claude.js');
let R: typeof import('./review-proof.js');
let IO: typeof import('./review-io.js');
let P: typeof import('./test-profile.js');
let E: typeof import('./test-env.js');
let V: typeof import('./verification.js');
let loadError: Error | null = null;
/** The private tsx copy (see tsxModules) — declared here: `before` runs while this module is still evaluating. */
let privateModules: string | null = null;

before(async () => {
  // Copy tsx now, at startup — this runner has just loaded it from the same
  // node_modules, so it is there; later in the run it may not be (see tsxModules).
  tsxModules();
  R = await import('./review-proof.js');
  IO = await import('./review-io.js');
  E = await import('./test-env.js');
  V = await import('./verification.js');
  try {
    const { getDb } = await import('../db/index.js');
    T = await import('./tasks.js');
    C = await import('./claude.js');
    P = await import('./test-profile.js');
    getDb().prepare("INSERT INTO users (id, username) VALUES ('u', 'tester')").run();
  } catch (err) {
    loadError = err as Error;
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

const dbTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, async t => { if (loadError) return t.skip(`database unavailable: ${loadError.message.slice(0, 80)}`); await fn(); });

// ---------------------------------------------------------------------------
// The root cause, reproduced against agent-box's real package.json
// ---------------------------------------------------------------------------

test('agent-box\'s real package.json (tsx --test over test/*.test.ts and test/*.test.mts) is detected as node:test with its own glob', () => {
  const profile = detectProfile(agentBox);
  assert.deepEqual(profile, {
    runner: 'node-test',
    command: 'npx --no-install tsx --test',
    suite: 'test/*.test.ts test/*.test.mts',
    source: 'detected',
  });
});

test('the agent-box script is the one that used to be missed: the old node-only pattern does not match it', () => {
  // The exact check detectProfile used before this fix — kept here as evidence of the cause.
  const oldNodeTest = /\bnode\b([^&|;]*?)--test\b\s*([^&|;]*)$/;
  const script = (JSON.parse(agentBox.packageJson) as { scripts: { test: string } }).scripts.test;
  assert.equal(script, 'tsx --test test/*.test.ts test/*.test.mts');
  assert.equal(oldNodeTest.exec(script), null);
  assert.ok(!agentBox.rootFiles.some(f => /^(pytest\.ini|conftest\.py|tox\.ini|setup\.cfg|pyproject\.toml|requirements\.txt|go\.mod)$|\.(sln|csproj|fsproj)$/.test(f)),
    'and no other marker file rescues it');
});

test('tsx --test is recognised behind npx, pnpm or yarn, after env assignments or cross-env, and after another command', () => {
  for (const script of [
    'npx tsx --test test/*.test.ts',
    'pnpm exec tsx --test test/*.test.ts',
    'yarn tsx --test test/*.test.ts',
    'NODE_ENV=test tsx --test test/*.test.ts',
    'cross-env NODE_ENV=test tsx --test test/*.test.ts',
    'npm run build && tsx --test test/*.test.ts',
  ]) {
    const p = detectProfile({ packageJson: pj(script), rootFiles: [] });
    assert.equal(p?.runner, 'node-test', script);
    assert.equal(p?.command, 'npx --no-install tsx --test', script);
    assert.equal(p?.suite, 'test/*.test.ts', script);
  }
});

test('tsx flags before --test are kept, and the script\'s own reporter flag is dropped so the harness can read TAP', () => {
  const p = detectProfile({ packageJson: pj('tsx --tsconfig tsconfig.test.json --test --test-reporter=spec "test/**/*.test.ts"'), rootFiles: [] });
  assert.equal(p?.command, 'npx --no-install tsx --tsconfig tsconfig.test.json --test');
  assert.equal(p?.suite, '"test/**/*.test.ts"');
});

test('tsx --test with no glob relies on node\'s own discovery', () => {
  const p = detectProfile({ packageJson: pj('tsx --test'), rootFiles: [] });
  assert.deepEqual(p, { runner: 'node-test', command: 'npx --no-install tsx --test', source: 'detected' });
});

test('node --test scripts still detect as before, and a --test-reporter flag is no longer mistaken for --test', () => {
  assert.deepEqual(detectProfile({ packageJson: pj('node --import tsx --test "server/**/*.test.ts"'), rootFiles: [] }),
    { runner: 'node-test', command: 'node --import tsx --test', suite: '"server/**/*.test.ts"', source: 'detected' });
  assert.deepEqual(detectProfile({ packageJson: pj('node --test-reporter=spec --test test/'), rootFiles: [] }),
    { runner: 'node-test', suite: 'test/', source: 'detected' });
});

test('tsx watch (a dev script, not a test run) is not mistaken for a test runner', () => {
  assert.equal(detectProfile({ packageJson: pj('tsx watch src/server.ts'), rootFiles: [] }), null);
});

test('a script with shell metacharacters in its glob still detects the runner, without the unsafe suite', () => {
  const p = detectProfile({ packageJson: pj('tsx --test $(ls test/*.test.ts)'), rootFiles: [] });
  assert.deepEqual(p, { runner: 'node-test', command: 'npx --no-install tsx --test', source: 'detected' });
});

// ---------------------------------------------------------------------------
// Genuinely no runner: still opinion mode, with the reason said plainly
// ---------------------------------------------------------------------------

test('a project with genuinely no test runner falls back, and says why', () => {
  const noScript = explainDetectProfile({ packageJson: '{"name":"x"}', rootFiles: ['package.json'] });
  assert.equal(noScript.profile, null);
  assert.match(noScript.reason ?? '', /no "test" script/);

  const npmDefault = explainDetectProfile({ packageJson: pj('echo "Error: no test specified" && exit 1'), rootFiles: [] });
  assert.equal(npmDefault.profile, null);
  assert.match(npmDefault.reason ?? '', /"test" script \(`echo "Error: no test specified" && exit 1`\) is not a runner CPM can drive/);

  const godot = explainDetectProfile({ rootFiles: ['project.godot', 'scenes'] });
  assert.equal(godot.profile, null);
  assert.match(godot.reason ?? '', /no package\.json, and no pytest, Go or \.NET project files/);

  assert.match(explainDetectProfile({ packageJson: '{nope', rootFiles: [] }).reason ?? '', /could not be parsed/);
  assert.equal(explainDetectProfile(agentBox).reason, undefined, 'a detected runner carries no fallback reason');
});

dbTest('resolving a workspace\'s profile reports why there is none — including an unreachable workspace', async () => {
  const none = await P.explainTestProfile('ws-none-1', '/wt', async () => 'README.md\n@@CPM_PACKAGE_JSON@@\n');
  assert.equal(none.profile, null);
  assert.match(none.reason ?? '', /no test runner found/);

  const down = await P.explainTestProfile('ws-none-2', '/wt', async () => { throw new Error('ssh: workspace is stopped'); });
  assert.equal(down.profile, null);
  assert.match(down.reason ?? '', /could not inspect the worktree .*workspace is stopped/);

  const ab = await P.explainTestProfile('ws-ab', '/wt', async () => `${agentBox.rootFiles.join('\n')}\n@@CPM_PACKAGE_JSON@@\n${agentBox.packageJson}`);
  assert.equal(ab.profile?.runner, 'node-test');
  assert.equal(ab.reason, undefined);
});

// ---------------------------------------------------------------------------
// The detected profile really runs an agent-box-shaped project
// ---------------------------------------------------------------------------

/**
 * Run the harness's scripts locally, as sshExec does for the local workspace —
 * in an environment that cannot leak a tsx in from elsewhere: no npm_* variables
 * (npm_config_local_prefix, inherited from an `npm run`, points npx at another
 * project), no node_modules/.bin directories on PATH, an empty global npm
 * prefix, and no NODE_TEST_CONTEXT (it would hijack the child's reporter).
 * Its own TMPDIR too: the run scripts `mktemp`, and other test files running in
 * parallel check the shared /tmp for leftover scratch files.
 */
const globalPrefix = join(dir, 'npm-global');
mkdirSync(globalPrefix);
const childTmp = join(dir, 'tmp');
mkdirSync(childTmp);
const childEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT' && !/^npm_/i.test(k))),
  PATH: (process.env.PATH ?? '').split(':').filter(d => d && !d.includes('node_modules')).join(':'),
  npm_config_prefix: globalPrefix,
  TMPDIR: childTmp,
};
const localExec = (cmd: string, timeoutMs = 90000) => new Promise<string>((resolve, reject) => {
  execFile('sh', ['-c', cmd], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: childEnv, cwd: dir }, (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)));
});

/**
 * A private node_modules holding tsx and its runtime dependencies, copied ONCE
 * at the start of this file (from `before`). The projects never touch this repo's
 * node_modules afterwards — which matters: CPM's preview can `npm ci` the
 * worktree (wiping node_modules) at the very moment the harness runs this file.
 */
function tsxModules(): string {
  if (privateModules) return privateModules;
  const repoModules = join(here, '..', '..', 'node_modules');
  const target = join(dir, 'deps', 'node_modules');
  const seen = new Set<string>();
  const copy = (name: string, optional: boolean) => {
    if (seen.has(name)) return;
    const from = join(repoModules, name);
    if (!existsSync(join(from, 'package.json'))) {
      if (optional) return;
      throw new Error(`test setup: ${name} is not installed in ${repoModules}`);
    }
    seen.add(name);
    cpSync(from, join(target, name), { recursive: true, dereference: true });
    const pkg = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    for (const dep of Object.keys(pkg.dependencies ?? {})) copy(dep, false);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) copy(dep, true); // platform packages: only the installed one
  };
  copy('tsx', false);
  mkdirSync(join(target, '.bin'));
  symlinkSync('../tsx/dist/cli.mjs', join(target, '.bin', 'tsx'));
  return (privateModules = target);
}

/**
 * test/ holds the tests (one .ts, one .mts), src/ the code — like agent-box.
 * `withTsx: false` is a worktree whose dependencies are not installed: the
 * package.json still declares tsx, but node_modules is empty.
 */
function agentBoxProject(opts: { withTsx: boolean } = { withTsx: true }): string {
  const root = mkdtempSync(join(dir, 'ab-'));
  writeFileSync(join(root, 'package.json'), agentBox.packageJson);
  if (opts.withTsx) symlinkSync(tsxModules(), join(root, 'node_modules'));
  else mkdirSync(join(root, 'node_modules'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'src', 'add.ts'), 'export function add(a: number, b: number): number { return a + b; }\n');
  writeFileSync(join(root, 'test', 'add.test.ts'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.ts';\ntest('adds in .ts', () => assert.equal(add(1, 2), 3));\n");
  writeFileSync(join(root, 'test', 'identity.test.mts'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.ts';\ntest('adds in .mts', () => assert.equal(add(0, 5), 5));\n");
  return root;
}

const FAILING_PROOF = { path: 'test/add-negative.cpm-proof.test.mts', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.ts';\ntest('add is wrong on purpose', () => assert.equal(add(2, 2), 5));\n" };

function runProof(root: string, profile: TestProfile) {
  return R.verifyProofs({
    issues: [{ text: 'add is wrong', requirement: 'add must add', proofPath: FAILING_PROOF.path }],
    files: [FAILING_PROOF],
    profile,
    io: IO.makeProofIO(localExec, root, profile),
  });
}

/** The harness's real pre-review (`full`) verification, which runs the whole suite; the git-facing parts report "nothing changed". */
function verifySuite(root: string, profile: TestProfile) {
  const real = IO.makeVerificationIO(localExec, root, profile);
  return V.buildVerification({
    profile,
    level: 'full',
    io: {
      ...real,
      fingerprint: async () => '', changedPaths: async () => [], addedPaths: async () => [],
      baseSources: async () => ({}), currentSources: async () => ({}), prepareBaseline: async () => null,
    },
  });
}

test('the harness\'s whole-suite run of the detected profile runs both the .ts and the .mts tests in test/', { timeout: 120000 }, async () => {
  const root = agentBoxProject();
  const profile = detectProfile(agentBox)!;
  const report = parseRunOutput(profile.runner, await localExec(buildRunCommand(profile, root, [])));
  assert.equal(report.suiteError, undefined, report.suiteError);
  assert.deepEqual(report.cases.map(c => [c.name, c.outcome]).sort(), [['adds in .mts', 'passed'], ['adds in .ts', 'passed']]);
});

test('a reviewer\'s failing proof placed in test/ (.mts) is run directly and confirms the defect', { timeout: 120000 }, async () => {
  const root = agentBoxProject();
  const profile = detectProfile(agentBox)!;
  assert.equal(R.validateProofPath(FAILING_PROOF.path, profile), null, 'a proof next to the project\'s own tests is an accepted path');
  const verified = await runProof(root, profile);
  assert.equal(verified[0].proof.status, 'confirmed', verified[0].proof.reason + '\n' + verified[0].proof.output);
  assert.equal(R.routeReview('proof', { outcome: 'fail', summary: 'add is wrong' }, verified).outcome, 'fail');
});

// ---------------------------------------------------------------------------
// tsx not installed: `npx --no-install tsx` resolves to nothing. That must be
// "could not run" → unverified, never a suite that quietly ran zero tests.
// ---------------------------------------------------------------------------

test('a run where the command fails before any test starts is a suite error, not zero clean results', () => {
  const npxOutput = 'npm error npx canceled due to missing packages and no YES option: ["tsx@4.23.15"]\nnpm error A complete log of this run can be found in: /home/coder/.npm/_logs/x.log\n';
  const report = parseRunOutput('node-test', `\n${RESULT_MARKER} exit=1\n${npxOutput}`);
  assert.equal(report.cases.length, 0);
  assert.match(report.suiteError ?? '', /npx canceled due to missing packages/);

  const empty = parseRunOutput('node-test', `\n${RESULT_MARKER} exit=0\nTAP version 13\n1..0\n# tests 0\n# pass 0\n`);
  assert.equal(empty.suiteError, undefined, 'a clean exit that found no tests is still "no tests ran", as before');
});

test('with tsx not installed, the agent-box suite run makes the review unverified — never a pass', { timeout: 120000 }, async () => {
  const root = agentBoxProject({ withTsx: false });
  const profile = detectProfile(agentBox)!;
  const summary = await verifySuite(root, profile);
  assert.equal(summary.suite?.passed, 0);
  assert.match(summary.suite?.error ?? '', /npx canceled due to missing packages|could not determine executable/, 'the suite records npx\'s own error');

  const envProblem = await E.environmentProblem({ suite: summary.suite, proofs: [] });
  assert.match(envProblem ?? '', /^tests could not run: /);
  const routed = R.routeReview('proof', { outcome: 'pass', summary: 'looks right' }, [], envProblem);
  assert.equal(routed.outcome, 'unverified');
});

test('with tsx not installed, a reviewer\'s proof is an environment failure, so the review is unverified — never a pass', { timeout: 120000 }, async () => {
  const root = agentBoxProject({ withTsx: false });
  const profile = detectProfile(agentBox)!;
  const verified = await runProof(root, profile);
  assert.equal(verified[0].proof.status, 'unproven');
  assert.equal(verified[0].proof.environment, true, verified[0].proof.reason + '\n' + verified[0].proof.output);
  assert.match(verified[0].proof.reason, /the test runner is not installed \(npx could not find it\)/);
  const routed = R.routeReview('proof', { outcome: 'fail', summary: 'add is wrong' }, verified);
  assert.equal(routed.outcome, 'unverified');
  assert.match(routed.unverifiedReason ?? '', /^tests could not run: /);
});

dbTest('with tsx not installed, the routed review is stored as unverified and MCP get_task does not report it as passed', async () => {
  const root = agentBoxProject({ withTsx: false });
  const profile = detectProfile(agentBox)!;
  const summary = await verifySuite(root, profile);
  const envProblem = await E.environmentProblem({ suite: summary.suite, proofs: [] });

  const task = T.createTask({ workspaceId: 'w-npx', workspaceName: 'local-ws', userId: 'u', username: 'tester', prompt: 'p' });
  T.updateTaskStatus(task.id, 'working');
  const turn = T.createTaskTurn({ taskId: task.id, role: 'reviewer' });
  C._reviewContextsForTest.set(turn.id, { mode: 'proof', profile } as never);
  C.routeVerifiedReview(T.getTask(task.id)!, turn.id, { outcome: 'pass', summary: 'looks right' }, 'proof', [], profile, envProblem);

  const stored = T.getTaskTurns(task.id).find(t => t.id === turn.id)!;
  assert.equal(stored.review_outcome, 'unverified');
  const view = E.reviewStatusView(T.getTaskTurns(task.id), T.getTask(task.id)!);
  assert.equal(view.passed, false);
  assert.match(view.unverified_reason ?? '', /^tests could not run: /);
});

test('the pre-review check finds the project\'s tsx installed, so the review proceeds in proof mode', () => {
  const req = E.runnerRequirements(detectProfile(agentBox)!);
  assert.deepEqual(req.packages, ['tsx'], 'it checks for tsx in node_modules');
  assert.equal(req.command, null, 'and does not demand a global tsx on PATH');
  assert.equal(req.nodeDeps, true);
});

// ---------------------------------------------------------------------------
// The opinion fallback is visible, and never reads as a pass
// ---------------------------------------------------------------------------

const passDecision: ReviewDecision = { outcome: 'pass', summary: 'looks right' };

test('an opinion-mode review carries "not test-verified: <reason>" into its routing, tally and stored form', () => {
  const routed = R.routeReview('opinion', passDecision, [], null, 'package.json has no "test" script and no vitest or jest dependency');
  assert.equal(routed.outcome, 'pass');
  assert.equal(routed.notTestVerified, 'package.json has no "test" script and no vitest or jest dependency');
  assert.equal(R.tally(routed), 'not test-verified: package.json has no "test" script and no vitest or jest dependency');
  assert.deepEqual(R.toStored(routed, []).notTestVerified, { reason: 'package.json has no "test" script and no vitest or jest dependency' });
  assert.equal(R.toStored(R.routeReview('proof', passDecision, []), []).notTestVerified, undefined, 'a proof-mode review has no such note');
});

const reviewerTurn = (mode: 'proof' | 'opinion' | null, outcome = 'pass', proofs: unknown = null) => ({
  role: 'reviewer', completed_at: '2026-11-21T00:00:00Z', review_outcome: outcome, review_summary: 's',
  review_mode: mode, review_proofs: proofs === null ? null : JSON.stringify(proofs),
});

test('MCP get_task: an opinion-mode pass keeps outcome "pass" but is not passed, and says plainly it was not test-verified', () => {
  const view = E.reviewStatusView([reviewerTurn('opinion', 'pass', { mode: 'opinion', proofs: [], notTestVerified: { reason: 'no test runner found' } })], {});
  assert.equal(view.outcome, 'pass');
  assert.equal(view.passed, false);
  assert.equal(view.test_verified, false);
  assert.equal(view.not_test_verified, 'not test-verified: no test runner found');
});

test('MCP get_task: an old opinion-mode review with no stored reason still reads as not test-verified', () => {
  const view = E.reviewStatusView([reviewerTurn('opinion', 'pass', { mode: 'opinion', proofs: [] })], {});
  assert.equal(view.passed, false);
  assert.match(view.not_test_verified ?? '', /^not test-verified: /);
});

test('MCP get_task: a proof-mode pass is a test-verified pass', () => {
  const view = E.reviewStatusView([reviewerTurn('proof', 'pass', { mode: 'proof', proofs: [] })], {});
  assert.equal(view.passed, true);
  assert.equal(view.test_verified, true);
  assert.equal(view.not_test_verified, undefined);
});

dbTest('a routed opinion-mode review stores its reason and its summary starts "Not test-verified (…)"', () => {
  const task = T.createTask({ workspaceId: 'w-op', workspaceName: 'local-ws', userId: 'u', username: 'tester', prompt: 'p' });
  T.updateTaskStatus(task.id, 'working');
  const turn = T.createTaskTurn({ taskId: task.id, role: 'reviewer' });
  C._reviewContextsForTest.set(turn.id, { mode: 'opinion', profile: null, notTestVerified: 'no test runner found — no package.json' } as never);
  C.routeVerifiedReview(T.getTask(task.id)!, turn.id, passDecision, 'opinion', [], null);

  const stored = T.getTaskTurns(task.id).find(t => t.id === turn.id)!;
  assert.equal(stored.review_mode, 'opinion');
  assert.equal(stored.review_outcome, 'pass');
  assert.equal(stored.review_summary, 'Not test-verified (no test runner found — no package.json) — looks right');
  assert.deepEqual(JSON.parse(stored.review_proofs!).notTestVerified, { reason: 'no test runner found — no package.json' });
  assert.equal(E.reviewStatusView(T.getTaskTurns(task.id), T.getTask(task.id)!).passed, false);
});
