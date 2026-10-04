/**
 * Test-runner adapters for the evidence-based auto-review.
 *
 * The harness has to tell "the test ran and an assertion failed" apart from "the
 * test never ran" (didn't compile, couldn't import, timed out). The exit code
 * cannot: it is non-zero for both. So every supported runner is invoked with a
 * machine-readable reporter and its output is parsed into a RunReport here.
 *
 * Everything in this file is pure (no IO, no DB) so it can be tested against
 * captured runner output — see __fixtures__/test-runners.
 */

import type { ImportBinding } from './added-exports.js';

export type RunnerKind = 'node-test' | 'vitest' | 'jest' | 'pytest' | 'go' | 'dotnet';

export const RUNNER_KINDS: RunnerKind[] = ['node-test', 'vitest', 'jest', 'pytest', 'go', 'dotnet'];

/** How a workspace's tests are run. Stored per workspace (workspace_settings.test_profile). */
export interface TestProfile {
  runner: RunnerKind;
  /**
   * Overrides the runner's default invocation prefix, e.g. `node --import tsx --test`
   * or `npx vitest run`. The harness appends its own reporter flags and file list.
   */
  command?: string;
  /** Directory (relative to the worktree root) to run from. Defaults to the root. */
  cwd?: string;
  /**
   * Extra arguments for a whole-suite run, e.g. the `"server/**\/*.test.ts"` glob of
   * `node --test`, which (unlike vitest/jest/pytest/go) does not discover TypeScript
   * tests on its own. Ignored when specific files are run.
   */
  suite?: string;
  /** Who chose it: auto-detected from the repo, reported by the implementer, or set by the user. */
  source: 'detected' | 'implementer' | 'user';
}

export interface TestCase {
  name: string;
  outcome: 'passed' | 'failed' | 'skipped';
  /** Failure text (assertion message, exception, stack head). */
  message?: string;
}

/** What one runner invocation produced. */
export interface RunReport {
  cases: TestCase[];
  /**
   * Set when the run failed at suite level: a file that didn't compile or load,
   * a collection error, a build failure, or no parseable report at all. Distinct
   * from a failed case, which means a test really ran and failed.
   */
  suiteError?: string;
  /**
   * Module specifiers the runner reported it could not resolve when loading the
   * test file — the structured part of a load failure, extracted per runner
   * (see `extractUnresolved`). JS: the import path as written (or an absolute
   * path); pytest: the dotted module name. Empty/absent when the load failure
   * was anything else (syntax error, env problem, a missing package…).
   */
  unresolved?: string[];
  /**
   * Named imports the runner reported a module does not provide when loading the
   * test file (see `extractMissingExports`). The module exists; the name doesn't.
   */
  missingExports?: MissingExport[];
  /** The runner was killed by the harness timeout. */
  timedOut?: boolean;
}

/** "Module `from` has no export `name`", as a runner reported it. */
export interface MissingExport {
  name: string;
  /** The module as the runner named it: a JS import specifier, or a dotted Python module. */
  from: string;
  /** The module's file, when the runner printed it (absolute, in the tree that ran). */
  file?: string;
  /** The file whose import failed, when the runner printed it (absolute); otherwise the test file. */
  importer?: string;
}

/**
 * A failed test's message, read as "a name the test imported was undefined when
 * it was used" (see `missingAtCall`):
 *  - `binding`: a bare local name (`formatDuration is not a function`);
 *  - `member`: a property of an imported module object — `namespace` is the
 *    test's own namespace binding (`dur.formatDuration`), or absent when the
 *    object is one the runner's transform generated (`(0 , _dur.formatDuration)`);
 *  - `module`: the runner named the module itself (pytest's AttributeError).
 */
export type CallTimeMiss =
  | { kind: 'binding'; local: string }
  | { kind: 'member'; name: string; namespace?: string }
  | { kind: 'module'; name: string; from: string };

export const RESULT_MARKER = '@@CPM_RESULT@@';

const MAX_LOG_CHARS = 6000;

// ---------------------------------------------------------------------------
// Profile validation + detection
// ---------------------------------------------------------------------------

/** Runner-default regex (source) matching test file paths the runner will pick up. */
export function defaultFilePattern(runner: RunnerKind): string {
  switch (runner) {
    case 'pytest': return '(^|/)(test_[^/]*|[^/]*_test)\\.py$';
    case 'go': return '_test\\.go$';
    case 'dotnet': return '\\.cs$';
    default: return '\\.(test|spec)\\.[cm]?[jt]sx?$|(^|/)__tests__/[^/]+\\.[cm]?[jt]sx?$';
  }
}

/** Commands go into a shell; keep profile-supplied text to a conservative charset. */
const SAFE_COMMAND = /^[\w@%+=:,./ \-"']{1,200}$/;
const SAFE_CWD = /^[\w@%+=:,./-]{1,200}$/;
const SAFE_SUITE = /^[\w@%+=:,./ \-"'*?{}[\]]{1,300}$/;

/** Validate untrusted profile JSON (from the implementer or the settings route). */
export function parseTestProfile(raw: unknown, source: TestProfile['source']): TestProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.runner !== 'string' || !RUNNER_KINDS.includes(r.runner as RunnerKind)) return null;
  const profile: TestProfile = { runner: r.runner as RunnerKind, source };
  if (r.command !== undefined && r.command !== null && r.command !== '') {
    if (typeof r.command !== 'string' || !SAFE_COMMAND.test(r.command) || /[;&|`$<>\\\n]/.test(r.command)) return null;
    profile.command = r.command.trim();
  }
  if (r.cwd !== undefined && r.cwd !== null && r.cwd !== '') {
    if (typeof r.cwd !== 'string' || !SAFE_CWD.test(r.cwd) || r.cwd.split('/').includes('..') || r.cwd.startsWith('/')) return null;
    profile.cwd = r.cwd;
  }
  if (r.suite !== undefined && r.suite !== null && r.suite !== '') {
    if (typeof r.suite !== 'string' || !SAFE_SUITE.test(r.suite) || /[;&|`$<>\\\n]/.test(r.suite)) return null;
    profile.suite = r.suite.trim();
  }
  return profile;
}

/**
 * Infer a profile from what is in the repo root. `rootFiles` is the directory
 * listing; `packageJson` the raw package.json text, when there is one. Returns
 * null when nothing recognisable is found — the caller then degrades to the
 * opinion-based review rather than guessing.
 */
export function detectProfile(input: { packageJson?: string | null; rootFiles: string[] }): TestProfile | null {
  const files = new Set(input.rootFiles);

  if (input.packageJson) {
    try {
      const pkg = JSON.parse(input.packageJson) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const testScript = pkg.scripts?.test ?? '';
      if (deps.vitest || /\bvitest\b/.test(testScript)) return { runner: 'vitest', source: 'detected' };
      if (deps.jest || /\bjest\b/.test(testScript)) return { runner: 'jest', source: 'detected' };
      const nodeTest = /\bnode\b([^&|;]*?)--test\b\s*([^&|;]*)$/.exec(testScript);
      if (nodeTest) {
        const withTsx = /--(import|loader|require)[ =]tsx\b/.test(nodeTest[1]);
        return {
          runner: 'node-test',
          command: withTsx ? 'node --import tsx --test' : undefined,
          suite: nodeTest[2].trim() || undefined,
          source: 'detected',
        };
      }
    } catch { /* malformed package.json — fall through to the marker files */ }
  }

  if (['pytest.ini', 'conftest.py', 'tox.ini', 'setup.cfg', 'pyproject.toml', 'requirements.txt'].some(f => files.has(f))) {
    // pyproject/requirements alone don't prove pytest, but it is the de-facto runner
    // and a missing one surfaces as a suite error (→ unproven), not a false verdict.
    return { runner: 'pytest', source: 'detected' };
  }
  if (files.has('go.mod')) return { runner: 'go', source: 'detected' };
  if ([...files].some(f => /\.(sln|csproj|fsproj)$/.test(f))) return { runner: 'dotnet', source: 'detected' };
  return null;
}

// ---------------------------------------------------------------------------
// Command building
// ---------------------------------------------------------------------------

/** POSIX single-quote a string for safe interpolation into a shell command. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
const q = shellQuote;

/**
 * Shell script that runs `files` under the profile's runner and prints
 *   <tail of the runner's log>\n@@CPM_RESULT@@ exit=<code>\n<machine-readable report>
 * Callers pass `cwd` as the worktree root. Test files are always passed as
 * quoted, pre-validated relative paths.
 */
export function buildRunCommand(
  profile: TestProfile,
  worktree: string,
  files: string[],
  opts: { timeoutSec?: number } = {},
): string {
  const timeoutSec = opts.timeoutSec ?? (files.length === 0 ? 180 : 120);
  const dir = profile.cwd ? `${worktree.replace(/\/$/, '')}/${profile.cwd}` : worktree;
  // Paths are relative to the worktree root; the runner starts in profile.cwd.
  const rel = (f: string) => {
    if (!profile.cwd) return f;
    const prefix = profile.cwd.replace(/\/$/, '') + '/';
    return f.startsWith(prefix) ? f.slice(prefix.length) : f;
  };
  const suiteRun = files.length === 0;
  const qFiles = files.map(f => q(rel(f))).join(' ');

  // Two shapes: runners that write their report to stdout (report == log), and
  // runners that write it to a file ($OUT) while the log goes to $LOG.
  let invoke: string;
  let reportInStdout = false;
  switch (profile.runner) {
    case 'node-test':
      reportInStdout = true;
      // A whole-suite run needs the project's own glob: node's default discovery
      // skips .ts files. The glob is validated (parseTestProfile) and, being a
      // glob, must reach `node` unexpanded — hence the quoting it already carries.
      invoke = `${profile.command ?? 'node --test'} --test-reporter=tap ${suiteRun ? (profile.suite ?? '') : qFiles}`;
      break;
    case 'vitest':
      invoke = `${profile.command ?? 'npx --no-install vitest run'} --reporter=json --outputFile="$OUT" ${qFiles}`;
      break;
    case 'jest':
      invoke = `${profile.command ?? 'npx --no-install jest'} --json --outputFile="$OUT" ${qFiles}`;
      break;
    case 'pytest':
      invoke = `${profile.command ?? 'python3 -m pytest'} -q -p no:cacheprovider --junitxml="$OUT" ${qFiles}`;
      break;
    case 'go': {
      reportInStdout = true;
      const pkgs = suiteRun ? ['./...'] : [...new Set(files.map(f => {
        const d = rel(f).split('/').slice(0, -1).join('/');
        return d ? `./${d}` : '.';
      }))];
      invoke = `${profile.command ?? 'go test'} -json ${pkgs.map(q).join(' ')}`;
      break;
    }
    case 'dotnet': {
      // dotnet can't select by file: filter on the test class named after the file.
      const filter = files
        .map(f => (f.split('/').pop() ?? f).replace(/\.cs$/, ''))
        .map(n => `FullyQualifiedName~${n}`)
        .join('|');
      invoke = `${profile.command ?? 'dotnet test'} ${suiteRun ? '' : `--filter ${q(filter)} `}--results-directory "$RD" --logger "trx;LogFileName=out.trx"`;
      break;
    }
  }

  const finish = profile.runner === 'dotnet'
    ? `cat "$RD/out.trx" 2>/dev/null`
    : reportInStdout ? `cat "$OUT"` : `cat "$OUT" 2>/dev/null`;
  const logTarget = reportInStdout ? '"$OUT"' : '"$LOG"';
  const logTail = reportInStdout ? '' : `tail -c ${MAX_LOG_CHARS} "$LOG" 2>/dev/null; `;

  return [
    `cd ${q(dir)} || exit 1`,
    `export NO_COLOR=1 CI=1 FORCE_COLOR=0`,
    `OUT="$(mktemp)"; LOG="$(mktemp)"; RD="$(mktemp -d)"`,
    `if command -v timeout >/dev/null 2>&1; then T="timeout -k 5 ${timeoutSec}"; else T=""; fi`,
    `$T ${invoke} > ${logTarget} 2>&1`,
    `RC=$?`,
    `${logTail}echo "${RESULT_MARKER} exit=$RC"`,
    `${finish} | head -c 2000000`,
    `rm -rf "$OUT" "$LOG" "$RD"`,
  ].join('\n');
}

/** The command a human (or the implementer) would type to run these files — display only. */
export function describeRunCommand(profile: TestProfile, files: string[]): string {
  const list = files.join(' ');
  switch (profile.runner) {
    case 'node-test': return `${profile.command ?? 'node --test'} ${list}`;
    case 'vitest': return `${profile.command ?? 'npx vitest run'} ${list}`;
    case 'jest': return `${profile.command ?? 'npx jest'} ${list}`;
    case 'pytest': return `${profile.command ?? 'python3 -m pytest'} ${list}`;
    case 'go': return `${profile.command ?? 'go test'} ${[...new Set(files.map(f => './' + f.split('/').slice(0, -1).join('/')))].join(' ')}`.replace(/\.\/$/, '.');
    case 'dotnet': return `${profile.command ?? 'dotnet test'} --filter ${files.map(f => 'FullyQualifiedName~' + (f.split('/').pop() ?? f).replace(/\.cs$/, '')).join('|')}`;
  }
}

/** One-line description of the runner for prompts and the UI. */
export function describeRunner(profile: TestProfile): string {
  const names: Record<RunnerKind, string> = {
    'node-test': 'node:test', vitest: 'Vitest', jest: 'Jest', pytest: 'pytest', go: 'Go (`go test`)', dotnet: '.NET (`dotnet test`)',
  };
  return `${names[profile.runner]}, run as \`${describeRunCommand(profile, ['<file>'])}\``;
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export interface SplitOutput {
  log: string;
  exit: number | null;
  result: string;
}

/** Split the harness script's stdout at the marker. `coder ssh` runs a PTY, so normalise CRLF. */
export function splitRunOutput(raw: string): SplitOutput {
  const text = raw.replace(/\r\n?/g, '\n').replace(ANSI, '');
  const idx = text.indexOf(RESULT_MARKER);
  if (idx === -1) return { log: text.trim(), exit: null, result: '' };
  const log = text.slice(0, idx).trim();
  const rest = text.slice(idx + RESULT_MARKER.length);
  const nl = rest.indexOf('\n');
  const head = nl === -1 ? rest : rest.slice(0, nl);
  const m = /exit=(\d+)/.exec(head);
  return { log, exit: m ? parseInt(m[1], 10) : null, result: nl === -1 ? '' : rest.slice(nl + 1) };
}

function tail(s: string, n = 1500): string {
  const t = s.trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}

export function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** node:test, `--test-reporter=tap`. */
export function parseTap(text: string): RunReport {
  const lines = text.split('\n');
  const cases: TestCase[] = [];
  let suiteError: string | undefined;
  let unresolved: string[] = [];
  let missingExports: MissingExport[] = [];
  let diag: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const comment = /^# (.*)$/.exec(line);
    if (comment) {
      // Runner-summary lines are not diagnostics; the rest is a crashed child's stderr.
      if (!/^(Subtest:|tests |suites |pass |fail |cancelled |skipped |todo |duration_ms )/.test(comment[1])) diag.push(comment[1]);
      continue;
    }
    const m = /^(\s*)(not ok|ok) \d+ - (.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/.exec(line);
    if (!m) continue;

    const yaml: Record<string, string> = {};
    if (lines[i + 1]?.trim() === '---') {
      let j = i + 2;
      let key: string | null = null;
      while (j < lines.length && lines[j].trim() !== '...') {
        const kv = /^\s{2}([A-Za-z_]\w*):\s?(.*)$/.exec(lines[j]);
        if (kv) {
          key = kv[1];
          yaml[key] = /^\|[+-]?$/.test(kv[2]) ? '' : kv[2].replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
        } else if (key) {
          yaml[key] += (yaml[key] ? '\n' : '') + lines[j].replace(/^\s{4}/, '');
        }
        j++;
      }
      i = j;
    }
    if (yaml.type === 'suite') { diag = []; continue; }

    const name = m[3];
    if (m[2] === 'ok') {
      cases.push({ name, outcome: m[4] ? 'skipped' : 'passed' });
    } else if (
      // A child process that died on load (syntax/import error) is reported as a
      // failed "test" named after the file, with the real error only on stderr.
      'exitCode' in yaml ||
      yaml.failureType === 'testTimeoutFailure' ||
      yaml.failureType === 'cancelledByParent'
    ) {
      suiteError = tail(diag.join('\n') || yaml.error || `${name} failed to run`);
      unresolved = extractUnresolved('node-test', diag.join('\n'));
      missingExports = extractMissingExports('node-test', diag.join('\n'));
    } else {
      cases.push({
        name,
        outcome: 'failed',
        message: [yaml.name, yaml.code, yaml.error].filter(Boolean).join(': ').trim() || 'test failed',
      });
    }
    diag = [];
  }
  return { cases, suiteError, ...(unresolved.length ? { unresolved } : {}), ...(missingExports.length ? { missingExports } : {}) };
}

function firstJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* the report may be surrounded by noise */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
}

/** jest `--json` and vitest `--reporter=json` (vitest emits the jest-compatible shape). */
export function parseJestJson(text: string): RunReport {
  const data = firstJsonObject(text) as {
    testResults?: Array<{
      name?: string; status?: string; message?: string;
      assertionResults?: Array<{ fullName?: string; title?: string; status?: string; failureMessages?: string[] }>;
    }>;
  } | null;
  if (!data || !Array.isArray(data.testResults)) return { cases: [], suiteError: 'The test runner produced no parseable report' };

  const cases: TestCase[] = [];
  const suiteErrors: string[] = [];
  const unresolved: string[] = [];
  for (const suite of data.testResults) {
    const results = suite.assertionResults ?? [];
    for (const a of results) {
      const name = a.fullName || a.title || '(unnamed)';
      if (a.status === 'passed') cases.push({ name, outcome: 'passed' });
      else if (a.status === 'failed') cases.push({ name, outcome: 'failed', message: (a.failureMessages ?? []).join('\n').replace(ANSI, '') || 'test failed' });
      else cases.push({ name, outcome: 'skipped' });
    }
    // A suite that failed without any failed case never got to run (import/syntax
    // error) or blew up in a hook; either way it isn't evidence about the code.
    if (suite.status === 'failed' && !results.some(a => a.status === 'failed')) {
      suiteErrors.push(tail((suite.message || `${suite.name ?? 'suite'} failed to run`).replace(ANSI, '')));
      unresolved.push(...extractUnresolved('jest', (suite.message ?? '').replace(ANSI, '')));
    }
  }
  return { cases, suiteError: suiteErrors.length ? suiteErrors.join('\n\n') : undefined, ...(unresolved.length ? { unresolved } : {}) };
}

/** pytest `--junitxml`. */
export function parseJunit(xml: string): RunReport {
  const cases: TestCase[] = [];
  const suiteErrors: string[] = [];
  const unresolved: string[] = [];
  const missingExports: MissingExport[] = [];
  const re = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const body = m[2] ?? '';
    const cls = /classname="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const nm = /\bname="([^"]*)"/.exec(attrs)?.[1] ?? '(unnamed)';
    const name = decodeXml(cls ? `${cls}.${nm}` : nm);
    const failure = /<failure\b([^>]*)>([\s\S]*?)<\/failure>|<failure\b([^>]*)\/>/.exec(body);
    const error = /<error\b([^>]*)>([\s\S]*?)<\/error>|<error\b([^>]*)\/>/.exec(body);
    if (failure) {
      const msg = decodeXml(/message="([^"]*)"/.exec(failure[1] ?? failure[3] ?? '')?.[1] ?? '');
      cases.push({ name, outcome: 'failed', message: [msg, decodeXml(failure[2] ?? '')].filter(Boolean).join('\n') || 'test failed' });
    } else if (error) {
      // In pytest an <error> is a collection failure or a fixture/setup error —
      // the test body never ran — so it is a suite-level problem, not a verdict.
      const errText = decodeXml(error[2] ?? /message="([^"]*)"/.exec(error[1] ?? error[3] ?? '')?.[1] ?? 'error');
      suiteErrors.push(tail(errText));
      unresolved.push(...extractUnresolved('pytest', errText));
      missingExports.push(...extractMissingExports('pytest', errText));
    } else if (/<skipped\b/.test(body)) {
      cases.push({ name, outcome: 'skipped' });
    } else {
      cases.push({ name, outcome: 'passed' });
    }
  }
  return {
    cases,
    suiteError: suiteErrors.length ? suiteErrors.join('\n\n') : undefined,
    ...(unresolved.length ? { unresolved } : {}),
    ...(missingExports.length ? { missingExports } : {}),
  };
}

/** `go test -json`. */
export function parseGoJson(text: string): RunReport {
  const cases: TestCase[] = [];
  const testOutput = new Map<string, string>();
  let pkgOutput = '';
  let pkgFailed = false;
  const stray: string[] = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev: { Action?: string; Test?: string; Output?: string };
    try { ev = JSON.parse(line); } catch { stray.push(line); continue; }
    if (ev.Test) {
      if (ev.Action === 'output') testOutput.set(ev.Test, (testOutput.get(ev.Test) ?? '') + (ev.Output ?? ''));
      else if (ev.Action === 'pass') cases.push({ name: ev.Test, outcome: 'passed' });
      else if (ev.Action === 'skip') cases.push({ name: ev.Test, outcome: 'skipped' });
      else if (ev.Action === 'fail') {
        const out = (testOutput.get(ev.Test) ?? '').split('\n').filter(l => !/^(=== |--- )/.test(l)).join('\n').trim();
        cases.push({ name: ev.Test, outcome: 'failed', message: out || 'test failed' });
      }
    } else if (ev.Action === 'output') {
      pkgOutput += ev.Output ?? '';
    } else if (ev.Action === 'fail') {
      pkgFailed = true;
    }
  }
  // A failed package with no failed test is a build/setup failure ("[build failed]").
  const suiteError = pkgFailed && !cases.some(c => c.outcome === 'failed')
    ? tail([pkgOutput, ...stray].join('\n') || 'package failed without a failing test')
    : undefined;
  return { cases, suiteError };
}

/** `dotnet test --logger trx`. */
export function parseTrx(xml: string): RunReport {
  const cases: TestCase[] = [];
  const re = /<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const name = decodeXml(/testName="([^"]*)"/.exec(m[1])?.[1] ?? '(unnamed)');
    const outcome = /outcome="([^"]*)"/.exec(m[1])?.[1];
    if (outcome === 'Passed') cases.push({ name, outcome: 'passed' });
    else if (outcome === 'Failed') {
      const msg = decodeXml(/<Message>([\s\S]*?)<\/Message>/.exec(m[2] ?? '')?.[1] ?? '');
      const stack = decodeXml(/<StackTrace>([\s\S]*?)<\/StackTrace>/.exec(m[2] ?? '')?.[1] ?? '');
      cases.push({ name, outcome: 'failed', message: [msg, stack].filter(Boolean).join('\n') || 'test failed' });
    } else cases.push({ name, outcome: 'skipped' });
  }
  return { cases };
}

// ---------------------------------------------------------------------------
// Load failures caused by code the task adds
// ---------------------------------------------------------------------------

/**
 * Pull the unresolved-module specifiers out of a load failure's text. The wording
 * is each runner's own, so it lives here per runner (fixtures: `*-newmod.*`,
 * `pytest-nothere-name.xml`, captured from real runs). Only "this module/package
 * could not be found" messages count — a syntax error, an environment problem or
 * an ImportError for a name in a module that exists yield nothing.
 */
export function extractUnresolved(runner: RunnerKind, text: string): string[] {
  const out = new Set<string>();
  const all = (re: RegExp, pick: (m: RegExpExecArray) => string) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.add(pick(m));
  };
  switch (runner) {
    case 'node-test':
    case 'jest':
    case 'vitest':
      // node (CJS and ESM), jest and vitest-on-node: "Cannot find module './x' …".
      all(/Cannot find module '([^']+)'/g, m => m[1]);
      // vite's import analysis: `Failed to resolve import "./x" from "src/a.test.ts"`.
      all(/Failed to resolve import "([^"]+)"/g, m => m[1]);
      break;
    case 'pytest':
      all(/ModuleNotFoundError: No module named '([^']+)'/g, m => m[1]);
      // `from pkg import newmod` where pkg exists but pkg/newmod.py does not (yet).
      all(/ImportError: cannot import name '([\w]+)' from '([\w.]+)'/g, m => `${m[2]}.${m[1]}`);
      break;
    default:
      // go/dotnet: a missing package is a build failure whose wording is not
      // captured from real runs here, so it stays "could not run".
      break;
  }
  return [...out];
}

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
/** `import './x.js'` in TypeScript means `./x.ts` (or .tsx); likewise .mjs→.mts, .cjs→.cts. */
const JS_EXT_SWAPS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'],
};

function normaliseRel(p: string): string | null {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join('/');
}

/** Repo-relative files a JS import specifier written in `testFile` could mean. Empty for bare (package) specifiers. */
function jsCandidates(spec: string, testFile: string, baseDir?: string): string[] {
  let p: string | null = null;
  if (spec.startsWith('./') || spec.startsWith('../')) {
    p = normaliseRel(`${testFile.split('/').slice(0, -1).join('/')}/${spec}`);
  } else if (spec.startsWith('/') && baseDir) {
    // The runner reported an absolute path: only meaningful inside the scratch tree we ran in.
    const root = baseDir.replace(/\/$/, '') + '/';
    if (spec.startsWith(root)) p = normaliseRel(spec.slice(root.length));
  }
  if (!p) return [];
  const out = [p];
  const ext = /\.[cm]?[jt]sx?$/.exec(p)?.[0];
  if (ext) for (const e of JS_EXT_SWAPS[ext] ?? []) out.push(p.slice(0, -ext.length) + e);
  for (const e of JS_EXTS) out.push(p + e);
  for (const e of JS_EXTS) out.push(`${p}/index${e}`);
  return out;
}

function pythonMatches(module: string, added: ReadonlySet<string>): boolean {
  const rel = module.replace(/\./g, '/');
  // `endsWith` rather than equality: src-layout projects import `pkg.x` from `src/pkg/x.py`.
  const hit = (f: string, tail: string) => f === tail || f.endsWith('/' + tail);
  for (const f of added) {
    if (!f.endsWith('.py')) continue;
    if (hit(f, `${rel}.py`) || hit(f, `${rel}/__init__.py`)) return true;
    // A whole new package (or namespace directory): `import newpkg.x` fails with "No module named 'newpkg'".
    if (f.startsWith(rel + '/') || f.includes('/' + rel + '/')) return true;
  }
  return false;
}

/**
 * Pull "module X does not provide name N" out of a load failure's text, per
 * runner (fixtures: `*-newexport-*`, captured from real runs):
 *  - node:test under native ESM (plain `.mjs`, or tsx with `"type": "module"`)
 *    fails at link time: `SyntaxError: The requested module './x.js' does not
 *    provide an export named 'n'`, preceded by the importing file's `path:line`.
 *  - pytest fails at collection: `ImportError: cannot import name 'n' from 'a.b'
 *    (/path/a/b.py)`. The same text also means "a.b is a new submodule", so it is
 *    ALSO in `extractUnresolved`; the classifier accepts either explanation.
 *  - vitest, jest and CommonJS-mode node:test never fail at load for this: the
 *    transformed import is just `undefined` until called — see `missingAtCall`.
 */
export function extractMissingExports(runner: RunnerKind, text: string): MissingExport[] {
  const out: MissingExport[] = [];
  let m: RegExpExecArray | null;
  switch (runner) {
    case 'node-test': {
      const re = /The requested module '([^']+)' does not provide an export named '([^']+)'/g;
      while ((m = re.exec(text)) !== null) {
        // Node prints the failing import's location (`/abs/file.ts:3`) above the excerpt.
        const before = text.slice(0, m.index).split('\n');
        const loc = before.map(l => /^(?:file:\/\/)?(\/\S+?):\d+$/.exec(l.trim())).filter(Boolean).pop();
        out.push({ name: m[2], from: m[1], ...(loc ? { importer: loc[1] } : {}) });
      }
      break;
    }
    case 'pytest': {
      const re = /ImportError: cannot import name '(\w+)' from '([\w.]+)'(?: \(([^)\n]+)\))?/g;
      while ((m = re.exec(text)) !== null) {
        const file = m[3] && m[3].startsWith('/') ? m[3] : undefined;
        out.push({ name: m[1], from: m[2], ...(file ? { file } : {}) });
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * The module objects each runner's transform generates for an import, so that
 * `(0 , <obj>.name) is not a function` can be read as "the imported `name` was
 * undefined". Captured from real runs (`*-newexport-*`): tsx/esbuild in CommonJS
 * mode (`import_dur`), vite's SSR transform (`__vite_ssr_import_1__`), babel
 * (`_dur`) and tsc/ts-jest (`dur_1`).
 */
const GENERATED_IMPORT_OBJECT: Partial<Record<RunnerKind, RegExp>> = {
  'node-test': /^import_[\w$]+$/,
  vitest: /^__vite_ssr_import_\d+__$/,
  jest: /^(?:_[\w$]+|[\w$]+_\d+)$/,
};

/**
 * Read a failed test's message as "something the test imported was undefined
 * when it was used" — or null. Per runner, from real runs (`*-newexport-*`):
 * JS runners report `TypeError: … is not a function / constructor` (node:test
 * prefixes its error code); pytest reports `AttributeError: module 'a.b' has no
 * attribute 'n'`. Whether that name really is an export the task adds is decided
 * by the caller from the diff — this only parses the runner's wording.
 */
export function missingAtCall(runner: RunnerKind, message: string | undefined): CallTimeMiss | null {
  if (!message) return null;
  if (runner === 'pytest') {
    const m = /AttributeError: module '([\w.]+)' has no attribute '(\w+)'/.exec(message);
    return m ? { kind: 'module', from: m[1], name: m[2] } : null;
  }
  const generated = GENERATED_IMPORT_OBJECT[runner];
  if (!generated) return null;
  const line = message.split('\n').find(l => /\bTypeError\b/.test(l));
  const m = line && /(?<![\w$.])(?:\(0\s*,\s*)?([\w$]+)(?:\.([\w$]+))?\)?\s+is not a (?:function|constructor)\b/.exec(line);
  if (!m) return null;
  if (!m[2]) return { kind: 'binding', local: m[1] };
  return generated.test(m[1]) ? { kind: 'member', name: m[2] } : { kind: 'member', name: m[2], namespace: m[1] };
}

/** What deciding "only new code" needs beyond the runner's output. */
export interface NewCodeContext {
  /** The test file, relative to the worktree root. */
  testFile: string;
  /** Files absent at the merge-base and present in the task. */
  added: ReadonlySet<string>;
  /** The scratch tree the base run happened in (to relativise absolute paths in runner output). */
  baseDir?: string;
  /**
   * For files that exist at the merge-base and that the task changed: the names
   * each one exports now and did not then (`addedExports` in added-exports.ts);
   * null when that could not be determined. A file missing from the map was not looked at.
   */
  addedExports?: ReadonlyMap<string, ReadonlySet<string> | null>;
  /** The test file's imports (JS), to trace a call-time miss back to a module. */
  testImports?: readonly ImportBinding[];
}

const relInside = (abs: string, baseDir?: string): string | null => {
  if (!baseDir) return null;
  const root = baseDir.replace(/\/$/, '') + '/';
  return abs.startsWith(root) ? normaliseRel(abs.slice(root.length)) : null;
};

/** One "module `from` lacks `name`" reference, to be checked against the diff. */
interface ExportRef { name: string; from: string; importer?: string; file?: string }

/** The repo file a reference points at, among `pool` (files the task changed that exist at the base). */
function moduleFileFor(runner: RunnerKind, ref: ExportRef, ctx: NewCodeContext, pool: Iterable<string>): string | null {
  const files = [...pool];
  if (runner === 'pytest') {
    if (ref.file) {
      const rel = relInside(ref.file, ctx.baseDir);
      return rel && files.includes(rel) ? rel : null;
    }
    const rel = ref.from.replace(/\./g, '/');
    const hit = files.filter(f => [`${rel}.py`, `${rel}/__init__.py`].some(t => f === t || f.endsWith('/' + t)));
    return hit.length === 1 ? hit[0] : null;
  }
  const importer = (ref.importer && relInside(ref.importer, ctx.baseDir)) || ctx.testFile;
  return jsCandidates(ref.from, importer, ctx.baseDir).find(c => files.includes(c)) ?? null;
}

/** The (module, name) pairs a call-time miss could mean, through the test file's own imports. */
function callTimeRefs(miss: CallTimeMiss, imports: readonly ImportBinding[]): ExportRef[] {
  if (miss.kind === 'module') return [{ name: miss.name, from: miss.from }];
  let hits: ImportBinding[];
  if (miss.kind === 'binding') hits = imports.filter(b => b.local === miss.local && b.imported !== '*');
  else if (miss.namespace) hits = imports.filter(b => b.imported === '*' && b.local === miss.namespace);
  else {
    // A generated module object stands for a named import of that name — or, when
    // there is none (vite rewrites `ns.x` too), for the namespace imports.
    hits = imports.filter(b => b.imported === miss.name);
    if (hits.length === 0) hits = imports.filter(b => b.imported === '*');
  }
  return hits.map(b => ({ name: miss.kind === 'binding' ? b.imported : miss.name, from: b.spec }));
}

function isAddedExport(runner: RunnerKind, ref: ExportRef, ctx: NewCodeContext): boolean {
  if (!ctx.addedExports) return false;
  const file = moduleFileFor(runner, ref, ctx, ctx.addedExports.keys());
  return !!file && !!ctx.addedExports.get(file)?.has(ref.name);
}

/**
 * The changed files whose exports must be compared with the merge-base to
 * classify this base run: the modules a missing name (at load, or in a failed
 * test) points at. `pool` = files the task changed that exist at the base.
 * Empty when nothing in the run is a missing-name failure.
 */
export function exportFilesToCheck(runner: RunnerKind, report: RunReport, ctx: NewCodeContext, pool: ReadonlySet<string>): string[] {
  const refs: ExportRef[] = [...(report.missingExports ?? [])];
  for (const c of report.cases) {
    const miss = c.outcome === 'failed' ? missingAtCall(runner, c.message) : null;
    if (miss) refs.push(...callTimeRefs(miss, ctx.testImports ?? []));
  }
  return [...new Set(refs.map(r => moduleFileFor(runner, r, ctx, pool)).filter((f): f is string => !!f))];
}

/** Whether any failure in this base run is worth tracing through the test file's imports. */
export function hasCallTimeMiss(runner: RunnerKind, report: RunReport): boolean {
  return report.cases.some(c => c.outcome === 'failed' && !!missingAtCall(runner, c.message));
}

/**
 * True when a test file failed to load on the original code ONLY because of
 * code the task adds. Every module the runner named as unresolved must be a file
 * absent at the merge-base and present in `added`, and every name it said a
 * module does not provide must be one the task adds to that (existing) file —
 * per the file's diff, see `addedExports`. Nothing named, a bare package name, a
 * module that exists on the base, or a name the task did not add (a rename, a
 * typo) returns false — those stay "could not run".
 */
export function loadFailureIsNewCode(
  runner: RunnerKind,
  report: Pick<RunReport, 'unresolved' | 'missingExports'>,
  ctx: NewCodeContext,
): boolean {
  const unresolved = report.unresolved ?? [];
  const missing = report.missingExports ?? [];
  if (unresolved.length + missing.length === 0) return false;
  const newModule = (spec: string) => {
    if (ctx.added.size === 0) return false;
    if (runner === 'pytest') return pythonMatches(spec, ctx.added);
    if (runner === 'node-test' || runner === 'vitest' || runner === 'jest') {
      return jsCandidates(spec, ctx.testFile, ctx.baseDir).some(c => ctx.added.has(c));
    }
    return false;
  };
  // pytest's "cannot import name 'b' from 'a'" is both `a.b` (unresolved) and
  // (a, b) (missing): either a new submodule a/b.py or a new name in a explains it.
  const pairedExport = (spec: string) =>
    runner === 'pytest' && missing.some(e => `${e.from}.${e.name}` === spec && isAddedExport(runner, e, ctx));
  return unresolved.every(spec => newModule(spec) || pairedExport(spec)) &&
    missing.every(e => isAddedExport(runner, e, ctx) || (runner === 'pytest' && newModule(`${e.from}.${e.name}`)));
}

/**
 * True when a test that loaded on the original code failed there only because a
 * name it imported did not exist yet: the runner's message is a call-time miss
 * (`missingAtCall`) and every import it can mean is a name the task adds to an
 * existing file.
 */
export function callFailureIsNewExport(runner: RunnerKind, message: string | undefined, ctx: NewCodeContext): boolean {
  const miss = missingAtCall(runner, message);
  if (!miss) return false;
  const refs = callTimeRefs(miss, ctx.testImports ?? []);
  return refs.length > 0 && refs.every(r => isAddedExport(runner, r, ctx));
}

/**
 * Parse one harness run into a RunReport. When the report is missing or empty the
 * tail of the runner's log becomes the suite error — that is where a compile
 * failure or a missing binary explains itself.
 */
export function parseRunOutput(runner: RunnerKind, raw: string): RunReport {
  const { log, exit, result } = splitRunOutput(raw);
  const timedOut = exit === 124 || exit === 137;
  const fallback = (why: string): RunReport => ({
    cases: [],
    suiteError: tail(log || result) || why,
    timedOut,
  });

  if (exit === null) return fallback('The run produced no output');
  if (!result.trim()) return fallback('The test runner produced no report');

  let report: RunReport;
  try {
    switch (runner) {
      case 'node-test': report = parseTap(result); break;
      case 'vitest':
      case 'jest': report = parseJestJson(result); break;
      case 'pytest': report = parseJunit(result); break;
      case 'go': report = parseGoJson(result); break;
      case 'dotnet': report = parseTrx(result); break;
    }
  } catch (err) {
    return fallback(`Could not parse the ${runner} report: ${(err as Error).message}`);
  }
  if (timedOut) report.timedOut = true;
  return report;
}
