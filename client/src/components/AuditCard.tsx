import { useEffect, useState } from 'react';
import type { AuditOwnership, AuditReuseFinding, AuditView, CheckedCite, ReviewFinding } from '../api/client';

/** Ticked when the card opens? Task-owned (or unclassified) findings are; pre-existing ones are not. Mirrors defaultSelected in server/services/audit-ownership.ts. */
const defaultChecked = (o: AuditOwnership | undefined) => !o || o.owner === 'task';

/** A citation, with the harness's verdict on it: one that does not resolve is flagged, never silently trusted. */
function Cite({ cite, check }: { cite: string; check?: CheckedCite }) {
  const bad = check && !check.ok;
  return (
    <span className="inline-flex items-center gap-1 mr-2">
      <code className={`text-[11px] px-1 rounded ${bad ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'}`}>{cite}</code>
      {bad && (
        <span className="text-[10px] text-amber-700 dark:text-amber-300" title={check.reason}>citation could not be verified</span>
      )}
    </span>
  );
}

/** One finding row: a checkbox, the text, its citations, whose code it is, and the two actions. */
function Finding({ id, label, labelCls, text, cites, checks, unverified, ownership, checked, onToggle, canSend, onSend, onMakeTask, busy }: {
  id: string;
  label: string;
  labelCls: string;
  text: string;
  cites: string[];
  checks?: Array<CheckedCite | undefined>;
  unverified?: boolean;
  ownership?: AuditOwnership;
  checked: boolean;
  onToggle: (id: string) => void;
  /** The task is awaiting feedback, so it can take the finding back. */
  canSend: boolean;
  onSend: (id: string) => void;
  onMakeTask: (id: string) => void;
  busy: boolean;
}) {
  const taskOwned = !ownership || ownership.owner === 'task';
  const primary = 'bg-blue-600 hover:bg-blue-700 text-white border border-blue-600';
  const secondary = 'border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800';
  return (
    <li className="text-sm text-gray-800 dark:text-gray-200" data-testid={`audit-finding-${id}`}>
      {/* Narrow screens: checkbox, label and actions share the first row and the text gets the full width below. */}
      <div className="flex flex-wrap sm:flex-nowrap items-start gap-2">
        {canSend && (
          <input type="checkbox" className="mt-1 shrink-0" checked={checked} onChange={() => onToggle(id)}
            aria-label={`Select ${label} finding`} data-testid={`audit-select-${id}`} />
        )}
        <span className={`shrink-0 mt-0.5 text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${labelCls}`}>{label}</span>
        <div className="min-w-0 order-last basis-full sm:order-none sm:basis-auto sm:flex-1">
          <p className="whitespace-pre-wrap break-words">{text}</p>
          <div className="mt-0.5">
            {cites.map((c, i) => <Cite key={`${c}-${i}`} cite={c} check={checks?.[i]} />)}
            {unverified && cites.length === 0 && (
              <span className="text-[10px] text-amber-700 dark:text-amber-300">citation could not be verified</span>
            )}
            {ownership && (
              <span
                className={`text-[10px] ${taskOwned ? 'text-blue-700 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400'}`}
                title={ownership.reason}
                data-testid={`audit-owner-${id}`}
              >
                {ownership.owner === 'pre_existing' ? 'pre-existing code'
                  : ownership.basis === 'unverified' ? 'unverified citations — treated as this task’s code'
                  : 'this task’s code'}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 ml-auto flex flex-wrap justify-end sm:flex-col sm:flex-nowrap gap-1">
          {canSend && (
            <button onClick={() => onSend(id)} disabled={busy}
              className={`text-[11px] px-2 py-0.5 rounded disabled:opacity-50 ${taskOwned ? primary : secondary}`}>
              Send to implementer
            </button>
          )}
          <button onClick={() => onMakeTask(id)} disabled={busy}
            className={`text-[11px] px-2 py-0.5 rounded disabled:opacity-50 ${taskOwned && canSend ? secondary : primary}`}>
            Make this a task
          </button>
        </div>
      </div>
    </li>
  );
}

/** The citations of a reuse finding with their checks, in step. */
function citePairs(f: AuditReuseFinding): Array<[string, CheckedCite | undefined]> {
  const pairs: Array<[string | null, CheckedCite | undefined]> = [[f.newCite, f.checks?.new], [f.existingCite, f.checks?.existing]];
  return pairs.filter((p): p is [string, CheckedCite | undefined] => !!p[0]);
}

const FACT_LABEL: Record<string, string> = {
  dependency: 'dependency', schema: 'schema', route: 'route', mcp_tool: 'MCP tool', env_var: 'env var',
};

/**
 * The auditor's report on a task. Same ordering philosophy as the verification
 * card: what a human must look at first (possible duplicates, deviations, facts
 * that are hard to reverse), the routine account folded, then discrepancies with
 * the implementer's summary. Facts under "Hard to reverse" come from the diff, not
 * from a model; every citation shows the harness's check.
 */
export default function AuditCard({ audit, onRun, onMakeTask, onSend, openReviewFindings = [], canSend = false, canRun }: {
  audit: AuditView;
  onRun: () => void;
  onMakeTask: (findingId: string) => Promise<void>;
  /** Send the selection (audit and/or reviewer findings) to the implementer as ONE turn — the existing Fix path. */
  onSend?: (sel: { auditIds: string[]; reviewIds: string[]; note: string }) => Promise<void>;
  /** The task's open reviewer findings, so one send can draw from both sources. */
  openReviewFindings?: ReviewFinding[];
  /** The task is awaiting feedback, so it can take findings back. */
  canSend?: boolean;
  /** False while the task is working: audit finished code only. */
  canRun: boolean;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [made, setMade] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const r = audit.report;

  // Re-seed the ticks from the classification when a NEW audit arrives; a poll of the same audit keeps the user's choices.
  useEffect(() => {
    const own = r?.ownership ?? {};
    const ids = r ? [...r.reuseFindings.filter(f => f.kind === 'possible_duplicate').map(f => f.id), ...r.deviations.map(d => d.id), ...r.hardToReverse.map(h => h.id), ...(r.discrepancies ?? []).map(x => x.id)] : [];
    setChecked(new Set(ids.filter(id => defaultChecked(own[id])).map(id => `a:${id}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audit.id]);

  const toggle = (key: string) => setChecked(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleAudit = (id: string) => toggle(`a:${id}`);
  const selectedAudit = [...checked].filter(k => k.startsWith('a:')).map(k => k.slice(2));
  const selectedReview = [...checked].filter(k => k.startsWith('r:')).map(k => k.slice(2)).filter(id => openReviewFindings.some(f => f.id === id));
  const selectedCount = selectedAudit.length + selectedReview.length;

  const send = async (auditIds: string[], reviewIds: string[]) => {
    if (!onSend || sending) return;
    setSending(true);
    try {
      await onSend({ auditIds, reviewIds, note });
    } finally {
      setSending(false);
    }
  };

  const makeTask = async (id: string) => {
    setBusyId(id);
    try {
      await onMakeTask(id);
      setMade(prev => new Set(prev).add(id));
    } finally {
      setBusyId(null);
    }
  };

  const header = (
    <div className="flex items-baseline justify-between gap-3 flex-wrap">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Audit</h3>
      <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 text-[11px]">
        {audit.stale && (
          <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 font-medium" data-testid="audit-stale">
            {audit.stale_label}
          </span>
        )}
        <span className="text-gray-500 dark:text-gray-400 order-last basis-full sm:order-none sm:basis-auto">
          Independent of the implementer&apos;s summary. Hard-to-reverse facts come from the diff; citations are checked.
        </span>
        {canRun && audit.status !== 'running' && (
          <button onClick={onRun} className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
            {audit.status === 'done' ? 'Audit again' : 'Run audit'}
          </button>
        )}
      </div>
    </div>
  );

  const shell = (body: React.ReactNode) => (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/40 p-4 space-y-2.5" data-testid="audit-card">
      {header}
      {body}
    </div>
  );

  if (audit.status === 'running') {
    return shell(
      <p className="text-sm text-gray-600 dark:text-gray-300 flex items-center gap-2">
        <span className="animate-spin h-3.5 w-3.5 border-2 border-gray-500 border-t-transparent rounded-full" />
        {audit.phase === 'comparing' ? 'Comparing its account with the implementer’s summary…' : 'Reading the change and searching the repository…'}
      </p>,
    );
  }
  if (!r) {
    return shell(
      <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="audit-no-report">
        {audit.status === 'skipped' ? audit.reason
          : audit.status === 'cancelled' ? `Audit cancelled — ${audit.reason ?? 'the code changed'}. It will run again after the next review.`
          : `The audit could not be completed${audit.reason ? `: ${audit.reason}` : '.'}`}
      </p>,
    );
  }

  const dups = r.reuseFindings.filter(f => f.kind === 'possible_duplicate');
  const others = r.reuseFindings.filter(f => f.kind !== 'possible_duplicate');
  const flagged = dups.length + r.deviations.length + r.hardToReverse.length;

  return shell(
    <>
      {flagged === 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-300">
          No possible duplicates, convention deviations, or hard-to-reverse changes found.
        </p>
      )}
      {flagged > 0 && (
        <ul className="space-y-2">
          {dups.map(f => (
            <Finding key={f.id} id={f.id} label="possible duplicate" labelCls="bg-rose-100 dark:bg-rose-900/30 text-rose-800 dark:text-rose-300"
              text={`${f.name} — ${f.note}`}
              cites={citePairs(f).map(([c]) => c)}
              checks={citePairs(f).map(([, k]) => k)}
              unverified={f.verified === false}
              ownership={r.ownership?.[f.id]} checked={checked.has(`a:${f.id}`)} onToggle={toggleAudit} canSend={canSend} onSend={id => send([id], [])}
              onMakeTask={makeTask} busy={busyId !== null || sending || made.has(f.id)} />
          ))}
          {r.deviations.map(d => (
            <Finding key={d.id} id={d.id} label="deviation" labelCls="bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300"
              text={d.text} cites={d.cites} checks={d.checks} unverified={d.verified === false}
              ownership={r.ownership?.[d.id]} checked={checked.has(`a:${d.id}`)} onToggle={toggleAudit} canSend={canSend} onSend={id => send([id], [])}
              onMakeTask={makeTask} busy={busyId !== null || sending || made.has(d.id)} />
          ))}
          {r.hardToReverse.map(h => (
            <Finding key={h.id} id={h.id} label={`hard to reverse · ${FACT_LABEL[h.kind] ?? h.kind}`} labelCls="bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-200"
              text={`${h.detail}${h.note ? ` — ${h.note}` : ''}`} cites={h.file ? [h.file] : []}
              ownership={r.ownership?.[h.id]} checked={checked.has(`a:${h.id}`)} onToggle={toggleAudit} canSend={canSend} onSend={id => send([id], [])}
              onMakeTask={makeTask} busy={busyId !== null || sending || made.has(h.id)} />
          ))}
        </ul>
      )}
      {made.size > 0 && (
        <p className="text-xs text-green-700 dark:text-green-400">Added as a proposed task below — create or dismiss it there.</p>
      )}
      {r.unassessedExports.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="audit-unassessed">
          The auditor gave no reuse verdict for: {r.unassessedExports.join(', ')}.
        </p>
      )}

      <details className="text-sm" data-testid="audit-account">
        <summary className="cursor-pointer text-gray-600 dark:text-gray-300 select-none">What was built (the auditor&apos;s account)</summary>
        <div className="mt-2 space-y-2 text-gray-800 dark:text-gray-200">
          <p className="whitespace-pre-wrap">{r.summary}</p>
          {(r.structure.added.length > 0 || r.structure.modified.length > 0) && (
            <ul className="text-xs space-y-0.5">
              {r.structure.added.map(a => <li key={`a-${a.path}`}><span className="text-green-700 dark:text-green-400">new</span> <code>{a.path}</code>{a.purpose && ` — ${a.purpose}`}</li>)}
              {r.structure.modified.map(m => <li key={`m-${m.path}`}><span className="text-blue-700 dark:text-blue-400">modified</span> <code>{m.path}</code>{m.change && ` — ${m.change}`}</li>)}
            </ul>
          )}
          {others.length > 0 && (
            <ul className="text-xs space-y-0.5">
              {others.map(f => (
                <li key={f.id}>
                  <span className="text-gray-500">{f.kind === 'reused' ? 'reuses existing' : 'new, nothing to reuse'}</span> <code>{f.name}</code>{f.note && ` — ${f.note}`}{' '}
                  {[f.newCite, f.existingCite].filter((c): c is string => !!c).map((c, i) => <Cite key={c} cite={c} check={i === 0 && f.newCite ? f.checks?.new : f.checks?.existing} />)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      <div data-testid="audit-discrepancies">
        <h4 className="text-xs font-semibold uppercase text-gray-500 dark:text-gray-400 mb-1">Versus the implementer&apos;s summary</h4>
        {r.discrepancies === null ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Not compared{r.discrepanciesNote ? ` — ${r.discrepanciesNote}` : '.'}</p>
        ) : r.discrepancies.length === 0 ? (
          <p className="text-sm text-gray-600 dark:text-gray-300">No discrepancies found.</p>
        ) : (
          <ul className="space-y-2">
            {r.discrepancies.map(d => (
              <Finding key={d.id} id={d.id}
                label={d.kind === 'unmentioned' ? 'not in the summary' : 'unsupported claim'}
                labelCls="bg-violet-100 dark:bg-violet-900/30 text-violet-800 dark:text-violet-300"
                text={d.text} cites={d.cites} checks={d.checks} unverified={d.verified === false}
                ownership={r.ownership?.[d.id]} checked={checked.has(`a:${d.id}`)} onToggle={toggleAudit} canSend={canSend} onSend={id => send([id], [])}
              onMakeTask={makeTask} busy={busyId !== null || sending || made.has(d.id)} />
            ))}
          </ul>
        )}
      </div>

      {r.resolvedSinceLastAudit && r.resolvedSinceLastAudit.items.length > 0 && (
        <div className="text-xs text-green-700 dark:text-green-400" data-testid="audit-resolved">
          <span className="font-semibold">Resolved since the last audit ({r.resolvedSinceLastAudit.items.length}):</span>
          <ul className="list-disc ml-4">
            {r.resolvedSinceLastAudit.items.map((it, i) => <li key={i}><span className="uppercase text-[10px]">{it.label}</span> {it.text.slice(0, 160)}</li>)}
          </ul>
        </div>
      )}

      {canSend && onSend && (flagged > 0 || openReviewFindings.length > 0 || (r.discrepancies?.length ?? 0) > 0) && (
        <div className="border-t border-gray-200 dark:border-gray-700 pt-2.5 space-y-2" data-testid="audit-send-bar">
          {openReviewFindings.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase text-gray-500 dark:text-gray-400 mb-1">Open reviewer findings — send together with the audit findings</h4>
              <ul className="space-y-1">
                {openReviewFindings.map(f => (
                  <li key={f.id} className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
                    <input type="checkbox" className="mt-1 shrink-0" checked={checked.has(`r:${f.id}`)} onChange={() => toggle(`r:${f.id}`)}
                      aria-label="Select reviewer finding" data-testid={`review-select-${f.id}`} />
                    <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 shrink-0 mt-0.5">
                      {f.severity === 'advisory' ? 'advisory' : f.proof_status === 'confirmed' ? 'proven defect' : 'review'}
                    </span>
                    <span className="min-w-0 break-words line-clamp-2">{f.body}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={2}
            placeholder="Optional note for the implementer — audit findings are judgement calls, e.g. “use the existing constant; ignore the list one”"
            className="w-full text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 p-2"
            data-testid="audit-send-note"
          />
          <button
            onClick={() => send(selectedAudit, selectedReview)}
            disabled={selectedCount === 0 || sending || busyId !== null}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
            data-testid="audit-send-selected"
          >
            {sending ? 'Sending…' : `Send selected to implementer (${selectedCount})`}
          </button>
        </div>
      )}
    </>,
  );
}
