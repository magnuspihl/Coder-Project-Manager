import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerification, classifyBaseline, isTestFile, markAddedTests, orderTests, parseNameList, reviewerTestLines, summariseVerification, testExistedAtBase, withBudget, type VerificationIO, type VerificationSummary, type VerifiedTest } from './verification.js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunOutput, RESULT_MARKER, type RunnerKind, type TestProfile } from './test-runners.js';

const profile: TestProfile = { runner: 'node-test', source: 'detected' };

const okTap = (...names: string[]) =>
  `${RESULT_MARKER} exit=0\nTAP version 13\n` + names.map((n, i) => `ok ${i + 1} - ${n}\n  ---\n  type: 'test'\n  ...\n`).join('');
const failTap = (name: string, error = 'boom') =>
  `${RESULT_MARKER} exit=1\nTAP version 13\nnot ok 1 - ${name}\n  ---\n  type: 'test'\n  error: '${error}'\n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  ...\n`;
const loadFailTap = `${RESULT_MARKER} exit=1\n# Error: Cannot find module './new'\n# Subtest: a.test.ts\nnot ok 1 - a.test.ts\n  ---\n  type: 'test'\n  exitCode: 1\n  error: 'test failed'\n  ...\n`;

function fakeIO(o: Partial<VerificationIO> & { changed?: string[]; added?: string[] } = {}): VerificationIO & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fingerprint: o.fingerprint ?? (async () => 'f'.repeat(40)),
    changedPaths: o.changedPaths ?? (async () => o.changed ?? []),
    addedPaths: o.addedPaths ?? (async () => o.added ?? []),
    baseSources: o.baseSources ?? (async () => ({})),
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
  assert.deepEqual(summariseVerification(v), { passing: 1, failing: 0, failsWithoutChange: 1, passesWithoutChange: 0, newCodeOnly: 0 });
});

test('buildVerification: a test that also passes on the original code is flagged as such', async () => {
  const io = fakeIO({ changed: ['a.test.ts'], runIn: async () => okTap('does a thing') });
  const v = await buildVerification({ profile, io });
  assert.equal(v.tests[0].baseline, 'passes');
  assert.equal(summariseVerification(v).passesWithoutChange, 1);
});

test('buildVerification: a test file that cannot load for a module the task did NOT add is not_runnable, not "fails"', async () => {
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


// --- load failures caused by code the task adds ---------------------------------
// Real runner output (captured by running each tool on a test that imports a module
// which does not exist yet) is classified against the task's added-file list.

const fxDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'test-runners');
const baseRun = (runner: RunnerKind, file: string) =>
  parseRunOutput(runner, `\n${RESULT_MARKER} exit=1\n${readFileSync(join(fxDir, file), 'utf8')}`.replace(/\n/g, '\r\n'));
const cur = (...names: string[]) => names.map(name => ({ name, outcome: 'passed' as const }));

const NEW_MODULE_CASES: Array<{ runner: RunnerKind; file: string; testFile: string; added: string[] }> = [
  { runner: 'node-test', file: 'node-newmod.tap', testFile: 'src/dur.test.ts', added: ['src/dur.ts', 'src/dur.test.ts'] },
  { runner: 'vitest', file: 'vitest-newmod.json', testFile: 'src/dur2.test.ts', added: ['src/dur2.ts', 'src/dur2.test.ts'] },
  { runner: 'jest', file: 'jest-newmod.json', testFile: 'src/dur3.test.js', added: ['src/dur3.js', 'src/dur3.test.js'] },
  { runner: 'pytest', file: 'pytest-newmod-module.xml', testFile: 'py/test_a.py', added: ['py/pkg/thing.py', 'py/test_a.py'] },
  { runner: 'pytest', file: 'pytest-newmod-name.xml', testFile: 'py/test_b.py', added: ['py/pkg/thing2.py', 'py/test_b.py'] },
];

for (const c of NEW_MODULE_CASES) {
  test(`${c.runner}: ${c.file} — a test file that cannot load only because it imports a module the task adds is labelled new_code`, () => {
    const r = classifyBaseline(cur('t'), baseRun(c.runner, c.file), { runner: c.runner, testFile: c.testFile, added: new Set(c.added) });
    assert.equal(r.get('t'), 'new_code');
  });

  test(`${c.runner}: ${c.file} — the same load failure is not_runnable when that module already existed on the base`, () => {
    // The module is not in the added set (it exists at the merge-base or was merely modified).
    const r = classifyBaseline(cur('t'), baseRun(c.runner, c.file), { runner: c.runner, testFile: c.testFile, added: new Set([c.testFile, 'src/unrelated.ts']) });
    assert.equal(r.get('t'), 'not_runnable');
  });
}

test('classifyBaseline: without an added-file list a load failure stays not_runnable', () => {
  assert.equal(classifyBaseline(cur('t'), baseRun('node-test', 'node-newmod.tap')).get('t'), 'not_runnable');
  assert.equal(classifyBaseline(cur('t'), baseRun('node-test', 'node-newmod.tap'),
    { runner: 'node-test', testFile: 'src/dur.test.ts', added: new Set() }).get('t'), 'not_runnable');
});

test('classifyBaseline: a modified existing module that fails an assertion on the base is still an assertion-level "fails"', () => {
  // The task only MODIFIED src/dur.ts; the test loads on the base and fails by assertion.
  const base = { cases: [{ name: 't', outcome: 'failed' as const, message: 'AssertionError: expected 2' }] };
  const r = classifyBaseline(cur('t'), base, { runner: 'node-test', testFile: 'src/dur.test.ts', added: new Set(['src/other.ts']) });
  assert.equal(r.get('t'), 'fails');
});

test('classifyBaseline: genuinely broken tests (syntax error, missing third-party package, missing name in an existing module) stay not_runnable', () => {
  const added = new Set(['src/dur.ts', 'src/dur.test.ts', 'py/pkg/thing.py', 'py/test_a.py']);
  for (const [runner, file, testFile] of [
    ['node-test', 'node-syntax.tap', 'src/dur.test.ts'],
    ['vitest', 'vitest-syn.json', 'src/dur.test.ts'],
    ['jest', 'jest-syn.json', 'src/dur.test.ts'],
    ['pytest', 'pytest-syn.xml', 'py/test_a.py'],
    // `nope` (python) / `./does-not-exist.ts` are not files this task adds.
    ['pytest', 'pytest-missing.xml', 'py/test_a.py'],
    ['node-test', 'node-missing.tap', 'src/dur.test.ts'],
    // `from pkg import nothere`: pkg exists on the base and nothing adds pkg/nothere.py.
    ['pytest', 'pytest-nothere-name.xml', 'py/test_a.py'],
  ] as const) {
    const r = classifyBaseline(cur('t'), baseRun(runner, file), { runner, testFile, added });
    assert.equal(r.get('t'), 'not_runnable', `${runner} ${file}`);
  }
});

test('classifyBaseline: a bare package specifier is never "new code", even if a same-named file was added', () => {
  const base = { cases: [], suiteError: "Cannot find module 'left-pad'", unresolved: ['left-pad'] };
  const r = classifyBaseline(cur('t'), base, { runner: 'node-test', testFile: 'src/a.test.ts', added: new Set(['left-pad.ts', 'src/left-pad.ts']) });
  assert.equal(r.get('t'), 'not_runnable');
});

test('classifyBaseline: if any unresolved module is NOT one the task adds, the file is not_runnable', () => {
  const base = { cases: [], suiteError: 'x', unresolved: ['./new', './old-but-moved'] };
  const r = classifyBaseline(cur('t'), base, { runner: 'node-test', testFile: 'src/a.test.ts', added: new Set(['src/new.ts']) });
  assert.equal(r.get('t'), 'not_runnable');
});

test('classifyBaseline: a timed-out base run is not_runnable even with a matching unresolved import', () => {
  const base = { cases: [], suiteError: 'x', timedOut: true, unresolved: ['./new'] };
  assert.equal(classifyBaseline(cur('t'), base, { runner: 'node-test', testFile: 'src/a.test.ts', added: new Set(['src/new.ts']) }).get('t'), 'not_runnable');
});

test('classifyBaseline: a mixed file (some tests use new code, some old) is labelled new_code as a whole, since the load failure takes every test down', () => {
  const r = classifyBaseline(cur('uses new code', 'only uses old code'), baseRun('node-test', 'node-newmod.tap'),
    { runner: 'node-test', testFile: 'src/dur.test.ts', added: new Set(['src/dur.ts']) });
  assert.deepEqual([r.get('uses new code'), r.get('only uses old code')], ['new_code', 'new_code']);
});

test('classifyBaseline: absolute paths in runner output are resolved inside the scratch tree only', () => {
  const base = { cases: [], suiteError: 'x', unresolved: ['/tmp/scratch.1/src/new.ts'] };
  const ctx = { runner: 'node-test' as const, testFile: 'src/a.test.ts', added: new Set(['src/new.ts']) };
  assert.equal(classifyBaseline(cur('t'), base, { ...ctx, baseDir: '/tmp/scratch.1' }).get('t'), 'new_code');
  assert.equal(classifyBaseline(cur('t'), base, { ...ctx, baseDir: '/tmp/other' }).get('t'), 'not_runnable');
  assert.equal(classifyBaseline(cur('t'), base, ctx).get('t'), 'not_runnable');
});

test('buildVerification: the new-module case end to end — new_code is counted apart from "fails"', async () => {
  const io = fakeIO({
    changed: ['src/dur.test.ts', 'src/dur.ts'],
    added: ['src/dur.ts', 'src/dur.test.ts'],
    runIn: async () => `\n${RESULT_MARKER} exit=1\n${readFileSync(join(fxDir, 'node-newmod.tap'), 'utf8')}`,
  });
  const v = await buildVerification({ profile, io });
  assert.equal(v.tests[0].baseline, 'new_code');
  assert.equal(v.baselineChecked, true);
  const s = summariseVerification(v);
  assert.equal(s.newCodeOnly, 1);
  assert.equal(s.failsWithoutChange, 0);
});

test('buildVerification: if the added-file list cannot be read, load failures degrade to not_runnable', async () => {
  const io = fakeIO({
    changed: ['src/dur.test.ts'],
    addedPaths: async () => { throw new Error('ssh hiccup'); },
    runIn: async () => `\n${RESULT_MARKER} exit=1\n${readFileSync(join(fxDir, 'node-newmod.tap'), 'utf8')}`,
  });
  assert.equal((await buildVerification({ profile, io })).tests[0].baseline, 'not_runnable');
});

test('a full verification can only be started by a review launch or the on-demand request — no other code path', () => {
  const src = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', f), 'utf8');
  const claude = src('server/services/claude.ts');
  const fullCalls = [...claude.matchAll(/verifyTurnTests\([^)]*'full'\)/g)].length;
  assert.equal(fullCalls, 2, 'exactly: the reviewer launch and startFullVerification');
  assert.equal([...claude.matchAll(/verifyTurnTests\([^)]*'tests'\)/g)].length, 1, 'an ordinary implementer turn runs only the quick level');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const walk = (d: string): string[] => readdirSync(join(root, d), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(`${d}/${e.name}`)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [`${d}/${e.name}`] : []);
  const callers = walk('server').filter(f => /startFullVerification\(/.test(src(f)) && f !== 'server/services/claude.ts');
  assert.deepEqual(callers, ['server/routes/tasks.ts'], 'only the POST /tasks/:id/verify route');
  assert.equal([...src('server/routes/tasks.ts').matchAll(/startFullVerification\(/g)].length, 1);
});

// ---- Only what the task added or changed is prominent -------------------------------------

const names = (...ns: string[]) => okTap(...ns);

test('testExistedAtBase: finds a js title as a quoted literal, with or without its describe prefix', () => {
  const src = `describe('Parser', () => { it('rejects empty input', () => {}); it("handles it's fine", () => {}); });`;
  assert.equal(testExistedAtBase('rejects empty input', src), true);
  assert.equal(testExistedAtBase('Parser rejects empty input', src), true);
  assert.equal(testExistedAtBase('Parser > rejects empty input', src), true);
  assert.equal(testExistedAtBase("handles it's fine", src), true);
  assert.equal(testExistedAtBase('Parser accepts a trailing comma', src), false);
});

test('testExistedAtBase: finds a title whose apostrophe or quote is backslash-escaped in the source', () => {
  const src = "test('lists the change\\'s tests', () => {});\ntest(\"says \\\"hi\\\"\", () => {});\n";
  assert.equal(testExistedAtBase("lists the change's tests", src), true);
  assert.equal(testExistedAtBase('says "hi"', src), true);
  assert.equal(testExistedAtBase("lists the user's tests", src), false);
});

test('testExistedAtBase: matches pytest, dotnet and go names by their method or segments', () => {
  assert.equal(testExistedAtBase('tests.test_a.TestA.test_old[1-2]', 'class TestA:\n    def test_old(self): pass'), true);
  assert.equal(testExistedAtBase('tests.test_a.TestA.test_new', 'class TestA:\n    def test_old(self): pass'), false);
  assert.equal(testExistedAtBase('test_old', 'def test_old_thing(): pass'), false, 'a longer identifier is not the same test');
  assert.equal(testExistedAtBase('Ns.Calc.AddsTwo', 'public void AddsTwo() {}'), true);
  assert.equal(testExistedAtBase('TestA/with_spaces', 'func TestA(t *testing.T) { t.Run("with spaces", f) }'), true);
  assert.equal(testExistedAtBase('TestA/other', 'func TestA(t *testing.T) { t.Run("with spaces", f) }'), false);
});

test('markAddedTests: new names are added, old names are routine, and evidence is never folded away', () => {
  const t = (name: string, extra: Partial<VerifiedTest> = {}): VerifiedTest => ({ name, file: 'a.test.ts', outcome: 'passed', origin: 'implementer', ...extra });
  const tests = [
    t('old passing test here'), t('brand new test here'), t('old failing test here', { outcome: 'failed' }),
    t('old but fails without the change', { baseline: 'fails' }), t('old proof test here', { origin: 'reviewer' }),
  ];
  markAddedTests(tests, new Set(), { 'a.test.ts': `it('old passing test here'); it('old failing test here'); it('old but fails without the change'); it('old proof test here');` });
  assert.deepEqual(tests.map(x => [x.name, x.added, !!x.routine]), [
    ['old passing test here', false, true],
    ['brand new test here', true, false],
    ['old failing test here', false, false],
    ['old but fails without the change', false, false],
    ['old proof test here', false, false],
  ]);
});

test('markAddedTests: every test in a new file is added; an unknown base leaves tests undetermined (shown)', () => {
  const tests: VerifiedTest[] = [
    { name: 'x one', file: 'new.test.ts', outcome: 'passed', origin: 'implementer' },
    { name: 'y two', file: 'gone.test.ts', outcome: 'passed', origin: 'implementer' },
    { name: 'z three', file: 'unknown.test.ts', outcome: 'passed', origin: 'implementer' },
  ];
  markAddedTests(tests, new Set(['new.test.ts']), { 'gone.test.ts': null });
  assert.deepEqual(tests.map(x => [x.added, !!x.routine]), [[true, false], [true, false], [undefined, false]]);
});

test('orderTests: failing first, then fails-before, then new-code, then the rest; routine tests last; stable', () => {
  const t = (name: string, extra: Partial<VerifiedTest> = {}): VerifiedTest => ({ name, file: 'f', outcome: 'passed', origin: 'implementer', ...extra });
  const ordered = orderTests([
    t('routine', { routine: true }), t('passes-before', { baseline: 'passes' }), t('new-code', { baseline: 'new_code' }),
    t('not-runnable', { baseline: 'not_runnable' }), t('fails-before', { baseline: 'fails' }), t('red', { outcome: 'failed' }),
  ]);
  assert.deepEqual(ordered.map(x => x.name), ['red', 'fails-before', 'new-code', 'passes-before', 'not-runnable', 'routine']);
});

test('buildVerification: pre-existing passing tests in a touched file are marked routine; the new one leads', async () => {
  const io = fakeIO({
    changed: ['a.test.ts'],
    run: async () => names('already there one', 'already there two', 'added by this task'),
    runIn: async () => failTap('added by this task'),
    baseSources: async () => ({ 'a.test.ts': `it('already there one'); it('already there two');` }),
  });
  const v = await buildVerification({ profile, io });
  assert.deepEqual(v.tests.map(t => [t.name, !!t.routine]), [['added by this task', false], ['already there one', true], ['already there two', true]]);
  // Whole-run counts are unchanged by the folding.
  assert.equal(summariseVerification(v).passing, 3);
});

test('buildVerification: if the base cannot be read, every test stays prominent', async () => {
  const io = fakeIO({ changed: ['a.test.ts'], run: async () => names('one one', 'two two'), baseSources: async () => { throw new Error('no git'); } });
  const v = await buildVerification({ profile, io });
  assert.deepEqual(v.tests.map(t => !!t.routine), [false, false]);
});

test('buildVerification: drops the implementer\'s no-tests reason when tests were added', async () => {
  const io = fakeIO({ changed: ['a.test.ts'], baseSources: async () => ({ 'a.test.ts': null }) });
  const v = await buildVerification({ profile, io, noTestsReason: 'not applicable, a test was added' });
  assert.equal(v.noTestsReason, undefined);
});

test('buildVerification: keeps the no-tests reason when the change carries no tests', async () => {
  const v = await buildVerification({ profile, io: fakeIO({ changed: ['README.md'] }), noTestsReason: 'docs only' });
  assert.equal(v.noTestsReason, 'docs only');
});

test('reviewerTestLines: lists the change\'s tests in full and folds the existing ones into a count', () => {
  const t = (name: string, extra: Partial<VerifiedTest> = {}): VerifiedTest => ({ name, file: 'a.test.ts', outcome: 'passed', origin: 'implementer', ...extra });
  const v = { computedAt: '', level: 'full', runner: 'node-test', problems: [], filesOmitted: 0, baselineChecked: true, notes: [],
    tests: [t('new one', { baseline: 'fails' }), t('old a', { routine: true }), t('old b', { routine: true })] } as VerificationSummary;
  const lines = reviewerTestLines(v);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /PASS "new one" \(a\.test\.ts\) \[fails without the change\]/);
  assert.match(lines[1], /\+2 existing tests in the touched files.*still pass/);
  assert.ok(!lines.join('\n').includes('old a'));
});
