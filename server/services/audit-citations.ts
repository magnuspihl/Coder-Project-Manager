/**
 * Citation checking for the auditor. The auditor cites `file:line` for every
 * finding; a model can invent a plausible path or a line past the end of a file,
 * so the harness resolves each citation against the repository before the human
 * sees it. Pure — the file lengths come in as an index built by audit-io.ts.
 */

export interface Cite {
  path: string;
  start: number;
  end: number;
}

/** Which tree a citation must resolve in. */
export type CiteExpect = 'base' | 'head' | 'either';

export interface CheckedCite {
  /** The citation as the auditor wrote it. */
  cite: string;
  ok: boolean;
  /** The tree it resolved in; null when it did not resolve. */
  tree: 'base' | 'head' | null;
  reason?: string;
}

/** Line counts of files at the merge-base and in the current tree; `null` = the file is not there. */
export interface LineIndex {
  base: Map<string, number | null>;
  head: Map<string, number | null>;
}

/**
 * `src/a.ts:12`, `src/a.ts:12-30`, `src/a.ts:12–30`, `src/a.ts#L12-L30`, optionally
 * wrapped in backticks. Returns null for anything that is not file + line.
 */
export function parseCite(raw: string, worktree?: string): Cite | null {
  let s = raw.trim().replace(/^[`'"(\[]+|[`'")\].,;]+$/g, '');
  if (worktree && s.startsWith(worktree.replace(/\/+$/, '') + '/')) s = s.slice(worktree.replace(/\/+$/, '').length + 1);
  s = s.replace(/^\.\//, '');
  const m = /^(.+?)(?::|#L)(\d+)(?:\s*[-–]\s*L?(\d+))?$/.exec(s);
  if (!m) return null;
  const path = m[1].trim();
  if (!path || path.startsWith('/') || path.split('/').includes('..')) return null;
  const start = parseInt(m[2], 10);
  const end = m[3] ? parseInt(m[3], 10) : start;
  if (start < 1 || end < start) return null;
  return { path, start, end };
}

/** Repo-relative paths of every parseable citation — what audit-io.ts has to measure. */
export function citedPaths(cites: Array<string | null | undefined>, worktree?: string): string[] {
  const out = new Set<string>();
  for (const c of cites) {
    const p = c ? parseCite(c, worktree) : null;
    if (p) out.add(p.path);
  }
  return [...out];
}

/** Resolve one citation. Never throws and never trusts: anything unresolvable says why. */
export function checkCite(raw: string | null | undefined, index: LineIndex, expect: CiteExpect, worktree?: string): CheckedCite {
  const cite = (raw ?? '').trim();
  if (!cite) return { cite, ok: false, tree: null, reason: 'no citation given' };
  const p = parseCite(cite, worktree);
  if (!p) return { cite, ok: false, tree: null, reason: 'not a file:line citation' };

  const inBase = index.base.get(p.path) ?? null;
  const inHead = index.head.get(p.path) ?? null;
  const fits = (n: number | null) => n !== null && p.end <= n;

  const order: Array<'base' | 'head'> = expect === 'base' ? ['base'] : expect === 'head' ? ['head'] : ['head', 'base'];
  for (const tree of order) {
    if (fits(tree === 'base' ? inBase : inHead)) return { cite, ok: true, tree };
  }

  const where = expect === 'base' ? 'at the merge-base' : expect === 'head' ? 'in the current tree' : 'in the repository';
  const wanted = order.map(t => (t === 'base' ? inBase : inHead)).find(n => n !== null);
  if (wanted !== undefined && wanted !== null) {
    return { cite, ok: false, tree: null, reason: `${p.path} has ${wanted} lines ${where}; the citation reaches line ${p.end}` };
  }
  if (expect === 'base' && inHead !== null) {
    return { cite, ok: false, tree: null, reason: `${p.path} does not exist at the merge-base — it was added by this task, so it is not pre-existing code` };
  }
  return { cite, ok: false, tree: null, reason: `${p.path} does not exist ${where}` };
}
