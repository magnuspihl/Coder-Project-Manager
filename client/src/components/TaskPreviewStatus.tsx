import { useEffect, useRef, useState } from 'react';
import { getTaskPreviewLog, restartTaskPreview, type Task } from '../api/client';

const LABELS: Record<string, { text: string; dot: string }> = {
  starting: { text: 'Preview starting', dot: 'bg-amber-400 animate-pulse' },
  running: { text: 'Preview running', dot: 'bg-green-500' },
  failed: { text: 'Preview failed', dot: 'bg-red-500' },
  stopped: { text: 'Preview stopped', dot: 'bg-gray-400' },
  none: { text: 'No preview', dot: 'bg-gray-300 dark:bg-gray-600' },
};

const FINISHED = ['completed', 'failed', 'cancelled'];

/**
 * The task's CPM-managed preview: its status, a Restart button, and the tail of
 * its log. CPM restarts the preview itself whenever an implementer turn ends;
 * this is for when the user wants it now, or wants to see why it failed.
 */
export default function TaskPreviewStatus({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const status = task.preview_status ?? null;
  const finished = FINISHED.includes(task.status);
  const canRestart = !finished && task.port_range_start != null;

  // Starting is short-lived and settles on the server; poll until it does.
  useEffect(() => {
    if (status !== 'starting') return;
    const timer = setInterval(onChanged, 2000);
    return () => clearInterval(timer);
  }, [status, onChanged]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Nothing to show for a task CPM never ran a preview for and can't now.
  if (!status && !canRestart) return null;

  const label = status ? LABELS[status] ?? LABELS.none : { text: 'Preview not started', dot: 'bg-gray-300 dark:bg-gray-600' };

  const loadLog = async () => {
    setLogLoading(true);
    setError(null);
    try {
      const { log: text } = await getTaskPreviewLog(task.id, 200);
      setLog(text || '(the log is empty)');
    } catch (err: any) {
      setError(err?.message || 'Could not load the log');
    } finally {
      setLogLoading(false);
    }
  };

  const restart = async () => {
    setBusy(true);
    setError(null);
    setLog(null);
    try {
      await restartTaskPreview(task.id);
      onChanged();
    } catch (err: any) {
      setError(err?.message || 'Restart failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
        title={task.preview_error || task.preview_command || 'Preview managed by CPM'}
        aria-expanded={open}
      >
        <span className={`w-2 h-2 rounded-full ${label.dot}`} />
        {label.text}
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 w-[min(32rem,90vw)] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg p-3 text-xs space-y-2">
          <p className="text-gray-500 dark:text-gray-400">
            CPM restarts this preview automatically whenever the agent finishes a turn.
          </p>
          {task.preview_command && (
            <div>
              <span className="text-gray-500 dark:text-gray-400">Command: </span>
              <code className="font-mono text-gray-700 dark:text-gray-200">{task.preview_command}</code>
              {task.port_range_start != null && <span className="text-gray-400"> on port {task.port_range_start}</span>}
            </div>
          )}
          {status === 'none' && (
            <p className="text-gray-600 dark:text-gray-300">
              No preview command: this workspace has none set, and package.json has no <code className="font-mono">dev</code> script.
              Set one in the workspace settings.
            </p>
          )}
          {task.preview_error && (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded p-2 max-h-40 overflow-auto">{task.preview_error}</pre>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={restart}
              disabled={!canRestart || busy || status === 'starting'}
              className="px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              title={canRestart ? 'Kill and start the preview again' : 'This task no longer has ports for a preview'}
            >
              {busy || status === 'starting' ? 'Restarting…' : 'Restart preview'}
            </button>
            <button
              onClick={loadLog}
              disabled={logLoading}
              className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              {logLoading ? 'Loading…' : log === null ? 'Show log' : 'Refresh log'}
            </button>
          </div>
          {error && <p className="text-red-500">{error}</p>}
          {log !== null && (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-gray-700 dark:text-gray-200 bg-gray-50 dark:bg-gray-800 rounded p-2 max-h-72 overflow-auto">{log}</pre>
          )}
        </div>
      )}
    </div>
  );
}
