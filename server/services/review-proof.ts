/**
 * Evidence-based review: the harness — not the reviewer — verifies proofs.
 *
 * The reviewer is read-only, so it cannot run the tests it writes. It emits them
 * (PROOF_FILE blocks) and this module materialises, runs and classifies them:
 *
 *   test fails as claimed          → confirmed → blocking
 *   test passes                    → refuted   → dropped (logged)
 *   test errors / can't run        → unproven  → advisory
 *
 * A review's outcome is then `fail` only if at least one finding is confirmed.
 * Everything here is pure or takes its IO as an injected `ProofIO`, so the
 * classification and routing can be tested without a workspace.
 */

import type { CoverageReport } from './review-coverage.js';
import type { ProofFile, ReviewDecision, ReviewIssue } from './review-verdict.js';
import type { ReviewFinding } from './tasks.js';
import {
  defaultFilePattern,
  parseRunOutput,
  type RunReport,
  type TestProfile,
} from './test-runners.js';

export type ProofStatus = 'confirmed' | 'refuted' | 'unproven';

/** `proof` = findings need failing tests; `opinion` = the pre-existing read-and-judge review. */
export type ReviewMode = 'proof' | 'opinion';

export interface ProofResult {
  status: ProofStatus;
  /** One line explaining the status, shown next to the badge. */
  reason: string;
  failedTests: string[];
  passedTests: number;
  /** Runner output worth showing as evidence (truncated). */
  output: string;
  /**
   * Unproven because the test itself was broken (didn't load, wrong import, bad
   * path). Worth one repair round with the reviewer; a timeout or a missing
   * test is not.
   */
  repairable: boolean;
}

export interface VerifiedIssue {
  issue: ReviewIssue;
  proof: ProofResult;
  /** The test as the reviewer wrote it, for display. Absent when none was supplied. */
  proofPath?: string;
  proofContent?: string;
}

export const MAX_PROOFS_PER_REVIEW = 5;
export const MAX_PROOF_BYTES = 60_000;
const MAX_OUTPUT_CHARS = 3000;
const MAX_STORED_CONTENT = 20_000;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Failure texts that mean the *test* is broken rather than the code under test:
 * it references something that doesn't exist, or didn't compile. A runtime
 * TypeError from inside the code under test is deliberately NOT here — "crashes
 * on empty input" is exactly the kind of defect a proof should confirm. The
 * bias is conservative: wrongly demoting a real failure to unproven costs a
 * repair round; wrongly confirming sends the implementer chasing a phantom.
 */
const TEST_AUTHORING_ERRORS: RegExp[] = [
  /\b(SyntaxError|ReferenceError|NameError|IndentationError|ModuleNotFoundError|ImportError)\b/,
  /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Failed to resolve import|Transform failed/,
  /\bis not defined\b|\bis not a function\b|\bis not a constructor\b|\bmodule '[^']+' has no attribute\b|\bhas no exported member\b/,
  /Unexpected token|Unexpected identifier|Expected identifier/,
  /\berror CS\d{4}\b|\[build failed\]|\bundefined: \w+|fixture '[^']*' not found/,
];

export function isTestAuthoringError(message: string | undefined): boolean {
  return !!message && TEST_AUTHORING_ERRORS.some(re => re.test(message));
}

function clip(s: string, n = MAX_OUTPUT_CHARS): string {
  return s.length > n ? s.slice(0, n) + '\n…[truncated]' : s;
}

/** Turn one runner report into a verdict on the proof. */
export function classifyRun(report: RunReport): ProofResult {
  const failed = report.cases.filter(c => c.outcome === 'failed');
  const passed = report.cases.filter(c => c.outcome === 'passed');
  const base = { failedTests: [] as string[], passedTests: passed.length, output: '' };

  if (report.timedOut) {
    return { ...base, status: 'unproven', reason: 'The test timed out', repairable: false, output: clip(report.suiteError ?? '') };
  }
  if (report.suiteError) {
    return { ...base, status: 'unproven', reason: 'The test could not run', repairable: true, output: clip(report.suiteError) };
  }
  if (report.cases.length === 0) {
    return { ...base, status: 'unproven', reason: 'No tests ran', repairable: true };
  }

  const real = failed.filter(c => !isTestAuthoringError(c.message));
  if (real.length > 0) {
    return {
      ...base,
      status: 'confirmed',
      reason: 'The test fails on the current code, as claimed',
      failedTests: real.map(c => c.name),
      repairable: false,
      output: clip(real.map(c => `${c.name}\n${c.message ?? ''}`).join('\n\n').trim()),
    };
  }
  if (failed.length > 0) {
    return {
      ...base,
      status: 'unproven',
      reason: 'The test failed because of a problem in the test itself, not the code',
      failedTests: failed.map(c => c.name),
      repairable: true,
      output: clip(failed.map(c => `${c.name}\n${c.message ?? ''}`).join('\n\n').trim()),
    };
  }
  if (passed.length === 0) {
    return { ...base, status: 'unproven', reason: 'Every test was skipped', repairable: false };
  }
  return { ...base, status: 'refuted', reason: 'The test passes on the current code, so the defect was not demonstrated', repairable: false };
}

function unproven(reason: string, repairable = false, output = ''): ProofResult {
  return { status: 'unproven', reason, failedTests: [], passedTests: 0, output, repairable };
}

// ---------------------------------------------------------------------------
// Materialising proofs
// ---------------------------------------------------------------------------

/**
 * Whether a reviewer-supplied path is safe and sensible to write into the
 * worktree. The reviewer's output is executed, so this is the trust boundary:
 * relative, inside the tree, shaped like a test for the workspace's runner, and
 * marked `cpm-proof` so it can't be mistaken for (or collide with) real tests.
 * Returns an error message, or null when acceptable.
 */
export function validateProofPath(path: string, profile: TestProfile): string | null {
  if (!path || path.length > 200) return 'The proof path is empty or too long';
  if (!/^[A-Za-z0-9_.@+\-/]+$/.test(path)) return 'The proof path contains unsupported characters';
  if (path.startsWith('/') || path.startsWith('-')) return 'The proof path must be relative to the repository root';
  const segments = path.split('/');
  if (segments.some(s => s === '..' || s === '.' || s === '')) return 'The proof path must not contain "..", "." or empty segments';
  if (segments.some(s => s === '.git' || s === 'node_modules')) return 'The proof path must not be inside .git or node_modules';
  const base = segments[segments.length - 1];
  if (!/cpm[-_]?proof/i.test(base)) return 'The proof file name must contain "cpm-proof" (or "cpm_proof")';
  if (!new RegExp(defaultFilePattern(profile.runner)).test(path)) return `The proof path does not look like a ${profile.runner} test file`;
  return null;
}

/** Side effects the verifier needs, injected so tests need no workspace. */
export interface ProofIO {
  exists(path: string): Promise<boolean>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Run the given proof files; resolves with the harness script's raw output. */
  run(files: string[]): Promise<string>;
}

export interface VerifyArgs {
  issues: ReviewIssue[];
  files: ProofFile[];
  profile: TestProfile;
  io: ProofIO;
  maxProofs?: number;
  /** Epoch ms after which no further test is started (each run is already individually time-limited). */
  deadline?: number;
}

/**
 * Write, run and classify each issue's proof, one file at a time so every result
 * is attributable to exactly one finding. Confirmed tests stay on disk (they are
 * the fix target and become regression tests); everything else is removed, and
 * removal is attempted even when a run throws.
 */
export async function verifyProofs(args: VerifyArgs): Promise<VerifiedIssue[]> {
  const { issues, files, profile, io } = args;
  const limit = args.maxProofs ?? MAX_PROOFS_PER_REVIEW;
  const byPath = new Map(files.map(f => [f.path, f.content]));
  const results = new Map<string, ProofResult>(); // per path: two findings may share one test
  let attempted = 0;

  const out: VerifiedIssue[] = [];
  for (const issue of issues) {
    const path = issue.proofPath;
    if (!path) {
      out.push({ issue, proof: unproven('No test was supplied for this finding') });
      continue;
    }
    const content = byPath.get(path);
    const shown = content?.slice(0, MAX_STORED_CONTENT);
    if (content === undefined) {
      out.push({ issue, proofPath: path, proof: unproven('The test file named by this finding was not provided', true) });
      continue;
    }
    if (results.has(path)) {
      out.push({ issue, proofPath: path, proofContent: shown, proof: results.get(path)! });
      continue;
    }

    const bad = validateProofPath(path, profile);
    if (bad) {
      const r = unproven(bad, true);
      results.set(path, r);
      out.push({ issue, proofPath: path, proofContent: shown, proof: r });
      continue;
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_PROOF_BYTES) {
      const r = unproven('The test file is too large', false);
      results.set(path, r);
      out.push({ issue, proofPath: path, proofContent: shown, proof: r });
      continue;
    }
    if (args.deadline !== undefined && Date.now() > args.deadline) {
      const r = unproven('The verification time budget ran out before this test could be run');
      results.set(path, r);
      out.push({ issue, proofPath: path, proofContent: shown, proof: r });
      continue;
    }
    if (attempted >= limit) {
      const r = unproven(`Over the limit of ${limit} proofs per review`);
      results.set(path, r);
      out.push({ issue, proofPath: path, proofContent: shown, proof: r });
      continue;
    }
    attempted++;

    let result: ProofResult;
    let written = false;
    try {
      // Never overwrite something already in the tree — that would destroy work.
      if (await io.exists(path)) {
        result = unproven('A file already exists at the proof path', true);
      } else {
        written = true; // set first: a write that throws midway may still leave a file
        await io.write(path, content);
        const raw = await io.run([path]);
        result = classifyRun(parseRunOutput(profile.runner, raw));
      }
    } catch (err) {
      result = unproven(`The test could not be run: ${(err as Error).message.slice(0, 200)}`);
    }
    if (written && result.status !== 'confirmed') await io.remove(path).catch(() => {});
    results.set(path, result);
    out.push({ issue, proofPath: path, proofContent: shown, proof: result });
  }
  return out;
}

/**
 * Re-run a confirmed proof after the implementer's fix. Returns whether it now
 * passes; anything other than a clean pass counts as "still failing" — a fix
 * that breaks the test file is not a fix.
 */
export async function rerunProof(
  path: string,
  profile: TestProfile,
  run: (files: string[]) => Promise<string>,
): Promise<{ fixed: boolean; detail: string }> {
  try {
    const result = classifyRun(parseRunOutput(profile.runner, await run([path])));
    if (result.status === 'refuted') return { fixed: true, detail: 'The proof test now passes' };
    return { fixed: false, detail: result.status === 'confirmed' ? result.output || result.reason : result.reason };
  } catch (err) {
    return { fixed: false, detail: `Could not run the proof test: ${(err as Error).message.slice(0, 200)}` };
  }
}

// ---------------------------------------------------------------------------
// Repair round
// ---------------------------------------------------------------------------

/** Verified issues whose proof is worth one repair attempt. */
export function repairable(verified: VerifiedIssue[]): VerifiedIssue[] {
  return verified.filter(v => v.proof.status === 'unproven' && v.proof.repairable);
}

/**
 * Attach the repair round's proof files to the issues that asked for one.
 * A block is matched to an issue by its original path; leftover blocks (the
 * reviewer chose a new path because the old one was rejected) are assigned in
 * order to the issues still unmatched.
 */
export function assignRepairFiles(issues: ReviewIssue[], files: ProofFile[]): { issues: ReviewIssue[]; files: ProofFile[] } {
  const used = new Set<string>();
  const unmatched: number[] = [];
  const next = issues.map((issue, i) => {
    if (issue.proofPath && files.some(f => f.path === issue.proofPath)) {
      used.add(issue.proofPath);
      return issue;
    }
    unmatched.push(i);
    return issue;
  });
  const spare = files.filter(f => !used.has(f.path));
  unmatched.forEach((idx, n) => {
    if (spare[n]) next[idx] = { ...next[idx], proofPath: spare[n].path };
  });
  return { issues: next, files };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface RoutedReview {
  mode: ReviewMode;
  outcome: 'pass' | 'fail';
  /** Findings that send the implementer back to work. */
  blocking: VerifiedIssue[];
  /** Surfaced to the user, never loops. */
  advisory: VerifiedIssue[];
  /** Demonstrably wrong; logged, not shown as findings. */
  refuted: VerifiedIssue[];
}

/**
 * Decide the review's outcome. In proof mode the reviewer's own `outcome` is
 * only a claim: the review fails if and only if a finding was confirmed. In
 * opinion mode (no runnable test setup) the reviewer's word stands, as it did
 * before evidence-based review existed.
 */
export function routeReview(mode: ReviewMode, decision: ReviewDecision, verified: VerifiedIssue[]): RoutedReview {
  if (mode === 'opinion') {
    return { mode, outcome: decision.outcome, blocking: verified, advisory: [], refuted: [] };
  }
  const blocking = verified.filter(v => v.proof.status === 'confirmed');
  return {
    mode,
    outcome: blocking.length > 0 ? 'fail' : 'pass',
    blocking,
    advisory: verified.filter(v => v.proof.status === 'unproven'),
    refuted: verified.filter(v => v.proof.status === 'refuted'),
  };
}

/** A verdict with no per-finding evidence: what an opinion-mode review yields. */
export function opinionIssues(decision: ReviewDecision): VerifiedIssue[] {
  return (decision.issues ?? []).map(issue => ({
    issue,
    proof: { status: 'unproven', reason: 'Opinion-based review — no test run', failedTests: [], passedTests: 0, output: '', repairable: false },
  }));
}

/** One-line tally, e.g. "1 confirmed, 2 refuted, 1 unproven". */
export function tally(routed: RoutedReview): string {
  if (routed.mode === 'opinion') return 'opinion-based review (no test runner configured)';
  const parts = [
    routed.blocking.length && `${routed.blocking.length} confirmed`,
    routed.refuted.length && `${routed.refuted.length} refuted`,
    routed.advisory.length && `${routed.advisory.length} unproven`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no findings';
}

// ---------------------------------------------------------------------------
// Persisted form (task_turns.review_proofs)
// ---------------------------------------------------------------------------

export interface StoredProof {
  defect: string;
  requirement?: string;
  requirementSource?: string;
  path?: string;
  content?: string;
  status: ProofStatus;
  reason: string;
  failedTests: string[];
  output: string;
}

export interface StoredReview {
  mode: ReviewMode;
  proofs: StoredProof[];
  /** 'partial': a pass over code the reviewer did not see. Absent on reviews that predate coverage checking. */
  verdict?: 'pass' | 'fail' | 'partial';
  coverage?: CoverageReport;
}

export function toStored(routed: RoutedReview, all: VerifiedIssue[]): StoredReview {
  return {
    mode: routed.mode,
    proofs: all.map(v => ({
      defect: v.issue.text,
      requirement: v.issue.requirement,
      requirementSource: v.issue.requirementSource,
      path: v.proofPath,
      content: v.proofContent,
      status: v.proof.status,
      reason: v.proof.reason,
      failedTests: v.proof.failedTests,
      output: v.proof.output,
    })),
  };
}

// ---------------------------------------------------------------------------
// Handing findings to the implementer
// ---------------------------------------------------------------------------

/** Appended to any implementer prompt that carries a confirmed finding. */
export const PROOF_INSTRUCTIONS = `A finding marked "FAILING TEST" is backed by a test the harness has already run: it FAILS on your current code. Fix the code so that test passes.
- Do NOT edit, weaken, skip or delete that test to make it pass. If you believe the test itself is wrong, report the finding as "disagree" and say why.
- Leave the test file where it is. It stays in the repository as a regression test, and the harness re-runs it after your turn to check your fix — a claim of "fixed" is verified by running it, not by taking your word.`;

/**
 * Render one finding for the implementer: its ref, the defect, the requirement it
 * was said to violate and — when the harness confirmed it — the failing test.
 * Shared by the auto-review loop and the inbox "Fix" route so both hand over the
 * same evidence.
 */
export function formatFindingForImplementer(
  f: Pick<ReviewFinding, 'id' | 'body' | 'revision' | 'requirement' | 'proof_status' | 'proof_path' | 'proof_output'>,
  opts: { runCommand?: string } = {},
): string {
  const lines = [`[${f.id.slice(0, 8)}] ${f.body}${f.revision > 0 ? '  (RE-RAISED: your previous fix was judged inadequate)' : ''}`];
  if (f.requirement) lines.push(`    Requirement: ${f.requirement}`);
  if (f.proof_status === 'confirmed' && f.proof_path) {
    lines.push(`    FAILING TEST: ${f.proof_path}${opts.runCommand ? `  (run: ${opts.runCommand})` : ''}`);
    if (f.proof_output) lines.push(`    Failure output:\n${f.proof_output.slice(0, 800).split('\n').map(l => '      ' + l).join('\n')}`);
  }
  return lines.join('\n');
}
