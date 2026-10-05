/**
 * Whose code is an audit finding about? Most findings are about code the task
 * itself introduced, and those are fixed IN the task: a new task branched from
 * the default branch would not even contain the code until this one merges.
 *
 * Decided mechanically, line-level, from the finding's already-verified
 * citations and the merge-base diff the audit read (the same definition of
 * "changed" as review-io.ts). Pure — no IO. Also the "resolved since the last
 * audit" diff, by finding identity.
 */

import { splitDiff } from './review-coverage.js';
import { parseCite, type CheckedCite } from './audit-citations.js';
import type { AuditReport, Ownership, ResolvedFinding } from './audit-report.js';

type Range = [number, number];

export interface FileChange {
  /** The task added this file. */
  added: boolean;
  /** Line ranges of the current file that the task added or rewrote. */
  newLines: Range[];
  /** Line ranges of the merge-base file that the task removed or rewrote. */
  oldLines: Range[];
}

export type ChangeMap = Map<string, FileChange>;

function push(ranges: Range[], line: number): void {
  const last = ranges[ranges.length - 1];
  if (last && last[1] === line - 1) last[1] = line;
  else ranges.push([line, line]);
}

/** path → which lines the diff touched, on both sides. */
export function parseChangeMap(diff: string): ChangeMap {
  const out: ChangeMap = new Map();
  for (const s of splitDiff(diff)) {
    const change: FileChange = { added: /^new file mode /m.test(s.header), newLines: [], oldLines: [] };
    for (const hunk of s.hunks) {
      const lines = hunk.split('\n');
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[0] ?? '');
      if (!m) continue;
      let oldLine = parseInt(m[1], 10);
      let newLine = parseInt(m[2], 10);
      for (const l of lines.slice(1)) {
        if (l.startsWith('+')) push(change.newLines, newLine++);
        else if (l.startsWith('-')) push(change.oldLines, oldLine++);
        else if (l.startsWith('\\')) continue;
        else if (l.length > 0 || l === ' ') { oldLine++; newLine++; }
      }
    }
    out.set(s.path, change);
  }
  return out;
}

const overlaps = (ranges: Range[], start: number, end: number) => ranges.some(([a, b]) => a <= end && start <= b);

/** Classify one finding from its checked citations. */
export function classifyCites(checks: Array<CheckedCite | undefined>, changes: ChangeMap, worktree?: string): Ownership {
  const verified = checks.filter((c): c is CheckedCite => !!c && c.ok && !!c.tree);
  if (verified.length === 0) {
    return { owner: 'task', basis: 'unverified', reason: 'no citation could be verified, so it is treated as this task\'s own' };
  }
  let addedFile = false;
  for (const c of verified) {
    const p = parseCite(c.cite, worktree);
    const change = p ? changes.get(p.path) : undefined;
    if (!p || !change) continue;
    if (c.tree === 'head') {
      if (overlaps(change.newLines, p.start, p.end)) return { owner: 'task', basis: 'lines', reason: 'cites lines this task changed' };
      if (change.added) addedFile = true;
    } else if (overlaps(change.oldLines, p.start, p.end)) {
      return { owner: 'task', basis: 'lines', reason: 'cites lines this task changed' };
    }
  }
  if (addedFile) return { owner: 'task', basis: 'added_file', reason: 'cites a file this task added' };
  return { owner: 'pre_existing', basis: 'untouched', reason: 'every verified citation points at code this task did not change' };
}

/** Finding id → ownership, for every finding the report carries. */
export function classifyReport(report: AuditReport, changes: ChangeMap, worktree?: string): Record<string, Ownership> {
  const out: Record<string, Ownership> = {};
  for (const r of report.reuseFindings) {
    // Only citations that were given count; "no existing code" is not an unverified citation.
    const checks = [r.newCite ? r.checks?.new : undefined, r.existingCite ? r.checks?.existing : undefined];
    out[r.id] = classifyCites(checks, changes, worktree);
  }
  for (const d of report.deviations) out[d.id] = classifyCites(d.checks ?? [], changes, worktree);
  for (const x of report.discrepancies ?? []) out[x.id] = classifyCites(x.checks ?? [], changes, worktree);
  // Hard-to-reverse facts are computed from the diff, so they are by definition the task's.
  for (const h of report.hardToReverse) out[h.id] = { owner: 'task', basis: 'harness', reason: 'computed from this task\'s diff' };
  return out;
}

// ---------------------------------------------------------------------------
// Resolved since the last audit
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const pathsOf = (cites: Array<string | null | undefined>) =>
  cites.map(c => (c ? parseCite(c)?.path ?? norm(c) : '')).filter(Boolean).sort().join(',');

interface Identified extends ResolvedFinding { key: string; discrepancy?: true }

/** The actionable findings of a report, each with a stable identity: name/kind + cited path. */
function identified(r: AuditReport): Identified[] {
  const out: Identified[] = [];
  for (const f of r.reuseFindings) {
    if (f.kind !== 'possible_duplicate') continue;
    out.push({ key: `dup|${norm(f.name)}|${pathsOf([f.newCite, f.existingCite])}`, label: 'possible duplicate', text: `${f.name} — ${f.note}` });
  }
  // Prose has no name, so the head of the text stands in for one. A reworded finding therefore
  // reads as "resolved" plus a new one; the cost of a simple identity.
  for (const d of r.deviations) out.push({ key: `dev|${norm(d.text).slice(0, 60)}|${pathsOf(d.cites)}`, label: 'deviation', text: d.text });
  for (const h of r.hardToReverse) out.push({ key: `hard|${h.kind}|${norm(h.detail)}`, label: `hard to reverse · ${h.kind}`, text: h.detail });
  for (const x of r.discrepancies ?? []) out.push({ key: `${x.kind}|${norm(x.text).slice(0, 60)}|${pathsOf(x.cites)}`, label: x.kind === 'unmentioned' ? 'not in the summary' : 'unsupported claim', text: x.text, discrepancy: true });
  return out;
}

/** Findings the previous audit reported that this one does not. */
export function resolvedSince(previous: AuditReport, current: AuditReport): ResolvedFinding[] {
  const now = new Set(identified(current).map(f => f.key));
  // A null list means the comparison did not run this time (no summary, or it failed): absent is not resolved.
  const compared = current.discrepancies !== null;
  return identified(previous).filter(f => !now.has(f.key) && (compared || !f.discrepancy)).map(({ label, text }) => ({ label, text }));
}

// ---------------------------------------------------------------------------
// Selection default
// ---------------------------------------------------------------------------

/**
 * Is the finding's checkbox ticked when the audit card opens? Task-owned ones are;
 * pre-existing ones are not (they are a separate task). A finding with no
 * classification — an audit from before it existed — is treated as the task's own.
 * The client (AuditCard.tsx) applies the same one-line rule.
 */
export function defaultSelected(o: Pick<Ownership, 'owner'> | undefined): boolean {
  return !o || o.owner === 'task';
}
