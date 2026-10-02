/**
 * Review coverage: what the reviewer was SHOWN, what it actually READ, and
 * whether a "pass" can be believed. Pure — no IO — so it is tested directly.
 *
 * Why this exists: a reviewer handed a truncated diff used to say "I didn't see
 * verification.ts" in its prose and still emit `pass`. The harness now knows
 * which files the diff left out, makes reading them an explicit obligation, and
 * checks the reviewer's own tool calls rather than its claim.
 */

import type { ReviewCoverage } from './review-verdict.js';

/** A changed file whose diff the reviewer was not (fully) given. */
export interface OmittedFile {
  path: string;
  /** Why it is not in the diff: too big for the budget, cut mid-file, untracked, deleted. */
  reason: string;
  /** For a file whose diff was cut at a hunk boundary: how many hunks were shown of how many. */
  hunksShown?: number;
  hunksTotal?: number;
  /** Deleted files can't be Read; the reviewer inspects them with `git diff` / `git show`. */
  deleted?: boolean;
}

export interface ExemptFile {
  path: string;
  reason: string;
}

/** The diff handed to the reviewer, plus the harness's record of what it left out. */
export interface ReviewDiff {
  text: string;
  /** Every changed, non-exempt file (merge-base diff + untracked — see review-io.ts BASE_SNIPPET). */
  changed: string[];
  /** Changed files whose whole diff is in `text`. */
  shown: string[];
  omitted: OmittedFile[];
  exempt: ExemptFile[];
}

// ---------------------------------------------------------------------------
// Exemptions
// ---------------------------------------------------------------------------

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
  'Cargo.lock', 'go.sum', 'poetry.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'uv.lock',
  'packages.lock.json', 'flake.lock',
]);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|wasm|mp[34]|mov|onnx|bin)$/i;
const GENERATED = /(\.min\.(js|css)|\.map|\.generated\.\w+|\.pb\.go|_pb2\.py)$/i;
const GENERATED_DIR = /(^|\/)(dist|build|coverage|node_modules|\.next|__generated__)\//;

/** Why a file needs no review, or null if it does. Lockfiles and generated/binary output are exempt. */
export function exemptReason(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (LOCKFILES.has(base)) return 'lockfile';
  if (BINARY_EXT.test(base)) return 'binary file';
  if (GENERATED.test(base) || GENERATED_DIR.test(path)) return 'generated output';
  return null;
}

// ---------------------------------------------------------------------------
// Building the diff
// ---------------------------------------------------------------------------

interface Section {
  path: string;
  header: string;
  hunks: string[];
  text: string;
  deleted: boolean;
  binary: boolean;
}

/** Split `git diff` output into per-file sections, each with its hunks. */
export function splitDiff(raw: string): Section[] {
  const sections: Section[] = [];
  const parts = raw.replace(/\r\n?/g, '\n').split(/^(?=diff --git )/m).filter(p => p.startsWith('diff --git '));
  for (const part of parts) {
    const headerLine = part.slice(0, part.indexOf('\n') === -1 ? undefined : part.indexOf('\n'));
    const rest = headerLine.slice('diff --git a/'.length);
    // `a/P b/P` for everything but a rename; for a rename the new path is the last ` b/` segment.
    const half = (rest.length - 3) / 2;
    const path = Number.isInteger(half) && rest.slice(half, half + 3) === ' b/' && rest.slice(0, half) === rest.slice(half + 3)
      ? rest.slice(0, half)
      : rest.slice(rest.lastIndexOf(' b/') + 3);
    const firstHunk = part.search(/^@@ /m);
    const header = firstHunk === -1 ? part : part.slice(0, firstHunk);
    const hunks = firstHunk === -1 ? [] : part.slice(firstHunk).split(/^(?=@@ )/m);
    sections.push({
      path,
      header,
      hunks,
      text: part.endsWith('\n') ? part : part + '\n',
      deleted: /^deleted file mode /m.test(header),
      binary: /^Binary files .* differ$|^GIT binary patch/m.test(part),
    });
  }
  return sections;
}

/** A partial diff is only worth showing when a meaningful amount of budget is left. */
const MIN_PARTIAL_BUDGET = 3000;

export interface BuildDiffOptions {
  /**
   * Restrict the review to these files — a "review remaining files" re-run, which
   * is only about what an earlier pass did not see. Everything else is out of
   * scope: neither shown nor counted as unreviewed.
   */
  onlyFiles?: string[];
}

/**
 * Fit the task's changes into `maxChars`, whole files at a time (a file is only
 * ever cut at a hunk boundary), and record exactly what did not fit. Generated and lockfile
 * diffs are left out first — they cost budget and need no review — and listed as
 * exempt. Untracked files carry no diff at all, so they are always "omitted":
 * the reviewer has to Read them.
 */
export function buildReviewDiff(rawDiff: string, untracked: string[], maxChars: number, opts: BuildDiffOptions = {}): ReviewDiff {
  const scope = opts.onlyFiles ? new Set(opts.onlyFiles) : null;
  const sections = splitDiff(rawDiff).filter(s => !scope || scope.has(s.path));
  untracked = untracked.filter(f => !scope || scope.has(f));
  const exempt: ExemptFile[] = [];
  const candidates: Section[] = [];
  for (const s of sections) {
    const why = s.binary ? 'binary file' : exemptReason(s.path);
    if (why) exempt.push({ path: s.path, reason: why });
    else candidates.push(s);
  }
  for (const f of untracked) {
    const why = exemptReason(f);
    if (why) exempt.push({ path: f, reason: why });
  }
  const untrackedNeeded = untracked.filter(f => !exemptReason(f));

  const untrackedBlock = untrackedNeeded.length ? `Untracked files:\n${untrackedNeeded.join('\n')}` : '';
  let remaining = Math.max(0, maxChars - untrackedBlock.length - 600); // 600: room for the notes below

  const order = candidates;
  const included = new Map<Section, string>();
  const omitted: OmittedFile[] = [];
  const shown: string[] = [];
  let partialSpent = false;

  for (const s of order) {
    if (s.text.length <= remaining) {
      included.set(s, s.text);
      remaining -= s.text.length;
      shown.push(s.path);
      continue;
    }
    // Too big. Show its leading hunks if there is a worthwhile amount of room — once.
    if (!partialSpent && remaining >= MIN_PARTIAL_BUDGET && s.hunks.length > 1) {
      let used = s.header.length;
      let n = 0;
      while (n < s.hunks.length && used + s.hunks[n].length <= remaining) used += s.hunks[n++].length;
      if (n > 0 && n < s.hunks.length) {
        included.set(s, s.header + s.hunks.slice(0, n).join(''));
        remaining -= used;
        partialSpent = true;
        omitted.push({ path: s.path, reason: 'diff cut at a hunk boundary', hunksShown: n, hunksTotal: s.hunks.length });
        continue;
      }
    }
    omitted.push({ path: s.path, reason: 'too large for the diff budget', ...(s.deleted ? { deleted: true } : {}), hunksShown: 0, hunksTotal: s.hunks.length });
  }
  for (const f of untrackedNeeded) omitted.push({ path: f, reason: 'untracked — its content is not in the diff' });

  const body = candidates.filter(s => included.has(s)).map(s => included.get(s)!.trimEnd()).join('\n');
  const notes: string[] = [];
  if (exempt.length) notes.push(`Diff left out as exempt from review (${exempt.map(e => `${e.path}: ${e.reason}`).join('; ')}).`);
  const parts = [body, untrackedBlock, notes.join('\n')].filter(Boolean);
  const text = parts.join('\n\n');

  const changed = [...new Set([...candidates.map(s => s.path), ...untrackedNeeded])];
  const omittedPaths = new Set(omitted.map(o => o.path));
  return {
    text: text || '(no diff output)',
    changed,
    shown: shown.filter(p => !omittedPaths.has(p)),
    omitted,
    exempt,
  };
}

/** The part of the reviewer prompt that makes reading the omitted files an obligation. Empty when nothing was left out. */
export function omittedFilesBlock(diff: ReviewDiff): string {
  if (diff.omitted.length === 0) return '';
  const list = diff.omitted.map(o => {
    const hunks = o.hunksTotal ? ` (${o.hunksShown ?? 0} of ${o.hunksTotal} hunks shown)` : '';
    const how = o.deleted ? ' — deleted: inspect with `git diff` / `git show`' : '';
    return `- ${o.path} — ${o.reason}${hunks}${how}`;
  }).join('\n');
  const exempt = diff.exempt.length
    ? `\nExempt from review (generated or lockfile — you need not read these):\n${diff.exempt.map(e => `- ${e.path} (${e.reason})`).join('\n')}\n`
    : '';
  return `\nTHE DIFF ABOVE IS INCOMPLETE. These changed files were NOT (fully) shown to you:\n${list}\n${exempt}
You MUST open EVERY file in that list with Read (or Grep on that file) BEFORE you emit a verdict. The harness checks your tool calls: a file you did not read counts as unreviewed no matter what you claim, and a "pass" with unreviewed files is reported to the user as a PARTIAL review, not a pass. Do not skip files because they look unimportant.\n`;
}

/** Only the exempt note, for a diff that fit entirely. */
export function exemptNote(diff: ReviewDiff): string {
  return diff.omitted.length === 0 && diff.exempt.length
    ? `\n(${diff.exempt.length} generated/lockfile diff(s) were left out as exempt: ${diff.exempt.map(e => e.path).join(', ')}.)\n`
    : '';
}

// ---------------------------------------------------------------------------
// Turn budget
// ---------------------------------------------------------------------------

/** Extra turns per omitted file, and the ceiling on the bonus (token cost grows with turns). */
const TURNS_PER_OMITTED_FILE = 3;
const MAX_EXTRA_TURNS = 24;

/** The reviewer's turn cap, raised modestly for each file it has to open beyond the diff. */
export function reviewerTurnCap(base: number, omittedFiles: number): number {
  return base + Math.min(omittedFiles * TURNS_PER_OMITTED_FILE, MAX_EXTRA_TURNS);
}

// ---------------------------------------------------------------------------
// Tool-call evidence
// ---------------------------------------------------------------------------

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** The tool_use blocks of one stream-json assistant message content array. */
export function toolCallsFromContent(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap(b => {
    if (!b || typeof b !== 'object') return [];
    const o = b as { type?: unknown; name?: unknown; input?: unknown };
    if (o.type !== 'tool_use' || typeof o.name !== 'string') return [];
    return [{ name: o.name, input: o.input && typeof o.input === 'object' ? o.input as Record<string, unknown> : {} }];
  });
}

/** Repo-relative form of a path a tool was given (absolute worktree paths and `./` are stripped). */
export function relativeTo(worktree: string, p: string): string {
  const wt = worktree.replace(/\/+$/, '');
  let out = p.trim();
  if (wt && out.startsWith(wt + '/')) out = out.slice(wt.length + 1);
  return out.replace(/^\.\//, '');
}

/**
 * Which of `candidates` the reviewer opened. Read of the file, Grep pointed at
 * the file itself, or a (read-only) Bash command naming it (`sed -n`, `git diff
 * -- path`, `cat`…). A Grep over a directory is a search, not a read, so it does
 * not count.
 */
export function filesOpened(calls: ToolCall[], worktree: string, candidates: string[]): Set<string> {
  const opened = new Set<string>();
  const want = new Set(candidates);
  for (const c of calls) {
    if (c.name === 'Read' && typeof c.input.file_path === 'string') {
      const p = relativeTo(worktree, c.input.file_path);
      if (want.has(p)) opened.add(p);
    } else if (c.name === 'Grep' && typeof c.input.path === 'string') {
      const p = relativeTo(worktree, c.input.path);
      if (want.has(p)) opened.add(p);
    } else if (c.name === 'Bash' && typeof c.input.command === 'string') {
      const cmd = c.input.command.replace(worktree.replace(/\/+$/, '') + '/', '');
      for (const f of candidates) if (cmd.includes(f)) opened.add(f);
    }
  }
  return opened;
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

export interface UnreviewedFile {
  path: string;
  reason: string;
}

/** What the harness concluded about coverage; stored with the review for the UI. */
export interface CoverageReport {
  /** Files whose content the reviewer demonstrably saw: shown in the diff, or opened with a tool. */
  reviewed: string[];
  /** Subset of `reviewed` that were opened via tool calls (beyond the diff). */
  readViaTool: string[];
  unreviewed: UnreviewedFile[];
  exempt: ExemptFile[];
  /** The reviewer gave no usable coverage field, so only the tool-call evidence was used. */
  claimUnverified: boolean;
  /** The reviewer ran out of turns while reading. */
  stoppedByTurnCap: boolean;
  turnCap?: number;
}

export interface AssessInput {
  diff: ReviewDiff;
  worktree: string;
  toolCalls: ToolCall[];
  /** The reviewer's own account; absent or garbled is fine. */
  claimed?: ReviewCoverage;
  stoppedByTurnCap?: boolean;
  turnCap?: number;
}

/**
 * A changed, non-exempt file is reviewed only if its whole diff was shown or the
 * reviewer opened it — whatever the reviewer says. The reviewer's own admission
 * ("I didn't read X") is also honoured: it can only ADD to the unreviewed set,
 * never remove from it, and never beat a tool call that proves it opened the file.
 */
export function assessCoverage(input: AssessInput): CoverageReport {
  const { diff, claimed } = input;
  const opened = filesOpened(input.toolCalls, input.worktree, diff.changed);
  const shown = new Set(diff.shown);
  const omitted = new Map(diff.omitted.map(o => [o.path, o]));
  const admitted = new Map((claimed?.notReviewed ?? []).filter(n => diff.changed.includes(n.file)).map(n => [n.file, n.reason]));

  const reviewed: string[] = [];
  const unreviewed: UnreviewedFile[] = [];
  for (const path of diff.changed) {
    if (opened.has(path)) { reviewed.push(path); continue; }
    const om = omitted.get(path);
    if (om) {
      const hunks = om.hunksTotal && om.hunksShown ? ` (${om.hunksShown} of ${om.hunksTotal} hunks shown)` : '';
      unreviewed.push({ path, reason: `${om.reason}${hunks}; never opened with Read/Grep` });
    } else if (admitted.has(path)) {
      unreviewed.push({ path, reason: admitted.get(path) || 'the reviewer says it did not read this' });
    } else if (shown.has(path)) {
      reviewed.push(path);
    }
  }
  return {
    reviewed,
    readViaTool: reviewed.filter(p => opened.has(p)),
    unreviewed,
    exempt: diff.exempt,
    claimUnverified: !claimed,
    stoppedByTurnCap: !!input.stoppedByTurnCap,
    ...(input.turnCap ? { turnCap: input.turnCap } : {}),
  };
}

export type ReviewVerdictKind = 'pass' | 'fail' | 'partial';

/**
 * A fail with confirmed proof stays a fail whatever the coverage. A pass only
 * stays a pass when nothing non-exempt went unseen; otherwise it is "partial".
 */
export function coverageOutcome(outcome: 'pass' | 'fail', report: CoverageReport | null): ReviewVerdictKind {
  if (outcome === 'fail') return 'fail';
  return report && report.unreviewed.length > 0 ? 'partial' : 'pass';
}

/** "Partial review — not seen: a.ts, b.ts (+2 more)". */
export function partialLabel(report: Pick<CoverageReport, 'unreviewed'>, max = 4): string {
  const names = report.unreviewed.map(u => u.path);
  const head = names.slice(0, max).join(', ');
  return `Partial review — not seen: ${head}${names.length > max ? ` (+${names.length - max} more)` : ''}`;
}

/** The sentence the harness adds to the task conversation for a partial review. */
export function partialMessage(report: CoverageReport): string {
  const lines = report.unreviewed.map(u => `- ${u.path} — ${u.reason}`).join('\n');
  const cap = report.stoppedByTurnCap
    ? ` The reviewer hit its turn limit${report.turnCap ? ` (${report.turnCap})` : ''} before it could read everything, so this is a budget stop, not a finding.`
    : '';
  return `${partialLabel(report, 6)}.${cap} The reviewer found no confirmed defect in what it saw, but it did not see these files, so this is NOT a pass:\n${lines}\nNothing is wrong with the code as far as is known — use "Review remaining files" to have the reviewer read only these.`;
}
