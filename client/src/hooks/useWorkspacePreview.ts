import { useCallback, useEffect, useState } from 'react';
import {
  getWorkspace,
  getPreviewSettings,
  updatePreviewSettings,
  type Workspace,
} from '../api/client';
import { useLocalStorageState } from './useDraft';
import { useIsMobile } from './useIsMobile';

export interface PreviewCandidate {
  url: string;
  label: string;
}

export interface WorkspacePreviewState {
  isMobile: boolean;
  previewEnabled: boolean;
  previewEffective: boolean;
  togglePreview: () => void;
  candidates: PreviewCandidate[];
  savedPreviewUrl: string | null;
  activePreviewUrl: string | null;
  setActivePreviewUrl: (url: string | null) => void;
  previewKey: number;
  reloadPreview: () => void;
}

/**
 * State for the workspace preview iframe. `scopeKey` (e.g. taskId or discussionId)
 * keys the per-device toggle so each chat remembers its own on/off state.
 */
export function useWorkspacePreview(
  workspaceId: string | null,
  scopeKey: string,
  taskPortStart: number | null = null,
): WorkspacePreviewState {
  const isMobile = useIsMobile();
  const [previewEnabled, setPreviewEnabled] = useLocalStorageState<boolean>(
    `preview:enabled:${scopeKey}`,
    false,
  );
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [savedPreviewUrl, setSavedPreviewUrl] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  const previewEffective = previewEnabled && !isMobile;

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    getPreviewSettings(workspaceId)
      .then(({ previewUrl }) => {
        if (cancelled) return;
        setSavedPreviewUrl(previewUrl);
        setSettingsLoaded(true);
      })
      .catch(() => { if (!cancelled) setSettingsLoaded(true); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || !previewEffective) return;
    let cancelled = false;
    const load = async () => {
      try {
        const { workspace: w } = await getWorkspace(workspaceId);
        if (!cancelled) setWorkspace(w);
      } catch { /* keep stale */ }
    };
    load();
    const interval = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [workspaceId, previewEffective]);

  const candidates: PreviewCandidate[] = [];
  if (workspace) {
    for (const p of workspace.listening_ports ?? []) {
      candidates.push({
        url: p.url,
        label: p.title ? `:${p.port} — ${p.title}` : `:${p.port} (${p.process_name})`,
      });
    }
    for (const app of workspace.apps ?? []) {
      if (app.subdomain && app.url) {
        candidates.push({ url: app.url, label: `app: ${app.display_name}` });
      }
    }
  }

  // If the task has an assigned port range, move that port to the front of candidates
  // (or construct a candidate for it if the port isn't listening yet)
  if (taskPortStart !== null) {
    const portIdx = candidates.findIndex(c => {
      try { return new URL(c.url).port === String(taskPortStart); } catch { return false; }
    });
    if (portIdx > 0) {
      // Already in the list but not first — move it to front
      candidates.unshift(...candidates.splice(portIdx, 1));
    }
    // Note: if the port isn't listening yet, it won't appear in candidates until it binds.
    // The workspace poll (every 15s) will pick it up once the service starts.
  }

  useEffect(() => {
    if (!previewEffective) return;
    if (!workspaceId || !settingsLoaded) return;
    if (savedPreviewUrl) return;
    if (candidates.length === 0) return;
    const chosen = candidates[0].url;
    setSavedPreviewUrl(chosen);
    updatePreviewSettings(workspaceId, chosen).catch(() => { /* keep local */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewEffective, settingsLoaded, savedPreviewUrl, candidates.length, workspaceId]);

  const setActivePreviewUrl = useCallback((url: string | null) => {
    setSavedPreviewUrl(url);
    setPreviewKey(k => k + 1);
    if (workspaceId) {
      updatePreviewSettings(workspaceId, url).catch(() => { /* ignore */ });
    }
  }, [workspaceId]);

  const togglePreview = useCallback(() => {
    if (isMobile) return;
    setPreviewEnabled(!previewEnabled);
  }, [isMobile, previewEnabled, setPreviewEnabled]);

  const reloadPreview = useCallback(() => setPreviewKey(k => k + 1), []);

  const activePreviewUrl = savedPreviewUrl ?? candidates[0]?.url ?? null;

  return {
    isMobile,
    previewEnabled,
    previewEffective,
    togglePreview,
    candidates,
    savedPreviewUrl,
    activePreviewUrl,
    setActivePreviewUrl,
    previewKey,
    reloadPreview,
  };
}
