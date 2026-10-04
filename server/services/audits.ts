/**
 * Persistence for the auditor (table `task_audits`) and the "should one run" rule.
 * The launch itself lives in claude.ts next to the reviewer it mirrors.
 */

import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { getTaskTurns, type Task } from './tasks.js';
import { isAuditStale, STALE_LABEL, type AuditReport } from './audit-report.js';

export type AuditStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';

export interface TaskAuditRow {
  id: string;
  task_id: string;
  status: AuditStatus;
  /** 'analysing' (phase 1) or 'comparing' (phase 2) while running. */
  phase: string | null;
  trigger_kind: 'auto' | 'manual';
  /** Implementer turns that had run when the audit started — what "stale" is measured from. */
  implementer_turns: number;
  base_sha: string | null;
  head_sha: string | null;
  tree: string | null;
  session_id: string | null;
  report_json: string | null;
  /** Why it was skipped, cancelled or failed. */
  reason: string | null;
  started_at: string;
  completed_at: string | null;
}

/** The auditor follows the task's own switch, and falls back to auto-review when it was never set. */
export function auditEnabled(task: Pick<Task, 'auto_review'> & { audit?: number | null }): boolean {
  return task.audit === null || task.audit === undefined ? !!task.auto_review : !!task.audit;
}

export function setTaskAudit(taskId: string, enabled: boolean | null): void {
  getDb().prepare('UPDATE tasks SET audit = ?, updated_at = ? WHERE id = ?')
    .run(enabled === null ? null : enabled ? 1 : 0, new Date().toISOString(), taskId);
}

export function countImplementerTurns(taskId: string): number {
  return getTaskTurns(taskId).filter(t => t.role === 'implementer').length;
}

export function getLatestAudit(taskId: string): TaskAuditRow | undefined {
  return getDb().prepare('SELECT * FROM task_audits WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
    .get(taskId) as TaskAuditRow | undefined;
}

export function getAudit(id: string): TaskAuditRow | undefined {
  return getDb().prepare('SELECT * FROM task_audits WHERE id = ?').get(id) as TaskAuditRow | undefined;
}

export function createAudit(args: {
  taskId: string;
  trigger: 'auto' | 'manual';
  implementerTurns: number;
  status?: 'running' | 'skipped';
  reason?: string;
}): TaskAuditRow {
  const id = randomUUID();
  const skipped = args.status === 'skipped';
  getDb().prepare(
    `INSERT INTO task_audits (id, task_id, status, phase, trigger_kind, implementer_turns, reason, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, args.taskId, skipped ? 'skipped' : 'running', skipped ? null : 'analysing', args.trigger, args.implementerTurns,
    args.reason ?? null, new Date().toISOString(), skipped ? new Date().toISOString() : null);
  return getAudit(id)!;
}

/** Pin what code the audit is about, once the snapshot has been taken. */
export function setAuditSnapshot(id: string, snap: { baseSha: string; headSha: string; tree: string | null }, sessionId: string): void {
  getDb().prepare('UPDATE task_audits SET base_sha = ?, head_sha = ?, tree = ?, session_id = ? WHERE id = ?')
    .run(snap.baseSha, snap.headSha, snap.tree, sessionId, id);
}

/** Phase 1 is stored BEFORE the implementer's summary is shown to the auditor. */
export function setAuditPhase(id: string, phase: 'analysing' | 'comparing', report?: AuditReport): void {
  getDb().prepare('UPDATE task_audits SET phase = ?, report_json = COALESCE(?, report_json) WHERE id = ?')
    .run(phase, report ? JSON.stringify(report) : null, id);
}

/** Close an audit. Only a still-running one is touched, so a late result cannot overwrite a cancellation. */
export function finishAudit(id: string, status: Exclude<AuditStatus, 'running' | 'skipped'>, opts: { report?: AuditReport; reason?: string } = {}): boolean {
  const res = getDb().prepare(
    `UPDATE task_audits SET status = ?, phase = NULL, report_json = COALESCE(?, report_json), reason = ?, completed_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(status, opts.report ? JSON.stringify(opts.report) : null, opts.reason ?? null, new Date().toISOString(), id);
  return res.changes > 0;
}

/** A running audit that turned out not to be worth running (too small, docs-only): recorded, with why. */
export function skipAudit(id: string, reason: string): boolean {
  return getDb().prepare("UPDATE task_audits SET status = 'skipped', phase = NULL, reason = ?, completed_at = ? WHERE id = ? AND status = 'running'")
    .run(reason, new Date().toISOString(), id).changes > 0;
}

/** The running audit of a task, if any. */
export function getRunningAudit(taskId: string): TaskAuditRow | undefined {
  return getDb().prepare("SELECT * FROM task_audits WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1")
    .get(taskId) as TaskAuditRow | undefined;
}

/** A server restart kills the in-memory runner; the rows it left 'running' would otherwise sit stale forever. */
export function abandonRunningAudits(): number {
  return getDb().prepare(
    "UPDATE task_audits SET status = 'cancelled', phase = NULL, reason = 'server restarted', completed_at = ? WHERE status = 'running'",
  ).run(new Date().toISOString()).changes;
}

/**
 * Should a review that just settled start an audit? Once per implementer-turn
 * count: a done, running, skipped or failed audit for THIS code is not repeated
 * (a failure is retried by hand, not in a loop), but a cancelled one is — it was
 * stopped because the code was changing, so there is still no audit of it.
 */
export function auditDue(latest: Pick<TaskAuditRow, 'status' | 'implementer_turns'> | undefined, implementerTurnsNow: number): boolean {
  if (!latest) return true;
  if (latest.status === 'cancelled') return true;
  return latest.implementer_turns < implementerTurnsNow;
}

export interface AuditView {
  id: string;
  status: AuditStatus;
  phase: string | null;
  trigger: 'auto' | 'manual';
  reason: string | null;
  stale: boolean;
  /** Present exactly when stale, so a consumer can show it verbatim. */
  stale_label: string | null;
  head_sha: string | null;
  started_at: string;
  completed_at: string | null;
  report: AuditReport | null;
}

/** The audit as the API / MCP return it. A report that no longer parses is dropped, not served half-read. */
export function auditView(row: TaskAuditRow, implementerTurnsNow: number): AuditView {
  let report: AuditReport | null = null;
  if (row.report_json) {
    try { report = JSON.parse(row.report_json) as AuditReport; } catch { report = null; }
  }
  const stale = row.status === 'done' && isAuditStale(row, implementerTurnsNow);
  return {
    id: row.id,
    status: row.status,
    phase: row.phase,
    trigger: row.trigger_kind,
    reason: row.reason,
    stale,
    stale_label: stale ? STALE_LABEL : null,
    head_sha: row.head_sha,
    started_at: row.started_at,
    completed_at: row.completed_at,
    report,
  };
}

/** A few lines for `get_task`: enough to know whether to fetch the full report. */
export function auditSummary(row: TaskAuditRow | undefined, implementerTurnsNow: number): Record<string, unknown> | null {
  if (!row) return null;
  const v = auditView(row, implementerTurnsNow);
  const r = v.report;
  return {
    id: v.id,
    status: v.status,
    ...(v.reason ? { reason: v.reason } : {}),
    stale: v.stale,
    ...(v.stale_label ? { stale_label: v.stale_label } : {}),
    ...(r ? {
      summary: r.summary,
      possible_duplicates: r.reuseFindings.filter(f => f.kind === 'possible_duplicate').length,
      deviations: r.deviations.length,
      hard_to_reverse: r.hardToReverse.length,
      discrepancies: r.discrepancies === null ? null : r.discrepancies.length,
    } : {}),
    detail: 'use get_audit for the full report',
  };
}
