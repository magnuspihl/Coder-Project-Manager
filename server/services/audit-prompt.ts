/**
 * What the auditor is told. Pure text assembly.
 *
 * The auditor runs with `--setting-sources ''`, so it never discovers CLAUDE.md
 * on its own: the repo's architecture guidance is handed over explicitly here.
 * Phase 1 deliberately contains nothing the implementer wrote about its own work;
 * phase 2 (a resumed turn) adds exactly that, after phase 1's report was stored.
 */

import type { HardFact } from './audit-facts.js';

export interface GuidanceDoc {
  path: string;
  content: string;
}

/** Inline budget for the architecture guidance; what does not fit is listed for the auditor to read itself. */
export const GUIDANCE_CHAR_CAP = 40_000;

/** CLAUDE.md first, then ARCHITECTURE.md, then docs/ alphabetically. */
function guidanceRank(path: string): number {
  if (/^CLAUDE\.md$/i.test(path)) return 0;
  if (/^ARCHITECTURE\.md$/i.test(path)) return 1;
  if (/^docs\/.*ARCHITECTURE/i.test(path)) return 2;
  return 3;
}

/** The guidance as one prompt section: whole files while they fit, the rest named. Empty docs are skipped. */
export function bundleGuidance(docs: GuidanceDoc[], cap = GUIDANCE_CHAR_CAP): string {
  const sorted = docs.filter(d => d.content.trim()).sort((a, b) => guidanceRank(a.path) - guidanceRank(b.path) || a.path.localeCompare(b.path));
  if (sorted.length === 0) {
    return 'The repository has no CLAUDE.md, ARCHITECTURE.md or docs/ — there is no documented guidance to check against; judge conventions from the code itself.';
  }
  const parts: string[] = [];
  const left: string[] = [];
  let used = 0;
  for (const d of sorted) {
    const block = `===== ${d.path} =====\n${d.content.trim()}\n`;
    if (used + block.length <= cap) { parts.push(block); used += block.length; continue; }
    // The primary guidance file is worth a cut version; a later doc is not.
    if (parts.length === 0) {
      parts.push(`${block.slice(0, cap)}\n[… ${d.path} truncated — read the rest yourself]\n`);
      used = cap;
    } else left.push(d.path);
  }
  if (left.length) parts.push(`Not included above (over budget) — read them yourself if relevant:\n${left.map(p => `- ${p}`).join('\n')}\n`);
  return parts.join('\n');
}

export const AUDITOR_SYSTEM_PROMPT = `You are an independent code AUDITOR. You did not write this change and you are not its reviewer: nobody is asking whether it is correct. You are asked what it IS, whether it duplicates or ignores code the repository already has, and where it departs from the repository's own conventions.

Rules:
- You are read-only. You may read files and use git (diff, log, show, grep, ls-files). You cannot edit or run anything, and you must not try.
- Never ask questions. Nobody will answer; produce the report.
- Every claim about code carries a citation \`path:line\` or \`path:start-end\`. Cite lines you actually saw. A citation that does not exist is shown to the human as "could not be verified", so do not guess.
- Be short. The reader is trying to reduce information overload: no praise, no restating the diff, no style nitpicks, no correctness review.
- Say what you saw, not what the implementer intended. If you cannot tell, say so.`;

const REPORT_SHAPE = `AUDIT_REPORT: {
  "summary": "<3-6 plain sentences: what was built>",
  "structure": {
    "added": [{"path": "<new file>", "purpose": "<what it is for>"}],
    "modified": [{"path": "<existing file>", "change": "<how it changed>"}]
  },
  "reuseFindings": [
    {"name": "<new module/class/function>", "verdict": "reused", "new": "<path:line>", "existing": "<path:line of the existing code it uses or extends>", "note": "<one line>"},
    {"name": "<new module/class/function>", "verdict": "possible_duplicate", "new": "<path:line>", "existing": "<path:line of the PRE-EXISTING code it overlaps>", "note": "<one line: what overlaps>"},
    {"name": "<new module/class/function>", "verdict": "new", "new": "<path:line>", "note": "<one line: what you searched for and did not find>"}
  ],
  "deviations": [{"text": "<where the change departs from the repo's conventions or documented rules>", "cites": ["<path:line>"]}],
  "annotations": [{"id": "<id of a hard-to-reverse fact listed below>", "note": "<one line: why it matters or what it affects>"}]
}`;

export interface Phase1Input {
  taskTitle: string;
  taskPrompt: string;
  /** Capped branch diff against the merge-base (merge-base definition: committed + uncommitted + untracked). */
  diff: string;
  diffNote: string;
  stat: string;
  guidance: string;
  facts: HardFact[];
  /** Exports the change added, which MUST each get a reuseFindings entry. */
  addedExports: Array<{ path: string; name: string }>;
}

export function buildPhase1Prompt(i: Phase1Input): string {
  const exportsList = i.addedExports.length
    ? i.addedExports.map(e => `- ${e.name}  (${e.path})`).join('\n')
    : '(none detected mechanically)';
  const factList = i.facts.length
    ? i.facts.map(f => `- ${f.id}: [${f.kind}] ${f.detail}${f.file ? ` — ${f.file}` : ''}`).join('\n')
    : '(none detected)';
  return `Audit the change below. First read the repository's own guidance, then the diff, then search the REST of the repository for what the change should have reused.

## The task the change was made for
Title: ${i.taskTitle}

${i.taskPrompt}

## The repository's architecture guidance
Rules such as "canonical modules", "extend X, do not recreate it" are what you check the change against.

${i.guidance}

## The change (merge-base diff)
${i.stat ? `Files changed:\n${i.stat}\n\n` : ''}${i.diffNote}
${i.diff}

## Your job
1. **summary / structure**: what was built, from the code.
2. **reuseFindings**: for EVERY export listed here, one entry — and also for any other new module, class or significant function you see. Before answering "reused" or "possible_duplicate", SEARCH the repository (Grep/Glob) for existing code that does the same job; the usual failure is an author who never found the existing code, the second is one who found it and built beside it to avoid touching shared code.
   - "reused": the new code uses or extends existing code — cite both.
   - "possible_duplicate": it overlaps code that existed BEFORE this change — cite both, the new code and the existing code, and say in one line what overlaps. The existing code must be pre-existing (use \`git show <merge-base>:path\` if unsure), not another file this change added.
   - "new": nothing existing does this job — say in the note what you searched for. Use it only after searching; it is not a way to skip the search.
   Exports added by the change (the mandatory checklist):
${exportsList}
3. **deviations**: places the change departs from the guidance above or from established patterns in the repo (including "a new pattern where an established one exists"), each with citations. Empty is a fine answer.
4. **annotations**: these facts were computed mechanically from the diff — do not restate or dispute them, only add a one-line note where it helps:
${factList}

Finish with exactly one line, the last thing you write, in this shape (valid JSON on one line is best):

${REPORT_SHAPE}`;
}

export interface Phase2Input {
  /** The implementer's last message, markers stripped. */
  implementerSummary: string;
}

/** The resumed turn: phase 1 is already stored; only discrepancies are accepted from this one. */
export function buildPhase2Prompt(i: Phase2Input): string {
  return `Your account above has been recorded and cannot be changed. Now compare it with the implementer's own summary of the same work, which you have not seen until now:

<implementer_summary>
${i.implementerSummary.slice(0, 12_000)}
</implementer_summary>

List the DISCREPANCIES between the two accounts:
- "unsupported_claim": something the summary claims that the code does not support (it says X was done; you saw no X, or saw it done differently).
- "unmentioned": something significant in the code that the summary never mentions (a new dependency, a changed behaviour, a deleted feature, a schema change).

Check the code again where needed, and cite \`path:line\` for each. Do not restate agreement, do not revise your earlier account, and do not add new reuse or convention findings — only discrepancies. If there are none, say so with an empty list.

Finish with exactly one line, the last thing you write:

AUDIT_REPORT: {"discrepancies": [{"kind": "unsupported_claim", "text": "<one line>", "cites": ["<path:line>"]}, {"kind": "unmentioned", "text": "<one line>", "cites": ["<path:line>"]}]}`;
}

/** Sent when the turn cap cut phase 1 off before the report: one resumed turn to write it. */
export function buildReportRecoveryPrompt(): string {
  return `You ran out of turns before writing the report. Do not investigate further. From what you have already read, write the report now: the single final line AUDIT_REPORT: {...} in the shape given at the start, with whatever you have established (omit findings you did not get to verify rather than guessing).`;
}
