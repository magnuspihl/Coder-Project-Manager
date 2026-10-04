// Message kinds: who a CPM-authored conversation message is FOR, and how it reads.
//
// Pure — no DB, no IO. The server tags a message with a `kind` (and a small
// `meta` blob) where it is created; the client picks a display from that, never
// from the text. Two audiences:
//
//   - human messages ask the user to act or decide. They stay visible, and the
//     content stored is real markdown, because what is stored is what is shown.
//   - agent messages are hand-offs to the implementer. The timeline collapses
//     them to a one-line summary with an expand control. (The text the agent
//     actually receives is the prompt it is launched with, built separately —
//     this module only shapes what the human sees in the transcript.)

export type MessageKind =
  | 'review_handoff'      // agent: findings sent back to the implementer
  | 'fix_request'         // agent: the Fix / Fix-all prompt (stored as a user message)
  | 'partial_review'      // human: the reviewer did not see some files
  | 'review_escalation'   // human: fix budget spent, input needed
  | 'review_started'      // neither: one short line
  | 'audit_skipped'       // neither: one short line
  | 'audit_failed';       // human, one line

/** Kinds whose text is meant for an agent and collapses in the timeline. */
export const AGENT_FACING_KINDS: ReadonlySet<string> = new Set(['review_handoff', 'fix_request']);

export function isAgentFacingKind(kind: string | null | undefined): boolean {
  return !!kind && AGENT_FACING_KINDS.has(kind);
}

export interface MessageMeta {
  /** How many findings/issues the message carries. */
  count?: number;
  /** How many of them the harness confirmed with a failing test. */
  confirmed?: number;
  /** The one-line row shown while collapsed. Computed from the counts above. */
  summary?: string;
}

// ---------------------------------------------------------------------------
// Summaries (from structured data, never from prose)
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Review found 2 confirmed defects → sent to implementer". */
export function handoffSummary(count: number, confirmed: number): string {
  const what = count > 0 && confirmed === count
    ? plural(count, 'confirmed defect', 'confirmed defects')
    : plural(count, 'issue', 'issues');
  return `Review found ${what} → sent to implementer`;
}

/** "Fix request: 3 findings → sent to implementer". */
export function fixRequestSummary(count: number | undefined): string {
  return count && count > 0
    ? `Fix request: ${plural(count, 'finding', 'findings')} → sent to implementer`
    : 'Fix request → sent to implementer';
}

export function summaryFor(kind: string, meta: MessageMeta | null | undefined): string | null {
  if (meta?.summary) return meta.summary;
  if (kind === 'review_handoff') return handoffSummary(meta?.count ?? 0, meta?.confirmed ?? 0);
  if (kind === 'fix_request') return fixRequestSummary(meta?.count);
  return null;
}

// ---------------------------------------------------------------------------
// Failure-output trimming
// ---------------------------------------------------------------------------

/** A stack frame: node/V8 "at fn (file:1:2)", python 'File "x", line 3', or a bare "file:line:col". */
const FRAME = /^\s*(at\s|File ".*", line \d+|\S+:\d+:\d+\s*$)/;

/**
 * The assertion line(s) plus at most `maxFrames` stack frames. The full output
 * stays on the review card; this is only what the transcript shows.
 */
export function trimFailureOutput(output: string, maxFrames = 3, maxHeadLines = 8): string {
  const lines = output.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
  const firstFrame = lines.findIndex(l => FRAME.test(l));
  const headEnd = firstFrame === -1 ? lines.length : firstFrame;
  const head = lines.slice(0, headEnd).slice(0, maxHeadLines);
  const frames = firstFrame === -1 ? [] : lines.slice(firstFrame).filter(l => FRAME.test(l)).slice(0, maxFrames);
  const kept = [...head, ...frames];
  const trimmed = lines.length - kept.length;
  return trimmed > 0
    ? `${kept.join('\n')}\n… (${plural(trimmed, 'more line', 'more lines')} — full output on the review card)`
    : kept.join('\n');
}

// ---------------------------------------------------------------------------
// Markdown builders
// ---------------------------------------------------------------------------

/** A fence long enough that nothing inside it can close it early. */
function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(r => r.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/** "1. text", with continuation lines indented so they stay inside the item. */
export function numberedList(items: string[]): string {
  return items
    .map((t, i) => {
      const marker = `${i + 1}. `;
      const pad = ' '.repeat(marker.length);
      return marker + t.trim().split('\n').join(`\n${pad}`);
    })
    .join('\n');
}

export interface HandoffFinding {
  ref: string;
  body: string;
  reraised?: boolean;
  requirement?: string | null;
  proofPath?: string | null;
  runCommand?: string;
  proofOutput?: string | null;
}

/** The transcript text for "findings sent back to the implementer" — markdown, output trimmed. */
export function formatHandoffMarkdown(findings: HandoffFinding[]): string {
  const blocks = findings.map(f => {
    const lines = [`**[${f.ref}]** ${f.body.trim()}${f.reraised ? ' _(re-raised: the previous fix was judged inadequate)_' : ''}`];
    if (f.requirement) lines.push(`- **Requirement:** ${f.requirement}`);
    if (f.proofPath) lines.push(`- **Failing test:** \`${f.proofPath}\`${f.runCommand ? ` — run \`${f.runCommand}\`` : ''}`);
    if (f.proofPath && f.proofOutput) lines.push('', fenced(trimFailureOutput(f.proofOutput)));
    return lines.join('\n');
  });
  return `Auto-review found issues — resuming implementer.\n\n${blocks.join('\n\n')}`;
}

/** Same hand-off when there are no stored findings, only the reviewer's issue texts. */
export function formatHandoffIssueTexts(issueTexts: string[]): string {
  return `Auto-review found issues — resuming implementer.\n\n${numberedList(issueTexts)}`;
}

export function formatEscalationMarkdown(rounds: number, issues: string[]): string {
  return [
    `**Auto-review has spent its fix budget** (${plural(rounds, 'automated round', 'automated rounds')}) without resolving all issues.`,
    'Further reviews will report findings but will not send them back automatically — use **Fix** on a finding to spend another round.',
    '**Your input is needed.**',
    `**Unresolved issues:**\n\n${numberedList(issues)}`,
  ].join('\n\n');
}

export function formatPartialMarkdown(opts: {
  label: string;
  unreviewed: Array<{ path: string; reason: string }>;
  stoppedByTurnCap?: boolean;
  turnCap?: number | string;
}): string {
  const bullets = opts.unreviewed.map(u => `- \`${u.path}\` — ${u.reason}`).join('\n');
  const cap = opts.stoppedByTurnCap
    ? ` The reviewer hit its turn limit${opts.turnCap ? ` (${opts.turnCap})` : ''} before it could read everything, so this is a budget stop, not a finding.`
    : '';
  return [
    `**${opts.label}.**${cap}`,
    `The reviewer found no confirmed defect in what it saw, but it did not see these files, so this is **NOT a pass**:\n\n${bullets}`,
    'Nothing is wrong with the code as far as is known — use **Review remaining files** to have the reviewer read only these.',
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Legacy rows (written before `kind` existed)
// ---------------------------------------------------------------------------

const FIX_REPLY_PREFIXES = [
  'Please apply fixes for the issues the reviewer found',
  'Please apply the fixes the reviewer suggested',
];

/** True for the auto-generated "go fix the review" reply shapes. */
export function isFixRequestText(content: string): boolean {
  return FIX_REPLY_PREFIXES.some(p => content.startsWith(p));
}

/** How many numbered/ref-tagged findings a fix-request body lists. */
export function countFixRequestItems(content: string): number {
  return (content.match(/^(\d+\.\s|\[[0-9a-f]{8}\]\s)/gm) ?? []).length;
}

/**
 * Best-effort kind for a row with no stored kind. FALLBACK ONLY: new rows are
 * tagged where they are created, and this never overrides a stored kind.
 */
export function inferLegacyKind(
  role: string,
  content: string,
): { kind: MessageKind; meta: MessageMeta } | null {
  if (role === 'system' && content.startsWith('Auto-review found issues — resuming implementer')) {
    // Old shape: one "[ref] defect" line per finding, indented detail under it.
    const count = (content.match(/^\[[0-9a-f]{8}\]\s/gm) ?? []).length || (content.match(/^\d+\.\s/gm) ?? []).length;
    const confirmed = (content.match(/^\s+FAILING TEST:/gm) ?? []).length;
    return { kind: 'review_handoff', meta: { count, confirmed } };
  }
  if (role === 'user' && isFixRequestText(content)) {
    return { kind: 'fix_request', meta: { count: countFixRequestItems(content) } };
  }
  if (role === 'system' && /^\**Partial review — not seen:/.test(content)) return { kind: 'partial_review', meta: {} };
  if (role === 'system' && /^\**Auto-review has spent its fix budget/.test(content)) return { kind: 'review_escalation', meta: {} };
  if (role === 'system' && content.startsWith('Manual review requested')) return { kind: 'review_started', meta: {} };
  return null;
}

/** Parse a stored meta blob; unreadable JSON is just "no meta". */
export function parseMeta(raw: string | null | undefined): MessageMeta | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v as MessageMeta : null;
  } catch {
    return null;
  }
}

export interface MessageTagFields {
  role: string;
  content: string;
  kind?: string | null;
  meta?: string | MessageMeta | null;
}

/** The kind/meta a message presents: stored values win; a legacy row falls back to the text. */
export function resolveMessageTag(m: MessageTagFields): { kind: string | null; meta: MessageMeta | null } {
  const stored = typeof m.meta === 'string' ? parseMeta(m.meta) : m.meta ?? null;
  if (m.kind) return { kind: m.kind, meta: { ...stored, summary: summaryFor(m.kind, stored) ?? undefined } };
  const legacy = inferLegacyKind(m.role, m.content);
  if (!legacy) return { kind: null, meta: stored };
  return { kind: legacy.kind, meta: { ...legacy.meta, summary: summaryFor(legacy.kind, legacy.meta) ?? undefined } };
}
