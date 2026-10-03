/**
 * Workspace-side IO for evidence-based review, parameterised on an `exec` that
 * runs a shell command in the task's workspace (over ssh in production, a local
 * shell in tests). Kept out of claude.ts so it can be exercised against real
 * temporary git repositories.
 */

import type { ProofIO } from './review-proof.js';
import { buildRunCommand, shellQuote, type TestProfile } from './test-runners.js';
import { parseNameList, type VerificationIO } from './verification.js';
import { buildReviewDiff, type BuildDiffOptions, type ReviewDiff } from './review-coverage.js';

/** Runs `command` in the workspace and resolves with its (trimmed) stdout. */
export type Exec = (command: string, timeoutMs?: number, maxBuffer?: number) => Promise<string>;

/**
 * Shell fragment that sets `$base` to the merge-base of HEAD with the default
 * branch (falling back to HEAD when the repo has none). EVERY question of the
 * form "what did this task change?" is answered relative to this — never with
 * `git status` alone. An implementer that commits its work leaves a clean
 * porcelain, and a porcelain-only check then reads a fully-implemented task as
 * "nothing to review" (seen on two production tasks: auto_review=1, no reviewer
 * turn). Expects `$WT` to be set.
 */
export const BASE_SNIPPET =
  `base=""; for r in origin/main main origin/master master; do ` +
  `git -C "$WT" rev-parse --verify --quiet "$r" >/dev/null 2>&1 && { base=$(git -C "$WT" merge-base "$r" HEAD 2>/dev/null); break; }; done; ` +
  `[ -n "$base" ] || base=HEAD`;

const CHANGES_MARKER = '@@CPM_CHANGES@@';
const UNTRACKED_MARKER = '@@CPM_UNTRACKED@@';

/** Prints `@@CPM_CHANGES@@yes|no`: does the task have ANY work — committed, uncommitted or untracked? */
export function changesScript(worktree: string): string {
  return [
    `WT=${shellQuote(worktree)}`,
    BASE_SNIPPET,
    `if [ -n "$(git -C "$WT" status --porcelain 2>/dev/null)" ]; then echo ${CHANGES_MARKER}yes; exit 0; fi`,
    // Exit 1 = differences, 0 = none; anything else (a git error) reads as "yes": fail toward reviewing.
    `git -C "$WT" diff --quiet "$base" HEAD 2>/dev/null && echo ${CHANGES_MARKER}no || echo ${CHANGES_MARKER}yes`,
  ].join('\n');
}

/**
 * Whether the task's branch has any work relative to the default branch. Throws
 * when the workspace can't be asked — the caller must NOT read that as "no
 * changes", which would silently skip the review.
 */
export async function hasBranchChanges(exec: Exec, worktree: string): Promise<boolean> {
  const out = await exec(changesScript(worktree), 20_000);
  const m = new RegExp(`${CHANGES_MARKER}(yes|no)`).exec(out);
  if (!m) throw new Error(`could not determine whether the worktree has changes: ${out.slice(0, 120)}`);
  return m[1] === 'yes';
}

/** Everything the task changed vs the default branch: the tracked diff (committed + uncommitted), then untracked file names. */
export function reviewDiffScript(worktree: string): string {
  return [
    `WT=${shellQuote(worktree)}`,
    BASE_SNIPPET,
    `git -C "$WT" -c core.quotepath=off diff --no-color "$base" 2>/dev/null`,
    `echo ${UNTRACKED_MARKER}`,
    `git -C "$WT" ls-files --others --exclude-standard 2>/dev/null`,
  ].join('\n');
}

/**
 * The diff handed to the reviewer, capped at ~8000 tokens, together with the
 * harness's record of which changed files did not fit (see review-coverage.ts).
 * Same merge-base definition of "changed" as everything else in this file.
 */
export async function getReviewDiffInfo(
  exec: Exec,
  worktree: string,
  maxChars = 32_000,
  opts: BuildDiffOptions = {},
): Promise<ReviewDiff> {
  const out = await exec(reviewDiffScript(worktree), 30_000, 16 * 1024 * 1024);
  const [diff, untracked] = out.replace(/\r\n?/g, '\n').split(UNTRACKED_MARKER);
  return buildReviewDiff(diff ?? '', parseNameList(untracked ?? ''), maxChars, opts);
}

/** The diff text alone. */
export async function getReviewDiff(exec: Exec, worktree: string, maxChars = 32_000): Promise<string> {
  return (await getReviewDiffInfo(exec, worktree, maxChars)).text;
}

const RUN_BUFFER = 8 * 1024 * 1024;
/** Runner timeouts (buildRunCommand: 120s per file, 180s per suite) plus slack for ssh and startup. */
const FILE_RUN_MS = 150_000;
const SUITE_RUN_MS = 210_000;

/**
 * File operations + test runs for verifying the reviewer's proofs, in the task's
 * worktree. File content travels base64-encoded: it is arbitrary code, and shell
 * quoting of it (apostrophes above all) is not something to trust.
 */
export function makeProofIO(exec: Exec, worktree: string, profile: TestProfile): ProofIO {
  const wt = worktree.replace(/\/$/, '');
  const abs = (p: string) => shellQuote(`${wt}/${p}`);
  return {
    exists: async p => (await exec(`test -e ${abs(p)} && echo yes || echo no`)).trim().endsWith('yes'),
    write: async (p, content) => {
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';
      const b64 = Buffer.from(content, 'utf8').toString('base64');
      await exec(`mkdir -p ${abs(dir)} && printf %s '${b64}' | base64 -d > ${abs(p)}`);
    },
    remove: async p => { await exec(`rm -f ${abs(p)}`); },
    run: files => exec(buildRunCommand(profile, worktree, files), FILE_RUN_MS, RUN_BUFFER),
  };
}

/**
 * Shell that prints `@@CPM_BASE_DIR@@ <dir>`: a scratch copy of the code as it
 * was before the task (merge-base with the default branch), with `files` laid
 * over it. Prints `@@CPM_NO_BASE@@` when there is nothing to compare with.
 */
export function baselineScript(worktree: string, files: string[]): string {
  const wt = shellQuote(worktree);
  const copies = files
    .map(f => `mkdir -p "$S/$(dirname ${shellQuote(f)})" && cp ${wt}/${shellQuote(f)} "$S/"${shellQuote(f)}`)
    .join('; ');
  return [
    `WT=${wt}`,
    `base=""; for r in origin/main main origin/master master; do git -C "$WT" rev-parse --verify --quiet "$r" >/dev/null 2>&1 && { base=$(git -C "$WT" merge-base "$r" HEAD 2>/dev/null); break; }; done`,
    `[ -n "$base" ] || { echo "@@CPM_NO_BASE@@"; exit 0; }`,
    `S="$(mktemp -d)"`,
    // git archive: tracked files at the base commit, with no worktree metadata left in the repo.
    `git -C "$WT" archive "$base" | tar -x -C "$S" || { rm -rf "$S"; echo "@@CPM_NO_BASE@@"; exit 0; }`,
    copies,
    // Share the dependencies rather than reinstalling them.
    `[ -d "$WT/node_modules" ] && [ ! -e "$S/node_modules" ] && ln -s "$WT/node_modules" "$S/node_modules"`,
    `echo "@@CPM_BASE_DIR@@ $S"`,
  ].join('\n');
}

/** Only ever rm -rf something that looks like a `mktemp -d` result. */
export function isScratchDir(dir: string): boolean {
  return /^\/[\w./-]*tmp[\w./-]*\/[\w.-]+$/.test(dir) && !dir.includes('..');
}

export function makeVerificationIO(exec: Exec, worktree: string, profile: TestProfile): VerificationIO {
  const runScript = (dir: string, files: string[]) =>
    exec(buildRunCommand(profile, dir, files), files.length ? FILE_RUN_MS : SUITE_RUN_MS, RUN_BUFFER);
  return {
    changedPaths: async () => {
      // Relative to the merge-base, so committed work counts (see BASE_SNIPPET).
      // Bracketed because exec trims its output. Deletions are excluded.
      const out = await exec([
        `WT=${shellQuote(worktree)}`,
        BASE_SNIPPET,
        `echo @@S@@`,
        `{ git -C "$WT" -c core.quotepath=off diff --name-only --no-renames --diff-filter=d "$base" 2>/dev/null; git -C "$WT" ls-files --others --exclude-standard 2>/dev/null; } | sort -u`,
      ].join('\n'));
      return parseNameList(out.split('@@S@@')[1] ?? '');
    },
    addedPaths: async () => {
      // --no-renames: a renamed file's new path is absent at the base, so it counts as added.
      const out = await exec([
        `WT=${shellQuote(worktree)}`,
        BASE_SNIPPET,
        `echo @@S@@`,
        `{ git -C "$WT" -c core.quotepath=off diff --name-only --no-renames --diff-filter=A "$base" 2>/dev/null; git -C "$WT" ls-files --others --exclude-standard 2>/dev/null; } | sort -u`,
      ].join('\n'));
      return parseNameList(out.split('@@S@@')[1] ?? '');
    },
    baseSources: async files => {
      if (files.length === 0) return {};
      const parts = files.map(f =>
        `echo "@@CPM_F@@ "${shellQuote(f)}; if git -C "$WT" cat-file -e "$base":${shellQuote(f)} 2>/dev/null; then echo @@CPM_HAVE@@; git -C "$WT" show "$base":${shellQuote(f)} 2>/dev/null; else echo @@CPM_ABSENT@@; fi`);
      const out = await exec([`WT=${shellQuote(worktree)}`, BASE_SNIPPET, `[ -n "$base" ] || exit 0`, `echo @@S@@`, ...parts].join('\n'), 60_000);
      const result: Record<string, string | null> = {};
      for (const chunk of (out.split('@@S@@')[1] ?? '').split('@@CPM_F@@ ').slice(1)) {
        const nl = chunk.indexOf('\n');
        if (nl < 0) continue;
        const file = chunk.slice(0, nl).trim();
        const body = chunk.slice(nl + 1);
        if (body.startsWith('@@CPM_ABSENT@@')) result[file] = null;
        else if (body.startsWith('@@CPM_HAVE@@')) result[file] = body.slice('@@CPM_HAVE@@'.length).replace(/^\r?\n/, '');
      }
      return result;
    },
    fingerprint: async () => {
      const out = await exec([
        `WT=${shellQuote(worktree)}`,
        BASE_SNIPPET,
        // HEAD + the whole diff against the base + the contents of untracked files.
        `{ git -C "$WT" rev-parse HEAD; git -C "$WT" diff "$base"; (cd "$WT" && git ls-files -o --exclude-standard -z | xargs -0 -r sha1sum); } 2>/dev/null | sha1sum | cut -d' ' -f1`,
      ].join('\n'), 60_000);
      const fp = out.trim().split(/\s+/)[0] ?? '';
      if (!/^[0-9a-f]{40}$/.test(fp)) throw new Error('could not fingerprint the worktree');
      return fp;
    },
    run: files => runScript(worktree, files),
    runSuite: () => runScript(worktree, []),
    prepareBaseline: async files => {
      const out = await exec(baselineScript(worktree, files), 60_000);
      const m = /@@CPM_BASE_DIR@@ (\S+)/.exec(out);
      return m ? { dir: m[1] } : null;
    },
    runIn: (dir, files) => runScript(dir, files),
    cleanupBaseline: async dir => {
      if (!isScratchDir(dir)) return;
      await exec(`rm -rf ${shellQuote(dir)}`);
    },
  };
}
