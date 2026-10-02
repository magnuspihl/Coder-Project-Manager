import { useState } from 'react';
import type { BaselineResult, VerificationSummary } from '../api/client';

const BASELINE: Record<BaselineResult, { label: string; cls: string; title: string }> = {
  fails: {
    label: 'fails without the change',
    cls: 'text-green-700 dark:text-green-400',
    title: 'The harness ran this test against the code as it was before the task and it failed there — so it genuinely exercises the new behaviour.',
  },
  passes: {
    label: 'also passes without the change',
    cls: 'text-gray-500 dark:text-gray-400',
    title: 'This test passes on the original code too, so it guards existing behaviour or proves nothing new about this change.',
  },
  new_code: {
    label: 'new code: fails without the change',
    cls: 'text-green-700 dark:text-green-400',
    title: 'On the original code this test file could not even load, because it imports a module this task adds. That proves the test depends on the new code, not that its assertions check the behaviour — weaker evidence than a test that loads and fails. Every test in the file gets this label, since a load failure takes the whole file down.',
  },
  not_runnable: {
    label: "couldn't run without the change",
    cls: 'text-gray-500 dark:text-gray-400',
    title: 'The test could not run against the original code for a reason other than new code (a syntax error, a missing package, an environment problem, or an import whose exports changed), so it is unknown whether it fails there.',
  },
};

const COLLAPSED_COUNT = 8;

/** Drawn, not typed: ✓/✗ are missing from some fonts and render as empty boxes — fatal for the one thing this card exists to show. */
function OutcomeIcon({ outcome }: { outcome: 'passed' | 'failed' | 'skipped' }) {
  const common = { className: 'w-4 h-4 shrink-0 mt-0.5', fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, viewBox: '0 0 24 24', role: 'img' as const, 'aria-label': outcome };
  if (outcome === 'passed') {
    return <svg {...common} style={{ color: '#16a34a' }}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>;
  }
  if (outcome === 'failed') {
    return <svg {...common} style={{ color: '#dc2626' }}><path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" /></svg>;
  }
  return <svg {...common} style={{ color: '#9ca3af' }}><path strokeLinecap="round" d="M6 12h12" /></svg>;
}

/**
 * "What was verified": the tests the task added or changed, as the HARNESS ran
 * them. Names are the implementer's own words; a tick means the harness ran that
 * test and it passed — nothing on this card was written by a model except the
 * names, which is why the caveat is stated on the card itself.
 */
export default function VerificationCard({ summary, onRunFull, running }: {
  summary: VerificationSummary;
  /** Offered when only the quick check has run. Absent while the task is busy. */
  onRunFull?: () => void;
  running?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const failing = summary.tests.filter(t => t.outcome === 'failed');
  const visible = showAll ? summary.tests : summary.tests.slice(0, COLLAPSED_COUNT);
  const hidden = summary.tests.length - visible.length;
  const suiteBad = !!summary.suite && (summary.suite.failed > 0 || !!summary.suite.error);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/40 p-4 space-y-2.5" data-testid="verification-card">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">What was verified</h3>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          Ticks = the harness ran the test and it passed. Names are written by the implementer.
        </span>
      </div>

      {summary.runner === null ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          No test runner was found for this workspace, so nothing could be run. Set a test command in the workspace settings, or have the implementer add tests.
        </p>
      ) : summary.tests.length === 0 && summary.problems.length === 0 ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {summary.noTestsReason
            ? <>No tests were added — the implementer says: {summary.noTestsReason}</>
            : 'This change adds or modifies no tests, so its behaviour has not been verified by anything.'}
        </p>
      ) : (
        <ul className="space-y-1">
          {visible.map((t, i) => (
            <li key={`${t.file}:${t.name}:${i}`} className="flex items-start gap-2 text-sm">
              <OutcomeIcon outcome={t.outcome} />
              <div className="min-w-0">
                <span className="text-gray-800 dark:text-gray-100 break-words">{t.name}</span>
                {t.origin === 'reviewer' && (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300" title="A test the reviewer wrote to prove a defect; kept as a regression test.">
                    reviewer's regression test
                  </span>
                )}
                {t.baseline && t.outcome === 'passed' && (
                  <span className={`ml-2 text-[11px] ${BASELINE[t.baseline].cls}`} title={BASELINE[t.baseline].title}>
                    {BASELINE[t.baseline].label}
                  </span>
                )}
                {t.outcome === 'failed' && t.message && (
                  <p className="text-[11px] font-mono text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">{t.message.split('\n')[0]}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button onClick={() => setShowAll(true)} className="text-[11px] text-gray-500 dark:text-gray-400 underline hover:text-gray-700 dark:hover:text-gray-200">
          Show {hidden} more
        </button>
      )}

      {summary.problems.map(p => (
        <p key={p.file} className="text-[11px] text-amber-700 dark:text-amber-300 break-words">
          Could not run <span className="font-mono">{p.file}</span>: {p.error.split('\n')[0]}
        </p>
      ))}
      {summary.filesOmitted > 0 && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">{summary.filesOmitted} more changed test file{summary.filesOmitted === 1 ? '' : 's'} not run individually.</p>
      )}

      {summary.level === 'tests' && summary.runner !== null && (
        <div className="flex items-center gap-3 flex-wrap text-[11px] text-gray-500 dark:text-gray-400">
          <span>
            Quick check after this turn. The comparison with the original code and the whole-suite run happen when a review runs
            {onRunFull ? ', or now:' : '.'}
          </span>
          {onRunFull && (
            <button
              onClick={onRunFull}
              disabled={running}
              className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              {running ? 'Running full verification…' : 'Run full verification'}
            </button>
          )}
        </div>
      )}

      {summary.suite && (
        <p className={`text-sm ${suiteBad ? 'text-red-700 dark:text-red-400' : 'text-gray-700 dark:text-gray-200'}`}>
          <span className="font-medium">Whole test suite:</span>{' '}
          {summary.suite.error
            ? `did not complete — ${summary.suite.error.split('\n')[0].slice(0, 140)}`
            : `${summary.suite.passed} passed, ${summary.suite.failed} failed${summary.suite.skipped ? `, ${summary.suite.skipped} skipped` : ''}`}
          {!summary.suite.error && summary.suite.failed > 0 && summary.suite.failedNames.length > 0 && (
            <span className="block text-[11px] font-mono text-red-600 dark:text-red-400">{summary.suite.failedNames.slice(0, 3).join(', ')}</span>
          )}
        </p>
      )}

      {failing.length === 0 && summary.notes.length > 0 && (
        <ul className="text-[11px] text-gray-500 dark:text-gray-400 space-y-0.5">
          {summary.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}
