/**
 * The harness's own account of what a task's tests show — the thing a human can
 * trust because no model wrote it.
 *
 * After an implementer turn the harness finds the test files the task added or
 * changed, runs each one, runs the project's whole suite, and — the strongest
 * signal — re-runs the new tests against the code as it was BEFORE the task. A
 * test that fails there and passes now provably exercises the change; one that
 * passes either way proves nothing new. The result is stored on the task and
 * rendered as a checklist of plain-English test names.
 *
 * Test names are the implementer's own claims. The reviewer audits that they
 * assert what they say; this module only reports what actually ran.
 */

import { isTestAuthoringError } from './review-proof.js';
import { defaultFilePattern, parseRunOutput, type RunnerKind, type RunReport, type TestCase, type TestProfile } from './test-runners.js';

export type BaselineResult =
  /** Fails on the original code: the test genuinely exercises new behaviour. */
  | 'fails'
  /** Passes on the original code too: it guards existing behaviour, or proves nothing new. */
  | 'passes'
  /** Could not run on the original code (e.g. it imports a module that didn't exist yet). */
  | 'not_runnable';

export interface VerifiedTest {
  name: string;
  file: string;
  outcome: TestCase['outcome'];
  /** `reviewer` for a confirmed proof test kept as a regression test. */
  origin: 'implementer' | 'reviewer';
  baseline?: BaselineResult;
  /** Failure text, for tests that failed. */
  message?: string;
}

export interface SuiteResult {
  passed: number;
  failed: number;
  skipped: number;
  /** The suite could not be run to completion. Never reported as a pass. */
  error?: string;
  failedNames: string[];
}

/**
 * How much was run. `tests` = only the change's own test files (cheap; after an
 * ordinary implementer turn). `full` = also the comparison with the original
 * code and the whole suite (when a review runs, or on demand).
 */
export type VerificationLevel = 'tests' | 'full';

export interface VerificationSummary {
  computedAt: string;
  level: VerificationLevel;
  /** Identifies the exact tree this describes; a `full` result for an unchanged tree is not recomputed. */
  fingerprint?: string;
  runner: RunnerKind | null;
  tests: VerifiedTest[];
  /** Test files that could not be run at all (didn't load, timed out). */
  problems: Array<{ file: string; error: string }>;
  /** More changed test files than the harness runs per turn. */
  filesOmitted: number;
  suite?: SuiteResult;
  /** The implementer's stated reason that no tests apply to this change. */
  noTestsReason?: string;
  /** Whether the before-the-change comparison ran (it needs a base commit). */
  baselineChecked: boolean;
  /** Anything the reader should know about how far to trust this. */
  notes: string[];
}

export const MAX_TEST_FILES = 8;

/** One path per line (the output of `git diff --name-only` / `ls-files`), blanks removed. */
export function parseNameList(out: string): string[] {
  return [...new Set(out.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean))];
}

export function isTestFile(path: string, profile: TestProfile): boolean {
  if (path.split('/').includes('node_modules')) return false;
  return new RegExp(defaultFilePattern(profile.runner)).test(path);
}

const isReviewerProof = (path: string) => /cpm[-_]?proof/i.test(path.split('/').pop() ?? '');

/**
 * Compare how the tests ran now with how the same file ran on the original
 * code. `not_runnable` covers both "the file didn't load" and "the test ran but
 * broke for a reason unrelated to the behaviour" — the summary never claims more
 * than "could not run without the change" for it.
 */
export function classifyBaseline(current: TestCase[], base: RunReport): Map<string, BaselineResult> {
  const out = new Map<string, BaselineResult>();
  const unrunnable = !!base.suiteError || base.timedOut || base.cases.length === 0;
  for (const c of current) {
    if (unrunnable) { out.set(c.name, 'not_runnable'); continue; }
    const b = base.cases.find(x => x.name === c.name);
    if (!b || b.outcome === 'skipped') out.set(c.name, 'not_runnable');
    else if (b.outcome === 'passed') out.set(c.name, 'passes');
    else out.set(c.name, isTestAuthoringError(b.message) ? 'not_runnable' : 'fails');
  }
  return out;
}

export interface VerificationIO {
  /** A hash of the task's exact state (HEAD, the diff against the base, untracked contents). */
  fingerprint(): Promise<string>;
  /** Files the task changed vs the default branch (committed, uncommitted and untracked), relative to the worktree root. */
  changedPaths(): Promise<string[]>;
  /** Run specific test files in the worktree. Resolves with the run script's raw output. */
  run(files: string[]): Promise<string>;
  /** Run the project's whole suite in the worktree. */
  runSuite(): Promise<string>;
  /**
   * Materialise the code as it was before the task (merge-base with the default
   * branch) with `files` copied over it. Null when there is no base to compare with.
   */
  prepareBaseline(files: string[]): Promise<{ dir: string } | null>;
  runIn(dir: string, files: string[]): Promise<string>;
  cleanupBaseline(dir: string): Promise<void>;
}

/**
 * Never throws: a verification that can't complete says so in `notes` instead of
 * failing the turn. `shouldStop` is polled before every run so a spent time
 * budget ends the work at the next boundary instead of grinding through the rest.
 */
export async function buildVerification(args: {
  profile: TestProfile | null;
  io: VerificationIO;
  level?: VerificationLevel;
  noTestsReason?: string;
  shouldStop?: () => boolean;
  now?: () => Date;
}): Promise<VerificationSummary> {
  const { profile, io } = args;
  const level = args.level ?? 'full';
  const stop = args.shouldStop ?? (() => false);
  const summary: VerificationSummary = {
    computedAt: (args.now ?? (() => new Date()))().toISOString(),
    level,
    runner: profile?.runner ?? null,
    tests: [],
    problems: [],
    filesOmitted: 0,
    baselineChecked: false,
    notes: [],
    ...(args.noTestsReason ? { noTestsReason: args.noTestsReason } : {}),
  };
  if (!profile) {
    summary.notes.push('No test runner was found for this workspace, so nothing could be run.');
    return summary;
  }
  const outOfTime = () => {
    if (!stop()) return false;
    if (!summary.notes.some(n => /time budget/.test(n))) summary.notes.push('The time budget ran out, so the remaining checks were skipped.');
    return true;
  };

  if (level === 'full') {
    try { summary.fingerprint = await io.fingerprint(); } catch { /* an unfingerprinted result is simply always recomputed */ }
  }

  let changed: string[] = [];
  try {
    changed = await io.changedPaths();
  } catch (err) {
    summary.notes.push(`Could not list the changed files: ${(err as Error).message.slice(0, 120)}`);
  }
  const all = [...new Set(changed.filter(p => isTestFile(p, profile)))];
  const files = all.slice(0, MAX_TEST_FILES);
  summary.filesOmitted = all.length - files.length;

  // Per-file runs keep every result attributable to a file without needing the
  // runner to report one.
  const byFile = new Map<string, RunReport>();
  for (const file of files) {
    if (outOfTime()) return summary;
    try {
      const report = parseRunOutput(profile.runner, await io.run([file]));
      byFile.set(file, report);
      if (report.suiteError || report.timedOut) {
        summary.problems.push({ file, error: report.timedOut ? 'The test file timed out' : (report.suiteError ?? '').slice(0, 400) });
      }
      for (const c of report.cases) {
        summary.tests.push({
          name: c.name, file, outcome: c.outcome,
          origin: isReviewerProof(file) ? 'reviewer' : 'implementer',
          ...(c.outcome === 'failed' ? { message: (c.message ?? '').slice(0, 400) } : {}),
        });
      }
    } catch (err) {
      summary.problems.push({ file, error: `Could not run: ${(err as Error).message.slice(0, 200)}` });
    }
  }
  if (level === 'tests') return summary;

  if (files.length > 0) {
    if (outOfTime()) return summary;
    await addBaseline(summary, files, byFile, profile, io, outOfTime);
  }

  if (outOfTime()) return summary;
  try {
    const report = parseRunOutput(profile.runner, await io.runSuite());
    summary.suite = {
      passed: report.cases.filter(c => c.outcome === 'passed').length,
      failed: report.cases.filter(c => c.outcome === 'failed').length,
      skipped: report.cases.filter(c => c.outcome === 'skipped').length,
      failedNames: report.cases.filter(c => c.outcome === 'failed').map(c => c.name).slice(0, 10),
      ...(report.suiteError || report.timedOut
        ? { error: report.timedOut ? 'The suite timed out' : (report.suiteError ?? '').slice(0, 400) }
        : report.cases.length === 0 ? { error: 'No tests ran' } : {}),
    };
  } catch (err) {
    summary.suite = { passed: 0, failed: 0, skipped: 0, failedNames: [], error: `Could not run: ${(err as Error).message.slice(0, 200)}` };
  }
  return summary;
}

async function addBaseline(
  summary: VerificationSummary,
  files: string[],
  byFile: Map<string, RunReport>,
  profile: TestProfile,
  io: VerificationIO,
  outOfTime: () => boolean,
): Promise<void> {
  let base: { dir: string } | null = null;
  try {
    base = await io.prepareBaseline(files);
    if (!base) {
      summary.notes.push('No base commit to compare against, so it is not known whether the new tests fail without the change.');
      return;
    }
    for (const file of files) {
      const current = byFile.get(file);
      if (!current) continue;
      if (outOfTime()) return;
      const baseReport = parseRunOutput(profile.runner, await io.runIn(base.dir, [file]));
      const verdicts = classifyBaseline(current.cases, baseReport);
      for (const t of summary.tests) {
        if (t.file === file && verdicts.has(t.name)) t.baseline = verdicts.get(t.name);
      }
    }
    summary.baselineChecked = true;
  } catch (err) {
    summary.notes.push(`The comparison with the original code could not be completed: ${(err as Error).message.slice(0, 120)}`);
  } finally {
    if (base) await io.cleanupBaseline(base.dir).catch(() => {});
  }
}

/** Headline counts for the UI/log: how many claims are actually backed. */
export function summariseVerification(v: VerificationSummary): {
  passing: number; failing: number; failsWithoutChange: number; passesWithoutChange: number;
} {
  const passed = v.tests.filter(t => t.outcome === 'passed');
  return {
    passing: passed.length,
    failing: v.tests.filter(t => t.outcome === 'failed').length,
    failsWithoutChange: passed.filter(t => t.baseline === 'fails').length,
    passesWithoutChange: passed.filter(t => t.baseline === 'passes').length,
  };
}

/**
 * Wait for `work`, but never longer than `ms`. Resolves `{timedOut: true}` when
 * the budget wins — the work is NOT cancelled (a promise cannot be), so callers
 * must also tell it to stop (see `shouldStop` on buildVerification) and ignore
 * its late result. What this guarantees is that the CALLER carries on: a hung
 * test process can cost a task at most this long, never forever.
 */
export async function withBudget<T>(work: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then(value => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

