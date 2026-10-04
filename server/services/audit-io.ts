/**
 * Workspace-side reads for the auditor, parameterised on an `exec` (ssh in
 * production, a local shell in tests) like review-io.ts. Everything "what did the
 * task change" is relative to the merge-base — BASE_SNIPPET, the one definition.
 *
 * Read-only: the working tree is snapshotted through a throwaway index, so the
 * task's real index is never touched.
 */

import { BASE_SNIPPET, type Exec } from './review-io.js';
import { shellQuote } from './test-runners.js';
import { addedExports } from './added-exports.js';
import { exemptReason } from './review-coverage.js';
import { citedPaths, type LineIndex } from './audit-citations.js';
import type { GuidanceDoc } from './audit-prompt.js';
import type { PackageJsonPair } from './audit-facts.js';

const BASE_M = '@@CPM_BASE@@';
const HEAD_M = '@@CPM_HEAD@@';
const TREE_M = '@@CPM_TREE@@';
const NAMES_M = '@@CPM_NAMES@@';
const DIFF_M = '@@CPM_DIFF@@';

export interface ChangedFile {
  /** A (added), M, D, R (renamed) — the first letter of git's status. */
  status: string;
  path: string;
  oldPath?: string;
}

export interface AuditSnapshot {
  /** Merge-base commit (the current HEAD when the repo has no default branch). */
  baseSha: string;
  headSha: string;
  /** Tree of the worktree now — committed, uncommitted and untracked. */
  tree: string | null;
  files: ChangedFile[];
  /** Unified diff of that tree against the merge-base. */
  diff: string;
}

export function snapshotScript(worktree: string): string {
  return [
    `WT=${shellQuote(worktree)}`,
    BASE_SNIPPET,
    `echo ${BASE_M}$(git -C "$WT" rev-parse "$base" 2>/dev/null)`,
    `echo ${HEAD_M}$(git -C "$WT" rev-parse HEAD 2>/dev/null)`,
    `export GIT_INDEX_FILE="$(mktemp -u)"`,
    `git -C "$WT" read-tree HEAD >/dev/null 2>&1; git -C "$WT" add -A >/dev/null 2>&1`,
    `echo ${TREE_M}$(git -C "$WT" write-tree 2>/dev/null)`,
    `echo ${NAMES_M}`,
    `git -C "$WT" -c core.quotepath=off diff --cached --name-status -M "$base" 2>/dev/null`,
    `echo ${DIFF_M}`,
    `git -C "$WT" -c core.quotepath=off diff --cached --no-color -M "$base" 2>/dev/null`,
    `rm -f "$GIT_INDEX_FILE"`,
  ].join('\n');
}

export function parseSnapshot(out: string): AuditSnapshot {
  const norm = out.replace(/\r\n?/g, '\n');
  const line = (marker: string) => new RegExp(`^${marker}(.*)$`, 'm').exec(norm)?.[1].trim() ?? '';
  const namesAt = norm.indexOf(`${NAMES_M}\n`);
  const diffAt = norm.indexOf(`${DIFF_M}\n`);
  const names = namesAt === -1 ? '' : norm.slice(namesAt + NAMES_M.length + 1, diffAt === -1 ? undefined : diffAt);
  const files: ChangedFile[] = [];
  for (const l of names.split('\n')) {
    const parts = l.split('\t');
    if (parts.length < 2 || !parts[0]) continue;
    const status = parts[0][0];
    if (status === 'R' || status === 'C') files.push({ status: 'R', path: parts[2] ?? parts[1], oldPath: parts[1] });
    else files.push({ status, path: parts[1] });
  }
  const tree = line(TREE_M);
  return {
    baseSha: line(BASE_M),
    headSha: line(HEAD_M),
    tree: /^[0-9a-f]{40,64}$/.test(tree) ? tree : null,
    files,
    diff: diffAt === -1 ? '' : norm.slice(diffAt + DIFF_M.length + 1),
  };
}

/** The change as a snapshot. Throws when the workspace cannot be asked or the merge-base is unknown. */
export async function readSnapshot(exec: Exec, worktree: string): Promise<AuditSnapshot> {
  const snap = parseSnapshot(await exec(snapshotScript(worktree), 30_000, 16 * 1024 * 1024));
  if (!snap.baseSha || !snap.headSha) throw new Error('could not resolve the merge-base of the worktree');
  return snap;
}

// ---------------------------------------------------------------------------
// File contents at the merge-base and now
// ---------------------------------------------------------------------------

const SAFE_PATH = /^[\w@+./-]+$/;
const PAIR_M = '@@CPM_PAIR@@';
const MAX_FILE_BYTES = 200_000;

/** Paths we are willing to interpolate into a shell command (they come from git or from a model's citation). */
const safe = (paths: string[]) => paths.filter(p => SAFE_PATH.test(p) && !p.split('/').includes('..'));

export interface FilePair {
  base: string | null;
  head: string | null;
}

/** `path` → its text at `baseSha` and in the working tree; null = the file is not there. */
export async function readPairs(exec: Exec, worktree: string, baseSha: string, paths: string[]): Promise<Map<string, FilePair>> {
  const wanted = safe(paths).slice(0, 80);
  const out = new Map<string, FilePair>();
  if (wanted.length === 0 || !/^[0-9a-f]{40,64}$/.test(baseSha)) return out;
  const script = [
    `WT=${shellQuote(worktree)}`,
    ...wanted.map(p => {
      const q = shellQuote(p);
      return `echo ${PAIR_M}${q}; ` +
        `if git -C "$WT" cat-file -e ${baseSha}:${q} 2>/dev/null; then git -C "$WT" show ${baseSha}:${q} 2>/dev/null | head -c ${MAX_FILE_BYTES} | base64 -w0; echo; else echo -; fi; ` +
        `if [ -f "$WT"/${q} ]; then head -c ${MAX_FILE_BYTES} "$WT"/${q} | base64 -w0; echo; else echo -; fi`;
    }),
  ].join('\n');
  const raw = (await exec(script, 30_000, 32 * 1024 * 1024)).replace(/\r\n?/g, '\n');
  const dec = (s: string | undefined) => (s === undefined || s.trim() === '-' ? null : Buffer.from(s.trim(), 'base64').toString('utf8'));
  for (const block of raw.split(PAIR_M).slice(1)) {
    const [path, base, head] = block.split('\n');
    if (path) out.set(path.trim(), { base: dec(base), head: dec(head) });
  }
  return out;
}

/** The names a change adds to what files export — the auditor's mandatory reuse checklist. */
export async function readAddedExports(exec: Exec, worktree: string, snap: AuditSnapshot): Promise<Array<{ path: string; name: string }>> {
  const candidates = snap.files
    .filter(f => (f.status === 'A' || f.status === 'M' || f.status === 'R') && /\.([cm]?[jt]sx?|pyi?)$/.test(f.path) && !exemptReason(f.path) && !/(\.|\/)(test|spec)\.|(^|\/)(__tests__|tests?)\//i.test(f.path))
    .slice(0, 60);
  const pairs = await readPairs(exec, worktree, snap.baseSha, candidates.flatMap(f => (f.oldPath ? [f.path, f.oldPath] : [f.path])));
  const out: Array<{ path: string; name: string }> = [];
  for (const f of candidates) {
    const pair = pairs.get(f.path);
    if (!pair || pair.head === null) continue;
    // A renamed file's old exports are not new ones: its base content is under the old path.
    const baseText = (f.oldPath ? pairs.get(f.oldPath)?.base : pair.base) ?? '';
    const added = addedExports(f.path, baseText, pair.head);
    if (!added) continue;
    for (const name of [...added].sort()) if (name !== 'default') out.push({ path: f.path, name });
  }
  return out;
}

export async function readPackageJsons(exec: Exec, worktree: string, snap: AuditSnapshot): Promise<PackageJsonPair[]> {
  const paths = snap.files.filter(f => /(^|\/)package\.json$/.test(f.path)).map(f => f.path);
  const pairs = await readPairs(exec, worktree, snap.baseSha, paths);
  return paths.map(path => ({ path, base: pairs.get(path)?.base ?? null, head: pairs.get(path)?.head ?? null }));
}

// ---------------------------------------------------------------------------
// Citation index
// ---------------------------------------------------------------------------

const LINES_M = '@@CPM_LINES@@';

/** Line counts of every cited file at the merge-base and in the working tree. */
export async function buildLineIndex(exec: Exec, worktree: string, baseSha: string, cites: Array<string | null | undefined>): Promise<LineIndex> {
  const index: LineIndex = { base: new Map(), head: new Map() };
  const paths = safe(citedPaths(cites, worktree)).slice(0, 200);
  if (paths.length === 0 || !/^[0-9a-f]{40,64}$/.test(baseSha)) return index;
  const script = [
    `WT=${shellQuote(worktree)}`,
    ...paths.map(p => {
      const q = shellQuote(p);
      return `b=-1; h=-1; ` +
        `git -C "$WT" cat-file -e ${baseSha}:${q} 2>/dev/null && b=$(git -C "$WT" show ${baseSha}:${q} 2>/dev/null | awk 'END{print NR}'); ` +
        `[ -f "$WT"/${q} ] && h=$(awk 'END{print NR}' "$WT"/${q}); ` +
        `echo "${LINES_M} $b $h "${q}`;
    }),
  ].join('\n');
  const raw = await exec(script, 30_000);
  for (const l of raw.split('\n')) {
    const m = new RegExp(`^${LINES_M} (-?\\d+) (-?\\d+) (.+)$`).exec(l.trim());
    if (!m) continue;
    index.base.set(m[3], parseInt(m[1], 10) < 0 ? null : parseInt(m[1], 10));
    index.head.set(m[3], parseInt(m[2], 10) < 0 ? null : parseInt(m[2], 10));
  }
  return index;
}

// ---------------------------------------------------------------------------
// Architecture guidance
// ---------------------------------------------------------------------------

const DOC_M = '@@CPM_DOC@@';

/** CLAUDE.md, ARCHITECTURE.md and docs/**.md of the worktree (the task's own versions), each capped. */
export async function readGuidanceDocs(exec: Exec, worktree: string): Promise<GuidanceDoc[]> {
  const script = [
    `WT=${shellQuote(worktree)}`,
    `cd "$WT" 2>/dev/null || exit 0`,
    `for f in CLAUDE.md ARCHITECTURE.md $(git ls-files 'docs/*.md' 'docs/**/*.md' 2>/dev/null | head -40); do`,
    `  [ -f "$f" ] && { echo ${DOC_M}"$f"; head -c 60000 "$f" | base64 -w0; echo; }`,
    `done; true`,
  ].join('\n');
  const raw = (await exec(script, 20_000, 16 * 1024 * 1024)).replace(/\r\n?/g, '\n');
  const docs: GuidanceDoc[] = [];
  const seen = new Set<string>();
  for (const block of raw.split(DOC_M).slice(1)) {
    const [path, b64] = block.split('\n');
    if (!path || seen.has(path.trim())) continue;
    seen.add(path.trim());
    docs.push({ path: path.trim(), content: Buffer.from((b64 ?? '').trim(), 'base64').toString('utf8') });
  }
  return docs;
}
