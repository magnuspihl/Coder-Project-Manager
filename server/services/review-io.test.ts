/**
 * Integration tests: the proof and verification pipelines against a REAL git
 * repository and a REAL test runner (node:test via tsx), with a local shell
 * standing in for `coder ssh`. Output is given CRLF line endings because
 * `coder ssh` runs commands under a PTY, which is what the parsers must survive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getReviewDiff, getReviewDiffInfo, hasBranchChanges, makeProofIO, makeVerificationIO, isScratchDir, type Exec } from './review-io.js';
import { rerunProof, routeReview, verifyProofs } from './review-proof.js';
import { extractProofFiles, parseReviewDecision } from './review-verdict.js';
import { buildVerification } from './verification.js';
import { buildRunCommand, detectProfile, parseRunOutput, type TestProfile } from './test-runners.js';
import { classifyRun } from './review-proof.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hasTsx = existsSync(join(repoRoot, 'node_modules', 'tsx'));

// This file itself runs under `node --test`, which marks its environment with
// NODE_TEST_CONTEXT; inherited by a nested `node --test` it switches that run to
// a different reporter protocol. A real workspace shell never has it.
const cleanEnv = { ...process.env };
delete cleanEnv.NODE_TEST_CONTEXT;

const exec: Exec = (command, timeout = 60000, maxBuffer = 8 * 1024 * 1024) =>
  new Promise((res, rej) => {
    execFile('bash', ['-c', command], { timeout, maxBuffer, env: cleanEnv }, (err, stdout) => {
      if (err && !stdout) return rej(err);
      res(stdout.trim().replace(/\n/g, '\r\n'));
    });
  });

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

const PROFILE: TestProfile = { runner: 'node-test', command: 'node --import tsx --test', source: 'detected' };

/** A repo whose base commit (on main) has a buggy greet(); the worktree is left dirty by the caller. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cpm-io-'));
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/greet.ts'), "export function greet(name: string): string { return 'hi ' + name; }\n");
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --import tsx --test "src/**/*.test.ts"' } }));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  return dir;
}

const skip = hasTsx ? false : 'node_modules/tsx is not installed';

test('detectProfile reads the real package.json of the temp repo, including the suite glob', { skip }, () => {
  const dir = makeRepo();
  try {
    const p = detectProfile({ packageJson: readFileSync(join(dir, 'package.json'), 'utf8'), rootFiles: readdirSync(dir) });
    assert.deepEqual(p, { runner: 'node-test', command: 'node --import tsx --test', suite: '"src/**/*.test.ts"', source: 'detected' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('proof pipeline: confirmed test is kept, refuted and broken ones are removed, nothing existing is overwritten', { skip }, async () => {
  const dir = makeRepo();
  try {
    const io = makeProofIO(exec, dir, PROFILE);
    const confirmed = 'src/greet.a.cpm-proof.test.ts';
    const refuted = 'src/greet.b.cpm-proof.test.ts';
    const broken = 'src/greet.c.cpm-proof.test.ts';
    const files = [
      { path: confirmed, content: "import test from 'node:test'; import assert from 'node:assert/strict'; import { greet } from './greet.ts';\ntest('greets with hello', () => { assert.equal(greet('Bo'), 'hello Bo'); });\n" },
      { path: refuted, content: "import test from 'node:test'; import assert from 'node:assert/strict'; import { greet } from './greet.ts';\ntest('greets with hi', () => { assert.equal(greet('Bo'), \"hi Bo\"); });\n" },
      { path: broken, content: "import test from 'node:test'; import { nope } from './does-not-exist.ts';\ntest('x', () => { nope(); });\n" },
    ];
    const issues = files.map(f => ({ text: `defect ${f.path}`, proofPath: f.path, requirement: 'r' }));
    const res = await verifyProofs({ issues, files, profile: PROFILE, io });

    assert.deepEqual(res.map(r => r.proof.status), ['confirmed', 'refuted', 'unproven']);
    assert.equal(res[2].proof.repairable, true);
    assert.deepEqual(res[0].proof.failedTests, ['greets with hello']);
    assert.match(res[0].proof.output, /hello Bo/);
    assert.equal(existsSync(join(dir, confirmed)), true, 'confirmed proof stays as a regression test');
    assert.equal(existsSync(join(dir, refuted)), false);
    assert.equal(existsSync(join(dir, broken)), false);

    // The kept file now passes once the code is fixed; the harness confirms by re-running it.
    assert.equal((await rerunProof(confirmed, PROFILE, io.run)).fixed, false);
    writeFileSync(join(dir, 'src/greet.ts'), "export function greet(name: string): string { return 'hello ' + name; }\n");
    assert.equal((await rerunProof(confirmed, PROFILE, io.run)).fixed, true);

    // A second attempt at the same path must not clobber it.
    const again = await verifyProofs({ issues: [issues[0]], files: [files[0]], profile: PROFILE, io });
    assert.equal(again[0].proof.status, 'unproven');
    assert.match(again[0].proof.reason, /already exists/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('proof pipeline survives awkward file content (quotes, backticks, $, unicode)', { skip }, async () => {
  const dir = makeRepo();
  try {
    const io = makeProofIO(exec, dir, PROFILE);
    const path = 'src/odd.cpm-proof.test.ts';
    const content = "import test from 'node:test'; import assert from 'node:assert/strict';\ntest('rejects @$€¥ `${x}` \\'quoted\\' \"dq\"', () => { assert.equal(1, 2); });\n";
    const [r] = await verifyProofs({ issues: [{ text: 'd', proofPath: path }], files: [{ path, content }], profile: PROFILE, io });
    assert.equal(r.proof.status, 'confirmed');
    assert.equal(readFileSync(join(dir, path), 'utf8'), content);
    assert.match(r.proof.failedTests[0], /@\$€¥/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verification: lists the change\'s tests, compares them with the original code, runs the suite, cleans up', { skip }, async () => {
  const dir = makeRepo();
  try {
    // The task changes greet() and adds a test for the new behaviour and one that proves nothing new.
    writeFileSync(join(dir, 'src/greet.ts'), "export function greet(name: string): string { return 'hello ' + name; }\n");
    writeFileSync(join(dir, 'src/greet.test.ts'),
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { greet } from './greet.ts';\n" +
      "test('greets people with hello', () => { assert.equal(greet('Bo'), 'hello Bo'); });\n" +
      "test('includes the name', () => { assert.ok(greet('Bo').includes('Bo')); });\n");
    const before = git(dir, 'status', '--porcelain');
    const scratchBefore = readdirSync(tmpdir()).filter(f => f.startsWith('tmp.'));

    const v = await buildVerification({ profile: { ...PROFILE, suite: '"src/**/*.test.ts"' }, io: makeVerificationIO(exec, dir, { ...PROFILE, suite: '"src/**/*.test.ts"' }) });

    assert.deepEqual(v.problems, []);
    const byName = Object.fromEntries(v.tests.map(t => [t.name, t]));
    assert.equal(byName['greets people with hello'].outcome, 'passed');
    assert.equal(byName['greets people with hello'].baseline, 'fails');
    assert.equal(byName['includes the name'].baseline, 'passes');
    assert.equal(v.baselineChecked, true);
    assert.deepEqual([v.suite?.passed, v.suite?.failed, v.suite?.error], [2, 0, undefined]);

    assert.equal(git(dir, 'status', '--porcelain'), before, 'the worktree is untouched');
    assert.deepEqual(readdirSync(tmpdir()).filter(f => f.startsWith('tmp.')), scratchBefore, 'no scratch directory is left behind');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verification: a test that imports a module the change adds is "new_code" before it, not "not_runnable"', { skip }, async () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, 'src/farewell.ts'), "export const bye = () => 'bye';\n");
    writeFileSync(join(dir, 'src/farewell.test.ts'),
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { bye } from './farewell.ts';\ntest('says bye', () => { assert.equal(bye(), 'bye'); });\n");
    const v = await buildVerification({ profile: PROFILE, io: makeVerificationIO(exec, dir, PROFILE) });
    assert.equal(v.tests[0].outcome, 'passed');
    assert.equal(v.tests[0].baseline, 'new_code');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verification: a test that imports a missing third-party package stays "not_runnable" before the change', { skip }, async () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, 'src/farewell.ts'), "export const bye = () => 'bye';\n");
    writeFileSync(join(dir, 'src/farewell.test.ts'),
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { nope } from 'not-a-real-package-xyz';\ntest('says bye', () => { assert.equal(nope, 1); });\n");
    const v = await buildVerification({ profile: PROFILE, io: makeVerificationIO(exec, dir, PROFILE) });
    assert.equal(v.tests.length, 0, 'it cannot load now either');
    const io = makeVerificationIO(exec, dir, PROFILE);
    const base = await io.prepareBaseline(['src/farewell.test.ts']);
    try {
      const report = parseRunOutput('node-test', await io.runIn(base!.dir, ['src/farewell.test.ts']));
      assert.ok(report.suiteError);
      assert.ok(!report.unresolved?.some(u => u.startsWith('.')), 'a package name is not a relative import');
    } finally { await io.cleanupBaseline(base!.dir); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verification: a failing test in the change is reported as failing', { skip }, async () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, 'src/bad.test.ts'),
      "import test from 'node:test'; import assert from 'node:assert/strict';\ntest('is broken', () => { assert.equal(1, 2); });\n");
    const v = await buildVerification({ profile: PROFILE, io: makeVerificationIO(exec, dir, PROFILE) });
    assert.equal(v.tests[0].outcome, 'failed');
    assert.match(v.tests[0].message ?? '', /1 !== 2|strictly equal/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verification: with no main/master branch the baseline is skipped honestly', { skip }, async () => {
  const dir = makeRepo();
  try {
    git(dir, 'branch', '-m', 'trunk');
    writeFileSync(join(dir, 'src/x.test.ts'), "import test from 'node:test';\ntest('t', () => {});\n");
    const v = await buildVerification({ profile: PROFILE, io: makeVerificationIO(exec, dir, PROFILE) });
    assert.equal(v.baselineChecked, false);
    assert.equal(v.tests[0].baseline, undefined);
    assert.match(v.notes.join(' '), /base commit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isScratchDir only accepts mktemp-shaped directories', () => {
  assert.equal(isScratchDir('/tmp/tmp.AbC123'), true);
  for (const bad of ['/', '/tmp', '/home/coder', '/tmp/../etc', '/tmp/tmp.x/../..', 'relative/tmp/x']) assert.equal(isScratchDir(bad), false, bad);
});

test('end to end: a realistic reviewer reply is parsed, its proofs are run, and only the confirmed one blocks', { skip }, async () => {
  const dir = makeRepo();
  try {
    // Shaped like a real reply: prose, markdown emphasis, fenced tests, then the verdict line.
    const reply = [
      "I read the diff and `src/greet.ts`. Two things stand out.",
      "",
      "**1. greet() ignores the required greeting.** The task says: \"greet people with hello\".",
      "",
      "PROOF_FILE: src/greet.hello.cpm-proof.test.ts",
      "```ts",
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { greet } from './greet.ts';",
      "",
      "test('greets people with hello', () => {",
      "  assert.equal(greet('Bo'), 'hello Bo');",
      "});",
      "```",
      "",
      "**2. greet() may drop the name.** I suspect it does, but let me check with a test.",
      "",
      "**PROOF_FILE:** `src/greet.name.cpm-proof.test.ts`",
      "",
      "```ts",
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { greet } from './greet.ts';",
      "test('keeps the name', () => { assert.ok(greet('Bo').includes('Bo')); });",
      "```",
      "",
      "Overall: one real defect.",
      "",
      'REVIEW_DECISION: {"outcome":"fail","summary":"greet() does not say hello","findings":[' +
        '{"defect":"greet() says \\"hi\\" instead of \\"hello\\"","requirement":"Task: greet people with hello","proof":"src/greet.hello.cpm-proof.test.ts"},' +
        '{"defect":"greet() may drop the name","requirement":"Task: greet people by name","proof":"src/greet.name.cpm-proof.test.ts"},' +
        '{"defect":"error handling is thin","requirement":"n/a"}]}',
    ].join('\n');

    const decision = parseReviewDecision(reply)!;
    const verified = await verifyProofs({
      issues: decision.issues!, files: extractProofFiles(reply), profile: PROFILE, io: makeProofIO(exec, dir, PROFILE),
    });
    const routed = routeReview('proof', decision, verified);

    assert.equal(routed.outcome, 'fail');
    assert.deepEqual(routed.blocking.map(v => v.issue.text), ['greet() says "hi" instead of "hello"']);
    assert.deepEqual(routed.refuted.map(v => v.issue.text), ['greet() may drop the name']);
    assert.deepEqual(routed.advisory.map(v => v.issue.text), ['error handling is thin']);
    assert.equal(routed.blocking[0].issue.requirement, 'Task: greet people with hello');
    assert.deepEqual(readdirSync(join(dir, 'src')).filter(f => f.includes('cpm-proof')), ['greet.hello.cpm-proof.test.ts']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- "everything already committed" -------------------------------------------
// Regression: with auto_review on, two production tasks got NO reviewer turn
// because the implementer had committed all its work and `git status --porcelain`
// was therefore empty. Change detection must be relative to the merge-base.

/** A repo on a task branch whose work is fully committed: the worktree is clean. */
function makeCommittedTaskRepo(): string {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'task/committed');
  writeFileSync(join(dir, 'src/greet.ts'), "export function greet(name: string): string { return 'hello ' + name; }\n");
  writeFileSync(join(dir, 'src/greet.test.ts'),
    "import test from 'node:test'; import assert from 'node:assert/strict'; import { greet } from './greet.ts';\n" +
    "test('greets people with hello', () => { assert.equal(greet('Bo'), 'hello Bo'); });\n");
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'implement');
  return dir;
}

test('committed work: the old porcelain check sees a clean tree, the branch check sees the work', { skip }, async () => {
  const dir = makeCommittedTaskRepo();
  try {
    assert.equal(git(dir, 'status', '--porcelain').trim(), '', 'precondition: this is exactly what fooled the old check');
    assert.equal(await hasBranchChanges(exec, dir), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('change detection: uncommitted-only, untracked-only, and no work at all', { skip }, async () => {
  const dir = makeRepo();
  try {
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'ignore file'); // main now includes .gitignore
    git(dir, 'checkout', '-q', '-b', 'task/x');
    assert.equal(await hasBranchChanges(exec, dir), false, 'a branch identical to main has no work');
    writeFileSync(join(dir, 'src/new.ts'), 'export {};\n');
    assert.equal(await hasBranchChanges(exec, dir), true, 'untracked file');
    git(dir, 'add', '-A');
    assert.equal(await hasBranchChanges(exec, dir), true, 'staged file');
    git(dir, 'commit', '-q', '-m', 'c');
    assert.equal(await hasBranchChanges(exec, dir), true, 'committed file');
    writeFileSync(join(dir, 'src/greet.ts'), '// edit\n');
    assert.equal(await hasBranchChanges(exec, dir), true, 'committed plus a later uncommitted edit');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('change detection: a workspace that cannot be asked is an error, never "no changes"', async () => {
  await assert.rejects(hasBranchChanges(async () => { throw new Error('ssh: connection refused'); }, '/wt'), /connection refused/);
  await assert.rejects(hasBranchChanges(async () => 'some unrelated output', '/wt'), /could not determine/);
});

test('committed work: the reviewer is shown the committed diff and untracked files', { skip }, async () => {
  const dir = makeCommittedTaskRepo();
  try {
    writeFileSync(join(dir, 'src/scratch.ts'), 'export {};\n');
    const diff = await getReviewDiff(exec, dir);
    assert.match(diff, /\+export function greet\(name: string\): string \{ return 'hello ' \+ name; \}/);
    assert.match(diff, /-export function greet/, 'shows what the committed change replaced');
    assert.match(diff, /Untracked files:\nsrc\/scratch\.ts/);
    assert.doesNotMatch(diff, /no diff output/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a real repo: a tiny diff budget records the committed and untracked files it left out, relative to the merge-base', { skip }, async () => {
  const dir = makeCommittedTaskRepo();
  try {
    writeFileSync(join(dir, 'src/scratch.ts'), 'export {};\n');
    const info = await getReviewDiffInfo(exec, dir, 700);
    assert.ok(info.changed.includes('src/greet.ts') && info.changed.includes('src/scratch.ts'), info.changed.join(','));
    assert.ok(info.omitted.some(o => o.path === 'src/scratch.ts' && /untracked/.test(o.reason)));
    const full = await getReviewDiffInfo(exec, dir, 32_000);
    assert.deepEqual(full.omitted.map(o => o.path), ['src/scratch.ts'], 'only the untracked file lacks a diff when everything fits');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('committed work: verification still finds the change\'s tests and compares them with the original code', { skip }, async () => {
  const dir = makeCommittedTaskRepo();
  try {
    const v = await buildVerification({ profile: PROFILE, io: makeVerificationIO(exec, dir, PROFILE) });
    assert.deepEqual(v.tests.map(t => [t.name, t.file, t.outcome, t.baseline]), [['greets people with hello', 'src/greet.test.ts', 'passed', 'fails']]);
    assert.equal(v.baselineChecked, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('committed work: deleted files are not reported as changed tests', { skip }, async () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, 'src/old.test.ts'), "import test from 'node:test';\ntest('old', () => {});\n");
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'add old test on main');
    git(dir, 'checkout', '-q', '-b', 'task/del');
    rmSync(join(dir, 'src/old.test.ts'));
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'delete it');
    const v = await buildVerification({ profile: PROFILE, io: makeVerificationIO(exec, dir, PROFILE) });
    assert.deepEqual(v.tests, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a new module and its test: the original-code run cannot load, and is labelled new_code (real git + real node:test)', { skip }, async () => {
  const dir = makeRepo();
  try {
    git(dir, 'checkout', '-q', '-b', 'task/newmod');
    writeFileSync(join(dir, 'src/dur.ts'), 'export const parse = (s: string) => s.length;\n');
    writeFileSync(join(dir, 'src/dur.test.ts'),
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { parse } from './dur.ts';\n" +
      "test('parses a duration', () => { assert.equal(parse('1s'), 2); });\n");
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'add module');
    writeFileSync(join(dir, 'src/untracked.ts'), 'export {};\n');
    const io = makeVerificationIO(exec, dir, PROFILE);
    assert.deepEqual((await io.addedPaths()).filter(p => p !== '.gitignore').sort(), ['src/dur.test.ts', 'src/dur.ts', 'src/untracked.ts']);
    const v = await buildVerification({ profile: PROFILE, io });
    assert.deepEqual(v.tests.map(t => [t.name, t.outcome, t.baseline]), [['parses a duration', 'passed', 'new_code']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A task that adds `shout` to src/greet.ts (which exists at the merge-base with only `greet`).
const SHOUT_TEST =
  "import test from 'node:test'; import assert from 'node:assert/strict'; import { greet, shout } from './greet.ts';\n" +
  "test('still greets', () => { assert.equal(greet('Bo'), 'hi Bo'); });\n" +
  "test('shouts the greeting', () => { assert.equal(shout('Bo'), 'HI BO'); });\n";
const GREET_WITH_SHOUT =
  "export function greet(name: string): string { return 'hi ' + name; }\n" +
  "export function shout(name: string): string { return greet(name).toUpperCase(); }\n";

test('a function added to an existing module, tsx in CommonJS mode: only its test is new_code, the old one still "passes" (real git + real node:test)', { skip }, async () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, 'src/greet.ts'), GREET_WITH_SHOUT);
    writeFileSync(join(dir, 'src/greet.test.ts'), SHOUT_TEST);
    const io = makeVerificationIO(exec, dir, PROFILE);
    const now = await io.currentSources(['src/greet.ts', 'src/nope.ts']);
    assert.equal(now['src/greet.ts']?.replace(/\r\n/g, '\n'), GREET_WITH_SHOUT, 'read from the worktree (PTY line endings aside)');
    assert.equal(now['src/nope.ts'], null);
    const v = await buildVerification({ profile: PROFILE, io });
    assert.deepEqual(v.tests.map(t => [t.name, t.outcome, t.baseline]).sort(),
      [['shouts the greeting', 'passed', 'new_code'], ['still greets', 'passed', 'passes']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a function added to an existing module, native ESM ("type": "module"): the file cannot load on the base and is new_code (real git + real node:test)', { skip }, async () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'esm');
    writeFileSync(join(dir, 'src/greet.ts'), GREET_WITH_SHOUT);
    writeFileSync(join(dir, 'src/greet.test.ts'), SHOUT_TEST);
    const v = await buildVerification({ profile: PROFILE, io: makeVerificationIO(exec, dir, PROFILE) });
    assert.deepEqual(v.tests.map(t => [t.name, t.outcome, t.baseline]).sort(),
      [['shouts the greeting', 'passed', 'new_code'], ['still greets', 'passed', 'new_code']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a renamed export stays "not_runnable" on the base, in CommonJS and native ESM alike (real git + real node:test)', { skip }, async () => {
  for (const esm of [false, true]) {
    const dir = makeRepo();
    try {
      // The base has greet() and yell(); the task renames yell to shout.
      writeFileSync(join(dir, 'src/greet.ts'), "export function greet(name: string): string { return 'hi ' + name; }\nexport function yell(name: string): string { return greet(name).toUpperCase(); }\n");
      if (esm) writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
      git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base with yell');
      writeFileSync(join(dir, 'src/greet.ts'), GREET_WITH_SHOUT);
      writeFileSync(join(dir, 'src/greet.test.ts'), SHOUT_TEST);
      const v = await buildVerification({ profile: PROFILE, io: makeVerificationIO(exec, dir, PROFILE) });
      const shout = v.tests.find(t => t.name === 'shouts the greeting')!;
      assert.equal(shout.outcome, 'passed');
      assert.equal(shout.baseline, 'not_runnable', esm ? 'esm' : 'cjs');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a modified module: addedPaths excludes it and the test keeps its assertion-level "fails" baseline', { skip }, async () => {
  const dir = makeCommittedTaskRepo();
  try {
    const io = makeVerificationIO(exec, dir, PROFILE);
    assert.deepEqual((await io.addedPaths()).filter(p => p !== '.gitignore'), ['src/greet.test.ts'], 'src/greet.ts was modified, not added');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- fingerprint --------------------------------------------------------------

test('fingerprint: stable for an unchanged tree, different once anything changes — committed or not', { skip }, async () => {
  const dir = makeCommittedTaskRepo();
  try {
    const io = makeVerificationIO(exec, dir, PROFILE);
    const a = await io.fingerprint();
    assert.match(a, /^[0-9a-f]{40}$/);
    assert.equal(await io.fingerprint(), a, 'unchanged tree → same fingerprint');
    writeFileSync(join(dir, 'src/untracked.ts'), 'export const a = 1;\n');
    const b = await io.fingerprint();
    assert.notEqual(b, a, 'a new untracked file changes it');
    writeFileSync(join(dir, 'src/untracked.ts'), 'export const a = 2;\n');
    assert.notEqual(await io.fingerprint(), b, 'editing an untracked file changes it');
    rmSync(join(dir, 'src/untracked.ts'));
    assert.equal(await io.fingerprint(), a, 'back to the original state → original fingerprint');
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'another commit');
    assert.notEqual(await io.fingerprint(), a, 'a new commit changes it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- a hung test cannot hold anything -----------------------------------------

test('a hung test is killed at the timeout, reported as timed out (not confirmed), and leaves no process behind', { skip }, async () => {
  const dir = makeRepo();
  const marker = `hang${process.pid}${Date.now()}`;
  try {
    // A test whose body never yields and which spawns a child that also never exits.
    writeFileSync(join(dir, `src/${marker}.test.ts`),
      "import test from 'node:test';\nimport { spawn } from 'node:child_process';\n" +
      `test('hangs forever', async () => { spawn('sleep', ['300', '${marker}'], { stdio: 'ignore' }); await new Promise(() => setInterval(() => {}, 1000)); });\n`);
    const started = Date.now();
    const script = buildRunCommand(PROFILE, dir, [`src/${marker}.test.ts`], { timeoutSec: 3 });
    const raw = await exec(script, 30_000);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 15_000, `returned in ${elapsed}ms — the timeout bounded it`);
    const report = parseRunOutput('node-test', raw);
    assert.equal(report.timedOut, true);
    assert.equal(classifyRun(report).status, 'unproven', 'a timeout must never read as a confirmed defect');

    await new Promise(r => setTimeout(r, 500));
    // `[h]ang…` keeps pgrep from matching its own command line (which contains the pattern).
    const pattern = `[${marker[0]}]${marker.slice(1)}`;
    const leftover = await exec(`ps -eo pid,args | grep -- ${pattern} | grep -v grep || true`);
    assert.equal(leftover.trim(), '', `neither the test process nor its child survives:\n${leftover}`);
  } finally {
    await exec(`pkill -f -- '[${marker[0]}]${marker.slice(1)}' || true`).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

