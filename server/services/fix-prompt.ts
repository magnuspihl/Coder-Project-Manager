/**
 * The one prompt behind "Fix / Fix all" and "Send selected to implementer":
 * reviewer findings, audit findings, or both, in a single implementer turn.
 *
 * Pure — no DB, no IO. The two sources are different in nature and the prompt
 * says so: a reviewer finding with a proof test is a defect to make pass; an
 * audit finding is a judgement call the implementer may decline.
 */

import { REVIEW_FIX_REPLY_PREFIX } from './message-kinds.js';
import type { Ownership } from './audit-report.js';

export interface AuditItem {
  id: string;
  kind: string;
  text: string;
  cites: string[];
  ownership?: Ownership;
}

export interface FixPromptInput {
  /** Reviewer findings, already rendered by formatFindingForImplementer. */
  reviewItems: string[];
  /** Any of them has a harness-confirmed failing test. */
  hasProof: boolean;
  /** Reviewer findings the user dismissed: do-not-touch. */
  dismissed: Array<{ body: string; note: string | null }>;
  auditItems: AuditItem[];
  /** The audit predates the implementer's latest changes. */
  auditStale: boolean;
  /** The user's free-text steer. */
  note?: string;
  /** PROOF_INSTRUCTIONS and FINDING_REPORT_FORMAT, passed in so this stays free of claude.ts. */
  proofInstructions: string;
  reportFormat: string;
}

/** The ref an audit finding is reported against. Never a prefix of a review finding's hex id. */
export const auditRef = (id: string) => `A-${id}`;

export function formatAuditItem(a: AuditItem): string {
  const lines = [`[${auditRef(a.id)}] (${a.kind}) ${a.text.trim()}`];
  if (a.cites.length) lines.push(`    Cited: ${a.cites.join(', ')}`);
  if (a.ownership) lines.push(`    Ownership: ${a.ownership.owner === 'task' ? 'introduced by this task' : 'pre-existing code'} — ${a.ownership.reason}`);
  return lines.join('\n');
}

export function buildCombinedFixPrompt(i: FixPromptInput): string {
  const parts: string[] = [`${REVIEW_FIX_REPLY_PREFIX}. Each is tagged with a ref you must report against.`];
  const note = i.note?.trim();
  if (note) parts.push(`Note from the user (follow it — it overrides anything below it contradicts):\n${note}`);

  if (i.reviewItems.length) {
    parts.push(`REVIEWER FINDINGS — defects the reviewer reported. Where one has a FAILING TEST, make that test pass.\n\n${i.reviewItems.join('\n\n')}`);
    if (i.hasProof) parts.push(i.proofInstructions);
  }
  if (i.auditItems.length) {
    parts.push([
      'AUDIT FINDINGS — from an independent audit of this task\'s code. These are JUDGEMENT CALLS, not proven defects: there is no failing test.',
      'Apply the user\'s note above. You may DECLINE any of them, but say why. If one no longer applies, report it as not applicable.',
      ...(i.auditStale ? ['The audit predates your latest changes: check each finding against the code as it is now.'] : []),
      '',
      i.auditItems.map(formatAuditItem).join('\n\n'),
    ].join('\n'));
  }
  if (i.dismissed.length) {
    // Tell the implementer what NOT to touch as well, so it doesn't "helpfully"
    // fix a waived finding it can still see in the earlier conversation.
    parts.push(`The user has explicitly DISMISSED the following reviewer findings. Do not act on them, and do not undo or "improve" the code they refer to:\n${i.dismissed.map((f, n) => `${n + 1}. ${f.body}${f.note ? ` (user's reason: ${f.note})` : ''}`).join('\n')}`);
  }
  parts.push(
    'Report on EVERY item, reviewer and audit alike, with its ref: "fixed"; declined, with a reason ("disagree"); or not applicable ("not_fixed", with the note starting "not applicable:").',
    i.reportFormat,
  );
  return parts.join('\n\n');
}
