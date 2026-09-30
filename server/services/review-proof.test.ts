import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignRepairFiles,
  classifyRun,
  isTestAuthoringError,
  opinionIssues,
  rerunProof,
  repairable,
  routeReview,
  tally,
  validateProofPath,
  verifyProofs,
  type ProofIO,
} from './review-proof.js';
import type { ReviewDecision, ReviewIssue } from './review-verdict.js';
import { RESULT_MARKER, type RunReport, type TestProfile } from './test-runners.js';

const profile: TestProfile = { runner: 'node-test', command: 'node --import tsx --test', source: 'detected' };
const P = 'src/x.cpm-proof.test.ts';

const tap = (lines: string) => `${RESULT_MARKER} exit=1\nTAP version 13\n${lines}`;
const TAP_FAIL = tap("not ok 1 - t\n  ---\n  type: 'test'\n  error: |-\n    boom\n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  ...\n");
const TAP_PASS = tap("ok 1 - t\n  ---\n  type: 'test'\n  ...\n");
const TAP_LOADFAIL = tap("# Error: Cannot find module './nope'\n# Subtest: x.test.ts\nnot ok 1 - x.test.ts\n  ---\n  type: 'test'\n  exitCode: 1\n  error: 'test failed'\n  ...\n");

function fakeIO(runOutput: string | ((f: string[]) => string | Promise<string>), existing: string[] = []) {
  const files = new Map<string, string>(existing.map(p => [p, 'ORIGINAL']));
  const log: string[] = [];
  const io: ProofIO = {
    exists: async p => files.has(p),
    write: async (p, c) => { log.push(`write ${p}`); files.set(p, c); },
    remove: async p => { log.push(`remove ${p}`); files.delete(p); },
    run: async f => { log.push(`run ${f.join(',')}`); return typeof runOutput === 'function' ? runOutput(f) : runOutput; },
  };
  return { io, files, log };
}

const issue = (over: Partial<ReviewIssue> = {}): ReviewIssue => ({ text: 'defect', requirement: 'req', proofPath: P, ...over });

// --- classification ----------------------------------------------------------

const report = (r: Partial<RunReport>): RunReport => ({ cases: [], ...r });

test('classifyRun: a failing test with a genuine failure is confirmed', () => {
  const r = classifyRun(report({ cases: [{ name: 'a', outcome: 'failed', message: 'AssertionError: expected 1 to be 2' }] }));
  assert.equal(r.status, 'confirmed');
  assert.deepEqual(r.failedTests, ['a']);
});

test('classifyRun: the code under test crashing is confirmed, not mistaken for a broken test', () => {
  assert.equal(classifyRun(report({ cases: [{ name: 'a', outcome: 'failed', message: "TypeError: Cannot read properties of undefined (reading 'foo')" }] })).status, 'confirmed');
  assert.equal(classifyRun(report({ cases: [{ name: 'a', outcome: 'failed', message: "AttributeError: 'NoneType' object has no attribute 'foo'" }] })).status, 'confirmed');
});

test('classifyRun: a failure caused by the test itself is unproven and repairable', () => {
  for (const message of [
    'ReferenceError: helper is not defined', "TypeError: parseRow is not a function", 'ModuleNotFoundError: No module named x',
    "AttributeError: module 'app' has no attribute 'nope'", 'error CS0103: The name x does not exist', 'FAIL p [build failed]',
  ]) {
    const r = classifyRun(report({ cases: [{ name: 'a', outcome: 'failed', message }] }));
    assert.equal(r.status, 'unproven', message);
    assert.equal(r.repairable, true, message);
  }
});

test('classifyRun: passing → refuted', () => {
  const r = classifyRun(report({ cases: [{ name: 'a', outcome: 'passed' }] }));
  assert.equal(r.status, 'refuted');
  assert.equal(r.passedTests, 1);
});

test('classifyRun: passing plus a genuine failure is still confirmed; passing plus a broken test is not', () => {
  const pass = { name: 'p', outcome: 'passed' as const };
  assert.equal(classifyRun(report({ cases: [pass, { name: 'f', outcome: 'failed', message: 'AssertionError' }] })).status, 'confirmed');
  assert.equal(classifyRun(report({ cases: [pass, { name: 'f', outcome: 'failed', message: 'SyntaxError' }] })).status, 'unproven');
});

test('classifyRun: suite error, no tests, all skipped, and timeout are all unproven', () => {
  assert.deepEqual(
    [report({ suiteError: 'boom' }), report({}), report({ cases: [{ name: 's', outcome: 'skipped' }] }), report({ timedOut: true, suiteError: 'x' })]
      .map(r => { const c = classifyRun(r); return [c.status, c.repairable]; }),
    [['unproven', true], ['unproven', true], ['unproven', false], ['unproven', false]]);
});

test('isTestAuthoringError has no false positive on ordinary assertion text', () => {
  assert.equal(isTestAuthoringError('expected 3 to equal 4'), false);
  assert.equal(isTestAuthoringError(undefined), false);
});

// --- path validation ---------------------------------------------------------

test('validateProofPath accepts a well-formed proof path', () => {
  assert.equal(validateProofPath(P, profile), null);
  assert.equal(validateProofPath('test_cpm_proof_1.py', { runner: 'pytest', source: 'user' }), null);
  assert.equal(validateProofPath('pkg/x_cpm_proof_test.go', { runner: 'go', source: 'user' }), null);
});

test('validateProofPath rejects traversal, absolute paths, odd characters and non-proof names', () => {
  for (const bad of ['../x.cpm-proof.test.ts', '/etc/x.cpm-proof.test.ts', 'a/../b.cpm-proof.test.ts', '-rf.cpm-proof.test.ts',
    'a b.cpm-proof.test.ts', 'a;b.cpm-proof.test.ts', '$(x).cpm-proof.test.ts', '.git/hooks/x.cpm-proof.test.ts',
    'node_modules/x.cpm-proof.test.ts', 'src/real.test.ts', 'src/x.cpm-proof.ts', '', 'a//b.cpm-proof.test.ts']) {
    assert.notEqual(validateProofPath(bad, profile), null, bad);
  }
  assert.notEqual(validateProofPath('x.cpm-proof.test.ts', { runner: 'pytest', source: 'user' }), null);
});

// --- verifyProofs ------------------------------------------------------------

test('verifyProofs: confirmed proof is kept on disk; refuted and unproven are removed', async () => {
  const a = 'a.cpm-proof.test.ts', b = 'b.cpm-proof.test.ts', c = 'c.cpm-proof.test.ts';
  const out: Record<string, string> = { [a]: TAP_FAIL, [b]: TAP_PASS, [c]: TAP_LOADFAIL };
  const { io, files } = fakeIO(f => out[f[0]]);
  const res = await verifyProofs({
    issues: [issue({ proofPath: a }), issue({ proofPath: b }), issue({ proofPath: c })],
    files: [a, b, c].map(path => ({ path, content: 'X' })),
    profile, io,
  });
  assert.deepEqual(res.map(r => r.proof.status), ['confirmed', 'refuted', 'unproven']);
  assert.deepEqual([...files.keys()], [a]);
  assert.equal(res[2].proof.repairable, true);
});

test('verifyProofs: never overwrites an existing file', async () => {
  const { io, files, log } = fakeIO(TAP_FAIL, [P]);
  const [r] = await verifyProofs({ issues: [issue()], files: [{ path: P, content: 'X' }], profile, io });
  assert.equal(r.proof.status, 'unproven');
  assert.equal(files.get(P), 'ORIGINAL');
  assert.deepEqual(log, []);
});

test('verifyProofs: a bad path is rejected without touching the filesystem', async () => {
  const { io, log } = fakeIO(TAP_FAIL);
  const [r] = await verifyProofs({ issues: [issue({ proofPath: '../evil.cpm-proof.test.ts' })], files: [{ path: '../evil.cpm-proof.test.ts', content: 'X' }], profile, io });
  assert.equal(r.proof.status, 'unproven');
  assert.deepEqual(log, []);
});

test('verifyProofs: findings with no test, or whose block is missing, are unproven', async () => {
  const { io } = fakeIO(TAP_FAIL);
  const res = await verifyProofs({ issues: [issue({ proofPath: undefined }), issue({ proofPath: 'gone.cpm-proof.test.ts' })], files: [], profile, io });
  assert.deepEqual(res.map(r => [r.proof.status, r.proof.repairable]), [['unproven', false], ['unproven', true]]);
});

test('verifyProofs: an infrastructure failure is unproven and still cleans up', async () => {
  const { io, files } = fakeIO(() => { throw new Error('ssh: connection lost'); });
  const [r] = await verifyProofs({ issues: [issue()], files: [{ path: P, content: 'X' }], profile, io });
  assert.equal(r.proof.status, 'unproven');
  assert.match(r.proof.reason, /connection lost/);
  assert.equal(files.size, 0);
});

test('verifyProofs: oversized files and proofs over the cap are not run', async () => {
  const { io, log } = fakeIO(TAP_FAIL);
  const big = await verifyProofs({ issues: [issue()], files: [{ path: P, content: 'x'.repeat(70_000) }], profile, io });
  assert.equal(big[0].proof.status, 'unproven');
  assert.deepEqual(log, []);

  const paths = ['1', '2', '3'].map(n => `${n}.cpm-proof.test.ts`);
  const capped = await verifyProofs({
    issues: paths.map(p => issue({ proofPath: p })), files: paths.map(path => ({ path, content: 'X' })), profile, io, maxProofs: 2,
  });
  assert.deepEqual(capped.map(r => r.proof.status), ['confirmed', 'confirmed', 'unproven']);
});

test('verifyProofs: two findings sharing one test file run it once', async () => {
  const { io, log } = fakeIO(TAP_FAIL);
  const res = await verifyProofs({ issues: [issue(), issue({ text: 'other' })], files: [{ path: P, content: 'X' }], profile, io });
  assert.deepEqual(res.map(r => r.proof.status), ['confirmed', 'confirmed']);
  assert.equal(log.filter(l => l.startsWith('run')).length, 1);
});

// --- routing -----------------------------------------------------------------

const decision = (outcome: 'pass' | 'fail'): ReviewDecision => ({ outcome, summary: 's' });
const v = (status: 'confirmed' | 'refuted' | 'unproven') => ({
  issue: issue(),
  proof: { status, reason: '', failedTests: [], passedTests: 0, output: '', repairable: false },
});

test('routeReview (proof): fails only when a finding is confirmed', () => {
  assert.equal(routeReview('proof', decision('fail'), [v('confirmed'), v('refuted')]).outcome, 'fail');
  assert.equal(routeReview('proof', decision('fail'), [v('refuted'), v('unproven')]).outcome, 'pass');
  assert.equal(routeReview('proof', decision('fail'), []).outcome, 'pass');
});

test('routeReview (proof): a pass verdict that carries a confirmed finding still fails', () => {
  assert.equal(routeReview('proof', decision('pass'), [v('confirmed')]).outcome, 'fail');
});

test('routeReview (proof): buckets findings by status', () => {
  const r = routeReview('proof', decision('fail'), [v('confirmed'), v('refuted'), v('unproven'), v('unproven')]);
  assert.deepEqual([r.blocking.length, r.refuted.length, r.advisory.length], [1, 1, 2]);
  assert.equal(tally(r), '1 confirmed, 1 refuted, 2 unproven');
});

test('routeReview (opinion): the reviewer\'s word stands and everything blocks', () => {
  const d: ReviewDecision = { outcome: 'fail', summary: 's', issues: [{ text: 'a' }, { text: 'b' }] };
  const r = routeReview('opinion', d, opinionIssues(d));
  assert.equal(r.outcome, 'fail');
  assert.equal(r.blocking.length, 2);
  assert.equal(r.advisory.length, 0);
  assert.equal(routeReview('opinion', decision('pass'), []).outcome, 'pass');
});

// --- repair ------------------------------------------------------------------

test('repairable() selects only unproven findings whose test was broken', () => {
  const broken = { ...v('unproven'), proof: { ...v('unproven').proof, repairable: true } };
  assert.equal(repairable([v('confirmed'), v('unproven'), broken]).length, 1);
});

test('assignRepairFiles matches by original path and hands new paths to the leftovers in order', () => {
  const issues = [issue({ proofPath: 'a.cpm-proof.test.ts' }), issue({ proofPath: 'bad path' }), issue({ proofPath: undefined })];
  const files = [{ path: 'a.cpm-proof.test.ts', content: '1' }, { path: 'n1.cpm-proof.test.ts', content: '2' }, { path: 'n2.cpm-proof.test.ts', content: '3' }];
  const r = assignRepairFiles(issues, files);
  assert.deepEqual(r.issues.map(i => i.proofPath), ['a.cpm-proof.test.ts', 'n1.cpm-proof.test.ts', 'n2.cpm-proof.test.ts']);
});

// --- re-running a confirmed proof after the fix ------------------------------

test('rerunProof: passing means fixed; failing, broken, or unrunnable does not', async () => {
  assert.equal((await rerunProof(P, profile, async () => TAP_PASS)).fixed, true);
  assert.equal((await rerunProof(P, profile, async () => TAP_FAIL)).fixed, false);
  assert.equal((await rerunProof(P, profile, async () => TAP_LOADFAIL)).fixed, false);
  assert.equal((await rerunProof(P, profile, async () => { throw new Error('down'); })).fixed, false);
});

test('verifyProofs: once the deadline has passed no further test is started', async () => {
  const { io, log } = fakeIO(TAP_FAIL);
  const paths = ['1', '2'].map(n => `${n}.cpm-proof.test.ts`);
  const res = await verifyProofs({
    issues: paths.map(p => issue({ proofPath: p })), files: paths.map(path => ({ path, content: 'X' })),
    profile, io, deadline: Date.now() - 1,
  });
  assert.deepEqual(res.map(r => [r.proof.status, r.proof.repairable]), [['unproven', false], ['unproven', false]]);
  assert.match(res[0].proof.reason, /time budget/);
  assert.deepEqual(log, []);
});

test('verifyProofs: a deadline that expires mid-way keeps the results already earned', async () => {
  let n = 0;
  const { io } = fakeIO(() => { n++; return TAP_FAIL; });
  const paths = ['1', '2', '3'].map(x => `${x}.cpm-proof.test.ts`);
  const res = await verifyProofs({
    issues: paths.map(p => issue({ proofPath: p })), files: paths.map(path => ({ path, content: 'X' })),
    profile, io, deadline: Date.now() + 60_000,
  });
  assert.deepEqual(res.map(r => r.proof.status), ['confirmed', 'confirmed', 'confirmed']);
  assert.equal(n, 3);
});

