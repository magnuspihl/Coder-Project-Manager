import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerification, classifyBaseline, isTestFile, parseNameList, summariseVerification, withBudget, type VerificationIO } from './verification.js';
import { RESULT_MARKER, type TestProfile } from './test-runners.js';

const profile: TestProfile = { runner: 'node-test', source: 'detected' };

const okTap = (...names: string[]) =>
  `${RESULT_MARKER} exit=0\nTAP version 13\n` + names.map((n, i) => `ok ${i + 1} - ${n}\n  ---\n  type: 'test'\n  ...\n`).join('');
const failTap = (name: string, error = 'boom') =>
  `${RESULT_MARKER} exit=1\nTAP version 13\nnot ok 1 - ${name}\n  ---\n  type: 'test'\n  error: '${error}'\n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  ...\n`;
const loadFailTap = `${RESULT_MARKER} exit=1\n# Error: Cannot find module './new'\n# Subtest: a.test.ts\nnot ok 1 - a.test.ts\n  ---\n  type: 'test'\n  exitCode: 1\n  error: 'test failed'\n  ...\n`;

function fakeIO(o: Partial<VerificationIO> & { changed?: string[] } = {}): VerificationIO & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fingerprint: o.fingerprint ?? (async () => 'f'.repeat(40)),
    changedPaths: o.changedPaths ?? (async () => o.changed ?? []),
    run: o.run ?? (async f => { calls.push(`run ${f}`); return okTap('does a thing'); }),
    runSuite: o.runSuite ?? (async () => { calls.push('suite'); return okTap('a', 'b', 'c'); }),
    prepareBaseline: o.prepareBaseline ?? (async () => { calls.push('prepareBaseline'); return { dir: '/base' }; }),
    runIn: o.runIn ?? (async () => failTap('does a thing')),
    cleanupBaseline: o.cleanupBaseline ?? (async d => { calls.push(`cleanup ${d}`); }),
  };
}

test('parseNameList: one path per line, deduplicated, blanks and CRLF tolerated', () => {
  assert.deepEqual(parseNameList('src/a.ts\r\n\nsrc/a.test.ts\nsrc/a.ts\n  sp ace.ts \n'), ['src/a.ts', 'src/a.test.ts', 'sp ace.ts']);
  assert.deepEqual(parseNameList(''), []);
});

test('isTestFile follows the runner and ignores node_modules', () => {
  assert.equal(isTestFile('src/a.test.ts', profile), true);
  assert.equal(isTestFile('src/a.ts', profile), false);
  assert.equal(isTestFile('node_modules/x/a.test.js', profile), false);
  assert.equal(isTestFile('tests/test_a.py', { runner: 'pytest', source: 'user' }), true);
  assert.equal(isTestFile('pkg/a_test.go', { runner: 'go', source: 'user' }), true);
});

test('classifyBaseline: fails / passes / not_runnable', () => {
  const cur = [{ name: 'a', outcome: 'passed' as const }, { name: 'b', outcome: 'passed' as const }, { name: 'c', outcome: 'passed' as const }];
  const base = {
    cases: [
      { name: 'a', outcome: 'failed' as const, message: 'AssertionError: expected 1' },
      { name: 'b', outcome: 'passed' as const },
      { name: 'c', outcome: 'failed' as const, message: 'ReferenceError: x is not defined' },
    ],
  };
  const r = classifyBaseline(cur, base);
  assert.deepEqual([r.get('a'), r.get('b'), r.get('c')], ['fails', 'passes', 'not_runnable']);
});

test('classifyBaseline: a base run that could not run is not_runnable, never "fails"', () => {
  const cur = [{ name: 'a', outcome: 'passed' as const }];
  assert.equal(classifyBaseline(cur, { cases: [], suiteError: 'Cannot find module' }).get('a'), 'not_runnable');
  assert.equal(classifyBaseline(cur, { cases: [], timedOut: true }).get('a'), 'not_runnable');
  assert.equal(classifyBaseline(cur, { cases: [] }).get('a'), 'not_runnable');
});

test('buildVerification: lists the tests that ran, marks fail-before, runs the suite', async () => {
  const io = fakeIO({ changed: ['src/a.ts', 'src/a.test.ts'] });
  const v = await buildVerification({ profile, io });
  assert.deepEqual(v.tests.map(t => [t.name, t.file, t.outcome, t.baseline, t.origin]), [['does a thing', 'src/a.test.ts', 'passed', 'fails', 'implementer']]);
  assert.equal(v.baselineChecked, true);
  assert.deepEqual([v.suite?.passed, v.suite?.failed], [3, 0]);
  assert.ok(io.calls.includes('cleanup /base'));
  assert.deepEqual(summariseVerification(v), { passing: 1, failing: 0, failsWithoutChange: 1, passesWithoutChange: 0 });
});

test('buildVerification: a test that also passes on the original code is flagged as such', async () => {
  const io = fakeIO({ changed: ['a.test.ts'], runIn: async () => okTap('does a thing') });
  const v = await buildVerification({ profile, io });
  assert.equal(v.tests[0].baseline, 'passes');
  assert.equal(summariseVerification(v).passesWithoutChange, 1);
});

test('buildVerification: a test file that cannot load on the original code is not_runnable (new code), not "fails"', async () => {
  const io = fakeIO({ changed: ['a.test.ts'], runIn: async () => loadFailTap });
  assert.equal((await buildVerification({ profile, io })).tests[0].baseline, 'not_runnable');
});

test('buildVerification: reviewer proof tests are labelled by origin', async () => {
  const io = fakeIO({ changed: ['src/x.cpm-proof.test.ts', 'src/y.test.ts'] });
  const v = await buildVerification({ profile, io });
  assert.deepEqual(v.tests.map(t => t.origin), ['reviewer', 'implementer']);
});

test('buildVerification: failing tests and unrunnable files are reported, never counted as passing', async () => {
  const io = fakeIO({
    changed: ['bad.test.ts', 'load.test.ts'],
    run: async f => (String(f).startsWith('bad') ? failTap('breaks', 'expected 1') : loadFailTap),
  });
  const v = await buildVerification({ profile, io });
  assert.equal(v.tests.filter(t => t.outcome === 'failed').length, 1);
  assert.match(v.tests[0].message!, /expected 1/);
  assert.equal(v.problems.length, 1);
  assert.equal(v.problems[0].file, 'load.test.ts');
});

test('buildVerification: no runner → nothing run and a note saying so', async () => {
  const io = fakeIO({ changed: ['a.test.ts'] });
  const v = await buildVerification({ profile: null, io });
  assert.equal(v.runner, null);
  assert.deepEqual(io.calls, []);
  assert.match(v.notes[0], /No test runner/);
});

test('buildVerification: no base commit → baseline skipped with a note, results still reported', async () => {
  const io = fakeIO({ changed: ['a.test.ts'], prepareBaseline: async () => null });
  const v = await buildVerification({ profile, io });
  assert.equal(v.baselineChecked, false);
  assert.equal(v.tests[0].baseline, undefined);
  assert.match(v.notes.join(' '), /base commit/);
});

test('buildVerification: an IO failure in any stage degrades to a note and never throws', async () => {
  const io = fakeIO({
    changed: ['a.test.ts'],
    prepareBaseline: async () => { throw new Error('git archive failed'); },
    runSuite: async () => { throw new Error('ssh down'); },
  });
  const v = await buildVerification({ profile, io });
  assert.equal(v.tests.length, 1);
  assert.match(v.notes.join(' '), /git archive failed/);
  assert.match(v.suite!.error!, /ssh down/);
});

test('buildVerification: the baseline scratch copy is always cleaned up', async () => {
  const io = fakeIO({ changed: ['a.test.ts'], runIn: async () => { throw new Error('boom'); } });
  await buildVerification({ profile, io });
  assert.ok(io.calls.includes('cleanup /base'));
});

test('buildVerification: caps the test files run per turn and reports the omission', async () => {
  const changed = Array.from({ length: 11 }, (_, i) => `t${i}.test.ts`);
  const io = fakeIO({ changed });
  const v = await buildVerification({ profile, io });
  assert.equal(io.calls.filter(c => c.startsWith('run ')).length, 8);
  assert.equal(v.filesOmitted, 3);
});

test('buildVerification: suite that ran nothing or errored is not a pass', async () => {
  const empty = await buildVerification({ profile, io: fakeIO({ runSuite: async () => `${RESULT_MARKER} exit=0\nTAP version 13\n` }) });
  assert.equal(empty.suite?.error, 'No tests ran');
  const broken = await buildVerification({ profile, io: fakeIO({ runSuite: async () => loadFailTap }) });
  assert.ok(broken.suite?.error);
});

test('buildVerification carries the implementer\'s no-tests reason', async () => {
  const v = await buildVerification({ profile, io: fakeIO(), noTestsReason: 'CSS-only change' });
  assert.equal(v.noTestsReason, 'CSS-only change');
});

// --- levels, budget -----------------------------------------------------------

test('level "tests": only the change\'s own tests run — no baseline, no suite, no fingerprint', async () => {
  const io = fakeIO({ changed: ['a.test.ts'] });
  const v = await buildVerification({ profile, io, level: 'tests' });
  assert.equal(v.level, 'tests');
  assert.equal(v.tests.length, 1);
  assert.equal(v.tests[0].baseline, undefined);
  assert.equal(v.suite, undefined);
  assert.equal(v.baselineChecked, false);
  assert.equal(v.fingerprint, undefined);
  assert.deepEqual(io.calls, ['run a.test.ts']);
});

test('level "full" (the default) records a fingerprint and runs everything', async () => {
  const io = fakeIO({ changed: ['a.test.ts'] });
  const v = await buildVerification({ profile, io });
  assert.equal(v.level, 'full');
  assert.equal(v.fingerprint, 'f'.repeat(40));
  assert.ok(v.suite);
  assert.ok(io.calls.includes('prepareBaseline'));
});

test('a spent budget stops the work at the next run and says so; partial results are kept', async () => {
  let runs = 0;
  const io = fakeIO({ changed: ['a.test.ts', 'b.test.ts', 'c.test.ts'], run: async () => { runs++; return okTap('t'); } });
  const v = await buildVerification({ profile, io, shouldStop: () => runs >= 1 });
  assert.equal(runs, 1, 'no run is started once the budget is spent');
  assert.equal(v.tests.length, 1);
  assert.equal(v.suite, undefined, 'the suite is skipped rather than started');
  assert.match(v.notes.join(' '), /time budget/);
  assert.ok(!io.calls.includes('suite'));
  assert.ok(!io.calls.includes('prepareBaseline'));
});

test('a budget already spent runs nothing at all', async () => {
  const io = fakeIO({ changed: ['a.test.ts'] });
  const v = await buildVerification({ profile, io, shouldStop: () => true });
  assert.deepEqual(io.calls.filter(c => c.startsWith('run') || c === 'suite'), []);
  assert.match(v.notes.join(' '), /time budget/);
});

test('a budget that runs out during the baseline still cleans the scratch copy up', async () => {
  let stop = false;
  const io = fakeIO({
    changed: ['a.test.ts', 'b.test.ts'],
    prepareBaseline: async () => { stop = true; return { dir: '/base' }; },
  });
  await buildVerification({ profile, io, shouldStop: () => stop });
  assert.ok(io.calls.includes('cleanup /base'));
});

test('withBudget: a hung piece of work cannot hold the caller past the budget', async () => {
  const started = Date.now();
  const r = await withBudget(new Promise<never>(() => { /* never settles: a hung test process */ }), 60);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 1000);
});

test('withBudget: work that finishes in time returns its value, and its timer does not linger', async () => {
  const r = await withBudget(Promise.resolve(42), 10_000);
  assert.deepEqual(r, { timedOut: false, value: 42 });
});

test('withBudget: work that rejects still rejects (nothing is swallowed)', async () => {
  await assert.rejects(withBudget(Promise.reject(new Error('boom')), 1000), /boom/);
});

