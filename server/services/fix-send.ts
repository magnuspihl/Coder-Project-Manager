/**
 * "Send to implementer": one entry point for the inbox Fix / Fix all, the audit
 * card's send, and the MCP tool. Selected reviewer findings and/or audit
 * findings become ONE message of kind `fix_request` and ONE implementer turn.
 *
 * The prompt itself is pure (fix-prompt.ts); this is the side-effecting half.
 */

import { addMessage, getDismissedFindings, getReviewFindings, resetReviewLoopCount, setPendingComplete, setReviewFindingState, updateTaskStatus, getTask, type Task } from './tasks.js';
import { getLatestAudit, auditView, countImplementerTurns } from './audits.js';
import { findingById } from './audit-report.js';
import { formatFindingForImplementer, PROOF_INSTRUCTIONS } from './review-proof.js';
import { buildCombinedFixPrompt, type AuditItem } from './fix-prompt.js';
import { fixRequestSummary, type MessageMeta } from './message-kinds.js';
import { FINDING_REPORT_FORMAT, processQueue } from './claude.js';

export const MAX_FIX_NOTE_CHARS = 4000;

export interface SendFindingsArgs {
  task: Task;
  /** Review finding ids (full id or the 8-char ref). */
  reviewIds?: string[];
  /** Ids from the task's latest audit report (r1, d2, x1, …). */
  auditIds?: string[];
  note?: string;
  actor: { username?: string; source?: string; clientLabel?: string | null };
}

export type SendFindingsResult =
  | { ok: true; task: Task; sent: { review: number; audit: number } }
  | { ok: false; status: number; error: string };

/** Queue the workspace; the turn itself starts in processQueue. */
function launchQueue(workspaceId: string): void {
  processQueue(workspaceId).catch(err =>
    console.error(`[fix-send] processQueue failed: ${(err as Error)?.message?.slice(0, 200)}`));
}

export function sendFindingsToImplementer(args: SendFindingsArgs, launch: (workspaceId: string) => void = launchQueue): SendFindingsResult {
  const { task } = args;
  if (task.status !== 'awaiting_feedback') return { ok: false, status: 400, error: 'Task is not awaiting feedback' };
  const reviewIds = (args.reviewIds ?? []).filter((x): x is string => typeof x === 'string');
  const auditIds = [...new Set((args.auditIds ?? []).filter((x): x is string => typeof x === 'string'))];
  if (reviewIds.length === 0 && auditIds.length === 0) return { ok: false, status: 400, error: 'Select at least one finding' };
  const note = typeof args.note === 'string' ? args.note.trim() : '';
  if (note.length > MAX_FIX_NOTE_CHARS) return { ok: false, status: 400, error: `note is too long (max ${MAX_FIX_NOTE_CHARS} characters)` };

  const all = getReviewFindings(task.id);
  const review = [...new Set(reviewIds)]
    .map(id => all.find(f => f.id === id || f.id.slice(0, 8) === id))
    .filter((f): f is NonNullable<typeof f> => f !== undefined);

  const audit = auditIds.length ? getLatestAudit(task.id) : undefined;
  const view = audit ? auditView(audit, countImplementerTurns(task.id)) : null;
  const items: AuditItem[] = [];
  if (view?.report) {
    for (const id of auditIds) {
      const f = findingById(view.report, id);
      if (f) items.push({ id, kind: f.kind, text: f.text, cites: f.cites, ownership: view.report.ownership?.[id] });
    }
  }
  if (review.length === 0 && items.length === 0) return { ok: false, status: 404, error: 'No matching findings' };

  const confirmed = review.filter(f => f.proof_status === 'confirmed' && f.proof_path);
  // Tag each finding with its ref and ask for a FINDING_REPORT, exactly as the
  // auto-review retry prompt does. This is not cosmetic: review findings move to
  // 'fixing', and applyFindingReport reopens everything the implementer did not
  // report on. Without the refs and the format there is no report to parse.
  const body = buildCombinedFixPrompt({
    reviewItems: review.map(f => formatFindingForImplementer(f)),
    hasProof: confirmed.length > 0,
    dismissed: getDismissedFindings(task.id),
    auditItems: items,
    auditStale: !!view?.stale,
    note,
    proofInstructions: PROOF_INSTRUCTIONS,
    reportFormat: FINDING_REPORT_FORMAT,
  });

  const count = review.length + items.length;
  const bySource = { review: review.length, audit: items.length };
  const meta: MessageMeta = { count, confirmed: confirmed.length, bySource, ...(note ? { hasNote: true } : {}), summary: fixRequestSummary(count, bySource) };
  addMessage(task.id, 'user', body, { username: args.actor.username, source: args.actor.source, clientLabel: args.actor.clientLabel, kind: 'fix_request', meta });
  review.forEach(f => setReviewFindingState(f.id, 'fixing'));
  resetReviewLoopCount(task.id);
  if (task.pending_complete) setPendingComplete(task.id, false);

  updateTaskStatus(task.id, 'queued');
  launch(task.workspace_id);
  return { ok: true, task: getTask(task.id)!, sent: bySource };
}
