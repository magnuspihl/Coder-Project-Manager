import { useEffect, useState } from 'react';
import { getPreviewCommand, updatePreviewCommand } from '../api/client';

/**
 * The command CPM runs to start each task's preview in this workspace. Stored
 * in CPM rather than in the repo, since some repos are public. Empty means
 * auto-detect: `npm run dev` when package.json has a dev script, else no preview.
 */
export default function PreviewCommandSetting({ workspaceId }: { workspaceId: string }) {
  const [saved, setSaved] = useState('');
  const [draft, setDraft] = useState('');
  const [detected, setDetected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPreviewCommand(workspaceId)
      .then(({ command, detected: d }) => {
        if (cancelled) return;
        setSaved(command ?? '');
        setDraft(command ?? '');
        setDetected(d);
      })
      .catch(() => { /* optional setting; a load failure just leaves it on auto-detect */ });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const dirty = draft.trim() !== saved;

  const persist = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await updatePreviewCommand(workspaceId, value.trim() || null);
      setSaved(res.command ?? '');
      setDraft(res.command ?? '');
      setDetected(res.detected);
    } catch (err: any) {
      setError(err?.message || 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  const placeholder = detected
    ? `auto-detect: ${detected}`
    : 'auto-detect (npm run dev if package.json has a dev script)';

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span
        className="text-gray-500 dark:text-gray-400 shrink-0"
        title="CPM runs this in each task's working directory when the agent finishes a turn, with $PORT set to the task's first port (and $CPM_PORT_RANGE to its range). Leave empty to auto-detect."
      >
        Preview command:
      </span>
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && dirty) persist(draft); }}
        placeholder={placeholder}
        className="flex-1 min-w-[12rem] text-[11px] font-mono px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 focus:outline-none focus:border-blue-400"
        aria-label="Preview command"
      />
      {dirty && (
        <button
          onClick={() => persist(draft)}
          disabled={busy}
          className="text-[10px] px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      )}
      {!dirty && saved && (
        <button
          onClick={() => persist('')}
          disabled={busy}
          className="text-[10px] px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-500 hover:text-red-500 hover:border-red-300 disabled:opacity-50"
          title="Clear and auto-detect"
        >
          Clear
        </button>
      )}
      {error && <span className="text-[10px] text-red-500">{error}</span>}
    </div>
  );
}
