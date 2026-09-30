import { useState } from 'react';
import type { ProofStatus, ReviewFinding, StoredProof, StoredReview, TaskTurn } from '../api/client';

/** Parse the proofs the harness recorded on a reviewer turn. Null for turns that predate evidence-based review. */
export function parseStoredReview(turn: TaskTurn): StoredReview | null {
  if (!turn.review_proofs) return null;
  try {
    const parsed = JSON.parse(turn.review_proofs) as StoredReview;
    return Array.isArray(parsed?.proofs) ? parsed : null;
  } catch {
    return null;
  }
}

const BADGE: Record<ProofStatus, { label: string; title: string; cls: string }> = {
  confirmed: {
    label: 'Confirmed',
    title: 'The reviewer wrote a test for this, and the harness ran it: it fails on the current code.',
    cls: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800',
  },
  refuted: {
    label: 'Refuted',
    title: 'The reviewer wrote a test for this, and it passed — so the code was right and the claim was dropped.',
    cls: 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700',
  },
  unproven: {
    label: 'Unproven',
    title: 'The reviewer could not back this with a working test, so it is advisory only and does not send anything back to the implementer.',
    cls: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-800',
  },
};

export function EvidenceBadge({ status }: { status: ProofStatus }) {
  const b = BADGE[status];
  return (
    <span title={b.title} className={`inline-block text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${b.cls}`}>
      {b.label}
    </span>
  );
}

/** The reviewer's test, collapsed by default: it is evidence to check, not reading material. */
function TestSource({ path, content, output }: { path?: string; content?: string; output?: string }) {
  const [open, setOpen] = useState(false);
  if (!content && !output) return path ? <p className="mt-1 text-[11px] font-mono text-gray-500 dark:text-gray-400 break-all">{path}</p> : null;
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-[11px] text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline"
      >
        {open ? 'Hide the test' : 'Show the test'}{path ? ` (${path})` : ''}
      </button>
      {open && (
        <div className="mt-1 space-y-1.5">
          {content && (
            <pre className="text-[11px] leading-snug font-mono p-2 rounded bg-gray-900 text-gray-100 overflow-x-auto max-h-64">{content}</pre>
          )}
          {output && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Failure output</p>
              <pre className="text-[11px] leading-snug font-mono p-2 rounded bg-red-950/90 text-red-100 overflow-x-auto max-h-40 whitespace-pre-wrap">{output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Evidence for one finding row: its status, the requirement it cites, and the test. */
export function FindingEvidence({ finding, proof }: { finding: ReviewFinding; proof?: StoredProof }) {
  const status: ProofStatus | null = finding.proof_status ?? (finding.severity === 'advisory' ? 'unproven' : null);
  if (!status && !finding.requirement) return null;
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        {status && <EvidenceBadge status={status} />}
        {finding.severity === 'advisory' && (
          <span className="text-[11px] text-amber-800/80 dark:text-amber-200/80">Advisory — not proven by a test, so it will not be sent back automatically</span>
        )}
      </div>
      {finding.requirement && (
        <blockquote className="text-[11px] italic text-gray-600 dark:text-gray-300 border-l-2 border-gray-300 dark:border-gray-600 pl-2">
          Requirement: {finding.requirement}
        </blockquote>
      )}
      {status === 'unproven' && (proof?.reason || finding.proof_output) && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">{proof?.reason ?? finding.proof_output?.split('\n')[0]}</p>
      )}
      <TestSource
        path={finding.proof_path ?? proof?.path}
        content={proof?.content}
        output={finding.proof_status === 'confirmed' ? (proof?.output || finding.proof_output || undefined) : undefined}
      />
    </div>
  );
}

/**
 * Claims the reviewer made that its own test disproved. Shown because they are
 * signal about the reviewer, and because "the reviewer tried and was wrong" is
 * part of why a clean result can be trusted.
 */
export function RefutedClaims({ proofs }: { proofs: StoredProof[] }) {
  const [open, setOpen] = useState(false);
  if (proofs.length === 0) return null;
  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-[11px] text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline"
      >
        {proofs.length} claim{proofs.length === 1 ? '' : 's'} the reviewer tested and dropped {open ? '(hide)' : '(show)'}
      </button>
      {open && (
        <ul className="mt-1.5 space-y-2">
          {proofs.map((p, i) => (
            <li key={i} className="rounded-md border border-gray-200 dark:border-gray-700 p-2 bg-gray-50/70 dark:bg-gray-800/40">
              <div className="flex items-center gap-2"><EvidenceBadge status="refuted" /></div>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300 break-words">{p.defect}</p>
              {p.requirement && <p className="mt-1 text-[11px] italic text-gray-500 dark:text-gray-400">Requirement cited: {p.requirement}</p>}
              <TestSource path={p.path} content={p.content} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shown on reviews that ran without a test runner: the findings were not checked by anything. */
export function OpinionNote() {
  return (
    <p
      className="text-[11px] px-2 py-1 rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200"
      title="No test runner was found for this workspace, so the reviewer's findings could not be backed by failing tests."
    >
      Opinion-based review — no test runner was found, so these findings are the reviewer's judgement and were not checked by running anything.
      Set a test command in the workspace settings, or have the implementer add tests.
    </p>
  );
}

/** One-line tally used in the pill next to a proof-mode review. */
export function proofTally(review: StoredReview | null): string | null {
  if (!review || review.mode !== 'proof') return null;
  const n = (s: ProofStatus) => review.proofs.filter(p => p.status === s).length;
  const parts = [
    n('confirmed') && `${n('confirmed')} confirmed`,
    n('refuted') && `${n('refuted')} refuted`,
    n('unproven') && `${n('unproven')} unproven`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
