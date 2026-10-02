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
import { defaultFilePattern, loadFailureIsNewCode, parseRunOutput, type RunnerKind, type RunReport, type TestCase, type TestProfile } from './test-runners.js';

export type BaselineResult =
  /** Fails on the original code: the test genuinely exercises new behaviour. */
  | 'fails'
  /** Passes on the original code too: it guards existing behaviour, or proves nothing new. */
  | 'passes'
  /**
   * The test file could not load on the original code, and the runner says the only
   * reason is a module the task ADDS (absent at the merge-base, present now). It
   * cannot pass without the change — but this proves the dependency, not the
   * behaviour, so it is kept apart from `fails`. Applies to every test in the file:
   * a load failure takes the whole file down, so a mixed file (some tests on new
   * code, some on old) cannot be split by test.
   */
  | 'new_code'
  /**
   * Could not run on the original code for any other reason: a syntax error, a
   * missing third-party package, an environment problem, an import of something
   * that exists on the base but changed shape.
   */
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
  /**
   * Whether the test's name is new in its file: true = absent from the file at the
   * merge-base (or the whole file is new), false = already there. Absent = not
   * determined (no base to read, or a summary stored before this existed), which is
   * treated as "show it". Name-based only — see testExistedAtBase.
   */
  added?: boolean;
  /**
   * An unremarkable pre-existing test: the task did not add it (by name), it
   * passes, and it does not fail on the original code either. It says nothing
   * about THIS change, so the card and the reviewer prompt fold it into a count.
   */
  routine?: true;
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

/** What `classifyBaseline` needs to tell "imports code the task adds" from any other load failure. */
export interface BaselineContext {
  runner: RunnerKind;
  /** The test file this report is for, relative to the worktree root. */
  testFile: string;
  /** Files absent at the merge-base and present in the task (relative to it, like `changedPaths`). */
  added: ReadonlySet<string>;
  /** The scratch tree the base run happened in (to relativise absolute paths in runner output). */
  baseDir?: string;
}

/**
 * Compare how the tests ran now with how the same file ran on the original
 * code. A file that did not load is `new_code` when the runner's structured
 * output names only modules the task adds, otherwise `not_runnable` — which also
 * covers "the test ran but broke for a reason unrelated to the behaviour"; the
 * summary never claims more than "could not run without the change" for it.
 */
export function classifyBaseline(current: TestCase[], base: RunReport, ctx?: BaselineContext): Map<string, BaselineResult> {
  const out = new Map<string, BaselineResult>();
  const unrunnable = !!base.suiteError || base.timedOut || base.cases.length === 0;
  if (
    ctx && base.suiteError && !base.timedOut && base.cases.length === 0 &&
    loadFailureIsNewCode(ctx.runner, base.unresolved, ctx)
  ) {
    for (const c of current) out.set(c.name, 'new_code');
    return out;
  }
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
  /**
   * Each file's source as it was at the merge-base; null when it did not exist
   * there. Files missing from the result (no base, git failure) are "unknown".
   */
  baseSources(files: string[]): Promise<Record<string, string | null>>;
  /** The subset of the changed files that do not exist at the merge-base (added or renamed-to, committed or untracked). */
  addedPaths(): Promise<string[]>;
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
export async function buildVerification(args: Parameters<typeof buildVerificationRaw>[0]): Promise<VerificationSummary> {
  const summary = await buildVerificationRaw(args);
  if (summary.tests.length > 0 && !(args.shouldStop?.())) {
    try {
      const files = [...new Set(summary.tests.map(t => t.file))];
      const [added, sources] = await Promise.all([
        args.io.addedPaths().catch(() => [] as string[]),
        args.io.baseSources(files).catch(() => ({} as Record<string, string | null>)),
      ]);
      markAddedTests(summary.tests, new Set(added), sources);
    } catch { /* leave `added` undetermined: every test is then shown */ }
  }
  summary.tests = orderTests(summary.tests);
  // "No tests apply" contradicts a change that carries tests of its own. The
  // implementer sometimes emits the marker anyway (e.g. "not applicable, a test was
  // added"); the harness's own findings win, so the reason is never shown then.
  if (summary.tests.some(t => !t.routine)) delete summary.noTestsReason;
  return summary;
}

async function buildVerificationRaw(args: {
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
    // Needed only to explain a load failure; if it can't be listed those files stay not_runnable.
    const added = new Set(await io.addedPaths().catch(() => [] as string[]));
    for (const file of files) {
      const current = byFile.get(file);
      if (!current) continue;
      if (outOfTime()) return;
      const baseReport = parseRunOutput(profile.runner, await io.runIn(base.dir, [file]));
      const verdicts = classifyBaseline(current.cases, baseReport, { runner: profile.runner, testFile: file, added, baseDir: base.dir });
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

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `s` appears in `src` as a quoted string literal (how js/ts and most others write a test title). */
function hasQuoted(src: string, s: string): boolean {
  for (const q of ["'", '"', '`']) if (src.includes(q + s + q)) return true;
  // A title containing its own quote is escaped in the source; don't call that "new".
  return /['"`\\]/.test(s) && src.includes(s);
}

const hasIdentifier = (src: string, id: string) => id.length > 0 && new RegExp(`(?<![\\w$])${escapeRe(id)}(?![\\w$])`).test(src);

/**
 * Whether a test of this name was already in the file at the merge-base, judged
 * from the old file's TEXT. Name-based and runner-agnostic on purpose: it works
 * the same for every supported runner and costs one `git show`, but it cannot see
 * that an existing test's BODY changed. It errs towards "added" (the safe side:
 * the test is shown, not folded away) whenever it cannot find the name.
 *
 *  - jest/vitest report `describe it` joined by spaces and node:test the title:
 *    found as a quoted literal, trying the whole name and then word-suffixes of at
 *    least two words (the `it` title without its `describe` prefixes).
 *  - pytest/dotnet report `module.Class.method[params]`: the method name as a word.
 *  - go reports `TestA/sub_name`: every segment, as a word or a quoted title with
 *    underscores for spaces.
 */
export function testExistedAtBase(name: string, baseSource: string): boolean {
  const src = baseSource;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (hasQuoted(src, trimmed)) return true;

  if (/\s/.test(trimmed)) {
    const parts = trimmed.split(/\s+[>›]\s+/);
    const leaf = parts[parts.length - 1];
    if (parts.length > 1 && hasQuoted(src, leaf)) return true;
    const words = leaf.split(/\s+/);
    for (let i = 1; i <= words.length - 2; i++) {
      if (hasQuoted(src, words.slice(i).join(' '))) return true;
    }
    return false;
  }

  if (trimmed.includes('/')) {
    return trimmed.split('/').every(seg => hasIdentifier(src, seg) || hasQuoted(src, seg.replace(/_/g, ' ')));
  }
  const leaf = (trimmed.split('.').pop() ?? trimmed).replace(/[\[(].*$/, '');
  return hasIdentifier(src, leaf) || hasQuoted(src, leaf);
}

/**
 * Set `added`/`routine` on each test from the files' base sources. A file that is
 * new (listed in `addedFiles`, or absent at the base) has only added tests; a file
 * whose base source is unknown is left undetermined.
 */
export function markAddedTests(tests: VerifiedTest[], addedFiles: ReadonlySet<string>, baseSources: Record<string, string | null>): void {
  for (const t of tests) {
    const src = baseSources[t.file];
    if (addedFiles.has(t.file) || src === null) t.added = true;
    else if (typeof src === 'string') t.added = !testExistedAtBase(t.name, src);
    else continue;
    // Anything failing, a reviewer's proof test, or a pre-existing test that fails
    // on the original code (so it must exercise something this task changed) is evidence.
    if (t.added === false && t.outcome !== 'failed' && t.origin !== 'reviewer' && t.baseline !== 'fails') t.routine = true;
    else delete t.routine;
  }
}

const evidenceRank = (t: VerifiedTest) =>
  t.outcome === 'failed' ? 0 : t.baseline === 'fails' ? 1 : t.baseline === 'new_code' ? 2 : 3;

/** Strongest evidence first (failing, fails-before, new-code, then the rest); routine tests last. Stable. */
export function orderTests(tests: VerifiedTest[]): VerifiedTest[] {
  const key = (t: VerifiedTest) => (t.routine ? 10 : 0) + evidenceRank(t);
  return tests.map((t, i) => ({ t, i })).sort((a, b) => key(a.t) - key(b.t) || a.i - b.i).map(x => x.t);
}

/**
 * The test lines of the reviewer's verification block. The change's own tests
 * (added, changed, failing, the reviewer's proofs) are listed, strongest evidence
 * first. Pre-existing tests in the same files that pass and say nothing about this
 * change are folded into one count, so they neither flood the prompt nor go
 * unmentioned — the reviewer can still see that they exist.
 */
export function reviewerTestLines(v: VerificationSummary, limit = 30): string[] {
  const tag = (t: VerifiedTest) =>
    t.baseline === 'fails' ? ' [fails without the change]'
    : t.baseline === 'passes' ? ' [ALSO PASSES without the change]'
    : t.baseline === 'new_code' ? ' [fails without the change only because it imports code this change adds — proves the dependency, not the behaviour]'
    : t.baseline === 'not_runnable' ? ' [could not run without the change]' : '';
  const evidence = v.tests.filter(t => !t.routine);
  const routine = v.tests.length - evidence.length;
  const lines = evidence.slice(0, limit).map(t => `- ${t.outcome === 'passed' ? 'PASS' : t.outcome === 'failed' ? 'FAIL' : 'SKIP'} "${t.name}" (${t.file})${tag(t)}`);
  if (evidence.length > limit) lines.push(`- (+${evidence.length - limit} more tests added or changed by this change, not listed)`);
  if (routine > 0) lines.push(`- (+${routine} existing test${routine === 1 ? '' : 's'} in the touched files, not added by this change, still pass and are not listed)`);
  return lines;
}

/** Headline counts for the UI/log: how many claims are actually backed. */
export function summariseVerification(v: VerificationSummary): {
  passing: number; failing: number; failsWithoutChange: number; passesWithoutChange: number; newCodeOnly: number;
} {
  const passed = v.tests.filter(t => t.outcome === 'passed');
  return {
    passing: passed.length,
    failing: v.tests.filter(t => t.outcome === 'failed').length,
    failsWithoutChange: passed.filter(t => t.baseline === 'fails').length,
    passesWithoutChange: passed.filter(t => t.baseline === 'passes').length,
    newCodeOnly: passed.filter(t => t.baseline === 'new_code').length,
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

