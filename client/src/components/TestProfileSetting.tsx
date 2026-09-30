import { useEffect, useState } from 'react';
import { getTestProfile, updateTestProfile, type TestObligationSetting, type TestProfile } from '../api/client';

const RUNNERS: Array<{ id: TestProfile['runner']; label: string }> = [
  { id: 'node-test', label: 'node:test' },
  { id: 'vitest', label: 'Vitest' },
  { id: 'jest', label: 'Jest' },
  { id: 'pytest', label: 'pytest' },
  { id: 'go', label: 'go test' },
  { id: 'dotnet', label: 'dotnet test' },
];

/**
 * How this workspace runs its tests, for evidence-based auto-review. Empty means
 * "auto-detect from the repo" (package.json, pyproject, go.mod, *.csproj); a
 * value set here always wins. The runner matters as much as the command: the
 * harness reads each runner's structured output to tell a failing assertion from
 * a test that never ran.
 */
export default function TestProfileSetting({ workspaceId }: { workspaceId: string }) {
  const [saved, setSaved] = useState<TestProfile | null>(null);
  const [runner, setRunner] = useState<TestProfile['runner'] | ''>('');
  const [command, setCommand] = useState('');
  const [obligation, setObligation] = useState<TestObligationSetting>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTestProfile(workspaceId)
      .then(({ profile, obligation: ob }) => {
        if (cancelled) return;
        setObligation(ob);
        setSaved(profile);
        setRunner(profile?.runner ?? '');
        setCommand(profile?.command ?? '');
      })
      .catch(() => { /* the setting is optional; a load failure just leaves it blank */ });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const dirty = (saved?.runner ?? '') !== runner || (saved?.command ?? '') !== command.trim();

  const persist = async (next: Omit<TestProfile, 'source'> | null) => {
    setBusy(true);
    setError(null);
    try {
      const { profile } = await updateTestProfile(workspaceId, { profile: next });
      setSaved(profile);
      setRunner(profile?.runner ?? '');
      setCommand(profile?.command ?? '');
    } catch (err: any) {
      setError(err?.message || 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  const changeObligation = async (value: TestObligationSetting) => {
    const previous = obligation;
    setObligation(value);
    setError(null);
    try {
      await updateTestProfile(workspaceId, { obligation: value });
    } catch (err: any) {
      setObligation(previous);
      setError(err?.message || 'Failed to save');
    }
  };

  return (
    <>
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-gray-500 dark:text-gray-400 shrink-0" title="Whether implementers must write tests for the behaviour they change. Auto follows the tooling: on where a test runner is detected or set below, off otherwise, so a Godot or Unity project is never talked into installing a test framework.">Implementer tests:</span>
      <select
        value={obligation}
        onChange={e => changeObligation(e.target.value as TestObligationSetting)}
        className="text-[11px] px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200"
        aria-label="Implementer test obligation"
      >
        <option value="auto">auto (on if a test runner is found)</option>
        <option value="on">always (set up a framework if none)</option>
        <option value="off">off</option>
      </select>
    </div>
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-gray-500 dark:text-gray-400 shrink-0" title="Used by auto-review to run the tests that back a finding. Leave empty to auto-detect from the repository.">Test runner:</span>
      <select
        value={runner}
        onChange={e => setRunner(e.target.value as TestProfile['runner'] | '')}
        className="text-[11px] px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200"
        aria-label="Test runner"
      >
        <option value="">auto-detect</option>
        {RUNNERS.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
      </select>
      {runner && (
        <input
          value={command}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && dirty) persist({ runner, command: command.trim() || undefined }); }}
          placeholder="command prefix (optional), e.g. npx vitest run"
          className="flex-1 min-w-[12rem] text-[11px] font-mono px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 focus:outline-none focus:border-blue-400"
          aria-label="Test command prefix"
        />
      )}
      {dirty && runner && (
        <button
          onClick={() => persist({ runner, command: command.trim() || undefined })}
          disabled={busy}
          className="text-[10px] px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      )}
      {dirty && !runner && saved && (
        <button
          onClick={() => persist(null)}
          disabled={busy}
          className="text-[10px] px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-500 hover:text-red-500 hover:border-red-300 disabled:opacity-50"
        >
          {busy ? 'Clearing…' : 'Clear'}
        </button>
      )}
      {saved?.source === 'implementer' && !dirty && (
        <span className="text-[10px] text-gray-400" title="Reported by the implementer when it set up the tests. Repository auto-detection takes precedence.">set by the implementer</span>
      )}
      {error && <span className="text-[10px] text-red-500">{error}</span>}
    </div>
    </>
  );
}
