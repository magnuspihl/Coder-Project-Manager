import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRunCommand,
  detectProfile,
  parseGoJson,
  parseRunOutput,
  parseTestProfile,
  parseTrx,
  RESULT_MARKER,
  splitRunOutput,
} from './test-runners.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'test-runners');
const fx = (name: string) => readFileSync(join(dir, name), 'utf8');
/** What the harness script prints: log, marker line, report. Over a PTY, so CRLF. */
const wrap = (result: string, log = '', exit = 1) =>
  `${log}\n${RESULT_MARKER} exit=${exit}\n${result}`.replace(/\n/g, '\r\n');

// Every runner is checked on the same five scenarios captured from the real tool:
// all pass, an assertion fails, the code under test throws, the test imports a
// missing module, and the test file has a syntax error.
const runners = [
  { runner: 'node-test', file: (s: string) => `node-${s === 'syn' ? 'syntax' : s}.tap` },
  { runner: 'vitest', file: (s: string) => `vitest-${s}.json` },
  { runner: 'jest', file: (s: string) => `jest-${s}.json` },
  { runner: 'pytest', file: (s: string) => `pytest-${s}.xml` },
] as const;

for (const { runner, file } of runners) {
  test(`${runner}: passing test is reported passed`, () => {
    const r = parseRunOutput(runner, wrap(fx(file('pass')), '', 0));
    assert.equal(r.suiteError, undefined);
    assert.deepEqual(r.cases.map(c => c.outcome), ['passed']);
  });

  test(`${runner}: an assertion failure is a failed case alongside a passing one`, () => {
    const r = parseRunOutput(runner, wrap(fx(file('fail'))));
    assert.equal(r.suiteError, undefined);
    assert.equal(r.cases.filter(c => c.outcome === 'failed').length, 1);
    assert.equal(r.cases.filter(c => c.outcome === 'passed').length, 1);
    assert.match(r.cases.find(c => c.outcome === 'failed')!.message!, /assert|expected|Expected/i);
  });

  test(`${runner}: code under test throwing is a failed case, not a suite error`, () => {
    const r = parseRunOutput(runner, wrap(fx(file('throws'))));
    assert.equal(r.suiteError, undefined);
    const failed = r.cases.filter(c => c.outcome === 'failed');
    assert.equal(failed.length, 1);
    assert.match(failed[0].message!, /undefined|NoneType/);
  });

  for (const scenario of ['missing', 'syn'] as const) {
    test(`${runner}: ${scenario === 'syn' ? 'a syntax error' : 'a missing import'} is a suite error and yields no failed case`, () => {
      const r = parseRunOutput(runner, wrap(fx(file(scenario))));
      assert.ok(r.suiteError && r.suiteError.length > 0, 'expected a suite error');
      assert.equal(r.cases.filter(c => c.outcome === 'failed').length, 0);
    });
  }
}

test('node-test: the diagnostic for a load failure comes from the crashed child, not the summary', () => {
  const r = parseRunOutput('node-test', wrap(fx('node-missing.tap')));
  assert.match(r.suiteError!, /Cannot find module/);
});

test('a timed-out run is flagged', () => {
  const r = parseRunOutput('node-test', wrap('', 'partial output', 124));
  assert.equal(r.timedOut, true);
  assert.ok(r.suiteError);
});

test('output without the marker is a suite error carrying the raw text', () => {
  const r = parseRunOutput('jest', 'bash: cd: no such directory');
  assert.match(r.suiteError!, /no such directory/);
  assert.deepEqual(r.cases, []);
});

test('an empty report falls back to the runner log', () => {
  const r = parseRunOutput('vitest', wrap('', 'Error: Cannot find package vitest'));
  assert.match(r.suiteError!, /Cannot find package vitest/);
});

test('splitRunOutput normalises PTY CRLF and strips ANSI colour', () => {
  const s = splitRunOutput(`\x1b[31mred\x1b[0m\r\n${RESULT_MARKER} exit=3\r\nreport`);
  assert.equal(s.log, 'red');
  assert.equal(s.exit, 3);
  assert.equal(s.result, 'report');
});

test('go: a failing test is a failed case with its output', () => {
  const ndjson = [
    '{"Action":"run","Package":"p","Test":"TestA"}',
    '{"Action":"output","Package":"p","Test":"TestA","Output":"=== RUN   TestA\\n"}',
    '{"Action":"output","Package":"p","Test":"TestA","Output":"    a_test.go:9: want 1 got 2\\n"}',
    '{"Action":"output","Package":"p","Test":"TestA","Output":"--- FAIL: TestA (0.00s)\\n"}',
    '{"Action":"fail","Package":"p","Test":"TestA"}',
    '{"Action":"pass","Package":"p","Test":"TestB"}',
    '{"Action":"fail","Package":"p"}',
  ].join('\n');
  const r = parseGoJson(ndjson);
  assert.equal(r.suiteError, undefined);
  assert.deepEqual(r.cases.map(c => [c.name, c.outcome]), [['TestA', 'failed'], ['TestB', 'passed']]);
  assert.match(r.cases[0].message!, /want 1 got 2/);
  assert.doesNotMatch(r.cases[0].message!, /=== RUN/);
});

test('go: a build failure has a failed package but no failed test → suite error', () => {
  const ndjson = [
    '{"Action":"output","Package":"p","Output":"# p [p.test]\\n"}',
    '{"Action":"output","Package":"p","Output":"./a_test.go:5:2: undefined: Nope\\n"}',
    '{"Action":"output","Package":"p","Output":"FAIL\\tp [build failed]\\n"}',
    '{"Action":"fail","Package":"p"}',
  ].join('\n');
  const r = parseGoJson(ndjson);
  assert.match(r.suiteError!, /undefined: Nope/);
  assert.equal(r.cases.length, 0);
});

test('dotnet trx: passed, failed with message, and not-executed', () => {
  const xml = `<TestRun><Results>
    <UnitTestResult testName="Ok" outcome="Passed" />
    <UnitTestResult testName="Bad" outcome="Failed"><Output><ErrorInfo><Message>Assert.Equal() Failure&#10;Expected: 1</Message><StackTrace>at X</StackTrace></ErrorInfo></Output></UnitTestResult>
    <UnitTestResult testName="Skip" outcome="NotExecuted" />
  </Results></TestRun>`;
  const r = parseTrx(xml);
  assert.deepEqual(r.cases.map(c => c.outcome), ['passed', 'failed', 'skipped']);
  assert.match(r.cases[1].message!, /Expected: 1/);
});

test('detectProfile: package.json devDependencies and scripts', () => {
  const pj = (o: object) => JSON.stringify(o);
  assert.equal(detectProfile({ packageJson: pj({ devDependencies: { vitest: '^1' } }), rootFiles: [] })?.runner, 'vitest');
  assert.equal(detectProfile({ packageJson: pj({ devDependencies: { jest: '^29' } }), rootFiles: [] })?.runner, 'jest');
  const nt = detectProfile({ packageJson: pj({ scripts: { test: 'node --import tsx --test "server/**/*.test.ts"' } }), rootFiles: [] });
  assert.equal(nt?.runner, 'node-test');
  assert.equal(nt?.command, 'node --import tsx --test');
  assert.equal(detectProfile({ packageJson: pj({ scripts: { test: 'node --test' } }), rootFiles: [] })?.command, undefined);
});

test('detectProfile: marker files, and nothing recognisable → null', () => {
  assert.equal(detectProfile({ rootFiles: ['pyproject.toml'] })?.runner, 'pytest');
  assert.equal(detectProfile({ rootFiles: ['go.mod', 'main.go'] })?.runner, 'go');
  assert.equal(detectProfile({ rootFiles: ['App.sln'] })?.runner, 'dotnet');
  assert.equal(detectProfile({ rootFiles: ['README.md'], packageJson: '{"scripts":{"test":"echo no"}}' }), null);
  assert.equal(detectProfile({ rootFiles: [], packageJson: '{not json' }), null);
});

test('parseTestProfile accepts known runners and rejects shell metacharacters', () => {
  assert.deepEqual(parseTestProfile({ runner: 'vitest' }, 'implementer'), { runner: 'vitest', source: 'implementer' });
  assert.equal(parseTestProfile({ runner: 'mocha' }, 'user'), null);
  assert.equal(parseTestProfile({ runner: 'jest', command: 'npx jest; rm -rf /' }, 'user'), null);
  assert.equal(parseTestProfile({ runner: 'jest', command: 'npx jest $(id)' }, 'user'), null);
  assert.equal(parseTestProfile({ runner: 'jest', cwd: '../x' }, 'user'), null);
  assert.equal(parseTestProfile({ runner: 'jest', cwd: '/etc' }, 'user'), null);
  assert.equal(parseTestProfile({ runner: 'jest', cwd: 'packages/web' }, 'user')?.cwd, 'packages/web');
});

test('buildRunCommand quotes files, applies the timeout and reporter flags', () => {
  const cmd = buildRunCommand({ runner: 'node-test', command: 'node --import tsx --test', source: 'detected' }, '/work/tree', ["a b/it's.cpm-proof.test.ts"]);
  assert.match(cmd, /cd '\/work\/tree'/);
  assert.match(cmd, /--test-reporter=tap 'a b\/it'\\''s\.cpm-proof\.test\.ts'/);
  assert.match(cmd, /timeout -k 5 120/);
  assert.match(cmd, new RegExp(RESULT_MARKER));
});

test('buildRunCommand: a cwd is prefixed and stripped from file paths', () => {
  const cmd = buildRunCommand({ runner: 'vitest', cwd: 'web', source: 'user' }, '/w', ['web/src/x.cpm-proof.test.ts']);
  assert.match(cmd, /cd '\/w\/web'/);
  assert.match(cmd, /'src\/x\.cpm-proof\.test\.ts'/);
});

test('buildRunCommand: go runs the package directory of each file once', () => {
  const cmd = buildRunCommand({ runner: 'go', source: 'detected' }, '/w', ['pkg/a/x_cpm_proof_test.go', 'pkg/a/y_cpm_proof_test.go']);
  assert.match(cmd, /go test -json '\.\/pkg\/a'/);
  assert.equal((cmd.match(/'\.\/pkg\/a'/g) ?? []).length, 1);
});
