import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  getWorkspaces,
  getTasks,
  stopWorkspace,
  startWorkspace,
  completeTask,
  retryTask,
  reopenTask,
  cancelTask,
  deleteTask,
  restoreTask,
  createTask,
  type Workspace,
  type Task,
  type TaskCounts,
  type TokenTotals,
} from '../api/client';
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

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

function getOpenPorts(workspace: Workspace) {
  return workspace.listening_ports || [];
}

function getApps(workspace: Workspace) {
  return workspace.apps || [];
}

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [taskCounts, setTaskCounts] = useState<Record<string, TaskCounts>>({});
  const [tokenTotals, setTokenTotals] = useState<Record<string, TokenTotals>>({});
  const [tasksByWorkspace, setTasksByWorkspace] = useState<Record<string, Task[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showStopped, setShowStopped] = useState(false);
  const [deletedTaskId, setDeletedTaskId] = useState<string | null>(null);
  const [newTaskWorkspaceId, setNewTaskWorkspaceId] = useSessionState<string | null>('newTaskWorkspaceId', null);
  const [newTaskPrompt, setNewTaskPrompt, clearNewTaskPrompt] = useDraft('newTaskPrompt');
  const [creatingTask, setCreatingTask] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useSessionState<string | null>('selectedTaskId', null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevTaskStatusesRef = useRef<Map<string, string>>(new Map());
  const lastTaskWorkspaceIdRef = useRef<string | null>(null);

  const loadData = async () => {
    try {
      const { workspaces: ws, taskCounts: tc, tokenTotals: tt } = await getWorkspaces();
      setWorkspaces(ws);
      setTaskCounts(tc);
      setTokenTotals(tt || {});
      setError('');

      // Fetch tasks for running workspaces in parallel
      const runningWs = ws.filter((w) => w.latest_build.status === 'running');
      const taskResults = await Promise.all(
        runningWs.map((w) => getTasks(w.id).then((r) => ({ id: w.id, tasks: r.tasks })).catch(() => ({ id: w.id, tasks: [] as Task[] })))
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

      setTasksByWorkspace(tasksMap);
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

  useEffect(() => {
    loadData();
    // Poll faster when tasks are active, slower when idle
    const pollMs = hasActiveTasks ? 5000 : 15000;
    const interval = setInterval(loadData, pollMs);
    return () => clearInterval(interval);
  }, [hasActiveTasks]);

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

  const stoppedWorkspaces = useMemo(() =>
    workspaces.filter((ws) => ws.latest_build.status !== 'running'),
    [workspaces]
  );

  // Compute which task the Space shortcut would open
  const spaceTargetTaskId = useMemo(() => {
    for (const ws of runningWorkspaces) {
      const sorted = sortedTasksByWorkspace[ws.id] || [];
      if (sorted.length > 0) return sorted[0].id;
    }
    return null;
  }, [runningWorkspaces, sortedTasksByWorkspace]);

  // Space shortcut to open the top-left task (uses memoized data)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ') return;
      if (selectedTaskId || newTaskWorkspaceId) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return;
      for (const ws of runningWorkspaces) {
        const sorted = sortedTasksByWorkspace[ws.id] || [];
        if (sorted.length > 0) {
          e.preventDefault();
          setSelectedTaskId(sorted[0].id);
          return;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [runningWorkspaces, sortedTasksByWorkspace, selectedTaskId, newTaskWorkspaceId]);

  // Compute the target workspace for Alt+N: last-created-in workspace, or left-most running
  const getAltNTargetWorkspaceId = (): string | null => {
    if (runningWorkspaces.length === 0) return null;
    const lastId = lastTaskWorkspaceIdRef.current;
    if (lastId && runningWorkspaces.some((ws) => ws.id === lastId)) return lastId;
    return runningWorkspaces[0].id;
  };

  const altNTargetWorkspaceId = getAltNTargetWorkspaceId();

  // Alt+N shortcut to open new task form
  useEffect(() => {
    const handleAltN = (e: KeyboardEvent) => {
      if (!e.altKey || e.key.toLowerCase() !== 'n') return;
      if (selectedTaskId || newTaskWorkspaceId) return;
      const target = getAltNTargetWorkspaceId();
      if (!target) return;
      e.preventDefault();
      setNewTaskWorkspaceId(target);
      clearNewTaskPrompt();
    };
    window.addEventListener('keydown', handleAltN);
    return () => window.removeEventListener('keydown', handleAltN);
  }, [workspaces, taskCounts, selectedTaskId, newTaskWorkspaceId]);

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
    await completeTask(taskId);
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

  const handleCreateTask = async (workspaceId: string) => {
    if (!newTaskPrompt.trim()) return;
    setCreatingTask(true);
    try {
      await createTask(workspaceId, newTaskPrompt.trim());
      lastTaskWorkspaceIdRef.current = workspaceId;
      clearNewTaskPrompt();
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
        <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap shrink-0 ${STATUS_COLORS[task.status] || ''}`}>
          {task.status.replace('_', ' ')}
        </span>
      </div>
      <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
        {new Date(task.created_at).toLocaleString()}
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
              className="p-1.5 bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
              title="Mark Complete"
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
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {typeof task.total_cost_usd === 'number' && task.total_cost_usd > 0 && (
            <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">${task.total_cost_usd.toFixed(2)}</span>
          )}
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
    const counts = taskCounts[ws.id];
    const tokens = tokenTotals[ws.id];
    const tasks = tasksByWorkspace[ws.id] || [];
    const openPorts = getOpenPorts(ws);
    const apps = getApps(ws);

    return (
      <div
        key={ws.id}
        className={`flex-shrink-0 w-80 flex flex-col rounded-lg border ${
          isRunning
            ? 'bg-gray-50 dark:bg-gray-900/50 border-gray-200 dark:border-gray-800'
            : 'bg-gray-50/50 dark:bg-gray-900/30 border-gray-200 dark:border-gray-800 opacity-60'
        }`}
      >
        {/* Workspace header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
              {ws.name}
            </span>
            <div className="flex items-center gap-1.5">
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
            </div>
          </div>
          {(apps.length > 0 || openPorts.length > 0) && (
            <div className="flex items-center gap-1.5 flex-wrap mb-1">
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
                <a
                  key={p.port}
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 hover:opacity-80 transition-opacity"
                  title={p.title || `:${p.port} (${p.process_name})`}
                >
                  {p.favicon_url ? (
                    <img
                      src={p.favicon_url.startsWith('data:') ? p.favicon_url : `/api/workspaces/proxy-icon?url=${encodeURIComponent(p.favicon_url)}`}
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
                    className={`h-4 w-4 text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400${p.favicon_url ? ' hidden' : ''}`}
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
                    <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
                  </svg>
                </a>
              ))}
            </div>
          )}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                <div>{ws.template_name}</div>
                {agent.name && (
                  <div>
                    <span className={agent.connected ? 'text-green-600 dark:text-green-400' : 'text-gray-400 dark:text-gray-500'}>
                      {agent.name} ({agent.connected ? 'connected' : 'disconnected'})
                    </span>
                  </div>
                )}
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
              {tokens && (tokens.total_input_tokens > 0 || tokens.total_output_tokens > 0 || tokens.total_cost_usd > 0) && (
                <div
                  className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 font-mono"
                  title={`Input: ${tokens.total_input_tokens.toLocaleString()} | Output: ${tokens.total_output_tokens.toLocaleString()}`}
                >
                  {(tokens.total_input_tokens > 0 || tokens.total_output_tokens > 0) && (
                    <span>{formatTokens(tokens.total_input_tokens + tokens.total_output_tokens)} tokens</span>
                  )}
                  {tokens.total_cost_usd > 0 && (
                    <span className={tokens.total_input_tokens > 0 || tokens.total_output_tokens > 0 ? 'ml-1.5' : ''}>${tokens.total_cost_usd.toFixed(2)}</span>
                  )}
                </div>
              )}
            </div>
            {isRunning && (
              <button
                onClick={() => { setNewTaskWorkspaceId(ws.id); clearNewTaskPrompt(); }}
                className="shrink-0 text-xs px-2 py-0.5 bg-blue-600 text-white rounded-full hover:bg-blue-700 transition-colors mt-0.5"
                title={altNTargetWorkspaceId === ws.id ? 'New task (Alt+N)' : 'New task'}
              >
                + Task{altNTargetWorkspaceId === ws.id && (
                  <span className="ml-1 opacity-70 text-[10px]">Alt+N</span>
                )}
              </button>
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
              <div className="flex gap-2 mt-1">
                <button
                  onClick={() => handleCreateTask(ws.id)}
                  disabled={creatingTask || !newTaskPrompt.trim()}
                  className="text-xs px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {creatingTask ? 'Creating...' : 'Create'}
                </button>
                <button
                  onClick={() => { setNewTaskWorkspaceId(null); clearNewTaskPrompt(); }}
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
          {!isRunning ? (
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
        <div className="flex gap-4 overflow-x-auto pb-4 flex-1 min-h-0">
          {runningWorkspaces.map(renderWorkspaceColumn)}
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
