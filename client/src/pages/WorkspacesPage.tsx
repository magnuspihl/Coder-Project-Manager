import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, Fragment } from 'react';
import {
  getWorkspaces,
  getTasks,
  stopWorkspace,
  startWorkspace,
  completeTask,
  retryTask,
  reopenTask,
  interruptTask,
  cancelTask,
  deleteTask,
  restoreTask,
  createTask,
  getModels,
  getGitSettings,
  updateGitSettings,
  getPreviewSettings,
  updatePreviewSettings,
  getWorkspaceVoiceSettings,
  updateWorkspaceVoiceSettings,
  uploadFiles,
  getWorkspaceMemory,
  updateWorkspaceMemoryFile,
  getAuthConfig,
  type Workspace,
  type ModelInfo,
  type MemoryFile,
  type Task,
  type TaskCounts,
  type TokenTotals,
  type RateLimitUsage,
} from '../api/client';
import { KOKORO_VOICES } from '../utils/kokoroTTS';
import { playChime } from '../utils/chime';
import { useDraft, useSessionState } from '../hooks/useDraft';
import TaskDetailModal from '../components/TaskDetailModal';

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

// Coder build statuses that mean the workspace is spinning up (not yet usable, not stopped)
const STARTING_STATUSES = ['starting', 'pending'];

const STATUS_ORDER: Record<string, number> = {
  failed: 0,
  cancelled: 1,
  awaiting_feedback: 2,
  working: 3,
  queued: 4,
  completed: 5,
};

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
  working: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
  awaiting_feedback: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400',
  completed: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  failed: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  cancelled: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400',
};

function getAgentStatus(workspace: Workspace): { connected: boolean; name: string } {
  for (const resource of workspace.latest_build.resources) {
    if (resource.agents) {
      for (const agent of resource.agents) {
        return { connected: agent.status === 'connected', name: agent.name };
      }
    }
  }
  return { connected: false, name: '' };
}

type WorkspacePort = NonNullable<Workspace['listening_ports']>[number];

function getOpenPorts(workspace: Workspace) {
  return workspace.listening_ports || [];
}

/**
 * A forwarded port belongs to a task when it falls inside the task's reserved
 * port range [port_range_start, port_range_start + rangeSize). Such ports are
 * shown on the task card rather than in the workspace-wide shortcut row.
 */
function portInTaskRange(port: number, task: Task, rangeSize: number): boolean {
  return (
    task.port_range_start != null &&
    port >= task.port_range_start &&
    port < task.port_range_start + rangeSize
  );
}

/**
 * Which task (if any) owns a forwarded port, among a workspace's tasks. Prefers
 * the server's worktree-based attribution (`owner_task_id`, which catches ports
 * that drifted outside the assigned range) and falls back to the numeric
 * port-range heuristic when the server hasn't attributed it yet.
 */
function resolvePortOwnerId(port: WorkspacePort, wsTasks: Task[], rangeSize: number): string | null {
  if (port.owner_task_id && wsTasks.some((t) => t.id === port.owner_task_id)) {
    return port.owner_task_id;
  }
  return wsTasks.find((t) => portInTaskRange(port.port, t, rangeSize))?.id ?? null;
}

/**
 * Link to a forwarded port. The default "icon" variant is icon-only (workspace
 * shortcut row); the "pill" variant also shows the `:port` label and is used on
 * task cards, where a bare icon lacks context.
 */
function PortLink({
  port,
  variant = 'icon',
  onClick,
}: {
  port: WorkspacePort;
  variant?: 'icon' | 'pill';
  onClick?: (e: React.MouseEvent) => void;
}) {
  const icon = (
    <>
      {port.favicon_url ? (
        <img
          src={port.favicon_url.startsWith('data:') ? port.favicon_url : `/api/workspaces/proxy-icon?url=${encodeURIComponent(port.favicon_url)}`}
          alt=""
          className="h-4 w-4 rounded-sm"
          onError={(e) => {
            const el = e.currentTarget;
            el.style.display = 'none';
            el.nextElementSibling?.classList.remove('hidden');
          }}
        />
      ) : null}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className={`h-4 w-4 text-gray-400 dark:text-gray-500 group-hover:text-blue-600 dark:group-hover:text-blue-400${port.favicon_url ? ' hidden' : ''}`}
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
        <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
      </svg>
    </>
  );
  const title = port.title || `:${port.port} (${port.process_name})`;
  if (variant === 'pill') {
    return (
      <a
        href={port.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onClick}
        className="group inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-[11px] font-mono text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        title={title}
      >
        {icon}
        <span>:{port.port}</span>
      </a>
    );
  }
  return (
    <a
      href={port.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className="group shrink-0 hover:opacity-80 transition-opacity"
      title={title}
    >
      {icon}
    </a>
  );
}

function getApps(workspace: Workspace) {
  return workspace.apps || [];
}

/**
 * Per-workspace Claude usage limits. Each workspace uses its own Claude account,
 * so session (five_hour) and weekly (seven_day) limits are tracked and shown
 * independently in the workspace's column header.
 */
function WorkspaceRateLimits({ limits }: { limits: Record<string, RateLimitUsage> | undefined }) {
  if (!limits || Object.keys(limits).length === 0) return null;
  const now = Date.now();
  const types = (['five_hour', 'seven_day'] as const).filter(t => limits[t]);
  if (types.length === 0) return null;
  return (
    // Grid (not per-row flex) so the label / bar / % / reset columns align
    // across both rows — this keeps the Session and Weekly bars the same width
    // regardless of differing reset-label lengths (e.g. "3h 0m" vs "4d 0h 0m").
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1 mt-2">
      {types.map(type => {
        const limit = limits[type];
        const pct = Math.round(limit.utilization * 100);
        const indeterminate = pct === 0 && limit.resetsAt * 1000 > now;
        const label = type === 'five_hour' ? 'Session' : 'Weekly';
        const diffMs = limit.resetsAt * 1000 - now;
        let resetLabel = '';
        if (diffMs > 0) {
          const diffD = Math.floor(diffMs / 86400000);
          const diffH = Math.floor((diffMs % 86400000) / 3600000);
          const diffM = Math.floor((diffMs % 3600000) / 60000);
          resetLabel = diffD > 0 ? `${diffD}d ${diffH}h ${diffM}m` : diffH > 0 ? `${diffH}h ${diffM}m` : `${diffM}m`;
        }
        const title = `${label} limit: ${indeterminate ? '<75%' : `${pct}%`}${resetLabel ? ` — resets in ${resetLabel}` : ''}`;
        return (
          <Fragment key={type}>
            <span title={title} className="text-[10px] text-gray-500 dark:text-gray-400 font-medium whitespace-nowrap">{label}</span>
            <div title={title} className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              {indeterminate ? (
                <div
                  className="h-full rounded-full"
                  style={{
                    width: '75%',
                    backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 2px, rgba(96,165,250,0.3) 2px, rgba(96,165,250,0.3) 4px)',
                    backgroundColor: 'rgba(96,165,250,0.15)',
                  }}
                />
              ) : (
                <div
                  className={`h-full rounded-full transition-all ${
                    pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-blue-500'
                  }`}
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              )}
            </div>
            <span title={title} className={`text-[10px] font-mono whitespace-nowrap text-right ${
              indeterminate
                ? 'text-gray-400 dark:text-gray-500'
                : pct >= 90 ? 'text-red-500' : pct >= 75 ? 'text-amber-500' : 'text-gray-400 dark:text-gray-500'
            }`}>
              {indeterminate ? 'OK' : `${pct}%`}
            </span>
            <span title={title} className="text-[10px] text-gray-400 dark:text-gray-500 whitespace-nowrap">
              {resetLabel}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [taskCounts, setTaskCounts] = useState<Record<string, TaskCounts>>({});
  const [tokenTotals, setTokenTotals] = useState<Record<string, TokenTotals>>({});
  const [githubRepoUrls, setGithubRepoUrls] = useState<Record<string, string>>({});
  const [rateLimits, setRateLimits] = useState<Record<string, Record<string, RateLimitUsage>>>({});
  const [tasksByWorkspace, setTasksByWorkspace] = useState<Record<string, Task[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Size of each task's reserved port range (from server config). Used to attribute
  // forwarded ports to the task that owns them so they render on the task card
  // instead of the workspace-wide shortcut row.
  const [portRangeSize, setPortRangeSize] = useState(10);
  const [showStopped, setShowStopped] = useState(false);
  const [deletedTaskId, setDeletedTaskId] = useState<string | null>(null);
  const [newTaskWorkspaceId, setNewTaskWorkspaceId] = useSessionState<string | null>('newTaskWorkspaceId', null);
  const [newTaskPrompt, setNewTaskPrompt, clearNewTaskPrompt] = useDraft('newTaskPrompt');
  const [newTaskModel, setNewTaskModel] = useState('');
  const [newTaskCaveman, setNewTaskCaveman] = useState('');
  const [newTaskAutoReview, setNewTaskAutoReview] = useState(true);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [newTaskFiles, setNewTaskFiles] = useState<File[]>([]);
  const [newTaskAttachmentIds, setNewTaskAttachmentIds] = useState<string[]>([]);
  const [newTaskUploading, setNewTaskUploading] = useState(false);
  const newTaskFileInputRef = useRef<HTMLInputElement>(null);
  const [selectedTaskId, setSelectedTaskId] = useSessionState<string | null>('selectedTaskId', null);
  const [settingsOpenWsId, setSettingsOpenWsId] = useState<string | null>(null);
  const [memoryOpenWsId, setMemoryOpenWsId] = useState<string | null>(null);
  const [memoryByWs, setMemoryByWs] = useState<Record<string, MemoryFile[]>>({});
  const [memoryLoadingWsId, setMemoryLoadingWsId] = useState<string | null>(null);
  const [memoryEditingFile, setMemoryEditingFile] = useState<{ wsId: string; filename: string; draft: string } | null>(null);
  const [memorySavingFile, setMemorySavingFile] = useState<string | null>(null);
  const [gitPushSettings, setGitPushSettings] = useState<Record<string, boolean>>({});
  const [previewUrlSettings, setPreviewUrlSettings] = useState<Record<string, string>>({});
  const [previewUrlDrafts, setPreviewUrlDrafts] = useState<Record<string, string>>({});
  const [previewUrlSaving, setPreviewUrlSaving] = useState<Record<string, boolean>>({});
  const [previewUrlError, setPreviewUrlError] = useState<Record<string, string | null>>({});
  const [wsVoiceSettings, setWsVoiceSettings] = useState<Record<string, string[]>>({});
  const [wsDefaultVoices, setWsDefaultVoices] = useState<Record<string, string | null>>({});
  const [availableVoices, setAvailableVoices] = useState<Array<{ id: string; name: string }>>([]);
  const availableVoicesLoadedRef = useRef(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevTaskStatusesRef = useRef<Map<string, string>>(new Map());
  const lastTaskWorkspaceIdRef = useRef<string | null>(null);
  const laneContainerRef = useRef<HTMLDivElement>(null);
  const prevLaneRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const prevLaneOrderRef = useRef<string[]>([]);

  // Stable-update helper: only set state if JSON representation changed
  const lastJsonRef = useRef<Record<string, string>>({});
  function setIfChanged<T>(key: string, setter: React.Dispatch<React.SetStateAction<T>>, value: T) {
    const json = JSON.stringify(value);
    if (lastJsonRef.current[key] !== json) {
      lastJsonRef.current[key] = json;
      setter(value);
    }
  }

  // Load the per-task port range size once so ports can be attributed to tasks.
  useEffect(() => {
    getAuthConfig()
      .then((cfg) => { if (cfg.port_range_size > 0) setPortRangeSize(cfg.port_range_size); })
      .catch(() => { /* keep default */ });
  }, []);

  const loadData = async () => {
    try {
      const { workspaces: ws, taskCounts: tc, tokenTotals: tt, githubRepoUrls: gh, rateLimits: rl } = await getWorkspaces();
      setIfChanged('workspaces', setWorkspaces, ws);
      setIfChanged('taskCounts', setTaskCounts, tc);
      setIfChanged('tokenTotals', setTokenTotals, tt || {});
      setIfChanged('githubRepoUrls', setGithubRepoUrls, gh || {});
      setIfChanged('rateLimits', setRateLimits, rl || {});
      setError('');

      // Fetch tasks for running workspaces in parallel
      const runningWs = ws.filter((w) => w.latest_build.status === 'running');
      const taskResults = await Promise.all(
        runningWs.map((w) => getTasks(w.id)
          .then((r) => ({ id: w.id, tasks: r.tasks }))
          .catch(() => ({ id: w.id, tasks: [] as Task[] })))
      );

      const tasksMap: Record<string, Task[]> = {};
      for (const { id, tasks } of taskResults) {
        tasksMap[id] = tasks;
      }

      // Chime detection
      const prev = prevTaskStatusesRef.current;
      if (prev.size > 0) {
        for (const tasks of Object.values(tasksMap)) {
          let chimed = false;
          for (const t of tasks) {
            const old = prev.get(t.id);
            if (old && old !== 'awaiting_feedback' && t.status === 'awaiting_feedback') {
              playChime();
              chimed = true;
              break;
            }
          }
          if (chimed) break;
        }
      }
      const next = new Map<string, string>();
      for (const tasks of Object.values(tasksMap)) {
        for (const t of tasks) next.set(t.id, t.status);
      }
      prevTaskStatusesRef.current = next;

      setIfChanged('tasksByWorkspace', setTasksByWorkspace, tasksMap);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  // Track whether any task is actively working/queued to adjust poll frequency
  const hasActiveTasks = Object.values(taskCounts).some(
    tc => tc.working > 0 || tc.queued > 0
  );
  const pollMsRef = useRef(5000);
  pollMsRef.current = hasActiveTasks ? 5000 : 15000;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const tick = () => {
      loadData().finally(() => {
        if (!cancelled) timer = setTimeout(tick, pollMsRef.current);
      });
    };
    tick(); // Initial load + start chain
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  // Sorted running workspaces (used for Alt+N targeting, Space shortcut, and rendering)
  const runningWorkspaces = useMemo(() => workspaces
    .filter((ws) => ws.latest_build.status === 'running')
    .sort((a, b) => {
      const aCounts = taskCounts[a.id];
      const bCounts = taskCounts[b.id];
      const aActive = aCounts ? (aCounts.working + aCounts.queued + aCounts.awaiting_feedback + aCounts.failed + aCounts.cancelled) > 0 : false;
      const bActive = bCounts ? (bCounts.working + bCounts.queued + bCounts.awaiting_feedback + bCounts.failed + bCounts.cancelled) > 0 : false;
      // Active tasks first
      if (aActive !== bActive) return aActive ? -1 : 1;
      // Then any tasks (including completed) before no tasks
      const aHasAny = aCounts ? (aCounts.working + aCounts.queued + aCounts.awaiting_feedback + aCounts.failed + aCounts.completed + aCounts.cancelled) > 0 : false;
      const bHasAny = bCounts ? (bCounts.working + bCounts.queued + bCounts.awaiting_feedback + bCounts.failed + bCounts.completed + bCounts.cancelled) > 0 : false;
      if (aHasAny !== bHasAny) return aHasAny ? -1 : 1;
      return a.name.localeCompare(b.name);
    }), [workspaces, taskCounts]);

  // Pre-sort tasks per workspace so we don't re-sort on every render/keypress
  const sortedTasksByWorkspace = useMemo(() => {
    const result: Record<string, Task[]> = {};
    for (const [wsId, tasks] of Object.entries(tasksByWorkspace)) {
      result[wsId] = [...tasks].sort((a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99));
    }
    return result;
  }, [tasksByWorkspace]);

  // Attribute each forwarded port to its owning task. These ports render on the
  // individual task card; the rest stay in the workspace-wide shortcut row at
  // the top of the swimlane.
  const portsByTaskId = useMemo(() => {
    const map: Record<string, WorkspacePort[]> = {};
    for (const ws of workspaces) {
      const ports = ws.listening_ports || [];
      if (ports.length === 0) continue;
      const wsTasks = tasksByWorkspace[ws.id] || [];
      for (const p of ports) {
        const ownerId = resolvePortOwnerId(p, wsTasks, portRangeSize);
        if (ownerId) (map[ownerId] ||= []).push(p);
      }
    }
    return map;
  }, [workspaces, tasksByWorkspace, portRangeSize]);

  // Workspaces that are spinning up — shown alongside running ones with a spinner
  const startingWorkspaces = useMemo(() =>
    workspaces
      .filter((ws) => STARTING_STATUSES.includes(ws.latest_build.status))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [workspaces]
  );

  const stoppedWorkspaces = useMemo(() =>
    workspaces.filter((ws) =>
      ws.latest_build.status !== 'running' && !STARTING_STATUSES.includes(ws.latest_build.status)),
    [workspaces]
  );

  // FLIP animation for workspace lane reordering
  // Only animate when the actual order of lanes changes, not on every re-render
  const currentLaneOrder = useMemo(() => runningWorkspaces.map(ws => ws.id), [runningWorkspaces]);

  useLayoutEffect(() => {
    const container = laneContainerRef.current;
    if (!container) return;

    const lanes = container.querySelectorAll<HTMLElement>('[data-ws-id]');
    const prevRects = prevLaneRectsRef.current;
    const prevOrder = prevLaneOrderRef.current;

    // Only animate if the order actually changed (not just content updates)
    const orderChanged = prevOrder.length > 0 &&
      (prevOrder.length !== currentLaneOrder.length ||
       prevOrder.some((id, i) => id !== currentLaneOrder[i]));

    if (orderChanged) {
      lanes.forEach(lane => {
        const id = lane.dataset.wsId!;
        const prevRect = prevRects.get(id);
        const currentRect = lane.getBoundingClientRect();

        if (prevRect) {
          const deltaX = prevRect.left - currentRect.left;

          if (Math.abs(deltaX) > 1) {
            // Invert: snap to old position
            lane.style.transform = `translateX(${deltaX}px)`;
            lane.style.transition = 'none';

            // Force reflow so the browser registers the starting position
            void lane.offsetHeight;

            // Play: animate to the new position
            lane.style.transition = 'transform 300ms ease-out';
            lane.style.transform = '';
          }
        }
      });
    }

    // Always snapshot current positions for next render
    const newRects = new Map<string, DOMRect>();
    lanes.forEach(lane => {
      newRects.set(lane.dataset.wsId!, lane.getBoundingClientRect());
    });
    prevLaneRectsRef.current = newRects;
    prevLaneOrderRef.current = currentLaneOrder;
  }, [currentLaneOrder, showStopped]);

  // Equalize workspace header heights across all visible lanes
  // Re-run when the set of visible workspaces changes or usage data arrives
  const headerDeps = runningWorkspaces.map(ws => ws.id).join(',');
  useLayoutEffect(() => {
    const container = laneContainerRef.current;
    if (!container) return;
    const headers = container.querySelectorAll<HTMLElement>('[data-ws-header]');
    // Reset to auto so we measure natural heights
    headers.forEach(h => { h.style.minHeight = ''; });
    let max = 0;
    headers.forEach(h => { max = Math.max(max, h.offsetHeight); });
    if (max > 0) {
      headers.forEach(h => { h.style.minHeight = `${max}px`; });
    }
  }, [headerDeps, showStopped]);

  // Compute which task the Space shortcut would open
  const spaceTargetTaskId = useMemo(() => {
    for (const ws of runningWorkspaces) {
      const sorted = sortedTasksByWorkspace[ws.id] || [];
      if (sorted.length > 0) return sorted[0].id;
    }
    return null;
  }, [runningWorkspaces, sortedTasksByWorkspace]);

  // Stable refs for keyboard handler data (avoids recreating listeners on poll)
  const runningWorkspacesRef = useRef(runningWorkspaces);
  runningWorkspacesRef.current = runningWorkspaces;
  const sortedTasksRef = useRef(sortedTasksByWorkspace);
  sortedTasksRef.current = sortedTasksByWorkspace;
  const selectedTaskIdRef = useRef(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;
  const newTaskWorkspaceIdRef = useRef(newTaskWorkspaceId);
  newTaskWorkspaceIdRef.current = newTaskWorkspaceId;

  // Space shortcut to open the top-left task (uses refs for stable listener)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ') return;
      if (selectedTaskIdRef.current || newTaskWorkspaceIdRef.current) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return;
      for (const ws of runningWorkspacesRef.current) {
        const sorted = sortedTasksRef.current[ws.id] || [];
        if (sorted.length > 0) {
          e.preventDefault();
          setSelectedTaskId(sorted[0].id);
          return;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Compute the target workspace for Alt+N: last-created-in workspace, or left-most running
  const getAltNTargetWorkspaceId = (): string | null => {
    if (runningWorkspaces.length === 0) return null;
    const lastId = lastTaskWorkspaceIdRef.current;
    if (lastId && runningWorkspaces.some((ws) => ws.id === lastId)) return lastId;
    return runningWorkspaces[0].id;
  };

  const altNTargetWorkspaceId = getAltNTargetWorkspaceId();

  // Alt+N shortcut to open new task form (uses refs for stable listener)
  useEffect(() => {
    const handleAltN = (e: KeyboardEvent) => {
      if (!e.altKey || e.key.toLowerCase() !== 'n') return;
      if (selectedTaskIdRef.current || newTaskWorkspaceIdRef.current) return;
      const target = getAltNTargetWorkspaceId();
      if (!target) return;
      e.preventDefault();
      setNewTaskWorkspaceId(target);
      clearNewTaskPrompt();
    };
    window.addEventListener('keydown', handleAltN);
    return () => window.removeEventListener('keydown', handleAltN);
  }, []);

  // Fetch available models and restore saved defaults when task creation form opens
  useEffect(() => {
    if (!newTaskWorkspaceId) {
      setAvailableModels([]);
      setNewTaskModel('');
      setNewTaskCaveman('');
      return;
    }
    // Restore per-workspace defaults
    try {
      const defaults = JSON.parse(localStorage.getItem('taskDefaults') || '{}');
      const ws = defaults[newTaskWorkspaceId];
      if (ws) {
        setNewTaskModel(ws.model || '');
        setNewTaskCaveman(ws.caveman || '');
      }
    } catch { /* ignore */ }
    let cancelled = false;
    setLoadingModels(true);
    getModels(newTaskWorkspaceId)
      .then(({ models }) => { if (!cancelled) setAvailableModels(models); })
      .catch(() => { if (!cancelled) setAvailableModels([]); })
      .finally(() => { if (!cancelled) setLoadingModels(false); });
    return () => { cancelled = true; };
  }, [newTaskWorkspaceId]);

  const handleStop = async (e: React.MouseEvent, id: string, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Stop workspace "${name}"?`)) return;
    await stopWorkspace(id);
    await loadData();
  };

  const handleStart = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    await startWorkspace(id);
    await loadData();
  };

  const handleComplete = async (e: React.MouseEvent, taskId: string) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await completeTask(taskId);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('uncommitted')) {
        alert(err.message);
      }
    }
    await loadData();
  };

  const handleRetry = async (e: React.MouseEvent, taskId: string) => {
    e.preventDefault();
    e.stopPropagation();
    await retryTask(taskId);
    await loadData();
  };

  const handleReopen = async (e: React.MouseEvent, taskId: string) => {
    e.preventDefault();
    e.stopPropagation();
    await reopenTask(taskId);
    await loadData();
  };

  const handleInterrupt = async (e: React.MouseEvent, taskId: string) => {
    e.preventDefault();
    e.stopPropagation();
    await interruptTask(taskId);
    await loadData();
  };

  const handleCancel = async (e: React.MouseEvent, taskId: string) => {
    e.preventDefault();
    e.stopPropagation();
    await cancelTask(taskId);
    await loadData();
  };

  const handleDelete = async (e: React.MouseEvent, taskId: string) => {
    e.preventDefault();
    e.stopPropagation();
    await deleteTask(taskId);
    setDeletedTaskId(taskId);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setDeletedTaskId(null), 8000);
    await loadData();
  };

  const handleUndo = async () => {
    if (!deletedTaskId) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    await restoreTask(deletedTaskId);
    setDeletedTaskId(null);
    await loadData();
  };

  const handleToggleSettings = async (workspaceId: string) => {
    if (settingsOpenWsId === workspaceId) {
      setSettingsOpenWsId(null);
      return;
    }
    setSettingsOpenWsId(workspaceId);
    // Fetch current git push setting
    if (!(workspaceId in gitPushSettings)) {
      try {
        const { gitPushEnabled } = await getGitSettings(workspaceId);
        setGitPushSettings(prev => ({ ...prev, [workspaceId]: gitPushEnabled }));
      } catch { /* default shown as true */ }
    }
    // Fetch saved preview URL
    if (!(workspaceId in previewUrlSettings)) {
      try {
        const { previewUrl } = await getPreviewSettings(workspaceId);
        const v = previewUrl ?? '';
        setPreviewUrlSettings(prev => ({ ...prev, [workspaceId]: v }));
        setPreviewUrlDrafts(prev => ({ ...prev, [workspaceId]: v }));
      } catch { /* leave empty */ }
    }
    // Fetch voice settings — skip if key already present (optimistic add may have
    // raced ahead of this fetch; don't clobber the already-updated state)
    if (!(workspaceId in wsVoiceSettings)) {
      getWorkspaceVoiceSettings(workspaceId)
        .then(({ voiceIds, defaultVoiceId }) => {
          setWsVoiceSettings(prev => workspaceId in prev ? prev : { ...prev, [workspaceId]: voiceIds });
          setWsDefaultVoices(prev => ({ ...prev, [workspaceId]: defaultVoiceId }));
        })
        .catch(() => setWsVoiceSettings(prev => workspaceId in prev ? prev : { ...prev, [workspaceId]: [] }));
    }
    // Load available voices once (Kokoro + ElevenLabs)
    if (!availableVoicesLoadedRef.current) {
      availableVoicesLoadedRef.current = true;
      const voices: Array<{ id: string; name: string }> = KOKORO_VOICES.map(v => ({
        id: `kokoro:${v.id}`,
        name: `${v.name} — ${v.accent} ${v.gender}`,
      }));
      try {
        const resp = await fetch('/api/tts/voices', { credentials: 'include' });
        if (resp.ok) {
          const data = await resp.json() as { enabled: boolean; voices: Array<{ id: string; name: string; description?: string }> };
          if (data.enabled) {
            for (const v of data.voices) {
              voices.push({ id: `el:${v.id}`, name: v.description ? `${v.name} — ${v.description}` : v.name });
            }
          }
        }
      } catch { /* ElevenLabs unavailable */ }
      try {
        const resp = await fetch('/api/tts/qwen/voices', { credentials: 'include' });
        if (resp.ok) {
          const data = await resp.json() as { enabled: boolean; voices: Array<{ id: string; name: string; description?: string }> };
          if (data.enabled) {
            for (const v of data.voices) {
              voices.push({ id: `qwen:${v.id}`, name: v.description ? `${v.name} — ${v.description}` : v.name });
            }
          }
        }
      } catch { /* Qwen TTS unavailable */ }
      setAvailableVoices(voices);
    }
  };

  const handleToggleMemory = async (workspaceId: string) => {
    if (memoryOpenWsId === workspaceId) {
      setMemoryOpenWsId(null);
      setMemoryEditingFile(null);
      return;
    }
    setMemoryOpenWsId(workspaceId);
    setMemoryEditingFile(null);
    if (!(workspaceId in memoryByWs)) {
      setMemoryLoadingWsId(workspaceId);
      try {
        const { files } = await getWorkspaceMemory(workspaceId);
        setMemoryByWs(prev => ({ ...prev, [workspaceId]: files }));
      } catch { /* show empty state */ }
      setMemoryLoadingWsId(null);
    }
  };

  const handleSaveMemoryFile = async (workspaceId: string, filename: string, content: string) => {
    setMemorySavingFile(filename);
    try {
      await updateWorkspaceMemoryFile(workspaceId, filename, content);
      setMemoryByWs(prev => ({
        ...prev,
        [workspaceId]: (prev[workspaceId] ?? []).map(f =>
          f.name === filename ? { ...f, content } : f
        ),
      }));
      setMemoryEditingFile(null);
    } catch (err) {
      alert((err as Error).message || 'Failed to save');
    } finally {
      setMemorySavingFile(null);
    }
  };

  const handleAddVoice = async (workspaceId: string, voiceId: string) => {
    const current = wsVoiceSettings[workspaceId] ?? [];
    if (current.includes(voiceId)) return;
    const next = [...current, voiceId];
    setWsVoiceSettings(prev => ({ ...prev, [workspaceId]: next }));
    try {
      await updateWorkspaceVoiceSettings(workspaceId, next);
    } catch {
      setWsVoiceSettings(prev => ({ ...prev, [workspaceId]: current }));
    }
  };

  const handleRemoveVoice = async (workspaceId: string, voiceId: string) => {
    const current = wsVoiceSettings[workspaceId] ?? [];
    const next = current.filter(v => v !== voiceId);
    setWsVoiceSettings(prev => ({ ...prev, [workspaceId]: next }));
    try {
      await updateWorkspaceVoiceSettings(workspaceId, next);
    } catch {
      setWsVoiceSettings(prev => ({ ...prev, [workspaceId]: current }));
    }
  };

  const handleSavePreviewUrl = async (workspaceId: string) => {
    const raw = (previewUrlDrafts[workspaceId] ?? '').trim();
    const next = raw === '' ? null : raw;
    setPreviewUrlSaving(prev => ({ ...prev, [workspaceId]: true }));
    setPreviewUrlError(prev => ({ ...prev, [workspaceId]: null }));
    try {
      const { previewUrl } = await updatePreviewSettings(workspaceId, next);
      const v = previewUrl ?? '';
      setPreviewUrlSettings(prev => ({ ...prev, [workspaceId]: v }));
      setPreviewUrlDrafts(prev => ({ ...prev, [workspaceId]: v }));
    } catch (err: unknown) {
      setPreviewUrlError(prev => ({
        ...prev,
        [workspaceId]: err instanceof Error ? err.message : 'Failed to save',
      }));
    } finally {
      setPreviewUrlSaving(prev => ({ ...prev, [workspaceId]: false }));
    }
  };

  const handleToggleGitPush = async (workspaceId: string) => {
    const current = gitPushSettings[workspaceId] ?? true;
    const next = !current;
    setGitPushSettings(prev => ({ ...prev, [workspaceId]: next }));
    try {
      await updateGitSettings(workspaceId, next);
    } catch {
      // Revert on failure
      setGitPushSettings(prev => ({ ...prev, [workspaceId]: current }));
    }
  };

  const handleNewTaskFileSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const newFiles = Array.from(files);
    setNewTaskFiles(prev => [...prev, ...newFiles]);
    setNewTaskUploading(true);
    try {
      const uploaded = await uploadFiles(newFiles);
      setNewTaskAttachmentIds(prev => [...prev, ...uploaded.map(a => a.id)]);
    } catch {
      setNewTaskFiles(prev => prev.filter(f => !newFiles.includes(f)));
    } finally {
      setNewTaskUploading(false);
      if (newTaskFileInputRef.current) newTaskFileInputRef.current.value = '';
    }
  };

  const handleRemoveNewTaskFile = (index: number) => {
    setNewTaskFiles(prev => prev.filter((_, i) => i !== index));
    setNewTaskAttachmentIds(prev => prev.filter((_, i) => i !== index));
  };

  const handleCreateTask = async (workspaceId: string) => {
    if (!newTaskPrompt.trim()) return;
    setCreatingTask(true);
    try {
      const model = newTaskModel || undefined;
      const caveman = newTaskCaveman || undefined;
      const attIds = newTaskAttachmentIds.length > 0 ? newTaskAttachmentIds : undefined;
      await createTask(workspaceId, newTaskPrompt.trim(), model, caveman, attIds, newTaskAutoReview);
      try {
        const defaults = JSON.parse(localStorage.getItem('taskDefaults') || '{}');
        defaults[workspaceId] = { model: newTaskModel, caveman: newTaskCaveman };
        localStorage.setItem('taskDefaults', JSON.stringify(defaults));
      } catch { /* ignore */ }
      lastTaskWorkspaceIdRef.current = workspaceId;
      clearNewTaskPrompt();
      setNewTaskModel('');
      setNewTaskCaveman('');
      setNewTaskFiles([]);
      setNewTaskAttachmentIds([]);
      setNewTaskWorkspaceId(null);
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setCreatingTask(false);
    }
  };

  if (loading && workspaces.length === 0) return <div className="text-gray-500 dark:text-gray-400">Loading workspaces...</div>;
  if (error && workspaces.length === 0) return <div className="text-red-600 dark:text-red-400">Error: {error}</div>;

  const renderTaskCard = (task: Task) => (
    <div
      key={task.id}
      onClick={() => setSelectedTaskId(task.id)}
      className="block bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-3 hover:shadow-sm transition-shadow cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2 flex-1">{task.title}</h4>
        <div className="flex items-center gap-1 shrink-0">
          {task.source === 'api' && (
            <span
              title={`Created via API${task.client_label ? ` (${task.client_label})` : ''}`}
              className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800"
            >
              {task.client_label || 'API'}
            </span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_COLORS[task.status] || ''}`}>
            {task.status.replace('_', ' ')}
          </span>
        </div>
      </div>
      {task.status === 'working' && task.activity && (
        <div className="mt-2 flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400">
          <div className="animate-spin h-3 w-3 border-[1.5px] border-blue-600 dark:border-blue-400 border-t-transparent rounded-full" />
          <span className="truncate">{task.activity.summary}</span>
          <span className="text-gray-400 dark:text-gray-500 whitespace-nowrap">
            {timeAgo(task.activity.timestamp)}
          </span>
        </div>
      )}
      {(portsByTaskId[task.id]?.length ?? 0) > 0 && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          {portsByTaskId[task.id].map((p) => (
            <PortLink key={p.port} port={p} variant="pill" onClick={(e) => e.stopPropagation()} />
          ))}
        </div>
      )}
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-1">
          {task.verification_url && (
            <a
              href={task.verification_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="p-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-700 transition-colors"
              title="View"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
                <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
              </svg>
            </a>
          )}
          {task.status === 'awaiting_feedback' && (
            <button
              onClick={(e) => handleComplete(e, task.id)}
              disabled={!!task.pending_complete}
              className="p-1.5 bg-green-600 text-white rounded hover:bg-green-700 transition-colors disabled:opacity-50"
              title={task.pending_complete ? 'Completion queued — will finalize once the working task finishes' : 'Mark Complete'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            </button>
          )}
          {(task.status === 'failed' || task.status === 'cancelled') && (
            <button
              onClick={(e) => handleRetry(e, task.id)}
              className={`p-1.5 text-white rounded transition-colors ${task.status === 'failed' ? 'bg-red-600 hover:bg-red-700' : 'bg-orange-600 hover:bg-orange-700'}`}
              title="Retry"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
              </svg>
            </button>
          )}
          {task.status === 'completed' && (
            <button
              onClick={(e) => handleReopen(e, task.id)}
              className="p-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
              title="Reopen"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
              </svg>
            </button>
          )}
          {task.status === 'working' && (
            <button
              onClick={(e) => handleInterrupt(e, task.id)}
              className="text-gray-300 dark:text-gray-600 hover:text-amber-500 dark:hover:text-amber-400 p-1.5"
              title="Interrupt (pause to give feedback)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </button>
          )}
          {(task.status === 'working' || task.status === 'queued') && (
            <button
              onClick={(e) => handleCancel(e, task.id)}
              className="text-gray-300 dark:text-gray-600 hover:text-orange-500 dark:hover:text-orange-400 p-1.5"
              title="Cancel task"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <rect x="4" y="4" width="12" height="12" rx="1" />
              </svg>
            </button>
          )}
          {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && (
            <button
              onClick={(e) => handleDelete(e, task.id)}
              className="text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 p-1.5"
              title="Delete task"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {task.id === spaceTargetTaskId && !selectedTaskId && !newTaskWorkspaceId && (
            <span className="text-[10px] text-gray-400 dark:text-gray-600">
              <kbd className="px-1 py-0.5 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-400 dark:text-gray-500 font-mono text-[10px]">Space</kbd> to open
            </span>
          )}
        </div>
      </div>
    </div>
  );

  const renderWorkspaceColumn = (ws: Workspace) => {
    const agent = getAgentStatus(ws);
    const isRunning = ws.latest_build.status === 'running';
    const isStarting = STARTING_STATUSES.includes(ws.latest_build.status);
    const counts = taskCounts[ws.id];
    const tasks = tasksByWorkspace[ws.id] || [];
    // Only ports NOT owned by a task appear in the workspace-wide shortcut row;
    // task-owned ports render on their task card instead.
    const openPorts = getOpenPorts(ws).filter(
      (p) => resolvePortOwnerId(p, tasks, portRangeSize) === null
    );
    const apps = getApps(ws);
    const githubRepoUrl = githubRepoUrls[ws.id] || tasks.find(t => t.github_repo_url)?.github_repo_url || null;

    return (
      <div
        key={ws.id}
        data-ws-id={ws.id}
        className={`flex-shrink-0 w-80 flex flex-col rounded-lg border ${
          isRunning || isStarting
            ? 'bg-gray-50 dark:bg-gray-900/50 border-gray-200 dark:border-gray-800'
            : 'bg-gray-50/50 dark:bg-gray-900/30 border-gray-200 dark:border-gray-800 opacity-60'
        }`}
      >
        {/* Workspace header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-800" data-ws-header>
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
              {ws.name}
            </span>
            <div className="flex items-center gap-1.5">
              {isStarting && (
                <span className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400" title={`Workspace is ${ws.latest_build.status}`}>
                  <span className="animate-spin h-3 w-3 border-[1.5px] border-blue-600 dark:border-blue-400 border-t-transparent rounded-full" />
                  Starting…
                </span>
              )}
              {isRunning ? (
                <button
                  onClick={(e) => handleStop(e, ws.id, ws.name)}
                  className="text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 p-0.5"
                  title="Stop workspace"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <rect x="4" y="4" width="12" height="12" rx="1" />
                  </svg>
                </button>
              ) : ws.latest_build.status === 'stopped' ? (
                <button
                  onClick={(e) => handleStart(e, ws.id)}
                  className="text-gray-300 dark:text-gray-600 hover:text-green-500 dark:hover:text-green-400 p-0.5"
                  title="Start workspace"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M6 4l10 6-10 6V4z" />
                  </svg>
                </button>
              ) : null}
              {isRunning && (
                <button
                  onClick={() => handleToggleMemory(ws.id)}
                  className={`p-0.5 transition-colors ${memoryOpenWsId === ws.id ? 'text-purple-500 dark:text-purple-400' : 'text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400'}`}
                  title="Workspace memory"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V12a1 1 0 11-2 0V4.804z" />
                  </svg>
                </button>
              )}
              {isRunning && (
                <button
                  onClick={() => handleToggleSettings(ws.id)}
                  className={`p-0.5 transition-colors ${settingsOpenWsId === ws.id ? 'text-blue-500 dark:text-blue-400' : 'text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400'}`}
                  title="Workspace settings"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          <WorkspaceRateLimits limits={rateLimits[ws.name]} />
          {memoryOpenWsId === ws.id && (() => {
            const files = memoryByWs[ws.id] ?? [];
            const isLoading = memoryLoadingWsId === ws.id;
            const userFiles = files.filter(f => f.name !== 'cpm_guidelines.md' && f.name !== 'cpm_session_guidelines.md');
            return (
              <div className="flex flex-col gap-2 px-2 py-2 bg-purple-50 dark:bg-purple-950/20 border border-purple-200 dark:border-purple-800/40 rounded text-xs mb-1">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-purple-700 dark:text-purple-300 flex items-center gap-1">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V12a1 1 0 11-2 0V4.804z" />
                    </svg>
                    Workspace Memory
                  </span>
                  <button
                    onClick={() => {
                      setMemoryByWs(prev => { const n = { ...prev }; delete n[ws.id]; return n; });
                      setMemoryLoadingWsId(ws.id);
                      getWorkspaceMemory(ws.id)
                        .then(({ files: f }) => setMemoryByWs(prev => ({ ...prev, [ws.id]: f })))
                        .catch(() => {})
                        .finally(() => setMemoryLoadingWsId(null));
                    }}
                    className="text-purple-400 hover:text-purple-600 dark:hover:text-purple-300 text-[10px]"
                    title="Refresh"
                  >↻</button>
                </div>
                {isLoading && (
                  <span className="text-gray-400 dark:text-gray-500 italic">Loading…</span>
                )}
                {!isLoading && userFiles.length === 0 && (
                  <span className="text-gray-400 dark:text-gray-500 italic">
                    No memory yet. Claude will add notes here as tasks and discussions run.
                  </span>
                )}
                {!isLoading && userFiles.map(file => {
                  const isEditing = memoryEditingFile?.wsId === ws.id && memoryEditingFile?.filename === file.name;
                  const isSaving = memorySavingFile === file.name;
                  return (
                    <div key={file.name} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[10px] text-purple-500 dark:text-purple-400">{file.name}</span>
                        {!isEditing ? (
                          <button
                            onClick={() => setMemoryEditingFile({ wsId: ws.id, filename: file.name, draft: file.content })}
                            className="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                          >Edit</button>
                        ) : (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleSaveMemoryFile(ws.id, file.name, memoryEditingFile!.draft)}
                              disabled={isSaving}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
                            >{isSaving ? 'Saving…' : 'Save'}</button>
                            <button
                              onClick={() => setMemoryEditingFile(null)}
                              className="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                            >Cancel</button>
                          </div>
                        )}
                      </div>
                      {isEditing ? (
                        <textarea
                          value={memoryEditingFile!.draft}
                          onChange={e => setMemoryEditingFile(prev => prev ? { ...prev, draft: e.target.value } : null)}
                          className="w-full text-[11px] font-mono px-1.5 py-1 rounded border border-purple-300 dark:border-purple-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 focus:outline-none focus:border-purple-500 resize-y"
                          rows={10}
                        />
                      ) : (
                        <pre className="text-[10px] text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words max-h-48 overflow-y-auto bg-white/50 dark:bg-gray-900/30 rounded p-1.5 border border-purple-100 dark:border-purple-900/40 leading-relaxed">{file.content || <em className="italic opacity-60">empty</em>}</pre>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
          {settingsOpenWsId === ws.id && (
            <div className="flex flex-col gap-2 px-2 py-2 bg-gray-100 dark:bg-gray-800 rounded text-xs mb-1">
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={gitPushSettings[ws.id] ?? true}
                  onChange={() => handleToggleGitPush(ws.id)}
                  className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 h-3.5 w-3.5"
                />
                <span className="text-gray-600 dark:text-gray-300">Allow git remote operations</span>
              </label>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-gray-500 dark:text-gray-400 shrink-0">Preview URL:</span>
                <input
                  type="url"
                  inputMode="url"
                  placeholder="auto-detect from open ports"
                  value={previewUrlDrafts[ws.id] ?? ''}
                  onChange={(e) => setPreviewUrlDrafts(prev => ({ ...prev, [ws.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSavePreviewUrl(ws.id); }}
                  className="flex-1 min-w-[12rem] text-[11px] font-mono px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 focus:outline-none focus:border-blue-400"
                />
                {((previewUrlDrafts[ws.id] ?? '') !== (previewUrlSettings[ws.id] ?? '')) && (
                  <button
                    onClick={() => handleSavePreviewUrl(ws.id)}
                    disabled={previewUrlSaving[ws.id]}
                    className="text-[10px] px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {previewUrlSaving[ws.id] ? 'Saving…' : 'Save'}
                  </button>
                )}
                {(previewUrlSettings[ws.id] ?? '') !== '' && ((previewUrlDrafts[ws.id] ?? '') === (previewUrlSettings[ws.id] ?? '')) && (
                  <button
                    onClick={() => {
                      setPreviewUrlDrafts(prev => ({ ...prev, [ws.id]: '' }));
                      handleSavePreviewUrl(ws.id);
                    }}
                    className="text-[10px] px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-500 hover:text-red-500 hover:border-red-300"
                    title="Clear and auto-detect"
                  >
                    Clear
                  </button>
                )}
                {previewUrlError[ws.id] && (
                  <span className="text-[10px] text-red-500">{previewUrlError[ws.id]}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-gray-500 dark:text-gray-400 shrink-0">Voice:</span>
                {(wsVoiceSettings[ws.id] ?? []).map((vid, idx) => {
                  const voiceName = availableVoices.find(v => v.id === vid)?.name ?? vid;
                  return (
                    <span key={vid} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded-full text-[10px] leading-tight">
                      <span className="text-purple-400 dark:text-purple-500 mr-0.5">{idx + 1}.</span>
                      {voiceName.slice(0, 24)}{voiceName.length > 24 ? '…' : ''}
                      <button
                        onClick={() => handleRemoveVoice(ws.id, vid)}
                        className="ml-0.5 opacity-50 hover:opacity-100 hover:text-red-500 leading-none"
                        title="Remove"
                      >×</button>
                    </span>
                  );
                })}
                <select
                  value=""
                  onChange={e => { if (e.target.value) { handleAddVoice(ws.id, e.target.value); (e.target as HTMLSelectElement).value = ''; } }}
                  className="text-[10px] px-1 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-pointer focus:outline-none max-w-[10rem] min-w-0"
                  title="Add a voice to the priority list"
                >
                  <option value="">+ Add voice</option>
                  {availableVoices.filter(v => v.id.startsWith('kokoro:') && !(wsVoiceSettings[ws.id] ?? []).includes(v.id)).length > 0 && (
                    <optgroup label="Kokoro (local)">
                      {availableVoices
                        .filter(v => v.id.startsWith('kokoro:') && !(wsVoiceSettings[ws.id] ?? []).includes(v.id))
                        .map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </optgroup>
                  )}
                  {availableVoices.filter(v => v.id.startsWith('el:') && !(wsVoiceSettings[ws.id] ?? []).includes(v.id)).length > 0 && (
                    <optgroup label="ElevenLabs">
                      {availableVoices
                        .filter(v => v.id.startsWith('el:') && !(wsVoiceSettings[ws.id] ?? []).includes(v.id))
                        .map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </optgroup>
                  )}
                  {availableVoices.filter(v => v.id.startsWith('qwen:') && !(wsVoiceSettings[ws.id] ?? []).includes(v.id)).length > 0 && (
                    <optgroup label="Qwen3-TTS (self-hosted)">
                      {availableVoices
                        .filter(v => v.id.startsWith('qwen:') && !(wsVoiceSettings[ws.id] ?? []).includes(v.id))
                        .map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </optgroup>
                  )}
                </select>
                {(() => {
                  const defaultId = wsDefaultVoices[ws.id] ?? null;
                  const fallbackName = defaultId
                    ? (availableVoices.find(v => v.id === defaultId)?.name
                        ?? KOKORO_VOICES.find(v => `kokoro:${v.id}` === defaultId)?.name
                        ?? defaultId.replace(/^(kokoro:|el:|qwen:|br:)/, ''))
                    : null;
                  const hasVoices = (wsVoiceSettings[ws.id] ?? []).length > 0;
                  if (!fallbackName) return null;
                  return (
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700/50 text-gray-400 dark:text-gray-500 rounded-full text-[10px] leading-tight italic">
                      {hasVoices ? '↩ ' : ''}{fallbackName}
                    </span>
                  );
                })()}
              </div>
            </div>
          )}
          {(apps.length > 0 || openPorts.length > 0 || githubRepoUrl) && (
            <div className="flex items-center gap-1.5 flex-wrap mb-1">
              {githubRepoUrl && (
                <a
                  href={githubRepoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 hover:opacity-80 transition-opacity"
                  title="GitHub repository"
                >
                  <svg className="h-4 w-4 text-gray-400 dark:text-gray-500 hover:text-gray-900 dark:hover:text-gray-100" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                </a>
              )}
              {apps.map((app) => {
                // Prefer the site's own favicon over the Coder-registered icon
                const iconSrc = app.favicon_url || app.icon;
                return (
                <a
                  key={`app-${app.slug}`}
                  href={app.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 hover:opacity-80 transition-opacity"
                  title={app.display_name}
                >
                  {iconSrc ? (
                    <img
                      src={iconSrc.startsWith('data:') ? iconSrc : `/api/workspaces/proxy-icon?url=${encodeURIComponent(iconSrc)}`}
                      alt=""
                      className="h-4 w-4 rounded-sm"
                      onError={(e) => {
                        const el = e.currentTarget;
                        el.style.display = 'none';
                        el.nextElementSibling?.classList.remove('hidden');
                      }}
                    />
                  ) : null}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className={`h-4 w-4 text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400${iconSrc ? ' hidden' : ''}`}
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
                    <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
                  </svg>
                </a>
                );
              })}
              {openPorts.map((p) => (
                <PortLink key={p.port} port={p} />
              ))}
            </div>
          )}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                <div>{ws.template_name}</div>
              </div>
              {counts && (
                <div className="flex gap-2 mt-1 text-xs flex-wrap">
                  {counts.working > 0 && (
                    <span className="text-blue-600 dark:text-blue-400">{counts.working} working</span>
                  )}
                  {counts.awaiting_feedback > 0 && (
                    <span className="text-yellow-600 dark:text-yellow-400">{counts.awaiting_feedback} awaiting</span>
                  )}
                  {counts.queued > 0 && (
                    <span className="text-gray-500 dark:text-gray-400">{counts.queued} queued</span>
                  )}
                  {counts.failed > 0 && (
                    <span className="text-red-600 dark:text-red-400">{counts.failed} failed</span>
                  )}
                  {counts.cancelled > 0 && (
                    <span className="text-orange-600 dark:text-orange-400">{counts.cancelled} cancelled</span>
                  )}
                </div>
              )}
            </div>
            {isRunning && (
              <div className="flex gap-1.5 shrink-0 mt-0.5">
                <button
                  onClick={() => {
                    if (newTaskWorkspaceId === ws.id) return;
                    setNewTaskWorkspaceId(ws.id);
                    clearNewTaskPrompt();
                  }}
                  className="text-xs px-2 py-0.5 bg-blue-600 text-white rounded-full hover:bg-blue-700 transition-colors"
                  title={altNTargetWorkspaceId === ws.id ? 'New task (Alt+N)' : 'New task'}
                >
                  + Task{altNTargetWorkspaceId === ws.id && (
                    <span className="ml-1 opacity-70 text-[10px]">Alt+N</span>
                  )}
                </button>
              </div>
            )}
          </div>
          {isRunning && newTaskWorkspaceId === ws.id && (
            <div className="mt-2">
              <textarea
                autoFocus
                value={newTaskPrompt}
                onChange={(e) => setNewTaskPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    handleCreateTask(ws.id);
                  }
                  if (e.key === 'Escape') {
                    setNewTaskWorkspaceId(null);
                    clearNewTaskPrompt();
                  }
                }}
                placeholder="What should Claude do?"
                className="w-full text-sm border border-gray-300 dark:border-gray-700 rounded-md p-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
                rows={2}
                disabled={creatingTask}
              />
              <select
                value={newTaskModel}
                onChange={(e) => setNewTaskModel(e.target.value)}
                className="w-full text-sm border border-gray-300 dark:border-gray-700 rounded-md p-1.5 mt-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                disabled={creatingTask || loadingModels}
              >
                <option value="">{loadingModels ? 'Loading models...' : 'Default model'}</option>
                {availableModels.some(m => m.provider === 'anthropic') && (
                  <optgroup label="Claude">
                    {availableModels.filter(m => m.provider === 'anthropic').map((m) => (
                      <option key={m.id} value={m.id}>{m.display_name}</option>
                    ))}
                  </optgroup>
                )}
                {availableModels.some(m => m.provider === 'ollama-local') && (
                  <optgroup label="Ollama (local)">
                    {availableModels.filter(m => m.provider === 'ollama-local').map((m) => (
                      <option key={m.id} value={m.id}>{m.display_name}</option>
                    ))}
                  </optgroup>
                )}
                {availableModels.some(m => m.provider === 'ollama-cloud') && (
                  <optgroup label="Ollama (cloud)">
                    {availableModels.filter(m => m.provider === 'ollama-cloud').map((m) => (
                      <option key={m.id} value={m.id}>{m.display_name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              <select
                value={newTaskCaveman}
                onChange={(e) => setNewTaskCaveman(e.target.value)}
                className="w-full text-sm border border-gray-300 dark:border-gray-700 rounded-md p-1.5 mt-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                disabled={creatingTask}
              >
                <option value="">Caveman mode (off)</option>
                <option value="lite">Caveman: Lite — no filler, full sentences</option>
                <option value="full">Caveman: Full — fragments, no articles</option>
                <option value="ultra">Caveman: Ultra — max compression</option>
              </select>
              <label className="flex items-center gap-2 mt-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={newTaskAutoReview}
                  onChange={(e) => setNewTaskAutoReview(e.target.checked)}
                  disabled={creatingTask}
                  className="w-3.5 h-3.5 accent-blue-600"
                />
                <span className="text-xs text-gray-600 dark:text-gray-400">Auto-review — red-team pass before surfacing to you</span>
              </label>
              {newTaskFiles.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {newTaskFiles.map((f, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                      <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                      <span className="truncate max-w-[120px]">{f.name}</span>
                      <button type="button" onClick={() => handleRemoveNewTaskFile(i)} className="text-blue-400 hover:text-red-500">&times;</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2 mt-1 items-center">
                <input
                  ref={newTaskFileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => handleNewTaskFileSelect(e.target.files)}
                />
                <button
                  type="button"
                  onClick={() => newTaskFileInputRef.current?.click()}
                  disabled={newTaskUploading || creatingTask}
                  className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-300 dark:hover:border-blue-600 transition-colors disabled:opacity-50"
                  title="Attach reference files"
                >
                  {newTaskUploading ? (
                    <span className="flex items-center gap-1">
                      <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                      Uploading...
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                      Attach
                    </span>
                  )}
                </button>
                <button
                  onClick={() => handleCreateTask(ws.id)}
                  disabled={creatingTask || !newTaskPrompt.trim()}
                  className="text-xs px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {creatingTask ? 'Creating...' : 'Create'}
                </button>
                <button
                  onClick={() => { setNewTaskWorkspaceId(null); clearNewTaskPrompt(); setNewTaskFiles([]); setNewTaskAttachmentIds([]); }}
                  className="text-xs px-3 py-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Task list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
          {isStarting ? (
            <p className="text-xs text-blue-600 dark:text-blue-400 px-1 flex items-center gap-1.5">
              <span className="animate-spin h-3 w-3 border-[1.5px] border-blue-600 dark:border-blue-400 border-t-transparent rounded-full" />
              Starting up — tasks can run once it's ready
            </p>
          ) : !isRunning ? (
            <p className="text-xs text-amber-600 dark:text-amber-400 px-1">Workspace must be running to execute tasks</p>
          ) : tasks.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-500 px-1">No tasks</p>
          ) : (
            (sortedTasksByWorkspace[ws.id] || tasks).map(renderTaskCard)
          )}
        </div>

      </div>
    );
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {error && workspaces.length > 0 && (
        <div className="mb-3 flex items-center justify-between gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm px-3 py-2 rounded-lg">
          <span>Connection error: {error}</span>
          <button onClick={() => setError('')} className="text-red-400 dark:text-red-500 hover:text-red-600 dark:hover:text-red-300">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}
      <div className="flex-shrink-0 flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Workspaces</h2>
        {stoppedWorkspaces.length > 0 && (
          <button
            onClick={() => setShowStopped(!showStopped)}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            {showStopped ? 'Hide' : 'Show'} stopped ({stoppedWorkspaces.length})
          </button>
        )}
      </div>

      {workspaces.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400">No workspaces found.</p>
      ) : (
        <div ref={laneContainerRef} className="flex gap-4 overflow-x-auto pb-4 flex-1 min-h-0">
          {runningWorkspaces.map(renderWorkspaceColumn)}
          {startingWorkspaces.map(renderWorkspaceColumn)}
          {showStopped && stoppedWorkspaces.map(renderWorkspaceColumn)}
        </div>
      )}

      {deletedTaskId && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 px-4 py-3 rounded-lg shadow-lg text-sm">
          <span>Task deleted</span>
          <button
            onClick={handleUndo}
            className="font-semibold text-blue-400 dark:text-blue-600 hover:text-blue-300 dark:hover:text-blue-700"
          >
            Undo
          </button>
          <button
            onClick={() => setDeletedTaskId(null)}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-200 dark:hover:text-gray-700 ml-1"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}

      {selectedTaskId && (
        <TaskDetailModal
          taskId={selectedTaskId}
          onClose={() => setSelectedTaskId(null)}
          onTaskChanged={loadData}
        />
      )}

    </div>
  );
}
