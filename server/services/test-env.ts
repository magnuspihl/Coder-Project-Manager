/**
 * Can this worktree run its tests at all?
 *
 * Evidence-based review only means something when the harness can execute
 * tests. A worktree with no dependencies installed (a fresh checkout, or an
 * `npm ci` that wiped node_modules and then failed) makes every proof fail with
 * "Cannot find package 'tsx'" and the whole suite run zero tests. Those runs
 * prove nothing either way — so the review must not be recorded as a pass.
 * This module tells "the tests ran" apart from "the tests could not run":
 *
 *  - before the review: a pre-check that the runner is installed, which
 *    installs the dependencies the same way the preview does when it isn't;
 *  - after the review: classifying a proof run or a suite run as broken by the
 *    environment rather than by the code or the test.
 *
 * The decision logic is pure; the shell scripts are built here and run by the
 * caller (claude.ts wires sshExec).
 */

import { DETECT_INSTALL_SH, INSTALL_LOCK_FN, INSTALL_MARKER, NPM_TREE_CURRENT_FN } from './install-script.js';
import { shellQuote, type TestProfile } from './test-runners.js';
import type { SuiteResult } from './verification.js';

const q = shellQuote;

/** What a profile needs before any test can run. */
export interface RunnerRequirements {
  /** A Node project: package.json's dependencies must be installed (some node_modules up the tree). */
  nodeDeps: boolean;
  /** npm packages that must resolve from the test directory (the runner and its loader). */
  packages: string[];
  /** A binary that must be on PATH (go, dotnet, a custom command's first word). */
  command: string | null;
  /** A Python module that must import, and the interpreter to try it with. */
  python: { interpreter: string; module: string } | null;
}

const NODE_LAUNCHERS = new Set(['npx', 'npm', 'pnpm', 'yarn']);
const DEFAULT_COMMANDS: Record<TestProfile['runner'], string> = {
  'node-test': 'node --test',
  vitest: 'npx --no-install vitest run',
  jest: 'npx --no-install jest',
  pytest: 'python3 -m pytest',
  go: 'go test',
  dotnet: 'dotnet test',
};

/** Derive what must be installed from the runner and its (possibly custom) command. */
export function runnerRequirements(profile: TestProfile): RunnerRequirements {
  const cmd = (profile.command ?? DEFAULT_COMMANDS[profile.runner]).trim();
  const first = cmd.split(/\s+/)[0] ?? '';
  const nodeRunner = profile.runner === 'node-test' || profile.runner === 'vitest' || profile.runner === 'jest';
  const packages: string[] = [];
  if (/\bvitest\b/.test(cmd)) packages.push('vitest');
  if (/\bjest\b/.test(cmd)) packages.push('jest');
  if (/(^|\s)tsx(\s|$)|--(import|loader|require)[ =]tsx\b/.test(cmd)) packages.push('tsx');
  if (/\bts-node\b/.test(cmd)) packages.push('ts-node');
  const py = /^(\S+)\s+-m\s+pytest\b/.exec(cmd);
  return {
    nodeDeps: nodeRunner || NODE_LAUNCHERS.has(first) || first === 'node',
    packages,
    command: first && !NODE_LAUNCHERS.has(first) && !packages.includes(first) ? first : null,
    python: py ? { interpreter: py[1], module: 'pytest' } : null,
  };
}

export interface TestEnvCheck {
  /**
   * ok             — everything the runner needs is there
   * installed      — something was missing; installing the dependencies fixed it
   * missing        — something is missing and could not be installed (not a Node project, or still missing after a clean install)
   * install-failed — the dependency install itself failed
   * unknown        — the check gave no answer (ssh trouble): the caller proceeds as before
   */
  status: 'ok' | 'installed' | 'missing' | 'install-failed' | 'unknown';
  /** `node_modules`, `package:<name>`, `command:<name>`, `python:<module>`. */
  missing: string[];
  installCommand?: string;
  installExit?: number;
  /** The tail of the install's output, when it failed. */
  logTail?: string;
}

export const ENV_MARK = '@@CPM_ENV@@';
export const ENV_LOG_MARK = '@@CPM_ENV_LOG@@';
const LOG_TAIL_BYTES = 3000;

/** Where the review's dependency install writes its log on the workspace. */
export function testInstallLogPath(taskId: string): string {
  return `/tmp/cpm-test-install-${taskId.replace(/[^a-zA-Z0-9-]/g, '')}.log`;
}

/**
 * Shell that checks the runner is installed in the test directory and — when
 * `install` is set and it is a Node project — installs the dependencies with
 * exactly the preview's command and marker (DETECT_INSTALL_SH / INSTALL_MARKER),
 * under the same per-directory lock, so a preview install already in progress
 * is waited for rather than raced. Prints `@@CPM_ENV@@ key=value` lines; see
 * parseTestEnvOutput.
 *
 * It installs only when something is actually missing — never just because the
 * lockfile changed: a working node_modules is left alone. With `install`, it
 * takes the lock BEFORE looking, so a preview install that is mid-way (npm ci
 * deletes node_modules first) is waited out rather than judged half-done.
 */
export function buildTestEnvCommand(
  profile: TestProfile,
  worktree: string,
  opts: { install: boolean; logPath: string; timeoutSec: number },
): string {
  const req = runnerRequirements(profile);
  const dir = profile.cwd ? `${worktree.replace(/\/$/, '')}/${profile.cwd}` : worktree;
  const checks: string[] = [];
  if (req.nodeDeps) {
    checks.push(`if [ -f package.json ] && grep -Eq '"(devD|d)ependencies"' package.json && ! cpm_up_dir node_modules; then M="$M node_modules"; fi`);
  }
  for (const p of req.packages) checks.push(`cpm_up_file node_modules/${p}/package.json || M="$M package:${p}"`);
  if (req.command) checks.push(`command -v ${q(req.command)} >/dev/null 2>&1 || M="$M command:${req.command}"`);
  if (req.python) checks.push(`${q(req.python.interpreter)} -c 'import ${req.python.module}' >/dev/null 2>&1 || M="$M python:${req.python.module}"`);

  const install = opts.install ? `
if [ -f package.json ] && printf '%s' "$M" | grep -Eq 'node_modules|package:'; then
  ${DETECT_INSTALL_SH.replace(/\n/g, '\n  ')}
  echo "${ENV_MARK} install=$CPM_INSTALL"
  if command -v timeout >/dev/null 2>&1; then T="timeout -k 10 ${opts.timeoutSec}"; else T=""; fi
  rm -f ${INSTALL_MARKER}
  $T sh -c "$CPM_INSTALL" > ${q(opts.logPath)} 2>&1 < /dev/null
  RC=$?
  [ $RC -eq 0 ] && mkdir -p node_modules && printf '%s\\n' "$CPM_DEPS_HASH" > ${INSTALL_MARKER}
  M=$(cpm_missing)
  if [ $RC -ne 0 ]; then
    echo "${ENV_MARK} result=install-failed exit=$RC"
    echo "${ENV_MARK} missing=$M"
    echo "${ENV_LOG_MARK}"
    tail -c ${LOG_TAIL_BYTES} ${q(opts.logPath)} 2>/dev/null
    exit 0
  fi
  if [ -z "$M" ]; then echo "${ENV_MARK} result=installed"; exit 0; fi
fi` : '';

  // Wait for any dependency install already running in this directory (the
  // preview's) before looking — held until the script exits. M0 is what was
  // missing before the wait, so "another install fixed it" reads as installed.
  const lockFirst = opts.install ? `M0=
if [ -f package.json ]; then
  ${INSTALL_LOCK_FN.replace(/\n/g, '\n  ')}
  M0=$(cpm_missing)
  cpm_install_lock ${opts.timeoutSec}
fi` : 'M0=';
  const script = `set +e
cd ${q(dir)} || { echo "${ENV_MARK} result=missing"; echo "${ENV_MARK} missing=directory"; exit 0; }
export PATH="$HOME/.local/bin:$PATH"
cpm_up_dir() { d=$(pwd -P); while :; do [ -d "$d/$1" ] && return 0; [ "$d" = / ] && return 1; d=$(dirname "$d"); done; }
cpm_up_file() { d=$(pwd -P); while :; do [ -f "$d/$1" ] && return 0; [ "$d" = / ] && return 1; d=$(dirname "$d"); done; }
cpm_missing() {
  M=
  ${checks.join('\n  ') || ':'}
  printf '%s' "$M" | sed 's/^ *//'
}
${lockFirst}
M=$(cpm_missing)
if [ -z "$M" ]; then
  # Found missing only once another install held the lock, and complete after it: that install fixed it.
  if [ -n "$M0" ]; then echo "${ENV_MARK} result=installed"; else echo "${ENV_MARK} result=ok"; fi
  exit 0
fi
echo "${ENV_MARK} missing=$M"${install}
echo "${ENV_MARK} result=missing"
echo "${ENV_MARK} missing=$M"
exit 0`;
  // base64, so it survives `coder ssh` (and the user's login shell) unquoted.
  return `sh -c "$(printf %s '${Buffer.from(script, 'utf8').toString('base64')}' | base64 -d)"`;
}

/** Read the pre-check's output. Anything unrecognisable is `unknown`, never a verdict. */
export function parseTestEnvOutput(out: string): TestEnvCheck {
  const [head, ...logParts] = out.split(ENV_LOG_MARK);
  let result: string | null = null;
  let missing: string[] = [];
  let installCommand: string | undefined;
  let installExit: number | undefined;
  for (const line of head.split('\n')) {
    const i = line.indexOf(ENV_MARK);
    if (i < 0) continue;
    const kv = line.slice(i + ENV_MARK.length).trim();
    const r = /^result=(\S+)(?:\s+exit=(\d+))?/.exec(kv);
    if (r) { result = r[1]; if (r[2]) installExit = Number(r[2]); continue; }
    if (kv.startsWith('missing=')) { missing = kv.slice(8).trim().split(/\s+/).filter(Boolean); continue; }
    if (kv.startsWith('install=')) installCommand = kv.slice(8).trim() || undefined;
  }
  const logTail = logParts.join(ENV_LOG_MARK).trim() || undefined;
  switch (result) {
    case 'ok': return { status: 'ok', missing: [] };
    case 'installed': return { status: 'installed', missing: [], installCommand };
    case 'missing': return { status: 'missing', missing, installCommand };
    case 'install-failed': return { status: 'install-failed', missing, installCommand, installExit, logTail };
    default: return { status: 'unknown', missing: [] };
  }
}

// ---------------------------------------------------------------------------
// Settling the dependencies before a verification run
// ---------------------------------------------------------------------------

export const DEPS_MARK = '@@CPM_DEPS@@';

export interface DependencySettle {
  /**
   * none           — not a Node project (no package.json): nothing to settle
   * current        — the install marker already matches the lockfile
   * recorded       — no marker, but node_modules matches package-lock.json (a plain `npm ci`): marker written, nothing reinstalled
   * installed      — stale or missing; installed with the preview's command, marker written
   * stale          — stale or missing, but `install` was off (this task's preview never installs): left alone
   * install-failed — the install ran and failed
   * unknown        — no answer (ssh trouble)
   */
  status: 'none' | 'current' | 'recorded' | 'installed' | 'stale' | 'install-failed' | 'unknown';
  installCommand?: string;
  installExit?: number;
  logTail?: string;
}

/**
 * Shell run by the harness before it runs any test in a worktree, so that its
 * runs and the preview's dependency install can never overlap.
 *
 * The preview (re)starts at the same moment as the turn-end verification, and
 * its install (`npm ci`) deletes and re-extracts node_modules — under a test
 * run, that makes every fresh `npx tsx` fail. Both now go through the same
 * per-directory lock and the same marker, so the order no longer matters:
 *
 *  - the preview's install already holds the lock → this waits for it to finish;
 *  - this gets the lock first → it leaves node_modules matching the lockfile and
 *    the marker saying so, so the preview, which re-checks the marker under the
 *    lock, finds nothing to install.
 *
 * The lock cannot simply be held for the whole verification (that is many
 * separate ssh calls), so "leave nothing for the preview to do" is what keeps
 * the preview out afterwards. Hence `install`: when the task's preview WOULD
 * install (an auto-detected `npm run dev`), this runs exactly that install,
 * first, instead of it happening under the tests. When the preview never
 * installs (an explicit preview command, no preview at all) nothing else can
 * race, and a node_modules that is stale is left alone — this never deletes a
 * tree nothing else would have deleted. Either way, a correct node_modules from
 * the agent's own `npm ci` is recognised and the marker recorded.
 *
 * Prints `@@CPM_DEPS@@ key=value` lines; see parseDependencySettleOutput.
 */
export function buildDependencySettleCommand(
  dir: string,
  opts: { install: boolean; logPath: string; timeoutSec: number },
): string {
  const script = `set +e
cd ${q(dir)} || { echo "${DEPS_MARK} result=none"; exit 0; }
export PATH="$HOME/.local/bin:$PATH"
[ -f package.json ] || { echo "${DEPS_MARK} result=none"; exit 0; }
${INSTALL_LOCK_FN}
${NPM_TREE_CURRENT_FN}
${DETECT_INSTALL_SH}
cpm_install_lock ${opts.timeoutSec}
if [ "$(cat ${INSTALL_MARKER} 2>/dev/null)" = "$CPM_DEPS_HASH" ]; then
  echo "${DEPS_MARK} result=current"
elif cpm_npm_tree_current "$CPM_DEPS"; then
  printf '%s\\n' "$CPM_DEPS_HASH" > ${INSTALL_MARKER}
  echo "${DEPS_MARK} result=recorded"
elif [ ${opts.install ? 1 : 0} = 0 ]; then
  echo "${DEPS_MARK} result=stale"
else
  echo "${DEPS_MARK} install=$CPM_INSTALL"
  if command -v timeout >/dev/null 2>&1; then T="timeout -k 10 ${opts.timeoutSec}"; else T=""; fi
  rm -f ${INSTALL_MARKER}
  $T sh -c "$CPM_INSTALL" > ${q(opts.logPath)} 2>&1 < /dev/null
  RC=$?
  if [ $RC -eq 0 ]; then
    mkdir -p node_modules && printf '%s\\n' "$CPM_DEPS_HASH" > ${INSTALL_MARKER}
    echo "${DEPS_MARK} result=installed"
  else
    echo "${DEPS_MARK} result=install-failed exit=$RC"
    echo "${ENV_LOG_MARK}"
    tail -c ${LOG_TAIL_BYTES} ${q(opts.logPath)} 2>/dev/null
  fi
fi
cpm_install_unlock
exit 0`;
  return `sh -c "$(printf %s '${Buffer.from(script, 'utf8').toString('base64')}' | base64 -d)"`;
}

/** Read the settle step's output. Anything unrecognisable is `unknown`. */
export function parseDependencySettleOutput(out: string): DependencySettle {
  const [head, ...logParts] = out.split(ENV_LOG_MARK);
  let result: string | null = null;
  let installCommand: string | undefined;
  let installExit: number | undefined;
  for (const line of head.split('\n')) {
    const i = line.indexOf(DEPS_MARK);
    if (i < 0) continue;
    const kv = line.slice(i + DEPS_MARK.length).trim();
    const r = /^result=(\S+)(?:\s+exit=(\d+))?/.exec(kv);
    if (r) { result = r[1]; if (r[2]) installExit = Number(r[2]); continue; }
    if (kv.startsWith('install=')) installCommand = kv.slice(8).trim() || undefined;
  }
  const logTail = logParts.join(ENV_LOG_MARK).trim() || undefined;
  switch (result) {
    case 'none': case 'current': case 'recorded': case 'stale':
      return { status: result };
    case 'installed': return { status: 'installed', installCommand };
    case 'install-failed': return { status: 'install-failed', installCommand, installExit, logTail };
    default: return { status: 'unknown' };
  }
}

/** Plain-English account of what is missing, e.g. "no dependencies installed in the worktree". */
export function describeMissing(missing: string[]): string {
  if (missing.includes('node_modules')) return 'no dependencies installed in the worktree (node_modules is missing)';
  const parts = missing.map(m => {
    const [kind, name] = m.includes(':') ? [m.slice(0, m.indexOf(':')), m.slice(m.indexOf(':') + 1)] : [m, ''];
    switch (kind) {
      case 'package': return `the test runner's package "${name}" is not installed in the worktree`;
      case 'command': return `"${name}" is not installed in the workspace`;
      case 'python': return `the Python module "${name}" is not installed`;
      case 'directory': return 'the test directory does not exist';
      default: return m;
    }
  });
  return parts.join('; ') || 'the test runner is not installed';
}

/** The one-line reason an unrunnable environment gives, for the review summary. */
export function envCheckReason(check: TestEnvCheck): string {
  if (check.status === 'install-failed') {
    const what = check.missing.length ? describeMissing(check.missing) : 'the test runner is not installed';
    return `tests could not run: ${what}, and installing the dependencies${check.installCommand ? ` (${check.installCommand})` : ''} failed${check.installExit !== undefined ? ` with exit code ${check.installExit}` : ''}`;
  }
  const after = check.installCommand ? ` (still missing after ${check.installCommand})` : '';
  return `tests could not run: ${describeMissing(check.missing)}${after}`;
}

// ---------------------------------------------------------------------------
// Classifying runs
// ---------------------------------------------------------------------------

/**
 * Runner output that means the runner itself could not start — its package or
 * binary is missing — as opposed to a broken test (a wrong relative import, a
 * syntax error) or a real failure. Only the runner's OWN pieces count: a
 * reviewer importing a package the project doesn't have is a broken test.
 * Returns a one-line reason, or null.
 */
export function environmentFailure(profile: TestProfile, text: string | undefined): string | null {
  if (!text) return null;
  const req = runnerRequirements(profile);
  const names = [...req.packages, ...(req.command ? [req.command] : []), ...(req.python ? [req.python.module] : [])];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const name of names) {
    const n = esc(name);
    if (new RegExp(`Cannot find (?:package|module) '${n}(?:/[^']*)?'`).test(text)) return `the test runner's package "${name}" is not installed`;
    if (new RegExp(`(?:^|[\\s:])${n}: (?:command )?not found`, 'm').test(text)) return `"${name}" is not installed`;
    if (new RegExp(`No module named '?${n}'?`).test(text)) return `the Python module "${name}" is not installed`;
  }
  if (/npx canceled due to missing packages|could not determine executable to run/.test(text)) {
    return 'the test runner is not installed (npx could not find it)';
  }
  return null;
}

/**
 * The whole suite errored before running a single test: it did not load at
 * all. "No tests ran" (a clean run that found nothing) and a timeout (it ran,
 * too slowly) are not this. Returns the reason, or null.
 */
export function suiteUnrunnable(suite: SuiteResult | undefined): string | null {
  if (!suite?.error) return null;
  if (suite.passed + suite.failed + suite.skipped > 0) return null;
  if (suite.error === 'No tests ran' || suite.error === 'The suite timed out') return null;
  const first = suite.error.split('\n').map(l => l.trim()).find(l => /error|cannot|not found|failed/i.test(l))
    ?? suite.error.split('\n')[0].trim();
  return `tests could not run: the whole suite errored before running any test (${first.slice(0, 160)})`;
}

// ---------------------------------------------------------------------------
// Preview install state (for the UI and MCP)
// ---------------------------------------------------------------------------

/** Prefixes of preview_error set by preview.ts when the dependency install failed. */
export const PREVIEW_INSTALL_FAILED_PREFIXES = ['Installing the dependencies failed', 'The dependency install did not finish'];

/** The task's last preview start failed while installing dependencies — its worktree is not testable either. */
export function previewInstallFailed(task: { preview_status?: string | null; preview_error?: string | null }): boolean {
  return task.preview_status === 'failed' && !!task.preview_error
    && PREVIEW_INSTALL_FAILED_PREFIXES.some(p => task.preview_error!.startsWith(p));
}

/**
 * After the review: did the tests fail to run because of the environment? The
 * whole suite erroring before any test is enough on its own. Otherwise, when a
 * proof failed to LOAD (a missing module, say), the environment is re-checked —
 * without installing — since a dependency the code needs may have gone missing
 * mid-review. Proofs whose runner was missing are handled by routeReview
 * itself. Returns the reason ("tests could not run: …"), or null.
 */
export async function environmentProblem(input: {
  suite?: SuiteResult;
  proofs: Array<{ status: string; output: string; reason: string; environment?: boolean }>;
  recheck?: () => Promise<TestEnvCheck>;
}): Promise<string | null> {
  const suite = suiteUnrunnable(input.suite);
  if (suite) return suite;
  const loadFailure = input.proofs.some(p => p.status === 'unproven' && !p.environment
    && /Cannot find (package|module)|MODULE_NOT_FOUND|ModuleNotFoundError|No module named|ImportError|command not found|: not found/.test(`${p.reason}\n${p.output}`));
  if (!loadFailure || !input.recheck) return null;
  const check = await input.recheck().catch(() => ({ status: 'unknown', missing: [] }) as TestEnvCheck);
  return check.status === 'missing' || check.status === 'install-failed' ? envCheckReason(check) : null;
}

/**
 * Whether a proof-mode review may start, given the pre-check. `ok` and
 * `installed` proceed; so does `unknown` (the check itself could not be run —
 * the post-run checks still catch a broken environment). `missing` and
 * `install-failed` stop it: the review is unverified, with the install log tail.
 */
export function preReviewGate(check: TestEnvCheck): { proceed: true } | { proceed: false; reason: string; log?: string } {
  if (check.status === 'missing' || check.status === 'install-failed') {
    return { proceed: false, reason: envCheckReason(check), ...(check.logTail ? { log: check.logTail } : {}) };
  }
  return { proceed: true };
}

/** The short "is this reviewed?" answer for get_task: never lets unverified, partial or untested read as a pass. */
export interface ReviewStatusView {
  /** The latest completed review's outcome; null when no review has completed. */
  outcome: 'pass' | 'fail' | 'partial' | 'unverified' | null;
  /**
   * True only for a TEST-VERIFIED pass. A partial or unverified review is not a
   * pass, and neither is an opinion-mode one: its outcome may be "pass", but
   * that is the reviewer's say-so with no test run behind it.
   */
  passed: boolean;
  /**
   * Whether the harness ran the tests for this review (proof mode). False for
   * an opinion-mode review; absent when no review has completed.
   */
  test_verified?: boolean;
  /** For an opinion-mode review: "not test-verified: <why>". */
  not_test_verified?: string;
  summary: string | null;
  /** For an unverified review: why the tests could not run. */
  unverified_reason?: string;
  /** Set when the task's preview dependency install failed — the worktree cannot run tests either. */
  worktree_not_testable?: string;
}

export function reviewStatusView(
  turns: Array<{ role: string; completed_at: string | null; review_outcome: string | null; review_summary: string | null; review_proofs: string | null; review_mode?: string | null }>,
  task: { preview_status?: string | null; preview_error?: string | null },
): ReviewStatusView {
  const last = turns.filter(t => t.role === 'reviewer' && t.completed_at && t.review_outcome).pop();
  const outcome = (last?.review_outcome ?? null) as ReviewStatusView['outcome'];
  let stored: { mode?: string; unverified?: { reason?: string }; notTestVerified?: { reason?: string } } | null = null;
  if (last?.review_proofs) {
    try { stored = JSON.parse(last.review_proofs); } catch { /* the summary still says it */ }
  }
  const opinion = !!last && (last.review_mode ?? stored?.mode) === 'opinion';
  const view: ReviewStatusView = { outcome, passed: outcome === 'pass' && !opinion, summary: last?.review_summary ?? null };
  if (last) view.test_verified = !opinion && outcome !== 'unverified';
  if (opinion) {
    view.not_test_verified = `not test-verified: ${stored?.notTestVerified?.reason ?? 'opinion-based review — no test runner was available'}`;
  }
  if (outcome === 'unverified' && stored?.unverified?.reason) view.unverified_reason = stored.unverified.reason;
  if (previewInstallFailed(task)) {
    view.worktree_not_testable = 'dependency install failed — see the task\'s preview log';
  }
  return view;
}
