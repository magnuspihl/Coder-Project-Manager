/**
 * The auditor's report: its shape, tolerant parsing of the model's output, the
 * harness's checks layered on top, and the policy around when to audit at all.
 *
 * Pure — no IO. The model supplies narration (summary, structure, reuse and
 * deviation findings, discrepancies); the harness supplies facts (hardToReverse),
 * verifies every citation, and notices exports the model never assessed.
 */

import { exemptReason, splitDiff } from './review-coverage.js';
import type { HardFact } from './audit-facts.js';
import { checkCite, type CheckedCite, type LineIndex } from './audit-citations.js';

export const AUDIT_MARKER = 'AUDIT_REPORT';

/** Below this many changed (non-exempt) lines the audit is not worth its cost. */
export const AUDIT_MIN_CHANGED_LINES = 20;

export interface AuditStructure {
  added: Array<{ path: string; purpose: string }>;
  modified: Array<{ path: string; change: string }>;
}

export interface ReuseFinding {
  id: string;
  /** The new abstraction (module, class or function). */
  name: string;
  kind: 'reused' | 'possible_duplicate' | 'new';
  /** `file:line` of the new code. */
  newCite: string | null;
  /** `file:line` of the existing code it extends, or overlaps. */
  existingCite: string | null;
  note: string;
  /** Harness verdict on the citations — absent until verifyReport has run. */
  checks?: { new: CheckedCite; existing: CheckedCite };
  verified?: boolean;
}

export interface Deviation {
  id: string;
  text: string;
  cites: string[];
  checks?: CheckedCite[];
  verified?: boolean;
}

export interface Discrepancy {
  id: string;
  /** A claim the code does not support, or something significant in the code the summary never mentioned. */
  kind: 'unsupported_claim' | 'unmentioned';
  text: string;
  cites: string[];
  checks?: CheckedCite[];
  verified?: boolean;
}

/** What phase 1 produces. */
export interface ModelAudit {
  summary: string;
  structure: AuditStructure;
  reuseFindings: ReuseFinding[];
  deviations: Deviation[];
  /** Fact id → the auditor's one-line comment. */
  annotations: Record<string, string>;
}

export interface AuditReport {
  summary: string;
  structure: AuditStructure;
  reuseFindings: ReuseFinding[];
  deviations: Deviation[];
  /** Computed by the harness; the auditor only annotated them. */
  hardToReverse: HardFact[];
  /** Phase 2. null = the comparison with the implementer's summary did not happen. */
  discrepancies: Discrepancy[] | null;
  /** Why `discrepancies` is null, when it is. */
  discrepanciesNote?: string;
  /** Exports the change added that the auditor gave no reuse entry for — the checklist is mandatory. */
  unassessedExports: string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');
const isPlaceholder = (s: string) => /^<[^>]*>$/.test(s.trim()) || s.trim() === '...';

/** The balanced JSON object starting at the first `{` at or after `from` (string-literal aware), or null. */
function objectAt(text: string, from: number): unknown | null {
  const start = text.indexOf('{', from);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/**
 * Every `AUDIT_REPORT` marker's object, last first — the same tolerance as
 * REVIEW_DECISION: markdown around the marker, pretty-printed JSON, and a marker
 * token mentioned in prose before the real one are all fine.
 */
function reportObjects(text: string): Array<Record<string, unknown>> {
  const re = new RegExp(`${AUDIT_MARKER}\\b[*_\`\\s]*:?[*_\`\\s]*`, 'gi');
  const ends: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ends.push(m.index + m[0].length);
  const out: Array<Record<string, unknown>> = [];
  for (let i = ends.length - 1; i >= 0; i--) {
    const o = objectAt(text, ends[i]);
    if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o as Record<string, unknown>);
  }
  return out;
}

const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const cites = (o: Record<string, unknown>): string[] =>
  [...list(o.cites), ...(o.cite ? [o.cite] : []), ...list(o.citations)].map(str).filter(c => c && !isPlaceholder(c));

function parseStructure(x: unknown): AuditStructure {
  const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
  const added = [...list(o.added), ...list(o.new)].flatMap(e => {
    if (typeof e === 'string') return str(e) && !isPlaceholder(e) ? [{ path: str(e), purpose: '' }] : [];
    const r = (e ?? {}) as Record<string, unknown>;
    const path = str(r.path) || str(r.file);
    return path && !isPlaceholder(path) ? [{ path, purpose: str(r.purpose) || str(r.what) || str(r.note) }] : [];
  });
  const modified = list(o.modified).flatMap(e => {
    if (typeof e === 'string') return str(e) && !isPlaceholder(e) ? [{ path: str(e), change: '' }] : [];
    const r = (e ?? {}) as Record<string, unknown>;
    const path = str(r.path) || str(r.file);
    return path && !isPlaceholder(path) ? [{ path, change: str(r.change) || str(r.how) || str(r.note) }] : [];
  });
  return { added, modified };
}

/** Phase 1 output → the model's account, or null when no usable report was emitted. */
export function parseModelAudit(text: string): ModelAudit | null {
  for (const o of reportObjects(text)) {
    const summary = str(o.summary);
    if (!summary || isPlaceholder(summary)) continue;
    const reuseFindings: ReuseFinding[] = [];
    for (const e of list(o.reuseFindings ?? o.reuse)) {
      const r = (e ?? {}) as Record<string, unknown>;
      const name = str(r.name) || str(r.symbol);
      const verdict = str(r.verdict) || str(r.kind);
      if (!name || isPlaceholder(name) || (verdict !== 'reused' && verdict !== 'possible_duplicate' && verdict !== 'new')) continue;
      reuseFindings.push({
        id: `r${reuseFindings.length + 1}`,
        name,
        kind: verdict,
        newCite: str(r.new) || str(r.newCite) || null,
        existingCite: str(r.existing) || str(r.existingCite) || null,
        note: str(r.note) || str(r.overlap) || '',
      });
    }
    const deviations: Deviation[] = [];
    for (const e of list(o.deviations)) {
      const r = typeof e === 'string' ? { text: e } : ((e ?? {}) as Record<string, unknown>);
      const text = str(r.text) || str(r.deviation);
      if (text && !isPlaceholder(text)) deviations.push({ id: `d${deviations.length + 1}`, text, cites: cites(r) });
    }
    const annotations: Record<string, string> = {};
    for (const e of list(o.annotations ?? o.hardToReverse)) {
      const r = (e ?? {}) as Record<string, unknown>;
      const id = str(r.id);
      const note = str(r.note);
      if (id && note) annotations[id] = note;
    }
    return { summary, structure: parseStructure(o.structure), reuseFindings, deviations, annotations };
  }
  return null;
}

/**
 * Phase 2 output. ONLY `discrepancies` is read from it: whatever else the model
 * writes after seeing the implementer's summary (a revised summary, new findings)
 * is ignored, so phase 1 stays what it was before the self-report was shown.
 * Null = no usable object; `[]` = it found none.
 */
export function parseDiscrepancies(text: string): Discrepancy[] | null {
  for (const o of reportObjects(text)) {
    if (!Array.isArray(o.discrepancies)) continue;
    const out: Discrepancy[] = [];
    for (const e of o.discrepancies) {
      const r = typeof e === 'string' ? { text: e } : ((e ?? {}) as Record<string, unknown>);
      const t = str(r.text) || str(r.discrepancy);
      if (!t || isPlaceholder(t)) continue;
      const kind = str(r.kind) === 'unmentioned' ? 'unmentioned' : 'unsupported_claim';
      out.push({ id: `x${out.length + 1}`, kind, text: t, cites: cites(r) });
    }
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Harness checks
// ---------------------------------------------------------------------------

/** Every citation in a model audit, for audit-io.ts to measure. */
export function allCitations(model: ModelAudit, discrepancies: Discrepancy[] = []): string[] {
  return [
    ...model.reuseFindings.flatMap(r => [r.newCite, r.existingCite]),
    ...model.deviations.flatMap(d => d.cites),
    ...discrepancies.flatMap(d => d.cites),
  ].filter((c): c is string => !!c);
}

/**
 * Check the citations. A reuse entry's `new` cite must exist in the current tree;
 * its `existing` cite must exist at the merge-base for a `possible_duplicate` —
 * otherwise "existing" code may be another file this very task added — and may be
 * in either tree for `reused`. A possible_duplicate must cite both sides.
 */
export function verifyReuse(f: ReuseFinding, index: LineIndex, worktree?: string): ReuseFinding {
  const nw = checkCite(f.newCite, index, 'head', worktree);
  const ex = checkCite(f.existingCite, index, f.kind === 'possible_duplicate' ? 'base' : 'either', worktree);
  // `new` claims there is nothing existing, so only its own location can be checked.
  const verified = f.kind === 'new' ? nw.ok : f.kind === 'possible_duplicate' ? nw.ok && ex.ok : ex.ok && (nw.ok || !f.newCite);
  return { ...f, checks: { new: nw, existing: ex }, verified };
}

function verifyCited<T extends { cites: string[] }>(item: T, index: LineIndex, worktree?: string): T & { checks: CheckedCite[]; verified: boolean } {
  const checks = item.cites.map(c => checkCite(c, index, 'either', worktree));
  // No citation at all is "could not be verified", not "verified".
  return { ...item, checks, verified: checks.length > 0 && checks.every(c => c.ok) };
}

/** Merge the model's account with the harness's facts and checks. */
export function assembleReport(args: {
  model: ModelAudit;
  facts: HardFact[];
  /** Exports the change added (the mandatory reuse checklist). */
  addedExports: Array<{ path: string; name: string }>;
  index: LineIndex;
  worktree?: string;
  discrepancies?: Discrepancy[] | null;
  discrepanciesNote?: string;
}): AuditReport {
  const { model, facts, index, worktree } = args;
  const assessed = new Set(model.reuseFindings.map(r => r.name.replace(/\(\)$/, '')));
  const unassessedExports = args.addedExports
    .filter(e => !assessed.has(e.name))
    .map(e => `${e.name} (${e.path})`);
  const discrepancies = args.discrepancies ? args.discrepancies.map(d => verifyCited(d, index, worktree)) : null;
  return {
    summary: model.summary,
    structure: model.structure,
    reuseFindings: model.reuseFindings.map(r => verifyReuse(r, index, worktree)),
    deviations: model.deviations.map(d => verifyCited(d, index, worktree)),
    hardToReverse: facts.map(f => (model.annotations[f.id] ? { ...f, note: model.annotations[f.id] } : f)),
    discrepancies,
    ...(discrepancies === null && args.discrepanciesNote ? { discrepanciesNote: args.discrepanciesNote } : {}),
    unassessedExports,
  };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

const DOC_FILE = /\.(md|mdx|markdown|txt|rst)$|(^|\/)(LICENSE|NOTICE|CHANGELOG)[^/]*$/i;

export type AuditGate = { run: true } | { run: false; reason: string };

/** Is the change big enough, and code enough, to be worth an audit? The reason is recorded on the task. */
export function auditGate(diff: string, minLines = AUDIT_MIN_CHANGED_LINES): AuditGate {
  const sections = splitDiff(diff).filter(s => !exemptReason(s.path));
  if (sections.length === 0) return { run: false, reason: 'audit skipped: no changed files' };
  if (sections.every(s => DOC_FILE.test(s.path))) return { run: false, reason: 'audit skipped: docs-only change' };
  let lines = 0;
  for (const s of sections) {
    for (const l of s.text.split('\n')) {
      if ((l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---'))) lines++;
    }
  }
  if (lines < minLines) return { run: false, reason: `audit skipped: ${lines} changed line${lines === 1 ? '' : 's'} (under ${minLines})` };
  return { run: true };
}

/**
 * Is this audit about code that has since changed? A new implementer turn is the
 * way code changes under CPM, so the count of implementer turns when the audit
 * started is compared with now. (Edits made outside any turn are not seen.)
 */
export function isAuditStale(audit: { implementer_turns: number }, implementerTurnsNow: number): boolean {
  return implementerTurnsNow > audit.implementer_turns;
}

export const STALE_LABEL = 'stale — code changed since this audit';

/** The implementer's final message with CPM's marker blocks removed — what it reads as to a human. */
export function cleanImplementerSummary(text: string): string {
  return text
    .replace(/\[WAKE\][\s\S]*?\[\/WAKE\]/g, '')
    .replace(/\[TASK_REQUEST\][\s\S]*?\[\/TASK_REQUEST\]/g, '')
    .replace(/\[OUTPUT_FILE\][\s\S]*?\[\/OUTPUT_FILE\]/g, '')
    .replace(/^[ \t]*(NO_REVIEW_NEEDED|NO_TESTS_NEEDED:.*|TEST_PROFILE:.*)[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The prompt of a task made from one audit finding. A new task starts from the default branch, so it says so. */
export function findingTaskPrompt(kind: string, text: string, cites: string[], taskTitle: string): string {
  return [
    `Follow-up from an independent audit of the task "${taskTitle}" (${kind}).`,
    '',
    text,
    ...(cites.length ? ['', 'Cited code:', ...cites.map(c => `- ${c}`)] : []),
    '',
    'You are starting from the default branch, which may not yet contain the audited task\'s changes: look at the code as it is now, check the finding still applies, and fix it if so — reuse or extend the existing code rather than adding more alongside it.',
  ].join('\n');
}

/** One finding of a report, as the text of a task to make from it; null when the id is not in the report. */
export function findingById(report: AuditReport, id: string): { kind: string; text: string; cites: string[] } | null {
  const r = report.reuseFindings.find(f => f.id === id);
  if (r) {
    const label = r.kind === 'possible_duplicate' ? 'possible duplicate' : r.kind === 'new' ? 'new abstraction' : 'reuse';
    return { kind: label, text: `${r.name}: ${r.note}`.trim(), cites: [r.newCite, r.existingCite].filter((c): c is string => !!c) };
  }
  const d = report.deviations.find(f => f.id === id);
  if (d) return { kind: 'deviation from the repo\'s conventions', text: d.text, cites: d.cites };
  const h = report.hardToReverse.find(f => f.id === id);
  if (h) return { kind: 'hard to reverse', text: `${h.detail}${h.note ? ` — ${h.note}` : ''}`, cites: h.file ? [h.file] : [] };
  const x = report.discrepancies?.find(f => f.id === id);
  if (x) return { kind: x.kind === 'unmentioned' ? 'unmentioned in the summary' : 'unsupported claim', text: x.text, cites: x.cites };
  return null;
}
