/**
 * Parsing of the reviewer's structured output: the REVIEW_DECISION line and the
 * PROOF_FILE blocks that carry its tests. Pure — no IO — so it can be tested
 * directly. (Moved out of claude.ts; behaviour of the pre-existing verdict
 * parsing is unchanged, see the notes on parseReviewDecision.)
 */

/** One problem from a verdict. */
export interface ReviewIssue {
  text: string;
  /** Links a re-raised issue to a finding the implementer claimed fixed. */
  reraises?: string;
  /** The requirement this violates, quoted or cited from the task / existing behaviour. */
  requirement?: string;
  /** Where the requirement comes from: `task`, `existing`, or `test`. */
  requirementSource?: string;
  /** Repo-relative path of the test that demonstrates the defect (see PROOF_FILE blocks). */
  proofPath?: string;
}

export interface ReviewDecision {
  outcome: 'pass' | 'fail';
  summary: string;
  issues?: ReviewIssue[];
}

// The literal placeholder tokens from the verdict template / worked example in
// the reviewer system prompt and REVIEW_DECISION_FORMAT. A weak (or rushed)
// model can echo the example line verbatim — e.g.
// `REVIEW_DECISION: {"outcome":"pass","summary":"<one sentence>"}` — which must
// NOT be accepted as a real verdict: doing so would silently route the task on a
// fabricated pass/fail the reviewer never actually reached. We reject a decision
// whose summary is a placeholder, and strip placeholder entries from `issues`.
const PLACEHOLDER_SUMMARIES = new Set(['<one sentence>', '<summary>']);
const PLACEHOLDER_ISSUES = new Set(['<specific issue>', '<issue>', '<defect>', '...']);

function isPlaceholderSummary(summary: string): boolean {
  return PLACEHOLDER_SUMMARIES.has(summary.trim());
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x.trim() ? x.trim() : undefined;
}

/**
 * Normalise one entry of `issues` / `findings`. Accepts the long-standing plain
 * string, the `{text, reraises}` object, and the evidence-based shape
 * `{defect, requirement, proof, reraises}` where `requirement` may be a string or
 * `{quote, source}` and `proof` a path string or `{path}`.
 */
function normaliseEntry(x: unknown): ReviewIssue[] {
  if (typeof x === 'string') {
    return PLACEHOLDER_ISSUES.has(x.trim()) ? [] : [{ text: x }];
  }
  if (!x || typeof x !== 'object') return [];
  const o = x as Record<string, unknown>;
  const text = str(o.defect) ?? str(o.text);
  if (!text || PLACEHOLDER_ISSUES.has(text)) return [];

  const ref = str(o.reraises);
  const req = o.requirement;
  const requirement = typeof req === 'object' && req ? str((req as Record<string, unknown>).quote) : str(req);
  const requirementSource = typeof req === 'object' && req
    ? str((req as Record<string, unknown>).source)
    : str(o.source);
  const proof = o.proof;
  const proofPath = typeof proof === 'object' && proof ? str((proof as Record<string, unknown>).path) : str(proof);

  const issue: ReviewIssue = { text };
  if (ref) issue.reraises = ref.toLowerCase();
  if (requirement) issue.requirement = requirement;
  if (requirementSource) issue.requirementSource = requirementSource;
  if (proofPath) issue.proofPath = proofPath;
  return [issue];
}

/**
 * Extract and validate the balanced JSON object that begins at the first `{`
 * at or after `from`. Returns the decision or null if no valid object is found.
 * The brace walk respects JSON string literals so a `}` inside a summary/issue
 * value doesn't terminate the object early.
 */
function extractDecisionAt(text: string, from: number): ReviewDecision | null {
  const braceStart = text.indexOf('{', from);
  if (braceStart === -1) return null;

  let depth = 0;
  let end = -1;
  let inStr = false;
  let escaped = false;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;

  try {
    const parsed = JSON.parse(text.slice(braceStart, end + 1));
    if (parsed.outcome !== 'pass' && parsed.outcome !== 'fail') return null;
    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    // Reject an echoed template (e.g. summary still "<one sentence>") — see
    // PLACEHOLDER_SUMMARIES. Returning null lets parseReviewDecision fall back to
    // an earlier (real) marker, or trigger verdict recovery if there is none.
    if (isPlaceholderSummary(summary)) return null;
    // `findings` (evidence-based) and `issues` (legacy) are both accepted, and
    // merged if a model emits both. Placeholder entries copied from the example
    // are dropped; an empty list collapses to undefined so downstream routing
    // falls back to the summary rather than surfacing an empty list.
    const entries: unknown[] = [
      ...(Array.isArray(parsed.findings) ? parsed.findings : []),
      ...(Array.isArray(parsed.issues) ? parsed.issues : []),
    ];
    const realIssues = entries.flatMap(normaliseEntry);
    return { outcome: parsed.outcome, summary, issues: realIssues.length ? realIssues : undefined };
  } catch {
    return null;
  }
}

/**
 * Tolerant parsing: the model often wraps the marker in markdown (**bold**,
 * `code`, fenced blocks), indents it, or pretty-prints the JSON across multiple
 * lines. The old anchored single-line regex (`^…$/m`) missed all of those and
 * treated a perfectly good verdict as "no decision".
 *
 * We collect every `REVIEW_DECISION` marker and try them from LAST to first,
 * returning the first that yields a valid verdict object. Trying the last
 * marker first preserves the "the model may discuss the token before emitting
 * the real verdict" behaviour. Falling back to earlier markers fixes a real
 * misparse: when the reviewer reviews its own pipeline, a genuine verdict can
 * contain the literal token inside an issue string, e.g.
 * `…"issues":["the reviewer never emits REVIEW_DECISION: when cut off"]`. The
 * last marker then lands *inside* the JSON; anchoring to it alone would find no
 * `{` (or a stray later brace) and drop an otherwise-valid verdict.
 */
export function parseReviewDecision(text: string): ReviewDecision | null {
  const markerRe = /REVIEW_DECISION\b\s*:?[ \t]*/gi;
  const markerEnds: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(text)) !== null) {
    markerEnds.push(m.index + m[0].length);
  }

  for (let i = markerEnds.length - 1; i >= 0; i--) {
    const decision = extractDecisionAt(text, markerEnds[i]);
    if (decision) return decision;
  }
  return null;
}

// ---------------------------------------------------------------------------
// PROOF_FILE blocks
// ---------------------------------------------------------------------------

export interface ProofFile {
  path: string;
  content: string;
}

/**
 * Extract `PROOF_FILE: <path>` blocks — the marker line followed by a fenced
 * code block holding the whole test file. Test source travels in fences rather
 * than inside the REVIEW_DECISION JSON because multi-line code in a one-line
 * JSON string is a reliable way to lose the entire verdict to one bad escape;
 * a malformed fence now costs one proof, not the verdict.
 *
 * The marker may be wrapped in markdown (`**PROOF_FILE:** \`path\``). A fence
 * closes only on a line of the same character at least as long as the opener,
 * so test code containing ``` inside a ```` block survives. If a path appears
 * twice the last block wins — a reviewer correcting itself should override.
 */
export function extractProofFiles(text: string): ProofFile[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const found = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    const marker = /PROOF_FILE\b[*_`\s]*:[*_`\s]*([^\s`*'"]+)/i.exec(lines[i]);
    if (!marker) continue;

    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const open = /^\s*(`{3,}|~{3,})[^\n]*$/.exec(lines[j] ?? '');
    if (!open) continue;

    const fence = open[1];
    const body: string[] = [];
    let k = j + 1;
    let closed = false;
    for (; k < lines.length; k++) {
      const t = lines[k].trim();
      if (t.length >= fence.length && t === fence[0].repeat(t.length)) { closed = true; break; }
      body.push(lines[k]);
    }
    if (!closed) continue; // a cut-off block is not a usable test
    found.set(marker[1], body.join('\n') + '\n');
    i = k;
  }
  return [...found].map(([path, content]) => ({ path, content }));
}
